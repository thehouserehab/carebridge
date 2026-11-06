import assert from 'node:assert/strict';
import { before,beforeEach,after,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { MediaResourcePolicy } from '../media-resource-policy.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { Conversations } from '../conversations.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { FixturePreparation,hash,evidenceForManifest,sealFixture } from './media-storage-fixtures.mjs';

// Real local private file IO + PGlite. Preparation is explicitly synthetic;
// concurrent, separate PostgreSQL connections are verified in the native suite.
const IMAGE = 10485760,VIDEO = 52428800;
const owner = { centerId:'quota-center',userId:'quota-guardian' },manager = { centerId:'quota-center',userId:'quota-manager' };
const bytes = syntheticPng(),file = { name:'synthetic.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
const errorCode = (code) => (error) => error.code === code;
const input = (row) => ({ conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version });
let db,policy,uploads,store,pipeline,directory,serial;
const policyInput = (extra = {}) => ({ expectedRevision:0,storageBytes:100*IMAGE,pendingUploads:100,
  uploadsPerWindow:100,windowMilliseconds:3600000,acceptingUploads:true,...extra });
const reserve = (room = 'quota-room',clientId = `quota-request-${++serial}-0001`,extra = {}) =>
  uploads.reserve(owner,{ conversationId:room,clientId,file:{ ...file,...extra } });
const usage = async () => (await policy.get(manager)).usage;
const rowFor = async (row) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[row.id])).rows[0];
async function received() { const row = await reserve(); return uploads.receive(owner,input(row),Readable.from([bytes],{ objectMode:false })); }
before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-resource-test-')); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('quota-center'),('quota-foreign');
    INSERT INTO cb_users VALUES ('quota-guardian',true),('quota-therapist',true),('quota-manager',true),('quota-foreign-manager',true);
    INSERT INTO cb_memberships VALUES ('quota-center','quota-guardian','guardian',true),('quota-center','quota-therapist','therapist',true),
      ('quota-center','quota-manager','center',true),('quota-foreign','quota-foreign-manager','center',true);
    INSERT INTO cb_children VALUES ('quota-center','quota-child'),('quota-center','quota-child-other');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('quota-center','quota-room','quota-child'),('quota-center','quota-other','quota-child-other');
    INSERT INTO cb_participants VALUES ('quota-center','quota-room','quota-guardian','guardian',true,1),('quota-center','quota-room','quota-therapist','therapist',true,1),
      ('quota-center','quota-other','quota-guardian','guardian',true,1),('quota-center','quota-other','quota-therapist','therapist',true,1);`);
  serial = 0; policy = new MediaResourcePolicy(db); store = new PrivateFileStore(join(directory,randomUUID()));
  pipeline = new FixturePreparation(); uploads = new MediaUploads(db,store,{ preparation:pipeline });
});
after(async () => {
  await db?.close(); const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-resource-test-'));
  await rm(target,{ recursive:true,force:true });
});

test('unconfigured centers fail closed without allocating IDs, sequence, events or file IO',async () => {
  assert.deepEqual(await policy.get(manager),{ configured:false,revision:0,acceptingUploads:false,limits:null,usage:{ reservedBytes:0,pendingUploads:0 } });
  await assert.rejects(reserve(),errorCode('MEDIA_RESOURCES_UNCONFIGURED'));
  for (const table of ['cb_media_uploads','cb_media_objects','cb_media_events']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
  assert.equal((await db.query("SELECT last_sequence FROM cb_conversations WHERE id = 'quota-room'")).rows[0].last_sequence,0);
});
test('only a current center administrator can see aggregate capacity or explicitly configure it',async () => {
  for (const actor of [owner,{ ...owner,role:'center' },{ centerId:manager.centerId,userId:'quota-therapist' },
    { centerId:manager.centerId,userId:'quota-foreign-manager' }]) {
    await assert.rejects(policy.get(actor),errorCode('NOT_FOUND'));
    await assert.rejects(policy.configure(actor,policyInput()),errorCode('NOT_FOUND'));
  }
  await policy.configure(manager,policyInput());
  const row = await reserve(); const result = await policy.get(manager);
  assert.deepEqual(result.usage,{ reservedBytes:2*IMAGE,pendingUploads:1 });
  for (const secret of [row.id,file.name,file.sha256,owner.userId,'quota-child','quota-room']) assert.equal(JSON.stringify(result).includes(secret),false);
  await db.query("UPDATE cb_memberships SET active = false WHERE user_id = 'quota-manager'");
  await assert.rejects(policy.get(manager),errorCode('NOT_FOUND'));
  await assert.rejects(policy.configure(manager,policyInput({ expectedRevision:1 })),errorCode('NOT_FOUND'));
});
test('capacity spans all child rooms and failed admission rolls back the room counter and original client ID',async () => {
  await policy.configure(manager,policyInput({ storageBytes:2*IMAGE })); const first = await reserve();
  await assert.rejects(reserve('quota-other','quota-other-fixed-id'),errorCode('CENTER_MEDIA_CAPACITY'));
  assert.equal((await db.query("SELECT last_sequence FROM cb_conversations WHERE id = 'quota-other'")).rows[0].last_sequence,0);
  await uploads.cancel(owner,input(first));
  const retried = await reserve('quota-other','quota-other-fixed-id'); assert.equal(retried.replayed,false);
  assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:1 });
  assert.equal((await reserve('quota-other','quota-other-fixed-id')).id,retried.id);
});
test('original plus candidate slots use format ceilings, not a misleading source-only disk estimate',async () => {
  await policy.configure(manager,policyInput({ storageBytes:2*IMAGE+2*VIDEO })); await reserve();
  await reserve('quota-other',undefined,{ name:'synthetic.webm',type:'video/webm',size:32,sha256:'a'.repeat(64) });
  assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE+2*VIDEO,pendingUploads:2 });
  await assert.rejects(reserve(),errorCode('CENTER_MEDIA_CAPACITY'));
});
test('DB-clock rate includes cancelled reservations, excludes exact replays and rejects caller backdating',async () => {
  await policy.configure(manager,policyInput({ uploadsPerWindow:1,windowMilliseconds:1000 }));
  const row = await reserve('quota-room','quota-rate-fixed-id');
  assert.equal((await reserve('quota-room','quota-rate-fixed-id')).id,row.id);
  await uploads.cancel(owner,input(row));
  await assert.rejects(reserve('quota-other','quota-rate-retry-id'),errorCode('CENTER_MEDIA_RATE'));
  await assert.rejects(db.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,created_at,expires_at)
    VALUES ('quota-center','quota-other',$1,'quota-guardian',$1,repeat('a',64),'synthetic.png','image/png',32,repeat('a',64),1,clock_timestamp()-interval '1 year',clock_timestamp()+interval '1 hour')`,[randomUUID()]),
  (error) => error.constraint === 'cb_media_resource_rate');
  const created = (await rowFor(row)).created_at;
  await wait(Math.max(0,new Date(created).getTime()+1030-Date.now()));
  assert.equal((await reserve('quota-other','quota-rate-retry-id')).replayed,false);
});
test('pending reservations and exhausted inspection jobs count toward the center backlog until explicitly cancelled',async () => {
  await policy.configure(manager,policyInput({ pendingUploads:1 })); let row = await received();
  pipeline.prepare = async () => { throw new Error('synthetic transient outage'); };
  for (let attempt = 0; attempt < 5; attempt++) row = await uploads.inspect(owner,input(row));
  assert.equal((await db.query('SELECT state FROM cb_media_work_queue WHERE upload_id = $1',[row.id])).rows[0].state,'blocked');
  await assert.rejects(reserve('quota-other'),errorCode('CENTER_MEDIA_BACKLOG'));
  await uploads.cancel(owner,input(row)); assert.equal((await reserve('quota-other')).replayed,false);
});
test('retired candidate IO remains charged; capacity denial consumes no attempt and cleanup enables the same upload retry',async () => {
  await policy.configure(manager,policyInput({ storageBytes:2*IMAGE }));
  const row = await received(); pipeline.prepare = async () => { throw new Error('synthetic outage'); };
  const failed = await uploads.inspect(owner,input(row)); assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:1 });
  const before = await rowFor(failed),job = (await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[row.id])).rows[0];
  await assert.rejects(uploads.inspect(owner,input(failed)),errorCode('CENTER_MEDIA_CAPACITY'));
  assert.deepEqual(await rowFor(failed),before);
  assert.deepEqual((await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[row.id])).rows[0],job);
  await uploads.cleanup(); pipeline = new FixturePreparation(); uploads = new MediaUploads(db,store,{ preparation:pipeline });
  const done = await uploads.inspect(owner,input(failed)); assert.equal(done.id,row.id); assert.equal(done.state,'ready');
  assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:0 });
  await new Conversations(db).sendText(owner,{ conversationId:'quota-room',clientId:'quota-bound-message',body:'',attachments:[{ id:done.id }] });
  await assert.rejects(uploads.cancel(owner,input({ ...done,version:done.version+1 })),errorCode('FILE_IN_USE'));
  assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:0 });
});
test('cancellation never refunds retained bytes when physical deletion fails, and successful deletion refunds only once',async () => {
  await policy.configure(manager,policyInput({ storageBytes:2*IMAGE })); const row = await received();
  const ready = await uploads.inspect(owner,input(row)); await uploads.cancel(owner,input(ready));
  const broken = new MediaUploads(db,{ write:store.write.bind(store),openVerified:store.openVerified.bind(store),async remove() { throw new Error('synthetic disk failure'); } });
  assert.equal((await broken.cleanup()).failed,2); assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:0 });
  await assert.rejects(reserve('quota-other'),errorCode('CENTER_MEDIA_CAPACITY'));
  assert.equal((await uploads.cleanup()).removed,2); assert.deepEqual(await usage(),{ reservedBytes:0,pendingUploads:0 });
  assert.equal((await uploads.cleanup()).removed,0); assert.equal((await reserve('quota-other')).replayed,false);
});
test('pausing new admission does not stop existing preparation, exact receipt replay or authorized file access',async () => {
  await policy.configure(manager,policyInput()); const pending = await reserve('quota-room','quota-paused-fixed-id');
  await policy.configure(manager,policyInput({ expectedRevision:1,acceptingUploads:false }));
  assert.equal((await reserve('quota-room','quota-paused-fixed-id')).id,pending.id);
  await assert.rejects(reserve('quota-other'),errorCode('CENTER_MEDIA_PAUSED'));
  const row = await uploads.receive(owner,input(pending),Readable.from([bytes],{ objectMode:false }));
  const done = await uploads.inspect(owner,input(row)); assert.equal(done.state,'ready');
  const opened = await uploads.open(owner,{ conversationId:'quota-room',uploadId:done.id }); opened.stream.destroy();
});
test('policy shrink is atomic, cannot discard retained usage and cannot be reset without a revision',async () => {
  await policy.configure(manager,policyInput()); await reserve();
  await assert.rejects(policy.configure(manager,policyInput({ expectedRevision:1,storageBytes:IMAGE })),errorCode('CENTER_MEDIA_CAPACITY'));
  await assert.rejects(policy.configure(manager,policyInput({ expectedRevision:1,pendingUploads:0 })),errorCode('CENTER_MEDIA_BACKLOG'));
  assert.equal((await policy.get(manager)).revision,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_resource_events')).rows[0].n,1);
  await assert.rejects(policy.configure(manager,policyInput()),errorCode('MEDIA_POLICY_CONFLICT'));
  for (const sql of ["UPDATE cb_media_resource_limits SET accepting_uploads = false WHERE center_id = 'quota-center'",
    "DELETE FROM cb_media_resource_limits WHERE center_id = 'quota-center'",'UPDATE cb_media_resource_events SET policy = \'{}\'', 'DELETE FROM cb_media_resource_events'])
    await assert.rejects(db.query(sql),errorCode('23514'));
});
test('invalid policy input is rejected before DB access and foreign centers retain independent explicit limits',async () => {
  const noDB = new MediaResourcePolicy({ async transaction() { throw new Error('unexpected DB access'); } });
  for (const extra of [{ storageBytes:-1 },{ storageBytes:Number.MAX_SAFE_INTEGER+1 },{ pendingUploads:1.1 },{ windowMilliseconds:49 },
    { windowMilliseconds:86400001 },{ acceptingUploads:'true' },{ adminPassword:'must never be accepted' }])
    await assert.rejects(noDB.configure(manager,policyInput(extra)),errorCode('INVALID_INPUT'));
  await policy.configure(manager,policyInput()); await reserve();
  const other = { centerId:'quota-foreign',userId:'quota-foreign-manager' };
  assert.deepEqual((await policy.get(other)).usage,{ reservedBytes:0,pendingUploads:0 });
  await policy.configure(other,policyInput({ storageBytes:0,pendingUploads:0,uploadsPerWindow:0,acceptingUploads:false }));
  assert.equal((await policy.get(manager)).acceptingUploads,true);
  assert.deepEqual(await usage(),{ reservedBytes:2*IMAGE,pendingUploads:1 });
});
test('014 to current schema preserves every historical manifest, object, proof, message and old queue field without choosing operating limits',async () => {
  const legacy = await PGlite.create(),migrationRoot = join(directory,'legacy-resource-migrations');
  try {
    await mkdir(migrationRoot);
    for (const name of (await readdir(new URL('../migrations/',import.meta.url))).filter((name) => name.endsWith('.sql') && name < '015-'))
      await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrationRoot,name));
    await migrate(legacy,pathToFileURL(`${migrationRoot}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('quota-center'); INSERT INTO cb_users VALUES ('quota-guardian',true);
      INSERT INTO cb_memberships VALUES ('quota-center','quota-guardian','guardian',true); INSERT INTO cb_children VALUES ('quota-center','quota-child');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('quota-center','quota-room','quota-child');
      INSERT INTO cb_participants VALUES ('quota-center','quota-room','quota-guardian','guardian',true,1);`);
    // Historical 014 SQL fixture only: current authorization requires 023 and
    // must not run before this upgrade test. Keep every old integrity trigger
    // enabled and follow the original reservation/receipt transitions.
    assert.equal((await legacy.query("SELECT max(name) AS latest FROM cb_schema_migrations")).rows[0].latest,'014-media-work-queue.sql');
    assert.equal((await legacy.query("SELECT to_regclass('public.cb_care_recipient_links') AS relation")).rows[0].relation,null);
    const uploadId=randomUUID(),sourceKey=randomUUID();
    await legacy.transaction(async tx=>{
      const {rows:[counter]}=await tx.query(`UPDATE cb_conversations SET last_sequence=last_sequence+1
        WHERE center_id='quota-center' AND id='quota-room' RETURNING last_sequence`);
      await tx.query(`INSERT INTO cb_media_uploads
        (center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ('quota-center','quota-room',$1,'quota-guardian','quota-legacy-fixed-id',$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`,
      [uploadId,hash(JSON.stringify(file)),file.name,file.type,file.size,file.sha256,counter.last_sequence]);
      await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id)
        VALUES ($1,'quota-center','quota-room',$2)`,[sourceKey,uploadId]);
      await tx.query(`UPDATE cb_media_uploads SET state='receiving',version=version+1,object_key=$2,
        lease_id=$3,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,[uploadId,sourceKey,randomUUID()]);
    });
    await store.write(sourceKey,Readable.from([bytes],{objectMode:false}),file);
    const received=(await legacy.query(`UPDATE cb_media_uploads SET state='quarantined',version=version+1,
      lease_id=NULL,lease_until=NULL WHERE id=$1 RETURNING *`,[uploadId])).rows[0];
    await legacy.transaction(async (tx) => {
      const key = randomUUID();
      await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'quota-center','quota-room',$2)`,[key,received.id]);
      const { rows } = await tx.query(`UPDATE cb_media_uploads SET state = 'inspecting',version = version+1,candidate_key = $2,
        lease_id = $3,lease_until = clock_timestamp()+interval '1 minute' WHERE id = $1 RETURNING *`,[received.id,key,randomUUID()]);
      await sealFixture(tx,rows[0],evidenceForManifest({ type:file.type,size:file.size,sha256:file.sha256 }));
    });
    const ready=(await legacy.query('SELECT id,state FROM cb_media_uploads WHERE id=$1',[received.id])).rows[0];
    assert.equal(ready.state,'ready');
    // Construct a historical 014 message using its schema. The current
    // Conversations projection deliberately requires migration 020.
    const messageId=randomUUID();
    await legacy.transaction(async (tx) => {
      const {rows:[counter]}=await tx.query(`UPDATE cb_conversations SET last_sequence=last_sequence+1,revision=revision+1
        WHERE center_id='quota-center' AND id='quota-room' RETURNING last_sequence`);
      await tx.query(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,attachments_sealed)
        VALUES ('quota-center','quota-room',$1,$2,'quota-guardian','quota-legacy-message',repeat('a',64),'text','Synthetic historical text',false)`,
      [messageId,counter.last_sequence]);
      await tx.query(`UPDATE cb_media_uploads SET state='bound',version=version+1,bound_message_id=$2
        WHERE id=$1`,[ready.id,messageId]);
      await tx.query(`INSERT INTO cb_message_attachments(center_id,conversation_id,message_id,ordinal,upload_id)
        VALUES ('quota-center','quota-room',$1,0,$2)`,[messageId,ready.id]);
      await tx.query('UPDATE cb_messages SET attachments_sealed=true WHERE id=$1',[messageId]);
    });
    const tables = ['cb_media_uploads','cb_media_objects','cb_media_preparations','cb_messages','cb_media_work_queue'],snapshots = [];
    for (const table of tables) snapshots.push((await legacy.query(`SELECT * FROM ${table}`)).rows);
    assert.deepEqual(await migrate(legacy),['015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    for (let index = 0; index < tables.length; index++) {
      const rows = (await legacy.query(`SELECT * FROM ${tables[index]}`)).rows;
      if (tables[index] === 'cb_media_work_queue') for (const row of rows) {
        assert.equal(row.approved_retries,0); assert.equal(row.last_review_id,null); delete row.approved_retries; delete row.last_review_id;
      }
      assert.deepEqual(rows,snapshots[index]);
    }
    assert.equal((await legacy.query('SELECT revision FROM cb_media_resource_limits')).rows[0].revision,0);
    const message=await new Conversations(legacy).get(owner,{conversationId:'quota-room',messageId});
    assert.equal(message.body,'Synthetic historical text');assert.equal(message.version,1);
    assert.equal(message.attachments[0].id,ready.id);
    const service = new MediaUploads(legacy,store,{ preparation:new FixturePreparation() });
    await assert.rejects(service.reserve(owner,{ conversationId:'quota-room',clientId:'quota-legacy-new-id',file }),errorCode('MEDIA_RESOURCES_UNCONFIGURED'));
    assert.deepEqual(await migrate(legacy),[]);
  } finally { await legacy.close(); }
});
