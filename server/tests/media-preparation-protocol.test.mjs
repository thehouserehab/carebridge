import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { RepositoryError } from '../errors.mjs';
import { preparationJobHeader,parsePreparationJobHeader,preparationJobOutput,preparationJobReport,preparationJobError,
  validatePreparationReport,PREPARATION_PROTOCOL,PREPARATION_REPORT_LIMIT,PREPARATION_OUTPUT_LIMIT } from '../media-preparation-protocol.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { syntheticMp4,syntheticWebm } from '../video-metadata-test-fixtures.mjs';
import { decodedMediaReport } from '../media-decoder-policy.mjs';
import { prepareDecodedMedia } from '../media-preparation-worker.mjs';
import { decoderCliTransport } from '../decoder-cli-transport.mjs';
import { run,manifest,reportFor,stream,hash,fakePreparation } from './media-preparation-fixtures.mjs';
const refused = (error) => error instanceof RepositoryError && error.code === 'SCAN_UNAVAILABLE' && error.message === error.code;
const invalid = (error) => error instanceof RepositoryError && error.code === 'SCAN_INVALID' && error.message === error.code;
const bytes = syntheticPng(),file = manifest(bytes);
function raw(value,payload = Buffer.alloc(0)) {
  const text = typeof value === 'string' ? value : JSON.stringify(value),json = Buffer.from(text),head = Buffer.alloc(4);
  head.writeUInt32BE(json.length); return Buffer.concat([head,json,payload]);
}
test('preparation input is a canonical bounded nonce and manifest without any name URL or identity',() => {
  const header = preparationJobHeader(run,file); assert.deepEqual(parsePreparationJobHeader(header.subarray(4)),{ id:run,...file });
  for (const value of [{ protocol:PREPARATION_PROTOCOL,id:run,...file,path:'PRIVATE' },{ protocol:'other',id:run,...file },
    { protocol:PREPARATION_PROTOCOL,id:'other',...file },{ protocol:PREPARATION_PROTOCOL,id:run,...file,size:50*1024*1024+1 }])
    assert.throws(() => parsePreparationJobHeader(Buffer.from(JSON.stringify(value))),invalid);
  const duplicate = JSON.stringify({ protocol:PREPARATION_PROTOCOL,id:run,...file }).replace('"size":','"size":1,"size":');
  for (const value of [Buffer.alloc(1025),Buffer.from(duplicate),Buffer.from([255])]) assert.throws(() => parsePreparationJobHeader(value),invalid);
});
test('binary candidate return verifies own hash and preserves image MP4 WebM manifest contracts',() => {
  for (const [bytes,type] of [[syntheticPng(),'image/png'],[syntheticMp4(),'video/mp4'],[syntheticWebm(),'video/webm']]) {
    const prepared = reportFor(bytes,type),packet = preparationJobOutput(run,prepared.report,prepared.bytes);
    const result = preparationJobReport(packet,run,manifest(bytes,type),0);
    assert.deepEqual(result.bytes,prepared.bytes); assert.deepEqual(result.report,prepared.report);
    assert.equal(result.report.mediaAcceptanceReady,false); assert.equal(Object.hasOwn(result.report,'verdict'),false);
    assert.notEqual(result.bytes.buffer,packet.buffer);
  }
});
test('bounded report prefix exact payload EOF and strict JSON reject ambiguous or extra output',() => {
  const prepared = reportFor(bytes),packet = preparationJobOutput(run,prepared.report,prepared.bytes);
  const duplicate = JSON.stringify({ protocol:PREPARATION_PROTOCOL,id:run,report:prepared.report }).replace('"protocol":','"protocol":"other","protocol":');
  for (const value of [packet.subarray(0,-1),Buffer.concat([packet,Buffer.from([0])]),Buffer.alloc(4),
    raw(duplicate,prepared.bytes),raw({ protocol:PREPARATION_PROTOCOL,id:run,report:prepared.report,path:'PRIVATE' },prepared.bytes)])
    assert.throws(() => preparationJobReport(value,run,file,0),refused);
  const bad = Buffer.from(packet); bad.writeUInt32BE(PREPARATION_REPORT_LIMIT+1); assert.throws(() => preparationJobReport(bad,run,file,0),refused);
  assert.equal(PREPARATION_OUTPUT_LIMIT,50*1024*1024+PREPARATION_REPORT_LIMIT+4);
});
test('nonce protocol actual exit and payload hash are independently required',() => {
  const prepared = reportFor(bytes),packet = preparationJobOutput(run,prepared.report,prepared.bytes);
  const bad = Buffer.from(packet); bad[bad.length-1] ^= 1;
  for (const [output,id,exit] of [[packet,'12345678-1234-4234-8234-123456789abd',0],[packet,run,1],[bad,run,0],
    [raw({ protocol:'other',id:run,report:prepared.report },prepared.bytes),run,0]]) assert.throws(() => preparationJobReport(output,id,file,exit),refused);
  const returned = preparationJobReport(packet,run,file,0); packet.fill(0); assert.deepEqual(returned.bytes,prepared.bytes);
});
test('failure protocol has no candidate or private diagnostic and requires a nonzero engine exit',() => {
  for (const code of ['SCAN_INVALID','SCAN_UNAVAILABLE']) {
    const packet = preparationJobError(run,code); assert.throws(() => preparationJobReport(packet,run,file,1),{ code,message:code });
    assert.throws(() => preparationJobReport(packet,run,file,0),refused);
    assert.throws(() => preparationJobReport(Buffer.concat([packet,Buffer.from([1])]),run,file,1),refused);
  }
  assert.throws(() => preparationJobError(run,'PRIVATE ERROR'),refused);
});
test('all source candidate decode timelines and metadata must agree without falling back',() => {
  const prepared = reportFor(bytes);
  for (const mutate of [(r) => { r.source.sha256 = '0'.repeat(64); },(r) => { r.derivative.type = 'image/jpeg'; },
    (r) => { r.sourceDecode.checkedBytes++; },(r) => { r.derivativeDecode.decodedVideoFrames++; },
    (r) => { r.derivativeTimelineSha256 = 'd'.repeat(64); },(r) => { r.metadata.policyVersion = 'old'; },
    (r) => { r.metadata.orientation = 0; },(r) => { r.metadata.iccProfilePolicy = 'unknown'; },
    (r) => { r.metadata.path = 'PRIVATE'; },(r) => { r.mediaAcceptanceReady = true; }]) {
    const report = structuredClone(prepared.report); mutate(report); assert.throws(() => validatePreparationReport(report,run,file),refused);
  }
});
test('timeline evidence catches changed frame timing even when dimensions count and total duration match',() => {
  const document = { format:{ format_name:'mov,mp4,m4a,3gp,3g2,mj2' },
    streams:[{ index:0,codec_type:'video',codec_name:'h264',width:1,height:1,nb_read_frames:'2' }],
    frames:[0,1].map((n) => ({ media_type:'video',stream_index:0,width:1,height:1,best_effort_timestamp_time:String(n),duration_time:'1' })) };
  const before = decodedMediaReport(document,'video/mp4',null,{ timelineEvidence:true }),changed = structuredClone(document);
  changed.frames[1].best_effort_timestamp_time = '1.5'; changed.frames[1].duration_time = '0.5';
  const after = decodedMediaReport(changed,'video/mp4',null,{ timelineEvidence:true });
  assert.deepEqual(before.media,after.media); assert.equal(before.decodedVideoFrames,after.decodedVideoFrames); assert.notEqual(before.timelineSha256,after.timelineSha256);
  document.format.tags = { name:'PRIVATE' }; document.streams[0].tags = { name:'PRIVATE' };
  assert.deepEqual(decodedMediaReport(document,'video/mp4',null,{ timelineEvidence:true }),before);
  assert.equal(Object.hasOwn(decodedMediaReport(document,'video/mp4'),'timelineSha256'),false);
});
test('timeline includes audio sample count and stream sample rate but no private metadata',() => {
  const document = { format:{ format_name:'matroska,webm' },
    streams:[{ index:0,codec_type:'video',codec_name:'vp8',width:1,height:1,nb_read_frames:'1' },
      { index:1,codec_type:'audio',codec_name:'opus',sample_rate:'48000',nb_read_frames:'1' }],
    frames:[{ media_type:'video',stream_index:0,width:1,height:1,best_effort_timestamp_time:'0',duration_time:'2' },
      { media_type:'audio',stream_index:1,nb_samples:1024,best_effort_timestamp_time:'0' }] };
  const before = decodedMediaReport(document,'video/webm',null,{ timelineEvidence:true }); document.frames[1].nb_samples = 512;
  const after = decodedMediaReport(document,'video/webm',null,{ timelineEvidence:true }); assert.deepEqual(before.media,after.media); assert.notEqual(before.timelineSha256,after.timelineSha256);
});
test('offline worker validates source first decodes both distinct manifests and retains the original',async () => {
  const reference = Buffer.from(bytes),calls = [];
  const decoder = { async decode(file,options) {
    assert.equal(options.timelineEvidence,true); const chunks = []; for await (const b of file.stream) chunks.push(b);
    const value = Buffer.concat(chunks); calls.push(manifest(value)); const prepared = reportFor(bytes);
    return { ...(calls.length === 1 ? prepared.report.sourceDecode : prepared.report.derivativeDecode),timelineSha256:'c'.repeat(64) };
  } };
  const prepared = await prepareDecodedMedia({ ...file,stream:stream(bytes) },decoder,run,{ signal:new AbortController().signal });
  assert.equal(calls.length,2); assert.equal(calls[1].sha256,hash(prepared.bytes)); assert.deepEqual(bytes,reference); assert.ok(prepared.bytes.some((b) => b !== 0));
});
test('original failure precedes transformation and derived failure never returns partially prepared bytes',async () => {
  const malformed = Buffer.from('synthetic malformed original'); let calls = 0;
  await assert.rejects(prepareDecodedMedia({ ...manifest(malformed),stream:stream(malformed) },{ async decode() { calls++; throw new RepositoryError('SCAN_UNAVAILABLE'); } },run,
    { signal:new AbortController().signal }),refused); assert.equal(calls,1);
  let borrowed;
  const decoder = { async decode(file) {
    calls++; const chunks = []; for await (const b of file.stream) chunks.push(b);
    if (calls === 3) { borrowed = chunks[0]; throw new Error('PRIVATE PROBE DETAIL'); }
    return { ...reportFor(bytes).report.sourceDecode,timelineSha256:'c'.repeat(64) };
  } };
  await assert.rejects(prepareDecodedMedia({ ...file,stream:stream(bytes) },decoder,run,{ signal:new AbortController().signal }),refused);
  assert.equal(borrowed.every((byte) => byte === 0),true);
});
test('corrupted binary and failed cleanup override a successful worker response',async () => {
  for (const options of [{ output:(buffer) => { buffer[buffer.length-1] ^= 1; return buffer; } },{ rmFails:true }]) {
    const f = fakePreparation(options); await assert.rejects(f.preparer.prepare({ ...file,stream:stream(bytes) }),refused);
    if (options.rmFails) { assert.equal(f.preparer.retainedJobs().length,1); options.rmFails = false; await f.preparer.recoverRetained(); }
    assert.equal(f.containers.size,0);
  }
});
test('binary pipe preserves arbitrary bytes while legacy text pipe retains its strict small bound',async () => {
  const transport = decoderCliTransport(async () => ({ file:process.execPath,
    args:['--input-type=module','-e',"for await (const b of process.stdin){};process.stdout.write(Buffer.alloc(9000,255));"],environment:{ PATH:'',LANG:'C',TZ:'UTC' } }));
  const result = await transport.exchange([],stream(Buffer.from('synthetic')),{ signal:new AbortController().signal,outputLimit:PREPARATION_OUTPUT_LIMIT });
  assert.equal(result.output.length,9000); assert.equal(result.output.every((b) => b === 255),true);
  await assert.rejects(transport.exchange([],stream(Buffer.from('synthetic')),{ signal:new AbortController().signal,outputLimit:4096 }),refused);
});
test('worker cancellation closes a stalled body without awaiting another source chunk',async () => {
  const controller = new AbortController(),source = new Readable({ read() {} }); let called = false;
  const pending = assert.rejects(prepareDecodedMedia({ ...file,stream:source },{ async decode() { called = true; } },run,{ signal:controller.signal }),refused);
  setTimeout(() => controller.abort('PRIVATE REASON'),10); await pending; assert.equal(source.destroyed,true); assert.equal(called,false);
});
