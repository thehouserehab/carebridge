// Synthetic transport doubles only: no server, browser, real accounts or data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareApiClient } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';

const path = '/api/local/centers/synthetic-center/conversations/synthetic-room/family-plan';
const plan = (extra = {}) => ({ conversationId: 'synthetic-room', childId: 'synthetic-child', revision: 0,
  concern: '', ...extra });
const operation = (extra = {}) => ({ clientId: 'synthetic-family-request', expectedRevision: 0, concern: '가상 가족 관심사', ...extra });
const receipt = (extra = {}) => ({ operation: 'child.concern', childId: 'synthetic-child', conversationId: 'synthetic-room',
  appliedVersion: 1, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
function client(fetch, options = {}) {
  const api = new CareApiClient({ fetch, ...options }); api.expectedUserId = 'synthetic-guardian'; return api;
}
const get = (api, signal) => api.familyPlan('synthetic-center', 'synthetic-room', signal);
const save = (api, input = operation(), signal) => api.familyPlanSave('synthetic-center', 'synthetic-room', 'synthetic-child', input, signal);
const readValue = (value) => get(client(async () => response(value)));
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };

test('GET uses the exact account-bound path with no-store cookie transport and no content query', async () => {
  const calls = [], api = client(async (...args) => { calls.push(args); return response({ familyPlan: plan() }); });
  assert.deepEqual(await get(api), plan()); assert.equal(calls.length, 1);
  const [url, options] = calls[0]; assert.equal(url, path); assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined); assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-guardian'); assert(options.signal instanceof AbortSignal);
});

test('GET permits empty concern and safe revisions including zero and the maximum', async () => {
  for (const revision of [0, 1, Number.MAX_SAFE_INTEGER]) for (const concern of ['', '가상 관심사', '가상\n둘째 줄\t😀']) {
    const value = plan({ revision, concern }); assert.deepEqual(await readValue({ familyPlan: value }), value);
  }
});

test('GET allowlist creates a detached four-field projection without retaining extra private data', async () => {
  const source = plan({ concern: '가상 관심사', updatedBy: 'PRIVATE-ACTOR', privateNote: 'PRIVATE-NOTE', token: 'PRIVATE-TOKEN' });
  const api = client(async () => response({ familyPlan: source, privateRecord: 'PRIVATE-RECORD' }));
  const value = await get(api); assert.deepEqual(value, plan({ concern: '가상 관심사' }));
  assert(!JSON.stringify(value).includes('PRIVATE-')); source.concern = 'CHANGED'; source.childId = 'changed';
  assert.equal(value.concern, '가상 관심사'); assert.equal(value.childId, 'synthetic-child');
  assert(!JSON.stringify(api).includes('가상 관심사'));
});

test('GET rejects malformed envelopes, identities and unsafe revision values', async () => {
  const values = [null, [], {}, { familyPlan: null }, { familyPlan: [] },
    ...[{ conversationId: 'other' }, { childId: '' }, { childId: '../private' }, { childId: 'a'.repeat(101) },
      ...[-1, 0.5, '0', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({ revision }))]
      .map((extra) => ({ familyPlan: plan(extra) }))];
  for (const value of values) await assert.rejects(readValue(value), errorCode('INVALID_RESPONSE'));
});

test('GET requires bounded well-formed canonical text rather than trimming server data', async () => {
  for (const concern of [null, undefined, false, 0, {}, [], ' ', '\t', ' 앞', '뒤 ', 'a'.repeat(1001), '\ud800', '\udfff',
    'a\0b', 'a\vb', 'a\x1fb', 'a\x7fb', 'a\x85b', 'a\x9fb'])
    await assert.rejects(readValue({ familyPlan: plan({ concern }) }), errorCode('INVALID_RESPONSE'));
  for (const concern of ['a'.repeat(1000), '😀'.repeat(500)]) assert.equal((await readValue({ familyPlan: plan({ concern }) })).concern, concern);
});

test('GET always fetches current context and never reuses a previous read or failed response', async () => {
  let calls = 0; const api = client(async () => {
    calls++; if (calls === 2) return response({ error: 'NOT_FOUND' }, 404);
    return response({ familyPlan: plan({ concern: `가상 관심사 ${calls}`, revision: calls }) });
  });
  assert.equal((await get(api)).revision, 1); await assert.rejects(get(api), errorCode('NOT_FOUND'));
  assert.equal((await get(api)).revision, 3); assert.equal(calls, 3);
});

test('GET and POST reject unsafe scope paths and POST requires the expected child identity before HTTP', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({}); });
  for (const [center, room] of [['../center', 'synthetic-room'], ['synthetic-center', 'room?x=1'], ['', 'synthetic-room'],
    ['synthetic-center', 'room/profile'], ['synthetic-center', 'a'.repeat(101)]]) {
    await assert.rejects(api.familyPlan(center, room), errorCode('INVALID_INPUT'));
    await assert.rejects(api.familyPlanSave(center, room, 'synthetic-child', operation()), errorCode('INVALID_INPUT'));
  }
  for (const child of [null, '', 'child/other', 'a'.repeat(101)])
    await assert.rejects(api.familyPlanSave('synthetic-center', 'synthetic-room', child, operation()), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('POST snapshots only three command fields before await and sends no caller role or child identity', async () => {
  const calls = [], gate = deferred(), api = client(async (...args) => { calls.push(args); return gate.promise; });
  const input = operation({ concern: ' \t가상 가족 관심사\r\n', childId: 'PRIVATE-CHILD', role: 'center', privateNote: 'PRIVATE-NOTE' });
  const pending = save(api, input); input.concern = 'CHANGED'; input.clientId = 'changed-request'; input.expectedRevision = 9;
  const [url, options] = calls[0]; assert.equal(url, path); assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.headers['X-Carebridge-Request'], '1');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-guardian'); assert.deepEqual(JSON.parse(options.body), operation());
  assert(!options.body.includes('PRIVATE-')); gate.resolve(response({ receipt: receipt() })); assert.deepEqual(await pending, receipt());
});

test('POST allows explicit clearing and canonicalizes whitespace without allowing oversized raw input', async () => {
  const calls = [], api = client(async (_path, options) => { calls.push(JSON.parse(options.body)); return response({ receipt: receipt() }); });
  for (const concern of ['', ' \t\r\n', '첫 줄\n\t둘째 줄 😀', 'a'.repeat(1000), '😀'.repeat(500)]) {
    await save(api, operation({ concern })); assert.equal(calls.at(-1).concern, concern.trim());
  }
  await assert.rejects(save(api, operation({ concern: ' ' + 'a'.repeat(1000) })), errorCode('INVALID_INPUT'));
  assert.equal(calls.length, 5);
});

test('POST rejects malformed commands, revision coercion and invalid Unicode or control characters before HTTP', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({}); });
  const inputs = [null, [], {}, ...['', 'short', 'has_underscore', 'a'.repeat(101), null].map((clientId) => operation({ clientId })),
    ...[-1, 0.1, '0', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => operation({ expectedRevision })),
    ...[undefined, null, false, 1, {}, [], '\ud800', '\udfff', 'a\0b', 'a\vb', 'a\x1fb', 'a\x7fb', 'a\x80b', 'a\x9fb']
      .map((concern) => operation({ concern }))];
  for (const input of inputs) await assert.rejects(save(api, input), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('POST accepts only the captured identity and changed/no-op applied version for original or replayed receipts', async () => {
  for (const expectedRevision of [0, 3, Number.MAX_SAFE_INTEGER - 1]) for (const changed of [false, true]) for (const replayed of [false, true]) {
    const result = receipt({ appliedVersion: expectedRevision + Number(changed), changed, replayed });
    assert.deepEqual(await save(client(async () => response({ receipt: result })), operation({ expectedRevision })), result);
  }
  const result = receipt({ appliedVersion: Number.MAX_SAFE_INTEGER, changed: false });
  assert.deepEqual(await save(client(async () => response({ receipt: result })), operation({ expectedRevision: Number.MAX_SAFE_INTEGER })), result);
});

test('POST rejects wrong child/room/operation, malformed flags and inconsistent or overflowing receipt versions', async () => {
  for (const extra of [{ childId: 'other' }, { conversationId: 'other' }, { operation: 'child.save' }, { appliedVersion: 0 },
    { appliedVersion: 2 }, { appliedVersion: '1' }, { appliedVersion: 0.5 }, { appliedVersion: NaN }, { appliedVersion: Infinity },
    { changed: false }, { changed: 1 }, { changed: undefined }, { replayed: 0 }, { replayed: undefined }])
    await assert.rejects(save(client(async () => response({ receipt: receipt(extra) }))), errorCode('INVALID_RESPONSE'));
  for (const value of [null, [], {}, { receipt: null }, { receipt: [] }])
    await assert.rejects(save(client(async () => response(value))), errorCode('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ appliedVersion: Number.MAX_SAFE_INTEGER + 1 }) })),
    operation({ expectedRevision: Number.MAX_SAFE_INTEGER })), errorCode('INVALID_RESPONSE'));
});

test('POST returns only six receipt fields without retaining concern, operator or private content', async () => {
  const source = receipt({ concern: 'PRIVATE-CONCERN', userId: 'PRIVATE-ACTOR', token: 'PRIVATE-TOKEN' });
  const api = client(async () => response({ receipt: source, body: 'PRIVATE-OUTER' }));
  const value = await save(api); assert.deepEqual(value, receipt()); assert(!JSON.stringify(value).includes('PRIVATE-'));
  source.childId = 'changed'; assert.equal(value.childId, 'synthetic-child'); assert(!JSON.stringify(api).includes('가상 가족 관심사'));
});

test('response loss never automatically retries and explicit retry preserves the immutable original wire command', async () => {
  const calls = [], api = client(async (_path, options) => {
    calls.push(options.body); if (calls.length === 1) throw new Error('PRIVATE-SOCKET');
    return response({ receipt: receipt({ replayed: true }) });
  });
  const input = Object.freeze(operation()); await assert.rejects(save(api, input), errorCode('UNAVAILABLE'));
  assert.equal(calls.length, 1); assert.equal((await save(api, input)).replayed, true);
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.deepEqual(input, operation());
});

test('profile conflict and revision limit retain their exact safe 409 codes and do not expose server errors', async () => {
  for (const [status, code, expected] of [[409, 'PROFILE_CONFLICT', 'PROFILE_CONFLICT'], [409, 'REVISION_LIMIT', 'REVISION_LIMIT'],
    [409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'], [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN', 'FORBIDDEN'], [404, 'NOT_FOUND', 'NOT_FOUND'], [400, 'INVALID_INPUT', 'INVALID_INPUT'],
    [413, 'PAYLOAD_TOO_LARGE', 'INVALID_INPUT'], [503, 'PRIVATE-FAILURE', 'UNAVAILABLE']]) {
    let calls = 0; const api = client(async () => { calls++; return response({ error: code, message: 'PRIVATE-PATH-CONCERN' }, status); });
    await assert.rejects(save(api), (error) => errorCode(expected)(error) && error.status === status && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
  assert.match(new LocalApiError('PROFILE_CONFLICT').message, /입력을 보존/);
  assert.match(new LocalApiError('REVISION_LIMIT').message, /한도/);
});

test('missing identity and pre-aborted requests cannot perform GET or POST', async () => {
  let calls = 0; const api = client(async () => { calls++; return response({}); });
  for (const account of [null, '', 'invalid account']) {
    api.expectedUserId = account; await assert.rejects(get(api), errorCode('AUTH_REQUIRED'));
    await assert.rejects(save(api), errorCode('AUTH_REQUIRED'));
  }
  api.expectedUserId = 'synthetic-guardian'; const abort = new AbortController(); abort.abort();
  await assert.rejects(get(api, abort.signal), errorCode('CANCELLED'));
  await assert.rejects(save(api, operation(), abort.signal), errorCode('CANCELLED')); assert.equal(calls, 0);
});

test('account changes during fetch, JSON parsing or transport failure suppress late reads and acknowledgements', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json', 'error']) {
    const gate = deferred(), api = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = mode === 'get' ? get(api) : save(api); await Promise.resolve(); api.expectedUserId = 'synthetic-other-account';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE'));
    else { const value = mode === 'get' ? { familyPlan: plan({ concern: 'PRIVATE-CONTENT' }) } : { receipt: receipt() };
      gate.resolve(phase === 'fetch' ? response(value) : value); }
    await assert.rejects(pending, errorCode('AUTH_REQUIRED'));
  }
});

test('abort during fetch or body parsing suppresses delivery even when the transport ignores cancellation', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json', 'error']) {
    const gate = deferred(), abort = new AbortController();
    const api = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = mode === 'get' ? get(api, abort.signal) : save(api, operation(), abort.signal);
    await Promise.resolve(); abort.abort();
    if (phase === 'error') gate.reject(new Error('PRIVATE-ABORT'));
    else { const value = mode === 'get' ? { familyPlan: plan() } : { receipt: receipt() };
      gate.resolve(phase === 'fetch' ? response(value) : value); }
    await assert.rejects(pending, errorCode('CANCELLED'));
  }
});

test('timeout and malformed JSON remain fixed safe errors without retaining content or retrying', async () => {
  for (const mode of ['get', 'save']) {
    let calls = 0; const api = client(async (_path, options) => {
      calls++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { timeoutMs: 5 });
    await assert.rejects(mode === 'get' ? get(api) : save(api), (error) => errorCode('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
    const malformed = client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } }));
    await assert.rejects(mode === 'get' ? get(malformed) : save(malformed), (error) => errorCode('INVALID_RESPONSE')(error) && !error.message.includes('PRIVATE'));
    assert(!JSON.stringify(api).includes('가상 가족 관심사'));
  }
});
