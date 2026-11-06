// Fixed synthetic Wi-Fi child. TLS material arrives only on this child's
// inherited private stdin pipe; IPC carries nonsecret bootstrap/control only.
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePrivateSecretFrame } from './windows-private-secret-io.mjs';
import { nativeApiInstanceId, nativeApiTestUnavailable } from './windows-native-api-test-policy.mjs';
import { runWindowsNativeApiTestChild } from './windows-native-api-test-control.mjs';

const MAX_FRAME = 16384 + 4;
function secretBytes(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw nativeApiTestUnavailable();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) { bytes.fill(0); throw nativeApiTestUnavailable(); }
  return bytes;
}

// Exported for isolated pipe tests only. Production fixes the 5s deadline and
// requires EOF: a complete-looking prefix is never enough to admit secrets.
export function readWifiTlsBootstrap(input, instanceId) {
  nativeApiInstanceId(instanceId);
  if (!(input instanceof Readable) || input.destroyed || input.readableEnded || input.readableEncoding ||
      input.listenerCount('data')) throw nativeApiTestUnavailable();
  // Node installs its own end listener on Windows' inherited stdin Socket.
  // Preserve runtime lifecycle listeners; never share an existing data reader.
  return new Promise((resolveSecret, reject) => {
    const bytes = Buffer.alloc(MAX_FRAME);
    let length = 0, expected, settled = false;
    const complete = (error, secret) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      input.removeListener('data', data); input.removeListener('end', end);
      input.removeListener('error', fail); input.removeListener('close', fail);
      bytes.fill(0); input.destroy();
      if (error) reject(nativeApiTestUnavailable()); else resolveSecret(secret);
    };
    const fail = () => complete(nativeApiTestUnavailable());
    const data = (chunk) => {
      try {
        if (!Buffer.isBuffer(chunk) || length + chunk.length > MAX_FRAME) throw nativeApiTestUnavailable();
        chunk.copy(bytes, length); length += chunk.length;
        if (length >= 4 && expected === undefined) {
          expected = bytes.readUInt32BE(0) + 4;
          if (expected < 6 || expected > MAX_FRAME) throw nativeApiTestUnavailable();
        }
        if (expected !== undefined && length > expected) throw nativeApiTestUnavailable();
      } catch { fail(); }
      finally { if (Buffer.isBuffer(chunk)) chunk.fill(0); }
    };
    const end = () => {
      let cert, key;
      try {
        if (expected !== length) throw nativeApiTestUnavailable();
        const value = decodePrivateSecretFrame(bytes.subarray(0, length));
        const keys = ['purpose', 'instanceId', 'cert', 'key'];
        if (Reflect.ownKeys(value).length !== keys.length || keys.some((name) => !Object.hasOwn(value, name)) ||
            value.purpose !== 'synthetic-wifi-tls-v1' || value.instanceId !== instanceId) throw nativeApiTestUnavailable();
        cert = secretBytes(value.cert); key = secretBytes(value.key);
        // JSON/base64 strings cannot be reliably erased by JavaScript. Keep
        // them out of all logs and release references promptly; owned Buffers
        // are overwritten on every error and by the service wrapper below.
        complete(undefined, Object.freeze({ cert, key }));
      } catch { cert?.fill(0); key?.fill(0); fail(); }
    };
    const timer = setTimeout(fail, 5000);
    input.on('data', data); input.once('end', end); input.once('error', fail); input.once('close', fail);
  });
}

async function run() {
  let privateInput;
  try {
    if (process.platform !== 'win32' || process.env.CAREBRIDGE_NATIVE_WIFI_API_CHILD !== 'synthetic-only' ||
        process.argv.length !== 3) throw nativeApiTestUnavailable();
    const instanceId = nativeApiInstanceId(process.argv[2]);
    privateInput = readWifiTlsBootstrap(process.stdin, instanceId);
    privateInput.catch(() => {});
    await runWindowsNativeApiTestChild({ instanceId, wifi: true,
      readActiveResources: () => process.getActiveResourcesInfo(),
      createService: async (bootstrap) => {
        const secret = await privateInput;
        try {
          const { createWindowsWifiApiService } = await import('./windows-local-api-service.mjs');
          return await createWindowsWifiApiService({ ...bootstrap, cert: secret.cert, key: secret.key });
        } finally { secret.cert.fill(0); secret.key.fill(0); }
      },
    });
  } catch {
    process.stderr.write('NATIVE_API_FAILED\n');
    if ([undefined, null, 0].includes(process.exitCode)) process.exitCode = 1;
    if (process.connected) process.disconnect();
  } finally {
    process.stdin.destroy();
    try {
      const secret = await privateInput;
      secret?.cert.fill(0); secret?.key.fill(0);
    } catch { /* Only the fixed failure diagnostic above is permitted. */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
