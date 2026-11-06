import assert from 'node:assert/strict';
import { after,before,beforeEach,test } from 'node:test';
import { copyFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Goals,Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';

let database,goals,appointments,records,conversations,relationships;
const therapist = { centerId:'center-a',userId:'therapist-a' };
const guardian = { centerId:'center-a',userId:'guardian-a' };
const manager = { centerId:'center-a',userId:'manager-a' };
const peer = { centerId:'center-a',userId:'therapist-other' };
const newcomer = { centerId:'center-a',userId:'guardian-new' };
const foreign = { centerId:'center-b',userId:'therapist-b' };
const errorCode = (code) => (error) => error instanceof RepositoryError && error.code === code;
const goalBody = (extra = {}) => ({ title:'가상 공동 목표',description:'가족과 확인한 가상 목표',status:'active',...extra });
const goalInput = (extra = {}) => ({ conversationId:'room-a',goalId:'goal-a',clientId:'goal-save-0001',expectedRevision:0,content:goalBody(),...extra });
const appointmentBody = (extra = {}) => ({ date:'2026-10-01',time:'10:00',duration:40,title:'가상 회기',room:'가상 치료실 A',status:'scheduled',...extra });
const appointmentInput = (extra = {}) => ({ conversationId:'room-a',appointmentId:'appointment-a',clientId:'appointment-save-0001',
  expectedRevision:0,content:appointmentBody(),...extra });
const goalGet = (actor = therapist,extra = {}) => goals.get(actor,{ conversationId:'room-a',goalId:'goal-a',...extra });
const appointmentGet = (actor = manager,extra = {}) => appointments.get(actor,{ conversationId:'room-a',appointmentId:'appointment-a',...extra });
const schedule = (actor = manager,extra = {}) => appointments.list(actor,{ dateFrom:'2026-10-01',dateTo:'2026-10-03',...extra });
const recordInput = (extra = {}) => ({ conversationId:'room-a',recordId:'record-a',clientId:'record-save-0001',expectedRevision:0,
  expectedGoalRevision:1,expectedAppointmentRevision:1,
  content:{ date:'2026-10-01',goalId:'goal-a',appointmentId:'appointment-a',performed:'가상 관찰',summary:'공개 요약',privateNote:'PRIVATE-RECORD-FIXTURE' },...extra });
async function replace(extra = {}) {
  const old = await relationships.get(manager,{ conversationId:'room-a' });
  return relationships.replace(manager,{ conversationId:'room-a',clientId:'relationship-0001',expectedVersion:old.version,historyConfirmed:true,
    therapist:{ userId:therapist.userId,history:'preserve' },guardians:[{ userId:guardian.userId,history:'preserve' }],...extra });
}
async function prepare() { await goals.save(therapist,goalInput()); await appointments.save(manager,appointmentInput()); }

before(async () => { database = await PGlite.create(); await migrate(database); });
after(async () => { await database?.close(); });
beforeEach(async () => {
  // This memory-only database contains invented identities and content.
  await database.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('therapist-other',true),('guardian-a',true),
      ('guardian-other',true),('guardian-new',true),('manager-a',true),('therapist-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','therapist-other','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-other','guardian',true),('center-a','guardian-new','guardian',true),
      ('center-a','manager-a','center',true),('center-b','therapist-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-second'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-second','child-second'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-second','therapist-a','therapist',true,1),('center-a','room-other','therapist-other','therapist',true,1),
      ('center-a','room-other','guardian-other','guardian',true,1),('center-b','room-b','therapist-b','therapist',true,1);`);
  goals = new Goals(database); appointments = new Appointments(database); records = new Records(database);
  conversations = new Conversations(database); relationships = new Relationships(database);
});

test('current care team reads shared goals; only assigned therapist writes, and earlier goal versions stay intact',async () => {
  await goals.save(therapist,goalInput());
  const original = await goalGet();
  assert.equal((await goalGet(guardian)).description,goalBody().description);
  await goals.save(therapist,goalInput({ clientId:'goal-save-0002',expectedRevision:1,content:goalBody({ status:'achieved',title:'수정한 가상 목표' }) }));
  assert.equal((await goalGet()).status,'achieved');
  assert.deepEqual(await goalGet(therapist,{ revision:1 }),original);
  assert.equal((await goals.list(guardian,{ conversationId:'room-a' })).goals.length,1);
  await assert.rejects(goals.save({ ...guardian,role:'therapist' },goalInput()),errorCode('FORBIDDEN'));
  await assert.rejects(goalGet(guardian,{ revision:1 }),errorCode('FORBIDDEN'));
  for (const actor of [manager,peer,newcomer,foreign]) await assert.rejects(goalGet({ ...actor,role:'therapist' }),errorCode('NOT_FOUND'));
  assert.equal((await conversations.list(guardian,{ conversationId:'room-a' })).messages.length,0);
});

test('therapist and manager maintain operational schedules; guardian reads only connected children and center gets no clinical originals',async () => {
  await prepare();
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'appointment-other',clientId:'appointment-other-0001',
    content:appointmentBody({ room:'가상 치료실 B' }) }));
  assert.equal((await appointmentGet(guardian)).therapistId,therapist.userId);
  assert.equal((await schedule(manager)).appointments.length,2);
  assert.equal((await schedule(therapist)).appointments.length,1);
  assert.equal((await schedule(guardian)).appointments.length,1);
  assert.equal((await schedule(newcomer)).appointments.length,0);
  await assert.rejects(appointments.save(guardian,appointmentInput()),errorCode('FORBIDDEN'));
  for (const actor of [peer,newcomer,foreign]) await assert.rejects(appointmentGet(actor),errorCode('NOT_FOUND'));
  await records.save(therapist,recordInput());
  const centerView = JSON.stringify(await schedule());
  assert.equal(centerView.includes('PRIVATE-'),false);
  assert.equal(centerView.includes(goalBody().description),false);
  await assert.rejects(records.get(manager,{ conversationId:'room-a',recordId:'record-a' }),errorCode('NOT_FOUND'));
  await appointments.save(therapist,appointmentInput({ clientId:'attendance-0001',expectedRevision:1,content:appointmentBody({ status:'attended' }) }));
  assert.equal((await appointmentGet(guardian)).status,'attended');
  assert.equal((await appointmentGet(manager,{ revision:1 })).status,'scheduled');
  await assert.rejects(appointmentGet(guardian,{ revision:1 }),errorCode('FORBIDDEN'));
});

test('overlap checks cover same child, therapist across children, and treatment place across therapists; adjacent slots and separate centers work',async () => {
  await appointments.save(manager,appointmentInput());
  const before = await schedule();
  const conflicts = [
    appointmentInput({ appointmentId:'overlap-child',clientId:'overlap-child-0001',content:appointmentBody({ time:'10:20',room:'다른 장소' }) }),
    appointmentInput({ conversationId:'room-second',appointmentId:'overlap-therapist',clientId:'overlap-therapist-0001',content:appointmentBody({ room:'다른 장소' }) }),
    appointmentInput({ conversationId:'room-other',appointmentId:'overlap-place',clientId:'overlap-place-0001' }),
  ];
  for (const input of conflicts) await assert.rejects(appointments.save(manager,input),errorCode('SCHEDULE_CONFLICT'));
  assert.deepEqual(await schedule(),before);
  await appointments.save(manager,appointmentInput({ appointmentId:'adjacent',clientId:'adjacent-0001',content:appointmentBody({ time:'10:40' }) }));
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'parallel',clientId:'parallel-0001',content:appointmentBody({ room:'다른 장소' }) }));
  await appointments.save(foreign,appointmentInput({ conversationId:'room-b',appointmentId:'foreign',clientId:'foreign-0001' }));
  assert.equal((await schedule()).appointments.length,3);
  assert.equal((await schedule(foreign)).appointments.length,1);
});

test('cancelled appointment releases resources; restoring conflicts and still preserves its linked record',async () => {
  await prepare(); await records.save(therapist,recordInput());
  const originalRecord = await records.get(therapist,{ conversationId:'room-a',recordId:'record-a' });
  await appointments.save(manager,appointmentInput({ clientId:'cancel-0001',expectedRevision:1,content:appointmentBody({ status:'cancelled' }) }));
  await appointments.save(manager,appointmentInput({ appointmentId:'replacement',clientId:'replacement-0001' }));
  await assert.rejects(appointments.save(manager,appointmentInput({ clientId:'restore-0001',expectedRevision:2 })),errorCode('SCHEDULE_CONFLICT'));
  assert.equal((await appointmentGet()).status,'cancelled');
  assert.deepEqual(await records.get(therapist,{ conversationId:'room-a',recordId:'record-a' }),originalRecord);
  assert.equal(originalRecord.appointmentSnapshot.status,'scheduled');
});

test('midnight end does not wrap overlap math; another date is independent and invalid times/dates are rejected',async () => {
  await appointments.save(manager,appointmentInput({ content:appointmentBody({ time:'23:20' }) }));
  await assert.rejects(appointments.save(manager,appointmentInput({ appointmentId:'late',clientId:'late-overlap-0001',
    content:appointmentBody({ time:'23:50',duration:10 }) })),errorCode('SCHEDULE_CONFLICT'));
  await appointments.save(manager,appointmentInput({ appointmentId:'tomorrow',clientId:'tomorrow-0001',content:appointmentBody({ date:'2026-10-02',time:'00:00' }) }));
  for (const extra of [{ date:'2026-02-30' },{ date:'0000-01-01' },{ time:'24:00' },{ time:'10:00:30' },{ time:'23:50' },
    { duration:false },{ duration:null },{ duration:{} },{ duration:9 },{ duration:181 },{ duration:40.1 },{ status:'invented' },{ attachments:[] }])
    await assert.rejects(appointments.save(manager,appointmentInput({ appointmentId:'invalid',clientId:'invalid-0001',content:appointmentBody(extra) })),errorCode('INVALID_INPUT'));
  for (const extra of [{ title:'' },{ title:{} },{ description:'x'.repeat(2001) },{ status:'invented' },{ privateNote:'unsupported' }])
    await assert.rejects(goals.save(therapist,goalInput({ content:goalBody(extra) })),errorCode('INVALID_INPUT'));
});

test('retries, no-op and optimistic conflicts prevent duplicate contexts and old requests reverting updated schedules/goals',async () => {
  const originalInput = goalInput();
  const [first,replay] = await Promise.all([goals.save(therapist,originalInput),goals.save(therapist,originalInput)]);
  assert.equal(first.revision,1); assert.equal(replay.replayed,true);
  await goals.save(therapist,goalInput({ clientId:'goal-save-0002',expectedRevision:1,content:goalBody({ status:'paused' }) }));
  assert.deepEqual(await goals.save(therapist,originalInput),{ ...first,replayed:true });
  assert.equal((await goalGet()).status,'paused');
  await assert.rejects(goals.save(therapist,goalInput({ clientId:'stale-goal-0001' })),errorCode('GOAL_CONFLICT'));
  await assert.rejects(goals.save(therapist,{ ...originalInput,content:goalBody({ status:'paused' }) }),errorCode('IDEMPOTENCY_CONFLICT'));
  await appointments.save(manager,appointmentInput());
  const before = await schedule();
  const same = await appointments.save(manager,appointmentInput({ clientId:'appointment-noop-0001',expectedRevision:1 }));
  assert.equal(same.changed,false); assert.equal(same.revision,1);
  assert.deepEqual(await schedule(),before);
  await appointments.save(manager,appointmentInput({ clientId:'appointment-edit-0001',expectedRevision:1,content:appointmentBody({ time:'11:00' }) }));
  assert.equal((await appointments.save(manager,appointmentInput())).replayed,true);
  assert.equal((await appointmentGet()).time,'11:00');
  await assert.rejects(appointments.save(manager,appointmentInput({ clientId:'appointment-stale-0001' })),errorCode('APPOINTMENT_CONFLICT'));
  await assert.rejects(appointments.save(therapist,appointmentInput({ clientId:originalInput.clientId })),errorCode('IDEMPOTENCY_CONFLICT'));
});

test('schedule pagination has stable tie-breakers and resets after changed content or relationship permissions',async () => {
  await appointments.save(manager,appointmentInput());
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'other',clientId:'other-0001',content:appointmentBody({ room:'다른 장소' }) }));
  const first = await schedule(manager,{ limit:1 });
  assert.equal(first.hasMore,true);
  const second = await schedule(manager,{ limit:1,after:first.nextCursor,expectedVersion:first.version });
  assert.equal(second.hasMore,false); assert.notEqual(first.appointments[0].id,second.appointments[0].id);
  await appointments.save(manager,appointmentInput({ clientId:'move-0001',expectedRevision:1,content:appointmentBody({ date:'2026-10-02' }) }));
  assert.equal((await schedule(manager,{ after:first.nextCursor,expectedVersion:first.version })).resetRequired,true);
  const guardianView = await schedule(guardian);
  await replace({ guardians:[{ userId:newcomer.userId,history:'from_now' }] });
  assert.equal((await schedule(guardian,{ expectedVersion:guardianView.version })).resetRequired,true);
  assert.equal((await schedule(guardian)).appointments.length,0);
  assert.equal((await schedule(newcomer)).appointments.length,1);
  await assert.rejects(schedule(manager,{ after:first.nextCursor }),errorCode('INVALID_INPUT'));
  await assert.rejects(schedule(manager,{ dateTo:'2027-10-01' }),errorCode('INVALID_INPUT'));
});

test('record revision captures original goal/schedule values and stale editing forms cannot silently switch context',async () => {
  await prepare();
  await records.save(therapist,recordInput());
  const original = await records.get(therapist,{ conversationId:'room-a',recordId:'record-a' });
  await goals.save(therapist,goalInput({ clientId:'goal-edit-0001',expectedRevision:1,content:goalBody({ title:'새 목표',status:'paused' }) }));
  await appointments.save(manager,appointmentInput({ clientId:'appointment-edit-0001',expectedRevision:1,content:appointmentBody({ time:'11:00',status:'attended' }) }));
  assert.deepEqual(await records.get(therapist,{ conversationId:'room-a',recordId:'record-a',revision:1 }),original);
  assert.equal(original.goalSnapshot.title,goalBody().title);
  assert.equal(original.appointmentSnapshot.time,'10:00');
  const next = recordInput({ clientId:'record-save-0002',expectedRevision:1 });
  await assert.rejects(records.save(therapist,next),errorCode('CONTEXT_CHANGED'));
  await assert.rejects(records.save(therapist,{ ...next,expectedGoalRevision:2 }),errorCode('CONTEXT_CHANGED'));
  await records.save(therapist,{ ...next,expectedGoalRevision:2,expectedAppointmentRevision:2 });
  const updated = await records.get(therapist,{ conversationId:'room-a',recordId:'record-a' });
  assert.equal(updated.goalRevision,2); assert.equal(updated.appointmentRevision,2);
  assert.equal(updated.goalSnapshot.title,'새 목표'); assert.equal(updated.appointmentSnapshot.time,'11:00');
});

test('therapist replacement rejects newly overlapping schedules atomically; resolving the conflict permits the same request retry',async () => {
  await appointments.save(manager,appointmentInput());
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'other',clientId:'other-0001',content:appointmentBody({ room:'다른 장소' }) }));
  const original = await relationships.get(manager,{ conversationId:'room-a' });
  const before = await schedule();
  await assert.rejects(replace({ pastHistoryConfirmed:true,therapist:{ userId:peer.userId,history:'all' } }),errorCode('SCHEDULE_CONFLICT'));
  assert.deepEqual(await relationships.get(manager,{ conversationId:'room-a' }),original);
  assert.deepEqual(await schedule(),before);
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM cb_relationship_requests')).rows[0].n,0);
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'other',clientId:'other-cancel-0001',expectedRevision:1,
    content:appointmentBody({ room:'다른 장소',status:'cancelled' }) }));
  await replace({ pastHistoryConfirmed:true,therapist:{ userId:peer.userId,history:'all' } });
  assert.equal((await appointmentGet()).therapistId,peer.userId);
  await assert.rejects(appointments.save(therapist,appointmentInput({ clientId:'former-0001',expectedRevision:1 })),errorCode('NOT_FOUND'));
});

test('from_now still shows current shared goals and operational schedule, while previous revisions require history access',async () => {
  await prepare();
  await replace({ guardians:[{ userId:newcomer.userId,history:'from_now' }] });
  assert.equal((await goalGet(newcomer)).title,goalBody().title);
  assert.equal((await appointmentGet(newcomer)).time,'10:00');
  await replace({ clientId:'replacement-0002',therapist:{ userId:peer.userId,history:'from_now' },
    guardians:[{ userId:newcomer.userId,history:'preserve' }] });
  assert.equal((await goalGet(peer)).revision,1);
  await assert.rejects(goalGet(peer,{ revision:1 }),errorCode('NOT_FOUND'));
  await assert.rejects(appointmentGet(peer,{ revision:1 }),errorCode('NOT_FOUND'));
  await goals.save(peer,goalInput({ clientId:'new-therapist-goal-0001',expectedRevision:1,content:goalBody({ title:'새 담당자가 확인한 목표' }) }));
  assert.equal((await goalGet(peer,{ revision:2 })).title,'새 담당자가 확인한 목표');
});

test('disabled users or memberships cannot read, save, or replay successful context commands',async () => {
  await prepare();
  await database.exec("UPDATE cb_users SET active = false WHERE id = 'guardian-a'; UPDATE cb_memberships SET active = false WHERE user_id = 'therapist-a';");
  await assert.rejects(goalGet(),errorCode('NOT_FOUND'));
  await assert.rejects(goals.save(therapist,goalInput()),errorCode('NOT_FOUND'));
  await assert.rejects(appointmentGet(guardian),errorCode('NOT_FOUND'));
  await assert.rejects(schedule(guardian),errorCode('NOT_FOUND'));
  await assert.rejects(appointments.save(manager,appointmentInput({ clientId:'no-provider-0001',expectedRevision:1,content:appointmentBody({ time:'11:00' }) })),errorCode('THERAPIST_UNAVAILABLE'));
  await database.exec("UPDATE cb_users SET active = false WHERE id = 'manager-a';");
  await assert.rejects(appointments.save(manager,appointmentInput()),errorCode('NOT_FOUND'));
});

test('receipt failure rolls back context originals/history, room counters and schedule version, then same request succeeds once',async () => {
  const commands = [() => goals.save(therapist,goalInput()),() => appointments.save(manager,appointmentInput()),
    () => goals.save(therapist,goalInput({ clientId:'goal-edit-0001',expectedRevision:1,content:goalBody({ status:'achieved' }) })),
    () => appointments.save(manager,appointmentInput({ clientId:'appointment-edit-0001',expectedRevision:1,content:appointmentBody({ status:'attended' }) }))];
  for (const command of commands) {
    const tables = ['cb_goals','cb_goal_revisions','cb_appointments','cb_appointment_revisions','cb_context_requests','cb_conversations','cb_centers'];
    const before = await Promise.all(tables.map(async (table) => (await database.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
    await database.exec(`CREATE FUNCTION cb_context_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected context receipt failure'; END; $$;
      CREATE TRIGGER cb_context_test_failure BEFORE INSERT ON cb_context_requests FOR EACH ROW EXECUTE FUNCTION cb_context_test_failure();`);
    try {
      await assert.rejects(command(),/injected context receipt failure/);
      for (const [index,table] of tables.entries()) assert.deepEqual((await database.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows,before[index]);
    } finally { await database.exec('DROP TRIGGER cb_context_test_failure ON cb_context_requests; DROP FUNCTION cb_context_test_failure();'); }
    assert.equal((await command()).replayed,false); assert.equal((await command()).replayed,true);
  }
});

test('database rejects mutable history, context moves, midnight overflow and overlapping direct inserts/assignments',async () => {
  await prepare();
  for (const sql of ["UPDATE cb_goal_revisions SET title = 'overwritten'",'DELETE FROM cb_goal_revisions',
    "UPDATE cb_appointment_revisions SET time = '12:00'",'DELETE FROM cb_appointment_revisions',
    "UPDATE cb_goals SET conversation_id = 'room-second'","UPDATE cb_appointments SET time = '12:00'"])
    await assert.rejects(database.query(sql),{ code:'23514' });
  await assert.rejects(database.query(`INSERT INTO cb_appointments(center_id,conversation_id,id,date,time,duration,title,room,status)
    VALUES ('center-a','room-other','late','2026-10-01','23:50',40,'가상 일정','다른 장소','scheduled')`),{ code:'23514' });
  await assert.rejects(database.query(`INSERT INTO cb_appointments(center_id,conversation_id,id,date,time,duration,title,room,status)
    VALUES ('center-a','room-other','overlap','2026-10-01','10:00',40,'가상 일정','가상 치료실 A','scheduled')`),{ code:'23P01' });
  await appointments.save(peer,appointmentInput({ conversationId:'room-other',appointmentId:'other',clientId:'other-0001',content:appointmentBody({ room:'다른 장소' }) }));
  await assert.rejects(database.transaction(async (tx) => {
    await tx.query("UPDATE cb_participants SET active = false WHERE conversation_id = 'room-a' AND user_id = 'therapist-a'");
    await tx.query("INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-other','therapist',true,1)");
  }),{ code:'23P01' });
  assert.equal((await appointmentGet()).therapistId,therapist.userId);
});

test('007 preserves legacy IDs/values, does not invent historical context versions on old records, and re-runs safely',async () => {
  const directory = await mkdtemp(join(tmpdir(),'carebridge-context-migration-'));
  const legacy = await PGlite.create();
  try {
    for (const name of ['001-conversations.sql','002-authentication.sql','003-invitations.sql','004-relationships.sql','005-records.sql','006-activity-feedback.sql'])
      await copyFile(new URL(`../migrations/${name}`,import.meta.url),join(directory,name));
    await migrate(legacy,pathToFileURL(`${directory}/`));
    await legacy.exec(`INSERT INTO cb_centers VALUES ('center-a'); INSERT INTO cb_users(id,active) VALUES ('therapist-a',true);
      INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true); INSERT INTO cb_children VALUES ('center-a','child-a');
      INSERT INTO cb_conversations(center_id,id,child_id,last_sequence) VALUES ('center-a','room-a','child-a',1);
      INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1);
      INSERT INTO cb_goals VALUES ('center-a','room-a','goal-a','기존 목표','기존 설명','paused');
      INSERT INTO cb_appointments VALUES ('center-a','room-a','appointment-a','2026-10-01','10:00',40,'기존 일정','기존 장소','attended');
      BEGIN;
      INSERT INTO cb_records VALUES ('center-a','room-a','record-a','therapist-a',1,1,'appointment-a');
      INSERT INTO cb_record_revisions(center_id,conversation_id,record_id,revision,author_id,goal_id,appointment_id,record_date,status,title,performed,response,next_plan,summary,private_note)
        VALUES ('center-a','room-a','record-a',1,'therapist-a','goal-a','appointment-a','2026-10-01','saved','이전 제목','이전 원문','','','','이전 내부 메모');
      UPDATE cb_record_revisions SET sealed = true; COMMIT;`);
    const before = (await legacy.query('SELECT * FROM cb_record_revisions')).rows;
    assert.deepEqual(await migrate(legacy),['007-care-contexts.sql','008-media-uploads.sql','009-media-bindings.sql','010-profiles.sql','011-center-bootstrap.sql','012-decoder-journal.sql','013-media-preparation-storage.sql','014-media-work-queue.sql','015-media-resource-limits.sql','016-media-work-reviews.sql','017-recovery-quarantine.sql','018-record-drafts.sql','019-account-security-events.sql','020-message-lifecycle.sql','021-password-recovery.sql','022-message-reviews.sql','023-care-recipient-links.sql']);
    assert.deepEqual((await legacy.query('SELECT * FROM cb_record_revisions')).rows,before.map((row) => ({ ...row,goal_revision:null,appointment_revision:null,draft_assessments:null })));
    const old = await new Records(legacy).get(therapist,{ conversationId:'room-a',recordId:'record-a' });
    assert.equal(old.goalSnapshot,null); assert.equal(old.appointmentSnapshot,null);
    assert.equal(old.performed,'이전 원문'); assert.equal(old.goalId,'goal-a');
    const imported = (await legacy.query('SELECT * FROM cb_goal_revisions')).rows[0];
    assert.equal(imported.title,'기존 목표'); assert.equal(imported.author_id,null); assert.equal(imported.changed_at,null);
    assert.equal((await new Appointments(legacy).get(therapist,{ conversationId:'room-a',appointmentId:'appointment-a' })).room,'기존 장소');
    assert.deepEqual(await migrate(legacy),[]);
  } finally {
    await legacy.close();
    assert.ok(directory.startsWith(join(tmpdir(),'carebridge-context-migration-')));
    await rm(directory,{ recursive:true,force:true });
  }
});
