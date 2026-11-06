import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync,inflateSync } from 'node:zlib';
import { validateMediaContainer } from '../media-container-validation.mjs';
import { prepareImageDerivative } from '../image-metadata.mjs';
import { RepositoryError } from '../errors.mjs';
import { pngChunk,pngChunks,rasterPng,animatedPng } from '../image-metadata-test-fixtures.mjs';
const validate = (bytes) => validateMediaContainer(bytes,'image/png');
const invalid = (run) => assert.throws(run,{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
const repack = (source,chunks) => Buffer.concat([source.subarray(0,8),...chunks.map(({ kind,data }) => pngChunk(kind,data))]);
const change = (source,kind,edit) => repack(source,pngChunks(source).map((c) => c.kind === kind ? { ...c,data:edit(Buffer.from(c.data)) } : c));
test('all standard PNG color depth pairs and five filters retain original bytes',() => {
  for (const [color,depths] of [[0,[1,2,4,8,16]],[2,[8,16]],[3,[1,2,4,8]],[4,[8,16]],[6,[8,16]]]) {
    for (const depth of depths) for (const filter of [0,1,2,3,4]) {
      const bytes = rasterPng({ color,depth,filter }),before = Buffer.from(bytes);
      assert.equal(validate(bytes),1); assert.deepEqual(bytes,before); assert.deepEqual(prepareImageDerivative(bytes,'image/png').bytes,bytes);
    }
  }
});
test('Adam7 pass lengths include packed rows and skip empty passes for small dimensions',() => {
  for (const [width,height] of [[1,1],[1,9],[9,1],[2,3],[3,2],[7,7],[8,8],[9,9]]) {
    for (const [color,depth] of [[0,1],[0,16],[3,2],[2,8],[4,16],[6,16]]) for (const filter of [0,4])
      assert.equal(validate(rasterPng({ width,height,color,depth,filter,interlace:1 })),1);
  }
});
test('illegal first last and every Adam7 filter are rejected despite valid CRC and zlib',() => {
  for (const interlace of [0,1]) for (const filter of [5,99,255]) invalid(() => validate(rasterPng({ interlace,filter })));
  const bytes = rasterPng();
  invalid(() => validate(change(bytes,'IDAT',(data) => { const rows = inflateSync(data); rows[8*28] = 99; return deflateSync(rows); })));
  invalid(() => prepareImageDerivative(rasterPng({ filter:99 }),'image/png'));
});
test('too short or extra decompressed rows and compressed expansion are never partial success',() => {
  for (const rowsChange of [(rows) => rows.subarray(0,-1),(rows) => Buffer.concat([rows,Buffer.from([0])]),() => Buffer.alloc(1024*1024)])
    invalid(() => validate(rasterPng({ rowsChange })));
});
test('zlib checksum EOF exact consumed bytes and no second stream are required',() => {
  const bytes = rasterPng();
  for (const edit of [(data) => data.subarray(0,-1),(data) => { data[data.length-1] ^= 1; return data; },
    (data) => Buffer.concat([data,Buffer.from([0])]),(data) => Buffer.concat([data,deflateSync(Buffer.from('SYNTHETIC_UNUSED_PAYLOAD'))])])
    invalid(() => validate(change(bytes,'IDAT',edit)));
});
test('IDAT boundaries can split every byte including zlib checksum and have empty chunks',() => {
  const bytes = rasterPng(),chunks = pngChunks(bytes),compressed = chunks.find((c) => c.kind === 'IDAT').data;
  assert.equal(validate(repack(bytes,chunks.flatMap((c) => c.kind !== 'IDAT' ? [c] : [
    { kind:'IDAT',data:Buffer.alloc(0) },...Array.from(compressed,(byte) => ({ kind:'IDAT',data:Buffer.from([byte]) })),{ kind:'IDAT',data:Buffer.alloc(0) },
  ]))),1);
});
test('IDAT resumed after ancillary data is not one legal consecutive stream',() => {
  const bytes = rasterPng(),chunks = pngChunks(bytes);
  invalid(() => validate(repack(bytes,chunks.flatMap((c) => c.kind !== 'IDAT' ? [c] : [
    { kind:'IDAT',data:c.data.subarray(0,2) },{ kind:'tEXt',data:Buffer.from('Comment\0SYNTHETIC') },{ kind:'IDAT',data:c.data.subarray(2) },
  ]))));
});
test('unsupported header combinations compression filter method and interlace stay invalid',() => {
  const bytes = rasterPng();
  for (const [at,value] of [[8,1],[8,7],[9,1],[9,5],[10,1],[11,1],[12,2]])
    invalid(() => validate(change(bytes,'IHDR',(data) => { data[at] = value; return data; })));
});
test('indexed palette is mandatory bounded unique and must precede data while grayscale forbids it',() => {
  const indexed = rasterPng({ color:3,depth:1 }),chunks = pngChunks(indexed);
  invalid(() => validate(repack(indexed,chunks.filter((c) => c.kind !== 'PLTE'))));
  invalid(() => validate(change(indexed,'PLTE',() => Buffer.alloc(9))));
  invalid(() => validate(repack(indexed,chunks.flatMap((c) => c.kind === 'PLTE' ? [c,c] : [c]))));
  invalid(() => validate(repack(indexed,[chunks[0],chunks[2],chunks[1],chunks[3]])));
  const gray = rasterPng({ color:0 }); invalid(() => validate(repack(gray,[pngChunks(gray)[0],chunks[1],...pngChunks(gray).slice(1)])));
});
test('per-raster allocation budget is checked before inflating an attacker-declared canvas',() => {
  const bytes = rasterPng({ color:6,depth:16 });
  invalid(() => validate(change(bytes,'IHDR',(data) => { data.writeUInt32BE(8192); data.writeUInt32BE(4882,4); return data; })));
});
test('APNG validates later frame scanlines too and retains complete valid compressed data',() => {
  for (const interlace of [0,1]) {
    const bytes = animatedPng(rasterPng({ interlace })); assert.equal(validate(bytes),2);
    assert.deepEqual(prepareImageDerivative(bytes,'image/png').bytes,bytes);
    invalid(() => validate(change(bytes,'fdAT',(data) => { const rows = inflateSync(data.subarray(4)); rows[0] = 99; return Buffer.concat([data.subarray(0,4),deflateSync(rows)]); })));
    invalid(() => validate(change(bytes,'fdAT',(data) => data.subarray(0,-1))));
  }
});
test('APNG frame sequence bounds first canvas and data presence cannot be skipped',() => {
  const bytes = animatedPng(rasterPng());
  invalid(() => validate(change(bytes,'fdAT',(data) => { data.writeUInt32BE(77); return data; })));
  for (const edit of [(data) => { data.writeUInt32BE(8,4); return data; },(data) => { data.writeUInt32BE(1,12); return data; },
    (data) => { data[24] = 3; return data; },(data) => { data[25] = 2; return data; }]) invalid(() => validate(change(bytes,'fcTL',edit)));
  invalid(() => validate(repack(bytes,pngChunks(bytes).filter((c) => c.kind !== 'fdAT'))));
});
test('later APNG frame may have a smaller bounded canvas and arbitrary fdAT split points',() => {
  const bytes = animatedPng(rasterPng()),smaller = pngChunks(rasterPng({ width:2,height:3 })).find((c) => c.kind === 'IDAT').data;
  let frame = 0;
  const chunks = pngChunks(bytes).flatMap((c) => {
    if (c.kind === 'fcTL' && ++frame === 2) { const data = Buffer.from(c.data); data.writeUInt32BE(2,4); data.writeUInt32BE(3,8); data.writeUInt32BE(2,12); return [{ ...c,data }]; }
    if (c.kind === 'fdAT') return [smaller.subarray(0,3),smaller.subarray(3)].map((part,index) => {
      const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2+index); return { kind:'fdAT',data:Buffer.concat([sequence,part]) };
    }); return [c];
  });
  assert.equal(validate(repack(bytes,chunks)),2);
});
test('unknown critical or reserved-bit chunks do not become successful decoded raster evidence',() => {
  const bytes = rasterPng();
  for (const kind of ['PRIV','priv']) invalid(() => validate(repack(bytes,[pngChunks(bytes)[0],{ kind,data:Buffer.alloc(0) },...pngChunks(bytes).slice(1)])));
});
test('trusted work budget checks every raster and preserves cancellation rather than relabeling invalid media',() => {
  const bytes = animatedPng(rasterPng()),before = Buffer.from(bytes); let calls = 0;
  assert.equal(validateMediaContainer(bytes,'image/png',{ checkpoint() { calls++; } }),2); assert.ok(calls > 8); assert.deepEqual(bytes,before);
  for (const stopAt of [1,6,calls]) {
    let at = 0; assert.throws(() => validateMediaContainer(bytes,'image/png',{ checkpoint() {
      if (++at === stopAt) throw new RepositoryError('SCAN_UNAVAILABLE');
    } }),{ code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' }); assert.deepEqual(bytes,before);
  }
  invalid(() => validateMediaContainer(bytes,'image/png',{ checkpoint:true }));
});
