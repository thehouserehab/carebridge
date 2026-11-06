import assert from 'node:assert/strict';
import { before,beforeEach,after,test } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { MediaWorkQueueWorker } from '../media-work-queue-worker.mjs';
import { runMediaWorkerProcess } from '../media-worker-process.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { hash,candidate,FixturePreparation } from './media-storage-fixtures.mjs';
const actor = { centerId:'lifecycle-center',userId:'lifecycle-guardian' };
const bytes = syntheticPng(),file = { name:'private-synthetic.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
const unavailable = { code:'MEDIA_WORKER_UNAVAILABLE' };
let db,directory,root,store,pipeline,uploads,worker,recoveries;
const query = (sql,args) => db.query(sql,args);
const rowFor = async (id) => (await query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
const jobFor = async (id) => (await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
const createWorker = () => new MediaWorkQueueWorker(uploads,{ localTestMode:true,pollMilliseconds:50 });
async function receive() {
  const row = await uploads.reserve(actor,{ conversationId:'lifecycle-room',clientId:randomUUID(),file });
  return uploads.receive(actor,{ conversationId:'lifecycle-room',uploadId:row.id,expectedVersion:row.version },Readable.from([bytes],{ objectMode:false }));
}
async function waitUntil(check) {
  const deadline = Date.now()+3000;
  while (!check()) { if (Date.now()>deadline) throw new Error('TEST_WAIT_TIMEOUT'); await delay(5); }
}
function heldPreparation() {
  const entered = Promise.withResolvers(),release = Promise.withResolvers();
  pipeline.work = async (source) => { entered.resolve(); await release.promise; return candidate(source); };
  return { entered:entered.promise,release:release.resolve };
}
before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-lifecycle-test-')); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('lifecycle-center'); INSERT INTO cb_users(id,active) VALUES ('lifecycle-guardian',true);
    INSERT INTO cb_memberships VALUES ('lifecycle-center','lifecycle-guardian','guardian',true);
    INSERT INTO cb_children VALUES ('lifecycle-center','lifecycle-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('lifecycle-center','lifecycle-room','lifecycle-child');
    INSERT INTO cb_participants VALUES ('lifecycle-center','lifecycle-room','lifecycle-guardian','guardian',true,1);`);
  await configureSyntheticMediaPolicy(db,'lifecycle-center');
  root = join(directory,randomUUID()); store = new PrivateFileStore(root); recoveries = 0;
  pipeline = new FixturePreparation(); pipeline.recoverRetained = async () => { recoveries++; };
  uploads = new MediaUploads(db,store,{ preparation:pipeline }); worker = createWorker();
});
after(async () => {
  await db?.close(); const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-lifecycle-test-'));
  await rm(target,{ recursive:true,force:true });
});

test('construction and immutable snapshots expose no file account or clinical data and do not start work',async () => {
  const status = worker.status; assert.equal(status.state,'new'); assert.equal(status.startedAt,null); assert.equal(recoveries,0);
  assert.equal(status.inFlight,false); assert.equal(status.loopRunning,false); assert(Object.isFrozen(status));
  assert.throws(() => { status.state = 'approved'; },TypeError);
  await worker.runOne(); assert.equal(status.state,'new'); assert.equal(worker.status.completedPolls,1);
  assert.deepEqual(Object.keys(status).sort(),['cleanupFailures','completedPolls','failureCode','inFlight','lastOutcome',
    'lastPollCompletedAt','loopRunning','phase','processed','startedAt','state','stoppedAt'].sort());
});
test('one idle poll checks recovery before and after dispatch and leaves a stopped local observation',async () => {
  assert.deepEqual(await worker.runOne(),{ status:'idle' }); assert.equal(recoveries,2);
  const status = worker.status; assert.equal(status.state,'stopped'); assert.equal(status.phase,null);
  assert.equal(status.processed,0); assert.equal(status.completedPolls,1); assert.equal(status.lastOutcome,null);
  for (const key of ['startedAt','lastPollCompletedAt','stoppedAt']) assert.equal(new Date(status[key]).toISOString(),status[key]);
});
test('a settled file increments the outcome counters without serializing its identifiers or manifest',async () => {
  const row = await receive(),result = await worker.runOne(); assert.equal(result.upload.id,row.id);
  assert.equal(worker.status.processed,1); assert.equal(worker.status.lastOutcome,'ready'); assert.equal(recoveries,2);
  const serialized = JSON.stringify(worker.status);
  for (const secret of [row.id,file.name,file.sha256,actor.userId,actor.centerId,'lifecycle-room']) assert(!serialized.includes(secret));
  await worker.runOne(); assert.equal(worker.status.lastOutcome,'ready'); assert.equal(worker.status.completedPolls,2);
});
test('an idle loop cannot be interleaved with an external poll and closes only on an explicit signal',async () => {
  const controller = new AbortController(),loop = worker.start({ signal:controller.signal });
  try {
    await waitUntil(() => worker.status.phase === 'idle'); assert.equal(worker.status.loopRunning,true);
    await assert.rejects(worker.runOne(),unavailable); await assert.rejects(worker.start({ signal:controller.signal }),unavailable);
    assert.equal(worker.status.failureCode,null); controller.abort();
    assert.deepEqual(await loop,{ stopped:true,processed:0 }); assert.equal(worker.status.loopRunning,false);
  } finally { controller.abort(); await loop; }
});
test('abort at a resolved recovery checkpoint is clean and consumes no upload attempt',async () => {
  const row = await receive(),entered = Promise.withResolvers(),release = Promise.withResolvers(),controller = new AbortController();
  pipeline.recoverRetained = async () => { recoveries++; entered.resolve(); await release.promise; };
  const loop = worker.start({ signal:controller.signal });
  try { await entered.promise; controller.abort(); assert.equal(worker.status.state,'stopping'); release.resolve();
    assert.deepEqual(await loop,{ stopped:true,processed:0 }); assert.equal((await jobFor(row.id)).attempts,0);
    assert.equal(worker.status.state,'stopped'); assert.equal(worker.status.completedPolls,0);
  } finally { controller.abort(); release.resolve(); await loop; }
});
test('a recovery error coinciding with abort is a fault rather than a false graceful stop',async () => {
  const row = await receive(),controller = new AbortController();
  pipeline.recoverRetained = async () => { controller.abort(); throw new Error('private engine diagnostics'); };
  await assert.rejects(worker.start({ signal:controller.signal }),unavailable);
  assert.equal(worker.status.state,'failed'); assert.equal(worker.status.phase,'recovering');
  assert.equal(worker.status.failureCode,'MEDIA_WORKER_UNAVAILABLE'); assert.equal((await jobFor(row.id)).attempts,0);
  assert(!JSON.stringify(worker.status).includes('private engine')); assert.equal(worker.status.inFlight,false);
});
test('a maintenance DB error coinciding with abort is not suppressed',async () => {
  const row = await receive(),controller = new AbortController();
  uploads.cleanup = async () => { controller.abort(); throw new Error('private database detail'); };
  await assert.rejects(worker.start({ signal:controller.signal }),unavailable);
  assert.equal(worker.status.state,'failed'); assert.equal(worker.status.phase,'cleanup'); assert.equal((await jobFor(row.id)).attempts,0);
});
test('active stop awaits preparation settlement and post-work recovery before reporting stopped',async () => {
  const row = await receive(),held = heldPreparation(),controller = new AbortController(); let closed = false;
  const loop = worker.start({ signal:controller.signal }).finally(() => { closed = true; });
  try {
    await held.entered; controller.abort(); await delay(25); assert.equal(closed,false);
    assert.equal(worker.status.state,'stopping'); assert.equal(worker.status.phase,'inspection'); assert.equal(worker.status.inFlight,true);
    held.release(); assert.deepEqual(await loop,{ stopped:true,processed:1 }); assert.equal(recoveries,2);
    assert.equal((await jobFor(row.id)).state,'retry'); assert.equal((await rowFor(row.id)).state,'quarantined');
    assert.equal(worker.status.lastOutcome,'quarantined'); assert.equal(worker.status.state,'stopped');
    assert.deepEqual(await readFile(join(root,`${(await rowFor(row.id)).object_key}.blob`)),bytes);
  } finally { controller.abort(); held.release(); await loop; }
});
test('settlement rollback after abort fails the loop and keeps the durable running lease for recovery',async () => {
  const row = await receive(),held = heldPreparation(),controller = new AbortController();
  await db.exec(`CREATE FUNCTION cb_lifecycle_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state = 'retry' THEN RAISE EXCEPTION 'synthetic settlement failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_lifecycle_fault BEFORE UPDATE ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_lifecycle_fault();`);
  const loop = worker.start({ signal:controller.signal }); const rejected = assert.rejects(loop,unavailable);
  try {
    await held.entered; controller.abort(); held.release(); await rejected;
    assert.equal(worker.status.state,'failed'); assert.equal(worker.status.phase,'inspection'); assert.equal(recoveries,2);
    assert.equal((await jobFor(row.id)).state,'running'); assert.equal((await rowFor(row.id)).state,'inspecting');
    assert.equal(worker.status.completedPolls,0);
  } finally { controller.abort(); held.release(); await rejected; await db.exec('DROP TRIGGER cb_lifecycle_fault ON cb_media_work_queue; DROP FUNCTION cb_lifecycle_fault();'); }
});
test('unresolved post-inspection decoder recovery is a fault even when quarantine and stop are already requested',async () => {
  const row = await receive(),held = heldPreparation(),controller = new AbortController();
  pipeline.recoverRetained = async () => { if (++recoveries > 1) throw new Error('private retained namespace'); };
  const loop = worker.start({ signal:controller.signal }),rejected = assert.rejects(loop,unavailable);
  try {
    await held.entered; controller.abort(); held.release(); await rejected;
    assert.equal((await jobFor(row.id)).state,'retry'); assert.equal(worker.status.state,'failed');
    assert.equal(worker.status.phase,'verification'); assert.equal(worker.status.completedPolls,0);
  } finally { controller.abort(); held.release(); await rejected; }
});
test('explicit retry after a fault rechecks retained work and does not mutate a prior failed snapshot',async () => {
  pipeline.recoverRetained = async () => { throw new Error('synthetic recovery failure'); };
  await assert.rejects(worker.runOne(),unavailable); const failed = worker.status;
  pipeline.recoverRetained = async () => { recoveries++; };
  assert.deepEqual(await worker.runOne(),{ status:'idle' }); assert.equal(recoveries,2);
  assert.equal(worker.status.state,'stopped'); assert.equal(worker.status.failureCode,null); assert.equal(failed.state,'failed');
});
test('invalid and pre-aborted single-poll inputs have no IO or false lifecycle side effects',async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(worker.runOne({ signal:controller.signal }),unavailable);
  await assert.rejects(worker.runOne({ signal:{} }),unavailable); await assert.rejects(worker.start(),unavailable);
  assert.equal(worker.status.state,'new'); assert.equal(recoveries,0);
  assert.deepEqual(await worker.start({ signal:controller.signal }),{ stopped:true,processed:0 }); assert.equal(recoveries,0);
});
test('failed physical cleanup is counted without claiming deletion or failing an otherwise idle poll',async () => {
  const row = await receive(),dbRow = await rowFor(row.id);
  await uploads.cancel(actor,{ conversationId:'lifecycle-room',uploadId:row.id,expectedVersion:dbRow.version });
  store.remove = async () => { throw new Error('synthetic IO failure'); };
  assert.deepEqual(await worker.runOne(),{ status:'idle' }); assert(worker.status.cleanupFailures > 0);
  assert.notEqual((await rowFor(row.id)).state,'deleted'); assert.equal(worker.status.failureCode,null);
});
test('dedicated process runner handles repeated SIGTERM and SIGINT without force exit and restores its listeners',async () => {
  const target = new EventEmitter(),pending = runMediaWorkerProcess(worker,{ targetProcess:target });
  try {
    await waitUntil(() => worker.status.phase === 'idle'); assert.equal(target.listenerCount('SIGTERM'),1);
    target.emit('SIGTERM'); target.emit('SIGINT'); target.emit('SIGTERM');
    assert.deepEqual(await pending,{ stopped:true,processed:0 }); assert.equal(target.exitCode,undefined);
    assert.equal(target.listenerCount('SIGTERM'),0); assert.equal(target.listenerCount('SIGINT'),0);
  } finally { target.emit('SIGTERM'); await pending; }
});
test('process runner rejects concurrent registration and foreign handlers without disrupting the owner',async () => {
  const target = new EventEmitter(),pending = runMediaWorkerProcess(worker,{ targetProcess:target });
  try { await waitUntil(() => worker.status.phase === 'idle');
    await assert.rejects(runMediaWorkerProcess(createWorker(),{ targetProcess:target }),unavailable);
    assert.equal(target.listenerCount('SIGTERM'),1); target.emit('SIGTERM'); await pending;
  } finally { target.emit('SIGTERM'); await pending; }
  const foreign = () => {}; target.on('SIGINT',foreign);
  await assert.rejects(runMediaWorkerProcess(worker,{ targetProcess:target }),unavailable);
  assert.equal(target.listenerCount('SIGINT'),1); assert.equal(target.exitCode,undefined);
});
test('process runner fault preserves a pre-existing nonzero exit code and removes its handlers',async () => {
  const target = new EventEmitter(); target.exitCode = 7;
  pipeline.recoverRetained = async () => { throw new Error('private engine error'); };
  await assert.rejects(runMediaWorkerProcess(worker,{ targetProcess:target }),unavailable);
  assert.equal(target.exitCode,7); assert.equal(target.listenerCount('SIGTERM'),0); assert.equal(target.listenerCount('SIGINT'),0);
});
test('partial process handler registration fails safely with nonzero exit and releases ownership',async () => {
  const target = new EventEmitter(),on = target.on; let reject = true;
  target.on = function (name,handler) { if (name === 'SIGINT' && reject) throw new Error('synthetic registration failure'); return on.call(this,name,handler); };
  await assert.rejects(runMediaWorkerProcess(worker,{ targetProcess:target }),unavailable);
  assert.equal(target.exitCode,1); assert.equal(target.listenerCount('SIGTERM'),0);
  reject = false; const pending = runMediaWorkerProcess(worker,{ targetProcess:target });
  try { await waitUntil(() => worker.status.phase === 'idle'); target.emit('SIGINT'); await pending; }
  finally { target.emit('SIGTERM'); await pending; }
  assert.equal(target.exitCode,1); // A success must not erase a previous process fault.
});

test('idle poll stages are finite and rejected observers do not alter recovery or dispatch',async () => {
  const events = [],onStage = (event) => { events.push(event); return Promise.reject(new Error('PRIVATE OBSERVER')); };
  const observedUploads = new MediaUploads(db,store,{preparation:pipeline,onStage});
  const observed = new MediaWorkQueueWorker(observedUploads,{localTestMode:true,pollMilliseconds:50,onStage});
  assert.deepEqual(await observed.runOne(),{status:'idle'}); assert.equal(recoveries,2);
  assert.deepEqual(events,['retained-recovery','object-cleanup','queue-claim','retained-recovery']
    .flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}]));
  assert.equal(observed.status.completedPolls,1); assert.equal(observed.status.failureCode,null);
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
});

test('cleanup stage remains active until the actual cleanup promise resolves',async () => {
  const entered = Promise.withResolvers(),release = Promise.withResolvers(),events = []; let done = false,changedCalls = 0;
  uploads.cleanup = async () => { entered.resolve(); await release.promise; return {removed:0,failed:0,finalized:0}; };
  const options = {localTestMode:true,pollMilliseconds:50,onStage:(event) => events.push(event)};
  const observed = new MediaWorkQueueWorker(uploads,options); options.onStage = () => changedCalls++;
  const pending = observed.runOne().finally(() => { done = true; });
  try {
    await entered.promise; assert.equal(done,false); assert.equal(observed.status.inFlight,true);
    assert.deepEqual(events.at(-1),{stage:'object-cleanup',edge:'begin'});
    release.resolve(); assert.deepEqual(await pending,{status:'idle'});
    assert.ok(events.some((event) => event.stage === 'object-cleanup' && event.edge === 'complete'));
    assert.equal(changedCalls,0);
  } finally { release.resolve(); await pending; }
});

test('recovery failure is still a worker failure when its observer also throws',async () => {
  const events = [];
  pipeline.recoverRetained = async () => { throw new Error('PRIVATE RETAINED ENGINE'); };
  const observed = new MediaWorkQueueWorker(uploads,{localTestMode:true,pollMilliseconds:50,onStage:(event) => {
    events.push(event); throw new Error('PRIVATE OBSERVER');
  }});
  await assert.rejects(observed.runOne(),unavailable);
  assert.deepEqual(events,[{stage:'retained-recovery',edge:'begin'},{stage:'retained-recovery',edge:'failed'}]);
  assert.equal(observed.status.state,'failed'); assert.equal(observed.status.phase,'recovering');
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
});
