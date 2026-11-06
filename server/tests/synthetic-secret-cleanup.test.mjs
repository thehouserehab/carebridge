import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSyntheticSecretCleanup } from '../synthetic-secret-cleanup.mjs';
import { regularDirectoryChain } from '../windows-synthetic-postgres-runtime.mjs';

// Actual temporary filesystem, synthetic bytes and injected acknowledgement
// failures only. No E drive, database, Docker, secret provider or native child.
const unavailable = { message: 'SYNTHETIC_SECRET_CLEANUP_UNAVAILABLE' };
const failOnce = () => Object.assign(new Error('injected temporary failure'), { code: 'EACCES' });
async function fixture(t, changeIo = (io) => io, { beforeRelease } = {}) {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(base, 'carebridge-secret-cleanup-'));
  const identity = await fs.lstat(root, { bigint: true }), handles = new Set(), calls = [];
  const roots = [join(root, 'tls'), join(root, 'credentials')], lockPath = join(root, '.session-lock');
  let pending = false;
  const io = changeIo({ ...fs,
    async open(...args) { const handle = await fs.open(...args); handles.add(handle); return handle; },
    async unlink(file) { calls.push(['unlink', file]); return fs.unlink(file); },
    async rmdir(file) { calls.push(['rmdir', file]); return fs.rmdir(file); },
  });
  const cleanup = createSyntheticSecretCleanup({ roots, lockPath, regularDirectoryChain,
    hasPendingSecrets: () => pending, beforeRelease, io });
  t.after(async () => {
    for (const handle of handles) await handle.close();
    // Only this newly created test directory, with the original root identity.
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(resolve(await fs.realpath(root)), resolve(root)); assert.equal(dirname(resolve(root)), resolve(base));
    assert(basename(root).startsWith('carebridge-secret-cleanup-'));
    assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true });
  });
  const acquire = () => cleanup.acquireLock(Buffer.from('synthetic owned lock'));
  async function populate() {
    for (const directory of roots) {
      await fs.mkdir(directory);
      for (const name of ['a.key', 'b.key']) await fs.writeFile(join(directory, name), `synthetic ${basename(directory)} ${name}`);
    }
  }
  const inventory = async () => { for (const directory of roots) await cleanup.inventory(directory, ['a.key', 'b.key']); };
  const absent = async (file) => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  const intact = async () => {
    assert.equal(await fs.readFile(lockPath, 'utf8'), 'synthetic owned lock');
    for (const directory of roots) for (const name of ['a.key', 'b.key'])
      assert.equal(await fs.readFile(join(directory, name), 'utf8'), `synthetic ${basename(directory)} ${name}`);
  };
  return { root, roots, lockPath, cleanup, calls, acquire, populate, inventory, absent, intact,
    pending: (value) => { pending = value; } };
}

test('sealed exact files are removed before the owned lock, with idempotent acknowledged completion', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate(); await f.inventory();
  const first = f.cleanup.dispose(); assert.equal(f.cleanup.dispose(), first); await first;
  for (const entry of [...f.roots, f.lockPath]) await f.absent(entry);
  assert.deepEqual(f.calls.at(-1), ['unlink', f.lockPath]);
  assert.deepEqual(f.cleanup.status(), { completed: true, lockOwned: true, lockRemoved: true, pendingRoots: 0 });
  const count = f.calls.length; await f.cleanup.dispose(); assert.equal(f.calls.length, count);
});

test('partial file unlink failure retains only remaining work and succeeds on the same owned retry', async (t) => {
  let rejected = false;
  const f = await fixture(t, (io) => ({ ...io, async unlink(file) {
    if (basename(dirname(file)) === 'tls' && basename(file) === 'b.key' && !rejected) { rejected = true; throw failOnce(); }
    return io.unlink(file);
  } }));
  await f.acquire(); await f.populate(); await f.inventory();
  await assert.rejects(f.cleanup.dispose(), unavailable);
  await f.absent(join(f.roots[0], 'a.key')); assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
  assert.equal(f.cleanup.status().completed, false);
  await f.cleanup.dispose(); for (const entry of [...f.roots, f.lockPath]) await f.absent(entry);
  assert.equal(f.calls.filter(([kind, file]) => kind === 'unlink' && file === join(f.roots[0], 'a.key')).length, 1);
});

test('rmdir failure after acknowledged file deletion retries the empty owned directory', async (t) => {
  let rejected = false;
  const f = await fixture(t, (io) => ({ ...io, async rmdir(directory) {
    if (basename(directory) === 'tls' && !rejected) { rejected = true; throw failOnce(); }
    return io.rmdir(directory);
  } }));
  await f.acquire(); await f.populate(); await f.inventory();
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(await fs.readdir(f.roots[0]), []);
  assert.equal(f.cleanup.status().lockRemoved, false);
  await f.cleanup.dispose(); for (const entry of [...f.roots, f.lockPath]) await f.absent(entry);
});

test('lock close followed by unlink failure retains the seal for exact-path retry', async (t) => {
  let rejected = false;
  const f = await fixture(t, (io) => ({ ...io, async unlink(file) {
    if (basename(file) === '.session-lock' && !rejected) { rejected = true; throw failOnce(); }
    return io.unlink(file);
  } }));
  await f.acquire(); await f.populate(); await f.inventory();
  await assert.rejects(f.cleanup.dispose(), unavailable);
  for (const directory of f.roots) await f.absent(directory);
  assert.equal(f.cleanup.status().completed, false); assert.equal(f.cleanup.status().lockRemoved, false);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
  await f.cleanup.dispose(); await f.absent(f.lockPath); assert.equal(f.cleanup.status().completed, true);
});

test('existing but unsealed partial key inventory prevents every deletion and lock release', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate();
  await f.cleanup.inventory(f.roots[0], ['a.key', 'b.key']);
  await assert.rejects(f.cleanup.inventory(f.roots[1], ['a.key', 'missing.key']), unavailable);
  await assert.rejects(f.cleanup.dispose(), unavailable); await f.intact(); assert.deepEqual(f.calls, []);
  await assert.rejects(f.cleanup.inventory(f.roots[1], ['a.key', 'b.key']), unavailable);
  assert.equal(f.cleanup.status().completed, false);
});

test('pending init-password evidence holds all keys and the lock until the provider confirms absence', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate(); await f.inventory(); f.pending(true);
  await assert.rejects(f.cleanup.dispose(), unavailable); await f.intact(); assert.deepEqual(f.calls, []);
  f.pending(false); await f.cleanup.dispose(); await f.absent(f.lockPath);
});

test('same-inode changed key content and unexpected files fail closed before any deletion', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate(); await f.inventory();
  const file = join(f.roots[1], 'b.key'); await fs.writeFile(file, 'foreign modified content');
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(file, 'utf8'), 'foreign modified content');
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
  await fs.writeFile(file, 'synthetic credentials b.key'); await fs.writeFile(join(f.roots[0], 'foreign.key'), 'foreign');
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
});

test('same-path replacement file and directory identities are not adopted even with matching contents', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate(); await f.inventory();
  const file = join(f.roots[0], 'a.key'), moved = join(f.root, 'held-original.key');
  await fs.rename(file, moved); await fs.writeFile(file, await fs.readFile(moved));
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
  await fs.unlink(file); await fs.rename(moved, file);
  const held = join(f.root, 'held-original-directory'); await fs.rename(f.roots[0], held); await fs.mkdir(f.roots[0]);
  // Move the same sealed files into a different root identity: file identity
  // alone must not authorize removing the replacement directory.
  for (const name of ['a.key', 'b.key']) await fs.rename(join(held, name), join(f.roots[0], name));
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
  assert.equal((await fs.readdir(f.roots[0])).length, 2);
});

test('a foreign existing lock is neither adopted nor removed after exclusive acquisition fails', async (t) => {
  const f = await fixture(t); await fs.writeFile(f.lockPath, 'foreign lock');
  await assert.rejects(f.acquire(), { code: 'EEXIST' });
  await f.cleanup.dispose(); assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'foreign lock');
  assert.equal(f.cleanup.status().lockOwned, false); assert.deepEqual(f.calls, []);
});

test('a replaced lock after close/unlink failure cannot be removed on retry', async (t) => {
  let rejected = false;
  const f = await fixture(t, (io) => ({ ...io, async unlink(file) {
    if (basename(file) === '.session-lock' && !rejected) { rejected = true; throw failOnce(); }
    return io.unlink(file);
  } }));
  await f.acquire(); await f.populate(); await f.inventory(); await assert.rejects(f.cleanup.dispose(), unavailable);
  await fs.rename(f.lockPath, join(f.root, 'held-original-lock'));
  await fs.writeFile(f.lockPath, 'synthetic owned lock');
  const count = f.calls.length;
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.equal(f.calls.length, count);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock'); assert.equal(f.cleanup.status().completed, false);
});

test('an unsealed partial lock write cannot release its pathname', async (t) => {
  const f = await fixture(t, (io) => ({ ...io, async open(file, flags, ...args) {
    const handle = await io.open(file, flags, ...args);
    if (flags !== 'wx') return handle;
    return { writeFile: async (bytes) => { await handle.writeFile(bytes.subarray(0, 4)); throw failOnce(); },
      sync: () => handle.sync(), stat: (options) => handle.stat(options), close: () => handle.close() };
  } }));
  await assert.rejects(f.acquire(), { code: 'EACCES' });
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synt'); assert.equal(f.cleanup.status().completed, false);
});

test('a foreign root recreated after acknowledged removal is never deleted or mistaken for completed cleanup', async (t) => {
  let rejected = false;
  const f = await fixture(t, (io) => ({ ...io, async unlink(file) {
    if (basename(dirname(file)) === 'credentials' && !rejected) { rejected = true; throw failOnce(); }
    return io.unlink(file);
  } }));
  await f.acquire(); await f.populate(); await f.inventory(); await assert.rejects(f.cleanup.dispose(), unavailable);
  await f.absent(f.roots[0]); await fs.mkdir(f.roots[0]); await fs.writeFile(join(f.roots[0], 'foreign.key'), 'foreign');
  const count = f.calls.length;
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.equal(f.calls.length, count);
  assert.equal(await fs.readFile(join(f.roots[0], 'foreign.key'), 'utf8'), 'foreign');
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
});

test('a junction/symlink root is never traversed for capture or cleanup', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate(); await f.inventory();
  const target = join(f.root, 'foreign-target'); await fs.rename(f.roots[0], target);
  await fs.symlink(target, f.roots[0], process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
    assert.equal(await fs.readFile(join(target, 'a.key'), 'utf8'), 'synthetic tls a.key');
    assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
  } finally { await fs.unlink(f.roots[0]); }
});

test('hard-linked and oversized files are not sealed as disposable private keys', async (t) => {
  const f = await fixture(t); await f.acquire(); await f.populate();
  const file = join(f.roots[0], 'a.key'), extra = join(f.root, 'held-hardlink');
  await fs.link(file, extra);
  await assert.rejects(f.inventory(), unavailable); await fs.unlink(extra);
  await fs.writeFile(file, Buffer.alloc(16385, 0x61));
  await assert.rejects(f.inventory(), unavailable);
  await assert.rejects(f.cleanup.dispose(), unavailable); assert.deepEqual(f.calls, []);
  assert.equal((await fs.stat(file)).size, 16385);
});

test('beforeRelease waits after every owned root is absent and before closing or unlinking the lock', async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let callbackCount = 0, lockClosed = false;
  const f = await fixture(t, (io) => ({ ...io, async open(file, flags, ...args) {
    const handle = await io.open(file, flags, ...args);
    if (flags !== 'wx') return handle;
    return { writeFile: (bytes) => handle.writeFile(bytes), sync: () => handle.sync(),
      stat: (options) => handle.stat(options), close: async () => { await handle.close(); lockClosed = true; } };
  } }), { beforeRelease: async () => {
    callbackCount++;
    for (const directory of f.roots) await f.absent(directory);
    assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
    assert.equal(lockClosed, false);
    assert.equal(f.calls.some(([kind, file]) => kind === 'unlink' && file === f.lockPath), false);
    entered.resolve(); await release.promise;
  } });
  await f.acquire(); await f.populate(); await f.inventory();
  const pending = f.cleanup.dispose();
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('certification callback was not awaited'); })]);
    assert.equal(f.cleanup.dispose(), pending);
    assert.deepEqual(f.cleanup.status(), { completed: false, lockOwned: true, lockRemoved: false, pendingRoots: 0 });
  } finally { release.resolve(); await pending; }
  assert.equal(lockClosed, true); await f.absent(f.lockPath);
  assert.deepEqual(f.calls.at(-1), ['unlink', f.lockPath]);
  await f.cleanup.dispose(); assert.equal(callbackCount, 1);
});

test('beforeRelease failure retains the same lock and retries certification without repeating file deletion', async (t) => {
  let callbackCount = 0;
  const f = await fixture(t, undefined, { beforeRelease: async () => {
    callbackCount++;
    for (const directory of f.roots) await f.absent(directory);
    assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
    if (callbackCount === 1) throw failOnce();
  } });
  await f.acquire(); await f.populate(); await f.inventory();
  const lockIdentity = await fs.lstat(f.lockPath, { bigint: true });
  await assert.rejects(f.cleanup.dispose(), unavailable);
  assert.deepEqual(f.cleanup.status(), { completed: false, lockOwned: true, lockRemoved: false, pendingRoots: 0 });
  const retained = await fs.lstat(f.lockPath, { bigint: true });
  assert.equal(retained.dev, lockIdentity.dev); assert.equal(retained.ino, lockIdentity.ino);
  assert.equal(f.calls.some(([kind, file]) => kind === 'unlink' && file === f.lockPath), false);
  const count = f.calls.length;
  await f.cleanup.dispose();
  assert.equal(callbackCount, 2); assert.deepEqual(f.calls.slice(count), [['unlink', f.lockPath]]);
  await f.absent(f.lockPath); assert.equal(f.cleanup.status().completed, true);
});

test('successful beforeRelease may run again after lock unlink failure so the caller owns certification idempotency', async (t) => {
  let rejected = false, certified = false, callbackCount = 0, certificationWrites = 0;
  const f = await fixture(t, (io) => ({ ...io, async unlink(file) {
    if (basename(file) === '.session-lock' && !rejected) { rejected = true; throw failOnce(); }
    return io.unlink(file);
  } }), { beforeRelease: async () => {
    callbackCount++;
    for (const directory of f.roots) await f.absent(directory);
    if (!certified) {
      await fs.writeFile(join(f.root, '.synthetic-closed'), 'synthetic certification', { flag: 'wx' });
      certificationWrites++; certified = true;
    }
  } });
  await f.acquire(); await f.populate(); await f.inventory();
  await assert.rejects(f.cleanup.dispose(), unavailable);
  assert.equal(callbackCount, 1); assert.equal(certificationWrites, 1);
  assert.equal(f.cleanup.status().lockRemoved, false);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'synthetic owned lock');
  await f.cleanup.dispose();
  assert.equal(callbackCount, 2); assert.equal(certificationWrites, 1);
  assert.equal(await fs.readFile(join(f.root, '.synthetic-closed'), 'utf8'), 'synthetic certification');
  await f.absent(f.lockPath); assert.equal(f.cleanup.status().completed, true);
  await f.cleanup.dispose(); assert.equal(callbackCount, 2);
});

test('failed exclusive acquisition never certifies or releases a foreign lock', async (t) => {
  let callbackCount = 0;
  const f = await fixture(t, undefined, { beforeRelease: async () => { callbackCount++; } });
  await fs.writeFile(f.lockPath, 'foreign lock');
  await assert.rejects(f.acquire(), { code: 'EEXIST' });
  await f.cleanup.dispose(); await f.cleanup.dispose();
  assert.equal(callbackCount, 0); assert.equal(await fs.readFile(f.lockPath, 'utf8'), 'foreign lock');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.cleanup.status(), { completed: true, lockOwned: false, lockRemoved: false, pendingRoots: 0 });
});
