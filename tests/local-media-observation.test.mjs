import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaUploadUi } from '../local-api/media-ui.js';
import { MediaApiError } from '../local-api/media-client.js';

const start = new Date('2026-10-14T00:00:00Z').getTime();
const uuid = (n) => `12345678-1234-4234-8234-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const tick = async (t, ms = 2000) => { t.mock.timers.tick(ms); await flush(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// This deliberately small DOM double counts destructive writes and tracks the
// nodes the observer is allowed to patch. It does not replace browser QA.
function hostDouble(document) {
  let html = '', rows = new Map();
  const details = { open: true }, help = { open: false }, notice = { textContent: '' };
  const host = {
    writes: 0, addEventListener() {}, removeEventListener() {}, contains: () => false,
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; this.writes++; rows = new Map(); document.activeElement = document.body;
      for (const match of value.matchAll(/<article data-testid="media-upload-row" data-media-id="([^"]+)">([\s\S]*?)<\/article>/g)) {
        const status = { textContent: /class="small media-file-status">([^<]*)/.exec(match[2])?.[1] ?? '' };
        const hint = { textContent: /class="small muted media-file-observation"[^>]*>([^<]*)/.exec(match[2])?.[1] ?? '', hidden: true };
        rows.set(match[1], { dataset: { mediaId: match[1] }, querySelector: (s) => s === '.media-file-status' ? status : s === '.media-file-observation' ? hint : null });
      }
    },
    replaceChildren() { this.innerHTML = ''; },
    querySelector(s) { return s === '[data-media-details]' ? details : s === '[data-media-help]' ? help : s === '[data-testid="media-upload-status"]' ? notice : null; },
    querySelectorAll(s) { return s === '[data-testid="media-upload-row"]' ? [...rows.values()] : []; },
    row(id) { return rows.get(id); },
  };
  return host;
}

function harness(t, { count = 1, deliveryEnabled = true, purpose = 'message', upload = {}, item = {}, context = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { visibilityState: 'visible', body: {}, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.activeElement = document.body;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let current = { user: { userId: 'synthetic-user' }, centerId: 'synthetic-center', roomId: 'synthetic-room', role: 'therapist',
    recordId: 'synthetic-record', feedbackId: 'synthetic-feedback', replyDraftId: 'synthetic-reply',
    generation: 1, connected: true, visible: true, signal: new AbortController().signal, ...context };
  const calls = [], errors = [], changes = [];
  const host = hostDouble(document);
  const api = {
    get: async (scope, id, signal) => { calls.push({ kind: 'get', scope, id, signal }); return { ...items.find((v) => v.upload?.id === id).upload }; },
    reserve: async () => { calls.push({ kind: 'reserve' }); throw new Error('Unexpected reservation'); },
    receive: async () => { calls.push({ kind: 'receive' }); throw new Error('Unexpected byte upload'); },
    cancel: async (scope, value, signal) => { calls.push({ kind: 'cancel', scope, id: value.id, signal }); return { ...value, state: 'deleted', version: value.version + 1 }; },
  };
  const ui = new MediaUploadUi({ api, deliveryEnabled, purpose, getContext: () => current,
    onChanged: () => changes.push(ui.busy), onError: (e) => errors.push(e) });
  ui.bind(host); ui.update();
  const key = ui.key;
  // Seed an already confirmed server-upload selection. Tests below never mark
  // content safe: readiness can only arrive through the mocked status GET.
  const items = Array.from({ length: count }, (_, i) => {
    const manifest = { name: `synthetic-${i}.png`, type: 'image/png', size: 9, sha256: '0'.repeat(64) };
    return { id: `selection-${i}`, clientId: `synthetic-client-${i}`, file: new File([new Uint8Array(9)], manifest.name, { type: manifest.type }),
      manifest, attempted: true, uncertain: false, cancelRequested: false, share: false,
      upload: { id: uuid(i + 1), conversationId: current.roomId, ...manifest, mode: 'prepared-delivery', source: { name: manifest.name, type: manifest.type, size: manifest.size },
        state: 'quarantined', version: 3, failureCode: null, expiresAt: new Date(start + 3600000).toISOString(), expired: false, ...upload }, ...item };
  });
  // A disallowed initial context has no state; install the same scoped local
  // selection while still leaving the public update/observer gate in force.
  const storedKey = key ?? JSON.stringify([current.user.userId, current.centerId, current.roomId, ...(purpose === 'message' ? [] : [current[purpose === 'record' ? 'recordId' : purpose === 'feedback' ? 'feedbackId' : 'replyDraftId']])]);
  if (!ui.states.has(storedKey)) ui.states.set(storedKey, { items: [], notice: '' });
  const state = ui.states.get(storedKey); state.items.push(...items);
  ui.update();
  t.after(() => {
    ui.clear();
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
  });
  return { ui, api, host, document, calls, errors, changes, items, state, key: storedKey,
    context: () => current,
    setContext(value, update = true) { current = { ...current, ...value }; if (update) ui.update(); },
    get(handler) { api.get = async (scope, id, signal) => { calls.push({ kind: 'get', scope, id, signal }); return handler(scope, id, signal); }; },
  };
}

for (const purpose of ['message', 'record', 'feedback', 'reply']) {
  test(`${purpose}: confirmed processing becomes ready using GET only without replacing controls`, async (t) => {
    const h = harness(t, { purpose }), item = h.items[0], control = {}, writes = h.host.writes;
    h.document.activeElement = control;
    h.get(() => ({ ...item.upload, state: 'ready', version: 4 }));
    assert.throws(() => h.ui.readyItems(), { code: 'MEDIA_BUSY' });
    await tick(t, 1999); assert.equal(h.calls.length, 0);
    await tick(t, 1);
    assert.deepEqual(h.calls.map((v) => v.kind), ['get']);
    assert.equal(h.calls[0].scope.roomId, 'synthetic-room');
    assert.equal(item.upload.state, 'ready'); assert.deepEqual(h.ui.readyItems(), [item]);
    assert.equal(h.ui.busy, null); assert(h.changes.every((value) => value === null));
    assert.equal(h.host.writes, writes); assert.equal(h.document.activeElement, control);
    assert.match(h.host.row(item.id).querySelector('.media-file-status').textContent, /준비 완료/);
    await tick(t, 150000); assert.equal(h.calls.length, 1);
  });
}

test('unchanged observations leave notice, controls, focus, busy state and change callbacks untouched', async (t) => {
  const h = harness(t), control = {}, writes = h.host.writes;
  h.document.activeElement = control;
  for (let n = 0; n < 4; n++) await tick(t);
  assert.equal(h.calls.length, 4); assert.equal(h.host.writes, writes);
  assert.equal(h.document.activeElement, control); assert.equal(h.ui.busy, null); assert.deepEqual(h.changes, []);
});

test('two files are observed fairly and no second GET starts while the first is pending', async (t) => {
  const h = harness(t, { count: 2 }), gate = deferred(); let first = true;
  h.get((scope, id) => { if (first) { first = false; return gate.promise; } return { ...h.items.find((v) => v.upload.id === id).upload }; });
  await tick(t); assert.equal(h.calls.length, 1);
  await tick(t, 6000); assert.equal(h.calls.length, 1);
  gate.resolve({ ...h.items[0].upload }); await flush();
  await tick(t); await tick(t); await tick(t);
  assert.deepEqual(h.calls.map((v) => v.id), [uuid(1), uuid(2), uuid(1), uuid(2)]);
});

test('ordinary updates do not renew the finite observation budget; explicit successful refresh does', async (t) => {
  const h = harness(t), item = h.items[0], file = item.file;
  for (let n = 0; n < 65; n++) { await tick(t); h.ui.update(); }
  assert(h.calls.length > 0 && h.calls.length <= 60);
  const stoppedCalls = h.calls.length;
  assert.match(item.observationNotice, /자동 확인을 멈췄어요/);
  assert.equal(item.file, file); assert.equal(item.uncertain, false);
  for (let n = 0; n < 3; n++) { h.ui.update(); await tick(t, 120000); }
  assert.equal(h.calls.length, stoppedCalls);
  assert.equal(await h.ui.action('refresh', item.id), true);
  assert.equal(item.observationNotice, '');
  await tick(t); assert.equal(h.calls.length, stoppedCalls + 2);
});

test('the time budget aborts an in-flight GET instead of waiting past the observation deadline', async (t) => {
  const h = harness(t); let signal;
  h.get((scope, id, captured) => { signal = captured; return new Promise((resolve, reject) => captured.addEventListener('abort', () => reject(new MediaApiError('CANCELLED')), { once: true })); });
  await tick(t); assert(signal && !signal.aborted);
  await tick(t, 118000); assert.equal(signal.aborted, true);
  assert.match(h.items[0].observationNotice, /자동 확인을 멈췄어요/);
  await tick(t, 100000); assert.equal(h.calls.length, 1);
});

for (const change of [{ roomId: 'other-room' }, { user: { userId: 'other-user' } }, { role: 'guardian' }, { generation: 2 }]) {
  for (const outcome of ['ready', 'denied']) {
    test(`late ${outcome} result is ignored after ${Object.keys(change)[0]} changes`, async (t) => {
      const h = harness(t), item = h.items[0], original = item.upload, gate = deferred();
      h.get(() => gate.promise); await tick(t);
      h.setContext(change);
      if (outcome === 'ready') gate.resolve({ ...original, state: 'ready', version: 4 });
      else gate.reject(new MediaApiError('FORBIDDEN', 403));
      await flush();
      assert.equal(item.upload, original); assert.deepEqual(h.errors, []);
      if (!change.user) assert.equal(item.file instanceof File, true);
    });
  }
}

for (const stop of ['begin', 'suspend', 'forget', 'bind', 'retain']) {
  test(`${stop} aborts the observer and ignores its late successful result`, async (t) => {
    const h = harness(t), item = h.items[0], original = item.upload, gate = deferred(); let signal;
    h.get((scope, id, captured) => { signal = captured; return gate.promise; });
    await tick(t);
    let manual;
    if (stop === 'begin') manual = h.ui.begin();
    if (stop === 'suspend') h.ui.suspend();
    if (stop === 'forget') h.ui.forgetSent({ userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' }, [uuid(1)]);
    if (stop === 'bind') h.ui.bind(null);
    if (stop === 'retain') h.ui.retainRooms('synthetic-user', 'synthetic-center', []);
    assert.equal(signal.aborted, true);
    gate.resolve({ ...original, state: 'ready', version: 4 }); await flush();
    assert.equal(item.upload, original);
    if (manual) h.ui.finish(manual);
  });
}

test('manual cancel aborts automatic observation and cancels only the resolved current upload', async (t) => {
  const h = harness(t), item = h.items[0], original = item.upload, gate = deferred(); let first = true, signal;
  h.get((scope, id, captured) => { if (first) { first = false; signal = captured; return gate.promise; } return { ...original }; });
  await tick(t); assert.equal(await h.ui.action('cancel', item.id), true);
  assert.equal(signal.aborted, true); assert.equal(item.file, null); assert.deepEqual(h.state.items, []);
  gate.resolve({ ...original, state: 'ready', version: 4 }); await flush();
  assert.deepEqual(h.state.items, []); assert.deepEqual(h.calls.map((v) => v.kind), ['get', 'get', 'cancel']);
});

const ineligible = [
  ['unconfirmed', { item: { attempted: false } }], ['uncertain', { item: { uncertain: true } }],
  ['cancel requested', { item: { cancelRequested: true } }], ['unknown upload', { item: { upload: null } }],
  ['pending', { upload: { state: 'pending' } }], ['ready', { upload: { state: 'ready' } }],
  ['bound', { upload: { state: 'bound', expiresAt: null } }], ['rejected', { upload: { state: 'rejected' } }],
  ['deleted', { upload: { state: 'deleted' } }], ['deleting', { upload: { state: 'delete_pending' } }],
  ['expired flag', { upload: { expired: true } }], ['elapsed expiry', { upload: { expiresAt: new Date(start - 1).toISOString() } }],
  ['invalid expiry', { upload: { expiresAt: 'invalid' } }], ['quarantine only', { deliveryEnabled: false }],
  ['unprepared response', { upload: { mode: 'quarantine-only' } }], ['hidden context', { context: { visible: false } }],
  ['disconnected', { context: { connected: false } }], ['cleanup', { context: { cleanupOnly: true } }],
  ['message operation', { context: { messageOperation: { clientId: 'immutable' } } }],
];
for (const [name, options] of ineligible) {
  test(`${name}: no automatic API request`, async (t) => {
    const h = harness(t, options); await tick(t, 180000); h.ui.update(); await tick(t);
    assert.deepEqual(h.calls, []);
  });
}

test('hidden document stops a pending observation before its GET and keeps the selection', async (t) => {
  const h = harness(t), item = h.items[0], file = item.file;
  h.document.visibilityState = 'hidden'; await tick(t);
  assert.deepEqual(h.calls, []); assert.equal(item.file, file);
});

test('message operation beginning while a GET is pending blocks its response without changing immutable selection', async (t) => {
  const h = harness(t), item = h.items[0], original = item.upload, gate = deferred();
  h.get(() => gate.promise); await tick(t);
  h.setContext({ messageOperation: { clientId: 'immutable' } });
  assert.equal(h.calls[0].signal.aborted, true);
  gate.resolve({ ...original, state: 'ready', version: 4 }); await flush();
  assert.equal(item.upload, original); assert.equal(item.clientId, 'synthetic-client-0');
});

for (const code of ['UNAVAILABLE', 'INVALID_RESPONSE']) {
  test(`${code} preserves the complete selection and stops with a fixed manual-refresh hint`, async (t) => {
    const h = harness(t), item = h.items[0], original = item.upload, file = item.file;
    h.get(() => { throw new MediaApiError(code); }); await tick(t);
    assert.equal(item.upload, original); assert.equal(item.file, file); assert.equal(item.clientId, 'synthetic-client-0');
    assert.equal(item.uncertain, false); assert.match(item.observationNotice, /상태 갱신으로 다시 확인/);
    h.ui.update(); await tick(t, 180000); assert.equal(h.calls.length, 1); assert.deepEqual(h.errors, []);
  });
}

for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND']) {
  test(`current ${code} clears only the authorized-room selection and invokes the existing denial path`, async (t) => {
    const h = harness(t), item = h.items[0];
    h.get(() => { throw new MediaApiError(code, code === 'AUTH_REQUIRED' ? 401 : code === 'FORBIDDEN' ? 403 : 404); });
    await tick(t); assert.equal(item.file, null); assert.equal(h.ui.states.has(h.key), false);
    assert.deepEqual(h.errors.map((e) => e.code), [code]); await tick(t, 180000); assert.equal(h.calls.length, 1);
  });
}

test('a recoverable scanner-unavailable state is observed but never retried or approved by the client', async (t) => {
  const h = harness(t, { upload: { failureCode: 'SCAN_UNAVAILABLE' } }), item = h.items[0];
  h.get(() => ({ ...item.upload, state: 'ready', failureCode: null, version: 4 }));
  await tick(t); assert.equal(item.upload.state, 'ready'); assert.deepEqual(h.calls.map((v) => v.kind), ['get']);
});

for (const change of [{ id: uuid(9) }, { conversationId: 'other-room' }, { version: 2 }, { mode: 'quarantine-only' }, { state: 'pending' }]) {
  test(`inconsistent status ${JSON.stringify(change)} is not applied`, async (t) => {
    const h = harness(t), item = h.items[0], original = item.upload;
    h.get(() => ({ ...original, ...change })); await tick(t);
    assert.equal(item.upload, original); assert.match(item.observationNotice, /자동 확인을 멈췄어요/);
    assert.deepEqual(h.errors, []);
  });
}

test('a version-only status update does not rewrite DOM or emit a presentation change', async (t) => {
  const h = harness(t), item = h.items[0], writes = h.host.writes;
  h.get(() => ({ ...item.upload, version: item.upload.version + 1 }));
  await tick(t); assert.equal(item.upload.version, 4);
  assert.equal(h.host.writes, writes); assert.deepEqual(h.changes, []);
});

test('background readiness does not overwrite a manual selection error', async (t) => {
  const h = harness(t), item = h.items[0];
  h.state.notice = '지원 형식·파일 이름·용량을 확인해 주세요.'; h.ui.render();
  h.get(() => ({ ...item.upload, state: 'ready', version: 4 }));
  await tick(t);
  assert.equal(item.upload.state, 'ready');
  assert.equal(h.state.notice, '지원 형식·파일 이름·용량을 확인해 주세요.');
  assert.match(h.host.row(item.id).querySelector('.media-file-status').textContent, /준비 완료/);
});

for (const state of ['rejected', 'bound', 'delete_pending', 'deleted']) {
  test(`observing terminal ${state} stops without automatically cancelling, sending or deleting retained bytes`, async (t) => {
    const h = harness(t), item = h.items[0], file = item.file;
    h.get(() => ({ ...item.upload, state, version: 4, ...(state === 'bound' ? { expiresAt: null } : {}) }));
    await tick(t); assert.equal(item.upload.state, state); assert.equal(item.file, file);
    assert.throws(() => h.ui.readyItems(), { code: 'MEDIA_BUSY' });
    await tick(t, 180000); assert.deepEqual(h.calls.map((v) => v.kind), ['get']);
  });
}

test('expiry from a status response blocks capture and ends observation while keeping the selection', async (t) => {
  const h = harness(t), item = h.items[0], file = item.file;
  h.get(() => ({ ...item.upload, expired: true, version: 4 }));
  await tick(t); assert.equal(item.upload.expired, true); assert.equal(item.file, file);
  assert.match(h.host.row(item.id).querySelector('.media-file-status').textContent, /만료/);
  assert.throws(() => h.ui.readyItems(), { code: 'MEDIA_BUSY' });
  await tick(t, 180000); assert.equal(h.calls.length, 1);
});

test('parent lifetime abort discards ready and authority errors without clearing selections itself', async (t) => {
  const parent = new AbortController();
  const h = harness(t, { context: { signal: parent.signal } }), item = h.items[0], original = item.upload, gate = deferred();
  h.get(() => gate.promise); await tick(t);
  parent.abort(); assert.equal(h.calls[0].signal.aborted, true);
  gate.reject(new MediaApiError('FORBIDDEN', 403)); await flush();
  assert.equal(item.upload, original); assert(item.file instanceof File); assert.deepEqual(h.errors, []);
  await tick(t, 180000); assert.equal(h.calls.length, 1);
});

test('a replaced upload snapshot makes an otherwise successful old GET stale', async (t) => {
  const h = harness(t), item = h.items[0], gate = deferred(), original = item.upload;
  h.get(() => gate.promise); await tick(t);
  const replacement = { ...original, state: 'inspecting', version: 4 }; item.upload = replacement;
  gate.resolve({ ...original, state: 'ready', version: 5 }); await flush();
  assert.equal(item.upload, replacement); assert.deepEqual(h.errors, []);
});

test('a failed manual refresh does not renew a stopped observer budget', async (t) => {
  const h = harness(t), item = h.items[0];
  h.get(() => { throw new MediaApiError('UNAVAILABLE'); }); await tick(t);
  const budget = h.ui.observationBudgets.get(item);
  assert.equal(await h.ui.action('refresh', item.id), false);
  assert.equal(h.ui.observationBudgets.get(item), budget); assert.equal(budget.stopped, true);
  await tick(t, 180000); assert.equal(h.calls.length, 2);
});

test('one file observation error does not prevent observing another queued file', async (t) => {
  const h = harness(t, { count: 2 });
  h.get((scope, id) => {
    if (id === uuid(1)) throw new MediaApiError('UNAVAILABLE');
    return { ...h.items[1].upload, state: 'ready', version: 4 };
  });
  await tick(t); await tick(t);
  assert.match(h.items[0].observationNotice, /자동 확인을 멈췄어요/);
  assert.equal(h.items[1].upload.state, 'ready');
  assert.deepEqual(h.calls.map((v) => v.id), [uuid(1), uuid(2)]);
});
