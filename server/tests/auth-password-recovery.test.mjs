import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError, AUTH_LIMITS } from '../auth.mjs';
import { handleAuthRequest } from '../auth-http.mjs';
import { migrate } from '../migrate.mjs';

const PASSWORD = 'Synthetic original password';
const NEXT = 'Synthetic recovered password';
const EMAIL = 'guardian-a@example.test';
const OPTIONS = { password: { N:1024, r:8, p:1, maxmem:32 * 1024 ** 2 } };
const code = (expected) => (error) => error instanceof AuthError && error.code === expected;
const hash = (token) => createHash('sha256').update(token).digest('hex');
let db, auth, first, peer;
const login = (password = PASSWORD) => auth.login({email:EMAIL,password});
const prepare = (service = auth) => service.preparePasswordRecovery({email:EMAIL});
const complete = (token, service = auth, extra = {}) => service.completePasswordRecovery({token,newPassword:NEXT,confirmation:NEXT,...extra});
const accounts = async () => (await db.query('SELECT * FROM cb_auth_accounts ORDER BY user_id')).rows;
const sessions = async () => (await db.query('SELECT * FROM cb_auth_sessions ORDER BY token_hash')).rows;
const resets = async () => (await db.query('SELECT * FROM cb_auth_password_resets ORDER BY token_hash')).rows;
const events = async () => (await db.query('SELECT * FROM cb_account_security_events ORDER BY id')).rows;
const snapshot = async () => ({accounts:await accounts(),sessions:await sessions(),resets:await resets(),events:await events()});
function intercept(hook, options = {}) {
  return new Auth({transaction:(work) => db.transaction((tx) => work({
    query:(sql,params) => hook(tx,sql,params), exec:(sql) => tx.exec(sql),
  }))}, {...OPTIONS,...options});
}
// Isolate the 60-second cooldown in these reissue tests; the real SQL still
// counts the hour's issued rows. No production clock or policy is configurable.
const withoutCooldown = () => intercept((tx,sql,params) => tx.query(sql,
  sql.includes('COALESCE(MAX(created_at)') ? [params[0],0] : params));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  // Only this in-memory synthetic database is reset. Retained security events
  // deliberately survive; individual assertions compare their before/after IDs.
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a');
    INSERT INTO cb_users VALUES ('guardian-a',true),('peer-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','peer-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','synthetic-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','synthetic-room','synthetic-child');
    INSERT INTO cb_participants VALUES ('center-a','synthetic-room','guardian-a','guardian',true,1);`);
  auth = new Auth(db,OPTIONS);
  await auth.provisionAccount({userId:'guardian-a',email:EMAIL,password:PASSWORD});
  await auth.provisionAccount({userId:'peer-a',email:'peer-a@example.test',password:PASSWORD});
  first = await login(); await login();
  peer = await auth.login({email:'peer-a@example.test',password:PASSWORD});
});

test('preparation stores a hash-only purpose-specific 15-minute capability, not a session or credential change', async () => {
  const before = await snapshot();
  const delivery = await auth.preparePasswordRecovery({email:' GUARDIAN-A@EXAMPLE.TEST '});
  assert.equal(delivery.email,EMAIL); assert.match(delivery.token,/^cr1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.isFrozen(delivery),true);
  assert.equal(JSON.stringify(delivery).includes(delivery.token),false);
  assert.equal(JSON.stringify(delivery).includes(EMAIL),false);
  const stored = (await resets())[0];
  assert.equal(stored.token_hash,hash(delivery.token));
  const lifetime = new Date(stored.expires_at) - new Date(stored.created_at);
  assert.ok(lifetime > 890_000 && lifetime <= 900_000);
  assert.equal(stored.consumed_at,null); assert.equal(stored.revoked_at,null);
  assert.equal(JSON.stringify(stored).includes(delivery.token),false);
  assert.deepEqual(await accounts(),before.accounts);
  assert.deepEqual(await sessions(),before.sessions);
  assert.deepEqual(await events(),before.events);
  assert.equal(await auth.authenticate(delivery.token),null);
  await assert.rejects(auth.acceptInvitation({token:delivery.token,password:NEXT}),code('INVITATION_INVALID'));
});

test('completion atomically changes password, consumes once, closes own sessions and retains a minimal security event', async () => {
  const delivery = await prepare(), before = await snapshot();
  assert.deepEqual(await complete(delivery.token),{passwordChanged:true,reauthenticate:true});
  const after = await snapshot();
  assert.notEqual(after.accounts[0].password_hash,before.accounts[0].password_hash);
  assert.equal(JSON.stringify(after).includes(NEXT),false);
  assert.ok(after.resets[0].consumed_at); assert.equal(after.resets[0].revoked_at,null);
  assert.ok(after.sessions.filter((s) => s.user_id==='guardian-a').every((s) => s.revoked_at));
  assert.deepEqual(after.sessions.find((s) => s.user_id==='peer-a'),before.sessions.find((s) => s.user_id==='peer-a'));
  assert.deepEqual(after.accounts[1],before.accounts[1]);
  const added = after.events.filter((e) => !before.events.some((old) => old.id===e.id));
  assert.equal(added.length,1); assert.equal(added[0].action,'password.recovered');
  assert.equal(added[0].revoked_sessions,2); assert.equal(added[0].user_id,'guardian-a');
  assert.equal(JSON.stringify(added).includes(EMAIL),false);
  assert.equal(JSON.stringify(added).includes(delivery.token),false);
  await assert.rejects(complete(delivery.token),code('PASSWORD_RECOVERY_INVALID'));
  assert.deepEqual(await snapshot(),after);
  assert.equal(await auth.authenticate(first.token),null);
  assert.equal((await auth.authenticate(peer.token)).userId,'peer-a');
  await assert.rejects(login(),code('AUTH_INVALID'));
  assert.equal((await login(NEXT)).user.userId,'guardian-a');
});

test('recovery with no prior sessions succeeds without relaxing zero-count constraints on older event actions', async () => {
  await auth.revokeAll('guardian-a');
  const delivery = await prepare(), before = await events();
  await complete(delivery.token);
  const added = (await events()).filter((e) => !before.some((old) => old.id===e.id));
  assert.equal(added.length,1); assert.equal(added[0].revoked_sessions,0);
  for (const action of ['password.changed','sessions.revoked'])
    await assert.rejects(db.query(`INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions)
      VALUES (gen_random_uuid(),'guardian-a',$1,0)`,[action]),{code:'23514'});
});

test('unknown, suspended and cooldown-limited requests do not alter credentials or reveal a delivery envelope', async () => {
  const before = await snapshot();
  assert.equal(await auth.preparePasswordRecovery({email:'unknown@example.test'}),null);
  assert.deepEqual(await snapshot(),before);
  await db.query("UPDATE cb_users SET active=false WHERE id='guardian-a'");
  const suspended = await snapshot();
  assert.equal(await prepare(),null); assert.deepEqual(await snapshot(),suspended);
  await db.query("UPDATE cb_users SET active=true WHERE id='guardian-a'");
  await prepare(); const issued = await snapshot();
  assert.equal(await prepare(),null); assert.deepEqual(await snapshot(),issued);
});

test('reissue revokes the previous link and hourly limits count already closed requests without locking login', async () => {
  const service = withoutCooldown();
  const one = await prepare(service), two = await prepare(service), three = await prepare(service);
  assert.notEqual(one.token,two.token); assert.notEqual(two.token,three.token);
  await assert.rejects(complete(one.token),code('PASSWORD_RECOVERY_INVALID'));
  await assert.rejects(complete(two.token),code('PASSWORD_RECOVERY_INVALID'));
  assert.equal(await prepare(service),null);
  const rows = await resets(); assert.equal(rows.length,3);
  assert.equal(rows.filter((r) => r.revoked_at).length,2);
  assert.equal((await login()).user.userId,'guardian-a');
  assert.equal(AUTH_LIMITS.recoveryCooldownSeconds,60); assert.equal(AUTH_LIMITS.recoveryHourlyLimit,3);
  await complete(three.token);
});

for (const change of ['password','email','deactivate']) test(`${change} invalidates the outstanding reset permanently`, async () => {
  const delivery = await prepare();
  if (change==='password') await auth.changePassword(first.token,{currentPassword:PASSWORD,newPassword:'Synthetic independently changed password'});
  if (change==='email') await db.query("UPDATE cb_auth_accounts SET email='replacement@example.test' WHERE user_id='guardian-a'");
  if (change==='deactivate') {
    await db.query("UPDATE cb_users SET active=false WHERE id='guardian-a'");
    await db.query("UPDATE cb_users SET active=true WHERE id='guardian-a'");
  }
  assert.ok((await resets())[0].revoked_at);
  const before = await snapshot();
  await assert.rejects(complete(delivery.token),code('PASSWORD_RECOVERY_INVALID'));
  assert.deepEqual(await snapshot(),before);
});

test('a valid recovery clears a temporary credential lock without reactivating a suspended center or child relation', async () => {
  await db.query("UPDATE cb_auth_accounts SET failed_attempts=5,locked_until=clock_timestamp()+interval '15 minutes' WHERE user_id='guardian-a'");
  await db.query("UPDATE cb_memberships SET active=false WHERE user_id='guardian-a'");
  await db.query("UPDATE cb_participants SET active=false WHERE user_id='guardian-a'");
  const tables = ['cb_users','cb_memberships','cb_children','cb_conversations','cb_participants','cb_records','cb_messages','cb_auth_invitations'];
  const before = await Promise.all(tables.map((table) => db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
  const delivery = await prepare(); await complete(delivery.token);
  const account = (await accounts())[0]; assert.equal(account.failed_attempts,0); assert.equal(account.locked_until,null);
  for (let i=0;i<tables.length;i++) assert.deepEqual((await db.query(`SELECT to_jsonb(t) AS row FROM ${tables[i]} t ORDER BY to_jsonb(t)::text`)).rows,before[i].rows);
});

test('wrong purpose, unknown or revoked tokens share one failure and do not touch a live request', async () => {
  const delivery = await prepare();
  const before = await snapshot();
  for (const token of [first.token,undefined,'cr1.bad',`cr1.${randomBytes(32).toString('base64url')}`])
    await assert.rejects(complete(token),code('PASSWORD_RECOVERY_INVALID'));
  assert.deepEqual(await snapshot(),before);
  await db.query('UPDATE cb_auth_password_resets SET revoked_at=clock_timestamp() WHERE token_hash=$1',[hash(delivery.token)]);
  const closed = await snapshot();
  await assert.rejects(complete(delivery.token),code('PASSWORD_RECOVERY_INVALID'));
  assert.deepEqual(await snapshot(),closed);
});

test('expiry during password hashing is rechecked at the consumption write and rolls everything back', async () => {
  let reached = false;
  const service = intercept(async (tx,sql,params) => {
    if (sql.includes('UPDATE cb_auth_password_resets SET consumed_at')) {
      reached = true;
      const result = await tx.query('SELECT expires_at FROM cb_auth_password_resets WHERE token_hash=$1',[params[0]]);
      await delay(Math.max(0,new Date(result.rows[0].expires_at).getTime()-Date.now())+50);
    }
    return tx.query(sql,params);
  },{recoveryTtlSeconds:1});
  const delivery = await prepare(service), before = await snapshot();
  await assert.rejects(complete(delivery.token,service),code('PASSWORD_RECOVERY_INVALID'));
  assert.equal(reached,true); assert.deepEqual(await snapshot(),before);
  await assert.rejects(db.query('UPDATE cb_auth_password_resets SET consumed_at=clock_timestamp() WHERE token_hash=$1',[hash(delivery.token)]),
    {code:'23514',constraint:'cb_password_reset_expired'});
});

for (const failure of ['password','sessions','event']) test(`${failure} write failure rolls back the token, credential and all session changes`, async () => {
  const delivery = await prepare(), before = await snapshot();
  const service = intercept((tx,sql,params) => {
    if ((failure==='password' && sql.includes('UPDATE cb_auth_accounts SET password_hash')) ||
        (failure==='sessions' && sql.includes('UPDATE cb_auth_sessions SET revoked_at')) ||
        (failure==='event' && sql.includes('INSERT INTO cb_account_security_events')))
      throw new Error('synthetic write failure');
    return tx.query(sql,params);
  });
  await assert.rejects(complete(delivery.token,service),/synthetic write failure/);
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(await complete(delivery.token),{passwordChanged:true,reauthenticate:true});
});

test('failed replacement insertion restores the previously usable token, with no automatic reissue', async () => {
  const delivery = await prepare(), before = await snapshot();
  const service = intercept((tx,sql,params) => {
    if (sql.includes('INSERT INTO cb_auth_password_resets')) throw new Error('synthetic issue failure');
    return tx.query(sql,sql.includes('COALESCE(MAX(created_at)') ? [params[0],0] : params);
  });
  await assert.rejects(prepare(service),/synthetic issue failure/);
  assert.deepEqual(await snapshot(),before);
  await complete(delivery.token);
});

test('commit acknowledgement loss does not auto-retry, reissue a session, or consume a link twice', async () => {
  const delivery = await prepare(); let calls=0;
  const service = new Auth({transaction:async (work) => {calls++;await db.transaction(work);throw new Error('synthetic commit acknowledgement lost');}},OPTIONS);
  await assert.rejects(complete(delivery.token,service),/synthetic commit acknowledgement lost/);
  assert.equal(calls,1);
  const after = await snapshot();
  await assert.rejects(complete(delivery.token),code('PASSWORD_RECOVERY_INVALID'));
  assert.deepEqual(await snapshot(),after);
  assert.equal((await login(NEXT)).user.userId,'guardian-a');
});

test('unchanged password and mismatched confirmation leave the valid link available for a corrected input', async () => {
  const delivery = await prepare(), before = await snapshot();
  await assert.rejects(complete(delivery.token,auth,{newPassword:PASSWORD,confirmation:PASSWORD}),code('PASSWORD_UNCHANGED'));
  await assert.rejects(complete(delivery.token,auth,{confirmation:'Synthetic different confirmation'}),code('PASSWORD_CONFIRMATION_MISMATCH'));
  assert.deepEqual(await snapshot(),before);
  await complete(delivery.token);
});

test('input shapes and lifetime bounds reject before database access; input values are captured before awaiting', async () => {
  let calls=0;
  const missing = {transaction() {calls++;throw new Error('No DB expected');}};
  const service = new Auth(missing,OPTIONS);
  for (const input of [null,[],{}, {email:EMAIL,userId:'peer-a'},{email:EMAIL,recipient:'peer-a@example.test'}, {email:'bad'}])
    await assert.rejects(service.preparePasswordRecovery(input),code('INVALID_INPUT'));
  for (const input of [null,[],{token:'cr1.'+'a'.repeat(43),newPassword:NEXT,confirmation:NEXT,role:'center'},
    {token:'cr1.'+'a'.repeat(43),newPassword:'short',confirmation:'short'}])
    await assert.rejects(service.completePasswordRecovery(input),code('INVALID_INPUT'));
  for (const ttl of [0,-1,901,1.5,'900',null]) assert.throws(() => new Auth(missing,{...OPTIONS,recoveryTtlSeconds:ttl}),/Invalid recovery TTL/);
  assert.equal(calls,0);
  const delivery = await prepare();
  const input={token:delivery.token,newPassword:NEXT,confirmation:NEXT};
  const request=auth.completePasswordRecovery(input);
  input.token='wrong'; input.newPassword='Synthetic attacker replacement';
  await request;
  assert.equal((await login(NEXT)).user.userId,'guardian-a');
});

test('DB recovery lifecycle is immutable, timestamped by DB, and unique per pending user', async () => {
  const delivery = await prepare(), tokenHash=hash(delivery.token);
  for (const assignment of ["token_hash=repeat('a',64)","user_id='peer-a'","created_at=created_at-interval '1 hour'","expires_at=expires_at+interval '1 hour'",
    'consumed_at=clock_timestamp(),revoked_at=clock_timestamp()'])
    await assert.rejects(db.query(`UPDATE cb_auth_password_resets SET ${assignment} WHERE token_hash=$1`,[tokenHash]),{code:'23514'});
  await assert.rejects(db.query(`INSERT INTO cb_auth_password_resets(token_hash,user_id,expires_at)
    VALUES (repeat('b',64),'guardian-a',clock_timestamp()+interval '5 minutes')`),{code:'23505'});
  await db.query("UPDATE cb_auth_password_resets SET revoked_at='2099-01-01' WHERE token_hash=$1",[tokenHash]);
  const revoked = (await resets())[0];
  assert.ok(new Date(revoked.revoked_at).getTime()<Date.parse('2099-01-01'));
  await assert.rejects(db.query('UPDATE cb_auth_password_resets SET revoked_at=NULL WHERE token_hash=$1',[tokenHash]),{code:'23514'});
});

test('default recovery uses production hashing and public reset/forgot endpoints remain absent', async () => {
  const delivery = await prepare();
  await complete(delivery.token,new Auth(db));
  assert.match((await accounts())[0].password_hash,/^scrypt\$32768\$8\$1\$/);
  for (const url of ['/api/auth/password/reset','/api/auth/password/forgot']) {
    let called=false;
    const res={writeHead(status){this.status=status;},end(body){this.body=body;}};
    const trap=()=>{called=true;};
    await handleAuthRequest({url,method:'POST',headers:{host:'127.0.0.1',origin:'http://127.0.0.1'}},res,
      {auth:{preparePasswordRecovery:trap,completePasswordRecovery:trap,authenticate:trap,login:trap,logout:trap}});
    assert.equal(res.status,404);assert.equal(called,false);
  }
});
