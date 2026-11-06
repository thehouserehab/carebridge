import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir,mkdtemp,mkdir,lstat,rmdir,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DATABASE_TABLES,DATABASE_FUNCTIONS} from '../database-privilege-policy.mjs';
import {compareRestoredDatabaseState,RecoveryStateComparisonError,RECOVERY_USER_STATE_EXPRESSIONS} from '../recovery-state-comparison.mjs';

// Contract doubles only; actual cursors, SHARE locks, native dump/restore and
// the same-cluster lock challenge are also tested by the explicit E harness.
const input=()=>({operationId:randomUUID(),bundleId:randomUUID(),sourceReceipt:{name:'synthetic_source',oid:1001,ownerOid:42},
  targetReceipt:{name:'synthetic_restore',oid:1002,ownerOid:42},confirmTarget:'synthetic_restore'});
const code=value=>error=>error instanceof RecoveryStateComparisonError&&error.code===value&&error.message===value&&!error.cause;
const directory=new URL('../migrations/',import.meta.url);
const migrations=await Promise.all((await readdir(directory)).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort()
  .map(async name=>({name,checksum:createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')})));
function fixture(request,changes={}){
  const approved=structuredClone(request),queries=[],receipts={
    operation_id:approved.operationId,bundle_id:approved.bundleId,source_name:approved.sourceReceipt.name,source_oid:approved.sourceReceipt.oid,
    source_owner_oid:approved.sourceReceipt.ownerOid,target_name:approved.targetReceipt.name,target_oid:approved.targetReceipt.oid,owner_oid:approved.targetReceipt.ownerOid};
  function connection(side){
    const current=side==='source'?approved.sourceReceipt:approved.targetReceipt;let table,pages=0,omissions=[],normalizeUserGeneration=false;
    return {async transaction(work){
      changes.onTransaction?.(side,true);
      try{
      const result=await work({async query(sql,params){
        queries.push({side,sql,params});await changes.onQuery?.(side,sql);
        if(changes.failSide===side&&sql.startsWith(changes.failAt??'FETCH'))throw new Error('PRIVATE: postgresql://secret / child / hash');
        if(sql.includes('FROM pg_catalog.pg_database'))return {rows:[approved.sourceReceipt,approved.targetReceipt].map(r=>({
          datname:r.name,oid:String(r.oid),owner_oid:String(r.ownerOid),role_oid:'42',current_database:current.name,direct_role:true,
          ...(changes.identitySide===side?changes.identity:{})}))};
        if(sql.startsWith('SELECT c.relname,c.relkind'))return {rows:DATABASE_TABLES.map(relname=>({relname,relkind:'r',relpersistence:'p',
          relrowsecurity:false,relforcerowsecurity:false,owner_oid:'42',...(changes.tableSide===side?changes.table:{})}))};
        if(sql==='SELECT * FROM public.cb_recovery_quarantine')return {rows:side==='source'?(changes.sourceGate?[receipts]:[]):
          changes.noGate?[]:[{...receipts,...changes.gate}]};
        if(sql.startsWith('SELECT name,checksum'))return {rows:changes.migrations?.[side]??
          (changes.migrationSide===side?migrations.slice(0,-1):migrations)};
        if(sql.startsWith('SELECT p.proname'))return {rows:DATABASE_FUNCTIONS.map(proname=>({proname,definition:changes.shapeSide===side?'changed':'same'}))};
        if(sql.startsWith('SELECT pg_catalog.pg_try_advisory_xact_lock'))return {rows:[{locked:true,pid:321}]};
        if(sql.includes('FROM pg_catalog.pg_locks'))return {rows:[{shared_source_lock:!changes.otherCluster}]};
        if(sql.startsWith('SELECT NOT EXISTS'))return {rows:[{closed:!changes.authOpen&&
          !(changes.resetOpen&&sql.includes('public.cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL'))}]};
        if(sql.startsWith('DECLARE')){
          table=sql.match(/FROM public\."([a-z_]+)"/)[1];pages=0;
          omissions=[...(sql.match(/ - ARRAY\[([^\]]+)\]/)?.[1]??'').matchAll(/'([a-z_]+)'/g)].map(match=>match[1]);
          normalizeUserGeneration=sql.includes(RECOVERY_USER_STATE_EXPRESSIONS.source);
          return {rows:[]};
        }
        if(sql.startsWith('FETCH')){
          const values=(changes.rows?.[side]?.[table]??['SYNTHETIC-PRIVATE-ROW']).map(value=>{
            if(typeof value==='string')return {row:value};
            const normalized={...value};
            if(normalizeUserGeneration&&value.active===true)normalized.communication_generation=value.communication_generation+1;
            return {row:JSON.stringify(Object.fromEntries(Object.entries(normalized).filter(([name])=>!omissions.includes(name))))};
          });
          return {rows:values.slice(pages++*128,pages*128)};
        }
        return {rows:[]};
      }});
      if(changes.lostCommit===side)throw new Error('PRIVATE UNKNOWN COMMIT');return result;
      }finally{changes.onTransaction?.(side,false);}
    }};
  }
  return {source:connection('source'),target:connection('target'),queries};
}

test('restore comparison requires exact approval, distinct databases and transactions before connection',async()=>{
  const good=input(),f=fixture(good);
  for(const bad of [null,{}, {...good,extra:true},{...good,operationId:0},{...good,bundleId:'invalid'},
    {...good,confirmTarget:good.sourceReceipt.name},{...good,targetReceipt:good.sourceReceipt},
    {...good,sourceReceipt:{...good.sourceReceipt,oid:good.targetReceipt.oid}},
    {...good,targetReceipt:{...good.targetReceipt,ownerOid:'42'}},
    {...good,targetReceipt:{...good.targetReceipt,name:'postgres'},confirmTarget:'postgres'}])
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,bad),code('RECOVERY_STATE_INVALID_INPUT'));
  await assert.rejects(compareRestoredDatabaseState(f.source,f.source,good),code('RECOVERY_STATE_INVALID_INPUT'));
  assert.equal(f.queries.length,0);
});
test('matching data remains quarantined and output exposes no original rows, names, counts or digests',async()=>{
  const request=input(),f=fixture(request),result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.deepEqual(result,{policyVersion:1,operationId:request.operationId,bundleId:request.bundleId,comparedTables:65,
    dataMatches:true,differences:[],authClosed:true,serviceReleaseAllowed:false,externalFilesChecked:false});
  const serialized=JSON.stringify(result);
  for(const secret of ['SYNTHETIC-PRIVATE-ROW','synthetic_source','synthetic_restore','digest','password_hash'])assert.equal(serialized.includes(secret),false);
  assert.equal(f.queries.some(q=>/^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|REVOKE)/.test(q.sql)),false);
  for(const side of ['source','target'])assert.ok(f.queries.findIndex(q=>q.side===side&&q.sql.startsWith('LOCK'))<
    f.queries.findIndex(q=>q.side===side&&q.sql.startsWith('DECLARE')));
});
test('data comparison pages past 128 rows and fails on equal-count body changes and missing history',async()=>{
  const rows=Array.from({length:260},(_,i)=>`SYNTHETIC-${i}`),changed=[...rows];changed[259]='SYNTHETIC-CHANGED';
  const request=input(),f=fixture(request,{rows:{source:{cb_message_text_revisions:rows,cb_message_hides:['one','two']},
    target:{cb_message_text_revisions:changed,cb_message_hides:['one']}}});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.equal(result.dataMatches,false);assert.deepEqual(result.differences,['cb_message_hides','cb_message_text_revisions']);
  assert.equal(result.serviceReleaseAllowed,false);
});

function communicationRows(){
  const room={center_id:'synthetic-generation-center',conversation_id:'synthetic-generation-room'};
  return {
    cb_users:[{id:'synthetic-active-recipient',active:true,communication_generation:11},
      {id:'synthetic-inactive-recipient',active:false,communication_generation:7}],
    cb_memberships:[{center_id:room.center_id,user_id:'synthetic-active-recipient',role:'care_recipient',active:true,communication_generation:5}],
    cb_participants:[{...room,user_id:'synthetic-active-recipient',role:'care_recipient',active:true,first_sequence:14,communication_generation:9}],
    cb_care_recipient_links:[{...room,child_id:'synthetic-generation-child',user_id:'synthetic-active-recipient',role:'care_recipient',
      linked_by:'synthetic-generation-manager',linked_at:'2026-10-16T00:01:00.000Z'}],
    cb_primary_communicators:[{...room,user_id:'synthetic-active-recipient',user_generation:11,membership_generation:5,participant_generation:9,
      revision:3,updated_by:'synthetic-generation-manager',updated_at:'2026-10-16T00:02:00.000Z'}],
    cb_primary_communicator_requests:[{...room,actor_id:'synthetic-generation-manager',client_id:'synthetic-generation-request',
      request_hash:'d'.repeat(64),expected_revision:2,applied_revision:3,changed:true,occurred_at:'2026-10-16T00:02:00.000Z'}],
    cb_record_recipients:[{...room,publication_id:'synthetic-generation-publication',user_id:'synthetic-original-guardian'}],
  };
}
function quarantinedCommunicationRows(sourceRows){
  const targetRows=structuredClone(sourceRows);
  for(const row of targetRows.cb_users){if(row.active)row.communication_generation++;row.active=false;}
  return targetRows;
}
async function compareCommunicationRows(sourceRows,targetRows){
  const before=structuredClone({source:sourceRows,target:targetRows}),request=input();
  const f=fixture(request,{rows:{source:sourceRows,target:targetRows}});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.deepEqual({source:sourceRows,target:targetRows},before);
  assert.equal(result.authClosed,true);assert.equal(result.serviceReleaseAllowed,false);
  assert.equal(f.queries.some(q=>/^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|REVOKE)/.test(q.sql)),false);
  assert.equal(JSON.stringify(result).includes('synthetic-active-recipient'),false);
  return {result,queries:f.queries};
}

test('023 quarantine compares the source-only active-user generation increment with the exact target generation',async()=>{
  const sourceRows=communicationRows(),targetRows=quarantinedCommunicationRows(sourceRows);
  const {result,queries}=await compareCommunicationRows(sourceRows,targetRows);
  assert.equal(result.dataMatches,true);assert.deepEqual(result.differences,[]);
  for(const side of ['source','target']){
    const declaration=queries.find(q=>q.side===side&&q.sql.startsWith('DECLARE')&&q.sql.includes('public."cb_users"'));
    const expression=RECOVERY_USER_STATE_EXPRESSIONS[side];
    assert.equal(declaration.sql,`DECLARE cb_recovery_compare NO SCROLL CURSOR FOR SELECT (${expression})::text AS row
    FROM public."cb_users" t ORDER BY (${expression})::text COLLATE "C"`);
    assert.equal(declaration.sql.includes('CASE WHEN t.active'),side==='source');
    assert.equal(/ - ARRAY\[[^\]]*'communication_generation'/.test(declaration.sql),false);
  }
  // Existing primary-contact eligibility snapshots stay old and thus revoked,
  // rather than being silently refreshed to the quarantined user generation.
  assert.deepEqual(targetRows.cb_primary_communicators,sourceRows.cb_primary_communicators);
});

test('023 generation drift on either source or target, including an already-inactive user, never matches',async()=>{
  for(const side of ['source','target'])for(const rowIndex of [0,1])for(const delta of [-1,1,2]){
    const sourceRows=communicationRows(),targetRows=quarantinedCommunicationRows(sourceRows);
    (side==='source'?sourceRows:targetRows).cb_users[rowIndex].communication_generation+=delta;
    const {result}=await compareCommunicationRows(sourceRows,targetRows);
    assert.equal(result.dataMatches,false,`${side} user ${rowIndex} delta ${delta}`);
    assert.deepEqual(result.differences,['cb_users']);
  }
  const sourceRows=communicationRows(),targetRows=quarantinedCommunicationRows(sourceRows);
  sourceRows.cb_users[0].active=false;
  const {result}=await compareCommunicationRows(sourceRows,targetRows);
  assert.equal(result.dataMatches,false);assert.deepEqual(result.differences,['cb_users']);
});

test('023 source normalization never erases authority, stable links, contact snapshots or immutable receipts',async()=>{
  const changes={
    cb_memberships:[{communication_generation:6},{role:'center'},{active:false}],
    cb_participants:[{communication_generation:10},{first_sequence:1},{role:'guardian'},{active:false}],
    cb_care_recipient_links:[{child_id:'synthetic-reassigned-child'},{user_id:'synthetic-other-recipient'},
      {linked_by:'synthetic-other-manager'},{linked_at:'2026-10-16T00:03:00.000Z'}],
    cb_primary_communicators:[{user_generation:12},{membership_generation:6},{participant_generation:10},
      {user_id:null},{revision:4},{updated_by:'synthetic-other-manager'},{updated_at:'2026-10-16T00:03:00.000Z'}],
    cb_primary_communicator_requests:[{request_hash:'e'.repeat(64)},{expected_revision:1},{applied_revision:4},{changed:false}],
    cb_record_recipients:[{user_id:'synthetic-active-recipient'}],
  };
  for(const [table,patches]of Object.entries(changes))for(const patch of patches)for(const side of ['source','target']){
    const sourceRows=communicationRows(),targetRows=quarantinedCommunicationRows(sourceRows);
    Object.assign((side==='source'?sourceRows:targetRows)[table][0],patch);
    const {result,queries}=await compareCommunicationRows(sourceRows,targetRows);
    assert.equal(result.dataMatches,false,`${side} ${table} ${Object.keys(patch)[0]}`);
    assert.deepEqual(result.differences,[table]);
    for(const declaration of queries.filter(q=>q.sql.startsWith('DECLARE')&&q.sql.includes(`public."${table}"`))){
      assert.equal(declaration.sql.includes(' - ARRAY['),false);
      assert.equal(declaration.sql.includes('CASE WHEN'),false);
    }
  }
});

// These rows model a latest note at source revision 2 and two immutable
// receipts. The earlier receipt intentionally does not point at the review
// head's current version. This double tests comparison, not SQL FK behavior.
function privateReviewRows(){
  const identity={center_id:'synthetic-review-center',conversation_id:'synthetic-review-room',message_id:'synthetic-review-message'};
  const actor='synthetic-review-therapist';
  return {
    cb_message_reviews:[{...identity,reviewer_id:actor,note:'SYNTHETIC-PRIVATE-LATEST-REVIEW',
      message_revision:2,review_version:2,updated_at:'2026-10-09T00:02:00.000Z'}],
    cb_message_review_requests:[
      {...identity,actor_id:actor,client_id:'synthetic-review-request-0001',request_hash:'a'.repeat(64),
        message_revision:1,review_version:1,occurred_at:'2026-10-09T00:01:00.000Z'},
      {...identity,actor_id:actor,client_id:'synthetic-review-request-0002',request_hash:'b'.repeat(64),
        message_revision:2,review_version:2,occurred_at:'2026-10-09T00:02:00.000Z'},
    ],
  };
}

async function comparePrivateReviews(sourceRows,targetRows){
  const before=structuredClone({source:sourceRows,target:targetRows}),request=input();
  const f=fixture(request,{rows:{source:sourceRows,target:targetRows}});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.deepEqual({source:sourceRows,target:targetRows},before);
  assert.equal(f.queries.some(q=>/^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|REVOKE)/.test(q.sql)),false);
  assert.equal(result.authClosed,true);assert.equal(result.serviceReleaseAllowed,false);
  for(const value of ['SYNTHETIC-PRIVATE-LATEST-REVIEW','synthetic-review-message','a'.repeat(64),'b'.repeat(64)])
    assert.equal(JSON.stringify(result).includes(value),false);
  return {result,queries:f.queries};
}

test('022 latest private review and its older pinned receipts match without omitting any review fields',async()=>{
  const rows=privateReviewRows(),{result,queries}=await comparePrivateReviews(rows,structuredClone(rows));
  assert.equal(result.dataMatches,true);assert.deepEqual(result.differences,[]);
  for(const side of ['source','target'])for(const table of Object.keys(rows)){
    const declaration=queries.find(q=>q.side===side&&q.sql.startsWith('DECLARE')&&q.sql.includes(`public."${table}"`));
    assert.ok(declaration);assert.equal(declaration.sql.includes(' - ARRAY['),false);
  }
});

test('022 equal-count note version source pin and historical receipt changes cannot be normalized away',async()=>{
  const changes={
    cb_message_reviews:[{note:'SYNTHETIC-PRIVATE-CHANGED-REVIEW'},{review_version:3},{message_revision:1},
      {reviewer_id:'synthetic-other-therapist'},{updated_at:'2026-10-09T00:03:00.000Z'}],
    cb_message_review_requests:[{request_hash:'c'.repeat(64)},{message_revision:2},{review_version:2},
      {client_id:'synthetic-review-request-replaced'},{actor_id:'synthetic-other-therapist'},
      {message_id:'synthetic-other-message'},{occurred_at:'2026-10-09T00:03:00.000Z'}],
  };
  for(const [table,patches]of Object.entries(changes))for(const patch of patches)for(const changedSide of ['source','target']){
    const sourceRows=privateReviewRows(),targetRows=structuredClone(sourceRows);
    // Mutate the OLD receipt, not merely the newest request matching the head.
    Object.assign((changedSide==='source'?sourceRows:targetRows)[table][0],patch);
    assert.equal(sourceRows[table].length,targetRows[table].length);
    const {result}=await comparePrivateReviews(sourceRows,targetRows);
    assert.equal(result.dataMatches,false,`${changedSide} ${table} ${Object.keys(patch)[0]}`);
    assert.deepEqual(result.differences,[table]);
  }
});

test('022 missing past receipt is detected even while the latest note and newest receipt remain exact',async()=>{
  for(const missingSide of ['source','target']){
    const sourceRows=privateReviewRows(),targetRows=structuredClone(sourceRows);
    (missingSide==='source'?sourceRows:targetRows).cb_message_review_requests.shift();
    assert.deepEqual(sourceRows.cb_message_reviews,targetRows.cb_message_reviews);
    assert.deepEqual(sourceRows.cb_message_review_requests.at(-1),targetRows.cb_message_review_requests.at(-1));
    const {result}=await comparePrivateReviews(sourceRows,targetRows);
    assert.equal(result.dataMatches,false);assert.deepEqual(result.differences,['cb_message_review_requests']);
  }
});
test('wrong identity, indirect role, non-owned or row-filtered tables fail closed',async()=>{
  for(const side of ['source','target'])for(const identity of [{oid:'999'},{owner_oid:'99'},{role_oid:'99'},{current_database:'wrong'},{direct_role:false}]){
    const request=input(),f=fixture(request,{identitySide:side,identity});
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),code('RECOVERY_STATE_TARGET_MISMATCH'));
  }
  for(const table of [{relkind:'v'},{relpersistence:'u'},{relrowsecurity:true},{relforcerowsecurity:true},{owner_oid:'99'}]){
    const request=input(),f=fixture(request,{tableSide:'target',table});
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),code('RECOVERY_STATE_SCHEMA_MISMATCH'));
  }
});
test('missing/stale quarantine, quarantined source and different cluster never report a match',async()=>{
  for(const [changes,expected]of [[{noGate:true},'RECOVERY_STATE_QUARANTINE_MISMATCH'],
    [{gate:{bundle_id:randomUUID()}},'RECOVERY_STATE_QUARANTINE_MISMATCH'],[{gate:{source_oid:7}},'RECOVERY_STATE_QUARANTINE_MISMATCH'],
    [{sourceGate:true},'RECOVERY_STATE_SOURCE_QUARANTINED'],[{otherCluster:true},'RECOVERY_STATE_CLUSTER_MISMATCH']]){
    const request=input(),f=fixture(request,changes);
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),code(expected));
    assert.equal(f.queries.some(q=>q.sql.startsWith('DECLARE')),false);
  }
});
test('schema/migration differences and open target auth cannot be normalized away',async()=>{
  for(const [changes,expected]of [[{migrationSide:'source'},'RECOVERY_STATE_SCHEMA_MISMATCH'],
    [{shapeSide:'target'},'RECOVERY_STATE_SCHEMA_MISMATCH'],[{authOpen:true},'RECOVERY_STATE_AUTH_OPEN'],
    [{resetOpen:true},'RECOVERY_STATE_AUTH_OPEN']]){
    const request=input(),f=fixture(request,changes);
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),code(expected));
  }
});

test('migration comparison rejects missing added renamed and checksum-changed entries on either side before row reads',async()=>{
  assert.equal(migrations.at(-1).name,'023-care-recipient-links.sql');
  const renamed=structuredClone(migrations);renamed.at(-1).name='022-unreviewed-replacement.sql';
  const changedChecksum=structuredClone(migrations);
  changedChecksum.at(-1).checksum=(changedChecksum.at(-1).checksum[0]==='a'?'b':'a')+changedChecksum.at(-1).checksum.slice(1);
  const variants=[migrations.slice(0,-1),[...migrations,{name:'023-unreviewed.sql',checksum:'c'.repeat(64)}],renamed,changedChecksum];
  assert.equal(renamed.length,migrations.length);assert.equal(changedChecksum.length,migrations.length);
  for(const side of ['source','target'])for(const rows of variants){
    const before=structuredClone(rows),request=input(),f=fixture(request,{migrations:{[side]:rows}});
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),error=>
      code('RECOVERY_STATE_SCHEMA_MISMATCH')(error)&&error.component==='migrations');
    assert.deepEqual(rows,before);assert.equal(f.queries.some(q=>q.sql.startsWith('DECLARE')),false);
    assert.equal(f.queries.some(q=>/^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|REVOKE)/.test(q.sql)),false);
  }
});
test('only deliberate quarantine restrictions are omitted; password and relationship state remain exact',async()=>{
  const request=input(),f=fixture(request);await compareRestoredDatabaseState(f.source,f.target,request);
  const declarations=f.queries.filter(q=>q.sql.startsWith('DECLARE'));
  for(const table of DATABASE_TABLES.filter(name=>name!=='cb_recovery_quarantine')){
    const sql=declarations.find(q=>q.sql.includes(`public."${table}"`)).sql;
    const omission=({cb_users:'active',cb_auth_sessions:'revoked_at',cb_auth_invitations:'revoked_at',cb_auth_password_resets:'revoked_at'})[table];
    assert.equal(sql.includes(' - ARRAY['),Boolean(omission));if(omission)assert.ok(sql.includes(`'${omission}'`));
  }
  const a=f.queries.find(q=>q.side==='source'&&q.sql.includes('pg_try_advisory'));
  const b=f.queries.find(q=>q.side==='target'&&q.sql.includes('FROM pg_catalog.pg_locks'));
  const bits=BigInt.asUintN(64,BigInt(a.params[0]));
  assert.deepEqual(b.params,[request.sourceReceipt.oid,321,Number(bits>>32n),Number(bits&0xffffffffn)]);
  assert.equal(f.queries.some(q=>q.side==='target'&&q.sql.includes('pg_try_advisory')),false);
});
test('password reset revocation may become stricter but identity hash lifetime and consumption must remain exact',async()=>{
  const original={token_hash:'a'.repeat(64),user_id:'synthetic-reset-user',created_at:'2026-10-08T00:00:00.000Z',
    expires_at:'2026-10-08T00:10:00.000Z',consumed_at:null,revoked_at:null};
  const restored={...original,revoked_at:'2026-10-08T00:05:00.000Z'};
  const compare=async(row,extra={})=>{
    const request=input(),f=fixture(request,{rows:{source:{cb_auth_password_resets:[original]},
      target:{cb_auth_password_resets:[row]}},...extra});
    return {result:await compareRestoredDatabaseState(f.source,f.target,request),queries:f.queries};
  };
  const matching=await compare(restored);
  assert.equal(matching.result.dataMatches,true);
  assert.ok(matching.queries.some(q=>q.side==='target'&&q.sql.includes('cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL')));
  for(const change of [{token_hash:'b'.repeat(64)},{user_id:'other-synthetic-user'},
    {created_at:'2026-10-08T00:01:00.000Z'},{expires_at:'2026-10-08T00:11:00.000Z'},
    {consumed_at:'2026-10-08T00:02:00.000Z'}]){
    const {result}=await compare({...restored,...change,...(change.consumed_at?{revoked_at:null}:{})});
    assert.equal(result.dataMatches,false);assert.deepEqual(result.differences,['cb_auth_password_resets']);
    assert.equal(JSON.stringify(result).includes(original.token_hash),false);
  }
  await assert.rejects(compare(original,{resetOpen:true}),code('RECOVERY_STATE_AUTH_OPEN'));
});
test('middle query failure and either unknown transaction outcome expose no partial report or driver content',async()=>{
  for(const changes of [{failSide:'source'},{failSide:'target'},{lostCommit:'source'},{lostCommit:'target'}]){
    const request=input(),f=fixture(request,changes);
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,request),code('RECOVERY_STATE_UNAVAILABLE'));
  }
});
test('entry approval is captured before async file/connection waits and names are never interpolated',async()=>{
  const request=input();request.targetReceipt.name="synthetic';--";request.confirmTarget=request.targetReceipt.name;
  const original=structuredClone(request),f=fixture(request,{onQuery:()=>{request.targetReceipt.name='unapproved';request.sourceReceipt.oid++;request.bundleId=randomUUID();}});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);assert.equal(result.bundleId,original.bundleId);
  assert.equal(f.queries.some(q=>q.sql.includes(original.targetReceipt.name)),false);
  assert.ok(f.queries.find(q=>q.sql.includes('FROM pg_catalog.pg_database')).params.includes(original.targetReceipt.name));
});

async function mediaFixture(t){
  const root=await mkdtemp(join(tmpdir(),'carebridge-state-media-')),ownedFiles=[];
  const mediaRoots={};
  for(const side of ['source','target']){
    const path=join(root,side);await mkdir(path,{mode:0o700});const info=await lstat(path,{bigint:true});
    mediaRoots[side]={path,dev:String(info.dev),ino:String(info.ino)};
  }
  t.after(async()=>{
    for(const path of ownedFiles)await unlink(path);
    // Only this fixture's known files and three empty, uniquely created dirs.
    for(const side of ['source','target'])await rmdir(join(root,side));await rmdir(root);
  });
  return {mediaRoots,async fence(side){
    const path=join(mediaRoots[side].path,`${randomUUID()}.blocked`);
    await writeFile(path,Buffer.alloc(0),{flag:'wx',mode:0o600});ownedFiles.push(path);return path;
  }};
}

test('optional media approval is exact and rejected before a database connection',async()=>{
  const request=input(),f=fixture(request);
  for(const mediaRoots of [undefined,null,{}, {source:{},target:{}},
    {source:{path:'relative',dev:'1',ino:'1'},target:{path:'relative2',dev:'1',ino:'2'}}]){
    await assert.rejects(compareRestoredDatabaseState(f.source,f.target,{...request,mediaRoots}),code('RECOVERY_STATE_MEDIA_INVALID_INPUT'));
  }
  assert.equal(f.queries.length,0);
});

test('combined empty media comparison preserves closed auth and both database SHARE locks',async t=>{
  const media=await mediaFixture(t),request={...input(),mediaRoots:media.mediaRoots},active=new Set();
  const f=fixture(request,{onTransaction:(side,started)=>started?active.add(side):active.delete(side),onQuery:(_side,sql)=>{
    if(/FROM public\.cb_media_(objects|uploads|preparations)/.test(sql))assert.deepEqual([...active].sort(),['source','target']);
  }});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.equal(active.size,0);
  assert.equal(result.dataMatches,true);assert.equal(result.authClosed,true);
  assert.equal(result.externalFilesChecked,true);assert.equal(result.externalFilesMatch,true);
  assert.deepEqual(result.externalFileDifferences,[]);assert.equal(result.filesystemWriterQuiescenceVerified,false);
  assert.equal(result.serviceReleaseAllowed,false);
  const fileQueries=f.queries.filter(q=>/FROM public\.cb_media_objects/.test(q.sql));
  assert.equal(fileQueries.length,2);
  for(const fileQuery of fileQueries)for(const side of ['source','target'])
    assert.ok(f.queries.indexOf(fileQuery)>f.queries.findIndex(q=>q.side===side&&q.sql.startsWith('LOCK')));
  assert.equal(f.queries.some(q=>/^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|GRANT|REVOKE)/.test(q.sql)),false);
  for(const value of [request.mediaRoots.source.path,request.mediaRoots.target.path])assert.equal(JSON.stringify(result).includes(value),false);
});

test('latest external cancellation fence makes the combined report differ even when DB rows match',async t=>{
  const media=await mediaFixture(t);await media.fence('source');
  const request={...input(),mediaRoots:media.mediaRoots},f=fixture(request);
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.equal(result.dataMatches,true);assert.equal(result.externalFilesMatch,false);
  assert.ok(result.externalFileDifferences.includes('deletion-fence'));assert.equal(result.serviceReleaseAllowed,false);
});

test('media match cannot suppress a database difference or an uncertain transaction outcome',async t=>{
  const media=await mediaFixture(t),request={...input(),mediaRoots:media.mediaRoots};
  const f=fixture(request,{rows:{source:{cb_message_hides:['new']},target:{cb_message_hides:[]}}});
  const result=await compareRestoredDatabaseState(f.source,f.target,request);
  assert.equal(result.dataMatches,false);assert.deepEqual(result.differences,['cb_message_hides']);
  assert.equal(result.externalFilesMatch,true);assert.equal(result.serviceReleaseAllowed,false);
  for(const side of ['source','target']){
    const lost=fixture(request,{lostCommit:side});
    await assert.rejects(compareRestoredDatabaseState(lost.source,lost.target,request),code('RECOVERY_STATE_UNAVAILABLE'));
  }
});

test('media paths and identities are captured before the first await and filesystem failures reveal no paths',async t=>{
  const media=await mediaFixture(t),request={...input(),mediaRoots:structuredClone(media.mediaRoots)};
  const f=fixture(request,{onQuery:()=>{request.mediaRoots.source.path='UNAPPROVED-PRIVATE-PATH';request.mediaRoots.target.ino='0';}});
  assert.equal((await compareRestoredDatabaseState(f.source,f.target,request)).externalFilesMatch,true);
  const bad={...input(),mediaRoots:structuredClone(media.mediaRoots)};bad.mediaRoots.target.ino=String(BigInt(bad.mediaRoots.target.ino)+1n);
  const active=new Set(),refused=fixture(bad,{onTransaction:(side,started)=>started?active.add(side):active.delete(side)});
  await assert.rejects(compareRestoredDatabaseState(refused.source,refused.target,bad),code('RECOVERY_STATE_MEDIA_UNAVAILABLE'));
  assert.equal(active.size,0);
});
