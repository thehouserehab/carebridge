// Fresh memory-only PostgreSQL, actual reviewed SQL grants and queue claims.
// The byte store is an explicit in-memory test double; no scanner/decoder,
// filesystem durability, native service admission, E data or listener runs.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Conversations } from '../conversations.mjs';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { participantVisibleSql } from '../conversation-visibility.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { syntheticPng } from '../image-metadata-test-fixtures.mjs';
import { DATABASE_PRIVILEGE_POLICY_VERSION, DATABASE_TABLES, DATABASE_FUNCTIONS, DATABASE_SEQUENCES,
  RUNTIME_HELPERS, TABLE_PRIVILEGES, expectedTablePrivileges, expectedColumnPrivileges,
  expectedFunctionExecution } from '../database-privilege-policy.mjs';

const centerId='synthetic-worker-recipient-center',roomId='synthetic-worker-recipient-room';
const actor=kind=>({centerId,userId:`synthetic-worker-${kind}`});
const guardian=actor('guardian'),therapist=actor('therapist'),recipient=actor('recipient'),manager=actor('manager');
const roleNames={worker:'synthetic_recipient_worker',runtime:'synthetic_recipient_app'};
const bytes=syntheticPng();
const digest=value=>createHash('sha256').update(value).digest('hex');
const file={name:'synthetic-worker.png',type:'image/png',size:bytes.length,sha256:digest(bytes)};
let db,worker,runtime,uploads,queue,links,store;

function memoryStore(){
  const objects=new Map(),calls={writes:0,opens:0,removes:0};
  return {objects,calls,async write(key,stream,manifest){
    calls.writes++;assert.ok(!objects.has(key));
    const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
    const value=Buffer.concat(chunks);
    assert.equal(value.length,manifest.size);assert.equal(digest(value),manifest.sha256);
    objects.set(key,value);return {size:value.length};
  },async openVerified(){calls.opens++;throw new Error('Queue claim must not read or approve bytes.');},
  async remove(key){calls.removes++;objects.get(key)?.fill(0);objects.delete(key);},
  clear(){for(const value of objects.values())value.fill(0);objects.clear();}};
}

function asRole(kind){
  return {transaction:work=>db.transaction(async tx=>{
    await tx.exec(`SET LOCAL ROLE ${roleNames[kind]}`);
    assert.equal((await tx.query('SELECT current_user AS role')).rows[0].role,roleNames[kind]);
    return work(tx);
  })};
}

before(async()=>{
  assert.equal(DATABASE_PRIVILEGE_POLICY_VERSION,7);
  db=await PGlite.create();await migrate(db);
  await db.exec(`CREATE ROLE ${roleNames.worker} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE ${roleNames.runtime} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`);
  for(const kind of ['worker','runtime']){
    const role=roleNames[kind];await db.exec(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for(const table of DATABASE_TABLES){
      const privileges=expectedTablePrivileges(kind,table);
      if(privileges.length)await db.exec(`GRANT ${privileges.join(',')} ON TABLE public.${table} TO ${role}`);
      for(const permission of ['SELECT','INSERT','UPDATE','REFERENCES']){
        const columns=expectedColumnPrivileges(kind,table,permission);
        if(columns.length)await db.exec(`GRANT ${permission} (${columns.join(',')}) ON TABLE public.${table} TO ${role}`);
      }
    }
    // Policy v7 grants NO sequence rights to workers.
    if(kind==='runtime')for(const sequence of DATABASE_SEQUENCES)
      await db.exec(`GRANT USAGE ON SEQUENCE public.${sequence} TO ${role}`);
    for(const [name,args]of Object.entries(RUNTIME_HELPERS))if(expectedFunctionExecution(kind,name))
      await db.exec(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO ${role}`);
  }
  worker=asRole('worker');runtime=asRole('runtime');
});
after(async()=>{store?.clear();bytes.fill(0);await db?.close();});
beforeEach(async()=>{
  store?.clear();store=memoryStore();
  await db.exec('TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE');
  await db.query('INSERT INTO cb_centers(id) VALUES ($1)',[centerId]);
  for(const [who,role]of [[guardian,'guardian'],[therapist,'therapist'],[recipient,'care_recipient'],[manager,'center']]){
    await db.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[who.userId]);
    await db.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)',[centerId,who.userId,role]);
  }
  // Account presence only, deliberately non-authenticatable sentinel.
  await db.query(`INSERT INTO cb_auth_accounts(user_id,email,password_hash)
    VALUES ($1,'recipient@synthetic-worker.invalid','scrypt$'||repeat('x',100))`,[recipient.userId]);
  await db.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[centerId,'synthetic-worker-child']);
  await db.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[centerId,roomId,'synthetic-worker-child']);
  for(const [who,role]of [[guardian,'guardian'],[therapist,'therapist']])
    await db.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,$4,true,1)`,[centerId,roomId,who.userId,role]);
  await configureSyntheticMediaPolicy(db,centerId);
  uploads=new MediaUploads(runtime,store);queue=new MediaUploads(worker,store);links=new CareRecipientLinks(runtime);
  await links.connect(manager,{conversationId:roomId,userId:recipient.userId,
    expectedVersion:(await links.get(manager,{conversationId:roomId})).version,clientId:randomUUID()});
});

async function inRoom(who,work=(_tx,scope)=>scope,database=worker){
  const chat=new Conversations(database);
  return database.transaction(tx=>chat.inRoomTransaction(tx,who,roomId,work));
}
async function received(who){
  const pending=await uploads.reserve(who,{conversationId:roomId,clientId:randomUUID(),file});
  const result=await uploads.receive(who,{conversationId:roomId,uploadId:pending.id,expectedVersion:pending.version},
    Readable.from([bytes],{objectMode:false}));
  assert.equal(result.state,'quarantined');
  assert.deepEqual((await db.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[result.id])).rows,
    [{state:'queued',attempts:0}]);
  return result;
}
async function queueRows(uploadId){
  return (await db.query(`SELECT q.state,q.attempts,u.state AS upload_state,u.version,u.candidate_key
    FROM cb_media_work_queue q JOIN cb_media_uploads u ON u.id=q.upload_id WHERE q.upload_id=$1`,[uploadId])).rows;
}

test('actual worker table column function and sequence grants match policy v7 without auth or link access',async()=>{
  for(const table of DATABASE_TABLES){
    for(const permission of TABLE_PRIVILEGES){
      const actual=(await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[roleNames.worker,`public.${table}`,permission])).rows[0].allowed;
      assert.equal(actual,expectedTablePrivileges('worker',table).includes(permission),`${table} ${permission}`);
    }
    const columns=(await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table])).rows;
    for(const {column_name:column}of columns)for(const permission of ['SELECT','INSERT','UPDATE','REFERENCES']){
      const actual=(await db.query('SELECT has_column_privilege($1,$2,$3,$4) AS allowed',[roleNames.worker,`public.${table}`,column,permission])).rows[0].allowed;
      const expected=expectedTablePrivileges('worker',table).includes(permission)||expectedColumnPrivileges('worker',table,permission).includes(column);
      assert.equal(actual,expected,`${table}.${column} ${permission}`);
    }
  }
  for(const name of DATABASE_FUNCTIONS){
    const actual=(await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',
      [roleNames.worker,`public.${name}(${RUNTIME_HELPERS[name]??''})`])).rows[0].allowed;
    assert.equal(actual,expectedFunctionExecution('worker',name),name);
  }
  for(const name of DATABASE_SEQUENCES)for(const permission of ['SELECT','USAGE','UPDATE'])
    assert.equal((await db.query('SELECT has_sequence_privilege($1,$2,$3) AS allowed',[roleNames.worker,`public.${name}`,permission])).rows[0].allowed,false);
  for(const table of ['cb_auth_accounts','cb_auth_sessions','cb_auth_invitations','cb_care_recipient_links','cb_primary_communicators'])
    await assert.rejects(worker.transaction(tx=>tx.query(`SELECT * FROM public.${table}`)),{code:'42501'});
  for(const sql of [
    'UPDATE cb_participants SET role=role WHERE false',
    'UPDATE cb_participants SET active=active WHERE false',
    'UPDATE cb_memberships SET role=role WHERE false',
    'UPDATE cb_users SET communication_generation=communication_generation WHERE false',
    'UPDATE cb_memberships SET communication_generation=communication_generation WHERE false',
    'UPDATE cb_participants SET communication_generation=communication_generation WHERE false',
    "SELECT nextval('cb_audit_events_id_seq')",
    'SELECT cb_communication_qualification_generation()',
  ])await assert.rejects(worker.transaction(tx=>tx.query(sql)),{code:'42501'});
});

test('the prior mixed-role SQL predicate requires private-table privileges even for a guardian row',async()=>{
  // Negative control reproduces the old predicate, not a replacement service
  // implementation. PostgreSQL checks relation rights before OR evaluation.
  await assert.rejects(worker.transaction(tx=>tx.query(`SELECT p.user_id FROM cb_participants p
    WHERE p.center_id=$1 AND p.conversation_id=$2 AND p.user_id=$3 AND ${participantVisibleSql('p')}`,
    [centerId,roomId,guardian.userId])),{code:'42501'});
});

for(const [who,role]of [[guardian,'guardian'],[therapist,'therapist']]){
  test(`${role} room transaction and real quarantined upload queue claim work under restricted worker grants`,async()=>{
    // Caller role fields never determine the locked database role.
    const scope=await inRoom({...who,role:'care_recipient'});
    assert.equal(scope.role,role);assert.equal(scope.userId,who.userId);assert.equal(scope.roomId,roomId);
    const upload=await received(who),claim=await queue.claimNextInspection();
    assert.deepEqual(claim.actor,who);assert.equal(claim.conversationId,roomId);assert.equal(claim.claimed.id,upload.id);
    assert.equal(claim.claimed.state,'inspecting');assert.equal(claim.claimed.version,upload.version+1);
    assert.match(claim.claimed.lease_id,/^[a-f0-9-]{36}$/);assert.match(claim.claimed.candidate_key,/^[a-f0-9-]{36}$/);
    assert.deepEqual((await db.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[upload.id])).rows,[{state:'running',attempts:1}]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_objects WHERE upload_id=$1',[upload.id])).rows[0].n,2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_preparations WHERE upload_id=$1',[upload.id])).rows[0].n,0);
    assert.deepEqual([...store.objects.values()],[bytes]);assert.deepEqual(store.calls,{writes:1,opens:0,removes:0});
    for(const table of ['cb_auth_accounts','cb_care_recipient_links'])
      await assert.rejects(worker.transaction(tx=>tx.query(`SELECT * FROM ${table}`)),{code:'42501'});
  });
}

for(const [label,sql,values]of [
  ['inactive account','UPDATE cb_users SET active=false WHERE id=$1',[guardian.userId]],
  ['inactive membership','UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2',[centerId,guardian.userId]],
  ['disconnected participant','UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3',[centerId,roomId,guardian.userId]],
])test(`${label} refuses the room callback and cannot consume queued inspection work`,async()=>{
  const upload=await received(guardian),beforeRows=await queueRows(upload.id);
  await db.query(sql,values);let callbacks=0;
  await assert.rejects(inRoom({...guardian,role:'therapist'},()=>{callbacks++;}),{code:'NOT_FOUND'});
  assert.equal(callbacks,0);assert.equal(await queue.claimNextInspection(),null);
  assert.deepEqual(await queueRows(upload.id),beforeRows);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_objects WHERE upload_id=$1',[upload.id])).rows[0].n,1);
});

test('forged caller roles cannot grant center or recipient clinical upload access',async()=>{
  let callbacks=0;
  await assert.rejects(inRoom({...manager,role:'guardian'},()=>{callbacks++;}),{code:'NOT_FOUND'});
  assert.equal(callbacks,0);
  const scope=await inRoom({...recipient,role:'therapist'},undefined,runtime);
  assert.equal(scope.role,'care_recipient');
  const message=await new Conversations(runtime).sendText({...recipient,role:'guardian'},
    {conversationId:roomId,clientId:randomUUID(),body:'Synthetic text-only recipient message'});
  assert.equal(message.body,'Synthetic text-only recipient message');
  for(const who of [recipient,manager])await assert.rejects(uploads.reserve({...who,role:'guardian'},
    {conversationId:roomId,clientId:randomUUID(),file}),{code:'NOT_FOUND'});
  // A worker cannot evaluate recipient auth binding and must not invoke work.
  await assert.rejects(inRoom({...recipient,role:'guardian'},()=>{callbacks++;}),{code:'42501'});
  assert.equal(callbacks,0);assert.equal(await queue.claimNextInspection(),null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n,0);
  assert.deepEqual(store.calls,{writes:0,opens:0,removes:0});
});

test('recipient account removal or explicit disconnect still fails closed before a runtime callback',async()=>{
  await db.query('DELETE FROM cb_auth_accounts WHERE user_id=$1',[recipient.userId]);let callbacks=0;
  await assert.rejects(inRoom(recipient,()=>{callbacks++;},runtime),{code:'NOT_FOUND'});
  assert.equal(callbacks,0);
  const state=await links.get(manager,{conversationId:roomId});
  await links.disconnect(manager,{conversationId:roomId,userId:recipient.userId,expectedVersion:state.version,clientId:randomUUID()});
  await assert.rejects(inRoom({...recipient,role:'guardian'},()=>{callbacks++;},runtime),{code:'NOT_FOUND'});
  assert.equal(callbacks,0);
});
