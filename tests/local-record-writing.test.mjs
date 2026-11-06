// Controller/DOM doubles: not browser, persistence or physical IME evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CareUi, CareMutation } from '../local-api/care-ui.js';

function fixture() {
  const context = { user: { userId: 'synthetic-writer', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
    centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1,
    signal: new AbortController().signal };
  const ui = new CareUi({ api: new Proxy({}, { get: () => assert.fail('Title suggestions must not access an API.') }),
    getContext: () => context });
  ui.key = JSON.stringify([context.user.userId, context.centerId, context.roomId]);
  const state = { mutation: new CareMutation(), view: { kind: 'record', expectedRevision: 3,
    values: { date: '2026-10-13', performed: '가상 활동', title: '직접 정한 제목', privateNote: 'PRIVATE-NOTE' } } };
  ui.states.set(ui.key, state);
  const fields = new Map(Object.entries(state.view.values).map(([name, value]) => [name,
    { name, value, focused: false, focus() { this.focused = true; } }]));
  const reads = [], writes = []; let text = '';
  const output = { get textContent() { return text; }, set textContent(value) { text = value; writes.push(value); } };
  const form = { elements: { namedItem(name) { reads.push(name); return fields.get(name); } },
    querySelector: selector => selector === '[data-record-title-suggestion]' ? output : null };
  ui.dialog = { querySelector: selector => selector === 'form' ? form : null };
  return { ui, state, context, fields, reads, writes, output, form };
}

test('date/activity changes update only plain-text suggestion, not authored fields, saved values or API', () => {
  const f = fixture(), original = structuredClone(f.state.view);
  f.fields.get('performed').value = '  합성 <활동>\n 두 번째 줄 ';
  f.ui.updateRecordTitleSuggestion({ target: f.fields.get('performed') });
  assert.equal(f.output.textContent, '2026-10-13 합성 <활동> 두 번째 줄');
  assert.equal(f.fields.get('performed').value, '  합성 <활동>\n 두 번째 줄 ');
  assert.equal(f.fields.get('title').value, '직접 정한 제목');
  assert.deepEqual(f.state.view, original);
  assert.deepEqual(f.reads, ['date', 'performed']);
  f.ui.updateRecordTitleSuggestion(); assert.equal(f.writes.length, 1);
});

test('manual titles and intentionally blank titles are never overwritten by live suggestions', () => {
  for (const title of ['기존 일정 제목', '직접 수정한 제목', '']) {
    const f = fixture(); f.fields.get('title').value = title;
    f.fields.get('date').value = '2026-11-02';
    f.ui.updateRecordTitleSuggestion({ target: f.fields.get('date') });
    assert.equal(f.fields.get('title').value, title);
    assert.equal(f.state.view.values.title, '직접 정한 제목');
  }
});

test('explicit apply reads current date/activity once and changes only the editable title', () => {
  const f = fixture(); f.fields.get('date').value = '2026-11-02'; f.fields.get('performed').value = '새 합성 활동';
  f.ui.useRecordTitleSuggestion();
  assert.equal(f.fields.get('title').value, '2026-11-02 새 합성 활동');
  assert.equal(f.state.view.values.title, '2026-11-02 새 합성 활동');
  assert.equal(f.fields.get('title').focused, true);
  assert.deepEqual(f.reads, ['title', 'date', 'performed']);
  assert.equal(f.state.view.values.privateNote, 'PRIVATE-NOTE');
  f.fields.get('title').value = '적용 후 직접 수정'; f.fields.get('performed').value = '다시 바꾼 활동';
  f.ui.updateRecordTitleSuggestion({ target: f.fields.get('performed') });
  assert.equal(f.fields.get('title').value, '적용 후 직접 수정');
});

test('composition input does not update suggestion until compositionend and unrelated fields are not read', () => {
  const f = fixture(); f.ui.updateRecordTitleSuggestion(); const before = f.output.textContent;
  f.fields.get('performed').value = '가상 한글 조합 완료';
  f.ui.updateRecordTitleSuggestion({ isComposing: true, target: f.fields.get('performed') });
  assert.equal(f.output.textContent, before);
  f.ui.updateRecordTitleSuggestion({ type: 'compositionend', target: f.fields.get('performed') });
  assert.equal(f.output.textContent, '2026-10-13 가상 한글 조합 완료');
  f.reads.length = 0;
  for (const name of ['title', 'response', 'nextPlan', 'privateNote', 'summary', 'observationTask', 'assessment-0-value'])
    f.ui.updateRecordTitleSuggestion({ target: { name } });
  assert.deepEqual(f.reads, []);
});

test('pending immutable operations and non-record views cannot modify or read title inputs', () => {
  for (const kind of ['publish', 'receipt', 'record-cleanup', 'feedback', 'reply']) {
    const f = fixture(); f.state.view.kind = kind;
    f.ui.updateRecordTitleSuggestion(); f.ui.useRecordTitleSuggestion(); assert.deepEqual(f.reads, []);
  }
  const f = fixture(); f.state.mutation.begin('record', 'synthetic-record', { expectedRevision: 3, content: { title: '고정 제목' } });
  const operation = f.state.mutation.operation;
  f.ui.updateRecordTitleSuggestion(); f.ui.useRecordTitleSuggestion();
  assert.deepEqual(f.reads, []); assert.equal(f.state.mutation.operation, operation);
  assert.equal(operation.body.content.title, '고정 제목');
});

test('applying requires the same connected therapist scope and no pending context refresh', () => {
  for (const alter of [f => { f.context.connected = false; }, f => { f.context.roomId = 'other-room'; },
    f => { f.context.user.centers[0].role = 'guardian'; }, f => { f.state.view.contextRefresh = {}; }]) {
    const f = fixture(); alter(f); f.ui.useRecordTitleSuggestion(); assert.deepEqual(f.reads, []);
  }
});
