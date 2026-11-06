import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { handleAuthRequest } from '../auth-http.mjs';
import { migrate } from '../migrate.mjs';

let database;
let auth;
let httpServer;
const password = 'correct horse battery';
const errorCode = (code) => (error) => error instanceof AuthError && error.code === code;

before(async () => {
  database = await PGlite.create();
  assert.deepEqual(await migrate(database), [
    '001-conversations.sql', '002-authentication.sql', '003-invitations.sql', '004-relationships.sql',
    '005-records.sql', '006-activity-feedback.sql', '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql', '010-profiles.sql', '011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql',
  ]);
});

after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await database?.close();
});

beforeEach(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
  await database.transaction(async (tx) => {
    await tx.exec(`TRUNCATE cb_centers, cb_users RESTART IDENTITY CASCADE;
      INSERT INTO cb_centers VALUES ('center-a');
      INSERT INTO cb_users(id, active) VALUES
        ('guardian-a', true), ('manager-a', true), ('disabled-a', false);
      INSERT INTO cb_memberships(center_id, user_id, role, active) VALUES
        ('center-a', 'guardian-a', 'guardian', true),
        ('center-a', 'manager-a', 'center', true);`);
  });
  auth = new Auth(database, {
    password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
  });
  await auth.provisionAccount({
    userId: 'guardian-a',
    email: 'Guardian@Example.com',
    password,
  });
  await auth.provisionAccount({
    userId: 'manager-a',
    email: 'Manager@Example.com',
    password,
  });
});

test('provisioning stores a one-way password hash and normalizes email', async () => {
  const { rows: [account] } = await database.query(
    'SELECT email, password_hash FROM cb_auth_accounts WHERE user_id = $1',
    ['guardian-a'],
  );
  assert.equal(account.email, 'guardian@example.com');
  assert.match(account.password_hash, /^scrypt\$/);
  assert.equal(account.password_hash.includes(password), false);
  await assert.rejects(
    auth.provisionAccount({ userId: 'guardian-a', email: 'other@example.com', password }),
    errorCode('ACCOUNT_EXISTS'),
  );
});

test('login issues a server-side session and authentication returns memberships', async () => {
  const result = await auth.login({ email: 'GUARDIAN@example.com', password });
  assert.equal(result.user.userId, 'guardian-a');
  assert.deepEqual(result.user.centers, [{ id: 'center-a', role: 'guardian' }]);
  assert.match(result.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal('password' in result.user, false);
  const { rows: [stored] } = await database.query('SELECT token_hash FROM cb_auth_sessions');
  assert.notEqual(stored.token_hash, result.token);
  assert.deepEqual(await auth.authenticate(result.token), result.user);
});

test('unknown and wrong credentials return the same public error and lock after repeated failure', async () => {
  await assert.rejects(
    auth.login({ email: 'missing@example.com', password }),
    errorCode('AUTH_INVALID'),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      auth.login({ email: 'guardian@example.com', password: 'wrong password' }),
      errorCode('AUTH_INVALID'),
    );
  }
  const { rows: [locked] } = await database.query(
    'SELECT failed_attempts, locked_until FROM cb_auth_accounts WHERE user_id = $1',
    ['guardian-a'],
  );
  assert.equal(locked.failed_attempts, 5);
  assert.ok(locked.locked_until);
  await assert.rejects(auth.login({ email: 'guardian@example.com', password }), errorCode('AUTH_INVALID'));
  await database.query(`UPDATE cb_auth_accounts SET failed_attempts = 0,
    locked_until = clock_timestamp() - interval '1 second' WHERE user_id = $1`, ['guardian-a']);
  assert.equal((await auth.login({ email: 'guardian@example.com', password })).user.userId, 'guardian-a');
});

test('disabled internal users cannot sign in and sessions can be revoked', async () => {
  await database.query('UPDATE cb_users SET active = false WHERE id = $1', ['guardian-a']);
  await assert.rejects(auth.login({ email: 'guardian@example.com', password }), errorCode('AUTH_INVALID'));
  await database.query('UPDATE cb_users SET active = true WHERE id = $1', ['guardian-a']);
  const result = await auth.login({ email: 'guardian@example.com', password });
  assert.equal(await auth.logout(result.token), true);
  assert.equal(await auth.authenticate(result.token), null);
  assert.equal(await auth.logout(result.token), false);
});

test('center managers create single-use invitations without storing the raw token', async () => {
  const invitation = await auth.createInvitation(
    { userId: 'manager-a' },
    { centerId: 'center-a', email: 'New.User@Example.com', role: 'guardian' },
  );
  assert.match(invitation.id, /^inv_[a-f0-9]{32}$/);
  assert.match(invitation.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(invitation.email, 'new.user@example.com');
  const { rows: [stored] } = await database.query(
    'SELECT token_hash, accepted_at, revoked_at FROM cb_auth_invitations WHERE id = $1',
    [invitation.id],
  );
  assert.notEqual(stored.token_hash, invitation.token);
  assert.equal(stored.accepted_at, null);
  assert.equal(stored.revoked_at, null);
  const listed = await auth.listInvitations({ userId: 'manager-a' }, { centerId: 'center-a' });
  assert.deepEqual(listed[0], {
    id: invitation.id,
    centerId: 'center-a',
    email: 'new.user@example.com',
    role: 'guardian',
    status: 'pending',
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: null,
    revokedAt: null,
  });
  await assert.rejects(
    auth.createInvitation({ userId: 'guardian-a' }, {
      centerId: 'center-a', email: 'another@example.com', role: 'guardian',
    }),
    errorCode('FORBIDDEN'),
  );
});

test('accepting an invitation atomically provisions a user, membership, and session', async () => {
  const invitation = await auth.createInvitation(
    { userId: 'manager-a' },
    { centerId: 'center-a', email: 'accepted@example.com', role: 'therapist' },
  );
  const accepted = await auth.acceptInvitation({ token: invitation.token, password });
  assert.match(accepted.user.userId, /^user-[0-9a-f-]{36}$/);
  assert.deepEqual(accepted.user.centers, [{ id: 'center-a', role: 'therapist' }]);
  assert.equal(accepted.invitation.id, invitation.id);
  assert.deepEqual(await auth.authenticate(accepted.token), accepted.user);
  const { rows: [stored] } = await database.query(`SELECT i.accepted_user_id,
      i.accepted_at, m.role, a.email
    FROM cb_auth_invitations i
    JOIN cb_memberships m ON m.center_id = i.center_id AND m.user_id = i.accepted_user_id
    JOIN cb_auth_accounts a ON a.user_id = i.accepted_user_id
    WHERE i.id = $1`, [invitation.id]);
  assert.equal(stored.email, 'accepted@example.com');
  assert.equal(stored.role, 'therapist');
  assert.ok(stored.accepted_user_id);
  assert.ok(stored.accepted_at);
  await assert.rejects(
    auth.acceptInvitation({ token: invitation.token, password }),
    errorCode('INVITATION_INVALID'),
  );
  const { rows: audit } = await database.query(`SELECT action FROM cb_auth_audit_events
    WHERE invitation_id = $1 ORDER BY id`, [invitation.id]);
  assert.deepEqual(audit.map((row) => row.action), ['invitation.created', 'invitation.accepted']);
});

test('invitation revocation, expiry, duplicate accounts, and unsupported roles are enforced', async () => {
  const revoked = await auth.createInvitation(
    { userId: 'manager-a' },
    { centerId: 'center-a', email: 'revoked@example.com', role: 'guardian' },
  );
  await auth.revokeInvitation({ userId: 'manager-a' }, {
    centerId: 'center-a', invitationId: revoked.id,
  });
  await assert.rejects(
    auth.acceptInvitation({ token: revoked.token, password }),
    errorCode('INVITATION_INVALID'),
  );

  const expired = await auth.createInvitation(
    { userId: 'manager-a' },
    { centerId: 'center-a', email: 'expired@example.com', role: 'guardian' },
  );
  await database.query(`UPDATE cb_auth_invitations
    SET created_at = clock_timestamp() - interval '2 seconds',
        expires_at = clock_timestamp() - interval '1 second'
    WHERE id = $1`, [expired.id]);
  await assert.rejects(
    auth.acceptInvitation({ token: expired.token, password }),
    errorCode('INVITATION_INVALID'),
  );

  const existing = await auth.createInvitation(
    { userId: 'manager-a' },
    { centerId: 'center-a', email: 'guardian@example.com', role: 'guardian' },
  );
  await assert.rejects(
    auth.acceptInvitation({ token: existing.token, password }),
    errorCode('INVITATION_ACCOUNT_EXISTS'),
  );
  await assert.rejects(
    auth.createInvitation({ userId: 'manager-a' }, {
      centerId: 'center-a', email: 'center@example.com', role: 'center',
    }),
    errorCode('INVALID_INPUT'),
  );
});

test('HTTP boundary uses an HttpOnly cookie and never returns the raw session token', async () => {
  httpServer = (await import('node:http')).createServer((req, res) =>
    handleAuthRequest(req, res, { auth, secureCookies: false }),
  );
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'guardian@example.com', password }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /cb_session=.*HttpOnly/);
  const body = await login.json();
  assert.equal('token' in body, false);
  const cookie = cookieHeader.split(';', 1)[0];
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.userId, 'guardian-a');
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 204);
  const afterLogout = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});

test('HTTP invitation flow restricts issuance to managers and signs in the accepted account', async () => {
  httpServer = (await import('node:http')).createServer((req, res) =>
    handleAuthRequest(req, res, { auth, secureCookies: true }),
  );
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;
  const managerLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'manager@example.com', password }),
  });
  const managerCookie = managerLogin.headers.get('set-cookie').split(';', 1)[0];
  assert.match(managerLogin.headers.get('set-cookie'), /Secure/);
  const created = await fetch(`${base}/api/auth/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: managerCookie },
    body: JSON.stringify({ centerId: 'center-a', email: 'http-user@example.com', role: 'guardian' }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const invitation = (await created.json()).invitation;
  assert.match(invitation.token, /^[A-Za-z0-9_-]{40,100}$/);
  const listed = await fetch(`${base}/api/auth/invitations?centerId=center-a`, {
    headers: { cookie: managerCookie },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).invitations[0].email, 'http-user@example.com');
  const accepted = await fetch(`${base}/api/auth/invitations/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: invitation.token, password }),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const acceptedCookie = accepted.headers.get('set-cookie').split(';', 1)[0];
  const acceptedSession = await fetch(`${base}/api/auth/session`, { headers: { cookie: acceptedCookie } });
  assert.equal(acceptedSession.status, 200);
  assert.match((await acceptedSession.json()).user.userId, /^user-/);
});
