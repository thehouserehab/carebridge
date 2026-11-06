// Pure UI/controller doubles only; no browser, HTTP, database or clinical data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareUi, CareMutation, careTextReviewContent, careMessageActions, renderCareMessage } from '../local-api/care-ui.js';
import { LocalApiError } from '../local-api/client.js';

const message = (extra = {}) => ({ id: 'synthetic-message', conversationId: 'synthetic-room', type: 'text',
  authorId: 'synthetic-guardian', body: '가상 목록 원문', version: 1, read: false, reviewed: false,
  hidden: false, deleted: false, attachmentCount: 0, ...extra });
const review = (extra = {}) => ({ messageId: 'synthetic-message', conversationId: 'synthetic-room', revision: 2,
  reviewVersion: 3, reviewedRevision: 1, body: '가상 최신 원문', note: '가상 비공개 반영', attachmentCount: 0, ...extra });
const view = (extra = {}) => ({ kind: 'text-review', messageId: 'synthetic-message', expectedRevision: 2,
  expectedReviewVersion: 3, reviewedRevision: 1, sourceBody: '가상 최신 원문', attachmentCount: 0,
  values: { note: '가상 비공개 반영' }, ...extra });
const context = () => ({ user: { userId: 'synthetic-therapist', centers: [{ id: 'synthetic-center', role: 'therapist' }] },
  centerId: 'synthetic-center', roomId: 'synthetic-room', messages: [message()], connected: true,
  generation: 1, signal: new AbortController().signal, careData: { goals: [], records: [], appointments: [] } });
const deferred = () => Promise.withResolvers();
function fixture(api = {}, callbacks = {}) {
  let current = context();
  const ui = new CareUi({ api, getContext: () => current, ...callbacks });
  ui.key = JSON.stringify([current.user.userId, current.centerId, current.roomId]); ui.owner = current.user.userId; ui.ownerRole = 'therapist';
  const state = { mutation: new CareMutation(() => 'synthetic-review-request'), records: [], goals: [], appointments: [], loaded: true, loading: false, view: null };
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
    display.nodes = kind === 'text-review' ? [makeNode({ type: 'textarea', name: 'note', value: state.view.values.note }),
      makeNode({ type: 'submit' }), makeNode({ type: 'button', dataset: { careAction: 'discard' } })] : [];
    ui.dialog.open = true; ui.lockForm();
  };
  return { ui, state, display, get current() { return current; }, setContext(next) { current = next; },
    note: () => display.nodes.find((node) => node.name === 'note'), submit: () => display.nodes.find((node) => node.type === 'submit') };
}
async function opened(api = {}, callbacks = {}) {
  const f = fixture({ textReview: async () => review(), ...api }, callbacks);
  await f.ui.handleAction('text-review', 'synthetic-message'); return f;
}

test('only incoming visible versioned text offers therapist review; own messages and other roles do not', () => {
  assert(careMessageActions(message(), 'therapist', 'synthetic-therapist').includes('text-review'));
  for (const role of ['guardian', 'center', undefined]) assert(!careMessageActions(message(), role, 'synthetic-therapist').includes('text-review'));
  for (const extra of [{ authorId: 'synthetic-therapist' }, { hidden: true }, { deleted: true }, { version: null },
    { version: 0 }, { version: '1' }, { type: 'feedback' }, { type: 'publication' }])
    assert(!careMessageActions(message(extra), 'therapist', 'synthetic-therapist').includes('text-review'));
});

test('read status never creates review status and public cards reveal only the explicit review Boolean', () => {
  for (const read of [false, true]) {
    const unreadReview = renderCareMessage(message({ read, reviewNote: 'PRIVATE-NOTE', reviewVersion: 8 }), 'therapist', 'synthetic-therapist');
    assert.match(unreadReview, /반영 확인 전/); assert(!unreadReview.includes('다음 회기 반영 확인')); assert(!unreadReview.includes('PRIVATE-NOTE'));
  }
  for (const role of ['guardian', 'therapist']) {
    const html = renderCareMessage(message({ reviewed: true, reviewNote: 'PRIVATE-NOTE', reviewedAt: 'PRIVATE-TIME' }), role, 'synthetic-therapist');
    assert.match(html, /다음 회기 반영 확인/); assert(!html.includes('PRIVATE-'));
    if (role === 'guardian') assert(!html.includes('data-care-action="text-review"'));
    for (const extra of [{ hidden: true }, { deleted: true }]) assert(!renderCareMessage(message({ reviewed: true, ...extra }), role, 'synthetic-therapist').includes('data-text-review-status'));
  }
});

test('review content contains only pinned source/review versions and a trimmed private note', () => {
  const values = { note: '  첫 줄\r\n다음 줄 😀  ', body: 'DO-NOT-PUBLISH', attachments: ['DO-NOT-BIND'] };
  const before = structuredClone(values);
  assert.deepEqual(careTextReviewContent(view(), values), { expectedRevision: 2, expectedReviewVersion: 3, note: '첫 줄\r\n다음 줄 😀' });
  assert.deepEqual(values, before);
  assert.equal(careTextReviewContent(view({ expectedReviewVersion: 0 }), { note: 'x'.repeat(2000) }).note.length, 2000);
});

test('review content rejects stale, malformed versions, blank, overlong, invalid Unicode and control notes', () => {
  for (const extra of [{ stale: true }, { expectedRevision: 0 }, { expectedRevision: '2' }, { expectedRevision: 2147483648 },
    { expectedReviewVersion: -1 }, { expectedReviewVersion: '3' }, { expectedReviewVersion: 2147483647 }, { expectedReviewVersion: 2147483648 }])
    assert.throws(() => careTextReviewContent(view(extra), { note: '가상 메모' }));
  for (const note of [undefined, null, 0, '', '  ', ' '.repeat(2000) + 'a', '\ud800', 'a\0b', 'a\x7fb', 'a\x85b'])
    assert.throws(() => careTextReviewContent(view(), { note }));
});

test('opening uses one fresh atomic private GET and pins its source, note and versions rather than list content', async () => {
  const calls = [], f = await opened({ textReview: async (...args) => { calls.push(args); return review(); },
    message: () => assert.fail('separate message read must not mix source and review snapshots') });
  assert.deepEqual(calls, [['synthetic-center', 'synthetic-room', 'synthetic-message', f.current.signal]]);
  assert.deepEqual(f.state.view, view()); assert.equal(f.note().value, '가상 비공개 반영');
  assert(!f.display.html.includes('가상 목록 원문')); assert.match(f.display.html, /가상 최신 원문/);
});

test('private form escapes note and source and labels historical note identity without embedding files', async () => {
  const f = await opened({ textReview: async () => review({ body: '<script>가상 원문</script>', note: '<b>가상 메모</b>', attachmentCount: 2 }) });
  assert.equal(f.display.title, '소식 반영 메모'); assert.equal(f.display.kind, 'text-review');
  for (const expected of ['&lt;script&gt;', '&lt;b&gt;', '수정 전 1번째 소식', '현재 2번째 소식', '메모 저장 버전 3',
    '첨부 2개는 보존됩니다', '읽음과 별도로', '담당 치료사만', '인용 답장', '비공개 반영 메모']) assert(f.display.html.includes(expected), expected);
  for (const forbidden of ['<script>', '<b>', '<img', '<video', 'data-open-attachment']) assert(!f.display.html.includes(forbidden));
  const empty = await opened({ textReview: async () => review({ body: '', note: '', reviewVersion: 0, reviewedRevision: null, attachmentCount: 1 }) });
  assert.match(empty.display.html, /첨부 소식/); assert(!empty.display.html.includes('data-text-review-history'));
});

test('opening refuses missing, hidden, own and guardian targets without private GET, and mismatched private response fails closed', async () => {
  for (const mode of ['missing', 'hidden', 'own', 'guardian']) {
    let calls = 0; const f = fixture({ textReview: async () => { calls++; return review(); } });
    if (mode === 'missing') f.current.messages = [];
    if (mode === 'hidden') f.current.messages[0].hidden = true;
    if (mode === 'own') f.current.messages[0].authorId = f.current.user.userId;
    if (mode === 'guardian') f.current.user.centers[0].role = 'guardian';
    await f.ui.handleAction('text-review', 'synthetic-message'); assert.equal(calls, 0, mode); assert.equal(f.state.view, null);
  }
  for (const extra of [{ messageId: 'other' }, { conversationId: 'other' }]) {
    const f = await opened({ textReview: async () => review(extra) }); assert.equal(f.state.view, null); assert.equal(f.display.count, 0);
  }
});

test('only one opening read runs and late results after room/account/role/menu transitions cannot restore private forms', async () => {
  for (const change of ['room', 'account', 'role', 'menu']) {
    const gate = deferred(); let calls = 0;
    const f = fixture({ textReview: () => { calls++; return gate.promise; } });
    const pending = f.ui.handleAction('text-review', 'synthetic-message');
    await f.ui.handleAction('text-review', 'synthetic-message'); assert.equal(calls, 1);
    if (change === 'menu') f.ui.suspend();
    else {
      const next = { ...f.current, generation: 2 };
      if (change === 'room') next.roomId = 'synthetic-other';
      if (change === 'account') next.user = { ...next.user, userId: 'synthetic-other-user' };
      if (change === 'role') next.user = { ...next.user, centers: [{ id: next.centerId, role: 'guardian' }] };
      f.setContext(next); f.ui.update(next);
    }
    gate.resolve(review()); await pending; assert.equal(f.display.count, 0, change); assert.equal(f.ui.dialog?.open ?? false, false, change);
  }
});

test('polling unchanged authority preserves unsaved DOM text and pinned versions without replacing the form', async () => {
  const f = await opened(); const original = f.state.view, count = f.display.count;
  f.note().value = '아직 저장하지 않은 입력';
  assert.equal(await f.ui.guardView(f.current), true);
  assert.equal(f.state.view, original); assert.equal(f.note().value, '아직 저장하지 않은 입력');
  assert.equal(f.display.count, count); assert.equal(original.expectedRevision, 2); assert.equal(original.expectedReviewVersion, 3);
});

test('changed source or memo version makes the form stale without merging new body/note or changing pinned versions', async () => {
  for (const extra of [{ revision: 3 }, { reviewVersion: 4 }]) {
    let current = review(); const f = await opened({ textReview: async () => current });
    const original = f.state.view; f.note().value = 'UNSAVED-NOTE'; current = review({ ...extra, body: 'NEW-BODY', note: 'NEW-NOTE' });
    assert.equal(await f.ui.guardView(f.current), true); assert.equal(original.stale, true);
    assert.equal(original.expectedRevision, 2); assert.equal(original.expectedReviewVersion, 3);
    assert.equal(original.sourceBody, '가상 최신 원문'); assert.equal(f.note().value, 'UNSAVED-NOTE');
    assert.equal(f.submit().disabled, true); assert.equal(f.note().disabled, false);
    assert(!f.display.html.includes('NEW-BODY')); assert(!f.display.html.includes('NEW-NOTE'));
    assert.match(f.display.notices.textContent, /바뀌어 이 입력으로는 저장할 수 없어요/);
  }
});

test('stale form is blocked by submission logic even if disabled HTML is bypassed, and stale remains latched', async () => {
  let writes = 0, current = review(); const f = await opened({ textReview: async () => current, textReviewSave: async () => { writes++; } });
  current = review({ revision: 3 }); await f.ui.guardView(f.current);
  current = review(); await f.ui.guardView(f.current); f.submit().disabled = false;
  await f.ui.submit(); assert.equal(writes, 0); assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view.stale, true);
  assert.equal(f.state.view.values.note, '가상 비공개 반영');
});

test('resume rechecks the exact source even when it is absent from the message list, then preserves draft', async () => {
  let calls = 0; const f = await opened({ textReview: async () => { calls++; return review(); } });
  f.note().value = '가상 이어쓸 입력'; f.ui.close(); f.current.messages = [];
  assert.equal(f.ui.dialog.open, false); await f.ui.handleAction('resume');
  assert.equal(calls, 2); assert.equal(f.ui.dialog.open, true); assert.equal(f.note().value, '가상 이어쓸 입력');
  assert.equal(f.state.view.expectedRevision, 2); assert.equal(f.state.view.expectedReviewVersion, 3);
});

test('confirmed source denial or deletion synchronously wipes source/note before notifying owner', async () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN', 'MESSAGE_DELETED']) {
    let denied = false, callbacks = 0, f;
    f = await opened({ textReview: async () => { if (denied) throw new LocalApiError(code, code === 'MESSAGE_DELETED' ? 409 : 404); return review(); } },
      { onSourceUnavailable: () => { callbacks++; assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false); assert.equal(f.state.view, null); } });
    const oldInput = f.note(); oldInput.value = 'PRIVATE-UNSAVED'; denied = true;
    assert.equal(await f.ui.guardView(f.current), false); assert.equal(callbacks, 1); assert.equal(oldInput.value, '');
    assert.equal(f.state.view, null); assert.equal(f.display.html, ''); assert.equal(f.state.mutation.operation, null);
  }
});

test('temporary source read failure hides private DOM, preserves unsaved note only in memory and requires successful recheck', async () => {
  let fail = false; const f = await opened({ textReview: async () => { if (fail) throw new LocalApiError('UNAVAILABLE'); return review(); } });
  f.note().value = '가상 미전송 메모'; const original = f.state.view; fail = true;
  assert.equal(await f.ui.guardView(f.current), false); assert.equal(f.display.html, ''); assert.equal(f.ui.dialog.open, false);
  assert.equal(f.state.view, original); assert.equal(original.values.note, '가상 미전송 메모');
  await f.ui.handleAction('resume'); assert.equal(f.ui.dialog.open, false);
  fail = false; await f.ui.handleAction('resume'); assert.equal(f.note().value, '가상 미전송 메모'); assert.equal(f.ui.dialog.open, true);
});

test('successful explicit submission sends only immutable review fields without replying, reading or copying record content', async () => {
  const calls = []; let changes = 0;
  const f = await opened({ textReviewSave: async (...args) => { calls.push(args); },
    send: () => assert.fail('review is not a reply'), recordSave: () => assert.fail('review is not a clinical record'),
    read: () => assert.fail('review is not read state') }, { onChanged: () => { changes++; } });
  f.note().value = '  가상 저장 메모  '; await f.ui.submit();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 3), ['synthetic-center', 'synthetic-room', 'synthetic-message']);
  assert.deepEqual(calls[0][3], { clientId: 'synthetic-review-request', expectedRevision: 2, expectedReviewVersion: 3, note: '가상 저장 메모' });
  assert(Object.isFrozen(calls[0][3])); assert.equal(calls[0][4], f.current.signal);
  assert.equal(changes, 1); assert.equal(f.state.view, null); assert.equal(f.state.mutation.operation, null); assert.equal(f.display.html, '');
});

test('first definitive conflict preserves note and versions without automatic merge or a second request', async () => {
  for (const code of ['MESSAGE_CONFLICT', 'REVIEW_CONFLICT']) {
    let writes = 0; const f = await opened({ textReviewSave: async () => { writes++; throw new LocalApiError(code, 409); } });
    f.note().value = '가상 충돌 입력'; await f.ui.submit();
    assert.equal(writes, 1); assert.equal(f.state.mutation.operation, null); assert.equal(f.note().value, '가상 충돌 입력');
    assert.equal(f.state.view.expectedRevision, 2); assert.equal(f.state.view.expectedReviewVersion, 3);
    assert.equal(f.note().disabled, false); assert.equal(f.state.mutation.everUncertain, false);
  }
});

test('unknown commit uses source-free receipt and retries the exact request even after a later conflict', async () => {
  const writes = []; let attempt = 0, reads = 0;
  const f = await opened({ textReview: async () => { reads++; return review(); }, textReviewSave: async (...args) => {
    writes.push(args[3]); if (++attempt === 1) throw new LocalApiError('UNAVAILABLE');
    if (attempt === 2) throw new LocalApiError('REVIEW_CONFLICT', 409);
  } });
  f.note().value = '가상 불확정 메모'; await f.ui.submit(); const operation = f.state.mutation.operation;
  assert(operation); assert.equal(f.note().disabled, true); await f.ui.guardView(f.current);
  assert.equal(f.state.view.kind, 'receipt'); assert.equal(reads, 1); assert.equal(f.display.title, '이전 요청 처리 확인');
  for (const secret of ['가상 최신 원문', '가상 불확정 메모', 'textarea']) assert(!f.display.html.includes(secret));
  await f.ui.mutate(); assert.equal(f.state.mutation.operation, operation); assert.equal(f.state.mutation.everUncertain, true);
  assert.equal(f.ui.discard(), false); await f.ui.mutate();
  assert.equal(writes.length, 3); for (const body of writes) assert.equal(body, operation.body);
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view, null);
});

test('first conflict arriving after poll receipt transition closes empty receipt without restoring private source', async () => {
  const gate = deferred(); const f = await opened({ textReviewSave: () => gate.promise });
  const pending = f.ui.submit(); await f.ui.guardView(f.current); assert.equal(f.state.view.kind, 'receipt');
  gate.reject(new LocalApiError('REVIEW_CONFLICT', 409)); await pending;
  assert.equal(f.state.mutation.operation, null); assert.equal(f.state.view, null); assert.equal(f.display.html, '');
  assert.equal(f.ui.dialog.open, false);
});

test('late mutation success after account transition never refreshes or restores the new account context', async () => {
  const gate = deferred(); let changes = 0;
  const f = await opened({ textReviewSave: () => gate.promise }, { onChanged: () => { changes++; } });
  const pending = f.ui.submit(); const next = { ...f.current, generation: 2, user: { ...f.current.user, userId: 'synthetic-new-user' } };
  f.setContext(next); f.ui.update(next); gate.resolve({}); await pending;
  assert.equal(changes, 0); assert.equal(f.ui.dialog?.open ?? false, false); assert.equal(f.display.html, '');
  assert.equal(f.ui.state().view, null);
});

test('authentication loss purges private view and opening errors never print raw server content', async () => {
  const errors = []; let denied = false;
  const f = await opened({ textReview: async () => { if (denied) throw new LocalApiError('AUTH_REQUIRED', 401); return review(); } },
    { onError: (error) => errors.push(error.code) });
  denied = true; await f.ui.guardView(f.current);
  assert.deepEqual(errors, ['AUTH_REQUIRED']); assert.equal(f.ui.states.size, 0); assert.equal(f.display.html, '');
  const failure = fixture({ textReview: async () => { throw new Error('PRIVATE-RAW-PATH-NOTE'); } });
  await failure.ui.handleAction('text-review', 'synthetic-message');
  assert.equal(failure.state.view, null); assert(!failure.display.html.includes('PRIVATE-')); assert(!failure.ui.host.innerHTML.includes('PRIVATE-'));
});
