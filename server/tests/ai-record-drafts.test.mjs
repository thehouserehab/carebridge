import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiRecordDrafts } from '../ai-record-drafts.mjs';
import { fail } from '../errors.mjs';

const actor = { userId: 'therapist-a', centerId: 'center-a' };
const selected = { conversationId: 'room-a', recordId: 'record-a', expectedRevision: 1 };
const code = expected => error => error?.code === expected;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ generate, maxCalls = 20, get } = {}) {
  const state = { calls: [], reads: [], allowed: true, record: { id: 'record-a', conversationId: 'room-a', revision: 1,
    performed: '블록 두 개를 쌓도록 안내함', response: '도움을 받아 두 개를 쌓음',
    name: 'NEVER-SEND-NAME', privateNote: 'NEVER-SEND-NOTE', nextPlan: 'NEVER-SEND-PLAN',
    attachments: [{ id: 'NEVER-SEND-FILE' }], referenceSources: ['NEVER-SEND-CHAT'] } };
  const records = { async get(identity, query) {
    state.reads.push({ identity: { ...identity }, query: { ...query } });
    if (!state.allowed || identity.userId !== actor.userId || identity.centerId !== actor.centerId || query.conversationId !== selected.conversationId)
      fail('FORBIDDEN');
    if (get) await get();
    return structuredClone(state.record);
  }, save() { throw new Error('Clinical writes are forbidden in this test.'); } };
  const provider = { mode: 'fixture', model: 'synthetic-summary', async generate(source, options) {
    state.calls.push({ source, signal: options.signal });
    return generate ? generate(source, options) : { summary: '도움을 받아 블록 두 개를 쌓았어요.', reviewNotes: ['원문과 확인해 주세요.'],
      usage: { inputTokens: 10, outputTokens: 10 } };
  } };
  const service = new AiRecordDrafts({ records, provider, maxCalls });
  const input = async (requestId = 'request-0001') => ({ ...selected, sourceHash: (await service.preview(actor, selected)).sourceHash, requestId });
  return { state, service, input };
}

test('preview exposes exactly selected source fields; generation returns a review-only draft', async () => {
  const { state, service, input } = fixture();
  const preview = await service.preview(actor, selected);
  assert.deepEqual(Object.keys(preview).sort(), ['model','mode','recordId','revision','source','sourceHash'].sort());
  assert.deepEqual(preview.source, { performed: state.record.performed, response: state.record.response });
  assert.match(preview.sourceHash, /^[a-f0-9]{64}$/);
  const draft = await service.generate(actor, await input());
  assert.equal(draft.summary, '도움을 받아 블록 두 개를 쌓았어요.');
  assert.equal(draft.mode, 'fixture');
  assert.equal(draft.model, 'synthetic-summary');
  assert.deepEqual(Object.keys(state.calls[0].source), ['performed','response']);
  assert(!JSON.stringify(state.calls[0].source).includes('NEVER-SEND'));
  assert(!Object.hasOwn(draft, 'usage'));
  assert(!JSON.stringify(draft).includes('NEVER-SEND'));
});

test('current authority is checked before provider and during cache replay', async () => {
  const { state, service, input } = fixture();
  const request = await input();
  state.allowed = false;
  await assert.rejects(service.generate(actor, request), code('FORBIDDEN'));
  assert.equal(state.calls.length, 0);
  state.allowed = true; await service.generate(actor, request); state.allowed = false;
  await assert.rejects(service.generate(actor, request), code('FORBIDDEN'));
  assert.equal(state.calls.length, 1);
});

test('same request replays one result; returned objects cannot mutate cached content', async () => {
  const { state, service, input } = fixture();
  const request = await input(), first = await service.generate(actor, request);
  first.summary = 'tampered'; first.reviewNotes.push('tampered');
  const replay = await service.generate(actor, request);
  assert.equal(state.calls.length, 1);
  assert.equal(replay.summary, '도움을 받아 블록 두 개를 쌓았어요.');
  assert.equal(replay.reviewNotes.length, 1);
});

test('same request ID with new source is rejected without another call', async () => {
  const { state, service, input } = fixture();
  await service.generate(actor, await input());
  state.record.response = '새로운 관찰';
  await assert.rejects(service.generate(actor, await input()), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(state.calls.length, 1);
});

test('stale revision and stale source hash never reach provider', async () => {
  const { state, service, input } = fixture();
  const request = await input();
  state.record.revision++;
  await assert.rejects(service.generate(actor, request), code('AI_SOURCE_CHANGED'));
  state.record.revision--; state.record.response = 'changed';
  await assert.rejects(service.generate(actor, request), code('AI_SOURCE_CHANGED'));
  assert.equal(state.calls.length, 0);
});

test('one in-flight call; same and other IDs cannot start additional generation', async () => {
  const started = deferred(), finish = deferred();
  const { state, service, input } = fixture({ generate: async () => { started.resolve(); return finish.promise; } });
  const request = await input(), first = service.generate(actor, request);
  await started.promise;
  await assert.rejects(service.generate(actor, request), code('AI_BUSY'));
  await assert.rejects(service.generate(actor, { ...request, requestId: 'request-0002' }), code('AI_BUSY'));
  finish.resolve({ summary: '가상 요약', reviewNotes: [] }); await first;
  assert.equal(state.calls.length, 1);
});

for (const change of ['revision', 'content', 'permission']) {
  test('late '+change+' change discards generated content', async () => {
    const started = deferred(), finish = deferred();
    const { state, service, input } = fixture({ generate: async () => { started.resolve(); return finish.promise; } });
    const request = await input(), pending = service.generate(actor, request); await started.promise;
    if (change === 'permission') state.allowed = false;
    else if (change === 'revision') state.record.revision++;
    else state.record.performed = '새 관찰';
    finish.resolve({ summary: 'MUST-NOT-RETURN', reviewNotes: [] });
    await assert.rejects(pending, code(change === 'permission' ? 'FORBIDDEN' : 'AI_SOURCE_CHANGED'));
    state.allowed = true; state.record.revision = 1; state.record.performed = '블록 두 개를 쌓도록 안내함';
    await assert.rejects(service.generate(actor, request), code('AI_REQUEST_FAILED'));
    assert.equal(state.calls.length, 1);
  });
}

test('provider exceptions are sanitized, tombstoned and counted against total limit', async () => {
  const { state, service, input } = fixture({ maxCalls: 2, generate() { throw Object.assign(new Error('SECRET-PROVIDER-FAILURE'), { code:'FORBIDDEN' }); } });
  const request = await input();
  await assert.rejects(service.generate(actor, request), error => error.code === 'AI_REQUEST_FAILED' && !error.message.includes('SECRET'));
  await assert.rejects(service.generate(actor, request), code('AI_REQUEST_FAILED'));
  assert.equal(state.calls.length, 1);
  await assert.rejects(service.generate(actor, { ...request, requestId:'request-0002' }), code('AI_REQUEST_FAILED'));
  await assert.rejects(service.generate(actor, { ...request, requestId:'request-0003' }), code('AI_LIMIT'));
  assert.equal(state.calls.length, 2);
});

test('abort is forwarded to provider and an uncertain request cannot replay', async () => {
  const started = deferred(), controller = new AbortController();
  const { state, service, input } = fixture({ generate: (_source, {signal}) => new Promise((resolve,reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new Error('private abort reason')), {once:true});
  }) });
  const request = await input(), pending = service.generate(actor, request, {signal:controller.signal});
  await started.promise; controller.abort(); await assert.rejects(pending, code('AI_REQUEST_FAILED'));
  assert.equal(state.calls[0].signal.aborted, true);
  await assert.rejects(service.generate(actor, request), code('AI_REQUEST_FAILED'));
  assert.equal(state.calls.length, 1);
});

test('pre-aborted request consumes no provider call', async () => {
  const { state, service, input } = fixture();
  await assert.rejects(service.generate(actor, await input(), {signal:AbortSignal.abort()}), code('AI_REQUEST_FAILED'));
  assert.equal(state.calls.length, 0);
});

test('close aborts and settles active generation, clears receipts, and forbids reuse', async () => {
  const started = deferred();
  const { service, input } = fixture({ generate: (_source,{signal}) => new Promise((resolve,reject) => {
    started.resolve(); signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }) });
  const request = await input(), pending = service.generate(actor,request);
  const rejected = assert.rejects(pending,code('AI_REQUEST_FAILED'));
  await started.promise; await service.close(); await rejected;
  await assert.rejects(service.preview(actor,selected),code('AI_UNAVAILABLE'));
  await assert.rejects(service.generate(actor,request),code('AI_UNAVAILABLE'));
});

test('strict input, source length and empty-source validation block arbitrary content', async () => {
  const {state,service,input}=fixture(), request=await input();
  for(const invalid of [{...request,privateNote:'inject'},{...request,expectedRevision:0},{...request,sourceHash:'bad'},
    {...request,requestId:'bad'},{...request,recordId:'../record'}])
    await assert.rejects(service.generate(actor,invalid),code('INVALID_INPUT'));
  state.record.performed='x'.repeat(2001);
  await assert.rejects(service.preview(actor,selected),code('INVALID_INPUT'));
  state.record.performed=' ';state.record.response='';
  await assert.rejects(service.preview(actor,selected),code('INVALID_INPUT'));
  assert.equal(state.calls.length,0);
});

for(const output of [{summary:'',reviewNotes:[]},{summary:'ok',reviewNotes:['x'.repeat(201)]},
  {summary:'x'.repeat(1201),reviewNotes:[]},
  {summary:'ok',reviewNotes:[],privateNote:'unexpected'}, {summary:'ok',reviewNotes:Array(5).fill('too many')}]) {
  test('malformed provider output stays a failed draft: '+JSON.stringify(output).slice(0,60),async()=>{
    const {service,input}=fixture({generate:()=>output});
    await assert.rejects(service.generate(actor,await input()),code('AI_REQUEST_FAILED'));
  });
}
