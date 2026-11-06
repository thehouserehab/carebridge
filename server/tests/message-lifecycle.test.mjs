import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../migrate.mjs';
import {Conversations} from '../conversations.mjs';
import {Records} from '../records.mjs';
import {RepositoryError} from '../errors.mjs';

// Memory-only invented identities, no environment or existing customer DB.
let db,chat,records;
const guardian={centerId:'synthetic-center',userId:'synthetic-guardian'},
  therapist={centerId:'synthetic-center',userId:'synthetic-therapist'},
  peer={centerId:'synthetic-center',userId:'synthetic-peer'},
  manager={centerId:'synthetic-center',userId:'synthetic-manager'};
const room='synthetic-room';
const code=expected=>error=>error instanceof RepositoryError && error.code===expected;
async function fixture(database){await database.exec(`
  INSERT INTO cb_centers(id) VALUES ('synthetic-center');
  INSERT INTO cb_users(id,active) VALUES ('synthetic-guardian',true),('synthetic-therapist',true),('synthetic-peer',true),('synthetic-manager',true);
  INSERT INTO cb_memberships VALUES ('synthetic-center','synthetic-guardian','guardian',true),('synthetic-center','synthetic-peer','guardian',true),
    ('synthetic-center','synthetic-therapist','therapist',true),('synthetic-center','synthetic-manager','center',true);
  INSERT INTO cb_children VALUES ('synthetic-center','synthetic-child');
  INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('synthetic-center','synthetic-room','synthetic-child');
  INSERT INTO cb_participants VALUES ('synthetic-center','synthetic-room','synthetic-guardian','guardian',true,1),
    ('synthetic-center','synthetic-room','synthetic-therapist','therapist',true,1),('synthetic-center','synthetic-room','synthetic-peer','guardian',true,1);
  INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('synthetic-center','synthetic-room','synthetic-goal','가상 목표','active');
`);}
before(async()=>{db=await PGlite.create();await migrate(db);});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE');await fixture(db);chat=new Conversations(db);records=new Records(db);});
const send=(extra={},actor=guardian)=>chat.sendText(actor,{conversationId:room,clientId:randomUUID(),body:'가상 최초 원문',...extra});
const get=(message,actor=therapist)=>chat.get(actor,{conversationId:room,messageId:message.id});
const edit=(message,extra={},actor=guardian)=>chat.editText(actor,{conversationId:room,messageId:message.id,clientId:randomUUID(),expectedRevision:1,body:'가상 수정 원문',...extra});
const del=(message,scope='all',extra={},actor=guardian)=>chat.deleteText(actor,{conversationId:room,messageId:message.id,clientId:randomUUID(),expectedRevision:1,scope,confirmed:true,...extra});
const page=(actor=therapist,extra={})=>chat.list(actor,{conversationId:room,...extra});
const content=(message,extra={})=>({date:'2026-10-08',goalId:'synthetic-goal',performed:'가상 활동',summary:'공개용 가상 요약',
  referenceMessageIds:[message.id],referenceTextRevisions:[{messageId:message.id,revision:1}],...extra});
const save=(message,extra={})=>records.save(therapist,{conversationId:room,recordId:'synthetic-record',clientId:randomUUID(),expectedRevision:0,content:content(message),...extra});
const record=()=>records.get(therapist,{conversationId:room,recordId:'synthetic-record'});
const raw=table=>db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`).then(result=>result.rows);

test('edits append immutable versions, keep original send hash/sequence and pin selected replies',async()=>{
  const originalInput={clientId:randomUUID(),body:'가상 최초 원문'},message=await send(originalInput);
  const reply=await send({body:'독립 답변',replyTo:message.id,expectedReplyVersion:1},therapist);
  const original=await raw('cb_messages'),before=await page();
  const command={clientId:randomUUID(),body:'가상 수정 원문'};
  assert.deepEqual(await edit(message,command),{messageId:message.id,revision:2,operation:'edit',replayed:false});
  assert.deepEqual(await edit(message,command),{messageId:message.id,revision:2,operation:'edit',replayed:true});
  assert.deepEqual(await raw('cb_messages'),original);
  assert.equal((await get(message)).body,command.body);assert.equal((await get(message)).edited,true);
  const quote=(await get(reply)).quote;assert.equal(quote.body,originalInput.body);assert.equal(quote.version,1);assert.equal(quote.changed,true);
  assert.equal((await page()).nextCursor,before.nextCursor);assert.equal((await page(therapist,{expectedRevision:before.revision})).resetRequired,true);
  await assert.rejects(send({replyTo:message.id,expectedReplyVersion:1}),code('MESSAGE_CONFLICT'));
  await assert.rejects(send({replyTo:message.id}),code('INVALID_INPUT'));
  const later=await send({replyTo:message.id,expectedReplyVersion:2},therapist);assert.equal((await get(later)).quote.body,command.body);
  assert.equal((await send(originalInput)).body,command.body);
  await assert.rejects(edit(message,{clientId:command.clientId,body:'다른 내용'}),code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(edit(message,{body:'오래된 창'}),code('MESSAGE_CONFLICT'));
});

test('author, room/history, strict schema and database clock are required for changes',async()=>{
  const message=await send();
  for(const actor of [therapist,peer]){await assert.rejects(edit(message,{},actor),code('FORBIDDEN'));await assert.rejects(del(message,'all',{},actor),code('FORBIDDEN'));}
  await assert.rejects(edit(message,{},manager),code('NOT_FOUND'));
  await assert.rejects(edit(message,{conversationId:'other-room'}),code('NOT_FOUND'));
  for(const extra of [{body:''},{body:12},{body:'a'.repeat(2001)},{now:'2099-01-01'}, {authorId:guardian.userId},{attachments:[]},
    {expectedRevision:0},{expectedRevision:'1'},{expectedRevision:2147483648},{clientId:'bad'}])await assert.rejects(edit(message,extra),code('INVALID_INPUT'));
  for(const extra of [{confirmed:false},{confirmed:'true'},{scope:'device'},{body:'unexpected'}])await assert.rejects(del(message,'all',extra),code('INVALID_INPUT'));
  await db.query("UPDATE cb_participants SET first_sequence=2 WHERE user_id=$1",[guardian.userId]);
  await assert.rejects(edit(message),code('NOT_FOUND'));await assert.rejects(del(message,'self'),code('NOT_FOUND'));
  await db.query("UPDATE cb_participants SET first_sequence=1 WHERE user_id=$1",[guardian.userId]);
  for(const offset of ['-25 hours','1 hour']){
    const id=randomUUID();await db.query(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,created_at)
      VALUES ($1,$2,$3,(SELECT last_sequence+1 FROM cb_conversations WHERE id=$2),$4,$5,$6,'text','가상 시간 제한',clock_timestamp()+$7::interval)`,
    [guardian.centerId,room,id,guardian.userId,randomUUID(),'a'.repeat(64),offset]);
    await db.query('UPDATE cb_conversations SET last_sequence=last_sequence+1 WHERE id=$1',[room]);
    await assert.rejects(edit({id}),code('MESSAGE_CHANGE_EXPIRED'));await assert.rejects(del({id}),code('MESSAGE_CHANGE_EXPIRED'));
    if(offset==='-25 hours')assert.equal((await del({id},'self')).operation,'self');
  }
});

test('self-hide removes only that user direct reads, quotes, unread and anchors, with safe send retry',async()=>{
  const input={clientId:randomUUID()},message=await send(input),reply=await send({replyTo:message.id,expectedReplyVersion:1,body:'별도 답변'},peer);
  const before=await page();assert.equal(before.unread,2);
  const command={clientId:randomUUID()};await del(message,'self',command,therapist);
  assert.equal((await del(message,'self',command,therapist)).replayed,true);
  assert.equal((await page()).unread,1);assert.deepEqual((await page()).messages.map(m=>m.id),[reply.id]);
  assert.equal((await get(reply)).quote.hidden,true);assert.equal((await get(reply,guardian)).quote.body,message.body);
  for(const work of [()=>get(message),()=>chat.markRead(therapist,{conversationId:room,messageId:message.id}),
    ()=>chat.review(therapist,{conversationId:room,messageId:message.id,note:'메모'}),()=>send({replyTo:message.id},therapist),()=>save(message)])await assert.rejects(work(),code('NOT_FOUND'));
  assert.equal((await get(message,peer)).body,message.body);
  await del(message,'self',{},guardian);
  const retry=await send(input);assert.equal(retry.id,message.id);assert.equal(retry.hidden,true);assert.equal(JSON.stringify(retry).includes(message.body),false);
  await assert.rejects(edit(message),code('NOT_FOUND'));
});

test('all-delete is anonymous and non-revivable, keeps independent replies and exact mutation receipts',async()=>{
  const originalInput={clientId:randomUUID()},message=await send(originalInput),reply=await send({replyTo:message.id,expectedReplyVersion:1,body:'독립 답변'},therapist);
  await chat.review(therapist,{conversationId:room,messageId:message.id,note:'PRIVATE-OLD-REVIEW'});
  const editId=randomUUID();await edit(message,{clientId:editId});
  const deleteId=randomUUID();await del(message,'all',{clientId:deleteId,expectedRevision:2});
  for(const actor of [guardian,therapist,peer]){
    const tombstone=await get(message,actor);assert.equal(tombstone.authorId,null);assert.equal(tombstone.deleted,true);assert.equal(tombstone.canReply,false);assert.deepEqual(tombstone.attachments,[]);
    for(const secret of ['가상 최초 원문','가상 수정 원문','PRIVATE-OLD-REVIEW'])assert.equal(JSON.stringify(tombstone).includes(secret),false);
    assert.equal((await get(reply,actor)).quote.hidden,true);assert.equal((await get(reply,actor)).body,'독립 답변');
  }
  assert.equal((await page()).unread,0);
  assert.equal((await edit(message,{clientId:editId})).replayed,true);
  assert.equal((await del(message,'all',{clientId:deleteId,expectedRevision:2})).replayed,true);
  assert.equal((await send(originalInput)).deleted,true);
  await assert.rejects(edit(message,{expectedRevision:3}),code('MESSAGE_DELETED'));
  await assert.rejects(send({replyTo:message.id,expectedReplyVersion:3}),code('MESSAGE_DELETED'));
  await assert.rejects(save(message),code('MESSAGE_DELETED'));
  await assert.rejects(chat.review(therapist,{conversationId:room,messageId:message.id,note:'가상 메모',expectedRevision:3}),code('MESSAGE_DELETED'));
  await del(message,'self',{},therapist);assert.equal((await page()).messages.length,1);assert.equal((await get(message,peer)).deleted,true);
});

test('clinical sources preserve selected text through edit/delete/hide and later record revisions, not public snapshots',async()=>{
  const message=await send();await save(message);const before=await record(),rawRevision=await raw('cb_record_revisions');
  await edit(message);await del(message,'all',{expectedRevision:2});await del(message,'self',{},therapist);
  const source=(await record()).referenceSources[0];assert.equal(source.body,message.body);assert.equal(source.messageRevision,1);assert.equal(source.changed,true);assert.equal(source.deleted,true);assert.equal(source.hidden,true);
  await save(message,{expectedRevision:1,content:content(message,{performed:'후속 관찰'})});
  assert.equal((await record()).referenceSources[0].body,before.referenceSources[0].body);
  assert.equal((await records.get(therapist,{conversationId:room,recordId:'synthetic-record',revision:1})).performed,before.performed);
  assert.deepEqual((await raw('cb_record_revisions')).filter(row=>row.row.revision===1),rawRevision);
  const preview=await records.preview(therapist,{conversationId:room,recordId:'synthetic-record'});
  assert.equal(JSON.stringify(preview).includes(message.body),false);
  await assert.rejects(records.get(guardian,{conversationId:room,recordId:'synthetic-record'}),code('FORBIDDEN'));
  await assert.rejects(save(message,{recordId:'other-record'}),code('NOT_FOUND'));
  await save(message,{expectedRevision:2,content:content(message,{referenceMessageIds:[],referenceTextRevisions:[]})});
  await assert.rejects(save(message,{expectedRevision:3}),code('NOT_FOUND')); // removed sources cannot be resurrected
});

test('new clinical sources need a current selected version; existing sources cannot silently be retargeted',async()=>{
  const message=await send();await edit(message);
  await assert.rejects(save(message),code('REFERENCE_CHANGED'));
  await assert.rejects(save(message,{content:content(message,{referenceTextRevisions:[]})}),code('INVALID_INPUT'));
  await save(message,{content:content(message,{referenceTextRevisions:[{messageId:message.id,revision:2}]})});
  await edit(message,{expectedRevision:2,body:'가상 세 번째 본문'});
  await assert.rejects(save(message,{expectedRevision:1,content:content(message,{referenceTextRevisions:[{messageId:message.id,revision:3}]})}),code('REFERENCE_CHANGED'));
  assert.equal((await record()).referenceSources[0].messageRevision,2);
});

test('reviews are version-bound and private; relationship revocation prevents old receipt replay',async()=>{
  const message=await send(),command={clientId:randomUUID()};
  await chat.review(therapist,{conversationId:room,messageId:message.id,note:'PRIVATE-NOTE'});await edit(message,command);
  assert.equal((await get(message)).reviewed,false);assert.equal((await get(message)).reviewChanged,true);
  assert.equal((await get(message)).reviewNote,'PRIVATE-NOTE');assert.equal(JSON.stringify(await get(message,guardian)).includes('PRIVATE-NOTE'),false);
  await assert.rejects(chat.review(therapist,{conversationId:room,messageId:message.id,note:'다음 메모'}),code('INVALID_INPUT'));
  await assert.rejects(chat.review(therapist,{conversationId:room,messageId:message.id,note:'다음 메모',expectedRevision:1}),code('MESSAGE_CONFLICT'));
  await chat.review(therapist,{conversationId:room,messageId:message.id,note:'확인한 다음 메모',expectedRevision:2});assert.equal((await get(message)).reviewed,true);
  await db.query('UPDATE cb_participants SET active=false WHERE user_id=$1',[guardian.userId]);
  await assert.rejects(edit(message,command),code('NOT_FOUND'));
});

test('failed audit or receipt rolls back history/head/hide/counters; same ID can retry once',async()=>{
  for(const operation of ['edit','all','self'])for(const table of ['cb_audit_events','cb_message_change_requests']){
    const message=await send(),command={clientId:randomUUID()},tables=['cb_message_text_heads','cb_message_text_revisions','cb_message_hides','cb_message_change_requests','cb_conversations','cb_audit_events'];
    const before=await Promise.all(tables.map(raw));
    const bad=new Conversations({transaction:work=>db.transaction(tx=>work({query:async(sql,params)=>{
      if(sql.includes(`INSERT INTO ${table}`))throw Error('synthetic rollback');return tx.query(sql,params);
    }}))});
    const actor=operation==='self' ? therapist : guardian;
    const input={conversationId:room,messageId:message.id,clientId:command.clientId,expectedRevision:1,...(operation==='edit' ? {body:'가상 변경'} : {scope:operation,confirmed:true})};
    await assert.rejects(operation==='edit' ? bad.editText(actor,input) : bad.deleteText(actor,input),/synthetic rollback/);
    assert.deepEqual(await Promise.all(tables.map(raw)),before);
    const work=()=>operation==='edit' ? chat.editText(actor,input) : chat.deleteText(actor,input);
    assert.equal((await work()).replayed,false);assert.equal((await work()).replayed,true);
  }
});

test('DB guards reject mutable originals/history, orphan revisions, forged source kinds and sealed source insertion',async()=>{
  const message=await send();await save(message);
  for(const sql of ["UPDATE cb_messages SET body='forged'",'DELETE FROM cb_message_text_revisions',"UPDATE cb_message_text_revisions SET body='forged'",
    'DELETE FROM cb_message_text_heads',"UPDATE cb_message_text_heads SET message_id='forged'",'UPDATE cb_record_text_sources SET message_revision=2','DELETE FROM cb_record_text_sources'])
    await assert.rejects(db.exec(sql),{code:'23514'});
  await assert.rejects(db.transaction(tx=>tx.query(`INSERT INTO cb_message_text_revisions(center_id,conversation_id,message_id,revision,actor_id,operation,body)
    VALUES ($1,$2,$3,2,$4,'edit','가상 미완료 변경')`,[guardian.centerId,room,message.id,guardian.userId])),{code:'23514'});
  assert.equal((await get(message)).version,1);
  await assert.rejects(db.query(`INSERT INTO cb_message_reply_versions VALUES ($1,$2,$3,$3,1)`,[guardian.centerId,room,message.id]),{code:'23514'});
  await assert.rejects(db.query(`INSERT INTO cb_record_text_sources VALUES ($1,$2,'synthetic-record',1,0,$3,1)`,[guardian.centerId,room,message.id]),{code:'23514'});
  await assert.rejects(db.transaction(async tx=>{
    await tx.query(`INSERT INTO cb_record_revisions(center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note)
      VALUES ($1,$2,'synthetic-record',2,$3,'synthetic-goal','2026-10-08','saved','가상 기록','가상 관찰','','','','')`,[guardian.centerId,room,therapist.userId]);
    await tx.query(`INSERT INTO cb_record_references(center_id,conversation_id,record_id,revision,ordinal,message_id) VALUES ($1,$2,'synthetic-record',2,0,$3)`,[guardian.centerId,room,message.id]);
    await tx.query("UPDATE cb_record_revisions SET sealed=true WHERE record_id='synthetic-record' AND revision=2");
    await tx.query("UPDATE cb_records SET current_revision=2 WHERE id='synthetic-record'");
  }),{code:'23514'});
  assert.equal((await record()).revision,1);
  await assert.rejects(db.transaction(async tx=>{
    await tx.query('DELETE FROM cb_read_states');
    await tx.query(`INSERT INTO cb_message_hides(center_id,conversation_id,message_id,user_id,hidden_at)
      VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,[guardian.centerId,room,message.id,guardian.userId]);
  }),{code:'23514'});
});

test('020 upgrades existing 019 text replies and clinical references without rewriting original rows or files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'carebridge-message-migration-')),legacy=await PGlite.create();
  try{
    const source=new URL('../migrations/',import.meta.url);
    for(const name of (await readdir(source)).filter(name=>name.endsWith('.sql') && name<'020-'))await copyFile(new URL(name,source),join(directory,name));
    await migrate(legacy,pathToFileURL(directory+'/'));await fixture(legacy);
    await legacy.transaction(async tx=>{
      for(const [id,sequence,reply] of [['legacy-text',1,null],['legacy-reply',2,'legacy-text']])await tx.query(`INSERT INTO cb_messages
        (center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,reply_to)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'text','가상 레거시 본문',$8)`,[guardian.centerId,room,id,sequence,guardian.userId,randomUUID(),'a'.repeat(64),reply]);
      await tx.query(`INSERT INTO cb_records(center_id,conversation_id,id,created_by,created_sequence,current_revision) VALUES ($1,$2,'legacy-record',$3,3,1)`,[guardian.centerId,room,therapist.userId]);
      await tx.query(`INSERT INTO cb_record_revisions(center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note)
        VALUES ($1,$2,'legacy-record',1,$3,'synthetic-goal','2026-10-08','saved','가상 기록','가상 관찰','','','','')`,[guardian.centerId,room,therapist.userId]);
      await tx.query(`INSERT INTO cb_record_references(center_id,conversation_id,record_id,revision,ordinal,message_id) VALUES ($1,$2,'legacy-record',1,0,'legacy-text')`,[guardian.centerId,room]);
      await tx.query("UPDATE cb_record_revisions SET sealed=true WHERE record_id='legacy-record'");
      await tx.query('UPDATE cb_conversations SET last_sequence=3 WHERE id=$1',[room]);
    });
    const tables=['cb_messages','cb_record_references','cb_record_revisions','cb_message_attachments'];
    const before=await Promise.all(tables.map(table=>legacy.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)));
    assert.deepEqual(await migrate(legacy),['020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);assert.deepEqual(await migrate(legacy),[]);
    for(const [index,table] of tables.entries())assert.deepEqual((await legacy.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows,before[index].rows);
    const service=new Conversations(legacy);await service.editText(guardian,{conversationId:room,messageId:'legacy-text',clientId:randomUUID(),expectedRevision:1,body:'가상 새 본문'});
    assert.equal((await service.get(therapist,{conversationId:room,messageId:'legacy-reply'})).quote.body,'가상 레거시 본문');
    const saved=await new Records(legacy).get(therapist,{conversationId:room,recordId:'legacy-record'});assert.equal(saved.referenceSources[0].body,'가상 레거시 본문');
  }finally{await legacy.close();await rm(directory,{recursive:true,force:true});} // Exact mkdtemp-owned synthetic fixture only.
});
