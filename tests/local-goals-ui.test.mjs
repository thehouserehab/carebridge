// Pure controller/markup doubles only. No browser, server, database or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareUi, CareMutation, careRecordContent } from '../local-api/care-ui.js';
import { GoalApiClient } from '../local-api/goal-client.js';
import { childMarkup } from '../local-api/workspace-ui.js';
import { LocalApiError } from '../local-api/client.js';

const goal = (extra = {}) => ({ id: 'synthetic-goal', conversationId: 'synthetic-room', childId: 'synthetic-child',
  revision: 3, title: '가상 최신 목표', description: '함께 확인할 가상 설명', status: 'active', updatedAt: '2026-10-09T00:00:00.000Z', ...extra });
const values = (extra = {}) => ({ title: '가상 최신 목표', description: '함께 확인할 가상 설명', status: 'active', ...extra });
const context = () => ({ user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', profile: { childId: 'synthetic-child', conversationId: 'synthetic-room' },
  connected: true, messages: [], generation: 1, signal: new AbortController().signal,
  careData: { goals: [goal({ title: '가상 오래된 목록', revision: 1 })], records: [], appointments: [] } });
const deferred = () => Promise.withResolvers();
const validator = new GoalApiClient({ request: async () => assert.fail('normalization must not send HTTP') });

function fixture(goalApi = {}, api = {}, callbacks = {}) {
  let current = context();
  const ui = new CareUi({ api: { profile: async () => ({ ...current.profile }), ...api },
    goalApi: { goal: async () => goal(), save: async () => ({}), content: (input) => validator.content(input), ...goalApi },
    getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]); ui.owner = current.user.userId; ui.ownerRole = 'therapist';
  const state = { mutation: new CareMutation(() => 'synthetic-goal-request'), records: [], goals: structuredClone(current.careData.goals),
    appointments: [], loaded: true, loading: false, view: null };
  ui.states.set(ui.key, state);
  const display = { html: '', title: '', kind: '', notices: { textContent: '' }, nodes: [], assessmentRows: [], retry: null, count: 0, comparisonWrites: 0 };
  const makeNode = (extra = {}) => ({ dataset: {}, disabled: false, value: '', closest: () => null,
    remove() { if (display.retry === this) display.retry = null; }, ...extra });
  const document = { activeElement: null, body: {}, createElement: () => makeNode({ setAttribute() {} }) };
  const makeComparison = () => { let comparisonHtml = ''; return { hidden: true,
    get innerHTML() { return comparisonHtml; },
    set innerHTML(value) {
      // Browser serialization drops spaces before a tag's closing bracket.
      // Preserve that observable distinction rather than comparing raw strings.
      comparisonHtml = value.replace(/" +>/g, '">'); display.comparisonWrites++;
      if (document.activeElement?.section === this) document.activeElement = document.body;
    },
  }; };
  let comparison = null;
  ui.host = { ownerDocument: document, innerHTML: '', contains: () => false, querySelectorAll: () => [],
    querySelector: () => null, append() {}, replaceChildren() { this.innerHTML = ''; } };
  const form = { get elements() { display.nodes.namedItem = (name) => display.nodes.find((node) => node.name === name); return display.nodes; }, reportValidity: () => true,
    querySelectorAll: (selector) => selector === '[data-assessment-row]' ? display.assessmentRows : display.nodes,
    querySelector: (selector) => selector === '[data-care-action="retry"]' ? display.retry
      : selector === '.care-submit' ? { append: (node) => { display.retry = node; } } : null };
  ui.dialog = { open: false, querySelector: (selector) => selector === 'form' ? (display.html ? form : null)
    : selector === '[data-care-error]' ? display.notices : selector === '[data-goal-conflict]' ? comparison : null,
    querySelectorAll: () => display.nodes.filter((node) => node.name), close() { this.open = false; },
    replaceChildren() { display.html = ''; display.nodes = []; display.assessmentRows = []; display.retry = null; comparison = null; }, remove() {} };
  ui.form = (title, kind, body, buttons) => {
    ui.wipeDialog(); Object.assign(display, { title, kind, html: body + buttons, count: display.count + 1 });
    display.notices.textContent = '';
    comparison = kind === 'goal' ? makeComparison() : null;
    display.nodes = kind === 'goal' ? ['title', 'description', 'status'].map((name) => makeNode({
      type: name === 'description' ? 'textarea' : name === 'status' ? 'select-one' : 'text', name, value: state.view.values[name] })) : [];
    if (kind === 'record') {
      const v = state.view.values;
      const named = { ...Object.fromEntries(['date', 'title', 'goalId', 'performed', 'response', 'nextPlan', 'summary', 'privateNote'].map((key) => [key, v[key] ?? ''])),
        ...Object.fromEntries(Object.entries(v.observation ?? {}).map(([key, value]) => [`observation${key[0].toUpperCase()}${key.slice(1)}`, value])),
        ...Object.fromEntries(Object.entries(v.activity ?? {}).map(([key, value]) => [`activity${key[0].toUpperCase()}${key.slice(1)}`, value])) };
      display.nodes = Object.entries(named).map(([name, value]) => makeNode({ name, value: String(value), type: 'text' }));
      display.assessmentRows = (v.assessments ?? []).map((row) => ({ querySelector: (selector) => {
        const key = selector.match(/data-assessment-field="([^"]+)"/)?.[1]; return { value: String(row[key] ?? '') };
      } }));
    }
    if (['goal', 'record'].includes(kind)) display.nodes.push(makeNode({ type: 'submit' }), makeNode({ type: 'button', dataset: { careAction: 'discard' } }));
    ui.dialog.open = true; ui.lockForm();
  };
  return { ui, state, display, get comparison() { return comparison; }, document, get current() { return current; }, setContext(next) { current = next; },
    input: (name = 'title') => display.nodes.find((node) => node.name === name), submit: () => display.nodes.find((node) => node.type === 'submit') };
}
async function opened(goalApi = {}, api = {}, callbacks = {}) {
  const f = fixture(goalApi, api, callbacks); await f.ui.handleAction('edit-goal', 'synthetic-goal'); return f;
}

function recordFixture(api = {}, callbacks = {}, revision = 0) {
  const calls = [], f = fixture({}, {
    profile: async (...args) => { calls.push(['profile', ...args]); return { conversationId: 'synthetic-room', childId: 'synthetic-child' }; },
    message: async (...args) => { calls.push(['message', ...args]); return { id: 'synthetic-reference', conversationId: 'synthetic-room', type: 'text', hidden: false, deleted: false, body: '현재 참고 내용' }; },
    record: async (...args) => { calls.push(['record', ...args]); return { id: 'synthetic-record', conversationId: 'synthetic-room' }; }, ...api,
  }, callbacks);
  const view = f.ui.newRecord(f.state); view.recordId = 'synthetic-record'; view.expectedRevision = revision;
  view.goals = [goal()]; view.references = [{ messageId: 'synthetic-reference', messageRevision: 1, body: '기록에 선택한 당시 참고' }];
  view.values = { ...view.values, date: '2026-10-09', title: '가상 보존할 기록', performed: '가상 저장할 활동', response: '가상 저장할 반응',
    nextPlan: '가상 다음 계획', summary: '가상 공개 요약', privateNote: '가상 비공개 입력',
    assessments: [{ tool: '가상 도구', item: '가상 항목', value: 0, unit: '회', context: '가상 동일 조건' }],
    attachments: [{ id: '00000000-0000-4000-8000-000000000001', name: 'synthetic.png', type: 'image/png', size: 12, share: false }] };
  f.state.view = view; f.ui.display();
  const body = { expectedRevision: revision, expectedGoalRevision: 3, content: careRecordContent(view.values, 'saved', view.references,
    view.values.attachments.map(({ id, share }) => ({ id, share }))) };
  const operation = f.state.mutation.begin('record', view.recordId, body);
  return { ...f, get current() { return f.current; }, calls, view, operation };
}

const appointment = (extra = {}) => ({ id: 'synthetic-appointment', conversationId: 'synthetic-room', childId: 'synthetic-child',
  revision: 2, date: '2026-10-09', time: '11:00', duration: 30, title: '가상 일정', room: '가상 공간', status: 'scheduled', ...extra });
function refreshFixture(api = {}, linked = false) {
  const f = recordFixture(api, {}, 2); f.state.mutation.rejected(f.operation);
  f.view.contextStale = true; f.view.values.goalSnapshot = { title: '당시 고정 목표', revision: 1, description: '', status: 'active' };
  if (linked) {
    f.view.values.appointmentId = 'synthetic-appointment'; f.view.appointment = appointment(); f.view.expectedAppointmentRevision = 2;
    f.view.values.appointmentSnapshot = { date: '2026-10-09', time: '10:00', revision: 1, title: '당시 고정 일정' };
  }
  f.ui.display(); f.ui.snapshot(); return f;
}

test('first record CONTEXT_CHANGED after a polling receipt restores captured input/goals/references only after fresh authority', async () => {
  const gate = deferred(), f = recordFixture({ recordSave: () => gate.promise });
  const before = structuredClone(f.view), pending = f.ui.mutate(true);
  await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt'); assert(!f.display.html.includes('가상 비공개 입력'));
  gate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await pending;
  assert.equal(f.state.view?.kind, 'record'); assert.deepEqual(f.state.view.values, before.values);
  assert.deepEqual(f.state.view.goals, before.goals); assert.deepEqual(f.state.view.references, before.references);
  assert.equal(f.state.view.expectedRevision, 0); assert.equal(f.state.view.goals[0].revision, f.operation.body.expectedGoalRevision);
  assert.equal(f.state.mutation.operation, null); assert.equal(f.input('performed').value, before.values.performed);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'message']);
});

test('record conflict recovery keeps the form hidden until both current room and referenced source checks complete', async () => {
  const saveGate = deferred(), profileGate = deferred(), sourceGate = deferred(), profileStarted = deferred(), sourceStarted = deferred();
  const f = recordFixture({ recordSave: () => saveGate.promise,
    profile: () => { profileStarted.resolve(); return profileGate.promise; },
    message: () => { sourceStarted.resolve(); return sourceGate.promise; } });
  const pending = f.ui.mutate(true); await f.ui.guardView(f.current);
  saveGate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await profileStarted.promise;
  assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  profileGate.resolve({ ...f.current.profile }); await sourceStarted.promise;
  assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  sourceGate.resolve({ id: 'synthetic-reference', conversationId: 'synthetic-room', hidden: false, deleted: false }); await pending;
  assert.equal(f.ui.dialog.open, true); assert.equal(f.input('privateNote').value, '가상 비공개 입력');
  assert.equal(f.state.view.references[0].body, '기록에 선택한 당시 참고');
});

test('record recovery clears all owned state on profile denial and only invalidates sources after profile authority succeeds', async () => {
  for (const boundary of ['profile-not-found', 'profile-forbidden', 'profile-child', 'profile-room', 'reference-hidden', 'reference-deleted', 'reference-not-found']) {
    const saveGate = deferred(), errors = []; let invalidated = 0, sourceReads = 0, f;
    f = recordFixture({ recordSave: () => saveGate.promise,
      profile: async () => {
        if (boundary === 'profile-not-found') throw new LocalApiError('NOT_FOUND', 404);
        if (boundary === 'profile-forbidden') throw new LocalApiError('FORBIDDEN', 403);
        return { ...f.current.profile, ...(boundary === 'profile-child' ? { childId: 'other-child' } : {}), ...(boundary === 'profile-room' ? { conversationId: 'other-room' } : {}) };
      }, message: async () => {
        sourceReads++;
        if (boundary === 'reference-not-found') throw new LocalApiError('NOT_FOUND', 404);
        return { id: 'synthetic-reference', conversationId: 'synthetic-room', hidden: boundary === 'reference-hidden', deleted: boundary === 'reference-deleted' };
      } }, { onError: (error) => errors.push(error.code),
        onSourceUnavailable: () => { invalidated++; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null); } });
    const privateInput = f.input('privateNote');
    const pending = f.ui.mutate(true); await f.ui.guardView(f.current); saveGate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await pending;
    assert.equal(f.display.html, '', boundary); assert.equal(privateInput.value, '');
    assert.equal(f.state.mutation.operation, null);
    if (boundary.startsWith('profile-')) {
      assert.equal(f.ui.dialog, null); assert.equal(f.ui.states.size, 0); assert.equal(f.ui.state(), undefined);
      assert.equal(sourceReads, 0); assert.equal(invalidated, 0);
      assert.deepEqual(errors, [boundary === 'profile-not-found' ? 'NOT_FOUND' : 'FORBIDDEN']);
    } else {
      assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null);
      assert.equal(sourceReads, 1); assert.equal(invalidated, 1); assert.deepEqual(errors, []);
    }
  }
});

test('a temporary profile read failure keeps rejected record input only in memory and rechecks it before resume', async () => {
  const gate = deferred(); let reads = 0, unavailable = true;
  const f = recordFixture({ recordSave: () => gate.promise,
    profile: async () => { reads++; if (unavailable) throw new LocalApiError('UNAVAILABLE'); return { ...f.current.profile }; } });
  const before = structuredClone(f.view), pending = f.ui.mutate(true); await f.ui.guardView(f.current);
  gate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await pending;
  assert.equal(reads, 1); assert.equal(f.state.view?.kind, 'record'); assert.equal(f.state.mutation.operation, null);
  assert.deepEqual(f.state.view.values, before.values); assert.deepEqual(f.state.view.goals, before.goals); assert.deepEqual(f.state.view.references, before.references);
  assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  await f.ui.handleAction('resume'); assert.equal(reads, 2); assert.equal(f.ui.dialog.open, false);
  unavailable = false; await f.ui.handleAction('resume'); assert.equal(reads, 3); assert.equal(f.ui.dialog.open, true);
  assert.equal(f.input('performed').value, before.values.performed); assert.equal(f.state.view.goals[0].revision, 3);
});

test('late record conflict recovery cannot revive inputs after account, room, role or navigation change', async () => {
  for (const change of ['account', 'room', 'role', 'navigation']) {
    const saveGate = deferred(), readGate = deferred(), started = deferred();
    const f = recordFixture({ recordSave: () => saveGate.promise, profile: () => { started.resolve(); return readGate.promise; } });
    const pending = f.ui.mutate(true); await f.ui.guardView(f.current); saveGate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await started.promise;
    if (change === 'navigation') f.ui.suspend();
    else {
      const next = { ...f.current, generation: 2 };
      if (change === 'account') next.user = { ...next.user, userId: 'another-therapist' };
      if (change === 'room') { next.roomId = 'another-room'; next.profile = { childId: 'another-child', conversationId: 'another-room' }; }
      if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
      f.setContext(next); f.ui.update(next);
    }
    readGate.resolve({ childId: 'synthetic-child', conversationId: 'synthetic-room' }); await pending;
    assert.equal(f.ui.dialog?.open ?? false, false, change); assert.equal(f.display.html, '');
    if (change !== 'navigation') assert.equal(f.ui.state().view, null);
  }
});

test('an unknown record commit followed by CONTEXT_CHANGED keeps the same content-free receipt and never restores editable input', async () => {
  const writes = []; let attempts = 0, reads = 0;
  const f = recordFixture({ recordSave: async (...args) => {
    writes.push(args[3]); if (++attempts === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempts === 2) throw new LocalApiError('CONTEXT_CHANGED', 409);
  }, profile: async () => { reads++; return { ...f.current.profile }; } });
  await f.ui.mutate(true); const original = f.state.mutation.operation; await f.ui.guardView(f.current);
  assert.equal(f.state.view.kind, 'receipt'); await f.ui.mutate();
  assert.equal(f.state.mutation.operation, original); assert.equal(f.state.mutation.everUncertain, true); assert.equal(f.state.view.kind, 'receipt');
  assert(!f.display.html.includes('가상 비공개 입력')); assert(!f.display.html.includes('textarea')); assert.equal(reads, 0);
  assert.equal(f.ui.discard(), false); await f.ui.mutate(); assert.equal(f.state.view, null);
  assert.equal(writes.length, 3); for (const body of writes) assert.equal(body, original.body);
});

test('restoring an existing saved record uses its independent read authority rather than reviving current hidden source', async () => {
  const gate = deferred(), f = recordFixture({ recordSave: () => gate.promise,
    message: () => assert.fail('saved clinical references retain independent authority') }, {}, 2);
  const before = structuredClone(f.view), pending = f.ui.mutate(true); await f.ui.guardView(f.current);
  gate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await pending;
  assert.equal(f.state.view?.kind, 'record'); assert.equal(f.state.view.expectedRevision, 2); assert.deepEqual(f.state.view.references, before.references);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'record']); assert.equal(f.input('performed').value, before.values.performed);
});

test('first definite record or reference conflicts restore original input only after fresh authority without adopting current versions', async () => {
  for (const code of ['REFERENCE_CHANGED', 'RECORD_CONFLICT']) {
    const gate = deferred(); let writes = 0;
    const f = recordFixture({ recordSave: () => { writes++; return gate.promise; } });
    const before = structuredClone(f.view), pending = f.ui.mutate(true);
    await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt'); assert(!f.display.html.includes('가상 비공개 입력'));
    gate.reject(new LocalApiError(code, 409)); await pending;
    assert.equal(f.state.view, f.view); assert.deepEqual(f.view.values, before.values);
    assert.deepEqual(f.view.references, before.references); assert.deepEqual(f.view.goals, before.goals);
    assert.equal(f.view.expectedRevision, before.expectedRevision); assert.notEqual(f.view.contextStale, true);
    assert.equal(f.view.goals[0].revision, f.operation.body.expectedGoalRevision);
    assert.equal(f.state.mutation.operation, null); assert.equal(writes, 1);
    assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'message']);
    assert.equal(f.input('privateNote').value, before.values.privateNote);
  }
});

test('unconfirmed or non-API context errors cannot restore record source content', async () => {
  for (const error of [new LocalApiError('CONTEXT_CHANGED', 0), Object.assign(new Error('PRIVATE-RAW'), { code: 'CONTEXT_CHANGED', status: 409 })]) {
    const gate = deferred(), f = recordFixture({ recordSave: () => gate.promise });
    const pending = f.ui.mutate(true); await f.ui.guardView(f.current); gate.reject(error); await pending;
    assert.notEqual(f.state.view?.kind, 'record'); assert.equal(f.calls.length, 0); assert(!f.display.html.includes('가상 비공개 입력'));
    assert(!f.display.html.includes('PRIVATE-RAW'));
  }
});

test('first actual context conflict marks both an open record and a receipt-restored record stale and blocks resubmission', async () => {
  for (const receipt of [false, true]) {
    const gate = deferred(); let writes = 0;
    const f = recordFixture({ recordSave: () => { writes++; return gate.promise; } });
    const pending = f.ui.mutate(true); if (receipt) await f.ui.guardView(f.current);
    gate.reject(new LocalApiError('CONTEXT_CHANGED', 409)); await pending;
    assert.equal(f.state.view?.contextStale, true); assert.equal(f.state.mutation.operation, null); assert.equal(f.submit().disabled, true);
    assert.match(f.display.html, /data-care-action="record-context-refresh"/);
    f.submit().disabled = false; await f.ui.submit(); assert.equal(writes, 1); assert.equal(f.state.mutation.operation, null);
    assert.equal(f.input('performed').value, '가상 저장할 활동'); assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'message']);
  }
});

test('explicit record context refresh changes only selected current goal metadata after rechecking authority, never authored data', async () => {
  let writes = 0; const goals = [], f = refreshFixture({ recordSave: async () => { writes++; } });
  f.view.goals.push(goal({ id: 'another-goal', revision: 2, title: '다른 선택지' }));
  const originalOther = f.view.goals[1], before = structuredClone(f.view);
  f.ui.goalApi.goal = async (...args) => { goals.push(args); return goal({ revision: 4, title: '<새 목표>', status: 'paused' }); };
  await f.ui.refreshRecordContext();
  assert.deepEqual(f.calls.map(([kind]) => kind), ['profile', 'record']);
  assert.deepEqual(goals, [['synthetic-center', 'synthetic-room', 'synthetic-goal', f.current.signal]]);
  assert.equal(f.view.goals[0].revision, 4); assert.equal(f.view.goals[0].title, '<새 목표>'); assert.deepEqual(f.view.goals[1], originalOther);
  assert.deepEqual(f.view.values, before.values); assert.deepEqual(f.view.references, before.references); assert.equal(f.view.expectedRevision, 2);
  assert.equal(f.view.contextStale, false); assert.equal(f.view.contextRefreshed, true); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.submit().disabled, false); assert.equal(writes, 0); assert.match(f.display.html, /&lt;새 목표&gt;/); assert(!f.display.html.includes('<새 목표>'));
});

test('linked goal and appointment refresh is all-or-nothing and uses the exact selected IDs without changing historical snapshots', async () => {
  const gate = deferred(), started = deferred(), requests = [];
  const f = refreshFixture({ appointment: (...args) => { requests.push(args); started.resolve(); return gate.promise; } }, true);
  f.ui.goalApi.goal = async () => goal({ revision: 5, title: '가상 새 목표' });
  const before = structuredClone(f.view), pending = f.ui.refreshRecordContext(); await started.promise;
  assert.deepEqual(f.view.goals, before.goals); assert.equal(f.view.expectedAppointmentRevision, 2);
  gate.resolve(appointment({ revision: 4, date: '2026-10-10', time: '12:00', title: '가상 변경 일정' })); await pending;
  assert.deepEqual(requests, [['synthetic-center', 'synthetic-room', 'synthetic-appointment', f.current.signal]]);
  assert.equal(f.view.goals[0].revision, 5); assert.equal(f.view.expectedAppointmentRevision, 4); assert.equal(f.view.appointment.time, '12:00');
  assert.deepEqual(f.view.values, before.values); assert.deepEqual(f.view.references, before.references); assert.equal(f.view.expectedRevision, 2);
  assert.equal(f.view.values.date, '2026-10-09'); assert.equal(f.view.values.goalSnapshot.revision, 1); assert.equal(f.view.values.appointmentSnapshot.revision, 1);
});

test('only a later explicit record save uses refreshed context versions and leaves immutable author content intact', async () => {
  const writes = [], f = refreshFixture({ appointment: async () => appointment({ revision: 4 }), recordSave: async (...args) => writes.push(args[3]) }, true);
  f.ui.goalApi.goal = async () => goal({ revision: 5 });
  await f.ui.refreshRecordContext(); assert.equal(writes.length, 0); await f.ui.submit(); assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedRevision, 2); assert.equal(writes[0].expectedGoalRevision, 5); assert.equal(writes[0].expectedAppointmentRevision, 4);
  assert.equal(writes[0].content.performed, '가상 저장할 활동'); assert.equal(writes[0].content.privateNote, '가상 비공개 입력');
  assert.equal(writes[0].content.assessments[0].value, 0); assert.deepEqual(writes[0].content.referenceMessageIds, ['synthetic-reference']);
  assert(Object.isFrozen(writes[0])); assert(Object.isFrozen(writes[0].content));
});

test('record context refresh refuses non-record/other-role/offline/unknown operations without any reads or pin changes', async () => {
  for (const boundary of ['view', 'guardian', 'center', 'offline', 'unknown']) {
    const f = refreshFixture(); let goals = 0; f.ui.goalApi.goal = async () => { goals++; return goal({ revision: 4 }); };
    const before = structuredClone(f.view.goals);
    if (boundary === 'view') f.state.view = { kind: 'receipt', values: {} };
    if (['guardian', 'center'].includes(boundary)) f.current.user.centers[0].role = boundary;
    if (boundary === 'offline') f.current.connected = false;
    if (boundary === 'unknown') { f.state.mutation.begin('record', f.view.recordId, f.operation.body); f.state.mutation.failed(f.state.mutation.operation); }
    const operation = f.state.mutation.operation; await f.ui.refreshRecordContext();
    assert.equal(goals, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.view.goals, before); assert.equal(f.state.mutation.operation, operation);
  }
});

test('record context refresh is single-flight and holds the save boundary until the one lookup completes', async () => {
  const gate = deferred(), started = deferred(); let reads = 0, writes = 0;
  const f = refreshFixture({ recordSave: async () => { writes++; } });
  f.ui.goalApi.goal = () => { reads++; started.resolve(); return gate.promise; };
  const pending = f.ui.refreshRecordContext(); await started.promise; await f.ui.refreshRecordContext();
  assert.equal(reads, 1); assert.equal(f.submit().disabled, true); await f.ui.submit(); assert.equal(writes, 0);
  gate.resolve(goal({ revision: 4 })); await pending;
  assert.equal(f.view.contextStale, false); assert.equal(f.view.goals[0].revision, 4); assert.equal(f.submit().disabled, false);
});

test('wrong selected goal identity, child or room rejects refresh without changing any pinned context or author content', async () => {
  for (const extra of [{ id: 'other-goal' }, { childId: 'other-child' }, { conversationId: 'other-room' }]) {
    const f = refreshFixture(); f.ui.goalApi.goal = async () => goal({ revision: 4, ...extra }); const before = structuredClone(f.view);
    await f.ui.refreshRecordContext(); assert.deepEqual(f.view.goals, before.goals); assert.deepEqual(f.view.values, before.values);
    assert.equal(f.view.expectedRevision, 2); assert.equal(f.view.contextStale, true); assert.notEqual(f.view.contextRefreshed, true);
  }
});

test('failed goal or appointment refresh never applies a successful partial result or discards author input', async () => {
  for (const boundary of ['goal', 'appointment', 'appointment-room', 'appointment-id']) {
    const f = refreshFixture({ appointment: async () => {
      if (boundary === 'appointment') throw new LocalApiError('UNAVAILABLE');
      return appointment({ revision: 4, ...(boundary === 'appointment-room' ? { conversationId: 'other-room' } : {}),
        ...(boundary === 'appointment-id' ? { id: 'other-appointment' } : {}) });
    } }, true);
    f.ui.goalApi.goal = async () => { if (boundary === 'goal') throw new LocalApiError('UNAVAILABLE'); return goal({ revision: 5 }); };
    const before = structuredClone(f.view); await f.ui.refreshRecordContext();
    assert.deepEqual(f.view.goals, before.goals); assert.deepEqual(f.view.appointment, before.appointment);
    assert.equal(f.view.expectedAppointmentRevision, 2); assert.deepEqual(f.view.values, before.values);
    assert.equal(f.view.contextStale, true); assert.notEqual(f.view.contextRefreshed, true);
  }
});

test('permission denial before context lookup clears all owned record state and cannot revive old metadata', async () => {
  let goals = 0, f; f = refreshFixture({ profile: async () => { throw new LocalApiError('NOT_FOUND', 404); } });
  const errors = []; f.ui.onError = (error) => errors.push(error.code);
  f.ui.onSourceUnavailable = () => assert.fail('current room denial must clear authority, not only the source');
  f.ui.goalApi.goal = async () => { goals++; return goal({ revision: 4 }); };
  const before = structuredClone(f.view.goals), privateInput = f.input('privateNote'); await f.ui.refreshRecordContext();
  assert.equal(goals, 0); assert.equal(f.ui.states.size, 0); assert.equal(f.ui.state(), undefined);
  assert.equal(f.display.html, ''); assert.equal(f.ui.dialog, null); assert.equal(privateInput.value, '');
  assert.deepEqual(errors, ['NOT_FOUND']); assert.deepEqual(f.view.goals, before);
});

test('late context refresh cannot repin or reopen a record after account, child, role, suspension or explicit close', async () => {
  for (const change of ['account', 'room', 'role', 'suspend', 'close']) {
    const gate = deferred(), started = deferred(), f = refreshFixture();
    f.ui.goalApi.goal = () => { started.resolve(); return gate.promise; };
    const before = structuredClone(f.view.goals), pending = f.ui.refreshRecordContext(); await started.promise;
    if (change === 'suspend') f.ui.suspend();
    else if (change === 'close') f.ui.close();
    else {
      const next = { ...f.current, generation: 2 };
      if (change === 'account') next.user = { ...next.user, userId: 'other-therapist' };
      if (change === 'room') { next.roomId = 'other-room'; next.profile = { childId: 'other-child', conversationId: 'other-room' }; }
      if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
      f.setContext(next); f.ui.update(next);
    }
    gate.resolve(goal({ revision: 4 })); await pending;
    assert.deepEqual(f.view.goals, before, change); assert.equal(f.ui.dialog?.open ?? false, false, change); assert.equal(f.display.html, '');
  }
});

test('unchanged stale-goal polling preserves the comparison DOM and its keyboard focus after HTML normalization', async () => {
  let current = goal(); const f = await opened({ goal: async () => current });
  current = goal({ revision: 4, title: '서버의 가상 변경' }); await f.ui.guardView(f.current);
  const writes = f.display.comparisonWrites, focused = { section: f.comparison, closest: () => null };
  f.document.activeElement = focused; f.input().value = '가상 작성 중';
  await f.ui.guardView(f.current); await f.ui.guardView(f.current);
  assert.equal(f.display.comparisonWrites, writes); assert.equal(f.document.activeElement, focused);
  assert.equal(f.input().value, '가상 작성 중'); assert.equal(f.state.view.expectedRevision, 3);
});

test('child screen offers goal actions only to therapists, including an empty goal list', () => {
  const room = { conversationId: 'synthetic-room', profile: { name: '가상 아동', participants: [] },
    care: { goals: [], records: [], appointments: [], publications: [] } };
  for (const role of ['therapist', 'guardian', 'center']) {
    const empty = childMarkup(room, role, { label: '가상 기간' });
    assert.equal(empty.includes('data-goal-new'), role === 'therapist'); assert.match(empty, /등록된 목표가 없습니다/);
    room.care.goals = ['active', 'achieved', 'paused'].map((status) => goal({ id: `goal-${status}`, title: '<가상 목표>', description: '<가상 설명>', status }));
    const html = childMarkup(room, role, { label: '가상 기간' });
    assert.equal(html.includes('data-goal-edit'), role === 'therapist'); assert.match(html, /&lt;가상 목표&gt;/); assert.match(html, /&lt;가상 설명&gt;/);
    assert(!html.includes('<가상 목표>')); for (const status of ['진행 중', '달성', '잠시 보류']) assert(html.includes(status));
    assert(!html.includes('목표·일정 변경은 아직')); room.care.goals = [];
  }
});

test('new goal needs fresh current-room authority but no existing goals or clinical records', async () => {
  const calls = [], f = fixture({ goal: () => assert.fail('new goal has no saved source') }, {
    profile: async (...args) => { calls.push(args); return { conversationId: 'synthetic-room', childId: 'synthetic-child' }; },
    record: () => assert.fail('new goal must not read records') });
  f.state.goals = []; f.state.loaded = false; await f.ui.handleAction('new-goal');
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', f.current.signal]]);
  const view = f.state.view; assert.equal(view.kind, 'goal'); assert.equal(view.childId, 'synthetic-child');
  assert.match(view.goalId, /^[a-f0-9-]{36}$/); assert.equal(view.expectedRevision, 0);
  assert.deepEqual(view.values, { title: '', description: '', status: 'active' });
  assert.equal(f.display.title, '목표 추가'); assert.equal(f.submit().disabled, false);
  const id = view.goalId; f.ui.discard(); await f.ui.handleAction('new-goal'); assert.notEqual(f.state.view.goalId, id);
});

test('editing pins one fresh current goal response and never edits cached list content', async () => {
  const calls = [], f = await opened({ goal: async (...args) => { calls.push(args); return goal(); } }, {
    record: () => assert.fail('goal edit must not fetch clinical record'), message: () => assert.fail('not a message') });
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', 'synthetic-goal', f.current.signal]]);
  assert.equal(f.state.view.expectedRevision, 3); assert.deepEqual(f.state.view.values, values());
  assert.equal(f.input().value, '가상 최신 목표'); assert(!f.display.html.includes('가상 오래된 목록'));
  assert.equal(f.display.title, '목표 수정'); assert.equal(f.display.kind, 'goal');
});

test('opening enforces therapist role, selected goal membership and exact current child/room', async () => {
  for (const name of ['new-goal', 'edit-goal']) {
    for (const role of ['guardian', 'center']) {
      let reads = 0; const f = fixture({ goal: async () => { reads++; return goal(); } }, { profile: async () => { reads++; return {}; } });
      f.current.user.centers[0].role = role; await f.ui.handleAction(name, 'synthetic-goal');
      assert.equal(reads, 0); assert.equal(f.state.view, null);
    }
    for (const extra of [{ childId: 'other-child' }, { conversationId: 'other-room' }]) {
      const f = fixture({ goal: async () => goal(extra) }, { profile: async () => ({ ...f.current.profile, ...extra }) });
      await f.ui.handleAction(name, 'synthetic-goal'); assert.equal(f.state.view, null); assert.equal(f.display.count, 0);
    }
  }
  let reads = 0; const f = fixture({ goal: async () => { reads++; return goal(); } });
  await f.ui.handleAction('edit-goal', 'not-in-selected-room'); assert.equal(reads, 0); assert.equal(f.state.view, null);
});

test('new/edit opening is single-flight and late account, room, role or navigation results never reopen a form', async () => {
  for (const name of ['new-goal', 'edit-goal']) for (const change of ['account', 'room', 'role', 'navigation']) {
    const gate = deferred(); let reads = 0;
    const f = fixture({ goal: () => { reads++; return gate.promise; } }, { profile: () => { reads++; return gate.promise; } });
    const pending = f.ui.handleAction(name, 'synthetic-goal'); await f.ui.handleAction(name, 'synthetic-goal'); assert.equal(reads, 1);
    if (change === 'navigation') f.ui.suspend();
    else {
      const next = { ...f.current, generation: 2 };
      if (change === 'account') next.user = { ...next.user, userId: 'other-user' };
      if (change === 'room') { next.roomId = 'other-room'; next.profile = { conversationId: 'other-room', childId: 'other-child' }; }
      if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
      f.setContext(next); f.ui.update(next);
    }
    gate.resolve(goal()); await pending; assert.equal(f.display.count, 0, `${name}/${change}`);
    assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, '');
  }
});

test('goal form explains current shared visibility and historical preservation with escaped bounded fields', async () => {
  const f = await opened({ goal: async () => goal({ title: '<가상 목표>', description: '<script>가상 설명</script>' }) });
  for (const copy of ['현재 연결된 보호자', '담당 치료사', '새로 연결된 참여자', '이전 기록에 남은 당시 목표는 바뀌지',
    '메시지나 치료 기록은 자동 생성하지', 'maxlength="100"', 'maxlength="2000"', '목표 상태', '목표 저장',
    '&lt;가상 목표&gt;', '&lt;script&gt;']) assert(f.display.html.includes(copy), copy);
  assert(!f.display.html.includes('<script>')); assert(!f.display.html.includes('data-record-upload'));
  for (const status of ['active', 'achieved', 'paused']) assert(f.display.html.includes(`value="${status}"`));
});

test('blank, malformed or overlong goals never allocate a mutation even if browser validity is bypassed', async () => {
  let writes = 0; const f = await opened({ save: async () => { writes++; } });
  for (const [key, value] of [['title', ''], ['title', ' '], ['title', 'a\nb'], ['title', '\ud800'], ['title', 'a'.repeat(101)],
    ['description', 'a'.repeat(2001)], ['description', '\0'], ['status', 'deleted']]) {
    for (const field of ['title', 'description', 'status']) f.input(field).value = values()[field];
    f.input(key).value = value; await f.ui.submit(); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null);
  }
});

test('save creates one deeply frozen minimal goal command without any chat/read/record side effects', async () => {
  for (const status of ['active', 'achieved', 'paused']) {
    const writes = []; let changes = 0;
    const f = await opened({ save: async (...args) => writes.push(args) }, {
      send: () => assert.fail('not a message'), markRead: () => assert.fail('not a read'), recordSave: () => assert.fail('not a record') },
    { onChanged: () => { changes++; } });
    f.input().value = '  가상 저장 목표  '; f.input('description').value = '  '; f.input('status').value = status;
    await f.ui.submit(); assert.equal(writes.length, 1); const [center, room, id, body, signal] = writes[0];
    assert.deepEqual([center, room, id], ['synthetic-center', 'synthetic-room', 'synthetic-goal']);
    assert.deepEqual(body, { clientId: 'synthetic-goal-request', expectedRevision: 3,
      content: { title: '가상 저장 목표', description: '', status } });
    assert(Object.isFrozen(body)); assert(Object.isFrozen(body.content)); assert.equal(signal, f.current.signal);
    assert.equal(changes, 1); assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null); assert.equal(f.display.html, '');
  }
});

test('an existing record draft and its captured goal list/snapshot win over a new goal-editor request', async () => {
  let reads = 0; const f = fixture({ goal: async () => { reads++; return goal(); } }, {
    profile: async () => { reads++; return f.current.profile; }, record: async () => ({ id: 'synthetic-record', conversationId: 'synthetic-room' }) });
  const historical = { title: '기록 당시 목표', revision: 1, description: '기록 당시 설명', status: 'active' };
  const view = { kind: 'record', recordId: 'synthetic-record', expectedRevision: 1,
    values: { performed: '작성 중 활동', goalId: 'synthetic-goal', goalSnapshot: historical }, references: [], goals: [goal({ revision: 1, title: historical.title })] };
  f.state.view = view; let displays = 0; f.ui.display = () => { displays++; };
  await f.ui.handleAction('new-goal'); assert.equal(f.state.view, view); assert.equal(reads, 0); assert.equal(displays, 1);
  const before = structuredClone(view); f.current.careData.goals = [goal({ revision: 4, title: '현재 다른 목표' })];
  f.ui.update(f.current); await f.ui.guardView(f.current);
  assert.deepEqual(view, before); assert.equal(f.state.goals[0].revision, 4); assert.equal(view.goals[0].revision, 1);
});

test('record form labels its escaped historical goal separately from the current selection without mutating either snapshot', () => {
  const f = fixture(), historical = { title: '<당시 목표>', revision: 1, description: '가상 당시 설명', status: 'active' };
  const recordView = f.ui.newRecord(f.state); recordView.expectedRevision = 1;
  recordView.values.goalSnapshot = historical;
  recordView.goals = [goal({ revision: 3, title: '<현재 확인 목표>' })];
  f.state.view = recordView; const before = structuredClone(recordView);
  f.ui.display();
  for (const copy of ['data-record-goal-snapshot', '이 기록에 저장된 당시 목표', '&lt;당시 목표&gt;', '(1번째 내용)',
    '다시 저장하면 위에서 확인한 현재 목표를 연결합니다', '&lt;현재 확인 목표&gt;']) assert(f.display.html.includes(copy), copy);
  assert(!f.display.html.includes('<당시 목표>')); assert(!f.display.html.includes('<현재 확인 목표>'));
  f.state.goals = [goal({ revision: 4, title: '더 늦게 바뀐 목표' })]; f.ui.display();
  assert(!f.display.html.includes('더 늦게 바뀐 목표')); assert.deepEqual(recordView, before); assert.equal(recordView.values.goalSnapshot, historical);
});

test('unchanged polling does not recreate input nodes, steal focus or replace the captured revision', async () => {
  const f = await opened(), original = f.state.view, input = f.input(), renders = f.display.count;
  input.value = '작성 중 가상 목표'; f.document.activeElement = input;
  await f.ui.guardView(f.current); await f.ui.guardView(f.current);
  assert.equal(f.state.view, original); assert.equal(f.input(), input); assert.equal(f.display.count, renders);
  assert.equal(f.document.activeElement, input); assert.equal(input.value, '작성 중 가상 목표'); assert.equal(original.expectedRevision, 3);
});

test('stale detection is sticky and keeps input/version unchanged until an explicit comparison decision', async () => {
  let current = goal(), writes = 0; const f = await opened({ goal: async () => current, save: async () => { writes++; } });
  f.input().value = '작성 중 가상 목표'; current = goal({ revision: 4, title: '<최신 목표>', description: '<새 설명>', status: 'paused' });
  await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true); assert.equal(f.state.view.expectedRevision, 3);
  assert.equal(f.input().value, '작성 중 가상 목표'); assert.equal(f.submit().disabled, true); assert.equal(f.input().disabled, false);
  assert.match(f.comparison.innerHTML, /&lt;최신 목표&gt;/); assert(!f.comparison.innerHTML.includes('<최신 목표>'));
  current = goal(); await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true);
  f.submit().disabled = false; await f.ui.submit(); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null);
});

test('explicit keep or replace adopts only the reviewed latest version and never saves automatically', async () => {
  for (const keep of [true, false]) {
    let current = goal(), writes = 0; const f = await opened({ goal: async () => current, save: async () => { writes++; } });
    f.input().value = '내가 쓴 목표'; f.input('description').value = '내가 쓴 설명'; f.input('status').value = 'achieved';
    current = goal({ revision: 4, title: '서버 목표', description: '서버 설명', status: 'paused' }); await f.ui.guardView(f.current);
    f.ui.compareGoal(keep); assert.equal(f.state.view.expectedRevision, 4); assert.equal(f.state.view.stale, false);
    assert.deepEqual(f.state.view.values, keep ? { title: '내가 쓴 목표', description: '내가 쓴 설명', status: 'achieved' }
      : { title: '서버 목표', description: '서버 설명', status: 'paused' });
    assert.equal(f.submit().disabled, false); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null);
    current = goal({ revision: 5 }); await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true); assert.equal(f.state.view.expectedRevision, 4);
  }
});

test('first conflict keeps editable input and disables stale submit until a fresh comparison is chosen', async () => {
  let current = goal(), writes = 0; const f = await opened({ goal: async () => current,
    save: async () => { writes++; throw new LocalApiError('GOAL_CONFLICT', 409); } });
  f.input().value = '가상 충돌 입력'; await f.ui.submit(); assert.equal(writes, 1); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.state.view.stale, true); assert.equal(f.state.view.latest, null);
  assert.equal(f.input().value, '가상 충돌 입력'); assert.equal(f.input().disabled, false); assert.equal(f.submit().disabled, true);
  f.ui.compareGoal(true); assert.equal(f.state.view.expectedRevision, 3); await f.ui.submit(); assert.equal(writes, 1);
  current = goal({ revision: 4 }); await f.ui.refreshGoal(); f.ui.compareGoal(true); assert.equal(f.state.view.expectedRevision, 4); assert.equal(writes, 1);
});

test('first conflict after polling receipt restores only original input after a fresh permission read', async () => {
  const saveGate = deferred(), readGate = deferred(), started = deferred(); let reads = 0;
  const f = await opened({ goal: () => { if (++reads === 1) return Promise.resolve(goal()); started.resolve(); return readGate.promise; }, save: () => saveGate.promise });
  f.input().value = '가상 영수증 전 입력'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
  assert.equal(f.state.view.kind, 'receipt'); saveGate.reject(new LocalApiError('GOAL_CONFLICT', 409)); await started.promise;
  assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  readGate.resolve(goal({ revision: 4, title: '현재 서버 목표' })); await pending;
  assert.equal(reads, 2); assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view.kind, 'goal');
  assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.state.view.stale, true); assert.equal(f.input().value, '가상 영수증 전 입력');
  assert.equal(f.state.view.latest.revision, 4); assert.equal(f.submit().disabled, true);
});

test('receipt conflict denial wipes input and temporary read failure preserves memory only until revalidated', async () => {
  for (const denial of [true, false]) {
    const gate = deferred(); let reads = 0, unavailable = true;
    const f = await opened({ goal: async () => {
      if (++reads > 1 && unavailable) throw new LocalApiError(denial ? 'NOT_FOUND' : 'UNAVAILABLE', denial ? 404 : 503);
      return goal({ revision: reads === 1 ? 3 : 4 });
    }, save: () => gate.promise });
    f.input().value = '보관할 가상 입력'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
    gate.reject(new LocalApiError('GOAL_CONFLICT', 409)); await pending;
    assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.mutation.operation, null);
    if (denial) assert.equal(f.state.view, null);
    else {
      assert.equal(f.state.view.values.title, '보관할 가상 입력'); unavailable = false; await f.ui.handleAction('resume');
      assert.equal(f.input().value, '보관할 가상 입력'); assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.submit().disabled, true);
    }
  }
});

test('definitive creation rejection after a receipt restores its UUID/input only after a fresh room-authority check', async () => {
  const gate = deferred(); let reads = 0;
  const f = fixture({ goal: () => assert.fail('rejected creation is not a saved goal'), save: () => gate.promise },
    { profile: async () => { reads++; return { ...f.current.profile }; } });
  await f.ui.handleAction('new-goal'); const id = f.state.view.goalId; f.input().value = '가상 거절된 새 목표';
  const pending = f.ui.submit(); await f.ui.guardView(f.current); gate.reject(new LocalApiError('INVALID_INPUT', 400)); await pending;
  assert.equal(reads, 2); assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view.goalId, id);
  assert.equal(f.state.view.expectedRevision, 0); assert.equal(f.input().value, '가상 거절된 새 목표'); assert.equal(f.submit().disabled, false);
});

test('late conflict revalidation cannot reopen the old form after account or child transition', async () => {
  for (const change of ['account', 'room']) {
    const saveGate = deferred(), readGate = deferred(), started = deferred(); let reads = 0;
    const f = await opened({ goal: () => { if (++reads === 1) return Promise.resolve(goal()); started.resolve(); return readGate.promise; }, save: () => saveGate.promise });
    f.input().value = 'PRIVATE-OLD-GOAL'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
    saveGate.reject(new LocalApiError('GOAL_CONFLICT', 409)); await started.promise;
    const next = { ...f.current, generation: 2 };
    if (change === 'account') next.user = { ...next.user, userId: 'other-user' };
    else { next.roomId = 'other-room'; next.profile = { childId: 'other-child', conversationId: 'other-room' }; }
    f.setContext(next); f.ui.update(next); readGate.resolve(goal({ revision: 4 })); await pending;
    assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, ''); assert.equal(f.ui.state().view, null);
  }
});

test('unknown creation pins its UUID/content and retries the identical operation even after a later conflict', async () => {
  const writes = []; let attempts = 0, profileReads = 0;
  const f = fixture({ save: async (...args) => { writes.push(args); if (++attempts === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempts === 2) throw new LocalApiError('GOAL_CONFLICT', 409); } },
  { profile: async () => { profileReads++; return { ...f.current.profile }; } });
  await f.ui.handleAction('new-goal'); f.input().value = '가상 새 목표'; const originalId = f.state.view.goalId; await f.ui.submit();
  const original = f.state.mutation.operation; assert(original); assert.equal(original.targetId, originalId);
  await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt'); assert.equal(profileReads, 1);
  assert.equal(f.display.title, '이전 요청 처리 확인'); assert(!f.display.html.includes('가상 새 목표')); assert(!f.display.html.includes('textarea'));
  await f.ui.mutate(); assert.equal(f.state.mutation.operation, original); assert.equal(f.state.mutation.everUncertain, true);
  assert.equal(f.ui.discard(), false); await f.ui.mutate(); assert.equal(writes.length, 3);
  for (const args of writes) { assert.equal(args[2], originalId); assert.equal(args[3], original.body); }
  assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null);
});

test('suspend/resume rechecks saved-goal permission but retains an unknown receipt without a new source read', async () => {
  for (const uncertain of [false, true]) {
    let reads = 0; const f = await opened({ goal: async () => { reads++; return goal(); }, save: async () => { throw new LocalApiError('UNAVAILABLE'); } });
    f.input().value = '가상 이어쓸 목표'; if (uncertain) await f.ui.submit(); const original = f.state.mutation.operation;
    f.ui.suspend(); assert.equal(f.ui.dialog.open, false); assert.equal(f.display.html, '');
    await f.ui.handleAction('resume'); assert.equal(reads, uncertain ? 1 : 2);
    if (uncertain) { assert.equal(f.state.mutation.operation, original); assert.equal(f.state.view.kind, 'receipt'); assert(!f.display.html.includes('가상 이어쓸 목표')); }
    else assert.equal(f.input().value, '가상 이어쓸 목표');
  }
});

test('permission loss and cross-child source changes wipe input before projection invalidation', async () => {
  for (const mode of ['NOT_FOUND', 'FORBIDDEN', 'room', 'child']) {
    let denied = false, notified = 0, f;
    f = await opened({ goal: async () => {
      if (!denied) return goal(); if (mode === 'room') return goal({ conversationId: 'other-room' });
      if (mode === 'child') return goal({ childId: 'other-child' }); throw new LocalApiError(mode, mode === 'FORBIDDEN' ? 403 : 404);
    } }, {}, { onSourceUnavailable: () => { notified++; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null); } });
    const input = f.input(); input.value = 'PRIVATE-DRAFT'; denied = true;
    assert.equal(await f.ui.guardView(f.current), false); assert.equal(notified, 1); assert.equal(input.value, ''); assert.equal(f.state.view, null);
  }
});

test('new-goal resume rechecks current room authority and never queries its unsaved identifier', async () => {
  let reads = 0, allowed = true; const f = fixture({ goal: () => assert.fail('unsaved goal has no source') }, {
    profile: async () => { reads++; if (!allowed) throw new LocalApiError('NOT_FOUND', 404); return { ...f.current.profile }; } });
  await f.ui.handleAction('new-goal'); f.input().value = '가상 새 초안'; const id = f.state.view.goalId;
  f.ui.close(); await f.ui.handleAction('resume'); assert.equal(reads, 2); assert.equal(f.state.view.goalId, id); assert.equal(f.input().value, '가상 새 초안');
  allowed = false; await f.ui.guardView(f.current); assert.equal(reads, 3); assert.equal(f.state.view, null); assert.equal(f.display.html, '');
});

test('int32 maximum no-op can be submitted, while a first limit rejection keeps input without uncertain retry', async () => {
  for (const reject of [false, true]) {
    const writes = [], f = await opened({ goal: async () => goal({ revision: 2147483647 }), save: async (...args) => {
      writes.push(args[3]); if (reject) throw new LocalApiError('REVISION_LIMIT', 409); return {};
    } });
    if (reject) f.input().value = '가상 변경'; await f.ui.submit(); assert.equal(writes.length, 1); assert.equal(writes[0].expectedRevision, 2147483647);
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.mutation.everUncertain, false);
    if (reject) { assert.equal(f.input().value, '가상 변경'); assert.match(f.display.notices.textContent, /한도/); }
    else assert.equal(f.state.view, null);
  }
});

test('late save acknowledgements cannot refresh the new account and authentication loss purges goal drafts', async () => {
  const gate = deferred(); let changes = 0;
  const f = await opened({ save: () => gate.promise }, {}, { onChanged: () => { changes++; } });
  const pending = f.ui.submit(); const next = { ...f.current, generation: 2, user: { ...f.current.user, userId: 'another-user' } };
  f.setContext(next); f.ui.update(next); gate.resolve({}); await pending;
  assert.equal(changes, 0); assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, ''); assert.equal(f.ui.state().view, null);
  let denied = false; const errors = [], other = await opened({ goal: async () => {
    if (denied) throw new LocalApiError('AUTH_REQUIRED', 401); return goal();
  } }, {}, { onError: (error) => errors.push(error.code) });
  denied = true; await other.ui.guardView(other.current); assert.deepEqual(errors, ['AUTH_REQUIRED']); assert.equal(other.ui.states.size, 0);
  assert.equal(other.display.html, ''); assert.equal(other.ui.dialog, null);
});
