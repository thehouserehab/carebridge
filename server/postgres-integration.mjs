import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { databaseFromPool } from './database.mjs';
import { Conversations } from './conversations.mjs';
import { migrate } from './migrate.mjs';
import { addDecoderJournalNativeCases } from './decoder-journal-native-tests.mjs';
import { addMediaStorageNativeCases } from './media-storage-native-tests.mjs';
import { addMediaQueueNativeCases } from './media-queue-native-tests.mjs';
import { configureSyntheticMediaPolicy } from './media-resource-test-policy.mjs';
import { addMediaResourceNativeCases } from './media-resource-native-tests.mjs';
import { addMediaReviewNativeCases } from './media-review-native-tests.mjs';
import { addMediaWorkerNativeCases } from './media-worker-native-tests.mjs';
import { addRecordDraftNativeCases } from './record-drafts-native-tests.mjs';
import { addAuthPasswordChangeNativeCases } from './auth-password-change-native-tests.mjs';
import { addAuthPasswordRecoveryNativeCases } from './auth-password-recovery-native-tests.mjs';
import { addMessageLifecycleNativeCases } from './message-lifecycle-native-tests.mjs';
import { createDisposableDatabase, disposableDatabaseName, dropDisposableDatabase, postgresTestOptions } from './postgres-test-harness.mjs';

// Explicit command only. No DATABASE_URL fallback, .env loading, HTTP/API,
// container start, account provisioning or cloud resource creation.
let admin, databaseA, databaseB, lease, candidate, failed = false;
const safeErrors = new Set(['POSTGRES_TEST_CONFIGURATION','POSTGRES_TEST_DATABASE_NAME',
  'POSTGRES_TEST_CONTROL_DATABASE','POSTGRES_TEST_OWNERSHIP','POSTGRES_TEST_SCENARIO_FAILED']);
const report = (label) => console.log(`PASS ${label}`);
process.on('uncaughtExceptionMonitor',(error) => {
  // Diagnostic only: does not swallow a fatal error or turn it into success.
  console.error(`Disconnect diagnostic: ${/^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : 'UNHANDLED_DRIVER_EVENT'}`);
});
function rendezvous() {
  const gate = Promise.withResolvers(); let arrivals = 0, timer;
  return async () => {
    if (++arrivals === 1) timer = setTimeout(() => gate.reject(new Error('POSTGRES_TEST_CONCURRENCY_TIMEOUT')),4000);
    if (arrivals === 2) { clearTimeout(timer); gate.resolve(); }
    await gate.promise;
  };
}

try {
  // Validate before constructing a pool or attempting any connection.
  const config = postgresTestOptions({ url:process.env.CAREBRIDGE_POSTGRES_TEST_URL,
    confirmation:process.env.CAREBRIDGE_POSTGRES_TEST_CONFIRM });
  admin = new Pool({ ...config,max:1 });
  admin.on('error',() => {}); // Never emit a driver's URL/credential/error text.
  candidate = disposableDatabaseName();
  lease = await createDisposableDatabase(admin,candidate);
  console.log(`Disposable test target: ${lease.name}`);
  databaseA = databaseFromPool(new Pool({ ...config,database:lease.name }));
  databaseB = databaseFromPool(new Pool({ ...config,database:lease.name }));
  const a = new Conversations(databaseA), b = new Conversations(databaseB);
  const query = (sql,params) => databaseA.transaction((tx) => tx.query(sql,params));
  const cases = [];
  const check = (label,work) => cases.push({ label,work });

  async function fixture(label) {
    const centerId = `synthetic-center-${label}`, roomId = `synthetic-room-${label}`;
    const therapist = { centerId,userId:`synthetic-therapist-${label}` };
    const guardian = { centerId,userId:`synthetic-guardian-${label}` };
    const peer = { centerId,userId:`synthetic-peer-${label}` };
    await databaseA.transaction(async (tx) => {
      await tx.query('INSERT INTO cb_centers(id) VALUES ($1)',[centerId]);
      await configureSyntheticMediaPolicy(tx,centerId);
      for (const [actor,role] of [[therapist,'therapist'],[guardian,'guardian'],[peer,'guardian']]) {
        await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[actor.userId]);
        await tx.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)',[centerId,actor.userId,role]);
      }
      await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[centerId,`synthetic-child-${label}`]);
      await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[centerId,roomId,`synthetic-child-${label}`]);
      for (const [actor,role] of [[therapist,'therapist'],[guardian,'guardian'],[peer,'guardian']])
        await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
          VALUES ($1,$2,$3,$4,true,1)`,[centerId,roomId,actor.userId,role]);
    });
    return { centerId,roomId,therapist,guardian,peer,
      send:(clientId,body = 'Synthetic test message') => ({ conversationId:roomId,clientId,body }) };
  }

  check('checked-in migrations and rerun on a fresh native database',async () => {
    assert.deepEqual(await migrate(databaseA),['001-conversations.sql','002-authentication.sql','003-invitations.sql',
      '004-relationships.sql','005-records.sql','006-activity-feedback.sql','007-care-contexts.sql',
      '008-media-uploads.sql','009-media-bindings.sql','010-profiles.sql','011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql']);
    assert.deepEqual(await migrate(databaseB),[]);
  });
  check('two simultaneously checked-out PostgreSQL backend connections',async () => {
    const enter = rendezvous();
    const pids = await Promise.all([databaseA,databaseB].map((database) => database.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT pg_backend_pid() AS pid'); await enter(); return rows[0].pid;
    })));
    assert.equal(pids.every((pid) => Number.isInteger(pid) && pid > 0),true);
    assert.equal(new Set(pids).size,2);
  });
  check('concurrent retries store exactly one message, sequence and audit event',async () => {
    const f = await fixture('retry'), input = f.send('synthetic-retry-0001');
    const sent = await Promise.all([a.sendText(f.guardian,input),b.sendText(f.guardian,input)]);
    assert.equal(sent[0].id,sent[1].id); assert.equal(sent[0].sequence,1);
    const page = await b.list(f.therapist,{ conversationId:f.roomId });
    assert.equal(page.messages.length,1);
    const { rows } = await query('SELECT count(*)::integer AS count FROM cb_audit_events WHERE conversation_id = $1',[f.roomId]);
    assert.equal(rows[0].count,1);
  });
  check('concurrent changed-content retry has one winner and a domain conflict',async () => {
    const f = await fixture('conflict');
    const outcomes = await Promise.allSettled([a.sendText(f.guardian,f.send('synthetic-conflict-0001','Synthetic A')),
      b.sendText(f.guardian,f.send('synthetic-conflict-0001','Synthetic B'))]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length,1);
    assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await a.list(f.therapist,{ conversationId:f.roomId })).messages.length,1);
  });
  check('concurrent distinct sends keep continuous ordering and reconnect cursor',async () => {
    const f = await fixture('order');
    const sent = await Promise.all(Array.from({ length:12 },(_,index) =>
      (index % 2 ? a : b).sendText(f.guardian,f.send(`synthetic-order-${String(index).padStart(4,'0')}`))));
    assert.deepEqual(sent.map((m) => m.sequence).sort((x,y) => x-y),Array.from({ length:12 },(_,i) => i+1));
    const first = await a.list(f.therapist,{ conversationId:f.roomId,limit:5 });
    assert.equal(first.hasMore,true); assert.equal(first.nextCursor,5);
    const second = await b.list(f.therapist,{ conversationId:f.roomId,after:first.nextCursor,expectedRevision:first.revision });
    assert.equal(second.resetRequired,false); assert.deepEqual(second.messages.map((m) => m.sequence),[6,7,8,9,10,11,12]);
  });
  check('concurrent reads stay monotonic and isolated between guardians',async () => {
    const f = await fixture('read'), messages = [];
    await a.sendText(f.guardian,f.send('synthetic-read-own-0001'));
    for (let i = 0; i < 6; i++) messages.push(await a.sendText(f.therapist,f.send(`synthetic-read-${i}-0001`)));
    const initial = await a.list(f.guardian,{ conversationId:f.roomId }); assert.equal(initial.unread,6);
    await Promise.all([b.markRead(f.guardian,{ conversationId:f.roomId,messageId:messages[5].id }),
      a.markRead(f.guardian,{ conversationId:f.roomId,messageId:messages[1].id }),
      b.markRead(f.guardian,{ conversationId:f.roomId,messageId:messages[3].id })]);
    const current = await a.list(f.guardian,{ conversationId:f.roomId });
    assert.equal(current.lastRead,7); assert.equal(current.unread,0);
    assert.equal((await b.list(f.peer,{ conversationId:f.roomId })).lastRead,0);
  });
  check('a real connection terminated before commit rolls back and the pool recovers',async () => {
    await query('CREATE TABLE integration_disconnect_probe(id integer PRIMARY KEY)');
    let terminatedPid, terminationAttempted = false;
    await assert.rejects(databaseA.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT pg_backend_pid() AS pid'); terminatedPid = rows[0].pid;
      await tx.query('INSERT INTO integration_disconnect_probe(id) VALUES (1)');
      // Only this transaction's own backend. Never take a PID from input or
      // terminate another session, Docker, WSL, or an operating DB process.
      terminationAttempted = true;
      await tx.query('SELECT pg_terminate_backend(pg_backend_pid())');
    }),(error) => {
      const expected = error.code === '57P01' || error.code === 'DATABASE_CONNECTION_LOST' ||
        error.message === 'Connection terminated unexpectedly';
      if (!expected) console.error(`Disconnect diagnostic: ${/^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : 'NON_SQLSTATE_DRIVER_ERROR'}`);
      return expected;
    });
    assert.equal(terminationAttempted,true); assert.equal(Number.isInteger(terminatedPid),true);
    // A different pooled PID alone is not evidence of termination. Check the
    // original backend disappears; allow bounded native process cleanup time.
    const deadline = Date.now() + 2500;
    let backendGone = false;
    while (!backendGone && Date.now() < deadline) {
      const { rows } = await databaseB.transaction((tx) => tx.query(`SELECT NOT EXISTS
        (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND datname = current_database()) AS gone`,[terminatedPid]));
      backendGone = rows[0].gone;
      if (!backendGone) await new Promise((resolve) => setTimeout(resolve,50));
    }
    assert.equal(backendGone,true);
    const { rows } = await query('SELECT pg_backend_pid() AS pid, (SELECT count(*)::integer FROM integration_disconnect_probe) AS count');
    assert.notEqual(rows[0].pid,terminatedPid); assert.equal(rows[0].count,0);
  });
  check('current participant revocation still denies retry and reads',async () => {
    const f = await fixture('access'), input = f.send('synthetic-access-0001');
    await a.sendText(f.guardian,input);
    await databaseB.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM cb_conversations WHERE center_id = $1 AND id = $2 FOR UPDATE',[f.centerId,f.roomId]);
      await tx.query('UPDATE cb_participants SET active = false WHERE center_id = $1 AND conversation_id = $2 AND user_id = $3',
        [f.centerId,f.roomId,f.guardian.userId]);
    });
    await assert.rejects(a.sendText(f.guardian,input),{ code:'NOT_FOUND' });
    await assert.rejects(b.list(f.guardian,{ conversationId:f.roomId }),{ code:'NOT_FOUND' });
  });

  addDecoderJournalNativeCases(check,databaseA,databaseB);
  addRecordDraftNativeCases(check,databaseA,databaseB,fixture);
  addMediaStorageNativeCases(check,databaseA,databaseB,fixture);
  addMediaQueueNativeCases(check,databaseA,databaseB,fixture,{ config,databaseName:lease.name });
  addMediaWorkerNativeCases(check,databaseA,databaseB,fixture,{ config,databaseName:lease.name });
  addMediaResourceNativeCases(check,databaseA,databaseB,fixture);
  addMediaReviewNativeCases(check,databaseA,databaseB,fixture);
  addAuthPasswordChangeNativeCases(check,databaseA,databaseB);
  addAuthPasswordRecoveryNativeCases(check,databaseA,databaseB);
  addMessageLifecycleNativeCases(check,databaseA,databaseB,fixture,{countEditEvents:(centerId,roomId)=>databaseA.transaction(async tx=>{
    await tx.query('SET TRANSACTION READ ONLY');
    return (await tx.query(`SELECT count(*)::integer AS n FROM cb_audit_events
      WHERE center_id=$1 AND conversation_id=$2 AND action='message.edited'`,[centerId,roomId])).rows[0].n;
  })});
  for (const { label,work } of cases) {
    try { await work(); report(label); }
    catch { console.error(`FAIL ${label}`); throw new Error('POSTGRES_TEST_SCENARIO_FAILED'); }
  }
  console.log(`Native PostgreSQL integration: ${cases.length} scenarios passed.`);
} catch (error) {
  failed = true;
  const safeCode = safeErrors.has(error?.message) ? error.message : 'POSTGRES_TEST_UNAVAILABLE';
  console.error(safeCode);
} finally {
  const closed = await Promise.allSettled([databaseA?.close(),databaseB?.close()]);
  try {
    if (closed.some((result) => result.status === 'rejected')) throw new Error('POSTGRES_TEST_CLEANUP');
    if (lease) await dropDisposableDatabase(admin,lease);
    else if (candidate) console.error(`No ownership receipt; no database deletion attempted (${candidate}).`);
  } catch {
    failed = true; console.error('POSTGRES_TEST_CLEANUP: disposable database retained for inspection.');
    if (candidate) console.error(`Retained test target: ${candidate}`);
  }
  try { await admin?.end(); } catch { failed = true; console.error('POSTGRES_TEST_CLEANUP'); }
  if (failed) process.exitCode = 1;
}
