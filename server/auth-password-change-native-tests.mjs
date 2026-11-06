import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Auth } from './auth.mjs';

// Only the disposable, explicitly confirmed native test database. All values
// are synthetic. Gates control ordering; pg_blocking_pids proves a real wait.
// These tests do not change operating accounts, expose routes or send mail.
const CURRENT = 'Synthetic native current credential';
const NEXT = 'Synthetic native next credential';
const OTHER = 'Synthetic native other credential';
const WRONG = 'Synthetic native incorrect credential';
const OPTIONS = { password:{ N:1024,r:8,p:1,maxmem:32 * 1024 ** 2 } };
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const capture = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const success = (outcome) => { assert.equal(outcome.error, undefined, 'NATIVE_AUTH_EXPECTED_SUCCESS'); return outcome.value; };
const rejected = (outcome, code) => assert.equal(outcome.error?.code, code, 'NATIVE_AUTH_EXPECTED_REJECTION');

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error('NATIVE_AUTH_GATE_TIMEOUT')),4000);
    })]);
  } finally { clearTimeout(timer); }
}

function traced(database, match = () => false, { after = false } = {}) {
  const entered = Promise.withResolvers(), reached = Promise.withResolvers(), resume = Promise.withResolvers();
  let paused = false;
  return {
    entered:entered.promise, reached:reached.promise, release:() => resume.resolve(),
    database:{ transaction:(work) => database.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT pg_backend_pid() AS pid');
      const pid = rows[0].pid; entered.resolve(pid);
      return work({ query:async (sql,params) => {
        if (!paused && match(sql)) {
          paused = true;
          const result = after ? await tx.query(sql,params) : undefined;
          reached.resolve(pid); await resume.promise;
          return after ? result : tx.query(sql,params);
        }
        return tx.query(sql,params);
      }, exec:(sql) => tx.exec(sql) });
    }) },
  };
}

async function poll(work) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve,25));
  }
  throw new Error('NATIVE_AUTH_WAIT_TIMEOUT');
}
async function waitBlocked(database, waiter, holder) {
  assert.notEqual(waiter,holder);
  await poll(async () => {
    const { rows } = await database.transaction((tx) => tx.query(
      'SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked',[waiter,holder]));
    return rows[0].blocked;
  });
}
const accountLock = (sql) => sql.includes('FROM cb_auth_accounts') && sql.includes('FOR UPDATE');
const passwordWrite = (sql) => sql.startsWith('UPDATE cb_auth_accounts SET password_hash');

export function addAuthPasswordChangeNativeCases(check, databaseA, databaseB) {
  const authA = new Auth(databaseA,OPTIONS), authB = new Auth(databaseB,OPTIONS);
  const query = (sql,params) => databaseA.transaction((tx) => tx.query(sql,params));
  async function fixture(label) {
    const userId = `auth-native-${label}`, managerId = `auth-manager-${label}`;
    const centerId = `auth-center-${label}`, targetId = `auth-target-${label}`;
    const email = `${userId}@example.com`;
    await databaseA.transaction(async (tx) => {
      await tx.query('INSERT INTO cb_centers(id) VALUES ($1),($2)',[centerId,targetId]);
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true),($2,true)',[userId,managerId]);
      await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active)
        VALUES ($1,$2,'guardian',true),($3,$4,'center',true)`,[centerId,userId,targetId,managerId]);
    });
    await authA.provisionAccount({ userId,email,password:CURRENT });
    const first = await authA.login({ email,password:CURRENT }), second = await authB.login({ email,password:CURRENT });
    return {
      userId,email,centerId,targetId,first,second,
      login:(service = authA,password = CURRENT) => service.login({ email,password }),
      change:(service = authA,session = first.token,newPassword = NEXT,currentPassword = CURRENT) =>
        service.changePassword(session,{ currentPassword,newPassword }),
      account:async () => (await query('SELECT * FROM cb_auth_accounts WHERE user_id = $1',[userId])).rows[0],
      sessions:async () => (await query('SELECT * FROM cb_auth_sessions WHERE user_id = $1 ORDER BY token_hash',[userId])).rows,
      invite:() => authA.createInvitation({ userId:managerId },{ centerId:targetId,email,role:'guardian' }),
    };
  }

  check('concurrent password changes have one winner and revoke both prior sessions',async () => {
    const f = await fixture('change-race');
    const held = traced(databaseA,accountLock,{ after:true }), contender = traced(databaseB);
    const jobs = [];
    try {
      jobs.push(capture(f.change(new Auth(held.database,OPTIONS))));
      const holder = await bounded(held.reached);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS),f.second.token,OTHER)));
      await waitBlocked(databaseB,await bounded(contender.entered),holder);
      held.release();
      assert.deepEqual(success(await jobs[0]),{ passwordChanged:true,reauthenticate:true });
      rejected(await jobs[1],'AUTH_REQUIRED');
      assert.deepEqual((await query('SELECT action,revoked_sessions FROM cb_account_security_events WHERE user_id=$1',[f.userId])).rows,
        [{action:'password.changed',revoked_sessions:2}]);
      assert.ok((await f.sessions()).every((item) => item.revoked_at));
      assert.equal(await authA.authenticate(f.first.token),null);
      assert.equal(await authB.authenticate(f.second.token),null);
      assert.equal((await f.login(authA,NEXT)).user.userId,f.userId);
      await assert.rejects(f.login(authB,OTHER),{ code:'AUTH_INVALID' });
      await assert.rejects(f.login(),{ code:'AUTH_INVALID' });
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('a login delayed before its account read cannot mint a session from the old password',async () => {
    const f = await fixture('change-login'), held = traced(databaseB,accountLock), jobs = [];
    try {
      jobs.push(capture(f.login(new Auth(held.database,OPTIONS)))); await bounded(held.reached);
      await f.change(); held.release(); rejected(await jobs[0],'AUTH_INVALID');
      assert.equal((await f.sessions()).length,2);
      assert.ok((await f.sessions()).every((item) => item.revoked_at));
      assert.equal((await f.login(authB,NEXT)).user.userId,f.userId);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('password change waits for an earlier login and also revokes its newly minted session',async () => {
    const f = await fixture('login-change');
    const held = traced(databaseA,(sql) => sql.startsWith('INSERT INTO cb_auth_sessions'),{ after:true });
    const contender = traced(databaseB), jobs = [];
    try {
      jobs.push(capture(f.login(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS))));
      await waitBlocked(databaseB,await bounded(contender.entered),holder); held.release();
      const login = success(await jobs[0]); success(await jobs[1]);
      assert.equal(await authA.authenticate(login.token),null);
      const sessions = await f.sessions(); assert.equal(sessions.length,3);
      assert.ok(sessions.every((item) => item.revoked_at));
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('password change wins against invitation acceptance without a reverse session lock deadlock',async () => {
    const f = await fixture('change-invite'), invitation = await f.invite();
    const held = traced(databaseA,passwordWrite,{ after:true }), contender = traced(databaseB), jobs = [];
    try {
      jobs.push(capture(f.change(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(new Auth(contender.database,OPTIONS).acceptExistingInvitation(f.second.token,
        { token:invitation.token,centerId:f.targetId,role:'guardian' })));
      await waitBlocked(databaseB,await bounded(contender.entered),holder); held.release();
      success(await jobs[0]); rejected(await jobs[1],'AUTH_REQUIRED');
      assert.equal((await query('SELECT 1 FROM cb_memberships WHERE center_id = $1 AND user_id = $2',[f.targetId,f.userId])).rowCount,0);
      assert.equal((await query('SELECT accepted_at FROM cb_auth_invitations WHERE id = $1',[invitation.id])).rows[0].accepted_at,null);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('an invitation accepted first survives the later password change but its old sessions do not',async () => {
    const f = await fixture('invite-change'), invitation = await f.invite();
    const held = traced(databaseA,accountLock,{ after:true }), contender = traced(databaseB), jobs = [];
    try {
      jobs.push(capture(new Auth(held.database,OPTIONS).acceptExistingInvitation(f.first.token,
        { token:invitation.token,centerId:f.targetId,role:'guardian' })));
      const holder = await bounded(held.reached);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS),f.second.token)));
      await waitBlocked(databaseB,await bounded(contender.entered),holder); held.release();
      assert.equal(success(await jobs[0]).linked,true); success(await jobs[1]);
      assert.deepEqual((await query('SELECT role,active FROM cb_memberships WHERE center_id = $1 AND user_id = $2',[f.targetId,f.userId])).rows,
        [{ role:'guardian',active:true }]);
      assert.ok((await f.sessions()).every((item) => item.revoked_at));
      const current = await f.login(authB,NEXT);
      assert.ok(current.user.centers.some((item) => item.id === f.targetId && item.role === 'guardian'));
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('a session that expires during a proven account lock wait cannot change any credential',async () => {
    const f = await fixture('expiry-change'), before = await f.account();
    const release = Promise.withResolvers(), reached = Promise.withResolvers(), contender = traced(databaseB), jobs = [];
    try {
      jobs.push(capture(databaseA.transaction(async (tx) => {
        await tx.query('SELECT 1 FROM cb_auth_accounts WHERE user_id = $1 FOR UPDATE',[f.userId]);
        const { rows } = await tx.query('SELECT pg_backend_pid() AS pid'); reached.resolve(rows[0].pid); await release.promise;
      })));
      const holder = await bounded(reached.promise);
      await query("UPDATE cb_auth_sessions SET expires_at = clock_timestamp() + interval '600 milliseconds' WHERE token_hash = $1",[tokenHash(f.first.token)]);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS))));
      await waitBlocked(databaseB,await bounded(contender.entered),holder);
      await poll(async () => (await query('SELECT expires_at <= clock_timestamp() AS expired FROM cb_auth_sessions WHERE token_hash = $1',[tokenHash(f.first.token)])).rows[0].expired);
      release.resolve(); success(await jobs[0]); rejected(await jobs[1],'AUTH_REQUIRED');
      assert.deepEqual(await f.account(),before);
      assert.ok((await f.sessions()).every((item) => !item.revoked_at));
      assert.equal((await f.login()).user.userId,f.userId);
    } finally { release.resolve(); await Promise.allSettled(jobs); }
  });

  check('concurrent login and current-password failures persist one shared five-attempt lock',async () => {
    const f = await fixture('proof-lock'), jobs = [];
    for (let index = 0; index < 8; index++) {
      const service = index % 2 ? authA : authB;
      jobs.push(capture(index % 2 ? f.login(service,WRONG) : f.change(service,f.first.token,NEXT,WRONG)));
    }
    for (const outcome of await Promise.all(jobs)) rejected(outcome,'AUTH_INVALID');
    const account = await f.account(); assert.equal(account.failed_attempts,5);
    assert.equal((await query('SELECT locked_until > clock_timestamp() AS locked FROM cb_auth_accounts WHERE user_id = $1',[f.userId])).rows[0].locked,true);
    await assert.rejects(f.change(authB),{ code:'AUTH_INVALID' }); await assert.rejects(f.login(),{ code:'AUTH_INVALID' });
    assert.deepEqual(await f.account(),account);
    assert.ok((await f.sessions()).every((item) => !item.revoked_at));
  });

  check('authentication rechecks a session revoked after its initial read by a password change',async () => {
    const f = await fixture('authenticate-change');
    const held = traced(databaseB,(sql) => sql.startsWith('SELECT s.user_id, s.expires_at, u.active, a.email'),{ after:true }), jobs = [];
    try {
      jobs.push(capture(new Auth(held.database,OPTIONS).authenticate(f.second.token))); await bounded(held.reached);
      await f.change(); held.release(); assert.equal(success(await jobs[0]),null);
      assert.ok((await f.sessions()).every((item) => item.revoked_at));
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('all-session revocation serializes on the account before a competing password change',async () => {
    const f = await fixture('revoke-change'), before = await f.account();
    const held = traced(databaseA,accountLock,{ after:true }), contender = traced(databaseB), jobs = [];
    try {
      jobs.push(capture(new Auth(held.database,OPTIONS).revokeAll(f.userId))); const holder = await bounded(held.reached);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS),f.second.token)));
      await waitBlocked(databaseB,await bounded(contender.entered),holder); held.release();
      assert.equal(success(await jobs[0]),2); rejected(await jobs[1],'AUTH_REQUIRED');
      assert.deepEqual(await f.account(),before); assert.ok((await f.sessions()).every((item) => item.revoked_at));
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('a real security event constraint failure rolls back credentials and all session revocations',async () => {
    const f=await fixture('event-rollback'), before=await f.account(), sessions=await f.sessions();
    const badAudit=new Auth({transaction:work => databaseB.transaction(tx => work({
      query:(sql,params) => tx.query(sql,sql.startsWith('INSERT INTO cb_account_security_events') ? [params[0],params[1],0] : params),
      exec:sql => tx.exec(sql),
    }))},OPTIONS);
    for (const work of [() => f.change(badAudit),() => badAudit.revokeAll(f.userId)]) {
      await assert.rejects(work(),{code:'23514'});
      assert.deepEqual(await f.account(),before); assert.deepEqual(await f.sessions(),sessions);
      assert.equal((await query('SELECT 1 FROM cb_account_security_events WHERE user_id=$1',[f.userId])).rowCount,0);
    }
    await f.change();
    assert.deepEqual((await query('SELECT action,revoked_sessions FROM cb_account_security_events WHERE user_id=$1',[f.userId])).rows,
      [{action:'password.changed',revoked_sessions:2}]);
  });

  check('native security events reject row rewrites and truncation and survive subject removal',async () => {
    const f=await fixture('event-retention'); await f.change();
    const rows=(await query('SELECT * FROM cb_account_security_events WHERE user_id=$1',[f.userId])).rows;
    for (const sql of ['UPDATE cb_account_security_events SET action=action WHERE user_id=$1',
      'DELETE FROM cb_account_security_events WHERE user_id=$1'])
      await assert.rejects(query(sql,[f.userId]),{code:'23514'});
    await assert.rejects(query('TRUNCATE cb_account_security_events'),{code:'23514'});
    await databaseB.transaction(async tx => {
      await tx.query('DELETE FROM cb_auth_sessions WHERE user_id=$1',[f.userId]);
      await tx.query('DELETE FROM cb_auth_accounts WHERE user_id=$1',[f.userId]);
      await tx.query('DELETE FROM cb_memberships WHERE user_id=$1',[f.userId]);
      await tx.query('DELETE FROM cb_users WHERE id=$1',[f.userId]);
    });
    assert.deepEqual((await query('SELECT * FROM cb_account_security_events WHERE user_id=$1',[f.userId])).rows,rows);
  });
}
