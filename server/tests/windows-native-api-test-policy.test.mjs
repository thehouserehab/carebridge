import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { windowsNativeApiBootstrap, nativeApiControlMessage, parseNativeApiControlMessage, nativeApiOrigin }
  from '../windows-native-api-test-policy.mjs';

const unavailable = { message: 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' };
function input() {
  const run = randomUUID();
  return { purpose: 'synthetic-carebridge-native-api',
    database: { storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run }, credentialId: randomUUID(),
      privileges: { roles: { owner: 'cb_owner', runtime: 'cb_runtime', bootstrap: 'cb_bootstrap', backup: 'cb_backup', worker: 'cb_worker' },
        target: { name: 'cb_synthetic', oid: 16384, ownerOid: 16385, confirm: 'cb_synthetic' } },
      endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] } },
    mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media` };
}
test('native API bootstrap captures only synthetic E, explicit TLS and a runtime-only database configuration', () => {
  const value = input(), captured = windowsNativeApiBootstrap(value);
  value.database.storage.base = 'E:\\Other'; value.database.endpoint.port = 1; value.database.privileges.roles.runtime = 'other';
  assert.equal(captured.database.storage.base, 'E:\\CarebridgeBeta'); assert.equal(captured.database.endpoint.port, 54321);
  assert.equal(captured.database.privileges.roles.runtime, 'cb_runtime');
  assert.deepEqual(Object.keys(captured).sort(), ['database', 'mediaRoot', 'root', 'screen']);
  assert.equal(captured.screen, 'api-only');
  for (const object of [captured, captured.database, captured.database.storage, captured.database.endpoint, captured.database.privileges])
    assert(Object.isFrozen(object));
  for (const field of ['kind', 'password', 'databaseUrl', 'createDatabase']) assert.equal(Object.hasOwn(captured.database, field), false);
});

test('native screen is a captured closed choice; omission stays API-only and client-like selectors are rejected', () => {
  for (const screen of ['api-only', 'prepared']) {
    const value = { ...input(), screen }, captured = windowsNativeApiBootstrap(value);
    value.screen = 'quarantine'; assert.equal(captured.screen, screen);
  }
  for (const screen of [undefined, null, '', 'quarantine', 'prepared-delivery', '?screen=prepared', {}, true])
    assert.throws(() => windowsNativeApiBootstrap({ ...input(), screen }), unavailable);
  let getters = 0;
  const value = Object.defineProperty(input(), 'screen', { get() { getters++; return 'prepared'; } });
  assert.throws(() => windowsNativeApiBootstrap(value), unavailable); assert.equal(getters, 0);
  assert.throws(() => windowsNativeApiBootstrap({ ...input(), query: { screen: 'prepared' } }), unavailable);
});
test('native API refuses alternate roles, roots, non-synthetic custody and extra configuration', () => {
  for (const change of [v => { v.purpose = 'production'; }, v => { v.extra = true; }, v => { v.database.kind = 'owner'; },
    v => { v.database.password = 'synthetic-private'; }, v => { delete v.database.storage.syntheticRunId; },
    v => { v.database.storage.syntheticRunId = randomUUID(); }, v => { v.mediaRoot += '\\..\\source-media'; },
    v => { v.mediaRoot = 'E:\\CarebridgeBeta\\private\\media'; }, v => { v.database.credentialId = 'existing'; },
    v => { v.database.endpoint.ssl = { rejectUnauthorized: false }; }, v => { v.database.endpoint.connectionString = 'private'; }]) {
    const value = input(); change(value); assert.throws(() => windowsNativeApiBootstrap(value), unavailable);
  }
});
test('native API requires explicit CA and loopback TLS without URL, DNS, plaintext or default-port adoption', () => {
  for (const change of [v => { delete v.database.endpoint.ca; }, v => { v.database.endpoint.ca = 'invalid'; },
    v => { v.database.endpoint = { host: '127.0.0.1', port: 54321, transport: 'synthetic-loopback' }; },
    v => { v.database.endpoint.host = 'localhost'; }, v => { v.database.endpoint.host = '192.0.2.1'; },
    v => { delete v.database.endpoint.port; }, v => { v.database.endpoint.port = '54321'; }]) {
    const value = input(); change(value); assert.throws(() => windowsNativeApiBootstrap(value), unavailable);
  }
});
test('API IPC frames carry only session ID, finite state and ready-only loopback origin', () => {
  const id = randomUUID();
  for (const kind of ['ready', 'stopped', 'failed']) {
    const frame = nativeApiControlMessage(id, kind, kind === 'ready' ? 'http://127.0.0.1:4180' : undefined);
    assert.deepEqual(parseNativeApiControlMessage(frame, id, 'child'), frame); assert(Object.isFrozen(frame));
  }
  const stop = nativeApiControlMessage(id, 'stop'); assert.deepEqual(parseNativeApiControlMessage(stop, id, 'parent'), stop);
  for (const [value, direction, handle] of [[{ ...stop, password: 'synthetic-private' }, 'parent'], [stop, 'child'],
    [nativeApiControlMessage(id, 'ready', 'http://127.0.0.1:4180'), 'parent'], [stop, 'parent', {}],
    [{ ...stop, instanceId: randomUUID() }, 'parent'], [{ ...stop, origin: 'http://127.0.0.1:4180' }, 'parent']])
    assert.throws(() => parseNativeApiControlMessage(value, id, direction, handle), unavailable);
  assert.throws(() => nativeApiControlMessage(id, 'failed', 'private'), unavailable);
  assert.throws(() => nativeApiControlMessage('not-an-id', 'stop'), unavailable);
});
test('ready origin rejects remote, normalized, privileged or decorated addresses', () => {
  for (const value of ['http://localhost:4180', 'https://127.0.0.1:4180', 'http://127.0.0.1:80', 'http://127.0.0.1:1023',
    'http://127.0.0.1:65536', 'http://127.0.0.1:04180', 'http://127.0.0.1:4180/', 'http://127.0.0.1:4180/?private',
    'http://127.0.0.1:4180#private', 'http://192.0.2.1:4180']) assert.throws(() => nativeApiOrigin(value));
  assert.equal(nativeApiOrigin('http://127.0.0.1:1024'), 'http://127.0.0.1:1024');
  assert.equal(nativeApiOrigin('http://127.0.0.1:65535'), 'http://127.0.0.1:65535');
});
