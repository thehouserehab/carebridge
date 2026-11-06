import { randomUUID } from 'node:crypto';
import { jobIdValid } from './decoder-job-protocol.mjs';
import { RepositoryError } from './errors.mjs';
const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
const containerIdValid = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const receipt = (row) => Object.freeze({ run:row.run,ownerId:row.owner_id,generation:row.generation,
  phase:row.phase,containerId:row.container_id,requiresRecovery:row.requires_recovery });
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));

// Internal worker-service persistence, never an actor/HTTP/upload queue. The
// database is operator-owned; no connection/environment secrets are read here.
export class DecoderJobJournal {
  #database; #engine; #image; #capacity; #owner; #duration;
  constructor(database,{ engineIdentity,approvedImageId,capacity = 2,ownerId = randomUUID(),leaseMilliseconds = 180000 } = {}) {
    if (!database?.transaction || typeof engineIdentity !== 'string' || !/^[a-zA-Z0-9:_-]{12,80}$/.test(engineIdentity) ||
        typeof approvedImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(approvedImageId) || !jobIdValid(ownerId) ||
        !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2 ||
        !Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 180000 || leaseMilliseconds > 600000)
      throw new TypeError('A transactional worker database, approved engine/image and bounded lease are required.');
    this.#database = database; this.#engine = engineIdentity; this.#image = approvedImageId;
    this.#capacity = capacity; this.#owner = ownerId; this.#duration = leaseMilliseconds;
  }
  matches(engine,image,capacity) { return engine === this.#engine && image === this.#image && capacity <= this.#capacity; }
  async #transaction(work) {
    try { return await this.#database.transaction(work); } catch { throw unavailable(); } // No SQL/driver/connection diagnostics escape.
  }
  async #engineLock(tx) {
    await tx.query(`INSERT INTO cb_decoder_engines(id,image_id,capacity) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,[this.#engine,this.#image,this.#capacity]);
    const { rows } = await tx.query('SELECT image_id,capacity FROM cb_decoder_engines WHERE id = $1 FOR UPDATE',[this.#engine]);
    if (rows.length !== 1 || rows[0].image_id !== this.#image || rows[0].capacity !== this.#capacity) throw unavailable();
  }
  #token(value) {
    if (!exact(value,['run','ownerId','generation','phase','containerId','requiresRecovery']) || !jobIdValid(value.run) || value.ownerId !== this.#owner ||
        !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation > 2147483647 ||
        !['reserved','creating','attached','closed'].includes(value.phase) || typeof value.requiresRecovery !== 'boolean' ||
        value.containerId !== null && !containerIdValid(value.containerId)) throw unavailable();
  }
  async #locked(tx,run) {
    const { rows } = await tx.query(`SELECT *,lease_until <= clock_timestamp() AS expired FROM cb_decoder_jobs
      WHERE run = $1 AND engine_id = $2 AND image_id = $3 FOR UPDATE`,[run,this.#engine,this.#image]);
    if (rows.length !== 1) throw unavailable(); return rows[0];
  }
  async reserve(run) {
    if (!jobIdValid(run)) throw unavailable();
    return this.#transaction(async (tx) => {
      await this.#engineLock(tx);
      const { rows } = await tx.query(`SELECT count(*)::integer AS count,
        coalesce(bool_or(requires_recovery OR lease_until <= clock_timestamp()),false) AS blocked
        FROM cb_decoder_jobs WHERE engine_id = $1 AND phase <> 'closed'`,[this.#engine]);
      if (rows[0].blocked || rows[0].count >= this.#capacity) throw unavailable();
      // A repeated run is NOT permission to repeat a possibly issued create.
      const { rows: inserted } = await tx.query(`INSERT INTO cb_decoder_jobs(run,engine_id,image_id,owner_id,phase,lease_until)
        VALUES ($1,$2,$3,$4,'reserved',clock_timestamp()+$5*interval '1 millisecond') RETURNING *`,[run,this.#engine,this.#image,this.#owner,this.#duration]);
      return receipt(inserted[0]);
    });
  }
  async #owned(tx,token) {
    await this.#engineLock(tx); const row = await this.#locked(tx,token.run);
    if (row.owner_id !== this.#owner || row.generation !== token.generation || row.phase === 'closed') throw unavailable(); return row;
  }
  async creating(token) {
    this.#token(token);
    return this.#transaction(async (tx) => {
      const row = await this.#owned(tx,token);
      if (row.expired || row.requires_recovery || row.phase !== 'reserved') throw unavailable();
      const { rows } = await tx.query(`UPDATE cb_decoder_jobs SET phase = 'creating',updated_at = clock_timestamp(),
        lease_until = clock_timestamp()+$2*interval '1 millisecond' WHERE run = $1 RETURNING *`,[row.run,this.#duration]);
      return receipt(rows[0]);
    });
  }
  async attach(token,id) {
    this.#token(token); if (!containerIdValid(id)) throw unavailable();
    return this.#transaction(async (tx) => {
      const row = await this.#owned(tx,token);
      if (row.expired || !['creating','attached'].includes(row.phase) || row.container_id !== null && row.container_id !== id) throw unavailable();
      const { rows } = await tx.query(`UPDATE cb_decoder_jobs SET phase = 'attached',container_id = $2,updated_at = clock_timestamp(),
        lease_until = clock_timestamp()+$3*interval '1 millisecond' WHERE run = $1 RETURNING *`,[row.run,id,this.#duration]);
      return receipt(rows[0]);
    });
  }
  async heartbeat(token) {
    this.#token(token);
    return this.#transaction(async (tx) => {
      const row = await this.#owned(tx,token); if (row.expired || row.requires_recovery) throw unavailable();
      await tx.query(`UPDATE cb_decoder_jobs SET updated_at = clock_timestamp(),lease_until = clock_timestamp()+$2*interval '1 millisecond' WHERE run = $1`,[row.run,this.#duration]);
    });
  }
  async take(run) {
    if (!jobIdValid(run)) throw unavailable();
    return this.#transaction(async (tx) => {
      await this.#engineLock(tx); const row = await this.#locked(tx,run);
      if (row.phase === 'closed') return receipt(row); // Stored cleanup receipt, not a new engine action.
      if (row.owner_id !== this.#owner && !row.expired || row.generation === 2147483647) throw unavailable();
      const { rows } = await tx.query(`UPDATE cb_decoder_jobs SET owner_id = $2,generation = generation+1,requires_recovery = true,
        lease_until = clock_timestamp()+$3*interval '1 millisecond',updated_at = clock_timestamp() WHERE run = $1 RETURNING *`,[run,this.#owner,this.#duration]);
      return receipt(rows[0]);
    });
  }
  async close(token) {
    this.#token(token);
    return this.#transaction(async (tx) => {
      await this.#engineLock(tx); const row = await this.#locked(tx,token.run);
      if (row.owner_id !== this.#owner || row.generation !== token.generation) throw unavailable();
      if (row.phase === 'closed') return receipt(row);
      // Reserved proves create authorization was never persisted. Creating
      // alone proves neither create termination nor container absence.
      if (!row.requires_recovery || !['reserved','attached'].includes(row.phase) || row.container_id !== token.containerId) throw unavailable();
      const { rows } = await tx.query(`UPDATE cb_decoder_jobs SET phase = 'closed',requires_recovery = false,lease_until = NULL,
        updated_at = clock_timestamp(),closed_at = clock_timestamp() WHERE run = $1 RETURNING *`,[row.run]);
      return receipt(rows[0]);
    });
  }
  async recoverable({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw unavailable();
    return this.#transaction(async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM cb_decoder_jobs WHERE engine_id = $1 AND image_id = $2 AND phase <> 'closed'
        AND (owner_id = $3 OR lease_until <= clock_timestamp()) ORDER BY created_at,run LIMIT $4`,[this.#engine,this.#image,this.#owner,limit]);
      return rows.map(receipt);
    });
  }
  async lookup(run) {
    if (!jobIdValid(run)) throw unavailable();
    return this.#transaction(async (tx) => {
      // Serializes behind an earlier reserve/commit before absence is used.
      // No create is authorized without that persisted creating receipt.
      await this.#engineLock(tx);
      const { rows } = await tx.query('SELECT * FROM cb_decoder_jobs WHERE run = $1 AND engine_id = $2 AND image_id = $3',[run,this.#engine,this.#image]);
      return rows.length ? receipt(rows[0]) : null;
    });
  }
}
