import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { prepareImageDerivative,IMAGE_METADATA_POLICY } from '../image-metadata.mjs';
import { PRIVATE_MARKER,pngChunk,pngChunks,syntheticPng,animatedPng,syntheticExif,jpegSegment,syntheticJpeg,
  riffChunk,riffChunks,riffFile,syntheticWebp,syntheticGif,addPrivateMetadata } from '../image-metadata-test-fixtures.mjs';
const invalid = (run) => assert.throws(run,{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
const unavailable = (run) => assert.throws(run,{ code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' });
const fixtures = [['image/png',syntheticPng],['image/jpeg',syntheticJpeg],['image/gif',syntheticGif],['image/webp',syntheticWebp]];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const insertPng = (chunk) => { const bytes = syntheticPng(); return Buffer.concat([bytes.subarray(0,33),chunk,bytes.subarray(33)]); };

test('strict bounded image-only input cannot select paths, execute tools or coerce MIME values',() => {
  for (const type of ['video/mp4','video/webm','image/svg+xml','constructor',null,{ toString:() => 'image/png' }]) invalid(() => prepareImageDerivative(syntheticPng(),type));
  for (const bytes of [null,'private bytes',new Uint8Array(syntheticPng()),Buffer.alloc(0),Buffer.alloc(10*1024*1024+1)]) invalid(() => prepareImageDerivative(bytes,'image/png'));
});
test('separate output bytes and manifests preserve original and make no scanner or acceptance claim',() => {
  for (const [type,make] of fixtures) {
    const bytes = make(),snapshot = Buffer.from(bytes),value = prepareImageDerivative(bytes,type);
    assert.deepEqual(bytes,snapshot); assert.deepEqual(value.bytes,bytes); assert.notEqual(value.bytes,bytes);
    assert.equal(value.policyVersion,IMAGE_METADATA_POLICY); assert.equal(value.mediaAcceptanceReady,false);
    assert.equal(value.iccProfilePolicy,null);
    assert.equal(Object.hasOwn(value,'verdict'),false); assert.equal(Object.hasOwn(value,'media'),false);
    assert.deepEqual(value.source,{ size:bytes.length,sha256:digest(bytes) }); assert.deepEqual(value.derivative,value.source);
    value.bytes.fill(0); assert.deepEqual(bytes,snapshot);
  }
});
test('PNG removes text compressed text GPS and private chunks without altering IDAT',() => {
  const original = addPrivateMetadata(syntheticPng(),'image/png',6),before = Buffer.from(original),value = prepareImageDerivative(original,'image/png');
  assert.equal(value.orientation,6); assert.equal(value.bytes.includes(Buffer.from(PRIVATE_MARKER)),false);
  const source = pngChunks(original),clean = pngChunks(value.bytes);
  assert.deepEqual(clean.filter((c) => c.kind === 'IDAT'),source.filter((c) => c.kind === 'IDAT'));
  assert.deepEqual(clean.map((c) => c.kind),['IHDR','eXIf','IDAT','IEND']);
  assert.equal(clean.find((c) => c.kind === 'eXIf').data.length,26); assert.deepEqual(original,before);
  assert.deepEqual(prepareImageDerivative(value.bytes,'image/png').bytes,value.bytes);
});
test('all eight TIFF directions in both byte orders survive canonical minimal EXIF',() => {
  for (const order of ['II','MM']) for (let orientation = 1; orientation <= 8; orientation++) {
    const exif = syntheticExif(orientation,order);
    for (const [type,make] of fixtures.filter(([type]) => type !== 'image/gif')) {
      let bytes = make();
      if (type === 'image/png') bytes = Buffer.concat([bytes.subarray(0,33),pngChunk('eXIf',exif),bytes.subarray(33)]);
      if (type === 'image/jpeg') bytes = Buffer.concat([bytes.subarray(0,2),jpegSegment(0xe1,Buffer.concat([Buffer.from('Exif\0\0'),exif])),bytes.subarray(2)]);
      if (type === 'image/webp') { const chunks = riffChunks(bytes); chunks[0].data = Buffer.from(chunks[0].data); chunks[0].data[0] |= 8; bytes = riffFile([...chunks.map((c) => riffChunk(c.kind,c.data)),riffChunk('EXIF',exif)]); }
      const value = prepareImageDerivative(bytes,type); assert.equal(value.orientation,orientation);
      assert.equal(value.bytes.includes(Buffer.from(PRIVATE_MARKER)),false); assert.deepEqual(prepareImageDerivative(value.bytes,type).bytes,value.bytes);
    }
  }
});
test('malformed EXIF duplicate or out-of-range orientation never silently rotates files',() => {
  const cases = [Buffer.alloc(14),syntheticExif(0),syntheticExif(9)];
  const pointer = syntheticExif(6); pointer.writeUInt32LE(0xffffffff,4); cases.push(pointer);
  const duplicate = syntheticExif(6); duplicate.writeUInt16LE(0x112,22); cases.push(duplicate);
  const wrongType = syntheticExif(6); wrongType.writeUInt16LE(2,12); cases.push(wrongType);
  for (const data of cases) invalid(() => prepareImageDerivative(insertPng(pngChunk('eXIf',data)),'image/png'));
});
test('PNG permits multiple text blocks but rejects unknown critical chunks and bad CRC',() => {
  const bytes = syntheticPng(),comment = pngChunk('tEXt',Buffer.from('Comment\0'+PRIVATE_MARKER));
  const source = Buffer.concat([bytes.subarray(0,33),comment,comment,pngChunk('prIv',Buffer.from(PRIVATE_MARKER)),bytes.subarray(33)]);
  assert.deepEqual(prepareImageDerivative(source,'image/png').bytes,bytes);
  invalid(() => prepareImageDerivative(insertPng(pngChunk('PRIV',Buffer.from(PRIVATE_MARKER))),'image/png'));
  const broken = Buffer.from(bytes); broken[34] ^= 1; invalid(() => prepareImageDerivative(broken,'image/png'));
});
test('PNG technical color alpha and pixel-density chunks are preserved with strict sizes',() => {
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45455); const density = Buffer.alloc(9); density.writeUInt32BE(3779,0); density.writeUInt32BE(3779,4); density[8] = 1;
  const chunks = [pngChunk('sRGB',Buffer.from([0])),pngChunk('gAMA',gamma),pngChunk('pHYs',density),pngChunk('tRNS',Buffer.alloc(6))];
  const png = syntheticPng(),bytes = Buffer.concat([png.subarray(0,33),...chunks,png.subarray(33)]);
  assert.deepEqual(prepareImageDerivative(bytes,'image/png').bytes,bytes);
  for (const chunk of [pngChunk('sRGB',Buffer.from([4])),pngChunk('sBIT',Buffer.from([8,8])),pngChunk('gAMA',Buffer.alloc(4)),pngChunk('tRNS',Buffer.alloc(5))])
    invalid(() => prepareImageDerivative(insertPng(chunk),'image/png'));
});
test('malformed ICC data is invalid rather than silently deleted',() => {
  invalid(() => prepareImageDerivative(insertPng(pngChunk('iCCP',Buffer.from(PRIVATE_MARKER))),'image/png'));
  const jpeg = syntheticJpeg(); invalid(() => prepareImageDerivative(Buffer.concat([jpeg.subarray(0,2),jpegSegment(0xe2,Buffer.from('ICC_PROFILE\0'+PRIVATE_MARKER)),jpeg.subarray(2)]),'image/jpeg'));
  invalid(() => prepareImageDerivative(riffFile([...riffChunks(syntheticWebp()).map((c) => riffChunk(c.kind,c.data)),riffChunk('ICCP',Buffer.from(PRIVATE_MARKER))]),'image/webp'));
});
test('APNG preserves frame payloads timing blend disposal and loop count with sequence validation',() => {
  const source = addPrivateMetadata(animatedPng(syntheticPng()),'image/png'),value = prepareImageDerivative(source,'image/png');
  assert.equal(value.containerFrames,2);
  const controls = (bytes) => pngChunks(bytes).filter((c) => ['IDAT','acTL','fcTL','fdAT'].includes(c.kind));
  assert.deepEqual(controls(value.bytes),controls(source));
  const chunks = pngChunks(source); chunks.find((c) => c.kind === 'fdAT').data = Buffer.from(chunks.find((c) => c.kind === 'fdAT').data);
  chunks.find((c) => c.kind === 'fdAT').data.writeUInt32BE(77); invalid(() => prepareImageDerivative(Buffer.concat([source.subarray(0,8),...chunks.map((c) => pngChunk(c.kind,c.data))]),'image/png'));
});
test('JPEG removes APP and COM between scans while preserving entropy and restart bytes',() => {
  const jpeg = syntheticJpeg(),secret = jpegSegment(0xfe,Buffer.from(PRIVATE_MARKER)),sos = jpegSegment(0xda,Buffer.from([1,1,0,0,63,0]));
  const source = Buffer.concat([jpeg.subarray(0,-2),secret,sos,Buffer.from([14,255,0,15]),Buffer.from([255,217])]);
  const value = prepareImageDerivative(source,'image/jpeg'); assert.equal(value.bytes.includes(Buffer.from(PRIVATE_MARKER)),false);
  assert.deepEqual(value.bytes,Buffer.concat([jpeg.subarray(0,-2),sos,Buffer.from([14,255,0,15,255,217])]));
  invalid(() => prepareImageDerivative(Buffer.concat([jpeg,Buffer.from(PRIVATE_MARKER)]),'image/jpeg'));
});
test('JFIF embedded thumbnail disappears but numeric density and Adobe color transform remain',() => {
  const jpeg = syntheticJpeg(),jfif = Buffer.alloc(17); jfif.write('JFIF\0'); jfif[5] = 1; jfif[6] = 2; jfif[7] = 1; jfif.writeUInt16BE(72,8); jfif.writeUInt16BE(72,10); jfif[12] = jfif[13] = 1; jfif.fill(200,14);
  const adobe = Buffer.alloc(12); adobe.write('Adobe'); adobe.writeUInt16BE(100,5); adobe[11] = 1;
  const source = Buffer.concat([jpeg.subarray(0,2),jpegSegment(0xe0,jfif),jpegSegment(0xee,adobe),jpeg.subarray(2)]);
  const clean = Buffer.from(jfif.subarray(0,14)); clean[12] = clean[13] = 0;
  assert.deepEqual(prepareImageDerivative(source,'image/jpeg').bytes,Buffer.concat([jpeg.subarray(0,2),jpegSegment(0xe0,clean),jpegSegment(0xee,adobe),jpeg.subarray(2)]));
  unavailable(() => prepareImageDerivative(Buffer.concat([jpeg.subarray(0,2),jpegSegment(0xee,Buffer.from(PRIVATE_MARKER)),jpeg.subarray(2)]),'image/jpeg'));
});
test('GIF removes comments and private application data but preserves loop and graphics controls',() => {
  const gif = syntheticGif(),loop = Buffer.concat([Buffer.from([33,255,11]),Buffer.from('NETSCAPE2.0'),Buffer.from([3,1,2,0,0])]),gce = Buffer.from([33,249,4,9,50,0,0,0]);
  const source = addPrivateMetadata(Buffer.concat([gif.subarray(0,19),loop,gce,gif.subarray(19)]),'image/gif');
  assert.deepEqual(prepareImageDerivative(source,'image/gif').bytes,Buffer.concat([gif.subarray(0,19),loop,gce,gif.subarray(19)]));
  const app = Buffer.concat([Buffer.from([33,255,11]),Buffer.from('PRIVATE0001'),Buffer.from([PRIVATE_MARKER.length]),Buffer.from(PRIVATE_MARKER),Buffer.from([0])]);
  assert.deepEqual(prepareImageDerivative(Buffer.concat([gif.subarray(0,-1),app,app,Buffer.from([59])]),'image/gif').bytes,gif);
});
test('GIF plain text is visible content and malformed loop controls are not sanitized by deletion',() => {
  const gif = syntheticGif(),text = Buffer.concat([Buffer.from([33,1,12]),Buffer.alloc(12),Buffer.from([1,65,0])]);
  unavailable(() => prepareImageDerivative(Buffer.concat([gif.subarray(0,-1),text,Buffer.from([59])]),'image/gif'));
  const loop = Buffer.concat([Buffer.from([33,255,11]),Buffer.from('NETSCAPE2.0'),Buffer.from([4,1,2,0,99,0])]);
  invalid(() => prepareImageDerivative(Buffer.concat([gif.subarray(0,-1),loop,Buffer.from([59])]),'image/gif'));
});
test('WebP keeps image payload but rebuilds RIFF length and EXIF XMP flags',() => {
  for (const orientation of [1,6]) {
    const source = addPrivateMetadata(syntheticWebp(),'image/webp',orientation),value = prepareImageDerivative(source,'image/webp'),chunks = riffChunks(value.bytes);
    assert.equal(value.bytes.readUInt32LE(4)+8,value.bytes.length); assert.equal(chunks[0].data[0]&12,orientation === 1 ? 0 : 8);
    assert.equal(chunks.some((c) => c.kind === 'XMP '),false); assert.equal(value.bytes.includes(Buffer.from(PRIVATE_MARKER)),false);
    assert.deepEqual(chunks.find((c) => c.kind === 'VP8L').data,riffChunks(source).find((c) => c.kind === 'VP8L').data);
  }
});
test('animated WebP keeps frame timings and bitstreams and removes nested private chunks',() => {
  const original = syntheticWebp(true),chunks = riffChunks(original),frame = chunks.find((c) => c.kind === 'ANMF');
  frame.data = Buffer.concat([frame.data,riffChunk('XMP ',Buffer.from(PRIVATE_MARKER))]);
  const source = riffFile(chunks.map((c) => riffChunk(c.kind,c.data))),value = prepareImageDerivative(source,'image/webp');
  assert.deepEqual(value.bytes,original); assert.equal(value.containerFrames,1);
  frame.data = Buffer.concat([frame.data,riffChunk('ICCP',Buffer.from(PRIVATE_MARKER))]);
  unavailable(() => prepareImageDerivative(riffFile(chunks.map((c) => riffChunk(c.kind,c.data))),'image/webp'));
});
test('WebP malformed padding bounds duplicate EXIF and missing extended header stay invalid',() => {
  const plain = syntheticWebp(),odd = riffChunk('priv',Buffer.from([1])); odd[odd.length-1] = 99;
  invalid(() => prepareImageDerivative(riffFile([...riffChunks(plain).map((c) => riffChunk(c.kind,c.data)),odd]),'image/webp'));
  const exif = riffChunk('EXIF',syntheticExif(6)); invalid(() => prepareImageDerivative(riffFile([...riffChunks(plain).map((c) => riffChunk(c.kind,c.data)),exif,exif]),'image/webp'));
  const broken = Buffer.from(plain); broken.writeUInt32LE(0xffffffff,16); invalid(() => prepareImageDerivative(broken,'image/webp'));
  invalid(() => prepareImageDerivative(riffFile([riffChunk('VP8L',riffChunks(plain)[1].data),exif]),'image/webp'));
});
test('JPEG EOF scan structure and segment-count budgets fail with fixed errors',() => {
  const jpeg = syntheticJpeg(); invalid(() => prepareImageDerivative(jpeg.subarray(0,-1),'image/jpeg'));
  invalid(() => prepareImageDerivative(Buffer.concat([jpeg.subarray(0,2),...Array.from({ length:20001 },() => jpegSegment(0xfe,Buffer.alloc(0))),jpeg.subarray(2)]),'image/jpeg'));
  const bad = Buffer.from(jpeg); bad.writeUInt16BE(0xffff,4); invalid(() => prepareImageDerivative(bad,'image/jpeg'));
});
