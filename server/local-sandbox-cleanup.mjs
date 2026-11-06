// In-process capability for a failed, newly owned synthetic sandbox only.
// Never discover cleanup methods on an error or adopt a caller-supplied path.
const pending = new WeakMap();

export function createOwnedCleanupError(error, cleanupError, close) {
  if (typeof close !== 'function') throw new TypeError('An owned cleanup function is required.');
  const failure = new AggregateError([error, cleanupError], 'Synthetic sandbox preparation and cleanup failed.');
  let closing, confirmed = false;
  const retry = Object.freeze(() => {
    if (confirmed) return Promise.resolve();
    if (closing) return closing;
    // Adopt synchronous throws as well as asynchronous close failures. The
    // owner supplies the actual-close contract; a timeout remains a rejection.
    closing = Promise.resolve().then(close).then(() => {
      confirmed = true;
      pending.delete(failure);
    }).finally(() => { closing = undefined; });
    return closing;
  });
  pending.set(failure, retry);
  return failure;
}

export function getPendingSyntheticCleanup(error) {
  // WeakMap identity lookup invokes no proxy traps, getters or inherited code.
  return pending.get(error);
}
