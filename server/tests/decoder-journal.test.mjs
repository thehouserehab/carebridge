import assert from 'node:assert/strict';
import { before,after,beforeEach,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { DecoderJobJournal } from '../decoder-journal.mjs';
import { migrate } from '../migrate.mjs';
const engine = 'synthetic-journal-engine-0001',image = `sha256:${'a'.repeat(64)}`,id = 'b'.repeat(64);
const config = { engineIdentity:engine,approvedImageId:image };
const unavailable = { code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' };
let db,a,b;
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE cb_decoder_jobs,cb_decoder_engines'); a = new DecoderJobJournal(db,config); b = new DecoderJobJournal(db,config); });
const expire = (run) => db.query("UPDATE cb_decoder_jobs SET lease_until = clock_timestamp()-interval '1 second' WHERE run = $1",[run]); // Test-only DB clock fixture.
async function attached(journal = a,containerId = id) {
  const reserved = await journal.reserve(randomUUID()),creating = await journal.creating(reserved); return journal.attach(creating,containerId);
}
test('durable receipt stores only opaque worker identity and lifecycle, never media fields',async () => {
  const r = await a.reserve(randomUUID()); assert.equal(r.phase,'reserved'); assert.ok(Object.isFrozen(r));
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'cb_decoder_jobs' ORDER BY ordinal_position")).rows.map((row) => row.column_name);
  assert.deepEqual(columns,['run','engine_id','image_id','owner_id','generation','phase','container_id','requires_recovery','lease_until','created_at','updated_at','closed_at']);
  assert.equal((await db.query('SELECT phase FROM cb_decoder_jobs WHERE run = $1',[r.run])).rows[0].phase,'reserved');
});
test('creating authorization precedes attachment; close never treats uncertain creation as absent',async () => {
  let r = await a.reserve(randomUUID()); await assert.rejects(a.attach(r,id),unavailable); await assert.rejects(a.close(r),unavailable);
  r = await a.creating(r); await assert.rejects(a.creating(r),unavailable); r = await a.take(r.run);
  await assert.rejects(a.close(r),unavailable); await assert.rejects(b.reserve(randomUUID()),unavailable);
  r = await a.attach(r,id); assert.equal(r.requiresRecovery,true); assert.equal((await a.close(r)).phase,'closed');
});
test('acknowledged cleanup is immutable and retryable but does not authorize create replay',async () => {
  const original = await attached(),taken = await a.take(original.run),closed = await a.close(taken);
  assert.equal(closed.phase,'closed'); assert.equal((await a.close(taken)).phase,'closed'); assert.equal((await b.take(closed.run)).phase,'closed');
  await assert.rejects(a.reserve(original.run),unavailable); await assert.rejects(a.attach(original,id),unavailable);
  for (const sql of ["UPDATE cb_decoder_jobs SET phase = 'creating' WHERE run = $1",'DELETE FROM cb_decoder_jobs WHERE run = $1'])
    await assert.rejects(db.query(sql,[original.run]),(error) => error.code === '23514');
});

test('closed container IDs cannot be reused on the same engine, while independent engines have separate identity spaces',async () => {
  const original=await attached();await a.close(await a.take(original.run));
  const reused=await b.creating(await b.reserve(randomUUID()));
  await assert.rejects(b.attach(reused,id),unavailable);
  assert.equal((await b.lookup(reused.run)).phase,'creating');
  assert.equal((await a.lookup(original.run)).phase,'closed');
  const independent=new DecoderJobJournal(db,{...config,engineIdentity:`${engine}-independent`});
  const fresh=await attached(independent,id);
  assert.equal(fresh.containerId,id);await independent.close(await independent.take(fresh.run));
  assert.equal((await independent.lookup(fresh.run)).phase,'closed');
});
test('shared engine capacity is bounded across separate owners and direct SQL',async () => {
  const first = await a.reserve(randomUUID()),second = await b.reserve(randomUUID());
  await assert.rejects(new DecoderJobJournal(db,config).reserve(randomUUID()),unavailable);
  await assert.rejects(db.query(`INSERT INTO cb_decoder_jobs(run,engine_id,image_id,owner_id,phase,lease_until)
    VALUES ($1,$2,$3,$4,'reserved',clock_timestamp()+interval '3 minutes')`,[randomUUID(),engine,image,randomUUID()]),(error) => error.code === '23514');
  await a.close(await a.take(first.run)); assert.equal((await b.reserve(randomUUID())).phase,'reserved');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_decoder_jobs WHERE phase <> 'closed'")).rows[0].n,2); assert.notEqual(first.ownerId,second.ownerId);
});
test('expired work still occupies capacity and blocks new work until recovery',async () => {
  const r = await a.reserve(randomUUID()); await expire(r.run);
  await assert.rejects(a.heartbeat(r),unavailable); await assert.rejects(b.reserve(randomUUID()),unavailable);
  const taken = await b.take(r.run); assert.equal(taken.generation,2); assert.notEqual(taken.ownerId,r.ownerId);
  await assert.rejects(a.creating(r),unavailable); await assert.rejects(a.close(r),unavailable);
  await b.close(taken); assert.equal((await a.reserve(randomUUID())).phase,'reserved');
});
test('unexpired owner cannot be stolen and renewal uses database time',async () => {
  const r = await attached(); await assert.rejects(b.take(r.run),unavailable);
  const before = (await db.query('SELECT lease_until FROM cb_decoder_jobs WHERE run = $1',[r.run])).rows[0].lease_until;
  await a.heartbeat(r);
  const after = (await db.query('SELECT lease_until FROM cb_decoder_jobs WHERE run = $1',[r.run])).rows[0].lease_until;
  assert.ok(after >= before); assert.deepEqual(await b.recoverable(),[]);
  assert.equal((await a.recoverable())[0].run,r.run);
});
test('recovery generation fences stale attach heartbeat and close after owner restarts',async () => {
  const old = await attached(); await expire(old.run); const recovering = await b.take(old.run);
  assert.equal(recovering.containerId,id); assert.equal(recovering.requiresRecovery,true);
  for (const operation of [() => a.heartbeat(old),() => a.attach(old,id),() => a.close(old)]) await assert.rejects(operation(),unavailable);
  await assert.rejects(b.heartbeat(recovering),unavailable); await assert.rejects(b.reserve(randomUUID()),unavailable);
  const checked = await b.attach(recovering,id); await b.close(checked); assert.equal((await b.reserve(randomUUID())).phase,'reserved');
});
test('container ID engine image capacity and receipt identity cannot silently change',async () => {
  const r = await attached(); await assert.rejects(a.attach(r,'c'.repeat(64)),unavailable);
  for (const change of [{ approvedImageId:`sha256:${'f'.repeat(64)}` },{ capacity:1 }]) await assert.rejects(new DecoderJobJournal(db,{ ...config,...change }).reserve(randomUUID()),unavailable);
  const wrongEngine = new DecoderJobJournal(db,{ ...config,engineIdentity:'other-synthetic-engine-0002' }); await assert.rejects(wrongEngine.take(r.run),unavailable);
  for (const change of [{ ownerId:randomUUID() },{ generation:2 },{ path:'/private' },{ run:'existing' }]) await assert.rejects(a.heartbeat({ ...r,...change }),unavailable);
  for (const sql of ['UPDATE cb_decoder_engines SET capacity = 1',"UPDATE cb_decoder_jobs SET container_id = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",'UPDATE cb_decoder_jobs SET generation = generation+2'])
    await assert.rejects(db.query(sql),(error) => error.code === '23514');
});
test('commit response loss retains persisted intent rather than fabricating rollback or duplicate create',async () => {
  const run = randomUUID(); let lost = true;
  const wrapper = { async transaction(work) { const result = await db.transaction(work); if (lost) { lost = false; throw new Error('PRIVATE COMMIT RESPONSE'); } return result; } };
  const journal = new DecoderJobJournal(wrapper,config); await assert.rejects(journal.reserve(run),unavailable);
  assert.equal((await journal.recoverable())[0].run,run); await assert.rejects(journal.reserve(run),unavailable);
  await journal.close(await journal.take(run)); assert.deepEqual(await journal.recoverable(),[]);
});
test('transaction rollback cannot leave partial engine or job receipt',async () => {
  const broken = { transaction: (work) => db.transaction(async (tx) => { await work(tx); throw new Error('PRIVATE TRANSACTION DETAIL'); }) };
  await assert.rejects(new DecoderJobJournal(broken,config).reserve(randomUUID()),unavailable);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_decoder_jobs')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_decoder_engines')).rows[0].n,0);
});
test('restored journal instances discover expired work from persistence without old instance memory',async () => {
  const r = await attached(); await expire(r.run);
  const replacement = new DecoderJobJournal(db,config),[pending] = await replacement.recoverable(); assert.equal(pending.run,r.run); assert.equal(pending.containerId,id);
  await replacement.close(await replacement.take(pending.run)); assert.deepEqual(await replacement.recoverable(),[]);
});
test('configuration and method inputs have no arbitrary IDs duration URLs or private fields',async () => {
  for (const change of [{ capacity:0 },{ capacity:3 },{ ownerId:'process' },{ approvedImageId:'latest' },{ engineIdentity:'http://remote' },
    { leaseMilliseconds:179999 },{ leaseMilliseconds:600001 }]) assert.throws(() => new DecoderJobJournal(db,{ ...config,...change }),TypeError);
  for (const run of [null,'existing','../private','12345678-1234-1234-8234-123456789abc']) { await assert.rejects(a.reserve(run),unavailable); await assert.rejects(a.take(run),unavailable); }
  await assert.rejects(a.recoverable({ limit:101 }),unavailable); await assert.rejects(a.recoverable({ limit:0 }),unavailable);
});
test('worker tables have no PUBLIC grants or links to clinical and account records',async () => {
  const { rows } = await db.query(`SELECT c.relname,a.grantee FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.relname IN ('cb_decoder_jobs','cb_decoder_engines') AND a.grantee = 0`);
  assert.deepEqual(rows,[]);
  const references = (await db.query(`SELECT ccu.table_name FROM information_schema.constraint_column_usage ccu
    JOIN information_schema.table_constraints tc ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.table_name IN ('cb_decoder_jobs','cb_decoder_engines') AND tc.constraint_type = 'FOREIGN KEY'`)).rows.map((row) => row.table_name);
  assert.ok(references.every((name) => name === 'cb_decoder_engines'));
});
