import assert from 'node:assert/strict';
import { after,afterEach,before,beforeEach,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { MediaPreparation } from '../media-preparation.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { MediaAccess } from '../media-access.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { Conversations } from '../conversations.mjs';
import { syntheticPng,addPrivateMetadata,PRIVATE_MARKER } from '../image-metadata-test-fixtures.mjs';
import { fakeClam,fakePreparation } from './media-preparation-fixtures.mjs';
import { candidate,collect,hash,FixturePreparation,evidenceForManifest,sealFixture } from './media-storage-fixtures.mjs';
import { RepositoryError } from '../errors.mjs';
import { servingFile } from '../media-serving.mjs';

// Actual private filesystem + PGlite + actual loopback protocol/client and
// isolated coordinator with synthetic engine/decoder. NO native engine proof.
const owner = { centerId:'center-a',userId:'guardian-a' },therapist = { centerId:'center-a',userId:'therapist-a' };
const manager = { centerId:'center-a',userId:'manager-a' };
const bytes = addPrivateMetadata(syntheticPng(),'image/png'),bare = syntheticPng();
const file = { name:'가상 사진.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
const input = (row) => ({ conversationId:'room-a',uploadId:row.id,expectedVersion:row.version });
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const delay = (milliseconds) => new Promise((yes) => setTimeout(yes,milliseconds));
let db,directory,root,store,pipeline,clam,job,uploads,count,returnedBytes;
const rowFor = async (id) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
const proofs = async () => (await db.query('SELECT * FROM cb_media_preparations ORDER BY created_at')).rows;
const queryObjects = async () => (await db.query('SELECT * FROM cb_media_objects ORDER BY created_at')).rows;
function storeWith(changes) { return { write:store.write.bind(store),openVerified:store.openVerified.bind(store),remove:store.remove.bind(store),...changes }; }
async function quarantine(instance = uploads) {
  const pending = await instance.reserve(owner,{ conversationId:'room-a',clientId:`storage-request-${++count}-0001`,file });
  return instance.receive(owner,input(pending),Readable.from([bytes],{ objectMode:false }));
}
async function ready(instance = uploads) { const row = await quarantine(instance); return instance.inspect(owner,input(row)); }
async function attach(row) { return new Conversations(db).sendText(owner,{ conversationId:'room-a',clientId:`storage-message-${++count}-0001`,body:'',attachments:[{ id:row.id }] }); }
before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-prepared-storage-')); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('therapist-a',true),('manager-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','therapist-a','therapist',true),('center-a','manager-a','center',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'); INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1);`);
  root = join(directory,randomUUID()); store = new PrivateFileStore(root); count = 0; returnedBytes = null;
  await configureSyntheticMediaPolicy(db,'center-a');
  clam = await fakeClam(); job = fakePreparation(); pipeline = new MediaPreparation({ scanner:clam.scanner,preparer:job.preparer });
  const work = pipeline.prepare.bind(pipeline);
  pipeline.prepare = async (...args) => { const result = await work(...args); returnedBytes = result.bytes; return result; };
  uploads = new MediaUploads(db,store,{ preparation:pipeline });
});
afterEach(async () => { await clam?.close(); assert.equal(job.containers.size,0); });
after(async () => {
  await db?.close(); const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-prepared-storage-'));
  await rm(target,{ recursive:true,force:true }); // Verified synthetic test-owned directory only.
});

test('full preparation stores distinct original and candidate before atomic proof and approval',async () => {
  const pending = await quarantine(); assert.equal(pending.state,'quarantined');
  assert.equal((await proofs()).length,0); assert.equal((await queryObjects()).length,1);
  const readyRow = await uploads.inspect(owner,input(pending)),row = await rowFor(pending.id),proof = (await proofs())[0];
  assert.equal(readyRow.state,'ready'); assert.equal(readyRow.version,5); assert.equal(row.preparation_required,true);
  assert.notEqual(row.object_key,row.candidate_key); assert.equal(proof.id,row.preparation_id); assert.equal(proof.upload_version,4);
  assert.equal(proof.source_key,row.object_key); assert.equal(proof.derivative_key,row.candidate_key);
  assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
  const derivative = await readFile(join(root,`${row.candidate_key}.blob`));
  assert.equal(derivative.includes(Buffer.from(PRIVATE_MARKER)),false); assert.equal(bytes.includes(Buffer.from(PRIVATE_MARKER)),true);
  assert.equal(derivative.length,row.prepared_size); assert.equal(hash(derivative),row.prepared_sha256);
  assert.equal(proof.evidence.source.sha256,file.sha256); assert.equal(proof.evidence.derivative.sha256,row.prepared_sha256);
  assert.equal(clam.scans.length,2); assert.deepEqual(clam.scans[0],bytes); assert.deepEqual(clam.scans[1],derivative);
  assert.equal(proof.evidence.mediaAcceptanceReady,false); assert.equal(returnedBytes.every((n) => n === 0),true);
  const preview = await uploads.open(owner,{ conversationId:'room-a',uploadId:row.id });
  assert.deepEqual(await collect(preview.stream),derivative); assert.equal(preview.total,derivative.length);
  assert.equal(readyRow.size,derivative.length); assert.equal(preview.attachment.id,pending.id);
  for (const secret of [PRIVATE_MARKER,'candidate_key','preparation_id','sha256','evidence',root]) assert.equal(JSON.stringify(readyRow).includes(secret),false);
});
test('new approvals cannot use scan-only adapters or a public settle shortcut',async () => {
  for (const options of [{ scanner:{ inspect() {} } },{ preparation:{ prepare() {} } },{ scanner:clam.scanner }])
    assert.throws(() => new MediaUploads(db,store,options),TypeError);
  const row = await quarantine(),unconfigured = new MediaUploads(db,store);
  const blocked = await unconfigured.inspect(owner,input(row)); assert.equal(blocked.state,'quarantined'); assert.equal(blocked.failureCode,'SCAN_UNAVAILABLE');
  const claim = await uploads.claim(owner,input(blocked),'inspect');
  await assert.rejects(uploads.settle(owner,'room-a',claim,{ state:'ready',evidence:candidate(bytes).report }),errorCode('SCAN_INVALID'));
  assert.equal((await proofs()).length,0);
  await assert.rejects(db.query(`UPDATE cb_media_uploads SET preparation_required = false,version = version + 1,state = 'quarantined',lease_id = NULL,lease_until = NULL,candidate_key = NULL WHERE id = $1`,[row.id]));
  assert.throws(() => servingFile({ ...claim,state:'ready',candidate_key:null,preparation_id:null }),errorCode('CONTENT_UNAVAILABLE'));
});
test('identical transformed bytes still have separate object keys and immutable evidence',async () => {
  const pending = await uploads.reserve(owner,{ conversationId:'room-a',clientId:'bare-storage-request-01',file:{ ...file,size:bare.length,sha256:hash(bare) } });
  const received = await uploads.receive(owner,input(pending),Readable.from([bare],{ objectMode:false }));
  const state = await uploads.inspect(owner,input(received)),row = await rowFor(state.id);
  assert.equal(state.state,'ready'); assert.notEqual(row.object_key,row.candidate_key); assert.equal(row.sha256,row.prepared_sha256);
  assert.equal((await proofs()).length,1); assert.equal((await queryObjects()).length,2);
});
test('message binding and partial downloads expose only candidate bytes with the original attachment ID',async () => {
  const state = await ready(),row = await rowFor(state.id),message = await attach(state),access = new MediaAccess(db,store);
  const listed = await new Conversations(db).get(therapist,{ conversationId:'room-a',messageId:message.id });
  assert.equal(listed.attachments[0].id,state.id); assert.equal(listed.attachments[0].size,row.prepared_size);
  const opened = await access.open(therapist,{ conversationId:'room-a',uploadId:state.id,source:{ kind:'message',messageId:message.id },range:{ start:2,end:8 } });
  const derivative = await readFile(join(root,`${row.candidate_key}.blob`));
  assert.deepEqual(await collect(opened.stream),derivative.subarray(2,9)); assert.equal(opened.total,derivative.length);
  assert.equal((await proofs()).length,1); assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n,0);
  await assert.rejects(access.open(manager,{ conversationId:'room-a',uploadId:state.id,source:{ kind:'message',messageId:message.id } }),errorCode('NOT_FOUND'));
});
test('a corrupt candidate never falls back to a healthy private original',async () => {
  const state = await ready(),row = await rowFor(state.id);
  await writeFile(join(root,`${row.candidate_key}.blob`),Buffer.alloc(row.prepared_size));
  await assert.rejects(uploads.open(owner,{ conversationId:'room-a',uploadId:state.id }),errorCode('CONTENT_UNAVAILABLE'));
  assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
  const message = await attach(state);
  await assert.rejects(new MediaAccess(db,store).open(therapist,{ conversationId:'room-a',uploadId:state.id,source:{ kind:'message',messageId:message.id } }),errorCode('CONTENT_UNAVAILABLE'));
});
test('changed manifest scan definitions metadata or acceptance claims fail closed at storage boundary',async () => {
  const changes = [
    (r) => r.report.source.sha256 = 'b'.repeat(64),
    (r) => r.report.derivativeScan.databaseVersion++,
    (r) => r.report.preparation.derivativeTimelineSha256 = 'b'.repeat(64),
    (r) => r.report.preparation.metadata.policyVersion = 'unsupported',
    (r) => r.report.derivativeScan.sha256 = 'b'.repeat(64),
    (r) => r.bytes[r.bytes.length-1] ^= 1,
    (r) => r.report.mediaAcceptanceReady = true,
    (r) => r.report.privatePath = 'PRIVATE-UNTRUSTED',
  ];
  for (const change of changes) {
    const prep = new FixturePreparation(() => { const result = candidate(bytes); change(result); return result; });
    const service = new MediaUploads(db,store,{ preparation:prep }),row = await quarantine(service),state = await service.inspect(owner,input(row));
    assert.equal(state.state,'quarantined'); assert.equal(state.failureCode,'SCAN_INVALID');
  }
  assert.equal((await proofs()).length,0);
  assert.equal((await queryObjects()).filter((r) => r.state === 'delete_pending').length,changes.length);
});
test('a write acknowledgement without persisted bytes cannot produce ready or evidence',async () => {
  let writes = 0;
  const dishonest = storeWith({ write:async (...args) => { if (++writes === 1) return store.write(...args); await collect(args[1]); return { size:args[2].size }; } });
  const service = new MediaUploads(db,dishonest,{ preparation:pipeline }),state = await ready(service);
  assert.equal(state.state,'quarantined'); assert.equal(state.failureCode,'SCAN_UNAVAILABLE'); assert.equal((await proofs()).length,0);
  const row = await rowFor(state.id); assert.equal(row.candidate_key,null); assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
});
test('candidate disk failure preserves original and exact retry uses a fresh fenced intent',async () => {
  let writes = 0;
  const broken = storeWith({ write:async (...args) => { if (++writes === 2) { args[1].destroy(); throw new Error('PRIVATE DISK DETAIL'); } return store.write(...args); } });
  const service = new MediaUploads(db,broken,{ preparation:pipeline }),state = await ready(service);
  assert.equal(state.state,'quarantined'); assert.equal(state.failureCode,'SCAN_UNAVAILABLE'); assert.equal((await proofs()).length,0);
  const failedKey = (await queryObjects()).find((r) => r.state === 'delete_pending').key;
  await uploads.cleanup(); const retry = await uploads.inspect(owner,input(state)),row = await rowFor(state.id);
  assert.equal(retry.state,'ready'); assert.notEqual(failedKey,row.candidate_key); assert.equal((await proofs()).length,1);
  await assert.rejects(store.write(failedKey,Readable.from([bytes],{ objectMode:false }),file));
  assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
});
test('post-write verification catches corrupted stored candidate before approval',async () => {
  let writes = 0;
  const corrupt = storeWith({ write:async (...args) => { const result = await store.write(...args); if (++writes === 2) await writeFile(join(root,`${args[0]}.blob`),Buffer.alloc(args[2].size)); return result; } });
  const service = new MediaUploads(db,corrupt,{ preparation:pipeline }),state = await ready(service);
  assert.equal(state.state,'quarantined'); assert.equal((await proofs()).length,0); assert.equal(returnedBytes.every((n) => n === 0),true);
});
test('proof and ready transition roll back together while persisted candidate remains recoverably tracked',async () => {
  const events = [],fast = new MediaUploads(db,store,{ preparation:pipeline,leaseMilliseconds:1500,operationTimeoutMilliseconds:1000,onStage:(event) => events.push(event) });
  const row = await quarantine(fast);
  await db.exec(`CREATE FUNCTION cb_test_preparation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'ready' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_preparation_failure BEFORE INSERT ON cb_media_events FOR EACH ROW EXECUTE FUNCTION cb_test_preparation_failure();`);
  try { await assert.rejects(fast.inspect(owner,input(row))); }
  finally { await db.exec('DROP TRIGGER cb_test_preparation_failure ON cb_media_events; DROP FUNCTION cb_test_preparation_failure();'); }
  assert.deepEqual(events.at(-1),{stage:'settlement',edge:'failed'});
  assert.equal(events.some((event) => event.stage === 'settlement' && event.edge === 'complete'),false);
  const claimed = await rowFor(row.id); assert.equal(claimed.state,'inspecting'); assert.equal((await proofs()).length,0);
  const persisted = await readFile(join(root,`${claimed.candidate_key}.blob`)); assert.equal(persisted.includes(Buffer.from(PRIVATE_MARKER)),false);
  assert.equal(returnedBytes.every((n) => n === 0),true);
  await delay(Math.max(0,new Date(claimed.lease_until).getTime()-Date.now()+50));
  assert.equal((await fast.cleanup()).removed,1); const recovered = await uploads.get(owner,{ conversationId:'room-a',uploadId:row.id });
  assert.equal(recovered.state,'quarantined'); assert.equal((await rowFor(row.id)).candidate_key,null);
  assert.equal((await uploads.inspect(owner,input(recovered))).state,'ready'); assert.equal((await proofs()).length,1);
});
test('committed response loss remains observable and does not duplicate evidence or a message on retry',async () => {
  let lost = true; const events = [];
  const wrapper = { async transaction(work) { const result = await db.transaction(work); if (lost && result?.state === 'ready') { lost = false; throw new Error('PRIVATE RESPONSE LOSS'); } return result; } };
  const service = new MediaUploads(wrapper,store,{ preparation:pipeline,onStage:(event) => events.push(event) }),received = await quarantine(service);
  await assert.rejects(service.inspect(owner,input(received))); const actual = await uploads.get(owner,{ conversationId:'room-a',uploadId:received.id });
  assert.equal(actual.state,'ready'); assert.equal((await proofs()).length,1);
  assert.deepEqual(events.at(-1),{stage:'settlement',edge:'failed'}); // Failed acknowledgement is not proof of rollback.
  await assert.rejects(service.inspect(owner,input(actual)),errorCode('UPLOAD_STATE'));
  const message = await attach(actual),chat = new Conversations(db);
  const retry = await chat.sendText(owner,{ conversationId:'room-a',clientId:`storage-message-${count}-0001`,body:'',attachments:[{ id:actual.id }] });
  assert.equal(retry.id,message.id); assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n,1); assert.equal((await proofs()).length,1);
});

test('observed queue preparation waits for real settlement and emits no private file or account fields',async () => {
  const events = [],entered = Promise.withResolvers(),release = Promise.withResolvers(); let done = false,changedCalls = 0;
  const onStage = (event) => { events.push(event); return Promise.reject(new Error('PRIVATE OBSERVER')); };
  const observedPipeline = new MediaPreparation({scanner:clam.scanner,preparer:job.preparer,onStage});
  const database = {transaction:(work) => db.transaction(async (tx) => {
    const result = await work(tx);
    if (result?.state === 'ready') { entered.resolve(); await release.promise; }
    return result;
  })};
  const options = {preparation:observedPipeline,onStage},service = new MediaUploads(database,store,options);
  options.onStage = () => changedCalls++;
  const received = await quarantine(service),pending = service.inspectNext().finally(() => { done = true; });
  try {
    await entered.promise; assert.equal(done,false); assert.deepEqual(events.at(-1),{stage:'settlement',edge:'begin'});
    release.resolve(); const result = await pending;
    assert.equal(result.status,'processed'); assert.equal(result.upload.state,'ready'); assert.equal(result.upload.id,received.id);
    assert.deepEqual(events,['queue-claim','source-open','source-scan','source-reopen','isolated-preparation','candidate-validation',
      'candidate-scan','candidate-write','candidate-verify','settlement'].flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}]));
    assert.equal(changedCalls,0); assert.equal((await proofs()).length,1); assert.equal((await rowFor(received.id)).state,'ready');
    for (const event of events) { assert.ok(Object.isFrozen(event)); assert.deepEqual(Object.keys(event),['stage','edge']); }
    const serialized = JSON.stringify(events);
    for (const secret of [PRIVATE_MARKER,file.name,file.sha256,root,owner.userId,owner.centerId,'room-a',received.id]) assert.equal(serialized.includes(secret),false);
  } finally { release.resolve(); await pending; }
});
test('cancel before candidate write fences both objects and a late worker cannot resurrect bytes',async (t) => {
  const entered = Promise.withResolvers(),release = Promise.withResolvers(); let writes = 0;
  t.after(() => release.resolve());
  const delayed = storeWith({ async write(...args) { if (++writes === 2) { entered.resolve(); await release.promise; } return store.write(...args); } });
  const service = new MediaUploads(db,delayed,{ preparation:pipeline }),received = await quarantine(service);
  const pending = assert.rejects(service.inspect(owner,input(received)),errorCode('UPLOAD_CONFLICT')); await entered.promise;
  const current = await uploads.get(owner,{ conversationId:'room-a',uploadId:received.id }),claimed = await rowFor(received.id);
  await uploads.cancel(owner,input(current)); assert.equal((await uploads.cleanup()).removed,2); release.resolve(); await pending;
  assert.equal((await proofs()).length,0); assert.equal((await rowFor(received.id)).state,'deleted'); assert.equal(returnedBytes.every((n) => n === 0),true);
  assert.equal((await readdir(root)).filter((name) => name.endsWith('.blob')).length,0);
  await assert.rejects(store.write(claimed.candidate_key,Readable.from([bytes],{ objectMode:false }),file));
});
test('expired inspection recovery replaces candidate intent and fences late post-write completion',async (t) => {
  const entered = Promise.withResolvers(),release = Promise.withResolvers(); let opens = 0;
  t.after(() => release.resolve());
  const delayed = storeWith({ async openVerified(...args) { if (++opens === 3) { entered.resolve(); await release.promise; } return store.openVerified(...args); } });
  const service = new MediaUploads(db,delayed,{ preparation:pipeline,leaseMilliseconds:1500,operationTimeoutMilliseconds:1000 });
  const received = await quarantine(service),pending = assert.rejects(service.inspect(owner,input(received)),errorCode('UPLOAD_CONFLICT')); await entered.promise;
  const old = await rowFor(received.id); await delay(Math.max(0,new Date(old.lease_until).getTime()-Date.now()+50));
  const current = await uploads.get(owner,{ conversationId:'room-a',uploadId:received.id });
  const readyRow = await uploads.inspect(owner,input(current)),row = await rowFor(received.id); assert.equal(readyRow.state,'ready');
  assert.notEqual(row.candidate_key,old.candidate_key); assert.equal((await uploads.cleanup()).removed,1);
  release.resolve(); await pending; assert.equal((await proofs()).length,1);
  assert.equal((await rowFor(row.id)).prepared_sha256,row.prepared_sha256);
});
test('active isolated job cancellation returns quarantine only after actual coordinator cleanup',async () => {
  const entered = Promise.withResolvers(); job.options.stall = true; job.options.started = () => entered.resolve();
  const received = await quarantine(),controller = new AbortController();
  const pending = uploads.inspect(owner,input(received),{ signal:controller.signal }); await entered.promise; controller.abort('PRIVATE REASON');
  const state = await pending; assert.equal(state.state,'quarantined'); assert.equal(state.failureCode,'SCAN_UNAVAILABLE');
  assert.equal(job.containers.size,0); assert.ok(job.calls.some((args) => args[0] === 'kill')); assert.equal((await proofs()).length,0);
  job.options.stall = false; assert.equal((await uploads.inspect(owner,input(state))).state,'ready');
});
test('aborted late verified source handle is closed without allowing another source read',async () => {
  const entered = Promise.withResolvers(),release = Promise.withResolvers(),closed = Promise.withResolvers(); let handle;
  const delayed = storeWith({ async openVerified(...args) { entered.resolve(); await release.promise; handle = await store.openVerified(...args); const close = handle.close.bind(handle);
    handle.close = async () => { await close(); closed.resolve(); }; return handle; } });
  const service = new MediaUploads(db,delayed,{ preparation:pipeline }),received = await quarantine(service),controller = new AbortController();
  const pending = service.inspect(owner,input(received),{ signal:controller.signal }); await entered.promise; controller.abort();
  const state = await pending; assert.equal(state.state,'quarantined'); release.resolve(); await closed.promise;
  assert.equal(handle.fd,-1); assert.equal(clam.scans.length,0); assert.equal((await proofs()).length,0);
});
test('source mutation between independent reads fails closed and cannot produce a derivative approval',async () => {
  let opens = 0;
  const changed = storeWith({ async openVerified(...args) { if (++opens === 2) await writeFile(join(root,`${args[0]}.blob`),Buffer.alloc(file.size)); return store.openVerified(...args); } });
  const service = new MediaUploads(db,changed,{ preparation:pipeline }),state = await ready(service);
  assert.equal(state.state,'quarantined'); assert.equal((await proofs()).length,0); assert.equal(clam.scans.length,1);
});
test('database freezes preparation evidence serving identity and both bound objects',async () => {
  const state = await ready(),row = await rowFor(state.id);
  for (const key of [row.object_key,row.candidate_key]) await assert.rejects(db.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]));
  for (const sql of ["UPDATE cb_media_preparations SET evidence = '{}' WHERE id = $1",'DELETE FROM cb_media_preparations WHERE id = $1']) await assert.rejects(db.query(sql,[row.preparation_id]));
  await assert.rejects(db.query(`UPDATE cb_media_uploads SET state = 'delete_pending',version = version + 1,prepared_sha256 = repeat('b',64) WHERE id = $1`,[row.id]));
  await attach(state);
  for (const key of [row.object_key,row.candidate_key]) await assert.rejects(db.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]));
  assert.equal((await rowFor(row.id)).state,'bound'); assert.equal((await proofs()).length,1);
});
test('cancellation cleanup removes both byte objects but retains the immutable preparation history',async () => {
  const state = await ready(),row = await rowFor(state.id); await uploads.cancel(owner,input(state));
  const cleaned = await uploads.cleanup(); assert.equal(cleaned.removed,2); assert.equal(cleaned.finalized,1);
  assert.equal((await proofs()).length,1); assert.equal((await rowFor(row.id)).preparation_id,row.preparation_id);
  assert.deepEqual(await uploads.cleanup(),{ removed:0,failed:0,finalized:0 });
  for (const key of [row.object_key,row.candidate_key]) await assert.rejects(store.write(key,Readable.from([bytes],{ objectMode:false }),file));
});
test('aggregate attachment budget also counts a larger derivative in JS and direct SQL',async () => {
  const files = [];
  for (let i = 0; i < 3; i++) {
    // Metadata-only SQL fixture: specifically NOT byte/decode/AV verification.
    const source = { type:'video/mp4',size:1,sha256:hash('SYNTHETIC-BUDGET') };
    const row = await uploads.reserve(owner,{ conversationId:'room-a',clientId:`larger-budget-${i}-0001`,file:{ name:'가상.mp4',...source } });
    const receiving = await uploads.claim(owner,input(row),'receive'),quarantined = await uploads.settle(owner,'room-a',receiving,{ state:'quarantined' });
    const inspecting = await uploads.claim(owner,input(quarantined),'inspect');
    files.push(await db.transaction((tx) => sealFixture(tx,inspecting,evidenceForManifest(source,{ ...source,size:50*1024**2 }))));
  }
  await assert.rejects(new Conversations(db).sendText(owner,{ conversationId:'room-a',clientId:'larger-budget-message',body:'',attachments:files.map(({ id }) => ({ id })) }),errorCode('ATTACHMENT_LIMIT'));
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,attachments_sealed)
      VALUES ('center-a','room-a','budget-direct',999,'guardian-a','budget-direct-request',repeat('a',64),'text','',false)`);
    for (const [ordinal,row] of files.entries()) {
      await tx.query(`UPDATE cb_media_uploads SET state = 'bound',version = version + 1,bound_message_id = 'budget-direct' WHERE id = $1`,[row.id]);
      await tx.query(`INSERT INTO cb_message_attachments VALUES ('center-a','room-a','budget-direct',$1,$2)`,[ordinal,row.id]);
    }
  }),(error) => error.code === '23514' && /budget exceeded/.test(error.message));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n,0);
});
