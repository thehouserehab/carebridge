// Actual PG connections / actual test child SIGKILL. Metadata and evidence are
// synthetic; no claim of native AV, physical disk or operating process recovery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaUploads } from './media-uploads.mjs';
import { evidenceForManifest,sealFixture } from './media-storage-test-evidence.mjs';
const manifest = { type:'image/png',size:32,sha256:'a'.repeat(64) };
const noIO = { async write() { throw new Error('NO_TEST_FILE_IO'); },async openVerified() { throw new Error('NO_TEST_FILE_IO'); },async remove() { throw new Error('NO_TEST_FILE_IO'); } };
export function addMediaQueueNativeCases(check,databaseA,databaseB,fixture,{ config,databaseName }) {
  const serviceA = new MediaUploads(databaseA,noIO),serviceB = new MediaUploads(databaseB,noIO);
  const query = (sql,args) => databaseB.transaction((tx) => tx.query(sql,args));
  const rowFor = async (id) => (await query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
  const jobFor = async (id) => (await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
  async function stage(f,{ quarantine = true } = {}) {
    return databaseA.transaction(async (tx) => {
      const id = randomUUID(),key = randomUUID(),lease = randomUUID();
      const seq = (await tx.query('UPDATE cb_conversations SET last_sequence = last_sequence + 1 WHERE id = $1 RETURNING last_sequence',[f.roomId])).rows[0].last_sequence;
      await tx.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ($1,$2,$3,$4,$3,repeat('b',64),'synthetic.png',$5,$6,$7,$8,clock_timestamp()+interval '1 hour')`,
      [f.centerId,f.roomId,id,f.guardian.userId,manifest.type,manifest.size,manifest.sha256,seq]);
      await tx.query('INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4)',[key,f.centerId,f.roomId,id]);
      await tx.query(`UPDATE cb_media_uploads SET state = 'receiving',version = 2,object_key = $2,lease_id = $3,
        lease_until = clock_timestamp()+interval '15 seconds' WHERE id = $1`,[id,key,lease]);
      if (quarantine) await tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1",[id]);
      return (await tx.query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
    });
  }
  async function complete(claim) {
    return databaseA.transaction((tx) => sealFixture(tx,claim.claimed,evidenceForManifest(manifest)));
  }
  async function cancelOldSyntheticJobs() {
    const { rows } = await query(`SELECT u.* FROM cb_media_uploads u JOIN cb_media_work_queue q ON
      (u.center_id,u.conversation_id,u.id) = (q.center_id,q.conversation_id,q.upload_id) WHERE q.state IN ('queued','retry')`);
    for (const row of rows) await serviceA.cancel({ centerId:row.center_id,userId:row.owner_id },
      { conversationId:row.conversation_id,uploadId:row.id,expectedVersion:row.version });
  }
  check('native upload receipt and durable queue insert roll back together',async () => {
    await cancelOldSyntheticJobs();
    const f = await fixture('queueatomic'),row = await stage(f,{ quarantine:false });
    await databaseA.transaction((tx) => tx.exec(`CREATE FUNCTION cb_native_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$;
      CREATE TRIGGER cb_native_queue_failure BEFORE INSERT ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_native_queue_failure();`));
    try { await assert.rejects(databaseA.transaction((tx) => tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1",[row.id]))); }
    finally { await databaseA.transaction((tx) => tx.exec('DROP TRIGGER cb_native_queue_failure ON cb_media_work_queue; DROP FUNCTION cb_native_queue_failure();')); }
    assert.equal((await rowFor(row.id)).state,'receiving'); assert.equal(await jobFor(row.id),undefined);
    await databaseA.transaction((tx) => tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1",[row.id]));
    const claimed = await serviceB.claimNextInspection(); assert.equal(claimed.claimed.id,row.id); await complete(claimed);
  });
  check('concurrent native queue workers claim one upload and one exact shared lease',async () => {
    const f = await fixture('queueconcurrent'),row = await stage(f);
    const claims = await Promise.all([serviceA.claimNextInspection(),serviceB.claimNextInspection()]);
    const claimed = claims.filter(Boolean); assert.equal(claimed.length,1); assert.equal(claimed[0].claimed.id,row.id);
    const job = await jobFor(row.id); assert.equal(job.state,'running'); assert.equal(job.attempts,1);
    assert.equal(job.lease_id,claimed[0].claimed.lease_id); assert.equal(job.upload_version,claimed[0].claimed.version);
    await complete(claimed[0]); assert.equal((await jobFor(row.id)).state,'completed');
  });
  check('native queue skips a locked room and advances another authorized child',async () => {
    const first = await fixture('queuelocked'),second = await fixture('queuefree'),a = await stage(first),b = await stage(second);
    const held = Promise.withResolvers(),release = Promise.withResolvers();
    const lock = databaseA.transaction(async (tx) => { await tx.query('SELECT 1 FROM cb_conversations WHERE id = $1 FOR UPDATE',[first.roomId]); held.resolve(); await release.promise; });
    let claimed;
    try { await held.promise; claimed = await serviceB.claimNextInspection(); assert.equal(claimed.claimed.id,b.id); }
    finally { release.resolve(); await lock; }
    await complete(claimed); const after = await serviceA.claimNextInspection(); assert.equal(after.claimed.id,a.id); await complete(after);
  });
  check('actual native queue child SIGKILL and expired lease resume through a new instance',async () => {
    const f = await fixture('queuekilled'),source = await stage(f),notice = Promise.withResolvers(),closed = Promise.withResolvers();
    const child = fork(new URL('./media-queue-native-child.mjs',import.meta.url),[],{
      env:{ CAREBRIDGE_QUEUE_TEST_CHILD:'synthetic-only' },stdio:['ignore','pipe','pipe','ipc'] });
    const timer = setTimeout(() => notice.reject(new Error('SYNTHETIC_CHILD_TIMEOUT')),5000);
    child.stdout.resume(); child.stderr.resume(); child.on('error',() => notice.reject(new Error('SYNTHETIC_CHILD_FAILED')));
    child.once('exit',(code,signal) => { closed.resolve({ code,signal }); notice.reject(new Error('SYNTHETIC_CHILD_EXITED')); });
    child.on('message',(message) => { if (message?.state === 'claimed') notice.resolve(); else notice.reject(new Error('SYNTHETIC_CHILD_CLAIM_FAILED')); });
    let old;
    try {
      child.send({ config,database:databaseName }); await notice.promise; old = await rowFor(source.id);
      assert.equal(old.state,'inspecting'); assert.equal((await jobFor(source.id)).state,'running');
    } finally { clearTimeout(timer); child.kill('SIGKILL'); const result = await closed.promise; assert.equal(result.signal,'SIGKILL'); }
    await delay(Math.max(0,new Date(old.lease_until).getTime()-Date.now()+40));
    await serviceB.cleanup(); const job = await jobFor(source.id); assert.equal(job.state,'retry');
    await assert.rejects(serviceA.settle(f.guardian,f.roomId,old,{ state:'quarantined' }),(error) => error.code === 'UPLOAD_CONFLICT');
    await delay(Math.max(0,new Date(job.available_at).getTime()-Date.now()+40));
    const fresh = await new MediaUploads(databaseB,noIO).claimNextInspection(); assert.equal(fresh.claimed.id,source.id);
    assert.notEqual(fresh.claimed.lease_id,old.lease_id); assert.notEqual(fresh.claimed.candidate_key,old.candidate_key);
    assert.equal((await jobFor(source.id)).attempts,2); await complete(fresh); assert.equal((await jobFor(source.id)).state,'completed');
  });
  check('native queue rechecks current membership and never dispatches a disabled owner',async () => {
    const f = await fixture('queuedisabled'),row = await stage(f);
    await query('UPDATE cb_users SET active = false WHERE id = $1',[f.guardian.userId]);
    assert.equal(await serviceB.claimNextInspection(),null); assert.equal((await jobFor(row.id)).attempts,0);
    assert.equal((await rowFor(row.id)).state,'quarantined');
  });
}
