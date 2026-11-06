import { MEDIA_LIMITS } from '../src/media-policy.js';
import { fail } from './errors.mjs';
import { hasSharedCareAccess, requireSharedCareAccess } from './conversation-visibility.mjs';

export const attachmentId = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
// Request metadata contains IDs only. Names/type/size always come from the
// immutable server manifest; record sharing is opt-in, never inferred.
export function attachmentInput(value = [], record = false) {
  if (!Array.isArray(value) || value.length > MEDIA_LIMITS.count) fail('INVALID_INPUT');
  const result = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !(record ? ['id','share'] : ['id']).includes(key)) ||
        (item.share !== undefined && typeof item.share !== 'boolean')) fail('INVALID_INPUT');
    return { id:attachmentId(item.id), ...(record ? { share:item.share ?? false } : {}) };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) fail('INVALID_INPUT');
  return result;
}
const origins = { message:'bound_message_id',record:'bound_record_id',feedback:'bound_feedback_id' };
export async function bindAttachments(tx, scope, kind, targetId, revision, items) {
  if (!origins[kind]) throw new TypeError('Unsupported file origin.');
  if (!items.length) return;
  requireSharedCareAccess(scope);
  const { rows } = await tx.query(`SELECT *, expires_at <= clock_timestamp() AS expired FROM cb_media_uploads
    WHERE center_id = $1 AND conversation_id = $2 AND id = ANY($3::text[]) ORDER BY id FOR UPDATE`,
  [scope.centerId,scope.roomId,items.map((item) => item.id)]);
  if (rows.length !== items.length) fail('ATTACHMENT_NOT_FOUND');
  if (rows.reduce((sum,row) => sum + Math.max(row.size,row.prepared_size ?? 0),0) > MEDIA_LIMITS.total) fail('ATTACHMENT_LIMIT');
  const byId = new Map(rows.map((row) => [row.id,row]));
  for (const row of rows) {
    if (row.state === 'bound') {
      if (row[origins[kind]] !== targetId) fail('ATTACHMENT_ORIGIN_CONFLICT');
      // The caller has already authorized the parent record/card and history.
      // Same-origin immutable revisions may reuse files from earlier revisions.
      continue;
    }
    if (row.owner_id !== scope.userId || Number(row.created_sequence) < scope.firstSequence) fail('ATTACHMENT_NOT_FOUND');
    if (row.expired) fail('UPLOAD_EXPIRED');
    if (row.state !== 'ready') fail('ATTACHMENT_NOT_READY');
    if (row.version === 2147483647) fail('REVISION_LIMIT');
    await tx.query(`UPDATE cb_media_uploads SET state = 'bound',version = version + 1,${origins[kind]} = $4
      WHERE center_id = $1 AND conversation_id = $2 AND id = $3`,[scope.centerId,scope.roomId,row.id,targetId]);
  }
  for (const [ordinal,item] of items.entries()) {
    const row = byId.get(item.id);
    if (kind === 'message') await tx.query(`INSERT INTO cb_message_attachments(center_id,conversation_id,message_id,ordinal,upload_id)
      VALUES ($1,$2,$3,$4,$5)`,[scope.centerId,scope.roomId,targetId,ordinal,row.id]);
    else if (kind === 'record') await tx.query(`INSERT INTO cb_record_attachments(center_id,conversation_id,record_id,revision,ordinal,upload_id,share)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[scope.centerId,scope.roomId,targetId,revision,ordinal,row.id,item.share]);
    else await tx.query(`INSERT INTO cb_feedback_attachments(center_id,conversation_id,feedback_id,revision,ordinal,upload_id)
      VALUES ($1,$2,$3,$4,$5,$6)`,[scope.centerId,scope.roomId,targetId,revision,ordinal,row.id]);
  }
}
export async function recordAttachments(tx, scope, recordId, revision) {
  requireSharedCareAccess(scope);
  const { rows } = await tx.query(`SELECT u.id,u.name,u.type,COALESCE(u.prepared_size,u.size) AS size,a.share FROM cb_record_attachments a JOIN cb_media_uploads u
    ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
    WHERE a.center_id = $1 AND a.conversation_id = $2 AND a.record_id = $3 AND a.revision = $4 ORDER BY a.ordinal`,
  [scope.centerId,scope.roomId,recordId,revision]);
  return rows;
}
export async function publishAttachments(tx, scope, publicationId, recordId, revision) {
  requireSharedCareAccess(scope);
  await tx.query(`INSERT INTO cb_publication_attachments(center_id,conversation_id,publication_id,record_id,record_revision,ordinal,upload_id)
    SELECT center_id,conversation_id,$3,record_id,revision,ordinal,upload_id FROM cb_record_attachments
    WHERE center_id = $1 AND conversation_id = $2 AND record_id = $4 AND revision = $5 AND share ORDER BY ordinal`,
  [scope.centerId,scope.roomId,publicationId,recordId,revision]);
}

export async function messageAttachments(tx, scope, messages) {
  if (!hasSharedCareAccess(scope)) return new Map();
  const visible = messages.filter((row) => row.text_operation!=='all' &&
    (scope.role !== 'guardian' || !row.revoked_at || row.kind === 'text'));
  const result = new Map();
  if (!visible.length) return result;
  // One batch for all message/card kinds, including an explicitly requested
  // feedback revision. Guardian projection never joins clinical record text.
  const { rows } = await tx.query(`WITH wanted AS (
    SELECT * FROM unnest($3::text[],$4::text[],$5::integer[]) AS x(message_id,feedback_id,feedback_revision)
  ), links AS (
    SELECT a.message_id,a.ordinal,a.upload_id FROM cb_message_attachments a WHERE a.center_id = $1 AND a.conversation_id = $2 AND a.message_id = ANY($3::text[])
    UNION ALL SELECT m.id,a.ordinal,a.upload_id FROM cb_publication_attachments a JOIN cb_messages m
      ON (m.center_id,m.conversation_id,m.publication_id) = (a.center_id,a.conversation_id,a.publication_id)
      WHERE a.center_id = $1 AND a.conversation_id = $2 AND m.id = ANY($3::text[])
    UNION ALL SELECT w.message_id,a.ordinal,a.upload_id FROM cb_feedback_attachments a JOIN wanted w
      ON (w.feedback_id,w.feedback_revision) = (a.feedback_id,a.revision) WHERE a.center_id = $1 AND a.conversation_id = $2
  ) SELECT l.message_id,u.id,u.name,u.type,COALESCE(u.prepared_size,u.size) AS size,true AS share FROM links l JOIN cb_media_uploads u
    ON (u.center_id,u.conversation_id,u.id) = ($1,$2,l.upload_id) ORDER BY l.message_id,l.ordinal`,
  [scope.centerId,scope.roomId,visible.map((row) => row.id),visible.map((row) => row.feedback_id ?? null),visible.map((row) => row.feedback_revision ?? null)]);
  for (const { message_id, ...file } of rows) {
    if (!result.has(message_id)) result.set(message_id,[]);
    result.get(message_id).push(file);
  }
  return result;
}
