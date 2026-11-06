// Display-only controller/DOM doubles. No browser, API, database, native
// storage, actual patient data or physical-device verification is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CareUi, CareMutation, publicCarePreview } from '../local-api/care-ui.js';

const goals = () => [{ id: 'synthetic-goal', revision: 3, title: '<합성 목표>' }];
const values = () => ({ date: '2026-10-13', title: '<합성 기록>', goalId: 'synthetic-goal',
  performed: '합성 활동 <A>', response: '합성 반응 <B>', nextPlan: '합성 계획 <C>',
  summary: '합성 보호자 요약', privateNote: 'PRIVATE-MEMO-CONTENT',
  observation: { status: 'observed', task: 'PRIVATE-OBSERVATION-CONTENT' },
  assessments: [
    { tool: 'ROM', item: '합성 각도', value: 0, unit: '도', context: '합성 조건 A' },
    { tool: 'MMT', item: '합성 근력', value: '', unit: '등급', context: '합성 조건 B' },
  ], activity: null, attachments: [] });
const recordView = (extra = {}) => ({ kind: 'record', recordId: 'synthetic-record', expectedRevision: 7,
  goals: goals(), references: [{ messageId: 'synthetic-source', messageRevision: 4,
    body: 'PRIVATE-REFERENCE-CONTENT <인용>', attachmentCount: 0 }], values: values(), ...extra });
const privateFile = () => ({ id: '12345678-1234-4234-8234-123456789abc', name: 'PRIVATE-FILE.png',
  type: 'image/png', size: 9, share: false });
const sharedFile = () => ({ id: '12345678-1234-4234-8234-123456789abd', name: '<합성 공유>.mp4',
  type: 'video/mp4', size: 11, share: true });
const preview = () => publicCarePreview({ recordId: 'synthetic-record', recordRevision: 7, relationshipsVersion: 5,
  recipientIds: ['synthetic-guardian'], date: '2026-10-13', title: '<공개 제목>', summary: '<공개 요약>',
  activity: { title: '<공개 활동>', instruction: '<공개 안내>', frequency: '하루 1회', caution: '무리하지 않기' },
  attachmentCount: 1, attachments: [privateFile(), { ...sharedFile(), privateKey: 'PRIVATE-STORAGE-KEY' }],
  performed: 'PRIVATE-PERFORMED', response: 'PRIVATE-RESPONSE', nextPlan: 'PRIVATE-PLAN',
  privateNote: 'PRIVATE-MEMO-CONTENT', assessments: [{ item: 'PRIVATE-ASSESSMENT' }],
  referenceSources: [{ body: 'PRIVATE-REFERENCE-CONTENT' }] });

function fixture(view, { captureForm = true, deliveryEnabled = false } = {}) {
  const current = { user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
    centerId: 'synthetic-center', roomId: 'synthetic-room', connected: true, generation: 1,
    signal: new AbortController().signal, messages: [], profile: { childId: 'synthetic-child',
      conversationId: 'synthetic-room', name: '<합성 아동 & 이름>', participants: [
        { userId: 'synthetic-guardian', role: 'guardian', displayName: '<합성 보호자 & 이름>' },
        { userId: 'unselected-guardian', role: 'guardian', displayName: 'UNSELECTED-RECIPIENT' },
      ] } };
  const api = new Proxy({}, { get: () => () => assert.fail('Layout rendering must not start an API operation.') });
  const ui = new CareUi({ api, getContext: () => current, deliveryEnabled, ...(deliveryEnabled ? { mediaApi: api } : {}) });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]);
  const state = { mutation: new CareMutation(() => 'synthetic-layout-request'), view,
    records: [], goals: goals(), appointments: [], loaded: true, loading: false };
  ui.states.set(ui.key, state);
  const displayed = [];
  ui.dialog = { innerHTML: '', open: false, querySelector: () => null, querySelectorAll: () => [],
    showModal() { this.open = true; } };
  ui.ensureDialog = () => {}; ui.wipeDialog = () => {}; ui.lockForm = () => {};
  if (captureForm) ui.form = (title, kind, body, buttons) => displayed.push({ title, kind, body, buttons });
  return { ui, state, current, displayed, get body() { return displayed.at(-1)?.body ?? ''; } };
}

function marked(html, tag, attribute) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`));
  assert(match, `Missing ${tag}[${attribute}]`); return match[0];
}
const summaries = (html) => [...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(match => match[1]);

test('record and publication use the real form header to identify the escaped current child', () => {
  for (const view of [recordView(), { kind: 'publish', preview: preview(), values: {} }]) {
    const f = fixture(view, { captureForm: false }); f.ui.display();
    const header = f.ui.dialog.innerHTML.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
    assert(header); assert.match(header, /\bdata-care-child\b/);
    assert.match(header, /&lt;합성 아동 &amp; 이름&gt;/); assert(!header.includes('<합성 아동'));
    assert.match(header, /id="care-dialog-title"/); assert.match(header, /data-care-action="close"/);
  }
});

test('record writing offers an escaped explicit title suggestion and a separate share-preparation intent', () => {
  const view = recordView(), original = structuredClone(view), f = fixture(view); f.ui.display();
  const suggestion = f.body.match(/<section class="care-title-suggestion"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert(suggestion);
  assert.match(suggestion, /2026-10-13 합성 활동 &lt;A&gt;/);
  assert.match(suggestion, /data-care-action="use-record-title"/);
  assert.match(suggestion, /<output data-record-title-suggestion aria-live="off">/);
  assert(!suggestion.includes('PRIVATE-')); assert(!suggestion.includes('합성 반응')); assert(!suggestion.includes('합성 계획'));
  assert.match(f.body, /name="title"[^>]*value="&lt;합성 기록&gt;"/);
  const summary = f.body.match(/<textarea\b[^>]*name="summary"[^>]*>/)?.[0];
  assert(summary); assert(!/\brequired\b/.test(summary));
  assert.match(f.displayed[0].buttons, /value="prepare-share" aria-label="보호자 공유 준비">공유 준비/);
  assert.match(f.displayed[0].buttons, /value="saved"[^>]*>기록 저장/);
  assert.deepEqual(view, original);
});

test('record actions group secondary controls before the main pair without changing native draft submission', () => {
  const f = fixture(recordView(), { captureForm: false }); f.ui.display();
  const html = f.ui.dialog.innerHTML;
  assert.match(html, /class="care-actions care-submit care-record-submit"/);
  const secondary = html.match(/<div class="care-record-secondary">([\s\S]*?)<\/div>/)?.[1];
  const primary = html.match(/<div class="care-record-primary">([\s\S]*?)<\/div>/)?.[1];
  assert(secondary && primary); assert(html.indexOf(secondary) < html.indexOf(primary));
  assert.match(secondary, /type="submit" name="intent" value="draft" formnovalidate/);
  assert.match(secondary, /type="button"[^>]*data-care-action="discard"/);
  assert.deepEqual([...html.matchAll(/name="intent" value="([^"]+)"/g)].map(match => match[1]), ['draft', 'saved', 'prepare-share']);
  assert.equal([...html.matchAll(/data-care-action="discard"/g)].length, 1);
  assert.match(primary, /class="primary"[^>]*value="saved"/);
  const publication = fixture({ kind: 'publish', preview: preview(), values: {} }, { captureForm: false }); publication.ui.display();
  assert(!publication.ui.dialog.innerHTML.includes('care-record-submit'));
  assert.equal([...publication.ui.dialog.innerHTML.matchAll(/data-care-action="discard"/g)].length, 1);
});

test('unknown-operation receipt headers do not reintroduce the child projection', () => {
  const f = fixture({ kind: 'receipt', values: {} }, { captureForm: false }); f.ui.display();
  assert(!f.ui.dialog.innerHTML.includes('data-care-child'));
  assert(!f.ui.dialog.innerHTML.includes('합성 아동'));
});

test('the three basic record fields precede folded references without changing source IDs or versions', () => {
  const view = recordView(), original = structuredClone(view), f = fixture(view); f.ui.display();
  const basics = marked(f.body, 'section', 'data-record-basics');
  const references = marked(f.body, 'details', 'data-record-references');
  assert(f.body.indexOf(basics) < f.body.indexOf(references));
  for (const name of ['performed', 'response', 'nextPlan']) assert.match(basics, new RegExp(`name="${name}"`));
  assert(basics.indexOf('name="performed"') < basics.indexOf('name="response"'));
  assert(basics.indexOf('name="response"') < basics.indexOf('name="nextPlan"'));
  assert(!basics.includes('PRIVATE-REFERENCE-CONTENT'));
  assert.match(references, /data-reference-message-id="synthetic-source"/);
  assert.match(references, /PRIVATE-REFERENCE-CONTENT &lt;인용&gt;/);
  assert.match(references, /4번째 소식/); assert.match(references, /data-care-action="reference-source"/);
  assert(!/^<details\b[^>]*\bopen\b/.test(references));
  assert.deepEqual(view, original);
  assert.match(f.displayed[0].buttons, /value="draft"[^>]*formnovalidate/);
  assert.match(f.displayed[0].buttons, /value="saved"/);
});

test('historical context is folded but stale-context warnings and their explicit refresh action remain outside details', () => {
  const view = recordView({ contextStale: true });
  view.values.goalSnapshot = { title: '<과거 목표>', revision: 2 };
  view.values.appointmentSnapshot = { date: '2026-10-12', time: '10:00', duration: 30,
    title: '<과거 일정>', room: '합성 장소', status: 'scheduled', revision: 4 };
  const original = structuredClone(view), f = fixture(view); f.ui.display();
  const history = marked(f.body, 'details', 'data-record-history');
  assert.match(history, /&lt;과거 목표&gt;/); assert.match(history, /&lt;과거 일정&gt;/);
  assert(!/^<details\b[^>]*\bopen\b/.test(history));
  const withoutDetails = f.body.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  assert.match(withoutDetails, /data-record-context/);
  assert.match(withoutDetails, /목표나 일정이 바뀌어 저장하지 않았어요/);
  assert.match(withoutDetails, /data-care-action="record-context-refresh"/);
  assert.deepEqual(view, original);
});

test('collapsed summaries indicate existing details without repeating clinical or internal text', () => {
  const f = fixture(recordView()); f.ui.display(); const text = summaries(f.body).join(' ');
  assert.match(text, /측정값\s*2개/); assert.match(text, /관찰 입력 있음/); assert.match(text, /내부 메모 있음/);
  for (const sensitive of ['PRIVATE-MEMO-CONTENT', 'PRIVATE-OBSERVATION-CONTENT', 'PRIVATE-REFERENCE-CONTENT']) assert(!text.includes(sensitive));
  assert.match(f.body, /name="assessment-0-value" value="0"/);
  assert.match(f.body, /name="assessment-1-value" value=""/);
});

test('an empty record does not invent history, reference content or existing clinical detail badges', () => {
  const view = recordView({ expectedRevision: 0, references: [] });
  Object.assign(view.values, { observation: null, assessments: [], privateNote: '' });
  const f = fixture(view); f.ui.display();
  assert(!f.body.includes('data-record-history')); assert(!f.body.includes('data-record-references'));
  const text = summaries(f.body).join(' '); assert(!text.includes('관찰 입력 있음')); assert(!text.includes('내부 메모 있음'));
  assert(!/측정값\s*[1-9]\d*개/.test(text));
});

test('publication separates the exact recipients, renders only allowed public fields and requires confirmation', () => {
  const view = { kind: 'publish', preview: preview(), values: {} }, original = structuredClone(view);
  const f = fixture(view, { deliveryEnabled: true }); f.ui.display();
  const recipients = marked(f.body, 'section', 'data-share-recipients');
  assert.match(recipients, /&lt;합성 보호자 &amp; 이름&gt;/); assert(!recipients.includes('UNSELECTED-RECIPIENT'));
  for (const allowed of ['&lt;공개 제목&gt;', '&lt;공개 요약&gt;', '&lt;공개 활동&gt;', '&lt;공개 안내&gt;', '&lt;합성 공유&gt;.mp4']) assert(f.body.includes(allowed), allowed);
  assert.match(f.body, /공유할 사진·영상\s*1개/);
  assert(!f.body.includes('PRIVATE-')); assert(!f.body.includes('UNSELECTED-RECIPIENT'));
  const confirmation = f.body.match(/<input\b[^>]*\bname="confirmed"[^>]*>/)?.[0];
  assert(confirmation); assert.match(confirmation, /\brequired\b/); assert.match(confirmation, /\btype="checkbox"/);
  assert(!/\bchecked\b/.test(confirmation));
  assert.match(f.displayed[0].buttons, /확인하고 공유/);
  assert.deepEqual(view, original);
  assert.deepEqual(view.preview.recipientIds, ['synthetic-guardian']);
  assert.equal(view.preview.recordRevision, 7); assert.equal(view.preview.relationshipsVersion, 5);
});

function disclosureFixture() {
  const f = fixture(recordView()), inputs = new Map(), rows = [];
  const status = (initial) => {
    let text = initial;
    return { writes: [], get textContent() { return text; }, set textContent(value) { this.writes.push(value); text = value; } };
  };
  const detail = status(''), privateNote = status('비공개');
  const form = { elements: { namedItem: (name) => inputs.get(name) ?? null },
    querySelectorAll: (selector) => selector === '[data-assessment-row]' ? rows : [],
    querySelector: (selector) => ({ '[data-record-detail-status]': detail, '[data-record-private-status]': privateNote })[selector] ?? null };
  f.ui.dialog.querySelector = (selector) => selector === 'form' ? form : null;
  const field = (name, value) => {
    const input = inputs.get(name) ?? { value: '' }; input.value = value; inputs.set(name, input); return input;
  };
  return { ...f, inputs, rows, detail, privateNote, form, field };
}

test('live disclosure updates only presence labels, never copies private text or changes the draft and request', () => {
  const f = disclosureFixture(), original = structuredClone(f.state.view);
  const request = Object.freeze({ clientId: 'synthetic-unchanged-request', body: Object.freeze({ expectedRevision: 7 }) });
  f.state.mutation.operation = request;
  const memo = f.field('privateNote', ' PRIVATE-LIVE-MEMO <秘密> ');
  const observation = f.field('observationTask', 'PRIVATE-LIVE-OBSERVATION');
  f.ui.updateRecordDisclosure();
  assert.equal(f.privateNote.textContent, '내부 메모 있음'); assert.equal(f.detail.textContent, '관찰 입력 있음');
  for (const text of [...f.detail.writes, ...f.privateNote.writes]) {
    assert(!text.includes('PRIVATE-')); assert(!text.includes('秘密'));
  }
  assert.equal(f.inputs.get('privateNote'), memo); assert.equal(f.inputs.get('observationTask'), observation);
  assert.equal(memo.value, ' PRIVATE-LIVE-MEMO <秘密> '); assert.equal(observation.value, 'PRIVATE-LIVE-OBSERVATION');
  assert.deepEqual(f.state.view, original); assert.equal(f.state.mutation.operation, request);
  memo.value = ' \t '; f.ui.updateRecordDisclosure(); assert.equal(f.privateNote.textContent, '비공개');
});

test('live disclosure treats typed zero as present without converting it or blank measurement values', () => {
  const f = disclosureFixture(), zero = f.field('observationRepetitions', '0');
  const measurement = { value: '0' }, blankMeasurement = { value: '' };
  f.rows.push(measurement, blankMeasurement); f.ui.updateRecordDisclosure();
  assert.match(f.detail.textContent, /관찰 입력 있음/); assert.match(f.detail.textContent, /측정값\s*2개/);
  assert.equal(zero.value, '0'); assert.equal(f.rows[0], measurement); assert.equal(measurement.value, '0');
  assert.equal(f.rows[1], blankMeasurement); assert.equal(blankMeasurement.value, '');
  zero.value = ''; f.ui.updateRecordDisclosure(); assert.equal(f.detail.textContent, '측정값 2개');
});

test('live row counts follow additions and removals while equivalent labels cause no DOM text writes', () => {
  const f = disclosureFixture(); f.ui.updateRecordDisclosure();
  assert.deepEqual(f.detail.writes, []); assert.deepEqual(f.privateNote.writes, []);
  for (const count of [1, 2, 1, 0]) {
    f.rows.length = count;
    const writes = f.detail.writes.length; f.ui.updateRecordDisclosure();
    assert.equal(f.detail.textContent, count ? `측정값 ${count}개` : '');
    assert.equal(f.detail.writes.length, writes + 1);
    f.ui.updateRecordDisclosure(); assert.equal(f.detail.writes.length, writes + 1);
  }
  f.field('privateNote', 'PRIVATE-ONE'); f.field('observationTask', 'PRIVATE-OBSERVATION-ONE');
  f.ui.updateRecordDisclosure(); const counts = [f.detail.writes.length, f.privateNote.writes.length];
  f.field('privateNote', 'PRIVATE-TWO'); f.field('observationTask', 'PRIVATE-OBSERVATION-TWO');
  f.ui.updateRecordDisclosure(); f.ui.updateRecordDisclosure();
  assert.deepEqual([f.detail.writes.length, f.privateNote.writes.length], counts);
});

test('not-observed and not-applicable indicate input presence rather than claiming an observation occurred', () => {
  const f = disclosureFixture(), field = f.field('observationStatus', '');
  for (const status of ['observed', 'not-observed', 'not-applicable']) {
    field.value = status; f.ui.updateRecordDisclosure();
    assert.equal(f.detail.textContent, '관찰 입력 있음'); assert.equal(field.value, status);
  }
  assert.equal(f.detail.writes.length, 1);
  field.value = ''; f.ui.updateRecordDisclosure(); assert.equal(f.detail.textContent, '');
});

test('non-record views do not inspect a form or update disclosure labels', () => {
  for (const kind of ['publish', 'receipt', 'record-cleanup', 'feedback', 'reply', undefined]) {
    const f = disclosureFixture(); f.state.view = kind ? { kind, values: {} } : null;
    f.ui.dialog.querySelector = () => assert.fail('A non-record view must not inspect stale record controls.');
    f.ui.updateRecordDisclosure(); assert.deepEqual(f.detail.writes, []); assert.deepEqual(f.privateNote.writes, []);
  }
  const f = disclosureFixture(); f.ui.dialog.querySelector = () => null;
  assert.doesNotThrow(() => f.ui.updateRecordDisclosure());
});
