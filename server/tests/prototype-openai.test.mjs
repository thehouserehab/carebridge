import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createPrototypeSandbox } from '../prototype-sandbox.mjs';
import { createLocalPrototypeApiSandbox } from '../local-api-sandbox.mjs';
import { createPrototypeProviders } from '../prototype-ai-fixtures.mjs';

// Explicit provider doubles exercise live-mode composition without credentials
// or external network. Actual model verification is a separate opt-in run.
let sandbox, actor, base, failChat = false;
const calls = [];
const aiProviders = {
  summaryProvider: { mode: 'openai', model: 'synthetic-openai-test', async generate(source) {
    calls.push({ kind: 'summary', source });
    return { summary: '가상 사례: 두 블록 중 파란 블록을 골랐어요.', reviewNotes: [] };
  } },
  chatProvider: { mode: 'openai', model: 'synthetic-openai-test', async respond(input) {
    calls.push({ kind: 'chat', input });
    if (failChat) throw new Error('PRIVATE-PROVIDER-ERROR');
    return { text: '가상 질문에 대한 연결 검증 응답입니다.', usage: { inputTokens: 7, outputTokens: 8 } };
  } },
};
async function request(route, { authenticated = true, method = 'GET', body } = {}) {
  const response = await fetch(sandbox.origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Origin: sandbox.origin, 'X-Carebridge-Request': '1',
      ...(authenticated && actor ? { Cookie: actor.cookie, 'X-Carebridge-Account': actor.userId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text,
    json: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
}
before(async () => {
  sandbox = await createPrototypeSandbox({ aiProviders });
  base = `/api/local/centers/${sandbox.ids.centerId}/conversations/${sandbox.ids.conversationId}`;
  const credential = sandbox.credentials.find(item => item.role === 'therapist');
  const login = await request('/api/local/auth/login', { authenticated: false, method: 'POST', body: { email: credential.email, password: credential.password } });
  assert.equal(login.status, 200);
  actor = { userId: login.json.user.userId, cookie: login.headers.get('set-cookie').split(';')[0] };
});
after(async () => {
  await sandbox?.close();
  if (sandbox) { assert.equal(sandbox.database.closed, true); await assert.rejects(access(sandbox.mediaRoot)); }
});

test('OpenAI composition is explicit, has no startup call, and exposes only honest mode markers', async () => {
  assert.equal(sandbox.aiMode, 'openai'); assert.equal(sandbox.mode, 'synthetic-prototype'); assert.deepEqual(calls, []);
  const page = await request('/');
  assert.match(page.text, /data-ai-mode="openai"/); assert.match(page.text, /data-prototype-mode="synthetic"/);
  assert.match(page.text, /data-media-mode="prepared-delivery"/);
  assert.match(page.text, /AI 대화와 선택한 기록 요약은 OpenAI로 전송/);
  assert.match(page.text, /녹음 정리와 파일 검사는 시연 응답/);
  assert(!page.text.includes('외부 API를 호출하지 않습니다'));
  assert(!page.text.includes('synthetic-openai-test')); // model/provider metadata is authenticated
  assert.equal((await request(base + '/ai-conversation', { authenticated: false })).status, 401);
  const conversation = (await request(base + '/ai-conversation')).json.conversation;
  assert.equal(conversation.mode, 'openai'); assert.equal(conversation.revision, 0); assert.deepEqual(calls, []);
});

test('home conversation forwards only explicit text, returns provider output and preserves it on reread', async () => {
  const body = { expectedRevision: 0, requestId: randomUUID(), message: '가상 시험: 입력한 질문만 전달하는지 확인합니다.' };
  const sent = await request(base + '/ai-conversation', { method: 'POST', body });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.conversation.mode, 'openai');
  assert.equal(sent.json.conversation.messages.at(-1).content, '가상 질문에 대한 연결 검증 응답입니다.');
  assert.deepEqual(calls, [{ kind: 'chat', input: { messages: [{ role: 'user', content: body.message }] } }]);
  assert.deepEqual((await request(base + '/ai-conversation')).json.conversation, sent.json.conversation);
  assert.deepEqual((await request(base + '/ai-conversation', { method: 'POST', body })).json.conversation, sent.json.conversation);
  assert.equal(calls.length, 1);
});

test('selected record summary uses OpenAI text provider while excluding private fields and never saves automatically', async () => {
  const route = `${base}/records/${sandbox.ids.recordId}/ai-summary`;
  const preview = (await request(route + '?revision=1')).json.preview;
  assert.equal(preview.mode, 'openai');
  const result = await request(route, { method: 'POST', body: { expectedRevision: 1, sourceHash: preview.sourceHash, requestId: randomUUID() } });
  assert.equal(result.status, 200, result.text); assert.equal(result.json.draft.mode, 'openai');
  assert.deepEqual(calls.at(-1), { kind: 'summary', source: {
    performed: '가상 사례: 파란 블록과 노란 블록 중 고르는 놀이를 했습니다.', response: '가상 사례: 하루가 파란 블록을 골랐습니다.' } });
  const record = await request(`${base}/records/${sandbox.ids.recordId}`);
  assert.equal(record.status, 200, record.text);
  assert.equal(record.json.record.revision, 1);
  assert.notEqual(record.json.record.summary, result.json.draft.summary);
});

test('provider failure is sanitized without fixture fallback, automatic retry or losing previous turns', async () => {
  const initial = (await request(base + '/ai-conversation')).json.conversation;
  const count = calls.length;
  const body = { requestId: randomUUID(), expectedRevision: initial.revision, message: '가상 오류 검증 질문' };
  failChat = true;
  try {
    const result = await request(base + '/ai-conversation', { method: 'POST', body });
    assert.equal(result.status, 503, result.text); assert.equal(result.json.error, 'AI_PROVIDER_UNAVAILABLE');
    assert(!result.text.includes('PRIVATE-PROVIDER-ERROR')); assert(!result.text.includes('예시 답변'));
    const retry = await request(base + '/ai-conversation', { method: 'POST', body });
    assert.equal(retry.status, 409); assert.equal(retry.json.error, 'AI_REQUEST_FAILED');
    assert.equal(calls.length, count + 1);
    assert.deepEqual((await request(base + '/ai-conversation')).json.conversation, initial);
  } finally { failChat = false; }
});

test('live text mode retains fixed-sample upload admission and fixture audio', async () => {
  const sample = sandbox.demoFiles.find(file => file.type === 'image/png');
  const changed = Buffer.from(sample.bytes); changed[changed.length - 1] ^= 1;
  const unknown = await request(base + '/uploads', { method: 'POST', body: { clientId: randomUUID(), file: {
    name: sample.name, type: sample.type, size: changed.length, sha256: createHash('sha256').update(changed).digest('hex') } } });
  assert.equal(unknown.status, 400);
  const accepted = await request(base + '/uploads', { method: 'POST', body: { clientId: randomUUID(), file: {
    name: sample.name, type: sample.type, size: sample.bytes.length, sha256: sample.sha256 } } });
  assert.equal(accepted.status, 200, accepted.text);
  const audio = sandbox.demoFiles.find(file => file.type === 'audio/wav');
  const uploaded = await request(`${base}/records/${sandbox.ids.recordId}/audio-notes`, { method: 'POST', body: {
    expectedRevision: 1, requestId: randomUUID(), filename: audio.name, type: audio.type, base64: audio.bytes.toString('base64'),
    syntheticConfirmed: true, processingConfirmed: true } });
  assert.equal(uploaded.status, 201, uploaded.text); assert.equal(uploaded.json.session.mode, 'fixture');
});

test('live prototype counts failed attempts against the 20-call lifetime cap', async () => {
  const route = base + '/ai-conversation';
  while (calls.filter(call => call.kind === 'chat').length < 20) {
    const previous = (await request(route)).json.conversation;
    const sent = await request(route, { method: 'POST', body: { expectedRevision: previous.revision, requestId: randomUUID(), message: '가상 호출 한도 검사' } });
    assert.equal(sent.status, 200, sent.text);
  }
  const previous = (await request(route)).json.conversation;
  const rejected = await request(route, { method: 'POST', body: { expectedRevision: previous.revision, requestId: randomUUID(), message: '가상 한도 초과 검사' } });
  assert.equal(rejected.json.error, 'AI_LIMIT'); assert.equal(calls.filter(call => call.kind === 'chat').length, 20);
});

test('invalid or implicit live configuration is rejected without enabling media or providers', async () => {
  for (const value of [null, {}, { chatProvider: aiProviders.chatProvider },
    { ...aiProviders, audioProvider: {} }, { ...aiProviders, chatProvider: { mode: 'fixture' } }]) {
    await assert.rejects(createPrototypeSandbox({ aiProviders: value }), TypeError);
  }
  const fixture = createPrototypeProviders();
  for (const options of [
    { ...fixture, ...aiProviders },
    { ...fixture, enableExternalAi: true },
    { ...fixture, ...aiProviders, enableExternalAi: 'true' },
    { ...fixture, ...aiProviders, audioProvider: { mode: 'openai' }, enableExternalAi: true },
  ]) await assert.rejects(createLocalPrototypeApiSandbox(options), TypeError);
});
