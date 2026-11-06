// Internal owned-resource cleanup, not a general file deletion API. The
// trusted session supplies exact roots and directory policy; io exists only
// for deterministic local failure tests. No recursive delete or root adoption.
import * as filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const fail = () => { throw new Error('SYNTHETIC_SECRET_CLEANUP_UNAVAILABLE'); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regularFile = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.size <= 16384n;
const regularDirectory = (s) => s.isDirectory() && !s.isSymbolicLink();
const exactPath = (value) => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && dirname(value) !== value;
const fileName = (value) => typeof value === 'string' && value !== '.' && value !== '..' &&
  value.length > 0 && basename(value) === value && !/[\\/:\x00-\x1f]/.test(value);

export function createSyntheticSecretCleanup({ roots, lockPath, regularDirectoryChain, hasPendingSecrets, beforeRelease, io = filesystem }) {
  if (!Array.isArray(roots) || !roots.length || roots.some((root) => !exactPath(root)) || new Set(roots).size !== roots.length ||
      !exactPath(lockPath) || roots.includes(lockPath) || typeof regularDirectoryChain !== 'function' || typeof hasPendingSecrets !== 'function' ||
      beforeRelease !== undefined && typeof beforeRelease !== 'function') fail();
  const expected = [...roots], inventories = new Map();
  let lock, attempted = false, closing = false, completed = false, disposal;
  const checkPending = () => { if (hasPendingSecrets() !== false) fail(); };
  async function absent(path) {
    try { await io.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    fail();
  }
  async function directory(root, identity) {
    await regularDirectoryChain(root);
    const current = await io.lstat(root, { bigint: true });
    if (!regularDirectory(current) || identity && !sameIdentity(current, identity)) fail();
    return current;
  }
  async function readSeal(path, identity) {
    const before = await io.lstat(path, { bigint: true });
    if (!regularFile(before) || identity && !sameIdentity(before, identity)) fail();
    const handle = await io.open(path, 'r');
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!regularFile(opened) || !sameIdentity(before, opened)) fail();
      bytes = Buffer.alloc(16385);
      let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length > 16384) fail();
      const after = await handle.stat({ bigint: true }), named = await io.lstat(path, { bigint: true });
      if (!regularFile(after) || !regularFile(named) || !sameIdentity(opened, after) || !sameIdentity(after, named) ||
          before.size !== after.size || after.size !== BigInt(length) || after.size !== named.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
          after.mtimeNs !== named.mtimeNs || after.ctimeNs !== named.ctimeNs) fail();
      return { dev: after.dev, ino: after.ino, size: after.size, sha: digest(bytes.subarray(0, length)) };
    } finally { bytes?.fill(0); await handle.close(); }
  }
  async function verifyFile(path, seal) {
    const current = await readSeal(path, seal);
    if (current.size !== seal.size || current.sha !== seal.sha) fail();
  }
  async function acquireLock(bytes) {
    if (attempted || closing || !Buffer.isBuffer(bytes) || bytes.length > 16384) fail();
    attempted = true;
    await regularDirectoryChain(dirname(lockPath));
    const handle = await io.open(lockPath, 'wx', 0o600);
    // Record ownership before write/sync/stat can fail. An unsealed partial
    // lock must be retained, never removed based merely on its pathname.
    lock = { handle, seal: null, removed: false };
    await handle.writeFile(bytes); await handle.sync();
    const identity = await handle.stat({ bigint: true });
    const seal = await readSeal(lockPath, identity);
    if (seal.sha !== digest(bytes) || seal.size !== BigInt(bytes.length)) fail();
    lock.seal = seal;
  }
  async function inventory(root, names) {
    if (closing || !expected.includes(root) || inventories.has(root) || !Array.isArray(names) ||
        !names.length || names.some((name) => !fileName(name)) || new Set(names).size !== names.length) fail();
    const identity = await directory(root), entries = await io.readdir(root);
    if (JSON.stringify(entries.sort()) !== JSON.stringify([...names].sort())) fail();
    const files = new Map();
    for (const name of names) files.set(name, await readSeal(join(root, name)));
    await directory(root, identity);
    // Only the complete inventory is admitted. A partial key write/failure
    // leaves this existing root unsealed and prevents lock release.
    inventories.set(root, { identity, files, removed: false });
  }
  async function verifyRoot(root) {
    const entry = inventories.get(root);
    if (!entry || entry.removed) { await absent(root); return; }
    await directory(root, entry.identity);
    if (JSON.stringify((await io.readdir(root)).sort()) !== JSON.stringify([...entry.files.keys()].sort())) fail();
    for (const [name, seal] of entry.files) await verifyFile(join(root, name), seal);
  }
  async function verifyLock() {
    if (!lock) return; // A failed exclusive open never owns a foreign lock.
    if (lock.removed) { await absent(lockPath); return; }
    if (!lock.seal) fail();
    await regularDirectoryChain(dirname(lockPath));
    await verifyFile(lockPath, lock.seal);
  }
  function dispose() {
    if (disposal) return disposal;
    closing = true;
    disposal = (async () => {
      if (completed) return;
      checkPending(); await verifyLock();
      for (const root of expected) await verifyRoot(root);
      for (const [root, entry] of inventories) {
        if (entry.removed) continue;
        for (const [name, seal] of entry.files) {
          checkPending(); await verifyRoot(root); await verifyLock();
          await verifyFile(join(root, name), seal);
          await io.unlink(join(root, name)); entry.files.delete(name);
        }
        await verifyRoot(root); await io.rmdir(root); entry.removed = true;
      }
      checkPending();
      for (const root of expected) await verifyRoot(root);
      await verifyLock();
      if (lock && !lock.removed) {
        // A retained session may certify a clean stop only after plaintext
        // keys are gone, while the exclusive execution lock is still held.
        await beforeRelease?.();
        await verifyLock();
        if (lock.handle) { await lock.handle.close(); lock.handle = null; }
        // Closing a handle does not mean its directory entry was removed.
        // Keep the seal until the exact-path unlink is acknowledged.
        await verifyLock(); await io.unlink(lockPath); lock.removed = true;
      }
      completed = true;
    })().catch(() => { disposal = undefined; fail(); });
    return disposal;
  }
  return Object.freeze({ acquireLock, inventory, dispose,
    status: () => Object.freeze({ completed, lockOwned: !!lock, lockRemoved: !!lock?.removed,
      pendingRoots: [...inventories.values()].filter((entry) => !entry.removed).length }) });
}
