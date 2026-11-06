// Pure input/closure tests only. No browser, native provider or E filesystem IO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validateApiRestartCheckpoint } from './native-api-restart-browser-helper.mjs';

const centerId = 'synthetic-center', conversationId = 'synthetic-room';
const rejected = { message: 'NATIVE_API_RESTART_BROWSER_FAILED' };
// Node appends an actual/expected diff for equal/deepEqual failures.
const rejectedComparison = { name: 'AssertionError', code: 'ERR_ASSERTION', message: /^NATIVE_API_RESTART_BROWSER_FAILED(?:\n|$)/ };
function fixture() {
  const first = { id: randomUUID(), name: 'synthetic-first.png', type: 'image/png', size: 91, sha256: 'a'.repeat(64) };
  const second = { id: randomUUID(), name: 'synthetic-second.mp4', type: 'video/mp4', size: 2439, sha256: 'b'.repeat(64) };
  const roles = { therapist: 'synthetic-therapist', guardian: 'synthetic-guardian' };
  const reference = { sourceRecordId: 'source-record', publicationMessageId: 'publication', feedbackId: 'feedback', messageId: 'feedback-message',
    recordId: 'pinned-record', recordRevision: 1, firstFeedbackRevision: 1, currentFeedbackRevision: 2, firstUploadId: first.id, currentUploadId: second.id };
  const original = { id: 'original', conversationId, sequence: 10, authorId: roles.therapist, type: 'text', body: 'synthetic original', version: 1 };
  const quote = { id: 'quote', conversationId, sequence: 11, authorId: roles.guardian, type: 'text', body: 'synthetic quote', version: 1,
    quote: { id: original.id, version: 1, body: original.body } };
  const marker = { id: 'marker', conversationId, sequence: 12, authorId: roles.therapist, type: 'text', body: 'synthetic unread', version: 1 };
  const privateNote = 'SYNTHETIC_PRIVATE_TEXT_REVIEW_ONLY';
  const feedbackNote = 'SYNTHETIC_PRIVATE_F2_REVIEW_ONLY', pinnedBody = 'SYNTHETIC_PINNED_F1_BODY_ONLY';
  const record = { id: reference.recordId, revision: 1, performed: 'SYNTHETIC_PERFORMED_ONLY', response: 'SYNTHETIC_RESPONSE_ONLY',
    nextPlan: 'SYNTHETIC_NEXT_PLAN_ONLY', privateNote: 'SYNTHETIC_RECORD_PRIVATE_NOTE_ONLY', title: 'Synthetic next record',
    summary: 'Synthetic guardian summary', date: '2026-10-20', activity: null,
    assessments: [{ tool: 'ROM', item: 'synthetic motion', value: 0, unit: 'degree', context: 'synthetic first context' },
      { tool: 'MMT', item: 'synthetic strength', value: '3', unit: 'grade', context: 'synthetic second context' }],
    referenceSources: [{ messageId: reference.messageId, feedbackId: reference.feedbackId, feedbackRevision: 1,
      attachmentCount: 1, attachments: [{ id: first.id, name: first.name, type: first.type, size: first.size }] }] };
  const reply = { id: 'connected-reply', conversationId, sequence: 5, authorId: roles.therapist, createdAt: '2026-10-20T01:00:00.000Z',
    type: 'text', body: 'Synthetic public reply remains available', version: 1, hidden: false, archived: false, attachmentCount: 0, attachments: [] };
  const connectedFlow = {
    pinnedFeedback: { messageId: reference.messageId, feedbackId: reference.feedbackId, revision: 1, body: pinnedBody },
    publicReplies: {
      guardian: { ...reply, quote: { id: reference.messageId, hidden: true, body: 'Synthetic source no longer shared' } },
      therapist: { ...reply, quote: { id: reference.messageId, hidden: false, authorId: roles.guardian, body: pinnedBody,
        version: 1, changed: true, feedbackId: reference.feedbackId, feedbackRevision: 1 } },
    },
    nextPublication: { id: 'next-publication-message', conversationId, sequence: 6, authorId: roles.therapist,
      createdAt: '2026-10-20T01:01:00.000Z', type: 'publication', body: record.title, version: null,
      hidden: false, archived: false, attachmentCount: 0, attachments: [],
      publication: { id: 'next-publication-snapshot', recordId: record.id, version: 1, recordRevision: 1,
        date: record.date, title: record.title, summary: record.summary, sharedAt: '2026-10-20T01:01:00.000Z', activity: record.activity } },
    feedbackReview: {
      review: { feedbackId: reference.feedbackId, revision: 2, reviewVersion: 1, note: feedbackNote,
        reviewed: true, reviewedAt: '2026-10-20T01:02:00.000Z' },
      request: { clientId: randomUUID(), expectedRevision: 2, expectedReviewVersion: 0, note: feedbackNote },
      receipt: { feedbackId: reference.feedbackId, revision: 2, reviewVersion: 1, messageId: reference.messageId, operation: 'review', replayed: false },
    },
  };
  return { schema: 2, centerId, conversationId, roles, reference, first, second,
    record, connectedFlow, sourceRecord: { id: reference.sourceRecordId, revision: 1 },
    feedback: { id: reference.feedbackId, revision: 2 }, messages: [original, quote, marker],
    baselines: { guardian: [{ conversationId, lastRead: 11, unread: 1, targetId: marker.id }],
      therapist: [{ conversationId, lastRead: 12, unread: 0, targetId: marker.id }] },
    replay: { pathname: `/api/local/centers/${centerId}/conversations/${conversationId}/feedback/${reference.feedbackId}`,
      body: { clientId: randomUUID(), sourceMessageId: reference.publicationMessageId, expectedRevision: 1, content: { attachments: [{ id: second.id }] } },
      receipt: { feedbackId: reference.feedbackId, messageId: reference.messageId, revision: 2, operation: 'save', replayed: true } },
    textReview: {
      review: { messageId: quote.id, conversationId, revision: 1, reviewVersion: 1, reviewedRevision: 1,
        note: privateNote, body: quote.body, attachmentCount: 0 },
      request: { clientId: randomUUID(), expectedRevision: 1, expectedReviewVersion: 0, note: privateNote },
      receipt: { messageId: quote.id, revision: 1, reviewVersion: 1, operation: 'review', replayed: false },
    },
    forbidden: [first.name, second.name, record.performed, record.response, record.nextPlan, record.privateNote,
      pinnedBody, feedbackNote, privateNote] };
}

test('checkpoint accepts exactly the two existing prepared formats and captures an immutable independent value', () => {
  const input = fixture(), result = validateApiRestartCheckpoint(input, centerId, conversationId);
  assert.deepEqual(result, input); assert.notEqual(result, input); assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.replay.body.content.attachments)); assert(Object.isFrozen(result.messages[1].quote));
  for (const value of [result.textReview, result.textReview.review, result.textReview.request, result.textReview.receipt])
    assert(Object.isFrozen(value));
  input.replay.body.expectedRevision = 2; input.first.name = 'changed'; input.textReview.request.note = 'changed';
  assert.equal(result.replay.body.expectedRevision, 1); assert.equal(result.first.name, 'synthetic-first.png');
  assert.equal(result.textReview.request.note, 'SYNTHETIC_PRIVATE_TEXT_REVIEW_ONLY');
});

test('schema 2 requires the connected flow and exact role projections, publication and F2 review envelopes', () => {
  const changes = [value => { value.schema = 1; }, value => { delete value.schema; }];
  const exactShapes = [
    [value => value, 'connectedFlow', ['pinnedFeedback', 'publicReplies', 'nextPublication', 'feedbackReview']],
    [value => value.connectedFlow, 'pinnedFeedback', ['messageId', 'feedbackId', 'revision', 'body']],
    [value => value.connectedFlow, 'publicReplies', ['guardian', 'therapist']],
    ...['guardian', 'therapist'].map(role => [value => value.connectedFlow.publicReplies, role,
      ['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version', 'hidden', 'archived', 'attachmentCount', 'attachments', 'quote']]),
    [value => value.connectedFlow, 'nextPublication',
      ['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version', 'hidden', 'archived', 'attachmentCount', 'attachments', 'publication']],
    [value => value.connectedFlow.nextPublication, 'publication', ['id', 'recordId', 'version', 'recordRevision', 'date', 'title', 'summary', 'sharedAt', 'activity']],
    [value => value.connectedFlow, 'feedbackReview', ['review', 'request', 'receipt']],
    [value => value.connectedFlow.feedbackReview, 'review', ['feedbackId', 'revision', 'reviewVersion', 'note', 'reviewed', 'reviewedAt']],
    [value => value.connectedFlow.feedbackReview, 'request', ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']],
    [value => value.connectedFlow.feedbackReview, 'receipt', ['feedbackId', 'revision', 'reviewVersion', 'messageId', 'operation', 'replayed']],
  ];
  for (const [parent, key, fields] of exactShapes) {
    changes.push(value => { delete parent(value)[key]; }, value => { parent(value)[key] = null; },
      value => { parent(value)[key] = []; }, value => { parent(value)[key].unexpected = 'not-allowed'; });
    for (const field of fields) changes.push(value => { delete parent(value)[key][field]; });
  }
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('schema 2 captures an independent deeply frozen structured record, public projections and F2 review', () => {
  const input = fixture(), before = structuredClone(input), result = validateApiRestartCheckpoint(input, centerId, conversationId);
  const assertFrozen = item => {
    if (item && typeof item === 'object') { assert(Object.isFrozen(item)); Object.values(item).forEach(assertFrozen); }
  };
  for (const key of ['record', 'connectedFlow']) {
    assert.notEqual(result[key], input[key]); assertFrozen(result[key]);
  }
  input.record.assessments[0].value = 99; input.record.referenceSources[0].attachments[0].name = 'changed';
  input.connectedFlow.pinnedFeedback.body = 'changed';
  input.connectedFlow.publicReplies.guardian.quote.body = 'changed';
  input.connectedFlow.nextPublication.publication.summary = 'changed';
  input.connectedFlow.feedbackReview.request.note = 'changed';
  input.connectedFlow.feedbackReview.receipt.reviewVersion = 9;
  assert.deepEqual(result, before);
  for (const change of [() => { result.record.assessments[0].value = 99; },
    () => { result.record.referenceSources.push({}); },
    () => { result.connectedFlow.pinnedFeedback.body = 'changed'; },
    () => { result.connectedFlow.publicReplies.guardian.quote.body = 'changed'; },
    () => { result.connectedFlow.nextPublication.publication.title = 'changed'; },
    () => { result.connectedFlow.feedbackReview.review.note = 'changed'; },
    () => { result.connectedFlow.feedbackReview.request.expectedRevision = 1; },
    () => { result.connectedFlow.feedbackReview.receipt.replayed = true; }]) assert.throws(change, TypeError);
});

test('connected reply snapshots pin the same message, author, room, F1 quote and chronological separate publication', () => {
  const changes = [
    value => { value.connectedFlow.publicReplies.guardian.id = 'other-reply'; },
    value => { value.connectedFlow.publicReplies.therapist.body = 'other-body'; },
    value => { value.connectedFlow.publicReplies.therapist.sequence += 1; },
    value => { for (const reply of Object.values(value.connectedFlow.publicReplies)) reply.body = ''; },
    value => { value.connectedFlow.publicReplies.therapist.quote.id = 'other-message'; },
    value => { value.connectedFlow.publicReplies.therapist.quote.feedbackId = 'other-feedback'; },
    value => { value.connectedFlow.publicReplies.therapist.quote.feedbackRevision = 2; },
    value => { value.connectedFlow.publicReplies.therapist.quote.body = 'current-instead-of-pinned'; },
    value => { value.connectedFlow.publicReplies.therapist.quote.hidden = true; },
    value => { value.connectedFlow.publicReplies.therapist.quote.attachments = []; },
    value => { value.connectedFlow.nextPublication.id = value.reference.publicationMessageId; },
    value => { value.connectedFlow.nextPublication.id = value.connectedFlow.publicReplies.guardian.id; },
    value => { value.connectedFlow.nextPublication.sequence = value.connectedFlow.publicReplies.guardian.sequence; },
    value => { value.connectedFlow.nextPublication.sequence = value.messages[0].sequence; },
  ];
  for (const message of [value => value.connectedFlow.publicReplies.guardian, value => value.connectedFlow.publicReplies.therapist,
    value => value.connectedFlow.nextPublication]) {
    changes.push(value => { message(value).authorId = value.roles.guardian; },
      value => { message(value).conversationId = 'other-room'; }, value => { message(value).hidden = true; },
      value => { message(value).archived = true; }, value => { message(value).createdAt = 'not-a-date'; },
      value => { message(value).sequence = 0; }, value => { message(value).type = 'feedback'; });
  }
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejectedComparison);
  }
});

test('guardian withdrawn quote contains only a hidden notice without old source or metadata', () => {
  const changes = [value => { value.connectedFlow.publicReplies.guardian.quote.id = 'other-source'; },
    value => { value.connectedFlow.publicReplies.guardian.quote.hidden = false; },
    value => { value.connectedFlow.publicReplies.guardian.quote.body = ''; },
    value => { value.connectedFlow.publicReplies.guardian.quote.body = value.connectedFlow.pinnedFeedback.body; }];
  for (const key of ['authorId', 'preview', 'version', 'changed', 'feedbackId', 'feedbackRevision', 'attachments'])
    changes.push(value => { value.connectedFlow.publicReplies.guardian.quote[key] = 'hidden-metadata'; });
  for (const key of ['id', 'hidden', 'body']) changes.push(value => { delete value.connectedFlow.publicReplies.guardian.quote[key]; });
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('structured next record requires three basics, a private note, two distinct measurements and pinned F1 source', () => {
  const changes = [];
  for (const key of ['performed', 'response', 'nextPlan', 'privateNote', 'title', 'summary', 'date']) {
    for (const invalid of [undefined, '', null, 1]) changes.push(value => { value.record[key] = invalid; });
  }
  for (const invalid of [undefined, null, [], [{}], [{}, {}, {}]]) changes.push(value => { value.record.assessments = invalid; });
  for (const key of ['tool', 'item', 'value', 'unit', 'context']) changes.push(value => { delete value.record.assessments[0][key]; });
  for (const key of ['tool', 'item', 'unit', 'context']) changes.push(value => { value.record.assessments[1][key] = ''; });
  for (const invalid of ['', null, false, 'not-a-number', Infinity, NaN]) changes.push(value => { value.record.assessments[0].value = invalid; });
  changes.push(value => { value.record.assessments[0].extra = 'not-allowed'; },
    value => { value.record.assessments[1] = structuredClone(value.record.assessments[0]); });
  for (const invalid of [undefined, null, [], [{}, {}]]) changes.push(value => { value.record.referenceSources = invalid; });
  changes.push(value => { value.record.referenceSources[0].messageId = 'other-message'; },
    value => { value.record.referenceSources[0].feedbackId = 'other-feedback'; },
    value => { value.record.referenceSources[0].feedbackRevision = 2; });
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('feedback reference DTO needs no body; exact F1 response supplies its independent pinned body', () => {
  const value = fixture(), before = structuredClone(value.record.referenceSources);
  assert.equal(Object.hasOwn(value.record.referenceSources[0], 'body'), false);
  assert.deepEqual(Object.keys(value.record.referenceSources[0]).sort(),
    ['messageId', 'feedbackId', 'feedbackRevision', 'attachmentCount', 'attachments'].sort());
  const result = validateApiRestartCheckpoint(value, centerId, conversationId);
  assert.deepEqual(result.record.referenceSources, before);
  assert.equal(Object.hasOwn(result.record.referenceSources[0], 'body'), false);
  assert.equal(result.connectedFlow.pinnedFeedback.body, result.connectedFlow.publicReplies.therapist.quote.body);
});

test('pinned F1 evidence rejects another source, current revision, missing body or a mismatched quote', () => {
  const changes = [
    value => { value.connectedFlow.pinnedFeedback.messageId = 'other-message'; },
    value => { value.connectedFlow.pinnedFeedback.feedbackId = 'other-feedback'; },
    value => { value.connectedFlow.pinnedFeedback.revision = 2; },
    value => { value.connectedFlow.pinnedFeedback.body = 'current-not-pinned'; },
    value => { value.connectedFlow.publicReplies.therapist.quote.body = 'other-quote'; },
    value => { value.forbidden = value.forbidden.filter(item => item !== value.connectedFlow.pinnedFeedback.body); },
  ];
  for (const invalid of [undefined, null, '', 1]) changes.push(value => { value.connectedFlow.pinnedFeedback.body = invalid; });
  for (const change of changes) {
    const value = fixture(); change(value);
    assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejectedComparison);
  }
});

test('independent publication pins the next record revision and exactly the selected public fields', () => {
  const changes = [value => { value.connectedFlow.nextPublication.publication.id = '../private'; },
    value => { value.connectedFlow.nextPublication.publication.recordId = value.reference.sourceRecordId; },
    value => { value.connectedFlow.nextPublication.publication.recordRevision = 2; },
    value => { value.connectedFlow.nextPublication.publication.version = 2; }];
  for (const key of ['date', 'title', 'summary', 'activity']) changes.push(value => { value.connectedFlow.nextPublication.publication[key] = 'different'; });
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejectedComparison);
  }
});

test('public connected flow rejects internal record or review strings and unexpected attachment projections', () => {
  const hiddenNames = value => [value.record.performed, value.record.response, value.record.nextPlan, value.record.privateNote,
    value.connectedFlow.pinnedFeedback.body, value.first.name, value.second.name,
    value.textReview.review.note, value.connectedFlow.feedbackReview.review.note];
  for (let index = 0; index < hiddenNames(fixture()).length; index += 1) {
    for (const target of ['reply', 'publication-body', 'publication-summary', 'forbidden']) {
      const value = fixture(), hidden = hiddenNames(value)[index];
      if (target === 'reply') for (const reply of Object.values(value.connectedFlow.publicReplies)) reply.body = 'Public: ' + hidden;
      else if (target === 'publication-body') value.connectedFlow.nextPublication.body = 'Public: ' + hidden;
      else if (target === 'publication-summary') {
        // Keep record and share matching: rejection must be the privacy guard, not a stale summary mismatch.
        value.record.summary = 'Public: ' + hidden; value.connectedFlow.nextPublication.publication.summary = value.record.summary;
      } else value.forbidden = value.forbidden.filter(item => item !== hidden);
      assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
    }
  }
  for (const target of [value => value.connectedFlow.publicReplies.guardian, value => value.connectedFlow.publicReplies.therapist,
    value => value.connectedFlow.nextPublication]) {
    for (const change of [item => { item.attachmentCount = 1; },
      (item, value) => { item.attachments = [{ id: value.first.id, name: value.first.name }]; },
      (item, value) => { item.attachmentCount = 1; item.attachments = [{ id: value.second.id }]; }]) {
      const value = fixture(); change(target(value), value);
      assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejectedComparison);
    }
  }
});

test('F2 private review pins current feedback, reviewed state and its original 0-to-1 committed request and receipt', () => {
  for (const change of [review => { review.review.feedbackId = 'other-feedback'; },
    review => { review.review.revision = 1; }, review => { review.review.reviewVersion = 2; },
    review => { review.review.reviewed = false; }, review => { review.review.reviewedAt = 'not-a-date'; },
    review => { review.request.clientId = 'not-a-uuid'; }, review => { review.request.expectedRevision = 1; },
    review => { review.request.expectedReviewVersion = 1; }, review => { review.request.note = 'not-the-committed-note'; },
    review => { review.receipt.feedbackId = 'other-feedback'; }, review => { review.receipt.messageId = 'other-message'; },
    review => { review.receipt.revision = 1; }, review => { review.receipt.reviewVersion = 2; },
    review => { review.receipt.operation = 'save'; }, review => { review.receipt.replayed = true; }]) {
    const value = fixture(); change(value.connectedFlow.feedbackReview);
    assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('F2 private note is normalized, bounded and included in public leak screening', () => {
  const setNote = (value, note) => {
    const review = value.connectedFlow.feedbackReview, previous = review.review.note;
    review.review.note = note; review.request.note = note;
    value.forbidden[value.forbidden.indexOf(previous)] = note;
  };
  for (const note of ['가상 F2 검토\n두 번째 줄\t확인\r정리', 'x'.repeat(2000)]) {
    const value = fixture(); setNote(value, note);
    assert.equal(validateApiRestartCheckpoint(value, centerId, conversationId).connectedFlow.feedbackReview.review.note, note);
  }
  for (const note of ['', ' ', ' leading', 'trailing ', 'x'.repeat(2001), '\u0000', '\u000b', '\u007f', '\u0085', '\ud800', 1, null]) {
    const value = fixture(); setNote(value, note);
    assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
  const value = fixture(); value.forbidden = value.forbidden.filter(item => item !== value.connectedFlow.feedbackReview.review.note);
  assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
});

test('C05 checkpoint requires exact private read, original command and original success receipt objects', () => {
  const changes = [value => { delete value.textReview; }, value => { value.textReview = null; },
    value => { value.textReview = []; }, value => { value.textReview.internal = 'not-allowed'; }];
  for (const [section, keys] of Object.entries({
    review: ['messageId', 'conversationId', 'revision', 'reviewVersion', 'reviewedRevision', 'note', 'body', 'attachmentCount'],
    request: ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note'],
    receipt: ['messageId', 'revision', 'reviewVersion', 'operation', 'replayed'],
  })) {
    changes.push(value => { value.textReview[section] = null; }, value => { value.textReview[section] = []; },
      value => { value.textReview[section].unexpected = 'not-allowed'; });
    for (const key of keys) changes.push(value => { delete value.textReview[section][key]; });
  }
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('C05 checkpoint pins the incoming ordinary text and cannot substitute a feedback, room or current body', () => {
  for (const change of [value => { value.textReview.review.messageId = value.reference.messageId; },
    value => { value.textReview.review.conversationId = 'different-room'; },
    value => { value.textReview.review.body = 'different-original'; },
    value => { value.textReview.review.attachmentCount = 1; },
    value => { value.textReview.review.revision = 2; },
    value => { value.messages[1].version = 2; },
    value => { value.messages[1].authorId = value.roles.therapist; },
    value => { value.textReview.receipt.messageId = value.messages[0].id; }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('C05 checkpoint preserves exactly the first committed 0-to-1 command for restart receipt replay', () => {
  for (const change of [value => { value.textReview.request.clientId = 'not-a-uuid'; },
    value => { value.textReview.request.expectedRevision = 2; },
    value => { value.textReview.request.expectedReviewVersion = 1; },
    value => { value.textReview.request.note = 'not-the-committed-note'; },
    value => { value.textReview.review.reviewVersion = 2; },
    value => { value.textReview.review.reviewedRevision = null; },
    value => { value.textReview.receipt.revision = 2; },
    value => { value.textReview.receipt.reviewVersion = 2; },
    value => { value.textReview.receipt.operation = 'save'; },
    value => { value.textReview.receipt.replayed = true; }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('C05 checkpoint accepts normalized bounded notes but refuses malformed or unscreened private text', () => {
  const setNote = (value, note) => {
    value.textReview.review.note = note; value.textReview.request.note = note; value.forbidden[value.forbidden.length - 1] = note;
  };
  for (const note of ['가상 메모\n두 번째 줄\t확인\r정리', 'x'.repeat(2000)]) {
    const value = fixture(); setNote(value, note);
    assert.equal(validateApiRestartCheckpoint(value, centerId, conversationId).textReview.review.note, note);
  }
  for (const note of ['', ' ', ' leading', 'trailing ', 'x'.repeat(2001), '\u0000', '\u000b', '\u007f', '\u0085', '\ud800', 1, null]) {
    const value = fixture(); setNote(value, note);
    assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
  const value = fixture(); value.forbidden = value.forbidden.filter(item => item !== value.textReview.review.note);
  assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
});

test('checkpoint rejects another tenant, room, role and malformed anchored identifiers', () => {
  for (const change of [value => { value.centerId = 'another'; }, value => { value.conversationId = 'another'; },
    value => { value.roles.guardian = value.roles.therapist; }, value => { value.roles.guardian = '../private'; },
    value => { value.reference.recordId = '../private'; }, value => { value.reference.firstUploadId = randomUUID(); }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('checkpoint rejects different pinned/current revisions and file metadata or hashes', () => {
  for (const change of [value => { value.reference.recordRevision = 2; }, value => { value.feedback.revision = 1; },
    value => { value.record.id = 'different'; }, value => { value.reference.currentFeedbackRevision = 3; },
    value => { value.second.type = 'video/webm'; }, value => { value.first.size = 11 * 1024 ** 2; },
    value => { value.second.sha256 = value.first.sha256; }, value => { value.first.sha256 = 'private'; }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('checkpoint rejects replay path escape or a changed original committed operation', () => {
  for (const change of [value => { value.replay.pathname = 'https://example.test'; }, value => { value.replay.body.expectedRevision = 2; },
    value => { value.replay.body.sourceMessageId = 'different'; }, value => { value.replay.body.clientId = 'not-a-uuid'; },
    value => { value.replay.body.content.attachments = [{ id: value.first.id }]; },
    value => { value.replay.receipt.replayed = false; }, value => { value.replay.receipt.revision = 3; }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('checkpoint requires a chronological independent quote and separate unread/read baselines', () => {
  for (const change of [value => { value.messages[1].quote.version = 2; }, value => { value.messages[1].quote.body = 'changed'; },
    value => { value.messages[2].sequence = 9; }, value => { value.messages[2].id = value.messages[0].id; },
    value => { value.baselines.guardian[0].unread = 0; }, value => { value.baselines.therapist[0].unread = 1; },
    value => { value.baselines.guardian.push(value.baselines.guardian[0]); }, value => { value.baselines.guardian[0].lastRead = -1; }]) {
    const value = fixture(); change(value); assert.throws(() => validateApiRestartCheckpoint(value, centerId, conversationId), rejected);
  }
});

test('C05 restart checks remain bounded alongside the existing boundaries and current-reference reads', async () => {
  const baseline = {
    'native-feedback-attachments-browser-helper.mjs': ['publication', 'firstFeedback', 'pinnedReference', 'replacementRetry',
      'publicReply', 'privateReview', 'nextStructuredRecord', 'nextRecordShare', 'independentSharePreserved',
      'currentSecondFile', 'pinnedFirstFile', 'unsavedCurrentReferencePhoto', 'currentReferenceVideo',
      'withdrawalDenial', 'retainedReference', 'reload'],
    'native-api-restart-browser-helper.mjs': ['freshLogin', 'homeReadState', 'messagesAndQuote', 'recordAndFeedback',
      'pinnedAndCurrentFiles', 'withdrawalDenial', 'roleReadIsolation', 'databaseReceiptReplay'],
  };
  for (const [name, keys] of Object.entries(baseline)) {
    const source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
    const expression = source.match(/checks: (\{[\s\S]+?\}),\r?\n    (?:contentEvidence|source):/);
    assert(expression, 'Expected the checked-in bounded check initializer');
    for (const prepareRestart of [false, true]) {
      // Only this inert object initializer is evaluated, never the runner.
      const checks = runInNewContext('(' + expression[1] + ')', { prepareRestart }, { timeout: 1000 });
      const extra = name === 'native-api-restart-browser-helper.mjs'
        ? ['textReviewRestored', 'textReviewPrivacy', 'textReviewReceiptReplay',
          'connectedPublicFlow', 'structuredRecordFields', 'currentFeedbackReviewRestored', 'currentFeedbackReviewReplay']
        : prepareRestart ? ['textReviewStored', 'textReviewPrivacy', 'currentFeedbackReviewStored'] : [];
      assert.deepEqual(Object.keys(checks), [...keys, ...extra]); assert(Object.values(checks).every(value => value === false));
    }
  }
});

test('restart runner explicitly waits for closed old browser and successful old API before new browser', async () => {
  const source = await readFile(new URL('./windows-synthetic-session-check.mjs', import.meta.url), 'utf8');
  const cleanup = source.indexOf('assert.equal(firstBrowser.cleanup.browserStopped,true)');
  const restart = source.indexOf('await session.restartApi()');
  const old = source.indexOf('assert(old.terminal&&old.stopped&&old.closeObserved&&old.stdioClosed');
  const next = source.indexOf('await exerciseApiRestartBrowser(');
  assert(cleanup > 0 && cleanup < restart && restart < old && old < next);
  const observation = source.indexOf('assert.equal(firstBrowser.cleanupObservationTimedOut,false)');
  assert(observation > cleanup && observation < restart);
  assert(source.includes('report.browser=structuredClone(firstBrowser)'));
  assert(source.includes('credentials:apiRestart?credentials.map(value=>({...value})):credentials'));
  assert(source.includes('for(const credential of credentials){credential.email=\'\';credential.password=\'\';}credentials.length=0'));
});

test('all native browser helpers fail verification after a cleanup observation timeout even if eventual closure succeeds', async () => {
  for (const name of ['native-api-restart-browser-helper.mjs', 'native-feedback-attachments-browser-helper.mjs',
    'native-record-attachments-browser-helper.mjs', 'native-prepared-media-browser-helper.mjs']) {
    const source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
    const result = source.match(/report\.passed = ([\s\S]+?);/);
    assert(result && result[1].includes('!report.cleanupObservationTimedOut'));
    assert(result[1].includes('Object.values(report.cleanup).every(Boolean)'));
  }
});

test('real observer snippets emit fixed diagnostics, retain entry phase and never publish response or error contents', async () => {
  // Execute only the checked-in observer blocks with synthetic response doubles.
  // This covers diagnostic classification, not actual browser/network delivery.
  for (const name of ['native-feedback-attachments-browser-helper.mjs', 'native-api-restart-browser-helper.mjs']) {
    const source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
    const start = source.indexOf('const observationPhase = phase;');
    const end = source.indexOf('observers.add(observation);', start);
    assert(start > 0 && end > start);
    const block = source.slice(start, end + 'observers.add(observation);'.length);
    assert.deepEqual([...block.matchAll(/observationStage = '([^']+)'/g)].map(match => match[1]),
      ['anchor', 'headers', 'body-read', 'body-size', 'evidence']);
    for (const failure of [null, 'anchor', 'headers', 'body-read', 'body-size', 'evidence']) {
      const bytes = Buffer.from([1, 2, 3]), errors = [], observers = new Set(), contentEvidence = [];
      const privateError = () => new Error('PRIVATE_ERROR https://private.test/body PRIVATE_HEADER');
      if (failure === 'evidence') contentEvidence.push = () => { throw privateError(); };
      const state = {
        assert, code: 'FIXED_FAILURE', phase: 'ENTRY_PHASE', role: failure === 'anchor' ? 'guardian' : 'therapist',
        report: { errors, contentEvidence }, observers,
        note: (collection, value) => collection.push(value),
        uuid: () => true, sha: () => 'a'.repeat(64),
        anchor: { uploadId: 'synthetic-upload' }, reference: true, feedback: false,
        r: { recordId: 'synthetic-record', messageId: 'synthetic-message' },
        file: { id: 'synthetic-upload', type: 'image/png', size: failure === 'body-size' ? 4 : 3, sha256: 'a'.repeat(64) },
        response: {
          headers: () => {
            if (failure === 'headers') throw privateError();
            return { 'content-type': 'image/png', 'content-length': failure === 'body-size' ? '4' : '3',
              'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'private-header': 'PRIVATE_HEADER' };
          },
          body: async () => { if (failure === 'body-read') throw privateError(); return bytes; },
        },
      };
      runInNewContext(block + "\nphase = 'LATER_PHASE';", state, { timeout: 1000 });
      await Promise.all([...observers]); assert.equal(observers.size, 0);
      if (failure === null) {
        assert.equal(errors.length, 0); assert.equal(contentEvidence.length, 1);
      } else {
        assert.equal(errors.length, 1);
        const error = errors[0];
        assert.deepEqual(Object.keys(error), ['role', 'phase', 'type', 'stage', 'category']);
        assert.equal(error.phase, 'ENTRY_PHASE'); assert.equal(error.type, 'content-observation'); assert.equal(error.stage, failure);
        assert.equal(error.category, ['anchor', 'body-size'].includes(failure) ? 'assertion' : failure === 'body-read' ? 'body-read-failed' : 'runtime');
        assert(!JSON.stringify(error).includes('PRIVATE')); assert(!JSON.stringify(error).includes('https:'));
        assert.equal(contentEvidence.length, 0);
      }
      if ([null, 'body-size', 'evidence'].includes(failure)) assert(bytes.every(value => value === 0));
    }
  }
});
