import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Invented accounts in memory only. No DATABASE_URL, persistent directory,
// native PostgreSQL, E drive, existing browser, email, or external listener.
let db, auth, conversations, profiles, server, options, origin, cookieName;
let cookieAccounts;
const password = 'Synthetic-only password 2026!';
const therapist = { userId: 'therapist-a', centerId: 'center-a' };
const guardian = { userId: 'guardian-a', centerId: 'center-a' };
const manager = { userId: 'manager-a', centerId: 'center-a' };
const base = '/api/local/centers/center-a';
const room = `${base}/conversations/room-a`;
const messageKeys = ['id', 'conversationId', 'childId', 'sequence', 'authorId', 'createdAt', 'type', 'body',
  'read', 'edited', 'hidden', 'deleted', 'archived', 'version', 'canReply', 'reviewed', 'canEdit', 'canDeleteAll', 'canHide', 'attachmentCount'].sort();
const input = (extra = {}) => ({ clientId: 'local-send-0001', body: '합성 대화만 확인합니다.', ...extra });

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});
beforeEach(async () => {
  cookieAccounts = new Map();
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),
      ('manager-a',true),('stranger-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','manager-a','center',true),
      ('center-a','stranger-a','guardian',true),('center-b','foreign-b','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),
      ('center-b','room-b','foreign-b','guardian',true,1);`);
  // Small work factor is ONLY the existing Auth test constructor option.
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of ['therapist-a', 'guardian-a', 'manager-a', 'stranger-a', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@local.test`, password });
  conversations = new Conversations(db); profiles = new Children(db);
  await profiles.save(manager, { conversationId: 'room-a', clientId: 'profile-seed-0001', expectedRevision: 0, content: { name: '합성 하루' } });
  const members = new MemberProfiles(db);
  await members.saveSelf(therapist, { clientId: 'member-seed-0001', expectedRevision: 0, displayName: '합성 치료사' });
  await members.saveSelf(guardian, { clientId: 'member-seed-0002', expectedRevision: 0, displayName: '합성 보호자' });
  cookieName = `cb_local_${randomBytes(16).toString('hex')}`;
  server = createServer(async (req, res) => {
    const handled = await handleLocalApiRequest(req, res, options);
    if (!handled) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations, profiles, origin, cookieName };
});

function call(path, { method = 'GET', body, cookie, headers = {}, raw, rawHeaders } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const combined = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, ...(cookieAccounts.has(cookie) ? { 'X-Carebridge-Account': cookieAccounts.get(cookie) } : {}) } : {}), ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: rawHeaders ?? combined, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { if (text) json = JSON.parse(text); } catch { /* inspected as text by the assertion */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.once('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Synthetic HTTP request timed out.')));
    req.end(payload);
  });
}
async function login(userId = 'guardian-a') {
  const result = await call('/api/local/auth/login', { method: 'POST', body: { email: `${userId}@local.test`, password } });
  assert.equal(result.status, 200);
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  cookieAccounts.set(cookie, userId);
  return { cookie, result };
}
async function send(cookie, extra = {}) {
  const result = await call(`${room}/messages`, { method: 'POST', cookie, body: input(extra) });
  assert.equal(result.status, 201);
  return result.json.message;
}
const checkError = (result, status, code) => {
  assert.equal(result.status, status);
  assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
};

test('real Auth login/session/logout uses only a per-run HttpOnly Strict path cookie, never JSON credentials', async () => {
  const { cookie, result } = await login();
  assert.deepEqual(Object.keys(result.json), ['user']);
  assert.deepEqual(Object.keys(result.json.user).sort(), ['userId', 'email', 'centers', 'expiresAt'].sort());
  assert.deepEqual(result.json.user.centers, [{ id: 'center-a', role: 'guardian' }]);
  assert.equal(result.json.user.userId, guardian.userId);
  assert(result.headers['set-cookie'][0].includes('Path=/api/local/; HttpOnly; SameSite=Strict; Max-Age='));
  assert(!result.headers['set-cookie'][0].includes('Domain='));
  assert(!result.text.includes(cookie.split('=')[1]));
  assert(!result.text.includes(password));
  assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  const session = await call('/api/local/auth/session', { cookie });
  assert.equal(session.status, 200); assert.deepEqual(session.json, result.json);
  const logout = await call('/api/local/auth/logout', { method: 'POST', body: {}, cookie });
  assert.equal(logout.status, 204); assert.equal(logout.text, '');
  assert(logout.headers['set-cookie'][0].endsWith('Max-Age=0'));
  checkError(await call('/api/local/auth/session', { cookie }), 401, 'AUTH_REQUIRED');
  assert.equal((await call('/api/local/auth/logout', { method: 'POST', body: {} })).status, 204);
});

test('wrong and unknown account receive the same safe response; no session is minted', async () => {
  const bad = await call('/api/local/auth/login', { method: 'POST', body: { email: 'guardian-a@local.test', password: 'incorrect synthetic password' } });
  const absent = await call('/api/local/auth/login', { method: 'POST', body: { email: 'absent@local.test', password } });
  checkError(bad, 401, 'AUTH_INVALID'); assert.deepEqual(absent.json, bad.json);
  assert.equal(absent.status, bad.status); assert.equal(bad.headers['set-cookie'], undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n, 0);
});

test('protected paths require an authenticated cookie, not body/query/header user or role authority', async () => {
  for (const path of ['/api/local/auth/session', `${base}/inbox`, `${room}/profile`, `${room}/messages`])
    checkError(await call(path, { headers: { 'X-User-Id': therapist.userId, 'X-Role': 'therapist' } }), 401, 'AUTH_REQUIRED');
  checkError(await call(`${room}/messages`, { method: 'POST', body: input({ userId: therapist.userId }) }), 401, 'AUTH_REQUIRED');
  const { cookie } = await login();
  for (const field of ['userId', 'centerId', 'role', 'conversationId', 'attachments', 'quote'])
    checkError(await call(`${room}/messages`, { method: 'POST', cookie, body: input({ [field]: 'forged' }) }), 400, 'INVALID_INPUT');
  const sent = await send(cookie);
  assert.equal(sent.authorId, guardian.userId);
});

test('exact Host, Origin, Fetch Metadata and custom mutation header are required without CORS fallback', async () => {
  const body = { email: 'guardian-a@local.test', password };
  for (const headers of [
    { Host: 'localhost:9999' }, { Host: 'attacker.test' }, { Host: '127.0.0.1' },
    { Origin: undefined }, { Origin: 'null' }, { Origin: `${origin}/` },
    { Origin: 'http://127.0.0.1:1' }, { 'X-Carebridge-Request': undefined },
    { 'X-Carebridge-Request': 'true' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) checkError(await call('/api/local/auth/login', { method: 'POST', body, headers }), 403, 'SOURCE_REJECTED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n, 0);
  const { cookie } = await login();
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://attacker.test' }])
    checkError(await call(`${base}/inbox`, { cookie, headers }), 403, 'SOURCE_REJECTED');
  assert.equal((await call(`${base}/inbox`, { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  checkError(await call('/api/local/auth/logout', { cookie, method: 'POST', body: {}, headers: { Origin: undefined } }), 403, 'SOURCE_REJECTED');
  assert.equal((await call('/api/local/auth/session', { cookie })).status, 200);
});

test('duplicate security headers and duplicate session or unrelated cookies are rejected', async () => {
  const { cookie } = await login(), host = new URL(origin).host;
  for (const value of [`${cookie}; ${cookie}`, `${cookie}; other=1; other=2`])
    checkError(await call('/api/local/auth/session', { cookie: value }), 400, 'INVALID_INPUT');
  for (const pair of [['Host', host], ['Cookie', cookie], ['Origin', origin], ['X-Carebridge-Request', '1'], ['Content-Type', 'application/json']]) {
    const rawHeaders = ['Host', host, 'Content-Type', 'application/json', 'Origin', origin, 'X-Carebridge-Request', '1', 'Cookie', cookie, ...pair];
    checkError(await call('/api/local/auth/logout', { method: 'POST', body: {}, rawHeaders }), 400, 'INVALID_INPUT');
  }
  checkError(await call('/api/local/auth/session', { cookie: `${cookieName}=%20` }), 401, 'AUTH_REQUIRED');
  checkError(await call('/api/local/auth/session', { cookie: cookie.replace(cookieName, 'cb_local_0000000000000000') }), 401, 'AUTH_REQUIRED');
});

test('only JSON UTF-8, bounded object bodies and exact mutation keys are accepted', async () => {
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json; charset=latin1'])
    checkError(await call('/api/local/auth/login', { method: 'POST', body: {}, headers: { 'Content-Type': contentType } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  checkError(await call('/api/local/auth/login', { method: 'POST', body: {}, headers: { 'Content-Encoding': 'gzip' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  for (const raw of ['', '{', 'null', '[]', '"text"', '{"email":"x","password":"x","role":"guardian"}', Buffer.from([0xff, 0xfe])])
    checkError(await call('/api/local/auth/login', { method: 'POST', raw }), 400, 'INVALID_INPUT');
  checkError(await call('/api/local/auth/login', { method: 'POST', raw: JSON.stringify({ email: 'x', password: 'x'.repeat(17000) }) }), 413, 'PAYLOAD_TOO_LARGE');
  const { cookie } = await login();
  for (const body of [input({ body: '' }), input({ body: ' '.repeat(4) }), input({ body: 'x'.repeat(2001) }),
    input({ body: '\ud800' }), input({ body: '\u0000' }), input({ clientId: 'short' }), { body: 'missing ID' }])
    checkError(await call(`${room}/messages`, { method: 'POST', cookie, body }), 400, 'INVALID_INPUT');
  checkError(await call(`${room}/read`, { method: 'POST', cookie, body: { messageId: 'id', sequence: 100 } }), 400, 'INVALID_INPUT');
  checkError(await call('/api/local/auth/logout', { method: 'POST', cookie, body: { redirect: '/' } }), 400, 'INVALID_INPUT');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, 0);
});

test('declared oversized requests and a slow unfinished body are bounded before Auth work', async () => {
  checkError(await call('/api/local/auth/login', { method: 'POST', raw: '{}', headers: { 'Content-Length': '17000' } }), 413, 'PAYLOAD_TOO_LARGE');
  let active;
  try {
    const result = await new Promise((resolve, reject) => {
      active = request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/local/auth/login', method: 'POST', agent: false,
        headers: { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json', 'Content-Length': '100' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      active.once('error', reject);
      active.setTimeout(8000, () => active.destroy(new Error('Synthetic timeout guard failed.')));
      active.write('{');
    });
    checkError(result, 408, 'REQUEST_TIMEOUT');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n, 0);
  } finally { active?.destroy(); }
});

test('query parsing rejects duplicates, unknown identity, malformed integers and oversized pagination', async () => {
  const { cookie } = await login();
  for (const query of ['?limit=1&limit=2', '?role=therapist', '?after=-1', '?after=1.5', '?after=1e2', '?after=01',
    '?after=9007199254740992', '?limit=0', '?limit=101', '?expectedRevision=bad', '?after=', '?expectedSnapshot=abc'])
    checkError(await call(`${room}/messages${query}`, { cookie }), 400, 'INVALID_INPUT');
  for (const query of ['?offset=1', '?limit=101', '?expectedSnapshot=abc', '?expectedSnapshot=' + 'a'.repeat(32) + '&expectedSnapshot=' + 'b'.repeat(32)])
    checkError(await call(`${base}/inbox${query}`, { cookie }), 400, 'INVALID_INPUT');
  for (const path of ['/api/local/auth/session?token=not-accepted', `${room}/profile?userId=guardian-a`])
    checkError(await call(path, { cookie }), 400, 'INVALID_INPUT');
});

test('unknown, legacy, encoded and wrong-method routes do not mount old auth, email, files or provisioning', async () => {
  const { cookie } = await login();
  for (const path of ['/api/auth/invitations', '/api/local/auth/invitations', '/api/local/auth/recovery',
    '/api/local/auth/register', `${room}/attachments`, `${room}/records/record-a/delete`, `${room}/messages/`,
    '/api/local/centers/center-a/conversations/room%2Da/messages', '/api/local/./auth/session',
    '/api/local/centers/center-a/conversations/../messages', '/api/local/unknown'])
    checkError(await call(path, { cookie }), 404, 'NOT_FOUND');
  checkError(await call('/api/local/auth/login', { cookie }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/messages`, { method: 'DELETE', cookie }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/messages`, { method: 'OPTIONS', cookie }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/profile`, { method: 'POST', body: {}, cookie }), 404, 'NOT_FOUND');
});

test('authenticated cross-center, unassigned child and center-manager clinical requests fail closed', async () => {
  const { cookie } = await login();
  for (const path of ['/api/local/centers/center-b/inbox', '/api/local/centers/center-b/conversations/room-b/messages',
    `${base}/conversations/room-other/messages`, `${base}/conversations/room-other/profile`])
    checkError(await call(path, { cookie }), 404, 'NOT_FOUND');
  checkError(await call(`${base}/conversations/room-other/messages`, { method: 'POST', cookie, body: input() }), 404, 'NOT_FOUND');
  for (const user of ['manager-a', 'stranger-a', 'foreign-b']) {
    const session = await login(user);
    checkError(await call(`${room}/messages`, { cookie: session.cookie }), 404, 'NOT_FOUND');
    checkError(await call(`${room}/profile`, { cookie: session.cookie }), 404, 'NOT_FOUND');
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, 0);
});

test('real two-account home to text send/read updates unread without exposing internal review or author spoofing', async () => {
  const g = await login(), t = await login('therapist-a');
  const message = await send(g.cookie);
  assert.deepEqual(Object.keys(message).sort(), messageKeys); assert.equal(message.read, false);
  const before = await call(`${base}/inbox`, { cookie: t.cookie });
  const entry = before.json.rooms.find((row) => row.conversationId === 'room-a');
  assert.equal(entry.unread, 1); assert.equal(entry.targetId, message.id); assert.equal(entry.latest.body, message.body);
  assert.equal((await call(`${base}/inbox`, { cookie: g.cookie })).json.rooms[0].unread, 0);
  const listed = await call(`${room}/messages`, { cookie: t.cookie });
  assert.equal(listed.json.messages[0].id, message.id); assert.equal(listed.json.lastRead, 0);
  const marked = await call(`${room}/read`, { method: 'POST', cookie: t.cookie, body: { messageId: message.id } });
  assert.equal(marked.status, 200); assert.equal(marked.json.lastRead, message.sequence);
  assert.equal((await call(`${room}/messages`, { cookie: g.cookie })).json.messages[0].read, true);
  assert.equal((await call(`${base}/inbox`, { cookie: t.cookie })).json.rooms.find((row) => row.conversationId === 'room-a').unread, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_message_reviews')).rows[0].n, 0);
});

test('same clientId retry preserves one committed message, changed retry conflicts', async () => {
  const { cookie } = await login();
  const first = await send(cookie), again = await send(cookie);
  assert.equal(first.id, again.id); assert.equal(first.sequence, again.sequence);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, 1);
  checkError(await call(`${room}/messages`, { method: 'POST', cookie, body: input({ body: 'different retry' }) }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call(`${room}/messages`, { cookie })).json.messages[0].body, first.body);
});

test('paged message and inbox snapshots require reset after intervening send/read changes', async () => {
  const g = await login(), t = await login('therapist-a');
  const first = await send(g.cookie);
  const list = (await call(`${room}/messages?limit=1`, { cookie: t.cookie })).json;
  const home = (await call(`${base}/inbox?limit=1`, { cookie: t.cookie })).json;
  await send(g.cookie, { clientId: 'local-send-0002', body: '두 번째 소식' });
  const stale = (await call(`${room}/messages?after=${first.sequence}&expectedRevision=${list.revision}`, { cookie: t.cookie })).json;
  assert.deepEqual(Object.keys(stale).sort(), ['resetRequired', 'revision']); assert.equal(stale.resetRequired, true);
  const staleHome = (await call(`${base}/inbox?offset=1&expectedSnapshot=${home.snapshot}`, { cookie: t.cookie })).json;
  assert.deepEqual(Object.keys(staleHome).sort(), ['resetRequired', 'snapshot']); assert.equal(staleHome.resetRequired, true);
  const refreshed = (await call(`${room}/messages?limit=1`, { cookie: t.cookie })).json;
  const next = (await call(`${room}/messages?after=${refreshed.nextCursor}&expectedRevision=${refreshed.revision}&limit=1`, { cookie: t.cookie })).json;
  assert.equal(refreshed.hasMore, true); assert.equal(next.messages.length, 1); assert.equal(next.hasMore, false);
});

test('profile returns allowlisted current child and family context to the connected clinical team', async () => {
  await profiles.saveFamilyPlan(guardian, { conversationId: 'room-a', clientId: 'family-shared-0001', expectedRevision: 0, concern: '함께 확인할 합성 관심사' });
  const expected = await profiles.get(guardian, { conversationId: 'room-a' });
  for (const userId of ['guardian-a', 'therapist-a']) {
    const { cookie } = await login(userId);
    const result = await call(`${room}/profile`, { cookie });
    assert.equal(result.status, 200); assert.equal(result.json.name, '합성 하루');
    assert.deepEqual(Object.keys(result.json).sort(), ['age', 'ageAsOf', 'childId', 'conversationId', 'familyPlan', 'name', 'participants', 'revision']);
    assert.equal(result.json.age, null); assert.equal(result.json.ageAsOf, null); assert.equal(result.json.revision, 1);
    assert.deepEqual(result.json.familyPlan, expected.familyPlan);
    assert.deepEqual(Object.keys(result.json.familyPlan).sort(), ['concern', 'revision', 'updatedAt']);
    for (const p of result.json.participants) assert.deepEqual(Object.keys(p).sort(), ['displayName', 'role', 'userId']);
    assert.deepEqual(result.json.participants.map((p) => p.displayName).sort(), ['합성 보호자', '합성 치료사'].sort());
    assert(!result.text.includes('PRIVATE-')); assert(!result.text.includes('stranger-a'));
  }
});

test('profile age preserves explicit zero, basis date and unknown without broadening writes', async () => {
  const { cookie } = await login();
  await profiles.save(manager, { conversationId: 'room-a', clientId: 'age-zero-0001', expectedRevision: 1,
    content: { name: '합성 하루', age: 0, ageAsOf: '2026-01-01' } });
  let result = await call(`${room}/profile`, { cookie });
  assert.equal(result.status, 200); assert.equal(result.json.age, 0);
  assert.equal(result.json.ageAsOf, '2026-01-01'); assert.equal(result.json.revision, 2);
  assert.deepEqual(result.json.familyPlan, { concern: '', revision: 0, updatedAt: null });
  await profiles.save(manager, { conversationId: 'room-a', clientId: 'age-unknown-0001', expectedRevision: 2,
    content: { name: '합성 하루', age: null, ageAsOf: null } });
  result = await call(`${room}/profile`, { cookie });
  assert.equal(result.json.age, null); assert.equal(result.json.ageAsOf, null); assert.equal(result.json.revision, 3);
  checkError(await call(`${room}/profile`, { method: 'POST', cookie, body: { age: 8, concern: 'injected' } }), 404, 'NOT_FOUND');
  assert.equal((await profiles.get(guardian, { conversationId: 'room-a' })).revision, 3);
});

test('profile detail projection strips unrelated service fields and denies center or ended relationships', async () => {
  await profiles.saveFamilyPlan(guardian, { conversationId: 'room-a', clientId: 'family-privacy-0001', expectedRevision: 0, concern: '합성 가족 관심사' });
  options.profiles = { get: async (...args) => {
    const p = await profiles.get(...args);
    return { ...p, diagnosis: 'PRIVATE-CLINICAL-MARKER', token: 'PRIVATE-TOKEN',
      familyPlan: { ...p.familyPlan, internalNote: 'PRIVATE-PLAN-NOTE' },
      participants: p.participants.map((member) => ({ ...member, email: 'PRIVATE-EMAIL' })) };
  } };
  const { cookie } = await login();
  const visible = await call(`${room}/profile`, { cookie });
  assert.equal(visible.status, 200); assert.equal(visible.json.familyPlan.concern, '합성 가족 관심사');
  assert(!visible.text.includes('PRIVATE-'));
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b']) {
    const denied = await call(`${room}/profile`, { cookie: (await login(userId)).cookie });
    checkError(denied, 404, 'NOT_FOUND'); assert(!denied.text.includes('합성 가족 관심사'));
  }
  const relationships = new Relationships(db), state = await relationships.get(manager, { conversationId: 'room-a' });
  await relationships.replace(manager, { conversationId: 'room-a', clientId: 'profile-remove-0001', expectedVersion: state.version,
    therapist: { userId: therapist.userId, history: 'preserve' }, guardians: [], historyConfirmed: true });
  const ended = await call(`${room}/profile`, { cookie });
  checkError(ended, 404, 'NOT_FOUND'); assert(!ended.text.includes('합성 가족 관심사'));
});

test('text projection allows authorized quotes but excludes private reviews and injected attachment and record metadata', async () => {
  const { cookie } = await login('therapist-a');
  const source = await conversations.sendText(guardian, { conversationId: 'room-a', ...input() });
  await conversations.review(therapist, { conversationId: 'room-a', messageId: source.id, note: 'PRIVATE-REVIEW-MARKER' });
  const reply = await conversations.sendText(therapist, { conversationId: 'room-a', ...input({ clientId: 'local-reply-0001', body: '인용의 본문' }), replyTo: source.id });
  const rawList = conversations.list.bind(conversations), rawInbox = conversations.inbox.bind(conversations);
  const secrets = { internalReview: 'PRIVATE-INTERNAL', attachments: [{ object_key: 'PRIVATE-PATH' }], record: { note: 'PRIVATE-RECORD' }, token: 'PRIVATE-TOKEN' };
  options.conversations = { ...conversations, sendText: conversations.sendText.bind(conversations), markRead: conversations.markRead.bind(conversations),
    list: async (...args) => { const page = await rawList(...args); return { ...page, secrets, messages: page.messages.map((m) => ({ ...m, ...secrets })) }; },
    inbox: async (...args) => { const page = await rawInbox(...args); return { ...page, secrets, rooms: page.rooms.map((r) => ({ ...r, secrets, latest: r.latest ? { ...r.latest, ...secrets } : null })) }; } };
  const list = await call(`${room}/messages`, { cookie });
  assert.equal(list.status, 200); assert(!list.text.includes('PRIVATE-'));
  assert.equal(list.json.messages.at(-1).id, reply.id);
  for (const m of list.json.messages) assert.deepEqual(Object.keys(m).filter((key) => key !== 'quote').sort(), messageKeys);
  assert.equal(list.json.messages.at(-1).quote.body, source.body);
  const home = await call(`${base}/inbox`, { cookie }); assert.equal(home.status, 200); assert(!home.text.includes('PRIVATE-'));
});

test('nontext cards expose the authorized public snapshot while retaining cursor positions', async () => {
  const card = await conversations.publishSnapshot(therapist, { conversationId: 'room-a', clientId: 'local-share-0001',
    recordId: 'public-record-id', title: '공유 제목', summary: '공유 요약' });
  const { cookie } = await login();
  for (const path of [`${room}/messages`, `${base}/inbox`]) {
    const result = await call(path, { cookie }); assert.equal(result.status, 200); assert(!result.text.includes('PRIVATE-'));
  }
  const message = (await call(`${room}/messages`, { cookie })).json.messages[0];
  assert.equal(message.id, card.id); assert.equal(message.type, 'publication'); assert.equal(message.sequence, card.sequence);
  assert.equal(message.publication.recordId, 'public-record-id');
  assert.equal(message.publication.title, '공유 제목'); assert.equal(message.publication.summary, '공유 요약');
});

test('session revocation, user deactivation and membership removal deny subsequent requests', async () => {
  const g = await login(), t = await login('therapist-a');
  await auth.revokeAll(guardian.userId);
  checkError(await call(`${room}/messages`, { cookie: g.cookie }), 401, 'AUTH_REQUIRED');
  await db.query('UPDATE cb_users SET active=false WHERE id=$1', [therapist.userId]);
  checkError(await call(`${base}/inbox`, { cookie: t.cookie }), 401, 'AUTH_REQUIRED');
  await db.query('UPDATE cb_users SET active=true WHERE id=$1', [therapist.userId]);
  await db.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [therapist.centerId, therapist.userId]);
  checkError(await call(`${room}/profile`, { cookie: t.cookie }), 404, 'NOT_FOUND');
});

test('expected-account header is a mandatory protected precondition, never an identity substitute', async () => {
  const g = await login();
  for (const path of [`${base}/inbox`, `${room}/profile`, `${room}/messages`]) {
    for (const value of [undefined, therapist.userId, 'bad account'])
      checkError(await call(path, { cookie: g.cookie, headers: { 'X-Carebridge-Account': value } }), 401, 'AUTH_REQUIRED');
  }
  checkError(await call(`${room}/messages`, { method: 'POST', cookie: g.cookie,
    headers: { 'X-Carebridge-Account': undefined }, body: input() }), 401, 'AUTH_REQUIRED');
  checkError(await call(`${base}/inbox`, { headers: { 'X-Carebridge-Account': guardian.userId } }), 401, 'AUTH_REQUIRED');
  assert.equal((await call('/api/local/auth/session', { cookie: g.cookie, headers: { 'X-Carebridge-Account': undefined } })).status, 200);
  checkError(await call('/api/local/auth/session', { cookie: g.cookie, headers: { 'X-Carebridge-Account': therapist.userId } }), 401, 'AUTH_REQUIRED');
  checkError(await call('/api/local/auth/login', { method: 'POST', body: { email: 'guardian-a@local.test', password },
    headers: { 'X-Carebridge-Account': guardian.userId } }), 400, 'INVALID_INPUT');
  const rawHeaders = ['Host', new URL(origin).host, 'Cookie', g.cookie,
    'X-Carebridge-Account', guardian.userId, 'X-Carebridge-Account', guardian.userId];
  checkError(await call(`${base}/inbox`, { rawHeaders }), 400, 'INVALID_INPUT');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, 0);
});

test('cookie account switch blocks old-tab reads, immutable retry and read receipt before any new-author mutation', async () => {
  const g = await login(), sent = await send(g.cookie);
  const t = await login('therapist-a');
  // The browser replaced the shared cookie, but the originating tab still
  // expects guardian-a and must NOT replay its clientId under therapist-a.
  const oldTab = { cookie: t.cookie, headers: { 'X-Carebridge-Account': guardian.userId } };
  for (const path of ['/api/local/auth/session', `${base}/inbox`, `${room}/profile`, `${room}/messages`]) {
    const result = await call(path, oldTab);
    checkError(result, 401, 'AUTH_REQUIRED');
    assert(!result.text.includes(sent.body));
    assert(!result.text.includes('합성 하루'));
  }
  checkError(await call(`${room}/messages`, { ...oldTab, method: 'POST', body: input() }), 401, 'AUTH_REQUIRED');
  checkError(await call(`${room}/read`, { ...oldTab, method: 'POST', body: { messageId: sent.id } }), 401, 'AUTH_REQUIRED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_read_states')).rows[0].n, 0);
  assert.equal((await call(`${room}/messages`, { cookie: t.cookie })).json.messages[0].authorId, guardian.userId);
});

test('old-tab logout never revokes a replacement account; expired or missing sessions remain idempotent', async () => {
  const g = await login(), t = await login('therapist-a');
  const mismatch = await call('/api/local/auth/logout', { method: 'POST', body: {}, cookie: t.cookie,
    headers: { 'X-Carebridge-Account': guardian.userId } });
  checkError(mismatch, 401, 'AUTH_REQUIRED'); assert.equal(mismatch.headers['set-cookie'], undefined);
  assert.equal((await call('/api/local/auth/session', { cookie: t.cookie })).status, 200);
  await auth.revokeAll(guardian.userId);
  const expired = await call('/api/local/auth/logout', { method: 'POST', body: {}, cookie: g.cookie });
  assert.equal(expired.status, 204); assert(expired.headers['set-cookie'][0].endsWith('Max-Age=0'));
  assert.equal((await call('/api/local/auth/logout', { method: 'POST', body: {}, headers: { 'X-Carebridge-Account': guardian.userId } })).status, 204);
});

test('current relationship removal blocks cached room IDs for read, send and profile without cancelling the account', async () => {
  const { cookie } = await login();
  const message = await send(cookie);
  const relations = new Relationships(db), current = await relations.get(manager, { conversationId: 'room-a' });
  await relations.replace(manager, { conversationId: 'room-a', clientId: 'remove-peer-0001', expectedVersion: current.version,
    therapist: { userId: therapist.userId, history: 'preserve' }, guardians: [], historyConfirmed: true });
  for (const path of [`${room}/messages`, `${room}/profile`]) checkError(await call(path, { cookie }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/messages`, { method: 'POST', cookie, body: input({ clientId: 'blocked-send-0001' }) }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/read`, { method: 'POST', cookie, body: { messageId: message.id } }), 404, 'NOT_FOUND');
  assert.equal((await call('/api/local/auth/session', { cookie })).status, 200);
  assert.deepEqual((await call(`${base}/inbox`, { cookie })).json.rooms, []);
});

test('unexpected errors and forged error codes never leak DB detail, raw cause or credentials', async () => {
  const { cookie } = await login();
  for (const error of [Object.assign(new Error('PRIVATE-DB-DETAIL'), { code: 'NOT_FOUND', cause: { token: 'PRIVATE-TOKEN' } }),
    new RepositoryError('PRIVATE-TABLE-NAME'), new AuthError('PRIVATE-AUTH-STATE')]) {
    options.conversations = { inbox: async () => { throw error; }, list() {}, sendText() {}, markRead() {} };
    const result = await call(`${base}/inbox`, { cookie });
    checkError(result, 503, 'LOCAL_API_UNAVAILABLE'); assert(!result.text.includes('PRIVATE-')); assert.equal(result.headers['set-cookie'], undefined);
  }
});

test('misconfigured origin/cookie or non-loopback sockets fail before authentication', async () => {
  let calls = 0;
  const guarded = { ...options, auth: { login() { calls++; }, authenticate() { calls++; }, logout() { calls++; } } };
  for (const originValue of ['http://localhost:1234', 'https://127.0.0.1:1234', `${origin}/`, 'http://127.0.0.1:0', 'http://127.0.0.1:65536']) {
    options = { ...guarded, origin: originValue };
    checkError(await call('/api/local/auth/session'), 503, 'LOCAL_API_UNAVAILABLE');
  }
  options = { ...guarded, cookieName: 'cb_session' };
  checkError(await call('/api/local/auth/session'), 503, 'LOCAL_API_UNAVAILABLE');
  for (const socket of [{ remoteAddress: '192.0.2.10', localAddress: '127.0.0.1', localPort: Number(new URL(origin).port) },
    { remoteAddress: '127.0.0.1', localAddress: '192.0.2.11', localPort: Number(new URL(origin).port) },
    { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 1 }]) {
    let status, body;
    const handled = await handleLocalApiRequest({ url: '/api/local/auth/session', method: 'GET', socket,
      headers: { host: new URL(origin).host, 'x-forwarded-for': '127.0.0.1' }, rawHeaders: [] },
    { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } }, guarded);
    assert.equal(handled, true); assert.equal(status, 403); assert.equal(body.error, 'SOURCE_REJECTED');
  }
  assert.equal(calls, 0);
  assert.equal(await handleLocalApiRequest({ url: '/local-synthetic.html' }, {}, guarded), false);
});
