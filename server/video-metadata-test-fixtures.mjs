// Independent synthetic structural fixtures. These are NOT decodable clinical
// recordings. Actual codec/media proof belongs to the separate native suite.
import { mediaCrc32 } from './media-container-validation.mjs';
export const VIDEO_PRIVATE_MARKER = 'CB-SYNTHETIC-PRIVATE';
export function mp4Box(kind,body = Buffer.alloc(0),wide = false) {
  const header = Buffer.alloc(wide ? 16 : 8); header.writeUInt32BE(wide ? 1 : body.length+8); header.write(kind,4,'latin1');
  if (wide) header.writeBigUInt64BE(BigInt(body.length+16),8); return Buffer.concat([header,body]);
}
export function mp4Boxes(bytes,start = 0,end = bytes.length) {
  const result = []; for (let at = start; at < end;) {
    let size = bytes.readUInt32BE(at),header = 8; if (size === 1) { size = Number(bytes.readBigUInt64BE(at+8)); header = 16; } else if (!size) size = end-at;
    result.push({ kind:bytes.toString('latin1',at+4,at+8),at,data:at+header,end:at+size }); at += size;
  } return result;
}
export function mp4Find(bytes,path) {
  let start = 0,end = bytes.length,found;
  for (const kind of path) { found = mp4Boxes(bytes,start,end).find((box) => box.kind === kind); if (!found) throw new Error('FIXTURE_BOX_MISSING'); start = found.data; end = found.end; }
  return found;
}
export function mp4Full(size,version = 0,flags = 0) { const body = Buffer.alloc(size); body[0] = version; body.writeUIntBE(flags,1,3); return body; }
export function replaceMp4Box(bytes,path,transform) {
  const [kind,...rest] = path,boxes = mp4Boxes(bytes),box = boxes.find((entry) => entry.kind === kind);
  if (!box) throw new Error('FIXTURE_BOX_MISSING');
  const body = bytes.subarray(box.data,box.end),next = rest.length ? replaceMp4Box(body,rest,transform) : transform(Buffer.from(body));
  return Buffer.concat([bytes.subarray(0,box.at),mp4Box(kind,next,box.data-box.at === 16),bytes.subarray(box.end)]);
}
export function syntheticMp4({ version = 0,codec = 'avc1',audio = false,extra = [],wide = false } = {}) {
  const marker = Buffer.from(VIDEO_PRIVATE_MARKER),ftyp = mp4Box('ftyp',Buffer.from('isom\0\0\0\0isommp42','latin1'));
  function timed(kind,base) {
    const body = mp4Full(base+(version ? 12 : 0),version,kind === 'tkhd' ? 3 : 0);
    body.fill(0x37,4,version ? 20 : 12); if (kind === 'tkhd') body.writeUInt32BE(0x40000000,(version ? 52 : 40)+32);
    return mp4Box(kind,body);
  }
  const sample = Buffer.alloc(audio ? 28 : 78); sample.writeUInt16BE(1,6);
  if (!audio) { sample.writeUInt16BE(32,24); sample.writeUInt16BE(24,26); marker.copy(sample,42); }
  const configKind = { avc1:'avcC',avc3:'avcC',hvc1:'hvcC',hev1:'hvcC',av01:'av1C',mp4v:'esds',mp4a:'esds',alac:'alac' }[codec];
  const entry = mp4Box(codec,Buffer.concat([sample,...(configKind ? [mp4Box(configKind,Buffer.from([1,2,3,4]))] : [])]));
  const stsd = mp4Full(8); stsd.writeUInt32BE(1,4);
  const dref = mp4Full(8); dref.writeUInt32BE(1,4);
  const hdlr = Buffer.concat([mp4Full(24),marker,Buffer.from([0])]); hdlr.write(audio ? 'soun' : 'vide',8,'ascii');
  const stbl = mp4Box('stbl',Buffer.concat([mp4Box('stsd',Buffer.concat([stsd,entry])),
    ...['stts','stsc','stco'].map((kind) => mp4Box(kind,mp4Full(8))),mp4Box('stsz',mp4Full(12))]));
  const dinf = mp4Box('dinf',mp4Box('dref',Buffer.concat([dref,mp4Box('url ',mp4Full(4,0,1))])));
  const mdia = mp4Box('mdia',Buffer.concat([timed('mdhd',24),mp4Box('hdlr',hdlr),mp4Box('minf',Buffer.concat([mp4Box(audio ? 'smhd' : 'vmhd',mp4Full(audio ? 8 : 12,0,audio ? 0 : 1)),dinf,stbl]))]));
  const trak = mp4Box('trak',Buffer.concat([timed('tkhd',84),mdia,mp4Box('meta',marker)]));
  const moov = mp4Box('moov',Buffer.concat([timed('mvhd',100),trak,mp4Box('udta',marker)]),wide);
  return Buffer.concat([ftyp,mp4Box('free',marker),mp4Box('mdat',Buffer.from('synthetic coded payload')),moov,...extra]);
}
export function ebmlSize(value,width) {
  const number = BigInt(value); if (!width) for (width = 1; width <= 8; width++) if (number <= (1n<<BigInt(width*7))-2n) break;
  if (width > 8 || number > (1n<<BigInt(width*7))-2n) throw new Error('FIXTURE_SIZE');
  let coded = number|(1n<<BigInt(width*7)); const bytes = Buffer.alloc(width);
  for (let i = width-1; i >= 0; i--) { bytes[i] = Number(coded&255n); coded >>= 8n; } return bytes;
}
export function ebmlElement(id,body,width) {
  const hex = id.toString(16); return Buffer.concat([Buffer.from(hex.length%2 ? '0'+hex : hex,'hex'),ebmlSize(body.length,width),body]);
}
export function ebmlUint(id,value,width = 1) { let number = BigInt(value); const bytes = Buffer.alloc(width); for (let i = width-1; i >= 0; i--) { bytes[i] = Number(number&255n); number >>= 8n; } return ebmlElement(id,bytes); }
export function ebmlFloat(id,value) { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ebmlElement(id,bytes); }
export function ebmlMaster(id,items,crc = false,width) {
  let body = Buffer.concat(items);
  if (crc) { const value = Buffer.alloc(4); value.writeUInt32LE(mediaCrc32(body)); body = Buffer.concat([ebmlElement(0xbf,value),body]); }
  return ebmlElement(id,body,width);
}
export function ebmlChildren(bytes) {
  function read(at,id) {
    if (!bytes[at]) throw new Error('FIXTURE_VINT'); let width = 1,marker = 128;
    while (!(bytes[at]&marker)) { width++; marker >>>= 1; }
    if (width > 8 || at+width > bytes.length) throw new Error('FIXTURE_VINT');
    let value = id ? bytes[at] : bytes[at]&(marker-1);
    for (let i = 1; i < width; i++) value = value*256+bytes[at+i];
    if (!Number.isSafeInteger(value)) throw new Error('FIXTURE_VINT'); return { value,next:at+width };
  }
  const result = [];
  for (let at = 0; at < bytes.length;) {
    const id = read(at,true),size = read(id.next,false),end = size.next+size.value;
    if (end > bytes.length || result.length > 200000) throw new Error('FIXTURE_SIZE');
    result.push({ id:id.value,data:bytes.subarray(size.next,end),raw:bytes.subarray(at,end) }); at = end;
  }
  return result;
}
export function webmWithSyntheticRoll(source,roll) {
  const roots = ebmlChildren(source),header = roots.find((entry) => entry.id === 0x1a45dfa3),segment = roots.find((entry) => entry.id === 0x18538067);
  const fields = ebmlChildren(segment.data),tracks = fields.find((entry) => entry.id === 0x1654ae6b);
  const entries = ebmlChildren(tracks.data).filter((entry) => entry.id !== 0xbf).map((entry) => {
    if (entry.id !== 0xae) return entry.raw;
    const fields = ebmlChildren(entry.data).filter((field) => field.id !== 0xbf).map((field) => field.id === 0xe0 ?
      ebmlMaster(0xe0,[...ebmlChildren(field.data).filter((child) => child.id !== 0xbf && child.id !== 0x7670).map((child) => child.raw),
        ebmlMaster(0x7670,[ebmlUint(0x7671,0),ebmlFloat(0x7673,0),ebmlFloat(0x7674,0),ebmlFloat(0x7675,roll)])]) : field.raw);
    return ebmlMaster(0xae,fields);
  });
  // Synthetic-only rebuilding deliberately omits auxiliary SeekHead/Cues.
  // This avoids inventing/rewriting media offsets when inserting projection.
  const body = fields.filter((entry) => [0x1549a966,0x1654ae6b,0x1254c367,0x1f43b675].includes(entry.id))
    .map((entry) => entry.id === 0x1654ae6b ? ebmlMaster(0x1654ae6b,entries) : entry.raw);
  return Buffer.concat([header.raw,ebmlMaster(0x18538067,body,false,8)]);
}
export function syntheticWebm({ crc = true,extraInfo = [],extraVideo = [],extraTrack = [],extraSegment = [],unknownSegment = false,unknownCluster = false,codec = 'V_VP8' } = {}) {
  const marker = Buffer.from(VIDEO_PRIVATE_MARKER);
  const header = ebmlMaster(0x1a45dfa3,[ebmlUint(0x4286,1),ebmlUint(0x42f7,1),ebmlUint(0x42f2,4),ebmlUint(0x42f3,8),
    ebmlElement(0x4282,Buffer.from('webm')),ebmlUint(0x4287,4),ebmlUint(0x4285,2)]);
  const info = ebmlMaster(0x1549a966,[ebmlUint(0x2ad7b1,1000000,3),ebmlFloat(0x4489,2000),ebmlElement(0x4461,Buffer.alloc(8,5)),
    ebmlElement(0x7ba9,marker),ebmlElement(0x4d80,marker),ebmlElement(0x5741,marker),ebmlElement(0x73a4,Buffer.alloc(16,11)),...extraInfo],crc);
  const video = ebmlMaster(0xe0,[ebmlUint(0xb0,32),ebmlUint(0xba,24),...extraVideo],crc);
  const tracks = ebmlMaster(0x1654ae6b,[ebmlMaster(0xae,[ebmlUint(0xd7,1),ebmlUint(0x73c5,11),ebmlUint(0x83,1),
    ebmlElement(0x86,Buffer.from(codec)),ebmlElement(0x536e,marker),ebmlElement(0x258688,marker),video,...extraTrack],crc)],crc);
  let cluster = ebmlMaster(0x1f43b675,[ebmlUint(0xe7,0),ebmlElement(0xa3,Buffer.from([0x81,0,0,0x80,1,2,3]))],crc,8);
  if (unknownCluster) cluster.fill(255,4,12),cluster[4] = 1;
  const segment = ebmlMaster(0x18538067,[info,tracks,ebmlElement(0x1254c367,marker),ebmlElement(0xec,marker),cluster,...extraSegment],crc,8);
  if (unknownSegment) segment.fill(255,4,12),segment[4] = 1;
  return Buffer.concat([header,segment]);
}
