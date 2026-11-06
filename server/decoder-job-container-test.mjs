// Explicit local Docker test ONLY. No real/user files, mounts, ports, database,
// application integration or implicit activation. Output never emits payloads.
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { decoderJobHeader,decoderJobReport } from './decoder-job-protocol.mjs';
import { addPrivateMetadata,rasterPng } from './image-metadata-test-fixtures.mjs';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames,decoderReceipt,decoderContainerArguments,assertDecoderOwner,assertDecoderIsolation } from './decoder-container-policy.mjs';
const directory = dirname(fileURLToPath(import.meta.url)),artifacts = [],rawJobs = [];
let runtime,engine,decoder,passed = 0,failed = false,complete = false;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const input = (fixture,changes = {}) => ({ stream:Readable.from([fixture.bytes],{ objectMode:false }),type:fixture.type,size:fixture.bytes.length,sha256:digest(fixture.bytes),...changes });
const manifest = (fixture) => ({ type:fixture.type,size:fixture.bytes.length,sha256:digest(fixture.bytes) });
const code = (expected) => (error) => error.code === expected && error.message === expected;
function pngChunk(name,data) {
  const bytes = Buffer.alloc(data.length+12); bytes.writeUInt32BE(data.length); bytes.write(name,4,'ascii'); data.copy(bytes,8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4,-4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0,bytes.length-4); return bytes;
}
function animatedPng(png) {
  const chunks = []; for (let at = 8; at < png.length;) { const size = png.readUInt32BE(at); chunks.push({ name:png.toString('ascii',at+4,at+8),data:png.subarray(at+8,at+8+size) }); at += size+12; }
  const header = chunks.find((chunk) => chunk.name === 'IHDR').data,ac = Buffer.alloc(8); ac.writeUInt32BE(2);
  const result = [png.subarray(0,8),pngChunk('IHDR',header),pngChunk('acTL',ac)]; let sequence = 0;
  for (let index = 0; index < 2; index++) {
    const fc = Buffer.alloc(26); fc.writeUInt32BE(sequence++); header.subarray(0,8).copy(fc,4); fc.writeUInt16BE(1,20); fc.writeUInt16BE(2,22); result.push(pngChunk('fcTL',fc));
    for (const chunk of chunks.filter((chunk) => chunk.name === 'IDAT')) {
      if (!index) result.push(pngChunk('IDAT',chunk.data));
      else { const frame = Buffer.alloc(chunk.data.length+4); frame.writeUInt32BE(sequence++); chunk.data.copy(frame,4); result.push(pngChunk('fdAT',frame)); }
    }
  }
  result.push(pngChunk('IEND',Buffer.alloc(0))); return Buffer.concat(result);
}
async function noJobs() {
  assert.deepEqual(decoder.retainedJobs(),[]);
  // An absence check corroborates coordinator cleanup, not creation-timeout
  // recovery. Opaque UUID labels ensure unrelated resources are never touched.
  for (const id of ownJobIds) { await assert.rejects(runtime.inspect('container',id)); ownJobIds.delete(id); }
}
const ownJobIds = new Set();
async function scenario(name,run) {
  try { await run(); await noJobs(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    console.log(`FAIL ${name}`);
    if (['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code)) console.log(`DECODER_JOB_TEST_${error.code}`);
    if (error.code === 'ERR_ASSERTION') {
      const line = /decoder-job-container-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1];
      if (line) console.log(`DECODER_JOB_ASSERTION_LINE_${line}`);
    }
    throw error;
  }
}
async function build(file,target) {
  const names = decoderResourceNames(randomUUID()); artifacts.push({ names,id:null }); const artifact = artifacts.at(-1);
  console.log(`Owned public build run: ${names.run}`);
  await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load','--target',target,'--label',`${DECODER_RUN_LABEL}=${names.run}`,
    '--tag',names.image,'--file',join(directory,file),dirname(directory)],{ timeout:900000 });
  const value = await runtime.inspect('image',names.image);
  assert.equal(value.Config.Labels[DECODER_RUN_LABEL],names.run); assert.equal(value.Os,'linux'); assert.equal(value.Architecture,'amd64');
  artifact.id = value.Id; return artifact;
}
async function removeContainer(receipt,imageId) {
  assert.equal(await runtime.identity(),engine);
  let state = await runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,imageId);
  if (state.State.Running) {
    await runtime.docker(['kill','--signal','KILL',receipt.id]);
    const deadline = Date.now()+15000;
    do { await delay(20); state = await runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,imageId); } while (state.State.Running && Date.now() < deadline);
  }
  assert.equal(state.State.Running,false); assert.ok(['created','exited','dead'].includes(state.State.Status));
  await runtime.docker(['rm',receipt.id]);
}
async function rawWorker(imageId,packet,id = randomUUID()) {
  const names = decoderResourceNames(id,'job');
  const created = await runtime.docker(decoderContainerArguments(names,imageId,'job'));
  const receipt = decoderReceipt(created,id,'job'); rawJobs.push({ receipt,imageId });
  assertDecoderIsolation(await runtime.inspect('container',created),receipt,imageId);
  const controller = new AbortController(),timer = setTimeout(() => controller.abort(),15000);
  let result;
  try {
    result = await runtime.exchange(created,packet,{ signal:controller.signal,outputLimit:4096,onFailure:() => controller.abort() });
    const state = await runtime.inspect('container',created); assertDecoderIsolation(state,receipt,imageId); assert.equal(state.State.Status,'exited');
    return { ...result,exitCode:state.State.ExitCode,id };
  } finally {
    clearTimeout(timer); await removeContainer(receipt,imageId); rawJobs.pop();
  }
}
try {
  runtime = await localDockerTestRuntime(); engine = await runtime.identity();
  await runtime.officialImage(DECODER_NODE_IMAGE); await runtime.localBuilder(); assert.ok(runtime.memoryBytes >= 3*1024**3);
  const worker = await build('decoder-job.Dockerfile','worker'),encoder = await build('decoder-test.Dockerfile','fixtures');
  const generatorId = await runtime.docker(decoderContainerArguments(encoder.names,encoder.id));
  const generatorReceipt = decoderReceipt(generatorId,encoder.names.run); rawJobs.push({ receipt:generatorReceipt,imageId:encoder.id });
  assertDecoderIsolation(await runtime.inspect('container',generatorId),generatorReceipt,encoder.id);
  const generated = await runtime.command(['start','--attach',generatorId],{ timeout:120000 });
  const generatorState = await runtime.inspect('container',generatorId); assertDecoderIsolation(generatorState,generatorReceipt,encoder.id);
  assert.equal(generated.code,0); assert.equal(generatorState.State.Status,'exited'); assert.equal(generatorState.State.ExitCode,0); assert.equal(generatorState.State.OOMKilled,false);
  const payload = JSON.parse(generated.output); assert.equal(payload.protocol,'carebridge-synthetic-fixtures-v1'); assert.equal(payload.fixtures.length,17);
  const fixtures = payload.fixtures.map(({ base64,...value }) => ({ ...value,bytes:Buffer.from(base64,'base64') }));
  fixtures.push({ name:'animated.png',type:'image/png',width:32,height:24,frames:2,codecs:['video:apng'],bytes:animatedPng(fixtures.find((fixture) => fixture.name === 'still.png').bytes) });
  await removeContainer(generatorReceipt,encoder.id); rawJobs.pop();
  const observedRuntime = { ...runtime,async docker(args,options) {
    const result = await runtime.docker(args,options); if (args[0] === 'create') ownJobIds.add(result); return result;
  } };
  decoder = new IsolatedMediaDecoder({ runtime:observedRuntime,approvedImageId:worker.id,engineIdentity:engine });
  for (const fixture of fixtures) await scenario(`isolated full decode ${fixture.name}`,async () => {
    const report = await decoder.decode(input(fixture)); assert.equal(report.mediaAcceptanceReady,false);
    assert.equal(report.media.width,fixture.width); assert.equal(report.media.height,fixture.height); assert.equal(report.media.type,fixture.type);
    assert.equal(report.decodedVideoFrames,fixture.frames); assert.equal(report.checkedBytes,fixture.bytes.length); assert.equal(report.sha256,digest(fixture.bytes));
    assert.equal(report.decodedAudioFrames > 0,fixture.codecs.some((codec) => codec.startsWith('audio:')));
    assert.equal(Object.hasOwn(report,'verdict'),false); assert.equal(typeof decoder.inspect,'undefined');
  });
  for (const fixture of fixtures) await scenario(`isolated prepare and decode both manifests ${fixture.name}`,async () => {
    const original = fixture.type.startsWith('image/') ? addPrivateMetadata(fixture.bytes,fixture.type,6) : Buffer.from(fixture.bytes);
    const source = { ...fixture,bytes:original },before = Buffer.from(original),prepared = await decoder.prepare(input(source));
    assert.ok(prepared.bytes !== original); assert.deepEqual(original,before);
    assert.equal(prepared.report.source.sha256,digest(original)); assert.equal(prepared.report.derivative.sha256,digest(prepared.bytes));
    assert.equal(prepared.report.sourceDecode.decodedVideoFrames,fixture.frames);
    assert.equal(prepared.report.derivativeDecode.decodedVideoFrames,fixture.frames);
    assert.equal(prepared.report.derivativeDecode.decodedAudioFrames > 0,fixture.codecs.some((codec) => codec.startsWith('audio:')));
    assert.equal(prepared.report.sourceTimelineSha256,prepared.report.derivativeTimelineSha256);
    assert.equal(prepared.report.mediaAcceptanceReady,false);
    if (fixture.type.startsWith('image/')) {
      assert.equal(prepared.report.metadata.orientation,fixture.type === 'image/gif' ? 1 : 6);
      assert.equal(prepared.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_IMAGE_METADATA')),false);
    }
    // Decode the returned binary bytes in another namespace, not merely the
    // worker's in-memory candidate/report. No base64 or text conversion.
    const received = await decoder.decode(input({ ...fixture,bytes:prepared.bytes }));
    assert.equal(received.sha256,prepared.report.derivative.sha256); assert.equal(received.decodedVideoFrames,fixture.frames); prepared.bytes.fill(0);
  });
  const png = fixtures.find((fixture) => fixture.name === 'still.png');
  await scenario('fragmented length header and payload reaches separate stdin worker',async () => {
    const id = randomUUID(),bytes = Buffer.concat([decoderJobHeader(id,manifest(png)),png.bytes]);
    const packet = Readable.from((async function* () { for (let at = 0; at < bytes.length; at++) { yield bytes.subarray(at,at+1); await delay(1); } })(),{ objectMode:false });
    const result = await rawWorker(worker.id,packet,id); assert.equal(result.code,0); assert.equal(decoderJobReport(result.output,id,manifest(png),result.exitCode).media.width,32);
  });
  await scenario('worker malformed bounded header returns no source details',async () => {
    const result = await rawWorker(worker.id,Readable.from([Buffer.from([0,0,4,1])],{ objectMode:false }));
    assert.notEqual(result.exitCode,0); assert.equal(result.output,'');
  });
  await scenario('missing stdin header ends worker and pending source without a reply',async () => {
    const stream = new Readable({ read() {} });
    await assert.rejects(rawWorker(worker.id,stream),code('SCAN_UNAVAILABLE')); assert.equal(stream.destroyed,true);
  });
  await scenario('worker full SHA mismatch does not return decode report',async () => {
    const id = randomUUID(),wrong = { ...manifest(png),sha256:'0'.repeat(64) };
    const result = await rawWorker(worker.id,Readable.from([decoderJobHeader(id,wrong),png.bytes],{ objectMode:false }),id);
    assert.throws(() => decoderJobReport(result.output,id,wrong,result.exitCode),code('SCAN_INVALID'));
  });
  await scenario('declared source size and hash mismatch clean up only own jobs',async () => {
    for (const change of [{ size:png.bytes.length+1 },{ size:png.bytes.length-1 },{ sha256:'0'.repeat(64) }]) await assert.rejects(decoder.decode(input(png,change)),code('SCAN_INVALID'));
  });
  await scenario('actual malformed and MIME mismatched content rejected by native worker',async () => {
    const invalid = { bytes:Buffer.from('synthetic invalid media'),type:'image/png' },id = randomUUID();
    const diagnostic = await rawWorker(worker.id,Readable.from([decoderJobHeader(id,manifest(invalid)),invalid.bytes],{ objectMode:false }),id);
    // Numeric transport/actual exit only; never print native stdout/stderr.
    console.log(`Worker invalid control CLI ${diagnostic.code} actual ${diagnostic.exitCode}`);
    assert.throws(() => decoderJobReport(diagnostic.output,id,manifest(invalid),diagnostic.exitCode),code('SCAN_INVALID'));
    await assert.rejects(decoder.decode(input({ bytes:Buffer.from('synthetic invalid media'),type:'image/png' })),code('SCAN_INVALID'));
    await assert.rejects(decoder.decode(input(png,{ type:'image/jpeg' })),code('SCAN_INVALID'));
    await assert.rejects(decoder.decode(input({ ...png,bytes:png.bytes.subarray(0,-2) })),code('SCAN_INVALID'));
  });
  await scenario('source IO failure private diagnostics remain redacted and job removed',async () => {
    const stream = new Readable({ read() { this.destroy(new Error('PRIVATE SYNTHETIC SOURCE DETAIL')); } });
    await assert.rejects(decoder.decode(input(png,{ stream })),code('SCAN_UNAVAILABLE')); assert.equal(stream.destroyed,true);
  });
  await scenario('active worker cancel ends actual owned namespace and supports next job',async () => {
    const controller = new AbortController(); let observed = false;
    const cancelRuntime = { ...observedRuntime,async exchange(id,packet,options) {
      const pending = runtime.exchange(id,packet,options),settled = pending.then((value) => ({ value }),(error) => ({ error }));
      const deadline = Date.now()+10000;
      while (Date.now() < deadline) {
        const state = await runtime.inspect('container',id);
        if (state.State.Running) { observed = true; controller.abort('PRIVATE REASON'); break; }
        await delay(10);
      }
      if (!observed) controller.abort();
      const result = await settled; if (result.error) throw result.error; return result.value;
    } };
    const isolated = new IsolatedMediaDecoder({ runtime:cancelRuntime,approvedImageId:worker.id,engineIdentity:engine });
    const stream = new Readable({ read() {} }); await assert.rejects(isolated.decode(input(png,{ stream }),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
    assert.equal(observed,true); assert.equal(stream.destroyed,true); assert.deepEqual(isolated.retainedJobs(),[]);
    await decoder.decode(input(png));
  });
  await scenario('stalled payload deadline removes actual running worker',async () => {
    let observed = false;
    const deadlineRuntime = { ...observedRuntime,async exchange(id,packet,options) {
      const pending = runtime.exchange(id,packet,options),settled = pending.then((value) => ({ value }),(error) => ({ error }));
      const state = await runtime.inspect('container',id); observed = state.State.Running;
      if (!observed) { await delay(200); observed = (await runtime.inspect('container',id)).State.Running; }
      const result = await settled; if (result.error) throw result.error; return result.value;
    } };
    const bounded = new IsolatedMediaDecoder({ runtime:deadlineRuntime,approvedImageId:worker.id,engineIdentity:engine,timeoutMilliseconds:10000 });
    const stream = new Readable({ read() {} }); await assert.rejects(bounded.decode(input(png,{ stream })),code('SCAN_UNAVAILABLE'));
    assert.equal(observed,true); assert.equal(stream.destroyed,true); assert.deepEqual(bounded.retainedJobs(),[]);
  });
  await scenario('two concurrent file namespaces decode independently with no leftovers',async () => {
    const results = await Promise.all([decoder.decode(input(png)),decoder.decode(input(fixtures.find((fixture) => fixture.name === 'h264.mp4')))]);
    assert.equal(results[0].media.type,'image/png'); assert.equal(results[1].media.type,'video/mp4');
  });
  await scenario('binary preparation refuses SHA and size mismatches without returning a candidate',async () => {
    for (const change of [{ size:png.bytes.length+1 },{ sha256:'0'.repeat(64) }]) await assert.rejects(decoder.prepare(input(png,change)),code('SCAN_INVALID'));
  });
  await scenario('two independent preparation namespaces preserve each returned manifest',async () => {
    const results = await Promise.all([decoder.prepare(input(png)),decoder.prepare(input(fixtures.find((fixture) => fixture.name === 'h264.mp4')))]);
    assert.equal(results[0].report.derivative.type,'image/png'); assert.equal(results[1].report.derivative.type,'video/mp4');
    for (const result of results) { assert.equal(result.report.derivative.sha256,digest(result.bytes)); result.bytes.fill(0); }
  });
  await scenario('illegal PNG row filters fail both isolated decode and preparation with no candidate',async () => {
    const bytes = rasterPng({ filter:99 }),fixture = { bytes,type:'image/png' };
    await assert.rejects(decoder.decode(input(fixture)),code('SCAN_INVALID'));
    await assert.rejects(decoder.prepare(input(fixture)),code('SCAN_INVALID')); bytes.fill(0);
  });
  assert.equal(passed,49); complete = true; console.log(`Native per-file isolation: ${passed} scenarios passed.`);
} catch (error) {
  failed = true;
  console.error(['LOCAL_DOCKER_TEST_UNAVAILABLE'].includes(error?.message) ? error.message : 'DECODER_JOB_TEST_FAILED');
  if (error.code === 'ERR_ASSERTION') {
    const line = /decoder-job-container-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1]; if (line) console.error(`DECODER_JOB_ASSERTION_LINE_${line}`);
  }
} finally {
  for (const { receipt,imageId } of rawJobs) try { await removeContainer(receipt,imageId); } catch { failed = true; console.error(`Retained opaque test container: ${receipt.id}`); }
  for (const retained of decoder?.retainedJobs() ?? []) { failed = true; console.error(`Retained opaque job: ${retained.run} ${retained.id ?? 'unknown'}`); }
  for (const artifact of artifacts) try {
    if (!artifact.id) throw new Error('UNKNOWN_BUILD');
    const value = await runtime.inspect('image',artifact.names.image);
    assert.equal(value.Id,artifact.id); assert.equal(value.Config.Labels[DECODER_RUN_LABEL],artifact.names.run);
    assert.deepEqual(value.RepoTags,[artifact.names.image]);
    assert.equal((await runtime.docker(['ps','--all','--filter',`ancestor=${artifact.id}`,'--format','{{.ID}}'])).trim(),'');
    await runtime.docker(['image','rm',artifact.names.image]);
  } catch { failed = true; console.error(`Retained owned test image: ${artifact.names.image}`); }
  if (complete && !failed) console.log('PASS exact owned test images removed after all job containers ended');
  if (failed || !complete) process.exitCode = 1;
}
