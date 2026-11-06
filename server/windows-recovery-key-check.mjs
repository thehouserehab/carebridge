// Explicit synthetic check only; never reads/creates an operating key. Own
// UUID fixtures only; no existing beta data, API, service or external access.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile, link, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { WindowsRecoveryKeyStore } from './windows-recovery-key-store.mjs';
import { recoveryKeyStoreOptions, recoveryKeyEnvironment, encodeKeyStoreFrame } from './windows-recovery-key-policy.mjs';
import { createRecoveryBundle } from './recovery-bundle.mjs';

const args = process.argv.slice(2);
assert.equal(process.platform,'win32','Windows is required');
assert.equal(args.length,5,'Use --base E:\\CarebridgeBeta --powershell <absolute pwsh.exe> --confirm-synthetic-key-store');
assert.equal(args[0],'--base'); assert.equal(args[2],'--powershell'); assert.equal(args[4],'--confirm-synthetic-key-store');
const runId = randomUUID(), keyId = randomUUID(), unknownRunId = randomUUID(), otherKeyId = randomUUID();
const options = recoveryKeyStoreOptions({ base:args[1],powershell:args[3],syntheticRunId:runId });
const unknownOptions = recoveryKeyStoreOptions(optionsInput(unknownRunId));
function optionsInput(id = runId) { return {base:args[1],powershell:args[3],syntheticRunId:id}; }
const store = new WindowsRecoveryKeyStore(optionsInput()), root = options.root, path = win32.join(root,`${keyId}.dpapi`);
const otherPath = win32.join(root,`${otherKeyId}.dpapi`), bundleRoot = win32.join(root,'bundles'), bundleId = randomUUID();
const key = randomBytes(32), checks = []; let original, failure = null, cleanup = false, bundleMade = false, unknownMade = false;
let stage = 'store', readerDiagnostic = null;
const moduleUrl = new URL('./windows-recovery-key-store.mjs',import.meta.url).href;
const provider = fileURLToPath(new URL('../scripts/windows-recovery-key-provider.ps1',import.meta.url));
const fixture = fileURLToPath(new URL('./tests/windows-recovery-key-fixture.ps1',import.meta.url));
const reportRoot = fileURLToPath(new URL('../test-results/',import.meta.url));
const denied = (promise) => assert.rejects(promise,{message:'WINDOWS_RECOVERY_KEY_UNAVAILABLE'});
function child(executable, childArgs, input) {
  const result = spawnSync(executable,childArgs,{input,windowsHide:true,timeout:25000,maxBuffer:32768,
    env:recoveryKeyEnvironment(process.env,options.powershell)});
  assert.equal(result.error,undefined,'Synthetic child must finish');
  return result;
}
function acl(action) {
  const result = child(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
    '-Base',options.base,'-RunId',runId,'-KeyId',keyId,'-Action',action]);
  assert.equal(result.status,0,'Owned synthetic ACL action must succeed');
  assert.equal(result.stdout.toString(),'KEY_FIXTURE_ACL_OK'); assert.equal(result.stderr.length,0);
}
async function corrupted(patch) {
  await writeFile(path,JSON.stringify({...JSON.parse(original.toString()),...patch}));
  try { await denied(store.load(keyId)); }
  finally { await writeFile(path,original); }
}
try {
  await assert.rejects(lstat(root),{code:'ENOENT'});
  await store.store(keyId,key); original = await readFile(path);
  assert.ok(!original.includes(key) && !original.includes(key.toString('base64')) && !original.includes(key.toString('hex')));
  const envelope = JSON.parse(original.toString()); assert.equal(envelope.scope,'CurrentUser');
  checks.push('Native CurrentUser DPAPI persists ciphertext only under a fresh protected E fixture');
  stage = 'same-process-read';
  let read = await store.load(keyId); try { assert.deepEqual(read,key); } finally { read.fill(0); }
  const readerCode = `
    import { createHash } from 'node:crypto';
    import { WindowsRecoveryKeyStore } from ${JSON.stringify(moduleUrl)};
    const [base,powershell,syntheticRunId,keyId,digest] = process.argv.slice(1);
    const store = new WindowsRecoveryKeyStore({base,powershell,syntheticRunId});
    let key;
    try { key = await store.load(keyId); if (createHash('sha256').update(key).digest('hex') !== digest) throw new Error('Synthetic mismatch'); process.stdout.write('KEY_STORE_READ_OK'); }
    catch { process.stderr.write('KEY_READ_FAILED'); process.exitCode = 1; }
    finally { key?.fill(0); }
  `;
  stage = 'fresh-process-read';
  const fresh = child(process.execPath,['--input-type=module','-e',readerCode,options.base,options.powershell,runId,keyId,createHash('sha256').update(key).digest('hex')]);
  readerDiagnostic = {exitCode:fresh.status,expectedOutput:fresh.stdout.toString() === 'KEY_STORE_READ_OK',fixedReadFailure:fresh.stderr.toString() === 'KEY_READ_FAILED'};
  assert.equal(fresh.status,0); assert.equal(fresh.stdout.toString(),'KEY_STORE_READ_OK'); assert.equal(fresh.stderr.length,0);
  checks.push('A fresh Node and native-provider process reopens the persisted key without a memory cache');
  stage = 'negative-checks';
  const replacement = randomBytes(32);
  try { await denied(store.store(keyId,replacement)); } finally { replacement.fill(0); }
  assert.deepEqual(await readFile(path),original);
  checks.push('Same-ID write is refused without overwriting ciphertext');
  await corrupted({scope:'LocalMachine'}); await corrupted({ownerSid:'S-1-5-21-11-22-33-1001'});
  await corrupted({createdAt:'2026-10-07T00:00:00.000Z'});
  checks.push('Scope, owner and authenticated timestamp changes are refused');
  const changed = Buffer.from(envelope.value,'base64'); changed[changed.length-1] ^= 1;
  await corrupted({value:changed.toString('base64')}); changed.fill(0);
  await corrupted({value:key.toString('base64')});
  checks.push('Altered DPAPI ciphertext and a plaintext key masquerading as ciphertext are refused');
  await writeFile(otherPath,JSON.stringify({...envelope,keyId:otherKeyId}));
  try { await denied(store.load(otherKeyId)); } finally { await unlink(otherPath); }
  checks.push('Copying a valid encrypted blob to a different key ID does not decrypt');
  await writeFile(path,original.toString().replace('"schema":1','"schema":1,"schema":1'));
  try { await denied(store.load(keyId)); } finally { await writeFile(path,original); }
  checks.push('Duplicate metadata properties are rejected before decryption');
  await link(path,otherPath);
  try { await denied(store.load(keyId)); } finally { await unlink(otherPath); }
  checks.push('A multiply-linked key file is rejected');
  acl('file-add');
  try { await denied(store.load(keyId)); } finally { acl('file-remove'); }
  acl('root-add');
  try { await denied(store.store(otherKeyId,key)); await assert.rejects(lstat(otherPath),{code:'ENOENT'}); }
  finally { acl('root-remove'); }
  read = await store.load(keyId); try { assert.deepEqual(read,key); } finally { read.fill(0); }
  checks.push('Broadened key-file/root NTFS access is refused without an automatic ACL repair');
  await assert.rejects(lstat(unknownOptions.root),{code:'ENOENT'}); await mkdir(unknownOptions.root); unknownMade = true;
  await denied(new WindowsRecoveryKeyStore(optionsInput(unknownRunId)).store(otherKeyId,key));
  assert.deepEqual(await readdir(unknownOptions.root),[]);
  checks.push('An existing directory without this key-store ownership receipt is not adopted');
  const junctionOptions = recoveryKeyStoreOptions(optionsInput(randomUUID()));
  await assert.rejects(lstat(junctionOptions.root),{code:'ENOENT'});
  await symlink(root,junctionOptions.root,'junction');
  try {
    await denied(new WindowsRecoveryKeyStore({base:options.base,powershell:options.powershell,syntheticRunId:junctionOptions.syntheticRunId}).store(otherKeyId,key));
    await assert.rejects(lstat(otherPath),{code:'ENOENT'});
  } finally {
    assert.ok((await lstat(junctionOptions.root)).isSymbolicLink());
    await unlink(junctionOptions.root); // Exact newly-created junction only.
  }
  checks.push('A junction to a valid owned key store is refused before writing through it');
  const request = {schema:1,operation:'protect',base:options.base,syntheticRunId:runId,purpose:'carebridge-recovery-key',scope:'LocalMachine',
    keyId:otherKeyId,createdAt:new Date().toISOString(),ownerSid:null,value:Buffer.alloc(32).toString('base64')};
  const invalidInput = encodeKeyStoreFrame(request);
  try {
    const deniedNative = child(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',provider],invalidInput);
    const duplicate = Buffer.from(JSON.stringify({...request,scope:'CurrentUser'}).replace('"schema":1','"schema":1,"schema":1'));
    const duplicateHeader = Buffer.alloc(4); duplicateHeader.writeUInt32BE(duplicate.length);
    const duplicateFrame = Buffer.concat([duplicateHeader,duplicate]);
    const booleanSchema = encodeKeyStoreFrame({...request,scope:'CurrentUser',schema:true});
    const arrayScope = encodeKeyStoreFrame({...request,scope:['CurrentUser']});
    const inputs = [invalidInput,invalidInput.subarray(0,-1),Buffer.concat([invalidInput,Buffer.from([0])]),duplicateFrame,booleanSchema,arrayScope];
    try {
      const nativeResults = [deniedNative,...inputs.slice(1).map((input) => child(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',provider],input))];
      for (const result of nativeResults) {
        assert.equal(result.status,1); assert.equal(result.stdout.length,0);
        assert.equal(result.stderr.toString(),'WINDOWS_RECOVERY_KEY_UNAVAILABLE');
      }
    } finally { duplicate.fill(0); duplicateFrame.fill(0); inputs[2].fill(0); booleanSchema.fill(0); arrayScope.fill(0); }
    await assert.rejects(lstat(otherPath),{code:'ENOENT'});
  } finally { invalidInput.fill(0); }
  checks.push('Direct native-provider LocalMachine, truncated, trailing, duplicate and coercible input fail with only a generic error');
  stage = 'bundle'; await mkdir(bundleRoot); bundleMade = true;
  const entries = [{name:'database.pgcustom',bytes:Buffer.from('SYNTHETIC-KEY-ROUNDTRIP-NOT-A-PG-DUMP')},
    {name:'snapshot.json',bytes:Buffer.from('{"synthetic":true}') }];
  read = await store.load(keyId);
  try { await createRecoveryBundle({directory:bundleRoot,runId:bundleId,key:read,
    entries:entries.map((entry) => ({name:entry.name,open:() => Readable.from([entry.bytes])}))}); }
  finally { read.fill(0); }
  const bundleReaderCode = `
    import { WindowsRecoveryKeyStore } from ${JSON.stringify(moduleUrl)};
    import { openRecoveryBundle } from ${JSON.stringify(new URL('./recovery-bundle.mjs',import.meta.url).href)};
    const [base,powershell,syntheticRunId,keyId,directory,runId] = process.argv.slice(1);
    let key, reader;
    try {
      key = await new WindowsRecoveryKeyStore({base,powershell,syntheticRunId}).load(keyId);
      reader = await openRecoveryBundle({directory,runId,key});
      for (const [name,expected] of [['database.pgcustom','SYNTHETIC-KEY-ROUNDTRIP-NOT-A-PG-DUMP'],['snapshot.json','{"synthetic":true}']]) {
        const chunks = []; for await (const bytes of reader.stream(name)) chunks.push(Buffer.from(bytes));
        if (Buffer.concat(chunks).toString() !== expected) throw new Error('Synthetic mismatch');
        for (const chunk of chunks) chunk.fill(0);
      }
      process.stdout.write('KEY_BUNDLE_READ_OK');
    } catch { process.stderr.write('KEY_BUNDLE_FAILED'); process.exitCode = 1; }
    finally { await reader?.close(); key?.fill(0); }
  `;
  const freshBundle = child(process.execPath,['--input-type=module','-e',bundleReaderCode,options.base,options.powershell,runId,keyId,bundleRoot,bundleId]);
  assert.equal(freshBundle.status,0); assert.equal(freshBundle.stdout.toString(),'KEY_BUNDLE_READ_OK'); assert.equal(freshBundle.stderr.length,0);
  checks.push('A fresh process uses the persisted DPAPI key to authenticate/read an existing bundle primitive (not a DB restore)');
} catch {
  failure = {code:'SYNTHETIC_KEY_CHECK_FAILED',stage,completedChecks:checks.length,readerDiagnostic}; process.exitCode = 1;
  console.error('Synthetic key check failed; no operating key or existing beta data was adopted.');
} finally {
  key.fill(0); original?.fill(0);
  try {
    if (failure) throw new Error('Retain uncertain synthetic fixture for inspection');
    assert.equal(root,win32.join(options.privateRoot,'checks',`key-check-${runId}`));
    assert.ok((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink());
    assert.deepEqual((await readdir(root)).sort(),['.carebridge-key-store.json','bundles',`${keyId}.dpapi`].sort());
    const receipt = JSON.parse((await readFile(win32.join(root,'.carebridge-key-store.json'))).toString());
    assert.equal(receipt.root,root); assert.equal(receipt.purpose,'carebridge-windows-recovery-keys');
    const files = [win32.join(root,'.carebridge-key-store.json'),path];
    if (bundleMade) {
      assert.ok((await lstat(bundleRoot)).isDirectory() && !(await lstat(bundleRoot)).isSymbolicLink());
      assert.deepEqual(await readdir(bundleRoot),[`${bundleId}.cbb`]); files.push(win32.join(bundleRoot,`${bundleId}.cbb`));
    }
    for (const file of files) { const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1); }
    if (unknownMade) {
      assert.equal(unknownOptions.root,win32.join(options.privateRoot,'checks',`key-check-${unknownRunId}`));
      assert.ok((await lstat(unknownOptions.root)).isDirectory() && !(await lstat(unknownOptions.root)).isSymbolicLink());
      assert.deepEqual(await readdir(unknownOptions.root),[]);
    }
    // Only known, validated synthetic files and empty UUID dirs; no recursion.
    for (const file of files) await unlink(file);
    if (bundleMade) await rmdir(bundleRoot); await rmdir(root);
    if (unknownMade) await rmdir(unknownOptions.root); cleanup = true;
  } catch { failure ??= {code:'SYNTHETIC_KEY_CLEANUP_UNCONFIRMED'}; process.exitCode = 1; }
  await mkdir(reportRoot,{recursive:true});
  const result = {runId,at:new Date().toISOString(),passed:!failure && cleanup && checks.length === 13,checks,cleanup,failure,
    limitations:['Synthetic key only; no operating key, OS account or API activation','CurrentUser is not same-user-process/admin isolation',
      'No independent backup medium, portable key recovery, cross-user/physical-device or power-loss proof','Bundle payload is a synthetic sentinel, not a PostgreSQL dump']};
  await writeFile(win32.join(reportRoot,'windows-recovery-key-results.json'),JSON.stringify(result,null,2)+'\n');
  if (!result.passed) process.exitCode = 1;
  console.log(JSON.stringify({passed:result.passed,checks:checks.length,cleanup,runId}));
}
