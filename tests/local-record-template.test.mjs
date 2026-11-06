// Pure helpers and controller/DOM doubles only. These tests do not establish
// browser, HTTP, database, native storage, or clinical-user acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CareUi, CareMutation, careRecordTemplate, careRecordContent } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

const goals = () => [{ id: 'synthetic-goal', revision: 2, title: '가상 목표' }];
const row = (extra = {}) => ({ tool: ' ROM ', item: ' 가상 각도 ', unit: ' 도 ', context: ' 가상 조건 ', value: 0, ...extra });
const sourceRecord = (extra = {}) => ({ id: 'synthetic-record', conversationId: 'synthetic-room', revision: 7,
  date: '2000-01-01', title: 'DO-NOT-COPY-TITLE', goalId: 'synthetic-goal', status: 'saved', format: 'structured',
  performed: 'DO-NOT-COPY-PERFORMED', response: 'DO-NOT-COPY-RESPONSE', nextPlan: 'DO-NOT-COPY-PLAN',
  summary: 'DO-NOT-COPY-SUMMARY', privateNote: 'DO-NOT-COPY-PRIVATE',
  observation: { status: 'observed', task: 'DO-NOT-COPY-OBSERVATION' }, assessments: [row(), row({ tool: 'MMT', value: 3 })],
  assessment: row({ value: 99 }), activity: { title: 'DO-NOT-COPY-ACTIVITY' },
  appointmentId: 'DO-NOT-COPY-APPOINTMENT', appointmentRevision: 4,
  attachments: [{ id: 'DO-NOT-COPY-FILE', name: 'DO-NOT-COPY-NAME', share: true }], attachmentCount: 1,
  referenceMessageIds: ['DO-NOT-COPY-REFERENCE'], referenceSources: [{ feedbackId: 'DO-NOT-COPY-FEEDBACK', feedbackRevision: 1 }],
  ...extra });
const context = () => ({ user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1,
  signal: new AbortController().signal, profile: { participants: [] }, messages: [] });
const pending = () => { const value = Promise.withResolvers(); value.promise.catch(() => {}); return value; };
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function fixture(api = {}) {
  let current = context(), html = '', open = false, unavailable = 0;
  const errors = [], displayed = [], reads = [];
  const ui = new CareUi({ api: { record: async (...args) => { reads.push(args); return sourceRecord(); }, ...api },
    getContext: () => current, onSourceUnavailable: () => { unavailable++; } });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  const state = { mutation: new CareMutation(() => 'synthetic-request'), records: [{ id: 'synthetic-record', revision: 7 }],
    goals: goals(), appointments: [], loaded: true, loading: false, view: null };
  ui.states.set(ui.key, state);
  ui.dialog = { get open() { return open; }, querySelector: () => null, querySelectorAll: () => [], remove() {} };
  ui.form = (title, kind, body) => { html = body; open = true; displayed.push({ title, kind }); };
  ui.wipeDialog = () => { html = ''; open = false; };
  ui.snapshot = () => {}; ui.fail = error => errors.push(error.code ?? error.message);
  return { ui, state, reads, errors, displayed, get current() { return current; },
    get html() { return html; }, get open() { return open; }, get unavailable() { return unavailable; },
    setContext(value) { current = value; } };
}

test('template returns only current goal and blank-valued measurement metadata; every prior clinical value is excluded', () => {
  const source = deepFreeze(sourceRecord()), original = JSON.stringify(source), options = deepFreeze(goals());
  const result = careRecordTemplate(source, options);
  assert.deepEqual(result, { goalId: 'synthetic-goal', assessments: [
    { tool: 'ROM', item: '가상 각도', unit: '도', context: '가상 조건', value: '' },
    { tool: 'MMT', item: '가상 각도', unit: '도', context: '가상 조건', value: '' },
  ] });
  assert.equal(JSON.stringify(source), original); assert(!JSON.stringify(result).includes('DO-NOT-COPY'));
  result.assessments[0].item = 'new'; assert.equal(source.assessments[0].item, ' 가상 각도 ');
});

test('template does not even read old measurement values or non-allowlisted sensitive getters', () => {
  const measurement = row(); Object.defineProperty(measurement, 'value', { get() { assert.fail('Prior clinical value must not be read.'); } });
  const source = { goalId: 'synthetic-goal', assessments: [measurement] };
  for (const key of ['privateNote', 'summary', 'observation', 'attachments', 'referenceSources', 'appointmentId', 'assessment'])
    Object.defineProperty(source, key, { get() { assert.fail(`Not allowlisted: ${key}`); } });
  assert.equal(careRecordTemplate(source, goals()).assessments[0].value, '');
});

test('absent or no-longer-available goal is blank, never replaced with the first current goal', () => {
  for (const list of [undefined, [], [{ id: 'other-goal', revision: 1 }]])
    assert.equal(careRecordTemplate(sourceRecord(), list).goalId, '');
  assert.equal(careRecordTemplate(sourceRecord({ goalId: '' }), goals()).goalId, '');
});

test('draft metadata rules preserve twenty rows and blank metadata without inventing a result', () => {
  const source = sourceRecord({ assessments: Array.from({ length: 20 }, () => row({ tool: '', item: ' ', unit: '', context: '' })) });
  const template = careRecordTemplate(source, goals()); assert.equal(template.assessments.length, 20);
  for (const value of template.assessments) assert.deepEqual(value, { tool: '', item: '', unit: '', context: '', value: '' });
  assert.deepEqual(careRecordTemplate(sourceRecord({ assessments: [] }), goals()).assessments, []);
});

test('malformed records, goal IDs, rows and oversized metadata fail closed; singular legacy assessment is not guessed', () => {
  for (const list of [null, {}, 'goals']) assert.throws(() => careRecordTemplate(sourceRecord(), list));
  for (const source of [null, undefined, [], 'record', { ...sourceRecord(), goalId: null }, { ...sourceRecord(), goalId: 4 },
    { ...sourceRecord(), assessments: undefined }, { ...sourceRecord(), assessments: null }, { ...sourceRecord(), assessments: {} },
    { ...sourceRecord(), assessments: 'rows' }, { goalId: 'synthetic-goal', assessment: row() }]) assert.throws(() => careRecordTemplate(source, goals()));
  for (const invalid of [null, undefined, [], 0, {}, row({ tool: null }), row({ item: 1 }), row({ unit: [] }), row({ context: {} }),
    row({ tool: 'x'.repeat(101) }), row({ item: 'x'.repeat(101) }), row({ unit: 'x'.repeat(101) }), row({ context: 'x'.repeat(301) })])
    assert.throws(() => careRecordTemplate(sourceRecord({ assessments: [invalid] }), goals()));
  assert.throws(() => careRecordTemplate(sourceRecord({ assessments: Array.from({ length: 21 }, () => row()) }), goals()));
});

test('reuse exact-reads the selected listed revision, creates a new UUID and keeps all clinical fields empty even in quarantine mode', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T15:00:00Z') });
  const f = fixture({ feedback: () => assert.fail('References must not be read.'), appointment: () => assert.fail('Schedule must not be read.') });
  await f.ui.handleAction('reuse-record', 'synthetic-record');
  const view = f.state.view;
  assert.deepEqual(f.reads, [[f.current.centerId, f.current.roomId, 'synthetic-record', f.current.signal, 7]]);
  assert.equal(view.kind, 'record'); assert.equal(view.expectedRevision, 0);
  assert.match(view.recordId, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  assert.notEqual(view.recordId, 'synthetic-record');
  assert.deepEqual(view.templateSource, { recordId: 'synthetic-record', revision: 7 });
  assert.equal(view.values.date, '2027-01-01'); assert.equal(view.values.title, '');
  for (const field of ['performed', 'response', 'nextPlan', 'summary', 'privateNote']) assert.equal(view.values[field], '', field);
  assert.equal(view.values.observation, null); assert.equal(view.values.activity, null); assert.deepEqual(view.references, []);
  for (const field of ['attachments', 'appointmentId', 'appointmentRevision', 'referenceSources', 'referenceMessageIds']) assert.equal(Object.hasOwn(view.values, field), false, field);
  assert.equal(view.expectedAppointmentRevision, undefined); assert.equal(view.appointment, undefined);
  assert.deepEqual(view.values.assessments, careRecordTemplate(sourceRecord(), goals()).assessments);
  assert(!f.html.includes('DO-NOT-COPY')); assert.equal(f.errors.length, 0);
  const draft = careRecordContent(view.values, 'draft', view.references);
  assert.equal(draft.assessments[0].value, null); assert.deepEqual(draft.referenceMessageIds, []);
  assert.throws(() => careRecordContent(view.values, 'saved', view.references), 'Blank copied measurements must not weaken saved-record validation.');
});

test('missing template goal requires explicit selection instead of keeping the new-record default goal', async () => {
  const f = fixture({ record: async () => sourceRecord({ goalId: 'retired-goal' }) });
  await f.ui.handleAction('reuse-record', 'synthetic-record'); assert.equal(f.state.view.values.goalId, '');
});

test('reuse requires therapist, loaded goals and a listed positive revision before any source lookup', async () => {
  for (const mode of ['guardian', 'center', 'not-loaded', 'no-goals', 'missing-record', 'missing-revision', 'zero', 'negative', 'fraction', 'string', 'overflow']) {
    const f = fixture();
    if (['guardian', 'center'].includes(mode)) f.current.user.centers[0].role = mode;
    if (mode === 'not-loaded') f.state.loaded = false;
    if (mode === 'no-goals') f.state.goals = [];
    if (mode === 'missing-record') f.state.records = [];
    const invalid = { 'missing-revision': undefined, zero: 0, negative: -1, fraction: 1.5, string: '7', overflow: 2147483648 };
    if (Object.hasOwn(invalid, mode)) f.state.records[0].revision = invalid[mode];
    await f.ui.handleAction('reuse-record', 'synthetic-record');
    assert.equal(f.reads.length, 0, mode); assert.equal(f.state.view, null, mode); assert.equal(f.displayed.length, 0, mode);
  }
});

test('source identity, room and exact revision mismatches never open a template', async () => {
  for (const mismatch of [{ id: 'other-record' }, { conversationId: 'other-room' }, { revision: 8 }, { revision: '7' }]) {
    const f = fixture({ record: async () => sourceRecord(mismatch) });
    await f.ui.handleAction('reuse-record', 'synthetic-record'); assert.equal(f.state.view, null); assert.equal(f.displayed.length, 0);
    assert(f.errors.length > 0);
  }
});

test('existing drafts route only through restoreView and cannot be overwritten by another template action', async () => {
  const f = fixture(); const existing = f.ui.newRecord(f.state); existing.values.performed = 'NEW-USER-INPUT'; f.state.view = existing;
  let restores = 0; f.ui.restoreView = async (context, state) => { restores++; assert.equal(context, f.current); assert.equal(state.view, existing); };
  await f.ui.handleAction('reuse-record', 'synthetic-record');
  assert.equal(restores, 1); assert.equal(f.reads.length, 0); assert.equal(f.state.view, existing); assert.equal(existing.values.performed, 'NEW-USER-INPUT');
});

test('unknown save remains the same immutable receipt and does not fetch or create another template', async () => {
  const f = fixture(); f.state.view = f.ui.newRecord(f.state);
  const operation = f.state.mutation.begin('record', f.state.view.recordId, { expectedRevision: 0, content: { privateNote: 'UNACKNOWLEDGED' } });
  f.state.mutation.failed(operation);
  await f.ui.handleAction('reuse-record', 'synthetic-record');
  assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.view.kind, 'receipt'); assert.equal(f.reads.length, 0);
  assert(!f.html.includes('UNACKNOWLEDGED'));
});

test('duplicate pending template actions share opening ownership and never create a second form', async () => {
  const gate = pending(); let reads = 0; const f = fixture({ record: async () => { reads++; return gate.promise; } });
  const first = f.ui.handleAction('reuse-record', 'synthetic-record'); await f.ui.handleAction('reuse-record', 'synthetic-record');
  assert.equal(reads, 1); gate.resolve(sourceRecord()); await first; assert.equal(f.displayed.length, 1);
});

for (const lost of ['loaded-state', 'goals']) {
  test(`a pending template lookup cannot open after authorized ${lost} is removed from the same context`, async () => {
    const gate = pending(), f = fixture({ record: async () => gate.promise });
    const action = f.ui.handleAction('reuse-record', 'synthetic-record');
    if (lost === 'loaded-state') f.state.loaded = false;
    else f.state.goals = [];
    gate.resolve(sourceRecord()); await action;
    assert.equal(f.state.view, null); assert.equal(f.displayed.length, 0);
    assert(f.errors.includes(lost === 'loaded-state' ? 'CONTEXT_LOADING' : 'CONTEXT_NOT_FOUND'));
    assert.equal(f.state.opening, null);
  });
}

test('late template responses cannot apply across room, account, generation or suspended context changes', async () => {
  for (const mode of ['room', 'account', 'generation', 'suspend', 'abort']) {
    const gate = pending(), f = fixture({ record: async () => gate.promise }), abort = new AbortController();
    f.setContext({ ...f.current, signal: abort.signal });
    const action = f.ui.handleAction('reuse-record', 'synthetic-record');
    if (mode === 'room') f.setContext({ ...f.current, roomId: 'other-room' });
    if (mode === 'account') f.setContext({ ...f.current, user: { ...f.current.user, userId: 'other-therapist' } });
    if (mode === 'generation') f.setContext({ ...f.current, generation: 2 });
    if (mode === 'suspend') f.ui.suspend();
    if (mode === 'abort') abort.abort();
    gate.resolve(sourceRecord()); await action;
    assert.equal(f.state.view, null, mode); assert.equal(f.displayed.length, 0, mode);
  }
});

test('new template draft permission checks exact source revision without replacing its edited fields', async () => {
  const f = fixture(); await f.ui.handleAction('reuse-record', 'synthetic-record');
  const view = f.state.view; view.values.performed = 'NEW-USER-INPUT'; view.values.assessments[0].value = '12';
  f.state.records[0].revision = 9;
  assert.equal(await f.ui.guardView(f.current), true); assert.equal(f.state.view, view);
  assert.equal(view.values.performed, 'NEW-USER-INPUT'); assert.equal(view.values.assessments[0].value, '12');
  assert.deepEqual(f.reads.at(-1), [f.current.centerId, f.current.roomId, 'synthetic-record', f.current.signal, 7]);
});

test('confirmed template source denial clears the dependent draft, closes its form and notifies the owner', async () => {
  for (const denial of ['NOT_FOUND', 'FORBIDDEN', 'wrong-revision']) {
    const f = fixture(); await f.ui.handleAction('reuse-record', 'synthetic-record');
    f.state.view.values.performed = 'UNSAVED-TEMPLATE-INPUT'; f.ui.display();
    f.ui.api.record = async () => { if (denial === 'wrong-revision') return sourceRecord({ revision: 8 }); throw new LocalApiError(denial, 404); };
    assert.equal(await f.ui.guardView(f.current), false);
    assert.equal(f.state.view, null, denial); assert.equal(f.html, '', denial); assert.equal(f.open, false, denial); assert.equal(f.unavailable, 1, denial);
  }
});

test('transient template source check failure removes DOM but keeps the same draft only in memory', async () => {
  const f = fixture(); await f.ui.handleAction('reuse-record', 'synthetic-record'); const view = f.state.view;
  f.ui.api.record = async () => { throw new LocalApiError('UNAVAILABLE'); };
  assert.equal(await f.ui.guardView(f.current), false); assert.equal(f.state.view, view);
  assert.equal(f.html, ''); assert.equal(f.open, false); assert.equal(f.unavailable, 0); assert(f.errors.includes('SOURCE_CHECK_UNAVAILABLE'));
});

test('once independently saved, record read authority takes precedence over the former template source', async () => {
  const f = fixture(); await f.ui.handleAction('reuse-record', 'synthetic-record');
  const view = f.state.view; view.expectedRevision = 1; const calls = [];
  f.ui.api.record = async (...args) => { calls.push(args); return { id: view.recordId, conversationId: f.current.roomId, revision: 1 }; };
  assert.equal(await f.ui.guardView(f.current), true);
  assert.deepEqual(calls, [[f.current.centerId, f.current.roomId, view.recordId, f.current.signal]]);
  assert.equal(f.state.view, view);
});
