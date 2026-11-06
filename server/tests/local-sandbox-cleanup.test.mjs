import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedCleanupError, getPendingSyntheticCleanup } from '../local-sandbox-cleanup.mjs';

test('only the exact registered error exposes cleanup, with no serializable capability or private details', async () => {
  const initial = new Error('PRIVATE_STARTUP'), cleanup = new Error('PRIVATE_CLEANUP');
  const failure = createOwnedCleanupError(initial, cleanup, async () => {});
  assert(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [initial, cleanup]);
  assert.equal(JSON.stringify(failure), '{}');
  assert.equal(Object.hasOwn(failure, 'close'), false);
  const close = getPendingSyntheticCleanup(failure);
  assert.equal(typeof close, 'function'); assert(Object.isFrozen(close));
  assert.equal(getPendingSyntheticCleanup(new AggregateError([failure], 'not an owner')), undefined);
  await close(); assert.equal(getPendingSyntheticCleanup(failure), undefined);
});

test('unknown primitives, getters and proxies cannot supply or run a cleanup method', () => {
  let touched = 0;
  const hostile = Object.defineProperties({}, {
    close: { get() { touched++; throw Error('PRIVATE_GETTER'); } },
    errors: { get() { touched++; throw Error('PRIVATE_ERRORS'); } },
  });
  const proxy = new Proxy(hostile, {
    get() { touched++; throw Error('PRIVATE_PROXY'); },
    ownKeys() { touched++; throw Error('PRIVATE_KEYS'); },
    getPrototypeOf() { touched++; throw Error('PRIVATE_PROTOTYPE'); },
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const error of [null, undefined, true, 1, 'error', Symbol('error'), hostile, proxy, revoked.proxy, () => {}])
    assert.equal(getPendingSyntheticCleanup(error), undefined);
  assert.equal(touched, 0);
});

test('pending close is single-flight, rejected cleanup remains owned, and actual completion revokes lookup', async () => {
  const first = Promise.withResolvers(), next = Promise.withResolvers(); let calls = 0;
  const failure = createOwnedCleanupError(Error('setup'), Error('cleanup'), () => ++calls === 1 ? first.promise : next.promise);
  const close = getPendingSyntheticCleanup(failure), pending = close();
  assert.equal(close(), pending); await Promise.resolve(); assert.equal(calls, 1);
  assert.equal(getPendingSyntheticCleanup(failure), close);
  const rejection = Error('owned close still pending'); first.reject(rejection);
  await assert.rejects(pending, error => error === rejection);
  assert.equal(getPendingSyntheticCleanup(failure), close);
  const retry = close(); assert.equal(close(), retry); await Promise.resolve(); assert.equal(calls, 2);
  assert.equal(getPendingSyntheticCleanup(failure), close);
  next.resolve(); await retry;
  assert.equal(getPendingSyntheticCleanup(failure), undefined);
  await close(); assert.equal(calls, 2);
});

test('a synchronous failure retains exactly its owner and never adopts a wrapped or different error', async () => {
  let calls = 0, otherCalls = 0;
  const failure = createOwnedCleanupError(Error('setup'), Error('cleanup'), () => { if (++calls === 1) throw Error('retry'); });
  const other = createOwnedCleanupError(Error('other'), Error('other cleanup'), () => { otherCalls++; });
  assert.equal(getPendingSyntheticCleanup(new Proxy(failure, {})), undefined);
  const close = getPendingSyntheticCleanup(failure);
  await assert.rejects(close(), /retry/);
  await close(); assert.equal(otherCalls, 0); assert.equal(calls, 2);
  assert.equal(typeof getPendingSyntheticCleanup(other), 'function');
  await getPendingSyntheticCleanup(other)(); assert.equal(otherCalls, 1);
});
