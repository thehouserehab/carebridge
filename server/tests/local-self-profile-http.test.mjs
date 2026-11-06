// Actual HTTP/Auth/service transactions with invented identities and memory
// PGlite only. No browser, native/E database, mail or real profile information.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

const endpoint = '/api/local/centers/center-a/account/profile';
const secondEndpoint = '/api/local/centers/center-b/account/profile';
const actors = ['guardian-a', 'therapist-a', 'manager-a', 'foreign-b', 'no-center'];
const password = 'Synthetic self-profile password 2026!';
const profileKeys = ['userId', 'role', 'displayName', 'revision', 'updatedAt'].sort();
const receiptKeys = ['operation', 'userId', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const input = (extra = {}) => ({ clientId: randomUUID(), expectedRevision: 0, displayName: '가상 표시 이름', ...extra });
let db, auth, members, server, origin, options, cookies, loseNextResponse;
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutationState = () => Promise.all(['cb_member_profiles', 'cb_profile_requests'].map(raw));
const unchangedState = () => Promise.all(['cb_auth_accounts', 'cb_users', 'cb_memberships', 'cb_participants', 'cb_conversations',
  'cb_messages', 'cb_read_states', 'cb_records', 'cb_record_revisions', 'cb_record_assessments', 'cb_record_references',
  'cb_record_publications', 'cb_child_profiles', 'cb_child_family_plans', 'cb_goals', 'cb_appointments'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseNextResponse = false;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('therapist-a',true),('manager-a',true),('foreign-b',true),('no-center',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-b','guardian-a','guardian',true),
      ('center-a','therapist-a','therapist',true),('center-a','manager-a','center',true),('center-b','foreign-b','center',true);
    INSERT INTO cb_children VALUES ('center-a','child-a');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1);`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@self-profile.test`, password });
  members = new MemberProfiles(db);
  server = createServer(async (req, res) => {
    // Lose only a real successful reply, after the service commits its receipt.
    if (loseNextResponse && req.method === 'POST' && req.url === endpoint) {
      const end = res.end.bind(res);
      res.end = (...args) => {
        if (res.statusCode === 200) { loseNextResponse = false; res.destroy(); return res; }
        return end(...args);
      };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: new Conversations(db), profiles: new Children(db), memberProfiles: members,
    origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});
function call(path = endpoint, { method = 'GET', body, cookie, headers = {}, rawBody } = {}) {
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': cookies.get(cookie) } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: requestHeaders, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic self-profile HTTP timeout.')));
    req.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const post = (cookie, body, path = endpoint, headers) => call(path, { method: 'POST', cookie, body, headers });
async function login(userId = 'guardian-a') {
  const result = await post(null, { email: `${userId}@self-profile.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result) {
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['set-cookie'], undefined); return result.json;
}
function denied(result, status, code) {
  assert.equal(result.status, status); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['set-cookie'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}

test('all three active roles can read and save only their own center-scoped display metadata', async () => {
  for (const [userId, role] of [['guardian-a', 'guardian'], ['therapist-a', 'therapist'], ['manager-a', 'center']]) {
    const cookie = await login(userId), initial = good(await call(endpoint, { cookie }));
    assert.deepEqual(Object.keys(initial), ['profile']); assert.deepEqual(Object.keys(initial.profile).sort(), profileKeys);
    assert.deepEqual(initial.profile, { userId, role, displayName: null, revision: 0, updatedAt: null });
    const result = good(await post(cookie, input({ displayName: `가상 ${role}` })));
    assert.deepEqual(Object.keys(result), ['receipt']); assert.deepEqual(Object.keys(result.receipt).sort(), receiptKeys);
    assert.deepEqual(result.receipt, { operation: 'member.save', userId, childId: null, conversationId: null,
      appliedVersion: 1, changed: true, replayed: false });
    const profile = good(await call(endpoint, { cookie })).profile;
    assert.equal(profile.displayName, `가상 ${role}`); assert.equal(profile.revision, 1); assert.ok(Number.isFinite(Date.parse(profile.updatedAt)));
    for (const value of [JSON.stringify(profile), JSON.stringify(result)]) assert.doesNotMatch(value, /email|password|token|centerId|privateNote/);
  }
});
test('same account in two centers has independent names, versions and receipts; a foreign member cannot select another center', async () => {
  const cookie = await login(), original = input({ displayName: '가상 첫 센터 이름' });
  good(await post(cookie, original));
  good(await post(cookie, { ...original, displayName: '가상 둘째 센터 이름' }, secondEndpoint));
  assert.equal(good(await call(endpoint, { cookie })).profile.displayName, original.displayName);
  assert.equal(good(await call(secondEndpoint, { cookie })).profile.displayName, '가상 둘째 센터 이름');
  denied(await call(endpoint, { cookie: await login('foreign-b') }), 404, 'NOT_FOUND');
  denied(await post(await login('no-center'), input()), 404, 'NOT_FOUND');
});
test('authentication and expected-account binding precede self-profile reads and writes', async () => {
  denied(await call(), 401, 'AUTH_REQUIRED'); denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  const cookie = await login();
  for (const account of [undefined, 'therapist-a']) {
    denied(await call(endpoint, { cookie, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    denied(await post(cookie, input(), endpoint, { 'X-Carebridge-Account': account }), 401, 'AUTH_REQUIRED');
  }
  assert.equal((await raw('cb_member_profiles')).length, 0); assert.equal((await raw('cb_profile_requests')).length, 0);
});
test('source, CSRF and strict closed route parsing do not create a self-profile shortcut', async () => {
  const cookie = await login();
  for (const headers of [{ Origin: 'https://outside.test' }, { Origin: undefined }, { 'X-Carebridge-Request': undefined },
    { Host: 'localhost:4180' }, { 'Sec-Fetch-Site': 'same-site' }]) denied(await post(cookie, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(cookie, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  for (const method of ['PUT', 'PATCH', 'DELETE']) denied(await call(endpoint, { cookie, method }), 404, 'NOT_FOUND');
  for (const suffix of ['/guardian-a', '/', '/save']) denied(await call(`${endpoint}${suffix}`, { cookie }), 404, 'NOT_FOUND');
  for (const suffix of ['?userId=therapist-a', '?role=center', '?x=1&x=2']) {
    denied(await call(`${endpoint}${suffix}`, { cookie }), 400, 'INVALID_INPUT');
    denied(await post(cookie, input(), `${endpoint}${suffix}`), 400, 'INVALID_INPUT');
  }
});
test('overposted authority/credentials and malformed names or versions are rejected before mutation', async () => {
  const cookie = await login(), before = await mutationState(), base = input();
  for (const extra of [{ userId: 'therapist-a' }, { role: 'center' }, { email: 'other@self-profile.test' },
    { centerId: 'center-b' }, { privateNote: 'PRIVATE-REJECT' }, { content: {} }])
    denied(await post(cookie, { ...base, ...extra }), 400, 'INVALID_INPUT');
  for (const key of Object.keys(base)) { const missing = { ...base }; delete missing[key]; denied(await post(cookie, missing), 400, 'INVALID_INPUT'); }
  for (const displayName of ['', ' ', '\t가상', '가상\n', '가상\r', '가상\u0085', '\ud800', 'x'.repeat(31), 0, {}, false])
    denied(await post(cookie, input({ displayName })), 400, 'INVALID_INPUT');
  for (const expectedRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1])
    denied(await post(cookie, input({ expectedRevision })), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { method: 'POST', cookie, rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
});
test('normalization, no-op, explicit null clear and exact replay never resurrect an old name', async () => {
  const cookie = await login(), first = input({ displayName: ' 가상 표시명 ' });
  assert.equal(good(await post(cookie, first)).receipt.appliedVersion, 1);
  assert.equal(good(await call(endpoint, { cookie })).profile.displayName, '가상 표시명');
  const noOp = good(await post(cookie, input({ expectedRevision: 1, displayName: '가상 표시명' }))).receipt;
  assert.equal(noOp.changed, false); assert.equal(noOp.appliedVersion, 1);
  const cleared = good(await post(cookie, input({ expectedRevision: 1, displayName: null }))).receipt;
  assert.equal(cleared.appliedVersion, 2); assert.equal(cleared.changed, true);
  const replay = good(await post(cookie, first)).receipt; assert.equal(replay.appliedVersion, 1); assert.equal(replay.replayed, true);
  assert.equal(good(await call(endpoint, { cookie })).profile.displayName, null);
  denied(await post(cookie, { ...first, displayName: '다른 가상 내용' }), 409, 'IDEMPOTENCY_CONFLICT');
});
test('two same-account sessions see a real stale-version conflict without an extra receipt or overwrite', async () => {
  const first = await login(), second = await login(), winner = input({ displayName: '가상 선행 저장' });
  good(await call(endpoint, { cookie: first })); good(await call(endpoint, { cookie: second }));
  good(await post(first, winner)); const before = await mutationState();
  denied(await post(second, input({ displayName: '가상 오래된 입력' })), 409, 'PROFILE_CONFLICT');
  assert.deepEqual(await mutationState(), before); assert.equal(good(await call(endpoint, { cookie: second })).profile.displayName, winner.displayName);
});
test('lost committed response replays exactly once, even after a later profile update', async () => {
  const cookie = await login(), lost = input({ displayName: '가상 응답 유실' }); loseNextResponse = true;
  await assert.rejects(post(cookie, lost), value => value?.code === 'ECONNRESET');
  assert.equal((await raw('cb_profile_requests')).length, 1);
  const replay = good(await post(cookie, lost)).receipt; assert.equal(replay.replayed, true); assert.equal(replay.appliedVersion, 1);
  good(await post(cookie, input({ expectedRevision: 1, displayName: '가상 더 최신 이름' })));
  assert.deepEqual(good(await post(cookie, lost)).receipt, replay);
  assert.equal(good(await call(endpoint, { cookie })).profile.displayName, '가상 더 최신 이름');
  assert.equal((await raw('cb_profile_requests')).length, 2);
});
test('current membership is rechecked after authentication for GET, POST and committed replay', async () => {
  const cookie = await login(), saved = input(); good(await post(cookie, saved)); const baseline = await mutationState();
  const authenticate = auth.authenticate.bind(auth);
  for (const action of ['read', 'write', 'replay']) {
    await db.query("UPDATE cb_memberships SET active=true WHERE center_id='center-a' AND user_id='guardian-a'");
    auth.authenticate = async token => {
      const value = await authenticate(token);
      await db.query("UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='guardian-a'");
      return value; // Deliberately stale authenticated projection; service must deny.
    };
    const result = action === 'read' ? await call(endpoint, { cookie }) : await post(cookie,
      action === 'replay' ? saved : input({ expectedRevision: 1, displayName: '가상 금지 변경' }));
    denied(result, 404, 'NOT_FOUND'); assert.deepEqual(await mutationState(), baseline);
  }
  auth.authenticate = authenticate;
});
test('disabled accounts cannot read or replay; child relationship removal does not erase self-membership rights', async () => {
  const cookie = await login(), saved = input(); good(await post(cookie, saved));
  await db.query("UPDATE cb_participants SET active=false WHERE center_id='center-a' AND user_id='guardian-a'");
  assert.equal(good(await call(endpoint, { cookie })).profile.revision, 1);
  assert.equal(good(await post(cookie, saved)).receipt.replayed, true);
  await db.query("UPDATE cb_users SET active=false WHERE id='guardian-a'");
  denied(await call(endpoint, { cookie }), 401, 'AUTH_REQUIRED'); denied(await post(cookie, saved), 401, 'AUTH_REQUIRED');
});
test('profile updates change current same-center labels without any credential, relationship, clinical or read-state writes', async () => {
  const cookie = await login();
  const message = await options.conversations.sendText({ centerId: 'center-a', userId: 'guardian-a' },
    { conversationId: 'room-a', clientId: randomUUID(), body: '가상 보존할 대화 원문' });
  await options.conversations.markRead({ centerId: 'center-a', userId: 'therapist-a' },
    { conversationId: 'room-a', messageId: message.id });
  const baseline = await unchangedState();
  good(await post(cookie, input({ displayName: '가상 <b>문자 그대로</b>' })));
  assert.deepEqual(await unchangedState(), baseline);
  const manager = await login('manager-a');
  const listed = good(await call('/api/local/centers/center-a/operations/members', { cookie: manager }));
  assert.equal(listed.members.find(member => member.userId === 'guardian-a').displayName, '가상 <b>문자 그대로</b>');
  const room = '/api/local/centers/center-a/conversations/room-a';
  assert.equal(good(await call(`${room}/profile`, { cookie })).participants.find(member => member.userId === 'guardian-a').displayName, '가상 <b>문자 그대로</b>');
  for (const suffix of ['profile', 'messages']) denied(await call(`${room}/${suffix}`, { cookie: manager }), 404, 'NOT_FOUND');
});
test('absent optional member service fails only this route, while valid existing session paths still work', async () => {
  const cookie = await login(); delete options.memberProfiles;
  denied(await call(endpoint, { cookie }), 503, 'LOCAL_API_UNAVAILABLE'); denied(await post(cookie, input()), 503, 'LOCAL_API_UNAVAILABLE');
  assert.equal((await call('/api/local/auth/session', { cookie })).status, 200);
  options.memberProfiles = { getSelf: async () => { throw new Error('PRIVATE-raw-service-diagnostic'); } };
  denied(await call(endpoint, { cookie }), 503, 'LOCAL_API_UNAVAILABLE');
});
test('MAX_SAFE revision permits a no-op but a changed value fails safely without another receipt', async () => {
  const cookie = await login(); good(await post(cookie, input()));
  // Synthetic boundary setup only: no product guard or schema is changed.
  // Restore the version guard in this same isolated transaction before HTTP.
  await db.transaction(async tx => {
    await tx.query('ALTER TABLE cb_member_profiles DISABLE TRIGGER cb_member_profile_guard');
    await tx.query("UPDATE cb_member_profiles SET revision=$1 WHERE center_id='center-a' AND user_id='guardian-a'", [Number.MAX_SAFE_INTEGER]);
    await tx.query('ALTER TABLE cb_member_profiles ENABLE TRIGGER cb_member_profile_guard');
  });
  const noOp = good(await post(cookie, input({ expectedRevision: Number.MAX_SAFE_INTEGER }))).receipt;
  assert.equal(noOp.changed, false); assert.equal(noOp.appliedVersion, Number.MAX_SAFE_INTEGER);
  const before = await mutationState();
  denied(await post(cookie, input({ expectedRevision: Number.MAX_SAFE_INTEGER, displayName: '가상 새 값' })), 409, 'REVISION_LIMIT');
  assert.deepEqual(await mutationState(), before);
});
