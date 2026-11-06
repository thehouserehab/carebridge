import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Auth,AuthError } from '../auth.mjs';
import { createAuthServer } from '../auth-http.mjs';
import { migrate } from '../migrate.mjs';

// Isolated in-memory DB and synthetic credentials only. This suite does not
// provision a real center/operator or verify multi-connection PostgreSQL locks.
let db,auth;
const password = 'synthetic bootstrap password';
const testOptions = { password:{ N:1024,r:8,p:1,maxmem:32 * 1024 ** 2 } };
const input = (extra = {}) => { const centerId = `center-${randomUUID()}`;
  return { centerId,operationId:randomUUID(),confirmNewCenter:centerId,email:'initial.manager@example.com',password,...extra }; };
const code = (expected) => (error) => error instanceof AuthError && error.code === expected && error.message === expected;
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM cb_centers)::int AS centers,(SELECT count(*) FROM cb_users)::int AS users,
  (SELECT count(*) FROM cb_auth_accounts)::int AS accounts,(SELECT count(*) FROM cb_memberships)::int AS memberships,
  (SELECT count(*) FROM cb_center_bootstraps)::int AS receipts,(SELECT count(*) FROM cb_auth_sessions)::int AS sessions,
  (SELECT count(*) FROM cb_children)::int AS children,(SELECT count(*) FROM cb_participants)::int AS participants`)).rows[0];
const account = async (id) => (await db.query('SELECT * FROM cb_auth_accounts WHERE user_id = $1',[id])).rows[0];
before(async () => {
  db = await PGlite.create(); await migrate(db);
  await db.exec(`CREATE ROLE cb_test_runtime; GRANT USAGE ON SCHEMA public TO cb_test_runtime;
    GRANT SELECT,INSERT,UPDATE ON cb_centers,cb_users,cb_auth_accounts,cb_memberships TO cb_test_runtime;`);
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE'); auth = new Auth(db,testOptions); });

test('new center, active manager, hashed account and minimal immutable receipt commit atomically',async () => {
  const request = input({ email:' Initial.Manager@Example.com ' }), result = await auth.bootstrapNewCenter(request);
  assert.equal(result.centerId,request.centerId); assert.equal(result.operationId,request.operationId);
  assert.equal(result.role,'center'); assert.equal(result.replayed,false); assert.match(result.userId,/^user-[a-f0-9-]{36}$/);
  assert.deepEqual(await counts(),{ centers:1,users:1,accounts:1,memberships:1,receipts:1,sessions:0,children:0,participants:0 });
  const stored = await account(result.userId);
  assert.equal(stored.email,'initial.manager@example.com'); assert.match(stored.password_hash,/^scrypt\$/);
  assert.equal(stored.password_hash.includes(password),false);
  const receipt = (await db.query('SELECT * FROM cb_center_bootstraps')).rows[0];
  assert.deepEqual(Object.keys(receipt).sort(),['center_id','created_at','manager_user_id','operation_id']);
  assert.equal(receipt.manager_user_id,result.userId);
  const serialized = JSON.stringify({ result,receipt });
  assert.equal(serialized.includes('initial.manager'),false); assert.equal(serialized.includes(password),false);
  assert.equal('token' in result,false);
});

test('default bootstrap credentials retain the production scrypt parameters',async () => {
  const request = input(), result = await new Auth(db).bootstrapNewCenter(request);
  assert.match((await account(result.userId)).password_hash,/^scrypt\$32768\$8\$1\$/);
});

test('bootstrapped manager signs in and issues an invitation without automatic clinical access',async () => {
  const request = input(), result = await auth.bootstrapNewCenter(request);
  const session = await auth.login({ email:request.email,password });
  assert.equal(session.user.userId,result.userId);
  assert.deepEqual(session.user.centers,[{ id:request.centerId,role:'center' }]);
  const invitation = await auth.createInvitation(session.user,{ centerId:request.centerId,email:'synthetic.guardian@example.com',role:'guardian' });
  const joined = await auth.acceptInvitation({ token:invitation.token,password });
  assert.deepEqual(joined.user.centers,[{ id:request.centerId,role:'guardian' }]);
  assert.equal((await counts()).children,0); assert.equal((await counts()).participants,0);
  const wrong = input();
  await assert.rejects(auth.createInvitation(session.user,{ centerId:wrong.centerId,email:'synthetic.other@example.com',role:'guardian' }),code('FORBIDDEN'));
});

test('exact receipt replay never changes password hashes, failed login state, roles or sessions',async () => {
  const request = input(), first = await auth.bootstrapNewCenter(request);
  await db.query(`UPDATE cb_auth_accounts SET failed_attempts = 5,locked_until = clock_timestamp() + interval '15 minutes' WHERE user_id = $1`,[first.userId]);
  const original = await account(first.userId);
  const replay = await auth.bootstrapNewCenter({ ...request,email:'INITIAL.MANAGER@EXAMPLE.COM' });
  assert.deepEqual(replay,{ ...first,replayed:true });
  assert.deepEqual(await account(first.userId),original);
  assert.equal((await counts()).sessions,0); assert.equal((await counts()).users,1);
});

test('operation IDs cannot be replayed with a different center, email or password',async () => {
  const request = input(), original = await auth.bootstrapNewCenter(request), stored = await account(original.userId);
  const otherCenter = `center-${randomUUID()}`;
  for (const extra of [{ centerId:otherCenter,confirmNewCenter:otherCenter },{ email:'other@example.com' },{ password:'another synthetic password' }])
    await assert.rejects(auth.bootstrapNewCenter({ ...request,...extra }),code('BOOTSTRAP_CONFLICT'));
  assert.deepEqual(await account(original.userId),stored); assert.equal((await counts()).centers,1);
});

test('different operations cannot overwrite an already-created center or add another manager',async () => {
  const request = input(), first = await auth.bootstrapNewCenter(request);
  await assert.rejects(auth.bootstrapNewCenter({ ...request,operationId:randomUUID(),email:'second.manager@example.com' }),code('BOOTSTRAP_EXISTS'));
  assert.equal((await counts()).receipts,1); assert.equal((await counts()).memberships,1);
  assert.equal((await account(first.userId)).email,request.email);
});

test('even empty legacy centers are not adopted through the new-center bootstrap path',async () => {
  const request = input(); await db.query('INSERT INTO cb_centers(id) VALUES ($1)',[request.centerId]);
  await assert.rejects(auth.bootstrapNewCenter(request),code('BOOTSTRAP_EXISTS'));
  assert.equal((await counts()).accounts,0); assert.equal((await counts()).receipts,0);
});

test('existing account email cannot be repurposed, promoted or reactivated as a new center administrator',async () => {
  const request = input();
  await db.exec(`INSERT INTO cb_centers VALUES ('legacy-center'); INSERT INTO cb_users VALUES ('legacy-guardian',true);
    INSERT INTO cb_memberships VALUES ('legacy-center','legacy-guardian','guardian',false);`);
  await auth.provisionAccount({ userId:'legacy-guardian',email:request.email,password });
  const original = await account('legacy-guardian');
  await assert.rejects(auth.bootstrapNewCenter(request),code('BOOTSTRAP_ACCOUNT_EXISTS'));
  assert.deepEqual(await account('legacy-guardian'),original);
  assert.deepEqual((await db.query('SELECT role,active FROM cb_memberships')).rows,[{ role:'guardian',active:false }]);
  assert.equal((await counts()).centers,1); assert.equal((await counts()).receipts,0);
});

test('receipt replay cannot recover suspended users/memberships, changed roles or deleted credentials',async () => {
  for (const change of ['UPDATE cb_users SET active = false WHERE id = $1',
    'UPDATE cb_memberships SET active = false WHERE user_id = $1',
    "UPDATE cb_memberships SET role = 'therapist' WHERE user_id = $1",'DELETE FROM cb_auth_accounts WHERE user_id = $1']) {
    const request = input({ email:`test-${randomUUID()}@example.com` }), first = await auth.bootstrapNewCenter(request);
    await db.query(change,[first.userId]);
    await assert.rejects(auth.bootstrapNewCenter(request),code('BOOTSTRAP_CLOSED'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_center_bootstraps WHERE operation_id = $1',[request.operationId])).rows[0].n,1);
  }
});

test('invalid inputs and caller-selected role/subject fields fail before any bootstrap writes',async () => {
  const request = input();
  for (const invalid of [null,{}, { ...request,operationId:'not-an-operation' },{ ...request,confirmNewCenter:'other' },
    { ...request,centerId:'unsafe/center' },{ ...request,email:'not-email' },{ ...request,password:'short' },
    { ...request,role:'center' },{ ...request,userId:'legacy-guardian' },{ ...request,force:true }])
    await assert.rejects(auth.bootstrapNewCenter(invalid),code('INVALID_INPUT'));
  assert.equal((await counts()).centers,0); assert.equal((await counts()).users,0);
});

test('failure persisting the receipt rolls back all center/account/membership rows and allows exact retry',async () => {
  const request = input();
  const broken = new Auth({ transaction:(work) => db.transaction((tx) => work({
    ...tx,query:(sql,params) => {
      if (sql.startsWith('INSERT INTO cb_center_bootstraps')) throw new Error('SYNTHETIC-PRIVATE-DB-DETAIL');
      return tx.query(sql,params);
    },
  })) },testOptions);
  await assert.rejects(broken.bootstrapNewCenter(request),/SYNTHETIC-PRIVATE-DB-DETAIL/);
  assert.equal((await counts()).centers,0); assert.equal((await counts()).users,0);
  assert.equal((await auth.bootstrapNewCenter(request)).replayed,false);
});

test('lost commit acknowledgment is recovered by the same IDs without duplicate users or password replacement',async () => {
  const request = input();
  const uncertain = new Auth({ transaction:async (work) => {
    await db.transaction(work); throw new Error('SYNTHETIC-COMMIT-ACK-LOST');
  } },testOptions);
  await assert.rejects(uncertain.bootstrapNewCenter(request),/SYNTHETIC-COMMIT-ACK-LOST/);
  const before = (await db.query('SELECT * FROM cb_auth_accounts')).rows[0];
  const replay = await auth.bootstrapNewCenter(request);
  assert.equal(replay.replayed,true); assert.equal(replay.userId,before.user_id);
  assert.deepEqual(await account(replay.userId),before);
  assert.equal((await counts()).centers,1); assert.equal((await counts()).users,1);
});

test('same/different operation concurrent retries create one manager and preserve explicit conflicts',async () => {
  const request = input();
  const results = await Promise.all([auth.bootstrapNewCenter(request),auth.bootstrapNewCenter(request)]);
  assert.equal(results.filter((row) => !row.replayed).length,1);
  assert.equal(results[0].userId,results[1].userId);
  const next = input({ email:'next.manager@example.com' });
  const attempts = await Promise.allSettled([auth.bootstrapNewCenter(next),auth.bootstrapNewCenter({ ...next,operationId:randomUUID() })]);
  assert.equal(attempts.filter((row) => row.status === 'fulfilled').length,1);
  assert.equal(attempts.find((row) => row.status === 'rejected').reason.code,'BOOTSTRAP_EXISTS');
  assert.equal((await counts()).centers,2); assert.equal((await counts()).users,2);
});

test('ordinary runtime DB role cannot bootstrap or replay even when it may write ordinary account tables',async () => {
  const request = input(), first = await auth.bootstrapNewCenter(request);
  const runtime = new Auth({ transaction:(work) => db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE cb_test_runtime'); return work(tx);
  }) },testOptions);
  await assert.rejects(runtime.bootstrapNewCenter(request),code('BOOTSTRAP_FORBIDDEN'));
  await assert.rejects(runtime.bootstrapNewCenter(input({ email:'runtime.attempt@example.com' })),code('BOOTSTRAP_FORBIDDEN'));
  assert.equal((await counts()).centers,1); assert.equal((await counts()).users,1);
  assert.equal((await account(first.userId)).email,request.email);
});

test('connection search_path cannot redirect receipt permissions or writes to look-alike schema tables',async () => {
  await db.exec(`CREATE SCHEMA cb_test_shadow; GRANT USAGE ON SCHEMA cb_test_shadow TO cb_test_runtime;
    CREATE TABLE cb_test_shadow.cb_center_bootstraps (operation_id uuid,center_id text,manager_user_id text,created_at timestamptz DEFAULT clock_timestamp());
    GRANT SELECT,INSERT ON cb_test_shadow.cb_center_bootstraps TO cb_test_runtime;`);
  const scoped = (runtime) => ({ transaction:(work) => db.transaction(async (tx) => {
    if (runtime) await tx.exec('SET LOCAL ROLE cb_test_runtime');
    await tx.exec('SET LOCAL search_path = cb_test_shadow,public');
    return work(tx);
  }) });
  await assert.rejects(new Auth(scoped(true),testOptions).bootstrapNewCenter(input()),code('BOOTSTRAP_FORBIDDEN'));
  assert.equal((await counts()).centers,0);
  const request = input(), result = await new Auth(scoped(false),testOptions).bootstrapNewCenter(request);
  assert.equal(result.centerId,request.centerId); assert.equal((await counts()).receipts,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_test_shadow.cb_center_bootstraps')).rows[0].n,0);
});

test('database receipt is immutable and cannot attest guardian/disabled/credential-less bootstrap subjects',async () => {
  const request = input(), first = await auth.bootstrapNewCenter(request);
  await assert.rejects(db.query('UPDATE cb_center_bootstraps SET created_at = clock_timestamp() WHERE operation_id = $1',[request.operationId]),(error) => error.code === '23514');
  await assert.rejects(db.query('DELETE FROM cb_center_bootstraps WHERE operation_id = $1',[request.operationId]),(error) => error.code === '23514');
  for (const state of ['guardian','disabled','missing-credential']) {
    const next = input(), id = `user-${randomUUID()}`;
    await db.query('INSERT INTO cb_centers(id) VALUES ($1)',[next.centerId]);
    await db.query('INSERT INTO cb_users(id,active) VALUES ($1,$2)',[id,state !== 'disabled']);
    await db.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)',[next.centerId,id,state === 'guardian' ? 'guardian' : 'center']);
    if (state !== 'missing-credential') await db.query('INSERT INTO cb_auth_accounts(user_id,email,password_hash) SELECT $1,$2,password_hash FROM cb_auth_accounts WHERE user_id = $3',[id,`db-${randomUUID()}@example.com`,first.userId]);
    await assert.rejects(db.query('INSERT INTO cb_center_bootstraps(operation_id,center_id,manager_user_id) VALUES ($1,$2,$3)',[next.operationId,next.centerId,id]),(error) => error.code === '23514');
  }
  assert.equal((await counts()).receipts,1);
});

test('bootstrap is not reachable through existing auth HTTP paths',{ timeout:5000 },async (t) => {
  const server = createAuthServer({ auth });
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const path of ['/api/auth/bootstrap','/api/auth/bootstrapNewCenter','/api/auth/centers/bootstrap']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
      method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(input()),
    });
    assert.equal(response.status,404); assert.equal((await response.json()).error,'NOT_FOUND');
    assert.equal(response.headers.get('set-cookie'),null);
  }
  assert.equal((await counts()).centers,0);
});

test('011 upgrade preserves earlier identities, credentials and profile data without making admin grants',async () => {
  const legacy = await PGlite.create(), directory = await mkdtemp(join(tmpdir(),'carebridge-bootstrap-migration-'));
  try {
    const names = (await db.query("SELECT name FROM cb_schema_migrations WHERE name < '011-center-bootstrap.sql' ORDER BY name")).rows.map((row) => row.name);
    for (const name of names) await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(directory,name));
    await migrate(legacy,pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('legacy-center'); INSERT INTO cb_users VALUES ('legacy-guardian',true);
      INSERT INTO cb_memberships VALUES ('legacy-center','legacy-guardian','guardian',true);
      INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision) VALUES ('legacy-center','legacy-guardian','가상 구성원',1);`);
    await new Auth(legacy,testOptions).provisionAccount({ userId:'legacy-guardian',email:'legacy@example.com',password });
    const snapshot = async () => (await legacy.query(`SELECT to_jsonb(u) AS u,to_jsonb(m) AS m,to_jsonb(a) AS a,to_jsonb(p) AS p
      FROM cb_users u JOIN cb_memberships m ON m.user_id = u.id JOIN cb_auth_accounts a ON a.user_id = u.id
      JOIN cb_member_profiles p ON p.user_id = u.id`)).rows;
    const original = await snapshot();
    assert(original.every(({u,m}) => !Object.hasOwn(u,'communication_generation') && !Object.hasOwn(m,'communication_generation')));
    assert.deepEqual(await migrate(legacy),['011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    // Preserve the complete legacy rows; only the new qualification generation
    // columns are initialized to zero by 023. No role or admin grant changes.
    const upgraded = original.map(row => ({...row,u:{...row.u,communication_generation:0},m:{...row.m,communication_generation:0}}));
    assert.deepEqual(await snapshot(),upgraded);
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM cb_center_bootstraps')).rows[0].n,0);
    assert.deepEqual(await migrate(legacy),[]);
    assert.deepEqual(await snapshot(),upgraded);
  } finally {
    await legacy.close();
    const target = resolve(directory), inside = relative(resolve(tmpdir()),target);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    await rm(target,{ recursive:true,force:true });
  }
});
