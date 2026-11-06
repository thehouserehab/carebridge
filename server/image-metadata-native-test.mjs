// Synthetic fixtures only, in the separately verified offline TEST image.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,readdir,unlink,rmdir,lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { LinuxMediaDecoder } from './media-decoder.mjs';
import { prepareImageDerivative } from './image-metadata.mjs';
import { PRIVATE_MARKER,pngChunks,pngChunk,animatedPng,addPrivateMetadata } from './image-metadata-test-fixtures.mjs';
import { runNativeIccCases } from './icc-profile-native-test.mjs';
const root = '/opt/carebridge/ffmpeg/bin/',sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decoder = new LinuxMediaDecoder({ approvedBinarySha256:'12b72afac0becf6cc5a2d71faf55b83f275f5e8c81083f8ab73df99ce830f681' });
let directory,passed = 0,failed = false; const fixtures = [];
async function command(binary,args) {
  return new Promise((resolve,reject) => {
    const child = spawn(root+binary,args,{ shell:false,env:{ PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC' },stdio:['ignore','pipe','pipe'] });
    let failed = false,size = 0; const chunks = [];
    const stop = () => { failed = true; child.kill('SIGKILL'); },timer = setTimeout(stop,30000);
    child.stdout.on('data',(bytes) => { size += bytes.length; if (size > 65536) stop(); else if (!failed) chunks.push(bytes); });
    child.stderr.on('data',stop); child.once('error',stop);
    child.once('close',(code,signal) => { clearTimeout(timer); if (failed || code !== 0 || signal) reject(new Error('IMAGE_NATIVE_COMMAND_FAILED')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
async function generate(name,type,args,frames) {
  const path = `${directory}/${name}`;
  await command('ffmpeg',['-hide_banner','-v','error','-nostdin',...args,path]);
  fixtures.push({ name,type,frames,bytes:await readFile(path) });
}
const file = (bytes,type) => ({ stream:Readable.from([bytes],{ objectMode:false }),type,size:bytes.length,sha256:sha(bytes) });
async function pixelsAndTiming(bytes,type,prefix) {
  const path = `${directory}/${prefix}.bin`; await writeFile(path,bytes,{ flag:'wx',mode:0o600 });
  const common = ['-hide_banner','-v','error','-protocol_whitelist','file'];
  const loop = type === 'image/gif' ? ['-ignore_loop','1'] : [];
  // Auto-rotation filters are absent from the reviewed test build. Compare
  // coded full-frame RGBA pixels; orientation is separately preserved by the
  // EXIF contract. This is not a browser/color-managed rendering proof.
  await command('ffmpeg',[...common,'-nostdin','-noautorotate',...loop,'-i',path,'-map','0:v:0','-map_metadata','-1','-an',
    '-pix_fmt','rgba','-c:v','png','-threads','1','-fps_mode','passthrough','-f','image2',`${directory}/${prefix}-frame-%06d.png`]);
  const names = (await readdir(directory)).filter((name) => name.startsWith(prefix+'-frame-') && /-frame-\d{6}\.png$/.test(name)).sort();
  const pixels = [];
  for (const name of names) {
    const chunks = pngChunks(await readFile(`${directory}/${name}`));
    // Hash just the lossless image encoding and dimensions, never copied tags.
    pixels.push(sha(Buffer.concat(chunks.filter((c) => ['IHDR','IDAT'].includes(c.kind)).map((c) => c.data))));
  }
  const measured = JSON.parse(await command('ffprobe',[...common,...loop,'-show_frames','-show_entries',
    'frame=width,height,best_effort_timestamp_time,duration_time:frame_tags=:frame_side_data=','-of','json','-i',path]));
  assert.ok(pixels.length > 0); assert.equal(measured.frames.length,pixels.length);
  // ffprobe can include an empty side_data_list even when side-data fields
  // are excluded. Metadata is intentionally different; compare only actual
  // measured dimensions/timestamps/durations, not that metadata envelope.
  return { pixels,timing:measured.frames.map(({ width,height,best_effort_timestamp_time,duration_time }) =>
    ({ width,height,best_effort_timestamp_time,duration_time })) };
}
async function compare(fixture,orientation = 1,prefix) {
  const original = addPrivateMetadata(fixture.bytes,fixture.type,orientation),snapshot = Buffer.from(original),prepared = prepareImageDerivative(original,fixture.type);
  assert.deepEqual(original,snapshot); assert.equal(prepared.bytes.includes(Buffer.from(PRIVATE_MARKER)),false);
  assert.equal(prepared.orientation,orientation); assert.equal(prepared.mediaAcceptanceReady,false);
  assert.deepEqual(prepareImageDerivative(prepared.bytes,fixture.type).bytes,prepared.bytes);
  const before = await decoder.decode(file(original,fixture.type)),after = await decoder.decode(file(prepared.bytes,fixture.type));
  assert.deepEqual(before.media,after.media); assert.equal(before.decodedVideoFrames,fixture.frames); assert.equal(after.decodedVideoFrames,fixture.frames);
  assert.equal(before.decodedAudioFrames,0); assert.equal(after.decodedAudioFrames,0);
  const clean = await pixelsAndTiming(prepared.bytes,fixture.type,prefix+'-clean'),source = await pixelsAndTiming(original,fixture.type,prefix+'-source');
  assert.deepEqual(clean.pixels,source.pixels);
  assert.deepEqual(clean.timing,source.timing);
  assert.deepEqual(prepared.source,{ size:original.length,sha256:sha(original) }); assert.deepEqual(prepared.derivative,{ size:prepared.bytes.length,sha256:sha(prepared.bytes) });
}
async function scenario(name,run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    console.log(`FAIL ${name}`);
    if (['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code)) console.log(`IMAGE_NATIVE_${error.code}`);
    if (error?.code === 'ERR_ASSERTION') { const line = /(?:image-metadata|icc-profile)-native-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1]; if (line) console.log(`IMAGE_NATIVE_ASSERTION_LINE_${line}`); }
    throw error;
  }
}
try {
  assert.ok(process.getuid() !== 0);
  assert.equal(sha(await readFile(root+'ffmpeg')),'d038f0fec3f7ea8b8eec4e90e8dcce330a6f7fcb1f3595d1ecb61877d310ab90');
  directory = await mkdtemp('/tmp/carebridge-image-metadata-');
  const still = ['-f','lavfi','-i','color=c=gray:s=32x24:r=2:d=2','-frames:v','1','-threads','1'],moving = ['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-threads','1'];
  await generate('still.png','image/png',[...still,'-c:v','png','-pix_fmt','rgb24','-f','image2','-update','1'],1);
  await generate('still.jpg','image/jpeg',[...still,'-c:v','mjpeg','-f','image2','-update','1'],1);
  await generate('still.webp','image/webp',[...still,'-c:v','libwebp','-lossless','1','-f','webp'],1);
  await generate('animated.gif','image/gif',[...moving,'-c:v','gif','-loop','0','-f','gif'],4);
  await generate('animated.webp','image/webp',[...moving,'-c:v','libwebp_anim','-lossless','1','-loop','0','-f','webp'],4);
  fixtures.push({ name:'animated.png',type:'image/png',frames:2,bytes:animatedPng(fixtures[0].bytes) });
  for (const [index,fixture] of fixtures.entries()) await scenario(`lossless metadata removal ${fixture.name}`,() => compare(fixture,1,`check-${index}`));
  await scenario('JPEG direction retained without exposing GPS or description',() => compare(fixtures[1],6,'direction'));
  await scenario('malformed ICC transformation is refused rather than changing colors',async () => {
    const png = fixtures[0].bytes,source = Buffer.concat([png.subarray(0,33),pngChunk('iCCP',Buffer.from(PRIVATE_MARKER)),png.subarray(33)]);
    assert.throws(() => prepareImageDerivative(source,'image/png'),{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
  });
  await runNativeIccCases({ scenario,fixtures,generate,decoder,file,pixelsAndTiming });
  assert.equal(passed,27); console.log(`Native image metadata: ${passed} scenarios passed.`);
} catch { failed = true; console.error('IMAGE_METADATA_NATIVE_FAILED'); }
finally {
  if (directory) try {
    // Explicitly bounded, flat, test-owned files only; no recursive deletion.
    const names = await readdir(directory); assert.ok(names.length < 100);
    for (const name of names) { assert.match(name,/^[a-z0-9.-]{1,80}$/); const path = `${directory}/${name}`,info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink()); await unlink(path); }
    await rmdir(directory);
  } catch { failed = true; console.error('IMAGE_METADATA_TEST_CLEANUP_FAILED'); }
  if (failed || passed !== 27) process.exitCode = 1;
}
