// Owns one fresh synthetic child. No PID adoption, force-kill, restart, file
// removal or alternate worker. A deadline never substitutes for real exit.
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { controlMediaWorkerChild } from './media-worker-child-control.mjs';
import { privateSecretEnvironment } from './windows-private-secret-io.mjs';
import { SYNTHETIC_WORKER_PURPOSE, windowsSyntheticWorkerBootstrap,
  syntheticWorkerAdmissionParser, syntheticWorkerStageObserver, syntheticWorkerUnavailable } from './windows-synthetic-worker-policy.mjs';

// Observation-only doubles may use a shorter deadline; the real launcher
// fixes it at 30 seconds. Product work and its drain are never raced away.
export function observeWindowsSyntheticWorkerChild(child, { instanceId, observationMilliseconds = 30000 } = {}) {
  if (!(child instanceof ChildProcess) || !Array.isArray(child.stdio) || !child.stdout || !child.stderr ||
      !Number.isInteger(observationMilliseconds) || observationMilliseconds < 1 || observationMilliseconds > 30000)
    throw syntheticWorkerUnavailable();
  const parser = syntheticWorkerAdmissionParser(instanceId);
  const stages = syntheticWorkerStageObserver();
  let control;
  try { control = controlMediaWorkerChild(child, { instanceId }); }
  catch { throw syntheticWorkerUnavailable(); }
  const streams = [...new Set(child.stdio.filter(Boolean))], listeners = [], streamListeners = [];
  const readiness = Promise.withResolvers(), terminal = Promise.withResolvers(), unavailability = Promise.withResolvers();
  const unavailableNotice = Object.freeze({ unavailable: true });
  readiness.promise.catch(() => {}); terminal.promise.catch(() => {});
  let ready = false, admissionObserved = false, failed = false, stopRequested = false, timedOut = false,
    exitObserved = false, closeObserved = false, spawnFailed = false, spawned = false, controlSettled = false,
    controlResult, completed = false, timer;
  const stdioClosed = () => streams.every(stream => stream.closed === true);
  const actuallyTerminal = () => stdioClosed() && controlSettled &&
    (exitObserved && control.status().terminal || spawnFailed && closeObserved && child.pid === undefined);
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; fault(); }, observationMilliseconds);
    timer.unref?.();
  }
  function stop() {
    // This notice only closes admission. It is deliberately independent from
    // successful/failed drain and never authorizes DB or file cleanup.
    unavailability.resolve(unavailableNotice);
    if (!stopRequested) {
      stopRequested = true; readiness.reject(syntheticWorkerUnavailable());
      if (!actuallyTerminal()) { arm(); void control.requestStop().catch(() => {}); }
    }
    return terminal.promise;
  }
  function fault() {
    failed = true; readiness.reject(syntheticWorkerUnavailable());
    void stop(); complete();
  }
  function complete() {
    if (completed || !actuallyTerminal()) return;
    try { stages.end(); } catch { failed = true; }
    completed = true; clearTimeout(timer);
    for (const [name, listener] of listeners) child.removeListener(name, listener);
    for (const [stream, name, listener] of streamListeners) stream.removeListener(name, listener);
    readiness.reject(syntheticWorkerUnavailable());
    if (!stopRequested || !closeObserved || !exitObserved || !controlResult || control.status().failureCode) failed = true;
    if (failed) terminal.reject(syntheticWorkerUnavailable());
    else terminal.resolve(controlResult);
  }
  function admit() {
    const state = control.status();
    if (state.failureCode || state.terminal || state.stopRequested && !stopRequested) { fault(); return; }
    if (!ready && admissionObserved && state.controlReady && !failed && !stopRequested) {
      ready = true; clearTimeout(timer); readiness.resolve();
    }
  }
  const stdout = bytes => {
    try { admissionObserved = parser.feed(bytes); admit(); }
    catch { fault(); }
  };
  const stdoutEnd = () => {
    // Startup cancellation need not have reached admission, but any received
    // partial frame is still not accepted as readiness.
    if (!stopRequested) try { parser.end(); } catch { fault(); }
    complete();
  };
  const stderr = bytes => { try { stages.feed(bytes); } catch { fault(); } };
  const stderrEnd = () => { try { stages.end(); } catch { fault(); } complete(); };
  const message = () => { admit(); complete(); }; // Core owns all IPC parsing.
  const error = () => { if (!spawned && child.pid === undefined) spawnFailed = true; fault(); };
  const exit = () => { exitObserved = true; if (!stopRequested) fault(); complete(); };
  const close = () => { closeObserved = true; unavailability.resolve(unavailableNotice); complete(); };
  try {
    for (const [name, listener] of [['spawn', () => { spawned = true; }], ['message', message], ['error', error],
      ['disconnect', () => { if (!stopRequested) fault(); complete(); }], ['exit', exit], ['close', close]]) {
      child.on(name, listener); listeners.push([name, listener]);
    }
    for (const stream of streams) for (const [name, listener] of [['close', complete], ['error', fault]]) {
      stream.on(name, listener); streamListeners.push([stream, name, listener]);
    }
    for (const [stream, name, listener] of [[child.stdout, 'data', stdout], [child.stdout, 'end', stdoutEnd],
      [child.stderr, 'data', stderr], [child.stderr, 'end', stderrEnd]]) {
      stream.on(name, listener); streamListeners.push([stream, name, listener]);
    }
    void control.waitForExit().then(result => { controlResult = result; controlSettled = true; complete(); },
      () => { controlSettled = true; fault(); });
    arm();
  } catch { fault(); }
  return Object.freeze({ ready: readiness.promise, close: stop, fail: fault, waitForExit: () => terminal.promise,
    waitForUnavailable: () => unavailability.promise,
    status: () => Object.freeze({ ...control.status(), ready, admissionObserved, stopRequested,
      terminal: actuallyTerminal(), closeObserved, stdioClosed: stdioClosed(), spawnFailed,
      diagnostics: stages.snapshot(),
      observationTimedOut: timedOut, failureCode: failed || control.status().failureCode ? 'WINDOWS_SYNTHETIC_WORKER_UNAVAILABLE' : null }) });
}

export async function launchWindowsSyntheticWorker(input) {
  const allowed = ['database', 'mediaRoot', 'nativeMedia', 'environment', 'onOwned'];
  if (process.platform !== 'win32' || !input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      ['database', 'mediaRoot', 'nativeMedia', 'environment'].some(name => !Object.hasOwn(input, name)) ||
      Reflect.ownKeys(input).some(name => !allowed.includes(name) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, name), 'value')) ||
      input.onOwned !== undefined && typeof input.onOwned !== 'function') throw syntheticWorkerUnavailable();
  const parsed = windowsSyntheticWorkerBootstrap({ purpose: SYNTHETIC_WORKER_PURPOSE,
    database: input.database, mediaRoot: input.mediaRoot, nativeMedia: input.nativeMedia });
  const onOwned = input.onOwned;
  let environment;
  try {
    const captured = {};
    for (const key of Reflect.ownKeys(input.environment)) {
      const property = Object.getOwnPropertyDescriptor(input.environment, key);
      if (typeof key !== 'string' || !Object.hasOwn(property, 'value') || typeof property.value !== 'string') throw syntheticWorkerUnavailable();
      Object.defineProperty(captured, key, { value: property.value, enumerable: true });
    }
    environment = privateSecretEnvironment(captured, parsed.database.storage.powershell);
  } catch { throw syntheticWorkerUnavailable(); }
  const instanceId = randomUUID();
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./windows-synthetic-worker-child.mjs', import.meta.url)), instanceId], {
      cwd: parsed.root, env: { ...environment, CAREBRIDGE_SYNTHETIC_WORKER_CHILD: 'synthetic-only' },
      shell: false, windowsHide: true, detached: false, serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch { throw syntheticWorkerUnavailable(); }
  const control = observeWindowsSyntheticWorkerChild(child, { instanceId });
  const lifetime = Object.freeze({ close: control.close, status: control.status, waitForExit: control.waitForExit,
    waitForUnavailable: control.waitForUnavailable });
  let bootstrapSent = false;
  try {
    onOwned?.(lifetime); // Ownership is recorded before any credential/engine work.
    await new Promise((yes, no) => {
      bootstrapSent = true;
      child.send({ purpose: SYNTHETIC_WORKER_PURPOSE, database: parsed.database,
        mediaRoot: parsed.mediaRoot, nativeMedia: parsed.nativeMedia }, error => error ? no(syntheticWorkerUnavailable()) : yes());
    });
    await control.ready;
    return lifetime;
  } catch {
    if (!control.status().stopRequested) control.fail();
    // An owner callback failure precedes any bootstrap/DB/engine work. Closing
    // this exact unbootstrapped channel lets its otherwise idle child end; a
    // bootstrapped worker must always use the cooperative stop/drain protocol.
    if (!bootstrapSent && child.connected) try { child.disconnect(); } catch { /* Observe actual terminal evidence below. */ }
    try { await control.waitForExit(); } catch { /* Same owned lifetime remains available to its owner. */ }
    throw syntheticWorkerUnavailable();
  }
}
