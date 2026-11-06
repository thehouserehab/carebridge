// Actual HTTP/Auth/domain transactions against owned in-memory PGlite only.
// All identities and clinical text are synthetic; no native/E or deployment.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { Relationships } from '../relationships.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localCareRoute, executeLocalCare } from '../local-care-http.mjs';

let db, auth, profiles, chat, goals, appointments, records, relations, server, origin, options, cookies, loseNextResponse;
const actors = ['therapist-a', 'therapist-peer', 'guardian-a', 'guardian-peer', 'manager-a', 'foreign-b'];
const therapist = { centerId: 'center-a', userId: 'therapist-a' }, guardian = { centerId: 'center-a', userId: 'guardian-a' };
const peer = { centerId: 'center-a', userId: 'therapist-peer' }, manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a', listPath = `${room}/goals`, endpoint = `${listPath}/goal-a`;
const password = 'Invented goal fixture only 2026!';
const content = (extra = {}) => ({ title: '가상 공동 목표', description: '가상 보호자와 확인한 설명', status: 'active', ...extra });
const input = (extra = {}) => ({ clientId: randomUUID(), expectedRevision: 0, content: content(), ...extra });
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutationState = () => Promise.all(['cb_goals', 'cb_goal_revisions', 'cb_context_requests', 'cb_conversations'].map(raw));
const unrelatedState = () => Promise.all(['cb_messages', 'cb_publications', 'cb_read_states', 'cb_records', 'cb_record_revisions',
  'cb_record_assessments', 'cb_record_references', 'cb_record_attachments', 'cb_record_publications', 'cb_publication_attachments',
  'cb_child_profiles', 'cb_child_family_plans', 'cb_appointments', 'cb_appointment_revisions', 'cb_participants', 'cb_audit_events'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseNextResponse = false;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('therapist-peer',true),('guardian-a',true),
      ('guardian-peer',true),('manager-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','therapist-peer','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),
      ('center-a','manager-a','center',true),('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-other','therapist-a','therapist',true,1),
      ('center-b','room-b','foreign-b','therapist',true,1)`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@goals.test`, password });
  profiles = new Children(db); chat = new Conversations(db); goals = new Goals(db); appointments = new Appointments(db);
  records = new Records(db); relations = new Relationships(db);
  server = createServer(async (req, res) => {
    // Transport-only lost acknowledgment after the real domain transaction
    // reaches res.end. No fake commit or receipt is injected.
    if (loseNextResponse && req.method === 'POST' && req.url === endpoint) {
      loseNextResponse = false; res.end = () => { res.destroy(); return res; };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles, goals, appointments, records, origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
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
async function login(userId = 'therapist-a') {
  const result = await post(null, { email: `${userId}@goals.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}
async function replace(therapistId, guardians = [{ userId: 'guardian-a', history: 'preserve' }]) {
  const current = await relations.get(manager, { conversationId: 'room-a' });
  await relations.replace(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: current.version,
    historyConfirmed: true, therapist: { userId: therapistId, history: 'from_now' }, guardians });
}

test('actual therapist create and current team detail expose eight goal fields and a five-field receipt', async () => {
  const t = await login(), g = await login('guardian-a'); denied(await call(endpoint, { cookie: t }), 404, 'NOT_FOUND');
  assert.deepEqual(good(await call(listPath, { cookie: t })).goals, []);
  const body = input({ content: content({ title: ' 가상 목표 ', description: ' 가상 설명\n다음\t줄\r\n ' }) });
  assert.deepEqual(good(await post(t, body)), { receipt: { kind: 'goal', id: 'goal-a', revision: 1, changed: true, replayed: false } });
  const detail = good(await call(endpoint, { cookie: t })).goal;
  assert.deepEqual(Object.keys(detail).sort(), ['id', 'conversationId', 'childId', 'revision', 'title', 'description', 'status', 'updatedAt'].sort());
  assert.deepEqual(detail, { id: 'goal-a', conversationId: 'room-a', childId: 'child-a', revision: 1,
    title: '가상 목표', description: '가상 설명\n다음\t줄', status: 'active', updatedAt: detail.updatedAt });
  assert.equal(Number.isFinite(Date.parse(detail.updatedAt)), true);
  assert.deepEqual(good(await call(endpoint, { cookie: g })), { goal: detail });
  assert.deepEqual(good(await call(listPath, { cookie: g })).goals, [detail]);
  assert.doesNotMatch(JSON.stringify(await raw('cb_context_requests')), /가상|"title":|"description":/);
});

test('status changes append history; no-op and exact retry preserve versions and changed counters', async () => {
  const t = await login(); good(await post(t, input()));
  let revision = 1;
  for (const status of ['achieved', 'paused', 'active']) {
    const before = good(await call(endpoint, { cookie: t })).goal;
    good(await post(t, input({ expectedRevision: revision, content: content({ status }) })));
    assert.deepEqual(await goals.get(therapist, { conversationId: 'room-a', goalId: 'goal-a', revision }), before);
    revision++;
  }
  const noOp = input({ expectedRevision: revision, content: content({ title: ' 가상 공동 목표 ', description: ' 가상 보호자와 확인한 설명 ' }) });
  const before = await mutationState();
  assert.deepEqual(good(await post(t, noOp)).receipt, { kind: 'goal', id: 'goal-a', revision, changed: false, replayed: false });
  assert.equal(good(await post(t, noOp)).receipt.replayed, true);
  const afterState = await mutationState(); assert.deepEqual(afterState[0], before[0]); assert.deepEqual(afterState[1], before[1]); assert.deepEqual(afterState[3], before[3]);
  assert.equal(afterState[2].length, before[2].length + 1);
  good(await post(t, input({ expectedRevision: revision, content: content({ description: ' \r\n\t ' }) })));
  assert.equal(good(await call(endpoint, { cookie: t })).goal.description, '');
});

test('lost HTTP acknowledgment retries the original receipt once without reverting a later edit', async () => {
  const t = await login(), original = input(); loseNextResponse = true;
  await assert.rejects(post(t, original), e => e.code === 'ECONNRESET');
  assert.equal(good(await call(endpoint, { cookie: t })).goal.revision, 1);
  good(await post(t, input({ expectedRevision: 1, content: content({ title: '후속 가상 목표' }) })));
  const before = await mutationState();
  assert.deepEqual(good(await post(t, original)).receipt, { kind: 'goal', id: 'goal-a', revision: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(t, { ...original, content: content({ status: 'paused' }) }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(t, original, endpoint.replace('room-a', 'room-other')), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(t, original, endpoint.replace('goal-a', 'goal-b')), 409, 'IDEMPOTENCY_CONFLICT');
});

test('two independently authenticated tabs cannot overwrite the same goal revision', async () => {
  const a = await login(), b = await login(); good(await post(a, input()));
  const results = await Promise.all([post(a, input({ expectedRevision: 1, content: content({ title: '가상 탭 A' }) })),
    post(b, input({ expectedRevision: 1, content: content({ title: '가상 탭 B' }) }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); denied(results.find(r => r.status === 409), 409, 'GOAL_CONFLICT');
  assert.equal(good(await call(endpoint, { cookie: a })).goal.revision, 2);
  assert.equal((await raw('cb_goal_revisions')).length, 2); assert.equal((await raw('cb_context_requests')).length, 2);
});

test('guardian writes, center clinical access, unassigned peers and other tenant IDs remain denied', async () => {
  const t = await login(); good(await post(t, input())); const before = await mutationState();
  denied(await post(await login('guardian-a'), input({ expectedRevision: 1 })), 404, 'NOT_FOUND');
  for (const user of ['manager-a', 'guardian-peer', 'therapist-peer', 'foreign-b']) {
    const cookie = await login(user);
    denied(await call(endpoint, { cookie }), 404, 'NOT_FOUND'); denied(await call(listPath, { cookie }), 404, 'NOT_FOUND');
    denied(await post(cookie, input({ expectedRevision: 1 })), 404, 'NOT_FOUND');
  }
  for (const path of [endpoint.replace('room-a', 'room-b'), endpoint.replace('center-a', 'center-b'), endpoint.replace('room-a', 'missing')]) {
    denied(await call(path, { cookie: t }), 404, 'NOT_FOUND'); denied(await post(t, input(), path), 404, 'NOT_FOUND');
  }
  assert.deepEqual(await mutationState(), before);
});

for (const boundary of ['relationship', 'membership', 'account']) test(`${boundary} ending blocks reads and even a previously committed exact retry`, async () => {
  const t = await login(), original = input(); good(await post(t, original));
  if (boundary === 'relationship') await replace('therapist-peer');
  else if (boundary === 'membership') await db.query("UPDATE cb_memberships SET active=false WHERE user_id='therapist-a'");
  else await db.query("UPDATE cb_users SET active=false WHERE id='therapist-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  denied(await call(endpoint, { cookie: t }), status, code); denied(await post(t, original), status, code);
  denied(await post(t, input({ expectedRevision: 1 })), status, code); assert.deepEqual(await mutationState(), before);
});

test('from-now participants get current shared context but neither historical goal HTTP nor old private revisions', async () => {
  const t = await login(); good(await post(t, input()));
  await replace('therapist-peer', [{ userId: 'guardian-peer', history: 'from_now' }]);
  const p = await login('therapist-peer'), g = await login('guardian-peer');
  for (const cookie of [p, g]) {
    assert.equal(good(await call(endpoint, { cookie })).goal.revision, 1);
    denied(await call(`${endpoint}?revision=1`, { cookie }), 400, 'INVALID_INPUT');
  }
  await assert.rejects(goals.get(peer, { conversationId: 'room-a', goalId: 'goal-a', revision: 1 }), e => e.code === 'NOT_FOUND');
  good(await post(p, input({ expectedRevision: 1, content: content({ title: '새 담당자의 가상 목표' }) })));
  assert.equal((await goals.get(peer, { conversationId: 'room-a', goalId: 'goal-a', revision: 2 })).title, '새 담당자의 가상 목표');
});

test('goal editing keeps saved records, shared snapshots, read state and attachments unchanged; stale record context is rejected', async () => {
  const t = await login(), g = await login('guardian-a'); good(await post(t, input()));
  const recordBody = { clientId: randomUUID(), expectedRevision: 0, expectedGoalRevision: 1, content: {
    date: '2026-10-09', goalId: 'goal-a', title: '가상 원 기록', performed: '가상 수행', response: '가상 반응', nextPlan: '가상 다음 계획',
    summary: '고정 공개 요약', privateNote: 'PRIVATE-CLINICAL', assessments: [{ tool: '가상 도구', item: '가상 측정', value: 0, unit: '회', context: '가상 조건' }],
    activity: { title: '가상 놀이', instruction: '공개 활동 안내', frequency: '가상 연습 1회', caution: '' } } };
  const recordPath = `${room}/records/record-a`;
  good(await post(t, recordBody, recordPath), 201);
  const preview = good(await call(`${recordPath}/preview`, { cookie: t })).preview;
  good(await post(t, { clientId: randomUUID(), expectedRevision: preview.recordRevision,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds }, `${recordPath}/publish`), 201);
  const oldRecord = good(await call(recordPath, { cookie: t })), oldMessages = good(await call(`${room}/messages`, { cookie: g }));
  const before = await unrelatedState(), goalPage = good(await call(`${listPath}?limit=1`, { cookie: t }));
  good(await post(t, input({ expectedRevision: 1, content: content({ title: '새 가상 목표', status: 'achieved' }) })));
  assert.deepEqual(await unrelatedState(), before);
  assert.deepEqual(good(await call(recordPath, { cookie: t })), oldRecord);
  const newMessages = good(await call(`${room}/messages`, { cookie: g }));
  assert.deepEqual(newMessages.messages, oldMessages.messages); assert.equal(newMessages.lastRead, oldMessages.lastRead);
  assert.deepEqual(good(await call(`${listPath}?expectedRevision=${goalPage.revision}`, { cookie: t })), {
    revision: newMessages.revision, resetRequired: true });
  denied(await post(t, { ...recordBody, clientId: randomUUID(), expectedRevision: 1 }, recordPath), 409, 'CONTEXT_CHANGED');
  assert.deepEqual(await unrelatedState(), before);
  good(await post(t, { ...recordBody, clientId: randomUUID(), expectedRevision: 1, expectedGoalRevision: 2 }, recordPath), 201);
  assert.equal(good(await call(recordPath, { cookie: t })).record.goalSnapshot.title, '새 가상 목표');
  assert.deepEqual(good(await call(`${recordPath}?revision=1`, { cookie: t })), oldRecord);
  assert.deepEqual(good(await call(`${room}/messages`, { cookie: g })).messages, oldMessages.messages);
});

test('strict body/content fields, scalar types, Unicode and raw limits fail without a goal or receipt write', async () => {
  const t = await login(), valid = input(), before = await mutationState();
  const invalid = [null, [], {}, { ...valid, clientId: undefined }, { ...valid, expectedRevision: undefined }, { ...valid, content: null }, { ...valid, content: [] }];
  for (const key of ['title', 'description', 'status']) invalid.push({ ...valid, content: { ...valid.content, [key]: undefined } });
  for (const title of [null, false, 0, {}, [], '', ' ', '\ud800', 'x\0', 'x\n', 'x\t', 'x\u0085', 'x'.repeat(101), ' '.repeat(100) + 'x']) invalid.push({ ...valid, content: content({ title }) });
  for (const description of [null, false, {}, [], '\udc00', 'x\0', 'x\u000b', 'x\u007f', 'x\u009f', 'x'.repeat(2001), ' '.repeat(2000) + 'x']) invalid.push({ ...valid, content: content({ description }) });
  for (const status of [null, false, 0, {}, [], '', 'archived']) invalid.push({ ...valid, content: content({ status }) });
  for (const expectedRevision of [-1, 0.5, '0', null, 2147483648]) invalid.push({ ...valid, expectedRevision });
  for (const clientId of ['', 'short', 'underscore_id', 'x'.repeat(101)]) invalid.push({ ...valid, clientId });
  for (const key of ['role', 'userId', 'goalId', 'conversationId', 'childId', 'revision', 'privateNote', 'attachments']) {
    invalid.push({ ...valid, [key]: 'PRIVATE-INJECTED' }); invalid.push({ ...valid, content: { ...valid.content, [key]: 'PRIVATE-INJECTED' } });
  }
  for (const body of invalid) denied(await post(t, body), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { cookie: t, method: 'POST', rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  good(await post(t, input({ content: content({ title: '가'.repeat(100), description: '설'.repeat(2000) }) })));
});

test('direct goal service uses the same Unicode and raw-boundary rules before entering a transaction', async () => {
  const before = await mutationState();
  for (const extra of [{ title: '\ud800' }, { title: 'x\t' }, { description: '\udc00' }, { description: 'x\u0080' },
    { title: ' '.repeat(100) + 'x' }, { description: ' '.repeat(2000) + 'x' }, { description: null }, { status: null }]) {
    await assert.rejects(goals.save(therapist, { ...input({ content: content(extra) }), conversationId: 'room-a', goalId: 'goal-a' }), e => e.code === 'INVALID_INPUT');
  }
  assert.deepEqual(await mutationState(), before);
});

test('maximum int32 goal revision permits a no-op and exact retry but changed data has a safe REVISION_LIMIT', async () => {
  const t = await login(); good(await post(t, input()));
  // Artificial upper-bound fixture only in owned memory; restore the root
  // guard atomically before HTTP. The capture trigger still creates the exact
  // revision referenced by the head and receipt, without changing old history.
  await db.transaction(async tx => {
    await tx.exec('ALTER TABLE cb_goals DISABLE TRIGGER cb_goal_root_guard');
    await tx.exec("UPDATE cb_conversations SET last_sequence=last_sequence+1,revision=revision+1 WHERE id='room-a'");
    await tx.exec("UPDATE cb_goals SET current_revision=2147483647,changed_sequence=2,updated_at=clock_timestamp() WHERE id='goal-a'");
    // Validate pending head/history foreign keys before changing trigger DDL.
    await tx.exec('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.exec('ALTER TABLE cb_goals ENABLE TRIGGER cb_goal_root_guard');
  });
  const noOp = input({ expectedRevision: 2147483647 });
  assert.equal(good(await post(t, noOp)).receipt.changed, false); assert.equal(good(await post(t, noOp)).receipt.replayed, true);
  const before = await mutationState();
  denied(await post(t, input({ expectedRevision: 2147483647, content: content({ status: 'paused' }) })), 409, 'REVISION_LIMIT');
  assert.deepEqual(await mutationState(), before);
});

test('only exact current goal GET/POST paths are mounted; historical query, delete, list POST and other methods stay closed', async () => {
  const t = await login();
  for (const suffix of ['?revision=1', '?expectedRevision=1', '?x=1', '?x=1&x=2']) {
    denied(await call(endpoint + suffix, { cookie: t }), 400, 'INVALID_INPUT'); denied(await post(t, input(), endpoint + suffix), 400, 'INVALID_INPUT');
  }
  for (const path of [endpoint + '/', endpoint + '/delete', endpoint + '/preview', endpoint + '/publish', endpoint.replace('goal-a', '%67oal-a')])
    denied(await call(path, { cookie: t }), 404, 'NOT_FOUND');
  for (const method of ['PATCH', 'PUT', 'DELETE', 'OPTIONS']) denied(await call(endpoint, { cookie: t, method }), 404, 'NOT_FOUND');
  denied(await post(t, input(), listPath), 404, 'NOT_FOUND');
});

test('session/account/CSRF/origin/host guards protect reads and writes without exposing internal failure values', async () => {
  const t = await login(), before = await mutationState();
  denied(await call(endpoint), 401, 'AUTH_REQUIRED'); denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  for (const account of [undefined, 'guardian-a']) {
    denied(await call(endpoint, { cookie: t, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    denied(await post(t, input(), endpoint, { 'X-Carebridge-Account': account }), 401, 'AUTH_REQUIRED');
  }
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:1234' }]) {
    denied(await call(endpoint, { cookie: t, headers }), 403, 'SOURCE_REJECTED'); denied(await post(t, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  }
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }]) denied(await post(t, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(t, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await mutationState(), before);
});

test('route-local service requirements and explicit whitelists preserve the existing list contract and exclude private additions', async () => {
  const t = await login(); options.goals = { list: goals.list.bind(goals) };
  assert.deepEqual(good(await call(listPath, { cookie: t })).goals, []);
  denied(await call(endpoint, { cookie: t }), 503, 'LOCAL_API_UNAVAILABLE'); denied(await post(t, input()), 503, 'LOCAL_API_UNAVAILABLE');
  const goal = { id: 'goal-a', conversationId: 'room-a', childId: 'child-a', revision: 1, title: '가상 목표', status: 'active', description: '', updatedAt: null };
  const get = localCareRoute(new URL(endpoint, origin), 'GET'), write = localCareRoute(new URL(endpoint, origin), 'POST');
  assert.deepEqual(await executeLocalCare(get, therapist, null, { goals: { get: async () => ({ ...goal, privateNote: 'PRIVATE-NOTE', authorId: 'PRIVATE-ACTOR' }) } }),
    { status: 200, body: { goal } });
  const receipt = { kind: 'goal', id: 'goal-a', revision: 1, changed: true, replayed: false };
  let captured;
  assert.deepEqual(await executeLocalCare(write, therapist, input(), { goals: { save: async (actor, body) => {
    captured = { actor, body }; return { ...receipt, request_hash: 'PRIVATE-HASH', content: 'PRIVATE-CONTENT' };
  } } }), { status: 200, body: { receipt } });
  assert.deepEqual(captured.actor, therapist); assert.equal(captured.body.goalId, 'goal-a'); assert.equal(captured.body.conversationId, 'room-a');
});

test('receipt failure rolls back current goal, immutable history and room counters before a same-request success', async () => {
  const t = await login(), body = input(), before = await mutationState();
  await db.exec(`CREATE FUNCTION cb_test_goal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-INTERNAL'; END; $$;
    CREATE TRIGGER cb_test_goal_failure BEFORE INSERT ON cb_context_requests FOR EACH ROW EXECUTE FUNCTION cb_test_goal_failure()`);
  try { denied(await post(t, body), 503, 'LOCAL_API_UNAVAILABLE'); assert.deepEqual(await mutationState(), before); }
  finally { await db.exec('DROP TRIGGER cb_test_goal_failure ON cb_context_requests; DROP FUNCTION cb_test_goal_failure()'); }
  assert.equal(good(await post(t, body)).receipt.replayed, false); assert.equal(good(await post(t, body)).receipt.replayed, true);
  assert.equal((await raw('cb_goal_revisions')).length, 1); assert.equal((await raw('cb_context_requests')).length, 1);
});
