// Internal read-only inspection under the caller's verified DB SHARE locks.
// Root receipts bind directory identity, not Windows ACLs or writer shutdown.
// No repair, store initialization, media serving or operating release decision.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MEDIA_TYPES } from '../src/media-policy.js';

const MAX_ROWS = 10000, MAX_FILES = 20000, MAX_FILE_BYTES = 50 * 1024 ** 2;
const MAX_TOTAL_BYTES = 2 * 1024 ** 3, DEADLINE_MS = 20000, CHUNK_BYTES = 65536;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const objectName = /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(blob|blocked)$/;
const decimal = /^(0|[1-9][0-9]{0,19})$/, hash = /^[a-f0-9]{64}$/;
const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const errorCodes = new Set(['RECOVERY_MEDIA_UNAVAILABLE', 'RECOVERY_MEDIA_INVALID_INPUT', 'RECOVERY_MEDIA_LEDGER_UNAVAILABLE',
  'RECOVERY_MEDIA_LIMIT', 'RECOVERY_MEDIA_IN_FLIGHT', 'RECOVERY_MEDIA_ROOT_MISMATCH', 'RECOVERY_MEDIA_CHANGED',
  'RECOVERY_MEDIA_UNRECOGNIZED_FILE', 'RECOVERY_MEDIA_INVALID_FENCE', 'RECOVERY_MEDIA_TIMEOUT']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const folded = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (parent, child) => { const rest = relative(folded(parent), folded(child)); return !rest || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };
export class RecoveryMediaComparisonError extends Error {
  constructor(code) { const fixed = errorCodes.has(code) ? code : 'RECOVERY_MEDIA_UNAVAILABLE'; super(fixed); this.name = 'RecoveryMediaComparisonError'; this.code = fixed; }
}
const fail = (code = 'RECOVERY_MEDIA_UNAVAILABLE') => { throw new RecoveryMediaComparisonError(code); };
const invalid = () => fail('RECOVERY_MEDIA_INVALID_INPUT');

export function approveRecoveryMediaRoots(input) {
  try {
    if (!exact(input, ['source', 'target'])) invalid();
    const result = {};
    for (const side of ['source', 'target']) {
      const value = input[side];
      if (!exact(value, ['path', 'dev', 'ino'])) invalid();
      const { path, dev, ino } = value;
      if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) ||
          ![dev, ino].every(n => typeof n === 'string' && decimal.test(n) && BigInt(n) <= 18446744073709551615n) || BigInt(ino) === 0n) invalid();
      // Reject Windows device/UNC paths, alternate streams, short ambiguous
      // trailing-dot/space names and reserved device segments before any IO.
      if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || /[:*?"<>|]/.test(path.slice(2)) ||
          path.slice(3).split(/[\\/]/).some(part => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)))) invalid();
      const root = resolve(path);
      if ([parse(root).root, homedir(), tmpdir()].some(broad => folded(resolve(broad)) === folded(root)) ||
          within(projectRoot, root) || within(root, projectRoot)) invalid();
      result[side] = Object.freeze({ path: root, dev, ino });
    }
    if (within(result.source.path, result.target.path) || within(result.target.path, result.source.path) ||
        (result.source.dev === result.target.dev && result.source.ino === result.target.ino)) invalid();
    return Object.freeze(result);
  } catch { invalid(); }
}

const ownerKey = row => JSON.stringify([row.center_id, row.conversation_id, row.upload_id ?? row.id]);
const validOwner = row => [row.center_id, row.conversation_id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1000);
const validKey = value => typeof value === 'string' && uuid.test(value);
const validManifest = (type, size, sha256) => MEDIA_TYPES.includes(type) && Number.isSafeInteger(size) && size > 0 &&
  size <= (type.startsWith('image/') ? 10 * 1024 ** 2 : MAX_FILE_BYTES) && typeof sha256 === 'string' && hash.test(sha256);
const ledgerFail = () => fail('RECOVERY_MEDIA_LEDGER_UNAVAILABLE');
const queryTexts = [
  'SELECT key,center_id,conversation_id,upload_id,state FROM public.cb_media_objects ORDER BY key COLLATE "C" LIMIT $1',
  'SELECT center_id,conversation_id,id,state,type,size,sha256,version,object_key,candidate_key,preparation_required,preparation_id,prepared_size,prepared_sha256,lease_id,lease_until FROM public.cb_media_uploads ORDER BY center_id COLLATE "C",conversation_id COLLATE "C",id COLLATE "C" LIMIT $1',
  'SELECT id,center_id,conversation_id,upload_id,source_key,derivative_key,type,source_size,derivative_size,source_sha256,derivative_sha256,upload_version FROM public.cb_media_preparations ORDER BY id COLLATE "C" LIMIT $1',
];
async function ledger(query, checked) {
  const tables = [];
  for (const sql of queryTexts) {
    const result = await checked(() => query(sql, [MAX_ROWS + 1]));
    if (!result || !Array.isArray(result.rows)) ledgerFail();
    if (result.rows.length > MAX_ROWS) fail('RECOVERY_MEDIA_LIMIT');
    tables.push(structuredClone(result.rows));
  }
  const [objects, uploads, preparations] = tables;
  const objectMap = new Map(), uploadMap = new Map(), proofMap = new Map();
  for (const row of objects) {
    if (!row || !validOwner(row) || !validKey(row.key) || !validKey(row.upload_id) || objectMap.has(row.key) ||
        !['active', 'delete_pending', 'deleted'].includes(row.state)) ledgerFail();
    if (row.state === 'delete_pending') fail('RECOVERY_MEDIA_IN_FLIGHT');
    objectMap.set(row.key, row);
  }
  for (const row of uploads) {
    if (!row || !validOwner(row) || !validKey(row.id) || uploadMap.has(ownerKey(row)) ||
        !validManifest(row.type, row.size, row.sha256) || !Number.isSafeInteger(row.version) || row.version < 1 ||
        typeof row.preparation_required !== 'boolean' || !['pending', 'receiving', 'quarantined', 'inspecting', 'ready', 'bound', 'rejected', 'delete_pending', 'deleted'].includes(row.state)) ledgerFail();
    if (['receiving', 'inspecting', 'delete_pending'].includes(row.state) || row.lease_id != null || row.lease_until != null) fail('RECOVERY_MEDIA_IN_FLIGHT');
    for (const key of [row.object_key, row.candidate_key]) {
      if (key == null) continue;
      const object = objectMap.get(key);
      if (!object || ownerKey(object) !== ownerKey(row) || object.state !== (row.state === 'deleted' ? 'deleted' : 'active')) ledgerFail();
    }
    if (row.object_key != null && row.object_key === row.candidate_key) ledgerFail();
    if (['quarantined', 'ready', 'bound'].includes(row.state) && row.object_key == null) ledgerFail();
    if (row.state === 'pending' && row.object_key != null) ledgerFail();
    if (row.candidate_key != null && !['ready', 'bound', 'deleted'].includes(row.state)) ledgerFail();
    const prepared = [row.preparation_id, row.prepared_size, row.prepared_sha256];
    if (prepared.some(value => value != null) && (prepared.some(value => value == null) || row.candidate_key == null ||
        !validKey(row.preparation_id) || !validManifest(row.type, row.prepared_size, row.prepared_sha256))) ledgerFail();
    if (['ready', 'bound'].includes(row.state) && (row.candidate_key != null || row.preparation_required) && row.preparation_id == null) ledgerFail();
    uploadMap.set(ownerKey(row), row);
  }
  for (const row of preparations) {
    if (!row || !validOwner(row) || !validKey(row.id) || proofMap.has(row.id) || !validKey(row.upload_id) ||
        !validKey(row.source_key) || !validKey(row.derivative_key) || row.source_key === row.derivative_key ||
        !validManifest(row.type, row.source_size, row.source_sha256) || !validManifest(row.type, row.derivative_size, row.derivative_sha256) ||
        !Number.isSafeInteger(row.upload_version) || row.upload_version < 1) ledgerFail();
    const upload = uploadMap.get(ownerKey(row));
    if (!upload || upload.preparation_id !== row.id || !['ready', 'bound', 'deleted'].includes(upload.state) ||
        upload.object_key !== row.source_key || upload.candidate_key !== row.derivative_key || upload.type !== row.type ||
        upload.size !== row.source_size || upload.sha256 !== row.source_sha256 || upload.prepared_size !== row.derivative_size ||
        upload.prepared_sha256 !== row.derivative_sha256 || upload.version <= row.upload_version) ledgerFail();
    proofMap.set(row.id, row);
  }
  for (const row of uploads) if (row.preparation_id != null && !proofMap.has(row.preparation_id)) ledgerFail();
  const expected = new Map();
  for (const object of objects) {
    const upload = uploadMap.get(ownerKey(object));
    if (!upload) ledgerFail();
    if (object.state === 'deleted') { expected.set(object.key, { state: 'deleted' }); continue; }
    if (upload.state === 'deleted') ledgerFail();
    if (object.key === upload.object_key) expected.set(object.key, { state: 'active', size: upload.size, sha256: upload.sha256 });
    else if (object.key === upload.candidate_key && proofMap.has(upload.preparation_id))
      expected.set(object.key, { state: 'active', size: upload.prepared_size, sha256: upload.prepared_sha256 });
    else ledgerFail(); // An abandoned active candidate has no trustworthy hash.
  }
  return expected;
}

const identitySame = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => a[key] === b[key]);
const fileSame = (a, b) => identitySame(a, b) && ['size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => a[key] === b[key]);
async function rootSnapshot(receipt, checked) {
  const chain = [];
  for (let path = receipt.path;; path = dirname(path)) {
    const info = await checked(() => fs.lstat(path, { bigint: true }));
    if (!info.isDirectory() || info.isSymbolicLink()) fail('RECOVERY_MEDIA_ROOT_MISMATCH');
    chain.push({ path, info });
    if (dirname(path) === path) break;
  }
  const info = chain[0].info;
  if (info.dev.toString() !== receipt.dev || info.ino.toString() !== receipt.ino ||
      folded(resolve(await checked(() => fs.realpath(receipt.path)))) !== folded(receipt.path) ||
      (process.platform !== 'win32' && (info.uid !== BigInt(process.getuid()) || (info.mode & 0o077n) !== 0n))) fail('RECOVERY_MEDIA_ROOT_MISMATCH');
  return { receipt, chain };
}
async function recheckRoot(root, checked) {
  const current = await rootSnapshot(root.receipt, checked);
  if (current.chain.length !== root.chain.length || current.chain.some((entry, index) => entry.path !== root.chain[index].path ||
      !identitySame(entry.info, root.chain[index].info)) || !fileSame(current.chain[0].info, root.chain[0].info)) fail('RECOVERY_MEDIA_CHANGED');
}
async function names(root, checked) {
  const found = [];
  await checked(async () => {});
  const directory = await fs.opendir(root.receipt.path);
  try {
    while (true) {
      const entry = await checked(() => directory.read());
      if (!entry) break;
      if (!objectName.test(entry.name)) fail('RECOVERY_MEDIA_UNRECOGNIZED_FILE');
      found.push(entry.name);
      if (found.length > MAX_FILES) fail('RECOVERY_MEDIA_LIMIT');
    }
  } finally { await directory.close(); }
  return found.sort();
}
async function regular(path, checked) {
  const info = await checked(() => fs.lstat(path, { bigint: true }));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail('RECOVERY_MEDIA_UNRECOGNIZED_FILE');
  if (info.size < 0n || info.size > BigInt(MAX_FILE_BYTES)) fail('RECOVERY_MEDIA_LIMIT');
  return info;
}
async function inventory(root, expected, checked) {
  const entries = new Map(); let total = 0;
  for (const name of await names(root, checked)) {
    const [, key, kind] = objectName.exec(name);
    if (kind === 'blob' && !expected.has(key)) fail('RECOVERY_MEDIA_UNRECOGNIZED_FILE');
    const info = await regular(join(root.receipt.path, name), checked);
    if (kind === 'blocked' && info.size !== 0n) fail('RECOVERY_MEDIA_INVALID_FENCE');
    total += Number(info.size);
    if (total > MAX_TOTAL_BYTES) fail('RECOVERY_MEDIA_LIMIT');
    entries.set(name, { info, kind, key });
  }
  await recheckRoot(root, checked);
  return entries;
}
async function hashFile(root, name, entry, checked) {
  let handle, buffer;
  try {
    await recheckRoot(root, checked);
    const path = join(root.receipt.path, name), observed = await regular(path, checked);
    if (!fileSame(entry.info, observed)) fail('RECOVERY_MEDIA_CHANGED');
    // NONBLOCK avoids waiting indefinitely if a regular file is replaced by
    // a FIFO between lstat/open on a platform supporting this flag.
    await checked(async () => {});
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await checked(() => handle.stat({ bigint: true }));
    if (!before.isFile() || before.nlink !== 1n || !fileSame(observed, before)) fail('RECOVERY_MEDIA_CHANGED');
    const digest = createHash('sha256'); buffer = Buffer.alloc(CHUNK_BYTES); let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await checked(() => handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position));
      if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > Math.min(buffer.length, Number(before.size) - position)) fail('RECOVERY_MEDIA_CHANGED');
      digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const extra = await checked(() => handle.read(buffer, 0, 1, position));
    if (extra.bytesRead !== 0 || !fileSame(before, await checked(() => handle.stat({ bigint: true }))) ||
        !fileSame(before, await regular(path, checked))) fail('RECOVERY_MEDIA_CHANGED');
    await recheckRoot(root, checked);
    return digest.digest('hex');
  } finally {
    buffer?.fill(0);
    // Cleanup is awaited even after the deadline; never abandon an active IO.
    await handle?.close();
  }
}
async function finalCheck(root, entries, checked) {
  await recheckRoot(root, checked);
  const currentNames = await names(root, checked);
  if (JSON.stringify(currentNames) !== JSON.stringify([...entries.keys()])) fail('RECOVERY_MEDIA_CHANGED');
  for (const [name, entry] of entries) {
    if (!fileSame(entry.info, await regular(join(root.receipt.path, name), checked))) fail('RECOVERY_MEDIA_CHANGED');
    // Same-size writes may retain the observed timestamps on Windows. A
    // final stat alone cannot establish that the first hash still describes
    // these bytes. Re-read under the SAME deadline; this is not a writer lock.
    if (await hashFile(root, name, entry, checked) !== entry.sha256) fail('RECOVERY_MEDIA_CHANGED');
  }
  await recheckRoot(root, checked);
}

export async function compareRecoveryMediaState(sourceTx, targetTx, approvedRoots) {
  try {
    // Capture every caller-controlled reference before the first await.
    const approved = approveRecoveryMediaRoots(approvedRoots);
    if (!sourceTx || !targetTx || sourceTx === targetTx || typeof sourceTx.query !== 'function' || typeof targetTx.query !== 'function') invalid();
    const sourceQuery = sourceTx.query.bind(sourceTx), targetQuery = targetTx.query.bind(targetTx);
    const deadline = performance.now() + DEADLINE_MS;
    const check = () => { if (performance.now() >= deadline) fail('RECOVERY_MEDIA_TIMEOUT'); };
    const checked = async work => { check(); const result = await work(); check(); return result; };
    const source = await rootSnapshot(approved.source, checked), target = await rootSnapshot(approved.target, checked);
    if (source.chain[0].info.dev === target.chain[0].info.dev && source.chain[0].info.ino === target.chain[0].info.ino) fail('RECOVERY_MEDIA_ROOT_MISMATCH');
    const sourceLedger = await ledger(sourceQuery, checked), targetLedger = await ledger(targetQuery, checked);
    const left = await inventory(source, sourceLedger, checked), right = await inventory(target, targetLedger, checked);
    const differences = new Set();
    for (const [root, expected, entries] of [[source, sourceLedger, left], [target, targetLedger, right]]) {
      for (const [key, item] of expected) {
        const blob = entries.has(`${key}.blob`), fence = entries.has(`${key}.blocked`);
        if (item.state === 'active') {
          if (!blob) differences.add('file-inventory');
          if (fence) differences.add('deletion-fence');
        } else if (blob || !fence) differences.add('deletion-fence');
      }
      for (const [name, entry] of entries) {
        entry.sha256 = await hashFile(root, name, entry, checked);
        const manifest = expected.get(entry.key);
        if (entry.kind === 'blob' && manifest?.state === 'active' &&
            (entry.info.size !== BigInt(manifest.size) || entry.sha256 !== manifest.sha256)) differences.add('file-content');
      }
    }
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(name), b = right.get(name);
      if (!a || !b) differences.add(name.endsWith('.blocked') ? 'deletion-fence' : 'file-inventory');
      else if (a.info.size !== b.info.size || a.sha256 !== b.sha256) differences.add('file-content');
    }
    // Earlier files must still match after all later files and the other root
    // have been read. This is observation, not an atomic filesystem snapshot.
    await finalCheck(source, left, checked); await finalCheck(target, right, checked);
    check();
    return { externalFilesChecked: true, externalFilesMatch: differences.size === 0,
      externalFileDifferences: [...differences].sort(), filesystemWriterQuiescenceVerified: false };
  } catch (error) {
    // Reconstruct even this module's error type: a foreign callback must not
    // smuggle a raw cause, message or custom field through instanceof alone.
    fail(error instanceof RecoveryMediaComparisonError ? error.code : undefined);
  }
}
