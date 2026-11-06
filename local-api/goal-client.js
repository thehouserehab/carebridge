import { LocalApiError } from './client.js';
import { goalFields } from '../src/context-fields.js';

const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const revision = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
const fail = (code = 'INVALID_RESPONSE') => { throw new LocalApiError(code); };
const pathId = (value) => { if (!id(value)) fail('INVALID_INPUT'); return value; };
const contentKeys = ['title', 'description', 'status'];
const goalKeys = ['id', 'conversationId', 'childId', 'revision', ...contentKeys, 'updatedAt'];
const pick = (value, names) => Object.fromEntries(names.map((key) => [key, value[key]]));
const goalPath = (centerId, roomId, goalId) =>
  `/api/local/centers/${pathId(centerId)}/conversations/${pathId(roomId)}/goals/${pathId(goalId)}`;

function content(input, code = 'INVALID_INPUT') {
  if (!object(input) || Reflect.ownKeys(input).length !== contentKeys.length ||
      !contentKeys.every((key) => Object.hasOwn(input, key) && typeof input[key] === 'string')) fail(code);
  try { return goalFields(input); }
  catch { fail(code); }
}
function goal(value, roomId, goalId) {
  if (!object(value) || !goalKeys.every((key) => Object.hasOwn(value, key)) || value.id !== goalId ||
      value.conversationId !== roomId || !id(value.childId) || !revision(value.revision, 1) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt) fail();
  const normalized = content(pick(value, contentKeys), 'INVALID_RESPONSE');
  if (contentKeys.some((key) => normalized[key] !== value[key])) fail();
  // This current-goal projection is not a record's historical goal snapshot.
  // Discard unrelated clinical, participant, credential and history fields.
  return pick(value, goalKeys);
}
function accountGuard(api, signal) {
  const account = api.expectedUserId;
  return () => {
    if (signal?.aborted) fail('CANCELLED');
    if (!id(account) || api.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
  };
}
async function request(api, path, body, signal, current) {
  current();
  try {
    const value = await api.request(path, { body, signal });
    current(); return value;
  } catch (error) {
    current();
    if (error instanceof LocalApiError) throw error;
    fail('UNAVAILABLE');
  }
}

// The existing transport owns the login identity, cookie and timeout. This
// adapter never grants a role, caches a goal or retries an uncertain write.
export class GoalApiClient {
  #api;
  constructor(api) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    this.#api = api;
  }
  content(input) { return content(input); }
  async goal(centerId, roomId, goalId, signal) {
    const path = goalPath(centerId, roomId, goalId), current = accountGuard(this.#api, signal);
    const value = await request(this.#api, path, undefined, signal, current);
    return goal(value?.goal, roomId, goalId);
  }
  async save(centerId, roomId, goalId, operation, signal) {
    const path = goalPath(centerId, roomId, goalId), current = accountGuard(this.#api, signal);
    if (!object(operation) || typeof operation.clientId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId) ||
        !revision(operation.expectedRevision)) fail('INVALID_INPUT');
    // Normalize and detach all command fields before the first await. The
    // caller must retain its own immutable operation for an explicit retry.
    const body = { clientId: operation.clientId, expectedRevision: operation.expectedRevision, content: content(operation.content) };
    const value = await request(this.#api, path, body, signal, current), receipt = value?.receipt;
    if (!object(receipt) || receipt.kind !== 'goal' || receipt.id !== goalId || !revision(receipt.revision, 1) ||
        typeof receipt.changed !== 'boolean' || typeof receipt.replayed !== 'boolean' ||
        receipt.revision !== body.expectedRevision + Number(receipt.changed)) fail();
    return pick(receipt, ['kind', 'id', 'revision', 'changed', 'replayed']);
  }
}
