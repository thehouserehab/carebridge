// Explicit synthetic parent only. It owns the actual spawn and never adopts a
// PID, accepts executable/DB secrets, force-kills, restarts or deletes resources.
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { privateSecretEnvironment, encodePrivateSecretFrame } from './windows-private-secret-io.mjs';
import { syntheticWifiNetwork } from './synthetic-wifi-network.mjs';
import { windowsNativeApiBootstrap, windowsWifiApiBootstrap, nativeApiInstanceId, nativeApiControlMessage,
  parseNativeApiControlMessage, nativeApiTestUnavailable } from './windows-native-api-test-policy.mjs';
import { NATIVE_API_RESOURCE_PROTOCOL, NATIVE_API_RESOURCE_PHASES,
  parseNativeApiResourceMessage } from './windows-native-api-test-resources.mjs';

// Exported for explicit process-event unit doubles. The real launcher fixes
// its 30s observation deadline; reaching it does NOT prove OS termination.
export function observeWindowsNativeApiTestChild(child, { instanceId, observationMilliseconds = 30000, network } = {}) {
  nativeApiInstanceId(instanceId);
  const ownedNetwork = network === undefined ? undefined : syntheticWifiNetwork(network);
  if (!(child instanceof ChildProcess) || typeof child.send !== 'function' || child.exitCode !== null || child.signalCode !== null ||
      !Number.isInteger(observationMilliseconds) || observationMilliseconds < 1 || observationMilliseconds > 30000 ||
      ['message', 'error', 'disconnect', 'exit', 'close'].some((name) => child.listenerCount(name))) throw nativeApiTestUnavailable();
  const streams = [...new Set(child.stdio.filter(Boolean))], listeners = [], streamListeners = [];
  const readiness = Promise.withResolvers(), terminal = Promise.withResolvers();
  readiness.promise.catch(() => {}); terminal.promise.catch(() => {});
  // First occurrence of each fixed event only: bounded diagnostic evidence,
  // not a process-health decision or a log of IPC payloads/private errors.
  const observedAt = performance.now(), eventTimeline = [], observedEvents = new Set(), resourceObservations = [];
  const observe = (event) => {
    if (observedEvents.has(event)) return;
    observedEvents.add(event);
    eventTimeline.push(Object.freeze({ event, elapsedMs: Math.max(0, Math.floor(performance.now() - observedAt)) }));
  };
  let origin, ready = false, stopped = false, failed = false, stopRequested = false, stopSent = false,
    exited = false, spawned = false, spawnFailed = false, closed = false, disconnected = false, completed = false, timedOut = false, exitCode = null, signalCode = null,
    pendingSends = 0, timer, stderr = '', outputBytes = 0;
  const stdioClosed = () => streams.every((stream) => stream.closed === true);
  const observeClosedStdio = () => {
    // Stream.closed may become true before its close callback is delivered.
    // Capture the same closed-state evidence used by isTerminal, including
    // when a pending IPC-send callback is what triggers final settlement.
    if (child.stdout?.closed === true) observe('stdout-close');
    if (child.stderr?.closed === true) observe('stderr-close');
    if (stdioClosed()) observe('stdio-close');
  };
  const isTerminal = () => stdioClosed() && (exited && (closed || failed && disconnected) || spawnFailed && closed && child.pid === undefined);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { observe('deadline'); timedOut = true; fault(); }, observationMilliseconds);
    timer.unref?.();
  };
  const complete = () => {
    observeClosedStdio();
    if (completed || !isTerminal() || pendingSends) return;
    completed = true; clearTimeout(timer);
    // Failed exit/disconnect/closed-pipe evidence can settle before Node's
    // child close callback. Preserve only that final observation; it cannot
    // turn the settled failure into success or authorize extra cleanup.
    for (const [name, listener] of listeners) if (name !== 'close' || closed) child.removeListener(name, listener);
    for (const [stream, name, listener] of streamListeners) stream.removeListener(name, listener);
    if (!closed || !stopped || exitCode !== 0 || signalCode !== null) { observe('failure'); failed = true; }
    // A ready frame received after stop/failure is not admitted readiness.
    // Rejecting an already resolved promise is harmless; no terminal path may
    // leave launch waiting forever for an earlier, unadmitted ready frame.
    readiness.reject(nativeApiTestUnavailable());
    if (failed) terminal.reject(nativeApiTestUnavailable());
    else terminal.resolve(Object.freeze({ exited: true, exitCode: 0, stopped: true }));
  };
  const sendStop = () => {
    if (stopSent || completed || child.connected !== true) return;
    stopSent = true; pendingSends++;
    try { child.send(nativeApiControlMessage(instanceId, 'stop', undefined, ownedNetwork), (error) => { pendingSends--; if (error) { observe('failure'); failed = true; } complete(); }); }
    catch { pendingSends--; observe('failure'); failed = true; complete(); }
  };
  const stop = () => {
    if (!stopRequested) { observe('stop-requested'); stopRequested = true; arm(); sendStop(); }
    return terminal.promise;
  };
  function fault() { observe('failure'); failed = true; void stop(); complete(); }
  const spawnError = () => { observe('child-error'); if (!spawned && child.pid === undefined) spawnFailed = true; fault(); };
  const message = (value, handle) => {
    try {
      if (Object.getOwnPropertyDescriptor(value ?? {}, 'protocol')?.value === NATIVE_API_RESOURCE_PROTOCOL) {
        const sample = parseNativeApiResourceMessage(value, instanceId, handle);
        if (stopped || completed || sample.phase !== NATIVE_API_RESOURCE_PHASES[resourceObservations.length]) throw nativeApiTestUnavailable();
        resourceObservations.push(Object.freeze({ phase: sample.phase,
          elapsedMs: Math.max(0, Math.floor(performance.now() - observedAt)),
          available: sample.available, truncated: sample.truncated, counts: sample.counts }));
        return; // Counts never admit readiness, acknowledge close or prove exit.
      }
      const frame = parseNativeApiControlMessage(value, instanceId, 'child', handle, ownedNetwork);
      if (frame.kind === 'ready') {
        observe('ipc-ready');
        if (ready || stopped || completed) throw nativeApiTestUnavailable();
        ready = true; origin = frame.origin;
        if (!stopRequested && !failed) { clearTimeout(timer); readiness.resolve(origin); }
      } else if (frame.kind === 'stopped') {
        observe('ipc-stopped');
        if (!stopRequested || stopped) throw nativeApiTestUnavailable();
        stopped = true;
      } else fault();
    } catch { fault(); }
  };
  const lost = () => { observe('disconnect'); disconnected = child.connected === false && !child.channel; if (!stopped) fault(); complete(); };
  const exit = (code, signal) => { observe('exit'); exited = true; exitCode = code; signalCode = signal; if (code !== 0 || signal !== null) fault(); complete(); };
  const close = (code, signal) => {
    observe('child-close');
    closed = true;
    if (completed) { child.removeListener('close', close); return; }
    if (!exited || code !== exitCode || signal !== signalCode || !stopped || code !== 0 || signal !== null) fault();
    complete();
  };
  const output = (bytes, standardError) => {
    outputBytes += bytes.length;
    if (outputBytes > 1024 || !standardError) { fault(); return; }
    // Even the allowed fixed child diagnostic signifies failure. Never retain
    // or forward arbitrary child text/SQL/paths; only its bounded known prefix.
    const next = stderr + bytes.toString('ascii');
    stderr = 'NATIVE_API_FAILED\n'.startsWith(next) ? next : '';
    fault();
  };
  try {
    for (const [name, listener] of [['spawn', () => { observe('spawn'); spawned = true; }], ['message', message], ['error', spawnError], ['disconnect', lost], ['exit', exit], ['close', close]]) {
      child.on(name, listener); listeners.push([name, listener]);
    }
    for (const stream of streams) for (const [name, listener] of [['close', complete], ['error', fault]]) {
      stream.on(name, listener); streamListeners.push([stream, name, listener]);
    }
    for (const [stream, standardError] of [[child.stdout, false], [child.stderr, true]]) if (stream) {
      const listener = (bytes) => output(bytes, standardError); stream.on('data', listener); streamListeners.push([stream, 'data', listener]);
    }
    arm(); if (child.connected !== true) fault();
  } catch { fault(); }
  return Object.freeze({ ready: readiness.promise, close: stop, waitForExit: () => terminal.promise, fail: fault,
    status: () => Object.freeze({ ready, stopRequested, stopped, terminal: isTerminal(), closeObserved: closed, spawnFailed,
      stdioClosed: stdioClosed(), observationTimedOut: timedOut, exitCode, signalCode,
      failureCode: failed ? 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' : null,
      eventTimeline: Object.freeze([...eventTimeline]), resourceObservations: Object.freeze([...resourceObservations]) }) });
}

export async function launchWindowsNativeApiTest(input) { return launchOwnedApiTest(input, false); }

export async function launchWindowsWifiApiTest(input) { return launchOwnedApiTest(input, true); }

// A single private stdin frame is not a control message. The buffer remains
// owned until the write callback or actual stream close, then is overwritten.
function writeTlsFrame(stream, frame) {
  return new Promise((resolve, reject) => {
    let settled = false, failed = false;
    const complete = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      stream.removeListener('error', fail); stream.removeListener('close', closed);
      frame.fill(0);
      if (failed || error) reject(nativeApiTestUnavailable()); else resolve();
    };
    const fail = () => { failed = true; stream.destroy(); };
    const closed = () => complete(nativeApiTestUnavailable());
    const timer = setTimeout(fail, 5000);
    stream.on('error', fail); stream.once('close', closed);
    try { stream.end(frame, complete); } catch { fail(); }
  });
}

async function launchOwnedApiTest(input, wifi) {
  const extra = wifi ? ['network', 'cert', 'key'] : [];
  if (process.platform !== 'win32' || !input || typeof input !== 'object' || Array.isArray(input) ||
      !['database', 'mediaRoot', 'environment', ...extra].every((name) => Object.hasOwn(input, name)) ||
      Reflect.ownKeys(input).some((name) => !['database', 'mediaRoot', 'environment', 'onOwned', 'screen', ...extra].includes(name)) ||
      Reflect.ownKeys(input).some((name) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, name), 'value')) ||
      input.onOwned !== undefined && typeof input.onOwned !== 'function') throw nativeApiTestUnavailable();
  const purpose = wifi ? 'synthetic-carebridge-wifi-api' : 'synthetic-carebridge-native-api';
  const parsed = (wifi ? windowsWifiApiBootstrap : windowsNativeApiBootstrap)({ purpose, database: input.database, mediaRoot: input.mediaRoot,
    ...(Object.hasOwn(input, 'screen') ? { screen: input.screen } : {}), ...(wifi ? { network: input.network } : {}) });
  const onOwned = input.onOwned;
  let environment;
  try { environment = privateSecretEnvironment(input.environment, parsed.database.storage.powershell); }
  catch { throw nativeApiTestUnavailable(); }
  const instanceId = randomUUID();
  let frame;
  if (wifi) {
    let cert, key;
    try {
      if (!Buffer.isBuffer(input.cert) || !Buffer.isBuffer(input.key) || !input.cert.length || !input.key.length ||
          input.cert.length > 16384 || input.key.length > 16384) throw nativeApiTestUnavailable();
      cert = Buffer.from(input.cert); key = Buffer.from(input.key);
      frame = encodePrivateSecretFrame({ purpose: 'synthetic-wifi-tls-v1', instanceId,
        cert: cert.toString('base64'), key: key.toString('base64') });
    } catch { throw nativeApiTestUnavailable(); }
    finally { cert?.fill(0); key?.fill(0); }
  }
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL(wifi ? './windows-wifi-api-child.mjs' : './windows-native-api-test-child.mjs', import.meta.url)), instanceId], {
      cwd: parsed.root, env: { ...environment, [wifi ? 'CAREBRIDGE_NATIVE_WIFI_API_CHILD' : 'CAREBRIDGE_NATIVE_API_TEST_CHILD']: 'synthetic-only' },
      shell: false, windowsHide: true, detached: false, serialization: 'json', stdio: [wifi ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch { frame?.fill(0); throw nativeApiTestUnavailable(); }
  const control = observeWindowsNativeApiTestChild(child, { instanceId, ...(wifi ? { network: parsed.network } : {}) });
  const lifetime = Object.freeze({ close: control.close, status: control.status, waitForExit: control.waitForExit });
  try {
    // Trusted owner registers the lifetime BEFORE any bootstrap can allocate
    // DB/HTTP resources, including when readiness later fails or never arrives.
    onOwned?.(lifetime);
    await new Promise((yes, no) => child.send({ purpose, database: parsed.database,
      mediaRoot: parsed.mediaRoot, screen: parsed.screen, ...(wifi ? { network: parsed.network } : {}) },
    (error) => error ? no(nativeApiTestUnavailable()) : yes()));
    if (wifi) { await writeTlsFrame(child.stdin, frame); frame = undefined; }
    const origin = await control.ready;
    return Object.freeze({ origin, ...lifetime });
  } catch {
    // A failed owner callback/bootstrap never delivers the private payload.
    // Closing stdin also releases a child waiting for its bounded EOF frame.
    frame?.fill(0); child.stdin?.destroy();
    control.fail();
    // Keep observing the same child. An uncertain stop is NOT permission to
    // clean its E files/credentials or release the caller's engine fixture.
    try { await control.waitForExit(); } catch { /* terminal failure is retained in status */ }
    throw nativeApiTestUnavailable();
  }
}
