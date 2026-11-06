import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeHistorySnapshot, assertNativeHistoryContent } from './native-history-media-browser-helper.mjs';

const fixture = () => ({ resetRequired: false, messages: [
  { id: 'synthetic-photo', sequence: 11, body: 'private fixture text excluded' },
  { id: 'synthetic-video', sequence: 14, privateNote: 'private fixture note excluded' },
], window: { startCursor: 11, endCursor: 14, hasOlder: true, hasNewer: true } });

test('history observations retain exact identities and nonconsecutive cursors but no message content', () => {
  const value = fixture(), before = structuredClone(value), result = nativeHistorySnapshot(value);
  assert.deepEqual(result, { messages: [{ id: 'synthetic-photo', sequence: 11 }, { id: 'synthetic-video', sequence: 14 }],
    count: 2, start: 11, end: 14, hasOlder: true, hasNewer: true });
  assert.deepEqual(value, before); assert(!JSON.stringify(result).includes('private'));
});

test('history evidence rejects a reset, missing window, empty list, or more than 100 rows', () => {
  for (const modify of [value => { value.resetRequired = true; }, value => { delete value.window; },
    value => { value.messages = []; }, value => { value.messages = Array.from({ length: 101 }, (_, index) => ({ id: `m-${index}`, sequence: index + 1 })); }]) {
    const value = fixture(); modify(value); assert.throws(() => nativeHistorySnapshot(value));
  }
  for (const value of [null, {}, [], { ...fixture(), resetRequired: undefined }]) assert.throws(() => nativeHistorySnapshot(value));
});

test('exactly 100 ordered unique messages are accepted', () => {
  const value = { resetRequired: false, messages: Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}`, sequence: index + 1 })),
    window: { startCursor: 1, endCursor: 100, hasOlder: false, hasNewer: false } };
  assert.equal(nativeHistorySnapshot(value).count, 100);
});

test('history evidence cannot substitute duplicate, out of order, unsafe or mismatched cursor data', () => {
  for (const modify of [value => { value.messages[1].id = value.messages[0].id; },
    value => { value.messages[1].sequence = 10; }, value => { value.messages[1].sequence = 11; },
    value => { value.messages[0].sequence = 0; }, value => { value.messages[0].sequence = '11'; },
    value => { value.messages[0].id = 'bad/id'; }, value => { value.window.startCursor = 12; },
    value => { value.window.endCursor = 13; }, value => { value.window.hasOlder = 1; },
    value => { value.window.hasNewer = null; }]) {
    const value = fixture(); modify(value); assert.throws(() => nativeHistorySnapshot(value));
  }
});

const content = () => {
  const bytes = Buffer.from('synthetic test bytes');
  return { bytes, expected: { messageId: 'synthetic-message', uploadId: 'a1111111-1111-4111-8111-111111111111',
    type: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
};
test('new file evidence must match the exact prior message, upload, type, byte length and hash', () => {
  const { bytes, expected } = content(), before = Buffer.from(bytes);
  assert.deepEqual(assertNativeHistoryContent(expected, expected, bytes), expected);
  assert.deepEqual(bytes, before);
  for (const type of ['video/mp4', 'video/webm']) {
    const video = { ...expected, type }; assert.deepEqual(assertNativeHistoryContent(video, video, bytes), video);
  }
});
test('content evidence rejects a different file or metadata even if the response looks successful', () => {
  const { bytes, expected } = content();
  for (const change of [{ messageId: 'other-message' }, { uploadId: 'b2222222-2222-4222-8222-222222222222' },
    { type: 'video/mp4' }, { size: bytes.length + 1 }])
    assert.throws(() => assertNativeHistoryContent(expected, { ...expected, ...change }, bytes));
  assert.throws(() => assertNativeHistoryContent(expected, expected, Buffer.from('different test bytes')));
  assert.throws(() => assertNativeHistoryContent(expected, expected, new Uint8Array(bytes)));
  assert.throws(() => assertNativeHistoryContent(expected, expected, Buffer.alloc(0)));
});
test('an invalid baseline is never promoted to file evidence', () => {
  const { bytes, expected } = content();
  for (const change of [{ messageId: '' }, { uploadId: 'not-a-file-id' }, { type: 'text/plain' },
    { size: -1 }, { size: 50 * 1024 ** 2 + 1 }, { sha256: 'x'.repeat(64) }]) {
    const altered = { ...expected, ...change }; assert.throws(() => assertNativeHistoryContent(altered, altered, bytes));
  }
});
