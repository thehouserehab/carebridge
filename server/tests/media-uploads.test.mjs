import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { copyFile,mkdtemp,readFile,readdir,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';
import { rasterPng } from '../image-metadata-test-fixtures.mjs';
import { fromLegacyScanner } from './media-storage-fixtures.mjs';

let database,service,store,directory,privateRoot;
const owner = { centerId:'center-a',userId:'guardian-a' };
const therapist = { centerId:'center-a',userId:'therapist-a' };
const peer = { centerId:'center-a',userId:'guardian-other' };
const manager = { centerId:'center-a',userId:'manager-a' };
const foreign = { centerId:'center-b',userId:'therapist-b' };
// Generated/invented content, not a child's image. The scanner below is a test
// double: this suite does NOT validate a real decoder or anti-malware engine.
const bytes = rasterPng({ width:1,height:1 });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const file = (data = bytes,extra = {}) => ({ name:'가상 사진.png',type:'image/png',size:data.length,sha256:digest(data),...extra });
const code = (expected) => (error) => error instanceof RepositoryError && error.code === expected;
const collect = async (stream) => { const parts = []; for await (const chunk of stream) parts.push(chunk); return Buffer.concat(parts); };
const proof = (extra = {}) => ({ verdict:'clean',engine:'test-only',engineVersion:'1',policyVersion:'carebridge-media-v1',
  media:{ type:'image/png',width:1,height:1 },...extra });
const scanner = { async inspect({ stream }) { assert.deepEqual(await collect(stream),bytes); return proof(); } };
const input = (row) => ({ conversationId:'room-a',uploadId:row.id,expectedVersion:row.version });
async function reserve(extra = {},actor = owner,instance = service) {
  return instance.reserve(actor,{ conversationId:'room-a',clientId:'upload-request-0001',file:file(),...extra });
}
const get = (row,actor = owner,instance = service) => instance.get(actor,{ conversationId:'room-a',uploadId:row.id });
async function ready(instance = service,actor = owner) {
  const reserved = await reserve({},actor,instance);
  const received = await instance.receive(actor,input(reserved),Readable.from([bytes.subarray(0,5),bytes.subarray(5)]));
  assert.equal(received.state,'quarantined');
  return instance.inspect(actor,input(received));
}
async function ledger(row) {
  return (await database.query('SELECT * FROM cb_media_uploads WHERE id = $1',[row.id])).rows[0];
}
before(async () => {
  database = await PGlite.create(); await migrate(database);
  directory = await mkdtemp(join(tmpdir(),'carebridge-media-test-'));
});
after(async () => {
  await database?.close();
  const target = resolve(directory), base = resolve(tmpdir()), rel = relative(base,target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-media-test-'));
  await rm(target,{ recursive:true,force:true }); // Only the verified test-owned directory.
});
beforeEach(async () => {
  await database.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('guardian-other',true),('manager-a',true),('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','guardian-other','guardian',true),('center-a','manager-a','center',true),('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','guardian-other','guardian',true,1),('center-a','room-other','guardian-a','guardian',true,1),('center-b','room-b','therapist-b','therapist',true,1);`);
  privateRoot = join(directory,randomUUID());
  for (const center of ['center-a','center-b']) await configureSyntheticMediaPolicy(database,center);
  store = new PrivateFileStore(privateRoot);
  service = new MediaUploads(database,store,{ preparation:fromLegacyScanner(scanner) });
});

test('private upload streams to quarantine, requires trusted inspection, and returns only owner-preview metadata',{ timeout:15000 },async () => {
  const row = await ready();
  assert.equal(row.state,'ready'); assert.equal(row.version,5);
  const opened = await service.open(owner,{ conversationId:'room-a',uploadId:row.id });
  assert.deepEqual(await collect(opened.stream),bytes);
  assert.deepEqual(opened.attachment,{ id:row.id,name:file().name,type:'image/png',size:bytes.length });
  assert.equal(JSON.stringify(row).includes(privateRoot),false);
  for (const secret of ['sha256','leaseId','lease_id','object_key','scan_report','owner_id']) assert.equal(secret in row,false);
  const events = (await database.query('SELECT state,version FROM cb_media_events WHERE upload_id = $1 ORDER BY version',[row.id])).rows;
  assert.deepEqual(events.map((r) => r.state),['pending','receiving','quarantined','inspecting','ready']);
  const chat = (await database.query('SELECT * FROM cb_messages')).rows;
  assert.equal(chat.length,0); // Reserving/inspecting does not emit a public card.
});

test('reservation retries are stable across processes and cannot be reused with different manifests or rooms',async () => {
  const first = await reserve(), retry = await reserve({},owner,new MediaUploads(database,store));
  assert.equal(retry.id,first.id); assert.equal(retry.replayed,true);
  assert.equal((await database.query('SELECT last_sequence FROM cb_conversations WHERE id = $1',['room-a'])).rows[0].last_sequence,1);
  await assert.rejects(reserve({ file:file(bytes,{ name:'다른 이름.png' }) }),code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(reserve({ conversationId:'room-other' }),code('IDEMPOTENCY_CONFLICT'));
  const received = await service.receive(owner,input(first),Readable.from([bytes]));
  await assert.rejects(service.receive(owner,input(first),Readable.from([bytes])),code('UPLOAD_CONFLICT'));
  const retried = await reserve();
  assert.equal(retried.version,received.version); assert.equal(retried.state,'quarantined');
});

test('center, other participants, foreign identities and forged roles cannot inspect or preview another owner staging file',async () => {
  const row = await ready();
  for (const actor of [peer,therapist,manager,foreign]) {
    await assert.rejects(get(row,{ ...actor,role:'guardian' }),code('NOT_FOUND'));
    await assert.rejects(service.open(actor,{ conversationId:'room-a',uploadId:row.id }),code('NOT_FOUND'));
    await assert.rejects(service.cancel(actor,input(row)),code('NOT_FOUND'));
  }
  await assert.rejects(reserve({},manager),code('NOT_FOUND'));
  await database.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]);
  await assert.rejects(get(row),code('NOT_FOUND'));
});

test('participant removal and from_now reattachment do not restore the owner previous private upload',async () => {
  const row = await ready(), relations = new Relationships(database);
  let current = await relations.get(manager,{ conversationId:'room-a' });
  await relations.replace(manager,{ conversationId:'room-a',clientId:'relationship-remove-1',expectedVersion:current.version,historyConfirmed:true,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[] });
  await assert.rejects(get(row),code('NOT_FOUND'));
  current = await relations.get(manager,{ conversationId:'room-a' });
  await relations.replace(manager,{ conversationId:'room-a',clientId:'relationship-readd-01',expectedVersion:current.version,historyConfirmed:true,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[{ userId:owner.userId,history:'from_now' }] });
  await assert.rejects(get(row),code('NOT_FOUND'));
  await assert.rejects(reserve(),code('NOT_FOUND'));
  const newRow = await reserve({ clientId:'fresh-upload-request-1' });
  assert.notEqual(newRow.id,row.id);
});

test('malformed name/type/size/hash/range inputs and coerced metadata are rejected without reserving objects',async () => {
  for (const change of [{ name:'../secret.png' },{ name:'bad\nname.png' },{ name:'bad\ud800name.png' },{ name:'' },{ type:'image/svg+xml' },{ size:0 },{ size:'70' },
    { size:10 * 1024 ** 2 + 1 },{ sha256:'bad' },{ extra:true }])
    await assert.rejects(reserve({ file:file(bytes,change) }),code('INVALID_INPUT'));
  assert.equal((await database.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n,0);
  const row = await ready();
  for (const range of [{ start:-1 },{ start:'0' },{ start:2,end:1 },{ start:0,extra:true }])
    await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id,range }),code('INVALID_INPUT'));
  await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id,range:{ start:bytes.length } }),code('INVALID_RANGE'));
  const partial = await service.open(owner,{ conversationId:'room-a',uploadId:row.id,range:{ start:2,end:7 } });
  assert.deepEqual(await collect(partial.stream),bytes.subarray(2,8));
});

test('declared byte count/hash/signature are verified against the full stream, never the browser metadata alone',async () => {
  const cases = [
    { body:Buffer.concat([bytes,Buffer.from('x')]), metadata:file(),reason:'SIZE_MISMATCH' },
    { body:bytes.subarray(0,-1),metadata:file(),reason:'SIZE_MISMATCH' },
    { body:Buffer.from(bytes).fill(0,30,31),metadata:file(),reason:'HASH_MISMATCH' },
    { body:Buffer.alloc(50),metadata:file(Buffer.alloc(50)),reason:'FORMAT_MISMATCH' },
  ];
  for (const [i,scenario] of cases.entries()) {
    const row = await reserve({ clientId:`invalid-upload-case-${i}`,file:scenario.metadata });
    const rejected = await service.receive(owner,input(row),Readable.from([scenario.body]));
    assert.equal(rejected.state,'rejected'); assert.equal(rejected.failureCode,scenario.reason);
    await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id }),code('UPLOAD_STATE'));
  }
  assert.equal((await readdir(privateRoot)).filter((p) => p.endsWith('.blob')).length,0);
  assert.equal((await service.cleanup()).removed,4);
});

test('an interrupted stream keeps the same manifest for retry and cleans the earlier partial object',async () => {
  const row = await reserve();
  const failed = await service.receive(owner,input(row),Readable.from((async function* () { yield bytes.subarray(0,8); throw new Error('PRIVATE-INPUT-ERROR'); })()));
  assert.equal(failed.state,'pending'); assert.equal(failed.failureCode,'UPLOAD_INTERRUPTED');
  assert.equal(JSON.stringify(failed).includes('PRIVATE-'),false);
  const received = await service.receive(owner,input(failed),Readable.from([bytes]));
  const inspected = await service.inspect(owner,input(received));
  assert.equal(inspected.state,'ready');
  assert.equal((await service.cleanup()).removed,1);
  assert.deepEqual(await collect((await service.open(owner,{ conversationId:'room-a',uploadId:row.id })).stream),bytes);
});

test('missing, failing or incomplete scanner leaves bytes quarantined; valid rejection never becomes previewable',async () => {
  const row = await reserve(), received = await service.receive(owner,input(row),Readable.from([bytes]));
  let current = await new MediaUploads(database,store).inspect(owner,input(received));
  assert.equal(current.state,'quarantined'); assert.equal(current.failureCode,'SCAN_UNAVAILABLE');
  const broken = new MediaUploads(database,store,{ preparation:fromLegacyScanner({ inspect:async () => { throw new Error('PRIVATE-SCANNER-DETAIL'); } }) });
  current = await broken.inspect(owner,input(current));
  assert.equal(current.failureCode,'SCAN_UNAVAILABLE');
  const incomplete = new MediaUploads(database,store,{ preparation:fromLegacyScanner({ inspect:async () => ({ verdict:'clean' }) }) });
  current = await incomplete.inspect(owner,input(current));
  assert.equal(current.failureCode,'SCAN_INVALID');
  const rejecting = new MediaUploads(database,store,{ preparation:fromLegacyScanner({ inspect:async () => proof({ verdict:'rejected' }) }) });
  current = await rejecting.inspect(owner,input(current));
  assert.equal(current.state,'rejected'); assert.equal(current.failureCode,'SCAN_REJECTED');
  await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id }),code('UPLOAD_STATE'));
  assert.equal(JSON.stringify(current).includes('PRIVATE-'),false);
});

test('scanner policy requires decoded MIME, bounded dimensions and finite bounded video duration',async () => {
  const row = await reserve(), received = await service.receive(owner,input(row),Readable.from([bytes]));
  let current = received;
  for (const report of [proof({ policyVersion:'untrusted' }),proof({ media:{ type:'image/jpeg',width:1,height:1 } }),
    proof({ media:{ type:'image/png',width:0,height:1 } }),proof({ media:{ type:'image/png',width:8192,height:8192 } })]) {
    current = await new MediaUploads(database,store,{ preparation:fromLegacyScanner({ inspect:async () => report }) }).inspect(owner,input(current));
    assert.equal(current.state,'quarantined'); assert.equal(current.failureCode,'SCAN_INVALID');
  }
  const video = Buffer.from([0,0,0,12,102,116,121,112,105,115,111,109]);
  const vrow = await reserve({ clientId:'video-upload-request-01',file:file(video,{ name:'가상 영상.mp4',type:'video/mp4' }) });
  let vcurrent = await service.receive(owner,input(vrow),Readable.from([video]));
  for (const duration of [undefined,Infinity,0,601,'10']) {
    const adapter = { inspect:async () => proof({ media:{ type:'video/mp4',width:2,height:2,duration } }) };
    vcurrent = await new MediaUploads(database,store,{ preparation:fromLegacyScanner(adapter) }).inspect(owner,input(vcurrent));
    assert.equal(vcurrent.failureCode,'SCAN_INVALID');
  }
});

test('scanner timeout returns to quarantine without exposing adapter errors or retaining its file handle',async () => {
  const row = await reserve(), received = await service.receive(owner,input(row),Readable.from([bytes]));
  const slow = new MediaUploads(database,store,{ operationTimeoutMilliseconds:50,leaseMilliseconds:800,
    preparation:fromLegacyScanner({ inspect:async () => { await new Promise((r) => setTimeout(r,150)); return proof(); } }) });
  const current = await slow.inspect(owner,input(received));
  assert.equal(current.state,'quarantined'); assert.equal(current.failureCode,'SCAN_UNAVAILABLE');
  assert.equal((await service.inspect(owner,input(current))).state,'ready');
});

test('post-write DB failure retains a tracked private object and allows bounded lease recovery, never a false success',async () => {
  const fast = new MediaUploads(database,store,{ preparation:fromLegacyScanner(scanner),leaseMilliseconds:300,operationTimeoutMilliseconds:100 });
  const row = await reserve({},owner,fast);
  await database.exec(`CREATE FUNCTION cb_test_settle_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state = 'quarantined' THEN RAISE EXCEPTION 'test settle failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_settle_failure BEFORE INSERT ON cb_media_events FOR EACH ROW EXECUTE FUNCTION cb_test_settle_failure();`);
  try { await assert.rejects(fast.receive(owner,input(row),Readable.from([bytes]))); }
  finally { await database.exec('DROP TRIGGER cb_test_settle_failure ON cb_media_events; DROP FUNCTION cb_test_settle_failure();'); }
  const current = await get(row), claimed = await ledger(row);
  assert.equal(current.state,'receiving'); assert.equal(current.version,2);
  assert.deepEqual(await readFile(join(privateRoot,`${claimed.object_key}.blob`)),bytes);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM cb_media_objects WHERE upload_id = $1',[row.id])).rows[0].n,1);
  await new Promise((r) => setTimeout(r,350));
  const received = await fast.receive(owner,input(current),Readable.from([bytes]));
  assert.equal((await service.inspect(owner,input(received))).state,'ready');
  assert.equal((await fast.cleanup()).removed,1);
});

test('preview verifies stored bytes and rechecks authorization after IO before returning a stream',async () => {
  const row = await ready(), original = await ledger(row);
  await writeFile(join(privateRoot,`${original.candidate_key}.blob`),Buffer.alloc(bytes.length));
  await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id }),code('CONTENT_UNAVAILABLE'));
  await writeFile(join(privateRoot,`${original.candidate_key}.blob`),bytes);
  let handle;
  const restricted = new MediaUploads(database,{ write:store.write.bind(store),remove:store.remove.bind(store),
    openVerified:async (...args) => {
      handle = await store.openVerified(...args);
      await database.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]);
      return handle;
    } });
  await assert.rejects(restricted.open(owner,{ conversationId:'room-a',uploadId:row.id }),code('NOT_FOUND'));
  assert.equal(handle.fd,-1);
});

test('staging byte quota is enforced independently of count and readiness transitions require complete DB proof',async () => {
  const large = file(bytes,{ type:'video/mp4',name:'가상 영상.mp4',size:50 * 1024 ** 2 });
  for (let i = 0; i < 6; i++) await reserve({ clientId:`byte-quota-request-${i}`,file:large });
  await assert.rejects(reserve({ clientId:'byte-quota-request-last',file:large }),code('UPLOAD_QUOTA'));
  const first = await reserve({ clientId:'byte-quota-request-0',file:large });
  await service.cancel(owner,input(first));
  const row = await reserve(), received = await service.receive(owner,input(row),Readable.from([bytes]));
  const claimed = await service.claim(owner,input(received),'inspect');
  for (const report of [{ verdict:'clean' },proof({ media:{ type:'image/png',width:0,height:1 } })])
    await assert.rejects(database.query(`UPDATE cb_media_uploads SET state = 'ready',version = version + 1,lease_id = NULL,
      lease_until = NULL,scan_report = $2 WHERE id = $1`,[row.id,JSON.stringify(report)]));
  assert.equal((await get(row)).version,claimed.version);
});

test('cancel marks a deletion intent, cleanup retries storage faults, and identical cancellation is harmless',async () => {
  const row = await ready();
  const cancel = await service.cancel(owner,input(row)); assert.equal(cancel.state,'delete_pending');
  assert.deepEqual(await service.cancel(owner,input(row)),cancel);
  await assert.rejects(service.open(owner,{ conversationId:'room-a',uploadId:row.id }),code('UPLOAD_STATE'));
  const faulty = new MediaUploads(database,{ write:store.write.bind(store),openVerified:store.openVerified.bind(store),remove:async () => { throw new Error('PRIVATE-STORAGE-ERROR'); } });
  assert.equal((await faulty.cleanup()).failed,2); assert.equal((await get(row)).state,'delete_pending');
  assert.equal((await service.cleanup()).removed,2); assert.equal((await get(row)).state,'deleted');
  assert.deepEqual(await service.cleanup(),{ removed:0,failed:0,finalized:0 });
  assert.equal((await reserve()).state,'deleted'); // Old request never resurrects bytes.
});

test('object deletion fences a receive that was claimed but has not started filesystem writing',async () => {
  const row = await reserve(), claim = await service.claim(owner,input(row),'receive');
  const cancelled = await service.cancel(owner,input({ ...row,version:claim.version }));
  assert.equal(cancelled.state,'delete_pending');
  await service.cleanup();
  await assert.rejects(store.write(claim.object_key,Readable.from([bytes]),claim));
  assert.equal((await readdir(privateRoot)).filter((p) => p.endsWith('.blob')).length,0);
  await assert.rejects(service.settle(owner,'room-a',claim,{ state:'quarantined' }),code('UPLOAD_CONFLICT'));
  assert.equal((await get(row)).state,'deleted');
});

test('expired receiving lease can be reclaimed; old worker completion cannot change a newer upload',async () => {
  const fast = new MediaUploads(database,store,{ preparation:fromLegacyScanner(scanner),leaseMilliseconds:300,operationTimeoutMilliseconds:100 });
  const row = await reserve({},owner,fast), claim = await fast.claim(owner,input(row),'receive');
  await new Promise((r) => setTimeout(r,350));
  const current = await get(row), received = await fast.receive(owner,input(current),Readable.from([bytes]));
  await assert.rejects(fast.settle(owner,'room-a',claim,{ state:'quarantined' }),code('UPLOAD_CONFLICT'));
  assert.equal((await service.inspect(owner,input(received))).state,'ready');
  assert.equal((await fast.cleanup()).removed,1);
  await assert.rejects(store.write(claim.object_key,Readable.from([bytes]),claim));
});

test('expiration cleanup works after account removal without granting the maintenance worker clinical access',async () => {
  const fast = new MediaUploads(database,store,{ ttlMilliseconds:100,leaseMilliseconds:300,operationTimeoutMilliseconds:100 });
  const row = await reserve({},owner,fast);
  await new Promise((r) => setTimeout(r,150));
  await assert.rejects(fast.receive(owner,input(row),Readable.from([bytes])),code('UPLOAD_EXPIRED'));
  assert.equal((await get(row)).expired,true);
  await database.query('UPDATE cb_users SET active = false WHERE id = $1',[owner.userId]);
  const outcome = await fast.cleanup(); assert.equal(outcome.finalized,1);
  assert.equal((await ledger(row)).state,'deleted');
});

test('unbound staging quota is checked before sequence allocation and cancellation releases it',async () => {
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push(await reserve({ clientId:`quota-upload-request-${i}` }));
  const before = (await database.query('SELECT last_sequence FROM cb_conversations WHERE id = $1',['room-a'])).rows[0];
  await assert.rejects(reserve({ clientId:'quota-upload-request-last' }),code('UPLOAD_QUOTA'));
  assert.deepEqual((await database.query('SELECT last_sequence FROM cb_conversations WHERE id = $1',['room-a'])).rows[0],before);
  await service.cancel(owner,input(rows[0]));
  assert.equal((await reserve({ clientId:'quota-upload-request-last' })).state,'pending');
});

test('private store refuses overwrite, traversal/public directories, corrupted bytes and durable delete resurrection',async () => {
  const key = randomUUID();
  await store.write(key,Readable.from([bytes]),file());
  await assert.rejects(store.write(key,Readable.from([Buffer.alloc(bytes.length)]),file()));
  assert.deepEqual(await readFile(join(privateRoot,`${key}.blob`)),bytes);
  await assert.rejects(store.remove('../outside'),code('INVALID_INPUT'));
  assert.throws(() => new PrivateFileStore(process.cwd()),/outside/);
  assert.throws(() => new PrivateFileStore(tmpdir()),/dedicated/);
  await writeFile(join(privateRoot,`${key}.blob`),Buffer.alloc(bytes.length)); // Deliberate corruption of test-owned storage.
  await assert.rejects(store.openVerified(key,file()),code('CONTENT_UNAVAILABLE'));
  await store.remove(key); await store.remove(key);
  await assert.rejects(store.write(key,Readable.from([bytes]),file()));
});

test('private store refuses junction/symlink roots and never deletes a symlink target',async (t) => {
  const linkedRoot = join(directory,`${randomUUID()}-linked`);
  await store.checkRoot();
  try { await symlink(privateRoot,linkedRoot,process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM','EACCES'].includes(error.code)) { t.skip('OS does not allow creating a test junction/symlink.'); return; } throw error; }
  await assert.rejects(new PrivateFileStore(linkedRoot).write(randomUUID(),Readable.from([bytes]),file()),code('STORAGE_UNAVAILABLE'));
});

test('reserve/state events roll back atomically and database guards reject mutable manifests, proof bypass and altered history',async () => {
  await database.exec(`CREATE FUNCTION cb_test_media_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test event failure'; END; $$;
    CREATE TRIGGER cb_test_media_failure BEFORE INSERT ON cb_media_events FOR EACH ROW EXECUTE FUNCTION cb_test_media_failure();`);
  try { await assert.rejects(reserve()); }
  finally { await database.exec('DROP TRIGGER cb_test_media_failure ON cb_media_events; DROP FUNCTION cb_test_media_failure();'); }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n,0);
  assert.equal((await database.query('SELECT last_sequence FROM cb_conversations WHERE id = $1',['room-a'])).rows[0].last_sequence,0);
  const row = await reserve();
  await assert.rejects(database.query(`UPDATE cb_media_uploads SET name = '다른 이름.png',version = version + 1 WHERE id = $1`,[row.id]));
  await assert.rejects(database.query(`UPDATE cb_media_uploads SET state = 'ready',version = version + 1 WHERE id = $1`,[row.id]));
  await assert.rejects(database.query(`DELETE FROM cb_media_events WHERE upload_id = $1`,[row.id]));
  await assert.rejects(database.query(`DELETE FROM cb_media_uploads WHERE id = $1`,[row.id]));
  assert.equal((await get(row)).version,1);
});

test('008 adds empty upload storage without manufacturing files or changing 007 clinical data',async () => {
  const legacy = await PGlite.create(), migrations = join(directory,`${randomUUID()}-migrations`);
  const { mkdir } = await import('node:fs/promises'); await mkdir(migrations);
  try {
    for (const name of ['001-conversations.sql','002-authentication.sql','003-invitations.sql','004-relationships.sql','005-records.sql','006-activity-feedback.sql','007-care-contexts.sql'])
      await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrations,name));
    await migrate(legacy,pathToFileURL(`${migrations}/`));
    await legacy.exec(`INSERT INTO cb_centers(id) VALUES ('legacy-center'); INSERT INTO cb_users(id,active) VALUES ('legacy-user',true);
      INSERT INTO cb_memberships VALUES ('legacy-center','legacy-user','therapist',true);
      INSERT INTO cb_children VALUES ('legacy-center','legacy-child');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('legacy-center','legacy-room','legacy-child');
      INSERT INTO cb_participants VALUES ('legacy-center','legacy-room','legacy-user','therapist',true,1);
      INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('legacy-center','legacy-room','legacy-goal','기존 가상 목표','active');`);
    const before = await legacy.query('SELECT * FROM cb_goal_revisions');
    assert.deepEqual(await migrate(legacy),['008-media-uploads.sql','009-media-bindings.sql','010-profiles.sql','011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual(await legacy.query('SELECT * FROM cb_goal_revisions'),before);
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n,0);
    assert.deepEqual(await migrate(legacy),[]);
  } finally { await legacy.close(); }
});
