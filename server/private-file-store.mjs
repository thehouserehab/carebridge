import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { matchesMediaSignature } from '../src/media-policy.js';
import { fail } from './errors.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const within = (root, target) => { const p = relative(resolve(root), target); return !p || (!p.startsWith('..') && !isAbsolute(p)); };
const opaqueKey = (key) => {
  if (typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key)) fail('INVALID_INPUT');
  return key;
};

// An explicitly configured, non-public directory; no URL or user filename is
// ever used as an object path. OS account/ACL isolation is still required.
export class PrivateFileStore {
  constructor(root, { forbiddenRoots = [] } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('An absolute private storage directory is required.');
    this.root = resolve(root);
    if ([parse(this.root).root, homedir(), tmpdir()].some((p) => resolve(p) === this.root) ||
        [projectRoot, ...forbiddenRoots].some((p) => within(p, this.root)))
      throw new TypeError('Storage must be a dedicated directory outside published/project roots.');
  }

  async checkRoot() {
    // Reject junctions/symlinks in the directory chain, including on Windows.
    let part = this.root;
    while (true) {
      try { if ((await lstat(part)).isSymbolicLink()) fail('STORAGE_UNAVAILABLE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(part);
      if (parent === part) break;
      part = parent;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (resolve(await realpath(this.root)) !== this.root || !(await lstat(this.root)).isDirectory()) fail('STORAGE_UNAVAILABLE');
  }

  async write(key, stream, manifest, { signal } = {}) {
    opaqueKey(key);
    signal?.throwIfAborted();
    await this.checkRoot();
    const path = join(this.root, `${key}.blob`);
    let handle;
    try {
      await this.assertWritable(key);
      signal?.throwIfAborted();
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      // A durable deletion fence covers cancel-before-write and a process
      // resuming after its lease expired. Never resurrect a removed object.
      await this.assertWritable(key);
      signal?.throwIfAborted();
      const digest = createHash('sha256');
      let size = 0, prefix = Buffer.alloc(0);
      const validator = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > manifest.size) { done(Object.assign(new Error('SIZE_MISMATCH'), { code: 'SIZE_MISMATCH' })); return; }
        digest.update(chunk);
        if (prefix.length < 40) prefix = Buffer.concat([prefix, chunk.subarray(0, 40 - prefix.length)]);
        done(null, chunk);
      } });
      // A Writable owns no FileHandle reference: explicit close in finally
      // cannot wait forever for an autoClose:false fs stream to release it.
      const writer = new Writable({ write(chunk, encoding, done) {
        (async () => {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error('Unable to persist media bytes.');
            offset += bytesWritten;
          }
        })().then(() => done(), done);
      } });
      await pipeline(stream, validator, writer, { signal });
      if (size !== manifest.size) fail('SIZE_MISMATCH');
      if (digest.digest('hex') !== manifest.sha256) fail('HASH_MISMATCH');
      if (!matchesMediaSignature(manifest.type, prefix)) fail('FORMAT_MISMATCH');
      await handle.sync();
      await this.syncRoot();
      return { size };
    } catch (error) {
      // Only remove the exact object that this call created, never an existing
      // file found by O_EXCL. A failed unlink is retried via the DB object ledger.
      if (handle) {
        await handle.close().catch(() => {}); handle = null;
        await unlink(path).catch(() => {});
      }
      throw error;
    } finally { await handle?.close(); }
  }

  async syncRoot() {
    // Linux persistence also flushes directory entries, not only file content.
    // Windows has no portable Node directory-fsync equivalent; local Windows
    // tests prove byte IO/recovery, NOT power-loss durability or operating ACLs.
    if (process.platform === 'win32') return;
    const handle = await open(this.root,constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { if (!(await handle.stat()).isDirectory()) fail('STORAGE_UNAVAILABLE'); await handle.sync(); }
    finally { await handle.close(); }
  }

  async assertWritable(key) {
    try { await lstat(join(this.root, `${key}.blocked`)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    fail('STORAGE_UNAVAILABLE');
  }

  async openVerified(key, manifest) {
    opaqueKey(key);
    await this.checkRoot();
    let handle,buffer;
    try {
      const path = join(this.root, `${key}.blob`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('CONTENT_UNAVAILABLE');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile() || before.size !== manifest.size || before.ino !== info.ino || before.dev !== info.dev) fail('CONTENT_UNAVAILABLE');
      const digest = createHash('sha256'); buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < manifest.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, manifest.size - position), position);
        if (!bytesRead) fail('CONTENT_UNAVAILABLE');
        digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const after = await handle.stat();
      if (digest.digest('hex') !== manifest.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        fail('CONTENT_UNAVAILABLE');
      return handle;
    } catch {
      await handle?.close().catch(() => {});
      fail('CONTENT_UNAVAILABLE');
    } finally { buffer?.fill(0); }
  }

  async remove(key) {
    opaqueKey(key);
    await this.checkRoot();
    let fence;
    try {
      fence = await open(join(this.root, `${key}.blocked`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await fence.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await fence?.close(); }
    await this.syncRoot(); // Commit the deletion fence before removing bytes.
    const path = join(this.root, `${key}.blob`);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('STORAGE_UNAVAILABLE');
      await unlink(path);
      await this.syncRoot();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
