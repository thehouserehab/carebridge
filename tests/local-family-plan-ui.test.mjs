// Pure controller/markup doubles only. No browser, API, database or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareUi, CareMutation, careFamilyPlanContent } from '../local-api/care-ui.js';
import { childMarkup } from '../local-api/workspace-ui.js';
import { LocalApiError } from '../local-api/client.js';

const plan = (extra = {}) => ({ conversationId: 'synthetic-room', childId: 'synthetic-child', revision: 3,
  concern: '가상 최신 가족 관심사', ...extra });
const view = (extra = {}) => ({ kind: 'family-plan', childId: 'synthetic-child', expectedRevision: 3,
  values: { concern: '가상 최신 가족 관심사' }, ...extra });
const context = () => ({ user: { userId: 'synthetic-guardian', centers: [{ id: 'synthetic-center', role: 'guardian' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', profile: { childId: 'synthetic-child', familyPlan: { concern: '가상 오래된 목록', revision: 1 } },
  connected: true, messages: [], generation: 1, signal: new AbortController().signal,
  careData: { goals: [], records: [], appointments: [] } });
const deferred = () => Promise.withResolvers();
function fixture(api = {}, callbacks = {}) {
  let current = context();
  const ui = new CareUi({ api, getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]); ui.owner = current.user.userId; ui.ownerRole = 'guardian';
  const state = { mutation: new CareMutation(() => 'synthetic-family-request'), records: [], goals: [], appointments: [], loaded: true, loading: false, view: null };
  ui.states.set(ui.key, state);
  const display = { html: '', title: '', kind: '', notices: { textContent: '' }, nodes: [], retry: null, count: 0 };
  const makeNode = (extra = {}) => ({ dataset: {}, disabled: false, value: '', closest: () => null,
    remove() { if (display.retry === this) display.retry = null; }, ...extra });
  const document = { activeElement: null, createElement: () => makeNode({ setAttribute() {} }) };
  ui.host = { ownerDocument: document, innerHTML: '', contains: () => false, querySelectorAll: () => [],
    querySelector: () => null, append() {}, replaceChildren() { this.innerHTML = ''; } };
  const form = { get elements() { return display.nodes; }, reportValidity: () => true,
    querySelectorAll: () => display.nodes,
    querySelector: (selector) => selector === '[data-care-action="retry"]' ? display.retry
      : selector === '.care-submit' ? { append: (node) => { display.retry = node; } } : null };
  ui.dialog = { open: false, querySelector: (selector) => selector === 'form' ? form
    : selector === '[data-care-error]' ? display.notices : null,
    querySelectorAll: () => display.nodes.filter((node) => node.name), close() { this.open = false; },
    replaceChildren() { display.html = ''; display.nodes = []; display.retry = null; }, remove() {} };
  ui.form = (title, kind, body, buttons) => {
    ui.wipeDialog(); Object.assign(display, { title, kind, html: body + buttons, count: display.count + 1 });
    display.notices.textContent = '';
    display.nodes = kind === 'family-plan' ? [makeNode({ type: 'textarea', name: 'concern', value: state.view.values.concern }),
      makeNode({ type: 'submit' }), makeNode({ type: 'button', dataset: { careAction: 'discard' } })] : [];
    ui.dialog.open = true; ui.lockForm();
  };
  return { ui, state, display, get current() { return current; }, setContext(next) { current = next; },
    input: () => display.nodes.find((node) => node.name === 'concern'), submit: () => display.nodes.find((node) => node.type === 'submit') };
}
async function opened(api = {}, callbacks = {}) {
  const f = fixture({ familyPlan: async () => plan(), ...api }, callbacks); await f.ui.handleAction('family-plan'); return f;
}

test('child screen displays escaped current shared concern and offers editing only to guardians', () => {
  const room = { conversationId: 'synthetic-room', profile: { name: '가상 아이', participants: [], familyPlan: { concern: '<b>가상 관심사</b>' } },
    care: { goals: [], records: [], appointments: [], publications: [] } };
  for (const role of ['guardian', 'therapist', 'center']) {
    const html = childMarkup(room, role, { label: '가상 조회 기간' });
    assert.match(html, /data-family-plan-concern/); assert.match(html, /&lt;b&gt;가상 관심사&lt;\/b&gt;/); assert(!html.includes('<b>'));
    assert.equal(html.includes('data-family-plan>'), role === 'guardian');
    if (role === 'guardian') { assert.match(html, /보호자들이 함께 작성/); assert.match(html, /담당 치료사와 보호자가 볼 수/); }
  }
  room.profile.familyPlan.concern = ''; assert.match(childMarkup(room, 'guardian', { label: '' }), /아직 등록되지 않았어요/);
});

test('content contains only the captured version and trimmed concern, preserving input including explicit clear', () => {
  const values = { concern: '  첫 줄\r\n둘째 줄 😀  ', role: 'center', body: 'DO-NOT-SEND', attachments: ['DO-NOT-BIND'] }, before = structuredClone(values);
  assert.deepEqual(careFamilyPlanContent(view(), values), { expectedRevision: 3, concern: '첫 줄\r\n둘째 줄 😀' });
  assert.deepEqual(values, before);
  for (const concern of ['', ' \t\n']) assert.deepEqual(careFamilyPlanContent(view({ expectedRevision: 0 }), { concern }), { expectedRevision: 0, concern: '' });
  assert.equal(careFamilyPlanContent(view({ expectedRevision: Number.MAX_SAFE_INTEGER }), { concern: 'a'.repeat(1000) }).expectedRevision, Number.MAX_SAFE_INTEGER);
});

test('content rejects stale, unsafe revisions, malformed text, raw overlength and forbidden controls', () => {
  for (const extra of [{ stale: true }, ...[-1, 0.5, '3', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({ expectedRevision }))])
    assert.throws(() => careFamilyPlanContent(view(extra), { concern: '가상 관심사' }));
  for (const concern of [undefined, null, false, 0, {}, ' ' + 'a'.repeat(1000), '\ud800', '\udfff', 'a\0b', 'a\vb', 'a\x1fb', 'a\x7fb', 'a\x85b'])
    assert.throws(() => careFamilyPlanContent(view(), { concern }));
  assert.equal(careFamilyPlanContent(view(), { concern: '😀'.repeat(500) }).concern.length, 1000);
});

test('opening pins one fresh atomic family GET rather than stale profile content and needs no clinical goals', async () => {
  const calls = [], f = await opened({ familyPlan: async (...args) => { calls.push(args); return plan(); },
    message: () => assert.fail('family context must not read messages'), goals: () => assert.fail('family editor needs no goals') });
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', f.current.signal]]); assert.deepEqual(f.state.view, view());
  assert.equal(f.input().value, '가상 최신 가족 관심사'); assert(!f.display.html.includes('가상 오래된 목록')); assert.equal(f.submit().disabled, false);
});

test('form escapes concern and clearly explains shared audience, future participants, clearing and no automatic communication', async () => {
  const f = await opened({ familyPlan: async () => plan({ concern: '<script>가상 관심사</script>' }) });
  assert.equal(f.display.title, '가족이 바라는 변화'); assert.equal(f.display.kind, 'family-plan');
  for (const copy of ['&lt;script&gt;', 'maxlength="1000"', '가족 관심사 저장', '보호자들이 함께 작성', '담당 치료사와 보호자',
    '새로 연결된 보호자·담당 치료사', '현재 내용만 지웁니다', '이미 남긴 내용은 지워지지', '메시지가 전송되거나 읽음으로 표시되지는']) assert(f.display.html.includes(copy), copy);
  assert(!f.display.html.includes('<script>')); assert(!/textarea[^>]*required/.test(f.display.html));
  for (const forbidden of ['data-record-upload', 'data-feedback-upload', '<img', '<video']) assert(!f.display.html.includes(forbidden));
});

test('opening denies therapist/center roles without fetching and rejects mismatched room or current child', async () => {
  for (const role of ['therapist', 'center']) {
    let calls = 0; const f = fixture({ familyPlan: async () => { calls++; return plan(); } }); f.current.user.centers[0].role = role;
    await f.ui.handleAction('family-plan'); assert.equal(calls, 0); assert.equal(f.state.view, null);
  }
  for (const extra of [{ childId: 'other-child' }, { conversationId: 'other-room' }]) {
    const f = await opened({ familyPlan: async () => plan(extra) }); assert.equal(f.state.view, null); assert.equal(f.display.count, 0);
  }
  const missing = fixture({ familyPlan: async () => plan() }); missing.current.profile = null;
  await missing.ui.handleAction('family-plan'); assert.equal(missing.state.view, null);
});

test('opening is single-flight and late results cannot reopen after account, room, role or navigation change', async () => {
  for (const change of ['account', 'room', 'role', 'navigation']) {
    const gate = deferred(); let calls = 0; const f = fixture({ familyPlan: () => { calls++; return gate.promise; } });
    const pending = f.ui.handleAction('family-plan'); await f.ui.handleAction('family-plan'); assert.equal(calls, 1);
    if (change === 'navigation') f.ui.suspend();
    else {
      const next = { ...f.current, generation: 2 };
      if (change === 'room') next.roomId = 'other-room';
      if (change === 'account') next.user = { ...next.user, userId: 'other-guardian' };
      if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'therapist' }] };
      f.setContext(next); f.ui.update(next);
    }
    gate.resolve(plan()); await pending; assert.equal(f.display.count, 0, change); assert.equal(f.ui.dialog?.open ?? false, false, change);
  }
});

test('unchanged polling preserves the existing DOM, unsaved concern and captured version', async () => {
  const f = await opened(), original = f.state.view, count = f.display.count; f.input().value = '가상 작성 중';
  assert.equal(await f.ui.guardView(f.current), true); assert.equal(f.state.view, original);
  assert.equal(f.input().value, '가상 작성 중'); assert.equal(f.display.count, count); assert.equal(original.expectedRevision, 3);
});

test('changed revision marks stale without merging shared content or allowing hidden submit bypass', async () => {
  let current = plan(), writes = 0; const f = await opened({ familyPlan: async () => current, familyPlanSave: async () => { writes++; } });
  f.input().value = '가상 충돌 이전 작성'; current = plan({ revision: 4, concern: 'NEW-SERVER-CONTENT' });
  await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true); assert.equal(f.state.view.expectedRevision, 3);
  assert.equal(f.input().value, '가상 충돌 이전 작성'); assert.equal(f.submit().disabled, true); assert.equal(f.input().disabled, false);
  assert(!f.display.html.includes('NEW-SERVER-CONTENT'));
  current = plan(); await f.ui.guardView(f.current); f.submit().disabled = false; await f.ui.submit();
  assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view.stale, true);
});

test('close/resume rechecks permission and keeps the draft rather than replacing it with current concern', async () => {
  let reads = 0; const f = await opened({ familyPlan: async () => { reads++; return plan(); } });
  f.input().value = '가상 이어쓸 관심사'; f.ui.close(); assert.equal(f.ui.dialog.open, false);
  await f.ui.handleAction('family-plan'); assert.equal(reads, 2); assert.equal(f.input().value, '가상 이어쓸 관심사'); assert.equal(f.state.view.expectedRevision, 3);
});

test('permission denial or cross-child response wipes the form before the owner invalidates other projections', async () => {
  for (const mode of ['NOT_FOUND', 'FORBIDDEN', 'child', 'room']) {
    let denied = false, calls = 0, f;
    f = await opened({ familyPlan: async () => {
      if (!denied) return plan();
      if (mode === 'child') return plan({ childId: 'other-child' }); if (mode === 'room') return plan({ conversationId: 'other-room' });
      throw new LocalApiError(mode, mode === 'FORBIDDEN' ? 403 : 404);
    } }, { onSourceUnavailable: () => { calls++; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null); } });
    const oldInput = f.input(); oldInput.value = 'PRIVATE-DRAFT'; denied = true;
    assert.equal(await f.ui.guardView(f.current), false); assert.equal(calls, 1); assert.equal(oldInput.value, ''); assert.equal(f.state.view, null);
  }
});

test('temporary permission-read failure hides DOM but retains only memory draft until a fresh successful read', async () => {
  let fail = false; const f = await opened({ familyPlan: async () => { if (fail) throw new LocalApiError('UNAVAILABLE'); return plan(); } });
  f.input().value = '가상 보존할 입력'; const original = f.state.view; fail = true;
  assert.equal(await f.ui.guardView(f.current), false); assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.state.view, original); assert.equal(original.values.concern, '가상 보존할 입력');
  await f.ui.handleAction('resume'); assert.equal(f.ui.dialog.open, false);
  fail = false; await f.ui.handleAction('resume'); assert.equal(f.input().value, '가상 보존할 입력');
});

test('explicit save sends one frozen child-bound command without message, read-state or record side effects', async () => {
  const writes = []; let changes = 0;
  const f = await opened({ familyPlanSave: async (...args) => writes.push(args), send: () => assert.fail('not a message'),
    read: () => assert.fail('not read state'), recordSave: () => assert.fail('not a clinical record') }, { onChanged: () => { changes++; } });
  f.input().value = '  가상 저장 관심사  '; await f.ui.submit(); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(0, 3), ['synthetic-center', 'synthetic-room', 'synthetic-child']);
  assert.deepEqual(writes[0][3], { clientId: 'synthetic-family-request', expectedRevision: 3, concern: '가상 저장 관심사' });
  assert(Object.isFrozen(writes[0][3])); assert.equal(writes[0][4], f.current.signal); assert.equal(changes, 1);
  assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null); assert.equal(f.display.html, '');
});

test('explicit empty clearing and maximum-safe no-op remain valid UI operations', async () => {
  for (const [revision, concern, changed] of [[0, '', false], [3, ' \n ', true], [Number.MAX_SAFE_INTEGER, '가상 최신 가족 관심사', false]]) {
    const writes = []; const f = await opened({ familyPlan: async () => plan({ revision }), familyPlanSave: async (...args) => {
      writes.push(args[3]); return { appliedVersion: revision + Number(changed), changed, replayed: false };
    } });
    f.input().value = concern; await f.ui.submit(); assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedRevision, revision); assert.equal(writes[0].concern, concern.trim()); assert.equal(f.state.view, null);
  }
});

test('first profile conflict preserves the editable concern and captured version while disabling stale submit', async () => {
  let writes = 0; const f = await opened({ familyPlanSave: async () => { writes++; throw new LocalApiError('PROFILE_CONFLICT', 409); } });
  f.input().value = '가상 충돌 작성'; await f.ui.submit(); assert.equal(writes, 1); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.state.view.stale, true); assert.equal(f.input().value, '가상 충돌 작성');
  assert.equal(f.input().disabled, false); assert.equal(f.submit().disabled, true); await f.ui.submit(); assert.equal(writes, 1);
});

test('unknown save becomes content-free receipt and repeats the same immutable operation even after later conflict', async () => {
  const writes = []; let attempts = 0, reads = 0;
  const f = await opened({ familyPlan: async () => { reads++; return plan(); }, familyPlanSave: async (...args) => {
    writes.push(args[3]); if (++attempts === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempts === 2) throw new LocalApiError('PROFILE_CONFLICT', 409);
  } });
  f.input().value = '가상 불확정 관심사'; await f.ui.submit(); const original = f.state.mutation.operation; assert(original);
  await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt'); assert.equal(reads, 1);
  assert.equal(f.display.title, '이전 요청 처리 확인'); assert(!f.display.html.includes('가상 불확정 관심사')); assert(!f.display.html.includes('textarea'));
  await f.ui.mutate(); assert.equal(f.state.mutation.operation, original); assert.equal(f.state.mutation.everUncertain, true);
  assert.equal(f.ui.discard(), false); await f.ui.mutate(); assert.equal(writes.length, 3);
  for (const body of writes) assert.equal(body, original.body); assert.equal(f.state.view, null);
});

test('first profile conflict after a polling receipt rechecks authority before restoring only a stale original draft', async () => {
  const saveGate = deferred(), readGate = deferred(); let reads = 0;
  const f = await opened({ familyPlan: () => ++reads === 1 ? Promise.resolve(plan()) : readGate.promise, familyPlanSave: () => saveGate.promise });
  f.input().value = '가상 영수증 전 작성'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
  assert.equal(f.state.view.kind, 'receipt'); saveGate.reject(new LocalApiError('PROFILE_CONFLICT', 409));
  await Promise.resolve(); await Promise.resolve(); assert(!f.display.html.includes('가상 영수증 전 작성'));
  readGate.resolve(plan({ revision: 4, concern: 'NEW-SERVER-CONTENT' })); await pending;
  assert.equal(reads, 2); assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view?.kind, 'family-plan');
  assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.state.view.stale, true); assert.equal(f.input().value, '가상 영수증 전 작성');
  assert.equal(f.submit().disabled, true); assert(!f.display.html.includes('NEW-SERVER-CONTENT'));
});

test('receipt conflict cannot restore a draft when the fresh permission read denies access', async () => {
  const gate = deferred(); let reads = 0;
  const f = await opened({ familyPlan: async () => { if (++reads > 1) throw new LocalApiError('NOT_FOUND', 404); return plan(); }, familyPlanSave: () => gate.promise });
  f.input().value = 'PRIVATE-CONFLICT-DRAFT'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
  gate.reject(new LocalApiError('PROFILE_CONFLICT', 409)); await pending;
  assert.equal(reads, 2); assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null); assert.equal(f.display.html, '');
});

test('receipt conflict with temporary revalidation failure retains only memory draft until a successful stale resume', async () => {
  const gate = deferred(); let reads = 0, unavailable = true;
  const f = await opened({ familyPlan: async () => {
    if (++reads > 1 && unavailable) throw new LocalApiError('UNAVAILABLE');
    return plan({ revision: reads === 1 ? 3 : 4, concern: reads === 1 ? '가상 최신 가족 관심사' : 'NEW-CONTENT' });
  }, familyPlanSave: () => gate.promise });
  f.input().value = '가상 유지할 충돌 입력'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
  gate.reject(new LocalApiError('PROFILE_CONFLICT', 409)); await pending;
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view?.kind, 'family-plan');
  assert.equal(f.state.view.values.concern, '가상 유지할 충돌 입력'); assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  unavailable = false; await f.ui.handleAction('resume');
  assert.equal(f.input().value, '가상 유지할 충돌 입력'); assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.submit().disabled, true);
  assert(!f.display.html.includes('NEW-CONTENT'));
});

test('late conflict permission check cannot restore the old form after account or room transition', async () => {
  for (const change of ['account', 'room']) {
    const saveGate = deferred(), readGate = deferred(), started = deferred(); let reads = 0;
    const f = await opened({ familyPlan: () => { if (++reads === 1) return Promise.resolve(plan()); started.resolve(); return readGate.promise; },
      familyPlanSave: () => saveGate.promise });
    f.input().value = 'PRIVATE-OLD-DRAFT'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
    saveGate.reject(new LocalApiError('PROFILE_CONFLICT', 409)); await started.promise;
    const next = { ...f.current, generation: 2 };
    if (change === 'account') next.user = { ...next.user, userId: 'other-guardian' }; else next.roomId = 'other-room';
    f.setContext(next); f.ui.update(next); readGate.resolve(plan({ revision: 4 })); await pending;
    assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, ''); assert.equal(f.ui.state().view, null);
  }
});

test('first revision limit rejection preserves input with an explicit limit notice rather than an unknown-result retry', async () => {
  const f = await opened({ familyPlan: async () => plan({ revision: Number.MAX_SAFE_INTEGER }),
    familyPlanSave: async () => { throw new LocalApiError('REVISION_LIMIT', 409); } });
  f.input().value = '가상 변경 내용'; await f.ui.submit();
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.mutation.everUncertain, false);
  assert.equal(f.input().value, '가상 변경 내용'); assert.equal(f.state.view.expectedRevision, Number.MAX_SAFE_INTEGER);
  assert.match(f.display.notices.textContent, /한도/); assert(!f.display.notices.textContent.includes('처리 결과를 확인하지 못'));
});

test('late save receipt cannot refresh or restore content after account transition', async () => {
  const gate = deferred(); let changes = 0; const f = await opened({ familyPlanSave: () => gate.promise }, { onChanged: () => { changes++; } });
  const pending = f.ui.submit(); const next = { ...f.current, generation: 2, user: { ...f.current.user, userId: 'synthetic-new-user' } };
  f.setContext(next); f.ui.update(next); gate.resolve({}); await pending;
  assert.equal(changes, 0); assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, ''); assert.equal(f.ui.state().view, null);
});

test('authentication loss purges memory and raw opening errors never enter public notices', async () => {
  let denied = false; const errors = [], f = await opened({ familyPlan: async () => {
    if (denied) throw new LocalApiError('AUTH_REQUIRED', 401); return plan();
  } }, { onError: (error) => errors.push(error.code) });
  denied = true; await f.ui.guardView(f.current); assert.deepEqual(errors, ['AUTH_REQUIRED']);
  assert.equal(f.ui.states.size, 0); assert.equal(f.display.html, '');
  const bad = fixture({ familyPlan: async () => { throw new Error('PRIVATE-RAW-CONTENT'); } });
  await bad.ui.handleAction('family-plan'); assert.equal(bad.state.view, null); assert(!bad.display.html.includes('PRIVATE-'));
  assert(!bad.display.notices.textContent.includes('PRIVATE-')); assert(!bad.ui.host.innerHTML.includes('PRIVATE-'));
});
