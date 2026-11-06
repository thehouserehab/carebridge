// Observation only: this file never authorizes elevation, establishes readiness,
// or proves cleanup. It is separate from the firewall helper's control directory.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';

const code = 'SYNTHETIC_WIFI_DIAGNOSTIC_UNAVAILABLE';
const snapshotKeys = ['schema', 'observationOnly', 'state', 'preflight', 'ready', 'failureReason',
  'readyDeadlineExpired', 'lifetimeExpired', 'cleanupDeadlineExpired', 'everActive', 'stopRequested', 'cleanup', 'observedStage', 'launcher'];
const launcherKeys = ['spawnObserved', 'exitObserved', 'closed', 'errorObserved', 'signalObserved', 'exitCode', 'outcome'];
const states = new Set(['preparing', 'waiting-approval', 'active', 'stopping', 'failed', 'removed']);
const preflights = new Set(['pending', 'passed', 'failed']);
const readiness = new Set(['pending', 'active', 'failed']);
const reasons = new Set([null, 'platform', 'configuration', 'executable', 'elevated', 'network', 'port',
  'firewall-allow', 'firewall-block', 'firewall-uncertain', 'inspection', 'approval', 'cancelled', 'status', 'cleanup-pending']);
const cleanups = new Set(['not-started', 'pending', 'confirmed', 'unconfirmed']);
const stages = new Set([null, 'active', 'removed', 'failed']);
const outcomes = new Set(['pending', 'not-spawned', 'declined', 'launch-failed', 'helper-failed',
  'observation-failed', 'exited', 'unrecognized']);
const events = new Set(['cleanup-confirmed', 'cleanup-unconfirmed']);

function unavailable() {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownData(value, keys) {
  // Check Proxy before reflection so hostile getters AND reflection traps stay
  // unevaluated. Never coerce unknown values or copy their inherited properties.
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name))) throw unavailable();
  const copy = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw unavailable();
    copy[key] = descriptor.value;
  }
  return copy;
}

export function sanitizeSyntheticWifiDiagnostic(value) {
  try {
    const snapshot = ownData(value, snapshotKeys);
    if (snapshot.schema !== 1 || snapshot.observationOnly !== true || !states.has(snapshot.state) ||
        !preflights.has(snapshot.preflight) || !readiness.has(snapshot.ready) || !reasons.has(snapshot.failureReason) ||
        !cleanups.has(snapshot.cleanup) || !stages.has(snapshot.observedStage) ||
        ['readyDeadlineExpired', 'lifetimeExpired', 'cleanupDeadlineExpired', 'everActive', 'stopRequested'].some(key => typeof snapshot[key] !== 'boolean')) throw unavailable();
    if (snapshot.launcher !== null) {
      const launcher = ownData(snapshot.launcher, launcherKeys);
      if (['spawnObserved', 'exitObserved', 'closed', 'errorObserved', 'signalObserved'].some(key => typeof launcher[key] !== 'boolean') ||
          !outcomes.has(launcher.outcome) || (launcher.exitCode !== null &&
          (!Number.isInteger(launcher.exitCode) || launcher.exitCode < -2147483648 || launcher.exitCode > 4294967295))) throw unavailable();
      snapshot.launcher = Object.freeze(launcher);
    }
    return Object.freeze(snapshot);
  } catch {
    // Never expose caller data, thrown proxy errors, raw child output or paths.
    throw unavailable();
  }
}

export async function writeSyntheticWifiDiagnostic(event, value) {
  try {
    if (!events.has(event)) throw unavailable();
    const snapshot = sanitizeSyntheticWifiDiagnostic(value);
    const data = JSON.stringify({ event, recordedAt: new Date().toISOString(), snapshot }) + '\n';
    if (data.length >= 4096 || Buffer.byteLength(data, 'utf8') >= 4096) throw unavailable();
    // No caller path, prior file adoption or overwrite. A failed/partial write
    // is intentionally retained; this diagnostic does not own cleanup powers.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carebridge-wifi-diagnostic-'));
    const filename = path.join(directory, 'diagnostic.json');
    const handle = await fs.open(filename, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return filename;
  } catch {
    // No cause/details/path: even an OS error may contain sensitive context.
    throw unavailable();
  }
}
