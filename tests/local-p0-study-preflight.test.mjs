import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hasLocalP0StudyPreflight } from '../scripts/local-p0-study-preflight.mjs';

const now = Date.parse('2026-10-14T12:00:00.000Z'), today = '2026-10-14';
const files = [{ name: 'local-api/app.js', sha256: 'a'.repeat(64) }, { name: 'server/local-api-sandbox.mjs', sha256: 'b'.repeat(64) }];
const sourceHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const material = 'c'.repeat(64), privateError = 'PRIVATE-REPORT-PATH-OR-ERROR';
function valid(runId) {
  return { runId, startedAt: new Date(now - 120000).toISOString(), finishedAt: new Date(now - 1000).toISOString(),
    source: { sha256: sourceHash, files: structuredClone(files) }, finalSource: { sha256: sourceHash, files: structuredClone(files) },
    passed: true, errors: [], unexpectedRequests: [], failure: null, humanMetricsCollected: false, humanTaskCompletion: false,
    cleanupObservationTimedOut: false, cleanup: { contextsClosed: true, browserStopped: true, sandboxesClosed: true },
    checks: [390, 1440].flatMap(width => ['A', 'B', 'C'].map(task => ({ width, task, day: today,
      homeEntry: true, apiRead: true, reloadReopen: true, sourceUnchanged: true, guardianPrivate: true, layout: true, cleanup: true,
      preparedReadingOnly: task === 'C', uiWriteVerified: task !== 'C', initialMaterialSha256: material, finalMaterialSha256: material }))) };
}

async function owned(t) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'carebridge-p0-preflight-test-')), directories = [], filenames = [];
  // Keep real owned files but explicitly simulate their Windows creation-time
  // observations. fs.utimes controls mtime only and must not stand for birthtime.
  const creations = new Map(), originalLstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async filename => {
    const info = await originalLstat(filename);
    return creations.has(filename) ? Object.assign(Object.create(info), { birthtimeMs: creations.get(filename) }) : info;
  });
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^carebridge-p0-preflight-test-[A-Za-z0-9]+$/);
    for (const filename of filenames.reverse()) {
      const relative = path.relative(root, filename);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const info = await fs.lstat(filename); assert(info.isFile() && !info.isSymbolicLink());
      await fs.unlink(filename);
    }
    for (const directory of directories.reverse()) {
      assert.equal(path.dirname(directory), root);
      const info = await fs.lstat(directory); assert(info.isDirectory() && !info.isSymbolicLink());
      assert.deepEqual(await fs.readdir(directory), []); await fs.rmdir(directory);
    }
    const info = await fs.lstat(root); assert(info.isDirectory() && !info.isSymbolicLink());
    assert.deepEqual(await fs.readdir(root), []); await fs.rmdir(root);
  });
  async function add({ change = () => {}, contents, missing = false, created = now - 1000, mtime = now - 1000, name } = {}) {
    const id = randomUUID(), directory = path.join(root, name ?? `local-p0-study-${id}`);
    await fs.mkdir(directory); directories.push(directory);
    creations.set(directory, created);
    const report = valid(id); change(report);
    const filename = path.join(directory, 'results.json');
    if (!missing) {
      await fs.writeFile(filename, contents ?? JSON.stringify(report), { flag: 'wx', mode: 0o600 }); filenames.push(filename);
    }
    await fs.utimes(directory, mtime / 1000, mtime / 1000);
    return { id, filename, directory, report };
  }
  return { root, add };
}

test('a complete current-day six-scenario report with the exact manifest is accepted without writes', async t => {
  const f = await owned(t); const result = await f.add();
  const before = await fs.readFile(result.filename), beforeInfo = await fs.lstat(result.filename);
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), true);
  assert((await fs.readFile(result.filename)).equals(before));
  const afterInfo = await fs.lstat(result.filename);
  assert.equal(afterInfo.size, beforeInfo.size); assert.equal(afterInfo.mtimeMs, beforeInfo.mtimeMs);
});

test('latest failure, missing result or source mismatch cannot fall back to an older passing run', async t => {
  const f = await owned(t); await f.add({ created: now - 10000 });
  const cases = [ { change: report => { report.passed = false; } }, { missing: true },
    { change: report => { report.source.sha256 = 'f'.repeat(64); } } ];
  for (const [index, scenario] of cases.entries()) {
    await f.add({ ...scenario, created: now - 3000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
});

test('latest creation replaces an older failure; tied latest birthtimes fail closed despite different mtimes', async t => {
  const f = await owned(t); await f.add({ change: report => { report.passed = false; }, created: now - 10000 });
  await f.add({ created: now - 1000 }); assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), true);
  await f.add({ created: now - 1000, mtime: now }); assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
});

test('a later audit mtime on an old passing directory cannot hide a newer failed run', async t => {
  const f = await owned(t), old = await f.add({ created: now - 10000, mtime: now - 10000 });
  const newer = await f.add({ created: now - 1000, mtime: now - 1000, change: report => { report.passed = false; } });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  await fs.utimes(old.directory, now / 1000, now / 1000);
  const oldInfo = await fs.lstat(old.directory), newInfo = await fs.lstat(newer.directory);
  assert(oldInfo.mtimeMs > newInfo.mtimeMs); assert(oldInfo.birthtimeMs < newInfo.birthtimeMs);
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
});

test('missing, false, nonpositive or nonfinite creation metadata cannot establish a latest run', async t => {
  const f = await owned(t), result = await f.add(), original = fs.lstat.bind(fs);
  for (const birthtimeMs of [undefined, null, false, '1791979199000', 0, -1, NaN, Infinity, -Infinity]) {
    const mocked = t.mock.method(fs, 'lstat', async filename => {
      const info = await original(filename);
      return filename === result.directory ? Object.assign(Object.create(info), { birthtimeMs }) : info;
    });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false); mocked.mock.restore();
  }
});

test('selected directory identity and creation time must remain stable before and after reading', async t => {
  const f = await owned(t), result = await f.add(), original = fs.lstat.bind(fs);
  for (const stage of [2, 3]) for (const field of ['birthtimeMs', 'ino']) {
    let observations = 0;
    const mocked = t.mock.method(fs, 'lstat', async filename => {
      const info = await original(filename);
      if (filename === result.directory && ++observations >= stage)
        return Object.assign(Object.create(info), { [field]: field === 'ino' ? (info.ino === 0 ? 1 : 0) : info[field] + 1 });
      return info;
    });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
    assert.equal(observations, stage); mocked.mock.restore();
  }
});

test('nonmatching names are ignored and exact run identity must match its directory', async t => {
  const f = await owned(t); await f.add({ name: 'local-p0-study-not-a-uuid', created: now });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  await f.add({ created: now - 1000 }); assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), true);
  await f.add({ change: report => { report.runId = randomUUID(); }, created: now });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
});

test('every outcome, cleanup and human-metric guard is required literally', async t => {
  const f = await owned(t);
  const changes = [report => { report.passed = 1; }, report => { delete report.failure; }, report => { report.failure = {}; },
    report => { report.errors = [{}]; }, report => { report.unexpectedRequests = [{}]; }, report => { report.errors = null; },
    report => { report.humanMetricsCollected = true; }, report => { report.humanTaskCompletion = true; },
    report => { report.cleanupObservationTimedOut = true; }, report => { report.currentCheck = {}; },
    ...['contextsClosed', 'browserStopped', 'sandboxesClosed'].map(key => report => { report.cleanup[key] = false; })];
  for (const [index, change] of changes.entries()) {
    await f.add({ change, created: now - 60000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
});

test('the exact six task/width pairs, write/read distinction and unchanged material are mandatory', async t => {
  const f = await owned(t);
  const changes = [report => { report.checks.pop(); }, report => { report.checks.push(report.checks[0]); },
    report => { report.checks[5] = structuredClone(report.checks[0]); }, report => { report.checks[0].width = '390'; },
    report => { report.checks[0].task = 'D'; }, report => { report.checks[0].day = '2026-10-13'; },
    report => { report.checks[0].preparedReadingOnly = true; }, report => { report.checks[0].uiWriteVerified = false; },
    report => { report.checks[2].preparedReadingOnly = false; }, report => { report.checks[2].uiWriteVerified = true; },
    report => { report.checks[0].initialMaterialSha256 = 'invalid'; }, report => { report.checks[0].finalMaterialSha256 = 'f'.repeat(64); },
    ...['homeEntry', 'apiRead', 'reloadReopen', 'sourceUnchanged', 'guardianPrivate', 'layout', 'cleanup'].map(key => report => { report.checks[0][key] = false; })];
  for (const [index, change] of changes.entries()) {
    await f.add({ change, created: now - 60000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
});

test('timestamps must be canonical, ordered, not future and both within the current Seoul day', async t => {
  const f = await owned(t);
  const changes = [report => { report.startedAt = 'not-a-date'; }, report => { report.finishedAt = '2026-02-30T00:00:00.000Z'; },
    report => { report.startedAt = new Date(now).toISOString(); }, report => { report.finishedAt = new Date(now + 1).toISOString(); },
    report => { report.startedAt = '2026-10-13T14:59:59.999Z'; },
    report => { report.startedAt = '2026-10-13T12:00:00.000Z'; report.finishedAt = '2026-10-13T13:00:00.000Z'; }];
  for (const [index, change] of changes.entries()) {
    await f.add({ change, created: now - 60000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
  await f.add({ change: report => { report.startedAt = '2026-10-13T15:00:00.000Z'; }, created: now - 1000 });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), true);
});

test('source lists must be nonempty, sorted, unique, identical and hash to the supplied digest', async t => {
  const f = await owned(t);
  const changes = [report => { report.source.files = []; }, report => { report.finalSource.sha256 = 'f'.repeat(64); },
    report => { report.finalSource.files[0].sha256 = 'f'.repeat(64); },
    report => { report.source.files.reverse(); report.finalSource.files.reverse(); },
    report => { report.source.files[1] = report.source.files[0]; report.finalSource.files = structuredClone(report.source.files); },
    report => { report.source.files[0].name = '../outside'; }, report => { report.source.files[0].sha256 = 'A'.repeat(64); },
    report => { report.source.files[0].extra = privateError; },
    report => { report.source.files[0].sha256 = 'd'.repeat(64); report.finalSource.files = structuredClone(report.source.files); }];
  for (const [index, change] of changes.entries()) {
    await f.add({ change, created: now - 60000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
});

test('producer scoped-package manifests are accepted but unsafe segments remain invalid even with matching hashes', async t => {
  const f = await owned(t);
  const names = ['server/node_modules/@electric-sql/pglite/dist/index.js',
    'server/node_modules/@/pglite/dist/index.js', 'server/node_modules/@@electric-sql/pglite/dist/index.js',
    'server/node_modules/electric@sql/pglite/dist/index.js', 'server/node_modules/../pglite/dist/index.js',
    'server/node_modules/@../pglite/dist/index.js', 'server/node_modules/@./pglite/dist/index.js',
    'server\\node_modules\\@electric-sql\\pglite\\dist\\index.js', '/server/node_modules/@electric-sql/pglite/dist/index.js'];
  for (const [index, name] of names.entries()) {
    const manifest = [...structuredClone(files), { name, sha256: 'd'.repeat(64) }].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    await f.add({ created: now - 60000 + index * 1000, change: report => {
      report.source = { sha256, files: manifest }; report.finalSource = structuredClone(report.source);
    } });
    assert.equal(await hasLocalP0StudyPreflight(sha256, { root: f.root }), index === 0);
  }
});

test('a report with a full source manifest larger than 256 KiB is accepted unchanged', async t => {
  const f = await owned(t);
  const manifest = Array.from({ length: 1000 }, (_, index) => {
    const name = `server/node_modules/@electric-sql/pglite/dist/synthetic-${String(index).padStart(4, '0')}.js`;
    return { name, sha256: createHash('sha256').update(name).digest('hex') };
  });
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const result = await f.add({ change: report => {
    report.source = { sha256, files: manifest }; report.finalSource = structuredClone(report.source);
  } });
  const contents = Buffer.from(JSON.stringify(result.report, null, 2));
  assert(contents.length > 256 * 1024 && contents.length < 1024 * 1024);
  await fs.writeFile(result.filename, contents);
  const before = await fs.lstat(result.filename);
  assert.equal(await hasLocalP0StudyPreflight(sha256, { root: f.root }), true);
  assert((await fs.readFile(result.filename)).equals(contents));
  assert.equal((await fs.lstat(result.filename)).mtimeMs, before.mtimeMs);
});

test('valid JSON at the 1 MiB boundary is accepted; one extra byte is refused before opening', async t => {
  const f = await owned(t), result = await f.add(), maximumBytes = 1024 * 1024;
  const json = Buffer.from(JSON.stringify(result.report));
  const originalOpen = fs.open.bind(fs); let opens = 0;
  const mocked = t.mock.method(fs, 'open', async (...args) => { opens++; return originalOpen(...args); });
  for (const size of [maximumBytes - 1, maximumBytes, maximumBytes + 1]) {
    // JSON whitespace keeps every case valid, so rejection can only be the size boundary.
    const contents = Buffer.concat([json, Buffer.alloc(size - json.length, 32)]);
    assert.equal(contents.length, size); assert.deepEqual(JSON.parse(contents.toString('utf8')), result.report);
    await fs.writeFile(result.filename, contents); opens = 0;
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), size <= maximumBytes);
    assert.equal(opens, size <= maximumBytes ? 1 : 0);
    assert((await fs.readFile(result.filename)).equals(contents));
  }
  mocked.mock.restore();
});

test('oversized, malformed, empty and invalid UTF-8 reports fail without decoding unbounded data', async t => {
  const f = await owned(t);
  for (const [index, contents] of [Buffer.alloc(1024 * 1024 + 1, 32), '{', '', Buffer.from([0xff, 0xfe])].entries()) {
    await f.add({ contents, created: now - 60000 + index * 1000 });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  }
});

test('root and results symlinks/nonregular files are refused without following their target', async t => {
  const f = await owned(t), result = await f.add(), original = fs.lstat.bind(fs);
  for (const affected of [f.root, result.directory, result.filename]) {
    const mocked = t.mock.method(fs, 'lstat', async filename => {
      const stat = await original(filename);
      return filename === affected ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat;
    });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false); mocked.mock.restore();
  }
  const mocked = t.mock.method(fs, 'lstat', async filename => {
    const stat = await original(filename);
    return filename === result.filename ? Object.assign(Object.create(stat), { isFile: () => false }) : stat;
  });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false); mocked.mock.restore();
});

test('invalid options/digests have no IO or getter side effects; IO errors resolve false', async t => {
  let reads = 0, getters = 0;
  t.mock.method(fs, 'lstat', async () => { reads++; throw Error(privateError); });
  for (const hash of ['', 'A'.repeat(64), 'a'.repeat(63), null, {}, 1]) assert.equal(await hasLocalP0StudyPreflight(hash), false);
  const accessor = {}; Object.defineProperty(accessor, 'root', { get() { getters++; throw Error(privateError); } });
  for (const options of [accessor, { root: '../outside' }, { root: 'C:\\', extra: true }, null])
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, options), false);
  assert.equal(reads, 0); assert.equal(getters, 0);
  assert.equal(await hasLocalP0StudyPreflight(sourceHash), false); assert.equal(reads, 1);
});

test('enumeration is bounded and closes the iterator when either limit is exceeded', async t => {
  const f = await owned(t), original = fs.lstat.bind(fs), rootInfo = await original(f.root);
  for (const matching of [false, true]) {
    let visited = 0, closed = false;
    const list = t.mock.method(fs, 'opendir', async () => (async function* () {
      try {
        const count = matching ? 129 : 4097;
        for (let index = 0; index < count; index++) {
          visited++; yield { name: matching ? `local-p0-study-${randomUUID()}` : `unrelated-${index}` };
        }
      } finally { closed = true; }
    })());
    const stat = t.mock.method(fs, 'lstat', async filename => path.dirname(filename) === f.root ? rootInfo : original(filename));
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
    assert.equal(visited, matching ? 129 : 4097); assert.equal(closed, true);
    stat.mock.restore(); list.mock.restore();
  }
});

test('a file changed during bounded reading is rejected and its read handle still closes', async t => {
  const f = await owned(t), result = await f.add(), original = fs.open.bind(fs); let closed = 0, statCalls = 0;
  const mocked = t.mock.method(fs, 'open', async (filename, flags) => {
    assert.equal(filename, result.filename);
    const handle = await original(filename, flags);
    return { read: (...args) => handle.read(...args), async stat() {
      const info = await handle.stat();
      return ++statCalls === 1 ? info : Object.assign(Object.create(info), { size: info.size + 1 });
    }, async close() { closed++; await handle.close(); } };
  });
  assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
  assert.equal(closed, 1); assert.equal(statCalls, 2); mocked.mock.restore();
});

test('root listing changes after enumeration invalidate a formerly latest report', async t => {
  const f = await owned(t); await f.add(); const original = fs.lstat.bind(fs);
  for (const field of ['mtimeMs', 'ctimeMs']) {
    let rootReads = 0;
    const mocked = t.mock.method(fs, 'lstat', async filename => {
      const info = await original(filename);
      if (filename === f.root && ++rootReads > 1) return Object.assign(Object.create(info), { [field]: info[field] + 1 });
      return info;
    });
    assert.equal(await hasLocalP0StudyPreflight(sourceHash, { root: f.root }), false);
    assert.equal(rootReads, 2); mocked.mock.restore();
  }
});
