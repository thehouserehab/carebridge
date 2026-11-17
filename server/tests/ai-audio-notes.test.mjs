import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AiAudioNotes } from '../ai-audio-notes.mjs';
import { fail } from '../errors.mjs';
import { AUDIO_NOTE_MAX_BYTES, normalizeAudioNoteFile, matchesAudioNoteSignature,
  validateAudioAnalysisResult, audioNoteFields } from '../../src/audio-note-contract.js';

const actor = { userId: 'therapist-a', centerId: 'center-a' };
const selected = { conversationId: 'room-a', recordId: 'record-a' };
const code = expected => error => error?.code === expected;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const wav = size => { const bytes = Buffer.alloc(size ?? 44); bytes.write('RIFF', 0); bytes.write('WAVE', 8); return bytes; };
const result = () => ({ transcript: { text: '가상 사례: 블록 놀이를 했습니다.', durationSeconds: 2,
  segments: [{ id: 0, start: 0, end: 2, text: '가상 사례: 블록 놀이를 했습니다.' }] },
  analysis: { performed: [{ text: '블록 놀이를 했습니다.', segmentIds: [0] }], response: [],
    reflection: [{ text: '안내 방법을 확인해 주세요.', segmentIds: [0] }], nextPlan: [],
    summary: [{ text: '블록 놀이에 참여했어요.', segmentIds: [0] }], warnings: ['녹음으로 확인하지 못한 반응은 직접 확인해 주세요.'] } });
function fixture({ generate, maxCalls = 10, get, allowOther = false } = {}) {
  const state = { allowed: true, revision: 1, calls: [], reads: [] };
  const records = { async get(owner, query) {
    state.reads.push({ owner: { ...owner }, query: { ...query } });
    if (!state.allowed || (!allowOther && (owner.userId !== actor.userId || owner.centerId !== actor.centerId))) fail('FORBIDDEN');
    if (get) await get(owner, query);
    return { id: query.recordId, conversationId: query.conversationId, revision: state.revision,
      performed: 'NEVER-FORWARD-RECORD', privateNote: 'NEVER-FORWARD-PRIVATE' };
  }, save() { throw new Error('Audio analysis must not write clinical records.'); } };
  const provider = { mode: 'fixture', model: 'synthetic-analysis', transcriptionModel: 'synthetic-transcription',
    async generate(source, options) { state.calls.push({ source, options }); return generate ? generate(source, options) : result(); } };
  const service = new AiAudioNotes({ records, provider, maxCalls });
  const upload = (requestId = 'upload-0001', extra = {}, owner = actor) => service.upload(owner, {
    ...selected, expectedRevision: state.revision, requestId, filename: 'synthetic.wav', type: 'audio/wav',
    base64: wav().toString('base64'), syntheticConfirmed: true, processingConfirmed: true, ...extra });
  return { state, service, upload };
}
const pick = session => ({ ...selected, sessionId: session.id });
const startInput = (session, requestId = 'start-0001') => ({ ...pick(session), expectedRevision: session.revision, requestId });
async function settle(service, session) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await service.get(actor, pick(session));
    if (current.state !== 'processing') return current;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Synthetic audio job did not settle.');
}

test('shared normalization admits only matching audio filename and MIME, with supported aliases', () => {
  for (const [filename, type, expected] of [['test.M4A', 'audio/x-m4a', 'audio/mp4'], ['test.mp3', '', 'audio/mpeg'],
    ['test.wav', 'audio/x-wav', 'audio/wav'], ['test.webm', 'audio/webm', 'audio/webm']])
    assert.deepEqual(normalizeAudioNoteFile({ filename, type }), { filename, type: expected });
  for (const [filename, type] of [['test.mp4', 'video/mp4'], ['test.wav', 'audio/mpeg'], ['../test.wav', 'audio/wav'],
    ['test.wav\r\nHeader: injected', 'audio/wav'], ['test.wav', 'application/octet-stream']])
    assert.throws(() => normalizeAudioNoteFile({ filename, type }), TypeError);
});
test('audio hints recognize four signatures but reject mismatched and truncated files', () => {
  const fixtures = [['audio/wav', wav()], ['audio/mp4', Buffer.from('0000ftypM4A 00000')],
    ['audio/mpeg', Buffer.from('ID3000000000000')], ['audio/webm', Buffer.from([26, 69, 223, 163, ...Array(12).fill(0)])]];
  for (const [type, bytes] of fixtures) assert.equal(matchesAudioNoteSignature(type, bytes), true);
  assert.equal(matchesAudioNoteSignature('audio/mp4', wav()), false);
  assert.equal(matchesAudioNoteSignature('audio/wav', wav().subarray(0, 11)), false);
  assert.equal(matchesAudioNoteSignature('video/mp4', fixtures[1][1]), false);
});
test('shared result projection preserves evidence and keeps reflection outside public summary', () => {
  const source = result(), clean = validateAudioAnalysisResult(source), fields = audioNoteFields(clean);
  source.analysis.summary[0].text = 'mutated'; source.transcript.segments[0].text = 'mutated';
  assert.equal(clean.analysis.summary[0].text, '블록 놀이에 참여했어요.');
  assert.equal(fields.summary, '블록 놀이에 참여했어요.');
  assert.match(fields.privateNote, /안내 방법/); assert.match(fields.privateNote, /직접 확인/);
  assert.equal(fields.response, ''); assert.equal(fields.nextPlan, '');
  assert(!fields.summary.includes('안내 방법'));
});
for (const [label, mutate] of [
  ['unknown root field', r => { r.speaker = 'therapist'; }],
  ['invented speaker', r => { r.transcript.segments[0].speaker = 'guardian'; }],
  ['unknown segment reference', r => { r.analysis.summary[0].segmentIds = [1]; }],
  ['missing evidence reference', r => { r.analysis.summary[0].segmentIds = []; }],
  ['duplicated evidence reference', r => { r.analysis.summary[0].segmentIds = [0, 0]; }],
  ['nonsequential segment', r => { r.transcript.segments[0].id = 2; }],
  ['negative start', r => { r.transcript.segments[0].start = -1; }],
  ['end beyond source', r => { r.transcript.segments[0].end = 3; }],
  ['zero duration', r => { r.transcript.durationSeconds = 0; }],
  ['excessive duration', r => { r.transcript.durationSeconds = 7201; }],
  ['nonfinite duration', r => { r.transcript.durationSeconds = Infinity; }],
  ['transcript limit', r => { r.transcript.text = 'a'.repeat(60001); }],
  ['empty segment list', r => { r.transcript.segments = []; }],
  ['claim limit', r => { r.analysis.performed = Array.from({ length: 7 }, () => ({ text: 'claim', segmentIds: [0] })); }],
  ['claim text limit', r => { r.analysis.performed[0].text = 'a'.repeat(301); }],
  ['summary text limit', r => { r.analysis.summary[0].text = 'a'.repeat(201); }],
  ['warning limit', r => { r.analysis.warnings = Array(9).fill('warning'); }],
  ['private field overflow', r => { r.analysis.reflection = Array.from({ length: 6 }, () => ({ text: 'a'.repeat(300), segmentIds: [0] })); r.analysis.warnings = Array(8).fill('a'.repeat(200)); }],
  ['control content', r => { r.transcript.text = 'bad\u0000content'; }],
]) test('shared contract rejects '+label, () => { const r = result(); mutate(r); assert.throws(() => validateAudioAnalysisResult(r), TypeError); });

test('upload, explicit start and ready result retain original separately without clinical writes', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const uploaded = await f.upload();
  assert.equal(uploaded.state, 'uploaded'); assert.equal(uploaded.syntheticOnly, true); assert.equal(uploaded.revision, 1);
  assert.equal(f.state.calls.length, 0);
  assert.equal(uploaded.sha256, createHash('sha256').update(wav()).digest('hex'));
  assert.deepEqual(Object.keys(uploaded).sort(), ['id','recordId','recordRevision','revision','filename','type','size','sha256','receivedAt',
    'state','mode','model','transcriptionModel','result','events','syntheticOnly'].sort());
  const processing = await f.service.start(actor, startInput(uploaded));
  assert.equal(processing.state, 'processing'); assert.equal(processing.revision, 2);
  const ready = await settle(f.service, uploaded);
  assert.equal(ready.state, 'ready'); assert.equal(ready.revision, 3); assert.deepEqual(ready.result, result());
  assert.deepEqual(ready.events.map(event => event.kind), ['uploaded', 'processing', 'ready']);
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(Object.keys(f.state.calls[0].source).sort(), ['bytes', 'type']);
  assert.equal(f.state.calls[0].source.bytes.every(byte => byte === 0), true);
  const original = await f.service.getOriginal(actor, pick(uploaded));
  assert.deepEqual(original.bytes, wav()); original.bytes.fill(0);
  assert.deepEqual((await f.service.getOriginal(actor, pick(uploaded))).bytes, wav());
  ready.result.analysis.summary[0].text = 'mutated';
  assert.equal((await f.service.get(actor, pick(uploaded))).result.analysis.summary[0].text, result().analysis.summary[0].text);
});

test('upload and start retries reuse a session and one provider call', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.upload(), replay = await f.upload(); assert.equal(replay.id, first.id);
  await f.service.start(actor, startInput(first)); await settle(f.service, first);
  assert.equal((await f.service.start(actor, startInput(first))).state, 'ready');
  assert.equal(f.state.calls.length, 1); assert.equal((await f.service.list(actor, selected)).length, 1);
  await assert.rejects(f.upload('upload-0001', { filename: 'changed.wav' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.service.start(actor, { ...startInput(first), expectedRevision: 2 }), code('IDEMPOTENCY_CONFLICT'));
});
test('another authorized therapist cannot list, read, remove or process an owner session', async t => {
  const f = fixture({ allowOther: true }); t.after(() => f.service.close()); const session = await f.upload();
  for (const other of [{ ...actor, userId: 'therapist-b' }, { ...actor, centerId: 'center-b' }]) {
    assert.deepEqual(await f.service.list(other, selected), []);
    for (const method of ['get', 'getOriginal', 'remove']) await assert.rejects(f.service[method](other, pick(session)), code('NOT_FOUND'));
    await assert.rejects(f.service.start(other, startInput(session)), code('NOT_FOUND'));
  }
  assert.equal(f.state.calls.length, 0);
});
test('current record authorization guards every public access', async t => {
  const f = fixture(); t.after(() => f.service.close()); const session = await f.upload(); f.state.allowed = false;
  for (const method of ['get', 'getOriginal', 'remove']) await assert.rejects(f.service[method](actor, pick(session)), code('FORBIDDEN'));
  await assert.rejects(f.service.list(actor, selected), code('FORBIDDEN'));
  await assert.rejects(f.service.assertUsable(actor, selected), code('FORBIDDEN'));
  await assert.rejects(f.upload('upload-0002'), code('FORBIDDEN'));
  await assert.rejects(f.service.start(actor, startInput(session)), code('FORBIDDEN'));
  await assert.rejects(f.service.cancel(actor, startInput(session)), code('FORBIDDEN'));
});
test('changed record permits read/cancel but never generation', async t => {
  const f = fixture(); t.after(() => f.service.close()); const session = await f.upload(); f.state.revision = 2;
  assert.equal((await f.service.get(actor, pick(session))).recordRevision, 1);
  assert.equal((await f.service.list(actor, selected)).length, 1);
  await assert.rejects(f.service.start(actor, startInput(session)), code('AI_SOURCE_CHANGED'));
  assert.equal((await f.service.cancel(actor, startInput(session, 'cancel-0001'))).state, 'cancelled');
  assert.equal(f.state.calls.length, 0);
});
test('start/cancel compare session revision, independently of uploaded record revision', async t => {
  const finish = deferred(), entered = deferred();
  const f = fixture({ generate: async () => { entered.resolve(); return finish.promise; } });
  t.after(() => { finish.resolve(result()); return f.service.close(); }); f.state.revision = 7;
  const session = await f.upload(); assert.equal(session.recordRevision, 7); assert.equal(session.revision, 1);
  await assert.rejects(f.service.start(actor, { ...startInput(session), expectedRevision: 7 }), code('AI_SOURCE_CHANGED'));
  const processing = await f.service.start(actor, startInput(session)); await entered.promise;
  await assert.rejects(f.service.cancel(actor, startInput(session, 'cancel-0001')), code('AI_SOURCE_CHANGED'));
  const cancellation = startInput(processing, 'cancel-0001');
  assert.equal((await f.service.cancel(actor, cancellation)).state, 'cancelled');
  assert.equal((await f.service.cancel(actor, cancellation)).revision, 3);
  finish.resolve(result());
});
test('one global job blocks another session while processing', async t => {
  const finish = deferred(), entered = deferred(); const f = fixture({ generate: async () => { entered.resolve(); return finish.promise; } });
  t.after(() => { finish.resolve(result()); return f.service.close(); });
  const first = await f.upload(), second = await f.upload('upload-0002');
  await f.service.start(actor, startInput(first)); await entered.promise;
  await assert.rejects(f.service.start(actor, startInput(second, 'start-0002')), code('AI_BUSY'));
  assert.equal(f.state.calls.length, 1); finish.resolve(result());
});
for (const kind of ['cancel', 'remove', 'close', 'permission', 'record-revision', 'session-revoke'])
  test('late provider response cannot commit after '+kind, async t => {
    const finish = deferred(), entered = deferred(); let authenticated = true;
    const f = fixture({ generate: async () => { entered.resolve(); return finish.promise; } });
    t.after(() => { finish.resolve(result()); return f.service.close(); });
    const first = await f.upload(), processing = await f.service.start(actor, startInput(first), {
      authorizeSession: async () => { if (!authenticated) fail('FORBIDDEN'); } });
    await entered.promise; let closing;
    if (kind === 'cancel') await f.service.cancel(actor, startInput(processing, 'cancel-0001'));
    if (kind === 'remove') await f.service.remove(actor, pick(first));
    if (kind === 'close') closing = f.service.close();
    if (kind === 'permission') f.state.allowed = false;
    if (kind === 'record-revision') f.state.revision = 2;
    if (kind === 'session-revoke') authenticated = false;
    finish.resolve(result());
    if (closing) { await closing; await assert.rejects(f.service.get(actor, pick(first)), code('AI_UNAVAILABLE')); }
    else if (kind === 'remove') await assert.rejects(f.service.get(actor, pick(first)), code('NOT_FOUND'));
    else {
      if (kind === 'permission') { await new Promise(resolve => setImmediate(resolve)); f.state.allowed = true; }
      const final = await settle(f.service, first);
      assert.equal(final.result, null); assert.equal(final.state, kind === 'cancel' ? 'cancelled' : 'failed');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.calls[0].source.bytes.every(byte => byte === 0), true);
  });
test('session expiry during final record read is checked again before committing', async t => {
  let finishing = false, authenticated = true;
  const f = fixture({ get: async () => { if (finishing) authenticated = false; }, generate: async () => { finishing = true; return result(); } });
  t.after(() => f.service.close()); const first = await f.upload();
  await f.service.start(actor, startInput(first), { authorizeSession: async () => { if (!authenticated) fail('FORBIDDEN'); } });
  assert.equal((await settle(f.service, first)).state, 'failed');
});
test('provider exceptions and malformed output become content-free failure without automatic retry', async t => {
  for (const generate of [async () => { throw new Error('PRIVATE-provider-error'); }, async () => ({ ...result(), secret: 'PRIVATE' })]) {
    const f = fixture({ generate, maxCalls: 1 }); t.after(() => f.service.close()); const first = await f.upload();
    await f.service.start(actor, startInput(first)); const final = await settle(f.service, first);
    assert.equal(final.state, 'failed'); assert.equal(final.result, null); assert(!JSON.stringify(final).includes('PRIVATE'));
    assert.equal((await f.service.start(actor, startInput(first))).state, 'failed');
    const second = await f.upload('upload-0002');
    await assert.rejects(f.service.start(actor, startInput(second, 'start-0002')), code('AI_LIMIT'));
    assert.equal(f.state.calls.length, 1);
  }
});
test('three sessions per record and twenty global sessions are enforced after asynchronous authorization', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => f.upload('upload-000'+i)));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 3);
  assert.equal(attempts.find(x => x.status === 'rejected').reason.code, 'AI_LIMIT');
  for (let i = 3; i < 20; i++) await f.upload('upload-global-'+i, { recordId: 'record-'+i });
  await assert.rejects(f.upload('upload-global-20', { recordId: 'record-20' }), code('AI_LIMIT'));
  const one = (await f.service.list(actor, selected))[0]; await f.service.remove(actor, pick(one));
  await f.upload('upload-global-21', { recordId: 'record-21' });
  await assert.rejects(f.upload('upload-0000'), code('NOT_FOUND'));
});
for (const [label, extra] of [
  ['synthetic consent absent', { syntheticConfirmed: false }], ['processing consent absent', { processingConfirmed: false }],
  ['invalid base64', { base64: 'not-base64=======' }], ['base64 with whitespace', { base64: wav().toString('base64')+'\n' }],
  ['wrong signature', { base64: Buffer.alloc(44).toString('base64') }], ['mismatched MIME', { type: 'audio/mpeg' }],
  ['unknown properties', { arbitrary: true }], ['stale record', { expectedRevision: 2 }],
]) test('upload rejects '+label+' before any model call', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.upload('upload-0001', extra), code(label === 'stale record' ? 'AI_SOURCE_CHANGED' : 'INVALID_INPUT'));
  assert.equal(f.state.calls.length, 0); assert.deepEqual(await f.service.list(actor, selected), []);
});
test('oversized uploads are rejected before decoding and any authorization or provider call', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.upload('upload-large', { base64: 'A'.repeat(4 * Math.ceil(AUDIO_NOTE_MAX_BYTES / 3) + 4) }), code('INVALID_INPUT'));
  assert.equal(f.state.reads.length, 0); assert.equal(f.state.calls.length, 0);
});
test('retained originals and a provider copy share the eighty MiB budget, reserved before job awaits', async t => {
  const finish = deferred(), entered = deferred();
  const f = fixture({ generate: async () => { entered.resolve(); return finish.promise; } });
  t.after(() => { finish.resolve(result()); return f.service.close(); });
  const base64 = wav(AUDIO_NOTE_MAX_BYTES).toString('base64'), sessions = [];
  for (let i = 0; i < 4; i++) sessions.push(await f.upload('upload-budget-'+i, { recordId: 'budget-'+i, base64 }));
  const firstSelection = { ...startInput(sessions[0]), recordId: 'budget-0' };
  await assert.rejects(f.service.start(actor, firstSelection), code('AI_LIMIT'));
  assert.equal(f.state.calls.length, 0);
  await f.service.remove(actor, { ...pick(sessions[3]), recordId: 'budget-3' });
  await f.service.start(actor, firstSelection);
  await assert.rejects(f.upload('upload-budget-full', { recordId: 'budget-new' }), code('AI_LIMIT'));
  await entered.promise; finish.resolve(result());
  for (let i = 0; i < 50; i++) {
    if ((await f.service.get(actor, { ...pick(sessions[0]), recordId: 'budget-0' })).state === 'ready') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  const ready = await f.service.get(actor, { ...pick(sessions[0]), recordId: 'budget-0' });
  assert.equal(ready.state, 'ready');
  await f.upload('upload-budget-released', { recordId: 'budget-new' });
  assert.equal(f.state.calls[0].source.bytes.every(byte => byte === 0), true);
});
test('authorization rejected before start never changes state or calls provider', async t => {
  const f = fixture(); t.after(() => f.service.close()); const session = await f.upload();
  await assert.rejects(f.service.start(actor, startInput(session), { authorizeSession: async () => fail('FORBIDDEN') }), code('FORBIDDEN'));
  assert.equal((await f.service.get(actor, pick(session))).state, 'uploaded'); assert.equal(f.state.calls.length, 0);
});
test('upload metadata has no path, raw bytes, identity or clinical record disclosure', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.upload();
  const views = JSON.stringify(await f.service.list(actor, selected));
  for (const forbidden of ['NEVER-FORWARD', 'base64', 'owner', 'bytes', actor.userId, actor.centerId]) assert(!views.includes(forbidden));
  const first = (await f.service.list(actor, selected))[0]; first.events.push({ kind: 'tamper', at: 'bad' });
  assert.equal((await f.service.get(actor, pick(first))).events.length, 1);
});
for (const change of ['session-revoke', 'membership-revoke', 'record-revision', 'cancel', 'remove', 'close'])
  test('stage authorization prevents analysis dispatch after transcription and '+change, async t => {
    const transcribed = deferred(), continueJob = deferred(), blocked = deferred(), stages = [];
    let authenticated = true;
    const f = fixture({ generate: async (_source, options) => {
      await options.authorizeStage('transcription'); stages.push('transcription');
      transcribed.resolve(); await continueJob.promise;
      try { await options.authorizeStage('analysis'); }
      catch (error) { blocked.resolve(); throw error; }
      stages.push('analysis'); return result();
    } });
    t.after(() => { continueJob.resolve(); return f.service.close(); });
    const uploaded = await f.upload(), processing = await f.service.start(actor, startInput(uploaded), {
      authorizeSession: async () => { if (!authenticated) fail('FORBIDDEN'); } });
    await transcribed.promise;
    let closing;
    if (change === 'session-revoke') authenticated = false;
    if (change === 'membership-revoke') f.state.allowed = false;
    if (change === 'record-revision') f.state.revision++;
    if (change === 'cancel') await f.service.cancel(actor, startInput(processing, 'cancel-between-stages'));
    if (change === 'remove') await f.service.remove(actor, pick(uploaded));
    if (change === 'close') closing = f.service.close();
    continueJob.resolve(); await blocked.promise; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(stages, ['transcription']);
    assert.equal(f.state.calls[0].source.bytes.every(byte => byte === 0), true);
    if (closing) { await closing; await assert.rejects(f.service.get(actor, pick(uploaded)), code('AI_UNAVAILABLE')); }
    else if (change === 'remove') await assert.rejects(f.service.get(actor, pick(uploaded)), code('NOT_FOUND'));
    else {
      f.state.allowed = true;
      const final = await settle(f.service, uploaded);
      assert.equal(final.result, null); assert.equal(final.state, change === 'cancel' ? 'cancelled' : 'failed');
    }
  });
test('stage authorization rejects expiry before transcription and rejects unknown stages', async t => {
  const entered = deferred(), continueJob = deferred(), blocked = deferred(); let authenticated = true, dispatches = 0;
  const f = fixture({ generate: async (_source, options) => {
    await assert.rejects(options.authorizeStage('unknown'), code('INVALID_INPUT'));
    entered.resolve(); await continueJob.promise;
    try { await options.authorizeStage('transcription'); }
    catch (error) { blocked.resolve(); throw error; }
    dispatches++; return result();
  } });
  t.after(() => { continueJob.resolve(); return f.service.close(); }); const uploaded = await f.upload();
  await f.service.start(actor, startInput(uploaded), { authorizeSession: async () => { if (!authenticated) fail('FORBIDDEN'); } });
  await entered.promise; authenticated = false; continueJob.resolve(); await blocked.promise;
  assert.equal((await settle(f.service, uploaded)).state, 'failed'); assert.equal(dispatches, 0);
});
