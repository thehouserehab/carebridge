import { AccountDelivery } from './account-delivery.mjs';
import { authFail } from './auth.mjs';

const RESPONSE = Object.freeze({ message: '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.' });
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/i;
// Deliberately small, process-owned synthetic limits. They are not a durable,
// distributed abuse policy or a guarantee of identical network response time.
const MAX_QUEUED = 16, MAX_PER_MINUTE = 32, WINDOW_MS = 60_000;
function exactObject(value, names) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).length !== names.length || names.some(name =>
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, name) ?? {}, 'value'))) authFail('INVALID_INPUT');
  } catch { authFail('INVALID_INPUT'); }
}
function address(input) {
  exactObject(input, ['email']);
  const value = input.email;
  if (typeof value !== 'string' || value.length > 254 || !value.isWellFormed() ||
      /[\x00-\x1f\x7f-\x9f]/.test(value) || !EMAIL.test(value.trim())) authFail('INVALID_INPUT');
  return value.trim().toLowerCase();
}

// Trusted AccountDelivery only. Public admission never calls Auth or waits for
// issuance/delivery. No outcome, queued recipient, token or error is logged.
export class LocalPasswordRecovery {
  #delivery;
  #queue = [];
  #recent = new Map();
  #admissions = [];
  #scheduled = null;
  #running = false;
  #activeEmail = null;
  #closed = false;
  #waiters = new Set();
  #closing;
  constructor(options) {
    exactObject(options, ['accountDelivery']);
    if (!(options.accountDelivery instanceof AccountDelivery)) authFail('LOCAL_API_UNAVAILABLE', 503);
    this.#delivery = options.accountDelivery;
  }
  request(input) {
    const email = address(input), now = performance.now();
    if (this.#closed) return RESPONSE;
    this.#admissions = this.#admissions.filter(time => now - time < WINDOW_MS);
    for (const [recipient, time] of this.#recent) if (now - time >= WINDOW_MS) this.#recent.delete(recipient);
    if (this.#recent.has(email) || this.#queue.includes(email) || this.#activeEmail === email ||
        this.#queue.length >= MAX_QUEUED || this.#admissions.length >= MAX_PER_MINUTE) return RESPONSE;
    this.#recent.set(email, now); this.#admissions.push(now); this.#queue.push(email);
    if (!this.#running && this.#scheduled === null) this.#scheduled = setImmediate(() => {
      this.#scheduled = null; this.#running = true;
      // The drain catches each delivery failure and has no public callback.
      void this.#drain();
    });
    return RESPONSE;
  }
  async #drain() {
    try {
      while (!this.#closed && this.#queue.length) {
        const email = this.#queue.shift();
        this.#activeEmail = email;
        try { await this.#delivery.recover({ email }); } catch { /* No retry or raw diagnostic. */ }
        finally { this.#activeEmail = null; }
      }
    } finally { this.#running = false; this.#settled(); }
  }
  #settled() {
    if (this.#running || this.#scheduled !== null || this.#queue.length) return;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
  idle() {
    if (!this.#running && this.#scheduled === null && !this.#queue.length) return Promise.resolve();
    return new Promise(resolve => this.#waiters.add(resolve));
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#queue.length = 0; this.#recent.clear(); this.#admissions.length = 0;
    if (this.#scheduled !== null) { clearImmediate(this.#scheduled); this.#scheduled = null; }
    this.#settled();
    // Never turn an observation deadline into completion. The current recover()
    // must settle; this local runtime pairs it with a synchronous memory mailbox.
    this.#closing = this.idle();
    return this.#closing;
  }
}
