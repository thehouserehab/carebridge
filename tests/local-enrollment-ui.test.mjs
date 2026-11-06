// Pure state/controller/markup doubles: no browser, HTTP, database or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChildRegistrationDraft, RelationshipDraft, registrationMarkup, relationshipsMarkup,
  relationshipPeople, relationshipSummary } from '../local-api/operations-onboarding.js';
import { OperationsUi } from '../local-api/operations-ui.js';
import { LocalApiError } from '../local-api/client.js';
import { ProfileFieldError } from '../src/profile-fields.js';

const clone = value => structuredClone(value);
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const profile = (room = 'a', extra = {}) => ({ conversationId: `room-${room}`, childId: `child-${room}`,
  name: `가상 아이 ${room}`, age: null, ageAsOf: null, revision: 1, ...extra });
const identity = () => ({ userId: 'manager-a', email: 'manager@example.test', centers: [
  { id: 'center-a', role: 'center' }, { id: 'center-b', role: 'guardian' },
] });
const members = () => [
  { userId: 'manager-a', role: 'center', displayName: '가상 센터' },
  { userId: 'therapist-a', role: 'therapist', displayName: '가상 치료사 A' },
  { userId: 'therapist-b', role: 'therapist', displayName: '가상 치료사 B' },
  { userId: 'guardian-a', role: 'guardian', displayName: '가상 보호자 A' },
  { userId: 'guardian-b', role: 'guardian', displayName: null },
];
const relationships = (room = 'a', extra = {}) => ({ conversationId: `room-${room}`, childId: `child-${room}`, version: 3,
  participants: [{ userId: 'therapist-a', role: 'therapist', firstSequence: 1 },
    { userId: 'guardian-a', role: 'guardian', firstSequence: 7 }], ...extra });
const relationshipDraft = extra => new RelationshipDraft(relationships('a', extra), members());
const registrationDraft = () => { const draft = new ChildRegistrationDraft(); draft.values.name = '가상 등록'; return draft; };
const confirmed = draft => { draft.values.historyConfirmed = true; return draft; };
const deferred = () => Promise.withResolvers();
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (text, name) => { const result = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(text); return result ? decode(result[1]) : null; };
const flag = (text, name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$|=)`).test(text);
function node(extra = {}) {
  return { disabled: false, hidden: false, textContent: '', innerHTML: '', listeners: [], dataset: {},
    addEventListener(type, handler, options) { this.listeners.push({ type, handler, signal: options?.signal }); },
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; }, ...extra };
}

// Models only queried form controls, checked state and content replacement. It
// does not simulate native validation, layout, actual focus or browser events.
function hostStub() {
  const display = { html: '', contentHtml: '', form: null, replacements: 0, focused: 0, center: node(), title: node() };
  display.title.focus = options => { assert.equal(options.preventScroll, true); display.focused++; };
  const content = node();
  Object.defineProperty(content, 'innerHTML', { get: () => display.contentHtml, set(html) {
    display.contentHtml = html; display.replacements++; display.form = null;
    const formId = /<form data-testid="([^"]+)"/.exec(html)?.[1];
    if (!formId) return;
    const elements = {}, inputs = [], selects = [];
    for (const [, raw] of html.matchAll(/<input\b([^>]*)>/g)) {
      const input = node({ name: attr(raw, 'name'), value: attr(raw, 'value') ?? 'on', checked: flag(raw, 'checked'),
        type: attr(raw, 'type') ?? 'text' });
      inputs.push(input); if (input.name && input.name !== 'guardian') elements[input.name] = input;
    }
    for (const [, raw, body] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const options = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, option]) =>
        node({ value: attr(option, 'value') ?? '', selected: flag(option, 'selected'), disabled: flag(option, 'disabled') }));
      const select = node({ name: attr(raw, 'name'), value: (options.find(option => option.selected) ?? options[0])?.value ?? '',
        options, dataset: attr(raw, 'data-guardian-history') === null ? {} : { guardianHistory: attr(raw, 'data-guardian-history') },
        querySelector: selector => options.find(option => selector === `[value="${option.value}"]`) ?? null });
      selects.push(select); if (select.name) elements[select.name] = select;
    }
    const controls = new Map(['[type="submit"]', '[data-ops-action="retry"]', '[data-ops-action="discard"]',
      '[data-ops-error]', '[data-ops-conflict]', '[data-past-confirm]'].map(key => [key, node()]));
    display.form = { id: formId, elements, inputs, selects, controls,
      querySelector: selector => controls.get(selector) ?? null,
      querySelectorAll: selector => selector === 'input' ? inputs : selector === 'select' ? selects
        : selector === 'input[name="guardian"]' ? inputs.filter(input => input.name === 'guardian')
          : selector === '[data-guardian-history]' ? selects.filter(select => select.dataset.guardianHistory) : [],
      matches: selector => selector.split(',').includes(`[data-testid="${formId}"]`) };
  } });
  const host = node({ contains: () => true, querySelector(selector) {
    if (selector === '[data-ops-content]') return display.html.includes('data-ops-content') ? content : null;
    if (selector === '[data-ops-center]') return display.html.includes('data-ops-center') ? display.center : null;
    if (selector === '[data-ops-title]') return display.contentHtml.includes('data-ops-title') ? display.title : null;
    if (selector === `[data-testid="${display.form?.id}"]`) return display.form;
    return null;
  }, replaceChildren() { display.html = ''; content.innerHTML = ''; } });
  Object.defineProperty(host, 'innerHTML', { get: () => display.html, set: html => { display.html = html; } });
  return { host, display };
}
function fixture(overrides = {}) {
  const { host, display } = hostStub(), user = identity(), notices = [], denied = [], calls = [], centerChanges = [];
  const profiles = new Map(['a', 'b'].map(room => [profile(room).conversationId, profile(room)]));
  const relations = new Map(['a', 'b'].map(room => [relationships(room).conversationId, relationships(room)]));
  const directory = members();
  const transport = { expectedUserId: user.userId, request: () => assert.fail('scoped controller API double required'),
    session: async signal => { calls.push(['session', signal]); return clone(user); } };
  const ui = new OperationsUi({ host, transport, user: clone(user), centerId: 'center-a',
    announce: text => notices.push(text), onDenied: error => denied.push(error), onCenterChange: id => centerChanges.push(id) });
  const api = {
    children: async (center, signal) => { calls.push(['children', center, signal]); return clone([...profiles.values()]); },
    childProfile: async (center, room, signal) => { calls.push(['profile', center, room, signal]); return clone(profiles.get(room)); },
    members: async (center, signal) => { calls.push(['members', center, signal]); return clone(directory); },
    relationships: async (center, room, signal) => { calls.push(['relationships', center, room, signal]); return clone(relations.get(room)); },
    childRegister: async (center, operation, signal) => {
      calls.push(['register', center, operation, signal]);
      profiles.set(operation.conversationId, { conversationId: operation.conversationId, childId: operation.childId, ...operation.content, revision: 1 });
      return { operation: 'child.register', childId: operation.childId, conversationId: operation.conversationId, appliedVersion: 1, changed: true, replayed: false };
    },
    relationshipsSave: async (center, room, operation, signal) => {
      calls.push(['relationship-save', center, room, operation, signal]);
      const participants = [...(operation.therapist ? [{ ...operation.therapist, role: 'therapist' }] : []),
        ...operation.guardians.map(p => ({ ...p, role: 'guardian' }))].map(p => ({ userId: p.userId, role: p.role, firstSequence: 9 }));
      relations.set(room, { ...relations.get(room), participants, version: operation.expectedVersion + 2 });
      return { conversationId: room, appliedVersion: operation.expectedVersion + 2, changed: true, replayed: false };
    },
    childProfileSave: async (center, room, child, operation, signal) => {
      calls.push(['profile-save', center, room, child, operation, signal]);
      profiles.set(room, { ...profiles.get(room), ...operation.content, revision: operation.expectedRevision + 1 });
      return { operation: 'child.save', childId: child, conversationId: room, appliedVersion: operation.expectedRevision + 1, changed: true, replayed: false };
    }, ...overrides,
  };
  ui.api = api; ui.mount();
  return { ui, api, user, transport, host, display, profiles, relations, directory, calls, notices, denied, centerChanges,
    input: name => display.form.elements[name], control: selector => display.form.querySelector(selector),
    guardian: id => display.form.inputs.find(input => input.name === 'guardian' && input.value === id),
    guardianHistory: id => display.form.selects.find(select => select.dataset.guardianHistory === id),
    emit: type => { for (const listener of host.listeners.filter(listener => listener.type === type && !listener.signal.aborted)) listener.handler({ target: display.form, preventDefault() {} }); },
  };
}
async function opened(mode = 'relationships', overrides = {}) {
  const f = fixture(overrides); await f.ui.refresh();
  if (mode === 'registration') await f.ui.newChild(); else await f.ui.open('room-a', mode);
  return f;
}
async function settled(ui) {
  for (let i = 0; ui.pending && i < 80; i++) await Promise.resolve();
  assert.equal(ui.pending, null, 'bounded controller continuation must settle');
}
async function until(check) {
  for (let i = 0; !check() && i < 80; i++) await Promise.resolve();
  assert(check(), 'bounded controller checkpoint must be reached');
}
function confirm(f, past = false) { f.input('historyConfirmed').checked = true; f.input('pastHistoryConfirmed').checked = past; f.emit('change'); }

test('registration starts blank and freezes three new identities plus normalized metadata once', () => {
  const draft = new ChildRegistrationDraft(); assert.deepEqual(draft.values, { name: '', age: '', ageAsOf: '' });
  Object.assign(draft.values, { name: ' 가상 등록 ', age: '0', ageAsOf: '2024-02-29' });
  let count = 0; const op = draft.begin(() => `synthetic-${++count}`);
  assert.deepEqual(op, { clientId: 'synthetic-1', childId: 'synthetic-2', conversationId: 'synthetic-3',
    content: { name: '가상 등록', age: 0, ageAsOf: '2024-02-29' } });
  assert(Object.isFrozen(op)); assert(Object.isFrozen(op.content)); assert.equal(draft.values.name, ' 가상 등록 ');
  assert.equal(draft.begin(() => assert.fail('no duplicate allocation')), null); assert.equal(count, 3);
});

test('registration invalid and mismatched profile fields allocate no identity; omitted age stays null', () => {
  for (const value of [{ name: '' }, { name: '\ud800' }, { name: '가상\n이름' }, { name: 'x'.repeat(31) },
    { age: '27', ageAsOf: '2024-02-29' }, { age: '0' }, { ageAsOf: '2024-02-29' },
    { age: '0', ageAsOf: '2023-02-29' }, { age: '0', ageAsOf: '9999-01-01' }]) {
    const draft = registrationDraft(); Object.assign(draft.values, value);
    assert.throws(() => draft.begin(() => assert.fail('invalid input must precede ID allocation')), ProfileFieldError);
    assert.equal(draft.operation, null); assert.equal(draft.sending, false);
  }
  assert.deepEqual(registrationDraft().begin().content, { name: '가상 등록', age: null, ageAsOf: null });
});

test('registration first definite rejection permits correction while unknown and later conflicts keep all original IDs', () => {
  const draft = registrationDraft(), first = draft.begin(); draft.failed(first, new LocalApiError('CHILD_EXISTS', 409));
  assert.equal(draft.operation, null); draft.values.name = '가상 수정'; const second = draft.begin();
  assert.notEqual(second.clientId, first.clientId); assert.notEqual(second.childId, first.childId); assert.notEqual(second.conversationId, first.conversationId);
  draft.failed(second, new Error('PRIVATE-RAW')); draft.values.name = '재전송에 들어가면 안 됨';
  assert.equal(draft.begin(() => assert.fail('unknown retry must not allocate')), second);
  draft.failed(second, new LocalApiError('CHILD_EXISTS', 409)); assert.equal(draft.operation, second); assert(draft.uncertain);
  assert(!draft.error.includes('PRIVATE-RAW')); assert.equal(second.content.name, '가상 수정');
});

test('relationship draft pins child/version and preserves existing scopes without default consent', () => {
  const source = relationships(), draft = new RelationshipDraft(source, members());
  assert.equal(draft.childId, 'child-a'); assert.equal(draft.roomId, 'room-a'); assert.equal(draft.revision, 3);
  assert.deepEqual(draft.values, { therapist: { userId: 'therapist-a', history: 'preserve' },
    guardians: [{ userId: 'guardian-a', history: 'preserve' }], historyConfirmed: false, pastHistoryConfirmed: false });
  draft.values.guardians[0].history = 'all'; assert.equal(source.participants[1].firstSequence, 7);
  assert.throws(() => draft.begin(), code('HISTORY_CONFIRMATION_REQUIRED'));
});

test('relationship all-history needs both explicit confirmations and produces a deep frozen copied command', () => {
  const draft = confirmed(relationshipDraft()); draft.values.guardians[0].history = 'all';
  assert.throws(() => draft.begin(), code('PAST_HISTORY_CONFIRMATION_REQUIRED')); assert.equal(draft.operation, null);
  draft.values.pastHistoryConfirmed = true; const op = draft.begin(() => 'synthetic-relation');
  assert.equal(op.expectedVersion, 3); assert.equal(op.clientId, 'synthetic-relation');
  for (const value of [op, op.therapist, op.guardians, op.guardians[0]]) assert(Object.isFrozen(value));
  draft.values.guardians[0].history = 'from_now'; assert.equal(op.guardians[0].history, 'all');
  assert.equal(draft.begin(), null);
});

test('relationship conflict is sticky and only explicit keep rebases disconnected preserve to from_now with new confirmation', () => {
  const draft = confirmed(relationshipDraft()); draft.values.pastHistoryConfirmed = true;
  draft.reconcile(relationships('a', { version: 9, participants: [] }), members());
  assert.equal(draft.revision, 3); assert(draft.stale); assert.throws(() => draft.begin(), code('RELATIONSHIP_CONFLICT'));
  assert.equal(draft.compare(true), true); assert.equal(draft.revision, 9);
  assert.deepEqual(draft.values, { therapist: { userId: 'therapist-a', history: 'from_now' },
    guardians: [{ userId: 'guardian-a', history: 'from_now' }], historyConfirmed: false, pastHistoryConfirmed: false });
  assert.equal(draft.operation, null); assert.throws(() => draft.begin(), code('HISTORY_CONFIRMATION_REQUIRED'));
});

test('replace takes latest participants explicitly and keep never silently downgrades selected all-history', () => {
  const latest = relationships('a', { version: 8, participants: [{ userId: 'guardian-b', role: 'guardian', firstSequence: 10 }] });
  const replaced = confirmed(relationshipDraft()); replaced.reconcile(latest, members()); assert(replaced.compare(false));
  assert.deepEqual(replaced.values, { therapist: null, guardians: [{ userId: 'guardian-b', history: 'preserve' }],
    historyConfirmed: false, pastHistoryConfirmed: false });
  const kept = confirmed(relationshipDraft()); kept.values.guardians[0].history = 'all'; kept.reconcile(latest, members()); kept.compare(true);
  assert.equal(kept.values.guardians[0].history, 'all'); assert.equal(kept.values.pastHistoryConfirmed, false);
  const sticky = relationshipDraft(); sticky.reconcile(latest, members()); sticky.reconcile(relationships(), members()); assert(sticky.stale);
});

test('directory change resets consent but keeps selected unavailable users visible, including after a conflict', () => {
  const draft = confirmed(relationshipDraft()); draft.values.pastHistoryConfirmed = true;
  draft.reconcile(relationships(), []); assert.equal(draft.values.historyConfirmed, false); assert.equal(draft.values.pastHistoryConfirmed, false);
  assert.equal(draft.values.guardians[0].userId, 'guardian-a'); assert(!draft.stale); assert(draft.directoryChanged);
  assert.equal(relationshipPeople(draft, 'therapist')[0].userId, 'therapist-a');
  assert(relationshipsMarkup(draft).includes('현재 선택 불가')); assert(relationshipsMarkup(draft).includes('name="guardian" value="guardian-a" checked'));
  draft.latest = null; assert.equal(relationshipPeople(draft, 'guardian')[0].userId, 'guardian-a');
});

test('reconciliation rejects cross-child/room and does not mutate a pending command during directory changes', () => {
  for (const change of [{ childId: 'child-b' }, { conversationId: 'room-b' }])
    assert.throws(() => relationshipDraft().reconcile(relationships('a', change), members()), code('INVALID_RESPONSE'));
  const draft = confirmed(relationshipDraft()), op = draft.begin(); draft.reconcile(relationships('a', { version: 8 }), []);
  assert.equal(draft.operation, op); assert.equal(op.expectedVersion, 3); assert.equal(draft.values.historyConfirmed, true);
  assert.equal(draft.compare(false), false); draft.interrupt(); assert(draft.uncertain); assert.equal(draft.begin(), op);
});

test('relationship first CAS rejection awaits latest read; unknown result cannot be unlocked by a later conflict', () => {
  const draft = confirmed(relationshipDraft()), op = draft.begin(); draft.failed(op, new LocalApiError('RELATIONSHIP_CONFLICT', 409));
  assert.equal(draft.operation, null); assert.equal(draft.latest, null); assert(draft.stale); assert.equal(draft.compare(true), false);
  for (const error of [new LocalApiError('UNAVAILABLE'), new LocalApiError('CANCELLED'), new LocalApiError('IDEMPOTENCY_CONFLICT', 409),
    new LocalApiError('RELATIONSHIP_CONFLICT', 503), new Error('PRIVATE-RAW')]) {
    const uncertain = confirmed(relationshipDraft()), original = uncertain.begin(); uncertain.failed(original, error);
    assert.equal(uncertain.begin(), original); uncertain.failed(original, new LocalApiError('PARTICIPANT_UNAVAILABLE', 409));
    assert.equal(uncertain.operation, original); assert.equal(uncertain.compare(true), false); assert(!uncertain.error.includes('PRIVATE-RAW'));
  }
});

test('late failures cannot alter another pending command and definitive eligibility failures permit explicit correction', () => {
  for (const error of ['PARTICIPANT_UNAVAILABLE', 'HISTORY_CHOICE_REQUIRED', 'SEQUENCE_LIMIT', 'SCHEDULE_CONFLICT']) {
    const draft = confirmed(relationshipDraft()), op = draft.begin(); draft.failed({}, new LocalApiError(error, 409)); assert(draft.sending);
    draft.failed(op, new LocalApiError(error, 409)); assert.equal(draft.operation, null); assert(!draft.uncertain);
    assert.equal(draft.values.guardians[0].userId, 'guardian-a');
  }
});

test('markup escapes child identity, user labels and registration input without clinical/private DTO fields', () => {
  const attack = '<img src=x onerror="alert(1)">', draft = relationshipDraft({ childId: attack }); draft.childName = attack;
  draft.members[1].displayName = attack; draft.latest.privateNote = 'PRIVATE-CLINICAL';
  const reg = registrationDraft(); reg.values.name = attack;
  for (const html of [relationshipsMarkup(draft), relationshipSummary(draft.latest, draft.members), registrationMarkup(reg)]) {
    assert(!html.includes('<img')); assert(html.includes('&lt;img')); assert(!html.includes('PRIVATE-CLINICAL'));
    assert(!/data-care-action|data-view="chat"|data-open-room/.test(html));
  }
  const html = relationshipsMarkup(draft); assert(html.includes('data-ops-child-context')); assert(html.includes('과거 공유 소식·자료를 열람할 수 있음을 확인'));
  assert(!html.includes('<option value="manager-a"')); assert(registrationMarkup(reg).includes('maxlength="30"'));
  assert(relationshipSummary(relationships('a', { participants: [] }), []).includes('연결된 사람이 없습니다'));
});

test('history choices disclose therapist clinical history separately from guardian shared news without changing option values', () => {
  const draft = relationshipDraft(), html = relationshipsMarkup(draft);
  const therapist = /<select name="therapistHistory">([\s\S]*?)<\/select>/.exec(html)?.[1];
  const guardian = /<select data-guardian-history="guardian-a">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert(therapist); assert(guardian);
  for (const menu of [therapist, guardian]) assert.deepEqual([...menu.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['preserve', 'from_now', 'all']);
  assert(therapist.includes('이번 연결 이후 소식·치료 기록만')); assert(therapist.includes('이전 소식·치료 기록 전체 공개'));
  assert(guardian.includes('이번 연결 이후 소식만')); assert(guardian.includes('이전 소식 전체 공개'));
  assert(!guardian.includes('치료 기록')); assert(!guardian.includes('비공개 메모'));
  assert(html.includes('치료사 과거 소식·기록 공개 범위')); assert(html.includes('이 보호자의 과거 대화 공개 범위'));
  assert.match(html, /data-therapist-history-notice>치료사에게는 이 범위의 치료 기록과 비공개 메모·참고·첨부도 열람 대상에 포함됩니다\. 보호자는 공유된 소식·자료만 볼 수 있습니다\./);
  assert(html.includes('연결·해제할 사람과 각 소식·기록 공개 범위를 확인했습니다.'));
  assert(html.includes('치료사는 과거 소식·치료 기록(비공개 메모·참고·첨부 포함)을, 보호자는 과거 공유 소식·자료를 열람할 수 있음을 확인했습니다.'));
  assert.equal(draft.values.historyConfirmed, false); assert.equal(draft.values.pastHistoryConfirmed, false);
});

test('history summary names therapist records but not guardian private records and keeps malicious member labels escaped', () => {
  const attack = '<script>PRIVATE_LABEL</script>', directory = members();
  directory.find(member => member.role === 'therapist').displayName = attack;
  directory.find(member => member.role === 'guardian').displayName = attack;
  const data = relationships(); data.participants.forEach(participant => { participant.firstSequence = 1; });
  const rows = [...relationshipSummary(data, directory).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]);
  assert.equal(rows.length, 2); assert(rows[0].startsWith('치료사 ·')); assert(rows[1].startsWith('보호자 ·'));
  assert(rows[0].includes('이전 소식·치료 기록 전체 열람')); assert(rows[1].includes('이전 소식 전체 열람'));
  assert(!rows[1].includes('치료 기록')); assert(!rows[1].includes('비공개 메모'));
  for (const row of rows) { assert(!row.includes('<script>')); assert(row.includes('&lt;script&gt;PRIVATE_LABEL&lt;/script&gt;')); }
  data.participants.forEach(participant => { participant.firstSequence = 9; });
  assert(!relationshipSummary(data, directory).includes('전체 열람'));
  assert.equal((relationshipSummary(data, directory).match(/설정된 연결 시점 이후 열람/g) ?? []).length, 2);
});

test('opening registration rechecks session/list but neither reads nor writes relationship or clinical data', async () => {
  const f = await opened('registration'); assert.equal(f.ui.current().kind, 'registration');
  assert.deepEqual(f.calls.map(([name]) => name), ['session', 'children', 'session', 'children']);
  assert.equal(f.display.form.id, 'operations-registration-form'); assert.equal(f.input('age').value, '');
  assert.equal(f.input('name').value, ''); assert.equal(f.ui.states.size, 0); assert.equal(f.ui.relationshipStates.size, 0);
});

test('opening relationships authenticates then reads current directory and exact relation without clinical/profile detail', async () => {
  const f = await opened(); assert.deepEqual(f.calls.map(([name]) => name), ['session', 'children', 'session', 'children', 'members', 'relationships']);
  assert.equal(f.ui.current().childName, '가상 아이 a'); assert.equal(f.display.form.id, 'operations-relationships-form');
  assert.equal(f.input('therapist').value, 'therapist-a'); assert(f.guardian('guardian-a').checked); assert(!f.guardian('guardian-b').checked);
  assert.equal(f.guardianHistory('guardian-b').value, 'from_now'); assert(f.guardianHistory('guardian-b').disabled);
});

test('new therapist and guardian selections default to from_now and selection/history changes reset both consents', async () => {
  const f = await opened(); confirm(f, true); f.input('therapist').value = 'therapist-b'; f.emit('change');
  assert.equal(f.input('therapistHistory').value, 'from_now'); assert(f.input('therapistHistory').querySelector('[value="preserve"]').disabled);
  assert.equal(f.input('historyConfirmed').checked, false); assert.equal(f.input('pastHistoryConfirmed').checked, false);
  confirm(f, true); f.guardian('guardian-b').checked = true; f.emit('change');
  assert.equal(f.guardianHistory('guardian-b').value, 'from_now'); assert(!f.guardianHistory('guardian-b').disabled);
  assert(!f.input('historyConfirmed').checked); confirm(f, true);
  f.guardianHistory('guardian-b').value = 'all'; f.emit('change');
  assert(!f.input('historyConfirmed').checked); assert(!f.input('pastHistoryConfirmed').checked); assert(!f.control('[data-past-confirm]').hidden);
  confirm(f, true); f.guardian('guardian-a').checked = false; f.emit('change'); assert(!f.input('historyConfirmed').checked);
  assert(f.guardianHistory('guardian-a').disabled);
});

test('all-history choice cannot submit until separate confirmation and no write is issued by input changes', async () => {
  const f = await opened(); f.guardianHistory('guardian-a').value = 'all'; f.emit('change'); confirm(f);
  await f.ui.save(); assert.equal(f.calls.filter(([name]) => name.endsWith('save')).length, 0);
  assert.match(f.control('[data-ops-error]').textContent, /과거|이전/); assert.equal(f.ui.current().operation, null);
  confirm(f, true); await f.ui.save(); assert.equal(f.calls.filter(([name]) => name === 'relationship-save').length, 1);
});

test('registration success is separate from relationship selection and clears only its own draft', async () => {
  const f = await opened('profile'); f.input('name').value = '프로필 초안'; const draft = f.ui.current();
  await f.ui.newChild(); f.input('name').value = '새 가상 아이'; await f.ui.save();
  const calls = f.calls.filter(([name]) => name === 'register'); assert.equal(calls.length, 1);
  assert.equal(f.ui.registration, null); assert.equal(f.ui.mode, 'profile'); assert.equal(f.ui.selected, null);
  assert.equal(f.ui.states.get('room-a'), draft); assert.equal(draft.values.name, '프로필 초안');
  assert.equal(f.calls.filter(([name]) => name === 'relationship-save').length, 0);
  assert(f.notices.some(text => text.includes('담당 관계는 별도로'))); assert(f.display.contentHtml.includes('새 가상 아이'));
});

test('registration unknown retry keeps three UUIDs/content, locks controls and cannot be discarded', async () => {
  const sent = []; const f = await opened('registration', { childRegister: async (center, op) => { sent.push(op); throw new LocalApiError('UNAVAILABLE'); } });
  f.input('name').value = '가상 원본 등록'; await f.ui.save(); const draft = f.ui.current(), op = draft.operation;
  assert.equal(new Set([op.clientId, op.childId, op.conversationId]).size, 3); assert(f.display.center.disabled);
  assert(f.input('name').disabled); assert(f.control('[type="submit"]').hidden); assert(!f.control('[data-ops-action="retry"]').hidden);
  assert(f.control('[data-ops-action="discard"]').disabled); f.ui.discard(); assert.equal(f.ui.registration, draft);
  f.input('name').value = '합성 DOM 변조'; await f.ui.save(); assert.equal(sent[1], op); assert.equal(sent[1].content.name, '가상 원본 등록');
});

test('back during a pending registration aborts observation but preserves original IDs for a later explicit retry', async () => {
  const gate = deferred(), sent = [];
  const f = await opened('registration', { childRegister: async (center, op, signal) => { sent.push({ op, signal }); return gate.promise; } });
  f.input('name').value = '가상 등록'; const saving = f.ui.save(), draft = f.ui.current();
  f.ui.back(); await settled(f.ui); assert(sent[0].signal.aborted); assert(draft.uncertain); assert.equal(f.ui.selected, null);
  gate.resolve({}); await saving; assert.equal(f.ui.registration, draft); assert.equal(f.ui.mode, 'profile');
  await f.ui.newChild(); const op = draft.operation; f.api.childRegister = async (center, next) => { assert.equal(next, op); };
  await f.ui.save(); assert.equal(f.ui.registration, null); assert(f.ui.connected);
});

test('profile, relationship, registration and second-child drafts are independent and only explicit discard removes one', async () => {
  const f = await opened('profile'); f.input('name').value = '프로필 A 입력'; const profileA = f.ui.current();
  await f.ui.open('room-a', 'relationships'); f.guardian('guardian-b').checked = true; f.emit('change'); const relationA = f.ui.current();
  await f.ui.open('room-b', 'relationships'); const relationB = f.ui.current(); assert(!f.guardian('guardian-b').checked);
  await f.ui.newChild(); f.input('name').value = '등록 입력'; const registration = f.ui.current();
  await f.ui.open('room-a'); assert.equal(f.ui.current(), profileA); assert.equal(f.input('name').value, '프로필 A 입력');
  await f.ui.open('room-a', 'relationships'); assert.equal(f.ui.current(), relationA); assert(f.guardian('guardian-b').checked);
  f.ui.discard(); await settled(f.ui); assert(!f.ui.relationshipStates.has('room-a'));
  assert.equal(f.ui.relationshipStates.get('room-b'), relationB); assert.equal(f.ui.states.get('room-a'), profileA); assert.equal(f.ui.registration, registration);
});

test('relationship unknown survives back, stale directory/version and later 409 without changing the request', async () => {
  const sent = []; const f = await opened('relationships', { relationshipsSave: async (c, r, op) => { sent.push(op); throw new LocalApiError('UNAVAILABLE'); } });
  confirm(f); await f.ui.save(); const draft = f.ui.current(), op = draft.operation;
  f.ui.back(); await settled(f.ui); f.directory.splice(0); f.relations.set('room-a', relationships('a', { version: 20, participants: [] }));
  await f.ui.open('room-a', 'relationships'); assert.equal(f.ui.current(), draft); assert.equal(draft.operation, op);
  assert(f.input('therapist').disabled); assert(f.display.center.disabled);
  f.api.relationshipsSave = async (c, r, next) => { sent.push(next); throw new LocalApiError('RELATIONSHIP_CONFLICT', 409); };
  await f.ui.save(); assert.equal(sent[1], op); assert.equal(op.expectedVersion, 3); assert.equal(draft.operation, op); assert(draft.uncertain);
  f.ui.compare(false); assert.equal(draft.operation, op);
});

test('first relationship conflict preserves input, waits for fresh latest, then explicitly keeps or replaces without autosave', async () => {
  for (const keep of [true, false]) {
    const f = await opened('relationships', { relationshipsSave: async () => { throw new LocalApiError('RELATIONSHIP_CONFLICT', 409); } });
    confirm(f); await f.ui.save(); const draft = f.ui.current(); assert.equal(draft.operation, null); assert(draft.stale);
    assert(f.control('[type="submit"]').disabled); assert(f.control('[data-ops-conflict]').innerHTML.includes('최신 내용을 먼저'));
    f.relations.set('room-a', relationships('a', { version: 12, participants: [] })); await f.ui.refresh();
    assert.equal(draft.revision, 3); assert.equal(f.input('therapist').value, 'therapist-a');
    f.ui.compare(keep); assert.equal(draft.revision, 12); assert.equal(draft.operation, null); assert(!draft.stale);
    assert.equal(draft.values.therapist?.history ?? null, keep ? 'from_now' : null);
    assert(!draft.values.historyConfirmed); assert(!draft.values.pastHistoryConfirmed);
  }
});

test('unchanged relationship polls preserve exact form/control nodes and do not force heading focus', async () => {
  const f = await opened(), form = f.display.form; confirm(f); const input = f.input('historyConfirmed'), focusCount = f.display.focused;
  await f.ui.refresh(); await f.ui.refresh(); assert.equal(f.display.form, form); assert.equal(f.input('historyConfirmed'), input);
  assert(input.checked); assert.equal(f.display.focused, focusCount); assert.equal(f.ui.current().revision, 3);
});

test('directory loss preserves selected unavailable users and resets consent visibly without silently removing a relation', async () => {
  const f = await opened(); confirm(f, true); f.directory.splice(f.directory.findIndex(member => member.userId === 'guardian-a'), 1);
  await f.ui.refresh(); assert(f.guardian('guardian-a').checked); assert(f.display.contentHtml.includes('현재 선택 불가'));
  assert(!f.input('historyConfirmed').checked); assert(!f.input('pastHistoryConfirmed').checked);
  assert.equal(f.ui.current().values.guardians[0].userId, 'guardian-a');
  assert.equal(f.calls.filter(([name]) => name === 'relationship-save').length, 0);
});

test('latest comparison controls are not recreated on unchanged stale polls', async () => {
  const f = await opened(); f.relations.set('room-a', relationships('a', { version: 5 })); await f.ui.refresh();
  const form = f.display.form, comparison = f.control('[data-ops-conflict]'); let replacements = 0, html = comparison.innerHTML;
  Object.defineProperty(comparison, 'innerHTML', { get: () => html, set: value => { html = value; replacements++; } });
  await f.ui.refresh(); assert.equal(f.display.form, form); assert.equal(f.control('[data-ops-conflict]'), comparison); assert.equal(replacements, 0);
});

test('cross-child relation response fails closed and does not display its target or create a draft', async () => {
  const f = await opened('relationships', { relationships: async () => relationships('a', { childId: 'child-b' }) });
  assert.equal(f.ui.connected, false); assert.equal(f.display.form, null); assert.equal(f.ui.relationshipStates.size, 0);
  assert(!f.display.contentHtml.includes('child-b')); assert(!f.ui.destroyed);
});

test('late relationship lookup after back cannot re-open the editor or insert its draft', async () => {
  const f = fixture(), gate = deferred(); await f.ui.refresh(); let signal;
  f.api.relationships = async (c, r, next) => { signal = next; return gate.promise; };
  const opening = f.ui.open('room-a', 'relationships'); await until(() => signal);
  f.ui.back(); await settled(f.ui); assert(signal.aborted); gate.resolve(relationships()); await opening;
  assert.equal(f.ui.mode, 'profile'); assert.equal(f.ui.selected, null); assert.equal(f.ui.relationshipStates.size, 0); assert.equal(f.display.form, null);
});

test('late registration and relationship callbacks after destroy cannot restore cleared private selection', async () => {
  for (const mode of ['registration', 'relationships']) {
    const f = await opened(mode), gate = deferred(); let signal;
    if (mode === 'registration') { f.input('name').value = '가상 늦은 등록'; f.api.childRegister = async (c, op, next) => { signal = next; return gate.promise; }; }
    else { confirm(f); f.api.relationshipsSave = async (c, r, op, next) => { signal = next; return gate.promise; }; }
    const writing = f.ui.save(); f.ui.destroy(); assert(signal.aborted); gate.resolve({}); await writing;
    assert.equal(f.display.html, ''); assert.equal(f.ui.registration, null); assert.equal(f.ui.relationshipStates.size, 0); assert.equal(f.ui.states.size, 0);
    assert.equal(f.ui.children.length, 0); assert.equal(f.ui.selected, null);
  }
});

for (const change of ['account', 'role', 'missing-center']) test(`${change} detected at refresh clears all three draft families before any data read`, async () => {
  const f = await opened('profile'); f.input('name').value = '가상 프로필 입력';
  await f.ui.open('room-a', 'relationships'); confirm(f); await f.ui.newChild(); f.input('name').value = '가상 등록 입력';
  if (change === 'account') f.user.userId = 'manager-b';
  else if (change === 'role') f.user.centers[0].role = 'guardian';
  else f.user.centers.splice(0, 1);
  const start = f.calls.length; await f.ui.refresh(); assert.deepEqual(f.calls.slice(start).map(([name]) => name), ['session']);
  assert(f.ui.destroyed); assert.equal(f.denied.length, 1); assert.equal(f.display.html, ''); assert.equal(f.ui.registration, null);
  assert.equal(f.ui.states.size, 0); assert.equal(f.ui.relationshipStates.size, 0);
});

test('permission denial during relation write destroys all drafts, while transient reads hide UI and preserve editable input', async () => {
  const f = await opened(); confirm(f); f.api.relationshipsSave = async () => { throw new LocalApiError('NOT_FOUND', 404); };
  await f.ui.save(); assert(f.ui.destroyed); assert.equal(f.denied.length, 1); assert.equal(f.ui.relationshipStates.size, 0);
  const transient = await opened(); transient.guardian('guardian-b').checked = true; transient.emit('change'); const draft = transient.ui.current();
  const original = transient.api.members; transient.api.members = async () => { throw new Error('PRIVATE-RAW'); };
  await transient.ui.refresh(); assert.equal(transient.display.form, null); assert(!transient.ui.connected); assert.equal(transient.ui.current(), draft);
  assert(draft.values.guardians.some(p => p.userId === 'guardian-b')); assert(!transient.notices.join().includes('PRIVATE-RAW'));
  transient.api.members = original; await transient.ui.refresh(); assert(transient.guardian('guardian-b').checked);
});

test('suspend hides DOM and aborts reads while retaining memory; re-entry authenticates and does not autowrite', async () => {
  const f = await opened(); f.guardian('guardian-b').checked = true; f.emit('change'); const draft = f.ui.current();
  f.ui.suspend(); assert.equal(f.display.form, null); assert.equal(f.ui.children.length, 0); assert.equal(f.ui.current(), draft);
  const offset = f.calls.length; await f.ui.refresh(); assert.equal(f.calls[offset][0], 'session'); assert(f.guardian('guardian-b').checked);
  assert.equal(f.calls.filter(([name]) => name.endsWith('save')).length, 0);
});

test('pending relationship blocks center changes even from list and first definite rejection unlocks explicit correction', async () => {
  const f = await opened('relationships', { relationshipsSave: async () => { throw new LocalApiError('PARTICIPANT_UNAVAILABLE', 409); } });
  confirm(f); await f.ui.save(); assert.equal(f.ui.current().operation, null); assert(!f.input('therapist').disabled); assert(!f.display.center.disabled);
  f.api.relationshipsSave = async () => { throw new LocalApiError('UNAVAILABLE'); }; await f.ui.save();
  f.ui.back(); await settled(f.ui); assert(f.display.center.disabled);
  const listener = f.display.center.listeners.find(listener => listener.type === 'change'); listener.handler({ target: { value: 'center-b' } });
  assert.deepEqual(f.centerChanges, []);
});

test('profile saving still uses its original endpoint and cannot save or clear another relationship draft', async () => {
  const f = await opened(); f.guardian('guardian-b').checked = true; f.emit('change'); const relation = f.ui.current();
  await f.ui.open('room-a'); f.input('name').value = '가상 기본정보 수정'; await f.ui.save();
  assert.equal(f.calls.filter(([name]) => name === 'profile-save').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'register' || name === 'relationship-save').length, 0);
  assert.equal(f.ui.relationshipStates.get('room-a'), relation); assert(relation.values.guardians.some(p => p.userId === 'guardian-b'));
  assert.equal(f.profiles.get('room-a').name, '가상 기본정보 수정');
});

test('refresh is single-flight and events capture the new forms without creating background mutations', async () => {
  const f = await opened('registration'); f.input('name').value = '가상 입력 이벤트'; f.emit('input');
  assert.equal(f.ui.current().values.name, '가상 입력 이벤트'); const gate = deferred(); let count = 0;
  f.api.children = async () => { count++; return gate.promise; };
  const refresh = f.ui.refresh(); await until(() => count === 1); await f.ui.refresh(); assert.equal(count, 1);
  gate.resolve(clone([...f.profiles.values()])); await refresh;
  assert.equal(f.calls.filter(([name]) => name === 'register').length, 0);
  f.emit('submit'); await until(() => f.calls.some(([name]) => name === 'register'));
  await until(() => f.ui.registration === null && f.ui.connected && f.ui.pending === null);
});
