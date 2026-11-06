// Driver-method doubles: prove adapter ordering/error contracts, not TCP/TLS.
// The companion wire tests exercise actual sockets using the installed driver.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Pool } from 'pg';
import { ownedPostgresPool } from '../postgres-pool.mjs';

afterEach(() => mock.restoreAll());
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const connects = [], ends = [];
  mock.method(Client.prototype, 'connect', function(callback) { connects.push({ client: this, callback }); });
  mock.method(Client.prototype, 'end', function(callback) { ends.push({ client: this, callback }); });
  const owned = ownedPostgresPool({ max: 2, idleTimeoutMillis: 0, connectionTimeoutMillis: 0 });
  owned.pool.on('error', () => {});
  return { ...owned, connects, ends };
}

test('failed acquisition stays pending until actual end callback and preserves the original error once', async () => {
  const f = fixture(), original = new Error('synthetic connection failure');
  const pending = f.pool.connect(); let settled = false;
  const rejected = assert.rejects(pending, error => error === original).then(() => { settled = true; });
  f.connects[0].callback(original); await tick();
  assert.equal(settled, false); assert.equal(f.ends.length, 1); assert.equal(f.pool.totalCount, 1);
  f.connects[0].callback(new Error('duplicate callback')); assert.equal(f.ends.length, 1);
  f.connects[0].callback(null); assert.equal(f.ends.length, 1);
  f.ends[0].callback(); await rejected; assert.equal(f.pool.totalCount, 0);
  await f.close(); assert.equal(f.ends.length, 1);
});

test('pool end membership is insufficient: adapter close waits for all removed client end callbacks', async () => {
  const f = fixture(), a = f.pool.connect(), b = f.pool.connect();
  for (const item of f.connects) item.callback(null);
  const clients = await Promise.all([a, b]); clients.forEach(client => client.release());
  let closed = false; const closing = f.close(); closing.then(() => { closed = true; });
  assert.equal(f.close(), closing); await tick();
  assert.equal(f.pool.ended, true); assert.equal(f.pool.totalCount, 0);
  assert.equal(f.ends.length, 2); assert.equal(closed, false);
  f.ends[0].callback(); await tick(); assert.equal(closed, false);
  f.ends[1].callback(); await closing; assert.equal(closed, true);
});

test('failed teardown retains the original acquisition error and makes close fail persistently', async () => {
  const f = fixture(), original = new Error('synthetic connection failure'), cleanup = new Error('synthetic end failure');
  const rejected = assert.rejects(f.pool.connect(), error => error === original);
  f.connects[0].callback(original); f.ends[0].callback(cleanup); await rejected;
  const closing = f.close(); await assert.rejects(closing, error => error === cleanup);
  assert.equal(f.close(), closing); await assert.rejects(f.close(), error => error === cleanup);
  assert.equal(f.ends.length, 1);
});

test('synchronous driver connect/end throws remain failures with no retry or abandoned end observation', async () => {
  const f = fixture(), original = new Error('synthetic sync connect'), cleanup = new Error('synthetic sync end');
  mock.method(Client.prototype, 'connect', () => { throw original; });
  mock.method(Client.prototype, 'end', () => { throw cleanup; });
  await assert.rejects(f.pool.connect(), error => error === original);
  await assert.rejects(f.close(), error => error === cleanup);
});

test('synchronous connect throw with successful teardown is returned only after that teardown', async () => {
  const f = fixture(), original = new Error('synthetic early connect throw');
  mock.method(Client.prototype, 'connect', () => { throw original; });
  let rejected = false;
  const pending = assert.rejects(f.pool.connect(), error => error === original).then(() => { rejected = true; });
  await tick(); assert.equal(rejected, false); assert.equal(f.ends.length, 1);
  f.ends[0].callback(); await pending; await f.close();
});

test('a client discarded before close remains owned until its pending end callback', async () => {
  const f = fixture(), acquisition = f.pool.connect(); f.connects[0].callback(null);
  const client = await acquisition; client.release(true);
  assert.equal(f.pool.totalCount, 0); assert.equal(f.ends.length, 1);
  let closed = false; const closing = f.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  f.ends[0].callback(); await closing; assert.equal(f.ends.length, 1);
});

test('driver end supports repeated callback and Promise callers through the same single operation', async () => {
  const f = fixture(), pending = f.pool.connect(); f.connects[0].callback(null);
  const client = await pending; client.release();
  const promise = client.end(); let calls = 0;
  client.end(() => { calls++; }); assert.equal(client.end(), promise); assert.equal(f.ends.length, 1);
  f.ends[0].callback(); await promise; await tick(); assert.equal(calls, 1);
  await f.close(); assert.equal(f.ends.length, 1);
});

test('pool error during close does not skip a pending end and remains the close failure', async () => {
  const f = fixture(), pending = f.pool.connect(); f.connects[0].callback(null);
  const client = await pending; client.release(); const ending = client.end();
  const error = new Error('synthetic pool end failure'); mock.method(Pool.prototype, 'end', async () => { throw error; });
  let settled = false; const closing = assert.rejects(f.close(), cause => cause === error).then(() => { settled = true; });
  await tick(); assert.equal(settled, false); f.ends[0].callback(); await ending; await closing;
});

test('factory refuses replacing its owned driver class with caller code', () => {
  assert.throws(() => ownedPostgresPool({ Client: class {} }), { message: 'DATABASE_CLIENT_OVERRIDE_UNAVAILABLE' });
});
