import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

// Adapted from RP AI Agent's write-free conversation boundary: bounded
// context, explicit provider, current authorization, and no automatic retries.
// This local lifetime keeps no clinical records, disk journal, or model keys.
const MAX_SESSIONS = 64;
const MAX_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 16000;
const roles = new Set(['therapist', 'guardian', 'care_recipient']);
const providerErrors = new Set(['AI_CANCELLED', 'AI_PROVIDER_UNAVAILABLE', 'AI_OUTPUT_INVALID']);
const clone = value => structuredClone(value);

function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  for (const key of Reflect.ownKeys(value))
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('INVALID_INPUT');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
}
function text(value, maximum) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > maximum ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) fail('INVALID_INPUT');
  return value.trim();
}
function identity(value) {
  object(value, ['userId', 'centerId']);
  return Object.freeze({ userId: id(value.userId), centerId: id(value.centerId) });
}
function request(value) {
  object(value, ['conversationId', 'requestId', 'expectedRevision', 'message']);
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(value.requestId) ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision > 2147483647)
    fail('INVALID_INPUT');
  return Object.freeze({ conversationId: id(value.conversationId), requestId: value.requestId,
    expectedRevision: value.expectedRevision, message: text(value.message, 2000) });
}
function output(value) {
  try {
    object(value, ['text', 'usage']);
    object(value.usage, ['inputTokens', 'outputTokens']);
    if (!Object.values(value.usage).every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000))
      fail('INVALID_INPUT');
    return text(value.text, 6000);
  } catch { fail('AI_OUTPUT_INVALID'); }
}
function boundedContext(messages, userMessage) {
  const next = [...messages.map(clone), { role: 'user', content: userMessage }];
  let truncated = false;
  // The provider accepts at most 12 items; the last item is a new user turn.
  // Remove complete old turns so remaining history always starts with a user.
  while (next.length > MAX_MESSAGES || next.reduce((n, item) => n + item.content.length, 0) > MAX_CONTEXT_CHARS) {
    next.splice(0, 2); truncated = true;
  }
  return { messages: next, truncated };
}

export class AiConversations {
  #conversations;
  #respond;
  #mode;
  #model;
  #maxCalls;
  #calls = 0;
  #sessions = new Map();
  #requests = new Map();
  #active = null;
  #closed = false;
  #closing = null;

  constructor({ conversations, provider, maxCalls = 20 } = {}) {
    if (typeof conversations?.inRoom !== 'function' || typeof provider?.respond !== 'function' ||
        !['openai', 'fixture'].includes(provider.mode) || typeof provider.model !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(provider.model) ||
        !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000)
      throw new TypeError('Invalid AI conversation configuration.');
    this.#conversations = conversations;
    this.#respond = provider.respond.bind(provider);
    this.#mode = provider.mode;
    this.#model = provider.model;
    this.#maxCalls = maxCalls;
  }

  #available(signal) {
    if (this.#closed) fail('AI_UNAVAILABLE');
    if (signal?.aborted) fail('AI_CANCELLED');
  }

  async #authorize(actor, roomId) {
    this.#available();
    // Only copy an authorization snapshot out of the DB transaction. The
    // external provider is never awaited while holding its room/account locks.
    const scope = await this.#conversations.inRoom(actor, roomId, (_tx, current) => {
      if (!current || current.centerId !== actor.centerId || current.userId !== actor.userId ||
          current.roomId !== roomId || !roles.has(current.role) ||
          !Number.isSafeInteger(current.firstSequence) || current.firstSequence < 1) fail('NOT_FOUND');
      return { key: JSON.stringify([current.centerId, current.userId, current.roomId]),
        access: JSON.stringify([current.childId, current.role, current.firstSequence]) };
    });
    this.#available();
    return scope;
  }

  #session(scope) {
    let state = this.#sessions.get(scope.key);
    if (!state) {
      if (this.#sessions.size >= MAX_SESSIONS) fail('AI_LIMIT');
      state = { revision: 0, messages: [], access: scope.access, contextTruncated: false };
      this.#sessions.set(scope.key, state);
    } else if (state.access !== scope.access) {
      // Reassignment/history changes invalidate earlier private AI context.
      // Keep revisions monotonic so an old open form cannot reuse revision 0.
      state = { revision: state.revision + 1, messages: [], access: scope.access, contextTruncated: false };
      this.#sessions.set(scope.key, state);
    }
    return state;
  }

  #view(state) {
    return { revision: state.revision, messages: state.messages.map(clone),
      mode: this.#mode, model: this.#model, contextTruncated: state.contextTruncated };
  }

  async get(actorInput, input) {
    const actor = identity(actorInput);
    object(input, ['conversationId']);
    const scope = await this.#authorize(actor, id(input.conversationId));
    return this.#view(this.#session(scope));
  }

  async send(actorInput, input, { signal } = {}) {
    const actor = identity(actorInput), data = request(input);
    this.#available(signal);
    const scope = await this.#authorize(actor, data.conversationId);
    this.#available(signal);
    const state = this.#session(scope);
    const key = JSON.stringify([actor.centerId, actor.userId, data.requestId]);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const prior = this.#requests.get(key);
    if (prior) {
      if (prior.hash !== hash) fail('AI_REQUEST_CONFLICT');
      if (prior.scope !== scope.key || prior.access !== scope.access) fail('AI_CONVERSATION_CHANGED');
      if (prior.status === 'pending') fail('AI_BUSY');
      if (prior.status !== 'completed') fail('AI_REQUEST_FAILED');
      if (state.revision !== prior.result.revision) fail('AI_CONVERSATION_CHANGED');
      return clone(prior.result);
    }
    if (state.revision !== data.expectedRevision) fail('AI_CONVERSATION_CHANGED');
    if (this.#active) fail('AI_BUSY');
    if (this.#calls >= this.#maxCalls || state.revision >= 2147483647) fail('AI_LIMIT');
    const context = boundedContext(state.messages, data.message);
    const entry = { hash, scope: scope.key, access: scope.access, status: 'pending' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#requests.set(key, entry);
    // Reserve before dispatch; exceptions, cancellations, and uncertain
    // outcomes consume the lifetime cap and retain their request tombstone.
    this.#calls++;
    let settle;
    const active = { controller, settled: new Promise(resolve => { settle = resolve; }) };
    this.#active = active;
    try {
      this.#available(controller.signal);
      let answer;
      try { answer = await this.#respond({ messages: clone(context.messages) }, { signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) fail(this.#closed ? 'AI_UNAVAILABLE' : 'AI_CANCELLED');
        fail(providerErrors.has(error?.code) ? error.code : 'AI_PROVIDER_UNAVAILABLE');
      }
      this.#available(controller.signal);
      const current = await this.#authorize(actor, data.conversationId);
      this.#available(controller.signal);
      if (current.access !== scope.access || current.key !== scope.key ||
          this.#sessions.get(scope.key) !== state || state.revision !== data.expectedRevision)
        fail('AI_CONVERSATION_CHANGED');
      const content = output(answer);
      // Commit the user/assistant pair only after provider validation and
      // current access checks. There are no clinical or message-store writes.
      state.messages = [...context.messages, { role: 'assistant', content }];
      state.revision++;
      state.contextTruncated = state.contextTruncated || context.truncated;
      entry.status = 'completed';
      entry.result = this.#view(state);
      return clone(entry.result);
    } catch (error) {
      entry.status = 'failed';
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.#active === active) this.#active = null;
      settle();
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const active = this.#active;
    active?.controller.abort();
    this.#closing = (async () => {
      // An abort signal alone is not evidence that a provider has stopped.
      if (active) await active.settled;
      this.#sessions.clear();
      this.#requests.clear();
    })();
    return this.#closing;
  }
}
