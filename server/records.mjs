import { createHash } from 'node:crypto';
import { recordDetails, hasRecordContent, isCompleteAssessment, recordActivity } from '../src/record-fields.js';
import { Conversations } from './conversations.mjs';
import { fail } from './errors.mjs';
import { attachmentInput, bindAttachments, recordAttachments, messageAttachments } from './media-bindings.mjs';

const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const text = (value, max = 2000, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('INVALID_INPUT');
  return value.trim();
};
const integer = (value, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_INPUT');
  return value;
};
const requestId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value) => value == null ? null : JSON.stringify(value);

function content(input) {
  keys(input, ['date', 'title', 'status', 'performed', 'response', 'nextPlan', 'summary', 'privateNote',
    'goalId', 'appointmentId', 'observation', 'assessments', 'activity', 'referenceMessageIds', 'referenceFeedbackRevisions', 'referenceTextRevisions', 'attachments']);
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      input.date.startsWith('0000') || Number.isNaN(Date.parse(`${input.date}T12:00:00Z`)) ||
      new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date) fail('INVALID_INPUT');
  // Reject coercible objects/booleans before applying the same pure content
  // rules used by the UI. Only explicit numeric values or numeric strings pass.
  const assessments = input.assessments ?? [];
  if (!Array.isArray(assessments) || assessments.length > 20) fail('INVALID_INPUT');
  for (const row of assessments) {
    keys(row, ['tool', 'item', 'value', 'unit', 'context']);
    for (const key of ['tool', 'item', 'unit', 'context']) text(row[key] ?? '', key === 'context' ? 300 : 100, input.status !== 'draft');
    if (!(input.status === 'draft' && row.value == null) && !['number', 'string'].includes(typeof row.value)) fail('INVALID_INPUT');
  }
  if (input.observation != null) {
    keys(input.observation, ['status', 'task', 'assistance', 'amount', 'repetitions', 'duration', 'context']);
    text(input.observation.status, 20);
    for (const key of ['task', 'assistance', 'amount', 'repetitions', 'duration', 'context'])
      text(input.observation[key] ?? '', 500);
  }
  const performed = text(input.performed ?? '');
  const response = text(input.response ?? '');
  let details;
  try { details = recordDetails({ ...input, performed, response, assessments }); }
  catch { fail('INVALID_INPUT'); }
  let activity = null;
  if (input.activity != null) {
    keys(input.activity, ['title', 'instruction', 'frequency', 'caution']);
    for (const key of ['title', 'instruction', 'frequency', 'caution'])
      text(input.activity[key] ?? '', key === 'instruction' ? 2000 : key === 'caution' ? 500 : 100);
    try { activity = recordActivity(input.activity, details.status); }
    catch { fail('INVALID_INPUT'); }
  }
  const references = input.referenceMessageIds ?? [];
  if (!Array.isArray(references) || references.length > 20 || new Set(references).size !== references.length) fail('INVALID_INPUT');
  const feedbackReferences = input.referenceFeedbackRevisions ?? [];
  if (!Array.isArray(feedbackReferences) || feedbackReferences.length > 20) fail('INVALID_INPUT');
  const expectedReferences = new Map();
  for (const reference of feedbackReferences) {
    keys(reference, ['messageId', 'revision']);
    const messageId = id(reference.messageId), revision = integer(reference.revision, 1);
    if (revision > 2147483647 || !references.includes(messageId) || expectedReferences.has(messageId)) fail('INVALID_INPUT');
    expectedReferences.set(messageId, revision);
  }
  const textReferences=input.referenceTextRevisions ?? [],expectedText=new Map();
  if (!Array.isArray(textReferences) || textReferences.length>20) fail('INVALID_INPUT');
  for (const reference of textReferences) {
    keys(reference,['messageId','revision']);
    const messageId=id(reference.messageId),revision=integer(reference.revision,1);
    if (revision>2147483647 || !references.includes(messageId) || expectedText.has(messageId) || expectedReferences.has(messageId)) fail('INVALID_INPUT');
    expectedText.set(messageId,revision);
  }
  const normalized = {
    date: input.date, goalId: id(input.goalId), appointmentId: input.appointmentId ? id(input.appointmentId) : null,
    title: text(input.title ?? '', 100) || `${input.date} ${performed.slice(0, 50) || '세션 기록'}`,
    status: details.status, performed, response, nextPlan: text(input.nextPlan ?? ''),
    summary: text(input.summary ?? ''), privateNote: text(input.privateNote ?? ''),
    observation: details.observation, assessments: details.assessments, activity,
    referenceMessageIds: references.map(id),
    // Omitting an empty version list preserves existing save request hashes.
    ...(expectedReferences.size ? { referenceFeedbackRevisions: references.filter((messageId) => expectedReferences.has(messageId))
      .map((messageId) => ({ messageId, revision: expectedReferences.get(messageId) })) } : {}),
    ...(expectedText.size ? {referenceTextRevisions:references.filter((messageId)=>expectedText.has(messageId))
      .map((messageId)=>({messageId,revision:expectedText.get(messageId)}))} : {}),
  };
  const attachments = attachmentInput(input.attachments, true);
  if (attachments.length) normalized.attachments = attachments;
  if (input.appointmentId != null && input.appointmentId !== '' && typeof input.appointmentId !== 'string') fail('INVALID_INPUT');
  if (normalized.status === 'saved' && !hasRecordContent(normalized)) fail('EMPTY_RECORD');
  return normalized;
}

function receipt(row, replayed) {
  return { recordId: row.record_id, revision: row.record_revision,
    operation: row.operation, messageId: row.message_id, replayed };
}

export class Records {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('Records requires a transactional database.');
    this.conversations = new Conversations(database);
  }

  inRoom(actor, roomId, work) {
    return this.conversations.inRoom(actor, roomId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      return work(tx, scope);
    }).catch((error) => {
      if (error.code === '23505' && error.constraint === 'cb_record_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
      if (error.code === '23505' && error.constraint === 'cb_record_appointment') fail('APPOINTMENT_RECORD_EXISTS');
      throw error;
    });
  }

  async header(tx, scope, recordId, optional = false) {
    const { rows } = await tx.query(`SELECT id, current_revision, created_sequence FROM cb_records
      WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId, scope.roomId, recordId]);
    if (rows.length && Number(rows[0].created_sequence) < scope.firstSequence) fail('NOT_FOUND');
    if (!rows.length && !optional) fail('NOT_FOUND');
    return rows[0] ?? null;
  }

  async duplicate(tx, scope, clientId, requestHash) {
    const { rows } = await tx.query(`SELECT conversation_id, request_hash, record_id, record_revision,
      operation, message_id FROM cb_record_requests WHERE center_id = $1 AND actor_id = $2 AND client_id = $3`,
    [scope.centerId, scope.userId, clientId]);
    if (!rows.length) return null;
    if (rows[0].conversation_id !== scope.roomId || rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
    await this.header(tx, scope, rows[0].record_id);
    return receipt(rows[0], true);
  }

  async remember(tx, scope, clientId, requestHash, operation, recordId, revision, messageId = null) {
    await tx.query(`INSERT INTO cb_record_requests
      (center_id, conversation_id, actor_id, client_id, request_hash, operation, record_id, record_revision, message_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [scope.centerId, scope.roomId, scope.userId, clientId, requestHash, operation, recordId, revision, messageId]);
    return { recordId, revision, operation, messageId, replayed: false };
  }

  async save(actor, input) {
    keys(input, ['conversationId', 'recordId', 'clientId', 'expectedRevision', 'content', 'expectedGoalRevision', 'expectedAppointmentRevision']);
    const recordId = id(input.recordId), clientId = requestId(input.clientId);
    const expected = integer(input.expectedRevision), data = content(input.content);
    const expectedGoal = input.expectedGoalRevision === undefined ? undefined : integer(input.expectedGoalRevision, 1);
    const expectedAppointment = input.expectedAppointmentRevision === undefined ? undefined : integer(input.expectedAppointmentRevision, 1);
    if ((expectedGoal !== undefined && expectedGoal > 2147483647) ||
        (expectedAppointment !== undefined && (!data.appointmentId || expectedAppointment > 2147483647))) fail('INVALID_INPUT');
    const requestHash = hash({ operation: 'save', recordId, expected, data,
      ...(expectedGoal === undefined ? {} : { expectedGoal }), ...(expectedAppointment === undefined ? {} : { expectedAppointment }) });
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      const prior = await this.duplicate(tx, scope, clientId, requestHash);
      if (prior) return prior;
      const old = await this.header(tx, scope, recordId, true);
      if ((old?.current_revision ?? 0) !== expected) fail('RECORD_CONFLICT');
      const { rows: goals } = await tx.query(`SELECT id, current_revision FROM cb_goals
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3 FOR SHARE`, [scope.centerId, scope.roomId, data.goalId]);
      if (!goals.length) fail('CONTEXT_NOT_FOUND');
      if (expectedGoal !== undefined && goals[0].current_revision !== expectedGoal) fail('CONTEXT_CHANGED');
      let appointmentRevision = null;
      if (data.appointmentId) {
        const { rows: appointments } = await tx.query(`SELECT id, current_revision FROM cb_appointments
          WHERE center_id = $1 AND conversation_id = $2 AND id = $3 FOR SHARE`,
        [scope.centerId, scope.roomId, data.appointmentId]);
        if (!appointments.length) fail('CONTEXT_NOT_FOUND');
        appointmentRevision = appointments[0].current_revision;
        if (expectedAppointment !== undefined && appointmentRevision !== expectedAppointment) fail('CONTEXT_CHANGED');
      }
      const referenceRows = [];
      const savedSources=old ? (await this.readRevision(tx,scope,recordId,old.current_revision)).referenceSources : [];
      for (const messageId of data.referenceMessageIds) {
        const preserved=savedSources.find((source)=>source.messageId===messageId && source.messageRevision);
        // Authorized clinical source is independent of conversational hiding.
        // Only references present in THIS record's current revision may survive.
        const reference = await this.conversations.row(tx, scope, messageId,!!preserved);
        const expectedReference = data.referenceFeedbackRevisions?.find((r) => r.messageId === messageId)?.revision;
        const expectedText=data.referenceTextRevisions?.find((r)=>r.messageId===messageId)?.revision;
        if (reference.kind==='text') {
          if (preserved) {
            if (expectedText!==undefined && expectedText!==preserved.messageRevision) fail('REFERENCE_CHANGED');
            reference.selected_text_revision=preserved.messageRevision;
          } else {
            if (reference.text_operation==='all') fail('MESSAGE_DELETED');
            if (expectedText===undefined && reference.text_revision!==1) fail('INVALID_INPUT');
            if (expectedText!==undefined && expectedText!==reference.text_revision) fail('REFERENCE_CHANGED');
            reference.selected_text_revision=reference.text_revision;
          }
        } else if (expectedText!==undefined) fail('INVALID_INPUT');
        if (reference.kind === 'feedback') {
          if (expectedReference === undefined) fail('INVALID_INPUT');
          // Editing a record must not silently replace its established clinical
          // source with the guardian's latest correction. Only this record's
          // CURRENT sealed reference may be retained; new/re-added references
          // still require confirmation of the current feedback revision.
          const savedFeedback = savedSources.find(source => source.messageId === messageId &&
            source.feedbackId === reference.feedback_id && source.feedbackRevision);
          const selectedRevision = savedFeedback?.feedbackRevision ?? reference.feedback_revision;
          if (selectedRevision !== expectedReference) fail('REFERENCE_CHANGED');
          reference.feedback_revision = selectedRevision;
        } else if (expectedReference !== undefined) fail('INVALID_INPUT');
        referenceRows.push(reference);
      }
      const revision = expected + 1;
      if (revision > 2147483647) fail('REVISION_LIMIT');
      if (!old) {
        const { rows: legacy } = await tx.query(`SELECT 1 FROM cb_publications
          WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3 LIMIT 1`, [scope.centerId, scope.roomId, recordId]);
        if (legacy.length) fail('RECORD_IMPORT_REQUIRED');
        // Reserve a room-order boundary for private record creation without
        // emitting a public message. Assignment from_now must also exclude old
        // unshared drafts created between two visible messages.
        const { rows: counters } = await tx.query(`UPDATE cb_conversations SET last_sequence = last_sequence + 1
          WHERE center_id = $1 AND id = $2 RETURNING last_sequence`, [scope.centerId, scope.roomId]);
        await tx.query(`INSERT INTO cb_records
          (center_id, conversation_id, id, created_by, created_sequence, current_revision, appointment_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [scope.centerId, scope.roomId, recordId, scope.userId, counters[0].last_sequence, revision, data.appointmentId]);
      } else {
        await tx.query(`UPDATE cb_records SET current_revision = $4, appointment_id = $5
          WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,
        [scope.centerId, scope.roomId, recordId, revision, data.appointmentId]);
      }
      await tx.query(`INSERT INTO cb_record_revisions
        (center_id, conversation_id, record_id, revision, author_id, goal_id, appointment_id, record_date,
         status, title, performed, response, next_plan, summary, private_note, observation, activity, goal_revision, appointment_revision, draft_assessments)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [scope.centerId, scope.roomId, recordId, revision, scope.userId, data.goalId, data.appointmentId,
        data.date, data.status, data.title, data.performed, data.response, data.nextPlan, data.summary,
        data.privateNote, json(data.observation), json(data.activity), goals[0].current_revision, appointmentRevision,
        data.assessments.every(isCompleteAssessment) ? null : json(data.assessments)]);
      // A partly written draft preserves its full ordered rows separately from
      // clinical measurements. Never drop rows, copy old results or invent zero.
      for (const [ordinal, row] of (data.assessments.every(isCompleteAssessment) ? data.assessments : []).entries())
        await tx.query(`INSERT INTO cb_record_assessments
          (center_id, conversation_id, record_id, revision, ordinal, tool, item, value, unit, context)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [scope.centerId, scope.roomId, recordId, revision, ordinal, row.tool, row.item, row.value, row.unit, row.context]);
      for (const [ordinal, reference] of referenceRows.entries()) {
        await tx.query(`INSERT INTO cb_record_references
          (center_id, conversation_id, record_id, revision, ordinal, message_id, feedback_id, feedback_revision)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.centerId, scope.roomId, recordId, revision, ordinal,
          reference.id, reference.feedback_id, reference.feedback_revision]);
        if (reference.selected_text_revision) await tx.query(`INSERT INTO cb_record_text_sources
          (center_id,conversation_id,record_id,revision,ordinal,message_id,message_revision) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [scope.centerId,scope.roomId,recordId,revision,ordinal,reference.id,reference.selected_text_revision]);
      }
      await bindAttachments(tx, scope, 'record', recordId, revision, data.attachments ?? []);
      await tx.query(`UPDATE cb_record_revisions SET sealed = true
        WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3 AND revision = $4`,
      [scope.centerId, scope.roomId, recordId, revision]);
      await this.conversations.bumpRevision(tx, scope);
      return this.remember(tx, scope, clientId, requestHash, 'save', recordId, revision);
    });
  }

  async readRevision(tx, scope, recordId, revision) {
    const { rows } = await tx.query(`SELECT revision, author_id, goal_id, appointment_id, record_date::text AS date,
      status, title, performed, response, next_plan, summary, private_note, observation, activity, created_at, goal_revision, appointment_revision, draft_assessments
      FROM cb_record_revisions WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3 AND revision = $4`,
    [scope.centerId, scope.roomId, recordId, revision]);
    if (!rows.length) fail('NOT_FOUND');
    const row = rows[0];
    let goalSnapshot = null, appointmentSnapshot = null;
    if (row.goal_revision !== null) {
      const { rows: snapshots } = await tx.query(`SELECT revision, title, description, status FROM cb_goal_revisions
        WHERE center_id = $1 AND conversation_id = $2 AND goal_id = $3 AND revision = $4`,
      [scope.centerId, scope.roomId, row.goal_id, row.goal_revision]);
      goalSnapshot = snapshots[0];
    }
    if (row.appointment_revision !== null) {
      const { rows: snapshots } = await tx.query(`SELECT revision, date::text AS date, to_char(time,'HH24:MI') AS time,
          duration, title, room, status FROM cb_appointment_revisions
        WHERE center_id = $1 AND conversation_id = $2 AND appointment_id = $3 AND revision = $4`,
      [scope.centerId, scope.roomId, row.appointment_id, row.appointment_revision]);
      appointmentSnapshot = snapshots[0];
    }
    const { rows: assessments } = await tx.query(`SELECT tool, item, value, unit, context FROM cb_record_assessments
      WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3 AND revision = $4 ORDER BY ordinal`,
    [scope.centerId, scope.roomId, recordId, revision]);
    const { rows: references } = await tx.query(`SELECT r.message_id, r.feedback_id, r.feedback_revision,
      s.message_revision,tv.body AS source_body,h.current_revision AS current_message_revision,cv.operation AS current_message_operation,
      EXISTS (SELECT 1 FROM cb_message_hides hide WHERE
        (hide.center_id,hide.conversation_id,hide.message_id)=(r.center_id,r.conversation_id,r.message_id) AND hide.user_id=$6) AS source_hidden
      FROM cb_record_references r
      JOIN cb_messages m ON (m.center_id, m.conversation_id, m.id) = (r.center_id, r.conversation_id, r.message_id)
      LEFT JOIN cb_record_text_sources s ON (s.center_id,s.conversation_id,s.record_id,s.revision,s.ordinal)=
        (r.center_id,r.conversation_id,r.record_id,r.revision,r.ordinal)
      LEFT JOIN cb_message_text_revisions tv ON (tv.center_id,tv.conversation_id,tv.message_id,tv.revision)=
        (s.center_id,s.conversation_id,s.message_id,s.message_revision)
      LEFT JOIN cb_message_text_heads h ON (h.center_id,h.conversation_id,h.message_id)=(m.center_id,m.conversation_id,m.id)
      LEFT JOIN cb_message_text_revisions cv ON (cv.center_id,cv.conversation_id,cv.message_id,cv.revision)=
        (h.center_id,h.conversation_id,h.message_id,h.current_revision)
      LEFT JOIN cb_activity_feedback f ON (f.center_id, f.conversation_id, f.id) = (m.center_id, m.conversation_id, m.feedback_id)
      LEFT JOIN cb_messages pm ON (pm.center_id, pm.conversation_id, pm.publication_id) = (f.center_id, f.conversation_id, f.publication_id)
      WHERE r.center_id = $1 AND r.conversation_id = $2 AND r.record_id = $3 AND r.revision = $4
        AND m.sequence >= $5 AND (m.kind <> 'feedback' OR pm.sequence >= $5)
      ORDER BY r.ordinal`, [scope.centerId, scope.roomId, recordId, revision, scope.firstSequence,scope.userId]);
    // Called only after therapist/record/history authorization. Original sealed
    // attachment metadata belongs to the clinical reference, not a live chat.
    // Feedback uses the revision captured by THIS record, never the current
    // feedback head. This read remains behind the record/history authority.
    const sourceAttachments=await messageAttachments(tx,scope,references.filter((r)=>r.message_revision || r.feedback_id)
      .map((r)=>({id:r.message_id,kind:r.feedback_id ? 'feedback' : 'text',
        ...(r.feedback_id ? {feedback_id:r.feedback_id,feedback_revision:r.feedback_revision} : {})})));
    return { id: recordId, conversationId: scope.roomId, childId: scope.childId,
      revision, authorId: row.author_id, goalId: row.goal_id, appointmentId: row.appointment_id,
      goalRevision: row.goal_revision, appointmentRevision: row.appointment_revision, goalSnapshot, appointmentSnapshot,
      date: row.date, format: 'structured', status: row.status, title: row.title,
      performed: row.performed, response: row.response, nextPlan: row.next_plan,
      summary: row.summary, privateNote: row.private_note, observation: row.observation,
      activity: row.activity, assessments: row.draft_assessments ?? assessments, attachments: await recordAttachments(tx, scope, recordId, revision),
      referenceMessageIds: references.map((r) => r.message_id),
      referenceSources: references.map((r) => ({ messageId: r.message_id,
        ...(r.message_revision ? {messageRevision:r.message_revision,body:r.source_body,
          attachments:sourceAttachments.get(r.message_id) ?? [],changed:r.message_revision!==r.current_message_revision,
          deleted:r.current_message_operation==='all',hidden:r.source_hidden} : {}),
        ...(r.feedback_id ? { feedbackId: r.feedback_id, feedbackRevision: r.feedback_revision,
          attachments:sourceAttachments.get(r.message_id) ?? [] } : {}) })),
      createdAt: new Date(row.created_at).toISOString() };
  }

  async get(actor, input) {
    keys(input, ['conversationId', 'recordId', 'revision']);
    const recordId = id(input.recordId);
    if (input.revision !== undefined) integer(input.revision, 1);
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      const header = await this.header(tx, scope, recordId);
      return this.readRevision(tx, scope, recordId, input.revision ?? header.current_revision);
    });
  }

  async list(actor, input) {
    keys(input, ['conversationId', 'after', 'limit', 'expectedRevision']);
    const after = integer(input.after ?? 0), limit = integer(input.limit ?? 50, 1);
    if (limit > 100) fail('INVALID_INPUT');
    if (input.expectedRevision !== undefined) integer(input.expectedRevision);
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== scope.revision)
        return { revision: scope.revision, resetRequired: true };
      const { rows } = await tx.query(`SELECT r.id, r.current_revision, r.created_sequence, r.appointment_id,
        v.record_date::text AS date, v.title, v.status FROM cb_records r JOIN cb_record_revisions v
        ON (v.center_id, v.conversation_id, v.record_id, v.revision) = (r.center_id, r.conversation_id, r.id, r.current_revision)
        WHERE r.center_id = $1 AND r.conversation_id = $2 AND r.created_sequence >= $3 AND r.created_sequence > $4
        ORDER BY r.created_sequence LIMIT $5`, [scope.centerId, scope.roomId, scope.firstSequence, after, limit + 1]);
      const selected = rows.slice(0, limit);
      return { revision: scope.revision, resetRequired: false,
        records: selected.map((r) => ({ id: r.id, revision: r.current_revision, date: r.date, title: r.title,
          status: r.status, appointmentId: r.appointment_id })),
        nextCursor: Number(selected.at(-1)?.created_sequence ?? after), hasMore: rows.length > limit };
    });
  }

  async measurements(actor, input) {
    keys(input, ['conversationId', 'after', 'limit', 'expectedRevision']);
    let sequence = 0, ordinal = -1;
    if (input.after !== undefined) {
      keys(input.after, ['sequence', 'ordinal']);
      sequence = integer(input.after.sequence); ordinal = integer(input.after.ordinal);
      if (ordinal > 19) fail('INVALID_INPUT');
    }
    const limit = integer(input.limit === undefined ? 50 : input.limit, 1);
    if (limit > 100) fail('INVALID_INPUT');
    if (input.expectedRevision !== undefined) integer(input.expectedRevision);
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== scope.revision)
        return { revision: scope.revision, resetRequired: true };
      // Only complete clinical rows of the current saved head are selected.
      // Draft JSON, prior revisions, free text, files and references never join
      // this projection. Unknown legacy goal versions remain unknown, rather
      // than replacing the record's historical context with today's goal title.
      const { rows } = await tx.query(`SELECT r.id, r.current_revision, r.created_sequence,
        v.record_date::text AS date, v.title, v.goal_id, g.title AS goal_title,
        a.ordinal, a.tool, a.item, a.value, a.unit, a.context
        FROM cb_records r JOIN cb_record_revisions v
          ON (v.center_id,v.conversation_id,v.record_id,v.revision) = (r.center_id,r.conversation_id,r.id,r.current_revision)
        JOIN cb_record_assessments a
          ON (a.center_id,a.conversation_id,a.record_id,a.revision) = (v.center_id,v.conversation_id,v.record_id,v.revision)
        LEFT JOIN cb_goal_revisions g
          ON (g.center_id,g.conversation_id,g.goal_id,g.revision) = (v.center_id,v.conversation_id,v.goal_id,v.goal_revision)
        WHERE r.center_id = $1 AND r.conversation_id = $2 AND r.created_sequence >= $3
          AND v.status = 'saved' AND v.sealed
          AND (r.created_sequence,a.ordinal) > ($4::bigint,$5::integer)
        ORDER BY r.created_sequence,a.ordinal LIMIT $6`,
      [scope.centerId, scope.roomId, scope.firstSequence, sequence, ordinal, limit + 1]);
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { revision: scope.revision, resetRequired: false,
        measurements: selected.map((row) => ({ recordId: row.id, recordRevision: row.current_revision,
          date: row.date, title: row.title, goalId: row.goal_id, goalTitle: row.goal_title,
          ordinal: row.ordinal, tool: row.tool, item: row.item, value: row.value, unit: row.unit, context: row.context })),
        nextCursor: last ? { sequence: Number(last.created_sequence), ordinal: last.ordinal } : null,
        hasMore: rows.length > limit };
    });
  }

  async shareContext(tx, scope, recordId) {
    const header = await this.header(tx, scope, recordId);
    const record = await this.readRevision(tx, scope, recordId, header.current_revision);
    if (record.status !== 'saved' || !record.summary) fail('RECORD_NOT_SHAREABLE');
    const recipientIds = await this.conversations.activeGuardians(tx, scope);
    if (!recipientIds.length) fail('NO_RECIPIENT');
    const { rows } = await tx.query(`SELECT relationships_version FROM cb_conversations
      WHERE center_id = $1 AND id = $2`, [scope.centerId, scope.roomId]);
    return { record, recipientIds, relationshipsVersion: Number(rows[0].relationships_version) };
  }

  async preview(actor, input) {
    keys(input, ['conversationId', 'recordId']);
    const recordId = id(input.recordId);
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      const { record, recipientIds, relationshipsVersion } = await this.shareContext(tx, scope, recordId);
      return { recordId, recordRevision: record.revision, relationshipsVersion, recipientIds,
        date: record.date, title: record.title, summary: record.summary, activity: record.activity,
        attachments: record.attachments.filter((file) => file.share) };
    });
  }

  async publish(actor, input) {
    keys(input, ['conversationId', 'recordId', 'clientId', 'expectedRevision', 'expectedRelationshipsVersion', 'recipientIds']);
    const recordId = id(input.recordId), clientId = requestId(input.clientId);
    const expected = integer(input.expectedRevision, 1), expectedRelationships = integer(input.expectedRelationshipsVersion);
    if (!Array.isArray(input.recipientIds) || input.recipientIds.length > 100 ||
        new Set(input.recipientIds).size !== input.recipientIds.length) fail('INVALID_INPUT');
    const recipients = input.recipientIds.map(id).sort();
    const requestHash = hash({ operation: 'publish', recordId, expected, expectedRelationships, recipients });
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      const prior = await this.duplicate(tx, scope, clientId, requestHash);
      if (prior) return prior;
      const { record, recipientIds, relationshipsVersion } = await this.shareContext(tx, scope, recordId);
      if (record.revision !== expected) fail('RECORD_CONFLICT');
      if (relationshipsVersion !== expectedRelationships || JSON.stringify(recipientIds.slice().sort()) !== JSON.stringify(recipients))
        fail('RECIPIENTS_CHANGED');
      const message = await this.conversations.publishInRoom(tx, scope, clientId, requestHash,
        { recordId, title: record.title, summary: record.summary },
        { revision: record.revision, date: record.date, activity: record.activity });
      return this.remember(tx, scope, clientId, requestHash, 'publish', recordId, record.revision, message.id);
    });
  }
}
