import { randomUUID } from 'node:crypto';
import { createLocalApiSandbox } from '../server/local-api-sandbox.mjs';
import { Goals, Appointments } from '../server/care-contexts.mjs';
import { Conversations } from '../server/conversations.mjs';
import { Children, MemberProfiles } from '../server/profiles.mjs';

const EXTRA_MESSAGES_PER_ROOM = 44;
const childNames = Object.freeze([
  '가상 첫째 아동 이름이 긴 화면 줄바꿈 확인용',
  '가상둘째아동이름이길고공백없는화면줄바꿈확인용',
]);

// Test-only composition: the original sandbox owns its memory DB, loopback
// listener, credentials and temporary quarantine. This module adds no worker,
// durable storage, environment option, remote request or alternate auth path.
// All seed writes below are fixture setup, not evidence of successful UI writes.
export async function createFrontendMultiroomFixture(options = {}) {
  // Reuse the original closed port-only contract (default 0); do not spread or
  // read options here, which could invoke accessors or discard forbidden keys.
  const sandbox = await createLocalApiSandbox(options);
  try {
    const { database, ids } = sandbox;
    const suffix = randomUUID();
    const rooms = Object.freeze([
      Object.freeze({ key: 'first', childId: ids.childId, conversationId: ids.conversationId,
        goalId: ids.goalId, appointmentId: ids.appointmentId, name: childNames[0] }),
      Object.freeze({ key: 'second', childId: `frontend-child-${suffix}`, conversationId: `frontend-room-${suffix}`,
        goalId: `frontend-goal-${suffix}`, appointmentId: `frontend-appointment-${suffix}`, name: childNames[1] }),
    ]);
    const extra = rooms[1];
    // Only the relationship bootstrap uses SQL. Public-facing profile, goal,
    // appointment and message content goes through the existing domain rules.
    await database.transaction(async (tx) => {
      await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
      await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',
        [ids.centerId, extra.conversationId, extra.childId]);
      await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
        VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`,
      [ids.centerId, extra.conversationId, ids.therapistId, ids.guardianId]);
    });
    const therapist = { centerId: ids.centerId, userId: ids.therapistId };
    const guardian = { centerId: ids.centerId, userId: ids.guardianId };
    const manager = { centerId: ids.centerId, userId: ids.managerId };
    const profiles = new Children(database), members = new MemberProfiles(database);
    const goals = new Goals(database), appointments = new Appointments(database), conversations = new Conversations(database);
    // Anchor both sessions to the sandbox's own date, including a run crossing
    // Korean midnight. Distinct hours avoid the same therapist's overlap rule.
    const originalAppointment = await appointments.get(therapist, {
      conversationId: ids.conversationId, appointmentId: ids.appointmentId,
    });
    await members.saveSelf(therapist, { clientId: randomUUID(), expectedRevision: 1,
      displayName: '가상 치료사 긴 표시 이름 화면 확인용' });
    await members.saveSelf(guardian, { clientId: randomUUID(), expectedRevision: 1,
      displayName: '가상보호자긴표시이름공백없는화면확인용' });
    for (const [index, room] of rooms.entries()) {
      const label = index === 0 ? '첫째' : '둘째';
      await profiles.save(manager, { conversationId: room.conversationId, clientId: randomUUID(),
        expectedRevision: index === 0 ? 1 : 0, content: { name: room.name, age: null, ageAsOf: null } });
      await goals.save(therapist, { conversationId: room.conversationId, goalId: room.goalId,
        clientId: randomUUID(), expectedRevision: index === 0 ? 1 : 0,
        content: { title: `가상 ${label} 아동의 긴 목표 제목 · 일상 놀이 참여와 보호자 소통 화면 확인`,
          description: `가상 ${label} 대화의 화면 구분을 위한 목표입니다. 실제 평가나 치료 계획이 아닙니다.`, status: 'active' } });
      await appointments.save(therapist, { conversationId: room.conversationId, appointmentId: room.appointmentId,
        clientId: randomUUID(), expectedRevision: index === 0 ? originalAppointment.revision : 0,
        content: { date: originalAppointment.date, time: index === 0 ? '14:00' : '15:00', duration: 30,
          title: `가상 ${label} 회기 · 길게 표시되는 일정 이름과 기록 바로가기 화면 확인`,
          room: `가상 ${label} 놀이 공간`, status: 'scheduled' } });
      for (let number = 1; number <= EXTRA_MESSAGES_PER_ROOM; number++) {
        const detail = number % 5 === 0
          ? `\n가상긴문장공백없는줄바꿈확인${'합성화면검증'.repeat(12)}\n위아래 대화를 읽다가 다른 아동을 선택한 뒤 돌아오는 화면 시험입니다.`
          : '\n사진·영상은 첨부하지 않은 합성 대화입니다. 실제 아동 정보나 치료 결과가 아닙니다.';
        await conversations.sendText(number % 2 === 1 ? therapist : guardian, {
          conversationId: room.conversationId, clientId: randomUUID(),
          body: `가상 ${label} 대화 ${String(number).padStart(2, '0')} · 목록 이동과 스크롤 위치 확인${detail}`,
        });
      }
    }
    // Preserve the exact original capability object and close function. Do not
    // copy its non-enumerable credentials/database into an enumerable wrapper.
    return Object.freeze({ sandbox, rooms });
  } catch (error) {
    try { await sandbox.close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Synthetic frontend fixture setup and cleanup failed.');
    }
    throw error;
  }
}
