import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest,sealFixture } from './media-storage-fixtures.mjs';

let db,records,feedback,chat,relationships,serial;
const therapist={centerId:'center-a',userId:'therapist-a'},guardian={centerId:'center-a',userId:'guardian-a'};
const manager={centerId:'center-a',userId:'manager-a'},replacement={centerId:'center-a',userId:'therapist-new'};
const request=()=>`retention-request-${++serial}`;
const code=expected=>error=>error instanceof RepositoryError && error.code===expected;
const body=extra=>({date:'2026-10-08',goalId:'goal-a',performed:'합성 관찰',response:'합성 반응',
  nextPlan:'처음 계획',summary:'합성 공유 요약',privateNote:'PRIVATE-CLINICAL',...extra});
const feedbackBody=extra=>({date:'2026-10-08',result:'partial',reaction:'처음 피드백',difficulty:'처음 어려움',...extra});
const reference=(id,revision)=>({referenceMessageIds:[id],referenceFeedbackRevisions:[{messageId:id,revision}]});
const save=(content,extra={})=>records.save(therapist,{conversationId:'room-a',recordId:'next-record',clientId:request(),
  expectedRevision:0,content:body(content),...extra});
const get=(extra={})=>records.get(therapist,{conversationId:'room-a',recordId:'next-record',...extra});
async function prepare(firstContent={}) {
  await save({activity:{title:'합성 활동',instruction:'합성 놀이',frequency:'편한 때',caution:''}},{recordId:'shared-record'});
  const preview=await records.preview(therapist,{conversationId:'room-a',recordId:'shared-record'});
  const publication=await records.publish(therapist,{conversationId:'room-a',recordId:'shared-record',clientId:request(),
    expectedRevision:preview.recordRevision,expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds});
  const update=(expectedRevision,content={})=>feedback.save(guardian,{conversationId:'room-a',feedbackId:'feedback-a',
    sourceMessageId:publication.messageId,clientId:request(),expectedRevision,content:feedbackBody(content)});
  const first=await update(0,firstContent);
  return {messageId:first.messageId,publicationId:publication.messageId,update};
}
async function relation(userId,history) {
  const current=await relationships.get(manager,{conversationId:'room-a'});
  return relationships.replace(manager,{conversationId:'room-a',clientId:request(),expectedVersion:current.version,
    historyConfirmed:true,pastHistoryConfirmed:true,therapist:{userId,history},guardians:[{userId:guardian.userId,history:'preserve'}]});
}
const feedbackHistory=()=>feedback.get(therapist,{conversationId:'room-a',feedbackId:'feedback-a',revision:1});
async function immutableRows() {
  const result={};
  for(const table of ['cb_feedback_revisions','cb_feedback_reviews','cb_feedback_attachments',
    'cb_media_uploads','cb_media_objects','cb_media_preparations'])
    result[table]=(await db.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  return result;
}
async function metadataOnlyFile() {
  // Contract-only synthetic manifest/proof; there are NO file bytes, decoders,
  // scan services or storage exceptions here. Existing media suites test IO.
  const forbidden=()=>{throw new Error('This fixture must never perform media IO.');};
  const uploads=new MediaUploads(db,{write:forbidden,openVerified:forbidden,remove:forbidden});
  await configureSyntheticMediaPolicy(db,'center-a');
  const file=await uploads.reserve(guardian,{conversationId:'room-a',clientId:request(),
    file:{name:'합성 첨부.png',type:'image/png',size:32,sha256:'a'.repeat(64)}});
  const input=row=>({conversationId:'room-a',uploadId:row.id,expectedVersion:row.version});
  const receiving=await uploads.claim(guardian,input(file),'receive');
  const quarantined=await uploads.settle(guardian,'room-a',receiving,{state:'quarantined'});
  const inspecting=await uploads.claim(guardian,input(quarantined),'inspect');
  return db.transaction(tx=>sealFixture(tx,inspecting,evidenceForManifest({type:inspecting.type,size:inspecting.size,sha256:inspecting.sha256})));
}

before(async()=>{db=await PGlite.create();await migrate(db);});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  // Only this in-memory synthetic database is reset. No configured URL is read.
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('manager-a',true),
      ('therapist-new',true),('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','manager-a','center',true),('center-a','therapist-new','therapist',true),('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-other','therapist-a','therapist',true,1),
      ('center-a','room-other','guardian-a','guardian',true,1),('center-b','room-b','therapist-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','합성 목표','active'),
      ('center-a','room-other','goal-other','다른 합성 목표','active');`);
  records=new Records(db);feedback=new ActivityFeedback(db);chat=new Conversations(db);relationships=new Relationships(db);serial=0;
});

test('existing record keeps its sealed feedback revision when only the next plan changes',async()=>{
  const fixture=await prepare();
  await save(reference(fixture.messageId,1));
  const original=await get();
  await fixture.update(1,{reaction:'수정한 피드백'});
  const receipt=await save({...reference(fixture.messageId,1),nextPlan:'수정한 계획'},{expectedRevision:1});
  assert.equal(receipt.revision,2);
  assert.deepEqual((await get()).referenceSources,original.referenceSources);
  assert.equal((await get()).nextPlan,'수정한 계획');
  assert.deepEqual(await get({revision:1}),original);
});

test('retention preserves feedback body, attachment bindings and version-specific private review without copying them into public records',async()=>{
  const file=await metadataOnlyFile(),fixture=await prepare({attachments:[{id:file.id}]});
  await feedback.review(therapist,{conversationId:'room-a',feedbackId:'feedback-a',clientId:request(),
    expectedRevision:1,expectedReviewVersion:0,note:'PRIVATE-ORIGINAL-REVIEW'});
  await save(reference(fixture.messageId,1));
  const originalRecord=await get(),originalFeedback=await feedbackHistory();
  assert.equal(originalFeedback.attachments[0].id,file.id);
  await fixture.update(1,{reaction:'다르게 수정한 피드백',difficulty:'수정된 어려움',attachments:[]});
  const originalRows=await immutableRows();
  await save({...reference(fixture.messageId,1),nextPlan:'참고본 유지 후 계획 변경'},{expectedRevision:1});
  assert.deepEqual((await get()).referenceSources,originalRecord.referenceSources);
  assert.deepEqual(await get({revision:1}),originalRecord);
  assert.deepEqual(await feedbackHistory(),originalFeedback);
  assert.deepEqual(await immutableRows(),originalRows);
  const preview=await records.preview(therapist,{conversationId:'room-a',recordId:'next-record'});
  assert.deepEqual(preview.attachments,[]);
  assert.equal(JSON.stringify(preview).includes('PRIVATE-'),false);
  assert.equal(JSON.stringify(preview).includes('referenceSources'),false);
  assert.equal(JSON.stringify(preview).includes(file.id),false);
  const latest=await feedback.get(guardian,{conversationId:'room-a',feedbackId:'feedback-a'});
  assert.equal(latest.feedback.reaction,'다르게 수정한 피드백');assert.deepEqual(latest.attachments,[]);
  assert.equal(JSON.stringify(latest).includes('PRIVATE-ORIGINAL-REVIEW'),false);
});

test('a saved feedback anchor cannot silently switch to latest or omit its explicit revision',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  await assert.rejects(save(reference(fixture.messageId,2),{expectedRevision:1}),code('REFERENCE_CHANGED'));
  await assert.rejects(save({referenceMessageIds:[fixture.messageId]},{expectedRevision:1}),code('INVALID_INPUT'));
  assert.equal((await get()).referenceSources[0].feedbackRevision,1);assert.equal((await get()).revision,1);
});

test('another or new record must explicitly confirm current feedback instead of borrowing an existing record anchor',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  await assert.rejects(save(reference(fixture.messageId,1),{recordId:'new-record'}),code('REFERENCE_CHANGED'));
  await save({}, {recordId:'other-record'});
  await assert.rejects(save(reference(fixture.messageId,1),{recordId:'other-record',expectedRevision:1}),code('REFERENCE_CHANGED'));
  await save(reference(fixture.messageId,2),{recordId:'new-record'});
  assert.equal((await get({recordId:'new-record'})).referenceSources[0].feedbackRevision,2);
  await fixture.update(2,{reaction:'세 번째 피드백'});
  await save(reference(fixture.messageId,2),{recordId:'new-record',expectedRevision:1});
  assert.equal((await get({recordId:'new-record'})).referenceSources[0].feedbackRevision,2);
});

test('removal from the current record revokes retention even though the old record revision still exists',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  await save({}, {expectedRevision:1});
  assert.deepEqual((await get()).referenceSources,[]);
  assert.equal((await get({revision:1})).referenceSources[0].feedbackRevision,1);
  await assert.rejects(save(reference(fixture.messageId,1),{expectedRevision:2}),code('REFERENCE_CHANGED'));
  await save(reference(fixture.messageId,2),{expectedRevision:2});
  assert.equal((await get()).referenceSources[0].feedbackRevision,2);
});

test('retaining a reference never bypasses current role, active account or room authorization',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  const input={conversationId:'room-a',recordId:'next-record',clientId:request(),expectedRevision:1,content:body(reference(fixture.messageId,1))};
  await assert.rejects(records.save(guardian,input),code('FORBIDDEN'));
  await assert.rejects(records.save(manager,input),code('NOT_FOUND'));
  await assert.rejects(records.save({centerId:'center-b',userId:'therapist-b'},input),code('NOT_FOUND'));
  for(const [table,key,extra] of [['cb_users','id',''],['cb_memberships','user_id'," AND center_id='center-a'"],
    ['cb_participants','user_id'," AND center_id='center-a' AND conversation_id='room-a'"]]) {
    await db.query(`UPDATE ${table} SET active=false WHERE ${key}=$1${extra}`,[therapist.userId]);
    await assert.rejects(records.save(therapist,input),code('NOT_FOUND'));
    await db.query(`UPDATE ${table} SET active=true WHERE ${key}=$1${extra}`,[therapist.userId]);
  }
  await records.save(therapist,input);
  assert.equal((await get()).referenceSources[0].feedbackRevision,1);
});

test('replacement therapist needs the record and source history grant before retaining its old anchor',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  await relation(replacement.userId,'from_now');
  const input={conversationId:'room-a',recordId:'next-record',clientId:request(),expectedRevision:1,content:body(reference(fixture.messageId,1))};
  await assert.rejects(records.save(therapist,input),code('NOT_FOUND'));
  await assert.rejects(records.save(replacement,input),code('NOT_FOUND'));
  await relation(replacement.userId,'all');
  await records.save(replacement,input);
  const record=await records.get(replacement,{conversationId:'room-a',recordId:'next-record'});
  assert.equal(record.referenceSources[0].feedbackRevision,1);assert.equal(record.authorId,replacement.userId);
});

test('a source publication outside the viewer history cannot be recovered through an otherwise visible record',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  const source=await chat.get(therapist,{conversationId:'room-a',messageId:fixture.messageId});
  // Model the exact persisted boundary between the older publication and the
  // later feedback/record, without weakening any constraints or read helper.
  await db.query(`UPDATE cb_participants SET first_sequence=$1 WHERE center_id='center-a'
    AND conversation_id='room-a' AND user_id='therapist-a'`,[source.sequence]);
  assert.deepEqual((await get()).referenceSources,[]);
  await assert.rejects(save(reference(fixture.messageId,1),{expectedRevision:1}),code('NOT_FOUND'));
});

test('withdrawal still hides guardian content while an authorized therapist retains the clinical source',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  await chat.withdraw(therapist,{conversationId:'room-a',messageId:fixture.publicationId});
  await save(reference(fixture.messageId,1),{expectedRevision:1});
  assert.equal((await get()).referenceSources[0].feedbackRevision,1);
  const hidden=await feedback.get(guardian,{conversationId:'room-a',feedbackId:'feedback-a'});
  assert.equal(hidden.hidden,true);assert.equal('feedback' in hidden,false);
});

test('a failed receipt rolls back retained references and exact retry is idempotent after later feedback edits',async()=>{
  const fixture=await prepare();await save(reference(fixture.messageId,1));await fixture.update(1,{reaction:'새 피드백'});
  const previous=await get(),input={conversationId:'room-a',recordId:'next-record',clientId:request(),expectedRevision:1,
    content:body({...reference(fixture.messageId,1),nextPlan:'다음 계획 수정'})};
  await db.exec(`CREATE FUNCTION cb_retention_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END; $$;
    CREATE TRIGGER cb_retention_test_failure BEFORE INSERT ON cb_record_requests
    FOR EACH ROW EXECUTE FUNCTION cb_retention_test_failure();`);
  try { await assert.rejects(records.save(therapist,input),error=>error.code==='P0001'); }
  finally { await db.exec('DROP TRIGGER cb_retention_test_failure ON cb_record_requests; DROP FUNCTION cb_retention_test_failure();'); }
  assert.deepEqual(await get(),previous);
  const stored=await records.save(therapist,input);
  await fixture.update(2,{reaction:'다시 바뀐 피드백'});
  assert.deepEqual(await records.save(therapist,input),{...stored,replayed:true});
  assert.equal((await get()).revision,2);assert.equal((await get()).referenceSources[0].feedbackRevision,1);
  assert.deepEqual(await get({revision:1}),previous);
});
