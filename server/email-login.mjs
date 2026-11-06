import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Auth, authFail, normalizeEmail } from './auth.mjs';

export const EMAIL_LOGIN_LIMITS = Object.freeze({
  ttlSeconds: 600, cooldownSeconds: 60, hourlyLimit: 3, attempts: 5, retrySeconds: 30,
});
const BROWSER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^el1\.[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{8}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid = () => authFail('EMAIL_LOGIN_INVALID', 401);
function keys(input, expected) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== expected.length || expected.some(key =>
        !Object.hasOwn(input, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')))
    authFail('INVALID_INPUT');
}
function binding(value) {
  if (typeof value !== 'string' || !BROWSER_TOKEN.test(value)) authFail('INVALID_INPUT');
  return value;
}
function sameHex(a, b) {
  return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Internal authentication service, NOT a public endpoint or a mail transport.
// Used by the memory-only local synthetic adapter, never the E runtime/public
// demo. Requires the separate schema proposal and a server-only key. No fallback.
// A future HTTP adapter must own an HttpOnly browser nonce, enforce HTTPS,
// exact-origin/CSRF checks, shared request-wide limits and asynchronous delivery
// with uniform responses. Never serialize delivery or expose prepare timing.
export class EmailLogin {
  #database;
  #auth;
  #key;
  #ttl;
  constructor({ database, auth, key, ttlSeconds = EMAIL_LOGIN_LIMITS.ttlSeconds }) {
    if (!(auth instanceof Auth) || auth.database !== database || !database?.transaction ||
        !Buffer.isBuffer(key) || key.length !== 32 || !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < 1 || ttlSeconds > EMAIL_LOGIN_LIMITS.ttlSeconds)
      throw new TypeError('EMAIL_LOGIN_CONFIG_INVALID');
    this.#database = database;
    this.#auth = auth;
    this.#key = Buffer.from(key);
    this.#ttl = ttlSeconds;
  }
  #mac(purpose, ...values) {
    return createHmac('sha256', this.#key).update(JSON.stringify(['carebridge-email-login-v1', purpose, ...values])).digest('hex');
  }

  async prepare(input, browserToken) {
    keys(input, ['email']);
    const email = normalizeEmail(input.email);
    // A single ASCII mailbox; prohibit header injection, lists and display names.
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(email)) authFail('INVALID_INPUT');
    binding(browserToken);
    const challenge = `el1.${randomBytes(32).toString('base64url')}`;
    const idHash = sha256(challenge), bindingHash = this.#mac('binding', browserToken);
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const delivery = await this.#database.transaction(async tx => {
      const { rows: accounts } = await tx.query(`SELECT user_id,email,locked_until>clock_timestamp() AS locked
        FROM cb_auth_accounts WHERE email=$1 FOR UPDATE`, [email]);
      const account = accounts[0];
      if (!account || account.locked) return null;
      const { rows: users } = await tx.query('SELECT id FROM cb_users WHERE id=$1 AND active FOR SHARE', [account.user_id]);
      if (!users.length) return null;
      const { rows: limits } = await tx.query(`SELECT COUNT(*) AS issued,
        COALESCE(MAX(created_at)>clock_timestamp()-($2*interval '1 second'),false) AS recent
        FROM cb_auth_email_logins WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'`,
      [account.user_id, EMAIL_LOGIN_LIMITS.cooldownSeconds]);
      if (limits[0].recent || Number(limits[0].issued) >= EMAIL_LOGIN_LIMITS.hourlyLimit) return null;
      await tx.query(`UPDATE cb_auth_email_logins SET revoked_at=clock_timestamp()
        WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [account.user_id]);
      const { rows } = await tx.query(`INSERT INTO cb_auth_email_logins
        (id_hash,user_id,binding_hash,code_hash,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+($5*interval '1 second'))
        RETURNING expires_at`, [idHash, account.user_id, bindingHash, this.#mac('code', challenge, code), this.#ttl]);
      return Object.freeze(Object.defineProperties({ expiresAt: new Date(rows[0].expires_at).toISOString() }, {
        to: { value: account.email }, code: { value: code }, challenge: { value: challenge },
      }));
    });
    // Every syntactically valid request has the same public shape, including
    // unknown, inactive and rate-limited accounts. Delivery is internal only.
    return Object.freeze(Object.defineProperty({ challenge,
      message: '로그인 가능한 계정이면 등록된 이메일로 인증번호를 보내드립니다.' }, 'delivery', { value: delivery }));
  }

  async verify(input, browserToken) {
    keys(input, ['challenge', 'code']); binding(browserToken);
    if (typeof input.challenge !== 'string' || !CHALLENGE.test(input.challenge) || typeof input.code !== 'string') invalid();
    const { challenge, code } = input;
    const idHash = sha256(challenge), bindingHash = this.#mac('binding', browserToken);
    // Stable ONLY for this unpredictable browser nonce + challenge. This lets
    // the same browser recover a lost success response without storing a raw
    // session token, extending expiry or minting a second session.
    const token = Buffer.from(this.#mac('session', challenge, browserToken), 'hex').toString('base64url');
    const tokenHash = sha256(token);
    const accepted = await this.#database.transaction(async tx => {
      const { rows: hints } = await tx.query('SELECT user_id FROM cb_auth_email_logins WHERE id_hash=$1', [idHash]);
      if (!hints.length) return false;
      // Match existing credential mutation lock ordering: account -> user -> proof.
      const { rows: accounts } = await tx.query(`SELECT user_id,locked_until>clock_timestamp() AS locked
        FROM cb_auth_accounts WHERE user_id=$1 FOR UPDATE`, [hints[0].user_id]);
      if (!accounts.length || accounts[0].locked) return false;
      const userId = accounts[0].user_id;
      const { rows: users } = await tx.query('SELECT id FROM cb_users WHERE id=$1 AND active FOR SHARE', [userId]);
      if (!users.length) return false;
      const { rows } = await tx.query(`SELECT *,expires_at>clock_timestamp() AS fresh,
        consumed_at>clock_timestamp()-($2*interval '1 second') AS retryable
        FROM cb_auth_email_logins WHERE id_hash=$1 AND user_id=$3 FOR UPDATE`, [idHash, EMAIL_LOGIN_LIMITS.retrySeconds, userId]);
      const proof = rows[0];
      if (!proof || proof.revoked_at || !sameHex(proof.binding_hash, bindingHash)) return false;
      const matches = CODE.test(code) && sameHex(proof.code_hash, this.#mac('code', challenge, code));
      if (proof.consumed_at) {
        if (!proof.retryable || !matches || proof.session_hash !== tokenHash) return false;
        const { rows: sessions } = await tx.query(`SELECT 1 FROM cb_auth_sessions
          WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [tokenHash, userId]);
        return sessions.length === 1;
      }
      if (!proof.fresh || proof.attempts >= EMAIL_LOGIN_LIMITS.attempts) return false;
      if (!matches) {
        await tx.query('UPDATE cb_auth_email_logins SET attempts=attempts+1 WHERE id_hash=$1', [idHash]);
        return false; // Commit failed-attempt counters, then throw outside the transaction.
      }
      const consumed = await tx.query(`UPDATE cb_auth_email_logins SET consumed_at=clock_timestamp(),session_hash=$2
        WHERE id_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND attempts<$3 AND expires_at>clock_timestamp()`,
      [idHash, tokenHash, EMAIL_LOGIN_LIMITS.attempts]);
      if (!consumed.rowCount) return false;
      await tx.query(`INSERT INTO cb_auth_sessions(token_hash,user_id,expires_at)
        VALUES ($1,$2,clock_timestamp()+($3*interval '1 second'))`, [tokenHash, userId, this.#auth.sessionTtlSeconds]);
      return true;
    }).catch(error => {
      // The DB clock can cross expiry between the UPDATE predicate and its
      // trigger. Roll back and treat only this exact constraint as an invalid
      // proof; infrastructure and other integrity failures must remain visible
      // to the future server error boundary, never as a fabricated success.
      if (error?.code === '23514' && error.constraint === 'cb_email_login_expired') return false;
      throw error;
    });
    if (!accepted) invalid();
    // Existing Auth reads current memberships, never a role supplied by a form.
    // It also checks revocation again if it wins immediately after the commit.
    const user = await this.#auth.authenticate(token);
    if (!user) invalid();
    return Object.freeze(Object.defineProperty({ user, approvalRequired: user.centers.length === 0 }, 'token', { value: token }));
  }
}
