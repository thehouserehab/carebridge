import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareUi, CareMutation } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

const recordId = 'synthetic-record';
const goal = () => ({ id: 'synthetic-goal', revision: 4, title: '가상 목표' });
const values = () => ({ date: '2026-10-13', title: '합성 기록', goalId: goal().id,
  performed: 'PRIVATE-PERFORMED', response: 'PRIVATE-RESPONSE', nextPlan: 'PRIVATE-NEXT-PLAN',
  summary: '합성 공개 요약', privateNote: 'PRIVATE-CLINICAL', assessments: [], observation: null, activity: null });
const receipt = (extra = {}) => ({ operation: 'save', recordId, revision: 3, replayed: false, ...extra });
const preview = (extra = {}) => ({ recordId, recordRevision: 3, relationshipsVersion: 7,
  recipientIds: ['synthetic-guardian'], date: '2026-10-13', title: '<합성 공개 제목>', summary: '<합성 공개 요약>',
  activity: null, attachmentCount: 0, attachments: [], ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Controller/DOM doubles, not HTTP, upload-scanner or browser evidence. The
// actual submit/snapshot/mutate/handleAction/display/lifecycle methods run.
// Only modal mounting and disabled-button painting are substituted.
function fixture(options = {}) {
  let current = { user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
    centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1,
    signal: new AbortController().signal, messages: [], profile: { childId: 'synthetic-child',
      conversationId: 'synthetic-room', name: '가상 아동', participants: [
        { userId: 'synthetic-guardian', role: 'guardian', displayName: '<합성 보호자>' },
      ] } };
  const calls = { save: [], preview: [], publish: [], changed: 0, errors: [], order: [] };
  let f;
  const api = {
    recordSave: async (...args) => {
      calls.save.push(args); calls.order.push('save');
      return options.recordSave ? options.recordSave(...args) : receipt();
    },
    recordPreview: async (...args) => {
      calls.preview.push(args); calls.order.push('preview');
      return options.recordPreview ? options.recordPreview(...args) : preview();
    },
    recordPublish: async (...args) => {
      calls.publish.push(args); calls.order.push('publish');
      return options.recordPublish ? options.recordPublish(...args) : receipt({ operation: 'publish' });
    },
  };
  const ui = new CareUi({ api, getContext: () => current, deliveryEnabled: options.deliveryEnabled === true,
    mediaApi: {}, onError: (error) => calls.errors.push(error.code), onChanged: async () => {
      calls.changed++; calls.order.push('changed');
      if (options.onChanged) await options.onChanged(f); else f.refresh();
    } });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  let ids = 0;
  const state = { mutation: new CareMutation(() => `synthetic-command-${++ids}`),
    goals: [goal()], records: [{ id: recordId, revision: 2, status: 'saved', title: '합성 이전 기록' }],
    appointments: [], loaded: true, loading: false,
    view: { kind: 'record', recordId, expectedRevision: 2, goals: [goal()], references: [],
      values: { ...values(), ...options.values } } };
  ui.states.set(ui.key, state);
  const display = { forms: [], body: '', kind: 'record', focus: null, validityChecks: 0 };
  const notice = { textContent: '' };
  let form;
  const buildForm = (view) => {
    const elements = Object.entries(view.values ?? {}).filter(([, value]) => value == null || typeof value !== 'object')
      .map(([name, value]) => ({ name, type: name === 'confirmed' ? 'checkbox' : 'text', value: value ?? '',
        checked: value === true, focus() { display.focus = name; } }));
    if (view.kind === 'publish' && !elements.some((item) => item.name === 'confirmed'))
      elements.push({ name: 'confirmed', type: 'checkbox', checked: false, value: 'on' });
    elements.namedItem = (name) => elements.find((item) => item.name === name) ?? null;
    const sharing = { open: false };
    return { elements, sharing, reportValidity() { display.validityChecks++; return options.valid !== false; },
      querySelector: (selector) => selector === '.care-sharing-fields' ? sharing : null,
      querySelectorAll: () => [] };
  };
  form = buildForm(state.view);
  ui.dialog = { open: true, querySelector: (selector) => selector === 'form' ? form : selector === '[data-care-error]' ? notice : null,
    querySelectorAll: () => form?.elements ?? [], close() { this.open = false; },
    replaceChildren() { form = null; display.body = ''; }, remove() { this.open = false; form = null; display.body = ''; } };
  ui.form = (title, kind, body, buttons) => {
    ui.wipeDialog(); form = buildForm(state.view); ui.dialog.open = true;
    Object.assign(display, { body, kind }); display.forms.push({ title, kind, body, buttons });
  };
  ui.lockForm = () => {};
  f = { ui, state, calls, display, notice, get form() { return form; }, get current() { return current; },
    setContext(value) { current = value; },
    field(name, value) { const input = form.elements.namedItem(name); assert(input, `Fixture field ${name}`); input.value = value; },
    refresh() {
      current = { ...current, careData: { goals: [goal()], appointments: [],
        records: [{ id: recordId, revision: 3, status: 'saved', title: '합성 저장 기록' }] } };
      ui.update(current);
    } };
  return f;
}

test('preparation waits for the exact save acknowledgement and fresh authorized workspace before preview; never auto-publishes', async () => {
  const saved = deferred(), changed = deferred();
  const f = fixture({ recordSave: () => saved.promise, onChanged: async (f) => { await changed.promise; f.refresh(); } });
  const pending = f.ui.submit({ value: 'prepare-share' });
  const operation = f.state.mutation.operation;
  assert(operation); assert.equal(f.state.sharePreparation.operation, operation);
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
  assert.equal(operation.body.content.status, 'saved'); assert.equal(operation.body.expectedRevision, 2);
  saved.resolve(receipt()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.loaded, false);
  assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.changed, 1);
  changed.resolve(); await pending;
  assert.deepEqual(f.calls.order, ['save', 'changed', 'preview']);
  assert.deepEqual(f.calls.preview[0], [f.current.centerId, f.current.roomId, recordId, f.current.signal]);
  assert.equal(f.state.view.kind, 'publish'); assert.deepEqual(f.state.view.values, {});
  assert.equal(f.state.view.preview.recordRevision, 3); assert.equal(f.state.sharePreparation, null);
  assert.match(f.notice.textContent, /아직 보호자에게 전송하지 않았습니다/);
  assert.equal(f.calls.publish.length, 0);
});

test('missing or whitespace-only summary expands and focuses its field without any save or publish', async () => {
  for (const summary of ['', ' \n\t ']) {
    const f = fixture({ values: { summary } }); const form = f.form;
    await f.ui.submit({ value: 'prepare-share' });
    assert.equal(form.sharing.open, true); assert.equal(f.display.focus, 'summary');
    assert.equal(f.state.mutation.operation, null); assert.equal(f.calls.save.length, 0);
    assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
    assert.match(f.notice.textContent, /아직 저장하거나 공유하지 않았습니다/);
    assert.equal(f.state.view.values.privateNote, 'PRIVATE-CLINICAL');
  }
});

test('ordinary saved and draft actions still allow an empty summary and never enter preparation', async () => {
  for (const intent of ['saved', 'draft']) {
    const f = fixture({ values: { summary: '' } });
    await f.ui.submit({ value: intent });
    assert.equal(f.calls.save.length, 1); assert.equal(f.calls.save[0][3].content.summary, '');
    assert.equal(f.calls.save[0][3].content.status, intent);
    assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view, null);
  }
});

test('an unknown preparation save retries its immutable ID/body but never resumes automatic preview', async () => {
  let attempt = 0;
  const f = fixture({ recordSave: async () => { if (++attempt === 1) throw new LocalApiError('UNAVAILABLE'); return receipt({ replayed: true }); } });
  await f.ui.submit({ value: 'prepare-share' }); const operation = f.state.mutation.operation;
  assert(operation); assert.equal(f.state.mutation.everUncertain, true); assert.equal(f.state.sharePreparation, null);
  await f.ui.guardView(f.current, f.state); assert.equal(f.state.view.kind, 'receipt');
  assert(!f.display.body.includes('PRIVATE-')); assert.equal(f.calls.preview.length, 0);
  await f.ui.mutate();
  assert.equal(f.calls.save.length, 2); assert.equal(f.calls.save[0][3], operation.body); assert.equal(f.calls.save[1][3], operation.body);
  assert.equal(f.state.mutation.operation, null); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
});

test('a later conflict cannot unlock an unknown preparation save or recreate its cancelled continuation', async () => {
  let attempt = 0;
  const f = fixture({ recordSave: async () => {
    throw ++attempt === 1 ? new LocalApiError('UNAVAILABLE') : new LocalApiError('RECORD_CONFLICT', 409);
  } });
  await f.ui.submit({ value: 'prepare-share' }); const operation = f.state.mutation.operation;
  await f.ui.guardView(f.current, f.state); await f.ui.mutate();
  assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.mutation.everUncertain, true);
  assert.equal(f.state.view.kind, 'receipt'); assert.equal(f.state.sharePreparation, null);
  assert.equal(f.calls.save[0][3], f.calls.save[1][3]);
  assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
  assert(!f.display.body.includes('PRIVATE-'));
});

test('a first definitive save conflict leaves editable input and explicit discard without scheduling preview', async () => {
  const f = fixture({ recordSave: async () => { throw new LocalApiError('RECORD_CONFLICT', 409); } });
  await f.ui.submit({ value: 'prepare-share' });
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.sharePreparation, null);
  assert.equal(f.state.view.values.privateNote, 'PRIVATE-CLINICAL');
  assert.equal(f.ui.discard(), true); assert.equal(f.state.view, null); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
});

test('closing while save is pending cancels preview intent without cancelling acknowledgement handling', async () => {
  const saved = deferred(), f = fixture({ recordSave: () => saved.promise });
  const pending = f.ui.submit({ value: 'prepare-share' }); const operation = f.state.mutation.operation;
  f.ui.close(); assert.equal(f.state.sharePreparation, null); assert.equal(f.state.mutation.operation, operation);
  saved.resolve(receipt()); await pending;
  assert.equal(f.state.mutation.operation, null); assert.equal(f.calls.changed, 1);
  assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0); assert.equal(f.ui.dialog.open, false);
});

test('suspend and account/room changes make a late save acknowledgement unable to reopen or refresh another context', async () => {
  for (const transition of ['same-room', 'room', 'account']) {
    const saved = deferred(), f = fixture({ recordSave: () => saved.promise });
    const pending = f.ui.submit({ value: 'prepare-share' }); const operation = f.state.mutation.operation;
    f.ui.suspend();
    f.setContext({ ...f.current, generation: 2,
      ...(transition === 'room' ? { roomId: 'another-synthetic-room' } : {}),
      ...(transition === 'account' ? { user: { userId: 'another-synthetic-therapist', centers: [] } } : {}) });
    assert.equal(f.state.sharePreparation, null); assert.equal(f.state.view.kind, 'receipt');
    saved.resolve(receipt()); await pending;
    assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.mutation.everUncertain, true);
    assert.equal(f.calls.changed, 0); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
    assert.equal(f.ui.dialog.open, false);
  }
});

test('polling may hide a pending form as receipt-only without cancelling a still-current preparation after normal ACK', async () => {
  const saved = deferred(), f = fixture({ recordSave: () => saved.promise });
  const pending = f.ui.submit({ value: 'prepare-share' }); const intent = f.state.sharePreparation;
  f.refresh(); await f.ui.guardView(f.current, f.state);
  assert.equal(f.state.view.kind, 'receipt'); assert.equal(f.state.sharePreparation, intent);
  assert(!f.display.body.includes('PRIVATE-')); assert.equal(f.calls.preview.length, 0);
  saved.resolve(receipt()); await pending;
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.preview.length, 1);
  assert.equal(f.state.view.kind, 'publish'); assert.equal(f.calls.publish.length, 0);
});

test('preview failures keep the accepted save accepted and cannot resend it or expose raw error details', async () => {
  for (const error of [new LocalApiError('UNAVAILABLE'), new LocalApiError('NO_RECIPIENT', 409),
    new LocalApiError('RECORD_NOT_SHAREABLE', 409), new Error('PRIVATE-SERVER-DETAIL')]) {
    const f = fixture({ recordPreview: async () => { throw error; } });
    await f.ui.submit({ value: 'prepare-share' });
    assert.equal(f.calls.save.length, 1); assert.equal(f.calls.preview.length, 1);
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.mutation.everUncertain, false);
    assert.equal(f.state.view, null); assert.equal(f.state.sharePreparation, null);
    assert.match(f.state.readNotice, /기록은 저장됐지만/); assert(!f.state.readNotice.includes('PRIVATE-'));
    await f.ui.mutate(); assert.equal(f.calls.save.length, 1); assert.equal(f.calls.publish.length, 0);
  }
});

test('changed record revision after save stops preview instead of presenting a different saved version', async () => {
  const f = fixture({ recordPreview: async () => preview({ recordRevision: 4 }) });
  await f.ui.submit({ value: 'prepare-share' });
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.preview.length, 1);
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view, null);
  assert.match(f.state.readNotice, /이후 내용이 변경/); assert.equal(f.calls.publish.length, 0);
});

test('a late preview after navigation cannot open a share dialog over the new context', async () => {
  const detail = deferred(), f = fixture({ recordPreview: () => detail.promise });
  const pending = f.ui.submit({ value: 'prepare-share' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.preview.length, 1); assert.equal(f.state.mutation.operation, null);
  f.ui.suspend(); f.setContext({ ...f.current, generation: 2, roomId: 'another-synthetic-room' });
  detail.resolve(preview()); await pending;
  assert.equal(f.state.view, null); assert.equal(f.ui.dialog.open, false); assert.equal(f.display.body, '');
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.publish.length, 0);
});

test('an acknowledged save with no fresh authorized workspace does not fetch preview', async () => {
  const f = fixture({ onChanged: async () => {} });
  await f.ui.submit({ value: 'prepare-share' });
  assert.equal(f.state.loaded, false); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.state.sharePreparation, null); assert.equal(f.calls.preview.length, 0);
  assert.equal(f.calls.publish.length, 0); assert.match(f.state.readNotice, /기록은 저장됐지만/);
});

test('malformed or mismatched save receipts stay unknown and cannot start preview or workspace refresh', async () => {
  for (const value of [undefined, receipt({ operation: 'publish' }), receipt({ recordId: 'another-record' }),
    receipt({ revision: 0 }), receipt({ revision: 2 }), receipt({ revision: 4 }), receipt({ revision: '3' })]) {
    const f = fixture({ recordSave: async () => value });
    await f.ui.submit({ value: 'prepare-share' });
    assert(f.state.mutation.operation); assert.equal(f.state.mutation.everUncertain, true);
    assert.equal(f.state.sharePreparation, null); assert.equal(f.calls.changed, 0);
    assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
  }
});

test('a preview permission denial clears private state but does not resurrect the accepted save', async () => {
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND']) {
    const f = fixture({ recordPreview: async () => { throw new LocalApiError(code); } });
    await f.ui.submit({ value: 'prepare-share' });
    assert.equal(f.calls.save.length, 1); assert.equal(f.state.mutation.operation, null);
    assert.equal(f.ui.states.size, 0); assert.equal(f.ui.key, null); assert.equal(f.display.body, '');
    assert.deepEqual(f.calls.errors, [code]); assert.equal(f.calls.publish.length, 0);
  }
});

test('preparation renders only the public preview allowlist and publishing still requires a separate explicit confirmation', async () => {
  const f = fixture({ recordPreview: async () => preview({ privateNote: 'PRIVATE-SERVER-NOTE', performed: 'PRIVATE-SERVER-ACTIVITY',
    referenceSources: [{ body: 'PRIVATE-SOURCE' }], assessments: [{ item: 'PRIVATE-ASSESSMENT' }] }) });
  await f.ui.submit({ value: 'prepare-share' });
  assert.equal(f.state.view.kind, 'publish'); assert(!f.display.body.includes('PRIVATE-'));
  assert.match(f.display.body, /&lt;합성 공개 제목&gt;/); assert.match(f.display.body, /&lt;합성 보호자&gt;/);
  assert.match(f.display.body, /name="confirmed" required/); assert(!/name="confirmed"[^>]*checked/.test(f.display.body));
  assert.deepEqual(Object.keys(f.state.view.preview).sort(), ['recordId', 'recordRevision', 'relationshipsVersion',
    'recipientIds', 'date', 'title', 'summary', 'activity', 'attachmentCount', 'attachments'].sort());
  await f.ui.submit(); assert.equal(f.calls.publish.length, 0); assert.equal(f.calls.save.length, 1);
  f.form.elements.namedItem('confirmed').checked = true; await f.ui.submit();
  assert.equal(f.calls.publish.length, 1); assert.equal(f.calls.save.length, 1);
  assert.deepEqual(f.calls.publish[0][3], { clientId: 'synthetic-command-2', expectedRevision: 3,
    expectedRelationshipsVersion: 7, recipientIds: ['synthetic-guardian'] });
});

test('preparation captures attachments once; an unknown retry reuses IDs/sharing and cannot recollect changed files', async () => {
  let attempt = 0, captures = 0;
  const forgotten = [], attachment = { id: '12345678-1234-4234-8234-123456789abc', share: false };
  const f = fixture({ recordSave: async () => { if (++attempt === 1) throw new LocalApiError('UNAVAILABLE'); return receipt({ replayed: true }); } });
  f.ui.recordMedia = { update() {}, bind() {}, clear() {}, captureRecordAttachments() { captures++; return [attachment]; },
    forgetSaved(...args) { forgotten.push(args); } };
  await f.ui.submit({ value: 'prepare-share' }); const operation = f.state.mutation.operation;
  assert.equal(captures, 1); assert.deepEqual(operation.body.content.attachments, [attachment]);
  f.ui.recordMedia.captureRecordAttachments = () => assert.fail('Unknown retry must not recapture files.');
  await f.ui.mutate();
  assert.equal(captures, 1); assert.equal(f.calls.save[1][3], operation.body);
  assert.equal(forgotten.length, 1); assert.equal(forgotten[0][1], recordId);
  assert.deepEqual(forgotten[0][2], [attachment.id]); assert.equal(f.calls.preview.length, 0); assert.equal(f.calls.publish.length, 0);
});

test('a successful preparation saves both attachment sharing choices but previews only the server-approved public file', async () => {
  const privateFile = { id: '12345678-1234-4234-8234-123456789abc', name: 'PRIVATE-FILE.png', type: 'image/png', size: 9, share: false };
  const sharedFile = { id: '12345678-1234-4234-8234-123456789abd', name: '<합성 공유>.mp4', type: 'video/mp4', size: 12, share: true };
  const f = fixture({ deliveryEnabled: true, values: { attachments: [privateFile, sharedFile] },
    recordPreview: async () => preview({ attachmentCount: 1, attachments: [sharedFile] }) });
  let captures = 0; const forgotten = [];
  f.ui.recordMedia = { update() {}, bind() {}, clear() {},
    captureRecordAttachments(files) { captures++; return files.map(({ id, share }) => ({ id, share })); },
    forgetSaved(...args) { forgotten.push(args); } };
  await f.ui.submit({ value: 'prepare-share' });
  assert.equal(captures, 1); assert.equal(forgotten.length, 1);
  assert.deepEqual(f.calls.save[0][3].content.attachments, [
    { id: privateFile.id, share: false }, { id: sharedFile.id, share: true },
  ]);
  assert.equal(f.state.view.kind, 'publish'); assert.deepEqual(f.state.view.preview.attachments, [sharedFile]);
  assert.match(f.display.body, /&lt;합성 공유&gt;.mp4/); assert(!f.display.body.includes('PRIVATE-'));
  assert.equal(f.calls.publish.length, 0);
});

test('unprepared or disconnected sharing attachments cannot become a publication preview after the save', async () => {
  const file = { id: '12345678-1234-4234-8234-123456789abc', name: 'synthetic.png', type: 'image/png', size: 9, share: true };
  for (const options of [{ deliveryEnabled: false, value: preview({ attachmentCount: 1, attachments: [file] }) },
    { deliveryEnabled: true, value: preview({ attachmentCount: 1, attachments: [{ ...file, share: false }] }) },
    { deliveryEnabled: true, value: preview({ attachmentCount: 2, attachments: [file] }) }]) {
    const f = fixture({ deliveryEnabled: options.deliveryEnabled, recordPreview: async () => options.value });
    // Media lifecycle is already covered by its own tests. This scoped double
    // supplies no selected uploads and exercises the real preview delivery gate.
    f.ui.recordMedia = { update() {}, bind() {}, captureRecordAttachments: () => [], forgetSaved() {}, clear() {} };
    await f.ui.submit({ value: 'prepare-share' });
    assert.equal(f.calls.save.length, 1); assert.equal(f.state.mutation.operation, null);
    assert.equal(f.state.view, null); assert.equal(f.calls.publish.length, 0);
  }
});
