import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { copyFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Records } from '../records.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';

let database, records, conversations, relationships;
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const replacement = { centerId: 'center-a', userId: 'therapist-new' };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const body = (extra = {}) => ({ date: '2026-10-01', goalId: 'goal-a', performed: '가상 놀이 선택', response: '선택한 놀이를 시작함',
  nextPlan: '같은 환경에서 관찰', summary: '공유용 가상 요약', privateNote: 'PRIVATE-NOTE-FIXTURE',
  assessments: [
    { tool: '직접 관찰', item: '참여 시간', value: 0, unit: '분', context: '같은 장소' },
    { tool: '별도 관찰', item: '시도 횟수', value: 2, unit: '회', context: '동일한 안내' },
  ], activity: { title: '가상 가정 활동', instruction: '가족과 선택한 놀이', frequency: '편한 시간', caution: '가상 자료' }, ...extra });
const saveInput = (extra = {}) => ({ conversationId: 'room-a', recordId: 'record-a', clientId: 'record-save-0001',
  expectedRevision: 0, content: body(), ...extra });
const get = (extra = {}) => records.get(therapist, { conversationId: 'room-a', recordId: 'record-a', ...extra });
const send = (extra = {}) => conversations.sendText(guardian, {
  conversationId: 'room-a', clientId: 'message-0001', body: '가정의 가상 소식', ...extra,
});
async function publishInput(extra = {}) {
  const preview = await records.preview(therapist, { conversationId: 'room-a', recordId: 'record-a' });
  return { conversationId: 'room-a', recordId: 'record-a', clientId: 'record-publish-0001',
    expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion,
    recipientIds: preview.recipientIds, ...extra };
}
const list = (actor = guardian) => conversations.list(actor, { conversationId: 'room-a' });
async function changeRelations(extra = {}) {
  const state = await relationships.get(manager, { conversationId: 'room-a' });
  return relationships.replace(manager, { conversationId: 'room-a', clientId: 'relationship-0001',
    expectedVersion: state.version, historyConfirmed: true,
    therapist: { userId: therapist.userId, history: 'preserve' },
    guardians: [{ userId: guardian.userId, history: 'preserve' }], ...extra });
}

before(async () => { database = await PGlite.create(); await migrate(database); });
after(async () => { await database?.close(); });
beforeEach(async () => {
  // All identities and observations are invented and the DB is memory-only.
  await database.exec(`TRUNCATE cb_centers, cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'), ('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true), ('guardian-a',true), ('manager-a',true),
      ('therapist-new',true), ('guardian-new',true), ('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true), ('center-a','manager-a','center',true),
      ('center-a','therapist-new','therapist',true), ('center-a','guardian-new','guardian',true),
      ('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'), ('center-a','child-other'), ('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('center-a','room-a','child-a'), ('center-a','room-other','child-other'), ('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),
      ('center-a','room-other','guardian-a','guardian',true,1),
      ('center-b','room-b','therapist-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES
      ('center-a','room-a','goal-a','가상 목표','active'), ('center-a','room-other','goal-other','다른 가상 목표','active');
    INSERT INTO cb_appointments VALUES ('center-a','room-a','appointment-a','2026-10-01','10:00',40,'가상 일정','가상 장소','scheduled'),
      ('center-a','room-other','appointment-other','2026-10-01','11:00',40,'다른 일정','가상 장소','scheduled');`);
  records = new Records(database);
  conversations = new Conversations(database);
  relationships = new Relationships(database);
});

test('structured records preserve context, reference links, zero measurements and immutable previous revisions', async () => {
  const message = await send();
  const first = saveInput({ content: body({ appointmentId: 'appointment-a', referenceMessageIds: [message.id],
    observation: { status: 'observed', task: '가상 과제', assistance: '언어 안내', repetitions: '0' } }) });
  const result = await records.save(therapist, first);
  assert.equal(result.revision, 1);
  const before = await get();
  assert.equal(before.assessments.length, 2);
  assert.equal(before.assessments[0].value, 0);
  assert.deepEqual(before.referenceMessageIds, [message.id]);
  assert.equal(before.appointmentId, 'appointment-a');
  assert.equal(before.observation.repetitions, '0');
  await records.save(therapist, { ...first, clientId: 'record-save-0002', expectedRevision: 1,
    content: { ...first.content, performed: '다음 관찰', assessments: [] } });
  assert.equal((await get()).performed, '다음 관찰');
  assert.deepEqual(await get({ revision: 1 }), before);
  assert.deepEqual(await new Records(database).get(therapist, { conversationId: 'room-a', recordId: 'record-a' }), await get());
  assert.equal((await records.list(therapist, { conversationId: 'room-a' })).records[0].revision, 2);
  assert.equal((await list()).messages.length, 1); // Saving never sends a message.
  await assert.rejects(database.query("UPDATE cb_record_revisions SET private_note = 'overwritten'"), { code: '23514' });
  await assert.rejects(database.query('DELETE FROM cb_record_assessments'), { code: '23514' });
});

test('empty drafts are allowed, completed empty records and incomplete/nonfinite measurements are rejected', async () => {
  const empty = { date: '2026-10-01', goalId: 'goal-a' };
  await records.save(therapist, saveInput({ content: { ...empty, status: 'draft', observation: { status: 'not-observed' } } }));
  assert.equal((await get()).status, 'draft');
  await assert.rejects(records.preview(therapist, { conversationId: 'room-a', recordId: 'record-a' }), errorCode('RECORD_NOT_SHAREABLE'));
  const next = saveInput({ clientId: 'record-save-0002', expectedRevision: 1, content: empty });
  await assert.rejects(records.save(therapist, next), errorCode('EMPTY_RECORD'));
  for (const override of [
    { date: '2026-02-30' }, { performed: {} }, { privateNote: 'x'.repeat(2001) },
    { observation: { status: 'not-observed', repetitions: '0' } },
    { observation: { status: 'not-applicable', task: '관찰 내용' } },
    { assessments: [{ ...body().assessments[0], value: '' }] },
    { assessments: [{ ...body().assessments[0], value: null }] },
    { assessments: [{ ...body().assessments[0], value: false }] },
    { assessments: [{ ...body().assessments[0], value: Infinity }] },
    { assessments: [{ ...body().assessments[0], context: '' }] },
    { assessments: Array.from({ length: 21 }, () => body().assessments[0]) },
    { attachments: [{ id:'not-a-server-upload' }] }, { format: 'legacy' }, { activity: { title: '내용 없음' } },
  ]) await assert.rejects(records.save(therapist, { ...next, content: body(override) }), errorCode('INVALID_INPUT'));
  assert.equal((await get()).revision, 1);
  assert.equal((await list()).messages.length, 0);
});

test('unfinished drafts round-trip ordered rows, observations and activities without numeric fabrication or public messages', async () => {
  const partial = body({ status:'draft', observation:{ status:'', task:'작성 중인 가상 관찰' }, activity:{ title:'작성 중인 활동' },
    assessments:[{ ...body().assessments[0], value:'' }, body().assessments[1], { tool:'새 도구' }] });
  const request = saveInput({ content:partial });
  await records.save(therapist, request);
  const draft = await get();
  assert.deepEqual(draft.assessments, [
    { ...partial.assessments[0], value:null }, partial.assessments[1], { tool:'새 도구', item:'', unit:'', context:'', value:null },
  ]);
  assert.equal(draft.observation.task, partial.observation.task);
  assert.deepEqual(draft.activity, { title:'작성 중인 활동', instruction:'', frequency:'', caution:'' });
  assert.equal((await database.query('SELECT * FROM cb_record_assessments')).rows.length, 0);
  assert.deepEqual((await database.query('SELECT draft_assessments FROM cb_record_revisions')).rows[0].draft_assessments, draft.assessments);
  assert.equal((await records.save(therapist, { ...request, content:{ ...partial, assessments:draft.assessments, activity:draft.activity } })).replayed, true);
  assert.equal((await list()).messages.length, 0);
  await assert.rejects(records.preview(therapist, { conversationId:'room-a', recordId:'record-a' }), errorCode('RECORD_NOT_SHAREABLE'));
  const saved = saveInput({ expectedRevision:1, clientId:'complete-draft-0001', content:body() });
  await records.save(therapist, saved);
  assert.equal((await get()).status, 'saved');
  assert.equal((await database.query('SELECT * FROM cb_record_assessments')).rows.length, 2);
  assert.deepEqual(await get({ revision:1 }), draft);
  await records.publish(therapist, await publishInput());
  const publicText = JSON.stringify(await list());
  assert.ok(!publicText.includes('작성 중인 가상 관찰') && !publicText.includes('새 도구') && !publicText.includes('draft_assessments'));
  await assert.rejects(database.query("UPDATE cb_record_revisions SET draft_assessments = '[]'::jsonb WHERE revision = 1"), { code:'23514' });
});

test('draft relaxation never permits invalid numeric values, oversized fields or a bypass to formal storage', async () => {
  for (const override of [
    { assessments:[{ tool:'x', value:false }] }, { assessments:[{ tool:'x', value:'NaN' }] },
    { assessments:[{ tool:'x', value:Infinity }] }, { assessments:[{ tool:'x', value:[] }] },
    { assessments:[{ tool:'x'.repeat(101) }] }, { assessments:[{ tool:'x', context:'x'.repeat(301) }] },
    { assessments:[{ tool:{}, value:null }] }, { activity:{ instruction:false } },
    { observation:{ status:'not-observed', task:'모순된 내용' } },
  ]) await assert.rejects(records.save(therapist, saveInput({ content:body({ status:'draft', ...override }) })), errorCode('INVALID_INPUT'));
  for (const override of [
    { assessments:[{ ...body().assessments[0], value:null }] },
    { observation:{ status:'', task:'아직 미선택' } }, { activity:{ title:'아직 작성 중' } },
  ]) await assert.rejects(records.save(therapist, saveInput({ content:body(override) })), errorCode('INVALID_INPUT'));
  assert.equal((await database.query('SELECT * FROM cb_records')).rows.length, 0);
});

test('draft column validates JSON shape and finite numbers and cannot contaminate clinical measurements', async () => {
  for (const invalid of [null, {}, [], [null], [{ tool:'x' }], Array(21).fill({ tool:'', item:'', value:null, unit:'', context:'' }),
    [{ tool:'', item:'', value:'0', unit:'', context:'' }], [{ tool:'', item:'', value:false, unit:'', context:'' }],
    [{ tool:'', item:'', value:null, unit:'', context:'', extra:'unexpected' }]])
    assert.equal((await database.query('SELECT cb_valid_draft_assessments($1::jsonb) AS valid', [JSON.stringify(invalid)])).rows[0].valid, false);
  assert.equal((await database.query(`SELECT cb_valid_draft_assessments('[{"tool":"","item":"","value":1e1000,"unit":"","context":""}]'::jsonb) AS valid`)).rows[0].valid, false);
  const rows = [{ ...body().assessments[0], value:null }];
  await records.save(therapist, saveInput({ content:body({ status:'draft', assessments:rows }) }));
  const unsealed = (status, work) => database.transaction(async (tx) => {
    await tx.query(`INSERT INTO cb_record_revisions
      (center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note,draft_assessments)
      SELECT center_id,conversation_id,record_id,2,author_id,goal_id,record_date,$1,title,performed,response,next_plan,summary,private_note,draft_assessments
      FROM cb_record_revisions WHERE revision = 1`, [status]);
    await work(tx);
    await tx.query('UPDATE cb_record_revisions SET sealed = true WHERE revision = 2');
  });
  await assert.rejects(unsealed('saved', async () => {}), { code:'23514' });
  await assert.rejects(unsealed('draft', (tx) => tx.query(`INSERT INTO cb_record_assessments
    (center_id,conversation_id,record_id,revision,ordinal,tool,item,value,unit,context)
    VALUES ('center-a','room-a','record-a',2,0,'가상 도구','가상 항목',0,'회','가상 조건')`)), { code:'23514' });
  assert.equal((await get()).revision, 1);
  assert.deepEqual((await get()).assessments, rows);
});

test('only assigned therapists can read clinical records; previews and shared cards exclude private data', async () => {
  await records.save(therapist, saveInput());
  const preview = await records.preview(therapist, { conversationId: 'room-a', recordId: 'record-a' });
  assert.deepEqual(preview.recipientIds, [guardian.userId]);
  assert.equal('privateNote' in preview, false);
  assert.equal('assessments' in preview, false);
  const sent = await records.publish(therapist, await publishInput());
  const shared = (await list()).messages[0];
  assert.equal(shared.id, sent.messageId);
  assert.equal(shared.publication.activity.instruction, body().activity.instruction);
  assert.equal(shared.publication.recordRevision, 1);
  assert.equal(JSON.stringify(shared).includes('PRIVATE-NOTE-FIXTURE'), false);
  assert.equal(JSON.stringify(shared).includes('별도 관찰'), false);
  for (const actor of [guardian, manager, replacement, { centerId: 'center-b', userId: 'therapist-b' }]) {
    const code = actor === guardian ? 'FORBIDDEN' : 'NOT_FOUND';
    const forged = { ...actor, role: 'therapist' };
    await assert.rejects(records.get(forged, { conversationId: 'room-a', recordId: 'record-a' }), errorCode(code));
    await assert.rejects(records.list(forged, { conversationId: 'room-a' }), errorCode(code));
    await assert.rejects(records.save(forged, saveInput()), errorCode(code));
    await assert.rejects(records.publish(forged, await publishInput({ clientId: 'forged-publish' })), errorCode(code));
  }
  const audits = (await database.query('SELECT * FROM cb_record_requests')).rows;
  assert.equal(JSON.stringify(audits).includes('PRIVATE-NOTE-FIXTURE'), false);
  assert.equal((await database.query('SELECT * FROM cb_record_recipients')).rows[0].user_id, guardian.userId);
});

test('unshared edits keep the old shared snapshot; reshare/withdrawal preserve original reply links', async () => {
  await records.save(therapist, saveInput());
  const input = await publishInput();
  const first = await records.publish(therapist, input);
  const reply = await send({ replyTo: first.messageId });
  await records.save(therapist, saveInput({ clientId: 'record-save-0002', expectedRevision: 1,
    content: body({ summary: '수정한 공유 요약', activity: { ...body().activity, instruction: '새 활동 안내' } }) }));
  assert.equal((await list()).messages[0].publication.summary, '공유용 가상 요약');
  const second = await records.publish(therapist, await publishInput({ clientId: 'record-publish-0002' }));
  const guardianPage = await list();
  assert.equal(guardianPage.messages[0].hidden, true);
  assert.equal('publication' in guardianPage.messages[0], false);
  assert.equal(guardianPage.messages.find((m) => m.id === reply.id).quote.hidden, true);
  assert.equal(guardianPage.messages.at(-1).publication.activity.instruction, '새 활동 안내');
  const history = await list(therapist);
  assert.equal(history.messages[0].publication.recordRevision, 1);
  assert.equal(history.messages[0].publication.activity.instruction, body().activity.instruction);
  await conversations.withdraw(therapist, { conversationId: 'room-a', messageId: second.messageId });
  const retry = await records.publish(therapist, input);
  assert.equal(retry.messageId, first.messageId);
  assert.equal(retry.replayed, true);
  assert.equal((await list()).messages.filter((m) => m.type === 'publication').every((m) => m.hidden), true);
  assert.equal((await list()).messages.find((m) => m.id === reply.id).body, '가정의 가상 소식');
});

test('stale record or recipient preview cannot share changed content or a newly connected guardian', async () => {
  await records.save(therapist, saveInput());
  const staleContent = await publishInput();
  await records.save(therapist, saveInput({ clientId: 'record-save-0002', expectedRevision: 1, content: body({ summary: '바뀐 요약' }) }));
  await assert.rejects(records.publish(therapist, staleContent), errorCode('RECORD_CONFLICT'));
  const staleRecipients = await publishInput();
  await changeRelations({ pastHistoryConfirmed: true, guardians: [{ userId: guardian.userId, history: 'preserve' }, { userId: 'guardian-new', history: 'all' }] });
  await assert.rejects(records.publish(therapist, staleRecipients), errorCode('RECIPIENTS_CHANGED'));
  const current = await publishInput();
  await database.query("UPDATE cb_memberships SET active = false WHERE user_id = 'guardian-new'");
  await assert.rejects(records.publish(therapist, current), errorCode('RECIPIENTS_CHANGED'));
  assert.equal((await list()).messages.length, 0);
  await records.publish(therapist, await publishInput());
  assert.equal((await list()).messages.length, 1);
});

test('save and publish retries are exactly once and old save receipts cannot roll back a newer revision', async () => {
  const original = saveInput();
  const saved = await Promise.all([records.save(therapist, original), records.save(therapist, original)]);
  assert.equal(saved.filter((r) => r.replayed).length, 1);
  await records.save(therapist, saveInput({ clientId: 'record-save-0002', expectedRevision: 1, content: body({ performed: '새 내용' }) }));
  assert.equal((await records.save(therapist, original)).revision, 1);
  assert.equal((await get()).revision, 2);
  assert.equal((await get()).performed, '새 내용');
  await assert.rejects(records.save(therapist, { ...original, content: body({ response: '다른 내용' }) }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(records.save(therapist, { ...original, clientId: 'stale-save-0001' }), errorCode('RECORD_CONFLICT'));
  const input = await publishInput();
  const results = await Promise.all([records.publish(therapist, input), records.publish(therapist, input)]);
  assert.equal(new Set(results.map((r) => r.messageId)).size, 1);
  assert.equal((await list()).messages.length, 1);
  await assert.rejects(records.publish(therapist, { ...input, recipientIds: [] }), errorCode('IDEMPOTENCY_CONFLICT'));
  await changeRelations({ pastHistoryConfirmed: true, therapist: { userId: replacement.userId, history: 'all' } });
  await assert.rejects(records.save(therapist, original), errorCode('NOT_FOUND'));
});

test('context/reference checks prevent cross-child links and duplicate appointment records', async () => {
  const outside = await send({ conversationId: 'room-other' });
  for (const [override, code] of [
    [{ goalId: 'goal-other' }, 'CONTEXT_NOT_FOUND'],
    [{ appointmentId: 'appointment-other' }, 'CONTEXT_NOT_FOUND'],
    [{ referenceMessageIds: [outside.id] }, 'NOT_FOUND'],
    [{ referenceMessageIds: ['missing-message'] }, 'NOT_FOUND'],
  ]) await assert.rejects(records.save(therapist, saveInput({ content: body(override) })), errorCode(code));
  await records.save(therapist, saveInput({ content: body({ appointmentId: 'appointment-a' }) }));
  await assert.rejects(records.save(therapist, saveInput({ recordId: 'record-other', clientId: 'record-save-0002',
    content: body({ appointmentId: 'appointment-a' }) })), errorCode('APPOINTMENT_RECORD_EXISTS'));
  assert.equal((await records.list(therapist, { conversationId: 'room-a' })).records.length, 1);
});

test('record list exposes only current appointment linkage within therapist history scope', async () => {
  await records.save(therapist, saveInput({ content: body({ appointmentId: 'appointment-a' }) }));
  await records.save(therapist, saveInput({ recordId: 'record-free', clientId: 'record-free-0001' }));
  const current = await records.list(therapist, { conversationId: 'room-a' });
  assert.deepEqual(current.records.map(({ id, appointmentId }) => ({ id, appointmentId })), [
    { id: 'record-a', appointmentId: 'appointment-a' }, { id: 'record-free', appointmentId: null },
  ]);
  for (const record of current.records)
    assert.deepEqual(Object.keys(record).sort(), ['appointmentId', 'date', 'id', 'revision', 'status', 'title']);
  await records.save(therapist, saveInput({ expectedRevision: 1, clientId: 'unlink-record-0001' }));
  const changed = await records.list(therapist, { conversationId: 'room-a' });
  assert.equal(changed.records[0].appointmentId, null);
  assert.equal((await get({ revision: 1 })).appointmentId, 'appointment-a');
  assert.equal((await records.list(therapist, { conversationId: 'room-a', expectedRevision: current.revision })).resetRequired, true);
  await assert.rejects(records.list(guardian, { conversationId: 'room-a' }), errorCode('FORBIDDEN'));
  await assert.rejects(records.list(manager, { conversationId: 'room-a' }), errorCode('NOT_FOUND'));
  await changeRelations({ therapist: { userId: replacement.userId, history: 'from_now' } });
  assert.deepEqual((await records.list(replacement, { conversationId: 'room-a' })).records, []);
  await assert.rejects(records.list(therapist, { conversationId: 'room-a' }), errorCode('NOT_FOUND'));
});

test('assignment from_now excludes older unshared drafts even when no visible message separates them', async () => {
  await records.save(therapist, saveInput({ content: { date: '2026-10-01', goalId: 'goal-a', status: 'draft' } }));
  assert.equal((await list()).messages.length, 0);
  await changeRelations({ therapist: { userId: replacement.userId, history: 'from_now' } });
  assert.deepEqual((await records.list(replacement, { conversationId: 'room-a' })).records, []);
  await assert.rejects(records.get(replacement, { conversationId: 'room-a', recordId: 'record-a' }), errorCode('NOT_FOUND'));
  await assert.rejects(records.save(replacement, saveInput({ expectedRevision: 1 })), errorCode('NOT_FOUND'));
  await records.save(replacement, saveInput({ recordId: 'record-new', clientId: 'record-save-new' }));
  assert.deepEqual((await records.list(replacement, { conversationId: 'room-a' })).records.map((r) => r.id), ['record-new']);
});

test('failed revision receipt rolls back original record, measurements, references and sequence allocation', async () => {
  const message = await send();
  const input = saveInput({ content: body({ referenceMessageIds: [message.id] }) });
  const beforeRoom = (await database.query("SELECT last_sequence,revision FROM cb_conversations WHERE id = 'room-a'")).rows[0];
  await database.exec(`CREATE FUNCTION cb_test_record_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected record receipt failure'; END; $$;
    CREATE TRIGGER cb_test_record_failure BEFORE INSERT ON cb_record_requests
    FOR EACH ROW EXECUTE FUNCTION cb_test_record_failure();`);
  try {
    await assert.rejects(records.save(therapist, input), /injected record receipt failure/);
    for (const table of ['cb_records', 'cb_record_revisions', 'cb_record_assessments', 'cb_record_references'])
      assert.equal((await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count, 0);
    assert.deepEqual((await database.query("SELECT last_sequence,revision FROM cb_conversations WHERE id = 'room-a'")).rows[0], beforeRoom);
  } finally {
    await database.exec('DROP TRIGGER cb_test_record_failure ON cb_record_requests; DROP FUNCTION cb_test_record_failure();');
  }
  assert.equal((await records.save(therapist, input)).revision, 1);
  assert.equal((await get()).assessments.length, 2);
});

test('failed share rolls back new snapshot/card/recipients and preserves the previous publication', async () => {
  await records.save(therapist, saveInput());
  await records.publish(therapist, await publishInput());
  const before = await list();
  await records.save(therapist, saveInput({ clientId: 'record-save-0002', expectedRevision: 1, content: body({ summary: '두 번째 요약' }) }));
  const afterSave = await list();
  assert.deepEqual(afterSave, { ...before, revision: before.revision + 1 });
  const input = await publishInput({ clientId: 'record-publish-0002' });
  await database.exec(`CREATE FUNCTION cb_test_share_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation = 'publish' THEN RAISE EXCEPTION 'injected share receipt failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER cb_test_share_failure BEFORE INSERT ON cb_record_requests
    FOR EACH ROW EXECUTE FUNCTION cb_test_share_failure();`);
  try {
    await assert.rejects(records.publish(therapist, input), /injected share receipt failure/);
    assert.deepEqual(await list(), afterSave);
    assert.equal((await database.query('SELECT * FROM cb_record_publications')).rows.length, 1);
    assert.equal((await database.query('SELECT * FROM cb_record_recipients')).rows.length, 1);
  } finally {
    await database.exec('DROP TRIGGER cb_test_share_failure ON cb_record_requests; DROP FUNCTION cb_test_share_failure();');
  }
  assert.equal((await records.publish(therapist, input)).replayed, false);
  assert.equal((await records.publish(therapist, input)).replayed, true);
  assert.equal((await list()).messages.length, 2);
});

test('raw snapshot helper cannot override a managed record or invent its missing legacy original', async () => {
  await records.save(therapist, saveInput());
  await assert.rejects(conversations.publishSnapshot(therapist, { conversationId: 'room-a', clientId: 'raw-share-0001',
    recordId: 'record-a', title: '위조 제목', summary: '위조 공유' }), errorCode('RECORD_SERVICE_REQUIRED'));
  await conversations.publishSnapshot(therapist, { conversationId: 'room-a', clientId: 'legacy-share-0001',
    recordId: 'legacy-record', title: '기존 제목', summary: '기존 자유 텍스트' });
  await assert.rejects(records.save(therapist, saveInput({ recordId: 'legacy-record', clientId: 'legacy-save-0001' })), errorCode('RECORD_IMPORT_REQUIRED'));
});

test('database enforces current revision, finite measurements and same-room reference/publication integrity', async () => {
  await records.save(therapist, saveInput());
  const outside = await send({ conversationId: 'room-other' });
  await assert.rejects(database.query('UPDATE cb_records SET current_revision = 999'), { code: '23503' });
  const unsealed = (work) => database.transaction(async (tx) => {
    await tx.query(`INSERT INTO cb_record_revisions
      (center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note)
      SELECT center_id,conversation_id,record_id,2,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note
      FROM cb_record_revisions WHERE record_id = 'record-a' AND revision = 1`);
    return work(tx);
  });
  await assert.rejects(unsealed((tx) => tx.query(`INSERT INTO cb_record_assessments
    (center_id,conversation_id,record_id,revision,ordinal,tool,item,value,unit,context)
    VALUES ('center-a','room-a','record-a',2,2,'직접 관찰','값','NaN'::double precision,'회','가상 조건')`)), { code: '23514' });
  await assert.rejects(unsealed((tx) => tx.query(`INSERT INTO cb_record_references
    (center_id,conversation_id,record_id,revision,ordinal,message_id)
    VALUES ('center-a','room-a','record-a',2,0,$1)`, [outside.id])), { code: '23503' });
  await assert.rejects(unsealed(async () => {}), { code: '23514' });
  await assert.rejects(database.query(`INSERT INTO cb_record_assessments
    (center_id,conversation_id,record_id,revision,ordinal,tool,item,value,unit,context)
    VALUES ('center-a','room-a','record-a',1,2,'직접 관찰','추가 값',1,'회','가상 조건')`), { code: '23514' });
  const result = await records.publish(therapist, await publishInput());
  await assert.rejects(database.query("UPDATE cb_record_publications SET activity = '{}'::jsonb"), { code: '23514' });
  await assert.rejects(database.query('DELETE FROM cb_record_recipients'), { code: '23514' });
  assert.equal((await get()).revision, 1);
  assert.equal((await list()).messages[0].id, result.messageId);
});

test('018 adds draft storage without rewriting existing clinical data or save request hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-draft-migration-'));
  const legacy = await PGlite.create();
  try {
    const names = (await readdir(new URL('../migrations/',import.meta.url))).filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name) && name < '018-');
    for (const name of names) await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(directory,name));
    await migrate(legacy,pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('center-a'); INSERT INTO cb_users(id,active) VALUES ('therapist-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true); INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id,last_sequence) VALUES ('center-a','room-a','child-a',1);
      INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1);
      INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
    // Independent normalization of the old 017 request contract. Adding a new
    // storage column must not change a completed request's idempotency hash.
    const oldContent = body(), normalized = { date:oldContent.date,goalId:oldContent.goalId,appointmentId:null,
      title:`${oldContent.date} ${oldContent.performed}`,status:'saved',performed:oldContent.performed,response:oldContent.response,
      nextPlan:oldContent.nextPlan,summary:oldContent.summary,privateNote:oldContent.privateNote,observation:null,
      assessments:oldContent.assessments.map(({ tool,item,unit,context,value }) => ({ tool,item,unit,context,value })),
      activity:oldContent.activity,referenceMessageIds:[] };
    const requestHash = createHash('sha256').update(JSON.stringify({ operation:'save',recordId:'record-a',expected:0,data:normalized })).digest('hex');
    await legacy.transaction(async (tx) => {
      await tx.query(`INSERT INTO cb_records(center_id,conversation_id,id,created_by,created_sequence,current_revision)
        VALUES ('center-a','room-a','record-a','therapist-a',1,1)`);
      await tx.query(`INSERT INTO cb_record_revisions
        (center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note,activity,sealed)
        VALUES ('center-a','room-a','record-a',1,'therapist-a','goal-a',$1,'saved',$2,$3,$4,$5,$6,$7,$8,false)`,
      [normalized.date,normalized.title,normalized.performed,normalized.response,normalized.nextPlan,normalized.summary,normalized.privateNote,JSON.stringify(normalized.activity)]);
      for (const [ordinal,row] of normalized.assessments.entries())
        await tx.query(`INSERT INTO cb_record_assessments(center_id,conversation_id,record_id,revision,ordinal,tool,item,value,unit,context)
          VALUES ('center-a','room-a','record-a',1,$1,$2,$3,$4,$5,$6)`,[ordinal,row.tool,row.item,row.value,row.unit,row.context]);
      await tx.query('UPDATE cb_record_revisions SET sealed = true');
    });
    const revisions = (await legacy.query('SELECT * FROM cb_record_revisions')).rows;
    const measurements = (await legacy.query('SELECT * FROM cb_record_assessments ORDER BY ordinal')).rows;
    await legacy.query(`INSERT INTO cb_record_requests(center_id,conversation_id,actor_id,client_id,request_hash,operation,record_id,record_revision)
      VALUES ('center-a','room-a','therapist-a','record-save-0001',$1,'save','record-a',1)`,[requestHash]);
    const requests = (await legacy.query('SELECT * FROM cb_record_requests')).rows;
    assert.deepEqual(await migrate(legacy),['018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_revisions')).rows,revisions.map((row) => ({ ...row,draft_assessments:null })));
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_requests')).rows,requests);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_assessments ORDER BY ordinal')).rows,measurements);
    const service = new Records(legacy);
    assert.equal((await service.save(therapist,saveInput())).replayed,true);
    assert.deepEqual((await service.get(therapist,{ conversationId:'room-a',recordId:'record-a' })).assessments,normalized.assessments);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_requests')).rows,requests);
    assert.deepEqual(await migrate(legacy),[]);
  } finally {
    await legacy.close(); await rm(directory,{ recursive:true,force:true }); // mkdtemp-owned fixture only
  }
});

test('record pagination rejects stale revisions after saves but an exact replay leaves its snapshot valid', async () => {
  await records.save(therapist, saveInput());
  const second = saveInput({ recordId: 'record-second', clientId: 'record-second-0001' });
  await records.save(therapist, second);
  const first = await records.list(therapist, { conversationId: 'room-a', limit: 1 });
  assert.equal(first.resetRequired, false); assert.equal(first.hasMore, true);
  assert.equal((await records.save(therapist, second)).replayed, true);
  const next = await records.list(therapist, { conversationId: 'room-a', after: first.nextCursor, limit: 1, expectedRevision: first.revision });
  assert.equal(next.resetRequired, false); assert.equal(next.records[0].id, 'record-second');
  await records.save(therapist, { ...second, expectedRevision: 1, clientId: 'record-second-0002', content: body({ title: '수정된 제목' }) });
  const stale = await records.list(therapist, { conversationId: 'room-a', after: first.nextCursor, expectedRevision: first.revision });
  assert.deepEqual(stale, { revision: first.revision + 1, resetRequired: true });
  assert.equal((await records.list(therapist, { conversationId: 'room-a' })).records[1].title, '수정된 제목');
  await assert.rejects(records.list(therapist, { conversationId: 'room-a', expectedRevision: -1 }), errorCode('INVALID_INPUT'));
});

test('record pagination snapshot resets after reconnect from now and omits earlier clinical metadata', async () => {
  await records.save(therapist, saveInput());
  const page = await records.list(therapist, { conversationId: 'room-a' });
  await changeRelations({ therapist: { userId: replacement.userId, history: 'from_now' } });
  await changeRelations({ clientId: 'relationship-0002', therapist: { userId: therapist.userId, history: 'from_now' } });
  const stale = await records.list(therapist, { conversationId: 'room-a', expectedRevision: page.revision });
  assert.equal(stale.resetRequired, true); assert.equal('records' in stale, false);
  assert.deepEqual((await records.list(therapist, { conversationId: 'room-a' })).records, []);
  await assert.rejects(get(), errorCode('NOT_FOUND'));
});

test('005 migration preserves older summary cards and replies without fabricating clinical records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-record-migration-'));
  const legacy = await PGlite.create();
  try {
    for (const name of ['001-conversations.sql', '002-authentication.sql', '003-invitations.sql', '004-relationships.sql'])
      await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
    await migrate(legacy, pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('center-a');
      INSERT INTO cb_users VALUES ('therapist-a',true), ('guardian-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true), ('center-a','guardian-a','guardian',true);
      INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id,last_sequence) VALUES ('center-a','room-a','child-a',2);
      INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1), ('center-a','room-a','guardian-a','guardian',true,1);
      INSERT INTO cb_publications(center_id,conversation_id,id,record_id,version,title,summary)
        VALUES ('center-a','room-a','legacy-publication','legacy-record',1,'이전 제목','이전 자유 텍스트');
      INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,publication_id)
        VALUES ('center-a','room-a','legacy-card',1,'therapist-a','legacy-publish',repeat('0',64),'publication','legacy-publication');
      INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,reply_to)
        VALUES ('center-a','room-a','legacy-reply',2,'guardian-a','legacy-message',repeat('1',64),'text','이전 답변','legacy-card');`);
    const previous = (await legacy.query('SELECT * FROM cb_messages ORDER BY sequence')).rows;
    assert.deepEqual(await migrate(legacy), ['005-records.sql', '006-activity-feedback.sql', '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql', '010-profiles.sql', '011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_messages ORDER BY sequence')).rows,
      previous.map((row) => ({ ...row, feedback_id: null, reply_feedback_id: null, reply_feedback_revision: null, attachments_sealed:true })));
    const result = await new Conversations(legacy).list(guardian, { conversationId: 'room-a' });
    assert.equal(result.messages[0].publication.summary, '이전 자유 텍스트');
    assert.equal(result.messages[1].quote.id, 'legacy-card');
    assert.equal((await legacy.query('SELECT * FROM cb_records')).rows.length, 0);
    assert.equal((await legacy.query('SELECT * FROM cb_record_publications')).rows.length, 0);
    assert.deepEqual(await migrate(legacy), []);
  } finally {
    await legacy.close();
    await rm(directory, { recursive: true, force: true }); // mkdtemp-owned fixture only
  }
});
