import { constants } from 'node:fs';
import { lstat, open, realpath, link, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Operator-side storage primitive, NOT an HTTP endpoint, scheduler or operating
// backup command. The caller must stop ALL writers and retain its own source /
// target ownership receipts. Authentication is not permission to run old SQL.
const MAGIC = Buffer.from('CBBNDL01');
const HEADER_BYTES = 40, CHUNK_BYTES = 65536, MAX_FRAMES = 131072;
const MAX_BYTES = 2 * 1024 ** 3, MAX_ENTRY_BYTES = 512 * 1024 ** 2, MAX_ENTRIES = 256;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const objectName = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(blob|blocked)$/;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fail = () => { throw new Error('RECOVERY_BUNDLE_UNAVAILABLE'); };
const validName = (name) => typeof name === 'string' && (['database.pgcustom', 'snapshot.json'].includes(name) || objectName.test(name));
const within = (root, target) => { const p = relative(resolve(root), target); return !p || (!p.startsWith('..') && !isAbsolute(p)); };
function keyBytes(key) { if (!Buffer.isBuffer(key) || key.length !== 32) fail(); return key; }
function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
async function privateDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail();
  const root = resolve(directory);
  if ([parse(root).root, homedir(), tmpdir()].some((p) => resolve(p) === root) || within(projectRoot, root)) fail();
  for (let part = root;; part = dirname(part)) {
    const s = await lstat(part);
    if (s.isSymbolicLink() || !s.isDirectory()) fail();
    if (dirname(part) === part) break;
  }
  const s = await lstat(root);
  if (resolve(await realpath(root)) !== root || (process.platform !== 'win32' &&
      (s.uid !== process.getuid() || (s.mode & 0o077) !== 0))) fail();
  return root;
}
async function syncDirectory(directory) {
  // Windows byte IO tests do not establish ACLs or power-loss durability.
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) fail();
    offset += bytesWritten;
  }
}
async function readExact(handle, size, position) {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, position + offset);
    if (!read.bytesRead) fail();
    offset += read.bytesRead;
  }
  return bytes;
}
function frameCrypto(key, header, index, length, decrypt = false) {
  // A fresh 256-bit salt derives a different key for every bundle, including a
  // retry of the same run ID. Per-key counter nonces are never reused. Counter
  // and frame length are authenticated together with the version/salt header.
  const iv = Buffer.alloc(12); iv.writeUInt32BE(index, 8);
  const dimensions = Buffer.alloc(8); dimensions.writeUInt32BE(index); dimensions.writeUInt32BE(length, 4);
  const cipher = (decrypt ? createDecipheriv : createCipheriv)('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.concat([header, dimensions])); return cipher;
}

export async function createRecoveryBundle({ directory, runId, key, entries, signal }) {
  let handle, derived, partial, final;
  try {
    keyBytes(key); if (typeof runId !== 'string' || !uuid.test(runId)) fail();
    const root = await privateDirectory(directory);
    partial = join(root, `${runId}.partial`); final = join(root, `${runId}.cbb`);
    // A retry must inspect the previous result; it never overwrites/adopts it.
    try { await lstat(final); fail(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const header = Buffer.concat([MAGIC, randomBytes(32)]);
    derived = Buffer.from(hkdfSync('sha256', key, header.subarray(8), MAGIC, 32));
    await writeAll(handle, header);
    let index = 0, total = 0; const inventory = [], names = new Set();
    async function frame(kind, content) {
      signal?.throwIfAborted();
      const plain = Buffer.concat([Buffer.from([kind]), content]);
      if (plain.length > CHUNK_BYTES + 1 || index >= MAX_FRAMES) fail();
      const cipher = frameCrypto(derived, header, index++, plain.length);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); plain.fill(0);
      const length = Buffer.alloc(4); length.writeUInt32BE(encrypted.length);
      await writeAll(handle, Buffer.concat([length, encrypted, cipher.getAuthTag()]));
    }
    for await (const entry of entries) {
      if (!entry || !validName(entry.name) || names.has(entry.name) || inventory.length >= MAX_ENTRIES || typeof entry.open !== 'function') fail();
      names.add(entry.name);
      await frame(1, Buffer.from(JSON.stringify({ name: entry.name })));
      const digest = createHash('sha256'); let bytes = 0;
      for await (const chunk of await entry.open()) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail();
        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
          const part = chunk.subarray(offset, offset + CHUNK_BYTES);
          bytes += part.length; total += part.length;
          if (bytes > MAX_ENTRY_BYTES || total > MAX_BYTES) fail();
          digest.update(part); await frame(2, part);
        }
      }
      const item = { name: entry.name, bytes, sha256: digest.digest('hex') };
      inventory.push(item); await frame(3, Buffer.from(JSON.stringify(item)));
    }
    if (!names.has('database.pgcustom') || !names.has('snapshot.json')) fail();
    const manifest = { version: 1, runId, createdAt: new Date().toISOString(), entries: inventory };
    await frame(4, Buffer.from(JSON.stringify(manifest)));
    await handle.sync(); await handle.close(); handle = undefined;
    // link is no-clobber, unlike rename on POSIX. Readers only accept the .cbb
    // name with exactly one link. Failed/unknown publication is never cutover.
    await link(partial, final);
    await unlink(partial); await syncDirectory(root);
    return Object.freeze({ runId, filename: `${runId}.cbb` });
  } catch { fail(); }
  finally {
    derived?.fill(0); await handle?.close().catch(() => {});
    // On failure retain this run's encrypted partial for inspection. Never
    // delete a pre-existing file or a possibly committed publication here.
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export async function openRecoveryBundle({ directory, runId, key, signal }) {
  let handle, derived;
  try {
    keyBytes(key); if (typeof runId !== 'string' || !uuid.test(runId)) fail();
    const root = await privateDirectory(directory), path = join(root, `${runId}.cbb`);
    const observed = await lstat(path, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1n ||
        observed.size > BigInt(MAX_BYTES + MAX_FRAMES * 1024) ||
        (process.platform !== 'win32' && (observed.uid !== BigInt(process.getuid()) || (observed.mode & 0o077n) !== 0n))) fail();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat({ bigint: true }); if (!sameFile(initial, observed)) fail();
    const header = await readExact(handle, HEADER_BYTES, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) fail();
    derived = Buffer.from(hkdfSync('sha256', key, header.subarray(8), MAGIC, 32));
    async function frame(position, index) {
      signal?.throwIfAborted(); if (index >= MAX_FRAMES) fail();
      const length = (await readExact(handle, 4, position)).readUInt32BE();
      if (length < 1 || length > CHUNK_BYTES + 1) fail();
      const encrypted = await readExact(handle, length + 16, position + 4);
      const decipher = frameCrypto(derived, header, index, length, true);
      decipher.setAuthTag(encrypted.subarray(length));
      let tentative;
      try {
        tentative = decipher.update(encrypted.subarray(0, length));
        decipher.final(); // MUST succeed before any bytes reach SQL or disk.
        return { plain: tentative, next: position + 4 + length + 16 };
      } catch { tentative?.fill(0); fail(); }
    }
    let position = HEADER_BYTES, index = 0, current, total = 0, manifest;
    const items = [], ranges = new Map();
    while (position < Number(initial.size)) {
      const start = position, sequence = index++, decoded = await frame(position, sequence);
      position = decoded.next; const plain = decoded.plain, kind = plain[0], content = plain.subarray(1);
      try {
        if (kind === 1) {
          if (current || items.length >= MAX_ENTRIES || manifest) fail();
          const meta = JSON.parse(content.toString('utf8')); exactKeys(meta, ['name']);
          if (!validName(meta.name) || ranges.has(meta.name)) fail();
          current = { name: meta.name, bytes: 0, digest: createHash('sha256'), frames: [] };
          ranges.set(meta.name, current.frames);
        } else if (kind === 2) {
          if (!current || !content.length) fail();
          current.bytes += content.length; total += content.length;
          if (current.bytes > MAX_ENTRY_BYTES || total > MAX_BYTES) fail();
          current.digest.update(content); current.frames.push({ start, sequence });
        } else if (kind === 3) {
          if (!current) fail();
          const item = JSON.parse(content.toString('utf8')); exactKeys(item, ['name', 'bytes', 'sha256']);
          if (item.name !== current.name || item.bytes !== current.bytes || item.sha256 !== current.digest.digest('hex')) fail();
          items.push(item); current = undefined;
        } else if (kind === 4) {
          if (current || manifest || position !== Number(initial.size)) fail();
          manifest = JSON.parse(content.toString('utf8')); exactKeys(manifest, ['version', 'runId', 'createdAt', 'entries']);
          if (manifest.version !== 1 || manifest.runId !== runId ||
              typeof manifest.createdAt !== 'string' || new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
              JSON.stringify(manifest.entries) !== JSON.stringify(items) ||
              !ranges.has('database.pgcustom') || !ranges.has('snapshot.json')) fail();
        } else fail();
      } finally { plain.fill(0); }
    }
    if (!manifest || current || !sameFile(initial, await handle.stat({ bigint: true }))) fail();
    // Full authentication/entry digests/commit manifest verified BEFORE the
    // caller can obtain ANY plaintext stream or invoke a restore command.
    for (const item of manifest.entries) Object.freeze(item);
    Object.freeze(manifest.entries); Object.freeze(manifest);
    let closed = false, streaming = false;
    const reader = {
      manifest,
      async *stream(name) {
        if (closed || streaming || !ranges.has(name)) fail(); streaming = true;
        const digest = createHash('sha256'); let bytes = 0;
        try {
          if (!sameFile(initial, await handle.stat({ bigint: true }))) fail();
          for (const { start, sequence } of ranges.get(name)) {
            const { plain } = await frame(start, sequence);
            if (plain[0] !== 2) { plain.fill(0); fail(); }
            const content = plain.subarray(1); bytes += content.length; digest.update(content);
            yield content; // Each bounded chunk has already authenticated.
          }
          const item = manifest.entries.find((entry) => entry.name === name);
          if (bytes !== item.bytes || digest.digest('hex') !== item.sha256 ||
              !sameFile(initial, await handle.stat({ bigint: true }))) fail();
        } catch { fail(); } finally { streaming = false; }
      },
      async close() { if (streaming) fail(); if (!closed) { closed = true; derived.fill(0); await handle.close(); } },
    };
    return Object.freeze(reader);
  } catch {
    derived?.fill(0); await handle?.close().catch(() => {}); fail();
  }
}
