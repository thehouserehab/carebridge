// Explicit native PostgreSQL synthetic ledger tests, NOT Docker/decoder tests.
// Container IDs/engine identities below are opaque invented receipt fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DecoderJobJournal } from './decoder-journal.mjs';
const unavailable = { code:'SCAN_UNAVAILABLE',message:'SCAN_UNAVAILABLE' };
function stores(a,b) {
  const config = { engineIdentity:`synthetic-journal-${randomUUID()}`,approvedImageId:`sha256:${'a'.repeat(64)}` };
  return [new DecoderJobJournal(a,config),new DecoderJobJournal(b,config),config];
}
export function addDecoderJournalNativeCases(check,databaseA,databaseB) {
  check('journal serializes global capacity across independent native DB pools',async () => {
    const [a,b] = stores(databaseA,databaseB);
    const results = await Promise.allSettled(Array.from({ length:8 },(_,at) => (at % 2 ? a : b).reserve(randomUUID())));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length,2);
    for (const result of results.filter((r) => r.status === 'rejected')) assert.equal(result.reason.code,'SCAN_UNAVAILABLE');
    for (const result of results.filter((r) => r.status === 'fulfilled')) {
      // Choose the reserving instance by the original call position, not by
      // inventing ownership in a caller token or a read-only lookup receipt.
      const index = results.indexOf(result),owner = index % 2 ? a : b;
      await owner.close(await owner.take(result.value.run)); assert.equal((await a.lookup(result.value.run)).phase,'closed');
    }
  });
  check('journal expired recovery fences old owner heartbeat attach and close',async () => {
    const [a,b] = stores(databaseA,databaseB); let old = await a.reserve(randomUUID()); old = await a.creating(old); old = await a.attach(old,'b'.repeat(64));
    await databaseB.transaction((tx) => tx.query("UPDATE cb_decoder_jobs SET lease_until = clock_timestamp()-interval '1 second' WHERE run = $1",[old.run]));
    const recovered = await b.take(old.run); assert.equal(recovered.containerId,old.containerId); assert.equal(recovered.generation,old.generation+1);
    await assert.rejects(a.heartbeat(old),unavailable); await assert.rejects(a.attach(old,'b'.repeat(64)),unavailable); await assert.rejects(a.close(old),unavailable);
    await b.close(recovered); assert.equal((await a.lookup(old.run)).phase,'closed');
  });
  check('journal unconfirmed creation never frees its slot merely on lease expiry',async () => {
    const [a,b] = stores(databaseA,databaseB); const r = await a.creating(await a.reserve(randomUUID()));
    await databaseB.transaction((tx) => tx.query("UPDATE cb_decoder_jobs SET lease_until = clock_timestamp()-interval '1 second' WHERE run = $1",[r.run]));
    const recovered = await b.take(r.run); await assert.rejects(b.close(recovered),unavailable); await assert.rejects(a.reserve(randomUUID()),unavailable);
    assert.equal((await a.lookup(r.run)).phase,'creating'); assert.equal((await b.recoverable())[0].containerId,null);
  });
  check('journal committed response loss is visible from a different native pool',async () => {
    const run = randomUUID(),[a,,config] = stores(databaseA,databaseB); let lost = true;
    const wrapper = { async transaction(work) { const result = await databaseA.transaction(work); if (lost) { lost = false; throw new Error('SYNTHETIC RESPONSE LOSS'); } return result; } };
    const journal = new DecoderJobJournal(wrapper,config); await assert.rejects(journal.reserve(run),unavailable);
    const reader = new DecoderJobJournal(databaseB,config); assert.equal((await reader.lookup(run)).phase,'reserved');
    await journal.close(await journal.take(run)); assert.equal((await a.lookup(run)).phase,'closed');
  });
  check('journal simultaneous recovery has one owner and rejects stale generations',async () => {
    const [a,b,config] = stores(databaseA,databaseB),c = new DecoderJobJournal(databaseB,config); const r = await a.reserve(randomUUID());
    await databaseA.transaction((tx) => tx.query("UPDATE cb_decoder_jobs SET lease_until = clock_timestamp()-interval '1 second' WHERE run = $1",[r.run]));
    const results = await Promise.allSettled([b.take(r.run),c.take(r.run)]);
    assert.equal(results.filter((value) => value.status === 'fulfilled').length,1);
    assert.equal(results.find((value) => value.status === 'rejected').reason.code,'SCAN_UNAVAILABLE');
    const winner = results[0].status === 'fulfilled' ? b : c,token = results.find((value) => value.status === 'fulfilled').value;
    await winner.close(token); await assert.rejects(a.creating(r),unavailable); assert.equal((await a.lookup(r.run)).phase,'closed');
  });
}
