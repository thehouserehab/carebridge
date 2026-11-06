// Actual local ClamAV + isolated native decoder + Linux private file IO and
// PGlite transaction composition. Synthetic files ONLY, no operating approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from './migrate.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { configureSyntheticMediaPolicy } from './media-resource-test-policy.mjs';
import { MediaWorkQueueWorker } from './media-work-queue-worker.mjs';
import { MediaWorkReviews } from './media-work-reviews.mjs';
import { MediaAccess } from './media-access.mjs';
import { Conversations } from './conversations.mjs';
import { syntheticPng,addPrivateMetadata,PRIVATE_MARKER } from './image-metadata-test-fixtures.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const input = (row) => ({ conversationId:'synthetic-storage-room',uploadId:row.id,expectedVersion:row.version });
const owner = { centerId:'synthetic-storage-center',userId:'synthetic-storage-guardian' };
const therapist = { centerId:owner.centerId,userId:'synthetic-storage-therapist' };
const manager = { centerId:owner.centerId,userId:'synthetic-storage-manager' };
export async function nativePreparationStorageCases(scenario,pipeline) {
  let db,directory,store,uploads,number = 0;
  const bytes = addPrivateMetadata(syntheticPng(),'image/png'),file = { name:'synthetic.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
  const rowFor = async (id) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
  const proofCount = async (id) => (await db.query('SELECT count(*)::int AS n FROM cb_media_preparations WHERE upload_id = $1',[id])).rows[0].n;
  const storeWith = (changes) => ({ write:store.write.bind(store),openVerified:store.openVerified.bind(store),remove:store.remove.bind(store),...changes });
  async function received(instance = uploads) {
    const row = await instance.reserve(owner,{ conversationId:'synthetic-storage-room',clientId:`native-storage-${++number}-0001`,file });
    return instance.receive(owner,input(row),Readable.from([bytes],{ objectMode:false }));
  }
  try {
    db = await PGlite.create(); await migrate(db);
    await db.exec(`INSERT INTO cb_centers VALUES ('synthetic-storage-center');
      INSERT INTO cb_users(id,active) VALUES ('synthetic-storage-guardian',true),('synthetic-storage-therapist',true),('synthetic-storage-manager',true);
      INSERT INTO cb_memberships VALUES ('synthetic-storage-center','synthetic-storage-guardian','guardian',true),('synthetic-storage-center','synthetic-storage-therapist','therapist',true),('synthetic-storage-center','synthetic-storage-manager','center',true);
      INSERT INTO cb_children VALUES ('synthetic-storage-center','synthetic-storage-child');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('synthetic-storage-center','synthetic-storage-room','synthetic-storage-child');
      INSERT INTO cb_participants VALUES ('synthetic-storage-center','synthetic-storage-room','synthetic-storage-guardian','guardian',true,1),('synthetic-storage-center','synthetic-storage-room','synthetic-storage-therapist','therapist',true,1);`);
    directory = await mkdtemp(join(tmpdir(),'carebridge-native-prepared-storage-')); store = new PrivateFileStore(directory); uploads = new MediaUploads(db,store,{ preparation:pipeline });
    await configureSyntheticMediaPolicy(db,'synthetic-storage-center');
    await scenario('explicit review after synthetic outage reruns native original candidate scans and commits one exact Linux storage proof',async () => {
      const source = await received(),job = (await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[source.id])).rows[0];
      assert.equal(job.state,'queued'); assert.equal(job.attempts,0);
      // Deliberately unavailable adapter, not five claimed native engine faults.
      const unavailable = new MediaUploads(db,store); let blocked = source;
      for (let i = 0; i < 5; i++) blocked = await unavailable.inspect(owner,input(blocked));
      assert.equal((await db.query('SELECT state FROM cb_media_work_queue WHERE upload_id = $1',[source.id])).rows[0].state,'blocked');
      const before = await rowFor(source.id);
      await new MediaWorkReviews(db).resume(manager,{ conversationId:'synthetic-storage-room',uploadId:source.id,clientId:'native-storage-explicit-review',
        expectedUploadVersion:blocked.version,expectedAttempts:5,reason:'CONFIGURATION_CORRECTED',confirmReinspection:true });
      assert.deepEqual(await rowFor(source.id),before); assert.equal(await proofCount(source.id),0);
      const result = await new MediaWorkQueueWorker(uploads,{ localTestMode:true }).runOne(),state = result.upload,row = await rowFor(state.id);
      assert.equal(result.status,'processed'); assert.equal(state.id,source.id);
      const completed = (await db.query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[source.id])).rows[0];
      assert.equal(completed.state,'completed'); assert.equal(completed.attempts,6); assert.equal(completed.approved_retries,1);
      assert.equal(state.state,'ready'); assert.equal(await proofCount(row.id),1); assert.notEqual(row.object_key,row.candidate_key);
      assert.deepEqual(await readFile(join(directory,`${row.object_key}.blob`)),bytes);
      const candidate = await readFile(join(directory,`${row.candidate_key}.blob`)); assert.equal(candidate.includes(Buffer.from(PRIVATE_MARKER)),false);
      assert.equal(hash(candidate),row.prepared_sha256); assert.equal(candidate.length,row.prepared_size);
      const evidence = (await db.query('SELECT evidence FROM cb_media_preparations WHERE id = $1',[row.preparation_id])).rows[0].evidence;
      assert.equal(evidence.sourceScan.verdict,'clean'); assert.equal(evidence.derivativeScan.verdict,'clean'); assert.equal(evidence.preparation.sourceDecode.media.width,32);
      assert.equal(evidence.preparation.sourceDecode.media.height,24); assert.equal(evidence.mediaAcceptanceReady,false);
    });
    await scenario('native bound message serves only exact candidate bytes and original attachment identity',async () => {
      const source = await received(),state = await uploads.inspect(owner,input(source)),row = await rowFor(state.id),chat = new Conversations(db);
      assert.equal(state.state,'ready'); const message = await chat.sendText(owner,{ conversationId:'synthetic-storage-room',clientId:'native-storage-message-01',body:'',attachments:[{ id:state.id }] });
      const access = new MediaAccess(db,store),request = { conversationId:'synthetic-storage-room',uploadId:state.id,source:{ kind:'message',messageId:message.id } };
      const opened = await access.open(therapist,request),candidate = await readFile(join(directory,`${row.candidate_key}.blob`));
      assert.deepEqual(await collect(opened.stream),candidate); assert.equal(opened.attachment.id,state.id); assert.equal(opened.attachment.size,candidate.length);
      const partial = await access.open(therapist,{ ...request,range:{ start:2,end:8 } }); assert.deepEqual(await collect(partial.stream),candidate.subarray(2,9));
      for (const key of [row.object_key,row.candidate_key]) await assert.rejects(db.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]));
    });
    await scenario('native successful scans cannot approve a missing candidate and retry stores a new intent',async () => {
      let writes = 0;
      const missing = storeWith({ async write(...args) { if (++writes === 2) { await collect(args[1]); return { size:args[2].size }; } return store.write(...args); } });
      const service = new MediaUploads(db,missing,{ preparation:pipeline }),source = await received(service),state = await service.inspect(owner,input(source));
      assert.equal(state.state,'quarantined'); assert.equal(state.failureCode,'SCAN_UNAVAILABLE'); assert.equal(await proofCount(source.id),0);
      const old = (await db.query("SELECT key FROM cb_media_objects WHERE upload_id = $1 AND state = 'delete_pending'",[source.id])).rows[0].key;
      await uploads.cleanup(); const retry = await uploads.inspect(owner,input(state)),row = await rowFor(source.id); assert.equal(retry.state,'ready');
      assert.notEqual(row.candidate_key,old); assert.equal(await proofCount(row.id),1); assert.deepEqual(await readFile(join(directory,`${row.object_key}.blob`)),bytes);
      await assert.rejects(store.write(old,Readable.from([bytes],{ objectMode:false }),file));
    });
    await scenario('native candidate bytes and failed DB approval stay tracked until lease recovery',async () => {
      const service = new MediaUploads(db,store,{ preparation:pipeline,leaseMilliseconds:15000,operationTimeoutMilliseconds:12000 }),source = await received(service);
      await db.exec(`CREATE FUNCTION cb_native_storage_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'ready' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER cb_native_storage_failure BEFORE INSERT ON cb_media_events FOR EACH ROW EXECUTE FUNCTION cb_native_storage_failure();`);
      try { await assert.rejects(service.inspect(owner,input(source))); }
      finally { await db.exec('DROP TRIGGER cb_native_storage_failure ON cb_media_events; DROP FUNCTION cb_native_storage_failure();'); }
      const row = await rowFor(source.id); assert.equal(row.state,'inspecting'); assert.equal(await proofCount(row.id),0);
      assert.equal((await readFile(join(directory,`${row.candidate_key}.blob`))).includes(Buffer.from(PRIVATE_MARKER)),false);
      await delay(Math.max(0,new Date(row.lease_until).getTime()-Date.now()+50)); await service.cleanup();
      const recovered = await uploads.get(owner,{ conversationId:'synthetic-storage-room',uploadId:row.id }); assert.equal(recovered.state,'quarantined');
      assert.equal((await uploads.inspect(owner,input(recovered))).state,'ready'); assert.equal(await proofCount(row.id),1);
    });
    await scenario('native corrupt serving bytes never fall back to healthy private original',async () => {
      const source = await received(),state = await uploads.inspect(owner,input(source)),row = await rowFor(state.id); assert.equal(state.state,'ready');
      await writeFile(join(directory,`${row.candidate_key}.blob`),Buffer.alloc(row.prepared_size));
      await assert.rejects(uploads.open(owner,{ conversationId:'synthetic-storage-room',uploadId:state.id }),(e) => e.code === 'CONTENT_UNAVAILABLE');
      assert.deepEqual(await readFile(join(directory,`${row.object_key}.blob`)),bytes);
    });
    await scenario('native cancel before candidate write preserves Linux deletion fences against late completion',async () => {
      const entered = Promise.withResolvers(),release = Promise.withResolvers(); let writes = 0;
      const delayed = storeWith({ async write(...args) { if (++writes === 2) { entered.resolve(); await release.promise; } return store.write(...args); } });
      const service = new MediaUploads(db,delayed,{ preparation:pipeline }),source = await received(service);
      const pending = service.inspect(owner,input(source)).then((value) => ({ value }),(error) => ({ error }));
      try {
        await entered.promise; const claimed = await rowFor(source.id); await uploads.cancel(owner,input(claimed)); await uploads.cleanup();
        for (const key of [claimed.object_key,claimed.candidate_key]) {
          assert.equal((await readdir(directory)).includes(`${key}.blocked`),true);
          await assert.rejects(store.write(key,Readable.from([bytes],{ objectMode:false }),file));
        }
      } finally { release.resolve(); }
      const result = await pending; assert.equal(result.error?.code,'UPLOAD_CONFLICT'); assert.equal(await proofCount(source.id),0);
      assert.equal((await rowFor(source.id)).state,'deleted');
    });
  } finally {
    await db?.close();
    if (directory) { const target = resolve(directory),rel = relative(resolve(tmpdir()),target);
      assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-native-prepared-storage-'));
      await rm(target,{ recursive:true,force:true }); }
  }
}
