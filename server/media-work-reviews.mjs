import { createHash,randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { Relationships } from './relationships.mjs';
import { Conversations } from './conversations.mjs';
import { currentCenterManager } from './center-access.mjs';
import { mediaResourceError } from './media-resource-policy.mjs';
const REASONS = ['ENGINE_RESTORED','STORAGE_RESTORED','CONFIGURATION_CORRECTED'];
const keys = (value,allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const id = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const uuid = (value) => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_INPUT'); return value; };
const integer = (value,min,max) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT'); return value; };
const operationalSelect = `SELECT q.conversation_id,q.upload_id,q.state,q.attempts,q.approved_retries,q.upload_version,
  u.failure_code,u.expires_at,u.expires_at <= clock_timestamp() AS expired,
  q.state = 'blocked' AND q.approved_retries < 3 AND u.state = 'quarantined' AND u.expires_at > clock_timestamp()
    AND limits.revision > 0 AND EXISTS (SELECT 1 FROM cb_media_objects WHERE key = q.source_key AND state = 'active')
    AND EXISTS (SELECT 1 FROM cb_participants p JOIN cb_memberships m ON (m.center_id,m.user_id,m.role) = (p.center_id,p.user_id,p.role)
      JOIN cb_users owner ON owner.id = p.user_id WHERE (p.center_id,p.conversation_id,p.user_id) = (q.center_id,q.conversation_id,u.owner_id)
        AND p.active AND m.active AND owner.active AND p.role IN ('therapist','guardian') AND u.created_sequence >= p.first_sequence) AS can_resume
  FROM cb_media_work_queue q JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (q.center_id,q.conversation_id,q.upload_id)
  JOIN cb_media_resource_limits limits ON limits.center_id = q.center_id`;
const project = (row) => ({ conversationId:row.conversation_id,uploadId:row.upload_id,state:row.state,attempts:row.attempts,
  approvedRetries:row.approved_retries,uploadVersion:row.upload_version,failureCode:row.failure_code,
  expiresAt:new Date(row.expires_at).toISOString(),expired:row.expired,canResume:row.can_resume });
const receipt = (row,replayed = false) => ({ reviewId:row.id,conversationId:row.conversation_id,uploadId:row.upload_id,
  attemptsBefore:row.attempts,approvedRetry:row.review_number,reason:row.reason,reviewedAt:new Date(row.reviewed_at).toISOString(),replayed });

// Operational retry administration only. No file names/bytes, clinical data,
// auto-approval, automatic loop, TTL extension or HTTP endpoint.
export class MediaWorkReviews {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('A transactional database is required.');
    this.database = database; this.relationships = new Relationships(database); this.conversations = new Conversations(database);
  }
  async list(actor,input = {}) {
    keys(input,['after','limit']); const limit = integer(input.limit ?? 50,1,100);
    if (input.after !== undefined) { keys(input.after,['conversationId','uploadId']); id(input.after.conversationId); uuid(input.after.uploadId); }
    return this.database.transaction(async (tx) => {
      const { centerId } = await currentCenterManager(tx,actor);
      const { rows } = await tx.query(`${operationalSelect} WHERE q.center_id = $1 AND q.state = 'blocked'
        AND (q.conversation_id,q.upload_id) > ($2,$3) ORDER BY q.conversation_id,q.upload_id LIMIT $4`,
      [centerId,input.after?.conversationId ?? '',input.after?.uploadId ?? '',limit+1]);
      const selected = rows.slice(0,limit),last = selected.at(-1);
      return { jobs:selected.map(project),hasMore:rows.length > limit,nextCursor:last ? { conversationId:last.conversation_id,uploadId:last.upload_id } : null };
    });
  }
  async get(actor,input) {
    keys(input,['conversationId','uploadId']); id(input.conversationId); uuid(input.uploadId);
    return this.relationships.inManagedRoom(actor,input.conversationId,async (tx,scope) => {
      const { rows } = await tx.query(`${operationalSelect} WHERE (q.center_id,q.conversation_id,q.upload_id) = ($1,$2,$3)`,[scope.centerId,scope.roomId,input.uploadId]);
      if (!rows.length) fail('NOT_FOUND'); return project(rows[0]);
    });
  }
  async resume(actor,input) {
    keys(input,['conversationId','uploadId','clientId','expectedUploadVersion','expectedAttempts','reason','confirmReinspection']);
    id(input.conversationId); uuid(input.uploadId);
    if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(input.clientId) || !REASONS.includes(input.reason) || input.confirmReinspection !== true) fail('INVALID_INPUT');
    integer(input.expectedUploadVersion,1,2147483647); integer(input.expectedAttempts,5,8);
    const requestHash = createHash('sha256').update(JSON.stringify([input.conversationId,input.uploadId,input.expectedUploadVersion,input.expectedAttempts,input.reason,true])).digest('hex');
    return this.relationships.inManagedRoom(actor,input.conversationId,async (tx,scope) => {
      const { rows: existing } = await tx.query('SELECT * FROM cb_media_work_reviews WHERE center_id = $1 AND reviewer_id = $2 AND client_id = $3',[scope.centerId,scope.userId,input.clientId]);
      if (existing.length) { if (existing[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT'); return receipt(existing[0],true); }
      const { rows: uploads } = await tx.query(`SELECT *,expires_at <= clock_timestamp() AS expired FROM cb_media_uploads
        WHERE (center_id,conversation_id,id) = ($1,$2,$3) FOR UPDATE`,[scope.centerId,scope.roomId,input.uploadId]);
      const { rows: jobs } = await tx.query(`SELECT * FROM cb_media_work_queue WHERE (center_id,conversation_id,upload_id) = ($1,$2,$3) FOR UPDATE`,[scope.centerId,scope.roomId,input.uploadId]);
      if (!uploads.length || !jobs.length) fail('NOT_FOUND'); const upload = uploads[0],job = jobs[0];
      if (upload.version !== input.expectedUploadVersion || job.attempts !== input.expectedAttempts) fail('MEDIA_REVIEW_CONFLICT');
      if (job.state !== 'blocked' || upload.state !== 'quarantined') fail('MEDIA_REVIEW_NOT_REQUIRED');
      if (upload.expired) fail('UPLOAD_EXPIRED'); if (job.approved_retries >= 3) fail('MEDIA_REVIEW_LIMIT');
      try {
        await this.conversations.inRoomTransaction(tx,{ centerId:scope.centerId,userId:upload.owner_id },scope.roomId,async (inner,owner) => {
          if (Number(upload.created_sequence) < owner.firstSequence) fail('NOT_FOUND');
          const source = await inner.query("SELECT 1 FROM cb_media_objects WHERE key = $1 AND state = 'active'",[upload.object_key]);
          if (!source.rows.length) fail('NOT_FOUND');
        });
      } catch (error) { if (error.code === 'NOT_FOUND') fail('MEDIA_OWNER_UNAVAILABLE'); throw error; }
      const { rows: policies } = await tx.query('SELECT * FROM cb_media_lock_resources($1)',[scope.centerId]);
      if (policies[0].revision === 0) fail('MEDIA_RESOURCES_UNCONFIGURED');
      const { rows } = await tx.query(`INSERT INTO cb_media_work_reviews(center_id,conversation_id,id,upload_id,reviewer_id,client_id,request_hash,
        upload_version,attempts,review_number,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [scope.centerId,scope.roomId,randomUUID(),upload.id,scope.userId,input.clientId,requestHash,upload.version,job.attempts,job.approved_retries+1,input.reason]);
      await tx.query(`UPDATE cb_media_work_queue SET state = 'retry',approved_retries = approved_retries + 1,last_review_id = $4
        WHERE (center_id,conversation_id,upload_id) = ($1,$2,$3)`,[scope.centerId,scope.roomId,upload.id,rows[0].id]);
      return receipt(rows[0]);
    }).catch((error) => {
      if (error.code === '23505' && error.constraint === 'cb_media_review_request_id') fail('IDEMPOTENCY_CONFLICT');
      return mediaResourceError(error);
    });
  }
}
