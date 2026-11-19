import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createWebChatHandler, WEB_CHAT_COOKIE } from '../server/web-chat-http.mjs';
import { readWebChatConfig, createWebChatRuntime, readWebChatDatabaseCa } from '../server/web-chat-runtime.mjs';
import { Auth, AuthError } from '../server/auth.mjs';
import { Conversations } from '../server/conversations.mjs';
import { Children } from '../server/profiles.mjs';
import { migrate } from '../server/migrate.mjs';
import { WEB_CHAT_MEDIA_MAX_BYTES } from '../src/shared-chat-media-policy.js';
import { RepositoryError } from '../server/errors.mjs';

const origin = 'https://carebridge.example';
const env = { CAREBRIDGE_WEB_CHAT_ENABLED: 'true', CAREBRIDGE_CHAT_CENTER_ID: 'synthetic-center',
  CAREBRIDGE_CHAT_DATABASE_URL: 'postgresql://synthetic:test-password@db.example:6543/postgres?sslmode=require',
  CAREBRIDGE_WEB_ORIGINS: origin, VERCEL_URL: 'carebridge-synthetic.vercel.app' };
const user = () => ({ userId: 'synthetic-therapist', email: 'therapist@synthetic.invalid',
  centers: [{ id: env.CAREBRIDGE_CHAT_CENTER_ID, role: 'therapist' }], expiresAt: new Date(Date.now() + 3600000).toISOString() });
const token = 't'.repeat(43);
function request(path = '/session', { method = 'GET', body, headers = {}, session = token, expected = 'synthetic-therapist', urlOrigin = origin } = {}) {
  return new Request(urlOrigin + '/api/chat' + path, { method,
    headers: { ...(method !== 'GET' ? { Origin: urlOrigin, 'X-Carebridge-Chat': '1', 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: WEB_CHAT_COOKIE + '=' + session } : {}),
      ...(expected ? { 'X-Carebridge-Chat-User': expected } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
function fixture(overrides = {}) {
  const calls = [];
  const services = { auth: {
    authenticate: async value => { calls.push(['authenticate', value]); return value === token ? user() : null; },
    login: async () => { calls.push(['login']); return { token, user: user() }; },
    logout: async () => { calls.push(['logout']); return true; },
  }, conversations: {
    inbox: async identity => { calls.push(['inbox', identity]); return { rooms: [], snapshot: 'a'.repeat(32), resetRequired: false, nextOffset: 0, hasMore: false }; },
    list: async (identity, input) => { calls.push(['list', identity, input]); return { messages: [], revision: 1, lastRead: 0, unread: 0, nextCursor: 0, hasMore: false }; },
    sendText: async (identity, input) => { calls.push(['send', identity, input]); return { id: 'message-one', conversationId: input.conversationId,
      childId: 'synthetic-child', sequence: 1, authorId: identity.userId, createdAt: new Date().toISOString(), type: 'text', body: input.body,
      reviewNote: 'PRIVATE_NEVER_RETURN', privateNote: 'PRIVATE_NEVER_RETURN', token: 'SECRET_NEVER_RETURN' }; },
    markRead: async () => ({ lastRead: 1 }),
  }, profiles: { get: async () => ({ name: '가상 아동', participants: [] }) }, ...overrides };
  return { calls, services, handle: createWebChatHandler({ env, getServices: async () => services }) };
}
async function errorCode(response) { return (await response.json()).error?.code; }

function mediaFixture() {
  const f = fixture(), attachment = { id: 'upload-one', type: 'image/png', name: 'carebridge-photo.png',
    size: 3, width: 20, height: 20, privateStorageKey: 'PRIVATE_NEVER_RETURN', bytes: Buffer.from([1, 2, 3]) };
  f.services.conversations.inRoom = async (identity, roomId, work) => { f.calls.push(['authorize-upload-room', identity, roomId]); return work(); };
  f.services.media = {
    upload: async (identity, input) => { f.calls.push(['upload', identity, input]); return attachment; },
    content: async (identity, input) => { f.calls.push(['content', identity, input]); return attachment; },
    discard: async (identity, input) => { f.calls.push(['discard', identity, input]); },
    decorate: async (_identity, { messages }) => messages.map(message => ({ ...message, webAttachments: [attachment] })),
    send: async (identity, input) => ({ ...(await f.services.conversations.sendText(identity, input)), webAttachments: [attachment] }),
  };
  const binary = (options = {}) => new Request(origin + '/api/chat/rooms/room-one/media?clientId=synthetic-upload-1', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'image/png', 'X-Carebridge-Chat': '1',
      Cookie: WEB_CHAT_COOKIE + '=' + token, 'X-Carebridge-Chat-User': 'synthetic-therapist', ...options.headers },
    body: options.bytes ?? new Uint8Array([1, 2, 3]),
  });
  return { ...f, binary };
}

test('media upload authorizes before reading binary and exposes only attachment metadata', async () => {
  const f = mediaFixture(), response = await f.handle(f.binary());
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { attachment: { id: 'upload-one', name: 'carebridge-photo.png', type: 'image/png', size: 3, width: 20, height: 20 } });
  assert(f.calls.findIndex(call => call[0] === 'authorize-upload-room') < f.calls.findIndex(call => call[0] === 'upload'));
  assert.deepEqual(f.calls.find(call => call[0] === 'upload')[2].bytes, Buffer.from([1, 2, 3]));
  f.services.conversations.inRoom = async () => { throw new RepositoryError('NOT_FOUND'); };
  const before = f.calls.filter(call => call[0] === 'upload').length;
  assert.equal((await f.handle(f.binary())).status, 404);
  assert.equal(f.calls.filter(call => call[0] === 'upload').length, before);
});

test('media boundaries reject anonymous, switched users, cross-origin, encoding, invalid MIME and oversized streams', async () => {
  const f = mediaFixture();
  for (const [headers, expected] of [
    [{ Cookie: '' }, 401], [{ 'X-Carebridge-Chat-User': 'different-account' }, 401],
    [{ Origin: 'https://elsewhere.example' }, 403], [{ 'Content-Encoding': 'gzip' }, 415],
    [{ 'Content-Type': 'image/svg+xml' }, 415], [{ 'Content-Length': String(WEB_CHAT_MEDIA_MAX_BYTES + 1) }, 413],
  ]) assert.equal((await f.handle(f.binary({ headers }))).status, expected);
  assert.equal((await f.handle(f.binary({ bytes: new Uint8Array(WEB_CHAT_MEDIA_MAX_BYTES + 1) }))).status, 413);
  assert.equal((await f.handle(f.binary({ bytes: new Uint8Array(0) }))).status, 400);
  assert.equal(f.calls.filter(call => call[0] === 'upload').length, 0);
});

test('protected media bytes require the same account header and are never cacheable or public', async () => {
  const f = mediaFixture(), path = '/rooms/room-one/media/upload-one';
  for (const options of [{ session: null }, { expected: null }, { expected: 'other-user' }]) {
    assert.equal((await f.handle(request(path, options))).status, 401);
  }
  assert.equal(f.calls.filter(call => call[0] === 'content').length, 0);
  const response = await f.handle(request(path));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), '3');
  for (const key of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) assert(response.headers.get(key).includes('no-store'));
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal((await f.handle(request(path + '?token=not-allowed'))).status, 400);
  assert.equal((await f.handle(request(path, { method: 'DELETE' }))).status, 200);
});

test('attachment-only messages preserve the narrow projection and reject duplicate or over-limit references', async () => {
  const f = mediaFixture(), path = '/rooms/room-one/messages';
  const body = { clientId: randomUUID(), body: '', attachments: [{ id: 'upload-one' }] };
  const response = await f.handle(request(path, { method: 'POST', body }));
  assert.equal(response.status, 201);
  const value = await response.json(); assert.equal(value.message.attachmentCount, 1);
  assert.equal(value.message.attachments[0].width, 20); assert(!JSON.stringify(value).includes('PRIVATE_NEVER_RETURN'));
  for (const attachments of [[{ id: 'upload-one', path: '/private' }], [{ id: 'one' }, { id: 'one' }],
    Array.from({ length: 5 }, (_, i) => ({ id: 'upload-' + i }))]) {
    assert.equal((await f.handle(request(path, { method: 'POST', body: { ...body, attachments } }))).status, 400);
  }
});

test('web chat configuration requires a dedicated HTTPS origin and verified TLS database settings', () => {
  const config = readWebChatConfig(env);
  assert.equal(config.connectionString, 'postgresql://synthetic:test-password@db.example:6543/postgres');
  assert(config.origins.has(origin)); assert(config.origins.has('https://carebridge-synthetic.vercel.app'));
  for (const change of [{ CAREBRIDGE_WEB_CHAT_ENABLED: 'false' }, { CAREBRIDGE_CHAT_CENTER_ID: '' },
    { CAREBRIDGE_WEB_ORIGINS: 'http://carebridge.example' }, { CAREBRIDGE_WEB_ORIGINS: origin + '/' },
    { CAREBRIDGE_CHAT_DATABASE_URL: 'postgresql://u:p@127.0.0.1/postgres' },
    { CAREBRIDGE_CHAT_DATABASE_URL: 'postgresql://u:p@db.example/postgres?sslmode=disable' },
    { CAREBRIDGE_CHAT_DATABASE_URL: 'postgresql://u:p@db.example/postgres?sslrootcert=other' },
    { VERCEL_URL: 'attacker.example' }]) assert.throws(() => readWebChatConfig({ ...env, ...change }), /CHAT_UNAVAILABLE/);
});

test('runtime reuses service instances without recreating accounts, schema or a memory database', async () => {
  const options = [];
  const runtime = createWebChatRuntime({ env, databaseFactory: value => {
    options.push(value); return { transaction: async () => { assert.fail('No query during runtime construction'); } };
  } });
  const [first, second] = await Promise.all([runtime.services(), runtime.services()]);
  assert.equal(first, second); assert.equal(options.length, 1); assert.equal(options[0].max, 2);
  assert.deepEqual(options[0].ssl, { rejectUnauthorized: true });
  assert.equal(options[0].idleTimeoutMillis, 10000); assert.equal(first.auth.sessionTtlSeconds, 3600);
});

test('optional pool CA must be a bounded, currently valid X509 CA and never weakens TLS verification', async () => {
  const publicCa = rootCertificates.find(value => {
    const certificate = new X509Certificate(value), now = Date.now();
    return certificate.ca && Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now;
  });
  assert(publicCa);
  const certificate = new X509Certificate(publicCa);
  assert.equal(readWebChatDatabaseCa(undefined), undefined);
  assert.equal(new X509Certificate(readWebChatDatabaseCa(publicCa)).fingerprint256, certificate.fingerprint256);
  for (const invalid of ['', 'not-a-certificate', 'x'.repeat(16 * 1024 + 1), publicCa + '\n' + publicCa,
    '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----']) {
    assert.throws(() => readWebChatDatabaseCa(invalid), /CHAT_UNAVAILABLE/);
  }
  assert.throws(() => readWebChatDatabaseCa(publicCa, Date.parse(certificate.validFrom) - 1), /CHAT_UNAVAILABLE/);
  assert.throws(() => readWebChatDatabaseCa(publicCa, Date.parse(certificate.validTo)), /CHAT_UNAVAILABLE/);
  let options;
  const runtime = createWebChatRuntime({ env: { ...env, CAREBRIDGE_CHAT_DATABASE_CA: publicCa }, databaseFactory: value => {
    options = value; return { transaction: async () => assert.fail('No startup query') };
  } });
  await runtime.services();
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new X509Certificate(options.ssl.ca).fingerprint256, certificate.fingerprint256);
  assert(!options.connectionString.includes('sslmode'));
});

test('disabled chat and rejected origins never create a database connection', async () => {
  const handle = createWebChatHandler({ env: { ...env, CAREBRIDGE_WEB_CHAT_ENABLED: 'false' }, getServices: () => assert.fail('connected') });
  assert.deepEqual(await (await handle(request('/session', { session: null }))).json(), { enabled: false, authenticated: false, user: null });
  assert.equal((await handle(request('/rooms'))).status, 503);
  const active = createWebChatHandler({ env, getServices: () => assert.fail('connected') });
  for (const req of [request('/rooms', { urlOrigin: 'https://attacker.example' }),
    request('/rooms', { headers: { Origin: 'https://attacker.example' } }),
    request('/session', { method: 'DELETE', headers: { 'X-Carebridge-Chat': '0' } }),
    request('/session', { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'same-site' } })]) {
    const result = await active(req); assert.equal(result.status, 403); assert.equal(await errorCode(result), 'CROSS_ORIGIN_DENIED');
  }
});

test('login issues only a one-hour HttpOnly secure cookie and excludes credentials from JSON', async () => {
  const f = fixture();
  const response = await f.handle(request('/session', { method: 'POST', session: null, expected: null,
    body: { email: 'therapist@synthetic.invalid', password: 'synthetic-password', syntheticConfirmed: true } }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert(cookie.startsWith(WEB_CHAT_COOKIE + '=')); assert(cookie.includes('Path=/api/chat;'));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert(cookie.includes(part));
  assert(Number(/Max-Age=(\d+)/.exec(cookie)[1]) <= 3600);
  assert(response.headers.get('cache-control').includes('no-store'));
  const body = await response.json(); assert.equal(body.user.role, 'therapist');
  assert.equal(body.authenticated, true); assert(!JSON.stringify(body).includes('synthetic-password')); assert(!JSON.stringify(body).includes(token));
});

test('unknown membership cannot log in, existing sessions cannot be silently replaced', async () => {
  const f = fixture(); const input = { email: 'someone@synthetic.invalid', password: 'synthetic-password', syntheticConfirmed: true };
  assert.equal((await f.handle(request('/session', { method: 'POST', body: input }))).status, 409);
  f.services.auth.login = async () => ({ token, user: { ...user(), centers: [{ id: 'other-center', role: 'therapist' }] } });
  const denied = await f.handle(request('/session', { method: 'POST', body: input, session: null, expected: null }));
  assert.equal(denied.status, 401); assert.equal(await errorCode(denied), 'AUTH_INVALID'); assert(f.calls.some(c => c[0] === 'logout'));
});

test('revoked membership cannot access chat but does not trap the account in an unusable cookie', async () => {
  const f = fixture();
  f.services.auth.authenticate = async () => ({ ...user(), centers: [] });
  assert.equal((await f.handle(request('/rooms'))).status, 401);
  assert.equal((await f.handle(request('/session', { method: 'DELETE' }))).status, 200);
  const response = await f.handle(request('/session', { method: 'POST', body: {
    email: 'therapist@synthetic.invalid', password: 'synthetic-password', syntheticConfirmed: true,
  } }));
  assert.equal(response.status, 200); assert.equal(f.calls.filter(call => call[0] === 'logout').length, 2);
});

test('anonymous, duplicate cookies, expected-account swaps and caller-selected identities are rejected before messaging', async () => {
  const f = fixture();
  for (const req of [request('/rooms', { session: null }), request('/rooms', { expected: null }),
    request('/rooms', { expected: 'synthetic-guardian' }),
    request('/rooms', { headers: { Cookie: `${WEB_CHAT_COOKIE}=${token}; ${WEB_CHAT_COOKIE}=${token}` } })]) {
    const response = await f.handle(req); assert.equal(response.status, 401);
  }
  const response = await f.handle(request('/rooms/room-one/messages', { method: 'POST',
    body: { clientId: randomUUID(), body: '가상 소식', userId: 'someone-else' } }));
  assert.equal(response.status, 400); assert(!f.calls.some(call => ['inbox', 'send'].includes(call[0])));
});

test('text sending derives identity from session and only returns the reviewed message projection', async () => {
  const f = fixture(); const clientId = randomUUID();
  const response = await f.handle(request('/rooms/room-one/messages', { method: 'POST', body: { clientId, body: '가상 소식' } }));
  assert.equal(response.status, 201); const value = await response.json(); assert.equal(value.message.body, '가상 소식');
  assert(!JSON.stringify(value).includes('NEVER_RETURN'));
  assert.deepEqual(f.calls.find(call => call[0] === 'send').slice(1),
    [{ userId: 'synthetic-therapist', centerId: env.CAREBRIDGE_CHAT_CENTER_ID }, { conversationId: 'room-one', clientId, body: '가상 소식' }]);
});

test('query/body boundaries reject oversized, extra, duplicate and malformed input without a write', async () => {
  const f = fixture();
  for (const req of [request('/rooms/room-one/messages?after=0&after=1'), request('/rooms?centerId=other'),
    request('/rooms/room-one/messages?view=private'),
    request('/rooms/room-one/messages', { method: 'POST', body: { clientId: randomUUID(), body: 'x'.repeat(2001) } }),
    request('/rooms/room-one/messages', { method: 'POST', body: { clientId: randomUUID(), body: 'text\u0000' } }),
    request('/rooms/room-one/messages', { method: 'POST', body: 'x'.repeat(25000) }),
    request('/rooms/room-one/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }),
    request('/rooms/room-one/read', { method: 'POST', body: { messageId: '../../other' } })]) {
    assert.equal((await f.handle(req)).status, 400);
  }
  assert(!f.calls.some(call => call[0] === 'send'));
});

test('session and logout do not expose unknown backend failures or erase another tab session', async () => {
  const f = fixture();
  assert.equal((await f.handle(request('/session', { method: 'DELETE', expected: 'other-user' }))).status, 401);
  assert(!f.calls.some(call => call[0] === 'logout'));
  const response = await f.handle(request('/session', { method: 'DELETE' }));
  assert.equal(response.status, 200); assert(response.headers.get('set-cookie').includes('Max-Age=0'));
  const stale = await f.handle(request('/session', { method: 'DELETE', session: 's'.repeat(43) }));
  assert.equal(stale.status, 200); assert.equal(stale.headers.get('set-cookie'), null);
  f.services.auth.authenticate = async () => { throw new Error('postgresql://PRIVATE_PASSWORD@host.example/private'); };
  const error = await f.handle(request('/rooms')); assert.equal(error.status, 503);
  assert.deepEqual(await error.json(), { error: { code: 'CHAT_UNAVAILABLE' } });
});

function streamedLogout(stream, { headers = {}, signal, session = token, expected = 'synthetic-therapist' } = {}) {
  const base = request('/session', { method: 'DELETE', headers, session, expected });
  return new Request(base.url, { method: base.method, headers: base.headers, body: stream, duplex: 'half', signal });
}

test('logout accepts Vercel empty DELETE streams with or without Content-Length while retaining cookie rules', async () => {
  for (const headers of [{}, { 'Content-Length': '0' }]) {
    const f = fixture();
    const empty = () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(0)); controller.close(); } });
    const response = await f.handle(streamedLogout(empty(), { headers }));
    assert.equal(response.status, 200);
    assert(response.headers.get('set-cookie').includes('Max-Age=0'));
    assert.equal(f.calls.filter(call => call[0] === 'logout').length, 1);
    const anonymous = await f.handle(streamedLogout(empty(), { headers, session: null, expected: null }));
    assert.equal(anonymous.status, 200); assert.equal(anonymous.headers.get('set-cookie'), null);
    const stale = await f.handle(streamedLogout(empty(), { headers, session: 's'.repeat(43) }));
    assert.equal(stale.status, 200); assert.equal(stale.headers.get('set-cookie'), null);
    const swapped = await f.handle(streamedLogout(empty(), { headers, expected: 'another-user' }));
    assert.equal(swapped.status, 401);
    assert.equal(f.calls.filter(call => call[0] === 'logout').length, 1);
  }
});

test('logout rejects actual bytes, positive or malformed lengths, failed and aborted streams before authentication', async () => {
  const cases = [
    () => streamedLogout(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([32])); controller.close(); } })),
    () => streamedLogout(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([32])); controller.close(); } }), { headers: { 'Content-Length': '0' } }),
    () => streamedLogout(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'Content-Length': '1' } }),
    () => streamedLogout(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'Content-Length': 'unknown' } }),
    () => streamedLogout(new ReadableStream({ start(controller) { controller.error(new Error('synthetic stream failure')); } })),
    () => streamedLogout(new ReadableStream({ start(controller) { controller.close(); } }), { signal: AbortSignal.abort() }),
  ];
  for (const create of cases) {
    const f = fixture(), response = await f.handle(create());
    assert.equal(response.status, 400); assert.equal(await errorCode(response), 'INVALID_INPUT');
    assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(f.calls, []);
  }
  const f = fixture(), controller = new AbortController(); let cancelled = false;
  const pending = f.handle(streamedLogout(new ReadableStream({ cancel() { cancelled = true; } }), { signal: controller.signal }));
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.status, 400); assert.equal(await errorCode(aborted), 'INVALID_INPUT');
  assert.equal(cancelled, true); assert.deepEqual(f.calls, []);
});

test('logout cancels a DELETE stream that does not finish within the five-second deadline', { timeout: 7000 }, async () => {
  const f = fixture(); let cancelled = false;
  const response = await f.handle(streamedLogout(new ReadableStream({ cancel() { cancelled = true; } })));
  assert.equal(response.status, 400); assert.equal(await errorCode(response), 'INVALID_INPUT');
  assert.equal(cancelled, true); assert.deepEqual(f.calls, []);
});

let PGlite;
try {
  const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
  ({ PGlite } = await import(pathToFileURL(serverRequire.resolve('@electric-sql/pglite')).href));
} catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('real SQL sessions and messages survive handler replacement with two identities, idempotency and room isolation',
  { skip: PGlite ? false : 'Local optional server PGlite dependency is not installed.' }, async () => {
    const database = await PGlite.create();
    try {
      await migrate(database);
      const centerId = env.CAREBRIDGE_CHAT_CENTER_ID;
      await database.exec(`INSERT INTO cb_centers(id) VALUES ('${centerId}'),('other-center');
        INSERT INTO cb_users(id,active) VALUES ('synthetic-therapist',true),('synthetic-guardian',true),('synthetic-outsider',true);
        INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
          ('${centerId}','synthetic-therapist','therapist',true),('${centerId}','synthetic-guardian','guardian',true),
          ('other-center','synthetic-outsider','therapist',true);
        INSERT INTO cb_children(center_id,id) VALUES ('${centerId}','child-one'),('other-center','other-child');
        INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('${centerId}','room-one','child-one'),('other-center','other-room','other-child');
        INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
          ('${centerId}','room-one','synthetic-therapist','therapist',true,1),('${centerId}','room-one','synthetic-guardian','guardian',true,1),
          ('other-center','other-room','synthetic-outsider','therapist',true,1);`);
      const password = randomBytes(24).toString('base64url');
      const auth = new Auth(database, { sessionTtlSeconds: 3600 });
      await auth.provisionAccount({ userId: 'synthetic-therapist', email: 'therapist@synthetic.invalid', password });
      await auth.provisionAccount({ userId: 'synthetic-guardian', email: 'guardian@synthetic.invalid', password });
      const create = () => createWebChatHandler({ env, getServices: async () => ({ auth: new Auth(database, { sessionTtlSeconds: 3600 }),
        conversations: new Conversations(database), profiles: new Children(database) }) });
      let handle = create();
      const login = async email => {
        const r = await handle(request('/session', { method: 'POST', session: null, expected: null, body: { email, password, syntheticConfirmed: true } }));
        assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0].slice(WEB_CHAT_COOKIE.length + 1);
      };
      const therapistToken = await login('therapist@synthetic.invalid'), guardianToken = await login('guardian@synthetic.invalid');
      assert.notEqual(therapistToken, guardianToken);
      const stored = await database.query('SELECT token_hash FROM cb_auth_sessions');
      assert(stored.rows.some(row => row.token_hash === createHash('sha256').update(therapistToken).digest('hex')));
      const clientId = randomUUID(), body = { clientId, body: '가상 치료사 소식' };
      const send = () => handle(request('/rooms/room-one/messages', { method: 'POST', session: therapistToken, body }));
      const first = await send(); assert.equal(first.status, 201); const message = (await first.json()).message;
      handle = create(); // New HTTP/services instance, same persistent DB.
      const second = await send(); assert.equal(second.status, 201); assert.equal((await second.json()).message.id, message.id);
      const conflict = await handle(request('/rooms/room-one/messages', { method: 'POST', session: therapistToken, body: { ...body, body: '다른 내용' } }));
      assert.equal(conflict.status, 409); assert.equal(await errorCode(conflict), 'IDEMPOTENCY_CONFLICT');
      const guardianOptions = { session: guardianToken, expected: 'synthetic-guardian' };
      const read = await handle(request('/rooms/room-one/messages?after=0', guardianOptions)); assert.equal(read.status, 200);
      const page = await read.json(); assert.equal(page.messages.length, 1); assert.equal(page.messages[0].body, body.body);
      const reply = await handle(request('/rooms/room-one/messages', { ...guardianOptions, method: 'POST', body: { clientId: randomUUID(), body: '가상 보호자 답장' } }));
      assert.equal(reply.status, 201);
      const sorted = await (await handle(request('/rooms/room-one/messages?after=0', { session: therapistToken }))).json();
      assert.deepEqual(sorted.messages.map(value => value.sequence), [1, 2]);
      assert.equal((await handle(request('/rooms/other-room/messages', guardianOptions))).status, 404);
      const rooms = await (await handle(request('/rooms', guardianOptions))).json();
      assert.deepEqual(rooms.rooms.map(value => value.conversationId), ['room-one']);
      const marked = await handle(request('/rooms/room-one/read', { ...guardianOptions, method: 'POST', body: { messageId: message.id } }));
      assert.equal(marked.status, 200);
      await handle(request('/session', { ...guardianOptions, method: 'DELETE' }));
      handle = create();
      assert.equal((await handle(request('/rooms/room-one/messages', guardianOptions))).status, 401);
      assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM cb_messages')).rows[0].count), 2);
    } finally { await database.close(); }
  });
