// Synthetic transport doubles only; no listener, database, browser or mail.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { InvitationApiClient, INVITATION_REQUEST_NOTICE, invitationEmail } from '../local-api/invitation-client.js';
import { takeInvitationToken } from '../local-api/invitation-token.js';

const token = 'a'.repeat(43), iid = `inv_${'a'.repeat(32)}`, center = 'synthetic-center';
const invite = (extra = {}) => ({ id: iid, centerId: center, role: 'guardian', expiresAt: '2026-10-12T00:00:00.000Z', ...extra });
const listed = (extra = {}) => ({ ...invite(), email: 'person@example.test', status: 'pending', createdAt: '2026-10-10T00:00:00.000Z', acceptedAt: null, revokedAt: null, ...extra });
const user = (extra = {}) => ({ userId: 'synthetic-user', email: 'person@example.test', centers: [{ id: center, role: 'guardian' }], expiresAt: '2026-10-10T08:00:00.000Z', ...extra });
const body = (existing = false) => ({ token, centerId: center, role: 'guardian', ...(existing ? {} : { password: 'Synthetic-password-1', confirmation: 'Synthetic-password-1' }) });
const accepted = (existing = false, extra = {}) => ({ user: user(), invitation: { id: iid, centerId: center, role: 'guardian' }, ...(existing ? { linked: true, replayed: false } : {}), ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = expected => error => error instanceof LocalApiError && error.code === expected;
function fixture(value, account = null) {
  const calls = [], base = new LocalApiClient({ fetch: async (...args) => { calls.push(args); return typeof value === 'function' ? value(...args) : response(value); } });
  base.expectedUserId = account; return { api: new InvitationApiClient(base), base, calls };
}

test('fragment is immediately removed with no history state before returning a strict token', () => {
  const calls = [], location = { pathname: '/account/invitation', search: '', hash: `#token=${token}` };
  assert.equal(takeInvitationToken(location, { replaceState: (...args) => calls.push(args) }), token);
  assert.deepEqual(calls, [[null, '', '/account/invitation']]);
});
test('malformed, duplicate, query, encoded and purpose-mixed capabilities are scrubbed then refused', () => {
  for (const hash of ['', '#token=', '#token=short', `#token=${token}&token=${token}`, `#token=%61${token}`, `#token=cr1.${token}`, `#token=${'a'.repeat(101)}`]) {
    let scrubbed = false;
    assert.throws(() => takeInvitationToken({ pathname: '/account/invitation', search: '', hash }, { replaceState: () => { scrubbed = true; } }), /^Error: INVITATION_INVALID$/);
    assert(scrubbed);
  }
  let scrubbed = false;
  assert.throws(() => takeInvitationToken({ pathname: '/account/invitation', search: '?token=private', hash: `#token=${token}` }, { replaceState: () => { scrubbed = true; } }));
  assert(scrubbed);
});
test('unrelated pages are not captured or rewritten and scrub failures never return a token', () => {
  assert.equal(takeInvitationToken({ pathname: '/', hash: `#token=${token}` }, { replaceState: () => assert.fail() }), null);
  assert.throws(() => takeInvitationToken({ pathname: '/account/invitation', search: '', hash: `#token=${token}` }, { replaceState: () => { throw new Error('fixed'); } }));
});
test('synthetic email normalization rejects real domains, raw controls and overlength', () => {
  assert.equal(invitationEmail(' Person@Example.TEST '), 'person@example.test');
  assert.equal(invitationEmail('p@synthetic.test'), 'p@synthetic.test');
  for (const value of ['p@example.com', 'p@test', 'p@.test', 'p q@example.test', 'a\0@example.test', 'a@example.test\n', '<a>@example.test', 'a@-example.test', '\ud800@example.test', 'a'.repeat(255), null])
    assert.throws(() => invitationEmail(value), code('INVALID_INPUT'));
});
test('client composition has no identity or secret-bearing cache', () => {
  const f = fixture({ invitation: invite() }); assert.equal(JSON.stringify(f.api), '{}');
  assert.equal(f.api.expectedUserId, undefined); assert.equal(f.api.login, undefined);
  for (const input of [null, {}, { request: false }]) assert.throws(() => new InvitationApiClient(input), TypeError);
});
test('public preview uses POST body, exact route and strips email, tokens and unknown fields', async () => {
  const f = fixture({ invitation: invite({ email: 'PRIVATE', token: 'PRIVATE', secret: 'PRIVATE' }) }, 'synthetic-user');
  assert.deepEqual(await f.api.preview(token), invite());
  const [path, options] = f.calls[0]; assert.equal(path, '/api/local/auth/invitations/preview'); assert(!path.includes(token));
  assert.deepEqual(JSON.parse(options.body), { token }); assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-Carebridge-Account'], undefined);
  for (const [key, value] of Object.entries({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(options[key], value);
});
test('preview rejects wrong shape and malformed metadata without retaining any body', async () => {
  for (const patch of [{ id: 'bad' }, { centerId: '../center' }, { role: 'center' }, { expiresAt: '2026-02-30T00:00:00.000Z' }, { expiresAt: null }])
    await assert.rejects(fixture({ invitation: invite(patch) }).api.preview(token), code('INVALID_RESPONSE'));
  for (const value of [null, {}, { invitation: [] }]) await assert.rejects(fixture(value).api.preview(token), code('INVALID_RESPONSE'));
});
test('center list uses protected scope and exactly nine detached fields', async () => {
  const source = listed({ token: 'PRIVATE', password: 'PRIVATE' }); const f = fixture({ invitations: [source] }, 'synthetic-manager');
  const rows = await f.api.list(center); assert.deepEqual(rows, [listed()]); source.email = 'changed@example.test'; assert.equal(rows[0].email, 'person@example.test');
  assert.equal(f.calls[0][0], `/api/local/centers/${center}/operations/invitations`);
  assert.equal(f.calls[0][1].headers['X-Carebridge-Account'], 'synthetic-manager');
});
test('list refuses duplicate IDs, wrong center, partial excess and inconsistent terminal states', async () => {
  for (const rows of [[listed(), listed()], [listed({ centerId: 'other' })], Array(101).fill(listed()),
    [listed({ status: 'accepted' })], [listed({ revokedAt: '2026-10-11T00:00:00.000Z' })], [listed({ email: 'p@example.com' })]])
    await assert.rejects(fixture({ invitations: rows }, 'synthetic-manager').api.list(center), code('INVALID_RESPONSE'));
});
test('list permits legitimate terminal state metadata and empty list', async () => {
  for (const row of [listed({ status: 'accepted', acceptedAt: '2026-10-11T00:00:00.000Z' }), listed({ status: 'revoked', revokedAt: '2026-10-11T00:00:00.000Z' }), listed({ status: 'expired' })])
    assert.deepEqual(await fixture({ invitations: [row] }, 'synthetic-manager').api.list(center), [row]);
  assert.deepEqual(await fixture({ invitations: [] }, 'synthetic-manager').api.list(center), []);
});
test('invite captures normalized two-field input and returns only the fixed generic notice', async () => {
  const gate = Promise.withResolvers(), input = { email: 'Person@Example.TEST', role: 'guardian' };
  const f = fixture(() => gate.promise, 'synthetic-manager'); const pending = f.api.invite(center, input); input.role = 'therapist';
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { email: 'person@example.test', role: 'guardian' });
  gate.resolve(response({ message: INVITATION_REQUEST_NOTICE, token: 'PRIVATE', delivery: 'accepted' }, 202));
  assert.deepEqual(await pending, { message: INVITATION_REQUEST_NOTICE });
});
test('invite rejects injected fields and unsafe target without transport', async () => {
  const f = fixture(null, 'synthetic-manager');
  for (const input of [{ email: 'p@example.test', role: 'center' }, { email: 'p@example.test', role: 'guardian', token }, { email: 'p@example.com', role: 'guardian' }])
    await assert.rejects(f.api.invite(center, input), code('INVALID_INPUT'));
  await assert.rejects(f.api.list('../center'), code('INVALID_INPUT')); assert.equal(f.calls.length, 0);
});
test('revoke is explicit POST with empty body and no capability', async () => {
  const f = fixture({ revoked: true, token }, 'synthetic-manager'); assert.deepEqual(await f.api.revoke(center, iid), { revoked: true });
  assert.equal(f.calls[0][0], `/api/local/centers/${center}/operations/invitations/${iid}/revoke`);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), {});
  await assert.rejects(f.api.revoke(center, '../bad'), code('INVALID_INPUT'));
});
test('new acceptance posts exactly five fields without expected-account header and does not adopt identity', async () => {
  const f = fixture(accepted(false, { token: 'PRIVATE' })); assert.deepEqual(await f.api.accept(body()), accepted());
  assert.deepEqual(JSON.parse(f.calls[0][1].body), body()); assert.equal(f.calls[0][1].headers['X-Carebridge-Account'], undefined);
  assert.equal(f.base.expectedUserId, null);
});
test('new acceptance refuses an already bound account and invalid passwords before sending', async () => {
  const logged = fixture(accepted(), 'synthetic-user'); await assert.rejects(logged.api.accept(body()), code('ACCOUNT_SESSION_PRESENT')); assert.equal(logged.calls.length, 0);
  const f = fixture(accepted());
  for (const patch of [{ password: 'short', confirmation: 'short' }, { confirmation: 'wrong' }, { token: 'bad' }, { role: 'center' }, { redirect: 'PRIVATE' }])
    await assert.rejects(f.api.accept({ ...body(), ...patch }), code('INVALID_INPUT'));
  assert.equal(f.calls.length, 0);
});
test('existing acceptance keeps expected-account and permits the same receipt replay', async () => {
  for (const replayed of [false, true]) {
    const f = fixture(accepted(true, { replayed }), 'synthetic-user'); const result = await f.api.acceptExisting(body(true));
    assert.equal(result.replayed, replayed); assert.equal(f.calls[0][1].headers['X-Carebridge-Account'], 'synthetic-user');
    assert.deepEqual(JSON.parse(f.calls[0][1].body), body(true));
  }
});
test('acceptance refuses response account/center/role substitution and strips all secret extras', async () => {
  for (const patch of [{ invitation: { id: iid, centerId: 'other', role: 'guardian' } }, { invitation: { id: iid, centerId: center, role: 'therapist' } },
    { user: user({ userId: 'other' }) }, { linked: false }, { replayed: 0 }])
    await assert.rejects(fixture(accepted(true, patch), 'synthetic-user').api.acceptExisting(body(true)), code('INVALID_RESPONSE'));
  const result = await fixture(accepted(true, { user: user({ token: 'PRIVATE', password: 'PRIVATE' }), token: 'PRIVATE' }), 'synthetic-user').api.acceptExisting(body(true));
  assert(!JSON.stringify(result).includes('PRIVATE')); assert.equal(Object.keys(result.user).length, 4);
});
test('all protected methods refuse missing account before any request', async () => {
  const f = fixture(null);
  for (const work of [() => f.api.list(center), () => f.api.invite(center, { email: 'p@example.test', role: 'guardian' }), () => f.api.revoke(center, iid), () => f.api.acceptExisting(body(true))])
    await assert.rejects(work(), code('AUTH_REQUIRED'));
  assert.equal(f.calls.length, 0);
});
test('late account replacement rejects success and raw failure alike', async () => {
  for (const mode of ['success', 'failure']) {
    const gate = Promise.withResolvers(), f = fixture(() => gate.promise, 'synthetic-user');
    const pending = f.api.acceptExisting(body(true)); f.base.expectedUserId = 'other';
    if (mode === 'success') gate.resolve(response(accepted(true))); else gate.reject(new Error('PRIVATE'));
    await assert.rejects(pending, code('AUTH_REQUIRED'));
  }
});
test('abort before and after response refuses delivery without exposing raw errors', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture({ invitation: invite() });
  await assert.rejects(f.api.preview(token, controller.signal), code('CANCELLED')); assert.equal(f.calls.length, 0);
  const gate = Promise.withResolvers(), late = new AbortController(), g = fixture(() => gate.promise);
  const pending = g.api.preview(token, late.signal); late.abort(); gate.resolve(response({ invitation: invite() }));
  await assert.rejects(pending, code('CANCELLED'));
});
test('safe invitation 410 and conflict statuses remain exact, raw payloads never become error messages', async () => {
  for (const [status, error] of [[410, 'INVITATION_INVALID'], [409, 'ACCOUNT_SESSION_PRESENT'], [409, 'INVITATION_ACCOUNT_EXISTS'], [409, 'INVITATION_MEMBERSHIP_UNAVAILABLE'], [409, 'INVITATION_CONFLICT']]) {
    const f = fixture(() => response({ error, detail: 'PRIVATE' }, status));
    await assert.rejects(f.api.preview(token), e => code(error)(e) && !e.message.includes('PRIVATE'));
  }
});
test('unknown outcomes make exactly one request; a later explicit retry is not synthesized by the client', async () => {
  const f = fixture(async () => { throw new Error('PRIVATE'); });
  await assert.rejects(f.api.accept(body()), code('UNAVAILABLE')); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(f.api), '{}');
});
