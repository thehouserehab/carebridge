import { createHash } from 'node:crypto';
import { deflateSync,inflateSync } from 'node:zlib';
import { MEDIA_LIMITS } from '../src/media-policy.js';
import { validateMediaContainer,mediaCrc32 } from './media-container-validation.mjs';
import { DECODE_LIMITS } from './media-decoder-policy.mjs';
import { fail } from './errors.mjs';
import { canonicalizeIccProfile,ICC_PROFILE_LIMIT,ICC_PROFILE_POLICY } from './icc-profile.mjs';

import { IMAGE_METADATA_POLICY } from './media-preparation-policy.mjs';
export { IMAGE_METADATA_POLICY };
const types = ['image/jpeg','image/png','image/gif','image/webp'];
const invalid = () => fail('SCAN_INVALID');
const unsupported = () => fail('SCAN_UNAVAILABLE');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dimensions = (width,height) => {
  if (!width || !height || width > DECODE_LIMITS.dimension || height > DECODE_LIMITS.dimension || width*height > DECODE_LIMITS.pixels) invalid();
};
function pngChunk(kind,data) {
  const bytes = Buffer.alloc(data.length+12); bytes.writeUInt32BE(data.length); bytes.write(kind,4,'ascii'); data.copy(bytes,8);
  bytes.writeUInt32BE(mediaCrc32(bytes.subarray(4,-4)),bytes.length-4); return bytes;
}
function riffChunk(kind,data) {
  const bytes = Buffer.alloc(8+data.length+(data.length&1)); bytes.write(kind,0,'ascii'); bytes.writeUInt32LE(data.length,4); data.copy(bytes,8); return bytes;
}

// Read ONLY IFD0 orientation. Do not follow arbitrary EXIF/GPS/MakerNote or
// thumbnail pointers or inflate metadata. Everything else is discarded.
function exifOrientation(bytes) {
  if (bytes.subarray(0,6).equals(Buffer.from('Exif\0\0'))) bytes = bytes.subarray(6);
  if (bytes.length < 14 || bytes.length > 1024*1024) invalid();
  const order = bytes.toString('ascii',0,2); if (!['II','MM'].includes(order)) invalid();
  const u16 = (at) => order === 'II' ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at) => order === 'II' ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  if (u16(2) !== 42) invalid(); const at = u32(4);
  if (at < 8 || at+2 > bytes.length) invalid(); const count = u16(at);
  if (count > 4096 || at+2+count*12+4 > bytes.length) invalid();
  let orientation = 1,found = false;
  for (let index = 0; index < count; index++) {
    const entry = at+2+index*12;
    if (u16(entry) !== 0x112) continue;
    if (found || u16(entry+2) !== 3 || u32(entry+4) !== 1) invalid();
    found = true; orientation = u16(entry+8); if (orientation < 1 || orientation > 8) invalid();
  }
  return orientation;
}
function minimalExif(orientation) {
  // Fixed TIFF containing exactly one SHORT orientation tag, no other IFD.
  const bytes = Buffer.alloc(26); bytes.write('II',0,'ascii'); bytes.writeUInt16LE(42,2); bytes.writeUInt32LE(8,4);
  bytes.writeUInt16LE(1,8); bytes.writeUInt16LE(0x112,10); bytes.writeUInt16LE(3,12); bytes.writeUInt32LE(1,14); bytes.writeUInt16LE(orientation,18); return bytes;
}
function jpegSegment(marker,data) {
  const bytes = Buffer.alloc(4+data.length); bytes[0] = 255; bytes[1] = marker; bytes.writeUInt16BE(data.length+2,2); data.copy(bytes,4); return bytes;
}
function jpeg(bytes) {
  const result = [bytes.subarray(0,2)]; let at = 2,segments = 0,scans = 0,frame = false,exif = false,jfif = false,adobe = false,orientation = 1;
  const profileParts = new Map(); let profileCount = 0,profileSize = 0,profilePosition = -1,channels = 0;
  while (at < bytes.length) {
    if (++segments > 20000 || bytes[at++] !== 255) invalid();
    while (at < bytes.length && bytes[at] === 255) at++;
    if (at >= bytes.length) invalid(); const marker = bytes[at++];
    if (marker === 0xd9) {
      if (!frame || !scans || at !== bytes.length) invalid(); result.push(Buffer.from([255,217]));
      if (profileCount) {
        if (profileParts.size !== profileCount) invalid();
        if (![1,3].includes(channels)) unsupported();
        const source = Buffer.concat(Array.from({ length:profileCount },(_,index) => profileParts.get(index+1)));
        const profile = canonicalizeIccProfile(source,channels === 1 ? 'GRAY' : 'RGB '),parts = [],count = Math.ceil(profile.length/65519);
        for (let index = 0; index < count; index++) parts.push(jpegSegment(0xe2,Buffer.concat([Buffer.from('ICC_PROFILE\0'),Buffer.from([index+1,count]),profile.subarray(index*65519,(index+1)*65519)])));
        result.splice(profilePosition,1,...parts);
      }
      return { bytes:Buffer.concat(result),orientation,iccProfilePolicy:profileCount ? ICC_PROFILE_POLICY : null };
    }
    if (at+2 > bytes.length) invalid(); const size = bytes.readUInt16BE(at),end = at+size;
    if (size < 2 || end > bytes.length) invalid(); const data = bytes.subarray(at+2,end); at = end;
    if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) {
      if (marker === 0xe1 && data.subarray(0,6).equals(Buffer.from('Exif\0\0'))) {
        if (exif) invalid(); exif = true; orientation = exifOrientation(data);
        if (orientation !== 1) result.push(jpegSegment(marker,Buffer.concat([Buffer.from('Exif\0\0'),minimalExif(orientation)])));
      } else if (marker === 0xe0 && data.subarray(0,5).equals(Buffer.from('JFIF\0'))) {
        if (jfif || data.length < 14 || data.length !== 14+3*data[12]*data[13] || data[7] > 2) invalid(); jfif = true;
        const header = Buffer.from(data.subarray(0,14)); header[12] = header[13] = 0; result.push(jpegSegment(marker,header));
      } else if (marker === 0xee) {
        // Adobe's numeric color transform must not disappear.
        if (adobe || data.length !== 12 || data.toString('ascii',0,5) !== 'Adobe' || data[11] > 2) unsupported();
        adobe = true; result.push(jpegSegment(marker,data));
      } else if (marker === 0xe2 && data.toString('latin1',0,11) === 'ICC_PROFILE') {
        if (scans || data.length < 15 || data[11] !== 0 || !data[12] || !data[13] || data[12] > data[13] || profileCount && data[13] !== profileCount || profileParts.has(data[12])) invalid();
        profileCount = data[13]; profileSize += data.length-14; if (profileSize > ICC_PROFILE_LIMIT) invalid();
        profileParts.set(data[12],data.subarray(14));
        if (profilePosition < 0) { profilePosition = result.length; result.push(Buffer.alloc(0)); }
      }
      continue;
    }
    if (![0xc0,0xc1,0xc2,0xc4,0xdb,0xdd,0xda].includes(marker)) invalid();
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (frame || data.length < 6 || data.length !== 6+3*data[5]) invalid(); frame = true;
      channels = data[5];
      dimensions(data.readUInt16BE(3),data.readUInt16BE(1));
    }
    if (marker === 0xdd && data.length !== 2) invalid();
    result.push(jpegSegment(marker,data));
    if (marker !== 0xda) continue;
    if (!frame || data.length < 4 || data.length !== 4+2*data[0]) invalid(); scans++;
    const start = at;
    // Walk all scans, not just bytes up to the first SOS. APP/COM metadata
    // between progressive scans must be removed too. Preserve stuffed bytes
    // and restart markers exactly; reject appended payload after EOI.
    while (at < bytes.length) {
      if (bytes[at] !== 255) { at++; continue; }
      const markerAt = at; while (at < bytes.length && bytes[at] === 255) at++;
      if (at >= bytes.length) invalid(); const next = bytes[at];
      if (next === 0 || next >= 0xd0 && next <= 0xd7) { at++; continue; }
      result.push(bytes.subarray(start,markerAt)); at = markerAt; break;
    }
  }
  invalid();
}

function png(bytes) {
  const result = [bytes.subarray(0,8)],seen = new Set(); let at = 8,orientation = 1,sequence = 0,animated = false,imageStarted = false;
  const color = bytes[25],depth = bytes[24]; let palette = 0;
  const retained = new Set(['IHDR','PLTE','IDAT','IEND','tRNS','cHRM','gAMA','sRGB','sBIT','cICP','mDCV','cLLI','bKGD','pHYs','hIST','acTL','fcTL','fdAT']);
  const lengths = { cHRM:32,gAMA:4,sRGB:1,cICP:4,mDCV:24,cLLI:8,pHYs:9,acTL:8,fcTL:26 };
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at),kind = bytes.toString('latin1',at+4,at+8),end = at+size+12,data = bytes.subarray(at+8,end-4);
    if (!/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2].toUpperCase()) invalid();
    if (retained.has(kind) && !['IDAT','fcTL','fdAT'].includes(kind) || ['eXIf','iCCP'].includes(kind)) { if (seen.has(kind)) invalid(); seen.add(kind); }
    if (kind === 'iCCP') {
      const nameEnd = data.indexOf(0);
      if (seen.has('PLTE') || imageStarted || nameEnd < 1 || nameEnd > 79 || data[nameEnd+1] !== 0 || nameEnd+2 >= data.length) invalid();
      const name = data.subarray(0,nameEnd);
      if (name[0] === 32 || name.at(-1) === 32 || name.includes(Buffer.from('  ')) || name.some((n) => n < 32 || n >= 127 && n <= 160)) invalid();
      const compressed = data.subarray(nameEnd+2); let inflated;
      try { inflated = inflateSync(compressed,{ maxOutputLength:ICC_PROFILE_LIMIT,info:true }); } catch { invalid(); }
      if (inflated.engine.bytesWritten !== compressed.length) invalid();
      const profile = canonicalizeIccProfile(inflated.buffer,[0,4].includes(color) ? 'GRAY' : 'RGB ');
      result.push(pngChunk(kind,Buffer.concat([Buffer.from('Carebridge\0\0'),deflateSync(profile,{ level:9 })])));
    } else if (kind === 'eXIf') {
      orientation = exifOrientation(data); if (orientation !== 1) result.push(pngChunk(kind,minimalExif(orientation)));
    } else if (retained.has(kind)) {
      if (kind === 'IDAT') imageStarted = true;
      if (Object.hasOwn(lengths,kind) && data.length !== lengths[kind]) invalid();
      if (kind === 'IHDR' && (![0,2,3,4,6].includes(color) || ![1,2,4,8,16].includes(depth))) invalid();
      if (kind === 'PLTE') { if (!size || size%3 || size > 768) invalid(); palette = size/3; }
      if (kind === 'sBIT' && (size !== ({ 0:1,2:3,3:3,4:2,6:4 })[color] || [...data].some((n) => !n || n > (color === 3 ? 8 : depth)))) invalid();
      if (kind === 'sRGB' && data[0] > 3 || kind === 'gAMA' && !data.readUInt32BE(0) || kind === 'pHYs' && data[8] > 1) invalid();
      if (kind === 'cICP' && (data[2] !== 0 || data[3] > 1)) invalid();
      if (kind === 'tRNS' && !(color === 0 && size === 2 || color === 2 && size === 6 || color === 3 && size > 0 && size <= palette)) invalid();
      if (kind === 'bKGD' && size !== ({ 0:2,2:6,3:1,4:2,6:6 })[color] || kind === 'hIST' && (!palette || size !== palette*2)) invalid();
      if (kind === 'acTL') animated = true;
      if (kind === 'fcTL' || kind === 'fdAT') {
        if (!animated || data.length < 4 || data.readUInt32BE(0) !== sequence++) invalid();
        if (kind === 'fcTL') {
          const width = data.readUInt32BE(4),height = data.readUInt32BE(8); dimensions(width,height);
          if (width+data.readUInt32BE(12) > bytes.readUInt32BE(16) || height+data.readUInt32BE(16) > bytes.readUInt32BE(20) || data[24] > 2 || data[25] > 1) invalid();
        } else if (data.length === 4) invalid();
      }
      result.push(Buffer.from(bytes.subarray(at,end)));
    } else if (kind[0] === kind[0].toUpperCase()) invalid(); // Unknown critical chunks are not metadata.
    at = end;
  }
  if (seen.has('iCCP') && seen.has('sRGB')) invalid();
  if (seen.has('iCCP') && seen.has('cICP')) unsupported();
  return { bytes:Buffer.concat(result),orientation,iccProfilePolicy:seen.has('iCCP') ? ICC_PROFILE_POLICY : null };
}

function gif(bytes) {
  const palette = bytes[10]&128 ? 3*2**((bytes[10]&7)+1) : 0;
  let at = 13+palette,blocks = 0,pendingControl = false,loop = false,profile = false; const result = [bytes.subarray(0,at)];
  const subBlocks = () => {
    while (true) {
      if (at >= bytes.length) invalid(); const size = bytes[at++]; if (!size) return;
      at += size; if (at > bytes.length) invalid();
    }
  };
  while (at < bytes.length) {
    if (++blocks > 20000) invalid(); const start = at,kind = bytes[at++];
    if (kind === 0x3b) { if (pendingControl) invalid(); result.push(Buffer.from([kind])); break; }
    if (kind === 0x2c) {
      const packed = bytes[at+8]; at += 9+(packed&128 ? 3*2**((packed&7)+1) : 0); at++; subBlocks();
      pendingControl = false; result.push(bytes.subarray(start,at)); continue;
    }
    if (kind !== 0x21) invalid(); const label = bytes[at++],dataAt = at; subBlocks();
    if (label === 0xf9) {
      if (pendingControl || at-dataAt !== 6 || bytes[dataAt] !== 4 || bytes[dataAt+1]&0xe0 || (bytes[dataAt+1] >>> 2&7) > 3) invalid();
      pendingControl = true; result.push(bytes.subarray(start,at));
    } else if (label === 0x01) unsupported(); // Plain text is visible graphics, not discardable comments.
    else if (label === 0xff) {
      if (bytes[dataAt] !== 11) invalid(); const app = bytes.toString('latin1',dataAt+1,dataAt+12);
      if (app === 'ICCRGBG1012') {
        if (profile || pendingControl) invalid(); profile = true; const parts = []; let size = 0;
        for (let pos = dataAt+12; pos < at-1;) { const length = bytes[pos++]; size += length; if (size > ICC_PROFILE_LIMIT) invalid(); parts.push(bytes.subarray(pos,pos+length)); pos += length; }
        const clean = canonicalizeIccProfile(Buffer.concat(parts),'RGB '),chunks = [Buffer.from([33,255,11]),Buffer.from(app)];
        for (let pos = 0; pos < clean.length; pos += 255) { const part = clean.subarray(pos,pos+255); chunks.push(Buffer.from([part.length]),part); }
        result.push(Buffer.concat([...chunks,Buffer.from([0])]));
      } else if (['NETSCAPE2.0','ANIMEXTS1.0'].includes(app)) {
        if (loop || at-dataAt !== 17 || bytes[dataAt+12] !== 3 || bytes[dataAt+13] !== 1) invalid(); loop = true;
        result.push(bytes.subarray(start,at));
      }
    } // Comments and unknown application/private extensions are not retained.
  }
  return { bytes:Buffer.concat(result),orientation:1,iccProfilePolicy:profile ? ICC_PROFILE_POLICY : null };
}

function webp(bytes) {
  const result = [],seen = new Set(); let at = 12,extended = null,orientation = 1,alpha = false,animated = false,frameCount = 0;
  while (at < bytes.length) {
    const kind = bytes.toString('latin1',at,at+4),size = bytes.readUInt32LE(at+4),end = at+8+size+(size&1),data = bytes.subarray(at+8,at+8+size);
    if (size&1 && bytes[end-1] !== 0) invalid();
    if (['VP8X','ICCP','EXIF','XMP ','VP8 ','VP8L','ALPH','ANIM'].includes(kind)) { if (seen.has(kind)) invalid(); seen.add(kind); }
    if (kind === 'ICCP') {
      if (!extended || !(extended[0]&0x20) || ['VP8 ','VP8L','ALPH','ANIM'].some((name) => seen.has(name)) || frameCount) invalid();
      result.push(riffChunk(kind,canonicalizeIccProfile(data,'RGB ')));
    } else if (kind === 'EXIF') {
      orientation = exifOrientation(data); if (orientation !== 1) result.push(riffChunk(kind,minimalExif(orientation)));
    } else if (kind === 'VP8X') {
      if (at !== 12 || size !== 10 || data[0]&0xc1 || data[1] || data[2] || data[3]) invalid();
      extended = Buffer.from(data); dimensions(data.readUIntLE(4,3)+1,data.readUIntLE(7,3)+1); extended[0] &= ~0x0c;
      alpha = !!(data[0]&0x10); animated = !!(data[0]&2); result.push(riffChunk(kind,extended));
    } else if (['VP8 ','VP8L','ALPH','ANIM'].includes(kind)) {
      if (kind === 'ANIM' && (!animated || size !== 6)) invalid();
      result.push(riffChunk(kind,data));
    } else if (kind === 'ANMF') {
      if (!extended || !animated || !seen.has('ANIM') || size < 16 || data[15]&0xfc) invalid(); frameCount++;
      const width = data.readUIntLE(6,3)+1,height = data.readUIntLE(9,3)+1; dimensions(width,height);
      if (width+2*data.readUIntLE(0,3) > extended.readUIntLE(4,3)+1 || height+2*data.readUIntLE(3,3) > extended.readUIntLE(7,3)+1) invalid();
      const children = [data.subarray(0,16)]; let pos = 16,image = 0,hasAlpha = false,nested = 0;
      while (pos < size) {
        if (++nested > 20000 || pos+8 > size) invalid(); const childKind = data.toString('latin1',pos,pos+4),length = data.readUInt32LE(pos+4),next = pos+8+length+(length&1);
        if (next > size || length&1 && data[next-1] !== 0) invalid();
        if (['VP8 ','VP8L','ALPH'].includes(childKind)) {
          if (childKind === 'ALPH') { if (hasAlpha || image) invalid(); hasAlpha = true; }
          else { if (++image !== 1 || childKind === 'VP8L' && hasAlpha) invalid(); }
          children.push(riffChunk(childKind,data.subarray(pos+8,pos+8+length)));
        } else if (['ICCP','VP8X','ANMF','ANIM'].includes(childKind)) unsupported();
        pos = next;
      }
      if (image !== 1) invalid(); result.push(riffChunk(kind,Buffer.concat(children)));
    } // EXIF/XMP and unknown chunks are dropped, including nested private chunks.
    at = end;
  }
  if (animated !== !!frameCount || seen.has('ALPH') && !seen.has('VP8 ') || animated && seen.has('ALPH')) invalid();
  if (extended && !!(extended[0]&0x20) !== seen.has('ICCP')) invalid();
  if (!extended && (seen.has('EXIF') || seen.has('XMP ') || seen.has('ALPH') || seen.has('ANIM'))) invalid();
  if (orientation !== 1) { if (!extended) invalid(); extended[0] |= 8; }
  if (extended) result[0] = riffChunk('VP8X',extended);
  if (alpha && !animated && !seen.has('ALPH') && !seen.has('VP8L')) invalid();
  const body = Buffer.concat(result),header = Buffer.alloc(12); header.write('RIFF',0,'ascii'); header.writeUInt32LE(body.length+4,4); header.write('WEBP',8,'ascii');
  return { bytes:Buffer.concat([header,body]),orientation,iccProfilePolicy:seen.has('ICCP') ? ICC_PROFILE_POLICY : null };
}

// Pure bounded structural transformation for an offline trusted worker, NOT a
// scanner/decoder, file store, HTTP service or approval. Original bytes are
// immutable. The caller must scan+fully decode BOTH the original and the new
// bytes, verify equivalence, and durably record both manifests before sharing.
export function prepareImageDerivative(bytes,type) {
  if (!Buffer.isBuffer(bytes) || !types.includes(type) || bytes.length < 1 || bytes.length > MEDIA_LIMITS.image) invalid();
  const frames = validateMediaContainer(bytes,type);
  const prepared = ({ 'image/jpeg':jpeg,'image/png':png,'image/gif':gif,'image/webp':webp })[type](bytes);
  if (prepared.bytes.length > MEDIA_LIMITS.image || validateMediaContainer(prepared.bytes,type) !== frames) invalid();
  return { ...prepared,policyVersion:IMAGE_METADATA_POLICY,type,
    source:{ size:bytes.length,sha256:hash(bytes) },derivative:{ size:prepared.bytes.length,sha256:hash(prepared.bytes) },
    containerFrames:frames,mediaAcceptanceReady:false };
}
