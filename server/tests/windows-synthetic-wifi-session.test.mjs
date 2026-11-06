import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Module-local doubles replace only the four external resource factories.
// The production factory exposes no injection option. Its actual input policy,
// network validator and complete ownSyntheticSession lifecycle remain in use.
// No E path is opened and no process, engine, certificate or socket is created.
const source = new URL('../windows-synthetic-wifi-session.mjs', import.meta.url);
const postgresArgs = () => ['--base', 'E:\\SyntheticWifiUnit', '--powershell', 'C:\\SyntheticUnit\\pwsh.exe', '--confirm-synthetic-e-drive'];
const network = () => ({ host: '192.168.80.10', peerAddress: '192.168.80.20', port: 8443, confirmSynthetic: true });
const input = () => ({ postgresArgs: postgresArgs(), network: network(), cert: Buffer.alloc(128, 7), key: Buffer.alloc(128, 9) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { const value = Promise.withResolvers(); value.promise.catch(() => {}); return value; };
const invalid = error => error.message === 'WINDOWS_SYNTHETIC_WIFI_SESSION_CONFIGURATION';

async function fixture(t) {
  const log = [], apis = [], apiInputs = [], workerInputs = [], storageInputs = [], sessions = [], gates = [];
  let worker, forgotten = false;
  const seed = { get credentials() { return forgotten ? [] : [{ role: 'guardian', email: 'unit@synthetic.test', password: 'unit-only' }]; },
    forgetCredentials() { forgotten = true; log.push('credentials:forget'); } };
  const storage = { seed, mediaRoot: 'E:\\SyntheticWifiUnit\\owned-media', environment: Object.freeze({ SYNTHETIC_UNIT: '1' }),
    async initialize() { log.push('storage:initialize'); await storage.initializeGate?.promise; },
    configuration: kind => Object.freeze({ kind }),
    async closeConnections() { log.push('connections:close'); },
    async stopDatabase() { log.push('database:stop'); },
    async disposeSecrets() { log.push('secrets:dispose'); storage.disposeEntered?.resolve(); await storage.disposeGate?.promise; },
    status: () => Object.freeze({ synthetic: true }),
  };
  const media = { engine: Object.freeze({ synthetic: true }), approvedImageId: 'synthetic-image',
    bridge: { endpoint: Object.freeze({ synthetic: true }) },
    scanner: { async status() { log.push('scanner:status'); return { available: true }; } },
    async close() { log.push('media:close'); }, diagnostics: () => Object.freeze({ synthetic: true }),
  };
  function child(name, isWorker = false) {
    const exit = deferred(), unavailable = deferred(), closeEntered = deferred();
    const state = { ready: true, stopRequested: false, stopped: false, stopAccepted: false, drainReported: false,
      terminal: false, closeObserved: false, spawnFailed: false, stdioClosed: false, observationTimedOut: false,
      exitCode: null, signalCode: null, failureCode: null, eventTimeline: [], resourceObservations: [] };
    const handle = { state, exit, closeEntered, closeBehavior: null,
      status: () => ({ ...state }), waitForExit: () => exit.promise, waitForUnavailable: () => unavailable.promise,
      finish() {
        Object.assign(state, { stopRequested: true, stopped: true, terminal: true, closeObserved: true,
          stdioClosed: true, exitCode: 0, signalCode: null, stopAccepted: isWorker, drainReported: isWorker });
        exit.resolve();
      },
      close() {
        log.push(`${name}:close`); state.stopRequested = true; closeEntered.resolve();
        if (handle.closeBehavior) return handle.closeBehavior();
        handle.finish(); return Promise.resolve();
      },
      fault() { state.ready = false; state.failureCode = 'SYNTHETIC_UNIT_FAILURE'; unavailable.resolve(); },
    };
    return handle;
  }
  const controls = {
    storage(...args) { log.push('storage:allocate'); storageInputs.push(args); return storage; },
    async media({ onOwned }) { log.push('media:allocate'); onOwned(media); return media; },
    async worker(value) { log.push('worker:allocate'); workerInputs.push(value); worker = child('worker', true); value.onOwned(worker); return worker; },
    async api(value) {
      const number = apis.length + 1, result = child(`api${number}`);
      log.push(`api${number}:allocate`); apis.push(result); apiInputs.push(value); value.onOwned(result);
      await controls.apiGate?.(number, result);
      return Object.freeze({ origin: `https://${value.network.host}:${value.network.port}` });
    },
  };
  const symbol = `carebridge.synthetic-wifi-unit.${randomUUID()}`;
  globalThis[Symbol.for(symbol)] = controls;
  const replacements = new Map([
    ['windows-synthetic-storage.mjs', ['createWindowsSyntheticStorage', 'storage']],
    ['windows-native-media-test-fixture.mjs', ['createWindowsSyntheticMediaEnvironment', 'media']],
    ['windows-synthetic-worker-parent.mjs', ['launchWindowsSyntheticWorker', 'worker']],
    ['windows-native-api-test-parent.mjs', ['launchWindowsWifiApiTest', 'api']],
  ].map(([file, [name, slot]]) => [new URL(`../${file}`, import.meta.url).href,
    `data:text/javascript,${encodeURIComponent(`const control=globalThis[Symbol.for(${JSON.stringify(symbol)})]; export const ${name}=(...args)=>control.${slot}(...args);`)}`]));
  const entry = new URL(source); entry.searchParams.set('synthetic-unit', randomUUID());
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (context.parentURL === entry.href && replacements.has(resolved.url))
      return { url: replacements.get(resolved.url), shortCircuit: true };
    return resolved;
  } });
  let create;
  try { ({ createWindowsSyntheticWifiSession: create } = await import(entry.href)); }
  finally { hooks.deregister(); delete globalThis[Symbol.for(symbol)]; }
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const api of apis) api.closeBehavior = null;
    if (worker) worker.closeBehavior = null;
    controls.apiGate = null;
    for (const session of sessions) await session.close().catch(() => {});
  });
  return { log, apis, apiInputs, workerInputs, storageInputs, storage, media, controls,
    get worker() { return worker; }, create,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    start(value = input()) { const session = create(value); sessions.push(session); return session; },
  };
}

test('Wi-Fi session rejects non-data input, resume flags and unsafe network/buffer bounds synchronously', async t => {
  const f = await fixture(t);
  let invoked = false;
  const arrayGetter = postgresArgs();
  Object.defineProperty(arrayGetter, '1', { get() { invoked = true; return 'E:\\SyntheticWifiUnit'; } });
  const arrayIterator = postgresArgs();
  arrayIterator[Symbol.iterator] = () => { invoked = true; return [][Symbol.iterator](); };
  const sparse = postgresArgs(); delete sparse[1];
  const inherited = Object.assign(Object.create(input()), {});
  for (const value of [undefined, null, [], new Date(), {}, inherited, { ...input(), injectedFactory() {} },
    { ...input(), [Symbol('extra')]: true },
    ...['postgresArgs', 'network', 'cert', 'key'].map(name => Object.defineProperty(input(), name,
      { get() { invoked = true; return input()[name]; } })),
    ...[arrayGetter, arrayIterator, sparse, ['--create-resumable', ...postgresArgs()],
      ['--resume-session', randomUUID(), ...postgresArgs()], ['--base', 'C:\\WrongDrive', ...postgresArgs().slice(2)],
      [...postgresArgs().slice(0, 4)], [...postgresArgs(), '--extra']].map(args => ({ ...input(), postgresArgs: args })),
    ...[{ ...network(), host: '0.0.0.0' }, { ...network(), peerAddress: '127.0.0.1' },
      { ...network(), port: 443 }, { ...network(), confirmSynthetic: false }].map(value => ({ ...input(), network: value })),
    ...[null, 'private-text', new Uint8Array(128), Buffer.alloc(127), Buffer.alloc(65537)].map(cert => ({ ...input(), cert })),
    ...[null, 'private-text', new Uint8Array(128), Buffer.alloc(127), Buffer.alloc(16385)].map(key => ({ ...input(), key })),
  ]) assert.throws(() => f.create(value), invalid);
  assert.equal(invoked, false);
  await turn();
  assert.deepEqual(f.log, []);
});

test('factory captures input before startup and preserves existing worker/media services and public surface', async t => {
  const f = await fixture(t), value = input(), expectedNetwork = network(), session = f.start(value);
  value.postgresArgs[1] = 'E:\\Changed'; value.network.host = '10.231.9.10';
  value.cert.fill(33); value.key.fill(44); value.cert = null; value.key = null;
  await session.ready;
  assert.equal(f.storageInputs.length, 1);
  assert.deepEqual(f.storageInputs[0][0], postgresArgs());
  assert.deepEqual(f.storageInputs[0][1], { mode: 'ephemeral', sessionId: null, postgresArgs: postgresArgs() });
  assert.equal(f.workerInputs.length, 1);
  assert.deepEqual(f.workerInputs[0].database, { kind: 'worker' });
  assert.equal(f.workerInputs[0].environment, f.storage.environment);
  assert.equal(f.workerInputs[0].mediaRoot, f.storage.mediaRoot);
  assert.equal(f.workerInputs[0].nativeMedia.engineIdentity, f.media.engine);
  assert.equal(f.workerInputs[0].nativeMedia.approvedImageId, f.media.approvedImageId);
  assert.equal(f.workerInputs[0].nativeMedia.scannerEndpoint, f.media.bridge.endpoint);
  const api = f.apiInputs[0];
  assert.deepEqual(Object.keys(api).sort(), ['cert', 'database', 'environment', 'key', 'mediaRoot', 'network', 'onOwned', 'screen']);
  assert.deepEqual(api.database, { kind: 'runtime' });
  assert.equal(api.screen, 'prepared'); assert.deepEqual(api.network, expectedNetwork);
  assert.equal(Object.isFrozen(api.network), true);
  assert.ok(api.cert.every(byte => byte === 7)); assert.ok(api.key.every(byte => byte === 9));
  assert.equal(api.environment, f.storage.environment); assert.equal(api.mediaRoot, f.storage.mediaRoot);
  assert.equal(session.origin, 'https://192.168.80.10:8443');
  assert.equal(Object.isFrozen(session), true);
  assert.equal(session.credentials.length, 1);
  assert.equal(JSON.stringify(session).includes('unit-only'), false);
  assert.equal(Object.hasOwn(session, 'key'), false); assert.equal(Object.hasOwn(session, 'cert'), false);
});

test('API-only restart retains session-owned material and clears it only after complete session shutdown', async t => {
  const f = await fixture(t), value = input(), session = f.start(value);
  await session.ready;
  const first = f.apiInputs[0];
  assert.notEqual(first.cert, value.cert); assert.notEqual(first.key, value.key);
  const restarted = await session.restartApi();
  assert.equal(restarted.apiGeneration, 2);
  assert.equal(f.apiInputs.length, 2);
  assert.equal(f.apiInputs[1].cert, first.cert); assert.equal(f.apiInputs[1].key, first.key);
  assert.ok(first.cert.every(byte => byte === 7)); assert.ok(first.key.every(byte => byte === 9));
  assert.equal(f.storageInputs.length, 1); assert.equal(f.workerInputs.length, 1);
  assert.equal(f.log.filter(value => value === 'media:allocate').length, 1);
  assert.equal(f.log.includes('database:stop'), false);
  const closed = await session.close();
  assert.deepEqual(closed, { stopped: true, failed: false });
  assert.deepEqual(await session.waitForStop(), closed);
  assert.ok(first.cert.every(byte => byte === 0)); assert.ok(first.key.every(byte => byte === 0));
  assert.ok(value.cert.every(byte => byte === 7)); assert.ok(value.key.every(byte => byte === 9));
  assert.ok(f.log.indexOf('api2:close') < f.log.indexOf('worker:close'));
  assert.ok(f.log.indexOf('worker:close') < f.log.indexOf('connections:close'));
  assert.ok(f.log.indexOf('connections:close') < f.log.indexOf('database:stop'));
  assert.ok(f.log.indexOf('database:stop') < f.log.indexOf('media:close'));
  assert.ok(f.log.indexOf('media:close') < f.log.indexOf('secrets:dispose'));
});

test('unconfirmed child shutdown retains material until the same child later reaches terminal cleanup', async t => {
  const f = await fixture(t), session = f.start(); await session.ready;
  const { cert, key } = f.apiInputs[0], api = f.apis[0];
  api.closeBehavior = async () => { throw new Error('SYNTHETIC_UNIT_STOP_UNCONFIRMED'); };
  await assert.rejects(session.close());
  assert.equal(session.status().phase, 'stop-unconfirmed');
  assert.equal(api.status().terminal, false);
  assert.ok(cert.every(byte => byte === 7)); assert.ok(key.every(byte => byte === 9));
  assert.equal(f.log.includes('database:stop'), false);
  api.closeBehavior = null;
  assert.deepEqual(await session.close(), { stopped: true, failed: true });
  assert.ok(cert.every(byte => byte === 0)); assert.ok(key.every(byte => byte === 0));
});

test('terminal API alone does not clear material before worker/database/media/secret disposal finishes', async t => {
  const f = await fixture(t), session = f.start(); await session.ready;
  const { key } = f.apiInputs[0];
  f.storage.disposeGate = f.gate(); f.storage.disposeEntered = f.gate();
  const closing = session.close();
  await f.storage.disposeEntered.promise;
  assert.equal(f.apis[0].status().terminal, true); assert.equal(f.worker.status().terminal, true);
  assert.equal(session.status().phase, 'stopping');
  assert.ok(key.every(byte => byte === 9));
  f.storage.disposeGate.resolve();
  await closing;
  assert.equal(session.status().phase, 'stopped');
  assert.ok(key.every(byte => byte === 0));
});

test('unplanned API failure uses existing whole-session cleanup and zeroizes owned material', async t => {
  const f = await fixture(t), session = f.start(); await session.ready;
  const { key } = f.apiInputs[0];
  f.apis[0].fault();
  assert.deepEqual(await session.waitForStop(), { stopped: true, failed: true });
  assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
  assert.ok(key.every(byte => byte === 0));
  assert.equal(f.log.filter(value => value === 'database:stop').length, 1);
});

test('close during replacement admission drains the registered replacement before clearing shared material', async t => {
  const f = await fixture(t), session = f.start(); await session.ready;
  const entered = f.gate(), release = f.gate(), drained = f.gate();
  f.controls.apiGate = async (number, api) => {
    if (number !== 2) return;
    api.closeBehavior = async () => { await drained.promise; api.finish(); };
    entered.resolve(); await release.promise;
  };
  const restart = session.restartApi(), rejected = assert.rejects(restart);
  await entered.promise;
  const { key } = f.apiInputs[1];
  const closing = session.close(); release.resolve();
  await rejected; await turn();
  assert.equal(f.apis[1].status().terminal, false);
  assert.ok(key.every(byte => byte === 9));
  assert.equal(f.log.includes('database:stop'), false);
  drained.resolve(); await closing;
  assert.equal(f.apis[1].status().terminal, true);
  assert.ok(key.every(byte => byte === 0));
});
