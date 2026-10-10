import assert from 'node:assert/strict';
import test from 'node:test';
import { seed } from '../src/seed.js';
import { mutate, project, validateState } from '../src/domain.js';
import { upgradeState, conversationView } from '../src/conversations.js';
import * as references from '../src/message-references.js';
import { messageVersion } from '../src/message-lifecycle.js';
import { recordDetail, recordEditor } from '../src/record-ui.js';
import { escape } from '../src/ui.js';
import { MediaView } from '../src/media-ui.js';

// Synthetic domain state, metadata and in-memory Blob fixtures only. No real
// browser, file IO, accounts, API, operating service or external storage.
const therapist = { id: 't1', role: 'therapist' };
const guardian = { id: 'p1', role: 'guardian' };
const manager = { id: 'm1', role: 'center' };
const replacement = { id: 't2', role: 'therapist' };
const at = '2026-10-08T00:00:00.000Z', later = '2026-10-08T01:00:00.000Z';
const photo = { id: 'reference-old-photo', name: 'SYNTHETIC-OLD.png', type: 'image/png', size: 32, share: true };
const video = { id: 'reference-old-video', name: 'SYNTHETIC-OLD.webm', type: 'video/webm', size: 64, share: true };
const newPhoto = { id: 'reference-new-photo', name: 'SYNTHETIC-NEW.png', type: 'image/png', size: 48, share: true };
const recordFile = { id: 'clinical-only-photo', name: 'SYNTHETIC-RECORD.png', type: 'image/png', size: 16, share: false };
const read = (db, actor, recordId, messageId) => references.recordReferenceMedia(db, actor, recordId, messageId);
const findRecord = (db, recordId) => db.records.find((row) => row.id === recordId);
function addReference(db, messageId, extra = {}) {
  return mutate(db, therapist, 'record', { childId: 'c1', goalId: 'g1', date: '2026-10-08',
    performed: '합성 활동 관찰', summary: '보호자에게 전할 합성 공유 요약',
    referenceMessageIds: [messageId], ...extra }, at);
}
function fixture(kind = 'text', attachments = [photo, video]) {
  let db = upgradeState(seed()), feedbackId;
  if (kind === 'text') db = mutate(db, guardian, 'message', {
    childId: 'c1', clientId: crypto.randomUUID(), body: '보존할 합성 원문', attachments,
  }, at);
  else {
    db = mutate(db, guardian, 'feedback', { childId: 'c1', publicationId: 'pub1', date: '2026-10-08',
      result: 'partial', reaction: 'F1 합성 피드백', difficulty: '합성 어려움', attachments }, at);
    feedbackId = db.feedback.at(-1).id;
  }
  const messageId = kind === 'text' ? db.messages.at(-1).id
    : db.messages.find((row) => row.type === 'feedback' && row.sourceId === feedbackId).id;
  db = addReference(db, messageId, { attachments: [recordFile] });
  return { db, messageId, recordId: db.records.at(-1).id, feedbackId };
}
function projectedReference(db, recordId, messageId, extra = {}) {
  const saved = findRecord(db, recordId).referenceSources.find((row) => row.messageId === messageId);
  return { id: messageId, recordId, body: saved.body, version: saved.version,
    attachments: structuredClone(saved.attachments), preserved: true, ...extra };
}
const edit = (db, messageId) => mutate(db, guardian, 'message-edit', { childId: 'c1', id: messageId,
  clientId: crypto.randomUUID(), expectedVersion: messageVersion(db.messages.find((row) => row.id === messageId)), body: '수정된 합성 원문' }, later);
const remove = (db, actor, messageId, scope) => mutate(db, actor, 'message-delete', { childId: 'c1', id: messageId,
  clientId: crypto.randomUUID(), confirmed: true, scope,
  expectedVersion: messageVersion(db.messages.find((row) => row.id === messageId)) }, later);
const reviseFeedback = (db, feedbackId) => mutate(db, guardian, 'feedback', {
  childId: 'c1', id: feedbackId, publicationId: 'pub1', date: '2026-10-08', result: 'done',
  reaction: 'F2 합성 피드백', difficulty: '', attachments: [newPhoto], expectedVersion: 1,
}, later);
function buttons(html) {
  return [...html.matchAll(/<button\b[^>]*data-action="view-reference-media"[^>]*>[\s\S]*?<\/button>/g)].map((row) => row[0]);
}

test('saved record detail and editor expose a count-only historical attachment button', () => {
  const { db, recordId, messageId } = fixture();
  const record = findRecord(db, recordId), before = structuredClone(db);
  const detail = recordDetail(record);
  const editor = recordEditor(record, db.goals.filter((row) => row.childId === 'c1'), '2026-10-08',
    [projectedReference(db, recordId, messageId)]);
  for (const html of [detail, editor]) {
    const found = buttons(html);
    assert.equal(found.length, 1, 'a saved attachment reference needs one historical media action');
    assert.ok(found[0].includes(`data-id="${recordId}"`));
    assert.ok(found[0].includes(`data-reference="${messageId}"`));
    assert.match(found[0], /당시 사진·영상 2개 보기/);
    assert.doesNotMatch(html, /<img\b|<video\b|data-media-id|SYNTHETIC-OLD|reference-old-photo|reference-old-video/);
  }
  assert.match(editor, /class="record-references"/);
  assert.deepEqual(db, before);
});

test('historical media lookup returns only a detached snapshot attachment list and never changes stored state', () => {
  const { db, recordId, messageId } = fixture();
  const before = structuredClone(db), value = read(db, therapist, recordId, messageId);
  assert.deepEqual(value, [photo, video]);
  assert.notEqual(value, findRecord(db, recordId).referenceSources[0].attachments);
  assert.notEqual(value[0], findRecord(db, recordId).referenceSources[0].attachments[0]);
  value[0].name = 'MODIFIED-RETURN-VALUE'; value.push(newPhoto);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test('multiple saved references resolve the requested message rather than the first snapshot or another record', () => {
  let { db, recordId, messageId } = fixture();
  db = mutate(db, guardian, 'message', { childId: 'c1', clientId: crypto.randomUUID(),
    body: '다른 합성 원문', attachments: [newPhoto] }, later);
  const secondMessageId = db.messages.at(-1).id;
  db = addReference(db, messageId, { id: recordId, referenceMessageIds: [messageId, secondMessageId], expectedReferenceVersions: [] });
  db = addReference(db, secondMessageId); const secondRecordId = db.records.at(-1).id;
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.deepEqual(read(db, therapist, recordId, secondMessageId), [newPhoto]);
  assert.deepEqual(read(db, therapist, secondRecordId, secondMessageId), [newPhoto]);
  assert.equal(read(db, therapist, secondRecordId, messageId), null);
  const actions = buttons(recordDetail(findRecord(db, recordId)));
  assert.equal(actions.length, 2);
  assert.match(actions[0], /당시 사진·영상 2개 보기/); assert.match(actions[1], /당시 사진·영상 1개 보기/);
  assert.ok(actions[0].includes(`data-reference="${messageId}"`));
  assert.ok(actions[1].includes(`data-reference="${secondMessageId}"`));
  assert.equal(validateState(db), true);
});

test('guardians, center staff, unassigned therapists and forged record/message pairs receive null', () => {
  const { db, recordId, messageId } = fixture(), before = structuredClone(db);
  for (const actor of [guardian, manager, replacement, { id: 'unknown', role: 'therapist' },
    { id: therapist.id, role: 'guardian' }, { id: therapist.id, role: 'center' }])
    assert.equal(read(db, actor, recordId, messageId), null);
  for (const wrongRecordId of ['missing', 'r1', '', null, { id: recordId }])
    assert.equal(read(db, therapist, wrongRecordId, messageId), null);
  for (const wrongMessageId of ['missing', 'publication-pub1', '', null, { id: messageId }])
    assert.equal(read(db, therapist, recordId, wrongMessageId), null);
  const second = fixture();
  assert.equal(read(db, therapist, recordId, second.messageId), null);
  assert.deepEqual(project(db, guardian, 'c1').records, []);
  assert.deepEqual(project(db, manager, 'c1').records, []);
  assert.deepEqual(db, before);
});

test('both the saved reference membership and matching snapshot are required; legacy ID-only rows do not fall back to source files', () => {
  const { db, recordId, messageId } = fixture();
  for (const modify of [
    (record) => { record.referenceMessageIds = []; },
    (record) => { record.referenceSources = []; },
    (record) => { delete record.referenceSources; },
    (record) => { record.referenceSources[0].messageId = 'another-message'; },
  ]) {
    const candidate = structuredClone(db); modify(findRecord(candidate, recordId));
    const before = structuredClone(candidate);
    assert.equal(read(candidate, therapist, recordId, messageId), null);
    assert.deepEqual(candidate, before);
  }
});

test('editing, hiding and deleting a source does not remove already authorized clinical snapshot media', () => {
  let { db, recordId, messageId } = fixture();
  const snapshot = structuredClone(findRecord(db, recordId).referenceSources);
  db = edit(db, messageId);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  db = remove(db, therapist, messageId, 'self');
  assert.equal(conversationView(db, therapist, 'c1').messages.some((row) => row.id === messageId), false);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  db = remove(db, guardian, messageId, 'all');
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.equal(conversationView(db, guardian, 'c1').messages.find((row) => row.id === messageId).hidden, true);
  const before = structuredClone(db);
  const record = findRecord(db, recordId);
  const html = recordEditor(record, db.goals.filter((row) => row.childId === 'c1'), '2026-10-08',
    [projectedReference(db, recordId, messageId, { sourceUnavailable: true, sourceChanged: true })]);
  assert.equal(buttons(html).length, 1); assert.doesNotMatch(html, /data-action="view-reference"/);
  assert.deepEqual(db, before); assert.deepEqual(record.referenceSources, snapshot); assert.equal(validateState(db), true);
});

test('feedback F2 replacement keeps historical F1 attachments separate from the current conversation', () => {
  let { db, recordId, messageId, feedbackId } = fixture('feedback');
  db = mutate(db, therapist, 'review', { childId: 'c1', id: feedbackId, expectedVersion: 1,
    reviewNote: 'SYNTHETIC-PRIVATE-REVIEW' }, at);
  db = reviseFeedback(db, feedbackId);
  const before = structuredClone(db), current = conversationView(db, therapist, 'c1').messages.find((row) => row.id === messageId);
  assert.deepEqual(current.attachments, [newPhoto]);
  const historical = read(db, therapist, recordId, messageId);
  assert.deepEqual(historical, [photo, video]);
  assert.doesNotMatch(JSON.stringify(historical), /reference-new-photo|SYNTHETIC-PRIVATE-REVIEW|reviewNote|reaction|difficulty|history/);
  const record = findRecord(db, recordId);
  const html = recordEditor(record, db.goals.filter((row) => row.childId === 'c1'), '2026-10-08',
    [projectedReference(db, recordId, messageId, { sourceChanged: true })]);
  assert.equal(buttons(html).length, 1); assert.match(html, /당시 사진·영상 2개 보기/);
  assert.match(html, /현재 원문 보기/); assert.doesNotMatch(html, /SYNTHETIC-NEW|reference-new-photo/);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test('withdrawal redacts guardian feedback but does not erase a therapist-readable historical attachment reference', () => {
  let { db, recordId, messageId, feedbackId } = fixture('feedback');
  db = reviseFeedback(db, feedbackId);
  db = mutate(db, therapist, 'unpublish', { childId: 'c1', id: 'r1' }, later);
  const before = structuredClone(db);
  const guardianMessage = conversationView(db, guardian, 'c1').messages.find((row) => row.id === messageId);
  assert.equal(guardianMessage.hidden, true); assert.deepEqual(guardianMessage.attachments, []);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.equal(read(db, guardian, recordId, messageId), null);
  assert.doesNotMatch(JSON.stringify(project(db, guardian, 'c1')), /referenceSources|reference-old-photo|reference-old-video/);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test('current assignment and record history grant are rechecked after a therapist changes or reconnects', () => {
  let { db, recordId, messageId } = fixture();
  db = mutate(db, manager, 'relationships', { childId: 'c1', therapistId: 't2', guardianIds: ['p1'], historyConfirmed: true }, later);
  assert.equal(read(db, therapist, recordId, messageId), null);
  assert.equal(read(db, replacement, recordId, messageId), null);
  db = mutate(db, manager, 'relationships', { childId: 'c1', therapistId: 't1', guardianIds: ['p1'], historyConfirmed: true }, later);
  assert.equal(read(db, therapist, recordId, messageId), null);
  db = mutate(db, manager, 'relationships', { childId: 'c1', therapistId: 't1', guardianIds: ['p1'],
    historyConfirmed: true, pastHistoryConfirmed: true, historyChoices: { t1: 'all' } }, later);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.equal(read(db, replacement, recordId, messageId), null); assert.equal(validateState(db), true);
});

test('removing a reference from the current record invalidates an old media button rather than using a cached projected snapshot', () => {
  let { db, recordId, messageId } = fixture();
  const cached = projectedReference(db, recordId, messageId);
  assert.deepEqual(read(db, therapist, cached.recordId, cached.id), cached.attachments);
  db = addReference(db, messageId, { id: recordId, referenceMessageIds: [], expectedReferenceVersions: [] });
  const before = structuredClone(db);
  assert.equal(read(db, therapist, cached.recordId, cached.id), null);
  assert.equal(buttons(recordDetail(findRecord(db, recordId))).length, 0);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test('a reference without media returns an empty list and renders no historical media button', () => {
  const { db, recordId, messageId } = fixture('text', []);
  assert.deepEqual(read(db, therapist, recordId, messageId), []);
  const record = findRecord(db, recordId);
  assert.equal(buttons(recordDetail(record)).length, 0);
  assert.equal(buttons(recordEditor(record, db.goals, '2026-10-08', [projectedReference(db, recordId, messageId)])).length, 0);
});

test('a newly selected current source has only its current-source action, not a fabricated historical attachment action', () => {
  const { db, messageId } = fixture();
  const current = conversationView(db, therapist, 'c1').messages.find((row) => row.id === messageId);
  const before = structuredClone(db);
  const html = recordEditor({}, db.goals.filter((row) => row.childId === 'c1'), '2026-10-08', [current]);
  assert.equal(buttons(html).length, 0);
  assert.match(html, /data-action="view-reference"/);
  assert.ok(html.includes(`data-id="${messageId}"`));
  assert.doesNotMatch(html, /<img\b|<video\b|SYNTHETIC-OLD|reference-old-photo|reference-old-video/);
  assert.deepEqual(db, before);
});

test('historical action IDs and quote text are HTML escaped and filenames never enter the count-only render', () => {
  const recordId = 'record" data-forged="yes', messageId = 'message"><img src=x onerror=evil()>', body = '<script>evil()</script>&"';
  const saved = { messageId, version: 1, body, attachments: [{ ...photo, name: '<img src=x onerror=evil()>.png' }] };
  const record = { id: recordId, referenceSources: [saved], referenceMessageIds: [messageId] };
  const projected = { id: messageId, recordId, body, version: 1, attachments: saved.attachments, preserved: true };
  for (const html of [recordDetail(record), recordEditor(record, [{ id: 'g1', title: '합성 목표' }], '2026-10-08', [projected])]) {
    const found = buttons(html); assert.equal(found.length, 1);
    assert.ok(found[0].includes(`data-id="${escape(recordId)}"`));
    assert.ok(found[0].includes(`data-reference="${escape(messageId)}"`));
    assert.ok(html.includes(escape(body)));
    assert.doesNotMatch(html, /<script>|<img\b|data-forged="yes"|SYNTHETIC-OLD/);
  }
});

test('opening and resaving a historical reference never copies those files into clinical or guardian-shared attachments', () => {
  let { db, recordId, messageId, feedbackId } = fixture('feedback');
  db = reviseFeedback(db, feedbackId);
  const referenceBefore = structuredClone(findRecord(db, recordId).referenceSources);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  db = addReference(db, messageId, { id: recordId, expectedReferenceVersions: [], performed: '합성 계획 수정' });
  const record = findRecord(db, recordId);
  assert.deepEqual(record.referenceSources, referenceBefore);
  assert.deepEqual(record.attachments, [recordFile]);
  db = mutate(db, therapist, 'publish', { childId: 'c1', id: recordId }, later);
  const publication = db.publications.find((row) => row.id === findRecord(db, recordId).publicationId);
  assert.deepEqual(publication.attachments, []);
  assert.doesNotMatch(JSON.stringify(publication), /referenceSources|reference-old-photo|reference-old-video|clinical-only-photo|SYNTHETIC-OLD/);
  assert.doesNotMatch(JSON.stringify(project(db, guardian, 'c1')), /referenceSources|reference-old-photo|reference-old-video|clinical-only-photo/);
  assert.deepEqual(read(db, therapist, recordId, messageId), [photo, video]);
  assert.equal(validateState(db), true);
});

test('historical media panel IDs cannot collide across ambiguous pairs, whitespace or detail/editor surfaces', () => {
  const pairs = [['a', 'b-c'], ['a-b', 'c'], ['a b', 'c'], ['a', 'b c'],
    ['a%20b', 'c'], ['한 글', '소식 id']];
  const ids = [];
  for (const [recordId, messageId] of pairs) {
    const source = { messageId, version: 1, body: '합성 원문', attachments: [photo] };
    const record = { id: recordId, referenceMessageIds: [messageId], referenceSources: [source] };
    const projected = { id: messageId, recordId, preserved: true, body: source.body, attachments: source.attachments };
    for (const [surface, html] of [
      ['detail', recordDetail(record)],
      ['editor', recordEditor(record, [{ id: 'g1', title: '합성 목표' }], '2026-10-08', [projected])],
    ]) {
      const found = buttons(html); assert.equal(found.length, 1);
      const controls = found[0].match(/aria-controls="([^"]+)"/)?.[1];
      assert.ok(controls); assert.doesNotMatch(controls, /\s/);
      assert.equal(controls, `reference-media-${surface}-${escape(encodeURIComponent(JSON.stringify([recordId, messageId])))}`);
      assert.match(found[0], /aria-expanded="false"/);
      assert.equal([...html.matchAll(/<div\b[^>]*\bid="([^"]+)"[^>]*>/g)]
        .filter((match) => match[1] === controls).length, 1, 'every aria-controls resolves to its own existing panel');
      ids.push(controls);
    }
  }
  assert.equal(new Set(ids).size, pairs.length * 2);
});

// The global stubs are limited to these serial tests. Restore exact property
// descriptors even after an assertion rejects; other files run in separate
// Node test workers. No browser functionality is claimed by this fake DOM.
let mediaDomBusy = false;
async function withMediaDom(work) {
  assert.equal(mediaDomBusy, false); mediaDomBusy = true;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const created = [], revoked = [];
  let revokeProbe = () => {};
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase(); this.children = []; this.attributes = {}; this.events = {};
      this.isConnected = true; this.parentNode = null; this.paused = false; this.pauseCalls = 0; this.loadCalls = 0;
    }
    get src() { return this.attributes.src ?? ''; }
    set src(value) { this.setAttribute('src', value); }
    get href() { return this.attributes.href ?? ''; }
    set href(value) { this.setAttribute('href', value); }
    append(...children) {
      for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); }
    }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      this.append(...children);
    }
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children, index = siblings.indexOf(this);
      if (index !== -1) siblings.splice(index, 1);
      this.parentNode = null;
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name, listener) { this.events[name] = listener; }
    removeEventListener(name, listener) { if (this.events[name] === listener) delete this.events[name]; }
    replaceWith(element) {
      if (!this.parentNode) return;
      const parent = this.parentNode, index = parent.children.indexOf(this);
      element.remove(); this.remove(); element.parentNode = parent; parent.children.splice(index, 0, element);
    }
    pause() { assert.equal(this.tagName, 'VIDEO'); this.paused = true; this.pauseCalls++; }
    load() { assert.equal(this.tagName, 'VIDEO'); this.loadCalls++; }
  }
  const slot = (blob, id = 'synthetic-blob') => Object.assign(new Element('div'), {
    dataset: { mediaId: id, type: blob.type, size: String(blob.size), name: `SYNTHETIC-${id}` },
  });
  const root = (...slots) => ({ querySelectorAll(selector) { assert.equal(selector, '[data-media-id]'); return slots; } });
  const restore = (target, key, descriptor) => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (name) => new Element(name) } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob) => {
      const value = `blob:synthetic-reference-${created.length + 1}`; created.push({ blob, value }); return value;
    } });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (value) => { revokeProbe(value); revoked.push(value); } });
    await work({ slot, root, created, revoked, element: (name) => new Element(name),
      onRevoke: (probe) => { revokeProbe = probe; } });
  } finally {
    restore(globalThis, 'document', originalDocument);
    restore(URL, 'createObjectURL', originalCreate); restore(URL, 'revokeObjectURL', originalRevoke);
    mediaDomBusy = false;
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const blobFixture = (type = 'image/png', size = 4) => new Blob([new Uint8Array(size)], { type });

test('deferred media reads recheck display permission before creating any URL or exposing the file', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created, revoked }) => {
    const blob = blobFixture(), target = slot(blob), read = deferred();
    let permitted = true, checked = 0, missing = 0;
    const view = new MediaView({ read: () => read.promise }, {
      canDisplay: (candidate) => { assert.equal(candidate, target); checked++; return permitted; },
      missingMessage: () => { missing++; return 'must not be used for permission denial'; },
    });
    try {
      const pending = view.hydrate(root(target));
      assert.equal(checked, 0); assert.equal(created.length, 0);
      permitted = false; read.resolve(blob); await pending;
      assert.equal(checked, 1); assert.equal(missing, 0); assert.equal(created.length, 0);
      assert.equal(target.children.length, 1); assert.equal(target.children[0].tagName, 'SPAN');
      assert.equal(target.children[0].textContent, '저장된 자료가 변경됐어요. 창을 닫고 최신 내용을 확인해 주세요.');
      assert.deepEqual(view.urls, []);
    } finally { view.clear(); }
    assert.deepEqual(revoked, []);
  });
});

test('cleared generations and disconnected slots discard delayed reads before permission callbacks and URL creation', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created }) => {
    for (const mode of ['cleared', 'disconnected']) {
      const blob = blobFixture(), target = slot(blob), read = deferred();
      let checked = 0;
      const view = new MediaView({ read: () => read.promise }, { canDisplay: () => { checked++; return true; } });
      try {
        const pending = view.hydrate(root(target));
        if (mode === 'cleared') view.clear(); else target.isConnected = false;
        read.resolve(blob); await pending;
        assert.equal(checked, 0); assert.equal(created.length, 0); assert.deepEqual(target.children, []);
      } finally { view.clear(); }
    }
  });
});

test('a missing or mismatched historical Blob uses the configured notice without a URL or download link', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created }) => {
    const expected = blobFixture(), message = '기록 당시 첨부를 찾지 못했어요. 현재 원본으로 대체하지 않았어요.';
    for (const actual of [null, blobFixture('video/webm'), blobFixture('image/png', 5)]) {
      const target = slot(expected);
      let asked = 0;
      const view = new MediaView({ read: async () => actual }, { missingMessage: (candidate) => {
        assert.equal(candidate, target); asked++; return message;
      } });
      try {
        await view.hydrate(root(target));
        assert.equal(asked, 1); assert.equal(created.length, 0);
        assert.equal(target.children.length, 1); assert.equal(target.children[0].textContent, message);
        assert.equal(target.children[0].tagName, 'SPAN'); assert.deepEqual(view.urls, []);
      } finally { view.clear(); }
    }
  });
});

test('ordinary MediaView defaults still render valid images and videos and revoke every URL on clear', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created, revoked }) => {
    const image = blobFixture(), video = blobFixture('video/webm', 8);
    const imageSlot = slot(image, 'image'), videoSlot = slot(video, 'video');
    const readIds = [], values = new Map([['image', image], ['video', video]]);
    const view = new MediaView({ read: async (id) => { readIds.push(id); return values.get(id); } });
    try {
      await view.hydrate(root(imageSlot, videoSlot));
      assert.deepEqual(readIds, ['image', 'video']); assert.equal(created.length, 2);
      const [imageElement, imageDownload] = imageSlot.children, [videoElement, videoDownload] = videoSlot.children;
      assert.equal(imageElement.tagName, 'IMG'); assert.equal(imageElement.alt, imageSlot.dataset.name); assert.equal(imageElement.loading, 'lazy');
      assert.equal(videoElement.tagName, 'VIDEO'); assert.equal(videoElement.controls, true); assert.equal(videoElement.playsInline, true);
      assert.equal(videoElement.preload, 'metadata'); assert.equal(videoElement.attributes['aria-label'], videoSlot.dataset.name);
      for (const [element, download, target] of [[imageElement, imageDownload, imageSlot], [videoElement, videoDownload, videoSlot]]) {
        assert.equal(download.tagName, 'A'); assert.equal(download.href, element.src);
        assert.equal(download.download, target.dataset.name); assert.equal(download.textContent, '원본 다운로드');
      }
      assert.deepEqual(view.urls, created.map((entry) => entry.value));
    } finally { view.clear(); }
    assert.deepEqual(revoked, created.map((entry) => entry.value)); assert.deepEqual(view.urls, []);
  });
});

test('ordinary missing-media fallback is retained when no custom notice is configured', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created }) => {
    for (const options of [undefined, { missingMessage: () => null }]) {
      const target = slot(blobFixture()), view = new MediaView({ read: async () => null }, options);
      try {
        await view.hydrate(root(target));
        assert.equal(created.length, 0); assert.equal(target.children.length, 1);
        assert.equal(target.children[0].textContent, '이 브라우저에서 원본을 찾지 못했어요. 파일을 다시 첨부해 주세요.');
      } finally { view.clear(); }
    }
  });
});

test('clear detaches owned previews and download links, removes error listeners and stops video before revoking URLs', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created, revoked, onRevoke }) => {
    const image = blobFixture(), video = blobFixture('video/webm', 8);
    const imageSlot = slot(image, 'image'), videoSlot = slot(video, 'video');
    const values = new Map([['image', image], ['video', video]]);
    const view = new MediaView({ read: async (id) => values.get(id) });
    try {
      await view.hydrate(root(imageSlot, videoSlot));
      const [imageElement, imageDownload] = imageSlot.children, [videoElement, videoDownload] = videoSlot.children;
      assert.equal(typeof imageElement.events.error, 'function'); assert.equal(typeof videoElement.events.error, 'function');
      let probes = 0;
      onRevoke(() => {
        probes++;
        for (const preview of [imageElement, videoElement]) {
          assert.equal(preview.getAttribute('src'), null, 'media source must be removed before revocation');
          assert.equal(preview.events.error, undefined, 'revocation must not invoke the obsolete error handler');
          assert.equal(preview.parentNode, null);
        }
        assert.equal(imageDownload.parentNode, null); assert.equal(videoDownload.parentNode, null);
        assert.equal(videoElement.paused, true); assert.equal(videoElement.pauseCalls, 1); assert.equal(videoElement.loadCalls, 1);
        for (const target of [imageSlot, videoSlot]) {
          assert.deepEqual(target.children.map((child) => child.tagName), ['SPAN']);
          assert.equal(target.children[0].textContent, '첨부파일 불러오는 중…');
        }
      });
      view.clear();
      assert.equal(probes, 2); assert.deepEqual(revoked, created.map((row) => row.value));
      assert.deepEqual(view.previews, []); assert.deepEqual(view.urls, []);
      view.clear(); assert.equal(probes, 2, 'clearing twice does not repeat cleanup or revocation');
    } finally { onRevoke(() => {}); view.clear(); }
  });
});

test('rehydration hides obsolete media and download links throughout a deferred store read', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, created, revoked }) => {
    const blob = blobFixture(), target = slot(blob), nextRead = deferred();
    let reads = 0;
    const view = new MediaView({ read: () => ++reads === 1 ? Promise.resolve(blob) : nextRead.promise });
    let pending;
    try {
      await view.hydrate(root(target));
      const [oldPreview, oldDownload] = target.children, oldUrl = oldPreview.src;
      pending = view.hydrate(root(target));
      assert.equal(reads, 2); assert.deepEqual(revoked, [oldUrl]);
      assert.equal(oldPreview.parentNode, null); assert.equal(oldPreview.getAttribute('src'), null);
      assert.equal(oldDownload.parentNode, null); assert.equal(oldPreview.events.error, undefined);
      assert.equal(target.children.some((child) => ['IMG', 'VIDEO', 'A'].includes(child.tagName)), false);
      assert.equal(target.children[0].textContent, '첨부파일 불러오는 중…');
      assert.equal(created.length, 1, 'the next URL cannot exist before the delayed read resolves');
      nextRead.resolve(blob); await pending;
      assert.equal(created.length, 2); assert.equal(target.children[0].tagName, 'IMG');
      assert.notEqual(target.children[0], oldPreview); assert.notEqual(target.children[0].src, oldUrl);
      assert.equal(target.children[1].tagName, 'A'); assert.notEqual(target.children[1], oldDownload);
    } finally { nextRead.resolve(blob); await pending; view.clear(); }
    assert.equal(revoked.length, 2);
  });
});

test('clear preserves nodes owned by another renderer, including foreign siblings beside an owned preview', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, element, created, revoked }) => {
    for (const mode of ['replacement', 'sibling']) {
      const blob = blobFixture(), target = slot(blob), foreign = element('span');
      foreign.textContent = `FOREIGN-${mode}`;
      const view = new MediaView({ read: async () => blob });
      try {
        await view.hydrate(root(target));
        const [preview, download] = target.children;
        if (mode === 'replacement') target.replaceChildren(foreign); else target.append(foreign);
        view.clear();
        assert.equal(foreign.parentNode, target, `${mode}: foreign content must not be removed`);
        assert.equal(target.children.includes(foreign), true); assert.equal(foreign.textContent, `FOREIGN-${mode}`);
        assert.equal(preview.parentNode, null); assert.equal(download.parentNode, null);
        assert.equal(preview.getAttribute('src'), null); assert.equal(preview.events.error, undefined);
        if (mode === 'replacement') assert.deepEqual(target.children, [foreign]);
      } finally { view.clear(); }
    }
    assert.equal(created.length, 2); assert.equal(revoked.length, 2);
  });
});

test('clear owns the decode-error fallback too, and a captured stale error handler cannot replace the next preview', { concurrency: false }, async () => {
  await withMediaDom(async ({ slot, root, element, created, revoked }) => {
    const blob = blobFixture(), target = slot(blob), foreign = element('span');
    foreign.textContent = 'FOREIGN-STATUS';
    const view = new MediaView({ read: async () => blob });
    try {
      await view.hydrate(root(target));
      const [oldPreview, oldDownload] = target.children, oldError = oldPreview.events.error;
      target.append(foreign); oldError();
      const fallback = target.children[0];
      assert.equal(fallback.tagName, 'SPAN'); assert.match(fallback.textContent, /미리볼 수 없는 파일/);
      assert.equal(oldPreview.parentNode, null); assert.equal(oldDownload.parentNode, target);
      assert.equal(view.previews[0].displayNode, fallback);
      view.clear();
      assert.equal(fallback.parentNode, null); assert.equal(oldDownload.parentNode, null);
      assert.equal(foreign.parentNode, target); assert.equal(target.children.includes(foreign), true);
      assert.equal(target.children[0].textContent, '첨부파일 불러오는 중…');
      assert.equal(oldPreview.getAttribute('src'), null); assert.equal(oldPreview.events.error, undefined);
      oldError();
      assert.equal(target.children[0].textContent, '첨부파일 불러오는 중…');
      await view.hydrate(root(target));
      const currentChildren = [...target.children];
      assert.equal(currentChildren[0].tagName, 'IMG');
      oldError();
      assert.deepEqual(target.children, currentChildren, 'a stale decoder event cannot overwrite a new generation');
      assert.equal(created.length, 2); assert.equal(revoked.length, 1);
    } finally { view.clear(); }
    assert.equal(revoked.length, 2);
  });
});
