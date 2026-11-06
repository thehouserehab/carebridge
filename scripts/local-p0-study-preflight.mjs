// Read-only preparation evidence, not proof of human task completion or a
// permission/cleanup authority. A failed newest run cannot reuse an older pass.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const defaultRoot = fileURLToPath(new URL('../test-results', import.meta.url));
// Full source manifests and browser evidence can exceed 256 KiB. Keep both
// the file check and read buffer bounded while accommodating those reports.
const maximumBytes = 1024 * 1024;
const runDirectory = /^local-p0-study-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const knownCreation = info => Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0;
const sameCreation = (a, b) => sameIdentity(a, b) && knownCreation(a) && knownCreation(b) && a.birthtimeMs === b.birthtimeMs;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const sameDirectory = (a, b) => sameIdentity(a, b) && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function resultRoot(options) {
  if (!object(options) || types.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw Error();
  const keys = Reflect.ownKeys(options);
  if (keys.length > 1 || keys.some(key => key !== 'root')) throw Error();
  const descriptor = Object.getOwnPropertyDescriptor(options, 'root');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw Error();
  const root = descriptor ? descriptor.value : defaultRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.startsWith('\\\\')) throw Error();
  return root;
}

async function directoryInfo(filename) {
  const info = await fs.lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
  return info;
}

async function inspectRoot(root) {
  let current = root, result;
  // Reject a root whose parent chain redirects outside the selected directory.
  while (true) {
    const info = await directoryInfo(current);
    if (current === root) result = info;
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function seoulDay(milliseconds) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(milliseconds));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw Error();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw Error();
  return milliseconds;
}

function sourceFiles(value, expected) {
  if (!object(value) || value.sha256 !== expected || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 2000) throw Error();
  const files = [];
  for (const file of value.files) {
    if (!object(file) || Object.keys(file).length !== 2 || !Object.hasOwn(file, 'name') || !Object.hasOwn(file, 'sha256') ||
        typeof file.name !== 'string' || file.name.length > 300 || !/^@?[A-Za-z0-9_.-]+(?:\/@?[A-Za-z0-9_.-]+)*$/.test(file.name) ||
        file.name.split('/').some(part => ['.', '..'].includes(part.replace(/^@/, ''))) || !digest(file.sha256) ||
        (files.length && files.at(-1).name >= file.name)) throw Error();
    files.push({ name: file.name, sha256: file.sha256 });
  }
  const serialized = JSON.stringify(files);
  if (hash(serialized) !== expected) throw Error();
  return serialized;
}

function validReport(report, runId, sourceHash, now) {
  if (!object(report) || report.runId !== runId || report.passed !== true || report.failure !== null ||
      report.humanMetricsCollected !== false || report.humanTaskCompletion !== false || report.cleanupObservationTimedOut !== false ||
      !Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.unexpectedRequests) || report.unexpectedRequests.length ||
      Object.hasOwn(report, 'currentCheck') || !object(report.cleanup) || Object.keys(report.cleanup).length !== 3 ||
      ['contextsClosed', 'browserStopped', 'sandboxesClosed'].some(key => report.cleanup[key] !== true)) return false;
  const today = seoulDay(now), start = timestamp(report.startedAt), finish = timestamp(report.finishedAt);
  if (start > finish || finish > now || seoulDay(start) !== today || seoulDay(finish) !== today) return false;
  if (sourceFiles(report.source, sourceHash) !== sourceFiles(report.finalSource, sourceHash)) return false;
  if (!Array.isArray(report.checks) || report.checks.length !== 6) return false;
  const expected = new Set(['390:A', '390:B', '390:C', '1440:A', '1440:B', '1440:C']);
  for (const check of report.checks) {
    if (!object(check) || ![390, 1440].includes(check.width) || !['A', 'B', 'C'].includes(check.task) ||
        !expected.delete(`${check.width}:${check.task}`) || check.day !== today ||
        ['homeEntry', 'apiRead', 'reloadReopen', 'sourceUnchanged', 'guardianPrivate', 'layout', 'cleanup'].some(key => check[key] !== true) ||
        check.preparedReadingOnly !== (check.task === 'C') || check.uiWriteVerified !== (check.task !== 'C') ||
        !digest(check.initialMaterialSha256) || check.finalMaterialSha256 !== check.initialMaterialSha256) return false;
  }
  return expected.size === 0;
}

async function readReport(root, rootInfo, candidate) {
  const beforeDirectory = await directoryInfo(candidate.filename);
  if (!sameCreation(beforeDirectory, candidate.info)) throw Error();
  const filename = path.join(candidate.filename, 'results.json'), before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maximumBytes) throw Error();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let result;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw Error();
    const bytes = Buffer.alloc(maximumBytes + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length !== before.size || length > maximumBytes) throw Error();
    const after = await fs.lstat(filename);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || !sameFile(before, after) ||
        !sameFile(before, await handle.stat()) || !sameCreation(beforeDirectory, await directoryInfo(candidate.filename)) ||
        !sameDirectory(rootInfo, await inspectRoot(root))) throw Error();
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await handle.close(); }
  return result;
}

export async function hasLocalP0StudyPreflight(sourceHash, options = {}) {
  try {
    if (!digest(sourceHash)) return false;
    const now = Date.now(), root = resultRoot(options), rootInfo = await inspectRoot(root), candidates = [];
    let entries = 0;
    for await (const entry of await fs.opendir(root)) {
      if (++entries > 4096) return false;
      const match = runDirectory.exec(entry.name);
      if (!match) continue;
      if (candidates.length >= 128) return false;
      const filename = path.join(root, entry.name), info = await fs.lstat(filename);
      if (!knownCreation(info)) return false;
      candidates.push({ filename, runId: match[1], info });
    }
    // Local Windows creation time orders runs; adding an audit file to an old
    // directory changes mtime, not its position. Unknown/tied creation is unsafe.
    candidates.sort((a, b) => b.info.birthtimeMs - a.info.birthtimeMs);
    if (!candidates.length || (candidates[1] && candidates[0].info.birthtimeMs === candidates[1].info.birthtimeMs)) return false;
    // Only the newest matching run is eligible. Never hide a later incomplete
    // or failed run by searching backwards for a successful result.
    const latest = candidates[0];
    return validReport(await readReport(root, rootInfo, latest), latest.runId, sourceHash, now);
  } catch { return false; } // Filesystem/JSON errors never expose raw paths/data.
}
