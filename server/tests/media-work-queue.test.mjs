import assert from 'node:assert/strict';
import { before,beforeEach,after,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,mkdir,copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { MediaWorkQueueWorker } from '../media-work-queue-worker.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { RepositoryError } from '../errors.mjs';
import { DecoderJobJournal } from '../decoder-journal.mjs';
import { MediaPreparation } from '../media-preparation.mjs';
import { LocalClamAvClient } from '../clamav-client.mjs';
import { fakePreparation } from './media-preparation-fixtures.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { candidate,hash,FixturePreparation,evidenceForManifest,sealFixture } from './media-storage-fixtures.mjs';

// Actual private disk + PGlite; preparation is a declared synthetic fixture.
// Native scanner/decoder and multi-connection/process proof are separate tests.
const owner = { centerId:'queue-center',userId:'queue-guardian' };
const bytes = syntheticPng(),file = { name:'synthetic.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
const input = (row) => ({ conversationId:row.conversationId ?? row.conversation_id,uploadId:row.id,expectedVersion:row.version });
let db,directory,root,store,pipeline,uploads,worker,number,calls;
const createWorker = (service = uploads,options = {}) => new MediaWorkQueueWorker(service,{ localTestMode:true,...options });
const rowFor = async (id) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
const jobFor = async (id) => (await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
const proofCount = async () => (await db.query('SELECT count(*)::int AS n FROM cb_media_preparations')).rows[0].n;
const waitFor = async (when) => delay(Math.max(0,new Date(when).getTime()-Date.now()+30));
const failCode = (expected) => (error) => error instanceof RepositoryError && error.code === expected;
async function receive(service = uploads,actor = owner,room = 'queue-room') {
  const pending = await service.reserve(actor,{ conversationId:room,clientId:`synthetic-queue-${++number}-0001`,file });
  return service.receive(actor,input(pending),Readable.from([bytes],{ objectMode:false }));
}
before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-queue-test-')); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('queue-center');
    INSERT INTO cb_users(id,active) VALUES ('queue-guardian',true),('queue-therapist',true);
    INSERT INTO cb_memberships VALUES ('queue-center','queue-guardian','guardian',true),('queue-center','queue-therapist','therapist',true);
    INSERT INTO cb_children VALUES ('queue-center','queue-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('queue-center','queue-room','queue-child');
    INSERT INTO cb_participants VALUES ('queue-center','queue-room','queue-guardian','guardian',true,1),('queue-center','queue-room','queue-therapist','therapist',true,1);`);
  root = join(directory,randomUUID()); store = new PrivateFileStore(root); calls = 0; number = 0;
  await configureSyntheticMediaPolicy(db,'queue-center');
  pipeline = new FixturePreparation(async (sourceBytes) => { calls++; assert.deepEqual(sourceBytes,bytes); return candidate(sourceBytes); });
  uploads = new MediaUploads(db,store,{ preparation:pipeline }); worker = createWorker(uploads,{ pollMilliseconds:50 });
});
after(async () => {
  await db?.close(); const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-queue-test-'));
  await rm(target,{ recursive:true,force:true });
});

test('receipt creates one durable minimal job and an independent worker processes the exact existing upload',async () => {
  const pending = await uploads.reserve(owner,{ conversationId:'queue-room',clientId:'synthetic-queue-reserve-01',file });
  assert.equal(await jobFor(pending.id),undefined); assert.equal(calls,0);
  const state = await uploads.receive(owner,input(pending),Readable.from([bytes],{ objectMode:false })),job = await jobFor(state.id);
  assert.equal(job.state,'queued'); assert.equal(job.attempts,0); assert.equal(job.upload_version,state.version);
  for (const secret of ['name','sha256','password','user_id','bytes','evidence','body']) assert.equal(Object.hasOwn(job,secret),false);
  const restarted = createWorker(new MediaUploads(db,new PrivateFileStore(root),{ preparation:pipeline }));
  const result = await restarted.runOne(); assert.equal(result.status,'processed'); assert.equal(result.upload.id,state.id); assert.equal(result.upload.state,'ready');
  const completed = await jobFor(state.id); assert.equal(completed.state,'completed'); assert.equal(completed.outcome,'ready');
  assert.equal(completed.upload_version,result.upload.version); assert.equal(completed.attempts,1); assert.equal(await proofCount(),1);
  assert.equal(calls,1); assert.deepEqual(await restarted.runOne(),{ status:'idle' });
});

test('queue insert failure rolls back receipt and event rather than stranding unqueued quarantine',async () => {
  const service = new MediaUploads(db,store,{ preparation:pipeline,leaseMilliseconds:300,operationTimeoutMilliseconds:150 });
  const pending = await service.reserve(owner,{ conversationId:'queue-room',clientId:'synthetic-queue-rollback-01',file });
  await db.exec(`CREATE FUNCTION cb_queue_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$;
    CREATE TRIGGER cb_queue_insert_failure BEFORE INSERT ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_queue_insert_failure();`);
  try { await assert.rejects(service.receive(owner,input(pending),Readable.from([bytes],{ objectMode:false }))); }
  finally { await db.exec('DROP TRIGGER cb_queue_insert_failure ON cb_media_work_queue; DROP FUNCTION cb_queue_insert_failure();'); }
  const claimed = await rowFor(pending.id); assert.equal(claimed.state,'receiving'); assert.equal(await jobFor(pending.id),undefined);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_media_events WHERE upload_id = $1 AND state = 'quarantined'",[pending.id])).rows[0].n,0);
  await waitFor(claimed.lease_until); const retry = await service.receive(owner,input(claimed),Readable.from([bytes],{ objectMode:false }));
  assert.equal(retry.state,'quarantined'); assert.equal((await jobFor(pending.id)).state,'queued');
});

test('transient failure backs off on the DB clock and resumes without a duplicate upload or candidate',async () => {
  const row = await receive(); let failures = 1;
  pipeline.prepare = async () => { calls++; if (failures--) throw new Error('private diagnostics must not escape'); return candidate(bytes); };
  const failed = await worker.runOne(); assert.equal(failed.upload.state,'quarantined');
  const job = await jobFor(row.id); assert.equal(job.state,'retry'); assert.equal(job.attempts,1); assert.equal(job.failure_code,'SCAN_UNAVAILABLE');
  assert(new Date(job.available_at)-new Date(job.updated_at) >= 1000); assert.deepEqual(await worker.runOne(),{ status:'idle' }); assert.equal(calls,1);
  await waitFor(job.available_at); const done = await worker.runOne(); assert.equal(done.upload.id,row.id); assert.equal(done.upload.state,'ready');
  assert.equal((await jobFor(row.id)).attempts,2); assert.equal(await proofCount(),1); assert.equal(calls,2);
});

test('five failed attempts block automatic and manual sixth attempts without deleting the original',async () => {
  let row = await receive(); pipeline.prepare = async () => { calls++; throw new RepositoryError('SCAN_INVALID'); };
  for (let attempt = 1; attempt <= 5; attempt++) { row = await uploads.inspect(owner,input(row)); assert.equal((await jobFor(row.id)).attempts,attempt); }
  const job = await jobFor(row.id),source = await rowFor(row.id); assert.equal(job.state,'blocked'); assert.equal(job.failure_code,'ATTEMPTS_EXHAUSTED');
  assert.deepEqual(await readFile(join(root,`${source.object_key}.blob`)),bytes); assert.equal(calls,5);
  await assert.rejects(uploads.inspect(owner,input(row)),failCode('UPLOAD_ATTEMPTS_EXHAUSTED')); assert.deepEqual(await worker.runOne(),{ status:'idle' });
  await uploads.cancel(owner,input(row)); await uploads.cleanup(); assert.equal((await jobFor(row.id)).state,'cancelled');
});

test('abandoned claim is recovered by a new instance with a fresh lease and candidate, never stale settlement',async () => {
  const service = new MediaUploads(db,store,{ preparation:pipeline,leaseMilliseconds:300,operationTimeoutMilliseconds:150 });
  const received = await receive(service),old = await service.claimNextInspection(); assert.equal(old.claimed.id,received.id);
  assert.equal((await jobFor(received.id)).state,'running'); assert.equal(await service.claimNextInspection(),null);
  await waitFor(old.claimed.lease_until); const restarted = createWorker(new MediaUploads(db,store,{ preparation:pipeline }));
  assert.deepEqual(await restarted.runOne(),{ status:'idle' }); const recovered = await jobFor(received.id); assert.equal(recovered.state,'retry');
  assert.equal((await readdir(root)).includes(`${old.claimed.candidate_key}.blocked`),true);
  await assert.rejects(service.settle(owner,'queue-room',old.claimed,{ state:'quarantined' }),failCode('UPLOAD_CONFLICT'));
  await waitFor(recovered.available_at); const done = await restarted.runOne(),row = await rowFor(received.id);
  assert.equal(done.upload.state,'ready'); assert.notEqual(row.candidate_key,old.claimed.candidate_key); assert.equal((await jobFor(row.id)).attempts,2);
  assert.equal(await proofCount(),1);
});

test('owner deactivation skips the private job while an authorized different owner can progress',async () => {
  const denied = await receive(),therapist = { centerId:owner.centerId,userId:'queue-therapist' },allowed = await receive(uploads,therapist);
  await db.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]);
  const result = await worker.runOne(); assert.equal(result.upload.id,allowed.id); assert.equal(result.upload.state,'ready');
  assert.equal((await jobFor(denied.id)).state,'queued'); assert.equal((await jobFor(denied.id)).attempts,0); assert.equal(calls,1);
});

test('revoked authorization during preparation cannot commit ready or completed work',async () => {
  const row = await receive(),entered = Promise.withResolvers(),release = Promise.withResolvers();
  pipeline.prepare = async () => { entered.resolve(); await release.promise; return candidate(bytes); };
  const pending = worker.runOne().then((value) => ({ value }),(error) => ({ error }));
  await entered.promise; await db.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]); release.resolve();
  assert.equal((await pending).error?.code,'MEDIA_WORKER_UNAVAILABLE'); assert.equal((await rowFor(row.id)).state,'inspecting');
  assert.equal((await jobFor(row.id)).state,'running'); assert.equal(await proofCount(),0);
});

test('queued expiry is cancelled by maintenance even after user access is removed',async () => {
  const service = new MediaUploads(db,store,{ preparation:pipeline,ttlMilliseconds:600,leaseMilliseconds:300,operationTimeoutMilliseconds:150 });
  const row = await receive(service); await db.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]); await waitFor(row.expiresAt);
  assert.deepEqual(await createWorker(service).runOne(),{ status:'idle' });
  assert.equal((await jobFor(row.id)).state,'cancelled'); assert.equal((await rowFor(row.id)).state,'deleted'); assert.equal(calls,0);
});

test('user cancellation fences an in-flight candidate and no background worker resurrects it',async () => {
  const row = await receive(),entered = Promise.withResolvers(),release = Promise.withResolvers();
  pipeline.prepare = async () => { entered.resolve(); await release.promise; return candidate(bytes); };
  const pending = worker.runOne().then((value) => ({ value }),(error) => ({ error }));
  await entered.promise; const claimed = await rowFor(row.id); await uploads.cancel(owner,input(claimed)); await uploads.cleanup(); release.resolve();
  assert.equal((await pending).error?.code,'MEDIA_WORKER_UNAVAILABLE'); assert.equal((await jobFor(row.id)).state,'cancelled');
  assert.equal((await rowFor(row.id)).state,'deleted'); assert.equal(await proofCount(),0); assert.deepEqual(await worker.runOne(),{ status:'idle' });
});

test('ready and completed queue outcome survive lost commit acknowledgment without another preparation',async () => {
  const row = await receive(); let lose = true;
  const database = { transaction:async (work) => { const result = await db.transaction(work);
    if (lose && result?.state === 'ready') { lose = false; throw new Error('private connection detail'); } return result; } };
  const restarted = createWorker(new MediaUploads(database,store,{ preparation:pipeline }));
  await assert.rejects(restarted.runOne(),failCode('MEDIA_WORKER_UNAVAILABLE'));
  assert.equal((await jobFor(row.id)).state,'completed'); assert.equal((await rowFor(row.id)).state,'ready');
  assert.deepEqual(await worker.runOne(),{ status:'idle' }); assert.equal(calls,1); assert.equal(await proofCount(),1);
});

test('DB approval failure rolls back completed queue outcome with proof and ready',async () => {
  const row = await receive();
  await db.exec(`CREATE FUNCTION cb_queue_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_queue_completion_failure BEFORE UPDATE ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_queue_completion_failure();`);
  try { await assert.rejects(worker.runOne(),failCode('MEDIA_WORKER_UNAVAILABLE')); }
  finally { await db.exec('DROP TRIGGER cb_queue_completion_failure ON cb_media_work_queue; DROP FUNCTION cb_queue_completion_failure();'); }
  assert.equal((await jobFor(row.id)).state,'running'); assert.equal((await rowFor(row.id)).state,'inspecting'); assert.equal(await proofCount(),0);
});

test('queue guards reject identity changes attempt reset false completion and removal',async () => {
  const row = await receive();
  for (const sql of ["UPDATE cb_media_work_queue SET state = 'completed'","UPDATE cb_media_work_queue SET attempts = 1",
    "UPDATE cb_media_work_queue SET available_at = clock_timestamp() - interval '1 day'","UPDATE cb_media_work_queue SET source_key = upload_id",
    'DELETE FROM cb_media_work_queue']) await assert.rejects(db.query(sql));
  assert.equal((await jobFor(row.id)).attempts,0);
  await worker.runOne(); await assert.rejects(db.query("UPDATE cb_media_work_queue SET attempts = 0"));
  assert.equal((await jobFor(row.id)).outcome,'ready');
});

test('unresolved decoder recovery blocks dispatch before consuming an attempt',async () => {
  const row = await receive(); pipeline.recoverRetained = async () => { throw new Error('private engine diagnostic'); };
  await assert.rejects(worker.runOne(),failCode('MEDIA_WORKER_UNAVAILABLE')); assert.equal((await jobFor(row.id)).attempts,0);
  assert.equal((await rowFor(row.id)).state,'quarantined'); assert.equal(calls,0);
});

test('worker is explicit bounded and non-reentrant; an aborted idle loop stops without consuming work',async () => {
  assert.throws(() => createWorker(new MediaUploads(db,store)),TypeError);
  assert.equal(pipeline.hasDurableJournal(),false);
  assert.throws(() => new MediaWorkQueueWorker(uploads),TypeError);
  assert.throws(() => createWorker(uploads,{ localTestMode:'true' }),TypeError);
  for (const value of [0,49,60001,'1000']) assert.throws(() => createWorker(uploads,{ pollMilliseconds:value }),TypeError);
  await assert.rejects(worker.start(),failCode('MEDIA_WORKER_UNAVAILABLE'));
  const controller = new AbortController(),loop = worker.start({ signal:controller.signal }); await delay(20);
  await assert.rejects(worker.start({ signal:controller.signal }),failCode('MEDIA_WORKER_UNAVAILABLE'));
  controller.abort(); assert.deepEqual(await loop,{ stopped:true,processed:0 });
  const row = await receive(); await assert.rejects(worker.runOne({ signal:controller.signal }),failCode('MEDIA_WORKER_UNAVAILABLE'));
  assert.equal((await jobFor(row.id)).attempts,0);
});

test('ordinary worker configuration requires a real matching durable decoder journal and never starts itself',async () => {
  const fake = fakePreparation(),engineIdentity = await fake.runtime.identity(),approvedImageId = (await fake.runtime.inspect('image','synthetic')).Id;
  const journal = new DecoderJobJournal(db,{ engineIdentity,approvedImageId });
  const preparer = fakePreparation({ config:{ journal } }).preparer;
  const scanner = new LocalClamAvClient({ endpoint:{ host:'127.0.0.1',port:65535 },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC' });
  const guarded = new MediaPreparation({ scanner,preparer }); assert.equal(guarded.hasDurableJournal(),true);
  const configured = new MediaWorkQueueWorker(new MediaUploads(db,store,{ preparation:guarded }));
  assert(configured instanceof MediaWorkQueueWorker);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_decoder_jobs')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_work_queue')).rows[0].n,0);
});

test('graceful worker stop drains the active preparation before returning and preserves a retryable original',async () => {
  const row = await receive(),entered = Promise.withResolvers(),release = Promise.withResolvers(),controller = new AbortController();
  let stopped = false; pipeline.prepare = async () => { entered.resolve(); await release.promise; return candidate(bytes); };
  const loop = worker.start({ signal:controller.signal }).finally(() => { stopped = true; });
  await entered.promise; controller.abort(); await delay(30); assert.equal(stopped,false);
  await assert.rejects(worker.runOne(),failCode('MEDIA_WORKER_UNAVAILABLE')); release.resolve();
  const result = await loop; assert.equal(result.stopped,true); assert.equal((await rowFor(row.id)).state,'quarantined');
  assert.equal((await jobFor(row.id)).state,'retry'); assert.equal(await proofCount(),0);
});

test('014 backfills only private pending work without changing historical approval evidence or manifests',async () => {
  const legacy = await PGlite.create(),migrationRoot = join(directory,'legacy-migrations');
  try {
    await mkdir(migrationRoot);
    const files = (await readdir(new URL('../migrations/',import.meta.url))).filter((name) => name.endsWith('.sql') && name < '014-');
    for (const name of files) await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrationRoot,name));
    await migrate(legacy,pathToFileURL(`${migrationRoot}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('legacy-queue-center'); INSERT INTO cb_users(id,active) VALUES ('legacy-queue-owner',true);
      INSERT INTO cb_memberships VALUES ('legacy-queue-center','legacy-queue-owner','guardian',true);
      INSERT INTO cb_children VALUES ('legacy-queue-center','legacy-queue-child');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('legacy-queue-center','legacy-queue-room','legacy-queue-child');
      INSERT INTO cb_participants VALUES ('legacy-queue-center','legacy-queue-room','legacy-queue-owner','guardian',true,1);`);
    const source = { type:'image/png',size:32,sha256:'a'.repeat(64) },ids = [];
    for (const state of ['quarantined','inspecting','ready']) await legacy.transaction(async (tx) => {
      const id = randomUUID(),sourceKey = randomUUID(),candidateKey = randomUUID(),lease = randomUUID(); ids.push(id);
      await tx.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ('legacy-queue-center','legacy-queue-room',$1,'legacy-queue-owner',$1,repeat('b',64),'synthetic.png',$2,$3,$4,1,clock_timestamp()+interval '1 hour')`,
      [id,source.type,source.size,source.sha256]);
      await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'legacy-queue-center','legacy-queue-room',$2)`,[sourceKey,id]);
      await tx.query(`UPDATE cb_media_uploads SET state = 'receiving',version = 2,object_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '5 minutes' WHERE id = $1`,[id,sourceKey,lease]);
      await tx.query(`UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1`,[id]);
      if (state !== 'quarantined') {
        await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'legacy-queue-center','legacy-queue-room',$2)`,[candidateKey,id]);
        const row = (await tx.query(`UPDATE cb_media_uploads SET state = 'inspecting',version = 4,candidate_key = $2,lease_id = $3,
          lease_until = clock_timestamp()+interval '5 minutes' WHERE id = $1 RETURNING *`,[id,candidateKey,lease])).rows[0];
        if (state === 'ready') await sealFixture(tx,row,evidenceForManifest(source));
      }
    });
    const before = (await legacy.query('SELECT * FROM cb_media_uploads ORDER BY id')).rows;
    const proofs = (await legacy.query('SELECT * FROM cb_media_preparations')).rows;
    assert.deepEqual(await migrate(legacy),['014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_media_uploads ORDER BY id')).rows,before);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_media_preparations')).rows,proofs);
    const jobs = (await legacy.query('SELECT * FROM cb_media_work_queue')).rows;
    assert.equal(jobs.length,2); assert.equal(jobs.find((row) => row.upload_id === ids[0]).state,'queued');
    const running = jobs.find((row) => row.upload_id === ids[1]); assert.equal(running.state,'running'); assert.equal(running.attempts,1);
    assert.equal(running.lease_id,before.find((row) => row.id === ids[1]).lease_id);
    assert.equal(jobs.some((row) => row.upload_id === ids[2]),false); assert.deepEqual(await migrate(legacy),[]);
  } finally { await legacy.close(); }
});
