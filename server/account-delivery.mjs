import { INVITATION_ROLES, normalizeEmail } from './auth.mjs';

const PUBLIC_RESPONSE = Object.freeze({ message: '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.' });
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const PURPOSES = Object.freeze({
  invitation: Object.freeze({ path: '/account/invitation', subject: 'Carebridge 계정 초대 안내',
    introduction: 'Carebridge 계정 초대가 준비되었습니다. 아래 링크에서 대상 센터와 역할을 확인한 뒤 수락해 주세요.' }),
  'password-recovery': Object.freeze({ path: '/account/password-recovery', subject: 'Carebridge 비밀번호 재설정 안내',
    introduction: 'Carebridge 비밀번호 재설정을 요청하셨다면 아래 링크에서 새 비밀번호를 설정해 주세요.' }),
});

export class AccountDeliveryError extends Error {
  constructor(code) {
    const safeCode = code === 'INVALID_CONFIG' ? code : 'INVALID_INPUT';
    super(safeCode);
    this.name = 'AccountDeliveryError';
    this.code = safeCode;
  }
}
const invalid = (code = 'INVALID_INPUT') => { throw new AccountDeliveryError(code); };
function keys(value, allowed, required = allowed) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some((key) => !allowed.includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
        required.some((key) => !Object.hasOwn(value, key))) invalid();
  } catch { invalid(); }
}
function address(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) invalid();
  let normalized;
  try { normalized = normalizeEmail(value); } catch { invalid(); }
  // One ASCII mailbox, not a display name, recipient list or raw mail header.
  if (!ADDRESS.test(normalized)) invalid();
  return normalized;
}
function trustedOrigin(value) {
  if (typeof value !== 'string' || /[^\x21-\x7e]|\\/.test(value)) invalid('INVALID_CONFIG');
  let parsed;
  try { parsed = new URL(value); } catch { invalid('INVALID_CONFIG'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.origin !== value) invalid('INVALID_CONFIG');
  return parsed.origin;
}
function result(issuance, delivery) {
  // These internal states can reveal account existence. Never use them for a
  // public response; only publicResponse is intended to cross that boundary.
  return Object.freeze(Object.defineProperty({ publicResponse: PUBLIC_RESPONSE }, 'internal', {
    value: Object.freeze({ issuance, delivery }),
  }));
}
function envelope(purpose, origin, token, recipient) {
  const metadata = PURPOSES[purpose];
  if (!(purpose === 'invitation' ? /^[A-Za-z0-9_-]{40,100}$/ : /^cr1\.[A-Za-z0-9_-]{43}$/).test(token)) invalid();
  const to = address(recipient.email);
  if (typeof recipient.expiresAt !== 'string' || !Number.isFinite(Date.parse(recipient.expiresAt))) invalid();
  // Reserved future paths, not routes connected to the current rehearsal UI.
  // A fragment avoids a bearer in an HTTP request URL. The future landing page
  // still needs no-referrer/no-store, prompt fragment removal and safe scripts.
  const link = `${origin}${metadata.path}#token=${encodeURIComponent(token)}`;
  const text = `${metadata.introduction}\n\n${link}\n\n사용 가능 시각(UTC): ${new Date(recipient.expiresAt).toISOString()}\n요청하지 않았다면 이 안내를 무시해 주세요. 링크를 다른 사람에게 전달하지 마세요.`;
  return Object.freeze(Object.defineProperties({ purpose }, {
    to: { value: to }, subject: { value: metadata.subject }, text: { value: text }, link: { value: link },
  }));
}

// Internal, provider-independent, one-attempt delivery. No HTTP, environment,
// SMTP, outbox, retry loop or secret persistence. Dependencies are trusted
// process-owned ports, not request input. Non-enumerability prevents ordinary
// JSON/inspection accidents, not deliberate reflection or a leaking transport.
// A future public API MUST enqueue independently, make timing uniform and add
// request-wide abuse limits; returning the same JSON alone is insufficient.
export class AccountDelivery {
  #auth;
  #origin;
  #send;
  #timeout;
  constructor(options) {
    try {
      keys(options, ['auth', 'origin', 'transport', 'timeoutMilliseconds'], ['auth', 'origin', 'transport']);
      const { auth, origin, transport, timeoutMilliseconds = 10_000 } = options;
      if (!auth || !['createInvitation', 'preparePasswordRecovery', 'accountDeliveryRecipient']
        .every((name) => typeof auth[name] === 'function') || typeof transport?.send !== 'function' ||
          !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 60_000)
        invalid('INVALID_CONFIG');
      this.#origin = trustedOrigin(origin);
      this.#auth = auth;
      this.#send = transport.send.bind(transport);
      this.#timeout = timeoutMilliseconds;
    } catch { invalid('INVALID_CONFIG'); }
  }
  async invite(actor, input) {
    keys(input, ['centerId', 'email', 'role']);
    const request = { centerId: input.centerId, email: address(input.email), role: input.role };
    let userId;
    try { userId = actor?.userId; } catch { invalid(); }
    if (typeof userId !== 'string' || !ID.test(userId) || typeof request.centerId !== 'string' ||
        !ID.test(request.centerId) || !INVITATION_ROLES.includes(request.role)) invalid();
    let issued;
    try { issued = await this.#auth.createInvitation({ userId }, request); }
    catch { return result('unknown', 'not-attempted'); }
    return this.#deliver('invitation', issued);
  }
  async recover(input) {
    keys(input, ['email']);
    const request = { email: address(input.email) };
    let issued;
    try { issued = await this.#auth.preparePasswordRecovery(request); }
    catch { return result('unknown', 'not-attempted'); }
    return this.#deliver('password-recovery', issued);
  }
  async #deliver(purpose, issued) {
    if (!issued) return result('not-issued', 'not-attempted');
    let message;
    try {
      const token = issued.token;
      const recipient = await this.#auth.accountDeliveryRecipient({ purpose, token });
      if (!recipient) return result('issued', 'not-attempted');
      message = envelope(purpose, this.#origin, token, recipient);
    } catch { return result('issued', 'not-attempted'); }
    const controller = new AbortController();
    let timer;
    // Attach both handlers immediately: a timeout does not imply cancellation,
    // and a late rejection must neither escape nor trigger another attempt.
    const attempt = Promise.resolve().then(() => this.#send(message, { signal: controller.signal }))
      .then((value) => value?.status === 'accepted' ? 'accepted' : value?.status === 'rejected' ? 'rejected' : 'unknown',
        () => 'unknown').catch(() => 'unknown');
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve('unknown');
        controller.abort();
      }, this.#timeout);
    });
    try { return result('issued', await Promise.race([attempt, timeout])); }
    finally { clearTimeout(timer); }
  }
}
