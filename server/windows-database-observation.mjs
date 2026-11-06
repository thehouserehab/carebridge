// Trusted, content-free observation only. Never receive or serialize an
// exception, query, path, credential, role, user, endpoint or provider response.
import { performance } from 'node:perf_hooks';

export const WINDOWS_DATABASE_STAGES = Object.freeze([
  'credential-read', 'credential-unprotect', 'credential-recheck',
  'connection', 'privilege-check', 'transaction',
]);
const noop = () => {};
export function beginWindowsDatabaseStage(observer, stage) {
  if (typeof observer !== 'function' || !WINDOWS_DATABASE_STAGES.includes(stage)) return noop;
  const started = performance.now(); let finished = false;
  const emit = (edge) => {
    const elapsedMs = edge === 'begin' ? 0 : Math.min(2147483647, Math.max(0, Math.round(performance.now() - started)));
    try {
      // Observation cannot become an admission hook, prolong work, or turn a
      // rejected observer Promise into an unhandled process error.
      Promise.resolve(observer(Object.freeze({ stage, edge, elapsedMs }))).catch(noop);
    } catch { /* Keep the original operation and error contract. */ }
  };
  emit('begin');
  return (edge) => {
    if (finished || !['complete', 'failed'].includes(edge)) return;
    finished = true; emit(edge);
  };
}
