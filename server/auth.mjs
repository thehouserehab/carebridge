import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const SESSION_BYTES = 32;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const INVITATION_TTL_SECONDS = 48 * 60 * 60;
const RECOVERY_TTL_SECONDS = 15 * 60;
const RECOVERY_COOLDOWN_SECONDS = 60;
const RECOVERY_HOURLY_LIMIT = 3;
const LOCK_THRESHOLD = 5;
const LOCK_SECONDS = 15 * 60;
const HASH_KEY_BYTES = 64;
const DEFAULT_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const DUMMY_PASSWORD = 'Carebridge unavailable credential';
const DUMMY_SALT = Buffer.from('carebridge-auth-dummy-salt', 'utf8');
export const INVITATION_ROLES = Object.freeze(['therapist', 'guardian', 'care_recipient']);
const INVITATION_ROLE = new Set(INVITATION_ROLES);

export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function authFail(code, status = 400) {
  throw new AuthError(code, status);
}

function assertUserId(value) {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) authFail('INVALID_INPUT');
  return value;
}

function assertCenterId(value) {
  return assertUserId(value);
}

function assertInvitationId(value) {
  if (typeof value !== 'string' || !/^inv_[a-f0-9]{32}$/.test(value)) authFail('INVALID_INPUT');
  return value;
}

function assertInvitationRole(value) {
  if (!INVITATION_ROLE.has(value)) authFail('INVALID_INPUT');
  return value;
}

function assertInvitationToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(value))
    authFail('INVITATION_INVALID', 410);
  return value;
}

function assertRecoveryToken(value) {
  // Purpose-separated from invitation/session credentials, including syntax.
  if (typeof value !== 'string' || !/^cr1\.[A-Za-z0-9_-]{43}$/.test(value))
    authFail('PASSWORD_RECOVERY_INVALID', 410);
  return value;
}

function assertObjectKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))) authFail('INVALID_INPUT');
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') authFail('INVALID_INPUT');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email))
    authFail('INVALID_INPUT');
  return email;
}

function assertPassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX)
    authFail('INVALID_INPUT');
  return value;
}

function passwordParams(options = {}) {
  const params = { ...DEFAULT_SCRYPT, ...options };
  if (!Number.isSafeInteger(params.N) || params.N < 1024 || (params.N & (params.N - 1)) !== 0)
    throw new Error('Invalid scrypt N parameter.');
  if (!Number.isSafeInteger(params.r) || params.r < 1 || params.r > 32)
    throw new Error('Invalid scrypt r parameter.');
  if (!Number.isSafeInteger(params.p) || params.p < 1 || params.p > 16)
    throw new Error('Invalid scrypt p parameter.');
  if (!Number.isSafeInteger(params.maxmem) || params.maxmem < 32 * 1024 * 1024)
    throw new Error('Invalid scrypt maxmem parameter.');
  return params;
}

function encodeHash(password, salt, params) {
  const derived = scryptSync(password, salt, HASH_KEY_BYTES, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function hashPassword(password, params) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, HASH_KEY_BYTES, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

function parseHash(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const params = passwordParams({
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  });
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || expected.length !== HASH_KEY_BYTES) return null;
  return { params, salt, expected };
}

async function verifyPassword(password, encoded) {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const candidate = await scryptAsync(
    typeof password === 'string' ? password : '',
    parsed.salt,
    parsed.expected.length,
    parsed.params,
  );
  const actual = Buffer.from(candidate);
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

function sessionToken() {
  return randomBytes(SESSION_BYTES).toString('base64url');
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function iso(value) {
  return new Date(value).toISOString();
}

function identity(userId, email, memberships, expiresAt) {
  return {
    userId,
    email,
    centers: memberships.map((row) => ({ id: row.center_id, role: row.role })),
    expiresAt: iso(expiresAt),
  };
}

// All account + session mutations take the account lock first. A session
// lookup is only a hint until it is revalidated after that lock; otherwise
// accepting an invitation can deadlock with revoking every session.
async function lockSessionAccount(tx, hash, passwordProof = false) {
  const { rows: hints } = await tx.query('SELECT user_id FROM cb_auth_sessions WHERE token_hash = $1', [hash]);
  if (!hints.length) authFail('AUTH_REQUIRED', 401);
  const columns = passwordProof ? ',a.password_hash,a.failed_attempts,a.locked_until > clock_timestamp() AS locked' : '';
  const { rows: accounts } = await tx.query(`SELECT a.user_id,a.email${columns}
    FROM cb_auth_accounts a WHERE a.user_id = $1 FOR UPDATE OF a`, [hints[0].user_id]);
  if (!accounts.length) authFail('AUTH_REQUIRED', 401);
  const { rows: sessions } = await tx.query(`SELECT s.user_id,s.expires_at FROM cb_auth_sessions s
    JOIN cb_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.user_id = $2
      AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.active FOR SHARE OF s,u`, [hash, accounts[0].user_id]);
  if (!sessions.length) authFail('AUTH_REQUIRED', 401);
  return { account: accounts[0], session: sessions[0] };
}

// Login and sensitive password proofs share the same persistent attempt bound.
// A proof made with a session that expired while awaiting crypto cannot alter
// another credential's lockout state. The caller commits a failure marker.
async function failedPasswordProof(tx, account, requiredSessionHash = null) {
  const attempts = Math.min(LOCK_THRESHOLD, Number(account.failed_attempts) + 1);
  const result = await tx.query(`UPDATE cb_auth_accounts SET failed_attempts = $2,
    locked_until = CASE WHEN $2 >= ${LOCK_THRESHOLD} THEN clock_timestamp() + ($3 * interval '1 second') ELSE NULL END
    WHERE user_id = $1 AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM cb_auth_sessions s
      WHERE s.token_hash = $4 AND s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()))`,
  [account.user_id, attempts, LOCK_SECONDS, requiredSessionHash]);
  return result.rowCount > 0;
}

async function requireCenterManager(tx, actor, centerId) {
  assertUserId(actor?.userId);
  assertCenterId(centerId);
  const result = await tx.query(`SELECT 1
    FROM cb_users u
    JOIN cb_memberships m ON m.user_id = u.id
    WHERE u.id = $1 AND u.active AND m.center_id = $2
      AND m.role = 'center' AND m.active FOR SHARE OF u,m`, [actor.userId, centerId]);
  if (!result.rows.length) authFail('FORBIDDEN', 403);
}

async function invitationForAcceptance(tx,hash) {
  const { rows } = await tx.query(`SELECT id,center_id,email,role,invited_by,accepted_user_id,accepted_at,revoked_at,
      expires_at <= clock_timestamp() AS expired FROM cb_auth_invitations WHERE token_hash = $1 FOR UPDATE`,[hash]);
  if (!rows.length) authFail('INVITATION_INVALID',410);
  return rows[0];
}
async function requireCurrentInviter(tx,invitation) {
  try { await requireCenterManager(tx,{ userId:invitation.invited_by },invitation.center_id); }
  catch (error) { if (error instanceof AuthError && error.code === 'FORBIDDEN') authFail('INVITATION_INVALID',410); throw error; }
}
async function consumeInvitation(tx,invitation,userId,sessionHash = null) {
  // Re-check the clock at the actual acceptance write: an invitation/session
  // may expire while locks were being awaited. Failure rolls the grant back.
  const { rows } = await tx.query(`UPDATE cb_auth_invitations SET accepted_user_id = $2,accepted_at = clock_timestamp()
    WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM cb_auth_sessions WHERE token_hash = $3 AND user_id = $2
        AND revoked_at IS NULL AND expires_at > clock_timestamp())) RETURNING id`,[invitation.id,userId,sessionHash]);
  if (!rows.length) {
    if (sessionHash) {
      const { rows: sessions } = await tx.query(`SELECT 1 FROM cb_auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,[sessionHash]);
      if (!sessions.length) authFail('AUTH_REQUIRED',401);
    }
    authFail('INVITATION_INVALID',410);
  }
}

function invitationStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.accepted_at) return 'accepted';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

export class Auth {
  constructor(database, {
    sessionTtlSeconds = SESSION_TTL_SECONDS,
    recoveryTtlSeconds = RECOVERY_TTL_SECONDS,
    password = DEFAULT_SCRYPT,
  } = {}) {
    if (!database?.transaction) throw new TypeError('Auth requires a transactional database.');
    if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 7 * 24 * 60 * 60)
      throw new TypeError('Invalid session TTL.');
    if (!Number.isSafeInteger(recoveryTtlSeconds) || recoveryTtlSeconds < 1 || recoveryTtlSeconds > RECOVERY_TTL_SECONDS)
      throw new TypeError('Invalid recovery TTL.');
    this.database = database;
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.recoveryTtlSeconds = recoveryTtlSeconds;
    this.password = passwordParams(password);
    this.dummyHash = encodeHash(DUMMY_PASSWORD, DUMMY_SALT, this.password);
  }

  // Account creation is intentionally not an HTTP endpoint. A future center
  // invitation/provisioning workflow must call this only after establishing
  // the approved internal cb_users row; center membership is provisioned by
  // the separate relationship workflow.
  async provisionAccount({ userId, email, password }) {
    assertUserId(userId);
    const normalizedEmail = normalizeEmail(email);
    const validPassword = assertPassword(password);
    const passwordHash = await hashPassword(validPassword, this.password);
    try {
      return await this.database.transaction(async (tx) => {
        const user = await tx.query('SELECT id FROM cb_users WHERE id = $1 AND active', [userId]);
        if (!user.rows.length) authFail('USER_NOT_FOUND', 404);
        await tx.query(`INSERT INTO cb_auth_accounts(user_id, email, password_hash)
          VALUES ($1, $2, $3)`, [userId, normalizedEmail, passwordHash]);
        return { userId, email: normalizedEmail };
      });
    } catch (error) {
      if (error.code === '23505') authFail('ACCOUNT_EXISTS', 409);
      throw error;
    }
  }

  // Privileged operator workflow ONLY, never an HTTP handler or public signup.
  // Use a separate DB role with access to cb_center_bootstraps; the normal
  // runtime role must not have INSERT permission on that receipt table.
  async bootstrapNewCenter(input) {
    assertObjectKeys(input,['operationId','centerId','confirmNewCenter','email','password']);
    const centerId = assertCenterId(input.centerId), operationId = input.operationId;
    if (input.confirmNewCenter !== centerId || typeof operationId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) authFail('INVALID_INPUT');
    const email = normalizeEmail(input.email), password = assertPassword(input.password);
    const passwordHash = await hashPassword(password,this.password);
    try {
      return await this.database.transaction(async (tx) => {
        // Rare, operator-only provisioning serializes all its own retries and
        // center creations. Migration uses a different advisory lock key.
        // A caller/connection search_path must not redirect the privileged
        // receipt check or account writes into look-alike tables.
        await tx.query('SET LOCAL search_path = pg_catalog,public,pg_temp');
        const { rows: privileges } = await tx.query(`SELECT has_table_privilege(current_user,'public.cb_center_bootstraps','INSERT') AS allowed`);
        if (privileges[0]?.allowed !== true) authFail('BOOTSTRAP_FORBIDDEN',403);
        await tx.query('SELECT pg_advisory_xact_lock(724381903)');
        const { rows: receipts } = await tx.query(`SELECT operation_id,center_id,manager_user_id,created_at
          FROM cb_center_bootstraps WHERE operation_id = $1`,[operationId]);
        if (receipts.length) {
          const receipt = receipts[0];
          if (receipt.center_id !== centerId) authFail('BOOTSTRAP_CONFLICT',409);
          const { rows: accounts } = await tx.query(`SELECT a.email,a.password_hash,u.active AS user_active,
              m.active AS membership_active,m.role
            FROM cb_auth_accounts a JOIN cb_users u ON u.id = a.user_id
            JOIN cb_memberships m ON m.user_id = u.id AND m.center_id = $2
            WHERE a.user_id = $1 FOR SHARE OF a,u,m`,[receipt.manager_user_id,centerId]);
          const account = accounts[0];
          if (!account || !account.user_active || !account.membership_active || account.role !== 'center')
            authFail('BOOTSTRAP_CLOSED',409);
          if (account.email !== email || !await verifyPassword(password,account.password_hash)) authFail('BOOTSTRAP_CONFLICT',409);
          // No password, lockout, membership, session or invitation changes on
          // replay. A stopped/suspended center is not a bootstrap recovery path.
          return { operationId,centerId,userId:receipt.manager_user_id,role:'center',
            createdAt:iso(receipt.created_at),replayed:true };
        }
        const { rows: centers } = await tx.query('SELECT id FROM cb_centers WHERE id = $1 FOR UPDATE',[centerId]);
        if (centers.length) authFail('BOOTSTRAP_EXISTS',409);
        const { rows: accounts } = await tx.query('SELECT 1 FROM cb_auth_accounts WHERE email = $1',[email]);
        if (accounts.length) authFail('BOOTSTRAP_ACCOUNT_EXISTS',409);
        const userId = `user-${randomUUID()}`;
        await tx.query('INSERT INTO cb_centers(id) VALUES ($1)',[centerId]);
        await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[userId]);
        await tx.query('INSERT INTO cb_auth_accounts(user_id,email,password_hash) VALUES ($1,$2,$3)',[userId,email,passwordHash]);
        await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'center',true)`,[centerId,userId]);
        const { rows: created } = await tx.query(`INSERT INTO cb_center_bootstraps(operation_id,center_id,manager_user_id)
          VALUES ($1,$2,$3) RETURNING created_at`,[operationId,centerId,userId]);
        return { operationId,centerId,userId,role:'center',createdAt:iso(created[0].created_at),replayed:false };
      });
    } catch (error) {
      if (error.code === '23505') authFail('BOOTSTRAP_CONFLICT',409);
      throw error;
    }
  }

  async createInvitation(actor, { centerId, email, role }) {
    assertObjectKeys(arguments[1], ['centerId', 'email', 'role']);
    const normalizedCenterId = assertCenterId(centerId);
    const normalizedEmail = normalizeEmail(email);
    const invitationRole = assertInvitationRole(role);
    const token = sessionToken();
    const invitationId = `inv_${randomUUID().replaceAll('-', '')}`;
    try {
      return await this.database.transaction(async (tx) => {
        await requireCenterManager(tx, actor, normalizedCenterId);
        // Expired pending rows must be closed before the partial unique index
        // is checked, otherwise a stale invite would block re-invitation.
        await tx.query(`UPDATE cb_auth_invitations
          SET revoked_at = clock_timestamp()
          WHERE center_id = $1 AND email = $2 AND role = $3
            AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at <= clock_timestamp()`, [
          normalizedCenterId, normalizedEmail, invitationRole,
        ]);
        const inserted = await tx.query(`INSERT INTO cb_auth_invitations
            (id, center_id, email, role, token_hash, invited_by, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6,
            clock_timestamp() + ($7 * interval '1 second'))
          RETURNING created_at, expires_at`, [
          invitationId, normalizedCenterId, normalizedEmail, invitationRole,
          tokenHash(token), actor.userId, INVITATION_TTL_SECONDS,
        ]);
        await tx.query(`INSERT INTO cb_auth_audit_events
            (center_id, actor_user_id, invitation_id, action)
          VALUES ($1, $2, $3, 'invitation.created')`, [
          normalizedCenterId, actor.userId, invitationId,
        ]);
        const row = inserted.rows[0];
        return {
          id: invitationId,
          centerId: normalizedCenterId,
          email: normalizedEmail,
          role: invitationRole,
          token,
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
        };
      });
    } catch (error) {
      if (error.code === '23505') authFail('INVITATION_EXISTS', 409);
      throw error;
    }
  }

  async listInvitations(actor, { centerId, limit }) {
    assertObjectKeys(arguments[1], ['centerId', 'limit']);
    const normalizedCenterId = assertCenterId(centerId);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) authFail('INVALID_INPUT');
    return this.database.transaction(async (tx) => {
      await requireCenterManager(tx, actor, normalizedCenterId);
      const { rows } = await tx.query(`SELECT id, email, role, created_at, expires_at,
          accepted_at, revoked_at
        FROM cb_auth_invitations
        WHERE center_id = $1
        ORDER BY created_at DESC, id DESC${limit === undefined ? '' : ' LIMIT $2'}`,
      limit === undefined ? [normalizedCenterId] : [normalizedCenterId, limit + 1]);
      // A bounded screen must never present a truncated list as complete. The
      // existing internal unbounded caller remains compatible; HTTP opts in.
      if (limit !== undefined && rows.length > limit) authFail('INVITATION_LIST_LIMIT', 409);
      return rows.map((row) => ({
        id: row.id,
        centerId: normalizedCenterId,
        email: row.email,
        role: row.role,
        status: invitationStatus(row),
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
        acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
        revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      }));
    });
  }

  async revokeInvitation(actor, { centerId, invitationId }) {
    assertObjectKeys(arguments[1], ['centerId', 'invitationId']);
    const normalizedCenterId = assertCenterId(centerId);
    const normalizedInvitationId = assertInvitationId(invitationId);
    return this.database.transaction(async (tx) => {
      await requireCenterManager(tx, actor, normalizedCenterId);
      const result = await tx.query(`UPDATE cb_auth_invitations
        SET revoked_at = clock_timestamp()
        WHERE center_id = $1 AND id = $2
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [normalizedCenterId, normalizedInvitationId]);
      if (!result.rowCount) {
        const existing = await tx.query(`SELECT id FROM cb_auth_invitations
          WHERE center_id = $1 AND id = $2`, [normalizedCenterId, normalizedInvitationId]);
        if (!existing.rows.length) authFail('NOT_FOUND', 404);
        authFail('INVITATION_NOT_PENDING', 409);
      }
      await tx.query(`INSERT INTO cb_auth_audit_events
          (center_id, actor_user_id, invitation_id, action)
        VALUES ($1, $2, $3, 'invitation.revoked')`, [
        normalizedCenterId, actor.userId, normalizedInvitationId,
      ]);
      return true;
    });
  }

  // Bearer preview only: no email, account-existence lookup, user or session.
  // Approval still rechecks these conditions in its own write transaction.
  async inspectInvitation(input) {
    assertObjectKeys(input, ['token']);
    const token = assertInvitationToken(input.token);
    return this.database.transaction(async (tx) => {
      const invitation = await invitationForAcceptance(tx, tokenHash(token));
      if (invitation.accepted_at || invitation.revoked_at || invitation.expired) authFail('INVITATION_INVALID', 410);
      await requireCurrentInviter(tx, invitation);
      // Waiting for inviter locks can cross expiry; use the DB clock again.
      const { rows } = await tx.query(`SELECT expires_at FROM cb_auth_invitations
        WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [invitation.id]);
      if (!rows.length) authFail('INVITATION_INVALID', 410);
      return { id: invitation.id, centerId: invitation.center_id, role: invitation.role, expiresAt: iso(rows[0].expires_at) };
    });
  }

  async acceptInvitation(input) {
    assertObjectKeys(input,['token','password','centerId','role']);
    const rawToken = assertInvitationToken(input.token);
    const validPassword = assertPassword(input.password);
    const confirmed = Object.hasOwn(input, 'centerId') || Object.hasOwn(input, 'role');
    // Legacy trusted callers may omit both. HTTP requires the pair; one field
    // alone or a caller-selected role can never change the stored invitation.
    const centerId = confirmed ? assertCenterId(input.centerId) : null;
    const role = confirmed ? assertInvitationRole(input.role) : null;
    const passwordHash = await hashPassword(validPassword, this.password);
    const hash = tokenHash(rawToken);
    return this.database.transaction(async (tx) => {
      const invitation = await invitationForAcceptance(tx,hash);
      if (confirmed && (invitation.center_id !== centerId || invitation.role !== role)) authFail('INVITATION_INVALID', 410);
      if (invitation.accepted_at || invitation.revoked_at || invitation.expired)
        authFail('INVITATION_INVALID', 410);
      await requireCurrentInviter(tx,invitation);
      const existing = await tx.query(`SELECT user_id FROM cb_auth_accounts WHERE email = $1`, [invitation.email]);
      if (existing.rows.length) authFail('INVITATION_ACCOUNT_EXISTS', 409);

      const userId = `user-${randomUUID()}`;
      await tx.query('INSERT INTO cb_users(id, active) VALUES ($1, true)', [userId]);
      await tx.query(`INSERT INTO cb_auth_accounts(user_id, email, password_hash)
        VALUES ($1, $2, $3)`, [userId, invitation.email, passwordHash]);
      await tx.query(`INSERT INTO cb_memberships(center_id, user_id, role, active)
        VALUES ($1, $2, $3, true)`, [invitation.center_id, userId, invitation.role]);
      await consumeInvitation(tx,invitation,userId);
      await tx.query(`INSERT INTO cb_auth_audit_events
          (center_id, actor_user_id, invitation_id, action)
        VALUES ($1, $2, $3, 'invitation.accepted')`, [
        invitation.center_id, userId, invitation.id,
      ]);
      const tokenValue = sessionToken();
      const session = await tx.query(`INSERT INTO cb_auth_sessions(token_hash, user_id, expires_at)
        VALUES ($1, $2, clock_timestamp() + ($3 * interval '1 second'))
        RETURNING expires_at`, [tokenHash(tokenValue), userId, this.sessionTtlSeconds]);
      const memberships = await tx.query(`SELECT center_id, role FROM cb_memberships
        WHERE user_id = $1 AND active ORDER BY center_id, role`, [userId]);
      return {
        token: tokenValue,
        user: identity(userId, invitation.email, memberships.rows, session.rows[0].expires_at),
        invitation: { id: invitation.id, centerId: invitation.center_id, role: invitation.role },
      };
    }).catch((error) => {
      if (error.code === '23505') authFail('INVITATION_CONFLICT', 409);
      throw error;
    });
  }

  // Internal only: the future HTTP boundary must pass the HttpOnly session
  // cookie, not a submitted user ID/email/role claim. Joining a center does
  // not create a child relationship, grant history, or reactivate a suspension.
  async acceptExistingInvitation(sessionValue,input) {
    assertObjectKeys(input,['token','centerId','role']);
    const rawToken = assertInvitationToken(input.token), centerId = assertCenterId(input.centerId), role = assertInvitationRole(input.role);
    if (typeof sessionValue !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(sessionValue)) authFail('AUTH_REQUIRED',401);
    return this.database.transaction(async (tx) => {
      const invitation = await invitationForAcceptance(tx,tokenHash(rawToken));
      // The user explicitly confirms the center and role displayed to them.
      if (invitation.center_id !== centerId || invitation.role !== role || invitation.revoked_at) authFail('INVITATION_INVALID',410);
      const { account,session } = await lockSessionAccount(tx,tokenHash(sessionValue));
      if (account.email !== invitation.email) authFail('INVITATION_INVALID',410);
      const { rows: existing } = await tx.query(`SELECT role,active FROM cb_memberships WHERE center_id = $1 AND user_id = $2 FOR UPDATE`,[centerId,session.user_id]);
      const membership = existing[0];
      if (membership && (membership.role !== role || !membership.active)) authFail('INVITATION_MEMBERSHIP_UNAVAILABLE',409);
      if (invitation.accepted_at) {
        if (invitation.accepted_user_id !== session.user_id || !membership) authFail('INVITATION_INVALID',410);
      } else {
        if (invitation.expired) authFail('INVITATION_INVALID',410);
        await requireCurrentInviter(tx,invitation);
        if (!membership) await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)`,[centerId,session.user_id,role]);
        await consumeInvitation(tx,invitation,session.user_id,tokenHash(sessionValue));
        await tx.query(`INSERT INTO cb_auth_audit_events(center_id,actor_user_id,invitation_id,action) VALUES ($1,$2,$3,'invitation.accepted')`,[centerId,session.user_id,invitation.id]);
      }
      const { rows: memberships } = await tx.query('SELECT center_id,role FROM cb_memberships WHERE user_id = $1 AND active ORDER BY center_id,role',[session.user_id]);
      return { user:identity(session.user_id,account.email,memberships,session.expires_at),
        invitation:{ id:invitation.id,centerId,role },linked:true,replayed:!!invitation.accepted_at };
    }).catch((error) => { if (error.code === '23505') authFail('INVITATION_CONFLICT',409); throw error; });
  }

  async login({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const candidate = typeof password === 'string' ? password : '';
    return this.database.transaction(async (tx) => {
      const result = await tx.query(`SELECT a.user_id, a.email, a.password_hash,
          a.failed_attempts, a.locked_until > clock_timestamp() AS locked, u.active
        FROM cb_auth_accounts a
        JOIN cb_users u ON u.id = a.user_id
        WHERE a.email = $1
        FOR UPDATE OF a`, [normalizedEmail]);
      const account = result.rows[0];
      // Always perform a password derivation, even when the email is unknown,
      // so the public login response does not reveal account existence by timing.
      const matches = await verifyPassword(candidate, account?.password_hash ?? this.dummyHash);
      const locked = account?.locked === true;
      if (!account || !matches || !account.active || locked) {
        if (account?.active && !locked) {
          await failedPasswordProof(tx, account);
        }
        // Return a marker so the failed-attempt update can commit. Throwing
        // inside the transaction would roll the lockout counter back.
        return { invalid: true };
      }
      const token = sessionToken();
      const hash = tokenHash(token);
      await tx.query(`UPDATE cb_auth_accounts
        SET failed_attempts = 0, locked_until = NULL
        WHERE user_id = $1`, [account.user_id]);
      const session = await tx.query(`INSERT INTO cb_auth_sessions(token_hash, user_id, expires_at)
        VALUES ($1, $2, clock_timestamp() + ($3 * interval '1 second'))
        RETURNING expires_at`, [hash, account.user_id, this.sessionTtlSeconds]);
      const memberships = await tx.query(`SELECT center_id, role FROM cb_memberships
        WHERE user_id = $1 AND active ORDER BY center_id, role`, [account.user_id]);
      return {
        token,
        user: identity(account.user_id, account.email, memberships.rows, session.rows[0].expires_at),
      };
    }).then((result) => {
      if (result.invalid) authFail('AUTH_INVALID', 401);
      return result;
    });
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
    const hash = tokenHash(token);
    return this.database.transaction(async (tx) => {
      const session = await tx.query(`SELECT s.user_id, s.expires_at, u.active, a.email
        FROM cb_auth_sessions s
        JOIN cb_users u ON u.id = s.user_id
        JOIN cb_auth_accounts a ON a.user_id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > clock_timestamp()`, [hash]);
      const row = session.rows[0];
      if (!row || !row.active) return null;
      const touched = await tx.query(`UPDATE cb_auth_sessions SET last_seen_at = clock_timestamp()
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
          AND EXISTS (SELECT 1 FROM cb_users WHERE id = cb_auth_sessions.user_id AND active)`, [hash]);
      // A password change/logout/expiry may win after the initial read.
      if (!touched.rowCount) return null;
      const memberships = await tx.query(`SELECT center_id, role FROM cb_memberships
        WHERE user_id = $1 AND active ORDER BY center_id, role`, [row.user_id]);
      return identity(row.user_id, row.email, memberships.rows, row.expires_at);
    });
  }

  async logout(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) return false;
    const result = await this.database.transaction((tx) => tx.query(`UPDATE cb_auth_sessions
      SET revoked_at = clock_timestamp()
      WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash(token)]));
    return result.rowCount > 0;
  }

  // Internal service only: not password recovery or an administrative reset.
  // The future HTTP boundary must pass its HttpOnly cookie, enforce same-origin
  // CSRF/transport/rate limits and never accept a user/role/email claim here.
  async changePassword(sessionValue, input) {
    assertObjectKeys(input, ['currentPassword', 'newPassword']);
    if (typeof sessionValue !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(sessionValue)) authFail('AUTH_REQUIRED', 401);
    const currentPassword = assertPassword(input.currentPassword), newPassword = assertPassword(input.newPassword);
    if (currentPassword === newPassword) authFail('PASSWORD_UNCHANGED');
    const hash = tokenHash(sessionValue);
    return this.database.transaction(async (tx) => {
      const { account } = await lockSessionAccount(tx, hash, true);
      const matches = await verifyPassword(currentPassword, account.password_hash);
      if (!matches || account.locked) {
        if (!account.locked) {
          if (!await failedPasswordProof(tx, account, hash)) authFail('AUTH_REQUIRED', 401);
        } else {
          const { rows } = await tx.query(`SELECT 1 FROM cb_auth_sessions WHERE token_hash = $1
            AND revoked_at IS NULL AND expires_at > clock_timestamp()`, [hash]);
          if (!rows.length) authFail('AUTH_REQUIRED', 401);
        }
        return { invalid: true };
      }
      const passwordHash = await hashPassword(newPassword, this.password);
      // Recheck the DB clock at the actual credential write, not only before
      // locks or expensive crypto. The held user/session locks prevent revoke
      // or deactivation from slipping between proof and this commit.
      const changed = await tx.query(`UPDATE cb_auth_accounts SET password_hash = $2,
        password_updated_at = clock_timestamp(), failed_attempts = 0, locked_until = NULL
        WHERE user_id = $1 AND EXISTS (SELECT 1 FROM cb_auth_sessions s WHERE s.token_hash = $3
          AND s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp())`,
      [account.user_id, passwordHash, hash]);
      if (!changed.rowCount) authFail('AUTH_REQUIRED', 401);
      const revoked = await tx.query(`UPDATE cb_auth_sessions SET revoked_at = clock_timestamp()
        WHERE user_id = $1 AND revoked_at IS NULL`, [account.user_id]);
      // Subject is proven above, never a submitted actor claim. No secrets,
      // email, session inventory or clinical data enter this retained event.
      await tx.query(`INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions)
        VALUES ($1,$2,'password.changed',$3)`, [randomUUID(),account.user_id,revoked.rowCount]);
      // No automatic login, new token, session inventory or account metadata.
      return { passwordChanged: true, reauthenticate: true };
    }).then((result) => {
      if (result.invalid) authFail('AUTH_INVALID', 401);
      return result;
    });
  }

  // TRUSTED DELIVERY PROCESSOR ONLY, not a public forgot-password response.
  // A future HTTP boundary must enqueue requests and give a uniform response,
  // enforce abuse limits, then send only to this stored account address. It
  // must never serialize this result, reveal account existence or take a
  // userId/recipient/role/redirect URL from the requester. No delivery occurs
  // here. Neither a token request nor a failed delivery locks out the account.
  async preparePasswordRecovery(input) {
    assertObjectKeys(input, ['email']);
    const email = normalizeEmail(input.email);
    const token = `cr1.${sessionToken()}`, hash = tokenHash(token);
    return this.database.transaction(async (tx) => {
      const { rows: accounts } = await tx.query(`SELECT user_id,email FROM cb_auth_accounts
        WHERE email=$1 FOR UPDATE`, [email]);
      const account = accounts[0];
      if (!account) return null;
      const { rows: users } = await tx.query('SELECT id FROM cb_users WHERE id=$1 AND active FOR SHARE', [account.user_id]);
      if (!users.length) return null;
      const { rows: rate } = await tx.query(`SELECT COUNT(*) AS issued,
          COALESCE(MAX(created_at)>clock_timestamp()-($2*interval '1 second'),false) AS recent
        FROM cb_auth_password_resets WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'`,
      [account.user_id, RECOVERY_COOLDOWN_SECONDS]);
      if (rate[0].recent || Number(rate[0].issued) >= RECOVERY_HOURLY_LIMIT) return null;
      await tx.query(`UPDATE cb_auth_password_resets SET revoked_at=clock_timestamp()
        WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [account.user_id]);
      const { rows: created } = await tx.query(`INSERT INTO cb_auth_password_resets(token_hash,user_id,expires_at)
        VALUES ($1,$2,clock_timestamp()+($3*interval '1 second')) RETURNING expires_at`,
      [hash, account.user_id, this.recoveryTtlSeconds]);
      // Plain JSON/logging does not accidentally include the bearer or email.
      // Trusted delivery code reads these properties explicitly; this is not
      // secure memory or a serialized/outbox delivery contract.
      return Object.freeze(Object.defineProperties({ expiresAt: iso(created[0].expires_at) }, {
        email: { value: account.email }, token: { value: token },
      }));
    });
  }

  // Trusted delivery process only. Re-read the stored destination and current
  // capability immediately before handing it to a transport. This SELECT has
  // no external I/O or row locks; its transaction ends before a caller sends.
  // A subsequent withdrawal can still race with delivery. Acceptance/reset
  // must continue to enforce their existing authoritative checks.
  async accountDeliveryRecipient(input) {
    assertObjectKeys(input, ['purpose', 'token']);
    const purpose = input.purpose;
    if (!['invitation', 'password-recovery'].includes(purpose)) authFail('INVALID_INPUT');
    const token = purpose === 'invitation'
      ? assertInvitationToken(input.token) : assertRecoveryToken(input.token);
    return this.database.transaction(async (tx) => {
      const { rows } = purpose === 'invitation'
        ? await tx.query(`SELECT i.email,i.expires_at FROM cb_auth_invitations i
            JOIN cb_users inviter ON inviter.id=i.invited_by AND inviter.active
            JOIN cb_memberships manager ON manager.center_id=i.center_id AND manager.user_id=i.invited_by
              AND manager.role='center' AND manager.active
            LEFT JOIN cb_auth_accounts recipient ON recipient.email=i.email
            LEFT JOIN cb_users recipient_user ON recipient_user.id=recipient.user_id
            LEFT JOIN cb_memberships recipient_member ON recipient_member.center_id=i.center_id
              AND recipient_member.user_id=recipient.user_id
            WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
              AND i.expires_at>clock_timestamp()
              AND (recipient.user_id IS NULL OR (recipient_user.active AND
                (recipient_member.user_id IS NULL OR (recipient_member.active AND recipient_member.role=i.role))))`,
          [tokenHash(token)])
        : await tx.query(`SELECT a.email,r.expires_at FROM cb_auth_password_resets r
            JOIN cb_auth_accounts a ON a.user_id=r.user_id JOIN cb_users u ON u.id=r.user_id AND u.active
            WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.revoked_at IS NULL
              AND r.expires_at>clock_timestamp()`, [tokenHash(token)]);
      if (!rows.length) return null;
      return Object.freeze(Object.defineProperties({ expiresAt: iso(rows[0].expires_at) }, {
        email: { value: rows[0].email },
      }));
    });
  }

  // Internal reset completion. The bearer proves access to the established
  // recovery channel, not a chosen account ID or a center administrator role.
  // Account -> active user -> reset locks match other credential mutations.
  async completePasswordRecovery(input) {
    assertObjectKeys(input, ['token', 'newPassword', 'confirmation']);
    const token = assertRecoveryToken(input.token), password = assertPassword(input.newPassword);
    if (assertPassword(input.confirmation) !== password) authFail('PASSWORD_CONFIRMATION_MISMATCH');
    const hash = tokenHash(token);
    return this.database.transaction(async (tx) => {
      const { rows: hints } = await tx.query('SELECT user_id FROM cb_auth_password_resets WHERE token_hash=$1', [hash]);
      if (!hints.length) authFail('PASSWORD_RECOVERY_INVALID', 410);
      const { rows: accounts } = await tx.query(`SELECT user_id,password_hash FROM cb_auth_accounts
        WHERE user_id=$1 FOR UPDATE`, [hints[0].user_id]);
      const account = accounts[0];
      if (!account) authFail('PASSWORD_RECOVERY_INVALID', 410);
      const { rows: users } = await tx.query('SELECT id FROM cb_users WHERE id=$1 AND active FOR SHARE', [account.user_id]);
      if (!users.length) authFail('PASSWORD_RECOVERY_INVALID', 410);
      const { rows: resets } = await tx.query(`SELECT token_hash FROM cb_auth_password_resets
        WHERE token_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at>clock_timestamp() FOR UPDATE`, [hash, account.user_id]);
      if (!resets.length) authFail('PASSWORD_RECOVERY_INVALID', 410);
      if (await verifyPassword(password, account.password_hash)) authFail('PASSWORD_UNCHANGED');
      const passwordHash = await hashPassword(password, this.password);
      // Expiration can occur during crypto or a lock wait. Consume first, with
      // a fresh DB-clock predicate, so the credential-change trigger revokes
      // only other still-pending reset tokens. Every following write is atomic.
      const consumed = await tx.query(`UPDATE cb_auth_password_resets SET consumed_at=clock_timestamp()
        WHERE token_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at>clock_timestamp()`, [hash, account.user_id]);
      if (!consumed.rowCount) authFail('PASSWORD_RECOVERY_INVALID', 410);
      await tx.query(`UPDATE cb_auth_accounts SET password_hash=$2,password_updated_at=clock_timestamp(),
        failed_attempts=0,locked_until=NULL WHERE user_id=$1`, [account.user_id, passwordHash]);
      const revoked = await tx.query(`UPDATE cb_auth_sessions SET revoked_at=clock_timestamp()
        WHERE user_id=$1 AND revoked_at IS NULL`, [account.user_id]);
      await tx.query(`INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions)
        VALUES ($1,$2,'password.recovered',$3)`, [randomUUID(), account.user_id, revoked.rowCount]);
      return { passwordChanged: true, reauthenticate: true };
    }).catch((error) => {
      if (error.code === '23514' && error.constraint === 'cb_password_reset_expired')
        authFail('PASSWORD_RECOVERY_INVALID', 410);
      throw error;
    });
  }

  async revokeAll(userId) {
    assertUserId(userId);
    const result = await this.database.transaction(async (tx) => {
      // Serialize multi-session revocation with password changes. Otherwise
      // separate row locks can form a cycle with the proof session SHARE lock.
      await tx.query('SELECT user_id FROM cb_auth_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
      const revoked = await tx.query(`UPDATE cb_auth_sessions SET revoked_at = clock_timestamp()
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      if (revoked.rowCount) await tx.query(`INSERT INTO cb_account_security_events(id,user_id,action,revoked_sessions)
        VALUES ($1,$2,'sessions.revoked',$3)`, [randomUUID(),userId,revoked.rowCount]);
      // No event for an idempotent zero-change call. This internal primitive
      // records the affected subject, not an unverified operator identity.
      return revoked;
    });
    return result.rowCount;
  }
}

export const AUTH_LIMITS = Object.freeze({
  passwordMin: PASSWORD_MIN,
  passwordMax: PASSWORD_MAX,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
  invitationTtlSeconds: INVITATION_TTL_SECONDS,
  recoveryTtlSeconds: RECOVERY_TTL_SECONDS,
  recoveryCooldownSeconds: RECOVERY_COOLDOWN_SECONDS,
  recoveryHourlyLimit: RECOVERY_HOURLY_LIMIT,
  lockThreshold: LOCK_THRESHOLD,
  lockSeconds: LOCK_SECONDS,
});
