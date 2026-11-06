// Trusted, process-local diagnostics only. These finite events are neither
// approval evidence nor a heartbeat, and contain no job/file/account data.
export const MEDIA_WORKER_STAGE_NAMES = Object.freeze([
  'db-open','worker-admission','retained-recovery','object-cleanup','queue-claim',
  'source-open','source-scan','source-reopen','isolated-preparation','candidate-validation',
  'candidate-scan','candidate-write','candidate-verify','settlement','db-close',
]);
const stages = new Set(MEDIA_WORKER_STAGE_NAMES);

export function captureMediaWorkerObserver(observer) {
  if (observer === null || observer === undefined) return null;
  if (typeof observer !== 'function') throw new TypeError('A trusted media stage observer must be a function.');
  return observer;
}

function notify(observer,stage,edge) {
  if (!observer) return;
  try {
    // Never await observation or let a thrown/rejected diagnostic replace the
    // original result. Also consume rejected thenables without exposing them.
    Promise.resolve(observer(Object.freeze({stage,edge}))).catch(() => {});
  } catch {}
}

export async function observeMediaStage(observer,stage,work) {
  const captured = captureMediaWorkerObserver(observer);
  if (!stages.has(stage) || typeof work !== 'function') throw new TypeError('A fixed media stage and work function are required.');
  notify(captured,stage,'begin');
  let result;
  try { result = await work(); }
  catch (error) { notify(captured,stage,'failed'); throw error; }
  notify(captured,stage,'complete');
  return result;
}
