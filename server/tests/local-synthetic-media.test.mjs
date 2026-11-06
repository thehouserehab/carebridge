import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { createLocalApiSandbox } from '../local-api-sandbox.mjs';
import { createLocalSyntheticMedia, LOCAL_SYNTHETIC_MEDIA_LIMITS } from '../local-synthetic-media.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { rasterPng } from '../image-metadata-test-fixtures.mjs';

// Invented one-pixel content. No decoder/antivirus success is fabricated here:
// the expected terminal content state is quarantine, never ready or public.
const bytes = rasterPng({ width: 1, height: 1 });
const file = () => ({ name: 'synthetic.png', type: 'image/png', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') });
let database;
before(async () => { database = await PGlite.create(); await migrate(database); });
after(async () => { await database?.close(); });

async function fixture(t) {
  const centerId = `synthetic-${randomUUID()}`, childId = `child-${randomUUID()}`, conversationId = `room-${randomUUID()}`;
  const userId = `guardian-${randomUUID()}`, therapistId = `therapist-${randomUUID()}`;
  await database.transaction(async (tx) => {
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [centerId]);
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true),($2,true)', [userId, therapistId]);
    await tx.query("INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'guardian',true),($1,$3,'therapist',true)", [centerId, userId, therapistId]);
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [centerId, childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [centerId, conversationId, childId]);
    await tx.query("INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES ($1,$2,$3,'guardian',true,1),($1,$2,$4,'therapist',true,1)", [centerId, conversationId, userId, therapistId]);
  });
  const media = await createLocalSyntheticMedia(database, centerId);
  t.after(() => media.close());
  const actor = { centerId, userId };
  const reserve = () => media.mediaUploads.reserve(actor, { conversationId, clientId: randomUUID(), file: file() });
  const input = (upload) => ({ conversationId, uploadId: upload.id, expectedVersion: upload.version });
  const receive = (upload, stream = Readable.from([bytes])) => media.mediaUploads.receive(actor, input(upload), stream);
  return { media, centerId, conversationId, actor, therapistId, reserve, receive, input };
}

test('synthetic limits use the real policy service and leave no bootstrap identity or altered roles', async (t) => {
  const { media, centerId, actor, therapistId } = await fixture(t);
  assert.deepEqual(LOCAL_SYNTHETIC_MEDIA_LIMITS, {
    storageBytes: 125829120, pendingUploads: 4, uploadsPerWindow: 8, windowMilliseconds: 3600000,
  });
  const policy = (await database.query('SELECT * FROM cb_media_resource_limits WHERE center_id=$1', [centerId])).rows[0];
  assert.equal(policy.revision, 1); assert.equal(policy.accepting_uploads, true);
  assert.equal(Number(policy.storage_bytes), LOCAL_SYNTHETIC_MEDIA_LIMITS.storageBytes);
  assert.equal(policy.pending_uploads, 4); assert.equal(policy.uploads_per_window, 8);
  assert.equal(policy.window_milliseconds, 3600000);
  assert.deepEqual((await database.query('SELECT user_id,role FROM cb_memberships WHERE center_id=$1 ORDER BY role', [centerId])).rows,
    [{ user_id: actor.userId, role: 'guardian' }, { user_id: therapistId, role: 'therapist' }]);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM cb_users WHERE id LIKE 'local-policy-%'")).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM cb_media_resource_events WHERE center_id=$1', [centerId])).rows[0].count, 1);
  assert.match(media.root, /carebridge-local-media-[A-Za-z0-9]+$/);
  assert.equal(Object.keys(media).includes('root'), false);
  assert.equal(JSON.stringify(media).includes(media.root), false);
  assert.equal((await lstat(media.root)).isDirectory(), true);
});

test('signature/hash checked bytes stay private and quarantined with no inspection/open capability', async (t) => {
  const { media, actor, therapistId, conversationId, reserve, receive } = await fixture(t);
  const pending = await reserve(), upload = await receive(pending);
  assert.equal(upload.state, 'quarantined'); assert.equal(upload.version, 3);
  assert.deepEqual(Object.keys(media.mediaUploads).sort(), ['cancel', 'get', 'receive', 'reserve']);
  const ledger = (await database.query('SELECT * FROM cb_media_uploads WHERE id=$1', [upload.id])).rows[0];
  assert.deepEqual(await readFile(join(media.root, `${ledger.object_key}.blob`)), bytes);
  assert.equal(ledger.preparation_id, null); assert.equal(ledger.prepared_sha256, null);
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM cb_media_preparations WHERE upload_id=$1', [upload.id])).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM cb_messages WHERE conversation_id=$1', [conversationId])).rows[0].count, 0);
  await assert.rejects(media.mediaUploads.get({ centerId: actor.centerId, userId: therapistId }, { conversationId, uploadId: upload.id }), { code: 'NOT_FOUND' });
  const state = await media.mediaUploads.get(actor, { conversationId, uploadId: upload.id });
  for (const secret of ['object_key', 'sha256', 'scan_report', 'preparation_id', 'lease_id']) assert.equal(secret in state, false);
  assert.equal(JSON.stringify(state).includes(media.root), false);
});

test('small pending and cumulative rate ceilings remain enforced after cancellation', async (t) => {
  const { media, actor, reserve, input } = await fixture(t);
  const uploads = [];
  for (let index = 0; index < 4; index++) uploads.push(await reserve());
  await assert.rejects(reserve(), { code: 'CENTER_MEDIA_BACKLOG' });
  for (const upload of uploads) await media.mediaUploads.cancel(actor, input(upload));
  assert.equal((await media.mediaCleanup()).failed, 0);
  for (let index = 0; index < 4; index++) {
    const upload = await reserve(); await media.mediaUploads.cancel(actor, input(upload)); await media.mediaCleanup();
  }
  await assert.rejects(reserve(), { code: 'CENTER_MEDIA_RATE' });
});

test('cancel deletes tracked quarantine bytes and close removes only its own fences/root', async (t) => {
  const { media, actor, reserve, receive, input } = await fixture(t);
  const upload = await receive(await reserve());
  await media.mediaUploads.cancel(actor, input(upload));
  const cleaned = await media.mediaCleanup();
  assert.deepEqual(cleaned, { removed: 1, failed: 0, finalized: 1 });
  const names = await readdir(media.root);
  assert.equal(names.length, 1); assert.match(names[0], /\.blocked$/);
  const closing = media.close(); assert.equal(media.close(), closing); await closing;
  await assert.rejects(lstat(media.root), { code: 'ENOENT' });
  await assert.rejects(reserve(), /closing/);
});

test('close waits for tracked byte IO instead of removing a receiving file', async (t) => {
  const { media, reserve, receive } = await fixture(t);
  const stream = new PassThrough();
  t.after(() => stream.destroy());
  const receiving = receive(await reserve(), stream);
  const deadline = performance.now() + 5000;
  while (stream.listenerCount('data') === 0) {
    assert.ok(performance.now() < deadline, 'receive must reach its actual byte pipeline');
    await nextTurn();
  }
  let closed = false;
  const closing = media.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false); assert.equal((await lstat(media.root)).isDirectory(), true);
  await assert.rejects(reserve(), /closing/);
  stream.end(bytes);
  assert.equal((await receiving).state, 'quarantined');
  await closing;
  await assert.rejects(lstat(media.root), { code: 'ENOENT' });
});

test('unknown entries stop cleanup before any known file is deleted and allow an explicit safe retry', async (t) => {
  const { media, reserve, receive } = await fixture(t);
  await receive(await reserve());
  const before = await readdir(media.root), unknown = join(media.root, 'not-owned.txt');
  await writeFile(unknown, 'synthetic unknown marker', { flag: 'wx' });
  try {
    await assert.rejects(media.close(), /ownership or cleanup/);
    assert.deepEqual((await readdir(media.root)).sort(), [...before, 'not-owned.txt'].sort());
    assert.equal(await readFile(unknown, 'utf8'), 'synthetic unknown marker');
  } finally { await unlink(unknown); }
  await media.close();
  await assert.rejects(lstat(media.root), { code: 'ENOENT' });
});

test('a substituted root is not deleted and the original root identity is required for retry', async (t) => {
  const { media } = await fixture(t);
  const parked = `${media.root}-owned-held`;
  await rename(media.root, parked);
  await mkdir(media.root);
  try {
    await assert.rejects(media.close(), /ownership or cleanup/);
    assert.equal((await lstat(media.root)).isDirectory(), true);
    assert.equal((await lstat(parked)).isDirectory(), true);
  } finally {
    await rmdir(media.root); // Exact empty substitute created by this test.
    await rename(parked, media.root);
  }
  await media.close();
  await assert.rejects(lstat(media.root), { code: 'ENOENT' });
});

test('sandbox owns a nonpublic temporary root and closes files before its memory database', async () => {
  const sandbox = await createLocalApiSandbox();
  try {
    assert.equal(Object.keys(sandbox).includes('mediaRoot'), false);
    assert.equal(JSON.stringify(sandbox).includes(sandbox.mediaRoot), false);
    assert.equal((await lstat(sandbox.mediaRoot)).isDirectory(), true);
    assert.equal((await sandbox.database.query("SELECT count(*)::integer AS count FROM cb_users")).rows[0].count, 3);
    assert.equal((await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_auth_accounts')).rows[0].count, 3);
    const response = await fetch(`${sandbox.origin}/local-api/media-client.js`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /blob:|data:|media-src/);
    for (const path of ['/uploads', '/server/local-synthetic-media.mjs', `/media/${encodeURIComponent(sandbox.mediaRoot)}`]) {
      assert.equal((await fetch(sandbox.origin + path)).status, 404);
    }
  } finally { await sandbox.close(); }
  assert.equal(sandbox.database.closed, true);
  await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' });
});

test('sandbox cleanup failure retains its database and unknown bytes until an explicit safe retry', async () => {
  const sandbox = await createLocalApiSandbox();
  const marker = join(sandbox.mediaRoot, 'test-owned-unrecognized.txt');
  await writeFile(marker, 'synthetic retained bytes', { flag: 'wx' });
  try {
    await assert.rejects(sandbox.close(), /ownership or cleanup/);
    assert.equal(sandbox.database.closed, false);
    assert.equal((await sandbox.database.query('SELECT 1 AS alive')).rows[0].alive, 1);
    assert.equal(await readFile(marker, 'utf8'), 'synthetic retained bytes');
    assert.deepEqual(sandbox.credentials, []);
    await assert.rejects(fetch(sandbox.origin));
  } finally {
    await unlink(marker); // Only this test's exact, deliberately unknown entry.
    await sandbox.close();
  }
  assert.equal(sandbox.database.closed, true);
  await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' });
});

test('sandbox close drains an already-running HTTP media handler before deleting files or the database', async (t) => {
  const sandbox = await createLocalApiSandbox();
  let release, entered, requestTask, openingTimer;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let wrapped;
  try {
    const credential = sandbox.credentials.find((account) => account.role === 'guardian');
    const login = await fetch(`${sandbox.origin}/api/local/auth/login`, {
      method: 'POST', headers: { Origin: sandbox.origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credential.email, password: credential.password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
    const original = MediaUploads.prototype.reserve;
    wrapped = t.mock.method(MediaUploads.prototype, 'reserve', async function (...args) {
      // Deliberately hold a real routed handler. The real authorization/DB
      // operation resumes unchanged after the test releases this barrier.
      entered(); await gate; return original.apply(this, args);
    });
    const path = `/api/local/centers/${sandbox.ids.centerId}/conversations/${sandbox.ids.conversationId}/uploads`;
    requestTask = fetch(sandbox.origin + path, {
      method: 'POST', headers: { Cookie: cookie, Origin: sandbox.origin, 'Content-Type': 'application/json',
        'X-Carebridge-Request': '1', 'X-Carebridge-Account': sandbox.ids.guardianId },
      body: JSON.stringify({ clientId: randomUUID(), file: file() }), signal: AbortSignal.timeout(10000),
    }).then(async (response) => { await response.arrayBuffer(); return response.status; }, () => 'connection-closed');
    try {
      await Promise.race([started, new Promise((_, reject) => {
        openingTimer = setTimeout(() => reject(new Error('The owned media handler did not start.')), 5000);
      })]);
    } finally { clearTimeout(openingTimer); }
    let closed = false;
    const closing = sandbox.close().then(() => { closed = true; });
    await nextTurn();
    assert.equal(closed, false);
    assert.equal(sandbox.database.closed, false);
    assert.equal((await lstat(sandbox.mediaRoot)).isDirectory(), true);
    release();
    await closing;
    assert.equal(await requestTask, 'connection-closed');
    assert.equal(sandbox.database.closed, true);
    await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' });
  } finally {
    release();
    await requestTask;
    wrapped?.mock.restore();
    await sandbox.close();
  }
});
