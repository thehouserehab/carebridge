// Entire filesystem/native-provider boundary is a deterministic double.
// Synthetic E-shaped strings are policy inputs only: NO E/DPAPI/process IO.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstat as boundLstat, realpath as boundRealpath, open as boundOpen } from 'node:fs/promises';
import childProcess, { spawn as boundSpawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WindowsDatabaseCredentialStore } from '../windows-database-credential-store.mjs';
import { DATABASE_CREDENTIAL_PURPOSE, databaseCredentialBinding } from '../windows-database-credential-policy.mjs';
import { encodePrivateSecretFrame } from '../windows-private-secret-io.mjs';
import { serviceInput } from './database-service-fixtures.mjs';
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const unavailable = { message: 'WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE' };
const windowsOnly = { skip: process.platform !== 'win32' };
const pairs = (events) => events.map(({stage,edge}) => `${stage}:${edge}`);
function fixture({ readFailure = false, unprotectFailure = false, wrongBinding = false, changed = false, observer } = {}) {
  const id = randomUUID(), privileges = serviceInput(), binding = databaseCredentialBinding(privileges, 'worker');
  const events = [], state = { opens: 0, closes: 0, spawns: 0, providerBytes: [], inputFrames: [] };
  const envelope = { schema: 1, purpose: DATABASE_CREDENTIAL_PURPOSE, scope: 'CurrentUser', credentialId: id,
    binding: { ...binding, ...(wrongBinding ? { kind: 'runtime' } : {}) }, createdAt: '2026-10-07T00:00:00.000Z',
    ownerSid: 'S-1-5-21-11-22-33-1001', value: Buffer.alloc(96, 7).toString('base64') };
  const payload = Buffer.from(JSON.stringify(envelope)); let readStats = 0;
  const info = (file, changedTime = false) => ({ dev: 1n, ino: 2n, nlink: 1n, size: file ? BigInt(payload.length) : 0n,
    mtimeNs: changedTime ? 11n : 10n, ctimeNs: changedTime ? 11n : 10n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false });
  mock.method(fs, 'lstat', async (path) => {
    if (readFailure) throw Error('private filesystem details');
    return info(path.endsWith('.dpapi') || path.endsWith('.json'));
  });
  mock.method(fs, 'realpath', async (path) => path);
  mock.method(fs, 'open', async () => {
    state.opens++;
    return { stat: async () => info(true, changed && ++readStats > 1),
      read: async (buffer, offset, length, position) => ({ bytesRead: payload.copy(buffer, offset, position, position + length) }),
      close: async () => { state.closes++; } };
  });
  mock.method(childProcess, 'spawn', () => {
    state.spawns++;
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdin.end = (input) => {
      state.inputFrames.push(input);
      queueMicrotask(() => {
        if (unprotectFailure) {
          const bytes = Buffer.from('private native provider diagnostic'); state.providerBytes.push(bytes);
          child.stderr.emit('data', bytes); child.emit('close', 1); return;
        }
        const bytes = encodePrivateSecretFrame({ schema: 1, credentialId: id, binding, value: Buffer.alloc(64, 65).toString('base64') });
        state.providerBytes.push(bytes); child.stdout.emit('data', bytes); child.emit('close', 0);
      });
    };
    return child;
  });
  syncBuiltinESMExports();
  // Fail before product invocation if the named imports were not replaced.
  assert.equal(boundLstat, fs.lstat); assert.equal(boundRealpath, fs.realpath);
  assert.equal(boundOpen, fs.open); assert.equal(boundSpawn, childProcess.spawn);
  const onStage = (event) => { events.push(event); return observer?.(event); };
  const store = new WindowsDatabaseCredentialStore({ base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: randomUUID() }, { onStage });
  return { state, events, load: () => store.load(id, privileges, 'worker') };
}
test('real store/read/provider protocol path emits read, unprotect and post-read verification without content', windowsOnly, async () => {
  const f = fixture(), bytes = await f.load();
  try {
    assert.equal(bytes.length, 64);
    assert.deepEqual(pairs(f.events), ['credential-read:begin','credential-read:complete','credential-unprotect:begin',
      'credential-unprotect:complete','credential-recheck:begin','credential-recheck:complete']);
    for (const event of f.events) {
      assert.deepEqual(Object.keys(event), ['stage','edge','elapsedMs']); assert(Object.isFrozen(event));
      assert(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0);
    }
    assert.equal(f.state.spawns, 1); assert.equal(f.state.opens, 1); assert.equal(f.state.closes, 1);
    assert(f.state.providerBytes.every(buffer => buffer.every(byte => byte === 0)));
    assert(f.state.inputFrames.every(buffer => buffer.every(byte => byte === 0)));
    for (const secret of ['E:', 'Carebridge', 'cb_worker', 'ownerSid', 'private', 'AAAA']) assert(!JSON.stringify(f.events).includes(secret));
  } finally { bytes.fill(0); }
});
test('read failure stops before unprotect, with the same redacted public failure', windowsOnly, async () => {
  const f = fixture({readFailure:true}); await assert.rejects(f.load(), unavailable);
  assert.deepEqual(pairs(f.events), ['credential-read:begin','credential-read:failed']); assert.equal(f.state.spawns, 0);
});
test('binding and provider failure share unprotect boundary but never skip verification or expose raw diagnostics', windowsOnly, async () => {
  for (const patch of [{wrongBinding:true}, {unprotectFailure:true}]) {
    const f = fixture(patch); await assert.rejects(f.load(), unavailable);
    assert.deepEqual(pairs(f.events), ['credential-read:begin','credential-read:complete','credential-unprotect:begin','credential-unprotect:failed']);
    assert.equal(f.state.spawns, patch.wrongBinding ? 0 : 1); assert.equal(f.state.closes, 1);
    assert(!JSON.stringify(f.events).includes('private')); mock.restoreAll(); syncBuiltinESMExports();
  }
});
test('ciphertext changed after unprotect fails its distinct recheck boundary', windowsOnly, async () => {
  const f = fixture({changed:true}); await assert.rejects(f.load(), unavailable);
  assert.deepEqual(pairs(f.events).slice(-2), ['credential-recheck:begin','credential-recheck:failed']); assert.equal(f.state.closes, 1);
});
test('throwing, rejected and pending observer results do not alter credential custody or its buffers', windowsOnly, async () => {
  for (const observer of [() => { throw Error('private observer'); }, () => Promise.reject(Error('private observer')), () => new Promise(() => {})]) {
    const f = fixture({observer}), bytes = await f.load(); bytes.fill(0);
    assert.equal(f.state.closes, 1); assert.equal(f.state.spawns, 1);
    assert(f.state.providerBytes.every(buffer => buffer.every(byte => byte === 0)));
    await new Promise(resolve => setImmediate(resolve)); mock.restoreAll(); syncBuiltinESMExports();
  }
});
