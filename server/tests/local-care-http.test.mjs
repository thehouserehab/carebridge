import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Relationships } from '../relationships.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest, sealFixture } from './media-storage-fixtures.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Memory-only synthetic accounts + an ephemeral IPv4 loopback HTTP listener.
// No native/E data, environment credentials, file bytes, mail or public hosting.
let db, auth, conversations, records, feedback, goals, appointments, relationships, server, origin, options, sessions;
const password = 'Synthetic clinical workflow only 2026!';
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a';
const content = (extra = {}) => ({ date: '2026-10-01', goalId: 'goal-a', title: '가상 회기 기록',
  performed: '놀이를 선택함', response: '선택한 놀이에 참여함', nextPlan: '다음 회기에 관찰',
  summary: '보호자와 나누는 요약', privateNote: 'PRIVATE-CLINICAL-NOTE',
  observation: { status: 'observed', task: '가상 과제', repetitions: '0' },
  assessments: [{ tool: '가상 관찰', item: '참여 시간', value: 0, unit: '분', context: '같은 환경' },
    { tool: '가상 관찰', item: '시도 횟수', value: 2, unit: '회', context: '같은 안내' }],
  activity: { title: '가정 놀이', instruction: '편하게 선택한 놀이', frequency: '편한 시간', caution: '무리하지 않기' }, ...extra });
const saveBody = (extra = {}) => ({ clientId: 'clinical-save-0001', expectedRevision: 0, content: content(), ...extra });
const feedbackBody = (sourceMessageId, extra = {}) => ({ sourceMessageId, clientId: 'feedback-save-0001', expectedRevision: 0,
  content: { date: '2026-10-01', result: 'partial', reaction: '가상 보호자 첫 반응', difficulty: '가상 어려움' }, ...extra });

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  sessions = new Map();
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('guardian-new',true),
      ('manager-a',true),('stranger-a',true),('foreign-b',true),('therapist-new',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-new','guardian',true),
      ('center-a','manager-a','center',true),('center-a','stranger-a','guardian',true),
      ('center-b','foreign-b','therapist',true),('center-a','therapist-new','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-b','room-b','foreign-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES
      ('center-a','room-a','goal-a','합성 목표','active'),('center-a','room-a','goal-z','두번째 목표','active'),
      ('center-a','room-other','goal-other','다른 합성 목표','active');
    INSERT INTO cb_appointments VALUES ('center-a','room-a','appointment-a','2026-10-01','10:00',40,'합성 일정','가상 장소','scheduled'),
      ('center-a','room-a','appointment-z','2026-10-02','10:00',40,'다음 합성 일정','가상 장소','scheduled');`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of ['therapist-a', 'guardian-a', 'manager-a', 'stranger-a', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@clinical.test`, password });
  conversations = new Conversations(db); records = new Records(db); feedback = new ActivityFeedback(db);
  goals = new Goals(db); appointments = new Appointments(db); relationships = new Relationships(db);
  server = createServer(async (req, res) => {
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations, records, feedback, goals, appointments, profiles: new Children(db), origin,
    cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});

function call(path, { cookie, method = 'GET', body, headers = {}, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': sessions.get(cookie) } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: requestHeaders, agent: false }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic HTTP request timed out.'))); req.end(payload);
  });
}
const post = (path, cookie, body, headers) => call(path, { cookie, body, headers, method: 'POST' });
async function login(userId = 'therapist-a') {
  const result = await post('/api/local/auth/login', null, { email: `${userId}@clinical.test`, password });
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; sessions.set(cookie, userId); return cookie;
}
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined); assert(!result.text.includes('PRIVATE-'));
}
async function save(cookie, recordId = 'record-a', body = saveBody()) {
  return good(await post(`${room}/records/${recordId}`, cookie, body), 201).receipt;
}
async function publish(cookie, recordId = 'record-a', clientId = 'clinical-publish-0001') {
  const { preview } = good(await call(`${room}/records/${recordId}/preview`, { cookie }));
  const input = { clientId, expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds };
  return { input, preview, receipt: good(await post(`${room}/records/${recordId}/publish`, cookie, input), 201).receipt };
}
async function relation(extra = {}) {
  const current = await relationships.get(manager, { conversationId: 'room-a' });
  return relationships.replace(manager, { conversationId: 'room-a', clientId: `relation-${randomBytes(8).toString('hex')}`, expectedVersion: current.version,
    historyConfirmed: true, therapist: { userId: therapist.userId, history: 'preserve' }, guardians: [{ userId: guardian.userId, history: 'preserve' }], ...extra });
}
async function approvedManifest(actor, clientId) {
  // Metadata-only fixture: no file IO or actual scanning is claimed or needed.
  await configureSyntheticMediaPolicy(db, 'center-a');
  const never = () => { throw new Error('No file IO allowed in metadata fixture.'); };
  const uploads = new MediaUploads(db, { write: never, openVerified: never, remove: never });
  const reserved = await uploads.reserve(actor, { conversationId: 'room-a', clientId,
    file: { name: 'synthetic.png', type: 'image/png', size: 100, sha256: createHash('sha256').update('synthetic-manifest-only').digest('hex') } });
  const at = (row) => ({ conversationId: 'room-a', uploadId: row.id, expectedVersion: row.version });
  const receiving = await uploads.claim(actor, at(reserved), 'receive');
  const quarantined = await uploads.settle(actor, 'room-a', receiving, { state: 'quarantined' });
  const inspecting = await uploads.claim(actor, at(quarantined), 'inspect');
  return db.transaction((tx) => sealFixture(tx, inspecting, evidenceForManifest({ type: inspecting.type, size: inspecting.size, sha256: inspecting.sha256 })));
}

test('actual HTTP connects draft → saved record → confirmed sharing → feedback → private review/public reply → next record → withdraw', async () => {
  const t = await login(), g = await login('guardian-a');
  const draft = saveBody({ content: content({ status: 'draft', assessments: [{ tool: '작성 중', item: '', value: null, unit: '', context: '' }] }) });
  assert.equal((await save(t, 'record-a', draft)).revision, 1);
  const readDraft = good(await call(`${room}/records/record-a`, { cookie: t })).record;
  assert.equal(readDraft.status, 'draft'); assert.equal(readDraft.assessments[0].value, null);
  denied(await call(`${room}/records/record-a/preview`, { cookie: t }), 409, 'RECORD_NOT_SHAREABLE');
  await save(t, 'record-a', saveBody({ clientId: 'clinical-save-0002', expectedRevision: 1, content: content({ appointmentId: 'appointment-a' }) }));
  const saved = good(await call(`${room}/records/record-a`, { cookie: t })).record;
  assert.equal(saved.privateNote, 'PRIVATE-CLINICAL-NOTE'); assert.equal(saved.assessments.length, 2); assert.equal(saved.assessments[0].value, 0);
  assert.equal(saved.observation.repetitions, '0'); assert.equal(saved.appointmentSnapshot.title, '합성 일정');
  const shared = await publish(t); assert.deepEqual(shared.preview.recipientIds, ['guardian-a']); assert(!JSON.stringify(shared.preview).includes('PRIVATE-'));
  const publication = good(await call(`${room}/messages`, { cookie: g })).messages[0];
  assert.equal(publication.publication.summary, content().summary); assert.equal(publication.publication.activity.instruction, content().activity.instruction);
  const f = good(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId)), 201).receipt;
  const firstFeedback = good(await call(`${room}/feedback/feedback-a`, { cookie: t })).message;
  assert.equal(firstFeedback.feedback.revision, 1); assert.equal(firstFeedback.feedback.reviewed, false);
  good(await post(`${room}/read`, t, { messageId: f.messageId }));
  assert.equal(good(await call(`${room}/feedback/feedback-a`, { cookie: t })).message.feedback.reviewed, false);
  const reviewInput = { clientId: 'clinical-review-0001', expectedRevision: 1, expectedReviewVersion: 0, note: 'PRIVATE-REVIEW-NOTE' };
  const reviewed = good(await post(`${room}/feedback/feedback-a/review`, t, reviewInput)).receipt;
  assert.equal(reviewed.reviewVersion, 1);
  assert.equal(good(await call(`${room}/feedback/feedback-a/review`, { cookie: t })).review.note, 'PRIVATE-REVIEW-NOTE');
  const reply = good(await post(`${room}/messages`, t, { clientId: 'clinical-reply-0001', body: '보호자에게 보내는 공개 답변', replyTo: f.messageId, expectedReplyRevision: 1 }), 201).message;
  assert.equal(reply.quote.body, '가상 보호자 첫 반응'); assert.equal(reply.quote.feedbackRevision, 1);
  for (const cookie of [t, g]) {
    const messages = await call(`${room}/messages`, { cookie }); good(messages); assert(!messages.text.includes('PRIVATE-'));
    assert.equal(messages.json.messages.find((m) => m.id === f.messageId).feedback.reviewed, true);
    assert(!messages.text.includes('reviewNote')); assert(!messages.text.includes('object_key'));
  }
  const nextContent = content({ referenceMessageIds: [f.messageId, reply.id], referenceFeedbackRevisions: [{ messageId: f.messageId, revision: 1 }] });
  await save(t, 'record-next', saveBody({ clientId: 'clinical-next-0001', content: nextContent }));
  const references = good(await call(`${room}/records/record-next`, { cookie: t })).record.referenceSources;
  assert.equal(references[0].feedbackRevision, 1); assert.equal(references[1].body, reply.body);
  good(await post(`${room}/publications/${shared.receipt.messageId}/withdraw`, t, {}));
  const visible = good(await call(`${room}/messages`, { cookie: g })).messages;
  assert.equal(visible.find((m) => m.id === f.messageId).hidden, true);
  assert.equal(visible.find((m) => m.id === reply.id).body, reply.body); assert.equal(visible.find((m) => m.id === reply.id).quote.hidden, true);
  assert.deepEqual(good(await call(`${room}/records/record-next`, { cookie: t })).record.referenceSources, references);
});

test('all clinical paths retain session/source/account guards and role/tenant/room object isolation', async () => {
  const t = await login(), g = await login('guardian-a'); await save(t); const shared = await publish(t);
  good(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId)), 201);
  for (const endpoint of ['/records', '/records/record-a', '/records/record-a/preview', '/feedback/feedback-a/review'])
    denied(await call(`${room}${endpoint}`, { cookie: g }), 404, 'NOT_FOUND');
  denied(await call(`${room}/feedback/feedback-a?revision=1`, { cookie: g }), 404, 'NOT_FOUND');
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b']) {
    const cookie = await login(userId);
    for (const endpoint of ['/records', '/records/record-a', '/feedback/feedback-a', '/feedback/feedback-a/review', '/goals'])
      denied(await call(`${room}${endpoint}`, { cookie }), 404, 'NOT_FOUND');
  }
  denied(await call(`${room.replace('room-a', 'room-other')}/records/record-a`, { cookie: t }), 404, 'NOT_FOUND');
  denied(await call(`${room}/records`, { cookie: t, headers: { 'X-Carebridge-Account': guardian.userId } }), 401, 'AUTH_REQUIRED');
  denied(await call(`${room}/records`, { cookie: t, headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
  denied(await call(`${room}/records`), 401, 'AUTH_REQUIRED');
  denied(await post(`${room}/records/record-a`, t, saveBody({ expectedRevision: 1 }), { Origin: 'https://attacker.test' }), 403, 'SOURCE_REJECTED');
  denied(await post(`${room}/records/record-a`, t, saveBody({ expectedRevision: 1 }), { 'X-Carebridge-Request': undefined }), 403, 'SOURCE_REJECTED');
  denied(await post(`${room}/feedback/feedback-a/review`, g, { clientId: 'forged-review-01', expectedRevision: 1, expectedReviewVersion: 0, note: 'forged' }), 404, 'NOT_FOUND');
  denied(await post(`${room}/publications/${shared.receipt.messageId}/withdraw`, g, {}), 404, 'NOT_FOUND');
  assert.equal((await records.get(therapist, { conversationId: 'room-a', recordId: 'record-a' })).revision, 1);
});

test('save/share/feedback/review exact retries return original receipts; changed payload and stale revisions do not mutate', async () => {
  const t = await login(), g = await login('guardian-a'), first = await save(t);
  const replay = await save(t); assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision);
  denied(await post(`${room}/records/record-a`, t, saveBody({ content: content({ summary: 'changed' }) })), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(`${room}/records/record-a`, t, saveBody({ clientId: 'stale-record-0001' })), 409, 'RECORD_CONFLICT');
  const share = await publish(t); assert.equal(good(await post(`${room}/records/record-a/publish`, t, share.input), 201).receipt.replayed, true);
  const fbInput = feedbackBody(share.receipt.messageId), firstFeedback = good(await post(`${room}/feedback/feedback-a`, g, fbInput), 201).receipt;
  assert.equal(good(await post(`${room}/feedback/feedback-a`, g, fbInput), 201).receipt.replayed, true);
  denied(await post(`${room}/feedback/feedback-a`, g, { ...fbInput, clientId: 'stale-feedback-01' }), 409, 'FEEDBACK_CONFLICT');
  const ri = { clientId: 'review-retry-0001', expectedRevision: 1, expectedReviewVersion: 0, note: 'PRIVATE-review' };
  good(await post(`${room}/feedback/feedback-a/review`, t, ri));
  assert.equal(good(await post(`${room}/feedback/feedback-a/review`, t, ri)).receipt.replayed, true);
  denied(await post(`${room}/feedback/feedback-a/review`, t, { ...ri, clientId: 'review-stale-0001' }), 409, 'REVIEW_CONFLICT');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_record_revisions')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_revisions')).rows[0].n, 1);
  assert.equal(good(await call(`${room}/feedback/feedback-a`, { cookie: g })).message.id, firstFeedback.messageId);
});

test('share preview recipient and record versions are confirmed; reshare appends rather than mutating past card', async () => {
  const t = await login(); await save(t);
  const old = good(await call(`${room}/records/record-a/preview`, { cookie: t })).preview;
  await relation({ guardians: [{ userId: guardian.userId, history: 'preserve' }, { userId: 'guardian-new', history: 'from_now' }] });
  const requestBody = { clientId: 'confirm-stale-001', expectedRevision: old.recordRevision, expectedRelationshipsVersion: old.relationshipsVersion, recipientIds: old.recipientIds };
  denied(await post(`${room}/records/record-a/publish`, t, requestBody), 409, 'RECIPIENTS_CHANGED');
  const first = await publish(t);
  await save(t, 'record-a', saveBody({ clientId: 'edit-record-0001', expectedRevision: 1, content: content({ summary: '수정된 공유 요약' }) }));
  denied(await post(`${room}/records/record-a/publish`, t, { ...first.input, clientId: 'stale-share-0001' }), 409, 'RECORD_CONFLICT');
  const second = await publish(t, 'record-a', 'reshare-record-01'); assert.notEqual(first.receipt.messageId, second.receipt.messageId);
  const cards = good(await call(`${room}/messages`, { cookie: t })).messages;
  assert.equal(cards.find((m) => m.id === first.receipt.messageId).publication.summary, content().summary);
  assert.equal(cards.find((m) => m.id === second.receipt.messageId).publication.summary, '수정된 공유 요약');
});

test('preserved feedback F1 reference survives F2 and withdrawal; new stale reference and reply are rejected', async () => {
  const t = await login(), g = await login('guardian-a'); await save(t); const shared = await publish(t);
  const first = good(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId)), 201).receipt;
  const refs = { referenceMessageIds: [first.messageId], referenceFeedbackRevisions: [{ messageId: first.messageId, revision: 1 }] };
  await save(t, 'record-next', saveBody({ clientId: 'reference-save-01', content: content(refs) }));
  good(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId, { clientId: 'feedback-save-0002', expectedRevision: 1,
    content: { date: '2026-10-02', result: 'done', reaction: '수정된 두번째 반응', difficulty: '' } })), 201);
  await save(t, 'record-next', saveBody({ clientId: 'reference-save-02', expectedRevision: 1, content: content({ ...refs, nextPlan: '다음 계획 변경' }) }));
  assert.equal(good(await call(`${room}/records/record-next`, { cookie: t })).record.referenceSources[0].feedbackRevision, 1);
  const oldFeedback = good(await call(`${room}/feedback/feedback-a?revision=1`, { cookie: t })).message;
  assert.equal(oldFeedback.feedback.reaction, '가상 보호자 첫 반응'); assert(!JSON.stringify(oldFeedback).includes('reviewNote'));
  denied(await post(`${room}/records/record-stale`, t, saveBody({ clientId: 'reference-stale-01', content: content(refs) })), 409, 'REFERENCE_CHANGED');
  denied(await post(`${room}/messages`, t, { clientId: 'reply-stale-0001', body: '새 답변', replyTo: first.messageId, expectedReplyRevision: 1 }), 409, 'FEEDBACK_CONFLICT');
  good(await post(`${room}/publications/${shared.receipt.messageId}/withdraw`, t, {}));
  assert.equal(good(await call(`${room}/records/record-next`, { cookie: t })).record.referenceSources[0].feedbackRevision, 1);
  denied(await post(`${room}/feedback/feedback-new`, g, feedbackBody(shared.receipt.messageId, { clientId: 'closed-source-01' })), 409, 'PUBLICATION_CLOSED');
});

test('context lists provide stable cursors and actual IDs; record save rejects changed or cross-room contexts', async () => {
  const t = await login(), g = await login('guardian-a');
  const goalPage = good(await call(`${room}/goals?limit=1`, { cookie: t })); assert.equal(goalPage.goals[0].id, 'goal-a'); assert.equal(goalPage.hasMore, true);
  assert.equal(good(await call(`${room}/goals?afterId=${goalPage.nextCursor}&expectedRevision=${goalPage.revision}`, { cookie: t })).goals[0].id, 'goal-z');
  const ap = good(await call(`${room}/appointments?dateFrom=2026-10-01&dateTo=2026-10-03&limit=1`, { cookie: g }));
  assert.equal(ap.appointments[0].id, 'appointment-a'); assert.equal(ap.hasMore, true);
  const cursor = encodeURIComponent(JSON.stringify(ap.nextCursor));
  assert.equal(good(await call(`${room}/appointments?dateFrom=2026-10-01&dateTo=2026-10-03&afterAppointment=${cursor}&expectedVersion=${ap.version}`, { cookie: g })).appointments[0].id, 'appointment-z');
  await goals.save(therapist, { conversationId: 'room-a', goalId: 'goal-a', clientId: 'goal-change-0001', expectedRevision: goalPage.goals[0].revision,
    content: { title: '갱신된 목표', description: '', status: 'active' } });
  assert.equal(good(await call(`${room}/goals?expectedRevision=${goalPage.revision}`, { cookie: t })).resetRequired, true);
  denied(await post(`${room}/records/record-a`, t, saveBody({ expectedGoalRevision: goalPage.goals[0].revision })), 409, 'CONTEXT_CHANGED');
  denied(await post(`${room}/records/record-a`, t, saveBody({ content: content({ goalId: 'goal-other' }) })), 409, 'CONTEXT_NOT_FOUND');
  denied(await call(`${room}/appointments?dateFrom=2026-10-01&dateTo=2026-10-03&afterAppointment=${cursor}`, { cookie: t }), 400, 'INVALID_INPUT');
});

test('record list HTTP exposes current appointment linkage only to its authorized therapist', async () => {
  const t = await login(), g = await login('guardian-a');
  await save(t, 'record-a', saveBody({ content: content({ appointmentId: 'appointment-a' }) }));
  await save(t, 'record-free', saveBody({ clientId: 'clinical-free-0001' }));
  const page = good(await call(`${room}/records`, { cookie: t }));
  assert.deepEqual(page.records.map(({ id, appointmentId }) => ({ id, appointmentId })), [
    { id: 'record-a', appointmentId: 'appointment-a' }, { id: 'record-free', appointmentId: null },
  ]);
  for (const record of page.records)
    assert.deepEqual(Object.keys(record).sort(), ['appointmentId', 'date', 'id', 'revision', 'status', 'title']);
  assert(!JSON.stringify(page).includes('PRIVATE-')); assert(!JSON.stringify(page).includes('assessments'));
  denied(await call(`${room}/records`, { cookie: g }), 404, 'NOT_FOUND');
  for (const user of ['manager-a', 'stranger-a', 'foreign-b'])
    denied(await call(`${room}/records`, { cookie: await login(user) }), 404, 'NOT_FOUND');
  await save(t, 'record-a', saveBody({ clientId: 'clinical-unlink-0001', expectedRevision: 1 }));
  const reset = good(await call(`${room}/records?expectedRevision=${page.revision}`, { cookie: t }));
  assert.equal(reset.resetRequired, true); assert.equal('records' in reset, false);
  assert.equal(good(await call(`${room}/records`, { cookie: t })).records[0].appointmentId, null);
});

test('appointment detail returns only its current authorized scheduling fields outside the selected month', async () => {
  const t = await login(), g = await login('guardian-a');
  const before = good(await call(`${room}/appointments/appointment-a`, { cookie: t })).appointment;
  assert.equal(before.id, 'appointment-a'); assert.equal(before.revision, 1);
  assert.deepEqual(Object.keys(before).sort(), ['childId', 'conversationId', 'date', 'duration', 'id', 'revision', 'room', 'status', 'therapistId', 'time', 'title', 'updatedAt']);
  const current = await appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' });
  await appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', clientId: 'move-detail-0001',
    expectedRevision: current.revision, content: { date: '2026-11-10', time: '09:00', duration: 40,
      title: '다음 달 합성 일정', room: '가상 장소', status: 'scheduled' } });
  const revised = good(await call(`${room}/appointments/appointment-a`, { cookie: g })).appointment;
  assert.equal(revised.revision, 2); assert.equal(revised.date, '2026-11-10'); assert.equal(revised.time, '09:00');
  assert.equal(revised.therapistId, therapist.userId);
  assert.deepEqual(revised, good(await call(`${room}/appointments/appointment-a`, { cookie: t })).appointment);
  assert(!good(await call(`${room}/appointments?dateFrom=2026-10-01&dateTo=2026-10-31`, { cookie: t })).appointments.some((item) => item.id === revised.id));
});

test('appointment detail preserves source/account/relationship guards and rejects incomplete writes or historical query', async () => {
  const t = await login(), g = await login('guardian-a'), path = `${room}/appointments/appointment-a`;
  denied(await call(path), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: g, headers: { 'X-Carebridge-Account': therapist.userId } }), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: g, headers: { Origin: 'https://attacker.test' } }), 403, 'SOURCE_REJECTED');
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b'])
    denied(await call(path, { cookie: await login(userId) }), 404, 'NOT_FOUND');
  denied(await call(`${room.replace('room-a', 'room-other')}/appointments/appointment-a`, { cookie: t }), 404, 'NOT_FOUND');
  denied(await call(`${room}/appointments/missing`, { cookie: t }), 404, 'NOT_FOUND');
  denied(await post(path, t, { clientId: 'forged-save-0001', expectedRevision: 1 }), 400, 'INVALID_INPUT');
  for (const query of ['revision=1', 'expectedVersion=1', 'role=therapist', 'dateFrom=2026-10-01'])
    denied(await call(`${path}?${query}`, { cookie: t }), 400, 'INVALID_INPUT');
  await relation({ guardians: [] });
  denied(await call(path, { cookie: g }), 404, 'NOT_FOUND');
  assert.equal((await appointments.get(therapist, { conversationId: 'room-a', appointmentId: 'appointment-a' })).revision, 1);
});

test('record list page revisions reset after edits and from-now reconnection without returning historical metadata', async () => {
  const t = await login(); await save(t); await save(t, 'record-b', saveBody({ clientId: 'record-page-0001' }));
  const page = good(await call(`${room}/records?limit=1`, { cookie: t }));
  const next = good(await call(`${room}/records?after=${page.nextCursor}&expectedRevision=${page.revision}`, { cookie: t }));
  assert.equal(next.records[0].id, 'record-b');
  await save(t, 'record-b', saveBody({ expectedRevision: 1, clientId: 'record-page-0002' }));
  const changed = good(await call(`${room}/records?after=${page.nextCursor}&expectedRevision=${page.revision}`, { cookie: t }));
  assert.equal(changed.resetRequired, true); assert.equal('records' in changed, false);
  await relation({ therapist: { userId: 'therapist-new', history: 'from_now' } });
  await relation({ therapist: { userId: therapist.userId, history: 'from_now' } });
  assert.equal(good(await call(`${room}/records?expectedRevision=${changed.revision}`, { cookie: t })).resetRequired, true);
  assert.deepEqual(good(await call(`${room}/records`, { cookie: t })).records, []);
  denied(await call(`${room}/records/record-a`, { cookie: t }), 404, 'NOT_FOUND');
});

test('strict clinical keys/query/methods reject injected authority and unsupported attachment inputs without mutations', async () => {
  const t = await login();
  for (const field of ['userId', 'role', 'centerId', 'recordId', 'conversationId', 'publication'])
    denied(await post(`${room}/records/record-a`, t, { ...saveBody(), [field]: 'forged' }), 400, 'INVALID_INPUT');
  for (const suffix of ['/records?limit=1&limit=2', '/records?expectedRevision=-1', '/records?userId=x', '/records/record-a?revision=01', '/goals?after=1', '/appointments?afterAppointment=%7Bbad'])
    denied(await call(`${room}${suffix}`, { cookie: t }), 400, 'INVALID_INPUT');
  for (const suffix of ['/records/record-a/delete', '/goals/goal-a/delete', '/publications', '/feedback/feedback-a/publish'])
    denied(await call(`${room}${suffix}`, { cookie: t }), 404, 'NOT_FOUND');
  denied(await post(`${room}/records/record-a`, t, saveBody({ content: content({ attachments: [{ id: 'forged' }] }) })), 409, 'ATTACHMENTS_NOT_CONNECTED');
  denied(await post(`${room}/records/record-a`, t, saveBody({ content: { date: '2026-10-01', goalId: 'goal-a' } })), 400, 'EMPTY_RECORD');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n, 0);
});

test('record-only bounded 128KiB accepts maximum valid Korean fields/20 rows while text/auth retain 16KiB', async () => {
  const t = await login(); const text = '가'.repeat(2000), row = { tool: '가'.repeat(100), item: '나'.repeat(100), value: 0, unit: '다'.repeat(100), context: '라'.repeat(300) };
  const large = saveBody({ content: content({ performed: text, response: text, nextPlan: text, summary: text, privateNote: text,
    observation: { status: 'observed', ...Object.fromEntries(['task', 'assistance', 'amount', 'repetitions', 'duration', 'context'].map((key) => [key, '나'.repeat(500)])) },
    assessments: Array.from({ length: 20 }, () => ({ ...row })), activity: { title: '나'.repeat(100), instruction: text, frequency: '나'.repeat(100), caution: '나'.repeat(500) } }) });
  assert(Buffer.byteLength(JSON.stringify(large)) > 16384); assert(Buffer.byteLength(JSON.stringify(large)) < 128 * 1024);
  await save(t, 'record-large', large);
  const loaded = good(await call(`${room}/records/record-large`, { cookie: t })).record;
  assert.equal(loaded.assessments.length, 20); assert.equal(loaded.performed, text);
  denied(await post(`${room}/records/record-too-large`, t, saveBody({ content: content({ performed: '가'.repeat(45000) }) })), 413, 'PAYLOAD_TOO_LARGE');
  denied(await post(`${room}/messages`, t, { clientId: 'large-text-0001', body: '가'.repeat(6000) }), 413, 'PAYLOAD_TOO_LARGE');
  denied(await post('/api/local/auth/login', null, { email: 'a'.repeat(17000), password }), 413, 'PAYLOAD_TOO_LARGE');
});

test('text-only record save/publish refuses existing media instead of silently deleting or exposing it', async () => {
  const t = await login(); const file = await approvedManifest(therapist, 'record-upload-0001');
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', ...saveBody({ content: content({ attachments: [{ id: file.id, share: true }] }) }) });
  const before = await records.get(therapist, { conversationId: 'room-a', recordId: 'record-a' });
  const displayed = await call(`${room}/records/record-a`, { cookie: t }); good(displayed);
  assert.equal(displayed.json.record.attachmentCount, 1); assert(!displayed.text.includes(file.id)); assert(!displayed.text.includes('objectKey'));
  for (const change of [{}, { attachments: [] }]) denied(await post(`${room}/records/record-a`, t,
    saveBody({ expectedRevision: 1, clientId: 'record-media-edit-01', content: content(change) })), 409, 'ATTACHMENTS_NOT_CONNECTED');
  const preview = good(await call(`${room}/records/record-a/preview`, { cookie: t })).preview; assert.equal(preview.attachmentCount, 1);
  denied(await post(`${room}/records/record-a/publish`, t, { clientId: 'record-media-share', expectedRevision: 1,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds }), 409, 'ATTACHMENTS_NOT_CONNECTED');
  assert.deepEqual(await records.get(therapist, { conversationId: 'room-a', recordId: 'record-a' }), before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_publications')).rows[0].n, 0);
});

test('text-only feedback update refuses current media and reference snapshots keep it separate from record attachments', async () => {
  const t = await login(), g = await login('guardian-a'); await save(t); const shared = await publish(t);
  const file = await approvedManifest(guardian, 'feedback-upload-01');
  const first = await feedback.save(guardian, { conversationId: 'room-a', feedbackId: 'feedback-a',
    ...feedbackBody(shared.receipt.messageId, { content: { date: '2026-10-01', result: 'done', reaction: '첨부가 있는 합성 반응', difficulty: '', attachments: [{ id: file.id }] } }) });
  const before = await feedback.get(guardian, { conversationId: 'room-a', feedbackId: 'feedback-a' });
  denied(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId, { clientId: 'media-feedback-edit', expectedRevision: 1 })), 409, 'ATTACHMENTS_NOT_CONNECTED');
  assert.deepEqual(await feedback.get(guardian, { conversationId: 'room-a', feedbackId: 'feedback-a' }), before);
  const publicRead = await call(`${room}/feedback/feedback-a`, { cookie: t }); good(publicRead); assert.equal(publicRead.json.message.attachmentCount, 1); assert(!publicRead.text.includes(file.id));
  await save(t, 'record-next', saveBody({ clientId: 'media-reference-01', content: content({ referenceMessageIds: [first.messageId], referenceFeedbackRevisions: [{ messageId: first.messageId, revision: 1 }] }) }));
  const next = good(await call(`${room}/records/record-next`, { cookie: t })).record;
  assert.equal(next.attachmentCount, 0); assert.equal(next.referenceSources[0].feedbackRevision, 1);
  assert.equal(next.referenceSources[0].attachmentCount, 1); // Exact F1 is now queried; text mode still withholds all file metadata.
  assert.equal('attachments' in next.referenceSources[0], false); assert(!JSON.stringify(next).includes(file.id));
  assert.equal(good(await call(`${room}/feedback/feedback-a?revision=1`, { cookie: t })).message.attachmentCount, 1);
  assert.equal((await records.get(therapist, { conversationId: 'room-a', recordId: 'record-next' })).attachments.length, 0);
});

test('committed feedback F2 with a lost response replays after withdrawal; unseen media never permits a fresh destructive update', async () => {
  const t = await login(), g = await login('guardian-a'); await save(t); const shared = await publish(t);
  good(await post(`${room}/feedback/feedback-a`, g, feedbackBody(shared.receipt.messageId)), 201);
  const second = feedbackBody(shared.receipt.messageId, { clientId: 'feedback-lost-0002', expectedRevision: 1,
    content: { date: '2026-10-02', result: 'done', reaction: '저장된 두번째 반응', difficulty: '' } });
  const committed = good(await post(`${room}/feedback/feedback-a`, g, second), 201).receipt;
  // Browser may never receive this response; the server has already committed.
  good(await post(`${room}/publications/${shared.receipt.messageId}/withdraw`, t, {}));
  const concealed = good(await call(`${room}/feedback/feedback-a`, { cookie: g })).message;
  assert.equal(concealed.hidden, true); assert.equal(concealed.archived, true); assert.equal('feedback' in concealed, false);
  const retried = good(await post(`${room}/feedback/feedback-a`, g, second), 201).receipt;
  assert.deepEqual(retried, { ...committed, replayed: true });
  denied(await post(`${room}/feedback/feedback-a`, g, { ...second, clientId: 'feedback-new-0003', expectedRevision: 2 }), 409, 'PUBLICATION_CLOSED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_revisions')).rows[0].n, 2);

  // A distinct old source can contain concealed attachments. A new operation
  // still cannot use its redacted projection to erase those immutable files.
  const reshared = await publish(t, 'record-a', 'feedback-media-pub');
  const file = await approvedManifest(guardian, 'feedback-hidden-media');
  await feedback.save(guardian, { conversationId: 'room-a', feedbackId: 'feedback-media',
    ...feedbackBody(reshared.receipt.messageId, { clientId: 'feedback-media-save', content: { date: '2026-10-02', result: 'done', reaction: '보존된 첨부', difficulty: '', attachments: [{ id: file.id }] } }) });
  const before = await feedback.get(therapist, { conversationId: 'room-a', feedbackId: 'feedback-media' });
  good(await post(`${room}/publications/${reshared.receipt.messageId}/withdraw`, t, {}));
  denied(await post(`${room}/feedback/feedback-media`, g, feedbackBody(reshared.receipt.messageId, { clientId: 'hidden-media-edit', expectedRevision: 1 })), 409, 'PUBLICATION_CLOSED');
  const after = await feedback.get(therapist, { conversationId: 'room-a', feedbackId: 'feedback-media' });
  assert.equal(after.feedback.revision, before.feedback.revision); assert.deepEqual(after.attachments, before.attachments);
});

test('service exceptions return fixed errors without raw clinical data, keys or database details', async () => {
  const t = await login(); const methods = ['list', 'get', 'save', 'preview', 'publish'];
  options.records = Object.fromEntries(methods.map((method) => [method, async () => { throw new Error('PRIVATE-DATABASE-DETAIL object_key password'); }]));
  for (const path of [`${room}/records`, `${room}/records/record-a`, `${room}/records/record-a/preview`])
    denied(await call(path, { cookie: t }), 503, 'LOCAL_API_UNAVAILABLE');
  denied(await post(`${room}/records/record-a`, t, saveBody()), 503, 'LOCAL_API_UNAVAILABLE');
});
