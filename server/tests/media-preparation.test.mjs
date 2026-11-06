import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { RepositoryError } from '../errors.mjs';
import { MediaPreparation } from '../media-preparation.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { manifest,stream,fakePreparation,fakeClam,hash } from './media-preparation-fixtures.mjs';
const bytes = syntheticPng(),file = manifest(bytes);
const refused = (error) => error instanceof RepositoryError && error.code === 'SCAN_UNAVAILABLE' && error.message === error.code;
const invalid = (error) => error instanceof RepositoryError && error.code === 'SCAN_INVALID' && error.message === error.code;
async function fixture(t,clamOptions = {},preparationOptions = {},config = {}) {
  const clam = await fakeClam(clamOptions); t.after(() => clam.close()); const f = fakePreparation(preparationOptions);
  return { ...f,clam,pipeline:new MediaPreparation({ scanner:clam.scanner,preparer:f.preparer,...config }) };
}
test('pipeline requires concrete local bounded services and cannot become an upload inspector',async (t) => {
  const f = await fixture(t);
  for (const change of [{ scanner:{ scan() {} } },{ preparer:{ prepare() {} } },{ maxConcurrent:3 },{ timeoutMilliseconds:360001 }])
    assert.throws(() => new MediaPreparation({ scanner:f.clam.scanner,preparer:f.preparer,...change }),TypeError);
  assert.equal(typeof f.pipeline.inspect,'undefined');
  assert.throws(() => new MediaUploads({ transaction() {} },{ write() {},openVerified() {},remove() {} },{ scanner:f.pipeline }),TypeError);
});
test('actual loopback framing scans source before isolated job and then scans exact returned candidate',async (t) => {
  const f = await fixture(t),streams = []; let opened = 0;
  const result = await f.pipeline.prepare({ ...file,openSource() { const s = stream(bytes); streams.push(s); opened++; return s; } });
  assert.equal(result.status,'prepared'); assert.equal(opened,2); assert.equal(f.clam.scans.length,2);
  assert.deepEqual(f.clam.scans[0],bytes); assert.deepEqual(f.clam.scans[1],result.bytes);
  assert.equal(hash(result.bytes),result.report.derivative.sha256); assert.equal(result.report.source.sha256,file.sha256);
  assert.equal(result.report.sourceScan.databaseVersion,result.report.derivativeScan.databaseVersion);
  assert.equal(result.mediaAcceptanceReady,false); assert.equal(result.report.mediaAcceptanceReady,false); assert.equal(f.containers.size,0);
  assert.equal(streams.every((s) => s.destroyed),true); result.bytes.fill(0);
});
test('source malware detection stops before second read any container or candidate creation',async (t) => {
  const f = await fixture(t,{ rejectAt:1 }); let opened = 0;
  const result = await f.pipeline.prepare({ ...file,openSource() { opened++; return stream(bytes); } });
  assert.equal(result.status,'rejected'); assert.equal(result.stage,'source'); assert.equal(opened,1);
  assert.equal(Object.hasOwn(result,'bytes'),false); assert.equal(f.calls.length,0);
});
test('candidate malware detection does not retain or return candidate bytes',async (t) => {
  const f = await fixture(t,{ rejectAt:2 });
  const result = await f.pipeline.prepare({ ...file,openSource:() => stream(bytes) });
  assert.equal(result.status,'rejected'); assert.equal(result.stage,'derivative'); assert.equal(Object.hasOwn(result,'bytes'),false); assert.equal(f.containers.size,0);
});
test('definition change between source and candidate invalidates the combined result',async (t) => {
  const options = {},f = await fixture(t,{},options); options.beforeReturn = () => f.clam.changeDatabase();
  await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  assert.equal(f.clam.scans.length,2); assert.equal(f.containers.size,0);
});
test('source changed between reads fails the isolated source SHA check and never scans a candidate',async (t) => {
  const f = await fixture(t); let opened = 0;
  await assert.rejects(f.pipeline.prepare({ ...file,openSource() { const b = Buffer.from(bytes); if (++opened === 2) b[b.length-1] ^= 1; return stream(b); } }),invalid);
  assert.equal(f.clam.scans.length,1); assert.equal(f.containers.size,0);
});
test('missing factory extra identities wrong manifest and reused ended streams are rejected',async (t) => {
  const f = await fixture(t);
  for (const value of [{ ...file },{ ...file,openSource:() => stream(bytes),childId:'PRIVATE' },{ ...file,size:0,openSource:() => stream(bytes) },
    { ...file,openSource:() => ({ path:'PRIVATE' }) }]) await assert.rejects(f.pipeline.prepare(value),invalid);
  const source = stream(bytes); await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => source }),invalid);
  assert.equal(f.containers.size,0);
});
test('private source errors and preparation transport failure expose only fixed codes',async (t) => {
  const f = await fixture(t,{}, { output:() => Buffer.from('PRIVATE TRANSPORT DETAIL') });
  await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  await assert.rejects(f.pipeline.prepare({ ...file,openSource() { throw new Error('PRIVATE STORAGE PATH'); } }),refused);
  assert.equal(f.containers.size,0);
});
test('cancelled pending read is disposed even when its factory resolves after cancellation',async (t) => {
  const f = await fixture(t),controller = new AbortController(); let give,entered;
  const waiting = new Promise((yes) => { entered = yes; }),source = new Readable({ read() {} });
  const work = f.pipeline.prepare({ ...file,openSource:() => { entered(); return new Promise((yes) => { give = yes; }); } },{ signal:controller.signal });
  const rejected = assert.rejects(work,refused); await waiting; controller.abort('PRIVATE REASON'); await rejected;
  give(source); await new Promise((yes) => setImmediate(yes)); assert.equal(source.destroyed,true); assert.equal(f.calls.length,0);
});
test('pipeline deadline kills and cleans its active file namespace before releasing the slot',async (t) => {
  const options = { stall:true },f = await fixture(t,{},options,{ timeoutMilliseconds:150 });
  await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  assert.equal(f.containers.size,0); assert.ok(f.calls.some((args) => args[0] === 'kill')); options.stall = false;
  const result = await f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }); assert.equal(result.status,'prepared'); result.bytes.fill(0);
});
test('bounded pipeline capacity rejects rather than queues and active cancellation has no duplicate job',async (t) => {
  let started; const entered = new Promise((yes) => { started = yes; });
  const f = await fixture(t,{}, { stall:true,started },{ maxConcurrent:1 }),controller = new AbortController();
  const pending = assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) },{ signal:controller.signal }),refused);
  await entered; await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  controller.abort(); await pending; assert.equal(f.calls.filter((args) => args[0] === 'create').length,1); assert.equal(f.containers.size,0);
});
test('cleanup failure retains a job and prevents a new candidate until explicit recovery',async (t) => {
  const options = { rmFails:true },f = await fixture(t,{},options);
  await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  assert.equal(f.preparer.retainedJobs().length,1); const count = f.calls.filter((args) => args[0] === 'create').length;
  await assert.rejects(f.pipeline.prepare({ ...file,openSource:() => stream(bytes) }),refused);
  assert.equal(f.calls.filter((args) => args[0] === 'create').length,count); options.rmFails = false; await f.preparer.recoverRetained(); assert.equal(f.containers.size,0);
});

test('finite stage observation follows both scans and real coordinator cleanup without returning file data',async (t) => {
  const events = [],cleanupSnapshots = [],f = await fixture(t,{}, {},{onStage:(event) => {
    events.push(event);
    if (event.stage === 'isolated-preparation' && event.edge === 'complete') cleanupSnapshots.push(f.containers.size);
  }});
  const result = await f.pipeline.prepare({...file,openSource:() => stream(bytes)});
  assert.equal(result.status,'prepared');
  assert.deepEqual(cleanupSnapshots,[0]);
  assert.deepEqual(events,['source-open','source-scan','source-reopen','isolated-preparation','candidate-validation','candidate-scan']
    .flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}]));
  for (const event of events) { assert.ok(Object.isFrozen(event)); assert.deepEqual(Object.keys(event),['stage','edge']); }
  assert.equal(JSON.stringify(events).includes(file.sha256),false); result.bytes.fill(0);
});

test('source rejection stops later stage observations without treating scan completion as approval',async (t) => {
  const events = [],f = await fixture(t,{rejectAt:1},{},{onStage:(event) => events.push(event)});
  const result = await f.pipeline.prepare({...file,openSource:() => stream(bytes)});
  assert.equal(result.status,'rejected'); assert.equal(result.mediaAcceptanceReady,false);
  assert.deepEqual(events,['source-open','source-scan'].flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}]));
  assert.equal(f.containers.size,0); assert.equal(f.calls.length,0);
});

test('a private source error marks only the failed stage while preserving public error redaction',async (t) => {
  const events = [],f = await fixture(t,{},{},{onStage:(event) => { events.push(event); throw new Error('PRIVATE OBSERVER'); }});
  await assert.rejects(f.pipeline.prepare({...file,openSource() { throw new Error('PRIVATE STORAGE'); }}),refused);
  assert.deepEqual(events,[{stage:'source-open',edge:'begin'},{stage:'source-open',edge:'failed'}]);
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false); assert.equal(f.calls.length,0);
});

test('rejected observers cannot change a prepared result or hold a coordinator slot',async (t) => {
  const config = {maxConcurrent:1,onStage:() => Promise.reject(new Error('PRIVATE OBSERVER'))};
  let changedCalls = 0;
  const f = await fixture(t,{},{},config); config.onStage = () => changedCalls++;
  for (let i = 0; i < 2; i++) {
    const result = await f.pipeline.prepare({...file,openSource:() => stream(bytes)});
    assert.equal(result.status,'prepared'); assert.equal(f.containers.size,0); result.bytes.fill(0);
  }
  await new Promise((yes) => setImmediate(yes));
  assert.equal(changedCalls,0);
});
