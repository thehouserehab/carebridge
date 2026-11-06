// Real Windows file-share/ACL test, synthetic OS temp only. Opt in with the
// explicit PowerShell 7 executable path; never searches PATH or touches E.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, lstat, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.env.CAREBRIDGE_TEST_POWERSHELL;
const enabled = process.platform === 'win32' && typeof executable === 'string' && executable.length > 0;
const options = { skip: enabled ? false : 'Requires Windows and an explicit CAREBRIDGE_TEST_POWERSHELL PowerShell 7 path.' };
let observation;
const unavailable = () => new Error('SYNTHETIC_RECEIPT_TEST_UNAVAILABLE');

async function runOwned() {
  assert(isAbsolute(executable) && /^pwsh\.exe$/i.test(basename(executable)));
  const binary = await lstat(executable); assert(binary.isFile() && !binary.isSymbolicLink());
  const base = await realpath(tmpdir()), root = resolve(await mkdtemp(join(base, 'carebridge-private-receipt-')));
  const original = await lstat(root, { bigint: true });
  let result, terminal = false, cleaned = false;
  try {
    const script = fileURLToPath(new URL('./windows-private-receipt-fixture.ps1', import.meta.url));
    result = await new Promise((resolveResult, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Root', root],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(script) });
      let output = '', bytes = 0, invalid = false, timedOut = false, exited = false, exitCode, signalCode, closed = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
      const finish = () => {
        if (!closed || !child.stdout.closed || !child.stderr.closed) return;
        clearTimeout(timer); terminal = exited || child.pid === undefined;
        if (!terminal || invalid || timedOut || signalCode !== null || ![0, 1].includes(exitCode)) { reject(unavailable()); return; }
        try {
          const report = JSON.parse(output);
          if (report.schema !== 1 || report.purpose !== 'synthetic-private-receipt-sharing' || report.pwshMajor < 7 ||
              typeof report.completed !== 'boolean' || !report.checks || Object.values(report.checks).some(value => typeof value !== 'boolean')) throw unavailable();
          resolveResult({ report, exitCode, exited, closeObserved: closed, stdioClosed: true });
        } catch { reject(unavailable()); }
      };
      child.on('error', () => { invalid = true; });
      child.stdout.on('data', data => { bytes += data.length; if (bytes > 8192) { invalid = true; child.kill(); } else output += data.toString('utf8'); });
      child.stderr.on('data', () => { invalid = true; });
      child.stdout.on('error', () => { invalid = true; }); child.stderr.on('error', () => { invalid = true; });
      child.stdout.on('close', finish); child.stderr.on('close', finish);
      child.on('exit', (code, signal) => { exited = true; exitCode = code; signalCode = signal; });
      child.on('close', (code, signal) => { closed = true; exitCode = code; signalCode = signal; finish(); });
    });
  } finally {
    // An uncertain subprocess is not permission to delete its open files.
    if (terminal) {
      assert.equal(dirname(root), base); assert(/^carebridge-private-receipt-[A-Za-z0-9]+$/.test(basename(root)));
      const current = await lstat(root, { bigint: true });
      assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === original.dev && current.ino === original.ino);
      assert.equal(await realpath(root), root);
      const entries = await readdir(root); assert(entries.every(name => name === 'receipt.json'));
      for (const name of entries) {
        const path = join(root, name), info = await lstat(path, { bigint: true });
        assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n); await unlink(path);
      }
      await rmdir(root); cleaned = true;
    }
  }
  return { ...result, cleaned };
}

before(async () => { if (enabled) observation = await runOwned(); });
function checks(names) {
  const failure = observation.report.failure;
  const stage = ['runtime', 'root', 'root-acl', 'file-acl', 'held-read', 'live-read', 'invalid-content', 'valid-size', 'invalid-acl', 'delete'].includes(failure?.stage) ? failure.stage : 'unknown';
  const line = Number.isSafeInteger(failure?.line) ? failure.line : 0;
  const code = Number.isSafeInteger(failure?.code) ? failure.code : 0;
  assert.equal(observation.report.completed, true, `Synthetic fixture incomplete: stage=${stage}, line=${line}, code=${code}.`);
  for (const name of names) assert.equal(observation.report.checks[name], true, name);
}
test('private receipt reads share safely with both prior and overlapping reader handles', options, t => {
  assert([0, 32].includes(observation.report.sharingViolationCode));
  t.diagnostic(`sharing-violation=${observation.report.sharingViolationCode}`);
  checks(['held-read-allows-helper', 'helper-allows-second-read', 'baseline-failure-is-sharing-violation']);
});
test('active private receipt reader excludes writes and deletion without changing bytes', options, () => {
  checks(['helper-denies-write', 'helper-denies-delete', 'protected-read-preserves-bytes']);
});
test('private receipt retains strict JSON, UTF-8 and minimum/maximum byte limits', options, () => {
  checks(['valid-json', 'malformed-json', 'invalid-utf8', 'empty', 'undersize', 'oversize',
    'size-2-accepted-released', 'size-8192-accepted-released']);
});
test('private receipt rejects a wrong expected ACL policy and releases all failed read handles', options, () => {
  checks(['wrong-expected-acl-policy-rejected', 'acl-failure-releases-handle', 'malformed-json-released', 'invalid-utf8-released',
    'empty-released', 'undersize-released', 'oversize-released']);
});
test('success and sharing failures release handles before owned process exit and exact temp cleanup', options, () => {
  checks(['held-read-cleanup', 'success-releases-handle', 'delete-after-close']);
  assert.equal(observation.exited, true); assert.equal(observation.closeObserved, true); assert.equal(observation.stdioClosed, true);
  assert.equal(observation.cleaned, true);
  assert.equal(observation.exitCode, Object.values(observation.report.checks).every(Boolean) ? 0 : 1);
});
