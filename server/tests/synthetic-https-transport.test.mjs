import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { connect as connectTcp } from 'node:net';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SyntheticHttpsTransport, isSyntheticHttpsTransport } from '../synthetic-https-transport.mjs';
import { createLocalApiListener, createSyntheticHttpsApiListener } from '../local-api-listener.mjs';
import { MediaAccess } from '../media-access.mjs';
import { syntheticHttpsCertificate } from './synthetic-https-certificate-fixture.mjs';

// Opt-in Windows integration. All listeners/clients bind loopback only. Private
// address validation below is pure configuration, never a LAN listen/connect.
const enabled = process.platform === 'win32' && Boolean(process.env.CAREBRIDGE_TEST_POWERSHELL);
const check = (name, fn) => test(name, { skip: enabled ? false : 'Set CAREBRIDGE_TEST_POWERSHELL to an explicit PowerShell 7 path on Windows.' }, fn);
let material;
before(async () => { if (enabled) material = await syntheticHttpsCertificate(); });
after(() => material?.key.fill(0));
const options = (extra = {}) => ({ mode: 'loopback-verification', host: '127.0.0.1', peerAddress: '127.0.0.1',
  cert: material.cert, key: material.key, confirmSynthetic: true, ...extra });
const token = 'T'.repeat(48), userId = 'synthetic-guardian', centerId = 'synthetic-center';
const uploadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const contentPath = `/api/local/centers/${centerId}/conversations/synthetic-room/messages/synthetic-message/attachments/${uploadId}/content`;
const uploadPath = `/api/local/centers/${centerId}/conversations/synthetic-room/uploads/${uploadId}/content`;
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const user = () => ({ userId, email: 'guardian@tls.test', centers: [{ id: centerId, role: 'guardian' }],
  expiresAt: new Date(Date.now() + 3600000).toISOString() });
function services() {
  return {
    auth: { async login() { return { token, user: user() }; }, async authenticate(value) { return value === token ? user() : null; }, async logout() {} },
    conversations: { async inbox() { return { rooms: [], snapshot: 'a'.repeat(32), hasMore: false, nextOffset: null }; },
      async list() {}, async sendText() {}, async markRead() {} }, profiles: { async get() {} },
  };
}
function call(origin, path = '/', { method = 'GET', headers = {}, body, ca = material.cert, tls = {} } = {}) {
  let outgoing;
  const result = new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    outgoing = request({ hostname: '127.0.0.1', port: new URL(origin).port, path, method, headers,
      agent: false, ca, rejectUnauthorized: true, servername: '', ...tls }, response => {
      const chunks = [];
      const finishResponse = aborted => finish({ status: response.statusCode, headers: response.headers,
        bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), aborted });
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => finishResponse(false));
      response.on('aborted', () => finishResponse(true));
      response.on('error', () => finishResponse(true));
    });
    outgoing.on('error', error => finish({ status: null, headers: {}, bytes: Buffer.alloc(0), text: '', aborted: true, code: error.code }));
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('SYNTHETIC_TLS_REQUEST_TIMEOUT')));
    outgoing.end(body);
  });
  return { request: outgoing, result };
}
const postHeaders = origin => ({ Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' });
async function start(t, selected = services(), extra = {}) {
  const transport = new SyntheticHttpsTransport(options());
  const listener = await createSyntheticHttpsApiListener({ services: selected, transport, ...extra });
  t.after(() => listener.close());
  return { ...listener, transport };
}
async function login(listener) {
  const response = await call(listener.origin, '/api/local/auth/login', { method: 'POST', headers: postHeaders(listener.origin),
    body: JSON.stringify({ email: 'guardian@tls.test', password: 'Synthetic TLS fixture only!' }) }).result;
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(JSON.parse(response.text), 'token'), false);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /; Secure$/); assert.match(cookie, /; HttpOnly; SameSite=Strict;/);
  return cookie.split(';')[0];
}
function access(open) {
  class TestAccess extends MediaAccess { async open(...args) { return open(...args); } }
  return new TestAccess({ transaction: async () => assert.fail('Not a database test') },
    { openVerified: async () => assert.fail('Not a file-store test') });
}
const opened = (stream = Readable.from([bytes], { objectMode: false })) => ({
  attachment: { id: uploadId, name: 'synthetic.png', type: 'image/png', size: bytes.length },
  total: bytes.length, range: { start: 0, end: bytes.length - 1 }, stream,
});
function deferred() {
  let resolve, settled = false;
  const promise = new Promise(done => { resolve = value => { settled = true; done(value); }; });
  return { promise, resolve, get settled() { return settled; } };
}
async function until(condition) {
  const deadline = performance.now() + 5000;
  while (!condition()) { assert(performance.now() < deadline, 'SYNTHETIC_TLS_TEST_TIMEOUT'); await nextTurn(); }
}

check('TLS configuration is explicit, exact, branded and copied without IO', async () => {
  for (const selected of [null, {}, [], options({ confirmSynthetic: false }), options({ mode: 'production' }),
    options({ host: '0.0.0.0' }), options({ peerAddress: '127.0.0.2' }), options({ extra: true }),
    options({ cert: material.cert.toString() }), options({ key: Buffer.alloc(128) }),
    options({ mode: 'private-wifi', host: '8.8.8.8', peerAddress: '10.231.9.11' }),
    options({ mode: 'private-wifi', host: '10.231.9.10', peerAddress: '10.231.9.10' }),
    options({ mode: 'private-wifi', host: '10.231.9.10', peerAddress: '127.0.0.1' }),
    options({ mode: 'private-wifi', host: '10.231.9.12', peerAddress: '10.231.9.11' }),
    Object.defineProperty(options(), 'cert', { get() { assert.fail('No getter execution'); } }),
  ]) assert.throws(() => new SyntheticHttpsTransport(selected), /SYNTHETIC_HTTPS_CONFIG_INVALID/);
  class Untrusted extends SyntheticHttpsTransport {}
  assert.throws(() => new Untrusted(options()), TypeError);
  assert.equal(isSyntheticHttpsTransport(Object.create(SyntheticHttpsTransport.prototype)), false);
  const privateTransport = new SyntheticHttpsTransport(options({ mode: 'private-wifi', host: '10.231.9.10', peerAddress: '10.231.9.11' }));
  assert.equal(privateTransport.host, '10.231.9.10'); privateTransport.invalidate(); // Never listen on this fixture address.
  const cert = Buffer.from(material.cert), key = Buffer.from(material.key);
  const transport = new SyntheticHttpsTransport(options({ cert, key }));
  cert.fill(0); key.fill(0);
  assert(Object.isFrozen(transport)); assert.equal(JSON.stringify(transport), '{}');
  assert.equal(transport.origin, null); assert.equal(transport.active, false);
  assert.equal(transport.accepts({ socket: { encrypted: true } }), false);
  const listener = await createSyntheticHttpsApiListener({ services: services(), transport });
  try { assert.equal((await call(listener.origin).result).status, 200); } finally { await listener.close(); }
});

check('HTTP default cannot be converted by a host, HTTPS origin or transport option', async () => {
  const transport = new SyntheticHttpsTransport(options());
  for (const extra of [{ host: '10.231.9.10' }, { origin: 'https://127.0.0.1:8443' }, { transport }])
    await assert.rejects(createLocalApiListener({ services: services(), ...extra }), TypeError);
  for (const value of [null, {}, Object.create(SyntheticHttpsTransport.prototype)])
    await assert.rejects(createSyntheticHttpsApiListener({ services: services(), transport: value }), TypeError);
  transport.invalidate();
});

check('actual TLS validates its CA and hostname, serves only fixed assets and denies untrusted TLS', async t => {
  const listener = await start(t);
  assert.match(listener.origin, /^https:\/\/127\.0\.0\.1:/);
  assert.deepEqual(Object.keys(listener).sort(), ['close', 'origin', 'transport']);
  const page = await call(listener.origin).result;
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY'); assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.doesNotMatch(page.text, /PRIVATE KEY|data-connection-mode="synthetic-private-wifi"/);
  const head = await call(listener.origin, '/', { method: 'HEAD' }).result;
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert(Number(head.headers['content-length']) > 0);
  for (const path of ['/server/synthetic-https-transport.mjs', '/.env', '/cert.pem', '/key.pem', '/local-api/app.js?x=1'])
    assert.equal((await call(listener.origin, path).result).status, 404);
  const untrusted = await call(listener.origin, '/', { ca: [] }).result;
  assert.equal(untrusted.status, null); assert.match(untrusted.code, /SELF_SIGNED|VERIFY/);
  const wrongName = await call(listener.origin, '/', { tls: { servername: 'wrong.tls.test' } }).result;
  assert.equal(wrongName.status, null); assert.equal(wrongName.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const oldTls = await call(listener.origin, '/', { tls: { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' } }).result;
  assert.equal(oldTls.status, null);
});

check('HTTPS preserves authentication, expected-account, role and logout rules with Secure cookies', async t => {
  let logouts = 0;
  const selected = services(); selected.auth.logout = async () => { logouts++; };
  const listener = await start(t, selected), cookie = await login(listener);
  assert.equal((await call(listener.origin, '/api/local/auth/session').result).status, 401);
  const session = await call(listener.origin, '/api/local/auth/session', { headers: { Cookie: cookie } }).result;
  assert.equal(session.status, 200); assert.equal(JSON.parse(session.text).user.centers[0].role, 'guardian');
  const inbox = `/api/local/centers/${centerId}/inbox`;
  assert.equal((await call(listener.origin, inbox, { headers: { Cookie: cookie } }).result).status, 401);
  assert.equal((await call(listener.origin, inbox, { headers: { Cookie: cookie, 'X-Carebridge-Account': 'other-user' } }).result).status, 401);
  assert.equal((await call(listener.origin, inbox, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } }).result).status, 200);
  const logout = await call(listener.origin, '/api/local/auth/logout', { method: 'POST', body: '{}',
    headers: { ...postHeaders(listener.origin), Cookie: cookie } }).result;
  assert.equal(logout.status, 204); assert.equal(logouts, 1);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure$/);
});

check('wrong host, cross-site, forwarded, duplicate and missing-CSRF requests fail before authentication', async t => {
  let calls = 0;
  const selected = services(); selected.auth.login = async () => { calls++; assert.fail('Denied request reached auth'); };
  const listener = await start(t, selected), expected = new URL(listener.origin).host;
  for (const headers of [{ Host: 'untrusted.test' }, { Origin: 'null' }, { Origin: 'https://127.0.0.1:1' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' },
    { Forwarded: 'for=127.0.0.1' }, { 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-For': '127.0.0.1' },
    ['Host', expected, 'Origin', listener.origin, 'Origin', listener.origin],
    ['Host', expected, 'Cookie', 'a=1', 'Cookie', 'b=2'],
    ['Host', expected, 'Range', 'bytes=0-1', 'Range', 'bytes=2-3'],
  ]) assert.equal((await call(listener.origin, '/api/local/auth/session', { headers }).result).status, 403);
  assert.equal((await call(listener.origin, '/', { tls: { localAddress: '127.0.0.2' } }).result).status, 403);
  for (const headers of [{}, { Origin: listener.origin }, { 'X-Carebridge-Request': '1' },
    { ...postHeaders(listener.origin), 'Sec-Fetch-Site': 'none' }]) {
    assert.equal((await call(listener.origin, '/api/local/auth/login', { method: 'POST', headers, body: '{}' }).result).status, 403);
  }
  for (const path of ['//api/local/auth/session', 'https://untrusted.test/api/local/auth/session'])
    assert.equal((await call(listener.origin, path).result).status, 403);
  assert.equal(calls, 0);
});

check('upgrade and CONNECT requests are closed without creating another protocol', async t => {
  const listener = await start(t);
  for (const firstLine of ['GET / HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket', 'CONNECT synthetic.test:443 HTTP/1.1']) {
    await new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(listener.origin).port), ca: material.cert, rejectUnauthorized: true }, () => {
        socket.write(`${firstLine}\r\nHost: ${new URL(listener.origin).host}\r\n\r\n`);
      });
      socket.setTimeout(3000, () => socket.destroy(new Error('Protocol switch was not closed')));
      socket.on('error', reject); socket.on('close', resolve);
      t.after(() => socket.destroy());
    });
  }
});

check('expired or not-yet-valid certificates fail configuration and expiry closes request admission', async t => {
  const certificate = new X509Certificate(material.cert), expires = Date.parse(certificate.validTo), starts = Date.parse(certificate.validFrom);
  const clock = t.mock.method(Date, 'now', () => starts - 1);
  assert.throws(() => new SyntheticHttpsTransport(options()), TypeError);
  clock.mock.mockImplementation(() => expires + 1);
  assert.throws(() => new SyntheticHttpsTransport(options()), TypeError);
  clock.mock.restore();
  const listener = await start(t);
  assert.equal((await call(listener.origin).result).status, 200);
  t.mock.method(Date, 'now', () => expires + 1);
  assert.equal(listener.transport.active, false);
  assert.equal((await call(listener.origin).result).status, 403);
});

check('transport reuse or failed binding cannot close another active owner', async t => {
  const listener = await start(t);
  await assert.rejects(createSyntheticHttpsApiListener({ services: services(), transport: listener.transport }), TypeError);
  assert.equal(listener.transport.active, true); assert.equal((await call(listener.origin).result).status, 200);
  const rejected = new SyntheticHttpsTransport(options());
  await assert.rejects(createSyntheticHttpsApiListener({ services: services(), port: Number(new URL(listener.origin).port), transport: rejected }), { code: 'EADDRINUSE' });
  assert.equal(rejected.active, false); assert.equal((await call(listener.origin).result).status, 200);
  await listener.close(); assert.equal(listener.transport.active, false);
  assert.equal((await call(listener.origin).result).status, null);
});

check('shutdown destroys a TCP connection that has not completed its TLS handshake', async t => {
  const listener = await start(t);
  const socket = connectTcp({ host: '127.0.0.1', port: Number(new URL(listener.origin).port) });
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  const closing = listener.close();
  await Promise.all([closed, closing]);
  assert.equal(listener.transport.active, false); assert.equal(socket.destroyed, true);
});

check('TLS does not rewrite upload bodies or add partial-file media delivery', async t => {
  let received = null, reads = 0;
  const selected = services();
  selected.mediaCleanup = async () => {};
  selected.mediaUploads = {
    async get() { return { id: uploadId, size: bytes.length }; },
    async receive(identity, input, source) {
      assert.equal(identity.userId, userId); assert.equal(input.expectedVersion, 1);
      const chunks = []; for await (const chunk of source) chunks.push(chunk);
      received = Buffer.concat(chunks); return { id: uploadId, size: bytes.length };
    },
  };
  const uploadListener = await start(t, selected, { screen: 'api-only' });
  const uploadCookie = await login(uploadListener);
  const result = await call(uploadListener.origin, uploadPath, { method: 'POST', body: bytes,
    headers: { ...postHeaders(uploadListener.origin), Cookie: uploadCookie, 'X-Carebridge-Account': userId,
      'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Carebridge-Upload-Version': '1' } }).result;
  assert.equal(result.status, 200); assert.deepEqual(received, bytes);
  const mediaAccess = access(async () => { reads++; return opened(); });
  const listener = await start(t, { ...services(), mediaAccess }, { screen: 'prepared' });
  assert.match((await call(listener.origin).result).text, /data-media-mode="prepared-delivery"/);
  assert.equal((await call(listener.origin, contentPath).result).status, 401); assert.equal(reads, 0);
  const cookie = await login(listener);
  const content = await call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId, Range: 'bytes=0-1' } }).result;
  assert.equal(content.status, 200); assert.deepEqual(content.bytes, bytes);
  assert.equal(content.headers['accept-ranges'], 'none'); assert.equal(reads, 1);
});

check('HTTPS refuses reused media lifetimes in both directions without draining the other owner', async t => {
  const mediaAccess = access(async () => opened());
  const selected = { ...services(), mediaAccess };
  const listener = await start(t, selected, { screen: 'api-only' });
  await assert.rejects(createLocalApiListener({ services: selected, screen: 'api-only' }), /exclusive media lifetime/);
  const otherTransport = new SyntheticHttpsTransport(options());
  await assert.rejects(createSyntheticHttpsApiListener({ services: selected, transport: otherTransport, screen: 'api-only' }), /exclusive media lifetime/);
  otherTransport.invalidate();
  const cookie = await login(listener);
  assert.equal((await call(listener.origin, contentPath, { headers: { Cookie: cookie, 'X-Carebridge-Account': userId } }).result).status, 200);
  await listener.close();
  await assert.rejects(createLocalApiListener({ services: selected, screen: 'api-only' }), /exclusive media lifetime/);
  const httpSelected = { ...services(), mediaAccess: access(async () => opened()) };
  const http = await createLocalApiListener({ services: httpSelected, screen: 'api-only' }); t.after(() => http.close());
  const blocked = new SyntheticHttpsTransport(options());
  await assert.rejects(createSyntheticHttpsApiListener({ services: httpSelected, transport: blocked, screen: 'api-only' }), /exclusive media lifetime/);
  blocked.invalidate();
});

check('a failed HTTP bind cannot erase another concurrent HTTP media owner', async t => {
  const occupied = await createLocalApiListener({ services: services(), screen: 'api-only' }); t.after(() => occupied.close());
  const selected = { ...services(), mediaAccess: access(async () => opened()) };
  const failed = createLocalApiListener({ services: selected, screen: 'api-only', port: Number(new URL(occupied.origin).port) });
  const succeeding = createLocalApiListener({ services: selected, screen: 'api-only' });
  const outcomes = await Promise.allSettled([failed, succeeding]);
  assert.equal(outcomes[0].status, 'rejected'); assert.equal(outcomes[0].reason.code, 'EADDRINUSE');
  assert.equal(outcomes[1].status, 'fulfilled'); t.after(() => outcomes[1].value.close());
  const transport = new SyntheticHttpsTransport(options());
  await assert.rejects(createSyntheticHttpsApiListener({ services: selected, transport, screen: 'api-only' }), /exclusive media lifetime/);
  transport.invalidate();
});

check('HTTPS shutdown waits for handler and late stream disposal, not just a closed socket', async t => {
  const entered = deferred(), release = deferred(), selected = services();
  selected.auth.authenticate = async () => { entered.resolve(); await release.promise; return user(); };
  const listener = await start(t, selected), cookie = await login(listener);
  t.after(() => release.resolve());
  const pending = call(listener.origin, '/api/local/auth/session', { headers: { Cookie: cookie } });
  await until(() => entered.settled);
  let closed = false;
  const first = listener.close(); assert.equal(listener.close(), first); first.then(() => { closed = true; });
  await nextTurn(); assert.equal(closed, false); assert.equal(listener.transport.active, false);
  release.resolve(); await first; assert.equal((await pending.result).aborted, true);
  const opening = deferred(), mediaEntered = deferred(), destroying = deferred(), destroyed = deferred();
  const mediaAccess = access(async () => { mediaEntered.resolve(); return opening.promise; });
  const mediaListener = await start(t, { ...services(), mediaAccess }, { screen: 'api-only' });
  t.after(() => { opening.resolve(opened()); destroying.resolve(); });
  const mediaCookie = await login(mediaListener);
  const mediaRequest = call(mediaListener.origin, contentPath, { headers: { Cookie: mediaCookie, 'X-Carebridge-Account': userId } });
  await until(() => mediaEntered.settled); mediaRequest.request.destroy(); await mediaRequest.result;
  let drained = false; const draining = mediaListener.close().then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false);
  const stream = new Readable({ read() {}, destroy(_error, callback) { destroyed.resolve(); destroying.promise.then(() => callback()); } });
  opening.resolve(opened(stream)); await until(() => destroyed.settled);
  assert.equal(drained, false); assert.equal(stream.closed, false);
  destroying.resolve(); await draining; assert.equal(stream.closed, true);
});
