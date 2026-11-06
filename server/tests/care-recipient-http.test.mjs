// Invented accounts, memory-only database and loopback HTTP. No native/E data.
import assert from 'node:assert/strict';
import { before, beforeEach, after, afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Relationships } from '../relationships.mjs';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { PrimaryCommunicators } from '../primary-communicators.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localParticipationRoute } from '../local-participation-http.mjs';

const prefix = '/api/local/centers/center-a';
const manager = { centerId: 'center-a', userId: 'manager-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const password = 'Synthetic recipient HTTP password 2026!';
let db, auth, chat, links, primary, server, origin, options, recipientId;
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; } });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('therapist-a',true),('manager-a',true),('manager-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','therapist-a','therapist',true),
      ('center-a','manager-a','center',true),('center-b','manager-b','center',true);
    INSERT INTO cb_children VALUES ('center-a','child-a');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1);`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 } });
  for (const userId of ['guardian-a', 'therapist-a', 'manager-a', 'manager-b'])
    await auth.provisionAccount({ userId, email: `${userId}@recipient-http.test`, password });
  const invitation = await auth.createInvitation(manager, { centerId: 'center-a', email: 'independent@recipient-http.test', role: 'care_recipient' });
  const accepted = await auth.acceptInvitation({ token: invitation.token, password, centerId: 'center-a', role: 'care_recipient' });
  recipientId = accepted.user.userId;
  chat = new Conversations(db); links = new CareRecipientLinks(db); primary = new PrimaryCommunicators(db);
  server = createServer((req, res) => handleLocalApiRequest(req, res, options));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles: new Children(db), memberProfiles: new MemberProfiles(db),
    relationships: new Relationships(db), careRecipientLinks: links, primaryCommunicators: primary,
    origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});
async function call(path, { session, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie, 'X-Carebridge-Account': session.userId } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
async function login(userId) {
  const email = userId === recipientId ? 'independent@recipient-http.test' : `${userId}@recipient-http.test`;
  const result = await call('/api/local/auth/login', { body: { email, password } });
  assert.equal(result.status, 200);
  return { userId, cookie: result.headers.get('set-cookie').split(';')[0] };
}
async function connect() {
  const state = await links.get(manager, { conversationId: 'room-a' });
  return links.connect(manager, { conversationId: 'room-a', userId: recipientId, expectedVersion: state.version, clientId: randomUUID() });
}

test('independent invitation creates no room link and cannot convert the guardian account', async () => {
  assert.notEqual(recipientId, 'guardian-a');
  assert.equal((await db.query('SELECT * FROM cb_participants WHERE user_id=$1', [recipientId])).rows.length, 0);
  const guardian = await auth.login({ email: 'guardian-a@recipient-http.test', password });
  const invitation = await auth.createInvitation(manager, { centerId: 'center-a', email: 'guardian-a@recipient-http.test', role: 'care_recipient' });
  await assert.rejects(auth.acceptExistingInvitation(guardian.token,
    { token: invitation.token, centerId: 'center-a', role: 'care_recipient' }), { code: 'INVITATION_MEMBERSHIP_UNAVAILABLE' });
  assert.equal((await auth.authenticate(guardian.token)).userId, 'guardian-a');
  assert.equal((await db.query("SELECT role FROM cb_memberships WHERE center_id='center-a' AND user_id='guardian-a'")).rows[0].role, 'guardian');
  const session = await login(recipientId);
  assert.equal((await call(`${prefix}/conversations/room-a/messages`, { session })).status, 404);
  assert.equal((await call(`${prefix}/primary-communicator?conversationId=room-a`, { session })).status, 404);
});

test('manager links an independent recipient through HTTP without changing existing participants', async () => {
  const session = await login('manager-a');
  const before = await db.query("SELECT user_id,role,active,first_sequence FROM cb_participants WHERE conversation_id='room-a' ORDER BY user_id");
  const state = await call(`${prefix}/care-recipient-link?conversationId=room-a`, { session });
  assert.equal(state.status, 200); assert.equal(state.body.link.active, false);
  const body = { conversationId: 'room-a', userId: recipientId, expectedVersion: state.body.link.version, clientId: randomUUID() };
  const saved = await call(`${prefix}/care-recipient-link`, { session, body });
  assert.equal(saved.status, 200); assert.equal(saved.body.receipt.changed, true);
  const replay = await call(`${prefix}/care-recipient-link`, { session, body });
  assert.equal(replay.status, 200); assert.equal(replay.body.receipt.replayed, true);
  const after = await db.query("SELECT user_id,role,active,first_sequence FROM cb_participants WHERE conversation_id='room-a' AND user_id<>$1 ORDER BY user_id", [recipientId]);
  assert.deepEqual(after.rows, before.rows);
  const members = await call(`${prefix}/operations/members`, { session });
  assert.equal(members.status, 200); assert(members.body.members.some(value => value.userId === recipientId && value.role === 'care_recipient'));
});

test('primary communicator HTTP is separate from access and invalidates no guardian permissions', async () => {
  await connect();
  const session = await login('manager-a'), recipient = await login(recipientId);
  const before = (await db.query('SELECT * FROM cb_participants ORDER BY user_id')).rows;
  const state = await call(`${prefix}/primary-communicator?conversationId=room-a`, { session });
  assert.equal(state.status, 200);
  const saved = await call(`${prefix}/primary-communicator`, { session,
    body: { conversationId: 'room-a', userId: recipientId, expectedRevision: state.body.primary.revision, clientId: randomUUID() } });
  assert.equal(saved.status, 200);
  const current = await call(`${prefix}/primary-communicator?conversationId=room-a`, { session: recipient });
  assert.equal(current.status, 200); assert.equal(current.body.primary.userId, recipientId);
  assert.deepEqual((await db.query('SELECT * FROM cb_participants ORDER BY user_id')).rows, before);
  assert.equal((await call(`${prefix}/primary-communicator`, { session: recipient,
    body: { conversationId: 'room-a', userId: 'guardian-a', expectedRevision: current.body.primary.revision, clientId: randomUUID() } })).status, 404);
  await db.query('UPDATE cb_users SET active=false WHERE id=$1', [recipientId]);
  const stale = await call(`${prefix}/primary-communicator?conversationId=room-a`, { session });
  assert.equal(stale.status, 200); assert.equal(stale.body.primary.userId, null);
});

test('recipient HTTP sends only allowed new text; previous messages and clinical routes stay unavailable', async () => {
  const prior = await chat.sendText(therapist, { conversationId: 'room-a', clientId: randomUUID(), body: 'synthetic prior private text' });
  await connect();
  const session = await login(recipientId);
  const sent = await call(`${prefix}/conversations/room-a/messages`, { session,
    body: { clientId: randomUUID(), body: 'synthetic recipient question' } });
  assert.equal(sent.status, 201); assert.equal(sent.body.message.body, 'synthetic recipient question');
  const list = await call(`${prefix}/conversations/room-a/messages`, { session });
  assert.equal(list.status, 200); assert(!JSON.stringify(list.body).includes('synthetic prior private text'));
  assert.equal((await call(`${prefix}/conversations/room-a/messages/${prior.id}`, { session })).status, 404);
  for (const suffix of ['records', 'goals', 'appointments', 'family-plan'])
    assert.equal((await call(`${prefix}/conversations/room-a/${suffix}`, { session })).status, 404);
  const profile = await call(`${prefix}/conversations/room-a/profile`, { session });
  assert.equal(profile.status, 200); assert.equal(profile.body.familyPlan, null);
  assert.deepEqual(profile.body.participants.map(value => Object.keys(value).sort()),
    profile.body.participants.map(() => ['displayName', 'role', 'userId']));
});

test('new endpoints retain authentication, center scoping, account precondition and CSRF', async () => {
  const managerSession = await login('manager-a'), foreign = await login('manager-b'), guardian = await login('guardian-a');
  const endpoint = `${prefix}/care-recipient-link?conversationId=room-a`;
  assert.equal((await call(endpoint)).status, 401);
  assert.equal((await call(endpoint, { session: foreign })).status, 404);
  assert.equal((await call(endpoint, { session: guardian })).status, 404);
  assert.equal((await call(endpoint, { session: managerSession, headers: { 'X-Carebridge-Account': 'guardian-a' } })).status, 401);
  const state = await links.get(manager, { conversationId: 'room-a' });
  const body = { conversationId: 'room-a', userId: recipientId, expectedVersion: state.version, clientId: randomUUID() };
  assert.equal((await call(`${prefix}/care-recipient-link`, { session: managerSession, body, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await call(`${prefix}/care-recipient-link`, { session: managerSession, body: { ...body, role: 'center' } })).status, 400);
  assert.equal((await links.get(manager, { conversationId: 'room-a' })).active, false);
});

test('closed route parser rejects duplicate target parameters, body authority and invalid actions', () => {
  for (const [suffix, method] of [['care-recipient-link?conversationId=room-a&conversationId=room-b', 'GET'],
    ['care-recipient-link?conversationId=room-a&role=center', 'GET'], ['primary-communicator/disconnect', 'POST'],
    ['care-recipient-link/disconnect', 'GET'], ['primary-communicator?conversationId=room-a', 'POST']])
    assert.throws(() => localParticipationRoute(new URL(`${prefix}/${suffix}`, origin), method));
});
