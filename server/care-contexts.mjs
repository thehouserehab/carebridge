import { createHash } from 'node:crypto';
import { goalFields, appointmentFields, contextDate } from '../src/context-fields.js';
import { Conversations } from './conversations.mjs';
import { lockCenterSchedule, scheduleError } from './schedule-gate.mjs';
import { fail } from './errors.mjs';
import { requireSharedCareAccess } from './conversation-visibility.mjs';

const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const version = (value, minimum = 0, maximum = 2147483647) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_INPUT');
  return value;
};
const requestId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value) => value == null ? null : new Date(value).toISOString();
const appointmentTextLimits = { title: 100, room: 60 };
function content(kind, input) {
  keys(input, kind === 'goal' ? ['title','description','status'] : ['date','time','duration','title','room','status']);
  for (const [key, maximum] of Object.entries(kind === 'appointment' ? appointmentTextLimits : {}))
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > maximum)) fail('INVALID_INPUT');
  try { return kind === 'goal' ? goalFields(input) : appointmentFields(input); }
  catch { fail('INVALID_INPUT'); }
}
function project(kind, row, scope) {
  const common = { id: row.id, conversationId: row.conversation_id ?? scope.roomId, childId: row.child_id ?? scope.childId,
    revision: row.current_revision, title: row.title, status: row.status, updatedAt: iso(row.updated_at) };
  return kind === 'goal' ? { ...common, description: row.description }
    : { ...common, date: row.date, time: row.time, duration: row.duration, room: row.room, therapistId: row.therapist_id ?? null };
}
const receipt = (row, replayed) => ({ kind: row.kind, id: row.goal_id ?? row.appointment_id,
  revision: row.revision, changed: row.changed, replayed });
async function duplicate(tx, scope, clientId, requestHash) {
  const { rows } = await tx.query(`SELECT conversation_id,request_hash,kind,goal_id,appointment_id,revision,changed
    FROM cb_context_requests WHERE center_id = $1 AND actor_id = $2 AND client_id = $3`, [scope.centerId,scope.userId,clientId]);
  if (!rows.length) return null;
  if (rows[0].conversation_id !== scope.roomId || rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
  return receipt(rows[0],true);
}
async function remember(tx, scope, clientId, requestHash, kind, targetId, revision, changed) {
  await tx.query(`INSERT INTO cb_context_requests
    (center_id,conversation_id,actor_id,client_id,request_hash,kind,goal_id,appointment_id,revision,changed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [scope.centerId,scope.roomId,scope.userId,clientId,requestHash,kind,
    kind === 'goal' ? targetId : null,kind === 'appointment' ? targetId : null,revision,changed]);
  return { kind,id:targetId,revision,changed,replayed:false };
}
async function sequence(tx, scope) {
  const { rows } = await tx.query(`UPDATE cb_conversations SET last_sequence = last_sequence + 1,revision = revision + 1
    WHERE center_id = $1 AND id = $2 RETURNING last_sequence`, [scope.centerId,scope.roomId]);
  return Number(rows[0].last_sequence);
}
function contextError(error) {
  if (error.code === '23505' && error.constraint === 'cb_context_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
  scheduleError(error);
}
const changed = (old, data) => !old || Object.entries(data).some(([key,value]) => old[key] !== value);

// Current shared goals are visible to current clinical participants; their
// previous revisions are private to therapists with the relevant history grant.
export class Goals {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('Goals requires a transactional database.');
    this.conversations = new Conversations(database);
  }
  inRoom(actor, roomId, work) {
    return this.conversations.inRoom(actor,roomId,(tx,scope) => {
      requireSharedCareAccess(scope);
      return work(tx,scope);
    }).catch(contextError);
  }

  async save(actor, input) {
    keys(input,['conversationId','goalId','clientId','expectedRevision','content']);
    const goalId = id(input.goalId), clientId = requestId(input.clientId), expected = version(input.expectedRevision);
    const data = content('goal',input.content), requestHash = hash({ kind:'goal',goalId,expected,data });
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const prior = await duplicate(tx,scope,clientId,requestHash);
      if (prior) return prior;
      const { rows } = await tx.query(`SELECT current_revision,title,description,status FROM cb_goals
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId,scope.roomId,goalId]);
      const old = rows[0];
      if ((old?.current_revision ?? 0) !== expected) fail('GOAL_CONFLICT');
      const hasChanges = changed(old,data);
      const revision = hasChanges ? expected + 1 : expected;
      if (revision > 2147483647) fail('REVISION_LIMIT');
      if (hasChanges) {
        const changeSequence = await sequence(tx,scope);
        if (!old) await tx.query(`INSERT INTO cb_goals
          (center_id,conversation_id,id,title,description,status,current_revision,updated_by,updated_at,changed_sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),$9)`,
        [scope.centerId,scope.roomId,goalId,data.title,data.description,data.status,revision,scope.userId,changeSequence]);
        else await tx.query(`UPDATE cb_goals SET title = $4,description = $5,status = $6,current_revision = $7,
          updated_by = $8,updated_at = clock_timestamp(),changed_sequence = $9
          WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,
        [scope.centerId,scope.roomId,goalId,data.title,data.description,data.status,revision,scope.userId,changeSequence]);
      }
      return remember(tx,scope,clientId,requestHash,'goal',goalId,revision,hasChanges);
    });
  }

  async get(actor, input) {
    keys(input,['conversationId','goalId','revision']);
    const goalId = id(input.goalId);
    if (input.revision !== undefined) version(input.revision,1);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      let rows;
      if (input.revision === undefined) ({ rows } = await tx.query(`SELECT id,current_revision,title,description,status,updated_at FROM cb_goals
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId,scope.roomId,goalId]));
      else {
        if (scope.role !== 'therapist') fail('FORBIDDEN');
        ({ rows } = await tx.query(`SELECT goal_id AS id,revision AS current_revision,title,description,status,changed_at AS updated_at
          FROM cb_goal_revisions WHERE center_id = $1 AND conversation_id = $2 AND goal_id = $3 AND revision = $4
            AND (change_sequence >= $5 OR (change_sequence IS NULL AND $5 = 1))`,
        [scope.centerId,scope.roomId,goalId,input.revision,scope.firstSequence]));
      }
      if (!rows.length) fail('NOT_FOUND');
      return project('goal',rows[0],scope);
    });
  }

  async list(actor, input) {
    keys(input,['conversationId','after','limit','expectedRevision']);
    const after = input.after == null ? '' : id(input.after), limit = version(input.limit ?? 50,1,100);
    if (input.expectedRevision !== undefined) version(input.expectedRevision,0,Number.MAX_SAFE_INTEGER);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== scope.revision) return { revision:scope.revision,resetRequired:true };
      const { rows } = await tx.query(`SELECT id,current_revision,title,description,status,updated_at FROM cb_goals
        WHERE center_id = $1 AND conversation_id = $2 AND id > $3 ORDER BY id LIMIT $4`, [scope.centerId,scope.roomId,after,limit + 1]);
      const selected = rows.slice(0,limit);
      return { goals:selected.map((row) => project('goal',row,scope)),revision:scope.revision,resetRequired:false,
        nextCursor:selected.at(-1)?.id ?? null,hasMore:rows.length > limit };
    });
  }
}

const appointmentSelect = `SELECT a.id,a.conversation_id,c.child_id,a.current_revision,a.date::text AS date,
  to_char(a.time,'HH24:MI') AS time,a.duration,a.title,a.room,a.status,a.updated_at,
  (SELECT p.user_id FROM cb_participants p JOIN cb_memberships cm
    ON (cm.center_id,cm.user_id,cm.role) = (p.center_id,p.user_id,p.role) JOIN cb_users u ON u.id = p.user_id
    WHERE p.center_id = a.center_id AND p.conversation_id = a.conversation_id AND p.role = 'therapist'
      AND p.active AND cm.active AND u.active) AS therapist_id
  FROM cb_appointments a JOIN cb_conversations c ON (c.center_id,c.id) = (a.center_id,a.conversation_id)`;

// Operational schedule access never joins clinical goals, records, messages or
// review notes. Center managers may maintain schedules without clinical access.
export class Appointments {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('Appointments requires a transactional database.');
    this.database = database;
  }
  async inScope(actor, roomId, work, { clinicalOnly = false, operationalOnly = false } = {}) {
    if (typeof clinicalOnly !== 'boolean' || typeof operationalOnly !== 'boolean' || (clinicalOnly && operationalOnly))
      throw new TypeError('Invalid appointment scope.');
    const centerId = id(actor?.centerId), userId = id(actor?.userId);
    if (roomId !== null) id(roomId);
    return this.database.transaction(async (tx) => {
      const scheduleVersion = await lockCenterSchedule(tx,centerId);
      let childId = null;
      if (roomId !== null) {
        const { rows } = await tx.query(`SELECT c.child_id FROM cb_conversations c
          WHERE c.center_id = $1 AND c.id = $2 AND EXISTS (
            SELECT 1 FROM cb_memberships cm JOIN cb_users u ON u.id = cm.user_id
            WHERE cm.center_id = c.center_id AND cm.user_id = $3 AND cm.active AND u.active AND
              (cm.role = 'center' OR EXISTS (SELECT 1 FROM cb_participants p
                WHERE (p.center_id,p.conversation_id,p.user_id,p.role) = (c.center_id,c.id,cm.user_id,cm.role) AND p.active)))
          FOR UPDATE OF c`, [centerId,roomId,userId]);
        if (!rows.length) fail('NOT_FOUND');
        childId = rows[0].child_id;
      }
      const { rows: members } = await tx.query(`SELECT cm.role FROM cb_memberships cm JOIN cb_users u ON u.id = cm.user_id
        WHERE cm.center_id = $1 AND cm.user_id = $2 AND cm.active AND u.active FOR SHARE OF cm,u`, [centerId,userId]);
      if (!members.length) fail('NOT_FOUND');
      const role = members[0].role;
      if (!['center','therapist','guardian'].includes(role)) fail('NOT_FOUND');
      // Each local namespace is narrower than the shared domain service.
      // Recheck under the same membership lock, not an earlier HTTP identity.
      if (clinicalOnly && !['therapist', 'guardian'].includes(role)) fail('NOT_FOUND');
      if (operationalOnly && role !== 'center') fail('NOT_FOUND');
      let firstSequence = 1;
      if (roomId !== null && role !== 'center') {
        const { rows } = await tx.query(`SELECT first_sequence FROM cb_participants
          WHERE center_id = $1 AND conversation_id = $2 AND user_id = $3 AND role = $4 AND active FOR SHARE`,
        [centerId,roomId,userId,role]);
        if (!rows.length) fail('NOT_FOUND');
        firstSequence = Number(rows[0].first_sequence);
      }
      return work(tx,{ centerId,userId,roomId,childId,role,firstSequence,scheduleVersion });
    }).catch(contextError);
  }

  async save(actor, input, options = {}) {
    keys(input,['conversationId','appointmentId','clientId','expectedRevision','content']);
    const roomId = id(input.conversationId), appointmentId = id(input.appointmentId), clientId = requestId(input.clientId);
    const expected = version(input.expectedRevision), data = content('appointment',input.content);
    const requestHash = hash({ kind:'appointment',appointmentId,expected,data });
    return this.inScope(actor,roomId,async (tx,scope) => {
      if (!['center','therapist'].includes(scope.role)) fail('FORBIDDEN');
      const prior = await duplicate(tx,scope,clientId,requestHash);
      if (prior) return prior;
      const { rows } = await tx.query(`${appointmentSelect} WHERE a.center_id = $1 AND a.conversation_id = $2 AND a.id = $3`,
        [scope.centerId,scope.roomId,appointmentId]);
      const old = rows[0];
      if ((old?.current_revision ?? 0) !== expected) fail('APPOINTMENT_CONFLICT');
      const hasChanges = changed(old,data), revision = hasChanges ? expected + 1 : expected;
      if (revision > 2147483647) fail('REVISION_LIMIT');
      if (hasChanges) {
        if (data.status !== 'cancelled') {
          const { rows: therapists } = await tx.query(`SELECT p.user_id FROM cb_participants p JOIN cb_memberships cm
            ON (cm.center_id,cm.user_id,cm.role) = (p.center_id,p.user_id,p.role) JOIN cb_users u ON u.id = p.user_id
            WHERE p.center_id = $1 AND p.conversation_id = $2 AND p.role = 'therapist' AND p.active AND cm.active AND u.active
            FOR SHARE OF p,cm,u`, [scope.centerId,scope.roomId]);
          if (!therapists.length) fail('THERAPIST_UNAVAILABLE');
        }
        const changeSequence = await sequence(tx,scope);
        if (!old) await tx.query(`INSERT INTO cb_appointments
          (center_id,conversation_id,id,date,time,duration,title,room,status,current_revision,updated_by,updated_at,changed_sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),$12)`,
        [scope.centerId,scope.roomId,appointmentId,data.date,data.time,data.duration,data.title,data.room,data.status,revision,scope.userId,changeSequence]);
        else await tx.query(`UPDATE cb_appointments SET date = $4,time = $5,duration = $6,title = $7,room = $8,status = $9,
          current_revision = $10,updated_by = $11,updated_at = clock_timestamp(),changed_sequence = $12
          WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,
        [scope.centerId,scope.roomId,appointmentId,data.date,data.time,data.duration,data.title,data.room,data.status,revision,scope.userId,changeSequence]);
      }
      return remember(tx,scope,clientId,requestHash,'appointment',appointmentId,revision,hasChanges);
    }, options);
  }

  async get(actor, input, options = {}) {
    keys(input,['conversationId','appointmentId','revision']);
    const roomId = id(input.conversationId), appointmentId = id(input.appointmentId);
    if (input.revision !== undefined) version(input.revision,1);
    return this.inScope(actor,roomId,async (tx,scope) => {
      let rows;
      if (input.revision === undefined) ({ rows } = await tx.query(`${appointmentSelect}
        WHERE a.center_id = $1 AND a.conversation_id = $2 AND a.id = $3`, [scope.centerId,scope.roomId,appointmentId]));
      else {
        if (scope.role === 'guardian') fail('FORBIDDEN');
        ({ rows } = await tx.query(`SELECT appointment_id AS id,revision AS current_revision,date::text AS date,to_char(time,'HH24:MI') AS time,
          duration,title,room,status,changed_at AS updated_at FROM cb_appointment_revisions
          WHERE center_id = $1 AND conversation_id = $2 AND appointment_id = $3 AND revision = $4
            AND ($5 = 'center' OR change_sequence >= $6 OR (change_sequence IS NULL AND $6 = 1))`,
        [scope.centerId,scope.roomId,appointmentId,input.revision,scope.role,scope.firstSequence]));
      }
      if (!rows.length) fail('NOT_FOUND');
      return project('appointment',rows[0],scope);
    }, options);
  }

  async list(actor, input, options = {}) {
    keys(input,['conversationId','dateFrom','dateTo','after','limit','expectedVersion']);
    const roomId = input.conversationId === undefined ? null : id(input.conversationId);
    let dateFrom, dateTo;
    try { dateFrom = contextDate(input.dateFrom); dateTo = contextDate(input.dateTo); } catch { fail('INVALID_INPUT'); }
    const days = (Date.parse(`${dateTo}T12:00:00Z`) - Date.parse(`${dateFrom}T12:00:00Z`)) / 86400000;
    if (days < 0 || days > 92) fail('INVALID_INPUT');
    const limit = version(input.limit ?? 50,1,100), after = input.after ?? null;
    if (input.expectedVersion !== undefined) version(input.expectedVersion,0,Number.MAX_SAFE_INTEGER);
    if (after !== null) {
      keys(after,['date','time','conversationId','appointmentId']);
      try { contextDate(after.date); } catch { fail('INVALID_INPUT'); }
      if (after.date < dateFrom || after.date > dateTo || typeof after.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(after.time)) fail('INVALID_INPUT');
      id(after.conversationId); id(after.appointmentId);
      if (roomId !== null && after.conversationId !== roomId) fail('INVALID_INPUT');
      if (input.expectedVersion === undefined) fail('INVALID_INPUT');
    }
    return this.inScope(actor,roomId,async (tx,scope) => {
      if (input.expectedVersion !== undefined && input.expectedVersion !== scope.scheduleVersion)
        return { version:scope.scheduleVersion,resetRequired:true };
      const { rows } = await tx.query(`${appointmentSelect}
        WHERE a.center_id = $1 AND a.date BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR a.conversation_id = $4)
          AND ($5 = 'center' OR EXISTS (SELECT 1 FROM cb_participants p
            WHERE (p.center_id,p.conversation_id,p.user_id,p.role) = (a.center_id,a.conversation_id,$6,$5) AND p.active))
          AND ($7::date IS NULL OR (a.date,a.time,a.conversation_id,a.id) > ($7::date,$8::time,$9::text,$10::text))
        ORDER BY a.date,a.time,a.conversation_id,a.id LIMIT $11`, [scope.centerId,dateFrom,dateTo,roomId,scope.role,scope.userId,
        after?.date ?? null,after?.time ?? null,after?.conversationId ?? null,after?.appointmentId ?? null,limit + 1]);
      const selected = rows.slice(0,limit), last = selected.at(-1);
      return { appointments:selected.map((row) => project('appointment',row,scope)),version:scope.scheduleVersion,resetRequired:false,
        nextCursor:last ? { date:last.date,time:last.time,conversationId:last.conversation_id,appointmentId:last.id } : null,hasMore:rows.length > limit };
    }, options);
  }
}
