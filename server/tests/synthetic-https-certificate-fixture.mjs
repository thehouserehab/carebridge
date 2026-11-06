// Test-only, opt-in Windows certificate generation. No PATH search, filesystem
// key/certificate artifacts, certificate-store imports or trust changes.
import { spawn } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const unavailable = () => new Error('SYNTHETIC_HTTPS_CERTIFICATE_UNAVAILABLE');
const script = fileURLToPath(new URL('./synthetic-https-certificate-fixture.ps1', import.meta.url));

async function explicitPowerShell() {
  const executable = process.env.CAREBRIDGE_TEST_POWERSHELL;
  if (process.platform !== 'win32' || typeof executable !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(executable) || !win32.isAbsolute(executable) ||
      !/^pwsh\.exe$/i.test(win32.basename(executable)) || /[\0\r\n]/.test(executable) ||
      executable.slice(2).includes(':') || executable.trim() !== executable) throw unavailable();
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
  const canonical = await realpath(executable);
  if (win32.normalize(canonical).toLowerCase() !== win32.normalize(executable).toLowerCase()) throw unavailable();
  return canonical;
}

function generate(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      cwd: dirname(script), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', bytes = 0, invalid = false, timedOut = false;
    let exited = false, closed = false, exitCode, exitSignal, settled = false, terminalTimer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminalTimer);
      output = '';
      if (error) reject(error); else resolve(value);
    };
    const terminate = () => {
      try { child.kill(); } catch { /* The safe failure below contains no child output. */ }
      // Never report successful generation without observed exit and pipe close.
      // A failed termination also fails the fixture instead of waiting forever.
      terminalTimer ??= setTimeout(() => settle(unavailable()), 5000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 30000);
    const finish = () => {
      if (settled || !closed || !child.stdout.closed || !child.stderr.closed) return;
      if (!exited || invalid || timedOut || exitCode !== 0 || exitSignal !== null) {
        settle(unavailable()); return;
      }
      let key;
      try {
        const result = JSON.parse(output);
        if (!result || Object.keys(result).sort().join(',') !== 'cert,key,purpose,schema' ||
            result.schema !== 1 || result.purpose !== 'synthetic-memory-https-certificate' ||
            typeof result.cert !== 'string' || typeof result.key !== 'string' ||
            !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(result.cert) ||
            !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----$/.test(result.key)) throw unavailable();
        const cert = Buffer.from(result.cert, 'ascii');
        key = Buffer.from(result.key, 'ascii');
        const certificate = new X509Certificate(cert);
        if (!certificate.checkPrivateKey(createPrivateKey(key)) ||
            certificate.subjectAltName !== 'IP Address:127.0.0.1, IP Address:10.231.9.10') throw unavailable();
        settle(null, { cert, key });
      } catch {
        key?.fill(0);
        settle(unavailable());
      }
    };
    child.on('error', () => { invalid = true; });
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 16384) { invalid = true; output = ''; terminate(); }
      else if (!settled && !invalid) output += data.toString('utf8');
    });
    child.stderr.on('data', () => { invalid = true; });
    child.stdout.on('error', () => { invalid = true; terminate(); });
    child.stderr.on('error', () => { invalid = true; terminate(); });
    child.stdout.on('close', finish);
    child.stderr.on('close', finish);
    child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
    child.on('close', () => { closed = true; finish(); });
  });
}

/** Returns fresh PEM Buffers to the owning test; never logs or persists them. */
export async function syntheticHttpsCertificate() {
  try { return await generate(await explicitPowerShell()); }
  catch { throw unavailable(); }
}
