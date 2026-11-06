import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaUploadUi, mediaUploadMarkup, MEDIA_MEMORY_FILE_LIMIT } from '../local-api/media-ui.js';
import { MediaApiError } from '../local-api/media-client.js';
import { MEDIA_LIMITS } from '../src/media-policy.js';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const file = (name = 'synthetic.png') => new File([bytes], name, { type: 'image/png' });
const uploadId = '12345678-1234-4234-8234-123456789abc';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function harness(overrides = {}, options = {}) {
  let context = { user: { userId: 'synthetic-user' }, centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1, signal: new AbortController().signal };
  let count = 0; const calls = [], errors = [];
  const dto = (changes = {}) => ({ id: uploadId, conversationId: context.roomId, name: 'synthetic.png', type: 'image/png', size: bytes.length,
    state: 'pending', version: 1, failureCode: null, expiresAt: '2030-01-01T00:00:00Z', expired: false, ...changes });
  const api = { reserve: async (...args) => { calls.push(['reserve', ...args]); return dto(); },
    get: async (...args) => { calls.push(['get', ...args]); return dto(); },
    receive: async (...args) => { calls.push(['receive', ...args]); return dto({ state: 'quarantined', version: 3 }); },
    cancel: async (...args) => { calls.push(['cancel', ...args]); return dto({ state: 'delete_pending', version: 4 }); }, ...overrides };
  const host = { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() { this.innerHTML = ''; }, addEventListener() {}, removeEventListener() {} };
  const ui = new MediaUploadUi({ api, getContext: () => context, onError: (e) => errors.push(e), createId: () => `12345678-1234-4234-8234-${String(++count).padStart(12, '0')}`, ...options });
  ui.bind(host); ui.update();
  return { ui, api, host, calls, errors, dto, state: () => ui.states.get(ui.key), item: () => ui.states.get(ui.key)?.items[0],
    setContext: (v) => { context = { ...context, ...v }; ui.update(); }, context: () => context };
}

test('selection is memory-only, hashed, immutable and sends no request or preview', async () => {
  const h = harness(); assert.equal(await h.ui.select([file()]), true);
  assert.equal(h.calls.length, 0); assert(h.item().file instanceof File); assert(Object.isFrozen(h.item().manifest));
  assert.equal(h.item().manifest.sha256.length, 64); assert.equal(h.item().attempted, false);
  assert.match(h.host.innerHTML, /가상 자료/); assert.match(h.host.innerHTML, /검사 서버/); assert.match(h.host.innerHTML, /상대에게 전송되지/);
  assert(!/<img\b|<video\b|blob:|data:|href=/.test(h.host.innerHTML));
});
test('upload reserves once and sends bytes only in pending state, with the captured room/account', async () => {
  const h = harness(); await h.ui.select([file()]); const original = h.item();
  await h.ui.action('upload', original.id);
  assert.deepEqual(h.calls.map((c) => c[0]), ['reserve', 'receive']);
  assert.deepEqual(h.calls[0][1], { userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' });
  assert.equal(h.calls[0][2].clientId, original.clientId); assert.equal(h.calls[1][3], original.file);
  assert.equal(original.upload.state, 'quarantined'); assert.equal(original.uncertain, false);
  assert.match(h.state().notice, /상대방 전송은 진행되지/);
});
test('reserve response loss retries the exact ID and manifest, not a new upload', async () => {
  const h = harness(); let first = true;
  h.api.reserve = async (...args) => { h.calls.push(['reserve', ...args]); if (first) { first = false; throw new MediaApiError('UNAVAILABLE'); } return h.dto(); };
  await h.ui.select([file()]); const item = h.item(), original = item.file;
  assert.equal(await h.ui.action('upload', item.id), false); assert.equal(item.file, original); assert(item.uncertain);
  await h.ui.action('upload', item.id);
  const reservations = h.calls.filter((c) => c[0] === 'reserve');
  assert.deepEqual(reservations[0][2], reservations[1][2]); assert.equal(item.upload.state, 'quarantined');
});
test('receive response loss checks status and never resends bytes already quarantined', async () => {
  const h = harness(); h.api.receive = async (...args) => { h.calls.push(['receive', ...args]); throw new MediaApiError('UNAVAILABLE'); };
  h.api.get = async (...args) => { h.calls.push(['get', ...args]); return h.dto({ state: 'quarantined', version: 3 }); };
  await h.ui.select([file()]); const item = h.item(); await h.ui.action('upload', item.id); assert(item.uncertain);
  await h.ui.action('upload', item.id);
  assert.deepEqual(h.calls.map((c) => c[0]), ['reserve', 'receive', 'get']); assert.equal(item.upload.state, 'quarantined');
});
test('receiving state cannot be blindly retried, while confirmed pending uses its current version', async () => {
  for (const state of ['receiving', 'pending']) {
    const h = harness(); await h.ui.select([file()]); const item = h.item(); item.attempted = true; item.upload = h.dto({ version: 2 });
    h.api.get = async (...args) => { h.calls.push(['get', ...args]); return h.dto({ state, version: 5 }); };
    await h.ui.action('upload', item.id);
    assert.deepEqual(h.calls.map((c) => c[0]), state === 'pending' ? ['get', 'receive'] : ['get']);
    if (state === 'pending') assert.equal(h.calls[1][2].version, 5);
  }
});
test('cancel failure retains bytes and intent; replay resolves status before attempting cancellation again', async () => {
  const h = harness(); await h.ui.select([file()]); const item = h.item(); await h.ui.action('upload', item.id);
  h.api.get = async (...args) => { h.calls.push(['get', ...args]); return h.dto({ state: 'quarantined', version: 3 }); };
  let first = true;
  h.api.cancel = async (...args) => { h.calls.push(['cancel', ...args]); if (first) { first = false; throw new MediaApiError('UNAVAILABLE'); } return h.dto({ state: 'delete_pending', version: 4 }); };
  assert.equal(await h.ui.action('cancel', item.id), false); assert.equal(h.item(), item); assert(item.file); assert(item.cancelRequested);
  await h.ui.action('upload', item.id); assert.equal(h.calls.filter((c) => c[0] === 'receive').length, 1);
  await h.ui.action('cancel', item.id); assert.equal(h.state().items.length, 0); assert.equal(item.file, null);
  assert.match(h.state().notice, /실제 정리는 서버/);
});
test('cancel of an unknown reservation first recovers the same ID and never sends file bytes', async () => {
  const h = harness(); await h.ui.select([file()]); const item = h.item(); item.attempted = true; item.uncertain = true;
  await h.ui.action('cancel', item.id);
  assert.deepEqual(h.calls.map((c) => c[0]), ['reserve', 'cancel']); assert.equal(h.calls[0][2].clientId, item.clientId);
  assert.equal(item.file, null);
});
test('unreserved selection cancel is local, whereas refresh of acknowledged cancellation releases bytes', async () => {
  const h = harness(); await h.ui.select([file()]); await h.ui.action('cancel', h.item().id); assert.equal(h.calls.length, 0);
  await h.ui.select([file()]); const item = h.item(); item.attempted = true; item.upload = h.dto();
  h.api.get = async () => h.dto({ state: 'deleted', version: 4 });
  await h.ui.action('refresh', item.id); assert.equal(h.state().items.length, 0); assert.equal(item.file, null);
});
test('a failed multi-file selection preserves all existing files and adds none of the batch', async () => {
  const h = harness(); await h.ui.select([file()]); const first = h.item();
  const ok = await h.ui.select([file('second.png'), new File(['bad'], 'bad.png', { type: 'image/png' })]);
  assert.equal(ok, false); assert.deepEqual(h.state().items, [first]); assert(first.file);
});
test('per-room count and global cross-room byte caps are enforced before reading any incoming bytes', async () => {
  const h = harness(); await h.ui.select(Array.from({ length: 6 }, (_, i) => file(`synthetic-${i}.png`)));
  assert.equal(await h.ui.select([file()]), false); assert.equal(h.state().items.length, 6);
  h.ui.states.set('other-owned-room', { items: [{ manifest: { size: MEDIA_LIMITS.total } }], notice: '' });
  h.setContext({ roomId: 'second-room' }); assert.equal(await h.ui.select([file()]), false); assert.equal(h.state().items.length, 0);
});
test('global busy bounds hashing across room switches and ignores a late completed selection', async () => {
  const h = harness(), gate = deferred(), started = deferred(), slow = file();
  Object.defineProperty(slow, 'arrayBuffer', { value: async () => { started.resolve(); await gate.promise; return bytes.slice().buffer; } });
  const pending = h.ui.select([slow]); await started.promise;
  h.setContext({ roomId: 'second-room' }); assert.equal(await h.ui.select([file()]), false);
  gate.resolve(); assert.equal(await pending, false); assert.equal(h.state().items.length, 0);
  assert.equal(await h.ui.select([file()]), true);
});
test('suspension wipes DOM but preserves scoped selection and cannot be undone by late completion', async () => {
  const gate = deferred(), started = deferred(), h = harness(); await h.ui.select([file()]); const item = h.item();
  h.api.reserve = async () => { started.resolve(); await gate.promise; return h.dto(); };
  const pending = h.ui.action('upload', item.id); await started.promise;
  h.ui.suspend(); assert.equal(h.host.innerHTML, ''); assert(item.file);
  gate.resolve(); await pending; assert.equal(h.host.innerHTML, ''); assert.equal(item.upload, null); assert(item.uncertain);
  h.ui.update(); assert.match(h.host.innerHTML, /synthetic.png/);
});
test('room drafts remain distinct and a late previous-room response never appears in the next room', async () => {
  const h = harness(); await h.ui.select([file()]); const first = h.item(), oldKey = h.ui.key;
  h.setContext({ roomId: 'second-room' }); await h.ui.select([file('second.png')]); assert.equal(h.item().manifest.name, 'second.png');
  assert(!h.host.innerHTML.includes('synthetic.png')); assert.equal(h.ui.states.get(oldKey).items[0], first);
  h.setContext({ roomId: 'synthetic-room' }); assert.equal(h.item(), first);
});
test('account change, explicit clear and permission loss release File references and UI', async () => {
  const h = harness(); await h.ui.select([file()]); const item = h.item();
  h.setContext({ user: { userId: 'another-user' } }); assert.equal(item.file, null); assert.equal(h.state().items.length, 0);
  await h.ui.select([file()]); const second = h.item(); h.ui.clear(); assert.equal(second.file, null); assert.equal(h.host.innerHTML, '');
  h.ui.update(); await h.ui.select([file()]); const third = h.item();
  h.api.reserve = async () => { throw new MediaApiError('NOT_FOUND', 404); };
  await h.ui.action('upload', third.id); assert.equal(third.file, null); assert.equal(h.host.innerHTML, ''); assert.equal(h.errors[0].code, 'NOT_FOUND');
});
test('malformed status and unacknowledged cancel never silently drop the original file', async () => {
  const h = harness(); await h.ui.select([file()]); const item = h.item();
  h.api.reserve = async () => h.dto({ name: 'different.png' }); await h.ui.action('upload', item.id);
  assert(item.file); assert.equal(item.upload, null); assert(item.uncertain);
  h.api.reserve = async () => h.dto(); h.api.cancel = async () => h.dto();
  await h.ui.action('cancel', item.id); assert.equal(h.item(), item); assert(item.file); assert(item.uncertain);
});
test('panel escapes names and notices, exposes no hash/private fields, and uses native accessible controls', () => {
  const html = mediaUploadMarkup({ notice: '<script>PRIVATE</script>', items: [{ id: 'local-id', manifest: { name: '<img onerror="bad">.png', size: 10, sha256: 'NEVER-HASH' },
    attempted: true, uncertain: true, cancelRequested: true, upload: { state: 'receiving', objectKey: 'NEVER-KEY' } }] }, true);
  assert.match(html, /<details/); assert.match(html, /aria-label="시험용 사진·영상 선택"/); assert.match(html, /role="status"/);
  assert.match(html, /&lt;img/); assert(!html.includes('<script>')); assert(!html.includes('NEVER-'));
  assert.match(html, /disabled/); assert(!/<img\b|<video\b|href=/.test(html));
});

test('purpose-specific delivery scope and synthetic-only warning remain outside collapsed file help', () => {
  for (const [purpose, scope, destination] of [
    ['message', '메시지와 함께 대화에 전송', '다음 메시지와 함께 현재 대화 참여자'],
    ['record', '기본 비공개 · 기록에 보관', '파일별 선택 → 기록 저장 → 공유 미리보기 확인'],
    ['feedback', '활동 경험 저장 시 대화에 공유', '활동 경험 저장 시 이 대화 참여자에게 함께 공유'],
    ['reply', '답장과 함께 대화에 전송', '원문의 파일은 자동으로 첨부하지 않으며'],
  ]) {
    const html = mediaUploadMarkup({ items: [] }, false, true, true, false, purpose);
    const visible = html.slice(0, html.indexOf('<details class="media-upload-help"'));
    assert(visible.includes(scope)); assert(visible.includes(destination));
    assert(visible.includes('가상 자료만 사용하는 시험')); assert(visible.includes('실제 아동의 사진·영상은 선택하지'));
    assert.match(html, /<details class="media-upload-help" data-media-help>/);
    assert.match(html, /aria-label="시험용 사진·영상 선택"/);
    assert.match(html, /role="status" aria-live="polite" data-testid="media-upload-status"/);
    if (purpose !== 'record') assert(visible.includes('업로드만으로'));
  }
  const quarantine = mediaUploadMarkup({ items: [] });
  assert.match(quarantine, /격리 보관 시험 · 전송 안 함/); assert.match(quarantine, /상대에게 전송되지/);
  assert(!quarantine.includes('메시지와 함께 대화에 전송'));
});

test('file help distinguishes one attachment batch from retained drafts without hiding delivery warnings', () => {
  const html = mediaUploadMarkup({ items: [] }, false, true, true, false, 'record');
  const help = html.match(/<details class="media-upload-help"[\s\S]*?<\/details>/)?.[0];
  assert(help); assert.match(help, /최대 6개/); assert.match(help, /사진 10MB, 동영상 50MB 이하/);
  assert.match(help, /여러 화면에 임시 보관 중인 기록 첨부 선택 합계 24개·100MB/);
  assert.match(help, /선택 목록은 새로고침하면 사라집니다/);
  assert.match(help, /비공개 시험 폴더/); assert.match(help, /서버 정리 전에는 직접 삭제하지/);
  assert(!help.includes('기본 비공개')); assert(!help.includes('실제 아동'));
});

test('long record filenames appear once visually while checkbox keeps its full escaped accessible name', () => {
  const name = `${'가상파일이름'.repeat(40)}<사진>&".png`;
  const escaped = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const item = { id: 'synthetic-selection', manifest: { name, size: 1024, sha256: 'DO-NOT-EXPOSE' }, share: false };
  const html = mediaUploadMarkup({ items: [item] }, false, true, true, false, 'record');
  assert(html.includes(`<p class="account media-file-name">${escaped}</p>`));
  assert(html.includes(`aria-label="보호자 공유에 포함 · ${escaped}"`));
  assert.match(html, />보호자 공유에 포함<\/label>/);
  const visible = html.replace(/<[^>]+>/g, '');
  assert.equal(visible.split(escaped).length - 1, 1);
  assert(!html.includes('DO-NOT-EXPOSE')); assert(!html.includes('<사진>'));
  assert.match(html, /media-file-meta">1 KB<\/p>/);
  assert.match(html, /media-file-status">선택됨 · 아직 서버에 보내지 않음<\/p>/);
  assert.match(html, /data-media-action="upload"/); assert.match(html, /data-media-action="cancel"/);
  const checkbox = html.match(/<input type="checkbox"[^>]*>/)?.[0]; assert(checkbox); assert(!checkbox.includes('checked'));
});
test('tiny files across many rooms cannot bypass the global retained-file count bound', async () => {
  const h = harness();
  h.ui.states.set('other-owned-rooms', { items: Array.from({ length: MEDIA_MEMORY_FILE_LIMIT }, () => ({ manifest: { size: 1 } })), notice: '' });
  assert.equal(await h.ui.select([file()]), false); assert.equal(h.state().items.length, 0); assert.equal(h.calls.length, 0);
});
test('unchanged polling leaves details, file chooser and DOM untouched', () => {
  const h = harness(); let writes = 0, html = h.host.innerHTML;
  Object.defineProperty(h.host, 'innerHTML', { get: () => html, set: (value) => { writes++; html = value; } });
  h.host.querySelector = (selector) => selector === '[data-media-details]' ? { open: true } : null;
  h.ui.update(); h.ui.update(); assert.equal(writes, 0);
  h.state().notice = '새 상태'; h.ui.update(); assert.equal(writes, 1); assert.match(html, /data-media-details open/);
  h.ui.update(); assert.equal(writes, 1);
  h.ui.suspend(); assert.equal(html, ''); h.ui.update(); assert.match(html, /대화에 사진·영상 첨부/);
});

test('changed status preserves opened file help and restores its own summary instead of the outer summary', { concurrency: false }, () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const h = harness(); let help = { open: true }, focused = null, writes = 0, html = h.host.innerHTML;
  const helpSummary = { matches: (selector) => ['[data-media-help-summary]', 'summary'].includes(selector), focus: () => { focused = 'help'; } };
  const outerSummary = { focus: () => { focused = 'outer'; } };
  Object.defineProperty(h.host, 'innerHTML', { get: () => html, set: (value) => { writes++; html = value; help = { open: false }; } });
  h.host.contains = (node) => node === helpSummary;
  h.host.querySelector = (selector) => selector === '[data-media-help]' ? help
    : selector === '[data-media-help-summary]' ? helpSummary
      : selector === '[data-media-details]' ? { open: true } : selector === 'summary' ? outerSummary : null;
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: helpSummary } });
    h.ui.update(); assert.equal(writes, 0); assert.equal(help.open, true);
    h.state().notice = '갱신된 상태'; h.ui.update();
    assert.equal(writes, 1); assert.equal(help.open, true); assert.equal(focused, 'help');
    help.open = false; h.state().notice = '다음 상태'; h.ui.update();
    assert.equal(writes, 2); assert.equal(help.open, false); assert.equal(focused, 'help');
  } finally {
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  }
});
test('changed markup retains summary, file input and existing action focus without fabricating a removed action', { concurrency: false }, () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    for (const kind of ['summary', 'file', 'action', 'removed-action']) {
      const h = harness(); let focused = null;
      const element = { dataset: kind.includes('action') ? { mediaAction: 'cancel', mediaId: 'local' } : {},
        matches: (selector) => kind === 'summary' ? selector === 'summary' : kind === 'file' && selector === 'input[type="file"]' };
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: element } });
      const summary = { focus: () => { focused = 'summary'; } }, input = { focus: () => { focused = 'file'; } };
      const action = { dataset: { mediaAction: 'cancel', mediaId: 'local' }, focus: () => { focused = 'action'; } };
      h.host.contains = () => true;
      h.host.querySelector = (selector) => selector === 'summary' ? summary : selector === 'input[type="file"]' ? input : null;
      h.host.querySelectorAll = () => kind === 'action' ? [action] : [];
      h.state().notice = '달라진 상태'; h.ui.render();
      assert.equal(focused, kind === 'removed-action' ? 'summary' : kind);
    }
  } finally {
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  }
});

test('complete room retention removes a revoked inactive draft without touching other centers/accounts', async () => {
  const h = harness(); await h.ui.select([file()]); const removed = h.item(), oldKey = h.ui.key;
  h.setContext({ roomId: 'second-room' }); await h.ui.select([file('second.png')]); const kept = h.item();
  const otherCenter = { items: [{ file: file('other-center.png') }], notice: '' };
  const otherUser = { items: [{ file: file('other-user.png') }], notice: '' };
  const centerKey = JSON.stringify(['synthetic-user', 'other-center', 'synthetic-room']);
  const userKey = JSON.stringify(['other-user', 'synthetic-center', 'synthetic-room']);
  h.ui.states.set(centerKey, otherCenter); h.ui.states.set(userKey, otherUser);
  assert.equal(h.ui.retainRooms('synthetic-user', 'synthetic-center', ['second-room']), 1);
  assert.equal(removed.file, null); assert(!h.ui.states.has(oldKey)); assert.equal(h.item(), kept);
  assert.equal(h.ui.states.get(centerKey), otherCenter); assert(otherCenter.items[0].file);
  assert.equal(h.ui.states.get(userKey), otherUser); assert(otherUser.items[0].file);
  h.ui.retainRooms('synthetic-user', 'synthetic-center', ['synthetic-room', 'second-room']);
  h.setContext({ roomId: 'synthetic-room' }); assert.equal(h.state().items.length, 0);
  assert.equal(h.calls.length, 0);
});
test('invalid room lists cannot partially remove a draft and an explicitly empty complete list clears its scope', async () => {
  const h = harness(); await h.ui.select([file()]); const selected = h.item();
  for (const rooms of [null, {}, ['bad/room'], ['same', 'same'], ['second-room', null]]) {
    assert.throws(() => h.ui.retainRooms('synthetic-user', 'synthetic-center', rooms), (e) => e.code === 'INVALID_INPUT');
    assert.equal(h.item(), selected); assert(selected.file);
  }
  assert.equal(h.ui.retainRooms('synthetic-user', 'synthetic-center', []), 1);
  assert.equal(selected.file, null); assert.equal(h.host.innerHTML, '');
});
test('revocation while a previous room request settles cannot restore files or old upload IDs on reconnect', async () => {
  const h = harness(), gate = deferred(), started = deferred(); await h.ui.select([file()]);
  const old = h.item(), oldKey = h.ui.key;
  h.api.reserve = async (_scope, _input, signal) => { started.resolve(signal); await gate.promise; return h.dto({ conversationId: 'synthetic-room' }); };
  const pending = h.ui.action('upload', old.id); const signal = await started.promise;
  h.setContext({ roomId: 'second-room' });
  const nextRoomMarkup = h.host.innerHTML;
  h.ui.retainRooms('synthetic-user', 'synthetic-center', ['second-room']);
  assert(signal.aborted); assert.equal(old.file, null); assert(!h.ui.states.has(oldKey));
  assert.equal(h.host.innerHTML, nextRoomMarkup); assert(h.ui.active);
  gate.resolve(); assert.equal(await pending, false); assert.equal(old.upload, null);
  h.setContext({ roomId: 'synthetic-room' }); assert.equal(h.state().items.length, 0);
});

// A small DOM double deliberately reproduces browser focus behavior: replacing
// a focused node moves focus to body, and disabled controls ignore focus().
async function withFocusDom(h, work) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set(), body = { matches: () => false }, doc = { activeElement: body,
    addEventListener(type, fn) { if (type === 'focusin') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'focusin') listeners.delete(fn); } };
  let nodes = [], html = '';
  const node = (kind, dataset = {}, disabled = false) => ({ kind, dataset, disabled,
    matches(selector) {
      return kind === 'file' && selector === 'input[type="file"]' || kind === 'summary' && selector === 'summary' ||
        selector.includes(',') && selector.split(',').includes(kind === 'file' ? 'input' : kind === 'summary' ? 'summary' : 'button');
    },
    focus() { if (!this.disabled) { doc.activeElement = this; for (const fn of listeners) fn({ target: this }); } },
  });
  Object.defineProperty(h.host, 'innerHTML', { configurable: true, get: () => html, set(value) {
    if (nodes.includes(doc.activeElement)) doc.activeElement = body;
    html = value; nodes = [];
    if (value.includes('<summary>')) nodes.push(node('summary'));
    const input = value.match(/<input\b[^>]*>/)?.[0]; if (input) nodes.push(node('file', {}, /\bdisabled\b/.test(input)));
    for (const match of value.matchAll(/data-media-action="([^"]+)" data-media-id="([^"]+)"([^>]*)/g))
      nodes.push(node('action', { mediaAction: match[1], mediaId: match[2] }, /\bdisabled\b/.test(match[3])));
  } });
  h.host.contains = (candidate) => nodes.includes(candidate);
  h.host.querySelector = (selector) => selector === '[data-media-details]' ? { open: true }
    : nodes.find((n) => selector === 'summary' ? n.kind === 'summary' : selector === 'input[type="file"]' && n.kind === 'file') ?? null;
  h.host.querySelectorAll = () => nodes.filter((n) => n.kind === 'action');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    h.ui.painted = null; h.ui.render();
    await work({ doc, body, listeners, current: (kind, action) => nodes.find((n) => n.kind === kind && (!action || n.dataset.mediaAction === action)),
      external: () => node('external'), focusBody: () => { doc.activeElement = body; } });
  } finally {
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  }
}
test('a temporarily disabled file input regains focus after selection completes', { concurrency: false }, async () => {
  const h = harness(), started = deferred(), gate = deferred(), slow = file();
  Object.defineProperty(slow, 'arrayBuffer', { value: async () => { started.resolve(); await gate.promise; return bytes.slice().buffer; } });
  await withFocusDom(h, async ({ doc, body, current, listeners }) => {
    current('file').focus(); const pending = h.ui.select([slow]); await started.promise;
    assert.equal(doc.activeElement, body); assert(current('file').disabled);
    gate.resolve(); assert.equal(await pending, true);
    assert.equal(doc.activeElement, current('file')); assert(!doc.activeElement.disabled); assert.equal(listeners.size, 0);
  });
});
test('a disabled action regains focus, or falls back to summary when its successful operation removes it', { concurrency: false }, async () => {
  for (const action of ['refresh', 'cancel']) {
    const h = harness(), gate = deferred(), started = deferred(); await h.ui.select([file()]); const item = h.item();
    item.attempted = true; item.upload = h.dto({ state: 'quarantined', version: 3 });
    h.api.get = async () => { started.resolve(); await gate.promise; return h.dto({ state: 'quarantined', version: 3 }); };
    await withFocusDom(h, async ({ doc, body, current, listeners }) => {
      current('action', action).focus(); const pending = h.ui.action(action, item.id); await started.promise;
      assert.equal(doc.activeElement, body); gate.resolve(); await pending;
      assert.equal(doc.activeElement, action === 'refresh' ? current('action', action) : current('summary'));
      assert.equal(listeners.size, 0);
    });
  }
});
test('completion does not steal focus after the user chooses another control, even if it later blurs', { concurrency: false }, async () => {
  for (const blur of [false, true]) {
    const h = harness(), gate = deferred(), started = deferred(); await h.ui.select([file()]); const item = h.item();
    h.api.reserve = async () => { started.resolve(); await gate.promise; return h.dto(); };
    await withFocusDom(h, async ({ doc, body, current, external, focusBody, listeners }) => {
      current('action', 'upload').focus(); const pending = h.ui.action('upload', item.id); await started.promise;
      const other = external(); other.focus(); if (blur) focusBody();
      gate.resolve(); await pending; assert.equal(doc.activeElement, blur ? body : other); assert.equal(listeners.size, 0);
    });
  }
});
test('navigation or revocation cancels focus restoration and detaches operation listeners', { concurrency: false }, async () => {
  for (const revoke of [false, true]) {
    const h = harness(), gate = deferred(), started = deferred(); await h.ui.select([file()]); const item = h.item();
    h.api.reserve = async () => { started.resolve(); await gate.promise; return h.dto(); };
    await withFocusDom(h, async ({ doc, current, external, listeners }) => {
      current('action', 'upload').focus(); const pending = h.ui.action('upload', item.id); await started.promise;
      if (revoke) h.ui.retainRooms('synthetic-user', 'synthetic-center', []); else h.setContext({ roomId: 'second-room' });
      const other = external(); other.focus(); assert.equal(listeners.size, 0);
      gate.resolve(); await pending; assert.equal(doc.activeElement, other);
      if (revoke) { assert.equal(item.file, null); assert.equal(h.host.innerHTML, ''); }
    });
  }
});

const prepared = (h, changes = {}) => h.dto({ mode: 'prepared-delivery', state: 'ready', size: 4,
  source: { name: 'synthetic.png', type: 'image/png', size: bytes.length }, ...changes });

test('prepared source size is validated independently of a smaller processed candidate', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  h.api.reserve = async () => prepared(h);
  assert.equal(await h.ui.action('upload', item.id), true);
  assert.equal(item.upload.size, 4); assert.equal(item.file.size, bytes.length);
  const captured = h.ui.captureAttachments(); assert.deepEqual(captured, [{ id: uploadId }]);
  assert(Object.isFrozen(captured)); assert(Object.isFrozen(captured[0]));
  assert.match(h.host.innerHTML, /실제 검사·처리/); assert.match(h.host.innerHTML, /다음 메시지에 함께/);
  assert(!h.host.innerHTML.includes('blob:')); assert.equal(h.calls.length, 0);
});

test('default quarantine mode cannot capture or adopt a prepared upload', async () => {
  const h = harness(); await h.ui.select([file()]); h.api.reserve = async () => prepared(h);
  assert.equal(await h.ui.action('upload', h.item().id), false);
  assert.equal(h.item().upload, null); assert(h.item().uncertain); assert.deepEqual(h.ui.captureAttachments(), []);
});

test('new sends reject every incomplete, expired, uncertain, cancelled or already bound selection', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  for (const change of [{ state: 'pending' }, { state: 'receiving' }, { state: 'quarantined' }, { state: 'inspecting' },
    { state: 'rejected' }, { state: 'bound', expiresAt: null }, { expired: true }, { expiresAt: '2000-01-01T00:00:00Z' }, { expiresAt: 'invalid' }]) {
    item.upload = prepared(h, change); assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  }
  item.upload = prepared(h);
  for (const property of ['uncertain', 'cancelRequested']) {
    item[property] = true; assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY'); item[property] = false;
  }
  item.upload = null; assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  item.upload = prepared(h); h.state().items.push({ ...item, id: 'duplicate-local' });
  assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'INVALID_RESPONSE');
});

test('message operation locks all attachment mutations while its captured IDs survive bound state', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  item.upload = prepared(h); item.attempted = true;
  const attachments = h.ui.captureAttachments(), operation = Object.freeze({ clientId: 'same-request', body: '', attachments });
  h.setContext({ messageOperation: operation }); item.upload = prepared(h, { state: 'bound', expiresAt: null });
  assert.equal(await h.ui.select([file('other.png')]), false);
  for (const action of ['upload', 'refresh', 'cancel']) assert.equal(await h.ui.action(action, item.id), false);
  assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  assert.deepEqual(operation.attachments, [{ id: uploadId }]); assert.equal(h.calls.length, 0);
  assert.match(h.host.innerHTML, /같은 파일과 요청 번호/); assert.match(h.host.innerHTML, /disabled/);
  assert(item.file); assert.equal(item.cancelRequested, false);
});

test('definitive message rejection unlocks unchanged selections; unknown operation remains caller-owned', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item(); item.upload = prepared(h);
  h.setContext({ messageOperation: { attachments: h.ui.captureAttachments() } });
  h.setContext({ messageOperation: null });
  assert.equal(h.item(), item); assert(item.file); assert.deepEqual(h.ui.captureAttachments(), [{ id: uploadId }]);
});

test('successful receipt forgets exact uploaded IDs in its captured room without cancel or cross-room deletion', async () => {
  let changes = 0; const h = harness({}, { deliveryEnabled: true, onChanged: () => changes++ });
  await h.ui.select([file()]); const first = h.item(); first.upload = prepared(h);
  const scope = { userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' };
  h.setContext({ roomId: 'second-room' }); await h.ui.select([file('second.png')]); const second = h.item();
  const before = changes; assert.equal(h.ui.forgetSent(scope, [uploadId]), 1);
  assert.equal(first.file, null); assert.equal(h.item(), second); assert(second.file); assert.equal(changes, before + 1);
  assert.equal(h.ui.forgetSent(scope, [uploadId]), 0); assert.equal(h.calls.length, 0);
  assert.throws(() => h.ui.forgetSent({ ...scope, roomId: '../bad' }, [uploadId]), (e) => e.code === 'INVALID_INPUT');
  h.setContext({ roomId: 'synthetic-room' }); assert.equal(h.state().items.length, 0);
});

test('prepared source mismatch is rejected and cancellation retains a processed-size original until acknowledged', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  h.api.reserve = async () => prepared(h, { source: { name: 'synthetic.png', type: 'image/png', size: 4 } });
  assert.equal(await h.ui.action('upload', item.id), false); assert(item.uncertain); assert(item.file);
  h.api.reserve = async () => prepared(h);
  h.api.cancel = async () => { throw new MediaApiError('UNAVAILABLE'); };
  assert.equal(await h.ui.action('cancel', item.id), false); assert(item.file); assert(item.cancelRequested);
  h.api.get = async () => prepared(h, { state: 'delete_pending' });
  assert.equal(await h.ui.action('refresh', item.id), true); assert.equal(item.file, null);
});

test('onChanged observes busy entry/exit so selection hashing cannot race message capture', async () => {
  const busy = [], gate = deferred(), started = deferred(), slow = file(); let h;
  h = harness({}, { deliveryEnabled: true, onChanged: () => busy.push(!!h.ui.busy) });
  Object.defineProperty(slow, 'arrayBuffer', { value: async () => { started.resolve(); await gate.promise; return bytes.slice().buffer; } });
  const pending = h.ui.select([slow]); await started.promise;
  assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  gate.resolve(); await pending; assert.deepEqual(busy, [true, false]);
});

test('clock expiry changes ready display and capture together without waiting for a new server flag', { concurrency: false }, async (t) => {
  let now = Date.parse('2030-01-01T00:00:00Z') - 1;
  t.mock.method(Date, 'now', () => now);
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  item.upload = prepared(h); item.attempted = true; h.ui.update();
  assert.deepEqual(h.ui.captureAttachments(), [{ id: uploadId }]);
  assert.match(h.host.innerHTML, /준비 완료 · 다음 메시지에 함께 전송/);
  now++; h.ui.update();
  assert.equal(item.upload.expired, false);
  assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  assert.match(h.host.innerHTML, /업로드가 만료되었어요. 상태 확인 또는 취소가 필요해요/);
  assert(!h.host.innerHTML.includes('준비 완료 · 다음 메시지에 함께 전송'));
  assert.match(h.host.innerHTML, /data-media-action="refresh"/); assert.match(h.host.innerHTML, /data-media-action="cancel"/);
  assert.equal(h.calls.length, 0); assert(item.file);
});

test('server expired flag overrides a future local clock and expired pending files cannot upload', { concurrency: false }, async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2029-12-31T00:00:00Z'));
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  item.upload = prepared(h, { expired: true }); item.attempted = true; h.ui.update();
  assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
  assert.match(h.host.innerHTML, /업로드가 만료되었어요/); assert(!h.host.innerHTML.includes('준비 완료 · 다음 메시지에 함께 전송'));
  for (const upload of [h.dto({ state: 'pending', expired: true }), h.dto({ state: 'pending', expiresAt: '2020-01-01T00:00:00Z', expired: false })]) {
    item.upload = upload; h.api.get = async () => upload; h.ui.update();
    assert.match(h.host.innerHTML, /업로드가 만료되었어요/); assert(!h.host.innerHTML.includes('data-media-action="upload"'));
    await h.ui.action('upload', item.id);
    assert.equal(h.calls.filter((call) => call[0] === 'receive').length, 0); assert(item.file);
    assert.match(h.state().notice, /업로드가 만료되었어요/);
  }
});

for (const failureCode of ['SCAN_INVALID', 'SCAN_UNAVAILABLE']) {
  test(`prepared quarantined ${failureCode} explains incomplete inspection without approving or reuploading`, async () => {
    const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item(), original = item.file;
    const blocked = prepared(h, { state: 'quarantined', size: bytes.length, failureCode });
    item.upload = blocked; item.attempted = true;
    h.api.get = async (...args) => { h.calls.push(['get', ...args]); return blocked; };
    h.ui.update();
    for (const action of ['refresh', 'upload']) {
      assert.equal(await h.ui.action(action, item.id), true);
      assert.match(h.host.innerHTML, /검사를 완료하지 못했어요/);
      assert.match(h.host.innerHTML, /이 파일은 아직 전송할 수 없어요/);
      assert.match(h.host.innerHTML, /상태 갱신으로 다시 확인하거나 업로드를 취소해 주세요/);
      assert.match(h.state().notice, /검사를 완료하지 못했어요/);
      assert(!h.host.innerHTML.includes('격리 보관됨 · 검사 대기'));
      assert(!h.host.innerHTML.includes('실제 검사·처리를 기다려 주세요'));
      assert(!h.host.innerHTML.includes(failureCode));
      assert(!h.host.innerHTML.includes('data-media-action="upload"'));
      assert.match(h.host.innerHTML, /data-media-action="refresh"/);
      assert.match(h.host.innerHTML, /data-media-action="cancel"/);
      assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'MEDIA_BUSY');
      assert.equal(item.file, original); assert.equal(item.cancelRequested, false);
    }
    assert.deepEqual(h.calls.map((call) => call[0]), ['get', 'get']);
    h.api.cancel = async (...args) => { h.calls.push(['cancel', ...args]); return prepared(h, { state: 'delete_pending' }); };
    assert.equal(await h.ui.action('cancel', item.id), true);
    assert.deepEqual(h.calls.map((call) => call[0]), ['get', 'get', 'get', 'cancel']);
    assert.equal(item.file, null); assert.equal(h.state().items.length, 0);
  });
}

test('inspection failure guidance is scoped to prepared quarantine and expiry retains priority', async () => {
  const h = harness({}, { deliveryEnabled: true }); await h.ui.select([file()]); const item = h.item();
  const markup = (upload, enabled = true) => mediaUploadMarkup({ items: [{ ...item, upload, attempted: true }] }, false, false, enabled);
  assert.match(markup(prepared(h, { state: 'quarantined', failureCode: null })), /격리 보관됨 · 검사 대기/);
  assert.match(markup(h.dto({ state: 'quarantined', failureCode: 'SCAN_UNAVAILABLE' }), false), /격리 보관됨 · 검사 서버 미연결/);
  for (const upload of [h.dto({ state: 'quarantined', failureCode: 'SCAN_INVALID' }),
    prepared(h, { state: 'inspecting', failureCode: 'SCAN_UNAVAILABLE' }),
    prepared(h, { state: 'rejected', failureCode: 'SCAN_INVALID' }),
    prepared(h, { state: 'quarantined', failureCode: 'SCAN_REJECTED' })]) {
    assert(!markup(upload).includes('검사를 완료하지 못했어요'));
  }
  item.upload = prepared(h, { state: 'quarantined', failureCode: 'SCAN_UNAVAILABLE', expired: true });
  item.attempted = true; h.api.get = async () => item.upload;
  await h.ui.action('refresh', item.id);
  assert.match(h.host.innerHTML, /업로드가 만료되었어요/); assert.match(h.state().notice, /업로드가 만료되었어요/);
  assert(!h.host.innerHTML.includes('검사를 완료하지 못했어요')); assert(item.file);
});

test('record selections are private by default, explicitly shared and isolated by record and message owner', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'record' }), chat = harness({}, { deliveryEnabled: true });
  assert.equal(await h.ui.select([file()]), false);
  h.setContext({ recordId: 'record-one' }); await h.ui.select([file()]); const first = h.item(); first.upload = prepared(h);
  assert.equal(first.share, false); assert.deepEqual(h.ui.captureRecordAttachments(), [{ id: uploadId, share: false }]);
  assert.equal(h.ui.setShare(first.id, true), true); assert.deepEqual(h.ui.captureRecordAttachments(), [{ id: uploadId, share: true }]);
  assert.match(h.host.innerHTML, /보호자 공유에 포함/); assert.match(h.host.innerHTML, /기록 첨부 선택 합계/);
  assert(!h.host.innerHTML.includes('다음 메시지에 함께 전송')); assert.throws(() => h.ui.captureAttachments(), (e) => e.code === 'INVALID_INPUT');
  h.setContext({ recordId: 'record-two' }); assert.equal(h.state().items.length, 0); await h.ui.select([file()]); const second = h.item();
  await chat.ui.select([file()]); assert.equal(chat.state().items.length, 1);
  assert.equal(chat.item().share, false); assert(!chat.host.innerHTML.includes('data-media-share'));
  h.setContext({ recordId: 'record-one' }); assert.equal(h.item(), first); assert.equal(first.share, true);
  h.ui.clearRoom('synthetic-user', 'synthetic-center', 'synthetic-room');
  assert.equal(first.file, null); assert.equal(second.file, null); assert(chat.item().file);
});

test('record capture combines existing bound metadata with only ready files and freezes ID/share fields', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'record' }); h.setContext({ recordId: 'record-one' });
  await h.ui.select([file()]); const item = h.item(); item.upload = prepared(h);
  const bound = { id: '12345678-1234-4234-8234-123456789abd', name: 'saved.png', type: 'image/png', size: 4, share: true };
  const captured = h.ui.captureRecordAttachments([bound]);
  assert.deepEqual(captured, [{ id: bound.id, share: true }, { id: uploadId, share: false }]);
  assert(Object.isFrozen(captured)); assert(Object.isFrozen(captured[0])); bound.share = false;
  assert.equal(captured[0].share, true);
  assert.throws(() => h.ui.captureRecordAttachments([{ ...bound, id: uploadId }]), (e) => e.code === 'MEDIA_LIMIT');
  assert.throws(() => h.ui.captureRecordAttachments([{ ...bound, share: undefined }]), (e) => e.code === 'INVALID_INPUT');
  const six = Array.from({ length: 6 }, (_, i) => ({ ...bound, id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}` }));
  assert.throws(() => h.ui.captureRecordAttachments(six), (e) => e.code === 'MEDIA_LIMIT');
  for (const state of ['pending', 'quarantined', 'inspecting', 'bound']) {
    item.upload = prepared(h, { state }); assert.throws(() => h.ui.captureRecordAttachments([bound]), (e) => e.code === 'MEDIA_BUSY');
  }
});

test('record unknown operation freezes sharing and cancellation until its exact receipt is accepted', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'record' }); h.setContext({ recordId: 'record-one' });
  await h.ui.select([file()]); const item = h.item(); item.upload = prepared(h); item.attempted = true;
  const operation = Object.freeze({ attachments: h.ui.captureRecordAttachments() });
  h.setContext({ messageOperation: operation }); item.upload = prepared(h, { state: 'bound', expiresAt: null });
  assert.equal(h.ui.setShare(item.id, true), false); assert.equal(await h.ui.action('cancel', item.id), false);
  assert.equal(await h.ui.select([file()]), false); assert.equal(item.share, false); assert(item.file);
  assert.match(h.host.innerHTML, /기록 저장 결과/); assert.match(h.host.innerHTML, /data-media-share="[^"]+"\s+disabled/);
  assert.deepEqual(operation.attachments, [{ id: uploadId, share: false }]); assert.equal(h.calls.length, 0);
  h.setContext({ recordId: 'record-two', messageOperation: null }); await h.ui.select([file()]); const other = h.item();
  const scope = { userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' };
  assert.equal(h.ui.forgetSaved(scope, 'record-one', [uploadId]), 1); assert.equal(item.file, null); assert(other.file);
  assert.equal(h.ui.hasRecordSelections(scope, 'record-one'), false); assert.equal(h.ui.hasRecordSelections(scope, 'record-two'), true);
  assert.equal(h.ui.retainRooms(scope.userId, scope.centerId, []), 2); assert.equal(other.file, null);
});

test('record cleanup retains original selection for status and confirmed cancellation but forbids new delivery work', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'record' }); h.setContext({ recordId: 'record-one' });
  await h.ui.select([file()]); const item = h.item(), original = item.file;
  item.upload = prepared(h, { state: 'pending' }); item.attempted = true;
  h.api.get = async (...args) => { h.calls.push(['get', ...args]); return prepared(h, { state: 'ready' }); };
  let confirmCancel;
  h.api.cancel = async (...args) => { h.calls.push(['cancel', ...args]); return new Promise((resolve) => { confirmCancel = resolve; }); };
  h.setContext({ cleanupOnly: true });
  assert.match(h.host.innerHTML, /남아 있는 첨부 정리/); assert.match(h.host.innerHTML, /data-media-action="refresh"/);
  for (const token of ['type="file"', 'data-media-share', 'data-media-action="upload"']) assert(!h.host.innerHTML.includes(token));
  assert.equal(await h.ui.select([file('new.png')]), false);
  assert.equal(h.ui.setShare(item.id, true), false); assert.equal(await h.ui.action('upload', item.id), false);
  assert.throws(() => h.ui.captureRecordAttachments(), (error) => error.code === 'MEDIA_BUSY');
  assert.equal(h.calls.length, 0); assert.equal(await h.ui.action('refresh', item.id), true); assert.equal(item.file, original);
  const cancel = h.ui.action('cancel', item.id);
  while (!confirmCancel) await Promise.resolve();
  assert.equal(item.file, original); assert.equal(h.state().items.length, 1);
  confirmCancel(prepared(h, { state: 'delete_pending' })); assert.equal(await cancel, true);
  assert.equal(item.file, null); assert.equal(h.state().items.length, 0);
  assert.deepEqual(h.calls.map((call) => call[0]), ['get', 'get', 'cancel']);
});

test('feedback selections are independently keyed and explicitly shared on save without record-private controls', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'feedback' }), record = harness({}, { deliveryEnabled: true, purpose: 'record' });
  assert.equal(await h.ui.select([file()]), false);
  h.setContext({ feedbackId: 'feedback-one' }); assert.equal(await h.ui.select([file()]), true); const first = h.item(); first.upload = prepared(h);
  assert.match(h.host.innerHTML, /활동 경험 사진·영상 추가/); assert.match(h.host.innerHTML, /활동 경험 저장 시 이 대화 참여자에게 함께 공유/);
  assert.match(h.host.innerHTML, /활동 경험 첨부 선택 합계/); assert(!h.host.innerHTML.includes('data-media-share')); assert(!h.host.innerHTML.includes('비공개로 첨부'));
  assert.equal(h.ui.setShare(first.id, true), false); assert.deepEqual(h.ui.captureFeedbackAttachments(), [{ id: uploadId }]);
  assert(Object.isFrozen(h.ui.captureFeedbackAttachments()[0]));
  h.setContext({ feedbackId: 'feedback-two' }); assert.equal(h.state().items.length, 0); await h.ui.select([file()]); const second = h.item();
  record.setContext({ recordId: 'feedback-one' }); await record.ui.select([file()]); assert.notEqual(record.item(), first);
  h.setContext({ feedbackId: 'feedback-one' }); assert.equal(h.item(), first);
  const scope = { userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' };
  assert.equal(h.ui.forgetFeedbackSaved(scope, 'feedback-one', [uploadId]), 1); assert.equal(first.file, null); assert(second.file); assert(record.item().file);
  h.ui.clear(); assert.equal(second.file, null); assert(record.item().file);
});

test('feedback capture retains only explicit bound IDs, enforces aggregate limits and locks every ambiguous request mutation', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'feedback' }); h.setContext({ feedbackId: 'feedback-one' });
  await h.ui.select([file()]); const item = h.item(); item.upload = prepared(h); item.attempted = true;
  const bound = { id: '12345678-1234-4234-8234-123456789abd', name: 'old.png', type: 'image/png', size: 9 };
  const attachments = h.ui.captureFeedbackAttachments([bound]);
  assert.deepEqual(attachments, [{ id: bound.id }, { id: uploadId }]); bound.name = 'changed.png'; assert.equal(Object.keys(attachments[0]).length, 1);
  assert.throws(() => h.ui.captureFeedbackAttachments([{ ...bound, share: true }]), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => h.ui.captureFeedbackAttachments([{ ...bound, id: uploadId }]), (e) => e.code === 'MEDIA_LIMIT');
  const six = Array.from({ length: 6 }, (_, i) => ({ ...bound, id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}` }));
  assert.throws(() => h.ui.captureFeedbackAttachments(six), (e) => e.code === 'MEDIA_LIMIT');
  for (const state of ['pending', 'quarantined', 'inspecting', 'bound']) {
    item.upload = prepared(h, { state }); assert.throws(() => h.ui.captureFeedbackAttachments(), (e) => e.code === 'MEDIA_BUSY');
  }
  h.setContext({ messageOperation: Object.freeze({ attachments }) });
  assert.equal(await h.ui.action('cancel', item.id), false); assert.equal(await h.ui.action('refresh', item.id), false); assert.equal(await h.ui.select([file()]), false);
  assert.match(h.host.innerHTML, /활동 경험 저장 결과/); assert(item.file); assert.equal(h.calls.length, 0);
});

test('feedback cleanup is limited to existing selection status/cancel and account revocation purges it', async () => {
  const h = harness({}, { deliveryEnabled: true, purpose: 'feedback' }); h.setContext({ feedbackId: 'feedback-one' });
  await h.ui.select([file()]); const item = h.item(); item.upload = prepared(h); item.attempted = true;
  h.setContext({ cleanupOnly: true });
  assert.equal(await h.ui.select([file()]), false); assert.equal(await h.ui.action('upload', item.id), false);
  assert.throws(() => h.ui.captureFeedbackAttachments(), (e) => e.code === 'MEDIA_BUSY');
  h.api.get = async () => item.upload; h.api.cancel = async () => prepared(h, { state: 'delete_pending' });
  assert.equal(await h.ui.action('cancel', item.id), true); assert.equal(item.file, null);
  h.setContext({ cleanupOnly: false }); await h.ui.select([file()]); const next = h.item();
  h.ui.retainRooms('synthetic-user', 'synthetic-center', []); assert.equal(next.file, null); assert.equal(h.ui.states.size, 0);
});
