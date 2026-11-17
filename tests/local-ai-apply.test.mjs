import test from 'node:test';
import assert from 'node:assert/strict';
import { AiAssistantUi } from '../local-api/ai-assistant-ui.js';
import { CareUi, CareMutation } from '../local-api/care-ui.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const source = { performed: '합성 블록 놀이', response: '합성 참여 관찰' };
const draft = { recordId: 'test-record', revision: 2, sourceHash: 'a'.repeat(64), summary: '검토한 합성 요약' };
const preview = { recordId: draft.recordId, revision: draft.revision, sourceHash: draft.sourceHash, source };
const saved = () => ({ id: draft.recordId, revision: 2, conversationId: 'test-room', status: 'saved',
  date: '2026-11-06', title: '합성 기록', goalId: 'test-goal', ...source, summary: '기존 요약',
  nextPlan: '기존 계획', privateNote: '가상 비공개 메모', observation: null, activity: null,
  assessments: [], referenceSources: [], attachmentCount: 0 });

// Controller tests use DOM doubles; the actual browser suite separately checks
// layout. Keep the real opening, snapshot, cancellation and ownership logic.
function fixture(api = {}) {
  let context = { user: { userId: 'test-user', centers: [{ id: 'test-center', role: 'therapist' }] },
    role: 'therapist', centerId: 'test-center', roomId: 'test-room', generation: 1,
    connected: true, signal: new AbortController().signal, messages: [] };
  const errors = [], ui = new CareUi({ api: { record: async () => saved(), ...api },
    getContext: () => context, onError: error => errors.push(error) });
  ui.key = JSON.stringify([context.user.userId, context.centerId, context.roomId]);
  const state = { mutation: new CareMutation(), records: [{ id: draft.recordId }],
    goals: [{ id: 'test-goal' }], loaded: true, view: null };
  ui.states.set(ui.key, state);
  let form = null, displays = 0, events = 0;
  const notice = { textContent: '' };
  ui.dialog = { open: false,
    querySelector: selector => ['form', '[data-care-form="record"]'].includes(selector) ? form :
      selector === '[data-care-error]' ? notice : null,
    querySelectorAll: () => [], close() { this.open = false; }, replaceChildren() { form = null; } };
  ui.render = () => {};
  ui.display = () => {
    displays++;
    const inputs = Object.fromEntries(['date', 'title', 'goalId', 'performed', 'response', 'summary', 'nextPlan', 'privateNote']
      .map(name => [name, { value: state.view.values[name] ?? '', parentElement: null,
        dispatchEvent(event) { assert.equal(event.type, 'input'); events++; } }]));
    form = { elements: { namedItem: name => inputs[name] ?? null }, querySelectorAll: () => [] };
    notice.textContent = ''; ui.dialog.open = true;
  };
  const controller = new AbortController();
  let active = true;
  const operation = { signal: controller.signal, isCurrent: () => active };
  return { ui, state, operation, controller, errors, get context() { return context; },
    setContext(value) { context = value; }, deactivate() { active = false; },
    get displays() { return displays; }, get events() { return events; },
    input: name => form?.elements.namedItem(name), apply: () => ui.applyAiSummary(draft, preview, context, operation) };
}

test('reviewed AI summary applies only to an unchanged authorized form without saving', async () => {
  const original = saved(), calls = [];
  const f = fixture({ record: async (...args) => { calls.push(args); return original; },
    recordSave: () => assert.fail('AI application must never save') });
  assert.equal(await f.apply(), true);
  assert.equal(calls.length, 1);
  assert.equal(f.input('summary').value, draft.summary);
  assert.equal(f.state.view.values.summary, draft.summary);
  assert.equal(f.events, 1);
  assert.equal(f.state.view.values.privateNote, original.privateNote);
  assert.equal(f.state.view.values.nextPlan, original.nextPlan);
  assert.equal(original.summary, '기존 요약');
  assert.equal(f.state.mutation.operation, null);
});

test('existing unsaved forms and already cancelled operations never begin record reads', async () => {
  const f = fixture({ record: () => assert.fail('must not read') });
  const existing = { kind: 'record', values: { summary: '사용자 입력' } };
  f.state.view = existing;
  assert.equal(await f.apply(), false); assert.equal(f.state.view, existing);
  f.state.view = null; f.controller.abort();
  assert.equal(await f.apply(), false); assert.equal(f.displays, 0);
});

test('cancellation during a slow record read aborts transport and blocks a late form', async () => {
  const gate = deferred(); let signal;
  const f = fixture({ record: async (_center, _room, _id, value) => { signal = value; return gate.promise; } });
  const pending = f.apply();
  assert.equal(f.state.opening !== null, true);
  f.controller.abort(); assert.equal(signal.aborted, true);
  gate.resolve(saved());
  assert.equal(await pending, false);
  assert.equal(f.state.view, null); assert.equal(f.state.opening, null); assert.equal(f.displays, 0);
  assert.deepEqual(f.errors, []);
});

test('cancellation also reaches a delayed reference read after the record arrives', async () => {
  const gate = deferred(), entered = deferred(); let signal;
  const f = fixture({ record: async () => ({ ...saved(), referenceSources: [{ feedbackId: 'test-feedback', feedbackRevision: 1 }] }),
    feedback: async (_center, _room, _id, value) => { signal = value; entered.resolve(); return gate.promise; } });
  const pending = f.apply(); await entered.promise;
  f.controller.abort(); assert.equal(signal.aborted, true);
  gate.resolve({ feedback: { reaction: '합성 반응' } });
  assert.equal(await pending, false); assert.equal(f.displays, 0); assert.equal(f.state.opening, null);
});

test('inactive UI scope prevents a late form even when no transport abort arrives', async () => {
  const gate = deferred(), f = fixture({ record: async () => gate.promise });
  const pending = f.apply(); f.deactivate(); gate.resolve(saved());
  assert.equal(await pending, false); assert.equal(f.displays, 0); assert.equal(f.state.view, null);
});

test('workspace changes prevent a pending AI record read from opening another workspace', async () => {
  const gate = deferred(), f = fixture({ record: async () => gate.promise });
  const pending = f.apply(); f.setContext({ ...f.context, generation: 2 }); gate.resolve(saved());
  assert.equal(await pending, false); assert.equal(f.displays, 0); assert.equal(f.state.view, null);
});

function afterOpen(f, callback) {
  const open = f.ui.handleAction.bind(f.ui);
  f.ui.handleAction = async (...args) => { const view = await open(...args); callback(view); return view; };
}

test('cancellation between form creation and application closes only its unchanged form', async () => {
  const f = fixture(); afterOpen(f, () => f.controller.abort());
  assert.equal(await f.apply(), false);
  assert.equal(f.displays, 1); assert.equal(f.state.view, null); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.events, 0);
});

test('a replacement form for the same record belongs to the user and survives cancellation', async () => {
  const f = fixture(); let replacement;
  afterOpen(f, view => {
    replacement = { ...view, values: { ...view.values, summary: '다른 작성 작업' } };
    f.state.view = replacement; f.ui.display(); f.controller.abort();
  });
  assert.equal(await f.apply(), false);
  assert.equal(f.state.view, replacement); assert.equal(f.ui.dialog.open, true);
  assert.equal(f.input('summary').value, '다른 작성 작업'); assert.equal(f.events, 0);
});

for (const cancel of [true, false]) {
  test(`manual edits between opening and AI application are preserved (cancel=${cancel})`, async () => {
    const f = fixture();
    afterOpen(f, () => { f.input('summary').value = '사용자가 직접 고친 내용'; if (cancel) f.controller.abort(); });
    assert.equal(await f.apply(), false);
    assert.equal(f.input('summary').value, '사용자가 직접 고친 내용');
    assert.equal(f.state.view.values.summary, '사용자가 직접 고친 내용');
    assert.equal(f.ui.dialog.open, true); assert.equal(f.events, 0);
  });
}

for (const changed of [{ revision: 3 }, { performed: '나중에 변경된 활동' }]) {
  test(`latest record mismatch does not apply a stale AI summary: ${Object.keys(changed)[0]}`, async () => {
    const f = fixture({ record: async () => ({ ...saved(), ...changed }) });
    assert.equal(await f.apply(), false);
    assert.equal(f.state.view, null); assert.equal(f.ui.dialog.open, false); assert.equal(f.events, 0);
  });
}

for (const action of ['cancel', 'close']) {
  test(`AI ${action} propagates through apply callback to the delayed care read`, async () => {
    const gate = deferred(), entered = deferred(); let signal;
    const f = fixture({ record: async (_center, _room, _id, value) => { signal = value; entered.resolve(); return gate.promise; } });
    const ai = new AiAssistantUi({ api: {}, getContext: () => f.context,
      onApplySummary: (...args) => f.ui.applyAiSummary(...args) });
    ai.context = f.context;
    ai.scope = JSON.stringify([f.context.user.userId, f.context.centerId, f.context.roomId, f.context.role, f.context.generation]);
    ai.dialog = { open: true, close() { this.open = false; }, remove() {} };
    ai.render = () => {}; ai.preview = preview; ai.draft = draft;
    ai.client.preview = async () => preview;
    const pending = ai.apply(); await entered.promise;
    if (action === 'cancel') ai.operation.abort(); else ai.close(false);
    assert.equal(signal.aborted, true); gate.resolve(saved()); await pending;
    assert.equal(f.state.view, null); assert.equal(f.displays, 0);
    assert.equal(ai.busy, false); assert.equal(ai.operation, null);
    if (action === 'close') assert.equal(ai.dialog, null);
  });
}
