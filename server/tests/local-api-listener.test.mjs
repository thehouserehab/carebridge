import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLocalApiListener } from '../local-api-listener.mjs';
import { MediaAccess } from '../media-access.mjs';
import { AccountDelivery } from '../account-delivery.mjs';

// Actual owned loopback HTTP and shutdown; synthetic service doubles only.
// These tests do not claim DB authorization, native media approval or playback.
const token = 'S'.repeat(48), userId = 'synthetic-reader', centerId = 'synthetic-center';
const uploadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contentPath = `/api/local/centers/${centerId}/conversations/synthetic-room/messages/synthetic-message/attachments/${uploadId}/content`;
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const user = () => ({ userId, email: 'reader@carebridge.test', centers: [{ id: centerId, role: 'guardian' }],
  expiresAt: new Date(Date.now() + 3600000).toISOString() });
function services() {
  return {
    auth: { async login() { return { user: user(), token }; }, async authenticate(value) { return value === token ? user() : null; }, async logout() {} },
    conversations: { async inbox() { return { rooms: [], snapshot: 'a'.repeat(32), hasMore: false, nextOffset: null }; },
      async list() {}, async sendText() {}, async markRead() {} },
    profiles: { async get() {} },
  };
}
function deferred() {
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => {
    resolve = (value) => { settled = true; yes(value); };
    reject = (error) => { settled = true; no(error); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) { assert(performance.now() < deadline, 'LOCAL_LISTENER_TEST_TIMEOUT'); await nextTurn(); }
}
function call(origin, pathname = '/', { method = 'GET', headers = {}, body } = {}) {
  let outgoing;
  const result = new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    outgoing = request({ hostname: '127.0.0.1', port: new URL(origin).port, path: pathname, method, headers, agent: false }, (response) => {
      const chunks = [];
      const snapshot = (aborted) => ({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'), aborted });
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => finish(snapshot(false)));
      response.on('aborted', () => finish(snapshot(true)));
      response.on('error', () => finish(snapshot(true)));
    });
    outgoing.on('error', () => finish({ status: null, headers: {}, body: '', aborted: true }));
    outgoing.end(body);
  });
  return { request: outgoing, result };
}
async function login(listener) {
  const result = await call(listener.origin, '/api/local/auth/login', { method: 'POST',
    headers: { Origin: listener.origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reader@carebridge.test', password: 'synthetic-password-only' }) }).result;
  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(JSON.parse(result.body), 'token'), false);
  assert.match(result.headers['set-cookie'][0], /^cb_local_[a-f0-9]{32}=/);
  return result.headers['set-cookie'][0].split(';')[0];
}
function access(open) {
  class SyntheticAccess extends MediaAccess { async open(...args) { return open(...args); } }
  return new SyntheticAccess({ transaction: async () => { throw new Error('No database calls in listener double.'); } },
    { openVerified: async () => { throw new Error('No store calls in listener double.'); } });
}
function opened(stream = Readable.from([bytes], { objectMode: false })) {
  return { attachment: { id: uploadId, name: 'synthetic.png', type: 'image/png', size: bytes.length },
    total: bytes.length, range: { start: 0, end: bytes.length - 1 }, stream };
}

test('closed listener inputs reject host/path/callback/service injection and getters before IO', async () => {
  const base = services();
  for (const input of [undefined, null, [], new Date(), {}, { services: base, host: '0.0.0.0' },
    { services: base, origin: 'http://127.0.0.1:1234' }, { services: base, path: 'synthetic' },
    { services: base, handler() {} }, { services: base, cookieName: 'cb_local_aaaaaaaaaaaaaaaa' },
    ...[undefined, 80, 1023, 65536, -1, 0.5, '0', NaN].map((port) => ({ services: base, port })),
    { services: base, screen: 'prepared' }, { services: base, screen: undefined },
    { services: { ...base, database: {} } }, { services: { ...base, origin: 'http://127.0.0.1:1234' } },
    { services: { ...base, cookieName: 'cb_local_aaaaaaaaaaaaaaaa' } },
    { services: { ...base, mediaAccess: { open() {} } }, screen: 'api-only' },
    { services: { ...base, mediaAccess: { open() {} } }, screen: 'prepared' },
    { services: { ...base, mediaMaintenance: 'worker' }, screen: 'api-only' },
    { services: { ...base, auth: {} } }, { services: Object.create({ ...base }) },
    Object.defineProperty({ services: base }, 'port', { get() { assert.fail('No option getter may execute.'); } }),
    { services: Object.defineProperty({ ...base }, 'auth', { get() { assert.fail('No service-map getter may execute.'); } }) },
    { services: base, [Symbol('unexpected')]: true },
  ]) await assert.rejects(createLocalApiListener(input), TypeError);
});

test('service map and screen are captured before the first await and cookies are listener-owned', async (t) => {
  const selected = services(), input = { services: selected };
  const pending = createLocalApiListener(input);
  selected.auth = { async login() { assert.fail('Replaced service must not run.'); } };
  input.screen = 'api-only'; input.port = 1;
  const listener = await pending; t.after(() => listener.close());
  assert(Object.isFrozen(listener)); assert.deepEqual(Object.keys(listener).sort(), ['close', 'origin']);
  const page = await call(listener.origin).result;
  assert.equal(page.status, 200); assert.match(page.body, /비공개 임시 폴더에 격리 보관/);
  const cookie = await login(listener);
  const other = await createLocalApiListener({ services: services(), screen: 'api-only' }); t.after(() => other.close());
  assert.notEqual((await login(other)).split('=')[0], cookie.split('=')[0]);
  assert.equal((await call(other.origin, '/api/local/auth/session', { headers: { Cookie: cookie } }).result).status, 401);
});

test('API-only exposes no static screen, script, favicon or configurable filesystem route', async (t) => {
  const listener = await createLocalApiListener({ services: services(), screen: 'api-only' }); t.after(() => listener.close());
  for (const pathname of ['/', '/favicon.ico', '/local-api/client.js', '/local-api/self-profile-client.js', '/local-api/self-profile-ui.js',
    '/src/media-policy.js', '/server/auth.mjs', '/.env', '/?screen=quarantine']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const result = await call(listener.origin, pathname, { method }).result;
      assert.equal(result.status, 404); assert.equal(result.headers['cache-control'], 'no-store');
      assert.match(result.headers['content-security-policy'], /connect-src 'self'/);
      assert.doesNotMatch(result.headers['content-security-policy'], /blob:|data:|unsafe-inline/);
    }
  }
  assert.equal((await call(listener.origin, '/api/auth/login').result).status, 404);
  assert.equal((await call(listener.origin, '/api/local/auth/session').result).status, 401);
  await login(listener);
});

test('quarantine screen keeps fixed assets, exact URLs, safe headers and HTTP method behavior', async (t) => {
  const listener = await createLocalApiListener({ services: services() }); t.after(() => listener.close());
  for (const pathname of ['/', '/local-api/client.js', '/local-api/app.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css', '/local-api/care-client.js',
    '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/self-profile-client.js', '/local-api/self-profile-ui.js',
    '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js',
    '/src/record-fields.js', '/src/feedback-fields.js', '/src/media-policy.js']) {
    const result = await call(listener.origin, pathname).result;
    assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.equal(result.headers['x-frame-options'], 'DENY');
    assert.equal(result.headers['referrer-policy'], 'no-referrer'); assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(result.headers['content-security-policy'], /blob:|data:|unsafe-inline/);
    if (pathname === '/') assert.match(result.body, /<html lang="ko" data-media-mode="quarantine-only">/);
  }
  for (const pathname of ['/local-api/app.js?debug=1', '/local-api/../server/auth.mjs', '//local-api/client.js', '/local-api/index.html',
    '/local-api/email-login-client.js', '/local-api/email-login-ui.js'])
    assert.equal((await call(listener.origin, pathname).result).status, 404);
  assert.equal((await call(listener.origin, '/favicon.ico').result).status, 204);
  const head = await call(listener.origin, '/', { method: 'HEAD' }).result;
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert(Number(head.headers['content-length']) > 0);
  const post = await call(listener.origin, '/', { method: 'POST' }).result;
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
});

test('invitation landing is exact, guarded by configured delivery, and never exposes a synthetic mailbox', async t => {
  const plain = await createLocalApiListener({ services: services() }); t.after(() => plain.close());
  const paths = ['/account/invitation', ...['invitation-entry', 'invitation-token', 'invitation-client', 'invitation-ui', 'operations-invitations']
    .map(name => `/local-api/${name}.js`)];
  for (const path of paths) assert.equal((await call(plain.origin, path).result).status, 404);
  const dependency = services();
  Object.assign(dependency.auth, { async createInvitation() {}, async preparePasswordRecovery() {}, async accountDeliveryRecipient() {} });
  dependency.accountDelivery = new AccountDelivery({ auth: dependency.auth, origin: 'https://carebridge.test', transport: { async send() {} } });
  const listener = await createLocalApiListener({ services: dependency }); t.after(() => listener.close());
  for (const path of paths) {
    const response = await call(listener.origin, path).result;
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  assert.match((await call(listener.origin).result).body, /data-invitations-mode="synthetic"/);
  assert.doesNotMatch((await call(listener.origin, '/account/invitation').result).body, /src="\/local-api\/app\.js"/);
  for (const path of ['/account/invitation/', '/account/invitation?token=redacted', '/account/password-recovery',
    '/test/mailbox', '/api/local/test/mailbox', '/local-api/invitation.html']) {
    assert.equal((await call(listener.origin, path).result).status, 404);
  }
  const apiOnly = await createLocalApiListener({ services: dependency, screen: 'api-only' }); t.after(() => apiOnly.close());
  for (const path of paths) assert.equal((await call(apiOnly.origin, path).result).status, 404);
});

test('all modes retain exact host/origin, duplicate header and forwarding rejection', async (t) => {
  for (const screen of ['quarantine', 'api-only', 'prepared']) {
    const selected = { ...services(), ...(screen === 'prepared' ? { mediaAccess: access(async () => opened()) } : {}) };
    const listener = await createLocalApiListener({ services: selected, screen }); t.after(() => listener.close());
    for (const pathname of ['/', '/api/local/auth/session']) {
      for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'http://127.0.0.1:1' }, { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-site' }, { Forwarded: 'host=synthetic.invalid' }, { 'X-Forwarded-For': '127.0.0.1' },
        ['Host', new URL(listener.origin).host, 'Origin', listener.origin, 'Origin', listener.origin],
        ['Host', new URL(listener.origin).host, 'Host', new URL(listener.origin).host],
      ]) {
        const result = await call(listener.origin, pathname, { headers }).result;
        assert.equal(result.status, 403); assert.equal(result.headers['access-control-allow-origin'], undefined);
      }
    }
  }
});

test('prepared services reject quarantine and worker maintenance cannot mask inline cleanup', async (t) => {
  const mediaAccess = access(async () => opened());
  await assert.rejects(createLocalApiListener({ services: { ...services(), mediaAccess } }), TypeError);
  await assert.rejects(createLocalApiListener({ screen: 'api-only', services: { ...services(), mediaAccess,
    mediaMaintenance: 'worker', mediaCleanup() {} } }), TypeError);
  const listener = await createLocalApiListener({ screen: 'api-only', services: { ...services(), mediaAccess, mediaMaintenance: 'worker' } });
  t.after(() => listener.close());
  const cookie = await login(listener);
  const result = await call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } }).result;
  assert.equal(result.status, 200); assert.equal(Number(result.headers['content-length']), bytes.length);
  assert.equal((await call(listener.origin).result).status, 404);
});

test('prepared screen is explicit, marked by the server and narrowly permits authenticated blob display', async (t) => {
  const selected = { ...services(), mediaAccess: access(async () => opened()), mediaMaintenance: 'worker' };
  const input = { screen: 'prepared', services: selected }, pending = createLocalApiListener(input);
  input.screen = 'quarantine'; selected.mediaAccess = undefined;
  const listener = await pending; t.after(() => listener.close());
  const page = await call(listener.origin).result;
  assert.equal(page.status, 200);
  assert.equal(page.body.match(/data-media-mode="prepared-delivery"/g)?.length, 1);
  assert.doesNotMatch(page.body, /data-media-mode="quarantine-only"/);
  assert.equal(Number(page.headers['content-length']), Buffer.byteLength(page.body));
  const directives = page.headers['content-security-policy'].split(';').map(value => value.trim());
  assert(directives.includes("img-src 'self' blob:")); assert(directives.includes('media-src blob:'));
  assert(directives.includes("script-src 'self'")); assert(directives.includes("connect-src 'self'"));
  assert.doesNotMatch(page.headers['content-security-policy'], /data:|unsafe-inline|unsafe-eval/);
  assert.equal((await call(listener.origin, '/local-api/media-viewer.js').result).status, 200);
  for (const path of ['/?screen=prepared', '/?media-mode=prepared-delivery', '/server/media-access.mjs', '/.env', '/local-api/media-viewer.js?mode=prepared'])
    assert.equal((await call(listener.origin, path).result).status, 404);
  assert.equal((await call(listener.origin, contentPath).result).status, 401);
  const cookie = await login(listener);
  assert.equal((await call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } }).result).status, 200);
});

test('listen failure cannot close caller services or the listener that already owns the port', async (t) => {
  const base = services(); let closed = 0;
  for (const service of Object.values(base)) service.close = () => { closed++; };
  const listener = await createLocalApiListener({ services: base }); t.after(() => listener.close());
  await assert.rejects(createLocalApiListener({ services: base, port: Number(new URL(listener.origin).port) }), { code: 'EADDRINUSE' });
  assert.equal(closed, 0); assert.equal((await call(listener.origin).result).status, 200);
  await listener.close(); assert.equal(closed, 0);
});

test('a failed bind never closes another listener\'s shared media service', async (t) => {
  const mediaAccess = access(async () => opened()), selected = { ...services(), mediaAccess };
  const listener = await createLocalApiListener({ services: selected, screen: 'api-only' }); t.after(() => listener.close());
  await assert.rejects(createLocalApiListener({ services: selected, screen: 'api-only',
    port: Number(new URL(listener.origin).port) }), { code: 'EADDRINUSE' });
  const cookie = await login(listener);
  const result = await call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } }).result;
  assert.equal(result.status, 200);
});

test('close is idempotent and waits for an already-running handler without owning its DB or files', async (t) => {
  const entered = deferred(), release = deferred(), base = services(); let closed = false;
  base.auth.authenticate = async () => { entered.resolve(); await release.promise; return user(); };
  const listener = await createLocalApiListener({ services: base }); t.after(async () => { release.resolve(); await listener.close(); });
  const cookie = await login(listener);
  const pending = call(listener.origin, '/api/local/auth/session', { headers: { Cookie: cookie } });
  await until(() => entered.settled);
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(listener.origin).port) });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve)); socket.write('GET / HTTP/1.1\r\nHost: ');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  const first = listener.close(); assert.equal(listener.close(), first); first.then(() => { closed = true; });
  await socketClosed; await nextTurn(); assert.equal(closed, false);
  release.resolve(); await first;
  assert.equal((await pending.result).aborted, true); assert.equal(closed, true);
  assert.equal((await call(listener.origin).result).aborted, true);
});

test('request-drain timeout does not become shutdown success and permits an explicit retry', async (t) => {
  const entered = deferred(), release = deferred(), base = services();
  base.auth.authenticate = async () => { entered.resolve(); await release.promise; return user(); };
  const listener = await createLocalApiListener({ services: base }); t.after(async () => { release.resolve(); t.mock.timers.reset(); await listener.close(); });
  const cookie = await login(listener);
  const pending = call(listener.origin, '/api/local/auth/session', { headers: { Cookie: cookie } });
  await until(() => entered.settled);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = listener.close(), rejected = assert.rejects(first, /Local listener shutdown timed out/);
  t.mock.timers.tick(10001); await rejected;
  t.mock.timers.reset(); release.resolve();
  const next = listener.close(); assert.notEqual(next, first); await next;
  assert.equal((await pending.result).aborted, true);
});

test('close waits beyond HTTP disconnect for late media open and actual asynchronous stream disposal', async (t) => {
  const opening = deferred(), entered = deferred(), destroying = deferred(), destroyed = deferred();
  const mediaAccess = access(async () => { entered.resolve(); return opening.promise; });
  const listener = await createLocalApiListener({ screen: 'api-only', services: { ...services(), mediaAccess } });
  t.after(async () => { opening.resolve(opened()); destroying.resolve(); await listener.close(); });
  const cookie = await login(listener);
  const pending = call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } });
  await until(() => entered.settled); pending.request.destroy(); await pending.result;
  let closed = false; const closing = listener.close().then(() => { closed = true; });
  await nextTurn(); assert.equal(closed, false);
  const stream = new Readable({ read() {}, destroy(_error, callback) { destroyed.resolve(); destroying.promise.then(() => callback()); } });
  opening.resolve(opened(stream)); await until(() => destroyed.settled); await nextTurn();
  assert.equal(closed, false); assert.equal(stream.closed, false);
  destroying.resolve(); await closing; assert.equal(stream.closed, true); assert.equal(closed, true);
});

test('media-drain timeout retains late work and repeated close waits rather than reporting success', async (t) => {
  const opening = deferred(), entered = deferred();
  const mediaAccess = access(async () => { entered.resolve(); return opening.promise; });
  const listener = await createLocalApiListener({ screen: 'api-only', services: { ...services(), mediaAccess } });
  t.after(async () => { opening.resolve(opened()); t.mock.timers.reset(); await listener.close(); });
  const cookie = await login(listener);
  const pending = call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } });
  await until(() => entered.settled); pending.request.destroy(); await pending.result;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = listener.close(), rejected = assert.rejects(first, /Local listener shutdown timed out/);
  // HTTP drain completes asynchronously before the media drain timer is set.
  for (let i = 0; i < 10; i++) await nextTurn();
  t.mock.timers.tick(10001); await rejected;
  t.mock.timers.reset();
  const value = opened(); opening.resolve(value);
  const next = listener.close(); assert.notEqual(next, first); await next;
  assert.equal(value.stream.closed, true);
});
