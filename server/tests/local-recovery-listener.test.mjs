import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Auth } from '../auth.mjs';
import { AccountDelivery } from '../account-delivery.mjs';
import { LocalPasswordRecovery } from '../local-password-recovery.mjs';
import { createLocalApiListener } from '../local-api-listener.mjs';
import { createLocalApiSandbox } from '../local-api-sandbox.mjs';

const paths = ['/account/password-recovery', '/account/password-recovery/request',
  ...['recovery-entry', 'recovery-token', 'recovery-client', 'recovery-ui', 'account-input'].map(name => `/local-api/${name}.js`)];
const base = () => ({ auth: { async login() {}, async authenticate() { return null; }, async logout() {} },
  conversations: { async inbox() {}, async list() {}, async sendText() {}, async markRead() {} }, profiles: { async get() {} } });
function queue() {
  return new LocalPasswordRecovery({ accountDelivery: new AccountDelivery({
    auth: { async createInvitation() {}, async preparePasswordRecovery() { return null; }, async accountDeliveryRecipient() {} },
    origin: 'https://carebridge.test', transport: { async send() { assert.fail('No real delivery is allowed.'); } },
  }) });
}
function call(origin, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(pathname, origin), { method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: body === undefined ? {} : { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('RECOVERY_LISTENER_TEST_TIMEOUT')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('recovery assets and APIs stay closed without a trusted configured queue, including a structural imitation', async t => {
  const listener = await createLocalApiListener({ services: base() }); t.after(() => listener.close());
  for (const path of paths) assert.equal((await call(listener.origin, path)).status, 404);
  assert.equal((await call(listener.origin, '/api/local/auth/password-recovery/request', { email: 'missing@carebridge.test' })).status, 404);
  assert(!(await call(listener.origin, '/')).text.includes('data-recovery-mode'));
  await assert.rejects(createLocalApiListener({ services: { ...base(), passwordRecovery: { request() {}, close() {} } } }), TypeError);
});

test('recovery-only listener serves exact assets with no-store and no-referrer but exposes no mailbox or invitation route', async t => {
  const passwordRecovery = queue(), listener = await createLocalApiListener({ services: { ...base(), passwordRecovery } });
  t.after(async () => { await listener.close(); await passwordRecovery.close(); });
  const page = await call(listener.origin, '/');
  assert.equal(page.text.match(/data-recovery-mode="synthetic"/g)?.length, 1);
  assert(!page.text.includes('data-invitations-mode'));
  for (const path of paths) {
    const res = await call(listener.origin, path); assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store'); assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  for (const path of ['/account/invitation', '/local-api/invitation-client.js', '/local-api/recovery.html',
    '/account/password-recovery?token=not-a-token', '/account/password-recovery/', '/api/local/recovery/mailbox',
    '/api/local/auth/password-recovery/mailbox', '/server/local-recovery-mailbox.mjs'])
    assert.equal((await call(listener.origin, path)).status, 404);
});

test('API-only mode cannot accidentally publish recovery screens or script assets', async t => {
  const passwordRecovery = queue();
  const listener = await createLocalApiListener({ screen: 'api-only', services: { ...base(), passwordRecovery } });
  t.after(async () => { await listener.close(); await passwordRecovery.close(); });
  for (const path of ['/', ...paths]) assert.equal((await call(listener.origin, path)).status, 404);
});

test('factory delivery stays private, one-take and synthetic while known and unknown requests return the same response', async t => {
  const sandbox = await createLocalApiSandbox(); t.after(() => sandbox.close());
  const email = sandbox.credentials.find(value => value.role === 'guardian').email;
  assert.equal(Object.keys(sandbox).includes('takeRecovery'), false);
  assert.equal(JSON.stringify(sandbox).includes(email), false);
  const known = await call(sandbox.origin, '/api/local/auth/password-recovery/request', { email });
  const unknown = await call(sandbox.origin, '/api/local/auth/password-recovery/request', { email: 'missing@carebridge.test' });
  assert.equal(known.status, 202); assert.equal(unknown.status, 202); assert.equal(known.text, unknown.text);
  assert.equal(known.headers['set-cookie'], undefined); assert.equal(unknown.headers['set-cookie'], undefined);
  const link = await sandbox.takeRecovery(email);
  assert(typeof link === 'string' && link.startsWith(sandbox.origin + '/account/password-recovery#token=cr1.'), 'Fixed private recovery link expected.');
  assert.equal(await sandbox.takeRecovery(email), null); assert.equal(await sandbox.takeRecovery('missing@carebridge.test'), null);
  await sandbox.close(); await assert.rejects(sandbox.takeRecovery(email));
});

test('factory close does not release the DB while a detached recovery issuance is still executing', async t => {
  const sandbox = await createLocalApiSandbox();
  const email = sandbox.credentials.find(value => value.role === 'guardian').email;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const prepare = Auth.prototype.preparePasswordRecovery;
  t.mock.method(Auth.prototype, 'preparePasswordRecovery', async function (input) {
    entered.resolve(); await release.promise;
    assert.equal(sandbox.database.closed, false);
    return prepare.call(this, input);
  });
  t.after(async () => { release.resolve(); await sandbox.close(); });
  const accepted = await call(sandbox.origin, '/api/local/auth/password-recovery/request', { email });
  assert.equal(accepted.status, 202); await entered.promise;
  let closed = false; const closing = sandbox.close().then(() => { closed = true; });
  for (let index = 0; index < 5; index++) await nextTurn();
  assert.equal(closed, false); assert.equal(sandbox.database.closed, false);
  release.resolve(); await closing; assert.equal(closed, true); assert.equal(sandbox.database.closed, true);
  assert.equal(sandbox.credentials.length, 0); await assert.rejects(sandbox.takeRecovery(email));
});
