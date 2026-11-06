// Pure state/controller/markup doubles only. No browser, HTTP, database or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CenterAppointmentDraft, scheduleKey, scheduleSummary, operationsOverviewMarkup,
  operationsScheduleMarkup, operationsAppointmentMarkup } from '../local-api/operations-schedule.js';
import { OperationsUi } from '../local-api/operations-ui.js';
import { LocalApiError } from '../local-api/client.js';
import { profileToday } from '../src/profile-fields.js';

const clone = value => structuredClone(value);
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const profile = (room = 'a', extra = {}) => ({ conversationId: `room-${room}`, childId: `child-${room}`,
  name: `가상 아이 ${room}`, age: null, ageAsOf: null, revision: 1, ...extra });
const identity = () => ({ userId: 'manager-a', email: 'manager@example.test', centers: [
  { id: 'center-a', role: 'center' }, { id: 'center-b', role: 'guardian' },
] });
const members = () => [{ userId: 'manager-a', role: 'center', displayName: '가상 센터' },
  { userId: 'therapist-a', role: 'therapist', displayName: '가상 치료사' },
  { userId: 'guardian-a', role: 'guardian', displayName: '가상 보호자' }];
const content = extra => ({ date: profileToday(), time: '10:00', duration: 30, title: '가상 일정', room: '가상 장소', status: 'scheduled', ...extra });
const appointment = extra => ({ id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1,
  ...content(), therapistId: 'therapist-a', updatedAt: '2026-10-10T00:00:00.000Z', ...extra });
const existing = value => { const a = appointment(value); return new CenterAppointmentDraft({ ...a, appointment: a }); };
const fresh = extra => new CenterAppointmentDraft({ ...profile(), id: 'new-appointment', date: profileToday(), ...extra });
const deferred = () => Promise.withResolvers();
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (text, name) => { const result = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(text); return result ? decode(result[1]) : null; };
const flag = (text, name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$|=)`).test(text);
function node(extra = {}) {
  return { disabled: false, hidden: false, textContent: '', innerHTML: '', listeners: [], dataset: {}, attributes: {},
    addEventListener(type, handler, options) { this.listeners.push({ type, handler, signal: options?.signal }); },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; }, ...extra };
}

// Models exactly the controls queried by the controller, including the separate
// date form and child selector. Focus ownership is modeled only for scoped
// queried controls; this is not native validation/layout/browser verification.
function hostStub() {
  const display = { html: '', contentHtml: '', form: null, dateForm: null, dateInput: null, newChild: null,
    replacements: 0, focused: 0, focusNodes: [], center: node(), title: node() };
  const ownerDocument = { activeElement: null };
  let owned = new Set();
  const scoped = value => {
    owned.add(value); value.focusCount = 0;
    value.focus = options => { assert.equal(options.preventScroll, true); if (!value.disabled) { value.focusCount++; ownerDocument.activeElement = value; } };
    return value;
  };
  const focusData = raw => Object.fromEntries(['Child', 'Recipient', 'DateInput', 'NewChild', 'Appointment', 'Room', 'Resume']
    .filter(key => flag(raw, `data-ops-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).slice(1)}`))
    .map(key => [`ops${key}`, attr(raw, `data-ops-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).slice(1)}`) ?? '']));
  const nav = ['overview', 'children', 'schedule'].map(section => node({ dataset: { opsView: section } }));
  display.title.focus = options => { assert.equal(options.preventScroll, true); display.focused++; ownerDocument.activeElement = display.title; };
  const contentHost = node({ contains: value => owned.has(value), querySelectorAll(selector) {
    // Model supported attribute-selector unions, not one past source string.
    // Unknown selector syntax fails loudly instead of silently erasing focus.
    const keys = selector.split(',').map(part => {
      const match = /^\[data-ops-(child|recipient|date-input|new-child|appointment|resume)\]$/.exec(part.trim());
      assert(match, 'The narrow DOM double needs an explicit supported selector.');
      return 'ops' + match[1].replace(/(?:^|-)([a-z])/g, (_, letter) => letter.toUpperCase());
    });
    return display.focusNodes.filter(control => keys.some(key => Object.hasOwn(control.dataset, key)));
  } });
  Object.defineProperty(contentHost, 'innerHTML', { get: () => display.contentHtml, set(html) {
    if (owned.has(ownerDocument.activeElement)) ownerDocument.activeElement = null;
    owned = new Set(); display.focusNodes = [];
    display.contentHtml = html; display.replacements++; display.form = null; display.dateForm = null; display.dateInput = null; display.newChild = null;
    const elements = {}, inputs = [], selects = [];
    for (const [, raw] of html.matchAll(/<input\b([^>]*)>/g)) {
      const input = scoped(node({ name: attr(raw, 'name'), value: attr(raw, 'value') ?? 'on', checked: flag(raw, 'checked'), type: attr(raw, 'type') ?? 'text', dataset: focusData(raw) }));
      inputs.push(input); if (input.name && input.name !== 'guardian') elements[input.name] = input;
      if (flag(raw, 'data-ops-date-input')) { display.dateInput = input; display.focusNodes.push(input); }
    }
    for (const [, raw, body] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, option]) =>
        node({ value: attr(option, 'value') ?? '', selected: flag(option, 'selected'), disabled: flag(option, 'disabled') }));
      const select = scoped(node({ name: attr(raw, 'name'), value: (options.find(option => option.selected) ?? options[0])?.value ?? '', options,
        dataset: { ...focusData(raw), ...(attr(raw, 'data-guardian-history') === null ? {} : { guardianHistory: attr(raw, 'data-guardian-history') }) },
        querySelector: selector => options.find(option => selector === `[value="${option.value}"]`) ?? null }));
      selects.push(select); if (select.name) elements[select.name] = select;
      if (flag(raw, 'data-ops-new-child')) { display.newChild = select; display.focusNodes.push(select); }
    }
    for (const [, raw] of html.matchAll(/<button\b([^>]*)>/g)) {
      const dataset = focusData(raw); if (!Object.keys(dataset).length) continue;
      display.focusNodes.push(scoped(node({ dataset, disabled: flag(raw, 'disabled') })));
    }
    if (html.includes('data-ops-date-form')) display.dateForm = { matches: selector => selector === '[data-ops-date-form]' };
    const formId = /<form data-testid="([^"]+)"/.exec(html)?.[1]; if (!formId) return;
    const controls = new Map(['[type="submit"]', '[data-ops-action="retry"]', '[data-ops-action="discard"]',
      '[data-ops-error]', '[data-ops-conflict]', '[data-past-confirm]'].map(key => [key, node()]));
    display.form = { id: formId, elements, inputs, selects, controls,
      querySelector: selector => controls.get(selector) ?? null,
      querySelectorAll: selector => selector === 'input' ? inputs : selector === 'select' ? selects
        : selector === 'input[name="guardian"]' ? inputs.filter(input => input.name === 'guardian')
          : selector === '[data-guardian-history]' ? selects.filter(select => select.dataset.guardianHistory) : [],
      matches: selector => selector.split(',').includes(`[data-testid="${formId}"]`) };
  } });
  const host = node({ ownerDocument, contains: () => true,
    querySelectorAll: selector => selector === '[data-ops-view]' ? nav : [],
    querySelector(selector) {
      if (selector === '[data-ops-content]') return display.html.includes('data-ops-content') ? contentHost : null;
      if (selector === '[data-ops-center]') return display.html.includes('data-ops-center') ? display.center : null;
      if (selector === '[data-ops-title]') return display.contentHtml.includes('data-ops-title') ? display.title : null;
      if (selector === '[data-ops-new-child]') return display.newChild;
      if (selector === '[data-ops-date-input]') return display.dateInput;
      if (selector === `[data-testid="${display.form?.id}"]`) return display.form;
      return null;
    }, replaceChildren() { display.html = ''; contentHost.innerHTML = ''; },
  });
  Object.defineProperty(host, 'innerHTML', { get: () => display.html, set: html => { display.html = html; } });
  return { host, display, nav };
}
function fixture(apiOverrides = {}, scheduleOverrides = {}) {
  const { host, display, nav } = hostStub(), user = identity(), notices = [], denied = [], calls = [], centerChanges = [];
  const profiles = new Map(['a', 'b'].map(room => [profile(room).conversationId, profile(room)]));
  const appointments = new Map([appointment(), appointment({ id: 'appointment-b', time: '11:00' }),
    appointment({ conversationId: 'room-b', childId: 'child-b' })].map(a => [scheduleKey(a.conversationId, a.id), a]));
  const directory = members();
  const transport = { expectedUserId: user.userId, request: () => assert.fail('use the scoped API double'),
    session: async signal => { calls.push(['session', signal]); return clone(user); } };
  const ui = new OperationsUi({ host, transport, user: clone(user), centerId: 'center-a',
    announce: text => notices.push(text), onDenied: error => denied.push(error), onCenterChange: id => centerChanges.push(id) });
  const api = {
    children: async (center, signal) => { calls.push(['children', center, signal]); return clone([...profiles.values()]); },
    childProfile: async (center, room, signal) => { calls.push(['profile', center, room, signal]); return clone(profiles.get(room)); },
    members: async (center, signal) => { calls.push(['members', center, signal]); return clone(directory); },
    relationships: async (center, room, signal) => { calls.push(['relationships', center, room, signal]);
      return { conversationId: room, childId: profiles.get(room).childId, version: 1, participants: [] }; },
    ...apiOverrides,
  };
  const scheduleApi = {
    list: async (center, period, signal) => { calls.push(['list', center, clone(period), signal]);
      return { version: 4, appointments: clone([...appointments.values()].filter(a => a.date >= period.dateFrom && a.date <= period.dateTo)) }; },
    appointment: async (center, room, id, signal) => { calls.push(['appointment', center, room, id, signal]);
      const value = appointments.get(scheduleKey(room, id)); if (!value) throw new LocalApiError('NOT_FOUND', 404); return clone(value); },
    save: async (center, room, id, operation, signal) => {
      calls.push(['save', center, room, id, operation, signal]);
      appointments.set(scheduleKey(room, id), appointment({ conversationId: room, childId: profiles.get(room).childId, id,
        ...operation.content, revision: operation.expectedRevision + 1 }));
      return { kind: 'appointment', id, revision: operation.expectedRevision + 1, changed: true, replayed: false };
    }, ...scheduleOverrides,
  };
  ui.api = api; ui.scheduleApi = scheduleApi; ui.mount();
  return { ui, api, scheduleApi, user, transport, host, display, nav, profiles, appointments, directory, calls, notices, denied, centerChanges,
    input: name => display.form.elements[name], control: selector => display.form.querySelector(selector),
    emit(type, target = display.form) { for (const listener of host.listeners.filter(listener => listener.type === type && !listener.signal.aborted)) listener.handler({ target, preventDefault() {} }); },
  };
}
async function scheduled(apiOverrides, scheduleOverrides) {
  const f = fixture(apiOverrides, scheduleOverrides); await f.ui.refresh(); await f.ui.showSection('schedule'); return f;
}
async function opened(apiOverrides, scheduleOverrides) {
  const f = await scheduled(apiOverrides, scheduleOverrides); await f.ui.openAppointment('room-a', 'appointment-a'); return f;
}
async function until(check) {
  for (let i = 0; !check() && i < 100; i++) await Promise.resolve();
  assert(check(), 'bounded controller checkpoint must settle');
}
async function settled(ui) { await until(() => ui.pending === null); }
function fill(f, extra = {}) { for (const [key, value] of Object.entries(content(extra))) f.input(key).value = String(value); f.emit('input'); }

test('new draft is child/room/appointment scoped with explicit date and otherwise blank scheduling inputs', () => {
  const draft = fresh(); assert.equal(draft.originNew, true); assert.equal(draft.revision, 0); assert.equal(draft.latest, null);
  assert.deepEqual(draft.values, { date: profileToday(), time: '', duration: '', title: '', room: '', status: 'scheduled' });
  assert.equal(draft.childId, 'child-a'); assert.equal(draft.roomId, 'room-a'); assert.equal(draft.id, 'new-appointment');
  assert.notEqual(scheduleKey('room-a', 'same'), scheduleKey('room-b', 'same'));
  assert.throws(() => draft.begin(() => assert.fail('blank input must not allocate request IDs')), code('INVALID_INPUT'));
});

test('existing draft captures current revision and six detached editable strings only', () => {
  const source = appointment({ privateNote: 'PRIVATE' }), draft = new CenterAppointmentDraft({ ...source, appointment: source });
  assert.equal(draft.originNew, false); assert.equal(draft.revision, 1); assert.equal(draft.values.duration, '30');
  assert.equal(Object.keys(draft.values).length, 6); assert(!JSON.stringify(draft.values).includes('PRIVATE'));
  draft.values.title = '미저장 입력'; assert.equal(source.title, '가상 일정');
});

test('begin validates shared text/date/duration rules, freezes normalized command and never double-allocates', () => {
  const draft = fresh(); Object.assign(draft.values, content({ title: ' 가상 입력 ', room: ' 가상 장소 ', duration: '030' }));
  const op = draft.begin(() => 'synthetic-request'); assert(Object.isFrozen(op)); assert(Object.isFrozen(op.content));
  assert.deepEqual(op, { clientId: 'synthetic-request', expectedRevision: 0, content: content({ title: '가상 입력' }) });
  assert.equal(draft.values.title, ' 가상 입력 '); assert.equal(draft.begin(), null);
  for (const patch of [{ title: 'x'.repeat(101) }, { room: 'x'.repeat(61) }, { title: '\ud800' }, { room: 'a\nb' },
    { duration: '9' }, { duration: '30.0' }, { date: '2026-02-30' }, { time: '23:51', duration: '10' }, { status: null }]) {
    const bad = existing(); Object.assign(bad.values, patch); assert.throws(() => bad.begin(), code('INVALID_INPUT')); assert.equal(bad.operation, null);
  }
});

test('appointment reconcile rejects identity changes, preserves user input and makes revision conflicts sticky', () => {
  const draft = existing(); draft.values.title = '가상 작성 중';
  for (const change of [{ id: 'other' }, { conversationId: 'room-b' }, { childId: 'child-b' }])
    assert.throws(() => draft.reconcile(appointment(change)), code('INVALID_RESPONSE'));
  draft.reconcile(appointment({ revision: 2, title: '서버 수정' })); draft.reconcile(appointment());
  assert(draft.stale); assert.equal(draft.revision, 1); assert.equal(draft.values.title, '가상 작성 중');
  assert.throws(() => draft.begin(), code('APPOINTMENT_CONFLICT'));
});

test('keep and replace are explicit revision decisions with no automatic save or implicit input merge', () => {
  for (const keep of [true, false]) {
    const draft = existing(); draft.values.title = '가상 내 입력'; draft.reconcile(appointment({ revision: 4, title: '가상 최신', status: 'cancelled' }));
    assert(draft.compare(keep)); assert.equal(draft.revision, 4); assert.equal(draft.values.title, keep ? '가상 내 입력' : '가상 최신');
    assert.equal(draft.values.status, keep ? 'scheduled' : 'cancelled'); assert(!draft.stale); assert.equal(draft.operation, null);
    assert.equal(draft.compare(keep), false);
  }
});

test('first no-write scheduling rejection unlocks correction, while CAS requires a fresh explicit comparison', () => {
  for (const error of ['SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE', 'REVISION_LIMIT', 'APPOINTMENT_CONFLICT']) {
    const draft = existing(), op = draft.begin(); draft.failed(op, new LocalApiError(error, 409));
    assert.equal(draft.operation, null); assert(!draft.sending); assert(!draft.uncertain); assert.equal(draft.values.title, '가상 일정');
    if (error === 'APPOINTMENT_CONFLICT') { assert(draft.stale); assert.equal(draft.latest, null); assert.equal(draft.compare(true), false); }
    else { assert(!draft.stale); assert(draft.begin()); }
  }
});

test('unknown results and suspend retain exact command even after a later conflict or modified input', () => {
  for (const failure of [new LocalApiError('UNAVAILABLE'), new LocalApiError('CANCELLED'), new LocalApiError('INVALID_RESPONSE'),
    new LocalApiError('APPOINTMENT_CONFLICT', 503), new Error('PRIVATE-FAILURE')]) {
    const draft = existing(), op = draft.begin(); draft.failed(op, failure); draft.values.title = '잘못된 새 값';
    assert.equal(draft.begin(() => assert.fail('retry must not allocate')), op); draft.failed(op, new LocalApiError('APPOINTMENT_CONFLICT', 409));
    assert.equal(draft.operation, op); assert(draft.uncertain); assert.equal(draft.compare(false), false); assert(!draft.error.includes('PRIVATE-FAILURE'));
  }
  const draft = existing(), op = draft.begin(); draft.interrupt(); assert.equal(draft.begin(), op);
  draft.failed({}, new LocalApiError('INVALID_INPUT', 400)); assert(draft.sending);
});

test('overview reports only three operational totals and four schedule states, not clinical/private counters', () => {
  const children = [profile(), profile('b')], directory = [...members(), { userId: 'guardian-b', role: 'guardian' }];
  const rows = ['scheduled', 'attended', 'absent', 'cancelled'].map(status => appointment({ status, privateNote: 'PRIVATE-NOTE', unread: 99 }));
  const html = operationsOverviewMarkup(children, directory, rows, '2026-10-10');
  assert.equal((html.match(/data-ops-count=/g) ?? []).length, 3); assert.equal((html.match(/data-ops-status-count=/g) ?? []).length, 4);
  for (const [key, total] of [['children', 2], ['therapists', 1], ['guardians', 2]]) assert(html.includes(`data-ops-count="${key}">${total}</dd>`));
  for (const status of ['scheduled', 'attended', 'absent', 'cancelled']) assert(html.includes(`data-ops-status-count="${status}">1</dd>`));
  assert(html.includes('활성 구성원 수는 로그인 계정 발급 수와 다릅니다')); assert(html.includes('조회 사이에 변경될 수 있습니다'));
  assert(!html.includes('PRIVATE-NOTE')); assert(!/data-.*(?:unread|clinical|record-count)/.test(html));
});

test('schedule/editor markup escapes identities and clinical-looking input, with clear historical and notification boundaries', () => {
  const attack = '<img src=x onerror="alert(1)">', child = profile('a', { name: attack, childId: attack });
  const row = appointment({ title: attack, room: attack, therapistId: attack, privateNote: 'PRIVATE' });
  const draft = existing({ title: attack, room: attack }); draft.childName = attack;
  const html = operationsScheduleMarkup([child], [row], profileToday(), profileToday(), new Map([[scheduleKey('room-a', draft.id), draft]]), 'room-a');
  for (const markup of [html, operationsAppointmentMarkup(draft), scheduleSummary(row)]) { assert(!markup.includes('<img')); assert(markup.includes('&lt;img')); assert(!markup.includes('PRIVATE')); }
  const editor = operationsAppointmentMarkup(draft);
  for (const value of ['maxlength="100"', 'maxlength="60"', 'min="10" max="180"', '과거 치료 기록의 당시 일정은 바꾸지 않으며', '소식을 자동 발신하지 않습니다']) assert(editor.includes(value));
  assert(html.includes('문자·카카오톡 알림은 전송하지 않습니다')); assert(html.includes('data-ops-room="room-a"'));
  assert(!/data-care-action|data-open-room|data-view="chat"/.test(html + editor));
});

test('initial screen remains children; overview authenticates, loads today once and uses no clinical endpoint', async () => {
  const f = fixture(); await f.ui.refresh(); assert.equal(f.ui.mode, 'profile'); assert(f.display.contentHtml.includes('operations-children'));
  assert.deepEqual(f.calls.map(c => c[0]), ['session', 'children']);
  await f.ui.showSection('overview'); assert.equal(f.ui.mode, 'overview'); assert(f.display.contentHtml.includes('operations-overview'));
  assert.deepEqual(f.calls.slice(2).map(c => c[0]), ['session', 'children', 'list', 'members']);
  assert.deepEqual(f.calls.find(c => c[0] === 'list')[2], { dateFrom: profileToday(), dateTo: profileToday() });
  assert.equal(f.nav.find(n => n.dataset.opsView === 'overview').attributes['aria-current'], 'page');
});

test('schedule uses one-day read without directory fetch and keeps unapplied date/child selections during polling', async () => {
  const f = await scheduled(), date = f.ui.scheduleDate; f.display.dateInput.value = '2026-11-12'; f.display.newChild.value = 'room-b';
  f.emit('change', f.display.dateForm); await f.ui.refresh();
  assert.equal(f.ui.scheduleDate, date); assert.equal(f.ui.dateInput, '2026-11-12'); assert.equal(f.display.dateInput.value, '2026-11-12');
  assert.equal(f.ui.newAppointmentChild, 'room-b'); assert.equal(f.display.newChild.value, 'room-b');
  assert.deepEqual(f.calls.filter(c => c[0] === 'list').at(-1)[2], { dateFrom: date, dateTo: date });
  assert(!f.calls.some(c => c[0] === 'members')); assert.equal(f.nav.find(n => n.dataset.opsView === 'schedule').attributes['aria-current'], 'page');
});

for (const target of ['date', 'child', 'appointment', 'resume']) test(`changed schedule polling restores only the owned ${target} focus target`, async () => {
  const f = await scheduled();
  const draft = existing({ conversationId: 'room-b', childId: 'child-b' });
  f.ui.scheduleDrafts.set(scheduleKey(draft.roomId, draft.id), draft); f.ui.render();
  f.display.dateInput.value = '2026-11-12'; f.display.newChild.value = 'room-b';
  const matches = value => target === 'date' ? Object.hasOwn(value.dataset, 'opsDateInput')
    : target === 'child' ? Object.hasOwn(value.dataset, 'opsNewChild')
      : target === 'appointment' ? value.dataset.opsAppointment === 'appointment-a' && value.dataset.opsRoom === 'room-b'
        : value.dataset.opsResume === 'room-b/appointment-a';
  const previous = f.display.focusNodes.find(matches); assert(previous); previous.focus({ preventScroll: true });
  const titleFocus = f.display.focused, replacements = f.display.replacements;
  f.appointments.set('room-a/appointment-b', appointment({ id: 'appointment-b', time: '11:00', title: '실제 목록 변경' }));
  await f.ui.refresh();
  const current = f.display.focusNodes.find(matches); assert(current); assert.notEqual(current, previous);
  assert(f.display.replacements > replacements); assert.equal(f.host.ownerDocument.activeElement, current); assert.equal(current.focusCount, 1);
  assert.equal(f.display.focused, titleFocus); assert.equal(f.display.dateInput.value, '2026-11-12'); assert.equal(f.display.newChild.value, 'room-b');
  assert(f.display.focusNodes.filter(value => value !== current).every(value => value.focusCount === 0));
  if (target === 'appointment') assert(f.display.focusNodes.some(value => value.dataset.opsAppointment === 'appointment-a' && value.dataset.opsRoom === 'room-a'));
});

test('changed child-list polling restores the owned recipient settings entry without stealing sibling focus', async () => {
  const f = fixture(); f.ui.mount(); await f.ui.refresh();
  const find = () => f.display.focusNodes.find(value => value.dataset.opsRecipient === 'room-a');
  const previous = find(); assert(previous); previous.focus({ preventScroll: true });
  f.profiles.set('room-b', profile('b', { name: '목록 이름 변경', revision: 2 }));
  await f.ui.refresh();
  const current = find(); assert(current); assert.notEqual(current, previous);
  assert.equal(f.host.ownerDocument.activeElement, current); assert.equal(current.focusCount, 1);
  assert(f.display.focusNodes.filter(value => value !== current).every(value => value.focusCount === 0));
});

test('changed schedule polling does not focus an unrelated control when its prior appointment has disappeared', async () => {
  const f = await scheduled(), target = f.display.focusNodes.find(value => value.dataset.opsAppointment === 'appointment-a' && value.dataset.opsRoom === 'room-b');
  assert(target); target.focus({ preventScroll: true }); f.appointments.delete('room-b/appointment-a');
  await f.ui.refresh(); assert.equal(f.host.ownerDocument.activeElement, null);
  assert(f.display.focusNodes.some(value => value.dataset.opsAppointment === 'appointment-a' && value.dataset.opsRoom === 'room-a'));
  assert(f.display.focusNodes.every(value => value.focusCount === 0));
});

test('changed schedule polling never steals focus from outside its owned content', async () => {
  const f = await scheduled(), outside = node({ dataset: { opsAppointment: 'appointment-a', opsRoom: 'room-a' } });
  f.host.ownerDocument.activeElement = outside;
  f.appointments.set('room-a/appointment-a', appointment({ title: '새 목록 제목' })); await f.ui.refresh();
  assert.equal(f.host.ownerDocument.activeElement, outside); assert(f.display.focusNodes.every(value => value.focusCount === 0));
});

test('date apply validates before reading and only explicit valid submit switches the requested day', async () => {
  const f = await scheduled(), count = f.calls.length; f.display.dateInput.value = '2026-02-30'; await f.ui.applyDate();
  assert.equal(f.calls.length, count); assert(f.notices.at(-1).includes('일정 날짜')); assert.equal(f.ui.scheduleDate, profileToday());
  f.display.dateInput.value = '2026-11-12'; f.emit('submit', f.display.dateForm); await until(() => f.ui.connected && f.ui.pending === null);
  assert.equal(f.ui.scheduleDate, '2026-11-12'); assert.deepEqual(f.calls.filter(c => c[0] === 'list').at(-1)[2], { dateFrom: '2026-11-12', dateTo: '2026-11-12' });
});

test('new appointment rechecks current child but never pre-GETs a nonexistent appointment or fills assumed duration', async () => {
  const f = await scheduled(); await f.ui.openAppointment('room-a'); const draft = f.ui.current();
  assert(draft.originNew); assert.equal(draft.revision, 0); assert.match(draft.id, /^[0-9a-f-]{36}$/);
  assert.equal(f.input('duration').value, ''); assert.equal(f.input('time').value, ''); assert.equal(f.input('title').value, '');
  assert.equal(draft.childName, '가상 아이 a'); assert(f.calls.some(c => c[0] === 'profile')); assert(!f.calls.some(c => c[0] === 'appointment'));
  await f.ui.save(); assert(!f.calls.some(c => c[0] === 'save')); assert.equal(draft.operation, null);
});

test('only one unfinished new appointment per child resumes with the original ID and authored fields', async () => {
  const f = await scheduled(); await f.ui.openAppointment('room-a'); fill(f, { title: 'A 신규 초안' }); const first = f.ui.current();
  f.ui.back(); await settled(f.ui); await f.ui.openAppointment('room-b'); fill(f, { title: 'B 신규 초안' }); const second = f.ui.current();
  f.ui.back(); await settled(f.ui); await f.ui.openAppointment('room-a');
  assert.equal(f.ui.current(), first); assert.equal(f.input('title').value, 'A 신규 초안'); assert.notEqual(first.id, second.id);
  assert.equal(f.ui.scheduleDrafts.size, 2); assert.equal(second.values.title, 'B 신규 초안');
});

test('existing appointment opens only a listed or owned pair and authenticates current child and exact detail', async () => {
  const f = await scheduled(), before = f.calls.length; await f.ui.openAppointment('room-a', 'unknown');
  assert.equal(f.calls.length, before); assert.equal(f.ui.mode, 'schedule');
  await f.ui.openAppointment('room-a', 'appointment-a'); assert.equal(f.ui.current().originNew, false);
  assert.deepEqual(f.calls.slice(before).map(c => c[0]), ['session', 'children', 'profile', 'appointment']);
  assert.equal(f.input('duration').value, '30'); assert.equal(f.ui.current().revision, 1);
});

test('same appointment ID in different rooms and second appointment in the same room keep independent drafts', async () => {
  const f = await opened(); f.input('title').value = 'A 첫 입력'; const first = f.ui.current();
  await f.ui.openAppointment('room-b', 'appointment-a'); f.input('title').value = 'B 첫 입력'; const second = f.ui.current();
  await f.ui.openAppointment('room-a', 'appointment-b'); f.input('title').value = 'A 둘째 입력'; const third = f.ui.current();
  await f.ui.openAppointment('room-a', 'appointment-a'); assert.equal(f.ui.current(), first); assert.equal(f.input('title').value, 'A 첫 입력');
  assert.equal(second.values.title, 'B 첫 입력'); assert.equal(third.values.title, 'A 둘째 입력'); assert.equal(f.ui.scheduleDrafts.size, 3);
});

test('profile, relationship and registration drafts survive schedule navigation and schedule discard removes only its target', async () => {
  const f = fixture(); await f.ui.refresh(); await f.ui.open('room-a'); f.input('name').value = '프로필 입력'; const p = f.ui.current();
  await f.ui.open('room-a', 'relationships'); const r = f.ui.current();
  await f.ui.newChild(); f.input('name').value = '등록 입력'; const reg = f.ui.current();
  await f.ui.showSection('schedule'); await f.ui.openAppointment('room-a'); fill(f); f.ui.discard(); await settled(f.ui);
  assert.equal(f.ui.scheduleDrafts.size, 0); assert.equal(f.ui.states.get('room-a'), p); assert.equal(p.values.name, '프로필 입력');
  assert.equal(f.ui.relationshipStates.get('room-a'), r); assert.equal(f.ui.registration, reg); assert.equal(reg.values.name, '등록 입력');
});

test('unchanged editor polling retains the same form and input nodes without stealing focus or changing the pinned revision', async () => {
  const f = await opened(), form = f.display.form, input = f.input('title'), focus = f.display.focused;
  input.value = '보존할 입력'; await f.ui.refresh(); await f.ui.refresh();
  assert.equal(f.display.form, form); assert.equal(f.input('title'), input); assert.equal(input.value, '보존할 입력');
  assert.equal(f.display.focused, focus); assert.equal(f.ui.current().revision, 1);
});

test('changed version blocks saving until explicit keep/replace and never overwrites original authored values', async () => {
  for (const keep of [true, false]) {
    const f = await opened(); fill(f, { title: '나의 일정 입력' });
    f.appointments.set(scheduleKey('room-a', 'appointment-a'), appointment({ revision: 3, title: '서버 최신', status: 'cancelled' }));
    await f.ui.refresh(); assert(f.ui.current().stale); assert(f.control('[type="submit"]').disabled); assert.equal(f.ui.current().revision, 1);
    assert.equal(f.input('title').value, '나의 일정 입력'); await f.ui.save(); assert(!f.calls.some(c => c[0] === 'save'));
    f.ui.compare(keep); assert.equal(f.ui.current().revision, 3); assert.equal(f.input('title').value, keep ? '나의 일정 입력' : '서버 최신');
    assert.equal(f.input('status').value, keep ? 'scheduled' : 'cancelled'); assert(!f.ui.current().operation);
  }
});

test('first actual CAS conflict retains input, waits for a fresh exact GET and keeps comparison controls stable', async () => {
  const f = await opened({}, { save: async () => { throw new LocalApiError('APPOINTMENT_CONFLICT', 409); } });
  fill(f, { title: '충돌 전 입력' }); await f.ui.save(); const draft = f.ui.current(); assert(draft.stale); assert.equal(draft.latest, null);
  assert.equal(draft.operation, null); assert.equal(f.input('title').value, '충돌 전 입력'); f.ui.compare(true); assert.equal(draft.revision, 1);
  f.appointments.set(scheduleKey('room-a', 'appointment-a'), appointment({ revision: 2, title: '<script>latest</script>' })); await f.ui.refresh();
  const comparison = f.control('[data-ops-conflict]'); assert(comparison.innerHTML.includes('&lt;script&gt;')); assert(!comparison.innerHTML.includes('<script>'));
  const form = f.display.form; await f.ui.refresh(); assert.equal(f.display.form, form); assert.equal(f.control('[data-ops-conflict]'), comparison);
  f.ui.compare(true); assert.equal(draft.revision, 2); assert.equal(f.input('title').value, '충돌 전 입력');
});

test('created-origin draft adopted after an ID-collision conflict continues exact current reads after keep', async () => {
  const f = await scheduled({}, { save: async () => { throw new LocalApiError('APPOINTMENT_CONFLICT', 409); } });
  await f.ui.openAppointment('room-a'); fill(f, { title: '보존할 신규 입력' }); const draft = f.ui.current();
  assert(draft.originNew); assert.equal(draft.revision, 0); await f.ui.save(); assert(draft.stale); assert.equal(draft.operation, null);
  f.appointments.set(scheduleKey('room-a', draft.id), appointment({ id: draft.id, revision: 2, title: '기존 서버 일정' }));
  await f.ui.refresh(); f.ui.compare(true); assert(draft.originNew); assert.equal(draft.revision, 2); assert(!draft.stale);
  assert.equal(f.input('title').value, '보존할 신규 입력');
  const reads = f.calls.filter(value => value[0] === 'appointment').length;
  f.appointments.set(scheduleKey('room-a', draft.id), appointment({ id: draft.id, revision: 3, title: '이후 서버 변경' }));
  await f.ui.refresh(); assert.equal(f.calls.filter(value => value[0] === 'appointment').length, reads + 1);
  assert.equal(draft.revision, 2); assert.equal(draft.latest.revision, 3); assert(draft.stale);
  assert.equal(f.input('title').value, '보존할 신규 입력'); assert(f.control('[type="submit"]').disabled);
  assert.equal(f.ui.scheduleDrafts.size, 1); assert.equal(draft.operation, null);
});

for (const error of ['SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE']) test(`${error} first definitive rejection keeps values editable and permits an explicit new request`, async () => {
  const sent = [], f = await opened({}, { save: async (c, r, id, op) => { sent.push(op); throw new LocalApiError(error, 409); } });
  fill(f, { time: '11:00', room: '새 장소' }); await f.ui.save(); assert.equal(f.ui.current().operation, null); assert(!f.ui.current().stale);
  assert(!f.input('time').disabled); assert.equal(f.input('time').value, '11:00'); assert.equal(f.input('room').value, '새 장소');
  f.input('time').value = '12:00'; await f.ui.save(); assert.notEqual(sent[0].clientId, sent[1].clientId);
  assert.equal(sent[1].content.time, '12:00'); assert.equal(sent[1].expectedRevision, 1);
});

test('unknown new creation survives list re-entry without preliminary 404 and retries identical IDs/content only', async () => {
  const sent = [], f = await scheduled({}, { save: async (c, r, id, op) => { sent.push({ room: r, id, op }); throw new LocalApiError('UNAVAILABLE'); },
    appointment: async () => assert.fail('new unknown creation must not GET nonexistent appointment') });
  await f.ui.openAppointment('room-a'); fill(f, { title: '신규 원요청' }); await f.ui.save(); const draft = f.ui.current(), op = draft.operation;
  assert(draft.uncertain); assert(f.input('title').disabled); assert(f.control('[type="submit"]').hidden); assert(f.display.center.disabled);
  f.ui.discard(); assert.equal(f.ui.current(), draft); f.ui.back(); await settled(f.ui);
  assert(f.display.contentHtml.includes('처리 결과 확인 필요')); await f.ui.openAppointment('room-a'); assert.equal(f.ui.current(), draft);
  f.input('title').value = '전송되면 안 되는 변조'; f.scheduleApi.save = async (c, r, id, next) => { sent.push({ room: r, id, op: next }); throw new LocalApiError('APPOINTMENT_CONFLICT', 409); };
  await f.ui.save(); assert.equal(sent[1].op, op); assert.equal(sent[1].id, sent[0].id); assert.equal(sent[1].room, 'room-a');
  assert.equal(op.content.title, '신규 원요청'); assert.equal(draft.operation, op); assert(draft.uncertain); assert(f.control('[data-ops-action="discard"]').disabled);
});

test('unknown existing write is not replaced by a newer GET version and only exact receipt removes the draft', async () => {
  const f = await opened({}, { save: async () => { throw new LocalApiError('UNAVAILABLE'); } }); fill(f); await f.ui.save();
  const draft = f.ui.current(), op = draft.operation; f.appointments.set(scheduleKey('room-a', 'appointment-a'), appointment({ revision: 3, title: '동료 최신 일정' }));
  f.ui.back(); await settled(f.ui); await f.ui.openAppointment('room-a', 'appointment-a'); assert.equal(draft.operation, op);
  f.scheduleApi.save = async (c, r, id, next) => { assert.equal(next, op); return { kind: 'appointment', id, revision: 2, changed: true, replayed: true }; };
  await f.ui.save(); assert(!f.ui.scheduleDrafts.has(scheduleKey('room-a', 'appointment-a'))); assert.equal(f.ui.mode, 'schedule');
  assert(f.ui.scheduleRows.some(row => row.revision === 3 && row.title === '동료 최신 일정'));
});

test('save success returns to saved date, clears only the saved draft and does not write any other feature', async () => {
  const f = await opened(); f.input('title').value = 'A 보존'; const first = f.ui.current();
  await f.ui.openAppointment('room-a', 'appointment-b'); fill(f, { date: '2026-11-12', status: 'absent' }); await f.ui.save();
  assert.equal(f.ui.mode, 'schedule'); assert.equal(f.ui.scheduleDate, '2026-11-12'); assert.equal(f.ui.dateInput, '2026-11-12');
  assert.equal(f.ui.scheduleDrafts.get(scheduleKey('room-a', 'appointment-a')), first); assert.equal(first.values.title, 'A 보존');
  assert.equal(f.ui.scheduleDrafts.size, 1); assert.equal(f.calls.filter(c => c[0] === 'save').length, 1);
  assert(f.notices.some(text => text.includes('알림은 전송하지 않았습니다'))); assert(f.ui.scheduleRows.some(row => row.status === 'absent'));
});

test('back while saving keeps uncertain command, aborts observation and ignores late receipt until explicit retry', async () => {
  const gate = deferred(); let signal; const f = await opened({}, { save: async (c, r, id, op, next) => { signal = next; return gate.promise; } });
  fill(f); const saving = f.ui.save(), draft = f.ui.current(), op = draft.operation; f.ui.back(); await settled(f.ui);
  assert(signal.aborted); assert(draft.uncertain); gate.resolve({}); await saving;
  assert.equal(f.ui.mode, 'schedule'); assert.equal(draft.operation, op); assert(f.ui.scheduleDrafts.has(scheduleKey('room-a', 'appointment-a')));
  await f.ui.openAppointment('room-a', 'appointment-a'); assert.equal(f.ui.current(), draft); assert(!f.control('[data-ops-action="retry"]').hidden);
});

test('late detail after offline suspension or destruction cannot create a draft or reopen a stale editor', async () => {
  for (const action of ['suspend', 'destroy']) {
    const gate = deferred(); let signal; const f = await scheduled({}, { appointment: async (c, r, id, next) => { signal = next; return gate.promise; } });
    const opening = f.ui.openAppointment('room-a', 'appointment-a'); await until(() => !!signal); f.ui[action]();
    assert(signal.aborted); gate.resolve(appointment()); await opening;
    assert.equal(f.ui.scheduleDrafts.size, 0); assert.equal(f.display.form, null); assert(!f.ui.connected);
    if (action === 'destroy') assert.equal(f.display.html, '');
  }
});

test('late schedule response cannot reappear after destruction', async () => {
  const gate = deferred(); let signal; const f = fixture({}, { list: async (c, p, next) => { signal = next; return gate.promise; } });
  await f.ui.refresh(); const showing = f.ui.showSection('schedule'); await until(() => !!signal); f.ui.destroy();
  gate.resolve({ version: 1, appointments: [appointment()] }); await showing;
  assert(signal.aborted); assert.deepEqual(f.ui.scheduleRows, []); assert.equal(f.display.html, ''); assert.equal(f.ui.scheduleDrafts.size, 0);
});

test('mismatched child in appointment response fails closed before displaying or storing it', async () => {
  const f = await opened({}, { appointment: async () => appointment({ childId: 'child-b' }) });
  assert(!f.ui.connected); assert.equal(f.display.form, null); assert.equal(f.ui.scheduleDrafts.size, 0); assert(!f.display.contentHtml.includes('child-b'));
});

test('new appointment profile identity change hides its draft rather than migrating it to another child', async () => {
  const f = await scheduled(); await f.ui.openAppointment('room-a'); fill(f); const draft = f.ui.current();
  f.api.childProfile = async () => profile('a', { childId: 'different-child' }); await f.ui.refresh();
  assert(!f.ui.connected); assert.equal(f.display.form, null); assert.equal(f.ui.current(), draft); assert.equal(draft.childId, 'child-a');
  assert(!f.calls.some(c => c[0] === 'save'));
});

for (const change of ['account', 'role', 'membership']) test(`${change} loss clears schedule data and every draft before notifying the owner`, async () => {
  const f = await opened(); fill(f); await f.ui.open('room-a'); f.input('name').value = '가상 프로필'; await f.ui.newChild(); f.input('name').value = '가상 등록';
  if (change === 'account') f.user.userId = 'other-manager'; else if (change === 'role') f.user.centers[0].role = 'therapist'; else f.user.centers.splice(0, 1);
  const before = f.calls.length; await f.ui.refresh(); assert.deepEqual(f.calls.slice(before).map(c => c[0]), ['session']);
  assert(f.ui.destroyed); assert.equal(f.denied.length, 1); assert.equal(f.display.html, ''); assert.equal(f.ui.scheduleDrafts.size, 0);
  assert.equal(f.ui.states.size, 0); assert.equal(f.ui.registration, null); assert.deepEqual(f.ui.scheduleRows, []); assert.deepEqual(f.ui.members, []);
});

test('schedule snapshot failure hides partial UI while preserving pending date/child selections and existing drafts', async () => {
  const f = await opened(); fill(f, { title: '보존할 일정' }); const draft = f.ui.current(); f.ui.back(); await settled(f.ui);
  f.display.dateInput.value = '2026-11-12'; f.display.newChild.value = 'room-b'; const original = f.scheduleApi.list;
  f.scheduleApi.list = async () => { throw new LocalApiError('SNAPSHOT_CHANGED'); }; await f.ui.refresh();
  assert(!f.ui.connected); assert.equal(f.display.dateInput, null); assert.deepEqual(f.ui.scheduleRows, []);
  assert.equal(f.ui.dateInput, '2026-11-12'); assert.equal(f.ui.newAppointmentChild, 'room-b'); assert.equal(f.ui.scheduleDrafts.get(scheduleKey('room-a', 'appointment-a')), draft);
  f.scheduleApi.list = original; await f.ui.refresh(); assert.equal(f.display.dateInput.value, '2026-11-12'); assert.equal(f.display.newChild.value, 'room-b');
});

test('permission denial during schedule read/write wipes all data rather than retaining a resumable unauthorized form', async () => {
  for (const at of ['read', 'write']) {
    const f = await opened(); fill(f);
    if (at === 'read') { f.scheduleApi.appointment = async () => { throw new LocalApiError('NOT_FOUND', 404); }; await f.ui.refresh(); }
    else { f.scheduleApi.save = async () => { throw new LocalApiError('AUTH_REQUIRED', 401); }; await f.ui.save(); }
    assert(f.ui.destroyed); assert.equal(f.ui.scheduleDrafts.size, 0); assert.equal(f.display.html, ''); assert.equal(f.denied.length, 1);
  }
});

test('destroy during pending write prevents late receipt resurrection and aborts lifecycle and event ownership', async () => {
  const gate = deferred(); let signal; const f = await opened({}, { save: async (c, r, id, op, next) => { signal = next; return gate.promise; } });
  fill(f); const pending = f.ui.save(); f.ui.destroy(); gate.resolve({}); await pending;
  assert(signal.aborted); assert(f.host.listeners.every(listener => listener.signal.aborted)); assert.equal(f.ui.scheduleDrafts.size, 0);
  assert.equal(f.ui.appointmentId, null); assert.equal(f.ui.selected, null); assert.equal(f.display.html, '');
});

test('unresolved schedule request blocks center change from other sections but does not block isolated profile editing', async () => {
  const f = await opened({}, { save: async () => { throw new LocalApiError('UNAVAILABLE'); } }); fill(f); await f.ui.save(); const draft = f.ui.current();
  await f.ui.showSection('children'); assert(f.display.center.disabled);
  f.display.center.listeners.find(listener => listener.type === 'change').handler({ target: { value: 'center-b' } }); assert.deepEqual(f.centerChanges, []);
  await f.ui.open('room-a'); f.input('name').value = '독립 프로필 입력'; f.emit('input'); assert.equal(f.ui.current().values.name, '독립 프로필 입력');
  assert.equal(f.ui.scheduleDrafts.get(scheduleKey('room-a', 'appointment-a')), draft); assert(draft.operation);
});
