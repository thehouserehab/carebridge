import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recoveryKeyId, recoveryKeyStoreOptions, recoveryKeyEnvironment, canonicalKeyBase64,
  encodeKeyStoreFrame, decodeKeyStoreFrame, validateProtectedRecoveryKey, validateKeyStoreResponse } from '../windows-recovery-key-policy.mjs';

const keyId = randomUUID(), options = { base:'E:\\CarebridgeBeta',powershell:'C:\\Tools\\pwsh.exe' };
const envelope = () => ({ schema:1,purpose:'carebridge-recovery-key',scope:'CurrentUser',keyId,
  createdAt:'2026-10-07T00:00:00.000Z',ownerSid:'S-1-5-21-11-22-33-1001',value:Buffer.alloc(96,7).toString('base64') });
const fails = (fn) => assert.throws(fn, { message:'WINDOWS_RECOVERY_KEY_UNAVAILABLE' });
test('key IDs only allow opaque lower-case version 4 UUIDs', () => {
  assert.equal(recoveryKeyId(keyId),keyId);
  for (const value of [null,1,'../password',`${keyId}.json`,keyId.toUpperCase(),'0'.repeat(36)]) fails(() => recoveryKeyId(value));
});
test('operating and synthetic paths are fixed, outside code, with no custom filename or mode', () => {
  assert.equal(recoveryKeyStoreOptions(options).root,'E:\\CarebridgeBeta\\private\\secrets\\recovery-keys');
  const run = randomUUID(); assert.equal(recoveryKeyStoreOptions({...options,syntheticRunId:run}).root,`E:\\CarebridgeBeta\\private\\checks\\key-check-${run}`);
  fails(() => recoveryKeyStoreOptions({...options,reset:true}));
  fails(() => recoveryKeyStoreOptions({...options,syntheticRunId:null}));
});
test('drive root, network, alternate streams, traversal, shell and reserved Windows paths are refused', () => {
  for (const base of ['E:\\','C:\\Beta','E:Beta','\\\\host\\E\\Beta','E:\\Beta:stream','E:\\Beta\\..\\other','E:\\Beta.','E:\\CON','E:\\Beta\\','E:\\Beta\n']) fails(() => recoveryKeyStoreOptions({...options,base}));
  for (const powershell of ['pwsh.exe','C:\\Tools\\cmd.exe','C:\\Tools\\pwsh.exe:stream','C:\\Tools\\pwsh.exe ']) fails(() => recoveryKeyStoreOptions({...options,powershell}));
});
test('native provider environment is allowlisted and strips application secrets and DLL/module injection', () => {
  const result = recoveryKeyEnvironment({SystemRoot:'C:\\Windows',UserProfile:'C:\\Users\\Synthetic',
    DATABASE_URL:'do-not-inherit',PGPASSWORD:'do-not-inherit',NODE_OPTIONS:'do-not-inherit',PSModulePath:'do-not-inherit',PATH:'do-not-inherit'},options.powershell);
  assert.deepEqual(Object.keys(result).sort(),['PATH','SYSTEMROOT','USERPROFILE']);
  assert.equal(result.PATH,'C:\\Tools;C:\\Windows\\System32;C:\\Windows');
  fails(() => recoveryKeyEnvironment({},options.powershell));
});
test('key bytes require canonical base64 and exact 256-bit plaintext length', () => {
  const value = Buffer.alloc(32,7).toString('base64'), decoded = canonicalKeyBase64(value,32,32);
  assert.equal(decoded.length,32); decoded.fill(0);
  for (const input of [null,value+'\n',value.slice(0,-1),Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64'),'!'+value]) fails(() => canonicalKeyBase64(input,32,32));
});
test('binary protocol preserves a bounded canonical JSON object', () => {
  const value = {schema:1,keyId,value:'synthetic'}, frame = encodeKeyStoreFrame(value);
  assert.deepEqual(decodeKeyStoreFrame(frame),value); frame.fill(0);
  fails(() => encodeKeyStoreFrame({value:'x'.repeat(17000)}));
});
test('protocol refuses truncated, trailing, malformed UTF-8, duplicate and non-object response frames', () => {
  const rawFrame = (content) => { const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header,bytes]); };
  for (const json of ['{"schema":1,"schema":1}','{"schema": 1}','[]','null','1','{"schema":1}\n']) fails(() => decodeKeyStoreFrame(rawFrame(json)));
  fails(() => decodeKeyStoreFrame(rawFrame(Buffer.from([0x7b,0xc0,0xaf,0x7d]))));
  const good = encodeKeyStoreFrame({schema:1}); fails(() => decodeKeyStoreFrame(good.subarray(0,-1))); fails(() => decodeKeyStoreFrame(Buffer.concat([good,Buffer.from([0])])));
});
test('ciphertext envelope binds exact schema, purpose, scope, owner, key ID and UTC timestamp', () => {
  assert.equal(validateProtectedRecoveryKey(envelope(),keyId).keyId,keyId);
  for (const patch of [{schema:2},{purpose:'password'},{scope:'LocalMachine'},{ownerSid:'everyone'},{keyId:randomUUID()},
    {createdAt:'2026-02-30T00:00:00.000Z'},{createdAt:'2026-10-07T09:00:00+09:00'},{value:Buffer.alloc(32).toString('base64')},{extra:'hidden'}]) fails(() => validateProtectedRecoveryKey({...envelope(),...patch},keyId));
});
test('unprotect response requires matching ID, no extra metadata and exactly 32 bytes', () => {
  const response = {schema:1,keyId,value:Buffer.alloc(32).toString('base64')};
  const key = validateKeyStoreResponse(response,'unprotect',keyId); assert.equal(key.length,32); key.fill(0);
  for (const patch of [{keyId:randomUUID()},{schema:2},{value:Buffer.alloc(96).toString('base64')},{trace:'internal'}]) fails(() => validateKeyStoreResponse({...response,...patch},'unprotect',keyId));
});
test('native check response is not a permissive truthy success or fallback', () => {
  assert.equal(validateKeyStoreResponse({schema:1,keyId,verified:true},'check',keyId),true);
  for (const response of [{schema:1,keyId,verified:1},{schema:1,keyId,verified:false},{schema:1,keyId,verified:true,value:'extra'}]) fails(() => validateKeyStoreResponse(response,'check',keyId));
  fails(() => validateKeyStoreResponse({schema:1,keyId,value:Buffer.alloc(32).toString('base64')},'unknown',keyId));
});
