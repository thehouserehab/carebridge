// Explicit synthetic custody rehearsal, not operating account provisioning,
// database authentication, API activation or independent backup.
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat,mkdir,readFile,readdir,rmdir,unlink,writeFile,link,symlink } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsDatabaseCredentialStore } from './windows-database-credential-store.mjs';
import { databaseCredentialOptions,databaseCredentialBinding } from './windows-database-credential-policy.mjs';
import { privateSecretEnvironment,encodePrivateSecretFrame } from './windows-private-secret-io.mjs';
import { WindowsRecoveryKeyStore } from './windows-recovery-key-store.mjs';
import { recoveryKeyStoreOptions } from './windows-recovery-key-policy.mjs';

const args=process.argv.slice(2);
assert.equal(process.platform,'win32'); assert.equal(args.length,5);
assert.equal(args[0],'--base'); assert.equal(args[2],'--powershell'); assert.equal(args[4],'--confirm-synthetic-credential-store');
const runId=randomUUID(), input={base:args[1],powershell:args[3],syntheticRunId:runId};
const options=databaseCredentialOptions(input), root=options.root;
const store=new WindowsDatabaseCredentialStore(input), checks=[], entries=[];
const privileges=() => ({roles:{owner:'cb_fixture_owner',runtime:'cb_fixture_app',bootstrap:'cb_fixture_bootstrap',backup:'cb_fixture_backup',worker:'cb_fixture_worker'},
  target:{name:'cb_fixture',oid:16384,ownerOid:16385,confirm:'cb_fixture'}});
const receiptName='.carebridge-database-credentials.json', provider=fileURLToPath(new URL('../scripts/windows-database-credential-provider.ps1',import.meta.url));
const fixture=fileURLToPath(new URL('./tests/windows-recovery-key-fixture.ps1',import.meta.url));
const reportRoot=fileURLToPath(new URL('../test-results/',import.meta.url));
const keyOptions=recoveryKeyStoreOptions(input), keyId=randomUUID(), key=randomBytes(32), keyPath=win32.join(keyOptions.root,`${keyId}.dpapi`);
let failure=null,cleanup=false,keyMade=false,unknownMade=false,keyOriginal;
const unknownOptions=databaseCredentialOptions({...input,syntheticRunId:randomUUID()});
const denied=(promise) => assert.rejects(promise,{message:'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'});
const pass=(label) => {checks.push(label);console.log(`PASS ${label}`);};
function child(executable,childArgs,bytes) {
  const result=spawnSync(executable,childArgs,{input:bytes,windowsHide:true,timeout:25000,maxBuffer:32768,
    env:privateSecretEnvironment(process.env,options.powershell)});
  assert.equal(result.error,undefined,'Synthetic child must finish'); return result;
}
function acl(action,id) {
  const result=child(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
    '-Base',options.base,'-RunId',runId,'-KeyId',id,'-Action',action,'-Purpose','database']);
  assert.equal(result.status,0); assert.equal(result.stdout.toString(),'KEY_FIXTURE_ACL_OK'); assert.equal(result.stderr.length,0);
}
async function corrupt(entry,patch,plan=privileges(),kind=entry.kind) {
  await writeFile(entry.path,JSON.stringify({...JSON.parse(entry.original.toString()),...patch}));
  try {await denied(store.load(entry.id,plan,kind));} finally {await writeFile(entry.path,entry.original);}
}
async function roundtrip(entry) {
  let read;
  try {read=await store.load(entry.id,privileges(),entry.kind);assert.deepEqual(read,entry.password);}
  finally {read?.fill(0);}
}
try {
  await assert.rejects(lstat(root),{code:'ENOENT'});
  for (const kind of ['runtime','bootstrap','backup','worker']) {
    const entry={kind,id:randomUUID(),password:Buffer.from(randomBytes(32).toString('hex'))};entries.push(entry);
    entry.path=win32.join(root,`${entry.id}.dpapi`);
    const receipt=await store.store(entry.id,privileges(),kind,entry.password);
    assert.equal(receipt.binding.kind,kind);assert.equal(receipt.scope,'CurrentUser');
    entry.original=await readFile(entry.path);
    assert.ok(!entry.original.includes(entry.password) && !entry.original.includes(entry.password.toString('base64')));
    await roundtrip(entry);
  }
  pass('Four non-owner role secrets persist as CurrentUser DPAPI ciphertext in a fresh protected E fixture');
  const readerCode=`
    import {createHash} from 'node:crypto';
    import {WindowsDatabaseCredentialStore} from ${JSON.stringify(new URL('./windows-database-credential-store.mjs',import.meta.url).href)};
    const [base,powershell,syntheticRunId,planText,entriesText]=process.argv.slice(1);
    const store=new WindowsDatabaseCredentialStore({base,powershell,syntheticRunId});let password;
    try {for(const entry of JSON.parse(entriesText)){password=await store.load(entry.id,JSON.parse(planText),entry.kind);
      if(createHash('sha256').update(password).digest('hex')!==entry.digest)throw new Error('Mismatch');password.fill(0);password=null;}
      process.stdout.write('CREDENTIAL_READ_OK');}
    catch{process.stderr.write('CREDENTIAL_READ_FAILED');process.exitCode=1;}finally{password?.fill(0);}
  `;
  const reopened=child(process.execPath,['--input-type=module','-e',readerCode,options.base,options.powershell,runId,JSON.stringify(privileges()),
    JSON.stringify(entries.map(({id,kind,password}) => ({id,kind,digest:createHash('sha256').update(password).digest('hex')})))]);
  assert.equal(reopened.status,0);assert.equal(reopened.stdout.toString(),'CREDENTIAL_READ_OK');assert.equal(reopened.stderr.length,0);
  pass('A fresh Node/native process reads all four encrypted secrets without a plaintext file or cache');
  const entry=entries.find((item) => item.kind==='worker');
  const snapshot={kind:'worker',id:randomUUID(),password:Buffer.from(randomBytes(32).toString('hex'))};entries.push(snapshot);
  snapshot.path=win32.join(root,`${snapshot.id}.dpapi`);
  const mutablePlan=privileges(), mutablePassword=Buffer.from(snapshot.password);
  const pending=store.store(snapshot.id,mutablePlan,'worker',mutablePassword);
  mutablePlan.roles.worker='other_worker';mutablePlan.target.oid=99999;mutablePassword.fill(0);input.base='E:\\Other';
  await pending;snapshot.original=await readFile(snapshot.path);await roundtrip(snapshot);
  pass('Options, role/target and password bytes are captured before asynchronous work');
  await denied(store.store(entry.id,privileges(),'worker',snapshot.password));
  assert.deepEqual(await readFile(entry.path),entry.original);
  pass('Same-ID storage is refused without overwrite, deletion or automatic retry');
  await denied(store.load(entry.id,privileges(),'runtime'));
  for (const mutate of [(p) => {p.roles.worker='other_worker';},(p) => {p.target.name=p.target.confirm='other_db';},
    (p) => {p.target.oid++;},(p) => {p.target.ownerOid++;}]) {const plan=privileges();mutate(plan);await denied(store.load(entry.id,plan,'worker'));}
  pass('Wrong expected role/name/database/OIDs are rejected before returning a password');
  for (const [patch,mutate,kind] of [
    [{kind:'runtime',roleName:'cb_fixture_app'},() => {},'runtime'],
    [{roleName:'other_worker'},(p) => {p.roles.worker='other_worker';},'worker'],
    [{databaseName:'other_db'},(p) => {p.target.name=p.target.confirm='other_db';},'worker'],
    [{databaseOid:16386},(p) => {p.target.oid=16386;},'worker'],
    [{ownerOid:16387},(p) => {p.target.ownerOid=16387;},'worker'],
  ]) {const plan=privileges();mutate(plan);await corrupt(entry,{binding:{...databaseCredentialBinding(privileges(),'worker'),...patch}},plan,kind);}
  pass('Relabelling ciphertext and matching caller metadata cannot change its authenticated role/DB binding');
  await corrupt(entry,{scope:'LocalMachine'});await corrupt(entry,{ownerSid:'S-1-5-21-11-22-33-1001'});
  await corrupt(entry,{createdAt:'2026-10-07T00:00:00.000Z'});
  const ciphertext=Buffer.from(JSON.parse(entry.original).value,'base64');ciphertext[ciphertext.length-1]^=1;
  await corrupt(entry,{value:ciphertext.toString('base64')});ciphertext.fill(0);
  await corrupt(entry,{value:entry.password.toString('base64')});
  const otherId=randomUUID(),otherPath=win32.join(root,`${otherId}.dpapi`);
  await writeFile(otherPath,JSON.stringify({...JSON.parse(entry.original),credentialId:otherId}));
  try{await denied(store.load(otherId,privileges(),'worker'));}finally{await unlink(otherPath);}
  pass('Scope/owner/timestamp/ciphertext/plaintext substitution and ID copying fail closed');
  const keys=new WindowsRecoveryKeyStore({...input,base:options.base});
  await assert.rejects(lstat(keyOptions.root),{code:'ENOENT'});await keys.store(keyId,key);keyMade=true;keyOriginal=await readFile(keyPath);
  await corrupt(entry,{value:JSON.parse(keyOriginal).value});
  await writeFile(keyPath,JSON.stringify({...JSON.parse(keyOriginal),value:JSON.parse(entry.original).value}));
  try{await assert.rejects(keys.load(keyId),{message:'WINDOWS_RECOVERY_KEY_UNAVAILABLE'});}finally{await writeFile(keyPath,keyOriginal);}
  pass('Actual recovery-key and database-credential DPAPI ciphertext cannot cross purposes in either direction');
  for(const content of [entry.original.toString().replace('"schema":1','"schema":1,"schema":1'),
    entry.original.toString().replace('"kind":"worker"','"kind":"worker","kind":"worker"'),entry.original.toString()+'\n',
    entry.original.subarray(0,-1),Buffer.from([0x7b,0xc0,0xaf,0x7d])]) {
    await writeFile(entry.path,content);try{await denied(store.load(entry.id,privileges(),'worker'));}finally{await writeFile(entry.path,entry.original);}
  }
  pass('Duplicate top/nested properties, trailing text, truncation and malformed UTF-8 are rejected');
  await link(entry.path,otherPath);try{await denied(store.load(entry.id,privileges(),'worker'));}finally{await unlink(otherPath);}
  pass('Multiply-linked secret files are refused');
  acl('file-add',entry.id);try{await denied(store.load(entry.id,privileges(),'worker'));}finally{acl('file-remove',entry.id);}
  acl('root-add',entry.id);try{await denied(store.store(otherId,privileges(),'worker',entry.password));await assert.rejects(lstat(otherPath),{code:'ENOENT'});}
  finally{acl('root-remove',entry.id);}await roundtrip(entry);
  pass('Broadened file/root NTFS ACLs are refused without permission repair');
  await assert.rejects(lstat(unknownOptions.root),{code:'ENOENT'});await mkdir(unknownOptions.root);unknownMade=true;
  await denied(new WindowsDatabaseCredentialStore({base:options.base,powershell:options.powershell,syntheticRunId:unknownOptions.syntheticRunId}).store(otherId,privileges(),'worker',entry.password));
  assert.deepEqual(await readdir(unknownOptions.root),[]);
  const junctionOptions=databaseCredentialOptions({base:options.base,powershell:options.powershell,syntheticRunId:randomUUID()});
  await assert.rejects(lstat(junctionOptions.root),{code:'ENOENT'});await symlink(root,junctionOptions.root,'junction');
  try{await denied(new WindowsDatabaseCredentialStore({base:options.base,powershell:options.powershell,syntheticRunId:junctionOptions.syntheticRunId}).store(otherId,privileges(),'worker',entry.password));}
  finally{assert.ok((await lstat(junctionOptions.root)).isSymbolicLink());await unlink(junctionOptions.root);}
  pass('Unowned existing roots and a junction to a valid store are not adopted');
  const request={schema:1,operation:'protect',base:options.base,syntheticRunId:runId,purpose:'carebridge-database-credential',scope:'CurrentUser',
    credentialId:otherId,binding:databaseCredentialBinding(privileges(),'worker'),createdAt:new Date().toISOString(),ownerSid:null,value:entry.password.toString('base64')};
  const malformed=[{...request,scope:'LocalMachine'},{...request,schema:true},{...request,purpose:'carebridge-recovery-key'},
    {...request,binding:{...request.binding,kind:'owner'}},{...request,binding:{...request.binding,databaseOid:true}},
    {...request,value:Buffer.alloc(64).toString('base64')},{...request,value:Buffer.alloc(31,65).toString('base64')},
    {...request,ownerSid:'S-1-5-21-11-22-33-1001'},{...request,extra:true}].map(encodePrivateSecretFrame);
  const good=encodePrivateSecretFrame(request),duplicate=Buffer.from(JSON.stringify(request).replace('"kind":"worker"','"kind":"worker","kind":"worker"'));
  const duplicateHeader=Buffer.alloc(4);duplicateHeader.writeUInt32BE(duplicate.length);
  malformed.push(good.subarray(0,-1),Buffer.concat([good,Buffer.from([0])]),Buffer.concat([duplicateHeader,duplicate]));
  try {for(const bytes of malformed){const result=child(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',provider],bytes);
    assert.equal(result.status,1);assert.equal(result.stdout.length,0);assert.equal(result.stderr.toString(),'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE');}}
  finally{good.fill(0);duplicate.fill(0);for(const bytes of malformed)bytes.fill(0);}
  await assert.rejects(lstat(otherPath),{code:'ENOENT'});
  pass('Direct native bad schema/purpose/scope/role/OID/password/owner/framing returns only a fixed error');
  for(const kind of ['owner','invalid'])await denied(store.store(otherId,privileges(),kind,entry.password));
  await denied(store.store(otherId,privileges(),'worker','string-password'));await assert.rejects(lstat(otherPath),{code:'ENOENT'});
  pass('Owner/unknown kinds and plaintext-string input cannot create a credential file');
  for(const saved of entries)await roundtrip(saved);
  pass('All five owned encrypted entries remain readable after the negative checks');
} catch {
  failure={code:'SYNTHETIC_CREDENTIAL_CHECK_FAILED',completedChecks:checks.length};process.exitCode=1;
  console.error('Synthetic credential check failed; uncertain fixtures are retained, not adopted or reset.');
} finally {
  for(const entry of entries)entry.password.fill(0);key.fill(0);
  try {
    if(failure)throw new Error('Retain uncertain fixture');
    assert.equal(root,win32.join(options.privateRoot,'checks',`credential-check-${runId}`));
    const validateRoot=async(directory,names,receiptFile,purpose) => {
      const info=await lstat(directory);assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.deepEqual((await readdir(directory)).sort(),names.sort());
      const receipt=JSON.parse(await readFile(win32.join(directory,receiptFile)));assert.equal(receipt.root,directory);assert.equal(receipt.purpose,purpose);
      for(const name of names){const file=await lstat(win32.join(directory,name));assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink===1);}
    };
    await validateRoot(root,[receiptName,...entries.map(({id}) => `${id}.dpapi`)],receiptName,'carebridge-windows-database-credentials');
    if(keyMade)await validateRoot(keyOptions.root,['.carebridge-key-store.json',`${keyId}.dpapi`],'.carebridge-key-store.json','carebridge-windows-recovery-keys');
    if(unknownMade){assert.equal(unknownOptions.root,win32.join(options.privateRoot,'checks',`credential-check-${unknownOptions.syntheticRunId}`));
      const info=await lstat(unknownOptions.root);assert.ok(info.isDirectory() && !info.isSymbolicLink());assert.deepEqual(await readdir(unknownOptions.root),[]);}
    // Exact fresh owned files and empty UUID directories only, never recursive.
    for(const entry of entries)await unlink(entry.path);await unlink(win32.join(root,receiptName));await rmdir(root);
    if(keyMade){await unlink(keyPath);await unlink(win32.join(keyOptions.root,'.carebridge-key-store.json'));await rmdir(keyOptions.root);}
    if(unknownMade)await rmdir(unknownOptions.root);cleanup=true;
  } catch {failure??={code:'SYNTHETIC_CREDENTIAL_CLEANUP_UNCONFIRMED'};process.exitCode=1;}
  for(const entry of entries)entry.original?.fill(0);keyOriginal?.fill(0);
  const result={runId,at:new Date().toISOString(),passed:!failure && cleanup && checks.length===15,checks,cleanup,failure,
    limitations:['Synthetic secrets only; no operating password/role/service/API created','Custody is not actual PostgreSQL authentication or role-grant verification',
      'CurrentUser is not same-user-process/admin isolation; JS/.NET strings are not guaranteed zeroed',
      'No independent backup, cross-user/profile-loss recovery, physical-device or power-loss proof']};
  await mkdir(reportRoot,{recursive:true});await writeFile(win32.join(reportRoot,'windows-database-credential-results.json'),JSON.stringify(result,null,2)+'\n');
  if(!result.passed)process.exitCode=1;console.log(JSON.stringify({passed:result.passed,checks:checks.length,cleanup,runId}));
}
