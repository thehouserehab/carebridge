import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCurrentMessageReferenceRead, preparedHelperFailureLocation } from './native-prepared-media-browser-helper.mjs';

const expected = () => ({ messageId: 'synthetic-text-message',
  uploadId: 'a1111111-1111-4111-8111-111111111111', type: 'image/png', size: 321, sha256: 'a'.repeat(64) });

test('a current-reference read requires a new matching response, not earlier chat-viewer evidence', () => {
  const bytes = expected(), evidence = [{ ...bytes }, { ...bytes }], before = structuredClone(evidence);
  assert.equal(assertCurrentMessageReferenceRead(evidence, 1, bytes), 1);
  assert.deepEqual(evidence, before);
  assert.throws(() => assertCurrentMessageReferenceRead(evidence, 2, bytes));
  assert.throws(() => assertCurrentMessageReferenceRead([], 0, bytes));
  for (const start of [-1, 0.5, NaN, '0']) assert.throws(() => assertCurrentMessageReferenceRead(evidence, start, bytes));
});

test('current-reference evidence cannot substitute another message, file, candidate hash, size or format', () => {
  const bytes = expected();
  for (const change of [{ messageId: 'other-message' }, { uploadId: 'b2222222-2222-4222-8222-222222222222' },
    { type: 'video/mp4' }, { size: 320 }, { sha256: 'b'.repeat(64) }]) {
    assert.throws(() => assertCurrentMessageReferenceRead([{ ...bytes, ...change }], 0, bytes));
    assert.throws(() => assertCurrentMessageReferenceRead([{ ...bytes }, { ...bytes, ...change }], 0, bytes));
  }
  for (const type of ['video/mp4', 'video/webm']) {
    const video = { ...bytes, type };
    assert.equal(assertCurrentMessageReferenceRead([{ ...video }], 0, video), 1);
  }
});

test('new native reference scenario uses existing attachment-only deliveries only in the full care mode', async () => {
  // Static harness checks, not a browser, scanner or E-drive test result.
  const source = await readFile(new URL('./native-prepared-media-browser-helper.mjs', import.meta.url), 'utf8');
  assert(source.includes("message.body === '' && message.attachments?.length === 1"));
  assert(source.includes("if (careContext && !replySources)"));
  assert(source.includes("currentReferencePhoto: false, currentReferenceVideo: false"));
  assert(source.includes("await unsavedCurrentReference(message, message.attachments[0], candidateBytes, kind)"));
  assert(source.includes("assert.equal(therapistRoomPosts, postsBefore, code)"));
  assert(source.includes("assert.deepEqual(after.records, before.records, code)"));
  assert(source.includes("assert.deepEqual(current.attachments, message.attachments, code)"));
  assert(source.includes("name: '현재 참고 첨부', exact: true"));
  assert(source.includes("el => el === document.activeElement"));
  assert.equal((source.match(/\.setInputFiles\(/g) ?? []).length, 1);
});

test('failure diagnostics retain only a bounded helper location and fixed reference phases', async () => {
  const secret = 'synthetic-secret-not-for-report';
  for (const frame of [
    `    at async unsavedCurrentReference (file:///C:/private/${secret}/native-prepared-media-browser-helper.mjs:271:18)`,
    `    at C:\\private\\${secret}\\native-prepared-media-browser-helper.mjs:271:18`,
  ]) {
    const location = preparedHelperFailureLocation({ stack: `TimeoutError: ${secret}\n${frame}` });
    assert.deepEqual(location, { file: 'native-prepared-media-browser-helper.mjs', line: 271, column: 18 });
    assert.equal(JSON.stringify(location).includes(secret), false);
  }
  for (const error of [null, {}, { stack: 1 }, { stack: 'Error: native-prepared-media-browser-helper.mjs:271:18' },
    { stack: 'Error\n    at C:/private/other-helper.mjs:271:18' },
    { stack: 'Error\n    at C:/private/native-prepared-media-browser-helper.mjs:0:18' },
    { stack: 'Error\n    at C:/private/native-prepared-media-browser-helper.mjs:271:18?token=secret' },
    { get stack() { throw new Error(secret); } }]) assert.equal(preparedHelperFailureLocation(error), null);
  const source = await readFile(new URL('./native-prepared-media-browser-helper.mjs', import.meta.url), 'utf8');
  for (const stage of ['BASELINE_READ', 'MENU_OPEN', 'REFERENCE_OPEN', 'RECORD_FORM', 'INPUT_CAPTURE', 'SOURCE_OPEN',
    'FILE_BUTTON', 'VIEWER_OPEN', 'VIEWER_CONTENT', 'EVIDENCE', 'SCREENSHOT', 'VIEWER_CLOSE', 'INPUT_PRESERVED',
    'SOURCE_CLOSE', 'DISCARD', 'RECORD_RECHECK', 'MESSAGE_RECHECK']) assert(source.includes(`phase = phasePrefix + '_${stage}'`));
  assert(source.includes('if (location) report.failure.location = location;'));
});
