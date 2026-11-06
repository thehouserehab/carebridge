// Trusted parent bootstrap for a NEW, owned synthetic session only. Never an
// HTTP route, an existing-center importer, or a production startup hook. The
// parent validates/owns the database and disposes the whole fixture on failure;
// the separate service transactions below are not an all-or-nothing migration.
import { randomBytes, randomUUID } from 'node:crypto';
import { Auth } from './auth.mjs';
import { Children, MemberProfiles } from './profiles.mjs';
import { Relationships } from './relationships.mjs';
import { Goals, Appointments } from './care-contexts.mjs';
import { Conversations } from './conversations.mjs';
import { MediaResourcePolicy } from './media-resource-policy.mjs';

// Source + candidate reservations use format ceilings: 120 MiB admits one
// video (100 MiB reserved) and one image (20 MiB). This is a synthetic-session
// ceiling, not a storage plan, scanner approval, or permission to use real data.
export const NATIVE_INTERACTIVE_MEDIA_LIMITS = Object.freeze({
  storageBytes: 120 * 1024 * 1024, pendingUploads: 4,
  uploadsPerWindow: 8, windowMilliseconds: 3600000,
});

export async function seedNativeInteractiveFixture({ owner, runtime } = {}) {
  if (typeof owner?.transaction !== 'function' || typeof runtime?.transaction !== 'function')
    throw new TypeError('Separate bootstrap and runtime database ports are required.');
  const centerId = `interactive-center-${randomUUID()}`, credentials = [];
  const forgetCredentials = () => {
    // Drop retained references, not a claim of zeroing immutable JS strings.
    for (const credential of credentials) { credential.email = ''; credential.password = ''; }
    credentials.length = 0;
  };
  let managerPassword = randomBytes(24).toString('base64url');
  try {
    const created = await new Auth(owner).bootstrapNewCenter({
      operationId: randomUUID(), centerId, confirmNewCenter: centerId,
      email: `interactive.manager.${randomUUID()}@synthetic.test`, password: managerPassword,
    });
    managerPassword = '';
    const manager = Object.freeze({ centerId, userId: created.userId });
    const auth = new Auth(runtime), members = new MemberProfiles(runtime), actors = {};
    for (const role of ['guardian', 'therapist']) {
      const credential = { role, centerId, email: `interactive.${role}.${randomUUID()}@synthetic.test`,
        password: randomBytes(24).toString('base64url') };
      credentials.push(credential);
      let invitation, accepted;
      try {
        invitation = await auth.createInvitation(manager, { centerId, email: credential.email, role });
        accepted = await auth.acceptInvitation({ token: invitation.token, password: credential.password });
        credential.userId = accepted.user.userId;
        // Browser login must use normal authentication, not an acceptance token.
        await auth.logout(accepted.token);
      } finally { invitation = null; accepted = null; }
      const actor = Object.freeze({ centerId, userId: credential.userId });
      actors[role] = actor;
      await members.saveSelf(actor, { clientId: randomUUID(), expectedRevision: 0,
        displayName: role === 'therapist' ? '가상 치료사' : '가상 보호자' });
    }
    const profiles = new Children(runtime), relationships = new Relationships(runtime);
    const goals = new Goals(runtime), appointments = new Appointments(runtime), conversations = new Conversations(runtime);
    // Capture one Seoul calendar day for the complete session, including at a
    // month boundary. Distinct slots avoid the same therapist's overlap guard.
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const rooms = [];
    for (const [index, label] of ['하나', '둘'].entries()) {
      const suffix = randomUUID();
      const room = Object.freeze({ childId: `interactive-child-${suffix}`, conversationId: `interactive-room-${suffix}`,
        goalId: `interactive-goal-${suffix}`, appointmentId: `interactive-appointment-${suffix}` });
      await profiles.register(manager, { childId: room.childId, conversationId: room.conversationId, clientId: randomUUID(),
        content: { name: `가상 아동 ${label}`, age: null, ageAsOf: null } });
      const initial = await relationships.get(manager, { conversationId: room.conversationId });
      await relationships.replace(manager, { conversationId: room.conversationId, clientId: randomUUID(),
        expectedVersion: initial.version, historyConfirmed: true,
        therapist: { userId: actors.therapist.userId, history: 'from_now' },
        guardians: [{ userId: actors.guardian.userId, history: 'from_now' }] });
      await goals.save(actors.therapist, { conversationId: room.conversationId, goalId: room.goalId,
        clientId: randomUUID(), expectedRevision: 0,
        content: { title: index === 0 ? '가상 놀이 선택 관찰' : '가상 순서 기다리기 관찰',
          description: '화면 체험을 위한 가상 목표입니다. 실제 치료 목표나 권고가 아닙니다.', status: 'active' } });
      await appointments.save(actors.therapist, { conversationId: room.conversationId, appointmentId: room.appointmentId,
        clientId: randomUUID(), expectedRevision: 0,
        content: { date, time: index === 0 ? '14:00' : '15:00', duration: 30,
          title: `가상 아동 ${label} 회기`, room: '가상 체험 공간', status: 'scheduled' } });
      await conversations.sendText(actors.therapist, { conversationId: room.conversationId, clientId: randomUUID(),
        body: `가상 아동 ${label}의 체험 대화입니다. 홈의 일정에서 기록을 작성하고, 미리보기로 확인한 내용만 보호자에게 공유해 보세요. 실제 아동 정보·사진·영상은 사용하지 마세요.` });
      rooms.push(room);
    }
    await new MediaResourcePolicy(runtime).configure(manager, {
      expectedRevision: 0, acceptingUploads: true, ...NATIVE_INTERACTIVE_MEDIA_LIMITS,
    });
    // No records, publications, feedback, attachments, or read cursors are
    // seeded: the human must perform those actions through the protected UI.
    const result = { centerId, manager, therapist: actors.therapist, guardian: actors.guardian,
      rooms: Object.freeze(rooms) };
    Object.defineProperties(result, { credentials: { value: credentials }, forgetCredentials: { value: forgetCredentials } });
    return Object.freeze(result);
  } catch (error) { forgetCredentials(); throw error; }
  finally { managerPassword = ''; }
}
