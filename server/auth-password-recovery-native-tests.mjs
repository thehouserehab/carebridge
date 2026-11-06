import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Auth } from './auth.mjs';

// Explicit disposable PostgreSQL harness only. Synthetic identities and cheap
// test-only password hashing; no HTTP, mail, environment or operating accounts.
// The caller owns and closes all injected databases, and retains/drops its own
// fixture as a whole. Every per-case gate is released before returning.
export const PASSWORD_RECOVERY_NATIVE_CASE_COUNT = 8;
const CURRENT = 'Synthetic recovery current credential';
const NEXT = 'Synthetic recovery next credential';
const OTHER = 'Synthetic recovery other credential';
const OPTIONS = { password:{ N:1024,r:8,p:1,maxmem:32 * 1024 ** 2 } };
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const capture = (promise) => promise.then(value => ({value}),error => ({error}));
const success = (outcome) => { assert.equal(outcome.error,undefined,'NATIVE_RECOVERY_EXPECTED_SUCCESS'); return outcome.value; };
const rejected = (outcome,code) => assert.equal(outcome.error?.code,code,'NATIVE_RECOVERY_EXPECTED_REJECTION');
const accountLock = (sql) => sql.includes('FROM cb_auth_accounts') && sql.includes('FOR UPDATE');

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject) => {
    timer = setTimeout(() => reject(new Error('NATIVE_RECOVERY_GATE_TIMEOUT')),4000);
  })]); } finally { clearTimeout(timer); }
}
function traced(database,match = () => false,{after = false} = {}) {
  const entered = Promise.withResolvers(),reached = Promise.withResolvers(),resume = Promise.withResolvers();
  let paused = false;
  return {entered:entered.promise,reached:reached.promise,release:() => resume.resolve(),
    database:{transaction:work => database.transaction(async tx => {
      const {rows} = await tx.query('SELECT pg_backend_pid() AS pid');
      const pid = rows[0].pid; entered.resolve(pid);
      return work({query:async (sql,params) => {
        if (!paused && match(sql)) {
          paused = true;
          const result = after ? await tx.query(sql,params) : undefined;
          reached.resolve(pid); await resume.promise;
          return after ? result : tx.query(sql,params);
        }
        return tx.query(sql,params);
      },exec:sql => tx.exec(sql)});
    })}};
}
async function poll(work) {
  const deadline = Date.now()+4000;
  while (Date.now()<deadline) {
    if (await work()) return;
    await new Promise(resolve => setTimeout(resolve,25));
  }
  throw new Error('NATIVE_RECOVERY_WAIT_TIMEOUT');
}
async function waitBlocked(observer,waiter,holder) {
  assert.notEqual(waiter,holder);
  await poll(async () => (await observer.transaction(tx => tx.query(
    'SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked',[waiter,holder]))).rows[0].blocked);
}

export function addAuthPasswordRecoveryNativeCases(check,databaseA,databaseB,{owner = databaseA,observer = owner} = {}) {
  const authA = new Auth(databaseA,OPTIONS),authB = new Auth(databaseB,OPTIONS);
  // Windows fixtures use max:1 per pool: observation must not borrow the
  // owner connection while that owner is deliberately holding a lock.
  const query = (sql,params) => observer.transaction(tx => tx.query(sql,params));
  async function fixture(label,{issue = true,ttl = 900} = {}) {
    const userId = `recovery-native-${label}`,centerId = `recovery-center-${label}`,email = `${userId}@example.com`;
    await owner.transaction(async tx => {
      await tx.query('INSERT INTO cb_centers(id) VALUES ($1)',[centerId]);
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[userId]);
      await tx.query("INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'guardian',true)",[centerId,userId]);
    });
    await new Auth(owner,OPTIONS).provisionAccount({userId,email,password:CURRENT});
    const first = await authA.login({email,password:CURRENT}),second = await authB.login({email,password:CURRENT});
    const envelope = issue ? await new Auth(databaseA,{...OPTIONS,recoveryTtlSeconds:ttl}).preparePasswordRecovery({email}) : null;
    if (issue) assert.ok(envelope);
    return {userId,email,first,second,envelope,
      login:(service = authA,password = CURRENT) => service.login({email,password}),
      issue:(service = authA) => service.preparePasswordRecovery({email}),
      reset:(service = authA,password = NEXT) => service.completePasswordRecovery({token:envelope.token,newPassword:password,confirmation:password}),
      change:(service = authA,password = OTHER) => service.changePassword(first.token,{currentPassword:CURRENT,newPassword:password}),
      account:async () => (await query('SELECT * FROM cb_auth_accounts WHERE user_id=$1',[userId])).rows[0],
      sessions:async () => (await query('SELECT * FROM cb_auth_sessions WHERE user_id=$1 ORDER BY token_hash',[userId])).rows,
      resets:async () => (await query('SELECT * FROM cb_auth_password_resets WHERE user_id=$1 ORDER BY token_hash',[userId])).rows,
      events:async () => (await query('SELECT action,revoked_sessions FROM cb_account_security_events WHERE user_id=$1 ORDER BY occurred_at,id',[userId])).rows,
    };
  }

  check('concurrent recovery completions consume one token once and preserve one credential winner',async () => {
    const f = await fixture('complete-race'),held = traced(databaseA,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.reset(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.reset(new Auth(contender.database,OPTIONS),OTHER)));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      assert.deepEqual(success(await jobs[0]),{passwordChanged:true,reauthenticate:true}); rejected(await jobs[1],'PASSWORD_RECOVERY_INVALID');
      assert.deepEqual(await f.events(),[{action:'password.recovered',revoked_sessions:2}]);
      const resets = await f.resets(); assert.equal(resets.length,1); assert.ok(resets[0].consumed_at); assert.equal(resets[0].revoked_at,null);
      assert.ok((await f.sessions()).every(row => row.revoked_at));
      assert.equal((await f.login(authA,NEXT)).user.userId,f.userId);
      await assert.rejects(f.login(authB,OTHER),{code:'AUTH_INVALID'});
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('concurrent recovery issuance shares one account cooldown and does not revoke existing sessions',async () => {
    const f = await fixture('issue-race',{issue:false}),before = await f.sessions();
    const held = traced(databaseA,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.issue(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.issue(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      const envelope = success(await jobs[0]); assert.ok(envelope); assert.deepEqual(Object.keys(envelope),['expiresAt']);
      assert.equal(success(await jobs[1]),null);
      const resets = await f.resets(); assert.equal(resets.length,1); assert.equal(resets[0].token_hash,tokenHash(envelope.token));
      assert.equal(resets[0].consumed_at,null); assert.equal(resets[0].revoked_at,null);
      assert.deepEqual(await f.sessions(),before); assert.deepEqual(await f.events(),[]);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('a login waiting behind completed recovery cannot mint an old-password session',async () => {
    const f = await fixture('reset-login'),held = traced(databaseA,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.reset(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.login(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      success(await jobs[0]); rejected(await jobs[1],'AUTH_INVALID');
      const sessions = await f.sessions(); assert.equal(sessions.length,2); assert.ok(sessions.every(row => row.revoked_at));
      assert.deepEqual(await f.events(),[{action:'password.recovered',revoked_sessions:2}]);
      assert.equal((await f.login(authB,NEXT)).user.userId,f.userId);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('recovery waits for an earlier login and revokes the session that login just committed',async () => {
    const f = await fixture('login-reset');
    const held = traced(databaseA,sql => sql.startsWith('INSERT INTO cb_auth_sessions'),{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.login(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.reset(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      const login = success(await jobs[0]); success(await jobs[1]);
      assert.equal(await authA.authenticate(login.token),null);
      const sessions = await f.sessions(); assert.equal(sessions.length,3); assert.ok(sessions.every(row => row.revoked_at));
      assert.deepEqual(await f.events(),[{action:'password.recovered',revoked_sessions:3}]);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('an earlier authenticated password change invalidates a recovery waiting on the same account',async () => {
    const f = await fixture('change-reset'),held = traced(databaseA,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.change(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.reset(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      success(await jobs[0]); rejected(await jobs[1],'PASSWORD_RECOVERY_INVALID');
      assert.deepEqual(await f.events(),[{action:'password.changed',revoked_sessions:2}]);
      const reset = (await f.resets())[0]; assert.ok(reset.revoked_at); assert.equal(reset.consumed_at,null);
      assert.equal((await f.login(authB,OTHER)).user.userId,f.userId);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('an earlier recovery revokes the proof session of a waiting authenticated password change',async () => {
    const f = await fixture('reset-change'),held = traced(databaseA,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(f.reset(new Auth(held.database,OPTIONS)))); const holder = await bounded(held.reached);
      jobs.push(capture(f.change(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      success(await jobs[0]); rejected(await jobs[1],'AUTH_REQUIRED');
      assert.deepEqual(await f.events(),[{action:'password.recovered',revoked_sessions:2}]);
      assert.equal(await authB.authenticate(f.first.token),null);
      assert.equal((await f.login(authB,NEXT)).user.userId,f.userId);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('account deactivation committed before recovery denies the waiting token without changing credentials',async () => {
    const f = await fixture('deactivate-reset'),before = await f.account();
    const held = traced(owner,sql => sql.startsWith('UPDATE cb_users SET active=false'),{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(held.database.transaction(async tx => {
        await tx.query('SELECT user_id FROM cb_auth_accounts WHERE user_id=$1 FOR UPDATE',[f.userId]);
        await tx.query('UPDATE cb_users SET active=false WHERE id=$1',[f.userId]);
      })));
      const holder = await bounded(held.reached);
      jobs.push(capture(f.reset(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder); held.release();
      success(await jobs[0]); rejected(await jobs[1],'PASSWORD_RECOVERY_INVALID');
      assert.deepEqual(await f.account(),before); assert.deepEqual(await f.events(),[]);
      const reset = (await f.resets())[0]; assert.ok(reset.revoked_at); assert.equal(reset.consumed_at,null);
      assert.equal(await authA.authenticate(f.first.token),null);
      assert.equal((await query('SELECT active FROM cb_users WHERE id=$1',[f.userId])).rows[0].active,false);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });

  check('recovery token expiry during a proven account lock wait preserves credentials and sessions',async () => {
    const f = await fixture('expiry-reset',{ttl:1}),before = await f.account(),sessions = await f.sessions();
    const held = traced(owner,accountLock,{after:true}),contender = traced(databaseB),jobs = [];
    try {
      jobs.push(capture(held.database.transaction(tx => tx.query('SELECT user_id FROM cb_auth_accounts WHERE user_id=$1 FOR UPDATE',[f.userId]))));
      const holder = await bounded(held.reached);
      jobs.push(capture(f.reset(new Auth(contender.database,OPTIONS))));
      await waitBlocked(observer,await bounded(contender.entered),holder);
      assert.equal((await query('SELECT expires_at>clock_timestamp() AS live FROM cb_auth_password_resets WHERE token_hash=$1',
        [tokenHash(f.envelope.token)])).rows[0].live,true);
      await poll(async () => (await query('SELECT expires_at<=clock_timestamp() AS expired FROM cb_auth_password_resets WHERE token_hash=$1',
        [tokenHash(f.envelope.token)])).rows[0].expired);
      held.release(); success(await jobs[0]); rejected(await jobs[1],'PASSWORD_RECOVERY_INVALID');
      assert.deepEqual(await f.account(),before); assert.deepEqual(await f.sessions(),sessions); assert.deepEqual(await f.events(),[]);
      const reset = (await f.resets())[0]; assert.equal(reset.consumed_at,null); assert.equal(reset.revoked_at,null);
    } finally { held.release(); await Promise.allSettled(jobs); }
  });
}
