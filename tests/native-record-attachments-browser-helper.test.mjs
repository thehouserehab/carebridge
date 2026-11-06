import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { syntheticSessionCheckOptions, assertSelectedRecordPreview, assertFreshAttachmentContent } from './native-record-attachments-browser-helper.mjs';

const args = ['--base', 'E:\\SyntheticTest', '--powershell', 'C:\\Runtime\\pwsh.exe', '--confirm-synthetic-e-drive'];

test('default synthetic session retains its original exact PostgreSQL arguments', () => {
  const result = syntheticSessionCheckOptions(args);
  assert.equal(result.recordAttachments, false);
  assert.deepEqual(result.args, args);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args)); assert.notEqual(result.args, args);
});

test('record attachments requires one explicit leading mode flag and preserves a fresh-session configuration', () => {
  const supplied = ['--record-attachments', ...args], result = syntheticSessionCheckOptions(supplied);
  assert.equal(result.recordAttachments, true); assert.deepEqual(result.args, args);
  supplied[2] = 'E:\\Changed'; assert.equal(result.args[1], 'E:\\SyntheticTest');
});

test('mode parsing does not accept duplicate flags, an existing session, non-E storage or credential overrides', () => {
  for (const input of [null, [], ['--record-attachments'], ['--record-attachments', '--record-attachments', ...args],
    [...args, '--record-attachments'], ['--record-attachments', ...args, '--resume', 'existing'],
    ['--record-attachments', ...args, '--password', 'synthetic'], ['--record-attachments', '--base', 'C:\\SyntheticTest', ...args.slice(2)]]) {
    assert.throws(() => syntheticSessionCheckOptions(input));
  }
});

test('record attachment evidence fingerprints the helper and exact session runner', async () => {
  // Static coverage only, not browser/native verification. No E drive is used.
  const source = await readFile(new URL('./native-record-attachments-browser-helper.mjs', import.meta.url), 'utf8');
  const list = source.slice(source.indexOf('async function sources()'), source.indexOf('function processLifetime'));
  assert(list.includes("'tests/native-record-attachments-browser-helper.mjs'"));
  assert(list.includes("'tests/windows-synthetic-session-check.mjs'"));
  assert(list.includes("'tests/native-upload-status-observation.mjs'"));
});

test('all synthetic session modes fingerprint the status observer transitively imported by their runner', async () => {
  for (const name of ['native-feedback-attachments-browser-helper.mjs', 'native-prepared-media-browser-helper.mjs']) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    const list = source.slice(source.indexOf('async function sources()'), source.indexOf('function processLifetime'));
    assert(list.includes("'tests/native-upload-status-observation.mjs'"));
  }
});

const sharedFile = { id: '12345678-1234-4234-8234-123456789abc', name: 'synthetic-video.mp4', type: 'video/mp4', size: 100 };
const previewExpected = { recordId: 'synthetic-record', recordRevision: 2, date: '2026-10-19',
  title: 'Synthetic title', summary: 'Synthetic summary', recipientIds: ['synthetic-guardian'],
  activity: { title: 'Synthetic play', instruction: 'Synthetic instructions', frequency: '', caution: '' },
  file: sharedFile, privateValues: ['synthetic-private-note', 'synthetic-private.png'] };
const previewFixture = () => ({ ...structuredClone(Object.fromEntries(Object.entries(previewExpected)
  .filter(([key]) => !['file', 'privateValues'].includes(key)))), relationshipsVersion: 1,
  attachmentCount: 1, attachments: [{ ...sharedFile, share: true }] });

test('selected preview binds the exact record, recipient, public text, activity and selected file', () => {
  assert.doesNotThrow(() => assertSelectedRecordPreview(previewFixture(), previewExpected));
  for (const change of [
    { recordId: 'other-record' }, { recordRevision: 1 }, { date: '2026-10-18' }, { title: 'Other title' },
    { summary: 'Other summary' }, { recipientIds: ['other-guardian'] }, { recipientIds: [] },
    { relationshipsVersion: -1 }, { relationshipsVersion: 0.5 }, { activity: null }, { attachmentCount: 2 },
    { attachments: [] }, { attachments: [{ ...sharedFile, share: false }] },
    { attachments: [{ ...sharedFile, id: 'other-file', share: true }] },
    { attachments: [{ ...sharedFile, type: 'image/png', share: true }] },
    { extra: 'synthetic-private-note' }, { extra: 'synthetic-private.png' },
  ]) assert.throws(() => assertSelectedRecordPreview({ ...previewFixture(), ...change }, previewExpected));
});

const contentExpected = { role: 'guardian', kind: 'publication-message', messageId: 'synthetic-message',
  uploadId: sharedFile.id, type: sharedFile.type, size: sharedFile.size };
const contentFixture = () => ({ ...contentExpected, sha256: 'a'.repeat(64) });

test('fresh content evidence rejects missing or mismatched anchors, media identity and digest', () => {
  const actual = contentFixture();
  assert.equal(assertFreshAttachmentContent([actual], contentExpected), actual);
  assert.throws(() => assertFreshAttachmentContent([], contentExpected));
  for (const change of [{ role: 'therapist' }, { kind: 'record' }, { messageId: 'other-message' },
    { uploadId: 'other-file' }, { type: 'image/png' }, { size: 101 }, { sha256: '' }])
    assert.throws(() => assertFreshAttachmentContent([{ ...actual, ...change }], contentExpected));
});

test('fresh guardian and reload downloads must match the previously viewed bytes, not only a cached button', () => {
  const previous = { ...contentFixture(), role: 'therapist', kind: 'record' };
  assert.doesNotThrow(() => assertFreshAttachmentContent([contentFixture()], contentExpected, previous));
  assert.throws(() => assertFreshAttachmentContent([{ ...contentFixture(), sha256: 'b'.repeat(64) }], contentExpected, previous));
  assert.throws(() => assertFreshAttachmentContent([], contentExpected, previous));
  // Even a later good response must not hide an inconsistent matching response.
  assert.throws(() => assertFreshAttachmentContent([
    { ...contentFixture(), sha256: 'b'.repeat(64) }, contentFixture(),
  ], contentExpected, previous));
});

test('first-read responses with the same anchor must share a digest without a previous baseline', () => {
  const first = contentFixture(), last = contentFixture();
  const observations = [{ ...contentFixture(), messageId: 'other-message', sha256: 'b'.repeat(64) }, first, last];
  const before = structuredClone(observations);
  assert.equal(assertFreshAttachmentContent(observations, contentExpected), last);
  assert.deepEqual(observations, before);
  const conflicting = { ...contentFixture(), sha256: 'b'.repeat(64) };
  for (const mixed of [[conflicting, first], [first, conflicting]])
    assert.throws(() => assertFreshAttachmentContent(mixed, contentExpected));
});

test('correct content cannot conceal another response with the same anchor but wrong MIME or size', () => {
  for (const change of [{ type: 'image/png' }, { size: 101 }]) {
    const inconsistent = { ...contentFixture(), ...change };
    for (const observations of [[inconsistent, contentFixture()], [contentFixture(), inconsistent]])
      assert.throws(() => assertFreshAttachmentContent(observations, contentExpected));
  }
  // Other anchors are independent observations, not evidence for this request.
  assert.doesNotThrow(() => assertFreshAttachmentContent([
    { ...contentFixture(), messageId: 'other-message', type: 'image/png', size: 101 }, contentFixture(),
  ], contentExpected));
});
