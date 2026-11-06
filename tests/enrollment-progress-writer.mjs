// Test harness only. The callback owns its destination and sanitized payload.
// A deadline bounds observation, not the underlying filesystem operation.
const error = () => new Error('ENROLLMENT_PROGRESS_WRITE_FAILED');

export function createEnrollmentProgressWriter(write, options = {}) {
  let timeoutMs;
  try {
    if (typeof write !== 'function' || !options || typeof options !== 'object' || Array.isArray(options)) throw error();
    const requestedTimeout = options.timeoutMs;
    timeoutMs = requestedTimeout === undefined ? 5000 : requestedTimeout;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw error();
  } catch { throw error(); }
  let failed = false, inFlight = false, timedOut = false, active = null;

  function seal(timeout = false) {
    failed = true;
    if (timeout) timedOut = true;
    // Reject the existing observer too. It must not later report success after
    // a concurrent call has permanently sealed this writer.
    active?.reject();
  }

  async function save(checkpoint) {
    if (failed) throw error();
    if (inFlight) { seal(); throw error(); }
    inFlight = true;
    const startedAt = performance.now();
    let timer, observed = false;
    const result = Promise.withResolvers();
    const operation = {
      reject() {
        if (observed) return;
        observed = true; clearTimeout(timer); result.reject(error());
      },
      resolve() {
        if (observed) return;
        observed = true; clearTimeout(timer); result.resolve();
      },
    };
    active = operation;
    timer = setTimeout(() => seal(true), timeoutMs);
    const settled = succeeded => {
      // Only actual settlement changes this flag. Deadline/overlap is NOT
      // cancellation, cleanup permission or proof that the write completed.
      inFlight = false;
      const late = performance.now() - startedAt >= timeoutMs;
      if (!succeeded || late) seal(late);
      if (failed) operation.reject(); else operation.resolve();
      if (active === operation) active = null;
    };
    try {
      // Install both callbacks immediately: a late rejection after the
      // observer's timeout cannot become an unhandled raw filesystem error.
      Promise.resolve(write(checkpoint)).then(() => settled(true), () => settled(false));
    } catch { settled(false); }
    await result.promise;
  }

  return Object.freeze({
    write: save,
    status: () => Object.freeze({ failed, inFlight, timedOut }),
  });
}
