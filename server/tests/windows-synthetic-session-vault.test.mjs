import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SESSION_VAULT_PURPOSE, SESSION_VAULT_PAYLOAD_LIMIT, SESSION_VAULT_CIPHERTEXT_LIMIT,
  sessionVaultId, syntheticSessionVaultOptions, canonicalVaultBase64, validateProtectedSessionVault,
  validateSessionVaultResponse, encodeSessionVaultFrame, decodeSessionVaultFrame } from '../windows-synthetic-session-vault-policy.mjs';
import { WindowsSyntheticSessionVault } from '../windows-synthetic-session-vault.mjs';

// Pure policy/IO-contract checks only: no E directory, DPAPI invocation, database,
// service or actual credential. Native protection is verified separately.
const vaultId = randomUUID(), syntheticRunId = randomUUID();
const input = {base:'E:\\CarebridgeSynthetic',powershell:'C:\\Tools\\pwsh.exe',syntheticRunId};
const options = syntheticSessionVaultOptions(input);
const envelope = () => ({schema:1,purpose:SESSION_VAULT_PURPOSE,scope:'CurrentUser',syntheticRunId,vaultId,
  root:options.root,createdAt:'2026-10-10T00:00:00.000Z',ownerSid:'S-1-5-21-11-22-33-1001',value:Buffer.alloc(96,7).toString('base64')});
const failure = {message:'WINDOWS_SYNTHETIC_SESSION_VAULT_UNAVAILABLE',code:'WINDOWS_SYNTHETIC_SESSION_VAULT_UNAVAILABLE'};
const fails = fn => assert.throws(fn,failure);

test('session vault IDs require opaque lower-case v4 UUIDs', () => {
  assert.equal(sessionVaultId(vaultId),vaultId);
  for (const value of [null,undefined,1,'../secret',vaultId.toUpperCase(),`${vaultId}.dpapi`,'0'.repeat(36)]) fails(() => sessionVaultId(value));
});

test('vault requires an explicit synthetic run and fixed dedicated root', () => {
  assert.deepEqual(options,{...input,privateRoot:'E:\\CarebridgeSynthetic\\private',
    root:`E:\\CarebridgeSynthetic\\private\\checks\\session-vault-${syntheticRunId}`});
  assert.ok(Object.isFrozen(options));
  const {syntheticRunId:ignored,...operating} = input;
  for (const value of [null,[],operating,{...input,syntheticRunId:null},{...input,syntheticRunId:undefined},
    {...input,root:'E:\\Other'},{...input,reset:true},{...input,provider:'C:\\Other.ps1'}]) fails(() => syntheticSessionVaultOptions(value));
});

test('Windows path checks reject traversal, streams, network, roots and non-PowerShell executables', () => {
  for (const base of ['E:\\','C:\\Synthetic','E:Synthetic','\\\\host\\E\\Synthetic','E:\\Synthetic:stream',
    'E:\\Synthetic\\..\\other','E:\\Synthetic.','E:\\CON','E:\\Synthetic\\','E:\\Synthetic\n'])
    fails(() => syntheticSessionVaultOptions({...input,base}));
  for (const powershell of ['pwsh.exe','C:\\Tools\\cmd.exe','C:\\Tools\\pwsh.exe:stream','C:\\Tools\\pwsh.exe '])
    fails(() => syntheticSessionVaultOptions({...input,powershell}));
});

test('plaintext boundary permits 32 through 8192 bytes without interpreting payload JSON', () => {
  for (const size of [32,4096,SESSION_VAULT_PAYLOAD_LIMIT]) {
    const payload = Buffer.alloc(size,7), decoded = canonicalVaultBase64(payload.toString('base64'),32,SESSION_VAULT_PAYLOAD_LIMIT);
    assert.deepEqual(decoded,payload); decoded.fill(0); payload.fill(0);
  }
  for (const size of [0,31,8193]) fails(() => canonicalVaultBase64(Buffer.alloc(size).toString('base64'),32,8192));
});

test('base64 is canonical and rejects non-string, whitespace and oversized input', () => {
  const value = Buffer.alloc(32,7).toString('base64');
  for (const malformed of [null,undefined,{},value+'\n',value.slice(0,-1),'!'+value,'x'.repeat(12289)])
    fails(() => canonicalVaultBase64(malformed,32,8192));
});

test('envelope is purpose-separated from database and recovery custody', () => {
  assert.ok(Object.isFrozen(validateProtectedSessionVault(envelope(),vaultId,options)));
  for (const patch of [{schema:2},{purpose:'carebridge-recovery-key'},{purpose:'carebridge-database-credential'},
    {scope:'LocalMachine'},{vaultId:randomUUID()},{extra:'not-retained'}])
    fails(() => validateProtectedSessionVault({...envelope(),...patch},vaultId,options));
});

test('ciphertext cannot be relabelled as another synthetic session or canonical root', () => {
  for (const patch of [{syntheticRunId:randomUUID()},{root:options.root+'-other'},{root:options.root.toLowerCase()},
    {root:null},{syntheticRunId:null}]) fails(() => validateProtectedSessionVault({...envelope(),...patch},vaultId,options));
  fails(() => validateProtectedSessionVault(envelope(),vaultId,syntheticSessionVaultOptions({...input,syntheticRunId:randomUUID()})));
});

test('ciphertext metadata requires exact UTC calendar and bounded Windows account SID', () => {
  for (const patch of [{createdAt:'2026-02-30T00:00:00.000Z'},{createdAt:'2026-10-10T09:00:00+09:00'},
    {createdAt:'2026-10-10T00:00:00Z'},{createdAt:1},{ownerSid:'S-1-5-18'},{ownerSid:'everyone'},
    {ownerSid:'S-1-5-21-11-22-33-100000000000'}]) fails(() => validateProtectedSessionVault({...envelope(),...patch},vaultId,options));
});

test('ciphertext overhead is bounded separately from plaintext and within existing private frame', () => {
  for (const size of [64,SESSION_VAULT_CIPHERTEXT_LIMIT]) {
    const value = {...envelope(),value:Buffer.alloc(size).toString('base64')};
    assert.equal(validateProtectedSessionVault(value,vaultId,options),value);
    const frame = encodeSessionVaultFrame(value); assert.ok(frame.length <= 16388); frame.fill(0);
  }
  for (const size of [63,SESSION_VAULT_CIPHERTEXT_LIMIT+1])
    fails(() => validateProtectedSessionVault({...envelope(),value:Buffer.alloc(size).toString('base64')},vaultId,options));
});

test('maximum plaintext protect request still fits the unchanged 16KiB IO frame', () => {
  const request = {schema:1,operation:'protect',base:input.base,syntheticRunId,purpose:SESSION_VAULT_PURPOSE,
    scope:'CurrentUser',vaultId,root:options.root,createdAt:envelope().createdAt,ownerSid:null,
    value:Buffer.alloc(8192).toString('base64')};
  const frame = encodeSessionVaultFrame(request);
  assert.deepEqual(decodeSessionVaultFrame(frame),request); assert.ok(frame.length < 16388); frame.fill(0);
  fails(() => encodeSessionVaultFrame({value:'x'.repeat(16384)}));
});

test('frame refuses duplicate keys, malformed UTF-8, noncanonical JSON and trailing bytes', () => {
  const raw = content => {const bytes=Buffer.isBuffer(content)?content:Buffer.from(content),header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);};
  for (const value of ['{"schema":1,"schema":1}','{"schema": 1}','[]','null','1','{"schema":1}\n',Buffer.from([123,192,175,125])])
    fails(() => decodeSessionVaultFrame(raw(value)));
  const good = encodeSessionVaultFrame({schema:1});
  fails(() => decodeSessionVaultFrame(good.subarray(0,-1)));
  fails(() => decodeSessionVaultFrame(Buffer.concat([good,Buffer.from([0])])));
});

test('unprotect returns only a matching opaque ID and bounded caller-owned Buffer', () => {
  for (const size of [32,8192]) {
    const value = validateSessionVaultResponse({schema:1,vaultId,value:Buffer.alloc(size,7).toString('base64')},'unprotect',vaultId,options);
    assert.ok(Buffer.isBuffer(value)); assert.equal(value.length,size); value.fill(0);
  }
  for (const patch of [{schema:2},{vaultId:randomUUID()},{value:Buffer.alloc(31).toString('base64')},
    {value:Buffer.alloc(8193).toString('base64')},{trace:'internal'}])
    fails(() => validateSessionVaultResponse({schema:1,vaultId,value:Buffer.alloc(32).toString('base64'),...patch},'unprotect',vaultId,options));
});

test('check validates exact true response and never serves as unprotect fallback', () => {
  assert.equal(validateSessionVaultResponse({schema:1,vaultId,verified:true},'check',vaultId,options),true);
  for (const value of [{schema:1,vaultId,verified:1},{schema:1,vaultId,verified:false},{schema:1,vaultId,verified:true,value:'extra'}])
    fails(() => validateSessionVaultResponse(value,'check',vaultId,options));
  fails(() => validateSessionVaultResponse({schema:1,vaultId,value:Buffer.alloc(32).toString('base64')},'unknown',vaultId,options));
});

test('store rejects invalid input before any provider or filesystem operation', async () => {
  if (process.platform !== 'win32') { fails(() => new WindowsSyntheticSessionVault(input)); return; }
  const vault = new WindowsSyntheticSessionVault(input);
  for (const payload of [null,'do-not-protect',new Uint8Array(32),Buffer.alloc(31),Buffer.alloc(8193)])
    await assert.rejects(vault.store(vaultId,payload),failure);
  await assert.rejects(vault.store('../not-an-id',Buffer.alloc(32)),failure);
  await assert.rejects(vault.load('../not-an-id'),failure);
  assert.deepEqual(Object.keys(vault),[]);
  assert.equal(vault.options,undefined);
});

test('provider source fixes purpose, CurrentUser, session/root entropy and uses inherited private ACL checks', async () => {
  const source = await readFile(new URL('../../scripts/windows-synthetic-session-vault-provider.ps1',import.meta.url),'utf8');
  assert.match(source,/\$args\.Count -ne 0/);
  assert.match(source,/\$properties\.Count -ne 11/);
  assert.match(source,/Assert-CarebridgeStorageReceipt \$policy/);
  assert.match(source,/Assert-CarebridgePrivateAcl \$vaultPath \$policy \$false \$true/);
  assert.match(source,/\$entropyText = @\('carebridge-synthetic-session','1','CurrentUser',\$request\.syntheticRunId,\$request\.vaultId,/);
  assert.match(source,/\$request\.createdAt,\$policy\.OperatorSid\.Value,\$root\.ToUpperInvariant\(\)\)/);
  assert.equal((source.match(/DataProtectionScope\]::CurrentUser/g)??[]).length,2);
  assert.doesNotMatch(source,/DataProtectionScope\]::LocalMachine|WriteAllText|WriteAllBytes|Remove-Item|Set-Acl/);
  assert.match(source,/\[Console\]::Error\.Write\('WINDOWS_SYNTHETIC_SESSION_VAULT_UNAVAILABLE'\)/);
});
