import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { createHash,randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth,AuthError } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';

let db,auth,session;
const password = 'fictional test credential', manager = { userId:'manager-b' };
const errorCode = (code) => (error) => error instanceof AuthError && error.code === code;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const invite = (extra = {}) => auth.createInvitation(manager,{ centerId:'center-b',email:'guardian-a@example.com',role:'guardian',...extra });
const accept = (invitation,token = session.token,extra = {}) => auth.acceptExistingInvitation(token,{ token:invitation.token,centerId:invitation.centerId,role:invitation.role,...extra });
const account = async () => (await db.query("SELECT * FROM cb_auth_accounts WHERE user_id = 'guardian-a'")).rows[0];
const pending = async (invitation) => (await db.query('SELECT accepted_at FROM cb_auth_invitations WHERE id = $1',[invitation.id])).rows[0].accepted_at;
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-b',true),('guardian-a',true),('guardian-other',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-b','manager-b','center',true),('center-a','guardian-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-b','child-b'); INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-b','room-b','child-b');`);
  auth = new Auth(db,{ password:{ N:1024,r:8,p:1,maxmem:32 * 1024 ** 2 } });
  for (const userId of ['guardian-a','guardian-other','manager-a','manager-b']) await auth.provisionAccount({ userId,email:`${userId}@example.com`,password });
  session = await auth.login({ email:'guardian-a@example.com',password });
});

test('existing account joins invited center without replacing credentials/user/session or automatically receiving child/history access',async () => {
  const before = await account(), invitation = await invite(), originalExpiry = session.user.expiresAt;
  const joined = await accept(invitation); assert.equal(joined.linked,true); assert.equal(joined.replayed,false);
  assert.deepEqual(joined.user.centers,[{ id:'center-a',role:'guardian' },{ id:'center-b',role:'guardian' }]);
  assert.equal(joined.user.userId,session.user.userId); assert.equal(joined.user.expiresAt,originalExpiry); assert.equal('token' in joined,false);
  assert.deepEqual(await account(),before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_users')).rows[0].n,4);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_participants')).rows[0].n,0);
  assert.deepEqual(await auth.authenticate(session.token),joined.user);
  await assert.rejects(new Conversations(db).list({ centerId:'center-b',userId:'guardian-a' },{ conversationId:'room-b' }),
    (error) => error instanceof RepositoryError && error.code === 'NOT_FOUND');
  assert.equal((await auth.login({ email:'guardian-a@example.com',password })).user.centers.length,2);
});

test('only matching authenticated owner can accept; bare user IDs, unknown/revoked/expired sessions and disabled accounts cannot link',async () => {
  const invitation = await invite(), other = await auth.login({ email:'guardian-other@example.com',password });
  await assert.rejects(accept(invitation,other.token),errorCode('INVITATION_INVALID'));
  for (const token of ['guardian-a',randomBytes(32).toString('base64url'),null]) await assert.rejects(accept(invitation,token),errorCode('AUTH_REQUIRED'));
  await auth.logout(session.token); await assert.rejects(accept(invitation),errorCode('AUTH_REQUIRED'));
  session = await auth.login({ email:'guardian-a@example.com',password });
  await db.query("UPDATE cb_auth_sessions SET expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1",[hash(session.token)]);
  await assert.rejects(accept(invitation),errorCode('AUTH_REQUIRED'));
  session = await auth.login({ email:'guardian-a@example.com',password }); await db.query("UPDATE cb_users SET active = false WHERE id = 'guardian-a'");
  await assert.rejects(accept(invitation),errorCode('AUTH_REQUIRED')); assert.equal(await pending(invitation),null);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE user_id = 'guardian-a' AND center_id = 'center-b'")).rows[0].n,0);
});

test('explicit center/role confirmation and strict fields prevent hidden target substitution or caller-selected identity',async () => {
  const invitation = await invite();
  for (const extra of [{ centerId:'center-a' },{ role:'therapist' }]) await assert.rejects(accept(invitation,session.token,extra),errorCode('INVITATION_INVALID'));
  for (const extra of [{ userId:'guardian-a' },{ email:'guardian-a@example.com' },{ password },{ history:'all' }]) await assert.rejects(accept(invitation,session.token,extra),errorCode('INVALID_INPUT'));
  await assert.rejects(accept(invitation,session.token,{ role:'center' }),errorCode('INVALID_INPUT'));
  assert.equal(await pending(invitation),null);
});

test('replays are content-free and cannot reactivate a subsequently suspended membership or change its role',async () => {
  const invitation = await invite(); await accept(invitation); const auditCount = (await db.query('SELECT count(*)::int AS n FROM cb_auth_audit_events')).rows[0].n;
  await db.query("UPDATE cb_auth_invitations SET expires_at = created_at + interval '1 millisecond' WHERE id = $1",[invitation.id]);
  const replay = await accept(invitation); assert.equal(replay.replayed,true); assert.equal(replay.linked,true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_audit_events')).rows[0].n,auditCount);
  await db.exec("UPDATE cb_memberships SET active = false WHERE center_id = 'center-b' AND user_id = 'guardian-a'");
  await assert.rejects(accept(invitation),errorCode('INVITATION_MEMBERSHIP_UNAVAILABLE'));
  assert.equal((await db.query("SELECT active FROM cb_memberships WHERE center_id = 'center-b' AND user_id = 'guardian-a'")).rows[0].active,false);
  const text = JSON.stringify((await db.query('SELECT * FROM cb_auth_audit_events')).rows);
  assert.equal(text.includes(invitation.token),false); assert.equal(text.includes(session.token),false); assert.equal(text.includes('guardian-a@example.com'),false);
});

test('an already-active matching center membership consumes the invitation without duplicating it; conflicting roles and suspensions stay unchanged',async () => {
  await db.exec("INSERT INTO cb_memberships VALUES ('center-b','guardian-a','guardian',true)");
  const same = await invite(); assert.equal((await accept(same)).linked,true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE center_id = 'center-b' AND user_id = 'guardian-a'")).rows[0].n,1);
  const different = await invite({ role:'therapist' }); await assert.rejects(accept(different),errorCode('INVITATION_MEMBERSHIP_UNAVAILABLE')); assert.equal(await pending(different),null);
  await db.exec("UPDATE cb_memberships SET active = false WHERE center_id = 'center-b' AND user_id = 'guardian-a'");
  const suspended = await invite(); await assert.rejects(accept(suspended),errorCode('INVITATION_MEMBERSHIP_UNAVAILABLE')); assert.equal(await pending(suspended),null);
});

test('revoked/expired invitations and loss of inviter current center authority block both existing and new account acceptance',async () => {
  const revoked = await invite(); await auth.revokeInvitation(manager,{ centerId:'center-b',invitationId:revoked.id });
  await assert.rejects(accept(revoked),errorCode('INVITATION_INVALID'));
  const expired = await invite(); await db.query("UPDATE cb_auth_invitations SET expires_at = created_at + interval '1 millisecond' WHERE id = $1",[expired.id]);
  await assert.rejects(accept(expired),errorCode('INVITATION_INVALID'));
  const existing = await invite(), fresh = await invite({ email:'new-account@example.com' });
  await db.exec("UPDATE cb_memberships SET active = false WHERE center_id = 'center-b' AND user_id = 'manager-b'");
  await assert.rejects(accept(existing),errorCode('INVITATION_INVALID'));
  await assert.rejects(auth.acceptInvitation({ token:fresh.token,password }),errorCode('INVITATION_INVALID'));
  await db.exec("UPDATE cb_memberships SET active = true WHERE center_id = 'center-b' AND user_id = 'manager-b'; UPDATE cb_users SET active = false WHERE id = 'manager-b'");
  await assert.rejects(accept(existing),errorCode('INVITATION_INVALID'));
  assert.equal(await pending(existing),null); assert.equal(await pending(fresh),null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_users')).rows[0].n,4);
});

test('audit write failure rolls back membership/acceptance and the same token retry creates one accepted event without a new session',async () => {
  const invitation = await invite(), before = await account();
  await db.exec(`CREATE FUNCTION cb_test_link_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test link failure'; END; $$;
    CREATE TRIGGER cb_test_link_failure BEFORE INSERT ON cb_auth_audit_events FOR EACH ROW EXECUTE FUNCTION cb_test_link_failure()`);
  try { await assert.rejects(accept(invitation),(error) => /test link failure/.test(error.message)); }
  finally { await db.exec('DROP TRIGGER cb_test_link_failure ON cb_auth_audit_events; DROP FUNCTION cb_test_link_failure()'); }
  assert.equal(await pending(invitation),null);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE user_id = 'guardian-a' AND center_id = 'center-b'")).rows[0].n,0);
  assert.deepEqual(await account(),before); await accept(invitation); await accept(invitation);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_auth_audit_events WHERE action = 'invitation.accepted'")).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n,1);
});

test('expiration during acceptance is rechecked at the actual write and rolls back both existing grants and new account creation',async () => {
  const existing = await invite(), fresh = await invite({ email:'late-expiry@example.com' });
  await db.exec(`CREATE FUNCTION cb_test_late_invitation_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE cb_auth_invitations SET expires_at = created_at + interval '1 millisecond' WHERE accepted_at IS NULL; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_late_invitation_expiry AFTER INSERT ON cb_memberships FOR EACH ROW EXECUTE FUNCTION cb_test_late_invitation_expiry()`);
  try {
    await assert.rejects(accept(existing),errorCode('INVITATION_INVALID'));
    await assert.rejects(auth.acceptInvitation({ token:fresh.token,password }),errorCode('INVITATION_INVALID'));
  } finally { await db.exec('DROP TRIGGER cb_test_late_invitation_expiry ON cb_memberships; DROP FUNCTION cb_test_late_invitation_expiry()'); }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_users')).rows[0].n,4);
  assert.equal(await pending(existing),null); assert.equal(await pending(fresh),null);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_memberships WHERE user_id = 'guardian-a' AND center_id = 'center-b'")).rows[0].n,0);
  await db.exec(`CREATE FUNCTION cb_test_late_session_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE cb_auth_sessions SET expires_at = created_at + interval '1 millisecond'; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_late_session_expiry AFTER INSERT ON cb_memberships FOR EACH ROW EXECUTE FUNCTION cb_test_late_session_expiry()`);
  try { await assert.rejects(accept(existing),errorCode('AUTH_REQUIRED')); }
  finally { await db.exec('DROP TRIGGER cb_test_late_session_expiry ON cb_memberships; DROP FUNCTION cb_test_late_session_expiry()'); }
  assert.equal(await pending(existing),null); assert.equal((await accept(existing)).linked,true);
  assert.equal((await auth.acceptInvitation({ token:fresh.token,password })).user.centers[0].id,'center-b');
});

test('new-account invitation path still cannot replace an existing account and only its authenticated owner may later replay its acceptance',async () => {
  const existing = await invite(); await assert.rejects(auth.acceptInvitation({ token:existing.token,password }),errorCode('INVITATION_ACCOUNT_EXISTS'));
  const fresh = await invite({ email:'fresh-account@example.com' }), created = await auth.acceptInvitation({ token:fresh.token,password });
  assert.equal((await accept(fresh,created.token)).replayed,true);
  await assert.rejects(accept(fresh),errorCode('INVITATION_INVALID'));
  await assert.rejects(auth.acceptInvitation({ token:fresh.token,password }),errorCode('INVITATION_INVALID'));
  await assert.rejects(auth.acceptInvitation({ token:existing.token,password,userId:'guardian-a' }),errorCode('INVALID_INPUT'));
});
