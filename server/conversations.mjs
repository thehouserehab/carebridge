import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { attachmentInput, bindAttachments, messageAttachments, publishAttachments } from './media-bindings.mjs';
import { messagePreview } from '../src/message-preview.js';
import { messageReadStates } from './message-read-states.mjs';
import { isCareRecipient, messageVisibleSql, recipientTextSql, participantVisibleSql, previewAttachments } from './conversation-visibility.mjs';

const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT');
  return value.trim();
};
const keys = (input, allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const count = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT');
  return value;
};
const clientId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const hash = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const iso = (value) => new Date(value).toISOString();

// Ordinary-message attachments are immutable. Summaries need only their MIME
// types, never filenames, upload IDs, storage keys or download URLs. Aliases
// are internal SQL constants, not caller input. Keep inbox reads in one snapshot.
const textAttachmentTypes = (alias) => `COALESCE((SELECT jsonb_agg(jsonb_build_object('type',u.type) ORDER BY a.ordinal)
  FROM cb_message_attachments a JOIN cb_media_uploads u ON
    (u.center_id,u.conversation_id,u.id)=(a.center_id,a.conversation_id,a.upload_id)
  WHERE (a.center_id,a.conversation_id,a.message_id)=(${alias}.center_id,${alias}.conversation_id,${alias}.id)), '[]'::jsonb)`;

// Private review content is deliberately excluded. Only the current-version
// reviewed Boolean is public; private notes are fetched separately for therapists.
function messageSelect(source = 'cb_messages') {
  if (!['cb_messages', 'selected', 'candidate'].includes(source)) throw new TypeError('Internal bounded message source required.');
  return `SELECT m.id, m.sequence, m.author_id, m.kind,
  CASE WHEN m.kind='text' THEN tv.body ELSE m.body END AS body,
  CASE WHEN m.kind='text' AND tv.operation<>'all' THEN ${textAttachmentTypes('m')}
    ELSE '[]'::jsonb END AS attachment_types,
  m.created_at, m.reply_to, m.publication_id,
  th.current_revision AS text_revision, tv.operation AS text_operation, tv.changed_at AS text_changed_at,
  EXISTS (SELECT 1 FROM cb_message_text_revisions e WHERE
    (e.center_id,e.conversation_id,e.message_id)=(m.center_id,m.conversation_id,m.id) AND e.operation='edit') AS text_edited,
  clock_timestamp() BETWEEN m.created_at AND m.created_at+interval '24 hours' AS text_change_available,
  EXISTS (SELECT 1 FROM cb_message_reviews mr WHERE
    (mr.center_id,mr.conversation_id,mr.message_id,mr.message_revision)=
    (m.center_id,m.conversation_id,m.id,th.current_revision)) AS text_reviewed,
  p.record_id, p.version, p.title, p.summary, p.revoked_at,
  f.id AS feedback_id, f.publication_id AS feedback_publication_id, f.current_revision AS feedback_revision,
  fv.activity_date::text AS feedback_date, fv.result AS feedback_result,
  fv.reaction AS feedback_reaction, fv.difficulty AS feedback_difficulty, fv.created_at AS feedback_updated_at,
  EXISTS (SELECT 1 FROM cb_feedback_reviews fr WHERE
    (fr.center_id, fr.conversation_id, fr.feedback_id, fr.feedback_revision) =
    (f.center_id, f.conversation_id, f.id, f.current_revision)) AS feedback_reviewed,
  q.sequence AS quote_sequence, q.author_id AS quote_author_id,
  CASE WHEN q.kind='text' THEN qv.body ELSE q.body END AS quote_body, q.kind AS quote_kind,
  CASE WHEN q.kind='text' AND qc.operation<>'all' THEN ${textAttachmentTypes('q')}
    ELSE '[]'::jsonb END AS quote_attachment_types,
  qh.current_revision AS quote_current_revision, qr.source_revision AS quote_text_revision,
  qc.operation AS quote_text_operation,
  ${recipientTextSql('q','qc')} AS quote_recipient_visible,
  m.reply_feedback_id, m.reply_feedback_revision, qfv.reaction AS quote_reaction,
  qpm.sequence AS quote_source_sequence,
  qp.title AS quote_title, qp.revoked_at AS quote_revoked_at
  FROM ${source} m
  LEFT JOIN cb_message_text_heads th ON (th.center_id,th.conversation_id,th.message_id)=(m.center_id,m.conversation_id,m.id)
  LEFT JOIN cb_message_text_revisions tv ON (tv.center_id,tv.conversation_id,tv.message_id,tv.revision)=
    (th.center_id,th.conversation_id,th.message_id,th.current_revision)
  LEFT JOIN cb_activity_feedback f ON (f.center_id, f.conversation_id, f.id) =
    (m.center_id, m.conversation_id, m.feedback_id)
  LEFT JOIN cb_feedback_revisions fv ON (fv.center_id, fv.conversation_id, fv.feedback_id, fv.revision) =
    (f.center_id, f.conversation_id, f.id, f.current_revision)
  LEFT JOIN cb_publications p ON (p.center_id, p.conversation_id, p.id) =
    (m.center_id, m.conversation_id, COALESCE(m.publication_id, f.publication_id))
  LEFT JOIN cb_messages pm ON (pm.center_id, pm.conversation_id, pm.publication_id) =
    (f.center_id, f.conversation_id, f.publication_id)
  LEFT JOIN cb_messages q ON (q.center_id, q.conversation_id, q.id) =
    (m.center_id, m.conversation_id, m.reply_to)
  LEFT JOIN cb_message_reply_versions qr ON (qr.center_id,qr.conversation_id,qr.message_id)=(m.center_id,m.conversation_id,m.id)
  LEFT JOIN cb_message_text_heads qh ON (qh.center_id,qh.conversation_id,qh.message_id)=(q.center_id,q.conversation_id,q.id)
  LEFT JOIN cb_message_text_revisions qc ON (qc.center_id,qc.conversation_id,qc.message_id,qc.revision)=
    (qh.center_id,qh.conversation_id,qh.message_id,qh.current_revision)
  LEFT JOIN cb_message_text_revisions qv ON (qv.center_id,qv.conversation_id,qv.message_id,qv.revision)=
    (qr.center_id,qr.conversation_id,qr.source_id,qr.source_revision)
  LEFT JOIN cb_activity_feedback qf ON (qf.center_id, qf.conversation_id, qf.id) =
    (q.center_id, q.conversation_id, q.feedback_id)
  LEFT JOIN cb_feedback_revisions qfv ON (qfv.center_id, qfv.conversation_id, qfv.feedback_id, qfv.revision) =
    (m.center_id, m.conversation_id, m.reply_feedback_id, m.reply_feedback_revision)
  LEFT JOIN cb_messages qpm ON (qpm.center_id, qpm.conversation_id, qpm.publication_id) =
    (qf.center_id, qf.conversation_id, qf.publication_id)
  LEFT JOIN cb_publications qp ON (qp.center_id, qp.conversation_id, qp.id) =
    (q.center_id, q.conversation_id, COALESCE(q.publication_id, qf.publication_id))`;
}

// A feedback card cannot grant access to an activity from before assignment.
// Parameter placeholders here are internal constants, never caller input.
const sourceVisible = (boundary) => `(m.kind <> 'feedback' OR pm.sequence >= ${boundary})`;
const notHidden = (user) => `NOT EXISTS (SELECT 1 FROM cb_message_hides hidden WHERE
  (hidden.center_id,hidden.conversation_id,hidden.message_id)=(m.center_id,m.conversation_id,m.id) AND hidden.user_id=${user})`;
// Navigation/counting needs only authorization sources, not quote payloads,
// file metadata or private reviews. Bound message IDs before full projection;
// otherwise a small LIMIT can still expand the complete history's joins.
// Both lateral lookups are unique by database keys. LIMIT 1 keeps their plans
// tied to one candidate rather than expanding multi-join history scans.
const messageVisibilityFrom = `FROM cb_messages m
  LEFT JOIN LATERAL (SELECT current_text.body,current_text.operation FROM cb_message_text_heads head
    JOIN cb_message_text_revisions current_text ON
      (current_text.center_id,current_text.conversation_id,current_text.message_id,current_text.revision)=
      (head.center_id,head.conversation_id,head.message_id,head.current_revision)
    WHERE (head.center_id,head.conversation_id,head.message_id)=(m.center_id,m.conversation_id,m.id)
    LIMIT 1) tv ON true
  LEFT JOIN LATERAL (SELECT source.sequence FROM cb_activity_feedback feedback
    JOIN cb_messages source ON (source.center_id,source.conversation_id,source.publication_id)=
      (feedback.center_id,feedback.conversation_id,feedback.publication_id)
    WHERE (feedback.center_id,feedback.conversation_id,feedback.id)=(m.center_id,m.conversation_id,m.feedback_id)
    LIMIT 1) pm ON true`;
const visibleWhere = (center, room, first, user, role) => `m.center_id=${center} AND m.conversation_id=${room}
  AND m.sequence>=${first} AND ${sourceVisible(first)} AND ${notHidden(user)} AND ${messageVisibleSql(role)}`;
// Share the unread boundary between the room page and home summaries. All
// arguments are SQL expressions authored here, never interpolated user input.
const unreadWhere = (center, room, user, lastRead, first, role) => `m.center_id=${center}
  AND m.conversation_id=${room} AND m.author_id<>${user} AND m.sequence>${lastRead}
  AND m.sequence>=${first} AND ${sourceVisible(first)} AND ${notHidden(user)}
  AND (tv.operation IS NULL OR tv.operation<>'all') AND ${messageVisibleSql(role)}`;

function project(row, scope) {
  const archived = ['publication', 'feedback'].includes(row.kind) && !!row.revoked_at;
  const result = {
    id: row.id, conversationId: scope.roomId, childId: scope.childId,
    sequence: Number(row.sequence), authorId: row.author_id,
    createdAt: iso(row.created_at), type: row.kind, archived,
    canReply: !archived, attachments: [],
  };
  if (row.text_operation === 'all') return {...result, authorId:null, hidden:true, deleted:true,
    body:'삭제된 소식입니다.', canReply:false, canHide:true, version:row.text_revision};
  if (archived && scope.role === 'guardian')
    return { ...result, hidden: true, body: '공유가 종료된 기록입니다.' };
  if (row.kind === 'publication') return {
    ...result, body: row.title,
    publication: {
      id: row.publication_id, recordId: row.record_id, version: row.version,
      title: row.title, summary: row.summary, sharedAt: iso(row.created_at),
    },
  };
  if (row.kind === 'feedback') return {
    ...result, body: row.feedback_reaction,
    feedback: {
      id: row.feedback_id, publicationId: row.feedback_publication_id, revision: row.feedback_revision,
      date: row.feedback_date, result: row.feedback_result, reaction: row.feedback_reaction,
      difficulty: row.feedback_difficulty, reviewed: row.feedback_reviewed,
      updatedAt: iso(row.feedback_updated_at),
    },
  };
  let quote = null;
  if (row.reply_to) {
    const outsideHistory = Number(row.quote_sequence) < scope.firstSequence ||
      (row.quote_kind === 'feedback' && Number(row.quote_source_sequence) < scope.firstSequence);
    const withdrawn = ['publication', 'feedback'].includes(row.quote_kind) && !!row.quote_revoked_at && scope.role === 'guardian';
    const unavailableToRecipient = isCareRecipient(scope) && (row.quote_recipient_visible !== true ||
      (row.quote_text_operation !== 'all' && !row.quote_body?.trim()));
    quote = outsideHistory || row.quote_hidden || unavailableToRecipient
      ? { id: row.reply_to, hidden: true, body: '열람할 수 없는 이전 소식입니다.' }
      : row.quote_text_operation === 'all'
      ? { id:row.reply_to, hidden:true, body:'삭제된 소식입니다.' }
      : { id: row.reply_to, hidden: withdrawn, authorId: row.quote_author_id,
          body: withdrawn ? '공유가 종료된 기록입니다.' :
            (row.quote_kind === 'feedback' ? row.quote_reaction : (row.quote_title ?? row.quote_body)) };
    if (!quote.hidden && row.quote_kind === 'feedback')
      Object.assign(quote, { feedbackId: row.reply_feedback_id, feedbackRevision: row.reply_feedback_revision });
    if (!quote.hidden && row.quote_kind==='text') Object.assign(quote, {
      version:row.quote_text_revision, changed:row.quote_text_revision!==row.quote_current_revision,
    });
    if (!quote.hidden) quote.preview = messagePreview({body:quote.body, attachments:previewAttachments(scope,row.quote_attachment_types)});
  }
  const canChange=row.author_id===scope.userId && row.text_change_available;
  return { ...result, body: row.body, quote, version:row.text_revision, edited:row.text_edited,
    reviewed:row.text_reviewed === true, canEdit:canChange, canDeleteAll:canChange, canHide:true };
}

export class Conversations {
  constructor(database) { this.database = database; }

  // Identity must come from a verified server session, never an HTTP body/header
  // supplied as a role selector. This library is not an authentication service.
  async inRoom(identity, roomId, work) {
    id(identity?.userId);
    id(identity?.centerId);
    id(roomId);
    return this.database.transaction((tx) => this.inRoomTransaction(tx,identity,roomId,work)).catch((error) => {
      // Same author/client ID racing across two rooms is rejected by the DB.
      if (error.code === '23505' && error.constraint === 'cb_message_request_id') fail('IDEMPOTENCY_CONFLICT');
      if (error.code === '23505' && error.constraint === 'cb_message_change_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
      if (error.code === '23505' && error.constraint === 'cb_message_review_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
      if (error.code === '23514' && error.constraint === 'cb_message_change_window') fail('MESSAGE_CHANGE_EXPIRED');
      throw error;
    });
  }

  // Internal composition on ONE existing transaction. Queue dispatch already
  // takes the room first; repeat that lock and all current authorization here.
  // Never accept a transaction or identity from an HTTP request.
  async inRoomTransaction(tx,identity,roomId,work) {
    const userId = id(identity?.userId),centerId = id(identity?.centerId); id(roomId);
    // Acquire the room lock in a separate statement, before any participant
    // or account locks. Relationship replacement uses the same lock order.
    const { rows: rooms } = await tx.query(`SELECT c.child_id, c.revision
      FROM cb_conversations c
      JOIN cb_participants p ON (p.center_id, p.conversation_id) = (c.center_id, c.id)
      JOIN cb_memberships cm ON (cm.center_id, cm.user_id, cm.role) = (p.center_id, p.user_id, p.role)
      JOIN cb_users u ON u.id = p.user_id
      WHERE c.center_id = $1 AND c.id = $2 AND p.user_id = $3
        AND p.active AND cm.active AND u.active
        AND cm.role IN ('therapist', 'guardian', 'care_recipient')
      FOR UPDATE OF c`, [centerId, roomId, userId]);
    if (!rooms.length) fail('NOT_FOUND');
    // Re-check after acquiring the room: another transaction may have
    // removed this participant while the room lock was being awaited.
    const { rows } = await tx.query(`SELECT p.role, p.first_sequence FROM cb_participants p
      JOIN cb_memberships cm ON (cm.center_id, cm.user_id, cm.role) = (p.center_id, p.user_id, p.role)
      JOIN cb_users u ON u.id = p.user_id
      WHERE p.center_id = $1 AND p.conversation_id = $2 AND p.user_id = $3
        AND p.active AND cm.active AND u.active AND cm.role IN ('therapist', 'guardian', 'care_recipient')
      FOR SHARE OF p, cm, u`, [centerId, roomId, userId]);
    if (!rows.length) fail('NOT_FOUND');
    const row = rows[0];
    // PostgreSQL checks every referenced relation's privileges even when an
    // OR branch is false. Media workers must not read authentication tables.
    // Decide from the locked DB role, never a caller role, and verify the
    // recipient binding before exposing scope or invoking any work callback.
    if (row.role === 'care_recipient') {
      const { rows: subjects } = await tx.query(`SELECT p.user_id FROM cb_participants p
        WHERE p.center_id=$1 AND p.conversation_id=$2 AND p.user_id=$3
          AND p.role='care_recipient' AND ${participantVisibleSql('p')}`, [centerId, roomId, userId]);
      if (!subjects.length) fail('NOT_FOUND');
    }
    return work(tx, {
      centerId, roomId, userId, childId: rooms[0].child_id, role: row.role,
      firstSequence: Number(row.first_sequence), revision: Number(rooms[0].revision),
    });
  }

  async row(tx, scope, messageId, includeHidden = false) {
    const { rows } = await tx.query(`${messageSelect()}
      WHERE m.center_id = $1 AND m.conversation_id = $2 AND m.id = $3 AND m.sequence >= $4
        AND ${sourceVisible('$4')} AND ($6::boolean OR ${notHidden('$5')}) AND ${messageVisibleSql('$7')}`,
      [scope.centerId, scope.roomId, messageId, scope.firstSequence, scope.userId, includeHidden, scope.role]);
    if (!rows.length) fail('NOT_FOUND');
    return rows[0];
  }

  async views(tx, scope, rows) {
    const reviews = new Map();
    const feedbackReviews = new Map();
    const recordSnapshots = new Map();
    const quoteIds=rows.map((row)=>row.reply_to).filter(Boolean);
    if (quoteIds.length) {
      const {rows:hidden}=await tx.query(`SELECT message_id FROM cb_message_hides WHERE
        center_id=$1 AND conversation_id=$2 AND user_id=$3 AND message_id=ANY($4::text[])`,
      [scope.centerId,scope.roomId,scope.userId,quoteIds]);
      const hiddenIds=new Set(hidden.map((row)=>row.message_id));
      rows=rows.map((row)=>({...row,quote_hidden:hiddenIds.has(row.reply_to)}));
    }
    const attachments = await messageAttachments(tx, scope, rows);
    const readStates = await messageReadStates(tx, scope, rows);
    const publicationIds = rows.filter((row) => row.kind === 'publication' &&
      (scope.role === 'therapist' || !row.revoked_at)).map((row) => row.publication_id);
    if (publicationIds.length) {
      // Public snapshot fields only: never join clinical revisions into the
      // guardian projection or serialize a private record as a shared card.
      const { rows: snapshots } = await tx.query(`SELECT publication_id, record_revision,
          record_date::text AS record_date, activity FROM cb_record_publications
        WHERE center_id = $1 AND conversation_id = $2 AND publication_id = ANY($3::text[])`,
      [scope.centerId, scope.roomId, publicationIds]);
      for (const snapshot of snapshots) recordSnapshots.set(snapshot.publication_id, snapshot);
    }
    const ids = rows.filter((row) => row.kind === 'text').map((row) => row.id);
    if (scope.role === 'therapist' && ids.length) {
      const { rows: privateRows } = await tx.query(`SELECT message_id, note, updated_at, message_revision FROM cb_message_reviews
        WHERE center_id = $1 AND conversation_id = $2 AND message_id = ANY($3::text[])`,
        [scope.centerId, scope.roomId, ids]);
      for (const review of privateRows) reviews.set(review.message_id, review);
    }
    const feedbackRows = rows.filter((row) => row.kind === 'feedback');
    if (scope.role === 'therapist' && feedbackRows.length) {
      // Private notes are fetched only for therapists, and for the exact
      // revision being projected (including an explicitly requested history).
      const { rows: privateRows } = await tx.query(`SELECT DISTINCT ON (r.feedback_id, r.feedback_revision)
          r.feedback_id, r.feedback_revision, r.review_version, r.note, r.created_at
        FROM cb_feedback_reviews r
        JOIN unnest($3::text[], $4::integer[]) AS wanted(id, revision)
          ON (wanted.id, wanted.revision) = (r.feedback_id, r.feedback_revision)
        WHERE r.center_id = $1 AND r.conversation_id = $2
        ORDER BY r.feedback_id, r.feedback_revision, r.review_version DESC`,
      [scope.centerId, scope.roomId, feedbackRows.map((r) => r.feedback_id), feedbackRows.map((r) => r.feedback_revision)]);
      for (const review of privateRows) feedbackReviews.set(`${review.feedback_id}:${review.feedback_revision}`, review);
    }
    return rows.map((row) => {
      const result = project(row, scope);
      result.read = !result.hidden && (readStates.get(row.id) ?? false);
      if (!result.hidden) result.attachments = attachments.get(row.id) ?? [];
      const snapshot = recordSnapshots.get(row.publication_id);
      if (snapshot && result.publication) Object.assign(result.publication, {
        recordRevision: snapshot.record_revision, date: snapshot.record_date, activity: snapshot.activity,
      });
      if (scope.role === 'therapist' && row.kind === 'text' && !result.hidden) {
        const review = reviews.get(row.id);
        result.reviewed = !!review && review.message_revision===row.text_revision;
        result.reviewChanged = !!review && review.message_revision!==row.text_revision;
        if (review) {
          result.reviewNote = review.note;
          result.reviewedAt = iso(review.updated_at);
        }
      }
      if (scope.role === 'therapist' && result.feedback) {
        const review = feedbackReviews.get(`${row.feedback_id}:${row.feedback_revision}`);
        Object.assign(result.feedback, { reviewed: !!review, reviewVersion: review?.review_version ?? 0 });
        if (review) Object.assign(result.feedback, { reviewNote: review.note, reviewedAt: iso(review.created_at) });
      }
      return result;
    });
  }

  async view(tx, scope, row) {
    return (await this.views(tx, scope, [row]))[0];
  }

  async duplicate(tx, scope, requestId, requestHash) {
    const { rows } = await tx.query(`SELECT id, conversation_id, request_hash FROM cb_messages
      WHERE center_id = $1 AND author_id = $2 AND client_id = $3`,
      [scope.centerId, scope.userId, requestId]);
    if (!rows.length) return null;
    if (rows[0].conversation_id !== scope.roomId || rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
    const row=await this.row(tx,scope,rows[0].id,true);
    const {rows:hidden}=await tx.query(`SELECT 1 FROM cb_message_hides WHERE
      center_id=$1 AND conversation_id=$2 AND message_id=$3 AND user_id=$4`,[scope.centerId,scope.roomId,row.id,scope.userId]);
    // A retry acknowledges the original send, never resurrects a self-hidden
    // body. Keep the public message envelope complete so the client can accept
    // this receipt without fetching the now-inaccessible message or retrying
    // forever; no author, attachment, quote or private review is restored.
    if (hidden.length) return {id:row.id,conversationId:scope.roomId,childId:scope.childId,
      sequence:Number(row.sequence),authorId:null,createdAt:iso(row.created_at),read:false,
      type:row.kind,hidden:true,body:'나에게서 삭제한 소식입니다.',attachments:[],canReply:false};
    return this.view(tx,scope,row);
  }

  async insert(tx, scope, requestId, requestHash, payload) {
    // Row locking in inRoom makes allocation follow commit order within a room.
    // A sequence allocated globally before commit could otherwise skip a delayed
    // transaction when a reconnecting client advances its pagination cursor.
    const { rows: counters } = await tx.query(`UPDATE cb_conversations
      SET last_sequence = last_sequence + 1, revision = revision + 1
      WHERE center_id = $1 AND id = $2 RETURNING last_sequence`, [scope.centerId, scope.roomId]);
    const messageId = randomUUID();
    await tx.query(`INSERT INTO cb_messages
      (center_id, conversation_id, id, sequence, author_id, client_id, request_hash, kind, body, publication_id, reply_to,
       feedback_id, reply_feedback_id, reply_feedback_revision, attachments_sealed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)`,
      [scope.centerId, scope.roomId, messageId, counters[0].last_sequence, scope.userId,
        requestId, requestHash, payload.kind, payload.body ?? null,
        payload.publicationId ?? null, payload.replyTo ?? null,
        payload.feedbackId ?? null, payload.replyFeedbackId ?? null, payload.replyFeedbackRevision ?? null]);
    if (payload.kind === 'text') await bindAttachments(tx, scope, 'message', messageId, null, payload.attachments ?? []);
    await tx.query(`UPDATE cb_messages SET attachments_sealed = true WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,
      [scope.centerId, scope.roomId, messageId]);
    await this.audit(tx, scope, { text: 'message.sent', publication: 'publication.shared', feedback: 'feedback.submitted' }[payload.kind]);
    return this.view(tx, scope, await this.row(tx, scope, messageId));
  }

  async audit(tx, scope, action) {
    await tx.query(`INSERT INTO cb_audit_events(center_id, conversation_id, actor_id, action)
      VALUES ($1,$2,$3,$4)`, [scope.centerId, scope.roomId, scope.userId, action]);
  }

  async bumpRevision(tx, scope) {
    await tx.query(`UPDATE cb_conversations SET revision = revision + 1 WHERE center_id = $1 AND id = $2`,
      [scope.centerId, scope.roomId]);
  }

  async sendText(identity, input) {
    keys(input, ['conversationId', 'clientId', 'body', 'replyTo', 'expectedReplyRevision', 'expectedReplyVersion', 'attachments']);
    const requestId = clientId(input.clientId);
    const attachments = attachmentInput(input.attachments);
    const body = input.body ?? '';
    if (typeof body !== 'string' || body.length > 2000 || (!body.trim() && !attachments.length)) fail('INVALID_INPUT');
    const payload = { kind: 'text', body: body.trim(), replyTo: input.replyTo == null ? null : id(input.replyTo),
      ...(attachments.length ? { attachments } : {}) };
    if (input.expectedReplyRevision !== undefined &&
        (!payload.replyTo || !Number.isInteger(input.expectedReplyRevision) || input.expectedReplyRevision < 1 ||
          input.expectedReplyRevision > 2147483647)) fail('INVALID_INPUT');
    if (input.expectedReplyVersion!==undefined && (!payload.replyTo || !Number.isInteger(input.expectedReplyVersion) ||
      input.expectedReplyVersion<1 || input.expectedReplyVersion>2147483647)) fail('INVALID_INPUT');
    // Preserve existing text/publication request hashes across this upgrade.
    const requestHash = hash({ ...payload, ...(input.expectedReplyRevision === undefined ? {} :
      { expectedReplyRevision: input.expectedReplyRevision }), ...(input.expectedReplyVersion===undefined ? {} :
      {expectedReplyVersion:input.expectedReplyVersion}) });
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (isCareRecipient(scope) && attachments.length) fail('FORBIDDEN');
      const existing = await this.duplicate(tx, scope, requestId, requestHash);
      if (existing) return existing;
      if (payload.replyTo) {
        const original = await this.row(tx, scope, payload.replyTo);
        if (original.text_operation==='all') fail('MESSAGE_DELETED');
        if (original.kind==='text') {
          if (input.expectedReplyVersion===undefined && original.text_revision!==1) fail('INVALID_INPUT');
          if (input.expectedReplyVersion!==undefined && input.expectedReplyVersion!==original.text_revision) fail('MESSAGE_CONFLICT');
        } else if (input.expectedReplyVersion!==undefined) fail('INVALID_INPUT');
        if (['publication', 'feedback'].includes(original.kind) && original.revoked_at) fail('PUBLICATION_CLOSED');
        if (original.kind === 'feedback') {
          if (input.expectedReplyRevision === undefined) fail('INVALID_INPUT');
          if (input.expectedReplyRevision !== original.feedback_revision) fail('FEEDBACK_CONFLICT');
          Object.assign(payload, { replyFeedbackId: original.feedback_id, replyFeedbackRevision: original.feedback_revision });
        } else if (input.expectedReplyRevision !== undefined) fail('INVALID_INPUT');
      }
      return this.insert(tx, scope, requestId, requestHash, payload);
    });
  }

  async activeGuardians(tx, scope) {
    const { rows } = await tx.query(`SELECT p.user_id FROM cb_participants p
      JOIN cb_memberships cm ON (cm.center_id, cm.user_id, cm.role) = (p.center_id, p.user_id, p.role)
      JOIN cb_users u ON u.id = p.user_id
      WHERE p.center_id = $1 AND p.conversation_id = $2 AND p.role = 'guardian'
        AND p.active AND cm.active AND u.active ORDER BY p.user_id FOR SHARE OF p, cm, u`,
    [scope.centerId, scope.roomId]);
    return rows.map((row) => row.user_id);
  }

  // Compatibility path for earlier summary-only data. Full clinical records
  // must be shared through Records.publish with version/recipient confirmation.
  // Neither this helper nor publishInRoom should be exposed as an HTTP endpoint.
  async publishSnapshot(identity, input) {
    keys(input, ['conversationId', 'clientId', 'recordId', 'title', 'summary']);
    const requestId = clientId(input.clientId);
    const snapshot = { kind: 'publication', recordId: id(input.recordId), title: text(input.title, 100), summary: text(input.summary, 2000) };
    const requestHash = hash(snapshot);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const { rows } = await tx.query(`SELECT 1 FROM cb_records
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId, scope.roomId, snapshot.recordId]);
      if (rows.length) fail('RECORD_SERVICE_REQUIRED');
      return this.publishInRoom(tx, scope, requestId, requestHash, snapshot);
    });
  }

  async publishInRoom(tx, scope, requestId, requestHash, snapshot, recordSnapshot = null) {
    if (scope.role !== 'therapist') fail('FORBIDDEN');
    const existing = await this.duplicate(tx, scope, requestId, requestHash);
    if (existing) return existing;
    const guardians = await this.activeGuardians(tx, scope);
    if (!guardians.length) fail('NO_RECIPIENT');
    const { rows: previous } = await tx.query(`SELECT m.sequence FROM cb_publications p
      JOIN cb_messages m ON (m.center_id, m.conversation_id, m.publication_id) = (p.center_id, p.conversation_id, p.id)
      WHERE p.center_id = $1 AND p.conversation_id = $2 AND p.record_id = $3
      ORDER BY p.version DESC LIMIT 1`, [scope.centerId, scope.roomId, snapshot.recordId]);
    if (previous.length && Number(previous[0].sequence) < scope.firstSequence) fail('NOT_FOUND');
    const { rows: versions } = await tx.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM cb_publications WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3`,
    [scope.centerId, scope.roomId, snapshot.recordId]);
    await tx.query(`UPDATE cb_publications SET revoked_at = clock_timestamp()
      WHERE center_id = $1 AND conversation_id = $2 AND record_id = $3 AND revoked_at IS NULL`,
    [scope.centerId, scope.roomId, snapshot.recordId]);
    const publicationId = randomUUID();
    await tx.query(`INSERT INTO cb_publications(center_id, conversation_id, id, record_id, version, title, summary)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [scope.centerId, scope.roomId, publicationId,
      snapshot.recordId, versions[0].version, snapshot.title, snapshot.summary]);
    if (recordSnapshot) {
      await tx.query(`INSERT INTO cb_record_publications
        (center_id, conversation_id, publication_id, record_id, record_revision, record_date, activity, attachments_sealed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,false)`, [scope.centerId, scope.roomId, publicationId,
        snapshot.recordId, recordSnapshot.revision, recordSnapshot.date,
        recordSnapshot.activity ? JSON.stringify(recordSnapshot.activity) : null]);
      await publishAttachments(tx, scope, publicationId, snapshot.recordId, recordSnapshot.revision);
      await tx.query(`UPDATE cb_record_publications SET attachments_sealed = true
        WHERE center_id = $1 AND conversation_id = $2 AND publication_id = $3`,[scope.centerId,scope.roomId,publicationId]);
      for (const guardian of guardians)
        await tx.query(`INSERT INTO cb_record_recipients(center_id, conversation_id, publication_id, user_id)
          VALUES ($1,$2,$3,$4)`, [scope.centerId, scope.roomId, publicationId, guardian]);
    }
    return this.insert(tx, scope, requestId, requestHash, { kind: 'publication', publicationId });
  }

  async withdraw(identity, input) {
    keys(input, ['conversationId', 'messageId']);
    id(input.messageId);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const row = await this.row(tx, scope, input.messageId);
      if (row.kind !== 'publication') fail('INVALID_INPUT');
      if (!row.revoked_at) {
        await tx.query(`UPDATE cb_publications SET revoked_at = clock_timestamp()
          WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,
          [scope.centerId, scope.roomId, row.publication_id]);
        await this.bumpRevision(tx, scope);
        await this.audit(tx, scope, 'publication.withdrawn');
      }
      return this.view(tx, scope, await this.row(tx, scope, row.id));
    });
  }

  async get(identity, input) {
    keys(input, ['conversationId', 'messageId']);
    id(input.messageId);
    return this.inRoom(identity, input.conversationId, async (tx, scope) =>
      this.view(tx, scope, await this.row(tx, scope, input.messageId)));
  }

  async editText(identity,input) {
    keys(input,['conversationId','messageId','clientId','expectedRevision','body']);
    if (typeof input.body!=='string' || input.body.length>2000) fail('INVALID_INPUT');
    return this.#changeText(identity,input,'edit');
  }

  async deleteText(identity,input) {
    keys(input,['conversationId','messageId','clientId','expectedRevision','scope','confirmed']);
    if (!['self','all'].includes(input.scope) || input.confirmed!==true) fail('INVALID_INPUT');
    return this.#changeText(identity,input,input.scope);
  }

  // Internal command path, not an HTTP handler. The clock, identity, room lock,
  // version, receipt and audit belong to one database transaction.
  async #changeText(identity,input,operation) {
    if (!['edit','self','all'].includes(operation)) fail('INVALID_INPUT');
    const messageId=id(input.messageId),requestId=clientId(input.clientId);
    const expected=input.expectedRevision;
    if (operation!=='self' && (!Number.isInteger(expected) || expected<1 || expected>2147483647) ||
        operation==='self' && expected!==undefined && (!Number.isInteger(expected) || expected<1 || expected>2147483647)) fail('INVALID_INPUT');
    const body=operation==='edit' ? input.body.trim() : null;
    const requestHash=hash({operation,messageId,...(expected===undefined ? {} : {expected}),...(operation==='edit' ? {body} : {})});
    return this.inRoom(identity,input.conversationId,async (tx,scope)=>{
      const row=await this.row(tx,scope,messageId,true);
      const {rows:prior}=await tx.query(`SELECT conversation_id,request_hash,message_id,message_revision,operation
        FROM cb_message_change_requests WHERE center_id=$1 AND actor_id=$2 AND client_id=$3`,[scope.centerId,scope.userId,requestId]);
      const receipt=(revision,replayed)=>({messageId,revision,operation,replayed});
      if (prior.length) {
        if (prior[0].conversation_id!==scope.roomId || prior[0].request_hash!==requestHash) fail('IDEMPOTENCY_CONFLICT');
        return receipt(prior[0].message_revision,true);
      }
      if (row.kind!=='text') fail('INVALID_INPUT');
      let revision=row.text_revision;
      if (operation==='self') {
        const {rows}=await tx.query(`INSERT INTO cb_message_hides(center_id,conversation_id,message_id,user_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING hidden_at`,[scope.centerId,scope.roomId,messageId,scope.userId]);
        if (rows.length) {await this.bumpRevision(tx,scope);await this.audit(tx,scope,'message.hidden');}
      } else {
        await this.row(tx,scope,messageId); // no edit/all-delete of self-hidden content
        if (row.author_id!==scope.userId) fail('FORBIDDEN');
        if (row.text_operation==='all') fail('MESSAGE_DELETED');
        if (row.text_revision!==expected) fail('MESSAGE_CONFLICT');
        if (!row.text_change_available) fail('MESSAGE_CHANGE_EXPIRED');
        if (revision===2147483647) fail('REVISION_LIMIT');
        if (operation==='edit') {
          if (body===row.body) fail('INVALID_INPUT');
          if (!body) {
            const {rows}=await tx.query(`SELECT 1 FROM cb_message_attachments WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3 LIMIT 1`,[scope.centerId,scope.roomId,messageId]);
            if (!rows.length) fail('INVALID_INPUT');
          }
        }
        revision++;
        await tx.query(`INSERT INTO cb_message_text_revisions(center_id,conversation_id,message_id,revision,actor_id,operation,body)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,[scope.centerId,scope.roomId,messageId,revision,scope.userId,operation,body]);
        await tx.query(`UPDATE cb_message_text_heads SET current_revision=$4 WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`,[scope.centerId,scope.roomId,messageId,revision]);
        await this.bumpRevision(tx,scope);
        await this.audit(tx,scope,operation==='edit' ? 'message.edited' : 'message.deleted');
      }
      await tx.query(`INSERT INTO cb_message_change_requests(center_id,conversation_id,actor_id,client_id,request_hash,operation,message_id,message_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[scope.centerId,scope.roomId,scope.userId,requestId,requestHash,operation,messageId,revision]);
      return receipt(revision,false);
    });
  }

  // Home is a read, not a markRead operation. One SQL statement gives the
  // authorization, history, message projection, counts and paging token the
  // same snapshot without taking every conversation's write lock.
  async inbox(identity, input = {}) {
    keys(input, ['limit', 'offset', 'expectedSnapshot']);
    const centerId = id(identity?.centerId), userId = id(identity?.userId);
    const limit = input.limit ?? 50, offset = count(input.offset ?? 0);
    const expectedSnapshot = input.expectedSnapshot;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (expectedSnapshot !== undefined && (typeof expectedSnapshot !== 'string' || !/^[a-f0-9]{32}$/.test(expectedSnapshot))) ||
        (offset > 0 && expectedSnapshot === undefined)) fail('INVALID_INPUT');
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query(`WITH authorized AS MATERIALIZED (
          SELECT cm.role FROM cb_memberships cm JOIN cb_users u ON u.id=cm.user_id
          WHERE cm.center_id=$1 AND cm.user_id=$2 AND cm.active AND u.active
            AND cm.role IN ('therapist','guardian','care_recipient')
        ), visible_rooms AS MATERIALIZED (
          SELECT c.id,c.child_id,c.revision,p.first_sequence,p.role
          FROM cb_conversations c JOIN cb_participants p
            ON (p.center_id,p.conversation_id)=(c.center_id,c.id)
          JOIN authorized a ON a.role=p.role
          WHERE c.center_id=$1 AND p.user_id=$2 AND p.active AND ${participantVisibleSql('p')}
        ), page AS (
          SELECT v.id AS conversation_id,v.child_id,v.revision,v.first_sequence,v.role,
            COALESCE(r.sequence,0) AS last_read, counts.unread,
            to_jsonb(latest) AS message, latest.created_at AS sort_at
          FROM visible_rooms v
          LEFT JOIN cb_read_states r ON (r.center_id,r.conversation_id,r.user_id)=($1,v.id,$2)
          LEFT JOIN LATERAL (WITH candidate AS MATERIALIZED (
              SELECT m.* ${messageVisibilityFrom}
              WHERE ${visibleWhere('$1', 'v.id', 'v.first_sequence', '$2', 'v.role')}
              ORDER BY m.sequence DESC LIMIT 1
            ) ${messageSelect('candidate')}) latest ON true
          CROSS JOIN LATERAL (SELECT COUNT(*) AS unread ${messageVisibilityFrom}
            WHERE ${unreadWhere('$1', 'v.id', '$2', 'COALESCE(r.sequence,0)', 'v.first_sequence', 'v.role')}) counts
          ORDER BY (counts.unread>0) DESC,latest.created_at DESC NULLS LAST,v.id COLLATE "C"
          OFFSET $3 LIMIT $4
        ) SELECT EXISTS(SELECT 1 FROM authorized) AS authorized,
          (SELECT md5(jsonb_build_array(1,$1::text,$2::text,
            COALESCE(jsonb_agg(jsonb_build_array(v.id,v.revision,v.first_sequence,v.role)
              ORDER BY v.id COLLATE "C"),'[]'::jsonb))::text) FROM visible_rooms v) AS snapshot,
          (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY (unread>0) DESC,
            sort_at DESC NULLS LAST,conversation_id COLLATE "C"),'[]'::jsonb) FROM page) AS rooms`,
      [centerId, userId, offset, limit + 1]);
      const result = rows[0];
      if (!result?.authorized) fail('NOT_FOUND');
      // This token only detects changes, never authorizes access. Pagination
      // must restart after sends, edits, deletion, reads or relationship changes.
      if (expectedSnapshot !== undefined && result.snapshot !== expectedSnapshot)
        return { snapshot: result.snapshot, resetRequired: true };
      const rooms = result.rooms.slice(0, limit).map((row) => {
        const message = row.message?.id ? project(row.message, {
          centerId, userId, roomId: row.conversation_id, childId: row.child_id,
          firstSequence: Number(row.first_sequence), role: row.role,
        }) : null;
        // Explicit allowlist: no quote, summary, assessments, private review,
        // attachments/URLs, or clinical record payload on the home screen.
        const latest = message ? {
          id: message.id, sequence: message.sequence, authorId: message.authorId,
          type: message.type, createdAt: message.createdAt,
          body: Array.from(messagePreview({...message,
            attachments: message.hidden ? [] : previewAttachments({role:row.role},row.message.attachment_types)})).slice(0, 120).join(''),
          hidden: !!message.hidden, deleted: !!message.deleted, edited: !!message.edited,
        } : null;
        return { conversationId: row.conversation_id, childId: row.child_id,
          revision: Number(row.revision), lastRead: Number(row.last_read),
          unread: Number(row.unread), targetId: latest?.id ?? null, latest };
      });
      return { rooms, snapshot: result.snapshot, resetRequired: false,
        nextOffset: offset + rooms.length, hasMore: result.rooms.length > limit };
    });
  }

  async list(identity, input) {
    keys(input, ['conversationId', 'view', 'after', 'before', 'from', 'around', 'limit', 'expectedRevision']);
    const view = input.view;
    if (Object.hasOwn(input, 'view') && !['timeline', 'publications'].includes(view)) fail('INVALID_INPUT');
    keys(input, view === 'timeline'
      ? ['conversationId', 'view', 'after', 'before', 'from', 'around', 'limit', 'expectedRevision']
      : ['conversationId', ...(view ? ['view'] : []), 'after', 'limit', 'expectedRevision']);
    const selectors = ['before', 'after', 'from', 'around'].filter(key => Object.hasOwn(input, key));
    if (view === 'timeline') {
      if (selectors.length > 1) fail('INVALID_INPUT');
      if (selectors.length) selectors[0] === 'around' ? id(input.around) : count(input[selectors[0]]);
      if (Object.hasOwn(input, 'limit') && input.limit == null) fail('INVALID_INPUT');
    }
    const after = count(input.after ?? 0);
    const limit = input.limit ?? (view === 'timeline' ? 100 : 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    if (input.expectedRevision !== undefined) count(input.expectedRevision);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      // New sends, withdrawal, reshare and read/review changes all invalidate a
      // paged snapshot. A client must replace old projections, not append-only.
      if (input.expectedRevision !== undefined && input.expectedRevision !== scope.revision)
        return { revision: scope.revision, resetRequired: true };
      if (view === 'timeline') return this.#timeline(tx, scope, input, limit);
      if (view === 'publications') return this.#publications(tx, scope, after, limit);
      const { rows } = await tx.query(`SELECT m.id,m.sequence ${messageVisibilityFrom}
        WHERE m.center_id = $1 AND m.conversation_id = $2 AND m.sequence > $3 AND m.sequence >= $4
          AND ${sourceVisible('$4')} AND ${notHidden('$6')} AND ${messageVisibleSql('$7')}
        ORDER BY m.sequence LIMIT $5`, [scope.centerId, scope.roomId, after, scope.firstSequence, limit + 1, scope.userId, scope.role]);
      const messages = await this.#windowViews(tx, scope, rows.slice(0, limit));
      return {
        messages, ...await this.#readSummary(tx, scope), revision: scope.revision,
        nextCursor: messages.at(-1)?.sequence ?? after, hasMore: rows.length > limit, resetRequired: false,
      };
    });
  }

  async #readSummary(tx, scope) {
    const { rows: reads } = await tx.query(`SELECT sequence FROM cb_read_states
      WHERE center_id = $1 AND conversation_id = $2 AND user_id = $3`, [scope.centerId, scope.roomId, scope.userId]);
    const lastRead = Number(reads[0]?.sequence ?? 0);
    const { rows: counts } = await tx.query(`SELECT COUNT(*) AS unread ${messageVisibilityFrom}
      WHERE ${unreadWhere('$1', '$2', '$3', '$4', '$5', '$6')}`,
      [scope.centerId, scope.roomId, scope.userId, lastRead, scope.firstSequence, scope.role]);
    return { lastRead, unread: Number(counts[0].unread) };
  }

  async #windowViews(tx, scope, selected) {
    if (!selected.length) return [];
    // Materialize the bounded authorized set so the full projection cannot
    // accidentally plan quote joins across every message in a long history.
    const { rows } = await tx.query(`WITH selected AS MATERIALIZED (
      SELECT * FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND id=ANY($3::text[])
    ) ${messageSelect('selected')} ORDER BY m.sequence`,
      [scope.centerId, scope.roomId, selected.map(row => row.id)]);
    return this.views(tx, scope, rows);
  }

  async #publications(tx, scope, after, limit) {
    const { rows } = await tx.query(`SELECT m.id,m.sequence ${messageVisibilityFrom}
      JOIN cb_publications p ON (p.center_id,p.conversation_id,p.id)=(m.center_id,m.conversation_id,m.publication_id)
      WHERE ${visibleWhere('$1', '$2', '$3', '$4', '$5')}
        AND m.kind='publication' AND p.revoked_at IS NULL AND m.sequence>$6
      ORDER BY m.sequence LIMIT $7`, [scope.centerId, scope.roomId, scope.firstSequence, scope.userId, scope.role, after, limit + 1]);
    const messages = await this.#windowViews(tx, scope, rows.slice(0, limit));
    return { messages, ...await this.#readSummary(tx, scope), revision: scope.revision, resetRequired: false,
      nextCursor: messages.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }

  async #timeline(tx, scope, input, limit) {
    // Every page and existence probe uses the same visibility conditions and
    // locked room scope. A sequence cursor is navigation, never authority.
    const visible = visibleWhere('$1', '$2', '$3', '$4', '$5');
    const values = [scope.centerId, scope.roomId, scope.firstSequence, scope.userId, scope.role];
    let boundary = null, operator = '', descending = true;
    if (Object.hasOwn(input, 'around')) {
      // Exact authorized target: neither a self-hidden message nor an older
      // history/recipient-only source may silently fall back to latest.
      const { rows: targets } = await tx.query(`SELECT m.sequence ${messageVisibilityFrom}
        WHERE ${visible} AND m.id=$6`, [...values, input.around]);
      if (!targets.length) fail('NOT_FOUND');
      boundary = Number(targets[0].sequence); operator = '<=';
    } else if (Object.hasOwn(input, 'before')) { boundary = input.before; operator = '<'; }
    else if (Object.hasOwn(input, 'after')) { boundary = input.after; operator = '>'; descending = false; }
    else if (Object.hasOwn(input, 'from')) { boundary = input.from; operator = '>='; descending = false; }
    const pageValues = [...values, limit, ...(boundary === null ? [] : [boundary])];
    const { rows } = await tx.query(`SELECT m.id,m.sequence ${messageVisibilityFrom} WHERE ${visible}
      ${boundary === null ? '' : `AND m.sequence ${operator} $7`}
      ORDER BY m.sequence ${descending ? 'DESC' : 'ASC'} LIMIT $6`, pageValues);
    if (descending) rows.reverse();
    const messages = await this.#windowViews(tx, scope, rows);
    const start = messages[0]?.sequence ?? 0, end = messages.at(-1)?.sequence ?? 0;
    // Empty pages still describe their requested boundary: before the first
    // visible message may have newer content, and after the last may have older.
    const olderOperator = messages.length ? '<' : operator === '>' ? '<=' : '<';
    const newerOperator = messages.length ? '>' : operator === '<' ? '>=' : '>';
    const olderBoundary = messages.length ? start : boundary ?? 0;
    const newerBoundary = messages.length ? end : boundary ?? 0;
    const { rows: edges } = await tx.query(`SELECT
      EXISTS (SELECT 1 ${messageVisibilityFrom} WHERE ${visible} AND m.sequence ${olderOperator} $6) AS has_older,
      EXISTS (SELECT 1 ${messageVisibilityFrom} WHERE ${visible} AND m.sequence ${newerOperator} $7) AS has_newer`,
      [...values, olderBoundary, newerBoundary]);
    return { messages, ...await this.#readSummary(tx, scope), revision: scope.revision, resetRequired: false,
      window: { hasOlder: edges[0].has_older, hasNewer: edges[0].has_newer, startCursor: start, endCursor: end } };
  }

  async markRead(identity, input) {
    keys(input, ['conversationId', 'messageId']);
    id(input.messageId);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      const message = await this.row(tx, scope, input.messageId);
      const { rows } = await tx.query(`INSERT INTO cb_read_states(center_id, conversation_id, user_id, sequence)
        VALUES ($1,$2,$3,$4) ON CONFLICT (center_id, conversation_id, user_id) DO UPDATE
        SET sequence = EXCLUDED.sequence WHERE cb_read_states.sequence < EXCLUDED.sequence RETURNING sequence`,
        [scope.centerId, scope.roomId, scope.userId, message.sequence]);
      if (rows.length) await this.bumpRevision(tx, scope);
      const { rows: current } = await tx.query(`SELECT sequence FROM cb_read_states
        WHERE center_id = $1 AND conversation_id = $2 AND user_id = $3`, [scope.centerId, scope.roomId, scope.userId]);
      return { lastRead: Number(current[0].sequence) };
    });
  }

  async review(identity, input) {
    keys(input, ['conversationId', 'messageId', 'note', 'expectedRevision']);
    id(input.messageId);
    const note = text(input.note, 2000);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const message = await this.row(tx, scope, input.messageId);
      if (message.kind !== 'text') fail('INVALID_INPUT');
      if (message.text_operation==='all') fail('MESSAGE_DELETED');
      if (input.expectedRevision===undefined && message.text_revision!==1) fail('INVALID_INPUT');
      if (input.expectedRevision!==undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision<1)) fail('INVALID_INPUT');
      if (input.expectedRevision!==undefined && input.expectedRevision!==message.text_revision) fail('MESSAGE_CONFLICT');
      await this.#writeTextReview(tx, scope, message, note);
      return this.view(tx, scope, message);
    });
  }

  async textReview(identity, input) {
    keys(input, ['conversationId', 'messageId']);
    const messageId = id(input.messageId);
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const message = await this.row(tx, scope, messageId);
      if (message.kind !== 'text') fail('INVALID_INPUT');
      if (message.text_operation === 'all') fail('MESSAGE_DELETED');
      const { rows } = await tx.query(`SELECT message_revision, review_version, note FROM cb_message_reviews
        WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`, [scope.centerId, scope.roomId, messageId]);
      const review = rows[0];
      return { messageId, conversationId: scope.roomId, revision: message.text_revision,
        reviewVersion: review?.review_version ?? 0, reviewedRevision: review?.message_revision ?? null,
        note: review?.note ?? '', body: message.body, attachmentCount: message.attachment_types.length };
    });
  }

  async textReviewSave(identity, input) {
    keys(input, ['conversationId', 'messageId', 'clientId', 'expectedRevision', 'expectedReviewVersion', 'note']);
    const messageId = id(input.messageId), requestId = clientId(input.clientId);
    const expected = count(input.expectedRevision), expectedReview = count(input.expectedReviewVersion);
    if (expected < 1 || expected > 2147483647 || expectedReview > 2147483646 ||
        typeof input.note !== 'string' || !input.note.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input.note)) fail('INVALID_INPUT');
    const note = text(input.note, 2000);
    const requestHash = hash({ operation: 'review', messageId, expected, expectedReview, note });
    return this.inRoom(identity, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      // Current membership/history remain required, even for an old receipt.
      // A hidden/deleted source may acknowledge an exact committed request,
      // but must never be read or returned as part of that acknowledgement.
      const message = await this.row(tx, scope, messageId, true);
      const { rows: prior } = await tx.query(`SELECT conversation_id,request_hash,message_id,message_revision,review_version
        FROM cb_message_review_requests WHERE center_id=$1 AND actor_id=$2 AND client_id=$3`,
      [scope.centerId, scope.userId, requestId]);
      const receipt = (revision, reviewVersion, replayed) => ({ messageId, revision, reviewVersion, operation: 'review', replayed });
      if (prior.length) {
        if (prior[0].conversation_id !== scope.roomId || prior[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return receipt(prior[0].message_revision, prior[0].review_version, true);
      }
      await this.row(tx, scope, messageId); // Fresh work never unhides a source.
      if (message.kind !== 'text') fail('INVALID_INPUT');
      if (message.text_operation === 'all') fail('MESSAGE_DELETED');
      if (message.text_revision !== expected) fail('MESSAGE_CONFLICT');
      const reviewVersion = await this.#writeTextReview(tx, scope, message, note, expectedReview);
      await tx.query(`INSERT INTO cb_message_review_requests
        (center_id,conversation_id,actor_id,client_id,request_hash,message_id,message_revision,review_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [scope.centerId, scope.roomId, scope.userId, requestId, requestHash, messageId, expected, reviewVersion]);
      return receipt(expected, reviewVersion, false);
    });
  }

  // Legacy trusted callers keep their return/input contract, but participate
  // in the same monotonic private-note version as the strict HTTP command.
  async #writeTextReview(tx, scope, message, note, expectedReview) {
    const { rows } = await tx.query(`SELECT review_version FROM cb_message_reviews
      WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`, [scope.centerId, scope.roomId, message.id]);
    const previous = rows[0]?.review_version ?? 0;
    if (expectedReview !== undefined && previous !== expectedReview) fail('REVIEW_CONFLICT');
    if (previous === 2147483647) fail('REVISION_LIMIT');
    const { rows: saved } = await tx.query(`INSERT INTO cb_message_reviews
      (center_id,conversation_id,message_id,reviewer_id,note,message_revision,review_version)
      VALUES ($1,$2,$3,$4,$5,$6,1) ON CONFLICT (center_id,conversation_id,message_id) DO UPDATE
      SET note=EXCLUDED.note,reviewer_id=EXCLUDED.reviewer_id,message_revision=EXCLUDED.message_revision,
        review_version=cb_message_reviews.review_version+1
      WHERE cb_message_reviews.review_version=$7 RETURNING review_version`,
    [scope.centerId, scope.roomId, message.id, scope.userId, note, message.text_revision, previous]);
    if (!saved.length) fail('REVIEW_CONFLICT');
    await this.bumpRevision(tx, scope);
    await this.audit(tx, scope, 'message.reviewed');
    return saved[0].review_version;
  }
}
