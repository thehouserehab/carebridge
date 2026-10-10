import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seed } from '../src/seed.js';
import { upgradeState, conversationView, messageProjection } from '../src/conversations.js';
import { mutate, project, validateState } from '../src/domain.js';
import { historyBoundary } from '../src/access.js';
import { load, persist } from '../src/repository.js';
import { STORAGE_KEY } from '../src/config.js';

const manager = { id:'m1', role:'center' }, therapist = { id:'t1', role:'therapist' }, guardian = { id:'p1', role:'guardian' };
const replacement = { id:'t2', role:'therapist' }, peer = { id:'p2', role:'guardian' };
const start = () => upgradeState(seed());
const connect = (db, extra = {}) => mutate(db, manager, 'relationships', {
  childId:'c1',therapistId:'t2',guardianIds:['p2'],historyConfirmed:true,...extra,
});
const send = (db, actor, clientId, extra = {}) => mutate(db, actor, 'message', {
  childId:'c1',clientId,body:'합성 관계 시험 소식',...extra,
});
const record = (db, extra = {}) => ({ childId:'c1',goalId:db.goals.find((g) => g.childId === 'c1').id,
  date:'2026-10-08',title:'합성 신규 기록',performed:'가상 활동',response:'가상 반응',nextPlan:'가상 계획',summary:'가상 요약',...extra });

test('legacy access is unchanged; new participants see only committed later news and new internal records', () => {
  const original = start();
  assert.ok(project(original, guardian, 'c1').publications.length);
  let db = connect(original);
  for (const actor of [replacement,peer]) {
    assert.deepEqual(conversationView(db,actor,'c1').messages,[]);
    assert.equal(conversationView(db,actor,'c1').unread,0);
    assert.deepEqual(project(db,actor,'c1').publications,[]);
    assert.deepEqual(project(db,actor,'c1').feedback,[]);
  }
  assert.deepEqual(project(db,replacement,'c1').records,[]);
  const oldRecord = original.records.find((r) => r.childId === 'c1');
  for (const action of ['publish','unpublish']) assert.throws(() => mutate(db,replacement,action,{childId:'c1',id:oldRecord.id}),/열람 범위/);
  assert.throws(() => mutate(db,replacement,'record',record(db,{id:oldRecord.id})),/열람 범위/);
  db = send(db,replacement,'history-after-news-01');
  assert.equal(conversationView(db,peer,'c1').messages.length,1);
  db = mutate(db,replacement,'record',record(db));
  assert.equal(project(db,replacement,'c1').records.length,1);
  assert.ok(project(db,replacement,'c1').records[0].createdRevision > historyBoundary(db,replacement,'c1').firstRecordRevision);
  for (const key of ['publications','feedback']) assert.deepEqual(db[key],original[key]);
  assert.deepEqual(db.records.filter((r) => original.records.some((old) => old.id === r.id)),original.records);
  assert.equal(validateState(db),true);
});

test('past news cannot be fetched, read, replied to, reviewed or used as a clinical reference', () => {
  const original = send(start(),guardian,'history-before-news-01');
  const message = original.messages.at(-1);
  let db = connect(original);
  for (const actor of [replacement,peer]) {
    assert.throws(() => messageProjection(db,actor,message));
    assert.throws(() => mutate(db,actor,'read',{childId:'c1',id:message.id}));
    assert.throws(() => send(db,actor,'history-blocked-reply-01',{replyTo:message.id}));
  }
  assert.throws(() => mutate(db,replacement,'message-review',{childId:'c1',id:message.id,reviewNote:'가상 확인'}));
  assert.throws(() => mutate(db,replacement,'record',record(db,{referenceMessageIds:[message.id]})),/열람 범위/);
  assert.throws(() => mutate(db,peer,'feedback',{childId:'c1',publicationId:'pub1',date:'2026-10-08',result:'done',reaction:'가상 반응'}));
  // A remaining participant may reply to old news, but its quote is redacted
  // for a newly connected peer without dropping that independent later reply.
  db = mutate(original,manager,'relationships',{childId:'c1',therapistId:'t1',guardianIds:['p1','p2'],historyConfirmed:true});
  db = send(db,therapist,'history-later-quote-01',{replyTo:message.id});
  const shown = conversationView(db,peer,'c1').messages[0];
  assert.equal(shown.quote.hidden,true);
  assert.equal(Object.hasOwn(shown.quote,'authorId'),false);
  assert.equal(shown.quote.body.includes(message.body),false);
  assert.equal(conversationView(db,guardian,'c1').messages.some((m) => m.id === message.id),true);
  db = mutate(db,guardian,'feedback',{childId:'c1',publicationId:'pub1',date:'2026-10-08',result:'done',reaction:'새로 도착한 합성 경험'});
  assert.equal(db.messages.at(-1).type,'feedback');
  assert.equal(conversationView(db,peer,'c1').messages.some((m) => m.type === 'feedback'),false);
  assert.deepEqual(project(db,peer,'c1').feedback,[]);
});

test('separate past confirmation expands only selected participants and resets only their read cursor', () => {
  let db = connect(start());
  db = send(db,replacement,'history-after-read-01');
  const id = db.messages.at(-1).id;
  for (const actor of [replacement,peer]) db = mutate(db,actor,'read',{childId:'c1',id});
  const before = structuredClone(db);
  const extra = { historyChoices:{p2:'all'} };
  assert.throws(() => connect(db,extra),/별도로 확인/);
  assert.throws(() => connect(db,{...extra,pastHistoryConfirmed:'true'}),/별도로 확인/);
  assert.deepEqual(db,before);
  db = connect(db,{...extra,pastHistoryConfirmed:true});
  assert.ok(project(db,peer,'c1').publications.length);
  assert.equal(conversationView(db,peer,'c1').lastRead,0);
  assert.equal(conversationView(db,replacement,'c1').lastRead,before.messages.at(-1).sequence);
  assert.deepEqual(project(db,replacement,'c1').records,[]);
  assert.equal(validateState(db),true);
});

test('disconnection denies access; reconnection starts again after now, including own old retries and feedback', () => {
  let db = send(start(),guardian,'history-old-own-message');
  const previous = structuredClone(db);
  db = connect(db);
  assert.throws(() => conversationView(db,guardian,'c1'));
  db = mutate(db,manager,'relationships',{childId:'c1',therapistId:'t1',guardianIds:['p1'],historyConfirmed:true});
  assert.deepEqual(conversationView(db,guardian,'c1').messages,[]);
  assert.throws(() => send(db,guardian,'history-old-own-message'));
  assert.throws(() => mutate(db,therapist,'review',{childId:'c1',id:previous.feedback.find((f) => f.childId === 'c1').id,reviewNote:'가상 확인'}));
  assert.deepEqual(db.messages,previous.messages);
  assert.equal(validateState(db),true);
});

test('additive policy survives save/reload and rejects damaged boundaries without rewriting legacy data', () => {
  const original = start();
  const db = connect(original);
  const map = new Map([[STORAGE_KEY,JSON.stringify(original)]]);
  const storage = {getItem:(key) => map.get(key) ?? null,setItem:(key,value) => map.set(key,value)};
  persist(storage,db,original.revision);
  assert.deepEqual(load(storage).db,db);
  for (const patch of [{firstSequence:0},{firstSequence:1.1},{firstRecordRevision:db.revision+1},{userId:'m1'},{unexpected:true}]) {
    const invalid = structuredClone(db); Object.assign(invalid.children[0].historyAccess[0],patch);
    assert.equal(validateState(invalid),false);
  }
  const duplicate = structuredClone(db); duplicate.children[0].historyAccess.push(structuredClone(duplicate.children[0].historyAccess[0]));
  assert.equal(validateState(duplicate),false);
  const damaged = structuredClone(db); damaged.records[0].createdRevision=-1;
  assert.equal(validateState(damaged),false);
  assert.deepEqual(original,start());
});

test('no-op full history preserves read cursors and inherited choices cannot grant old content', () => {
  let db = send(start(),therapist,'history-no-op-read-01');
  db = mutate(db,guardian,'read',{childId:'c1',id:db.messages.at(-1).id});
  const before = structuredClone(db);
  db = mutate(db,manager,'relationships',{childId:'c1',therapistId:'t1',guardianIds:['p1'],
    historyChoices:{p1:'all'},historyConfirmed:true,pastHistoryConfirmed:true});
  assert.deepEqual(db.readStates,before.readStates);
  assert.equal(db.children[0].historyAccess,undefined);
  const forged = Object.create({p2:'all'});
  db = connect(db,{historyChoices:forged});
  assert.deepEqual(project(db,peer,'c1').publications,[]);
});
