import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { LocalEmailLogin, LocalEmailMailbox, LOCAL_EMAIL_RESPONSE } from '../local-email-login.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

const BASE = '/api/local/auth/email-login', EMAIL = 'guardian@email.test', PASSWORD = 'Synthetic password only!';
const password = { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 };
let db, auth, service, mailbox, server, options, origin, cookieName, dropVerify;
const count = async table => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
before(async () => {
  db = await PGlite.create(); await migrate(db);
  await db.exec(await readFile(new URL('../schema-proposals/email-login.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise(done => server.close(done)); await service?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a');
    INSERT INTO cb_users VALUES ('guardian',true),('manager',true),('pending',true),('inactive',true),('locked',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian','guardian',true),('center-a','manager','center',true);`);
  auth = new Auth(db, { password });
  for (const userId of ['guardian', 'manager', 'pending', 'inactive', 'locked'])
    await auth.provisionAccount({ userId, email: `${userId}@email.test`, password: PASSWORD });
  await db.exec("UPDATE cb_users SET active=false WHERE id='inactive'; UPDATE cb_auth_accounts SET locked_until=clock_timestamp()+interval '1 hour' WHERE user_id='locked'");
  mailbox = new LocalEmailMailbox(); service = new LocalEmailLogin({ auth, key: randomBytes(32), mailbox });
  cookieName = `cb_local_${randomBytes(16).toString('hex')}`; dropVerify = false;
  server = createServer(async (req, res) => {
    if (req.url === `${BASE}/verify` && dropVerify) {
      const end = res.end.bind(res);
      res.end = (...args) => { if (res.statusCode === 200) { dropVerify = false; res.destroy(); return res; } return end(...args); };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: new Conversations(db), profiles: new Children(db), origin, cookieName, emailLogin: service };
});
function call(path, { body, cookie, method = 'POST', headers = {}, raw } = {}) {
  const combined = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: combined, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic request timeout')));
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
function err(result, status, code) { assert.equal(result.status, status, result.text); assert.equal(result.json.error, code); assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']); assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['cache-control'], 'no-store'); }
const cookieOf = result => result.headers['set-cookie'][0].split(';')[0];
async function start() { const result = await call(`${BASE}/start`, { body: {} }); assert.equal(result.status, 200, result.text); assert.deepEqual(result.json, { ready: true }); return cookieOf(result); }
async function issue(email = EMAIL, cookie = null, clientId = randomUUID()) {
  cookie ??= await start();
  const result = await call(`${BASE}/request`, { cookie, body: { email, clientId } });
  assert.equal(result.status, 202, result.text); assert.deepEqual(result.json, LOCAL_EMAIL_RESPONSE); await service.idle();
  return { cookie, clientId, delivery: mailbox.take(email) };
}
const verify = (entry, extra = {}) => call(`${BASE}/verify`, { cookie: entry.cookie, body: { clientId: entry.clientId, code: entry.delivery?.code }, ...extra });
test('email route is unavailable without a trusted same-auth service', async () => {
  delete options.emailLogin; err(await call(`${BASE}/start`, { body: {} }), 404, 'NOT_FOUND');
  options.emailLogin = { start() {} }; err(await call(`${BASE}/start`, { body: {} }), 503, 'LOCAL_API_UNAVAILABLE');
  const other = new LocalEmailLogin({ auth: new Auth(db, { password }), key: randomBytes(32), mailbox: new LocalEmailMailbox() });
  options.emailLogin = other; err(await call(`${BASE}/start`, { body: {} }), 503, 'LOCAL_API_UNAVAILABLE'); await other.close();
});
test('bootstrap owns an HttpOnly same-site nonce; arbitrary client nonces cannot issue a code', async () => {
  const result = await call(`${BASE}/start`, { body: {} }); assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie'][0], /HttpOnly/); assert.match(result.headers['set-cookie'][0], /SameSite=Strict/); assert.match(result.headers['set-cookie'][0], /Path=\/api\/local\//);
  assert.deepEqual(result.json, { ready: true });
  err(await call(`${BASE}/request`, { body: { email: EMAIL, clientId: randomUUID() } }), 401, 'EMAIL_LOGIN_INVALID');
  err(await call(`${BASE}/request`, { cookie: `${cookieName}_email=${randomBytes(32).toString('base64url')}`, body: { email: EMAIL, clientId: randomUUID() } }), 401, 'EMAIL_LOGIN_INVALID');
  assert.equal(await count('cb_auth_email_logins'), 0);
});
test('exact routes, claims, .test address and body bounds remain enforced', async () => {
  const cookie = await start(), clientId = randomUUID();
  for (const method of ['GET', 'PUT', 'DELETE']) err(await call(`${BASE}/request`, { method }), 404, 'NOT_FOUND');
  for (const path of ['mailbox', 'request/']) err(await call(`${BASE}/${path}`, { body: {} }), 404, 'NOT_FOUND');
  err(await call(`${BASE}/start?x=1`, { body: {} }), 400, 'INVALID_INPUT');
  for (const body of [{ email: 'real@example.com', clientId }, { email: EMAIL, clientId, role: 'center' }, { email: EMAIL, clientId, nonce: 'chosen' }, { email: EMAIL, clientId, userId: 'manager' }, { email: EMAIL, clientId: 'bad' }])
    err(await call(`${BASE}/request`, { body, cookie }), 400, 'INVALID_INPUT');
  err(await call(`${BASE}/start`, { body: { role: 'center' } }), 400, 'INVALID_INPUT');
  err(await call(`${BASE}/request`, { raw: '{', cookie }), 400, 'INVALID_INPUT');
  err(await call(`${BASE}/request`, { body: { email: 'x'.repeat(1100), clientId }, cookie }), 413, 'PAYLOAD_TOO_LARGE');
});
test('Origin, host, CSRF, encoding and account preconditions are not bypassed', async () => {
  for (const headers of [{ Origin: 'https://other.test' }, { Origin: undefined }, { 'X-Carebridge-Request': undefined }, { Host: 'localhost:4180' }, { 'Sec-Fetch-Site': 'same-site' }])
    err(await call(`${BASE}/start`, { body: {}, headers }), 403, 'SOURCE_REJECTED');
  err(await call(`${BASE}/start`, { body: {}, headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  err(await call(`${BASE}/start`, { body: {}, headers: { 'X-Carebridge-Account': 'manager' } }), 400, 'INVALID_INPUT');
});
test('known, missing, inactive and locked accounts receive the same receipt without signup', async () => {
  for (const user of ['guardian', 'missing', 'inactive', 'locked']) {
    const entry = await issue(`${user}@email.test`);
    assert.equal(Boolean(entry.delivery), user === 'guardian');
  }
  assert.equal(await count('cb_users'), 5); assert.equal(await count('cb_auth_sessions'), 0);
});
test('request receipt retry is idempotent; client id cannot be rebound to another email', async () => {
  const entry = await issue();
  const result = await call(`${BASE}/request`, { cookie: entry.cookie, body: { email: EMAIL, clientId: entry.clientId } });
  assert.deepEqual(result.json, LOCAL_EMAIL_RESPONSE); await service.idle(); assert.equal(mailbox.take(EMAIL), null); assert.equal(await count('cb_auth_email_logins'), 1);
  err(await call(`${BASE}/request`, { cookie: entry.cookie, body: { email: 'manager@email.test', clientId: entry.clientId } }), 400, 'INVALID_INPUT');
  const resend = await issue(EMAIL, entry.cookie); assert.equal(resend.delivery, null); assert.equal(await count('cb_auth_email_logins'), 1);
});
test('server roles and approval pending are authoritative; clinical assignments are unchanged', async () => {
  for (const [name, centers] of [['guardian', [{ id: 'center-a', role: 'guardian' }]], ['manager', [{ id: 'center-a', role: 'center' }]], ['pending', []]]) {
    const entry = await issue(`${name}@email.test`), result = await verify(entry);
    assert.equal(result.status, 200, result.text); assert.deepEqual(result.json.user.centers, centers);
    assert.deepEqual(Object.keys(result.json), ['user']); assert(!result.text.includes(entry.delivery.code));
    const session = await call('/api/local/auth/session', { method: 'GET', cookie: cookieOf(result) }); assert.deepEqual(session.json, result.json);
    assert.equal((await call('/api/local/auth/logout', { body: {}, cookie: `${entry.cookie}; ${cookieOf(result)}` })).status, 204);
  }
  assert.equal(await count('cb_memberships'), 2); assert.equal(await count('cb_participants'), 0);
});
test('wrong browser and forged role cannot use a valid code', async () => {
  const entry = await issue(); err(await verify(entry, { cookie: await start() }), 401, 'EMAIL_LOGIN_INVALID');
  err(await verify(entry, { body: { clientId: entry.clientId, code: entry.delivery.code, role: 'center' } }), 400, 'INVALID_INPUT');
  assert.equal(await count('cb_auth_sessions'), 0); assert.equal((await verify(entry)).status, 200);
});
test('five wrong codes terminate proof, including later submission of the right code', async () => {
  const entry = await issue(), wrong = entry.delivery.code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 5; i++) err(await verify(entry, { body: { clientId: entry.clientId, code: wrong } }), 401, 'EMAIL_LOGIN_INVALID');
  err(await verify(entry), 401, 'EMAIL_LOGIN_INVALID'); assert.equal(await count('cb_auth_sessions'), 0);
});
test('lost success response retry recovers exactly one session, including a cookie already accepted', async () => {
  const entry = await issue(); dropVerify = true; await assert.rejects(verify(entry)); assert.equal(await count('cb_auth_sessions'), 1);
  const result = await verify(entry); assert.equal(result.status, 200, result.text);
  const retry = await verify(entry, { cookie: `${entry.cookie}; ${cookieOf(result)}` });
  assert.equal(retry.status, 200); assert.equal(cookieOf(retry), cookieOf(result)); assert.equal(await count('cb_auth_sessions'), 1);
});
test('an unrelated live session is never replaced by an email verification', async () => {
  const entry = await issue(); const other = await auth.login({ email: 'manager@email.test', password: PASSWORD });
  const cookie = `${entry.cookie}; ${cookieName}=${other.token}`;
  err(await verify(entry, { cookie }), 409, 'ACCOUNT_SESSION_PRESENT');
  err(await call(`${BASE}/start`, { cookie, body: {} }), 409, 'ACCOUNT_SESSION_PRESENT');
  err(await call(`${BASE}/request`, { cookie, body: { email: EMAIL, clientId: randomUUID() } }), 409, 'ACCOUNT_SESSION_PRESENT');
  assert.equal(await count('cb_auth_sessions'), 1);
});
test('logout without the lost reply cookie revokes its minted session and invalidates proof', async () => {
  const entry = await issue(), result = await verify(entry);
  const logout = await call('/api/local/auth/logout', { cookie: entry.cookie, body: {} });
  assert.equal(logout.status, 204); assert.equal(logout.headers['set-cookie'].length, 2);
  err(await verify(entry), 401, 'EMAIL_LOGIN_INVALID');
  err(await call('/api/local/auth/session', { method: 'GET', cookie: cookieOf(result) }), 401, 'AUTH_REQUIRED');
});
test('logout winning during verification revokes late SQL success', async () => {
  const entry = await issue(), nonce = entry.cookie.split('=')[1];
  const original = auth.authenticate.bind(auth), gate = Promise.withResolvers(), reached = Promise.withResolvers();
  auth.authenticate = async token => { reached.resolve(); await gate.promise; return original(token); };
  const verification = service.verify({ clientId: entry.clientId, code: entry.delivery.code }, nonce);
  await reached.promise; await service.invalidate(nonce); gate.resolve();
  await assert.rejects(verification, error => error.code === 'EMAIL_LOGIN_INVALID');
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM cb_auth_sessions WHERE revoked_at IS NULL')).rows[0].n), 0);
});
test('password login invalidates outstanding email proofs without changing existing role', async () => {
  const entry = await issue();
  const result = await call('/api/local/auth/login', { cookie: entry.cookie, body: { email: EMAIL, password: PASSWORD } });
  assert.equal(result.status, 200); err(await verify(entry), 401, 'EMAIL_LOGIN_INVALID');
  assert.equal(result.json.user.centers[0].role, 'guardian');
});
test('database failure is safely normalized and never exposes raw diagnostics', async () => {
  const entry = await issue(), original = auth.authenticate;
  auth.authenticate = async () => { throw new Error('private SQL sentinel'); };
  err(await verify(entry), 503, 'LOCAL_API_UNAVAILABLE'); auth.authenticate = original;
});
test('mailbox does not serialize codes, is take-once, and closes without re-issuing', async () => {
  const entry = await issue(); assert(!JSON.stringify(entry.delivery).includes(entry.delivery.code)); assert.equal(mailbox.take(EMAIL), null);
  mailbox.close(); const pending = await issue('pending@email.test'); assert.equal(pending.delivery, null);
  assert.equal(await count('cb_auth_email_logins'), 2); await service.idle(); assert.equal(await count('cb_auth_email_logins'), 2);
});
test('nonce admission stays bounded and close rejects reuse', async () => {
  for (let i = 0; i < 64; i++) service.start(null);
  assert.throws(() => service.start(null), error => error.code === 'LOCAL_API_UNAVAILABLE');
  await service.close(); assert.throws(() => service.start(null), error => error.code === 'LOCAL_API_UNAVAILABLE');
});
test('expired code cannot create a session through HTTP', async () => {
  await service.close(); mailbox = new LocalEmailMailbox();
  service = new LocalEmailLogin({ auth, key: randomBytes(32), mailbox, ttlSeconds: 1 }); options.emailLogin = service;
  const entry = await issue(); await delay(1100); err(await verify(entry), 401, 'EMAIL_LOGIN_INVALID'); assert.equal(await count('cb_auth_sessions'), 0);
});
