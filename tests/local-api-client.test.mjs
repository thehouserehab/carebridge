import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalApiClient, LocalApiError, collectPages, MessageDrafts, isRejectedMessageSend, LOCAL_MEDIA_CONFLICT_CODES } from '../local-api/client.js';

const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const identity = { userId: 'synthetic-user', email: 'synthetic@example.test', centers: [{ id: 'synthetic-center', role: 'guardian' }], expiresAt: '2030-01-01T00:00:00Z' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fileId = (n = 1) => `${String(n).padStart(8, '0')}-1234-4234-8234-123456789abc`;

test('only exact recovery entry endpoints omit account binding and still use the protected same-origin transport', async () => {
  const requests = [];
  const client = new LocalApiClient({ fetch: async (path, options) => { requests.push({ path, options }); return json({}); } });
  client.expectedUserId = identity.userId;
  for (const action of ['request', 'complete']) {
    const path = `/api/local/auth/password-recovery/${action}`;
    await client.request(path, { body: {} });
    const options = requests.at(-1).options;
    assert.equal(options.headers['X-Carebridge-Account'], undefined);
    assert.equal(options.headers['X-Carebridge-Request'], '1');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    await client.request(path + '?not-an-exception=1', { body: {} });
    assert.equal(requests.at(-1).options.headers['X-Carebridge-Account'], identity.userId);
  }
  assert.equal(client.expectedUserId, identity.userId);
});

test('recovery errors expose only the matching fixed code/status and never server diagnostic wording', async () => {
  for (const [status, code] of [[400, 'PASSWORD_UNCHANGED'], [400, 'PASSWORD_CONFIRMATION_MISMATCH'], [410, 'PASSWORD_RECOVERY_INVALID']]) {
    const client = new LocalApiClient({ fetch: async () => json({ error: code, message: 'PRIVATE RAW CONTENT' }, status) });
    await assert.rejects(client.request('/api/local/auth/password-recovery/complete', { body: {} }), error =>
      error instanceof LocalApiError && error.code === code && error.status === status && !error.message.includes('PRIVATE'));
  }
  for (const [status, code, expected] of [[500, 'PASSWORD_UNCHANGED', 'UNAVAILABLE'],
    [410, 'PASSWORD_UNCHANGED', 'UNAVAILABLE'], [400, 'PASSWORD_RECOVERY_INVALID', 'INVALID_INPUT']]) {
    const client = new LocalApiClient({ fetch: async () => json({ error: code }, status) });
    await assert.rejects(client.request('/api/local/auth/password-recovery/complete', { body: {} }), errorCode(expected));
  }
});

test('local API transport is same-origin/no-store, posts CSRF header and keeps only minimal identity', async () => {
  let request;
  const client = new LocalApiClient({ fetch: async (path, options) => { request = { path, options }; return json({ user: { ...identity, token: 'NEVER-USE', password: 'NEVER-USE' } }); } });
  assert.deepEqual(await client.login(identity.email, 'SYNTHETIC-ONLY-PASSWORD'), identity);
  assert.equal(request.path, '/api/local/auth/login');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['X-Carebridge-Request'], '1');
  assert.deepEqual(JSON.parse(request.options.body), { email: identity.email, password: 'SYNTHETIC-ONLY-PASSWORD' });
  assert.equal('Authorization' in request.options.headers, false);
});

test('transport validates HTTP results and never reflects raw server errors', async () => {
  for (const [status, code] of [[400, 'INVALID_INPUT'], [401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'IDEMPOTENCY_CONFLICT'], [500, 'UNAVAILABLE']]) {
    const client = new LocalApiClient({ fetch: async () => json({ message: 'PRIVATE DATABASE DETAILS', error: 'SECRET' }, status) });
    await assert.rejects(client.session(), (error) => errorCode(code)(error) && !error.message.includes('PRIVATE'));
  }
  await assert.rejects(new LocalApiClient({ fetch: async () => json({ error: 'AUTH_INVALID' }, 401) }).session(), errorCode('AUTH_INVALID'));
  await assert.rejects(new LocalApiClient({ fetch: async () => new Response('<html>not JSON</html>') }).session(), errorCode('INVALID_RESPONSE'));
  await assert.rejects(new LocalApiClient({ fetch: async () => json({ user: { ...identity, userId: '<bad>' } }) }).session(), errorCode('INVALID_RESPONSE'));
});

test('network failures and deadlines are unknown outcomes, explicit aborts are cancellation', async () => {
  await assert.rejects(new LocalApiClient({ fetch: async () => { throw new Error('PRIVATE URL'); } }).session(), errorCode('UNAVAILABLE'));
  const waitForAbort = async (_path, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('abort'));
    else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  });
  await assert.rejects(new LocalApiClient({ fetch: waitForAbort, timeoutMs: 5 }).session(), errorCode('UNAVAILABLE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new LocalApiClient({ fetch: waitForAbort }).session(controller.signal), errorCode('CANCELLED'));
  const duringBody = new AbortController();
  const client = new LocalApiClient({ fetch: async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => { duringBody.abort(); return { user: identity }; } }) });
  await assert.rejects(client.session(duringBody.signal), errorCode('CANCELLED'));
});

test('untrusted identifiers cannot turn local relative requests into other paths or hosts', async () => {
  let calls = 0; const client = new LocalApiClient({ fetch: async () => { calls++; return json({}); } });
  for (const id of ['../secret', 'https://other.test', 'a?role=admin', 'a/b', 'a%2Fb', ''])
    await assert.rejects(client.profile(id, 'room'), errorCode('INVALID_INPUT'));
  await assert.rejects(client.request('https://other.test/api/local/auth/session'), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('paginated projections restart after invalidation without merging old history', async () => {
  let attempt = 0; const calls = [];
  const result = await collectPages(async (cursor, snapshot) => {
    calls.push([cursor, snapshot]);
    if (!cursor && attempt++ === 0) return { items: ['OLD-PRIVATE'], cursor: 1, snapshot: 1, more: true };
    if (cursor) return { reset: true };
    return { items: ['CURRENT-ALLOWED'], cursor: 3, snapshot: 2, more: false };
  });
  assert.deepEqual(result, ['CURRENT-ALLOWED']);
  assert.deepEqual(calls, [[0, undefined], [1, 1], [0, undefined]]);
});

test('pagination bounds, monotonically advancing cursors and stable revisions fail closed', async () => {
  await assert.rejects(collectPages(async () => ({ reset: true })), errorCode('SNAPSHOT_CHANGED'));
  await assert.rejects(collectPages(async (cursor) => ({ items: ['a'], cursor, snapshot: 1, more: true })), errorCode('INVALID_RESPONSE'));
  await assert.rejects(collectPages(async (cursor) => ({ items: ['a'], cursor: cursor + 1, snapshot: cursor + 1, more: true })), errorCode('INVALID_RESPONSE'));
  await assert.rejects(collectPages(async (cursor) => ({ items: ['a'], cursor: cursor + 1, snapshot: 1, more: true }), { maxPages: 2 }), errorCode('TOO_MUCH_DATA'));
  assert.deepEqual(await collectPages(async () => ({ items: [], cursor: 0, snapshot: 1, more: false })), []);
});

test('client preserves exact send operation and projects only allowed request keys', async () => {
  const m = { id: 'm1', conversationId: 'r1', childId: 'c1', sequence: 1, authorId: 'u1', type: 'text', body: '가상 메시지', read: false, createdAt: '2026-10-08T00:00:00Z' };
  let sent; const client = new LocalApiClient({ fetch: async (_path, options) => { sent = JSON.parse(options.body); return json({ message: m }); } });
  const op = { clientId: 'synthetic-send-0001', body: '가상 메시지', role: 'center', userId: 'not-trusted' };
  assert.deepEqual(await client.send('center1', 'r1', op), m);
  assert.deepEqual(sent, { clientId: op.clientId, body: op.body });
  await assert.rejects(client.send('center1', 'r2', op), errorCode('INVALID_RESPONSE'));
});

test('drafts lock ambiguous operations and retry same id/body exactly once at a time', () => {
  let n = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++n}`);
  drafts.edit('room-a', ' 첫 가상 메시지 ');
  const op = drafts.begin('room-a');
  assert.equal(Object.isFrozen(op), true);
  assert.equal(drafts.begin('room-a'), null);
  assert.equal(drafts.edit('room-a', '다른 내용'), false);
  drafts.failed('room-a', op);
  assert.equal(drafts.get('room-a').uncertain, true);
  assert.equal(drafts.begin('room-a'), op);
  assert.equal(n, 1);
  drafts.accepted('room-a', op);
  assert.equal(drafts.get('room-a').body, '');
});

test('switch, suspend and logout do not leave stuck in-flight operations or revive old drafts', () => {
  const drafts = new MessageDrafts(() => 'synthetic-operation-1');
  drafts.edit('room-a', '합성 입력'); drafts.edit('room-b', '다른 방 입력');
  const op = drafts.begin('room-a'); drafts.suspend();
  assert.equal(drafts.get('room-a').sending, false);
  assert.equal(drafts.get('room-a').uncertain, true);
  assert.equal(drafts.get('room-b').body, '다른 방 입력');
  assert.equal(drafts.begin('room-a'), op);
  drafts.clear(); drafts.failed('room-a', op); drafts.accepted('room-a', op);
  assert.equal(drafts.get('room-a').body, '');
  assert.equal(drafts.get('room-b').body, '');
  assert.equal(drafts.begin('room-a'), null);
});

const scopedDraftKey = (room, user = 'synthetic-user', center = 'synthetic-center') => JSON.stringify([user, center, room]);
const emptyDraft = { body: '', operation: null, sending: false, uncertain: false };

for (const state of ['unsent', 'sending', 'unknown']) test(`a complete room list permanently removes a revoked ${state} draft before reconnect`, () => {
  let created = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++created}`);
  const a = scopedDraftKey('room-a'), b = scopedDraftKey('room-b');
  drafts.edit(a, '권한이 끝날 방의 가상 입력');
  const operation = state === 'unsent' ? null : drafts.begin(a, [{ id: fileId() }]);
  // Changing rooms suspends pending sends, but does not itself revoke access.
  drafts.suspend(); drafts.edit(b, '현재 방의 가상 입력');
  if (state === 'sending') assert.equal(drafts.begin(a), operation);
  assert.equal(drafts.retainRooms('synthetic-user', 'synthetic-center', ['room-b']), 1);
  assert.deepEqual(drafts.get(a), emptyDraft);
  assert.equal(drafts.get(b).body, '현재 방의 가상 입력');
  assert.equal(drafts.retainRooms('synthetic-user', 'synthetic-center', ['room-a', 'room-b']), 0);
  assert.deepEqual(drafts.get(a), emptyDraft); assert.equal(drafts.begin(a), null);
  if (operation) {
    drafts.failed(a, operation); drafts.accepted(a, operation); drafts.rejected(a, operation);
    assert.deepEqual(drafts.get(a), emptyDraft);
  }
});

test('authorized room pruning is scoped to the exact account and center, preserving other scopes and allowed operations', () => {
  const drafts = new MessageDrafts(() => 'synthetic-operation');
  const revoked = scopedDraftKey('room-a'), kept = scopedDraftKey('room-b');
  const otherUser = scopedDraftKey('room-a', 'synthetic-user-2'), otherCenter = scopedDraftKey('room-a', 'synthetic-user', 'synthetic-center-2');
  const nonScope = ['room-a', JSON.stringify(['synthetic-user', 'synthetic-center']), JSON.stringify(['synthetic-user', 'synthetic-center', 'room-a', 'extra'])];
  for (const key of [revoked, kept, otherUser, otherCenter, ...nonScope]) drafts.edit(key, '가상 입력');
  const operation = drafts.begin(kept, [{ id: fileId() }]); drafts.failed(kept, operation);
  const snapshots = new Map([kept, otherUser, otherCenter, ...nonScope].map(key => [key, drafts.get(key)]));
  assert.equal(drafts.retainRooms('synthetic-user', 'synthetic-center', ['room-b']), 1);
  assert.deepEqual(drafts.get(revoked), emptyDraft);
  for (const [key, snapshot] of snapshots) assert.equal(drafts.get(key), snapshot);
  assert.equal(drafts.retainRooms('synthetic-user', 'synthetic-center', []), 1);
  assert.equal(drafts.get(otherUser).body, '가상 입력'); assert.equal(drafts.get(otherCenter).body, '가상 입력');
});

test('invalid authorized room lists never partially prune drafts or invoke list accessors', () => {
  const drafts = new MessageDrafts(() => 'synthetic-operation'), key = scopedDraftKey('room-a');
  drafts.edit(key, '검증 실패에도 보존할 가상 입력'); const operation = drafts.begin(key); drafts.failed(key, operation);
  const snapshot = drafts.get(key), sparse = new Array(1); let reads = 0;
  const accessor = []; Object.defineProperty(accessor, '0', { get() { reads++; return 'room-b'; } });
  for (const rooms of [undefined, null, {}, new Set(), 'room-b', [null], [3], [''], ['bad/room'], ['x'.repeat(101)],
    ['room-b', 'room-b'], ['room-b', null], sparse, accessor]) {
    assert.throws(() => drafts.retainRooms('synthetic-user', 'synthetic-center', rooms), errorCode('INVALID_INPUT'));
    assert.equal(drafts.get(key), snapshot);
  }
  for (const bad of [undefined, null, 0, '', 'bad/id', 'x'.repeat(101)]) {
    assert.throws(() => drafts.retainRooms(bad, 'synthetic-center', []), errorCode('INVALID_INPUT'));
    assert.throws(() => drafts.retainRooms('synthetic-user', bad, []), errorCode('INVALID_INPUT'));
    assert.equal(drafts.get(key), snapshot);
  }
  assert.equal(reads, 0);
});

test('late outcomes for a revoked operation cannot revive it or alter a fresh draft after reconnect', () => {
  let created = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++created}`), key = scopedDraftKey('room-a');
  drafts.edit(key, '권한 종료 전 가상 입력'); const old = drafts.begin(key, [{ id: fileId() }]); drafts.failed(key, old);
  drafts.retainRooms('synthetic-user', 'synthetic-center', []);
  drafts.retainRooms('synthetic-user', 'synthetic-center', ['room-a']);
  drafts.edit(key, '재연결 후 직접 작성한 가상 입력'); const fresh = drafts.begin(key, [{ id: fileId(2) }]);
  const snapshot = drafts.get(key);
  drafts.failed(key, old); drafts.rejected(key, old); drafts.accepted(key, old);
  assert.equal(drafts.get(key), snapshot); assert.notEqual(fresh, old); assert.notEqual(fresh.clientId, old.clientId);
  drafts.accepted(key, fresh); assert.deepEqual(drafts.get(key), emptyDraft);
});

test('ordinary offline suspension and an unchanged complete room list preserve exact unknown requests', () => {
  const drafts = new MessageDrafts(() => 'synthetic-operation'), a = scopedDraftKey('room-a'), b = scopedDraftKey('room-b');
  drafts.edit(a, '오프라인에서도 유지할 가상 입력'); drafts.edit(b, '다른 방 미전송 입력');
  const operation = drafts.begin(a, [{ id: fileId() }]); drafts.suspend();
  assert.equal(drafts.get(a).operation, operation); assert.equal(drafts.get(a).uncertain, true);
  assert.equal(drafts.get(b).body, '다른 방 미전송 입력');
  assert.equal(drafts.retainRooms('synthetic-user', 'synthetic-center', ['room-a', 'room-b']), 0);
  assert.equal(drafts.begin(a), operation); assert.deepEqual(operation.attachments, [{ id: fileId() }]);
});

test('definitive input rejection unlocks correction without treating unknown sends as rejected', () => {
  let n = 0; const drafts = new MessageDrafts(() => `synthetic-rejected-${++n}`);
  drafts.edit('r', '잘못된 가상 입력'); const first = drafts.begin('r');
  drafts.rejected('r', first);
  assert.equal(drafts.get('r').body, '잘못된 가상 입력');
  assert.equal(drafts.get('r').rejected, true);
  assert.equal(drafts.edit('r', '고친 가상 입력'), true);
  const next = drafts.begin('r');
  assert.notEqual(next.clientId, first.clientId);
  drafts.failed('r', next);
  assert.equal(drafts.edit('r', '응답 유실 뒤 수정'), false);
});

test('every protected read and mutation is bound to the verified account, not a cross-tab cookie change', async () => {
  const seen = [];
  const client = new LocalApiClient({ fetch: async (path, options) => {
    seen.push({ path, headers: options.headers });
    return path.endsWith('/logout') ? new Response(null, { status: 204 }) : json({ user: identity });
  } });
  await client.session();
  assert.equal(seen.at(-1).headers['X-Carebridge-Account'], undefined);
  await client.session();
  assert.equal(seen.at(-1).headers['X-Carebridge-Account'], identity.userId);
  await client.request('/api/local/centers/synthetic-center/inbox');
  assert.equal(seen.at(-1).headers['X-Carebridge-Account'], identity.userId);
  await client.logout();
  assert.equal(seen.at(-1).headers['X-Carebridge-Account'], identity.userId);
  await client.login(identity.email, 'synthetic-login-only');
  assert.equal(seen.at(-1).headers['X-Carebridge-Account'], undefined);
  client.clearIdentity();
  assert.equal(client.expectedUserId, null);
});

test('a mismatched session response cannot silently adopt another account', async () => {
  let changed = false;
  const client = new LocalApiClient({ fetch: async () => json({ user: { ...identity, userId: changed ? 'other-user' : identity.userId } }) });
  await client.session(); changed = true;
  await assert.rejects(client.session(), errorCode('AUTH_REQUIRED'));
  assert.equal(client.expectedUserId, identity.userId);
});

test('attachment-only drafts capture independent frozen IDs without adding keys to text-only operations', () => {
  const drafts = new MessageDrafts(() => 'synthetic-attachment-operation');
  const selected = [{ id: fileId() }], operation = drafts.begin('files', selected);
  assert.deepEqual(operation, { clientId: 'synthetic-attachment-operation', body: '', attachments: [{ id: fileId() }] });
  assert(Object.isFrozen(operation)); assert(Object.isFrozen(operation.attachments)); assert(Object.isFrozen(operation.attachments[0]));
  assert.notEqual(operation.attachments, selected); assert.notEqual(operation.attachments[0], selected[0]);
  selected[0].id = fileId(2); selected.push({ id: fileId(3) });
  assert.deepEqual(operation.attachments, [{ id: fileId() }]);
  assert.throws(() => { operation.attachments[0].id = fileId(4); }, TypeError);
  assert.throws(() => { operation.attachments.push({ id: fileId(5) }); }, TypeError);
  drafts.edit('text', ' 그대로 보관 ');
  assert.deepEqual(drafts.begin('text', []), { clientId: 'synthetic-attachment-operation', body: ' 그대로 보관 ' });
  assert.equal(drafts.begin('empty', []), null);
});

test('draft attachment validation admits six unique UUIDs and rejects malformed selections without allocating requests', () => {
  let ids = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++ids}`);
  drafts.edit('invalid', '합성 본문');
  const inheritedId = Object.assign(Object.create({ id: fileId() }), { other: 'not an ID' });
  const invalid = [null, {}, 'file', [fileId()], [null], new Array(1), [{ id: 'not-uuid' }], [{ id: '../file' }],
    [{ id: fileId(), name: 'not ID-only' }], [inheritedId], [{ id: fileId(), [Symbol('private')]: true }],
    [{ id: fileId() }, { id: fileId() }], Array.from({ length: 7 }, (_, index) => ({ id: fileId(index + 1) }))];
  for (const selected of invalid) {
    assert.throws(() => drafts.begin('invalid', selected), errorCode('INVALID_INPUT'));
    assert.equal(drafts.get('invalid').body, '합성 본문'); assert.equal(drafts.get('invalid').operation, null);
  }
  assert.equal(ids, 0);
  const six = Array.from({ length: 6 }, (_, index) => ({ id: fileId(index + 1) }));
  assert.deepEqual(drafts.begin('six', six).attachments, six); assert.equal(ids, 1);
});

test('in-flight and unknown attachment sends ignore replacement parameters and retain the original request', () => {
  let ids = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++ids}`);
  drafts.edit('room', ' 초기 본문 '); const first = drafts.begin('room', [{ id: fileId() }]);
  assert.equal(drafts.begin('room', null), null); assert.equal(drafts.edit('room', '대체 본문'), false);
  assert.deepEqual(drafts.get('room').operation, first);
  drafts.failed('room', first); assert.equal(drafts.begin('room', [{ id: fileId(2) }]), first);
  drafts.failed('room', first); assert.equal(drafts.begin('room', null), first);
  assert.equal(ids, 1); assert.equal(first.body, ' 초기 본문 '); assert.deepEqual(first.attachments, [{ id: fileId() }]);
});

test('definitive first rejection unlocks a corrected attachment selection but retains its text draft', () => {
  let ids = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++ids}`);
  drafts.edit('room', '가상 설명'); const first = drafts.begin('room', [{ id: fileId() }]);
  drafts.rejected('room', first); assert.equal(drafts.get('room').operation, null); assert.equal(drafts.get('room').body, '가상 설명');
  const corrected = drafts.begin('room', [{ id: fileId(2) }]);
  assert.notEqual(corrected.clientId, first.clientId); assert.deepEqual(corrected.attachments, [{ id: fileId(2) }]);
  assert.equal(drafts.get('room').rejected, false); assert.deepEqual(first.attachments, [{ id: fileId() }]);
});

test('a rejected retry cannot erase a possibly committed request after transport loss or suspend', () => {
  for (const unknown of ['failed', 'suspend']) {
    let ids = 0; const drafts = new MessageDrafts(() => `synthetic-operation-${++ids}`);
    const first = drafts.begin('room', [{ id: fileId() }]);
    if (unknown === 'failed') drafts.failed('room', first); else drafts.suspend();
    assert.equal(drafts.begin('room', [{ id: fileId(2) }]), first);
    drafts.rejected('room', first);
    assert.equal(drafts.get('room').operation, first); assert.equal(drafts.get('room').uncertain, true);
    assert.equal(drafts.get('room').rejected, false); assert.equal(drafts.edit('room', '새 요청 금지'), false);
    assert.equal(drafts.begin('room', null), first); assert.equal(ids, 1);
    drafts.accepted('room', first); assert.equal(drafts.get('room').operation, null); assert.equal(drafts.get('room').body, '');
  }
});

test('attachment operations stay room-scoped and late outcomes cannot resurrect accepted or cleared drafts', () => {
  const drafts = new MessageDrafts(() => 'synthetic-operation');
  const a = drafts.begin('room-a', [{ id: fileId() }]), b = drafts.begin('room-b', [{ id: fileId(2) }]);
  drafts.rejected('room-a', b); drafts.accepted('room-a', b); assert.equal(drafts.get('room-a').operation, a);
  drafts.accepted('room-a', a); drafts.failed('room-a', a); drafts.rejected('room-a', a);
  assert.equal(drafts.get('room-a').operation, null); assert.equal(drafts.get('room-b').operation, b);
  drafts.clear(); drafts.failed('room-b', b); drafts.rejected('room-b', b); drafts.accepted('room-b', b);
  assert.equal(drafts.get('room-b').operation, null); assert.equal(drafts.begin('room-b'), null);
});

test('draft-driven attachment-only send replays the exact body and frozen IDs after an unknown HTTP outcome', async () => {
  const requests = [], drafts = new MessageDrafts(() => 'synthetic-file-retry');
  const client = new LocalApiClient({ fetch: async (_path, options) => {
    requests.push(JSON.parse(options.body)); if (requests.length === 1) throw new Error('synthetic lost response');
    return json({ message: { id: 'm1', conversationId: 'r1', childId: 'c1', sequence: 1, authorId: 'u1',
      type: 'text', body: '', read: false, createdAt: '2026-10-08T00:00:00Z' } });
  } });
  const selected = [{ id: fileId() }], first = drafts.begin('r1', selected);
  await assert.rejects(client.send('center1', 'r1', first), errorCode('UNAVAILABLE')); drafts.failed('r1', first);
  selected[0].id = fileId(2); const retry = drafts.begin('r1', selected);
  await client.send('center1', 'r1', retry); drafts.accepted('r1', retry);
  assert.deepEqual(requests, [first, first]); assert.equal(drafts.get('r1').operation, null);
});

const bindRejections = ['UPLOAD_EXPIRED', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT'];
test('message rejection classification admits only exact no-write status/code pairs, never arbitrary media failures', () => {
  for (const code of bindRejections) {
    assert.equal(isRejectedMessageSend(new LocalApiError(code, 409)), true);
    for (const status of [0, 200, 400, 401, 403, 404, 413, 500]) assert.equal(isRejectedMessageSend(new LocalApiError(code, status)), false);
  }
  for (const status of [0, 400, 413]) assert.equal(isRejectedMessageSend(new LocalApiError('INVALID_INPUT', status)), true);
  for (const status of [200, 401, 403, 404, 409, 500]) assert.equal(isRejectedMessageSend(new LocalApiError('INVALID_INPUT', status)), false);
  for (const code of [...LOCAL_MEDIA_CONFLICT_CODES.filter((code) => !bindRejections.includes(code)),
    'IDEMPOTENCY_CONFLICT', 'ATTACHMENTS_NOT_CONNECTED', 'INVALID_RESPONSE', 'UNAVAILABLE', 'CANCELLED'])
    assert.equal(isRejectedMessageSend(new LocalApiError(code, 409)), false);
  for (const error of [null, {}, { code: 'UPLOAD_EXPIRED', status: 409 }, Object.assign(new Error('PRIVATE'), { code: 'INVALID_INPUT', status: 400 })])
    assert.equal(isRejectedMessageSend(error), false);
});

test('first definitive attachment bind rejection unlocks correction while preserving selected IDs and the body', async () => {
  for (const code of bindRejections) {
    let count = 0;
    const drafts = new MessageDrafts(() => `synthetic-rejection-${++count}`), selected = [{ id: fileId() }];
    const client = new LocalApiClient({ fetch: async () => json({ error: code }, 409) });
    drafts.edit('r1', '보존할 가상 본문'); const first = drafts.begin('r1', selected);
    try { await client.send('c1', 'r1', first); assert.fail('Expected rejection'); }
    catch (error) { assert.equal(isRejectedMessageSend(error), true); drafts.rejected('r1', first); }
    assert.equal(drafts.get('r1').operation, null); assert.equal(drafts.get('r1').rejected, true);
    assert.equal(drafts.get('r1').body, '보존할 가상 본문'); assert.deepEqual(selected, [{ id: fileId() }]);
    assert.equal(drafts.edit('r1', '수정한 가상 본문'), true);
    const corrected = drafts.begin('r1', [{ id: fileId(2) }]);
    assert.notEqual(corrected.clientId, first.clientId); assert.deepEqual(corrected.attachments, [{ id: fileId(2) }]);
  }
});

test('definitive bind rejection after a lost response keeps the exact possibly committed body, attachments and request', async () => {
  for (const code of bindRejections) {
    const requests = [], drafts = new MessageDrafts(() => 'synthetic-unknown-then-rejected');
    const client = new LocalApiClient({ fetch: async (_path, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) throw new Error('synthetic response loss');
      return json({ error: code }, 409);
    } });
    drafts.edit('r1', ' 변경 금지 가상 본문 '); const first = drafts.begin('r1', [{ id: fileId() }]);
    try { await client.send('c1', 'r1', first); assert.fail('Expected unknown outcome'); }
    catch (error) { assert.equal(isRejectedMessageSend(error), false); drafts.failed('r1', first); }
    const retry = drafts.begin('r1', [{ id: fileId(2) }]); assert.equal(retry, first);
    try { await client.send('c1', 'r1', retry); assert.fail('Expected current rejection'); }
    catch (error) { assert.equal(isRejectedMessageSend(error), true); drafts.rejected('r1', retry); }
    assert.equal(drafts.get('r1').operation, first); assert.equal(drafts.get('r1').uncertain, true);
    assert.equal(drafts.get('r1').rejected, false); assert.equal(drafts.edit('r1', '덮어쓰기 금지'), false);
    assert.deepEqual(requests, [first, first]); assert.equal(drafts.begin('r1', []), first);
  }
});

test('status-zero INVALID_INPUT comes from send preflight before any HTTP request', async () => {
  let requests = 0;
  const client = new LocalApiClient({ fetch: async () => { requests++; return json({}); } });
  for (const [center, operation] of [['../not-a-center', { clientId: 'synthetic-local-reject', body: '가상 본문' }],
    ['c1', { clientId: 'synthetic-local-reject', body: '', attachments: [{ id: 'invalid-file' }] }]]) {
    await assert.rejects(client.send(center, 'r1', operation), (error) =>
      error instanceof LocalApiError && error.status === 0 && error.code === 'INVALID_INPUT' && isRejectedMessageSend(error));
  }
  assert.equal(requests, 0);
});
