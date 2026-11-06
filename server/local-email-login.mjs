import { createHash, randomBytes } from 'node:crypto';
import { Auth, authFail } from './auth.mjs';
import { EmailLogin } from './email-login.mjs';

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const RESPONSE = Object.freeze({ message: '요청을 확인했어요. 발급 가능한 가상 계정은 시험 메일함에서 인증번호를 확인해 주세요.' });
export const LOCAL_EMAIL_RESPONSE = RESPONSE;
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== names.length || names.some(name =>
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, name) ?? {}, 'value'))) authFail('INVALID_INPUT');
}
const invalid = () => authFail('EMAIL_LOGIN_INVALID', 401);
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !value.isWellFormed() || /[\x00-\x20\x7f-\x9f]/.test(value) || !EMAIL.test(value)) authFail('INVALID_INPUT');
  return value;
}

// Process-owned capability, never served by HTTP. No external transport exists.
export class LocalEmailMailbox {
  #messages = new Map(); #closed = false;
  #prune() { for (const [id, item] of this.#messages) if (Date.parse(item.expiresAt) <= Date.now()) this.#messages.delete(id); }
  send(delivery, clientId) {
    this.#prune();
    if (this.#closed || !ID.test(clientId) || !delivery || !/^\d{8}$/.test(delivery.code) ||
        !Number.isFinite(Date.parse(delivery.expiresAt)) || Date.parse(delivery.expiresAt) <= Date.now()) throw new Error('SYNTHETIC_MAIL_UNAVAILABLE');
    emailAddress(delivery.to);
    if (this.#messages.size >= 32) throw new Error('SYNTHETIC_MAIL_UNAVAILABLE');
    this.#messages.set(clientId, { email: delivery.to, code: delivery.code, expiresAt: delivery.expiresAt });
  }
  take(email) {
    emailAddress(email); this.#prune();
    if (this.#closed) return null;
    for (const [clientId, item] of this.#messages) if (item.email === email) {
      this.#messages.delete(clientId);
      return Object.freeze(Object.defineProperties({ clientId, expiresAt: item.expiresAt }, { code: { value: item.code } }));
    }
    return null;
  }
  close() { this.#closed = true; this.#messages.clear(); }
}

// Synthetic loopback service only: bounded volatile admissions, owned browser
// nonces and memory delivery. Not a distributed/public-production abuse policy.
export class LocalEmailLogin {
  #auth; #core; #mailbox; #browsers = new Map(); #entries = new Map();
  #recent = []; #queue = []; #scheduled = null; #running = false; #closed = false;
  #active = new Set(); #waiters = new Set();
  constructor({ auth, key, mailbox, ttlSeconds = 600 }) {
    if (!(auth instanceof Auth) || !(mailbox instanceof LocalEmailMailbox)) throw new TypeError('SYNTHETIC_EMAIL_CONFIG_INVALID');
    this.#auth = auth; this.#mailbox = mailbox;
    this.#core = new EmailLogin({ database: auth.database, auth, key, ttlSeconds });
  }
  #prune() {
    const now = performance.now();
    for (const [nonce, expiry] of this.#browsers) if (expiry <= now) this.#discard(nonce);
    for (const [id, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(id);
    this.#recent = this.#recent.filter(time => now - time < 60_000);
  }
  start(existingNonce) {
    this.#prune();
    if (this.#closed) authFail('LOCAL_API_UNAVAILABLE', 503);
    let nonce = existingNonce;
    if (!this.#browsers.has(nonce)) {
      if (this.#browsers.size >= 64) authFail('LOCAL_API_UNAVAILABLE', 503);
      nonce = randomBytes(32).toString('base64url');
    }
    this.#browsers.set(nonce, performance.now() + 660_000);
    return nonce; // Only the HTTP boundary writes this to an HttpOnly cookie.
  }
  usesAuth(auth) { return this.#auth === auth; }
  #owned(nonce) { this.#prune(); if (this.#closed || !this.#browsers.has(nonce)) invalid(); }
  request(input, nonce) {
    exact(input, ['email', 'clientId']); this.#owned(nonce);
    const email = emailAddress(input.email), { clientId } = input;
    if (typeof clientId !== 'string' || !ID.test(clientId)) authFail('INVALID_INPUT');
    const id = `${nonce}:${clientId}`, previous = this.#entries.get(id);
    if (previous) { if (previous.email !== email) authFail('INVALID_INPUT'); return RESPONSE; }
    // The same public receipt is returned without waiting for DB lookup or
    // delivery, including unknown accounts, full queues and throttling.
    if (this.#entries.size >= 128 || this.#queue.length >= 16 || this.#recent.length >= 32) return RESPONSE;
    const entry = { id, nonce, email, clientId, expires: performance.now() + 630_000, challenge: null, sessionHash: null };
    this.#entries.set(id, entry); this.#queue.push(entry); this.#recent.push(performance.now());
    if (!this.#running && this.#scheduled === null) this.#scheduled = setImmediate(() => {
      this.#scheduled = null; this.#running = true; void this.#drain();
    });
    return RESPONSE;
  }
  #current(entry) { return !this.#closed && this.#browsers.get(entry.nonce) > performance.now() && entry.expires > performance.now() && this.#entries.get(entry.id) === entry; }
  async #drain() {
    try {
      while (!this.#closed && this.#queue.length) {
        const entry = this.#queue.shift();
        if (!this.#current(entry)) continue;
        try {
          const prepared = await this.#core.prepare({ email: entry.email }, entry.nonce);
          if (!this.#current(entry)) continue;
          entry.challenge = prepared.challenge;
          if (prepared.delivery) this.#mailbox.send(prepared.delivery, entry.clientId);
        } catch { /* Same admission response; no automatic re-issue or raw log. */ }
      }
    } finally { this.#running = false; this.#settled(); }
  }
  async verify(input, nonce, currentSessionToken = null) {
    exact(input, ['clientId', 'code']); this.#owned(nonce);
    if (typeof input.clientId !== 'string' || !ID.test(input.clientId) || typeof input.code !== 'string' || input.code.length > 64) authFail('INVALID_INPUT');
    const entry = this.#entries.get(`${nonce}:${input.clientId}`);
    if (!entry?.challenge) invalid();
    if (currentSessionToken && entry.sessionHash !== digest(currentSessionToken)) authFail('ACCOUNT_SESSION_PRESENT', 409);
    const work = (async () => {
      const result = await this.#core.verify({ challenge: entry.challenge, code: input.code }, nonce);
      if (!this.#current(entry)) {
        // Logout/close/password login can win while verification awaits SQL.
        // Never install the late session, and revoke the token it just minted.
        await this.#auth.logout(result.token); invalid();
      }
      entry.sessionHash = digest(result.token);
      Object.defineProperty(entry, 'sessionToken', { value: result.token, configurable: true });
      return result;
    })();
    this.#active.add(work);
    try { return await work; } finally { this.#active.delete(work); this.#settled(); }
  }
  #discard(nonce) {
    this.#browsers.delete(nonce);
    for (const [id, entry] of this.#entries) if (entry.nonce === nonce) this.#entries.delete(id);
    this.#queue = this.#queue.filter(entry => entry.nonce !== nonce);
  }
  async invalidate(nonce) {
    const tokens = [...this.#entries.values()].filter(entry => entry.nonce === nonce && entry.sessionToken).map(entry => entry.sessionToken);
    this.#discard(nonce);
    // Include a successful reply still in flight whose cookie the browser has
    // not received. A delayed Set-Cookie then carries only a revoked session.
    await Promise.all(tokens.map(token => this.#auth.logout(token)));
  }
  #settled() {
    if (this.#running || this.#scheduled !== null || this.#queue.length || this.#active.size) return;
    for (const done of this.#waiters) done(); this.#waiters.clear();
  }
  idle() {
    if (!this.#running && this.#scheduled === null && !this.#queue.length && !this.#active.size) return Promise.resolve();
    return new Promise(done => this.#waiters.add(done));
  }
  async close() {
    this.#closed = true; this.#browsers.clear(); this.#entries.clear(); this.#queue.length = 0; this.#recent.length = 0;
    this.#mailbox.close();
    if (this.#scheduled !== null) { clearImmediate(this.#scheduled); this.#scheduled = null; }
    this.#settled(); await this.idle();
  }
}

export function localEmailLoginRoute(url, method) {
  const match = /^\/api\/local\/auth\/email-login\/(start|request|verify)$/.exec(url.pathname);
  if (!match) return null;
  if (method !== 'POST') authFail('NOT_FOUND', 404);
  if ([...url.searchParams].length) authFail('INVALID_INPUT');
  return { action: match[1] };
}
