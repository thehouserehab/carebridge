// Invented identities, memory-only PGlite and an owned IPv4 loopback listener.
// No native/E database, real child data, public listener or deployment.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Records } from '../records.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localOperationsRoute, executeLocalOperations } from '../local-operations-http.mjs';

let db, auth, profiles, chat, server, origin, options, cookies, loseNextResponse;
const actors = ['manager-a', 'manager-peer', 'manager-b', 'guardian-a', 'therapist-a', 'stranger-a'];
const manager = { centerId: 'center-a', userId: 'manager-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const base = '/api/local/centers/center-a/operations';
const listPath = `${base}/children`, endpoint = `${base}/conversations/room-a/profile`;
const clinical = '/api/local/centers/center-a/conversations/room-a';
const password = 'Invented operations fixture only 2026!';
const input = (extra = {}) => ({ clientId: randomUUID(), expectedRevision: 0,
  content: { name: '가상 아이', age: 0, ageAsOf: '2020-01-01' }, ...extra });
const emptyProfile = (childId = 'child-a', conversationId = 'room-a') => ({ conversationId, childId,
  name: null, age: null, ageAsOf: null, revision: 0 });
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutationState = () => Promise.all(['cb_child_profiles', 'cb_profile_requests', 'cb_conversations'].map(raw));
const unrelatedState = () => Promise.all(['cb_child_family_plans', 'cb_messages', 'cb_message_text_revisions', 'cb_read_states',
  'cb_records', 'cb_record_revisions', 'cb_record_assessments', 'cb_record_references', 'cb_record_publications',
  'cb_goals', 'cb_appointments', 'cb_audit_events', 'cb_participants', 'cb_memberships', 'cb_member_profiles'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseNextResponse = false;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-peer',true),('manager-b',true),
      ('guardian-a',true),('therapist-a',true),('stranger-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-a','manager-peer','center',true),
      ('center-b','manager-b','center',true),('center-a','guardian-a','guardian',true),
      ('center-a','therapist-a','therapist',true),('center-a','stranger-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','therapist-a','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@operations.test`, password });
  profiles = new Children(db); chat = new Conversations(db);
  server = createServer(async (req, res) => {
    // Drop the actual HTTP acknowledgment only after domain execution reaches
    // res.end. This is a transport fault fixture, not a simulated DB receipt.
    if (loseNextResponse && req.method === 'POST' && req.url === endpoint) {
      loseNextResponse = false; res.end = () => { res.destroy(); return res; };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles, origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});

function call(path = endpoint, { cookie, method = 'GET', body, headers = {}, rawBody } = {}) {
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': cookies.get(cookie) } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: requestHeaders, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic HTTP request timed out.'))); req.end(payload);
  });
}
const post = (cookie, body, path = endpoint, headers) => call(path, { cookie, method: 'POST', body, headers });
async function login(userId = 'manager-a') {
  const result = await post(null, { email: `${userId}@operations.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result) { assert.equal(result.status, 200, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}

test('center-only list/detail expose exactly six basic fields, including unknown and zero age distinctly', async () => {
  const m = await login();
  assert.deepEqual(good(await call(endpoint, { cookie: m })), { profile: emptyProfile() });
  assert.deepEqual(good(await call(listPath, { cookie: m })), { children: [emptyProfile(), emptyProfile('child-other', 'room-other')],
    nextCursor: 'child-other', hasMore: false });
  const body = input({ content: { name: '  가상 영아  ', age: 0, ageAsOf: '2020-01-01' } });
  assert.deepEqual(good(await post(m, body)), { receipt: { operation: 'child.save', childId: 'child-a', conversationId: 'room-a',
    appliedVersion: 1, changed: true, replayed: false } });
  const saved = { ...emptyProfile(), name: '가상 영아', age: 0, ageAsOf: '2020-01-01', revision: 1 };
  assert.deepEqual(good(await call(endpoint, { cookie: m })).profile, saved);
  assert.deepEqual(good(await call(listPath, { cookie: m })).children[0], saved);
  assert.doesNotMatch(JSON.stringify(await raw('cb_profile_requests')), /가상|"name":|"age":/);
});

test('bounded child-id keyset pages keep a final nonempty cursor and reject unknown, duplicate or malformed queries', async () => {
  const m = await login();
  const first = good(await call(`${listPath}?limit=1`, { cookie: m }));
  assert.deepEqual(first, { children: [emptyProfile()], nextCursor: 'child-a', hasMore: true });
  assert.deepEqual(good(await call(`${listPath}?afterId=child-a&limit=1`, { cookie: m })), {
    children: [emptyProfile('child-other', 'room-other')], nextCursor: 'child-other', hasMore: false });
  assert.deepEqual(good(await call(`${listPath}?afterId=child-other`, { cookie: m })), { children: [], nextCursor: null, hasMore: false });
  for (const suffix of ['?limit=0', '?limit=101', '?limit=01', '?limit=1.1', '?limit=-1', '?limit=1&limit=2',
    '?afterId=', '?afterId=bad.value', '?afterId=a&afterId=b', '?after=child-a', '?childId=x', '?role=center'])
    denied(await call(listPath + suffix, { cookie: m }), 400, 'INVALID_INPUT');
  for (const suffix of ['?revision=1', '?afterId=x', '?limit=1', '?x=1&x=2']) {
    denied(await call(endpoint + suffix, { cookie: m }), 400, 'INVALID_INPUT');
    denied(await post(m, input(), endpoint + suffix), 400, 'INVALID_INPUT');
  }
});

test('explicit age/date clearing is full replacement, while no-op and retry do not bump room/profile revision', async () => {
  const m = await login(), original = input(); good(await post(m, original));
  const before = await raw('cb_conversations');
  const noOp = input({ expectedRevision: 1, content: { ...original.content, name: ` ${original.content.name} ` } });
  assert.equal(good(await post(m, noOp)).receipt.changed, false);
  assert.equal(good(await post(m, noOp)).receipt.replayed, true); assert.deepEqual(await raw('cb_conversations'), before);
  good(await post(m, input({ expectedRevision: 1, content: { name: '가상 새 이름', age: null, ageAsOf: null } })));
  assert.deepEqual(good(await call(endpoint, { cookie: m })).profile, { ...emptyProfile(), name: '가상 새 이름', revision: 2 });
});

test('lost HTTP acknowledgment replays an immutable receipt without undoing a newer profile or creating a duplicate', async () => {
  const m = await login(), original = input(); loseNextResponse = true;
  await assert.rejects(post(m, original), error => error.code === 'ECONNRESET');
  assert.equal(good(await call(endpoint, { cookie: m })).profile.revision, 1);
  good(await post(m, input({ expectedRevision: 1, content: { name: '가상 후속 이름', age: null, ageAsOf: null } })));
  const before = await mutationState();
  assert.deepEqual(good(await post(m, original)).receipt, { operation: 'child.save', childId: 'child-a', conversationId: 'room-a',
    appliedVersion: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(m, { ...original, content: { ...original.content, name: '가상 충돌' } }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(m, original, endpoint.replace('room-a', 'room-other')), 409, 'IDEMPOTENCY_CONFLICT');
});

test('two managers compare-and-swap rather than overwrite a newer child profile', async () => {
  const m = await login(), peer = await login('manager-peer');
  const results = await Promise.all([post(m, input()), post(peer, input({ content: { name: '가상 두 번째', age: null, ageAsOf: null } }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); denied(results.find(r => r.status === 409), 409, 'PROFILE_CONFLICT');
  assert.equal(good(await call(endpoint, { cookie: m })).profile.revision, 1); assert.equal((await raw('cb_profile_requests')).length, 1);
});

test('clinical roles cannot enter operations; a center cannot use clinical, family, messages or media routes', async () => {
  const m = await login();
  for (const user of ['guardian-a', 'therapist-a', 'stranger-a', 'manager-b']) {
    const cookie = await login(user);
    denied(await call(listPath, { cookie }), 404, 'NOT_FOUND'); denied(await call(endpoint, { cookie }), 404, 'NOT_FOUND');
    denied(await post(cookie, input()), 404, 'NOT_FOUND');
  }
  for (const suffix of ['/profile', '/messages', '/family-plan', '/records', '/records/record-a', '/goals', '/appointments',
    '/measurements', '/feedback/feedback-a', '/messages/message-a', '/messages/message-a/review', '/uploads/00000000-0000-4000-8000-000000000001'])
    denied(await call(clinical + suffix, { cookie: m }), 404, 'NOT_FOUND');
  denied(await call('/api/local/centers/center-a/inbox', { cookie: m }), 404, 'NOT_FOUND');
  for (const [suffix, body] of [['/messages', { clientId: randomUUID(), body: 'PRIVATE-INJECTED' }], ['/read', { messageId: 'message-a' }],
    ['/family-plan', { clientId: randomUUID(), expectedRevision: 0, concern: 'PRIVATE-INJECTED' }]])
    denied(await post(m, body, clinical + suffix), 404, 'NOT_FOUND');
  const g = await login('guardian-a'); assert.equal(good(await call(`${clinical}/profile`, { cookie: g })).childId, 'child-a');
});

test('a manager does not need clinical participation and cannot cross the center or invent a room', async () => {
  const m = await login();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_participants WHERE user_id='manager-a'")).rows[0].n, 0);
  good(await call(endpoint.replace('room-a', 'room-other'), { cookie: m }));
  good(await post(m, input(), endpoint.replace('room-a', 'room-other')));
  for (const path of [endpoint.replace('room-a', 'missing'), endpoint.replace('room-a', 'room-b'), endpoint.replace('center-a', 'center-b'), listPath.replace('center-a', 'center-b')])
    denied(await call(path, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, input(), endpoint.replace('center-a', 'center-b').replace('room-a', 'room-b')), 404, 'NOT_FOUND');
  assert.deepEqual(good(await call(listPath.replace('center-a', 'center-b'), { cookie: await login('manager-b') })), {
    children: [emptyProfile('child-b', 'room-b')], nextCursor: 'child-b', hasMore: false });
});

for (const boundary of ['membership', 'account', 'role']) test(`${boundary} removal denies new reads, saves and exact previously committed retries`, async () => {
  const m = await login(), original = input(); good(await post(m, original));
  if (boundary === 'account') await db.query("UPDATE cb_users SET active=false WHERE id='manager-a'");
  else await db.query(boundary === 'role' ? "UPDATE cb_memberships SET role='guardian' WHERE user_id='manager-a'"
    : "UPDATE cb_memberships SET active=false WHERE user_id='manager-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  denied(await call(listPath, { cookie: m }), status, code); denied(await call(endpoint, { cookie: m }), status, code);
  denied(await post(m, original), status, code); denied(await post(m, input({ expectedRevision: 1 })), status, code);
  assert.deepEqual(await mutationState(), before);
});

test('stale authenticated center identity cannot bypass the managed service transaction after a role change', async () => {
  const m = await login(); let snapshot, afterRoleChange;
  options.auth = { login: auth.login.bind(auth), logout: auth.logout.bind(auth), authenticate: async token => {
    if (!snapshot) {
      snapshot = await auth.authenticate(token);
      await db.exec(`UPDATE cb_memberships SET role='guardian' WHERE user_id='manager-a';
        INSERT INTO cb_participants VALUES ('center-a','room-a','manager-a','guardian',true,1)`);
      afterRoleChange = await mutationState();
    }
    return snapshot; // Intentional stale identity fault; services still read current DB authority.
  } };
  denied(await call(listPath, { cookie: m }), 404, 'NOT_FOUND'); denied(await call(endpoint, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, input()), 404, 'NOT_FOUND'); assert.deepEqual(await mutationState(), afterRoleChange);
  assert.equal((await profiles.get(manager, { conversationId: 'room-a' })).childId, 'child-a');
  assert.equal((await profiles.list(manager)).children.length, 1); // Existing clinical methods deliberately retain their old contract.
});

test('managed reads query no family/participant data and cannot be authorized by caller-supplied role', async () => {
  const queries = [];
  const traced = new Children({ transaction: work => db.transaction(tx => work({ query: (sql, params) => { queries.push(sql); return tx.query(sql, params); } })) });
  const detail = await traced.getManaged(manager, { conversationId: 'room-a' });
  assert.deepEqual(Object.keys(detail).sort(), ['conversationId', 'childId', 'name', 'age', 'ageAsOf', 'revision', 'updatedAt'].sort());
  await traced.listManaged(manager);
  assert.equal(queries.some(sql => sql.includes('cb_child_family_plans') || sql.includes('cb_member_profiles')), false);
  assert.equal(queries.some(sql => /SELECT m\.user_id,m\.role,p\.display_name/.test(sql)), false);
  for (const actor of [guardian, therapist, { centerId: 'center-b', userId: 'manager-a' }]) {
    await assert.rejects(traced.getManaged({ ...actor, role: 'center' }, { conversationId: 'room-a' }), e => e.code === 'NOT_FOUND');
    await assert.rejects(traced.listManaged({ ...actor, role: 'center' }), e => e.code === 'NOT_FOUND');
  }
});

test('operations do not mark read, post chat, alter relationships, or rewrite family and clinical data', async () => {
  await profiles.saveFamilyPlan(guardian, { conversationId: 'room-a', clientId: randomUUID(), expectedRevision: 0, concern: 'PRIVATE-FAMILY' });
  await chat.sendText(guardian, { conversationId: 'room-a', clientId: randomUUID(), body: 'PRIVATE-MESSAGE' });
  await new Records(db).save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-09', goalId: 'goal-a', title: '가상 기록', performed: '가상 수행', response: '가상 반응', nextPlan: '가상 계획', privateNote: 'PRIVATE-CLINICAL' } });
  const m = await login(), before = await unrelatedState();
  for (const path of [listPath, endpoint]) assert.doesNotMatch(JSON.stringify(good(await call(path, { cookie: m }))), /PRIVATE-|participants|familyPlan|updatedAt|updatedBy/);
  good(await post(m, input())); assert.deepEqual(await unrelatedState(), before);
  assert.equal(good(await call(`${clinical}/messages`, { cookie: await login('therapist-a') })).lastRead, 0);
});

test('strict full-replacement JSON and domain validation reject missing fields, coercion, dates and private field injection', async () => {
  const m = await login(), valid = input(), before = await mutationState();
  const malformed = [null, [], {}, { ...valid, clientId: undefined }, { ...valid, expectedRevision: undefined }, { ...valid, content: null },
    { ...valid, content: [] }, { ...valid, content: {} }];
  for (const key of ['name', 'age', 'ageAsOf']) malformed.push({ ...valid, content: { ...valid.content, [key]: undefined } });
  for (const name of [null, 1, false, '', ' ', '가'.repeat(31), '\ud800', 'x\n', 'x\t', 'x\0', 'x\u007f', 'x\u0085']) malformed.push({ ...valid, content: { ...valid.content, name } });
  for (const age of [-1, 27, 0.5, '0', false, null]) malformed.push({ ...valid, content: { ...valid.content, age } });
  for (const ageAsOf of [null, '', 2020, '1899-12-31', '2021-02-29', '2020-13-01', '9999-12-31', '2020-1-01']) malformed.push({ ...valid, content: { ...valid.content, ageAsOf } });
  for (const expectedRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) malformed.push({ ...valid, expectedRevision });
  for (const clientId of ['', 'short', 'underscore_id', 'x'.repeat(101)]) malformed.push({ ...valid, clientId });
  for (const key of ['childId', 'conversationId', 'role', 'userId', 'privateNote', 'familyPlan', 'participants', 'birthDate']) {
    malformed.push({ ...valid, [key]: 'PRIVATE-INJECTED' }); malformed.push({ ...valid, content: { ...valid.content, [key]: 'PRIVATE-INJECTED' } });
  }
  for (const body of malformed) denied(await post(m, body), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { cookie: m, method: 'POST', rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  const today = (await db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date::text AS today")).rows[0].today;
  good(await post(m, input({ content: { name: '가'.repeat(30), age: 26, ageAsOf: today } })));
});

test('MAX_SAFE_INTEGER allows no-op/exact retry but a changed value is a safe conflict without new receipt', async () => {
  const m = await login(), original = input(); good(await post(m, original));
  // This artificial extreme state is confined to memory fixture setup. Restore
  // the actual DB guard in the same transaction before invoking HTTP again.
  await db.transaction(async tx => {
    await tx.exec('ALTER TABLE cb_child_profiles DISABLE TRIGGER cb_child_profile_guard');
    await tx.query("UPDATE cb_child_profiles SET revision=$1 WHERE center_id='center-a' AND child_id='child-a'", [Number.MAX_SAFE_INTEGER]);
    await tx.exec('ALTER TABLE cb_child_profiles ENABLE TRIGGER cb_child_profile_guard');
  });
  const unchanged = input({ expectedRevision: Number.MAX_SAFE_INTEGER });
  assert.equal(good(await post(m, unchanged)).receipt.changed, false);
  assert.equal(good(await post(m, unchanged)).receipt.replayed, true);
  assert.equal(good(await call(endpoint, { cookie: m })).profile.revision, Number.MAX_SAFE_INTEGER);
  const before = await mutationState();
  denied(await post(m, input({ expectedRevision: Number.MAX_SAFE_INTEGER, content: { ...original.content, name: '가상 변경' } })), 409, 'REVISION_LIMIT');
  assert.deepEqual(await mutationState(), before);
});

test('only exact operations routes and methods are mounted, with no child registration/delete alias', async () => {
  const m = await login();
  for (const path of [listPath + '/', listPath + '/child-a', listPath + '/register', endpoint + '/', endpoint + '/save',
    `${base}/conversations/room-a/family-plan`, `${base}/conversations/room-a/messages`, endpoint.replace('room-a', '%72oom-a')])
    denied(await call(path, { cookie: m }), 404, 'NOT_FOUND');
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    denied(await call(endpoint, { cookie: m, method }), 404, 'NOT_FOUND'); denied(await call(listPath, { cookie: m, method }), 404, 'NOT_FOUND');
  }
  denied(await post(m, input(), listPath), 400, 'INVALID_INPUT'); // Registration requires its own explicit ID/content contract.
});

test('authenticated account binding, origin, host, CSRF and JSON protections are unchanged', async () => {
  const m = await login(), before = await mutationState();
  for (const path of [listPath, endpoint]) {
    denied(await call(path), 401, 'AUTH_REQUIRED');
    for (const account of [undefined, 'manager-peer']) denied(await call(path, { cookie: m, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:1234' }])
      denied(await call(path, { cookie: m, headers }), 403, 'SOURCE_REJECTED');
  }
  denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  for (const headers of [{ 'X-Carebridge-Account': undefined }, { 'X-Carebridge-Account': 'manager-peer' }]) denied(await post(m, input(), endpoint, headers), 401, 'AUTH_REQUIRED');
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }])
    denied(await post(m, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(m, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await mutationState(), before);
});

test('managed methods are route-local requirements and the explicit DTO never inherits internal/private additions', async () => {
  const m = await login();
  options.profiles = { get: profiles.get.bind(profiles) };
  good(await call(`${clinical}/profile`, { cookie: await login('guardian-a') }));
  denied(await call(listPath, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE'); denied(await call(endpoint, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE');
  denied(await post(m, input()), 503, 'LOCAL_API_UNAVAILABLE');
  const get = localOperationsRoute(new URL(endpoint, origin), 'GET'), list = localOperationsRoute(new URL(listPath, origin), 'GET');
  const internal = { ...emptyProfile(), updatedAt: 'PRIVATE-TIME', participants: ['PRIVATE-MEMBER'], familyPlan: 'PRIVATE-FAMILY', privateNote: 'PRIVATE-CLINICAL' };
  assert.deepEqual(await executeLocalOperations(get, manager, null, { getManaged: async () => internal }), { status: 200, body: { profile: emptyProfile() } });
  assert.deepEqual(await executeLocalOperations(list, manager, null, { listManaged: async () => ({ children: [internal], nextCursor: 'child-a', hasMore: false, privateNote: 'PRIVATE-CLINICAL' }) }),
    { status: 200, body: { children: [emptyProfile()], nextCursor: 'child-a', hasMore: false } });
  const receipt = { operation: 'child.save', childId: 'child-a', conversationId: 'room-a', appliedVersion: 1, changed: true, replayed: false };
  assert.deepEqual(await executeLocalOperations(localOperationsRoute(new URL(endpoint, origin), 'POST'), manager, input(), {
    save: async () => ({ ...receipt, userId: 'PRIVATE-ACTOR', name: 'PRIVATE-NAME', request_hash: 'PRIVATE-HASH' }),
  }), { status: 200, body: { receipt } });
});

test('receipt persistence failure returns a fixed error and rolls the child change back atomically', async () => {
  const m = await login(), before = await mutationState();
  await db.exec(`CREATE FUNCTION cb_test_operations_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-INTERNAL'; END; $$;
    CREATE TRIGGER cb_test_operations_failure BEFORE INSERT ON cb_profile_requests FOR EACH ROW EXECUTE FUNCTION cb_test_operations_failure()`);
  try { denied(await post(m, input()), 503, 'LOCAL_API_UNAVAILABLE'); assert.deepEqual(await mutationState(), before); }
  finally { await db.exec('DROP TRIGGER cb_test_operations_failure ON cb_profile_requests; DROP FUNCTION cb_test_operations_failure()'); }
});
