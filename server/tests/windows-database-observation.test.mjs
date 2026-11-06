import test from 'node:test';
import assert from 'node:assert/strict';
import { beginWindowsDatabaseStage, WINDOWS_DATABASE_STAGES } from '../windows-database-observation.mjs';

test('only fixed names, edges and monotonic bounded durations reach the immutable observation', async () => {
  const events = [];
  for (const stage of WINDOWS_DATABASE_STAGES) {
    const finish = beginWindowsDatabaseStage((event) => events.push(event), stage);
    finish('complete'); finish('failed');
  }
  assert(Object.isFrozen(WINDOWS_DATABASE_STAGES)); assert.equal(events.length, 12);
  for (const event of events) {
    assert.deepEqual(Object.keys(event), ['stage', 'edge', 'elapsedMs']); assert(Object.isFrozen(event));
    assert(WINDOWS_DATABASE_STAGES.includes(event.stage)); assert(['begin', 'complete'].includes(event.edge));
    assert(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= 2147483647);
    if (event.edge === 'begin') assert.equal(event.elapsedMs, 0);
  }
  beginWindowsDatabaseStage((event) => events.push(event), 'private caller text')('failed');
  assert.equal(events.length, 12);
});

test('absent, throwing, rejected and indefinitely pending observers cannot cancel or delay work', async () => {
  for (const observer of [undefined, null, () => { throw Error('private observer'); },
    () => Promise.reject(Error('private async observer')), () => new Promise(() => {})]) {
    const finish = beginWindowsDatabaseStage(observer, 'connection'); finish('failed'); finish('complete');
  }
  await new Promise((resolve) => setImmediate(resolve)); // Rejected observers were consumed, not awaited.
});
