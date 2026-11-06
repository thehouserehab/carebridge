// Synthetic HTTP transport doubles only: no running API, database or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { OperationsApiClient } from '../local-api/operations-client.js';

const root = '/api/local/centers/synthetic-center/operations';
const detailPath = `${root}/conversations/synthetic-room/profile`;
const dto = (extra = {}) => ({ conversationId: 'synthetic-room', childId: 'synthetic-child',
  name: '가상 아이', age: 0, ageAsOf: '2024-02-29', revision: 1, ...extra });
const initial = () => dto({ name: null, age: null, ageAsOf: null, revision: 0 });
const page = (children = [], hasMore = false, nextCursor = children.at(-1)?.childId ?? null) => ({ children, hasMore, nextCursor });
const content = (extra = {}) => ({ name: '가상 아이', age: 0, ageAsOf: '2024-02-29', ...extra });
const command = (extra = {}) => ({ clientId: 'synthetic-profile-request', expectedRevision: 0, content: content(), ...extra });
const receipt = (extra = {}) => ({ operation: 'child.save', childId: 'synthetic-child', conversationId: 'synthetic-room',
  appliedVersion: 1, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = (expected) => (error) => error instanceof LocalApiError && error.code === expected;
function client(fetch, options = {}) {
  const base = new LocalApiClient({ fetch, ...options }); base.expectedUserId = 'synthetic-manager';
  return { base, api: new OperationsApiClient(base) };
}
const list = (api, signal) => api.children('synthetic-center', signal);
const get = (api, signal) => api.childProfile('synthetic-center', 'synthetic-room', signal);
const save = (api, operation = command(), signal) => api.childProfileSave('synthetic-center', 'synthetic-room', 'synthetic-child', operation, signal);
const modes = ['list', 'get', 'save'];
const call = (mode, api, signal) => mode === 'list' ? list(api, signal) : mode === 'get' ? get(api, signal) : save(api, command(), signal);
const payload = (mode) => mode === 'list' ? page([dto()]) : mode === 'get' ? { profile: dto() } : { receipt: receipt() };
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };

test('composition reuses the logged-in transport without creating another identity or a clinical API', async () => {
  const calls = [], { api, base } = client(async (...args) => { calls.push(args); return response(page([dto()])); });
  assert.deepEqual(await list(api), [dto()]);
  base.expectedUserId = 'synthetic-other-manager'; await list(api);
  assert.equal(calls[1][1].headers['X-Carebridge-Account'], 'synthetic-other-manager');
  assert.equal(api.login, undefined); assert.equal(api.messages, undefined); assert.equal(api.expectedUserId, undefined);
  assert.equal(JSON.stringify(api), '{}');
  for (const bad of [null, undefined, {}, { request: false }]) assert.throws(() => new OperationsApiClient(bad), TypeError);
});

test('list and detail use operations-only GETs with the existing cookie/account/no-store transport', async () => {
  const calls = [], { api } = client(async (...args) => { calls.push(args); return response(args[0].includes('/children?') ? page([dto()]) : { profile: dto() }); });
  assert.deepEqual(await list(api), [dto()]); assert.deepEqual(await get(api), dto());
  assert.deepEqual(calls.map(([path]) => path), [`${root}/children?limit=100`, detailPath]);
  for (const [, options] of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-manager'); assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-Carebridge-Request'], undefined);
  }
});

test('profiles preserve the initial null state, unknown age, explicit zero and safe maximum revision', async () => {
  for (const value of [initial(), dto({ age: null, ageAsOf: null }), dto(), dto({ age: 26, revision: Number.MAX_SAFE_INTEGER })]) {
    const { api } = client(async (path) => response(path.includes('/children?') ? page([value]) : { profile: value }));
    assert.deepEqual(await get(api), value); assert.deepEqual(await list(api), [value]);
  }
});

test('profile projections strip participants, family, clinical, credential and outer response fields', async () => {
  const source = dto({ participants: [{ displayName: 'PRIVATE-PERSON' }], familyPlan: { concern: 'PRIVATE-CONCERN' }, privateNote: 'PRIVATE-NOTE', token: 'PRIVATE-TOKEN' });
  const { api } = client(async (path) => response(path.includes('/children?') ? { ...page([source]), secret: 'PRIVATE-OUTER' } : { profile: source, secret: 'PRIVATE-OUTER' }));
  const values = [await get(api), ...(await list(api))];
  for (const value of values) { assert.deepEqual(value, dto()); assert(!JSON.stringify(value).includes('PRIVATE-')); }
  source.name = '변경'; assert(values.every((value) => value.name === '가상 아이')); assert.equal(JSON.stringify(api), '{}');
});

test('strict profile DTOs reject wrong identity, missing fields, unsafe revisions and impossible initial states', async () => {
  const values = [null, [], {}, ...[{ conversationId: '' }, { childId: '../child' }, { childId: 'x'.repeat(101) },
    { name: null }, { revision: 0 }, { name: null, revision: 0 },
    ...[-1, 0.5, '1', undefined, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({ revision }))].map(dto)];
  for (const key of Object.keys(dto())) { const value = dto(); delete value[key]; values.push(value); }
  for (const value of values) {
    const { api } = client(async (path) => response(path.includes('/children?') ? page([value]) : { profile: value }));
    await assert.rejects(get(api), code('INVALID_RESPONSE')); await assert.rejects(list(api), code('INVALID_RESPONSE'));
  }
  await assert.rejects(get(client(async () => response({ profile: dto({ conversationId: 'other-room' }) })).api), code('INVALID_RESPONSE'));
});

test('profile DTOs require canonical well-formed names and exact valid age/date pairs without coercion', async () => {
  for (const extra of [...['', ' ', ' 앞', '뒤 ', 'x'.repeat(31), '\ud800', '\udfff', '\n가상', '가상\t', 'a\0b', 'a\x7fb', 'a\x85b'].map((name) => ({ name })),
    ...[-1, 27, 0.5, '0', false, undefined, NaN, Infinity].map((age) => ({ age })),
    { age: null }, { ageAsOf: null }, ...['1899-12-31', '2023-02-29', '2024-02-30', '2024-2-29', '0000-01-01', '', false, undefined].map((ageAsOf) => ({ ageAsOf }))]) {
    const { api } = client(async () => response({ profile: dto(extra) })); await assert.rejects(get(api), code('INVALID_RESPONSE'));
  }
  // Read validation must not erase a server value because the client's clock is wrong.
  assert.equal((await get(client(async () => response({ profile: dto({ ageAsOf: '9999-12-31' }) })).api)).ageAsOf, '9999-12-31');
});

test('list fully gathers keyset pages, preserves database collation order and passes only last child ID', async () => {
  const pages = [page([dto({ childId: 'child_a', conversationId: 'room-a' })], true),
    page([dto({ childId: 'child-Z', conversationId: 'room-z' })], true), page([dto({ childId: 'childA', conversationId: 'room-c' })])];
  const seen = [], { api } = client(async (path) => { seen.push(path); return response(pages[seen.length - 1]); });
  assert.deepEqual((await list(api)).map((row) => row.childId), ['child_a', 'child-Z', 'childA']);
  assert.deepEqual(seen, [`${root}/children?limit=100`, `${root}/children?limit=100&afterId=child_a`, `${root}/children?limit=100&afterId=child-Z`]);
});

test('empty lists and an empty final page are allowed, but malformed/oversized pages and false progress fail', async () => {
  assert.deepEqual(await list(client(async () => response(page())).api), []);
  let n = 0; assert.deepEqual(await list(client(async () => response(++n === 1 ? page([dto()], true) : page())).api), [dto()]);
  for (const value of [null, [], {}, { ...page(), children: {} }, { ...page(), hasMore: 0 }, { ...page(), nextCursor: undefined },
    page([], true), page([], false, 'unexpected'), page([dto()], true, null), page([dto()], false, 'other'),
    page([dto()], false, '../private'), page(Array.from({ length: 101 }, (_, i) => dto({ childId: `child-${i}`, conversationId: `room-${i}` })))])
    await assert.rejects(list(client(async () => response(value)).api), code('INVALID_RESPONSE'));
});

test('duplicate children, conversations and repeated cursors never return a plausible partial collection', async () => {
  for (const second of [dto(), dto({ conversationId: 'different-room' }), dto({ childId: 'different-child' })]) {
    await assert.rejects(list(client(async () => response(page([dto(), second]))).api), code('INVALID_RESPONSE'));
    let count = 0; const { api } = client(async () => response(++count === 1 ? page([dto()], true) : page([second])));
    await assert.rejects(list(api), code('INVALID_RESPONSE')); assert.equal(count, 2);
  }
  let count = 0; const { api } = client(async () => response(++count === 1 ? page([dto()], true) : page([dto()], true)));
  await assert.rejects(list(api), code('INVALID_RESPONSE')); assert.equal(count, 2);
});

test('collection is bounded at 20 pages/2000 items, without an extra read or silent truncation', async () => {
  for (const overflowing of [false, true]) {
    let count = 0; const { api } = client(async () => {
      const rows = Array.from({ length: 100 }, (_, i) => dto({ childId: `child-${count}-${i}`, conversationId: `room-${count}-${i}` }));
      return response(page(rows, ++count < 20 || overflowing));
    });
    if (overflowing) await assert.rejects(list(api), code('TOO_MUCH_DATA')); else assert.equal((await list(api)).length, 2000);
    assert.equal(count, 20);
  }
});

test('page failure discards partial results and a later explicit read starts from the beginning', async () => {
  const paths = []; let attempt = 0;
  const { api } = client(async (path) => { paths.push(path); return response(++attempt === 1 ? page([dto()], true)
    : attempt === 2 ? { error: 'NOT_FOUND' } : page([dto({ revision: 2 })]), attempt === 2 ? 404 : 200); });
  await assert.rejects(list(api), code('NOT_FOUND')); assert.equal((await list(api))[0].revision, 2);
  assert.equal(paths[2], `${root}/children?limit=100`); assert.equal(paths.length, 3);
});

test('GETs fetch fresh values without caching, and no role hint can bypass a server denial', async () => {
  let count = 0; const { api } = client(async () => response({ profile: dto({ revision: ++count }) }));
  assert.equal((await get(api)).revision, 1); assert.equal((await get(api)).revision, 2);
  for (const mode of modes) {
    const { api, base } = client(async () => response({ error: 'NOT_FOUND' }, 404)); base.expectedUserId = 'synthetic-guardian';
    await assert.rejects(call(mode, api), code('NOT_FOUND'));
  }
});

test('all methods reject unsafe paths, and writes require a valid expected child before transport', async () => {
  let count = 0; const { api } = client(async () => { count++; return response({}); });
  for (const center of ['', '../center', 'center?role=center', 'x'.repeat(101), null]) {
    await assert.rejects(api.children(center), code('INVALID_INPUT'));
    await assert.rejects(api.childProfile(center, 'room'), code('INVALID_INPUT'));
    await assert.rejects(api.childProfileSave(center, 'room', 'child', command()), code('INVALID_INPUT'));
  }
  for (const room of ['', 'room/profile', 'room?secret=x', 'x'.repeat(101), null]) {
    await assert.rejects(api.childProfile('center', room), code('INVALID_INPUT'));
    await assert.rejects(api.childProfileSave('center', room, 'child', command()), code('INVALID_INPUT'));
  }
  for (const child of ['', '../child', null, 'x'.repeat(101)])
    await assert.rejects(api.childProfileSave('center', 'room', child, command()), code('INVALID_INPUT'));
  assert.equal(count, 0);
});

test('save snapshots a canonical three-field command and private/caller-role fields never enter the wire', async () => {
  const gate = deferred(), calls = [], { api } = client(async (...args) => { calls.push(args); return gate.promise; });
  const input = command({ content: content({ name: ' 가상 아이 ' }), role: 'center', childId: 'PRIVATE-CHILD', privateNote: 'PRIVATE-NOTE' });
  const pending = save(api, input); input.content.name = '변경'; input.content.age = 26; input.clientId = 'changed-request'; input.expectedRevision = 9;
  const [path, options] = calls[0]; assert.equal(path, detailPath); assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), command()); assert(!options.body.includes('PRIVATE-'));
  assert.equal(options.headers['X-Carebridge-Request'], '1'); assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-manager');
  gate.resolve(response({ receipt: receipt() })); assert.deepEqual(await pending, receipt());
});

test('save accepts explicit unknown age, integer zero and Seoul today while rejecting a future date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T15:00:00Z') });
  const calls = [], { api } = client(async (_path, options) => { calls.push(JSON.parse(options.body)); return response({ receipt: receipt() }); });
  for (const value of [content({ age: null, ageAsOf: null }), content({ ageAsOf: '2026-01-02' }), content({ age: 26, ageAsOf: '1900-01-01' })])
    await save(api, command({ content: value }));
  assert.equal(calls[0].content.age, null); assert.equal(calls[1].content.age, 0);
  await assert.rejects(save(api, command({ content: content({ ageAsOf: '2026-01-03' }) })), code('INVALID_INPUT'));
  assert.equal(calls.length, 3);
});

test('save rejects malformed commands, missing content keys, coerced clinical-free fields and raw oversized names', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  const values = [null, [], {}, ...['', 'short', 'bad_id', 'x'.repeat(101), null].map((clientId) => command({ clientId })),
    ...[-1, 0.1, '0', undefined, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => command({ expectedRevision }))];
  for (const value of [null, [], {}, { name: '가상 아이' }, ...Object.keys(content()).map((key) => { const c = content(); delete c[key]; return c; }),
    content({ diagnosis: 'PRIVATE-NOTE' }), content({ name: null }), content({ name: ' ' }), content({ name: ' ' + 'a'.repeat(30) }),
    ...['\ud800', 'a\0b', 'a\nb', 'a\tb', 'a\x7fb', 'a\x80b', 'a\x9fb'].map((name) => content({ name })),
    ...['0', false, -1, 27, 0.5].map((age) => content({ age })), content({ age: null }), content({ ageAsOf: null }),
    content({ ageAsOf: '2023-02-29' }), content({ ageAsOf: '1899-12-31' }), content({ ageAsOf: '9999-01-01' })]) values.push(command({ content: value }));
  for (const value of values) await assert.rejects(save(api, value), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('save accepts original/replayed changed and no-op receipts including MAX_SAFE no-op', async () => {
  for (const expectedRevision of [0, 3, Number.MAX_SAFE_INTEGER - 1]) for (const changed of [false, true]) for (const replayed of [false, true]) {
    const r = receipt({ changed, replayed, appliedVersion: expectedRevision + Number(changed) });
    assert.deepEqual(await save(client(async () => response({ receipt: r })).api, command({ expectedRevision })), r);
  }
  const r = receipt({ changed: false, appliedVersion: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(await save(client(async () => response({ receipt: r })).api, command({ expectedRevision: Number.MAX_SAFE_INTEGER })), r);
});

test('receipt validation requires exact identity, operation, booleans and arithmetically consistent safe version', async () => {
  for (const extra of [{ operation: 'child.concern' }, { childId: 'other' }, { conversationId: 'other' }, { changed: false }, { changed: 1 },
    { changed: undefined }, { replayed: undefined }, { replayed: 1 }, ...[0, 2, -1, 0.5, '1', null, undefined, NaN, Infinity].map((appliedVersion) => ({ appliedVersion }))])
    await assert.rejects(save(client(async () => response({ receipt: receipt(extra) })).api), code('INVALID_RESPONSE'));
  for (const value of [null, [], {}, { receipt: null }, { receipt: [] }])
    await assert.rejects(save(client(async () => response(value)).api), code('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ appliedVersion: Number.MAX_SAFE_INTEGER + 1 }) })).api,
    command({ expectedRevision: Number.MAX_SAFE_INTEGER })), code('INVALID_RESPONSE'));
});

test('receipt returns only six non-content fields, detached from the server object', async () => {
  const r = receipt({ name: 'PRIVATE-NAME', concern: 'PRIVATE-CONCERN', userId: 'PRIVATE-ACTOR', token: 'PRIVATE-TOKEN' });
  const { api } = client(async () => response({ receipt: r, body: 'PRIVATE-CONTENT' }));
  const value = await save(api); assert.deepEqual(value, receipt()); assert(!JSON.stringify(value).includes('PRIVATE-'));
  r.childId = 'changed'; assert.equal(value.childId, 'synthetic-child'); assert.equal(JSON.stringify(api), '{}');
});

test('unknown response loss does not retry automatically; an explicit same-operation retry sends identical bytes', async () => {
  const calls = [], { api } = client(async (_path, options) => { calls.push(options.body);
    if (calls.length === 1) throw new Error('PRIVATE-TRANSPORT'); return response({ receipt: receipt({ replayed: true }) }); });
  const operation = Object.freeze({ ...command(), content: Object.freeze(content()) });
  await assert.rejects(save(api, operation), code('UNAVAILABLE')); assert.equal(calls.length, 1);
  assert.equal((await save(api, operation)).replayed, true); assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
});

test('conflicts and all HTTP failures retain safe codes without raw errors, request content or retries', async () => {
  for (const [status, serverCode, expected] of [[409, 'PROFILE_CONFLICT', 'PROFILE_CONFLICT'], [409, 'REVISION_LIMIT', 'REVISION_LIMIT'],
    [409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'], [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'FORBIDDEN', 'FORBIDDEN'],
    [404, 'NOT_FOUND', 'NOT_FOUND'], [400, 'INVALID_INPUT', 'INVALID_INPUT'], [413, 'PRIVATE-LENGTH', 'INVALID_INPUT'], [503, 'PRIVATE-FAILURE', 'UNAVAILABLE']]) {
    let count = 0; const { api } = client(async () => { count++; return response({ error: serverCode, message: 'PRIVATE-DATABASE' }, status); });
    await assert.rejects(save(api), (error) => code(expected)(error) && error.status === status && !error.message.includes('PRIVATE-'));
    assert.equal(count, 1);
  }
});

test('missing identity and already-aborted signals prevent all operations before HTTP', async () => {
  let calls = 0; const { api, base } = client(async () => { calls++; return response({}); });
  for (const account of [null, '', 'bad account']) { base.expectedUserId = account;
    for (const mode of modes) await assert.rejects(call(mode, api), code('AUTH_REQUIRED')); }
  base.expectedUserId = 'synthetic-manager'; const abort = new AbortController(); abort.abort();
  for (const mode of modes) await assert.rejects(call(mode, api, abort.signal), code('CANCELLED'));
  assert.equal(calls, 0);
});

test('late account changes or aborts during fetch, JSON body or failure suppress all read and save results', async () => {
  for (const mode of modes) for (const phase of ['fetch', 'json', 'error']) for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController();
    const { api, base } = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = call(mode, api, abort.signal); await Promise.resolve();
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-manager';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE')); else gate.resolve(phase === 'json' ? payload(mode) : response(payload(mode)));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED'));
  }
});

test('a collection retains the original account across pages and does not leak earlier-page names after revocation', async () => {
  for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController(); let calls = 0;
    const { api, base } = client(async () => ++calls === 1 ? response(page([dto()], true)) : gate.promise);
    const pending = list(api, abort.signal);
    // Wait only for the deterministic second fetch, not a timer or external service.
    for (let i = 0; calls < 2 && i < 10; i++) await Promise.resolve(); assert.equal(calls, 2);
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-manager';
    gate.resolve(response(page([dto({ childId: 'other-child', conversationId: 'other-room' })])));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED')); assert.equal(calls, 2);
  }
});

test('timeout, malformed JSON and transport rejection are fixed errors with no cache or background retry', async () => {
  for (const mode of modes) {
    let calls = 0; const { api } = client(async (_path, options) => { calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { timeoutMs: 5 });
    await assert.rejects(call(mode, api), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-')); assert.equal(calls, 1);
    const malformed = client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } })).api;
    await assert.rejects(call(mode, malformed), code('INVALID_RESPONSE'));
    const unexpected = new OperationsApiClient({ expectedUserId: 'synthetic-manager', request: async () => { throw new Error('PRIVATE-RAW'); } });
    await assert.rejects(call(mode, unexpected), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-'));
  }
});
