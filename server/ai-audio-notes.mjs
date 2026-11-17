import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { AUDIO_NOTE_MAX_BYTES, normalizeAudioNoteFile, matchesAudioNoteSignature,
  validateAudioAnalysisResult } from '../src/audio-note-contract.js';

const MEMORY_LIMIT = 80 * 1024 ** 2, SESSION_LIMIT = 20, RECEIPT_LIMIT = 1000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key =>
    !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_INPUT');
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail('INVALID_INPUT');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
}
function identity(actor) {
  exact(actor, ['userId', 'centerId']);
  return { userId: identifier(actor.userId), centerId: identifier(actor.centerId) };
}
function selection(input, extras = []) {
  exact(input, ['conversationId', 'recordId', ...extras]);
  return { conversationId: identifier(input.conversationId), recordId: identifier(input.recordId) };
}
const digest = value => createHash('sha256').update(value).digest('hex');
const sameOwner = (row, actor) => row.owner.userId === actor.userId && row.owner.centerId === actor.centerId;
const stamp = () => new Date().toISOString();

// Ephemeral synthetic sessions only. No record writes, sharing, durable archive,
// content logs or legal-evidence claims. Files and derived text stay owner-only.
export class AiAudioNotes {
  #read; #provider; #maxCalls; #calls = 0; #bytes = 0; #closed = false;
  #sessions = new Map(); #receipts = new Map(); #active = null; #pending = null;
  constructor({ records, provider, maxCalls = 10 } = {}) {
    if (typeof records?.get !== 'function' || typeof provider?.generate !== 'function' ||
        !['openai', 'fixture'].includes(provider.mode) ||
        ![provider.model, provider.transcriptionModel].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)) ||
        !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
      throw new TypeError('Invalid audio note service configuration.');
    this.#read = records.get.bind(records);
    this.#provider = { mode: provider.mode, model: provider.model, transcriptionModel: provider.transcriptionModel,
      generate: provider.generate.bind(provider) };
    this.#maxCalls = maxCalls;
  }
  #open() { if (this.#closed) fail('AI_UNAVAILABLE'); }
  async #record(actor, selected) {
    this.#open();
    const record = await this.#read(actor, selected);
    this.#open();
    if (!record || record.id !== selected.recordId || record.conversationId !== selected.conversationId) fail('NOT_FOUND');
    version(record.revision);
    return record;
  }
  async assertUsable(actor, input) {
    const owner = identity(actor), selected = selection(input);
    const record = await this.#record(owner, selected);
    return { recordRevision: record.revision };
  }
  #view(row) { return structuredClone(row.session); }
  #change(row, state, kind = state) {
    row.session.state = state;
    row.session.revision++;
    row.session.events.push({ kind, at: stamp() });
  }
  async #owned(actor, input, extras = []) {
    const owner = identity(actor), selected = selection(input, ['sessionId', ...extras]);
    identifier(input.sessionId);
    const record = await this.#record(owner, selected);
    const row = this.#sessions.get(input.sessionId);
    if (!row || !sameOwner(row, owner) || row.conversationId !== selected.conversationId || row.session.recordId !== selected.recordId)
      fail('NOT_FOUND');
    return { owner, selected, record, row };
  }
  #receipt(owner, operation, id, fingerprint) {
    const key = JSON.stringify([owner.centerId, owner.userId, operation, id]);
    const prior = this.#receipts.get(key);
    if (prior && prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
    if (!prior && this.#receipts.size >= RECEIPT_LIMIT) fail('AI_LIMIT');
    return { key, prior };
  }
  async list(actor, input) {
    const owner = identity(actor), selected = selection(input);
    await this.#record(owner, selected);
    return [...this.#sessions.values()].filter(row => sameOwner(row, owner) && row.conversationId === selected.conversationId &&
      row.session.recordId === selected.recordId).map(row => this.#view(row));
  }
  async upload(actor, input) {
    const owner = identity(actor), selected = selection(input,
      ['expectedRevision', 'requestId', 'filename', 'type', 'base64', 'syntheticConfirmed', 'processingConfirmed']);
    const expected = version(input.expectedRevision), clientId = requestId(input.requestId);
    if (input.syntheticConfirmed !== true || input.processingConfirmed !== true || typeof input.base64 !== 'string' ||
        input.base64.length < 16 || input.base64.length > 4 * Math.ceil(AUDIO_NOTE_MAX_BYTES / 3) ||
        input.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.base64)) fail('INVALID_INPUT');
    let file;
    try { file = normalizeAudioNoteFile({ filename: input.filename, type: input.type }); }
    catch { fail('INVALID_INPUT'); }
    const record = await this.#record(owner, selected);
    if (record.revision !== expected) fail('AI_SOURCE_CHANGED');
    const bytes = Buffer.from(input.base64, 'base64');
    let retained = false;
    try {
      if (bytes.length < 12 || bytes.length > AUDIO_NOTE_MAX_BYTES || bytes.toString('base64') !== input.base64 ||
          !matchesAudioNoteSignature(file.type, bytes)) fail('INVALID_INPUT');
      const sha256 = digest(bytes), fingerprint = digest(JSON.stringify([selected, expected, file, sha256]));
      const { key, prior } = this.#receipt(owner, 'upload', clientId, fingerprint);
      if (prior) {
        const row = this.#sessions.get(prior.sessionId);
        if (!row) fail('NOT_FOUND');
        return this.#view(row);
      }
      const count = [...this.#sessions.values()].filter(row => sameOwner(row, owner) && row.conversationId === selected.conversationId &&
        row.session.recordId === selected.recordId).length;
      if (count >= 3 || this.#sessions.size >= SESSION_LIMIT || this.#bytes + bytes.length > MEMORY_LIMIT) fail('AI_LIMIT');
      const id = randomUUID(), receivedAt = stamp();
      const session = { id, recordId: selected.recordId, recordRevision: expected, revision: 1, ...file, size: bytes.length,
        sha256, receivedAt, state: 'uploaded', mode: this.#provider.mode, model: this.#provider.model,
        transcriptionModel: this.#provider.transcriptionModel, result: null, events: [{ kind: 'uploaded', at: receivedAt }], syntheticOnly: true };
      this.#sessions.set(id, { owner, conversationId: selected.conversationId, bytes, session });
      this.#bytes += bytes.length; retained = true;
      this.#receipts.set(key, { fingerprint, sessionId: id });
      return structuredClone(session);
    } finally { if (!retained) bytes.fill(0); }
  }
  async get(actor, input) { return this.#view((await this.#owned(actor, input)).row); }
  async getOriginal(actor, input) {
    const { row } = await this.#owned(actor, input);
    return { bytes: Buffer.from(row.bytes), type: row.session.type, filename: row.session.filename, sha256: row.session.sha256 };
  }
  async start(actor, input, { authorizeSession } = {}) {
    if (authorizeSession !== undefined && typeof authorizeSession !== 'function') fail('INVALID_INPUT');
    const expected = version(input?.expectedRevision), clientId = requestId(input?.requestId);
    const { owner, selected, row } = await this.#owned(actor, input, ['expectedRevision', 'requestId']);
    await authorizeSession?.();
    const record = await this.#record(owner, selected);
    if (this.#sessions.get(row.session.id) !== row) fail('NOT_FOUND');
    if (record.revision !== row.session.recordRevision) fail('AI_SOURCE_CHANGED');
    const fingerprint = digest(JSON.stringify([selected, row.session.id, expected]));
    const { key, prior } = this.#receipt(owner, 'start', clientId, fingerprint);
    if (prior) return this.#view(row);
    if (row.session.revision !== expected) fail('AI_SOURCE_CHANGED');
    if (row.session.state !== 'uploaded') fail('AI_REQUEST_FAILED');
    if (this.#active) fail('AI_BUSY');
    if (this.#calls >= this.#maxCalls || this.#bytes + row.bytes.length > MEMORY_LIMIT) fail('AI_LIMIT');
    const controller = new AbortController();
    this.#active = { row, controller }; this.#calls++;
    // Reserve the provider copy before any job await, so concurrent uploads
    // cannot consume that space while authorization is being rechecked.
    this.#bytes += row.bytes.length;
    this.#receipts.set(key, { fingerprint, sessionId: row.session.id });
    this.#change(row, 'processing');
    const accepted = this.#view(row);
    const operation = this.#process(row, owner, selected, controller, authorizeSession);
    this.#pending = operation;
    void operation.finally(() => { if (this.#pending === operation) this.#pending = null; });
    return accepted;
  }
  #current(row, controller) {
    return !this.#closed && !controller.signal.aborted && this.#active?.row === row && this.#active.controller === controller &&
      this.#sessions.get(row.session.id) === row && row.session.state === 'processing';
  }
  async #process(row, owner, selected, controller, authorizeSession) {
    let source;
    const reauthorize = async () => {
      if (!this.#current(row, controller)) fail('AI_REQUEST_FAILED');
      await authorizeSession?.();
      const record = await this.#record(owner, selected);
      await authorizeSession?.();
      if (!this.#current(row, controller)) fail('AI_REQUEST_FAILED');
      if (record.revision !== row.session.recordRevision) fail('AI_SOURCE_CHANGED');
    };
    const authorizeStage = async stage => {
      if (!['transcription', 'analysis'].includes(stage)) fail('INVALID_INPUT');
      // A live request has two independently chargeable provider operations.
      // Do not let loss of authority during transcription launch analysis.
      await reauthorize();
    };
    try {
      await reauthorize();
      source = Buffer.from(row.bytes);
      const output = await this.#provider.generate({ bytes: source, type: row.session.type }, { signal: controller.signal, authorizeStage });
      if (!this.#current(row, controller)) return;
      const result = validateAudioAnalysisResult(output);
      await reauthorize();
      row.session.result = result;
      this.#change(row, 'ready');
    } catch {
      if (this.#current(row, controller)) { row.session.result = null; this.#change(row, 'failed'); }
    } finally {
      this.#bytes -= row.session.size;
      source?.fill(0);
      if (this.#active?.row === row) this.#active = null;
    }
  }
  async cancel(actor, input) {
    const expected = version(input?.expectedRevision), clientId = requestId(input?.requestId);
    const { owner, selected, row } = await this.#owned(actor, input, ['expectedRevision', 'requestId']);
    const fingerprint = digest(JSON.stringify([selected, row.session.id, expected]));
    const { key, prior } = this.#receipt(owner, 'cancel', clientId, fingerprint);
    if (prior) return this.#view(row);
    if (row.session.revision !== expected) fail('AI_SOURCE_CHANGED');
    if (!['uploaded', 'processing'].includes(row.session.state)) fail('AI_REQUEST_FAILED');
    this.#receipts.set(key, { fingerprint, sessionId: row.session.id });
    this.#change(row, 'cancelled'); row.session.result = null;
    if (this.#active?.row === row) this.#active.controller.abort();
    return this.#view(row);
  }
  async remove(actor, input) {
    const { row } = await this.#owned(actor, input);
    if (this.#active?.row === row) this.#active.controller.abort();
    this.#sessions.delete(row.session.id);
    this.#bytes -= row.bytes.length; row.bytes.fill(0); row.session.result = null;
    return null;
  }
  async close() {
    this.#closed = true; this.#active?.controller.abort();
    for (const row of this.#sessions.values()) { this.#bytes -= row.bytes.length; row.bytes.fill(0); row.session.result = null; }
    this.#sessions.clear(); this.#receipts.clear();
    await this.#pending;
  }
}
