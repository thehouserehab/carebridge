import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { MediaAccess } from '../media-access.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { Conversations } from '../conversations.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';
import { rasterPng } from '../image-metadata-test-fixtures.mjs';
import { fromLegacyScanner,evidenceForManifest,sealFixture } from './media-storage-fixtures.mjs';

let db,uploads,access,store,chat,records,feedback,relations,directory,requestNumber;
const therapist = { centerId:'center-a',userId:'therapist-a' }, guardian = { centerId:'center-a',userId:'guardian-a' };
const peer = { centerId:'center-a',userId:'guardian-other' }, manager = { centerId:'center-a',userId:'manager-a' };
const newcomer = { centerId:'center-a',userId:'guardian-new' }, replacement = { centerId:'center-a',userId:'therapist-new' };
const foreign = { centerId:'center-b',userId:'therapist-b' };
const bytes = rasterPng({ width:1,height:1 });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
// Test-only trusted scanner; no claim of actual decoding/anti-malware coverage.
const scanner = { inspect:async ({ stream }) => { await collect(stream); return { verdict:'clean',engine:'test-only',engineVersion:'1',
  policyVersion:'carebridge-media-v1',media:{ type:'image/png',width:1,height:1 } }; } };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const uploadInput = (row,conversationId = 'room-a') => ({ conversationId,uploadId:row.id,expectedVersion:row.version });
async function approved(actor = therapist,options = {},instance = uploads) {
  const room = options.conversationId ?? 'room-a';
  const pending = await instance.reserve(actor,{ conversationId:room,clientId:`upload-request-${++requestNumber}-0000`,
    file:{ name:options.name ?? '가상 사진.png',type:'image/png',size:bytes.length,sha256:hash(bytes) } });
  const quarantine = await instance.receive(actor,uploadInput(pending,room),Readable.from([bytes]));
  return instance.inspect(actor,uploadInput(quarantine,room));
}
// Metadata-only fixture for aggregate budget/SQL tests. It deliberately does
// not write bytes or prove decoding. Byte IO and real hash/signature checks
// are covered by approved() and media-uploads.test.mjs, not this shortcut.
async function approvedManifestOnly(actor,size) {
  const pending = await uploads.reserve(actor,{ conversationId:'room-a',clientId:`budget-request-${++requestNumber}-0000`,
    file:{ name:'가상 용량.mp4',type:'video/mp4',size,sha256:hash('metadata-only-test-fixture') } });
  const receiving = await uploads.claim(actor,uploadInput(pending),'receive');
  const quarantined = await uploads.settle(actor,'room-a',receiving,{ state:'quarantined' });
  const inspecting = await uploads.claim(actor,uploadInput(quarantined),'inspect');
  return db.transaction((tx) => sealFixture(tx,inspecting,evidenceForManifest({ type:inspecting.type,size:inspecting.size,sha256:inspecting.sha256 })));
}
const recordBody = (extra = {}) => ({ date:'2026-10-02',goalId:'goal-a',performed:'가상 회기 관찰',summary:'보호자용 요약',privateNote:'PRIVATE-NOTE',
  activity:{ title:'가상 놀이',instruction:'함께 가상 활동',frequency:'편한 시간',caution:'' },...extra });
const recordInput = (extra = {}) => ({ conversationId:'room-a',recordId:'record-a',clientId:'record-request-0001',expectedRevision:0,content:recordBody(),...extra });
async function publish(extra = {},actor = therapist) {
  const preview = await records.preview(actor,{ conversationId:'room-a',recordId:extra.recordId ?? 'record-a' });
  return records.publish(actor,{ conversationId:'room-a',recordId:'record-a',clientId:'publish-request-0001',expectedRevision:preview.recordRevision,
    expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds,...extra });
}
const feedbackBody = (extra = {}) => ({ date:'2026-10-02',result:'partial',reaction:'가상 보호자 소식',difficulty:'',...extra });
const feedbackInput = (source,extra = {}) => ({ conversationId:'room-a',feedbackId:'feedback-a',sourceMessageId:source,clientId:'feedback-request-0001',
  expectedRevision:0,content:feedbackBody(),...extra });
const sourceMessage = (id,feedbackRevision) => ({ kind:'message',messageId:id,...(feedbackRevision === undefined ? {} : { feedbackRevision }) });
const sourceRecord = (revision) => ({ kind:'record',recordId:'record-a',...(revision === undefined ? {} : { revision }) });
const open = (actor,file,source,extra = {},instance = access) => instance.open(actor,{ conversationId:'room-a',uploadId:file.id,source,...extra });
async function share(extra = {}) { await records.save(therapist,recordInput({ content:recordBody(extra) })); return publish(); }
async function relationship(extra = {}) {
  const current = await relations.get(manager,{ conversationId:'room-a' });
  return relations.replace(manager,{ conversationId:'room-a',clientId:`relation-request-${++requestNumber}`,expectedVersion:current.version,historyConfirmed:true,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[{ userId:guardian.userId,history:'preserve' },{ userId:peer.userId,history:'preserve' }],...extra });
}
async function injected(table,run) {
  // Table names below are test constants, never request/user input.
  assert(['cb_audit_events','cb_record_requests','cb_feedback_requests'].includes(table));
  await db.exec(`CREATE FUNCTION cb_test_binding_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$;
    CREATE TRIGGER cb_test_binding_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION cb_test_binding_failure();`);
  try { await assert.rejects(run()); }
  finally { await db.exec(`DROP TRIGGER cb_test_binding_failure ON ${table}; DROP FUNCTION cb_test_binding_failure();`); }
}
const mediaRow = async (file) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1',[file.id])).rows[0];

before(async () => { db = await PGlite.create(); await migrate(db); directory = await mkdtemp(join(tmpdir(),'carebridge-bindings-test-')); });
after(async () => {
  await db?.close(); const target = resolve(directory), rel = relative(resolve(tmpdir()),target);
  assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-bindings-test-'));
  await rm(target,{ recursive:true,force:true });
});
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('guardian-other',true),('guardian-new',true),('manager-a',true),('therapist-new',true),('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),('center-a','guardian-other','guardian',true),
      ('center-a','guardian-new','guardian',true),('center-a','manager-a','center',true),('center-a','therapist-new','therapist',true),('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','guardian-other','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-a','room-other','guardian-a','guardian',true,1),('center-b','room-b','therapist-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
  requestNumber = 0; store = new PrivateFileStore(join(directory,randomUUID())); uploads = new MediaUploads(db,store,{ preparation:fromLegacyScanner(scanner) }); access = new MediaAccess(db,store);
  for (const center of ['center-a','center-b']) await configureSyntheticMediaPolicy(db,center);
  chat = new Conversations(db); records = new Records(db); feedback = new ActivityFeedback(db); relations = new Relationships(db);
});

test('attachment-only chat shares immutable bytes with current participants but never a center, foreign actor or owner fallback',async () => {
  const file = await approved(guardian);
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'message-request-0001',body:'',attachments:[{ id:file.id }] });
  assert.equal(message.body,''); assert.equal(message.attachments.length,1); assert.equal(message.attachments[0].share,true);
  for (const actor of [guardian,peer,therapist]) assert.deepEqual(await collect((await open(actor,file,sourceMessage(message.id))).stream),bytes);
  for (const actor of [manager,foreign,newcomer]) await assert.rejects(open({ ...actor,role:'guardian' },file,sourceMessage(message.id)),errorCode('NOT_FOUND'));
  await assert.rejects(uploads.open(guardian,{ conversationId:'room-a',uploadId:file.id }),errorCode('UPLOAD_STATE'));
  assert.equal((await uploads.get(guardian,{ conversationId:'room-a',uploadId:file.id })).state,'bound');
  await assert.rejects(uploads.cancel(guardian,{ ...uploadInput(file),expectedVersion:6 }),errorCode('FILE_IN_USE'));
  const range = await open(therapist,file,sourceMessage(message.id),{ range:{ start:2,end:8 } });
  assert.deepEqual(await collect(range.stream),bytes.subarray(2,9));
});

test('record attachments default private and only selected immutable IDs appear in preview/shared card and downloads',async () => {
  const privateFile = await approved(therapist,{ name:'PRIVATE-FILE.png' }), sharedFile = await approved(therapist,{ name:'가족 공유.png' });
  await records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:privateFile.id },{ id:sharedFile.id,share:true }] }) }));
  const record = await records.get(therapist,{ conversationId:'room-a',recordId:'record-a' });
  assert.deepEqual(record.attachments.map((f) => f.share),[false,true]);
  const preview = await records.preview(therapist,{ conversationId:'room-a',recordId:'record-a' });
  assert.deepEqual(preview.attachments.map((f) => f.id),[sharedFile.id]);
  assert.equal(JSON.stringify(preview).includes('PRIVATE-'),false);
  const shared = await publish(), card = await chat.get(guardian,{ conversationId:'room-a',messageId:shared.messageId });
  assert.deepEqual(card.attachments.map((f) => f.id),[sharedFile.id]); assert.equal(JSON.stringify(card).includes('PRIVATE-'),false);
  assert.deepEqual(await collect((await open(therapist,privateFile,sourceRecord())).stream),bytes);
  assert.deepEqual(await collect((await open(guardian,sharedFile,sourceMessage(card.id))).stream),bytes);
  await assert.rejects(open(guardian,privateFile,sourceMessage(card.id)),errorCode('NOT_FOUND'));
  await assert.rejects(open(guardian,privateFile,sourceRecord()),errorCode('FORBIDDEN'));
});

test('unshared edits keep old shared attachments; reshare/withdraw hide old files from guardians while therapists retain history',async () => {
  const file = await approved(); const first = await share({ attachments:[{ id:file.id,share:true }] });
  const reply = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'reply-request-0001',body:'공개 답변',replyTo:first.messageId });
  await records.save(therapist,recordInput({ expectedRevision:1,clientId:'record-request-0002',content:recordBody({ attachments:[] }) }));
  assert.deepEqual(await collect((await open(guardian,file,sourceMessage(first.messageId))).stream),bytes);
  assert.deepEqual((await records.get(therapist,{ conversationId:'room-a',recordId:'record-a',revision:1 })).attachments.map((f) => f.id),[file.id]);
  const second = await publish({ clientId:'publish-request-0002' });
  assert.deepEqual((await chat.get(guardian,{ conversationId:'room-a',messageId:first.messageId })).attachments,[]);
  await assert.rejects(open(guardian,file,sourceMessage(first.messageId)),errorCode('NOT_FOUND'));
  await assert.rejects(open(guardian,file,sourceMessage(second.messageId)),errorCode('NOT_FOUND'));
  assert.deepEqual(await collect((await open(therapist,file,sourceRecord(1))).stream),bytes);
  assert.equal((await chat.get(guardian,{ conversationId:'room-a',messageId:reply.id })).body,'공개 답변');
  assert.equal((await chat.get(therapist,{ conversationId:'room-a',messageId:reply.id })).quote.id,first.messageId);
  await chat.withdraw(therapist,{ conversationId:'room-a',messageId:second.messageId });
  assert.deepEqual(await collect((await open(therapist,file,sourceMessage(first.messageId))).stream),bytes);
});

test('feedback revisions pin files; edited/removed files are therapist history only and do not create a second card',async () => {
  const shared = await share(), oldFile = await approved(guardian), newFile = await approved(guardian);
  const saved = await feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:[{ id:oldFile.id }] }) }));
  const card = await feedback.get(guardian,{ conversationId:'room-a',feedbackId:'feedback-a' });
  assert.equal(card.attachments[0].id,oldFile.id);
  const reply = await chat.sendText(therapist,{ conversationId:'room-a',clientId:'feedback-reply-0001',body:'공개 답변',replyTo:saved.messageId,expectedReplyRevision:1 });
  await feedback.save(guardian,feedbackInput(shared.messageId,{ expectedRevision:1,clientId:'feedback-request-0002',content:feedbackBody({ attachments:[{ id:newFile.id }] }) }));
  assert.equal((await feedback.get(guardian,{ conversationId:'room-a',feedbackId:'feedback-a' })).id,card.id);
  assert.equal((await chat.get(guardian,{ conversationId:'room-a',messageId:card.id })).attachments[0].id,newFile.id);
  await assert.rejects(open(guardian,oldFile,sourceMessage(card.id)),errorCode('NOT_FOUND'));
  await assert.rejects(open(guardian,oldFile,sourceMessage(card.id,1)),errorCode('FORBIDDEN'));
  assert.deepEqual(await collect((await open(therapist,oldFile,sourceMessage(card.id,1))).stream),bytes);
  assert.equal((await feedback.get(therapist,{ conversationId:'room-a',feedbackId:'feedback-a',revision:1 })).attachments[0].id,oldFile.id);
  await assert.rejects(open(guardian,oldFile,sourceMessage(reply.id)),errorCode('NOT_FOUND')); // Quote is not a new file grant.
});

test('closing the activity hides even its guardian-owned feedback file, without erasing independent chat files',async () => {
  const shared = await share(), file = await approved(guardian), independent = await approved(guardian);
  const saved = await feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:[{ id:file.id }] }) }));
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'independent-message-01',body:'일상 소식',attachments:[{ id:independent.id }] });
  await chat.withdraw(therapist,{ conversationId:'room-a',messageId:shared.messageId });
  assert.deepEqual((await chat.get(guardian,{ conversationId:'room-a',messageId:saved.messageId })).attachments,[]);
  await assert.rejects(open(guardian,file,sourceMessage(saved.messageId)),errorCode('NOT_FOUND'));
  await assert.rejects(uploads.open(guardian,{ conversationId:'room-a',uploadId:file.id }),errorCode('UPLOAD_STATE'));
  assert.deepEqual(await collect((await open(therapist,file,sourceMessage(saved.messageId))).stream),bytes);
  assert.deepEqual(await collect((await open(guardian,independent,sourceMessage(message.id))).stream),bytes);
});

test('only owner ready files bind initially, cross-room files and single-origin reuse cannot be smuggled into another target',async () => {
  const file = await approved(guardian), wrongRoom = await approved(therapist,{ conversationId:'room-other' });
  await assert.rejects(records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:file.id }] }) })),errorCode('ATTACHMENT_NOT_FOUND'));
  await assert.rejects(records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:wrongRoom.id }] }) })),errorCode('ATTACHMENT_NOT_FOUND'));
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'origin-message-0001',body:'소식',attachments:[{ id:file.id }] });
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'origin-message-0002',body:'다른 소식',attachments:[{ id:file.id }] }),errorCode('ATTACHMENT_ORIGIN_CONFLICT'));
  const own = await approved(); await records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:own.id }] }) }));
  await assert.rejects(records.save(therapist,recordInput({ recordId:'record-other',clientId:'different-record-0001',content:recordBody({ attachments:[{ id:own.id }] }) })),errorCode('ATTACHMENT_ORIGIN_CONFLICT'));
  assert.equal((await chat.list(therapist,{ conversationId:'room-a' })).messages.length,1);
  assert.equal(message.attachments[0].id,file.id);
});

test('text lifecycle hides live file anchors but retains authorized clinical reference bytes and immutable file binding',async()=>{
  const file=await approved(guardian),message=await chat.sendText(guardian,{conversationId:'room-a',clientId:randomUUID(),body:'가상 사진 원문',attachments:[{id:file.id}]});
  const before=await mediaRow(file);
  await records.save(therapist,recordInput({content:recordBody({referenceMessageIds:[message.id],referenceTextRevisions:[{messageId:message.id,revision:1}]})}));
  await chat.editText(guardian,{conversationId:'room-a',messageId:message.id,clientId:randomUUID(),expectedRevision:1,body:''});
  assert.equal((await chat.get(therapist,{conversationId:'room-a',messageId:message.id})).attachments[0].id,file.id);
  await chat.deleteText(guardian,{conversationId:'room-a',messageId:message.id,clientId:randomUUID(),expectedRevision:2,scope:'all',confirmed:true});
  for(const actor of [guardian,therapist,peer])await assert.rejects(open(actor,file,sourceMessage(message.id)),errorCode('NOT_FOUND'));
  const reference={kind:'record-reference',recordId:'record-a',revision:1,messageId:message.id};
  assert.deepEqual(await collect((await open(therapist,file,reference)).stream),bytes);
  await assert.rejects(open(guardian,file,reference),errorCode('FORBIDDEN'));
  await chat.deleteText(therapist,{conversationId:'room-a',messageId:message.id,clientId:randomUUID(),scope:'self',confirmed:true});
  assert.deepEqual(await collect((await open(therapist,file,reference)).stream),bytes);
  await assert.rejects(open(therapist,file,{...reference,messageId:'not-referenced'}),errorCode('NOT_FOUND'));
  assert.deepEqual(await mediaRow(file),before);
  const clinical=await records.get(therapist,{conversationId:'room-a',recordId:'record-a'});
  assert.equal(clinical.referenceSources[0].body,'가상 사진 원문');assert.equal(clinical.referenceSources[0].attachments[0].id,file.id);
});

test('delete between file open and reauthorization closes the handle and never returns a live origin stream',async()=>{
  const file=await approved(guardian),message=await chat.sendText(guardian,{conversationId:'room-a',clientId:randomUUID(),body:'가상 경합 원문',attachments:[{id:file.id}]});
  let closed=false;
  const racing=new MediaAccess(db,{openVerified:async(key,manifest)=>{
    const handle=await store.openVerified(key,manifest);
    await chat.deleteText(guardian,{conversationId:'room-a',messageId:message.id,clientId:randomUUID(),expectedRevision:1,scope:'all',confirmed:true});
    return {createReadStream(){assert.fail('deleted anchor cannot return a stream');},close:async()=>{closed=true;await handle.close();}};
  }});
  await assert.rejects(racing.open(therapist,{conversationId:'room-a',uploadId:file.id,source:sourceMessage(message.id)}),errorCode('NOT_FOUND'));
  assert.equal(closed,true);
});

test('pending/quarantined/cancelled IDs cannot become attachments and failed message binding leaves no partial card or sequence',async () => {
  const pending = await uploads.reserve(guardian,{ conversationId:'room-a',clientId:'pending-file-request-1',file:{ name:'가상.png',type:'image/png',size:bytes.length,sha256:hash(bytes) } });
  const counter = async () => (await db.query('SELECT last_sequence,revision FROM cb_conversations WHERE id = $1',['room-a'])).rows[0];
  let before = await counter();
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'pending-message-0001',body:'',attachments:[{ id:pending.id }] }),errorCode('ATTACHMENT_NOT_READY'));
  assert.deepEqual(await counter(),before);
  const received = await uploads.receive(guardian,uploadInput(pending),Readable.from([bytes]));
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'pending-message-0001',body:'',attachments:[{ id:pending.id }] }),errorCode('ATTACHMENT_NOT_READY'));
  await uploads.cancel(guardian,uploadInput(received));
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'pending-message-0001',body:'',attachments:[{ id:pending.id }] }),errorCode('ATTACHMENT_NOT_READY'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_message_attachments')).rows[0].n,0);
});

test('message, record and feedback receipt failure roll back bindings/events with the parent, preserving ready bytes for exact retry',async () => {
  const file = await approved(guardian), send = () => chat.sendText(guardian,{ conversationId:'room-a',clientId:'rollback-message-01',body:'소식',attachments:[{ id:file.id }] });
  const original = await mediaRow(file);
  await injected('cb_audit_events',send); assert.deepEqual(await mediaRow(file),original);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_message_attachments')).rows[0].n,0);
  const message = await send(); assert.equal((await send()).id,message.id);
  const recordFile = await approved(), save = () => records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:recordFile.id,share:true }] }) }));
  const before = await mediaRow(recordFile); await injected('cb_record_requests',save); assert.deepEqual(await mediaRow(recordFile),before);
  await save(); assert.equal((await save()).replayed,true); const shared = await publish();
  const feedbackFile = await approved(guardian), respond = () => feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:[{ id:feedbackFile.id }] }) }));
  const prior = await mediaRow(feedbackFile); await injected('cb_feedback_requests',respond); assert.deepEqual(await mediaRow(feedbackFile),prior);
  const response = await respond(); assert.equal((await respond()).messageId,response.messageId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_attachments')).rows[0].n,1);
});

test('failed reshare keeps the earlier snapshot/file access and later retry creates exactly one new sealed snapshot',async () => {
  const file = await approved(), first = await share({ attachments:[{ id:file.id,share:true }] });
  await records.save(therapist,recordInput({ expectedRevision:1,clientId:'record-request-0002',content:recordBody({ summary:'새 요약',attachments:[{ id:file.id,share:true }] }) }));
  const republish = () => publish({ clientId:'publish-request-0002' });
  await injected('cb_record_requests',republish);
  assert.deepEqual(await collect((await open(guardian,file,sourceMessage(first.messageId))).stream),bytes);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_publication_attachments')).rows[0].n,1);
  const second = await republish(); assert.equal((await republish()).messageId,second.messageId);
  await assert.rejects(open(guardian,file,sourceMessage(first.messageId)),errorCode('NOT_FOUND'));
  assert.deepEqual(await collect((await open(guardian,file,sourceMessage(second.messageId))).stream),bytes);
});

test('from_now uses the visible message/snapshot boundary, not a file upload timestamp, and prior attachments remain hidden',async () => {
  const old = await approved(guardian), oldMessage = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'old-message-0001',body:'이전 소식',attachments:[{ id:old.id }] });
  const future = await approved(guardian);
  await relationship({ guardians:[{ userId:guardian.userId,history:'preserve' },{ userId:newcomer.userId,history:'from_now' }] });
  const fresh = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'fresh-message-0001',body:'새 소식',attachments:[{ id:future.id }] });
  await assert.rejects(open(newcomer,old,sourceMessage(oldMessage.id)),errorCode('NOT_FOUND'));
  assert.deepEqual(await collect((await open(newcomer,future,sourceMessage(fresh.id))).stream),bytes);
  const page = await chat.list(newcomer,{ conversationId:'room-a' }); assert.deepEqual(page.messages.map((m) => m.id),[fresh.id]);
});

test('replacement therapist can retain existing same-record files with all history but not bypass from_now via a record anchor',async () => {
  const file = await approved(); await records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:file.id }] }) }));
  await relationship({ pastHistoryConfirmed:true,therapist:{ userId:replacement.userId,history:'all' } });
  await records.save(replacement,recordInput({ expectedRevision:1,clientId:'replacement-record-01',content:recordBody({ attachments:[{ id:file.id,share:true }] }) }));
  assert.deepEqual(await collect((await open(replacement,file,sourceRecord(1))).stream),bytes);
  await assert.rejects(open(therapist,file,sourceRecord()),errorCode('NOT_FOUND'));
  await relationship({ therapist:{ userId:replacement.userId,history:'from_now' } });
  await assert.rejects(open(replacement,file,sourceRecord(2)),errorCode('NOT_FOUND'));
});

test('strict ID-only lists reject caller metadata, malformed shares, duplicate/too-many IDs and invalid download anchors/ranges',async () => {
  const file = await approved(guardian);
  for (const attachments of [null,[{ id:file.id,name:'forged.png' }],[{ id:file.id,share:true }],[{ id:file.id },{ id:file.id }],
    Array.from({ length:7 },() => ({ id:randomUUID() }))])
    await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'invalid-list-0001',body:'소식',attachments }),errorCode('INVALID_INPUT'));
  await assert.rejects(records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:file.id,share:'true' }] }) })),errorCode('INVALID_INPUT'));
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'range-message-0001',body:'소식',attachments:[{ id:file.id }] });
  for (const source of [{ kind:'upload' },{ kind:'message',messageId:message.id,role:'guardian' },{ kind:'record',recordId:'record-a',revision:0 }])
    await assert.rejects(open(guardian,file,source),errorCode('INVALID_INPUT'));
  await assert.rejects(open(guardian,file,sourceMessage(message.id),{ range:{ start:bytes.length } }),errorCode('INVALID_RANGE'));
});

test('six files retain selection order across chat, feedback and shared records; bound files leave staging count quota',async () => {
  const files = [];
  for (let i = 0; i < 6; i++) files.push(await approved(guardian,{ name:`가상-${i}.png` }));
  const ordered = files.toReversed(), selection = ordered.map(({ id }) => ({ id }));
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'six-file-message-0001',attachments:selection });
  assert.deepEqual(message.attachments.map(({ id }) => id),selection.map(({ id }) => id));
  const shared = await share(), responseFiles = [], recordFiles = [];
  for (let i = 0; i < 6; i++) { responseFiles.push(await approved(guardian)); recordFiles.push(await approved()); }
  const response = await feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:responseFiles.map(({ id }) => ({ id })) }) }));
  assert.deepEqual((await chat.get(therapist,{ conversationId:'room-a',messageId:response.messageId })).attachments.map(({ id }) => id),responseFiles.map(({ id }) => id));
  await records.save(therapist,recordInput({ expectedRevision:1,clientId:'six-file-record-0002',content:recordBody({ attachments:recordFiles.map(({ id }) => ({ id,share:true })) }) }));
  const next = await publish({ clientId:'six-file-publish-0002' });
  assert.deepEqual((await chat.get(guardian,{ conversationId:'room-a',messageId:next.messageId })).attachments.map(({ id }) => id),recordFiles.map(({ id }) => id));
  // 24 staging files plus twelve bound files must be allowed. A 25th unbound
  // file is rejected before changing room counters, even when no bytes exist.
  for (let i = 0; i < 24; i++) await uploads.reserve(guardian,{ conversationId:'room-a',clientId:`staging-count-${i}-0000`,
    file:{ name:'가상.png',type:'image/png',size:bytes.length,sha256:hash(bytes) } });
  await assert.rejects(uploads.reserve(guardian,{ conversationId:'room-a',clientId:'staging-count-overflow',
    file:{ name:'가상.png',type:'image/png',size:bytes.length,sha256:hash(bytes) } }),errorCode('UPLOAD_QUOTA'));
});

test('aggregate byte budget allows exactly 100MiB and rejects one more byte in every origin, including a direct SQL bypass',async () => {
  const guardianFiles = [await approvedManifestOnly(guardian,50 * 1024 ** 2),await approvedManifestOnly(guardian,50 * 1024 ** 2),await approvedManifestOnly(guardian,1)];
  const therapistFiles = [await approvedManifestOnly(therapist,50 * 1024 ** 2),await approvedManifestOnly(therapist,50 * 1024 ** 2),await approvedManifestOnly(therapist,1)];
  const shared = await share(), select = (files) => files.map(({ id }) => ({ id }));
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'budget-message-0001',attachments:select(guardianFiles) }),errorCode('ATTACHMENT_LIMIT'));
  await assert.rejects(feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:select(guardianFiles) }) })),errorCode('ATTACHMENT_LIMIT'));
  await assert.rejects(records.save(therapist,recordInput({ expectedRevision:1,clientId:'budget-record-0002',content:recordBody({ attachments:select(therapistFiles) }) })),errorCode('ATTACHMENT_LIMIT'));
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,attachments_sealed)
      VALUES ('center-a','room-a','budget-sql-message',999,'therapist-a','budget-sql-request',repeat('0',64),'text','',false)`);
    for (const [ordinal,file] of therapistFiles.entries()) {
      await tx.query(`UPDATE cb_media_uploads SET state = 'bound',version = version + 1,bound_message_id = 'budget-sql-message' WHERE id = $1`,[file.id]);
      await tx.query(`INSERT INTO cb_message_attachments VALUES ('center-a','room-a','budget-sql-message',$1,$2)`,[ordinal,file.id]);
    }
  }),(error) => error.code === '23514' && /budget exceeded/.test(error.message));
  for (const file of [...guardianFiles,...therapistFiles]) assert.equal((await mediaRow(file)).state,'ready');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_message_attachments')).rows[0].n,0);
  const exact = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'budget-message-exact',attachments:select(guardianFiles.slice(0,2)) });
  assert.equal(exact.attachments.reduce((total,file) => total + file.size,0),100 * 1024 ** 2);
});

test('publication attachment foreign keys require an explicitly selected file from the exact immutable record revision',async () => {
  const privateFile = await approved(), oldSelected = await approved();
  await records.save(therapist,recordInput({ content:recordBody({ attachments:[{ id:privateFile.id },{ id:oldSelected.id,share:true }] }) }));
  await records.save(therapist,recordInput({ expectedRevision:1,clientId:'subset-record-0002',content:recordBody({ attachments:[{ id:privateFile.id,share:true }] }) }));
  async function forgedShare(snapshotRevision,referenceRevision,file) {
    return db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO cb_publications(center_id,conversation_id,id,record_id,version,title,summary)
        VALUES ('center-a','room-a','subset-sql-publication','record-a',1,'가상 제목','가상 요약')`);
      await tx.query(`INSERT INTO cb_record_publications(center_id,conversation_id,publication_id,record_id,record_revision,record_date,attachments_sealed)
        VALUES ('center-a','room-a','subset-sql-publication','record-a',$1,'2026-10-02',false)`,[snapshotRevision]);
      await tx.query(`INSERT INTO cb_publication_attachments(center_id,conversation_id,publication_id,record_id,record_revision,ordinal,upload_id)
        VALUES ('center-a','room-a','subset-sql-publication','record-a',$1,0,$2)`,[referenceRevision,file.id]);
    });
  }
  // Unsealed snapshots pass the insert guard; these must fail the FK itself,
  // not merely fail sealing at COMMIT or a late-insertion guard.
  await assert.rejects(forgedShare(1,1,privateFile),(error) => error.code === '23503');
  await assert.rejects(forgedShare(2,1,oldSelected),(error) => error.code === '23503');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_publication_attachments')).rows[0].n,0);
  const shared = await publish();
  assert.deepEqual((await chat.get(guardian,{ conversationId:'room-a',messageId:shared.messageId })).attachments.map(({ id }) => id),[privateFile.id]);
});

test('empty attachment compatibility preserves message/record/feedback request hashes while changed selections conflict',async () => {
  const text = { conversationId:'room-a',clientId:'empty-list-message-01',body:'가상 소식' };
  const message = await chat.sendText(guardian,text); assert.equal((await chat.sendText(guardian,{ ...text,attachments:[] })).id,message.id);
  await records.save(therapist,recordInput()); assert.equal((await records.save(therapist,recordInput({ content:recordBody({ attachments:[] }) }))).replayed,true);
  const shared = await publish(); await feedback.save(guardian,feedbackInput(shared.messageId));
  assert.equal((await feedback.save(guardian,feedbackInput(shared.messageId,{ content:feedbackBody({ attachments:[] }) }))).replayed,true);
  const file = await approved(guardian);
  await assert.rejects(chat.sendText(guardian,{ ...text,attachments:[{ id:file.id }] }),errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal((await mediaRow(file)).state,'ready');
});

test('IO completion rechecks withdrawal/current relationships before returning bound-file bytes',async () => {
  const file = await approved(), shared = await share({ attachments:[{ id:file.id,share:true }] });
  let handle;
  const checked = new MediaAccess(db,{ openVerified:async (...args) => {
    handle = await store.openVerified(...args); await chat.withdraw(therapist,{ conversationId:'room-a',messageId:shared.messageId }); return handle;
  } });
  await assert.rejects(open(guardian,file,sourceMessage(shared.messageId),{},checked),errorCode('NOT_FOUND')); assert.equal(handle.fd,-1);
});

test('binding excludes temporary expiry/quota cleanup; expired ready files fail rather than being silently revived',async () => {
  const short = new MediaUploads(db,store,{ preparation:fromLegacyScanner(scanner),ttlMilliseconds:2000 });
  const bound = await approved(guardian,{},short), unbound = await approved(guardian,{},short);
  const message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'expiry-message-0001',body:'소식',attachments:[{ id:bound.id }] });
  await new Promise((resolve) => setTimeout(resolve,2100));
  await assert.rejects(chat.sendText(guardian,{ conversationId:'room-a',clientId:'expired-message-0001',body:'소식',attachments:[{ id:unbound.id }] }),errorCode('UPLOAD_EXPIRED'));
  const cleaned = await short.cleanup(); assert.equal(cleaned.removed,2);
  assert.equal((await mediaRow(bound)).state,'bound'); assert.equal((await mediaRow(unbound)).state,'deleted');
  assert.deepEqual(await collect((await open(therapist,bound,sourceMessage(message.id))).stream),bytes);
  const metadata = await short.get(guardian,{ conversationId:'room-a',uploadId:bound.id }); assert.equal(metadata.expired,false); assert.equal(metadata.expiresAt,null);
});

test('DB rejects later list insertion/deletion, empty media-less messages, bound-byte deletion and origin relinking',async () => {
  const file = await approved(guardian), message = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'database-message-01',body:'소식',attachments:[{ id:file.id }] });
  const media = await mediaRow(file), extra = await approved(guardian);
  await assert.rejects(db.query('DELETE FROM cb_message_attachments WHERE upload_id = $1',[file.id]));
  await assert.rejects(db.query('UPDATE cb_messages SET attachments_sealed = false WHERE id = $1',[message.id]));
  await assert.rejects(db.query("UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1",[media.object_key]));
  await assert.rejects(db.query("UPDATE cb_media_uploads SET state = 'delete_pending',version = version + 1,bound_message_id = NULL WHERE id = $1",[file.id]));
  await assert.rejects(db.exec(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
    VALUES ('center-a','room-a','empty-direct',999,'guardian-a','empty-direct-request',repeat('0',64),'text','');`));
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`UPDATE cb_media_uploads SET state = 'bound',version = version + 1,bound_message_id = $2 WHERE id = $1`,[extra.id,message.id]);
  })); // No actual list link: deferred guard must fail at COMMIT.
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`UPDATE cb_media_uploads SET state = 'bound',version = version + 1,bound_message_id = $2 WHERE id = $1`,[extra.id,message.id]);
    await tx.query(`INSERT INTO cb_message_attachments VALUES ('center-a','room-a',$1,1,$2)`,[message.id,extra.id]);
  })); // Existing message list is sealed.
  assert.equal((await mediaRow(extra)).state,'ready');
});

test('009 preserves 008 uploads/bytes and earlier message hashes without inventing attachment links',async () => {
  const legacy = await PGlite.create(), migrations = join(directory,`${randomUUID()}-migrations`); await mkdir(migrations);
  try {
    for (const name of ['001-conversations.sql','002-authentication.sql','003-invitations.sql','004-relationships.sql','005-records.sql','006-activity-feedback.sql','007-care-contexts.sql','008-media-uploads.sql'])
      await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrations,name));
    await migrate(legacy,pathToFileURL(`${migrations}/`));
    await legacy.exec(`INSERT INTO cb_centers(id) VALUES ('center-a'); INSERT INTO cb_users(id,active) VALUES ('guardian-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true); INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'); INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1);`);
    // Historical 008 fixture uses the actual old schema, not a new-service
    // opt-out that could accidentally approve new scan-only uploads.
    const file = { id:randomUUID() }, objectKey = randomUUID(), leaseId = randomUUID();
    await legacy.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
      VALUES ('center-a','room-a',$1,'guardian-a','legacy-upload-request',repeat('a',64),'가상 사진.png','image/png',$2,$3,1,clock_timestamp()+interval '1 day')`,[file.id,bytes.length,hash(bytes)]);
    await legacy.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,'center-a','room-a',$2)`,[objectKey,file.id]);
    await legacy.query(`UPDATE cb_media_uploads SET state = 'receiving',version = 2,object_key = $2,lease_id = $3,lease_until = clock_timestamp()+interval '5 minutes' WHERE id = $1`,[file.id,objectKey,leaseId]);
    await store.write(objectKey,Readable.from([bytes]),{ type:'image/png',size:bytes.length,sha256:hash(bytes) });
    await legacy.query(`UPDATE cb_media_uploads SET state = 'quarantined',version = 3,lease_id = NULL,lease_until = NULL WHERE id = $1`,[file.id]);
    await legacy.query(`UPDATE cb_media_uploads SET state = 'inspecting',version = 4,lease_id = $2,lease_until = clock_timestamp()+interval '5 minutes' WHERE id = $1`,[file.id,leaseId]);
    await legacy.query(`UPDATE cb_media_uploads SET state = 'ready',version = 5,lease_id = NULL,lease_until = NULL,scan_report = $2 WHERE id = $1`,
      [file.id,JSON.stringify({ verdict:'clean',engine:'test-only',engineVersion:'1',policyVersion:'carebridge-media-v1',media:{ type:'image/png',width:1,height:1 } })]);
    const original = (await legacy.query('SELECT * FROM cb_media_uploads')).rows[0];
    const oldHash = hash(JSON.stringify({ kind:'text',body:'이전 소식',replyTo:null }));
    await legacy.query(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
      VALUES ('center-a','room-a','legacy-message',2,'guardian-a','legacy-message-request',$1,'text','이전 소식')`,[oldHash]);
    assert.deepEqual(await migrate(legacy),['009-media-bindings.sql','010-profiles.sql','011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_media_uploads')).rows[0],{ ...original,bound_message_id:null,bound_record_id:null,bound_feedback_id:null,
      preparation_required:false,candidate_key:null,preparation_id:null,prepared_size:null,prepared_sha256:null });
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM cb_message_attachments')).rows[0].n,0);
    const retried = await new Conversations(legacy).sendText(guardian,{ conversationId:'room-a',clientId:'legacy-message-request',body:'이전 소식',attachments:[] });
    assert.equal(retried.id,'legacy-message'); assert.deepEqual(retried.attachments,[]);
    assert.deepEqual(await collect((await new MediaUploads(legacy,store).open(guardian,{ conversationId:'room-a',uploadId:file.id })).stream),bytes);
    assert.deepEqual(await migrate(legacy),[]);
  } finally { await legacy.close(); }
});
