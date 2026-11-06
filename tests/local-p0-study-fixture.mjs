// Test-only preparation for the CURRENT local-api UI, not the src/ A/B
// runner. Seed writes are setup, never participant work or UI-save evidence.
import { randomUUID } from 'node:crypto';
import { createLocalApiSandbox } from '../server/local-api-sandbox.mjs';
import { Children, MemberProfiles } from '../server/profiles.mjs';
import { Relationships } from '../server/relationships.mjs';
import { Goals, Appointments } from '../server/care-contexts.mjs';
import { Records } from '../server/records.mjs';
import { Conversations } from '../server/conversations.mjs';
import { createOwnedCleanupError } from '../server/local-sandbox-cleanup.mjs';

export const LOCAL_P0_BASELINE_COMMIT = '580b873d7cbc71ddf7d1589f50286ed5c11fd3e1';
export const LOCAL_P0_BASELINE_SEED_BLOB = '59c806621e3dfd8e6a0a1eb45ec53df5af758bfd';
export const LOCAL_P0_TASK_C_SUMMARY = '화면 시험용 가상 사례입니다. 하루는 두 가지 가상 놀이 중 하나를 손으로 골랐습니다. 다음 가상 활동 후에는 선택한 놀이와 반응을 이 기록의 답변으로 알려 주세요. 오래 이어가기 어려웠다면 그 점도 남겨 주세요. 실제 활동은 담당 치료사와 정해 주세요.';

const freeze = value => {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return Object.freeze(value);
};
// Reviewed literals from the pinned Git seed, not a mutable src/ import or a
// caller-provided dataset. The companion test compares them with that source.
const baseline = freeze({
  children: [
    { name:'하루', age:5, concern:'놀이터에서 친구들과 더 편하게 어울렸으면 좋겠어요.' },
    { name:'나무', age:7, concern:'아침 준비를 스스로 해 보고 싶어 해요.' },
  ],
  goals: [
    { title:'놀이에 스스로 참여하기', description:'아이와 가족이 즐거워하는 놀이를 찾고, 참여한 상황을 함께 살펴봐요.', status:'active' },
    { title:'일상에서 편안하게 이동하기', description:'가정과 센터에서 관찰한 이동 경험을 모아 다음 목표를 함께 정해요.', status:'active' },
    { title:'아침 준비에 참여하기', description:'가족과 정한 작은 역할부터 시도해요.', status:'active' },
  ],
  records: [
    { title:'놀이 참여 관찰', privateNote:'가상 내부 메모: 다음 회기에서 환경에 따른 참여 차이를 확인.',
      summary:'좋아하는 놀이를 직접 고르고 시작하는 모습을 보였어요. 가정에서의 반응도 함께 알려주세요.',
      nextPlan:'보호자 피드백을 확인하고 다음 놀이를 함께 고르기', assessments:[],
      activity:{ title:'좋아하는 놀이 함께 고르기',
        instruction:'아이가 좋아하는 놀이 두 가지 중 하나를 고르고 함께한 경험을 남겨 주세요.',
        frequency:'편한 시간에 한 번', caution:'이 내용은 화면 체험용 예시입니다. 실제 활동은 담당 치료사와 정해 주세요.' } },
    { title:'일상 이동 관찰', privateNote:'가상 내부 메모: 보호자 확인 전 초안.',
      summary:'센터에서 관찰한 내용을 정리하고 있어요.', nextPlan:'관찰 조건 확인 후 공유 내용 작성',
      assessments:[{ tool:'직접 관찰', item:'놀이 참여 시간', value:6, unit:'분', context:'동일한 놀이 공간 · 가상 관찰값' }], activity:null },
  ],
});
const beforeDay = (day, days) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

export async function createLocalP0StudyFixture(task, options = {}) {
  if (!['A', 'B', 'C'].includes(task)) throw new TypeError('One explicit synthetic study task A, B or C is required.');
  // Forward the original port-only contract without spreading/accessing user
  // options. No caller DB, prior session, hostname or credentials are accepted.
  const sandbox = await createLocalApiSandbox(options);
  try {
    const { database, ids } = sandbox, suffix = randomUUID();
    const therapist = { centerId:ids.centerId, userId:ids.therapistId };
    const guardian = { centerId:ids.centerId, userId:ids.guardianId };
    const manager = { centerId:ids.centerId, userId:ids.managerId };
    const otherGuardian = { centerId:ids.centerId, userId:`p0-other-guardian-${suffix}` };
    const profiles = new Children(database), members = new MemberProfiles(database);
    const relationships = new Relationships(database), goals = new Goals(database);
    const appointments = new Appointments(database), records = new Records(database);
    // The sandbox captured this Seoul day once. Never derive different task
    // dates from later wall-clock reads while preparing the same fixture.
    const originalAppointment = await appointments.get(therapist,
      { conversationId:ids.conversationId, appointmentId:ids.appointmentId });
    const day = originalAppointment.date;
    const rooms = freeze([
      { legacyChildId:'c1', name:'하루', childId:ids.childId, conversationId:ids.conversationId,
        // Goals.list sorts by ID: "local-goal-" must precede "p0-second-".
        goalIds:[ids.goalId, `p0-second-goal-${suffix}`], appointmentId:ids.appointmentId },
      { legacyChildId:'c2', name:'나무', childId:`p0-child-${suffix}`, conversationId:`p0-room-${suffix}`,
        goalIds:[`p0-third-goal-${suffix}`], appointmentId:`p0-appointment-${suffix}` },
    ]);
    // The only fixture SQL bootstraps one synthetic relationship identity; it
    // creates no password/account/session and never grants the trial guardian
    // access to the other child's room. All content uses domain services.
    await database.transaction(async tx => {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [otherGuardian.userId]);
      await tx.query("INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'guardian',true)",
        [ids.centerId, otherGuardian.userId]);
    });
    await members.saveSelf(therapist, { clientId:randomUUID(), expectedRevision:1, displayName:'담당 치료사' });
    await members.saveSelf(guardian, { clientId:randomUUID(), expectedRevision:1, displayName:'하루 보호자' });
    await members.saveSelf(otherGuardian, { clientId:randomUUID(), expectedRevision:0, displayName:'나무 보호자' });
    for (const [index, room] of rooms.entries()) {
      const content = { name:baseline.children[index].name, age:baseline.children[index].age, ageAsOf:day };
      if (index === 0) await profiles.save(manager, { conversationId:room.conversationId,
        clientId:randomUUID(), expectedRevision:1, content });
      else {
        await profiles.register(manager, { childId:room.childId, conversationId:room.conversationId, clientId:randomUUID(), content });
        const initial = await relationships.get(manager, { conversationId:room.conversationId });
        await relationships.replace(manager, { conversationId:room.conversationId, clientId:randomUUID(), expectedVersion:initial.version,
          historyConfirmed:true, therapist:{ userId:therapist.userId, history:'from_now' },
          guardians:[{ userId:otherGuardian.userId, history:'from_now' }] });
      }
      await profiles.saveFamilyPlan(index === 0 ? guardian : otherGuardian, { conversationId:room.conversationId,
        clientId:randomUUID(), expectedRevision:0, concern:baseline.children[index].concern });
      for (const [goalIndex, goalId] of room.goalIds.entries()) await goals.save(therapist, {
        conversationId:room.conversationId, goalId, clientId:randomUUID(), expectedRevision:index === 0 && goalIndex === 0 ? 1 : 0,
        content:baseline.goals[index === 0 ? goalIndex : 2] });
      await appointments.save(therapist, { conversationId:room.conversationId, appointmentId:room.appointmentId,
        clientId:randomUUID(), expectedRevision:index === 0 ? originalAppointment.revision : 0,
        content:{ date:day, time:index === 0 ? '10:00' : '11:00', duration:40, title:'물리치료', room:'1번 치료실', status:'scheduled' } });
    }
    const recordIds = freeze({ r1:`p0-record-one-${suffix}`, r2:`p0-record-two-${suffix}` });
    const summary = task === 'C' ? LOCAL_P0_TASK_C_SUMMARY : baseline.records[0].summary;
    for (const [index, content] of baseline.records.entries()) await records.save(therapist, {
      conversationId:rooms[0].conversationId, recordId:recordIds[index === 0 ? 'r1' : 'r2'], clientId:randomUUID(), expectedRevision:0,
      content:{ ...content, date:beforeDay(day, index === 0 ? 2 : 1), goalId:rooms[0].goalIds[index], status:'saved',
        performed:'', response:'', ...(index === 0 ? { summary } : {}) } });
    const target = { conversationId:rooms[0].conversationId, recordId:recordIds.r1 };
    const preview = await records.preview(therapist, target);
    const published = await records.publish(therapist, { ...target, clientId:randomUUID(), expectedRevision:preview.recordRevision,
      expectedRelationshipsVersion:preview.relationshipsVersion, recipientIds:preview.recipientIds });
    const shared = await new Conversations(database).get(guardian, { conversationId:target.conversationId, messageId:published.messageId });
    const result = { sandbox, task, day, baselineCommit:LOCAL_P0_BASELINE_COMMIT, baselineSeedBlob:LOCAL_P0_BASELINE_SEED_BLOB,
      rooms, records:recordIds, publication:freeze({ messageId:published.messageId, publicationId:shared.publication.id }),
      expected:freeze({ summary, activity:{ ...baseline.records[0].activity },
        counts:{ therapistRooms:2, guardianRooms:1, records:2, publications:1, feedback:0 } }),
      evidence:freeze({ setupOnly:true, uiTaskCompleted:false, humanMetricsCollected:false,
        purpose:task === 'C' ? 'current-app-summary-preparation' : 'current-app-comparison-preparation',
        limitations:[
          'The original sandbox setup greeting is retained; complete conversation histories are not identical.',
          'Only the trial therapist and guardian access scopes match; other-therapist and center workflows are not compared.',
          'Current authenticated API storage differs from legacy browser storage; do not infer design improvement percentages.',
          'Record/calendar dates match the fixed study day; server-generated sharing timestamps are not backdated to legacy sharedAt.',
          'No prepared attachments, human timings, navigation counts, comprehension or physical-device results are collected.',
          'This owned memory-only fixture and temporary quarantine are disposed on close; not a persistent beta session.',
        ] }) };
    // Keep credentials/database non-enumerable on the original sandbox. Never
    // copy them into a serializable wrapper or an observation/result report.
    return Object.freeze(result);
  } catch (error) {
    try { await sandbox.close(); }
    catch (cleanupError) { throw createOwnedCleanupError(error, cleanupError, sandbox.close); }
    throw error;
  }
}
