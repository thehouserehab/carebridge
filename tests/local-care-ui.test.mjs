import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareUi, CareMutation, careRecordContent, publicCarePreview, renderCareMessage, renumberCareAssessments,
  careMessageActions, careTextChange, careReplyContent, careMeasurementMarkup } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

test('prepared text cards expose escaped explicit attachment buttons, never inline URLs or private metadata', () => {
  const m = { id: 'synthetic-message', type: 'text', body: '', attachmentCount: 2,
    attachments: [{ id: '12345678-1234-4234-8234-123456789abc', name: '<가상 사진>.png', type: 'image/png', size: 90, privateKey: 'PRIVATE' },
      { id: '12345678-1234-4234-8234-123456789abd', name: '가상 영상.mp4', type: 'video/mp4', size: 110 }] };
  const html = renderCareMessage(m, 'guardian', 'g1', true);
  assert.match(html, /사진 열기: &lt;가상 사진&gt;.png/);
  assert.match(html, /동영상 열기: 가상 영상.mp4/);
  assert.equal((html.match(/data-open-attachment=/g) ?? []).length, 2);
  for (const value of ['PRIVATE', '<img', '<video', 'src=', 'href=', '<가상 사진>', '<p></p>']) assert(!html.includes(value));
  for (const flags of [{ hidden: true }, { deleted: true }]) assert(!renderCareMessage({ ...m, ...flags }, 'guardian', 'g1', true).includes('data-open-attachment'));
  for (const flag of [undefined, false, 'prepared']) assert(!renderCareMessage(m, 'guardian', 'g1', flag).includes('data-open-attachment'));
  assert(!renderCareMessage({ ...m, attachmentCount: 3 }, 'guardian', 'g1', true).includes('data-open-attachment'));
});

const base = () => ({ date: '2026-10-09', title: '합성 관찰', goalId: 'synthetic-goal', performed: '가상 활동',
  response: '가상 반응', nextPlan: '가상 다음 계획', summary: '공개 요약', privateNote: 'PRIVATE-CLINICAL',
  assessments: [], observation: null, activity: null });
const row = (value = 0) => ({ tool: 'ROM', item: '합성 측정', value, unit: '도', context: '가상 조건' });
const context = () => ({ user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', profile: { conversationId: 'synthetic-room', childId: 'synthetic-child', participants: [] }, messages: [], connected: true,
  generation: 1, signal: new AbortController().signal });
function controller(api, callbacks = {}) {
  let current = context();
  const ui = new CareUi({ api, getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  const state = { mutation: new CareMutation(() => 'synthetic-request-1'), records: [{ id: 'synthetic-record' }],
    goals: [], loaded: true, loading: false, view: { kind: 'record', values: base(), references: [] } };
  ui.states.set(ui.key, state);
  return { ui, state, get current() { return current; }, setContext(value) { current = value; } };
}

const recordFileId = '12345678-1234-4234-8234-123456789abc';
const recordFile = (extra = {}) => ({ id: recordFileId, name: 'synthetic.png', type: 'image/png', size: 9, share: false, ...extra });
const pendingResult = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Controller and DOM doubles only: these fixtures do not approve a real file
// or establish browser, API, scanner or native-storage evidence.
function recordMediaFixture(api = {}, callbacks = {}) {
  const fixture = controller(api, { deliveryEnabled: true, mediaApi: {}, ...callbacks });
  fixture.state.goals = [{ id: 'synthetic-goal', revision: 2, title: '가상 목표' }];
  fixture.state.view = { kind: 'record', recordId: 'synthetic-record', expectedRevision: 0,
    values: base(), references: [], goals: structuredClone(fixture.state.goals) };
  const uploadHost = { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() { this.innerHTML = ''; }, addEventListener() {}, removeEventListener() {} };
  const form = { reportValidity: () => true, querySelectorAll: () => [], querySelector: () => null };
  const display = { title: '', kind: '', body: '' };
  fixture.ui.dialog = { open: true, querySelector: (selector) => selector === '[data-record-upload]' ? uploadHost : selector === 'form' ? form : null,
    querySelectorAll: () => [], close() { this.open = false; }, replaceChildren() { display.body = ''; }, remove() {} };
  fixture.ui.form = (title, kind, body) => {
    fixture.ui.wipeDialog(); Object.assign(display, { title, kind, body }); fixture.ui.dialog.open = true;
  };
  fixture.ui.snapshot = () => {}; fixture.ui.lockForm = () => {};
  fixture.ui.syncRecordMedia();
  const media = fixture.ui.recordMedia;
  const item = { id: 'synthetic-selection', clientId: 'synthetic-upload-request',
    file: new File([new Uint8Array(9)], 'synthetic.png', { type: 'image/png' }),
    manifest: Object.freeze({ name: 'synthetic.png', type: 'image/png', size: 9, sha256: '0'.repeat(64) }),
    upload: { ...recordFile(), mode: 'prepared-delivery', source: { name: 'synthetic.png', type: 'image/png', size: 9 },
      conversationId: fixture.current.roomId, state: 'ready', version: 3, expired: false, expiresAt: '2030-01-01T00:00:00Z', failureCode: null },
    share: false, attempted: true, uncertain: false, cancelRequested: false };
  media.states.get(media.key).items.push(item); media.render();
  return { ...fixture, get current() { return fixture.current; }, media, item, uploadHost, display };
}

test('record attachment save defaults private and freezes only IDs and explicit sharing in the immutable request', async () => {
  const gate = pendingResult(), calls = [];
  const fixture = recordMediaFixture({ recordSave: async (...args) => { calls.push(args); return gate.promise; } });
  const pending = fixture.ui.submit({ value: 'saved' }); const operation = fixture.state.mutation.operation;
  assert.deepEqual(operation.body.content.attachments, [{ id: recordFileId, share: false }]);
  assert.equal(operation.body.expectedRevision, 0); assert.equal(operation.body.expectedGoalRevision, 2);
  assert(Object.isFrozen(operation.body.content.attachments[0]));
  assert.equal(fixture.media.setShare(fixture.item.id, true), false);
  assert.equal(await fixture.media.action('cancel', fixture.item.id), false); assert(fixture.item.file);
  assert.equal(calls.length, 1); assert.equal(calls[0][3], operation.body);
  for (const key of ['name', 'type', 'size', 'sha256']) assert.equal(Object.hasOwn(operation.body.content.attachments[0], key), false);
  gate.resolve({}); await pending;
  assert.equal(fixture.item.file, null); assert.equal(fixture.state.mutation.operation, null); assert.equal(fixture.state.view, null);
});

test('record unknown save retries the exact request even after files become bound and later rejection never unlocks it', async () => {
  const calls = []; let attempt = 0;
  const fixture = recordMediaFixture({ recordSave: async (...args) => {
    calls.push(args); if (++attempt === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempt === 2) throw new LocalApiError('ATTACHMENT_NOT_READY', 409); return {};
  } });
  await fixture.ui.submit({ value: 'saved' }); const operation = fixture.state.mutation.operation;
  assert(operation); assert.equal(fixture.state.mutation.everUncertain, true); assert(fixture.item.file);
  await fixture.ui.guardView(fixture.current, fixture.state); assert.equal(fixture.state.view.kind, 'receipt');
  fixture.item.upload.state = 'bound'; fixture.item.upload.expiresAt = null;
  fixture.media.captureRecordAttachments = () => assert.fail('must not recapture ready files on retry');
  await fixture.ui.mutate();
  assert.equal(fixture.state.mutation.operation, operation); assert.equal(fixture.state.view.kind, 'receipt'); assert(fixture.item.file);
  assert(!fixture.display.body.includes('PRIVATE-CLINICAL')); assert(!fixture.display.body.includes('data-record-upload'));
  await fixture.ui.mutate();
  assert.equal(calls.length, 3); for (const call of calls) assert.equal(call[3], operation.body);
  assert.equal(fixture.item.file, null); assert.equal(fixture.state.view, null);
});

test('first rejected record save after polling restores authored input and files only after current child and reference permission', async () => {
  const gate = pendingResult(), permission = pendingResult(), reads = []; let saves = 0;
  const fixture = recordMediaFixture({ recordSave: async () => { saves++; return gate.promise; },
    profile: async () => { reads.push('profile'); return permission.promise; },
    message: async () => { reads.push('reference'); return { id: 'reference-1', conversationId: 'synthetic-room' }; } });
  const original = fixture.item.file, view = fixture.state.view;
  view.references = [{ messageId: 'reference-1', messageRevision: 2, body: '당시 합성 원문', attachments: [recordFile()] }];
  view.values.attachments = [recordFile({ id: '12345678-1234-4234-8234-123456789abd', share: true })];
  const values = structuredClone(view.values), references = structuredClone(view.references), goals = structuredClone(view.goals);
  const pending = fixture.ui.submit({ value: 'saved' });
  await fixture.ui.guardView(fixture.current, fixture.state); assert.equal(fixture.state.view.kind, 'receipt');
  gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.state.view, view); assert.equal(fixture.ui.dialog.open, false); assert.equal(fixture.display.body, '');
  const repeated = fixture.ui.guardView(fixture.current, fixture.state); assert.deepEqual(reads, ['profile']);
  permission.resolve(fixture.current.profile); await Promise.all([pending, repeated]);
  assert.equal(fixture.state.view, view); assert.deepEqual(view.values, values); assert.deepEqual(view.references, references); assert.deepEqual(view.goals, goals);
  assert.deepEqual(reads, ['profile', 'reference']); assert.equal(view.expectedRevision, 0);
  assert.equal(fixture.state.mutation.operation, null); assert.equal(fixture.item.file, original);
  assert.equal(fixture.ui.recordMediaContext().cleanupOnly, false); assert.equal(fixture.display.kind, 'record');
  assert.match(fixture.display.body, /PRIVATE-CLINICAL/); assert.match(fixture.display.body, /name="performed"/);
  assert.match(fixture.uploadHost.innerHTML, /type="file"/); assert.equal(fixture.media.setShare(fixture.item.id, true), true);
  assert.equal(saves, 1); // Restoring a form is not an automatic retry.
});

for (const code of ['RECORD_CONFLICT', 'CONTEXT_CHANGED']) {
  test(`${code} restoration cannot reuse a pre-submit source read or let its late denial erase the recovered record`, async () => {
    for (const oldOutcome of ['allowed', 'denied']) {
      const save = pendingResult(), oldRead = pendingResult(), profile = pendingResult(), reads = [];
      const fixture = recordMediaFixture({ recordSave: () => save.promise,
        profile: () => { reads.push('profile'); return profile.promise; },
        message: () => { reads.push('source'); return reads.filter(value => value === 'source').length === 1
          ? oldRead.promise : Promise.resolve({ id: 'reference-1', conversationId: 'synthetic-room' }); } });
      const view = fixture.state.view;
      view.references = [{ messageId: 'reference-1', messageRevision: 2, body: '당시 합성 참고' }];
      const original = structuredClone(view), oldCheck = fixture.ui.guardView(fixture.current, fixture.state);
      assert.deepEqual(reads, ['source']);
      const pending = fixture.ui.submit({ value: 'saved' }); await fixture.ui.guardView(fixture.current, fixture.state);
      assert.equal(fixture.state.view.kind, 'receipt'); save.reject(new LocalApiError(code, 409));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(reads, ['source', 'profile']); assert.equal(fixture.state.view, view);
      assert.equal(fixture.ui.dialog.open, false); assert.equal(fixture.display.body, '');
      if (oldOutcome === 'allowed') {
        oldRead.resolve({ id: 'reference-1', conversationId: 'synthetic-room' });
        assert.equal(await oldCheck, false); assert.equal(fixture.ui.dialog.open, false);
      }
      profile.resolve(fixture.current.profile); await pending;
      assert.deepEqual(reads, ['source', 'profile', 'source']); assert.equal(fixture.display.kind, 'record');
      assert.deepEqual(view.values, original.values); assert.deepEqual(view.references, original.references);
      assert.deepEqual(view.goals, original.goals); assert.equal(view.expectedRevision, original.expectedRevision);
      assert.equal(view.contextStale === true, code === 'CONTEXT_CHANGED'); assert(fixture.item.file);
      if (oldOutcome === 'denied') {
        oldRead.reject(new LocalApiError('NOT_FOUND', 404)); assert.equal(await oldCheck, false);
        assert.equal(fixture.state.view, view); assert.equal(fixture.ui.dialog.open, true); assert(fixture.item.file);
      }
    }
  });
}

test('a late old profile result cannot mark the replacement permission check as authorized', async () => {
  const save = pendingResult(), oldProfile = pendingResult(), freshProfile = pendingResult(), errors = [];
  let reads = 0;
  const fixture = recordMediaFixture({ recordSave: () => save.promise,
    profile: () => ++reads === 1 ? oldProfile.promise : freshProfile.promise }, { onError: error => errors.push(error.code) });
  Object.assign(fixture.state.view, { requiresProfileCheck: true, profileChildId: fixture.current.profile.childId });
  const oldCheck = fixture.ui.guardView(fixture.current, fixture.state), pending = fixture.ui.submit({ value: 'saved' });
  await fixture.ui.guardView(fixture.current, fixture.state); save.reject(new LocalApiError('RECORD_CONFLICT', 409));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2);
  oldProfile.resolve(fixture.current.profile); assert.equal(await oldCheck, false);
  freshProfile.reject(new LocalApiError('FORBIDDEN', 403)); await pending;
  assert.deepEqual(errors, ['FORBIDDEN']); assert.equal(fixture.ui.states.size, 0); assert.equal(fixture.item.file, null);
});

test('a text-only saved record recovers authored values and its old clinical references using independent record authority', async () => {
  const save = pendingResult(), reads = [], fixture = recordMediaFixture({ recordSave: () => save.promise,
    profile: async () => { reads.push('profile'); return context().profile; },
    record: async () => { reads.push('record'); return { id: 'synthetic-record', conversationId: 'synthetic-room', revision: 9 }; },
    message: () => assert.fail('saved clinical references have independent record read authority') });
  fixture.media.states.get(fixture.media.key).items = []; const view = fixture.state.view;
  view.expectedRevision = 3; view.references = [{ messageId: 'hidden-source', messageRevision: 1, body: '당시 합성 참고', hidden: true }];
  const original = structuredClone(view), pending = fixture.ui.submit({ value: 'saved' });
  await fixture.ui.guardView(fixture.current, fixture.state); save.reject(new LocalApiError('RECORD_CONFLICT', 409)); await pending;
  assert.equal(fixture.state.view, view); assert.equal(fixture.state.mutation.operation, null);
  assert.deepEqual(reads, ['profile', 'record']); assert.equal(view.expectedRevision, 3);
  assert.deepEqual(view.references, original.references); assert.deepEqual(view.values, original.values);
  assert.match(fixture.display.body, /PRIVATE-CLINICAL/);
});

test('record recovery retains input only in memory on transient reads and clears files on room or source denial', async () => {
  for (const stage of ['profile', 'source']) for (const code of ['UNAVAILABLE', 'NOT_FOUND', 'FORBIDDEN', 'AUTH_REQUIRED']) {
    const save = pendingResult(), api = { recordSave: () => save.promise,
      profile: async () => { if (stage === 'profile') throw new LocalApiError(code); return context().profile; },
      message: async () => { if (stage === 'source') throw new LocalApiError(code); return { id: 'reference-1', conversationId: 'synthetic-room' }; } };
    const fixture = recordMediaFixture(api), view = fixture.state.view;
    view.references = [{ messageId: 'reference-1', messageRevision: 2, body: '당시 합성 참고' }];
    const pending = fixture.ui.submit({ value: 'saved' }); await fixture.ui.guardView(fixture.current, fixture.state);
    save.reject(new LocalApiError('RECORD_CONFLICT', 409)); await pending;
    assert.equal(fixture.display.body, ''); assert.equal(fixture.ui.dialog?.open ?? false, false);
    if (code === 'UNAVAILABLE') {
      assert.equal(fixture.state.view, view); assert(fixture.item.file); assert.equal(fixture.state.mutation.operation, null);
      api.profile = async () => context().profile;
      api.message = async () => ({ id: 'reference-1', conversationId: 'synthetic-room' });
      await fixture.ui.handleAction('resume'); assert.equal(fixture.state.view, view);
      assert.equal(fixture.display.kind, 'record'); assert.match(fixture.display.body, /PRIVATE-CLINICAL/);
    } else {
      assert.equal(fixture.item.file, null);
      if (stage === 'profile' || code === 'AUTH_REQUIRED') assert.equal(fixture.ui.states.size, 0);
      else assert.equal(fixture.state.view, null);
    }
  }
});

test('a recovered record never reopens or clears newer input after late permission results cross scope or suspension', async () => {
  for (const change of ['account', 'room', 'role', 'generation', 'suspend']) for (const result of ['allowed', 'denied']) {
    const save = pendingResult(), profile = pendingResult(), errors = [];
    const fixture = recordMediaFixture({ recordSave: () => save.promise, profile: () => profile.promise }, { onError: error => errors.push(error.code) });
    const originalContext = fixture.current, pending = fixture.ui.submit({ value: 'saved' });
    await fixture.ui.guardView(fixture.current, fixture.state); save.reject(new LocalApiError('RECORD_CONFLICT', 409));
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'account') fixture.setContext({ ...originalContext, user: { ...originalContext.user, userId: 'different-user' } });
    if (change === 'room') fixture.setContext({ ...originalContext, roomId: 'different-room' });
    if (change === 'role') fixture.setContext({ ...originalContext, user: { ...originalContext.user, centers: [{ id: originalContext.centerId, role: 'guardian' }] } });
    if (change === 'generation') fixture.setContext({ ...originalContext, generation: 2 });
    if (change === 'suspend') fixture.ui.suspend();
    const next = { kind: 'record', recordId: 'new-record', values: { ...base(), privateNote: 'NEW-PRIVATE' }, references: [] };
    if (change !== 'role') fixture.state.view = next; // Role-only case also verifies the explicit role fence on the same view.
    const expected = fixture.state.view;
    if (result === 'allowed') profile.resolve(originalContext.profile); else profile.reject(new LocalApiError('NOT_FOUND', 404));
    await pending;
    assert.equal(fixture.state.view, expected); assert.equal(fixture.ui.dialog.open, false); assert.equal(fixture.display.body, '');
    assert(fixture.item.file); assert.deepEqual(errors, []);
  }
});

test('definitive media rejection without receipt preserves editable record and failed cancellation retains its file', async () => {
  const fixture = recordMediaFixture({ recordSave: async () => { throw new LocalApiError('UPLOAD_EXPIRED', 409); } });
  const view = fixture.state.view; await fixture.ui.submit({ value: 'saved' });
  assert.equal(fixture.state.mutation.operation, null); assert.equal(fixture.state.view, view); assert(fixture.item.file);
  assert.equal(fixture.media.setShare(fixture.item.id, true), true);
  fixture.media.api.get = async () => fixture.item.upload;
  fixture.media.api.cancel = async () => { throw new LocalApiError('UNAVAILABLE'); };
  assert.equal(await fixture.media.action('cancel', fixture.item.id), false);
  assert(fixture.item.file); assert.equal(fixture.ui.discard(), false);
});

test('existing bound attachment sharing and removal change only the next record snapshot, never cancel the original file', async () => {
  const opened = []; const fixture = recordMediaFixture({}, { onOpenRecordAttachment: async (...args) => opened.push(args) });
  fixture.state.view.expectedRevision = 4;
  fixture.state.view.values.attachments = [recordFile()]; const original = structuredClone(fixture.state.view.values.attachments);
  fixture.media.api.cancel = () => assert.fail('bound record file must not use upload cancel');
  await fixture.ui.openRecordAttachment(recordFileId);
  assert.deepEqual(opened, [['synthetic-record', 4, recordFileId]]);
  assert.equal(fixture.ui.setRecordShare(recordFileId, true), true);
  assert.equal(original[0].share, false);
  const html = fixture.ui.recordAttachmentsMarkup(fixture.state.view);
  assert.match(html, /data-record-share=/); assert.match(html, /checked/); assert.match(html, /data-record-revision="4"/);
  assert.equal(fixture.ui.removeRecordAttachment(recordFileId), true); assert.deepEqual(fixture.state.view.values.attachments, []);
  await fixture.ui.openRecordAttachment(recordFileId); assert.equal(opened.length, 1);
  assert(fixture.item.file); // Independent new selection is not removed with the bound snapshot.
});

test('prepared edit and preview show explicit permitted filenames while quarantine mode still refuses attached records', async () => {
  const privateFile = recordFile(), shared = recordFile({ id: '12345678-1234-4234-8234-123456789abd', name: '<shared>.mp4', type: 'video/mp4', share: true });
  const record = { ...base(), id: 'synthetic-record', conversationId: 'synthetic-room', revision: 4, attachments: [privateFile, shared], attachmentCount: 2, referenceSources: [] };
  const preview = { recordId: record.id, recordRevision: 4, relationshipsVersion: 2, recipientIds: ['guardian'],
    date: record.date, title: record.title, summary: record.summary, activity: null, attachmentCount: 1, attachments: [shared], privateNote: 'NEVER' };
  const fixture = controller({ record: async () => record, recordPreview: async () => preview }, { mediaApi: {}, deliveryEnabled: true });
  fixture.state.view = null; fixture.state.goals = careData().goals; const forms = captureForms(fixture);
  await fixture.ui.handleAction('edit-record', record.id);
  assert.match(forms.html, /data-record-upload/); assert.match(forms.html, /data-record-share=/); assert.match(forms.html, /&lt;shared&gt;.mp4/);
  assert.equal(fixture.ui.setRecordShare(privateFile.id, true), true); assert.equal(record.attachments[0].share, false);
  fixture.state.view = null; await fixture.ui.handleAction('preview-record', record.id);
  assert.match(forms.html, /aria-label="공유할 첨부"/); assert.match(forms.html, /&lt;shared&gt;.mp4/);
  assert(!forms.html.includes('synthetic.png')); assert(!forms.html.includes('PRIVATE-CLINICAL')); assert(!forms.html.includes('NEVER'));
  const publicProjection = publicCarePreview({ ...preview, attachments: [{ ...shared, privateKey: 'NEVER' }, privateFile] });
  assert.deepEqual(publicProjection.attachments, [shared]);
  const quarantine = controller({ record: async () => record, recordPreview: async () => preview }); quarantine.state.view = null;
  const denied = []; quarantine.ui.fail = (error) => denied.push(error.code);
  await quarantine.ui.handleAction('edit-record', record.id); await quarantine.ui.handleAction('preview-record', record.id);
  assert.equal(quarantine.ui.recordMedia, null); assert.deepEqual(denied, ['ATTACHMENTS_NOT_CONNECTED', 'ATTACHMENTS_NOT_CONNECTED']);
});

test('publication attachment controls use only the prepared public message metadata and disappear with withdrawn content', () => {
  const message = { id: 'p-message', type: 'publication', body: '공유 종료', attachmentCount: 1, attachments: [recordFile({ share: true })],
    publication: { id: 'p1', title: '공유 기록', summary: '공개 요약', privateNote: 'NEVER', attachments: [recordFile({ name: 'PRIVATE.png' })] } };
  const html = renderCareMessage(message, 'guardian', 'g1', true);
  assert.match(html, /data-open-attachment=/); assert.match(html, /synthetic.png/);
  assert(!html.includes('PRIVATE.png')); assert(!html.includes('NEVER'));
  for (const flag of ['hidden', 'deleted']) assert.equal(renderCareMessage({ ...message, [flag]: true }, 'guardian', 'g1', true), '<p>공유 종료</p>');
  assert(!renderCareMessage(message, 'guardian', 'g1', false).includes('data-open-attachment'));
});

test('record attachment viewer is synchronously closed before every source DOM wipe including network denial and suspend', async () => {
  for (const cause of ['close', 'suspend', 'forbidden', 'unavailable']) {
    let fixture, callbacks = 0;
    fixture = recordMediaFixture({ record: async () => { throw new LocalApiError(cause === 'forbidden' ? 'NOT_FOUND' : 'UNAVAILABLE'); } }, {
      onRecordViewClosed: () => { callbacks++; assert.equal(fixture.ui.dialog.open, true); throw new Error('synthetic callback failure'); },
    });
    fixture.state.view.expectedRevision = 1;
    if (cause === 'close') fixture.ui.close();
    else if (cause === 'suspend') fixture.ui.suspend();
    else await fixture.ui.guardView(fixture.current, fixture.state);
    assert.equal(callbacks, 1, cause); assert.equal(fixture.ui.dialog.open, false, cause); assert.equal(fixture.uploadHost.innerHTML, '', cause);
    if (cause === 'forbidden') { assert.equal(fixture.state.view, null); assert.equal(fixture.item.file, null); }
    else { assert(fixture.state.view); assert(fixture.item.file); }
  }
});

test('late viewer rejection cannot clear a different account or newly opened record', async () => {
  const gate = pendingResult(); const fixture = recordMediaFixture({}, { onOpenRecordAttachment: () => gate.promise });
  fixture.state.view.expectedRevision = 2; fixture.state.view.values.attachments = [recordFile()];
  const pending = fixture.ui.openRecordAttachment(recordFileId);
  fixture.setContext({ ...fixture.current, generation: 2 });
  const next = { ...fixture.state.view, recordId: 'new-record', values: { ...base(), privateNote: 'NEW-PRIVATE' } }; fixture.state.view = next;
  gate.reject(new LocalApiError('AUTH_REQUIRED', 401)); await pending;
  assert.equal(fixture.state.view, next); assert.equal(fixture.ui.states.size, 1); assert(fixture.item.file);
});

test('complete room revocation clears record cleanup files and late upload results cannot restore them', async () => {
  const gate = pendingResult(); const fixture = recordMediaFixture();
  fixture.state.view = { kind: 'record-cleanup', recordId: 'synthetic-record', values: {} }; fixture.ui.syncRecordMedia();
  fixture.media.api.get = async () => gate.promise;
  const pending = fixture.media.action('refresh', fixture.item.id);
  fixture.ui.retainRooms(fixture.current.user.userId, fixture.current.centerId, []);
  assert.equal(fixture.item.file, null); assert.equal(fixture.ui.states.size, 0); assert.equal(fixture.media.states.size, 0);
  gate.resolve(fixture.item.upload); assert.equal(await pending, false);
  assert.equal(fixture.ui.states.size, 0); assert.equal(fixture.media.states.size, 0); assert.equal(fixture.uploadHost.innerHTML, '');
});

const publicFile = (extra = {}) => { const { share, ...file } = recordFile(extra); return file; };
const publicationMessage = () => ({ id: 'publication-message', type: 'publication', conversationId: 'synthetic-room', hidden: false, archived: false,
  publication: { id: 'publication', title: '공유 활동', activity: { title: '가상 활동' } } });
const feedbackMessage = (extra = {}) => ({ id: 'feedback-message', conversationId: 'synthetic-room', authorId: 'synthetic-guardian', type: 'feedback',
  hidden: false, deleted: false, archived: false, canReply: true, attachmentCount: 1, attachments: [publicFile()],
  feedback: { id: 'synthetic-feedback', publicationId: 'publication', revision: 1, date: '2026-10-09', result: 'done', reaction: 'F1 경험', difficulty: '' }, ...extra });
function feedbackMediaFixture(api = {}, callbacks = {}) {
  const fixture = recordMediaFixture(api, callbacks), item = fixture.item, original = item.file;
  fixture.ui.recordMedia.clear(); fixture.ui.recordMedia.bind(null); item.file = original;
  fixture.setContext({ ...fixture.current, user: { userId: 'synthetic-guardian', centers: [{ id: 'synthetic-center', role: 'guardian' }] },
    messages: [publicationMessage(), feedbackMessage()] });
  fixture.ui.states.clear(); fixture.ui.key = JSON.stringify(['synthetic-guardian', fixture.current.centerId, fixture.current.roomId]);
  fixture.ui.states.set(fixture.ui.key, fixture.state);
  fixture.state.view = { kind: 'feedback', feedbackId: 'synthetic-feedback', sourceMessageId: 'publication-message', expectedRevision: 0,
    sourceTitle: '공유 활동', values: { date: '2026-10-09', result: 'done', reaction: 'F1 경험', difficulty: '', attachments: [] } };
  fixture.ui.dialog.open = true;
  const form = { reportValidity: () => true, querySelectorAll: () => [], querySelector: () => null };
  fixture.ui.dialog.querySelector = (selector) => selector === '[data-feedback-upload]' ? fixture.uploadHost : selector === 'form' ? form : null;
  fixture.ui.syncFeedbackMedia(); const media = fixture.ui.feedbackMedia;
  media.states.get(media.key).items.push(item); media.render();
  return { ...fixture, get current() { return fixture.current; }, media, item };
}

test('feedback attachment save shares only its selected IDs and locks edits and file cancellation until acknowledgement', async () => {
  const gate = pendingResult(), calls = [];
  const fixture = feedbackMediaFixture({ feedbackSave: async (...args) => { calls.push(args); return gate.promise; } });
  const pending = fixture.ui.submit(); const operation = fixture.state.mutation.operation;
  assert.equal(operation.kind, 'feedback'); assert.equal(operation.targetId, 'synthetic-feedback');
  assert.equal(operation.body.sourceMessageId, 'publication-message'); assert.equal(operation.body.expectedRevision, 0);
  assert.deepEqual(operation.body.content.attachments, [{ id: recordFileId }]); assert(Object.isFrozen(operation.body.content.attachments[0]));
  assert.equal(fixture.ui.removeFeedbackAttachment(recordFileId), false); assert.equal(await fixture.media.action('cancel', fixture.item.id), false);
  assert.equal(fixture.ui.recordMedia.states.size, 0); assert(fixture.item.file);
  gate.resolve({}); await pending;
  assert.equal(calls.length, 1); assert.equal(calls[0][3], operation.body); assert.equal(fixture.item.file, null); assert.equal(fixture.state.view, null);
});

test('feedback response loss keeps original IDs/version/client request after prepared files become bound and a later conflict', async () => {
  const calls = []; let attempt = 0;
  const fixture = feedbackMediaFixture({ feedbackSave: async (...args) => {
    calls.push(args); if (++attempt === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempt === 2) throw new LocalApiError('FEEDBACK_CONFLICT', 409); return {};
  } });
  fixture.state.view.expectedRevision = 1;
  await fixture.ui.submit(); const operation = fixture.state.mutation.operation;
  await fixture.ui.guardView(fixture.current, fixture.state);
  assert.equal(fixture.state.view.kind, 'receipt'); assert(!fixture.display.body.includes('F1 경험')); assert(!fixture.display.body.includes('data-feedback-upload'));
  fixture.item.upload.state = 'bound'; fixture.item.upload.expiresAt = null;
  fixture.media.captureFeedbackAttachments = () => assert.fail('unknown receipt must not recapture');
  await fixture.ui.mutate(); assert.equal(fixture.state.mutation.operation, operation); assert(fixture.item.file);
  await fixture.ui.mutate(); assert.equal(fixture.item.file, null); assert.equal(fixture.state.view, null);
  for (const call of calls) assert.equal(call[3], operation.body);
  assert.equal(operation.body.expectedRevision, 1); assert.deepEqual(operation.body.content.attachments, [{ id: recordFileId }]);
});

test('first feedback conflict after polling preserves authored F1 input, retained files and version rather than merging F2', async () => {
  const save = pendingResult(), profile = pendingResult(), reads = []; let writes = 0;
  const fixture = feedbackMediaFixture({ feedbackSave: () => { writes++; return save.promise; },
    profile: () => { reads.push('profile'); return profile.promise; },
    message: async () => { reads.push('publication'); return publicationMessage(); },
    feedback: async () => { reads.push('feedback'); return feedbackMessage({ feedback: { ...feedbackMessage().feedback, revision: 2, reaction: '별도 F2 내용' } }); } });
  const view = fixture.state.view; view.expectedRevision = 1;
  view.values.attachments = [publicFile({ id: '12345678-1234-4234-8234-123456789abd' })];
  const values = structuredClone(view.values), pending = fixture.ui.submit();
  await fixture.ui.guardView(fixture.current, fixture.state); save.reject(new LocalApiError('FEEDBACK_CONFLICT', 409));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.state.view, view); assert.equal(fixture.display.body, ''); assert.deepEqual(reads, ['profile']);
  profile.resolve(fixture.current.profile); await pending;
  assert.deepEqual(reads, ['profile', 'publication', 'feedback']); assert.equal(view.expectedRevision, 1);
  assert.deepEqual(view.values, values); assert.equal(fixture.state.mutation.operation, null); assert(fixture.item.file);
  assert.equal(fixture.display.kind, 'feedback'); assert.match(fixture.display.body, /F1 경험/); assert(!fixture.display.body.includes('별도 F2 내용'));
  assert.match(fixture.uploadHost.innerHTML, /type="file"/); assert.equal(writes, 1);
});

test('a definitively closed publication after a poll retains cancel-only feedback cleanup without restoring its source', async () => {
  for (const code of ['PUBLICATION_CLOSED']) {
    const gate = pendingResult(); let saves = 0;
    const fixture = feedbackMediaFixture({ feedbackSave: async () => { saves++; return gate.promise; } });
    const pending = fixture.ui.submit(); await fixture.ui.guardView(fixture.current, fixture.state);
    gate.reject(new LocalApiError(code, 409)); await pending;
    assert.deepEqual(fixture.state.view, { kind: 'feedback-cleanup', feedbackId: 'synthetic-feedback', values: {} });
    assert.equal(fixture.state.mutation.operation, null); assert(fixture.item.file);
    assert(!fixture.display.body.includes('F1 경험')); assert(!fixture.display.body.includes('공유 활동'));
    assert.match(fixture.uploadHost.innerHTML, /data-media-action="cancel"/);
    for (const value of ['type="file"', 'data-media-share', 'data-media-action="upload"']) assert(!fixture.uploadHost.innerHTML.includes(value));
    await fixture.ui.submit(); assert.equal(saves, 1); assert.equal(fixture.ui.discard(), false);
    fixture.media.api.get = async () => fixture.item.upload;
    fixture.media.api.cancel = async () => ({ ...fixture.item.upload, state: 'delete_pending' });
    assert.equal(await fixture.media.action('cancel', fixture.item.id), true); assert.equal(fixture.item.file, null);
    assert.equal(fixture.ui.discard(), true);
  }
});

test('feedback edit rereads current files, excludes a bound file only in next revision, and preserves files across form snapshots', async () => {
  const saved = feedbackMessage(), reads = [], writes = [];
  const fixture = feedbackMediaFixture({ feedback: async (...args) => { reads.push(args); return saved; }, feedbackSave: async (...args) => writes.push(args) });
  fixture.media.clear(); fixture.state.view = null;
  await fixture.ui.handleAction('edit-feedback', saved.id);
  assert.equal(reads.length, 1); assert.equal(reads[0][2], saved.feedback.id);
  assert.deepEqual(fixture.state.view.values.attachments, saved.attachments); assert.equal(fixture.state.view.expectedRevision, 1);
  assert.match(fixture.display.body, /data-feedback-attachment=/); assert(!fixture.display.body.includes('data-open-feedback-attachment'));
  const before = fixture.state.view.values.attachments;
  const elements = [{ name: 'reaction', type: 'textarea', value: 'F2 경험' }, { name: 'result', type: 'select', value: 'partial' }];
  const originalQuery = fixture.ui.dialog.querySelector;
  fixture.ui.dialog.querySelector = (selector) => selector === 'form' ? { elements } : originalQuery(selector);
  CareUi.prototype.snapshot.call(fixture.ui);
  assert.equal(fixture.state.view.values.attachments, before); assert.equal(fixture.state.view.values.reaction, 'F2 경험');
  fixture.ui.dialog.querySelector = originalQuery;
  fixture.media.api.cancel = () => assert.fail('removing bound file must not cancel upload');
  assert.equal(fixture.ui.removeFeedbackAttachment(recordFileId), true);
  assert.deepEqual(fixture.state.view.values.attachments, []); assert.deepEqual(saved.attachments, [publicFile()]);
  await fixture.ui.submit(); assert.deepEqual(writes[0][3].content.attachments, []); assert.equal(writes[0][3].expectedRevision, 1);
});

test('feedback edit refuses unsupported attachment lists, wrong authors and stale opening results', async () => {
  for (const prepared of [true, false]) {
    const fixture = controller({ feedback: async () => feedbackMessage({ attachments: undefined }) }, prepared ? { mediaApi: {}, deliveryEnabled: true } : {});
    fixture.setContext({ ...fixture.current, user: { userId: 'synthetic-guardian', centers: [{ id: 'synthetic-center', role: 'guardian' }] }, messages: [publicationMessage(), feedbackMessage()] });
    fixture.ui.key = JSON.stringify(['synthetic-guardian', fixture.current.centerId, fixture.current.roomId]); fixture.ui.states.set(fixture.ui.key, fixture.state); fixture.state.view = null;
    const denied = []; fixture.ui.fail = (error) => denied.push(error.code);
    await fixture.ui.handleAction('edit-feedback', 'feedback-message'); assert.deepEqual(denied, ['ATTACHMENTS_NOT_CONNECTED']); assert.equal(fixture.state.view, null);
  }
  for (const changes of [{ authorId: 'other-guardian' }, { hidden: true }, { archived: true }, { id: 'other-message' }]) {
    const denied = [], fixture = feedbackMediaFixture({ feedback: async () => feedbackMessage(changes) });
    fixture.state.view = null; fixture.ui.fail = (error) => denied.push(error.code);
    await fixture.ui.handleAction('edit-feedback', 'feedback-message'); assert.deepEqual(denied, ['FEEDBACK_CONFLICT']); assert.equal(fixture.state.view, null);
  }
  const gate = pendingResult(), fixture = feedbackMediaFixture({ feedback: () => gate.promise }); fixture.state.view = null;
  const opening = fixture.ui.handleAction('edit-feedback', 'feedback-message'); fixture.ui.suspend();
  fixture.setContext({ ...fixture.current, generation: 2 }); const fresh = { kind: 'feedback', feedbackId: 'fresh', values: {} }; fixture.state.view = fresh;
  gate.resolve(feedbackMessage()); await opening; assert.equal(fixture.state.view, fresh);
});

test('recent feedback can edit a still-active activity outside the bounded conversation window', async () => {
  const saved = feedbackMessage();
  const fixture = feedbackMediaFixture({ feedback: async () => saved });
  fixture.media.clear(); fixture.state.view = null;
  fixture.setContext({ ...fixture.current, messages: [saved], careData: { publications: [publicationMessage()] } });
  await fixture.ui.handleAction('edit-feedback', saved.id);
  assert.equal(fixture.state.view.sourceMessageId, publicationMessage().id);
  assert.equal(fixture.state.view.expectedRevision, saved.feedback.revision);
  assert.deepEqual(fixture.state.view.values.attachments, saved.attachments);
});

test('off-window activity fallback rejects other-room, closed and deleted publications', async () => {
  for (const changes of [{ conversationId: 'other-room' }, { archived: true }, { hidden: true }, { deleted: true }]) {
    const saved = feedbackMessage(), failures = [];
    const fixture = feedbackMediaFixture({ feedback: async () => saved });
    fixture.media.clear(); fixture.state.view = null; fixture.ui.fail = error => failures.push(error.code);
    fixture.setContext({ ...fixture.current, messages: [saved], careData: { publications: [{ ...publicationMessage(), ...changes }] } });
    await fixture.ui.handleAction('edit-feedback', saved.id);
    assert.equal(fixture.state.view, null); assert.deepEqual(failures, ['PUBLICATION_CLOSED']);
  }
});

test('feedback metadata and file controls disappear on source denial or logout and late media status cannot repopulate a revoked room', async () => {
  for (const reason of ['source', 'room', 'logout']) {
    const gate = pendingResult(); const fixture = feedbackMediaFixture({ message: async () => publicationMessage() });
    fixture.media.api.get = () => gate.promise; const pending = fixture.media.action('refresh', fixture.item.id);
    if (reason === 'source') fixture.ui.sourceUnavailable(fixture.state);
    else if (reason === 'room') fixture.ui.retainRooms(fixture.current.user.userId, fixture.current.centerId, []);
    else fixture.ui.clear();
    assert.equal(fixture.item.file, null); assert.equal(fixture.uploadHost.innerHTML, '');
    gate.resolve(fixture.item.upload); assert.equal(await pending, false); assert.equal(fixture.media.states.size, 0);
  }
});

test('therapist feedback review and quote buttons pin the displayed revision and never attach it implicitly to a record', async () => {
  const feedback = feedbackMessage(), opened = [];
  const fixture = controller({ feedbackReview: async () => ({ revision: 1, reviewVersion: 0, note: '' }), message: async () => feedback },
    { mediaApi: {}, deliveryEnabled: true, onOpenFeedbackAttachment: async (...args) => opened.push(args) });
  fixture.current.messages = [feedback]; fixture.state.goals = careData().goals; fixture.state.view = null;
  const forms = captureForms(fixture);
  await fixture.ui.handleAction('review', feedback.id);
  assert.match(forms.html, /data-open-feedback-attachment=/); assert.match(forms.html, /data-feedback-revision="1"/);
  await fixture.ui.openFeedbackAttachment('synthetic-feedback', feedback.id, 1, recordFileId);
  await fixture.ui.openFeedbackAttachment('synthetic-feedback', feedback.id, 2, recordFileId);
  assert.deepEqual(opened, [['synthetic-feedback', feedback.id, 1, recordFileId]]);
  fixture.state.view = null; await fixture.ui.handleAction('reply', feedback.id); assert.match(forms.html, /data-open-feedback-attachment=/);
  fixture.state.view = null; await fixture.ui.handleAction('reference', feedback.id);
  assert.deepEqual(fixture.state.view.references[0].attachments, [publicFile()]); assert.match(forms.html, /data-open-feedback-attachment=/);
  assert.equal(fixture.state.view.values.attachments, undefined);
  const content = careRecordContent({ ...fixture.state.view.values, performed: '가상 기록' }, 'saved', fixture.state.view.references, []);
  assert.deepEqual(content.attachments, []); assert.deepEqual(content.referenceFeedbackRevisions, [{ messageId: feedback.id, revision: 1 }]);
  assert(!JSON.stringify(content).includes(recordFileId));
});

test('saved record reference buttons retain F1 or text snapshot file identity independently of current source content', async () => {
  const old = publicFile(), different = publicFile({ id: '12345678-1234-4234-8234-123456789abd', name: 'F2.png' }), calls = [], opened = [];
  const record = { ...base(), id: 'record', conversationId: 'synthetic-room', revision: 3, attachmentCount: 0, attachments: [],
    referenceSources: [{ messageId: 'feedback-message', feedbackId: 'synthetic-feedback', feedbackRevision: 1, attachmentCount: 1, attachments: [old] },
      { messageId: 'text-message', messageRevision: 2, body: '당시 텍스트', hidden: true, deleted: true, attachmentCount: 1, attachments: [old] }] };
  const fixture = controller({ record: async () => record, feedback: async (...args) => {
    calls.push(args); return feedbackMessage({ feedback: { ...feedbackMessage().feedback, revision: 1, reaction: 'F1 경험' }, attachments: [different] });
  } }, { mediaApi: {}, deliveryEnabled: true, onOpenReferenceAttachment: async (...args) => opened.push(args), onOpenFeedbackAttachment: () => assert.fail('saved reference uses independent record anchor') });
  fixture.state.view = null; fixture.state.goals = careData().goals; const forms = captureForms(fixture);
  await fixture.ui.handleAction('edit-record', 'record');
  assert.equal(calls[0][4], 1); assert.match(forms.html, /F1 경험/); assert(!forms.html.includes('F2.png'));
  assert.equal((forms.html.match(/data-open-reference-attachment=/g) ?? []).length, 2);
  assert(!forms.html.includes('data-open-feedback-attachment')); assert.match(forms.html, /data-record-revision="3"/);
  await fixture.ui.openReferenceAttachment('feedback-message', old.id); await fixture.ui.openReferenceAttachment('text-message', old.id);
  await fixture.ui.openReferenceAttachment('feedback-message', different.id); await fixture.ui.openReferenceAttachment('foreign', old.id);
  assert.deepEqual(opened, [['record', 3, 'feedback-message', old.id], ['record', 3, 'text-message', old.id]]);
  assert.deepEqual(record.referenceSources[0].attachments, [old]);
});

test('historical feedback and reference viewer callbacks reject guardian use, unknown operations and stale error callbacks', async () => {
  const gate = pendingResult(), opened = [];
  const fixture = controller({}, { mediaApi: {}, deliveryEnabled: true, onOpenFeedbackAttachment: (...args) => { opened.push(args); return gate.promise; } });
  fixture.state.view = { kind: 'review', feedbackId: 'synthetic-feedback', messageId: 'feedback-message', expectedRevision: 1, attachments: [publicFile()], values: {} };
  const pending = fixture.ui.openFeedbackAttachment('synthetic-feedback', 'feedback-message', 1, recordFileId);
  fixture.setContext({ ...fixture.current, generation: 2 }); gate.reject(new LocalApiError('AUTH_REQUIRED', 401)); await pending;
  assert.equal(fixture.ui.states.size, 1); assert.equal(opened.length, 1);
  fixture.current.user.centers[0].role = 'guardian';
  await fixture.ui.openFeedbackAttachment('synthetic-feedback', 'feedback-message', 1, recordFileId); assert.equal(opened.length, 1);
  assert.equal(fixture.ui.exactFeedbackMarkup({ feedbackId: 'synthetic-feedback', messageId: 'feedback-message', feedbackRevision: 1, attachments: [publicFile()] }), '');
  fixture.current.user.centers[0].role = 'therapist'; fixture.state.mutation.begin('review', 'synthetic-feedback', {});
  await fixture.ui.openFeedbackAttachment('synthetic-feedback', 'feedback-message', 1, recordFileId); assert.equal(opened.length, 1);
});

test('current feedback cards show public attachments only in prepared mode and remove them with hidden content', () => {
  const message = feedbackMessage(); const html = renderCareMessage(message, 'guardian', 'synthetic-guardian', true);
  assert.match(html, /data-open-attachment=/); assert(!html.includes('data-open-feedback-attachment'));
  assert(!renderCareMessage(message, 'guardian', 'synthetic-guardian', false).includes('data-open-attachment'));
  for (const flag of ['hidden', 'deleted']) assert(!renderCareMessage({ ...message, [flag]: true }, 'guardian', 'synthetic-guardian', true).includes('synthetic.png'));
});

test('record content reuses clinical normalization and preserves zero distinctly from blank', () => {
  const saved = careRecordContent({ ...base(), assessments: [row('0'), row('2.5')] }, 'saved');
  assert.deepEqual(saved.assessments.map((a) => a.value), [0, 2.5]);
  assert.equal(saved.privateNote, 'PRIVATE-CLINICAL');
  const draft = careRecordContent({ ...base(), assessments: [row(''), row(0)] }, 'draft');
  assert.deepEqual(draft.assessments.map((a) => a.value), [null, 0]);
  assert.throws(() => careRecordContent({ ...base(), assessments: [row('')] }, 'saved'), /모두 입력/);
  for (const status of ['draft', 'saved']) assert.throws(() => careRecordContent({ ...base(), assessments: [row('-')] }, status), /측정값/);
});

test('draft-only incomplete measurements do not relax final record validation or limits', () => {
  const blank = { tool: '', item: '', value: '', unit: '', context: '' };
  assert.equal(careRecordContent({ ...base(), assessments: [blank] }, 'draft').assessments[0].value, null);
  assert.throws(() => careRecordContent({ ...base(), assessments: [blank] }, 'saved'));
  assert.throws(() => careRecordContent({ ...base(), assessments: Array.from({ length: 21 }, () => row()) }, 'draft'), /20개/);
  assert.throws(() => careRecordContent({ ...base(), performed: '', response: '', summary: '', privateNote: '', nextPlan: '' }, 'saved'), /기록할 내용/);
});

test('explicit observation state and complete activity use the existing shared rules', () => {
  const observation = { status: 'not-observed', task: '가상 수행', assistance: '', amount: '', repetitions: '', duration: '', context: '' };
  assert.throws(() => careRecordContent({ ...base(), observation }, 'saved'), /관찰함/);
  assert.equal(careRecordContent({ ...base(), observation: { ...observation, status: 'observed' } }, 'saved').observation.task, '가상 수행');
  const activity = { title: '가상 놀이', instruction: '', frequency: '', caution: '' };
  assert.equal(careRecordContent({ ...base(), activity }, 'draft').activity.title, '가상 놀이');
  assert.throws(() => careRecordContent({ ...base(), activity }, 'saved'), /이름·안내·빈도/);
});

test('record references retain selected historical versions without copying source body to public fields', () => {
  const references = [{ messageId: 'feedback-message', feedbackRevision: 2, body: 'PRIVATE-REFERENCE' },
    { messageId: 'text-message', messageRevision: 3, body: 'PRIVATE-TEXT' }];
  const content = careRecordContent(base(), 'saved', references);
  assert.deepEqual(content.referenceMessageIds, ['feedback-message', 'text-message']);
  assert.deepEqual(content.referenceFeedbackRevisions, [{ messageId: 'feedback-message', revision: 2 }]);
  assert.deepEqual(content.referenceTextRevisions, [{ messageId: 'text-message', revision: 3 }]);
  assert.equal(JSON.stringify(content).includes('PRIVATE-REFERENCE'), false);
  assert.equal(JSON.stringify(content).includes('PRIVATE-TEXT'), false);
});

test('preview copies only public fields and the exact explicit recipient/version preconditions', () => {
  const source = { ...base(), recordId: 'r1', recordRevision: 4, relationshipsVersion: 8, recipientIds: ['g1'],
    activity: { title: '놀이', instruction: '안내', frequency: '한 번', caution: '가상 주의', internal: 'NEVER' },
    assessments: [row(0)], referenceSources: [{ body: 'NEVER' }], note: 'NEVER', attachmentCount: 0 };
  const preview = publicCarePreview(source);
  assert.deepEqual(Object.keys(preview), ['recordId', 'recordRevision', 'relationshipsVersion', 'recipientIds', 'date', 'title', 'summary', 'activity', 'attachmentCount']);
  assert.equal(JSON.stringify(preview).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(preview).includes('NEVER'), false);
  source.recipientIds.push('g2'); assert.deepEqual(preview.recipientIds, ['g1']);
});

test('public cards escape text and never surface private notes or controls from a hidden source', () => {
  const publication = { id: 'm1', type: 'publication', body: '<body>', archived: false,
    publication: { id: 'p1', title: '<img onerror=bad>', summary: '<script>bad</script>', privateNote: 'PRIVATE',
      activity: { title: '활동', instruction: '가상 안내', frequency: '한 번', caution: '' } } };
  const guardian = renderCareMessage(publication, 'guardian', 'g1');
  assert.match(guardian, /&lt;img onerror=bad&gt;/); assert.equal(guardian.includes('<script>'), false);
  assert.match(guardian, /data-care-action="feedback"/); assert.equal(guardian.includes('PRIVATE'), false);
  assert.equal(guardian.includes('withdraw'), false);
  assert.match(renderCareMessage(publication, 'therapist', 't1'), /data-care-action="withdraw"/);
  const hidden = renderCareMessage({ ...publication, hidden: true, body: '공유가 종료된 기록입니다.' }, 'guardian', 'g1');
  assert.equal(hidden, '<p>공유가 종료된 기록입니다.</p>');
});

test('feedback controls distinguish private review, public reply and own-guardian editing', () => {
  const feedback = { id: 'm2', authorId: 'g1', type: 'feedback', canReply: true, archived: false,
    feedback: { id: 'f1', publicationId: 'p1', revision: 1, date: '2026-10-09', result: 'done', reaction: '가상 경험', difficulty: '', reviewed: true, note: 'PRIVATE' } };
  const therapist = renderCareMessage(feedback, 'therapist', 't1');
  for (const name of ['review', 'reply', 'reference']) assert.match(therapist, new RegExp(`data-care-action="${name}"`));
  assert.equal(therapist.includes('PRIVATE'), false);
  assert.match(renderCareMessage(feedback, 'guardian', 'g1'), /data-care-action="edit-feedback"/);
  assert.equal(renderCareMessage(feedback, 'guardian', 'g2').includes('edit-feedback'), false);
  assert.equal(renderCareMessage({ ...feedback, archived: true }, 'guardian', 'g1').includes('edit-feedback'), false);
});

test('mutation freezes nested body/client ID and retries exactly the acknowledged-unknown operation', () => {
  let created = 0; const mutation = new CareMutation(() => `synthetic-request-${++created}`);
  const body = { expectedRevision: 0, content: { assessments: [row(0)] } };
  const first = mutation.begin('record', 'r1', body);
  body.content.assessments[0].value = 99;
  assert.equal(first.body.content.assessments[0].value, 0);
  assert.throws(() => { first.body.content.assessments[0].value = 5; }, TypeError);
  assert.equal(mutation.begin('record', 'r1', { content: {} }), null);
  mutation.failed(first);
  assert.equal(mutation.uncertain, true);
  assert.equal(mutation.begin('feedback', 'different', { body: 'changed' }), first);
  assert.equal(created, 1);
  mutation.accepted(first); assert.equal(mutation.operation, null);
  const second = mutation.begin('record', 'r2', {}); assert.notEqual(second.body.clientId, first.body.clientId);
  mutation.accepted(first); assert.equal(mutation.operation, second);
});

test('assessment renumbering retains node identity and raw zero/blank/invalid input strings', () => {
  const rows = [0, 2].map((old, index) => {
    const inputs = [{ dataset: { assessmentField: 'value' }, name: `assessment-${old}-value`, value: index ? '-' : '0' },
      { dataset: { assessmentField: 'context' }, name: `assessment-${old}-context`, value: '' }];
    const legend = { textContent: `측정값 ${old + 1}` };
    return { inputs, legend, querySelector: () => legend, querySelectorAll: () => inputs };
  });
  const before = rows[1].inputs[0];
  renumberCareAssessments({ querySelectorAll: () => rows });
  assert.equal(rows[1].inputs[0], before); assert.equal(before.name, 'assessment-1-value');
  assert.equal(before.value, '-'); assert.equal(rows[0].inputs[0].value, '0');
  assert.equal(rows[1].inputs[1].value, ''); assert.equal(rows[1].legend.textContent, '측정값 2');
});

test('acknowledged mutation invokes only the corresponding scoped API and then refreshes', async () => {
  const calls = []; let changed = 0;
  const { ui, state, current } = controller({ recordSave: async (...args) => calls.push(args) }, { onChanged: () => { changed++; } });
  const operation = state.mutation.begin('record', 'r1', { expectedRevision: 0, content: careRecordContent(base(), 'draft') });
  await ui.mutate(true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [current.centerId, current.roomId, 'r1', operation.body, current.signal]);
  assert.equal(changed, 1); assert.equal(state.view, null); assert.equal(state.mutation.operation, null);
});

test('ambiguous API outcome retains form and identical retry body instead of creating a second record', async () => {
  const calls = []; let fail = true;
  const { ui, state } = controller({ recordSave: async (...args) => { calls.push(args); if (fail) throw { code: 'UNAVAILABLE' }; } });
  const operation = state.mutation.begin('record', 'r1', { expectedRevision: 0, content: careRecordContent(base(), 'draft') });
  await ui.mutate(true);
  assert.equal(state.mutation.operation, operation); assert.equal(state.mutation.uncertain, true);
  assert.equal(state.view.values.privateNote, 'PRIVATE-CLINICAL');
  fail = false; await ui.mutate();
  assert.equal(calls.length, 2); assert.equal(calls[0][3], calls[1][3]);
  assert.equal(state.mutation.operation, null);
});

test('definitive service rejections preserve input but unlock correction/cancellation', async () => {
  for (const code of ['INVALID_INPUT', 'RECORD_CONFLICT', 'FEEDBACK_CONFLICT', 'REVIEW_CONFLICT', 'RECIPIENTS_CHANGED',
    'PUBLICATION_CLOSED', 'CONTEXT_CHANGED', 'REFERENCE_CHANGED', 'ATTACHMENTS_NOT_CONNECTED', 'NO_ACTIVITY']) {
    const { ui, state } = controller({ recordSave: async () => { throw { code }; } });
    state.mutation.begin('record', 'r1', { content: base() }); await ui.mutate(true);
    assert.equal(state.mutation.operation, null, code);
    assert.equal(state.view.values.privateNote, 'PRIVATE-CLINICAL', code);
    assert.ok(state.view.error);
  }
  const { ui, state } = controller({ recordSave: async () => { throw { code: 'IDEMPOTENCY_CONFLICT' }; } });
  const operation = state.mutation.begin('record', 'r1', { content: base() }); await ui.mutate(true);
  assert.equal(state.mutation.operation, operation);
});

test('permission denial clears private state synchronously and delegates to the owner', async () => {
  const failures = [];
  const { ui, state } = controller({ recordSave: async () => { throw { code: 'NOT_FOUND' }; } }, { onError: (e) => failures.push(e.code) });
  state.mutation.begin('record', 'r1', { content: base() }); await ui.mutate(true);
  assert.equal(ui.states.size, 0); assert.equal(ui.key, null); assert.deepEqual(failures, ['NOT_FOUND']);
});

test('late acknowledgements from a previous account/generation cannot repopulate or refresh the new context', async () => {
  let release; let changed = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  const fixture = controller({ recordSave: async () => delayed }, { onChanged: () => changed++ });
  fixture.state.mutation.begin('record', 'r1', { content: base() });
  const work = fixture.ui.mutate(true);
  fixture.setContext({ ...fixture.current, generation: 2, user: { userId: 'new-account', centers: [] } });
  fixture.ui.clear(); release(); await work;
  assert.equal(changed, 0); assert.equal(fixture.ui.states.size, 0); assert.equal(fixture.ui.key, null);
});

test('transient suspend drops read projections while retaining an immutable unknown request in memory', () => {
  const { ui, state } = controller({});
  const operation = state.mutation.begin('record', 'r1', { content: base() });
  ui.suspend();
  assert.deepEqual(state.records, []); assert.deepEqual(state.goals, []); assert.equal(state.loaded, false);
  assert.equal(state.view.kind, 'receipt'); assert.deepEqual(state.view.values, {});
  assert.equal(operation.body.content.privateNote, 'PRIVATE-CLINICAL');
  assert.equal(state.mutation.operation, operation); assert.equal(state.mutation.uncertain, true);
  ui.clear(); assert.equal(ui.states.size, 0);
});

test('private service error details never become user-facing form messages', async () => {
  const { ui, state } = controller({ recordSave: async () => { throw new Error('PRIVATE DATABASE ERROR AND TOKEN'); } });
  state.mutation.begin('record', 'r1', { content: base() }); await ui.mutate(true);
  assert.equal(state.view.error.includes('PRIVATE'), false);
  assert.match(state.view.error, /같은 요청/);
});

test('an unknown commit followed by a domain conflict never unlocks or replaces the original request', async () => {
  let attempt = 0;
  const { ui, state } = controller({ recordSave: async () => { throw { code: ++attempt === 1 ? 'UNAVAILABLE' : 'RECORD_CONFLICT' }; } });
  const operation = state.mutation.begin('record', 'r1', { content: base() });
  await ui.mutate(true); assert.equal(state.mutation.everUncertain, true);
  await ui.mutate();
  assert.equal(state.mutation.operation, operation); assert.equal(state.mutation.everUncertain, true);
  assert.equal(state.view.values.privateNote, 'PRIVATE-CLINICAL');
  assert.match(state.view.error, /이전 요청의 처리 여부/);
});

test('an outstanding record lookup reserves the form so another action cannot create inputs to overwrite', async () => {
  let release; let reads = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const { ui, state } = controller({ record: async () => { reads++; return pending; } });
  state.view = null; ui.display = () => {};
  const first = ui.handleAction('edit-record', 'r1');
  await ui.handleAction('edit-record', 'r2'); await ui.handleAction('new-record');
  assert.equal(reads, 1); assert.equal(state.view, null); assert.ok(state.opening);
  release({ id: 'r1', revision: 1, ...base(), referenceSources: [] }); await first;
  assert.equal(state.view.recordId, 'r1'); assert.equal(state.opening, null);
});

test('suspend invalidates an outstanding opening token and its late result cannot replace new input', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { ui, state } = controller({ record: async () => pending });
  state.view = null; state.goals = [{ id: 'g1', revision: 1, title: '가상 목표' }]; ui.display = () => {};
  const old = ui.handleAction('edit-record', 'old');
  ui.suspend(); assert.equal(state.opening, null);
  state.loaded = true; state.goals = [{ id: 'g1', revision: 1, title: '가상 목표' }];
  await ui.handleAction('new-record'); state.view.values.performed = 'NEW UNSAVED SYNTHETIC INPUT';
  release({ id: 'old', revision: 1, ...base(), referenceSources: [] }); await old;
  assert.notEqual(state.view.recordId, 'old'); assert.equal(state.view.values.performed, 'NEW UNSAVED SYNTHETIC INPUT');
});

const syntheticText = (extra = {}) => ({ id: 'synthetic-message', conversationId: 'synthetic-room', type: 'text',
  body: '가상 원문', authorId: 'synthetic-therapist', version: 1, canReply: true, canEdit: true, canDeleteAll: true,
  canHide: true, hidden: false, deleted: false, archived: false, attachmentCount: 0, ...extra });

test('text menus use strict server capabilities and ownership, not truthy flags or a local clock', () => {
  assert.deepEqual(careMessageActions(syntheticText(), 'therapist', 'synthetic-therapist'),
    ['reply', 'reference', 'text-edit', 'text-delete-self', 'text-delete-all']);
  assert.deepEqual(careMessageActions(syntheticText(), 'guardian', 'another-user'), ['reply', 'text-delete-self']);
  assert.deepEqual(careMessageActions(syntheticText({ canEdit: 'true', canDeleteAll: 1, canHide: 'true', canReply: 'true' }), 'guardian', 'synthetic-therapist'), []);
  assert.deepEqual(careMessageActions(syntheticText({ version: null }), 'therapist', 'synthetic-therapist'), ['text-delete-self']);
  assert.deepEqual(careMessageActions(syntheticText(), 'center', 'synthetic-therapist'), []);
});

test('hidden text has no source or menu; a deleted-text notice permits only explicit self-hide', () => {
  const hidden = renderCareMessage(syntheticText({ hidden: true, body: 'SENSITIVE-HIDDEN' }), 'therapist', 'synthetic-therapist');
  assert.equal(hidden.includes('SENSITIVE-HIDDEN'), false); assert.equal(hidden.includes('data-care-action'), false);
  const deleted = renderCareMessage(syntheticText({ hidden: true, deleted: true, body: 'SENSITIVE-DELETED' }), 'therapist', 'synthetic-therapist');
  assert.equal(deleted.includes('SENSITIVE-DELETED'), false);
  assert.match(deleted, /삭제된 소식입니다/); assert.match(deleted, /data-care-action="text-delete-self"/);
  for (const action of ['text-edit', 'text-delete-all', 'reply', 'reference']) assert.equal(deleted.includes(`data-care-action="${action}"`), false);
  assert.deepEqual(careMessageActions(syntheticText({ deleted: true, hidden: true, canHide: false }), 'guardian', 'g1'), []);
});

test('visible text markup escapes source content and describes unsupported immutable attachments', () => {
  const html = renderCareMessage(syntheticText({ body: '<img onerror=bad>', attachmentCount: 2, privateNote: 'NEVER' }), 'guardian', 'g1');
  assert.match(html, /&lt;img onerror=bad&gt;/); assert.equal(html.includes('<img'), false);
  assert.match(html, /메시지 메뉴/); assert.match(html, /첨부 2개는 보존/);
  assert.equal(html.includes('NEVER'), false); assert.equal(html.includes('type="file"'), false);
});

test('both roles can quote current publications while withdrawn cards offer no reply', () => {
  const message = { id: 'm1', type: 'publication', canReply: true, archived: false,
    publication: { id: 'p1', title: '합성 공개 제목', summary: '합성 요약', activity: null } };
  for (const role of ['therapist', 'guardian']) {
    assert.match(renderCareMessage(message, role, 'someone'), /data-care-action="reply"/);
    assert.equal(renderCareMessage({ ...message, archived: true }, role, 'someone').includes('data-care-action="reply"'), false);
  }
});

test('reply payload pins exactly the source kind version and does not attach clinical fields', () => {
  assert.deepEqual(careReplyContent({ sourceType: 'text', messageId: 'm1', expectedReplyVersion: 3 }, { body: ' 답장 ' }),
    { body: '답장', replyTo: 'm1', expectedReplyVersion: 3 });
  assert.deepEqual(careReplyContent({ sourceType: 'publication', messageId: 'p1' }, { body: ' 답장 ' }), { body: '답장', replyTo: 'p1' });
  assert.deepEqual(careReplyContent({ sourceType: 'feedback', messageId: 'f1', expectedReplyRevision: 2 }, { body: ' 답장 ' }),
    { body: '답장', replyTo: 'f1', expectedReplyRevision: 2 });
  assert.throws(() => careReplyContent({ sourceType: 'text', messageId: 'm1' }, { body: '답장' }));
  assert.throws(() => careReplyContent({ sourceType: 'publication', messageId: 'm1' }, { body: ' ' }));
});

test('text edit/delete payloads distinguish self-hide from versioned all-delete and require confirmation', () => {
  assert.deepEqual(careTextChange({ kind: 'text-edit', expectedRevision: 2, attachmentCount: 0 }, { body: ' 수정 ' }),
    { expectedRevision: 2, body: '수정' });
  assert.throws(() => careTextChange({ kind: 'text-edit', expectedRevision: 2, attachmentCount: 0 }, { body: '' }));
  assert.equal(careTextChange({ kind: 'text-edit', expectedRevision: 2, attachmentCount: 1 }, { body: '' }).body, '');
  assert.throws(() => careTextChange({ kind: 'text-edit', expectedRevision: 2 }, { body: 'a'.repeat(2001) }));
  assert.deepEqual(careTextChange({ kind: 'text-delete', scope: 'self', expectedRevision: 99 }, { confirmed: true }), { scope: 'self', confirmed: true });
  assert.deepEqual(careTextChange({ kind: 'text-delete', scope: 'all', expectedRevision: 2 }, { confirmed: true }), { scope: 'all', confirmed: true, expectedRevision: 2 });
  for (const confirmed of [false, undefined, 'true']) assert.throws(() => careTextChange({ kind: 'text-delete', scope: 'all', expectedRevision: 2 }, { confirmed }));
});

test('form opening rereads current server capabilities and refuses a stale edit permission', async () => {
  let reads = 0;
  const fixture = controller({ message: async () => { reads++; return syntheticText({ canEdit: false }); } });
  fixture.current.messages = [syntheticText()]; fixture.state.view = null; fixture.ui.display = () => {};
  await fixture.ui.handleAction('text-edit', 'synthetic-message');
  assert.equal(reads, 1); assert.equal(fixture.state.view, null); assert.equal(fixture.state.opening, null);
});

test('text reply/reference forms pin the freshly read body and revision, not stale list text', async () => {
  const current = syntheticText({ body: '수정된 가상 원문', version: 4 });
  const fixture = controller({ message: async () => current });
  fixture.state.goals = [{ id: 'g1', revision: 1, title: '가상 목표' }];
  fixture.current.messages = [syntheticText()]; fixture.state.view = null; fixture.ui.display = () => {};
  await fixture.ui.handleAction('reply', current.id);
  assert.equal(fixture.state.view.sourceBody, current.body); assert.equal(fixture.state.view.expectedReplyVersion, 4);
  fixture.state.view = null;
  await fixture.ui.handleAction('reference', current.id);
  assert.deepEqual(fixture.state.view.references, [{ messageId: current.id, messageRevision: 4, body: current.body, attachmentCount: 0 }]);
  const content = careRecordContent(base(), 'saved', fixture.state.view.references);
  assert.deepEqual(content.referenceTextRevisions, [{ messageId: current.id, revision: 4 }]);
});

test('a deleted text can open only its server-permitted self-hide confirmation, without old source data', async () => {
  const deleted = syntheticText({ deleted: true, hidden: true, body: 'SECRET-OLD-BODY', canEdit: false, canReply: false, canDeleteAll: false });
  const fixture = controller({ message: async () => deleted });
  fixture.current.messages = [deleted]; fixture.state.view = null; fixture.ui.display = () => {};
  await fixture.ui.handleAction('text-edit', deleted.id); assert.equal(fixture.state.view, null);
  await fixture.ui.handleAction('text-delete-self', deleted.id);
  assert.equal(fixture.state.view.scope, 'self'); assert.equal(fixture.state.view.sourceBody, '삭제된 소식입니다.');
  assert.equal(fixture.state.view.sourceDeleted, true);
  assert.equal(JSON.stringify(fixture.state.view).includes('SECRET-OLD-BODY'), false);
});

test('edit and delete commands route their own immutable receipt request, including exact retry', async () => {
  for (const [kind, method] of [['text-edit', 'messageEdit'], ['text-delete', 'messageDelete']]) {
    const calls = []; let failed = false;
    const fixture = controller({ [method]: async (...args) => { calls.push(args); if (!failed) { failed = true; throw { code: 'UNAVAILABLE' }; } } });
    const body = kind === 'text-edit' ? { expectedRevision: 1, body: '합성 수정' } : { scope: 'all', expectedRevision: 1, confirmed: true };
    const operation = fixture.state.mutation.begin(kind, 'synthetic-message', body);
    await fixture.ui.mutate(true); await fixture.ui.mutate();
    assert.equal(calls.length, 2); assert.equal(calls[0][3], operation.body); assert.equal(calls[1][3], operation.body);
    assert.equal(fixture.state.mutation.operation, null);
  }
});

test('message conflicts expire only a definitively rejected command, never an earlier unknown commit', async () => {
  for (const code of ['MESSAGE_CONFLICT', 'MESSAGE_DELETED', 'MESSAGE_CHANGE_EXPIRED']) {
    const fixture = controller({ messageEdit: async () => { throw { code }; } });
    fixture.state.mutation.begin('text-edit', 'm1', { expectedRevision: 1, body: '수정' });
    await fixture.ui.mutate(true); assert.equal(fixture.state.mutation.operation, null);
    const unknown = fixture.state.mutation.begin('text-edit', 'm1', { expectedRevision: 1, body: '수정' });
    fixture.state.mutation.failed(unknown); await fixture.ui.mutate();
    assert.equal(fixture.state.mutation.operation, unknown); assert.match(fixture.state.view.error, /이전 요청의 처리 여부/);
  }
});

test('new-record and reference actions wait for a loaded goal instead of opening an unsavable empty form', async () => {
  let reads = 0;
  const fixture = controller({ message: async () => { reads++; return syntheticText(); } });
  fixture.current.messages = [syntheticText()]; fixture.state.view = null; fixture.ui.display = () => {};
  for (const [loaded, goals] of [[false, [{ id: 'g1', revision: 1, title: '가상 목표' }]], [true, []]]) {
    fixture.state.loaded = loaded; fixture.state.goals = goals;
    for (const name of ['new-record', 'reference']) {
      await fixture.ui.handleAction(name, 'synthetic-message'); assert.equal(fixture.state.view, null);
    }
  }
  assert.equal(reads, 0);
  fixture.state.loaded = true; fixture.state.goals = [{ id: 'g1', revision: 1, title: '가상 목표' }];
  await fixture.ui.handleAction('reference', 'synthetic-message');
  assert.equal(reads, 1); assert.equal(fixture.state.view.values.goalId, 'g1');
});

const replyView = () => ({ kind: 'reply', sourceType: 'text', messageId: 'synthetic-message', expectedReplyVersion: 1,
  sourceBody: 'SYNTHETIC-OLD-SOURCE', values: { body: 'SYNTHETIC-UNSENT-INPUT' } });
function captureForms(fixture) {
  let html = '', open = false; const displayed = [];
  fixture.ui.dialog = { get open() { return open; }, querySelector: () => null, remove() {} };
  fixture.ui.form = (title, kind, body) => { html = body; open = true; displayed.push({ title, kind }); };
  fixture.ui.wipeDialog = () => { html = ''; open = false; };
  return { get html() { return html; }, get open() { return open; }, displayed };
}
const safeLists = { goals: async () => [{ id: 'g1', revision: 1, title: '가상 목표' }], records: async () => [] };

test('same-account future-only resume rechecks exact source even when the latest list omits it', async () => {
  let reads = 0;
  const fixture = controller({ ...safeLists, message: async () => { reads++; throw { code: 'NOT_FOUND' }; } });
  fixture.state.view = replyView(); const forms = captureForms(fixture);
  fixture.ui.display(); assert.match(forms.html, /SYNTHETIC-OLD-SOURCE/);
  fixture.ui.suspend();
  fixture.setContext({ ...fixture.current, messages: [], generation: 2, signal: new AbortController().signal });
  await fixture.ui.handleAction('resume');
  assert.equal(reads, 1); assert.equal(fixture.state.view, null); assert.equal(forms.html, '');
  assert.equal(forms.displayed.length, 1);
});

test('all source-dependent existing-view branches recheck read authority before redisplay', async () => {
  const views = [replyView(),
    { kind: 'text-edit', messageId: 'synthetic-message', expectedRevision: 1, values: { body: 'PRIVATE-ORIGINAL' } },
    { kind: 'text-delete', messageId: 'synthetic-message', scope: 'all', sourceBody: 'PRIVATE-ORIGINAL', values: {} },
    { kind: 'record', recordId: 'r1', expectedRevision: 0, values: base(), references: [{ messageId: 'synthetic-message', body: 'PRIVATE-ORIGINAL' }] },
    { kind: 'record', recordId: 'r1', expectedRevision: 1, values: base(), references: [] },
    { kind: 'publish', preview: { recordId: 'r1' }, values: {} },
    { kind: 'feedback', sourceMessageId: 'p1', feedbackId: 'f1', expectedRevision: 0, values: {} },
    { kind: 'review', feedbackId: 'f1', sourceBody: 'PRIVATE-ORIGINAL', values: { note: 'PRIVATE-NOTE' } },
    { kind: 'withdraw', messageId: 'p1', sourceTitle: 'PRIVATE-TITLE', values: {} }];
  for (const view of views) {
    let reads = 0;
    const denied = async () => { reads++; throw { code: 'NOT_FOUND' }; };
    const fixture = controller({ message: denied, record: denied, recordPreview: denied, feedbackReview: denied });
    fixture.state.view = view; const forms = captureForms(fixture);
    await fixture.ui.handleAction('new-record');
    assert.equal(reads, 1, view.kind); assert.equal(fixture.state.view, null, view.kind);
    assert.equal(forms.displayed.length, 0, view.kind);
  }
});

test('normal polling removes an already open reply when the source becomes hidden or deleted', async () => {
  for (const message of [syntheticText({ hidden: true }), syntheticText({ hidden: true, deleted: true })]) {
    const fixture = controller({ ...safeLists, message: async () => message });
    fixture.state.view = replyView(); const forms = captureForms(fixture);
    fixture.ui.display(); fixture.ui.update(); await fixture.state.readCheck.promise;
    assert.equal(fixture.state.view, null); assert.equal(forms.open, false); assert.equal(forms.html, '');
  }
});

test('overlapping read guards share one lookup and success never replaces filled form DOM or the pinned source version', async () => {
  let resolve, reads = 0;
  const pending = new Promise((r) => { resolve = r; });
  const fixture = controller({ ...safeLists, message: async () => { reads++; return pending; } });
  const view = replyView(); fixture.state.view = view; const forms = captureForms(fixture);
  fixture.ui.display(); const before = forms.html;
  fixture.ui.update(); const check = fixture.state.readCheck.promise; fixture.ui.update();
  assert.equal(fixture.state.readCheck.promise, check); assert.equal(reads, 1);
  resolve(syntheticText({ version: 2, body: 'NEW-SOURCE' })); await check;
  assert.equal(forms.html, before); assert.equal(forms.displayed.length, 1); assert.equal(fixture.state.view, view);
  assert.equal(view.expectedReplyVersion, 1); assert.equal(view.values.body, 'SYNTHETIC-UNSENT-INPUT');
});

test('late denied read guards cannot erase a newly selected context or overwrite a new view', async () => {
  let reject;
  const pending = new Promise((_resolve, r) => { reject = r; });
  const fixture = controller({ message: async () => pending });
  fixture.state.view = replyView(); const forms = captureForms(fixture);
  const old = fixture.ui.handleAction('resume');
  fixture.ui.suspend(); fixture.setContext({ ...fixture.current, generation: 2 });
  const fresh = { kind: 'record', expectedRevision: 0, references: [], values: base() }; fixture.state.view = fresh;
  fixture.ui.display(); const before = forms.html;
  reject({ code: 'NOT_FOUND' }); await old;
  assert.equal(fixture.state.view, fresh); assert.equal(forms.html, before);
});

test('authorized saved record references survive source hiding but inaccessible records do not', async () => {
  let recordReads = 0, sourceReads = 0, permitted = true;
  const fixture = controller({ record: async () => { recordReads++; if (!permitted) throw { code: 'NOT_FOUND' }; return { id: 'r1', conversationId: 'synthetic-room' }; },
    message: async () => { sourceReads++; throw { code: 'NOT_FOUND' }; } });
  fixture.state.view = { kind: 'record', recordId: 'r1', expectedRevision: 1, values: base(), references: [{ messageId: 'm1', body: 'CLINICAL-SNAPSHOT' }] };
  const forms = captureForms(fixture);
  await fixture.ui.handleAction('resume'); assert.match(forms.html, /CLINICAL-SNAPSHOT/);
  permitted = false; await fixture.ui.guardView(fixture.current);
  assert.equal(forms.html, ''); assert.equal(fixture.state.view, null);
  assert.equal(recordReads, 2); assert.equal(sourceReads, 0);
});

test('source absence in the list alone is not a denial, and an independent new draft needs no message lookup', async () => {
  let reads = 0;
  const fixture = controller({ message: async () => { reads++; return syntheticText(); } });
  fixture.state.view = replyView(); const forms = captureForms(fixture);
  await fixture.ui.handleAction('resume'); assert.match(forms.html, /SYNTHETIC-UNSENT-INPUT/); assert.equal(reads, 1);
  fixture.state.view = { kind: 'record', recordId: 'new', expectedRevision: 0, values: base(), references: [] };
  await fixture.ui.handleAction('resume'); assert.match(forms.html, /PRIVATE-CLINICAL/); assert.equal(reads, 1);
});

test('unknown mutations resume as receipt-only with exact retry body and no source GET dependency', async () => {
  let sourceReads = 0; const calls = [];
  const fixture = controller({ message: async () => { sourceReads++; throw { code: 'NOT_FOUND' }; }, messageEdit: async (...args) => calls.push(args) });
  fixture.state.view = { kind: 'text-edit', messageId: 'm1', expectedRevision: 1, values: { body: 'SYNTHETIC-SECRET' } };
  const operation = fixture.state.mutation.begin('text-edit', 'm1', { expectedRevision: 1, body: 'SYNTHETIC-SECRET' });
  const forms = captureForms(fixture); fixture.ui.suspend();
  await fixture.ui.handleAction('resume');
  assert.equal(fixture.state.view.kind, 'receipt'); assert.equal(forms.html.includes('SYNTHETIC-SECRET'), false);
  assert.equal(forms.html.includes('textarea'), false); assert.equal(sourceReads, 0);
  await fixture.ui.mutate();
  assert.equal(calls.length, 1); assert.equal(calls[0][3], operation.body); assert.equal(fixture.state.mutation.operation, null);
});

test('unknown receipts survive later source-specific forbidden/not-found without restoring sensitive view data', async () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN']) {
    const fixture = controller({ messageEdit: async () => { throw { code }; } });
    fixture.state.view = { kind: 'text-edit', messageId: 'm1', values: { body: 'SYNTHETIC-SECRET' } };
    const operation = fixture.state.mutation.begin('text-edit', 'm1', { expectedRevision: 1, body: 'SYNTHETIC-SECRET' });
    fixture.state.mutation.failed(operation); const forms = captureForms(fixture);
    await fixture.ui.mutate();
    assert.equal(fixture.state.mutation.operation, operation); assert.equal(fixture.state.view.kind, 'receipt');
    assert.equal(forms.html.includes('SYNTHETIC-SECRET'), false); assert.equal(fixture.ui.states.size, 1);
  }
});

test('failed revalidation hides DOM without pretending authority was revoked and requires a successful reread to reopen', async () => {
  let unavailable = true, reads = 0;
  const fixture = controller({ message: async () => { reads++; if (unavailable) throw { code: 'UNAVAILABLE' }; return syntheticText(); } });
  const view = replyView(); fixture.state.view = view; const forms = captureForms(fixture); fixture.ui.display();
  await fixture.ui.guardView(fixture.current);
  assert.equal(forms.html, ''); assert.equal(fixture.state.view, view);
  unavailable = false; await fixture.ui.handleAction('resume');
  assert.equal(reads, 2); assert.match(forms.html, /SYNTHETIC-UNSENT-INPUT/);
});

test('a deleted-text self-hide confirmation remains readable only with its explicit deleted-source state', async () => {
  const fixture = controller({ message: async () => syntheticText({ hidden: true, deleted: true, canHide: true }) });
  fixture.state.view = { kind: 'text-delete', messageId: 'synthetic-message', scope: 'self', sourceDeleted: true, sourceBody: '삭제된 소식입니다.', values: {} };
  const forms = captureForms(fixture); await fixture.ui.handleAction('resume');
  assert.match(forms.html, /삭제된 소식입니다/);
  fixture.state.view.sourceDeleted = false; fixture.state.view.sourceBody = 'SYNTHETIC-OLD-SOURCE';
  await fixture.ui.guardView(fixture.current); assert.equal(fixture.state.view, null); assert.equal(forms.html, '');
});

test('a normal message matching the deletion notice can resume and complete self-hide without sentinel confusion', async () => {
  let reads = 0; const writes = [];
  const source = syntheticText({ body: '삭제된 소식입니다.', deleted: false, hidden: false });
  const fixture = controller({ message: async () => { reads++; return source; }, messageDelete: async (...args) => writes.push(args) });
  fixture.current.messages = [source]; fixture.state.view = null; const forms = captureForms(fixture);
  await fixture.ui.handleAction('text-delete-self', source.id);
  const view = fixture.state.view;
  assert.equal(view.sourceDeleted, false); assert.equal(view.sourceBody, source.body);
  fixture.ui.close(); await fixture.ui.handleAction('resume');
  assert.equal(reads, 2); assert.equal(fixture.state.view, view); assert.match(forms.html, /삭제된 소식입니다/);
  fixture.state.mutation.begin('text-delete', source.id, careTextChange(view, { confirmed: true }));
  await fixture.ui.mutate(true);
  assert.equal(writes.length, 1); assert.equal(writes[0][3].scope, 'self'); assert.equal(writes[0][3].confirmed, true);
  assert.equal(fixture.state.view, null);
});

test('a mutation started during revalidation is preserved as receipt-only when that read is denied', async () => {
  let reject;
  const fixture = controller({ message: async () => new Promise((_resolve, r) => { reject = r; }) });
  fixture.state.view = replyView(); const forms = captureForms(fixture); fixture.ui.display();
  const check = fixture.ui.guardView(fixture.current);
  const operation = fixture.state.mutation.begin('reply', 'm1', { body: 'SYNTHETIC-UNSENT-INPUT', replyTo: 'm1', expectedReplyVersion: 1 });
  reject({ code: 'NOT_FOUND' }); await check;
  assert.equal(fixture.state.mutation.operation, operation); assert.equal(fixture.state.view.kind, 'receipt');
  assert.equal(forms.html.includes('SYNTHETIC-OLD-SOURCE'), false);
});

test('a first-attempt definitive conflict after polling hid the form exits the empty receipt state explicitly', async () => {
  let reject; const notices = [];
  const fixture = controller({ ...safeLists, messageEdit: async () => new Promise((_resolve, r) => { reject = r; }) });
  fixture.state.view = { kind: 'text-edit', messageId: 'm1', expectedRevision: 1, values: { body: 'SYNTHETIC-SECRET' } };
  const forms = captureForms(fixture); fixture.ui.display();
  const fail = fixture.ui.fail.bind(fixture.ui); fixture.ui.fail = (error) => { notices.push(error.code); fail(error); };
  fixture.state.mutation.begin('text-edit', 'm1', { expectedRevision: 1, body: 'SYNTHETIC-SECRET' });
  const work = fixture.ui.mutate(true);
  fixture.ui.update(); assert.equal(fixture.state.view.kind, 'receipt');
  reject({ code: 'MESSAGE_CONFLICT' }); await work;
  assert.equal(fixture.state.mutation.operation, null); assert.equal(fixture.state.view, null);
  assert.equal(forms.html, ''); assert.deepEqual(notices, ['RECEIPT_REJECTED']);
});

test('revalidation rejects withdrawn feedback sources and mismatched feedback authors without reading list assumptions', async () => {
  const cases = [
    { source: { id: 'p1', conversationId: 'synthetic-room', type: 'publication', archived: true }, revision: 0 },
    { source: { id: 'p1', conversationId: 'synthetic-room', type: 'publication' }, revision: 1 },
  ];
  for (const item of cases) {
    const fixture = controller({ message: async () => item.source,
      feedback: async () => ({ conversationId: 'synthetic-room', authorId: 'another-user', feedback: { id: 'f1' } }) });
    fixture.state.view = { kind: 'feedback', sourceMessageId: 'p1', feedbackId: 'f1', expectedRevision: item.revision, values: {} };
    const forms = captureForms(fixture); await fixture.ui.handleAction('resume');
    assert.equal(fixture.state.view, null); assert.equal(forms.displayed.length, 0);
  }
});

test('confirmed source rejection notifies the owner only after synchronous wipe and cannot overwrite its new epoch', async () => {
  for (const reason of ['hidden', 'NOT_FOUND', 'FORBIDDEN']) {
    let calls = 0, fixture, forms;
    fixture = controller({ message: async () => {
      if (reason === 'hidden') return syntheticText({ hidden: true });
      throw { code: reason };
    } }, { onSourceUnavailable: () => {
      calls++;
      assert.equal(forms.html, ''); assert.equal(forms.open, false); assert.equal(fixture.state.view, null);
      assert.match(fixture.state.readNotice, /현재 읽을 수 없는 원문/);
      fixture.ui.suspend(); fixture.setContext({ ...fixture.current, generation: 2 });
      fixture.state.view = { kind: 'record', expectedRevision: 0, references: [], values: { ...base(), title: 'NEW-CONTEXT-DRAFT' } };
      fixture.ui.display();
    } });
    fixture.state.view = replyView(); forms = captureForms(fixture); fixture.ui.display();
    await fixture.ui.handleAction('resume');
    assert.equal(calls, 1); assert.match(forms.html, /NEW-CONTEXT-DRAFT/);
    assert.equal(forms.html.includes('SYNTHETIC-OLD-SOURCE'), false);
  }
});

test('source callback failures never restore a rejected view or produce unhandled asynchronous rejection', async () => {
  for (const fail of [() => { throw new Error('synthetic callback failure'); }, async () => { throw new Error('synthetic async callback failure'); }]) {
    const fixture = controller({ message: async () => { throw { code: 'NOT_FOUND' }; } }, { onSourceUnavailable: fail });
    fixture.state.view = replyView(); const forms = captureForms(fixture); fixture.ui.display();
    await fixture.ui.handleAction('resume'); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.state.view, null); assert.equal(forms.html, '');
    assert.match(fixture.state.readNotice, /현재 읽을 수 없는 원문/);
  }
});

test('source callback excludes network failures, unknown receipt-only requests and lookups overtaken by a mutation', async () => {
  let calls = 0;
  const network = controller({ message: async () => { throw { code: 'UNAVAILABLE' }; } }, { onSourceUnavailable: () => calls++ });
  network.state.view = replyView(); captureForms(network); await network.ui.guardView(network.current);
  assert.equal(calls, 0); assert.ok(network.state.view);

  const unknown = controller({ message: async () => { throw new Error('must not pre-read source'); } }, { onSourceUnavailable: () => calls++ });
  unknown.state.view = replyView(); const operation = unknown.state.mutation.begin('reply', 'm1', { body: 'synthetic request' });
  unknown.state.mutation.failed(operation); captureForms(unknown); await unknown.ui.handleAction('resume');
  assert.equal(calls, 0); assert.equal(unknown.state.mutation.operation, operation); assert.equal(unknown.state.view.kind, 'receipt');

  let reject;
  const racing = controller({ message: async () => new Promise((_resolve, r) => { reject = r; }) }, { onSourceUnavailable: () => calls++ });
  racing.state.view = replyView(); captureForms(racing); const check = racing.ui.guardView(racing.current);
  const pending = racing.state.mutation.begin('reply', 'm1', { body: 'synthetic pending request' });
  reject({ code: 'NOT_FOUND' }); await check;
  assert.equal(calls, 0); assert.equal(racing.state.mutation.operation, pending); assert.equal(racing.state.view.kind, 'receipt');
});

const appointment = (extra = {}) => ({ id: 'synthetic-appointment', conversationId: 'synthetic-room',
  revision: 3, date: '2026-10-12', time: '10:30', title: '합성 치료 일정', status: 'scheduled', ...extra });
const careData = (extra = {}) => ({ goals: [{ id: 'synthetic-goal', revision: 2, title: '합성 목표' }],
  records: [], appointments: [appointment()], ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('coherent workspace data supplies all care collections without independent list requests or input replacement', async () => {
  let reads = 0;
  const fixture = controller({ goals: async () => { reads++; }, records: async () => { reads++; } });
  fixture.state.view = null;
  const data = careData(); fixture.setContext({ ...fixture.current, careData: data }); fixture.ui.update();
  assert.equal(fixture.state.loaded, true); assert.equal(fixture.state.loading, false); assert.equal(reads, 0);
  assert.deepEqual(fixture.state.goals, data.goals); assert.deepEqual(fixture.state.appointments, data.appointments);
  data.goals[0].title = 'MUTATED OUTSIDE SNAPSHOT'; assert.equal(fixture.state.goals[0].title, '합성 목표');
  const view = fixture.ui.newRecord(fixture.state); view.values.performed = 'UNSAVED CLINICAL INPUT'; fixture.state.view = view;
  fixture.setContext({ ...fixture.current, careData: careData({ goals: [{ id: 'different-goal', revision: 9, title: '다른 목표' }] }) });
  fixture.ui.update(); await fixture.state.readCheck.promise;
  assert.equal(fixture.state.view, view); assert.equal(view.values.performed, 'UNSAVED CLINICAL INPUT');
  assert.equal(view.goals[0].id, 'synthetic-goal'); assert.equal(reads, 0);
});

test('chat attachment suspension reproduces CONTEXT_LOADING and coherent action rehydration immediately opens a fresh-source record', async () => {
  const reads = [], failures = [], current = syntheticText({ body: 'FRESH-AFTER-VIEWER', version: 4 });
  const fixture = controller({ message: async (...args) => { reads.push(args); return current; },
    goals: () => assert.fail('coherent workspace must not trigger a separate list'),
    records: () => assert.fail('coherent workspace must not trigger a separate list') });
  const fail = fixture.ui.fail.bind(fixture.ui);
  fixture.ui.fail = error => { failures.push(error.code); return fail(error); };
  fixture.state.view = null;
  fixture.setContext({ ...fixture.current, panelMode: 'compact', messages: [syntheticText({ body: 'STALE-LIST-BODY' })], careData: careData() });
  const forms = captureForms(fixture); fixture.ui.update(); assert.equal(fixture.state.loaded, true);
  // The chat attachment opener suspends care. Closing its independent viewer
  // does not itself refresh care collections: this is the native failure path.
  fixture.ui.suspend(); assert.equal(fixture.state.loaded, false); assert.deepEqual(fixture.state.goals, []);
  await fixture.ui.handleAction('reference', current.id);
  assert.deepEqual(failures, ['CONTEXT_LOADING']); assert.equal(reads.length, 0); assert.equal(forms.open, false);
  // The application now applies the currently authorized coherent snapshot
  // immediately before the action; no polling tick or permissive bypass.
  fixture.ui.update(fixture.current); await fixture.ui.handleAction('reference', current.id);
  assert.equal(fixture.state.loaded, true); assert.equal(forms.open, true); assert.equal(forms.displayed.length, 1);
  assert.equal(fixture.state.view.kind, 'record'); assert.equal(fixture.state.view.expectedRevision, 0);
  assert.equal(fixture.state.view.values.goalId, 'synthetic-goal'); assert.equal(fixture.state.view.goals[0].revision, 2);
  assert.equal(fixture.state.view.references[0].body, 'FRESH-AFTER-VIEWER'); assert.equal(fixture.state.view.references[0].messageRevision, 4);
  assert.equal(reads.length, 1); assert.deepEqual(reads[0], ['synthetic-center', 'synthetic-room', current.id, fixture.current.signal]);
  assert(!forms.html.includes('STALE-LIST-BODY')); assert.deepEqual(failures, ['CONTEXT_LOADING']);
});

test('rehydrating after a chat viewer never authorizes a hidden, deleted, foreign or denied cached source', async () => {
  for (const boundary of ['hidden', 'deleted', 'foreign-room', 'not-found', 'forbidden']) {
    let reads = 0;
    const fixture = controller({ message: async () => {
      reads++;
      if (boundary === 'not-found') throw new LocalApiError('NOT_FOUND', 404);
      if (boundary === 'forbidden') throw new LocalApiError('FORBIDDEN', 403);
      return syntheticText({ body: 'DENIED-SOURCE', ...(boundary === 'foreign-room' ? { conversationId: 'other-room' } : { [boundary]: true }) });
    } });
    fixture.state.view = null; fixture.setContext({ ...fixture.current, messages: [syntheticText()], careData: careData() });
    const forms = captureForms(fixture); fixture.ui.update(); fixture.ui.suspend(); fixture.ui.update(fixture.current);
    await fixture.ui.handleAction('reference', 'synthetic-message');
    assert.equal(reads, 1, boundary); assert.equal(forms.open, false); assert.equal(forms.displayed.length, 0);
    assert(!forms.html.includes('DENIED-SOURCE')); assert.equal(fixture.ui.state()?.view ?? null, null);
  }
});

test('a late source read after viewer rehydration cannot open a record in another account, room or role', async () => {
  for (const boundary of ['account', 'room', 'role']) {
    const gate = pendingResult(), started = pendingResult();
    const fixture = controller({ message: () => { started.resolve(); return gate.promise; } });
    fixture.state.view = null; fixture.setContext({ ...fixture.current, messages: [syntheticText()], careData: careData() });
    const forms = captureForms(fixture); fixture.ui.update(); fixture.ui.suspend(); fixture.ui.update(fixture.current);
    const opening = fixture.ui.handleAction('reference', 'synthetic-message'); await started.promise;
    const next = { ...fixture.current, generation: fixture.current.generation + 1 };
    if (boundary === 'account') next.user = { ...next.user, userId: 'other-therapist' };
    if (boundary === 'room') { next.roomId = 'other-room'; next.profile = { childId: 'other-child', conversationId: 'other-room', participants: [] }; }
    if (boundary === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
    fixture.setContext(next); fixture.ui.update(next);
    gate.resolve(syntheticText({ body: 'LATE-OLD-SOURCE' })); await opening;
    assert.equal(forms.open, false, boundary); assert.equal(forms.displayed.length, 0);
    assert.equal(fixture.ui.state()?.view ?? null, null); assert(!forms.html.includes('LATE-OLD-SOURCE'));
  }
});

test('viewer rehydration preserves an unknown record receipt instead of starting or repinning another reference', async () => {
  const fixture = controller({ message: () => assert.fail('unknown request recovery must not query a different source') });
  fixture.state.view = null; fixture.setContext({ ...fixture.current, messages: [syntheticText()], careData: careData() });
  const forms = captureForms(fixture); fixture.ui.update();
  fixture.state.view = fixture.ui.newRecord(fixture.state); fixture.state.view.values.privateNote = 'UNKNOWN-RECORD-INPUT';
  const operation = fixture.state.mutation.begin('record', fixture.state.view.recordId,
    { expectedRevision: 0, expectedGoalRevision: 2, content: { privateNote: 'UNKNOWN-RECORD-INPUT', referenceMessageIds: [] } });
  fixture.ui.suspend(); fixture.ui.update(fixture.current); await fixture.ui.handleAction('reference', 'synthetic-message');
  assert.equal(fixture.state.mutation.operation, operation); assert.equal(fixture.state.mutation.everUncertain, true);
  assert.equal(fixture.state.view.kind, 'receipt'); assert.equal(forms.open, true);
  assert(!forms.html.includes('UNKNOWN-RECORD-INPUT')); assert.equal(operation.body.expectedGoalRevision, 2);
  assert.deepEqual(operation.body.content.referenceMessageIds, []);
});

test('legacy list loading remains available but late results and errors cannot overwrite a coherent snapshot', async () => {
  for (const rejected of [false, true]) {
    let complete; const failures = [];
    const fixture = controller({ goals: async () => new Promise((resolve, reject) => { complete = rejected ? reject : resolve; }),
      records: async () => [{ id: 'STALE-RECORD' }] });
    fixture.state.view = null; fixture.ui.fail = (error) => failures.push(error.code);
    const pending = fixture.ui.load(fixture.current); assert.equal(fixture.state.loading, true);
    fixture.setContext({ ...fixture.current, careData: careData() }); fixture.ui.update();
    complete(rejected ? { code: 'NOT_FOUND' } : [{ id: 'STALE-GOAL' }]); await pending;
    assert.equal(fixture.state.loading, false); assert.equal(fixture.state.loaded, true);
    assert.equal(fixture.state.goals[0].id, 'synthetic-goal'); assert.deepEqual(fixture.state.records, []);
    assert.deepEqual(failures, []);
  }
  const fixture = controller(safeLists); fixture.state.view = null; fixture.ui.update(); await tick();
  assert.equal(fixture.state.goals[0].id, 'g1'); assert.equal(fixture.state.loaded, true);
});

test('malformed supplied care data fails closed without unrelated list fallback and suspend removes appointment projections', () => {
  const fixture = controller({ goals: () => assert.fail('must not load independently'), records: () => assert.fail('must not load independently') });
  fixture.state.view = null; fixture.setContext({ ...fixture.current, careData: { ...careData(), appointments: null } });
  fixture.ui.update(); assert.equal(fixture.state.loaded, false);
  assert.deepEqual(fixture.state.goals, []); assert.deepEqual(fixture.state.records, []); assert.deepEqual(fixture.state.appointments, []);
  fixture.setContext({ ...fixture.current, careData: careData() }); fixture.ui.update(); fixture.ui.suspend();
  assert.deepEqual(fixture.state.appointments, []); assert.equal(fixture.state.loadRequest, null);
});

test('compact mode shows record entry and resume without record titles while default and records modes retain the list', () => {
  const fixture = controller({});
  fixture.ui.host = { ownerDocument: { activeElement: null }, innerHTML: '', contains: () => false };
  fixture.state.records = [{ id: 'r1', title: '<SYNTHETIC-RECORD>', date: '2026-10-12', revision: 1, status: 'saved' }];
  fixture.state.goals = careData().goals;
  fixture.setContext({ ...fixture.current, panelMode: 'compact' }); fixture.ui.render();
  assert.match(fixture.ui.host.innerHTML, /data-care-action="new-record"/); assert.match(fixture.ui.host.innerHTML, /data-care-action="resume"/);
  assert.match(fixture.ui.host.innerHTML, /치료사 전용/); assert.equal(fixture.ui.host.innerHTML.includes('care-record-list'), false);
  assert.equal(fixture.ui.host.innerHTML.includes('SYNTHETIC-RECORD'), false);
  assert(!fixture.ui.host.innerHTML.includes('care-record-toolbar'));
  assert(!fixture.ui.host.innerHTML.includes('care-comparison-help'));
  for (const panelMode of [undefined, 'records']) {
    fixture.setContext({ ...fixture.current, panelMode }); fixture.ui.render();
    assert.match(fixture.ui.host.innerHTML, /care-record-list/); assert.match(fixture.ui.host.innerHTML, /&lt;SYNTHETIC-RECORD&gt;/);
  }
});

test('record overview separates drafts from saved records without changing actions, source order within each group or record data', () => {
  const fixture = controller({});
  fixture.ui.host = { ownerDocument: { activeElement: null }, innerHTML: '', contains: () => false };
  fixture.state.goals = careData().goals; fixture.state.view = null;
  fixture.state.records = [
    { id: 'saved-first', title: '<저장 하나>', date: '2026-11-03', revision: 1, status: 'saved' },
    { id: 'draft-first', title: '<초안 하나>', date: '2026-11-03', revision: 1, status: 'draft' },
    { id: 'saved-second', title: '저장 둘', date: '2026-11-02', revision: 2, status: 'saved' },
    { id: 'draft-second', title: '초안 둘', date: '2026-11-02', revision: 2, status: 'draft' },
  ];
  const records = structuredClone(fixture.state.records); fixture.ui.render(); const html = fixture.ui.host.innerHTML;
  assert.match(html, /aria-label="작성 중인 기록"/); assert.match(html, /aria-label="저장한 기록"/);
  const order = [...html.matchAll(/<article[^>]*data-record-id="([^"]+)"/g)].map(([, id]) => id);
  assert.deepEqual(order, ['draft-first', 'draft-second', 'saved-first', 'saved-second']);
  for (const name of ['edit-record', 'reuse-record']) assert.equal((html.match(new RegExp(`data-care-action="${name}"`, 'g')) ?? []).length, 4);
  assert.equal((html.match(/data-care-action="preview-record"/g) ?? []).length, 2);
  assert.equal((html.match(/data-care-action="new-record"/g) ?? []).length, 1);
  assert.match(html, /&lt;저장 하나&gt;/); assert.match(html, /&lt;초안 하나&gt;/);
  assert.deepEqual(fixture.state.records, records);
});

test('record empty state waits for a completed read and comparison actions and status remain outside the help disclosure', () => {
  const fixture = controller({});
  fixture.ui.host = { ownerDocument: { activeElement: null }, innerHTML: '', contains: () => false };
  fixture.state.records = []; fixture.state.view = null; fixture.state.loaded = false;
  fixture.ui.render(); assert(!fixture.ui.host.innerHTML.includes('care-record-empty'));
  fixture.state.loaded = true; fixture.ui.render();
  assert.match(fixture.ui.host.innerHTML, /목표를 만든 뒤 첫 관찰/);
  assert.match(fixture.ui.host.innerHTML, /data-care-action="new-record"[^>]*disabled/);
  fixture.state.goals = careData().goals; fixture.ui.render();
  assert.match(fixture.ui.host.innerHTML, /활동·아이의 반응·다음 계획/);
  for (const comparison of [null, { loading: true, loaded: false }, { notice: '가상 다시 확인', loaded: false }]) {
    const html = careMeasurementMarkup(comparison), help = html.match(/<details class="care-comparison-help">[\s\S]*?<\/details>/)?.[0];
    assert(help); assert(!help.includes('data-care-action=')); assert(!help.includes('role="status"'));
    assert(!help.includes(' open')); assert.match(help, /자동 점수 산정이나 임상 해석은 제공하지 않습니다/);
    const outside = html.replace(help, ''); assert.match(outside, /data-care-action="compare-records"/);
    if (comparison) assert.match(outside, /role="status"/);
  }
});

test('changed authorized record rendering retains static help disclosure and focus but an invalidated host does not carry them forward', () => {
  const fixture = controller({}), document = { activeElement: null }, focusOptions = [];
  let markup = '', help = null;
  const makeHelp = () => {
    const summary = { closest: () => null, focus(options) { document.activeElement = summary; focusOptions.push(options); } };
    return { open: false, querySelector: selector => selector === 'summary' ? summary : null };
  };
  fixture.ui.host = { ownerDocument: document, contains: node => !!help && node === help.querySelector('summary'),
    querySelector: selector => selector === '.care-comparison-help' ? help : null, querySelectorAll: () => [],
    get innerHTML() { return markup; }, set innerHTML(value) { markup = value; document.activeElement = null; help = value.includes('care-comparison-help') ? makeHelp() : null; } };
  const initial = careMeasurementMarkup(null);
  fixture.ui.paintHost(initial, false); help.open = true; document.activeElement = help.querySelector('summary');
  const previousHelp = help; fixture.ui.paintHost(initial + '<p>가상 목록 갱신</p>', false);
  assert.notEqual(help, previousHelp); assert.equal(help.open, true);
  assert.equal(document.activeElement, help.querySelector('summary')); assert.equal(focusOptions.at(-1).preventScroll, true);
  fixture.ui.painted = null; fixture.ui.paintHost(initial, false);
  assert.equal(help.open, false); assert.equal(document.activeElement, null);
});

// A DOM double makes replacement observable through new node identities and
// write counts. It is not evidence of physical-browser focus or layout.
function careHost(document = { activeElement: null }) {
  let markup = '', buttons = [], extras = [];
  const element = (dataset = {}, disabled = false) => ({ dataset, disabled, textContent: '',
    closest: () => null, setAttribute() {},
    focus() { if (!this.disabled) document.activeElement = this; } });
  document.createElement ??= () => element();
  const host = { ownerDocument: document, writes: 0,
    get innerHTML() { return markup.replace(/ disabled>/g, ' disabled="">'); },
    set innerHTML(value) {
      this.writes++; markup = value; extras = [];
      if (this.contains(document.activeElement)) document.activeElement = null;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attributes]) => {
        const dataset = Object.fromEntries([...attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)]
          .map(([, key, text]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), text]));
        const button = element(dataset, /\bdisabled\b/.test(attributes));
        button.closest = (selector) => selector === '[data-care-action]' ? button : null;
        return button;
      });
    },
    contains: (node) => !!node && (buttons.includes(node) || extras.includes(node)),
    querySelectorAll: (selector) => selector === '[data-care-action]' ? buttons : [],
    querySelector: (selector) => selector === '[data-care-status]' ? extras.find(node => 'careStatus' in node.dataset) ?? null : null,
    append(node) { extras.push(node); },
    replaceChildren() { this.innerHTML = ''; }, addEventListener() {}, removeEventListener() {},
    get extras() { return extras; },
  };
  return host;
}
function paintedCareFixture(role = 'therapist', api = {}, callbacks = {}) {
  const fixture = controller(api, callbacks), host = careHost();
  fixture.state.view = null;
  fixture.setContext({ ...fixture.current, careData: careData(),
    user: { ...fixture.current.user, centers: [{ id: fixture.current.centerId, role }] } });
  fixture.ui.bind(host); fixture.ui.update();
  return { ...fixture, get current() { return fixture.current; }, host };
}

for (const role of ['therapist', 'guardian']) {
  test(`${role} unchanged polling keeps host nodes and focus while still checking source authority`, async () => {
    let reads = 0;
    const fixture = paintedCareFixture(role, { message: async () => {
      reads++; return { id: 'synthetic-message', conversationId: 'synthetic-room', type: 'text' };
    } });
    fixture.state.view = { kind: 'text-edit', messageId: 'synthetic-message', values: { body: '합성 미전송 입력' } };
    fixture.ui.update(); await fixture.ui.guardView(fixture.current);
    const button = fixture.host.querySelectorAll('[data-care-action]').find(node => node.dataset.careAction === 'resume');
    button.focus(); const writes = fixture.host.writes;
    for (let poll = 0; poll < 3; poll++) {
      fixture.ui.update(); await fixture.ui.guardView(fixture.current);
      assert.equal(fixture.host.writes, writes);
      assert.equal(fixture.host.querySelectorAll('[data-care-action]').find(node => node.dataset.careAction === 'resume'), button);
      assert.equal(fixture.host.ownerDocument.activeElement, button);
    }
    assert.equal(reads, 4); assert.equal(fixture.state.view.values.body, '합성 미전송 입력');
  });

  test(`${role} opening transitions repaint and lock controls without repeated writes or duplicate status`, () => {
    const fixture = paintedCareFixture(role);
    fixture.state.view = { kind: 'receipt', values: {} }; fixture.ui.render();
    fixture.state.opening = {}; fixture.ui.render(); const writes = fixture.host.writes;
    assert(fixture.host.querySelectorAll('[data-care-action]').every(node => node.disabled));
    assert.equal(fixture.host.extras.length, 1);
    assert.equal(fixture.host.extras[0].textContent, '기록 내용을 확인하고 있어요…');
    fixture.state.opening = {}; fixture.ui.render();
    assert.equal(fixture.host.writes, writes); assert.equal(fixture.host.extras.length, 1);
    fixture.state.opening = null; fixture.ui.render();
    assert.equal(fixture.host.writes, writes + 1); assert.equal(fixture.host.extras.length, 0);
    assert(fixture.host.querySelectorAll('[data-care-action]').every(node => !node.disabled));
  });
}

test('host painting reflects panel, records, goal availability and notices rather than caching the context object', () => {
  const fixture = paintedCareFixture();
  const repaint = (change, check) => {
    const writes = fixture.host.writes; change(); fixture.ui.render();
    assert.equal(fixture.host.writes, writes + 1); check();
    fixture.ui.render(); assert.equal(fixture.host.writes, writes + 1);
  };
  repaint(() => { fixture.state.records = [{ id: 'record-1', title: '<합성 기록>', date: '2026-10-13', revision: 1, status: 'saved' }]; },
    () => assert.match(fixture.host.innerHTML, /&lt;합성 기록&gt;/));
  repaint(() => { fixture.state.goals = []; },
    () => assert.equal(fixture.host.querySelectorAll('[data-care-action]').find(node => node.dataset.careAction === 'new-record').disabled, true));
  repaint(() => fixture.setContext({ ...fixture.current, panelMode: 'compact' }),
    () => assert(!fixture.host.innerHTML.includes('care-record-list')));
  repaint(() => { fixture.state.readNotice = '<합성 안내>'; },
    () => assert.match(fixture.host.innerHTML, /&lt;합성 안내&gt;/));
  repaint(() => { fixture.state.loaded = false; },
    () => assert.match(fixture.host.innerHTML, /기록과 목표를 확인하고 있어요/));
});

test('bind, suspend and clear invalidate host markup even when the next authorized projection is identical', () => {
  const fixture = paintedCareFixture(), first = fixture.host, second = careHost(first.ownerDocument);
  const original = first.querySelectorAll('[data-care-action]')[0];
  fixture.ui.bind(second); fixture.ui.update(); assert.equal(second.writes, 1);
  const writes = first.writes; fixture.ui.bind(first); fixture.ui.update();
  assert.equal(first.writes, writes + 1); assert.notEqual(first.querySelectorAll('[data-care-action]')[0], original);
  fixture.ui.bind(null); fixture.ui.bind(first); fixture.ui.update(); assert.equal(first.writes, writes + 2);
  for (const operation of ['suspend', 'clear']) {
    fixture.ui[operation](); assert.equal(first.innerHTML, ''); assert.equal(fixture.ui.painted, null);
    const cleared = first.writes; fixture.ui.update(); assert(first.writes > cleared);
    assert.match(first.innerHTML, /data-care-action="new-record"/);
    const restored = first.writes; fixture.ui.update(); assert.equal(first.writes, restored);
  }
});

test('role and account boundaries discard existing host nodes even if public markup would be unchanged', () => {
  const fixture = paintedCareFixture();
  fixture.setContext({ ...fixture.current, user: { ...fixture.current.user,
    centers: [{ id: fixture.current.centerId, role: 'guardian' }] } });
  fixture.ui.update(); assert(!fixture.host.innerHTML.includes('data-care-action="new-record"'));
  assert.match(fixture.host.innerHTML, /공유된 기록에서/);
  const writes = fixture.host.writes;
  fixture.setContext({ ...fixture.current, user: { ...fixture.current.user, userId: 'other-synthetic-guardian' } });
  fixture.ui.update(); assert(fixture.host.writes > writes);
  assert.equal(fixture.ui.states.size, 1); assert.equal(fixture.ui.owner, 'other-synthetic-guardian');
});

test('cached host paint never suppresses a later source denial or restores its resume control', async () => {
  let denied = false, closed = 0;
  const fixture = paintedCareFixture('therapist', { message: async () => {
    if (denied) throw new LocalApiError('NOT_FOUND', 404);
    return { id: 'synthetic-message', conversationId: 'synthetic-room', type: 'text' };
  } }, { onSourceUnavailable: () => { closed++; } });
  fixture.state.view = { kind: 'text-edit', messageId: 'synthetic-message', values: { body: '합성 미전송 입력' } };
  fixture.ui.update(); await fixture.ui.guardView(fixture.current);
  assert.match(fixture.host.innerHTML, /data-care-action="resume"/);
  denied = true; fixture.ui.update(); await fixture.ui.guardView(fixture.current);
  assert.equal(closed, 1); assert.equal(fixture.state.view, null);
  fixture.ui.render(); assert(!fixture.host.innerHTML.includes('data-care-action="resume"'));
});

test('direct host error notices invalidate markup and cannot survive a later unchanged successful render', () => {
  const fixture = paintedCareFixture();
  fixture.ui.fail(new LocalApiError('UNAVAILABLE'));
  assert.equal(fixture.ui.painted, null); assert(fixture.host.querySelector('[data-care-status]'));
  const writes = fixture.host.writes; fixture.ui.render();
  assert.equal(fixture.host.writes, writes + 1); assert.equal(fixture.host.querySelector('[data-care-status]'), null);
});

test('appointment entry reads the current appointment and proposes only date/title with explicit goal selection', async () => {
  const calls = [];
  const fixture = controller({ appointment: async (...args) => { calls.push(args); return appointment({ revision: 4, date: '2026-10-13' }); } });
  fixture.state.view = null; Object.assign(fixture.state, careData({ appointments: [appointment({ revision: 1 })] }));
  const forms = captureForms(fixture); await fixture.ui.handleAction('appointment-record', 'synthetic-appointment');
  const view = fixture.state.view;
  assert.deepEqual(calls[0], [fixture.current.centerId, fixture.current.roomId, 'synthetic-appointment', fixture.current.signal]);
  assert.equal(view.expectedRevision, 0); assert.equal(view.expectedAppointmentRevision, 4);
  assert.equal(view.values.appointmentId, 'synthetic-appointment'); assert.equal(view.values.date, '2026-10-13');
  assert.equal(view.values.title, '합성 치료 일정'); assert.equal(view.values.goalId, '');
  for (const field of ['performed', 'response', 'nextPlan', 'summary', 'privateNote']) assert.equal(view.values[field], '');
  assert.deepEqual(view.values.assessments, []); assert.equal(view.values.observation, null); assert.equal(view.values.activity, null);
  assert.match(forms.html, /연결 일정/); assert.match(forms.html, /목표를 직접 확인/); assert.match(forms.html, /value="" selected>목표를 선택해 주세요/);
});

test('appointment actions require a loaded authorized room list and therapist role before current lookup', async () => {
  for (const mode of ['missing', 'other-room', 'not-loaded', 'guardian']) {
    let reads = 0;
    const fixture = controller({ appointment: async () => { reads++; return appointment(); } });
    fixture.state.view = null; Object.assign(fixture.state, careData()); fixture.ui.display = () => {};
    if (mode === 'missing') fixture.state.appointments = [];
    if (mode === 'other-room') fixture.state.appointments = [appointment({ conversationId: 'another-room' })];
    if (mode === 'not-loaded') fixture.state.loaded = false;
    if (mode === 'guardian') fixture.current.user.centers[0].role = 'guardian';
    await fixture.ui.handleAction('appointment-record', 'synthetic-appointment');
    assert.equal(reads, 0, mode); assert.equal(fixture.state.view, null, mode);
  }
});

test('appointment-linked existing records reopen without resetting values and pin current rather than historical appointment revision', async () => {
  const saved = { ...base(), id: 'existing-record', revision: 5, conversationId: 'synthetic-room',
    appointmentId: 'synthetic-appointment', appointmentRevision: 1, referenceSources: [], date: '2026-09-01' };
  for (const entry of ['appointment-record', 'edit-record']) {
    const calls = [];
    const fixture = controller({ appointment: async (...args) => { calls.push(['appointment', args[2]]); return appointment({ revision: 8 }); },
      record: async (...args) => { calls.push(['record', args[2]]); return saved; } });
    fixture.state.view = null; Object.assign(fixture.state, careData({ records: [{ id: saved.id, appointmentId: saved.appointmentId }] }));
    if (entry === 'edit-record') fixture.state.appointments = []; // Old or rescheduled date can be outside the current list.
    const forms = captureForms(fixture); await fixture.ui.handleAction(entry, entry === 'edit-record' ? saved.id : saved.appointmentId);
    assert.equal(fixture.state.view.recordId, saved.id); assert.equal(fixture.state.view.expectedRevision, 5);
    assert.equal(fixture.state.view.expectedAppointmentRevision, 8); assert.equal(fixture.state.view.values.appointmentRevision, 1);
    assert.deepEqual(fixture.state.view.values, saved); assert.match(forms.html, /PRIVATE-CLINICAL/);
    assert.equal(calls.filter(([method]) => method === 'appointment').length, 1); assert.equal(calls.filter(([method]) => method === 'record').length, 1);
  }
});

test('mismatched appointment lookup or a changed record association cannot open an appointment record form', async () => {
  for (const next of [appointment({ id: 'another-id' }), appointment({ conversationId: 'another-room' }), appointment({ revision: 0 })]) {
    const fixture = controller({ appointment: async () => next });
    fixture.state.view = null; Object.assign(fixture.state, careData()); fixture.ui.display = () => assert.fail('must not open');
    await fixture.ui.handleAction('appointment-record', 'synthetic-appointment'); assert.equal(fixture.state.view, null);
  }
  const fixture = controller({ appointment: async () => appointment(), record: async () => ({ ...base(), id: 'r1', appointmentId: 'changed' }) });
  fixture.state.view = null; Object.assign(fixture.state, careData({ records: [{ id: 'r1', appointmentId: 'synthetic-appointment' }] }));
  fixture.ui.display = () => assert.fail('must not open'); await fixture.ui.handleAction('appointment-record', 'synthetic-appointment');
  assert.equal(fixture.state.view, null);
});

test('appointment opening is single-flight and a late appointment read cannot replace a newer room draft', async () => {
  let complete; let reads = 0;
  const fixture = controller({ appointment: async () => { reads++; return new Promise((resolve) => { complete = resolve; }); } });
  fixture.state.view = null; Object.assign(fixture.state, careData()); fixture.ui.display = () => {};
  const pending = fixture.ui.handleAction('appointment-record', 'synthetic-appointment');
  await fixture.ui.handleAction('new-record'); assert.equal(fixture.state.view, null); assert.equal(reads, 1);
  fixture.ui.suspend(); fixture.setContext({ ...fixture.current, generation: 2 });
  const replacement = fixture.ui.newRecord(fixture.state); replacement.values.title = 'NEW-CONTEXT-INPUT'; fixture.state.view = replacement;
  complete(appointment()); await pending;
  assert.equal(fixture.state.view, replacement); assert.equal(replacement.values.title, 'NEW-CONTEXT-INPUT');
});

function stubSubmit(fixture) {
  fixture.ui.snapshot = () => {}; fixture.ui.lockForm = () => {}; fixture.ui.wipeDialog = () => {};
  fixture.ui.dialog = { querySelector: () => ({ reportValidity: () => true }) };
}

for (const kind of ['record', 'feedback']) {
  test(`Seoul calendar defaults reach the ${kind} form and save without replacing a selected date`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T15:00:00Z') });
    for (const selectedDate of [null, '2024-02-29']) {
      const calls = [], save = async (...args) => { calls.push(args); };
      const fixture = controller(kind === 'record' ? { recordSave: save } : { feedbackSave: save });
      fixture.state.view = null; Object.assign(fixture.state, careData());
      if (kind === 'feedback') {
        fixture.setContext({ ...fixture.current,
          user: { userId: 'synthetic-guardian', centers: [{ id: fixture.current.centerId, role: 'guardian' }] },
          messages: [publicationMessage()] });
        fixture.ui.states.clear();
        fixture.ui.key = JSON.stringify([fixture.current.user.userId, fixture.current.centerId, fixture.current.roomId]);
        fixture.ui.states.set(fixture.ui.key, fixture.state);
      }
      const forms = captureForms(fixture);
      await fixture.ui.handleAction(kind === 'record' ? 'new-record' : 'feedback',
        kind === 'feedback' ? publicationMessage().id : undefined);
      const view = fixture.state.view;
      assert.equal(view.kind, kind); assert.equal(view.values.date, '2027-01-01');
      assert.equal(forms.open, true); assert.equal(calls.length, 0);
      const dateInput = () => forms.html.match(/<input\b[^>]*name="date"[^>]*>/)?.[0] ?? '';
      assert.match(dateInput(), /type="date"/); assert.match(dateInput(), /value="2027-01-01"/);
      if (selectedDate) {
        view.values.date = selectedDate;
        t.mock.timers.tick(86_400_000);
        fixture.ui.display();
        assert.equal(fixture.state.view, view); assert.equal(view.values.date, selectedDate);
        assert.match(dateInput(), /value="2024-02-29"/);
      }
      if (kind === 'record') view.values.performed = '합성 날짜 검증 활동';
      else view.values.reaction = '합성 날짜 검증 반응';
      stubSubmit(fixture); await fixture.ui.submit({ value: 'saved' });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 2), [fixture.current.centerId, fixture.current.roomId]);
      assert.equal(calls[0][2], kind === 'record' ? view.recordId : view.feedbackId);
      assert.equal(calls[0][3].content.date, selectedDate ?? '2027-01-01');
      assert.equal(fixture.state.mutation.operation, null); assert.equal(fixture.state.view, null);
    }
  });
}

test('appointment save and unknown retry freeze the selected current revision even after later coherent updates', async () => {
  const calls = []; let failed = false;
  const fixture = controller({ recordSave: async (...args) => { calls.push(args); if (!failed) { failed = true; throw { code: 'UNAVAILABLE' }; } } });
  Object.assign(fixture.state, careData()); fixture.state.view = fixture.ui.newRecord(fixture.state, appointment({ revision: 7 }));
  fixture.state.view.values.goalId = 'synthetic-goal'; fixture.state.view.values.performed = 'USER-CONFIRMED-ACTIVITY'; stubSubmit(fixture);
  await fixture.ui.submit({ value: 'draft' });
  const operation = fixture.state.mutation.operation;
  assert.equal(operation.body.expectedAppointmentRevision, 7); assert.equal(operation.body.content.appointmentId, 'synthetic-appointment');
  assert.equal(operation.body.expectedGoalRevision, 2); assert.equal(operation.body.content.performed, 'USER-CONFIRMED-ACTIVITY');
  fixture.setContext({ ...fixture.current, careData: careData({ appointments: [appointment({ revision: 8 })] }) }); fixture.ui.update();
  assert.equal(fixture.state.view.kind, 'receipt'); assert.equal(fixture.state.mutation.operation, operation);
  await fixture.ui.mutate(); assert.equal(calls.length, 2); assert.equal(calls[0][3], calls[1][3]);
  assert.equal(calls[1][3].expectedAppointmentRevision, 7); assert.equal(fixture.state.mutation.operation, null);
});

test('appointment saves require explicit goal choice and a pinned current revision without silently using the old record revision', async () => {
  let writes = 0; const notices = [];
  const fixture = controller({ recordSave: async () => writes++ }); Object.assign(fixture.state, careData());
  fixture.state.view = fixture.ui.newRecord(fixture.state, appointment()); stubSubmit(fixture); fixture.ui.notice = (message) => notices.push(message);
  await fixture.ui.submit({ value: 'draft' }); assert.equal(writes, 0); assert.match(notices.at(-1), /연결 목표/);
  fixture.state.view.values.goalId = 'synthetic-goal'; fixture.state.view.values.appointmentRevision = 99;
  delete fixture.state.view.expectedAppointmentRevision;
  await fixture.ui.submit({ value: 'draft' }); assert.equal(writes, 0); assert.match(notices.at(-1), /연결 일정의 현재 내용/);
  assert.equal(fixture.state.view.values.appointmentRevision, 99); assert.equal(fixture.state.mutation.operation, null);
});

test('saving an existing linked record sends the newly read appointment revision without changing original clinical values', async () => {
  const calls = [];
  const saved = { ...base(), id: 'existing-record', revision: 5, conversationId: 'synthetic-room',
    appointmentId: 'synthetic-appointment', appointmentRevision: 1, referenceSources: [] };
  const fixture = controller({ appointment: async () => appointment({ revision: 8 }), record: async () => saved,
    recordSave: async (...args) => calls.push(args) });
  fixture.state.view = null; Object.assign(fixture.state, careData()); fixture.ui.display = () => {};
  await fixture.ui.handleAction('edit-record', saved.id); stubSubmit(fixture); await fixture.ui.submit({ value: 'saved' });
  assert.equal(calls.length, 1); assert.equal(calls[0][2], saved.id);
  assert.equal(calls[0][3].expectedRevision, 5); assert.equal(calls[0][3].expectedAppointmentRevision, 8);
  assert.equal(calls[0][3].content.performed, saved.performed); assert.equal(calls[0][3].content.privateNote, saved.privateNote);
  assert.equal(saved.appointmentRevision, 1); assert.equal(saved.revision, 5);
});

test('reopened forms retain selected goal options and values from opening instead of silently adopting a later list', async () => {
  const fixture = controller({}); Object.assign(fixture.state, careData()); fixture.state.view = fixture.ui.newRecord(fixture.state);
  fixture.state.view.values.performed = 'USER INPUT'; const forms = captureForms(fixture); fixture.ui.display();
  fixture.ui.close(); fixture.setContext({ ...fixture.current, careData: careData({ goals: [{ id: 'new-goal', revision: 9, title: 'NEW-GOAL' }] }) });
  fixture.ui.update(); await fixture.state.readCheck.promise; await fixture.ui.handleAction('resume');
  assert.match(forms.html, /value="synthetic-goal" selected/); assert.equal(forms.html.includes('NEW-GOAL'), false);
  assert.match(forms.html, /USER INPUT/); assert.equal(fixture.state.view.goals[0].revision, 2);
});

test('appointment draft revalidation uses current authorization but preserves the original input and version until denial', async () => {
  let denied = false; let notifications = 0;
  const fixture = controller({ appointment: async () => { if (denied) throw { code: 'NOT_FOUND' }; return appointment({ revision: 9 }); } },
    { onSourceUnavailable: () => notifications++ });
  Object.assign(fixture.state, careData()); const view = fixture.ui.newRecord(fixture.state, appointment({ revision: 3 }));
  view.values.response = 'UNSAVED-RESPONSE'; fixture.state.view = view; const forms = captureForms(fixture); fixture.ui.display();
  const html = forms.html; assert.equal(await fixture.ui.guardView(fixture.current), true);
  assert.equal(fixture.state.view, view); assert.equal(view.expectedAppointmentRevision, 3); assert.equal(view.values.response, 'UNSAVED-RESPONSE');
  assert.equal(forms.html, html);
  denied = true; await fixture.ui.guardView(fixture.current);
  assert.equal(fixture.state.view, null); assert.equal(forms.html, ''); assert.equal(notifications, 1);
});

test('menu suspension invalidates pending record opening even when the same room receives a coherent compact update', async () => {
  let complete; const displayed = [];
  const fixture = controller({ record: async () => new Promise((resolve) => { complete = resolve; }) });
  fixture.state.view = null; fixture.setContext({ ...fixture.current, panelMode: 'records', careData: careData() });
  fixture.ui.update(); fixture.ui.display = () => displayed.push(fixture.state.view);
  const opening = fixture.ui.handleAction('edit-record', 'synthetic-record');
  fixture.ui.suspend(); fixture.setContext({ ...fixture.current, panelMode: 'compact' }); fixture.ui.update();
  complete({ ...base(), id: 'synthetic-record', conversationId: 'synthetic-room', revision: 1, referenceSources: [] }); await opening;
  assert.deepEqual(displayed, []); assert.equal(fixture.state.view, null); assert.equal(fixture.state.opening, null);
  assert.equal(fixture.state.loaded, true); assert.equal(fixture.state.goals[0].id, 'synthetic-goal');
});
