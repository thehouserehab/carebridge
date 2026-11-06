// Synthetic source construction independent of the production canonicalizer.
import { deflateSync,inflateSync } from 'node:zlib';
import { pngChunk,pngChunks,jpegSegment,riffChunk,riffFile,riffChunks,PRIVATE_MARKER } from './image-metadata-test-fixtures.mjs';
export function iccMluc(text = PRIVATE_MARKER) {
  const string = Buffer.from(text,'utf16le').swap16(),bytes = Buffer.alloc(28+string.length);
  bytes.write('mluc'); bytes.writeUInt32BE(1,8); bytes.writeUInt32BE(12,12); bytes.write('enUS',16); bytes.writeUInt32BE(string.length,20); bytes.writeUInt32BE(28,24); string.copy(bytes,28); return bytes;
}
export function iccDesc(text = PRIVATE_MARKER) {
  const string = Buffer.from(text+'\0'),bytes = Buffer.alloc(90+string.length); bytes.write('desc'); bytes.writeUInt32BE(string.length,8); string.copy(bytes,12); return bytes;
}
export function iccText(text = 'Synthetic legal notice - preserve verbatim') { return Buffer.concat([Buffer.from('text'),Buffer.alloc(4),Buffer.from(text+'\0')]); }
export function iccNumeric(type,values) {
  const bytes = Buffer.alloc(8+values.length*4); bytes.write(type); for (const [index,value] of values.entries()) bytes.writeInt32BE(Math.round(value*65536),8+index*4); return bytes;
}
export function iccCurve(count = 17) {
  const bytes = Buffer.alloc(12+count*2); bytes.write('curv'); bytes.writeUInt32BE(count,8);
  for (let index = 0; index < count; index++) bytes.writeUInt16BE(count === 1 ? 563 : Math.round(index/(count-1)*65535),12+index*2); return bytes;
}
export function profileTags(bytes) {
  return Array.from({ length:bytes.readUInt32BE(128) },(_,index) => {
    const at = 132+index*12,offset = bytes.readUInt32BE(at+4),size = bytes.readUInt32BE(at+8);
    return { name:bytes.toString('latin1',at,at+4),offset,size,data:bytes.subarray(offset,offset+size) };
  });
}
export function repackProfile(header,tags,gap = Buffer.alloc(0)) {
  const table = Buffer.alloc(132+tags.length*12); header.subarray(0,128).copy(table); table.writeUInt32BE(tags.length,128);
  const padding = Buffer.alloc(Math.ceil(gap.length/4)*4); gap.copy(padding); const parts = [table,padding]; let offset = table.length+padding.length;
  for (const [index,{ name,data }] of tags.entries()) {
    const at = 132+index*12; table.write(name,at); table.writeUInt32BE(offset,at+4); table.writeUInt32BE(data.length,at+8);
    const pad = Buffer.alloc((4-data.length%4)%4); parts.push(data,pad); offset += data.length+pad.length;
  }
  table.writeUInt32BE(offset); return Buffer.concat(parts);
}
export function syntheticIcc({ major = 4,space = 'RGB ',extra = [],samples = 17 } = {}) {
  const header = Buffer.alloc(128); header[8] = major; header[9] = major === 4 ? 0x30 : 0x10;
  header.write('lcms',4); header.write('mntr',12); header.write(space,16); header.write('XYZ ',20); header.write('acsp',36); header.write('MSFT',40);
  [2020,1,2,3,4,5].forEach((n,index) => header.writeUInt16BE(n,24+index*2)); header.writeUInt32BE(3,44); header.write('FAKE',48); header.write('TEST',52); header.write('TEST',80);
  [0.9642,1,0.8249].forEach((n,index) => header.writeInt32BE(Math.round(n*65536),68+index*4));
  const tags = [{ name:'desc',data:major === 4 ? iccMluc() : iccDesc() },{ name:'cprt',data:major === 4 ? iccMluc('Synthetic legal notice - preserve verbatim') : iccText() },
    { name:'wtpt',data:iccNumeric('XYZ ',[0.9642,1,0.8249]) },{ name:'dmnd',data:major === 4 ? iccMluc() : iccDesc() }];
  if (space === 'GRAY') tags.push({ name:'kTRC',data:iccCurve(samples) });
  else {
    for (const [name,values] of [['rXYZ',[0.4361,0.2225,0.0139]],['gXYZ',[0.3851,0.7169,0.0971]],['bXYZ',[0.1431,0.0606,0.7141]]]) tags.push({ name,data:iccNumeric('XYZ ',values) });
    for (const name of ['rTRC','gTRC','bTRC']) tags.push({ name,data:iccCurve(samples) });
  }
  return repackProfile(header,[...tags,...extra],Buffer.from(PRIVATE_MARKER));
}
export function attachIcc(bytes,type,profile,segmentSize = 65519) {
  if (type === 'image/png') return Buffer.concat([bytes.subarray(0,33),pngChunk('iCCP',Buffer.concat([Buffer.from('Synthetic profile\0\0'),deflateSync(profile)])),bytes.subarray(33)]);
  if (type === 'image/jpeg') {
    const count = Math.ceil(profile.length/segmentSize),parts = [];
    for (let index = 0; index < count; index++) parts.push(jpegSegment(0xe2,Buffer.concat([Buffer.from('ICC_PROFILE\0'),Buffer.from([index+1,count]),profile.subarray(index*segmentSize,(index+1)*segmentSize)])));
    return Buffer.concat([bytes.subarray(0,2),...parts,bytes.subarray(2)]);
  }
  if (type === 'image/webp') {
    const chunks = riffChunks(bytes); let header = chunks.find((c) => c.kind === 'VP8X');
    if (!header) { const data = Buffer.alloc(10); data.writeUIntLE(31,4,3); data.writeUIntLE(23,7,3); header = { kind:'VP8X',data }; chunks.unshift(header); }
    header.data = Buffer.from(header.data); header.data[0] |= 0x20;
    return riffFile(chunks.flatMap((chunk) => chunk.kind === 'VP8X' ? [riffChunk(chunk.kind,chunk.data),riffChunk('ICCP',profile)] : [riffChunk(chunk.kind,chunk.data)]));
  }
  if (type === 'image/gif') {
    const palette = bytes[10]&128 ? 3*2**((bytes[10]&7)+1) : 0,start = 13+palette,parts = [Buffer.from([33,255,11]),Buffer.from('ICCRGBG1012')];
    for (let at = 0; at < profile.length; at += 255) { const part = profile.subarray(at,at+255); parts.push(Buffer.from([part.length]),part); }
    return Buffer.concat([bytes.subarray(0,start),...parts,Buffer.from([0]),bytes.subarray(start)]);
  }
  throw new Error('SYNTHETIC_ICC_TYPE');
}
export function extractIcc(bytes,type) {
  if (type === 'image/png') { const data = pngChunks(bytes).find((c) => c.kind === 'iCCP').data; return inflateSync(data.subarray(data.indexOf(0)+2)); }
  if (type === 'image/webp') return riffChunks(bytes).find((c) => c.kind === 'ICCP').data;
  if (type === 'image/jpeg') {
    const parts = []; let at = 2;
    while (bytes[at] === 255) {
      const marker = bytes[at+1]; if (marker === 0xda || marker === 0xd9) break;
      const size = bytes.readUInt16BE(at+2),data = bytes.subarray(at+4,at+size+2);
      if (marker === 0xe2 && data.subarray(0,12).equals(Buffer.from('ICC_PROFILE\0'))) parts[data[12]-1] = data.subarray(14); at += size+2;
    }
    return Buffer.concat(parts);
  }
  if (type === 'image/gif') {
    const at = bytes.indexOf(Buffer.from('ICCRGBG1012'))+11; if (at < 11) throw new Error('SYNTHETIC_ICC_MISSING');
    const parts = []; for (let pos = at; bytes[pos];) { const size = bytes[pos++]; parts.push(bytes.subarray(pos,pos+size)); pos += size; } return Buffer.concat(parts);
  }
  throw new Error('SYNTHETIC_ICC_TYPE');
}
