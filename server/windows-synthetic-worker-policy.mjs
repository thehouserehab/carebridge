// Fresh synthetic E sessions only. A startup observation is not file approval,
// a heartbeat, or evidence of process termination.
import { windowsNativeWorkerBootstrap, nativeWorkerStderrObserver } from './windows-native-worker-test-policy.mjs';
import { mediaWorkerControlId } from './media-worker-control-protocol.mjs';
import { MEDIA_WORKER_STAGE_NAMES } from './media-worker-observation.mjs';
import { WINDOWS_DATABASE_STAGES } from './windows-database-observation.mjs';

export const SYNTHETIC_WORKER_PURPOSE = 'synthetic-carebridge-interactive-worker';
export const syntheticWorkerUnavailable = () => new Error('WINDOWS_SYNTHETIC_WORKER_UNAVAILABLE');

function data(value, seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || seen.has(value)) throw syntheticWorkerUnavailable();
  seen.add(value);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(property, 'value')) throw syntheticWorkerUnavailable();
    Object.defineProperty(result, key, { value: data(property.value, seen), enumerable: true });
  }
  seen.delete(value);
  return Object.freeze(result);
}

export function windowsSyntheticWorkerBootstrap(input) {
  try {
    const captured = data(input), keys = ['purpose', 'database', 'mediaRoot', 'nativeMedia'];
    if (!captured || Reflect.ownKeys(captured).length !== keys.length || keys.some(key => !Object.hasOwn(captured, key)) ||
        captured.purpose !== SYNTHETIC_WORKER_PURPOSE) throw syntheticWorkerUnavailable();
    // Caller cannot select a test gate. Reuse the existing role/TLS/E/image
    // validator with a fixed internal mode, never trust an incoming mode.
    const { mode, ...parsed } = windowsNativeWorkerBootstrap({ ...captured,
      purpose: 'synthetic-carebridge-native-worker', mode: 'complete' });
    return Object.freeze(parsed);
  } catch { throw syntheticWorkerUnavailable(); }
}

export function syntheticWorkerAdmissionFrame(instanceId) {
  try { mediaWorkerControlId(instanceId); }
  catch { throw syntheticWorkerUnavailable(); }
  return `SWA1:${instanceId}:ADMITTED\n`;
}

export function syntheticWorkerAdmissionReporter(instanceId, write) {
  const frame = syntheticWorkerAdmissionFrame(instanceId);
  if (typeof write !== 'function') throw syntheticWorkerUnavailable();
  let sent = false;
  return event => {
    if (sent || !event || typeof event !== 'object') return;
    const fields = Object.getOwnPropertyDescriptors(event);
    if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields, 'stage') || !Object.hasOwn(fields, 'edge') ||
        !Object.hasOwn(fields.stage, 'value') || !Object.hasOwn(fields.edge, 'value') ||
        fields.stage.value !== 'worker-admission' || fields.edge.value !== 'complete') return;
    sent = true;
    return write(frame); // The trusted onStage wrapper consumes diagnostic errors.
  };
}

export function syntheticWorkerAdmissionParser(instanceId) {
  const expected = Buffer.from(syntheticWorkerAdmissionFrame(instanceId));
  let offset = 0, invalid = false;
  return Object.freeze({
    feed(bytes) {
      if (invalid) throw syntheticWorkerUnavailable();
      if (!(bytes instanceof Uint8Array) || offset + bytes.length > expected.length) {
        invalid = true; throw syntheticWorkerUnavailable();
      }
      for (const byte of bytes) if (byte !== expected[offset++]) {
        invalid = true; throw syntheticWorkerUnavailable();
      }
      return offset === expected.length;
    },
    end() {
      if (invalid || offset !== expected.length) { invalid = true; throw syntheticWorkerUnavailable(); }
    },
    get complete() { return !invalid && offset === expected.length; },
  });
}

// Only finite stage frames may share this child's stderr. Unlike the native
// crash classifier, this channel still rejects every unexpected diagnostic.
// It never changes admission, file approval or actual process-exit evidence.
export function syntheticWorkerStageObserver() {
  const observer = nativeWorkerStderrObserver();
  let line = '', bytes = 0, invalid = false, ended = false;
  const fail = () => { invalid = true; line = ''; throw syntheticWorkerUnavailable(); };
  return Object.freeze({
    feed(chunk) {
      if (invalid || ended || !(chunk instanceof Uint8Array) || bytes + chunk.length > 16384) return fail();
      bytes += chunk.length;
      for (const byte of chunk) {
        if (byte !== 10) {
          if (byte < 32 || byte > 126 || line.length >= 32) return fail();
          line += String.fromCharCode(byte);
          if (line.length <= 4 && !['NS1:', 'ND1:', 'NL1:', 'NDL1'].some(prefix => prefix.startsWith(line))) return fail();
          continue;
        }
        const stage = /^NS1:(\d{2}):[BCF]$/.exec(line);
        const database = /^ND1:(\d{2}):[BCF]:(0|[1-9]\d{0,8})$/.exec(line);
        if (!(stage && Number(stage[1]) >= 1 && Number(stage[1]) <= MEDIA_WORKER_STAGE_NAMES.length) &&
            !(database && Number(database[1]) >= 1 && Number(database[1]) <= WINDOWS_DATABASE_STAGES.length) &&
            !/^NL1:[PWL]$/.test(line) && line !== 'NDL1') return fail();
        observer.feed(Buffer.from(`${line}\n`, 'ascii')); line = '';
      }
    },
    end() {
      if (invalid || line.length) return fail();
      ended = true;
    },
    snapshot: () => Object.freeze({ ...observer.snapshot(), invalidOutput: invalid }),
  });
}
