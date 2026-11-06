import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { MediaUploads } from './media-uploads.mjs';
import { MediaResourcePolicy } from './media-resource-policy.mjs';
import { PrivateFileStore } from './private-file-store.mjs';

// Deliberate synthetic-session ceilings, not an operating plan. The existing
// resource service reserves two format-ceiling slots (100 MiB per video), not
// just the bytes received. There is no scanner, decoder or approval fallback.
export const LOCAL_SYNTHETIC_MEDIA_LIMITS = Object.freeze({
  storageBytes: 120 * 1024 * 1024, pendingUploads: 4,
  uploadsPerWindow: 8, windowMilliseconds: 3600000,
});
const PREFIX = 'carebridge-local-media-';
const OBJECT_NAME = /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(blob|blocked)$/;
const unavailable = () => new Error('Synthetic media ownership or cleanup could not be verified.');

async function boundedDrain(pending) {
  let timer;
  try {
    await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic media operations have not finished.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

async function configure(database, centerId) {
  const userId = `local-policy-${randomUUID()}`;
  await database.transaction(async (tx) => {
    // The bootstrap identity has no login account or room participation and
    // never changes either of the two interactive users' roles. The complete
    // configuration and removal are one transaction through the real service.
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [userId]);
    await tx.query("INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'center',true)", [centerId, userId]);
    const policy = new MediaResourcePolicy({ transaction: (work) => work(tx) });
    await policy.configure({ centerId, userId }, {
      expectedRevision: 0, acceptingUploads: true, ...LOCAL_SYNTHETIC_MEDIA_LIMITS,
    });
    await tx.query('DELETE FROM cb_memberships WHERE center_id=$1 AND user_id=$2', [centerId, userId]);
    await tx.query('DELETE FROM cb_users WHERE id=$1', [userId]);
  });
}

/** A factory-owned temporary quarantine. Never accepts a caller-supplied path. */
export async function createLocalSyntheticMedia(database, centerId) {
  if (!database?.transaction || typeof centerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(centerId)) {
    throw new TypeError('A synthetic transactional database and center are required.');
  }
  await configure(database, centerId);
  const base = resolve(await realpath(tmpdir()));
  const root = resolve(await mkdtemp(join(base, PREFIX)));
  const identity = await lstat(root, { bigint: true });
  const ownedKeys = new Set(), pending = new Set();
  let closing = false, removed = false, closePromise;

  const assertRoot = async () => {
    const rel = relative(base, root);
    if (!isAbsolute(root) || dirname(root) !== base || !rel || isAbsolute(rel) || rel.startsWith('..') ||
        !basename(root).startsWith(PREFIX) || resolve(await realpath(base)) !== base ||
        resolve(await realpath(root)) !== root) throw unavailable();
    const current = await lstat(root, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || !current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw unavailable();
    return current;
  };

  const removeOwnedRoot = async () => {
    await assertRoot();
    // Preflight the WHOLE directory before removing anything. No recursive
    // deletion, symlink traversal, filename supplied by a client or broad glob.
    const entries = await readdir(root);
    const files = [];
    for (const name of entries) {
      const match = OBJECT_NAME.exec(name);
      if (!match || !ownedKeys.has(match[1])) throw unavailable();
      const path = join(root, name), info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (match[2] === 'blocked' && info.size !== 0n)) throw unavailable();
      files.push({ path, info });
    }
    for (const { path, info } of files) {
      await assertRoot();
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
          current.dev !== info.dev || current.ino !== info.ino) throw unavailable();
      await unlink(path);
    }
    await assertRoot();
    await rmdir(root); // Fails closed if an unexpected entry appeared meanwhile.
    removed = true;
  };

  try {
    const store = new PrivateFileStore(root);
    await store.checkRoot();
    await assertRoot();
    const trackedStore = {
      write: async (key, ...args) => { await assertRoot(); ownedKeys.add(key); return store.write(key, ...args); },
      openVerified: async (...args) => { await assertRoot(); return store.openVerified(...args); },
      remove: async (key) => { await assertRoot(); ownedKeys.add(key); return store.remove(key); },
    };
    const service = new MediaUploads(database, trackedStore, {
      preparation: null, ttlMilliseconds: 900000, leaseMilliseconds: 15000, operationTimeoutMilliseconds: 8000,
    });
    const track = (work) => {
      if (closing) return Promise.reject(new Error('Synthetic media is closing.'));
      const task = Promise.resolve().then(async () => { await assertRoot(); return work(); });
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    };
    // No inspect/open/bind method: quarantine-only is also an injected-service
    // boundary, not just an omitted UI button. Existing authorization stays in
    // MediaUploads for every call, including cancellation and status retries.
    const mediaUploads = Object.freeze(Object.fromEntries(['reserve', 'get', 'receive', 'cancel'].map((method) =>
      [method, (...args) => track(() => service[method](...args))])));
    const mediaCleanup = () => track(() => service.cleanup());
    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await boundedDrain(pending);
        if (!removed) await removeOwnedRoot();
      })();
      // A failed drain or ownership check preserves all remaining data. An
      // explicit later close may retry after the cause is safely resolved.
      void closePromise.catch(() => { closePromise = undefined; });
      return closePromise;
    };
    const result = { mediaUploads, mediaCleanup, close };
    Object.defineProperty(result, 'root', { value: root });
    return Object.freeze(result);
  } catch (error) {
    try { await removeOwnedRoot(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Synthetic media initialization and cleanup failed.'); }
    throw error;
  }
}
