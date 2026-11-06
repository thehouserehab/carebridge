// Pure controller/markup doubles. No browser DOM, HTTP service, DB or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChildProfileDraft, OperationsUi, operationsListMarkup, operationsEditorMarkup } from '../local-api/operations-ui.js';
import { LocalApiError } from '../local-api/client.js';
import { ProfileFieldError } from '../src/profile-fields.js';

const profile = (extra = {}) => ({ conversationId: 'room-a', childId: 'child-a', name: '가상 아이', age: 0, ageAsOf: '2024-02-29', revision: 1, ...extra });
const other = () => profile({ conversationId: 'room-b', childId: 'child-b', name: '다른 가상 아이' });
const user = () => ({ userId: 'manager-a', email: 'manager@example.test', centers: [{ id: 'center-a', role: 'center' }, { id: 'center-b', role: 'guardian' }] });
const code = (expected) => (error) => error instanceof LocalApiError && error.code === expected;
const deferred = () => Promise.withResolvers();
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const node = (extra = {}) => ({ disabled: false, hidden: false, textContent: '', innerHTML: '', listeners: [],
  addEventListener(type, handler, options) { this.listeners.push({ type, handler, signal: options?.signal }); },
  replaceChildren() { this.innerHTML = ''; this.textContent = ''; }, ...extra });

// The stub models only the controller's queried controls and replacement of its
// content host. It does not claim HTML validity, layout, focus or native events.
function hostStub() {
  const display = { html: '', form: null, contentHtml: '', replacements: 0, focused: 0, center: node(), title: node() };
  display.title.focus = (options) => { assert.equal(options.preventScroll, true); display.focused++; };
  const content = node();
  Object.defineProperty(content, 'innerHTML', {
    get: () => display.contentHtml,
    set(value) {
      display.contentHtml = value; display.replacements++; display.form = null;
      if (!value.includes('data-testid="operations-form"')) return;
      const elements = Object.fromEntries(['name', 'age', 'ageAsOf'].map((key) => {
        const raw = new RegExp(`<input name="${key}" value="([^"]*)"`).exec(value)?.[1];
        assert.notEqual(raw, undefined, `stub input ${key} missing`);
        return [key, node({ value: decode(raw), name: key })];
      }));
      const controls = new Map(['[type="submit"]', '[data-ops-action="retry"]', '[data-ops-action="discard"]',
        '[data-ops-error]', '[data-ops-conflict]'].map((key) => [key, node()]));
      display.form = { elements, controls, querySelector: (key) => controls.get(key) ?? null,
        querySelectorAll: (key) => key === 'input' ? Object.values(elements) : [],
        matches: (key) => key === '[data-testid="operations-form"]' };
    },
  });
  const host = node({ contains: () => true,
    querySelector(selector) {
      if (selector === '[data-ops-content]') return display.html.includes('data-ops-content') ? content : null;
      if (selector === '[data-ops-center]') return display.html.includes('data-ops-center') ? display.center : null;
      if (selector === '[data-testid="operations-form"]') return display.form;
      if (selector === '[data-ops-title]') return display.contentHtml.includes('data-ops-title') ? display.title : null;
      return null;
    },
    replaceChildren() { display.html = ''; content.innerHTML = ''; },
  });
  Object.defineProperty(host, 'innerHTML', { get: () => display.html, set: (value) => { display.html = value; } });
  return { host, display };
}
function fixture(overrides = {}, callbacks = {}) {
  const { host, display } = hostStub(), profiles = new Map([profile(), other()].map((p) => [p.conversationId, p]));
  const identity = user(), calls = [], notices = [], denied = [];
  const transport = { expectedUserId: identity.userId, request: () => assert.fail('controller test must use its scoped API double'),
    session: async (signal) => { calls.push(['session', signal]); return structuredClone(identity); } };
  const ui = new OperationsUi({ host, transport, user: structuredClone(identity), centerId: 'center-a',
    announce: (message) => notices.push(message), onDenied: (error) => { denied.push(error); callbacks.onDenied?.(error); }, ...callbacks });
  const api = {
    children: async (center, signal) => { calls.push(['children', center, signal]); return [...profiles.values()].map((p) => ({ ...p })); },
    childProfile: async (center, room, signal) => { calls.push(['detail', center, room, signal]); return { ...profiles.get(room) }; },
    childProfileSave: async (center, room, child, operation, signal) => {
      calls.push(['save', center, room, child, operation, signal]);
      profiles.set(room, { ...profiles.get(room), ...operation.content, revision: operation.expectedRevision + 1 });
      return { operation: 'child.save', childId: child, conversationId: room, appliedVersion: operation.expectedRevision + 1, changed: true, replayed: false };
    }, ...overrides,
  };
  ui.api = api; ui.mount();
  return { ui, api, profiles, identity, transport, host, display, calls, notices, denied,
    input: (key = 'name') => display.form?.elements[key], control: (key) => display.form?.querySelector(key) };
}
async function opened(overrides = {}, callbacks = {}) {
  const f = fixture(overrides, callbacks); await f.ui.refresh(); await f.ui.open('room-a'); return f;
}
async function settled(ui) {
  for (let i = 0; ui.pending && i < 50; i++) await Promise.resolve();
  assert.equal(ui.pending, null, 'bounded controller continuation should settle');
}

test('interrupted first invitation import returns to a reloadable list and cannot mount late', async () => {
  const f = fixture({}, { invitationsEnabled: true }); await f.ui.refresh();
  const pending = f.ui.openInvitations(); assert.equal(f.ui.mode, 'invitations');
  f.ui.suspend(); assert.equal(f.ui.mode, 'profile'); assert.equal(f.ui.invitations, null);
  await pending; assert.equal(f.ui.invitations, null);
  await f.ui.refresh(); assert.equal(f.ui.connected, true); assert.match(f.display.contentHtml, /data-ops-action="invitations"/);
  f.ui.destroy();
});

test('draft keeps initial null, explicit zero, separate input values and exact child/version identity', () => {
  const empty = new ChildProfileDraft(profile({ name: null, age: null, ageAsOf: null, revision: 0 }));
  assert.deepEqual(empty.values, { name: '', age: '', ageAsOf: '' }); assert.equal(empty.revision, 0);
  const p = profile(), draft = new ChildProfileDraft(p); assert.equal(draft.values.age, '0');
  draft.values.name = '가상 입력'; assert.equal(p.name, '가상 아이');
  assert.equal(draft.childId, p.childId); assert.equal(draft.roomId, p.conversationId); assert.equal(draft.revision, 1);
});

test('draft first save validates raw fields and freezes a minimal immutable command without source mutation', () => {
  const draft = new ChildProfileDraft(profile()); draft.values.name = ' 가상 입력 ';
  const operation = draft.begin(() => 'synthetic-save-id');
  assert.deepEqual(operation, { clientId: 'synthetic-save-id', expectedRevision: 1,
    content: { name: '가상 입력', age: 0, ageAsOf: '2024-02-29' } });
  assert(Object.isFrozen(operation)); assert(Object.isFrozen(operation.content));
  assert.equal(draft.values.name, ' 가상 입력 '); assert.equal(draft.sending, true); assert.equal(draft.begin(), null);
  assert.throws(() => { operation.content.name = 'altered'; }, TypeError);
});

test('draft strict validation rejects mismatched age/date, controls, invalid numbers and future dates before allocating an operation', () => {
  for (const value of [{ name: '' }, { name: '\ud800' }, { name: '가상\n이름' }, { age: '-1' }, { age: '0.5' }, { age: '27' },
    { age: '' }, { ageAsOf: '' }, { ageAsOf: '2023-02-29' }, { ageAsOf: '9999-01-01' }]) {
    const draft = new ChildProfileDraft(profile()); Object.assign(draft.values, value);
    assert.throws(() => draft.begin(), ProfileFieldError); assert.equal(draft.operation, null); assert.equal(draft.sending, false);
  }
  const draft = new ChildProfileDraft(profile()); Object.assign(draft.values, { age: '', ageAsOf: '' });
  assert.equal(draft.begin().content.age, null);
});

test('first definitive rejection unlocks only known safe outcomes; conflict requires a fresh comparison', () => {
  for (const error of [new LocalApiError('INVALID_INPUT', 0), new LocalApiError('INVALID_INPUT', 400), new LocalApiError('INVALID_INPUT', 413),
    new LocalApiError('PROFILE_CONFLICT', 409), new LocalApiError('REVISION_LIMIT', 409)]) {
    const draft = new ChildProfileDraft(profile()), operation = draft.begin(); draft.failed(operation, error);
    assert.equal(draft.operation, null); assert.equal(draft.sending, false); assert.equal(draft.uncertain, false);
    assert.equal(draft.values.name, '가상 아이');
    if (error.code === 'PROFILE_CONFLICT') { assert(draft.stale); assert.equal(draft.latest, null); assert.equal(draft.compare(true), false); }
  }
});

test('unknown, cancellation, unsafe code/status and interrupt keep the original command across later definitive conflicts', () => {
  for (const error of [new LocalApiError('UNAVAILABLE'), new LocalApiError('CANCELLED'), new LocalApiError('INVALID_RESPONSE'),
    new LocalApiError('IDEMPOTENCY_CONFLICT', 409), new LocalApiError('PROFILE_CONFLICT', 503), new Error('PRIVATE-RAW')]) {
    const draft = new ChildProfileDraft(profile()), operation = draft.begin(() => 'original-save-id'); draft.failed(operation, error);
    draft.values.name = 'should not enter retry'; assert.equal(draft.begin(() => assert.fail('new ID forbidden')), operation);
    draft.failed(operation, new LocalApiError('PROFILE_CONFLICT', 409)); assert.equal(draft.operation, operation);
    assert(draft.uncertain); assert(!draft.error.includes('PRIVATE-')); assert.equal(draft.compare(false), false);
  }
  const draft = new ChildProfileDraft(profile()), operation = draft.begin(); draft.interrupt();
  assert.equal(draft.operation, operation); assert(draft.uncertain); assert.equal(draft.sending, false);
});

test('late failure cannot clear another operation and unchanged profile reconciliation never overwrites input', () => {
  const draft = new ChildProfileDraft(profile()), operation = draft.begin(); draft.failed({}, new LocalApiError('INVALID_INPUT', 400));
  assert.equal(draft.operation, operation); assert.equal(draft.sending, true);
  const editable = new ChildProfileDraft(profile()); editable.values.name = '가상 미저장'; editable.reconcile(profile());
  assert.equal(editable.values.name, '가상 미저장'); assert.equal(editable.stale, false);
  for (const change of [{ childId: 'other-child' }, { conversationId: 'other-room' }])
    assert.throws(() => editable.reconcile(profile(change)), code('INVALID_RESPONSE'));
});

test('changed revision stays stale until explicit keep/replace and version advances without automatic save or merge', () => {
  for (const keep of [true, false]) {
    const draft = new ChildProfileDraft(profile()); draft.values.name = '가상 내 입력';
    draft.reconcile(profile({ revision: 2, name: '가상 최신 내용' })); assert.equal(draft.revision, 1);
    assert.throws(() => draft.begin(), code('PROFILE_CONFLICT')); assert.equal(draft.values.name, '가상 내 입력');
    assert.equal(draft.compare(keep), true); assert.equal(draft.values.name, keep ? '가상 내 입력' : '가상 최신 내용');
    assert.equal(draft.revision, 2); assert.equal(draft.operation, null); assert.equal(draft.stale, false);
    assert.equal(draft.compare(keep), false);
  }
  const draft = new ChildProfileDraft(profile()); draft.reconcile(profile({ revision: 2 })); draft.reconcile(profile());
  assert(draft.stale, 'a later old read must not silently remove an already detected conflict');
});

test('list/editor markup escape labels and IDs and do not expose private DTO extras or offer clinical navigation', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const p = profile({ name: attack, conversationId: attack, privateNote: 'PRIVATE-NOTE', familyPlan: { concern: 'PRIVATE-CONCERN' }, participants: ['PRIVATE-PERSON'] });
  const list = operationsListMarkup([p], new Map([[attack, {}]])), editor = operationsEditorMarkup(new ChildProfileDraft(p));
  for (const html of [list, editor]) { assert(!html.includes('<img')); assert(html.includes('&lt;img')); assert(!html.includes('PRIVATE-')); }
  assert(list.includes('작성 중인 입력 이어보기')); assert(list.includes('치료 대화와 임상 기록은 조회하지 않습니다'));
  for (const label of ['name="name"', 'name="age"', 'name="ageAsOf"', 'maxlength="30"', 'max="26"', 'role="status"',
    '메시지는 자동 전송하지 않습니다', '0세와 미등록은 다릅니다', '브라우저 새로고침·센터 전환·로그아웃 시 사라집니다',
    'class="care-actions care-submit"']) assert(editor.includes(label), label);
  assert(!/data-open-room|data-view="chat"|data-care-action/.test(list + editor));
  assert(operationsListMarkup([]).includes('등록된 아이가 없습니다'));
});

test('initial mount has no child data and refresh authenticates a current center session before listing', async () => {
  const f = fixture(); assert.equal(f.ui.connected, false); assert.equal(f.display.form, null); assert(!f.display.contentHtml.includes('가상 아이'));
  await f.ui.refresh(); assert.deepEqual(f.calls.map(([name]) => name), ['session', 'children']);
  assert.equal(f.ui.connected, true); assert(f.display.contentHtml.includes('가상 아이')); assert.equal(f.ui.states.size, 0);
  await f.ui.open('unknown-room'); assert.equal(f.calls.length, 2); assert.equal(f.ui.selected, null);
});

test('unchanged list polling neither rebuilds child buttons nor forces focus away from keyboard navigation', async () => {
  const f = fixture(); await f.ui.refresh(); const replacements = f.display.replacements, focused = f.display.focused;
  await f.ui.refresh(); await f.ui.refresh();
  assert.equal(f.display.replacements, replacements, 'poll must retain the same unchanged list nodes');
  assert.equal(f.display.focused, focused, 'background poll must not focus the page heading');
});

test('opening always fetches fresh exact-child detail, while unchanged refresh preserves input DOM and pinned version', async () => {
  const f = await opened(), form = f.display.form; f.input().value = '가상 이어쓰기';
  assert.deepEqual(f.calls.filter(([name]) => name === 'detail').map((args) => args.slice(0, 3)), [['detail', 'center-a', 'room-a']]);
  await f.ui.refresh(); assert.equal(f.display.form, form); assert.equal(f.input().value, '가상 이어쓰기');
  assert.equal(f.ui.current().revision, 1); assert.equal(f.ui.current().values.name, '가상 이어쓰기');
  assert.equal(f.control('[type="submit"]').disabled, false);
});

test('refresh is single flight and a partial list failure hides DOM without discarding an editable draft', async () => {
  const f = await opened(), draft = f.ui.current(); f.input().value = '가상 보존';
  const gate = deferred(); let reads = 0; f.api.children = async () => { reads++; return gate.promise; };
  const pending = f.ui.refresh(); await Promise.resolve(); await f.ui.refresh(); assert.equal(reads, 1);
  gate.reject(new LocalApiError('UNAVAILABLE')); await pending;
  assert.equal(f.ui.connected, false); assert.deepEqual(f.ui.children, []); assert.equal(f.display.form, null);
  assert.equal(f.ui.current(), draft); assert.equal(draft.values.name, '가상 보존');
  f.api.children = async () => [...f.profiles.values()]; await f.ui.refresh(); assert.equal(f.input().value, '가상 보존');
});

test('drafts stay separated per child and returning to a child rechecks detail before restoring values', async () => {
  const f = await opened(); f.input().value = '가상 A 초안'; const first = f.ui.current();
  await f.ui.open('room-b'); assert.equal(f.input().value, '다른 가상 아이'); f.input().value = '가상 B 초안';
  const second = f.ui.current(); await f.ui.open('room-a');
  assert.equal(f.ui.current(), first); assert.notEqual(first, second); assert.equal(f.input().value, '가상 A 초안');
  assert.equal(second.values.name, '가상 B 초안'); assert.equal(f.calls.filter(([name]) => name === 'detail').length, 3);
  assert.equal(f.ui.hasPendingWrite(), false);
});

test('pagination absence does not purge a selected draft when an exact current detail remains authorized', async () => {
  const f = await opened(), state = f.ui.current(); f.input().value = '가상 입력';
  f.api.children = async () => []; await f.ui.refresh();
  assert.equal(f.ui.current(), state); assert.equal(f.ui.connected, true); assert.equal(f.input().value, '가상 입력');
});

test('changed current detail exposes an escaped explicit comparison and cannot submit until reviewed', async () => {
  const f = await opened(); f.input().value = '가상 내 입력'; f.profiles.set('room-a', profile({ revision: 2, name: '<b>가상 최신</b>' }));
  await f.ui.refresh(); const state = f.ui.current(); assert(state.stale); assert.equal(state.revision, 1);
  assert.equal(f.input().value, '가상 내 입력'); assert.equal(f.control('[type="submit"]').disabled, true);
  const comparison = f.control('[data-ops-conflict]'); assert.equal(comparison.hidden, false);
  assert(comparison.innerHTML.includes('&lt;b&gt;')); assert(!comparison.innerHTML.includes('<b>'));
  await f.ui.save(); assert.equal(f.calls.filter(([name]) => name === 'save').length, 0);
  f.ui.compare(true); assert.equal(state.revision, 2); assert.equal(f.input().value, '가상 내 입력');
  assert.equal(state.operation, null); assert.equal(f.control('[type="submit"]').disabled, false);
});

test('unchanged conflict polling keeps the comparison controls in place for keyboard review', async () => {
  const f = await opened(); f.profiles.set('room-a', profile({ revision: 2, name: '가상 서버 최신' })); await f.ui.refresh();
  const form = f.display.form, comparison = f.control('[data-ops-conflict]'); let html = comparison.innerHTML, writes = 0;
  Object.defineProperty(comparison, 'innerHTML', { get: () => html, set: (value) => { html = value; writes++; } });
  f.ui.controls(); await f.ui.refresh(); assert.equal(f.display.form, form); assert.equal(writes, 0);
  assert.equal(f.control('[data-ops-conflict]'), comparison); assert.equal(comparison.hidden, false);
  f.profiles.set('room-a', profile({ revision: 3, name: '가상 변경된 최신' })); await f.ui.refresh();
  assert.equal(writes, 1); assert(html.includes('가상 변경된 최신')); assert.equal(f.ui.current().revision, 1);
});

test('first CAS conflict keeps original input, requires fresh latest detail and explicit keep/replace before a new command', async () => {
  let writes = 0; const f = await opened({ childProfileSave: async () => { writes++; throw new LocalApiError('PROFILE_CONFLICT', 409); } });
  f.input().value = '가상 충돌 입력'; await f.ui.save(); const state = f.ui.current();
  assert.equal(writes, 1); assert.equal(state.operation, null); assert(state.stale); assert.equal(state.latest, null);
  assert.equal(f.input().disabled, false); assert.equal(f.control('[type="submit"]').disabled, true);
  f.ui.compare(true); assert.equal(state.revision, 1); await f.ui.save(); assert.equal(writes, 1);
  f.profiles.set('room-a', profile({ revision: 2, name: '가상 서버 최신' })); await f.ui.refresh();
  f.ui.compare(false); assert.equal(f.input().value, '가상 서버 최신'); assert.equal(state.revision, 2); assert.equal(state.operation, null);
});

test('first input/limit rejection unlocks correction without allocating another command or losing input', async () => {
  for (const error of [new LocalApiError('INVALID_INPUT', 400), new LocalApiError('REVISION_LIMIT', 409)]) {
    const f = await opened({ childProfileSave: async () => { throw error; } }); f.input().value = '가상 수정 중';
    await f.ui.save(); assert.equal(f.ui.current().operation, null); assert.equal(f.input().value, '가상 수정 중');
    assert.equal(f.input().disabled, false); assert.equal(f.control('[type="submit"]').disabled, false);
    assert(f.control('[data-ops-error]').textContent.length > 0);
  }
});

test('unknown save locks editing/discard/center switch, and explicit retry retains identical operation even after later conflict', async () => {
  const writes = []; const f = await opened({ childProfileSave: async (...args) => { writes.push(args);
    throw new LocalApiError(writes.length === 1 ? 'UNAVAILABLE' : 'PROFILE_CONFLICT', writes.length === 1 ? 0 : 409); } });
  f.input().value = '가상 저장 입력'; await f.ui.save(); const operation = f.ui.current().operation;
  assert(operation); assert.equal(f.input().disabled, true); assert.equal(f.control('[type="submit"]').disabled, true);
  assert.equal(f.control('[type="submit"]').hidden, true);
  assert.equal(f.control('[data-ops-action="discard"]').disabled, true); assert.equal(f.display.center.disabled, true);
  assert.equal(f.control('[data-ops-action="retry"]').hidden, false); f.ui.discard(); assert.equal(f.ui.current().operation, operation);
  f.input().value = 'tampered disabled input'; await f.ui.save(); assert.equal(writes[1][3], operation);
  assert.equal(operation.content.name, '가상 저장 입력'); assert.equal(f.ui.current().operation, operation); assert(f.ui.current().uncertain);
});

test('an unresolved saved request survives reopening at a newer server revision and only its exact retry clears the draft', async () => {
  const writes = []; const f = await opened({ childProfileSave: async (...args) => {
    writes.push(args);
    if (writes.length === 1) {
      f.profiles.set('room-a', profile({ revision: 2, name: args[3].content.name }));
      throw new LocalApiError('UNAVAILABLE');
    }
    return { operation: 'child.save', childId: 'child-a', conversationId: 'room-a', appliedVersion: 2, changed: true, replayed: true };
  } });
  f.input().value = '가상 서버저장 후 응답유실'; await f.ui.save(); const operation = f.ui.current().operation;
  f.ui.back(); await settled(f.ui); await f.ui.open('room-a');
  assert.equal(f.ui.current().revision, 1); assert(f.ui.current().stale); assert.equal(f.ui.current().operation, operation);
  assert.equal(f.control('[data-ops-conflict]').hidden, true); assert.equal(f.input().disabled, true);
  await f.ui.save(); assert.equal(writes.length, 2); assert.equal(writes[1][3], operation);
  assert.equal(f.ui.states.has('room-a'), false); assert.equal(f.ui.selected, null); assert.equal(f.ui.hasPendingWrite(), false);
  assert.equal(f.display.center.disabled, false);
});

test('successful save clears only its child draft after receipt and refreshes without any clinical side effect', async () => {
  const f = await opened(); f.input().value = '가상 A 초안'; await f.ui.open('room-b'); f.input().value = '가상 B 보존';
  await f.ui.open('room-a'); const otherState = f.ui.states.get('room-b'); f.input().value = '가상 A 저장'; await f.ui.save();
  const writes = f.calls.filter(([name]) => name === 'save'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(1, 4), ['center-a', 'room-a', 'child-a']); assert.equal(writes[0][4].content.name, '가상 A 저장');
  assert.equal(f.ui.selected, null); assert.equal(f.ui.states.has('room-a'), false); assert.equal(f.ui.states.get('room-b'), otherState);
  assert.equal(otherState.values.name, '가상 B 보존'); assert.equal(f.ui.connected, true);
  assert(f.notices.some((text) => text.includes('메시지는 전송하지 않았습니다')));
  assert(f.calls.every(([name]) => ['session', 'children', 'detail', 'save'].includes(name)));
});

test('back during a pending write aborts the old request, keeps its unknown receipt and ignores late success/failure', async () => {
  for (const outcome of ['success', 'error']) {
    const gate = deferred(), writes = []; const f = await opened({ childProfileSave: async (...args) => { writes.push(args); return gate.promise; } });
    f.input().value = '가상 전송 중'; const pending = f.ui.save(), state = f.ui.current(), operation = state.operation;
    f.ui.back(); await settled(f.ui); assert.equal(f.ui.selected, null); assert.equal(f.display.form, null);
    assert(writes[0][4].aborted); assert.equal(state.operation, operation); assert(state.uncertain); assert.equal(state.sending, false);
    if (outcome === 'success') gate.resolve({}); else gate.reject(new LocalApiError('PROFILE_CONFLICT', 409));
    await pending; assert.equal(f.ui.selected, null); assert.equal(state.operation, operation);
    assert(!f.notices.some((text) => text.includes('저장했어요')));
    await f.ui.open('room-a'); assert.equal(f.ui.current(), state); assert.equal(f.input().disabled, true);
    assert.equal(state.begin(() => assert.fail('must retry original')), operation); state.interrupt();
  }
});

test('opening another child during pending save never puts the old receipt or content in the new child', async () => {
  const gate = deferred(); const f = await opened({ childProfileSave: () => gate.promise });
  f.input().value = '가상 A 미확인'; const pending = f.ui.save(), first = f.ui.current(); await f.ui.open('room-b');
  const second = f.ui.current(); assert.equal(f.ui.selected, 'room-b'); assert.equal(f.input().value, '다른 가상 아이');
  gate.resolve({}); await pending; assert.equal(f.ui.current(), second); assert.equal(f.ui.states.get('room-a'), first);
  assert(first.operation); assert.equal(second.operation, null);
});

test('offline suspension hides all operational content, preserves memory draft/unknown operation and requires fresh reads to resume', async () => {
  const f = await opened(); f.input().value = '가상 오프라인 입력'; const state = f.ui.current(); f.ui.suspend();
  assert.equal(f.display.form, null); assert(!f.display.contentHtml.includes('가상 오프라인 입력')); assert.equal(state.values.name, '가상 오프라인 입력');
  const before = f.calls.length; await f.ui.refresh(); assert(f.calls.length > before); assert.equal(f.input().value, '가상 오프라인 입력');
  const gate = deferred(); f.api.childProfileSave = () => gate.promise; const pending = f.ui.save(); f.ui.suspend();
  assert(state.operation); assert(state.uncertain); assert.equal(f.display.form, null); gate.resolve({}); await pending;
  assert.equal(f.ui.connected, false); assert.equal(f.ui.states.get('room-a'), state);
});

test('account, center role and membership loss clear drafts and DOM before notifying the owner', async () => {
  for (const change of ['account', 'role', 'membership']) {
    let f, notified = 0;
    f = await opened({}, { onDenied: () => { notified++; assert.equal(f.display.html, ''); assert.equal(f.ui.states.size, 0); } });
    f.input().value = 'PRIVATE-DRAFT';
    if (change === 'account') f.identity.userId = 'other-manager';
    else if (change === 'role') f.identity.centers[0].role = 'guardian'; else f.identity.centers = [];
    await f.ui.refresh(); assert.equal(notified, 1); assert(f.ui.destroyed); assert.equal(f.ui.children.length, 0);
    assert(!f.display.contentHtml.includes('PRIVATE-DRAFT')); assert(f.ui.events.signal.aborted);
  }
});

test('detail or save permission denials wipe content and requests rather than retaining a resumable private draft', async () => {
  for (const mode of ['detail', 'save']) for (const errorCode of ['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN']) {
    const f = await opened(); f.input().value = 'PRIVATE-DRAFT';
    if (mode === 'detail') { f.api.childProfile = async () => { throw new LocalApiError(errorCode, 403); }; await f.ui.refresh(); }
    else { f.api.childProfileSave = async () => { throw new LocalApiError(errorCode, 403); }; await f.ui.save(); }
    assert(f.ui.destroyed); assert.equal(f.ui.states.size, 0); assert.equal(f.display.html, ''); assert.equal(f.denied.length, 1);
  }
});

test('late detail after navigation, suspension or destroy cannot reopen the previous child', async () => {
  for (const action of ['back', 'suspend', 'destroy']) {
    const f = fixture(), gate = deferred(); await f.ui.refresh(); f.api.childProfile = () => gate.promise;
    const pending = f.ui.open('room-a');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    f.ui[action](); gate.resolve(profile({ name: 'PRIVATE-LATE' })); await pending; await settled(f.ui);
    assert.equal(f.display.form, null); assert(!f.display.contentHtml.includes('PRIVATE-LATE')); assert.equal(f.ui.states.size, 0);
    if (action === 'destroy') assert.equal(f.display.html, '');
  }
});

test('late session success after destroy cannot start a child collection or restore the center screen', async () => {
  const f = fixture(), gate = deferred(); f.transport.session = () => gate.promise;
  const pending = f.ui.refresh(); f.ui.destroy(); gate.resolve(user()); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.display.html, ''); assert.equal(f.ui.states.size, 0);
});

test('destroy aborts both lifecycles, clears every draft and ignores late write results without resurrecting a host', async () => {
  for (const outcome of ['success', 'error']) {
    const gate = deferred(); const f = await opened({ childProfileSave: () => gate.promise }); f.input().value = 'PRIVATE-SAVE';
    const pending = f.ui.save(), controller = f.ui.controller; f.ui.destroy();
    assert(controller.signal.aborted); assert(f.ui.controller.signal.aborted); assert(f.ui.events.signal.aborted);
    assert.equal(f.ui.states.size, 0); assert.equal(f.ui.selected, null); assert.equal(f.display.html, '');
    if (outcome === 'success') gate.resolve({}); else gate.reject(new Error('PRIVATE-RAW'));
    await pending; await f.ui.refresh(); await f.ui.save(); assert.equal(f.display.html, ''); assert.equal(f.ui.states.size, 0);
  }
});

test('event ownership blocks center changes during unresolved writes and uses captured actions without storing browser data', async () => {
  const changes = [], f = await opened({}, { onCenterChange: (value) => changes.push(value) });
  const listener = f.display.center.listeners.find((item) => item.type === 'change'); assert(listener);
  listener.handler({ target: { value: 'center-b' } }); assert.deepEqual(changes, ['center-b']);
  const state = f.ui.current(); state.begin(); state.interrupt(); f.ui.controls();
  listener.handler({ target: { value: 'center-b' } }); assert.equal(changes.length, 1); assert.equal(f.display.center.disabled, true);
  f.ui.destroy(); assert(listener.signal.aborted); assert(f.host.listeners.every((item) => item.signal.aborted));
});
