import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Conversations} from './conversations.mjs';
import {Records} from './records.mjs';

// Owner-only fixture construction for the Windows/E disposable role rehearsal.
// Product commands below still use two independent NON-owner app connections.
export async function messageLifecycleNativeFixture(owner,label){
  const centerId=`synthetic-center-${label}`,roomId=`synthetic-room-${label}`;
  const therapist={centerId,userId:`synthetic-therapist-${label}`},guardian={centerId,userId:`synthetic-guardian-${label}`},peer={centerId,userId:`synthetic-peer-${label}`};
  await owner.transaction(async tx=>{
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)',[centerId]);
    for(const [actor,role]of [[therapist,'therapist'],[guardian,'guardian'],[peer,'guardian']]){
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[actor.userId]);
      await tx.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)',[centerId,actor.userId,role]);
    }
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[centerId,`synthetic-child-${label}`]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[centerId,roomId,`synthetic-child-${label}`]);
    for(const [actor,role]of [[therapist,'therapist'],[guardian,'guardian'],[peer,'guardian']])await tx.query(`INSERT INTO cb_participants
      (center_id,conversation_id,user_id,role,active,first_sequence) VALUES ($1,$2,$3,$4,true,1)`,[centerId,roomId,actor.userId,role]);
  });
  return {centerId,roomId,therapist,guardian,peer,send:(clientId,body='Synthetic test message')=>({conversationId:roomId,clientId,body})};
}

// Registered only in the explicit, disposable native PostgreSQL harness.
export function addMessageLifecycleNativeCases(check,databaseA,databaseB,fixture,{countEditEvents}){
  if(typeof countEditEvents!=='function')throw new TypeError('An explicit test-only audit observer is required.');
  const a=new Conversations(databaseA),b=new Conversations(databaseB);
  const input=(f,m,extra={})=>({conversationId:f.roomId,messageId:m.id,clientId:randomUUID(),expectedRevision:1,...extra});
  const query=(sql,params)=>databaseA.transaction(tx=>tx.query(sql,params));
  const get=(f,m)=>b.get(f.therapist,{conversationId:f.roomId,messageId:m.id});
  check('concurrent text edits have one version winner and preserve original send and selected quote',async()=>{
    const f=await fixture('text-edit-race'),m=await a.sendText(f.guardian,f.send(randomUUID(),'Synthetic original'));
    const reply=await b.sendText(f.therapist,{...f.send(randomUUID(),'Independent reply'),replyTo:m.id,expectedReplyVersion:1});
    const outcomes=await Promise.allSettled([a.editText(f.guardian,input(f,m,{body:'Synthetic A'})),b.editText(f.guardian,input(f,m,{body:'Synthetic B'}))]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'MESSAGE_CONFLICT');
    assert.equal((await get(f,m)).version,2);assert.equal((await get(f,reply)).quote.body,'Synthetic original');
    assert.equal((await query('SELECT body FROM cb_messages WHERE id=$1',[m.id])).rows[0].body,'Synthetic original');
  });
  check('concurrent exact edit retries commit one immutable revision receipt and audit',async()=>{
    const f=await fixture('text-retry-race'),m=await a.sendText(f.guardian,f.send(randomUUID())),command=input(f,m,{body:'Synthetic edit'});
    const results=await Promise.all([a.editText(f.guardian,command),b.editText(f.guardian,command)]);
    assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);
    assert.equal((await query('SELECT count(*)::integer AS n FROM cb_message_text_revisions WHERE message_id=$1',[m.id])).rows[0].n,2);
    // App has INSERT-only audit access. Observation must not grant it SELECT.
    assert.equal(await countEditEvents(f.centerId,f.roomId),1);
  });
  check('concurrent edit and all-delete have one winner and retries never resurrect deleted text',async()=>{
    const f=await fixture('text-delete-race'),m=await a.sendText(f.guardian,f.send(randomUUID())),edit=input(f,m,{body:'Synthetic changed'}),remove=input(f,m,{scope:'all',confirmed:true});
    const outcomes=await Promise.allSettled([a.editText(f.guardian,edit),b.deleteText(f.guardian,remove)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.ok(['MESSAGE_CONFLICT','MESSAGE_DELETED'].includes(outcomes.find(r=>r.status==='rejected').reason.code));
    if(outcomes[0].status==='fulfilled'){
      await a.deleteText(f.guardian,{...remove,clientId:randomUUID(),expectedRevision:2});assert.equal((await b.editText(f.guardian,edit)).replayed,true);
    }else assert.equal((await b.deleteText(f.guardian,remove)).replayed,true);
    const current=await get(f,m);assert.equal(current.deleted,true);assert.equal(current.authorId,null);assert.equal(current.body,'삭제된 소식입니다.');
  });
  check('clinical save versus text edit pins the selected version or rejects stale source and survives deletion',async()=>{
    const f=await fixture('text-record-race'),m=await a.sendText(f.guardian,f.send(randomUUID(),'Synthetic clinical original'));
    await query(`INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ($1,$2,'synthetic-goal','Synthetic goal','active')`,[f.centerId,f.roomId]);
    const ra=new Records(databaseA),rb=new Records(databaseB),content={date:'2026-10-08',goalId:'synthetic-goal',performed:'Synthetic observation',
      referenceMessageIds:[m.id],referenceTextRevisions:[{messageId:m.id,revision:1}]};
    const save={conversationId:f.roomId,recordId:'synthetic-record',clientId:randomUUID(),expectedRevision:0,content};
    const outcomes=await Promise.allSettled([ra.save(f.therapist,save),b.editText(f.guardian,input(f,m,{body:'Synthetic corrected'}))]);
    assert.equal(outcomes[1].status,'fulfilled');
    if(outcomes[0].status==='rejected'){
      assert.equal(outcomes[0].reason.code,'REFERENCE_CHANGED');save.clientId=randomUUID();save.content={...content,referenceTextRevisions:[{messageId:m.id,revision:2}]};await ra.save(f.therapist,save);
    }
    const before=await rb.get(f.therapist,{conversationId:f.roomId,recordId:save.recordId});
    assert.equal(before.referenceSources[0].body,before.referenceSources[0].messageRevision===1 ? 'Synthetic clinical original' : 'Synthetic corrected');
    await a.deleteText(f.guardian,input(f,m,{expectedRevision:2,scope:'all',confirmed:true}));
    await rb.save(f.therapist,{...save,clientId:randomUUID(),expectedRevision:1,content:{...save.content,performed:'Synthetic next observation'}});
    const after=await ra.get(f.therapist,{conversationId:f.roomId,recordId:save.recordId});assert.equal(after.referenceSources[0].body,before.referenceSources[0].body);assert.equal(after.referenceSources[0].deleted,true);
  });
  check('self-hide on another connection resets paging but not peer visibility or quotes',async()=>{
    const f=await fixture('text-hide'),m=await a.sendText(f.guardian,f.send(randomUUID(),'Synthetic hidden source'));
    const reply=await a.sendText(f.peer,{...f.send(randomUUID(),'Independent reply'),replyTo:m.id,expectedReplyVersion:1});
    const first=await a.list(f.therapist,{conversationId:f.roomId});
    await b.deleteText(f.therapist,input(f,m,{scope:'self',confirmed:true}));
    assert.equal((await a.list(f.therapist,{conversationId:f.roomId,expectedRevision:first.revision})).resetRequired,true);
    await assert.rejects(get(f,m),{code:'NOT_FOUND'});assert.equal((await get(f,reply)).quote.hidden,true);
    assert.equal((await b.get(f.peer,{conversationId:f.roomId,messageId:reply.id})).quote.body,'Synthetic hidden source');
  });
  check('lost native connection before mutation receipt rolls back history head and audit then exact retry succeeds',async()=>{
    const f=await fixture('text-disconnect'),m=await a.sendText(f.guardian,f.send(randomUUID())),command=input(f,m,{body:'Synthetic retry after disconnect'});
    const interrupted=new Conversations({transaction:work=>databaseA.transaction(tx=>work({query:async(sql,params)=>{
      if(sql.includes('INSERT INTO cb_message_change_requests'))await tx.query('SELECT pg_terminate_backend(pg_backend_pid())');
      return tx.query(sql,params);
    }}))});
    await assert.rejects(interrupted.editText(f.guardian,command),error=>['57P01','DATABASE_CONNECTION_LOST'].includes(error.code)||error.message==='Connection terminated unexpectedly');
    assert.equal((await get(f,m)).version,1);
    assert.equal((await query('SELECT count(*)::integer AS n FROM cb_message_text_revisions WHERE message_id=$1',[m.id])).rows[0].n,1);
    assert.equal((await a.editText(f.guardian,command)).replayed,false);assert.equal((await b.editText(f.guardian,command)).replayed,true);
  });
}
