import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseForService} from '../database-privileges.mjs';
import {serviceCatalog,serviceInput} from './database-service-fixtures.mjs';
const denied = {message:'DATABASE_PRIVILEGES_UNAVAILABLE'};

test('service port requires an explicit non-owner purpose and exact five-role target before entering DB',() => {
  const f = serviceCatalog();
  for (const kind of [undefined,null,'owner','tenant','WORKER']) assert.throws(() => databaseForService(f.database,f.input,kind),denied);
  const legacy = serviceInput(); delete legacy.roles.worker;
  for (const input of [null,legacy,{...serviceInput(),password:'never-accepted'}]) assert.throws(() => databaseForService(f.database,input,'worker'),denied);
  assert.throws(() => databaseForService({},f.input,'worker'),denied); assert.equal(f.state.transactions,0);
});

test('all four service purposes verify the actual transaction before work without grants, SET ROLE, secrets or closing the pool',async () => {
  for (const kind of ['runtime','worker','bootstrap','backup']) {
    const f = serviceCatalog(); f.state.kind = kind;
    const db = databaseForService(f.database,f.input,kind); assert.ok(Object.isFrozen(db)); assert.deepEqual(Object.keys(db),['transaction']);
    const value = await db.transaction(async (tx) => { assert.ok(f.calls.some(({sql}) => sql.includes('has_column_privilege'))); return tx; });
    assert.equal(typeof value.query,'function'); assert.equal(f.state.transactions,1);
    assert.ok(f.calls.every(({sql}) => /^(?:SET LOCAL search_path=|SELECT )/.test(sql)));
  }
});

test('wrong actual role is rejected before caller work and is never repaired with SET ROLE',async () => {
  const f = serviceCatalog(),db = databaseForService(f.database,f.input,'worker');
  for (const kind of ['runtime','owner','bootstrap','backup']) {
    f.state.kind = kind; let entered = false;
    await assert.rejects(db.transaction(() => { entered = true; }),denied); assert.equal(entered,false);
  }
  assert.ok(!f.calls.some(({sql}) => /SET ROLE|GRANT|REVOKE/.test(sql)));
});

test('a rotating pool or role/grant drift after startup is rechecked on every actual transaction',async () => {
  const f = serviceCatalog(),db = databaseForService(f.database,f.input,'worker'); let entered = 0;
  await db.transaction(() => ++entered); f.state.kind = 'runtime';
  await assert.rejects(db.transaction(() => ++entered),denied); f.state.kind = 'worker';
  f.state.grantedBody = true; await assert.rejects(db.transaction(() => ++entered),denied); f.state.grantedBody = false;
  f.state.missingWorkerRead = true; await assert.rejects(db.transaction(() => ++entered),denied); f.state.missingWorkerRead = false;
  await db.transaction(() => ++entered); assert.equal(entered,2); assert.equal(f.state.transactions,5);
});

test('target/role options and transaction method are snapshotted before later caller mutation',async () => {
  const f = serviceCatalog(),request = serviceInput(),db = databaseForService(f.database,request,'worker');
  request.target.oid = 99999; request.roles.worker = request.roles.owner;
  f.database.transaction = () => { throw new Error('REPLACED_METHOD'); };
  assert.equal(await db.transaction(() => 'original'), 'original');
  assert.throws(() => databaseForService(f.database,request,'worker'),denied);
});

test('missing/malformed work is rejected before acquiring a connection',async () => {
  const f = serviceCatalog(),db = databaseForService(f.database,f.input,'worker');
  for (const value of [undefined,null,{},'query']) await assert.rejects(db.transaction(value),denied);
  assert.equal(f.state.transactions,0);
});

test('admission/connection/commit errors are redacted and unknown outcomes are never retried',async () => {
  const f = serviceCatalog(),secret = new Error('SYNTHETIC-PRIVATE-CONNECTION');
  const db = databaseForService(f.database,f.input,'worker'); f.state.before = () => { throw secret; };
  await assert.rejects(db.transaction(() => assert.fail('work must not run')),denied); assert.equal(f.state.transactions,1);
  f.state.before = null; f.state.commitError = secret; let work = 0;
  await assert.rejects(db.transaction(() => ++work),denied); assert.equal(work,1); assert.equal(f.state.transactions,2);
});

test('existing internal callback errors preserve their identity and rollback contract without automatic work replay',async () => {
  const f = serviceCatalog(),db = databaseForService(f.database,f.input,'worker'),error = Object.assign(new Error('existing internal conflict'),{code:'CONFLICT'});
  await assert.rejects(db.transaction(() => { throw error; }),(actual) => actual === error);
  assert.equal(f.state.transactions,1);
});

test('retained transaction ports cannot issue late queries after callback success or failure',async () => {
  const f = serviceCatalog(),db = databaseForService(f.database,f.input,'worker'); let failed;
  const succeeded = await db.transaction((tx) => { assert.ok(Object.isFrozen(tx)); return tx; });
  await assert.rejects(db.transaction((tx) => { failed = tx; throw new Error('existing rollback'); }),{message:'existing rollback'});
  const count = f.calls.length;
  for (const tx of [succeeded,failed]) {
    await assert.rejects(tx.query('SELECT never_lend_pool_client'),denied);
    await assert.rejects(tx.exec('SELECT never_lend_pool_client'),denied);
  }
  assert.equal(f.calls.length,count); assert.equal(f.state.transactions,2);
});
