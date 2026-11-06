import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

const invalid = () => fail('SCAN_INVALID'),unsupported = () => fail('SCAN_UNAVAILABLE');
const children = {
  root:['ftyp','moov','mdat','moof','sidx','mfra','styp','prft'],
  moov:['mvhd','trak','mvex','udta','meta'],trak:['tkhd','mdia','edts','udta','meta'],
  mdia:['mdhd','hdlr','minf'],minf:['vmhd','smhd','dinf','stbl'],dinf:['dref'],
  stbl:['stsd','stts','ctts','stsc','stsz','stz2','stco','co64','stss','sdtp','sgpd','sbgp','cslg'],
  edts:['elst'],mvex:['trex','mehd'],moof:['mfhd','traf'],traf:['tfhd','tfdt','trun'],mfra:['tfra','mfro'],
  video:['avcC','hvcC','av1C','esds','pasp','clap','colr','btrt','fiel','gama','mdcv','clli'],
  audio:['esds','alac','btrt','chan'],
};
const videoEntries = ['avc1','avc3','hvc1','hev1','av01','mp4v'],audioEntries = ['mp4a','.mp3','alac'];
const repeating = new Set(['trak','mdat','moof','traf','trun','trex','tfra','sidx','prft']);
const padding = new Set(['free','skip']);
const xmpUuid = Buffer.from('be7acfcb97a942e89c71999491e3afac','hex');

// Same-size replacement deliberately preserves every media/sample/index offset.
// This is a bounded container rewrite, NOT a decoder or an upload approval.
export function rewriteMp4Metadata(source) {
  const output = Buffer.from(source),payloadHash = createHash('sha256'),displayHash = createHash('sha256');
  let boxes = 0,mediaUnits = 0,videoTracks = 0,audioTracks = 0;
  function boxesAt(start,end,depth) {
    if (depth > 12) invalid(); const result = [];
    for (let at = start; at < end;) {
      if (++boxes > 200000 || at+8 > end) invalid();
      let size = source.readUInt32BE(at),header = 8;
      const kind = source.toString('latin1',at+4,at+8);
      if (size === 1) {
        if (at+16 > end) invalid(); const wide = source.readBigUInt64BE(at+8);
        if (wide > BigInt(end-at)) invalid(); size = Number(wide); header = 16;
      } else if (size === 0) { if (depth || kind !== 'mdat') invalid(); size = end-at; }
      if (size < header || at+size > end) invalid();
      result.push({ kind,at,data:at+header,end:at+size,header }); at += size;
    }
    return result;
  }
  function neutral(box) {
    output.write('free',box.at+4,'ascii'); output.fill(0,box.data,box.end);
  }
  const data = (box) => source.subarray(box.data,box.end);
  function full(bytes,versions = [0],allowedFlags = 0) {
    if (bytes.length < 4 || !versions.includes(bytes[0]) || (bytes.readUIntBE(1,3)&~allowedFlags)) invalid();
    return bytes[0];
  }
  const exact = (bytes,size) => { if (bytes.length !== size) invalid(); };
  function counted(bytes,base,width,versions = [0]) {
    full(bytes,versions); if (bytes.length < base) invalid();
    const count = bytes.readUInt32BE(base-4);
    if (count > 200000 || bytes.length !== base+count*width) invalid();
  }
  function headerTime(box,base) {
    const bytes = data(box),version = full(bytes,[0,1],box.kind === 'tkhd' ? 15 : 0);
    exact(bytes,base+(version ? 12 : 0)); output.fill(0,box.data+4,box.data+(version ? 20 : 12));
    if (box.kind === 'tkhd') displayHash.update(bytes.subarray(version ? 52 : 40));
  }
  function sampleDescription(box,depth) {
    const bytes = data(box); full(bytes); if (bytes.length < 8) invalid();
    const entries = boxesAt(box.data+8,box.end,depth+1);
    if (!entries.length || entries.length > 16 || entries.length !== bytes.readUInt32BE(4)) invalid();
    for (const entry of entries) {
      const visual = videoEntries.includes(entry.kind),audio = audioEntries.includes(entry.kind),body = data(entry);
      if (!visual && !audio) unsupported(); const base = visual ? 78 : 28;
      if (body.length < base || body.subarray(0,6).some((n) => n !== 0) || !body.readUInt16BE(6)) invalid();
      if (visual) {
        if (!body.readUInt16BE(24) || !body.readUInt16BE(26)) invalid();
        output.fill(0,entry.data+42,entry.data+74); displayHash.update(body.subarray(24,42));
      } else if (body.readUInt16BE(8) !== 0) unsupported(); // QuickTime versioned audio is not ISOBMFF v0.
      const config = walk(entry.data+base,entry.end,visual ? 'video' : 'audio',depth+2);
      const required = { avc1:'avcC',avc3:'avcC',hvc1:'hvcC',hev1:'hvcC',av01:'av1C',mp4v:'esds',mp4a:'esds',alac:'alac' }[entry.kind];
      if (required && !config.has(required)) invalid();
    }
  }
  function leaf(box,depth) {
    const bytes = data(box),kind = box.kind;
    if (kind === 'mdat') {
      if (!bytes.length) invalid(); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
      payloadHash.update(length).update(bytes); mediaUnits++; return;
    }
    if (['ftyp','styp'].includes(kind)) { if (bytes.length < 8 || bytes.length%4 || bytes.toString('latin1',0,4) === 'qt  ') invalid(); return; }
    if (kind === 'mvhd') return headerTime(box,100);
    if (kind === 'tkhd') return headerTime(box,84);
    if (kind === 'mdhd') return headerTime(box,24);
    if (kind === 'hdlr') {
      full(bytes); if (bytes.length < 24 || bytes.length > 65536) invalid();
      const handler = bytes.toString('latin1',8,12);
      if (handler === 'vide') videoTracks++; else if (handler === 'soun') audioTracks++; else unsupported();
      output.fill(0,box.data+24,box.end); return;
    }
    if (kind === 'stsd') return sampleDescription(box,depth);
    if (kind === 'dref') {
      full(bytes); if (bytes.length < 8) invalid(); const entries = boxesAt(box.data+8,box.end,depth+1);
      if (!entries.length || entries.length > 16 || entries.length !== bytes.readUInt32BE(4)) invalid();
      for (const entry of entries) {
        const ref = data(entry); if (entry.kind !== 'url ') unsupported(); full(ref,[0],1);
        if (ref.length !== 4 || ref.readUIntBE(1,3) !== 1) unsupported();
      }
      return;
    }
    const widths = { stts:8,ctts:8,stsc:12,stco:4,co64:8,stss:4 };
    if (Object.hasOwn(widths,kind)) return counted(bytes,8,widths[kind],kind === 'ctts' ? [0,1] : [0]);
    if (kind === 'stsz') { full(bytes); if (bytes.length < 12) invalid(); const count = bytes.readUInt32BE(8); if (count > 200000 || bytes.length !== 12+(bytes.readUInt32BE(4) ? 0 : count*4)) invalid(); return; }
    if (kind === 'stz2') {
      full(bytes); if (bytes.length < 12 || bytes.readUIntBE(4,3) || ![4,8,16].includes(bytes[7])) invalid();
      const count = bytes.readUInt32BE(8); if (count > 200000 || bytes.length !== 12+Math.ceil(count*bytes[7]/8)) invalid(); return;
    }
    if (kind === 'sdtp') { full(bytes); if (bytes.length > 200004) invalid(); return; }
    if (kind === 'elst') { const version = full(bytes,[0,1]); return counted(bytes,8,version ? 20 : 12,[0,1]); }
    if (kind === 'cslg') { const version = full(bytes,[0,1]); exact(bytes,version ? 44 : 24); return; }
    if (kind === 'sbgp') {
      const version = full(bytes,[0,1]); if (bytes.length < 12 || !['roll','prol'].includes(bytes.toString('latin1',4,8))) unsupported();
      return counted(bytes,version ? 16 : 12,8,[0,1]);
    }
    if (kind === 'sgpd') {
      const version = full(bytes,[0,1,2]); if (bytes.length < 12 || !['roll','prol'].includes(bytes.toString('latin1',4,8))) unsupported();
      if (version && bytes.readUInt32BE(8) !== 2) unsupported(); return counted(bytes,version === 2 ? 20 : version ? 16 : 12,2,[0,1,2]);
    }
    if (kind === 'tfhd') {
      full(bytes,[0],0x03003b); if (bytes.length < 8) invalid(); const flags = bytes.readUIntBE(1,3);
      exact(bytes,8+((flags&1) ? 8 : 0)+[2,8,16,32].filter((bit) => flags&bit).length*4); return;
    }
    if (kind === 'trun') {
      full(bytes,[0,1],0xf05); if (bytes.length < 8) invalid(); const flags = bytes.readUIntBE(1,3),count = bytes.readUInt32BE(4);
      if (count > 200000) invalid(); exact(bytes,8+[1,4].filter((bit) => flags&bit).length*4+count*[0x100,0x200,0x400,0x800].filter((bit) => flags&bit).length*4); return;
    }
    if (['tfdt','mehd'].includes(kind)) { const version = full(bytes,[0,1]); exact(bytes,version ? 12 : 8); return; }
    if (kind === 'sidx') {
      const version = full(bytes,[0,1]),base = version ? 32 : 24; if (bytes.length < base) invalid();
      exact(bytes,base+12*bytes.readUInt16BE(base-2)); return;
    }
    if (kind === 'tfra') {
      const version = full(bytes,[0,1]); if (bytes.length < 16 || bytes.readUInt32BE(8)&0xffffffc0) invalid();
      const lengths = bytes.readUInt32BE(8),count = bytes.readUInt32BE(12);
      if (count > 200000) invalid(); exact(bytes,16+count*((version ? 16 : 8)+((lengths>>>4)&3)+((lengths>>>2)&3)+(lengths&3)+3)); return;
    }
    const fixedFull = { vmhd:12,smhd:8,mfhd:8,mfro:8,trex:24 };
    if (Object.hasOwn(fixedFull,kind)) { full(bytes,[0],kind === 'vmhd' ? 1 : 0); exact(bytes,fixedFull[kind]); return; }
    const fixed = { pasp:8,clap:32,btrt:12,fiel:2,gama:4,mdcv:24,clli:4 };
    if (Object.hasOwn(fixed,kind)) { exact(bytes,fixed[kind]); if (kind !== 'btrt') displayHash.update(bytes); return; }
    if (kind === 'colr') {
      const color = bytes.toString('latin1',0,4); if (!['nclx','nclc'].includes(color)) unsupported();
      exact(bytes,color === 'nclx' ? 11 : 10); if (color === 'nclx' && bytes[10]&127) invalid(); displayHash.update(bytes); return;
    }
    if (kind === 'chan') { full(bytes); if (bytes.length < 16) invalid(); const count = bytes.readUInt32BE(12); if (count > 64) invalid(); exact(bytes,16+20*count); return; }
    // Codec configuration is retained byte-for-byte, never treated as text.
    // A full decoder must separately validate it and every compressed sample.
    if (['avcC','hvcC','av1C','esds','alac'].includes(kind)) { if (!bytes.length || bytes.length > 1024*1024) invalid(); return; }
    unsupported();
  }
  function walk(start,end,parent,depth) {
    const seen = new Set(),counts = new Map();
    for (const box of boxesAt(start,end,depth)) {
      const count = (counts.get(box.kind) ?? 0)+1; counts.set(box.kind,count);
      if (padding.has(box.kind)) { neutral(box); continue; }
      if (box.kind === 'uuid') {
        if (box.end-box.data < 16) invalid();
        if (!source.subarray(box.data,box.data+16).equals(xmpUuid)) unsupported(); neutral(box); continue;
      }
      if (!children[parent]?.includes(box.kind)) unsupported();
      if (count > 1 && !repeating.has(box.kind)) invalid(); seen.add(box.kind);
      if (['udta','meta','prft'].includes(box.kind)) { neutral(box); continue; }
      if (Object.hasOwn(children,box.kind)) {
        const inner = walk(box.data,box.end,box.kind,depth+1);
        const required = { moov:['mvhd','trak'],trak:['tkhd','mdia'],mdia:['mdhd','hdlr','minf'],
          minf:['dinf','stbl'],dinf:['dref'],stbl:['stsd','stts','stsc'],edts:['elst'],moof:['mfhd','traf'],traf:['tfhd','trun'] }[box.kind] ?? [];
        if (required.some((kind) => !inner.has(kind))) invalid();
        if (box.kind === 'stbl' && (inner.has('stsz') === inner.has('stz2') || inner.has('stco') === inner.has('co64'))) invalid();
      } else leaf(box,depth);
    }
    return seen;
  }
  const seen = walk(0,source.length,'root',0);
  if (!seen.has('ftyp') || !seen.has('moov') || !mediaUnits || videoTracks !== 1 || audioTracks > 1) invalid();
  return { bytes:output,containerMediaUnits:mediaUnits,codedPayloadSha256:payloadHash.digest('hex'),displayStateSha256:displayHash.digest('hex') };
}
