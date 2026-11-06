import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { PrimaryCommunicators } from '../primary-communicators.mjs';
import { Relationships } from '../relationships.mjs';
import { Conversations } from '../conversations.mjs';
import { migrate } from '../migrate.mjs';
import { RepositoryError } from '../errors.mjs';

// New, memory-only synthetic schema. Never attach to a persisted or E: DB.
let db,links,primary,relationships,chat;
const manager={ centerId:'center-a',userId:'manager-a' },guardian={ centerId:'center-a',userId:'guardian-a' };
const therapist={ centerId:'center-a',userId:'therapist-a' },recipient={ centerId:'center-a',userId:'recipient-a' };
const foreign={ centerId:'center-b',userId:'manager-b' },unlinked={ centerId:'center-a',userId:'recipient-new' };
const room={ conversationId:'room-a' };
const code=value => error => error instanceof RepositoryError && error.code===value;
const sqlCode=value => error => error.code===value;
const get=() => links.get(manager,room);
const select=(userId,expectedRevision=0,clientId='primary-select-0001') => ({ ...room,userId,expectedRevision,clientId });
async function connect(extra={}) {
  return links.connect(manager,{ ...room,userId:recipient.userId,expectedVersion:(await get()).version,clientId:'recipient-connect-0001',...extra });
}
async function disconnect(extra={}) {
  return links.disconnect(manager,{ ...room,userId:recipient.userId,expectedVersion:(await get()).version,clientId:'recipient-disconnect-0001',...extra });
}
async function send(clientId='synthetic-message-0001') {
  return chat.sendText(guardian,{ ...room,clientId,body:'SYNTHETIC existing guardian message' });
}
async function snapshot() {
  const result={};
  for (const name of ['cb_users','cb_auth_accounts','cb_memberships','cb_participants','cb_care_recipient_links','cb_messages','cb_read_states','cb_record_recipients'])
    result[name]=(await db.query(`SELECT * FROM ${name} ORDER BY 1,2`)).rows;
  result.relationshipsVersion=(await get()).version;
  return result;
}
before(async () => { db=await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-b',true),('guardian-a',true),('therapist-a',true),
      ('recipient-a',true),('recipient-new',true),('recipient-unprovisioned',true),('recipient-disabled',false),('recipient-b',true),('guardian-new',true);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ('center-a','manager-a','center',true),('center-b','manager-b','center',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-new','guardian',true),('center-a','therapist-a','therapist',true),
      ('center-a','recipient-a','care_recipient',true),('center-a','recipient-new','care_recipient',true),
      ('center-a','recipient-unprovisioned','care_recipient',true),('center-a','recipient-disabled','care_recipient',true),('center-b','recipient-b','care_recipient',true);
    INSERT INTO cb_auth_accounts(user_id,email,password_hash)
      SELECT id,id||'@synthetic.test','scrypt$'||repeat('x',100) FROM cb_users WHERE id LIKE 'recipient-%' AND id<>'recipient-unprovisioned';
    INSERT INTO cb_children(center_id,id) VALUES('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1);`);
  links=new CareRecipientLinks(db); primary=new PrimaryCommunicators(db); relationships=new Relationships(db); chat=new Conversations(db);
});

test('a separate provisioned recipient is connected from now without changing old accounts or history',async () => {
  const message=await send(),before=await snapshot(),version=(await get()).version;
  assert.deepEqual(await get(),{ ...room,childId:'child-a',userId:null,active:false,version });
  const result=await connect(); assert.equal(result.changed,true); assert.equal(result.appliedVersion,version+1);
  assert.deepEqual(await get(),{ ...room,childId:'child-a',userId:recipient.userId,active:true,version:version+1 });
  const after=await snapshot();
  for (const table of ['cb_users','cb_auth_accounts','cb_memberships','cb_messages','cb_record_recipients']) assert.deepEqual(after[table],before[table]);
  for (const old of before.cb_participants) assert.deepEqual(after.cb_participants.find(row=>row.user_id===old.user_id),old);
  const added=after.cb_participants.find(row=>row.user_id===recipient.userId); assert.equal(Number(added.first_sequence),message.sequence+1);
  assert.equal(after.cb_care_recipient_links[0].child_id,'child-a');
  assert.equal((await chat.get(guardian,{ ...room,messageId:message.id })).id,message.id);
});

test('only a currently active center manager can inspect, connect or disconnect; caller role is not authority',async () => {
  const input={ ...room,userId:recipient.userId,expectedVersion:(await get()).version,clientId:'recipient-forged-0001' };
  for (const actor of [guardian,therapist,recipient,foreign,{ ...foreign,centerId:'center-a' }]) {
    await assert.rejects(links.get({ ...actor,role:'center' },room),code('NOT_FOUND'));
    await assert.rejects(links.connect({ ...actor,role:'center' },input),code('NOT_FOUND'));
    await assert.rejects(links.disconnect({ ...actor,role:'center' },input),code('NOT_FOUND'));
  }
  for (const table of ['cb_users','cb_memberships']) {
    const column=table==='cb_users'?'id':'user_id';
    await db.query(`UPDATE ${table} SET active=false WHERE ${column}=$1`,[manager.userId]);
    await assert.rejects(links.connect(manager,input),code('NOT_FOUND'));
    await db.query(`UPDATE ${table} SET active=true WHERE ${column}=$1`,[manager.userId]);
  }
  assert.equal((await get()).userId,null);
});

test('wrong role, unprovisioned, inactive, foreign and missing accounts have the same unavailable boundary',async () => {
  for (const userId of ['guardian-a','therapist-a','manager-a','recipient-unprovisioned','recipient-disabled','recipient-b','absent'])
    await assert.rejects(connect({ userId,clientId:`recipient-unavailable-${userId}` }),code('PARTICIPANT_UNAVAILABLE'));
  await db.query(`UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='recipient-a'`);
  await assert.rejects(connect(),code('PARTICIPANT_UNAVAILABLE'));
  assert.equal((await db.query('SELECT * FROM cb_care_recipient_links')).rows.length,0);
});

test('recipient requests reject history, age, role, target omission and malformed version fields',async () => {
  const input={ ...room,userId:recipient.userId,expectedVersion:(await get()).version,clientId:'recipient-input-0001' };
  for (const extra of [{ history:'all' },{ age:18 },{ role:'center' },{ expectedVersion:-1 },{ clientId:'short' },{ userId:null }])
    assert.throws(()=>links.connect(manager,{ ...input,...extra }),code('INVALID_INPUT'));
  const { userId,...missing }=input; assert.throws(()=>links.disconnect(manager,missing),code('INVALID_INPUT'));
});

test('stable identity prevents moving the same account to another child or replacing a disconnected child identity',async () => {
  await connect();
  const other={ conversationId:'room-other',userId:recipient.userId,expectedVersion:0,clientId:'recipient-other-child-0001' };
  await assert.rejects(links.connect(manager,other),code('PARTICIPANT_UNAVAILABLE'));
  await assert.rejects(connect({ userId:'recipient-new',clientId:'recipient-replace-0001' }),code('PARTICIPANT_UNAVAILABLE'));
  await disconnect();
  await assert.rejects(connect({ userId:'recipient-new',clientId:'recipient-replace-0002' }),code('PARTICIPANT_UNAVAILABLE'));
  await assert.rejects(links.connect(manager,other),code('PARTICIPANT_UNAVAILABLE'));
  assert.equal((await get()).userId,recipient.userId); assert.equal((await get()).active,false);
});

test('disconnect preserves identity and messages; explicit reconnect starts after new messages and resets only its read state',async () => {
  await connect(); const first=await send();
  await db.query(`INSERT INTO cb_read_states(center_id,conversation_id,user_id,sequence) VALUES('center-a','room-a','recipient-a',$1),('center-a','room-a','guardian-a',$1)`,[first.sequence]);
  await disconnect(); const last=await send('synthetic-message-after-disconnect');
  await connect({ clientId:'recipient-reconnect-0001' });
  const { rows }=await db.query(`SELECT first_sequence FROM cb_participants WHERE user_id='recipient-a'`);
  assert.equal(Number(rows[0].first_sequence),last.sequence+1);
  assert.deepEqual((await db.query('SELECT user_id FROM cb_read_states')).rows,[{ user_id:'guardian-a' }]);
  assert.equal((await db.query('SELECT * FROM cb_care_recipient_links')).rows.length,1);
  assert.equal((await db.query('SELECT * FROM cb_messages')).rows.length,2);
});

test('relationship receipts are idempotent, stale-safe and old connect retries never reactivate a disconnected account',async () => {
  const initial={ ...room,userId:recipient.userId,expectedVersion:(await get()).version,clientId:'recipient-replay-0001' };
  const first=await links.connect(manager,initial),stable=(await get()).version;
  assert.deepEqual(await links.connect(manager,initial),{ ...first,replayed:true });
  await assert.rejects(links.connect(manager,{ ...initial,clientId:'recipient-stale-0001' }),code('RELATIONSHIP_CONFLICT'));
  await assert.rejects(links.disconnect(manager,initial),code('IDEMPOTENCY_CONFLICT'));
  const noOp=await connect({ clientId:'recipient-no-op-0001' }); assert.equal(noOp.changed,false); assert.equal(noOp.appliedVersion,stable);
  await disconnect(); await links.connect(manager,initial); assert.equal((await get()).active,false);
});

test('legacy therapist/guardian replacement preserves care-recipient identity, participation and history',async () => {
  await connect(); const before=(await snapshot()).cb_participants.find(row=>row.user_id===recipient.userId);
  const result=await relationships.replace(manager,{ ...room,clientId:'legacy-replace-0001',expectedVersion:(await get()).version,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[],historyConfirmed:true,pastHistoryConfirmed:false });
  assert.equal(result.changed,true);
  assert.deepEqual((await snapshot()).cb_participants.find(row=>row.user_id===recipient.userId),before);
  assert.equal((await get()).active,true);
  assert.equal((await relationships.get(manager,room)).participants.filter(row=>row.active&&row.role==='care_recipient').length,1);
});

test('failed recipient audit rolls back participant, fixed identity, version and receipt before a successful retry',async () => {
  const before=await snapshot();
  await db.exec(`CREATE FUNCTION cb_test_recipient_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END; $$;
    CREATE TRIGGER cb_test_recipient_failure BEFORE INSERT ON cb_relationship_changes FOR EACH ROW EXECUTE FUNCTION cb_test_recipient_failure()`);
  try { await assert.rejects(connect(),/synthetic receipt failure/); }
  finally { await db.exec('DROP TRIGGER cb_test_recipient_failure ON cb_relationship_changes; DROP FUNCTION cb_test_recipient_failure()'); }
  assert.deepEqual(await snapshot(),before); assert.equal((await db.query('SELECT * FROM cb_relationship_requests')).rows.length,0);
  assert.equal((await connect()).changed,true);
});

test('schema requires a stable link, prevents identity mutation and denies history expansion or deletion',async () => {
  await assert.rejects(db.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
    VALUES('center-a','room-a','recipient-a','care_recipient',true,1)`),sqlCode('23514'));
  assert.equal((await db.query(`SELECT * FROM cb_participants WHERE role='care_recipient'`)).rows.length,0);
  await send(); await connect(); await disconnect();
  for (const sql of [
    `UPDATE cb_participants SET first_sequence=1 WHERE user_id='recipient-a'`,
    `UPDATE cb_participants SET conversation_id='room-other' WHERE user_id='recipient-a'`,
    `UPDATE cb_participants SET role='guardian' WHERE user_id='recipient-a'`,
    `DELETE FROM cb_participants WHERE user_id='recipient-a'`,
    `UPDATE cb_care_recipient_links SET child_id='child-other'`,
    `DELETE FROM cb_care_recipient_links`,
  ]) await assert.rejects(db.exec(sql),sqlCode('23514'));
  await assert.rejects(db.exec(`INSERT INTO cb_memberships VALUES('center-a','recipient-a','guardian',true)`),sqlCode('23505'));
});

test('manager can disconnect an already suspended recipient but cannot reactivate it',async () => {
  await connect(); await db.exec(`UPDATE cb_users SET active=false WHERE id='recipient-a'`);
  assert.equal((await get()).active,false);
  assert.equal((await disconnect()).changed,true);
  await assert.rejects(connect({ clientId:'recipient-suspended-reconnect' }),code('PARTICIPANT_UNAVAILABLE'));
});

test('primary communicator metadata is readable only by manager or current linked clinical actors',async () => {
  await connect();
  for (const actor of [manager,guardian,therapist,recipient]) assert.deepEqual(await primary.get(actor,room),{ ...room,userId:null,revision:0 });
  for (const actor of [unlinked,foreign,{ ...foreign,centerId:'center-a' }])
    await assert.rejects(primary.get({ ...actor,role:'center' },room),code('NOT_FOUND'));
  for (const actor of [guardian,therapist,recipient]) await assert.rejects(primary.save({ ...actor,role:'center' },select(guardian.userId)),code('NOT_FOUND'));
  await disconnect(); await assert.rejects(primary.get(recipient,room),code('NOT_FOUND'));
});

test('switching primary communicator changes only metadata, never roles, account state, history or recipients',async () => {
  await connect(); await send(); const before=await snapshot();
  const selected=await primary.save(manager,select(guardian.userId)); assert.equal(selected.appliedRevision,1);
  assert.deepEqual(await primary.get(recipient,room),{ ...room,userId:guardian.userId,revision:1 });
  await primary.save(manager,select(recipient.userId,1,'primary-recipient-0001'));
  assert.deepEqual(await primary.get(guardian,room),{ ...room,userId:recipient.userId,revision:2 });
  assert.deepEqual(await snapshot(),before);
});

test('primary selection requires an active linked guardian or recipient and hides inactive or disconnected stored identities',async () => {
  await connect();
  for (const userId of ['therapist-a','manager-a','recipient-new','recipient-b','guardian-new','absent'])
    await assert.rejects(primary.save(manager,select(userId,0,`primary-unavailable-${userId}`)),code('PARTICIPANT_UNAVAILABLE'));
  await primary.save(manager,select(recipient.userId));
  await db.exec(`UPDATE cb_memberships SET active=false WHERE user_id='recipient-a'`);
  assert.deepEqual(await primary.get(guardian,room),{ ...room,userId:null,revision:1 });
  await assert.rejects(primary.save(manager,select(recipient.userId,1,'primary-disabled-0001')),code('PARTICIPANT_UNAVAILABLE'));
  await db.exec(`UPDATE cb_memberships SET active=true WHERE user_id='recipient-a'`);
  await disconnect(); assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision:1 });
  const cleared=await primary.save(manager,select(null,1,'primary-clear-stale-0001')); assert.equal(cleared.changed,true);
  assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision:2 });
});

test('user, membership and participation reactivation never revives a previous primary designation',async () => {
  await connect(); let revision=0,index=0;
  for (const userId of [guardian.userId,recipient.userId]) for (const table of ['cb_users','cb_memberships','cb_participants']) {
    index++;
    const selected=await primary.save(manager,select(userId,revision,`primary-generation-select-${index}`)); revision=selected.appliedRevision;
    assert.equal((await primary.get(manager,room)).userId,userId);
    const column=table==='cb_users'?'id':'user_id';
    await db.query(`UPDATE ${table} SET active=false WHERE ${column}=$1`,[userId]);
    assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision });
    await db.query(`UPDATE ${table} SET active=true WHERE ${column}=$1`,[userId]);
    assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision });
    const newSelection=await primary.save(manager,select(userId,revision,`primary-generation-reselect-${index}`));
    assert.equal(newSelection.changed,true); assert.equal(newSelection.appliedRevision,revision+1); revision=newSelection.appliedRevision;
    assert.equal((await primary.get(manager,room)).userId,userId);
  }
});

test('explicit recipient disconnect and reconnect require primary redesignation; retrying its old receipt cannot renew it',async () => {
  await connect(); const input=select(recipient.userId),first=await primary.save(manager,input);
  await disconnect(); await send(); await connect({ clientId:'recipient-generation-reconnect' });
  assert.deepEqual(await primary.get(recipient,room),{ ...room,userId:null,revision:1 });
  assert.deepEqual(await primary.save(manager,input),{ ...first,replayed:true });
  assert.deepEqual(await primary.get(recipient,room),{ ...room,userId:null,revision:1 });
  const before=await snapshot();
  const selected=await primary.save(manager,select(recipient.userId,1,'primary-explicit-redesignation'));
  assert.equal(selected.changed,true); assert.equal(selected.appliedRevision,2);
  assert.equal((await primary.get(recipient,room)).userId,recipient.userId);
  assert.deepEqual(await snapshot(),before);
});

test('no-op qualification updates preserve designation, while generation mutation is rejected',async () => {
  await connect(); await primary.save(manager,select(recipient.userId));
  for (const table of ['cb_users','cb_memberships','cb_participants']) {
    const column=table==='cb_users'?'id':'user_id';
    await db.query(`UPDATE ${table} SET active=true WHERE ${column}=$1`,[recipient.userId]);
    assert.equal((await primary.get(recipient,room)).userId,recipient.userId);
    await assert.rejects(db.query(`UPDATE ${table} SET communication_generation=communication_generation+1 WHERE ${column}=$1`,[recipient.userId]),sqlCode('23514'));
  }
});

test('primary receipts have independent versions, no-op stability, exact replay and no reapplication after clearing',async () => {
  const first=await primary.save(manager,select(guardian.userId)),relationshipVersion=(await get()).version;
  assert.deepEqual(await primary.save(manager,select(guardian.userId)),{ ...first,replayed:true });
  await connect(); // An unrelated relationship change must not stale the contact form.
  const second=await primary.save(manager,select(recipient.userId,1,'primary-change-0002')); assert.equal(second.appliedRevision,2);
  assert.equal((await get()).version,relationshipVersion+1);
  await assert.rejects(primary.save(manager,select(guardian.userId,1,'primary-stale-0001')),code('PRIMARY_COMMUNICATOR_CONFLICT'));
  await assert.rejects(primary.save(manager,select(null,0)),code('IDEMPOTENCY_CONFLICT'));
  const same=await primary.save(manager,select(recipient.userId,2,'primary-noop-0001')); assert.equal(same.changed,false); assert.equal(same.appliedRevision,2);
  await primary.save(manager,select(null,2,'primary-clear-0001'));
  await primary.save(manager,select(guardian.userId)); assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision:3 });
});

test('primary save rejects unrelated fields and a missing target rather than silently clearing',() => {
  const input=select(guardian.userId);
  for (const extra of [{ role:'center' },{ history:'all' },{ expectedRevision:-1 },{ clientId:'short' },{ userId:undefined }])
    assert.throws(()=>primary.save(manager,{ ...input,...extra }),code('INVALID_INPUT'));
  const { userId,...missing }=input; assert.throws(()=>primary.save(manager,missing),code('INVALID_INPUT'));
});

test('failed primary receipt rolls back the metadata and display revision, then retries once',async () => {
  const before=(await db.query(`SELECT revision FROM cb_conversations WHERE id='room-a'`)).rows[0].revision;
  await db.exec(`CREATE FUNCTION cb_test_primary_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic primary receipt failure'; END; $$;
    CREATE TRIGGER cb_test_primary_failure BEFORE INSERT ON cb_primary_communicator_requests FOR EACH ROW EXECUTE FUNCTION cb_test_primary_failure()`);
  try { await assert.rejects(primary.save(manager,select(guardian.userId)),/synthetic primary receipt failure/); }
  finally { await db.exec('DROP TRIGGER cb_test_primary_failure ON cb_primary_communicator_requests; DROP FUNCTION cb_test_primary_failure()'); }
  assert.deepEqual(await primary.get(manager,room),{ ...room,userId:null,revision:0 });
  assert.equal((await db.query(`SELECT revision FROM cb_conversations WHERE id='room-a'`)).rows[0].revision,before);
  assert.equal((await primary.save(manager,select(guardian.userId))).replayed,false);
});

test('primary schema rejects an ineligible role, identity changes, deletion and audit rewrites',async () => {
  await assert.rejects(db.exec(`INSERT INTO cb_primary_communicators(center_id,conversation_id,user_id,revision,updated_by)
    VALUES('center-a','room-a','therapist-a',1,'manager-a')`),sqlCode('23514'));
  await primary.save(manager,select(guardian.userId));
  for (const sql of [
    `UPDATE cb_primary_communicators SET user_id=NULL`,
    `UPDATE cb_primary_communicators SET conversation_id='room-other',revision=2`,
    `DELETE FROM cb_primary_communicators`,
    `UPDATE cb_primary_communicator_requests SET changed=false`,
    `DELETE FROM cb_primary_communicator_requests`,
  ]) await assert.rejects(db.exec(sql),sqlCode('23514'));
});

test('new feature tables retain both row-write and truncate quarantine guards',async () => {
  const { rows }=await db.query(`SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname=ANY($1::text[]) AND t.tgname IN ('cb_000_recovery_guard','cb_recovery_truncate_guard') ORDER BY c.relname,t.tgname`,
  [['cb_care_recipient_links','cb_primary_communicators','cb_primary_communicator_requests']]);
  assert.equal(rows.length,6);
  assert.deepEqual(await migrate(db),[]);
});
