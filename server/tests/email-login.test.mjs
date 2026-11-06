import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { EmailLogin, EMAIL_LOGIN_LIMITS } from '../email-login.mjs';
import { Conversations } from '../conversations.mjs';
import { migrate } from '../migrate.mjs';

// No operating DB, environment secrets, email network or real identities.
const EMAIL = 'guardian@example.test', PASSWORD = 'Synthetic original password!';
const password = { N:1024,r:8,p:1,maxmem:32*1024**2 };
const errorCode = expected => error => error instanceof AuthError && error.code === expected;
const invalid = errorCode('EMAIL_LOGIN_INVALID');
const sha256 = value => createHash('sha256').update(value).digest('hex');
let db,auth,service,key,browser;
const prepare = (email=EMAIL,svc=service,nonce=browser) => svc.prepare({email},nonce);
const verify = (issued,svc=service,nonce=browser,code=issued.delivery?.code) => svc.verify({challenge:issued.challenge,code},nonce);
const rows = async () => (await db.query('SELECT * FROM cb_auth_email_logins ORDER BY created_at')).rows;
const count = async table => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
function intercept(hook, options={}) {
  const database = {transaction:work=>db.transaction(tx=>work({query:(sql,params)=>hook(tx,sql,params)}))};
  const adapter = new Auth(database,{password});
  return new EmailLogin({database,auth:adapter,key,...options});
}
const withoutCooldown = () => intercept((tx,sql,params)=>tx.query(sql,
  sql.includes('COALESCE(MAX(created_at)') ? [params[0],0] : params));

before(async()=>{
  db=await PGlite.create(); await migrate(db);
  // Proposal is deliberately not discovered by migrate(), including on E.
  assert.equal((await db.query("SELECT to_regclass('public.cb_auth_email_logins') AS table_name")).rows[0].table_name,null);
  await db.exec(await readFile(new URL('../schema-proposals/email-login.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users VALUES ('guardian',true),('manager',true),('pending',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian','guardian',true),('center-a','manager','center',true);
    INSERT INTO cb_children VALUES ('center-a','child-a');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian','guardian',true,1);`);
  auth=new Auth(db,{password}); key=randomBytes(32); browser=randomBytes(32).toString('base64url');
  for(const userId of ['guardian','manager','pending'])
    await auth.provisionAccount({userId,email:`${userId}@example.test`,password:PASSWORD});
  service=new EmailLogin({database:db,auth,key});
});

test('issuance stores only keyed proofs, never raw codes/browser nonces or a session',async()=>{
  const issued=await prepare(' GUARDIAN@EXAMPLE.TEST '),[stored]=await rows();
  assert.equal(issued.delivery.to,EMAIL); assert.match(issued.delivery.code,/^\d{8}$/);
  assert.match(issued.challenge,/^el1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(stored.id_hash,sha256(issued.challenge));
  assert.notEqual(stored.code_hash,sha256(issued.delivery.code));
  for(const secret of [issued.delivery.code,browser,EMAIL]) assert.equal(JSON.stringify(stored).includes(secret),false);
  assert.deepEqual(Object.keys(issued).sort(),['challenge','message']);
  assert.equal(JSON.stringify(issued).includes(issued.delivery.code),false);
  assert.equal(await count('cb_auth_sessions'),0);
  assert.ok(new Date(stored.expires_at)-new Date(stored.created_at)<=600_000);
  assert.equal(await auth.authenticate(issued.challenge),null);
});

test('correct proof issues the existing server session with assigned role, not a new account or membership',async()=>{
  const result=await verify(await prepare());
  assert.deepEqual(result.user.centers,[{id:'center-a',role:'guardian'}]);
  assert.equal(result.approvalRequired,false);
  assert.equal(await count('cb_users'),3); assert.equal(await count('cb_memberships'),2);
  assert.deepEqual(await auth.authenticate(result.token),result.user);
  assert.equal(JSON.stringify(result).includes(result.token),false);
  assert.ok(Date.parse(result.user.expiresAt)-Date.now()>7.9*60*60*1000);
});

test('unknown and inactive accounts have indistinguishable public shapes, no automatic signup or delivery',async()=>{
  const known=await prepare(),unknown=await prepare('unknown@example.test');
  await db.query("UPDATE cb_users SET active=false WHERE id='guardian'");
  const inactive=await prepare();
  for(const value of [unknown,inactive]) {
    assert.deepEqual(Object.keys(value),Object.keys(known)); assert.equal(value.message,known.message);
    assert.equal(value.delivery,null); await assert.rejects(verify(value,service,browser,'12345678'),invalid);
  }
  assert.equal(await count('cb_users'),3); assert.equal(await count('cb_auth_sessions'),0);
});

test('eight-digit code requires the issuing browser nonce and cannot be used as a recovery or invitation token',async()=>{
  const issued=await prepare();
  await assert.rejects(verify(issued,service,randomBytes(32).toString('base64url')),invalid);
  await assert.rejects(auth.acceptInvitation({token:issued.challenge,password:PASSWORD}),errorCode('INVITATION_INVALID'));
  await assert.rejects(auth.completePasswordRecovery({token:issued.challenge,newPassword:PASSWORD,confirmation:PASSWORD}),errorCode('PASSWORD_RECOVERY_INVALID'));
  assert.equal(await count('cb_auth_sessions'),0); assert.equal((await rows())[0].attempts,0);
});

test('wrong and malformed codes count persistently; fifth failure prevents the correct code',async()=>{
  const issued=await prepare(),wrong=issued.delivery.code==='00000000'?'11111111':'00000000';
  for(const code of [wrong,'bad',wrong,wrong,wrong]) await assert.rejects(verify(issued,service,browser,code),invalid);
  assert.equal((await rows())[0].attempts,5);
  await assert.rejects(verify(issued),invalid);
  assert.equal(await count('cb_auth_sessions'),0);
  assert.equal((await auth.login({email:EMAIL,password:PASSWORD})).user.userId,'guardian');
});

test('cooldown is enforced by persisted account-serialized issuance, across service instances',async()=>{
  await prepare(); const next=await prepare(EMAIL,new EmailLogin({database:db,auth,key}));
  assert.equal(next.delivery,null); assert.equal((await rows()).length,1);
  assert.equal(EMAIL_LOGIN_LIMITS.cooldownSeconds,60);
});

test('resend invalidates old proofs and the hourly cap includes revoked proofs',async()=>{
  const sender=withoutCooldown();
  const first=await prepare(EMAIL,sender),second=await prepare(EMAIL,sender),third=await prepare(EMAIL,sender);
  await assert.rejects(verify(first),invalid); await assert.rejects(verify(second),invalid);
  assert.equal((await prepare(EMAIL,sender)).delivery,null); assert.equal((await rows()).length,3);
  assert.equal((await verify(third)).user.userId,'guardian');
});

test('expired code cannot issue a session',async()=>{
  const short=new EmailLogin({database:db,auth,key,ttlSeconds:1}),issued=await prepare(EMAIL,short);
  await delay(1100); await assert.rejects(verify(issued),invalid);
  assert.equal(await count('cb_auth_sessions'),0);
});

test('lost success response can recover only the same session, without extending expiry',async()=>{
  const issued=await prepare(),one=await verify(issued),two=await verify(issued);
  assert.equal(one.token,two.token); assert.equal(one.user.expiresAt,two.user.expiresAt);
  assert.equal(await count('cb_auth_sessions'),1);
  const late=intercept((tx,sql,params)=>tx.query(sql,sql.includes('AS retryable')?[params[0],0,params[2]]:params));
  await assert.rejects(verify(issued,late),invalid);
  await assert.rejects(verify(issued,service,randomBytes(32).toString('base64url')),invalid);
});

test('concurrent confirmations return one session and never duplicate the session grant',async()=>{
  const issued=await prepare(),results=await Promise.all([verify(issued),verify(issued),verify(issued)]);
  assert.equal(new Set(results.map(r=>r.token)).size,1); assert.equal(await count('cb_auth_sessions'),1);
});

test('logout prevents response-recovery from resurrecting a session',async()=>{
  const issued=await prepare(),result=await verify(issued);
  assert.equal(await auth.logout(result.token),true); assert.equal(await auth.authenticate(result.token),null);
  await assert.rejects(verify(issued),invalid); assert.equal(await count('cb_auth_sessions'),1);
});

test('session expiration is authoritative during response recovery',async()=>{
  const issued=await prepare(),result=await verify(issued);
  await db.query(`UPDATE cb_auth_sessions SET created_at=clock_timestamp()-interval '2 minutes',
    expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1`,[sha256(result.token)]);
  assert.equal(await auth.authenticate(result.token),null); await assert.rejects(verify(issued),invalid);
});

for(const change of ['email','password','deactivate']) test(`${change} permanently invalidates pending proof`,async()=>{
  const issued=await prepare();
  if(change==='email') await db.query("UPDATE cb_auth_accounts SET email='changed@example.test' WHERE user_id='guardian'");
  if(change==='password') {
    const session=await auth.login({email:EMAIL,password:PASSWORD});
    await auth.changePassword(session.token,{currentPassword:PASSWORD,newPassword:'Synthetic replacement password!'});
  }
  if(change==='deactivate') {
    await db.query("UPDATE cb_users SET active=false WHERE id='guardian'");
    await db.query("UPDATE cb_users SET active=true WHERE id='guardian'");
  }
  assert.ok((await rows())[0].revoked_at); await assert.rejects(verify(issued),invalid);
});

test('existing password lockout cannot be bypassed through email verification',async()=>{
  const issued=await prepare();
  for(let i=0;i<5;i++) await assert.rejects(auth.login({email:EMAIL,password:'wrong'}),errorCode('AUTH_INVALID'));
  await assert.rejects(verify(issued),invalid); assert.equal((await prepare()).delivery,null);
});

test('session insert failure rolls back consumption, allowing a safe retry',async()=>{
  const issued=await prepare(),broken=intercept((tx,sql,params)=>{
    if(sql.startsWith('INSERT INTO cb_auth_sessions')) throw new Error('Synthetic insert failure');
    return tx.query(sql,params);
  });
  await assert.rejects(verify(issued,broken),/Synthetic insert failure/);
  assert.equal((await rows())[0].consumed_at,null); assert.equal(await count('cb_auth_sessions'),0);
  assert.equal((await verify(issued)).user.userId,'guardian');
});

test('expiry crossed inside the consuming trigger becomes a generic failed proof',async()=>{
  const issued=await prepare(),boundary=intercept((tx,sql,params)=>{
    if(sql.startsWith('UPDATE cb_auth_email_logins SET consumed_at='))
      throw Object.assign(new Error('Synthetic clock boundary'),{code:'23514',constraint:'cb_email_login_expired'});
    return tx.query(sql,params);
  });
  await assert.rejects(verify(issued,boundary),invalid);
  assert.equal((await rows())[0].consumed_at,null); assert.equal(await count('cb_auth_sessions'),0);
});

test('server-key rotation invalidates old proof without changing existing password sessions',async()=>{
  const session=await auth.login({email:EMAIL,password:PASSWORD}),issued=await prepare();
  const rotated=new EmailLogin({database:db,auth,key:randomBytes(32)});
  await assert.rejects(verify(issued,rotated),invalid);
  assert.ok(await auth.authenticate(session.token));
});

test('account without assigned role is approval-pending and cannot read another center or child',async()=>{
  const result=await verify(await prepare('pending@example.test'));
  assert.equal(result.approvalRequired,true); assert.deepEqual(result.user.centers,[]);
  const conversations=new Conversations(db);
  await assert.rejects(conversations.inbox({userId:result.user.userId,centerId:'center-a',role:'center'}));
  await assert.rejects(auth.createInvitation(result.user,{centerId:'center-a',email:'other@example.test',role:'guardian'}),errorCode('FORBIDDEN'));
  assert.equal(await count('cb_memberships'),2);
});

test('current server membership changes are reflected in an already-issued session',async()=>{
  const result=await verify(await prepare('pending@example.test'));
  // Operator fixture only, not a role assignment API or a real-user mutation.
  await db.query("INSERT INTO cb_memberships VALUES ('center-a','pending','guardian',true)");
  assert.deepEqual((await auth.authenticate(result.token)).centers,[{id:'center-a',role:'guardian'}]);
  await db.query("UPDATE cb_memberships SET role='therapist' WHERE user_id='pending'");
  assert.deepEqual((await auth.authenticate(result.token)).centers,[{id:'center-a',role:'therapist'}]);
  await db.query("UPDATE cb_memberships SET active=false WHERE user_id='pending'");
  assert.deepEqual((await auth.authenticate(result.token)).centers,[]);
});

test('assigned guardian cannot self-promote; manager invitations are same-center and audited',async()=>{
  const guardian=await verify(await prepare()),manager=await verify(await prepare('manager@example.test'));
  await assert.rejects(auth.createInvitation({...guardian.user,role:'center'},
    {centerId:'center-a',email:'new@example.test',role:'therapist'}),errorCode('FORBIDDEN'));
  await assert.rejects(auth.createInvitation(manager.user,
    {centerId:'center-b',email:'new@example.test',role:'guardian'}),errorCode('FORBIDDEN'));
  await assert.rejects(auth.createInvitation(manager.user,
    {centerId:'center-a',email:'new@example.test',role:'center'}),errorCode('INVALID_INPUT'));
  const invite=await auth.createInvitation(manager.user,{centerId:'center-a',email:'new@example.test',role:'guardian'});
  assert.equal(invite.role,'guardian');
  const events=(await db.query('SELECT actor_user_id,center_id,action FROM cb_auth_audit_events')).rows;
  assert.deepEqual(events,[{actor_user_id:'manager',center_id:'center-a',action:'invitation.created'}]);
});

test('request role/center/user claims are rejected before proof or session changes',async()=>{
  const issued=await prepare();
  for(const property of ['role','centerId','userId','redirectUrl']) {
    await assert.rejects(service.prepare({email:EMAIL,[property]:'center'},browser),errorCode('INVALID_INPUT'));
    await assert.rejects(service.verify({challenge:issued.challenge,code:issued.delivery.code,[property]:'center'},browser),errorCode('INVALID_INPUT'));
  }
  assert.equal(await count('cb_auth_sessions'),0);
});

test('schema retains one-way proof state and does not allow resetting attempts or reopening consumption',async()=>{
  const issued=await prepare(),id=sha256(issued.challenge);
  const wrong=issued.delivery.code==='00000000'?'11111111':'00000000';
  await assert.rejects(verify(issued,service,browser,wrong),invalid);
  await assert.rejects(db.query('UPDATE cb_auth_email_logins SET attempts=0 WHERE id_hash=$1',[id]),{code:'23514'});
  await assert.rejects(db.query("UPDATE cb_auth_email_logins SET expires_at=expires_at+interval '1 minute' WHERE id_hash=$1",[id]),{code:'23514'});
  await verify(issued);
  await assert.rejects(db.query('UPDATE cb_auth_email_logins SET consumed_at=NULL,session_hash=NULL WHERE id_hash=$1',[id]),{code:'23514'});
});

test('unsafe configuration and malformed browser bindings fail closed',async()=>{
  assert.throws(()=>new EmailLogin({database:db,auth,key:Buffer.alloc(16)}),/CONFIG_INVALID/);
  assert.throws(()=>new EmailLogin({database:db,auth,key,ttlSeconds:601}),/CONFIG_INVALID/);
  assert.throws(()=>new EmailLogin({database:{},auth,key}),/CONFIG_INVALID/);
  await assert.rejects(prepare(EMAIL,service,'caller-chosen-short-value'),errorCode('INVALID_INPUT'));
  await assert.rejects(prepare('recipient@example.test\r\nBcc: other@example.test'),errorCode('INVALID_INPUT'));
});
