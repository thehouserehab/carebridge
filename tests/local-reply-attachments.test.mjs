import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareUi, CareMutation, careReplyContent } from '../local-api/care-ui.js';
import { MediaUploadUi, mediaUploadMarkup, MEDIA_MEMORY_FILE_LIMIT } from '../local-api/media-ui.js';
import { LocalApiError } from '../local-api/client.js';
import { MEDIA_LIMITS } from '../src/media-policy.js';

// In-memory controller/DOM doubles only. A prepared DTO is test data, not
// evidence of a scanner, server binding, filesystem or actual browser result.
const fileId = '12345678-1234-4234-8234-123456789abc';
const otherFileId = '12345678-1234-4234-8234-123456789abd';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const source = (type = 'text', extra = {}) => ({ id: 'source-1', conversationId: 'room-1', childId: 'child-1', authorId: 'other-user',
  type, body: 'SYNTHETIC-OLD-SOURCE', version: 4, canReply: true, hidden: false, deleted: false, archived: false,
  attachmentCount: 0,
  ...(type === 'publication' ? { publication: { id: 'publication-1', title: 'SYNTHETIC-OLD-SOURCE', activity: null } } : {}),
  ...(type === 'feedback' ? { feedback: { id: 'feedback-1', revision: 3, reaction: 'SYNTHETIC-OLD-SOURCE' } } : {}), ...extra });
const view = (type = 'text') => ({ kind: 'reply', replyDraftId: 'reply-draft-1', messageId: 'source-1', sourceType: type,
  sourceBody: 'SYNTHETIC-OLD-SOURCE', attachmentCount: 0, values: { body: 'SYNTHETIC-DRAFT' },
  ...(type === 'text' ? { expectedReplyVersion: 4 } : type === 'feedback' ? { expectedReplyRevision: 3, feedbackId: 'feedback-1' } : {}) });
const png = (name = 'synthetic.png') => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], name, { type: 'image/png' });
function item(id = fileId, type = 'image/png') {
  const name = type === 'image/png' ? '<synthetic>.png' : 'synthetic.mp4';
  const metadata = { name, type, size: 9 };
  return { id: `selection-${id}`, clientId: `request-${id}`, file: new File([new Uint8Array(9)], name, { type }),
    manifest: Object.freeze({ ...metadata, sha256: '0'.repeat(64) }),
    upload: { ...metadata, id, conversationId: 'room-1', mode: 'prepared-delivery', source: metadata,
      state: 'ready', version: 3, expired: false, expiresAt: '2030-01-01T00:00:00Z', failureCode: null },
    share: false, attempted: true, uncertain: false, cancelRequested: false };
}
const host = () => ({ innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [],
  replaceChildren() { this.innerHTML = ''; }, addEventListener() {}, removeEventListener() {} });
function fixture({ type = 'text', role = 'guardian', api = {}, delivery = true, callbacks = {} } = {}) {
  let current = { user: { userId: 'user-1', centers: [{ id: 'center-1', role }] }, centerId: 'center-1', roomId: 'room-1',
    profile: { conversationId: 'room-1', childId: 'child-1', participants: [] }, messages: [source(type)],
    connected: true, generation: 1, signal: new AbortController().signal, mediaDelivery: delivery };
  const calls = [], notices = [], errors = [], display = { title: '', kind: '', body: '', buttons: '' };
  const transport = { profile: async () => ({ conversationId: 'room-1', childId: 'child-1' }), message: async () => source(type),
    send: async (...args) => { calls.push(args); }, ...api };
  const ui = new CareUi({ api: transport, getContext: () => current, mediaApi: {}, deliveryEnabled: delivery,
    onError: (error) => errors.push(error.code), ...callbacks });
  ui.key = JSON.stringify(['user-1', 'center-1', 'room-1']); ui.owner = 'user-1'; ui.ownerRole = role;
  const state = { mutation: new CareMutation(() => '12345678-1234-4234-8234-123456789abe'), records: [], goals: [], appointments: [],
    loaded: true, loading: false, replyDraftId: 'reply-draft-1', view: view(type) };
  ui.states.set(ui.key, state);
  const uploadHost = host(), form = { reportValidity: () => true, querySelectorAll: () => [], querySelector: () => null, elements: [] };
  ui.dialog = { open: true, querySelector: (selector) => selector === '[data-reply-upload]' ? uploadHost : selector === 'form' ? form : null,
    querySelectorAll: () => [], close() { this.open = false; }, replaceChildren() { display.body = ''; display.buttons = ''; }, remove() {} };
  ui.form = (title, kind, body, buttons) => { ui.wipeDialog(); Object.assign(display, { title, kind, body, buttons }); ui.dialog.open = true; };
  ui.lockForm = () => {}; ui.notice = (text) => notices.push(text);
  ui.display();
  const selected = item(); if (ui.replyMedia) { ui.replyMedia.states.get(ui.replyMedia.key).items.push(selected); ui.replyMedia.render(); }
  return { ui, state, media: ui.replyMedia, item: selected, transport, calls, notices, errors, display, uploadHost, form,
    get current() { return current; }, setContext(value) { current = value; } };
}

test('reply helper accepts prepared IDs with empty body and pins exactly the relevant source version', () => {
  for (const type of ['text', 'publication', 'feedback']) {
    const files = [{ id: fileId }], result = careReplyContent(view(type), { body: '  ', attachments: [{ id: otherFileId }] }, files);
    assert.deepEqual(result, { body: '', replyTo: 'source-1',
      ...(type === 'text' ? { expectedReplyVersion: 4 } : type === 'feedback' ? { expectedReplyRevision: 3 } : {}), attachments: [{ id: fileId }] });
    files[0].id = otherFileId; assert.equal(result.attachments[0].id, fileId);
    assert.equal(Object.hasOwn(careReplyContent(view(type), { body: '  text  ' }), 'attachments'), false);
  }
});

test('reply helper rejects empty requests, invalid versions and untrusted attachment shapes', () => {
  assert.throws(() => careReplyContent(view(), { body: ' ' }));
  for (const body of [null, undefined, 4, 'a'.repeat(2001)]) assert.throws(() => careReplyContent(view(), { body }, [{ id: fileId }]));
  for (const files of [null, {}, [null], [{ id: 'wrong' }], [{ id: fileId, share: true }], [{ id: fileId, name: 'private' }],
    [{ id: fileId }, { id: fileId }], Array.from({ length: 7 }, (_, n) => ({ id: `12345678-1234-4234-8234-${String(n).padStart(12, '0')}` }))])
    assert.throws(() => careReplyContent(view(), { body: 'text' }, files));
  for (const next of [{ sourceType: 'other' }, { expectedReplyVersion: 0 }, { sourceType: 'feedback', expectedReplyRevision: null }])
    assert.throws(() => careReplyContent({ ...view(), ...next }, { body: '' }, [{ id: fileId }]));
});

for (const type of ['text', 'publication', 'feedback']) {
  test(`${type} attachment-only reply freezes a separate draft, and success forgets exactly the acknowledged IDs`, async () => {
    const gate = deferred(), calls = [], f = fixture({ type, api: { send: async (...args) => { calls.push(args); return gate.promise; } } });
    f.state.view.values.body = ''; if (type === 'feedback') f.state.view.attachments = [{ id: otherFileId, name: 'source.png', type: 'image/png', size: 9 }];
    const pending = f.ui.submit(), operation = f.state.mutation.operation;
    assert.deepEqual(operation.body.attachments, [{ id: fileId }]); assert.equal(operation.body.body, '');
    assert.equal(operation.body.replyTo, 'source-1'); assert.equal(calls[0][2], operation.body);
    assert(Object.isFrozen(operation.body)); assert(Object.isFrozen(operation.body.attachments[0]));
    assert.equal(await f.media.action('cancel', f.item.id), false); assert.equal(await f.media.select([png()]), false);
    assert.equal(f.media.setShare(f.item.id, true), false); assert(f.item.file);
    assert(!JSON.stringify(operation).includes('sha256')); assert(!JSON.stringify(operation).includes('replyDraftId'));
    const unrelated = item(otherFileId); // Independent draft is not part of this send.
    f.media.states.set(JSON.stringify(['user-1', 'center-1', 'room-1', 'other-draft']), { items: [unrelated], notice: '' });
    gate.resolve({}); await pending;
    assert.equal(f.item.file, null); assert(unrelated.file); assert.equal(f.state.view, null);
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.replyDraftId, null);
  });
}

test('unprepared, expired, uncertain or cancelling selections block reply even when text is present', async () => {
  for (const change of [{ upload: null }, { state: 'pending' }, { state: 'receiving' }, { state: 'quarantined' }, { state: 'inspecting' },
    { state: 'bound' }, { expired: true }, { expiresAt: '2000-01-01T00:00:00Z' }, { uncertain: true }, { cancelRequested: true }]) {
    const f = fixture();
    if (Object.hasOwn(change, 'upload')) f.item.upload = change.upload;
    else if (Object.hasOwn(change, 'uncertain') || Object.hasOwn(change, 'cancelRequested')) Object.assign(f.item, change);
    else Object.assign(f.item.upload, change);
    await f.ui.submit(); assert.equal(f.calls.length, 0, JSON.stringify(change));
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view.values.body, 'SYNTHETIC-DRAFT'); assert(f.item.file);
    assert(f.notices.length > 0);
  }
});

test('default quarantine/text-only UI never creates reply attachment owner or an attachment-only request', async () => {
  const f = fixture({ delivery: false });
  assert.equal(f.media, null); assert(!f.display.body.includes('data-reply-upload')); assert.match(f.display.body, /maxlength="2000" required/);
  f.state.view.values.body = ''; await f.ui.submit(); assert.equal(f.calls.length, 0);
  f.state.view.values.body = 'normal'; await f.ui.submit(); assert.equal(f.calls.length, 1); assert(!Object.hasOwn(f.calls[0][2], 'attachments'));
});

test('prepared mode still sends ordinary text replies with an empty selection and omits source attachment IDs', async () => {
  const f = fixture({ type: 'feedback' });
  f.media.states.get(f.media.key).items = [];
  f.state.view.attachments = [{ id: otherFileId, name: 'source-only.png', type: 'image/png', size: 9 }];
  assert.deepEqual(f.media.readyItems(), []); assert.deepEqual(f.media.captureAttachments(), []);
  await f.ui.submit(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][2], { body: 'SYNTHETIC-DRAFT', replyTo: 'source-1', expectedReplyRevision: 3,
    clientId: '12345678-1234-4234-8234-123456789abe' });
  assert.equal(f.state.view, null);
});

test('reply markup has separate escaped file controls and never adds original files or preview URLs', () => {
  const f = fixture(); f.state.view.sourceBody = '<PRIVATE-SOURCE>'; f.state.view.values.body = '<DRAFT>'; f.ui.display();
  assert.match(f.display.body, /&lt;PRIVATE-SOURCE&gt;/); assert.match(f.display.body, /&lt;DRAFT&gt;/);
  assert.match(f.display.body, /data-reply-upload/); assert.match(f.display.buttons, /답장 보내기/);
  assert(!/maxlength="2000" required/.test(f.display.body));
  for (const text of ['답장 사진·영상 추가', '답장 첨부 선택 합계 24개·100MB', '원문의 파일은 자동으로 첨부하지', '&lt;synthetic&gt;.png']) assert(f.uploadHost.innerHTML.includes(text));
  for (const text of ['data-media-share', '<img', '<video', 'blob:', 'sha256', 'src=']) assert(!f.uploadHost.innerHTML.includes(text));
});

test('unknown reply retries identical body/version/IDs/clientId after bound or source closure, including later 409/404', async () => {
  const calls = []; let attempt = 0;
  const f = fixture({ api: { send: async (...args) => {
    calls.push(args); attempt++;
    if (attempt === 1) throw new LocalApiError('UNAVAILABLE', 503);
    if (attempt === 2) throw new LocalApiError('PUBLICATION_CLOSED', 409);
    if (attempt === 3) throw new LocalApiError('NOT_FOUND', 404);
  } } });
  await f.ui.submit(); const operation = f.state.mutation.operation;
  assert(operation); assert.equal(f.state.mutation.everUncertain, true);
  f.transport.profile = () => assert.fail('unknown receipt must not depend on a fresh profile');
  f.transport.message = () => assert.fail('unknown must not re-read source');
  await f.ui.guardView(f.current, f.state); assert.equal(f.state.view.kind, 'receipt');
  assert(!f.display.body.includes('SYNTHETIC-OLD-SOURCE')); assert(!f.display.body.includes('SYNTHETIC-DRAFT')); assert(!f.display.body.includes('data-reply-upload'));
  Object.assign(f.item.upload, { state: 'bound', expiresAt: null });
  f.media.captureAttachments = () => assert.fail('must not recapture ready IDs');
  for (let n = 0; n < 2; n++) {
    await f.ui.mutate(); assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.view.kind, 'receipt');
    assert(f.item.file); assert.equal(f.ui.discard(), false); assert.equal(await f.media.action('cancel', f.item.id), false);
  }
  await f.ui.mutate(); assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call[2], operation.body);
  assert.equal(f.item.file, null); assert.equal(f.state.view, null); assert.deepEqual(f.errors, []);
});

test('first definite rejection without receipt retains editable text/files and failed cancel preserves its identity', async () => {
  for (const code of ['UPLOAD_EXPIRED', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT']) {
    const f = fixture({ api: { send: async () => { throw new LocalApiError(code, 409); } } });
    const original = f.state.view; await f.ui.submit();
    assert.equal(f.state.view, original); assert.equal(f.state.mutation.operation, null); assert(f.item.file);
    f.media.api.get = async () => f.item.upload;
    f.media.api.cancel = async () => { throw new LocalApiError('UNAVAILABLE'); };
    assert.equal(await f.media.action('cancel', f.item.id), false); assert(f.item.file);
    assert.equal(f.item.cancelRequested, true); assert.equal(f.ui.discard(), false);
  }
});

test('non-409 media errors are not classified as definite no-write outcomes', async () => {
  for (const status of [0, 500, 503]) {
    const f = fixture({ api: { send: async () => { throw new LocalApiError('ATTACHMENT_NOT_READY', status); } } });
    await f.ui.submit(); assert(f.state.mutation.operation); assert(f.state.mutation.everUncertain); assert(f.item.file);
  }
});

test('poll receipt followed by first rejection restores pinned reply input and files only after fresh room and source checks', async () => {
  for (const type of ['text', 'publication', 'feedback']) {
    const gate = deferred(), permission = deferred(), reads = [], calls = [];
    const f = fixture({ type, api: { send: (...args) => { calls.push(args); return gate.promise; },
      profile: async () => { reads.push('profile'); return permission.promise; },
      message: async () => { reads.push('source'); return source(type, { body: 'NEW-CURRENT-BODY', version: 5 }); } } });
    const original = f.state.view, before = structuredClone(original), file = f.item.file;
    const pending = f.ui.submit(), operation = f.state.mutation.operation;
    await f.ui.guardView(f.current, f.state); assert.equal(f.state.view.kind, 'receipt');
    gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await tick();
    assert.equal(f.ui.dialog.open, false); assert.equal(f.display.body, ''); assert.equal(f.state.view, original);
    const poll = f.ui.guardView(f.current, f.state); assert.deepEqual(reads, ['profile']);
    permission.resolve(f.current.profile); await Promise.all([pending, poll]);
    assert.equal(f.state.view, original); assert.deepEqual(original.values, before.values);
    assert.equal(original.sourceBody, before.sourceBody); assert.equal(original.expectedReplyVersion, before.expectedReplyVersion);
    assert.equal(original.expectedReplyRevision, before.expectedReplyRevision); assert.equal(f.item.file, file);
    assert.deepEqual(reads, ['profile', 'source']); assert.equal(f.state.mutation.operation, null);
    assert.equal(f.display.kind, 'reply'); assert.match(f.display.body, /SYNTHETIC-DRAFT/);
    assert(!f.display.body.includes('NEW-CURRENT-BODY')); assert.match(f.uploadHost.innerHTML, /type="file"/);
    assert.deepEqual(f.media.captureAttachments(), [{ id: fileId }]); assert.equal(calls.length, 1);
    f.state.mutation.createId = () => '12345678-1234-4234-8234-123456789abf';
    f.transport.send = async (...args) => calls.push(args);
    await f.ui.submit(); assert.equal(calls.length, 2);
    assert.notEqual(calls[1][2].clientId, operation.body.clientId);
    assert.equal(calls[1][2].body, operation.body.body); assert.deepEqual(calls[1][2].attachments, operation.body.attachments);
    assert.equal(f.item.file, null);
  }
});

test('denied recovery room authorization wipes selections; transient read failure retains only an undisplayed draft', async () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN', 'AUTH_REQUIRED', 'UNAVAILABLE']) {
    const gate = deferred(), f = fixture({ api: { send: () => gate.promise, profile: async () => { throw new LocalApiError(code); } } });
    const original = f.state.view;
    const pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
    gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await pending;
    assert.equal(f.display.body, ''); assert.equal(f.ui.dialog?.open ?? false, false);
    if (code !== 'UNAVAILABLE') { assert.equal(f.ui.states.size, 0); assert.equal(f.item.file, null); assert(f.errors.includes(code)); }
    else {
      assert.equal(f.state.view, original); assert(f.item.file); assert.equal(f.state.mutation.operation, null);
      f.transport.profile = async () => ({ conversationId: 'room-1', childId: 'child-1' });
      await f.ui.handleAction('resume'); assert.equal(f.ui.dialog.open, true); assert.equal(f.display.kind, 'reply');
      assert.match(f.display.body, /SYNTHETIC-DRAFT/); assert.equal(f.calls.length, 0);
    }
  }
});

test('a mismatched fresh child projection cannot restore reply input or retained files', async () => {
  const gate = deferred(), f = fixture({ api: { send: () => gate.promise,
    profile: async () => ({ conversationId: 'room-1', childId: 'different-child' }),
    message: () => assert.fail('source must not be read after a rejected room projection') } });
  const pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
  gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await pending;
  assert.equal(f.ui.states.size, 0); assert.equal(f.media.states.size, 0); assert.equal(f.item.file, null);
  assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.body, ''); assert(f.errors.includes('FORBIDDEN'));
});

test('transient source failure after a valid recovery profile retains the hidden draft until explicit fresh resume', async () => {
  const gate = deferred(), reads = [], f = fixture({ api: { send: () => gate.promise,
    profile: async () => { reads.push('profile'); return { conversationId: 'room-1', childId: 'child-1' }; },
    message: async () => { reads.push('source-failed'); throw new LocalApiError('UNAVAILABLE', 503); } } });
  const original = f.state.view, file = f.item.file, values = structuredClone(original.values);
  const pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
  gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await pending;
  assert.equal(f.state.view, original); assert.deepEqual(original.values, values); assert.equal(f.item.file, file);
  assert.equal(f.state.mutation.operation, null); assert.equal(f.ui.dialog.open, false); assert.equal(f.display.body, '');
  assert.deepEqual(reads, ['profile', 'source-failed']);
  f.transport.message = async () => { reads.push('source-current'); return source('text', { version: 5, body: 'NEW-CURRENT-BODY' }); };
  await f.ui.handleAction('resume');
  assert.deepEqual(reads, ['profile', 'source-failed', 'profile', 'source-current']);
  assert.equal(f.state.view, original); assert.equal(original.expectedReplyVersion, 4);
  assert.equal(f.display.kind, 'reply'); assert.match(f.display.body, /SYNTHETIC-DRAFT/);
  assert(!f.display.body.includes('NEW-CURRENT-BODY')); assert.deepEqual(f.media.captureAttachments(), [{ id: fileId }]);
});

for (const outcome of ['allowed', 'denied']) {
  test(`a pre-submission ${outcome} source response cannot replace the new recovery permission check`, async () => {
    const oldSource = deferred(), write = deferred(), permission = deferred(), reads = [];
    let sourceReads = 0, unavailable = 0;
    const f = fixture({ callbacks: { onSourceUnavailable: () => { unavailable++; } }, api: {
      send: () => write.promise,
      profile: async () => { reads.push('fresh-profile'); return permission.promise; },
      message: async () => { sourceReads++; reads.push(`source-${sourceReads}`); return sourceReads === 1 ? oldSource.promise : source(); },
    } });
    const original = f.state.view, file = f.item.file;
    const oldCheck = f.ui.guardView(f.current, f.state), firstCheck = f.state.readCheck;
    assert.deepEqual(reads, ['source-1']);
    const pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
    assert.equal(f.state.view.kind, 'receipt');
    write.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await tick();
    assert.equal(f.state.view, original); assert.notEqual(f.state.readCheck, firstCheck);
    assert.deepEqual(reads, ['source-1', 'fresh-profile']); assert.equal(f.display.body, '');
    if (outcome === 'allowed') oldSource.resolve(source());
    else oldSource.reject(new LocalApiError('NOT_FOUND', 404));
    assert.equal(await oldCheck, false);
    assert.equal(f.state.view, original); assert.equal(f.item.file, file); assert.equal(f.display.body, '');
    assert.equal(unavailable, 0); assert.deepEqual(f.errors, []);
    permission.resolve(f.current.profile); await pending;
    assert.deepEqual(reads, ['source-1', 'fresh-profile', 'source-2']); assert.equal(f.state.view, original);
    assert.equal(f.display.kind, 'reply'); assert.match(f.display.body, /SYNTHETIC-DRAFT/);
    assert.equal(f.item.file, file); assert.equal(f.state.mutation.operation, null);
  });
}

test('late recovery profile success cannot reopen a draft after room, account or role transition', async () => {
  for (const transition of ['room', 'account', 'role']) {
    const write = deferred(), permission = deferred(), f = fixture({ api: { send: () => write.promise,
      profile: () => permission.promise } });
    const before = f.current, pending = f.ui.submit(); await f.ui.guardView(before, f.state);
    write.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await tick();
    assert.equal(f.display.body, ''); assert.equal(f.ui.dialog.open, false);
    f.ui.suspend();
    const next = { ...before, generation: before.generation + 1, careData: { goals: [], records: [], appointments: [] },
      ...(transition === 'room' ? { roomId: 'room-2', profile: { conversationId: 'room-2', childId: 'child-2' } } : {}),
      ...(transition === 'account' ? { user: { userId: 'other-user', centers: [{ id: 'center-1', role: 'guardian' }] } } : {}),
      ...(transition === 'role' ? { user: { userId: 'user-1', centers: [{ id: 'center-1', role: 'therapist' }] } } : {}) };
    f.setContext(next); f.ui.update(next);
    permission.resolve(before.profile); await pending;
    assert.equal(f.ui.dialog?.open ?? false, false, transition); assert.equal(f.display.body, '', transition);
    assert.equal(f.ui.state().view, null, transition); assert.deepEqual(f.errors, [], transition);
    if (transition === 'room') assert(f.item.file); // Only the original room may resume its draft.
    else { assert.equal(f.item.file, null); assert.equal(f.media.states.size, 0); }
    f.ui.clear();
  }
});

test('first no-write recovery with a now-hidden source preserves only source-free cancelable reply selections', async () => {
  const gate = deferred(), f = fixture({ api: { send: () => gate.promise, message: async () => source('text', { hidden: true }) } });
  const pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
  gate.reject(new LocalApiError('ATTACHMENT_NOT_READY', 409)); await pending;
  assert.deepEqual(f.state.view, { kind: 'reply-cleanup', replyDraftId: 'reply-draft-1', values: {},
    error: '현재 읽을 수 없는 원문에 연결된 입력을 닫았어요. 저장된 자료는 변경하지 않았습니다.' });
  assert.equal(f.state.mutation.operation, null); assert(f.item.file); assert.equal(f.display.body, '');
  await f.ui.handleAction('resume'); assert.equal(f.display.kind, 'reply-cleanup');
  for (const text of ['SYNTHETIC-OLD-SOURCE', 'SYNTHETIC-DRAFT', 'name="body"']) assert(!f.display.body.includes(text));
  for (const text of ['type="file"', 'data-media-share', 'data-media-action="upload"']) assert(!f.uploadHost.innerHTML.includes(text));
  assert.equal(await f.media.select([png()]), false); assert.throws(() => f.media.captureAttachments()); assert.equal(f.ui.discard(), false);
  f.media.api.get = async () => f.item.upload;
  f.media.api.cancel = async () => ({ ...f.item.upload, state: 'delete_pending', version: 4 });
  assert.equal(await f.media.action('cancel', f.item.id), true); assert.equal(f.item.file, null);
  assert.equal(f.ui.discard(), true); assert.equal(f.state.view, null); assert.equal(f.state.replyDraftId, null);
});

test('text-only reply survives first validation rejection after polling without creating upload cleanup', async () => {
  const gate = deferred(), f = fixture({ delivery: false, api: { send: () => gate.promise } });
  const original = f.state.view, pending = f.ui.submit(); await f.ui.guardView(f.current, f.state);
  gate.reject(new LocalApiError('INVALID_INPUT', 400)); await pending;
  assert.equal(f.state.view, original); assert.equal(f.state.mutation.operation, null); assert.equal(f.display.kind, 'reply');
  assert.match(f.display.body, /SYNTHETIC-DRAFT/); assert(!f.display.body.includes('data-reply-upload'));
});

test('source hide/withdrawal immediately removes quote/input and retains only authorized upload cleanup', async () => {
  for (const changed of [{ hidden: true }, { deleted: true }, { archived: true }, { canReply: false }]) {
    let notification = 0; const f = fixture({ type: 'publication', callbacks: { onSourceUnavailable: () => {
      notification++; assert.equal(f.display.body, ''); assert.equal(f.ui.dialog.open, false);
    } } });
    f.transport.message = async () => source('publication', changed);
    await f.ui.guardView(f.current, f.state);
    assert.equal(notification, 1); assert.equal(f.state.view.kind, 'reply-cleanup'); assert(f.item.file);
    assert.equal(Object.hasOwn(f.state.view, 'messageId'), false); assert.equal(Object.hasOwn(f.state.view, 'sourceBody'), false);
    await f.ui.handleAction('resume'); assert.equal(f.display.kind, 'reply-cleanup'); assert(!f.display.body.includes('SYNTHETIC'));
    f.ui.retainRooms('user-1', 'center-1', []); assert.equal(f.item.file, null); assert.equal(f.media.states.size, 0); assert.equal(f.ui.states.size, 0);
  }
});

test('first closed-publication rejection also removes source immediately without waiting for a poll', async () => {
  const f = fixture({ type: 'publication', api: { send: async () => { throw new LocalApiError('PUBLICATION_CLOSED', 409); } } });
  await f.ui.submit(); assert.equal(f.state.view.kind, 'reply-cleanup'); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.display.body, ''); assert(f.item.file);
});

test('a failed source refresh does not claim deletion and resumes the same draft after a valid read', async () => {
  const f = fixture({ api: { message: async () => { throw new LocalApiError('UNAVAILABLE'); } } });
  const original = f.state.view; await f.ui.guardView(f.current, f.state);
  assert.equal(f.state.view, original); assert.equal(f.display.body, ''); assert(f.item.file);
  f.transport.message = async () => source(); await f.ui.handleAction('resume');
  assert.equal(f.state.view, original); assert.match(f.display.body, /SYNTHETIC-DRAFT/);
  assert.deepEqual(f.media.captureAttachments(), [{ id: fileId }]);
});

test('fresh reply creation checks current capability and gives every discarded source draft a new selection key', async () => {
  const f = fixture(); f.media.states.clear(); f.state.view = null;
  await f.ui.handleAction('reply', 'source-1'); const first = f.state.view.replyDraftId;
  assert.match(first, /^[a-f0-9-]{36}$/); assert.equal(f.media.states.get(f.media.key).items.length, 0);
  assert.equal(f.ui.discard(), true);
  f.current.messages = [source('publication', { id: 'source-2' })];
  f.transport.message = async () => source('publication', { id: 'source-2' });
  await f.ui.handleAction('reply', 'source-2'); assert.notEqual(f.state.view.replyDraftId, first);
  assert.equal(f.state.view.messageId, 'source-2'); assert.equal(f.media.states.get(f.media.key).items.length, 0);
  f.ui.discard(); f.transport.message = async () => source('publication', { id: 'source-2', canReply: false });
  await f.ui.handleAction('reply', 'source-2'); assert.equal(f.state.view, null);
});

test('close and room navigation retain the original draft/files without mixing another room or media owner', async () => {
  const f = fixture(), originalContext = f.current, original = f.state.view, originalKey = f.media.key;
  f.ui.close(); assert.equal(f.uploadHost.innerHTML, ''); assert(f.item.file);
  f.ui.suspend(); f.setContext({ ...originalContext, roomId: 'room-2', profile: { conversationId: 'room-2', childId: 'child-2' } });
  f.ui.key = JSON.stringify(['user-1', 'center-1', 'room-2']);
  f.ui.states.set(f.ui.key, { ...f.state, mutation: new CareMutation(), view: { ...view(), replyDraftId: 'room-two-draft' }, replyDraftId: 'room-two-draft' });
  f.ui.display(); assert.equal(f.media.states.get(f.media.key).items.length, 0); assert.notEqual(f.media.key, originalKey);
  assert.equal(f.ui.recordMedia.states.size, 0); assert.equal(f.ui.feedbackMedia.states.size, 0);
  f.ui.suspend(); f.setContext(originalContext); f.ui.key = JSON.stringify(['user-1', 'center-1', 'room-1']);
  await f.ui.handleAction('resume'); assert.equal(f.state.view, original); assert.equal(f.media.key, originalKey);
  assert.deepEqual(f.media.captureAttachments(), [{ id: fileId }]); assert(f.item.file);
});

test('late source reads or upload responses cannot reinsert a revoked room or changed account', async () => {
  const sourceGate = deferred(), f = fixture({ api: { message: () => sourceGate.promise } });
  const pending = f.ui.guardView(f.current, f.state); f.ui.retainRooms('user-1', 'center-1', []);
  sourceGate.resolve(source()); await pending; assert.equal(f.ui.states.size, 0); assert.equal(f.item.file, null); assert.equal(f.display.body, '');
  const g = fixture(), uploadGate = deferred(); g.media.api.get = () => uploadGate.promise;
  const uploading = g.media.action('refresh', g.item.id); g.ui.clear();
  g.setContext({ ...g.current, user: { userId: 'other-account', centers: [{ id: 'center-1', role: 'guardian' }] } });
  uploadGate.resolve(g.item.upload); assert.equal(await uploading, false); assert.equal(g.media.states.size, 0); assert.equal(g.item.file, null);
});

test('late successful send after suspension keeps immutable receipt work instead of clearing another draft', async () => {
  const gate = deferred(), calls = [], f = fixture({ api: { send: async (...args) => { calls.push(args); if (calls.length === 1) return gate.promise; } } });
  const pending = f.ui.submit(), operation = f.state.mutation.operation;
  f.ui.suspend(); gate.resolve({}); await pending;
  assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.view.kind, 'receipt'); assert(f.item.file);
  await f.ui.handleAction('resume'); await f.ui.mutate();
  assert.equal(calls[1][2], operation.body); assert.equal(f.item.file, null); assert.equal(f.state.view, null);
});

test('body snapshot is preserved with the upload list when the reply form closes', () => {
  const f = fixture(); f.form.elements = [{ name: 'body', type: 'textarea', value: 'EDITED BEFORE CLOSE' }, { name: '', type: 'file', value: '' }];
  f.ui.close(); assert.equal(f.state.view.values.body, 'EDITED BEFORE CLOSE'); assert(f.item.file); assert.equal(f.display.body, '');
});

test('reply media respects per-draft and per-owner count/byte limits without borrowing composer selections', async () => {
  const f = fixture(); f.media.states.get(f.media.key).items = [];
  assert.equal(await f.media.select(Array.from({ length: MEDIA_LIMITS.count }, () => png())), true);
  assert.equal(await f.media.select([png()]), false); assert.equal(f.media.states.get(f.media.key).items.length, 6);
  for (let n = 0; n < 3; n++) f.media.states.set(JSON.stringify(['user-1', 'center-1', 'room-1', `other-${n}`]), { items: Array.from({ length: 6 }, () => item()), notice: '' });
  const freshKey = JSON.stringify(['user-1', 'center-1', 'room-1', 'fresh']);
  f.state.view.replyDraftId = 'fresh'; f.state.replyDraftId = 'fresh'; f.media.update();
  assert.equal([...f.media.states.values()].reduce((sum, state) => sum + state.items.length, 0), MEDIA_MEMORY_FILE_LIMIT);
  assert.equal(await f.media.select([png()]), false); assert.equal(f.media.states.get(freshKey).items.length, 0);
  f.media.states.clear(); f.media.states.set(freshKey, { items: [], notice: '' });
  const large = item(); large.manifest = { ...large.manifest, size: MEDIA_LIMITS.total };
  f.media.states.set(JSON.stringify(['user-1', 'center-1', 'room-2', 'large']), { items: [large], notice: '' });
  assert.equal(await f.media.select([png()]), false);
  const composer = new MediaUploadUi({ api: {}, getContext: () => f.current, deliveryEnabled: true }); composer.bind(host()); composer.update();
  assert.equal(await composer.select([png()]), true); assert.equal(f.media.states.get(freshKey).items.length, 0);
  f.ui.clear(); composer.clear(); await tick();
});

test('cleanup markup has status/cancel only and never a sharing checkbox or upload action', () => {
  const html = mediaUploadMarkup({ items: [item()] }, false, true, true, false, 'reply', true);
  assert.match(html, /data-media-action="refresh"/); assert.match(html, /data-media-action="cancel"/);
  for (const text of ['type="file"', 'data-media-action="upload"', 'data-media-share']) assert(!html.includes(text));
});
