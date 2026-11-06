// Real PostgreSQL pools/concurrency. Synthetic manifests only: no file IO,
// scanner/decoder or physical-disk durability claim is made in these cases.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaUploads } from './media-uploads.mjs';
const IMAGE = 10485760;
const file = { name:'synthetic.png',type:'image/png',size:32,sha256:'a'.repeat(64) };
const noIO = { async write() { throw new Error('NO_TEST_FILE_IO'); },async openVerified() { throw new Error('NO_TEST_FILE_IO'); },async remove() { throw new Error('NO_TEST_FILE_IO'); } };
const input = (row) => ({ conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version });
function overlap() {
  const gate = Promise.withResolvers(); let entered = 0,timer;
  return async () => {
    if (++entered === 1) timer = setTimeout(() => gate.reject(new Error('SYNTHETIC_CONCURRENCY_TIMEOUT')),4000);
    if (entered === 2) { clearTimeout(timer); gate.resolve(); }
    await gate.promise;
  };
}
const gated = (db,enter) => ({ transaction: (work) => db.transaction(async (tx) => { await enter(); return work(tx); }) });
export function addMediaResourceNativeCases(check,databaseA,databaseB,fixture) {
  const query = (sql,args) => databaseB.transaction((tx) => tx.query(sql,args));
  const reserve = (service,actor,roomId,clientId) => service.reserve(actor,{ conversationId:roomId,clientId,file });
  async function limits(f,{ bytes = 100*IMAGE,pending = 100,rate = 100 } = {},db = databaseA,enter = async () => {}) {
    return db.transaction(async (tx) => { await enter(); return tx.query(`UPDATE cb_media_resource_limits SET revision = revision + 1,
      storage_bytes = $2,pending_uploads = $3,uploads_per_window = $4 WHERE center_id = $1`,[f.centerId,bytes,pending,rate]); });
  }
  async function secondRoom(f) {
    const roomId = f.roomId+'-other',childId = f.roomId+'-other-child';
    await databaseA.transaction(async (tx) => {
      await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[f.centerId,childId]);
      await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[f.centerId,roomId,childId]);
      for (const [actor,role] of [[f.guardian,'guardian'],[f.therapist,'therapist']])
        await tx.query('INSERT INTO cb_participants VALUES ($1,$2,$3,$4,true,1)',[f.centerId,roomId,actor.userId,role]);
    });
    return roomId;
  }
  async function concurrentReservations(f,room,expected) {
    const enter = overlap(),a = new MediaUploads(gated(databaseA,enter),noIO),b = new MediaUploads(gated(databaseB,enter),noIO);
    const clientIds = ['synthetic-resource-first','synthetic-resource-second'];
    const inputs = [[f.guardian,f.roomId],[f.therapist,room]];
    const results = await Promise.allSettled(inputs.map(([actor,roomId],index) => reserve(index ? b : a,actor,roomId,clientIds[index])));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length,1);
    const loser = results.findIndex((result) => result.status === 'rejected'),winner = 1-loser;
    assert.equal(results[loser].reason.code,expected);
    assert.equal((await query('SELECT count(*)::int AS n FROM cb_media_uploads WHERE center_id = $1',[f.centerId])).rows[0].n,1);
    assert.equal((await query('SELECT last_sequence FROM cb_conversations WHERE id = $1',[inputs[loser][1]])).rows[0].last_sequence,'0');
    return { loser,winner,inputs,clientIds,results };
  }
  check('native center capacity serializes distinct child rooms and preserves the denied client ID for retry',async () => {
    const f = await fixture('resourcecapacity'),room = await secondRoom(f); await limits(f,{ bytes:2*IMAGE });
    const result = await concurrentReservations(f,room,'CENTER_MEDIA_CAPACITY'),service = new MediaUploads(databaseA,noIO);
    await service.cancel(result.inputs[result.winner][0],input(result.results[result.winner].value));
    const retry = await reserve(service,...result.inputs[result.loser],result.clientIds[result.loser]);
    assert.equal(retry.replayed,false); assert.equal((await reserve(service,...result.inputs[result.loser],result.clientIds[result.loser])).id,retry.id);
    assert.equal(Number((await query('SELECT reserved_bytes FROM cb_media_resource_usage($1)',[f.centerId])).rows[0].reserved_bytes),2*IMAGE);
  });
  check('native center rate serializes different users and cancelled reservations still consume the window',async () => {
    const f = await fixture('resourcerate'),room = await secondRoom(f); await limits(f,{ rate:1 });
    const result = await concurrentReservations(f,room,'CENTER_MEDIA_RATE'),service = new MediaUploads(databaseA,noIO);
    const winner = result.results[result.winner].value;
    assert.equal((await reserve(service,...result.inputs[result.winner],result.clientIds[result.winner])).id,winner.id);
    await service.cancel(result.inputs[result.winner][0],input(winner));
    await assert.rejects(reserve(service,...result.inputs[result.loser],result.clientIds[result.loser]),(error) => error.code === 'CENTER_MEDIA_RATE');
  });
  check('native center backlog has one winner across rooms and cancellation makes one slot available',async () => {
    const f = await fixture('resourcebacklog'),room = await secondRoom(f); await limits(f,{ pending:1 });
    const result = await concurrentReservations(f,room,'CENTER_MEDIA_BACKLOG'),service = new MediaUploads(databaseA,noIO);
    await service.cancel(result.inputs[result.winner][0],input(result.results[result.winner].value));
    assert.equal((await reserve(service,...result.inputs[result.loser],result.clientIds[result.loser])).replayed,false);
    assert.equal(Number((await query('SELECT pending_count FROM cb_media_resource_usage($1)',[f.centerId])).rows[0].pending_count),1);
  });
  check('native policy shrink races admission without overcommitting capacity or leaving a partial revision',async () => {
    const f = await fixture('resourceshrink'),room = await secondRoom(f); await limits(f,{ bytes:4*IMAGE });
    const service = new MediaUploads(databaseA,noIO); await reserve(service,f.guardian,f.roomId,'synthetic-resource-existing');
    const enter = overlap(),contended = new MediaUploads(gated(databaseA,enter),noIO);
    const results = await Promise.allSettled([reserve(contended,f.guardian,room,'synthetic-resource-race'),limits(f,{ bytes:2*IMAGE },databaseB,enter)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length,1);
    if (results[0].status === 'rejected') assert.equal(results[0].reason.code,'CENTER_MEDIA_CAPACITY');
    else assert.equal(results[1].reason.constraint,'cb_media_resource_capacity');
    const policy = (await query('SELECT revision,storage_bytes FROM cb_media_resource_limits WHERE center_id = $1',[f.centerId])).rows[0];
    const usage = (await query('SELECT reserved_bytes FROM cb_media_resource_usage($1)',[f.centerId])).rows[0];
    assert(Number(usage.reserved_bytes) <= Number(policy.storage_bytes));
    assert.equal(policy.revision,results[1].status === 'fulfilled' ? 3 : 2);
  });
  check('native queue bypasses an older capacity-held center without consuming its attempt or blocking another center',async () => {
    const blocked = await fixture('resourceheld'); await limits(blocked,{ bytes:2*IMAGE });
    const service = new MediaUploads(databaseA,noIO);
    const row = await reserve(service,blocked.guardian,blocked.roomId,'synthetic-resource-held');
    const receiving = await service.claim(blocked.guardian,input(row),'receive');
    const quarantine = await service.settle(blocked.guardian,blocked.roomId,receiving,{ state:'quarantined' });
    const inspect = await service.claim(blocked.guardian,input(quarantine),'inspect');
    await service.settle(blocked.guardian,blocked.roomId,inspect,{ state:'quarantined',failure:'SCAN_UNAVAILABLE' });
    const old = (await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[row.id])).rows[0];
    await delay(Math.max(0,new Date(old.available_at).getTime()-Date.now()+40));
    const free = await fixture('resourcefree'),freeRow = await reserve(service,free.guardian,free.roomId,'synthetic-resource-free');
    const freeReceiving = await service.claim(free.guardian,input(freeRow),'receive');
    await service.settle(free.guardian,free.roomId,freeReceiving,{ state:'quarantined' });
    const next = await new MediaUploads(databaseB,noIO).claimNextInspection(); assert.equal(next.claimed.id,freeRow.id);
    assert.deepEqual((await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[row.id])).rows[0],old);
    await service.cancel(free.guardian,{ conversationId:free.roomId,uploadId:next.claimed.id,expectedVersion:next.claimed.version });
  });
}
