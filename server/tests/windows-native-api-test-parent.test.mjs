import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { observeWindowsNativeApiTestChild, launchWindowsNativeApiTest } from '../windows-native-api-test-parent.mjs';
import { nativeApiControlMessage } from '../windows-native-api-test-policy.mjs';
import { nativeApiResourceMessage } from '../windows-native-api-test-resources.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const unavailable = { message: 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' };
function frame(f, kind, origin) { f.child.emit('message', nativeApiControlMessage(f.instanceId, kind, origin)); }
function resources(f, phase, counts = []) {
  f.child.emit('message', nativeApiResourceMessage(f.instanceId, phase, { available: true, truncated: false, counts }));
}
function fixture({ pid = 12345, observationMilliseconds = 30000 } = {}) {
  // Explicit process-event double only; never represents real OS termination.
  const child = new ChildProcess(), instanceId = randomUUID(), sent = [];
  child.pid = pid; child.connected = true; child.channel = {};
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, null];
  child.send = (value, done) => { sent.push(value); queueMicrotask(() => done(null)); return false; };
  const control = observeWindowsNativeApiTestChild(child, { instanceId, observationMilliseconds });
  return { child, instanceId, sent, control };
}
function disconnect(f) { f.child.connected = false; f.child.channel = null; f.child.emit('disconnect'); }
async function pipes(f) { f.child.stdout.destroy(); f.child.stderr.destroy(); await tick(); }
async function terminal(f, code = 0) {
  if (f.child.connected) disconnect(f);
  f.child.exitCode = code; f.child.emit('exit', code, null); await pipes(f); f.child.emit('close', code, null); await tick();
}
function clean(f) {
  for (const name of ['spawn', 'message', 'error', 'disconnect', 'exit', 'close']) assert.equal(f.child.listenerCount(name), 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0); assert.equal(f.child.stderr.listenerCount('data'), 0);
}

test('parent requires stopped, real exit, actual close and all pipes closed before successful completion', async () => {
  const f = fixture(); frame(f, 'ready', 'http://127.0.0.1:4180'); assert.equal(await f.control.ready, 'http://127.0.0.1:4180');
  let settled = false; const closing = f.control.close(); closing.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(f.control.close(), closing); frame(f, 'stopped'); disconnect(f); await tick(); assert.equal(settled, false);
  f.child.emit('exit', 0, null); f.child.emit('close', 0, null); await tick(); assert.equal(settled, false);
  assert.equal(f.control.status().terminal, false); await pipes(f);
  assert.deepEqual(await closing, { exited: true, exitCode: 0, stopped: true });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'stop'); assert.equal(f.control.status().terminal, true); clean(f);
});
test('late ready after observation timeout cannot leave readiness pending after terminal failure', async () => {
  const f = fixture({ observationMilliseconds: 5 }); let settled = false;
  f.control.waitForExit().catch(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.control.status().observationTimedOut, true); assert.equal(f.control.status().terminal, false); assert.equal(settled, false);
  frame(f, 'ready', 'http://127.0.0.1:4180'); frame(f, 'stopped'); await terminal(f);
  await assert.rejects(f.control.ready, unavailable); await assert.rejects(f.control.waitForExit(), unavailable); clean(f);
});

test('deadline failure retains only late close observation without upgrading its terminal result', async () => {
  const f = fixture({ observationMilliseconds: 5 });
  frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready;
  const closing = f.control.close(); frame(f, 'stopped'); disconnect(f); f.child.emit('exit', 0, null); await pipes(f);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(closing, unavailable);
  const before = f.control.status();
  assert.equal(before.terminal, true); assert.equal(before.closeObserved, false); assert.equal(before.stdioClosed, true);
  assert.equal(before.observationTimedOut, true); assert.equal(before.failureCode, unavailable.message);
  assert.equal(f.child.listenerCount('close'), 1);
  for (const name of ['spawn', 'message', 'error', 'disconnect', 'exit']) assert.equal(f.child.listenerCount(name), 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0); assert.equal(f.child.stderr.listenerCount('data'), 0);
  f.child.emit('close', 0, null); await tick();
  const after = f.control.status();
  assert.equal(after.closeObserved, true); assert.equal(after.observationTimedOut, true);
  assert.equal(after.failureCode, unavailable.message); assert.equal(after.terminal, true);
  assert.equal(f.control.waitForExit(), closing); await assert.rejects(f.control.close(), unavailable);
  assert.equal(before.closeObserved, false); clean(f);
  assert.equal(before.eventTimeline.some(value => value.event === 'child-close'), false);
  assert.equal(after.eventTimeline.at(-1).event, 'child-close');
  const events = after.eventTimeline.map(value => value.event);
  for (const name of ['ipc-ready', 'ipc-stopped', 'stop-requested', 'disconnect', 'exit', 'stdout-close', 'stderr-close', 'stdio-close', 'deadline', 'failure', 'child-close'])
    assert.equal(events.filter(value => value === name).length, 1);
  assert(events.indexOf('deadline') < events.indexOf('child-close')); assert.equal(f.sent.length, 1);
  f.child.emit('close', 9, 'synthetic-late-duplicate');
  assert.deepEqual(f.control.status(), after); clean(f);
});

test('event timeline is a frozen bounded first-occurrence snapshot with no private payloads', async () => {
  const f = fixture(), initial = f.control.status();
  assert.deepEqual(initial.eventTimeline, []);
  for (let i = 0; i < 200; i++) {
    f.child.emit('spawn');
    f.child.emit('message', { private: 'PRIVATE_ACCOUNT_PASSWORD_PATH' });
    f.child.emit('error', new Error('PRIVATE_ACCOUNT_PASSWORD_PATH'));
    f.child.stdout.write('PRIVATE_ACCOUNT_PASSWORD_PATH');
  }
  frame(f, 'ready', 'http://127.0.0.1:4180');
  frame(f, 'stopped'); await terminal(f);
  await assert.rejects(f.control.ready, unavailable); await assert.rejects(f.control.waitForExit(), unavailable);
  const timeline = f.control.status().eventTimeline;
  const allowed = new Set(['spawn', 'ipc-ready', 'ipc-stopped', 'stop-requested', 'disconnect', 'exit', 'child-close',
    'stdout-close', 'stderr-close', 'stdio-close', 'deadline', 'failure', 'child-error']);
  assert(timeline.length > 0); assert(timeline.length <= allowed.size);
  assert.equal(new Set(timeline.map(value => value.event)).size, timeline.length);
  for (const [index, value] of timeline.entries()) {
    assert.deepEqual(Object.keys(value).sort(), ['elapsedMs', 'event']); assert(allowed.has(value.event));
    assert(Number.isSafeInteger(value.elapsedMs)); assert(value.elapsedMs >= 0);
    if (index) assert(value.elapsedMs >= timeline[index - 1].elapsedMs);
    assert(Object.isFrozen(value)); assert.throws(() => { value.event = 'forbidden mutation'; }, TypeError);
  }
  assert(Object.isFrozen(timeline)); assert.throws(() => timeline.push({}), TypeError);
  assert.deepEqual(initial.eventTimeline, []);
  assert(!JSON.stringify(timeline).includes('PRIVATE')); assert(!JSON.stringify(timeline).includes('http'));
  assert.equal(f.sent.length, 1); clean(f);
});

test('successful close captures observation order without treating timeline entries as terminal proof', async () => {
  const f = fixture(); f.child.emit('spawn'); frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready;
  const closing = f.control.close(); frame(f, 'stopped'); disconnect(f); f.child.emit('exit', 0, null);
  f.child.emit('close', 0, null);
  const incomplete = f.control.status();
  assert.equal(incomplete.closeObserved, true); assert.equal(incomplete.stdioClosed, false); assert.equal(incomplete.terminal, false);
  assert.equal(incomplete.eventTimeline.at(-1).event, 'child-close');
  await pipes(f); await closing;
  const result = f.control.status(), events = result.eventTimeline.map(value => value.event);
  assert.equal(result.terminal, true); assert.equal(result.failureCode, null); assert.equal(result.observationTimedOut, false);
  assert.deepEqual(events.slice(0, 7), ['spawn', 'ipc-ready', 'stop-requested', 'ipc-stopped', 'disconnect', 'exit', 'child-close']);
  assert(events.includes('stdio-close')); assert(events.includes('stdout-close')); assert(events.includes('stderr-close'));
  assert(!events.includes('deadline')); assert(!events.includes('failure'));
  assert.equal(incomplete.eventTimeline.some(value => value.event === 'stdio-close'), false); clean(f);
});

test('resource count snapshots are fixed and frozen but never substitute for stopped or actual terminal evidence', async () => {
  const f = fixture(), initial = f.control.status(); frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready;
  const closing = f.control.close();
  resources(f, 'before-service-close', [{ type: 'Timeout', count: 2 }]);
  const before = f.control.status(); resources(f, 'after-service-close');
  let settled = false; closing.then(() => { settled = true; }, () => { settled = true; }); await tick();
  assert.equal(settled, false); assert.equal(f.control.status().stopped, false); assert.equal(f.control.status().terminal, false);
  frame(f, 'stopped'); disconnect(f); await tick(); assert.equal(settled, false);
  await terminal(f); await closing;
  const observations = f.control.status().resourceObservations;
  assert.equal(initial.resourceObservations.length, 0); assert.equal(before.resourceObservations.length, 1);
  assert.equal(observations.length, 2); assert(observations[1].elapsedMs >= observations[0].elapsedMs);
  assert(Object.isFrozen(observations));
  for (const value of observations) {
    assert.deepEqual(Object.keys(value).sort(), ['available', 'counts', 'elapsedMs', 'phase', 'truncated']);
    assert(Object.isFrozen(value)); assert(Object.isFrozen(value.counts)); assert(Number.isSafeInteger(value.elapsedMs));
  }
  assert.throws(() => { observations[0].counts[0].count = 99; }, TypeError);
  assert(!JSON.stringify(observations).includes(f.instanceId)); assert.equal(f.control.status().failureCode, null); clean(f);
});

test('resource samples cannot extend or clear the existing observation deadline', async () => {
  const f = fixture({ observationMilliseconds: 5 }); frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready;
  const closing = f.control.close(); resources(f, 'before-service-close'); resources(f, 'after-service-close');
  frame(f, 'stopped'); disconnect(f); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.control.status().observationTimedOut, true); assert.equal(f.control.status().terminal, false);
  await terminal(f); await assert.rejects(closing, unavailable);
  assert.equal(f.control.status().resourceObservations.length, 2); assert.equal(f.control.status().exitCode, 0); clean(f);
});

test('malformed, duplicate, out-of-order or attached resource observations fail closed without retaining payloads', async () => {
  for (const mode of ['extra', 'wrong-instance', 'attached', 'duplicate', 'order', 'after-stopped', 'unbounded']) {
    const f = fixture(); frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready; f.control.close();
    const first = nativeApiResourceMessage(f.instanceId, 'before-service-close', { available: true, truncated: false, counts: [] });
    if (mode === 'duplicate') { f.child.emit('message', first); f.child.emit('message', first); }
    else if (mode === 'order') resources(f, 'after-service-close');
    else if (mode === 'after-stopped') { frame(f, 'stopped'); f.child.emit('message', first); }
    else if (mode === 'extra') f.child.emit('message', { ...first, path: 'PRIVATE' });
    else if (mode === 'wrong-instance') f.child.emit('message', { ...first, instanceId: randomUUID() });
    else if (mode === 'attached') f.child.emit('message', first, {});
    else f.child.emit('message', { ...first, counts: [{ type: 'Timeout', count: 4097 }] });
    if (mode !== 'after-stopped') frame(f, 'stopped');
    await terminal(f); await assert.rejects(f.control.waitForExit(), unavailable);
    assert(f.control.status().resourceObservations.length <= 1); assert(!JSON.stringify(f.control.status()).includes('PRIVATE')); clean(f);
  }
});
test('cooperative stop before late ready terminates but never admits the stale readiness promise', async () => {
  const f = fixture(); const closing = f.control.close(); frame(f, 'ready', 'http://127.0.0.1:4180'); frame(f, 'stopped'); await terminal(f);
  await closing; await assert.rejects(f.control.ready, unavailable); clean(f);
});
test('spawn error without PID requires close and pipes before failing terminal, without inventing an exit', async () => {
  const f = fixture(); f.child.pid = undefined; f.child.emit('error', new Error('synthetic spawn diagnostic'));
  await pipes(f); assert.equal(f.control.status().terminal, false);
  f.child.emit('close', -2, null); await assert.rejects(f.control.waitForExit(), unavailable); await assert.rejects(f.control.ready, unavailable);
  assert.equal(f.control.status().spawnFailed, true); assert.equal(f.control.status().exitCode, null); clean(f);
});
test('error and close with assigned PID do not substitute for an actual exit event', async () => {
  const f = fixture(); f.child.emit('error', new Error('synthetic runtime diagnostic')); f.child.emit('close', -2, null); await pipes(f);
  assert.equal(f.control.status().spawnFailed, false); assert.equal(f.control.status().terminal, false);
  f.child.emit('exit', 1, null); await assert.rejects(f.control.waitForExit(), unavailable); clean(f);
});
test('unknown frames, attached handles, stdout and fixed stderr remain bounded failures with no raw diagnostics', async () => {
  for (const kind of ['frame', 'handle', 'stdout', 'stderr', 'large']) {
    const f = fixture();
    if (kind === 'frame') f.child.emit('message', { private: 'synthetic secret' });
    else if (kind === 'handle') f.child.emit('message', nativeApiControlMessage(f.instanceId, 'ready', 'http://127.0.0.1:4180'), {});
    else if (kind === 'stdout') f.child.stdout.write('synthetic secret');
    else f.child.stderr.write(kind === 'large' ? 'x'.repeat(2048) : 'NATIVE_API_FAILED\n');
    frame(f, 'stopped'); await terminal(f);
    await assert.rejects(f.control.waitForExit(), (error) => error.message === unavailable.message && error.cause === undefined);
    assert.equal(JSON.stringify(f.control.status()).includes('secret'), false); assert.equal(f.sent.length, 1); clean(f);
  }
});
test('nonzero exit or missing close never reports successful stop', async () => {
  for (const mode of ['nonzero', 'missing-close']) {
    const f = fixture(); frame(f, 'ready', 'http://127.0.0.1:4180'); await f.control.ready; f.control.close(); frame(f, 'stopped');
    if (mode === 'nonzero') await terminal(f, 7);
    else { f.control.fail(); disconnect(f); f.child.emit('exit', 0, null); await pipes(f); }
    await assert.rejects(f.control.waitForExit(), unavailable); assert.equal(f.control.status().terminal, true);
    if (mode === 'missing-close') {
      assert.equal(f.control.status().closeObserved, false); assert.equal(f.child.listenerCount('close'), 1);
      f.child.emit('close', 0, null); assert.equal(f.control.status().closeObserved, true);
      await assert.rejects(f.control.waitForExit(), unavailable);
    }
    clean(f);
  }
});
test('launcher rejects extra input before it can spawn or adopt an existing process', async () => {
  await assert.rejects(launchWindowsNativeApiTest({ database: {}, mediaRoot: 'synthetic', environment: {}, command: 'forbidden' }), unavailable);
  const f = fixture(); assert.throws(() => observeWindowsNativeApiTestChild(f.child, { instanceId: f.instanceId }), unavailable);
  f.control.close(); frame(f, 'stopped'); await terminal(f); await f.control.waitForExit(); clean(f);
});

test('launcher rejects unsupported or accessor screen before spawning', async () => {
  const { purpose, ...value } = bootstrap();
  for (const screen of [undefined, null, 'quarantine', 'prepared-delivery', true, {}])
    await assert.rejects(launchWindowsNativeApiTest({ ...value, environment: {}, screen }), unavailable);
  let getters = 0;
  const accessor = Object.defineProperty({ ...value, environment: {} }, 'screen', { get() { getters++; return 'prepared'; } });
  await assert.rejects(launchWindowsNativeApiTest(accessor), unavailable); assert.equal(getters, 0);
});

function bootstrap() {
  const run = randomUUID();
  return { purpose: 'synthetic-carebridge-native-api', database: {
    storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run }, credentialId: randomUUID(),
    privileges: { roles: { owner: 'cb_owner', runtime: 'cb_runtime', bootstrap: 'cb_bootstrap', backup: 'cb_backup', worker: 'cb_worker' },
      target: { name: 'cb_synthetic', oid: 16384, ownerOid: 16385, confirm: 'cb_synthetic' } },
    endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] } },
  mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media` };
}

// Actual inherited IPC / actual Node child lifetime, but EXPLICIT service
// double. These tests do not open HTTP/DB, read E, inspect media or load the
// Windows service factory. The returned origin is synthetic, not a listener.
for (const mode of ['ready-stop', 'late-start', 'invalid-bootstrap']) test(`actual inherited IPC ${mode} observes child exit and stdio terminal evidence`, async () => {
  const instanceId = randomUUID(), controller = new URL('../windows-native-api-test-control.mjs', import.meta.url).href;
  const code = `import {runWindowsNativeApiTestChild} from ${JSON.stringify(controller)};
    let closes = 0;
    try { await runWindowsNativeApiTestChild({instanceId:process.argv[1],readActiveResources:()=>process.getActiveResourcesInfo(),createService:async()=>{
      ${mode === 'late-start' ? 'await new Promise(resolve=>setTimeout(resolve,30));' : ''}
      return {origin:'http://127.0.0.1:4180',close:async()=>{if(++closes!==1)throw Error('double close');}};
    }}); if(closes!==1)process.exitCode=1; } catch { process.exitCode=1; }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, instanceId], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), env: {}, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
  });
  const control = observeWindowsNativeApiTestChild(child, { instanceId });
  try {
    await new Promise((yes, no) => child.send(mode === 'invalid-bootstrap' ? { purpose: 'invalid synthetic fixture' } : bootstrap(), (error) => error ? no(error) : yes()));
    if (mode === 'ready-stop') { assert.equal(await control.ready, 'http://127.0.0.1:4180'); await control.close(); }
    else if (mode === 'late-start') { await control.close(); await assert.rejects(control.ready, unavailable); }
    else { await assert.rejects(control.ready, unavailable); await assert.rejects(control.waitForExit(), unavailable); }
    assert.equal(control.status().terminal, true); assert.equal(control.status().stdioClosed, true);
    // Failed startup may settle on exit + disconnect + every closed pipe
    // before Node's later close callback. It is still rejected, never success.
    if (mode !== 'invalid-bootstrap') assert.equal(control.status().closeObserved, true);
    else assert.equal(control.status().failureCode, unavailable.message);
    assert.equal(control.status().exitCode, mode === 'invalid-bootstrap' ? 1 : 0);
    assert.equal(control.status().resourceObservations.length, mode === 'invalid-bootstrap' ? 0 : 2);
    if (mode !== 'invalid-bootstrap') assert(control.status().resourceObservations.every(value => value.available));
  } finally { try { await control.close(); } catch { /* asserted terminal failure is intentionally retained */ } }
});
test('actual spawn ENOENT observes failure close without waiting for a nonexistent exit event', async () => {
  const child = spawn(fileURLToPath(new URL(`./never-exists-${randomUUID()}.exe`, import.meta.url)), [], {
    env: {}, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const control = observeWindowsNativeApiTestChild(child, { instanceId: randomUUID() });
  try {
    await assert.rejects(control.ready, unavailable); await assert.rejects(control.waitForExit(), unavailable);
    assert.equal(control.status().spawnFailed, true); assert.equal(control.status().terminal, true); assert.equal(control.status().closeObserved, true);
    assert.equal(control.status().stdioClosed, true); assert.equal(control.status().exitCode, null);
  } finally { try { await control.close(); } catch { /* no process was created */ } }
});
