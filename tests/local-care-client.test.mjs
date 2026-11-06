import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareApiClient, carePages } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const page = (items, revision, more = false, cursor = null) => ({ items, revision, more, cursor, reset: false });

test('single appointment reads bind the exact current room and version without a historical query', async () => {
  const seen = [], appointment = { id: 'appointment', conversationId: 'room', revision: 3, date: '2026-10-09', title: '합성 일정' };
  const client = new CareApiClient({ fetch: async (path, options) => { seen.push({ path, options }); return json({ appointment }); } });
  client.expectedUserId = 'synthetic-user';
  assert.deepEqual(await client.appointment('center', 'room', 'appointment'), appointment);
  assert.equal(seen[0].path, '/api/local/centers/center/conversations/room/appointments/appointment');
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.headers['X-Carebridge-Account'], 'synthetic-user');
  await assert.rejects(client.appointment('center', 'other-room', 'appointment'), errorCode('INVALID_RESPONSE'));
  await assert.rejects(client.appointment('center', 'room', 'other-appointment'), errorCode('INVALID_RESPONSE'));
  appointment.revision = 0;
  await assert.rejects(client.appointment('center', 'room', 'appointment'), errorCode('INVALID_RESPONSE'));
  const count = seen.length;
  await assert.rejects(client.appointment('center', 'room', '../private'), errorCode('INVALID_INPUT'));
  assert.equal(seen.length, count);
});

test('care collections discard old projections on revision resets, including object cursors', async () => {
  let first = true; const calls = [];
  const result = await carePages(async (cursor, revision) => {
    calls.push([cursor, revision]);
    if (!cursor && first) { first = false; return page(['OLD'], 1, true, { date: '2026-10-09', id: 'a' }); }
    if (cursor) return { revision: 2, reset: true };
    return page(['CURRENT'], 2);
  });
  assert.deepEqual(result, ['CURRENT']);
  assert.equal(calls[1][1], 1);
  assert.deepEqual(calls[2], [undefined, undefined]);
});

test('care pagination rejects unstable revisions, loops, empty nonterminal pages and unbounded loads', async () => {
  await assert.rejects(carePages(async () => ({ revision: 2, reset: true })), errorCode('SNAPSHOT_CHANGED'));
  await assert.rejects(carePages(async () => page(['a'], 1, true, 'same')), errorCode('INVALID_RESPONSE'));
  await assert.rejects(carePages(async () => page([], 1, true, 'a')), errorCode('INVALID_RESPONSE'));
  await assert.rejects(carePages(async (cursor) => page(['a'], cursor ? 2 : 1, true, 'a')), errorCode('INVALID_RESPONSE'));
  await assert.rejects(carePages(async (cursor = 0) => page(['a'], 1, true, cursor + 1), { maxPages: 2 }), errorCode('TOO_MUCH_DATA'));
  assert.deepEqual(await carePages(async () => page([], 0)), []);
});

test('care list routes send the service cursor names and preserve one server revision', async () => {
  const seen = []; const client = new CareApiClient({ fetch: async (path) => {
    const url = new URL(path, 'http://localhost'); seen.push(url);
    if (url.pathname.endsWith('/goals')) return json({ goals: [{ id: 'g1', revision: 1, title: '가상 목표' }], revision: 4, resetRequired: false, hasMore: !url.searchParams.has('afterId'), nextCursor: 'g1' });
    if (url.pathname.endsWith('/appointments')) return json({ appointments: [{ id: 'a1', revision: 1, date: '2026-10-09' }], version: 5, resetRequired: false,
      hasMore: !url.searchParams.has('afterAppointment'), nextCursor: { date: '2026-10-09', time: '14:00', conversationId: 'room', appointmentId: 'a1' } });
    return json({ records: [{ id: 'r1', revision: 1, date: '2026-10-09', title: '가상 기록', status: 'draft' }], revision: 6, resetRequired: false, hasMore: url.searchParams.get('after') === '0', nextCursor: 4 });
  } });
  await client.goals('center', 'room');
  assert.equal(seen[1].searchParams.get('afterId'), 'g1');
  assert.equal(seen[1].searchParams.get('expectedRevision'), '4');
  await client.appointments('center', 'room', { dateFrom: '2026-10-09', dateTo: '2026-10-09' });
  assert.equal(JSON.parse(seen[3].searchParams.get('afterAppointment')).appointmentId, 'a1');
  assert.equal(seen[3].searchParams.get('expectedVersion'), '5');
  await client.records('center', 'room');
  assert.equal(seen[5].searchParams.get('after'), '4');
  assert.equal(seen[5].searchParams.get('expectedRevision'), '6');
});

test('care commands strip identity injection, retain the exact operation and validate acknowledgement', async () => {
  const seen = []; const client = new CareApiClient({ fetch: async (path, options) => {
    seen.push({ path, ...options });
    return json({ receipt: { recordId: 'record', revision: 1, operation: path.endsWith('/publish') ? 'publish' : 'save', replayed: false } });
  } });
  client.expectedUserId = 'verified-user';
  const command = { clientId: 'synthetic-command', expectedRevision: 0, expectedGoalRevision: 1, content: { status: 'draft', assessments: [{ value: 0 }] }, role: 'center', userId: 'injected' };
  await client.recordSave('center', 'room', 'record', command);
  assert.deepEqual(JSON.parse(seen[0].body), { clientId: command.clientId, expectedRevision: 0, expectedGoalRevision: 1, content: command.content });
  assert.equal(seen[0].headers['X-Carebridge-Account'], 'verified-user');
  await client.recordPublish('center', 'room', 'record', { clientId: 'synthetic-publish', expectedRevision: 1, expectedRelationshipsVersion: 3, recipientIds: ['guardian'], privateNote: 'DO-NOT-SEND' });
  assert.deepEqual(JSON.parse(seen[1].body), { clientId: 'synthetic-publish', expectedRevision: 1, expectedRelationshipsVersion: 3, recipientIds: ['guardian'] });
  await assert.rejects(client.recordSave('center', 'room', 'other', command), errorCode('INVALID_RESPONSE'));
});

test('feedback history routes keep explicit revision and commands restrict write keys', async () => {
  const seen = []; const client = new CareApiClient({ fetch: async (path, options) => {
    seen.push({ path, ...options });
    if (!options.body) return json({ message: { id: 'message', conversationId: 'room', type: 'feedback', feedback: { id: 'feedback', revision: 1 } } });
    return json({ receipt: { feedbackId: 'feedback', revision: 2, messageId: 'message', operation: path.endsWith('/review') ? 'review' : 'save', replayed: false } });
  } });
  await client.feedback('center', 'room', 'feedback', undefined, 1);
  assert.equal(seen[0].path.endsWith('/feedback/feedback?revision=1'), true);
  await client.feedbackReviewSave('center', 'room', 'feedback', { clientId: 'review', expectedRevision: 2, expectedReviewVersion: 0, note: '가상 검토', role: 'therapist' });
  assert.deepEqual(JSON.parse(seen[1].body), { clientId: 'review', expectedRevision: 2, expectedReviewVersion: 0, note: '가상 검토' });
  await client.feedbackSave('center', 'room', 'feedback', { clientId: 'feedback-save', expectedRevision: 1, sourceMessageId: 'source', content: { reaction: '가상 경험' }, reviewNote: 'DO-NOT-SEND' });
  assert.equal('reviewNote' in JSON.parse(seen[2].body), false);
});

test('care paths and malformed public/private projections fail closed', async () => {
  let calls = 0; const client = new CareApiClient({ fetch: async () => { calls++; return json({}); } });
  await assert.rejects(client.record('center', 'room', '../other'), errorCode('INVALID_INPUT'));
  await assert.rejects(client.feedback('center', 'room', 'other?private=1'), errorCode('INVALID_INPUT'));
  assert.equal(calls, 0);
  await assert.rejects(client.record('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  await assert.rejects(client.recordPreview('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  await assert.rejects(client.feedbackReview('center', 'room', 'feedback'), errorCode('INVALID_RESPONSE'));
});

test('only known conflict codes cross transport; raw server text never becomes public copy', async () => {
  for (const code of ['RECORD_CONFLICT', 'FEEDBACK_CONFLICT', 'REVIEW_CONFLICT', 'RECIPIENTS_CHANGED', 'PUBLICATION_CLOSED', 'ATTACHMENTS_NOT_CONNECTED']) {
    const client = new CareApiClient({ fetch: async () => json({ error: code, message: 'PRIVATE DETAILS' }, 409) });
    await assert.rejects(client.records('center', 'room'), (error) => errorCode(code)(error) && !error.message.includes('PRIVATE'));
  }
  const client = new CareApiClient({ fetch: async () => json({ error: 'AUTH_REQUIRED' }, 409) });
  await assert.rejects(client.records('center', 'room'), errorCode('IDEMPOTENCY_CONFLICT'));
});

const recordFile = (changes = {}) => ({ id: '12345678-1234-4234-8234-123456789abc', name: 'synthetic.png', type: 'image/png', size: 9, share: false, ...changes });
const fullRecord = (changes = {}) => ({ id: 'record', conversationId: 'room', revision: 2, status: 'saved', assessments: [],
  referenceMessageIds: [], referenceSources: [], attachmentCount: 1, attachments: [recordFile()], ...changes });
test('record historical attachment reads pin exact revision and validate immutable private metadata', async () => {
  let value = fullRecord(); const seen = [];
  const client = new CareApiClient({ fetch: async (path, options) => { seen.push({ path, options }); return json({ record: value }); } });
  const record = await client.record('center', 'room', 'record', undefined, 2);
  assert.equal(seen[0].path.endsWith('/records/record?revision=2'), true);
  assert.deepEqual(record.attachments, [recordFile()]); assert(Object.isFrozen(record.attachments)); assert(Object.isFrozen(record.attachments[0]));
  await assert.rejects(client.record('center', 'room', 'record', undefined, 1), errorCode('INVALID_RESPONSE'));
  const count = seen.length;
  for (const revision of [0, -1, 1.5, '2', 2147483648]) await assert.rejects(client.record('center', 'room', 'record', undefined, revision), errorCode('INVALID_INPUT'));
  assert.equal(seen.length, count);
  for (const changes of [{ share: undefined }, { share: 'true' }, { name: '../private.png' }, { id: 'bad' },
    { privateKey: 'PRIVATE' }, { sha256: 'PRIVATE' }, { url: 'https://private.invalid' }]) {
    value = fullRecord({ attachments: [recordFile(changes)] });
    await assert.rejects(client.record('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  }
  value = fullRecord({ attachmentCount: 0 }); await assert.rejects(client.record('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
});

test('prepared share previews accept only explicitly shared files and an exact matching count', async () => {
  const value = { recordId: 'record', recordRevision: 2, relationshipsVersion: 3, recipientIds: ['guardian'], title: '가상 기록', summary: '공개 요약',
    attachmentCount: 1, attachments: [recordFile({ share: true })] };
  const client = new CareApiClient({ fetch: async () => json({ preview: value }) });
  assert.deepEqual((await client.recordPreview('center', 'room', 'record')).attachments, value.attachments);
  value.attachments[0].share = false; await assert.rejects(client.recordPreview('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  value.attachments[0].share = true; value.attachmentCount = 2;
  await assert.rejects(client.recordPreview('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
});

const messageFile = (changes = {}) => { const { share, ...file } = recordFile(changes); return file; };
test('feedback reads validate exact revision and four-field immutable attachments without inventing metadata in text mode', async () => {
  let message = { id: 'message', type: 'feedback', conversationId: 'room', feedback: { id: 'feedback', revision: 2 }, attachmentCount: 1, attachments: [messageFile()] };
  const paths = [], client = new CareApiClient({ fetch: async (path) => { paths.push(path); return json({ message }); } });
  const result = await client.feedback('center', 'room', 'feedback', undefined, 2);
  assert.deepEqual(result.attachments, [messageFile()]); assert(Object.isFrozen(result.attachments)); assert(Object.isFrozen(result.attachments[0]));
  assert.match(paths[0], /feedback\/feedback\?revision=2$/);
  await assert.rejects(client.feedback('center', 'room', 'feedback', undefined, 1), errorCode('INVALID_RESPONSE'));
  const calls = paths.length;
  for (const revision of [0, -1, '2', 1.5, 2147483648]) await assert.rejects(client.feedback('center', 'room', 'feedback', undefined, revision), errorCode('INVALID_INPUT'));
  assert.equal(paths.length, calls);
  for (const extra of [{ share: true }, { url: 'PRIVATE' }, { privateKey: 'PRIVATE' }, { name: '../bad.png' }, { size: -1 }]) {
    message.attachments = [{ ...messageFile(), ...extra }];
    await assert.rejects(client.feedback('center', 'room', 'feedback'), errorCode('INVALID_RESPONSE'));
  }
  message.attachments = [messageFile()]; message.hidden = true;
  await assert.rejects(client.feedback('center', 'room', 'feedback'), errorCode('INVALID_RESPONSE'));
  message = { ...message, attachments: [], attachmentCount: 0, feedback: undefined };
  assert.deepEqual((await client.feedback('center', 'room', 'feedback')).attachments, []);
  message = { id: 'message', type: 'feedback', conversationId: 'room', feedback: { id: 'feedback', revision: 2 }, attachmentCount: 1 };
  assert.equal(Object.hasOwn(await client.feedback('center', 'room', 'feedback'), 'attachments'), false);
});

test('saved record references validate their own pinned file list rather than current message metadata', async () => {
  const reference = { messageId: 'source', feedbackId: 'feedback', feedbackRevision: 1, attachmentCount: 1, attachments: [messageFile()] };
  let record = fullRecord({ referenceMessageIds: ['source'], referenceSources: [reference] });
  const client = new CareApiClient({ fetch: async () => json({ record }) });
  const result = await client.record('center', 'room', 'record', undefined, 2);
  assert.deepEqual(result.referenceSources[0].attachments, [messageFile()]); assert(Object.isFrozen(result.referenceSources[0].attachments[0]));
  for (const extra of [{ attachmentCount: 0 }, { feedbackRevision: 0 }, { attachments: [{ ...messageFile(), share: true }] },
    { attachments: [{ ...messageFile(), hash: 'PRIVATE' }] }, { messageId: '' }]) {
    record = fullRecord({ referenceSources: [{ ...reference, ...extra }] });
    await assert.rejects(client.record('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  }
  record = fullRecord({ referenceSources: [reference, reference] });
  await assert.rejects(client.record('center', 'room', 'record'), errorCode('INVALID_RESPONSE'));
  record = fullRecord({ referenceSources: [{ messageId: 'text-source', messageRevision: 3, body: '당시 원문', attachmentCount: 1, attachments: [messageFile()] }] });
  assert.equal((await client.record('center', 'room', 'record')).referenceSources[0].messageRevision, 3);
});
