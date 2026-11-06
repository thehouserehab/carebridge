import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareUi, CareMutation, publicCarePreview } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

const recordId = 'synthetic-record';
const goal = () => ({ id: 'synthetic-goal', revision: 2, title: '가상 목표' });
const image = () => ({ id: '11111111-1111-4111-8111-111111111111', name: '<공개 사진>.png', type: 'image/png', size: 32, share: true });
const video = () => ({ id: '22222222-2222-4222-8222-222222222222', name: '<공개 영상>.mp4', type: 'video/mp4', size: 64, share: true });
const privateFile = () => ({ id: '33333333-3333-4333-8333-333333333333', name: 'PRIVATE-FILE.png', type: 'image/png', size: 32, share: false });
const preview = (extra = {}) => ({ recordId, recordRevision: 3, relationshipsVersion: 4,
  recipientIds: ['synthetic-guardian'], date: '2026-10-14', title: '<공개 제목>', summary: '<공개 요약>',
  activity: null, attachmentCount: 0, attachments: [], ...extra });
const record = (extra = {}) => ({ id: recordId, conversationId: 'synthetic-room', revision: 9,
  date: '2026-10-14', title: '서버의 최신 기록', goalId: goal().id, status: 'saved',
  performed: 'PRIVATE-LATEST-ACTIVITY', response: 'PRIVATE-LATEST-RESPONSE', nextPlan: 'PRIVATE-LATEST-PLAN',
  summary: '서버의 최신 요약', privateNote: 'PRIVATE-LATEST-NOTE', observation: null, assessments: [],
  activity: null, attachmentCount: 0, attachments: [], referenceSources: [], ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Real CareUi state, lifecycle, action, display and form methods. The minimal
// DOM only mounts markup and named controls; no browser, HTTP, media bytes or
// upload scanner is claimed by these controller regressions.
function fixture(options = {}) {
  const controller = new AbortController();
  let context = { user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
    centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1,
    signal: controller.signal, messages: [], profile: { childId: 'synthetic-child', name: '<가상 아동>',
      conversationId: 'synthetic-room', participants: [{ userId: 'synthetic-guardian', displayName: '<가상 보호자>' }] } };
  const calls = { record: [], preview: [], save: [], publish: [], open: [], errors: [], closed: 0 };
  const api = {
    record: async (...args) => { calls.record.push(args); return options.record ? options.record(...args) : record(); },
    recordPreview: async (...args) => { calls.preview.push(args); return options.preview ? options.preview(...args) : preview({ recordRevision: 9 }); },
    recordSave: async (...args) => { calls.save.push(args); assert.fail('Review navigation must never save.'); },
    recordPublish: async (...args) => { calls.publish.push(args); assert.fail('Review navigation must never publish.'); },
  };
  const ui = new CareUi({ api, getContext: () => context, deliveryEnabled: options.deliveryEnabled !== false, mediaApi: {},
    onError: (error) => calls.errors.push(error.code), onRecordViewClosed: () => { calls.closed++; },
    onOpenRecordAttachment: async (...args) => { calls.open.push(args); if (options.open) await options.open(...args); } });
  ui.key = JSON.stringify([context.user.userId, context.centerId, context.roomId]);
  const state = { mutation: new CareMutation(() => 'synthetic-review-command'), loaded: true, loading: false,
    records: [{ id: recordId, revision: 9, title: '서버 목록의 최신 기록', status: 'saved' }], goals: [goal()], appointments: [],
    view: { kind: 'publish', preview: options.initialPreview ?? preview(), values: { confirmed: true } }, sharePreparation: null };
  ui.states.set(ui.key, state);
  const notice = { textContent: '' };
  let html = '', form = null;
  const mount = () => {
    const elements = Object.entries(state.view?.values ?? {}).filter(([, value]) => value == null || typeof value !== 'object')
      .map(([name, value]) => ({ name, type: name === 'confirmed' ? 'checkbox' : 'text', value: String(value ?? ''), checked: value === true }));
    if (state.view?.kind === 'publish' && !elements.some((item) => item.name === 'confirmed'))
      elements.push({ name: 'confirmed', type: 'checkbox', value: 'on', checked: false });
    const rows = [];
    if (state.view?.kind === 'record') {
      for (const [prefix, keys] of [['observation', ['status', 'task', 'assistance', 'amount', 'repetitions', 'duration', 'context']],
        ['activity', ['title', 'instruction', 'frequency', 'caution']]]) {
        for (const key of keys) elements.push({ name: prefix + key[0].toUpperCase() + key.slice(1), type: 'text',
          value: String(state.view.values[prefix]?.[key] ?? '') });
      }
      for (const [index, assessment] of (state.view.values.assessments ?? []).entries()) {
        const inputs = ['tool', 'item', 'value', 'unit', 'context'].map(key => ({
          name: `assessment-${index}-${key}`, type: 'text', value: String(assessment[key] ?? ''), dataset: { assessmentField: key } }));
        elements.push(...inputs);
        rows.push({ querySelector: selector => inputs.find(input => selector === `[data-assessment-field="${input.dataset.assessmentField}"]`) ?? null });
      }
    }
    elements.namedItem = (name) => elements.find((item) => item.name === name) ?? null;
    form = { elements, reportValidity: () => true, querySelector: () => null,
      querySelectorAll: selector => selector === '[data-assessment-row]' ? rows : [] };
  };
  ui.dialog = { open: true, get innerHTML() { return html; }, set innerHTML(value) { html = value; mount(); },
    querySelector: (selector) => selector === 'form' ? form : selector === '[data-care-error]' ? notice : null,
    querySelectorAll: () => form?.elements ?? [], showModal() { this.open = true; }, close() { this.open = false; },
    replaceChildren() { html = ''; form = null; }, remove() { this.open = false; html = ''; form = null; } };
  mount(); ui.ensureDialog = () => {}; ui.lockForm = () => {};
  return { ui, state, calls, controller, notice, get html() { return html; }, get form() { return form; },
    get context() { return context; }, setContext(next) { context = next; },
    setRole(role) { context = { ...context, user: { ...context.user, centers: [{ id: context.centerId, role }] } }; } };
}
function noWrites(f) { assert.equal(f.calls.save.length, 0); assert.equal(f.calls.publish.length, 0); }

test('editing a checked share preview discards confirmation and reads the latest authorized record without writing', async () => {
  const f = fixture();
  f.state.sharePreparation = { operation: 'obsolete-preparation' };
  await f.ui.editPreviewRecord();
  assert.deepEqual(f.calls.record, [[f.context.centerId, f.context.roomId, recordId, f.context.signal]]);
  assert.equal(f.state.view.kind, 'record'); assert.equal(f.state.view.recordId, recordId);
  assert.equal(f.state.view.expectedRevision, 9); assert.equal(f.state.view.values.summary, '서버의 최신 요약');
  assert.equal(f.state.view.values.privateNote, 'PRIVATE-LATEST-NOTE');
  assert(!Object.hasOwn(f.state.view.values, 'confirmed')); assert.equal(f.state.sharePreparation, null);
  assert.match(f.html, /PRIVATE-LATEST-ACTIVITY/); assert(!f.html.includes('name="confirmed"'));
  assert.equal(f.calls.preview.length, 0); assert(f.calls.closed > 0); noWrites(f);
});

test('closing preview then opening the same record returns to editing instead of restoring the checked preview', async () => {
  const f = fixture(); f.ui.close(); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.state.view.kind, 'publish');
  await f.ui.handleAction('edit-record', recordId);
  assert.equal(f.calls.record.length, 1); assert.equal(f.calls.preview.length, 0);
  assert.equal(f.state.view.kind, 'record'); assert.equal(f.ui.dialog.open, true); noWrites(f);
});

test('a new preview after returning to edit requires a fresh unchecked confirmation', async () => {
  const f = fixture(); await f.ui.editPreviewRecord();
  assert.equal(f.ui.discard(), true); await f.ui.handleAction('preview-record', recordId);
  assert.equal(f.calls.preview.length, 1); assert.equal(f.state.view.preview.recordRevision, 9);
  assert.deepEqual(f.state.view.values, {});
  assert.match(f.html, /name="confirmed" required/); assert(!/name="confirmed"[^>]*checked/.test(f.html)); noWrites(f);
});

test('duplicate return-to-edit clicks while the authorized read is pending make only one GET', async () => {
  const detail = deferred(), f = fixture({ record: () => detail.promise });
  const pending = f.ui.editPreviewRecord();
  assert.equal(f.state.view, null); assert(f.state.opening); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.html, ''); await f.ui.editPreviewRecord(); await f.ui.handleAction('edit-record', recordId);
  assert.equal(f.calls.record.length, 1); noWrites(f);
  detail.resolve(record()); await pending;
  assert.equal(f.state.opening, null); assert.equal(f.state.view.kind, 'record');
});

test('a late return-to-edit read cannot reopen after suspend, scope changes or an aborted lifetime', async () => {
  for (const transition of ['suspend', 'room', 'account', 'generation', 'abort']) {
    const detail = deferred(), f = fixture({ record: () => detail.promise });
    const pending = f.ui.editPreviewRecord();
    if (transition === 'suspend') f.ui.suspend();
    else if (transition === 'abort') f.controller.abort();
    else f.setContext({ ...f.context,
      ...(transition === 'room' ? { roomId: 'other-synthetic-room' } : {}),
      ...(transition === 'account' ? { user: { ...f.context.user, userId: 'other-synthetic-user' } } : {}),
      ...(transition === 'generation' ? { generation: 2 } : {}) });
    detail.resolve(record()); await pending;
    assert.equal(f.state.view, null, transition); assert.equal(f.ui.dialog?.open, false, transition);
    assert.equal(f.html, '', transition); assert.equal(f.calls.record.length, 1); noWrites(f);
  }
});

test('permission denial during return-to-edit clears the abandoned preview and all private UI state', async () => {
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND']) {
    const f = fixture({ record: async () => { throw new LocalApiError(code, code === 'AUTH_REQUIRED' ? 401 : 403); } });
    await f.ui.editPreviewRecord();
    assert.deepEqual(f.calls.errors, [code]); assert.equal(f.ui.states.size, 0); assert.equal(f.ui.key, null);
    assert.equal(f.html, ''); assert.equal(f.state.view, null); noWrites(f);
  }
});

test('an unavailable edit read does not reuse a public preview as a clinical record or leak an error message', async () => {
  const f = fixture({ record: async () => { throw new Error('PRIVATE-RAW-SERVER-DETAIL'); } });
  await f.ui.editPreviewRecord();
  assert.equal(f.state.view, null); assert.equal(f.state.opening, null); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.html, ''); assert(!f.notice.textContent.includes('PRIVATE-RAW')); noWrites(f);
});

test('return-to-edit is blocked outside an idle current therapist share preview', async () => {
  for (const boundary of ['guardian', 'operator', 'disconnected', 'aborted', 'opening', 'operation', 'record', 'no-view']) {
    const f = fixture();
    if (['guardian', 'operator'].includes(boundary)) f.setRole(boundary);
    else if (boundary === 'disconnected') f.setContext({ ...f.context, connected: false });
    else if (boundary === 'aborted') f.controller.abort();
    else if (boundary === 'opening') f.state.opening = {};
    else if (boundary === 'operation') f.state.mutation.begin('publish', recordId, { expectedRevision: 3 });
    else if (boundary === 'record') f.state.view = { kind: 'record', values: {} };
    else f.state.view = null;
    const before = f.state.view, operation = f.state.mutation.operation;
    await f.ui.editPreviewRecord();
    assert.equal(f.calls.record.length, 0, boundary); assert.equal(f.state.view, before, boundary);
    assert.equal(f.state.mutation.operation, operation, boundary); noWrites(f);
  }
});

test('a share attachment opens only its exact selected public ID and preview revision, not the newer record head', async () => {
  const f = fixture({ initialPreview: preview({ attachments: [image(), video(), privateFile()], attachmentCount: 3 }) });
  for (const id of [privateFile().id, 'missing-synthetic-file']) await f.ui.openRecordAttachment(id);
  assert.equal(f.calls.open.length, 0);
  await f.ui.openRecordAttachment(image().id); await f.ui.openRecordAttachment(video().id);
  assert.deepEqual(f.calls.open, [[recordId, 3, image().id], [recordId, 3, video().id]]);
  assert.equal(f.state.view.values.confirmed, true); assert.equal(f.calls.record.length, 0); noWrites(f);
});

test('only the boolean share true makes an attachment eligible for preview inspection', async () => {
  for (const share of [false, undefined, null, 1, 'true']) {
    const f = fixture({ initialPreview: preview({ attachments: [{ ...image(), share }], attachmentCount: 1 }) });
    await f.ui.openRecordAttachment(image().id); assert.equal(f.calls.open.length, 0, String(share)); noWrites(f);
  }
});

test('existing saved-record private attachment inspection remains pinned to its record revision', async () => {
  const f = fixture(); f.state.view = { kind: 'record', recordId, expectedRevision: 5,
    values: { attachments: [privateFile()] }, references: [] };
  await f.ui.openRecordAttachment(privateFile().id);
  assert.deepEqual(f.calls.open, [[recordId, 5, privateFile().id]]); noWrites(f);
});

test('share attachment inspection remains disabled at role, connection, operation, delivery and revision boundaries', async () => {
  for (const boundary of ['guardian', 'operator', 'disconnected', 'aborted', 'operation', 'delivery-off', 'zero', 'string', 'unknown-view']) {
    const f = fixture({ deliveryEnabled: boundary !== 'delivery-off', initialPreview: preview({ attachments: [image()], attachmentCount: 1 }) });
    if (['guardian', 'operator'].includes(boundary)) f.setRole(boundary);
    else if (boundary === 'disconnected') f.setContext({ ...f.context, connected: false });
    else if (boundary === 'aborted') f.controller.abort();
    else if (boundary === 'operation') f.state.mutation.begin('publish', recordId, { expectedRevision: 3 });
    else if (boundary === 'zero') f.state.view.preview.recordRevision = 0;
    else if (boundary === 'string') f.state.view.preview.recordRevision = '3';
    else if (boundary === 'unknown-view') f.state.view = { kind: 'receipt', values: {} };
    await f.ui.openRecordAttachment(image().id); assert.equal(f.calls.open.length, 0, boundary); noWrites(f);
  }
});

test('late attachment errors do not clear a replacement view or a new account/room', async () => {
  for (const transition of ['view', 'suspend', 'room', 'account']) {
    const opened = deferred(), f = fixture({ open: () => opened.promise,
      initialPreview: preview({ attachments: [image()], attachmentCount: 1 }) });
    const pending = f.ui.openRecordAttachment(image().id); assert.equal(f.calls.open.length, 1);
    if (transition === 'view') f.state.view = { kind: 'record', recordId: 'other-synthetic-record', values: {} };
    else if (transition === 'suspend') f.ui.suspend();
    else f.setContext({ ...f.context, ...(transition === 'room' ? { roomId: 'other-synthetic-room' }
      : { user: { ...f.context.user, userId: 'other-synthetic-user' } }) });
    const view = f.state.view;
    opened.reject(new LocalApiError('FORBIDDEN', 403)); await pending;
    assert.deepEqual(f.calls.errors, [], transition); assert.equal(f.state.view, view, transition);
    assert.equal(f.ui.states.size, 1, transition); noWrites(f);
  }
});

test('a current attachment authorization failure clears the review instead of retaining its clinical projection', async () => {
  const f = fixture({ open: async () => { throw new LocalApiError('FORBIDDEN', 403); },
    initialPreview: preview({ attachments: [image()], attachmentCount: 1 }) });
  await f.ui.openRecordAttachment(image().id);
  assert.deepEqual(f.calls.errors, ['FORBIDDEN']); assert.equal(f.ui.states.size, 0); assert.equal(f.html, ''); noWrites(f);
});

test('share review renders an explicit edit action and escaped buttons for the public attachment allowlist only', () => {
  const raw = preview({ attachments: [image(), video(), privateFile()], attachmentCount: 2,
    privateNote: 'PRIVATE-NOTE', referenceSources: [{ body: 'PRIVATE-REFERENCE' }], assessments: [{ item: 'PRIVATE-MEASUREMENT' }] });
  const f = fixture({ initialPreview: publicCarePreview(raw) }); f.ui.display();
  assert.match(f.html, /data-care-action="edit-preview-record"[^>]*>기록 수정/);
  for (const file of [image(), video()]) {
    const button = [...f.html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0]).find((html) => html.includes(`data-open-record-attachment="${file.id}"`));
    assert(button, file.id); assert.match(button, /type="button"/);
    assert.match(button, /data-record-id="synthetic-record"/); assert.match(button, /data-record-revision="3"/);
  }
  assert.match(f.html, /&lt;공개 사진&gt;\.png/); assert.match(f.html, /&lt;공개 영상&gt;\.mp4/);
  assert(!f.html.includes('PRIVATE-')); assert(!f.html.includes(privateFile().id));
  assert.match(f.html, /name="confirmed" required/); noWrites(f);
});

test('delivery-disabled review has no attachment inspection controls while retaining the explicit edit action', () => {
  const f = fixture({ deliveryEnabled: false }); f.ui.display();
  assert.match(f.html, /data-care-action="edit-preview-record"/);
  assert(!f.html.includes('data-open-record-attachment')); noWrites(f);
});

test('the real modal click delegation reaches review editing and exact attachment inspection without trusting DOM revision data', async () => {
  const f = fixture({ initialPreview: preview({ attachments: [image()], attachmentCount: 1 }) });
  const dialog = f.ui.dialog, handlers = new Map();
  dialog.dataset = {}; dialog.setAttribute = () => {};
  dialog.addEventListener = (name, callback) => handlers.set(name, callback);
  const document = { createElement: (tag) => { assert.equal(tag, 'dialog'); return dialog; },
    body: { append: (node) => { assert.equal(node, dialog); node.isConnected = true; } } };
  f.ui.host = { ownerDocument: document }; f.ui.dialog = null;
  delete f.ui.ensureDialog; f.ui.ensureDialog(); f.ui.host = null;
  const click = (dataset) => {
    const target = { dataset, closest: (selector) =>
      selector === '[data-open-record-attachment]' && dataset.openRecordAttachment ? target :
        selector === '[data-care-action]' && dataset.careAction ? target : null };
    handlers.get('click')({ target });
  };
  click({ openRecordAttachment: image().id, recordId: 'forged-record', recordRevision: '999' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.open, [[recordId, 3, image().id]]);
  click({ careAction: 'edit-preview-record' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.record.length, 1); assert.equal(f.state.view.kind, 'record'); noWrites(f);
});

test('the real form lock disables editing, attachment opening and confirmation throughout an unresolved publish', () => {
  const f = fixture();
  const control = (type, dataset = {}) => ({ type, dataset, disabled: false, checked: true, closest: () => null });
  const controls = [control('button', { careAction: 'edit-preview-record' }),
    control('button', { openRecordAttachment: image().id }), control('checkbox'), control('submit'), control('button', { careAction: 'discard' })];
  const retries = [], form = f.form;
  form.querySelectorAll = (selector) => selector === 'input,textarea,select,button' ? [...controls, ...retries] : [];
  form.querySelector = (selector) => selector === '[data-care-action="retry"]' ? retries[0] ?? null
    : selector === '.care-submit' ? { append: (button) => retries.push(button) } : null;
  f.ui.host = { ownerDocument: { createElement: (tag) => {
    assert.equal(tag, 'button');
    const button = control('button'); button.remove = () => retries.splice(retries.indexOf(button), 1); return button;
  } } };
  delete f.ui.lockForm;
  const operation = f.state.mutation.begin('publish', recordId, { expectedRevision: 3 });
  f.ui.lockForm(); assert(controls.every((item) => item.disabled));
  assert.equal(retries.length, 1); assert.equal(retries[0].disabled, true);
  f.state.mutation.failed(operation); f.ui.lockForm();
  assert(controls.every((item) => item.disabled)); assert.equal(retries.length, 1); assert.equal(retries[0].disabled, false);
  assert.equal(f.state.mutation.operation, operation); assert.equal(controls[2].checked, true);
  f.state.mutation.accepted(operation); f.ui.lockForm();
  assert(controls.every((item) => !item.disabled)); assert.equal(retries.length, 0); noWrites(f);
});

const observedRecord = () => record({
  observation: { status: 'observed', task: '가상 놀이', assistance: '', amount: '', repetitions: '', duration: '', context: '' },
  activity: { title: '가상 활동', instruction: '가상 안내', frequency: '한 번', caution: '' },
  assessments: [{ tool: '직접 관찰', item: '참여 시간', value: 3, unit: '분', context: '가상 조건' },
    { tool: '직접 관찰', item: '도움 횟수', value: 0, unit: '회', context: '가상 조건' }],
});
async function openedRecord(options = {}) {
  const f = fixture({ record: async () => observedRecord(), ...options });
  f.state.view = null; f.ui.wipeDialog();
  await f.ui.handleAction('edit-record', recordId);
  assert.equal(f.state.view?.kind, 'record'); assert.equal(f.ui.dialog.open, true);
  return f;
}

test('viewing a saved record and closing discards only the unchanged editor, then opens the requested preview without saving', async () => {
  for (const requested of [recordId, 'other-synthetic-record']) {
    const f = await openedRecord({ preview: async () => preview({ recordId: requested, recordRevision: 9 }) });
    assert.equal(f.state.view.values.assessments[1].value, 0);
    assert.equal(f.form.elements.namedItem('assessment-1-value').value, '0');
    assert.match(f.html, /id="care-dialog-title">기록 수정<\/h2>/);
    f.ui.close();
    assert.equal(f.state.view, null); assert.equal(f.ui.dialog.open, false);
    assert.equal(f.html, ''); assert.equal(f.calls.record.length, 1);
    await f.ui.handleAction('preview-record', requested);
    assert.equal(f.state.view.kind, 'publish'); assert.equal(f.state.view.preview.recordId, requested);
    assert.deepEqual(f.calls.preview, [[f.context.centerId, f.context.roomId, requested, f.context.signal]]);
    assert.deepEqual(f.state.view.values, {}); noWrites(f);
  }
});

test('the native dialog cancel handler uses the same unchanged-record close path', async () => {
  const f = await openedRecord(), dialog = f.ui.dialog, handlers = new Map();
  dialog.dataset = {}; dialog.setAttribute = () => {};
  dialog.addEventListener = (name, callback) => handlers.set(name, callback);
  f.ui.host = { ownerDocument: { createElement: () => dialog, body: { append() {} } } };
  f.ui.dialog = null; delete f.ui.ensureDialog; f.ui.ensureDialog(); f.ui.host = null;
  let prevented = false;
  handlers.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.state.view, null); assert.equal(dialog.open, false); noWrites(f);
});

test('changed record fields and a blank measurement retain the same input through close, authority checks and redisplay', async () => {
  for (const [name, value] of [['summary', '수정한 가상 요약'], ['privateNote', '수정한 가상 메모'],
    ['observationAssistance', '가상 도움'], ['activityCaution', '가상 주의'], ['assessment-1-value', '']]) {
    const f = await openedRecord(), original = f.state.view;
    f.form.elements.namedItem(name).value = value;
    f.ui.close(); assert.equal(f.state.view, original, name);
    await f.ui.handleAction('preview-record', 'other-synthetic-record');
    assert.equal(f.state.view, original, name); assert.equal(f.calls.preview.length, 0);
    assert.equal(f.form.elements.namedItem(name).value, value, name);
    f.ui.close(); assert.equal(f.state.view, original, name); noWrites(f);
  }
});

test('returning every field to its original value clears the editor without rebasing on earlier redisplay', async () => {
  const f = await openedRecord(), original = f.state.view;
  f.form.elements.namedItem('summary').value = '임시 가상 변경';
  f.form.elements.namedItem('assessment-1-value').value = '';
  f.ui.close(); await f.ui.handleAction('resume');
  assert.equal(f.state.view, original); assert.equal(f.form.elements.namedItem('assessment-1-value').value, '');
  f.form.elements.namedItem('summary').value = observedRecord().summary;
  f.form.elements.namedItem('assessment-1-value').value = '0';
  f.ui.close(); assert.equal(f.state.view, null); noWrites(f);
});

test('changing assessment row membership remains an unsaved edit', async () => {
  const f = await openedRecord(), original = f.state.view;
  f.form.querySelectorAll('[data-assessment-row]').pop();
  f.ui.close(); assert.equal(f.state.view, original); assert.equal(original.values.assessments.length, 1); noWrites(f);
});

test('new, template and unproven editor states are never discarded merely because their form is untouched', async () => {
  for (const kind of ['new', 'template', 'no-baseline']) {
    const f = await openedRecord();
    f.state.view = kind === 'no-baseline' ? structuredClone(f.state.view) : f.ui.newRecord(f.state);
    if (kind === 'template') f.state.view.templateSource = { recordId, revision: 9 };
    const view = f.state.view; f.ui.display(); f.ui.close();
    assert.equal(f.state.view, view, kind); noWrites(f);
  }
});

test('persisted draft records including empty drafts retain their editor despite a positive revision', async () => {
  for (const savedDraft of [record({ status: 'draft' }), record({ status: 'draft', title: '', performed: '', response: '',
    nextPlan: '', summary: '', privateNote: '', assessments: [] })]) {
    const f = await openedRecord({ record: async () => savedDraft }), view = f.state.view;
    f.ui.close(); assert.equal(f.state.view, view); assert.equal(view.expectedRevision, 9);
    await f.ui.handleAction('resume'); f.ui.close(); assert.equal(f.state.view, view); noWrites(f);
  }
  const f = await openedRecord(), view = f.state.view;
  view.values.status = 'draft'; f.ui.close(); assert.equal(f.state.view, view); noWrites(f);
});

test('pending, ambiguous, rejected and context-check states preserve unchanged saved-record inputs', async () => {
  for (const boundary of ['operation', 'uncertain', 'sending', 'ever-uncertain', 'error', 'stale', 'context-stale',
    'context-refresh', 'context-refreshed', 'profile-check', 'opening', 'read-check', 'read-notice', 'local-notice', 'share-preparation']) {
    const f = await openedRecord(), view = f.state.view;
    if (boundary === 'operation' || boundary === 'uncertain') {
      const operation = f.state.mutation.begin('record', recordId, { expectedRevision: 9 });
      if (boundary === 'uncertain') f.state.mutation.failed(operation);
    } else if (boundary === 'sending') f.state.mutation.sending = true;
    else if (boundary === 'ever-uncertain') f.state.mutation.everUncertain = true;
    else if (boundary === 'error') view.error = '보존해야 하는 합성 오류';
    else if (boundary === 'stale') view.stale = true;
    else if (boundary === 'context-stale') view.contextStale = true;
    else if (boundary === 'context-refresh') view.contextRefresh = {};
    else if (boundary === 'context-refreshed') view.contextRefreshed = true;
    else if (boundary === 'profile-check') view.requiresProfileCheck = true;
    else if (boundary === 'opening') f.state.opening = {};
    else if (boundary === 'read-check') f.state.readCheck = {};
    else if (boundary === 'read-notice') f.state.readNotice = '합성 조회 오류';
    else if (boundary === 'local-notice') f.ui.notice('요약을 입력해 주세요. 저장하지 않았습니다.');
    else f.state.sharePreparation = {};
    const operation = f.state.mutation.operation;
    f.ui.close(); assert.equal(f.state.view, view, boundary);
    assert.equal(f.state.mutation.operation, operation, boundary); noWrites(f);
  }
});

test('stored attachment choices and pending uploads are retained while inspection alone is not an edit', async () => {
  for (const change of ['inspect', 'share', 'remove', 'selection', 'busy', 'unknown-selection', 'selection-error']) {
    const f = await openedRecord({ record: async () => observedRecordWithFile() }), view = f.state.view;
    if (change === 'inspect') await f.ui.openRecordAttachment(privateFile().id);
    else if (change === 'share') assert.equal(f.ui.setRecordShare(privateFile().id, true), true);
    else if (change === 'remove') f.ui.removeRecordAttachment(privateFile().id);
    else if (change === 'busy') f.ui.recordMedia.busy = { controller: new AbortController() };
    else f.ui.recordMedia.hasRecordSelections = () => {
      if (change === 'selection-error') throw Error('Unconfirmed synthetic upload state');
      return change === 'selection' ? true : undefined;
    };
    f.ui.close();
    assert.equal(f.state.view, change === 'inspect' ? null : view, change); noWrites(f);
  }
  function observedRecordWithFile() {
    return { ...observedRecord(), attachmentCount: 1, attachments: [privateFile()] };
  }
});

test('suspend and a different room preserve the draft and cannot establish a new clean baseline', async () => {
  const f = await openedRecord(), view = f.state.view, context = f.context;
  f.form.elements.namedItem('summary').value = '아이별 미저장 가상 입력';
  f.ui.suspend(); assert.equal(f.state.view, view); assert.equal(view.values.summary, '아이별 미저장 가상 입력');
  f.setContext({ ...context, roomId: 'other-synthetic-room' });
  f.ui.close(); assert.equal(f.state.view, view);
  f.setContext(context); await f.ui.handleAction('resume');
  assert.equal(f.form.elements.namedItem('summary').value, '아이별 미저장 가상 입력');
  f.ui.close(); assert.equal(f.state.view, view); noWrites(f);
});
