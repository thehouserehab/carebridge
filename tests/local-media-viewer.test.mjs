import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MediaViewer } from '../local-api/media-viewer.js';
import { LocalApiError } from '../local-api/client.js';

// DOM/transport doubles verify ownership and permission ordering only. No
// native inspection, actual browser decoding or authenticated HTTP is claimed.
const file = Object.freeze({ id: '12345678-1234-4234-8234-123456789abc', name: 'synthetic.png', type: 'image/png', size: 4 });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { resolve, promise }; };
function harness(t, metadata = file) {
  let context = { user: { userId: 'synthetic-user' }, centerId: 'synthetic-center', roomId: 'synthetic-room',
    connected: true, enabled: true, visible: true, generation: 1, signal: new AbortController().signal };
  const events = [], errors = [], errorSources = [], created = [], revoked = [], nodes = [];
  const element = (tag) => {
    const listeners = new Map(), n = { tagName: tag.toUpperCase(), attrs: {}, textContent: '', isConnected: true,
      addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
      emit(type, value = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...value };
        for (const fn of listeners.get(type) ?? []) fn(event); return event; },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; if (name === 'src') { this.src = ''; events.push('src-removed'); } },
      querySelectorAll() { return []; }, remove() { this.isConnected = false; events.push('removed'); },
      focus() { doc.activeElement = this; events.push('focus'); },
    };
    if (tag === 'video') { n.pause = () => events.push('pause'); n.load = () => events.push('load'); }
    nodes.push(n); return n;
  };
  const doc = { activeElement: null, createElement: element };
  const opener = element('button'); doc.activeElement = opener;
  let html = '', dialog = null, controls = null;
  const host = { ownerDocument: doc,
    get innerHTML() { return html; }, set innerHTML(value) {
      html = value; dialog = element('dialog'); dialog.open = false;
      controls = { close: element('button'), name: element('p'), status: element('p'), content: { children: [], append(value) { this.children.push(value); } } };
      dialog.showModal = () => { dialog.open = true; events.push('show'); };
      dialog.close = () => { dialog.open = false; events.push('dialog-close'); dialog.emit('close'); };
      dialog.getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 110 });
      dialog.querySelector = (selector) => controls[selector.match(/data-media-viewer-(.*)\]/)?.[1]] ?? null;
    },
    querySelector: () => dialog,
    replaceChildren() { html = ''; for (const node of nodes) if (node !== opener) node.isConnected = false; },
  };
  const message = (changes = {}) => ({ id: 'synthetic-message', conversationId: 'synthetic-room', hidden: false, deleted: false, attachments: [metadata], ...changes });
  const api = { message: async (...args) => { events.push('message'); return message(); } };
  const mediaApi = { openMessageAttachment: async (...args) => { events.push('read'); return new Blob([new Uint8Array(metadata.size)], { type: metadata.type }); } };
  t.mock.method(URL, 'createObjectURL', (blob) => { events.push('create-url'); created.push(blob); return 'blob:synthetic-test'; });
  t.mock.method(URL, 'revokeObjectURL', (url) => { events.push('revoke-url'); revoked.push(url); });
  const viewer = new MediaViewer({ api, mediaApi, getContext: () => context, onError: (e, source) => { errors.push(e); errorSources.push(source); } }); viewer.bind(host);
  return { viewer, api, mediaApi, host, doc, opener, events, errors, errorSources, created, revoked, message,
    dialog: () => dialog, controls: () => controls, setContext: (next) => { context = { ...context, ...next }; }, context: () => context,
    open: () => viewer.open('synthetic-message', metadata.id) };
}

test('viewer is unavailable in default quarantine, hidden, disconnected or missing-account contexts', async (t) => {
  const h = harness(t);
  for (const change of [{ enabled: false }, { enabled: true, visible: false }, { visible: true, connected: false }, { connected: true, user: null }]) {
    h.setContext(change); assert.equal(await h.open(), false); assert.equal(h.host.innerHTML, '');
  }
  assert.equal(h.created.length, 0); assert(!h.events.includes('message')); assert(!h.events.includes('read'));
});

test('image URL is created only after both fresh anchor checks and a matching bounded Blob', async (t) => {
  const metadata = { ...file, name: '<img onerror="synthetic">.png' }, h = harness(t, metadata);
  const captured = [];
  h.mediaApi.openMessageAttachment = async (scope, id, attachment, signal) => {
    captured.push({ scope, id, attachment, signal }); h.events.push('read');
    assert(Object.isFrozen(scope)); assert(Object.isFrozen(attachment)); assert.equal(h.created.length, 0);
    return new Blob([new Uint8Array(4)], { type: metadata.type });
  };
  assert.equal(await h.open(), true);
  assert.deepEqual(h.events.filter((e) => ['message', 'read', 'create-url'].includes(e)), ['message', 'read', 'message', 'create-url']);
  assert.deepEqual(captured[0].scope, { userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' });
  assert.deepEqual(captured[0].attachment, metadata); assert.equal(h.viewer.media.tagName, 'IMG');
  assert.equal(h.viewer.media.alt, metadata.name); assert.equal(h.controls().name.textContent, metadata.name);
  assert(!h.host.innerHTML.includes('<img onerror')); assert.equal(h.doc.activeElement, h.controls().close);
  h.viewer.clear(); assert.equal(h.revoked.length, 1);
});

test('video has native controls but no autoplay and close pauses, detaches, loads and revokes before focus return', async (t) => {
  const h = harness(t, { ...file, name: 'synthetic.mp4', type: 'video/mp4' }); await h.open();
  const media = h.viewer.media, signal = h.viewer.operation.signal;
  assert.equal(media.controls, true); assert.equal(media.playsInline, true); assert.equal(media.preload, 'metadata'); assert.notEqual(media.autoplay, true);
  h.events.length = 0; h.controls().close.emit('click');
  assert.deepEqual(h.events, ['pause', 'src-removed', 'load', 'removed', 'revoke-url', 'dialog-close', 'focus']);
  assert(signal.aborted); assert.equal(h.host.innerHTML, ''); assert.equal(h.doc.activeElement, h.opener);
  h.viewer.clear(); assert.equal(h.revoked.length, 1);
});

test('explicit close notifies its owner once only after clearing the authorized viewer and before focus return', async (t) => {
  const h = harness(t), calls = [];
  h.viewer.onClose = source => {
    assert.equal(h.viewer.operation, null); assert.equal(h.viewer.media, null);
    assert.equal(h.host.innerHTML, ''); assert.equal(h.revoked.length, 1);
    assert.notEqual(h.doc.activeElement, h.opener);
    calls.push(source);
  };
  await h.open(); h.viewer.close(); h.viewer.close();
  assert.deepEqual(calls, [{ kind: 'message', messageId: 'synthetic-message' }]);
  assert(Object.isFrozen(calls[0])); assert.equal(h.doc.activeElement, h.opener);
});

test('explicit close while loading restores its owner without waiting for or accepting late metadata', async (t) => {
  const h = harness(t), gate = deferred(), started = deferred(), calls = [];
  h.api.message = async () => { started.resolve(); await gate.promise; return h.message(); };
  h.viewer.onClose = source => calls.push(source);
  const pending = h.open(); await started.promise; const signal = h.viewer.operation.signal;
  h.viewer.close(); assert(signal.aborted); assert.equal(calls.length, 1);
  gate.resolve(); assert.equal(await pending, false); assert.equal(calls.length, 1);
  assert.equal(h.created.length, 0); assert(!h.events.includes('read'));
});

test('scope, generation and visibility loss never notify the close owner or restore its old UI', async (t) => {
  for (const change of [{ user: { userId: 'other-user' } }, { centerId: 'other-center' }, { roomId: 'other-room' },
    { generation: 2 }, { connected: false }, { visible: false }, { enabled: false }]) {
    const h = harness(t); let calls = 0;
    h.viewer.onClose = () => calls++;
    await h.open(); h.setContext(change); h.viewer.close();
    assert.equal(calls, 0); assert.equal(h.host.innerHTML, ''); assert.equal(h.revoked.length, 1);
  }
});

test('clear, suspend, context abort, revoked anchor and denied GET are not ordinary close notifications', async (t) => {
  for (const boundary of ['clear', 'suspend', 'abort', 'anchor', 'denied']) {
    const h = harness(t), lifetime = new AbortController(); let calls = 0;
    h.viewer.onClose = () => calls++; h.setContext({ signal: lifetime.signal });
    if (boundary === 'denied') h.api.message = async () => { throw new LocalApiError('NOT_FOUND', 404); };
    await h.open();
    if (boundary === 'clear') h.viewer.clear();
    if (boundary === 'suspend') h.viewer.suspend();
    if (boundary === 'abort') lifetime.abort();
    if (boundary === 'anchor') h.viewer.reconcile([]);
    h.viewer.close(); assert.equal(calls, 0); assert.equal(h.host.innerHTML, '');
  }
});

test('application close hook rehydrates only a visible connected chat from its current coherent snapshot', async () => {
  const source = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
  const hook = source.match(/function restoreCareAfterMediaClose\(source\) \{[\s\S]*?\n\}/)?.[0];
  assert(hook); assert.match(source, /onClose: restoreCareAfterMediaClose/);
  const document = { visibilityState: 'visible' }, navigator = { onLine: true }, calls = [];
  let context = { enabled: true, visible: true, connected: true, signal: new AbortController().signal, careData: { current: true } };
  const close = vm.runInNewContext(`(${hook})`, { document, navigator, getMediaContext: () => context, care: { update: value => calls.push(value) } });
  close({ kind: 'message' }); assert.equal(calls.length, 1); assert.equal(calls[0], context);
  for (const kind of ['record', 'feedback', 'record-reference', 'current-reference', undefined]) close({ kind });
  close(null); assert.equal(calls.length, 1);
  for (const change of [{ enabled: false }, { visible: false }, { connected: false }, { signal: AbortSignal.abort() }]) {
    const previous = context; context = { ...context, ...change }; close({ kind: 'message' }); context = previous;
  }
  document.visibilityState = 'hidden'; close({ kind: 'message' }); document.visibilityState = 'visible';
  navigator.onLine = false; close({ kind: 'message' });
  assert.equal(calls.length, 1);
});

test('hidden, deleted, absent, duplicate or malformed anchor attachments never start the content read', async (t) => {
  const h = harness(t);
  for (const change of [{ hidden: true }, { deleted: true }, { attachments: [] }, { attachments: [file, file] },
    { attachments: [{ ...file, size: 0 }] }, { conversationId: 'foreign-room' }]) {
    h.api.message = async () => h.message(change); assert.equal(await h.open(), false);
  }
  assert.equal(h.created.length, 0); assert(!h.events.includes('read'));
  assert(h.errors.every((e) => e instanceof LocalApiError));
});

test('revoked permission or changed attachment after download never becomes a readable URL', async (t) => {
  const h = harness(t);
  for (const after of ['denied', 'hidden', 'changed']) {
    let reads = 0;
    h.api.message = async () => {
      if (++reads === 1) return h.message();
      if (after === 'denied') throw new LocalApiError('NOT_FOUND', 404);
      return h.message(after === 'hidden' ? { hidden: true } : { attachments: [{ ...file, size: 3 }] });
    };
    assert.equal(await h.open(), false); assert.equal(h.host.innerHTML, '');
  }
  assert.equal(h.created.length, 0); assert.equal(h.revoked.length, 0);
});

test('wrong MIME, length, and raw read errors expose neither bytes nor transport diagnostics', async (t) => {
  const h = harness(t);
  for (const value of [new Blob(['abcd'], { type: 'text/html' }), new Blob(['abc'], { type: file.type }), null]) {
    h.mediaApi.openMessageAttachment = async () => { if (value === null) throw new Error('PRIVATE-TOKEN-OR-PATH'); return value; };
    assert.equal(await h.open(), false); assert.equal(h.created.length, 0);
    assert(!h.host.innerHTML.includes('PRIVATE')); assert(!h.errors.at(-1).message.includes('PRIVATE'));
    assert.equal(h.controls().status.textContent, '파일을 열지 못했어요. 닫은 뒤 다시 확인해 주세요.');
  }
  h.viewer.clear();
});

test('account, room or generation changes during an in-flight read discard its late bytes', async (t) => {
  const h = harness(t);
  for (const change of [{ user: { userId: 'other-user' } }, { roomId: 'other-room' }, { generation: 2 }]) {
    h.setContext({ user: { userId: 'synthetic-user' }, roomId: 'synthetic-room', generation: 1 });
    const started = deferred(), gate = deferred();
    h.mediaApi.openMessageAttachment = async () => { started.resolve(); await gate.promise; return new Blob(['1234'], { type: file.type }); };
    const pending = h.open(); await started.promise; h.setContext(change); gate.resolve();
    assert.equal(await pending, false); assert.equal(h.host.innerHTML, ''); assert.equal(h.created.length, 0);
  }
});

test('context signal abort and suspend actively abort late reads and cannot restore a cleared dialog', async (t) => {
  const h = harness(t);
  for (const abortContext of [false, true]) {
    const lifetime = new AbortController(); h.setContext({ signal: lifetime.signal });
    const started = deferred(), gate = deferred(); let receivedSignal;
    h.mediaApi.openMessageAttachment = async (_scope, _id, _file, signal) => { receivedSignal = signal; started.resolve(); await gate.promise; return new Blob(['1234'], { type: file.type }); };
    const pending = h.open(); await started.promise;
    if (abortContext) lifetime.abort(); else h.viewer.suspend();
    assert(receivedSignal.aborted); assert.equal(h.host.innerHTML, ''); gate.resolve();
    assert.equal(await pending, false); assert.equal(h.created.length, 0);
  }
});

test('reconcile keeps an unchanged attachment but closes every missing, hidden or metadata-changed anchor', async (t) => {
  const h = harness(t);
  for (const change of [[], [h.message({ hidden: true })], [h.message({ deleted: true })], [h.message({ attachments: [] })],
    [h.message({ attachments: [{ ...file, name: 'changed.png' }] })]]) {
    assert.equal(await h.open(), true);
    const media = h.viewer.media;
    h.viewer.reconcile([h.message({ body: 'edited text', version: 2 })]); assert.equal(h.viewer.media, media);
    const before = h.revoked.length; h.viewer.reconcile(change);
    assert.equal(h.host.innerHTML, ''); assert.equal(h.viewer.media, null); assert.equal(h.revoked.length, before + 1);
  }
});

test('reconcile revocation during initial anchor query prevents even a late content request', async (t) => {
  const h = harness(t), started = deferred(), gate = deferred();
  h.api.message = async () => { started.resolve(); await gate.promise; return h.message(); };
  const pending = h.open(); await started.promise; h.viewer.reconcile([]); gate.resolve();
  assert.equal(await pending, false); assert(!h.events.includes('read')); assert.equal(h.created.length, 0);
});

test('Escape and only true backdrop clicks close accessibly; navigation never steals focus', async (t) => {
  const h = harness(t); await h.open();
  h.dialog().emit('click', { clientX: 20, clientY: 20 }); assert(h.viewer.operation);
  h.dialog().emit('click', { target: h.controls().content, clientX: 0, clientY: 0 }); assert(h.viewer.operation);
  const escaped = h.dialog().emit('cancel'); assert(escaped.defaultPrevented); assert.equal(h.doc.activeElement, h.opener);
  await h.open(); h.dialog().emit('click', { clientX: 0, clientY: 0 }); assert.equal(h.host.innerHTML, '');
  await h.open(); const elsewhere = {}; h.doc.activeElement = elsewhere;
  h.viewer.suspend(); assert.equal(h.doc.activeElement, elsewhere);
  h.doc.activeElement = h.opener; await h.open(); h.opener.isConnected = false;
  const before = h.events.filter((e) => e === 'focus').length; h.viewer.close();
  assert.equal(h.events.filter((e) => e === 'focus').length, before);
});

test('browser decode failure releases its URL and shows only a fixed safe notice', async (t) => {
  const h = harness(t); await h.open(); h.viewer.media.emit('error');
  assert.equal(h.viewer.media, null); assert.equal(h.revoked.length, 1);
  assert.equal(h.controls().status.textContent, '파일을 표시하지 못했어요. 닫은 뒤 다시 확인해 주세요.');
  h.viewer.clear(); assert.equal(h.revoked.length, 1);
});

test('replaced open owns only its own URL and late prior completion cannot close the newer viewer', async (t) => {
  const h = harness(t), started = deferred(), gate = deferred(); let read = 0;
  h.mediaApi.openMessageAttachment = async () => { if (++read === 1) { started.resolve(); await gate.promise; } return new Blob(['1234'], { type: file.type }); };
  const old = h.open(); await started.promise; assert.equal(await h.open(), true); const current = h.viewer.media;
  gate.resolve(); assert.equal(await old, false); assert.equal(h.viewer.media, current); assert.equal(h.created.length, 1);
  h.viewer.clear(); assert.equal(h.revoked.length, 1);
});

test('poll-replaced opener falls back only to a visible exact message/file button in the same current scope', async (t) => {
  const h = harness(t);
  let focused = null;
  const button = (label, changes = {}) => ({ isConnected: true, disabled: false,
    dataset: { messageId: 'synthetic-message', openAttachment: file.id },
    getClientRects: () => [1], closest: () => null, focus: () => { focused = label; }, ...changes });
  const exact = button('exact');
  h.doc.querySelectorAll = () => [
    button('wrong-message', { dataset: { messageId: 'other-message', openAttachment: file.id } }),
    button('wrong-file', { dataset: { messageId: 'synthetic-message', openAttachment: 'other-file' } }),
    button('hidden', { getClientRects: () => [] }), button('inert', { closest: () => ({}) }),
    button('disabled', { disabled: true }), exact,
  ];
  await h.open(); h.opener.isConnected = false; h.viewer.close(); assert.equal(focused, 'exact');
  focused = null; await h.open(); h.viewer.operation.opener.isConnected = false;
  h.setContext({ roomId: 'other-room' }); h.viewer.close(); assert.equal(focused, null);
  h.setContext({ roomId: 'synthetic-room' }); await h.open(); h.viewer.operation.opener.isConnected = false;
  h.doc.querySelectorAll = () => []; h.viewer.close(); assert.equal(focused, null);
});

function recordHarness(t) {
  const h = harness(t); h.setContext({ role: 'therapist' });
  h.record = (changes = {}) => ({ id: 'synthetic-record', conversationId: 'synthetic-room', revision: 2,
    attachments: [{ ...file, share: false }], ...changes });
  h.api.record = async (_center, _room, id, signal, revision) => {
    assert.equal(id, 'synthetic-record'); assert.equal(revision, 2); assert(signal instanceof AbortSignal);
    h.events.push('record'); return h.record();
  };
  h.mediaApi.openRecordAttachment = async (scope, id, revision, metadata, signal) => {
    assert.equal(scope.roomId, 'synthetic-room'); assert.equal(id, 'synthetic-record'); assert.equal(revision, 2);
    assert.deepEqual(metadata, file); assert(signal instanceof AbortSignal);
    h.events.push('record-read'); return new Blob(['1234'], { type: file.type });
  };
  h.openRecord = () => h.viewer.openRecord('synthetic-record', 2, file.id);
  return h;
}

test('record viewer verifies the same explicit private revision before and after the authorized read', async (t) => {
  const h = recordHarness(t); assert.equal(await h.openRecord(), true);
  assert.deepEqual(h.events.filter((e) => ['record', 'record-read', 'create-url', 'message', 'read'].includes(e)),
    ['record', 'record-read', 'record', 'create-url']);
  assert.match(h.host.innerHTML, /기록 첨부/); assert.match(h.controls().status.textContent, /보호자에게 공유되지 않습니다/);
  h.viewer.reconcile([]); assert.equal(h.created.length, 1); assert(h.viewer.media);
  h.viewer.close(); assert.deepEqual(h.revoked, ['blob:synthetic-test']); assert.equal(h.doc.activeElement, h.opener);
});

test('record viewer denies non-therapists and invalid record/revision anchors without transport', async (t) => {
  const h = recordHarness(t);
  for (const role of ['guardian', 'center_admin', null, undefined]) {
    h.setContext({ role }); assert.equal(await h.openRecord(), false);
  }
  h.setContext({ role: 'therapist' });
  for (const revision of [undefined, 0, -1, '2', 2.5, 2147483648])
    assert.equal(await h.viewer.openRecord('synthetic-record', revision, file.id), false);
  assert.equal(await h.viewer.openRecord('../other', 2, file.id), false);
  assert(!h.events.includes('record')); assert(!h.events.includes('record-read')); assert.equal(h.created.length, 0);
});

test('wrong record revision, cross-room metadata or missing share flag never opens a private file', async (t) => {
  const h = recordHarness(t);
  for (const changes of [{ id: 'other-record' }, { revision: 3 }, { conversationId: 'other-room' },
    { attachments: [file] }, { attachments: [{ ...file, share: false }, { ...file, share: true }] }]) {
    h.api.record = async () => h.record(changes); assert.equal(await h.openRecord(), false);
  }
  assert(!h.events.includes('record-read')); assert.equal(h.created.length, 0);
});

test('record permission revoked or exact-revision file altered during download never becomes a URL', async (t) => {
  const h = recordHarness(t);
  for (const changed of ['denied', 'file', 'revision']) {
    let calls = 0;
    h.api.record = async () => {
      if (++calls === 1) return h.record();
      if (changed === 'denied') throw new LocalApiError('NOT_FOUND', 404);
      return h.record(changed === 'revision' ? { revision: 3 } : { attachments: [{ ...file, share: false, size: 3 }] });
    };
    assert.equal(await h.openRecord(), false); assert.equal(h.created.length, 0); assert.equal(h.host.innerHTML, '');
  }
});

test('record role or scope change discards a late file and reconcile releases an already-open URL', async (t) => {
  const h = recordHarness(t), started = deferred(), gate = deferred();
  const read = h.mediaApi.openRecordAttachment;
  h.mediaApi.openRecordAttachment = async (...args) => { started.resolve(); await gate.promise; return read(...args); };
  const pending = h.openRecord(); await started.promise; h.setContext({ role: 'guardian' }); gate.resolve();
  assert.equal(await pending, false); assert.equal(h.created.length, 0);
  h.setContext({ role: 'therapist' }); assert.equal(await h.openRecord(), true);
  h.setContext({ roomId: 'other-room' }); h.viewer.reconcile([]); assert.equal(h.revoked.length, 1);
});

test('record focus recovery uses the exact revision and never a newer revision of the same file', async (t) => {
  const h = recordHarness(t); let focused;
  const button = (revision) => ({ isConnected: true, disabled: false,
    dataset: { openRecordAttachment: file.id, recordId: 'synthetic-record', recordRevision: revision },
    getClientRects: () => [1], closest: () => null, focus: () => { focused = revision; } });
  h.doc.querySelectorAll = () => [button('3'), button('2')];
  assert.equal(await h.openRecord(), true); h.opener.isConnected = false; h.viewer.close(); assert.equal(focused, '2');
});

function pinnedHarness(t, kind) {
  const h = recordHarness(t);
  h.feedback = (changes = {}) => h.message({ type: 'feedback', archived: true,
    feedback: { id: 'synthetic-feedback', revision: 1 }, ...changes });
  h.reference = (changes = {}) => h.record({ attachments: [],
    referenceSources: [{ messageId: 'synthetic-message', feedbackId: 'synthetic-feedback', feedbackRevision: 1, attachments: [file] }], ...changes });
  h.api.feedback = async (_center, _room, id, signal, revision) => {
    assert.equal(id, 'synthetic-feedback'); assert.equal(revision, 1); assert(signal instanceof AbortSignal);
    h.events.push('pinned-metadata'); return h.feedback();
  };
  h.api.record = async (_center, _room, id, signal, revision) => {
    assert.equal(id, 'synthetic-record'); assert.equal(revision, 2); assert(signal instanceof AbortSignal);
    h.events.push('pinned-metadata'); return h.reference();
  };
  h.mediaApi.openFeedbackAttachment = async (scope, messageId, revision, metadata, signal) => {
    assert.equal(messageId, 'synthetic-message'); assert.equal(revision, 1);
    assert.equal(scope.roomId, 'synthetic-room'); assert.deepEqual(metadata, file); assert(signal instanceof AbortSignal);
    h.events.push('pinned-read'); return new Blob(['1234'], { type: file.type });
  };
  h.mediaApi.openReferenceAttachment = async (scope, recordId, revision, messageId, metadata, signal) => {
    assert.equal(recordId, 'synthetic-record'); assert.equal(revision, 2); assert.equal(messageId, 'synthetic-message');
    assert.equal(scope.roomId, 'synthetic-room'); assert.deepEqual(metadata, file); assert(signal instanceof AbortSignal);
    h.events.push('pinned-read'); return new Blob(['1234'], { type: file.type });
  };
  h.openPinned = () => kind === 'feedback' ? h.viewer.openFeedback('synthetic-feedback', 'synthetic-message', 1, file.id)
    : h.viewer.openReference('synthetic-record', 2, 'synthetic-message', file.id);
  h.metadataKey = kind === 'feedback' ? 'feedback' : 'record';
  h.readKey = kind === 'feedback' ? 'openFeedbackAttachment' : 'openReferenceAttachment';
  h.projection = kind === 'feedback' ? h.feedback : h.reference;
  return h;
}

for (const kind of ['feedback', 'reference']) {
  test(`${kind} viewer verifies its exact pinned source twice, ignoring unrelated current-message versions`, async (t) => {
    const h = pinnedHarness(t, kind); assert.equal(await h.openPinned(), true);
    assert.deepEqual(h.events.filter((e) => ['pinned-metadata', 'pinned-read', 'create-url', 'message', 'read'].includes(e)),
      ['pinned-metadata', 'pinned-read', 'pinned-metadata', 'create-url']);
    assert.match(h.host.innerHTML, kind === 'feedback' ? /활동 경험 첨부/ : /당시 참고 첨부/);
    h.viewer.reconcile([h.message({ hidden: true, attachments: [] })]); assert(h.viewer.media);
    h.viewer.reconcile([]); assert(h.viewer.media);
    h.viewer.clear(); assert.equal(h.revoked.length, 1);
  });

  test(`${kind} viewer rejects non-therapist, malformed anchors and stale parent contexts before transport`, async (t) => {
    const h = pinnedHarness(t, kind);
    for (const role of ['guardian', 'center_admin', undefined]) { h.setContext({ role }); assert.equal(await h.openPinned(), false); }
    h.setContext({ role: 'therapist' });
    for (const revision of [undefined, 0, '1', 1.5, 2147483648]) {
      assert.equal(await (kind === 'feedback' ? h.viewer.openFeedback('synthetic-feedback', 'synthetic-message', revision, file.id)
        : h.viewer.openReference('synthetic-record', revision, 'synthetic-message', file.id)), false);
    }
    assert.equal(await (kind === 'feedback' ? h.viewer.openFeedback('../feedback', 'synthetic-message', 1, file.id)
      : h.viewer.openReference('synthetic-record', 2, '../message', file.id)), false);
    h.setContext({ visible: false }); assert.equal(await h.openPinned(), false);
    assert(!h.events.includes('pinned-read')); assert(!h.events.includes('pinned-metadata')); assert.equal(h.created.length, 0);
  });

  test(`${kind} viewer does not substitute newest, foreign or missing references, including after a file read`, async (t) => {
    const h = pinnedHarness(t, kind);
    const wrong = kind === 'feedback' ? [
      { feedback: { id: 'synthetic-feedback', revision: 2 } }, { feedback: { id: 'foreign', revision: 1 } },
      { id: 'foreign-message' }, { hidden: true }, { deleted: true }, { type: 'text' }, { attachments: [] },
    ] : [
      { revision: 3 }, { conversationId: 'foreign-room' }, { referenceSources: [] },
      { referenceSources: [{ messageId: 'foreign-message', attachments: [file] }] },
      { attachments: [{ ...file, share: true }], referenceSources: [{ messageId: 'synthetic-message' }] },
      { referenceSources: [{ messageId: 'synthetic-message', attachments: [file] }, { messageId: 'synthetic-message', attachments: [file] }] },
    ];
    for (const afterRead of [false, true]) for (const changed of wrong) {
      let calls = 0;
      h.api[h.metadataKey] = async () => h.projection(!afterRead || ++calls > 1 ? changed : {});
      assert.equal(await h.openPinned(), false); assert.equal(h.created.length, 0);
    }
    h.api[h.metadataKey] = async () => { throw new LocalApiError('NOT_FOUND', 404); };
    assert.equal(await h.openPinned(), false); assert.equal(h.host.innerHTML, '');
  });

  test(`${kind} viewer releases content on parent close or role change and rejects late bytes`, async (t) => {
    const h = pinnedHarness(t, kind), started = deferred(), gate = deferred();
    const read = h.mediaApi[h.readKey];
    h.mediaApi[h.readKey] = async (...args) => { started.resolve(); await gate.promise; return read(...args); };
    const pending = h.openPinned(); await started.promise; h.viewer.clear(); gate.resolve();
    assert.equal(await pending, false); assert.equal(h.created.length, 0);
    assert.equal(await h.openPinned(), true); h.setContext({ role: 'guardian' }); h.viewer.reconcile([]);
    assert.equal(h.revoked.length, 1); assert.equal(h.host.innerHTML, '');
  });

  test(`${kind} viewer focus fallback matches file, message and the exact source revision`, async (t) => {
    const h = pinnedHarness(t, kind); let focused;
    const button = (revision) => ({ isConnected: true, disabled: false,
      dataset: kind === 'feedback' ? { openFeedbackAttachment: file.id, feedbackId: 'synthetic-feedback', messageId: 'synthetic-message', feedbackRevision: revision }
        : { openReferenceAttachment: file.id, recordId: 'synthetic-record', messageId: 'synthetic-message', recordRevision: revision },
      getClientRects: () => [1], closest: () => null, focus: () => { focused = revision; } });
    const wanted = kind === 'feedback' ? '1' : '2';
    h.doc.querySelectorAll = () => [button('3'), button(wanted)];
    assert.equal(await h.openPinned(), true); h.opener.isConnected = false; h.viewer.close(); assert.equal(focused, wanted);
  });
}

function currentReferenceHarness(t, messageType = 'text') {
  const h = harness(t); h.setContext({ role: 'therapist', referenceAttachments: [file] });
  h.source = { messageId: 'synthetic-message', messageType, revision: 3,
    ...(messageType === 'feedback' ? { feedbackId: 'synthetic-feedback' } : {}) };
  h.currentMessage = (changes = {}) => h.message({ type: messageType, version: 3, archived: messageType === 'feedback',
    ...(messageType === 'feedback' ? { feedback: { id: 'synthetic-feedback', revision: 3 } } : {}), ...changes });
  h.api.message = async (_center, _room, id, signal) => {
    assert.equal(id, 'synthetic-message'); assert(signal instanceof AbortSignal); h.events.push('current-message'); return h.currentMessage();
  };
  for (const key of ['record', 'feedback']) h.api[key] = () => assert.fail('Current source cannot fall back to a pinned revision.');
  for (const key of ['openRecordAttachment', 'openFeedbackAttachment', 'openReferenceAttachment'])
    h.mediaApi[key] = () => assert.fail('Current source must use the current message-content route.');
  h.openCurrent = () => h.viewer.openCurrentReference(h.source, file.id);
  return h;
}

for (const type of ['text', 'feedback']) {
  test(`current ${type} attachment verifies the exact inspected version twice and uses only current message bytes`, async (t) => {
    const h = currentReferenceHarness(t, type); assert.equal(await h.openCurrent(), true);
    assert.deepEqual(h.events.filter(event => ['current-message', 'read', 'create-url'].includes(event)),
      ['current-message', 'read', 'current-message', 'create-url']);
    assert.deepEqual(h.viewer.operation.source, { kind: 'current-reference', ...h.source }); assert(Object.isFrozen(h.viewer.operation.source));
    assert.equal(h.viewer.operation.source.revision, 3); assert.equal(h.created.length, 1);
    h.viewer.clear(); assert.equal(h.revoked.length, 1);
  });

  test(`current ${type} source or file changes before/after bytes never create an object URL`, async (t) => {
    const h = currentReferenceHarness(t, type);
    const changes = [{ id: 'other-message' }, { conversationId: 'other-room' }, { hidden: true }, { deleted: true },
      { type: 'publication' }, { attachments: [] }, { attachments: [file, file] }, { attachments: [{ ...file, name: 'new-file.png' }] },
      ...(type === 'text' ? [{ version: 4 }, { version: '3' }] : [{ feedback: { id: 'synthetic-feedback', revision: 4 } },
        { feedback: { id: 'other-feedback', revision: 3 } }, { feedback: null }])];
    for (const afterRead of [false, true]) for (const change of changes) {
      let reads = 0;
      h.api.message = async () => h.currentMessage(!afterRead || ++reads > 1 ? change : {});
      assert.equal(await h.openCurrent(), false); assert.equal(h.created.length, 0);
      assert.equal(h.errorSources.at(-1)?.kind, 'current-reference'); assert.deepEqual(h.errorSources.at(-1), { kind: 'current-reference', ...h.source });
    }
    h.viewer.clear();
  });

  test(`current ${type} exact-source focus fallback never selects pinned, stale or unrelated attachment buttons`, async (t) => {
    const h = currentReferenceHarness(t, type); let focused;
    const attrs = { openCurrentReferenceAttachment: file.id, messageId: 'synthetic-message', messageType: type, referenceRevision: '3',
      ...(type === 'feedback' ? { feedbackId: 'synthetic-feedback' } : {}) };
    const button = (name, changes = {}) => ({ isConnected: true, disabled: false, dataset: { ...attrs, ...changes },
      getClientRects: () => [1], closest: () => null, focus: () => { focused = name; } });
    h.doc.querySelectorAll = () => [button('wrong-id', { messageId: 'other-message' }), button('old', { referenceRevision: '2' }),
      button('wrong-type', { messageType: type === 'text' ? 'feedback' : 'text' }),
      ...(type === 'feedback' ? [button('other-feedback', { feedbackId: 'other-feedback' })] : []), button('correct')];
    assert.equal(await h.openCurrent(), true); h.opener.isConnected = false; h.viewer.close(); assert.equal(focused, 'correct');
  });
}

test('current reference rejects malformed inputs/non-therapists and never honors caller kind overrides', async (t) => {
  const h = currentReferenceHarness(t);
  for (const input of [null, undefined, [], 'source', {}, { ...h.source, messageId: '../message' }, { ...h.source, messageType: 'publication' },
    ...[0, -1, '3', 3.5, 2147483648].map(revision => ({ ...h.source, revision })),
    { ...h.source, feedbackId: 'synthetic-feedback' }, { ...h.source, messageType: 'feedback' },
    { ...h.source, messageType: 'feedback', feedbackId: '../feedback' }]) {
    assert.equal(await h.viewer.openCurrentReference(input, file.id), false); assert.equal(h.created.length, 0);
  }
  for (const role of ['guardian', 'center', undefined]) { h.setContext({ role }); assert.equal(await h.openCurrent(), false); }
  assert(!h.events.includes('current-message')); assert(!h.events.includes('read'));
  h.setContext({ role: 'therapist' });
  assert.equal(await h.viewer.openCurrentReference({ ...h.source, kind: 'record', recordId: 'PRIVATE-RECORD' }, file.id), true);
  assert.deepEqual(h.viewer.operation.source, { kind: 'current-reference', ...h.source }); h.viewer.clear();
});

test('current-source descriptor and expected file are captured before await and caller mutation cannot repin the read', async (t) => {
  const h = currentReferenceHarness(t, 'feedback'), gate = deferred(), started = deferred();
  const callerFile = { ...file }, callerAttachments = [callerFile]; h.setContext({ referenceAttachments: callerAttachments });
  h.api.message = async () => { started.resolve(); await gate.promise; return h.currentMessage(); };
  const pending = h.openCurrent(); await started.promise; h.source.revision = 7; h.source.feedbackId = 'other-feedback';
  callerFile.name = 'CHANGED-CALLER-FILE.png'; callerAttachments.length = 0; gate.resolve();
  assert.equal(await pending, true); assert.equal(h.viewer.operation.source.revision, 3);
  assert.equal(h.viewer.operation.source.feedbackId, 'synthetic-feedback'); assert.deepEqual(h.viewer.operation.attachment, file); h.viewer.clear();
});

test('parent current-source abort immediately releases an open URL and cancels an unfinished current read', async (t) => {
  const h = currentReferenceHarness(t);
  let parent = new AbortController(); h.setContext({ signal: parent.signal }); assert.equal(await h.openCurrent(), true);
  parent.abort(); assert.equal(h.host.innerHTML, ''); assert.equal(h.revoked.length, 1);
  parent = new AbortController(); h.setContext({ signal: parent.signal });
  const gate = deferred(), started = deferred(); let signal;
  h.mediaApi.openMessageAttachment = async (_scope, _id, _file, currentSignal) => {
    signal = currentSignal; started.resolve(); await gate.promise; return new Blob(['1234'], { type: file.type });
  };
  const pending = h.openCurrent(); await started.promise; parent.abort(); assert.equal(signal.aborted, true);
  gate.resolve(); assert.equal(await pending, false); assert.equal(h.created.length, 1); assert.equal(h.host.innerHTML, '');
});

test('current-source temporary/raw errors report safe source context without restoring obsolete content or diagnostics', async (t) => {
  const h = currentReferenceHarness(t, 'feedback');
  h.mediaApi.openMessageAttachment = async () => { throw new Error('PRIVATE-URL-TOKEN'); };
  assert.equal(await h.openCurrent(), false); assert.equal(h.created.length, 0);
  assert.equal(h.errors.at(-1).code, 'UNAVAILABLE'); assert(!h.errors.at(-1).message.includes('PRIVATE-'));
  assert.deepEqual(h.errorSources.at(-1), { kind: 'current-reference', ...h.source }); assert(!h.host.innerHTML.includes('PRIVATE-'));
  h.viewer.clear();
});

test('current-reference reconciliation follows current parent visibility rather than unrelated paginated chat messages', async (t) => {
  const h = currentReferenceHarness(t, 'feedback'); assert.equal(await h.openCurrent(), true);
  h.viewer.reconcile([]); assert(h.viewer.media);
  h.setContext({ visible: false }); h.viewer.reconcile([]);
  assert.equal(h.viewer.media, null); assert.equal(h.revoked.length, 1);
});

test('current-reference requires one valid captured file before querying or downloading a current message', async (t) => {
  const h = currentReferenceHarness(t);
  for (const referenceAttachments of [undefined, [], [file, file], [{ ...file, id: '../file' }],
    ...[{ name: '' }, { name: 'invalid\nname' }, { type: 'text/html' }, { size: 0 }, { size: 1.5 }].map(change => [{ ...file, ...change }])]) {
    h.setContext({ referenceAttachments }); assert.equal(await h.openCurrent(), false);
    assert.equal(h.created.length, 0); assert(!h.events.includes('current-message')); assert(!h.events.includes('read'));
  }
});
