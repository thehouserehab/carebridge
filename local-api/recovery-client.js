import { LocalApiError } from './client.js';
import { syntheticAccountEmail } from './account-input.js';
import { isRecoveryToken } from './recovery-token.js';

export const RECOVERY_REQUEST_NOTICE = '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.';
const fail = (code = 'INVALID_RESPONSE', status = 0) => { throw new LocalApiError(code, status); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function recoveryCompletion(input) {
  if (!exact(input, ['token', 'newPassword', 'confirmation'])) fail('INVALID_INPUT');
  // Snapshot once before any asynchronous transport work.
  const { token, newPassword, confirmation } = input;
  if (!isRecoveryToken(token)) fail('PASSWORD_RECOVERY_INVALID', 410);
  if (![newPassword, confirmation].every(value => typeof value === 'string' && value.length >= 12 && value.length <= 128 && value.isWellFormed())) fail('INVALID_INPUT');
  if (newPassword !== confirmation) fail('PASSWORD_CONFIRMATION_MISMATCH');
  return { token, newPassword, confirmation };
}

// Cookie transport only. No response/credential cache, retries, or auto-login.
export class RecoveryApiClient {
  #api;
  constructor(api) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    this.#api = api;
  }
  async #request(path, body, signal) {
    const account = this.#api.expectedUserId;
    const current = () => {
      if (signal?.aborted) fail('CANCELLED');
      if (this.#api.expectedUserId !== account) fail('AUTH_REQUIRED', 401);
      if (account !== null) fail('ACCOUNT_SESSION_PRESENT', 409);
    };
    current();
    try { const result = await this.#api.request(path, { body, signal }); current(); return result; }
    catch (error) { current(); if (error instanceof LocalApiError) throw error; fail('UNAVAILABLE'); }
  }
  async request(email, signal) {
    const body = { email: syntheticAccountEmail(email) };
    const result = await this.#request('/api/local/auth/password-recovery/request', body, signal);
    if (result?.message !== RECOVERY_REQUEST_NOTICE) fail();
    return { message: RECOVERY_REQUEST_NOTICE };
  }
  async complete(input, signal) {
    const body = recoveryCompletion(input);
    const result = await this.#request('/api/local/auth/password-recovery/complete', body, signal);
    if (result?.passwordChanged !== true || result?.reauthenticate !== true) fail();
    return { passwordChanged: true, reauthenticate: true };
  }
}
