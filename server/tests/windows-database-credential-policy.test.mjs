import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DATABASE_CREDENTIAL_PURPOSE, databaseCredentialId, databaseCredentialOptions, databaseCredentialBinding,
  validateDatabasePassword, validateProtectedDatabaseCredential, validateDatabaseCredentialResponse } from '../windows-database-credential-policy.mjs';
import { WindowsDatabaseCredentialStore } from '../windows-database-credential-store.mjs';

const privileges = () => ({roles:{owner:'cb_owner',runtime:'cb_app',bootstrap:'cb_bootstrap',backup:'cb_backup',worker:'cb_worker'},
  target:{name:'cb_beta',oid:16384,ownerOid:16385,confirm:'cb_beta'}});
const options = {base:'E:\\CarebridgeBeta',powershell:'C:\\Tools\\pwsh.exe'};
const id = randomUUID(), binding = databaseCredentialBinding(privileges(),'worker');
const envelope = () => ({schema:1,purpose:DATABASE_CREDENTIAL_PURPOSE,scope:'CurrentUser',credentialId:id,binding:{...binding},
  createdAt:'2026-10-07T00:00:00.000Z',ownerSid:'S-1-5-21-11-22-33-1001',value:Buffer.alloc(96,7).toString('base64')});
const fail = (fn) => assert.throws(fn,{message:'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'});

test('credential IDs are opaque lower-case version 4 UUIDs',() => {
  assert.equal(databaseCredentialId(id),id);
  for (const value of [null,'../password',id.toUpperCase(),`${id}:stream`]) fail(() => databaseCredentialId(value));
});
test('credential paths/purpose never reuse recovery-key storage and options are captured',() => {
  const input = {...options}, captured = databaseCredentialOptions(input); input.base = 'E:\\Other';
  assert.equal(captured.root,'E:\\CarebridgeBeta\\private\\secrets\\database-credentials'); assert.ok(Object.isFrozen(captured));
  const run = randomUUID(); assert.equal(databaseCredentialOptions({...options,syntheticRunId:run}).root,`E:\\CarebridgeBeta\\private\\checks\\credential-check-${run}`);
  for (const patch of [{root:'E:\\Other'},{scope:'LocalMachine'},{syntheticRunId:null},{reset:true},{password:'not-accepted'}]) fail(() => databaseCredentialOptions({...options,...patch}));
});
test('credential options refuse relative/network/stream/traversal/root/reserved paths',() => {
  for (const base of ['E:\\','C:\\Beta','E:Beta','\\\\host\\share','E:\\Beta:stream','E:\\Beta\\..\\Other','E:\\CON','E:\\Beta.']) fail(() => databaseCredentialOptions({...options,base}));
  for (const powershell of ['pwsh.exe','C:\\Tools\\cmd.exe','C:\\Tools\\pwsh.exe:stream']) fail(() => databaseCredentialOptions({...options,powershell}));
});
test('four non-owner service kinds derive frozen bindings from the existing five-role policy',() => {
  for (const kind of ['runtime','bootstrap','backup','worker']) {
    const input = privileges(), result = databaseCredentialBinding(input,kind); input.roles[kind] = 'other'; input.target.oid = 20000;
    assert.equal(result.kind,kind); assert.equal(result.roleName,privileges().roles[kind]); assert.equal(result.databaseOid,16384); assert.ok(Object.isFrozen(result));
  }
  for (const kind of ['owner','postgres','Worker',null,1]) fail(() => databaseCredentialBinding(privileges(),kind));
});
test('invalid, aliased or incomplete privilege plans cannot create credential bindings',() => {
  for (const change of [(p) => {delete p.roles.worker;},(p) => {p.roles.worker=p.roles.owner;},
    (p) => {p.target.confirm='other';},(p) => {p.target.oid='16384';},(p) => {p.target.ownerOid=0;},
    (p) => {p.roles.worker='postgres';},(p) => {p.extra=true;}]) {
    const input = privileges(); change(input); fail(() => databaseCredentialBinding(input,'worker'));
  }
});
test('generated service passwords require caller-owned 32..1024 printable ASCII bytes',() => {
  for (const size of [32,64,1024]) {const bytes=Buffer.alloc(size,65); assert.equal(validateDatabasePassword(bytes),bytes); bytes.fill(0);}
  for (const value of ['A'.repeat(64),Buffer.alloc(31,65),Buffer.alloc(1025,65),Buffer.alloc(64),Buffer.alloc(64,32),Buffer.alloc(64,127),Buffer.from('가'.repeat(32))]) fail(() => validateDatabasePassword(value));
});
test('protected credential envelope strictly binds purpose/scope/ID/owner/timestamp',() => {
  assert.equal(validateProtectedDatabaseCredential(envelope(),id,binding).credentialId,id);
  for (const patch of [{schema:2},{purpose:'carebridge-recovery-key'},{scope:'LocalMachine'},{credentialId:randomUUID()},
    {ownerSid:'everyone'},{createdAt:'2026-02-30T00:00:00.000Z'},{createdAt:'2026-10-07T09:00:00+09:00'},
    {value:Buffer.alloc(32).toString('base64')},{extra:'internal'}]) fail(() => validateProtectedDatabaseCredential({...envelope(),...patch},id,binding));
});
test('every binding field is compared without coercion or additional fields',() => {
  for (const patch of [{kind:'runtime'},{roleName:'other_worker'},{databaseName:'other_database'},
    {databaseOid:16386},{ownerOid:16387},{databaseOid:'16384'},{extra:true}]) fail(() => validateProtectedDatabaseCredential({...envelope(),binding:{...binding,...patch}},id,binding));
  const missing={...binding}; delete missing.ownerOid; fail(() => validateProtectedDatabaseCredential({...envelope(),binding:missing},id,binding));
});
test('ciphertext requires bounded canonical base64, not plaintext or permissive decoding',() => {
  for (const value of [null,envelope().value+'\n',envelope().value.slice(1),'x'.repeat(13000),Buffer.alloc(8193).toString('base64')])
    fail(() => validateProtectedDatabaseCredential({...envelope(),value},id,binding));
});
test('unprotect returns only a valid password Buffer with the expected binding and ID',() => {
  const response={schema:1,credentialId:id,binding,value:Buffer.alloc(64,65).toString('base64')};
  const read=validateDatabaseCredentialResponse(response,'unprotect',id,binding); assert.equal(read.length,64); read.fill(0);
  for (const patch of [{credentialId:randomUUID()},{binding:{...binding,kind:'runtime'}},{value:Buffer.alloc(64).toString('base64')},{trace:'private'}])
    fail(() => validateDatabaseCredentialResponse({...response,...patch},'unprotect',id,binding));
});
test('native check is a strict boolean receipt, never a permissive fallback',() => {
  const response={schema:1,credentialId:id,binding,verified:true}; assert.equal(validateDatabaseCredentialResponse(response,'check',id,binding),true);
  for (const patch of [{verified:1},{verified:false},{value:'extra'},{binding:{...binding,ownerOid:5}}]) fail(() => validateDatabaseCredentialResponse({...response,...patch},'check',id,binding));
  fail(() => validateDatabaseCredentialResponse(response,'unknown',id,binding));
});
test('store rejects owner/invalid password before invoking the nonexistent native provider',async () => {
  if (process.platform !== 'win32') {fail(() => new WindowsDatabaseCredentialStore(options)); return;}
  const store=new WindowsDatabaseCredentialStore(options), bytes=Buffer.alloc(64,65), before=Buffer.from(bytes);
  try {
    for (const kind of ['owner','invalid']) await assert.rejects(store.store(id,privileges(),kind,bytes),{message:'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'});
    await assert.rejects(store.store(id,privileges(),'worker','plaintext-string'),{message:'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'});
    await assert.rejects(store.load(id,privileges(),'owner'),{message:'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'});
    assert.deepEqual(bytes,before);
  } finally {bytes.fill(0);before.fill(0);}
});
