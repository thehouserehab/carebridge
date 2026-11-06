// Explicit synthetic recovery fixture only. Importing opens no database,
// account, listener, process or file. Callers own a NEW disposable database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { CareRecipientLinks } from './care-recipient-links.mjs';
import { PrimaryCommunicators } from './primary-communicators.mjs';
import { Conversations } from './conversations.mjs';

const proofCode = 'RECOVERY_RECIPIENT_FIXTURE_INVALID';
const probeKinds = Object.freeze(['retained-link-conflict-insert', 'primary-clear', 'primary-receipt-insert',
  'links-truncate', 'primary-truncate', 'receipts-truncate']);
const same = (actual, expected) => assert.deepEqual(actual, expected, proofCode);
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const row = value => JSON.parse(value);
const receipt = value => ({ ...value, replayed: true });
const actorsOf = fixture => [fixture.manager, fixture.guardian, fixture.recipient];

async function state(owner, fixture) {
  const { centerId, conversationId } = fixture, users = actorsOf(fixture).map(actor => actor.userId);
  return owner.transaction(async tx => {
    await tx.query("SET LOCAL timezone = 'UTC'");
    await tx.query("SET LOCAL datestyle = 'ISO, YMD'");
    const raw = async (table, where, values) => (await tx.query(`SELECT to_jsonb(t)::text AS value
      FROM public.${table} t WHERE ${where} ORDER BY to_jsonb(t)::text COLLATE "C"`, values)).rows.map(item => item.value);
    // Full rows for the three new tables: hashes, snapshots, versions, actor
    // identities and timestamps must survive, not just matching row counts.
    const links = await raw('cb_care_recipient_links', 'center_id=$1', [centerId]);
    const primary = await raw('cb_primary_communicators', 'center_id=$1', [centerId]);
    const primaryRequests = await raw('cb_primary_communicator_requests', 'center_id=$1', [centerId]);
    const userRows = (await tx.query(`SELECT id,active,communication_generation::text AS generation
      FROM public.cb_users WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`, [users])).rows;
    const memberships = (await tx.query(`SELECT center_id,user_id,role,active,communication_generation::text AS generation
      FROM public.cb_memberships WHERE center_id=$1 ORDER BY user_id COLLATE "C"`, [centerId])).rows;
    const participants = (await tx.query(`SELECT center_id,conversation_id,user_id,role,active,first_sequence::text AS first_sequence,
      communication_generation::text AS generation FROM public.cb_participants WHERE center_id=$1
      ORDER BY conversation_id COLLATE "C",user_id COLLATE "C"`, [centerId])).rows;
    // No password, password hash or login token is needed in returned evidence.
    const accounts = (await tx.query(`SELECT user_id,email FROM public.cb_auth_accounts
      WHERE user_id=ANY($1::text[]) ORDER BY user_id COLLATE "C"`, [users])).rows;
    const conversation = (await tx.query(`SELECT center_id,id,child_id,last_sequence::text AS last_sequence,
      revision::text AS revision,relationships_version::text AS relationships_version
      FROM public.cb_conversations WHERE center_id=$1 AND id=$2`, [centerId, conversationId])).rows;
    return { links, primary, primaryRequests, users: userRows, memberships, participants, accounts, conversation };
  });
}

function assertFixture(fixture) {
  assert.equal(fixture?.version, 1, proofCode);
  const actors = actorsOf(fixture), identities = actors.map(actor => actor?.userId);
  assert.equal(new Set(identities).size, 3, proofCode);
  for (const value of [fixture.centerId, fixture.childId, fixture.conversationId, ...identities])
    assert.match(value, /^synthetic-recipient-[a-z]+-[a-f0-9-]{36}$/, proofCode);
  for (const actor of actors) assert.equal(actor.centerId, fixture.centerId, proofCode);
  same(fixture.positiveControls, probeKinds);
  const expected = fixture.expected;
  for (const [name, count] of [['links', 1], ['primary', 1], ['primaryRequests', 2], ['users', 3],
    ['memberships', 3], ['participants', 2], ['accounts', 3], ['conversation', 1]]) {
    assert.ok(Array.isArray(expected?.[name]), proofCode);
    assert.equal(expected[name].length, count, proofCode);
  }
  const link = row(expected.links[0]), selected = row(expected.primary[0]);
  for (const value of [link, selected]) {
    assert.equal(value.center_id, fixture.centerId, proofCode);
    assert.equal(value.conversation_id, fixture.conversationId, proofCode);
    assert.equal(value.user_id, fixture.recipient.userId, proofCode);
  }
  assert.equal(link.child_id, fixture.childId, proofCode);
  assert.equal(link.role, 'care_recipient', proofCode);
  assert.equal(link.linked_by, fixture.manager.userId, proofCode);
  assert.equal(selected.revision, 2, proofCode);
  assert.equal(selected.updated_by, fixture.manager.userId, proofCode);
  for (const name of ['user_generation', 'membership_generation', 'participant_generation'])
    assert.equal(selected[name], 2, proofCode);
  const roles = new Map([[fixture.manager.userId, 'center'], [fixture.guardian.userId, 'guardian'],
    [fixture.recipient.userId, 'care_recipient']]);
  for (const name of ['users', 'memberships', 'participants']) {
    const rows = expected[name], key = name === 'users' ? 'id' : 'user_id';
    assert.equal(new Set(rows.map(item => item[key])).size, rows.length, proofCode);
    for (const value of rows) {
      assert.ok(roles.has(value[key]), proofCode);
      assert.equal(value.active, true, proofCode);
      assert.equal(value.generation, value[key] === fixture.recipient.userId ? '2' : '0', proofCode);
      if (name !== 'users') {
        assert.equal(value.center_id, fixture.centerId, proofCode);
        assert.equal(value.role, roles.get(value[key]), proofCode);
      }
    }
  }
  const recipient = expected.participants.find(value => value.user_id === fixture.recipient.userId);
  assert.equal(recipient?.first_sequence, '2', proofCode);
  assert.equal(recipient?.conversation_id, fixture.conversationId, proofCode);
  assert.equal(expected.conversation[0].last_sequence, '1', proofCode);
  assert.equal(expected.conversation[0].child_id, fixture.childId, proofCode);
  const requests = expected.primaryRequests.map(row).sort((a, b) => a.applied_revision - b.applied_revision);
  for (const [index, request] of requests.entries()) {
    const command = fixture.commands[index === 0 ? 'firstPrimary' : 'secondPrimary'];
    same({ centerId: request.center_id, conversationId: request.conversation_id, actorId: request.actor_id,
      clientId: request.client_id, expectedRevision: request.expected_revision, appliedRevision: request.applied_revision, changed: request.changed },
    { centerId: fixture.centerId, conversationId: fixture.conversationId, actorId: fixture.manager.userId,
      clientId: command.clientId, expectedRevision: index, appliedRevision: index + 1, changed: true });
    const hash = createHash('sha256').update(JSON.stringify({ roomId: fixture.conversationId,
      userId: index === 0 ? fixture.guardian.userId : fixture.recipient.userId, expected: index })).digest('hex');
    assert.equal(request.request_hash, hash, proofCode);
  }
}

function writeProbes(fixture) {
  const { centerId, conversationId, childId, manager, recipient } = fixture;
  return [
    { kind: probeKinds[0], expectedRows: 0, sql: `INSERT INTO public.cb_care_recipient_links
      (center_id,conversation_id,child_id,user_id,linked_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (center_id,conversation_id) DO NOTHING`,
    values: [centerId, conversationId, childId, recipient.userId, manager.userId] },
    { kind: probeKinds[1], expectedRows: 1, sql: `UPDATE public.cb_primary_communicators SET user_id=NULL,
      user_generation=NULL,membership_generation=NULL,participant_generation=NULL,revision=revision+1,updated_by=$3
      WHERE center_id=$1 AND conversation_id=$2`, values: [centerId, conversationId, manager.userId] },
    { kind: probeKinds[2], expectedRows: 1, sql: `INSERT INTO public.cb_primary_communicator_requests
      (center_id,conversation_id,actor_id,client_id,request_hash,expected_revision,applied_revision,changed)
      VALUES ($1,$2,$3,$4,$5,2,2,false)`,
    values: [centerId, conversationId, manager.userId, fixture.probeClientId, 'a'.repeat(64)] },
    ...[['cb_care_recipient_links', probeKinds[3]], ['cb_primary_communicators', probeKinds[4]],
      ['cb_primary_communicator_requests', probeKinds[5]]].map(([table, kind]) => ({ kind,
      sql: `TRUNCATE public.${table}`, emptyTable: table, values: [] })),
  ];
}

async function proveRollbackWrites(owner, fixture) {
  const before = await state(owner, fixture);
  for (const probe of writeProbes(fixture)) {
    const rollback = new Error('RECOVERY_RECIPIENT_POSITIVE_CONTROL_ROLLBACK');
    await assert.rejects(owner.transaction(async tx => {
      const result = await tx.query(probe.sql, probe.values);
      if (probe.emptyTable) {
        const { rows } = await tx.query(`SELECT count(*)::integer AS count FROM public.${probe.emptyTable}`);
        same(rows, [{ count: 0 }]);
      } else assert.equal(result.rowCount ?? result.affectedRows, probe.expectedRows, proofCode);
      // Force deferred identity checks before deliberately rolling back. A
      // statement that only appeared valid until transaction end is no proof.
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }), error => error === rollback, proofCode);
    same(await state(owner, fixture), before);
  }
}

export async function seedRecoveryRecipientFixture(owner) {
  const suffix = randomUUID(), centerId = `synthetic-recipient-center-${suffix}`;
  const actor = kind => ({ centerId, userId: `synthetic-recipient-${kind}-${suffix}` });
  const manager = actor('manager'), guardian = actor('guardian'), recipient = actor('recipient');
  const fixture = { version: 1, centerId, childId: `synthetic-recipient-child-${suffix}`,
    conversationId: `synthetic-recipient-room-${suffix}`, manager, guardian, recipient,
    commands: {}, receipts: {}, probeClientId: randomUUID(), positiveControls: [] };
  await owner.transaction(async tx => {
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [centerId]);
    for (const [who, role] of [[manager, 'center'], [guardian, 'guardian'], [recipient, 'care_recipient']]) {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [who.userId]);
      await tx.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)', [centerId, who.userId, role]);
      // Deliberately unparseable, non-authenticatable synthetic hash. This
      // fixture proves account presence/identity, never a login or password.
      await tx.query(`INSERT INTO cb_auth_accounts(user_id,email,password_hash)
        VALUES ($1,$2,'scrypt$'||repeat('x',100))`, [who.userId, `${role}.${suffix}@synthetic.invalid`]);
    }
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [centerId, fixture.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',
      [centerId, fixture.conversationId, fixture.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'guardian',true,1)`, [centerId, fixture.conversationId, guardian.userId]);
    for (const active of [false, true]) {
      await tx.query('UPDATE cb_users SET active=$2 WHERE id=$1', [recipient.userId, active]);
      await tx.query('UPDATE cb_memberships SET active=$3 WHERE center_id=$1 AND user_id=$2', [centerId, recipient.userId, active]);
    }
  });
  await new Conversations(owner).sendText(guardian, { conversationId: fixture.conversationId,
    clientId: randomUUID(), body: 'Synthetic retained history before recipient connection' });
  const links = new CareRecipientLinks(owner), primary = new PrimaryCommunicators(owner);
  const target = { conversationId: fixture.conversationId };
  for (const [name, method] of [['connect', 'connect'], ['disconnect', 'disconnect'], ['reconnect', 'connect']]) {
    fixture.commands[name] = { ...target, userId: recipient.userId, expectedVersion: (await links.get(manager, target)).version, clientId: randomUUID() };
    fixture.receipts[name] = await links[method](manager, fixture.commands[name]);
    assert.equal(fixture.receipts[name].changed, true, proofCode);
  }
  for (const [index, name, userId] of [[0, 'firstPrimary', guardian.userId], [1, 'secondPrimary', recipient.userId]]) {
    fixture.commands[name] = { ...target, userId, expectedRevision: index, clientId: randomUUID() };
    fixture.receipts[name] = await primary.save(manager, fixture.commands[name]);
    same(fixture.receipts[name], { ...target, appliedRevision: index + 1, changed: true, replayed: false });
  }
  fixture.expected = await state(owner, fixture);
  await proveRollbackWrites(owner, fixture);
  fixture.positiveControls = [...probeKinds];
  assertFixture(fixture);
  return deepFreeze(fixture);
}

export async function verifyRecoveryRecipientFixture({ owner, fixture, fingerprint }) {
  const before = await fingerprint(owner);
  try {
    assertFixture(fixture);
    same(await state(owner, fixture), fixture.expected);
    const links = new CareRecipientLinks(owner), primary = new PrimaryCommunicators(owner);
    const target = { conversationId: fixture.conversationId }, expectedContact = { ...target, userId: fixture.recipient.userId, revision: 2 };
    const expectedLink = { ...target, childId: fixture.childId, userId: fixture.recipient.userId, active: true,
      version: Number(fixture.expected.conversation[0].relationships_version) };
    for (const actor of actorsOf(fixture)) same(await primary.get(actor, target), expectedContact);
    same(await links.get(fixture.manager, target), expectedLink);
    for (const [name, method] of [['connect', 'connect'], ['disconnect', 'disconnect'], ['reconnect', 'connect']]) {
      same(await links[method](fixture.manager, fixture.commands[name]), receipt(fixture.receipts[name]));
      same(await links.get(fixture.manager, target), expectedLink);
    }
    for (const name of ['firstPrimary', 'secondPrimary']) {
      same(await primary.save(fixture.manager, fixture.commands[name]), receipt(fixture.receipts[name]));
      same(await primary.get(fixture.manager, target), expectedContact);
    }
    same(await state(owner, fixture), fixture.expected);
  } finally {
    // Includes denied reads, exact retries, unexpected errors and all tables
    // outside this fixture. A receipt retry must not roll current state back.
    same(await fingerprint(owner), before);
  }
}

export async function verifyQuarantinedRecoveryRecipientFixture({ owner, fixture, fingerprint }) {
  const before = await fingerprint(owner);
  try {
    assertFixture(fixture);
    const posture = (await owner.transaction(tx => tx.query(`SELECT
      (SELECT count(*)::integer FROM public.cb_recovery_quarantine) AS gates,
      (SELECT count(*)::integer FROM public.cb_users WHERE active) AS active_users`))).rows;
    same(posture, [{ gates: 1, active_users: 0 }]);
    const expected = structuredClone(fixture.expected);
    expected.users = expected.users.map(user => ({ ...user, active: false,
      generation: String(BigInt(user.generation) + (user.active ? 1n : 0n)) }));
    // Only account generations change (recipient 2->3). Membership and
    // participant generations, stored primary snapshots (2), all receipts,
    // the retained link and first_sequence stay byte-for-byte unchanged.
    same(await state(owner, fixture), expected);
    const primary = new PrimaryCommunicators(owner), links = new CareRecipientLinks(owner);
    const target = { conversationId: fixture.conversationId };
    for (const actor of actorsOf(fixture)) await assert.rejects(primary.get(actor, target), { code: 'NOT_FOUND' });
    await assert.rejects(links.get(fixture.manager, target), { code: 'NOT_FOUND' });
    for (const probe of writeProbes(fixture)) {
      await assert.rejects(owner.transaction(async tx => {
        await tx.query(probe.sql, probe.values);
        // Unexpected success is always rolled back; it must still fail this
        // verifier rather than become an intentional write to the restore.
        throw new Error('RECOVERY_RECIPIENT_WRITE_NOT_BLOCKED');
      }), { code: '23514', message: 'restored service remains quarantined' });
    }
    same(await state(owner, fixture), expected);
  } finally {
    same(await fingerprint(owner), before);
  }
}
