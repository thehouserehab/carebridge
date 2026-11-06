import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareUi, CareMutation, groupCareMeasurements, careMeasurementMarkup } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

// Pure rendering/controller doubles only. No browser, API, database, real
// clinical data, native process, or measurement interpretation is exercised.
const row = (extra = {}) => ({ recordId: 'synthetic-record', recordRevision: 1,
  date: '2026-10-09', title: '가상 기록', goalId: 'synthetic-goal', goalTitle: '가상 목표',
  ordinal: 0, tool: 'ROM', item: '가상 항목', value: 0, unit: '도', context: '가상 조건', ...extra });
const record = (extra = {}) => ({ id: 'synthetic-record', revision: 1, status: 'saved',
  date: '2026-10-09', title: '가상 기록', ...extra });
const context = () => ({ user: { userId: 'synthetic-therapist',
  centers: [{ id: 'synthetic-center', role: 'therapist' }] }, centerId: 'synthetic-center',
  roomId: 'synthetic-room', roomRevision: 7, panelMode: 'full', connected: true,
  generation: 1, signal: new AbortController().signal,
  careData: { records: [record()], goals: [], appointments: [] } });
const result = (measurements = [row()], revision = 7) => ({ revision, measurements });
const deferred = () => Promise.withResolvers();
function host() {
  return { innerHTML: '', ownerDocument: { activeElement: null }, contains: () => false,
    querySelectorAll: () => [], replaceChildren() { this.innerHTML = ''; } };
}
function controller(api, callbacks = {}) {
  let current = context();
  const ui = new CareUi({ api, getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  ui.owner = current.user.userId; ui.ownerRole = 'therapist'; ui.host = host();
  const state = { mutation: new CareMutation(() => 'synthetic-request'), records: [record()],
    goals: [], appointments: [], loaded: true, loading: false, view: null };
  ui.states.set(ui.key, state);
  return { ui, state, get current() { return current; }, setContext(next) { current = next; } };
}
const loaded = (measurements = [row()]) => ({ loaded: true, groups: groupCareMeasurements(measurements) });

test('groups use exactly goal/tool/item/unit/context, not titles, dates, record IDs or revisions', () => {
  const original = row();
  const alternatives = ['goalId', 'tool', 'item', 'unit', 'context'].map((key) => row({ [key]: `${original[key]}-different` }));
  const rows = [original, row({ recordId: 'synthetic-other', recordRevision: 3,
    date: '2026-10-10', title: '다른 기록', goalTitle: '다른 당시 목표', ordinal: 1 }), ...alternatives];
  const groups = groupCareMeasurements(rows);
  assert.equal(groups.length, 6); assert.equal(groups[0].measurements.length, 2);
  assert.deepEqual(JSON.parse(groups[0].key), [original.goalId, original.tool, original.item, original.unit, original.context]);
  assert.equal(groupCareMeasurements([row({ tool: 'a,b', item: 'c' }), row({ tool: 'a', item: 'b,c' })]).length, 2);
});

test('dates are chronological and equal dates retain server order including repeated measurement rows', () => {
  const rows = [row({ date: '2026-10-11', value: 11 }), row({ ordinal: 2, value: 2 }),
    row({ ordinal: 0, value: 0 }), row({ ordinal: 1, value: 1 }),
    row({ date: '2026-10-08', recordId: 'synthetic-earlier', value: -1 })];
  const before = structuredClone(rows), [group] = groupCareMeasurements(rows);
  assert.deepEqual(group.measurements.map((entry) => entry.value), [-1, 2, 0, 1, 11]);
  assert.deepEqual(group.measurements.slice(1, 4).map((entry) => entry.ordinal), [2, 0, 1]);
  assert.deepEqual(rows, before);
});

test('finite zero and negative values remain, while blank or incomplete measurements are excluded', () => {
  const incomplete = [null, undefined, ...[null, '', '0', NaN, Infinity, -Infinity].map((value) => row({ value })),
    ...['tool', 'item', 'unit', 'context'].flatMap((key) => [row({ [key]: '' }), row({ [key]: '   ' }), row({ [key]: null })])];
  const groups = groupCareMeasurements([...incomplete, row(), row({ ordinal: 1, value: -2.5 })]);
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].measurements.map((entry) => entry.value), [0, -2.5]);
  assert.deepEqual(groupCareMeasurements(incomplete), []);
});

test('historical goal titles stay on individual rows and absent historical titles never become current goal text', () => {
  const groups = groupCareMeasurements([row({ goalTitle: null }), row({ date: '2026-10-10', goalTitle: '당시 바뀐 목표' })]);
  assert.equal(groups.length, 1); assert.equal(groups[0].goalTitle, '당시 바뀐 목표');
  assert.deepEqual(groups[0].measurements.map((entry) => entry.goalTitle), [null, '당시 바뀐 목표']);
  assert.match(careMeasurementMarkup({ loaded: true, groups }), /당시 목표 · 제목 미보존/);
  assert.match(careMeasurementMarkup(loaded([row({ goalTitle: null })])), /제목이 보존되지 않은 이전 목표/);
});

test('group projection retains only measurement metadata and copies rows without private source references', () => {
  const source = row({ body: 'PRIVATE-BODY', privateNote: 'PRIVATE-NOTE', attachments: [{ name: 'PRIVATE-FILE' }],
    observed: { secret: 'PRIVATE-OBSERVED' } });
  const [group] = groupCareMeasurements([source]);
  assert.deepEqual(Object.keys(group).sort(), ['key', 'goalId', 'goalTitle', 'tool', 'item', 'unit', 'context', 'measurements'].sort());
  assert.deepEqual(Object.keys(group.measurements[0]).sort(), ['recordId', 'recordRevision', 'date', 'title', 'goalTitle', 'ordinal', 'value'].sort());
  source.title = 'MUTATED'; source.value = 99; source.context = 'MUTATED';
  assert.equal(group.measurements[0].title, '가상 기록'); assert.equal(group.measurements[0].value, 0);
  assert.equal(group.context, '가상 조건'); assert(!JSON.stringify(group).includes('PRIVATE-'));
});

test('measurement markup escapes content and exposes dates, zero, row identity and explicit non-interpretation', () => {
  const html = careMeasurementMarkup(loaded([row({ item: '<script>synthetic</script>', title: '<b>가상</b>',
    tool: 'ROM & synthetic', goalTitle: '<목표>', context: '"조건"', recordId: 'synthetic-"quoted' })]));
  for (const expected of ['<time>2026-10-09</time>', 'data-measurement-value>0 도', 'data-record-revision="1"',
    'data-measurement-ordinal="0"', '1개 측정값 · 1개 조건', '&lt;script&gt;', '&lt;b&gt;', '&amp;', '&quot;',
    '자동 점수 산정이나 임상 해석은 제공하지 않습니다.']) assert(html.includes(expected), expected);
  assert(!html.includes('<script>')); assert(!html.includes('<b>')); assert(!html.includes('<목표>'));
});

test('loading, failure and empty-result markup distinguish incomplete reads from a complete empty comparison', () => {
  const loadingHtml = careMeasurementMarkup({ loading: true, loaded: false, groups: loaded().groups });
  assert.match(loadingHtml, /role="status"/); assert.match(loadingHtml, /compare-records[^>]*disabled/);
  assert(!loadingHtml.includes('data-measurement-row')); assert(!loadingHtml.includes('data-comparison-count'));
  const failed = careMeasurementMarkup({ loaded: false, groups: [], notice: '<실패>' });
  assert.match(failed, /data-comparison-notice>&lt;실패&gt;/); assert(!failed.includes('0개 측정값'));
  const empty = careMeasurementMarkup({ loaded: true, groups: [] });
  assert.match(empty, /0개 측정값 · 0개 조건/); assert.match(empty, /비교할 정식 측정값이 아직 없습니다/);
  assert.match(careMeasurementMarkup(null), /data-care-action="compare-records"/);
  assert(!careMeasurementMarkup(null).includes('clear-comparison'));
});

test('complete comparison loads with no current goals and calls only the scoped read API', async () => {
  const calls = [], fixture = controller({ recordMeasurements: async (...args) => { calls.push(args); return result(); } });
  fixture.ui.render(); assert.match(fixture.ui.host.innerHTML, /data-care-action="compare-records"/);
  await fixture.ui.handleAction('compare-records');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 2), ['synthetic-center', 'synthetic-room']);
  assert(calls[0][2] instanceof AbortSignal); assert.equal(fixture.state.comparison.revision, 7);
  assert.equal(fixture.state.comparison.loaded, true); assert.equal(fixture.state.comparison.loading, false);
  assert.equal(fixture.state.comparison.controller, null); assert.equal(fixture.state.goals.length, 0);
  assert.match(fixture.ui.host.innerHTML, /data-measurement-value>0 도/);
});

test('one pending complete read is deduplicated and renders no rows until its final response', async () => {
  const gate = deferred(); let calls = 0;
  const fixture = controller({ recordMeasurements: () => { calls++; return gate.promise; } });
  const pending = fixture.ui.handleAction('compare-records');
  await fixture.ui.handleAction('compare-records');
  assert.equal(calls, 1); assert.equal(fixture.state.comparison.loading, true);
  assert(!fixture.ui.host.innerHTML.includes('data-measurement-row'));
  gate.resolve(result([row(), row({ ordinal: 1, value: 3 })])); await pending;
  assert.equal(fixture.state.comparison.groups[0].measurements.length, 2);
  assert.match(fixture.ui.host.innerHTML, /2개 측정값 · 1개 조건/);
});

test('explicit refresh releases prior groups immediately and cannot display prior results while loading', async () => {
  const gate = deferred(); let calls = 0;
  const fixture = controller({ recordMeasurements: () => ++calls === 1 ? Promise.resolve(result()) : gate.promise });
  await fixture.ui.handleAction('compare-records'); const previous = fixture.state.comparison;
  const pending = fixture.ui.handleAction('compare-records');
  assert.deepEqual(previous.groups, []); assert.notEqual(fixture.state.comparison, previous);
  assert(!fixture.ui.host.innerHTML.includes('data-measurement-row'));
  gate.resolve(result([row({ value: 5 })])); await pending;
  assert.equal(fixture.state.comparison.groups[0].measurements[0].value, 5);
});

test('network, oversized and malformed complete results fail safely without partial rows or raw error content', async () => {
  for (const failure of [new Error('PRIVATE-TRANSPORT'), new LocalApiError('TOO_MUCH_DATA'),
    { revision: -1, measurements: [row()] }, { revision: 7, measurements: null }]) {
    const fixture = controller({ recordMeasurements: async () => {
      if (failure instanceof Error) throw failure; return failure;
    } });
    await fixture.ui.handleAction('compare-records');
    assert.equal(fixture.state.comparison.loaded, false); assert.equal(fixture.state.comparison.loading, false);
    assert.deepEqual(fixture.state.comparison.groups, []); assert.equal(fixture.state.comparison.controller, null);
    assert.match(fixture.ui.host.innerHTML, /일부 결과는 표시하지 않았습니다/);
    assert(!fixture.ui.host.innerHTML.includes('data-measurement-row')); assert(!fixture.ui.host.innerHTML.includes('PRIVATE-'));
    if (failure.code === 'TOO_MUCH_DATA') assert.match(fixture.ui.host.innerHTML, /한 번에 비교할 수 있는 범위를 넘었어요/);
  }
});

test('authentication or relationship denial discards comparison and all authorized care state', async () => {
  for (const code of ['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN']) {
    const errors = [], fixture = controller({ recordMeasurements: async () => { throw new LocalApiError(code, 401); } },
      { onError: (error) => errors.push(error.code) });
    await fixture.ui.handleAction('compare-records');
    assert.deepEqual(errors, [code]); assert.equal(fixture.state.comparison, null);
    assert.equal(fixture.ui.states.size, 0); assert.equal(fixture.ui.key, null); assert.equal(fixture.ui.host.innerHTML, '');
  }
});

test('comparison and explicit clear do not snapshot, replace or alter an unsaved record draft', async () => {
  const fixture = controller({ recordMeasurements: async () => result() });
  const draft = { kind: 'record', recordId: 'synthetic-draft', expectedRevision: 0,
    values: { performed: 'PRIVATE-DRAFT', assessments: [{ value: '' }] }, references: [] };
  fixture.state.view = draft; const before = structuredClone(draft);
  fixture.ui.snapshot = () => assert.fail('comparison must not snapshot record inputs');
  fixture.ui.restoreView = () => assert.fail('comparison must not reopen record inputs');
  await fixture.ui.handleAction('compare-records'); await fixture.ui.handleAction('clear-comparison');
  assert.equal(fixture.state.view, draft); assert.deepEqual(draft, before);
  assert.equal(fixture.state.mutation.operation, null); assert(!fixture.ui.host.innerHTML.includes('PRIVATE-DRAFT'));
});

test('comparison preserves an uncertain mutation object, immutable request and receipt view unchanged', async () => {
  const fixture = controller({ recordMeasurements: async () => result() });
  const operation = fixture.state.mutation.begin('record', 'synthetic-draft',
    { expectedRevision: 0, content: { privateNote: 'PRIVATE-PENDING' } });
  fixture.state.mutation.failed(operation); fixture.state.view = { kind: 'receipt', values: {} };
  const receipt = fixture.state.view, before = structuredClone(operation);
  await fixture.ui.handleAction('compare-records'); await fixture.ui.handleAction('clear-comparison');
  assert.equal(fixture.state.mutation.operation, operation); assert.deepEqual(operation, before);
  assert.equal(fixture.state.mutation.everUncertain, true); assert.equal(fixture.state.view, receipt);
  assert(!fixture.ui.host.innerHTML.includes('PRIVATE-PENDING'));
});

test('explicit clear aborts a pending read, releases sensitive groups and rejects its late success', async () => {
  const gate = deferred(); let signal;
  const fixture = controller({ recordMeasurements: (_c, _r, s) => { signal = s; return gate.promise; } });
  const pending = fixture.ui.handleAction('compare-records'), abandoned = fixture.state.comparison;
  await fixture.ui.handleAction('clear-comparison');
  assert.equal(signal.aborted, true); assert.equal(fixture.state.comparison, null); assert.deepEqual(abandoned.groups, []);
  gate.resolve(result()); await pending;
  assert.equal(fixture.state.comparison, null); assert(!fixture.ui.host.innerHTML.includes('data-measurement-row'));
});

test('navigation suspend aborts a read and a new read cannot be overwritten by the abandoned response', async () => {
  const first = deferred(), second = deferred(), signals = []; let calls = 0;
  const fixture = controller({ recordMeasurements: (_c, _r, signal) => { signals.push(signal); return ++calls === 1 ? first.promise : second.promise; } });
  const oldPending = fixture.ui.handleAction('compare-records'); fixture.ui.suspend();
  assert.equal(signals[0].aborted, true); assert.equal(fixture.ui.host.innerHTML, '');
  fixture.ui.update(fixture.current); const newPending = fixture.ui.handleAction('compare-records');
  second.resolve(result([row({ value: 22 })])); await newPending;
  first.resolve(result([row({ value: 11 })])); await oldPending;
  assert.equal(fixture.state.comparison.groups[0].measurements[0].value, 22);
  assert.match(fixture.ui.host.innerHTML, /data-measurement-value>22 도/);
});

test('room, account, role and disconnect transitions purge old comparison and late results cannot reappear', async () => {
  for (const change of ['room', 'account', 'role', 'disconnect']) {
    const gate = deferred(); let signal;
    const fixture = controller({ recordMeasurements: (_c, _r, s) => { signal = s; return gate.promise; } });
    const pending = fixture.ui.handleAction('compare-records'), previous = fixture.state.comparison;
    const next = { ...fixture.current, generation: 2 };
    if (change === 'room') next.roomId = 'synthetic-other-room';
    if (change === 'account') next.user = { ...next.user, userId: 'synthetic-other-user' };
    if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
    if (change === 'disconnect') next.connected = false;
    fixture.setContext(next); fixture.ui.update(next);
    assert.equal(signal.aborted, true, change); assert.deepEqual(previous.groups, [], change);
    gate.resolve(result()); await pending;
    assert(!fixture.ui.host.innerHTML.includes('data-measurement-row'), change);
    assert.equal(fixture.state.comparison, null, change);
  }
});

test('changed room revision or record scope invalidates groups and aborts pending comparison reads', async () => {
  for (const change of ['roomRevision', 'recordRevision', 'recordId', 'recordStatus', 'notLoaded']) {
    const fixture = controller({ recordMeasurements: async () => result([row()], 6) });
    await fixture.ui.handleAction('compare-records'); const previous = fixture.state.comparison;
    if (change === 'roomRevision') fixture.setContext({ ...fixture.current, roomRevision: 8 });
    if (change === 'recordRevision') fixture.state.records[0].revision++;
    if (change === 'recordId') fixture.state.records[0].id = 'synthetic-new-record';
    if (change === 'recordStatus') fixture.state.records[0].status = 'draft';
    if (change === 'notLoaded') fixture.state.loaded = false;
    fixture.ui.reconcileComparison(fixture.current, fixture.state); fixture.ui.render();
    assert.deepEqual(previous.groups, [], change); assert.equal(fixture.state.comparison.loaded, undefined, change);
    assert.match(fixture.state.comparison.notice, /기록 또는 열람 범위가 바뀌어/);
    assert(!fixture.ui.host.innerHTML.includes('data-measurement-row'), change);
  }
  const gate = deferred(); let signal;
  const fixture = controller({ recordMeasurements: (_c, _r, s) => { signal = s; return gate.promise; } });
  const pending = fixture.ui.handleAction('compare-records'); fixture.state.records[0].revision++;
  fixture.ui.reconcileComparison(fixture.current, fixture.state); assert.equal(signal.aborted, true);
  gate.resolve(result()); await pending; assert.equal(fixture.state.comparison.loaded, undefined);
});

test('an unchanged scope or refreshed workspace matching the complete response revision retains valid groups', async () => {
  const fixture = controller({ recordMeasurements: async () => result([row()], 8) });
  await fixture.ui.handleAction('compare-records'); const comparison = fixture.state.comparison;
  fixture.ui.reconcileComparison(fixture.current, fixture.state); assert.equal(fixture.state.comparison, comparison);
  fixture.setContext({ ...fixture.current, roomRevision: 8 }); fixture.state.records[0].revision++;
  fixture.ui.reconcileComparison(fixture.current, fixture.state);
  assert.equal(fixture.state.comparison, comparison); assert.equal(comparison.loaded, true);
  assert.equal(comparison.groups[0].measurements.length, 1);
  const key = comparison.key; fixture.ui.reconcileComparison(fixture.current, fixture.state);
  assert.equal(comparison.key, key);
});

test('only a loaded therapist full panel offers or executes comparison; guardian and compact modes never fetch', async () => {
  for (const variant of ['guardian', 'compact', 'unloaded']) {
    let calls = 0;
    const fixture = controller({ recordMeasurements: async () => { calls++; return result(); } });
    if (variant === 'guardian') fixture.setContext({ ...fixture.current,
      user: { ...fixture.current.user, centers: [{ id: fixture.current.centerId, role: 'guardian' }] } });
    if (variant === 'compact') fixture.setContext({ ...fixture.current, panelMode: 'compact' });
    if (variant === 'unloaded') fixture.state.loaded = false;
    fixture.ui.render(); await fixture.ui.handleAction('compare-records'); await fixture.ui.handleAction('clear-comparison');
    assert.equal(calls, 0, variant); assert(!fixture.ui.host.innerHTML.includes('measurement-comparison'), variant);
    assert(!fixture.ui.host.innerHTML.includes('data-care-action="compare-records"'), variant);
  }
});
