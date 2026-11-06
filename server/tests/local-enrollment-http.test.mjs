// Actual authenticated HTTP and domain services, invented identities and memory
// PGlite only. No invitation delivery, native/E database or public listener.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Relationships } from '../relationships.mjs';
import { Conversations } from '../conversations.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localOperationsRoute, executeLocalOperations } from '../local-operations-http.mjs';

let db, auth, profiles, members, relationships, chat, server, origin, options, cookies, loseResponse;
const base = '/api/local/centers/center-a/operations';
const childrenPath = `${base}/children`, membersPath = `${base}/members`;
const relationshipPath = `${base}/conversations/room-a/relationships`;
const clinical = '/api/local/centers/center-a/conversations/room-a';
const manager = { centerId: 'center-a', userId: 'manager-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const peer = { centerId: 'center-a', userId: 'guardian-peer' };
const actors = ['manager-a', 'manager-peer', 'manager-b', 'therapist-a', 'therapist-peer', 'guardian-a', 'guardian-peer', 'guardian-b'];
const password = 'Invented enrollment fixture only 2026!';
const register = (extra = {}) => ({ clientId: randomUUID(), childId: 'child-new', conversationId: 'room-new',
  content: { name: '가상 등록 아동', age: 0, ageAsOf: '2020-01-01' }, ...extra });
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutableTables = ['cb_children', 'cb_conversations', 'cb_child_profiles', 'cb_profile_requests', 'cb_participants',
  'cb_relationship_requests', 'cb_relationship_changes', 'cb_read_states'];
const mutationState = () => Promise.all(mutableTables.map(raw));
const authState = () => Promise.all(['cb_users', 'cb_memberships', 'cb_auth_accounts', 'cb_auth_invitations', 'cb_auth_audit_events'].map(raw));
const clinicalState = () => Promise.all(['cb_messages', 'cb_message_text_revisions', 'cb_child_family_plans', 'cb_records',
  'cb_record_revisions', 'cb_record_assessments', 'cb_record_references', 'cb_record_attachments', 'cb_record_publications',
  'cb_goals', 'cb_goal_revisions', 'cb_appointments', 'cb_appointment_revisions', 'cb_media_uploads'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseResponse = null;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-peer',true),('manager-b',true),
      ('therapist-a',true),('therapist-peer',true),('guardian-a',true),('guardian-peer',true),('guardian-b',true),
      ('disabled-a',false),('inactive-a',true),('no-login-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-a','manager-peer','center',true),
      ('center-b','manager-b','center',true),('center-a','therapist-a','therapist',true),('center-a','therapist-peer','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),('center-b','guardian-b','guardian',true),
      ('center-a','disabled-a','guardian',true),('center-a','inactive-a','guardian',false),('center-a','no-login-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1);
    INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision) VALUES ('center-a','guardian-a','가상 표시명',1);`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@enrollment.test`, password });
  profiles = new Children(db); members = new MemberProfiles(db); relationships = new Relationships(db); chat = new Conversations(db);
  server = createServer(async (req, res) => {
    // Genuine commit followed by a dropped HTTP acknowledgment. SQL and domain
    // writes still execute normally before the response's end is suppressed.
    if (loseResponse && req.method === 'POST' && req.url === loseResponse) {
      loseResponse = null; res.end = () => { res.destroy(); return res; };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles, memberProfiles: members, relationships, origin,
    cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});
function call(path, { cookie, method = 'GET', body, headers = {}, rawBody } = {}) {
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
const post = (cookie, path, body, headers) => call(path, { cookie, method: 'POST', body, headers });
async function login(userId = 'manager-a') {
  const result = await post(null, '/api/local/auth/login', { email: `${userId}@enrollment.test`, password });
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}
async function command(extra = {}, roomId = 'room-a') {
  return { clientId: randomUUID(), expectedVersion: (await relationships.get(manager, { conversationId: roomId })).version,
    therapist: { userId: 'therapist-a', history: 'preserve' }, guardians: [{ userId: 'guardian-a', history: 'preserve' }],
    historyConfirmed: true, pastHistoryConfirmed: false, ...extra };
}
const send = (actor = therapist, body = 'PRIVATE-OLD-MESSAGE') => chat.sendText(actor, { conversationId: 'room-a', clientId: randomUUID(), body });

test('registration is atomic and minimally projected, with zero age and no account, relationship or history creation', async () => {
  const m = await login(), beforeAuth = await authState(), beforeClinical = await clinicalState(), input = register();
  assert.deepEqual(good(await post(m, childrenPath, input), 201), { receipt: { operation: 'child.register', childId: input.childId,
    conversationId: input.conversationId, appliedVersion: 1, changed: true, replayed: false } });
  assert.deepEqual(good(await call(`${base}/conversations/room-new/profile`, { cookie: m })).profile,
    { conversationId: 'room-new', childId: 'child-new', name: '가상 등록 아동', age: 0, ageAsOf: '2020-01-01', revision: 1 });
  assert.deepEqual(good(await call(relationshipPath.replace('room-a', 'room-new'), { cookie: m })).relationships,
    { conversationId: 'room-new', childId: 'child-new', version: 0, participants: [] });
  assert.deepEqual(await authState(), beforeAuth); assert.deepEqual(await clinicalState(), beforeClinical);
  denied(await call(clinical.replace('room-a', 'room-new') + '/profile', { cookie: await login('guardian-a') }), 404, 'NOT_FOUND');
  const linked = await command({ therapist: { userId: 'therapist-a', history: 'from_now' },
    guardians: [{ userId: 'guardian-a', history: 'from_now' }] }, 'room-new');
  assert.equal(good(await post(m, relationshipPath.replace('room-a', 'room-new'), linked)).receipt.appliedVersion, 2);
  assert.equal(good(await call(clinical.replace('room-a', 'room-new') + '/profile', { cookie: await login('guardian-a') })).childId, 'child-new');
});

test('registration acknowledgment loss replays exact IDs without reverting later metadata or producing duplicates', async () => {
  const m = await login(), input = register(); loseResponse = childrenPath;
  await assert.rejects(post(m, childrenPath, input), error => error.code === 'ECONNRESET');
  await profiles.save(manager, { conversationId: 'room-new', clientId: randomUUID(), expectedRevision: 1,
    content: { name: '가상 후속 이름', age: null, ageAsOf: null } });
  const before = await mutationState();
  assert.deepEqual(good(await post(m, childrenPath, input), 201).receipt,
    { operation: 'child.register', childId: 'child-new', conversationId: 'room-new', appliedVersion: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(m, childrenPath, { ...input, childId: 'substitute' }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(m, childrenPath, register()), 409, 'CHILD_EXISTS');
  denied(await post(m, childrenPath, register({ childId: 'another-child' })), 409, 'CHILD_EXISTS');
  denied(await post(m, childrenPath, register({ conversationId: 'another-room' })), 409, 'CHILD_EXISTS');
});

test('concurrent exact registrations commit once and return one replay, while separate requests cannot reuse IDs', async () => {
  const m = await login(), input = register();
  const results = await Promise.all([post(m, childrenPath, input), post(m, childrenPath, input)]);
  assert.deepEqual(results.map(result => good(result, 201).receipt.replayed).sort(), [false, true]);
  assert.equal((await db.query("SELECT count(*)::int n FROM cb_profile_requests WHERE operation='child.register'")).rows[0].n, 1);
  denied(await post(await login('manager-peer'), childrenPath, register()), 409, 'CHILD_EXISTS');
});

test('active member pages expose only center-scoped display labels and keep all-role source cursors without claiming login eligibility', async () => {
  const m = await login(), collected = []; let cursor;
  do {
    const page = good(await call(`${membersPath}?limit=2${cursor ? `&afterId=${cursor}` : ''}`, { cookie: m }));
    assert.deepEqual(Object.keys(page).sort(), ['hasMore', 'members', 'nextCursor']);
    for (const item of page.members) assert.deepEqual(Object.keys(item).sort(), ['displayName', 'role', 'userId']);
    assert.equal(page.nextCursor, page.members.at(-1)?.userId ?? null); collected.push(...page.members); cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  assert.deepEqual(collected.map(row => row.userId), ['guardian-a', 'guardian-peer', 'manager-a', 'manager-peer', 'no-login-a', 'therapist-a', 'therapist-peer']);
  assert.equal(collected.find(row => row.userId === 'guardian-a').displayName, '가상 표시명');
  assert.equal(collected.find(row => row.userId === 'no-login-a').displayName, null);
  assert.equal((await db.query("SELECT count(*)::int n FROM cb_auth_accounts WHERE user_id='no-login-a'")).rows[0].n, 0);
  assert.deepEqual(good(await call(`${membersPath}?afterId=therapist-peer`, { cookie: m })), { members: [], nextCursor: null, hasMore: false });
});

test('relationship projection retains active but unavailable assignments, omits disconnected history and contains no clinical fields', async () => {
  await send();
  await db.exec(`INSERT INTO cb_participants VALUES ('center-a','room-a','inactive-a','guardian',true,1),
    ('center-a','room-a','disabled-a','guardian',true,1),('center-a','room-a','guardian-peer','guardian',false,1)`);
  const m = await login(), view = good(await call(relationshipPath, { cookie: m })).relationships;
  assert.deepEqual(Object.keys(view).sort(), ['childId', 'conversationId', 'participants', 'version']);
  assert.deepEqual(view.participants.map(row => row.userId), ['disabled-a', 'guardian-a', 'inactive-a', 'therapist-a']);
  for (const item of view.participants) assert.deepEqual(Object.keys(item).sort(), ['firstSequence', 'role', 'userId']);
  const directory = good(await call(membersPath, { cookie: m })).members;
  assert.equal(directory.some(row => ['disabled-a', 'inactive-a'].includes(row.userId)), false);
  const before = await mutationState();
  denied(await post(m, relationshipPath, await command({ guardians: view.participants.filter(row => row.role === 'guardian')
    .map(row => ({ userId: row.userId, history: 'preserve' })) })), 409, 'PARTICIPANT_UNAVAILABLE');
  assert.deepEqual(await mutationState(), before);
});

test('from-now admission locks the committed message boundary and all-history access requires an explicit second confirmation', async () => {
  const m = await login(), p = await login('guardian-peer'), old = await send();
  const join = await command({ guardians: [{ userId: 'guardian-a', history: 'preserve' }, { userId: 'guardian-peer', history: 'from_now' }] });
  const later = await send(therapist, 'PRIVATE-BEFORE-COMMIT'); good(await post(m, relationshipPath, join));
  const visible = good(await call(clinical + '/messages', { cookie: p })); assert.deepEqual(visible.messages, []); assert.equal(visible.unread, 0);
  assert.equal(good(await call(relationshipPath, { cookie: m })).relationships.participants.find(row => row.userId === 'guardian-peer').firstSequence, later.sequence + 1);
  denied(await call(`${clinical}/messages/${old.id}`, { cookie: p }), 404, 'NOT_FOUND');
  const next = await send(therapist, '가상 새 소식');
  assert.deepEqual(good(await call(clinical + '/messages', { cookie: p })).messages.map(row => row.id), [next.id]);
  await chat.markRead(peer, { conversationId: 'room-a', messageId: next.id });
  const all = await command({ guardians: [{ userId: 'guardian-a', history: 'preserve' }, { userId: 'guardian-peer', history: 'all' }] });
  const before = await mutationState(); denied(await post(m, relationshipPath, all), 409, 'PAST_HISTORY_CONFIRMATION_REQUIRED');
  assert.deepEqual(await mutationState(), before); good(await post(m, relationshipPath, { ...all, pastHistoryConfirmed: true }));
  const granted = good(await call(clinical + '/messages', { cookie: p })); assert.equal(granted.lastRead, 0);
  assert.deepEqual(granted.messages.map(row => row.id), [old.id, later.id, next.id]);
});

test('disconnection closes old access; reconnection cannot preserve an old grant and from-now clears only its old read cursor', async () => {
  const m = await login(), g = await login('guardian-a'), old = await send();
  await chat.markRead(guardian, { conversationId: 'room-a', messageId: old.id });
  good(await post(m, relationshipPath, await command({ guardians: [] })));
  denied(await call(clinical + '/messages', { cookie: g }), 404, 'NOT_FOUND');
  denied(await post(m, relationshipPath, await command()), 409, 'HISTORY_CHOICE_REQUIRED');
  good(await post(m, relationshipPath, await command({ guardians: [{ userId: 'guardian-a', history: 'from_now' }] })));
  const page = good(await call(clinical + '/messages', { cookie: g })); assert.equal(page.lastRead, 0); assert.deepEqual(page.messages, []);
  denied(await call(`${clinical}/messages/${old.id}`, { cookie: g }), 404, 'NOT_FOUND');
});

test('relationship CAS detects two-manager edits while a no-op remains stable across new messages and read state', async () => {
  const m = await login(), other = await login('manager-peer'), current = await command();
  const old = await send(); await chat.markRead(guardian, { conversationId: 'room-a', messageId: old.id });
  const noOp = good(await post(m, relationshipPath, current)).receipt;
  assert.equal(noOp.changed, false); assert.equal(noOp.appliedVersion, current.expectedVersion);
  const candidates = [await command({ guardians: [] }), await command({ therapist: null })];
  const results = await Promise.all([post(m, relationshipPath, candidates[0]), post(other, relationshipPath, candidates[1])]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]); denied(results.find(row => row.status === 409), 409, 'RELATIONSHIP_CONFLICT');
  assert.equal((await raw('cb_relationship_requests')).length, 2);
});

test('lost relationship acknowledgment and exact old retry return only the immutable receipt without reapplying retired assignments', async () => {
  const m = await login(), input = await command({ therapist: { userId: 'therapist-peer', history: 'from_now' }, guardians: [] });
  loseResponse = relationshipPath; await assert.rejects(post(m, relationshipPath, input), error => error.code === 'ECONNRESET');
  const firstVersion = (await relationships.get(manager, { conversationId: 'room-a' })).version;
  assert.equal(firstVersion, input.expectedVersion + 3); // Old provider off, guardian off, replacement on.
  good(await post(m, relationshipPath, await command({ therapist: { userId: 'therapist-a', history: 'from_now' },
    guardians: [{ userId: 'guardian-a', history: 'from_now' }] })));
  const before = await mutationState();
  assert.deepEqual(good(await post(m, relationshipPath, input)).receipt,
    { conversationId: 'room-a', appliedVersion: firstVersion, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(m, relationshipPath, { ...input, therapist: null }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(m, relationshipPath.replace('room-a', 'room-other'), input), 409, 'IDEMPOTENCY_CONFLICT');
});

for (const boundary of ['membership', 'role', 'account']) test(`current manager ${boundary} removal blocks registration, roster, relations and committed retries`, async () => {
  const m = await login(), registration = register(), relation = await command();
  good(await post(m, childrenPath, registration), 201); good(await post(m, relationshipPath, relation));
  await db.query(boundary === 'account' ? "UPDATE cb_users SET active=false WHERE id='manager-a'"
    : boundary === 'role' ? "UPDATE cb_memberships SET role='guardian' WHERE user_id='manager-a'"
    : "UPDATE cb_memberships SET active=false WHERE user_id='manager-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  for (const path of [membersPath, childrenPath, relationshipPath]) denied(await call(path, { cookie: m }), status, code);
  denied(await post(m, childrenPath, registration), status, code); denied(await post(m, relationshipPath, relation), status, code);
  assert.deepEqual(await mutationState(), before);
});

test('a stale authenticated center snapshot cannot bypass transactional manager checks on any new operation', async () => {
  const m = await login(), relation = await command(); let snapshot;
  options.auth = { login: auth.login.bind(auth), logout: auth.logout.bind(auth), authenticate: async token => {
    if (!snapshot) { snapshot = await auth.authenticate(token); await db.query("UPDATE cb_memberships SET role='guardian' WHERE user_id='manager-a'"); }
    return snapshot;
  } };
  denied(await call(membersPath, { cookie: m }), 404, 'NOT_FOUND'); denied(await call(relationshipPath, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, childrenPath, register()), 404, 'NOT_FOUND'); denied(await post(m, relationshipPath, relation), 404, 'NOT_FOUND');
  assert.equal((await raw('cb_profile_requests')).length, 0); assert.equal((await raw('cb_relationship_requests')).length, 0);
});

test('existing memberships are not created/reactivated or re-roled by relationship selection', async () => {
  const m = await login(), before = await authState(), initial = await mutationState();
  for (const userId of ['missing', 'guardian-b', 'disabled-a', 'inactive-a', 'manager-a', 'therapist-peer']) {
    denied(await post(m, relationshipPath, await command({ guardians: [{ userId, history: 'from_now' }] })), 409, 'PARTICIPANT_UNAVAILABLE');
  }
  denied(await post(m, relationshipPath, await command({ therapist: { userId: 'guardian-a', history: 'from_now' }, guardians: [] })), 409, 'PARTICIPANT_UNAVAILABLE');
  assert.deepEqual(await mutationState(), initial); assert.deepEqual(await authState(), before);
  // Membership-only eligibility is deliberate, not a claim of a login account.
  good(await post(m, relationshipPath, await command({ guardians: [{ userId: 'no-login-a', history: 'from_now' }] })));
  assert.deepEqual(await authState(), before);
});

test('clinical roles and other centers cannot use enrollment, while center operations still cannot read clinical/family/media content', async () => {
  const relation = await command();
  for (const userId of ['guardian-a', 'therapist-a', 'guardian-peer', 'manager-b']) {
    const cookie = await login(userId);
    for (const path of [membersPath, relationshipPath]) denied(await call(path, { cookie }), 404, 'NOT_FOUND');
    denied(await post(cookie, childrenPath, register()), 404, 'NOT_FOUND'); denied(await post(cookie, relationshipPath, relation), 404, 'NOT_FOUND');
  }
  const m = await login();
  for (const path of [relationshipPath.replace('room-a', 'room-b'), relationshipPath.replace('room-a', 'missing'), membersPath.replace('center-a', 'center-b')])
    denied(await call(path, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, relationshipPath.replace('room-a', 'room-b'), relation), 404, 'NOT_FOUND');
  for (const suffix of ['/messages', '/profile', '/records', '/family-plan', '/goals', '/appointments', '/feedback/feedback-a'])
    denied(await call(clinical + suffix, { cookie: m }), 404, 'NOT_FOUND');
});

test('strict registration JSON accepts no omitted fields, forged subject/role, invalid age/date or unsafe identifier', async () => {
  const m = await login(), valid = register(), before = await mutationState();
  const malformed = [null, [], {}, { ...valid, content: null }];
  for (const key of Object.keys(valid)) malformed.push({ ...valid, [key]: undefined });
  for (const key of Object.keys(valid.content)) malformed.push({ ...valid, content: { ...valid.content, [key]: undefined } });
  for (const id of ['', 'bad.id', 'x'.repeat(101), null, 1]) for (const key of ['childId', 'conversationId']) malformed.push({ ...valid, [key]: id });
  for (const name of ['', ' ', '\ud800', 'x\n', 'x\u0085', '가'.repeat(31)]) malformed.push({ ...valid, content: { ...valid.content, name } });
  for (const content of [{ name: '가상', age: '0', ageAsOf: '2020-01-01' }, { name: '가상', age: null, ageAsOf: '2020-01-01' },
    { name: '가상', age: 0, ageAsOf: '9999-12-31' }, { name: '가상', age: 27, ageAsOf: '2020-01-01' }]) malformed.push({ ...valid, content });
  for (const key of ['centerId', 'userId', 'role', 'therapist', 'guardians', 'familyPlan', 'expectedRevision']) malformed.push({ ...valid, [key]: 'PRIVATE-INJECTED' });
  for (const body of malformed) denied(await post(m, childrenPath, body), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  good(await post(m, childrenPath, register({ content: { name: '가상 연령 미상', age: null, ageAsOf: null } })), 201);
});

test('strict relationship JSON distinguishes malformed input, explicit history consent and unavailable history choices', async () => {
  const m = await login(), valid = await command(), before = await mutationState();
  const malformed = [null, [], {}, { ...valid, guardians: null }, { ...valid, therapist: [] }];
  for (const key of Object.keys(valid)) malformed.push({ ...valid, [key]: undefined });
  for (const expectedVersion of [-1, '0', 0.5, null, Number.MAX_SAFE_INTEGER + 1]) malformed.push({ ...valid, expectedVersion });
  for (const historyConfirmed of [null, 1, 'true']) malformed.push({ ...valid, historyConfirmed });
  for (const pastHistoryConfirmed of [null, 1, 'false']) malformed.push({ ...valid, pastHistoryConfirmed });
  for (const participant of [{ userId: 'guardian-a' }, { history: 'preserve' }, { userId: 'guardian-a', history: 'automatic' },
    { userId: 'guardian-a', history: 'preserve', role: 'guardian' }]) malformed.push({ ...valid, guardians: [participant] });
  malformed.push({ ...valid, guardians: [valid.guardians[0], valid.guardians[0]] }, { ...valid, guardians: Array(101).fill(valid.guardians[0]) });
  for (const key of ['centerId', 'conversationId', 'role', 'participants', 'email', 'firstSequence']) malformed.push({ ...valid, [key]: 'PRIVATE-INJECTED' });
  for (const body of malformed) denied(await post(m, relationshipPath, body), 400, 'INVALID_INPUT');
  denied(await post(m, relationshipPath, { ...valid, historyConfirmed: false }), 409, 'HISTORY_CONFIRMATION_REQUIRED');
  assert.deepEqual(await mutationState(), before);
});

test('only exact operations routes and bounded roster query keys are allowed; registration/relationship POST do not accept query overrides', async () => {
  const m = await login();
  for (const suffix of ['?limit=0', '?limit=101', '?limit=01', '?limit=1&limit=2', '?afterId=', '?afterId=a&afterId=b', '?role=guardian', '?email=x', '?after=x'])
    denied(await call(membersPath + suffix, { cookie: m }), 400, 'INVALID_INPUT');
  for (const suffix of ['?limit=1', '?afterId=a', '?revision=1', '?action=register']) {
    denied(await post(m, childrenPath + suffix, register()), 400, 'INVALID_INPUT');
    denied(await call(relationshipPath + suffix, { cookie: m }), 400, 'INVALID_INPUT');
    denied(await post(m, relationshipPath + suffix, await command()), 400, 'INVALID_INPUT');
  }
  for (const path of [childrenPath + '/register', membersPath + '/', membersPath + '/guardian-a', relationshipPath + '/replace',
    relationshipPath.replace('room-a', '%72oom-a'), `${base}/invitations`, `${base}/accounts`, `${base}/provision`])
    denied(await call(path, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, membersPath, {}), 404, 'NOT_FOUND');
  for (const method of ['PATCH', 'PUT', 'DELETE', 'OPTIONS']) for (const path of [childrenPath, membersPath, relationshipPath])
    denied(await call(path, { cookie: m, method }), 404, 'NOT_FOUND');
});

test('new operations preserve account binding, session, loopback source, CSRF and content-type protections', async () => {
  const m = await login(), relation = await command(), before = await mutationState();
  for (const path of [membersPath, relationshipPath]) {
    denied(await call(path), 401, 'AUTH_REQUIRED');
    for (const headers of [{ 'X-Carebridge-Account': undefined }, { 'X-Carebridge-Account': 'manager-peer' }])
      denied(await call(path, { cookie: m, headers }), 401, 'AUTH_REQUIRED');
    for (const headers of [{ Origin: 'https://foreign.invalid' }, { Host: 'localhost:1234' }, { 'Sec-Fetch-Site': 'same-site' }])
      denied(await call(path, { cookie: m, headers }), 403, 'SOURCE_REJECTED');
  }
  for (const [path, body] of [[childrenPath, register()], [relationshipPath, relation]]) {
    denied(await post(null, path, body), 401, 'AUTH_REQUIRED');
    denied(await post(m, path, body, { 'X-Carebridge-Account': 'manager-peer' }), 401, 'AUTH_REQUIRED');
    for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }, { Origin: 'https://foreign.invalid' }])
      denied(await post(m, path, body, headers), 403, 'SOURCE_REJECTED');
    denied(await post(m, path, body, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  assert.deepEqual(await mutationState(), before);
});

test('receipt and audit failures roll registration and complete relationship replacement back without partial grants', async () => {
  const m = await login(), initial = await mutationState();
  for (const [table, path, body] of [['cb_profile_requests', childrenPath, register()], ['cb_relationship_requests', relationshipPath,
    await command({ therapist: { userId: 'therapist-peer', history: 'from_now' }, guardians: [] })],
    ['cb_relationship_changes', relationshipPath, await command({ guardians: [] })]]) {
    await db.exec(`CREATE FUNCTION cb_test_enrollment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-INTERNAL'; END; $$;
      CREATE TRIGGER cb_test_enrollment_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION cb_test_enrollment_failure()`);
    try { denied(await post(m, path, body), 503, 'LOCAL_API_UNAVAILABLE'); assert.deepEqual(await mutationState(), initial); }
    finally { await db.exec(`DROP TRIGGER cb_test_enrollment_failure ON ${table}; DROP FUNCTION cb_test_enrollment_failure()`); }
  }
});

test('provider reassignment respects existing schedule overlap and keeps the old relation/receipts on conflict', async () => {
  const appointments = new Appointments(db), m = await login();
  await relationships.replace(manager, { conversationId: 'room-other', ...await command({ expectedVersion: 0,
    therapist: { userId: 'therapist-peer', history: 'from_now' }, guardians: [] }) });
  for (const [conversationId, room] of [['room-a', '가상 1실'], ['room-other', '가상 2실']])
    await appointments.save(manager, { conversationId, appointmentId: `appointment-${conversationId}`, clientId: randomUUID(), expectedRevision: 0,
      content: { date: '2026-10-09', time: '10:00', duration: 30, title: '가상 일정', room, status: 'scheduled' } });
  const before = await mutationState(), schedule = await raw('cb_appointments');
  denied(await post(m, relationshipPath, await command({ therapist: { userId: 'therapist-peer', history: 'from_now' } })), 409, 'SCHEDULE_CONFLICT');
  assert.deepEqual(await mutationState(), before); assert.deepEqual(await raw('cb_appointments'), schedule);
});

test('relationship changes preserve authored clinical/family/message originals and never post an automatic chat or mark remaining readers', async () => {
  const goals = new Goals(db), records = new Records(db), m = await login();
  await goals.save(therapist, { conversationId: 'room-a', goalId: 'goal-a', clientId: randomUUID(), expectedRevision: 0,
    content: { title: '가상 목표', description: '가상 설명', status: 'active' } });
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-09', goalId: 'goal-a', title: '가상 기록', performed: '가상 수행', response: '가상 반응', nextPlan: '가상 계획', privateNote: 'PRIVATE-CLINICAL' } });
  await profiles.saveFamilyPlan(guardian, { conversationId: 'room-a', clientId: randomUUID(), expectedRevision: 0, concern: 'PRIVATE-FAMILY' });
  const old = await send(); await chat.markRead(guardian, { conversationId: 'room-a', messageId: old.id });
  const clinicalBefore = await clinicalState(), reads = await raw('cb_read_states');
  good(await post(m, relationshipPath, await command({ guardians: [{ userId: 'guardian-a', history: 'preserve' }, { userId: 'guardian-peer', history: 'from_now' }] })));
  assert.deepEqual(await clinicalState(), clinicalBefore); assert.deepEqual(await raw('cb_read_states'), reads);
  for (const path of [membersPath, relationshipPath]) assert.doesNotMatch(JSON.stringify(good(await call(path, { cookie: m }))), /PRIVATE-|body|summary|familyPlan|email|password/);
});

test('sequence exhaustion fails closed and an oversized legacy active set is not silently truncated', async () => {
  const m = await login(); await db.query("UPDATE cb_conversations SET last_sequence=$1 WHERE id='room-a'", [Number.MAX_SAFE_INTEGER]);
  const before = await mutationState();
  denied(await post(m, relationshipPath, await command({ guardians: [{ userId: 'guardian-peer', history: 'from_now' }] })), 409, 'SEQUENCE_LIMIT');
  assert.deepEqual(await mutationState(), before);
  await db.transaction(async tx => {
    for (let i = 0; i < 100; i++) {
      const userId = `legacy-guardian-${i}`;
      await tx.query('INSERT INTO cb_users(id) VALUES ($1)', [userId]);
      await tx.query("INSERT INTO cb_memberships VALUES ('center-a',$1,'guardian',true)", [userId]);
      await tx.query("INSERT INTO cb_participants VALUES ('center-a','room-a',$1,'guardian',true,1)", [userId]);
    }
  });
  denied(await call(relationshipPath, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE');
});

test('recipient projection adds one independent slot without widening guardian or therapist limits', async () => {
  const participant = (role, index = 0) => ({ userId: `${role}-${index}`, role, active: true, firstSequence: 1 });
  const guardians = Array.from({ length: 100 }, (_, index) => participant('guardian', index));
  const route = localOperationsRoute(new URL(relationshipPath, origin), 'GET');
  const project = participants => executeLocalOperations(route, manager, null, {}, {
    relationships: { get: async () => ({ conversationId: 'room-a', childId: 'child-a', version: 1, participants }) },
  });
  const allowed = [...guardians, participant('therapist'), participant('care_recipient')];
  assert.equal((await project(allowed)).body.relationships.participants.length, 102);
  for (const participants of [
    [...guardians, participant('guardian', 100)],
    [participant('therapist'), participant('therapist', 1)],
    [participant('care_recipient'), participant('care_recipient', 1)],
    [participant('center')], [participant('__proto__')],
  ]) await assert.rejects(project(participants), error => error.code === 'LOCAL_API_UNAVAILABLE');
  assert.equal((await project([...allowed, { ...participant('guardian', 100), active: false }])).body.relationships.participants.length, 102);
});

test('additional services are lazy route requirements and all new projections whitelist private service additions', async () => {
  const m = await login(); options.memberProfiles = undefined; options.relationships = undefined;
  good(await call(childrenPath, { cookie: m })); good(await post(m, childrenPath, register()), 201);
  denied(await call(membersPath, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE');
  denied(await call(relationshipPath, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE');
  denied(await post(m, relationshipPath, await command()), 503, 'LOCAL_API_UNAVAILABLE');
  const route = (path, method = 'GET') => localOperationsRoute(new URL(path, origin), method);
  assert.deepEqual(await executeLocalOperations(route(membersPath), manager, null, {}, { members: { listMembers: async () => ({
    members: [{ userId: 'guardian-a', role: 'guardian', displayName: null, email: 'PRIVATE-EMAIL', password: 'PRIVATE-PASSWORD' }], nextCursor: 'guardian-a', hasMore: false,
  }) } }), { status: 200, body: { members: [{ userId: 'guardian-a', role: 'guardian', displayName: null }], nextCursor: 'guardian-a', hasMore: false } });
  const relationship = { conversationId: 'room-a', childId: 'child-a', version: 2,
    participants: [{ userId: 'guardian-a', role: 'guardian', firstSequence: 1 }] };
  assert.deepEqual(await executeLocalOperations(route(relationshipPath), manager, null, {}, { relationships: { get: async () => ({ ...relationship,
    privateNote: 'PRIVATE-NOTE', participants: [{ ...relationship.participants[0], active: true, email: 'PRIVATE-EMAIL' },
      { userId: 'old', role: 'guardian', active: false, firstSequence: 1 }],
  }) } }), { status: 200, body: { relationships: relationship } });
  const receipt = { conversationId: 'room-a', appliedVersion: 4, changed: true, replayed: false };
  assert.deepEqual(await executeLocalOperations(route(relationshipPath, 'POST'), manager, await command(), {}, { relationships: {
    replace: async () => ({ ...receipt, requestHash: 'PRIVATE-HASH', actorId: 'PRIVATE-ACTOR' }),
  } }), { status: 200, body: { receipt } });
});
