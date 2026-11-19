import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedChatClient, SharedChatError, chatAttachment, chatMessage, validateChatFile, validateChatPayload } from '../src/shared-chat-client.js';
import { SharedChatApp } from '../src/shared-chat.js';
import { SharedChatMedia, attachmentCards } from '../src/shared-chat-media.js';
import { WEB_CHAT_MEDIA_MAX_BYTES, WEB_CHAT_MEDIA_TYPES, webChatMediaName } from '../src/shared-chat-media-policy.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const metadata = (patch = {}) => ({ id: 'media-one', name: 'carebridge-photo.png', type: 'image/png', size: 4, width: 2, height: 2, ...patch });
const message = attachments => ({ id: 'message-one', conversationId: 'room-one', childId: 'child-one', authorId: 'user-one', sequence: 1,
  body: '사진 1개', type: 'text', createdAt: '2026-11-19T06:00:00.000Z', hidden: false, deleted: false, attachments });
const file = (type = 'image/png', size = 4) => new File([new Uint8Array(size)], 'private-original-name.png', { type });
const rejectsCode = code => error => error instanceof SharedChatError && error.code === code;

test('media metadata accepts only bounded canonical photo/video records, strips remote URLs and rejects malformed attachments', () => {
  for (const type of WEB_CHAT_MEDIA_TYPES) {
    const value = metadata({ type, name: webChatMediaName(type), ...(type.startsWith('video/') ? { duration: 2 } : {}), url: 'https://untrusted.invalid/file' });
    assert.equal(chatAttachment(value).url, undefined);
    assert.equal(chatMessage(message([value]), 'room-one').attachments.length, 1);
  }
  for (const patch of [{ size: 0 }, { size: WEB_CHAT_MEDIA_MAX_BYTES + 1 }, { type: 'image/svg+xml' }, { name: '../private.png' }, { width: -1 }, { height: Infinity }, { duration: 2 }])
    assert.throws(() => chatAttachment(metadata(patch)), rejectsCode('CHAT_UNAVAILABLE'));
  assert.throws(() => chatAttachment(metadata({ type: 'video/mp4', name: 'carebridge-video.mp4' })), rejectsCode('CHAT_UNAVAILABLE'));
  assert.throws(() => chatMessage(message([metadata(), metadata()]), 'room-one'), rejectsCode('CHAT_UNAVAILABLE'));
  assert.throws(() => chatMessage({ ...message([metadata()]), hidden: true }, 'room-one'), rejectsCode('CHAT_UNAVAILABLE'));
});

test('attachment-only payloads are allowed, but empty, duplicate, excess or arbitrary attachment fields are rejected', () => {
  assert.deepEqual(validateChatPayload(' ', [{ id: 'media-one' }]), { body: '', attachments: [{ id: 'media-one' }] });
  for (const [body, attachments] of [[' ', []], ['x'.repeat(2001), []], ['hello', [{ id: 'one' }, { id: 'one' }]],
    ['hello', Array.from({ length: 5 }, (_, index) => ({ id: 'file-' + index }))], ['hello', [{ id: 'one', url: 'https://untrusted.invalid' }]]])
    assert.throws(() => validateChatPayload(body, attachments), rejectsCode('INVALID_INPUT'));
});

test('upload uses bounded raw bytes with identity preconditions and does not transmit original filenames', async () => {
  const calls = [], selected = file();
  const client = new SharedChatClient({ fetch: async (...args) => { calls.push(args); return Response.json({ attachment: metadata() }, { status: 201 }); } });
  client.userId = 'user-one'; const result = await client.upload('room-one', { clientId: uuid, file: selected });
  assert.deepEqual(result, metadata()); assert.equal(calls.length, 1);
  const [path, options] = calls[0]; assert.equal(path, '/api/chat/rooms/room-one/media?clientId=' + uuid);
  assert.equal(options.body, selected); assert.equal(options.headers['Content-Type'], 'image/png');
  assert.equal(options.headers['X-Carebridge-Chat-User'], 'user-one'); assert.equal(options.headers['X-Carebridge-Chat'], '1');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(JSON.stringify(options.headers).includes(selected.name), false); assert.equal(path.includes(selected.name), false);
});

test('invalid upload files and pre-aborted requests never reach the transport', async () => {
  let calls = 0; const client = new SharedChatClient({ fetch: async () => { calls++; throw Error(); } }); client.userId = 'user-one';
  for (const selected of [file('video/quicktime'), file('image/svg+xml'), file('image/png', 0), file('image/png', WEB_CHAT_MEDIA_MAX_BYTES + 1)])
    await assert.rejects(client.upload('room-one', { clientId: uuid, file: selected }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.upload('room-one', { clientId: uuid, file: file() }, controller.signal), rejectsCode('CANCELLED'));
  assert.equal(calls, 0); assert.throws(() => validateChatFile({ type: 'image/png', size: 1 }), rejectsCode('INVALID_MEDIA'));
});

test('content reads verify exact metadata and use authenticated byte requests rather than supplied URLs', async () => {
  const calls = [], client = new SharedChatClient({ fetch: async (...args) => { calls.push(args); return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/png', 'Content-Length': '4' } }); } });
  client.userId = 'user-one'; const blob = await client.attachment('room-one', metadata({ url: 'https://untrusted.invalid' }));
  assert.equal(blob.type, 'image/png'); assert.equal(blob.size, 4);
  assert.equal(calls[0][0], '/api/chat/rooms/room-one/media/media-one');
  assert.equal(calls[0][1].headers['X-Carebridge-Chat-User'], 'user-one');
  assert.equal(calls[0][1].credentials, 'same-origin');
});

test('wrong MIME, truncated, oversized and partial content responses never become preview blobs', async () => {
  for (const response of [new Response(new Uint8Array(4), { headers: { 'Content-Type': 'text/html' } }),
    new Response(new Uint8Array(3), { headers: { 'Content-Type': 'image/png' } }),
    new Response(new Uint8Array(5), { headers: { 'Content-Type': 'image/png' } }),
    new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Type': 'image/png', 'Content-Range': 'bytes 0-3/4' } }),
    new Response(new Uint8Array(4), { headers: { 'Content-Type': 'image/png', 'Content-Length': '9' } })]) {
    const client = new SharedChatClient({ fetch: async () => response }); client.userId = 'user-one';
    await assert.rejects(client.attachment('room-one', metadata()), rejectsCode('CHAT_UNAVAILABLE'));
  }
});

test('account replacement during a streamed content response discards the bytes', async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const client = new SharedChatClient({ fetch: async () => new Response(new ReadableStream({ async start(controller) {
    started(); await new Promise(resolve => { release = resolve; }); controller.enqueue(new Uint8Array(4)); controller.close();
  } }), { headers: { 'Content-Type': 'image/png' } }) }); client.userId = 'user-one';
  const pending = client.attachment('room-one', metadata()); await ready; client.userId = 'other-account'; release();
  await assert.rejects(pending, rejectsCode('AUTH_REQUIRED'));
});

test('media errors are safe user codes and overlong error responses are bounded', async () => {
  for (const code of ['INVALID_MEDIA', 'MEDIA_LIMIT', 'MEDIA_STORAGE_FULL', 'UPLOAD_EXPIRED', 'ATTACHMENT_NOT_FOUND']) {
    const client = new SharedChatClient({ fetch: async () => Response.json({ error: { code, internal: 'do not expose' } }, { status: 409 }) }); client.userId = 'user-one';
    await assert.rejects(client.upload('room-one', { clientId: uuid, file: file() }), error => error.code === code && !error.message.includes('do not expose'));
  }
  const client = new SharedChatClient({ fetch: async () => new Response('x'.repeat(9000), { status: 500, headers: { 'Content-Type': 'application/json' } }) }); client.userId = 'user-one';
  await assert.rejects(client.upload('room-one', { clientId: uuid, file: file() }), rejectsCode('CHAT_UNAVAILABLE'));
});

test('empty native chooser and failed selection retain the earlier draft; clearing releases file references and previews', () => {
  const selected = Object.create(SharedChatMedia.prototype), notices = [];
  Object.assign(selected, { items: [], locked: false, closed: false, notice: '', getContext: () => ({ roomId: 'room-one' }),
    draw() {}, onChanged() {}, errorText: error => error.code, picker: { value: 'selected' }, pickButton: { focus() { notices.push('focus'); } } });
  selected.selectFiles([file()]); assert.equal(selected.items.length, 1); const first = selected.items[0], url = first.previewUrl;
  selected.selectFiles([]); assert.equal(selected.items[0], first);
  selected.selectFiles([file(), file('image/svg+xml')]); assert.equal(selected.items.length, 1); assert.equal(selected.notice, 'INVALID_MEDIA');
  selected.locked = true; selected.selectFiles([file()]); assert.equal(selected.items.length, 1);
  selected.locked = false; selected.clearSelection(); assert.equal(first.file, null); assert.equal(first.previewUrl, null); assert.equal(selected.items.length, 0);
  assert.equal(typeof url, 'string'); assert.equal(selected.picker.value, '');
});

test('attachment cards never embed server-provided URLs or executable media markup', () => {
  const html = attachmentCards([metadata({ url: 'https://untrusted.invalid', name: '<script>' })]);
  assert.match(html, /data-chat-open-media="media-one"/); assert.doesNotMatch(html, /<script|<img|<video|untrusted/);
});

function sender(client, files) {
  const input = { value: '가상 첨부', style: {}, focus() {} }, host = { querySelector: selector => selector === 'textarea' ? input : null };
  const app = new SharedChatApp({ host, client }); app.phase = 'workspace'; app.selected = 'room-one';
  app.media = { capture: () => Object.freeze(files), clearSelection() { this.cleared = true; } };
  app.composer = () => {}; app.sizeInput = () => {}; app.status = value => { app.notice = value; }; app.refresh = async () => {};
  app.paintMessages = value => { app.messages = value; }; return { app, input };
}

test('partial upload retry reuses each upload id and message retry reuses its fixed payload without duplicate uploads', async () => {
  const files = [1, 2].map(index => ({ clientId: `00000000-0000-4000-8000-00000000000${index}`, file: file(), receipt: null }));
  const uploads = [], sends = []; let loseUpload = true, loseMessage = true;
  const client = { async upload(room, item) { uploads.push(item.clientId); if (item === files[1] && loseUpload) { loseUpload = false; throw new SharedChatError('CHAT_UNAVAILABLE'); } return metadata({ id: 'media-' + item.clientId }); },
    async send(room, operation) { sends.push(operation); if (loseMessage) { loseMessage = false; throw new SharedChatError('CHAT_UNAVAILABLE'); } return message(operation.attachments.map(item => metadata({ id: item.id }))); } };
  const { app, input } = sender(client, files); await app.send(); const operation = app.operation;
  assert(operation); assert.equal(sends.length, 0); assert.equal(input.value, '가상 첨부');
  await app.send(); assert.equal(app.operation, operation); assert.equal(sends.length, 1);
  await app.send(); assert.equal(app.operation, null); assert.equal(input.value, ''); assert.equal(app.media.cleared, true);
  assert.deepEqual(uploads, [files[0].clientId, files[1].clientId, files[1].clientId]); assert.deepEqual(sends[0], sends[1]);
  assert.equal(app.messages.length, 1);
});
