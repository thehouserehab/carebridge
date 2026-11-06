// Synthetic transport doubles only: no HTTP listener, DB, browser or real names.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { SelfProfileApiClient } from '../local-api/self-profile-client.js';

const profile = (extra = {}) => ({ userId: 'synthetic-user', role: 'guardian', displayName: '가상 이름', revision: 1, updatedAt: '2026-10-10T00:00:00.000Z', ...extra });
const operation = (extra = {}) => ({ clientId: 'synthetic-command', expectedRevision: 1, displayName: '새 가상 이름', ...extra });
const receipt = (extra = {}) => ({ operation: 'member.save', userId: 'synthetic-user', childId: null, conversationId: null, appliedVersion: 2, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = value => error => error instanceof LocalApiError && error.code === value;
const deferred = () => Promise.withResolvers();
function fixture(fetch) {
  const base = new LocalApiClient({ fetch }); base.expectedUserId = 'synthetic-user';
  return { base, api: new SelfProfileApiClient(base) };
}
const get = (api, signal) => api.get('synthetic-center', signal);
const save = (api, op = operation(), signal) => api.save('synthetic-center', op, signal);

test('composition has one transport identity and stores no credential or profile snapshot', async () => {
  const { api, base } = fixture(async () => response({ profile: profile() }));
  assert.deepEqual(await get(api), profile()); assert.equal(base.expectedUserId, 'synthetic-user');
  assert.equal(api.login, undefined); assert.equal(api.expectedUserId, undefined); assert.equal(JSON.stringify(api), '{}');
  for (const transport of [null, undefined, {}, { request: 1 }]) assert.throws(() => new SelfProfileApiClient(transport), TypeError);
});

test('GET is the exact no-query protected center-scoped path', async () => {
  const calls = [], { api } = fixture(async (...args) => { calls.push(args); return response({ profile: profile() }); });
  await get(api); assert.equal(calls.length, 1);
  const [path, options] = calls[0]; assert.equal(path, '/api/local/centers/synthetic-center/account/profile');
  assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-user');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
});

test('GET projects five fields, never reads injected unknown getters and returns detached values', async () => {
  const raw = profile(); Object.defineProperty(raw, 'privateToken', { enumerable: true, get: () => assert.fail('unknown getter') });
  const base = { expectedUserId: 'synthetic-user', request: async () => ({ profile: raw }) };
  const result = await get(new SelfProfileApiClient(base)); assert.deepEqual(Object.keys(result), ['userId', 'role', 'displayName', 'revision', 'updatedAt']);
  result.displayName = 'changed locally'; assert.equal(raw.displayName, '가상 이름'); assert(!JSON.stringify(result).includes('private'));
});

test('GET permits initial null and cleared null at a later version, all current roles and MAX_SAFE revision', async () => {
  for (const value of [profile({ displayName: null, revision: 0, updatedAt: null }), profile({ displayName: null }),
    ...['center', 'therapist', 'guardian'].map(role => profile({ role, revision: Number.MAX_SAFE_INTEGER }))]) {
    const { api } = fixture(async () => response({ profile: value })); assert.deepEqual(await get(api), value);
  }
});

test('GET rejects wrong subject, role, version, missing and noncanonical metadata', async () => {
  for (const extra of [{ userId: 'other' }, { role: 'owner' }, { revision: -1 }, { revision: '1' }, { revision: Infinity },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { displayName: '' }, { displayName: ' spaced ' }, { displayName: 'a\n' },
    { displayName: '\ud800' }, { displayName: 'a'.repeat(31) }, { updatedAt: null }, { updatedAt: '2026-10-10' },
    { updatedAt: '2026-10-10T00:00:00+00:00' }, { revision: 0 }, { displayName: undefined }]) {
    const { api } = fixture(async () => response({ profile: profile(extra) })); await assert.rejects(get(api), code('INVALID_RESPONSE'));
  }
  for (const value of [null, [], {}, { profile: [] }]) {
    const { api } = fixture(async () => response(value)); await assert.rejects(get(api), code('INVALID_RESPONSE'));
  }
});

test('paths reject traversal, encoded separators, query fragments, controls and oversized IDs before transport', async () => {
  const { api } = fixture(() => assert.fail('no transport'));
  for (const center of ['', '../x', 'a/b', 'a?x=1', 'a#x', 'a%2fb', 'x\n', 'x'.repeat(101), null, 1]) {
    await assert.rejects(api.get(center), code('INVALID_INPUT')); await assert.rejects(api.save(center, operation()), code('INVALID_INPUT'));
  }
});

test('POST writes only three captured normalized fields and uses the same account/CSRF transport', async () => {
  const calls = [], { api } = fixture(async (...args) => { calls.push(args); return response({ receipt: receipt() }); });
  const raw = operation({ displayName: ' 새 가상 이름 ' }); assert.deepEqual(await save(api, raw), receipt());
  const [path, options] = calls[0]; assert.equal(path, '/api/local/centers/synthetic-center/account/profile');
  assert.equal(options.method, 'POST'); assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-user');
  assert.equal(options.headers['X-Carebridge-Request'], '1'); assert.deepEqual(JSON.parse(options.body), operation());
  assert.equal(raw.displayName, ' 새 가상 이름 ');
});

test('POST permits explicit null clearing and exact MAX_SAFE no-op without an overflowed receipt', async () => {
  for (const [op, result] of [[operation({ displayName: null }), receipt()],
    [operation({ expectedRevision: Number.MAX_SAFE_INTEGER }), receipt({ appliedVersion: Number.MAX_SAFE_INTEGER, changed: false, replayed: true })]]) {
    const { api } = fixture(async () => response({ receipt: result })); assert.deepEqual(await save(api, op), result);
  }
});

test('POST rejects extra/missing/invalid command fields and malformed raw names without transport', async () => {
  const { api } = fixture(() => assert.fail('no transport'));
  for (const extra of [{ userId: 'other' }, { role: 'center' }, { displayName: undefined }, { displayName: '' }, { displayName: '  ' },
    { displayName: 'a\n' }, { displayName: 'a\u0085' }, { displayName: '\ud800' }, { displayName: 'a'.repeat(31) },
    { clientId: 'short' }, { clientId: 'abcdefgh\n' }, { expectedRevision: -1 }, { expectedRevision: '1' }, { expectedRevision: NaN }]) {
    await assert.rejects(save(api, operation(extra)), code('INVALID_INPUT'));
  }
  const missing = operation(); delete missing.expectedRevision; await assert.rejects(save(api, missing), code('INVALID_INPUT'));
});

test('command snapshot precedes async transport and explicit retry sends unchanged bytes without automatic retry', async () => {
  const gate = deferred(), bodies = []; let count = 0;
  const { api } = fixture(async (_path, options) => { bodies.push(options.body); if (++count === 1) return gate.promise; return response({ receipt: receipt({ replayed: true }) }); });
  const op = operation(), pending = save(api, op); op.displayName = 'later mutation'; op.expectedRevision = 4;
  gate.reject(new Error('PRIVATE_RAW')); await assert.rejects(pending, code('UNAVAILABLE')); assert.equal(count, 1);
  await save(api, operation()); assert.equal(bodies[0], bodies[1]);
});

test('receipt is seven-field minimum projection with no submitted name or arbitrary private values', async () => {
  const raw = receipt(); Object.defineProperty(raw, 'displayName', { enumerable: true, get: () => assert.fail('unknown getter') });
  const api = new SelfProfileApiClient({ expectedUserId: 'synthetic-user', request: async () => ({ receipt: raw }) });
  assert.deepEqual(await save(api), receipt());
});

test('receipt rejects identity substitution, scope, operation, arithmetic and non-boolean flags', async () => {
  for (const extra of [{ operation: 'child.save' }, { userId: 'other' }, { childId: 'child' }, { conversationId: 'room' },
    { childId: undefined }, { appliedVersion: 1 }, { appliedVersion: 3 }, { appliedVersion: '2' }, { changed: 1 }, { replayed: 0 }]) {
    const { api } = fixture(async () => response({ receipt: receipt(extra) })); await assert.rejects(save(api), code('INVALID_RESPONSE'));
  }
  const { api } = fixture(async () => response({ receipt: receipt({ appliedVersion: Number.MAX_SAFE_INTEGER + 1 }) }));
  await assert.rejects(save(api, operation({ expectedRevision: Number.MAX_SAFE_INTEGER })), code('INVALID_RESPONSE'));
});

test('GET and POST reject missing or changed current identity before transport', async () => {
  for (const mode of ['get', 'save']) {
    const { api, base } = fixture(() => assert.fail('no transport')); base.expectedUserId = null;
    await assert.rejects(mode === 'get' ? get(api) : save(api), code('AUTH_REQUIRED'));
  }
});

test('GET and POST suppress successful late responses after account changes', async () => {
  for (const mode of ['get', 'save']) {
    const gate = deferred(), { api, base } = fixture(() => gate.promise);
    const pending = mode === 'get' ? get(api) : save(api); base.expectedUserId = 'other';
    gate.resolve(response(mode === 'get' ? { profile: profile() } : { receipt: receipt() }));
    await assert.rejects(pending, code('AUTH_REQUIRED'));
  }
});

test('late transport failures after account changes report fixed auth failure, not another account error', async () => {
  for (const mode of ['get', 'save']) {
    const gate = deferred(), { api, base } = fixture(() => gate.promise);
    const pending = mode === 'get' ? get(api) : save(api); base.expectedUserId = 'other'; gate.reject(new Error('PRIVATE_ERROR'));
    await assert.rejects(pending, code('AUTH_REQUIRED'));
  }
});

test('already-aborted input starts no request and pending cancellation yields no profile or receipt', async () => {
  for (const mode of ['get', 'save']) {
    const controller = new AbortController(); controller.abort();
    const f = fixture(() => assert.fail('no transport'));
    await assert.rejects(mode === 'get' ? get(f.api, controller.signal) : save(f.api, operation(), controller.signal), code('CANCELLED'));
    const gate = deferred(), active = new AbortController(), { api } = fixture(() => gate.promise);
    const pending = mode === 'get' ? get(api, active.signal) : save(api, operation(), active.signal); active.abort();
    gate.resolve(response(mode === 'get' ? { profile: profile() } : { receipt: receipt() })); await assert.rejects(pending, code('CANCELLED'));
  }
});

test('known safe conflict survives transport while raw backend errors and bodies are never exposed', async () => {
  for (const value of ['PROFILE_CONFLICT', 'REVISION_LIMIT']) {
    const { api } = fixture(async () => response({ error: value, message: 'PRIVATE_BACKEND' }, 409));
    await assert.rejects(save(api), error => code(value)(error) && !error.message.includes('PRIVATE_BACKEND'));
  }
  const api = new SelfProfileApiClient({ expectedUserId: 'synthetic-user', request: async () => { throw new Error('PRIVATE_RAW'); } });
  await assert.rejects(get(api), error => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE_RAW'));
});
