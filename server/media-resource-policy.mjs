import { fail } from './errors.mjs';
import { currentCenterManager } from './center-access.mjs';
export function mediaResourceError(error) {
  if (error.code === '23514') {
    const code = { cb_media_resource_configured:'MEDIA_RESOURCES_UNCONFIGURED',cb_media_resource_paused:'CENTER_MEDIA_PAUSED',
      cb_media_resource_rate:'CENTER_MEDIA_RATE',cb_media_resource_capacity:'CENTER_MEDIA_CAPACITY',cb_media_resource_backlog:'CENTER_MEDIA_BACKLOG' }[error.constraint];
    if (code) fail(code);
  }
  throw error;
}
const project = (row,usage) => ({ configured:row.revision > 0,revision:row.revision,acceptingUploads:row.accepting_uploads,
  limits:row.revision > 0 ? { storageBytes:Number(row.storage_bytes),pendingUploads:row.pending_uploads,
    uploadsPerWindow:row.uploads_per_window,windowMilliseconds:row.window_milliseconds } : null,
  usage:{ reservedBytes:Number(usage.reserved_bytes),pendingUploads:Number(usage.pending_count) } });

// Internal administrative service only, not an HTTP route or billing plan.
// Identity must originate from the verified session. Center-wide aggregates
// contain no child/file/message identifiers, names, hashes or clinical bytes.
export class MediaResourcePolicy {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('A transactional database is required.');
    this.database = database;
  }
  async inCenter(actor,work) {
    return this.database.transaction(async (tx) => {
      const { centerId } = await currentCenterManager(tx,actor);
      const policy = (await tx.query('SELECT * FROM cb_media_lock_resources($1)',[centerId])).rows[0];
      return work(tx,centerId,policy);
    }).catch(mediaResourceError);
  }
  async get(actor) {
    return this.inCenter(actor,async (tx,centerId,policy) => project(policy,(await tx.query('SELECT * FROM cb_media_resource_usage($1)',[centerId])).rows[0]));
  }
  async configure(actor,input) {
    const allowed = ['expectedRevision','storageBytes','pendingUploads','uploadsPerWindow','windowMilliseconds','acceptingUploads'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== allowed.length ||
      allowed.some((key) => !Object.hasOwn(input,key)) || typeof input.acceptingUploads !== 'boolean') fail('INVALID_INPUT');
    for (const [key,min,max] of [['expectedRevision',0,2147483646],['storageBytes',0,Number.MAX_SAFE_INTEGER],
      ['pendingUploads',0,1000000],['uploadsPerWindow',0,1000000],['windowMilliseconds',50,86400000]])
      if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) fail('INVALID_INPUT');
    return this.inCenter(actor,async (tx,centerId,policy) => {
      if (policy.revision !== input.expectedRevision) fail('MEDIA_POLICY_CONFLICT');
      const { rows } = await tx.query(`UPDATE cb_media_resource_limits SET revision = revision + 1,storage_bytes = $2,
        pending_uploads = $3,uploads_per_window = $4,window_milliseconds = $5,accepting_uploads = $6 WHERE center_id = $1 RETURNING *`,
      [centerId,input.storageBytes,input.pendingUploads,input.uploadsPerWindow,input.windowMilliseconds,input.acceptingUploads]);
      return project(rows[0],(await tx.query('SELECT * FROM cb_media_resource_usage($1)',[centerId])).rows[0]);
    });
  }
}
