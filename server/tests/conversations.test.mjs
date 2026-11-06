import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Conversations } from '../conversations.mjs';
import { migrate } from '../migrate.mjs';
import { RepositoryError } from '../errors.mjs';

// Only in-memory PostgreSQL with invented IDs. Never accept a DATABASE_URL in
// this suite: resets must not be able to touch a user's database.
let database, repository;
const therapist = { userId: 'therapist-a', centerId: 'center-a' };
const guardian = { userId: 'guardian-a', centerId: 'center-a' };
const peerGuardian = { userId: 'guardian-peer', centerId: 'center-a' };
const manager = { userId: 'manager-a', centerId: 'center-a' };
const input = (extra = {}) => ({ conversationId: 'room-a', clientId: 'send-0001', body: '가상 대화 테스트', ...extra });
const snapshot = (extra = {}) => ({ conversationId: 'room-a', clientId: 'share-0001', recordId: 'record-a', title: '가상 활동', summary: '공유할 가상 요약', ...extra });
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const get = (actor, message) => repository.get(actor, { conversationId: 'room-a', messageId: message.id });
const list = (actor, extra = {}) => repository.list(actor, { conversationId: 'room-a', ...extra });

before(async () => {
  database = await PGlite.create();
  assert.deepEqual(await migrate(database), [
    '001-conversations.sql', '002-authentication.sql', '003-invitations.sql', '004-relationships.sql',
    '005-records.sql', '006-activity-feedback.sql', '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql', '010-profiles.sql', '011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql',
  ]);
});
after(async () => { await database?.close(); });
beforeEach(async () => {
  await database.transaction(async (tx) => {
    await tx.exec(`TRUNCATE cb_centers, cb_users RESTART IDENTITY CASCADE;
      INSERT INTO cb_centers VALUES ('center-a'), ('center-b');
      INSERT INTO cb_users(id, active) VALUES
        ('therapist-a', true), ('guardian-a', true), ('guardian-peer', true),
        ('manager-a', true), ('unassigned-a', true), ('therapist-b', true), ('guardian-b', true);
      INSERT INTO cb_memberships(center_id, user_id, role, active) VALUES
        ('center-a','therapist-a','therapist',true), ('center-a','guardian-a','guardian',true),
        ('center-a','guardian-peer','guardian',true), ('center-a','manager-a','center',true),
        ('center-a','unassigned-a','therapist',true),
        ('center-b','therapist-b','therapist',true), ('center-b','guardian-b','guardian',true);
      INSERT INTO cb_children VALUES ('center-a','child-a'), ('center-a','child-other'), ('center-b','child-b');
      INSERT INTO cb_conversations(center_id, id, child_id) VALUES
        ('center-a','room-a','child-a'), ('center-a','room-other','child-other'), ('center-b','room-b','child-b');
      INSERT INTO cb_participants(center_id, conversation_id, user_id, role, active, first_sequence) VALUES
        ('center-a','room-a','therapist-a','therapist',true,1), ('center-a','room-a','guardian-a','guardian',true,1),
        ('center-a','room-a','guardian-peer','guardian',true,1),
        ('center-a','room-other','therapist-a','therapist',true,1), ('center-a','room-other','guardian-a','guardian',true,1),
        ('center-b','room-b','therapist-b','therapist',true,1), ('center-b','room-b','guardian-b','guardian',true,1);`);
  });
  repository = new Conversations(database);
});

test('migration re-runs preserve data and reject modified migration history', async () => {
  const sent = await repository.sendText(guardian, input());
  assert.deepEqual(await migrate(database), []);
  assert.equal((await get(therapist, sent)).body, input().body);
  const { rows: original } = await database.query('SELECT name, checksum FROM cb_schema_migrations');
  try {
    await database.query("UPDATE cb_schema_migrations SET checksum = 'changed'");
    await assert.rejects(migrate(database), /history does not match/);
  } finally {
    for (const row of original)
      await database.query('UPDATE cb_schema_migrations SET checksum = $1 WHERE name = $2', [row.checksum, row.name]);
  }
});

test('inbox returns authorized empty rooms, but never center, inactive or foreign membership data', async () => {
  const initial = await repository.inbox(therapist);
  assert.deepEqual(initial.rooms.map((r) => [r.conversationId, r.childId, r.targetId, r.latest, r.unread]),
    [['room-a', 'child-a', null, null, 0], ['room-other', 'child-other', null, null, 0]]);
  assert.equal(initial.hasMore, false);
  assert.equal(initial.resetRequired, false);
  assert.deepEqual((await repository.inbox({ ...therapist, userId: 'unassigned-a' })).rooms, []);
  for (const actor of [manager, { ...guardian, centerId: 'center-b' }, { ...guardian, userId: 'missing' }])
    await assert.rejects(repository.inbox({ ...actor, role: 'therapist' }), errorCode('NOT_FOUND'));
  for (const table of ['cb_users', 'cb_memberships', 'cb_participants']) {
    const key = table === 'cb_users' ? 'id' : 'user_id';
    await database.query(`UPDATE ${table} SET active=false WHERE ${key}=$1`, [guardian.userId]);
    if (table === 'cb_participants') assert.deepEqual((await repository.inbox(guardian)).rooms, []);
    else await assert.rejects(repository.inbox(guardian), errorCode('NOT_FOUND'));
    await database.query(`UPDATE ${table} SET active=true WHERE ${key}=$1`, [guardian.userId]);
  }
});

test('inbox sorts by cross-room creation time, not each room sequence, and keeps preview/target identical', async () => {
  for (let n = 0; n < 3; n++)
    await repository.sendText(guardian, input({ clientId: `inbox-old-${n}` }));
  const latest = await repository.sendText(guardian, input({ conversationId: 'room-other', clientId: 'inbox-new-1', body: '새 방의 첫 소식' }));
  const page = await repository.inbox(therapist);
  assert.deepEqual(page.rooms.map((r) => r.conversationId), ['room-other', 'room-a']);
  assert.equal(page.rooms[0].latest.sequence, 1);
  assert.equal(page.rooms[1].latest.sequence, 3);
  assert.equal(page.rooms[0].targetId, latest.id);
  const direct = await repository.get(therapist, { conversationId: page.rooms[0].conversationId, messageId: page.rooms[0].targetId });
  assert.equal(page.rooms[0].latest.body, direct.body);
  assert.equal(page.rooms[0].childId, direct.childId);
  await repository.markRead(therapist, { conversationId: 'room-other', messageId: latest.id });
  assert.deepEqual((await repository.inbox(therapist)).rooms.map((r) => r.conversationId), ['room-a', 'room-other']);
});

test('inbox latest own send does not replace the preview target with an earlier unread message', async () => {
  await repository.sendText(guardian, input());
  const own = await repository.sendText(therapist, input({ clientId: 'inbox-own-1', body: '공개 답변' }));
  const before = await database.query('SELECT * FROM cb_read_states ORDER BY user_id');
  const inbox = await repository.inbox(therapist);
  const room = inbox.rooms[0];
  assert.equal(room.latest.id, own.id);
  assert.equal(room.targetId, own.id);
  assert.equal(room.unread, 1);
  assert.equal(room.lastRead, 0);
  assert.deepEqual((await database.query('SELECT * FROM cb_read_states ORDER BY user_id')).rows, before.rows);
  assert.equal((await database.query('SELECT * FROM cb_message_reviews')).rows.length, 0);
  assert.equal((await repository.inbox(peerGuardian)).rooms[0].unread, 2);
});

test('inbox uses current edit/hide/delete projections without leaking message history or private review', async () => {
  const first = await repository.sendText(guardian, input({ body: '원래 소식' }));
  await repository.review(therapist, { conversationId: 'room-a', messageId: first.id, note: 'PRIVATE-ONLY-FIXTURE' });
  const before = await repository.inbox(therapist);
  await repository.editText(guardian, { conversationId: 'room-a', messageId: first.id, clientId: 'inbox-edit-1', expectedRevision: 1, body: '고친 소식' });
  const edited = (await repository.inbox(therapist)).rooms[0];
  assert.equal(edited.latest.body, '고친 소식');
  assert.equal(edited.latest.edited, true);
  assert.equal(edited.targetId, first.id);
  assert.equal(edited.unread, 1);
  assert.equal(JSON.stringify(edited).includes('PRIVATE-'), false);
  assert.equal(JSON.stringify(edited).includes('원래 소식'), false);
  assert.deepEqual(Object.keys(edited.latest).sort(), ['authorId','body','createdAt','deleted','edited','hidden','id','sequence','type'].sort());
  assert.equal((await repository.inbox(therapist, { expectedSnapshot: before.snapshot })).resetRequired, true);
  await repository.deleteText(guardian, { conversationId: 'room-a', messageId: first.id, clientId: 'inbox-delete-1', expectedRevision: 2, scope: 'all', confirmed: true });
  const deleted = (await repository.inbox(therapist)).rooms.find((r) => r.conversationId === 'room-a');
  assert.equal(deleted.latest.body, '삭제된 소식입니다.');
  assert.equal(deleted.latest.authorId, null);
  assert.equal(deleted.latest.hidden, true);
  assert.equal(deleted.unread, 0);
  assert.equal(deleted.targetId, first.id);
  await repository.deleteText(therapist, { conversationId: 'room-a', messageId: first.id, clientId: 'inbox-hide-1', scope: 'self', confirmed: true });
  const hidden = (await repository.inbox(therapist)).rooms.find((r) => r.conversationId === 'room-a');
  assert.equal(hidden.latest, null);
  assert.equal(hidden.targetId, null);
  assert.equal((await repository.inbox(peerGuardian)).rooms[0].latest.id, first.id);
});

test('inbox hides withdrawn publication content for guardians and never includes its detailed summary', async () => {
  const card = await repository.publishSnapshot(therapist, snapshot({ summary: 'SUMMARY-NOT-FOR-HOME' }));
  const visible = await repository.inbox(guardian);
  assert.equal(visible.rooms[0].latest.body, card.body);
  assert.equal(JSON.stringify(visible).includes('SUMMARY-NOT-FOR-HOME'), false);
  await repository.withdraw(therapist, { conversationId: 'room-a', messageId: card.id });
  const withdrawn = await repository.inbox(guardian);
  assert.equal(withdrawn.rooms[0].latest.body, '공유가 종료된 기록입니다.');
  assert.equal(withdrawn.rooms[0].latest.hidden, true);
  assert.equal(JSON.stringify(withdrawn).includes(card.body), false);
  assert.equal((await repository.inbox(therapist)).rooms[0].latest.body, card.body);
});

test('inbox history restriction removes older previews and invalidates previous page tokens', async () => {
  const first = await repository.sendText(therapist, input());
  const original = await repository.inbox(guardian, { limit: 1 });
  await database.query(`UPDATE cb_participants SET first_sequence=2 WHERE center_id='center-a' AND conversation_id='room-a' AND user_id='guardian-a'`);
  const changed = await repository.inbox(guardian, { limit: 1, offset: 1, expectedSnapshot: original.snapshot });
  assert.equal(changed.resetRequired, true);
  assert.equal('rooms' in changed, false);
  const blank = (await repository.inbox(guardian)).rooms.find((r) => r.conversationId === 'room-a');
  assert.equal(blank.latest, null);
  assert.equal(blank.unread, 0);
  assert.equal(JSON.stringify(blank).includes(first.id), false);
  const next = await repository.sendText(therapist, input({ clientId: 'inbox-after-1' }));
  assert.equal((await repository.inbox(guardian)).rooms[0].targetId, next.id);
});

test('inbox bounded paging is stable for unchanged data and resets after reads or identity changes', async () => {
  const first = await repository.sendText(therapist, input());
  const page = await repository.inbox(guardian, { limit: 1 });
  assert.equal(page.rooms.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 1);
  const second = await repository.inbox(guardian, { limit: 1, offset: page.nextOffset, expectedSnapshot: page.snapshot });
  assert.equal(second.hasMore, false);
  assert.equal(second.rooms[0].conversationId, 'room-other');
  const exhausted = await repository.inbox(guardian, { offset: second.nextOffset, expectedSnapshot: page.snapshot });
  assert.deepEqual(exhausted.rooms, []);
  assert.equal((await repository.inbox(peerGuardian, { expectedSnapshot: page.snapshot })).resetRequired, true);
  await repository.markRead(guardian, { conversationId: 'room-a', messageId: first.id });
  const stale = await repository.inbox(guardian, { offset: 1, expectedSnapshot: page.snapshot });
  assert.equal(stale.resetRequired, true);
  assert.deepEqual(Object.keys(stale).sort(), ['resetRequired', 'snapshot']);
});

test('inbox rejects invalid paging or caller filters before querying and propagates storage failures', async () => {
  let calls = 0;
  const guarded = new Conversations({ transaction() { calls++; throw new Error('synthetic database failure'); } });
  for (const options of [null, [], { role: 'therapist' }, { centerId: 'center-b' }, { limit: 0 },
    { limit: 101 }, { limit: '1' }, { offset: -1 }, { offset: 0.1 }, { offset: 1 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { expectedSnapshot: '' }, { expectedSnapshot: 'x'.repeat(32) }])
    await assert.rejects(guarded.inbox(guardian, options), errorCode('INVALID_INPUT'));
  await assert.rejects(guarded.inbox({ userId: 'bad id', centerId: 'center-a' }), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
  await assert.rejects(guarded.inbox(guardian), /synthetic database failure/);
  assert.equal(calls, 1);
});

test('inbox previews have a Unicode-safe size bound and never serialize a quoted prior message', async () => {
  const original = await repository.sendText(therapist, input({ body: 'QUOTE-NOT-FOR-HOME' }));
  const reply = await repository.sendText(guardian, input({ clientId: 'inbox-unicode-1', body: '🌱'.repeat(130), replyTo: original.id }));
  const page = await repository.inbox(therapist);
  assert.equal(page.rooms[0].latest.body, '🌱'.repeat(120));
  assert.equal(page.rooms[0].targetId, reply.id);
  assert.equal(page.rooms[0].latest.body.isWellFormed(), true);
  assert.equal(JSON.stringify(page).includes('QUOTE-NOT-FOR-HOME'), false);
});

test('two repository clients retrieve committed messages and reconnect by cursor', async () => {
  const clientB = new Conversations(database);
  const first = await repository.sendText(guardian, input());
  const reply = await clientB.sendText(therapist, input({ clientId: 'reply-0001', body: '답변', replyTo: first.id }));
  const page = await list(guardian, { limit: 1 });
  assert.equal(page.messages[0].id, first.id);
  assert.equal(page.hasMore, true);
  const next = await new Conversations(database).list(guardian, {
    conversationId: 'room-a', after: page.nextCursor, expectedRevision: page.revision,
  });
  assert.deepEqual(next.messages.map((m) => m.id), [reply.id]);
  assert.equal(next.messages[0].quote.body, first.body);
  assert.equal(next.hasMore, false);
});

test('same client ID retries produce one message and one audit event', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => repository.sendText(guardian, input())));
  assert.equal(new Set(results.map((m) => m.id)).size, 1);
  assert.deepEqual((await list(therapist)).messages.map((m) => m.sequence), [1]);
  const { rows } = await database.query('SELECT action FROM cb_audit_events');
  assert.deepEqual(rows, [{ action: 'message.sent' }]);
  await assert.rejects(repository.sendText(guardian, input({ body: '바꾼 내용' })), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.sendText(guardian, input({ conversationId: 'room-other' })), errorCode('IDEMPOTENCY_CONFLICT'));
});

test('room membership and database role determine access, not caller role fields', async () => {
  const sent = await repository.sendText(guardian, input());
  for (const actor of [manager, { userId: 'unassigned-a', centerId: 'center-a' },
    { userId: 'therapist-b', centerId: 'center-b' }, { userId: 'therapist-b', centerId: 'center-a' }]) {
    await assert.rejects(list({ ...actor, role: 'therapist' }), errorCode('NOT_FOUND'));
    await assert.rejects(repository.sendText(actor, input()), errorCode('NOT_FOUND'));
    await assert.rejects(get(actor, sent), errorCode('NOT_FOUND'));
  }
  await assert.rejects(repository.review({ ...guardian, role: 'therapist' }, {
    conversationId: 'room-a', messageId: sent.id, note: 'forged role',
  }), errorCode('FORBIDDEN'));
});

test('disabled account, center relationship, or child relationship blocks every fresh operation', async () => {
  const sent = await repository.sendText(guardian, input());
  for (const table of ['cb_users', 'cb_memberships', 'cb_participants']) {
    const key = table === 'cb_users' ? 'id' : 'user_id';
    // Table/column names are fixed test constants, never application input.
    await database.query(`UPDATE ${table} SET active = false WHERE ${key} = $1`, [guardian.userId]);
    await assert.rejects(list(guardian), errorCode('NOT_FOUND'));
    await assert.rejects(get(guardian, sent), errorCode('NOT_FOUND'));
    await assert.rejects(repository.sendText(guardian, input()), errorCode('NOT_FOUND'));
    await assert.rejects(repository.markRead(guardian, { conversationId: 'room-a', messageId: sent.id }), errorCode('NOT_FOUND'));
    await database.query(`UPDATE ${table} SET active = true WHERE ${key} = $1`, [guardian.userId]);
  }
});

test('read positions are per user, monotonic, exclude self sends, and do not create review notes', async () => {
  const first = await repository.sendText(therapist, input());
  const second = await repository.sendText(guardian, input({ clientId: 'send-0002' }));
  assert.equal((await list(guardian)).unread, 1);
  assert.equal((await list(peerGuardian)).unread, 2);
  assert.equal((await list(guardian)).lastRead, 0); // listing is not reading
  await repository.markRead(guardian, { conversationId: 'room-a', messageId: second.id });
  await repository.markRead(guardian, { conversationId: 'room-a', messageId: first.id });
  assert.equal((await list(guardian)).lastRead, 2);
  assert.equal((await list(guardian)).unread, 0);
  assert.equal((await list(peerGuardian)).lastRead, 0);
  assert.equal((await get(therapist, second)).reviewed, false);
  assert.equal((await database.query('SELECT * FROM cb_message_reviews')).rows.length, 0);
});

test('internal review stays absent from guardian and quoted-message projections', async () => {
  const first = await repository.sendText(guardian, input());
  await repository.review(therapist, { conversationId: 'room-a', messageId: first.id, note: 'INTERNAL-ONLY-FIXTURE' });
  await repository.sendText(therapist, input({ clientId: 'reply-0001', body: '공개 답변', replyTo: first.id }));
  assert.equal((await get(therapist, first)).reviewNote, 'INTERNAL-ONLY-FIXTURE');
  assert.equal(JSON.stringify(await list(guardian)).includes('INTERNAL-ONLY-FIXTURE'), false);
  assert.equal('reviewNote' in await get(guardian, first), false);
  assert.equal(JSON.stringify((await database.query('SELECT * FROM cb_audit_events')).rows).includes('INTERNAL-ONLY-FIXTURE'), false);
});

test('reshare creates immutable versions; old replies keep their original link', async () => {
  const first = await repository.publishSnapshot(therapist, snapshot());
  const reply = await repository.sendText(guardian, input({ replyTo: first.id }));
  const second = await repository.publishSnapshot(therapist, snapshot({ clientId: 'share-0002', summary: '새 공유 요약' }));
  assert.equal(second.publication.version, 2);
  assert.notEqual(first.publication.id, second.publication.id);
  assert.equal((await get(guardian, first)).hidden, true);
  assert.equal('publication' in await get(guardian, first), false);
  assert.equal((await get(guardian, reply)).quote.hidden, true);
  assert.equal((await get(guardian, reply)).quote.id, first.id);
  assert.equal((await get(therapist, first)).publication.summary, '공유할 가상 요약');
  // Retry is allowed after reshare without resurrecting the first version.
  assert.equal((await repository.publishSnapshot(therapist, snapshot())).id, first.id);
  assert.equal((await get(guardian, second)).hidden, undefined);
});

test('withdrawal invalidates paging, closes replies, preserves independent messages and successful retries', async () => {
  const card = await repository.publishSnapshot(therapist, snapshot());
  const sent = await repository.sendText(guardian, input({ replyTo: card.id }));
  const independent = await repository.sendText(guardian, input({ clientId: 'send-0002', body: '독립적인 소식' }));
  const page = await list(guardian);
  await repository.withdraw(therapist, { conversationId: 'room-a', messageId: card.id });
  const resync = await list(guardian, { after: page.nextCursor, expectedRevision: page.revision });
  assert.equal(resync.resetRequired, true);
  assert.equal('messages' in resync, false);
  const hidden = await get(guardian, card);
  assert.equal(hidden.canReply, false);
  assert.equal(hidden.hidden, true);
  assert.equal(JSON.stringify(hidden).includes('공유할 가상 요약'), false);
  await assert.rejects(repository.sendText(guardian, input({ clientId: 'send-0003', replyTo: card.id })), errorCode('PUBLICATION_CLOSED'));
  assert.equal((await repository.sendText(guardian, input({ replyTo: card.id }))).id, sent.id);
  assert.equal((await get(guardian, independent)).body, independent.body);
});

test('history grants apply to direct reads, replies, read positions, quotes and reshare', async () => {
  const card = await repository.publishSnapshot(therapist, snapshot());
  const second = await repository.sendText(guardian, input({ replyTo: card.id }));
  const beforeGrantChange = await list(peerGuardian);
  await database.query(`UPDATE cb_participants SET first_sequence = 2
    WHERE center_id = 'center-a' AND conversation_id = 'room-a' AND user_id = 'guardian-peer'`);
  assert.equal((await list(peerGuardian, { expectedRevision: beforeGrantChange.revision })).resetRequired, true);
  const visible = await list(peerGuardian);
  assert.deepEqual(visible.messages.map((m) => m.id), [second.id]);
  assert.equal(visible.messages[0].quote.hidden, true);
  assert.equal('authorId' in visible.messages[0].quote, false);
  assert.equal(JSON.stringify(visible).includes(card.body), false);
  await assert.rejects(get(peerGuardian, card), errorCode('NOT_FOUND'));
  await assert.rejects(repository.sendText(peerGuardian, input({ clientId: 'peer-0001', replyTo: card.id })), errorCode('NOT_FOUND'));
  await assert.rejects(repository.markRead(peerGuardian, { conversationId: 'room-a', messageId: card.id }), errorCode('NOT_FOUND'));
  await database.query(`UPDATE cb_participants SET first_sequence = 2
    WHERE center_id = 'center-a' AND conversation_id = 'room-a' AND user_id = 'therapist-a'`);
  await assert.rejects(repository.publishSnapshot(therapist, snapshot({ clientId: 'share-0002' })), errorCode('NOT_FOUND'));
});

test('cross-room reference and fabricated read target fail without changing state', async () => {
  const initialRevision = (await list(guardian)).revision;
  const outside = await repository.sendText(guardian, input({ conversationId: 'room-other' }));
  await assert.rejects(repository.sendText(guardian, input({ clientId: 'send-0002', replyTo: outside.id })), errorCode('NOT_FOUND'));
  await assert.rejects(repository.markRead(guardian, { conversationId: 'room-a', messageId: outside.id }), errorCode('NOT_FOUND'));
  await assert.rejects(get(guardian, outside), errorCode('NOT_FOUND'));
  assert.equal((await list(guardian)).messages.length, 0);
  assert.equal((await list(guardian)).revision, initialRevision);
});

test('database failure after insertion rolls back message, sequence, and audit; same ID can retry', async () => {
  const initialRevision = (await list(guardian)).revision;
  await database.exec(`CREATE FUNCTION cb_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected test failure'; END; $$;
    CREATE TRIGGER cb_test_audit_failure BEFORE INSERT ON cb_audit_events
    FOR EACH ROW EXECUTE FUNCTION cb_test_audit_failure();`);
  try {
    await assert.rejects(repository.sendText(guardian, input()), /injected test failure/);
    assert.equal((await list(guardian)).messages.length, 0);
    assert.equal((await list(guardian)).revision, initialRevision);
  } finally {
    await database.exec('DROP TRIGGER cb_test_audit_failure ON cb_audit_events; DROP FUNCTION cb_test_audit_failure();');
  }
  const retried = await repository.sendText(guardian, input());
  assert.equal(retried.sequence, 1);
});

test('failed reshare preserves previously current publication', async () => {
  const card = await repository.publishSnapshot(therapist, snapshot());
  await database.exec(`CREATE FUNCTION cb_test_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected reshare failure'; END; $$;
    CREATE TRIGGER cb_test_publication_failure BEFORE INSERT ON cb_publications
    FOR EACH ROW EXECUTE FUNCTION cb_test_publication_failure();`);
  try {
    await assert.rejects(repository.publishSnapshot(therapist, snapshot({ clientId: 'share-0002' })), /injected reshare failure/);
    assert.equal((await get(guardian, card)).canReply, true);
  } finally {
    await database.exec('DROP TRIGGER cb_test_publication_failure ON cb_publications; DROP FUNCTION cb_test_publication_failure();');
  }
});

test('database constraints prevent cross-tenant relations, center chat roles and mutable snapshots', async () => {
  await assert.rejects(database.query(`INSERT INTO cb_participants
    (center_id, conversation_id, user_id, role, active, first_sequence)
    VALUES ('center-a','room-a','guardian-b','guardian',true,1)`), { code: '23503' });
  await assert.rejects(database.query(`INSERT INTO cb_participants
    (center_id, conversation_id, user_id, role, active, first_sequence)
    VALUES ('center-a','room-a','manager-a','center',true,1)`), { code: '23514' });
  const card = await repository.publishSnapshot(therapist, snapshot());
  await assert.rejects(database.query('UPDATE cb_publications SET summary = $1', ['edited']), { code: '23514' });
  await repository.withdraw(therapist, { conversationId: 'room-a', messageId: card.id });
  await assert.rejects(database.query('UPDATE cb_publications SET revoked_at = NULL'), { code: '23514' });
});

test('strict input bounds reject invalid attachment IDs and private fields, while SQL text stays literal', async () => {
  for (const override of [{ body: '' }, { body: 'a'.repeat(2001) }, { body: {} }, { clientId: '../bad' },
    { attachments: [{ id:'not-a-server-upload' }] }, { role: 'therapist' }])
    await assert.rejects(repository.sendText(guardian, input(override)), errorCode('INVALID_INPUT'));
  await assert.rejects(repository.publishSnapshot(therapist, snapshot({ privateNote: 'hidden' })), errorCode('INVALID_INPUT'));
  await assert.rejects(list(guardian, { limit: 101 }), errorCode('INVALID_INPUT'));
  await assert.rejects(list(guardian, { after: -1 }), errorCode('INVALID_INPUT'));
  const sent = await repository.sendText(guardian, input({ body: "'); DROP TABLE cb_messages; --" }));
  assert.equal((await get(therapist, sent)).body, sent.body);
});

test('sharing requires a currently active guardian; guardian cannot publish or withdraw', async () => {
  await assert.rejects(repository.publishSnapshot(guardian, snapshot()), errorCode('FORBIDDEN'));
  const card = await repository.publishSnapshot(therapist, snapshot());
  await assert.rejects(repository.withdraw(guardian, { conversationId: 'room-a', messageId: card.id }), errorCode('FORBIDDEN'));
  await database.query("UPDATE cb_participants SET active = false WHERE role = 'guardian'");
  await assert.rejects(repository.publishSnapshot(therapist, snapshot({ clientId: 'share-0002' })), errorCode('NO_RECIPIENT'));
});
