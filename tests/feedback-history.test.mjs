import assert from 'node:assert/strict';
import test from 'node:test';
import { seed } from '../src/seed.js';
import { mutate, project, validateState } from '../src/domain.js';
import { upgradeState, conversationView } from '../src/conversations.js';
import { BACKUP_KEY, load, persist } from '../src/repository.js';
import { STORAGE_KEY } from '../src/config.js';

// Synthetic domain data and attachment metadata only. No browser persistence,
// real media bytes, database, accounts, APIs, or external service is accessed.
const guardian = { id:'p1', role:'guardian' };
const therapist = { id:'t1', role:'therapist' };
const manager = { id:'m1', role:'center' };
const peer = { id:'p2', role:'guardian' };
const replacement = { id:'t2', role:'therapist' };
const at = '2026-10-08T00:00:00.000Z', later = '2026-10-08T01:00:00.000Z';
const oldPhoto = { id:'history-old-photo', name:'SYNTHETIC-OLD.png', type:'image/png', size:32, share:true };
const newVideo = { id:'history-new-video', name:'SYNTHETIC-NEW.webm', type:'video/webm', size:64, share:true };
const sourceView = (db, id, actor = therapist) => conversationView(db,actor,'c1').messages.find((row) => row.id === id);
function fixture() {
  let db = upgradeState(seed());
  db = mutate(db,guardian,'feedback',{ childId:'c1', publicationId:'pub1', date:'2026-10-08', result:'partial',
    reaction:'F1 합성 활동 반응', difficulty:'F1 합성 어려움', attachments:[oldPhoto] },at);
  const feedbackId = db.feedback.at(-1).id;
  const messageId = db.messages.find((row) => row.type === 'feedback' && row.sourceId === feedbackId).id;
  return { db,feedbackId,messageId };
}
function revise(db, feedbackId, extra = {}) {
  return mutate(db,guardian,'feedback',{ childId:'c1', id:feedbackId, publicationId:'pub1', date:'2026-10-08', result:'done',
    reaction:'F2 합성 활동 반응', difficulty:'F2 합성 어려움', attachments:[newVideo], ...extra },later);
}
function reply(db, messageId, extra = {}) {
  return mutate(db,therapist,'message',{ childId:'c1', clientId:crypto.randomUUID(), body:'합성 독립 답변', replyTo:messageId,
    expectedReplyVersion:sourceView(db,messageId)?.version ?? 1, attachments:[], ...extra },at);
}
function reference(db, messageId, extra = {}) {
  return mutate(db,therapist,'record',{ childId:'c1', goalId:'g1', date:'2026-10-08', performed:'합성 회기 관찰',
    referenceMessageIds:[messageId], expectedReferenceVersions:[{ messageId,version:sourceView(db,messageId)?.version ?? 1 }], ...extra },at);
}
const savedReference = (db, recordId, messageId) => project(db,therapist,'c1').records
  .find((row) => row.id === recordId).referenceSources.find((source) => source.messageId === messageId);
function noPrivateQuote(quote) {
  assert.doesNotMatch(JSON.stringify(quote),/SYNTHETIC-PRIVATE-REVIEW|reviewNote|reviewedAt|SYNTHETIC-OLD|SYNTHETIC-NEW|history-old-photo|history-new-video/);
}

test('an existing reply keeps feedback F1 after its source is edited to F2', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId);
  const replyId = db.messages.at(-1).id;
  assert.equal(sourceView(db,replyId).quote.body,'F1 합성 활동 반응');
  db = revise(db,feedbackId);
  assert.equal(sourceView(db,messageId).body,'F2 합성 활동 반응');
  assert.equal(sourceView(db,replyId).quote.body,'F1 합성 활동 반응');
  assert.equal(validateState(db),true);
});

test('a saved clinical reference keeps feedback F1 content and files after a source edit', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId);
  const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  const record = project(db,therapist,'c1').records.find((row) => row.id === recordId);
  const saved = record.referenceSources.find((source) => source.messageId === messageId);
  assert.ok(saved,'a feedback reference must capture the selected source, not only its mutable ID');
  assert.equal(saved.body,'F1 합성 활동 반응');
  assert.deepEqual(saved.attachments,[oldPhoto]);
  assert.equal(saved.version,1);
  assert.deepEqual(saved.feedback,{ id:feedbackId,publicationId:'pub1',date:'2026-10-08',result:'partial',reaction:'F1 합성 활동 반응',difficulty:'F1 합성 어려움' });
  assert.equal(validateState(db),true);
});

test('editing feedback changes one current card, preserves its anchor, and keeps old and new replies distinct', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId); const firstReply = db.messages.at(-1).id;
  const originalMessage = structuredClone(db.messages.find((row) => row.id === messageId));
  db = revise(db,feedbackId);
  db = reply(db,messageId); const secondReply = db.messages.at(-1).id;
  assert.equal(sourceView(db,firstReply).quote.body,'F1 합성 활동 반응');
  assert.equal(sourceView(db,secondReply).quote.body,'F2 합성 활동 반응');
  assert.equal(sourceView(db,firstReply).quote.changed,true);
  assert.notEqual(sourceView(db,secondReply).quote.changed,true);
  assert.equal(sourceView(db,firstReply).quote.version,1);
  assert.equal(sourceView(db,secondReply).quote.version,2);
  assert.equal(sourceView(db,messageId).version,2);
  assert.equal(sourceView(db,messageId).feedback.revision,2);
  assert.deepEqual(sourceView(db,messageId).attachments,[newVideo]);
  assert.equal(db.messages.filter((row) => row.type === 'feedback' && row.sourceId === feedbackId).length,1);
  const currentMessage = db.messages.find((row) => row.id === messageId);
  for (const key of ['id','sequence','createdAt','conversationId','childId','sourceId','authorId'])
    assert.equal(currentMessage[key],originalMessage[key]);
  noPrivateQuote(sourceView(db,firstReply).quote); noPrivateQuote(sourceView(db,secondReply).quote);
  assert.equal(validateState(db),true);
});

test('record edits and later source revisions cannot overwrite the originally selected feedback snapshot', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  const captured = structuredClone(savedReference(db,recordId,messageId));
  assert.ok(captured);
  db = revise(db,feedbackId);
  db = reference(db,messageId,{ id:recordId, performed:'합성 회기 기록만 수정',expectedReferenceVersions:[{messageId,version:1}] });
  assert.deepEqual(savedReference(db,recordId,messageId),captured);
  db = revise(db,feedbackId,{ reaction:'F3 합성 활동 반응', difficulty:'F3 합성 어려움', attachments:[] });
  assert.deepEqual(savedReference(db,recordId,messageId),captured);
  assert.deepEqual(sourceView(db,messageId).attachments,[]);
  assert.deepEqual(captured.attachments,[oldPhoto]);
  assert.equal(captured.body,'F1 합성 활동 반응');
  assert.equal(validateState(db),true);
});

test('review confirmation resets on source edit without exposing private notes or revision internals to guardians', () => {
  let { db,feedbackId,messageId } = fixture();
  db = mutate(db,therapist,'review',{ childId:'c1', id:feedbackId, reviewNote:'SYNTHETIC-PRIVATE-REVIEW-F1' },at);
  assert.equal(sourceView(db,messageId,guardian).feedback.reviewed,true);
  assert.equal(sourceView(db,messageId).feedback.reviewNote,'SYNTHETIC-PRIVATE-REVIEW-F1');
  db = reply(db,messageId); const replyId = db.messages.at(-1).id;
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  const guardianProjection = project(db,guardian,'c1');
  assert.equal(guardianProjection.records.length,0);
  assert.equal(sourceView(db,messageId,guardian).feedback.reviewed,false);
  assert.equal(sourceView(db,messageId).feedback.reviewed,false);
  assert.equal(db.feedback.find((row) => row.id === feedbackId).history[0].reviewNote,'SYNTHETIC-PRIVATE-REVIEW-F1');
  assert.doesNotMatch(JSON.stringify(guardianProjection),/SYNTHETIC-PRIVATE-REVIEW|reviewNote|reviewedAt|history-old-photo|F1 합성/);
  assert.doesNotMatch(JSON.stringify(sourceView(db,messageId,guardian)),/SYNTHETIC-PRIVATE-REVIEW|reviewNote|reviewedAt|history-old-photo|F1 합성/);
  const quote = sourceView(db,replyId,guardian).quote;
  assert.equal(quote.body,'F1 합성 활동 반응'); noPrivateQuote(quote);
  assert.equal(savedReference(db,recordId,messageId).body,'F1 합성 활동 반응');
  const centerView = project(db,manager,'c1');
  assert.deepEqual(centerView.records,[]); assert.deepEqual(centerView.feedback,[]);
  assert.throws(() => conversationView(db,manager,'c1'));
  assert.equal(validateState(db),true);
});

test('save and reload retain pinned feedback replies and references without restoring old files to the current card', () => {
  const initial = fixture(); let { db,feedbackId,messageId } = initial;
  const map = new Map([[STORAGE_KEY,JSON.stringify(db)]]);
  const storage = { getItem:(key) => map.get(key) ?? null, setItem:(key,value) => map.set(key,value) };
  db = reply(db,messageId); const replyId = db.messages.at(-1).id;
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  persist(storage,db,initial.db.revision);
  const loaded = load(storage,{ requireExisting:true });
  assert.equal(loaded.error,null); assert.deepEqual(loaded.db,db);
  assert.equal(sourceView(loaded.db,replyId).quote.body,'F1 합성 활동 반응');
  assert.equal(savedReference(loaded.db,recordId,messageId).body,'F1 합성 활동 반응');
  assert.deepEqual(savedReference(loaded.db,recordId,messageId).attachments,[oldPhoto]);
  assert.deepEqual(sourceView(loaded.db,messageId).attachments,[newVideo]);
  const before = structuredClone(loaded.db);
  project(loaded.db,guardian,'c1'); conversationView(loaded.db,guardian,'c1'); conversationView(loaded.db,therapist,'c1');
  assert.deepEqual(loaded.db,before);
  assert.equal(validateState(loaded.db),true);
});

test('future-only newcomer cannot retrieve a feedback history by following a later reply or a source edit', () => {
  let { db,feedbackId,messageId } = fixture();
  db = mutate(db,manager,'relationships',{ childId:'c1', therapistId:'t1', guardianIds:['p1','p2'], historyConfirmed:true },later);
  db = revise(db,feedbackId);
  db = reply(db,messageId); const replyId = db.messages.at(-1).id;
  const quote = sourceView(db,replyId,peer).quote;
  assert.equal(quote.hidden,true); assert.equal(quote.body,'열람 범위 밖의 대화입니다.');
  assert.equal('authorId' in quote,false);
  assert.doesNotMatch(JSON.stringify(quote),/F1 합성|F2 합성|사진|동영상|history-old-photo|history-new-video/);
  assert.equal(sourceView(db,messageId,peer),undefined);
  assert.deepEqual(project(db,peer,'c1').feedback,[]);
  assert.throws(() => mutate(db,peer,'message',{ childId:'c1', clientId:crypto.randomUUID(), body:'차단되어야 하는 답변', replyTo:messageId },later));
  assert.equal(sourceView(db,replyId,guardian).quote.body,'F2 합성 활동 반응');
  assert.equal(validateState(db),true);
});

test('disconnection and future-only therapist reconnection do not grant old feedback or clinical references', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  db = mutate(db,manager,'relationships',{ childId:'c1', therapistId:'t2', guardianIds:['p1'], historyConfirmed:true },later);
  assert.throws(() => conversationView(db,therapist,'c1'));
  assert.equal(sourceView(db,messageId,replacement),undefined);
  assert.deepEqual(project(db,replacement,'c1').records,[]);
  assert.throws(() => mutate(db,replacement,'record',{ childId:'c1', goalId:'g1', date:'2026-10-08', performed:'합성 새 기록', referenceMessageIds:[messageId] },later));
  db = mutate(db,manager,'relationships',{ childId:'c1', therapistId:'t1', guardianIds:['p1'], historyConfirmed:true },later);
  assert.equal(sourceView(db,messageId),undefined);
  assert.equal(project(db,therapist,'c1').records.some((row) => row.id === recordId),false);
  assert.throws(() => reference(db,messageId));
  assert.equal(validateState(db),true);
});

test('withdrawal hides guardian quotes but keeps already-authorized therapist clinical feedback snapshots', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId); const replyId = db.messages.at(-1).id;
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  db = mutate(db,therapist,'unpublish',{ childId:'c1', id:'r1' },later);
  const quote = sourceView(db,replyId,guardian).quote;
  assert.equal(quote.hidden,true); assert.equal(quote.body,'공유가 종료된 기록입니다.');
  assert.doesNotMatch(JSON.stringify(quote),/F1 합성|F2 합성|사진|동영상/); noPrivateQuote(quote);
  assert.deepEqual(sourceView(db,messageId,guardian).attachments,[]);
  assert.deepEqual(project(db,guardian,'c1').feedback,[]);
  assert.equal(sourceView(db,replyId).quote.body,'F1 합성 활동 반응');
  assert.equal(savedReference(db,recordId,messageId).body,'F1 합성 활동 반응');
  assert.deepEqual(savedReference(db,recordId,messageId).attachments,[oldPhoto]);
  assert.throws(() => reply(db,messageId));
  assert.throws(() => revise(db,feedbackId));
  assert.equal(validateState(db),true);
});

test('stale replies and new references are rejected while an identical sent-reply retry preserves its original source version', () => {
  let { db,feedbackId,messageId } = fixture();
  const clientId = crypto.randomUUID();
  db = reply(db,messageId,{ clientId,expectedReplyVersion:1 });
  const replyId = db.messages.at(-1).id;
  db = revise(db,feedbackId); const before = structuredClone(db);
  assert.throws(() => reply(db,messageId,{ expectedReplyVersion:1 }),/수정|버전|최신/);
  assert.throws(() => reference(db,messageId,{ expectedReferenceVersions:[{messageId,version:1}] }),/수정|버전|최신/);
  assert.deepEqual(db,before);
  db = reply(db,messageId,{ clientId,expectedReplyVersion:1 });
  assert.equal(db.messages.filter((row) => row.id === replyId).length,1);
  assert.equal(sourceView(db,replyId).quote.version,1);
  assert.equal(sourceView(db,replyId).quote.body,'F1 합성 활동 반응');
  assert.equal(validateState(db),true);
});

test('removing and re-adding a clinical reference requires the current feedback version instead of reviving the removed snapshot', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  const original = structuredClone(savedReference(db,recordId,messageId));
  db = revise(db,feedbackId);
  db = reference(db,messageId,{ id:recordId,expectedReferenceVersions:[{messageId,version:1}] });
  assert.deepEqual(savedReference(db,recordId,messageId),original);
  db = reference(db,messageId,{ id:recordId,referenceMessageIds:[],expectedReferenceVersions:[] });
  assert.equal(savedReference(db,recordId,messageId),undefined);
  assert.throws(() => reference(db,messageId,{ id:recordId,expectedReferenceVersions:[{messageId,version:1}] }),/수정|버전|최신/);
  db = reference(db,messageId,{ id:recordId,expectedReferenceVersions:[{messageId,version:2}] });
  const replacementSource = savedReference(db,recordId,messageId);
  assert.equal(replacementSource.version,2); assert.equal(replacementSource.body,'F2 합성 활동 반응');
  assert.deepEqual(replacementSource.attachments,[newVideo]);
  assert.equal(validateState(db),true);
});

test('an existing F1 reference rejects an explicitly mismatched version but preserves F1 when selected or omitted', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  const original = structuredClone(savedReference(db,recordId,messageId));
  db = revise(db,feedbackId);
  const before = structuredClone(db);
  assert.equal(sourceView(db,messageId).version,2);
  for (const version of [2,999]) {
    assert.throws(() => reference(db,messageId,{ id:recordId,expectedReferenceVersions:[{messageId,version}] }));
    assert.deepEqual(db,before);
  }
  const selected = reference(db,messageId,{ id:recordId,expectedReferenceVersions:[{messageId,version:1}] });
  assert.deepEqual(savedReference(selected,recordId,messageId),original);
  // Omit the property itself, not just its value, to exercise legacy re-save.
  const omitted = mutate(db,therapist,'record',{ childId:'c1',id:recordId,goalId:'g1',date:'2026-10-08',
    performed:'합성 기존 참고 재저장',referenceMessageIds:[messageId] },later);
  assert.deepEqual(savedReference(omitted,recordId,messageId),original);
  assert.equal(validateState(selected),true); assert.equal(validateState(omitted),true);
  assert.deepEqual(db,before);
});

test('feedback snapshot validation rejects mismatched versions, content, attachments and copied private fields', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  db = revise(db,feedbackId);
  for (const patch of [
    {version:99}, {body:'합성 변조 내용'}, {attachments:[newVideo]},
    {feedback:{ id:feedbackId,publicationId:'pub1',date:'2026-10-08',result:'done',reaction:'합성 변조',difficulty:'' }},
    {reviewNote:'SYNTHETIC-PRIVATE-REVIEW'},
  ]) {
    const damaged = structuredClone(db);
    Object.assign(damaged.records.find((row) => row.id === recordId).referenceSources.find((source) => source.messageId === messageId),patch);
    assert.equal(validateState(damaged),false);
  }
  assert.equal(validateState(db),true);
});

test('legacy ID-only replies and clinical references freeze the still-available F1 before the first source edit', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId); const replyId = db.messages.at(-1).id;
  db = reference(db,messageId); const recordId = db.records.at(-1).id;
  // Model only a valid old schema-3 shape. This cannot recover content already
  // overwritten before history support existed; it freezes the available head.
  delete db.feedback.find((row) => row.id === feedbackId).history;
  delete db.messages.find((row) => row.id === replyId).replyVersion;
  db.records.find((row) => row.id === recordId).referenceSources = [];
  assert.equal(validateState(db),true);
  db = revise(db,feedbackId);
  assert.equal(sourceView(db,replyId).quote.body,'F1 합성 활동 반응');
  assert.equal(sourceView(db,replyId).quote.version,1);
  const saved = savedReference(db,recordId,messageId);
  assert.ok(saved); assert.equal(saved.body,'F1 합성 활동 반응');
  assert.deepEqual(saved.attachments,[oldPhoto]);
  assert.equal(validateState(db),true);
});

test('schema-2 and schema-3 legacy text is preserved byte-for-byte through reload and its first feedback revision', () => {
  for (const schema of [2,3]) {
    const fresh = fixture();
    let db = schema === 2 ? seed() : fresh.db;
    const old = structuredClone(fresh.db.feedback.find((row) => row.id === fresh.feedbackId));
    Object.assign(old,{ reaction:`  LEGACY-${'가'.repeat(1001)}\n `, difficulty:' \t ', reviewed:true,
      reviewNote:` SYNTHETIC-PRIVATE-REVIEW-${'메'.repeat(2001)} `, reviewedAt:at });
    delete old.history;
    if (schema === 2) db.feedback.push(old);
    else Object.assign(db.feedback.find((row) => row.id === old.id),old);
    assert.equal(validateState(db),true);
    const raw = JSON.stringify(db), map = new Map([[STORAGE_KEY,raw]]);
    const storage = { getItem:(key) => map.get(key) ?? null, setItem:(key,value) => map.set(key,value) };
    const loaded = load(storage,{ requireExisting:true });
    assert.equal(loaded.error,null);
    assert.deepEqual(loaded.db.feedback.find((row) => row.id === old.id),old);
    if (schema === 2) assert.equal(map.get(BACKUP_KEY),raw);
    else assert.equal(map.get(STORAGE_KEY),raw);
    db = loaded.db;
    const messageId = db.messages.find((row) => row.type === 'feedback' && row.sourceId === old.id).id;
    db = reply(db,messageId); const replyId = db.messages.at(-1).id;
    db = reference(db,messageId); const recordId = db.records.at(-1).id;
    db = revise(db,old.id,{ expectedVersion:1 });
    const historical = db.feedback.find((row) => row.id === old.id).history[0];
    for (const key of ['reaction','difficulty','reviewNote','reviewedAt','attachments']) assert.deepEqual(historical[key],old[key]);
    assert.equal(sourceView(db,replyId).quote.body,old.reaction);
    assert.equal(savedReference(db,recordId,messageId).body,old.reaction);
    assert.deepEqual(savedReference(db,recordId,messageId).attachments,[oldPhoto]);
    assert.equal(validateState(db),true);
  }
});

test('malformed feedback history shapes, dates, attachments and timeline order return false instead of throwing', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId);
  db = reference(db,messageId);
  db = revise(db,feedbackId);
  const isolated = fixture();
  const isolatedDb = revise(isolated.db,isolated.feedbackId);
  const malformed = [
    (f) => { f.history = null; },
    (f) => { f.history = {}; },
    (f) => { f.history = {length:1}; },
    (f) => { f.history = []; },
    (f) => { f.history = [null]; },
    (f) => { f.history = ['not-a-snapshot']; },
    (f) => { f.history[0].date = '2026-02-30'; },
    (f) => { f.history[0].date = 'not-a-date'; },
    (f) => { f.history[0].updatedAt = 'not-a-time'; },
    (f) => { f.history[0].updatedAt = '2026-10-09T00:00:00.000Z'; },
    (f) => { f.history[0].reviewedAt = 'not-a-time'; },
    (f) => { f.history[0].reviewed = 'true'; },
    (f) => { f.history[0].reaction = null; },
    (f) => { f.history[0].attachments = null; },
    (f) => { f.history[0].attachments = {}; },
    (f) => { f.history[0].attachments = [{...oldPhoto,size:-1}]; },
    (f) => { f.history[0].attachments = [oldPhoto,oldPhoto]; },
    (f) => { f.history[0].unexpected = true; },
  ];
  // Exercise both history itself and snapshots that reference it, so an
  // invalid date cannot appear covered merely because reference equality fails.
  for (const state of [{ db,feedbackId,label:'referenced' },{ db:isolatedDb,feedbackId:isolated.feedbackId,label:'unreferenced' }])
    for (const [index,damage] of malformed.entries()) {
      const invalid = structuredClone(state.db); damage(invalid.feedback.find((row) => row.id === state.feedbackId));
      let result;
      assert.doesNotThrow(() => { result = validateState(invalid); },`${state.label} invalid history case ${index}`);
      assert.equal(result,false,`${state.label} invalid history case ${index}`);
      const raw = JSON.stringify(invalid), map = new Map([[STORAGE_KEY,raw]]);
      const storage = { getItem:(key) => map.get(key) ?? null, setItem:() => assert.fail('invalid state must never be rewritten') };
      const loaded = load(storage,{ requireExisting:true });
      assert.equal(loaded.db,null); assert.equal(typeof loaded.error,'string'); assert.equal(map.get(STORAGE_KEY),raw);
    }
  assert.equal(validateState(db),true);
});

test('stale feedback edit and review cannot change the source, and each successful edit preserves its old private review', () => {
  let { db,feedbackId,messageId } = fixture();
  db = mutate(db,therapist,'review',{ childId:'c1', id:feedbackId, expectedVersion:1, reviewNote:'SYNTHETIC-PRIVATE-REVIEW-F1' },at);
  db = revise(db,feedbackId,{ expectedVersion:1 });
  const before = structuredClone(db);
  assert.throws(() => revise(db,feedbackId,{ expectedVersion:1,reaction:'차단될 합성 내용' }),/수정|버전|최신/);
  assert.throws(() => mutate(db,therapist,'review',{ childId:'c1',id:feedbackId,expectedVersion:1,reviewNote:'차단될 합성 메모' },later),/수정|버전|최신/);
  assert.deepEqual(db,before);
  db = mutate(db,therapist,'review',{ childId:'c1', id:feedbackId, expectedVersion:2, reviewNote:'SYNTHETIC-PRIVATE-REVIEW-F2' },later);
  assert.equal(sourceView(db,messageId).feedback.reviewed,true);
  db = revise(db,feedbackId,{ expectedVersion:2,reaction:'F3 합성 활동 반응',attachments:[] });
  const f = db.feedback.find((row) => row.id === feedbackId);
  assert.equal(f.history[0].reviewNote,'SYNTHETIC-PRIVATE-REVIEW-F1');
  assert.equal(f.history[1].reviewNote,'SYNTHETIC-PRIVATE-REVIEW-F2');
  assert.equal(f.history[0].reviewed,true); assert.equal(f.history[1].reviewed,true);
  assert.equal(f.reviewed,false); assert.equal(f.reviewNote,''); assert.equal('reviewedAt' in f,false);
  assert.equal(sourceView(db,messageId).version,3);
  assert.doesNotMatch(JSON.stringify(project(db,guardian,'c1')),/SYNTHETIC-PRIVATE-REVIEW/);
  assert.equal(validateState(db),true);
});

test('a failed save or stale storage revision leaves the old feedback, source snapshots and storage intact', () => {
  let { db,feedbackId,messageId } = fixture();
  db = reply(db,messageId);
  db = reference(db,messageId);
  db = mutate(db,therapist,'review',{ childId:'c1', id:feedbackId, expectedVersion:1, reviewNote:'SYNTHETIC-PRIVATE-REVIEW-F1' },at);
  const original = structuredClone(db), raw = JSON.stringify(db), map = new Map([[STORAGE_KEY,raw]]);
  const candidate = revise(db,feedbackId,{ expectedVersion:1 });
  assert.deepEqual(db,original);
  const failedStorage = { getItem:(key) => map.get(key) ?? null, setItem:() => { throw new Error('synthetic storage quota'); } };
  assert.throws(() => persist(failedStorage,candidate,db.revision),/저장/);
  assert.equal(map.get(STORAGE_KEY),raw); assert.deepEqual(db,original);
  const recovered = load(failedStorage,{ requireExisting:true });
  assert.equal(recovered.error,null); assert.deepEqual(recovered.db,original);
  assert.equal(candidate.feedback.find((row) => row.id === feedbackId).history[0].reviewNote,'SYNTHETIC-PRIVATE-REVIEW-F1');
  const newer = mutate(db,guardian,'concern',{ childId:'c1',concern:'합성 다른 탭 변경' },later);
  map.set(STORAGE_KEY,JSON.stringify(newer));
  const writableStorage = { getItem:(key) => map.get(key) ?? null, setItem:(key,value) => map.set(key,value) };
  assert.throws(() => persist(writableStorage,candidate,db.revision),/다른 탭/);
  assert.equal(map.get(STORAGE_KEY),JSON.stringify(newer));
  assert.deepEqual(db,original); assert.equal(validateState(candidate),true);
});
