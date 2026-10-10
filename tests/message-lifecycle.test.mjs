import assert from 'node:assert/strict';
import {test} from 'node:test';
import {seed} from '../src/seed.js';
import {upgradeState, conversationView, messageProjection} from '../src/conversations.js';
import {mutate, project, validateState} from '../src/domain.js';
import {messageVersion, messageBodyAt, messageCapabilities} from '../src/message-lifecycle.js';
import {chatDraftValid} from '../src/chat-drafts.js';
import {load,persist} from '../src/repository.js';
import {STORAGE_KEY} from '../src/config.js';
import {communicationHome} from '../src/home-ui.js';
const therapist={id:'t1',role:'therapist'}, guardian={id:'p1',role:'guardian'}, manager={id:'m1',role:'center'};
const at='2026-10-08T00:00:00.000Z', later='2026-10-08T01:00:00.000Z';
const start=()=>upgradeState(seed());
const send=(db, actor=guardian, extra={})=>mutate(db,actor,'message',{
  childId:'c1',clientId:crypto.randomUUID(),body:'합성 최초 소식',...extra},at);
const edit=(db,id,extra={},now=later)=>mutate(db,guardian,'message-edit',{
  childId:'c1',id,clientId:crypto.randomUUID(),expectedVersion:messageVersion(db.messages.find(m=>m.id===id)),body:'합성 수정 소식',...extra},now);
const remove=(db,actor,id,scope='all',extra={},now=later)=>mutate(db,actor,'message-delete',{
  childId:'c1',id,scope,confirmed:true,clientId:crypto.randomUUID(),expectedVersion:messageVersion(db.messages.find(m=>m.id===id)),...extra},now);
const record=(db,id,extra={})=>mutate(db,therapist,'record',{
  childId:'c1',goalId:'g1',date:'2026-10-08',performed:'가상 활동',referenceMessageIds:[id],...extra},later);

test('author edits only current text within the original 24-hour window, not a renewed window',()=>{
  const db=send(start()),id=db.messages.at(-1).id, before=structuredClone(db);
  const updated=edit(db,id);
  assert.equal(messageVersion(updated.messages.at(-1)),2);
  assert.equal(messageBodyAt(updated.messages.at(-1),1),'합성 최초 소식');
  assert.equal(messageBodyAt(updated.messages.at(-1),2),'합성 수정 소식');
  assert.equal(conversationView(updated,therapist,'c1').messages.at(-1).edited,true);
  assert.equal(validateState(updated),true); assert.deepEqual(db,before);
  for(const now of ['2026-10-07T23:59:59.999Z','2026-10-09T00:00:00.001Z','invalid'])
    assert.throws(()=>edit(db,id,{},now));
  assert.doesNotThrow(()=>edit(db,id,{},'2026-10-09T00:00:00.000Z'));
  assert.throws(()=>edit(updated,id,{body:'다음 수정'},'2026-10-08T00:30:00.000Z'));
  assert.equal(messageCapabilities(updated.messages.at(-1),guardian,'2026-10-09T00:00:00.001Z').canEdit,false);
});

test('foreign author, center, wrong child, archived card, stale version and malformed changes fail atomically',()=>{
  const db=send(start()),id=db.messages.at(-1).id,before=structuredClone(db);
  const input={childId:'c1',id,clientId:'change-foreign-0001',expectedVersion:1,body:'합성 위조'};
  for(const actor of [therapist,manager,{id:'p2',role:'guardian'}]) assert.throws(()=>mutate(db,actor,'message-edit',input,later));
  for(const patch of [{childId:'c2'},{id:'publication-pub1'},{expectedVersion:0},{expectedVersion:'1'},
    {body:''},{body:'x'.repeat(2001)},{clientId:id}]) assert.throws(()=>edit(db,id,patch));
  assert.throws(()=>remove(db,therapist,id)); assert.throws(()=>remove(db,guardian,id,'all',{confirmed:false}));
  assert.throws(()=>remove(db,guardian,id,'everything')); assert.deepEqual(db,before);
});

test('edit/delete commands replay once even after later mutations or deadline, without reviving deleted content',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  const input={childId:'c1',id,clientId:'stable-edit-command-01',expectedVersion:1,body:'첫 수정'};
  db=mutate(db,guardian,'message-edit',input,later);
  db=edit(db,id,{body:'두 번째 수정'},'2026-10-08T02:00:00.000Z');
  db=mutate(db,guardian,'message-edit',input,'2026-10-10T00:00:00.000Z');
  assert.equal(db.messages.at(-1).body,'두 번째 수정'); assert.equal(messageVersion(db.messages.at(-1)),3);
  assert.throws(()=>mutate(db,guardian,'message-edit',{...input,body:'ID 재사용'},later));
  assert.throws(()=>remove(db,guardian,id,'all',{clientId:input.clientId}));
  const command={childId:'c1',id,scope:'all',confirmed:true,clientId:'stable-delete-command-01',expectedVersion:3};
  db=mutate(db,guardian,'message-delete',command,'2026-10-08T03:00:00.000Z');
  db=mutate(db,guardian,'message-delete',command,'2026-10-10T00:00:00.000Z');
  assert.equal(messageVersion(db.messages.at(-1)),4); assert.equal(validateState(db),true);
  assert.equal(conversationView(db,guardian,'c1').messages.at(-1).deleted,true);
});

test('all-delete hides author, text, attachments, quotes and private notes; keeps independent replies and IDs',()=>{
  const attachment={id:'synthetic-photo',name:'가상.png',type:'image/png',size:42,share:true};
  let db=send(start(),guardian,{attachments:[attachment]}); const id=db.messages.at(-1).id;
  db=mutate(db,therapist,'message-review',{childId:'c1',id,reviewNote:'SYNTHETIC PRIVATE REVIEW'},later);
  db=send(db,therapist,{body:'독립 답변 유지',replyTo:id}); const replyId=db.messages.at(-1).id;
  const originals=structuredClone(db);
  db=remove(db,guardian,id);
  for(const actor of [therapist,guardian]) {
    const view=conversationView(db,actor,'c1'); const message=view.messages.find(m=>m.id===id);
    assert.equal(message.authorId,null); assert.equal(message.canReply,false); assert.deepEqual(message.attachments,[]);
    assert.equal(JSON.stringify(message).includes('합성 최초'),false);
    assert.equal(JSON.stringify(message).includes('synthetic-photo'),false);
    assert.equal(JSON.stringify(message).includes('SYNTHETIC PRIVATE'),false);
    assert.equal(view.messages.find(m=>m.id===replyId).body,'독립 답변 유지');
    assert.equal(view.messages.find(m=>m.id===replyId).quote.hidden,true);
  }
  assert.equal(conversationView(db,therapist,'c1').unread,0);
  assert.deepEqual(db.messages.find(m=>m.id===replyId),originals.messages.find(m=>m.id===replyId));
  assert.deepEqual(db.messages.find(m=>m.id===id).attachments,originals.messages.find(m=>m.id===id).attachments);
  assert.throws(()=>send(db,therapist,{replyTo:id}));
  assert.throws(()=>record(db,id));
  assert.throws(()=>mutate(db,therapist,'message-review',{childId:'c1',id,reviewNote:'가상 새 확인'},later));
  assert.equal(validateState(db),true);
});

test('self-delete is per-user without deadline, excludes home/unread/direct reads and redacts their quotes only',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  db=send(db,therapist,{body:'가상 답변',replyTo:id});
  db=remove(db,therapist,id,'self',{},'2026-10-10T00:00:00.000Z');
  assert.equal(conversationView(db,therapist,'c1').messages.some(m=>m.id===id),false);
  assert.equal(conversationView(db,therapist,'c1').messages.at(-1).quote.hidden,true);
  assert.equal(conversationView(db,guardian,'c1').messages.some(m=>m.id===id),true);
  assert.equal(conversationView(db,guardian,'c1').messages.at(-1).quote.hidden,false);
  assert.throws(()=>messageProjection(db,therapist,db.messages.find(m=>m.id===id)));
  assert.throws(()=>mutate(db,therapist,'read',{childId:'c1',id},later));
  assert.throws(()=>record(db,id));
  db=remove(db,therapist,id,'self',{},'2026-10-11T00:00:00.000Z');
  assert.equal(db.messages.find(m=>m.id===id).hiddenFor.length,1); assert.equal(validateState(db),true);
});

test('replies retain the version selected; stale reply drafts reject instead of silently attaching changed content',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  db=send(db,therapist,{body:'가상 답변',replyTo:id,expectedReplyVersion:1});
  const replyId=db.messages.at(-1).id; db=edit(db,id);
  const quote=conversationView(db,therapist,'c1').messages.find(m=>m.id===replyId).quote;
  assert.equal(quote.body,'합성 최초 소식'); assert.equal(quote.changed,true);
  assert.throws(()=>send(db,therapist,{replyTo:id,expectedReplyVersion:1}));
  assert.throws(()=>send(db,therapist,{expectedReplyVersion:1}));
  assert.doesNotThrow(()=>send(db,therapist,{replyTo:id,expectedReplyVersion:2}));
  const draft={clientId:'synthetic-draft-001',body:'가상',replyTo:id,expectedReplyVersion:1,attachments:[],entries:[]};
  assert.equal(chatDraftValid(draft),true);
  for(const version of [0,-1,1.1,'1',null]) assert.equal(chatDraftValid({...draft,expectedReplyVersion:version}),false);
  assert.equal(chatDraftValid({...draft,replyTo:null}),false); assert.equal(validateState(db),true);
});

test('clinical references preserve selected text/attachments through edit, hide, delete and subsequent record edits',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  db=record(db,id,{expectedReferenceVersions:[{messageId:id,version:1}]}); const recordId=db.records.at(-1).id;
  const sources=structuredClone(db.records.at(-1).referenceSources);
  db=edit(db,id);
  assert.throws(()=>record(db,id,{expectedReferenceVersions:[{messageId:id,version:1}]}));
  db=remove(db,guardian,id); db=remove(db,therapist,id,'self');
  db=record(db,id,{id:recordId,performed:'가상 다음 활동',expectedReferenceVersions:[]});
  assert.deepEqual(db.records.at(-1).referenceSources,sources);
  assert.equal(project(db,guardian,'c1').records.length,0);
  assert.equal(JSON.stringify(project(db,guardian,'c1')).includes('referenceSources'),false);
  assert.equal(validateState(db),true);
});

test('legacy ID-only references are frozen before mutation without changing record text, publications or original files',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  db=send(db,therapist,{body:'가상 기존 답변',replyTo:id}); const replyId=db.messages.at(-1).id;
  delete db.messages.at(-1).replyVersion;
  db=record(db,id); delete db.records.at(-1).referenceSources;
  const before=structuredClone(db); db=edit(db,id);
  assert.equal(db.records.at(-1).referenceSources[0].body,'합성 최초 소식');
  for(const key of Object.keys(before.records.at(-1))) assert.deepEqual(db.records.at(-1)[key],before.records.at(-1)[key]);
  assert.deepEqual(db.publications,before.publications); assert.equal(validateState(db),true);
  assert.equal(conversationView(db,therapist,'c1').messages.find(m=>m.id===replyId).quote.body,'합성 최초 소식');
});

test('changed messages invalidate current review status while keeping the old private note separate',()=>{
  let db=send(start()); const id=db.messages.at(-1).id;
  db=mutate(db,therapist,'message-review',{childId:'c1',id,expectedVersion:1,reviewNote:'SYNTHETIC PRIVATE'},later);
  db=edit(db,id);
  const view=conversationView(db,therapist,'c1').messages.at(-1);
  assert.equal(view.reviewed,false); assert.equal(view.reviewChanged,true);
  assert.equal(view.reviewNote,'SYNTHETIC PRIVATE');
  assert.equal(JSON.stringify(conversationView(db,guardian,'c1')).includes('SYNTHETIC PRIVATE'),false);
  assert.throws(()=>mutate(db,therapist,'message-review',{childId:'c1',id,expectedVersion:1,reviewNote:'가상 새 확인'},later));
  db=mutate(db,therapist,'message-review',{childId:'c1',id,expectedVersion:2,reviewNote:'가상 새 확인'},later);
  assert.equal(conversationView(db,therapist,'c1').messages.at(-1).reviewed,true);
  assert.equal(validateState(db),true);
});

test('original send retry remains idempotent after edit/delete, and relationship revocation still denies changes',()=>{
  const input={childId:'c1',clientId:'stable-original-send-01',body:'가상 최초 발신'};
  let db=mutate(start(),guardian,'message',input,at); db=edit(db,input.clientId); db=remove(db,guardian,input.clientId);
  db=mutate(db,guardian,'message',input,later); assert.equal(db.messages.filter(m=>m.id===input.clientId).length,1);
  assert.equal(conversationView(db,guardian,'c1').messages.at(-1).deleted,true);
  db=mutate(db,manager,'relationships',{childId:'c1',therapistId:'t2',guardianIds:['p2'],historyConfirmed:true});
  assert.throws(()=>edit(db,input.clientId)); assert.throws(()=>remove(db,guardian,input.clientId,'self'));
  assert.equal(validateState(db),true);
});

test('new therapist home cannot expose the title or open action of an old private draft',()=>{
  let db=mutate(start(),therapist,'record',{childId:'c1',goalId:'g1',date:'2026-10-08',status:'draft',title:'SYNTHETIC RESTRICTED DRAFT'},at);
  const recordId=db.records.at(-1).id;
  db=mutate(db,manager,'relationships',{childId:'c1',therapistId:'t2',guardianIds:['p1'],historyConfirmed:true},later);
  const html=communicationHome(db,{id:'t2',role:'therapist'},{heading:()=>'',appointmentRows:()=>''});
  assert.equal(html.includes('SYNTHETIC RESTRICTED DRAFT'),false);
  assert.equal(html.includes(recordId),false); assert.equal(validateState(db),true);
});

test('save/reload preserves boundaries and strict validation rejects forged receipts, snapshots and versions',()=>{
  let db=send(start()); const id=db.messages.at(-1).id; db=record(db,id); db=edit(db,id);
  const map=new Map([[STORAGE_KEY,JSON.stringify(db)]]),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
  const next=remove(db,guardian,id); persist(storage,next,db.revision); assert.deepEqual(load(storage).db,next);
  for(const patch of [{body:'다른 본문'},{sentBody:4},{deletedAt:''},{changes:[]},{reviewVersion:9},{replyVersion:1}]) {
    const invalid=structuredClone(db); Object.assign(invalid.messages.at(-1),patch); assert.equal(validateState(invalid),false);
  }
  for(const patch of [{body:'가상 변조'},{version:99},{attachments:[{id:'bad'}]},{extra:true}]) {
    const invalid=structuredClone(db); Object.assign(invalid.records.at(-1).referenceSources[0],patch); assert.equal(validateState(invalid),false);
  }
  const invalid=structuredClone(db); invalid.messages.at(-1).changes[0].expectedVersion=2; assert.equal(validateState(invalid),false);
  assert.equal(validateState(db),true);
});
