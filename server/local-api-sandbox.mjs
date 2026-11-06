import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from './auth.mjs';
import { AccountDelivery } from './account-delivery.mjs';
import { LocalInvitationMailbox } from './local-invitation-mailbox.mjs';
import { LocalRecoveryMailbox } from './local-recovery-mailbox.mjs';
import { LocalPasswordRecovery } from './local-password-recovery.mjs';
import { LocalEmailLogin, LocalEmailMailbox } from './local-email-login.mjs';
import { Conversations } from './conversations.mjs';
import { Children, MemberProfiles } from './profiles.mjs';
import { Relationships } from './relationships.mjs';
import { CareRecipientLinks } from './care-recipient-links.mjs';
import { PrimaryCommunicators } from './primary-communicators.mjs';
import { Records } from './records.mjs';
import { ActivityFeedback } from './activity-feedback.mjs';
import { Goals, Appointments } from './care-contexts.mjs';
import { migrate } from './migrate.mjs';
import { createLocalApiListener } from './local-api-listener.mjs';
import { createLocalSyntheticMedia } from './local-synthetic-media.mjs';
import { createOwnedCleanupError } from './local-sandbox-cleanup.mjs';

function sandboxPort(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some((key) => key !== 'port')) {
    throw new TypeError('Only a numeric local port may be configured.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'port');
  const port = descriptor ? descriptor.value : 0;
  if ((descriptor && !Object.hasOwn(descriptor, 'value')) ||
      !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
    // Exclude privileged/default HTTP ports; the exact-origin adapter requires
    // an explicit non-default port, while 0 asks the OS for an ephemeral one.
    throw new TypeError('Local port must be 0 or an integer from 1024 to 65535.');
  }
  return port;
}

async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local sandbox shutdown timed out.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function seed(database, ids) {
  await database.transaction(async (tx) => {
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [ids.centerId]);
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true),($2,true),($3,true)', [ids.therapistId, ids.guardianId, ids.managerId]);
    await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active)
      VALUES ($1,$2,'therapist',true),($1,$3,'guardian',true),($1,$4,'center',true)`, [ids.centerId, ids.therapistId, ids.guardianId, ids.managerId]);
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, ids.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',
      [ids.centerId, ids.conversationId, ids.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`,
    [ids.centerId, ids.conversationId, ids.therapistId, ids.guardianId]);
    await tx.query(`INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision)
      VALUES ($1,$2,'가상 치료사',1),($1,$3,'가상 보호자',1)`, [ids.centerId, ids.therapistId, ids.guardianId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 아동',NULL,NULL,1,$3)`, [ids.centerId, ids.childId, ids.therapistId]);
  });
}

/** Synthetic-only HTTP: memory DB and a factory-owned temporary quarantine; no mail or worker. */
export async function createLocalApiSandbox(options = {}) {
  const port = sandboxPort(options);
  const database = await PGlite.create(); // No path/options: memory-only, never DATABASE_URL.
  const credentials = [];
  const invitations = new LocalInvitationMailbox();
  const recoveryMailbox = new LocalRecoveryMailbox();
  const emailMailbox = new LocalEmailMailbox();
  let listener;
  let passwordRecovery;
  let emailLogin;
  let media;
  let closePromise;
  let databaseClosing;
  const close = () => {
    if (closePromise) return closePromise;
    // Drop this factory's references; this is not a claim of secure RAM zeroization.
    for (const account of credentials) { account.password = ''; account.email = ''; }
    credentials.length = 0;
    invitations.close();
    recoveryMailbox.close();
    emailMailbox.close();
    closePromise = (async () => {
      // A deadline failure is NOT proof that handlers stopped using the DB or
      // files. Retain both on failure instead of racing destructive cleanup.
      await listener?.close();
      // Detached admission must drain its actual job before releasing the DB.
      // Closing the memory mailbox prevents any late link from being retained.
      await passwordRecovery?.close();
      await emailLogin?.close();
      await media?.close();
      if (!databaseClosing && !database.closed) {
        const operation = Promise.resolve().then(() => database.close());
        databaseClosing = operation;
        void operation.catch(() => { if (databaseClosing === operation) databaseClosing = undefined; });
      }
      // A deadline does not cancel PGlite.close(). Retain that exact pending
      // operation across retries instead of starting another close around it.
      if (databaseClosing) await within(databaseClosing, 5000);
      if (database.closed !== true) throw new Error('Local sandbox shutdown is not confirmed.');
    })();
    void closePromise.catch(() => { closePromise = undefined; });
    return closePromise;
  };

  try {
    await migrate(database);
    // This factory owns a newly created memory-only PGlite. The proposal is
    // deliberately not a numbered migration and never applied by the E runner.
    await database.exec(await readFile(new URL('./schema-proposals/email-login.sql', import.meta.url), 'utf8'));
    const suffix = randomUUID();
    const ids = Object.freeze({
      centerId: `local-center-${suffix}`, childId: `local-child-${suffix}`,
      conversationId: `local-room-${suffix}`, therapistId: `local-therapist-${suffix}`,
      guardianId: `local-guardian-${suffix}`, managerId: `local-manager-${suffix}`,
      goalId: `local-goal-${suffix}`, appointmentId: `local-appointment-${suffix}`,
    });
    await seed(database, ids);
    media = await createLocalSyntheticMedia(database, ids.centerId);
    const auth = new Auth(database); // Production-default scrypt cost; no test-password shortcut.
    emailLogin = new LocalEmailLogin({ auth, key: randomBytes(32), mailbox: emailMailbox });
    const accountDelivery = new AccountDelivery({ auth, origin: 'https://carebridge.test', transport: invitations });
    passwordRecovery = new LocalPasswordRecovery({ accountDelivery:
      new AccountDelivery({ auth, origin: 'https://carebridge.test', transport: recoveryMailbox }) });
    const conversations = new Conversations(database);
    const profiles = new Children(database);
    const records = new Records(database), feedback = new ActivityFeedback(database);
    const goals = new Goals(database), appointments = new Appointments(database);
    const therapist = { centerId: ids.centerId, userId: ids.therapistId };
    await goals.save(therapist, { conversationId: ids.conversationId, goalId: ids.goalId,
      clientId: randomUUID(), expectedRevision: 0,
      content: { title: '가상 놀이 참여 관찰', description: '연결 시험을 위한 가상 목표입니다. 실제 치료 목표가 아닙니다.', status: 'active' } });
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    await appointments.save(therapist, { conversationId: ids.conversationId, appointmentId: ids.appointmentId,
      clientId: randomUUID(), expectedRevision: 0,
      content: { date, time: '14:00', duration: 30, title: '가상 회기', room: '가상 공간', status: 'scheduled' } });
    for (const role of ['therapist', 'guardian', 'center']) {
      const credential = { role, email: `${role}.${suffix}@carebridge.test`, password: randomBytes(24).toString('base64url') };
      credentials.push(credential);
      await auth.provisionAccount({ userId: role === 'center' ? ids.managerId : ids[`${role}Id`], email: credential.email, password: credential.password });
    }
    await conversations.sendText({ centerId: ids.centerId, userId: ids.therapistId }, {
      conversationId: ids.conversationId, clientId: randomUUID(),
      body: '가상 자료로 연결을 확인하는 대화입니다. 실제 아동 정보는 입력하지 마세요.',
    });
    listener = await createLocalApiListener({ port, services: { auth, accountDelivery, passwordRecovery, emailLogin, conversations, profiles, records, feedback, goals, appointments,
      memberProfiles: new MemberProfiles(database), relationships: new Relationships(database),
      careRecipientLinks: new CareRecipientLinks(database), primaryCommunicators: new PrimaryCommunicators(database),
      mediaUploads: media.mediaUploads, mediaCleanup: media.mediaCleanup } });
    const sandbox = { origin: listener.origin, ids, close };
    Object.defineProperties(sandbox, {
      credentials: { value: credentials },
      database: { value: database },
      mediaRoot: { value: media.root },
      // Trusted fixture capability, never an HTTP mailbox or center-user response.
      takeInvitation: { value: email => invitations.take(email, listener.origin) },
      takeEmailLogin: { value: async email => { await emailLogin.idle(); return emailMailbox.take(email); } },
      takeRecovery: { value: async email => {
        await passwordRecovery.idle();
        return recoveryMailbox.take(email, listener.origin);
      } },
    });
    return Object.freeze(sandbox);
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw createOwnedCleanupError(error, cleanupError, close); }
    throw error;
  }
}
