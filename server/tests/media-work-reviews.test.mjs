import assert from 'node:assert/strict';
import { before,beforeEach,after,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm,mkdir,readdir,copyFile } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { MediaWorkReviews } from '../media-work-reviews.mjs';
import { MediaWorkQueueWorker } from '../media-work-queue-worker.mjs';
import { MediaResourcePolicy } from '../media-resource-policy.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { RepositoryError } from '../errors.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { FixturePreparation,candidate,hash,scan } from './media-storage-fixtures.mjs';

// Real private local files and PostgreSQL semantics via PGlite. Preparation is
// explicitly synthetic; native scanning/concurrency have separate verification.
const manager = { centerId:'review-center',userId:'review-manager' };
const owner = { centerId:manager.centerId,userId:'review-guardian' };
const bytes = syntheticPng(),file = { name:'synthetic-private-name.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
const code = (expected) => (error) => error.code === expected;
const input = (row) => ({ conversationId:row.conversationId ?? row.conversation_id,uploadId:row.id,expectedVersion:row.version });
let db,directory,root,store,uploads,pipeline,reviews,serial,calls;
const rowFor = async (id) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
const jobFor = async (id) => (await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const request = (row,extra = {}) => ({ conversationId:row.conversationId ?? row.conversation_id,uploadId:row.id,
  clientId:`synthetic-review-${++serial}-0001`,expectedUploadVersion:row.version,expectedAttempts:5,reason:'ENGINE_RESTORED',confirmReinspection:true,...extra });
async function receive(service = uploads,room = 'review-room',actor = owner) {
  const pending = await service.reserve(actor,{ conversationId:room,clientId:`synthetic-reserve-${++serial}-0001`,file });
  return service.receive(actor,input(pending),Readable.from([bytes],{ objectMode:false }));
}
async function block(service = uploads,room = 'review-room',actor = owner) {
  let row = await receive(service,room,actor);
  for (let attempt = 0; attempt < 5; attempt++) row = await service.inspect(actor,input(row));
  assert.equal((await jobFor(row.id)).state,'blocked'); return row;
}
before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-reviews-test-')); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('review-center'),('review-foreign');
    INSERT INTO cb_users VALUES ('review-manager',true),('review-guardian',true),('review-therapist',true),('review-foreign-manager',true);
    INSERT INTO cb_memberships VALUES ('review-center','review-manager','center',true),('review-center','review-guardian','guardian',true),
      ('review-center','review-therapist','therapist',true),('review-foreign','review-foreign-manager','center',true);
    INSERT INTO cb_children VALUES ('review-center','review-child'),('review-center','review-other-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('review-center','review-room','review-child'),('review-center','review-other','review-other-child');
    INSERT INTO cb_participants VALUES ('review-center','review-room','review-guardian','guardian',true,1),('review-center','review-room','review-therapist','therapist',true,1),
      ('review-center','review-other','review-guardian','guardian',true,1),('review-center','review-other','review-therapist','therapist',true,1);`);
  await configureSyntheticMediaPolicy(db,manager.centerId); serial = 0; calls = 0;
  root = join(directory,randomUUID()); store = new PrivateFileStore(root);
  pipeline = new FixturePreparation(async () => { calls++; throw new RepositoryError('SCAN_INVALID'); });
  uploads = new MediaUploads(db,store,{ preparation:pipeline }); reviews = new MediaWorkReviews(db);
});
after(async () => {
  await db?.close(); if (!directory) return;
  const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-reviews-test-'));
  await rm(target,{ recursive:true,force:true });
});

test('review lists expose only bounded operational state, not file or clinical details',async () => {
  const one = await block(),two = await block(uploads,'review-other');
  const first = await reviews.list(manager,{ limit:1 }); assert.equal(first.jobs.length,1); assert.equal(first.hasMore,true);
  const second = await reviews.list(manager,{ limit:1,after:first.nextCursor }); assert.equal(second.jobs.length,1); assert.equal(second.hasMore,false);
  assert.deepEqual([first.jobs[0].uploadId,second.jobs[0].uploadId].sort(),[one.id,two.id].sort());
  const state = await reviews.get(manager,{ conversationId:'review-room',uploadId:one.id }); assert.equal(state.canResume,true);
  assert.deepEqual(Object.keys(state).sort(),['conversationId','uploadId','state','attempts','approvedRetries','uploadVersion','failureCode','expiresAt','expired','canResume'].sort());
  for (const secret of [file.name,file.sha256,owner.userId,'review-child','body','scan_report','source_key','candidate_key'])
    assert.equal(JSON.stringify(first).includes(secret),false);
  assert.deepEqual(await reviews.list({ centerId:'review-foreign',userId:'review-foreign-manager' }),{ jobs:[],hasMore:false,nextCursor:null });
});

test('a current manager grant keeps identity, original bytes, TTL, upload version and cumulative attempts unchanged',async () => {
  const blocked = await block(),before = await rowFor(blocked.id),oldJob = await jobFor(blocked.id);
  const result = await reviews.resume(manager,request(blocked)); assert.equal(result.replayed,false); assert.equal(result.approvedRetry,1);
  assert.deepEqual(await rowFor(blocked.id),before); assert.deepEqual(await readFile(join(root,`${before.object_key}.blob`)),bytes);
  const job = await jobFor(blocked.id); assert.equal(job.state,'retry'); assert.equal(job.attempts,oldJob.attempts); assert.equal(job.approved_retries,1);
  assert.equal(job.last_review_id,result.reviewId); assert.equal(job.finished_at,null); assert.equal(await count('cb_media_preparations'),0); assert.equal(calls,5);
  pipeline.work = async (source) => { calls++; return candidate(source); };
  const done = await new MediaWorkQueueWorker(uploads,{ localTestMode:true }).runOne(); assert.equal(done.upload.id,blocked.id); assert.equal(done.upload.state,'ready');
  assert.equal((await jobFor(blocked.id)).attempts,6); assert.equal((await jobFor(blocked.id)).outcome,'ready'); assert.equal(calls,6);
  assert.equal(await count('cb_media_preparations'),1);
  await assert.rejects(uploads.open(manager,{ conversationId:'review-room',uploadId:blocked.id }),code('NOT_FOUND'));
  await assert.rejects(new Conversations(db).list(manager,{ conversationId:'review-room' }),code('NOT_FOUND'));
});

test('exact retry is a stable receipt after processing, never another grant or preparation',async () => {
  const blocked = await block(),wanted = request(blocked),first = await reviews.resume(manager,wanted);
  assert.deepEqual(await reviews.resume(manager,wanted),{ ...first,replayed:true });
  pipeline.work = async (source) => { calls++; return candidate(source); }; await uploads.inspect(owner,input(blocked));
  const completed = await jobFor(blocked.id); assert.deepEqual(await reviews.resume(manager,wanted),{ ...first,replayed:true });
  assert.deepEqual(await jobFor(blocked.id),completed); assert.equal(await count('cb_media_work_reviews'),1); assert.equal(calls,6);
  for (const extra of [{ reason:'STORAGE_RESTORED' },{ expectedAttempts:6 },{ conversationId:'review-other' }])
    await assert.rejects(reviews.resume(manager,{ ...wanted,...extra }),code('IDEMPOTENCY_CONFLICT'));
});

test('each review adds exactly one failed attempt and the third lifetime review exhausts the bound',async () => {
  let row = await block();
  for (let retry = 1; retry <= 3; retry++) {
    await reviews.resume(manager,request(row,{ expectedAttempts:4+retry })); row = await uploads.inspect(owner,input(row));
    const job = await jobFor(row.id); assert.equal(job.state,'blocked'); assert.equal(job.attempts,5+retry); assert.equal(job.approved_retries,retry);
    await assert.rejects(uploads.inspect(owner,input(row)),code('UPLOAD_ATTEMPTS_EXHAUSTED'));
  }
  assert.equal((await reviews.get(manager,{ conversationId:'review-room',uploadId:row.id })).canResume,false);
  await assert.rejects(reviews.resume(manager,request(row,{ expectedAttempts:8 })),code('MEDIA_REVIEW_LIMIT'));
  assert.equal(await count('cb_media_work_reviews'),3); assert.equal(calls,8);
});

test('only stored current center membership grants operational review access',async () => {
  const blocked = await block(),wanted = request(blocked);
  for (const actor of [owner,{ ...owner,role:'center' },{ ...manager,userId:'review-therapist' },{ ...manager,userId:'review-foreign-manager' }]) {
    await assert.rejects(reviews.list(actor),code('NOT_FOUND'));
    await assert.rejects(reviews.get(actor,{ conversationId:'review-room',uploadId:blocked.id }),code('NOT_FOUND'));
    await assert.rejects(reviews.resume(actor,wanted),code('NOT_FOUND'));
  }
  assert.equal(await count('cb_media_work_reviews'),0);
});

test('deactivated reviewers cannot inspect or replay their previous receipt',async () => {
  const row = await block(),wanted = request(row); await reviews.resume(manager,wanted);
  await db.query('UPDATE cb_memberships SET active = false WHERE user_id = $1',[manager.userId]);
  await assert.rejects(reviews.resume(manager,wanted),code('NOT_FOUND')); await assert.rejects(reviews.list(manager),code('NOT_FOUND'));
  assert.equal(await count('cb_media_work_reviews'),1); assert.equal((await jobFor(row.id)).approved_retries,1);
});

test('stale versions or attempts cannot consume a grant',async () => {
  const row = await block();
  for (const extra of [{ expectedUploadVersion:row.version-1 },{ expectedAttempts:6 }])
    await assert.rejects(reviews.resume(manager,request(row,extra)),code('MEDIA_REVIEW_CONFLICT'));
  assert.equal(await count('cb_media_work_reviews'),0); assert.equal((await jobFor(row.id)).approved_retries,0);
});

test('invalid or unacknowledged input is rejected before database access',async () => {
  const noDB = new MediaWorkReviews({ async transaction() { throw new Error('unexpected DB access'); } });
  const row = { conversationId:'review-room',id:randomUUID(),version:13 },wanted = request(row);
  for (const extra of [{ confirmReinspection:false },{ confirmReinspection:'true' },{ reason:'approve media' },{ reason:'private raw diagnostic' },
    { clientId:'bad' },{ expectedAttempts:4 },{ expectedAttempts:9 },{ expectedUploadVersion:0 },{ uploadId:'../private' },{ body:'private notes' }])
    await assert.rejects(noDB.resume(manager,{ ...wanted,...extra }),code('INVALID_INPUT'));
  for (const options of [{ limit:0 },{ limit:101 },{ after:{ conversationId:'review-room',uploadId:'bad' } },{ childName:'private' }])
    await assert.rejects(noDB.list(manager,options),code('INVALID_INPUT'));
});

test('owner deactivation, disconnected relationship and narrowed history prevent reopening',async () => {
  const row = await block(),wanted = request(row);
  await db.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]);
  assert.equal((await reviews.get(manager,{ conversationId:'review-room',uploadId:row.id })).canResume,false);
  await assert.rejects(reviews.resume(manager,wanted),code('MEDIA_OWNER_UNAVAILABLE'));
  await db.query('UPDATE cb_users SET active = true WHERE id = $1',[owner.userId]);
  const relationships = new Relationships(db),before = await relationships.get(manager,{ conversationId:'review-room' });
  const disconnected = await relationships.replace(manager,{ conversationId:'review-room',clientId:'synthetic-review-disconnect',expectedVersion:before.version,
    therapist:{ userId:'review-therapist',history:'preserve' },guardians:[],historyConfirmed:true });
  await assert.rejects(reviews.resume(manager,wanted),code('MEDIA_OWNER_UNAVAILABLE'));
  await relationships.replace(manager,{ conversationId:'review-room',clientId:'synthetic-review-reconnect',expectedVersion:disconnected.appliedVersion,
    therapist:{ userId:'review-therapist',history:'preserve' },guardians:[{ userId:owner.userId,history:'from_now' }],historyConfirmed:true });
  await assert.rejects(reviews.resume(manager,wanted),code('MEDIA_OWNER_UNAVAILABLE'));
  assert.equal(await count('cb_media_work_reviews'),0);
});

test('the ledger cannot abandon a current original and review never bypasses an unreadable source',async () => {
  const row = await block(),source = await rowFor(row.id);
  await assert.rejects(db.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[source.object_key]),code('23514'));
  await reviews.resume(manager,request(row));
  const unavailable = new MediaUploads(db,{ write:store.write.bind(store),remove:store.remove.bind(store),
    async openVerified() { throw new Error('synthetic unavailable original'); } },{ preparation:pipeline });
  const result = await unavailable.inspect(owner,input(row)); assert.equal(result.state,'quarantined');
  assert.equal((await jobFor(row.id)).state,'blocked'); assert.equal((await jobFor(row.id)).attempts,6); assert.equal(await count('cb_media_preparations'),0);
});

test('expiry is not extended and expired work remains unavailable until normal cleanup',async () => {
  const service = new MediaUploads(db,store,{ preparation:pipeline,ttlMilliseconds:2500,leaseMilliseconds:1000,operationTimeoutMilliseconds:800 });
  const row = await block(service),before = await rowFor(row.id); await delay(Math.max(0,new Date(row.expiresAt).getTime()-Date.now()+30));
  await assert.rejects(reviews.resume(manager,request(row)),code('UPLOAD_EXPIRED')); assert.deepEqual(await rowFor(row.id),before);
  assert.equal(await count('cb_media_work_reviews'),0); assert.equal((await reviews.list(manager)).jobs[0].expired,true);
  await service.cleanup(); assert.equal((await jobFor(row.id)).state,'cancelled');
});

test('cancelled and successfully inspected files cannot be reopened',async () => {
  const blocked = await block(); await uploads.cancel(owner,input(blocked)); const cancelled = await rowFor(blocked.id);
  await assert.rejects(reviews.resume(manager,request(cancelled)),code('MEDIA_REVIEW_NOT_REQUIRED'));
  pipeline.work = async (source) => candidate(source); const received = await receive(),ready = await uploads.inspect(owner,input(received));
  await assert.rejects(reviews.resume(manager,request(ready,{ expectedAttempts:5 })),code('MEDIA_REVIEW_CONFLICT'));
  assert.equal(await count('cb_media_work_reviews'),0); assert.equal((await jobFor(ready.id)).state,'completed');
});

test('a rejection on the additional scan stays terminal and is never converted to ready',async () => {
  const blocked = await block(); await reviews.resume(manager,request(blocked));
  pipeline.work = async (source,manifest) => ({ status:'rejected',stage:'source',source:manifest,sourceScan:scan(manifest,'rejected'),mediaAcceptanceReady:false });
  const rejected = await uploads.inspect(owner,input(blocked)); assert.equal(rejected.state,'rejected');
  await assert.rejects(reviews.resume(manager,request(rejected,{ expectedAttempts:6 })),code('MEDIA_REVIEW_NOT_REQUIRED'));
  assert.equal((await jobFor(blocked.id)).outcome,'rejected'); assert.equal(await count('cb_media_preparations'),0);
});

test('pausing new uploads does not approve files or prevent explicit review of existing work',async () => {
  const row = await block(),policy = new MediaResourcePolicy(db),previous = await policy.get(manager);
  await policy.configure(manager,{ expectedRevision:previous.revision,...previous.limits,acceptingUploads:false });
  await reviews.resume(manager,request(row)); pipeline.work = async (source) => candidate(source);
  assert.equal((await new MediaWorkQueueWorker(uploads,{ localTestMode:true }).runOne()).upload.state,'ready');
  await assert.rejects(receive(),code('CENTER_MEDIA_PAUSED'));
});

test('grant update failure rolls back the receipt and leaves all prior upload data untouched',async () => {
  const row = await block(),before = await jobFor(row.id),wanted = request(row);
  await db.exec(`CREATE FUNCTION cb_review_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.approved_retries > OLD.approved_retries THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_review_test_failure BEFORE UPDATE ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_review_test_failure();`);
  try { await assert.rejects(reviews.resume(manager,wanted)); }
  finally { await db.exec('DROP TRIGGER cb_review_test_failure ON cb_media_work_queue; DROP FUNCTION cb_review_test_failure();'); }
  assert.equal(await count('cb_media_work_reviews'),0); assert.deepEqual(await jobFor(row.id),before);
  assert.equal((await reviews.resume(manager,wanted)).replayed,false);
});

test('lost commit acknowledgment is recovered by the exact receipt without a second grant',async () => {
  const row = await block(),wanted = request(row); let lose = true;
  const uncertain = new MediaWorkReviews({ transaction:async (work) => { const result = await db.transaction(work);
    if (lose && result?.reviewId) { lose = false; throw new Error('synthetic response loss'); } return result; } });
  await assert.rejects(uncertain.resume(manager,wanted)); assert.equal(await count('cb_media_work_reviews'),1);
  assert.equal((await reviews.resume(manager,wanted)).replayed,true); assert.equal((await jobFor(row.id)).approved_retries,1);
});

test('SQL guards reject attempt resets, fabricated grants and mutation of immutable reviews',async () => {
  const row = await block();
  for (const sql of ["UPDATE cb_media_work_queue SET attempts = 0","UPDATE cb_media_work_queue SET approved_retries = 1",
    "UPDATE cb_media_work_queue SET state = 'retry'","UPDATE cb_media_work_queue SET attempts = 4,state = 'retry'"])
    await assert.rejects(db.query(sql),code('23514'));
  await reviews.resume(manager,request(row));
  for (const sql of ['UPDATE cb_media_work_reviews SET reason = \'STORAGE_RESTORED\'','DELETE FROM cb_media_work_reviews',
    'UPDATE cb_media_work_queue SET approved_retries = 0,last_review_id = NULL']) await assert.rejects(db.query(sql),code('23514'));
  assert.equal((await jobFor(row.id)).attempts,5); assert.equal(await count('cb_media_work_reviews'),1);
});

test('a SQL review receipt alone cannot commit or accept a forged reviewer',async () => {
  const row = await block(),wanted = request(row),reviewId = randomUUID();
  const insert = (tx,reviewer) => tx.query(`INSERT INTO cb_media_work_reviews(center_id,conversation_id,id,upload_id,reviewer_id,client_id,request_hash,upload_version,attempts,review_number,reason)
    VALUES ($1,$2,$3,$4,$5,$6,repeat('a',64),$7,5,1,'ENGINE_RESTORED')`,[manager.centerId,'review-room',reviewId,row.id,reviewer,wanted.clientId,row.version]);
  await assert.rejects(db.transaction((tx) => insert(tx,manager.userId)),code('23514'));
  await assert.rejects(db.transaction((tx) => insert(tx,owner.userId)),code('23514'));
  assert.equal(await count('cb_media_work_reviews'),0); assert.equal((await jobFor(row.id)).state,'blocked');
});

test('014 and 015 to 016 preserve every old queue field and never auto-reopen or auto-configure blocked work',async () => {
  for (const checkpoint of ['015-','016-']) {
    const legacy = await PGlite.create(),migrationRoot = join(directory,`legacy-review-migrations-${checkpoint}`);
    try {
      await mkdir(migrationRoot);
      for (const name of (await readdir(new URL('../migrations/',import.meta.url))).filter((name) => name.endsWith('.sql') && name < checkpoint))
        await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrationRoot,name));
      await migrate(legacy,pathToFileURL(`${migrationRoot}/`));
      await legacy.exec(`INSERT INTO cb_centers VALUES ('review-center'); INSERT INTO cb_users VALUES ('review-manager',true),('review-guardian',true);
        INSERT INTO cb_memberships VALUES ('review-center','review-manager','center',true),('review-center','review-guardian','guardian',true);
        INSERT INTO cb_children VALUES ('review-center','review-child'); INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('review-center','review-room','review-child');
        INSERT INTO cb_participants VALUES ('review-center','review-room','review-guardian','guardian',true,1);`);
      if (checkpoint === '016-') await configureSyntheticMediaPolicy(legacy,manager.centerId);
      // Stage historic data using only its actual SQL transitions, not a new
      // runtime service against an obsolete schema.
      const uploadId = randomUUID(),source = randomUUID();
      await legacy.transaction(async (tx) => {
        await tx.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
          VALUES ('review-center','review-room',$1,'review-guardian',$1,repeat('a',64),'synthetic.png','image/png',32,repeat('b',64),1,clock_timestamp()+interval '1 hour')`,[uploadId]);
        await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'review-center','review-room',$2)`,[source,uploadId]);
        await tx.query(`UPDATE cb_media_uploads SET state = 'receiving',version = 2,object_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '1 minute' WHERE id = $1`,[uploadId,source,randomUUID()]);
        await tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1",[uploadId]);
        for (let i = 0; i < 5; i++) {
          const key = randomUUID(); await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'review-center','review-room',$2)`,[key,uploadId]);
          await tx.query("UPDATE cb_media_uploads SET state = 'inspecting',version = version+1,candidate_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '1 minute' WHERE id = $1",[uploadId,key,randomUUID()]);
          await tx.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]);
          await tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = version+1,candidate_key = NULL,lease_id = NULL,lease_until = NULL,failure_code = 'SCAN_UNAVAILABLE' WHERE id = $1",[uploadId]);
        }
      });
      const tables = ['cb_media_uploads','cb_media_objects','cb_media_events','cb_media_work_queue'],snapshots = [];
      for (const table of tables) snapshots.push((await legacy.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows);
      assert.equal(snapshots.at(-1)[0].state,'blocked');
      assert.deepEqual(await migrate(legacy),checkpoint === '016-' ? ['016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql'] : ['015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
      for (let i = 0; i < tables.length; i++) {
        const rows = (await legacy.query(`SELECT * FROM ${tables[i]} ORDER BY 1,2`)).rows;
        if (tables[i] === 'cb_media_work_queue') for (const current of rows) { assert.equal(current.approved_retries,0); assert.equal(current.last_review_id,null); delete current.approved_retries; delete current.last_review_id; }
        assert.deepEqual(rows,snapshots[i]);
      }
      const operations = new MediaWorkReviews(legacy),sourceRow = (await legacy.query('SELECT * FROM cb_media_uploads')).rows[0];
      if (checkpoint === '015-') {
        assert.equal((await operations.get(manager,{ conversationId:'review-room',uploadId })).canResume,false);
        await assert.rejects(operations.resume(manager,request(sourceRow)),code('MEDIA_RESOURCES_UNCONFIGURED'));
        await assert.rejects(legacy.transaction((tx) => tx.query(`INSERT INTO cb_media_work_reviews(center_id,conversation_id,id,upload_id,reviewer_id,client_id,request_hash,upload_version,attempts,review_number,reason)
          VALUES ('review-center','review-room',$1,$2,'review-manager','synthetic-legacy-unconfigured',repeat('a',64),$3,5,1,'CONFIGURATION_CORRECTED')`,
        [randomUUID(),uploadId,sourceRow.version])),(error) => error.code === '23514' && error.constraint === 'cb_media_resource_configured');
        assert.equal((await legacy.query('SELECT count(*)::int AS n FROM cb_media_work_reviews')).rows[0].n,0);
        await configureSyntheticMediaPolicy(legacy,manager.centerId);
      }
      assert.equal((await operations.get(manager,{ conversationId:'review-room',uploadId })).canResume,true);
      assert.deepEqual(await migrate(legacy),[]); await operations.resume(manager,request(sourceRow));
      assert.equal((await legacy.query('SELECT attempts FROM cb_media_work_queue')).rows[0].attempts,5);
    } finally { await legacy.close(); }
  }
});
