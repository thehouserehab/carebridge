import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Auth } from '../auth.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Conversations } from '../conversations.mjs';
import { Records } from '../records.mjs';
import { MediaResourcePolicy } from '../media-resource-policy.mjs';
import { seedNativeApiTestFixture } from '../native-api-seed-testfixture.mjs';
import { seedNativeInteractiveFixture, NATIVE_INTERACTIVE_MEDIA_LIMITS } from '../native-interactive-seed.mjs';

// Real migrations and domain services, memory-only PGlite. No E drive, HTTP,
// browser, worker, file writes or native PostgreSQL role enforcement evidence.
let db, original, baseline, fixtures, ownerCalls = 0, dayBefore, dayAfter;
const day = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const port = () => ({ transaction: (work) => db.transaction(work) });
async function originalSnapshot() {
  const result = {};
  for (const table of ['cb_centers', 'cb_memberships', 'cb_children', 'cb_conversations', 'cb_child_profiles',
    'cb_participants', 'cb_media_resource_limits', 'cb_auth_invitations', 'cb_center_bootstraps']) {
    const column = table === 'cb_centers' ? 'id' : 'center_id';
    result[table] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${column}=$1 ORDER BY to_jsonb(t)::text`, [original.centerId])).rows;
  }
  const ids = [original.manager.userId, original.guardian.userId, original.therapist.userId];
  for (const table of ['cb_users', 'cb_auth_accounts', 'cb_auth_sessions']) {
    const column = table === 'cb_users' ? 'id' : 'user_id';
    result[table] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${column}=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [ids])).rows;
  }
  return result;
}
before(async () => {
  db = await PGlite.create(); fixtures = [];
  await migrate(db);
  original = await seedNativeApiTestFixture({ owner: port(), runtime: port() });
  baseline = await originalSnapshot(); dayBefore = day();
  for (let i = 0; i < 2; i++) fixtures.push(await seedNativeInteractiveFixture({
    owner: { transaction: (work) => { ownerCalls++; return db.transaction(work); } }, runtime: port(),
  }));
  dayAfter = day();
});
after(async () => {
  original?.forgetCredentials(); for (const fixture of fixtures ?? []) fixture.forgetCredentials();
  await db?.close();
});

test('requires both database ports before performing bootstrap', async () => {
  let touched = false;
  const owner = { transaction: () => { touched = true; throw new Error('must not bootstrap'); } };
  for (const input of [undefined, {}, { owner }, { owner, runtime: {} }])
    await assert.rejects(seedNativeInteractiveFixture(input), TypeError);
  assert.equal(touched, false);
});

test('fresh accounts stay random, private in serialization, and use normal login with no seeded active sessions', async () => {
  const emails = [], passwords = [], auth = new Auth(db);
  assert.equal(ownerCalls, 2, 'owner port is used only for one bootstrap per center');
  for (const fixture of fixtures) {
    assert.deepEqual(Object.keys(fixture), ['centerId', 'manager', 'therapist', 'guardian', 'rooms']);
    assert(Object.isFrozen(fixture) && Object.isFrozen(fixture.rooms) && fixture.rooms.every(Object.isFrozen));
    assert.equal(Object.getOwnPropertyDescriptor(fixture, 'credentials').enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(fixture, 'forgetCredentials').enumerable, false);
    assert.equal(fixture.credentials.length, 2);
    const userIds = [fixture.manager.userId, fixture.therapist.userId, fixture.guardian.userId];
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_auth_sessions WHERE user_id=ANY($1::text[]) AND revoked_at IS NULL', [userIds])).rows[0].n, 0);
    for (const credential of fixture.credentials) {
      assert.match(credential.email, /^interactive\.(guardian|therapist)\.[a-f0-9-]+@synthetic\.test$/);
      assert.equal(credential.password.length, 32); assert.equal(credential.centerId, fixture.centerId);
      assert.equal(credential.userId, fixture[credential.role].userId);
      assert(!JSON.stringify(fixture).includes(credential.email)); assert(!JSON.stringify(fixture).includes(credential.password));
      emails.push(credential.email); passwords.push(credential.password);
      const session = await auth.login({ email: credential.email, password: credential.password });
      assert.equal(session.user.userId, credential.userId);
      assert.deepEqual(session.user.centers, [{ id: fixture.centerId, role: credential.role }]);
      await auth.logout(session.token);
    }
  }
  assert.equal(new Set(emails).size, 4); assert.equal(new Set(passwords).size, 4);
});

test('both roles can read two distinct child contexts, active goals and nonoverlapping current-day appointments', async () => {
  const profiles = new Children(db), members = new MemberProfiles(db), goals = new Goals(db), appointments = new Appointments(db);
  for (const fixture of fixtures) {
    assert.equal(fixture.rooms.length, 2);
    for (const field of ['childId', 'conversationId', 'goalId', 'appointmentId'])
      assert.equal(new Set(fixture.rooms.map((room) => room[field])).size, 2);
    const dates = [];
    for (const role of ['therapist', 'guardian']) {
      const actor = fixture[role];
      assert.equal((await members.getSelf(actor)).displayName, role === 'therapist' ? '가상 치료사' : '가상 보호자');
      assert.equal((await profiles.list(actor)).children.length, 2);
      for (const [index, room] of fixture.rooms.entries()) {
        const p = await profiles.get(actor, { conversationId: room.conversationId });
        assert.equal(p.childId, room.childId); assert.equal(p.name, index === 0 ? '가상 아동 하나' : '가상 아동 둘');
        assert.equal(p.age, null); assert.equal(p.ageAsOf, null);
        assert.deepEqual(p.participants.map((member) => member.role), ['guardian', 'therapist']);
        const goal = await goals.get(actor, { conversationId: room.conversationId, goalId: room.goalId });
        assert.equal(goal.status, 'active'); assert.equal(goal.revision, 1); assert.match(goal.title, /^가상 /);
        const appointment = await appointments.get(actor, { conversationId: room.conversationId, appointmentId: room.appointmentId });
        assert.equal(appointment.revision, 1); assert.equal(appointment.status, 'scheduled');
        assert.equal(appointment.time, index === 0 ? '14:00' : '15:00'); assert.equal(appointment.duration, 30);
        assert.equal(appointment.therapistId, fixture.therapist.userId);
        assert([dayBefore, dayAfter].includes(appointment.date)); dates.push(appointment.date);
      }
    }
    assert.equal(new Set(dates).size, 1, 'one captured Seoul date per fixture');
  }
});

test('small media limits use the administrative service without changing interactive roles or approving files', async () => {
  for (const fixture of fixtures) {
    const policy = await new MediaResourcePolicy(db).get(fixture.manager);
    assert.equal(policy.configured, true); assert.equal(policy.revision, 1); assert.equal(policy.acceptingUploads, true);
    assert.deepEqual(policy.limits, NATIVE_INTERACTIVE_MEDIA_LIMITS);
    assert.deepEqual(policy.usage, { reservedBytes: 0, pendingUploads: 0 });
    assert.deepEqual((await db.query('SELECT role FROM cb_memberships WHERE center_id=$1 ORDER BY role', [fixture.centerId])).rows.map((r) => r.role), ['center', 'guardian', 'therapist']);
    for (const table of ['cb_media_uploads', 'cb_media_preparations'])
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE center_id=$1`, [fixture.centerId])).rows[0].n, 0);
  }
});

test('welcome messages are readable but records, publications, feedback and read cursors remain human actions', async () => {
  const conversations = new Conversations(db);
  for (const fixture of fixtures) {
    for (const room of fixture.rooms) {
      for (const role of ['therapist', 'guardian']) {
        const result = await conversations.list(fixture[role], { conversationId: room.conversationId });
        assert.equal(result.messages.length, 1); assert.equal(result.messages[0].type, 'text');
        assert.equal(result.messages[0].authorId, fixture.therapist.userId);
        assert.match(result.messages[0].body, /실제 아동 정보·사진·영상은 사용하지 마세요/);
      }
    }
    for (const table of ['cb_records', 'cb_publications', 'cb_activity_feedback', 'cb_read_states'])
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE center_id=$1`, [fixture.centerId])).rows[0].n, 0);
  }
});

test('existing native fixture and other synthetic centers are not adopted or granted access', async () => {
  assert.deepEqual(await originalSnapshot(), baseline);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_centers')).rows[0].n, 3);
  const profiles = new Children(db);
  for (const [first, second] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]]) {
    await assert.rejects(profiles.get(first.guardian, { conversationId: second.rooms[0].conversationId }), { code: 'NOT_FOUND' });
    await assert.rejects(profiles.get(original.guardian, { conversationId: first.rooms[0].conversationId }), { code: 'NOT_FOUND' });
  }
});

test('seeded contexts support a later explicit record save, preview and recipient-confirmed publication', async () => {
  const fixture = fixtures[0], room = fixture.rooms[0], records = new Records(db), recordId = randomUUID();
  const saved = await records.save(fixture.therapist, { conversationId: room.conversationId, recordId,
    clientId: randomUUID(), expectedRevision: 0, expectedGoalRevision: 1, expectedAppointmentRevision: 1,
    content: { date: dayBefore, goalId: room.goalId, appointmentId: room.appointmentId, title: '가상 직접 작성 기록',
      status: 'saved', performed: '가상 놀이 선택', response: '가상 반응 관찰', nextPlan: '가상 다음 계획',
      privateNote: '가상 비공개 임상 참고', summary: '가상 보호자 공유 요약',
      activity: { title: '가상 활동', instruction: '화면 체험용 가상 내용입니다.', frequency: '가상 한 번', caution: '실제 활동 권고 아님' } } });
  const preview = await records.preview(fixture.therapist, { conversationId: room.conversationId, recordId });
  assert.deepEqual(preview.recipientIds, [fixture.guardian.userId]); assert.equal(preview.recordRevision, saved.revision);
  assert(!JSON.stringify(preview).includes('가상 비공개 임상 참고'));
  const receipt = await records.publish(fixture.therapist, { conversationId: room.conversationId, recordId,
    clientId: randomUUID(), expectedRevision: saved.revision, expectedRelationshipsVersion: preview.relationshipsVersion,
    recipientIds: preview.recipientIds });
  assert.equal(typeof receipt.messageId, 'string');
  const publicMessages = await new Conversations(db).list(fixture.guardian, { conversationId: room.conversationId });
  assert(publicMessages.messages.some((m) => m.id === receipt.messageId && m.type === 'publication'));
  assert(!JSON.stringify(publicMessages).includes('가상 비공개 임상 참고'));
  await assert.rejects(records.get(fixture.guardian, { conversationId: room.conversationId, recordId }), { code: 'FORBIDDEN' });
});

test('forgetCredentials clears retained credential objects idempotently without altering persisted memberships', async () => {
  const fixture = fixtures[1], retained = [...fixture.credentials], other = fixtures[0].credentials[0];
  fixture.forgetCredentials(); fixture.forgetCredentials();
  assert.equal(fixture.credentials.length, 0); assert(retained.every((value) => value.email === '' && value.password === ''));
  assert(other.email.endsWith('.test') && other.password.length === 32);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_memberships WHERE center_id=$1 AND active', [fixture.centerId])).rows[0].n, 3);
});
