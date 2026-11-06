import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Auth, AuthError } from '../auth.mjs';
import { AccountDelivery, AccountDeliveryError } from '../account-delivery.mjs';
import { migrate } from '../migrate.mjs';

const OPTIONS = { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 } };
const PASSWORD = 'Synthetic original password';
const EMAIL = 'guardian@example.test';
const INVITEE = 'new.guardian@example.test';
const ORIGIN = 'https://carebridge.example.test';
const MANAGER = { userId: 'manager-a' };
let db, auth;
const invitation = (email = INVITEE) => ({ centerId: 'center-a', email, role: 'guardian' });
const authCode = (code) => (error) => error instanceof AuthError && error.code === code;
const ownCode = (code) => (error) => error instanceof AccountDeliveryError && error.code === code;
const tokenIn = (message) => new URLSearchParams(new URL(message.link).hash.slice(1)).get('token');
const methods = (service = auth) => ({
  createInvitation: (...args) => service.createInvitation(...args),
  preparePasswordRecovery: (...args) => service.preparePasswordRecovery(...args),
  accountDeliveryRecipient: (...args) => service.accountDeliveryRecipient(...args),
});
function harness({ service = auth, port, timeoutMilliseconds = 1000 } = {}) {
  const calls = [];
  const delivery = new AccountDelivery({ auth: service, origin: ORIGIN, timeoutMilliseconds,
    transport: { send(message, options) { calls.push({ message, options }); return port ? port(message, options) : { status: 'accepted' }; } } });
  return { delivery, calls };
}
function afterIssue(kind, hook, service = auth) {
  const facade = methods(service);
  const method = kind === 'invitation' ? 'createInvitation' : 'preparePasswordRecovery';
  facade[method] = async (...args) => {
    const issued = await service[method](...args);
    await hook(issued);
    return issued;
  };
  return facade;
}
const state = async () => ({
  accounts: (await db.query('SELECT * FROM cb_auth_accounts ORDER BY user_id')).rows,
  sessions: (await db.query('SELECT * FROM cb_auth_sessions ORDER BY token_hash')).rows,
  invitations: (await db.query('SELECT * FROM cb_auth_invitations ORDER BY id')).rows,
  resets: (await db.query('SELECT * FROM cb_auth_password_resets ORDER BY token_hash')).rows,
});
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users VALUES ('manager-a',true),('guardian-a',true),('peer-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),
      ('center-a','guardian-a','guardian',true),('center-b','peer-a','center',true);`);
  auth = new Auth(db, OPTIONS);
  await auth.provisionAccount({ userId: 'manager-a', email: 'manager@example.test', password: PASSWORD });
  await auth.provisionAccount({ userId: 'guardian-a', email: EMAIL, password: PASSWORD });
});

test('invitation uses only a revalidated DB recipient and fixed HTTPS fragment link; ordinary inspection is secret-free', async () => {
  const service = methods();
  service.createInvitation = async (...args) => ({ ...await auth.createInvitation(...args), email: 'attacker@example.test' });
  const { delivery, calls } = harness({ service });
  const result = await delivery.invite(MANAGER, invitation());
  assert.deepEqual(result.internal, { issuance: 'issued', delivery: 'accepted' });
  assert.equal(calls.length, 1);
  const message = calls[0].message;
  assert.equal(message.to, INVITEE);
  assert.equal(message.purpose, 'invitation');
  assert.equal(message.subject, 'Carebridge 계정 초대 안내');
  const url = new URL(message.link), token = tokenIn(message);
  assert.equal(url.origin, ORIGIN); assert.equal(url.pathname, '/account/invitation'); assert.equal(url.search, '');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(message.text.includes(message.link));
  for (const serialized of [JSON.stringify(message), inspect(message), JSON.stringify(result), inspect(result)]) {
    assert.equal(serialized.includes(token), false); assert.equal(serialized.includes(INVITEE), false);
    assert.equal(serialized.includes(message.link), false);
  }
  assert.deepEqual(Object.keys(message), ['purpose']); assert.deepEqual(Object.keys(result), ['publicResponse']);
  assert.ok(Object.isFrozen(message) && Object.isFrozen(result) && Object.isFrozen(result.internal) && Object.isFrozen(result.publicResponse));
  assert.equal('centerId' in message, false); assert.equal('role' in message, false); assert.equal('token' in message, false);
  const accepted = await auth.acceptInvitation({ token, password: 'Synthetic invited password' });
  assert.equal(accepted.invitation.role, 'guardian');
});

test('recovery delivery does not change credentials or sessions, and its link retains the existing one-use Auth contract', async () => {
  const logged = await auth.login({ email: EMAIL, password: PASSWORD });
  const before = await state();
  const { delivery, calls } = harness();
  const result = await delivery.recover({ email: ' GUARDIAN@EXAMPLE.TEST ' });
  assert.equal(result.internal.delivery, 'accepted'); assert.equal(calls.length, 1);
  const message = calls[0].message, token = tokenIn(message);
  assert.equal(message.to, EMAIL); assert.equal(new URL(message.link).pathname, '/account/password-recovery');
  assert.match(token, /^cr1\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((await state()).accounts, before.accounts); assert.deepEqual((await state()).sessions, before.sessions);
  assert.equal((await auth.authenticate(logged.token)).userId, 'guardian-a');
  assert.deepEqual(await auth.completePasswordRecovery({ token, newPassword: 'Synthetic recovered password', confirmation: 'Synthetic recovered password' }),
    { passwordChanged: true, reauthenticate: true });
  await assert.rejects(auth.completePasswordRecovery({ token, newPassword: 'Synthetic another password', confirmation: 'Synthetic another password' }), authCode('PASSWORD_RECOVERY_INVALID'));
});

test('existent, absent, suspended, cooldown-limited and transport outcomes share the same public response only', async () => {
  const { delivery, calls } = harness();
  const results = [await delivery.recover({ email: EMAIL }), await delivery.recover({ email: EMAIL }),
    await delivery.recover({ email: 'absent@example.test' })];
  await db.query('UPDATE cb_users SET active=false WHERE id=$1', ['guardian-a']);
  results.push(await delivery.recover({ email: EMAIL }));
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map((row) => row.internal.issuance), ['issued', 'not-issued', 'not-issued', 'not-issued']);
  for (const status of ['rejected', 'unknown']) {
    const attempt = harness({ port: () => ({ status }) });
    results.push(await attempt.delivery.invite(MANAGER, invitation(`${status}@example.test`)));
  }
  assert.equal(new Set(results.map((row) => JSON.stringify(row))).size, 1);
});

test('an unexpired recovery is not handed off if revoked, consumed, email-replaced or disabled before the fresh read', async () => {
  for (const mode of ['revoked', 'consumed', 'email-replaced', 'disabled']) {
    // Separate synthetic account per branch avoids changing the real cooldown.
    const userId = `case-${mode}`, email = `${mode}@example.test`;
    await db.query('INSERT INTO cb_users VALUES ($1,true)', [userId]);
    await auth.provisionAccount({ userId, email, password: PASSWORD });
    const service = afterIssue('password-recovery', async (issued) => {
      if (mode === 'revoked') await db.query('UPDATE cb_auth_password_resets SET revoked_at=clock_timestamp() WHERE user_id=$1', [userId]);
      if (mode === 'consumed') await auth.completePasswordRecovery({ token: issued.token, newPassword: 'Synthetic changed password', confirmation: 'Synthetic changed password' });
      if (mode === 'email-replaced') await db.query('UPDATE cb_auth_accounts SET email=$2 WHERE user_id=$1', [userId, `changed-${email}`]);
      if (mode === 'disabled') await db.query('UPDATE cb_users SET active=false WHERE id=$1', [userId]);
    });
    const { delivery, calls } = harness({ service });
    assert.deepEqual((await delivery.recover({ email })).internal, { issuance: 'issued', delivery: 'not-attempted' });
    assert.equal(calls.length, 0);
  }
});

test('an expired recovery is withheld using the DB clock, without rewriting or extending the token', async () => {
  const service = new Auth(db, { ...OPTIONS, recoveryTtlSeconds: 1 });
  let expiry;
  const wrapped = afterIssue('password-recovery', async (issued) => { expiry = issued.expiresAt; await delay(1100); }, service);
  const { delivery, calls } = harness({ service: wrapped });
  assert.deepEqual((await delivery.recover({ email: EMAIL })).internal, { issuance: 'issued', delivery: 'not-attempted' });
  assert.equal(calls.length, 0);
  const row = (await db.query('SELECT expires_at,consumed_at,revoked_at FROM cb_auth_password_resets')).rows[0];
  assert.equal(new Date(row.expires_at).toISOString(), expiry); assert.equal(row.consumed_at, null); assert.equal(row.revoked_at, null);
});

test('expired, revoked and consumed invitations never reach the transport', async () => {
  for (const mode of ['expired', 'revoked', 'consumed']) {
    const service = afterIssue('invitation', async (issued) => {
      if (mode === 'expired') await db.query(`UPDATE cb_auth_invitations SET created_at=clock_timestamp()-interval '2 days',
        expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [issued.id]);
      if (mode === 'revoked') await auth.revokeInvitation(MANAGER, { centerId: 'center-a', invitationId: issued.id });
      if (mode === 'consumed') await auth.acceptInvitation({ token: issued.token, password: PASSWORD });
    });
    const { delivery, calls } = harness({ service });
    assert.deepEqual((await delivery.invite(MANAGER, invitation(`${mode}@example.test`))).internal,
      { issuance: 'issued', delivery: 'not-attempted' });
    assert.equal(calls.length, 0);
  }
});

for (const mode of ['inviter-disabled', 'membership-inactive', 'manager-role-changed']) {
  test(`invitation fresh read requires the inviter's current authority: ${mode}`, async () => {
    const service = afterIssue('invitation', async () => {
      if (mode === 'inviter-disabled') await db.query('UPDATE cb_users SET active=false WHERE id=$1', ['manager-a']);
      if (mode === 'membership-inactive') await db.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', ['center-a', 'manager-a']);
      if (mode === 'manager-role-changed') await db.query('UPDATE cb_memberships SET role=$3 WHERE center_id=$1 AND user_id=$2', ['center-a', 'manager-a', 'guardian']);
    });
    const { delivery, calls } = harness({ service });
    assert.equal((await delivery.invite(MANAGER, invitation())).internal.delivery, 'not-attempted');
    assert.equal(calls.length, 0);
  });
}

for (const mode of ['disabled', 'membership-inactive', 'role-conflict']) {
  test(`an existing invitation recipient remains subject to acceptance availability: ${mode}`, async () => {
    const service = afterIssue('invitation', async () => {
      if (mode === 'disabled') await db.query('UPDATE cb_users SET active=false WHERE id=$1', ['guardian-a']);
      if (mode === 'membership-inactive') await db.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', ['center-a', 'guardian-a']);
      if (mode === 'role-conflict') await db.query('UPDATE cb_memberships SET role=$3 WHERE center_id=$1 AND user_id=$2', ['center-a', 'guardian-a', 'therapist']);
    });
    const { delivery, calls } = harness({ service });
    assert.equal((await delivery.invite(MANAGER, invitation(EMAIL))).internal.delivery, 'not-attempted');
    assert.equal(calls.length, 0);
  });
}

test('current same-role members and existing accounts without a center membership can receive the existing-account invitation', async () => {
  await db.query('INSERT INTO cb_users VALUES ($1,true)', ['new-center-member']);
  await auth.provisionAccount({ userId: 'new-center-member', email: 'other-center@example.test', password: PASSWORD });
  const { delivery, calls } = harness();
  for (const email of [EMAIL, 'other-center@example.test']) {
    assert.equal((await delivery.invite(MANAGER, invitation(email))).internal.delivery, 'accepted');
    const token = tokenIn(calls.at(-1).message), session = await auth.login({ email, password: PASSWORD });
    assert.equal((await auth.acceptExistingInvitation(session.token, { token, centerId: 'center-a', role: 'guardian' })).linked, true);
  }
});

test('recipient checks are read-only, purpose-separated and return no secret in ordinary serialization', async () => {
  const invite = await auth.createInvitation(MANAGER, invitation());
  const recovery = await auth.preparePasswordRecovery({ email: EMAIL });
  const before = await state();
  for (const [purpose, token, email] of [['invitation', invite.token, INVITEE], ['password-recovery', recovery.token, EMAIL]]) {
    const recipient = await auth.accountDeliveryRecipient({ purpose, token });
    assert.equal(recipient.email, email); assert.ok(Object.isFrozen(recipient));
    assert.equal(JSON.stringify(recipient).includes(email), false); assert.equal(inspect(recipient).includes(email), false);
    assert.equal('token' in recipient, false);
  }
  await assert.rejects(auth.accountDeliveryRecipient({ purpose: 'invitation', token: recovery.token }), authCode('INVITATION_INVALID'));
  await assert.rejects(auth.accountDeliveryRecipient({ purpose: 'password-recovery', token: invite.token }), authCode('PASSWORD_RECOVERY_INVALID'));
  await assert.rejects(auth.accountDeliveryRecipient({ purpose: 'other', token: invite.token }), authCode('INVALID_INPUT'));
  await assert.rejects(auth.accountDeliveryRecipient({ purpose: 'invitation', token: invite.token, recipient: EMAIL }), authCode('INVALID_INPUT'));
  assert.deepEqual(await state(), before);
});

test('transport runs after DB transactions close and a subsequent revocation still prevents capability consumption', async () => {
  let active = 0;
  const service = new Auth({ transaction: (work) => db.transaction(async (tx) => {
    active++; try { return await work(tx); } finally { active--; }
  }) }, OPTIONS);
  const { delivery, calls } = harness({ service, port: async () => {
    assert.equal(active, 0);
    await db.query('UPDATE cb_auth_password_resets SET revoked_at=clock_timestamp() WHERE user_id=$1', ['guardian-a']);
    return { status: 'accepted' };
  } });
  assert.equal((await delivery.recover({ email: EMAIL })).internal.delivery, 'accepted');
  await assert.rejects(auth.completePasswordRecovery({ token: tokenIn(calls[0].message), newPassword: 'Synthetic changed password', confirmation: 'Synthetic changed password' }), authCode('PASSWORD_RECOVERY_INVALID'));
});

test('known provider acceptance/rejection is preserved; exceptions and malformed provider results are unknown without detail leakage', async () => {
  for (const [index, port, expected] of [
    [0, () => ({ status: 'accepted', privateMetadata: 'SYNTHETIC-RAW-SECRET' }), 'accepted'],
    [1, () => ({ status: 'rejected', detail: 'SYNTHETIC-RAW-SECRET' }), 'rejected'],
    [2, () => { throw new Error('SYNTHETIC-RAW-SECRET'); }, 'unknown'],
    [3, async () => { throw new Error('SYNTHETIC-RAW-SECRET'); }, 'unknown'],
    [4, () => ({ status: 'delivered' }), 'unknown'],
    [5, () => null, 'unknown'],
    [6, () => ({ get status() { throw new Error('SYNTHETIC-RAW-SECRET'); } }), 'unknown'],
  ]) {
    const { delivery, calls } = harness({ port });
    const result = await delivery.invite(MANAGER, invitation(`transport-${index}@example.test`));
    assert.equal(result.internal.delivery, expected); assert.equal(calls.length, 1);
    assert.equal(inspect(result, { showHidden: true }).includes('SYNTHETIC-RAW-SECRET'), false);
  }
});

test('timeout is unknown, signals abort, observes late rejection, and never automatically retries', async () => {
  let rejectLate, capturedSignal;
  const { delivery, calls } = harness({ timeoutMilliseconds: 10, port: (_message, { signal }) => {
    capturedSignal = signal; return new Promise((_resolve, reject) => { rejectLate = reject; });
  } });
  const result = await delivery.recover({ email: EMAIL });
  assert.deepEqual(result.internal, { issuance: 'issued', delivery: 'unknown' });
  assert.equal(capturedSignal.aborted, true); assert.equal(calls.length, 1);
  rejectLate(new Error('SYNTHETIC-LATE-SECRET'));
  await delay(20);
  assert.equal(calls.length, 1); assert.equal(result.internal.delivery, 'unknown');
});

test('late transport acceptance cannot convert an already returned timeout into delivery success', async () => {
  let resolveLate;
  const { delivery, calls } = harness({ timeoutMilliseconds: 10,
    port: () => new Promise((resolve) => { resolveLate = resolve; }) });
  const result = await delivery.recover({ email: EMAIL });
  resolveLate({ status: 'accepted' }); await delay(20);
  assert.equal(result.internal.delivery, 'unknown'); assert.equal(calls.length, 1);
});

test('unsafe origin/config and request routing/header overrides fail before any issue or transport call', async () => {
  let called = 0;
  const trap = () => { called++; throw new Error('must not be reached'); };
  const options = { auth: { createInvitation: trap, preparePasswordRecovery: trap, accountDeliveryRecipient: trap },
    transport: { send: trap }, origin: ORIGIN };
  for (const origin of ['http://carebridge.example.test', 'https://user:pass@carebridge.example.test',
    `${ORIGIN}/path`, `${ORIGIN}?host=evil.example.test`, `${ORIGIN}#fragment`, `${ORIGIN}/`,
    `${ORIGIN}\r\nHost: evil.example.test`, 'https://carebridge.example.test\\@evil.example.test',
    ' https://carebridge.example.test', 'javascript:alert(1)', '//evil.example.test', 'https://carebridge.example.test:443'])
    assert.throws(() => new AccountDelivery({ ...options, origin }), ownCode('INVALID_CONFIG'));
  for (const patch of [{ timeoutMilliseconds: 0 }, { timeoutMilliseconds: Infinity }, { timeoutMilliseconds: 60_001 },
    { from: 'other@example.test' }, { transport: {} }, { auth: {} }])
    assert.throws(() => new AccountDelivery({ ...options, ...patch }), ownCode('INVALID_CONFIG'));
  const delivery = new AccountDelivery(options);
  for (const key of ['recipient', 'redirect', 'from', 'host', 'origin', 'token']) {
    await assert.rejects(delivery.recover({ email: EMAIL, [key]: 'override' }), ownCode('INVALID_INPUT'));
    await assert.rejects(delivery.invite(MANAGER, { ...invitation(), [key]: 'override' }), ownCode('INVALID_INPUT'));
  }
  for (const email of [`guardian@example.test\r\nBcc: other@example.test`, 'Name <guardian@example.test>',
    'guardian@example.test,other@example.test', 'guardian@example.test;other@example.test', 'a\u0000b@example.test'])
    await assert.rejects(delivery.recover({ email }), ownCode('INVALID_INPUT'));
  await assert.rejects(delivery.recover({ get email() { throw new Error('SYNTHETIC-ACCESSOR-SECRET'); } }), ownCode('INVALID_INPUT'));
  assert.equal(called, 0);
});

test('issuer/revalidation failures stay secret-free and never call transport or pretend an unknown commit did not happen', async () => {
  for (const phase of ['issue', 'validation']) {
    const service = methods();
    service[phase === 'issue' ? 'preparePasswordRecovery' : 'accountDeliveryRecipient'] = async () => { throw new Error('SYNTHETIC-DB-SECRET'); };
    const { delivery, calls } = harness({ service });
    const result = await delivery.recover({ email: EMAIL });
    assert.equal(result.internal.issuance, phase === 'issue' ? 'unknown' : 'issued');
    assert.equal(result.internal.delivery, 'not-attempted'); assert.equal(calls.length, 0);
    assert.equal(inspect(result, { showHidden: true }).includes('SYNTHETIC-DB-SECRET'), false);
  }
});

test('malformed stored mailbox is withheld instead of constructing an injectable envelope', async () => {
  const service = afterIssue('invitation', async (issued) => {
    await db.query('UPDATE cb_auth_invitations SET email=$2 WHERE id=$1', [issued.id, 'name <other@example.test>']);
  });
  const { delivery, calls } = harness({ service });
  assert.equal((await delivery.invite(MANAGER, invitation())).internal.delivery, 'not-attempted');
  assert.equal(calls.length, 0);
});
