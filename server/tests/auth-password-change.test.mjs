import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { handleAuthRequest } from '../auth-http.mjs';
import { migrate } from '../migrate.mjs';

const PASSWORD = 'Synthetic current credential';
const NEW_PASSWORD = 'Synthetic changed credential';
const OPTIONS = { password: { N:1024, r:8, p:1, maxmem:32 * 1024 ** 2 } };
const code = (expected) => (error) => error instanceof AuthError && error.code === expected;
const hash = (token) => createHash('sha256').update(token).digest('hex');
let db, auth, first, second, peer;
const login = (password = PASSWORD) => auth.login({ email:'guardian-a@example.com', password });
const change = (input = {}, token = first.token, service = auth) => service.changePassword(token, { currentPassword:PASSWORD, newPassword:NEW_PASSWORD, ...input });
const account = async () => (await db.query("SELECT * FROM cb_auth_accounts WHERE user_id = 'guardian-a'")).rows[0];
const sessions = async () => (await db.query('SELECT * FROM cb_auth_sessions ORDER BY token_hash')).rows;
function intercept(hook) {
  return new Auth({ transaction: (work) => db.transaction((tx) => work({
    query: (sql, params) => hook(tx, sql, params), exec: (sql) => tx.exec(sql),
  })) }, OPTIONS);
}

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('manager-a',true),('peer-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','manager-a','center',true),
      ('center-b','manager-a','center',true),('center-a','peer-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','synthetic-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','synthetic-room','synthetic-child');
    INSERT INTO cb_participants VALUES ('center-a','synthetic-room','guardian-a','guardian',true,1);`);
  auth = new Auth(db, OPTIONS);
  for (const userId of ['guardian-a','manager-a','peer-a']) await auth.provisionAccount({ userId,email:`${userId}@example.com`,password:PASSWORD });
  first = await login(); second = await login(); peer = await auth.login({ email:'peer-a@example.com',password:PASSWORD });
});

test('password change stores a fresh hash and timestamp, revokes all own sessions and returns no token or account data', async () => {
  const before = await account(), beforeSessions = await sessions();
  assert.deepEqual(await change(), { passwordChanged:true,reauthenticate:true });
  const saved = await account();
  assert.notEqual(saved.password_hash, before.password_hash); assert.ok(saved.password_updated_at >= before.password_updated_at);
  assert.equal(saved.password_hash.includes(PASSWORD), false); assert.equal(saved.password_hash.includes(NEW_PASSWORD), false);
  assert.equal(saved.email, before.email); assert.equal(saved.user_id, before.user_id);
  const afterSessions = await sessions(); assert.equal(afterSessions.length, beforeSessions.length);
  assert.ok(afterSessions.filter((item) => item.user_id === 'guardian-a').every((item) => item.revoked_at));
  assert.deepEqual(afterSessions.find((item) => item.user_id === 'peer-a'), beforeSessions.find((item) => item.user_id === 'peer-a'));
  assert.equal(await auth.authenticate(first.token), null); assert.equal(await auth.authenticate(second.token), null);
  assert.equal((await auth.authenticate(peer.token)).userId, 'peer-a');
});

test('only the new exact password signs in and a stale request cannot repeat or replace the change', async () => {
  await change(); const saved = await account(), storedSessions = await sessions();
  await assert.rejects(change({newPassword:'Synthetic another credential'}), code('AUTH_REQUIRED'));
  assert.deepEqual(await account(), saved); assert.deepEqual(await sessions(), storedSessions);
  await assert.rejects(login(), code('AUTH_INVALID'));
  const next = await login(NEW_PASSWORD); assert.notEqual(next.token, first.token);
  assert.equal((await auth.authenticate(next.token)).userId, 'guardian-a');
});

test('internal all-session revocation preserves other users and is safe after a password change', async () => {
  assert.equal(await auth.revokeAll('guardian-a'), 2);
  assert.equal(await auth.authenticate(first.token), null);
  assert.equal(await auth.authenticate(second.token), null);
  assert.equal((await auth.authenticate(peer.token)).userId, 'peer-a');
  const next = await login();
  await change({}, next.token);
  assert.equal(await auth.revokeAll('guardian-a'), 0);
});

test('password change does not rewrite memberships, child/history grants, room state, invitations or clinical tables', async () => {
  const tables = ['cb_users','cb_memberships','cb_children','cb_conversations','cb_participants','cb_auth_invitations','cb_auth_audit_events','cb_records','cb_messages'];
  const before = await Promise.all(tables.map((name) => db.query(`SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`)));
  await change();
  for (let index=0; index<tables.length; index++) assert.deepEqual((await db.query(`SELECT to_jsonb(t) AS row FROM ${tables[index]} t ORDER BY to_jsonb(t)::text`)).rows, before[index].rows);
});

test('wrong current proofs commit counters shared with login and cannot bypass the fifth-failure lock', async () => {
  const wrong = 'Synthetic incorrect credential';
  for (let index=0; index<2; index++) await assert.rejects(login(wrong), code('AUTH_INVALID'));
  for (let index=0; index<3; index++) await assert.rejects(change({currentPassword:wrong}), code('AUTH_INVALID'));
  const locked = await account(); assert.equal(locked.failed_attempts, 5); assert.ok(locked.locked_until);
  await assert.rejects(change(), code('AUTH_INVALID')); await assert.rejects(login(), code('AUTH_INVALID'));
  assert.deepEqual(await account(), locked);
  assert.ok((await sessions()).filter((item) => item.user_id === 'guardian-a').every((item) => !item.revoked_at));
});

test('after the DB-clock lock expires a valid proof changes password and clears failure state without reactivating relationships', async () => {
  await db.query("UPDATE cb_auth_accounts SET failed_attempts = 5,locked_until = clock_timestamp() - interval '1 second' WHERE user_id = 'guardian-a'");
  await db.query("UPDATE cb_memberships SET active = false WHERE user_id = 'guardian-a'");
  await change(); const saved = await account(); assert.equal(saved.failed_attempts,0); assert.equal(saved.locked_until,null);
  assert.equal((await db.query("SELECT active FROM cb_memberships WHERE user_id = 'guardian-a'")).rows[0].active, false);
});

for (const kind of ['unknown-session','revoked-session','expired-session','inactive-user','missing-account'])
  test(`${kind} cannot change credentials or lockout state`, async () => {
    let token = first.token;
    if (kind === 'unknown-session') token = randomBytes(32).toString('base64url');
    if (kind === 'revoked-session') await auth.logout(token);
    if (kind === 'expired-session') await db.query("UPDATE cb_auth_sessions SET created_at = clock_timestamp() - interval '1 day', expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",[hash(token)]);
    if (kind === 'inactive-user') await db.query("UPDATE cb_users SET active = false WHERE id = 'guardian-a'");
    if (kind === 'missing-account') await db.query("DELETE FROM cb_auth_accounts WHERE user_id = 'guardian-a'");
    const before = await account(), storedSessions = await sessions();
    await assert.rejects(change({},token), code('AUTH_REQUIRED'));
    assert.deepEqual(await account(),before); assert.deepEqual(await sessions(),storedSessions);
  });

test('closed input shape, password bounds and malformed sessions fail before any DB access', async () => {
  let calls = 0;
  const service = new Auth({ transaction() { calls++; throw new Error('No DB expected'); } }, OPTIONS);
  for (const input of [null,[],{}, { currentPassword:PASSWORD },{newPassword:NEW_PASSWORD},
    {currentPassword:PASSWORD,newPassword:'short'}, {currentPassword:PASSWORD,newPassword:'x'.repeat(129)},
    {currentPassword:'',newPassword:NEW_PASSWORD}, {currentPassword:PASSWORD,newPassword:NEW_PASSWORD,userId:'peer-a'},
    {currentPassword:PASSWORD,newPassword:NEW_PASSWORD,email:'peer-a@example.com'}, {currentPassword:PASSWORD,newPassword:NEW_PASSWORD,role:'center'}])
    await assert.rejects(service.changePassword(first.token,input), code('INVALID_INPUT'));
  for (const token of [null,'guardian-a','',{},'x'.repeat(101)]) await assert.rejects(change({}, token, service), code('AUTH_REQUIRED'));
  assert.equal(calls,0);
});

test('an unchanged password is explicitly rejected without updating credentials or sessions', async () => {
  const before = await account(), storedSessions = await sessions();
  await assert.rejects(change({newPassword:PASSWORD}), code('PASSWORD_UNCHANGED'));
  assert.deepEqual(await account(),before); assert.deepEqual(await sessions(),storedSessions);
});

test('Unicode and whitespace are preserved as exact credentials, not normalized or truncated', async () => {
  const value = '  가상 변경 비밀번호 2026  ';
  await change({newPassword:value});
  await assert.rejects(login(value.trim()), code('AUTH_INVALID'));
  assert.equal((await login(value)).user.userId, 'guardian-a');
});

test('input captured before the first await cannot be replaced while DB work is pending', async () => {
  const gate = Promise.withResolvers(); let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const service = new Auth({ transaction: async (work) => { started(); await gate.promise; return db.transaction(work); } }, OPTIONS);
  const input = {currentPassword:PASSWORD,newPassword:NEW_PASSWORD};
  const pending = service.changePassword(first.token,input); await ready;
  input.currentPassword = 'Synthetic wrong replacement'; input.newPassword = 'Synthetic unwanted replacement'; gate.resolve();
  await pending; assert.equal((await login(NEW_PASSWORD)).user.userId,'guardian-a');
});

test('a session revocation failure rolls back the already-written password, timestamp and failure reset', async () => {
  const before = await account(), storedSessions = await sessions();
  const service = intercept((tx,sql,params) => {
    if (sql.includes('UPDATE cb_auth_sessions SET revoked_at')) throw new Error('Synthetic revocation failure');
    return tx.query(sql,params);
  });
  await assert.rejects(change({},first.token,service), {message:'Synthetic revocation failure'});
  assert.deepEqual(await account(),before); assert.deepEqual(await sessions(),storedSessions);
  assert.equal((await login()).user.userId,'guardian-a');
});

for (const kind of ['credential-write','failed-proof'])
  test(`${kind} rechecks actual session expiry at the write boundary and rolls back`, async () => {
    const before = await account(), storedSessions = await sessions(); let reached = false;
    const service = intercept(async (tx,sql,params) => {
      if ((kind === 'credential-write' && sql.includes('UPDATE cb_auth_accounts SET password_hash')) ||
          (kind === 'failed-proof' && sql.includes('UPDATE cb_auth_accounts SET failed_attempts'))) {
        reached = true;
        await tx.query("UPDATE cb_auth_sessions SET created_at = clock_timestamp() - interval '1 day', expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",[hash(first.token)]);
      }
      return tx.query(sql,params);
    });
    await assert.rejects(change(kind === 'failed-proof' ? {currentPassword:'Synthetic incorrect proof'} : {},first.token,service),code('AUTH_REQUIRED'));
    assert.equal(reached,true); assert.deepEqual(await account(),before); assert.deepEqual(await sessions(),storedSessions);
  });

test('authenticate refuses a session revoked after its initial read instead of returning a stale identity', async () => {
  let reached = false;
  const service = intercept(async (tx,sql,params) => {
    if (sql.includes('UPDATE cb_auth_sessions SET last_seen_at')) {
      reached = true; await tx.query('UPDATE cb_auth_sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1',[hash(first.token)]);
    }
    return tx.query(sql,params);
  });
  assert.equal(await service.authenticate(first.token),null); assert.equal(reached,true);
});

test('old-session invitation acceptance is denied after change, while newly authenticated matching owner can still join', async () => {
  const invitation = await auth.createInvitation({userId:'manager-a'},{centerId:'center-b',email:'guardian-a@example.com',role:'guardian'});
  const input = {token:invitation.token,centerId:'center-b',role:'guardian'};
  await change();
  await assert.rejects(auth.acceptExistingInvitation(first.token,input),code('AUTH_REQUIRED'));
  assert.equal((await db.query('SELECT accepted_at FROM cb_auth_invitations WHERE id = $1',[invitation.id])).rows[0].accepted_at,null);
  const fresh = await login(NEW_PASSWORD);
  assert.equal((await auth.acceptExistingInvitation(fresh.token,input)).linked,true);
});

test('default password change keeps production scrypt parameters rather than test-strength hashing', async () => {
  const service = new Auth(db);
  await change({},first.token,service);
  assert.match((await account()).password_hash,/^scrypt\$32768\$8\$1\$/);
  assert.equal((await login(NEW_PASSWORD)).user.userId,'guardian-a');
});

test('password-change and recovery HTTP paths remain absent and never dispatch the new internal service', async () => {
  for (const url of ['/api/auth/password/change','/api/auth/password/reset','/api/auth/password/forgot']) {
    const res = {writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
    let called = false;
    await handleAuthRequest({url,method:'POST',headers:{host:'127.0.0.1',origin:'http://127.0.0.1'}},res,
      {auth:{ changePassword() { called = true; },authenticate() { called = true; }, login() { called = true; }, logout() { called = true; } }});
    assert.equal(res.status,404); assert.equal(called,false);
  }
});
