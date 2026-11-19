import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { WEB_CHAT_MEDIA_MAX_BYTES, WEB_CHAT_MEDIA_TYPES } from '../src/shared-chat-media-policy.js';
import { matchesMediaSignature } from '../src/media-policy.js';
import { validateMediaContainer } from './media-container-validation.mjs';
import { prepareImageDerivative } from './image-metadata.mjs';
import { rewriteMp4Metadata } from './mp4-metadata.mjs';
import { fail } from './errors.mjs';

const invalid = () => fail('INVALID_MEDIA');
const MAX_PIXELS = 16_000_000, MAX_DIMENSION = 8192, MAX_SECONDS = 600, MAX_SAMPLES = 100_000;
function dimensions(width, height) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_DIMENSION) || width * height > MAX_PIXELS) invalid();
  return { width, height };
}

async function imageInfo(bytes, type) {
  const options = { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true, animated: false };
  const image = sharp(bytes, options).timeout({ seconds: 5 });
  let pixels, prepared;
  try {
    const meta = await image.metadata();
    if (meta.format !== ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' })[type] ||
        (meta.pages ?? 1) !== 1 || meta.pageHeight && meta.pageHeight !== meta.height) invalid();
    const result = dimensions(meta.width, meta.height);
    // Reuse the strict container/marker checks, including PNG CRC/raster and
    // trailing-data rejection. The derivative is discarded; stored bytes stay
    // unchanged, and metadata removal or anonymization is NOT claimed.
    prepared = prepareImageDerivative(bytes, type);
    if (prepared.containerFrames !== 1) invalid();
    prepared.bytes.fill(0); prepared = undefined;
    // metadata() alone does not decode compressed pixels. No resize/thumbnail
    // optimization: decode the entire single image under the input pixel cap.
    pixels = await image.ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (pixels.info.width !== result.width || pixels.info.height !== result.height ||
        pixels.info.channels !== 4 || pixels.data.length !== result.width * result.height * 4) invalid();
    return result;
  } finally { pixels?.data.fill(0); prepared?.bytes.fill(0); image.destroy(); }
}

// The existing MP4 rewriter validates the complete supported box grammar and
// rejects external data references. This small second pass measures a narrower
// non-fragmented H.264/AAC subset and checks sample locations against mdat.
// It does not decode video/audio or claim anti-malware inspection.
function mp4Info(bytes) {
  validateMediaContainer(bytes, 'video/mp4');
  const checked = rewriteMp4Metadata(bytes); checked.bytes.fill(0);
  let boxCount = 0;
  function boxes(start, end) {
    const result = [];
    for (let at = start; at < end;) {
      if (++boxCount > 20_000 || at + 8 > end) invalid();
      let size = bytes.readUInt32BE(at), header = 8;
      const kind = bytes.toString('latin1', at + 4, at + 8);
      if (size === 1) {
        if (at + 16 > end) invalid(); const wide = bytes.readBigUInt64BE(at + 8);
        if (wide > BigInt(end - at)) invalid(); size = Number(wide); header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end) invalid();
      result.push({ kind, at, data: at + header, end: at + size }); at += size;
    }
    return result;
  }
  const children = box => boxes(box.data, box.end);
  const one = (list, kind) => { const matches = list.filter(b => b.kind === kind); if (matches.length !== 1) invalid(); return matches[0]; };
  const data = box => bytes.subarray(box.data, box.end);
  const safe64 = at => { const value = bytes.readBigUInt64BE(at); if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(value); };
  function time(box) {
    const b = data(box), version = b[0], scaleAt = version === 1 ? 20 : 12, durationAt = scaleAt + 4;
    if (![0, 1].includes(version) || b.length < durationAt + (version === 1 ? 8 : 4)) invalid();
    const scale = b.readUInt32BE(scaleAt), duration = version === 1 ? safe64(box.data + durationAt) : b.readUInt32BE(durationAt);
    if (!scale || !duration || duration / scale > MAX_SECONDS) invalid();
    return { scale, duration };
  }
  const top = boxes(0, bytes.length), movie = children(one(top, 'moov'));
  if (top.some(b => b.kind === 'moof') || movie.some(b => b.kind === 'mvex')) invalid();
  time(one(movie, 'mvhd'));
  const mdats = top.filter(b => b.kind === 'mdat'), tracks = movie.filter(b => b.kind === 'trak');
  if (!mdats.length || tracks.length < 1 || tracks.length > 2) invalid();
  const occupied = []; let video, audio = false;
  for (const track of tracks) {
    const media = children(one(children(track), 'mdia')), handler = data(one(media, 'hdlr')).toString('latin1', 8, 12);
    const timing = time(one(media, 'mdhd')), table = children(one(children(one(media, 'minf')), 'stbl'));
    const description = one(table, 'stsd'), entries = boxes(description.data + 8, description.end);
    if (entries.length !== 1 || bytes.readUInt32BE(description.data + 4) !== 1) invalid();
    const entry = entries[0], body = data(entry);
    if (body.readUInt16BE(6) !== 1) invalid();
    let naluLength;
    if (handler === 'vide') {
      if (video || !['avc1', 'avc3'].includes(entry.kind) || body.length < 78) invalid();
      video = { ...dimensions(body.readUInt16BE(24), body.readUInt16BE(26)), duration: timing.duration / timing.scale };
      const codec = one(boxes(entry.data + 78, entry.end), 'avcC');
      naluLength = avcConfiguration(data(codec));
    } else if (handler === 'soun') {
      if (audio || entry.kind !== 'mp4a' || body.length < 28 || body.readUInt16BE(8) !== 0) invalid();
      audio = true; aacConfiguration(data(one(boxes(entry.data + 28, entry.end), 'esds')));
    } else invalid();
    const sizesBox = one(table, 'stsz'), sizesData = data(sizesBox);
    const fixedSize = sizesData.readUInt32BE(4), sampleCount = sizesData.readUInt32BE(8);
    if (!sampleCount || sampleCount > MAX_SAMPLES || table.some(b => b.kind === 'stz2')) invalid();
    const sizes = Array.from({ length: sampleCount }, (_, i) => fixedSize || sizesData.readUInt32BE(12 + i * 4));
    if (sizes.some(size => !size || size > bytes.length)) invalid();
    const stts = data(one(table, 'stts')); let count = 0, duration = 0;
    for (let at = 8; at < stts.length; at += 8) {
      const samples = stts.readUInt32BE(at), delta = stts.readUInt32BE(at + 4);
      if (!samples || !delta) invalid(); count += samples; duration += samples * delta;
      if (count > sampleCount || !Number.isSafeInteger(duration)) invalid();
    }
    if (count !== sampleCount || duration !== timing.duration) invalid();
    const ctts = table.find(b => b.kind === 'ctts');
    if (ctts) {
      const b = data(ctts); let total = 0;
      for (let at = 8; at < b.length; at += 8) {
        const count = b.readUInt32BE(at), offset = b[0] === 1 ? b.readInt32BE(at + 4) : b.readUInt32BE(at + 4);
        if (!count || Math.abs(offset) > MAX_SECONDS * timing.scale) invalid(); total += count;
      }
      if (total !== sampleCount) invalid();
    }
    const offsetBox = table.find(b => ['stco', 'co64'].includes(b.kind));
    if (!offsetBox) invalid(); const offsetData = data(offsetBox), width = offsetBox.kind === 'co64' ? 8 : 4;
    const chunks = Array.from({ length: offsetData.readUInt32BE(4) }, (_, i) => width === 8 ? safe64(offsetBox.data + 8 + i * 8) : offsetData.readUInt32BE(8 + i * 4));
    if (!chunks.length || chunks.length > sampleCount) invalid();
    const stsc = data(one(table, 'stsc')), mappings = [];
    for (let at = 8; at < stsc.length; at += 12) {
      const first = stsc.readUInt32BE(at), perChunk = stsc.readUInt32BE(at + 4), descriptionIndex = stsc.readUInt32BE(at + 8);
      if (!first || first > chunks.length || !perChunk || perChunk > sampleCount || descriptionIndex !== 1 ||
          mappings.length && first <= mappings.at(-1).first) invalid();
      mappings.push({ first, perChunk });
    }
    if (!mappings.length || mappings[0].first !== 1) invalid();
    let sample = 0, mapping = 0;
    chunks.forEach((offset, index) => {
      if (mapping + 1 < mappings.length && mappings[mapping + 1].first === index + 1) mapping++;
      let end = offset;
      for (let i = 0; i < mappings[mapping].perChunk; i++) {
        if (sample >= sampleCount) invalid(); const next = end + sizes[sample++];
        if (!Number.isSafeInteger(next) || !mdats.some(mdat => end >= mdat.data && next <= mdat.end)) invalid();
        if (naluLength) avcSample(bytes.subarray(end, next), naluLength);
        end = next;
      }
      occupied.push({ start: offset, end });
    });
    if (sample !== sampleCount) invalid();
    const sync = table.find(b => b.kind === 'stss');
    if (sync) {
      let previous = 0; const b = data(sync);
      for (let at = 8; at < b.length; at += 4) { const n = b.readUInt32BE(at); if (n <= previous || n > sampleCount) invalid(); previous = n; }
    }
  }
  occupied.sort((a, b) => a.start - b.start);
  for (let i = 1; i < occupied.length; i++) if (occupied[i].start < occupied[i - 1].end) invalid();
  if (!video) invalid(); return video;
}

function avcConfiguration(bytes) {
  if (bytes.length < 7 || bytes[0] !== 1 || (bytes[4] & 252) !== 252 || (bytes[5] & 224) !== 224) invalid();
  const length = (bytes[4] & 3) + 1; if (length === 3) invalid(); let at = 6;
  function parameters(count, type) {
    if (!count) invalid();
    for (let i = 0; i < count; i++) {
      if (at + 2 > bytes.length) invalid(); const size = bytes.readUInt16BE(at); at += 2;
      if (size < (type === 7 ? 4 : 2) || at + size > bytes.length || bytes[at] & 128 || (bytes[at] & 31) !== type ||
          type === 7 && (bytes[at + 1] !== bytes[1] || bytes[at + 3] !== bytes[3])) invalid(); at += size;
    }
  }
  parameters(bytes[5] & 31, 7);
  if (at >= bytes.length) invalid(); parameters(bytes[at++], 8);
  if (at < bytes.length) {
    if (![100, 110, 122, 144].includes(bytes[1]) || at + 4 > bytes.length || (bytes[at] & 252) !== 252 ||
        (bytes[at + 1] & 248) !== 248 || (bytes[at + 2] & 248) !== 248) invalid();
    at += 3; const count = bytes[at++]; if (count) parameters(count, 13);
  }
  if (at !== bytes.length) invalid(); return length;
}
function avcSample(bytes, length) {
  let at = 0, picture = false, count = 0;
  while (at < bytes.length) {
    if (++count > 100_000 || at + length > bytes.length) invalid(); const size = bytes.readUIntBE(at, length); at += length;
    if (!size || at + size > bytes.length || bytes[at] & 128) invalid(); const kind = bytes[at] & 31;
    if (!kind || kind >= 24) invalid(); if (kind <= 5) picture = true; at += size;
  }
  if (!picture) invalid();
}
function aacConfiguration(bytes) {
  if (bytes.length < 6 || bytes.readUInt32BE(0)) invalid(); let found = false;
  function descriptors(start, end, parent) {
    const allowed = ({ 0: [3], 3: [4, 6], 4: [5] })[parent], seen = new Set();
    if (!allowed) invalid();
    for (let at = start; at < end;) {
      const tag = bytes[at++]; let size = 0, terminated = false;
      if (!allowed.includes(tag) || seen.has(tag)) invalid(); seen.add(tag);
      for (let i = 0; i < 4; i++) { if (at >= end) invalid(); const n = bytes[at++]; size = size * 128 + (n & 127); if (!(n & 128)) { terminated = true; break; } }
      const next = at + size; if (!terminated || next > end || !size) invalid();
      if (tag === 3) {
        if (size < 3 || bytes[at + 2] !== 0) invalid(); descriptors(at + 3, next, 3);
      } else if (tag === 4) {
        if (size < 13 || bytes[at] !== 0x40 || (bytes[at + 1] >> 2) !== 5 || !(bytes[at + 1] & 1)) invalid(); descriptors(at + 13, next, 4);
      } else if (tag === 5) {
        if (found || size < 2 || size > 64 || (bytes[at] >> 3) !== 2 || ((bytes[at] & 7) * 2 + (bytes[at + 1] >> 7)) > 12 ||
            !((bytes[at + 1] >> 3) & 15) || ((bytes[at + 1] >> 3) & 15) > 7) invalid(); found = true;
      } else if (tag !== 6 || size !== 1 || bytes[at] !== 2) invalid();
      at = next;
    }
    if (allowed.some(tag => !seen.has(tag))) invalid();
  }
  descriptors(4, bytes.length, 0); if (!found) invalid();
}

/** Public synthetic-prototype validation only. Images are decoded; MP4 uses a
 * strict structural subset. Neither path is an antivirus or clinical-media
 * approval. Input bytes, metadata and private names are never logged/returned.
 */
export async function validateWebChatMedia(bytes, type) {
  try {
    if (!Buffer.isBuffer(bytes) || !WEB_CHAT_MEDIA_TYPES.includes(type) || bytes.length < 1 ||
        bytes.length > WEB_CHAT_MEDIA_MAX_BYTES || !matchesMediaSignature(type, bytes)) invalid();
    const info = type.startsWith('image/') ? await imageInfo(bytes, type) : mp4Info(bytes);
    return Object.freeze({ type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...info });
  } catch { invalid(); }
}
