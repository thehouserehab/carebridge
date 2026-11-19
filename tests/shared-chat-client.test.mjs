import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedChatClient, validateChatText, chatMessage } from '../src/shared-chat-client.js';
const user = { userId: 'synthetic-therapist', email: 'therapist@example.test', centerId: 'synthetic-center', role: 'therapist', expiresAt: '2030-01-01T00:00:00.000Z' };
const session = { enabled: true, authenticated: true, user };
const response = (value, status = 200) => Response.json(value, { status });
const message = (sequence = 1) => ({ id: `message-${sequence}`, conversationId: 'room-1', childId: 'child-1', authorId: user.userId, sequence, body: '가상 소식', createdAt: '2026-11-18T02:00:00.000Z', type: 'text', hidden: false, deleted: false, edited: false, read: false });

test('chat writes use server session, same-origin cookies and explicit account precondition without retries', async () => {
  const calls = [], client = new SharedChatClient({ fetch: async (path, options) => { calls.push({ path, options }); return response(path.endsWith('/session') ? session : { error: { code: 'CHAT_UNAVAILABLE' } }, path.endsWith('/session') ? 200 : 503); } });
  await client.login(user.email, 'synthetic-password', undefined);
  await assert.rejects(client.send('room-1', { clientId: '11111111-1111-4111-8111-111111111111', body: '가상 소식' }), error => error.code === 'CHAT_UNAVAILABLE');
  assert.equal(calls.length, 2); assert.equal(calls[1].options.headers['X-Carebridge-Chat-User'], user.userId);
  assert.equal(calls[1].options.headers['X-Carebridge-Chat'], '1'); assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.redirect, 'error'); assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(JSON.parse(calls[1].options.body).clientId, '11111111-1111-4111-8111-111111111111');
});
test('HTML firewall response becomes a rate limit error rather than exposing its body', async () => {
  const client = new SharedChatClient({ fetch: async () => new Response('<html>limit</html>', { status: 429 }) });
  await assert.rejects(client.session(), error => error.code === 'CHAT_LIMIT');
});
test('account replacement while awaiting a response rejects the stale result', async () => {
  let resolve; const client = new SharedChatClient({ fetch: () => new Promise(ready => { resolve = ready; }) }); client.userId = user.userId;
  const pending = client.request('/api/chat/rooms'); client.userId = 'other-account'; resolve(response({ rooms: [] }));
  await assert.rejects(pending, error => error.code === 'AUTH_REQUIRED');
});

test('account replacement or clearing during JSON body reading cannot restore the previous session', async () => {
  for (const nextAccount of ['other-account', null]) {
    let beginBody, finishBody;
    const bodyStarted = new Promise(resolve => { beginBody = resolve; });
    const result = response(session);
    result.text = () => { beginBody(); return new Promise(resolve => { finishBody = resolve; }); };
    const client = new SharedChatClient({ fetch: async () => result }); client.userId = user.userId;
    const pending = client.session(); await bodyStarted;
    // SharedChatApp.clear() clears this exact client identity field.
    client.userId = nextAccount; finishBody(JSON.stringify(session));
    await assert.rejects(pending, error => error.code === 'AUTH_REQUIRED');
    assert.equal(client.userId, nextAccount);
  }
});

test('aborting during JSON body reading rejects the completed body before applying its session', async () => {
  let beginBody, finishBody;
  const bodyStarted = new Promise(resolve => { beginBody = resolve; });
  const result = response(session);
  result.text = () => { beginBody(); return new Promise(resolve => { finishBody = resolve; }); };
  const client = new SharedChatClient({ fetch: async () => result });
  const controller = new AbortController(), pending = client.session(controller.signal); await bodyStarted;
  controller.abort(); finishBody(JSON.stringify(session));
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(client.userId, null);
});
test('message pages from changed revisions are discarded before returning a complete snapshot', async () => {
  const calls = []; const client = new SharedChatClient({ fetch: async path => {
    calls.push(path); const index = calls.length;
    if (index === 1) return response({ messages: [message(1)], lastRead: 0, unread: 1, revision: 1, nextCursor: 1, hasMore: true, resetRequired: false });
    if (index === 2) return response({ revision: 2, resetRequired: true });
    return response({ messages: [message(1), message(2)], lastRead: 0, unread: 2, revision: 2, nextCursor: 2, hasMore: false, resetRequired: false });
  } });
  const result = await client.messages('room-1'); assert.equal(result.messages.length, 2); assert.equal(result.revision, 2);
  assert(calls[1].includes('expectedRevision=1')); assert(calls[2].includes('after=0'));
});
test('wrong-room and duplicate messages cannot be painted as the authorized conversation', async () => {
  for (const messages of [[{ ...message(), conversationId: 'other-room' }], [message(), message()]]) {
    const client = new SharedChatClient({ fetch: async () => response({ messages, lastRead: 0, unread: 0, revision: 1, nextCursor: 1, hasMore: false, resetRequired: false }) });
    await assert.rejects(client.messages('room-1'), error => error.code === 'CHAT_UNAVAILABLE');
  }
});
test('invalid input is rejected before fetch, including blank, long and control text', async () => {
  for (const value of ['', '  ', 'x'.repeat(2001), 'abc\u0000']) assert.throws(() => validateChatText(value), error => error.code === 'INVALID_INPUT');
  assert.equal(validateChatText(' 가상\n소식 '), '가상\n소식');
});
test('disabled session is represented explicitly and cannot masquerade as an authenticated account', async () => {
  const client = new SharedChatClient({ fetch: async () => response({ enabled: false, authenticated: false, user: null }) });
  assert.deepEqual(await client.session(), { enabled: false, authenticated: false, user: null });
  const invalid = new SharedChatClient({ fetch: async () => response({ ...session, enabled: false }) });
  await assert.rejects(invalid.session());
});
test('self-hidden message may redact author identity without permitting unhidden anonymous messages', () => {
  assert.equal(chatMessage({ ...message(), authorId: null, hidden: true }, 'room-1').authorId, null);
  assert.throws(() => chatMessage({ ...message(), authorId: null }, 'room-1'));
});
