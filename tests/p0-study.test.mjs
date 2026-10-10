import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { BASELINE_COMMIT, PUBLIC_ASSET, STUDY_STORAGE_KEY, STUDY_MARKER, TASK_B, LEGACY_NOTE,
  sha256, studyChildEnvironment, studyOptions, seedStudyStorage } from '../scripts/p0-study-policy.mjs';
import { publicSnapshot, serveStudySnapshot, captureWorkingSnapshot } from '../scripts/p0-study-snapshots.mjs';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';

const entries = () => ['index.html', 'favicon.svg', 'src/app.js', 'src/seed.js', 'src/config.js']
  .map((name) => [name, Buffer.from(`synthetic ${name}`)]);
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get length() { return values.size; }, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function sandbox(initial = {}) {
  return { location: { origin: 'http://127.0.0.1:12345' }, localStorage: storage(initial), sessionStorage: storage() };
}
function seed(context, task = 'A') {
  context.input = { origin: 'http://127.0.0.1:12345', fixture: { schema: 2, synthetic: true }, task,
    storageKey: STUDY_STORAGE_KEY, marker: STUDY_MARKER };
  return runInNewContext(`(${seedStudyStorage.toString()})(input)`, context);
}
function get(origin, pathname = '/', headers = {}, method = 'GET') {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: pathname, method, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('study options require explicit synthetic scope and unambiguous manual task/order', () => {
  assert.equal(BASELINE_COMMIT.length, 40);
  assert.deepEqual(studyOptions(['--confirm-synthetic-local']), { interactive: false, task: undefined, versions: ['baseline', 'revised'] });
  assert.deepEqual(studyOptions(['--confirm-synthetic-local', '--interactive', '--task=B', '--order=revised-first']),
    { interactive: true, task: 'B', versions: ['revised', 'baseline'] });
  for (const args of [[], ['--confirm-synthetic-local', '--confirm-synthetic-local'], ['--confirm-synthetic-local', '--url=https://example.com'],
    ['--confirm-synthetic-local', '--task=A'], ['--confirm-synthetic-local', '--interactive'],
    ['--confirm-synthetic-local', '--interactive', '--task=A', '--task=B', '--order=baseline-first']]) assert.throws(() => studyOptions(args));
});

test('study child environment excludes DB/auth/proxy/debug and app settings', () => {
  assert.deepEqual(studyChildEnvironment({ Path: 'synthetic-path', SystemRoot: 'synthetic-windows', TEMP: 'synthetic-temp',
    DATABASE_URL: 'exclude', VERCEL_TOKEN: 'exclude', HTTP_PROXY: 'exclude', NODE_OPTIONS: 'exclude',
    PLAYWRIGHT_MODULE: 'exclude', PLAYWRIGHT_BROWSERS_PATH: 'exclude', APP_URL: 'exclude', AWS_SECRET_ACCESS_KEY: 'exclude' }),
  { Path: 'synthetic-path', SystemRoot: 'synthetic-windows', TEMP: 'synthetic-temp' });
});

test('public allowlist denies private files, nested paths, query/encoding and traversal', () => {
  for (const name of ['index.html', 'favicon.svg', 'src/app.js', 'src/record-ui.js', 'src/styles.css']) assert.equal(PUBLIC_ASSET.test(name), true);
  for (const name of ['.env', 'server/auth.mjs', 'docs/p0-user-validation.md', 'package.json', 'src/../server.js',
    'src/a/b.js', 'src/app.js?token=x', 'src/%61pp.js', 'src\\app.js', 'src/app.js\n', 'test-results/results.json']) assert.equal(PUBLIC_ASSET.test(name), false);
});

test('public snapshot defensively copies bytes and pins exact sorted per-file fingerprints', () => {
  const source = entries(), snapshot = publicSnapshot(source, 'test');
  const original = snapshot.read('src/app.js'), fingerprint = snapshot.manifest.sha256;
  source[2][1].fill(0); snapshot.read('src/app.js').fill(0);
  assert.deepEqual(snapshot.read('src/app.js'), original);
  assert.equal(snapshot.manifest.sha256, fingerprint);
  assert.equal(snapshot.manifest.assets.find((asset) => asset.name === 'src/app.js').sha256, sha256(original));
  assert.equal(publicSnapshot([...entries()].reverse(), 'test').manifest.sha256, fingerprint);
  assert.equal(snapshot.read('.env'), null); assert.ok(Object.isFrozen(snapshot.manifest.assets));
  assert.throws(() => publicSnapshot([...entries(), ['.env', Buffer.from('synthetic')]], 'test'));
  assert.throws(() => publicSnapshot([...entries(), entries()[0]], 'test'));
  assert.throws(() => publicSnapshot(entries().slice(1), 'test'));
});

test('current-only snapshot works without Git and cannot serve private files or change after capture',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'carebridge-snapshot-test-'));
  const original=await realpath(folder);
  try{
    await mkdir(join(folder,'src'));
    for(const [name,bytes]of entries())await writeFile(join(folder,name),bytes);
    await writeFile(join(folder,'.env'),'SYNTHETIC_DO_NOT_SERVE');
    await writeFile(join(folder,'src','private.json'),'SYNTHETIC_DO_NOT_SERVE');
    const snapshot=await captureWorkingSnapshot(folder);
    assert.equal(snapshot.manifest.assets.length,5);assert.equal(snapshot.read('.env'),null);assert.equal(snapshot.read('src/private.json'),null);
    const initial=snapshot.read('src/app.js');await writeFile(join(folder,'src','app.js'),'changed synthetic source');
    assert.deepEqual(snapshot.read('src/app.js'),initial);assert.notDeepEqual(await readFile(join(folder,'src','app.js')),initial);
    assert.equal(snapshot.manifest.sha256,publicSnapshot(entries(),'synthetic').manifest.sha256);
  }finally{
    const target=await realpath(folder),child=relative(resolve(tmpdir()),target);
    assert.equal(target,original);assert(!isAbsolute(child)&&!child.startsWith('..')&&child.startsWith('carebridge-snapshot-test-'));
    await rm(target,{recursive:true,force:true});
  }
});

test('synthetic seed uses the assigned role and preserves changed data on reload', () => {
  for (const [task, role] of [['A', 'guardian'], ['B', 'therapist']]) {
    const context = sandbox(); assert.equal(seed(context, task), 'seeded');
    assert.equal(JSON.parse(context.sessionStorage.getItem('child-development-view')).account, role);
    context.localStorage.setItem(STUDY_STORAGE_KEY, 'synthetic changed');
    assert.equal(seed(context, task), 'preserved');
    assert.equal(context.localStorage.getItem(STUDY_STORAGE_KEY), 'synthetic changed');
  }
});

test('synthetic seed refuses existing site data, absent experiment data and another origin', () => {
  for (const initial of [{ unrelated: 'keep' }, { [STUDY_STORAGE_KEY]: 'keep' },
    { [STUDY_MARKER]: 'synthetic-v1' }, { [STUDY_MARKER]: 'invalid', [STUDY_STORAGE_KEY]: 'keep' }]) {
    const context = sandbox(initial); assert.throws(() => seed(context));
    for (const [key, value] of Object.entries(initial)) assert.equal(context.localStorage.getItem(key), value);
  }
  const session = sandbox(); session.sessionStorage.setItem('existing', 'keep'); assert.throws(() => seed(session));
  const other = sandbox(); other.location.origin = 'https://example.com';
  assert.equal(seed(other), 'outside-origin'); assert.equal(other.localStorage.length, 0);
});

test('task B preserves second measurement as explicit legacy text and real numeric zero', () => {
  assert.equal(TASK_B.assessments[1].value, 0);
  assert.ok(LEGACY_NOTE.includes('도움 횟수 / 0 / 회 / 동일한 가상 놀이 공간'));
  assert.ok(LEGACY_NOTE.includes(TASK_B.performed) && LEGACY_NOTE.includes(TASK_B.response));
});

test('loopback snapshot HTTP serves exact bytes and denies writes, foreign hosts/origins and private paths', async () => {
  const snapshot = publicSnapshot(entries(), 'test'), server = await serveStudySnapshot(snapshot);
  try {
    const result = await get(server.origin);
    assert.equal(result.status, 200); assert.deepEqual(result.body, snapshot.read('index.html'));
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.ok(result.headers['content-security-policy'].includes("frame-ancestors 'none'"));
    const head = await get(server.origin, '/src/app.js', {}, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), snapshot.read('src/app.js').length);
    for (const pathname of ['/.env', '/api/auth/session', '/server/auth.mjs', '/docs/p0-user-validation.md',
      '/src/', '/src/../index.html', '/src/%61pp.js', '/src/app.js?token=x', '/src/missing.js', '/index.html/'])
      assert.equal((await get(server.origin, pathname)).status, 404, pathname);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await get(server.origin, '/', {}, method)).status, 405);
    for (const headers of [{ Host: 'example.com' }, { Host: `localhost:${new URL(server.origin).port}` },
      { Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await get(server.origin, '/', headers)).status, 403);
  } finally { await server.close(); }
  await assert.rejects(get(server.origin));
});
