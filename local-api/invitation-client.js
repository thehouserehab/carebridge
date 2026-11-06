import { LocalApiError } from './client.js';
import { syntheticAccountEmail as invitationEmail } from './account-input.js';
export { invitationEmail };

const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const inviteId = v => typeof v === 'string' && /^inv_[a-f0-9]{32}$/.test(v);
const role = v => ['therapist', 'guardian', 'care_recipient'].includes(v);
const tokenValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{40,100}$/.test(v);
const exact = (v, names) => object(v) && Reflect.ownKeys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const pick = (v, keys) => Object.fromEntries(keys.map(k => [k, v[k]]));
const fail = (code = 'INVALID_RESPONSE', status = 0) => { throw new LocalApiError(code, status); };
const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const pathId = v => { if (!id(v)) fail('INVALID_INPUT'); return v; };
const root = center => `/api/local/centers/${pathId(center)}/operations/invitations`;
export const INVITATION_REQUEST_NOTICE = '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.';

function summary(v) {
  if (!object(v) || !inviteId(v.id) || !id(v.centerId) || !role(v.role) || !stamp(v.expiresAt)) fail();
  return pick(v, ['id', 'centerId', 'role', 'expiresAt']);
}
function user(v) {
  if (!object(v) || !id(v.userId) || typeof v.email !== 'string' || !stamp(v.expiresAt) ||
      !Array.isArray(v.centers) || !v.centers.length || v.centers.length > 100 ||
      !v.centers.every(c => object(c) && id(c.id) && ['center', 'therapist', 'guardian', 'care_recipient'].includes(c.role)) ||
      new Set(v.centers.map(c => c.id)).size !== v.centers.length) fail();
  try { if (invitationEmail(v.email) !== v.email) fail(); } catch { fail(); }
  return { userId: v.userId, email: v.email, centers: v.centers.map(c => pick(c, ['id', 'role'])), expiresAt: v.expiresAt };
}
function acceptInput(input, existing) {
  if (!exact(input, existing ? ['token', 'centerId', 'role'] : ['token', 'centerId', 'role', 'password', 'confirmation']) ||
      !tokenValid(input.token) || !id(input.centerId) || !role(input.role)) fail('INVALID_INPUT');
  if (!existing && (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128 ||
      !input.password.isWellFormed() || input.password !== input.confirmation)) fail('INVALID_INPUT');
  return pick(input, existing ? ['token', 'centerId', 'role'] : ['token', 'centerId', 'role', 'password', 'confirmation']);
}
function accepted(value, body, expectedUserId, existing) {
  const u = user(value?.user), i = value?.invitation;
  if (!object(i) || !inviteId(i.id) || i.centerId !== body.centerId || i.role !== body.role ||
      !u.centers.some(c => c.id === i.centerId && c.role === i.role) ||
      (existing && (u.userId !== expectedUserId || value.linked !== true || typeof value.replayed !== 'boolean'))) fail();
  return { user: u, invitation: pick(i, ['id', 'centerId', 'role']),
    ...(existing ? { linked: true, replayed: value.replayed } : {}) };
}

// One transport/cookie identity; no token, password, response or role cache.
export class InvitationApiClient {
  #api;
  constructor(api) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    this.#api = api;
  }
  async #request(path, body, signal, accountRequired = false, anonymousOnly = false) {
    const account = this.#api.expectedUserId;
    const current = () => {
      if (signal?.aborted) fail('CANCELLED');
      if (this.#api.expectedUserId !== account || (accountRequired && !id(account))) fail('AUTH_REQUIRED', 401);
      if (anonymousOnly && account !== null) fail('ACCOUNT_SESSION_PRESENT', 409);
    };
    current();
    try { const result = await this.#api.request(path, { body, signal }); current(); return result; }
    catch (error) { current(); if (error instanceof LocalApiError) throw error; fail('UNAVAILABLE'); }
  }
  async list(centerId, signal) {
    const value = await this.#request(root(centerId), undefined, signal, true);
    if (!Array.isArray(value?.invitations) || value.invitations.length > 100) fail();
    const seen = new Set();
    return value.invitations.map(v => {
      const s = summary(v);
      if (s.centerId !== centerId || seen.has(s.id) || !['pending', 'accepted', 'revoked', 'expired'].includes(v.status) ||
          !stamp(v.createdAt) || !(v.acceptedAt === null || stamp(v.acceptedAt)) || !(v.revokedAt === null || stamp(v.revokedAt))) fail();
      try { if (invitationEmail(v.email) !== v.email) fail(); } catch { fail(); }
      if ((v.status === 'accepted') !== (v.acceptedAt !== null) || (v.status === 'revoked') !== (v.revokedAt !== null) ||
          (v.acceptedAt !== null && v.revokedAt !== null) || Date.parse(v.expiresAt) <= Date.parse(v.createdAt)) fail();
      seen.add(v.id);
      return pick(v, ['id', 'centerId', 'email', 'role', 'status', 'createdAt', 'expiresAt', 'acceptedAt', 'revokedAt']);
    });
  }
  async invite(centerId, input, signal) {
    if (!exact(input, ['email', 'role']) || !role(input.role)) fail('INVALID_INPUT');
    const body = { email: invitationEmail(input.email), role: input.role };
    const value = await this.#request(root(centerId), body, signal, true);
    if (value?.message !== INVITATION_REQUEST_NOTICE) fail();
    return { message: INVITATION_REQUEST_NOTICE };
  }
  async revoke(centerId, invitationId, signal) {
    if (!inviteId(invitationId)) fail('INVALID_INPUT');
    const value = await this.#request(`${root(centerId)}/${invitationId}/revoke`, {}, signal, true);
    if (value?.revoked !== true) fail();
    return { revoked: true };
  }
  async preview(token, signal) {
    if (!tokenValid(token)) fail('INVITATION_INVALID', 410);
    return summary((await this.#request('/api/local/auth/invitations/preview', { token }, signal))?.invitation);
  }
  async accept(input, signal) {
    const body = acceptInput(input, false);
    const value = await this.#request('/api/local/auth/invitations/accept', body, signal, false, true);
    return accepted(value, body, null, false);
  }
  async acceptExisting(input, signal) {
    const body = acceptInput(input, true), account = this.#api.expectedUserId;
    const value = await this.#request('/api/local/auth/invitations/accept-existing', body, signal, true);
    return accepted(value, body, account, true);
  }
}
