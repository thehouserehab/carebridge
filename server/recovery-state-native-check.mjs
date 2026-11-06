// Explicit synthetic harness ONLY. Never imported by a service or HTTP route.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {lstat,open,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Auth} from './auth.mjs';
import {Conversations} from './conversations.mjs';
import {Records} from './records.mjs';
import {messageLifecycleNativeFixture} from './message-lifecycle-native-tests.mjs';
import {quarantineRestoredDatabase} from './recovery-quarantine.mjs';
import {compareRestoredDatabaseState} from './recovery-state-comparison.mjs';
import {RepositoryError} from './errors.mjs';
import {exercisePreparedRecoveryFaults} from './recovery-prepared-faults.mjs';
import {verifyQuarantinedRecoveryRecipientFixture} from './recovery-recipient-native-check.mjs';

export async function seedRecoveryStateComparison(source){
  const f=await messageLifecycleNativeFixture(source,'recovery-state');
  const manager={centerId:f.centerId,userId:'synthetic-recovery-state-manager'};
  await source.transaction(async tx=>{
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[manager.userId]);
    await tx.query("INSERT INTO cb_memberships VALUES ($1,$2,'center',true)",[f.centerId,manager.userId]);
    await tx.query("INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ($1,$2,'synthetic-goal','Synthetic goal','active')",[f.centerId,f.roomId]);
  });
  const password=randomBytes(32).toString('hex'),auth=new Auth(source,{password:{N:1024,r:8,p:1,maxmem:32*1024**2}});
  await auth.provisionAccount({userId:f.guardian.userId,email:'guardian.synthetic-state@example.invalid',password});
  const session=await auth.login({email:'guardian.synthetic-state@example.invalid',password});
  const invitation=await auth.createInvitation(manager,{centerId:f.centerId,email:'pending.synthetic-state@example.invalid',role:'guardian'});
  const resetHash=randomBytes(32).toString('hex');
  await source.transaction(tx=>tx.query(`INSERT INTO cb_auth_password_resets(token_hash,user_id,expires_at)
    VALUES ($1,$2,clock_timestamp()+interval '600 seconds')`,[resetHash,f.guardian.userId]));
  const chat=new Conversations(source),records=new Records(source);
  const edited=await chat.sendText(f.guardian,f.send(randomUUID(),'Synthetic original before backup'));
  const hidden=await chat.sendText(f.peer,f.send(randomUUID(),'Synthetic peer before backup'));
  const recordId='synthetic-recovery-state-record';
  await records.save(f.therapist,{conversationId:f.roomId,recordId,clientId:randomUUID(),expectedRevision:0,
    content:{date:'2026-10-08',goalId:'synthetic-goal',performed:'Synthetic activity',summary:'Synthetic family summary',
      referenceMessageIds:[edited.id],referenceTextRevisions:[{messageId:edited.id,revision:1}]}});
  const preview=await records.preview(f.therapist,{conversationId:f.roomId,recordId});
  const publication=await records.publish(f.therapist,{conversationId:f.roomId,recordId,clientId:randomUUID(),expectedRevision:preview.recordRevision,
    expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds});
  return {...f,manager,password,session,invitation,resetHash,edited,hidden,publication};
}

// These mutations are solely to exact files in the caller's newly created
// synthetic roots. The product comparison must not write, repair or release.
async function exerciseRecoveryFiles({source,target,input,fingerprint,media,check}){
  const {roots,object,blocked,bytes}=media;
  for(const key of [object,blocked])assert.match(key,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const assertRoot=async receipt=>{
    const info=await lstat(receipt.path,{bigint:true});assert.ok(info.isDirectory()&&!info.isSymbolicLink());
    assert.equal(info.dev.toString(),receipt.dev);assert.equal(info.ino.toString(),receipt.ino);
  };
  const fileFingerprint=async receipt=>{
    await assertRoot(receipt);const inventory=[];
    for(const name of (await readdir(receipt.path)).sort()){
      assert.match(name,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(blob|blocked)$/);
      const path=join(receipt.path,name),info=await lstat(path,{bigint:true});
      assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n);
      inventory.push({name,dev:String(info.dev),ino:String(info.ino),size:String(info.size),
        mtime:String(info.mtimeNs),ctime:String(info.ctimeNs),sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
    }
    return inventory; // Private assertion value only; never returned or logged.
  };
  const fresh=async(path,data)=>{
    const handle=await open(path,'wx',0o600);
    try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  };
  const inspect=async()=>{
    const beforeSource=await fingerprint(source),beforeTarget=await fingerprint(target);
    const sourceFiles=await fileFingerprint(roots.source),targetFiles=await fileFingerprint(roots.target);
    try{
      const result=await compareRestoredDatabaseState(source,target,{...input,mediaRoots:roots});
      assert.equal(result.dataMatches,true);assert.equal(result.authClosed,true);assert.equal(result.serviceReleaseAllowed,false);
      assert.equal(result.externalFilesChecked,true);assert.equal(result.filesystemWriterQuiescenceVerified,false);
      return result;
    }finally{
      assert.deepEqual(await fingerprint(source),beforeSource);assert.deepEqual(await fingerprint(target),beforeTarget);
      assert.deepEqual(await fileFingerprint(roots.source),sourceFiles);assert.deepEqual(await fileFingerprint(roots.target),targetFiles);
      assert.equal((await target.transaction(tx=>tx.query(`SELECT
        (SELECT count(*) FROM cb_recovery_quarantine)=1 AND NOT EXISTS(SELECT 1 FROM cb_users WHERE active) AND
        NOT EXISTS(SELECT 1 FROM cb_auth_sessions WHERE revoked_at IS NULL) AND
        NOT EXISTS(SELECT 1 FROM cb_auth_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL) AND
        NOT EXISTS(SELECT 1 FROM cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL) AS closed`))).rows[0].closed,true);
    }
  };
  const targetBlob=join(roots.target.path,`${object}.blob`),targetFence=join(roots.target.path,`${blocked}.blocked`);
  await check('native DB plus authenticated PNG/fence restoration matches without releasing quarantine or claiming writer shutdown',async()=>{
    assert.deepEqual(await readFile(targetBlob),bytes);assert.equal((await readFile(targetFence)).length,0);
    const result=await inspect();assert.equal(result.externalFilesMatch,true);assert.deepEqual(result.externalFileDifferences,[]);
  });
  if(media.prepared){
    const allowed=new Set(media.prepared.map(sample=>sample.object));
    const candidatePath=async(object,{exists=true}={})=>{
      assert.ok(allowed.has(object));assert.match(object,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      await assertRoot(roots.target);const path=join(roots.target.path,`${object}.blob`);
      if(exists){const info=await lstat(path,{bigint:true});assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n);}
      return path;
    };
    await exercisePreparedRecoveryFaults({samples:media.prepared,inspect,check,files:{
      read:async object=>readFile(await candidatePath(object)),
      write:async(object,bytes)=>writeFile(await candidatePath(object),bytes),
      remove:async object=>unlink(await candidatePath(object)),
      create:async(object,bytes)=>fresh(await candidatePath(object,{exists:false}),bytes),
    }});
  }
  await check('changed target PNG bytes fail file-content comparison although both native databases still match and remain untouched',async()=>{
    await assertRoot(roots.target);const changed=Buffer.from(bytes);changed[0]^=255;
    await writeFile(targetBlob,changed);
    try{const result=await inspect();assert.equal(result.externalFilesMatch,false);assert.deepEqual(result.externalFileDifferences,['file-content']);}
    finally{await assertRoot(roots.target);await writeFile(targetBlob,bytes);}
  });
  await check('missing target PNG fails file inventory comparison without silent replacement or database changes',async()=>{
    await assertRoot(roots.target);assert.deepEqual(await readFile(targetBlob),bytes);await unlink(targetBlob);
    try{const result=await inspect();assert.equal(result.externalFilesMatch,false);assert.ok(result.externalFileDifferences.includes('file-inventory'));}
    finally{await assertRoot(roots.target);await fresh(targetBlob,bytes);}
  });
  await check('new source orphan deletion fence is detected without DB changes or automatic deletion of restored bytes',async()=>{
    await assertRoot(roots.source);const fence=join(roots.source.path,`${randomUUID()}.blocked`);await fresh(fence,Buffer.alloc(0));
    try{const result=await inspect();assert.equal(result.externalFilesMatch,false);assert.deepEqual(result.externalFileDifferences,['deletion-fence']);}
    finally{await assertRoot(roots.source);assert.equal((await readFile(fence)).length,0);await unlink(fence);}
  });
  await check('unknown target blob and nonempty deletion fence are rejected while native data files and quarantine stay unchanged',async()=>{
    await assertRoot(roots.target);const unknown=join(roots.target.path,`${randomUUID()}.blob`);await fresh(unknown,bytes);
    try{await assert.rejects(inspect(),{code:'RECOVERY_STATE_MEDIA_UNAVAILABLE'});}
    finally{await assertRoot(roots.target);assert.deepEqual(await readFile(unknown),bytes);await unlink(unknown);}
    await writeFile(targetFence,Buffer.from('synthetic-invalid-fence'));
    try{await assert.rejects(inspect(),{code:'RECOVERY_STATE_MEDIA_UNAVAILABLE'});}
    finally{await assertRoot(roots.target);await writeFile(targetFence,Buffer.alloc(0));}
  });
}

export async function exerciseRecoveryStateComparison({source,sourcePeer,target,input,fixture:f,recipientFixture,fingerprint,mediaObject,media,onQuarantined,onPass=()=>{}}){
  assert.ok(recipientFixture);
  const checks=[],constraints={};let sqlstate=null;
  const observed=(db,side='source')=>({transaction:work=>db.transaction(tx=>work({query:async(sql,params)=>{
    try{const result=await tx.query(sql,params);
      if(sql.startsWith('SELECT c.relname,k.conname'))constraints[side]=result.rows;
      return result;
    }catch(error){if(/^[A-Z0-9]{5}$/.test(error?.code??''))sqlstate=error.code;throw error;}
  }}))});
  const observedSource=observed(source),observedTarget=observed(target,'target');
  const check=async(label,work)=>{
    try{await work();checks.push(label);onPass(label);}catch(error){
      error.recoveryStateObservation={phase:checks.length+1,sqlstate,
        ...(error instanceof RepositoryError&&/^[A-Z_]{1,64}$/.test(error.code)?{repositoryCode:error.code}:{}),
        ...(['inventory','migrations','columns','constraints','triggers','functions','indexes'].includes(error?.component)?{component:error.component}:{}),
        ...(/^RECOVERY_STATE_[A-Z_]+$/.test(error?.actual?.code??'')?{assertionActualCode:error.actual.code}:{}),
        code:/^RECOVERY_STATE_[A-Z_]+$/.test(error?.code??'')?error.code:'RECOVERY_STATE_CHECK_FAILED'};
      if(error?.component==='constraints'&&constraints.source&&constraints.target){
        const first=constraints.source.findIndex((row,index)=>JSON.stringify(row)!==JSON.stringify(constraints.target[index]));
        const a=constraints.source[first],b=constraints.target[first];
        error.recoveryStateObservation.constraintDifference={index:first,sourceCount:constraints.source.length,targetCount:constraints.target.length,
          fields:['relname','conname','contype','definition'].filter(key=>a?.[key]!==b?.[key]),
          nonNullabilityMatches:JSON.stringify(constraints.source.filter(row=>row.contype!=='n'))===JSON.stringify(constraints.target.filter(row=>row.contype!=='n')),
          sourceKind:/^[a-z]$/.test(a?.contype??'')?a.contype:null,targetKind:/^[a-z]$/.test(b?.contype??'')?b.contype:null};
      }
      throw error;
    }
  };
  const inspect=async(database=source)=>{
    const beforeSource=await fingerprint(source),beforeTarget=await fingerprint(target);
    const result=await compareRestoredDatabaseState(observed(database),observedTarget,input);
    assert.deepEqual(await fingerprint(source),beforeSource);assert.deepEqual(await fingerprint(target),beforeTarget);
    assert.equal(result.authClosed,true);assert.equal(result.serviceReleaseAllowed,false);assert.equal(result.externalFilesChecked,false);
    return result;
  };
  await check('state comparison refuses an unquarantined native restore before reading domain data',async()=>{
    await assert.rejects(compareRestoredDatabaseState(observedSource,observedTarget,input),{code:'RECOVERY_STATE_QUARANTINE_MISMATCH'});
  });
  await quarantineRestoredDatabase(target,input);
  await check('state comparison binds exact quarantine bundle database OIDs owners and confirmation',async()=>{
    await assert.rejects(compareRestoredDatabaseState(observedSource,observedTarget,{...input,bundleId:randomUUID()}),{code:'RECOVERY_STATE_QUARANTINE_MISMATCH'});
    await assert.rejects(compareRestoredDatabaseState(observedSource,observedTarget,{...input,targetReceipt:{...input.targetReceipt,oid:input.targetReceipt.oid+1}}),
      {code:'RECOVERY_STATE_TARGET_MISMATCH'});
  });
  await check('all 65 native data tables and recipient identity match with users sessions invitations and pending password resets closed',async()=>{
    const result=await inspect();assert.equal(result.dataMatches,true);assert.equal(result.comparedTables,65);
    assert.deepEqual(result.differences,[]);
    const reset=async db=>(await db.transaction(tx=>tx.query('SELECT * FROM cb_auth_password_resets WHERE token_hash=$1',[f.resetHash]))).rows[0];
    const sourceReset=await reset(source),targetReset=await reset(target);
    assert.equal(sourceReset.revoked_at,null);assert.ok(targetReset.revoked_at);
    assert.deepEqual({...targetReset,revoked_at:null},sourceReset);
    assert.equal((await target.transaction(tx=>tx.query(`SELECT count(*)::integer AS n FROM cb_auth_password_resets
      WHERE consumed_at IS NULL AND revoked_at IS NULL`))).rows[0].n,0);
    await verifyQuarantinedRecoveryRecipientFixture({owner:target,fixture:recipientFixture,fingerprint});
  });
  if(onQuarantined)await check('022 private review and old receipts survive quarantine while legitimate new writes remain refused',async()=>{
    await onQuarantined(target);
  });
  if(media)await exerciseRecoveryFiles({source,target,input,fingerprint,media,check});
  await check('source SHARE locks reject a concurrent writer on another real connection without changing either database',async()=>{
    let observed=false;
    const interleaved={transaction:work=>source.transaction(tx=>work({query:async(sql,params)=>{
      if(!observed&&sql.startsWith('FETCH')){
        observed=true;
        await assert.rejects(sourcePeer.transaction(async peer=>{
          await peer.query("SET LOCAL lock_timeout = '50ms'");
          await peer.query('UPDATE public.cb_participants SET active=false WHERE user_id=$1',[f.guardian.userId]);
        }),{code:'55P03'});
      }
      return tx.query(sql,params);
    }}))};
    assert.equal((await inspect(interleaved)).dataMatches,true);assert.equal(observed,true);
  });
  await check('real weakened CHECK is refused while equivalent PostgreSQL dump parentheses remain accepted',async()=>{
    const original=(await source.transaction(tx=>tx.query(`SELECT pg_catalog.pg_get_constraintdef(oid,true) AS definition
      FROM pg_catalog.pg_constraint WHERE conrelid='public.cb_child_profiles'::regclass AND conname='cb_child_profiles_name_check'`))).rows[0].definition;
    await target.transaction(async tx=>{
      await tx.query('ALTER TABLE public.cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
      await tx.query('ALTER TABLE public.cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check CHECK (length(name)<=300)');
    });
    await assert.rejects(compareRestoredDatabaseState(observedSource,observedTarget,input),{code:'RECOVERY_STATE_SCHEMA_MISMATCH',component:'constraints'});
    await target.transaction(async tx=>{
      await tx.query('ALTER TABLE public.cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
      // Definition comes only from this owned synthetic source's catalog.
      await tx.query(`ALTER TABLE public.cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check ${original}`);
    });
    assert.equal((await inspect()).dataMatches,true);
  });
  const chat=new Conversations(source),command=(message,extra)=>({conversationId:f.roomId,messageId:message.id,clientId:randomUUID(),expectedRevision:1,...extra});
  await check('post-backup text edit is detected while original send and pinned clinical source remain intact',async()=>{
    await chat.editText(f.guardian,command(f.edited,{body:'Synthetic edited after backup'}));
    const result=await inspect();assert.equal(result.dataMatches,false);
    for(const table of ['cb_message_text_heads','cb_message_text_revisions'])assert.ok(result.differences.includes(table));
    assert.equal((await target.transaction(tx=>tx.query('SELECT body FROM cb_messages WHERE id=$1',[f.edited.id]))).rows[0].body,'Synthetic original before backup');
  });
  await check('post-backup self-hide is detected instead of silently restoring the hidden conversation item',async()=>{
    await chat.deleteText(f.guardian,command(f.hidden,{scope:'self',confirmed:true}));
    assert.ok((await inspect()).differences.includes('cb_message_hides'));
  });
  await check('post-backup all-delete is detected without rewriting the old immutable text history',async()=>{
    await chat.deleteText(f.guardian,command(f.edited,{expectedRevision:2,scope:'all',confirmed:true}));
    const result=await inspect();assert.ok(result.differences.includes('cb_message_text_revisions'));
    assert.equal((await chat.get(f.therapist,{conversationId:f.roomId,messageId:f.edited.id})).deleted,true);
    assert.equal((await target.transaction(tx=>tx.query('SELECT current_revision FROM cb_message_text_heads WHERE message_id=$1',[f.edited.id]))).rows[0].current_revision,1);
  });
  await check('post-backup publication withdrawal is detected while independent clinical and reply history stays retained',async()=>{
    await chat.withdraw(f.therapist,{conversationId:f.roomId,messageId:f.publication.messageId});
    assert.ok((await inspect()).differences.includes('cb_publications'));
  });
  await check('post-backup participant disconnect and membership stop are detected without restoring access',async()=>{
    await source.transaction(async tx=>{
      await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND user_id=$2',[f.centerId,f.peer.userId]);
      await tx.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2',[f.centerId,f.peer.userId]);
    });
    const result=await inspect();for(const table of ['cb_participants','cb_memberships'])assert.ok(result.differences.includes(table));
  });
  await check('post-backup password change session closure and invitation withdrawal cannot be ignored',async()=>{
    const auth=new Auth(source,{password:{N:1024,r:8,p:1,maxmem:32*1024**2}});
    await auth.changePassword(f.session.token,{currentPassword:f.password,newPassword:randomBytes(32).toString('hex')});
    await auth.revokeInvitation(f.manager,{centerId:f.centerId,invitationId:f.invitation.id});
    const result=await inspect();for(const table of ['cb_auth_accounts','cb_account_security_events','cb_auth_audit_events'])assert.ok(result.differences.includes(table));
  });
  await check('post-backup media deletion intent is detected but does not physically erase or serve any file',async()=>{
    await source.transaction(async tx=>{
      await tx.query("UPDATE cb_media_uploads SET state='delete_pending',version=version+1 WHERE object_key=$1",[mediaObject]);
      await tx.query("UPDATE cb_media_objects SET state='delete_pending' WHERE key=$1",[mediaObject]);
    });
    assert.ok((await inspect()).differences.includes('cb_media_objects'));
    assert.equal((await target.transaction(tx=>tx.query('SELECT state FROM cb_media_objects WHERE key=$1',[mediaObject]))).rows[0].state,'active');
  });
  await check('repeated mismatch checks leave native restore quarantine and all original data unchanged',async()=>{
    const a=await inspect(),b=await inspect();assert.deepEqual(a,b);assert.equal(a.dataMatches,false);
    assert.equal((await target.transaction(tx=>tx.query('SELECT count(*)::integer AS n FROM cb_recovery_quarantine'))).rows[0].n,1);
    assert.equal((await target.transaction(tx=>tx.query('SELECT count(*)::integer AS n FROM cb_users WHERE active'))).rows[0].n,0);
    assert.equal((await target.transaction(tx=>tx.query(`SELECT count(*)::integer AS n FROM cb_auth_password_resets
      WHERE consumed_at IS NULL AND revoked_at IS NULL`))).rows[0].n,0);
  });
  return checks;
}
