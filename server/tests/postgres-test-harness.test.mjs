import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDisposableDatabase, disposableDatabaseName, dropDisposableDatabase,
  postgresTestOptions, quotedTestDatabase, TEST_DATABASE_CONFIRMATION } from '../postgres-test-harness.mjs';

const syntheticUrl = 'postgresql://carebridge_test:synthetic-only@127.0.0.1:15432/carebridge_integration_control';
const input = (url = syntheticUrl) => ({ url,confirmation:TEST_DATABASE_CONFIRMATION });
const name = disposableDatabaseName('12345678-1234-4234-8234-123456789abc');
const control = { database_name:'carebridge_integration_control',role_name:'carebridge_test',
  session_role:'carebridge_test',is_template:false,allows_connections:true,owner_oid:'42',role_oid:'42',
  rolsuper:false,rolcreatedb:true,rolcreaterole:false,rolreplication:false,rolbypassrls:false,server_version:180000 };
const lease = { name,oid:77,ownerOid:42 };

function adminFixture({ identity = {}, database = { oid:'77',owner_oid:'42' }, failCreate = false } = {}) {
  const calls = [];
  return { calls,async query(sql,params) {
    calls.push({ sql,params });
    if (sql.startsWith('SELECT current_database')) return { rows:[{ ...control,...identity }] };
    if (sql.startsWith('SELECT oid')) return { rows:database ? [database] : [] };
    if (sql.startsWith('CREATE DATABASE') && failCreate) throw new Error('synthetic existing database');
    return { rows:[] };
  } };
}

test('native PostgreSQL test options require an explicit local disposable-DB confirmation', () => {
  const config = postgresTestOptions(input());
  assert.equal(config.host,'127.0.0.1'); assert.equal(config.port,15432);
  assert.equal(config.database,'carebridge_integration_control'); assert.equal(config.user,'carebridge_test');
  assert.equal(config.ssl,false); assert.equal(config.max,4); assert.equal(config.connectionTimeoutMillis,4000);
  assert.match(config.options,/search_path=public,pg_catalog/); assert.equal(Object.isFrozen(config),true);
  assert.equal(postgresTestOptions(input(syntheticUrl.replace('127.0.0.1','[::1]'))).host,'::1');
  for (const invalid of [undefined,{}, { url:syntheticUrl }, { ...input(),confirmation:'yes' }])
    assert.throws(() => postgresTestOptions(invalid),{ message:'POSTGRES_TEST_CONFIGURATION' });
});

test('remote, DNS, production, query-override and credential variants fail without leaking their input', () => {
  for (const invalid of [syntheticUrl.replace('127.0.0.1','localhost'),syntheticUrl.replace('127.0.0.1','192.0.2.1'),
    syntheticUrl.replace('127.0.0.1','127.1'),syntheticUrl.replace('15432','543'),syntheticUrl.replace(':15432',''),
    syntheticUrl.replace('carebridge_integration_control','carebridge'),syntheticUrl.replace('carebridge_test:','postgres:'),
    syntheticUrl.replace('synthetic-only',''),syntheticUrl.replace('synthetic-only','secret%00data'),
    `${syntheticUrl}?host=remote.invalid`,`${syntheticUrl}#fragment`,`${syntheticUrl}\n`,null]) {
    assert.throws(() => postgresTestOptions(input(invalid)),(error) => error.message === 'POSTGRES_TEST_CONFIGURATION' &&
      !error.message.includes('synthetic') && !error.message.includes('secret'));
  }
});

function refusedCommand(environment) {
  const result = spawnSync(process.execPath,[fileURLToPath(new URL('../postgres-integration.mjs',import.meta.url))],{
    env:{ ...process.env,DATABASE_URL:syntheticUrl,CAREBRIDGE_POSTGRES_TEST_URL:'',CAREBRIDGE_POSTGRES_TEST_CONFIRM:'',...environment },
    encoding:'utf8',timeout:10000,
  });
  assert.equal(result.error,undefined); assert.equal(result.status,1);
  assert.equal(result.stdout,''); assert.equal(result.stderr.trim(),'POSTGRES_TEST_CONFIGURATION');
}

test('the integration command refuses missing configuration without falling back to DATABASE_URL', () => {
  refusedCommand({});
  refusedCommand({ CAREBRIDGE_POSTGRES_TEST_URL:syntheticUrl });
});

test('the integration command rejects a non-test target without exposing a URL or credential', () => {
  refusedCommand({ CAREBRIDGE_POSTGRES_TEST_CONFIRM:TEST_DATABASE_CONFIRMATION,
    CAREBRIDGE_POSTGRES_TEST_URL:syntheticUrl.replace('carebridge_integration_control','carebridge') });
});

test('disposable names are bounded UUID-v4 identifiers; arbitrary targets cannot be quoted', () => {
  assert.match(name,/^carebridge_it_[a-f0-9]{32}$/); assert.equal(name.length,46);
  assert.equal(quotedTestDatabase(name),`"${name}"`);
  assert.notEqual(disposableDatabaseName(),disposableDatabaseName());
  for (const invalid of ['public','postgres','carebridge_integration_control',`${name}"; DROP DATABASE postgres;--`,null])
    assert.throws(() => quotedTestDatabase(invalid),{ message:'POSTGRES_TEST_DATABASE_NAME' });
  for (const invalid of ['12345678-1234-1234-8234-123456789abc','../test',null])
    assert.throws(() => disposableDatabaseName(invalid),{ message:'POSTGRES_TEST_DATABASE_NAME' });
});

test('creation uses template0, refuses adoption and captures the new DB identity', async () => {
  const admin = adminFixture();
  assert.deepEqual(await createDisposableDatabase(admin,name),lease);
  assert.equal(admin.calls[1].sql,`CREATE DATABASE "${name}" TEMPLATE template0`);
  assert.deepEqual(admin.calls[2].params,[name]);
  const existing = adminFixture({ failCreate:true });
  await assert.rejects(createDisposableDatabase(existing,name),/synthetic existing database/);
  assert.equal(existing.calls.some(({ sql }) => sql.startsWith('DROP')),false);
});

test('wrong control DB, account, owner, server or excessive privilege prevents creation', async () => {
  for (const identity of [{ database_name:'carebridge' },{ role_name:'postgres' },{ session_role:'operator' },
    { owner_oid:'43' },{ role_oid:'0' },{ is_template:true },{ allows_connections:false },
    { rolcreatedb:false },{ rolsuper:true },{ rolcreaterole:true },{ rolreplication:true },{ rolbypassrls:true },
    { server_version:140000 },{ server_version:190000 }]) {
    const admin = adminFixture({ identity });
    await assert.rejects(createDisposableDatabase(admin,name),{ message:'POSTGRES_TEST_CONTROL_DATABASE' });
    assert.equal(admin.calls.some(({ sql }) => sql.startsWith('CREATE') || sql.startsWith('DROP')),false);
  }
});

test('lost or changed ownership after creation does not trigger a guessed cleanup', async () => {
  for (const database of [null,{ oid:'0',owner_oid:'42' },{ oid:'77',owner_oid:'43' }]) {
    const admin = adminFixture({ database });
    await assert.rejects(createDisposableDatabase(admin,name),{ message:'POSTGRES_TEST_OWNERSHIP' });
    assert.equal(admin.calls.some(({ sql }) => sql.startsWith('DROP')),false);
  }
});

test('cleanup drops only the freshly recorded name/OID/owner, never FORCE or another session', async () => {
  const admin = adminFixture();
  await dropDisposableDatabase(admin,lease);
  assert.equal(admin.calls.at(-1).sql,`DROP DATABASE "${name}"`);
  assert.equal(admin.calls.some(({ sql }) => /FORCE|terminate_backend/.test(sql)),false);
  for (const database of [null,{ oid:'78',owner_oid:'42' },{ oid:'77',owner_oid:'43' }]) {
    const refused = adminFixture({ database });
    await assert.rejects(dropDisposableDatabase(refused,lease),{ message:'POSTGRES_TEST_OWNERSHIP' });
    assert.equal(refused.calls.some(({ sql }) => sql.startsWith('DROP')),false);
  }
});

test('malformed cleanup receipts and changed control identity cannot delete anything', async () => {
  for (const invalid of [null,{ ...lease,oid:0 },{ ...lease,oid:'77' },{ ...lease,ownerOid:-1 },
    { ...lease,extra:true },{ ...lease,name:'carebridge_integration_control' }]) {
    const admin = adminFixture(); await assert.rejects(dropDisposableDatabase(admin,invalid));
    assert.equal(admin.calls.length,0);
  }
  const admin = adminFixture({ identity:{ rolsuper:true } });
  await assert.rejects(dropDisposableDatabase(admin,lease),{ message:'POSTGRES_TEST_CONTROL_DATABASE' });
  assert.equal(admin.calls.some(({ sql }) => sql.startsWith('DROP')),false);
});
