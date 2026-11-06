import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { Records } from '../records.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';

let database, feedback, records, conversations, relationships;
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const otherGuardian = { centerId: 'center-a', userId: 'guardian-other' };
const newcomer = { centerId: 'center-a', userId: 'guardian-new' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const replacement = { centerId: 'center-a', userId: 'therapist-new' };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const activity = { title: '가상 활동', instruction: '가족과 가상 놀이', frequency: '편한 시간', caution: '' };
const recordContent = (extra = {}) => ({ date: '2026-10-01', goalId: 'goal-a', performed: '가상 관찰',
  summary: '공개 요약', privateNote: 'PRIVATE-CLINICAL-FIXTURE', activity, ...extra });
const data = (extra = {}) => ({ date: '2026-10-01', result: 'partial', reaction: '처음 남긴 가상 반응', difficulty: '처음 남긴 어려움', ...extra });
const saveInput = (source, extra = {}) => ({ conversationId: 'room-a', feedbackId: 'feedback-a', sourceMessageId: source,
  clientId: 'feedback-save-0001', expectedRevision: 0, content: data(), ...extra });
const reviewInput = (extra = {}) => ({ conversationId: 'room-a', feedbackId: 'feedback-a', clientId: 'feedback-review-0001',
  expectedRevision: 1, expectedReviewVersion: 0, note: 'PRIVATE-REVIEW-FIXTURE', ...extra });
const get = (actor = therapist, extra = {}) => feedback.get(actor, { conversationId: 'room-a', feedbackId: 'feedback-a', ...extra });
const list = (actor = therapist, extra = {}) => conversations.list(actor, { conversationId: 'room-a', ...extra });
const reply = (messageId, extra = {}) => conversations.sendText(therapist, { conversationId: 'room-a',
  clientId: 'public-reply-0001', body: '보호자에게 보내는 공개 답변', replyTo: messageId, expectedReplyRevision: 1, ...extra });
async function publish(recordId = 'record-a', request = 'record-publish-0001') {
  const preview = await records.preview(therapist, { conversationId: 'room-a', recordId });
  return records.publish(therapist, { conversationId: 'room-a', recordId, clientId: request,
    expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds });
}
async function share(extra = {}) {
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: 'record-save-0001',
    expectedRevision: 0, content: recordContent(extra) });
  return (await publish()).messageId;
}
async function relation(extra = {}) {
  const state = await relationships.get(manager, { conversationId: 'room-a' });
  return relationships.replace(manager, { conversationId: 'room-a', clientId: 'relation-0001', expectedVersion: state.version,
    historyConfirmed: true, therapist: { userId: therapist.userId, history: 'preserve' },
    guardians: [{ userId: guardian.userId, history: 'preserve' }, { userId: otherGuardian.userId, history: 'preserve' }], ...extra });
}

before(async () => { database = await PGlite.create(); await migrate(database); });
after(async () => { await database?.close(); });
beforeEach(async () => {
  // All names/content are invented; reset only this in-memory test database.
  await database.exec(`TRUNCATE cb_centers, cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('guardian-other',true),
      ('guardian-new',true),('manager-a',true),('therapist-new',true),('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','guardian-other','guardian',true),('center-a','guardian-new','guardian',true),
      ('center-a','manager-a','center',true),('center-a','therapist-new','therapist',true),('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','guardian-other','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-a','room-other','guardian-a','guardian',true,1),
      ('center-b','room-b','therapist-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
  feedback = new ActivityFeedback(database);
  records = new Records(database);
  conversations = new Conversations(database);
  relationships = new Relationships(database);
});

test('activity feedback completes share → response → private review/public reply → next record without leaking private fields', async () => {
  const source = await share();
  const saved = await feedback.save(guardian, saveInput(source));
  const card = await get();
  assert.equal(card.id, saved.messageId);
  assert.equal(card.type, 'feedback');
  assert.equal(card.feedback.result, 'partial');
  assert.equal(card.feedback.reviewed, false);
  assert.equal(card.feedback.reviewVersion, 0);
  assert.equal((await list()).unread, 1);
  await conversations.markRead(therapist, { conversationId: 'room-a', messageId: card.id });
  assert.equal((await get()).feedback.reviewed, false);
  await feedback.review(therapist, reviewInput());
  assert.equal((await get()).feedback.reviewNote, 'PRIVATE-REVIEW-FIXTURE');
  const publicReply = await reply(card.id);
  assert.equal(publicReply.quote.body, data().reaction);
  const guardianView = await list(guardian);
  assert.equal(guardianView.messages.find((m) => m.id === card.id).feedback.reviewed, true);
  assert.equal(JSON.stringify(guardianView).includes('PRIVATE-'), false);
  assert.equal('reviewVersion' in (await get(guardian)).feedback, false);

  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-next', clientId: 'record-next-0001',
    expectedRevision: 0, content: recordContent({ referenceMessageIds: [card.id, publicReply.id],
      referenceFeedbackRevisions: [{ messageId: card.id, revision: 1 }] }) });
  const next = await records.get(therapist, { conversationId: 'room-a', recordId: 'record-next' });
  assert.deepEqual(next.referenceSources, [{ messageId: card.id, feedbackId: 'feedback-a', feedbackRevision: 1, attachments: [] },
    { messageId: publicReply.id, messageRevision: 1, body: '보호자에게 보내는 공개 답변', attachments: [],
      changed: false, deleted: false, hidden: false }]);
  assert.equal(next.performed, '가상 관찰'); // No automatic clinical copying.
  await publish('record-next', 'record-next-share');
  assert.equal((await list(guardian)).messages.at(-1).type, 'publication');
  assert.deepEqual(await new ActivityFeedback(database).get(therapist, { conversationId: 'room-a', feedbackId: 'feedback-a' }), await get());
});

test('inbox feedback preview respects the source publication history boundary and current reaction only', async () => {
  const source = await share();
  const sourceCard = await conversations.get(therapist, { conversationId: 'room-a', messageId: source });
  await database.query(`UPDATE cb_participants SET first_sequence=$1
    WHERE center_id='center-a' AND conversation_id='room-a' AND user_id='guardian-other'`, [sourceCard.sequence + 1]);
  const saved = await feedback.save(guardian, saveInput(source));
  const visible = (await conversations.inbox(therapist)).rooms[0];
  assert.equal(visible.targetId, saved.messageId);
  assert.equal(visible.latest.type, 'feedback');
  assert.equal(visible.latest.body, data().reaction);
  assert.equal(visible.unread, 1);
  const hidden = (await conversations.inbox(otherGuardian)).rooms.find((room) => room.conversationId === 'room-a');
  assert.equal(hidden.latest, null);
  assert.equal(hidden.unread, 0);
  await feedback.review(therapist, reviewInput());
  const reviewed = await conversations.inbox(therapist);
  assert.equal(JSON.stringify(reviewed).includes('PRIVATE-'), false);
  assert.equal(JSON.stringify(reviewed).includes(data().difficulty), false);
  await feedback.save(guardian, saveInput(source, { clientId: 'feedback-inbox-edit', expectedRevision: 1,
    content: data({ reaction: '갱신된 가상 반응' }) }));
  const updated = await conversations.inbox(therapist);
  assert.equal(updated.rooms[0].targetId, saved.messageId);
  assert.equal(updated.rooms[0].latest.body, '갱신된 가상 반응');
  assert.notEqual(updated.snapshot, reviewed.snapshot);
  assert.equal((await conversations.inbox(otherGuardian)).rooms[0].latest, null);
});

test('editing keeps one card and original sequence, resets version-specific review but preserves read state, quotes and record references', async () => {
  const source = await share();
  const saved = await feedback.save(guardian, saveInput(source));
  await feedback.review(therapist, reviewInput());
  await conversations.markRead(therapist, { conversationId: 'room-a', messageId: saved.messageId });
  const oldReply = await reply(saved.messageId);
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-next', clientId: 'record-next-0001',
    expectedRevision: 0, content: recordContent({ referenceMessageIds: [saved.messageId],
      referenceFeedbackRevisions: [{ messageId: saved.messageId, revision: 1 }] }) });
  const before = await list();
  const oldCard = await get();
  await feedback.save(guardian, saveInput(source, { clientId: 'feedback-save-0002', expectedRevision: 1,
    content: data({ result: 'done', reaction: '수정한 가상 반응', difficulty: '' }) }));
  const after = await list();
  const card = await get();
  assert.equal(card.id, oldCard.id);
  assert.equal(card.sequence, oldCard.sequence);
  assert.equal(card.createdAt, oldCard.createdAt);
  assert.equal(card.feedback.revision, 2);
  assert.equal(card.feedback.reviewed, false);
  assert.equal('reviewNote' in card.feedback, false);
  assert.equal(after.messages.length, before.messages.length);
  assert.equal(after.lastRead, before.lastRead);
  assert.equal(after.unread, 0);
  assert.equal((await list(therapist, { expectedRevision: before.revision })).resetRequired, true);
  assert.deepEqual(await conversations.get(therapist, { conversationId: 'room-a', messageId: oldReply.id }), oldReply);
  const freshReply = await reply(saved.messageId, { clientId: 'public-reply-0002', expectedReplyRevision: 2 });
  assert.equal(freshReply.quote.feedbackRevision, 2);
  assert.equal(freshReply.quote.body, '수정한 가상 반응');
  assert.deepEqual(await get(therapist, { revision: 1 }), oldCard);
  const record = await records.get(therapist, { conversationId: 'room-a', recordId: 'record-next' });
  assert.equal(record.referenceSources[0].feedbackRevision, 1);
  await assert.rejects(get(guardian, { revision: 1 }), errorCode('FORBIDDEN'));
  await assert.rejects(feedback.review(therapist, reviewInput({ clientId: 'review-stale-0001' })), errorCode('FEEDBACK_CONFLICT'));
  await feedback.review(therapist, reviewInput({ clientId: 'review-new-0001', expectedRevision: 2 }));
  assert.equal((await get()).feedback.reviewed, true);
});

test('save and review retries return immutable receipts without duplicate cards or reverting later edits', async () => {
  const source = await share();
  const input = saveInput(source);
  const [a, b] = await Promise.all([feedback.save(guardian, input), feedback.save(guardian, input)]);
  assert.equal(a.messageId, b.messageId);
  assert.equal(b.replayed, true);
  const reviewed = await feedback.review(therapist, reviewInput());
  await feedback.review(therapist, reviewInput({ clientId: 'review-new-0002', expectedReviewVersion: 1, note: 'PRIVATE-UPDATED-NOTE' }));
  assert.deepEqual(await feedback.review(therapist, reviewInput()), { ...reviewed, replayed: true });
  assert.equal((await get()).feedback.reviewVersion, 2);
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM cb_feedback_reviews')).rows[0].count, 2);
  await assert.rejects(feedback.review(therapist, reviewInput({ clientId: 'review-stale-0002' })), errorCode('REVIEW_CONFLICT'));
  await feedback.save(guardian, saveInput(source, { clientId: 'feedback-save-0002', expectedRevision: 1, content: data({ reaction: '수정됨' }) }));
  assert.deepEqual(await feedback.save(guardian, input), { ...a, replayed: true });
  assert.equal((await get()).feedback.revision, 2);
  assert.equal((await list()).messages.filter((m) => m.type === 'feedback').length, 1);
  await assert.rejects(feedback.save(guardian, { ...input, content: data({ result: 'skipped' }) }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(feedback.save(guardian, { ...input, conversationId: 'room-other' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(feedback.review(therapist, reviewInput({ note: '변경된 요청' })), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(feedback.save(guardian, { ...input, clientId: 'feedback-stale-0001' }), errorCode('FEEDBACK_CONFLICT'));
});

test('a correction between reading and replying/referencing requires explicit reconfirmation instead of silently citing new content', async () => {
  const source = await share();
  const saved = await feedback.save(guardian, saveInput(source));
  const recordInput = { conversationId: 'room-a', recordId: 'record-next', clientId: 'next-record-0001', expectedRevision: 0,
    content: recordContent({ referenceMessageIds: [saved.messageId], referenceFeedbackRevisions: [{ messageId: saved.messageId, revision: 1 }] }) };
  await feedback.save(guardian, saveInput(source, { clientId: 'feedback-save-0002', expectedRevision: 1, content: data({ reaction: '뒤늦게 수정된 반응' }) }));
  const before = await list();
  await assert.rejects(reply(saved.messageId), errorCode('FEEDBACK_CONFLICT'));
  await assert.rejects(reply(saved.messageId, { expectedReplyRevision: undefined }), errorCode('INVALID_INPUT'));
  await assert.rejects(records.save(therapist, recordInput), errorCode('REFERENCE_CHANGED'));
  await assert.rejects(records.save(therapist, { ...recordInput, content: { ...recordInput.content, referenceFeedbackRevisions: [] } }), errorCode('INVALID_INPUT'));
  await assert.rejects(conversations.review(therapist, { conversationId: 'room-a', messageId: saved.messageId, note: '우회 검토' }), errorCode('INVALID_INPUT'));
  assert.deepEqual(await list(), before);
  assert.equal((await records.list(therapist, { conversationId: 'room-a' })).records.length, 1);
  await reply(saved.messageId, { expectedReplyRevision: 2 });
  await records.save(therapist, { ...recordInput, content: { ...recordInput.content,
    referenceFeedbackRevisions: [{ messageId: saved.messageId, revision: 2 }] } });
  assert.equal((await records.get(therapist, { conversationId: 'room-a', recordId: 'record-next' })).referenceSources[0].feedbackRevision, 2);
});

test('only current guardian author can edit; manager, unrelated/foreign actors and caller-supplied roles cannot bypass access', async () => {
  const source = await share();
  const input = saveInput(source);
  await feedback.save(guardian, input);
  await assert.rejects(feedback.save(otherGuardian, { ...input, expectedRevision: 1 }), errorCode('FORBIDDEN'));
  await assert.rejects(feedback.save({ ...therapist, role: 'guardian' }, input), errorCode('FORBIDDEN'));
  await assert.rejects(feedback.review({ ...guardian, role: 'therapist' }, reviewInput()), errorCode('FORBIDDEN'));
  for (const actor of [manager, newcomer, replacement, { centerId: 'center-b', userId: 'therapist-b' }]) {
    await assert.rejects(get(actor), errorCode('NOT_FOUND'));
    await assert.rejects(feedback.save(actor, input), errorCode('NOT_FOUND'));
    await assert.rejects(feedback.review(actor, reviewInput()), errorCode('NOT_FOUND'));
  }
  await assert.rejects(feedback.save(guardian, { ...input, conversationId: 'room-other', clientId: 'other-room-0001' }), errorCode('NOT_FOUND'));
  await relation({ guardians: [{ userId: otherGuardian.userId, history: 'preserve' }] });
  await assert.rejects(feedback.save(guardian, input), errorCode('NOT_FOUND')); // Even a successful retry.
  assert.equal((await get()).feedback.reaction, data().reaction);
});

test('inactive user or center membership blocks existing card reads, edits, reviews and receipts', async () => {
  const source = await share();
  const input = saveInput(source);
  await feedback.save(guardian, input);
  await feedback.review(therapist, reviewInput());
  await database.exec("UPDATE cb_users SET active = false WHERE id = 'guardian-a'; UPDATE cb_memberships SET active = false WHERE user_id = 'therapist-a';");
  await assert.rejects(get(guardian), errorCode('NOT_FOUND'));
  await assert.rejects(feedback.save(guardian, input), errorCode('NOT_FOUND'));
  await assert.rejects(get(), errorCode('NOT_FOUND'));
  await assert.rejects(feedback.review(therapist, reviewInput()), errorCode('NOT_FOUND'));
});

test('source activity must exist and remain shared; withdrawal hides card/quote content but retains independent replies and retry receipts', async () => {
  const source = await share({ activity: null });
  await assert.rejects(feedback.save(guardian, saveInput(source)), errorCode('NO_ACTIVITY'));
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: 'record-save-0002', expectedRevision: 1, content: recordContent() });
  const active = (await publish('record-a', 'record-publish-0002')).messageId;
  const input = saveInput(active);
  const saved = await feedback.save(guardian, input);
  await feedback.review(therapist, reviewInput());
  const message = await reply(saved.messageId);
  await conversations.withdraw(therapist, { conversationId: 'room-a', messageId: active });
  const hidden = await get(guardian);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.canReply, false);
  assert.equal('feedback' in hidden, false);
  const guardianReply = await conversations.get(guardian, { conversationId: 'room-a', messageId: message.id });
  assert.equal(guardianReply.body, message.body);
  assert.equal(guardianReply.quote.hidden, true);
  assert.equal(JSON.stringify(guardianReply).includes(data().reaction), false);
  assert.equal(JSON.stringify(await list(guardian)).includes('PRIVATE-'), false);
  assert.equal((await get()).feedback.reaction, data().reaction);
  assert.equal((await get()).feedback.reviewed, true);
  assert.equal((await feedback.save(guardian, input)).replayed, true);
  await assert.rejects(feedback.save(guardian, saveInput(active, { clientId: 'new-feedback-0001', expectedRevision: 1 })), errorCode('PUBLICATION_CLOSED'));
  await assert.rejects(reply(saved.messageId, { clientId: 'closed-reply-0001' }), errorCode('PUBLICATION_CLOSED'));
  assert.equal((await reply(saved.messageId)).id, message.id); // Successful old reply can retry.
});

test('resharing cannot reassign an old feedback to the new activity snapshot', async () => {
  const source = await share();
  await feedback.save(guardian, saveInput(source));
  const next = (await publish('record-a', 'record-publish-0002')).messageId;
  assert.equal((await get(guardian)).hidden, true);
  await assert.rejects(feedback.save(guardian, saveInput(next, { clientId: 'wrong-source-0001', expectedRevision: 1 })), errorCode('INVALID_INPUT'));
  await feedback.save(guardian, saveInput(next, { clientId: 'new-source-0001', feedbackId: 'feedback-next' }));
  const cards = (await list(guardian)).messages.filter((m) => m.type === 'feedback');
  assert.equal(cards.length, 2);
  assert.equal(cards.filter((m) => !m.hidden).length, 1);
});

test('from_now cannot expose earlier activity through newer feedback, quotes, reads, review or record references', async () => {
  const source = await share();
  await relation({ guardians: [{ userId: guardian.userId, history: 'preserve' }, { userId: newcomer.userId, history: 'from_now' }] });
  const saved = await feedback.save(guardian, saveInput(source));
  const message = await reply(saved.messageId);
  const view = await list(newcomer);
  assert.equal(view.messages.length, 1);
  assert.equal(view.unread, 1);
  assert.equal(view.messages[0].id, message.id);
  assert.equal(view.messages[0].quote.hidden, true);
  await assert.rejects(get(newcomer), errorCode('NOT_FOUND'));
  await assert.rejects(conversations.markRead(newcomer, { conversationId: 'room-a', messageId: saved.messageId }), errorCode('NOT_FOUND'));
  await assert.rejects(conversations.sendText(newcomer, { conversationId: 'room-a', clientId: 'new-quote-0001', body: '새 답변', replyTo: saved.messageId }), errorCode('NOT_FOUND'));
  await assert.rejects(feedback.save(newcomer, saveInput(source, { feedbackId: 'new-feedback', clientId: 'new-save-0001' })), errorCode('NOT_FOUND'));
  // Give the new therapist a boundary between the source and its feedback.
  await database.exec(`UPDATE cb_participants SET active = false WHERE conversation_id = 'room-a' AND user_id = 'therapist-a';
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-new','therapist',true,3);`);
  await assert.rejects(feedback.review(replacement, reviewInput()), errorCode('NOT_FOUND'));
  await assert.rejects(records.save(replacement, { conversationId: 'room-a', recordId: 'record-next', clientId: 'next-save-0001',
    expectedRevision: 0, content: recordContent({ referenceMessageIds: [saved.messageId] }) }), errorCode('NOT_FOUND'));
});

test('strict content validation rejects invalid dates, states, hidden fields, attachment IDs and coercible values without partial writes', async () => {
  const source = await share();
  for (const extra of [{ date: '2026-02-30' }, { date: '0000-01-01' }, { result: 'invented' }, { reaction: '' },
    { reaction: {} }, { reaction: 'x'.repeat(1001) }, { difficulty: false }, { difficulty: 'x'.repeat(1001) },
    { reviewed: true }, { reviewNote: 'hidden' }, { attachments: [{ id:'not-a-server-upload' }] }])
    await assert.rejects(feedback.save(guardian, saveInput(source, { content: data(extra) })), errorCode('INVALID_INPUT'));
  await assert.rejects(feedback.save(guardian, saveInput(source, { expectedRevision: -1 })), errorCode('INVALID_INPUT'));
  await assert.rejects(feedback.save(guardian, saveInput(source, { expectedRevision: 1.5 })), errorCode('INVALID_INPUT'));
  const sqlText = "'); DROP TABLE cb_users; --";
  await feedback.save(guardian, saveInput(source, { content: data({ reaction: sqlText, difficulty: '' }) }));
  assert.equal((await get()).feedback.reaction, sqlText);
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM cb_users')).rows[0].count, 7);
  for (const note of ['', {}, 'x'.repeat(2001)])
    await assert.rejects(feedback.review(therapist, reviewInput({ note })), errorCode('INVALID_INPUT'));
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM cb_feedback_revisions')).rows[0].count, 1);
});

test('receipt failure rolls back new card, edits, reviews, counters and audit; retry then succeeds exactly once', async () => {
  const source = await share();
  const first = saveInput(source);
  const commands = [
    () => feedback.save(guardian, first),
    () => feedback.save(guardian, saveInput(source, { clientId: 'feedback-save-0002', expectedRevision: 1, content: data({ reaction: '수정됨' }) })),
    () => feedback.review(therapist, reviewInput({ expectedRevision: 2 })),
  ];
  for (const command of commands) {
    const before = await list();
    const beforeCounters = (await database.query("SELECT last_sequence, revision FROM cb_conversations WHERE id = 'room-a'")).rows;
    const tables = ['cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests', 'cb_audit_events'];
    const counts = await Promise.all(tables.map(async (table) => (await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count));
    await database.exec(`CREATE FUNCTION cb_test_feedback_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected feedback receipt failure'; END; $$;
      CREATE TRIGGER cb_test_feedback_failure BEFORE INSERT ON cb_feedback_requests
      FOR EACH ROW EXECUTE FUNCTION cb_test_feedback_failure();`);
    try {
      await assert.rejects(command(), /injected feedback receipt failure/);
      assert.deepEqual(await list(), before);
      assert.deepEqual((await database.query("SELECT last_sequence, revision FROM cb_conversations WHERE id = 'room-a'")).rows, beforeCounters);
      for (const [i, table] of tables.entries()) assert.equal((await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count, counts[i]);
    } finally {
      await database.exec('DROP TRIGGER cb_test_feedback_failure ON cb_feedback_requests; DROP FUNCTION cb_test_feedback_failure();');
    }
    assert.equal((await command()).replayed, false);
    assert.equal((await command()).replayed, true);
  }
  assert.equal((await get()).feedback.revision, 2);
  assert.equal((await get()).feedback.reviewVersion, 1);
  assert.equal((await list()).messages.length, 2);
});

test('database protects immutable versions, one card per feedback, fixed source and explicit quote revision', async () => {
  const source = await share();
  const saved = await feedback.save(guardian, saveInput(source));
  await feedback.review(therapist, reviewInput());
  for (const sql of ["UPDATE cb_feedback_revisions SET reaction = 'overwritten'", 'DELETE FROM cb_feedback_revisions',
    "UPDATE cb_feedback_reviews SET note = 'overwritten'", 'DELETE FROM cb_feedback_reviews',
    "UPDATE cb_activity_feedback SET author_id = 'guardian-other'", 'UPDATE cb_activity_feedback SET current_revision = 1'])
    await assert.rejects(database.query(sql), { code: '23514' });
  await assert.rejects(database.query(`INSERT INTO cb_messages
    (center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,reply_to)
    VALUES ('center-a','room-a','unpinned',99,'therapist-a','unpinned-0001',repeat('0',64),'text','답변',$1)`, [saved.messageId]), { code: '23514' });
  await assert.rejects(database.query(`INSERT INTO cb_messages
    (center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,feedback_id)
    VALUES ('center-a','room-a','duplicate',99,'guardian-a','duplicate-0001',repeat('0',64),'feedback','feedback-a')`), { code: '23505' });
  const publicationId = (await get()).feedback.publicationId;
  await assert.rejects(database.transaction(async (tx) => {
    await tx.query(`INSERT INTO cb_activity_feedback VALUES ('center-a','room-a','orphan',$1,'guardian-a',1)`, [publicationId]);
    await tx.query(`INSERT INTO cb_feedback_revisions
      (center_id,conversation_id,feedback_id,revision,activity_date,result,reaction,difficulty)
      VALUES ('center-a','room-a','orphan',1,'2026-10-01','done','가상 반응','')`);
  }), { code: '23503' });
});

test('006 upgrades existing structured records and message links without rewriting original data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-feedback-migration-'));
  const legacy = await PGlite.create();
  try {
    for (const name of ['001-conversations.sql', '002-authentication.sql', '003-invitations.sql', '004-relationships.sql', '005-records.sql'])
      await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
    await migrate(legacy, pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('center-a'); INSERT INTO cb_users(id,active) VALUES ('therapist-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true);
      INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a');
      INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1);
      INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','기존 목표','active');
      BEGIN;
      INSERT INTO cb_records VALUES ('center-a','room-a','record-a','therapist-a',1,1,NULL);
      INSERT INTO cb_record_revisions(center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note)
        VALUES ('center-a','room-a','record-a',1,'therapist-a','goal-a','2026-10-01','saved','기존 제목','기존 관찰','','','','이전 내부 메모');
      UPDATE cb_record_revisions SET sealed = true;
      COMMIT;`);
    const before = (await legacy.query('SELECT * FROM cb_record_revisions')).rows;
    assert.deepEqual(await migrate(legacy), ['006-activity-feedback.sql', '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql', '010-profiles.sql', '011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_revisions')).rows,
      before.map((row) => ({ ...row, goal_revision: null, appointment_revision: null, draft_assessments: null })));
    assert.equal((await new Records(legacy).get(therapist, { conversationId: 'room-a', recordId: 'record-a' })).performed, '기존 관찰');
    assert.equal((await legacy.query('SELECT COUNT(*) AS count FROM cb_activity_feedback')).rows[0].count, 0);
    assert.deepEqual(await migrate(legacy), []);
  } finally {
    await legacy.close();
    // The only removed directory is this test's unique mkdtemp output.
    await rm(directory, { recursive: true, force: true });
  }
});
