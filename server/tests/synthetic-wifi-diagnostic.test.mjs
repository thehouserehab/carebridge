import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSyntheticWifiDiagnostic, writeSyntheticWifiDiagnostic } from '../synthetic-wifi-diagnostic.mjs';

const code = 'SYNTHETIC_WIFI_DIAGNOSTIC_UNAVAILABLE';
const marker = 'MUST-NOT-LEAK-PRIVATE-PATH-OUTPUT';
const valid = () => ({ schema: 1, observationOnly: true, state: 'failed', preflight: 'passed', ready: 'failed',
  failureReason: 'approval', readyDeadlineExpired: true, lifetimeExpired: false, cleanupDeadlineExpired: true, everActive: false,
  stopRequested: true, cleanup: 'unconfirmed', observedStage: null,
  launcher: { spawnObserved: true, exitObserved: false, closed: false, errorObserved: false,
    signalObserved: false, exitCode: null, outcome: 'pending' } });
function fixedError(error) {
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.deepEqual(Object.keys(error), ['code']);
  assert(!JSON.stringify(error).includes(marker)); assert(!error.stack.includes(marker));
  return true;
}

test('sanitizer copies and deeply freezes exact own-data snapshots without inferring success', () => {
  const source = valid(), result = sanitizeSyntheticWifiDiagnostic(source);
  assert.deepEqual(result, source); assert.notEqual(result, source); assert.notEqual(result.launcher, source.launcher);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.launcher));
  source.state = 'active'; source.launcher.outcome = 'exited';
  assert.equal(result.state, 'failed'); assert.equal(result.launcher.outcome, 'pending');
  assert.throws(() => { result.state = 'active'; }, TypeError);
  assert.throws(() => { result.launcher.closed = true; }, TypeError);
  const plain = Object.assign(Object.create(null), valid());
  plain.launcher = Object.assign(Object.create(null), plain.launcher);
  assert.deepEqual(sanitizeSyntheticWifiDiagnostic(plain), valid());
  assert.equal(sanitizeSyntheticWifiDiagnostic({ ...valid(), launcher: null }).launcher, null);
});

test('all fixed classifications and exact integer boundaries are accepted', () => {
  const enumerations = {
    state: ['preparing', 'waiting-approval', 'active', 'stopping', 'failed', 'removed'],
    preflight: ['pending', 'passed', 'failed'], ready: ['pending', 'active', 'failed'],
    failureReason: [null, 'platform', 'configuration', 'executable', 'elevated', 'network', 'port', 'firewall-allow',
      'firewall-block', 'firewall-uncertain', 'inspection', 'approval', 'cancelled', 'status', 'cleanup-pending'],
    cleanup: ['not-started', 'pending', 'confirmed', 'unconfirmed'], observedStage: [null, 'active', 'removed', 'failed'],
  };
  for (const [key, values] of Object.entries(enumerations)) for (const value of values)
    assert.equal(sanitizeSyntheticWifiDiagnostic({ ...valid(), [key]: value })[key], value);
  for (const outcome of ['pending', 'not-spawned', 'declined', 'launch-failed', 'helper-failed', 'observation-failed', 'exited', 'unrecognized'])
    for (const exitCode of [null, -2147483648, -1, 0, 1, 1223, 4294967295]) {
      const value = valid(); Object.assign(value.launcher, { outcome, exitCode });
      assert.deepEqual(sanitizeSyntheticWifiDiagnostic(value).launcher, value.launcher);
    }
});

test('missing, extra, malformed and unsafe scalar fields fail closed', () => {
  for (const key of Object.keys(valid())) {
    const value = valid(); delete value[key]; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  for (const key of Object.keys(valid().launcher)) {
    const value = valid(); delete value.launcher[key]; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  for (const key of ['stdout', 'stderr', 'error', 'path', 'controlDirectory', 'ip', 'credential', 'toJSON']) {
    assert.throws(() => sanitizeSyntheticWifiDiagnostic({ ...valid(), [key]: marker }), fixedError);
    const value = valid(); value.launcher[key] = marker; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  for (const [key, value] of Object.entries({ schema: '1', observationOnly: false, state: marker, preflight: marker,
    ready: marker, failureReason: marker, cleanup: marker, observedStage: marker, launcher: undefined }))
    assert.throws(() => sanitizeSyntheticWifiDiagnostic({ ...valid(), [key]: value }), fixedError);
  for (const key of ['readyDeadlineExpired', 'lifetimeExpired', 'cleanupDeadlineExpired', 'everActive', 'stopRequested']) for (const value of [null, 0, 'true', undefined])
    assert.throws(() => sanitizeSyntheticWifiDiagnostic({ ...valid(), [key]: value }), fixedError);
  for (const key of ['spawnObserved', 'exitObserved', 'closed', 'errorObserved', 'signalObserved']) for (const bad of [null, 0, 'true', undefined]) {
    const value = valid(); value.launcher[key] = bad; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  for (const exitCode of [undefined, NaN, Infinity, -Infinity, 0.5, -2147483649, 4294967296, '0', 0n, {}]) {
    const value = valid(); value.launcher.exitCode = exitCode; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  const invalidOutcome = valid(); invalidOutcome.launcher.outcome = marker;
  assert.throws(() => sanitizeSyntheticWifiDiagnostic(invalidOutcome), fixedError);
});

test('getters, setters, symbols, custom prototypes and proxies never execute', () => {
  let observed = 0;
  const getter = () => { observed++; throw new Error(marker); };
  for (const target of ['snapshot', 'launcher']) for (const key of [target === 'snapshot' ? 'state' : 'outcome', 'extra']) {
    const value = valid(), owner = target === 'snapshot' ? value : value.launcher;
    Object.defineProperty(owner, key, { enumerable: true, configurable: true, get: getter });
    assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  }
  const setter = valid(); Object.defineProperty(setter, 'state', { set: getter });
  assert.throws(() => sanitizeSyntheticWifiDiagnostic(setter), fixedError);
  for (const target of ['snapshot', 'launcher']) {
    const value = valid(), owner = target === 'snapshot' ? value : value.launcher;
    owner[Symbol(marker)] = marker; assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
    const hidden = valid(); Object.defineProperty(target === 'snapshot' ? hidden : hidden.launcher, 'extra', { value: marker });
    assert.throws(() => sanitizeSyntheticWifiDiagnostic(hidden), fixedError);
    const inherited = valid(); Object.setPrototypeOf(target === 'snapshot' ? inherited : inherited.launcher, { private: marker });
    assert.throws(() => sanitizeSyntheticWifiDiagnostic(inherited), fixedError);
  }
  const proxy = new Proxy(valid(), { get: getter, ownKeys: getter, getPrototypeOf: getter, getOwnPropertyDescriptor: getter });
  assert.throws(() => sanitizeSyntheticWifiDiagnostic(proxy), fixedError);
  assert.throws(() => sanitizeSyntheticWifiDiagnostic({ ...valid(), launcher: proxy }), fixedError);
  const revoked = Proxy.revocable(valid(), {}); revoked.revoke();
  assert.throws(() => sanitizeSyntheticWifiDiagnostic(revoked.proxy), fixedError);
  for (const value of [undefined, null, true, 1, marker, [], new Date(), new (class Diagnostic {})()])
    assert.throws(() => sanitizeSyntheticWifiDiagnostic(value), fixedError);
  assert.equal(observed, 0);
});

test('writer rejects invalid events or snapshots before allocating any artifact', async t => {
  let allocated = 0;
  t.mock.method(fs, 'mkdtemp', async () => { allocated++; throw new Error(marker); });
  for (const event of ['active', '', marker, null, { toString() { throw new Error(marker); } }])
    await assert.rejects(writeSyntheticWifiDiagnostic(event, valid()), fixedError);
  await assert.rejects(writeSyntheticWifiDiagnostic('cleanup-unconfirmed', { ...valid(), stdout: marker }), fixedError);
  assert.equal(allocated, 0);
});

test('writer opens exclusively, flushes and closes before returning its new path', async t => {
  const calls = [], directory = path.join(os.tmpdir(), 'carebridge-wifi-diagnostic-mocked');
  let captured;
  t.mock.method(fs, 'mkdtemp', async prefix => { calls.push(['mkdtemp', prefix]); return directory; });
  t.mock.method(fs, 'open', async (filename, flags, mode) => {
    calls.push(['open', filename, flags, mode]);
    return { async writeFile(data, encoding) { captured = data; calls.push(['write', encoding]); },
      async sync() { calls.push(['sync']); }, async close() { calls.push(['close']); } };
  });
  const result = await writeSyntheticWifiDiagnostic('cleanup-unconfirmed', valid());
  assert.equal(result, path.join(directory, 'diagnostic.json'));
  assert.deepEqual(calls, [['mkdtemp', path.join(os.tmpdir(), 'carebridge-wifi-diagnostic-')],
    ['open', result, 'wx', 0o600], ['write', 'utf8'], ['sync'], ['close']]);
  assert(captured.length < 4096); assert(Buffer.byteLength(captured) < 4096);
  const record = JSON.parse(captured);
  assert.deepEqual(Object.keys(record), ['event', 'recordedAt', 'snapshot']);
  assert.equal(record.event, 'cleanup-unconfirmed'); assert.equal(new Date(record.recordedAt).toISOString(), record.recordedAt);
  assert.deepEqual(record.snapshot, valid());
});

test('IO failures are redacted, handles close, and partial artifacts are never read, removed or retried', async t => {
  for (const stage of ['mkdtemp', 'open', 'write', 'sync', 'close']) await t.test(stage, async t => {
    const calls = [], directory = path.join(os.tmpdir(), 'carebridge-wifi-diagnostic-mocked');
    const failAt = name => { calls.push(name); if (name === stage) throw Object.assign(new Error(marker), { path: marker, code: marker }); };
    for (const method of ['readFile', 'readdir', 'rm', 'rmdir', 'unlink', 'rename']) t.mock.method(fs, method, async () => {
      calls.push(method); throw new Error(marker);
    });
    t.mock.method(fs, 'mkdtemp', async () => { failAt('mkdtemp'); return directory; });
    t.mock.method(fs, 'open', async () => { failAt('open'); return {
      async writeFile() { failAt('write'); }, async sync() { failAt('sync'); }, async close() { failAt('close'); },
    }; });
    await assert.rejects(writeSyntheticWifiDiagnostic('cleanup-unconfirmed', valid()), fixedError);
    const expected = { mkdtemp: ['mkdtemp'], open: ['mkdtemp', 'open'], write: ['mkdtemp', 'open', 'write', 'close'],
      sync: ['mkdtemp', 'open', 'write', 'sync', 'close'], close: ['mkdtemp', 'open', 'write', 'sync', 'close'] };
    assert.deepEqual(calls, expected[stage]);
  });
});

test('successful writes use separate fresh owned directories and preserve the first artifact', async t => {
  const owned = [];
  t.after(async () => {
    for (const filename of owned) {
      const directory = path.dirname(filename);
      assert.equal(path.basename(filename), 'diagnostic.json');
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.match(path.basename(directory), /^carebridge-wifi-diagnostic-[A-Za-z0-9]+$/);
      const folder = await fs.lstat(directory), file = await fs.lstat(filename);
      assert(folder.isDirectory() && !folder.isSymbolicLink()); assert(file.isFile() && !file.isSymbolicLink());
      assert.deepEqual(await fs.readdir(directory), ['diagnostic.json']);
      await fs.unlink(filename); await fs.rmdir(directory);
    }
  });
  const first = await writeSyntheticWifiDiagnostic('cleanup-unconfirmed', valid()); owned.push(first);
  const original = await fs.readFile(first, 'utf8');
  const secondValue = { ...valid(), cleanup: 'confirmed', observedStage: 'removed' };
  const second = await writeSyntheticWifiDiagnostic('cleanup-confirmed', secondValue); owned.push(second);
  assert.notEqual(path.dirname(first), path.dirname(second)); assert.equal(await fs.readFile(first, 'utf8'), original);
  for (const [filename, event, snapshot] of [[first, 'cleanup-unconfirmed', valid()], [second, 'cleanup-confirmed', secondValue]]) {
    const text = await fs.readFile(filename, 'utf8'), result = JSON.parse(text), info = await fs.lstat(filename);
    assert(text.length < 4096 && Buffer.byteLength(text) < 4096); assert(text.endsWith('\n'));
    assert.deepEqual(Object.keys(result), ['event', 'recordedAt', 'snapshot']);
    assert.equal(result.event, event); assert.deepEqual(result.snapshot, snapshot);
    assert.equal(new Date(result.recordedAt).toISOString(), result.recordedAt);
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  }
});
