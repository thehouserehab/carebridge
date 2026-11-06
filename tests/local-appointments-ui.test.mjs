// Pure controller and markup doubles. No browser, HTTP listener or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareUi, CareMutation } from '../local-api/care-ui.js';
import { AppointmentApiClient } from '../local-api/appointment-client.js';
import { childMarkup, appointmentMarkup } from '../local-api/workspace-ui.js';
import { LocalApiError } from '../local-api/client.js';

const fields = ['date', 'time', 'duration', 'title', 'room', 'status'];
const values = (extra = {}) => ({ date: '2026-10-09', time: '10:00', duration: 30, title: '가상 최신 일정', room: '가상 치료실', status: 'scheduled', ...extra });
const appointment = (extra = {}) => ({ id: 'synthetic-appointment', conversationId: 'synthetic-room', childId: 'synthetic-child', revision: 3,
  ...values(), therapistId: 'synthetic-therapist', updatedAt: '2026-10-09T00:00:00.000Z', ...extra });
const context = () => ({ user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', profile: { childId: 'synthetic-child', conversationId: 'synthetic-room' },
  connected: true, messages: [], generation: 1, signal: new AbortController().signal,
  careData: { goals: [], records: [], appointments: [appointment({ revision: 1, title: '가상 오래된 목록' })] } });
const deferred = () => Promise.withResolvers();
const validator = new AppointmentApiClient({ request: async () => assert.fail('normalization must not send HTTP') });
const seoulDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function fixture(appointmentApi = {}, api = {}, callbacks = {}) {
  let current = context(), request = 0;
  const ui = new CareUi({ api: { profile: async () => ({ ...current.profile }), ...api },
    appointmentApi: { appointment: async () => appointment(), save: async () => ({}), content: (input) => validator.content(input), ...appointmentApi },
    getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]); ui.owner = current.user.userId; ui.ownerRole = 'therapist';
  const state = { mutation: new CareMutation(() => `synthetic-appointment-request-${++request}`), records: [], goals: [],
    appointments: structuredClone(current.careData.appointments), loaded: true, loading: false, view: null };
  ui.states.set(ui.key, state);
  const display = { html: '', title: '', kind: '', notices: { textContent: '' }, nodes: [], retry: null, count: 0, comparisonWrites: 0 };
  const node = (extra = {}) => ({ dataset: {}, disabled: false, value: '', closest: () => null,
    remove() { if (display.retry === this) display.retry = null; }, ...extra });
  const document = { activeElement: null, body: {}, createElement: () => node({ setAttribute() {} }) };
  const makeComparison = () => { let html = ''; return { hidden: true, get innerHTML() { return html; }, set innerHTML(value) {
    html = value.replace(/" +>/g, '">'); display.comparisonWrites++;
    if (document.activeElement?.section === this) document.activeElement = document.body;
  } }; };
  let comparison = null;
  ui.host = { ownerDocument: document, innerHTML: '', contains: () => false, querySelectorAll: () => [], querySelector: () => null,
    append() {}, replaceChildren() { this.innerHTML = ''; } };
  const form = { get elements() { display.nodes.namedItem = (name) => display.nodes.find((item) => item.name === name); return display.nodes; },
    reportValidity: () => true, querySelectorAll: () => display.nodes,
    querySelector: (selector) => selector === '[data-care-action="retry"]' ? display.retry : selector === '.care-submit' ? { append: (item) => { display.retry = item; } } : null };
  ui.dialog = { open: false, querySelector: (selector) => selector === 'form' ? (display.html ? form : null)
    : selector === '[data-care-error]' ? display.notices : selector === '[data-appointment-conflict]' ? comparison : null,
    querySelectorAll: () => display.nodes.filter((item) => item.name), close() { this.open = false; },
    replaceChildren() { display.html = ''; display.nodes = []; display.retry = null; comparison = null; }, remove() {} };
  ui.form = (title, kind, body, buttons) => {
    ui.wipeDialog(); Object.assign(display, { title, kind, html: body + buttons, count: display.count + 1 });
    display.notices.textContent = ''; comparison = kind === 'appointment' ? makeComparison() : null;
    display.nodes = kind === 'appointment' ? fields.map((name) => node({ name,
      type: name === 'status' ? 'select-one' : name === 'duration' ? 'number' : name === 'date' || name === 'time' ? name : 'text',
      value: String(state.view.values[name] ?? '') })) : [];
    if (kind === 'appointment') display.nodes.push(node({ type: 'submit' }), node({ type: 'button', dataset: { careAction: 'discard' } }));
    ui.dialog.open = true; ui.lockForm();
  };
  return { ui, state, display, document, get comparison() { return comparison; }, get current() { return current; }, setContext(next) { current = next; },
    input: (name = 'title') => display.nodes.find((item) => item.name === name), submit: () => display.nodes.find((item) => item.type === 'submit') };
}
async function opened(appointmentApi = {}, api = {}, callbacks = {}) {
  const f = fixture(appointmentApi, api, callbacks); await f.ui.handleAction('edit-appointment', 'synthetic-appointment'); return f;
}
function fill(f, input = values()) { for (const key of fields) f.input(key).value = String(input[key]); }
function transition(f, change) {
  if (change === 'suspend') { f.ui.suspend(); return; }
  if (change === 'close') { f.ui.close(); return; }
  const next = { ...f.current, generation: 2 };
  if (change === 'account') next.user = { ...next.user, userId: 'another-user' };
  if (change === 'room') { next.roomId = 'another-room'; next.profile = { childId: 'another-child', conversationId: 'another-room' }; }
  if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
  if (change === 'offline') next.connected = false;
  f.setContext(next); f.ui.update(next);
}

test('current schedule exposes add/edit only to therapists without changing record or guardian conversation actions', () => {
  const room = { conversationId: 'synthetic-room', profile: { name: '가상 아동', participants: [] },
    care: { goals: [], records: [], appointments: [], publications: [] } };
  for (const role of ['therapist', 'guardian', 'center']) {
    const empty = childMarkup(room, role, { label: '가상 조회 기간' });
    assert.equal(empty.includes('data-appointment-new'), role === 'therapist');
    room.care.appointments = ['scheduled', 'attended', 'absent', 'cancelled'].map((status) => appointment({ id: `appointment-${status}`, status, title: '<가상 일정>', room: '<가상 치료실>' }));
    const html = childMarkup(room, role, { label: '가상 조회 기간' });
    assert.equal(html.includes('data-appointment-edit'), role === 'therapist'); assert.match(html, /&lt;가상 일정&gt;/); assert.match(html, /&lt;가상 치료실&gt;/);
    assert(!html.includes('<가상 일정>')); assert(!html.includes('일정 변경은 아직'));
    for (const label of ['예정', '완료', '미참석', '취소']) assert(html.includes(label));
    room.care.appointments = [];
  }
  const guardian = appointmentMarkup(room, appointment(), 'guardian'); assert.match(guardian, /data-open-room="synthetic-room"/);
  assert(!guardian.includes('data-appointment-edit')); assert(!guardian.includes('data-appointment-record'));
  room.care.records = [{ id: 'synthetic-record', appointmentId: 'synthetic-appointment' }];
  const therapist = appointmentMarkup(room, appointment(), 'therapist'); assert.match(therapist, /data-appointment-record="synthetic-appointment"/); assert.match(therapist, /기록 이어보기/);
});

test('new appointment uses fresh current child authority with no goals required and does not invent time or duration', async () => {
  const calls = [], f = fixture({ appointment: () => assert.fail('new appointment has no saved source') }, {
    profile: async (...args) => { calls.push(args); return { conversationId: 'synthetic-room', childId: 'synthetic-child' }; },
    record: () => assert.fail('new schedule does not read clinical records') });
  f.state.loaded = false; f.state.appointments = []; const day = seoulDay(); await f.ui.handleAction('new-appointment');
  const view = f.state.view; assert.equal(view.kind, 'appointment'); assert.equal(view.childId, 'synthetic-child');
  assert.equal(view.expectedRevision, 0); assert.match(view.appointmentId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(view.values, { date: day, time: '', duration: '', title: '', room: '', status: 'scheduled' });
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', f.current.signal]]);
  const id = view.appointmentId; f.ui.discard(); await f.ui.handleAction('new-appointment'); assert.notEqual(f.state.view.appointmentId, id);
});

test('edit pins one fresh current appointment response instead of the older list projection', async () => {
  const calls = [], f = await opened({ appointment: async (...args) => { calls.push(args); return appointment(); } }, {
    record: () => assert.fail('not a clinical read'), message: () => assert.fail('not a message') });
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', 'synthetic-appointment', f.current.signal]]);
  assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.state.view.appointmentId, 'synthetic-appointment');
  assert.deepEqual(f.state.view.values, values()); assert.equal(f.display.kind, 'appointment'); assert(!f.display.html.includes('가상 오래된 목록'));
});

test('new/edit enforce therapist role, selected list identity and exact current child and room', async () => {
  for (const action of ['new-appointment', 'edit-appointment']) {
    for (const role of ['guardian', 'center']) {
      let reads = 0; const f = fixture({ appointment: async () => { reads++; return appointment(); } }, { profile: async () => { reads++; return {}; } });
      f.current.user.centers[0].role = role; await f.ui.handleAction(action, 'synthetic-appointment'); assert.equal(reads, 0); assert.equal(f.state.view, null);
    }
    for (const extra of [{ childId: 'other-child' }, { conversationId: 'other-room' }]) {
      const f = fixture({ appointment: async () => appointment(extra) }, { profile: async () => ({ ...f.current.profile, ...extra }) });
      await f.ui.handleAction(action, 'synthetic-appointment'); assert.equal(f.state.view, null); assert.equal(f.display.html, '');
    }
  }
  let reads = 0; const f = fixture({ appointment: async () => { reads++; return appointment(); } });
  await f.ui.handleAction('edit-appointment', 'not-listed'); assert.equal(reads, 0); assert.equal(f.state.view, null);
});

test('opening is single flight and cannot reopen an old editor after account, child, role or suspension change', async () => {
  for (const change of ['account', 'room', 'role', 'suspend', 'offline']) {
    const gate = deferred(), started = deferred(); let reads = 0;
    const f = fixture({ appointment: () => { reads++; started.resolve(); return gate.promise; } });
    const pending = f.ui.handleAction('edit-appointment', 'synthetic-appointment'); await started.promise;
    await f.ui.handleAction('new-appointment'); assert.equal(reads, 1); transition(f, change);
    gate.resolve(appointment()); await pending; assert.equal(f.display.html, '', change); assert.equal(f.ui.dialog?.open ?? false, false);
  }
});

test('appointment form escapes shared scheduling values, labels all six fields and declares bounded inputs', async () => {
  const f = await opened({ appointment: async () => appointment({ title: '<가상 일정>', room: '<script>가상 치료실</script>' }) });
  for (const field of fields) assert(f.display.html.includes(`name="${field}"`), field);
  for (const fragment of ['maxlength="100"', 'maxlength="60"', 'min="10"', 'max="180"', 'type="date"', 'type="time"',
    '&lt;가상 일정&gt;', '&lt;script&gt;', '일정 저장']) assert(f.display.html.includes(fragment), fragment);
  for (const status of ['scheduled', 'attended', 'absent', 'cancelled']) assert(f.display.html.includes(`value="${status}"`));
  assert(!f.display.html.includes('<script>')); assert(!f.display.html.includes('data-record-upload'));
});

test('invalid appointment fields cannot allocate a mutation even when browser validity is bypassed', async () => {
  let writes = 0; const f = await opened({ save: async () => { writes++; } });
  for (const [field, value] of [['date', '2026-02-30'], ['time', ''], ['duration', ''], ['duration', '0'], ['duration', '181'],
    ['title', ''], ['title', 'a\nb'], ['title', '\ud800'], ['title', 'a'.repeat(101)], ['room', ''], ['room', 'a'.repeat(61)], ['status', 'deleted']]) {
    fill(f); f.input(field).value = value; await f.ui.submit(); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null);
  }
  fill(f, values({ time: '23:59' })); await f.ui.submit(); assert.equal(writes, 0);
});

test('explicit save sends one immutable six-field operation and never emits messages, read changes or records', async () => {
  for (const status of ['scheduled', 'attended', 'absent', 'cancelled']) {
    const writes = []; let changes = 0;
    const f = await opened({ save: async (...args) => writes.push(args) }, {
      send: () => assert.fail('not a chat message'), markRead: () => assert.fail('not a read'), recordSave: () => assert.fail('not a record') },
    { onChanged: () => { changes++; } });
    fill(f, values({ title: '  가상 일정 저장  ', room: '  가상 공간  ', status })); await f.ui.submit();
    assert.equal(writes.length, 1); const [center, room, id, body, signal] = writes[0];
    assert.deepEqual([center, room, id], ['synthetic-center', 'synthetic-room', 'synthetic-appointment']);
    assert.deepEqual(body, { clientId: 'synthetic-appointment-request-1', expectedRevision: 3, content: values({ title: '가상 일정 저장', room: '가상 공간', status }) });
    assert(Object.isFrozen(body) && Object.isFrozen(body.content)); assert.equal(signal, f.current.signal);
    assert.equal(changes, 1); assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null);
  }
});

test('a record draft wins over schedule editing and retains its historical appointment and pinned revision', async () => {
  let reads = 0; const f = fixture({ appointment: async () => { reads++; return appointment(); } }, {
    profile: async () => { reads++; return f.current.profile; }, record: async () => ({ id: 'synthetic-record', conversationId: 'synthetic-room' }) });
  const historical = { ...values({ title: '기록 당시 일정' }), revision: 1 };
  const view = { kind: 'record', recordId: 'synthetic-record', expectedRevision: 2, expectedAppointmentRevision: 1,
    values: { performed: '작성 중 임상 관찰', appointmentId: 'synthetic-appointment', appointmentSnapshot: historical }, references: [], goals: [] };
  f.state.view = view; let displays = 0; f.ui.display = () => { displays++; };
  await f.ui.handleAction('new-appointment'); assert.equal(f.state.view, view); assert.equal(reads, 0); assert.equal(displays, 1);
  const before = structuredClone(view); f.current.careData.appointments = [appointment({ revision: 4 })]; f.ui.update(f.current); await f.ui.guardView(f.current);
  assert.deepEqual(view, before); assert.equal(f.state.appointments[0].revision, 4); assert.equal(view.values.appointmentSnapshot.revision, 1);
});

test('record markup distinguishes escaped historical appointment fields from the current linked appointment without replacing either', () => {
  const f = fixture(), historical = { ...values({ date: '2026-10-08', time: '08:00', duration: 20,
    title: '<당시 일정>', room: '<당시 장소>', status: 'attended' }), revision: 1 };
  const current = appointment({ revision: 4, title: '<현재 연결 일정>', room: '<현재 장소>', time: '11:00' });
  const view = f.ui.newRecord(f.state, current); view.recordId = 'synthetic-record'; view.expectedRevision = 2;
  view.values.appointmentSnapshot = historical; f.state.view = view; const before = structuredClone(view);
  f.ui.display();
  for (const text of ['data-record-appointment-snapshot', '이 기록에 저장된 당시 일정', '2026-10-08', '08:00', '20분',
    '&lt;당시 일정&gt;', '&lt;당시 장소&gt;', '완료', '(1번째 내용)', '현재 연결 일정과 다를 수 있습니다', '&lt;현재 연결 일정&gt;'])
    assert(f.display.html.includes(text), text);
  assert(!f.display.html.includes('<당시 일정>')); assert(!f.display.html.includes('<현재 연결 일정>'));
  f.state.appointments = [appointment({ revision: 5, title: '뒤늦게 바뀐 목록 일정' })]; f.ui.display();
  assert(!f.display.html.includes('뒤늦게 바뀐 목록 일정')); assert.deepEqual(view, before); assert.equal(view.values.appointmentSnapshot, historical);
  assert.equal(view.expectedAppointmentRevision, 4);
});

test('unchanged polling preserves input nodes, keyboard focus and captured revision', async () => {
  const f = await opened(), view = f.state.view, input = f.input(), renders = f.display.count;
  input.value = '가상 작성 중 일정'; f.document.activeElement = input;
  await f.ui.guardView(f.current); await f.ui.guardView(f.current);
  assert.equal(f.state.view, view); assert.equal(f.input(), input); assert.equal(f.document.activeElement, input);
  assert.equal(f.display.count, renders); assert.equal(input.value, '가상 작성 중 일정'); assert.equal(view.expectedRevision, 3);
});

test('stale comparison is sticky, escaped and disables save without replacing entered scheduling values', async () => {
  let latest = appointment(), writes = 0; const f = await opened({ appointment: async () => latest, save: async () => { writes++; } });
  fill(f, values({ title: '가상 작성 중', room: '내가 입력한 장소', status: 'absent' }));
  latest = appointment({ revision: 4, title: '<최신 일정>', room: '<최신 장소>', status: 'cancelled' }); await f.ui.guardView(f.current);
  assert.equal(f.state.view.stale, true); assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.submit().disabled, true);
  assert.equal(f.input().disabled, false); assert.equal(f.input('room').value, '내가 입력한 장소');
  assert.match(f.comparison.innerHTML, /&lt;최신 일정&gt;/); assert.match(f.comparison.innerHTML, /&lt;최신 장소&gt;/);
  latest = appointment(); await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true);
  f.submit().disabled = false; await f.ui.submit(); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null);
});

test('unchanged stale polling keeps comparison controls and focus despite HTML serialization normalization', async () => {
  let latest = appointment(); const f = await opened({ appointment: async () => latest });
  latest = appointment({ revision: 4, title: '서버의 가상 변경' }); await f.ui.guardView(f.current);
  const writes = f.display.comparisonWrites, focused = { section: f.comparison, closest: () => null }; f.document.activeElement = focused;
  f.input('room').value = '작성 중 장소'; await f.ui.guardView(f.current); await f.ui.guardView(f.current);
  assert.equal(f.display.comparisonWrites, writes); assert.equal(f.document.activeElement, focused); assert.equal(f.input('room').value, '작성 중 장소');
});

test('explicit keep/replace adopts only the reviewed latest revision and never saves automatically', async () => {
  for (const keep of [true, false]) {
    let latest = appointment(), writes = 0; const f = await opened({ appointment: async () => latest, save: async () => { writes++; } });
    const input = values({ title: '내가 입력한 일정', date: '2026-10-10', time: '13:00', duration: 40, room: '입력 장소', status: 'attended' }); fill(f, input);
    latest = appointment({ revision: 4, ...values({ title: '서버 일정', room: '서버 장소', status: 'cancelled' }) }); await f.ui.guardView(f.current);
    f.ui.compareContext('appointment', keep); assert.equal(f.state.view.expectedRevision, 4); assert.equal(f.state.view.stale, false);
    const expected = keep ? { ...input, duration: String(input.duration) } : values({ title: '서버 일정', room: '서버 장소', status: 'cancelled' });
    assert.deepEqual(f.state.view.values, expected); assert.equal(f.submit().disabled, false); assert.equal(writes, 0);
    latest = appointment({ revision: 5 }); await f.ui.guardView(f.current); assert.equal(f.state.view.stale, true); assert.equal(f.state.view.expectedRevision, 4);
  }
});

test('first appointment CAS rejection preserves input and requires explicit latest comparison before another write', async () => {
  let latest = appointment(), writes = 0; const f = await opened({ appointment: async () => latest,
    save: async () => { writes++; throw new LocalApiError('APPOINTMENT_CONFLICT', 409); } });
  f.input().value = '가상 충돌 입력'; await f.ui.submit(); assert.equal(writes, 1); assert.equal(f.state.mutation.operation, null);
  assert.equal(f.state.view.stale, true); assert.equal(f.state.view.latest, null); assert.equal(f.input().value, '가상 충돌 입력');
  assert.equal(f.submit().disabled, true); assert.equal(f.input().disabled, false);
  f.ui.compareContext('appointment', true); await f.ui.submit(); assert.equal(writes, 1);
  latest = appointment({ revision: 4 }); await f.ui.refreshContext('appointment'); f.ui.compareContext('appointment', true);
  assert.equal(f.state.view.expectedRevision, 4); assert.equal(writes, 1);
});

test('scheduling collisions and missing therapists preserve editable input without falsely claiming a changed source revision', async () => {
  for (const errorCode of ['SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE']) {
    const writes = []; let fail = true;
    const f = await opened({ save: async (...args) => { writes.push(args[3]); if (fail) throw new LocalApiError(errorCode, 409); } });
    f.input('time').value = '14:00'; await f.ui.submit(); assert.equal(f.state.mutation.operation, null);
    assert.equal(f.state.mutation.everUncertain, false); assert.equal(f.state.view.stale, false); assert.equal(f.state.view.expectedRevision, 3);
    assert.equal(f.input('time').value, '14:00'); assert.equal(f.input('time').disabled, false); assert.equal(f.submit().disabled, false);
    fail = false; f.input('time').value = '15:00'; await f.ui.submit(); assert.equal(writes.length, 2);
    assert.notEqual(writes[0].clientId, writes[1].clientId); assert.equal(writes[1].content.time, '15:00'); assert.equal(f.state.view, null);
  }
});

test('first rejected write after a polling receipt restores input only after a current authorized appointment lookup', async () => {
  for (const errorCode of ['APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE']) {
    const saveGate = deferred(), readGate = deferred(), started = deferred(); let reads = 0;
    const f = await opened({ appointment: () => { if (++reads === 1) return Promise.resolve(appointment()); started.resolve(); return readGate.promise; }, save: () => saveGate.promise });
    f.input().value = '가상 영수증 전 입력'; const pending = f.ui.submit(); await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt');
    saveGate.reject(new LocalApiError(errorCode, 409)); await started.promise; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
    readGate.resolve(appointment({ revision: errorCode === 'APPOINTMENT_CONFLICT' ? 4 : 3 })); await pending;
    assert.equal(f.state.view.kind, 'appointment'); assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.input().value, '가상 영수증 전 입력');
    assert.equal(f.state.view.stale, errorCode === 'APPOINTMENT_CONFLICT'); assert.equal(f.submit().disabled, errorCode === 'APPOINTMENT_CONFLICT');
    assert.equal(f.state.mutation.operation, null);
  }
});

test('rejected new appointment keeps its UUID but needs a fresh profile before receipt restoration', async () => {
  const gate = deferred(); let reads = 0; const f = fixture({ appointment: () => assert.fail('unsaved appointment cannot be queried'), save: () => gate.promise },
    { profile: async () => { reads++; return { ...f.current.profile }; } });
  await f.ui.handleAction('new-appointment'); fill(f); const id = f.state.view.appointmentId;
  const pending = f.ui.submit(); await f.ui.guardView(f.current); gate.reject(new LocalApiError('SCHEDULE_CONFLICT', 409)); await pending;
  assert.equal(reads, 2); assert.equal(f.state.view.appointmentId, id); assert.equal(f.state.view.expectedRevision, 0);
  assert.equal(f.input().value, values().title); assert.equal(f.submit().disabled, false); assert.equal(f.state.mutation.operation, null);
});

test('permission-denied receipt restoration wipes input; temporary failures preserve memory only until a successful check', async () => {
  for (const denial of [true, false]) {
    const gate = deferred(); let reads = 0, unavailable = true;
    const f = await opened({ appointment: async () => {
      if (++reads > 1 && unavailable) throw new LocalApiError(denial ? 'NOT_FOUND' : 'UNAVAILABLE', denial ? 404 : 503);
      return appointment({ revision: reads === 1 ? 3 : 4 });
    }, save: () => gate.promise });
    f.input().value = '가상 보존 입력'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
    gate.reject(new LocalApiError('APPOINTMENT_CONFLICT', 409)); await pending; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
    if (denial) assert.equal(f.state.view, null);
    else { assert.equal(f.state.view.values.title, '가상 보존 입력'); unavailable = false; await f.ui.handleAction('resume');
      assert.equal(f.input().value, '가상 보존 입력'); assert.equal(f.state.view.expectedRevision, 3); assert.equal(f.submit().disabled, true); }
  }
});

test('late receipt restoration after account, room or role change cannot revive old schedule input', async () => {
  for (const change of ['account', 'room', 'role', 'suspend']) {
    const saveGate = deferred(), readGate = deferred(), started = deferred(); let reads = 0;
    const f = await opened({ appointment: () => { if (++reads === 1) return Promise.resolve(appointment()); started.resolve(); return readGate.promise; }, save: () => saveGate.promise });
    f.input().value = 'PRIVATE-OLD-APPOINTMENT'; const pending = f.ui.submit(); await f.ui.guardView(f.current);
    saveGate.reject(new LocalApiError('APPOINTMENT_CONFLICT', 409)); await started.promise; transition(f, change);
    readGate.resolve(appointment({ revision: 4 })); await pending; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog?.open ?? false, false);
  }
});

test('unknown appointment save and later conflicts keep the identical UUID and immutable body without editable revival', async () => {
  for (const nextCode of ['APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE']) {
    const writes = []; let attempts = 0, profileReads = 0;
    const f = fixture({ save: async (...args) => { writes.push(args); if (++attempts === 1) throw new LocalApiError('UNAVAILABLE');
      if (attempts === 2) throw new LocalApiError(nextCode, 409); } }, { profile: async () => { profileReads++; return { ...f.current.profile }; } });
    await f.ui.handleAction('new-appointment'); fill(f); const id = f.state.view.appointmentId; await f.ui.submit(); const original = f.state.mutation.operation;
    assert(original); await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt'); assert(!f.display.html.includes(values().title));
    assert.equal(f.display.title, '이전 요청 처리 확인'); await f.ui.mutate();
    assert.equal(f.state.mutation.operation, original); assert.equal(f.state.mutation.everUncertain, true); assert.equal(f.ui.discard(), false);
    assert.equal(profileReads, 1); await f.ui.mutate(); assert.equal(writes.length, 3);
    for (const args of writes) { assert.equal(args[2], id); assert.equal(args[3], original.body); }
    assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null);
  }
});

test('suspend and resume recheck saved schedule permission while unknown requests resume as content-free receipts', async () => {
  for (const uncertain of [false, true]) {
    let reads = 0; const f = await opened({ appointment: async () => { reads++; return appointment(); }, save: async () => { throw new LocalApiError('UNAVAILABLE'); } });
    f.input().value = '가상 이어쓸 일정'; if (uncertain) await f.ui.submit(); const original = f.state.mutation.operation;
    f.ui.suspend(); assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); await f.ui.handleAction('resume');
    assert.equal(reads, uncertain ? 1 : 2);
    if (uncertain) { assert.equal(f.state.mutation.operation, original); assert.equal(f.state.view.kind, 'receipt'); assert(!f.display.html.includes('가상 이어쓸 일정')); }
    else assert.equal(f.input().value, '가상 이어쓸 일정');
  }
});

test('permission loss or wrong child/room wipes schedule values before owner projection invalidation', async () => {
  for (const mode of ['NOT_FOUND', 'FORBIDDEN', 'child', 'room']) {
    let denied = false, notifications = 0, f;
    f = await opened({ appointment: async () => {
      if (!denied) return appointment(); if (mode === 'child') return appointment({ childId: 'another-child' });
      if (mode === 'room') return appointment({ conversationId: 'another-room' }); throw new LocalApiError(mode, mode === 'FORBIDDEN' ? 403 : 404);
    } }, {}, { onSourceUnavailable: () => { notifications++; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null); } });
    const input = f.input(); input.value = 'PRIVATE-INPUT'; denied = true; assert.equal(await f.ui.guardView(f.current), false);
    assert.equal(notifications, 1); assert.equal(input.value, ''); assert.equal(f.state.view, null);
  }
});

test('closing a new schedule keeps its UUID but resume needs fresh room permission rather than an unsaved-ID lookup', async () => {
  let reads = 0, allowed = true; const f = fixture({ appointment: () => assert.fail('unsaved appointment has no server record') }, {
    profile: async () => { reads++; if (!allowed) throw new LocalApiError('NOT_FOUND', 404); return { ...f.current.profile }; } });
  await f.ui.handleAction('new-appointment'); fill(f); const id = f.state.view.appointmentId; f.ui.close(); await f.ui.handleAction('resume');
  assert.equal(reads, 2); assert.equal(f.state.view.appointmentId, id); assert.equal(f.input().value, values().title);
  allowed = false; await f.ui.guardView(f.current); assert.equal(f.state.view, null); assert.equal(f.display.html, '');
});

test('maximum revision no-op stays valid while a first revision-limit rejection preserves editable input', async () => {
  for (const reject of [false, true]) {
    const writes = [], f = await opened({ appointment: async () => appointment({ revision: 2147483647 }), save: async (...args) => {
      writes.push(args[3]); if (reject) throw new LocalApiError('REVISION_LIMIT', 409);
    } });
    if (reject) f.input().value = '가상 수정'; await f.ui.submit(); assert.equal(writes.length, 1); assert.equal(writes[0].expectedRevision, 2147483647);
    assert.equal(f.state.mutation.operation, null); assert.equal(f.state.mutation.everUncertain, false);
    if (reject) { assert.equal(f.input().value, '가상 수정'); assert.match(f.display.notices.textContent, /한도/); assert.equal(f.submit().disabled, false); }
    else assert.equal(f.state.view, null);
  }
});

test('late save cannot refresh another account and authentication loss purges schedule drafts', async () => {
  const gate = deferred(); let changes = 0; const f = await opened({ save: () => gate.promise }, {}, { onChanged: () => { changes++; } });
  const pending = f.ui.submit(); transition(f, 'account'); gate.resolve({}); await pending;
  assert.equal(changes, 0); assert.equal(f.display.html, ''); assert.equal(f.ui.dialog?.open ?? false, false);
  let denied = false; const errors = [], other = await opened({ appointment: async () => {
    if (denied) throw new LocalApiError('AUTH_REQUIRED', 401); return appointment();
  } }, {}, { onError: (error) => errors.push(error.code) });
  denied = true; await other.ui.guardView(other.current); assert.deepEqual(errors, ['AUTH_REQUIRED']); assert.equal(other.ui.states.size, 0);
  assert.equal(other.display.html, ''); assert.equal(other.ui.dialog, null);
});
