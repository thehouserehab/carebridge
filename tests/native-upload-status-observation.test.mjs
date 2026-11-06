import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createUploadStatusObservations, UPLOAD_STATUS_OBSERVATION_LIMIT } from './native-upload-status-observation.mjs';

// Pure event/response doubles. No browser, network, credentials, E drive or
// preparation approval is used or inferred by these observation tests.
const privateMarker = 'DO-NOT-LOG-URL-ACCOUNT-FILE-TOKEN';
const request = (path = privateMarker, method = 'GET') => ({ url: () => path, method: () => method,
  failure: () => assert.fail('must not read the raw failure message'),
  headers: () => assert.fail('must not read headers'), postData: () => assert.fail('must not read body') });
const response = (req, status = 200, json = async () => ({ private: privateMarker })) => ({ request: () => req, status: () => status, json,
  url: () => assert.fail('observer must not copy URLs'), headers: () => assert.fail('observer must not read cookies') });
const timeout = () => Object.assign(new Error(privateMarker), { name: 'TimeoutError' });
function setup() {
  let time = 0; const page = new EventEmitter(), diagnostics = createUploadStatusObservations({ now: () => time });
  const begin = () => diagnostics.begin(page, req => req.url() === privateMarker && req.method() === 'GET');
  return { page, diagnostics, begin, setTime: (value) => { time = value; } };
}
const assertSafe = (rows) => {
  assert(!JSON.stringify(rows).includes(privateMarker));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['category', 'status', 'bodyOutcome', 'responseWaitTimedOut', 'elapsedMs']);
    assert(['no-request', 'no-response', 'http', 'request-failed'].includes(row.category));
    assert(row.status === null || Number.isInteger(row.status) && row.status >= 100 && row.status <= 599);
    assert(['not-read', 'pending', 'complete', 'timeout', 'failed'].includes(row.bodyOutcome));
    assert.equal(typeof row.responseWaitTimedOut, 'boolean'); assert(Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0);
  }
};

test('status200 and completed JSON are observed without retaining response content or changing its value', async () => {
  const h = setup(), observation = h.begin(), req = request(), res = response(req);
  h.page.emit('request', req); h.setTime(11); h.page.emit('response', res);
  assert.equal(observation.matchesResponse(res), true);
  const value = await observation.readJson(res); assert.deepEqual(value, { private: privateMarker });
  h.setTime(15); const rows = observation.finish();
  assert.deepEqual(rows, [{ category: 'http', status: 200, bodyOutcome: 'complete', responseWaitTimedOut: false, elapsedMs: 15 }]);
  assertSafe(rows); assert(Object.isFrozen(rows)); assert(Object.isFrozen(rows[0]));
  assert.equal(h.page.eventNames().length, 0);
});

for (const status of [401, 403, 404, 409, 500, 503]) {
  test(`non200 status ${status} remains visible when the existing200-only wait times out`, () => {
    const h = setup(), observation = h.begin(), req = request();
    h.page.emit('request', req); h.setTime(7);
    h.page.emit('response', response(req, status, () => assert.fail('non200 body must not be inspected')));
    h.setTime(15_000); observation.responseWaitFailed(timeout());
    const rows = observation.finish(); assert.deepEqual(rows, [{ category: 'http', status, bodyOutcome: 'not-read', responseWaitTimedOut: true, elapsedMs: 15_000 }]);
    assertSafe(rows); assert.equal(h.page.eventNames().length, 0);
  });
}

test('no issued request and an issued request without response are distinct fixed outcomes', () => {
  for (const issued of [false, true]) {
    const h = setup(), observation = h.begin(); if (issued) h.page.emit('request', request());
    h.setTime(15_000); observation.responseWaitFailed(timeout());
    const rows = observation.finish(); assert.equal(rows[0].category, issued ? 'no-response' : 'no-request');
    assert.equal(rows[0].responseWaitTimedOut, true); assert.equal(rows[0].elapsedMs, 15_000); assert.equal(rows[0].status, null);
    assertSafe(rows);
  }
});

test('request abort or transport failure is recorded without inspecting or claiming its private reason', () => {
  const h = setup(), observation = h.begin(), req = request();
  h.page.emit('request', req); h.setTime(10_000); h.page.emit('requestfailed', req);
  h.setTime(15_000); observation.responseWaitFailed(timeout());
  const rows = observation.finish();
  assert.deepEqual(rows, [{ category: 'request-failed', status: null, bodyOutcome: 'not-read', responseWaitTimedOut: true, elapsedMs: 15_000 }]);
  assertSafe(rows);
});

test('only the newly issued exact request identity is observed, not prior or simultaneous workspace requests', async () => {
  const h = setup(), old = request(); h.page.emit('request', old);
  const observation = h.begin(); h.page.emit('response', response(old));
  const wrongPath = request('/workspace'), wrongMethod = request(privateMarker, 'POST');
  for (const req of [wrongPath, wrongMethod]) { h.page.emit('request', req); h.page.emit('response', response(req)); h.page.emit('requestfailed', req); }
  const current = request(), concurrentSamePath = request();
  h.page.emit('request', current); h.page.emit('request', concurrentSamePath);
  for (const req of [old, wrongPath, wrongMethod, concurrentSamePath]) assert.equal(observation.matchesResponse(response(req)), false);
  h.page.emit('response', response(concurrentSamePath, 500)); h.page.emit('requestfailed', concurrentSamePath);
  const result = response(current); h.page.emit('response', result); await observation.readJson(result);
  const rows = observation.finish(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 200); assert.equal(rows[0].bodyOutcome, 'complete');
  assertSafe(rows);
});

for (const bodyOutcome of ['timeout', 'failed']) {
  test(`status200 headers followed by ${bodyOutcome} JSON read remain distinct from no response`, async () => {
    const h = setup(), observation = h.begin(), req = request(), error = bodyOutcome === 'timeout' ? timeout() : new Error(privateMarker);
    h.page.emit('request', req); const res = response(req, 200, async () => { throw error; }); h.page.emit('response', res);
    await assert.rejects(observation.readJson(res), (received) => received === error);
    const rows = observation.finish(); assert.equal(rows[0].status, 200); assert.equal(rows[0].bodyOutcome, bodyOutcome);
    assert.equal(rows[0].responseWaitTimedOut, false); assertSafe(rows);
  });
}

test('abort after200 headers preserves both transport failure and failed body reading', async () => {
  const h = setup(), observation = h.begin(), req = request(); let reject;
  const res = response(req, 200, () => new Promise((_resolve, no) => { reject = no; }));
  h.page.emit('request', req); h.page.emit('response', res); const read = observation.readJson(res);
  h.setTime(10_000); h.page.emit('requestfailed', req); reject(new Error(privateMarker));
  await assert.rejects(read);
  const rows = observation.finish(); assert.equal(rows[0].category, 'request-failed'); assert.equal(rows[0].status, 200); assert.equal(rows[0].bodyOutcome, 'failed'); assertSafe(rows);
});

test('finish releases its listeners once, preserves pending body evidence and ignores late completion', async () => {
  const h = setup(), observation = h.begin(), req = request(); let resolve;
  h.page.emit('request', req); const res = response(req, 200, () => new Promise((yes) => { resolve = yes; }));
  h.page.emit('response', res); const read = observation.readJson(res); h.setTime(22);
  const before = observation.finish(); assert.equal(before[0].bodyOutcome, 'pending'); assert.equal(h.page.eventNames().length, 0);
  h.page.emit('requestfailed', req); observation.responseWaitFailed(timeout()); h.setTime(100);
  resolve({ private: privateMarker }); await read;
  assert.deepEqual(observation.finish(), before); assert.deepEqual(h.diagnostics.snapshot(), before); assertSafe(before);
});

test('bounded latest observations retain a terminal failure even after many successful polls', async () => {
  const h = setup();
  for (let i = 0; i < UPLOAD_STATUS_OBSERVATION_LIMIT + 10; i++) {
    h.setTime(i * 100); const observation = h.begin(), req = request(), res = response(req);
    h.page.emit('request', req); h.page.emit('response', res); await observation.readJson(res); observation.finish();
  }
  const last = h.begin(), req = request(); h.page.emit('request', req); h.page.emit('response', response(req, 503)); last.responseWaitFailed(timeout());
  const rows = last.finish(); assert.equal(rows.length, UPLOAD_STATUS_OBSERVATION_LIMIT); assert.equal(rows.at(-1).status, 503); assert(rows.at(-1).responseWaitTimedOut);
  assertSafe(rows); assert.equal(h.page.eventNames().length, 0);
});

test('elapsed time is finite and monotonic and malformed status never enters the safe result', () => {
  const h = setup(), observation = h.begin(), req = request(); h.page.emit('request', req);
  h.setTime(9); h.page.emit('response', response(req, 200));
  h.setTime(-100); h.page.emit('requestfailed', req); h.setTime(Infinity);
  assert.equal(observation.finish()[0].elapsedMs, 9);
  const other = h.begin(), next = request(); h.page.emit('request', next); h.page.emit('response', response(next, privateMarker));
  const rows = other.finish(); assert.equal(rows.at(-1).status, null); assertSafe(rows);
});

test('observer rejects invalid setup with fixed messages and does not add listeners', () => {
  assert.throws(() => createUploadStatusObservations({ now: privateMarker }), { message: 'INVALID_STATUS_OBSERVATION_OPTIONS' });
  const h = setup(); assert.throws(() => h.diagnostics.begin(h.page, privateMarker), { message: 'INVALID_STATUS_OBSERVATION_OPTIONS' });
  assert.equal(h.page.eventNames().length, 0);
});
