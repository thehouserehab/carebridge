import { LocalApiError } from './client.js';
import { memberDisplayName, ProfileFieldError } from '../src/profile-fields.js';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length >= 1 && value.length <= 100 && !/[^A-Za-z0-9_-]/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code = 'INVALID_RESPONSE') => { throw new LocalApiError(code); };
const keys = ['userId', 'role', 'displayName', 'revision', 'updatedAt'];
const pick = (value, names) => Object.fromEntries(names.map(key => [key, value[key]]));
const stamp = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function name(value, code) {
  try { return memberDisplayName(value); }
  catch (error) { if (error instanceof ProfileFieldError) fail(code); throw error; }
}
function path(centerId) {
  if (!id(centerId)) fail('INVALID_INPUT');
  return `/api/local/centers/${centerId}/account/profile`;
}
function identity(api, signal) {
  const userId = api.expectedUserId;
  const current = () => {
    if (signal?.aborted) fail('CANCELLED');
    if (!id(userId) || api.expectedUserId !== userId) throw new LocalApiError('AUTH_REQUIRED', 401);
  };
  current(); return { userId, current };
}
async function request(api, route, body, signal, current) {
  current();
  try { const result = await api.request(route, { body, signal }); current(); return result; }
  catch (error) { current(); if (error instanceof LocalApiError) throw error; fail('UNAVAILABLE'); }
}

// One authenticated transport; no credentials, cached profile or browser storage.
// The center-scoped endpoint, not this adapter, decides the current membership.
export class SelfProfileApiClient {
  #api;
  constructor(api) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    this.#api = api;
  }
  async get(centerId, signal) {
    const route = path(centerId), { userId, current } = identity(this.#api, signal);
    const response = await request(this.#api, route, undefined, signal, current);
    if (!object(response?.profile)) fail();
    const value = pick(response.profile, keys);
    if (value.userId !== userId || !['center', 'therapist', 'guardian', 'care_recipient'].includes(value.role) || !revision(value.revision) ||
        name(value.displayName) !== value.displayName ||
        (value.revision === 0 ? value.displayName !== null || value.updatedAt !== null : !stamp(value.updatedAt))) fail();
    current(); return value;
  }
  async save(centerId, operation, signal) {
    const route = path(centerId), { userId, current } = identity(this.#api, signal);
    const names = ['clientId', 'expectedRevision', 'displayName'];
    if (!object(operation) || !names.every(key => Object.hasOwn(operation, key)) || Object.keys(operation).some(key => !names.includes(key))) fail('INVALID_INPUT');
    const body = pick(operation, names);
    if (typeof body.clientId !== 'string' || body.clientId.length < 8 || body.clientId.length > 100 || /[^A-Za-z0-9-]/.test(body.clientId) ||
        !revision(body.expectedRevision)) fail('INVALID_INPUT');
    body.displayName = name(body.displayName, 'INVALID_INPUT');
    const response = await request(this.#api, route, body, signal, current);
    if (!object(response?.receipt)) fail();
    const value = pick(response.receipt, ['operation', 'userId', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed']);
    if (value.operation !== 'member.save' || value.userId !== userId || value.childId !== null || value.conversationId !== null ||
        typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean' || !revision(value.appliedVersion) ||
        value.appliedVersion !== body.expectedRevision + Number(value.changed)) fail();
    current(); return value;
  }
}
