import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { databaseFromPool } from '../database.mjs';

function fixture({ failOn,onQuery } = {}) {
  const calls = [];
  const client = Object.assign(new EventEmitter(),{
    async query(sql, params) {
      calls.push([sql, params]);
      onQuery?.(sql,client);
      if (failOn?.(sql)) throw new Error('test driver error');
      return { rows: [{ value: 1 }] };
    },
    release(discard) { calls.push(['release', discard]); },
  });
  const pool = new EventEmitter();
  pool.connect = async () => client;
  pool.end = async () => { calls.push(['end']); };
  return { calls, pool,client };
}

test('transaction uses one checked-out client and commits before releasing', async () => {
  const { calls, pool } = fixture();
  const database = databaseFromPool(pool);
  const value = await database.transaction(async (tx) => tx.query('SELECT $1', ['fixture']));
  assert.equal(value.rows[0].value, 1);
  assert.deepEqual(calls.map(([sql]) => sql), [
    'BEGIN', "SET LOCAL statement_timeout = '10s'", "SET LOCAL lock_timeout = '5s'",
    'SELECT $1', 'COMMIT', 'release',
  ]);
  assert.deepEqual(calls[3][1], ['fixture']);
  assert.equal(calls.at(-1)[1], false);
  await database.close();
  assert.deepEqual(calls.at(-1), ['end']);
});

test('failed callback rolls back and releases; failed rollback discards the connection', async () => {
  for (const failRollback of [false, true]) {
    const { calls, pool } = fixture({ failOn: (sql) => failRollback && sql === 'ROLLBACK' });
    const database = databaseFromPool(pool);
    await assert.rejects(database.transaction(async () => { throw new Error('test write failure'); }), /test write failure/);
    assert.equal(calls.some(([sql]) => sql === 'COMMIT'), false);
    assert.deepEqual(calls.at(-1), ['release', failRollback]);
    assert.equal(calls.at(-2)[0], 'ROLLBACK');
  }
});

test('commit failure is not reported as success', async () => {
  const { calls, pool } = fixture({ failOn: (sql) => sql === 'COMMIT' });
  await assert.rejects(databaseFromPool(pool).transaction(async () => 'value'), /test driver error/);
  assert.deepEqual(calls.slice(-3).map(([sql]) => sql), ['COMMIT', 'ROLLBACK', 'release']);
});

test('background pool failure produces a content-free health signal', () => {
  const { pool } = fixture();
  let observed;
  const database = databaseFromPool(pool, { onBackgroundError: (...args) => { observed = args; } });
  assert.equal(database.hasBackgroundError(), false);
  pool.emit('error', new Error('a driver error that must not be forwarded'));
  assert.equal(database.hasBackgroundError(), true);
  assert.deepEqual(observed, []);
});

test('checked-out socket error between queries rejects without crashing, committing or returning the client',async () => {
  const { calls,pool,client } = fixture();
  await assert.rejects(databaseFromPool(pool).transaction(async (tx) => {
    client.emit('error',new Error('synthetic private socket detail'));
    await tx.query('SELECT 1');
  }),{ code:'DATABASE_CONNECTION_LOST',message:'Database connection unavailable.' });
  assert.equal(calls.some(([sql]) => ['SELECT 1','COMMIT','ROLLBACK'].includes(sql)),false);
  assert.deepEqual(calls.at(-1),['release',true]); assert.equal(client.listenerCount('error'),0);
});

test('socket error at begin prevents the callback and discards once',async () => {
  const { calls,pool,client } = fixture({ onQuery:(sql,connection) => {
    if (sql === 'BEGIN') connection.emit('error',new Error('synthetic startup socket detail'));
  } });
  let entered = false;
  await assert.rejects(databaseFromPool(pool).transaction(async () => { entered = true; }),{ code:'DATABASE_CONNECTION_LOST' });
  assert.equal(entered,false); assert.deepEqual(calls.map(([sql]) => sql),['BEGIN','release']);
  assert.equal(calls.at(-1)[1],true); assert.equal(client.listenerCount('error'),0);
});

test('socket failure while commit is pending never returns a success or retries work',async () => {
  const { calls,pool,client } = fixture({ onQuery:(sql,connection) => {
    if (sql === 'COMMIT') connection.emit('error',new Error('synthetic commit socket detail'));
  } });
  let attempts = 0;
  await assert.rejects(databaseFromPool(pool).transaction(async () => { attempts++; return 'not confirmed'; }),{ code:'DATABASE_CONNECTION_LOST' });
  assert.equal(attempts,1); assert.deepEqual(calls.at(-1),['release',true]);
  assert.equal(calls.some(([sql]) => sql === 'ROLLBACK'),false); assert.equal(client.listenerCount('error'),0);
});

test('ordinary SQL errors still roll back and do not discard a healthy connection',async () => {
  const { calls,pool,client } = fixture({ failOn:(sql) => sql === 'SELECT invalid' });
  await assert.rejects(databaseFromPool(pool).transaction((tx) => tx.query('SELECT invalid')),/test driver error/);
  assert.deepEqual(calls.slice(-2),[['ROLLBACK',undefined],['release',false]]);
  assert.equal(client.listenerCount('error'),0);
});

test('temporary checked-out error listeners do not accumulate on repeated use',async () => {
  const { pool,client } = fixture(); const database = databaseFromPool(pool);
  for (let i = 0; i < 5; i++) {
    await database.transaction(async () => { assert.equal(client.listenerCount('error'),1); });
    assert.equal(client.listenerCount('error'),0);
  }
});
