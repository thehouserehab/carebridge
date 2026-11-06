import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess, { ChildProcess, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { syntheticWifiNetwork, wifiOrigin } from '../synthetic-wifi-network.mjs';
import { windowsNativeApiBootstrap, windowsWifiApiBootstrap, nativeApiOrigin,
  nativeApiControlMessage, parseNativeApiControlMessage } from '../windows-native-api-test-policy.mjs';
import { runWindowsNativeApiTestChild } from '../windows-native-api-test-control.mjs';
import { observeWindowsNativeApiTestChild, launchWindowsNativeApiTest,
  launchWindowsWifiApiTest } from '../windows-native-api-test-parent.mjs';
import { encodePrivateSecretFrame, decodePrivateSecretFrame } from '../windows-private-secret-io.mjs';
import { readWifiTlsBootstrap } from '../windows-wifi-api-child.mjs';

// Fictional values only. These tests create no listener, DB, E file, firewall
// rule, certificate trust, or real-network request.
const network = () => ({ host: '192.168.80.10', peerAddress: '192.168.80.20', port: 8443, confirmSynthetic: true });
const origin = 'https://192.168.80.10:8443';
const unavailable = { message: 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function bootstrap() {
  const run = randomUUID();
  return { purpose: 'synthetic-carebridge-wifi-api', database: {
    storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run }, credentialId: randomUUID(),
    privileges: { roles: { owner: 'cb_owner', runtime: 'cb_runtime', bootstrap: 'cb_bootstrap', backup: 'cb_backup', worker: 'cb_worker' },
      target: { name: 'cb_synthetic', oid: 16384, ownerOid: 16385, confirm: 'cb_synthetic' } },
    endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] } },
  mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media`, network: network() };
}
function tlsFrame(instanceId, extra = {}) {
  return encodePrivateSecretFrame({ purpose: 'synthetic-wifi-tls-v1', instanceId,
    cert: Buffer.from('fixture-cert').toString('base64'), key: Buffer.from('fixture-key').toString('base64'), ...extra });
}
class Target extends EventEmitter {
  connected = true; channel = {}; frames = [];
  send(value, callback) { this.frames.push(value); queueMicrotask(() => callback(null)); }
  disconnect() { this.connected = false; this.channel = null; this.emit('disconnect'); }
}
function controller(createService, wifi = true) {
  const target = new Target(), instanceId = randomUUID();
  const done = runWindowsNativeApiTestChild({ instanceId, targetProcess: target, createService, wifi });
  done.catch(() => {});
  return { target, instanceId, done, stop: () => target.emit('message', nativeApiControlMessage(instanceId, 'stop')) };
}

test('Wi-Fi network accepts only a frozen explicit private IPv4 single-peer snapshot', () => {
  const input = network(), parsed = syntheticWifiNetwork(input);
  input.host = '10.8.0.1'; assert.equal(parsed.host, '192.168.80.10'); assert(Object.isFrozen(parsed));
  for (const host of ['10.8.0.1', '172.16.0.1', '172.31.255.254', '192.168.80.10'])
    assert.equal(syntheticWifiNetwork({ ...network(), host }).host, host);
  assert.deepEqual(syntheticWifiNetwork(Object.assign(Object.create(null), network())), network());
  for (const value of [null, [], new (class Network { constructor() { Object.assign(this, network()); } })(),
    Object.assign(new Date(), network()), Object.assign(Object.create({ inherited: true }), network()),
    { ...network(), extra: true }, { ...network(), [Symbol('extra')]: true }, { ...network(), port: '8443' },
    { ...network(), port: 443 }, { ...network(), confirmSynthetic: false }, { ...network(), peerAddress: network().host },
    ...['0.0.0.0', '127.0.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.168.080.10', '::1', 'localhost'].map(host => ({ ...network(), host }))])
    assert.throws(() => syntheticWifiNetwork(value), { message: 'SYNTHETIC_WIFI_NETWORK_UNAVAILABLE' });
  let reads = 0; const accessor = { ...network(), get host() { reads++; return '192.168.80.10'; } };
  assert.throws(() => syntheticWifiNetwork(accessor)); assert.equal(reads, 0);
});

test('HTTPS origin and control are opt-in, exact, and cannot weaken the HTTP default', () => {
  const instanceId = randomUUID();
  assert.equal(wifiOrigin(origin, network()), origin); assert.equal(nativeApiOrigin(origin, network()), origin);
  assert.throws(() => nativeApiOrigin(origin), unavailable);
  assert.equal(nativeApiOrigin('http://127.0.0.1:4180'), 'http://127.0.0.1:4180');
  for (const value of ['http://192.168.80.10:8443', 'https://192.168.80.20:8443', 'https://192.168.80.10', `${origin}/`,
    `${origin}?x=1`, 'https://localhost:8443', 'http://127.0.0.1:4180']) assert.throws(() => nativeApiOrigin(value, network()), unavailable);
  const ready = nativeApiControlMessage(instanceId, 'ready', origin, network());
  assert.deepEqual(parseNativeApiControlMessage(ready, instanceId, 'child', undefined, network()), ready);
  assert.throws(() => parseNativeApiControlMessage(ready, instanceId, 'child'), unavailable);
  assert.throws(() => parseNativeApiControlMessage(ready, randomUUID(), 'child', undefined, network()), unavailable);
  assert.throws(() => parseNativeApiControlMessage({ ...ready, key: 'not permitted' }, instanceId, 'child', undefined, network()), unavailable);
  assert.throws(() => parseNativeApiControlMessage(ready, instanceId, 'child', {}, network()), unavailable);
});

test('Wi-Fi bootstrap reuses existing DB/media validation without admitting Wi-Fi to HTTP', async () => {
  const input = bootstrap(), parsed = windowsWifiApiBootstrap(input);
  assert.equal(parsed.screen, 'api-only'); assert(Object.isFrozen(parsed.network));
  input.network.host = '10.8.0.1'; assert.equal(parsed.network.host, network().host);
  assert.throws(() => windowsNativeApiBootstrap(bootstrap()), unavailable);
  for (const extra of [{ cert: 'not IPC' }, { key: 'not IPC' }, { screen: 'quarantine' }, { mediaRoot: 'E:\\elsewhere' },
    { purpose: 'synthetic-carebridge-native-api' }, { network: undefined }])
    assert.throws(() => windowsWifiApiBootstrap({ ...bootstrap(), ...extra }), unavailable);
  let reads = 0;
  assert.throws(() => windowsWifiApiBootstrap({ ...bootstrap(), get network() { reads++; return network(); } }), unavailable);
  assert.equal(reads, 0);
  const launch = { ...bootstrap(), environment: { SYSTEMROOT: 'C:\\Windows' } }; delete launch.purpose;
  await assert.rejects(launchWindowsNativeApiTest(launch), unavailable);
  await assert.rejects(launchWindowsWifiApiTest(launch), unavailable);
  await assert.rejects(launchWindowsWifiApiTest({ ...launch, cert: Buffer.alloc(17000), key: Buffer.from('key') }), unavailable);
});

test('Wi-Fi child captures network, emits only exact readiness and waits for owned close', async () => {
  const closing = Promise.withResolvers(); let received, closes = 0;
  const f = controller(async (input) => { received = input; return { origin, close: () => { closes++; return closing.promise; } }; });
  const input = bootstrap(); f.target.emit('message', input); input.network.host = '10.8.0.1'; await tick();
  assert.deepEqual(Object.keys(received).sort(), ['database', 'mediaRoot', 'network', 'screen']);
  assert.deepEqual(received.network, network()); assert(Object.isFrozen(received.network));
  assert.deepEqual(f.target.frames, [nativeApiControlMessage(f.instanceId, 'ready', origin, network())]);
  f.stop(); f.stop(); await tick(); assert.equal(closes, 1); assert(f.target.connected);
  closing.resolve(); assert.deepEqual(await f.done, { stopped: true }); assert.equal(f.target.connected, false);
  assert.deepEqual(f.target.frames.map(value => value.kind), ['ready', 'stopped']);
});

test('wrong HTTP/Wi-Fi bootstrap and late/wrong origins fail closed without leaking inputs', async () => {
  let calls = 0;
  const old = controller(async () => { calls++; }, false); old.target.emit('message', bootstrap());
  await assert.rejects(old.done, unavailable); assert.equal(calls, 0);
  for (const wrong of ['http://127.0.0.1:4180', 'https://192.168.80.20:8443']) {
    let closes = 0;
    const f = controller(async () => ({ origin: wrong, close: async () => { closes++; } }));
    f.target.emit('message', bootstrap()); await assert.rejects(f.done, unavailable);
    assert.equal(closes, 1); assert.deepEqual(f.target.frames.map(value => value.kind), ['failed']);
  }
  const opening = Promise.withResolvers(); let closed = false;
  const late = controller(() => opening.promise); late.target.emit('message', bootstrap()); late.stop();
  opening.resolve({ origin, close: async () => { closed = true; } }); await late.done;
  assert(closed); assert.deepEqual(late.target.frames.map(value => value.kind), ['stopped']);
});

test('private frame requires EOF, survives chunking, binds instance and clears consumed buffers', async () => {
  const instanceId = randomUUID(), pipe = new PassThrough();
  const pending = readWifiTlsBootstrap(pipe, instanceId); let settled = false;
  pending.then(() => { settled = true; });
  const frame = tlsFrame(instanceId), one = Buffer.from(frame.subarray(0, 2)), two = Buffer.from(frame.subarray(2));
  pipe.write(one); pipe.write(two); await tick(); assert.equal(settled, false);
  pipe.end(); const secret = await pending;
  assert.equal(secret.cert.toString(), 'fixture-cert'); assert.equal(secret.key.toString(), 'fixture-key');
  assert(one.every(value => value === 0)); assert(two.every(value => value === 0));
  secret.cert.fill(0); secret.key.fill(0); frame.fill(0);
});

test('private frame rejects wrong instance/purpose, secrets on IPC, malformed and extra bytes', async () => {
  const instanceId = randomUUID();
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(16385);
  const frames = [Buffer.alloc(0), oversized, Buffer.from([0, 0, 0, 5, 123]), tlsFrame(randomUUID()),
    tlsFrame(instanceId, { purpose: 'wrong' }), tlsFrame(instanceId, { extra: true }), tlsFrame(instanceId, { cert: '' }),
    tlsFrame(instanceId, { key: 'YR==' }), tlsFrame(instanceId, { key: 'a===' }),
    Buffer.concat([tlsFrame(instanceId), Buffer.from('trailing')]), tlsFrame(instanceId).subarray(0, 10)];
  for (const frame of frames) {
    const pipe = new PassThrough(), pending = readWifiTlsBootstrap(pipe, instanceId);
    pipe.end(frame); await assert.rejects(pending, unavailable); assert(pipe.destroyed);
  }
  const pipe = new PassThrough(), pending = readWifiTlsBootstrap(pipe, instanceId); pipe.destroy();
  await assert.rejects(pending, unavailable);
  let calls = 0; const f = controller(async () => { calls++; });
  f.target.emit('message', { ...bootstrap(), key: 'never IPC' }); await assert.rejects(f.done, unavailable);
  assert.equal(calls, 0); assert.equal(JSON.stringify(f.target.frames).includes('never IPC'), false);
});

test('private frame has a fixed five-second deadline even after a complete frame without EOF', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instanceId = randomUUID(), pipe = new PassThrough(), pending = readWifiTlsBootstrap(pipe, instanceId);
  pipe.write(tlsFrame(instanceId)); t.mock.timers.tick(5000);
  await assert.rejects(pending, unavailable); assert(pipe.destroyed);
});

test('parent snapshots network and cannot call termination successful before private stdin closes', async () => {
  const child = new ChildProcess(), instanceId = randomUUID(), input = network();
  child.pid = 12345; child.connected = true; child.channel = {};
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, null];
  child.send = (_value, callback) => queueMicrotask(() => callback(null));
  const control = observeWindowsNativeApiTestChild(child, { instanceId, network: input }); input.host = '10.8.0.1';
  child.emit('message', nativeApiControlMessage(instanceId, 'ready', origin, network())); assert.equal(await control.ready, origin);
  const closing = control.close(); let settled = false; closing.then(() => { settled = true; });
  child.emit('message', nativeApiControlMessage(instanceId, 'stopped'));
  child.connected = false; child.channel = null; child.emit('disconnect'); child.emit('exit', 0, null);
  child.stdout.destroy(); child.stderr.destroy(); child.emit('close', 0, null); await tick();
  assert.equal(settled, false); assert.equal(control.status().stdioClosed, false);
  child.stdin.destroy(); assert.deepEqual(await closing, { exited: true, exitCode: 0, stopped: true });
  assert.equal(control.status().stdioClosed, true); assert.equal(JSON.stringify(control.status()).includes('fixture-key'), false);
});

test('actual isolated child receives secrets on inherited stdin, not IPC, argv, environment or output', { timeout: 10000 }, async () => {
  const instanceId = randomUUID();
  const code = `
    import { readWifiTlsBootstrap } from ${JSON.stringify(new URL('../windows-wifi-api-child.mjs', import.meta.url).href)};
    import { runWindowsNativeApiTestChild } from ${JSON.stringify(new URL('../windows-native-api-test-control.mjs', import.meta.url).href)};
    const secret = readWifiTlsBootstrap(process.stdin, process.argv[1]); secret.catch(() => {});
    try {
      await runWindowsNativeApiTestChild({ instanceId: process.argv[1], wifi: true, createService: async input => {
        const bytes = await secret;
        try {
          if (bytes.cert.toString() !== 'fixture-cert' || bytes.key.toString() !== 'fixture-key') throw new Error();
          if ('cert' in input || 'key' in input ||
            [...Object.values(process.env), ...process.argv].some(value => value.includes('fixture-key'))) throw new Error();
          return { origin: 'https://' + input.network.host + ':8443', close: async () => {} };
        } finally { bytes.cert.fill(0); bytes.key.fill(0); }
      }});
    } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
    finally { process.stdin.destroy(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, instanceId], {
    env: {}, shell: false, windowsHide: true, serialization: 'json', stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const control = observeWindowsNativeApiTestChild(child, { instanceId, network: network(), observationMilliseconds: 5000 });
  await new Promise((resolve, reject) => child.send(bootstrap(), error => error ? reject(error) : resolve()));
  const frame = tlsFrame(instanceId);
  await new Promise((resolve, reject) => child.stdin.end(frame, error => { frame.fill(0); error ? reject(error) : resolve(); }));
  assert.equal(await control.ready, origin);
  assert.deepEqual(await control.close(), { exited: true, exitCode: 0, stopped: true });
  assert.equal(control.status().stdioClosed, true); assert.equal(control.status().failureCode, null);
  assert.equal(JSON.stringify(control.status()).includes('fixture-key'), false);
});

function mockLauncherSpawn(t, mode = 'success') {
  const records = [];
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const child = new ChildProcess(), record = { executable, args, options, child, messages: [], frames: [], buffers: [] };
    records.push(record); child.pid = 12345; child.connected = true; child.channel = {};
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _encoding, callback) {
      record.buffers.push(bytes); record.frames.push(decodePrivateSecretFrame(bytes));
      callback(mode === 'pipe-error' ? new Error('synthetic private pipe failure') : undefined);
    } });
    child.stdio = [child.stdin, child.stdout, child.stderr, null];
    child.stdin.on('finish', () => {
      if (mode === 'success') queueMicrotask(() => child.emit('message', nativeApiControlMessage(args[1], 'ready', origin, network())));
    });
    child.send = (value, callback) => {
      record.messages.push(structuredClone(value));
      if (value.kind === 'stop') {
        queueMicrotask(() => {
          callback(null); child.emit('message', nativeApiControlMessage(args[1], 'stopped'));
          child.connected = false; child.channel = null; child.emit('disconnect'); child.exitCode = 0; child.emit('exit', 0, null);
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          setImmediate(() => child.emit('close', 0, null));
        });
      } else queueMicrotask(() => callback(mode === 'bootstrap-error' ? new Error('synthetic private bootstrap failure') : null));
      return false;
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return records;
}
function launchInput() {
  const value = bootstrap(); delete value.purpose;
  return { ...value, environment: { SYSTEMROOT: 'C:\\Windows', NODE_OPTIONS: '--should-not-propagate', PRIVATE: 'not propagated' },
    cert: Buffer.from('fixture-cert'), key: Buffer.from('fixture-key') };
}

test('Wi-Fi launcher owns before bootstrap, captures TLS, clears sent copies and restarts with new frame binding',
  { skip: process.platform !== 'win32' }, async (t) => {
    const records = mockLauncherSpawn(t), inputs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const input = launchInput(); inputs.push(input); let owned;
      input.onOwned = lifetime => {
        owned = lifetime; assert.equal(records.at(-1).messages.length, 0); assert.equal(records.at(-1).frames.length, 0);
        input.network.host = '10.8.0.1'; input.cert.fill(0); input.key.fill(0);
      };
      const service = await launchWindowsWifiApiTest(input), record = records.at(-1);
      assert.equal(service.origin, origin); assert.equal(service.close, owned.close);
      assert.equal(record.args.length, 2); assert.match(record.args[0], /windows-wifi-api-child\.mjs$/);
      assert.equal(record.options.env.CAREBRIDGE_NATIVE_WIFI_API_CHILD, 'synthetic-only');
      assert.equal(record.options.env.NODE_OPTIONS, undefined); assert.equal(record.options.env.PRIVATE, undefined);
      assert.deepEqual(record.options.stdio, ['pipe', 'pipe', 'pipe', 'ipc']); assert.equal(record.options.windowsHide, true);
      assert.equal(record.options.shell, false); assert.equal(record.options.detached, false);
      assert.equal(record.frames.length, 1); assert.equal(record.frames[0].instanceId, record.args[1]);
      assert.equal(Buffer.from(record.frames[0].cert, 'base64').toString(), 'fixture-cert');
      assert.equal(Buffer.from(record.frames[0].key, 'base64').toString(), 'fixture-key');
      assert(record.buffers.every(value => value.every(byte => byte === 0)));
      assert.deepEqual(record.messages[0].network, network());
      assert.equal(JSON.stringify([record.messages, record.args, record.options.env, service.status()]).includes('fixture-key'), false);
      assert.equal(JSON.stringify(record.messages).includes(record.frames[0].key), false);
      assert.deepEqual(await service.close(), { exited: true, exitCode: 0, stopped: true });
    }
    assert.notEqual(records[0].args[1], records[1].args[1]);
  });

for (const mode of ['owner-error', 'bootstrap-error', 'pipe-error']) test(`Wi-Fi launcher ${mode} waits for owned termination and never spills secrets`,
  { skip: process.platform !== 'win32' }, async (t) => {
    const records = mockLauncherSpawn(t, mode), input = launchInput(); let owned;
    input.onOwned = lifetime => { owned = lifetime; if (mode === 'owner-error') throw new Error('synthetic private owner failure'); };
    await assert.rejects(launchWindowsWifiApiTest(input), unavailable);
    assert.equal(owned.status().terminal, true); assert.equal(owned.status().stdioClosed, true);
    assert.equal(owned.status().failureCode, unavailable.message);
    assert.equal(records[0].frames.length, mode === 'pipe-error' ? 1 : 0);
    assert(records[0].buffers.every(value => value.every(byte => byte === 0)));
    assert.equal(input.cert.toString(), 'fixture-cert'); assert.equal(input.key.toString(), 'fixture-key');
    assert.equal(JSON.stringify([records[0].messages, owned.status()]).includes('fixture-key'), false);
  });
