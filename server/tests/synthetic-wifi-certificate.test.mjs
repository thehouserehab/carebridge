import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer, request } from 'node:https';
import { inspect } from 'node:util';
import { generateSyntheticWifiCertificate } from '../synthetic-wifi-certificate.mjs';

const powershell = process.env.CAREBRIDGE_TEST_POWERSHELL;
const enabled = process.platform === 'win32' && Boolean(powershell);
const options = { host: '127.0.0.1', powershell: 'C:\\SyntheticFixture\\pwsh.exe' };
const invalid = error => error instanceof TypeError && error.message === 'SYNTHETIC_WIFI_CERTIFICATE_CONFIG_INVALID';

test('synthetic Wi-Fi certificate input is closed, data-only and excludes public or ambiguous hosts', async () => {
  let getterCalled = false;
  for (const input of [undefined, null, [], new Date(), {}, { ...options, extra: true },
    Object.create(options), { ...options, [Symbol('extra')]: true },
    ...['0.0.0.0', '127.0.0.2', '8.8.8.8', '169.254.1.2', '172.15.1.2', '172.32.1.2',
      '192.0.2.1', '10.01.2.3', '10.1.2.3 ', 'localhost', '::1', '::ffff:127.0.0.1',
      '10.1.2.3/24', 'https://10.1.2.3', 123].map(host => ({ ...options, host })),
    ...['pwsh', 'pwsh.exe', 'C:\\Tools\\cmd.exe', 'C:\\Tools\\pwsh.exe:stream',
      '\\\\synthetic\\share\\pwsh.exe', 'C:\\Tools\\pwsh.exe ', 'C:\\Tools\\pwsh.exe\n', null]
      .map(value => ({ ...options, powershell: value })),
    Object.defineProperty({ ...options }, 'host', { get() { getterCalled = true; return '127.0.0.1'; } }),
    Object.defineProperty({ ...options }, 'powershell', { get() { getterCalled = true; return options.powershell; } }),
  ]) await assert.rejects(generateSyntheticWifiCertificate(input), invalid);
  assert.equal(getterCalled, false);
});

// Minimal bounded DER reading for exact certificate-extension assertions. These
// public certificate bytes are not trusted executable instructions or files.
function element(bytes, offset = 0) {
  assert.ok(offset >= 0 && offset + 2 <= bytes.length);
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    assert.ok(count >= 1 && count <= 4 && offset + count <= bytes.length);
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
  }
  assert.ok(offset + length <= bytes.length);
  return { tag, bytes: bytes.subarray(offset, offset + length), end: offset + length };
}
function children(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    const child = element(bytes, offset);
    result.push(child);
    offset = child.end;
  }
  return result;
}
function extension(certificate, oid) {
  const outer = element(certificate.raw);
  assert.equal(outer.tag, 0x30);
  const tbs = children(outer.bytes)[0];
  const extensions = children(tbs.bytes).find(value => value.tag === 0xa3);
  assert.ok(extensions);
  const sequence = element(extensions.bytes);
  const matches = children(sequence.bytes).map(value => children(value.bytes))
    .filter(values => values[0].tag === 0x06 && values[0].bytes.toString('hex') === oid);
  assert.equal(matches.length, 1);
  const values = matches[0], value = values.at(-1);
  assert.equal(value.tag, 0x04);
  return { critical: values.length === 3 && values[1].tag === 0x01 && values[1].bytes[0] === 0xff,
    bytes: value.bytes };
}
function signingAlgorithm(certificate) {
  const outer = children(element(certificate.raw).bytes);
  return children(outer[1].bytes)[0].bytes.toString('hex');
}

describe('memory-only Wi-Fi root and server certificate provider', {
  concurrency: false,
  skip: enabled ? false : 'Requires Windows and an explicit CAREBRIDGE_TEST_POWERSHELL PowerShell 7 path.',
}, () => {
  let loopback, fictional;
  before(async () => {
    loopback = await generateSyntheticWifiCertificate({ host: '127.0.0.1', powershell });
    // An invented RFC1918 address is only a certificate SAN. No socket binds
    // to or connects to that address during any test.
    fictional = await generateSyntheticWifiCertificate({ host: '10.231.9.10', powershell });
  });
  after(() => { loopback?.key.fill(0); fictional?.key.fill(0); });

  test('missing explicit runtime fails safely without PATH fallback or raw diagnostics', async () => {
    await assert.rejects(generateSyntheticWifiCertificate({ host: '127.0.0.1',
      powershell: 'C:\\CarebridgeSyntheticAbsentRuntime\\pwsh.exe' }),
    error => error.message === 'SYNTHETIC_WIFI_CERTIFICATE_UNAVAILABLE' && error.cause === undefined);
  });

  test('root and leaf have verified signatures, exact constraints and a bounded lifetime', () => {
    const root = new X509Certificate(loopback.ca), leaf = new X509Certificate(loopback.cert);
    assert.equal(root.ca, true);
    assert.equal(leaf.ca, false);
    assert.equal(root.verify(root.publicKey), true);
    assert.equal(leaf.checkIssued(root), true);
    assert.equal(leaf.verify(root.publicKey), true);
    assert.equal(leaf.checkPrivateKey(createPrivateKey(loopback.key)), true);
    assert.equal(root.checkPrivateKey(createPrivateKey(loopback.key)), false);
    for (const certificate of [root, leaf]) {
      assert.equal(certificate.publicKey.asymmetricKeyType, 'rsa');
      assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 2048);
      assert.equal(signingAlgorithm(certificate), '2a864886f70d01010b'); // sha256WithRSAEncryption
    }
    const rootBasic = extension(root, '551d13'), rootUsage = extension(root, '551d0f');
    const leafBasic = extension(leaf, '551d13'), leafUsage = extension(leaf, '551d0f');
    assert.equal(rootBasic.critical, true);
    assert.equal(rootBasic.bytes.toString('hex'), '30060101ff020100'); // CA=true, pathLen=0
    assert.equal(rootUsage.critical, true);
    assert.equal(rootUsage.bytes.toString('hex'), '03020106'); // keyCertSign | cRLSign
    assert.equal(leafBasic.critical, true);
    assert.equal(leafBasic.bytes.toString('hex'), '3000'); // CA=false
    assert.equal(leafUsage.critical, true);
    assert.equal(leafUsage.bytes.toString('hex'), '030205a0'); // digitalSignature | keyEncipherment
    assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    assert.equal(leaf.subjectAltName, 'IP Address:127.0.0.1');
    assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(leaf.checkIP('10.231.9.10'), undefined);
    const now = Date.now();
    for (const certificate of [root, leaf]) {
      const starts = Date.parse(certificate.validFrom);
      assert.ok(starts <= now && starts >= now - 3 * 60 * 1000);
    }
    const rootLifetime = Date.parse(root.validTo) - Date.parse(root.validFrom);
    const leafLifetime = Date.parse(leaf.validTo) - Date.parse(leaf.validFrom);
    assert.equal(rootLifetime, (24 * 60 + 1) * 60 * 1000);
    assert.equal(leafLifetime, (23 * 60 + 1) * 60 * 1000);
    assert.equal(loopback.expiresAt, new Date(leaf.validTo).toISOString());
    assert.ok(root.raw.equals(loopback.publicCertificate));
    assert.equal(loopback.fingerprint, createHash('sha256').update(root.raw).digest('hex'));
  });

  test('each root has a unique UUID and the fictional server SAN contains only the requested host', () => {
    const one = new X509Certificate(loopback.ca), two = new X509Certificate(fictional.ca);
    assert.match(one.subject, /^CN=Carebridge synthetic Wi-Fi root [a-f0-9-]{36}$/);
    assert.match(two.subject, /^CN=Carebridge synthetic Wi-Fi root [a-f0-9-]{36}$/);
    assert.notEqual(one.subject, two.subject);
    assert.notEqual(loopback.fingerprint, fictional.fingerprint);
    const leaf = new X509Certificate(fictional.cert);
    assert.equal(leaf.subjectAltName, 'IP Address:10.231.9.10');
    assert.equal(leaf.checkIP('10.231.9.10'), '10.231.9.10');
    assert.equal(leaf.checkIP('127.0.0.1'), undefined);
  });

  test('material is explicit-access only, with redacted JSON and no returned CA private key', () => {
    assert.equal(Object.isFrozen(loopback), true);
    assert.deepEqual(Object.keys(loopback).sort(), ['expiresAt', 'fingerprint']);
    assert.deepEqual(Object.getOwnPropertyNames(loopback).sort(),
      ['ca', 'cert', 'expiresAt', 'fingerprint', 'key', 'publicCertificate', 'toJSON']);
    for (const name of ['cert', 'key', 'ca', 'publicCertificate']) {
      assert.equal(Buffer.isBuffer(loopback[name]), true);
      assert.equal(Object.getOwnPropertyDescriptor(loopback, name).enumerable, false);
    }
    assert.equal(JSON.stringify(loopback), '"[redacted]"');
    assert.equal(inspect(loopback).includes('PRIVATE KEY'), false);
    assert.equal(inspect(loopback).includes('<Buffer'), false);
    assert.equal(loopback.key.toString('ascii').startsWith('-----BEGIN PRIVATE KEY-----'), true);
  });

  async function serverFor(t, material) {
    const sockets = new Set();
    const server = createServer({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2',
      handshakeTimeout: 3000 }, (_, response) => { response.writeHead(200); response.end('synthetic'); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', (_, socket) => socket.destroy());
    t.after(async () => {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    });
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error('SYNTHETIC_CERTIFICATE_TEST_LISTENER_FAILED')));
      server.listen(0, '127.0.0.1', resolve);
    });
    return server;
  }
  async function fetch(server, ca) {
    return new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/', method: 'GET',
        ca, rejectUnauthorized: true, agent: false }, response => {
        const authorized = response.socket.authorized, protocol = response.socket.getProtocol();
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', () => resolve({ ok: false, code: 'RESPONSE_FAILED' }));
        response.on('end', () => resolve({ ok: true, authorized, protocol,
          status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', error => resolve({ ok: false, code: error.code }));
      req.setTimeout(5000, () => req.destroy());
      req.end();
    });
  }
  test('actual loopback HTTPS validates the root chain and IP without modifying global trust', async t => {
    const server = await serverFor(t, loopback);
    const result = await fetch(server, loopback.ca);
    assert.equal(result.ok, true);
    assert.equal(result.authorized, true);
    assert.ok(['TLSv1.2', 'TLSv1.3'].includes(result.protocol));
    assert.equal(result.status, 200);
    assert.equal(result.text, 'synthetic');
  });

  test('an unrelated root remains untrusted even for a matching loopback IP', async t => {
    const server = await serverFor(t, loopback);
    const result = await fetch(server, fictional.ca);
    assert.equal(result.ok, false);
    assert.ok(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_UNTRUSTED', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(result.code));
  });

  test('a trusted chain cannot bypass exact IP SAN validation', async t => {
    const server = await serverFor(t, fictional);
    const result = await fetch(server, fictional.ca);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  });
});
