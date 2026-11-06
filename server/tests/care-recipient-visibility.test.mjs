import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { migrate } from '../migrate.mjs';
import { Conversations } from '../conversations.mjs';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { MediaAccess } from '../media-access.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest, sealFixture } from './media-storage-fixtures.mjs';
import { messageVisibleSql, recipientTextSql, participantVisibleSql } from '../conversation-visibility.mjs';

// In-memory PostgreSQL and invented subjects only. No server, filesystem media,
// native service, operational account, external delivery or database URL.
// Media evidence below is metadata-only; it does not prove scanning/decoding.
let db, chat, links, children, members, goals, appointments, records, feedback, uploads, media, serial, ioCalls;
const therapist = {centerId:'center-a',userId:'therapist-a'};
const guardian = {centerId:'center-a',userId:'guardian-a'};
const recipient = {centerId:'center-a',userId:'recipient-a'};
const unlinked = {centerId:'center-a',userId:'recipient-unlinked'};
const manager = {centerId:'center-a',userId:'manager-a'};
const room = 'room-a';
const requestId = () => `recipient-request-${++serial}`;
const denied = code => error => error?.code === code;
const send = (actor,body,extra = {}) => chat.sendText(actor,{conversationId:room,clientId:requestId(),body,...extra});
const get = (actor,message) => chat.get(actor,{conversationId:room,messageId:message.id});
const read = (actor,message) => chat.markRead(actor,{conversationId:room,messageId:message.id});
const list = (actor,extra = {}) => chat.list(actor,{conversationId:room,...extra});
const link = async () => links.connect(manager,{conversationId:room,userId:recipient.userId,
  expectedVersion:(await links.get(manager,{conversationId:room})).version,clientId:requestId()});
const unlink = async () => links.disconnect(manager,{conversationId:room,userId:recipient.userId,
  expectedVersion:(await links.get(manager,{conversationId:room})).version,clientId:requestId()});

async function sharedActivity() {
  await records.save(therapist,{conversationId:room,recordId:'record-a',clientId:requestId(),expectedRevision:0,
    content:{date:'2026-10-16',goalId:'goal-a',title:'PRIVATE-CARD-TITLE',performed:'PRIVATE-CLINICAL-ACTIVITY',
      response:'PRIVATE-CLINICAL-RESPONSE',privateNote:'PRIVATE-CLINICAL-NOTE',summary:'PRIVATE-SHARED-SUMMARY',
      activity:{title:'PRIVATE-ACTIVITY-TITLE',instruction:'PRIVATE-ACTIVITY-INSTRUCTION',frequency:'합성 일정',caution:''}}});
  const preview = await records.preview(therapist,{conversationId:room,recordId:'record-a'});
  const published = await records.publish(therapist,{conversationId:room,recordId:'record-a',clientId:requestId(),
    expectedRevision:preview.recordRevision,expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds});
  const card = await get(guardian,{id:published.messageId});
  const saved = await feedback.save(guardian,{conversationId:room,feedbackId:'feedback-a',sourceMessageId:card.id,
    clientId:requestId(),expectedRevision:0,content:{date:'2026-10-16',result:'partial',reaction:'PRIVATE-FEEDBACK-REACTION',difficulty:'PRIVATE-FEEDBACK-DIFFICULTY'}});
  return {card,reply:await get(guardian,{id:saved.messageId}),preview};
}

async function approvedMetadata(actor = guardian) {
  const pending = await uploads.reserve(actor,{conversationId:room,clientId:requestId(),
    file:{name:'PRIVATE-MEDIA-NAME.png',type:'image/png',size:100,sha256:'b'.repeat(64)}});
  const input = row => ({conversationId:room,uploadId:row.id,expectedVersion:row.version});
  const receiving = await uploads.claim(actor,input(pending),'receive');
  const quarantined = await uploads.settle(actor,room,receiving,{state:'quarantined'});
  const inspecting = await uploads.claim(actor,input(quarantined),'inspect');
  return db.transaction(tx => sealFixture(tx,inspecting,evidenceForManifest({type:inspecting.type,size:inspecting.size,sha256:inspecting.sha256})));
}

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  serial = 0; ioCalls = 0;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('recipient-a',true),
      ('recipient-unlinked',true),('manager-a',true);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','recipient-a','care_recipient',true),
      ('center-a','recipient-unlinked','care_recipient',true),('center-a','manager-a','center',true);
    INSERT INTO cb_children(center_id,id) VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','PRIVATE-GOAL','active');
    INSERT INTO cb_appointments(center_id,conversation_id,id,date,time,duration,title,room,status)
      VALUES ('center-a','room-a','appointment-a','2026-10-16','10:00',30,'PRIVATE-APPOINTMENT','합성 공간','scheduled');`);
  const auth = new Auth(db,{password:{N:1024,r:8,p:1,maxmem:32 * 1024 ** 2}});
  for (const userId of [recipient.userId,unlinked.userId]) await auth.provisionAccount({userId,
    email:`${userId}@synthetic.test`,password:'Synthetic recipient password 2026!'});
  chat = new Conversations(db); links = new CareRecipientLinks(db); children = new Children(db); members = new MemberProfiles(db);
  goals = new Goals(db); appointments = new Appointments(db); records = new Records(db); feedback = new ActivityFeedback(db);
  const noIO = async () => { ioCalls++; throw new Error('A privacy test must not open or write bytes.'); };
  const store = {write:noIO,openVerified:noIO,remove:noIO};
  uploads = new MediaUploads(db,store); media = new MediaAccess(db,store);
  await configureSyntheticMediaPolicy(db,'center-a');
});

test('unlinked subject membership and forged caller role grant no subject, room or clinical access',async () => {
  assert.deepEqual((await children.list(unlinked)).children,[]);
  assert.deepEqual((await chat.inbox(unlinked)).rooms,[]);
  for (const actor of [unlinked,{...unlinked,role:'therapist'},manager,{...recipient,centerId:'center-b'}])
    await assert.rejects(list(actor),denied('NOT_FOUND'));
  await assert.rejects(children.get(unlinked,{conversationId:room}),denied('NOT_FOUND'));
});

test('from-now restricts direct IDs, replies and read targets while independent text delivery and retries work',async () => {
  const before = await send(guardian,'PRIVATE-OLD-TEXT'); await link();
  const fresh = await send(therapist,'합성 새 텍스트');
  await assert.rejects(get(recipient,before),denied('NOT_FOUND'));
  await assert.rejects(read(recipient,before),denied('NOT_FOUND'));
  await assert.rejects(send(recipient,'과거 원문 답글',{replyTo:before.id}),denied('NOT_FOUND'));
  assert.deepEqual((await list(recipient)).messages.map(row=>row.id),[fresh.id]);
  const input = {conversationId:room,clientId:requestId(),body:'내 운동 소감',replyTo:fresh.id};
  const sent = await chat.sendText(recipient,input), retried = await chat.sendText(recipient,input);
  assert.equal(sent.id,retried.id); assert.equal(sent.authorId,recipient.userId);
  assert.equal((await get(guardian,sent)).body,'내 운동 소감');
  assert.equal((await get(therapist,sent)).quote.body,fresh.body);
  assert.equal((await chat.inbox(recipient)).rooms[0].latest.body,'내 운동 소감');
  assert.equal((await list(recipient)).unread,1);
  await read(recipient,fresh); assert.equal((await list(recipient)).unread,0);
  assert.equal((await list(guardian)).unread,2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n,0);
});

test('new guardian-only publications and feedback are absent from all subject reads, counts and reply targets',async () => {
  await link(); const {card,reply,preview} = await sharedActivity();
  assert.deepEqual(preview.recipientIds,[guardian.userId]);
  assert.deepEqual((await list(recipient)).messages,[]); assert.equal((await list(recipient)).unread,0);
  const home = (await chat.inbox(recipient)).rooms[0]; assert.equal(home.latest,null); assert.equal(home.unread,0);
  for (const protectedMessage of [card,reply]) {
    await assert.rejects(get(recipient,protectedMessage),denied('NOT_FOUND'));
    await assert.rejects(read(recipient,protectedMessage),denied('NOT_FOUND'));
    await assert.rejects(send(recipient,'새 답글',{replyTo:protectedMessage.id,expectedReplyRevision:1}),denied('NOT_FOUND'));
  }
  await assert.rejects(feedback.get(recipient,{conversationId:room,feedbackId:'feedback-a'}),denied('NOT_FOUND'));
  await assert.rejects(feedback.save(recipient,{conversationId:room,feedbackId:'feedback-recipient',sourceMessageId:card.id,
    clientId:requestId(),expectedRevision:0,content:{date:'2026-10-16',result:'done',reaction:'나의 소감',difficulty:''}}),denied('NOT_FOUND'));
  assert.equal((await get(guardian,card)).publication.summary,'PRIVATE-SHARED-SUMMARY');
  await chat.withdraw(therapist,{conversationId:room,messageId:card.id});
  assert.equal((await get(guardian,card)).hidden,true);
  assert.equal((await get(therapist,card)).publication.title,'PRIVATE-CARD-TITLE');
  await assert.rejects(get(recipient,card),denied('NOT_FOUND'));
});

test('ordinary replies never reveal inaccessible old text or new private card/feedback through quotes',async () => {
  const old = await send(guardian,'PRIVATE-OLD-QUOTE'); await link(); const {card,reply} = await sharedActivity();
  const quotes = [];
  for (const source of [old,card,reply]) quotes.push(await send(therapist,'합성 공개 답변',{
    replyTo:source.id,...(source.type === 'feedback' ? {expectedReplyRevision:1} : {})}));
  for (const message of quotes) {
    const projected = await get(recipient,message);
    assert.equal(projected.quote.hidden,true);
    for (const field of ['authorId','preview','feedbackId','feedbackRevision','version']) assert.equal(field in projected.quote,false);
    assert.equal(JSON.stringify(projected).includes('PRIVATE-'),false);
  }
  assert.equal((await list(recipient)).messages.length,3);
  assert.equal((await chat.inbox(recipient)).rooms[0].latest.body,'합성 공개 답변');
});

test('mixed messages expose text only; attachment-only messages, quotes and all file anchors stay private',async () => {
  await link(); const mixedFile = await approvedMetadata(), onlyFile = await approvedMetadata();
  const mixed = await send(guardian,'합성 본문',{attachments:[{id:mixedFile.id}]});
  const only = await send(guardian,'',{attachments:[{id:onlyFile.id}]});
  const reply = await send(therapist,'합성 답변',{replyTo:mixed.id});
  const hiddenReply = await send(therapist,'별도 답변',{replyTo:only.id});
  const projected = await get(recipient,mixed); assert.equal(projected.body,'합성 본문'); assert.deepEqual(projected.attachments,[]);
  assert.equal((await get(recipient,reply)).quote.preview,'합성 본문');
  assert.equal((await get(recipient,hiddenReply)).quote.hidden,true);
  const page = await list(recipient); assert.equal(page.messages.some(row=>row.id===only.id),false);
  assert.equal(page.unread,3); assert.equal(JSON.stringify(page).includes('PRIVATE-MEDIA-NAME'),false);
  assert.equal(JSON.stringify(page).includes(mixedFile.id),false); assert.equal(JSON.stringify(page).includes('image/png'),false);
  await assert.rejects(get(recipient,only),denied('NOT_FOUND')); await assert.rejects(read(recipient,only),denied('NOT_FOUND'));
  await assert.rejects(send(recipient,'첨부 원문 답글',{replyTo:only.id}),denied('NOT_FOUND'));
  for (const source of [{kind:'message',messageId:mixed.id},{kind:'record',recordId:'record-a'},
    {kind:'record-reference',recordId:'record-a',messageId:mixed.id}])
    await assert.rejects(media.open(recipient,{conversationId:room,uploadId:mixedFile.id,source}),denied('NOT_FOUND'));
  assert.equal(ioCalls,0);
  assert.equal((await get(therapist,mixed)).attachments[0].name,'PRIVATE-MEDIA-NAME.png');
  assert.equal((await get(guardian,only)).attachments.length,1);
});

test('an attachment-only last message never becomes the home target or counts as subject unread',async () => {
  await link(); const text = await send(therapist,'텍스트 홈'); const file = await approvedMetadata();
  const only = await send(guardian,'',{attachments:[{id:file.id}]});
  const home = (await chat.inbox(recipient)).rooms[0];
  assert.equal(home.targetId,text.id); assert.equal(home.latest.body,'텍스트 홈'); assert.equal(home.unread,1);
  await chat.deleteText(guardian,{conversationId:room,messageId:only.id,clientId:requestId(),expectedRevision:1,scope:'all',confirmed:true});
  await assert.rejects(get(recipient,only),denied('NOT_FOUND'));
  assert.equal((await chat.inbox(recipient)).rooms[0].targetId,text.id);
});

test('current text removal also removes direct, list, quote and unread visibility without exposing pinned media',async () => {
  await link(); const file = await approvedMetadata();
  const mixed = await send(guardian,'이전 공개 텍스트',{attachments:[{id:file.id}]});
  const quoted = await send(therapist,'합성 인용 답변',{replyTo:mixed.id});
  const oldPage = await list(recipient);
  await chat.editText(guardian,{conversationId:room,messageId:mixed.id,clientId:requestId(),expectedRevision:1,body:''});
  await assert.rejects(get(recipient,mixed),denied('NOT_FOUND'));
  assert.equal((await get(recipient,quoted)).quote.hidden,true);
  assert.equal((await list(recipient,{expectedRevision:oldPage.revision})).resetRequired,true);
  assert.deepEqual((await list(recipient)).messages.map(row=>row.id),[quoted.id]);
  assert.equal((await list(recipient)).unread,1);
});

test('subject cursors count only for readable text, never for private cards or attachment-only messages',async () => {
  await link(); const text = await send(therapist,'읽음 대상 텍스트');
  await read(guardian,text); assert.equal((await get(therapist,text)).read,false);
  await read(recipient,text); assert.equal((await get(therapist,text)).read,true);
  const {card,reply} = await sharedActivity();
  await read(guardian,card); assert.equal((await get(therapist,card)).read,true);
  await read(therapist,reply); assert.equal((await get(guardian,reply)).read,true);
  const file = await approvedMetadata(therapist), only = await send(therapist,'',{attachments:[{id:file.id}]});
  await read(guardian,only); assert.equal((await get(therapist,only)).read,true);
  assert.equal((await list(recipient)).unread,0);
});

test('subject profile is minimal; goals, schedules, family interests and clinical originals remain denied',async () => {
  await children.save(manager,{conversationId:room,clientId:requestId(),expectedRevision:0,
    content:{name:'합성 대상',age:18,ageAsOf:'2026-10-16'}});
  await children.saveFamilyPlan(guardian,{conversationId:room,clientId:requestId(),expectedRevision:0,concern:'PRIVATE-FAMILY-CONCERN'});
  await link(); await sharedActivity();
  const profile = await children.get(recipient,{conversationId:room});
  assert.equal(profile.name,'합성 대상'); assert.equal('familyPlan' in profile,false);
  for (const key of ['age','ageAsOf','updatedAt']) assert.equal(key in profile,false);
  assert.equal(JSON.stringify(profile).includes('PRIVATE-'),false);
  assert.deepEqual((await children.list(recipient)).children.map(row=>row.childId),['child-a']);
  for (const action of [
    () => goals.get(recipient,{conversationId:room,goalId:'goal-a'}),
    () => goals.list(recipient,{conversationId:room}),
    () => appointments.get(recipient,{conversationId:room,appointmentId:'appointment-a'}),
    () => appointments.get(recipient,{conversationId:room,appointmentId:'appointment-a',revision:1}),
    () => appointments.list(recipient,{dateFrom:'2026-10-16',dateTo:'2026-10-16'}),
  ]) await assert.rejects(action(),denied('NOT_FOUND'));
  for (const action of [
    () => records.get(recipient,{conversationId:room,recordId:'record-a'}),
    () => records.list(recipient,{conversationId:room}),
    () => records.measurements(recipient,{conversationId:room}),
    () => records.preview(recipient,{conversationId:room,recordId:'record-a'}),
    () => children.saveFamilyPlan(recipient,{conversationId:room,clientId:requestId(),expectedRevision:1,concern:'새 소감'}),
  ]) await assert.rejects(action(),denied('FORBIDDEN'));
  assert.equal((await children.get(guardian,{conversationId:room})).familyPlan.concern,'PRIVATE-FAMILY-CONCERN');
  assert.equal((await goals.get(guardian,{conversationId:room,goalId:'goal-a'})).title,'PRIVATE-GOAL');
  assert.equal((await appointments.get(manager,{conversationId:room,appointmentId:'appointment-a'})).title,'PRIVATE-APPOINTMENT');
  assert.equal((await records.get(therapist,{conversationId:room,recordId:'record-a'})).privateNote,'PRIVATE-CLINICAL-NOTE');
});

test('subject media input and staging APIs fail before allocation, state changes or file IO',async () => {
  await link(); const file = await approvedMetadata();
  await assert.rejects(send(recipient,'합성 본문',{attachments:[{id:file.id}]}),denied('FORBIDDEN'));
  await assert.rejects(uploads.reserve(recipient,{conversationId:room,clientId:requestId(),
    file:{name:'합성 사진.png',type:'image/png',size:100,sha256:'a'.repeat(64)}}),denied('NOT_FOUND'));
  for (const operation of ['get','getTransferState','open'])
    await assert.rejects(uploads[operation](recipient,{conversationId:room,uploadId:file.id}),denied('NOT_FOUND'));
  await assert.rejects(uploads.cancel(recipient,{conversationId:room,uploadId:file.id,expectedVersion:file.version}),denied('NOT_FOUND'));
  await assert.rejects(uploads.claim(recipient,{conversationId:room,uploadId:file.id,expectedVersion:file.version},'receive'),denied('NOT_FOUND'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n,1); assert.equal(ioCalls,0);
});

test('member roster and self display-name editing support subject accounts without additional private fields',async () => {
  assert.equal((await members.listMembers(manager)).members.some(row=>row.userId===recipient.userId && row.role==='care_recipient'),true);
  const before = await members.getSelf(recipient);
  await members.saveSelf(recipient,{clientId:requestId(),expectedRevision:before.revision,displayName:'합성 본인'});
  const current = await members.getSelf(recipient); assert.equal(current.displayName,'합성 본인');
  assert.deepEqual(Object.keys(current).sort(),['displayName','revision','role','updatedAt','userId']);
  await assert.rejects(members.listMembers(recipient),denied('NOT_FOUND'));
});

test('active membership/account checks and disconnection deny old successful commands; re-entry grants no old history',async () => {
  await link(); const input = {conversationId:room,clientId:requestId(),body:'합성 본인 메시지'};
  const sent = await chat.sendText(recipient,input);
  for (const [table,column,condition] of [['cb_users','id',''],['cb_memberships','user_id'," AND center_id='center-a'"]]) {
    await db.query(`UPDATE ${table} SET active=false WHERE ${column}=$1${condition}`,[recipient.userId]);
    await assert.rejects(get(recipient,sent),denied('NOT_FOUND'));
    await assert.rejects(chat.sendText(recipient,input),denied('NOT_FOUND'));
    await assert.rejects(children.get(recipient,{conversationId:room}),denied('NOT_FOUND'));
    await db.query(`UPDATE ${table} SET active=true WHERE ${column}=$1${condition}`,[recipient.userId]);
  }
  await unlink(); await assert.rejects(get(recipient,sent),denied('NOT_FOUND'));
  assert.deepEqual((await chat.inbox(recipient)).rooms,[]);
  await link(); await assert.rejects(get(recipient,sent),denied('NOT_FOUND'));
  await assert.rejects(chat.sendText(recipient,input),denied('NOT_FOUND'));
  assert.equal((await get(guardian,sent)).body,'합성 본인 메시지');
  for (const actor of [recipient,{...recipient,role:'therapist'}])
    await assert.rejects(chat.list(actor,{conversationId:'room-other'}),denied('NOT_FOUND'));
});

test('recipient edits are author-bound and private review remains therapist-only',async () => {
  await link(); const own = await send(recipient,'합성 원문'), other = await send(guardian,'다른 사람의 텍스트');
  await chat.editText(recipient,{conversationId:room,messageId:own.id,clientId:requestId(),expectedRevision:1,body:'합성 수정'});
  assert.equal((await get(therapist,own)).body,'합성 수정');
  await assert.rejects(chat.editText(recipient,{conversationId:room,messageId:other.id,clientId:requestId(),expectedRevision:1,body:'권한 없는 수정'}),denied('FORBIDDEN'));
  await chat.review(therapist,{conversationId:room,messageId:own.id,expectedRevision:2,note:'PRIVATE-REVIEW'});
  assert.equal(JSON.stringify(await get(recipient,own)).includes('PRIVATE-REVIEW'),false);
  await assert.rejects(chat.textReview(recipient,{conversationId:room,messageId:own.id}),denied('FORBIDDEN'));
  await chat.deleteText(recipient,{conversationId:room,messageId:own.id,clientId:requestId(),expectedRevision:2,scope:'all',confirmed:true});
  assert.equal((await get(recipient,own)).deleted,true);
  assert.equal((await get(guardian,own)).deleted,true);
});

test('visibility fragments accept internal aliases/placeholders only',() => {
  assert.match(messageVisibleSql('$1'),/care_recipient/);
  for (const value of ['x); DELETE FROM cb_users; --','unknown role',null]) {
    assert.throws(()=>messageVisibleSql(value),TypeError);
    assert.throws(()=>recipientTextSql(value),TypeError);
    assert.throws(()=>participantVisibleSql(value),TypeError);
  }
  assert.match(participantVisibleSql('team'),/cb_care_recipient_links/);
});
