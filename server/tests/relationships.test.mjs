import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Relationships } from '../relationships.mjs';
import { Conversations } from '../conversations.mjs';
import { migrate } from '../migrate.mjs';
import { RepositoryError } from '../errors.mjs';

// In-memory fixture only; never read DATABASE_URL or reset an external database.
let database, relationships, conversations;
const manager = { centerId: 'center-a', userId: 'manager-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const replacement = { centerId: 'center-a', userId: 'therapist-new' };
const peer = { centerId: 'center-a', userId: 'guardian-new' };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const get = () => relationships.get(manager, { conversationId: 'room-a' });
const list = (actor, extra = {}) => conversations.list(actor, { conversationId: 'room-a', ...extra });
const send = (actor, clientId, extra = {}) => conversations.sendText(actor, {
  conversationId: 'room-a', clientId, body: 'PRIVATE-CONTENT-FIXTURE', ...extra,
});
async function command(extra = {}) {
  return {
    conversationId: 'room-a', clientId: 'relation-0001', expectedVersion: (await get()).version,
    therapist: { userId: therapist.userId, history: 'preserve' },
    guardians: [{ userId: guardian.userId, history: 'preserve' }], historyConfirmed: true, ...extra,
  };
}

before(async () => {
  database = await PGlite.create();
  await migrate(database);
});
after(async () => { await database?.close(); });
beforeEach(async () => {
  await database.exec(`TRUNCATE cb_centers, cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'), ('center-b');
    INSERT INTO cb_users(id, active) VALUES
      ('manager-a',true), ('manager-b',true), ('therapist-a',true), ('therapist-new',true),
      ('guardian-a',true), ('guardian-new',true), ('guardian-b',true), ('disabled-user',false);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ('center-a','manager-a','center',true), ('center-b','manager-b','center',true),
      ('center-a','therapist-a','therapist',true), ('center-a','therapist-new','therapist',true),
      ('center-a','guardian-a','guardian',true), ('center-a','guardian-new','guardian',true),
      ('center-a','disabled-user','guardian',true), ('center-b','guardian-b','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'), ('center-a','child-other'), ('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('center-a','room-a','child-a'), ('center-a','room-other','child-other'), ('center-b','room-b','child-b');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1);`);
  relationships = new Relationships(database);
  conversations = new Conversations(database);
});

test('only a current center manager can inspect or change relationships without seeing clinical content', async () => {
  await send(guardian, 'message-0001');
  const input = await command();
  for (const actor of [therapist, guardian, { centerId: 'center-a', userId: 'manager-b' },
    { centerId: 'center-b', userId: 'manager-b' }]) {
    await assert.rejects(relationships.get({ ...actor, role: 'center' }, { conversationId: 'room-a' }), errorCode('NOT_FOUND'));
    await assert.rejects(relationships.replace({ ...actor, role: 'center' }, input), errorCode('NOT_FOUND'));
  }
  assert.deepEqual(Object.keys(await get()).sort(), ['childId', 'conversationId', 'participants', 'version']);
  assert.equal(JSON.stringify(await get()).includes('PRIVATE-CONTENT-FIXTURE'), false);
  await assert.rejects(list(manager), errorCode('NOT_FOUND'));
  for (const target of ['cb_users', 'cb_memberships']) {
    const column = target === 'cb_users' ? 'id' : 'user_id';
    await database.query(`UPDATE ${target} SET active = false WHERE ${column} = $1`, [manager.userId]);
    await assert.rejects(relationships.replace(manager, input), errorCode('NOT_FOUND'));
    await database.query(`UPDATE ${target} SET active = true WHERE ${column} = $1`, [manager.userId]);
  }
});

test('therapist replacement and guardian disconnection preserve messages and immediately deny former access', async () => {
  const old = await send(guardian, 'message-0001');
  const response = await send(therapist, 'message-0002', { replyTo: old.id });
  const input = await command({
    therapist: { userId: replacement.userId, history: 'all' },
    pastHistoryConfirmed: true,
    guardians: [{ userId: peer.userId, history: 'all' }],
  });
  const result = await relationships.replace(manager, input);
  assert.equal(result.changed, true);
  assert.ok(result.appliedVersion > input.expectedVersion);
  for (const actor of [therapist, guardian]) {
    await assert.rejects(list(actor), errorCode('NOT_FOUND'));
    await assert.rejects(send(actor, 'blocked-0001'), errorCode('NOT_FOUND'));
    await assert.rejects(conversations.get(actor, { conversationId: 'room-a', messageId: old.id }), errorCode('NOT_FOUND'));
    await assert.rejects(conversations.markRead(actor, { conversationId: 'room-a', messageId: old.id }), errorCode('NOT_FOUND'));
  }
  assert.deepEqual((await list(replacement)).messages.map((m) => m.id), [old.id, response.id]);
  assert.equal((await list(peer)).messages[1].quote.id, old.id);
  assert.equal((await get()).participants.filter((p) => p.active && p.role === 'therapist').length, 1);
  assert.equal((await database.query('SELECT * FROM cb_messages')).rows.length, 2);
  assert.equal((await database.query('SELECT * FROM cb_relationship_changes')).rows.length, 4);
  assert.equal(JSON.stringify((await database.query('SELECT * FROM cb_relationship_requests')).rows).includes(old.body), false);
  assert.deepEqual(await migrate(database), []);
});

test('from_now starts after the committed boundary and applies to read, reply, quote and unread projections', async () => {
  const first = await send(therapist, 'message-0001');
  const input = await command({ guardians: [
    { userId: guardian.userId, history: 'preserve' }, { userId: peer.userId, history: 'from_now' },
  ] });
  // Messages arriving after the management form opened remain before admission.
  await send(therapist, 'message-0002');
  await relationships.replace(manager, input);
  assert.equal((await get()).participants.find((p) => p.userId === peer.userId).firstSequence, 3);
  assert.deepEqual((await list(peer)).messages, []);
  assert.equal((await list(peer)).unread, 0);
  for (const operation of [
    () => conversations.get(peer, { conversationId: 'room-a', messageId: first.id }),
    () => conversations.markRead(peer, { conversationId: 'room-a', messageId: first.id }),
    () => send(peer, 'blocked-0001', { replyTo: first.id }),
  ]) await assert.rejects(operation(), errorCode('NOT_FOUND'));
  const newMessage = await send(therapist, 'message-0003', { replyTo: first.id });
  const visible = await list(peer);
  assert.deepEqual(visible.messages.map((m) => m.id), [newMessage.id]);
  assert.equal(visible.messages[0].quote.hidden, true);
  assert.equal('authorId' in visible.messages[0].quote, false);
  assert.equal(visible.unread, 1);
});

test('history expansion resets only the affected read cursor and invalidates existing projections', async () => {
  const first = await send(therapist, 'message-0001');
  await relationships.replace(manager, await command({ guardians: [
    { userId: guardian.userId, history: 'preserve' }, { userId: peer.userId, history: 'from_now' },
  ] }));
  const next = await send(therapist, 'message-0002');
  for (const actor of [guardian, peer])
    await conversations.markRead(actor, { conversationId: 'room-a', messageId: next.id });
  const previousPage = await list(peer);
  const unconfirmed = await command({ clientId: 'relation-0002', guardians: [
    { userId: guardian.userId, history: 'preserve' }, { userId: peer.userId, history: 'all' },
  ] });
  await assert.rejects(relationships.replace(manager, unconfirmed), errorCode('PAST_HISTORY_CONFIRMATION_REQUIRED'));
  assert.equal((await list(peer)).lastRead, next.sequence);
  assert.equal((await list(peer)).messages.length, 1);
  await relationships.replace(manager, await command({ clientId: 'relation-0002', pastHistoryConfirmed: true, guardians: [
    { userId: guardian.userId, history: 'preserve' }, { userId: peer.userId, history: 'all' },
  ] }));
  assert.equal((await list(peer, { expectedRevision: previousPage.revision })).resetRequired, true);
  assert.equal((await list(peer)).lastRead, 0);
  assert.equal((await list(peer)).unread, 2);
  assert.equal((await list(guardian)).lastRead, next.sequence);
  assert.equal((await list(peer)).messages[0].id, first.id);
});

test('rejoining a disconnected participant requires explicit history and does not inherit old read state', async () => {
  const first = await send(therapist, 'message-0001');
  await conversations.markRead(guardian, { conversationId: 'room-a', messageId: first.id });
  await relationships.replace(manager, await command({ guardians: [] }));
  await send(therapist, 'message-0002');
  await assert.rejects(relationships.replace(manager, await command({ clientId: 'relation-0002' })), errorCode('HISTORY_CHOICE_REQUIRED'));
  await relationships.replace(manager, await command({
    clientId: 'relation-0002', guardians: [{ userId: guardian.userId, history: 'from_now' }],
  }));
  assert.equal((await list(guardian)).lastRead, 0);
  assert.equal((await list(guardian)).unread, 0);
  assert.deepEqual((await list(guardian)).messages, []);
  const after = await send(therapist, 'message-0003');
  assert.deepEqual((await list(guardian)).messages.map((m) => m.id), [after.id]);
});

test('same request replay returns its receipt without applying old assignments again', async () => {
  const input = await command({ guardians: [] });
  const results = await Promise.all([relationships.replace(manager, input), relationships.replace(manager, input)]);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.equal(results[0].appliedVersion, results[1].appliedVersion);
  await relationships.replace(manager, await command({
    clientId: 'relation-0002', pastHistoryConfirmed: true, guardians: [{ userId: guardian.userId, history: 'all' }],
  }));
  const before = await get();
  assert.equal((await relationships.replace(manager, input)).replayed, true);
  assert.deepEqual(await get(), before);
  await assert.rejects(relationships.replace(manager, { ...input, therapist: null }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(relationships.replace(manager, {
    ...input, conversationId: 'room-other', expectedVersion: 0,
  }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal((await database.query('SELECT * FROM cb_relationship_requests')).rows.length, 2);
  await database.query("UPDATE cb_memberships SET active = false WHERE user_id = 'manager-a'");
  await assert.rejects(relationships.replace(manager, input), errorCode('NOT_FOUND'));
});

test('stale assignments are rejected, no-op is stable, and message/read updates do not cause false conflicts', async () => {
  const noOp = await command();
  const message = await send(therapist, 'message-0001');
  await conversations.markRead(guardian, { conversationId: 'room-a', messageId: message.id });
  const result = await relationships.replace(manager, noOp);
  assert.equal(result.changed, false);
  assert.equal(result.appliedVersion, noOp.expectedVersion);
  const stale = await command({ clientId: 'relation-stale', therapist: null });
  await relationships.replace(manager, await command({ clientId: 'relation-0002', guardians: [] }));
  await assert.rejects(relationships.replace(manager, stale), errorCode('RELATIONSHIP_CONFLICT'));
  assert.equal((await get()).participants.find((p) => p.userId === therapist.userId).active, true);
});

test('invalid selection, forged role, missing history and inactive/foreign accounts never partially change relationships', async () => {
  const initial = await get();
  const base = await command();
  for (const [override, code] of [
    [{ historyConfirmed: false }, 'HISTORY_CONFIRMATION_REQUIRED'],
    [{ expectedVersion: -1 }, 'INVALID_INPUT'],
    [{ role: 'center' }, 'INVALID_INPUT'],
    [{ therapist: { userId: therapist.userId } }, 'INVALID_INPUT'],
    [{ therapist: { userId: therapist.userId, history: 'from_now', firstSequence: 1 } }, 'INVALID_INPUT'],
    [{ therapist: { userId: manager.userId, history: 'all' } }, 'PARTICIPANT_UNAVAILABLE'],
    [{ guardians: [{ userId: peer.userId, history: 'preserve' }] }, 'HISTORY_CHOICE_REQUIRED'],
    [{ guardians: [{ userId: 'disabled-user', history: 'all' }] }, 'PARTICIPANT_UNAVAILABLE'],
    [{ guardians: [{ userId: 'guardian-b', history: 'all' }] }, 'PARTICIPANT_UNAVAILABLE'],
    [{ guardians: [{ userId: 'missing-user', history: 'all' }] }, 'PARTICIPANT_UNAVAILABLE'],
    [{ guardians: [{ userId: peer.userId, history: 'all' }, { userId: peer.userId, history: 'all' }] }, 'INVALID_INPUT'],
  ]) {
    await assert.rejects(relationships.replace(manager, { ...base, ...override }), errorCode(code));
    assert.deepEqual(await get(), initial);
  }
  await database.query("UPDATE cb_memberships SET active = false WHERE user_id = 'guardian-new'");
  await assert.rejects(relationships.replace(manager, {
    ...base, guardians: [{ userId: peer.userId, history: 'all' }],
  }), errorCode('PARTICIPANT_UNAVAILABLE'));
  assert.equal((await database.query('SELECT * FROM cb_relationship_requests')).rows.length, 0);
});

test('failure writing relationship audit rolls back assignments, read cursors and both revisions; retry succeeds once', async () => {
  await send(therapist, 'message-0001');
  const message = await send(therapist, 'message-0002');
  await database.query("UPDATE cb_participants SET first_sequence = 2 WHERE user_id = 'guardian-a'");
  await conversations.markRead(guardian, { conversationId: 'room-a', messageId: message.id });
  const initial = await get();
  const beforePage = await list(guardian);
  const input = await command({
    pastHistoryConfirmed: true,
    therapist: { userId: replacement.userId, history: 'all' },
    guardians: [{ userId: guardian.userId, history: 'all' }],
  });
  await database.exec(`CREATE FUNCTION cb_test_relationship_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected relationship audit failure'; END; $$;
    CREATE TRIGGER cb_test_relationship_failure BEFORE INSERT ON cb_relationship_changes
    FOR EACH ROW EXECUTE FUNCTION cb_test_relationship_failure();`);
  try {
    await assert.rejects(relationships.replace(manager, input), /injected relationship audit failure/);
    assert.deepEqual(await get(), initial);
    assert.deepEqual(await list(guardian), beforePage);
    assert.equal((await database.query('SELECT * FROM cb_relationship_requests')).rows.length, 0);
  } finally {
    await database.exec('DROP TRIGGER cb_test_relationship_failure ON cb_relationship_changes; DROP FUNCTION cb_test_relationship_failure();');
  }
  assert.equal((await relationships.replace(manager, input)).replayed, false);
  assert.equal((await relationships.replace(manager, input)).replayed, true);
  assert.equal((await list(guardian)).lastRead, 0);
  assert.equal((await list(guardian)).unread, 2);
  assert.equal((await database.query('SELECT * FROM cb_relationship_changes')).rows.length, 3);
});

test('new and expanded past access requires a separate confirmation while an old receipt never reapplies access', async () => {
  await send(therapist, 'history-news-0001');
  const before = await get();
  const input = await command({ guardians: [
    { userId: guardian.userId, history: 'preserve' }, { userId: peer.userId, history: 'all' },
  ] });
  for (const pastHistoryConfirmed of [undefined, false]) {
    await assert.rejects(relationships.replace(manager, { ...input, pastHistoryConfirmed }), errorCode('PAST_HISTORY_CONFIRMATION_REQUIRED'));
    assert.deepEqual(await get(), before);
    assert.equal((await database.query('SELECT * FROM cb_relationship_requests')).rows.length, 0);
  }
  await assert.rejects(relationships.replace(manager, { ...input, pastHistoryConfirmed: 'true' }), errorCode('INVALID_INPUT'));
  await relationships.replace(manager, { ...input, pastHistoryConfirmed: true });
  await relationships.replace(manager, await command({ clientId: 'history-disconnect-01', guardians: [] }));
  const disconnected = await get();
  assert.equal((await relationships.replace(manager, input)).replayed, true);
  assert.deepEqual(await get(), disconnected);
  await assert.rejects(list(peer), errorCode('NOT_FOUND'));
});

test('upgrading the previous schema preserves messages and existing grants without reapplying earlier migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-migration-test-'));
  const legacy = await PGlite.create();
  try {
    const names = ['001-conversations.sql', '002-authentication.sql', '003-invitations.sql'];
    for (const name of names)
      await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
    await migrate(legacy, pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('legacy-center');
      INSERT INTO cb_users VALUES ('legacy-therapist',true), ('legacy-guardian',true);
      INSERT INTO cb_memberships VALUES ('legacy-center','legacy-therapist','therapist',true),
        ('legacy-center','legacy-guardian','guardian',true);
      INSERT INTO cb_children VALUES ('legacy-center','legacy-child');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('legacy-center','legacy-room','legacy-child');
      INSERT INTO cb_participants VALUES ('legacy-center','legacy-room','legacy-therapist','therapist',true,1),
        ('legacy-center','legacy-room','legacy-guardian','guardian',true,1);`);
    // Prepare a historical-schema fixture without invoking the current service
    // against tables it cannot yet use. Compare original stored fields exactly.
    await legacy.exec(`UPDATE cb_conversations SET last_sequence = 1, revision = revision + 1;
      INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
      VALUES ('legacy-center','legacy-room','legacy-message',1,'legacy-therapist','legacy-0001',repeat('0',64),'text','기존 가상 소식');`);
    const actor = { centerId: 'legacy-center', userId: 'legacy-therapist' };
    const beforeUpgrade = (await legacy.query('SELECT * FROM cb_messages')).rows;
    const oldRoom = (await legacy.query('SELECT * FROM cb_conversations')).rows[0];
    const oldGrants = (await legacy.query('SELECT * FROM cb_participants ORDER BY user_id')).rows;
    assert.deepEqual(await migrate(legacy), ['004-relationships.sql', '005-records.sql', '006-activity-feedback.sql', '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql', '010-profiles.sql', '011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_messages')).rows,
      beforeUpgrade.map((row) => ({ ...row, feedback_id: null, reply_feedback_id: null, reply_feedback_revision: null, attachments_sealed:true })));
    assert.deepEqual((await legacy.query('SELECT * FROM cb_conversations')).rows[0], { ...oldRoom, relationships_version: 0 });
    assert.deepEqual((await legacy.query('SELECT * FROM cb_participants ORDER BY user_id')).rows,
      oldGrants.map(row => ({ ...row, communication_generation: 0 })));
    const service = new Conversations(legacy);
    assert.equal((await service.get(actor, { conversationId: 'legacy-room', messageId: 'legacy-message' })).body, '기존 가상 소식');
    assert.deepEqual(await migrate(legacy), []);
    assert.equal(Number((await legacy.query('SELECT relationships_version FROM cb_conversations')).rows[0].relationships_version), 0);
  } finally {
    await legacy.close();
    // directory is created above by mkdtemp, never a user-supplied path.
    await rm(directory, { recursive: true, force: true });
  }
});

test('database constraints keep one therapist and prevent audit cross-room/tenant references', async () => {
  await assert.rejects(database.query(`INSERT INTO cb_participants
    (center_id,conversation_id,user_id,role,active,first_sequence)
    VALUES ('center-a','room-a','therapist-new','therapist',true,1)`), { code: '23505' });
  await relationships.replace(manager, await command({ guardians: [] }));
  await assert.rejects(database.query(`UPDATE cb_relationship_changes
    SET conversation_id = 'room-other'`), { code: '23503' });
  await assert.rejects(database.query(`UPDATE cb_relationship_changes
    SET next_first_sequence = 0`), { code: '23514' });
});
