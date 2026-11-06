import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { runWindowsNativeApiTestChild } from '../windows-native-api-test-control.mjs';
import { nativeApiControlMessage } from '../windows-native-api-test-policy.mjs';
import { NATIVE_API_RESOURCE_PROTOCOL } from '../windows-native-api-test-resources.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const unavailable = { message: 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' };
function bootstrap() {
  const run = randomUUID();
  return { purpose: 'synthetic-carebridge-native-api', database: {
    storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run }, credentialId: randomUUID(),
    privileges: { roles: { owner: 'cb_owner', runtime: 'cb_runtime', bootstrap: 'cb_bootstrap', backup: 'cb_backup', worker: 'cb_worker' },
      target: { name: 'cb_synthetic', oid: 16384, ownerOid: 16385, confirm: 'cb_synthetic' } },
    endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] } },
  mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media` };
}
class Target extends EventEmitter {
  connected = true; channel = {}; frames = []; exitCode = undefined; sendFailure = false; disconnects = 0;
  send(frame, done) { this.frames.push(frame); queueMicrotask(() => done(this.sendFailure ? new Error('synthetic-private-send') : null)); return false; }
  disconnect() { this.disconnects++; this.connected = false; this.channel = null; this.emit('disconnect'); }
}
function fixture(createService, target = new Target(), readActiveResources) {
  const instanceId = randomUUID();
  const pending = runWindowsNativeApiTestChild({ instanceId, createService, targetProcess: target, readActiveResources });
  pending.catch(() => {});
  return { target, instanceId, pending, start: () => target.emit('message', bootstrap()),
    stop: () => target.emit('message', nativeApiControlMessage(instanceId, 'stop')) };
}
function cleared(target) { assert.equal(target.listenerCount('message'), 0); assert.equal(target.listenerCount('disconnect'), 0); }

// Explicit service/IPC doubles: no DB, E files, HTTP listener or engine runs.
test('API ready follows service creation; repeated stop waits for owned close before reporting stopped', async () => {
  const opening = Promise.withResolvers(), closing = Promise.withResolvers(); let closes = 0, settled = false;
  const f = fixture(() => opening.promise); f.pending.then(() => { settled = true; }, () => { settled = true; }); f.start();
  assert.deepEqual(f.target.frames, []);
  opening.resolve({ origin: 'http://127.0.0.1:4180', close: () => { closes++; return closing.promise; } }); await tick();
  assert.deepEqual(f.target.frames.map((frame) => frame.kind), ['ready']); f.stop(); f.stop(); await tick();
  assert.equal(closes, 1); assert.equal(settled, false); assert.equal(f.target.connected, true);
  assert.deepEqual(f.target.frames.map((frame) => frame.kind), ['ready']);
  closing.resolve(); assert.deepEqual(await f.pending, { stopped: true });
  assert.deepEqual(f.target.frames.map((frame) => frame.kind), ['ready', 'stopped']); assert.equal(f.target.disconnects, 1); cleared(f.target);
});

test('bootstrap screen reaches the fixed service as a captured choice, never as a ready-frame option', async () => {
  for (const screen of [undefined, 'prepared']) {
    let received;
    const f = fixture(async value => { received = value; return { origin: 'http://127.0.0.1:4180', close: async () => {} }; });
    const value = bootstrap(); if (screen !== undefined) value.screen = screen;
    f.target.emit('message', value); value.screen = 'quarantine'; await tick();
    assert.equal(received.screen, screen ?? 'api-only');
    assert.deepEqual(Object.keys(received).sort(), ['database', 'mediaRoot', 'screen']);
    assert.equal(Object.hasOwn(f.target.frames[0], 'screen'), false);
    f.stop(); await f.pending; cleared(f.target);
  }
});

test('invalid screen cannot reach service creation or emit readiness', async () => {
  for (const screen of ['quarantine', 'prepared-delivery', undefined]) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error('must not run'); });
    f.target.emit('message', { ...bootstrap(), screen });
    await assert.rejects(f.pending, unavailable); assert.equal(calls, 0);
    assert.deepEqual(f.target.frames.map(value => value.kind), ['failed']); cleared(f.target);
  }
});
test('stop during startup closes the late service and never announces readiness', async () => {
  const opening = Promise.withResolvers(); let closes = 0;
  const f = fixture(() => opening.promise); f.start(); f.stop(); await tick(); assert.equal(f.target.connected, true);
  opening.resolve({ origin: 'http://127.0.0.1:4180', close: async () => { closes++; } });
  await f.pending; assert.equal(closes, 1); assert.deepEqual(f.target.frames.map((frame) => frame.kind), ['stopped']); cleared(f.target);
});
test('startup channel loss waits for the late owned service to close and fails without a false ready', async () => {
  const opening = Promise.withResolvers(), closing = Promise.withResolvers(); let closes = 0, settled = false;
  const f = fixture(() => opening.promise); f.pending.catch(() => { settled = true; }); f.start(); f.target.disconnect();
  opening.resolve({ origin: 'http://127.0.0.1:4180', close: () => { closes++; return closing.promise; } }); await tick();
  assert.equal(closes, 1); assert.equal(settled, false); assert.deepEqual(f.target.frames, []);
  closing.resolve(); await assert.rejects(f.pending, unavailable); assert.equal(f.target.exitCode, 1); cleared(f.target);
});
test('duplicate bootstrap or attached handles fail closed after draining the actual service', async () => {
  for (const duplicate of [true, false]) {
    let closes = 0;
    const f = fixture(async () => ({ origin: 'http://127.0.0.1:4180', close: async () => { closes++; } })); f.start(); await tick();
    if (duplicate) f.target.emit('message', bootstrap());
    else f.target.emit('message', nativeApiControlMessage(f.instanceId, 'stop'), {});
    await assert.rejects(f.pending, unavailable); assert.equal(closes, 1); assert.equal(f.target.frames.at(-1).kind, 'failed'); cleared(f.target);
  }
});
test('invalid bootstrap is rejected before invoking a service or exposing raw input', async () => {
  let calls = 0; const f = fixture(() => { calls++; throw new Error('must not run'); });
  f.target.emit('message', { purpose: 'synthetic-private-invalid' });
  await assert.rejects(f.pending, unavailable); assert.equal(calls, 0);
  assert.deepEqual(f.target.frames.map((frame) => frame.kind), ['failed']); assert.equal(JSON.stringify(f.target.frames).includes('private'), false); cleared(f.target);
});
test('startup rejection, invalid origin, close error and send error never become successful termination', async () => {
  for (const mode of ['startup', 'origin', 'close', 'send']) {
    let closes = 0; const target = new Target(); target.sendFailure = mode === 'send';
    const f = fixture(async () => {
      if (mode === 'startup') throw new Error('synthetic-private-start');
      return { origin: mode === 'origin' ? 'https://synthetic.invalid' : 'http://127.0.0.1:4180',
        close: async () => { closes++; if (mode === 'close') throw new Error('synthetic-private-close'); } };
    }, target);
    f.start(); await tick(); if (mode === 'close') f.stop();
    await assert.rejects(f.pending, (error) => error.message === unavailable.message && error.cause === undefined);
    assert.equal(closes, mode === 'startup' ? 0 : 1); assert.equal(target.exitCode, 1);
    assert.equal(JSON.stringify(target.frames).includes('private'), false); assert(!target.frames.some((frame) => frame.kind === 'stopped')); cleared(target);
  }
});
test('disconnect after ready drains before failure and preserves a pre-existing failure exit code', async () => {
  const closing = Promise.withResolvers(); let closes = 0;
  const f = fixture(async () => ({ origin: 'http://127.0.0.1:4180', close: () => { closes++; return closing.promise; } })); f.start(); await tick();
  f.target.exitCode = 7; f.target.disconnect(); await tick(); assert.equal(closes, 1);
  closing.resolve(); await assert.rejects(f.pending, unavailable); assert.equal(f.target.exitCode, 7); cleared(f.target);
});
test('controller cannot adopt an existing listener, a disconnected channel or another active lifetime', async () => {
  const createService = async () => ({ origin: 'http://127.0.0.1:4180', close: async () => {} });
  const occupied = new Target(), listener = () => {}; occupied.on('message', listener);
  assert.throws(() => runWindowsNativeApiTestChild({ instanceId: randomUUID(), createService, targetProcess: occupied }), unavailable);
  assert.equal(occupied.listeners('message')[0], listener);
  const disconnected = new Target(); disconnected.disconnect();
  assert.throws(() => runWindowsNativeApiTestChild({ instanceId: randomUUID(), createService, targetProcess: disconnected }), unavailable);
  const f = fixture(createService);
  assert.throws(() => runWindowsNativeApiTestChild({ instanceId: randomUUID(), createService, targetProcess: f.target }), unavailable);
  f.start(); await tick(); f.stop(); await f.pending; cleared(f.target);
});

test('resource samples bracket actual service close, without acknowledging stop before it settles', async () => {
  const closing = Promise.withResolvers(); let samples = 0, closes = 0;
  const f = fixture(async () => ({ origin: 'http://127.0.0.1:4180', close: () => { closes++; return closing.promise; } }),
    new Target(), () => ++samples === 1 ? ['Timeout', 'TCPSocketWrap'] : ['Timeout']);
  f.start(); await tick(); f.stop(); f.stop(); await tick();
  assert.equal(samples, 1); assert.equal(closes, 1);
  assert.deepEqual(f.target.frames.map(value => value.phase ?? value.kind), ['ready', 'before-service-close']);
  assert.equal(f.target.connected, true);
  closing.resolve(); await f.pending;
  assert.equal(samples, 2);
  assert.deepEqual(f.target.frames.map(value => value.phase ?? value.kind),
    ['ready', 'before-service-close', 'after-service-close', 'stopped']);
  assert.deepEqual(f.target.frames[2].counts, [{ type: 'Timeout', count: 1 }]); cleared(f.target);
});

test('after-service-close is a finally observation, not successful close or terminal evidence', async () => {
  let samples = 0;
  const f = fixture(async () => ({ origin: 'http://127.0.0.1:4180', close: async () => { throw new Error('PRIVATE_CLOSE'); } }),
    new Target(), () => { samples++; return []; });
  f.start(); await tick(); f.stop(); await assert.rejects(f.pending, unavailable);
  assert.equal(samples, 2);
  assert.deepEqual(f.target.frames.map(value => value.phase ?? value.kind),
    ['ready', 'before-service-close', 'after-service-close', 'failed']);
  assert.equal(f.target.exitCode, 1); assert(!JSON.stringify(f.target.frames).includes('PRIVATE')); cleared(f.target);
});

test('resource reader and diagnostic transport errors cannot abandon close or change its successful result', async () => {
  for (const mode of ['reader', 'send-throw', 'send-callback-error', 'send-no-callback']) {
    let closes = 0, samples = 0;
    const target = new Target(), baseSend = target.send.bind(target);
    target.send = (value, done) => {
      if (value.protocol === NATIVE_API_RESOURCE_PROTOCOL) {
        target.frames.push(value);
        if (mode === 'send-throw') throw new Error('PRIVATE');
        if (mode === 'send-callback-error') { done(new Error('PRIVATE')); return false; }
        if (mode === 'send-no-callback') return false;
        done(null); return false;
      }
      return baseSend(value, done);
    };
    const f = fixture(async () => ({ origin: 'http://127.0.0.1:4180', close: async () => { closes++; } }), target,
      () => { samples++; if (mode === 'reader') throw new Error('PRIVATE'); return ['PRIVATE_RESOURCE']; });
    f.start(); await tick(); f.stop(); assert.deepEqual(await f.pending, { stopped: true });
    assert.equal(closes, 1); assert.equal(samples, 2); assert.equal(target.frames.at(-1).kind, 'stopped');
    assert(!JSON.stringify(target.frames).includes('PRIVATE')); cleared(target);
  }
});

test('late startup still drains with two samples; startup failure before service allocation has none', async () => {
  const opening = Promise.withResolvers(); let calls = 0;
  const f = fixture(() => opening.promise, new Target(), () => { calls++; return []; });
  f.start(); f.stop();
  opening.resolve({ origin: 'http://127.0.0.1:4180', close: async () => {} }); await f.pending;
  assert.equal(calls, 2);
  assert.deepEqual(f.target.frames.map(value => value.phase ?? value.kind), ['before-service-close', 'after-service-close', 'stopped']);
  const bad = fixture(async () => { throw new Error('PRIVATE'); }, new Target(), () => { calls++; return []; });
  bad.start(); await assert.rejects(bad.pending, unavailable); assert.equal(calls, 2);
  assert.deepEqual(bad.target.frames.map(value => value.kind), ['failed']); cleared(f.target); cleared(bad.target);
});
