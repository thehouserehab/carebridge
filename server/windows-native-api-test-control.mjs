// Test-harness lifetime for an already inherited, directly owned IPC channel.
// The entrypoint supplies the fixed real factory. Injection here is for unit
// protocol doubles, not browser input, engine selection or an operating server.
import { windowsNativeApiBootstrap, windowsWifiApiBootstrap, nativeApiInstanceId, nativeApiOrigin, nativeApiControlMessage,
  parseNativeApiControlMessage, nativeApiTestUnavailable } from './windows-native-api-test-policy.mjs';
import { captureNativeApiResources, nativeApiResourceMessage } from './windows-native-api-test-resources.mjs';

const active = new WeakSet();
export function runWindowsNativeApiTestChild({ instanceId, createService, targetProcess = process, readActiveResources, wifi = false } = {}) {
  nativeApiInstanceId(instanceId);
  const target = targetProcess;
  if (typeof wifi !== 'boolean' || typeof createService !== 'function' || readActiveResources !== undefined && typeof readActiveResources !== 'function' ||
      !target || target.connected !== true || !target.channel ||
      !['on', 'removeListener', 'listenerCount', 'send', 'disconnect'].every((name) => typeof target[name] === 'function') ||
      active.has(target) || ['message', 'disconnect'].some((name) => target.listenerCount(name))) throw nativeApiTestUnavailable();
  const send = target.send.bind(target), disconnect = target.disconnect.bind(target);
  const completion = Promise.withResolvers(), registered = [];
  let service, network, starting = false, bootstrapSeen = false, stopRequested = false, failed = false, finishing = false;
  const observeResources = phase => {
    if (!readActiveResources || target.connected !== true) return;
    try {
      // Diagnostic sends do not gate or abandon owned cleanup. Inherited IPC
      // ordering preserves the samples before the later terminal control frame.
      send(nativeApiResourceMessage(instanceId, phase, captureNativeApiResources(readActiveResources)), () => {});
    } catch { /* A diagnostic failure cannot replace the service close result. */ }
  };
  const notify = (kind, origin) => new Promise((yes, no) => {
    if (target.connected !== true) return no(nativeApiTestUnavailable());
    try { send(nativeApiControlMessage(instanceId, kind, origin, network), (error) => error ? no(nativeApiTestUnavailable()) : yes()); }
    catch { no(nativeApiTestUnavailable()); }
  });
  const finish = async () => {
    if (finishing || starting || !stopRequested) return;
    finishing = true;
    // Stop admission/drain belongs to the fixed service. Never race its close
    // with a success timeout, force exit or remove possibly-live DB/files here.
    try {
      if (service) { observeResources('before-service-close'); await service.close(); }
    }
    catch { failed = true; }
    finally {
      // A finally sample is NOT a successful close, drain or OS-exit proof.
      if (service) observeResources('after-service-close');
    }
    if (target.connected === true) {
      try { await notify(failed ? 'failed' : 'stopped'); }
      catch { failed = true; }
    } else failed = true;
    for (const [name, listener] of registered) target.removeListener(name, listener);
    active.delete(target);
    if (target.connected === true) { try { disconnect(); } catch { failed = true; } }
    if (failed) {
      if ([undefined, null, 0].includes(target.exitCode)) target.exitCode = 1;
      completion.reject(nativeApiTestUnavailable());
    } else completion.resolve(Object.freeze({ stopped: true }));
  };
  const fault = () => { failed = true; stopRequested = true; void finish(); };
  const start = async (input) => {
    starting = true;
    try {
      service = await createService({ database: input.database, mediaRoot: input.mediaRoot, screen: input.screen,
        ...(wifi ? { network } : {}) });
      if (!service || typeof service.close !== 'function') throw nativeApiTestUnavailable();
      nativeApiOrigin(service.origin, network);
      // Startup may finish after stop/disconnect. Own and close the late result
      // without announcing readiness or making another startup attempt.
      if (!stopRequested && !failed) await notify('ready', service.origin);
    } catch { failed = true; stopRequested = true; }
    finally { starting = false; await finish(); }
  };
  const message = (value, handle) => {
    try {
      if (handle !== undefined) throw nativeApiTestUnavailable();
      if (!bootstrapSeen) {
        const input = wifi ? windowsWifiApiBootstrap(value) : windowsNativeApiBootstrap(value);
        network = input.network;
        bootstrapSeen = true;
        void start(input);
      } else {
        parseNativeApiControlMessage(value, instanceId, 'parent', handle, network);
        stopRequested = true;
        void finish();
      }
    } catch { fault(); }
  };
  active.add(target);
  try {
    for (const [name, listener] of [['message', message], ['disconnect', fault]]) {
      target.on(name, listener); registered.push([name, listener]);
    }
    if (target.connected !== true || ![undefined, null, 0].includes(target.exitCode)) fault();
  } catch { fault(); }
  return completion.promise;
}
