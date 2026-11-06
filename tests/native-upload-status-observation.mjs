// Diagnostic-only observer for an already authorized browser status check.
// It neither issues requests nor changes waits, retries, approval or assertions.
// Keep the latest bounded outcomes so repeated successful polls cannot evict
// the failure at the end. No request/response/error data is serialized.
export const UPLOAD_STATUS_OBSERVATION_LIMIT = 32;

export function createUploadStatusObservations({ now = () => performance.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('INVALID_STATUS_OBSERVATION_OPTIONS');
  const entries = [];
  const snapshot = () => Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  const append = (entry) => {
    if (entries.length === UPLOAD_STATUS_OBSERVATION_LIMIT) entries.shift();
    entries.push(entry); return entry;
  };
  return Object.freeze({ snapshot, begin(page, matchesRequest) {
    if (!page || typeof page.on !== 'function' || typeof page.off !== 'function' || typeof matchesRequest !== 'function')
      throw new TypeError('INVALID_STATUS_OBSERVATION_OPTIONS');
    const started = now();
    let finished = false, observedRequest = null, entry = null, lastElapsed = 0, responseWaitTimedOut = false;
    const elapsed = () => {
      const value = now() - started;
      if (Number.isFinite(value)) lastElapsed = Math.min(1_000_000_000, Math.max(lastElapsed, Math.floor(value), 0));
      return lastElapsed;
    };
    const matches = (request) => {
      if (finished || !request || typeof request !== 'object') return false;
      try { return matchesRequest(request) === true; } catch { return false; }
    };
    const requestStarted = (request) => {
      if (observedRequest || !matches(request)) return;
      observedRequest = request;
      entry = append({ category: 'no-response', status: null, bodyOutcome: 'not-read', responseWaitTimedOut: false, elapsedMs: elapsed() });
    };
    const matchesResponse = (response) => {
      if (finished || !observedRequest) return false;
      try { return response.request() === observedRequest; } catch { return false; }
    };
    const responseObserved = (response) => {
      if (!matchesResponse(response)) return null;
      let status; try { status = response.status(); } catch { return null; }
      if (!Number.isInteger(status) || status < 100 || status > 599) return null;
      if (entry.category !== 'request-failed') entry.category = 'http';
      entry.status = status; entry.elapsedMs = elapsed(); return entry;
    };
    const requestFailed = (request) => {
      if (finished || !observedRequest || request !== observedRequest) return;
      // Playwright requestfailed covers transport errors as well as aborts.
      // Do not guess an abort reason or read/retain its raw error string.
      entry.category = 'request-failed'; entry.elapsedMs = elapsed();
    };
    page.on('request', requestStarted); page.on('response', responseObserved); page.on('requestfailed', requestFailed);
    return Object.freeze({
      matchesResponse,
      responseWaitFailed(error) {
        if (!finished && error?.name === 'TimeoutError') {
          responseWaitTimedOut = true;
          if (entry) entry.responseWaitTimedOut = true;
        }
      },
      async readJson(response) {
        const entry = responseObserved(response);
        if (entry) entry.bodyOutcome = 'pending';
        try {
          const value = await response.json();
          if (entry && !finished) { entry.bodyOutcome = 'complete'; entry.elapsedMs = elapsed(); }
          return value;
        } catch (error) {
          if (entry && !finished) {
            entry.bodyOutcome = error?.name === 'TimeoutError' ? 'timeout' : 'failed'; entry.elapsedMs = elapsed();
          }
          throw error;
        }
      },
      finish() {
        if (!finished) {
          finished = true;
          page.off('request', requestStarted); page.off('response', responseObserved); page.off('requestfailed', requestFailed);
          if (entry) entry.elapsedMs = elapsed();
          else append({ category: 'no-request', status: null, bodyOutcome: 'not-read', responseWaitTimedOut, elapsedMs: elapsed() });
          observedRequest = null;
        }
        return snapshot();
      },
    });
  } });
}
