import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { Records } from '../records.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { MediaPreparation } from '../media-preparation.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { MediaAccess } from '../media-access.mjs';
import { PrivateFileStore } from '../private-file-store.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { syntheticPng, addPrivateMetadata, PRIVATE_MARKER } from '../image-metadata-test-fixtures.mjs';
import { fakeClam, fakePreparation } from './media-preparation-fixtures.mjs';
import { LocalApiClient } from '../../local-api/client.js';
import { MediaApiClient, mediaFileManifest } from '../../local-api/media-client.js';

// Real localhost HTTP/Auth/PGlite/private files and the MediaPreparation domain
// path. fakeClam and fakePreparation are EXPLICIT inspection/decoder doubles:
// this proves delivery contracts, NOT native AV, decoder or operating readiness.
// No ready/evidence SQL injection, environment database, E drive or public server.
const original = addPrivateMetadata(syntheticPng(), 'image/png');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const file = { name: '가상 비공개 사진.png', type: 'image/png', size: original.length, sha256: hash(original) };
const source = { name: file.name, type: file.type, size: file.size };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a';
const uploadPath = (id = '') => `${room}/uploads${id ? `/${id}` : ''}`;
const messagePath = (id) => `${room}/messages/${id}`;
const contentPath = (message, upload) => `${messagePath(message.id)}/attachments/${upload.id}/content`;
const password = 'Synthetic delivery fixture only 2026!';
const uploadKeys = ['id', 'conversationId', 'name', 'type', 'size', 'state', 'version', 'failureCode', 'expiresAt', 'expired'];
let db, auth, chat, store, uploads, clam, job, server, options, origin, sessions, root, rootIdentity;

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  sessions = new Map();
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('therapist-a',true),('manager-a',true),
      ('peer-a',true),('stranger-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','therapist-a','therapist',true),
      ('center-a','manager-a','center',true),('center-a','peer-a','guardian',true),('center-a','stranger-a','guardian',true),
      ('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','peer-a','guardian',true,1),('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-other','guardian-a','guardian',true,1),('center-a','room-other','therapist-a','therapist',true,1),
      ('center-b','room-b','foreign-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','합성 목표','active');`);
  await configureSyntheticMediaPolicy(db, 'center-a');
  // Reduced scrypt cost is test-only; authentication/session code is unchanged.
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of ['guardian-a', 'therapist-a', 'manager-a', 'peer-a', 'stranger-a', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@delivery.test`, password });
  root = resolve(await mkdtemp(join(tmpdir(), 'carebridge-delivery-test-')));
  rootIdentity = await lstat(root, { bigint: true });
  store = new PrivateFileStore(root);
  clam = await fakeClam(); job = fakePreparation();
  uploads = new MediaUploads(db, store, { preparation: new MediaPreparation({ scanner: clam.scanner, preparer: job.preparer }) });
  chat = new Conversations(db);
  server = createServer(async (req, res) => {
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles: new Children(db), records: new Records(db), feedback: new ActivityFeedback(db), origin,
    cookieName: `cb_local_${randomBytes(16).toString('hex')}`, mediaUploads: uploads,
    mediaAccess: new MediaAccess(db, store), mediaCleanup: () => uploads.cleanup() };
});
afterEach(async () => {
  // Stop owned HTTP and inspection resources before touching their exact files.
  if (server) { server.closeAllConnections(); await new Promise((yes) => server.close(yes)); server = null; }
  await clam?.close(); clam = null;
  assert.equal(job?.containers.size ?? 0, 0, 'Synthetic decoder resources must be released.');
  if (!root) return;
  const identity = await lstat(root, { bigint: true });
  assert.equal(dirname(root), resolve(tmpdir())); assert(basename(root).startsWith('carebridge-delivery-test-'));
  assert.equal(resolve(await realpath(root)), root); assert(identity.isDirectory() && !identity.isSymbolicLink());
  assert.equal(identity.dev, rootIdentity.dev); assert.equal(identity.ino, rootIdentity.ino);
  const knownKeys = new Set((await db.query('SELECT key FROM cb_media_objects')).rows.map((row) => row.key));
  const names = await readdir(root);
  // Preflight ALL entries; unknown files, links or nested directories are
  // retained and fail teardown. No recursive delete or ownership guess.
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.(blob|blocked)$/.exec(name);
    assert(match && knownKeys.has(match[1]), 'Unknown private-store entry must be retained.');
    const entry = await lstat(join(root, name)); assert(entry.isFile() && !entry.isSymbolicLink());
  }
  for (const name of names) await unlink(join(root, name));
  await rmdir(root); root = null;
});

function call(path, { cookie, method = 'GET', body, bytes, headers = {} } = {}) {
  const outgoing = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1',
    'Content-Type': bytes ? 'application/octet-stream' : 'application/json' } : {}),
  ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': sessions.get(cookie) } : {}),
  ...(bytes ? { 'Content-Length': String(bytes.length) } : {}), ...headers };
  for (const key of Object.keys(outgoing)) if (outgoing[key] === undefined) delete outgoing[key];
  return new Promise((yes, no) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: outgoing, agent: false }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.once('error', no);
      res.on('end', () => {
        const buffer = Buffer.concat(chunks), text = buffer.toString('utf8');
        const json = res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null;
        yes({ status: res.statusCode, headers: res.headers, buffer, text, json });
      });
    });
    req.once('error', no); req.setTimeout(8000, () => req.destroy(new Error('Synthetic delivery request timed out.')));
    req.end(bytes ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
const post = (path, cookie, body, headers) => call(path, { method: 'POST', cookie, body, headers });
function good(result, status = 200) { assert.equal(result.status, status, result.json?.error); return result.json; }
function denied(result, status = 404, code = 'NOT_FOUND') {
  assert.equal(result.status, status); assert.equal(result.json?.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  noPrivateData(result.json);
}
function noPrivateData(value) {
  const text = JSON.stringify(value);
  for (const secret of [PRIVATE_MARKER, root, 'sha256', 'object_key', 'candidate_key', 'preparation_id', 'evidence', 'file://'])
    assert.equal(text.includes(secret), false, `Public response contains private field ${secret === root ? 'root' : secret}.`);
}
function transfer(result, state, replayed) {
  const value = good(result); assert.deepEqual(Object.keys(value).sort(), ['mode', 'source', 'upload']);
  assert.equal(value.mode, 'prepared-delivery'); assert.deepEqual(value.source, source);
  assert.deepEqual(Object.keys(value.upload).sort(), [...uploadKeys, ...(replayed === undefined ? [] : ['replayed'])].sort());
  if (replayed !== undefined) assert.equal(value.upload.replayed, replayed);
  assert.equal(value.upload.state, state); noPrivateData(value); return value.upload;
}
async function login(userId = 'guardian-a') {
  const response = await post('/api/local/auth/login', null, { email: `${userId}@delivery.test`, password }); good(response);
  const cookie = response.headers['set-cookie'][0].split(';')[0]; sessions.set(cookie, userId); return cookie;
}
async function reserve(cookie, clientId = randomUUID()) {
  const upload = transfer(await post(uploadPath(), cookie, { clientId, file }), 'pending', false);
  return { upload, clientId };
}
async function quarantine(cookie) {
  const reserved = await reserve(cookie);
  const response = await call(`${uploadPath(reserved.upload.id)}/content`, { cookie, method: 'POST', bytes: original,
    headers: { 'X-Carebridge-Upload-Version': String(reserved.upload.version) } });
  return { ...reserved, upload: transfer(response, 'quarantined') };
}
async function ready(cookie) {
  const received = await quarantine(cookie);
  const upload = await uploads.inspect({ centerId: 'center-a', userId: sessions.get(cookie) }, { conversationId: 'room-a', uploadId: received.upload.id,
    expectedVersion: received.upload.version });
  assert.equal(upload.state, 'ready');
  return { ...received, upload };
}
const rowFor = async (id) => (await db.query('SELECT * FROM cb_media_uploads WHERE id = $1', [id])).rows[0];
const send = async (cookie, body) => good(await post(`${room}/messages`, cookie,
  { clientId: randomUUID(), body: '합성 일반 소식', ...body }), 201).message;
async function bound(cookie) {
  const result = await ready(cookie);
  const sendInput = { clientId: randomUUID(), body: '', attachments: [{ id: result.upload.id }] };
  const message = await send(cookie, sendInput);
  return { ...result, message, sendInput, row: await rowFor(result.upload.id) };
}
async function changeHistory({ therapistHistory = 'preserve', ownerHistory = 'preserve', removeOwner = false } = {}) {
  const relationships = new Relationships(db), state = await relationships.get(manager, { conversationId: 'room-a' });
  return relationships.replace(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: state.version,
    therapist: { userId: 'therapist-a', history: therapistHistory },
    guardians: [...(removeOwner ? [] : [{ userId: 'guardian-a', history: ownerHistory }]), { userId: 'peer-a', history: 'preserve' }],
    historyConfirmed: true });
}

test('transformed ready state and reserve replay retain immutable original transfer metadata', async () => {
  const g = await login(), result = await ready(g), row = await rowFor(result.upload.id);
  const candidate = await readFile(join(root, `${row.candidate_key}.blob`));
  assert(candidate.length < original.length); assert.equal(candidate.includes(Buffer.from(PRIVATE_MARKER)), false);
  assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
  const current = transfer(await call(uploadPath(row.id), { cookie: g }), 'ready');
  assert.equal(current.size, candidate.length);
  const replay = transfer(await post(uploadPath(), g, { clientId: result.clientId, file }), 'ready', true);
  assert.equal(replay.id, row.id); assert.equal(replay.size, candidate.length);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_preparations')).rows[0].n, 1);
  assert.deepEqual(clam.scans, [original, candidate]);
  assert.equal((await db.query('SELECT evidence FROM cb_media_preparations')).rows[0].evidence.mediaAcceptanceReady, false);
});

test('file-only HTTP message binds atomically, retries once and serves only candidate public metadata and bytes', async () => {
  const g = await login(), t = await login('therapist-a'), result = await ready(g), row = await rowFor(result.upload.id);
  const body = { clientId: randomUUID(), body: '', attachments: [{ id: row.id }] };
  const message = await send(g, body), replay = await send(g, body);
  assert.equal(replay.id, message.id); assert.equal(message.body, ''); assert.equal(message.attachmentCount, 1);
  assert.equal((await rowFor(row.id)).state, 'bound');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages WHERE client_id = $1', [body.clientId])).rows[0].n, 1);
  const candidate = await readFile(join(root, `${row.candidate_key}.blob`));
  for (const projected of [message, replay, good(await call(messagePath(message.id), { cookie: t })).message,
    good(await call(`${room}/messages`, { cookie: t })).messages.find((item) => item.id === message.id)]) {
    assert.deepEqual(projected.attachments, [{ id: row.id, name: file.name, type: file.type, size: candidate.length }]); noPrivateData(projected);
  }
  for (const headers of [{}, { Range: 'bytes=1-4' }]) {
    const response = await call(contentPath(message, result.upload), { cookie: t, headers });
    assert.equal(response.status, 200); assert.deepEqual(response.buffer, candidate);
    assert.equal(response.headers['content-type'], file.type); assert.equal(response.headers['content-length'], String(candidate.length));
    assert.equal(response.headers['content-disposition'], 'attachment; filename="download.png"');
    assert.equal(response.headers['accept-ranges'], 'none'); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    for (const header of ['etag', 'last-modified', 'content-range', 'access-control-allow-origin']) assert.equal(response.headers[header], undefined);
  }
  assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
});

test('real client transports join source-aware upload, ID-only send and authorized candidate Blob download over HTTP', async () => {
  // Node supplies the two cookie jars and browser Origin in this transport
  // integration. This is NOT a UI, native inspection or browser-codec test.
  const makeClient = (cookie, userId) => {
    const api = new LocalApiClient({ fetch: (path, init) => {
      assert(path.startsWith('/api/local/'));
      return fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, Cookie: cookie,
        ...(init.method === 'POST' ? { Origin: origin } : {}) } });
    } });
    api.expectedUserId = userId; return { api, media: new MediaApiClient(api) };
  };
  const g = await login(), t = await login('therapist-a');
  const sender = makeClient(g, guardian.userId), reader = makeClient(t, 'therapist-a');
  const selected = new File([original], file.name, { type: file.type });
  const scope = { userId: guardian.userId, centerId: 'center-a', roomId: 'room-a' };
  const operation = Object.freeze({ clientId: randomUUID(), file: await mediaFileManifest(selected) });
  const reserved = await sender.media.reserve(scope, operation);
  const received = await sender.media.receive(scope, reserved, selected);
  assert.equal(received.state, 'quarantined');
  await uploads.inspect(guardian, { conversationId: 'room-a', uploadId: received.id, expectedVersion: received.version });
  const prepared = await sender.media.get(scope, received.id);
  assert.equal(prepared.state, 'ready'); assert.deepEqual(prepared.source, source); assert(prepared.size < source.size);
  const replay = await sender.media.reserve(scope, operation);
  assert.equal(replay.id, prepared.id); assert.equal(replay.replayed, true); assert.deepEqual(replay.source, source);
  const command = Object.freeze({ clientId: randomUUID(), body: '', attachments: Object.freeze([Object.freeze({ id: prepared.id })]) });
  const sent = await sender.api.send('center-a', 'room-a', command);
  assert.equal((await sender.api.send('center-a', 'room-a', command)).id, sent.id);
  const projected = await reader.api.message('center-a', 'room-a', sent.id);
  assert.equal(projected.attachments.length, 1);
  const readerScope = { ...scope, userId: 'therapist-a' };
  const blob = await reader.media.openMessageAttachment(readerScope, sent.id, projected.attachments[0]);
  const row = await rowFor(prepared.id), candidate = await readFile(join(root, `${row.candidate_key}.blob`));
  assert(blob instanceof Blob); assert.equal(blob.type, file.type); assert.equal(blob.size, candidate.length);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), candidate); assert.equal(candidate.includes(Buffer.from(PRIVATE_MARKER)), false);
  await reader.api.messageDelete('center-a', 'room-a', sent.id, { clientId: randomUUID(), scope: 'self', confirmed: true });
  await assert.rejects(reader.media.openMessageAttachment(readerScope, sent.id, projected.attachments[0]), { code: 'NOT_FOUND' });
});

test('quarantined and ready-unbound uploads are not downloadable and failed multi-bind leaves no partial write', async () => {
  const g = await login(), t = await login('therapist-a'), plain = await send(g), prepared = await ready(g), pending = await quarantine(g);
  for (const upload of [prepared.upload, pending.upload])
    for (const cookie of [g, t]) denied(await call(contentPath(plain, upload), { cookie }));
  const clientId = randomUUID();
  denied(await post(`${room}/messages`, g, { clientId, body: '', attachments: [{ id: prepared.upload.id }, { id: pending.upload.id }] }), 409, 'ATTACHMENT_NOT_READY');
  assert.equal((await rowFor(prepared.upload.id)).state, 'ready'); assert.equal((await rowFor(pending.upload.id)).state, 'quarantined');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages WHERE client_id = $1', [clientId])).rows[0].n, 0);
});

test('same-room nonowners cannot inspect transfer metadata or bind another account unpublished upload', async () => {
  const g = await login(), peer = await login('peer-a'), result = await ready(g);
  denied(await call(uploadPath(result.upload.id), { cookie: peer }));
  denied(await post(`${room}/messages`, peer, { clientId: randomUUID(), body: '', attachments: [{ id: result.upload.id }] }));
  assert.equal((await rowFor(result.upload.id)).state, 'ready');
  const message = await send(g, { body: '', attachments: [{ id: result.upload.id }] });
  assert.equal((await call(contentPath(message, result.upload), { cookie: peer })).status, 200);
  denied(await call(uploadPath(result.upload.id), { cookie: peer }));
});

test('center manager, unrelated accounts, foreign centers and wrong conversation cannot download', async () => {
  const g = await login(), result = await bound(g), path = contentPath(result.message, result.upload);
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b']) denied(await call(path, { cookie: await login(userId) }));
  denied(await call(path.replace('/room-a/', '/room-other/'), { cookie: g }));
  denied(await call(path.replace('/center-a/', '/center-b/'), { cookie: g }));
  denied(await call(path.replace(result.message.id, 'missing-message'), { cookie: g }));
  denied(await call(path.replace(result.upload.id, randomUUID()), { cookie: g }));
});

test('file reads and writes preserve session, account, same-origin and CSRF fences', async () => {
  const g = await login(), result = await bound(g), path = contentPath(result.message, result.upload);
  denied(await call(path), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: g, headers: { 'X-Carebridge-Account': 'therapist-a' } }), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: g, headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
  for (const headers of [{ Origin: 'https://synthetic.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'localhost' }])
    denied(await call(path, { cookie: g, headers }), 403, 'SOURCE_REJECTED');
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }, { Origin: 'https://synthetic.invalid' }])
    denied(await post(uploadPath(), g, { clientId: randomUUID(), file }, headers), 403, 'SOURCE_REJECTED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n, 1);
});

test('original paths and inspection or approval routes do not exist even for an authenticated owner', async () => {
  const g = await login(), result = await bound(g);
  const paths = [`${uploadPath(result.upload.id)}/content`, `${uploadPath(result.upload.id)}/original`,
    `${room}/messages/${result.message.id}/attachments/${result.upload.id}/original`,
    `/api/local/media/${result.row.object_key}.blob`, `/api/local/media/${result.row.candidate_key}.blob`];
  for (const path of paths) denied(await call(path, { cookie: g }));
  for (const action of ['inspect', 'approve', 'prepare', 'cleanup'])
    denied(await post(`${uploadPath(result.upload.id)}/${action}`, g, {}));
  for (const path of [`/${result.row.object_key}.blob`, `/private/${result.row.object_key}.blob`])
    assert.equal((await call(path, { cookie: g })).status, 404);
});

test('self-hide removes only that reader delivery without erasing private originals or peer access', async () => {
  const g = await login(), t = await login('therapist-a'), result = await bound(g), path = contentPath(result.message, result.upload);
  good(await post(`${messagePath(result.message.id)}/delete`, t, { clientId: randomUUID(), scope: 'self', confirmed: true }));
  denied(await call(path, { cookie: t })); assert.equal((await call(path, { cookie: g })).status, 200);
  denied(await call(messagePath(result.message.id), { cookie: t }));
  assert.equal(good(await call(`${room}/messages`, { cookie: t })).messages.some((item) => item.id === result.message.id), false);
  assert.deepEqual(await readFile(join(root, `${result.row.object_key}.blob`)), original);
  assert.equal((await rowFor(result.upload.id)).state, 'bound');
  good(await post(`${messagePath(result.message.id)}/delete`, g, { clientId: randomUUID(), scope: 'self', confirmed: true }));
  const replay = await send(g, result.sendInput);
  assert.equal(replay.id, result.message.id); assert.equal(replay.hidden, true); assert.equal(replay.attachmentCount, 0);
  assert.equal(replay.attachments, undefined); assert.equal(replay.body, '나에게서 삭제한 소식입니다.'); noPrivateData(replay);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_messages WHERE client_id = $1', [result.sendInput.clientId])).rows[0].n, 1);
});

test('delete for everyone closes message delivery but preserves immutable attachment records and original bytes', async () => {
  const g = await login(), t = await login('therapist-a'), result = await bound(g);
  good(await post(`${messagePath(result.message.id)}/delete`, g,
    { clientId: randomUUID(), scope: 'all', expectedRevision: 1, confirmed: true }));
  for (const cookie of [g, t]) {
    denied(await call(contentPath(result.message, result.upload), { cookie }));
    const projection = good(await call(messagePath(result.message.id), { cookie })).message;
    assert.equal(projection.deleted, true); assert.equal(projection.attachments, undefined);
  }
  assert.equal((await rowFor(result.upload.id)).state, 'bound');
  assert.deepEqual(await readFile(join(root, `${result.row.object_key}.blob`)), original);
});

test('future-only history and relationship removal revoke content and original transfer metadata reads', async () => {
  const g = await login(), t = await login('therapist-a'), peer = await login('peer-a'), result = await bound(g);
  await changeHistory({ therapistHistory: 'from_now', ownerHistory: 'from_now' });
  for (const cookie of [g, t]) denied(await call(contentPath(result.message, result.upload), { cookie }));
  denied(await call(uploadPath(result.upload.id), { cookie: g }));
  assert.equal((await call(contentPath(result.message, result.upload), { cookie: peer })).status, 200);
  await changeHistory({ removeOwner: true });
  denied(await call(uploadPath(result.upload.id), { cookie: g }));
  assert.deepEqual(await readFile(join(root, `${result.row.object_key}.blob`)), original);
});

test('tampered candidate is refused without original fallback or unsafe diagnostic exposure', async () => {
  const g = await login(), t = await login('therapist-a'), result = await bound(g);
  await writeFile(join(root, `${result.row.candidate_key}.blob`), Buffer.alloc(result.row.prepared_size));
  denied(await call(contentPath(result.message, result.upload), { cookie: t }));
  assert.deepEqual(await readFile(join(root, `${result.row.object_key}.blob`)), original);
  assert.equal((await rowFor(result.upload.id)).state, 'bound');
});

test('cancel response preserves original metadata while domain cleanup fences and removes both owned files', async () => {
  const g = await login(), result = await ready(g), row = await rowFor(result.upload.id);
  transfer(await post(`${uploadPath(row.id)}/cancel`, g, { expectedVersion: result.upload.version }), 'deleted');
  for (const key of [row.object_key, row.candidate_key]) {
    await assert.rejects(readFile(join(root, `${key}.blob`)), { code: 'ENOENT' });
    assert.equal((await readFile(join(root, `${key}.blocked`))).length, 0);
  }
  transfer(await call(uploadPath(row.id), { cookie: g }), 'deleted');
});

test('worker maintenance mode returns real pending deletion until separate cleanup, without an API maintenance callback', async () => {
  options.mediaMaintenance = 'worker'; delete options.mediaCleanup;
  const g = await login(), result = await ready(g), row = await rowFor(result.upload.id);
  transfer(await post(`${uploadPath(row.id)}/cancel`, g, { expectedVersion: result.upload.version }), 'delete_pending');
  for (const key of [row.object_key, row.candidate_key]) assert.ok((await readFile(join(root, `${key}.blob`))).length > 0);
  transfer(await call(uploadPath(row.id), { cookie: g }), 'delete_pending');
  // Explicit worker stand-in here: HTTP did not invoke cleanup or claim that
  // bytes were removed. The actual native worker is verified separately.
  assert.equal((await uploads.cleanup()).failed, 0);
  transfer(await call(uploadPath(row.id), { cookie: g }), 'deleted');
  for (const key of [row.object_key, row.candidate_key]) await assert.rejects(readFile(join(root, `${key}.blob`)), { code: 'ENOENT' });
});

test('unknown or ambiguous maintenance configuration fails closed without invoking callbacks', async () => {
  const g = await login(); let invoked = false;
  options.mediaCleanup = async () => { invoked = true; };
  for (const mode of ['worker', null, false, 'external', {}]) {
    options.mediaMaintenance = mode;
    denied(await post(uploadPath(), g, { clientId: randomUUID(), file }), 503, 'LOCAL_API_UNAVAILABLE');
  }
  assert.equal(invoked, false);
  options.mediaMaintenance = 'worker'; delete options.mediaCleanup; delete options.mediaAccess;
  denied(await post(uploadPath(), g, { clientId: randomUUID(), file }), 503, 'LOCAL_API_UNAVAILABLE');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n, 0);
});

test('without explicit MediaAccess the default remains quarantine-only, cannot attach or deliver prepared files', async () => {
  const g = await login(), result = await ready(g);
  // Only the factory/server option changes; no environment or public input can
  // enable delivery. Existing valid candidate files do not bypass this gate.
  delete options.mediaAccess;
  options.mediaDelivery = true; // A boolean alone is not a delivery capability.
  const current = good(await call(uploadPath(result.upload.id), { cookie: g }));
  assert.equal(current.mode, 'quarantine-only'); assert.equal(current.source, undefined);
  denied(await post(`${room}/messages`, g, { clientId: randomUUID(), body: '', attachments: [{ id: result.upload.id }] }),
    409, 'ATTACHMENTS_NOT_CONNECTED');
  const message = await chat.sendText(guardian, { conversationId: 'room-a', clientId: randomUUID(), body: '', attachments: [{ id: result.upload.id }] });
  denied(await call(contentPath(message, result.upload), { cookie: g }));
  const publicMessage = good(await call(messagePath(message.id), { cookie: g })).message;
  assert.equal(publicMessage.attachmentCount, 1); assert.equal(publicMessage.attachments, undefined); noPrivateData(publicMessage);
  assert.equal((await send(g)).body, '합성 일반 소식');
  options.mediaAccess = {}; // A lookalike cannot opt into the concrete reader.
  denied(await call(contentPath(message, result.upload), { cookie: g }), 503, 'LOCAL_API_UNAVAILABLE');
  options.mediaAccess = { open() { throw new Error('Duck-typed reader must never execute.'); } };
  denied(await call(contentPath(message, result.upload), { cookie: g }), 503, 'LOCAL_API_UNAVAILABLE');
});

const recordPath = (id = 'record-a') => `${room}/records/${id}`;
const recordContentPath = (id, revision, uploadId) => `${recordPath(id)}/revisions/${revision}/attachments/${uploadId}/content`;
const recordContent = (attachments = []) => ({ date: '2026-10-09', goalId: 'goal-a', title: '합성 첨부 기록',
  performed: '합성 놀이 관찰', response: '선택 후 참여', nextPlan: '다음 관찰', summary: '공개 합성 요약',
  privateNote: 'PRIVATE-RECORD-NOTE', activity: { title: '합성 가정 활동', instruction: '편하게 선택하기', frequency: '편한 시간', caution: '무리하지 않기' }, attachments });
const recordCommand = (attachments, overrides = {}) => ({ clientId: randomUUID(), expectedRevision: 0,
  content: recordContent(attachments), ...overrides });
async function saveRecord(cookie, attachments, { id = 'record-a', ...overrides } = {}) {
  const command = recordCommand(attachments, overrides);
  const result = good(await post(recordPath(id), cookie, command), 201);
  assert.deepEqual(Object.keys(result), ['receipt']); return { ...result, command };
}
async function publishRecord(cookie, id = 'record-a') {
  const preview = good(await call(`${recordPath(id)}/preview`, { cookie })).preview;
  const command = { clientId: randomUUID(), expectedRevision: preview.recordRevision,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds };
  const result = good(await post(`${recordPath(id)}/publish`, cookie, command), 201);
  assert.deepEqual(Object.keys(result), ['receipt']); return { ...result, preview, command };
}
async function attachmentView(upload, share) {
  const row = await rowFor(upload.id), bytes = await readFile(join(root, `${row.candidate_key}.blob`));
  return { id: upload.id, name: file.name, type: file.type, size: bytes.length, share };
}

test('record HTTP binds private/share-opt-in candidates once and projects only exact public manifest fields', async () => {
  const t = await login('therapist-a'), g = await login(), a = await ready(t), b = await ready(t);
  const saved = await saveRecord(t, [{ id: a.upload.id, share: true }, { id: b.upload.id }]);
  const replay = good(await post(recordPath(), t, saved.command), 201).receipt;
  assert.equal(replay.revision, 1); assert.equal(replay.replayed, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_record_requests WHERE client_id=$1', [saved.command.clientId])).rows[0].n, 1);
  const expected = [await attachmentView(a.upload, true), await attachmentView(b.upload, false)];
  const record = good(await call(`${recordPath()}?revision=1`, { cookie: t })).record;
  assert.deepEqual(record.attachments, expected); assert.equal(record.attachmentCount, 2);
  assert.equal(record.privateNote, 'PRIVATE-RECORD-NOTE'); noPrivateData(record.attachments);
  for (const upload of [a.upload, b.upload]) {
    const row = await rowFor(upload.id), response = await call(recordContentPath('record-a', 1, upload.id), { cookie: t });
    assert.equal(row.state, 'bound'); assert.equal(row.bound_record_id, 'record-a');
    assert.equal(response.status, 200); assert.deepEqual(response.buffer, await readFile(join(root, `${row.candidate_key}.blob`)));
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['content-disposition'], 'attachment; filename="download.png"');
    assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
    denied(await call(recordContentPath('record-a', 1, upload.id), { cookie: g }));
  }
  const shared = await publishRecord(t);
  assert.deepEqual(shared.preview.attachments, [expected[0]]); assert.equal(shared.preview.attachmentCount, 1);
  assert(!JSON.stringify(shared.preview).includes('PRIVATE-RECORD-NOTE')); noPrivateData(shared.preview);
  for (const cookie of [t, g]) {
    const publication = good(await call(messagePath(shared.receipt.messageId), { cookie })).message;
    const { share, ...publicFile } = expected[0];
    assert.deepEqual(publication.attachments, [publicFile]); assert.equal(publication.attachmentCount, 1); noPrivateData(publication);
    assert.equal((await call(contentPath(publication, a.upload), { cookie })).status, 200);
    denied(await call(contentPath(publication, b.upload), { cookie }));
  }
});

test('record revisions and publication snapshots preserve selected files through edit, retry, reshare and withdraw', async () => {
  const t = await login('therapist-a'), g = await login(), a = await ready(t), b = await ready(t);
  const first = await saveRecord(t, [{ id: a.upload.id, share: true }, { id: b.upload.id, share: false }]);
  const oldShare = await publishRecord(t), oldMessage = { id: oldShare.receipt.messageId };
  await saveRecord(t, [{ id: b.upload.id, share: true }], { expectedRevision: 1 });
  const oldRecord = good(await call(`${recordPath()}?revision=1`, { cookie: t })).record;
  const newRecord = good(await call(recordPath(), { cookie: t })).record;
  assert.deepEqual(oldRecord.attachments.map(({ id, share }) => ({ id, share })), [{ id: a.upload.id, share: true }, { id: b.upload.id, share: false }]);
  assert.deepEqual(newRecord.attachments.map(({ id, share }) => ({ id, share })), [{ id: b.upload.id, share: true }]);
  assert.equal(newRecord.revision, 2);
  assert.equal(good(await post(recordPath(), t, first.command), 201).receipt.revision, 1);
  assert.equal(good(await post(`${recordPath()}/publish`, t, oldShare.command), 201).receipt.replayed, true);
  assert.equal((await call(recordContentPath('record-a', 1, a.upload.id), { cookie: t })).status, 200);
  denied(await call(recordContentPath('record-a', 2, a.upload.id), { cookie: t }));
  denied(await call(recordContentPath('record-a', 3, b.upload.id), { cookie: t }));
  assert.deepEqual(good(await call(messagePath(oldMessage.id), { cookie: g })).message.attachments.map(f => f.id), [a.upload.id]);
  assert.equal((await call(contentPath(oldMessage, a.upload), { cookie: g })).status, 200);
  const newShare = await publishRecord(t), newMessage = { id: newShare.receipt.messageId };
  denied(await call(contentPath(oldMessage, a.upload), { cookie: g }));
  assert.deepEqual(good(await call(messagePath(newMessage.id), { cookie: g })).message.attachments.map(f => f.id), [b.upload.id]);
  assert.equal((await call(contentPath(newMessage, b.upload), { cookie: g })).status, 200);
  const withdrawn = good(await post(`${room}/publications/${newMessage.id}/withdraw`, t, {})).message;
  assert.deepEqual(withdrawn.attachments.map(f => f.id), [b.upload.id]); noPrivateData(withdrawn);
  denied(await call(contentPath(newMessage, b.upload), { cookie: g }));
  assert.equal((await call(recordContentPath('record-a', 1, a.upload.id), { cookie: t })).status, 200);
  for (const upload of [a.upload, b.upload]) {
    const row = await rowFor(upload.id); assert.equal(row.state, 'bound');
    assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
  }
});

test('record attachment validation and ownership failures leave all bindings and record writes atomic', async () => {
  const t = await login('therapist-a'), g = await login(), prepared = await ready(t), pending = await quarantine(t), other = await ready(g);
  const failSave = async (attachments, status, code) => denied(await post(recordPath(), t, recordCommand(attachments)), status, code);
  await failSave([{ id: prepared.upload.id }, { id: pending.upload.id }], 409, 'ATTACHMENT_NOT_READY');
  await failSave([{ id: other.upload.id }], 404, 'NOT_FOUND');
  for (const attachments of [[{ id: prepared.upload.id, name: 'forged' }], [{ id: prepared.upload.id, share: 'true' }],
    [{ id: prepared.upload.id }, { id: prepared.upload.id }], Array.from({ length: 7 }, () => ({ id: randomUUID() }))])
    await failSave(attachments, 400, 'INVALID_INPUT');
  assert.equal((await rowFor(prepared.upload.id)).state, 'ready'); assert.equal((await rowFor(pending.upload.id)).state, 'quarantined');
  assert.equal((await rowFor(other.upload.id)).state, 'ready');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_record_attachments')).rows[0].n, 0);
  await saveRecord(t, [{ id: prepared.upload.id }]);
  denied(await post(recordPath('record-b'), t, recordCommand([{ id: prepared.upload.id }])), 409, 'ATTACHMENT_ORIGIN_CONFLICT');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_records')).rows[0].n, 1);
});

test('record file route preserves source/account/role/room fences and exact revisions without original paths', async () => {
  const t = await login('therapist-a'), a = await ready(t); await saveRecord(t, [{ id: a.upload.id, share: true }]);
  const path = recordContentPath('record-a', 1, a.upload.id);
  for (const userId of ['guardian-a', 'peer-a', 'manager-a', 'stranger-a', 'foreign-b'])
    denied(await call(path, { cookie: await login(userId) }));
  denied(await call(path), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: t, headers: { 'X-Carebridge-Account': guardian.userId } }), 401, 'AUTH_REQUIRED');
  denied(await call(path, { cookie: t, headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
  for (const headers of [{ Origin: 'https://synthetic.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost' }])
    denied(await call(path, { cookie: t, headers }), 403, 'SOURCE_REJECTED');
  for (const changed of [path.replace('/room-a/', '/room-other/'), path.replace('/center-a/', '/center-b/'),
    path.replace('/record-a/', '/missing-record/'), path.replace(a.upload.id, randomUUID()), path.replace('/content', '/original')])
    denied(await call(changed, { cookie: t }));
  denied(await call(path + '?revision=2', { cookie: t }), 400, 'INVALID_INPUT');
  denied(await post(path, t, {}));
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }])
    denied(await post(recordPath(), t, recordCommand([], { expectedRevision: 1 }), headers), 403, 'SOURCE_REJECTED');
  assert.equal(good(await call(recordPath(), { cookie: t })).record.revision, 1);
});

test('record default mode refuses attachment edits/shares and delivery even when an untrusted boolean asks to enable it', async () => {
  const t = await login('therapist-a'), a = await ready(t); await saveRecord(t, [{ id: a.upload.id, share: true }]);
  delete options.mediaAccess; options.mediaDelivery = true;
  const record = good(await call(recordPath(), { cookie: t })).record;
  assert.equal(record.attachmentCount, 1); assert.equal(record.attachments, undefined);
  const preview = good(await call(`${recordPath()}/preview`, { cookie: t })).preview;
  assert.equal(preview.attachmentCount, 1); assert.equal(preview.attachments, undefined);
  denied(await post(recordPath('new-record'), t, recordCommand([{ id: a.upload.id }])), 409, 'ATTACHMENTS_NOT_CONNECTED');
  for (const attachments of [undefined, []]) {
    const command = recordCommand([], { expectedRevision: 1 });
    if (attachments === undefined) delete command.content.attachments;
    denied(await post(recordPath(), t, command), 409, 'ATTACHMENTS_NOT_CONNECTED');
  }
  denied(await post(`${recordPath()}/publish`, t, { clientId: randomUUID(), expectedRevision: 1,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds }), 409, 'ATTACHMENTS_NOT_CONNECTED');
  denied(await call(recordContentPath('record-a', 1, a.upload.id), { cookie: t }));
  options.mediaAccess = {};
  denied(await call(recordContentPath('record-a', 1, a.upload.id), { cookie: t }), 503, 'LOCAL_API_UNAVAILABLE');
  assert.equal((await options.records.get(therapist, { conversationId: 'room-a', recordId: 'record-a' })).revision, 1);
});

test('default feedback mode rejects new attachments and cannot remove existing media by omission or empty input', async () => {
  const t = await login('therapist-a'), g = await login(), a = await ready(g);
  await saveRecord(t, []); const publication = await publishRecord(t);
  const command = { sourceMessageId: publication.receipt.messageId, clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-09', result: 'done', reaction: '합성 반응', difficulty: '', attachments: [{ id: a.upload.id }] } };
  delete options.mediaAccess; options.mediaDelivery = true; // Untrusted boolean cannot enable delivery.
  denied(await post(`${room}/feedback/feedback-a`, g, command), 409, 'ATTACHMENTS_NOT_CONNECTED');
  assert.equal((await rowFor(a.upload.id)).state, 'ready');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_activity_feedback')).rows[0].n, 0);
  // Existing domain callers may own feedback media; a text-only adapter must
  // not silently remove those files on an edit that cannot display them.
  await options.feedback.save(guardian, { conversationId: 'room-a', feedbackId: 'feedback-a', ...command });
  for (const attachments of [undefined, []]) {
    const update = { ...command, clientId: randomUUID(), expectedRevision: 1, content: { ...command.content } };
    if (attachments === undefined) delete update.content.attachments; else update.content.attachments = attachments;
    denied(await post(`${room}/feedback/feedback-a`, g, update), 409, 'ATTACHMENTS_NOT_CONNECTED');
  }
  const card = good(await call(`${room}/feedback/feedback-a`, { cookie: t })).message;
  assert.equal(card.attachmentCount, 1); assert.equal(card.attachments, undefined); assert.equal(card.feedback.revision, 1);
  denied(await call(`${messagePath(card.id)}/feedback-revisions/1/attachments/${a.upload.id}/content`, { cookie: t }));
  assert.equal((await rowFor(a.upload.id)).state, 'bound');
});

test('record history removal and candidate tamper refuse delivery without altering original attachments', async () => {
  const t = await login('therapist-a'), a = await ready(t), intact = await ready(t);
  await saveRecord(t, [{ id: a.upload.id }, { id: intact.upload.id }]);
  const row = await rowFor(a.upload.id), path = recordContentPath('record-a', 1, a.upload.id);
  const intactPath = recordContentPath('record-a', 1, intact.upload.id);
  await writeFile(join(root, `${row.candidate_key}.blob`), Buffer.alloc(row.prepared_size));
  denied(await call(path, { cookie: t }));
  assert.equal((await call(intactPath, { cookie: t })).status, 200);
  assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
  await changeHistory({ therapistHistory: 'from_now' });
  denied(await call(recordPath(), { cookie: t })); denied(await call(path, { cookie: t }));
  denied(await call(intactPath, { cookie: t }));
  assert.equal((await rowFor(a.upload.id)).state, 'bound');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_record_attachments')).rows[0].n, 2);
  assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
});

const feedbackPath = (id = 'feedback-a') => `${room}/feedback/${id}`;
const feedbackContentPath = (messageId, revision, uploadId) => `${messagePath(messageId)}/feedback-revisions/${revision}/attachments/${uploadId}/content`;
const referenceContentPath = (recordId, revision, messageId, uploadId) => `${recordPath(recordId)}/revisions/${revision}/references/${messageId}/attachments/${uploadId}/content`;
const feedbackCommand = (sourceMessageId, attachments = [], overrides = {}) => ({ sourceMessageId, clientId: randomUUID(), expectedRevision: 0,
  content: { date: '2026-10-09', result: 'done', reaction: '합성 F1 반응', difficulty: '', attachments }, ...overrides });
async function feedbackFixture() {
  const t = await login('therapist-a'), g = await login();
  await saveRecord(t, []); const publication = await publishRecord(t), a = await ready(g);
  const command = feedbackCommand(publication.receipt.messageId, [{ id: a.upload.id }]);
  const receipt = good(await post(feedbackPath(), g, command), 201).receipt;
  return { t, g, a, publication, command, receipt };
}
async function saveReference(t, messageId, feedbackRevision, { id = 'record-next', expectedRevision = 0 } = {}) {
  return saveRecord(t, [], { id, expectedRevision, content: { ...recordContent(), referenceMessageIds: [messageId],
    ...(feedbackRevision === undefined ? { referenceTextRevisions: [{ messageId, revision: 1 }] }
      : { referenceFeedbackRevisions: [{ messageId, revision: feedbackRevision }] }) } });
}
async function publicAttachment(upload) {
  const { share, ...view } = await attachmentView(upload, false); return view;
}
async function candidateBytes(upload) {
  const row = await rowFor(upload.id); return readFile(join(root, `${row.candidate_key}.blob`));
}

test('prepared feedback binds once, projects candidate metadata and preserves F1 through F2 replacement and removal', async () => {
  const f = await feedbackFixture(), { t, g, a, receipt, command } = f;
  const expected = [await publicAttachment(a.upload)];
  for (const cookie of [t, g, await login('peer-a')]) {
    const card = good(await call(feedbackPath(), { cookie })).message;
    assert.deepEqual(card.attachments, expected); assert.equal(card.id, receipt.messageId); assert.equal(card.feedback.revision, 1);
    assert.equal(card.attachmentCount, 1); noPrivateData(card);
    assert.deepEqual((await call(contentPath(card, a.upload), { cookie })).buffer, await candidateBytes(a.upload));
  }
  const replay = good(await post(feedbackPath(), g, command), 201).receipt;
  assert.equal(replay.replayed, true); assert.equal(replay.revision, 1); assert.equal(replay.messageId, receipt.messageId);
  assert.equal((await rowFor(a.upload.id)).bound_feedback_id, 'feedback-a');
  const b = await ready(g), second = feedbackCommand(command.sourceMessageId, [{ id: b.upload.id }], { expectedRevision: 1 });
  second.content.reaction = '합성 F2 반응';
  good(await post(feedbackPath(), g, second), 201);
  const current = good(await call(feedbackPath(), { cookie: g })).message;
  assert.equal(current.feedback.revision, 2); assert.deepEqual(current.attachments, [await publicAttachment(b.upload)]);
  denied(await call(contentPath(current, a.upload), { cookie: t }));
  const first = good(await call(`${feedbackPath()}?revision=1`, { cookie: t })).message;
  assert.equal(first.feedback.revision, 1); assert.equal(first.feedback.reaction, command.content.reaction); assert.deepEqual(first.attachments, expected);
  assert.deepEqual((await call(feedbackContentPath(receipt.messageId, 1, a.upload.id), { cookie: t })).buffer, await candidateBytes(a.upload));
  denied(await call(feedbackContentPath(receipt.messageId, 2, a.upload.id), { cookie: t }));
  denied(await call(feedbackContentPath(receipt.messageId, 1, b.upload.id), { cookie: t }));
  denied(await call(`${feedbackPath()}?revision=1`, { cookie: g }));
  denied(await call(feedbackContentPath(receipt.messageId, 1, a.upload.id), { cookie: g }));
  assert.equal(good(await post(feedbackPath(), g, command), 201).receipt.revision, 1);
  good(await post(feedbackPath(), g, feedbackCommand(command.sourceMessageId, [], { expectedRevision: 2 })), 201);
  assert.deepEqual(good(await call(feedbackPath(), { cookie: t })).message.attachments, []);
  assert.deepEqual(good(await call(`${feedbackPath()}?revision=2`, { cookie: t })).message.attachments, [await publicAttachment(b.upload)]);
  // Exact retries do not create another revision or change immutable origin.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_revisions')).rows[0].n, 3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_requests WHERE client_id=$1', [command.clientId])).rows[0].n, 1);
  for (const item of [a, b]) { const row = await rowFor(item.upload.id); assert.equal(row.state, 'bound'); assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original); }
});

test('record references return only captured feedback files through edit, feedback correction and source withdrawal', async () => {
  const { t, g, a, receipt, command, publication } = await feedbackFixture();
  await saveReference(t, receipt.messageId, 1);
  const b = await ready(g);
  good(await post(feedbackPath(), g, feedbackCommand(command.sourceMessageId, [{ id: b.upload.id }], { expectedRevision: 1 })), 201);
  const reference = { messageId: receipt.messageId, feedbackId: 'feedback-a', feedbackRevision: 1,
    attachmentCount: 1, attachments: [await publicAttachment(a.upload)] };
  const next = good(await call(recordPath('record-next'), { cookie: t })).record;
  assert.deepEqual(next.referenceSources, [reference]); assert.deepEqual(next.attachments, []); noPrivateData(next.referenceSources);
  await saveReference(t, receipt.messageId, 1, { expectedRevision: 1 });
  assert.deepEqual(good(await call(recordPath('record-next'), { cookie: t })).record.referenceSources, [reference]);
  for (const revision of [1, 2]) {
    const path = referenceContentPath('record-next', revision, receipt.messageId, a.upload.id);
    assert.deepEqual((await call(path, { cookie: t })).buffer, await candidateBytes(a.upload));
    denied(await call(path, { cookie: g }));
    denied(await call(referenceContentPath('record-next', revision, receipt.messageId, b.upload.id), { cookie: t }));
  }
  const preview = good(await call(`${recordPath('record-next')}/preview`, { cookie: t })).preview;
  assert.equal(preview.attachmentCount, 0); assert.deepEqual(preview.attachments, []);
  assert(!JSON.stringify(preview).includes(a.upload.id)); assert(!JSON.stringify(preview).includes('referenceSources'));
  await publishRecord(t, 'record-next');
  const closed = good(await post(`${room}/publications/${publication.receipt.messageId}/withdraw`, t, {})).message;
  assert.equal(closed.id, publication.receipt.messageId);
  denied(await call(contentPath({ id: receipt.messageId }, b.upload), { cookie: g }));
  const hidden = good(await call(feedbackPath(), { cookie: g })).message;
  assert.equal(hidden.hidden, true); assert.equal(hidden.attachments, undefined); assert.equal(hidden.attachmentCount, 0);
  assert.deepEqual(good(await call(recordPath('record-next'), { cookie: t })).record.referenceSources, [reference]);
  assert.deepEqual((await call(referenceContentPath('record-next', 1, receipt.messageId, a.upload.id), { cookie: t })).buffer, await candidateBytes(a.upload));
  assert.equal(good(await post(feedbackPath(), g, command), 201).receipt.replayed, true);
  denied(await post(feedbackPath(), g, feedbackCommand(command.sourceMessageId, [], { expectedRevision: 2 })), 409, 'PUBLICATION_CLOSED');
});

test('exact feedback and record-reference routes keep role/account/room/history and source fences', async () => {
  const { t, a, receipt } = await feedbackFixture(); await saveReference(t, receipt.messageId, 1);
  const paths = [feedbackContentPath(receipt.messageId, 1, a.upload.id), referenceContentPath('record-next', 1, receipt.messageId, a.upload.id)];
  for (const path of paths) {
    assert.equal((await call(path, { cookie: t })).status, 200);
    denied(await call(path), 401, 'AUTH_REQUIRED');
    for (const userId of ['guardian-a', 'peer-a', 'manager-a', 'stranger-a', 'foreign-b']) denied(await call(path, { cookie: await login(userId) }));
    for (const expected of [undefined, 'guardian-a']) denied(await call(path, { cookie: t, headers: { 'X-Carebridge-Account': expected } }), 401, 'AUTH_REQUIRED');
    for (const headers of [{ Origin: 'https://synthetic.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost' }])
      denied(await call(path, { cookie: t, headers }), 403, 'SOURCE_REJECTED');
    for (const changed of [path.replace('/room-a/', '/room-other/'), path.replace('/center-a/', '/center-b/'),
      path.replace(receipt.messageId, 'other-message'), path.replace(a.upload.id, randomUUID()), path.replace('/content', '/original')]) denied(await call(changed, { cookie: t }));
    denied(await call(path + '?revision=2', { cookie: t }), 400, 'INVALID_INPUT'); denied(await post(path, t, {}));
  }
  await changeHistory({ therapistHistory: 'from_now' });
  for (const path of paths) denied(await call(path, { cookie: t }));
  denied(await call(recordPath('record-next'), { cookie: t }));
  denied(await call(`${feedbackPath()}?revision=1`, { cookie: t }));
  const row = await rowFor(a.upload.id); assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
});

test('feedback attachment role, readiness and origin failures atomically preserve files and heads', async () => {
  const t = await login('therapist-a'), g = await login(); await saveRecord(t, []); const pub = await publishRecord(t);
  const a = await ready(g), pending = await quarantine(g), other = await ready(t);
  const command = (attachments) => feedbackCommand(pub.receipt.messageId, attachments);
  denied(await post(feedbackPath(), g, command([{ id: a.upload.id }, { id: pending.upload.id }])), 409, 'ATTACHMENT_NOT_READY');
  denied(await post(feedbackPath(), g, command([{ id: other.upload.id }])));
  denied(await post(feedbackPath(), t, command([{ id: a.upload.id }])));
  for (const attachments of [[{ id: a.upload.id, share: true }], [{ id: a.upload.id, name: 'forged' }],
    [{ id: a.upload.id }, { id: a.upload.id }], Array.from({ length: 7 }, () => ({ id: randomUUID() }))])
    denied(await post(feedbackPath(), g, command(attachments)), 400, 'INVALID_INPUT');
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }]) denied(await post(feedbackPath(), g, command([{ id: a.upload.id }]), headers), 403, 'SOURCE_REJECTED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_activity_feedback')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_attachments')).rows[0].n, 0);
  assert.equal((await rowFor(a.upload.id)).state, 'ready'); assert.equal((await rowFor(pending.upload.id)).state, 'quarantined');
  const first = command([{ id: a.upload.id }]); good(await post(feedbackPath(), g, first), 201);
  denied(await post(feedbackPath('feedback-b'), g, command([{ id: a.upload.id }])), 409, 'ATTACHMENT_ORIGIN_CONFLICT');
  denied(await post(feedbackPath(), g, { ...first, content: { ...first.content, attachments: [] } }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(feedbackPath(), g, { ...first, clientId: randomUUID() }), 409, 'FEEDBACK_CONFLICT');
  denied(await post(feedbackPath(), await login('peer-a'), { ...first, clientId: randomUUID(), expectedRevision: 1 }));
  good(await post(feedbackPath(), g, { ...first, clientId: randomUUID(), expectedRevision: 1 }), 201); // Same-origin immutable reuse.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_feedback_revisions')).rows[0].n, 2);
});

test('record-reference content keeps independent text originals after hide/delete without granting live-source access', async () => {
  const t = await login('therapist-a'), g = await login(), a = await bound(g);
  await saveReference(t, a.message.id);
  const path = referenceContentPath('record-next', 1, a.message.id, a.upload.id);
  assert.deepEqual(good(await call(recordPath('record-next'), { cookie: t })).record.referenceSources[0].attachments, [await publicAttachment(a.upload)]);
  good(await post(`${messagePath(a.message.id)}/delete`, g, { clientId: randomUUID(), expectedRevision: 1, scope: 'all', confirmed: true }));
  good(await post(`${messagePath(a.message.id)}/delete`, t, { clientId: randomUUID(), scope: 'self', confirmed: true }));
  denied(await call(contentPath(a.message, a.upload), { cookie: t }));
  assert.deepEqual((await call(path, { cookie: t })).buffer, await candidateBytes(a.upload));
  denied(await call(path, { cookie: g }));
  const source = good(await call(recordPath('record-next'), { cookie: t })).record.referenceSources[0];
  assert.equal(source.deleted, true); assert.equal(source.hidden, true); assert.deepEqual(source.attachments, [await publicAttachment(a.upload)]);
});

test('reference delivery is gated by trusted service and candidate integrity without modifying original bytes', async () => {
  const { t, a, receipt } = await feedbackFixture(); await saveReference(t, receipt.messageId, 1);
  const paths = [feedbackContentPath(receipt.messageId, 1, a.upload.id), referenceContentPath('record-next', 1, receipt.messageId, a.upload.id)];
  const access = options.mediaAccess; delete options.mediaAccess; options.mediaDelivery = true;
  const record = good(await call(recordPath('record-next'), { cookie: t })).record;
  assert.equal(record.referenceSources[0].attachmentCount, 1); assert.equal(record.referenceSources[0].attachments, undefined);
  for (const path of paths) denied(await call(path, { cookie: t }));
  options.mediaAccess = {}; for (const path of paths) denied(await call(path, { cookie: t }), 503, 'LOCAL_API_UNAVAILABLE');
  options.mediaAccess = access;
  for (const path of paths) assert.equal((await call(path, { cookie: t })).status, 200);
  const row = await rowFor(a.upload.id), candidate = await candidateBytes(a.upload), changed = Buffer.from(candidate); changed[changed.length - 1] ^= 1;
  await writeFile(join(root, `${row.candidate_key}.blob`), changed);
  for (const path of paths) denied(await call(path, { cookie: t }));
  assert.deepEqual(await readFile(join(root, `${row.object_key}.blob`)), original);
});
