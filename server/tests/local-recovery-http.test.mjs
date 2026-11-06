import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { AccountDelivery } from '../account-delivery.mjs';
import { LocalPasswordRecovery } from '../local-password-recovery.mjs';
import { LocalRecoveryMailbox } from '../local-recovery-mailbox.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Real HTTP/Auth/domain transactions, new memory PGlite and a synthetic private
// mailbox. No external mail, E/native, browser, real recipient or token log.
const BASE = '/api/local/auth/password-recovery';
const EMAIL = 'guardian@recovery.test', OTHER = 'other@recovery.test';
const OLD = 'Synthetic original password 2026!', NEW = 'Synthetic changed password 2026!';
const PASSWORD = { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 };
const PUBLIC = { message: '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.' };
let db, auth, mailbox, queue, server, options, origin, cookieName, dropComplete;
const count = async table => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
  await queue?.close(); mailbox?.close();
});
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('other-a',true),('inactive-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','other-a','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','other-a','therapist',true,1);`);
  auth = new Auth(db, { password: PASSWORD });
  for (const [userId, email] of [['guardian-a', EMAIL], ['other-a', OTHER], ['inactive-a', 'inactive@recovery.test']])
    await auth.provisionAccount({ userId, email, password: OLD });
  await db.query("UPDATE cb_users SET active=false WHERE id='inactive-a'");
  mailbox = new LocalRecoveryMailbox();
  queue = new LocalPasswordRecovery({ accountDelivery: new AccountDelivery({ auth, origin: 'https://carebridge.test', transport: mailbox }) });
  cookieName = `cb_local_${randomBytes(16).toString('hex')}`; dropComplete = false;
  server = createServer(async (req, res) => {
    if (req.url === `${BASE}/complete` && dropComplete) {
      const end = res.end.bind(res);
      res.end = (...args) => {
        if (res.statusCode === 200) { dropComplete = false; res.destroy(); return res; }
        return end(...args);
      };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: new Conversations(db), profiles: new Children(db), origin, cookieName, passwordRecovery: queue };
});
function call(path, { method = 'POST', body, cookie, headers = {}, raw } = {}) {
  const combined = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: combined, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
      res.on('error', reject);
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic recovery request timed out.')));
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const requestRecovery = (email = EMAIL, extra = {}) => call(`${BASE}/request`, { body: { email }, ...extra });
const complete = (token, extra = {}) => call(`${BASE}/complete`, { body: { token, newPassword: NEW, confirmation: NEW }, ...extra });
function error(value, status, code) {
  assert.equal(value.status, status); assert.equal(value.json.error, code);
  assert.deepEqual(Object.keys(value.json).sort(), ['error', 'message']); assert.equal(value.headers['set-cookie'], undefined);
  assert.equal(value.headers['cache-control'], 'no-store');
}
function accepted(value) {
  assert.equal(value.status, 202); assert.deepEqual(value.json, PUBLIC);
  assert.equal(value.headers['set-cookie'], undefined); assert.equal(value.headers['cache-control'], 'no-store');
}
async function login(email = EMAIL, password = OLD) {
  const value = await call('/api/local/auth/login', { body: { email, password } });
  assert.equal(value.status, 200); return value.headers['set-cookie'][0].split(';')[0];
}
async function issue(email = EMAIL) {
  accepted(await requestRecovery(email)); await queue.idle();
  const link = mailbox.take(email, origin); assert.equal(typeof link, 'string');
  return new URL(link).hash.slice('#token='.length);
}
const clinicalState = async () => {
  const out = {};
  for (const table of ['cb_users', 'cb_memberships', 'cb_participants', 'cb_conversations', 'cb_messages',
    'cb_records', 'cb_record_revisions', 'cb_publications', 'cb_activity_feedback', 'cb_read_states'])
    out[table] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return out;
};

test('recovery endpoints require an explicit trusted queue, never a duck-typed method or delivery flag', async () => {
  delete options.passwordRecovery;
  error(await requestRecovery(), 404, 'NOT_FOUND'); error(await complete('unused'), 404, 'NOT_FOUND');
  options.passwordRecovery = { request: () => PUBLIC, idle: async () => {} };
  error(await requestRecovery(), 503, 'LOCAL_API_UNAVAILABLE'); options.passwordRecovery = queue;
  assert.equal(await count('cb_auth_password_resets'), 0);
});
test('exact POST routes reject query, unknown body keys, real addresses and malformed input without issuance', async () => {
  for (const path of [`${BASE}/request/`, `${BASE}/preview`, `${BASE}/complete/`, '/api/local/auth/password-recovery'])
    error(await call(path, { body: { email: EMAIL } }), 404, 'NOT_FOUND');
  for (const method of ['GET', 'PUT', 'DELETE']) error(await call(`${BASE}/request`, { method }), 404, 'NOT_FOUND');
  for (const path of [`${BASE}/request?email=x`, `${BASE}/complete?token=x`, `${BASE}/request?x=1&x=2`])
    error(await call(path, { body: {} }), 400, 'INVALID_INPUT');
  for (const email of ['real@example.com', '한글@recovery.test', `${EMAIL}\n`, `${EMAIL},a@b.test`, '\ud800@x.test'])
    error(await requestRecovery(email), 400, 'INVALID_INPUT');
  error(await requestRecovery(EMAIL, { body: { email: EMAIL, userId: 'other-a' } }), 400, 'INVALID_INPUT');
  error(await call(`${BASE}/request`, { raw: '{' }), 400, 'INVALID_INPUT');
  error(await call(`${BASE}/complete`, { body: { token: 'unused', newPassword: NEW, confirmation: NEW, userId: 'guardian-a' } }), 400, 'INVALID_INPUT');
  await queue.idle(); assert.equal(await count('cb_auth_password_resets'), 0);
});
test('common loopback source, CSRF, encoding and expected-account fences remain enforced', async () => {
  for (const headers of [{ Origin: 'https://elsewhere.test' }, { Origin: undefined }, { 'X-Carebridge-Request': undefined },
    { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:4180' }])
    error(await requestRecovery(EMAIL, { headers }), 403, 'SOURCE_REJECTED');
  error(await requestRecovery(EMAIL, { headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  for (const path of ['request', 'complete']) {
    error(await call(`${BASE}/${path}`, { body: {}, headers: { 'X-Carebridge-Account': 'guardian-a' } }), 400, 'INVALID_INPUT');
    error(await call(`${BASE}/${path}`, { body: {}, headers: { 'X-Carebridge-Account': '' } }), 400, 'INVALID_INPUT');
  }
  assert.equal(await count('cb_auth_password_resets'), 0);
});
test('any current authenticated cookie blocks both recovery operations without replacing that session', async () => {
  const token = await issue();
  for (const email of [EMAIL, OTHER]) {
    const cookie = await login(email);
    error(await requestRecovery(EMAIL, { cookie }), 409, 'ACCOUNT_SESSION_PRESENT');
    error(await complete(token, { cookie }), 409, 'ACCOUNT_SESSION_PRESENT');
    assert.equal((await call('/api/local/auth/session', { method: 'GET', cookie })).status, 200);
  }
  assert.equal((await db.query('SELECT consumed_at FROM cb_auth_password_resets')).rows[0].consumed_at, null);
});
test('request acknowledges before a held account lookup completes and never reports its outcome', async () => {
  const original = auth.preparePasswordRecovery.bind(auth), release = Promise.withResolvers(), entered = Promise.withResolvers();
  auth.preparePasswordRecovery = async input => { entered.resolve(); await release.promise; return original(input); };
  try {
    accepted(await requestRecovery()); await entered.promise;
    assert.equal(await count('cb_auth_password_resets'), 0);
  } finally { release.resolve(); await queue.idle(); auth.preparePasswordRecovery = original; }
  assert.equal(await count('cb_auth_password_resets'), 1);
});
test('known, absent, inactive and cooling-down recipients receive the same minimal response', async () => {
  for (const email of [EMAIL, 'absent@recovery.test', 'inactive@recovery.test', EMAIL.toUpperCase()]) accepted(await requestRecovery(email));
  await queue.idle(); assert.equal(await count('cb_auth_password_resets'), 1);
  const link = mailbox.take(EMAIL, origin); assert(link); assert.equal(mailbox.take('absent@recovery.test', origin), null);
  assert.equal(mailbox.take('inactive@recovery.test', origin), null);
  const stored = (await db.query('SELECT token_hash FROM cb_auth_password_resets')).rows[0].token_hash;
  assert.equal(stored, createHash('sha256').update(new URL(link).hash.slice(7)).digest('hex'));
});
test('completion changes only credentials/security state, revokes all target sessions and never auto-signs in', async () => {
  const first = await login(), second = await login(), peer = await login(OTHER), baseline = await clinicalState();
  const token = await issue(), beforeSessions = await count('cb_auth_sessions');
  const result = await complete(token);
  assert.equal(result.status, 200); assert.deepEqual(result.json, { passwordChanged: true, reauthenticate: true });
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(await count('cb_auth_sessions'), beforeSessions);
  for (const cookie of [first, second]) error(await call('/api/local/auth/session', { method: 'GET', cookie }), 401, 'AUTH_REQUIRED');
  assert.equal((await call('/api/local/auth/session', { method: 'GET', cookie: peer })).status, 200);
  error(await call('/api/local/auth/login', { body: { email: EMAIL, password: OLD } }), 401, 'AUTH_INVALID');
  assert(await login(EMAIL, NEW)); assert.deepEqual(await clinicalState(), baseline);
  const events = (await db.query("SELECT action,revoked_sessions FROM cb_account_security_events WHERE action='password.recovered'")).rows;
  assert.deepEqual(events, [{ action: 'password.recovered', revoked_sessions: 2 }]);
});
test('stale syntactically valid cookies are accepted but never cleared by recovery responses', async () => {
  const cookie = await login(); await auth.logout(cookie.slice(cookie.indexOf('=') + 1));
  accepted(await requestRecovery(EMAIL, { cookie })); await queue.idle();
  const token = new URL(mailbox.take(EMAIL, origin)).hash.slice(7);
  const result = await complete(token, { cookie }); assert.equal(result.status, 200); assert.equal(result.headers['set-cookie'], undefined);
});
test('invalid, consumed and revoked reset bearers share the safe 410 without issuing new tokens', async () => {
  const token = await issue(); error(await complete('bad-token'), 410, 'PASSWORD_RECOVERY_INVALID');
  error(await complete(`cr1.${'a'.repeat(43)}`), 410, 'PASSWORD_RECOVERY_INVALID');
  assert.equal((await complete(token)).status, 200); error(await complete(token), 410, 'PASSWORD_RECOVERY_INVALID');
  const other = await issue(OTHER); await db.query("UPDATE cb_users SET active=false WHERE id='other-a'");
  error(await complete(other), 410, 'PASSWORD_RECOVERY_INVALID'); assert.equal(await count('cb_auth_password_resets'), 2);
});
test('unchanged, mismatched and malformed passwords preserve the usable bearer and current credentials', async () => {
  const token = await issue();
  error(await complete(token, { body: { token, newPassword: OLD, confirmation: OLD } }), 400, 'PASSWORD_UNCHANGED');
  error(await complete(token, { body: { token, newPassword: NEW, confirmation: OLD } }), 400, 'PASSWORD_CONFIRMATION_MISMATCH');
  for (const value of ['short', 'x'.repeat(129), '\ud800'.repeat(12)])
    error(await complete(token, { body: { token, newPassword: value, confirmation: value } }), 400, 'INVALID_INPUT');
  assert.equal((await db.query('SELECT consumed_at FROM cb_auth_password_resets')).rows[0].consumed_at, null);
  assert(await login()); assert.equal((await complete(token)).status, 200);
});
test('a lost successful completion response is not retried as a second password change; new-password login confirms it', async () => {
  const token = await issue(), eventsBefore = await count('cb_account_security_events'); dropComplete = true;
  await assert.rejects(complete(token), value => value?.code === 'ECONNRESET');
  error(await complete(token), 410, 'PASSWORD_RECOVERY_INVALID');
  // Account-security audit rows deliberately outlive account fixture resets.
  assert.equal(await count('cb_account_security_events'), eventsBefore + 1); assert(await login(EMAIL, NEW));
});
test('a session created after the signed-out precheck is not overwritten by a recovery response cookie', async () => {
  const token = await issue(), original = auth.completePasswordRecovery.bind(auth), entered = Promise.withResolvers(), release = Promise.withResolvers();
  auth.completePasswordRecovery = async input => { entered.resolve(); await release.promise; return original(input); };
  const pending = complete(token); let peer;
  try { await entered.promise; peer = await login(OTHER); }
  finally { release.resolve(); }
  const result = await pending; auth.completePasswordRecovery = original;
  assert.equal(result.status, 200); assert.equal(result.headers['set-cookie'], undefined);
  assert.equal((await call('/api/local/auth/session', { method: 'GET', cookie: peer })).status, 200);
});
test('unavailable issuance does not leak raw errors or alter the uniform accepted response', async () => {
  auth.preparePasswordRecovery = async () => { throw new Error('Synthetic secret database diagnostic.'); };
  const result = await requestRecovery(); accepted(result); await queue.idle();
  assert.equal(result.text.includes('diagnostic'), false); assert.equal(await count('cb_auth_password_resets'), 0);
  assert.equal(mailbox.take(EMAIL, origin), null);
});
test('completion cannot fabricate success from an incomplete or false service result', async () => {
  for (const result of [null, {}, { passwordChanged: false, reauthenticate: true }, { passwordChanged: true, reauthenticate: false }]) {
    auth.completePasswordRecovery = async () => result;
    error(await complete(`cr1.${'a'.repeat(43)}`), 503, 'LOCAL_API_UNAVAILABLE');
  }
});
