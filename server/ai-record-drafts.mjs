import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

const HASH = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).length !== allowed.length ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    fail('INVALID_INPUT');
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
}
function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit || !value.isWellFormed() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) fail('INVALID_INPUT');
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function request(actor, input, generation = false) {
  fields(actor, ['userId', 'centerId']);
  fields(input, ['conversationId', 'recordId', 'expectedRevision', ...(generation ? ['sourceHash', 'requestId'] : [])]);
  const identity = Object.freeze({ userId: id(actor.userId), centerId: id(actor.centerId) });
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision > 2147483647)
    fail('INVALID_INPUT');
  const selected = { conversationId: id(input.conversationId), recordId: id(input.recordId), expectedRevision: input.expectedRevision };
  if (generation) {
    if (typeof input.sourceHash !== 'string' || !HASH.test(input.sourceHash) ||
        typeof input.requestId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(input.requestId)) fail('INVALID_INPUT');
    Object.assign(selected, { sourceHash: input.sourceHash, requestId: input.requestId });
  }
  return { identity, selected: Object.freeze(selected) };
}
function source(record) {
  const result = { performed: text(record.performed, 2000), response: text(record.response, 2000) };
  if (!result.performed.trim() && !result.response.trim()) fail('INVALID_INPUT');
  return Object.freeze(result);
}
function abortCheck(signal) { if (signal?.aborted) fail('AI_REQUEST_FAILED'); }
function generated(value) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['summary', 'reviewNotes', 'usage'].includes(key))) fail('AI_REQUEST_FAILED');
  try {
    const summary = text(value.summary, 1200).trim();
    if (!summary || !Array.isArray(value.reviewNotes) || value.reviewNotes.length > 4) fail('AI_REQUEST_FAILED');
    const reviewNotes = value.reviewNotes.map(note => text(note, 200).trim());
    if (reviewNotes.some(note => !note)) fail('AI_REQUEST_FAILED');
    return { summary, reviewNotes };
  } catch { fail('AI_REQUEST_FAILED'); }
}

// Process-local synthetic beta boundary: no clinical writes, content logs, key
// access, autonomous tools, or automatic publishing. The counter includes failed
// provider calls and never evicts receipts: eviction could repeat a paid request.
export class AiRecordDrafts {
  #get; #generate; #mode; #model; #maxCalls; #calls = 0; #busy = false; #receipts = new Map();
  #closed = false; #active = null; #pending = null;
  constructor({ records, provider, maxCalls = 20 } = {}) {
    if (typeof records?.get !== 'function' || typeof provider?.generate !== 'function' ||
        !['openai', 'fixture'].includes(provider.mode) || typeof provider.model !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,100}$/.test(provider.model) || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000)
      throw new TypeError('Invalid AI draft service configuration.');
    this.#get = records.get.bind(records); this.#generate = provider.generate.bind(provider);
    this.#mode = provider.mode; this.#model = provider.model; this.#maxCalls = maxCalls;
  }
  async #read(identity, selected) {
    // A fresh current read authorizes therapist membership/history and closes its
    // own DB transaction before any provider network request.
    const record = await this.#get(identity, { conversationId: selected.conversationId, recordId: selected.recordId });
    if (record.id !== selected.recordId || record.conversationId !== selected.conversationId || record.revision !== selected.expectedRevision)
      fail('AI_SOURCE_CHANGED');
    const selectedSource = source(record);
    return { recordId: selected.recordId, revision: record.revision, source: selectedSource,
      sourceHash: digest(selectedSource), mode: this.#mode, model: this.#model };
  }
  async preview(actor, input) {
    if (this.#closed) fail('AI_UNAVAILABLE');
    const { identity, selected } = request(actor, input);
    const preview = await this.#read(identity, selected);
    if (this.#closed) fail('AI_UNAVAILABLE');
    return preview;
  }
  async generate(actor, input, { signal } = {}) {
    if (this.#closed) fail('AI_UNAVAILABLE');
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
    const { identity, selected } = request(actor, input, true);
    abortCheck(signal);
    const current = await this.#read(identity, selected);
    if (this.#closed) fail('AI_UNAVAILABLE');
    abortCheck(signal);
    if (current.sourceHash !== selected.sourceHash) fail('AI_SOURCE_CHANGED');
    const key = JSON.stringify([identity.userId, identity.centerId, selected.conversationId, selected.requestId]);
    const fingerprint = digest([selected.recordId, selected.expectedRevision, selected.sourceHash]);
    const previous = this.#receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
      if (previous.state === 'pending') fail('AI_BUSY');
      if (previous.state !== 'ready') fail('AI_REQUEST_FAILED');
      return structuredClone(previous.draft);
    }
    if (this.#busy) fail('AI_BUSY');
    if (this.#calls >= this.#maxCalls) fail('AI_LIMIT');
    const receipt = { fingerprint, state: 'pending' };
    this.#receipts.set(key, receipt); this.#calls++; this.#busy = true;
    this.#active = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, this.#active.signal]) : this.#active.signal;
    const operation = (async () => {
      let verifying = false;
      try {
        // Only these two strings cross the provider boundary. Never forward the
        // record, identity, attachment metadata, private notes, or request objects.
        const output = await this.#generate({ performed: current.source.performed, response: current.source.response }, { signal: requestSignal });
        abortCheck(requestSignal);
        const candidate = generated(output);
        verifying = true;
        const latest = await this.#read(identity, selected);
        abortCheck(requestSignal);
        if (latest.sourceHash !== selected.sourceHash) fail('AI_SOURCE_CHANGED');
        const draft = { recordId: selected.recordId, revision: selected.expectedRevision, sourceHash: selected.sourceHash,
          requestId: selected.requestId, ...candidate, mode: this.#mode, model: this.#model };
        receipt.state = 'ready'; receipt.draft = draft;
        return structuredClone(draft);
      } catch (error) {
        receipt.state = 'failed';
        // Repository authorization and changed-source errors remain actionable;
        // provider exceptions/messages never reach logs or the client.
        if (verifying && ['FORBIDDEN', 'NOT_FOUND', 'AI_SOURCE_CHANGED'].includes(error?.code)) throw error;
        fail('AI_REQUEST_FAILED');
      } finally { this.#busy = false; this.#active = null; }
    })();
    this.#pending = operation;
    try { return await operation; }
    finally { if (this.#pending === operation) this.#pending = null; }
  }
  async close() {
    this.#closed = true;
    this.#active?.abort();
    await this.#pending?.catch(() => {});
    this.#receipts.clear();
  }
}
