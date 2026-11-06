import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { migrate } from '../migrate.mjs';

const CURRENT = 'Synthetic security current credential', NEXT = 'Synthetic security next credential';
const OPTIONS = {password:{N:1024,r:8,p:1,maxmem:32 * 1024 ** 2}};
let db, auth, userId, email, first, second, subject = 0;
const events = async () => (await db.query('SELECT * FROM cb_account_security_events WHERE user_id=$1 ORDER BY occurred_at,id',[userId])).rows;
const change = (service = auth,session = first.token) => service.changePassword(session,{currentPassword:CURRENT,newPassword:NEXT});
const snapshot = async () => ({
  account:(await db.query('SELECT * FROM cb_auth_accounts WHERE user_id=$1',[userId])).rows,
  sessions:(await db.query('SELECT * FROM cb_auth_sessions WHERE user_id=$1 ORDER BY token_hash',[userId])).rows,
  events:await events(),
});
function auditFault() {
  return new Auth({transaction:work => db.transaction(tx => work({
    query:(sql,params) => {
      if (sql.startsWith('INSERT INTO cb_account_security_events')) throw new Error('SYNTHETIC_SECURITY_EVENT_FAILURE');
      return tx.query(sql,params);
    },exec:sql => tx.exec(sql),
  }))},OPTIONS);
}
before(async () => {db=await PGlite.create(); await migrate(db);});
after(async () => {await db?.close();});
beforeEach(async () => {
  // Retained events are never truncated just to reset a test. New synthetic
  // subjects also prevent prior test rows from being mistaken for this one.
  userId=`security-event-${++subject}`; email=`${userId}@example.com`; auth=new Auth(db,OPTIONS);
  await db.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[userId]);
  await auth.provisionAccount({userId,email,password:CURRENT});
  first=await auth.login({email,password:CURRENT}); second=await auth.login({email,password:CURRENT});
});

test('password and all prior sessions commit with one minimal subject event and no secret or clinical content',async () => {
  const before=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  assert.deepEqual(await change(),{passwordChanged:true,reauthenticate:true});
  const rows=await events(), after=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  assert.equal(rows.length,1); const row=rows[0];
  assert.deepEqual(Object.keys(row).sort(),['action','id','occurred_at','revoked_sessions','user_id']);
  assert.match(row.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(row.user_id,userId); assert.equal(row.action,'password.changed'); assert.equal(row.revoked_sessions,2);
  assert.ok(row.occurred_at>=before && row.occurred_at<=after);
  for (const value of [CURRENT,NEXT,email,first.token,second.token]) assert.equal(JSON.stringify(rows).includes(value),false);
  assert.ok((await snapshot()).sessions.every(item => item.revoked_at));
});

test('all-session revocation records the affected subject and a repeat no-op does not duplicate events',async () => {
  assert.equal(await auth.revokeAll(userId),2); const rows=await events();
  assert.equal(rows.length,1); assert.equal(rows[0].action,'sessions.revoked'); assert.equal(rows[0].revoked_sessions,2);
  assert.equal(await auth.revokeAll(userId),0); assert.deepEqual(await events(),rows);
  assert.equal(await auth.authenticate(first.token),null);
});

test('unknown subjects with no sessions cause no event and never fabricate an operator actor',async () => {
  const before=(await db.query('SELECT count(*)::integer AS count FROM cb_account_security_events')).rows[0].count;
  assert.equal(await auth.revokeAll('synthetic-unknown-account'),0);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM cb_account_security_events')).rows[0].count,before);
  assert.deepEqual(await events(),[]);
});

test('wrong proof, unchanged credentials and revoked sessions never record a successful password change',async () => {
  await assert.rejects(auth.changePassword(first.token,{currentPassword:'Synthetic incorrect credential',newPassword:NEXT}),{code:'AUTH_INVALID'});
  await assert.rejects(auth.changePassword(first.token,{currentPassword:CURRENT,newPassword:CURRENT}),{code:'PASSWORD_UNCHANGED'});
  assert.deepEqual(await events(),[]);
  await auth.revokeAll(userId); const rows=await events();
  await assert.rejects(change(),{code:'AUTH_REQUIRED'}); assert.deepEqual(await events(),rows);
});

test('event insertion failure rolls back password, timestamp, failure reset and every session revocation',async () => {
  await db.query('UPDATE cb_auth_accounts SET failed_attempts=2 WHERE user_id=$1',[userId]);
  const before=await snapshot();
  await assert.rejects(change(auditFault()),{message:'SYNTHETIC_SECURITY_EVENT_FAILURE'});
  assert.deepEqual(await snapshot(),before); assert.equal((await auth.login({email,password:CURRENT})).user.userId,userId);
  await assert.rejects(auth.login({email,password:NEXT}),{code:'AUTH_INVALID'});
});

test('event insertion failure also rolls back an internal all-session revocation',async () => {
  const before=await snapshot();
  await assert.rejects(auditFault().revokeAll(userId),{message:'SYNTHETIC_SECURITY_EVENT_FAILURE'});
  assert.deepEqual(await snapshot(),before); assert.equal((await auth.authenticate(first.token)).userId,userId);
});

test('an unknown commit acknowledgment is not auto-retried and a stale session cannot duplicate the committed event',async () => {
  let transactions=0;
  const uncertain=new Auth({transaction:async work => {
    transactions++; await db.transaction(work); throw new Error('SYNTHETIC_COMMIT_ACKNOWLEDGMENT_LOSS');
  }},OPTIONS);
  await assert.rejects(change(uncertain),{message:'SYNTHETIC_COMMIT_ACKNOWLEDGMENT_LOSS'}); assert.equal(transactions,1);
  const committed=await snapshot(); assert.equal(committed.events.length,1);
  assert.ok(committed.sessions.every(item => item.revoked_at));
  await assert.rejects(change(),{code:'AUTH_REQUIRED'}); assert.deepEqual(await snapshot(),committed);
  assert.equal((await auth.login({email,password:NEXT})).user.userId,userId);
});

test('ordinary update, delete and statement-wide truncate cannot erase retained events',async () => {
  await change(); const rows=await events();
  for (const sql of ['UPDATE cb_account_security_events SET action=action WHERE user_id=$1',
    'DELETE FROM cb_account_security_events WHERE user_id=$1'])
    await assert.rejects(db.query(sql,[userId]),{code:'23514'});
  await assert.rejects(db.exec('TRUNCATE cb_account_security_events'),{code:'23514'});
  assert.deepEqual(await events(),rows);
});

test('caller-supplied event timestamps are replaced by the database clock',async () => {
  const before=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  await db.query(`INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions,occurred_at)
    VALUES ($1,$2,'sessions.revoked',1,'2099-01-01T00:00:00Z')`,[randomUUID(),userId]);
  const after=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now, row=(await events())[0];
  assert.ok(row.occurred_at>=before && row.occurred_at<=after);
});

test('database constrains action vocabulary, opaque identity, UUID version and positive integer session count',async () => {
  for (const [id,subject,action,count] of [
    [randomUUID(),userId,'password.reset',1],[randomUUID(),userId,'sessions.revoked',0],
    [randomUUID(),userId,'sessions.revoked',-1],[randomUUID(),userId,'sessions.revoked',1.5],
    ['12345678-1234-1234-8234-123456789abc',userId,'sessions.revoked',1],
    [randomUUID(),'synthetic private email@example.com','sessions.revoked',1],
  ]) await assert.rejects(db.query('INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions) VALUES ($1,$2,$3,$4)',
    [id,subject,action,count]),error => ['23514','22P02'].includes(error.code));
  assert.deepEqual(await events(),[]);
});

test('removing an account and user cannot cascade-delete or mutate the retained pseudonymous event',async () => {
  await change(); const rows=await events();
  await db.query('DELETE FROM cb_auth_sessions WHERE user_id=$1',[userId]);
  await db.query('DELETE FROM cb_auth_accounts WHERE user_id=$1',[userId]);
  await db.query('DELETE FROM cb_users WHERE id=$1',[userId]);
  assert.deepEqual(await events(),rows);
});

test('019 upgrades 018 without changing existing users credentials sessions or fabricating historical security events',async () => {
  const directory=await mkdtemp(join(tmpdir(),'carebridge-security-migration-')), legacy=await PGlite.create();
  try {
    const source=new URL('../migrations/',import.meta.url);
    for (const name of (await readdir(source)).filter(name => name.endsWith('.sql') && name<'019-'))
      await copyFile(new URL(name,source),join(directory,name));
    await migrate(legacy,pathToFileURL(directory+'/'));
    await legacy.query("INSERT INTO cb_users(id,active) VALUES ('synthetic-legacy-security',true)");
    const service=new Auth(legacy,OPTIONS);
    await service.provisionAccount({userId:'synthetic-legacy-security',email:'synthetic-legacy-security@example.com',password:CURRENT});
    await service.login({email:'synthetic-legacy-security@example.com',password:CURRENT});
    const tables=['cb_users','cb_auth_accounts','cb_auth_sessions'];
    const before=await Promise.all(tables.map(table => legacy.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
    assert(before[0].rows.every(({row}) => !Object.hasOwn(row,'communication_generation')));
    assert.deepEqual(await migrate(legacy),['019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    // 023 initializes revocable communication qualification, not identities or
    // credentials. Compare every old field and the exact new default value.
    for (let index=0; index<tables.length; index++) assert.deepEqual(
      (await legacy.query(`SELECT to_jsonb(t) AS row FROM ${tables[index]} t ORDER BY to_jsonb(t)::text`)).rows,
      tables[index]==='cb_users' ? before[index].rows.map(({row}) => ({row:{...row,communication_generation:0}})) : before[index].rows);
    assert.equal((await legacy.query('SELECT count(*)::integer AS count FROM cb_account_security_events')).rows[0].count,0);
    await assert.rejects(legacy.exec('TRUNCATE cb_account_security_events'),{code:'23514'});
    assert.deepEqual(await migrate(legacy),[]);
  } finally {
    await legacy.close(); await rm(directory,{recursive:true,force:true}); // Only this mkdtemp-owned fixture.
  }
});
