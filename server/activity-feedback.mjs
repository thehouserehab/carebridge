import { createHash } from 'node:crypto';
import { feedbackFields } from '../src/feedback-fields.js';
import { Conversations } from './conversations.mjs';
import { fail } from './errors.mjs';
import { attachmentInput, bindAttachments } from './media-bindings.mjs';
import { requireSharedCareAccess } from './conversation-visibility.mjs';

const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const clientId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const version = (value, minimum = 0) => {
  if (!Number.isInteger(value) || value < minimum || value > 2147483647) fail('INVALID_INPUT');
  return value;
};
const advance = (value) => {
  if (value === 2147483647) fail('REVISION_LIMIT');
  return value + 1;
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (row, replayed) => ({ feedbackId: row.feedback_id, revision: row.feedback_revision,
  reviewVersion: row.review_version, messageId: row.message_id, operation: row.operation, replayed });

function content(input) {
  keys(input, ['date', 'result', 'reaction', 'difficulty', 'attachments']);
  for (const key of ['reaction', 'difficulty'])
    if (input[key] != null && (typeof input[key] !== 'string' || input[key].length > 1000)) fail('INVALID_INPUT');
  const attachments = attachmentInput(input.attachments);
  try { return { ...feedbackFields(input), ...(attachments.length ? { attachments } : {}) }; }
  catch { fail('INVALID_INPUT'); }
}

// Internal persistence service, not an HTTP endpoint. Identity must be supplied
// by the authenticated server session; active membership is rechecked per call.
export class ActivityFeedback {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('ActivityFeedback requires a transactional database.');
    this.conversations = new Conversations(database);
  }

  inRoom(actor, roomId, work) {
    return this.conversations.inRoom(actor, roomId, (tx,scope) => {
      requireSharedCareAccess(scope);
      return work(tx,scope);
    }).catch((error) => {
      if (error.code === '23505' && error.constraint === 'cb_feedback_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
      throw error;
    });
  }

  async message(tx, scope, feedbackId) {
    const { rows } = await tx.query(`SELECT id FROM cb_messages
      WHERE center_id = $1 AND conversation_id = $2 AND feedback_id = $3`,
    [scope.centerId, scope.roomId, feedbackId]);
    if (!rows.length) fail('NOT_FOUND');
    return this.conversations.row(tx, scope, rows[0].id);
  }

  async duplicate(tx, scope, requestId, requestHash) {
    const { rows } = await tx.query(`SELECT conversation_id, request_hash, feedback_id,
        feedback_revision, review_version, message_id, operation FROM cb_feedback_requests
      WHERE center_id = $1 AND actor_id = $2 AND client_id = $3`, [scope.centerId, scope.userId, requestId]);
    if (!rows.length) return null;
    if (rows[0].conversation_id !== scope.roomId || rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
    await this.conversations.row(tx, scope, rows[0].message_id);
    return receipt(rows[0], true);
  }

  async remember(tx, scope, requestId, requestHash, operation, feedbackId, revision, reviewVersion, messageId) {
    await tx.query(`INSERT INTO cb_feedback_requests
      (center_id, conversation_id, actor_id, client_id, request_hash, operation,
       feedback_id, feedback_revision, review_version, message_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [scope.centerId, scope.roomId, scope.userId, requestId, requestHash, operation,
      feedbackId, revision, reviewVersion, messageId]);
    return { feedbackId, revision, reviewVersion, messageId, operation, replayed: false };
  }

  async save(actor, input) {
    keys(input, ['conversationId', 'feedbackId', 'sourceMessageId', 'clientId', 'expectedRevision', 'content']);
    const feedbackId = id(input.feedbackId), sourceId = id(input.sourceMessageId), requestId = clientId(input.clientId);
    const expected = version(input.expectedRevision), data = content(input.content);
    const requestHash = hash({ operation: 'save', feedbackId, sourceId, expected, data });
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'guardian') fail('FORBIDDEN');
      const prior = await this.duplicate(tx, scope, requestId, requestHash);
      if (prior) return prior;
      const source = await this.conversations.row(tx, scope, sourceId);
      if (source.kind !== 'publication') fail('INVALID_INPUT');
      if (source.revoked_at) fail('PUBLICATION_CLOSED');
      const { rows: snapshots } = await tx.query(`SELECT activity FROM cb_record_publications
        WHERE center_id = $1 AND conversation_id = $2 AND publication_id = $3`,
      [scope.centerId, scope.roomId, source.publication_id]);
      if (!snapshots[0]?.activity) fail('NO_ACTIVITY');

      const { rows } = await tx.query(`SELECT author_id, publication_id, current_revision FROM cb_activity_feedback
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId, scope.roomId, feedbackId]);
      const old = rows[0];
      let card;
      if (old) {
        card = await this.message(tx, scope, feedbackId);
        if (old.author_id !== scope.userId) fail('FORBIDDEN');
        if (old.publication_id !== source.publication_id) fail('INVALID_INPUT');
      }
      if ((old?.current_revision ?? 0) !== expected) fail('FEEDBACK_CONFLICT');
      const revision = advance(expected);
      if (!old) await tx.query(`INSERT INTO cb_activity_feedback
        (center_id, conversation_id, id, publication_id, author_id, current_revision) VALUES ($1,$2,$3,$4,$5,$6)`,
      [scope.centerId, scope.roomId, feedbackId, source.publication_id, scope.userId, revision]);
      else await tx.query(`UPDATE cb_activity_feedback SET current_revision = $4
        WHERE center_id = $1 AND conversation_id = $2 AND id = $3`, [scope.centerId, scope.roomId, feedbackId, revision]);
      await tx.query(`INSERT INTO cb_feedback_revisions
        (center_id, conversation_id, feedback_id, revision, activity_date, result, reaction, difficulty, attachments_sealed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
      [scope.centerId, scope.roomId, feedbackId, revision, data.date, data.result, data.reaction, data.difficulty]);
      await bindAttachments(tx, scope, 'feedback', feedbackId, revision, data.attachments ?? []);
      await tx.query(`UPDATE cb_feedback_revisions SET attachments_sealed = true
        WHERE center_id = $1 AND conversation_id = $2 AND feedback_id = $3 AND revision = $4`,[scope.centerId,scope.roomId,feedbackId,revision]);
      if (old) {
        await this.conversations.bumpRevision(tx, scope);
        await this.conversations.audit(tx, scope, 'feedback.updated');
      } else card = await this.conversations.insert(tx, scope, requestId, requestHash, { kind: 'feedback', feedbackId });
      return this.remember(tx, scope, requestId, requestHash, 'save', feedbackId, revision, null, card.id);
    });
  }

  async get(actor, input) {
    keys(input, ['conversationId', 'feedbackId', 'revision']);
    const feedbackId = id(input.feedbackId);
    if (input.revision !== undefined) version(input.revision, 1);
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      const card = await this.message(tx, scope, feedbackId);
      if (input.revision !== undefined) {
        if (scope.role !== 'therapist') fail('FORBIDDEN');
        const { rows } = await tx.query(`SELECT revision AS feedback_revision, activity_date::text AS feedback_date,
            result AS feedback_result, reaction AS feedback_reaction, difficulty AS feedback_difficulty,
            created_at AS feedback_updated_at FROM cb_feedback_revisions
          WHERE center_id = $1 AND conversation_id = $2 AND feedback_id = $3 AND revision = $4`,
        [scope.centerId, scope.roomId, feedbackId, input.revision]);
        if (!rows.length) fail('NOT_FOUND');
        Object.assign(card, rows[0]);
      }
      return this.conversations.view(tx, scope, card);
    });
  }

  async review(actor, input) {
    keys(input, ['conversationId', 'feedbackId', 'clientId', 'expectedRevision', 'expectedReviewVersion', 'note']);
    const feedbackId = id(input.feedbackId), requestId = clientId(input.clientId);
    const expected = version(input.expectedRevision, 1), expectedReview = version(input.expectedReviewVersion);
    if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000) fail('INVALID_INPUT');
    const note = input.note.trim();
    const requestHash = hash({ operation: 'review', feedbackId, expected, expectedReview, note });
    return this.inRoom(actor, input.conversationId, async (tx, scope) => {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const prior = await this.duplicate(tx, scope, requestId, requestHash);
      if (prior) return prior;
      const card = await this.message(tx, scope, feedbackId);
      if (card.feedback_revision !== expected) fail('FEEDBACK_CONFLICT');
      const { rows } = await tx.query(`SELECT COALESCE(MAX(review_version), 0) AS version FROM cb_feedback_reviews
        WHERE center_id = $1 AND conversation_id = $2 AND feedback_id = $3 AND feedback_revision = $4`,
      [scope.centerId, scope.roomId, feedbackId, expected]);
      if (rows[0].version !== expectedReview) fail('REVIEW_CONFLICT');
      const reviewVersion = advance(expectedReview);
      await tx.query(`INSERT INTO cb_feedback_reviews
        (center_id, conversation_id, feedback_id, feedback_revision, review_version, reviewer_id, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [scope.centerId, scope.roomId, feedbackId, expected, reviewVersion, scope.userId, note]);
      await this.conversations.bumpRevision(tx, scope);
      await this.conversations.audit(tx, scope, 'feedback.reviewed');
      return this.remember(tx, scope, requestId, requestHash, 'review', feedbackId, expected, reviewVersion, card.id);
    });
  }
}
