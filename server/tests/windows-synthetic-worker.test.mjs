// Pure configuration/protocol/process-event doubles. No child process, E
// filesystem, database, Docker daemon, scanner or native decoder is started.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { SYNTHETIC_WORKER_PURPOSE, windowsSyntheticWorkerBootstrap, syntheticWorkerAdmissionFrame,
  syntheticWorkerAdmissionReporter, syntheticWorkerAdmissionParser, syntheticWorkerStageObserver } from '../windows-synthetic-worker-policy.mjs';
import { nativeWorkerStageReporter, nativeDatabaseStageReporter } from '../windows-native-worker-test-policy.mjs';
import { WINDOWS_DATABASE_STAGES } from '../windows-database-observation.mjs';
import { observeWindowsSyntheticWorkerChild, launchWindowsSyntheticWorker } from '../windows-synthetic-worker-parent.mjs';
import { mediaWorkerControlMessage } from '../media-worker-control-protocol.mjs';
import { observeMediaStage } from '../media-worker-observation.mjs';

const denied = { message: 'WINDOWS_SYNTHETIC_WORKER_UNAVAILABLE' };
const tick = () => new Promise(yes => setImmediate(yes));
function bootstrap() {
  const run = randomUUID();
  return { purpose: SYNTHETIC_WORKER_PURPOSE,
    database: { storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run }, credentialId: randomUUID(),
      privileges: { roles: { owner: 'cb_owner', runtime: 'cb_runtime', bootstrap: 'cb_bootstrap', backup: 'cb_backup', worker: 'cb_worker' },
        target: { name: 'cb_synthetic', oid: 16384, ownerOid: 16385, confirm: 'cb_synthetic' } },
      endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] } },
    mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media`,
    nativeMedia: { engineIdentity: 'synthetic-worker-engine', approvedImageId: 'sha256:' + 'a'.repeat(64), scannerEndpoint: { host: '127.0.0.1', port: 54322 } } };
}
function rawChild() {
  const child = new ChildProcess(), sent = [];
  Object.assign(child, { connected: true, channel: {}, pid: 12345, exitCode: null, signalCode: null });
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, null];
  child.send = (value, done) => { sent.push(value); queueMicrotask(() => done(null)); return false; };
  return { child, sent };
}
function fixture(milliseconds = 30000) {
  const f = { ...rawChild(), instanceId: randomUUID() };
  f.control = observeWindowsSyntheticWorkerChild(f.child, { instanceId: f.instanceId, observationMilliseconds: milliseconds });
  return f;
}
const frame = (f, kind, requestId = null) => f.child.emit('message', mediaWorkerControlMessage(f.instanceId, kind, requestId));
const admission = f => f.child.stdout.write(syntheticWorkerAdmissionFrame(f.instanceId));
async function finish(f, { code = 0, close = true, exit = true } = {}) {
  f.child.connected = false; f.child.channel = null; f.child.emit('disconnect');
  if (exit) { f.child.exitCode = code; f.child.emit('exit', code, null); }
  f.child.stdout.destroy(); f.child.stderr.destroy(); await tick();
  if (close) f.child.emit('close', code, null);
  await tick();
}
async function drain(f) {
  frame(f, 'control-ready');
  const request = f.sent.find(value => value.kind === 'stop')?.requestId;
  assert.ok(request); frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f);
}
function clean(f) {
  for (const name of ['spawn', 'message', 'error', 'disconnect', 'exit', 'close']) assert.equal(f.child.listenerCount(name), 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0); assert.equal(f.child.stderr.listenerCount('data'), 0);
  assert.equal(f.child.stderr.listenerCount('end'), 0);
}

test('synthetic stage diagnostics accept fragmented fixed frames and keep bounded immutable history only', () => {
  const observer = syntheticWorkerStageObserver();
  const write = frame => { for (const byte of Buffer.from(frame)) observer.feed(Uint8Array.of(byte)); };
  const stage = nativeWorkerStageReporter(write), database = nativeDatabaseStageReporter(write);
  database({ stage: WINDOWS_DATABASE_STAGES[0], edge: 'begin', elapsedMs: 0 });
  for (let i = 0; i < 5000; i++) stage({ stage: 'queue-claim', edge: 'begin' });
  stage({ stage: 'source-scan', edge: 'begin' }); stage({ stage: 'source-scan', edge: 'failed' });
  stage({ stage: 'db-close', edge: 'complete' }); observer.end();
  const value = observer.snapshot();
  assert.equal(value.stageEventCount, 131); assert.equal(value.stageHistory.length, 32);
  assert.equal(value.stageLimits.polling, true); assert.equal(value.databaseEventCount, 1);
  assert.deepEqual(value.stageCounts.find(item => item.stage === 'source-scan'), { stage: 'source-scan', begin: 1, complete: 0, failed: 1 });
  assert.equal(value.lastStage.stage, 'db-close'); assert.equal(value.invalidOutput, false);
  assert.ok(Object.isFrozen(value.stageHistory) && Object.isFrozen(value.stageCounts[0]));
  assert.throws(() => observer.feed(Buffer.from('NS1:01:B\n')), denied);
});

test('synthetic stderr preserves fail-closed behavior for unknown, malformed, oversized and partial frames', () => {
  for (const bytes of [Buffer.from('PRIVATE PATH TOKEN\n'), Buffer.from('NATIVE_PHASE_1\n'),
    Buffer.from('NS1:00:B\n'), Buffer.from('NS1:99:C\n'), Buffer.from('NS1:01:X\n'),
    Buffer.from('ND1:00:B:1\n'), Buffer.from('ND1:01:B:01\n'), Buffer.from('NL1:X\n'),
    Buffer.alloc(33, 65), Buffer.alloc(16385), Buffer.from([0]), 'text']) {
    const observer = syntheticWorkerStageObserver();
    assert.throws(() => observer.feed(bytes), denied);
    assert.equal(observer.snapshot().invalidOutput, true);
    assert.equal(JSON.stringify(observer.snapshot()).includes('PRIVATE'), false);
    assert.throws(() => observer.end(), denied);
  }
  const observer = syntheticWorkerStageObserver(); observer.feed(Buffer.from('NS1:01:B'));
  assert.equal(observer.snapshot().stageEventCount, 0); assert.throws(() => observer.end(), denied);
});

test('stage completion cannot admit startup or prove stop; evidence survives the actual owned lifetime', async () => {
  const f = fixture(); let ready = false;
  f.control.ready.then(() => { ready = true; }); frame(f, 'control-ready');
  f.child.stderr.write('NS1:02:C\n'); await tick(); assert.equal(ready, false);
  admission(f); await f.control.ready;
  f.child.stderr.write('NS1:07:B\nNS1:07:C\n');
  const closing = f.control.close(), request = f.sent[0].requestId;
  f.child.stderr.write('NS1:15:C\n');
  assert.equal(f.control.status().terminal, false);
  frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f); await closing;
  assert.equal(f.control.status().diagnostics.stageEventCount, 4);
  assert.equal(f.control.status().diagnostics.lastStage.stage, 'db-close'); clean(f);
});

test('partial stderr at actual close fails even after a normal stop and zero exit', async () => {
  const f = fixture(); frame(f, 'control-ready'); admission(f); await f.control.ready;
  const closing = f.control.close(), request = f.sent[0].requestId;
  f.child.stderr.write('NS1:15:C'); frame(f, 'stop-accepted', request); frame(f, 'drained', request);
  await finish(f); await assert.rejects(closing, denied);
  assert.equal(f.control.status().terminal, true); assert.equal(f.control.status().diagnostics.invalidOutput, true); clean(f);
});

test('synthetic bootstrap snapshots only the fixed purpose, worker role, TLS and exact fresh E root', () => {
  const original = bootstrap(), value = windowsSyntheticWorkerBootstrap(original);
  original.database.privileges.roles.worker = 'changed'; original.nativeMedia.scannerEndpoint.port = 1;
  assert.equal(value.database.privileges.roles.worker, 'cb_worker'); assert.equal(value.nativeMedia.scannerEndpoint.port, 54322);
  assert.equal(Object.hasOwn(value, 'mode'), false); assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.database.privileges.roles));
  assert.equal(JSON.stringify(value).includes('password'), false);
});

test('bootstrap refuses legacy purpose, gate selection, arbitrary roots/hosts and accessors before reading them', () => {
  for (const change of [v => { v.purpose = 'synthetic-carebridge-native-worker'; }, v => { v.mode = 'hold-input'; },
    v => { v.mediaRoot = 'E:\\Existing'; }, v => { delete v.database.storage.syntheticRunId; },
    v => { v.nativeMedia.scannerEndpoint.host = 'localhost'; }, v => { v.nativeMedia.approvedImageId = 'latest'; },
    v => { v.database.kind = 'owner'; }, v => { v.database.password = 'synthetic'; },
    v => { delete v.database.endpoint.ca; }]) {
    const value = bootstrap(); change(value); assert.throws(() => windowsSyntheticWorkerBootstrap(value), denied);
  }
  let reads = 0;
  const value = bootstrap(); Object.defineProperty(value.nativeMedia, 'engineIdentity', { get() { reads++; return 'synthetic-worker-engine'; } });
  assert.throws(() => windowsSyntheticWorkerBootstrap(value), denied); assert.equal(reads, 0);
  const cycle = bootstrap(); cycle.database.self = cycle; assert.throws(() => windowsSyntheticWorkerBootstrap(cycle), denied);
});

test('admission reporter emits once only after actual work completion, without payload or failures', async () => {
  const id = randomUUID(), frames = [], reporter = syntheticWorkerAdmissionReporter(id, text => frames.push(text));
  for (const event of [{ stage: 'db-open', edge: 'complete' }, { stage: 'worker-admission', edge: 'begin' },
    { stage: 'worker-admission', edge: 'failed' }, { stage: 'worker-admission', edge: 'complete', secret: 'private' }]) reporter(event);
  const gate = Promise.withResolvers();
  const work = observeMediaStage(reporter, 'worker-admission', () => gate.promise); await tick(); assert.deepEqual(frames, []);
  gate.resolve('private-result'); assert.equal(await work, 'private-result'); reporter({ stage: 'worker-admission', edge: 'complete' });
  assert.deepEqual(frames, [syntheticWorkerAdmissionFrame(id)]); assert.equal(frames[0].includes('private'), false);
  let failures = 0;
  await assert.rejects(observeMediaStage(syntheticWorkerAdmissionReporter(id, () => failures++), 'worker-admission', () => { throw Error('private'); }));
  assert.equal(failures, 0);
});

test('bounded admission parser requires every exact byte and newline, rejects duplicate/wrong-run/oversized frames', () => {
  const id = randomUUID(), bytes = Buffer.from(syntheticWorkerAdmissionFrame(id)), parser = syntheticWorkerAdmissionParser(id);
  for (const byte of bytes.subarray(0, -1)) assert.equal(parser.feed(Uint8Array.of(byte)), false);
  assert.equal(parser.complete, false); assert.equal(parser.feed(bytes.subarray(-1)), true); parser.end();
  assert.throws(() => parser.feed(bytes), denied); assert.equal(parser.complete, false);
  for (const bytes of [Buffer.from(syntheticWorkerAdmissionFrame(randomUUID())), Buffer.alloc(1024), 'text'])
    assert.throws(() => syntheticWorkerAdmissionParser(id).feed(bytes), denied);
  const partial = syntheticWorkerAdmissionParser(id); partial.feed(Buffer.from('SWA1:')); assert.throws(() => partial.end(), denied);
});

test('control readiness alone never admits startup; fragmented admission waits for its newline', async () => {
  const f = fixture(); let ready = false; f.control.ready.then(() => { ready = true; });
  frame(f, 'control-ready'); await tick(); assert.equal(ready, false);
  const bytes = Buffer.from(syntheticWorkerAdmissionFrame(f.instanceId)); f.child.stdout.write(bytes.subarray(0, -1)); await tick(); assert.equal(ready, false);
  f.child.stdout.write(bytes.subarray(-1)); await f.control.ready; assert.equal(f.control.status().admissionObserved, true);
  const closing = f.control.close(), request = f.sent[0].requestId;
  frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f);
  assert.deepEqual(await closing, { exited: true, exitCode: 0, drained: true }); clean(f);
});

test('independent stdout/IPC scheduling permits admission before control-ready but waits for both', async () => {
  const f = fixture(); admission(f); let ready = false; f.control.ready.then(() => { ready = true; }); await tick(); assert.equal(ready, false);
  frame(f, 'control-ready'); await f.control.ready; const closing = f.control.close(), request = f.sent[0].requestId;
  frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f); await closing; clean(f);
});

test('startup cancellation refuses late admission but awaits zero-exit drain and all captured pipes', async () => {
  const f = fixture(), closing = f.control.close(); assert.equal(f.control.close(), closing);
  await assert.rejects(f.control.ready, denied); admission(f); frame(f, 'control-ready');
  const request = f.sent[0].requestId; frame(f, 'stop-accepted', request); frame(f, 'drained', request);
  f.child.connected = false; f.child.channel = null; f.child.emit('disconnect'); f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
  await tick(); assert.equal(f.control.status().terminal, false); assert.equal(f.control.status().ready, false);
  f.child.stdout.destroy(); f.child.stderr.destroy(); await closing; assert.equal(f.control.status().terminal, true); clean(f);
});

test('duplicate admission, wrong-run frame, stderr and partial EOF fail without leaking raw diagnostics', async () => {
  for (const mode of ['duplicate', 'wrong', 'stderr', 'partial']) {
    const f = fixture(); frame(f, 'control-ready');
    if (mode === 'duplicate') { admission(f); await f.control.ready; admission(f); }
    else if (mode === 'wrong') f.child.stdout.write(syntheticWorkerAdmissionFrame(randomUUID()));
    else if (mode === 'stderr') f.child.stderr.write('PRIVATE PATH PASSWORD');
    else f.child.stdout.end('SWA1:');
    await tick(); const request = f.sent[0].requestId; frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f);
    await assert.rejects(f.control.waitForExit(), denied); assert.equal(JSON.stringify(f.control.status()).includes('PRIVATE'), false); clean(f);
  }
});

test('admission deadline rejects readiness but keeps the same child observed until actual terminal evidence', async () => {
  const f = fixture(5); await new Promise(yes => setTimeout(yes, 20));
  await assert.rejects(f.control.ready, denied); assert.equal(f.control.status().observationTimedOut, true); assert.equal(f.control.status().terminal, false);
  admission(f); await drain(f); await assert.rejects(f.control.waitForExit(), denied); assert.equal(f.sent.length, 1); clean(f);
});

test('unexpected exit after admission remains a failure even when the child reports a drained result', async () => {
  const f = fixture(); frame(f, 'control-ready'); admission(f); await f.control.ready;
  frame(f, 'drained'); await finish(f); await assert.rejects(f.control.waitForExit(), denied);
  assert.equal(f.control.status().terminal, true); assert.equal(f.control.status().failureCode, denied.message); clean(f);
});

test('spawn failure without a PID requires actual close and closed pipes, not fabricated exit', async () => {
  const f = fixture(); f.child.pid = undefined; f.child.emit('error', Error('PRIVATE SPAWN'));
  f.child.stdout.destroy(); f.child.stderr.destroy(); await tick(); assert.equal(f.control.status().terminal, false);
  f.child.emit('close', -2, null); await assert.rejects(f.control.waitForExit(), denied);
  assert.equal(f.control.status().spawnFailed, true); assert.equal(f.control.status().exitCode, null); clean(f);
});

test('assigned PID plus close without exit cannot authorize cleanup; later actual failure exit completes it', async () => {
  const f = fixture(); f.child.emit('error', Error('PRIVATE')); f.child.emit('close', 1, null);
  f.child.stdout.destroy(); f.child.stderr.destroy(); await tick(); assert.equal(f.control.status().terminal, false);
  f.child.emit('exit', 1, null); await assert.rejects(f.control.waitForExit(), denied); clean(f);
});

test('close observation timeout never resolves a live child or replaces its direct lifetime', async () => {
  const f = fixture(5); frame(f, 'control-ready'); admission(f); await f.control.ready;
  const closing = f.control.close(); let settled = false; closing.catch(() => { settled = true; });
  await new Promise(yes => setTimeout(yes, 20)); assert.equal(settled, false); assert.equal(f.control.status().terminal, false);
  const request = f.sent[0].requestId; frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f);
  await assert.rejects(closing, denied); assert.equal(f.control.close(), closing); clean(f);
});

test('normal close notifies unavailability immediately without marking failure or proving terminal', async () => {
  const f = fixture(); frame(f, 'control-ready'); admission(f); await f.control.ready;
  const notice = f.control.waitForUnavailable(); assert.equal(f.control.waitForUnavailable(), notice);
  let notified = false; notice.then(() => { notified = true; }); await tick(); assert.equal(notified, false);
  const closing = f.control.close(), value = await notice;
  assert.deepEqual(value, { unavailable: true }); assert.ok(Object.isFrozen(value));
  assert.equal(f.control.status().ready, true); // Historical admission fact, not current health.
  assert.equal(f.control.status().stopRequested, true); assert.equal(f.control.status().terminal, false);
  assert.equal(f.control.status().failureCode, null);
  const request = f.sent[0].requestId; frame(f, 'stop-accepted', request); frame(f, 'drained', request); await finish(f);
  await closing; assert.equal(f.control.status().failureCode, null); clean(f);
});

test('post-admission faults notify before exit/pipe drain while preserving actual lifetime observation', async () => {
  for (const mode of ['stderr', 'protocol', 'disconnect', 'exit']) {
    const f = fixture(); frame(f, 'control-ready'); admission(f); await f.control.ready;
    let ended = false; f.control.waitForExit().catch(() => { ended = true; });
    if (mode === 'stderr') f.child.stderr.write('PRIVATE FAILURE');
    else if (mode === 'protocol') f.child.emit('message', { secret: 'PRIVATE FAILURE' });
    else if (mode === 'disconnect') { f.child.connected = false; f.child.channel = null; f.child.emit('disconnect'); }
    else f.child.emit('exit', 1, null);
    const value = await f.control.waitForUnavailable(); assert.deepEqual(value, { unavailable: true });
    assert.equal(ended, false); assert.equal(f.control.status().terminal, false); assert.equal(f.control.status().ready, true);
    assert.equal(f.control.status().failureCode, denied.message); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
    await finish(f, { code: 1 }); await assert.rejects(f.control.waitForExit(), denied); clean(f);
  }
});

test('startup observation timeout notifies unavailability without waiting for the owned child to terminate', async () => {
  const f = fixture(5), hold = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await f.control.waitForUnavailable(), { unavailable: true });
    assert.equal(f.control.status().observationTimedOut, true); assert.equal(f.control.status().terminal, false);
    await assert.rejects(f.control.ready, denied); await drain(f);
    await assert.rejects(f.control.waitForExit(), denied); clean(f);
  } finally { clearTimeout(hold); }
});

test('launcher validation never spawns for unknown fields, accessors, malformed environment or purpose injection', async () => {
  let calls = 0, getters = 0; const patch = mock.method(childProcess, 'spawn', () => { calls++; throw Error('SHOULD_NOT_SPAWN'); }); syncBuiltinESMExports();
  try {
    const { purpose, ...base } = bootstrap(); const environment = { SYSTEMROOT: 'C:\\Windows' };
    for (const input of [{ ...base, environment, command: 'private' }, { ...base, environment, purpose },
      { ...base, environment: { SYSTEMROOT: 7 } }, { ...base, environment, onOwned: true }])
      await assert.rejects(launchWindowsSyntheticWorker(input), denied);
    const value = { ...base, environment }; Object.defineProperty(value, 'onOwned', { get() { getters++; } });
    await assert.rejects(launchWindowsSyntheticWorker(value), denied); assert.equal(calls, 0); assert.equal(getters, 0);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

test('synchronous spawn failure is redacted without an invented child lifetime', { skip: process.platform !== 'win32' }, async () => {
  const patch = mock.method(childProcess, 'spawn', () => { throw Error('PRIVATE PATH'); }); syncBuiltinESMExports();
  try {
    const { purpose, ...input } = bootstrap(); let owned = false;
    await assert.rejects(launchWindowsSyntheticWorker({ ...input, environment: { SYSTEMROOT: 'C:\\Windows' }, onOwned: () => { owned = true; } }),
      error => error.message === denied.message && !error.cause && !error.stack.includes('PRIVATE PATH'));
    assert.equal(owned, false);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

for (const mode of ['normal', 'cancel', 'owner-throws']) test(`launcher mock ${mode} registers ownership before bootstrap and retains exact terminal observation`,
  { skip: process.platform !== 'win32' }, async () => {
    const f = rawChild(); let owned, spawnOptions, bootstraps = 0, id;
    f.child.send = (value, done) => {
      assert.ok(owned);
      if (value.purpose === SYNTHETIC_WORKER_PURPOSE) {
        bootstraps++; assert.equal(Object.hasOwn(value, 'mode'), false); assert.equal(Object.hasOwn(value.database, 'password'), false);
        queueMicrotask(() => { done(null); frame({ ...f, instanceId: id }, 'control-ready'); admission({ ...f, instanceId: id }); });
      } else {
        f.sent.push(value); queueMicrotask(async () => {
          done(null); frame({ ...f, instanceId: id }, 'stop-accepted', value.requestId);
          frame({ ...f, instanceId: id }, 'drained', value.requestId); await finish(f);
        });
      }
      return false;
    };
    f.child.disconnect = () => { void finish(f, { code: 1 }); };
    const patch = mock.method(childProcess, 'spawn', (executable, args, options) => {
      assert.equal(executable, process.execPath); assert.match(args[0], /windows-synthetic-worker-child\.mjs$/); id = args[1];
      spawnOptions = options; return f.child;
    }); syncBuiltinESMExports();
    try {
      const { purpose, ...input } = bootstrap();
      const pending = launchWindowsSyntheticWorker({ ...input,
        environment: { SYSTEMROOT: 'C:\\Windows', PRIVATE_SECRET: 'NEVER_FORWARD', NODE_OPTIONS: '--inspect' },
        onOwned: lifetime => { owned = lifetime; assert.equal(bootstraps, 0); if (mode === 'cancel') void lifetime.close(); if (mode === 'owner-throws') throw Error('PRIVATE'); } });
      if (mode === 'normal') { assert.equal(await pending, owned); assert.equal(owned.status().ready, true); await owned.close(); }
      else await assert.rejects(pending, denied);
      assert.equal(owned.status().terminal, true); assert.equal(owned.status().stdioClosed, true);
      assert.equal(bootstraps, mode === 'owner-throws' ? 0 : 1); assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
      assert.equal(spawnOptions.env.PRIVATE_SECRET, undefined); assert.equal(spawnOptions.env.NODE_OPTIONS, undefined);
      assert.deepEqual(Object.keys(owned), ['close', 'status', 'waitForExit', 'waitForUnavailable']);
      assert.deepEqual(await owned.waitForUnavailable(), { unavailable: true }); clean(f);
    } finally { patch.mock.restore(); syncBuiltinESMExports(); }
  });
