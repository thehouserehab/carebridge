import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { feedbackSessionCheckOptions, feedbackAttachmentSamples, attachRestartCheckpoint,
  assertCurrentReferenceContentEvidence, revealFeedbackRecordReference, assertRetainedReplyRedaction, stableConnectedMessage } from './native-feedback-attachments-browser-helper.mjs';
import { pngChunks } from '../server/image-metadata-test-fixtures.mjs';
import { NATIVE_SYNTHETIC_VIDEO } from './native-video-fixture.mjs';

const args = ['--base', 'E:\\SyntheticTest', '--powershell', 'C:\\Runtime\\pwsh.exe', '--confirm-synthetic-e-drive'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('feedback mode preserves default and record mode argument contracts', () => {
  for (const [input, record] of [[args, false], [['--record-attachments', ...args], true]]) {
    const result = feedbackSessionCheckOptions(input);
    assert.equal(result.feedbackAttachments, false); assert.equal(result.recordAttachments, record);
    assert.deepEqual(result.args, args); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args));
  }
});

test('one leading feedback flag selects a fresh session without mutating caller arguments', () => {
  const input = ['--feedback-attachments', ...args], result = feedbackSessionCheckOptions(input);
  assert.equal(result.feedbackAttachments, true); assert.equal(result.recordAttachments, false);
  assert.deepEqual(result.args, args); input[2] = 'E:\\Changed'; assert.equal(result.args[1], 'E:\\SyntheticTest');
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args));
});

test('feedback mode rejects combined, duplicate, trailing, resume and credential flags', () => {
  for (const input of [null, [], ['--feedback-attachments'], ['--feedback-attachments', '--feedback-attachments', ...args],
    ['--feedback-attachments', '--record-attachments', ...args], ['--record-attachments', '--feedback-attachments', ...args],
    [...args, '--feedback-attachments'], ['--feedback-attachments', ...args, '--resume', 'existing'],
    ['--feedback-attachments', ...args, '--password', 'synthetic'], ['--feedback-attachments', '--base', 'C:\\SyntheticTest', ...args.slice(2)]])
    assert.throws(() => feedbackSessionCheckOptions(input));
});

test('API restart is a separate explicit fresh-session mode using the existing feedback flow', () => {
  const input = ['--api-restart', ...args], result = feedbackSessionCheckOptions(input);
  assert.equal(result.apiRestart, true); assert.equal(result.feedbackAttachments, true); assert.equal(result.recordAttachments, false);
  assert.deepEqual(result.args, args); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args));
  input[2] = 'E:\\Changed'; assert.equal(result.args[1], args[1]);
  for (const invalid of [['--api-restart'], ['--api-restart', '--api-restart', ...args],
    ['--api-restart', '--feedback-attachments', ...args], ['--feedback-attachments', '--api-restart', ...args],
    ['--api-restart', '--record-attachments', ...args], [...args, '--api-restart'],
    ['--api-restart', ...args, '--resume', 'previous'], ['--api-restart', ...args, '--password', 'private']])
    assert.throws(() => feedbackSessionCheckOptions(invalid));
});

test('restart handoff is cloned, deeply frozen and excluded from JSON, spreading and structuredClone', () => {
  const original = { replay: { body: { clientId: 'synthetic', content: { reaction: 'MEMORY_ONLY_PAYLOAD' } } }, values: [1] };
  const report = { passed: true, checks: { reload: true } };
  assert.equal(attachRestartCheckpoint(report, original), report);
  original.replay.body.content.reaction = 'changed'; original.values.push(2);
  assert.equal(report.restartCheckpoint.replay.body.content.reaction, 'MEMORY_ONLY_PAYLOAD');
  assert.deepEqual(report.restartCheckpoint.values, [1]);
  for (const value of [report.restartCheckpoint, report.restartCheckpoint.replay, report.restartCheckpoint.replay.body.content, report.restartCheckpoint.values])
    assert(Object.isFrozen(value));
  assert.equal(Object.getOwnPropertyDescriptor(report, 'restartCheckpoint').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(report, 'restartCheckpoint').writable, false);
  assert(!JSON.stringify(report).includes('MEMORY_ONLY')); assert(!Object.hasOwn({ ...report }, 'restartCheckpoint'));
  assert(!Object.hasOwn(structuredClone(report), 'restartCheckpoint'));
});

test('reply attachment mode is explicit, exclusive and preserves fresh E session arguments', () => {
  const input = ['--reply-attachments', ...args], result = feedbackSessionCheckOptions(input);
  assert.deepEqual(result, { args, recordAttachments: false, feedbackAttachments: false, replyAttachments: true });
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args));
  input[2] = 'E:\\Changed'; assert.equal(result.args[1], args[1]);
  for (const invalid of [['--reply-attachments'], ['--reply-attachments', '--reply-attachments', ...args],
    ['--reply-attachments', '--api-restart', ...args], ['--api-restart', '--reply-attachments', ...args],
    ['--reply-attachments', '--record-attachments', ...args], ['--feedback-attachments', '--reply-attachments', ...args],
    [...args, '--reply-attachments'], ['--reply-attachments', ...args, '--resume', 'previous'],
    ['--reply-attachments', ...args, '--password', 'private']]) assert.throws(() => feedbackSessionCheckOptions(invalid));
});

test('C05 original review note and replay command stay in nonenumerable memory-only restart handoff', () => {
  const note = 'SYNTHETIC_C05_NOTE_NEVER_REPORT', body = 'SYNTHETIC_C05_BODY_NEVER_REPORT';
  const input = { textReview: {
    review: { messageId: 'synthetic-message', conversationId: 'synthetic-room', revision: 1,
      reviewVersion: 1, reviewedRevision: 1, note, body, attachmentCount: 0 },
    request: { clientId: 'synthetic-command', expectedRevision: 1, expectedReviewVersion: 0, note },
    receipt: { messageId: 'synthetic-message', revision: 1, reviewVersion: 1, operation: 'review', replayed: false },
  } };
  const report = attachRestartCheckpoint({ passed: true, checks: { textReviewSaved: true } }, input);
  input.textReview.review.note = 'changed'; input.textReview.request.note = 'changed'; input.textReview.receipt.reviewVersion = 2;
  assert.equal(report.restartCheckpoint.textReview.review.note, note);
  assert.equal(report.restartCheckpoint.textReview.request.note, note);
  assert.equal(report.restartCheckpoint.textReview.receipt.reviewVersion, 1);
  for (const value of [report.restartCheckpoint.textReview, ...Object.values(report.restartCheckpoint.textReview)]) assert(Object.isFrozen(value));
  for (const publicReport of [report, { ...report }, structuredClone(report)]) {
    const serialized = JSON.stringify(publicReport);
    assert(!serialized.includes(note)); assert(!serialized.includes(body)); assert(!serialized.includes('synthetic-command'));
    assert(!serialized.includes('textReview"')); assert(!serialized.includes('restartCheckpoint'));
  }
});

test('exactly one synthetic PNG and the previously fixed MP4 use 120 MiB format reservations', () => {
  const files = feedbackAttachmentSamples(); assert.equal(files.length, 2);
  assert.deepEqual(files.map(file => file.type), ['image/png', 'video/mp4']);
  assert(files.every(file => Buffer.isBuffer(file.bytes) && file.bytes.length > 0));
  const chunks = pngChunks(files[0].bytes), ihdr = chunks.find(chunk => chunk.kind === 'IHDR').data;
  assert.equal(ihdr.readUInt32BE(0), 32); assert.equal(ihdr.readUInt32BE(4), 24);
  assert.equal(inflateSync(Buffer.concat(chunks.filter(chunk => chunk.kind === 'IDAT').map(chunk => chunk.data))).length, 24 * 97);
  assert.equal(files[1].bytes.length, NATIVE_SYNTHETIC_VIDEO.size); assert.equal(hash(files[1].bytes), NATIVE_SYNTHETIC_VIDEO.sha256);
  assert.equal(files.reduce((n, file) => n + (file.type === 'image/png' ? 20 : 100), 0), 120);
  assert.notEqual(hash(files[0].bytes), hash(files[1].bytes));
  const fresh = feedbackAttachmentSamples(); files[0].bytes.fill(0); files[1].bytes.fill(0);
  assert.equal(hash(fresh[1].bytes), NATIVE_SYNTHETIC_VIDEO.sha256); assert.notEqual(fresh[0].bytes[0], 0);
});

test('all three native modes fingerprint the new runtime dependency and exact runner', async () => {
  // Static closure coverage only, not E-drive, native engine or browser proof.
  for (const name of ['native-feedback-attachments-browser-helper.mjs', 'native-record-attachments-browser-helper.mjs', 'native-prepared-media-browser-helper.mjs', 'native-api-restart-browser-helper.mjs']) {
    const source = await readFile(new URL('./' + name, import.meta.url), 'utf8');
    const list = source.slice(source.indexOf('async function sources()'), source.indexOf('function processLifetime'));
    for (const dependency of ['native-feedback-attachments-browser-helper.mjs', 'native-record-attachments-browser-helper.mjs',
      'native-prepared-media-browser-helper.mjs', 'native-api-restart-browser-helper.mjs', 'native-interactive-care-browser-helper.mjs',
      'native-reply-source-browser-helper.mjs', 'windows-synthetic-session-check.mjs'])
      assert.equal(list.split("'tests/" + dependency + "'").length - 1, 1);
  }
});

test('current reference evidence requires a fresh current-message response matching the native candidate bytes', () => {
  const file = { id: 'a1111111-1111-4111-8111-111111111111', type: 'video/mp4', size: 321 };
  const expected = { messageId: 'synthetic-feedback-message', file, expectedSha256: 'a'.repeat(64) };
  const item = { role: 'therapist', kind: 'current-message', messageId: expected.messageId,
    uploadId: file.id, type: file.type, size: file.size, sha256: expected.expectedSha256 };
  const evidence = [{ ...item, kind: 'feedback-revision' }, item], before = structuredClone(evidence);
  assert.equal(assertCurrentReferenceContentEvidence(evidence, 1, expected), 1);
  assert.deepEqual(evidence, before);
  assert.throws(() => assertCurrentReferenceContentEvidence(evidence, evidence.length, expected));
  assert.throws(() => assertCurrentReferenceContentEvidence(evidence, 0, expected));
  for (const change of [{ kind: 'feedback-revision' }, { kind: 'record-reference' }, { role: 'guardian' },
    { messageId: 'other-message' }, { uploadId: 'b2222222-2222-4222-8222-222222222222' },
    { type: 'image/png' }, { size: 320 }, { sha256: 'b'.repeat(64) }])
    assert.throws(() => assertCurrentReferenceContentEvidence([{ ...item, ...change }], 0, expected));
});

test('feedback native scenario retains original checks and adds current-photo and current-video reads without a third upload', async () => {
  // Harness construction proof only. Actual native bytes/UI require the owner run.
  const source = await readFile(new URL('./native-feedback-attachments-browser-helper.mjs', import.meta.url), 'utf8');
  assert(source.includes("unsavedCurrentReferencePhoto: false, currentReferenceVideo: false"));
  assert(source.includes("report.checks.unsavedCurrentReferencePhoto = true"));
  assert(source.includes("report.checks.currentReferenceVideo = true"));
  assert(source.includes("await currentReferenceFile(messageId, first, f1Evidence.sha256"));
  assert(source.includes("await currentReferenceFile(messageId, second, f2Evidence.sha256"));
  assert(source.includes("assert.deepEqual(await recordInput(), inputBefore, code)"));
  assert(source.includes("assert.equal(therapistRoomPosts, postsBefore, code)"));
  assert(source.includes("/records/' + recordId, 200)).record, savedBeforeCurrent"));
  assert.equal((source.match(/await uploadFeedback\(/g) ?? []).length, 2);
});

// Locator doubles only; actual native-browser evidence is separate.
function referenceDisclosure({ open = false, references = 1, containers = 1, opens = true } = {}) {
  const calls = [];
  const details = {
    count: async () => containers,
    getAttribute: async name => { assert.equal(name, 'open'); calls.push('read-open'); return open ? '' : null; },
    locator: selector => {
      assert.equal(selector, ':scope > summary');
      return { click: async options => { assert.equal(options, undefined); calls.push('click-summary'); if (opens) open = true; } };
    },
  };
  const reference = {
    waitFor: async ({ state }) => {
      calls.push('wait-' + state);
      assert(references > 0); if (state === 'visible') assert(open);
    },
    count: async () => references,
    locator: selector => { assert.equal(selector, 'xpath=ancestor::details[@data-record-references]'); return details; },
  };
  const dialog = { locator: selector => { assert.equal(selector, '[data-reference-message-id="synthetic-message"]'); return reference; } };
  return { dialog, reference, calls };
}

test('a collapsed reference is opened through its ordinary summary before awaiting visible content', async () => {
  const fixture = referenceDisclosure();
  assert.equal(await revealFeedbackRecordReference(fixture.dialog, 'synthetic-message'), fixture.reference);
  assert.deepEqual(fixture.calls, ['wait-attached', 'read-open', 'click-summary', 'wait-visible']);
});

test('an already open reference is not toggled closed', async () => {
  const fixture = referenceDisclosure({ open: true });
  await revealFeedbackRecordReference(fixture.dialog, 'synthetic-message');
  assert.deepEqual(fixture.calls, ['wait-attached', 'read-open', 'wait-visible']);
});

test('missing or ambiguous references and containers are rejected without clicking', async () => {
  for (const options of [{ references: 0 }, { references: 2 }, { containers: 0 }, { containers: 2 }]) {
    const fixture = referenceDisclosure(options);
    await assert.rejects(revealFeedbackRecordReference(fixture.dialog, 'synthetic-message'));
    assert(!fixture.calls.includes('click-summary'));
  }
});

test('a click that leaves the reference hidden is not considered a successful reveal', async () => {
  const fixture = referenceDisclosure({ opens: false });
  await assert.rejects(revealFeedbackRecordReference(fixture.dialog, 'synthetic-message'));
  assert.deepEqual(fixture.calls, ['wait-attached', 'read-open', 'click-summary', 'wait-visible']);
});

test('invalid reference identifiers never reach a locator', async () => {
  const dialog = { locator: () => { assert.fail('Must reject before accessing the UI'); } };
  for (const invalid of ['', 'invalid"]', null]) await assert.rejects(revealFeedbackRecordReference(dialog, invalid));
});

const redactionExpected = { replyId: 'synthetic-reply', sourceId: 'synthetic-source', body: '가상 독립 답장',
  privateValues: ['가상 원본 내용', 'synthetic-private.png', '가상 비공개 검토'] };
const redactedReply = () => ({ id: redactionExpected.replyId, body: redactionExpected.body, hidden: false,
  quote: { id: redactionExpected.sourceId, hidden: true, body: '공유가 종료된 소식입니다.' } });

test('retained public reply preserves its own body and only a minimal hidden source quote', () => {
  const message = redactedReply(), before = structuredClone(message);
  assertRetainedReplyRedaction(message, redactionExpected);
  assert.deepEqual(message, before);
});

test('retained reply rejects missing, visible, wrong-source or metadata-bearing quotes', () => {
  for (const change of [{ quote: undefined }, { quote: { ...redactedReply().quote, hidden: false } },
    { quote: { ...redactedReply().quote, id: 'different-source' } },
    { quote: { ...redactedReply().quote, feedbackId: 'synthetic-feedback' } },
    { quote: { ...redactedReply().quote, feedbackRevision: 1 } },
    { quote: { ...redactedReply().quote, body: '' } },
    { id: 'different-reply' }, { hidden: true }, { body: 'changed reply' }])
    assert.throws(() => assertRetainedReplyRedaction({ ...redactedReply(), ...change }, redactionExpected));
});

test('private source text, filename or review cannot leak elsewhere in the retained public response', () => {
  for (const value of redactionExpected.privateValues) {
    assert.throws(() => assertRetainedReplyRedaction({ ...redactedReply(), extra: { detail: value } }, redactionExpected));
    assert.throws(() => assertRetainedReplyRedaction({ ...redactedReply(), quote: { ...redactedReply().quote, body: value } }, redactionExpected));
  }
});

test('connected message snapshot omits viewer/time-dependent flags and clones nested public values', () => {
  const message = { id: 'message', body: 'synthetic', read: true, canEdit: false, canReply: true,
    quote: { id: 'source', hidden: true, body: 'redacted' }, attachments: [],
    publication: { recordId: 'record', recordRevision: 1 }, unexpectedPrivate: 'NEVER_COPIED' };
  const snapshot = stableConnectedMessage(message);
  assert.deepEqual(Object.keys(snapshot), ['id', 'body', 'quote', 'publication', 'attachments']);
  message.quote.body = 'changed'; message.publication.recordRevision = 2; message.attachments.push({ id: 'later' });
  assert.equal(snapshot.quote.body, 'redacted'); assert.equal(snapshot.publication.recordRevision, 1);
  assert.deepEqual(snapshot.attachments, []); assert(!JSON.stringify(snapshot).includes('NEVER_COPIED'));
});

test('connected flow private review and request stay frozen in the nonserialized handoff', () => {
  const privateNote = 'SYNTHETIC_F2_REVIEW_MEMORY_ONLY';
  const original = { schema: 2, connectedFlow: { feedbackReview: {
    review: { note: privateNote }, request: { clientId: 'PRIVATE_REQUEST_ID', note: privateNote }, receipt: { reviewVersion: 1 },
  }, publicReplies: { guardian: { quote: { hidden: true } } }, nextPublication: { attachments: [] } } };
  const report = attachRestartCheckpoint({ passed: true }, original);
  original.connectedFlow.feedbackReview.review.note = 'changed';
  assert.equal(report.restartCheckpoint.connectedFlow.feedbackReview.review.note, privateNote);
  for (const item of [report.restartCheckpoint.connectedFlow, report.restartCheckpoint.connectedFlow.feedbackReview,
    report.restartCheckpoint.connectedFlow.feedbackReview.review, report.restartCheckpoint.connectedFlow.feedbackReview.request,
    report.restartCheckpoint.connectedFlow.publicReplies.guardian.quote, report.restartCheckpoint.connectedFlow.nextPublication.attachments])
    assert(Object.isFrozen(item));
  for (const publicReport of [report, { ...report }, structuredClone(report)]) {
    assert(!JSON.stringify(publicReport).includes(privateNote)); assert(!JSON.stringify(publicReport).includes('PRIVATE_REQUEST_ID'));
    assert(!Object.hasOwn(publicReport, 'restartCheckpoint') || publicReport === report);
  }
});
