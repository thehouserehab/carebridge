// Transport doubles only. No real API, browser, database, account or clinical data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareApiClient } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';

const path = '/api/local/centers/synthetic-center/conversations/synthetic-room/messages/synthetic-message/review';
const review = (extra = {}) => ({ messageId: 'synthetic-message', conversationId: 'synthetic-room',
  revision: 2, reviewVersion: 0, reviewedRevision: null, note: '', body: '가상 원문', attachmentCount: 0, ...extra });
const operation = (extra = {}) => ({ clientId: 'synthetic-review-request', expectedRevision: 2,
  expectedReviewVersion: 0, note: '가상 반영 메모', ...extra });
const receipt = (extra = {}) => ({ messageId: 'synthetic-message', revision: 2, reviewVersion: 1, operation: 'review', replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
function client(fetch, extra = {}) {
  const api = new CareApiClient({ fetch, ...extra }); api.expectedUserId = 'synthetic-therapist'; return api;
}
const get = (api, signal) => api.textReview('synthetic-center', 'synthetic-room', 'synthetic-message', signal);
const save = (api, input = operation(), signal) => api.textReviewSave('synthetic-center', 'synthetic-room', 'synthetic-message', input, signal);
const readValue = (value) => get(client(async () => response(value)));
const deferred = () => { const value = Promise.withResolvers(); value.promise.catch(() => {}); return value; };

test('private review GET uses the exact account-bound room path and safe read transport', async () => {
  const seen = [], api = client(async (...args) => { seen.push(args); return response({ review: review() }); });
  assert.deepEqual(await get(api), review()); assert.equal(seen.length, 1); assert.equal(seen[0][0], path);
  const options = seen[0][1]; assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist'); assert(options.signal instanceof AbortSignal);
  assert(!path.includes('note='));
});

test('GET distinguishes a retained earlier-revision note from a review of the current source revision', async () => {
  for (const reviewedRevision of [1, 2]) {
    const value = review({ reviewVersion: 3, reviewedRevision, note: '가상 이전 반영' });
    assert.deepEqual(await readValue({ review: value }), value);
  }
  const maximum = review({ revision: 2147483647, reviewVersion: 2147483647, reviewedRevision: 2147483647, note: '끝 판' });
  assert.deepEqual(await readValue({ review: maximum }), maximum);
});

test('GET allowlist drops other clinical fields and creates a detached projection without client caches', async () => {
  const source = review({ reviewVersion: 1, reviewedRevision: 2, note: '가상 비공개 메모',
    attachments: [{ id: 'PRIVATE-ATTACHMENT' }], reviewerId: 'PRIVATE-REVIEWER', token: 'PRIVATE-TOKEN', privateRecord: { body: 'PRIVATE-RECORD' } });
  const api = client(async () => response({ review: source, privateNote: 'PRIVATE-OUTER' }));
  const result = await get(api);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(review()).sort()); assert(!JSON.stringify(result).includes('PRIVATE-'));
  source.note = 'CHANGED'; source.body = 'CHANGED'; assert.equal(result.note, '가상 비공개 메모'); assert.equal(result.body, '가상 원문');
  assert(!JSON.stringify(api).includes('가상 비공개 메모')); assert(!JSON.stringify(api).includes('가상 원문'));
});

test('GET rejects mismatched identity, malformed envelopes and invalid current or review versions', async () => {
  for (const value of [null, [], {}, { review: null }, { review: [] }, { review: review({ messageId: 'other' }) },
    { review: review({ conversationId: 'other' }) }, ...[0, -1, 1.2, '2', null, NaN, Infinity, 2147483648]
      .map((revision) => ({ review: review({ revision }) })),
    ...[-1, 0.2, '0', null, NaN, Infinity, 2147483648].map((reviewVersion) => ({ review: review({ reviewVersion }) }))])
    await assert.rejects(readValue(value), errorCode('INVALID_RESPONSE'));
});

test('GET no-review state is exactly zero/null/empty and existing review must identify an actual source revision', async () => {
  for (const extra of [{ note: '메모' }, { reviewedRevision: 1 }, { reviewedRevision: undefined }, { note: undefined },
    ...[null, undefined, 0, -1, 1.5, '1', 3, NaN, Infinity].map((reviewedRevision) =>
      ({ reviewVersion: 1, reviewedRevision, note: '가상 메모' })),
    { reviewVersion: 1, reviewedRevision: 1, note: '' }])
    await assert.rejects(readValue({ review: review(extra) }), errorCode('INVALID_RESPONSE'));
});

test('GET notes are bounded canonical well-formed text, never silently trimmed or repaired', async () => {
  for (const note of [null, undefined, 0, {}, ' ', ' 앞', '뒤 ', 'a'.repeat(2001), '\ud800', '\udfff',
    '가상\u0000메모', '가상\u000b메모', '가상\u001f메모', '가상\u007f메모', '가상\u0085메모'])
    await assert.rejects(readValue({ review: review({ reviewVersion: 1, reviewedRevision: 2, note }) }), errorCode('INVALID_RESPONSE'));
  const note = '첫 줄\r\n\t둘째 줄 😀';
  assert.equal((await readValue({ review: review({ reviewVersion: 1, reviewedRevision: 2, note }) })).note, note);
});

test('GET body and attachment count are minimally bounded without exposing attachment metadata', async () => {
  for (const body of [null, undefined, 7, {}, 'a'.repeat(2001), '\ud800', 'a\u0000b', 'a\u0080b'])
    await assert.rejects(readValue({ review: review({ body }) }), errorCode('INVALID_RESPONSE'));
  for (const attachmentCount of [-1, 0.5, '0', null, undefined, 7, Infinity, NaN])
    await assert.rejects(readValue({ review: review({ attachmentCount }) }), errorCode('INVALID_RESPONSE'));
  assert.deepEqual(await readValue({ review: review({ body: '', attachmentCount: 6 }) }), review({ body: '', attachmentCount: 6 }));
  assert.equal((await readValue({ review: review({ body: 'a'.repeat(2000) }) })).body.length, 2000);
});

test('POST snapshots only the command allowlist with trimmed note and account/CSRF transport', async () => {
  const seen = [], gate = deferred();
  const api = client(async (...args) => { seen.push(args); return gate.promise; });
  const input = operation({ note: '  가상 반영 메모\n', role: 'therapist', userId: 'injected', sourceBody: 'PRIVATE-SOURCE',
    attachments: [{ id: 'PRIVATE-FILE' }], privateRecord: 'PRIVATE-RECORD' });
  const pending = save(api, input); input.note = 'MUTATED'; input.clientId = 'mutated-command'; input.expectedRevision = 99;
  const [url, options] = seen[0]; assert.equal(url, path); assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.headers['X-Carebridge-Request'], '1');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist');
  assert.deepEqual(JSON.parse(options.body), operation()); assert(!options.body.includes('PRIVATE-'));
  gate.resolve(response({ receipt: receipt() })); assert.deepEqual(await pending, receipt());
});

test('POST accepts bounded Unicode and layout whitespace but enforces the original input length before trim', async () => {
  const seen = [], api = client(async (_path, options) => { seen.push(JSON.parse(options.body)); return response({ receipt: receipt() }); });
  for (const note of ['a'.repeat(2000), '😀'.repeat(1000), '\t첫 줄\r\n둘째 줄\n']) {
    await save(api, operation({ note })); assert.equal(seen.at(-1).note, note.trim());
  }
  await assert.rejects(save(api, operation({ note: ' ' + 'a'.repeat(2000) })), errorCode('INVALID_INPUT'));
  assert.equal(seen.length, 3);
});

test('POST rejects invalid raw commands before any HTTP request or secret normalization', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({ receipt: receipt() }); });
  const inputs = [null, [], {}, ...['', 'short', 'has_under_score', 'a'.repeat(101), null].map((clientId) => operation({ clientId })),
    ...[0, -1, 0.5, '2', null, NaN, Infinity, 2147483648].map((expectedRevision) => operation({ expectedRevision })),
    ...[-1, 0.5, '0', null, NaN, Infinity, 2147483647, 2147483648].map((expectedReviewVersion) => operation({ expectedReviewVersion })),
    ...[null, undefined, 1, {}, '', ' \t\n', '\ud800', '\udfff', 'a\0b', 'a\vb', 'a\x1fb', 'a\x7fb', 'a\x9fb']
      .map((note) => operation({ note }))];
  for (const input of inputs) await assert.rejects(save(api, input), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('GET and POST reject invalid scope paths before transport', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({}); });
  for (const values of [['../center', 'synthetic-room', 'synthetic-message'], ['synthetic-center', 'room?x=1', 'synthetic-message'],
    ['synthetic-center', 'synthetic-room', 'message/review'], ['synthetic-center', 'synthetic-room', ''],
    ['synthetic-center', 'synthetic-room', 'a'.repeat(101)]]) {
    await assert.rejects(api.textReview(...values), errorCode('INVALID_INPUT'));
    await assert.rejects(api.textReviewSave(...values, operation()), errorCode('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('POST accepts new or replayed receipts only for the captured source and next review version', async () => {
  for (const expectedReviewVersion of [0, 3, 2147483646]) for (const replayed of [false, true]) {
    const value = receipt({ reviewVersion: expectedReviewVersion + 1, replayed });
    const api = client(async () => response({ receipt: value }));
    assert.deepEqual(await save(api, operation({ expectedReviewVersion })), value);
  }
});

test('POST refuses mismatched, non-integer, zero or malformed acknowledgements rather than claiming success', async () => {
  for (const extra of [{ messageId: 'other' }, { revision: 1 }, { revision: '2' }, { revision: 0 },
    { reviewVersion: 0 }, { reviewVersion: 2 }, { reviewVersion: '1' }, { reviewVersion: 1.5 },
    { reviewVersion: 2147483648 }, { reviewVersion: NaN }, { reviewVersion: Infinity },
    { operation: 'save' }, { replayed: 0 }, { replayed: undefined }])
    await assert.rejects(save(client(async () => response({ receipt: receipt(extra) }))), errorCode('INVALID_RESPONSE'));
  for (const value of [null, [], {}, { receipt: null }, { receipt: [] }])
    await assert.rejects(save(client(async () => response(value))), errorCode('INVALID_RESPONSE'));
});

test('POST receipt projection never retains note, source, reviewer or attachment payloads', async () => {
  const source = receipt({ note: 'PRIVATE-NOTE', body: 'PRIVATE-SOURCE', reviewerId: 'PRIVATE-USER', attachments: [{ id: 'PRIVATE-FILE' }] });
  const api = client(async () => response({ receipt: source, note: 'PRIVATE-OUTER' }));
  const value = await save(api); assert.deepEqual(value, receipt()); assert(!JSON.stringify(value).includes('PRIVATE-'));
  source.messageId = 'changed'; assert.equal(value.messageId, 'synthetic-message');
  assert(!JSON.stringify(api).includes('가상 반영 메모'));
});

test('response loss does not retry automatically and an explicit retry sends the same captured operation', async () => {
  const calls = []; const api = client(async (_path, options) => {
    calls.push(options.body); if (calls.length === 1) throw new Error('PRIVATE-SOCKET');
    return response({ receipt: receipt({ replayed: true }) });
  });
  const input = Object.freeze(operation());
  await assert.rejects(save(api, input), (error) => errorCode('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
  assert.equal(calls.length, 1); assert.equal((await save(api, input)).replayed, true);
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.deepEqual(input, operation());
});

test('recognized rejection codes remain distinct and no private server errors or automatic retries escape', async () => {
  for (const [status, code, expected] of [[409, 'MESSAGE_CONFLICT', 'MESSAGE_CONFLICT'], [409, 'REVIEW_CONFLICT', 'REVIEW_CONFLICT'],
    [409, 'MESSAGE_DELETED', 'MESSAGE_DELETED'], [409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'FORBIDDEN', 'FORBIDDEN'], [404, 'NOT_FOUND', 'NOT_FOUND'],
    [400, 'INVALID_INPUT', 'INVALID_INPUT'], [413, 'PAYLOAD_TOO_LARGE', 'INVALID_INPUT'], [503, 'PRIVATE-FAILURE', 'UNAVAILABLE']]) {
    let calls = 0; const api = client(async () => { calls++; return response({ error: code, message: 'PRIVATE-NOTE-PATH' }, status); });
    await assert.rejects(save(api), (error) => errorCode(expected)(error) && error.status === status && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('missing account and pre-aborted request are rejected before GET or POST can leave the client', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({}); });
  for (const identity of [null, '', 'bad identity']) {
    api.expectedUserId = identity; await assert.rejects(get(api), errorCode('AUTH_REQUIRED'));
    await assert.rejects(save(api), errorCode('AUTH_REQUIRED'));
  }
  api.expectedUserId = 'synthetic-therapist'; const abort = new AbortController(); abort.abort();
  await assert.rejects(get(api, abort.signal), errorCode('CANCELLED'));
  await assert.rejects(save(api, operation(), abort.signal), errorCode('CANCELLED')); assert.equal(calls, 0);
});

test('account changes during fetch or JSON parsing reject both late private reads and write receipts', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json', 'error']) {
    const gate = deferred(), api = client(async () => phase === 'json'
      ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = mode === 'get' ? get(api) : save(api); await Promise.resolve();
    api.expectedUserId = 'synthetic-new-account';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE'));
    else {
      const value = mode === 'get' ? { review: review({ reviewVersion: 1, reviewedRevision: 2, note: 'PRIVATE-NOTE' }) } : { receipt: receipt() };
      gate.resolve(phase === 'fetch' ? response(value) : value);
    }
    await assert.rejects(pending, errorCode('AUTH_REQUIRED'));
  }
});

test('abort during fetch or body parsing prevents both read and receipt delivery even when a transport ignores it', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json']) {
    const abort = new AbortController(), gate = deferred();
    const api = client(async () => phase === 'fetch' ? gate.promise : { ...response({}), json: () => gate.promise });
    const pending = mode === 'get' ? get(api, abort.signal) : save(api, operation(), abort.signal); await Promise.resolve(); abort.abort();
    const value = mode === 'get' ? { review: review() } : { receipt: receipt() };
    gate.resolve(phase === 'fetch' ? response(value) : value); await assert.rejects(pending, errorCode('CANCELLED'));
  }
});

test('timeouts, thrown transport errors and invalid JSON fail safely without caching private payloads', async () => {
  for (const mode of ['get', 'save']) {
    const api = client(async (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true });
    }), { timeoutMs: 5 });
    await assert.rejects(mode === 'get' ? get(api) : save(api), (error) => errorCode('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
    const malformed = client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } }));
    await assert.rejects(mode === 'get' ? get(malformed) : save(malformed), (error) => errorCode('INVALID_RESPONSE')(error) && !error.message.includes('PRIVATE'));
    assert(!JSON.stringify(api).includes('가상 반영 메모')); assert(!JSON.stringify(malformed).includes('가상 원문'));
  }
});
