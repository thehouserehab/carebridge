// Pure state/controller/markup doubles. No native dialog, browser, API or DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiError } from '../local-api/client.js';
import { ProfileFieldError } from '../src/profile-fields.js';
import { SelfProfileDraft, SelfProfileUi, selfProfileMarkup } from '../local-api/self-profile-ui.js';

const profile = (extra = {}) => ({ userId: 'synthetic-user', role: 'guardian', displayName: '가상 이름', revision: 1, updatedAt: '2026-10-10T00:00:00.000Z', ...extra });
const receipt = (extra = {}) => ({ operation: 'member.save', userId: 'synthetic-user', childId: null, conversationId: null, appliedVersion: 2, changed: true, replayed: false, ...extra });
const deferred = () => Promise.withResolvers();
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

// Only queried controls, events and focus ownership are modeled. This cannot
// verify browser layout, modal top-layer behavior or native keyboard handling.
function hostStub() {
  const state = { html: '', form: null, input: null, shows: 0, closes: 0, focus: [], attributes: {} };
  const document = { activeElement: null, querySelector: () => state.replacement ?? null };
  const element = (name, extra = {}) => ({ isConnected: true, disabled: false, name,
    focus(options) { assert.equal(options.preventScroll, true); document.activeElement = this; state.focus.push(name); }, ...extra });
  state.opener = element('opener'); document.activeElement = state.opener; state.title = element('title');
  const listeners = [];
  const host = { open: false, ownerDocument: document,
    setAttribute(key, value) { state.attributes[key] = value; },
    addEventListener(type, callback, options) { listeners.push({ type, callback, signal: options?.signal }); },
    emit(type, event = {}) { for (const item of listeners) if (item.type === type && !item.signal?.aborted) item.callback(event); },
    contains: node => node === state.input || node === state.form || node?.owned === true,
    querySelector(key) { return key === '[name="displayName"]' ? state.input : key === '[data-self-profile-form]' ? state.form : key === '#self-profile-title' ? state.title : null; },
    showModal() { this.open = true; state.shows++; }, close() { this.open = false; state.closes++; this.emit('close'); },
    replaceChildren() { this.innerHTML = ''; },
  };
  Object.defineProperty(host, 'innerHTML', { get: () => state.html, set: html => {
    if (state.input) state.input.isConnected = false;
    state.html = html; state.input = null; state.form = null;
    const match = /<input name="displayName" value="([^"]*)"([^>]*)>/.exec(html);
    if (match) { state.input = element('displayName', { value: decode(match[1]), readOnly: match[2].includes('readonly') }); state.form = { owned: true }; }
  } });
  return { host, state, document, element };
}
function fixture(overrides = {}, callbacks = {}) {
  const f = hostStub(), context = { userId: 'synthetic-user', centerId: 'synthetic-center', role: 'guardian', active: true };
  const calls = [], changed = [], denied = [], notices = [];
  const transport = { expectedUserId: context.userId, request: () => assert.fail('scoped API double only') };
  const ui = new SelfProfileUi({ host: f.host, transport, getContext: () => context,
    onChanged: () => { changed.push(true); return callbacks.onChanged?.(); },
    onDenied: error => { denied.push(error?.code); return callbacks.onDenied?.(error); },
    announce: value => { notices.push(value); return callbacks.announce?.(value); } });
  ui.api = {
    get: async (center, signal) => { calls.push(['get', center, signal]); return profile({ role: context.role }); },
    save: async (center, op, signal) => { calls.push(['save', center, op, signal]); return receipt(); }, ...overrides,
  };
  return { ...f, context, transport, calls, changed, denied, notices, ui,
    input(value) { assert(f.state.input); f.state.input.value = value; f.host.emit('input', { target: f.state.input }); },
    action(action) { const button = { owned: true, dataset: { selfProfileAction: action }, closest() { return this; } }; f.host.emit('click', { target: button }); } };
}
async function opened(overrides = {}, callbacks = {}) { const f = fixture(overrides, callbacks); await f.ui.open(); return f; }

test('draft tracks null clearing and current center identity without modifying the fetched profile', () => {
  const raw = profile({ displayName: null, revision: 0, updatedAt: null }), draft = new SelfProfileDraft(raw);
  assert.equal(draft.value, ''); draft.value = 'draft'; assert.equal(raw.displayName, null);
  draft.value = ''; assert.deepEqual(draft.begin(() => 'synthetic-write'), { clientId: 'synthetic-write', expectedRevision: 0, displayName: null });
});

test('draft normalizes names before UUID allocation and freezes exactly one operation', () => {
  const draft = new SelfProfileDraft(profile()); draft.value = ' 가상 작성 ';
  const op = draft.begin(() => 'synthetic-write'); assert(Object.isFrozen(op));
  assert.deepEqual(op, { clientId: 'synthetic-write', expectedRevision: 1, displayName: '가상 작성' });
  assert.equal(draft.begin(), null); assert.equal(draft.value, ' 가상 작성 ');
  assert.throws(() => { op.displayName = 'mutated'; }, TypeError);
});

test('draft raw validation rejects whitespace-only, length, newline/control and malformed Unicode', () => {
  for (const value of [' ', 'a'.repeat(31), 'name\n', '\u0000', '\u0085', '\ud800']) {
    const draft = new SelfProfileDraft(profile()); draft.value = value;
    assert.throws(() => draft.begin(() => assert.fail('no ID')), ProfileFieldError); assert.equal(draft.operation, null);
  }
});

test('first definitive rejection preserves editable input; exact conflict requires explicit latest comparison', () => {
  for (const error of [new LocalApiError('INVALID_INPUT', 400), new LocalApiError('INVALID_INPUT', 413), new LocalApiError('REVISION_LIMIT', 409), new LocalApiError('PROFILE_CONFLICT', 409)]) {
    const draft = new SelfProfileDraft(profile()); draft.value = '내 입력'; const op = draft.begin(); draft.failed(op, error);
    assert.equal(draft.value, '내 입력'); assert.equal(draft.operation, null); assert.equal(draft.uncertain, false);
    if (error.code === 'PROFILE_CONFLICT') { assert(draft.stale); assert.equal(draft.latest, null); assert.equal(draft.compare(true), false); }
  }
});

test('unknown then later conflict preserves original ID/version/name and never invokes another ID factory', () => {
  for (const error of [new Error('PRIVATE_RAW'), new LocalApiError('UNAVAILABLE'), new LocalApiError('CANCELLED'), new LocalApiError('INVALID_RESPONSE'),
    new LocalApiError('IDEMPOTENCY_CONFLICT', 409), new LocalApiError('PROFILE_CONFLICT', 503)]) {
    const draft = new SelfProfileDraft(profile()), op = draft.begin(() => 'original-write'); draft.failed(op, error);
    draft.value = 'must not transmit'; draft.reconcile(profile({ revision: 9, displayName: '다른 최신' }));
    assert.equal(draft.begin(() => assert.fail('new ID')), op); draft.failed(op, new LocalApiError('PROFILE_CONFLICT', 409));
    assert.equal(draft.operation, op); assert(draft.uncertain); assert(!draft.error.includes('PRIVATE_RAW')); assert.equal(draft.compare(false), false);
  }
});

test('explicit keep and replace repin version without a save; stale remains sticky until selected', () => {
  for (const keep of [true, false]) {
    const draft = new SelfProfileDraft(profile()); draft.value = '내 입력';
    draft.reconcile(profile({ revision: 2, displayName: '새 이름' })); assert(draft.stale); assert.equal(draft.value, '내 입력');
    assert.throws(() => draft.begin(), error => error.code === 'PROFILE_CONFLICT');
    assert(draft.compare(keep)); assert.equal(draft.revision, 2); assert.equal(draft.value, keep ? '내 입력' : '새 이름'); assert.equal(draft.operation, null);
  }
});

test('draft rejects mismatched user/role and supports maximum-version no-op command', () => {
  const draft = new SelfProfileDraft(profile({ revision: Number.MAX_SAFE_INTEGER }));
  for (const extra of [{ userId: 'other' }, { role: 'center' }]) assert.throws(() => draft.reconcile(profile(extra)), error => error.code === 'AUTH_REQUIRED');
  assert.equal(draft.begin().expectedRevision, Number.MAX_SAFE_INTEGER);
});

test('markup escapes authored/latest values and documents immutable role, scope, identity and null behavior', () => {
  const draft = new SelfProfileDraft(profile({ displayName: '<img src=x onerror=x>' }));
  draft.reconcile(profile({ revision: 2, displayName: '"<latest>' }));
  const html = selfProfileMarkup(draft, { role: 'guardian' });
  assert(!html.includes('<img')); assert(html.includes('&lt;img')); assert(html.includes('&quot;&lt;latest&gt;'));
  for (const text of ['이 센터', '확인된 실명', '다른 센터', '현재 역할: 보호자', '역할이나 담당 관계', '기본 표시', 'maxlength="30"', 'autocomplete="off"', 'data-self-profile-conflict']) assert(html.includes(text));
  assert.match(html, /data-self-profile-action="save" disabled/);
});

test('unknown markup only shows pinned name, readonly retry and no fresh-save control', () => {
  const draft = new SelfProfileDraft(profile()); const op = draft.begin(); draft.failed(op, new Error('secret'));
  draft.value = 'different'; const html = selfProfileMarkup(draft, { role: 'therapist' });
  assert(html.includes('value="가상 이름"')); assert(html.includes('readonly')); assert(html.includes('data-self-profile-action="retry"'));
  assert(!html.includes('data-self-profile-action="save"')); assert(!html.includes('secret')); assert(!html.includes('different'));
});

test('loading/unavailable markup never projects a preserved draft name or unknown operation', () => {
  const draft = new SelfProfileDraft(profile({ displayName: 'PRIVATE_DRAFT' })); draft.begin();
  for (const options of [{ loading: true }, { unavailable: true }]) {
    const html = selfProfileMarkup(draft, options); assert(!html.includes('PRIVATE_DRAFT')); assert(!html.includes('<input'));
  }
});

test('open uses a fresh read, native-dialog shell, accessible title and input focus', async () => {
  const f = await opened(); assert.equal(f.calls[0][0], 'get'); assert.equal(f.calls[0][1], 'synthetic-center');
  assert(f.host.open); assert(f.ui.verified); assert.equal(f.state.attributes['aria-labelledby'], 'self-profile-title');
  assert.equal(f.state.input.value, '가상 이름'); assert.equal(f.document.activeElement, f.state.input); f.ui.destroy();
});

test('slow open displays no old value, is single-flight, and close prevents late appearance', async () => {
  const gate = deferred(), f = fixture({ get: () => gate.promise });
  const pending = f.ui.open(); await f.ui.open(); assert.equal(f.state.input, null); assert(f.host.open);
  f.ui.close(); gate.resolve(profile()); await pending; assert(!f.host.open); assert.equal(f.state.html, ''); assert.equal(f.ui.draft, null);
});

test('close and Escape retain same-scope input only in memory and restore opener focus', async () => {
  const f = await opened(); f.input('작성 중'); let prevented = false;
  f.host.emit('cancel', { preventDefault() { prevented = true; } });
  assert(prevented); assert(!f.host.open); assert.equal(f.state.html, ''); assert.equal(f.ui.draft.value, '작성 중');
  assert.equal(f.document.activeElement, f.state.opener); await f.ui.open(); assert.equal(f.state.input.value, '작성 중');
  assert.equal(f.calls.filter(call => call[0] === 'get').length, 2); f.ui.destroy();
});

test('detached opener uses same-scope header fallback but hidden/offline suspension never steals focus', async () => {
  const f = await opened(); f.state.opener.isConnected = false; f.state.replacement = f.element('replacement');
  f.ui.close(); assert.equal(f.document.activeElement, f.state.replacement);
  await f.ui.open(); const previous = f.document.activeElement; f.context.active = false; f.ui.suspend();
  assert.equal(f.document.activeElement, previous); assert.equal(f.state.html, ''); f.ui.destroy();
});

test('ordinary save closes, clears only own draft, announces and refreshes once', async () => {
  const unrelated = { record: 'preserve', message: 'preserve' }, f = await opened({}, { onChanged: () => { assert.deepEqual(unrelated, { record: 'preserve', message: 'preserve' }); } });
  f.input(' 새 이름 '); await f.ui.submit(); const save = f.calls.find(call => call[0] === 'save');
  assert.equal(save[2].displayName, '새 이름'); assert.equal(save[2].expectedRevision, 1); assert(Object.isFrozen(save[2]));
  assert.equal(f.ui.draft, null); assert(!f.host.open); assert.equal(f.changed.length, 1); assert.equal(f.notices[0], '이 센터의 표시 이름을 저장했어요.');
  assert.equal(f.document.activeElement, f.state.opener); f.ui.destroy();
});

test('empty input writes null rather than omitting a field', async () => {
  const f = await opened(); f.input(''); await f.ui.submit(); assert.equal(f.calls.find(call => call[0] === 'save')[2].displayName, null); f.ui.destroy();
});

test('unknown write survives close/fresh read and exact explicit retry; replay announcement does not imply latest name', async () => {
  const writes = []; let version = 1;
  const f = await opened({ get: async () => profile({ revision: version, displayName: version === 1 ? '가상 이름' : '다른 최신 이름' }),
    save: async (_center, op) => { writes.push(op); if (writes.length === 1) throw new LocalApiError('UNAVAILABLE'); return receipt({ replayed: true }); } });
  f.input('보내려던 이름'); await f.ui.submit(); const original = writes[0];
  assert(f.ui.hasPendingWrite()); assert(f.state.input.readOnly); assert(!f.state.html.includes('data-self-profile-action="save"'));
  f.ui.close(); version = 8; await f.ui.open(); assert.equal(writes.length, 1); assert.equal(f.state.input.value, '보내려던 이름');
  await f.ui.submit(true); assert.equal(writes[1], original); assert(!f.host.open); assert.equal(f.ui.draft, null);
  assert.match(f.notices[0], /이전 저장 요청/); assert.match(f.notices[0], /최신 이름은 다시/); f.ui.destroy();
});

test('first conflict keeps typed value, GET alone cannot unlock it, explicit keep or replace enables separate save', async () => {
  for (const keep of [true, false]) {
    let current = profile(), writes = 0;
    const f = await opened({ get: async () => ({ ...current }), save: async () => { writes++; throw new LocalApiError('PROFILE_CONFLICT', 409); } });
    f.input('내 작성'); await f.ui.submit(); assert.equal(f.state.input.value, '내 작성'); assert(f.ui.draft.stale);
    assert.equal(f.ui.draft.latest, null); assert.match(f.state.html, /data-self-profile-action="save" disabled/);
    current = profile({ revision: 2, displayName: '최신 작성' }); await f.ui.open(); assert.equal(writes, 1);
    assert.equal(f.state.input.value, '내 작성'); assert.equal(f.ui.draft.revision, 1);
    f.ui.compare(keep); assert.equal(f.ui.draft.revision, 2); assert.equal(f.state.input.value, keep ? '내 작성' : '최신 작성');
    assert.equal(writes, 1); f.ui.destroy();
  }
});

test('unknown then definitive conflict never unlocks the command or enables latest selection', async () => {
  let attempt = 0; const f = await opened({ save: async () => { throw new LocalApiError(++attempt === 1 ? 'UNAVAILABLE' : 'PROFILE_CONFLICT', attempt === 1 ? 0 : 409); } });
  f.input('원 입력'); await f.ui.submit(); const op = f.ui.draft.operation; await f.ui.submit(true);
  assert.equal(f.ui.draft.operation, op); assert(f.ui.draft.uncertain); assert.equal(f.state.input.value, '원 입력');
  f.ui.compare(false); assert.equal(f.ui.draft.operation, op); f.ui.destroy();
});

test('close while write is pending aborts observation but retains command; late success cannot announce or refresh', async () => {
  const gate = deferred(), f = await opened({ save: (_center, _op, signal) => { f.writeSignal = signal; return gate.promise; } });
  f.input('원 입력'); const pending = f.ui.submit(), op = f.ui.draft.operation; f.ui.close();
  assert(f.writeSignal.aborted); assert.equal(f.ui.draft.operation, op); assert(f.ui.draft.uncertain);
  gate.resolve(receipt()); await pending; assert.equal(f.changed.length, 0); assert.equal(f.notices.length, 0); assert(!f.host.open); f.ui.destroy();
});

test('suspend/reopen ignores an older read without clearing the new dialog epoch', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ get: () => ++reads === 1 ? old.promise : Promise.resolve(profile({ displayName: '현재 이름' })) });
  const pending = f.ui.open(); f.ui.suspend(); await f.ui.open(); old.resolve(profile({ displayName: '옛 이름' })); await pending;
  assert(f.host.open); assert.equal(f.state.input.value, '현재 이름'); f.ui.destroy();
});

test('late read after account, center or role change is wiped without projecting another scope', async () => {
  for (const change of [f => { f.context.userId = 'other'; f.transport.expectedUserId = 'other'; }, f => { f.context.centerId = 'other'; }, f => { f.context.role = 'center'; }]) {
    const gate = deferred(), f = fixture({ get: () => gate.promise }); const pending = f.ui.open(); change(f); gate.resolve(profile()); await pending;
    assert(!f.host.open); assert.equal(f.state.html, ''); assert.equal(f.ui.draft, null); assert.deepEqual(f.denied, ['AUTH_REQUIRED']); f.ui.destroy();
  }
});

test('late failed read after identity change returns fixed denial, not backend details', async () => {
  const gate = deferred(), f = fixture({ get: () => gate.promise }); const pending = f.ui.open(); f.transport.expectedUserId = 'other';
  gate.reject(new Error('PRIVATE_NAME')); await pending; assert.equal(f.state.html, ''); assert.deepEqual(f.denied, ['AUTH_REQUIRED']); f.ui.destroy();
});

test('late write after role change purges operation and cannot refresh or focus the new scope', async () => {
  const gate = deferred(), f = await opened({ save: () => gate.promise }); const pending = f.ui.submit(); f.context.role = 'center';
  gate.resolve(receipt()); await pending; assert(!f.host.open); assert.equal(f.ui.draft, null); assert.equal(f.changed.length, 0);
  assert.deepEqual(f.denied, ['AUTH_REQUIRED']); assert.notEqual(f.document.activeElement, f.state.opener); f.ui.destroy();
});

test('inactive initial open issues no request, and inactive late read hides UI without declaring auth loss', async () => {
  const f = fixture(); f.context.active = false; await f.ui.open(); assert.equal(f.calls.length, 0); assert(!f.host.open);
  const gate = deferred(), late = fixture({ get: () => gate.promise }); const pending = late.ui.open(); late.context.active = false;
  gate.resolve(profile()); await pending; assert(!late.host.open); assert.equal(late.denied.length, 0); f.ui.destroy(); late.ui.destroy();
});

test('temporary GET failure hides name and disables programmatic submit until successful permission check', async () => {
  const f = await opened(); f.input('개인 초안'); f.ui.close(); f.ui.api.get = async () => { throw new Error('PRIVATE_BACKEND'); };
  await f.ui.open(); assert(f.host.open); assert.equal(f.state.input, null); assert(!f.state.html.includes('개인 초안')); assert(!f.state.html.includes('PRIVATE_BACKEND'));
  assert.equal(f.ui.draft.value, '개인 초안'); await f.ui.submit(); assert.equal(f.calls.filter(call => call[0] === 'save').length, 0);
  f.ui.api.get = async () => profile(); await f.ui.open(); assert.equal(f.state.input.value, '개인 초안'); f.ui.destroy();
});

test('permission-denied reads or writes purge all own input and call denial once', async () => {
  for (const mode of ['get', 'save']) for (const error of [new LocalApiError('AUTH_REQUIRED', 401), new LocalApiError('NOT_FOUND', 404), new LocalApiError('FORBIDDEN', 403)]) {
    const f = await opened(); f.input('개인 초안'); f.ui.api[mode] = async () => { throw error; };
    if (mode === 'get') await f.ui.open(); else await f.ui.submit();
    assert(!f.host.open); assert.equal(f.state.html, ''); assert.equal(f.ui.draft, null); assert.equal(f.ui.scope, null); assert.equal(f.denied.length, 1); f.ui.destroy();
  }
});

test('server role mismatch cannot mount current profile under the old role', async () => {
  const f = fixture({ get: async () => profile({ role: 'center' }) }); await f.ui.open(); assert(!f.host.open); assert.equal(f.ui.draft, null); assert.equal(f.denied.length, 1); f.ui.destroy();
});

test('destroy wipes memory, aborts events/request and blocks late results or reopening', async () => {
  const gate = deferred(), f = await opened({ save: () => gate.promise }); const pending = f.ui.submit(); f.ui.destroy();
  assert(f.ui.events.signal.aborted); assert.equal(f.ui.draft, null); assert.equal(f.ui.scope, null); gate.resolve(receipt()); await pending;
  await f.ui.open(); assert(!f.host.open); assert.equal(f.changed.length, 0); assert.equal(f.state.html, '');
});

test('callback failures cannot reclassify a committed write as unknown or prevent modal cleanup', async () => {
  const f = await opened({}, { onChanged: () => Promise.reject(new Error('PRIVATE_CALLBACK')), announce: () => { throw new Error('PRIVATE_CALLBACK'); } });
  await f.ui.submit(); await Promise.resolve(); assert(!f.host.open); assert.equal(f.ui.draft, null); assert.equal(f.changed.length, 1); f.ui.destroy();
});

test('queued native close event from a previous close cannot erase a newly opened dialog', async () => {
  const f = await opened(); f.ui.close(); await f.ui.open(); f.host.emit('close'); assert(f.host.open); assert(f.state.input); f.ui.destroy();
});
