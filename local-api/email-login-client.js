import { LocalApiError } from './client.js';
import { syntheticAccountEmail } from './account-input.js';

export const EMAIL_LOGIN_NOTICE = '요청을 확인했어요. 발급 가능한 가상 계정은 시험 메일함에서 인증번호를 확인해 주세요.';
const fail = (code = 'INVALID_RESPONSE', status = 0) => { throw new LocalApiError(code, status); };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function emailLoginRequest(email, clientId = crypto.randomUUID()) {
  if (typeof clientId !== 'string' || !idPattern.test(clientId)) fail('INVALID_INPUT');
  return Object.freeze({ email: syntheticAccountEmail(email), clientId });
}

// Credentials live only in the controller and HttpOnly cookies, never storage,
// URL parameters, role selectors or a client-readable session token.
export class EmailLoginClient {
  constructor(transport) { this.transport = transport; }
  #anonymous(signal) {
    if (signal?.aborted) fail('CANCELLED');
    if (this.transport.expectedUserId !== null) fail('ACCOUNT_SESSION_PRESENT', 409);
  }
  async request(input, signal) {
    const body = emailLoginRequest(input.email, input.clientId);
    this.#anonymous(signal);
    const ready = await this.transport.request('/api/local/auth/email-login/start', { body: {}, signal });
    this.#anonymous(signal);
    if (ready?.ready !== true) fail();
    const result = await this.transport.request('/api/local/auth/email-login/request', { body, signal });
    this.#anonymous(signal);
    if (result?.message !== EMAIL_LOGIN_NOTICE) fail();
    return { message: EMAIL_LOGIN_NOTICE };
  }
  async verify(input, signal) {
    this.#anonymous(signal);
    if (!idPattern.test(input.clientId) || typeof input.code !== 'string' || !/^\d{8}$/.test(input.code)) fail('INVALID_INPUT');
    return this.transport.emailLoginVerify({ clientId: input.clientId, code: input.code }, signal);
  }
}
