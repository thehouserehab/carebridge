import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiConversations } from '../ai-conversations.mjs';
import { RepositoryError, fail } from '../errors.mjs';

const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const code = expected => error => error instanceof RepositoryError && error.code === expected && error.message === expected;
const input = (extra = {}) => ({ conversationId: 'room-a', requestId: 'request-0001', expectedRevision: 0, message: '가상 질문입니다.', ...extra });
const answer = (text = '가상 AI 답변입니다.') => ({ text, usage: { inputTokens: 30, outputTokens: 20 } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ respond, maxCalls = 20 } = {}) {
  let activeTransaction = false;
  const permission = { active: true, role: 'guardian', firstSequence: 1, childId: 'child-a' };
  const calls = [];
  const conversations = {
    async inRoom(actor, roomId, work) {
      if (!permission.active) fail('NOT_FOUND');
      activeTransaction = true;
      try { return await work({}, { centerId: actor.centerId, userId: actor.userId, roomId,
        childId: permission.childId, role: permission.role, firstSequence: permission.firstSequence, revision: 1 }); }
      finally { activeTransaction = false; }
    },
  };
  const provider = { mode: 'fixture', model: 'synthetic-chat', async respond(payload, options) {
    assert.equal(activeTransaction, false, 'Never invoke a model inside a DB transaction');
    calls.push(structuredClone(payload));
    return respond ? respond(payload, options) : answer();
  } };
  return { service: new AiConversations({ conversations, provider, maxCalls }), calls, permission, conversations, provider };
}

test('authenticated initial state has no automatic child records or provider call', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get(guardian, { conversationId: 'room-a' }), {
    revision: 0, messages: [], mode: 'fixture', model: 'synthetic-chat', contextTruncated: false,
  });
  assert.equal(f.calls.length, 0);
  await f.service.close();
});

test('free conversation sends only user text/history and commits a cloned pair', async () => {
  const f = fixture();
  const first = await f.service.send(guardian, input());
  assert.deepEqual(f.calls[0], { messages: [{ role: 'user', content: '가상 질문입니다.' }] });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.messages, [{ role: 'user', content: '가상 질문입니다.' }, { role: 'assistant', content: '가상 AI 답변입니다.' }]);
  first.messages[0].content = 'changed by browser';
  const second = await f.service.send(guardian, input({ requestId: 'request-0002', expectedRevision: 1, message: '이어서 설명해 주세요.' }));
  assert.equal(second.messages[0].content, '가상 질문입니다.');
  assert.deepEqual(Object.keys(f.calls[1]), ['messages']);
  assert.equal(JSON.stringify(f.calls).includes('center-a'), false);
  assert.equal(JSON.stringify(f.calls).includes('guardian-a'), false);
  assert.equal(JSON.stringify(f.calls).includes('child-a'), false);
  assert.equal(second.messages.length, 4);
  await f.service.close();
});

test('model payload mutation cannot alter committed history', async () => {
  const f = fixture({ respond: payload => { payload.messages[0].content = 'provider mutation'; return answer(); } });
  const result = await f.service.send(guardian, input());
  assert.equal(result.messages[0].content, '가상 질문입니다.');
  await f.service.close();
});

test('user, center and room AI histories are isolated', async () => {
  const f = fixture();
  await f.service.send(guardian, input());
  for (const [actor, room] of [[therapist, 'room-a'], [{ userId: guardian.userId, centerId: 'center-b' }, 'room-a'], [guardian, 'room-b']]) {
    assert.deepEqual((await f.service.get(actor, { conversationId: room })).messages, []);
  }
  assert.equal((await f.service.get(guardian, { conversationId: 'room-a' })).messages.length, 2);
  await f.service.close();
});

test('successful same request is replayed without another model call; changed body conflicts', async () => {
  const f = fixture();
  const first = await f.service.send(guardian, input());
  assert.deepEqual(await f.service.send(guardian, input()), first);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.send(guardian, input({ message: '다른 내용' })), code('AI_REQUEST_CONFLICT'));
  await assert.rejects(f.service.send(guardian, input({ conversationId: 'room-b' })), code('AI_REQUEST_CONFLICT'));
  await f.service.close();
});

test('stale revisions and old receipts cannot roll conversation back', async () => {
  const f = fixture();
  await f.service.send(guardian, input());
  await assert.rejects(f.service.send(guardian, input({ requestId: 'request-0002' })), code('AI_CONVERSATION_CHANGED'));
  await f.service.send(guardian, input({ requestId: 'request-0002', expectedRevision: 1 }));
  await assert.rejects(f.service.send(guardian, input()), code('AI_CONVERSATION_CHANGED'));
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service.get(guardian, { conversationId: 'room-a' })).revision, 2);
  await f.service.close();
});

test('current room authorization precedes history and cached response access', async () => {
  const f = fixture();
  await f.service.send(guardian, input());
  f.permission.active = false;
  await assert.rejects(f.service.get(guardian, { conversationId: 'room-a' }), code('NOT_FOUND'));
  await assert.rejects(f.service.send(guardian, input()), code('NOT_FOUND'));
  assert.equal(f.calls.length, 1);
  await f.service.close();
});

test('denied request does not spend model budget', async () => {
  const f = fixture({ maxCalls: 1 });
  f.permission.active = false;
  await assert.rejects(f.service.send(guardian, input()), code('NOT_FOUND'));
  assert.equal(f.calls.length, 0);
  f.permission.active = true;
  await f.service.send(guardian, input());
  assert.equal(f.calls.length, 1);
  await f.service.close();
});

test('permission revocation during provider work discards both pending user/assistant pair', async () => {
  const ready = deferred(), reply = deferred();
  const f = fixture({ respond: () => { ready.resolve(); return reply.promise; } });
  const sending = f.service.send(guardian, input());
  await ready.promise;
  f.permission.active = false;
  reply.resolve(answer());
  await assert.rejects(sending, code('NOT_FOUND'));
  f.permission.active = true;
  assert.deepEqual((await f.service.get(guardian, { conversationId: 'room-a' })).messages, []);
  await assert.rejects(f.service.send(guardian, input()), code('AI_REQUEST_FAILED'));
  assert.equal(f.calls.length, 1);
  await f.service.close();
});

test('history-boundary change drops former AI context and invalidates receipts', async () => {
  const f = fixture();
  await f.service.send(guardian, input());
  f.permission.firstSequence = 8;
  const reset = await f.service.get(guardian, { conversationId: 'room-a' });
  assert.deepEqual(reset.messages, []);
  assert.equal(reset.revision, 2);
  await assert.rejects(f.service.send(guardian, input()), code('AI_CONVERSATION_CHANGED'));
  await f.service.send(guardian, input({ requestId: 'request-0002', expectedRevision: reset.revision }));
  assert.equal(f.calls[1].messages.length, 1);
  await f.service.close();
});

test('scope change during a model request rejects its late response', async () => {
  const ready = deferred(), reply = deferred();
  const f = fixture({ respond: () => { ready.resolve(); return reply.promise; } });
  const sending = f.service.send(guardian, input());
  await ready.promise;
  f.permission.role = 'care_recipient';
  reply.resolve(answer());
  await assert.rejects(sending, code('AI_CONVERSATION_CHANGED'));
  assert.deepEqual((await f.service.get(guardian, { conversationId: 'room-a' })).messages, []);
  await f.service.close();
});

test('single in-flight call rejects duplicate and other-user concurrency', async () => {
  const ready = deferred(), reply = deferred();
  const f = fixture({ respond: () => { ready.resolve(); return reply.promise; } });
  const sending = f.service.send(guardian, input());
  await ready.promise;
  await assert.rejects(f.service.send(guardian, input()), code('AI_BUSY'));
  await assert.rejects(f.service.send(therapist, input()), code('AI_BUSY'));
  await assert.rejects(f.service.send(guardian, input({ requestId: 'request-0002' })), code('AI_BUSY'));
  reply.resolve(answer());
  await sending;
  assert.equal(f.calls.length, 1);
  await f.service.close();
});

test('uncertain provider failures are redacted, consume the cap and never retry by request ID', async () => {
  const f = fixture({ maxCalls: 2, respond: () => { throw new Error('secret fixture raw diagnostic'); } });
  await assert.rejects(f.service.send(guardian, input()), code('AI_PROVIDER_UNAVAILABLE'));
  await assert.rejects(f.service.send(guardian, input()), code('AI_REQUEST_FAILED'));
  await assert.rejects(f.service.send(guardian, input({ requestId: 'request-0002' })), code('AI_PROVIDER_UNAVAILABLE'));
  await assert.rejects(f.service.send(guardian, input({ requestId: 'request-0003' })), code('AI_LIMIT'));
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service.get(guardian, { conversationId: 'room-a' })).revision, 0);
  await f.service.close();
});

test('already-cancelled request does not call the model', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.send(guardian, input(), { signal: controller.signal }), code('AI_CANCELLED'));
  assert.equal(f.calls.length, 0);
  await f.service.close();
});

test('cancellation discards late response and keeps the charged request tombstone', async () => {
  const ready = deferred(), reply = deferred(), controller = new AbortController();
  const f = fixture({ respond: (_payload, { signal }) => { signal.addEventListener('abort', () => ready.resolve()); return reply.promise; } });
  const sending = f.service.send(guardian, input(), { signal: controller.signal });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await ready.promise;
  reply.resolve(answer());
  await assert.rejects(sending, code('AI_CANCELLED'));
  assert.deepEqual((await f.service.get(guardian, { conversationId: 'room-a' })).messages, []);
  await assert.rejects(f.service.send(guardian, input()), code('AI_REQUEST_FAILED'));
  await f.service.close();
});

test('close aborts and waits for actual provider settlement before releasing memory', async () => {
  const ready = deferred(), reply = deferred(); let providerAborted = false;
  const f = fixture({ respond: (_payload, { signal }) => { signal.addEventListener('abort', () => { providerAborted = true; }); ready.resolve(); return reply.promise; } });
  const sending = f.service.send(guardian, input());
  await ready.promise;
  let closed = false;
  const closing = f.service.close();
  closing.then(() => { closed = true; });
  assert.equal(f.service.close(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerAborted, true); assert.equal(closed, false);
  reply.resolve(answer());
  await assert.rejects(sending, code('AI_UNAVAILABLE'));
  await closing;
  await assert.rejects(f.service.get(guardian, { conversationId: 'room-a' }), code('AI_UNAVAILABLE'));
});

test('bounded multi-turn history removes complete pairs and signals truncation', async () => {
  const f = fixture(); let result;
  for (let turn = 0; turn < 8; turn++) {
    result = await f.service.send(guardian, input({ requestId: `request-${String(turn).padStart(4, '0')}`,
      expectedRevision: turn, message: `가상 질문 ${turn}` }));
    assert.ok(result.messages.length <= 12);
    assert.ok(f.calls[turn].messages.length <= 12);
    assert.equal(f.calls[turn].messages.at(-1).role, 'user');
  }
  assert.equal(result.contextTruncated, true);
  assert.equal(result.messages[0].content, '가상 질문 2');
  await f.service.close();
});

test('long replies respect total provider context limit without splitting a turn', async () => {
  const f = fixture({ respond: () => answer('가'.repeat(6000)) });
  for (let turn = 0; turn < 5; turn++) {
    await f.service.send(guardian, input({ requestId: `request-${String(turn).padStart(4, '0')}`,
      expectedRevision: turn, message: '나'.repeat(2000) }));
    const messages = f.calls.at(-1).messages;
    assert.ok(messages.reduce((n, message) => n + message.content.length, 0) <= 16000);
    messages.forEach((message, index) => assert.equal(message.role, index % 2 === 0 ? 'user' : 'assistant'));
  }
  assert.equal((await f.service.get(guardian, { conversationId: 'room-a' })).contextTruncated, true);
  await f.service.close();
});

test('invalid input, unknown fields, accessors and caller roles fail before model access', async () => {
  const f = fixture();
  const getter = input(); Object.defineProperty(getter, 'message', { get() { throw new Error('Getter must not run'); }, enumerable: true });
  const cases = [input({ message: '' }), input({ message: 'x'.repeat(2001) }), input({ message: '\ud800' }),
    input({ message: 'text\u0000control' }), input({ expectedRevision: -1 }), input({ expectedRevision: 1.5 }),
    input({ requestId: 'short' }), input({ privateNote: 'do not send' }), getter, { ...input(), [Symbol('key')]: 'bad' }];
  for (const value of cases) await assert.rejects(f.service.send(guardian, value), code('INVALID_INPUT'));
  await assert.rejects(f.service.send({ ...guardian, role: 'therapist' }, input()), code('INVALID_INPUT'));
  assert.equal(f.calls.length, 0);
  await f.service.close();
});

test('malformed model output is rejected without creating conversation history', async () => {
  for (const result of [null, answer(''), answer('a'.repeat(6001)), answer('\ud800'), answer('a\u0000b'),
    { ...answer(), raw: 'private' }, { text: 'safe', usage: { inputTokens: -1, outputTokens: 3 } },
    { text: 'safe', usage: { inputTokens: 1, outputTokens: 3, raw: 'private' } }]) {
    const f = fixture({ respond: () => result });
    await assert.rejects(f.service.send(guardian, input()), code('AI_OUTPUT_INVALID'));
    assert.deepEqual((await f.service.get(guardian, { conversationId: 'room-a' })).messages, []);
    await f.service.close();
  }
});

test('session allocation is bounded and never evicts an expense tombstone', async () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) await f.service.get(guardian, { conversationId: `room-${i}` });
  await assert.rejects(f.service.get(guardian, { conversationId: 'room-overflow' }), code('AI_LIMIT'));
  assert.equal(f.calls.length, 0);
  await f.service.close();
});

test('invalid dependencies and unrecognized provider configuration fail closed', () => {
  const f = fixture();
  for (const options of [{}, { conversations: f.conversations, provider: { ...f.provider, mode: 'pretend' } },
    { conversations: f.conversations, provider: f.provider, maxCalls: 0 },
    { conversations: f.conversations, provider: { ...f.provider, model: 'secret\nmodel' } }]) {
    assert.throws(() => new AiConversations(options), TypeError);
  }
});
