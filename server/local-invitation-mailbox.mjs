// Synthetic process-owned delivery only. Never mount this capability on HTTP,
// serialize it, or treat possession as evidence of real mailbox ownership.
const PREFIX = 'https://carebridge.test/account/invitation#token=';
const MAX_MESSAGES = 32, TTL = 15 * 60 * 1000;
const unavailable = () => { throw new Error('Synthetic invitation delivery unavailable.'); };
const address = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/.test(value);

export class LocalInvitationMailbox {
  #messages = [];
  #closed = false;
  #prune() { this.#messages = this.#messages.filter(message => message.expires > Date.now()); }
  async send(envelope, { signal } = {}) {
    if (this.#closed || signal?.aborted) unavailable();
    this.#prune();
    if (envelope?.purpose !== 'invitation' || !address(envelope.to) || typeof envelope.link !== 'string' ||
        !/^https:\/\/carebridge\.test\/account\/invitation#token=[A-Za-z0-9_-]{40,100}$/.test(envelope.link) ||
        this.#messages.length >= MAX_MESSAGES) unavailable();
    // Retain neither mail body nor caller object. Non-enumerability is an
    // accidental-log safeguard, not a claim that same-process code is isolated.
    this.#messages.push({ to: envelope.to, token: envelope.link.slice(PREFIX.length), expires: Date.now() + TTL });
    // Internal queue acknowledgement only, never evidence of external mail.
    return { status: 'accepted' };
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
    // Only this trusted fixed landing path can be remapped to the owned listener.
    return `${origin}/account/invitation#token=${message.token}`;
  }
  close() { this.#closed = true; this.#messages.length = 0; }
}
