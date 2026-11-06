// Actual independent CMM and image decoding, SYNTHETIC TESTS ONLY.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { canonicalizeIccProfile } from './icc-profile.mjs';
import { prepareImageDerivative } from './image-metadata.mjs';
import { repackProfile,profileTags,attachIcc,extractIcc } from './icc-profile-test-fixtures.mjs';
import { PRIVATE_MARKER,addPrivateMetadata } from './image-metadata-test-fixtures.mjs';
async function color(args,input = Buffer.alloc(0),expectedFailure = false) {
  assert.ok(input.length <= 2*1024*1024+8);
  return new Promise((resolve,reject) => {
    const child = spawn('/opt/carebridge/color-test/icc-color-test',args,{ shell:false,
      env:{ PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC' },stdio:[input.length ? 'pipe' : 'ignore','pipe','pipe'] });
    let problem = false,size = 0; const chunks = [];
    const stop = () => { problem = true; child.kill('SIGKILL'); },timer = setTimeout(stop,30000);
    child.stdout.on('data',(bytes) => { size += bytes.length; if (size > 1024*1024) stop(); else if (!problem) chunks.push(bytes); });
    child.stderr.on('data',stop); child.once('error',stop);
    if (input.length) { child.stdin.on('error',stop); child.stdin.end(input); }
    child.once('close',(code,signal) => {
      clearTimeout(timer); const output = Buffer.concat(chunks);
      if (problem || code !== 0 || signal) {
        if (!expectedFailure) console.log(`IMAGE_NATIVE_COLOR_${args[0] === 'generate' ? 'GENERATOR' : 'COMPARATOR'}_FAILED`);
        if (!expectedFailure) for (const line of output.toString('ascii').split(/\r?\n/)) if (/^ICC_CMM_(OPEN_FAILED|TRANSFORM_FAILED|MISMATCH|ENGINE_ERROR)$/.test(line)) console.log(`IMAGE_NATIVE_${line}`);
        reject(new Error('ICC_NATIVE_COLOR_FAILED'));
      } else resolve(output);
    });
  });
}
async function compare(source,clean,expectedFailure = false) {
  const first = Buffer.alloc(4),second = Buffer.alloc(4); first.writeUInt32BE(source.length); second.writeUInt32BE(clean.length);
  assert.equal((await color(['compare'],Buffer.concat([first,source,second,clean]),expectedFailure)).toString('ascii'),'ICC_CMM_OK\n');
}
export async function runNativeIccCases({ scenario,fixtures,generate,decoder,file,pixelsAndTiming }) {
  const profiles = new Map();
  const cases = ['srgb','p3','gray-gamma','gray-table'].flatMap((kind) => [2,4].map((major) => ({ kind,major })));
  cases.push(...['rgb-param1','rgb-param2','rgb-param4'].map((kind) => ({ kind,major:4 })));
  for (const { kind,major } of cases) await scenario(`ICC actual CMM ${kind} v${major}`,async () => {
    const source = await color(['generate',kind,String(major)]),space = kind.startsWith('gray') ? 'GRAY' : 'RGB ';
    const original = repackProfile(source,profileTags(source),Buffer.from(PRIVATE_MARKER)),snapshot = Buffer.from(original),clean = canonicalizeIccProfile(original,space);
    assert.deepEqual(original,snapshot); assert.deepEqual(canonicalizeIccProfile(clean,space),clean);
    assert.equal(clean.includes(Buffer.from(PRIVATE_MARKER)),false); assert.equal(clean.includes(Buffer.from(PRIVATE_MARKER,'utf16le').swap16()),false);
    assert.deepEqual(profileTags(clean).find((tag) => tag.name === 'cprt').data,profileTags(source).find((tag) => tag.name === 'cprt').data);
    await compare(original,clean); profiles.set(`${kind}-${major}`,original);
  });
  async function image(fixture,index,profile) {
    const orientation = fixture.type === 'image/jpeg' ? 6 : 1;
    const source = attachIcc(addPrivateMetadata(fixture.bytes,fixture.type,orientation),fixture.type,profile),snapshot = Buffer.from(source),prepared = prepareImageDerivative(source,fixture.type);
    assert.deepEqual(source,snapshot); assert.equal(prepared.mediaAcceptanceReady,false); assert.deepEqual(prepareImageDerivative(prepared.bytes,fixture.type).bytes,prepared.bytes);
    assert.equal(prepared.orientation,orientation);
    assert.equal(extractIcc(prepared.bytes,fixture.type).includes(Buffer.from(PRIVATE_MARKER,'utf16le').swap16()),false);
    await compare(extractIcc(source,fixture.type),extractIcc(prepared.bytes,fixture.type));
    const before = await decoder.decode(file(source,fixture.type)),after = await decoder.decode(file(prepared.bytes,fixture.type));
    assert.deepEqual(before.media,after.media); assert.equal(before.decodedVideoFrames,fixture.frames); assert.equal(after.decodedVideoFrames,fixture.frames);
    assert.deepEqual(await pixelsAndTiming(source,fixture.type,`icc-${index}-source`),await pixelsAndTiming(prepared.bytes,fixture.type,`icc-${index}-clean`));
  }
  for (const [index,fixture] of fixtures.entries()) await scenario(`ICC embedded native pixels and timing ${fixture.name}`,() => image(fixture,index,profiles.get('srgb-4')));
  await scenario('ICC embedded grayscale PNG preserves decoded pixels and color',async () => {
    await generate('gray.png','image/png',['-f','lavfi','-i','color=c=gray:s=32x24:r=2:d=2','-frames:v','1','-threads','1','-c:v','png','-pix_fmt','gray','-f','image2','-update','1'],1);
    await image(fixtures.at(-1),'gray',profiles.get('gray-gamma-4'));
  });
  await scenario('ICC color comparator detects a changed rendering matrix',async () => {
    const source = profiles.get('p3-4'),clean = canonicalizeIccProfile(source,'RGB '),tags = profileTags(clean),matrix = tags.find((tag) => tag.name === 'rXYZ');
    matrix.data = Buffer.from(matrix.data); matrix.data.writeInt32BE(matrix.data.readInt32BE(8)+6554,8);
    await assert.rejects(() => compare(source,repackProfile(clean,tags),true),{ message:'ICC_NATIVE_COLOR_FAILED' });
  });
}
