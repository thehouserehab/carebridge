import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { prepareVideoDerivative,VIDEO_METADATA_POLICY } from '../video-metadata.mjs';
import { VIDEO_PRIVATE_MARKER,syntheticMp4,mp4Box,mp4Find,mp4Full,replaceMp4Box,syntheticWebm,ebmlElement,ebmlMaster,ebmlUint,ebmlFloat } from '../video-metadata-test-fixtures.mjs';
const invalid = (run) => assert.throws(run,{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
const unavailable = (run) => assert.throws(run,{ code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (source,type) => {
  const snapshot = Buffer.from(source),result = prepareVideoDerivative(source,type),again = prepareVideoDerivative(result.bytes,type);
  assert.deepEqual(source,snapshot); assert.notEqual(result.bytes,source); assert.equal(result.bytes.length,source.length);
  assert.deepEqual(result.source,{ size:source.length,sha256:sha(source) }); assert.deepEqual(result.derivative,{ size:result.bytes.length,sha256:sha(result.bytes) });
  assert.equal(result.policyVersion,VIDEO_METADATA_POLICY); assert.equal(result.mediaAcceptanceReady,false); assert.equal(result.bytes.includes(Buffer.from(VIDEO_PRIVATE_MARKER)),false);
  assert.deepEqual(again.bytes,result.bytes); assert.equal(again.codedPayloadSha256,result.codedPayloadSha256); assert.equal(again.displayStateSha256,result.displayStateSha256);
  assert.equal('verdict' in result,false); assert.equal('inspect' in result,false); return result;
};
test('video candidates are byte-only bounded not scanner or acceptance reports',() => {
  for (const value of [null,new Uint8Array(20),'private.mp4',Buffer.alloc(0),Buffer.alloc(50*1024*1024+1)]) invalid(() => prepareVideoDerivative(value,'video/mp4'));
  invalid(() => prepareVideoDerivative(syntheticMp4(),'image/jpeg'));
});
test('MP4 v0 and v1 times text and padding are neutralized without moving payload or matrices',() => {
  for (const version of [0,1]) for (const wide of [false,true]) {
    const source = syntheticMp4({ version,wide }),result = check(source,'video/mp4');
    const before = mp4Find(source,['mdat']),after = mp4Find(result.bytes,['mdat']); assert.deepEqual(after,before);
    assert.deepEqual(result.bytes.subarray(after.data,after.end),source.subarray(before.data,before.end));
    for (const path of [['moov','mvhd'],['moov','trak','tkhd'],['moov','trak','mdia','mdhd']]) {
      const box = mp4Find(source,path),end = box.data+(version ? 20 : 12);
      assert.ok(result.bytes.subarray(box.data+4,end).every((value) => value === 0)); assert.deepEqual(result.bytes.subarray(end,box.end),source.subarray(end,box.end));
    }
  }
});
test('all accepted MP4 video sample entry families preserve codec configuration',() => {
  for (const codec of ['avc1','avc3','hvc1','hev1','av01','mp4v']) check(syntheticMp4({ codec }),'video/mp4');
});
test('known XMP UUID and padding are erased while unknown UUID is not blindly removed',() => {
  const xmp = Buffer.from('be7acfcb97a942e89c71999491e3afac','hex');
  check(syntheticMp4({ extra:[mp4Box('uuid',Buffer.concat([xmp,Buffer.from(VIDEO_PRIVATE_MARKER)]))] }),'video/mp4');
  unavailable(() => prepareVideoDerivative(syntheticMp4({ extra:[mp4Box('uuid',Buffer.alloc(20))] }),'video/mp4'));
  invalid(() => prepareVideoDerivative(syntheticMp4({ extra:[mp4Box('uuid',Buffer.alloc(1))] }),'video/mp4'));
});
test('MP4 appended damage impossible sizes and unknown technical boxes fail closed',() => {
  const bytes = syntheticMp4(); invalid(() => prepareVideoDerivative(Buffer.concat([bytes,Buffer.from([1])]),'video/mp4'));
  for (const size of [2,7,0xffffffff]) { const source = Buffer.from(bytes),box = mp4Find(source,['moov']); source.writeUInt32BE(size,box.at); invalid(() => prepareVideoDerivative(source,'video/mp4')); }
  unavailable(() => prepareVideoDerivative(syntheticMp4({ extra:[mp4Box('abcd',Buffer.alloc(8))] }),'video/mp4'));
});
test('MP4 structural counts and unsupported tracks cannot create accepted candidates',() => {
  const source = syntheticMp4(),box = mp4Find(source,['moov','trak','mdia','hdlr']); source.write('text',box.data+8);
  unavailable(() => prepareVideoDerivative(source,'video/mp4'));
  const data = syntheticMp4(),stsd = mp4Find(data,['moov','trak','mdia','minf','stbl','stsd']); data.writeUInt32BE(2,stsd.data+4);
  invalid(() => prepareVideoDerivative(data,'video/mp4'));
});
test('external MP4 data references and encrypted/unknown sample entries are unavailable',() => {
  const source = syntheticMp4(),box = mp4Find(source,['moov','trak','mdia','minf','dinf','dref']); source.fill(0,box.data+8+8,box.data+8+12);
  unavailable(() => prepareVideoDerivative(source,'video/mp4'));
  unavailable(() => prepareVideoDerivative(syntheticMp4({ codec:'encv' }),'video/mp4'));
});
test('MP4 zero-length terminal mdat is supported without changing its offset',() => {
  const source = syntheticMp4(),mdat = mp4Find(source,['mdat']),moov = mp4Find(source,['moov']);
  const tail = Buffer.from(source.subarray(mdat.at,mdat.end)); tail.writeUInt32BE(0);
  const moved = Buffer.concat([source.subarray(0,mdat.at),source.subarray(moov.at,moov.end),tail]); check(moved,'video/mp4');
});
test('MP4 fragmented timeline boxes are copied exactly and producer time is removed',() => {
  const tfhd = mp4Full(8,0,0x20000); tfhd.writeUInt32BE(1,4);
  const trun = mp4Full(12,0,1),traf = mp4Box('traf',Buffer.concat([mp4Box('tfhd',tfhd),mp4Box('tfdt',mp4Full(12,1)),mp4Box('trun',trun)]));
  const moof = mp4Box('moof',Buffer.concat([mp4Box('mfhd',mp4Full(8)),traf]));
  const source = syntheticMp4({ extra:[moof,mp4Box('prft',Buffer.from(VIDEO_PRIVATE_MARKER))] }),result = check(source,'video/mp4');
  const box = mp4Find(source,['moof']); assert.deepEqual(source.subarray(box.at,box.end),result.bytes.subarray(box.at,box.end));
});
test('WebM removes container descriptions dates identifiers and unused tags with nested CRC refresh',() => {
  for (const crc of [false,true]) check(syntheticWebm({ crc }),'video/webm');
});
test('WebM numeric colors stereo aspect audio and projection roll remain unchanged',() => {
  const source = syntheticWebm({ extraVideo:[ebmlUint(0x54b0,64),ebmlUint(0x54ba,48),ebmlUint(0x53b8,0),
    ebmlMaster(0x55b0,[ebmlUint(0x55b1,1),ebmlUint(0x55ba,1),ebmlMaster(0x55d0,[ebmlFloat(0x55d1,0.64),ebmlFloat(0x55da,0.05)])]),
    ebmlMaster(0x7670,[ebmlUint(0x7671,0),ebmlFloat(0x7673,0),ebmlFloat(0x7674,0),ebmlFloat(0x7675,90)])] });
  const result = check(source,'video/webm'); assert.ok(result.bytes.includes(ebmlFloat(0x7675,90))); assert.ok(result.bytes.includes(ebmlFloat(0x55d1,0.64)));
});
test('WebM unknown-size Segment and unknown-size Cluster stop at their correct boundary',() => {
  check(syntheticWebm({ unknownSegment:true }),'video/webm');
  check(syntheticWebm({ unknownSegment:true,unknownCluster:true,extraSegment:[ebmlMaster(0x1f43b675,[ebmlUint(0xe7,500),ebmlElement(0xa3,Buffer.from([0x81,1,0,0x80,4,5]))])] }),'video/webm');
});
test('WebM CRC corruption is rejected rather than recalculating a corrupted source',() => {
  const bytes = syntheticWebm(); bytes[bytes.length-1] ^= 1; invalid(() => prepareVideoDerivative(bytes,'video/webm'));
});
test('WebM unknown semantic elements encryption and chapters are unavailable',() => {
  for (const id of [0x1043a770,0x1b538667]) unavailable(() => prepareVideoDerivative(syntheticWebm({ extraSegment:[ebmlElement(id,Buffer.alloc(3))] }),'video/webm'));
  unavailable(() => prepareVideoDerivative(syntheticWebm({ extraVideo:[ebmlElement(0x47e1,Buffer.from([1]))] }),'video/webm'));
});
test('WebM codec mismatch invalid strings and nonfinite numeric display fields fail closed',() => {
  unavailable(() => prepareVideoDerivative(syntheticWebm({ codec:'V_PRIVATE' }),'video/webm'));
  invalid(() => prepareVideoDerivative(syntheticWebm({ extraVideo:[ebmlFloat(0x2383e3,NaN)] }),'video/webm'));
  invalid(() => prepareVideoDerivative(syntheticWebm({ extraVideo:[ebmlMaster(0x7670,[ebmlFloat(0x7675,181)])] }),'video/webm'));
});
test('WebM malformed lengths repeated singleton fields or unknown-size primitives are invalid',() => {
  invalid(() => prepareVideoDerivative(syntheticWebm({ extraInfo:[ebmlFloat(0x4489,10)] }),'video/webm'));
  const source = syntheticWebm({ crc:false }),marker = source.indexOf(Buffer.from([0x44,0x89,0x88])); source[marker+2] = 255;
  invalid(() => prepareVideoDerivative(source,'video/webm'));
  invalid(() => prepareVideoDerivative(syntheticWebm().subarray(0,-1),'video/webm'));
});
test('MP4 numeric color aspect and aperture survive while unsupported ICC and codec extension are deferred',() => {
  const path = ['moov','trak','mdia','minf','stbl','stsd'];
  const add = (extra) => replaceMp4Box(syntheticMp4(),path,(body) => Buffer.concat([body.subarray(0,8),mp4Box('avc1',Buffer.concat([body.subarray(16),extra]))]));
  const color = Buffer.from('6e636c7800010001000180','hex'),extra = Buffer.concat([mp4Box('colr',color),mp4Box('pasp',Buffer.from('0000000100000001','hex')),mp4Box('clap',Buffer.alloc(32))]);
  const result = check(add(extra),'video/mp4'); assert.ok(result.bytes.includes(color));
  unavailable(() => prepareVideoDerivative(add(mp4Box('colr',Buffer.from('profICC'))),'video/mp4'));
  unavailable(() => prepareVideoDerivative(add(mp4Box('sinf',Buffer.alloc(12))),'video/mp4'));
});
test('MP4 cannot carry conflicting sample-size or chunk-offset tables',() => {
  const path = ['moov','trak','mdia','minf','stbl'];
  invalid(() => prepareVideoDerivative(replaceMp4Box(syntheticMp4(),path,(body) => Buffer.concat([body,mp4Box('co64',mp4Full(8))])),'video/mp4'));
  const stz2 = mp4Full(12); stz2[7] = 8;
  invalid(() => prepareVideoDerivative(replaceMp4Box(syntheticMp4(),path,(body) => Buffer.concat([body,mp4Box('stz2',stz2)])),'video/mp4'));
});
test('MP4 counted tables unsupported header versions and private full-box flags are invalid',() => {
  for (const path of [['moov','mvhd'],['moov','trak','tkhd'],['moov','trak','mdia','mdhd']]) {
    invalid(() => prepareVideoDerivative(replaceMp4Box(syntheticMp4(),path,(body) => { body[0] = 2; return body; }),'video/mp4'));
  }
  const path = ['moov','trak','mdia','minf','stbl','stco'];
  invalid(() => prepareVideoDerivative(replaceMp4Box(syntheticMp4(),path,(body) => { body.writeUInt32BE(0xffffffff,4); return body; }),'video/mp4'));
  invalid(() => prepareVideoDerivative(replaceMp4Box(syntheticMp4(),path,(body) => { body[3] = 128; return body; }),'video/mp4'));
});
test('MP4 fragment index structures retain offsets and reject length or flag ambiguity',() => {
  const sidx = mp4Full(24),tfra = mp4Full(16),mfra = mp4Box('mfra',Buffer.concat([mp4Box('tfra',tfra),mp4Box('mfro',mp4Full(8))]));
  check(syntheticMp4({ extra:[mp4Box('sidx',sidx),mfra] }),'video/mp4');
  tfra.writeUInt32BE(0x100,8); invalid(() => prepareVideoDerivative(syntheticMp4({ extra:[mp4Box('mfra',mp4Box('tfra',tfra))] }),'video/mp4'));
});
test('WebM misplaced or repeated CRC never becomes a fabricated valid checksum',() => {
  invalid(() => prepareVideoDerivative(syntheticWebm({ crc:false,extraInfo:[ebmlElement(0xbf,Buffer.alloc(4))] }),'video/webm'));
  invalid(() => prepareVideoDerivative(syntheticWebm({ extraInfo:[ebmlElement(0xbf,Buffer.alloc(4))] }),'video/webm'));
});
test('WebM laced block bytes and block-group reference/discard timing are retained exactly',() => {
  const block = ebmlElement(0xa3,Buffer.from([0x81,1,0,0x82,1,2,11,12,13,14]));
  const group = ebmlMaster(0xa0,[ebmlElement(0xa1,Buffer.from([0x81,1,10,0,15,16])),ebmlUint(0x9b,500,2),ebmlElement(0xfb,Buffer.from([0xff])),ebmlUint(0x75a2,100,2)]);
  const source = syntheticWebm({ extraSegment:[ebmlMaster(0x1f43b675,[ebmlUint(0xe7,500,2),block,group],true)] }),result = check(source,'video/webm');
  assert.ok(result.bytes.includes(block)); assert.ok(result.bytes.includes(group)); assert.equal(result.containerMediaUnits,3);
});
test('WebM inconsistent codec type or malformed track-selection flags are rejected',() => {
  invalid(() => prepareVideoDerivative(syntheticWebm({ codec:'A_OPUS' }),'video/webm'));
  const source = syntheticWebm({ crc:false }),at = source.indexOf(Buffer.from([0x83,0x81,1])); source[at+2] = 2;
  invalid(() => prepareVideoDerivative(source,'video/webm'));
  invalid(() => prepareVideoDerivative(syntheticWebm({ extraTrack:[ebmlUint(0xb9,2)] }),'video/webm'));
  check(syntheticWebm({ extraTrack:[ebmlUint(0x55ee,0),ebmlUint(0x55ab,1),ebmlUint(0xaa,1)] }),'video/webm');
});
test('video 50MiB boundary is preserved with one separate candidate and no source mutation',() => {
  const source = syntheticMp4(),mdat = mp4Find(source,['mdat']),payloadSize = 50*1024*1024-(source.length-(mdat.end-mdat.at))-8;
  const large = Buffer.concat([source.subarray(0,mdat.at),mp4Box('mdat',Buffer.alloc(payloadSize)),source.subarray(mdat.end)]);
  const result = check(large,'video/mp4'); assert.equal(result.bytes.length,50*1024*1024);
});
