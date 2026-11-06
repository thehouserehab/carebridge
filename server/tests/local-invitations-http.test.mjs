import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { AccountDelivery } from '../account-delivery.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { Relationships } from '../relationships.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Invented .test identities only, a new in-memory DB and an owned IPv4
// loopback server. Transport is an explicitly private memory test double:
// no external mail, browser, E drive, native service or delivery claim.
const PASSWORD = 'Synthetic invitation password 2026!';
const PASSWORD_OPTIONS = { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 };
const BASE = '/api/local/centers/center-a/operations/invitations';
const RECEIVER = '/api/local/auth/invitations';
const MANAGER = { userId: 'manager-a' };
const listKeys = ['id', 'centerId', 'email', 'role', 'status', 'createdAt', 'expiresAt', 'acceptedAt', 'revokedAt'].sort();
let db, auth, server, options, origin, cookieName, envelopes, cookieUsers, deliveryBehavior;
const count = async table => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const authCode = code => error => error instanceof AuthError && error.code === code;

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  envelopes.length = 0;
});
beforeEach(async () => {
  envelopes = []; cookieUsers = new Map(); deliveryBehavior = null;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-b',true),('therapist-a',true),('guardian-a',true),('stranger-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-b','manager-b','center',true),
      ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1);`);
  auth = new Auth(db, { password: PASSWORD_OPTIONS });
  for (const userId of ['manager-a', 'manager-b', 'therapist-a', 'guardian-a', 'stranger-a'])
    await auth.provisionAccount({ userId, email: `${userId}@synthetic.test`, password: PASSWORD });
  const accountDelivery = new AccountDelivery({ auth, origin: 'https://carebridge.test', transport: {
    send: async envelope => { if (deliveryBehavior) return deliveryBehavior(envelope); envelopes.push(envelope); return { status: 'accepted' }; },
  } });
  cookieName = `cb_local_${randomBytes(16).toString('hex')}`;
  server = createServer(async (req, res) => {
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: new Conversations(db), profiles: new Children(db), origin, cookieName, accountDelivery };
});

function call(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const combined = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, ...(cookieUsers.has(cookie) ? { 'X-Carebridge-Account': cookieUsers.get(cookie) } : {}) } : {}), ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: combined, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null, text });
      });
    });
    req.once('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Synthetic invitation request timed out.')));
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
async function login(userId = 'manager-a', email = `${userId}@synthetic.test`) {
  const result = await call('/api/local/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(result.status, 200);
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  cookieUsers.set(cookie, result.json.user.userId);
  return cookie;
}
const post = (path, body, cookie, extra = {}) => call(path, { method: 'POST', body, cookie, ...extra });
function error(result, status, code) {
  assert.equal(result.status, status); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store');
}
async function invite(email = 'new-person@synthetic.test', role = 'guardian', cookie, base = BASE) {
  const result = await post(base, { email, role }, cookie ?? await login());
  assert.equal(result.status, 202);
  const envelope = envelopes.at(-1);
  assert.equal(envelope.to, email.toLowerCase());
  const token = new URL(envelope.link).hash.slice('#token='.length);
  const preview = await post(`${RECEIVER}/preview`, { token });
  assert.equal(preview.status, 200);
  return { token, ...preview.json.invitation, email, response: result };
}
const confirmed = invitation => ({ token: invitation.token, centerId: invitation.centerId, role: invitation.role });
const accept = (invitation, extra = {}) => post(`${RECEIVER}/accept`, { ...confirmed(invitation), password: PASSWORD, confirmation: PASSWORD, ...extra });
const noChildWrites = async () => {
  assert.equal(await count('cb_participants'), 2);
  for (const table of ['cb_records', 'cb_messages', 'cb_child_profiles', 'cb_member_profiles']) assert.equal(await count(table), 0, table);
};

test('routes remain unavailable without explicit delivery, and a duck-typed delivery is not accepted', async () => {
  const delivery = options.accountDelivery; delete options.accountDelivery;
  error(await post(`${RECEIVER}/preview`, { token: 'a'.repeat(43) }), 404, 'NOT_FOUND');
  error(await call(BASE, { cookie: await login() }), 404, 'NOT_FOUND');
  options.accountDelivery = { invite: async () => { throw new Error('not a trusted delivery'); } };
  error(await post(`${RECEIVER}/preview`, { token: 'a'.repeat(43) }), 503, 'LOCAL_API_UNAVAILABLE');
  options.accountDelivery = delivery;
  assert.equal(await count('cb_auth_invitations'), 0);
});

test('center issuance gives only a generic acknowledgement and listing never reveals tokens or private delivery metadata', async () => {
  const cookie = await login(), invitation = await invite('new-person@synthetic.test', 'guardian', cookie);
  assert.deepEqual(Object.keys(invitation.response.json), ['message']);
  assert.equal(invitation.response.text.includes(invitation.token), false);
  assert.equal(invitation.response.headers['set-cookie'], undefined);
  const listed = await call(BASE, { cookie });
  assert.equal(listed.status, 200); assert.deepEqual(Object.keys(listed.json), ['invitations']);
  assert.deepEqual(Object.keys(listed.json.invitations[0]).sort(), listKeys);
  assert.equal(listed.json.invitations[0].status, 'pending');
  assert.equal(listed.text.includes(invitation.token), false);
  const stored = (await db.query('SELECT token_hash FROM cb_auth_invitations WHERE id=$1', [invitation.id])).rows[0];
  assert.equal(stored.token_hash, createHash('sha256').update(invitation.token).digest('hex'));
  await noChildWrites();
});

test('preview is bearer-only, minimal, read-only and independent of recipient account existence', async () => {
  const fresh = await invite(), existing = await invite('stranger-a@synthetic.test');
  const counts = [await count('cb_auth_accounts'), await count('cb_auth_sessions'), await count('cb_auth_audit_events')];
  for (const invitation of [fresh, existing]) {
    const result = await post(`${RECEIVER}/preview`, { token: invitation.token });
    assert.deepEqual(Object.keys(result.json.invitation).sort(), ['id', 'centerId', 'role', 'expiresAt'].sort());
    for (const secret of [invitation.email, invitation.token, PASSWORD, 'userId', 'acceptedUserId']) assert.equal(result.text.includes(secret), false);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.deepEqual([await count('cb_auth_accounts'), await count('cb_auth_sessions'), await count('cb_auth_audit_events')], counts);
});

test('new-account acceptance atomically creates only the invited account/membership/session and confirms the displayed target', async () => {
  const invitation = await invite(); const sessions = await count('cb_auth_sessions');
  const result = await accept(invitation);
  assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.json).sort(), ['invitation', 'user']);
  assert.deepEqual(result.json.invitation, { id: invitation.id, centerId: 'center-a', role: 'guardian' });
  assert.deepEqual(result.json.user.centers, [{ id: 'center-a', role: 'guardian' }]);
  assert.equal(await count('cb_auth_accounts'), 6); assert.equal(await count('cb_auth_sessions'), sessions + 1);
  const cookie = result.headers['set-cookie'][0];
  assert(cookie.includes('Path=/api/local/; HttpOnly; SameSite=Strict; Max-Age='));
  assert.equal(result.text.includes(cookie.split(';')[0].split('=')[1]), false);
  assert.equal(result.text.includes(invitation.token), false); assert.equal(result.text.includes(PASSWORD), false);
  const bound = cookie.split(';')[0]; cookieUsers.set(bound, result.json.user.userId);
  error(await call('/api/local/centers/center-a/conversations/room-a/messages', { cookie: bound }), 404, 'NOT_FOUND');
  await noChildWrites();
});

test('new acceptance keeps legacy internal compatibility but rejects incomplete or substituted confirmation without writes', async () => {
  const invitation = await invite();
  for (const extra of [{ centerId: 'center-b' }, { role: 'therapist' }]) error(await accept(invitation, extra), 410, 'INVITATION_INVALID');
  for (const partial of [{ centerId: 'center-a' }, { role: 'guardian' }])
    await assert.rejects(auth.acceptInvitation({ token: invitation.token, password: PASSWORD, ...partial }), authCode('INVALID_INPUT'));
  for (const body of [{ token: invitation.token, password: PASSWORD, confirmation: PASSWORD },
    { ...confirmed(invitation), password: PASSWORD }, { ...confirmed(invitation), password: PASSWORD, confirmation: 'different synthetic password' }])
    assert.equal((await post(`${RECEIVER}/accept`, body)).status, 400);
  assert.equal(await count('cb_auth_accounts'), 5);
  const accepted = await auth.acceptInvitation({ token: invitation.token, password: PASSWORD });
  assert.equal(accepted.invitation.role, 'guardian');
});

test('a live session cannot be silently replaced by a new account, even when no expected-account header was sent', async () => {
  const invitation = await invite(), cookie = await login('guardian-a'), sessions = await count('cb_auth_sessions');
  const result = await post(`${RECEIVER}/accept`, { ...confirmed(invitation), password: PASSWORD, confirmation: PASSWORD }, cookie,
    { headers: { 'X-Carebridge-Account': undefined } });
  error(result, 409, 'ACCOUNT_SESSION_PRESENT'); assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(await count('cb_auth_accounts'), 5); assert.equal(await count('cb_auth_sessions'), sessions);
  assert.equal((await call('/api/local/auth/session', { cookie })).json.user.userId, 'guardian-a');
});

test('new acceptance committed response loss is reconciled by login, never by silently replacing credentials or consuming twice', async () => {
  const invitation = await invite();
  const saved = auth.acceptInvitation.bind(auth);
  options.auth = Object.create(auth);
  options.auth.acceptInvitation = async input => { await saved(input); throw new Error('synthetic post-commit response loss'); };
  error(await accept(invitation), 503, 'LOCAL_API_UNAVAILABLE');
  options.auth = auth;
  error(await accept(invitation), 410, 'INVITATION_INVALID');
  const cookie = await login('new-person', invitation.email);
  assert.equal((await call('/api/local/auth/session', { cookie })).json.user.email, invitation.email);
  assert.equal(await count('cb_auth_accounts'), 6);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_auth_audit_events WHERE action='invitation.accepted'")).rows[0].n, 1);
});

test('existing account joins with its current cookie/account precondition and exact retry leaves credentials/session/history unchanged', async () => {
  const invitation = await invite('stranger-a@synthetic.test'), cookie = await login('stranger-a');
  const before = (await db.query("SELECT * FROM cb_auth_accounts WHERE user_id='stranger-a'")).rows[0];
  const sessionCount = await count('cb_auth_sessions');
  const first = await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie);
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.json).sort(), ['user', 'invitation', 'linked', 'replayed'].sort());
  assert.equal(first.json.linked, true); assert.equal(first.json.replayed, false); assert.equal(first.headers['set-cookie'], undefined);
  error(await post(`${RECEIVER}/preview`, { token: invitation.token }), 410, 'INVITATION_INVALID');
  const retry = await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie);
  assert.equal(retry.status, 200); assert.equal(retry.json.replayed, true);
  assert.deepEqual((await db.query("SELECT * FROM cb_auth_accounts WHERE user_id='stranger-a'")).rows[0], before);
  assert.equal(await count('cb_auth_sessions'), sessionCount); assert.equal(await count('cb_auth_accounts'), 5);
  error(await call('/api/local/centers/center-a/conversations/room-a/messages', { cookie }), 404, 'NOT_FOUND');
  await noChildWrites();
});

test('existing account committed reply loss permits the same bound retry without another audit event or grant', async () => {
  const invitation = await invite('stranger-a@synthetic.test'), cookie = await login('stranger-a');
  const saved = auth.acceptExistingInvitation.bind(auth);
  options.auth = Object.create(auth);
  options.auth.acceptExistingInvitation = async (...args) => { await saved(...args); throw new Error('synthetic committed receipt loss'); };
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie), 503, 'LOCAL_API_UNAVAILABLE');
  options.auth = auth;
  const retry = await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie);
  assert.equal(retry.status, 200); assert.equal(retry.json.replayed, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_auth_audit_events WHERE action='invitation.accepted'")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE user_id='stranger-a'")).rows[0].n, 1);
});

test('existing acceptance rejects wrong account, missing binding and old-tab replacement cookies', async () => {
  const invitation = await invite('stranger-a@synthetic.test'), stranger = await login('stranger-a'), guardian = await login('guardian-a');
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation)), 401, 'AUTH_REQUIRED');
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), stranger, { headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), guardian), 410, 'INVITATION_INVALID');
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), guardian, { headers: { 'X-Carebridge-Account': 'stranger-a' } }), 401, 'AUTH_REQUIRED');
  assert.equal((await db.query("SELECT accepted_at FROM cb_auth_invitations WHERE id=$1", [invitation.id])).rows[0].accepted_at, null);
});

test('a pre-existing account cannot be overwritten by the new-account endpoint', async () => {
  const invitation = await invite('stranger-a@synthetic.test');
  const before = (await db.query("SELECT * FROM cb_auth_accounts WHERE user_id='stranger-a'")).rows[0];
  error(await accept(invitation), 409, 'INVITATION_ACCOUNT_EXISTS');
  assert.deepEqual((await db.query("SELECT * FROM cb_auth_accounts WHERE user_id='stranger-a'")).rows[0], before);
});

test('same-role active membership can consume an invitation but role change or suspension can never be restored by replay', async () => {
  // No child participant here: the existing participant/role FK correctly
  // forbids changing an assigned user's role behind its relationship.
  await db.query("INSERT INTO cb_memberships VALUES ('center-a','stranger-a','guardian',true)");
  const invitation = await invite('stranger-a@synthetic.test'), cookie = await login('stranger-a');
  assert.equal((await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie)).status, 200);
  await db.query("UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='stranger-a'");
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie), 409, 'INVITATION_MEMBERSHIP_UNAVAILABLE');
  await db.query("UPDATE cb_memberships SET active=true,role='therapist' WHERE center_id='center-a' AND user_id='stranger-a'");
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie), 409, 'INVITATION_MEMBERSHIP_UNAVAILABLE');
  assert.equal((await db.query("SELECT role FROM cb_memberships WHERE center_id='center-a' AND user_id='stranger-a'")).rows[0].role, 'therapist');
});

test('center invitation roles cannot mint another manager and unsupported identity/history claims are rejected', async () => {
  const cookie = await login();
  for (const body of [{ email: 'new@synthetic.test', role: 'center' }, { email: 'new@synthetic.test', role: 'guardian', userId: 'manager-a' },
    { email: 'new@synthetic.test', role: 'guardian', history: 'all' }]) error(await post(BASE, body, cookie), 400, 'INVALID_INPUT');
  const invitation = await invite('stranger-a@synthetic.test'); const stranger = await login('stranger-a');
  error(await post(`${RECEIVER}/accept-existing`, { ...confirmed(invitation), role: 'center' }, stranger), 400, 'INVALID_INPUT');
  error(await post(`${RECEIVER}/accept-existing`, { ...confirmed(invitation), userId: 'manager-a' }, stranger), 400, 'INVALID_INPUT');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE role='center'")).rows[0].n, 2);
});

test('only the current center manager can list, issue or revoke in its own tenant', async () => {
  const invitation = await invite();
  for (const userId of ['therapist-a', 'guardian-a', 'manager-b']) {
    const cookie = await login(userId);
    error(await call(BASE, { cookie }), 404, 'NOT_FOUND');
    error(await post(BASE, { email: `${userId}.new@synthetic.test`, role: 'guardian' }, cookie), 404, 'NOT_FOUND');
    error(await post(`${BASE}/${invitation.id}/revoke`, {}, cookie), 404, 'NOT_FOUND');
  }
  error(await call(BASE), 401, 'AUTH_REQUIRED');
  assert.equal(await count('cb_auth_invitations'), 1);
});

test('current transaction authority wins after HTTP authentication; a lost manager role makes no new invitation write', async () => {
  const cookie = await login(); const realAuthenticate = auth.authenticate.bind(auth);
  options.auth = Object.create(auth);
  options.auth.authenticate = async token => {
    const user = await realAuthenticate(token);
    await db.query("UPDATE cb_memberships SET role='guardian' WHERE center_id='center-a' AND user_id='manager-a'");
    return user;
  };
  // Delivery intentionally returns the same acknowledgement even when issuance
  // fails. This is not represented as a successful grant or actual delivery.
  const response = await post(BASE, { email: 'race@synthetic.test', role: 'guardian' }, cookie);
  assert.equal(response.status, 202); assert.equal(envelopes.length, 0); assert.equal(await count('cb_auth_invitations'), 0);
  options.auth = auth; error(await call(BASE, { cookie }), 404, 'NOT_FOUND');
});

test('revocation stops preview and both consumption paths, while a second revoke asks for current status', async () => {
  const cookie = await login(), invitation = await invite('stranger-a@synthetic.test', 'guardian', cookie);
  assert.deepEqual((await post(`${BASE}/${invitation.id}/revoke`, {}, cookie)).json, { revoked: true });
  error(await post(`${RECEIVER}/preview`, { token: invitation.token }), 410, 'INVITATION_INVALID');
  error(await accept(invitation), 410, 'INVITATION_INVALID');
  error(await post(`${RECEIVER}/accept-existing`, confirmed(invitation), await login('stranger-a')), 410, 'INVITATION_INVALID');
  error(await post(`${BASE}/${invitation.id}/revoke`, {}, cookie), 409, 'INVITATION_NOT_PENDING');
  error(await post(`${BASE}/inv_${'f'.repeat(32)}/revoke`, {}, cookie), 404, 'NOT_FOUND');
});

for (const mode of ['expired', 'inviter-disabled', 'inviter-role-changed']) {
  test(`preview and acceptance fail closed for ${mode}`, async () => {
    const invitation = await invite();
    if (mode === 'expired') await db.query("UPDATE cb_auth_invitations SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [invitation.id]);
    if (mode === 'inviter-disabled') await db.query("UPDATE cb_users SET active=false WHERE id='manager-a'");
    if (mode === 'inviter-role-changed') await db.query("UPDATE cb_memberships SET role='guardian' WHERE center_id='center-a' AND user_id='manager-a'");
    error(await post(`${RECEIVER}/preview`, { token: invitation.token }), 410, 'INVITATION_INVALID');
    error(await accept(invitation), 410, 'INVITATION_INVALID');
    assert.equal(await count('cb_auth_accounts'), 5);
  });
}

test('unavailable, malformed, wrong-purpose and consumed tokens share the same safe preview response', async () => {
  const invitation = await invite(); await accept(invitation);
  let previous;
  for (const token of [invitation.token, randomBytes(32).toString('base64url'), 'cr1.' + 'a'.repeat(43), '', null]) {
    const result = await post(`${RECEIVER}/preview`, { token }); error(result, 410, 'INVITATION_INVALID');
    if (previous) assert.deepEqual(result.json, previous); previous = result.json;
  }
});

test('real addresses, header syntax, controls, overlong and extra fields fail before issuance', async () => {
  const cookie = await login();
  for (const email of ['person@example.com', 'name <person@synthetic.test>', 'person@synthetic.test\r\nBcc:x@synthetic.test',
    'x\u0000@synthetic.test', '\ud800@synthetic.test', `${'x'.repeat(250)}@synthetic.test`])
    error(await post(BASE, { email, role: 'guardian' }, cookie), 400, 'INVALID_INPUT');
  for (const key of ['recipient', 'origin', 'transport', 'redirectUrl', 'token', 'clientId'])
    error(await post(BASE, { email: 'new@synthetic.test', role: 'guardian', [key]: 'caller-input' }, cookie), 400, 'INVALID_INPUT');
  assert.equal(await count('cb_auth_invitations'), 0); assert.equal(envelopes.length, 0);
});

test('closed paths/methods/query and CSRF/host/account checks apply to recipient and manager endpoints', async () => {
  const cookie = await login(), invitation = await invite('new-person@synthetic.test', 'guardian', cookie);
  for (const path of [`${BASE}?limit=100`, `${BASE}?token=x`, `${RECEIVER}/preview?token=x`, `${BASE}/${invitation.id}/revoke?confirm=1`])
    error(await call(path, { method: path.includes('/preview') || path.includes('/revoke') ? 'POST' : 'GET', cookie, body: {} }), 400, 'INVALID_INPUT');
  for (const path of [`${RECEIVER}/preview`, `${RECEIVER}/accept`, `${RECEIVER}/accept-existing`])
    error(await call(path), 404, 'NOT_FOUND');
  error(await call(BASE, { method: 'DELETE', cookie }), 404, 'NOT_FOUND');
  error(await post('/api/auth/invitations', {}), 404, 'NOT_FOUND');
  for (const headers of [{ Origin: 'http://127.0.0.1:1' }, { Origin: undefined }, { 'X-Carebridge-Request': undefined },
    { Host: 'localhost' }, { 'Sec-Fetch-Site': 'same-site' }])
    error(await post(`${RECEIVER}/preview`, { token: invitation.token }, undefined, { headers }), 403, 'SOURCE_REJECTED');
  error(await call(BASE, { cookie, headers: { 'X-Carebridge-Account': 'guardian-a' } }), 401, 'AUTH_REQUIRED');
  error(await call(BASE, { cookie, headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
  error(await post(`${RECEIVER}/preview`, { token: invitation.token }, undefined,
    { headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
});

test('duplicate issuance and rejected/throwing transport remain indistinguishable publicly, with no automatic re-issue', async () => {
  const cookie = await login(), first = await invite('same@synthetic.test', 'guardian', cookie);
  const second = await post(BASE, { email: first.email, role: first.role }, cookie);
  assert.deepEqual(second.json, first.response.json); assert.equal(envelopes.length, 1); assert.equal(await count('cb_auth_invitations'), 1);
  deliveryBehavior = async () => ({ status: 'rejected' });
  const rejected = await post(BASE, { email: 'rejected@synthetic.test', role: 'guardian' }, cookie);
  deliveryBehavior = async () => { throw new Error('synthetic private transport diagnostics'); };
  const unknown = await post(BASE, { email: 'unknown@synthetic.test', role: 'guardian' }, cookie);
  for (const result of [rejected, unknown]) { assert.equal(result.status, 202); assert.deepEqual(result.json, first.response.json); }
  assert.equal(await count('cb_auth_invitations'), 3); assert.equal(envelopes.length, 1);
});

test('list has a strict bounded complete result and refuses overflow rather than hiding older invitations', async () => {
  const cookie = await login();
  await db.query(`INSERT INTO cb_auth_invitations(id,center_id,email,role,token_hash,invited_by,expires_at)
    SELECT 'inv_'||md5(n::text),'center-a','bounded-'||n||'@synthetic.test','guardian',
      md5(n::text)||md5(n::text),'manager-a',clock_timestamp()+interval '1 day' FROM generate_series(1,101) n`);
  error(await call(BASE, { cookie }), 409, 'INVITATION_LIST_LIMIT');
  assert.equal((await auth.listInvitations(MANAGER, { centerId: 'center-a' })).length, 101);
  for (const limit of [0, 101, '100', 1.5]) await assert.rejects(auth.listInvitations(MANAGER, { centerId: 'center-a', limit }), authCode('INVALID_INPUT'));
});

test('a new accepted membership still requires a separately confirmed relationship and does not inherit past messages', async () => {
  const invitation = await invite('stranger-a@synthetic.test'), cookie = await login('stranger-a');
  const chat = options.conversations;
  await chat.sendText({ userId: 'therapist-a', centerId: 'center-a' }, { conversationId: 'room-a', clientId: 'before-invitation-link', body: '합성 과거 소식' });
  assert.equal((await post(`${RECEIVER}/accept-existing`, confirmed(invitation), cookie)).status, 200);
  error(await call('/api/local/centers/center-a/conversations/room-a/messages', { cookie }), 404, 'NOT_FOUND');
  const relations = new Relationships(db); const actor = { userId: 'manager-a', centerId: 'center-a' };
  const current = await relations.get(actor, { conversationId: 'room-a' });
  await relations.replace(actor, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: current.version,
    therapist: { userId: 'therapist-a', history: 'preserve' }, guardians: [
      { userId: 'guardian-a', history: 'preserve' }, { userId: 'stranger-a', history: 'from_now' }],
    historyConfirmed: true, pastHistoryConfirmed: false });
  const messages = await call('/api/local/centers/center-a/conversations/room-a/messages', { cookie });
  assert.equal(messages.status, 200); assert.deepEqual(messages.json.messages, []);
});

test('failed acceptance transaction rolls back account/session/grant and allows the identical corrected retry', async () => {
  const invitation = await invite(); const sessions = await count('cb_auth_sessions');
  await db.exec(`CREATE FUNCTION cb_test_invitation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='invitation.accepted' THEN RAISE EXCEPTION 'synthetic private diagnostic'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_invitation_failure BEFORE INSERT ON cb_auth_audit_events FOR EACH ROW EXECUTE FUNCTION cb_test_invitation_failure()`);
  try { error(await accept(invitation), 503, 'LOCAL_API_UNAVAILABLE'); }
  finally { await db.exec('DROP TRIGGER cb_test_invitation_failure ON cb_auth_audit_events; DROP FUNCTION cb_test_invitation_failure()'); }
  assert.equal(await count('cb_auth_accounts'), 5); assert.equal(await count('cb_auth_sessions'), sessions);
  assert.equal((await post(`${RECEIVER}/preview`, { token: invitation.token })).status, 200);
  assert.equal((await accept(invitation)).status, 200);
});
