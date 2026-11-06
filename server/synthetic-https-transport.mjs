import { X509Certificate, createPrivateKey } from 'node:crypto';
import { createServer } from 'node:https';
import { isIPv4 } from 'node:net';

const owned = new WeakSet();
const fail = () => { throw new TypeError('SYNTHETIC_HTTPS_CONFIG_INVALID'); };
const secureHeaders = new Set(['host', 'origin', 'sec-fetch-site', 'cookie', 'content-type', 'content-length',
  'transfer-encoding', 'x-carebridge-request', 'x-carebridge-account', 'range']);
function privateIPv4(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function capture(input) {
  const names = ['mode', 'host', 'peerAddress', 'cert', 'key', 'confirmSynthetic'];
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== names.length) fail();
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    result[name] = descriptor.value;
  }
  if (result.confirmSynthetic !== true || !['private-wifi', 'loopback-verification'].includes(result.mode)) fail();
  if (result.mode === 'loopback-verification') {
    if (result.host !== '127.0.0.1' || result.peerAddress !== '127.0.0.1') fail();
  } else if (!privateIPv4(result.host) || !privateIPv4(result.peerAddress) || result.host === result.peerAddress) fail();
  if (!Buffer.isBuffer(result.cert) || result.cert.length < 128 || result.cert.length > 65536 ||
      !Buffer.isBuffer(result.key) || result.key.length < 128 || result.key.length > 16384) fail();
  return { ...result, cert: Buffer.from(result.cert), key: Buffer.from(result.key) };
}

export function isSyntheticHttpsTransport(value) { return owned.has(value); }

// Only a transport boundary, never an identity or user permission. No DNS,
// firewall, certificate-store, disk or deployment side effect occurs here.
// A caller still needs explicit LAN/trust approval and one owned session lifetime.
export class SyntheticHttpsTransport {
  #host; #peer; #mode; #cert; #key; #expires; #starts; #server = null; #origin = null;
  #sockets = new WeakSet(); #closed = false;
  constructor(input) {
    if (new.target !== SyntheticHttpsTransport) fail();
    const selected = capture(input);
    try {
      const certificate = new X509Certificate(selected.cert), key = createPrivateKey(selected.key);
      const from = Date.parse(certificate.validFrom), until = Date.parse(certificate.validTo), now = Date.now();
      const publicKey = certificate.publicKey, detail = publicKey.asymmetricKeyDetails;
      const strongKey = publicKey.asymmetricKeyType === 'rsa' && detail?.modulusLength >= 2048 ||
        publicKey.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1'].includes(detail?.namedCurve);
      if (certificate.ca || !strongKey || !certificate.checkPrivateKey(key) || certificate.checkIP(selected.host) !== selected.host ||
          !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || !Number.isFinite(from) || !Number.isFinite(until) ||
          from > now || until <= now || until - from > 48 * 60 * 60 * 1000 || until - now > 48 * 60 * 60 * 1000) fail();
      this.#host = selected.host; this.#peer = selected.peerAddress; this.#mode = selected.mode;
      this.#cert = selected.cert; this.#key = key; this.#starts = from; this.#expires = until;
      owned.add(this); Object.freeze(this);
    } catch { fail(); }
    finally { selected.key.fill(0); }
  }
  get host() { return this.#host; }
  get mode() { return this.#mode; }
  get origin() { return this.#origin; }
  get active() { return !this.#closed && Boolean(this.#origin) && Date.now() >= this.#starts && Date.now() < this.#expires; }
  createServer(handler) {
    if (this.#closed || this.#server || Date.now() >= this.#expires || typeof handler !== 'function') fail();
    // Keep crypto policy independent from HTTP headers or runtime environment.
    const pem = Buffer.from(this.#key.export({ type: 'pkcs8', format: 'pem' }));
    let server;
    try {
      server = createServer({ cert: this.#cert, key: pem, minVersion: 'TLSv1.2', handshakeTimeout: 5000,
        maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, handler);
    } finally { pem.fill(0); }
    this.#server = server;
    server.on('secureConnection', socket => {
      if (this.#closed) { socket.destroy(); return; }
      this.#sockets.add(socket);
    });
    server.on('tlsClientError', (_, socket) => { socket.destroy(); });
    server.on('upgrade', (_, socket) => socket.destroy());
    server.on('connect', (_, socket) => socket.destroy());
    server.once('close', () => this.invalidate());
    return server;
  }
  activate() {
    const address = this.#server?.address();
    if (this.#closed || this.#origin || !address || address.address !== this.#host ||
        !Number.isSafeInteger(address.port) || address.port < 1024 || Date.now() < this.#starts || Date.now() >= this.#expires) fail();
    this.#origin = `https://${this.#host}:${address.port}`;
    return this.#origin;
  }
  accepts(request) {
    if (!this.active || !this.#sockets.has(request?.socket)) return false;
    const socket = request.socket, expected = new URL(this.#origin), headers = request.headers;
    if (socket.encrypted !== true || !['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol()) ||
        socket.localAddress !== this.#host || String(socket.localPort) !== expected.port ||
        ![this.#host, this.#peer].includes(socket.remoteAddress) || !headers || headers.host !== expected.host ||
        !['GET', 'HEAD', 'POST'].includes(request.method) || typeof request.url !== 'string' ||
        !request.url.startsWith('/') || request.url.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(request.url) ||
        !Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2) return false;
    const seen = new Set();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (secureHeaders.has(name) && seen.has(name)) return false;
      seen.add(name);
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'upgrade') return false;
    }
    if (headers.origin !== undefined && headers.origin !== this.#origin ||
        headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(headers['sec-fetch-site'])) return false;
    // Static navigations may use fetch-site:none. Writes must always prove
    // same-origin intent; the API also enforces its content type/body rules.
    return request.method !== 'POST' || headers.origin === this.#origin && headers['x-carebridge-request'] === '1' &&
      (headers['sec-fetch-site'] === undefined || headers['sec-fetch-site'] === 'same-origin');
  }
  invalidate() {
    this.#closed = true; this.#sockets = new WeakSet(); this.#cert = null; this.#key = null;
    // Dropping references is not a claim of secure RAM zeroization. The owning
    // listener must still close sockets and drain API/media work before disposal.
  }
}
