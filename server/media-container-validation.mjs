import { matchesMediaSignature } from '../src/media-policy.js';
import { inflateSync } from 'node:zlib';
import { DECODE_LIMITS } from './media-decoder-policy.mjs';
import { fail } from './errors.mjs';
const invalid = () => fail('SCAN_INVALID');
const table = Array.from({ length:256 },(_,index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function mediaCrc32(bytes) {
  let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function dimensions(width,height) {
  if (!width || !height || width > DECODE_LIMITS.dimension || height > DECODE_LIMITS.dimension || width*height > DECODE_LIMITS.pixels) invalid();
}
// FFmpeg's PNG row filter switch has no default rejection. Container CRC and
// a successful probe therefore cannot establish valid PNG raster structure.
// Run only inside the bounded offline worker (or explicit synthetic tests).
function pngRaster(parts,width,height,bits,interlace) {
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = []; let expected = 0,compressed,output;
  for (const [x,y,dx,dy] of passes) {
    const w = Math.max(0,Math.ceil((width-x)/dx)),h = Math.max(0,Math.ceil((height-y)/dy));
    if (!w || !h) continue;
    const stride = Math.ceil(w*bits/8)+1; rows.push({ stride,count:h }); expected += stride*h;
  }
  if (!expected || expected > DECODE_LIMITS.allocationBytes || !parts.length) invalid();
  try {
    compressed = Buffer.concat(parts);
    // Default Z_FINISH requires the checksum/end, maxOutputLength bounds a
    // bomb independently of its compressed size. Reject unused trailing input
    // under our strict subset policy instead of retaining hidden IDAT bytes.
    const inflated = inflateSync(compressed,{ info:true,maxOutputLength:expected }); output = inflated.buffer;
    if (inflated.engine.bytesWritten !== compressed.length || output.length !== expected) invalid();
    let at = 0;
    for (const { stride,count } of rows) for (let row = 0; row < count; row++) {
      if (output[at] > 4) invalid(); at += stride;
    }
  } catch { invalid(); }
  finally { output?.fill(0); compressed?.fill(0); }
}
function png(bytes,checkpoint) {
  let at = 8,chunks = 0,animation = null,frames = 0,sequence = 0,seenData = false,dataEnded = false,palette = false;
  let width,height,bits,interlace,frame,parts = [],pixelWork = 0,color,depth;
  const finish = () => {
    checkpoint();
    if (!frame) invalid(); pixelWork += frame.width*frame.height;
    if (pixelWork > DECODE_LIMITS.decodedPixels) invalid();
    pngRaster(parts,frame.width,frame.height,bits,interlace); parts = []; checkpoint();
  };
  while (at < bytes.length) {
    checkpoint();
    if (++chunks > 20000 || at+12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(at),end = at+12+size,kind = bytes.toString('latin1',at+4,at+8);
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2].toUpperCase() ||
        mediaCrc32(bytes.subarray(at+4,end-4)) !== bytes.readUInt32BE(end-4)) invalid();
    const data = bytes.subarray(at+8,end-4);
    if (chunks === 1) {
      if (kind !== 'IHDR' || size !== 13) invalid(); width = data.readUInt32BE(0); height = data.readUInt32BE(4); dimensions(width,height);
      depth = data[8]; color = data[9]; interlace = data[12];
      if (!({ 0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16] })[color]?.includes(depth) ||
          data[10] !== 0 || data[11] !== 0 || interlace > 1) invalid();
      bits = ({ 0:1,2:3,3:1,4:2,6:4 })[color]*depth; frame = { width,height };
    } else if (kind === 'IHDR') invalid();
    if (seenData && kind !== 'IDAT') dataEnded = true;
    if (kind === 'PLTE') {
      if (palette || seenData || [0,4].includes(color) || !size || size%3 || size > 768 || color === 3 && size/3 > 2**depth) invalid();
      palette = true;
    }
    if (kind === 'acTL') {
      if (size !== 8 || animation !== null || seenData) invalid(); animation = data.readUInt32BE(0);
      if (animation < 1 || animation > DECODE_LIMITS.frames) invalid();
    }
    if (kind === 'fcTL') {
      // Existing supported APNG subset requires IDAT to be frame 1 (no
      // separate poster). Validate every frame, not only the IDAT raster.
      if (animation === null || size !== 26 || !frames && seenData || ++frames > animation || data.readUInt32BE(0) !== sequence++) invalid();
      if (frames > 1) finish();
      frame = { width:data.readUInt32BE(4),height:data.readUInt32BE(8) }; dimensions(frame.width,frame.height);
      const x = data.readUInt32BE(12),y = data.readUInt32BE(16);
      if (frame.width+x > width || frame.height+y > height || data[24] > 2 || data[25] > 1 ||
          frames === 1 && (x || y || frame.width !== width || frame.height !== height)) invalid();
    }
    if (kind === 'IDAT') {
      if (dataEnded || animation !== null && frames !== 1 || color === 3 && !palette) invalid(); seenData = true; parts.push(data);
    }
    if (kind === 'fdAT') {
      if (animation === null || frames < 2 || !seenData || size <= 4 || data.readUInt32BE(0) !== sequence++) invalid(); parts.push(data.subarray(4));
    }
    if (kind === 'IEND') {
      if (size || !seenData || end !== bytes.length || animation !== null && frames !== animation) invalid();
      finish();
      return animation ?? 1;
    }
    if (kind[0] === kind[0].toUpperCase() && !['IHDR','PLTE','IDAT','IEND'].includes(kind)) invalid();
    at = end;
  }
  invalid();
}
function gif(bytes) {
  if (bytes.length < 14) invalid(); dimensions(bytes.readUInt16LE(6),bytes.readUInt16LE(8));
  let at = 13+((bytes[10] & 128) ? 3*2**((bytes[10]&7)+1) : 0), frames = 0;
  function blocks() {
    while (true) {
      if (at >= bytes.length) invalid(); const size = bytes[at++]; if (!size) return;
      at += size; if (at > bytes.length) invalid();
    }
  }
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) { if (!frames || at !== bytes.length) invalid(); return frames; }
    if (kind === 0x21) { if (at >= bytes.length) invalid(); at += 1; blocks(); }
    else if (kind === 0x2c) {
      if (at+9 >= bytes.length || ++frames > DECODE_LIMITS.frames) invalid();
      dimensions(bytes.readUInt16LE(at+4),bytes.readUInt16LE(at+6));
      const packed = bytes[at+8]; at += 9; if (packed & 128) at += 3*2**((packed&7)+1);
      if (at >= bytes.length || bytes[at] < 2 || bytes[at] > 8) invalid(); at += 1; blocks();
    } else invalid();
  }
  invalid();
}
function webp(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4)+8 !== bytes.length) invalid();
  let at = 12,frames = 0,still = 0,chunks = 0;
  while (at < bytes.length) {
    if (++chunks > 20000 || at+8 > bytes.length) invalid();
    const kind = bytes.toString('ascii',at,at+4), size = bytes.readUInt32LE(at+4),end = at+8+size+(size&1);
    if (end > bytes.length) invalid();
    if (kind === 'ANMF') { if (size < 16) invalid(); frames += 1; }
    if (['VP8 ','VP8L'].includes(kind)) still += 1;
    at = end;
  }
  if (frames && still || !frames && still !== 1 || frames > DECODE_LIMITS.frames) invalid();
  return frames || 1;
}
function webm(bytes) {
  function vint(at,id = false) {
    if (at >= bytes.length || !bytes[at]) invalid();
    let length = 1, marker = 128; while (!(bytes[at]&marker)) { length += 1; marker >>>= 1; }
    if (length > (id ? 4 : 8) || at+length > bytes.length) invalid();
    let value = id ? bytes[at] : bytes[at] & (marker-1);
    for (let index = 1; index < length; index++) value = value*256+bytes[at+index];
    if (!Number.isSafeInteger(value)) invalid(); return { value,next:at+length };
  }
  const header = vint(4), end = header.next+header.value;
  if (end > bytes.length || end > 4096) invalid(); let at = header.next,docType = null;
  while (at < end) {
    const id = vint(at,true), size = vint(id.next), next = size.next+size.value;
    if (next > end) invalid();
    if (id.value === 0x4282) { if (docType !== null) invalid(); docType = bytes.toString('ascii',size.next,next); }
    at = next;
  }
  if (docType !== 'webm') invalid(); return null;
}
export function validateMediaContainer(bytes,type,{ checkpoint = () => {} } = {}) {
  // Trusted synchronous work-budget check, never file/request supplied code.
  // It cannot preempt one bounded zlib call; the separate host/job deadline
  // still enforces process lifetime. Do not swallow its unavailable error.
  if (typeof checkpoint !== 'function') invalid(); checkpoint();
  if (!Buffer.isBuffer(bytes) || !matchesMediaSignature(type,bytes)) invalid();
  if (type === 'image/png') return png(bytes,checkpoint);
  if (type === 'image/gif') return gif(bytes);
  if (type === 'image/webp') return webp(bytes);
  if (type === 'image/jpeg') { if (bytes.length < 4 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid(); return 1; }
  if (type === 'video/webm') return webm(bytes);
  if (type === 'video/mp4') {
    let at = 0,boxes = 0,hasMedia = false,hasMovie = false;
    while (at < bytes.length) {
      if (++boxes > 20000 || at+8 > bytes.length) invalid();
      let size = bytes.readUInt32BE(at), headerSize = 8; const kind = bytes.toString('ascii',at+4,at+8);
      if (size === 1) { headerSize = 16; if (at+16 > bytes.length) invalid(); const wide = bytes.readBigUInt64BE(at+8); if (wide > BigInt(bytes.length)) invalid(); size = Number(wide); }
      else if (size === 0) size = bytes.length-at;
      if (size < headerSize || at+size > bytes.length || boxes === 1 && (kind !== 'ftyp' || size < headerSize+8 || bytes.toString('ascii',at+headerSize,at+headerSize+4) === 'qt  ')) invalid();
      if (kind === 'moov') { if (hasMovie) invalid(); hasMovie = true; }
      if (kind === 'mdat') hasMedia = true;
      at += size;
    }
    if (!hasMedia || !hasMovie) invalid(); return null;
  }
  invalid();
}
