import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Auth } from '../auth.mjs';
import { createLocalApiSandbox } from '../local-api-sandbox.mjs';

// Actual loopback HTTP, memory-only PGlite and the sandbox's owned temporary
// private store. These invented bytes/accounts never enter a scanner, decoder,
// ready state, native database, E drive, public host or existing user folder.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = (changes = {}) => ({ name: 'synthetic-pixel.png', type: 'image/png', size: png.length, sha256: digest(png), ...changes });
const uploadKeys = ['id', 'conversationId', 'name', 'type', 'size', 'state', 'version', 'failureCode', 'expiresAt', 'expired'].sort();
let sandbox, room, otherRoom, foreignRoom, sessions, extras, reservedCount = 0;
const active = new Map();

function call(path, { method = 'GET', session, body, bytes, headers = {}, rawHeaders, chunked = false } = {}) {
  const target = new URL(sandbox.origin);
  const payload = bytes ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  const combined = { Host: target.host,
    ...(method === 'POST' ? { Origin: sandbox.origin, 'X-Carebridge-Request': '1',
      'Content-Type': bytes === undefined ? 'application/json' : 'application/octet-stream' } : {}),
    ...(payload !== undefined ? { 'Content-Length': String(payload.length) } : {}),
    ...(session ? { Cookie: session.cookie, 'X-Carebridge-Account': session.userId } : {}), ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  if (chunked) { delete combined['Content-Length']; combined['Transfer-Encoding'] = 'chunked'; }
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path, method, headers: rawHeaders ?? combined, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { if (text) json = JSON.parse(text); } catch { /* An unexpected body is asserted without printing bytes. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Synthetic media HTTP timeout.')));
    if (chunked && payload) { req.write(payload); req.end(); } else req.end(payload);
  });
}

async function login(role) {
  const account = sandbox.credentials.find((item) => item.role === role) ?? extras[role];
  const result = await call('/api/local/auth/login', { method: 'POST', body: { email: account.email, password: account.password } });
  assert.equal(result.status, 200, 'Synthetic login must succeed.');
  return { cookie: result.headers['set-cookie'][0].split(';')[0], userId: result.json.user.userId };
}
function checkError(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.json?.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), code === 'LOCAL_REQUEST_UNAVAILABLE' ? ['error'] : ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert(!result.text.includes(sandbox.mediaRoot), 'Private directory must not appear in errors.');
}
function publicUpload(result, expectedState, { reserved = false } = {}) {
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.json).sort(), ['mode', 'upload']);
  assert.equal(result.json.mode, 'quarantine-only');
  const upload = result.json.upload;
  assert.deepEqual(Object.keys(upload).sort(), [...uploadKeys, ...(reserved ? ['replayed'] : [])].sort());
  assert.equal(upload.state, expectedState);
  assert.match(upload.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert(Number.isInteger(upload.version) && upload.version > 0);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  for (const privateValue of [sandbox.mediaRoot, digest(png)]) assert(!result.text.includes(privateValue));
  for (const forbidden of ['object_key', 'candidate_key', 'lease_id', 'sha256', 'scan_report', 'preparation_id', 'stream'])
    assert(!result.text.includes(`"${forbidden}"`));
  return upload;
}
async function reserve({ session = sessions.guardian, file = manifest(), clientId = randomUUID(), at = room } = {}) {
  const result = await call(`${at}/uploads`, { method: 'POST', session, body: { clientId, file } });
  const upload = publicUpload(result, 'pending', { reserved: true });
  reservedCount++;
  active.set(upload.id, { session, at });
  return { upload, clientId, file };
}
const receive = (upload, options = {}) => call(`${options.at ?? room}/uploads/${upload.id}/content`, {
  method: 'POST', session: options.session ?? sessions.guardian, bytes: options.bytes ?? png,
  headers: { 'X-Carebridge-Upload-Version': String(upload.version), ...options.headers },
  ...(options.chunked ? { chunked: true } : {}),
});
async function row(id) {
  return (await sandbox.database.query('SELECT * FROM cb_media_uploads WHERE center_id=$1 AND id=$2', [sandbox.ids.centerId, id])).rows[0];
}
async function until(condition, description) {
  const deadline = performance.now() + 4000;
  do {
    if (await condition()) return;
    await delay(10);
  } while (performance.now() < deadline);
  assert.fail(description);
}
function incompleteReceive(upload) {
  const req = request({ hostname: '127.0.0.1', port: new URL(sandbox.origin).port,
    path: `${room}/uploads/${upload.id}/content`, method: 'POST', agent: false,
    headers: { Host: new URL(sandbox.origin).host, Origin: sandbox.origin,
      'X-Carebridge-Request': '1', Cookie: sessions.guardian.cookie, 'X-Carebridge-Account': sessions.guardian.userId,
      'Content-Type': 'application/octet-stream', 'Content-Length': String(png.length),
      'X-Carebridge-Upload-Version': String(upload.version) },
  }, (response) => response.resume());
  req.on('error', () => {}); // An explicit disconnect is the tested transport failure.
  req.setTimeout(6000, () => req.destroy());
  req.write(png.subarray(0, 8));
  return req;
}
async function cancel(id) {
  const { session, at } = active.get(id);
  const current = await call(`${at}/uploads/${id}`, { session });
  assert.equal(current.status, 200, 'Cleanup must retain owner access.');
  const result = await call(`${at}/uploads/${id}/cancel`, { method: 'POST', session, body: { expectedVersion: current.json.upload.version } });
  assert.equal(result.status, 200, 'Owned synthetic reservation must be cancellable.');
  active.delete(id);
  return result;
}

async function startSandbox() {
  sandbox = await createLocalApiSandbox();
  const { ids, database } = sandbox, suffix = randomUUID();
  room = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
  const otherChild = `media-child-${suffix}`, otherId = `media-room-${suffix}`, foreignCenter = `media-center-${suffix}`;
  const foreignChild = `foreign-child-${suffix}`, foreignId = `foreign-room-${suffix}`;
  otherRoom = `/api/local/centers/${ids.centerId}/conversations/${otherId}`;
  foreignRoom = `/api/local/centers/${foreignCenter}/conversations/${foreignId}`;
  extras = Object.fromEntries(['manager', 'stranger', 'foreign'].map((role) => [role, {
    userId: `media-${role}-${suffix}`, email: `${role}.${suffix}@synthetic.test`, password: `Synthetic-only-${randomUUID()}!`,
  }]));
  await database.transaction(async (tx) => {
    for (const account of Object.values(extras)) await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [account.userId]);
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [foreignCenter]);
    await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ($1,$2,'center',true),($1,$3,'guardian',true),($4,$5,'guardian',true)`,
    [ids.centerId, extras.manager.userId, extras.stranger.userId, foreignCenter, extras.foreign.userId]);
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2),($3,$4)', [ids.centerId, otherChild, foreignCenter, foreignChild]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3),($4,$5,$6)',
      [ids.centerId, otherId, otherChild, foreignCenter, foreignId, foreignChild]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ($1,$2,$3,'guardian',true,1),($1,$2,$4,'therapist',true,1),($5,$6,$7,'guardian',true,1)`,
    [ids.centerId, otherId, ids.guardianId, ids.therapistId, foreignCenter, foreignId, extras.foreign.userId]);
  });
  const auth = new Auth(database);
  for (const account of Object.values(extras)) await auth.provisionAccount(account);
  sessions = {};
  for (const role of ['guardian', 'therapist', 'manager', 'stranger', 'foreign']) sessions[role] = await login(role);
  reservedCount = 0;
}
before(startSandbox);
beforeEach(async () => {
  // Keep the actual fixed 8/hour policy. New isolated runs, not a test policy
  // override, leave enough capacity for the largest (three-reservation) case.
  if (reservedCount < 5) return;
  const root = sandbox.mediaRoot;
  await sandbox.close();
  await assert.rejects(stat(root), { code: 'ENOENT' });
  for (const account of Object.values(extras)) { account.password = ''; account.email = ''; }
  await startSandbox();
});
afterEach(async () => { if (!sandbox?.database.closed) for (const id of [...active.keys()]) await cancel(id); });
after(async () => { await sandbox?.close(); });

test('actual PNG bytes are quarantined and privately persisted without inspection or message binding', async () => {
  const { upload } = await reserve();
  const received = publicUpload(await receive(upload), 'quarantined');
  assert.equal(received.version, upload.version + 2);
  assert.equal(received.failureCode, null);
  const stored = await row(upload.id);
  assert.equal(stored.state, 'quarantined'); assert.equal(stored.preparation_required, true);
  for (const name of ['candidate_key', 'preparation_id', 'prepared_sha256', 'scan_report', 'lease_id', 'bound_message_id']) assert.equal(stored[name], null);
  const bytes = await readFile(join(sandbox.mediaRoot, `${stored.object_key}.blob`));
  assert.equal(bytes.length, png.length); assert.equal(digest(bytes), digest(png));
  assert.deepEqual(bytes, png);
  const queue = (await sandbox.database.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1', [upload.id])).rows;
  assert.deepEqual(queue, [{ state: 'queued', attempts: 0 }]);
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS n FROM cb_media_preparations')).rows[0].n, 0);
  const status = publicUpload(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian }), 'quarantined');
  assert.equal(status.version, received.version);
  assert.equal((await row(upload.id)).version, received.version, 'Status reads never run a worker.');
});

test('cancel acknowledges deletion, retains a tombstone and removes only its tracked private object', async () => {
  const { upload, clientId, file } = await reserve();
  publicUpload(await receive(upload), 'quarantined');
  const stored = await row(upload.id), path = join(sandbox.mediaRoot, `${stored.object_key}.blob`);
  const result = await cancel(upload.id);
  assert.equal(result.json.mode, 'quarantine-only');
  assert(['delete_pending', 'deleted'].includes(result.json.upload.state));
  const current = publicUpload(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian }), 'deleted');
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal((await sandbox.database.query('SELECT state FROM cb_media_objects WHERE key=$1', [stored.object_key])).rows[0].state, 'deleted');
  assert.equal((await sandbox.database.query('SELECT state FROM cb_media_work_queue WHERE upload_id=$1', [upload.id])).rows[0].state, 'cancelled');
  const again = await call(`${room}/uploads/${upload.id}/cancel`, { method: 'POST', session: sessions.guardian, body: { expectedVersion: upload.version } });
  assert.equal(again.status, 200); assert.equal(again.json.upload.version, current.version);
  const replay = await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId, file } });
  const tombstone = publicUpload(replay, 'deleted', { reserved: true });
  assert.equal(tombstone.id, upload.id); assert.equal(tombstone.replayed, true);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('unknown reservation response and changed payload retries keep one immutable upload ID', async () => {
  const { upload, clientId, file } = await reserve();
  // Intentionally discard the first receipt: retry the exact immutable request.
  const replay = publicUpload(await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId, file } }), 'pending', { reserved: true });
  assert.equal(replay.id, upload.id); assert.equal(replay.replayed, true);
  publicUpload(await receive(upload), 'quarantined');
  const afterReceive = publicUpload(await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId, file } }), 'quarantined', { reserved: true });
  assert.equal(afterReceive.id, upload.id);
  for (const [at, changed] of [[room, { ...file, name: 'changed.png' }], [otherRoom, file]])
    checkError(await call(`${at}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId, file: changed } }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS n FROM cb_media_uploads WHERE client_id=$1', [clientId])).rows[0].n, 1);
});

test('stale receive/cancel and repeat content cannot replace the committed quarantined bytes', async () => {
  const { upload } = await reserve();
  const current = publicUpload(await receive(upload), 'quarantined');
  checkError(await receive(upload), 409, 'UPLOAD_CONFLICT');
  checkError(await receive(current), 409, 'UPLOAD_STATE');
  checkError(await call(`${room}/uploads/${upload.id}/cancel`, { method: 'POST', session: sessions.guardian, body: { expectedVersion: upload.version } }), 409, 'UPLOAD_CONFLICT');
  const stored = await row(upload.id);
  assert.equal(stored.version, current.version);
  assert.equal(digest(await readFile(join(sandbox.mediaRoot, `${stored.object_key}.blob`))), digest(png));
});

test('other participants, unrelated accounts, another room and another center cannot consume an upload ID', async () => {
  const { upload } = await reserve();
  for (const session of [sessions.therapist, sessions.manager, sessions.stranger, sessions.foreign]) {
    checkError(await call(`${room}/uploads/${upload.id}`, { session }), 404, 'NOT_FOUND');
    checkError(await receive(upload, { session }), 404, 'NOT_FOUND');
    checkError(await call(`${room}/uploads/${upload.id}/cancel`, { method: 'POST', session, body: { expectedVersion: upload.version } }), 404, 'NOT_FOUND');
  }
  for (const at of [otherRoom, foreignRoom]) {
    checkError(await call(`${at}/uploads/${upload.id}`, { session: sessions.guardian }), 404, 'NOT_FOUND');
    checkError(await receive(upload, { at }), 404, 'NOT_FOUND');
  }
  for (const session of [sessions.manager, sessions.stranger, sessions.foreign])
    checkError(await call(`${room}/uploads`, { method: 'POST', session, body: { clientId: randomUUID(), file: manifest() } }), 404, 'NOT_FOUND');
  assert.equal((await row(upload.id)).version, upload.version);
  assert.equal((await row(upload.id)).object_key, null);
});

test('an authenticated therapist may independently reserve bytes without acquiring a guardian upload', async () => {
  const { upload } = await reserve({ session: sessions.therapist });
  publicUpload(await receive(upload, { session: sessions.therapist }), 'quarantined');
  checkError(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian }), 404, 'NOT_FOUND');
  assert.equal((await row(upload.id)).owner_id, sessions.therapist.userId);
});

test('authentication and expected-account checks run before binary storage or owner mutation', async () => {
  const { upload } = await reserve();
  for (const headers of [{ Cookie: undefined }, { 'X-Carebridge-Account': undefined }, { 'X-Carebridge-Account': sessions.therapist.userId }]) {
    checkError(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian, headers }), 401, 'AUTH_REQUIRED');
    checkError(await receive(upload, { headers }), 401, 'AUTH_REQUIRED');
  }
  const replacedCookie = { Cookie: sessions.therapist.cookie, 'X-Carebridge-Account': sessions.guardian.userId };
  checkError(await receive(upload, { headers: replacedCookie }), 401, 'AUTH_REQUIRED');
  assert.equal((await row(upload.id)).object_key, null);
  assert.equal((await row(upload.id)).version, upload.version);
  const fresh = await login('guardian');
  assert.equal((await call('/api/local/auth/logout', { method: 'POST', session: fresh, body: {} })).status, 204);
  checkError(await receive(upload, { session: fresh }), 401, 'AUTH_REQUIRED');
});

test('exact Origin and CSRF header protect all mutations while GET rejects other-site metadata', async () => {
  const { upload } = await reserve();
  for (const headers of [{ Origin: undefined }, { Origin: 'null' }, { Origin: 'http://127.0.0.1:1' },
    { 'X-Carebridge-Request': undefined }, { 'X-Carebridge-Request': 'true' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const code = headers.Origin !== undefined || headers['Sec-Fetch-Site'] ? 'LOCAL_REQUEST_UNAVAILABLE' : 'SOURCE_REJECTED';
    checkError(await receive(upload, { headers }), 403, code);
    checkError(await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId: randomUUID(), file: manifest() }, headers }), 403, code);
    checkError(await call(`${room}/uploads/${upload.id}/cancel`, { method: 'POST', session: sessions.guardian, body: { expectedVersion: upload.version }, headers }), 403, code);
  }
  checkError(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian, headers: { 'Sec-Fetch-Site': 'same-site' } }), 403, 'LOCAL_REQUEST_UNAVAILABLE');
  assert.equal((await row(upload.id)).version, upload.version);
});

test('raw content accepts only octet-stream and a single canonical positive upload version', async () => {
  const { upload } = await reserve();
  for (const value of [undefined, '', '0', '-1', '01', '1.0', '2147483648', '1, 1'])
    checkError(await receive(upload, { headers: { 'X-Carebridge-Upload-Version': value } }), 400, 'INVALID_INPUT');
  for (const type of ['application/json', 'image/png', 'multipart/form-data', 'application/octet-stream; charset=utf-8'])
    checkError(await receive(upload, { headers: { 'Content-Type': type } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  checkError(await receive(upload, { headers: { 'Content-Encoding': 'gzip' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  const rawHeaders = ['Host', new URL(sandbox.origin).host, 'Origin', sandbox.origin, 'X-Carebridge-Request', '1',
    'Cookie', sessions.guardian.cookie, 'X-Carebridge-Account', sessions.guardian.userId,
    'Content-Type', 'application/octet-stream', 'Content-Length', String(png.length),
    'X-Carebridge-Upload-Version', '1', 'X-Carebridge-Upload-Version', '1'];
  checkError(await call(`${room}/uploads/${upload.id}/content`, { method: 'POST', bytes: png, rawHeaders }), 400, 'INVALID_INPUT');
  assert.equal((await row(upload.id)).version, upload.version);
});

test('fixed Content-Length must equal the reservation and fit the hard bound; chunked input is refused', async () => {
  const { upload } = await reserve();
  for (const size of [0, png.length - 1, png.length + 1])
    checkError(await receive(upload, { bytes: Buffer.alloc(size), headers: { 'Content-Length': String(size) } }), 400, 'INVALID_INPUT');
  checkError(await receive(upload, { headers: { 'Content-Length': String(50 * 1024 * 1024 + 1) } }), 413, 'PAYLOAD_TOO_LARGE');
  checkError(await receive(upload, { chunked: true }), 400, 'INVALID_INPUT');
  assert.equal((await row(upload.id)).version, upload.version);
  assert.equal((await row(upload.id)).object_key, null);
});

test('a literally absent Content-Length is rejected without waiting for or claiming a body', async () => {
  const { upload } = await reserve(), target = new URL(sandbox.origin);
  const response = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(target.port) });
    const chunks = [];
    socket.once('error', reject);
    socket.setTimeout(8000, () => socket.destroy(new Error('Synthetic header-only HTTP timeout.')));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('connect', () => socket.write([
      `POST ${room}/uploads/${upload.id}/content HTTP/1.1`, `Host: ${target.host}`, `Origin: ${sandbox.origin}`,
      'X-Carebridge-Request: 1', `Cookie: ${sessions.guardian.cookie}`, `X-Carebridge-Account: ${sessions.guardian.userId}`,
      'Content-Type: application/octet-stream', 'X-Carebridge-Upload-Version: 1', 'Connection: close', '', '',
    ].join('\r\n')));
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /"error":"INVALID_INPUT"/);
  assert.equal((await row(upload.id)).version, upload.version);
});

test('untrusted filename, MIME, limits and injected manifest or reservation authority never create rows', async () => {
  const before = (await sandbox.database.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n;
  for (const file of [manifest({ name: '../private.png' }), manifest({ name: 'bad\r\nname.png' }),
    manifest({ type: 'image/svg+xml' }), manifest({ size: 0 }), manifest({ size: 10 * 1024 * 1024 + 1 }),
    manifest({ type: 'video/mp4', size: 50 * 1024 * 1024 + 1 }), manifest({ sha256: 'invalid' }),
    manifest({ object_key: randomUUID() }), manifest({ state: 'ready' }), manifest({ share: true })])
    checkError(await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId: randomUUID(), file } }), 400, 'INVALID_INPUT');
  for (const key of ['userId', 'role', 'centerId', 'conversationId', 'scanner', 'preparation', 'objectKey', 'state'])
    checkError(await call(`${room}/uploads`, { method: 'POST', session: sessions.guardian, body: { clientId: randomUUID(), file: manifest(), [key]: 'injected' } }), 400, 'INVALID_INPUT');
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS n FROM cb_media_uploads')).rows[0].n, before);
});

test('hash and signature mismatch return a safe rejected state rather than approving or keeping bytes', async () => {
  for (const scenario of [{ file: manifest({ sha256: '0'.repeat(64) }), bytes: png, code: 'HASH_MISMATCH' },
    { file: manifest({ sha256: digest(Buffer.alloc(png.length)) }), bytes: Buffer.alloc(png.length), code: 'FORMAT_MISMATCH' }]) {
    const { upload } = await reserve({ file: scenario.file });
    const rejected = publicUpload(await receive(upload, { bytes: scenario.bytes }), 'rejected');
    assert.equal(rejected.failureCode, scenario.code);
    const stored = await row(upload.id);
    assert.equal(stored.object_key, null); assert.equal(stored.preparation_id, null);
    const objects = (await sandbox.database.query('SELECT key FROM cb_media_objects WHERE upload_id=$1', [upload.id])).rows;
    for (const object of objects) await assert.rejects(stat(join(sandbox.mediaRoot, `${object.key}.blob`)), { code: 'ENOENT' });
  }
});

test('inspection, approval, maintenance and every direct byte/download path remain unavailable', async () => {
  const { upload } = await reserve();
  publicUpload(await receive(upload), 'quarantined');
  for (const [suffix, method] of [['data', 'GET'], ['content', 'GET'], ['preview', 'GET'], ['download', 'GET'],
    ['inspect', 'POST'], ['ready', 'POST'], ['settle', 'POST'], ['cleanup', 'POST']])
    checkError(await call(`${room}/uploads/${upload.id}/${suffix}`, { method, session: sessions.guardian, ...(method === 'POST' ? { body: {} } : {}) }), 404, 'NOT_FOUND');
  for (const path of [`${room}/uploads/cleanup`, '/api/local/media/cleanup'])
    checkError(await call(path, { method: 'POST', session: sessions.guardian, body: {} }), 404, 'NOT_FOUND');
  const stored = await row(upload.id);
  for (const path of [`/${stored.object_key}.blob`, `/uploads/${stored.object_key}.blob`, `/media/${stored.object_key}.blob`]) {
    const result = await call(path, { session: sessions.guardian });
    assert.equal(result.status, 404); assert(!result.text.includes(png.toString('base64')));
  }
  assert.equal(stored.state, 'quarantined');
  assert.equal((await sandbox.database.query('SELECT attempts FROM cb_media_work_queue WHERE upload_id=$1', [upload.id])).rows[0].attempts, 0);
});

test('strict upload paths, query keys and cancel inputs reject client scope or ready-state injection', async () => {
  const { upload } = await reserve();
  for (const path of [`${room}/uploads/${upload.id}?role=guardian`, `${room}/uploads/${upload.id}?uploadId=${upload.id}`,
    `${room}/uploads/${upload.id}/cancel?expectedVersion=1`])
    checkError(await call(path, { session: sessions.guardian, ...(path.includes('/cancel?') ? { method: 'POST', body: { expectedVersion: 1 } } : {}) }), 400, 'INVALID_INPUT');
  for (const body of [{ expectedVersion: 1, state: 'ready' }, { expectedVersion: 1, uploadId: upload.id }, { expectedVersion: '1' }, {}])
    checkError(await call(`${room}/uploads/${upload.id}/cancel`, { method: 'POST', session: sessions.guardian, body }), 400, 'INVALID_INPUT');
  checkError(await call(`${room}/uploads/${upload.id}`, { method: 'POST', session: sessions.guardian, body: {} }), 404, 'NOT_FOUND');
  checkError(await call(`${room}/uploads/${upload.id}/cancel`, { session: sessions.guardian }), 404, 'NOT_FOUND');
  assert.equal((await row(upload.id)).version, upload.version);
});

test('quarantined IDs cannot be sent through text messages or silently bound to a record', async () => {
  const { upload } = await reserve();
  publicUpload(await receive(upload), 'quarantined');
  const count = (await sandbox.database.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n;
  checkError(await call(`${room}/messages`, { method: 'POST', session: sessions.guardian,
    body: { clientId: randomUUID(), body: '합성 첨부 우회 요청', attachments: [{ id: upload.id }] } }), 409, 'ATTACHMENTS_NOT_CONNECTED');
  checkError(await call(`${room}/records/synthetic-media-record`, { method: 'POST', session: sessions.therapist,
    body: { clientId: randomUUID(), expectedRevision: 0, content: { attachments: [{ id: upload.id, share: true }] } } }), 409, 'ATTACHMENTS_NOT_CONNECTED');
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS n FROM cb_messages')).rows[0].n, count);
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS n FROM cb_message_attachments WHERE upload_id=$1', [upload.id])).rows[0].n, 0);
  assert.equal((await row(upload.id)).state, 'quarantined');
});

test('current account membership and room relationship are checked again before reading or receiving', async () => {
  const { upload } = await reserve();
  const cases = [
    ['UPDATE cb_memberships SET active=$3 WHERE center_id=$1 AND user_id=$2', [sandbox.ids.centerId, sandbox.ids.guardianId]],
    ['UPDATE cb_participants SET active=$4 WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [sandbox.ids.centerId, sandbox.ids.conversationId, sandbox.ids.guardianId]],
  ];
  for (const [sql, params] of cases) {
    try {
      await sandbox.database.query(sql, [...params, false]);
      checkError(await call(`${room}/uploads/${upload.id}`, { session: sessions.guardian }), 404, 'NOT_FOUND');
      checkError(await receive(upload), 404, 'NOT_FOUND');
    } finally { await sandbox.database.query(sql, [...params, true]); }
  }
  assert.equal((await row(upload.id)).version, upload.version);
  assert.equal((await row(upload.id)).object_key, null);
});

test('two active binary streams bound global capacity and disconnects settle safely before a slot is reused', async () => {
  const first = (await reserve()).upload, second = (await reserve()).upload;
  const third = (await reserve({ session: sessions.therapist, at: otherRoom })).upload;
  const thirdScope = { session: sessions.therapist, at: otherRoom };
  const requests = [];
  try {
    requests.push(incompleteReceive(first));
    await until(async () => (await row(first.id)).state === 'receiving', 'First partial stream must acquire its lease.');
    requests.push(incompleteReceive(second));
    await until(async () => (await row(second.id)).state === 'receiving', 'Second partial stream must acquire its lease.');
    checkError(await receive(third, thirdScope), 409, 'UPLOAD_BUSY');
    assert.equal((await row(third.id)).version, third.version);
    assert.equal((await row(third.id)).object_key, null);
    for (const req of requests) req.destroy();
    await until(async () => (await row(first.id)).state === 'pending' && (await row(second.id)).state === 'pending',
      'Disconnected streams must settle rather than retaining receive leases.');
    for (const upload of [first, second]) {
      const stored = await row(upload.id);
      assert.equal(stored.failure_code, 'UPLOAD_INTERRUPTED'); assert.equal(stored.object_key, null);
      const objects = (await sandbox.database.query('SELECT key FROM cb_media_objects WHERE upload_id=$1', [upload.id])).rows;
      for (const object of objects) await assert.rejects(stat(join(sandbox.mediaRoot, `${object.key}.blob`)), { code: 'ENOENT' });
    }
    // A pending DB state does not prove that the disconnected HTTP handler has
    // finished cleanup and released its slot. Retry only this unchanged request
    // after an explicit no-write UPLOAD_BUSY, never after an unknown outcome.
    await until(async () => {
      const result = await receive(third, thirdScope);
      if (result.status === 200) {
        publicUpload(result, 'quarantined');
        return true;
      }
      checkError(result, 409, 'UPLOAD_BUSY');
      const unchanged = await row(third.id);
      assert.equal(unchanged.version, third.version);
      assert.equal(unchanged.object_key, null);
      return false;
    }, 'The unchanged third upload must become usable after receive cleanup releases a slot.');
  } finally {
    for (const req of requests) req.destroy();
    await until(async () => !['receiving'].includes((await row(first.id)).state) && !['receiving'].includes((await row(second.id)).state),
      'Owned partial stream tasks must finish before test cleanup.');
  }
});

test('shutdown removes its temporary quarantine root, closes memory data and cannot leave a listening origin', async () => {
  const { upload } = await reserve();
  publicUpload(await receive(upload), 'quarantined');
  const root = sandbox.mediaRoot;
  assert.equal(Object.keys(sandbox).includes('mediaRoot'), false);
  assert(!JSON.stringify(sandbox).includes(root));
  assert((await readdir(root)).some((name) => name.endsWith('.blob')));
  const first = sandbox.close();
  assert.equal(sandbox.close(), first);
  await first;
  active.clear();
  await assert.rejects(stat(root), { code: 'ENOENT' });
  assert.equal(sandbox.database.closed, true);
  await assert.rejects(call('/api/local/auth/session'), { code: 'ECONNREFUSED' });
});
