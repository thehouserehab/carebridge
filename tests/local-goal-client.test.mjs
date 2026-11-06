// Synthetic transport doubles only: no API listener, database or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { GoalApiClient } from '../local-api/goal-client.js';

const max = 2147483647;
const path = '/api/local/centers/synthetic-center/conversations/synthetic-room/goals/synthetic-goal';
const content = (extra = {}) => ({ title: '가상 목표', description: '함께 확인할 가상 변화', status: 'active', ...extra });
const dto = (extra = {}) => ({ id: 'synthetic-goal', conversationId: 'synthetic-room', childId: 'synthetic-child',
  revision: 1, ...content(), updatedAt: '2026-10-09T00:00:00.000Z', ...extra });
const command = (extra = {}) => ({ clientId: 'synthetic-goal-request', expectedRevision: 0, content: content(), ...extra });
const receipt = (extra = {}) => ({ kind: 'goal', id: 'synthetic-goal', revision: 1, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = (expected) => (error) => error instanceof LocalApiError && error.code === expected;
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };
function client(fetch, options = {}) {
  const base = new LocalApiClient({ fetch, ...options }); base.expectedUserId = 'synthetic-therapist';
  return { base, api: new GoalApiClient(base) };
}
const get = (api, signal) => api.goal('synthetic-center', 'synthetic-room', 'synthetic-goal', signal);
const save = (api, operation = command(), signal) => api.save('synthetic-center', 'synthetic-room', 'synthetic-goal', operation, signal);
const call = (mode, api, signal) => mode === 'get' ? get(api, signal) : save(api, command(), signal);
const payload = (mode) => mode === 'get' ? { goal: dto() } : { receipt: receipt() };

test('composition keeps one transport identity and does not create another login or credential-bearing object', async () => {
  const { api, base } = client(async () => response({ goal: dto() }));
  assert.deepEqual(await get(api), dto()); assert.equal(base.expectedUserId, 'synthetic-therapist');
  assert.equal(api.login, undefined); assert.equal(api.session, undefined); assert.equal(api.expectedUserId, undefined);
  assert.equal(JSON.stringify(api), '{}');
  for (const value of [undefined, null, {}, { request: false }]) assert.throws(() => new GoalApiClient(value), TypeError);
});

test('GET uses only the exact current goal route with the existing protected transport', async () => {
  const calls = [], { api } = client(async (...args) => { calls.push(args); return response({ goal: dto() }); });
  assert.deepEqual(await get(api), dto());
  assert.equal(calls.length, 1); const [url, options] = calls[0];
  assert.equal(url, path); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist'); assert(options.signal instanceof AbortSignal);
  assert.equal(options.headers['X-Carebridge-Request'], undefined);
});

test('current goal preserves all three states, an empty description and maximum stored revision', async () => {
  for (const status of ['active', 'achieved', 'paused']) for (const revision of [1, max]) {
    const value = dto({ status, revision, description: '' });
    assert.deepEqual(await get(client(async () => response({ goal: value })).api), value);
  }
});

test('GET returns exactly eight detached public fields without private history, notes, people or tokens', async () => {
  const source = dto({ privateNote: 'PRIVATE-NOTE', history: [{ description: 'PRIVATE-HISTORY' }], participants: ['PRIVATE-PERSON'], token: 'PRIVATE-TOKEN' });
  const { api } = client(async () => response({ goal: source, secret: 'PRIVATE-OUTER' }));
  const result = await get(api); assert.deepEqual(result, dto()); assert.equal(Object.keys(result).length, 8);
  assert(!JSON.stringify(result).includes('PRIVATE-')); source.title = '바뀐 응답'; assert.equal(result.title, '가상 목표');
  assert.equal(JSON.stringify(api), '{}');
});

test('GET rejects malformed envelopes, missing fields, wrong identities and revisions outside int32', async () => {
  for (const value of [null, [], {}, { goal: null }, { goal: [] }])
    await assert.rejects(get(client(async () => response(value)).api), code('INVALID_RESPONSE'));
  const invalid = [{ id: 'other-goal' }, { conversationId: 'other-room' }, { childId: '../child' }, { childId: '' }, { childId: 'x'.repeat(101) },
    ...[0, -1, 1.5, '1', undefined, null, NaN, Infinity, max + 1].map((revision) => ({ revision }))].map(dto);
  for (const key of Object.keys(dto())) { const value = dto(); delete value[key]; invalid.push(value); }
  for (const value of invalid) await assert.rejects(get(client(async () => response({ goal: value })).api), code('INVALID_RESPONSE'));
});

test('GET requires canonical complete text fields and a real canonical timestamp', async () => {
  const invalid = [
    ...['', ' ', ' 앞', '뒤 ', 'x'.repeat(101), '\ud800', 'a\nb', 'a\tb', 'a\0b', 'a\x7fb', 'a\x85b', null].map((title) => ({ title })),
    ...[' 앞', '뒤 ', 'x'.repeat(2001), '\udfff', 'a\0b', 'a\x7fb', 'a\x85b', null].map((description) => ({ description })),
    ...['', 'deleted', 'ACTIVE', ' active', null, 1].map((status) => ({ status })),
    ...[null, 0, '', 'yesterday', '2026-02-30T00:00:00.000Z', '2026-10-09', '2026-10-09T00:00:00Z'].map((updatedAt) => ({ updatedAt })),
  ];
  for (const extra of invalid) await assert.rejects(get(client(async () => response({ goal: dto(extra) })).api), code('INVALID_RESPONSE'));
  assert.equal((await get(client(async () => response({ goal: dto({ description: '가상\t설명\r\n둘째 줄' }) })).api)).description, '가상\t설명\r\n둘째 줄');
});

test('content synchronously normalizes only the three explicit fields without mutating caller input', () => {
  const { api } = client(async () => { throw new Error('No transport expected.'); });
  const input = content({ title: ' 가상 목표 ', description: ' 가상 설명\n다음 줄 ', status: 'paused' });
  const result = api.content(input); assert.deepEqual(result, content({ description: '가상 설명\n다음 줄', status: 'paused' }));
  assert.equal(input.title, ' 가상 목표 '); input.description = '변경'; assert.equal(result.description, '가상 설명\n다음 줄');
  assert.deepEqual(api.content(content({ description: '' })), content({ description: '' }));
});

test('content refuses missing/null/extra fields and never imports another object or defaults missing state', () => {
  const { api } = client(async () => response({}));
  const values = [null, [], {}, ...Object.keys(content()).flatMap((key) => {
    const missing = content(); delete missing[key]; return [missing, content({ [key]: null }), content({ [key]: undefined }), content({ [key]: 1 })];
  }), content({ privateNote: 'PRIVATE-NOTE' }), content({ [Symbol('private')]: 'PRIVATE-SYMBOL' })];
  for (const value of values) assert.throws(() => api.content(value), code('INVALID_INPUT'));
});

test('shared goal input validation enforces raw lengths, Unicode and exact title/description control rules', () => {
  const { api } = client(async () => response({}));
  for (const extra of [{ title: '' }, { title: ' ' }, { title: ' ' + 'a'.repeat(100) }, { description: ' ' + 'a'.repeat(2000) },
    { title: '\ud800' }, { description: '\udfff' }, ...['', 'deleted', 'ACTIVE'].map((status) => ({ status }))])
    assert.throws(() => api.content(content(extra)), code('INVALID_INPUT'));
  for (const n of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
    const text = `a${String.fromCharCode(n)}b`;
    assert.throws(() => api.content(content({ title: text })), code('INVALID_INPUT'));
    if ([9, 10, 13].includes(n)) assert.equal(api.content(content({ description: text })).description, text);
    else assert.throws(() => api.content(content({ description: text })), code('INVALID_INPUT'));
  }
  assert.equal(api.content(content({ title: 'a'.repeat(100), description: 'b'.repeat(2000) })).title.length, 100);
  assert.equal(api.content(content({ title: '😀'.repeat(50) })).title.length, 100);
});

test('unsafe route identifiers never reach either GET or POST transport', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  for (const invalid of ['', '../id', 'id?role=therapist', 'a/b', 'x'.repeat(101), null, 5]) for (const index of [0, 1, 2]) {
    const ids = ['center', 'room', 'goal']; ids[index] = invalid;
    await assert.rejects(api.goal(...ids), code('INVALID_INPUT'));
    await assert.rejects(api.save(...ids, command()), code('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('save captures a canonical minimal command before awaiting and never sends caller role or private fields', async () => {
  const gate = deferred(), calls = [], { api } = client(async (...args) => { calls.push(args); return gate.promise; });
  const input = command({ content: content({ title: ' 가상 목표 ' }), role: 'therapist', note: 'PRIVATE-NOTE' });
  const pending = save(api, input); input.content.title = '바뀐 목표'; input.expectedRevision = 20; input.clientId = 'changed-request';
  const [url, options] = calls[0]; assert.equal(url, path); assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), command()); assert(!options.body.includes('PRIVATE-'));
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist');
  assert.equal(options.headers['X-Carebridge-Request'], '1'); assert.equal(options.headers['Content-Type'], 'application/json');
  gate.resolve(response({ receipt: receipt() })); assert.deepEqual(await pending, receipt());
});

test('save rejects malformed operations before HTTP, including inherited or absent content fields', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  const invalid = [null, [], {}, ...['', 'short', 'bad_id', 'x'.repeat(101), null].map((clientId) => command({ clientId })),
    ...[-1, 0.5, '0', undefined, null, NaN, Infinity, max + 1].map((expectedRevision) => command({ expectedRevision })),
    ...[null, [], {}, Object.create(content()), content({ title: ' ' }), content({ description: null }), content({ status: null }),
      content({ privateNote: 'PRIVATE-NOTE' })].map((value) => command({ content: value }))];
  for (const value of invalid) await assert.rejects(save(api, value), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('save accepts changed/replayed and no-op receipts including the exact maximum no-op', async () => {
  for (const expectedRevision of [0, 1, max - 1, max]) for (const changed of [false, true]) for (const replayed of [false, true]) {
    if ((expectedRevision === 0 && !changed) || (expectedRevision === max && changed)) continue;
    const result = receipt({ revision: expectedRevision + Number(changed), changed, replayed });
    assert.deepEqual(await save(client(async () => response({ receipt: result })).api, command({ expectedRevision })), result);
  }
});

test('receipts require the exact goal, operation, booleans and revision arithmetic', async () => {
  for (const extra of [{ kind: 'appointment' }, { id: 'another-goal' }, { changed: false }, { changed: 1 }, { changed: undefined },
    { replayed: undefined }, { replayed: 1 }, ...[0, 2, -1, 0.5, '1', null, undefined, NaN, Infinity, max + 1].map((revision) => ({ revision }))])
    await assert.rejects(save(client(async () => response({ receipt: receipt(extra) })).api), code('INVALID_RESPONSE'));
  for (const value of [null, [], {}, { receipt: null }, { receipt: [] }])
    await assert.rejects(save(client(async () => response(value)).api), code('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ revision: 0, changed: false }) })).api), code('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ revision: max + 1 }) })).api,
    command({ expectedRevision: max })), code('INVALID_RESPONSE'));
});

test('receipts expose only five detached non-content fields and never persist goal content', async () => {
  const source = receipt({ title: 'PRIVATE-TITLE', description: 'PRIVATE-DESCRIPTION', userId: 'PRIVATE-USER', token: 'PRIVATE-TOKEN' });
  const { api } = client(async () => response({ receipt: source, secret: 'PRIVATE-OUTER' }));
  const result = await save(api); assert.deepEqual(result, receipt()); assert.equal(Object.keys(result).length, 5);
  assert(!JSON.stringify(result).includes('PRIVATE-')); source.id = 'other-goal'; assert.equal(result.id, 'synthetic-goal');
  assert.equal(JSON.stringify(api), '{}');
});

test('GET always fetches fresh current state and never claims client role grants write permission', async () => {
  let count = 0; const { api } = client(async () => response({ goal: dto({ revision: ++count }) }));
  assert.equal((await get(api)).revision, 1); assert.equal((await get(api)).revision, 2);
  const denied = client(async () => response({ error: 'FORBIDDEN' }, 403)); denied.base.expectedUserId = 'synthetic-guardian';
  await assert.rejects(save(denied.api), code('FORBIDDEN'));
});

test('response loss never retries itself; explicit same-operation retry sends identical bytes', async () => {
  const calls = [], { api } = client(async (_path, options) => {
    calls.push(options.body); if (calls.length === 1) throw new Error('PRIVATE-TRANSPORT');
    return response({ receipt: receipt({ replayed: true }) });
  });
  const operation = Object.freeze({ ...command(), content: Object.freeze(content()) });
  await assert.rejects(save(api, operation), code('UNAVAILABLE')); assert.equal(calls.length, 1);
  assert.equal((await save(api, operation)).replayed, true); assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
});

test('goal conflict and limit map to fixed safe errors without raw server text or automatic retries', async () => {
  for (const [status, serverCode, expected] of [[409, 'GOAL_CONFLICT', 'GOAL_CONFLICT'], [409, 'REVISION_LIMIT', 'REVISION_LIMIT'],
    [409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'], [409, 'PRIVATE-CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'FORBIDDEN', 'FORBIDDEN'], [404, 'NOT_FOUND', 'NOT_FOUND'],
    [400, 'INVALID_INPUT', 'INVALID_INPUT'], [413, 'PRIVATE-LENGTH', 'INVALID_INPUT'], [503, 'PRIVATE-SERVER', 'UNAVAILABLE']]) {
    let calls = 0; const { api } = client(async () => { calls++; return response({ error: serverCode, message: 'PRIVATE-DATABASE' }, status); });
    await assert.rejects(save(api), (error) => code(expected)(error) && error.status === status && !error.message.includes('PRIVATE-'));
    assert.equal(calls, 1);
  }
  assert.match(new LocalApiError('GOAL_CONFLICT').message, /최신 목표/);
});

test('missing identity and already-aborted signals block both operations before transport', async () => {
  let calls = 0; const { api, base } = client(async () => { calls++; return response({}); });
  for (const identity of [null, '', 'bad identity']) { base.expectedUserId = identity;
    for (const mode of ['get', 'save']) await assert.rejects(call(mode, api), code('AUTH_REQUIRED'));
  }
  base.expectedUserId = 'synthetic-therapist'; const abort = new AbortController(); abort.abort();
  for (const mode of ['get', 'save']) await assert.rejects(call(mode, api, abort.signal), code('CANCELLED'));
  assert.equal(calls, 0);
});

test('late account switch or cancellation suppresses data and receipts after fetch, JSON and failure', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json', 'error']) for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController();
    const { api, base } = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = call(mode, api, abort.signal); await Promise.resolve();
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-therapist';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE')); else gate.resolve(phase === 'json' ? payload(mode) : response(payload(mode)));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED'));
  }
});

test('safe fixed failures wrap malformed JSON, transport exceptions and deadlines without extra requests', async () => {
  for (const mode of ['get', 'save']) {
    let calls = 0; const { api } = client(async (_path, options) => { calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { timeoutMs: 5 });
    await assert.rejects(call(mode, api), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-')); assert.equal(calls, 1);
    const malformed = client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } })).api;
    await assert.rejects(call(mode, malformed), code('INVALID_RESPONSE'));
    const raw = new GoalApiClient({ expectedUserId: 'synthetic-therapist', request: async () => { throw new Error('PRIVATE-RAW'); } });
    await assert.rejects(call(mode, raw), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-'));
  }
});
