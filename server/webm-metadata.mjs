import { createHash } from 'node:crypto';
import { mediaCrc32 } from './media-container-validation.mjs';
import { fail } from './errors.mjs';

const invalid = () => fail('SCAN_INVALID'),unsupported = () => fail('SCAN_UNAVAILABLE');
// Explicit parent grammar. Unknown elements are NOT silently deleted: they
// may change playback, color, encryption or a future codec's interpretation.
const grammar = {
  root:[0x1a45dfa3,0x18538067],
  0x1a45dfa3:[0x4286,0x42f7,0x42f2,0x42f3,0x4282,0x4287,0x4285],
  0x18538067:[0x114d9b74,0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b,0x1254c367,0x1941a469],
  0x1549a966:[0x2ad7b1,0x4489,0x4461,0x7ba9,0x4d80,0x5741,0x73a4,0x7384,0x3cb923,0x3c83ab,0x3eb923,0x3e83bb,0x4444],
  0x1654ae6b:[0xae],
  0xae:[0xd7,0x73c5,0x83,0xb9,0x88,0x55aa,0x55ab,0x55ac,0x55ad,0x55ae,0x55af,0x55ee,0x9c,0xaa,0x23e383,0x234e7a,0x23314f,0x536e,0x22b59c,0x22b59d,0x86,0x63a2,0x258688,0x56aa,0x56bb,0x6fab,0xe0,0xe1],
  0xe0:[0x9a,0x9d,0x53b8,0x53c0,0xb0,0xba,0x54aa,0x54bb,0x54cc,0x54dd,0x54b0,0x54ba,0x54b2,0x54b3,0x2eb524,0x2fb523,0x2383e3,0x55b0,0x7670],
  0x55b0:[0x55b1,0x55b2,0x55b3,0x55b4,0x55b5,0x55b6,0x55b7,0x55b8,0x55b9,0x55ba,0x55bb,0x55bc,0x55bd,0x55d0],
  0x55d0:[0x55d1,0x55d2,0x55d3,0x55d4,0x55d5,0x55d6,0x55d7,0x55d8,0x55d9,0x55da],
  0x7670:[0x7671,0x7672,0x7673,0x7674,0x7675],
  0xe1:[0xb5,0x78b5,0x9f,0x6264,0x52f1],
  0x1f43b675:[0xe7,0xa7,0xab,0xa3,0xa0],
  0xa0:[0xa1,0x9b,0xfa,0xfb,0x75a2],
  0x1c53bb6b:[0xbb],0xbb:[0xb3,0xb7],0xb7:[0xf7,0xf1,0xf0,0xb2,0x5378,0xea],
};
const removed = new Set([0x114d9b74,0x1254c367,0x1941a469,0x4461,0x7ba9,0x73a4,0x7384,0x3cb923,0x3c83ab,0x3eb923,0x3e83bb,0x4444,0x536e,0x258688]);
const repeating = new Set([0x1f43b675,0xae,0xa3,0xa0,0xbb,0xb7,0xfb,0x4444]);
const floats = new Set([0x4489,0x23314f,0x2383e3,0xb5,0x78b5,0x7673,0x7674,0x7675,...Array.from({ length:10 },(_,i) => 0x55d1+i)]);
const binary = new Set([0xa3,0xa1,0x63a2,0x2eb524,0x2fb523,0x7672]);
const displayParents = new Set([0xe0,0x55b0,0x55d0,0x7670,0xe1]);
const booleans = new Set([0xb9,0x88,0x55aa,0x55ab,0x55ac,0x55ad,0x55ae,0x55af,0x9c,0xaa]);

export function rewriteWebmMetadata(source) {
  const output = Buffer.from(source),payloadHash = createHash('sha256'),displayHash = createHash('sha256');
  let elements = 0,mediaUnits = 0,videoTracks = 0,audioTracks = 0;
  function vint(at,end,id = false) {
    if (at >= end || !source[at]) invalid(); let size = 1,marker = 128;
    while (!(source[at]&marker)) { size++; marker >>>= 1; }
    if (size > (id ? 4 : 8) || at+size > end) invalid();
    let value = BigInt(source[at]&(marker-1)); for (let i = 1; i < size; i++) value = (value<<8n)|BigInt(source[at+i]);
    const max = (1n<<BigInt(size*7))-1n,unknown = value === max;
    if (id && (value === 0n || unknown || size > 1 && value <= (1n<<BigInt((size-1)*7))-1n)) invalid();
    if (id) value |= 1n<<BigInt(size*7);
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return { value:id || !unknown ? Number(value) : null,next:at+size,size,unknown };
  }
  function neutral(at,end) {
    const total = end-at; output.fill(0,at,end); output[at] = 0xec;
    for (let size = 1; size <= 8; size++) {
      const payload = total-1-size; if (payload < 0 || BigInt(payload) > (1n<<BigInt(7*size))-2n) continue;
      let value = BigInt(payload)|(1n<<BigInt(7*size));
      for (let i = size; i >= 1; i--) { output[at+i] = Number(value&255n); value >>= 8n; } return;
    }
    invalid();
  }
  function number(at,end,signed = false) {
    if (end-at < 1 || end-at > 8) invalid(); let value = 0n;
    for (let i = at; i < end; i++) value = (value<<8n)|BigInt(source[i]);
    if (signed && source[at]&128) value -= 1n<<BigInt((end-at)*8);
    return value;
  }
  function float(at,end) {
    const size = end-at; if (![4,8].includes(size)) invalid();
    const value = size === 4 ? source.readFloatBE(at) : source.readDoubleBE(at); if (!Number.isFinite(value)) invalid(); return value;
  }
  function string(at,end) {
    if (end-at > 65536) invalid(); const bytes = source.subarray(at,end),firstZero = bytes.indexOf(0);
    if (firstZero >= 0 && bytes.subarray(firstZero).some((n) => n !== 0)) invalid();
    try { return new TextDecoder('utf-8',{ fatal:true }).decode(firstZero < 0 ? bytes : bytes.subarray(0,firstZero)); } catch { invalid(); }
  }
  function leaf(id,at,end,parent) {
    if ([0x4d80,0x5741].includes(id)) {
      if (!string(at,end).length) invalid(); output.fill(0,at,end);
      Buffer.from('Carebridge-v1').copy(output,at,0,Math.min(end-at,13)); return;
    }
    if (id === 0x4282) { if (string(at,end) !== 'webm') unsupported(); return; }
    if (id === 0x86) {
      if (!['V_VP8','V_VP9','V_AV1','A_OPUS','A_VORBIS'].includes(string(at,end))) unsupported(); return;
    }
    if ([0x22b59c,0x22b59d].includes(id)) { if (!/^[a-zA-Z0-9-]{1,35}$/.test(string(at,end))) invalid(); return; }
    if (binary.has(id)) {
      if (end === at || id === 0x63a2 && end-at > 1024*1024) invalid();
      if ([0xa3,0xa1].includes(id)) {
        const track = vint(at,end); if (track.unknown || !track.value || track.next+3 > end) invalid();
        const length = Buffer.alloc(4); length.writeUInt32BE(end-at); payloadHash.update(length).update(source.subarray(at,end)); mediaUnits++;
      }
    } else if (floats.has(id)) {
      const value = float(at,end);
      if ([0x4489,0x23314f,0x2383e3,0xb5,0x78b5].includes(id) && value <= 0 ||
          [0x7673,0x7675].includes(id) && Math.abs(value) > 180 || id === 0x7674 && Math.abs(value) > 90) invalid();
    } else {
      const value = number(at,end,id === 0xfb || id === 0x75a2);
      if (id === 0x83) { if (value === 1n) videoTracks++; else if (value === 2n) audioTracks++; else unsupported(); }
      if (booleans.has(id) && value > 1n) invalid();
      if ([0x2ad7b1,0xd7,0x73c5,0xb0,0xba,0x9f,0x6264].includes(id) && value <= 0n) invalid();
      if (id === 0x4286 && value !== 1n || id === 0x42f7 && value !== 1n || id === 0x42f2 && value > 4n ||
          id === 0x42f3 && value > 8n || [0x4285,0x4287].includes(id) && (value < 1n || value > 4n)) unsupported();
    }
    if (displayParents.has(parent)) {
      const header = Buffer.alloc(4); header.writeUInt32BE(id); displayHash.update(header).update(source.subarray(at,end));
    }
  }
  function walk(start,limit,parent,depth,unknownCluster = false) {
    if (depth > 12) invalid(); let at = start,crc = null;
    const seen = new Set(); let trackType = null,codec = null;
    while (at < limit) {
      if (++elements > 200000) invalid(); const id = vint(at,limit,true),size = vint(id.next,limit);
      if (unknownCluster && grammar[0x18538067].includes(id.value)) break;
      let end = size.unknown ? limit : size.next+size.value;
      if (end > limit) invalid();
      if (size.unknown && ![0x18538067,0x1f43b675].includes(id.value)) invalid();
      if (id.value === 0xec) { if (size.unknown) invalid(); neutral(at,end); at = end; continue; }
      if (id.value === 0xbf) {
        if (crc || at !== start || end-size.next !== 4 || parent === 'root') invalid();
        crc = { at,data:size.next,end }; at = end; continue;
      }
      if (!grammar[parent]?.includes(id.value)) {
        try { unsupported(); } catch (error) { error.elementId = id.value; throw error; }
      }
      if (seen.has(id.value) && !repeating.has(id.value)) invalid(); seen.add(id.value);
      if (removed.has(id.value)) { neutral(at,end); at = end; continue; }
      if (Object.hasOwn(grammar,id.value)) {
        const inner = walk(size.next,end,id.value,depth+1,size.unknown && id.value === 0x1f43b675);
        if (size.unknown && id.value === 0x1f43b675) end = inner.end;
        const required = { [0x18538067]:[0x1549a966,0x1654ae6b,0x1f43b675],
          [0x1549a966]:[0x4d80,0x5741],[0x1654ae6b]:[0xae],[0xae]:[0xd7,0x73c5,0x83,0x86],
          [0xe0]:[0xb0,0xba],[0x1f43b675]:[0xe7],[0xa0]:[0xa1],[0xbb]:[0xb3,0xb7],[0xb7]:[0xf7,0xf1] }[id.value] ?? [];
        if (required.some((id) => !inner.seen.has(id))) invalid();
        if (id.value === 0xae && (inner.trackType === 1 ? !inner.seen.has(0xe0) || inner.seen.has(0xe1) || !inner.codec?.startsWith('V_') :
          !inner.seen.has(0xe1) || inner.seen.has(0xe0) || !inner.codec?.startsWith('A_'))) invalid();
      } else leaf(id.value,size.next,end,parent);
      if (parent === 0xae && id.value === 0x83) trackType = Number(number(size.next,end));
      if (parent === 0xae && id.value === 0x86) codec = string(size.next,end);
      at = end;
    }
    if (crc) {
      // RFC 8794: CRC is first, covers parent data excluding the CRC element,
      // little-endian storage. Nested CRCs are recomputed from inside out.
      if (mediaCrc32(source.subarray(crc.end,at)) !== source.readUInt32LE(crc.data)) invalid();
      output.writeUInt32LE(mediaCrc32(output.subarray(crc.end,at)),crc.data);
    }
    return { end:at,seen,trackType,codec };
  }
  const result = walk(0,source.length,'root',0);
  if (!result.seen.has(0x1a45dfa3) || !result.seen.has(0x18538067) || !mediaUnits || videoTracks !== 1 || audioTracks > 1) invalid();
  return { bytes:output,containerMediaUnits:mediaUnits,codedPayloadSha256:payloadHash.digest('hex'),displayStateSha256:displayHash.digest('hex') };
}
