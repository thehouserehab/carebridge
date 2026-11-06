import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryBundle, openRecoveryBundle } from '../recovery-bundle.mjs';

const unavailable = { message: 'RECOVERY_BUNDLE_UNAVAILABLE' };
const bytes = Buffer.from('SYNTHETIC-PRIVATE-SNAPSHOT-NOT-A-PATIENT');
const entry = (name, data) => ({ name, open: async function* () { yield data; } });
async function collect(stream) { const chunks = []; for await (const part of stream) chunks.push(Buffer.from(part)); return Buffer.concat(chunks); }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-recovery-unit-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const options = { directory, key: randomBytes(32), runId: randomUUID() };
  const object = randomUUID(), blocked = randomUUID();
  const entries = [entry('snapshot.json', Buffer.from('{"synthetic":true}')), entry('database.pgcustom', bytes),
    entry(`${object}.blob`, Buffer.alloc(180000, 71)), entry(`${blocked}.blocked`, Buffer.alloc(0))];
  return { options, entries, object, blocked, path: join(directory, `${options.runId}.cbb`) };
}

test('bundle authenticates all entries then streams exact multi-frame bytes and empty deletion fence', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const reader = await openRecoveryBundle(f.options); t.after(() => reader.close());
  assert.equal(Object.isFrozen(reader.manifest.entries[0]), true);
  assert.equal(reader.manifest.entries.length, 4);
  assert.deepEqual(await collect(reader.stream('database.pgcustom')), bytes);
  assert.deepEqual(await collect(reader.stream(`${f.object}.blob`)), Buffer.alloc(180000, 71));
  assert.deepEqual(await collect(reader.stream(`${f.blocked}.blocked`)), Buffer.alloc(0));
  assert.deepEqual(await readdir(f.options.directory), [`${f.options.runId}.cbb`]);
});

test('archive has no plaintext manifest, identifiers, clinical sentinel or serialized key', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const encrypted = await readFile(f.path);
  for (const secret of [bytes, Buffer.from(f.object), Buffer.from('snapshot.json'), Buffer.from(f.options.runId), f.options.key])
    assert.equal(encrypted.includes(secret), false);
  assert.deepEqual(bytes, Buffer.from('SYNTHETIC-PRIVATE-SNAPSHOT-NOT-A-PATIENT'));
});

for (const [name, mutate] of [
  ['header version', (b) => { b[0] ^= 1; return b; }],
  ['key derivation salt', (b) => { b[13] ^= 1; return b; }],
  ['ciphertext', (b) => { b[50] ^= 1; return b; }],
  ['authentication tag', (b) => { b[44 + b.readUInt32BE(40)] ^= 1; return b; }],
  ['oversized frame', (b) => { b.writeUInt32BE(0xffffffff, 40); return b; }],
  ['truncation', (b) => b.subarray(0, b.length - 1)],
  ['trailing garbage', (b) => Buffer.concat([b, Buffer.from('garbage')])],
]) test(`tampered ${name} fails before any plaintext is available`, async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  await writeFile(f.path, mutate(await readFile(f.path)));
  await assert.rejects(openRecoveryBundle(f.options), unavailable);
});

test('wrong key or mismatched run receipt cannot open a correctly authenticated archive', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  await assert.rejects(openRecoveryBundle({ ...f.options, key: randomBytes(32) }), unavailable);
  const runId = randomUUID(); await copyFile(f.path, join(f.options.directory, `${runId}.cbb`));
  await assert.rejects(openRecoveryBundle({ ...f.options, runId }), unavailable);
});

test('same run never overwrites completed archive and failed source has no complete filename', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const before = await readFile(f.path);
  await assert.rejects(createRecoveryBundle({ ...f.options, entries: f.entries }), unavailable);
  assert.deepEqual(await readFile(f.path), before);
  const runId = randomUUID();
  const bad = { name: 'database.pgcustom', open: async function* () { yield bytes; throw new Error('SENSITIVE-DRIVER-MESSAGE'); } };
  await assert.rejects(createRecoveryBundle({ ...f.options, runId, entries: [f.entries[0], bad] }), unavailable);
  assert.equal((await readdir(f.options.directory)).includes(`${runId}.cbb`), false);
  assert.equal((await readdir(f.options.directory)).includes(`${runId}.partial`), true);
});

test('missing required entry, duplicate, arbitrary filename or traversal never publishes', async (t) => {
  const f = await fixture(t);
  for (const entries of [[f.entries[0]], [...f.entries, f.entries[0]], [...f.entries, entry('../escape', bytes)],
    [...f.entries, entry('secrets.env', bytes)]]) {
    const runId = randomUUID(); await assert.rejects(createRecoveryBundle({ ...f.options, runId, entries }), unavailable);
    assert.equal((await readdir(f.options.directory)).includes(`${runId}.cbb`), false);
  }
});

test('cancellation leaves only an encrypted incomplete artifact and no successful receipt', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const aborted = { name: 'database.pgcustom', open: async function* () { yield bytes; controller.abort(); yield bytes; } };
  await assert.rejects(createRecoveryBundle({ ...f.options, entries: [f.entries[0], aborted], signal: controller.signal }), unavailable);
  const names = await readdir(f.options.directory); assert.deepEqual(names, [`${f.options.runId}.partial`]);
  assert.equal((await readFile(join(f.options.directory, names[0]))).includes(bytes), false);
});

test('hard links, mutation after verification, closed reader and unknown entries are refused', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const reader = await openRecoveryBundle(f.options);
  await assert.rejects(collect(reader.stream('../escape')), unavailable);
  const original = await readFile(f.path); await writeFile(f.path, Buffer.concat([original, Buffer.from('changed')]));
  await assert.rejects(collect(reader.stream('database.pgcustom')), unavailable); await reader.close();
  await assert.rejects(collect(reader.stream('database.pgcustom')), unavailable);
  await writeFile(f.path, original); await link(f.path, join(f.options.directory, 'extra-link'));
  await assert.rejects(openRecoveryBundle(f.options), unavailable);
});

test('broad/non-private directory or invalid key/run is rejected before creating an artifact', async (t) => {
  const f = await fixture(t);
  for (const extra of [{ directory: tmpdir() }, { directory: '.' }, { key: Buffer.alloc(31) }, { runId: '../../data' }])
    await assert.rejects(createRecoveryBundle({ ...f.options, ...extra, entries: f.entries }), unavailable);
  assert.deepEqual(await readdir(f.options.directory), []);
  if (process.platform !== 'win32') {
    await chmod(f.options.directory, 0o755);
    await assert.rejects(createRecoveryBundle({ ...f.options, entries: f.entries }), unavailable);
  }
});

test('symlinked directory is never used for backup output', async (t) => {
  const f = await fixture(t), target = join(f.options.directory, 'private-target'), alias = join(f.options.directory, 'alias');
  await mkdir(target, { mode: 0o700 });
  try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('OS did not permit creating the synthetic symlink.'); return; } throw e; }
  await assert.rejects(createRecoveryBundle({ ...f.options, directory: alias, entries: f.entries }), unavailable);
  assert.deepEqual(await readdir(target), []);
});

test('reordered authenticated frames and a valid prefix missing its completion frame are refused', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const original = await readFile(f.path), frames = []; let position = 40;
  while (position < original.length) {
    const end = position + 4 + original.readUInt32BE(position) + 16;
    frames.push(original.subarray(position, end)); position = end;
  }
  assert.ok(frames.length > 5);
  const exchanged = [...frames]; [exchanged[1], exchanged[2]] = [exchanged[2], exchanged[1]];
  await writeFile(f.path, Buffer.concat([original.subarray(0, 40), ...exchanged]));
  await assert.rejects(openRecoveryBundle(f.options), unavailable);
  await writeFile(f.path, Buffer.concat([original.subarray(0, 40), ...frames.slice(0, -1)]));
  await assert.rejects(openRecoveryBundle(f.options), unavailable);
});

test('same run and master key in independent private directories derive different bundle keys', async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const optionsB = { ...a.options, directory: b.options.directory };
  await createRecoveryBundle({ ...a.options, entries: a.entries });
  await createRecoveryBundle({ ...optionsB, entries: a.entries });
  const first = await readFile(a.path), second = await readFile(join(b.options.directory, `${a.options.runId}.cbb`));
  assert.equal(first.subarray(8, 40).equals(second.subarray(8, 40)), false);
  const reader = await openRecoveryBundle(optionsB); t.after(() => reader.close());
  assert.deepEqual(await collect(reader.stream('database.pgcustom')), bytes);
});

test('concurrent plaintext streams and close during an active stream cannot invalidate another consumer', async (t) => {
  const f = await fixture(t); await createRecoveryBundle({ ...f.options, entries: f.entries });
  const reader = await openRecoveryBundle(f.options), stream = reader.stream(`${f.object}.blob`);
  assert.equal((await stream.next()).value.length, 65536);
  await assert.rejects(collect(reader.stream('database.pgcustom')), unavailable);
  await assert.rejects(reader.close(), unavailable);
  await stream.return();
  assert.deepEqual(await collect(reader.stream('database.pgcustom')), bytes);
  await reader.close();
});
