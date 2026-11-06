// Owned loopback TLS + real in-memory auth integration. This does not open LAN,
// trust an OS certificate, send mail, or enable operating/E-drive accounts.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { LocalEmailLogin, LocalEmailMailbox, LOCAL_EMAIL_RESPONSE } from '../local-email-login.mjs';
import { migrate } from '../migrate.mjs';
import { createSyntheticHttpsApiListener } from '../local-api-listener.mjs';
import { SyntheticHttpsTransport } from '../synthetic-https-transport.mjs';
import { syntheticHttpsCertificate } from './synthetic-https-certificate-fixture.mjs';

const enabled = process.platform === 'win32' && Boolean(process.env.CAREBRIDGE_TEST_POWERSHELL);
const BASE = '/api/local/auth/email-login';
const CENTER = 'synthetic-https-center';
const INBOX = `/api/local/centers/${CENTER}/inbox`;
const PASSWORD = 'Synthetic HTTPS fixture only!';
const password = { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 };
const email = name => `${name}@https-email.test`;
const userId = name => `synthetic-${name}`;

describe('synthetic HTTPS email authentication', {
  concurrency: false,
  skip: enabled ? false : 'Requires Windows and an explicit CAREBRIDGE_TEST_POWERSHELL PowerShell 7 path.',
}, () => {
  let db, material, auth, mailbox, emailLogin, listener;
  before(async () => {
    material = await syntheticHttpsCertificate();
    db = await PGlite.create();
    await migrate(db);
    // The proposal is applied only to this fresh, owned memory DB, never a
    // discovered existing database or the numbered operating migration path.
    await db.exec(await readFile(new URL('../schema-proposals/email-login.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    listener = undefined;
    emailLogin = undefined;
    await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
      INSERT INTO cb_centers VALUES ('${CENTER}');
      INSERT INTO cb_users VALUES ('synthetic-guardian',true),('synthetic-manager',true),('synthetic-pending',true);
      INSERT INTO cb_memberships VALUES
        ('${CENTER}','synthetic-guardian','guardian',true),('${CENTER}','synthetic-manager','center',true);`);
    auth = new Auth(db, { password });
    for (const name of ['guardian', 'manager', 'pending'])
      await auth.provisionAccount({ userId: userId(name), email: email(name), password: PASSWORD });
    mailbox = new LocalEmailMailbox();
    emailLogin = new LocalEmailLogin({ auth, mailbox, key: randomBytes(32) });
    const transport = new SyntheticHttpsTransport({ mode: 'loopback-verification', host: '127.0.0.1',
      peerAddress: '127.0.0.1', cert: material.cert, key: material.key, confirmSynthetic: true });
    listener = await createSyntheticHttpsApiListener({ port: 0, screen: 'api-only', transport,
      services: { auth, conversations: new Conversations(db), profiles: new Children(db), emailLogin } });
    assert.ok(/^https:\/\/127\.0\.0\.1:[1-9][0-9]+$/.test(listener.origin));
  });
  afterEach(async () => {
    await listener?.close();
    await emailLogin?.close();
  });
  after(async () => {
    await db?.close();
    material?.key.fill(0);
  });

  function call(path, { body, cookie, method = 'POST', headers = {} } = {}) {
    const outgoing = { ...(method === 'POST'
      ? { Origin: listener.origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...headers };
    for (const name of Object.keys(outgoing)) if (outgoing[name] === undefined) delete outgoing[name];
    return new Promise((resolve, reject) => {
      // Trust only the in-memory test certificate for this request. Certificate
      // chain and IP/SAN validation remain enabled; no global TLS override.
      const req = request({ hostname: '127.0.0.1', port: new URL(listener.origin).port, path, method,
        headers: outgoing, ca: material.cert, rejectUnauthorized: true, agent: false }, response => {
        const chunks = [];
        const authorized = response.socket.authorized;
        const protocol = response.socket.getProtocol();
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', () => reject(new Error('SYNTHETIC_HTTPS_TEST_RESPONSE_FAILED')));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, headers: response.headers, text,
              json: text ? JSON.parse(text) : null, authorized, protocol });
          } catch { reject(new Error('SYNTHETIC_HTTPS_TEST_RESPONSE_INVALID')); }
        });
      });
      req.on('error', () => reject(new Error('SYNTHETIC_HTTPS_TEST_REQUEST_FAILED')));
      req.setTimeout(8000, () => req.destroy());
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  function tls(result) {
    assert.equal(result.authorized, true);
    assert.ok(['TLSv1.2', 'TLSv1.3'].includes(result.protocol));
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  function error(result, status, code) {
    tls(result);
    assert.equal(result.status, status);
    assert.equal(result.json.error, code);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  function secureCookie(value, { deletion = false, emailNonce = false } = {}) {
    assert.equal(typeof value, 'string');
    const parts = value.split(';').map(part => part.trim());
    // Boolean assertions deliberately avoid printing raw cookies on failure.
    assert.ok(parts.includes('Secure'), 'HTTPS cookies must have Secure');
    assert.ok(parts.includes('HttpOnly'), 'Authentication cookies must have HttpOnly');
    assert.ok(parts.includes('SameSite=Strict'));
    assert.ok(parts.includes('Path=/api/local/'));
    assert.ok(!parts.some(part => /^Domain=/i.test(part)));
    const pattern = emailNonce ? /^cb_local_[a-f0-9]{32}_email=/ : /^cb_local_[a-f0-9]{32}=/;
    assert.ok(pattern.test(parts[0]));
    if (deletion) {
      assert.ok(parts[0].endsWith('='));
      assert.ok(parts.includes('Max-Age=0'));
    } else {
      assert.ok(/=[A-Za-z0-9_-]{40,100}$/.test(parts[0]));
      assert.ok(parts.some(part => /^Max-Age=[1-9][0-9]*$/.test(part)));
    }
    return parts[0];
  }
  async function start() {
    const result = await call(`${BASE}/start`, { body: {} });
    tls(result);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ready: true });
    assert.equal(result.headers['set-cookie']?.length, 1);
    return secureCookie(result.headers['set-cookie'][0], { emailNonce: true });
  }
  async function issue(name = 'guardian') {
    const cookie = await start(), clientId = randomUUID();
    const result = await call(`${BASE}/request`, { cookie, body: { email: email(name), clientId } });
    tls(result);
    assert.equal(result.status, 202);
    assert.deepEqual(result.json, LOCAL_EMAIL_RESPONSE);
    assert.equal(result.headers['set-cookie'], undefined);
    await emailLogin.idle();
    const delivery = mailbox.take(email(name));
    assert.ok(delivery);
    assert.equal(delivery.clientId, clientId);
    assert.equal(mailbox.take(email(name)), null);
    assert.ok(!JSON.stringify(delivery).includes(delivery.code));
    return { cookie, clientId, delivery };
  }
  const verify = (entry, extra = {}) => call(`${BASE}/verify`, { cookie: entry.cookie,
    body: { clientId: entry.clientId, code: entry.delivery.code }, ...extra });

  test('TLS does not grant a session or center access; unauthenticated requests remain blocked', async () => {
    error(await call('/api/local/auth/session', { method: 'GET' }), 401, 'AUTH_REQUIRED');
    error(await call(INBOX, { method: 'GET', headers: { 'X-Carebridge-Account': userId('guardian') } }), 401, 'AUTH_REQUIRED');
    error(await call(`${BASE}/request`, { body: { email: email('guardian'), clientId: randomUUID() } }), 401, 'EMAIL_LOGIN_INVALID');
    const { rows } = await db.query('SELECT count(*)::integer AS count FROM cb_auth_sessions');
    assert.equal(rows[0].count, 0);
  });

  test('HTTPS still rejects cross-origin writes, missing CSRF intent and forwarding headers', async () => {
    for (const headers of [{ Origin: 'https://other.test' }, { Origin: undefined },
      { 'X-Carebridge-Request': undefined }, { 'X-Forwarded-For': '127.0.0.1' }]) {
      const result = await call(`${BASE}/start`, { body: {}, headers });
      tls(result);
      assert.equal(result.status, 403);
      assert.equal(result.headers['set-cookie'], undefined);
    }
    const { rows } = await db.query('SELECT count(*)::integer AS count FROM cb_auth_email_logins');
    assert.equal(rows[0].count, 0);
  });

  for (const [name, role] of [['guardian', 'guardian'], ['manager', 'center'], ['pending', null]]) {
    test(`email code establishes the current ${name} identity and Secure logout revokes it`, async () => {
      const entry = await issue(name);
      const accepted = await verify(entry);
      tls(accepted);
      assert.equal(accepted.status, 200);
      assert.deepEqual(Object.keys(accepted.json), ['user']);
      assert.equal(accepted.json.user.userId, userId(name));
      assert.equal(accepted.json.user.email, email(name));
      assert.deepEqual(accepted.json.user.centers, role ? [{ id: CENTER, role }] : []);
      assert.ok(!accepted.text.includes(entry.delivery.code));
      assert.equal(accepted.headers['set-cookie']?.length, 1);
      const sessionCookie = secureCookie(accepted.headers['set-cookie'][0]);
      const session = await call('/api/local/auth/session', { method: 'GET', cookie: sessionCookie });
      tls(session);
      assert.equal(session.status, 200);
      assert.deepEqual(session.json, accepted.json);

      const inbox = await call(INBOX, { method: 'GET', cookie: sessionCookie,
        headers: { 'X-Carebridge-Account': userId(name) } });
      if (name === 'guardian') {
        tls(inbox);
        assert.equal(inbox.status, 200);
        assert.deepEqual(inbox.json.rooms, []);
      } else error(inbox, 404, 'NOT_FOUND');
      // Pending verification never creates a membership; center role likewise
      // does not silently become a clinical participant.
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM cb_memberships')).rows[0].n), 2);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM cb_participants')).rows[0].n), 0);

      const loggedOut = await call('/api/local/auth/logout', { cookie: `${entry.cookie}; ${sessionCookie}`,
        body: {}, headers: { 'X-Carebridge-Account': userId(name) } });
      tls(loggedOut);
      assert.equal(loggedOut.status, 204);
      assert.equal(loggedOut.headers['set-cookie']?.length, 2);
      assert.deepEqual(loggedOut.headers['set-cookie'].map(value => value.split('=')[0]).sort(),
        [entry.cookie, sessionCookie].map(value => value.split('=')[0]).sort());
      for (const value of loggedOut.headers['set-cookie']) secureCookie(value, {
        deletion: true, emailNonce: value.split('=')[0].endsWith('_email'),
      });
      error(await call('/api/local/auth/session', { method: 'GET', cookie: sessionCookie }), 401, 'AUTH_REQUIRED');
      error(await verify(entry), 401, 'EMAIL_LOGIN_INVALID');
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM cb_auth_sessions WHERE revoked_at IS NULL')).rows[0].n), 0);
    });
  }

  test('a valid code remains browser-bound and refuses forged role claims over HTTPS', async () => {
    const entry = await issue();
    error(await verify(entry, { cookie: await start() }), 401, 'EMAIL_LOGIN_INVALID');
    error(await verify(entry, { body: { clientId: entry.clientId, code: entry.delivery.code, role: 'center' } }), 400, 'INVALID_INPUT');
    const wrong = entry.delivery.code === '00000000' ? '11111111' : '00000000';
    error(await verify(entry, { body: { clientId: entry.clientId, code: wrong } }), 401, 'EMAIL_LOGIN_INVALID');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM cb_auth_sessions')).rows[0].n), 0);
    const accepted = await verify(entry);
    tls(accepted);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.json.user.centers, [{ id: CENTER, role: 'guardian' }]);
    secureCookie(accepted.headers['set-cookie'][0]);
  });
});
