import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { PrimaryCommunicators } from '../primary-communicators.mjs';
import { seedRecoveryRecipientFixture, verifyRecoveryRecipientFixture,
  verifyQuarantinedRecoveryRecipientFixture } from '../recovery-recipient-native-check.mjs';

// Actual SQL/migration/service checks use a NEW memory-only DB. PGlite cannot
// represent the native operator's two owned database receipts: quarantined
// verifier tests below therefore use an explicitly named gate/denial DOUBLE.
// They prove verifier behavior, not native dump/restore or the real gate.
let db;
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE'); });

async function fingerprint(owner) {
  return owner.transaction(async tx => {
    await tx.query("SET LOCAL timezone = 'UTC'");
    const tables = (await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const data = [];
    for (const { tablename } of tables) {
      assert.match(tablename, /^cb_[a-z_]+$/);
      const values = (await tx.query(`SELECT to_jsonb(t)::text AS value FROM public."${tablename}" t
        ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
      data.push({ name: tablename, values });
    }
    return data;
  });
}
const verify = fixture => verifyRecoveryRecipientFixture({ owner: db, fixture, fingerprint });
const target = fixture => ({ conversationId: fixture.conversationId });
const primary = fixture => new PrimaryCommunicators(db).get(fixture.manager, target(fixture));
const assertion = error => error?.code === 'ERR_ASSERTION';
const probeOf = sql => {
  if (sql.startsWith('INSERT INTO public.cb_care_recipient_links')) return 'retained-link-conflict-insert';
  if (sql.startsWith('UPDATE public.cb_primary_communicators SET user_id=NULL')) return 'primary-clear';
  if (sql.startsWith('INSERT INTO public.cb_primary_communicator_requests')) return 'primary-receipt-insert';
  return ({ 'TRUNCATE public.cb_care_recipient_links': 'links-truncate',
    'TRUNCATE public.cb_primary_communicators': 'primary-truncate',
    'TRUNCATE public.cb_primary_communicator_requests': 'receipts-truncate' })[sql] ?? null;
};

// Account deactivation and qualification increments remain actual SQL. ONLY
// the private gate observation and blocked-statement outcome are doubled.
async function quarantineContractDouble(options = {}) {
  await db.query('UPDATE public.cb_users SET active=false WHERE active');
  const seen = [];
  const owner = { transaction(work) { return db.transaction(async tx => {
    try {
      return await work({ async query(sql, params) {
        if (sql.includes('AS gates,') && sql.includes('AS active_users')) {
          const actual = await tx.query('SELECT count(*)::integer AS active_users FROM public.cb_users WHERE active');
          return { rows: [{ gates: options.gates ?? 1, active_users: actual.rows[0].active_users }] };
        }
        const probe = probeOf(sql);
        if (probe) {
          seen.push(probe);
          if (options.allow === probe) return tx.query(sql, params);
          throw Object.assign(new Error(options.message ?? 'restored service remains quarantined'), { code: options.code ?? '23514' });
        }
        return tx.query(sql, params);
      } });
    } catch (error) {
      if (options.breakRollback && error.message === 'RECOVERY_RECIPIENT_WRITE_NOT_BLOCKED') return;
      throw error;
    }
  }); } };
  return { owner, seen };
}

test('actual SQL seeds nonempty stable identity, two exact preferences and nonzero qualification snapshots', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  assert.ok(Object.isFrozen(fixture) && Object.isFrozen(fixture.expected) && Object.isFrozen(fixture.commands.connect));
  assert.deepEqual([fixture.expected.links.length, fixture.expected.primary.length, fixture.expected.primaryRequests.length], [1, 1, 2]);
  const selected = JSON.parse(fixture.expected.primary[0]);
  assert.deepEqual([selected.user_generation, selected.membership_generation, selected.participant_generation], [2, 2, 2]);
  assert.equal(selected.user_id, fixture.recipient.userId);
  assert.equal(selected.revision, 2);
  const participant = fixture.expected.participants.find(value => value.user_id === fixture.recipient.userId);
  assert.equal(participant.first_sequence, '2'); assert.equal(participant.generation, '2');
  assert.equal(fixture.expected.users.length, 3); assert.ok(fixture.expected.users.every(value => value.active));
  assert.equal(fixture.expected.accounts.length, 3);
  assert.doesNotMatch(JSON.stringify(fixture), /password|password_hash|token|scrypt\$/i);
  const { rows } = await db.query(`SELECT (SELECT count(*)::integer FROM cb_auth_sessions) AS sessions,
    (SELECT count(*)::integer FROM cb_account_security_events) AS events`);
  assert.deepEqual(rows, [{ sessions: 0, events: 0 }]);
});

test('actual SQL positive controls run successfully then roll back, including each whole-table truncate', async () => {
  const statements = [], owner = { transaction: work => db.transaction(tx => work({ query(sql, params) {
    if (probeOf(sql)) statements.push({ kind: probeOf(sql), sql });
    return tx.query(sql, params);
  } })) };
  const fixture = await seedRecoveryRecipientFixture(owner);
  assert.deepEqual(statements.map(value => value.kind), fixture.positiveControls);
  assert.equal(statements.length, 6);
  assert.match(statements[0].sql, /ON CONFLICT \(center_id,conversation_id\) DO NOTHING/);
  await verify(fixture);
  assert.deepEqual([fixture.expected.links.length, fixture.expected.primary.length, fixture.expected.primaryRequests.length], [1, 1, 2]);
});

test('exact old connect/disconnect and primary receipts never mutate current state or issue write SQL', async () => {
  const fixture = await seedRecoveryRecipientFixture(db), before = await fingerprint(db);
  let prohibited = 0;
  const owner = { transaction: work => db.transaction(tx => work({ query(sql, params) {
    if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i.test(sql)) {
      prohibited++; throw new Error('SYNTHETIC_UNEXPECTED_REPLAY_WRITE');
    }
    return tx.query(sql, params);
  } })) };
  await verifyRecoveryRecipientFixture({ owner, fixture, fingerprint });
  await verifyRecoveryRecipientFixture({ owner, fixture, fingerprint });
  assert.equal(prohibited, 0);
  assert.deepEqual(await primary(fixture), { ...target(fixture), userId: fixture.recipient.userId, revision: 2 });
  assert.deepEqual(await fingerprint(db), before);
});

test('separate synthetic fixtures and rollback probes preserve earlier fixture rows', async () => {
  const first = await seedRecoveryRecipientFixture(db), second = await seedRecoveryRecipientFixture(db);
  assert.notEqual(first.centerId, second.centerId);
  await verify(first); await verify(second);
  const { rows } = await db.query('SELECT count(*)::integer AS count FROM cb_care_recipient_links');
  assert.deepEqual(rows, [{ count: 2 }]);
});

test('empty expected evidence and zero qualification snapshots cannot masquerade as 023 coverage', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  for (const name of ['links', 'primary', 'primaryRequests', 'users', 'memberships', 'participants', 'accounts', 'conversation']) {
    const invalid = structuredClone(fixture); invalid.expected[name] = [];
    await assert.rejects(verify(invalid), assertion);
  }
  const invalid = structuredClone(fixture), selected = JSON.parse(invalid.expected.primary[0]);
  selected.user_generation = 0; invalid.expected.primary[0] = JSON.stringify(selected);
  await assert.rejects(verify(invalid), assertion);
});

test('missing actual links and equal-count receipt changes are rejected without modifying the DB', async () => {
  const fixture = await seedRecoveryRecipientFixture(db), before = await fingerprint(db);
  for (const table of ['cb_care_recipient_links', 'cb_primary_communicator_requests']) {
    const owner = { transaction: work => db.transaction(tx => work({ async query(sql, params) {
      const result = await tx.query(sql, params);
      if (sql.includes(`FROM public.${table} t WHERE`)) {
        if (table === 'cb_care_recipient_links') return { ...result, rows: [] };
        return { ...result, rows: result.rows.map(value => ({ value: JSON.stringify({ ...JSON.parse(value.value), request_hash: 'f'.repeat(64) }) })) };
      }
      return result;
    } })) };
    await assert.rejects(verifyRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
  }
  assert.deepEqual(await fingerprint(db), before);
});

test('actual later preference and qualification changes cannot pass as the retained baseline', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  await new PrimaryCommunicators(db).save(fixture.manager, { ...target(fixture), userId: fixture.guardian.userId,
    expectedRevision: 2, clientId: 'synthetic-newer-primary-request' });
  const before = await fingerprint(db);
  await assert.rejects(verify(fixture), assertion);
  assert.deepEqual(await fingerprint(db), before);
});

test('normal verification checks the full fingerprint in finally even when a state query fails', async () => {
  const fixture = await seedRecoveryRecipientFixture(db); let fingerprints = 0;
  const owner = { transaction: work => db.transaction(tx => work({ query(sql, params) {
    if (sql.includes('FROM public.cb_care_recipient_links t WHERE')) throw new Error('SYNTHETIC_READ_FAILURE');
    return tx.query(sql, params);
  } })) };
  await assert.rejects(verifyRecoveryRecipientFixture({ owner, fixture,
    fingerprint: async () => { fingerprints++; return fingerprint(db); } }), /SYNTHETIC_READ_FAILURE/);
  assert.equal(fingerprints, 2);
});

test('quarantine CONTRACT DOUBLE accepts only account generation +1 and all six exact guard denials', async () => {
  const fixture = await seedRecoveryRecipientFixture(db), { owner, seen } = await quarantineContractDouble();
  const before = await fingerprint(db);
  await verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint });
  assert.deepEqual(seen, fixture.positiveControls);
  assert.deepEqual(await fingerprint(db), before);
  const { rows } = await db.query(`SELECT u.communication_generation::text AS current,p.user_generation::text AS saved
    FROM cb_users u JOIN cb_primary_communicators p ON p.user_id=u.id WHERE u.id=$1`, [fixture.recipient.userId]);
  assert.deepEqual(rows, [{ current: '3', saved: '2' }]);
});

test('quarantine CONTRACT DOUBLE refuses absent or duplicate gate observations before probes', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  for (const gates of [0, 2]) {
    const { owner, seen } = await quarantineContractDouble({ gates });
    await assert.rejects(verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
    assert.deepEqual(seen, []);
  }
});

test('quarantine CONTRACT DOUBLE rejects another SQLSTATE or another 23514 message as false guard evidence', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  for (const options of [{ code: '42501' }, { message: 'primary communicator identity/version is immutable' }]) {
    const { owner } = await quarantineContractDouble(options), before = await fingerprint(db);
    await assert.rejects(verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
    assert.deepEqual(await fingerprint(db), before);
  }
});

test('quarantine CONTRACT DOUBLE rolls back every unexpected successful probe and still fails verification', async () => {
  const fixture = await seedRecoveryRecipientFixture(db);
  for (const allow of fixture.positiveControls) {
    const { owner } = await quarantineContractDouble({ allow }), before = await fingerprint(db);
    await assert.rejects(verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
    assert.deepEqual(await fingerprint(db), before);
  }
});

for (const table of ['cb_users', 'cb_memberships', 'cb_participants']) {
  test(`quarantine CONTRACT DOUBLE independently detects excess actual ${table} generation`, async () => {
    const fixture = await seedRecoveryRecipientFixture(db), { owner } = await quarantineContractDouble();
    // Fresh fixture for each generation axis: a previous mismatch must not
    // mask failure to detect a different table's qualification generation.
    // These real transitions do not alter the schema or disable a trigger.
    const where = table === 'cb_users' ? 'id=$1' : 'center_id=$1 AND user_id=$2';
    const values = table === 'cb_users' ? [fixture.recipient.userId] : [fixture.centerId, fixture.recipient.userId];
    const first = table === 'cb_users' ? true : false;
    for (const active of [first, !first]) await db.query(`UPDATE ${table} SET active=$${values.length + 1} WHERE ${where}`, [...values, active]);
    const before = await fingerprint(db);
    await assert.rejects(verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
    assert.deepEqual(await fingerprint(db), before);
  });
}

test('quarantine CONTRACT DOUBLE finally fingerprint detects an owner adapter that improperly commits a failed probe', async () => {
  const fixture = await seedRecoveryRecipientFixture(db), { owner } = await quarantineContractDouble({ allow: 'primary-clear', breakRollback: true });
  const before = await fingerprint(db);
  await assert.rejects(verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }), assertion);
  assert.notDeepEqual(await fingerprint(db), before);
  const { rows } = await db.query('SELECT user_id,revision::text AS revision FROM cb_primary_communicators WHERE center_id=$1', [fixture.centerId]);
  assert.deepEqual(rows, [{ user_id: null, revision: '3' }]);
});
