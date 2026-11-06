// Synthetic inherited-IPC diagnostics only. Never expose handles, filenames,
// socket peers, resource IDs or arbitrary runtime type strings to a report.
import { nativeApiInstanceId, nativeApiTestUnavailable } from './windows-native-api-test-policy.mjs';

export const NATIVE_API_RESOURCE_PROTOCOL = 'carebridge-native-api-resources-v1';
export const NATIVE_API_RESOURCE_PHASES = Object.freeze(['before-service-close', 'after-service-close']);
export const NATIVE_API_RESOURCE_TYPES = Object.freeze(['Timeout', 'Immediate', 'TCPSocketWrap', 'TCPServerWrap',
  'TCPConnectWrap', 'PipeWrap', 'PipeConnectWrap', 'ProcessWrap', 'FSReqCallback', 'FSReqPromise',
  'FileHandleCloseReq', 'ShutdownWrap', 'WriteWrap', 'TLSWrap', 'MessagePort', 'Other']);
export const NATIVE_API_RESOURCE_LIMIT = 4096;

function data(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value');
    });
}
function snapshot(value) {
  if (!data(value, ['available', 'truncated', 'counts']) || typeof value.available !== 'boolean' ||
      typeof value.truncated !== 'boolean' || !Array.isArray(value.counts) ||
      value.counts.length > NATIVE_API_RESOURCE_TYPES.length ||
      Reflect.ownKeys(value.counts).length !== value.counts.length + 1) throw nativeApiTestUnavailable();
  let prior = -1, total = 0;
  const counts = [];
  for (let index = 0; index < value.counts.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value.counts, String(index));
    if (!entry || !Object.hasOwn(entry, 'value') || !data(entry.value, ['type', 'count'])) throw nativeApiTestUnavailable();
    const { type, count } = entry.value, position = NATIVE_API_RESOURCE_TYPES.indexOf(type);
    if (position <= prior || !Number.isSafeInteger(count) || count < 1 || count > NATIVE_API_RESOURCE_LIMIT)
      throw nativeApiTestUnavailable();
    prior = position; total += count;
    if (total > NATIVE_API_RESOURCE_LIMIT) throw nativeApiTestUnavailable();
    counts.push(Object.freeze({ type, count }));
  }
  if (!value.available && (value.truncated || total) || value.truncated && total !== NATIVE_API_RESOURCE_LIMIT)
    throw nativeApiTestUnavailable();
  return Object.freeze({ available: value.available, truncated: value.truncated, counts: Object.freeze(counts) });
}

/** Internal synchronous observer injection only; never selected by IPC input. */
export function captureNativeApiResources(read) {
  try {
    const types = read();
    if (!Array.isArray(types)) {
      // The native reader is synchronous. An accidentally async trusted
      // observer is unavailable, but its rejection must not crash cleanup.
      void Promise.resolve(types).catch(() => {});
      throw nativeApiTestUnavailable();
    }
    const counts = new Map();
    for (let index = 0; index < Math.min(types.length, NATIVE_API_RESOURCE_LIMIT); index++) {
      const entry = Object.getOwnPropertyDescriptor(types, String(index));
      if (!entry || !Object.hasOwn(entry, 'value') || typeof entry.value !== 'string') throw nativeApiTestUnavailable();
      const type = NATIVE_API_RESOURCE_TYPES.includes(entry.value) ? entry.value : 'Other';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return snapshot({ available: true, truncated: types.length > NATIVE_API_RESOURCE_LIMIT,
      counts: NATIVE_API_RESOURCE_TYPES.filter(type => counts.has(type)).map(type => ({ type, count: counts.get(type) })) });
  } catch {
    // Observation failure neither abandons close nor emits its private error.
    return snapshot({ available: false, truncated: false, counts: [] });
  }
}

export function nativeApiResourceMessage(instanceId, phase, observation) {
  nativeApiInstanceId(instanceId);
  if (!NATIVE_API_RESOURCE_PHASES.includes(phase)) throw nativeApiTestUnavailable();
  return Object.freeze({ protocol: NATIVE_API_RESOURCE_PROTOCOL, instanceId, phase, ...snapshot(observation) });
}
export function parseNativeApiResourceMessage(value, instanceId, handle) {
  if (handle !== undefined || !data(value, ['protocol', 'instanceId', 'phase', 'available', 'truncated', 'counts']) ||
      value.protocol !== NATIVE_API_RESOURCE_PROTOCOL || value.instanceId !== instanceId) throw nativeApiTestUnavailable();
  return nativeApiResourceMessage(instanceId, value.phase,
    { available: value.available, truncated: value.truncated, counts: value.counts });
}
