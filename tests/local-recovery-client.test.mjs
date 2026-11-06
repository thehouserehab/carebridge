// Pure HTTP doubles: no account, delivery, server or browser is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { RecoveryApiClient, recoveryCompletion, RECOVERY_REQUEST_NOTICE } from '../local-api/recovery-client.js';
import { takeRecoveryLocation, isRecoveryToken } from '../local-api/recovery-token.js';
import { syntheticAccountEmail } from '../local-api/account-input.js';
import { invitationEmail } from '../local-api/invitation-client.js';

const token = `cr1.${'s'.repeat(43)}`;
const input = () => ({ token, newPassword: 'Synthetic-password-2', confirmation: 'Synthetic-password-2' });
const code = (name, status) => error => error instanceof LocalApiError && error.code === name && (status === undefined || error.status === status);
const deferred = () => Promise.withResolvers();
function fixture(reply = () => ({ passwordChanged: true, reauthenticate: true })) {
  const calls = [], transport = { expectedUserId: null, async request(path, options) { calls.push({ path, ...options }); return reply(path, options); } };
  return { calls, transport, client: new RecoveryApiClient(transport) };
}
function capture({ pathname = '/account/password-recovery', search = '', hash = `#token=${token}` } = {}) {
  const writes = [], location = { pathname, search, hash };
  const history = { replaceState(state, title, path) { writes.push({ state, title, path }); location.hash = ''; location.search = ''; } };
  return { location, writes, take: () => takeRecoveryLocation(location, history) };
}

test('capability capture scrubs URL before returning exact complete mode without retaining query', () => {
  const f = capture(), result = f.take();
  assert.deepEqual(result, { mode: 'complete', token }); assert(Object.isFrozen(result));
  assert.deepEqual(f.writes, [{ state: null, title: '', path: '/account/password-recovery' }]);
  assert.equal(f.location.hash, '');
});
test('request landing allows only its exact path without query or fragment', () => {
  const f = capture({ pathname: '/account/password-recovery/request', hash: '' });
  assert.deepEqual(f.take(), { mode: 'request', token: null });
  for (const change of [{ hash: '#main' }, { search: '?email=private' }, { pathname: '/account/password-recovery/request/' }]) {
    const bad = capture({ pathname: '/account/password-recovery/request', hash: '', ...change });
    assert.throws(bad.take, { message: 'PASSWORD_RECOVERY_INVALID' }); assert.equal(bad.writes.length, 1);
  }
});
test('malformed, duplicate, encoded and trailing-newline capabilities are scrubbed and rejected', () => {
  for (const hash of ['', `#token=${token}\n`, `#token=${token}&token=${token}`, `#token=${token.slice(0, -1)}`, '#token=cr1.%41', '#token=other.' + 'a'.repeat(43)]) {
    const f = capture({ hash }); assert.throws(f.take, { message: 'PASSWORD_RECOVERY_INVALID' }); assert.equal(f.location.hash, '');
  }
  assert.equal(isRecoveryToken(token + '\n'), false);
  const f = capture({ search: '?token=private' }); assert.throws(f.take); assert.equal(f.location.search, '');
});
test('scrub failure returns only a fixed error with no underlying URL or history cause', () => {
  assert.throws(() => takeRecoveryLocation(capture().location, { replaceState() { throw new Error('private capability'); } }), error => error.message === 'PASSWORD_RECOVERY_INVALID' && error.cause === undefined);
});
test('shared synthetic mailbox policy preserves invitation alias and excludes real/control addresses', () => {
  assert.equal(invitationEmail, syntheticAccountEmail); assert.equal(syntheticAccountEmail(' PERSON@example.test '), 'person@example.test');
  for (const value of ['person@example.com', 'a@bad-.test', '<a>@example.test', 'a@example.test\n', 'a@.test', 'a'.repeat(255), '\ud800@example.test'])
    assert.throws(() => syntheticAccountEmail(value), code('INVALID_INPUT'));
});
test('request body is only normalized email and result projects only generic public notice', async () => {
  const f = fixture(() => ({ message: RECOVERY_REQUEST_NOTICE, token, email: 'private@example.test', exists: true }));
  assert.deepEqual(await f.client.request('PERSON@example.test'), { message: RECOVERY_REQUEST_NOTICE });
  assert.equal(f.calls[0].path, '/api/local/auth/password-recovery/request');
  assert.deepEqual(f.calls[0].body, { email: 'person@example.test' });
});
test('request rejects non-generic notices rather than displaying private server text', async () => {
  for (const value of [null, {}, { message: 'account exists' }, { message: true }]) {
    const f = fixture(() => value); await assert.rejects(f.client.request('a@example.test'), code('INVALID_RESPONSE'));
  }
});
test('completion captures three exact input fields and minimally projects success without auth adoption', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), original = input();
  const work = f.client.complete(original); original.token = 'changed'; original.newPassword = 'changed';
  assert.deepEqual(f.calls[0].body, input());
  gate.resolve({ passwordChanged: true, reauthenticate: true, token, user: { secret: 'ignored' } });
  assert.deepEqual(await work, { passwordChanged: true, reauthenticate: true }); assert.equal(f.transport.expectedUserId, null);
  assert.equal(f.calls[0].path, '/api/local/auth/password-recovery/complete'); assert(!JSON.stringify(f.client).includes(token));
});
test('completion rejects invalid shape, lengths, malformed Unicode and mismatched confirmation before transport', async () => {
  const f = fixture();
  for (const value of [null, [], { ...input(), email: 'a@example.test' }, { ...input(), newPassword: 'short' },
    { ...input(), newPassword: 'a'.repeat(129), confirmation: 'a'.repeat(129) }, { ...input(), newPassword: '\ud800'.repeat(12), confirmation: '\ud800'.repeat(12) }])
    await assert.rejects(f.client.complete(value), code('INVALID_INPUT'));
  await assert.rejects(f.client.complete({ ...input(), confirmation: 'Different-password' }), code('PASSWORD_CONFIRMATION_MISMATCH'));
  await assert.rejects(f.client.complete({ ...input(), token: token + '\n' }), code('PASSWORD_RECOVERY_INVALID', 410));
  assert.equal(f.calls.length, 0);
});
test('password boundaries preserve exact whitespace, allow 12 and 128, and do not trim secrets', () => {
  for (const password of [' '.repeat(12), 'x'.repeat(128)]) assert.deepEqual(recoveryCompletion({ token, newPassword: password, confirmation: password }), { token, newPassword: password, confirmation: password });
});
test('success requires both exact boolean outcomes', async () => {
  for (const value of [null, {}, { passwordChanged: true }, { passwordChanged: true, reauthenticate: false }, { passwordChanged: 1, reauthenticate: true }])
    await assert.rejects(fixture(() => value).client.complete(input()), code('INVALID_RESPONSE'));
});
test('current session blocks either anonymous mutation before any network', async () => {
  const f = fixture(); f.transport.expectedUserId = 'active-account';
  await assert.rejects(f.client.request('a@example.test'), code('ACCOUNT_SESSION_PRESENT', 409));
  await assert.rejects(f.client.complete(input()), code('ACCOUNT_SESSION_PRESENT', 409)); assert.equal(f.calls.length, 0);
});
test('account change during success rejects late response', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), work = f.client.complete(input());
  f.transport.expectedUserId = 'another-account'; gate.resolve({ passwordChanged: true, reauthenticate: true });
  await assert.rejects(work, code('AUTH_REQUIRED', 401));
});
test('account change during failure overrides stale error without raw details', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), work = f.client.request('a@example.test');
  f.transport.expectedUserId = 'another-account'; gate.reject(new Error('private')); await assert.rejects(work, code('AUTH_REQUIRED', 401));
});
test('pre-abort prevents dispatch and post-abort prevents acceptance', async () => {
  const aborted = new AbortController(); aborted.abort(); const f = fixture();
  await assert.rejects(f.client.complete(input(), aborted.signal), code('CANCELLED')); assert.equal(f.calls.length, 0);
  const gate = deferred(), g = fixture(() => gate.promise), signal = new AbortController(), work = g.client.complete(input(), signal.signal);
  signal.abort(); gate.resolve({ passwordChanged: true, reauthenticate: true }); await assert.rejects(work, code('CANCELLED'));
});
test('unknown transport errors are fixed and never automatically retried', async () => {
  const f = fixture(() => { throw new Error(`private ${token}`); });
  await assert.rejects(f.client.complete(input()), error => error.code === 'UNAVAILABLE' && !error.message.includes(token) && error.cause === undefined);
  assert.equal(f.calls.length, 1);
});
test('safe definite errors retain exact code/status and unknown remains uncertain', async () => {
  for (const [name, status] of [['PASSWORD_UNCHANGED', 400], ['PASSWORD_CONFIRMATION_MISMATCH', 400], ['INVALID_INPUT', 400], ['PASSWORD_RECOVERY_INVALID', 410], ['ACCOUNT_SESSION_PRESENT', 409], ['UNAVAILABLE', 503]]) {
    const f = fixture(() => { throw new LocalApiError(name, status); }); await assert.rejects(f.client.complete(input()), code(name, status)); assert.equal(f.calls.length, 1);
  }
});
test('base transport sends recovery anonymously but logout stays account-bound with secure request options', async () => {
  const calls = [], api = new LocalApiClient({ fetch: async (path, options) => {
    calls.push({ path, options }); return new Response(path.endsWith('logout') ? null : JSON.stringify(path.endsWith('request') ? { message: RECOVERY_REQUEST_NOTICE } : { passwordChanged: true, reauthenticate: true }), { status: path.endsWith('logout') ? 204 : path.endsWith('request') ? 202 : 200, headers: { 'Content-Type': 'application/json' } });
  } });
  api.expectedUserId = 'active-account';
  await api.request('/api/local/auth/password-recovery/request', { body: { email: 'a@example.test' } });
  await api.request('/api/local/auth/password-recovery/complete', { body: input() }); await api.logout();
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-Carebridge-Request'], '1');
  }
  assert.equal(calls[0].options.headers['X-Carebridge-Account'], undefined); assert.equal(calls[1].options.headers['X-Carebridge-Account'], undefined);
  assert.equal(calls[2].options.headers['X-Carebridge-Account'], 'active-account');
});
test('base status mapping retains only approved recovery codes and drops injected public detail', async () => {
  for (const [status, serverCode, expected] of [[400, 'PASSWORD_UNCHANGED', 'PASSWORD_UNCHANGED'], [400, 'PASSWORD_CONFIRMATION_MISMATCH', 'PASSWORD_CONFIRMATION_MISMATCH'], [410, 'PASSWORD_RECOVERY_INVALID', 'PASSWORD_RECOVERY_INVALID'], [409, 'ACCOUNT_SESSION_PRESENT', 'ACCOUNT_SESSION_PRESENT'], [503, 'private', 'UNAVAILABLE']]) {
    const api = new LocalApiClient({ fetch: async () => new Response(JSON.stringify({ error: serverCode, message: `private ${token}` }), { status, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(api.request('/api/local/auth/password-recovery/complete', { body: input() }), error => code(expected, status)(error) && !error.message.includes(token));
  }
});
