// Synthetic process-owned recovery capability. Never mount this on HTTP or
// treat it as proof of an actual user's mailbox ownership.
const PREFIX = 'https://carebridge.test/account/password-recovery#token=';
const MAX_MESSAGES = 32, TTL = 15 * 60 * 1000;
const unavailable = () => { throw new Error('Synthetic recovery delivery unavailable.'); };
const address = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/.test(value);

export class LocalRecoveryMailbox {
  #messages = [];
  #closed = false;
  #prune() { this.#messages = this.#messages.filter(message => message.expires > Date.now()); }
  async send(envelope, { signal } = {}) {
    if (this.#closed || signal?.aborted) unavailable();
    this.#prune();
    if (envelope?.purpose !== 'password-recovery' || !address(envelope.to) || typeof envelope.link !== 'string' ||
        !/^https:\/\/carebridge\.test\/account\/password-recovery#token=cr1\.[A-Za-z0-9_-]{43}$/.test(envelope.link) ||
        this.#messages.length >= MAX_MESSAGES) unavailable();
    this.#messages.push({ to: envelope.to, token: envelope.link.slice(PREFIX.length), expires: Date.now() + TTL });
    return { status: 'accepted' }; // Private memory acceptance, not external mail.
  }
  take(email, origin) {
    if (this.#closed || !address(email) || typeof origin !== 'string') unavailable();
    let parsed;
    try { parsed = new URL(origin); } catch { unavailable(); }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin ||
        !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1024 || Number(parsed.port) > 65535) unavailable();
    this.#prune();
    const index = this.#messages.findIndex(message => message.to === email);
    if (index < 0) return null;
    const [message] = this.#messages.splice(index, 1);
    return `${origin}/account/password-recovery#token=${message.token}`;
  }
  close() { this.#closed = true; this.#messages.length = 0; }
}
