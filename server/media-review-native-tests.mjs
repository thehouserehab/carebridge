// Actual independent PostgreSQL connections and observed lock contention.
// Synthetic manifests/SQL evidence only; native file scanning is tested elsewhere.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaUploads } from './media-uploads.mjs';
import { MediaWorkReviews } from './media-work-reviews.mjs';
import { evidenceForManifest,sealFixture } from './media-storage-test-evidence.mjs';
const file = { name:'synthetic.png',type:'image/png',size:32,sha256:'a'.repeat(64) };
const noIO = { async write() { throw new Error('NO_TEST_FILE_IO'); },async openVerified() { throw new Error('NO_TEST_FILE_IO'); },async remove() { throw new Error('NO_TEST_FILE_IO'); } };
const input = (row) => ({ conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version });
function overlap() {
  const gate = Promise.withResolvers(); let entered = 0,timer;
  return async () => {
    if (++entered === 1) timer = setTimeout(() => gate.reject(new Error('SYNTHETIC_CONCURRENCY_TIMEOUT')),4000);
    if (entered === 2) { clearTimeout(timer); gate.resolve(); } await gate.promise;
  };
}
const gated = (db,enter) => ({ transaction:(work) => db.transaction(async (tx) => { await enter(); return work(tx); }) });
export function addMediaReviewNativeCases(check,databaseA,databaseB,fixture) {
  const query = (sql,args) => databaseB.transaction((tx) => tx.query(sql,args));
  const service = new MediaUploads(databaseA,noIO),a = new MediaWorkReviews(databaseA),b = new MediaWorkReviews(databaseB);
  const jobFor = async (id) => (await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
  const receipts = async (f) => (await query('SELECT count(*)::int AS n FROM cb_media_work_reviews WHERE center_id = $1',[f.centerId])).rows[0].n;
  const request = (f,row,clientId) => ({ conversationId:f.roomId,uploadId:row.id,clientId,expectedUploadVersion:row.version,
    expectedAttempts:5,reason:'ENGINE_RESTORED',confirmReinspection:true });
  async function blocked(label) {
    const f = await fixture(label); f.manager = { centerId:f.centerId,userId:`synthetic-manager-${label}` };
    await databaseA.transaction(async (tx) => {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[f.manager.userId]);
      await tx.query("INSERT INTO cb_memberships VALUES ($1,$2,'center',true)",[f.centerId,f.manager.userId]);
    });
    const pending = await service.reserve(f.guardian,{ conversationId:f.roomId,clientId:`synthetic-native-${label}`,file });
    const receiving = await service.claim(f.guardian,input(pending),'receive');
    let row = await service.settle(f.guardian,f.roomId,receiving,{ state:'quarantined' });
    for (let i = 0; i < 5; i++) {
      const claimed = await service.claim(f.guardian,input(row),'inspect');
      row = await service.settle(f.guardian,f.roomId,claimed,{ state:'quarantined',failure:'SCAN_UNAVAILABLE' });
    }
    assert.equal((await jobFor(row.id)).state,'blocked'); return { f,row };
  }
  async function complete(row,claim) {
    await databaseA.transaction((tx) => sealFixture(tx,claim,evidenceForManifest({ type:file.type,size:file.size,sha256:file.sha256 })));
    assert.equal((await jobFor(row.id)).state,'completed');
  }
  check('native identical concurrent reviews commit one immutable receipt and one additional attempt',async () => {
    const { f,row } = await blocked('reviewreplay'),enter = overlap(),wanted = request(f,row,'synthetic-review-replay');
    const results = await Promise.all([new MediaWorkReviews(gated(databaseA,enter)).resume(f.manager,wanted),
      new MediaWorkReviews(gated(databaseB,enter)).resume(f.manager,wanted)]);
    assert.equal(results[0].reviewId,results[1].reviewId); assert.equal(results.filter((r) => r.replayed).length,1);
    assert.equal(await receipts(f),1); const job = await jobFor(row.id); assert.equal(job.approved_retries,1); assert.equal(job.attempts,5);
    const claimed = await service.claim(f.guardian,input(row),'inspect'); await complete(row,claimed);
    assert.equal((await b.resume(f.manager,wanted)).replayed,true); assert.equal((await jobFor(row.id)).attempts,6);
    await query('UPDATE cb_memberships SET active = false WHERE user_id = $1',[f.manager.userId]);
    await assert.rejects(a.resume(f.manager,wanted),{ code:'NOT_FOUND' });
  });
  check('native different review IDs race for one grant without resetting or duplicating work',async () => {
    const { f,row } = await blocked('reviewdistinct'),enter = overlap();
    const results = await Promise.allSettled([new MediaWorkReviews(gated(databaseA,enter)).resume(f.manager,request(f,row,'synthetic-review-first')),
      new MediaWorkReviews(gated(databaseB,enter)).resume(f.manager,request(f,row,'synthetic-review-second'))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code,'MEDIA_REVIEW_NOT_REQUIRED');
    assert.equal(await receipts(f),1); assert.equal((await jobFor(row.id)).approved_retries,1); assert.equal((await jobFor(row.id)).attempts,5);
    const claimed = await service.claim(f.guardian,input(row),'inspect'); await complete(row,claimed);
  });
  check('native review waits on actual owner revocation and cannot commit after that authority disappears',async () => {
    const { f,row } = await blocked('reviewrevoked'),held = Promise.withResolvers(),release = Promise.withResolvers(),entered = Promise.withResolvers();
    const lock = databaseA.transaction(async (tx) => { await tx.query('UPDATE cb_users SET active = false WHERE id = $1',[f.guardian.userId]); held.resolve(); await release.promise; });
    const watched = { transaction:(work) => databaseB.transaction(async (tx) => {
      const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return work({ ...tx,query:(sql,args) => { const pending = tx.query(sql,args); if (sql.includes('FOR SHARE OF p, cm, u')) entered.resolve(pid); return pending; } });
    }) };
    let reviewing,timer;
    try {
      await held.promise; reviewing = new MediaWorkReviews(watched).resume(f.manager,request(f,row,'synthetic-review-revoked')).then((value) => ({ value }),(error) => ({ error }));
      timer = setTimeout(() => entered.reject(new Error('SYNTHETIC_OWNER_LOCK_TIMEOUT')),4000);
      const pid = await entered.promise; clearTimeout(timer); const deadline = Date.now()+2000; let contended = false;
      do {
        contended = (await query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',[pid])).rows[0].waiting;
        if (!contended) await delay(20);
      } while (!contended && Date.now() < deadline);
      assert.equal(contended,true);
    } finally { clearTimeout(timer); release.resolve(); await lock; }
    assert.equal((await reviewing).error?.code,'MEDIA_OWNER_UNAVAILABLE'); assert.equal(await receipts(f),0);
    assert.equal((await jobFor(row.id)).approved_retries,0); assert.equal((await jobFor(row.id)).state,'blocked');
  });
  check('native review receipt and grant roll back together and lost acknowledgment replays before exclusive sixth claim',async () => {
    const { f,row } = await blocked('reviewatomic'),wanted = request(f,row,'synthetic-review-atomic'),before = await jobFor(row.id);
    await databaseA.transaction((tx) => tx.exec(`CREATE FUNCTION cb_native_review_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.approved_retries > OLD.approved_retries THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER cb_native_review_failure BEFORE UPDATE ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_native_review_failure();`));
    try { await assert.rejects(a.resume(f.manager,wanted)); }
    finally { await databaseA.transaction((tx) => tx.exec('DROP TRIGGER cb_native_review_failure ON cb_media_work_queue; DROP FUNCTION cb_native_review_failure();')); }
    assert.equal(await receipts(f),0); assert.deepEqual(await jobFor(row.id),before);
    let lost = true;
    const uncertain = new MediaWorkReviews({ transaction:async (work) => { const result = await databaseA.transaction(work);
      if (lost && result?.reviewId) { lost = false; throw new Error('synthetic response loss'); } return result; } });
    await assert.rejects(uncertain.resume(f.manager,wanted)); assert.equal((await b.resume(f.manager,wanted)).replayed,true);
    assert.equal(await receipts(f),1);
    const enter = overlap(),claims = await Promise.allSettled([new MediaUploads(gated(databaseA,enter),noIO).claim(f.guardian,input(row),'inspect'),
      new MediaUploads(gated(databaseB,enter),noIO).claim(f.guardian,input(row),'inspect')]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length,1); assert.equal(claims.find((r) => r.status === 'rejected').reason.code,'UPLOAD_CONFLICT');
    assert.equal((await jobFor(row.id)).attempts,6); await complete(row,claims.find((r) => r.status === 'fulfilled').value);
  });
}
