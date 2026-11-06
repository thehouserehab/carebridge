// Explicit native PostgreSQL concurrency/constraint tests, not file/AV proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Conversations } from './conversations.mjs';
import { evidenceForManifest,sealFixture } from './media-storage-test-evidence.mjs';
const manifest = { type:'image/png',size:32,sha256:'a'.repeat(64) };
export function addMediaStorageNativeCases(check,databaseA,databaseB,fixture) {
  const query = (sql,args) => databaseB.transaction((tx) => tx.query(sql,args));
  async function stage(f,{ leaseMilliseconds = 15000 } = {}) {
    return databaseA.transaction(async (tx) => {
      const id = randomUUID(),sourceKey = randomUUID(),candidateKey = randomUUID(),leaseId = randomUUID();
      const counter = (await tx.query('UPDATE cb_conversations SET last_sequence = last_sequence + 1 WHERE id = $1 RETURNING last_sequence',[f.roomId])).rows[0];
      await tx.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ($1,$2,$3,$4,$3,repeat('b',64),'synthetic.png',$5,$6,$7,$8,clock_timestamp()+interval '1 hour')`,
      [f.centerId,f.roomId,id,f.guardian.userId,manifest.type,manifest.size,manifest.sha256,counter.last_sequence]);
      await tx.query('INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4),($5,$2,$3,$4)',[sourceKey,f.centerId,f.roomId,id,candidateKey]);
      await tx.query(`UPDATE cb_media_uploads SET state = 'receiving',version = 2,object_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '15 seconds' WHERE id = $1`,[id,sourceKey,leaseId]);
      await tx.query("UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1",[id]);
      return (await tx.query(`UPDATE cb_media_uploads SET state = 'inspecting',version = 4,candidate_key = $2,lease_id = $3,
        lease_until = clock_timestamp()+$4*interval '1 millisecond' WHERE id = $1 RETURNING *`,[id,candidateKey,leaseId,leaseMilliseconds])).rows[0];
    });
  }
  async function current(tx,row) {
    await tx.query('SELECT 1 FROM cb_conversations WHERE id = $1 FOR UPDATE',[row.conversation_id]);
    const actual = (await tx.query('SELECT * FROM cb_media_uploads WHERE id = $1 FOR UPDATE',[row.id])).rows[0];
    if (actual.version !== row.version || actual.lease_id !== row.lease_id || actual.state !== 'inspecting') throw new Error('SYNTHETIC_STALE_OWNER');
    return actual;
  }
  const proofCount = async (row) => (await query('SELECT count(*)::int AS n FROM cb_media_preparations WHERE upload_id = $1',[row.id])).rows[0].n;
  check('preparation evidence cannot commit without ready and rollback is visible from another native pool',async () => {
    const f = await fixture('mediaatomic'),row = await stage(f),evidence = evidenceForManifest(manifest);
    await assert.rejects(databaseA.transaction(async (tx) => {
      const prepared = await sealFixture(tx,row,evidence); assert.equal(prepared.state,'ready'); throw new Error('SYNTHETIC COMMIT FAILURE');
    }));
    assert.equal((await query('SELECT state FROM cb_media_uploads WHERE id = $1',[row.id])).rows[0].state,'inspecting'); assert.equal(await proofCount(row),0);
    await databaseB.transaction((tx) => sealFixture(tx,row,evidence)); assert.equal(await proofCount(row),1);
  });
  check('native approval and cancellation serialize with one winner and no mixed byte or evidence state',async () => {
    const f = await fixture('mediarace'),row = await stage(f),gate = Promise.withResolvers(); let arrivals = 0;
    const enter = async () => { if (++arrivals === 2) gate.resolve(); await gate.promise; };
    const results = await Promise.allSettled([
      databaseA.transaction(async (tx) => { await enter(); await current(tx,row); return sealFixture(tx,row,evidenceForManifest(manifest)); }),
      databaseB.transaction(async (tx) => { await enter(); await current(tx,row);
        await tx.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE upload_id = $1",[row.id]);
        return (await tx.query("UPDATE cb_media_uploads SET state = 'delete_pending',version = version + 1,lease_id = NULL,lease_until = NULL WHERE id = $1 RETURNING *",[row.id])).rows[0]; }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.message,'SYNTHETIC_STALE_OWNER');
    const actual = (await query('SELECT * FROM cb_media_uploads WHERE id = $1',[row.id])).rows[0],approved = actual.state === 'ready';
    assert.ok(['ready','delete_pending'].includes(actual.state)); assert.equal(await proofCount(row),approved ? 1 : 0);
    const objects = (await query('SELECT state FROM cb_media_objects WHERE upload_id = $1',[row.id])).rows;
    assert.equal(objects.length,2); assert.equal(objects.every((o) => o.state === (approved ? 'active' : 'delete_pending')),true);
  });
  check('expired inspection reclamation fences the previous native owner and its candidate proof',async () => {
    const f = await fixture('mediafence'),old = await stage(f,{ leaseMilliseconds:100 });
    const until = new Date(old.lease_until).getTime(); await new Promise((yes) => setTimeout(yes,Math.max(0,until-Date.now()+30)));
    const reclaim = (database) => database.transaction(async (tx) => {
      await current(tx,old); const candidate = randomUUID(),lease = randomUUID();
      await tx.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[old.candidate_key]);
      await tx.query('INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4)',[candidate,old.center_id,old.conversation_id,old.id]);
      return (await tx.query(`UPDATE cb_media_uploads SET version = version + 1,candidate_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '15 seconds' WHERE id = $1 RETURNING *`,[old.id,candidate,lease])).rows[0];
    });
    const results = await Promise.allSettled([reclaim(databaseA),reclaim(databaseB)]); assert.equal(results.filter((r) => r.status === 'fulfilled').length,1);
    const winner = results.find((r) => r.status === 'fulfilled').value;
    await assert.rejects(databaseA.transaction((tx) => sealFixture(tx,old,evidenceForManifest(manifest))),(error) => error.code === '23514');
    await databaseB.transaction((tx) => sealFixture(tx,winner,evidenceForManifest(manifest))); assert.equal(await proofCount(old),1);
    assert.equal((await query('SELECT state FROM cb_media_objects WHERE key = $1',[old.candidate_key])).rows[0].state,'delete_pending');
  });
  check('native immutable preparation and both retained bound object keys reject direct mutation',async () => {
    const f = await fixture('mediaimmutable'),row = await stage(f),approved = await databaseA.transaction((tx) => sealFixture(tx,row,evidenceForManifest(manifest)));
    for (const key of [row.object_key,row.candidate_key]) await assert.rejects(query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]),(e) => e.code === '23514');
    await assert.rejects(query("UPDATE cb_media_preparations SET evidence = '{}' WHERE id = $1",[approved.preparation_id]),(e) => e.code === '23514');
    const chat = new Conversations(databaseB),message = await chat.sendText(f.guardian,{ conversationId:f.roomId,clientId:'synthetic-native-media-message',body:'',attachments:[{ id:row.id }] });
    assert.equal(message.attachments[0].id,row.id);
    for (const key of [row.object_key,row.candidate_key]) await assert.rejects(query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[key]),(e) => e.code === '23514');
    assert.equal(await proofCount(row),1);
  });
  check('native committed approval response loss is independently observable without duplicate preparation',async () => {
    const f = await fixture('mediaresponse'),row = await stage(f);
    await assert.rejects((async () => { await databaseA.transaction((tx) => sealFixture(tx,row,evidenceForManifest(manifest))); throw new Error('SYNTHETIC LOST RESPONSE'); })());
    const actual = (await query('SELECT * FROM cb_media_uploads WHERE id = $1',[row.id])).rows[0]; assert.equal(actual.state,'ready'); assert.equal(await proofCount(row),1);
    await assert.rejects(databaseB.transaction((tx) => sealFixture(tx,row,evidenceForManifest(manifest))),(e) => e.code === '23514');
    assert.equal(await proofCount(row),1);
  });
}
