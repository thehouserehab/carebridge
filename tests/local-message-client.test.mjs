import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rejects = (code) => (error) => error instanceof LocalApiError && error.code === code;
const msg = { id: 'message', conversationId: 'room', childId: 'child', authorId: 'synthetic-user', sequence: 1,
  type: 'text', body: '가상 원문', read: false, createdAt: '2026-10-09T00:00:00Z', version: 1, canEdit: true, canDeleteAll: true, canHide: true };
const receipt = (operation, extra = {}) => ({ receipt: { messageId: 'message', revision: 2, operation, replayed: false, ...extra } });

test('message detail is scoped to the exact room/id and sends verified account header', async () => {
  let request; const client = new LocalApiClient({ fetch: async (path, options) => { request = { path, ...options }; return json({ message: msg }); } });
  client.expectedUserId = 'synthetic-user';
  assert.deepEqual(await client.message('center', 'room', 'message'), msg);
  assert.equal(request.path, '/api/local/centers/center/conversations/room/messages/message');
  assert.equal(request.headers['X-Carebridge-Account'], 'synthetic-user');
  assert.equal(request.cache, 'no-store');
  await assert.rejects(client.message('center', 'other-room', 'message'), rejects('INVALID_RESPONSE'));
  await assert.rejects(client.message('center', 'room', 'other-message'), rejects('INVALID_RESPONSE'));
});

test('message edit carries only immutable command fields, not role/author/attachments', async () => {
  let request; const client = new LocalApiClient({ fetch: async (path, options) => { request = { path, ...options }; return json(receipt('edit')); } });
  const operation = { clientId: 'synthetic-edit', expectedRevision: 1, body: '가상 수정', role: 'center', authorId: 'other', attachments: ['DO-NOT-SEND'] };
  assert.deepEqual(await client.messageEdit('center', 'room', 'message', operation), receipt('edit').receipt);
  assert.equal(request.path.endsWith('/messages/message/edit'), true);
  assert.deepEqual(JSON.parse(request.body), { clientId: operation.clientId, expectedRevision: 1, body: operation.body });
  assert.equal(request.headers['X-Carebridge-Request'], '1');
});

test('delete retains exact confirmation/scope and does not invent a self-hide version', async () => {
  const requests = []; const client = new LocalApiClient({ fetch: async (path, options) => {
    requests.push({ path, ...options }); return json(receipt(JSON.parse(options.body).scope));
  } });
  await client.messageDelete('center', 'room', 'message', { clientId: 'synthetic-self', scope: 'self', confirmed: true, body: 'DO-NOT-SEND' });
  assert.deepEqual(JSON.parse(requests[0].body), { clientId: 'synthetic-self', scope: 'self', confirmed: true });
  await client.messageDelete('center', 'room', 'message', { clientId: 'synthetic-all', scope: 'all', confirmed: false, expectedRevision: 3 });
  assert.deepEqual(JSON.parse(requests[1].body), { clientId: 'synthetic-all', scope: 'all', confirmed: false, expectedRevision: 3 });
});

test('wrong acknowledgement message/action/revision cannot clear an unconfirmed operation', async () => {
  for (const bad of [{ messageId: 'other' }, { operation: 'all' }, { revision: 0 }, { revision: 1.5 }, { replayed: 'yes' }]) {
    const client = new LocalApiClient({ fetch: async () => json(receipt('edit', bad)) });
    await assert.rejects(client.messageEdit('center', 'room', 'message', { clientId: 'synthetic-edit', expectedRevision: 1, body: '가상 수정' }), rejects('INVALID_RESPONSE'));
  }
  const client = new LocalApiClient({ fetch: async () => json(receipt('all')) });
  await assert.rejects(client.messageDelete('center', 'room', 'message', { scope: 'self', confirmed: true }), rejects('INVALID_RESPONSE'));
});

test('message routes reject traversal and unsupported scopes without any request', async () => {
  let calls = 0; const client = new LocalApiClient({ fetch: async () => { calls++; return json({}); } });
  await assert.rejects(client.message('center', 'room', '../other'), rejects('INVALID_INPUT'));
  await assert.rejects(client.messageEdit('center', 'room', 'message?role=admin', {}), rejects('INVALID_INPUT'));
  await assert.rejects(client.messageDelete('center', 'room', 'message', { scope: 'everyone' }), rejects('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('edit/delete failure codes are safe fixed copy and transport loss remains unknown', async () => {
  for (const code of ['MESSAGE_CONFLICT', 'MESSAGE_DELETED', 'MESSAGE_CHANGE_EXPIRED']) {
    const client = new LocalApiClient({ fetch: async () => json({ error: code, message: 'PRIVATE DETAILS' }, 409) });
    await assert.rejects(client.messageEdit('center', 'room', 'message', {}), (error) => rejects(code)(error) && !error.message.includes('PRIVATE'));
  }
  const client = new LocalApiClient({ fetch: async () => { throw Error('PRIVATE DETAILS'); } });
  await assert.rejects(client.messageDelete('center', 'room', 'message', { scope: 'all' }), rejects('UNAVAILABLE'));
});

test('text reply preserves selected version and publication reply invents no text revision', async () => {
  const sent = []; const client = new LocalApiClient({ fetch: async (_path, options) => { sent.push(JSON.parse(options.body)); return json({ message: msg }); } });
  await client.send('center', 'room', { clientId: 'reply-text', body: '가상 답장', replyTo: 'source', expectedReplyVersion: 2 });
  assert.deepEqual(sent[0], { clientId: 'reply-text', body: '가상 답장', replyTo: 'source', expectedReplyVersion: 2 });
  await client.send('center', 'room', { clientId: 'reply-publication', body: '공유본에 가상 답장', replyTo: 'publication' });
  assert.equal('expectedReplyVersion' in sent[1], false);
});

test('attachment-only send preserves the exact ID-only command across a lost-response retry', async () => {
  const file = Object.freeze({ id: 'a1111111-1111-4111-8111-111111111111' });
  const operation = Object.freeze({ clientId: 'synthetic-file-send', body: '', attachments: Object.freeze([file]) });
  const sent = []; const client = new LocalApiClient({ fetch: async (path, options) => {
    sent.push({ path, body: options.body });
    if (sent.length === 1) throw Error('PRIVATE TRANSPORT DETAIL');
    return json({ message: { ...msg, body: '', attachmentCount: 1,
      attachments: [{ id: file.id, name: '합성.png', type: 'image/png', size: 42 }] } });
  } });
  await assert.rejects(client.send('center', 'room', operation), rejects('UNAVAILABLE'));
  const result = await client.send('center', 'room', operation);
  assert.equal(result.attachments[0].id, file.id);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(JSON.parse(sent[1].body), operation);
  assert.equal(operation.attachments[0], file);
});

test('message attachment commands reject duplicate IDs, forged metadata, paths and oversized lists before fetching', async () => {
  let calls = 0; const client = new LocalApiClient({ fetch: async () => { calls++; return json({ message: msg }); } });
  const file = { id: 'a1111111-1111-4111-8111-111111111111' };
  for (const attachments of [null, {}, [null], [file, file], [{ id: '../other' }], [{ ...file, name: 'PRIVATE' }],
    [{ ...file, state: 'ready' }], [{ ...file, objectKey: 'PRIVATE' }],
    Array.from({ length: 7 }, (_, i) => ({ id: `a111111${i}-1111-4111-8111-111111111111` }))]) {
    await assert.rejects(client.send('center', 'room', { clientId: 'synthetic-send', body: '', attachments }), rejects('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('message attachment metadata rejects invalid or private projections and hidden/deleted file resurrection', async () => {
  const file = { id: 'a1111111-1111-4111-8111-111111111111', name: '합성.png', type: 'image/png', size: 42 };
  for (const extra of [
    { attachments: [{ ...file, objectKey: 'PRIVATE' }] }, { attachments: [{ ...file, sha256: 'PRIVATE' }] },
    { attachments: [{ ...file, type: 'text/html' }] }, { attachments: [{ ...file, name: '../private.png' }] },
    { attachments: [{ ...file, size: 0 }] }, { attachments: [{ ...file, size: 10 * 1024 ** 2 + 1 }] },
    { attachments: [file, file] }, { attachments: [file], hidden: true }, { attachments: [file], deleted: true },
    { attachments: [file], attachmentCount: 0 }, { attachments: null },
  ]) {
    const client = new LocalApiClient({ fetch: async () => json({ message: { ...msg, ...extra } }) });
    await assert.rejects(client.message('center', 'room', 'message'), rejects('INVALID_RESPONSE'));
  }
  const client = new LocalApiClient({ fetch: async () => json({ message: { ...msg, attachments: [file], attachmentCount: 1 } }) });
  assert.deepEqual((await client.message('center', 'room', 'message')).attachments, [file]);
});

test('attachment unavailable, approval and read-capacity conflicts use fixed public copy', async () => {
  for (const code of ['ATTACHMENTS_NOT_CONNECTED', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT', 'MEDIA_READ_BUSY']) {
    const client = new LocalApiClient({ fetch: async () => json({ error: code, message: 'PRIVATE FILE PATH' }, 409) });
    await assert.rejects(client.send('center', 'room', { clientId: 'synthetic-send', body: '가상 자료' }),
      (error) => rejects(code)(error) && !error.message.includes('PRIVATE'));
  }
});
