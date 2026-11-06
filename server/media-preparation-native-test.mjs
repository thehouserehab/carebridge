// Synthetic native controller ONLY. Has an explicitly granted engine socket;
// actual per-file workers remain offline and receive no engine/host mounts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalClamAvClient } from './clamav-client.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { linuxDecoderRuntime } from './linux-decoder-runtime.mjs';
import { MediaPreparation } from './media-preparation.mjs';
import { nativePreparationStorageCases } from './media-preparation-storage-native-test.mjs';
import { syntheticPng,animatedPng,syntheticGif,addPrivateMetadata,pngChunk,rasterPng } from './image-metadata-test-fixtures.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = (bytes,type = 'image/png') => ({ type,size:bytes.length,sha256:hash(bytes) });
const streamOf = (bytes) => Readable.from([bytes],{ objectMode:false });
const code = (expected) => (error) => error.code === expected && error.message === expected;
const testMarker = () => Buffer.concat([Buffer.from('X5O!P%@AP[4'),Buffer.from([92]),
  Buffer.from('PZX54(P^)7CC)7}$'),Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
let runtime,preparer,scanner,pipeline,engine,passed = 0,cancelActive = null;
const ownJobs = new Set(); let creates = 0;
class CountingScanner extends LocalClamAvClient {
  calls = 0;
  async scan(...args) { this.calls++; return super.scan(...args); }
}
async function noJobs() {
  assert.deepEqual(preparer.retainedJobs(),[]); assert.equal(await runtime.identity(),engine);
  for (const id of ownJobs) assert.equal(await runtime.docker(['ps','--all','--no-trunc','--filter',`id=${id}`,'--format','{{.ID}}']),'');
  ownJobs.clear();
}
async function scenario(name,work) {
  try { await work(); await noJobs(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.log(`FAIL ${name}`); throw error; }
}
try {
  assert.equal(process.platform,'linux'); assert.notEqual(process.getuid(),0);
  engine = process.env.CAREBRIDGE_LINUX_TEST_ENGINE;
  runtime = await linuxDecoderRuntime({ cliPath:'/usr/local/bin/docker',cliSha256:'9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581',
    socketPath:'/run/carebridge-engine/docker.sock',socketOwnerUid:0,engineIdentity:engine,approvedImageId:process.env.CAREBRIDGE_LINUX_TEST_IMAGE });
  const observed = { ...runtime,async docker(args,options) {
    const id = await runtime.docker(args,options); if (args[0] === 'create') { ownJobs.add(id); creates++; } return id;
  },async exchange(id,packet,options) {
    if (!cancelActive) return runtime.exchange(id,packet,options);
    const pending = runtime.exchange(id,packet,options),settled = pending.then((value) => ({ value }),(error) => ({ error }));
    let running = false; const deadline = Date.now()+5000;
    while (Date.now() < deadline) { if ((await runtime.inspect('container',id)).State.Running) { running = true; break; } await delay(20); }
    cancelActive.observed = running; cancelActive.controller.abort();
    const result = await settled; if (result.error) throw result.error; return result.value;
  } };
  preparer = new IsolatedMediaDecoder({ runtime:observed,approvedImageId:process.env.CAREBRIDGE_LINUX_TEST_IMAGE,engineIdentity:engine });
  scanner = new CountingScanner({ endpoint:{ host:'127.0.0.1',port:3310 },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC',
    timeoutMilliseconds:5000,connectTimeoutMilliseconds:500 });
  pipeline = new MediaPreparation({ scanner,preparer,maxConcurrent:1 });
  const startup = Date.now()+120000; let status;
  while (Date.now() < startup) { try { status = await scanner.status(); break; } catch { await delay(500); } }
  assert.equal(status?.available,true);
  await scenario('actual approved scanner definitions available before any file input',async () => {
    assert.equal(status.engineVersion,'1.4.6'); assert.equal(status.mediaAcceptanceReady,false);
    console.log(`Engine: ClamAV 1.4.6; definitions ${status.databaseVersion}; UTC ${status.databaseUpdatedAt}`);
  });
  for (const [name,bytes,type,frames,orientation] of [
    ['PNG',addPrivateMetadata(syntheticPng(),'image/png',6),'image/png',1,6],
    ['APNG',addPrivateMetadata(animatedPng(syntheticPng()),'image/png',6),'image/png',2,6],
    ['GIF',addPrivateMetadata(syntheticGif(),'image/gif'),'image/gif',1,1],
  ]) await scenario(`native two scans offline preparation and binary return ${name}`,async () => {
    const original = Buffer.from(bytes),start = scanner.calls;
    const result = await pipeline.prepare({ ...manifest(bytes,type),openSource:() => streamOf(bytes) });
    assert.equal(result.status,'prepared'); assert.equal(scanner.calls-start,2); assert.deepEqual(bytes,original);
    assert.equal(result.report.source.sha256,hash(bytes)); assert.equal(result.report.derivative.sha256,hash(result.bytes));
    assert.equal(result.report.preparation.sourceDecode.decodedVideoFrames,frames);
    assert.equal(result.report.preparation.derivativeDecode.decodedVideoFrames,frames);
    assert.equal(result.report.preparation.metadata.orientation,orientation);
    assert.equal(result.report.preparation.sourceTimelineSha256,result.report.preparation.derivativeTimelineSha256);
    assert.equal(result.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_IMAGE_METADATA')),false);
    assert.equal(result.mediaAcceptanceReady,false); result.bytes.fill(0);
  });
  await scenario('native normal PNG depths filters and Adam7 empty passes retain full decode support',async () => {
    for (const options of [{ width:1,height:1,color:3,depth:1,interlace:1 },{ color:6,depth:16,interlace:1,filter:4 },
      { width:3,height:2,color:4,depth:16,interlace:1,filter:2 },{ color:3,depth:4,interlace:1,filter:3 },{ filter:1 },{ color:0,depth:16 }]) {
      const bytes = rasterPng(options),result = await pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) });
      assert.equal(result.status,'prepared'); assert.deepEqual(result.bytes,bytes); assert.equal(result.report.preparation.sourceDecode.decodedVideoFrames,1);
      assert.equal(result.report.preparation.sourceTimelineSha256,result.report.preparation.derivativeTimelineSha256); result.bytes.fill(0);
    }
  });
  await scenario('native source detection stops before any decoder namespace is created',async () => {
    // Official raw harmless anti-malware control, not a valid PNG. The MIME
    // is only the declared scan manifest; rejection must precede decoding.
    const bytes = testMarker();
    const before = creates,start = scanner.calls,result = await pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) });
    assert.equal(result.status,'rejected'); assert.equal(result.stage,'source'); assert.equal(creates,before); assert.equal(scanner.calls-start,1);
    assert.equal(Object.hasOwn(result,'bytes'),false); bytes.fill(0);
  });
  await scenario('embedded marker clean reply cannot turn preparation into operating file approval',async () => {
    // Retain the originally failing real PNG control. Definition-dependent
    // detection is measured, never relabeled as a guaranteed malware block.
    const png = syntheticPng(),marker = testMarker(),bytes = Buffer.concat([png.subarray(0,33),pngChunk('tEXt',Buffer.concat([Buffer.from('Comment\0'),marker])),png.subarray(33)]);
    const result = await pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) });
    assert.equal(result.mediaAcceptanceReady,false);
    if (result.status === 'prepared') {
      assert.equal(result.report.sourceScan.verdict,'clean'); assert.equal(result.report.derivativeScan.verdict,'clean');
      assert.equal(result.report.mediaAcceptanceReady,false); assert.equal(result.bytes.includes(marker),false);
      console.log('Embedded marker result: prepared-unapproved'); result.bytes.fill(0);
    } else { assert.equal(result.status,'rejected'); assert.equal(Object.hasOwn(result,'bytes'),false); console.log('Embedded marker result: rejected'); }
    bytes.fill(0); marker.fill(0);
  });
  await scenario('truncated container is blocked before any candidate scan',async () => {
    const bytes = syntheticPng().subarray(0,-2),start = scanner.calls;
    let result,error;
    try { result = await pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) }); } catch (caught) { error = caught; }
    if (result) {
      assert.equal(result.status,'rejected'); assert.equal(result.stage,'source'); assert.equal(Object.hasOwn(result,'bytes'),false);
      console.log('Truncated control result: source-rejected');
    } else { assert.ok(code('SCAN_INVALID')(error)); console.log('Truncated control result: decode-invalid'); }
    assert.equal(scanner.calls-start,1);
  });
  await scenario('actual clean scan cannot substitute for full decoded pixel structure validation',async () => {
    // Valid PNG chunks/CRC/zlib, but illegal PNG row filters. This isolates
    // full decoding from the daemon's AlertBrokenMedia container checks.
    const png = syntheticPng(),rows = Buffer.alloc(24*97,100); for (let row = 0; row < 24; row++) rows[row*97] = 99;
    const bytes = Buffer.concat([png.subarray(0,33),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]);
    const scan = await scanner.scan({ ...manifest(bytes),stream:streamOf(bytes) }); assert.equal(scan.verdict,'clean');
    const start = scanner.calls,before = creates;
    await assert.rejects(pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) }),code('SCAN_INVALID'));
    assert.equal(scanner.calls-start,1); assert.equal(creates,before+1); rows.fill(0); bytes.fill(0);
  });
  await scenario('actual active isolated preparation cancellation ends its namespace before returning',async () => {
    const bytes = syntheticPng(),controller = new AbortController(),state = { controller,observed:false }; cancelActive = state; let opened = 0;
    await assert.rejects(pipeline.prepare({ ...manifest(bytes),openSource:() => ++opened === 1 ? streamOf(bytes) : new Readable({ read() {} }) },
      { signal:controller.signal }),code('SCAN_UNAVAILABLE')); cancelActive = null; assert.equal(state.observed,true);
  });
  await scenario('native second source hash mismatch cannot substitute another candidate',async () => {
    const bytes = syntheticPng(),other = Buffer.from(bytes); other[other.length-1] ^= 1; let opened = 0; const start = scanner.calls;
    await assert.rejects(pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(++opened === 1 ? bytes : other) }),code('SCAN_INVALID'));
    assert.equal(scanner.calls-start,1); other.fill(0);
  });
  await scenario('successful retry after cancellation creates a fresh job without old candidate reuse',async () => {
    const bytes = syntheticPng(),before = creates,result = await pipeline.prepare({ ...manifest(bytes),openSource:() => streamOf(bytes) });
    assert.equal(result.status,'prepared'); assert.equal(creates,before+1); result.bytes.fill(0);
  });
  await nativePreparationStorageCases(scenario,pipeline);
  assert.equal(passed,18); console.log('Native combined media preparation: 18 scenarios passed.');
} catch (error) {
  console.log('MEDIA_PREPARATION_NATIVE_FAILED');
  if (/^[A-Z0-9]{5}$/.test(error?.code ?? '')) console.log(`MEDIA_PREPARATION_SQLSTATE_${error.code}`);
  if (['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code)) console.log(`MEDIA_PREPARATION_${error.code}`);
  const line = /media-preparation-native-test\.mjs:(\d{1,4}):\d+/.exec(error?.stack ?? '')?.[1]; if (line) console.log(`MEDIA_PREPARATION_ASSERTION_LINE_${line}`);
  const storageLine = /media-preparation-storage-native-test\.mjs:(\d{1,4}):\d+/.exec(error?.stack ?? '')?.[1]; if (storageLine) console.log(`MEDIA_PREPARATION_STORAGE_ASSERTION_LINE_${storageLine}`);
  process.exitCode = 1;
} finally {
  if (preparer) try { await noJobs(); } catch { process.exitCode = 1; console.error('MEDIA_PREPARATION_RETAINED_JOBS'); }
  for (const job of preparer?.retainedJobs() ?? []) console.error(`Retained opaque job: ${job.run} ${job.id ?? 'unknown'}`);
}
