import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AccountDelivery } from '../account-delivery.mjs';
import { LocalPasswordRecovery } from '../local-password-recovery.mjs';

const response = { message: '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.' };
function fixture(prepare = async () => null) {
  const calls = [];
  const accountDelivery = new AccountDelivery({ origin: 'https://carebridge.test', auth: {
    createInvitation: async () => null, accountDeliveryRecipient: async () => null,
    preparePasswordRecovery: async input => { calls.push(input.email); return prepare(input); },
  }, transport: { send: async () => { throw new Error('Unexpected synthetic delivery.'); } } });
  return { queue: new LocalPasswordRecovery({ accountDelivery }), calls };
}
test('recovery admission returns before any account lookup and exposes only the uniform response', async () => {
  const { queue, calls } = fixture();
  const accepted = queue.request({ email: ' PERSON@CAREBRIDGE.TEST ' });
  assert.deepEqual(accepted, response); assert(Object.isFrozen(accepted)); assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(queue), []); assert.equal(JSON.stringify(queue), '{}');
  assert.equal(inspect(queue).includes('PERSON'), false);
  await queue.idle(); assert.deepEqual(calls, ['person@carebridge.test']); await queue.close();
});
test('only an explicitly trusted AccountDelivery and one ASCII synthetic address are accepted', async () => {
  assert.throws(() => new LocalPasswordRecovery({ accountDelivery: { recover() {} } }));
  const { queue, calls } = fixture();
  for (const email of ['real@example.com', 'x@carebridge.test\r\nBcc:a@x.test', 'x@carebridge.test\t',
    '한글@carebridge.test', 'x@carebridge.test,y@carebridge.test', 'Name <x@carebridge.test>', '\ud800@x.test',
    `${'x'.repeat(250)}@a.test`, null]) assert.throws(() => queue.request({ email }), { code: 'INVALID_INPUT' });
  for (const body of [{}, { email: 'x@a.test', extra: true }, { get email() { throw new Error('secret'); } }, []])
    assert.throws(() => queue.request(body), { code: 'INVALID_INPUT' });
  await queue.idle(); assert.equal(calls.length, 0); await queue.close();
});
test('queue is bounded at sixteen before its first turn and saturation is indistinguishable', async () => {
  const { queue, calls } = fixture();
  for (let i = 0; i < 24; i++) assert.deepEqual(queue.request({ email: `person${i}@carebridge.test` }), response);
  assert.equal(calls.length, 0); await queue.idle(); assert.equal(calls.length, 16); await queue.close();
});
test('one worker processes sequentially, with independent cooldown for existing and absent accounts', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let active = 0, maximum = 0;
  const { queue, calls } = fixture(async () => {
    maximum = Math.max(maximum, ++active); entered.resolve(); await release.promise; active--; return null;
  });
  for (const email of ['known@carebridge.test', 'absent@carebridge.test', 'KNOWN@CAREBRIDGE.TEST'])
    assert.deepEqual(queue.request({ email }), response);
  await entered.promise; assert.equal(calls.length, 1); release.resolve(); await queue.idle();
  assert.deepEqual(calls, ['known@carebridge.test', 'absent@carebridge.test']); assert.equal(maximum, 1); await queue.close();
});
test('global thirty-two-per-minute admission applies without any account-existence knowledge', async () => {
  const { queue, calls } = fixture();
  for (let i = 0; i < 40; i++) { assert.deepEqual(queue.request({ email: `person${i}@carebridge.test` }), response); await queue.idle(); }
  assert.equal(calls.length, 32); await queue.close();
});
test('monotonic cooldown expires but an actually running address cannot be queued again', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { queue, calls } = fixture(async () => { entered.resolve(); await release.promise; return null; });
  queue.request({ email: 'person@carebridge.test' }); await entered.promise;
  now = 60_001; queue.request({ email: 'person@carebridge.test' }); release.resolve(); await queue.idle();
  assert.equal(calls.length, 1);
  queue.request({ email: 'person@carebridge.test' }); await queue.idle(); assert.equal(calls.length, 2); await queue.close();
});
test('a failed issuance is private, not retried, and does not strand the next job', async () => {
  const { queue, calls } = fixture(async () => { throw new Error('Synthetic secret diagnostic must stay private.'); });
  queue.request({ email: 'first@carebridge.test' }); queue.request({ email: 'second@carebridge.test' });
  await queue.idle(); assert.equal(calls.length, 2);
  assert.deepEqual(queue.request({ email: 'first@carebridge.test' }), response); await queue.idle();
  assert.equal(calls.length, 2); await queue.close();
});
test('close cancels a not-yet-started turn and remains idempotent and closed', async () => {
  const { queue, calls } = fixture(); queue.request({ email: 'queued@carebridge.test' });
  const closed = queue.close(); assert.equal(queue.close(), closed); await closed; await nextTurn();
  assert.equal(calls.length, 0); assert.deepEqual(queue.request({ email: 'new@carebridge.test' }), response);
  await queue.idle(); assert.equal(calls.length, 0);
});
test('close discards queued work but does not claim an active job has completed', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { queue, calls } = fixture(async () => { entered.resolve(); await release.promise; return null; });
  queue.request({ email: 'active@carebridge.test' }); queue.request({ email: 'queued@carebridge.test' }); await entered.promise;
  let finished = false; const closing = queue.close(); void closing.then(() => { finished = true; });
  await nextTurn(); assert.equal(finished, false); assert.equal(queue.close(), closing);
  release.resolve(); await closing; assert.equal(finished, true); assert.deepEqual(calls, ['active@carebridge.test']);
});
