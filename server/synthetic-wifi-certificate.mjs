import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateSecretEnvironment } from './windows-private-secret-io.mjs';

const script = fileURLToPath(new URL('../scripts/synthetic-wifi-certificate-provider.ps1', import.meta.url));
const unavailable = () => new Error('SYNTHETIC_WIFI_CERTIFICATE_UNAVAILABLE');
const invalid = () => { throw new TypeError('SYNTHETIC_WIFI_CERTIFICATE_CONFIG_INVALID'); };
const certificatePem = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/;
const privateKeyPem = /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----$/;

function capture(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== 2) invalid();
  const result = {};
  for (const name of ['host', 'powershell']) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result[name] = descriptor.value;
  }
  if (typeof result.host !== 'string' || !isIPv4(result.host)) invalid();
  const [a, b] = result.host.split('.').map(Number);
  if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || result.host === '127.0.0.1')) invalid();
  const executable = result.powershell;
  if (typeof executable !== 'string' || !/^[A-Za-z]:[\\/]/.test(executable) || !win32.isAbsolute(executable) ||
      !/^pwsh\.exe$/i.test(win32.basename(executable)) || /[\0\r\n]/.test(executable) ||
      executable.slice(2).includes(':') || executable.trim() !== executable) invalid();
  return result;
}

async function resolveRuntime(executable) {
  if (process.platform !== 'win32') throw unavailable();
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
  const canonical = await realpath(executable);
  if (win32.normalize(canonical).toLowerCase() !== win32.normalize(executable).toLowerCase()) throw unavailable();
  return canonical;
}

function materialFromReport(text, host) {
  let key;
  try {
    const report = JSON.parse(text);
    if (!report || Object.keys(report).sort().join(',') !== 'ca,cert,expiresAt,fingerprint,key,publicCertificate,purpose,schema' ||
        report.schema !== 1 || report.purpose !== 'synthetic-wifi-memory-certificate' ||
        typeof report.cert !== 'string' || !certificatePem.test(report.cert) ||
        typeof report.ca !== 'string' || !certificatePem.test(report.ca) ||
        typeof report.key !== 'string' || !privateKeyPem.test(report.key) ||
        typeof report.publicCertificate !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(report.publicCertificate) ||
        typeof report.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(report.fingerprint) ||
        typeof report.expiresAt !== 'string') throw unavailable();
    const cert = Buffer.from(report.cert, 'ascii'), ca = Buffer.from(report.ca, 'ascii');
    const publicCertificate = Buffer.from(report.publicCertificate, 'base64');
    key = Buffer.from(report.key, 'ascii');
    const leaf = new X509Certificate(cert), root = new X509Certificate(ca), privateKey = createPrivateKey(key);
    const leafUntil = Date.parse(leaf.validTo), rootUntil = Date.parse(root.validTo), now = Date.now();
    const leafFrom = Date.parse(leaf.validFrom), rootFrom = Date.parse(root.validFrom);
    if (!root.ca || leaf.ca || !root.verify(root.publicKey) || !leaf.checkIssued(root) || !leaf.verify(root.publicKey) ||
        !leaf.checkPrivateKey(privateKey) || root.checkPrivateKey(privateKey) ||
        !root.raw.equals(publicCertificate) || publicCertificate.toString('base64') !== report.publicCertificate ||
        leaf.subjectAltName !== `IP Address:${host}` || leaf.checkIP(host) !== host ||
        !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
        [root.publicKey, leaf.publicKey].some(value => value.asymmetricKeyType !== 'rsa' || value.asymmetricKeyDetails?.modulusLength !== 2048) ||
        ![leafFrom, leafUntil, rootFrom, rootUntil].every(Number.isFinite) ||
        leafFrom > now || rootFrom > now || leafUntil <= now || rootUntil <= leafUntil ||
        leafUntil - leafFrom > 24 * 60 * 60 * 1000 || rootUntil - rootFrom > 25 * 60 * 60 * 1000 ||
        Date.parse(report.expiresAt) !== leafUntil ||
        createHash('sha256').update(publicCertificate).digest('hex') !== report.fingerprint) throw unavailable();
    const result = { expiresAt: new Date(leafUntil).toISOString(), fingerprint: report.fingerprint };
    for (const [name, value] of Object.entries({ cert, key, ca, publicCertificate }))
      Object.defineProperty(result, name, { value, enumerable: false });
    Object.defineProperty(result, 'toJSON', { value: () => '[redacted]', enumerable: false });
    return Object.freeze(result);
  } catch {
    key?.fill(0);
    throw unavailable();
  }
}

function generate(executable, host) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      cwd: dirname(script), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: privateSecretEnvironment(process.env, executable),
    });
    const chunks = [];
    let bytes = 0, failed = false, timedOut = false, exited = false, closed = false, settled = false;
    let exitCode, exitSignal, terminalTimer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminalTimer);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    const terminate = () => {
      try { child.kill(); } catch { /* Failure must never contain runtime output. */ }
      terminalTimer ??= setTimeout(() => {
        // Do not retain unbounded pipe handles if OS termination cannot be
        // confirmed. This remains a failed run, never successful generation.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        settle(unavailable());
      }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 30000);
    const finish = () => {
      if (settled || !closed || !child.stdin.closed || !child.stdout.closed || !child.stderr.closed) return;
      if (!exited || failed || timedOut || exitCode !== 0 || exitSignal !== null) {
        settle(unavailable()); return;
      }
      const output = Buffer.concat(chunks);
      try { settle(null, materialFromReport(output.toString('utf8'), host)); }
      catch { settle(unavailable()); }
      finally { output.fill(0); }
    };
    child.on('error', () => { failed = true; });
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 32768) { data.fill(0); failed = true; terminate(); }
      else if (!settled && !failed) chunks.push(data);
      else data.fill(0);
    });
    child.stderr.on('data', data => { data.fill(0); failed = true; terminate(); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => { failed = true; terminate(); });
      stream.on('close', finish);
    }
    child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
    child.on('close', () => { closed = true; finish(); });
    // The private host is not placed in command-line arguments or log output.
    child.stdin.end(JSON.stringify({ host }));
  });
}

/**
 * Creates one memory-only synthetic root + server certificate pair. This does
 * not authorize a listener, change firewall/trust, persist a key, or enable a
 * real-data service. Buffers are intentionally non-enumerable; callers must
 * access them explicitly, and must release/zero their owned key after use.
 */
export async function generateSyntheticWifiCertificate(input) {
  const { host, powershell } = capture(input);
  try { return await generate(await resolveRuntime(powershell), host); }
  catch { throw unavailable(); }
}
