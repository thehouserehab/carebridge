import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { copyFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Children,MemberProfiles } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';

let db,children,members,chat,relations;
const manager = { centerId:'center-a',userId:'manager-a' }, therapist = { centerId:'center-a',userId:'therapist-a' };
const guardian = { centerId:'center-a',userId:'guardian-a' }, peer = { centerId:'center-a',userId:'guardian-peer' };
const stranger = { centerId:'center-a',userId:'stranger-a' }, foreign = { centerId:'center-b',userId:'manager-b' };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const registerInput = (extra = {}) => ({ childId:'child-new',conversationId:'room-new',clientId:'register-child-0001',content:{ name:'가상 아이',age:0,ageAsOf:'2026-01-01' },...extra });
const saveInput = (extra = {}) => ({ conversationId:'room-a',clientId:'save-child-0001',expectedRevision:0,content:{ name:'가상 하루' },...extra });
const familyInput = (extra = {}) => ({ conversationId:'room-a',clientId:'save-family-0001',expectedRevision:0,concern:'PRIVATE-FAMILY 가상 관심사',...extra });
const memberInput = (extra = {}) => ({ clientId:'save-member-0001',expectedRevision:0,displayName:'가상 보호자',...extra });
const get = (actor = guardian,room = 'room-a') => children.get(actor,{ conversationId:room });
async function failReceipt(run) {
  await db.exec(`CREATE FUNCTION cb_test_profile_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END; $$;
    CREATE TRIGGER cb_test_profile_failure BEFORE INSERT ON cb_profile_requests FOR EACH ROW EXECUTE FUNCTION cb_test_profile_failure()`);
  try { await assert.rejects(run(),(error) => /test receipt failure/.test(error.message)); }
  finally { await db.exec('DROP TRIGGER cb_test_profile_failure ON cb_profile_requests; DROP FUNCTION cb_test_profile_failure()'); }
}
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-b',true),('therapist-a',true),('guardian-a',true),('guardian-peer',true),('stranger-a',true),('disabled-a',false);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-b','manager-b','center',true),('center-a','therapist-a','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-b','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),('center-a','stranger-a','guardian',true),('center-a','disabled-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-a','guardian-peer','guardian',true,1);`);
  children = new Children(db); members = new MemberProfiles(db); chat = new Conversations(db); relations = new Relationships(db);
});

test('manager registration atomically creates child/room/minimal profile but no account, participant or history grant',async () => {
  const registered = await children.register(manager,registerInput());
  assert.equal(registered.appliedVersion,1); assert.equal((await children.register(manager,registerInput())).replayed,true);
  const profile = await get(manager,'room-new'); assert.equal(profile.name,'가상 아이'); assert.equal(profile.age,0); assert.equal(profile.ageAsOf,'2026-01-01');
  assert.deepEqual(profile.participants,[]); assert.equal('familyPlan' in profile,false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_participants WHERE conversation_id = 'room-new'")).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_accounts')).rows[0].n,0);
  await assert.rejects(get(therapist,'room-new'),errorCode('NOT_FOUND'));
  await assert.rejects(children.register({ ...guardian,role:'center' },registerInput({ childId:'forged-child',conversationId:'forged-room' })),errorCode('NOT_FOUND'));
  await assert.rejects(children.register(manager,registerInput({ clientId:'register-child-0002' })),errorCode('CHILD_EXISTS'));
});

test('self-managed display names are center-scoped and roster/team projections never expose credentials or another center profile',async () => {
  await members.saveSelf(guardian,memberInput());
  await members.saveSelf({ ...guardian,centerId:'center-b' },memberInput({ displayName:'다른 센터 가상명' }));
  assert.equal((await members.getSelf(guardian)).displayName,'가상 보호자');
  assert.equal((await members.getSelf({ ...guardian,centerId:'center-b' })).displayName,'다른 센터 가상명');
  const team = (await get()).participants; assert.equal(team.find((row) => row.userId === guardian.userId).displayName,'가상 보호자');
  const roster = await members.listMembers(manager); assert(!roster.members.some((row) => row.userId === 'disabled-a'));
  assert.equal(JSON.stringify(roster).includes('다른 센터'),false);
  for (const row of [...team,...roster.members]) assert.deepEqual(Object.keys(row),['userId','role','displayName','revision','updatedAt']);
  await assert.rejects(members.listMembers({ ...guardian,role:'center' }),errorCode('NOT_FOUND'));
  assert.throws(() => members.saveSelf(manager,{ ...memberInput(),userId:guardian.userId }),errorCode('INVALID_INPUT'));
});

test('member saves preserve exact receipts, reject stale writes/noisy conflicts and allow clearing without retaining name snapshots',async () => {
  const first = await members.saveSelf(guardian,memberInput()); assert.equal(first.appliedVersion,1);
  await assert.rejects(members.saveSelf(guardian,memberInput({ clientId:'stale-member-0001' })),errorCode('PROFILE_CONFLICT'));
  const unchanged = await members.saveSelf(guardian,memberInput({ expectedRevision:1,clientId:'same-member-0001' }));
  assert.equal(unchanged.changed,false); assert.equal(unchanged.appliedVersion,1);
  await members.saveSelf(guardian,memberInput({ expectedRevision:1,clientId:'clear-member-0001',displayName:null }));
  assert.equal((await members.getSelf(guardian)).displayName,null);
  const replay = await members.saveSelf(guardian,memberInput()); assert.equal(replay.appliedVersion,1); assert.equal(replay.replayed,true);
  assert.equal((await members.getSelf(guardian)).revision,2);
  await assert.rejects(members.saveSelf(guardian,memberInput({ displayName:'가상 변경' })),errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(JSON.stringify((await db.query('SELECT * FROM cb_profile_requests')).rows).includes('가상 보호자'),false);
});

test('shared display-name rules reject controls before trimming without changing profile or adding a receipt',async () => {
  for (const displayName of ['', ' ', '\n가상', '가상\t', '가상\r', '가상\u0085', '\ud800', '가'.repeat(31), false, undefined])
    assert.throws(() => members.saveSelf(guardian,memberInput({ displayName })),errorCode('INVALID_INPUT'));
  assert.equal((await members.getSelf(guardian)).displayName,null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_profile_requests')).rows[0].n,0);
  await members.saveSelf(guardian,memberInput({ displayName:' 가상 설정 ' }));
  assert.equal((await members.getSelf(guardian)).displayName,'가상 설정');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions')).rows[0].n,0);
});

test('child profile updates preserve unknown age, explicit zero and measurement date instead of inventing birth dates or advancing ages',async () => {
  const unknown = await get(); assert.equal(unknown.name,null); assert.equal(unknown.age,null); assert.equal(unknown.revision,0);
  await children.save(manager,saveInput()); assert.equal((await get()).age,null);
  await children.save(manager,saveInput({ expectedRevision:1,clientId:'save-child-0002',content:{ name:'가상 하루',age:0,ageAsOf:'2026-01-01' } }));
  const zero = await get(); assert.equal(zero.age,0); assert.equal(zero.ageAsOf,'2026-01-01'); assert.equal('birthDate' in zero,false);
  const same = await children.save(manager,saveInput({ expectedRevision:2,clientId:'save-child-same',content:{ name:'가상 하루',age:0,ageAsOf:'2026-01-01' } }));
  assert.equal(same.changed,false); assert.equal(same.appliedVersion,2);
  await children.save(manager,saveInput({ expectedRevision:2,clientId:'save-child-0003',content:{ name:'가상 하루' } }));
  assert.equal((await get()).age,null);
  for (const actor of [guardian,therapist]) await assert.rejects(children.save({ ...actor,role:'center' },saveInput()),errorCode('FORBIDDEN'));
  await assert.rejects(children.save(manager,saveInput({ clientId:'stale-child-0001' })),errorCode('PROFILE_CONFLICT'));
});

test('family interest is guardian-authored current shared context, never a center operational field or clinical record',async () => {
  await children.saveFamilyPlan(guardian,familyInput()); assert.equal((await get(therapist)).familyPlan.concern,familyInput().concern);
  for (const actor of [manager,therapist]) await assert.rejects(children.saveFamilyPlan({ ...actor,role:'guardian' },familyInput()),errorCode('FORBIDDEN'));
  await assert.rejects(children.saveFamilyPlan(peer,familyInput({ clientId:'peer-family-0001' })),errorCode('PROFILE_CONFLICT'));
  await children.saveFamilyPlan(peer,familyInput({ clientId:'peer-family-0002',expectedRevision:1,concern:'가상 최신 관심사' }));
  assert.equal((await get()).familyPlan.revision,2);
  const centerProfile = await get(manager); assert.equal('familyPlan' in centerProfile,false);
  assert.equal(JSON.stringify(await children.list(manager)).includes('관심사'),false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n,0);
  assert.equal(JSON.stringify((await db.query('SELECT * FROM cb_profile_requests')).rows).includes('PRIVATE-FAMILY'),false);
  await children.saveFamilyPlan(peer,familyInput({ clientId:'clear-family-0001',expectedRevision:2,concern:'' }));
  assert.equal((await get()).familyPlan.concern,''); assert.equal((await children.saveFamilyPlan(guardian,familyInput())).replayed,true);
  assert.equal((await get()).familyPlan.concern,'');
});

test('lists are bounded/keyset-paged and child reads require current relationships, not knowledge of a child ID or caller role',async () => {
  assert.deepEqual((await children.list(guardian)).children.map((row) => row.childId),['child-a']);
  assert.deepEqual((await children.list(stranger)).children,[]);
  const first = await children.list(manager,{ limit:1 }); assert.equal(first.hasMore,true);
  const second = await children.list(manager,{ after:first.nextCursor,limit:1 }); assert.equal(second.children[0].childId,'child-other');
  const roster = await members.listMembers(manager,{ limit:1 }); assert.equal(roster.members.length,1); assert.equal(roster.hasMore,true);
  await assert.rejects(get(stranger),errorCode('NOT_FOUND')); await assert.rejects(get(foreign),errorCode('NOT_FOUND'));
  await assert.rejects(get(guardian,'room-other'),errorCode('NOT_FOUND'));
  for (const limit of [0,101,'1',1.5]) { assert.throws(() => children.list(manager,{ limit }),errorCode('INVALID_INPUT')); assert.throws(() => members.listMembers(manager,{ limit }),errorCode('INVALID_INPUT')); }
});

test('from_now permits current child context without granting earlier messages or silently assigning newly registered children',async () => {
  await children.save(manager,saveInput()); await children.saveFamilyPlan(guardian,familyInput());
  const old = await chat.sendText(guardian,{ conversationId:'room-a',clientId:'old-child-message',body:'가상 이전 소식' });
  const current = await relations.get(manager,{ conversationId:'room-a' });
  await relations.replace(manager,{ conversationId:'room-a',clientId:'connect-stranger-01',expectedVersion:current.version,historyConfirmed:true,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[{ userId:guardian.userId,history:'preserve' },{ userId:stranger.userId,history:'from_now' }] });
  assert.equal((await get(stranger)).name,'가상 하루'); assert.equal((await get(stranger)).familyPlan.concern,familyInput().concern);
  await assert.rejects(chat.get(stranger,{ conversationId:'room-a',messageId:old.id }),errorCode('NOT_FOUND'));
  await assert.rejects(get(peer),errorCode('NOT_FOUND')); // Disconnected peer, not a stale caller role.
});

test('account, center membership and child relationship deactivation deny fresh reads/writes and successful receipt replay',async () => {
  await members.saveSelf(guardian,memberInput()); await children.saveFamilyPlan(guardian,familyInput());
  await db.query('UPDATE cb_users SET active = false WHERE id = $1',[guardian.userId]);
  for (const run of [() => members.getSelf(guardian),() => members.saveSelf(guardian,memberInput()),() => get(),() => children.list(guardian),() => children.saveFamilyPlan(guardian,familyInput())]) await assert.rejects(run(),errorCode('NOT_FOUND'));
  await db.query('UPDATE cb_users SET active = true WHERE id = $1',[guardian.userId]);
  await db.query("UPDATE cb_memberships SET active = false WHERE center_id = 'center-a' AND user_id = $1",[guardian.userId]);
  await assert.rejects(members.getSelf(guardian),errorCode('NOT_FOUND')); await assert.rejects(get(),errorCode('NOT_FOUND'));
  await db.query("UPDATE cb_memberships SET active = true WHERE center_id = 'center-a' AND user_id = $1",[guardian.userId]);
  await db.query("UPDATE cb_participants SET active = false WHERE conversation_id = 'room-a' AND user_id = $1",[guardian.userId]);
  assert.equal((await members.getSelf(guardian)).displayName,'가상 보호자');
  await assert.rejects(children.saveFamilyPlan(guardian,familyInput()),errorCode('NOT_FOUND'));
});

test('strict profile inputs reject coerced ages, missing/future/invalid dates, credential fields and injected role/subject selection',async () => {
  for (const content of [{ name:'' },{ name:'x'.repeat(31) },{ name:'가상\n이름' },{ name:'\n가상' },{ name:'가상\t' },{ name:'가상',age:'2',ageAsOf:'2026-01-01' },
    { name:'가상',age:2 },{ name:'가상',age:-1,ageAsOf:'2026-01-01' },{ name:'가상',age:27,ageAsOf:'2026-01-01' },
    { name:'가상',age:2,ageAsOf:'2026-02-30' },{ name:'가상',age:2,ageAsOf:'9999-01-01' },{ name:'가상',ageAsOf:'2026-01-01' },{ name:'가상',diagnosis:'hidden' }])
    await assert.rejects(Promise.resolve().then(() => children.save(manager,saveInput({ content }))),errorCode('INVALID_INPUT'));
  for (const displayName of ['',5,{},'x'.repeat(31),'가상\t이름','가상\u0000','가상\u0085','가상\ud800'])
    assert.throws(() => members.saveSelf(guardian,memberInput({ displayName })),errorCode('INVALID_INPUT'));
  assert.throws(() => children.saveFamilyPlan(guardian,{ ...familyInput(),privateNote:'hidden' }),errorCode('INVALID_INPUT'));
  await children.save(manager,saveInput({ content:{ name:"가상 ' <b>표시명</b>" } }));
  assert.equal((await get()).name,"가상 ' <b>표시명</b>"); // Literal text; escaping belongs to the future UI boundary.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_children')).rows[0].n,3);
});

test('receipt failure rolls back first saves, registration, updates and room invalidation; exact retries succeed once',async () => {
  await failReceipt(() => members.saveSelf(guardian,memberInput())); assert.equal((await members.getSelf(guardian)).revision,0);
  await members.saveSelf(guardian,memberInput());
  await failReceipt(() => children.register(manager,registerInput()));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_children WHERE id = 'child-new'")).rows[0].n,0);
  await children.register(manager,registerInput());
  const before = (await db.query("SELECT revision FROM cb_conversations WHERE id = 'room-a'")).rows[0];
  await failReceipt(() => children.save(manager,saveInput())); assert.equal((await get()).revision,0);
  await failReceipt(() => children.saveFamilyPlan(guardian,familyInput())); assert.equal((await get()).familyPlan.revision,0);
  assert.deepEqual((await db.query("SELECT revision FROM cb_conversations WHERE id = 'room-a'")).rows[0],before);
  await children.save(manager,saveInput()); await children.saveFamilyPlan(guardian,familyInput());
  const original = await get();
  await failReceipt(() => children.save(manager,saveInput({ expectedRevision:1,clientId:'rollback-child-02',content:{ name:'가상 변경' } })));
  await failReceipt(() => children.saveFamilyPlan(guardian,familyInput({ expectedRevision:1,clientId:'rollback-family-02',concern:'가상 변경' })));
  assert.deepEqual(await get(),original);
  assert.equal((await children.save(manager,saveInput())).replayed,true); assert.equal((await children.saveFamilyPlan(guardian,familyInput())).replayed,true);
});

test('database guards reject moving profile identities, invalid age pairs, mutable receipts and nullable self subjects',async () => {
  await members.saveSelf(guardian,memberInput()); await children.save(manager,saveInput()); await children.saveFamilyPlan(guardian,familyInput());
  await assert.rejects(db.query("UPDATE cb_member_profiles SET center_id = 'center-b',revision = revision + 1"),{ code:'23514' });
  await assert.rejects(db.query("UPDATE cb_child_profiles SET age = 3,age_as_of = NULL,revision = revision + 1"),{ code:'23514' });
  await assert.rejects(db.query("UPDATE cb_child_profiles SET name = '가상 변경'"),{ code:'23514' });
  await assert.rejects(db.query('DELETE FROM cb_child_family_plans'),{ code:'23514' });
  await assert.rejects(db.query('UPDATE cb_profile_requests SET changed = false'),{ code:'23514' });
  await assert.rejects(db.exec(`INSERT INTO cb_profile_requests(center_id,actor_id,client_id,request_hash,operation,applied_version,changed)
    VALUES ('center-a','guardian-a','invalid-self-subject',repeat('0',64),'member.save',0,false)`),{ code:'23514' });
  await assert.rejects(db.exec(`INSERT INTO cb_profile_requests(center_id,actor_id,client_id,request_hash,operation,child_id,conversation_id,applied_version,changed)
    VALUES ('center-a','manager-a','cross-child-receipt',repeat('0',64),'child.save','child-other','room-a',1,true)`),{ code:'23503' });
});

test('010 preserves 009 identifiers/content/permissions and does not synthesize any historical profile data',async () => {
  const directory = await mkdtemp(join(tmpdir(),'carebridge-profiles-migration-')), legacy = await PGlite.create();
  try {
    const migrations = join(directory,'migrations'); await mkdir(migrations);
    for (const name of ['001-conversations.sql','002-authentication.sql','003-invitations.sql','004-relationships.sql','005-records.sql','006-activity-feedback.sql','007-care-contexts.sql','008-media-uploads.sql','009-media-bindings.sql'])
      await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(migrations,name));
    await migrate(legacy,pathToFileURL(`${migrations}/`));
    await legacy.exec(`INSERT INTO cb_centers(id) VALUES ('center-a'); INSERT INTO cb_users(id,active) VALUES ('guardian-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true); INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'); INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1);`);
    // Use an actual historical 009 row, not current service SQL against a
    // deliberately unmigrated schema. The upgrade must preserve it verbatim.
    await legacy.exec(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
      VALUES ('center-a','room-a','legacy-profile-message',1,'guardian-a','legacy-profile-message',repeat('a',64),'text','가상 과거 자유 텍스트');
      UPDATE cb_conversations SET last_sequence = 1 WHERE id = 'room-a';`);
    const previous = (await legacy.query('SELECT * FROM cb_messages')).rows, grants = (await legacy.query('SELECT * FROM cb_participants')).rows;
    assert.deepEqual(await migrate(legacy),['010-profiles.sql','011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_messages')).rows,previous);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_participants')).rows,grants.map(row=>({...row,communication_generation:0})));
    assert.equal((await legacy.query('SELECT * FROM cb_child_profiles')).rows.length,0); assert.equal((await legacy.query('SELECT * FROM cb_member_profiles')).rows.length,0);
    const profile = await new Children(legacy).get(guardian,{ conversationId:'room-a' }); assert.equal(profile.name,null); assert.equal(profile.familyPlan.concern,'');
    assert.deepEqual(await migrate(legacy),[]);
  } finally {
    await legacy.close(); const target = resolve(directory), rel = relative(resolve(tmpdir()),target);
    assert(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('carebridge-profiles-migration-')); await rm(target,{ recursive:true,force:true });
  }
});
