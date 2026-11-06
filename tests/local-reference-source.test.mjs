// Pure controller/DOM doubles. No browser, HTTP server, database, file data or
// real identities. These checks do not establish actual device evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareUi, CareMutation, careReferenceSourceMarkup } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

const deferred = () => Promise.withResolvers();
const checkedAt = '2026-10-10T01:02:03.000Z';
const oldFile = () => ({ id: 'synthetic-old-file', name: 'PINNED-FILE.png', type: 'image/png', size: 12 });
const reference = (feedback = false, extra = {}) => ({ messageId: 'synthetic-source', body: 'PINNED-OLD-SOURCE',
  attachmentCount: 1, attachments: [oldFile()], ...(feedback
    ? { feedbackId: 'synthetic-feedback', feedbackRevision: 1 }
    : { messageRevision: 1 }), ...extra });
const message = (feedback = false, extra = {}) => ({ id: 'synthetic-source', conversationId: 'synthetic-room', childId: 'synthetic-child',
  type: feedback ? 'feedback' : 'text', version: 3, body: 'CURRENT-TEXT-SOURCE', hidden: false, deleted: false, archived: false,
  attachmentCount: 2, attachments: [{ id: 'current-file', name: 'NEVER-FILE-METADATA', type: 'image/png', size: 45 }],
  ...(feedback ? { feedback: { id: 'synthetic-feedback', publicationId: 'synthetic-publication', revision: 3,
    date: '2026-10-10', result: 'partial', reaction: 'CURRENT-FEEDBACK-REACTION', difficulty: 'CURRENT-FEEDBACK-DIFFICULTY' } } : {}), ...extra });
function context() { return { user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', roomRevision: 9, generation: 1, connected: true,
  profile: { childId: 'synthetic-child', conversationId: 'synthetic-room', participants: [] },
  messages: [], careData: { records: [], goals: [], appointments: [] }, signal: new AbortController().signal }; }
function sourceNodes(messageId) {
  const attributes = new Map([['aria-expanded', 'false']]);
  let markup = '', text = '';
  const panel = { hidden: true, isConnected: true,
    get innerHTML() { return markup; }, set innerHTML(value) { markup = value; text = value; },
    get textContent() { return text; }, set textContent(value) {
      text = String(value); markup = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }, replaceChildren() { this.innerHTML = ''; } };
  const button = { textContent: '현재 원문 보기', disabled: false, isConnected: true,
    dataset: { careAction: 'reference-source', messageId },
    setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: (key) => attributes.get(key),
    removeAttribute: key => attributes.delete(key) };
  const nodes = { panel, button };
  nodes.wrapper = { dataset: { referenceMessageId: messageId }, isConnected: true,
    querySelector: selector => selector === '[data-reference-source]' ? nodes.panel
      : selector === '[data-care-action="reference-source"]' ? nodes.button : null,
    contains: node => node === nodes.panel || node === nodes.button };
  return nodes;
}
function fixture({ feedback = false, api = {}, delivery = false, callbacks = {} } = {}) {
  let current = context(); const contextController = new AbortController(); current.signal = contextController.signal;
  const calls = [], errors = [], notices = [], nodes = [sourceNodes('synthetic-source')];
  const ui = new CareUi({ api: {
    profile: async (...args) => { calls.push(['profile', ...args]); return { ...current.profile }; },
    record: async (...args) => { calls.push(['record', ...args]); return { id: 'synthetic-record', conversationId: 'synthetic-room', revision: 2 }; },
    message: async (...args) => { calls.push(['message', ...args]); return message(feedback); }, ...api,
  }, getContext: () => current, onError: error => errors.push(error.code),
    ...(delivery ? { deliveryEnabled: true, mediaApi: {} } : {}), ...callbacks });
  ui.owner = current.user.userId; ui.ownerRole = 'therapist'; ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  const view = { kind: 'record', recordId: 'synthetic-record', expectedRevision: 2, goals: [], references: [reference(feedback)],
    values: { date: '2026-10-09', title: 'SAVED-RECORD', performed: 'UNSAVED-PERFORMED', response: 'UNSAVED-RESPONSE',
      nextPlan: 'UNSAVED-PLAN', privateNote: 'PRIVATE-RECORD-NOTE', attachments: [{ ...oldFile(), share: false }],
      assessments: [{ tool: 'ROM', item: 'synthetic', unit: 'degree', context: 'synthetic', value: 0 }] } };
  const state = { mutation: new CareMutation(() => 'synthetic-request'), records: [], goals: [], appointments: [], loaded: true, loading: false, view };
  ui.states.set(ui.key, state);
  const inputs = [{ value: view.values.performed }, { value: view.values.privateNote }];
  const dialog = { open: true, removed: false,
    querySelector: selector => selector === '[data-care-error]' ? { set textContent(value) { notices.push(value); } } : null,
    querySelectorAll: selector => selector === '[data-reference-message-id]' ? nodes.map(node => node.wrapper)
      : selector === 'input,textarea,select' ? inputs : [],
    contains: node => nodes.some(entry => [entry.wrapper, entry.panel, entry.button].includes(node)),
    close() { this.open = false; }, remove() { this.removed = true; },
    replaceChildren() { for (const node of nodes) { node.panel.innerHTML = ''; node.panel.hidden = true;
      node.wrapper.isConnected = node.panel.isConnected = node.button.isConnected = false; } } };
  ui.dialog = dialog;
  return { ui, state, view, nodes, dialog, inputs, calls, errors, notices, contextController,
    get current() { return current; }, setContext(next) { current = next; },
    preserved: () => structuredClone({ values: view.values, references: view.references }) };
}
const assertClosed = f => {
  for (const { panel, button } of f.nodes) {
    assert.equal(panel.innerHTML, ''); assert.equal(panel.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false'); assert.equal(button.textContent, '현재 원문 보기');
  }
};

test('current text markup escapes content and selects public fields rather than serializing message metadata', () => {
  const source = message(false, { body: '<script>synthetic</script>&"\'', privateNote: 'PRIVATE-NOTE', reviewNote: 'PRIVATE-REVIEW',
    token: 'PRIVATE-TOKEN', authorId: 'PRIVATE-AUTHOR', storagePath: 'PRIVATE-PATH', sha256: 'PRIVATE-HASH' });
  const before = structuredClone(source), html = careReferenceSourceMarkup(source, checkedAt);
  assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/); assert(!html.includes('<script>'));
  for (const value of ['PRIVATE-', 'NEVER-FILE-METADATA', 'current-file']) assert(!html.includes(value), value);
  assert.deepEqual(source, before);
});

test('current feedback markup shows the current feedback fields without copying its private review or files', () => {
  const source = message(true); source.feedback.note = 'PRIVATE-REVIEW'; source.feedback.reviewNote = 'PRIVATE-REVIEW';
  source.feedback.reaction = '<img src=x onerror=synthetic()> CURRENT-REACTION';
  const html = careReferenceSourceMarkup(source, checkedAt);
  assert.match(html, /CURRENT-REACTION/); assert.match(html, /CURRENT-FEEDBACK-DIFFICULTY/); assert.match(html, /2026-10-10/);
  assert(!html.includes('<img')); assert(!html.includes('PRIVATE-')); assert(!html.includes('NEVER-FILE-METADATA'));
});

for (const feedback of [false, true]) test(`explicit ${feedback ? 'feedback' : 'text'} lookup rechecks saved-record authority and never repins old source or attachments`, async () => {
  const f = fixture({ feedback }), before = f.preserved();
  await f.ui.toggleReferenceSource('synthetic-source');
  assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'record', 'message']);
  const call = f.calls.find(([kind]) => kind === 'message');
  assert.deepEqual(call.slice(1, 4), ['synthetic-center', 'synthetic-room', 'synthetic-source']); assert(call[4] instanceof AbortSignal);
  assert.equal(f.nodes[0].panel.hidden, false); assert.equal(f.nodes[0].button.getAttribute('aria-expanded'), 'true');
  assert.match(f.nodes[0].panel.innerHTML, feedback ? /CURRENT-FEEDBACK-REACTION/ : /CURRENT-TEXT-SOURCE/);
  assert.equal(f.nodes[0].button.textContent, '현재 원문 닫기'); assert.deepEqual(f.preserved(), before);
  assert(!f.nodes[0].panel.innerHTML.includes('PRIVATE-RECORD-NOTE')); assert(!f.nodes[0].panel.innerHTML.includes('PINNED-FILE'));
  const request = f.ui.referenceSource; assert.equal(f.ui.referenceSourceCurrent(request), true);
  await f.ui.toggleReferenceSource('synthetic-source'); assertClosed(f);
  assert.equal(call[4].aborted, true); assert.deepEqual(f.preserved(), before); assert.equal(f.calls.length, 3);
});

test('archived but currently authorized text and feedback remain readable without changing preserved record references', async () => {
  for (const feedback of [false, true]) {
    const f = fixture({ feedback, api: { message: async () => message(feedback, { archived: true }) } }), before = f.preserved();
    await f.ui.toggleReferenceSource('synthetic-source');
    assert.match(f.nodes[0].panel.innerHTML, feedback ? /CURRENT-FEEDBACK-REACTION/ : /CURRENT-TEXT-SOURCE/);
    assert.deepEqual(f.preserved(), before);
  }
});

test('lookup stays unavailable outside a current open therapist record or during an immutable mutation/context refresh', async () => {
  for (const boundary of ['guardian', 'center', 'offline', 'closed', 'not-record', 'missing-reference', 'missing-node', 'mutation', 'context-refresh']) {
    const f = fixture();
    if (['guardian', 'center'].includes(boundary)) f.current.user.centers[0].role = boundary;
    if (boundary === 'offline') f.current.connected = false;
    if (boundary === 'closed') f.dialog.open = false;
    if (boundary === 'not-record') f.view.kind = 'reply';
    if (boundary === 'missing-reference') f.view.references = [];
    if (boundary === 'missing-node') f.nodes.length = 0;
    if (boundary === 'mutation') f.state.mutation.begin('record', f.view.recordId, { expectedRevision: 2, content: {} });
    if (boundary === 'context-refresh') f.view.contextRefresh = {};
    await f.ui.toggleReferenceSource('synthetic-source'); assert.equal(f.calls.length, 0, boundary); assertClosed(f);
  }
});

test('lookup waits for both current profile and saved record checks before reading a source', async () => {
  const profile = deferred(), record = deferred(), profileStarted = deferred(), recordStarted = deferred(); let reads = 0;
  const f = fixture({ api: { profile: () => { profileStarted.resolve(); return profile.promise; },
    record: () => { recordStarted.resolve(); return record.promise; }, message: async () => { reads++; return message(); } } });
  const pending = f.ui.toggleReferenceSource('synthetic-source'); await profileStarted.promise;
  assert.equal(reads, 0); assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-'));
  profile.resolve({ ...f.current.profile }); await recordStarted.promise; assert.equal(reads, 0);
  record.resolve({ id: 'synthetic-record', conversationId: 'synthetic-room' }); await pending;
  assert.equal(reads, 1); assert.match(f.nodes[0].panel.innerHTML, /CURRENT-TEXT-SOURCE/);
});

test('wrong source identity, room, child, type or feedback ID never substitutes another current source', async () => {
  for (const extra of [{ id: 'other-source' }, { conversationId: 'other-room' }, { childId: 'other-child' },
    { type: 'publication' }, { type: 'text', feedback: undefined }, { feedback: { ...message(true).feedback, id: 'other-feedback' } }]) {
    const f = fixture({ feedback: true, api: { message: async () => message(true, extra) } }), before = f.preserved();
    await f.ui.toggleReferenceSource('synthetic-source'); assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-'));
    assert.deepEqual(f.preserved(), before); assert.equal(f.state.view, f.view);
  }
});

test('hidden/deleted or 404/403 current source is unavailable without erasing independently authorized saved content/files', async () => {
  for (const boundary of ['hidden', 'deleted', 'not-found', 'forbidden']) {
    const f = fixture({ api: { message: async () => {
      if (boundary === 'not-found') throw new LocalApiError('NOT_FOUND', 404);
      if (boundary === 'forbidden') throw new LocalApiError('FORBIDDEN', 403);
      return message(false, { [boundary]: true });
    } } }), before = f.preserved();
    await f.ui.toggleReferenceSource('synthetic-source');
    assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-')); assert.equal(f.state.view, f.view); assert.equal(f.ui.dialog, f.dialog);
    assert.equal(f.dialog.open, true); assert.deepEqual(f.preserved(), before);
    assert(f.calls.filter(([kind]) => kind === 'record').length >= 1); assert.deepEqual(f.errors, []);
  }
});

test('authentication denial clears all owned state rather than preserving the current source or record DOM', async () => {
  for (const stage of ['profile', 'record', 'message']) {
    const f = fixture({ api: { [stage]: async () => { throw new LocalApiError('AUTH_REQUIRED', 401); } } });
    await f.ui.toggleReferenceSource('synthetic-source');
    assert.equal(f.ui.states.size, 0); assert.equal(f.ui.dialog, null); assert.deepEqual(f.errors, ['AUTH_REQUIRED']);
    assertClosed(f); assert.equal(f.inputs[0].value, '');
  }
});

test('temporary source failure exposes no raw error and an explicit retry performs fresh authority/source reads', async () => {
  let attempts = 0; const f = fixture({ api: { message: async () => { if (++attempts === 1) throw new Error('PRIVATE-RAW-ERROR'); return message(); } } });
  const before = f.preserved(); await f.ui.toggleReferenceSource('synthetic-source');
  assert.equal(f.state.view, f.view); assert(!f.nodes[0].panel.innerHTML.includes('PRIVATE-')); assert.deepEqual(f.preserved(), before);
  if (f.ui.referenceSource) await f.ui.toggleReferenceSource('synthetic-source');
  await f.ui.toggleReferenceSource('synthetic-source');
  assert.equal(attempts, 2); assert.match(f.nodes[0].panel.innerHTML, /CURRENT-TEXT-SOURCE/);
  assert.equal(f.calls.filter(([kind]) => kind === 'profile').length, 2); assert.deepEqual(f.preserved(), before);
});

test('clear/close/wipe abort active source reads and a late transport result cannot repaint detached panels', async () => {
  for (const boundary of ['clear-source', 'close', 'wipe', 'suspend']) {
    const gate = deferred(), started = deferred(); let signal;
    const f = fixture({ api: { message: (...args) => { signal = args[3]; started.resolve(); return gate.promise; } } });
    const before = f.preserved(), pending = f.ui.toggleReferenceSource('synthetic-source'); await started.promise;
    const request = f.ui.referenceSource;
    if (boundary === 'clear-source') f.ui.clearReferenceSource();
    else if (boundary === 'wipe') f.ui.wipeDialog();
    else f.ui[boundary]();
    assert.equal(signal.aborted, true); assert.equal(f.ui.referenceSourceCurrent(request), false);
    gate.resolve(message()); await pending; assertClosed(f); assert.deepEqual(f.preserved(), before);
  }
});

test('late source results cannot cross account, generation, room, child, role, room revision or context abort', async () => {
  for (const change of ['account', 'generation', 'room', 'child', 'role', 'revision', 'abort']) {
    const gate = deferred(), started = deferred();
    const f = fixture({ api: { message: () => { started.resolve(); return gate.promise; } } });
    const pending = f.ui.toggleReferenceSource('synthetic-source'); await started.promise; const request = f.ui.referenceSource;
    const next = structuredClone({ ...f.current, signal: undefined }); next.signal = f.current.signal;
    if (change === 'account') next.user.userId = 'other-user';
    if (change === 'generation') next.generation++;
    if (change === 'room') next.roomId = 'other-room';
    if (change === 'child') next.profile.childId = 'other-child';
    if (change === 'role') next.user.centers[0].role = 'guardian';
    if (change === 'revision') next.roomRevision++;
    if (change === 'abort') f.contextController.abort();
    f.setContext(next);
    assert.equal(f.ui.referenceSourceCurrent(request), false, change);
    gate.resolve(message()); await pending; assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-'), change);
  }
});

test('replacing the view, pinned reference, panel or button invalidates an in-flight current-source projection', async () => {
  for (const change of ['view', 'reference', 'panel', 'button']) {
    const gate = deferred(), started = deferred();
    const f = fixture({ api: { message: () => { started.resolve(); return gate.promise; } } });
    const pending = f.ui.toggleReferenceSource('synthetic-source'); await started.promise; const request = f.ui.referenceSource;
    const oldPanel = f.nodes[0].panel;
    if (change === 'view') f.state.view = { ...f.view };
    if (change === 'reference') f.view.references = [{ ...f.view.references[0] }];
    if (change === 'panel' || change === 'button') f.nodes[0][change] = sourceNodes('synthetic-source')[change];
    assert.equal(f.ui.referenceSourceCurrent(request), false, change);
    gate.resolve(message()); await pending; assert(!oldPanel.innerHTML.includes('CURRENT-'));
    assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-'));
  }
});

test('captured primitive child and room revision detect in-place context changes before a late source result', async () => {
  for (const change of ['child', 'revision']) {
    const gate = deferred(), started = deferred();
    const f = fixture({ api: { message: () => { started.resolve(); return gate.promise; } } });
    const before = f.preserved(), pending = f.ui.toggleReferenceSource('synthetic-source'); await started.promise;
    const request = f.ui.referenceSource; assert.equal(request.context, f.current);
    if (change === 'child') f.current.profile.childId = 'other-child';
    else f.current.roomRevision++;
    assert.equal(f.ui.referenceSourceCurrent(request), false, change);
    gate.resolve(message()); await pending; assertClosed(f); assert.deepEqual(f.preserved(), before);
  }
});

test('a newer selected reference cancels the previous one and a late first result cannot overwrite the second source', async () => {
  const old = deferred(), oldStarted = deferred();
  const f = fixture({ api: { message: async (...args) => {
    if (args[2] === 'synthetic-source') { oldStarted.resolve(); return old.promise; }
    return message(false, { id: 'second-source', body: 'SECOND-CURRENT' });
  } } });
  f.view.references.push(reference(false, { messageId: 'second-source', body: 'SECOND-PINNED' })); f.nodes.push(sourceNodes('second-source'));
  const before = f.preserved(), pending = f.ui.toggleReferenceSource('synthetic-source'); await oldStarted.promise;
  const request = f.ui.referenceSource; await f.ui.toggleReferenceSource('second-source');
  assert.equal(f.ui.referenceSourceCurrent(request), false); assert.match(f.nodes[1].panel.innerHTML, /SECOND-CURRENT/);
  old.resolve(message()); await pending; assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-TEXT-SOURCE'));
  assert.match(f.nodes[1].panel.innerHTML, /SECOND-CURRENT/); assert.deepEqual(f.preserved(), before);
});

test('a real mutation clears source-only DOM immediately without changing the frozen save request or canceling retained files', async () => {
  const sourceGate = deferred(), sourceStarted = deferred(), saveGate = deferred(), saveStarted = deferred();
  const writes = []; let signal;
  const f = fixture({ api: { message: (...args) => { signal = args[3]; sourceStarted.resolve(); return sourceGate.promise; },
    recordSave: (...args) => { writes.push(args[3]); saveStarted.resolve(); return saveGate.promise; } } });
  const before = f.preserved(), sourcePending = f.ui.toggleReferenceSource('synthetic-source'); await sourceStarted.promise;
  const operation = f.state.mutation.begin('record', f.view.recordId, { expectedRevision: 2,
    content: { privateNote: f.view.values.privateNote, attachments: [{ id: oldFile().id, share: false }] } });
  const saving = f.ui.mutate(true); await saveStarted.promise;
  assert.equal(signal.aborted, true); assertClosed(f); assert.equal(writes[0], operation.body);
  sourceGate.resolve(message()); await sourcePending; assertClosed(f); assert.deepEqual(f.preserved(), before);
  saveGate.reject(new LocalApiError('UNAVAILABLE')); await saving;
  assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.mutation.everUncertain, true);
  assert.deepEqual(operation.body.content.attachments, [{ id: oldFile().id, share: false }]);
});

test('a coherent room revision update clears an already displayed source without replacing record author values', async () => {
  const f = fixture(), before = f.preserved(); await f.ui.toggleReferenceSource('synthetic-source');
  assert.match(f.nodes[0].panel.innerHTML, /CURRENT-TEXT-SOURCE/);
  const next = { ...f.current, roomRevision: f.current.roomRevision + 1 }; f.setContext(next); f.ui.update(next);
  assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-TEXT-SOURCE'));
  assert.equal(f.nodes[0].button.getAttribute('aria-expanded'), 'false'); assert.equal(f.nodes[0].button.textContent, '현재 원문 보기');
  assert.equal(f.ui.referenceSource, null); assert.deepEqual(f.preserved(), before);
});

test('source 404 followed by revoked room authority clears the record instead of retaining its source-only unavailable panel', async () => {
  let profiles = 0;
  const f = fixture({ api: { profile: async () => {
    if (++profiles === 2) throw new LocalApiError('FORBIDDEN', 403); return { ...f.current.profile };
  }, message: async () => { throw new LocalApiError('NOT_FOUND', 404); } } });
  await f.ui.toggleReferenceSource('synthetic-source');
  assert.equal(profiles, 2); assert.equal(f.ui.states.size, 0); assert.equal(f.ui.dialog, null);
  assert.deepEqual(f.errors, ['FORBIDDEN']); assertClosed(f);
});

test('explicit source inspection never reuses an older in-flight record authority check', async () => {
  for (const priorAllowed of [true, false]) {
    const oldRecord = deferred(), oldStarted = deferred(), newProfile = deferred(), newStarted = deferred(); let records = 0, sources = 0;
    const f = fixture({ api: {
      profile: () => { newStarted.resolve(); return newProfile.promise; },
      record: () => { if (++records === 1) { oldStarted.resolve(); return oldRecord.promise; }
        return Promise.resolve({ id: 'synthetic-record', conversationId: 'synthetic-room' }); },
      message: async () => { sources++; return message(); },
    } });
    const old = f.ui.guardView(f.current); await oldStarted.promise;
    const reading = f.ui.toggleReferenceSource('synthetic-source'); await newStarted.promise;
    oldRecord.resolve(priorAllowed ? { id: 'synthetic-record', conversationId: 'synthetic-room' } : { id: 'other-record' }); await old;
    assert.equal(sources, 0); assert.equal(f.state.view, f.view); assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-'));
    newProfile.resolve({ ...f.current.profile }); await reading;
    assert.equal(sources, 1); assert.equal(f.state.view, f.view); assert.match(f.nodes[0].panel.innerHTML, /CURRENT-TEXT-SOURCE/);
  }
});

const currentFile = (extra = {}) => ({ id: '12345678-1234-4234-8234-123456789abc', name: 'CURRENT-ONLY.png', type: 'image/png', size: 4, ...extra });
const mediaMessage = (feedback = false, extra = {}) => message(feedback, { attachmentCount: 1, attachments: [currentFile()], ...extra });
const currentSource = (feedback = false) => ({ messageId: 'synthetic-source', messageType: feedback ? 'feedback' : 'text', revision: 3,
  ...(feedback ? { feedbackId: 'synthetic-feedback' } : {}) });

test('prepared source markup adds only exact current-file buttons and escapes names without exposing private metadata', () => {
  for (const feedback of [false, true]) {
    const source = mediaMessage(feedback, { attachments: [currentFile({ name: '<img onerror="synthetic">.png',
      storagePath: 'PRIVATE-STORAGE', sha256: 'PRIVATE-HASH', share: true })] });
    const before = structuredClone(source), ordinary = careReferenceSourceMarkup(source, checkedAt);
    assert(!ordinary.includes('data-open-current-reference-attachment')); assert(!ordinary.includes('onerror'));
    const html = careReferenceSourceMarkup(source, checkedAt, true);
    assert.match(html, new RegExp(`data-open-current-reference-attachment="${currentFile().id}"`));
    assert.match(html, /data-message-id="synthetic-source"/); assert.match(html, /data-reference-revision="3"/);
    assert.match(html, new RegExp(`data-message-type="${feedback ? 'feedback' : 'text'}"`));
    if (feedback) assert.match(html, /data-feedback-id="synthetic-feedback"/);
    else assert(!html.includes('data-feedback-id'));
    assert.match(html, /&lt;img/); assert(!html.includes('<img')); assert(!html.includes('PRIVATE-'));
    assert.deepEqual(source, before);
  }
});

test('missing, count-mismatched or excessive projected metadata never creates prepared clickable buttons', () => {
  // The API validates individual files; this renderer checks projection
  // completeness. Malformed/duplicate files are also tested at the viewer.
  for (const extra of [{ attachments: undefined }, { attachmentCount: 2 }, { attachmentCount: 0 },
    { attachmentCount: 7, attachments: Array.from({ length: 7 }, () => currentFile()) }]) {
    assert(!careReferenceSourceMarkup(mediaMessage(false, extra), checkedAt, true).includes('data-open-current-reference-attachment'));
  }
});

for (const feedback of [false, true]) test(`only captured current ${feedback ? 'feedback' : 'text'} files can invoke the viewer; pinned file IDs never substitute`, async () => {
  const opened = [], source = mediaMessage(feedback), f = fixture({ feedback, delivery: true,
    api: { message: async () => source }, callbacks: { onOpenCurrentReferenceAttachment: (...args) => opened.push(args) } });
  const before = f.preserved();
  await f.ui.openCurrentReferenceAttachment('synthetic-source', currentFile().id); assert.equal(opened.length, 0);
  await f.ui.toggleReferenceSource('synthetic-source');
  await f.ui.openCurrentReferenceAttachment('other-source', currentFile().id);
  await f.ui.openCurrentReferenceAttachment('synthetic-source', oldFile().id);
  await f.ui.openCurrentReferenceAttachment('synthetic-source', '00000000-0000-4000-8000-000000000002');
  assert.equal(opened.length, 0);
  // Caller-owned response changes cannot change the already-inspected source.
  source.attachments[0].id = '00000000-0000-4000-8000-000000000002';
  if (feedback) source.feedback.revision = 9; else source.version = 9;
  await f.ui.openCurrentReferenceAttachment('synthetic-source', currentFile().id);
  assert.equal(opened.length, 1); assert.deepEqual(opened[0], [currentSource(feedback), currentFile().id]);
  assert(Object.isFrozen(opened[0][0])); assert.deepEqual(f.preserved(), before);
  const scope = f.ui.currentReferenceMediaContext({ kind: 'current-reference', ...currentSource(feedback) });
  assert.equal(scope.enabled, true); assert.equal(scope.visible, true); assert.equal(scope.role, 'therapist');
  assert.deepEqual(scope.referenceAttachments, [currentFile()]); assert(Object.isFrozen(scope.referenceAttachments));
  assert(scope.signal instanceof AbortSignal); assert.equal(scope.signal.aborted, false);
  const request = f.ui.referenceSource;
  f.ui.clearReferenceSource(); assert.equal(scope.signal.aborted, true);
  assert.equal(request.source, null); assert.deepEqual(request.attachments, []);
  assert.equal(f.ui.currentReferenceMediaContext({ kind: 'current-reference', ...currentSource(feedback) }).visible, false);
  await f.ui.openCurrentReferenceAttachment('synthetic-source', currentFile().id); assert.equal(opened.length, 1);
});

test('current media context requires the same source version/type/feedback ID and current parent scope', async () => {
  const f = fixture({ feedback: true, delivery: true, api: { message: async () => mediaMessage(true) } });
  await f.ui.toggleReferenceSource('synthetic-source'); const source = { kind: 'current-reference', ...currentSource(true) };
  assert.equal(f.ui.currentReferenceMediaContext(source).visible, true);
  for (const change of [{ messageId: 'other-message' }, { messageType: 'text' }, { revision: 4 }, { feedbackId: 'other-feedback' }]) {
    const scope = f.ui.currentReferenceMediaContext({ ...source, ...change });
    assert.equal(scope.visible, false); assert.deepEqual(scope.referenceAttachments, []);
  }
  f.current.profile.childId = 'other-child'; assert.equal(f.ui.currentReferenceMediaContext(source).visible, false);
});

test('default quarantine and failed source lookup cannot open a current-file viewer', async () => {
  for (const delivery of [false, true]) {
    const opened = [], f = fixture({ delivery, api: { message: async () => delivery ? message(false, { hidden: true }) : mediaMessage() },
      callbacks: { onOpenCurrentReferenceAttachment: (...args) => opened.push(args) } });
    await f.ui.toggleReferenceSource('synthetic-source'); await f.ui.openCurrentReferenceAttachment('synthetic-source', currentFile().id);
    assert.equal(opened.length, 0);
    const scope = f.ui.currentReferenceMediaContext({ kind: 'current-reference', ...currentSource() });
    if (!delivery) assert.equal(scope.enabled, false); else assert.equal(scope.visible, false);
  }
});

test('current-file denial rechecks independent clinical authority while transient failure only clears current content', async () => {
  for (const error of [new LocalApiError('NOT_FOUND', 404), new LocalApiError('FORBIDDEN', 403), new LocalApiError('UNAVAILABLE')]) {
    const f = fixture({ delivery: true, api: { message: async () => mediaMessage() } }), before = f.preserved();
    await f.ui.toggleReferenceSource('synthetic-source'); const request = f.ui.referenceSource;
    await f.ui.currentReferenceMediaFailed({ kind: 'current-reference', ...currentSource() }, error);
    assert.equal(f.ui.referenceSource, null); assert.equal(request.signal.aborted, true);
    assert(!f.nodes[0].panel.innerHTML.includes('CURRENT-TEXT-SOURCE')); assert.equal(f.state.view, f.view);
    assert.equal(f.dialog.open, true); assert.deepEqual(f.preserved(), before); assert.deepEqual(f.errors, []);
    assert.equal(f.calls.filter(([kind]) => kind === 'profile').length, error.status ? 2 : 1);
  }
});

test('current-file AUTH_REQUIRED or confirmed clinical revocation clears owned state, not just file access', async () => {
  for (const auth of [true, false]) {
    const f = fixture({ delivery: true, api: { message: async () => mediaMessage() } });
    await f.ui.toggleReferenceSource('synthetic-source');
    if (!auth) f.ui.api.profile = async () => { throw new LocalApiError('FORBIDDEN', 403); };
    await f.ui.currentReferenceMediaFailed({ kind: 'current-reference', ...currentSource() }, new LocalApiError(auth ? 'AUTH_REQUIRED' : 'NOT_FOUND', auth ? 401 : 404));
    assert.equal(f.ui.states.size, 0); assert.equal(f.ui.dialog, null); assert.deepEqual(f.errors, [auth ? 'AUTH_REQUIRED' : 'FORBIDDEN']);
  }
});

test('a late failure from another source or older version cannot clear the current inspected source', async () => {
  const f = fixture({ delivery: true, api: { message: async () => mediaMessage() } });
  await f.ui.toggleReferenceSource('synthetic-source'); const request = f.ui.referenceSource;
  for (const change of [{ messageId: 'other-source' }, { revision: 2 }, { messageType: 'feedback', feedbackId: 'other-feedback' }]) {
    await f.ui.currentReferenceMediaFailed({ kind: 'current-reference', ...currentSource(), ...change }, new LocalApiError('AUTH_REQUIRED', 401));
    assert.equal(f.ui.referenceSource, request); assert.match(f.nodes[0].panel.innerHTML, /CURRENT-TEXT-SOURCE/); assert.deepEqual(f.errors, []);
  }
});
