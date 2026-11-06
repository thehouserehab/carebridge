import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const powershell = process.env.CAREBRIDGE_TEST_POWERSHELL;
const windowsOnly = process.platform !== 'win32' || !powershell
  ? 'Windows and an explicit CAREBRIDGE_TEST_POWERSHELL executable are required.' : false;
const childScript = fileURLToPath(new URL('./fixtures/postgres-prepare-lock-child.ps1', import.meta.url));

test('runtime preparer acquires only after private-path validation and disposes without path deletion', async () => {
  const source = await readFile(new URL('../scripts/prepare-beta-postgres.ps1', import.meta.url), 'utf8');
  assert.match(source, /Assert-PrivatePath \$runtimeRoot \$true\s+\$lockPath = Join-Path/);
  assert.match(source, /\$lock = Open-CarebridgePostgresPrepareLock -Path \$lockPath\s+try \{\s+\$reused = Test-Path/);
  assert.match(source, /finally \{\s+\$lock\.Dispose\(\)\s+\}/);
  assert.doesNotMatch(source, /(?:Delete|Remove-Item)[^\r\n]*\$lockPath/);
});

async function fixture(t) {
  assert(path.isAbsolute(powershell), 'Use an explicit absolute PowerShell 7 path.');
  const directory = await mkdtemp(path.join(tmpdir(), 'carebridge-prepare-lock-test-'));
  const lockPath = path.join(directory, '.prepare-postgres.lock');
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (!child.ended) child.process.kill('SIGKILL');
      await child.closed;
    }
    // This unique fixture has one known file only. Never recursively delete.
    const entries = await readdir(directory);
    assert(entries.every(name => name === '.prepare-postgres.lock'), 'Unexpected fixture files; retained.');
    if (entries.length) await unlink(lockPath);
    await rmdir(directory);
  });
  function start(mode) {
    const process = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', childScript,
      '-LockPath', lockPath, '-Mode', mode], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    const child = {process, ended: false, stdout: '', stderr: '', error: null};
    child.closed = new Promise(resolve => {
      process.on('error', error => { child.error = error; });
      process.stdout.on('data', data => { child.stdout += data; });
      process.stderr.on('data', data => { child.stderr += data; });
      process.on('close', (code, signal) => {
        child.ended = true;
        resolve({code, signal});
      });
    });
    child.acquired = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Fixture lock acquisition timed out.')), 15_000);
      const inspect = () => {
        if (child.stdout.includes('LOCK_ACQUIRED')) { clearTimeout(deadline); resolve(); }
      };
      process.stdout.on('data', inspect);
      child.closed.then(result => {
        clearTimeout(deadline);
        if (!child.stdout.includes('LOCK_ACQUIRED')) reject(child.error ?? new Error(`Lock not acquired (${result.code}).`));
      });
    });
    // Rejected acquisition is expected in collision tests; it is still observed.
    child.acquired.catch(() => {});
    children.push(child);
    return child;
  }
  return {lockPath, start};
}

async function assertAbsent(lockPath) {
  await assert.rejects(stat(lockPath), error => error.code === 'ENOENT');
}

test('prepare lock disappears after normal handle disposal', {skip: windowsOnly, timeout: 30_000}, async t => {
  const {lockPath, start} = await fixture(t);
  const child = start('close');
  assert.deepEqual(await child.closed, {code: 0, signal: null});
  assert.equal(child.error, null);
  assert.match(child.stdout, /LOCK_ACQUIRED/);
  await assertAbsent(lockPath);
});

test('prepare lock disappears after an exception', {skip: windowsOnly, timeout: 30_000}, async t => {
  const {lockPath, start} = await fixture(t);
  const child = start('throw');
  assert.notEqual((await child.closed).code, 0);
  assert.equal(child.error, null);
  assert.match(child.stdout, /LOCK_ACQUIRED/);
  assert.match(child.stderr, /Intentional lock fixture failure/);
  await assertAbsent(lockPath);
});

test('prepare lock disappears after force-kill and observed process close', {skip: windowsOnly, timeout: 30_000}, async t => {
  const {lockPath, start} = await fixture(t);
  const child = start('hold');
  await child.acquired;
  assert((await stat(lockPath)).isFile());
  assert.equal(child.process.kill('SIGKILL'), true);
  const result = await child.closed;
  assert.equal(child.ended, true);
  assert.equal(child.error, null);
  assert(result.signal === 'SIGKILL' || result.code !== 0);
  await assertAbsent(lockPath);
});

test('a preexisting lock sentinel is rejected and remains unchanged', {skip: windowsOnly, timeout: 30_000}, async t => {
  const {lockPath, start} = await fixture(t);
  const sentinel = Buffer.from('preexisting owner — do not modify\n');
  await writeFile(lockPath, sentinel, {flag: 'wx'});
  const before = await stat(lockPath);
  const child = start('close');
  assert.notEqual((await child.closed).code, 0);
  assert.equal(child.error, null);
  assert.doesNotMatch(child.stdout, /LOCK_ACQUIRED/);
  assert.deepEqual(await readFile(lockPath), sentinel);
  const after = await stat(lockPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('failed concurrent acquisition cannot remove the incumbent lock', {skip: windowsOnly, timeout: 30_000}, async t => {
  const {lockPath, start} = await fixture(t);
  const incumbent = start('hold');
  await incumbent.acquired;
  const before = await stat(lockPath);
  const contender = start('close');
  assert.notEqual((await contender.closed).code, 0);
  assert.equal(contender.error, null);
  assert.doesNotMatch(contender.stdout, /LOCK_ACQUIRED/);
  assert.equal(incumbent.ended, false);
  assert.equal((await stat(lockPath)).ino, before.ino);
  await assert.rejects(readFile(lockPath), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
  incumbent.process.stdin.end('release\n');
  assert.deepEqual(await incumbent.closed, {code: 0, signal: null});
  await assertAbsent(lockPath);
});
