import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { messageReadStates } from '../message-read-states.mjs';

// Synthetic data in an in-memory database only. No environment/URL can redirect
// these fixtures or their resets into an operational database.
let database, chat, relationships, serial;
const therapist = { centerId:'center-a',userId:'therapist-a' };
const guardian = { centerId:'center-a',userId:'guardian-a' };
const peer = { centerId:'center-a',userId:'guardian-peer' };
const manager = { centerId:'center-a',userId:'manager-a' };
const requestId = () => `read-state-${++serial}`;
const send = (actor = therapist, extra = {}) => chat.sendText(actor,
  { conversationId:'room-a',clientId:requestId(),body:'합성 소식',...extra });
const get = (actor, message) => chat.get(actor,{conversationId:'room-a',messageId:message.id});
const list = (actor = therapist, extra = {}) => chat.list(actor,{conversationId:'room-a',...extra});
const read = (actor, message) => chat.markRead(actor,{conversationId:'room-a',messageId:message.id});
const member = (actor, history = 'preserve') => ({userId:actor.userId,history});
async function relations(guardians) {
  const current = await relationships.get(manager,{conversationId:'room-a'});
  return relationships.replace(manager,{conversationId:'room-a',clientId:requestId(),expectedVersion:current.version,
    historyConfirmed:true,pastHistoryConfirmed:true,therapist:member(therapist),guardians});
}
async function assertRead(actor, message, expected) {
  assert.equal((await get(actor,message)).read,expected);
  assert.equal((await list(actor)).messages.find(row=>row.id===message.id).read,expected);
}

before(async()=>{ database=await PGlite.create(); await migrate(database); });
after(async()=>{ await database?.close(); });
beforeEach(async()=>{
  await database.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('guardian-peer',true),
      ('manager-a',true),('therapist-b',true),('guardian-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),
      ('center-a','manager-a','center',true),('center-b','therapist-b','therapist',true),
      ('center-b','guardian-b','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),
      ('center-a','room-other','guardian-peer','guardian',true,1),
      ('center-b','room-b','therapist-b','therapist',true,1),
      ('center-b','room-b','guardian-b','guardian',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status)
      VALUES ('center-a','room-a','goal-a','합성 목표','active');`);
  chat=new Conversations(database); relationships=new Relationships(database); serial=0;
});

test('get and list distinguish the other participant cursor from the viewer own cursor',async()=>{
  const first=await send(),second=await send();
  await assertRead(therapist,first,false); await read(therapist,second);
  await assertRead(therapist,first,false);
  await read(guardian,first); await assertRead(therapist,first,true); await assertRead(therapist,second,false);
  await read(guardian,second); await assertRead(therapist,second,true);
  await assertRead(guardian,second,true);
});

test('all eligible recipients must acknowledge while other rooms and centers never count',async()=>{
  await relations([member(guardian),member(peer,'all')]);
  const message=await send(); await read(guardian,message); await assertRead(therapist,message,false);
  const other=await send(therapist,{conversationId:'room-other'});
  await chat.markRead(peer,{conversationId:'room-other',messageId:other.id});
  await assertRead(therapist,message,false);
  await read(peer,message); await assertRead(therapist,message,true);
});

test('zero currently eligible peers is not vacuously read',async()=>{
  await relations([]); const message=await send(); await read(therapist,message);
  await assertRead(therapist,message,false);
  await relations([member(peer,'from_now')]);
  await assertRead(therapist,message,false);
});

test('inactive participant, membership or account is excluded and fresh reads re-evaluate eligibility',async()=>{
  await relations([member(guardian),member(peer,'all')]);
  const message=await send(); await read(guardian,message);
  for(const [table,key,extra] of [
    ['cb_participants','user_id'," AND center_id='center-a' AND conversation_id='room-a'"],
    ['cb_memberships','user_id'," AND center_id='center-a'"],['cb_users','id',''],
  ]) {
    await assertRead(therapist,message,false);
    await database.query(`UPDATE ${table} SET active=false WHERE ${key}=$1${extra}`,[peer.userId]);
    await assertRead(therapist,message,true);
    await database.query(`UPDATE ${table} SET active=true WHERE ${key}=$1${extra}`,[peer.userId]);
    await assertRead(therapist,message,false);
  }
});

test('from-now peers cannot block old messages; explicit history grant resets their acknowledgement',async()=>{
  const old=await send(); await read(guardian,old);
  await relations([member(guardian),member(peer,'from_now')]);
  await assertRead(therapist,old,true);
  const fresh=await send(); await read(guardian,fresh); await assertRead(therapist,fresh,false);
  await read(peer,fresh); await assertRead(therapist,fresh,true);
  await relations([member(guardian),member(peer,'all')]);
  await assertRead(therapist,old,false); await assertRead(therapist,fresh,false);
  await read(peer,fresh); await assertRead(therapist,old,true);
});

test('disconnect and from-now reconnection do not reuse a past peer cursor',async()=>{
  await relations([member(guardian),member(peer,'all')]);
  const old=await send(); await read(guardian,old); await read(peer,old);
  await relations([member(guardian)]);
  await relations([member(guardian),member(peer,'from_now')]);
  await assertRead(therapist,old,true);
  const next=await send(); await read(guardian,next); await assertRead(therapist,next,false);
  await read(peer,next); await assertRead(therapist,next,true);
});

test('self hiding neither acknowledges nor removes a recipient from the read calculation',async()=>{
  const message=await send();
  await chat.deleteText(guardian,{conversationId:'room-a',messageId:message.id,clientId:requestId(),scope:'self',confirmed:true});
  assert.equal((await list(guardian)).messages.length,0);
  await assertRead(therapist,message,false);
  const later=await send(); await read(guardian,later);
  await assertRead(therapist,message,true);
});

test('publication and feedback read states also honor the original publication history boundary',async()=>{
  const records=new Records(database),feedback=new ActivityFeedback(database);
  await records.save(therapist,{conversationId:'room-a',recordId:'record-a',clientId:requestId(),expectedRevision:0,
    content:{date:'2026-10-08',goalId:'goal-a',performed:'합성 관찰',summary:'합성 공유',privateNote:'PRIVATE-CLINICAL',
      activity:{title:'합성 활동',instruction:'가상 놀이',frequency:'가능한 때',caution:''}}});
  const preview=await records.preview(therapist,{conversationId:'room-a',recordId:'record-a'});
  const publication=await records.publish(therapist,{conversationId:'room-a',recordId:'record-a',clientId:requestId(),
    expectedRevision:preview.recordRevision,expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds});
  const card={id:publication.messageId}; await assertRead(therapist,card,false);
  await read(guardian,card); await assertRead(therapist,card,true);
  await relations([member(guardian),member(peer,'from_now')]);
  const saved=await feedback.save(guardian,{conversationId:'room-a',feedbackId:'feedback-a',sourceMessageId:card.id,
    clientId:requestId(),expectedRevision:0,content:{date:'2026-10-08',result:'done',reaction:'합성 반응',difficulty:''}});
  const response={id:saved.messageId}; await assertRead(guardian,response,false);
  await read(therapist,response); await assertRead(guardian,response,true);
  assert.equal((await list(peer)).messages.length,0);
  await relations([member(guardian),member(peer,'all')]);
  await assertRead(guardian,response,false); await read(peer,response); await assertRead(guardian,response,true);
});

test('hidden and deleted projections are false even when their previous content was read',async()=>{
  const message=await send(); await read(guardian,message); await assertRead(therapist,message,true);
  await chat.deleteText(therapist,{conversationId:'room-a',messageId:message.id,clientId:requestId(),
    scope:'all',expectedRevision:1,confirmed:true});
  await assertRead(therapist,message,false);
  const publication=await chat.publishSnapshot(therapist,{conversationId:'room-a',clientId:requestId(),recordId:'legacy-a',title:'합성 기록',summary:'합성 요약'});
  await read(therapist,publication); await read(guardian,publication);
  await chat.withdraw(therapist,{conversationId:'room-a',messageId:publication.id});
  const hidden=await get(guardian,publication); assert.equal(hidden.hidden,true); assert.equal(hidden.read,false);
});

test('get and list do not write cursors or expose peer identities, cursor arrays or private notes',async()=>{
  const message=await send(guardian); await read(therapist,message);
  await chat.review(therapist,{conversationId:'room-a',messageId:message.id,note:'PRIVATE-REVIEW',expectedRevision:1});
  const snapshot=async()=>({reads:(await database.query('SELECT * FROM cb_read_states ORDER BY user_id')).rows,
    reviews:(await database.query('SELECT * FROM cb_message_reviews ORDER BY message_id')).rows,
    rooms:(await database.query('SELECT * FROM cb_conversations ORDER BY center_id,id')).rows});
  const before=await snapshot();
  for(const value of [await get(guardian,message),await list(guardian)]) {
    const serialized=JSON.stringify(value); assert.equal(serialized.includes('PRIVATE-'),false);
    assert.equal(serialized.includes('guardian-peer'),false);
    assert.equal(serialized.includes('readStates'),false); assert.equal(serialized.includes('recipients'),false);
  }
  assert.deepEqual(await snapshot(),before);
});

test('clinical review is not acknowledgement and a correction does not erase an explicit read cursor',async()=>{
  const message=await send(guardian);
  await chat.review(therapist,{conversationId:'room-a',messageId:message.id,note:'PRIVATE-REVIEW',expectedRevision:1});
  assert.equal((await get(therapist,message)).reviewed,true);
  await assertRead(guardian,message,false);
  await read(therapist,message); await assertRead(guardian,message,true);
  await chat.editText(guardian,{conversationId:'room-a',messageId:message.id,clientId:requestId(),
    expectedRevision:1,body:'수정된 합성 소식'});
  await assertRead(guardian,message,true);
  assert.equal((await get(therapist,message)).reviewed,false);
});

test('read projection remains behind center, account, membership and conversation viewer authorization',async()=>{
  const message=await send(); await read(guardian,message);
  const refused=async actor=>{
    const denied=error=>error.code==='NOT_FOUND';
    await assert.rejects(get(actor,message),denied); await assert.rejects(list(actor),denied);
  };
  await refused(manager); await refused({...therapist,centerId:'center-b'});
  for(const [table,key,extra] of [
    ['cb_participants','user_id'," AND center_id='center-a' AND conversation_id='room-a'"],
    ['cb_memberships','user_id'," AND center_id='center-a'"],['cb_users','id',''],
  ]) {
    await database.query(`UPDATE ${table} SET active=false WHERE ${key}=$1${extra}`,[therapist.userId]);
    await refused(therapist);
    await database.query(`UPDATE ${table} SET active=true WHERE ${key}=$1${extra}`,[therapist.userId]);
    await assertRead(therapist,message,true);
  }
});

test('helper performs one bounded read-only query and returns only requested message booleans',async()=>{
  const one=await send(),two=await send(); await read(guardian,one);
  const queries=[];
  const result=await chat.inRoom(therapist,'room-a',async(tx,scope)=>messageReadStates({query:async(sql,values)=>{
    queries.push({sql,values}); return tx.query(sql,values);
  }},scope,[await chat.row(tx,scope,one.id),await chat.row(tx,scope,two.id)]));
  assert.deepEqual([...result],[[one.id,true],[two.id,false]]); assert.equal(queries.length,1);
  assert.match(queries[0].sql,/^WITH selected AS MATERIALIZED \(/);
  assert.doesNotMatch(queries[0].sql,/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL|DO)\b/i);
  assert.match(queries[0].sql,/cm\.center_id,cm\.user_id,cm\.role/);
  assert.deepEqual(queries[0].values[2],[one.id,two.id]);
  let calls=0; const unused={query(){calls++;throw Error('No query expected');}};
  assert.deepEqual(await messageReadStates(unused,{},[]),new Map());
  await assert.rejects(messageReadStates(unused,{},Array.from({length:101},()=>({id:'synthetic'}))),TypeError);
  for(const rows of [null,{},[null],[{}]]) await assert.rejects(messageReadStates(unused,{},rows),TypeError);
  assert.equal(calls,0);
});

test('helper tenant and history boundaries cannot be expanded with foreign batch ids',async()=>{
  const message=await send(),outside=await send(therapist,{conversationId:'room-other'});
  const foreign=await send({centerId:'center-b',userId:'therapist-b'},{conversationId:'room-b'});
  await read(guardian,message);
  const result=await chat.inRoom(therapist,'room-a',(tx,scope)=>messageReadStates(tx,scope,
    [{id:message.id},{id:outside.id},{id:foreign.id},{id:'synthetic-missing'}]));
  assert.deepEqual([...result],[[message.id,true],[outside.id,false],[foreign.id,false],['synthetic-missing',false]]);
  await relations([member(guardian),member(peer,'from_now')]);
  const restricted=await chat.inRoom(peer,'room-a',(tx,scope)=>messageReadStates(tx,scope,[{id:message.id}]));
  assert.deepEqual([...restricted],[[message.id,false]]);
});
