// Synthetic only: never imported into an application or operating worker.
import { deflateSync } from 'node:zlib';
export const PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_IMAGE_METADATA';
export function pngChunk(kind,data) {
  const bytes = Buffer.alloc(12+data.length); bytes.writeUInt32BE(data.length); bytes.write(kind,4,'ascii'); data.copy(bytes,8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4,-4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc&1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0,bytes.length-4); return bytes;
}
export function pngChunks(bytes) {
  const result = []; for (let at = 8; at < bytes.length;) { const length = bytes.readUInt32BE(at); result.push({ kind:bytes.toString('latin1',at+4,at+8),data:bytes.subarray(at+8,at+8+length) }); at += length+12; } return result;
}
export function syntheticPng() {
  const header = Buffer.alloc(13); header.writeUInt32BE(32,0); header.writeUInt32BE(24,4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(24*(1+32*3),100); for (let i = 0; i < 24; i++) rows[i*97] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]);
}
// Independent test-only scanline layout. Zero-valued samples are valid for
// every PNG color/depth combination and filter 0..4, without re-encoding.
export function rasterPng({ width = 9,height = 9,color = 2,depth = 8,interlace = 0,filter = 0,rowsChange = (rows) => rows } = {}) {
  const samples = { 0:1,2:3,3:1,4:2,6:4 }[color];
  const ranges = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const lines = [];
  for (const [x,y,dx,dy] of ranges) {
    const w = Math.max(0,Math.ceil((width-x)/dx)),h = Math.max(0,Math.ceil((height-y)/dy));
    if (!w || !h) continue;
    for (let row = 0; row < h; row++) { const line = Buffer.alloc(1+Math.ceil(w*samples*depth/8)); line[0] = filter; lines.push(line); }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),
    ...(color === 3 ? [pngChunk('PLTE',Buffer.from([0,0,0]))] : []),pngChunk('IDAT',deflateSync(rowsChange(Buffer.concat(lines)))),pngChunk('IEND',Buffer.alloc(0))]);
}
export function animatedPng(bytes) {
  const chunks = pngChunks(bytes),header = chunks.find((c) => c.kind === 'IHDR').data,ac = Buffer.alloc(8); ac.writeUInt32BE(2);
  const result = [bytes.subarray(0,8),pngChunk('IHDR',header),pngChunk('acTL',ac)]; let seq = 0;
  for (let frame = 0; frame < 2; frame++) {
    const fc = Buffer.alloc(26); fc.writeUInt32BE(seq++); header.subarray(0,8).copy(fc,4); fc.writeUInt16BE(1,20); fc.writeUInt16BE(2,22); result.push(pngChunk('fcTL',fc));
    for (const c of chunks.filter((c) => c.kind === 'IDAT')) {
      if (!frame) result.push(pngChunk('IDAT',c.data));
      else { const data = Buffer.alloc(c.data.length+4); data.writeUInt32BE(seq++); c.data.copy(data,4); result.push(pngChunk('fdAT',data)); }
    }
  }
  return Buffer.concat([...result,pngChunk('IEND',Buffer.alloc(0))]);
}
export function syntheticExif(orientation = 6,order = 'II') {
  const description = Buffer.from(PRIVATE_MARKER+'\0'),gpsAt = 50+description.length,valuesAt = gpsAt+30;
  const bytes = Buffer.alloc(valuesAt+24),u16 = (value,at) => order === 'II' ? bytes.writeUInt16LE(value,at) : bytes.writeUInt16BE(value,at),
    u32 = (value,at) => order === 'II' ? bytes.writeUInt32LE(value,at) : bytes.writeUInt32BE(value,at);
  const entry = (at,tag,type,count,value,short = false) => { u16(tag,at); u16(type,at+2); u32(count,at+4); (short ? u16 : u32)(value,at+8); };
  bytes.write(order,0,'ascii'); u16(42,2); u32(8,4); u16(3,8);
  entry(10,0x112,3,1,orientation,true); entry(22,0x10e,2,description.length,50); entry(34,0x8825,4,1,gpsAt); description.copy(bytes,50);
  u16(2,gpsAt); entry(gpsAt+2,1,2,2,0); bytes[gpsAt+10] = 78; entry(gpsAt+14,2,5,3,valuesAt);
  for (let i = 0; i < 3; i++) { u32(1+i,valuesAt+i*8); u32(1,valuesAt+i*8+4); }
  return bytes;
}
export function jpegSegment(marker,data) {
  const bytes = Buffer.alloc(data.length+4); bytes[0] = 255; bytes[1] = marker; bytes.writeUInt16BE(data.length+2,2); data.copy(bytes,4); return bytes;
}
export function syntheticJpeg() {
  // Structural test only, NOT a native-decodable JPEG fixture.
  return Buffer.concat([Buffer.from([255,216]),jpegSegment(0xc0,Buffer.from([8,0,1,0,1,1,1,17,0])),
    jpegSegment(0xda,Buffer.from([1,1,0,0,63,0])),Buffer.from([7,255,0,9,255,208,10,255,217])]);
}
export function riffChunk(kind,data) {
  const bytes = Buffer.alloc(8+data.length+(data.length&1)); bytes.write(kind,0,'ascii'); bytes.writeUInt32LE(data.length,4); data.copy(bytes,8); return bytes;
}
export function riffFile(chunks) {
  const data = Buffer.concat(chunks),header = Buffer.alloc(12); header.write('RIFF',0,'ascii'); header.writeUInt32LE(data.length+4,4); header.write('WEBP',8,'ascii'); return Buffer.concat([header,data]);
}
export function riffChunks(bytes) {
  const chunks = []; for (let at = 12; at < bytes.length;) { const size = bytes.readUInt32LE(at+4); chunks.push({ kind:bytes.toString('latin1',at,at+4),data:bytes.subarray(at+8,at+8+size) }); at += 8+size+(size&1); } return chunks;
}
export function syntheticWebp(animated = false) {
  const pixel = Buffer.alloc(5); pixel[0] = 47; pixel.writeUInt32LE(31+(23 << 14),1);
  const vp = Buffer.alloc(10); vp[0] = animated ? 2 : 0; vp.writeUIntLE(31,4,3); vp.writeUIntLE(23,7,3);
  if (!animated) return riffFile([riffChunk('VP8X',vp),riffChunk('VP8L',pixel)]);
  const frame = Buffer.alloc(16); frame.writeUIntLE(31,6,3); frame.writeUIntLE(23,9,3); frame.writeUIntLE(500,12,3);
  return riffFile([riffChunk('VP8X',vp),riffChunk('ANIM',Buffer.alloc(6)),riffChunk('ANMF',Buffer.concat([frame,riffChunk('VP8L',pixel)]))]);
}
export function syntheticGif() {
  return Buffer.concat([Buffer.from('GIF89a'),Buffer.from([1,0,1,0,128,0,0,0,0,0,255,255,255,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59])]);
}
export function addPrivateMetadata(bytes,type,orientation = 1) {
  const exif = syntheticExif(orientation),secret = Buffer.from(PRIVATE_MARKER);
  if (type === 'image/png') return Buffer.concat([bytes.subarray(0,33),pngChunk('tEXt',Buffer.from('Comment\0'+PRIVATE_MARKER)),
    pngChunk('zTXt',Buffer.concat([Buffer.from('Comment\0\0'),deflateSync(secret)])),pngChunk('eXIf',exif),bytes.subarray(33)]);
  if (type === 'image/jpeg') return Buffer.concat([bytes.subarray(0,2),jpegSegment(0xe1,Buffer.concat([Buffer.from('Exif\0\0'),exif])),
    jpegSegment(0xfe,secret),jpegSegment(0xed,secret),bytes.subarray(2)]);
  if (type === 'image/gif') return Buffer.concat([bytes.subarray(0,-1),Buffer.from([33,254,secret.length]),secret,Buffer.from([0,59])]);
  if (type === 'image/webp') {
    const chunks = riffChunks(bytes); let vp = chunks.find((c) => c.kind === 'VP8X');
    if (!vp) { const data = Buffer.alloc(10); data.writeUIntLE(31,4,3); data.writeUIntLE(23,7,3); vp = { kind:'VP8X',data }; chunks.unshift(vp); }
    vp.data = Buffer.from(vp.data); vp.data[0] |= 12;
    return riffFile([...chunks.map((c) => riffChunk(c.kind,c.data)),riffChunk('EXIF',exif),riffChunk('XMP ',secret)]);
  }
  throw new Error('SYNTHETIC_TYPE_INVALID');
}
