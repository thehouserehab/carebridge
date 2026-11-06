import { createHash, randomUUID } from 'node:crypto';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media-policy.js';
import { Conversations } from './conversations.mjs';
import { fail, RepositoryError } from './errors.mjs';
import { Readable } from 'node:stream';
import { MediaPreparation } from './media-preparation.mjs';
import { preparedCandidate,preparationRejection } from './media-preparation-evidence.mjs';
import { servingFile } from './media-serving.mjs';
import { nextMediaWork } from './media-work-queue.mjs';
import { mediaResourceError } from './media-resource-policy.mjs';
import { captureMediaWorkerObserver,observeMediaStage } from './media-worker-observation.mjs';
import { requireSharedCareAccess } from './conversation-visibility.mjs';

const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const uploadId = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const version = (value) => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('INVALID_INPUT'); return value; };
const manifest = (input) => {
  keys(input, ['name','type','size','sha256']);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255 || !input.name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(input.name) ||
      !MEDIA_TYPES.includes(input.type) || !Number.isInteger(input.size) || input.size < 1 ||
      input.size > (input.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video) ||
      typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) fail('INVALID_INPUT');
  return { name:input.name.trim(), type:input.type, size:input.size, sha256:input.sha256 };
};
const publicState = (row) => ({ id:row.id, conversationId:row.conversation_id, name:row.name, type:row.type,
  size:row.prepared_size ?? row.size, state:row.state, version:row.version, failureCode:row.failure_code,
  expiresAt:row.state === 'bound' ? null : new Date(row.expires_at).toISOString(), expired:row.expired });
const selectUpload = `SELECT *, state <> 'bound' AND expires_at <= clock_timestamp() AS expired, lease_until <= clock_timestamp() AS lease_expired FROM cb_media_uploads`;
// Internal staging service only. Bound files use MediaAccess with an authorized
// origin/snapshot. Only explicitly configured full preparation can approve new
// files; a scan-only/decode-only adapter is never a fallback approval route.
export class MediaUploads {
  #onStage;
  constructor(database, store, { preparation = null, scanner = null, ttlMilliseconds = 86400000, leaseMilliseconds = 300000, operationTimeoutMilliseconds = 120000,onStage = null } = {}) {
    if (!database?.transaction || !store?.write || !store?.openVerified || !store?.remove) throw new TypeError('Transactional database and private object store are required.');
    for (const number of [ttlMilliseconds,leaseMilliseconds,operationTimeoutMilliseconds])
      if (!Number.isSafeInteger(number) || number < 50 || number > 86400000) throw new TypeError('Invalid media operation duration.');
    if (operationTimeoutMilliseconds >= leaseMilliseconds || scanner !== null || (preparation !== null && !(preparation instanceof MediaPreparation)))
      throw new TypeError('Explicit full media preparation and a longer operation lease are required.');
    Object.assign(this,{ database,store,preparation,ttlMilliseconds,leaseMilliseconds,operationTimeoutMilliseconds });
    this.#onStage = captureMediaWorkerObserver(onStage);
    this.conversations = new Conversations(database);
  }

  inRoom(actor, roomId, work) {
    return this.conversations.inRoom(actor,roomId,(tx,scope) => {
      requireSharedCareAccess(scope);
      return work(tx,scope);
    }).catch((error) => {
      if (error.code === '23505' && error.constraint === 'cb_media_request_id') fail('IDEMPOTENCY_CONFLICT');
      mediaResourceError(error);
    });
  }
  async owned(tx, scope, id) {
    const { rows } = await tx.query(`${selectUpload} WHERE center_id = $1 AND conversation_id = $2 AND id = $3
      AND owner_id = $4 AND created_sequence >= $5 FOR UPDATE`, [scope.centerId,scope.roomId,id,scope.userId,scope.firstSequence]);
    if (!rows.length) fail('NOT_FOUND');
    return rows[0];
  }
  async update(tx, scope, row, { state, objectKey = row.object_key, leaseId = null, leaseUntil = null, report = row.scan_report, failure = null,
    candidateKey = row.candidate_key,preparationId = row.preparation_id,preparedSize = row.prepared_size,preparedSha256 = row.prepared_sha256 }) {
    if (row.version === 2147483647) fail('REVISION_LIMIT');
    const { rows } = await tx.query(`UPDATE cb_media_uploads SET version = version + 1,state = $4,object_key = $5,
      lease_id = $6,lease_until = $7,scan_report = $8,failure_code = $9,candidate_key = $10,preparation_id = $11,prepared_size = $12,prepared_sha256 = $13
      WHERE center_id = $1 AND conversation_id = $2 AND id = $3 RETURNING *,expires_at <= clock_timestamp() AS expired`,
    [scope.centerId,scope.roomId,row.id,state,objectKey,leaseId,leaseUntil,report ? JSON.stringify(report) : null,failure,
      candidateKey,preparationId,preparedSize,preparedSha256]);
    return rows[0];
  }

  async reserve(actor, input) {
    keys(input,['conversationId','clientId','file']);
    if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(input.clientId)) fail('INVALID_INPUT');
    const file = manifest(input.file), requestHash = createHash('sha256').update(JSON.stringify(file)).digest('hex');
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      const { rows: existing } = await tx.query(`${selectUpload} WHERE center_id = $1 AND owner_id = $2 AND client_id = $3`,
        [scope.centerId,scope.userId,input.clientId]);
      if (existing.length) {
        const row = existing[0];
        if (row.conversation_id !== scope.roomId || row.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        if (Number(row.created_sequence) < scope.firstSequence) fail('NOT_FOUND');
        return { ...publicState(row), replayed:true };
      }
      // Unbound staging budget, not per-record attachment limits. Room locking
      // serializes the room/owner quota without account lock upgrades.
      const { rows: quota } = await tx.query(`SELECT count(*)::integer AS count,COALESCE(sum(size),0)::bigint AS bytes FROM cb_media_uploads
        WHERE center_id = $1 AND conversation_id = $2 AND owner_id = $3 AND state NOT IN ('bound','rejected','delete_pending','deleted')`,
      [scope.centerId,scope.roomId,scope.userId]);
      if (quota[0].count >= 24 || Number(quota[0].bytes) + file.size > 3 * MEDIA_LIMITS.total) fail('UPLOAD_QUOTA');
      const { rows: counter } = await tx.query(`UPDATE cb_conversations SET last_sequence = last_sequence + 1
        WHERE center_id = $1 AND id = $2 RETURNING last_sequence`,[scope.centerId,scope.roomId]);
      const { rows } = await tx.query(`INSERT INTO cb_media_uploads
        (center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp() + $12 * interval '1 millisecond')
        RETURNING *,false AS expired`,[scope.centerId,scope.roomId,randomUUID(),scope.userId,input.clientId,requestHash,
        file.name,file.type,file.size,file.sha256,counter[0].last_sequence,this.ttlMilliseconds]);
      return { ...publicState(rows[0]), replayed:false };
    });
  }

  async get(actor, input) {
    keys(input,['conversationId','uploadId']); uploadId(input.uploadId);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => publicState(await this.owned(tx,scope,input.uploadId)));
  }

  // A transformed candidate may have a different size. Keep the immutable
  // original metadata separate so a lost reserve/receive response can still
  // be matched to the selected file. Never expose hashes, paths or evidence.
  async getTransferState(actor, input) {
    keys(input,['conversationId','uploadId']); uploadId(input.uploadId);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      const row = await this.owned(tx,scope,input.uploadId);
      return { upload:publicState(row), source:{ name:row.name,type:row.type,size:row.size } };
    });
  }

  async claim(actor, input, operation) {
    if (!['receive','inspect'].includes(operation)) fail('INVALID_INPUT');
    keys(input,['conversationId','uploadId','expectedVersion']); uploadId(input.uploadId); version(input.expectedVersion);
    return this.inRoom(actor,input.conversationId,(tx,scope) => this.#claim(tx,scope,input,operation));
  }
  async #claim(tx,scope,input,operation,queueOnly = false) {
    requireSharedCareAccess(scope);
    const row = await this.owned(tx,scope,input.uploadId);
    // Re-evaluate the hint after the room lock; another transaction may
    // have completed/cancelled/delayed this job since the SELECT snapshot.
    if (queueOnly && (row.state !== 'quarantined' || row.expired)) return null;
    if (row.state === 'bound') fail('FILE_IN_USE');
    if (!queueOnly && row.version !== input.expectedVersion) fail('UPLOAD_CONFLICT');
    if (row.expired) fail('UPLOAD_EXPIRED');
    const stage = operation === 'receive' ? 'receiving' : 'inspecting';
    if (row.state !== (operation === 'receive' ? 'pending' : 'quarantined') && !(row.state === stage && row.lease_expired)) fail('UPLOAD_STATE');
    if (operation === 'inspect') {
      const { rows: work } = await tx.query(`SELECT attempts,approved_retries,state,available_at <= clock_timestamp() AS due FROM cb_media_work_queue WHERE
        (center_id,conversation_id,upload_id) = ($1,$2,$3) FOR UPDATE`,[scope.centerId,scope.roomId,row.id]);
      if (work.length !== 1) fail('UPLOAD_STATE');
      if (queueOnly && (!['queued','retry'].includes(work[0].state) || !work[0].due)) return null;
      if (work[0].attempts >= 5 + work[0].approved_retries) fail('UPLOAD_ATTEMPTS_EXHAUSTED');
    }
    const leaseId = randomUUID(), objectKey = operation === 'receive' ? randomUUID() : row.object_key;
    const candidateKey = operation === 'receive' ? null : randomUUID();
    if (operation === 'receive') {
      if (row.object_key) await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1 AND state = 'active'`,[row.object_key]);
      await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4)`,[objectKey,scope.centerId,scope.roomId,row.id]);
    }
    if (operation === 'inspect') {
      if (row.candidate_key) await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1 AND state = 'active'`,[row.candidate_key]);
      // A committed write intent exists BEFORE any candidate file IO.
      await tx.query(`INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4)`,[candidateKey,scope.centerId,scope.roomId,row.id]);
    }
    const { rows: clock } = await tx.query(`SELECT clock_timestamp() + $1 * interval '1 millisecond' AS lease_until`,[this.leaseMilliseconds]);
    return this.update(tx,scope,row,{ state:stage,objectKey,candidateKey,leaseId,leaseUntil:clock[0].lease_until });
  }

  // Trusted queue/test-driver primitive. Identity comes only from the stored
  // upload owner, not a session token, request body or caller-selected role.
  async claimNextInspection() {
    return this.database.transaction(async (tx) => {
      const next = await nextMediaWork(tx); if (!next) return null;
      const actor = { centerId:next.center_id,userId:next.owner_id };
      const claimed = await this.conversations.inRoomTransaction(tx,actor,next.conversation_id,
        (inner,scope) => this.#claim(inner,scope,{ uploadId:next.upload_id },'inspect',true));
      if (!claimed) return null;
      return { actor,conversationId:next.conversation_id,claimed };
    }).catch((error) => {
      // Capacity may change after the eligibility snapshot. Roll back the
      // attempt/intent before any file IO; the worker can clean up and retry.
      if (error.code === '23514' && ['cb_media_resource_capacity','cb_media_resource_configured'].includes(error.constraint)) return null;
      return mediaResourceError(error);
    });
  }

  async settle(actor, roomId, claimed, result) {
    // Public staging helpers are not an approval shortcut. Only inspect's
    // private completion path can use already persisted candidate evidence.
    if (result?.state === 'ready') fail('SCAN_INVALID');
    return this.#settle(actor,roomId,claimed,result);
  }
  async #settle(actor, roomId, claimed, result) {
    return this.inRoom(actor,roomId,async (tx,scope) => {
      const row = await this.owned(tx,scope,claimed.id);
      if (row.version !== claimed.version || row.lease_id !== claimed.lease_id || row.state !== claimed.state || row.lease_expired) fail('UPLOAD_CONFLICT');
      if (row.expired) fail('UPLOAD_EXPIRED');
      if (claimed.state === 'receiving' && result.state !== 'quarantined') {
        await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1 AND state = 'active'`,[row.object_key]);
        result.objectKey = null;
      }
      if (claimed.state === 'inspecting') {
        if (result.state === 'ready') {
          const evidence = result.evidence,preparationId = randomUUID();
          if (!evidence || !row.candidate_key) fail('SCAN_INVALID');
          await tx.query(`INSERT INTO cb_media_preparations
            (id,center_id,conversation_id,upload_id,upload_version,lease_id,source_key,derivative_key,type,source_size,derivative_size,source_sha256,derivative_sha256,evidence)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [preparationId,scope.centerId,scope.roomId,row.id,row.version,row.lease_id,row.object_key,row.candidate_key,row.type,row.size,
            evidence.derivative.size,row.sha256,evidence.derivative.sha256,JSON.stringify(evidence)]);
          result = { ...result,preparationId,preparedSize:evidence.derivative.size,preparedSha256:evidence.derivative.sha256 };
        } else {
          await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1 AND state = 'active'`,[row.candidate_key]);
          result = { ...result,candidateKey:null };
        }
      }
      return publicState(await this.update(tx,scope,row,result));
    });
  }

  async receive(actor, input, stream) {
    if (!stream || typeof stream.pipe !== 'function') fail('INVALID_INPUT');
    const claimed = await this.claim(actor,input,'receive');
    let result;
    try {
      await this.store.write(claimed.object_key,stream,claimed,{ signal:AbortSignal.timeout(this.operationTimeoutMilliseconds) });
      result = { state:'quarantined' };
    } catch (error) {
      const malformed = ['SIZE_MISMATCH','HASH_MISMATCH','FORMAT_MISMATCH'].includes(error.code);
      result = { state:malformed ? 'rejected' : 'pending', failure:malformed ? error.code : 'UPLOAD_INTERRUPTED' };
    }
    return this.settle(actor,input.conversationId,claimed,result);
  }

  async inspect(actor, input, { signal:externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) fail('INVALID_INPUT');
    if (externalSignal?.aborted) fail('SCAN_UNAVAILABLE');
    const claimed = await this.claim(actor,input,'inspect');
    return this.#inspectClaimed(actor,input.conversationId,claimed,externalSignal);
  }

  async inspectNext({ signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
    if (signal?.aborted) fail('SCAN_UNAVAILABLE');
    const next = await observeMediaStage(this.#onStage,'queue-claim',() => this.claimNextInspection()); if (!next) return { status:'idle' };
    const upload = await this.#inspectClaimed(next.actor,next.conversationId,next.claimed,signal);
    return { status:'processed',upload };
  }

  async #inspectClaimed(actor,roomId,claimed,externalSignal) {
    let prepared,result,writeStream;
    const deadline = AbortSignal.timeout(this.operationTimeoutMilliseconds);
    const signal = externalSignal ? AbortSignal.any([deadline,externalSignal]) : deadline;
    const file = { type:claimed.type,size:claimed.size,sha256:claimed.sha256 };
    try {
      if (!this.preparation) fail('SCAN_UNAVAILABLE');
      prepared = await this.preparation.prepare({ ...file,openSource:async ({ signal:readSignal }) => {
        readSignal.throwIfAborted();
        const handle = await this.store.openVerified(claimed.object_key,file);
        try { readSignal.throwIfAborted(); return handle.createReadStream({ start:0,autoClose:true }); }
        catch (error) { await handle.close(); throw error; }
      } },{ signal });
      signal.throwIfAborted();
      if (prepared?.status === 'rejected') {
        result = { state:'rejected',report:preparationRejection(prepared,file),failure:'SCAN_REJECTED' };
      } else {
        const evidence = preparedCandidate(prepared,file,claimed.lease_id);
        writeStream = Readable.from([prepared.bytes],{ objectMode:false });
        await observeMediaStage(this.#onStage,'candidate-write',() => this.store.write(claimed.candidate_key,writeStream,evidence.derivative,{ signal }));
        // Do not treat a write acknowledgement alone as persisted-byte proof.
        await observeMediaStage(this.#onStage,'candidate-verify',async () => {
          const handle = await this.store.openVerified(claimed.candidate_key,evidence.derivative);
          await handle.close(); signal.throwIfAborted();
        });
        result = { state:'ready',evidence,report:{ verdict:'clean',engine:'clamav',engineVersion:evidence.sourceScan.engineVersion,
          policyVersion:'carebridge-media-v1',media:evidence.preparation.derivativeDecode.media } };
      }
    } catch (error) {
      result = { state:'quarantined',failure:error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? 'SCAN_INVALID' : 'SCAN_UNAVAILABLE' };
    } finally {
      writeStream?.destroy();
      if (Buffer.isBuffer(prepared?.bytes)) prepared.bytes.fill(0);
    }
    // No early Promise.race around preparation: an isolated job must first
    // terminate/clean up or latch. A stale/cancelled lease cannot commit ready.
    return observeMediaStage(this.#onStage,'settlement',() => this.#settle(actor,roomId,claimed,result));
  }

  // Owner's unbound preview only. Binding-specific access will replace this at
  // consumption; current room participation alone does not grant file access.
  async open(actor, input) {
    keys(input,['conversationId','uploadId','range']); uploadId(input.uploadId);
    if (input.range !== undefined) {
      keys(input.range,['start','end']);
      if (!Number.isSafeInteger(input.range.start) || input.range.start < 0 ||
          (input.range.end !== undefined && (!Number.isSafeInteger(input.range.end) || input.range.end < input.range.start))) fail('INVALID_INPUT');
    }
    const read = () => this.inRoom(actor,input.conversationId,async (tx,scope) => {
      const row = await this.owned(tx,scope,input.uploadId);
      if (row.expired) fail('UPLOAD_EXPIRED');
      if (row.state !== 'ready') fail('UPLOAD_STATE');
      return servingFile(row);
    });
    const row = await read(), start = input.range?.start ?? 0, end = input.range?.end ?? row.size - 1;
    if (start >= row.size || end >= row.size) fail('INVALID_RANGE');
    const handle = await this.store.openVerified(row.object_key,row);
    try {
      const current = await read();
      if (current.version !== row.version || current.object_key !== row.object_key) fail('UPLOAD_CONFLICT');
      return { stream:handle.createReadStream({ start,end,autoClose:true }), attachment:{ id:row.id,name:row.name,type:row.type,size:row.size },
        range:{ start,end }, total:row.size };
    } catch (error) { await handle.close(); throw error; }
  }

  async cancel(actor, input) {
    keys(input,['conversationId','uploadId','expectedVersion']); uploadId(input.uploadId); version(input.expectedVersion);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      const row = await this.owned(tx,scope,input.uploadId);
      if (['delete_pending','deleted'].includes(row.state)) return publicState(row);
      if (row.state === 'bound') fail('FILE_IN_USE');
      if (row.version !== input.expectedVersion) fail('UPLOAD_CONFLICT');
      await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE center_id = $1 AND conversation_id = $2 AND upload_id = $3 AND state = 'active'`,
      [scope.centerId,scope.roomId,row.id]);
      return publicState(await this.update(tx,scope,row,{ state:'delete_pending' }));
    });
  }

  // Trusted maintenance entry point, NEVER an actor-controlled HTTP endpoint.
  // DB intent precedes object deletion; errors keep ledger rows for retries.
  async cleanup({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    await this.database.transaction(async (tx) => {
      // Crash/DB-response loss after candidate IO leaves a tracked intent.
      // Fence that candidate after the lease expires; a retry gets a NEW key.
      const { rows: abandoned } = await tx.query(`${selectUpload} WHERE state = 'inspecting' AND lease_until <= clock_timestamp()
        AND expires_at > clock_timestamp() ORDER BY lease_until,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
      for (const row of abandoned) {
        await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE key = $1 AND state = 'active'`,[row.candidate_key]);
        await this.update(tx,{ centerId:row.center_id,roomId:row.conversation_id },row,{ state:'quarantined',candidateKey:null,failure:'SCAN_UNAVAILABLE' });
      }
      const { rows } = await tx.query(`${selectUpload} WHERE expires_at <= clock_timestamp() AND state NOT IN ('bound','delete_pending','deleted')
        AND (lease_until IS NULL OR lease_until <= clock_timestamp()) ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
      for (const row of rows) {
        await tx.query(`UPDATE cb_media_objects SET state = 'delete_pending' WHERE center_id = $1 AND conversation_id = $2 AND upload_id = $3 AND state = 'active'`,[row.center_id,row.conversation_id,row.id]);
        await this.update(tx,{ centerId:row.center_id,roomId:row.conversation_id },row,{ state:'delete_pending' });
      }
    });
    const { rows: objects } = await this.database.transaction((tx) => tx.query(`SELECT key FROM cb_media_objects WHERE state = 'delete_pending' ORDER BY created_at,key LIMIT $1`,[limit]));
    let removed = 0, failed = 0;
    for (const object of objects) {
      try {
        await this.store.remove(object.key);
        await this.database.transaction((tx) => tx.query(`UPDATE cb_media_objects SET state = 'deleted' WHERE key = $1 AND state = 'delete_pending'`,[object.key]));
        removed++;
      } catch { failed++; }
    }
    const finalized = await this.database.transaction(async (tx) => {
      const { rows } = await tx.query(`${selectUpload} u WHERE state = 'delete_pending' AND NOT EXISTS (
        SELECT 1 FROM cb_media_objects o WHERE (o.center_id,o.conversation_id,o.upload_id) = (u.center_id,u.conversation_id,u.id) AND o.state <> 'deleted')
        ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
      for (const row of rows) await this.update(tx,{ centerId:row.center_id,roomId:row.conversation_id },row,{ state:'deleted' });
      return rows.length;
    });
    return { removed,failed,finalized };
  }
}
