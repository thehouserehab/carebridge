import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { canonicalizeIccProfile,ICC_PROFILE_LIMIT,ICC_PROFILE_POLICY } from '../icc-profile.mjs';
import { prepareImageDerivative } from '../image-metadata.mjs';
import { syntheticIcc,profileTags,repackProfile,iccNumeric,iccMluc,iccCurve,attachIcc,extractIcc } from '../icc-profile-test-fixtures.mjs';
import { syntheticPng,syntheticJpeg,syntheticGif,syntheticWebp,pngChunk,pngChunks,riffChunks,riffChunk,riffFile,jpegSegment,PRIVATE_MARKER } from '../image-metadata-test-fixtures.mjs';
const invalid = (run) => assert.throws(run,{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
const unavailable = (run) => assert.throws(run,{ code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' });
const canonical = (bytes,space = 'RGB ') => canonicalizeIccProfile(bytes,space);
const modified = (bytes,run) => { const value = Buffer.from(bytes); run(value); return value; };
const replace = (bytes,name,data) => repackProfile(bytes,profileTags(bytes).map((tag) => tag.name === name ? { name,data } : tag));
const extra = (bytes,name,data) => repackProfile(bytes,[...profileTags(bytes),{ name,data }]);

test('ICC input and declared lengths are strict bounded Buffer contracts',() => {
  for (const bytes of [null,'profile',new Uint8Array(syntheticIcc()),Buffer.alloc(131),Buffer.alloc(ICC_PROFILE_LIMIT+1)]) invalid(() => canonical(bytes));
  for (const space of [undefined,'rgb','CMYK',{},'__proto__']) invalid(() => canonicalizeIccProfile(syntheticIcc(),space));
  for (const run of [(b) => b.writeUInt32BE(b.length-1),(b) => b.write('nope',36),(b) => b[100] = 1]) invalid(() => canonical(modified(syntheticIcc(),run)));
});
test('RGB and grayscale v2 v4 preserve numeric tags legal notices and profile date without mutating originals',() => {
  for (const major of [2,4]) for (const space of ['RGB ','GRAY']) {
    const source = syntheticIcc({ major,space }),snapshot = Buffer.from(source),result = canonical(source,space),tags = profileTags(result);
    assert.deepEqual(source,snapshot); assert.notEqual(source,result); assert.deepEqual(result.subarray(24,36),source.subarray(24,36));
    assert.equal(tags.some((tag) => tag.name === 'dmnd'),false); assert.equal(result.includes(Buffer.from(PRIVATE_MARKER)),false);
    assert.equal(result.includes(Buffer.from(PRIVATE_MARKER,'utf16le').swap16()),false);
    for (const before of profileTags(source).filter((tag) => !['desc','dmnd'].includes(tag.name))) assert.deepEqual(tags.find((tag) => tag.name === before.name).data,before.data);
    assert.equal(result.subarray(48,56).every((n) => n === 0),true); assert.equal(result.subarray(80,84).every((n) => n === 0),true);
    assert.deepEqual(canonical(result,space),result); result.fill(0); assert.deepEqual(source,snapshot);
  }
});
test('canonical tables remove unreferenced gaps deduplicate equal curves and normalize source tag order',() => {
  const source = syntheticIcc(),expected = canonical(source),tags = profileTags(expected),curves = tags.filter((tag) => tag.name.endsWith('TRC'));
  assert.equal(new Set(curves.map((tag) => tag.offset)).size,1);
  assert.deepEqual(canonical(repackProfile(source,profileTags(source).reverse(),Buffer.from(PRIVATE_MARKER))),expected);
  const unique = [...new Map(tags.map((tag) => [tag.offset,tag])).values()].sort((a,b) => a.offset-b.offset);
  let end = 132+tags.length*12; for (const tag of unique) { assert.equal(tag.offset,end); end += Math.ceil(tag.size/4)*4; } assert.equal(end,expected.length);
});
test('duplicate tags table offsets partial overlaps and incompatible shared ranges stay invalid',() => {
  const source = syntheticIcc();
  for (const run of [(b) => b.writeUInt32BE(257,128),(b) => b.write('desc',144),(b) => b.writeUInt32BE(128,136),
    (b) => b.writeUInt32BE(b.readUInt32BE(136)+1,136),(b) => b.writeUInt32BE(0xffffffff,140),
    (b) => b.writeUInt32BE(b.readUInt32BE(136)+4,148)]) invalid(() => canonical(modified(source,run)));
  const value = canonical(source),tags = profileTags(value); invalid(() => canonical(modified(value,(b) => b.writeUInt32BE(tags.find((t) => t.name === 'rTRC').size-1,132+tags.findIndex((t) => t.name === 'gTRC')*12+8))));
});
test('unknown and overriding LUT HDR private tags are not silently deleted',() => {
  for (const name of ['A2B0','B2A0','D2B0','cicp','meta','priv','targ']) unavailable(() => canonical(extra(syntheticIcc(),name,iccNumeric('sf32',[1]))));
  for (const run of [(b) => b[8] = 5,(b) => b[9] = 0x50,(b) => b.write('prtr',12),(b) => b.write('CMYK',16),(b) => b.write('Lab ',20)]) unavailable(() => canonical(modified(syntheticIcc(),run)));
  invalid(() => canonical(syntheticIcc({ space:'GRAY' })));
});
test('required color tags and color channel correspondence cannot be omitted',() => {
  const source = syntheticIcc(); for (const name of ['desc','cprt','wtpt','rTRC','bXYZ']) invalid(() => canonical(repackProfile(source,profileTags(source).filter((tag) => tag.name !== name))));
  invalid(() => canonical(extra(source,'kTRC',iccCurve())));
  invalid(() => canonical(extra(syntheticIcc({ space:'GRAY' }),'rTRC',iccCurve()),'GRAY'));
});
test('numeric color tags are retained exactly and hidden nonzero suffixes or reserved bytes are invalid',() => {
  const source = syntheticIcc(),matrix = iccNumeric('sf32',[1,0,0,0,1,0,0,0,1]);
  const result = canonical(extra(source,'chad',matrix)); assert.deepEqual(profileTags(result).find((t) => t.name === 'chad').data,matrix);
  for (const data of [Buffer.concat([matrix,Buffer.from(PRIVATE_MARKER)]),modified(matrix,(b) => b[4] = 1),matrix.subarray(0,-1)]) invalid(() => canonical(extra(source,'chad',data)));
  unavailable(() => canonical(replace(source,'wtpt',iccNumeric('sf32',[1,1,1]))));
});
test('parametric curve functions zero through four retain every color parameter',() => {
  const source = syntheticIcc();
  for (const [kind,count] of [1,3,4,5,7].entries()) {
    const curve = Buffer.alloc(12+count*4); curve.write('para'); curve.writeUInt16BE(kind,8); curve.writeInt32BE(144179,12); if (kind) curve.writeInt32BE(65536,16);
    const result = canonical(replace(source,'rTRC',curve)); assert.deepEqual(profileTags(result).find((tag) => tag.name === 'rTRC').data,curve);
    if (kind) unavailable(() => canonical(replace(source,'rTRC',modified(curve,(b) => b.writeInt32BE(0,16)))));
    invalid(() => canonical(replace(source,'rTRC',modified(curve,(b) => b[10] = 1))));
  }
  unavailable(() => canonical(replace(syntheticIcc({ major:2 }),'rTRC',iccNumeric('para',[1,1]))));
});
test('curve tables include identity and gamma while malformed unbounded or nonmonotonic curves are refused',() => {
  for (const count of [0,1,17,65536]) assert.ok(canonical(replace(syntheticIcc(),'rTRC',iccCurve(count))).length <= ICC_PROFILE_LIMIT);
  const curve = iccCurve(17); unavailable(() => canonical(replace(syntheticIcc(),'rTRC',modified(curve,(b) => b.writeUInt16BE(0,20)))));
  invalid(() => canonical(replace(syntheticIcc(),'rTRC',modified(iccCurve(1),(b) => b.writeUInt16BE(0,12)))));
  unavailable(() => canonical(replace(syntheticIcc(),'rTRC',modified(curve,(b) => b.writeUInt32BE(65537,8)))));
});
test('parametric curves with undefined power domains nonfinite results or backwards branch jumps are unavailable',() => {
  const curve = (kind,values) => { const bytes = Buffer.alloc(12+values.length*4); bytes.write('para'); bytes.writeUInt16BE(kind,8); values.forEach((n,index) => bytes.writeInt32BE(Math.round(n*65536),12+index*4)); return bytes; };
  for (const data of [curve(3,[2.2,1,-0.5,1,0.25]),curve(3,[2.2,1,0,-1,0.25]),curve(3,[2.2,1,0,1,2]),
    curve(4,[2.2,1,0,1,0.25,-1,0]),curve(1,[32767,2,0]),curve(2,[2.2,1,0,-1])]) unavailable(() => canonical(replace(syntheticIcc(),'rTRC',data)));
  const valid = curve(1,[2.2,1,-0.5]); assert.deepEqual(profileTags(canonical(replace(syntheticIcc(),'rTRC',valid))).find((tag) => tag.name === 'rTRC').data,valid);
});
test('copyright multilingual legal text survives while its gaps are rebuilt and invalid UTF16 is rejected',() => {
  const source = syntheticIcc(),notice = iccMluc('Copyright Synthetic test owner');
  const result = canonical(replace(source,'cprt',notice)); assert.deepEqual(profileTags(result).find((t) => t.name === 'cprt').data,notice);
  invalid(() => canonical(replace(source,'cprt',modified(notice,(b) => b.writeUInt32BE(0,24)))));
  invalid(() => canonical(replace(source,'cprt',modified(notice,(b) => b.writeUInt16BE(0xd800,b.length-2)))));
  const gap = Buffer.alloc(notice.length+4); notice.subarray(0,28).copy(gap); gap.writeUInt32BE(32,24); Buffer.from('JUNK').copy(gap,28); notice.subarray(28).copy(gap,32);
  assert.deepEqual(profileTags(canonical(replace(source,'cprt',gap))).find((t) => t.name === 'cprt').data,notice);
  const english = notice.subarray(28),korean = Buffer.from('합성 프로필 고지 🧪','utf16le').swap16(),multilingual = Buffer.alloc(40+english.length+korean.length);
  notice.subarray(0,28).copy(multilingual); multilingual.writeUInt32BE(2,8); multilingual.writeUInt32BE(40,24); multilingual.write('koKR',28);
  multilingual.writeUInt32BE(korean.length,32); multilingual.writeUInt32BE(40+english.length,36); english.copy(multilingual,40); korean.copy(multilingual,40+english.length);
  assert.deepEqual(profileTags(canonical(replace(source,'cprt',multilingual))).find((t) => t.name === 'cprt').data,multilingual);
  invalid(() => canonical(replace(source,'cprt',modified(multilingual,(b) => b.write('enUS',28)))));
});
test('v2 copyright ASCII and metadata descriptions are validated rather than claimed as sanitized legal text',() => {
  const source = syntheticIcc({ major:2 }),tag = profileTags(source).find((t) => t.name === 'cprt');
  for (const data of [tag.data.subarray(0,-1),modified(tag.data,(b) => b[9] = 0),modified(tag.data,(b) => b[8] = 255)]) invalid(() => canonical(replace(source,'cprt',data)));
  invalid(() => canonical(replace(source,'desc',modified(profileTags(source)[0].data,(b) => b.writeUInt32BE(0xffffffff,8)))));
});
test('profile flags attributes intent and valid D50 header are preserved without accepting unknown vendor semantics',() => {
  const source = syntheticIcc();
  for (const run of [(b) => b.writeUInt32BE(4,44),(b) => b.writeBigUInt64BE(16n,56)]) unavailable(() => canonical(modified(source,run)));
  for (const run of [(b) => b.writeUInt32BE(4,64),(b) => b.writeUInt16BE(13,26),(b) => b.writeUInt16BE(32,28),(b) => b.writeInt32BE(0,68),(b) => b[10] = 1]) invalid(() => canonical(modified(source,run)));
  const changed = modified(source,(b) => { b.writeBigUInt64BE(15n,56); b.writeUInt32BE(3,64); });
  assert.deepEqual(canonical(changed).subarray(44,48),changed.subarray(44,48)); assert.deepEqual(canonical(changed).subarray(56,80),changed.subarray(56,80));
});
test('v4 profile ID masks flags intent and ID only and v2 reserved ID stays zero',() => {
  const source = modified(syntheticIcc(),(b) => b.writeBigUInt64BE(15n,56)),result = canonical(source),checked = Buffer.from(result);
  checked.fill(0,44,48); checked.fill(0,64,68); checked.fill(0,84,100);
  assert.deepEqual(result.subarray(84,100),createHash('md5').update(checked).digest());
  assert.deepEqual(canonical(modified(source,(b) => { b.writeUInt32BE(1,44); b.writeUInt32BE(2,64); })).subarray(84,100),result.subarray(84,100));
  assert.equal(canonical(syntheticIcc({ major:2 })).subarray(84,128).every((n) => n === 0),true);
});
test('PNG GIF and WebP embed canonical RGB profiles and preserve image bitstreams',() => {
  for (const [type,make] of [['image/png',syntheticPng],['image/gif',syntheticGif],['image/webp',syntheticWebp]]) {
    const profile = syntheticIcc(),source = attachIcc(make(),type,profile),snapshot = Buffer.from(source),value = prepareImageDerivative(source,type);
    assert.deepEqual(extractIcc(value.bytes,type),canonical(profile)); assert.deepEqual(source,snapshot); assert.equal(value.mediaAcceptanceReady,false);
    assert.equal(value.iccProfilePolicy,ICC_PROFILE_POLICY);
    assert.deepEqual(prepareImageDerivative(value.bytes,type).bytes,value.bytes);
    if (type === 'image/png') assert.deepEqual(pngChunks(value.bytes).filter((c) => c.kind === 'IDAT'),pngChunks(source).filter((c) => c.kind === 'IDAT'));
    if (type === 'image/webp') assert.deepEqual(riffChunks(value.bytes).find((c) => c.kind === 'VP8L'),riffChunks(source).find((c) => c.kind === 'VP8L'));
  }
});
test('JPEG ICC multipart sequence is complete bounded reorderable and never ambiguous',() => {
  const jpeg = syntheticJpeg(),profile = syntheticIcc({ space:'GRAY',samples:65536 }),source = attachIcc(jpeg,'image/jpeg',profile),value = prepareImageDerivative(source,'image/jpeg');
  assert.deepEqual(extractIcc(value.bytes,'image/jpeg'),canonical(profile,'GRAY'));
  const first = source.readUInt16BE(4)+4,second = first+source.readUInt16BE(first+2)+2,last = second+source.readUInt16BE(second+2)+2;
  assert.deepEqual(prepareImageDerivative(Buffer.concat([source.subarray(0,2),source.subarray(second,last),source.subarray(2,first),source.subarray(first,second),source.subarray(last)]),'image/jpeg').bytes,value.bytes);
  for (const run of [(b) => b[18] = 0,(b) => b[19] = 0,(b) => b[first+16] = 1,(b) => b[first+17] = 9]) invalid(() => prepareImageDerivative(modified(source,run),'image/jpeg'));
  invalid(() => prepareImageDerivative(Buffer.concat([source.subarray(0,second),source.subarray(last)]),'image/jpeg'));
  invalid(() => prepareImageDerivative(attachIcc(jpeg,'image/jpeg',syntheticIcc()),'image/jpeg'));
  const late = jpegSegment(0xe2,Buffer.concat([Buffer.from('ICC_PROFILE\0'),Buffer.from([1,1]),syntheticIcc({ space:'GRAY' })]));
  invalid(() => prepareImageDerivative(Buffer.concat([jpeg.subarray(0,-2),late,jpeg.subarray(-2)]),'image/jpeg'));
});
test('PNG profile inflate is bounded and rejects corruption trailers bad names and extra streams',() => {
  const source = syntheticPng(),profile = syntheticIcc(),compressed = deflateSync(profile),chunk = (data) => Buffer.concat([source.subarray(0,33),pngChunk('iCCP',data),source.subarray(33)]);
  for (const data of [Buffer.from('missing separator'),Buffer.concat([Buffer.from('bad\0\x01'),compressed]),Buffer.concat([Buffer.from(' bad\0\0'),compressed]),
    Buffer.concat([Buffer.from('bad  name\0\0'),compressed]),Buffer.concat([Buffer.from('x\0\0'),compressed,Buffer.from('JUNK')]),
    Buffer.concat([Buffer.from('x\0\0'),compressed,compressed]),Buffer.concat([Buffer.from('x\0\0'),deflateSync(Buffer.alloc(ICC_PROFILE_LIMIT+1))])]) invalid(() => prepareImageDerivative(chunk(data),'image/png'));
  invalid(() => prepareImageDerivative(chunk(Buffer.concat([Buffer.from('x\0\0'),compressed.subarray(0,-1)])),'image/png'));
});
test('PNG profile channel correspondence ordering duplicate and conflicting color indications are explicit',() => {
  const source = attachIcc(syntheticPng(),'image/png',syntheticIcc()),chunks = pngChunks(source),repack = (list) => Buffer.concat([source.subarray(0,8),...list.map((c) => pngChunk(c.kind,c.data))]);
  invalid(() => prepareImageDerivative(attachIcc(syntheticPng(),'image/png',syntheticIcc({ space:'GRAY' })),'image/png'));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[2],chunks[1],chunks[3]]),'image/png'));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[1],chunks[1],...chunks.slice(2)]),'image/png'));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[1],{ kind:'sRGB',data:Buffer.from([0]) },...chunks.slice(2)]),'image/png'));
  unavailable(() => prepareImageDerivative(repack([chunks[0],chunks[1],{ kind:'cICP',data:Buffer.from([1,13,0,1]) },...chunks.slice(2)]),'image/png'));
});
test('WebP ICC flag payload ordering duplicates and color space must agree',() => {
  const source = attachIcc(syntheticWebp(),'image/webp',syntheticIcc()),chunks = riffChunks(source),repack = (list) => riffFile(list.map((c) => riffChunk(c.kind,c.data)));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[2]]),'image/webp'));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[2],chunks[1]]),'image/webp'));
  invalid(() => prepareImageDerivative(repack([chunks[0],chunks[1],chunks[1],chunks[2]]),'image/webp'));
  invalid(() => prepareImageDerivative(repack([{ ...chunks[0],data:modified(chunks[0].data,(b) => b[0] &= ~0x20) },...chunks.slice(1)]),'image/webp'));
  invalid(() => prepareImageDerivative(attachIcc(syntheticWebp(),'image/webp',syntheticIcc({ space:'GRAY' })),'image/webp'));
});
test('GIF ICC application blocks stay bounded unique and RGB without accepting an empty profile',() => {
  const gif = syntheticGif(),source = attachIcc(gif,'image/gif',syntheticIcc());
  invalid(() => prepareImageDerivative(attachIcc(source,'image/gif',syntheticIcc()),'image/gif'));
  invalid(() => prepareImageDerivative(attachIcc(gif,'image/gif',syntheticIcc({ space:'GRAY' })),'image/gif'));
  invalid(() => prepareImageDerivative(attachIcc(gif,'image/gif',Buffer.alloc(0)),'image/gif'));
});
