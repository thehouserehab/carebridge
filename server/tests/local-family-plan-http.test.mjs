// Invented .test identities, memory-only PGlite and an owned loopback HTTP
// listener. No native/E database, external account, media bytes or deployment.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { Records } from '../records.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { executeLocalCare, localCareRoute } from '../local-care-http.mjs';

let db, auth, profiles, chat, relations, server, origin, options, cookies, loseNextResponse;
const actors = ['guardian-a', 'guardian-peer', 'therapist-a', 'manager-a', 'stranger-a', 'foreign-b'];
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a';
const endpoint = `${room}/family-plan`;
const password = 'Synthetic family-plan fixture only 2026!';
const input = (extra = {}) => ({ clientId: randomUUID(), expectedRevision: 0, concern: '가족이 바라는 가상 변화', ...extra });
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutationState = () => Promise.all(['cb_child_family_plans', 'cb_profile_requests', 'cb_conversations'].map(raw));
const clinicalState = () => Promise.all(['cb_messages', 'cb_message_text_revisions', 'cb_read_states', 'cb_records', 'cb_record_revisions',
  'cb_record_assessments', 'cb_record_references', 'cb_record_publications', 'cb_child_profiles', 'cb_goals', 'cb_appointments', 'cb_audit_events'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseNextResponse = false;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('guardian-peer',true),('therapist-a',true),
      ('manager-a',true),('stranger-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),
      ('center-a','therapist-a','therapist',true),('center-a','manager-a','center',true),
      ('center-a','stranger-a','guardian',true),('center-b','foreign-b','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','guardian-peer','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1),
      ('center-b','room-b','foreign-b','guardian',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@family-plan.test`, password });
  profiles = new Children(db); chat = new Conversations(db); relations = new Relationships(db);
  server = createServer(async (req, res) => {
    // Real lost HTTP acknowledgment, only after the domain transaction commits:
    // the handler reaches res.end but this fixture drops its owned socket.
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
const post = (cookie, body, path = endpoint, headers) => call(path, { cookie, body, headers, method: 'POST' });
async function login(userId = 'guardian-a') {
  const result = await post(null, { email: `${userId}@family-plan.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result) { assert.equal(result.status, 200, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}
async function replace(guardians) {
  const current = await relations.get(manager, { conversationId: 'room-a' });
  return relations.replace(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: current.version,
    historyConfirmed: true, therapist: { userId: 'therapist-a', history: 'preserve' }, guardians });
}

test('actual authenticated GET/POST expose only the family plan and minimal saved receipt', async () => {
  const g = await login(), t = await login('therapist-a');
  assert.deepEqual(good(await call(endpoint, { cookie: g })), { familyPlan: { conversationId: 'room-a', childId: 'child-a', revision: 0, concern: '' } });
  const body = input({ concern: '  가상 가족의 변화\n다음 줄\t선택  ' });
  assert.deepEqual(good(await post(g, body)), { receipt: { operation: 'child.concern', childId: 'child-a', conversationId: 'room-a',
    appliedVersion: 1, changed: true, replayed: false } });
  for (const cookie of [g, t]) assert.deepEqual(good(await call(endpoint, { cookie })), { familyPlan: {
    conversationId: 'room-a', childId: 'child-a', revision: 1, concern: body.concern.trim() } });
  const profile = good(await call(`${room}/profile`, { cookie: t })); assert.equal(profile.familyPlan.concern, body.concern.trim());
  assert.doesNotMatch(JSON.stringify(await raw('cb_profile_requests')), /가상|변화|"concern":/);
});

test('therapists read but cannot author; centers, unassigned users and other tenants cannot obtain a plan', async () => {
  const g = await login(); good(await post(g, input())); const before = await mutationState();
  denied(await post(await login('therapist-a'), input()), 404, 'NOT_FOUND');
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b']) {
    const cookie = await login(userId); denied(await call(endpoint, { cookie }), 404, 'NOT_FOUND'); denied(await post(cookie, input()), 404, 'NOT_FOUND');
  }
  denied(await call(endpoint.replace('room-a', 'room-other'), { cookie: g }), 404, 'NOT_FOUND');
  denied(await post(g, input(), endpoint.replace('center-a', 'center-b')), 404, 'NOT_FOUND');
  assert.deepEqual(await mutationState(), before);
});

test('future-only relationships share the current family context without access to previous messages', async () => {
  const g = await login(); good(await post(g, input()));
  const old = await chat.sendText(guardian, { conversationId: 'room-a', clientId: randomUUID(), body: 'PRIVATE-HISTORICAL-MESSAGE' });
  await replace([{ userId: 'guardian-a', history: 'preserve' }, { userId: 'stranger-a', history: 'from_now' }]);
  const newcomer = await login('stranger-a');
  assert.equal(good(await call(endpoint, { cookie: newcomer })).familyPlan.revision, 1);
  denied(await call(`${room}/messages/${old.id}`, { cookie: newcomer }), 404, 'NOT_FOUND');
  good(await post(newcomer, input({ expectedRevision: 1, concern: '새 보호자가 확인한 현재 가상 맥락' })));
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.revision, 2);
});

test('two current guardians use compare-and-swap rather than overwriting a newer family concern', async () => {
  const g = await login(), peer = await login('guardian-peer');
  const results = await Promise.all([post(g, input({ concern: '가상 선택 A' })), post(peer, input({ concern: '가상 선택 B' }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  denied(results.find(r => r.status === 409), 409, 'PROFILE_CONFLICT');
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.revision, 1);
  assert.equal((await raw('cb_profile_requests')).length, 1);
});

test('unchanged requests do not bump a revision; explicit empty and whitespace clear without retaining prior text', async () => {
  const g = await login(), empty = input({ concern: '' });
  assert.equal(good(await post(g, empty)).receipt.changed, false); assert.equal((await raw('cb_child_family_plans')).length, 0);
  const first = input(); good(await post(g, first));
  const before = await raw('cb_conversations');
  const same = good(await post(g, input({ expectedRevision: 1, concern: ` ${first.concern} ` }))).receipt;
  assert.equal(same.changed, false); assert.equal(same.appliedVersion, 1); assert.deepEqual(await raw('cb_conversations'), before);
  good(await post(g, input({ expectedRevision: 1, concern: ' \r\n\t ' })));
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.concern, '');
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.revision, 2);
  assert.equal(JSON.stringify(await raw('cb_child_family_plans')).includes(first.concern), false);
  assert.equal(JSON.stringify(await raw('cb_profile_requests')).includes(first.concern), false);
});

test('lost HTTP response replays the exact receipt without undoing a later save or adding a second write', async () => {
  const g = await login(), original = input(); loseNextResponse = true;
  await assert.rejects(post(g, original), error => error.code === 'ECONNRESET');
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.revision, 1);
  good(await post(g, input({ expectedRevision: 1, concern: '응답 유실 이후 별도로 저장한 가상 변화' })));
  const before = await mutationState();
  assert.deepEqual(good(await post(g, original)).receipt, { operation: 'child.concern', childId: 'child-a', conversationId: 'room-a',
    appliedVersion: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(g, { ...original, concern: '같은 발신 번호의 다른 가상 내용' }), 409, 'IDEMPOTENCY_CONFLICT');
});

for (const boundary of ['relationship', 'membership', 'account']) test(`${boundary} revocation blocks reads, new writes and previously committed retries`, async () => {
  const g = await login(), original = input(); good(await post(g, original));
  if (boundary === 'relationship') await replace([{ userId: 'guardian-peer', history: 'preserve' }]);
  else if (boundary === 'membership') await db.query("UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='guardian-a'");
  else await db.query("UPDATE cb_users SET active=false WHERE id='guardian-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  denied(await call(endpoint, { cookie: g }), status, code); denied(await post(g, original), status, code);
  denied(await post(g, input({ expectedRevision: 1 })), status, code); assert.deepEqual(await mutationState(), before);
});

test('family reads and writes do not mark messages read, auto-post chat, or mutate clinical/basic child data', async () => {
  const g = await login(), t = await login('therapist-a');
  await profiles.save(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedRevision: 0, content: { name: '가상 아이' } });
  await chat.sendText(therapist, { conversationId: 'room-a', clientId: randomUUID(), body: '가상 읽지 않은 소식' });
  await new Records(db).save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-09', goalId: 'goal-a', title: '가상 기록', performed: '가상 수행', response: '가상 반응', nextPlan: '가상 계획', privateNote: 'PRIVATE-CLINICAL' } });
  const before = await clinicalState();
  good(await call(endpoint, { cookie: g })); good(await post(g, input())); good(await call(endpoint, { cookie: t }));
  assert.deepEqual(await clinicalState(), before);
  assert.equal(good(await call(`${room}/messages`, { cookie: g })).lastRead, 0);
});

test('MAX_SAFE_INTEGER accepts no-op and exact retry but rejects changed data safely without a receipt', async () => {
  const g = await login(), original = input(); good(await post(g, original));
  // Bounded extreme-state fixture in this test's memory database only. The
  // normal guard correctly forbids skipping 9 quadrillion revisions; restore
  // it in the same atomic setup before any actual HTTP operation is exercised.
  await db.transaction(async tx => {
    await tx.exec('ALTER TABLE cb_child_family_plans DISABLE TRIGGER cb_family_plan_guard');
    await tx.query("UPDATE cb_child_family_plans SET revision=$1 WHERE center_id='center-a' AND child_id='child-a'", [Number.MAX_SAFE_INTEGER]);
    await tx.exec('ALTER TABLE cb_child_family_plans ENABLE TRIGGER cb_family_plan_guard');
  });
  assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgname='cb_family_plan_guard'")).rows[0].tgenabled, 'O');
  assert.equal(good(await call(endpoint, { cookie: g })).familyPlan.revision, Number.MAX_SAFE_INTEGER);
  const noOp = input({ expectedRevision: Number.MAX_SAFE_INTEGER, concern: original.concern });
  assert.equal(good(await post(g, noOp)).receipt.appliedVersion, Number.MAX_SAFE_INTEGER);
  assert.equal(good(await post(g, noOp)).receipt.replayed, true);
  const before = await mutationState();
  denied(await post(g, input({ expectedRevision: Number.MAX_SAFE_INTEGER, concern: '최댓값 이후 변경' })), 409, 'REVISION_LIMIT');
  assert.deepEqual(await mutationState(), before);
});

test('strict JSON fields reject targets, injected role/clinical fields, malformed text and unsafe versions', async () => {
  const g = await login(), valid = input(), before = await mutationState();
  const malformed = [null, [], {}, { ...valid, concern: undefined }, { ...valid, expectedRevision: undefined }, { ...valid, clientId: undefined }];
  for (const concern of [null, false, 0, {}, ['x'], '\ud800', 'x'.repeat(1001), '\0', '\u0001', '\u007f', '\u0085', '\u009f']) malformed.push({ ...valid, concern });
  for (const expectedRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) malformed.push({ ...valid, expectedRevision });
  for (const clientId of ['', 'short', 'underscore_id', 'x'.repeat(101)]) malformed.push({ ...valid, clientId });
  for (const key of ['role', 'userId', 'childId', 'conversationId', 'name', 'privateNote', 'clinical', 'attachments']) malformed.push({ ...valid, [key]: 'PRIVATE-INJECTED' });
  for (const body of malformed) denied(await post(g, body), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { cookie: g, method: 'POST', rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  good(await post(g, input({ concern: '가'.repeat(1000) })));
});

test('only exact GET/POST collection paths are mounted and no query is accepted', async () => {
  const g = await login(), before = await mutationState();
  for (const suffix of ['?revision=0', '?x=1', '?x=1&x=2', '?concern=PRIVATE-QUERY']) {
    denied(await call(endpoint + suffix, { cookie: g }), 400, 'INVALID_INPUT');
    denied(await post(g, input(), endpoint + suffix), 400, 'INVALID_INPUT');
  }
  for (const suffix of ['/child-a', '/child-a/review', '/preview', '/', '/save']) denied(await call(endpoint + suffix, { cookie: g }), 404, 'NOT_FOUND');
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) denied(await call(endpoint, { cookie: g, method }), 404, 'NOT_FOUND');
  assert.deepEqual(await mutationState(), before);
});

test('authentication, expected account, same-origin, host and JSON protections apply to both routes', async () => {
  const g = await login(), before = await mutationState();
  denied(await call(), 401, 'AUTH_REQUIRED'); denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  for (const account of [undefined, 'therapist-a']) {
    denied(await call(endpoint, { cookie: g, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    denied(await post(g, input(), endpoint, { 'X-Carebridge-Account': account }), 401, 'AUTH_REQUIRED');
  }
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:1234' }]) {
    denied(await call(endpoint, { cookie: g, headers }), 403, 'SOURCE_REJECTED');
    denied(await post(g, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  }
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }]) denied(await post(g, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(g, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await mutationState(), before);
});

test('route-local method requirements and explicit projection do not widen the profile or receipt contract', async () => {
  const get = localCareRoute(new URL(endpoint, origin), 'GET'), postRoute = localCareRoute(new URL(endpoint, origin), 'POST');
  const plan = { conversationId: 'room-a', childId: 'child-a', revision: 7, concern: '가상 최소 내용' };
  const projection = await executeLocalCare(get, guardian, null, { profiles: { get: async () => ({ ...plan, name: 'PRIVATE-NAME',
    participants: ['PRIVATE-MEMBER'], familyPlan: { ...plan, updatedAt: 'PRIVATE-TIME', privateNote: 'PRIVATE-NOTE' } }) } });
  assert.deepEqual(projection, { status: 200, body: { familyPlan: plan } });
  await assert.rejects(executeLocalCare(get, guardian, null, { profiles: { get: async () => ({ ...plan }) } }), e => e.code === 'FORBIDDEN');
  await assert.rejects(executeLocalCare(postRoute, guardian, input(), { profiles: { get() {} } }), e => e.code === 'LOCAL_API_UNAVAILABLE');
  const saved = { operation: 'child.concern', childId: 'child-a', conversationId: 'room-a', appliedVersion: 1, changed: true, replayed: false };
  let captured;
  assert.deepEqual(await executeLocalCare(postRoute, guardian, input({ clientId: 'fixed-request-01' }), {
    profiles: { saveFamilyPlan: async (actor, data) => { captured = { actor, data }; return { ...saved, userId: 'PRIVATE-ACTOR', concern: 'PRIVATE-TEXT', request_hash: 'PRIVATE-HASH' }; } },
  }), { status: 200, body: { receipt: saved } });
  assert.deepEqual(captured.actor, guardian); assert.equal(captured.data.conversationId, 'room-a');
});
