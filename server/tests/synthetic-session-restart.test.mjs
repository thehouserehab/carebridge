// Deterministic lifetime doubles only: no process, socket, E storage or real
// credential is created. Actual native exit evidence is covered separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownSyntheticSession } from '../synthetic-session-lifetime.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { const value = Promise.withResolvers(); value.promise.catch(() => {}); return value; };
const options = { timeout: 3000 };
function fixture(t) {
  const log = [], apis = [], apiStorage = [], gates = [], launches = new Map();
  let forgotten = 0, worker, session;
  const seed = { get credentials() { return forgotten ? [] : [{ role: 'therapist', email: 'restart@example.test', password: 'synthetic-test-only' }]; },
    forgetCredentials() { forgotten++; log.push('credentials:forget'); } };
  function child(name) {
    const exit = deferred(), unavailable = deferred(), closeEntered = deferred();
    const state = { ready: true, stopRequested: false, stopped: false, terminal: false, closeObserved: false, spawnFailed: false,
      stdioClosed: false, observationTimedOut: false, exitCode: null, signalCode: null, failureCode: null,
      eventTimeline: [{ event: 'ipc-ready', elapsedMs: 1 }], resourceObservations: [] };
    const handle = { state, exit, unavailable, closeEntered, closeBehavior: null, closeCalls: 0,
      status: () => ({ ...state }), waitForExit: () => exit.promise, waitForUnavailable: () => unavailable.promise,
      finish() {
        Object.assign(state, { stopRequested: true, stopped: true, terminal: true, closeObserved: true, stdioClosed: true,
          observationTimedOut: false, exitCode: 0, signalCode: null, failureCode: null });
        exit.resolve();
      },
      close() {
        handle.closeCalls++; log.push(`${name}:close`); state.stopRequested = true; closeEntered.resolve();
        if (handle.closeBehavior) return handle.closeBehavior();
        handle.finish(); return Promise.resolve();
      },
      fault() { state.failureCode = 'SYNTHETIC_CHILD_FAILED'; state.ready = false; unavailable.resolve(); },
    };
    return handle;
  }
  const storage = { seed, initialize: async () => { log.push('storage:initialize'); },
    closeConnections: async () => { log.push('connections:close'); }, stopDatabase: async () => { log.push('database:stop'); },
    disposeSecrets: async () => { log.push('secrets:dispose'); }, status: () => ({ runId: 'synthetic-unit-only' }) };
  const plan = {
    storage: () => { log.push('storage:allocate'); return storage; },
    media: async ({ onOwned }) => {
      log.push('media:allocate');
      const media = { scanner: { status: async () => { log.push('scanner:status'); return { available: true }; } },
        close: async () => { log.push('media:close'); } };
      onOwned(media); return media;
    },
    worker: async ({ onOwned }) => { log.push('worker:allocate'); worker = child('worker'); onOwned(worker); return worker; },
    api: async ({ storage: value, onOwned }) => {
      const generation = apis.length + 1, api = child(`api${generation}`);
      apis.push(api); apiStorage.push(value); log.push(`api${generation}:allocate`);
      onOwned(api); await launches.get(generation)?.(api);
      return { origin: `http://127.0.0.1:${4100 + generation}`, ...api };
    },
  };
  t.after(async () => {
    // Release only these deterministic doubles if an assertion fails. This is
    // not a real-child termination shortcut and cannot delete outside state.
    for (const gate of gates) gate.resolve();
    for (const api of apis) api.closeBehavior = null;
    if (worker) worker.closeBehavior = null;
    await session?.close().catch(() => {});
  });
  return { log, apis, apiStorage, storage, seed, plan, launches,
    get worker() { return worker; }, get forgotten() { return forgotten; },
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    start() { session = ownSyntheticSession(plan); return session; } };
}
function unchangedCore(f) {
  for (const event of ['storage:allocate', 'storage:initialize', 'media:allocate', 'scanner:status', 'worker:allocate'])
    assert.equal(f.log.filter(value => value === event).length, 1, event);
  for (const event of ['connections:close', 'database:stop', 'media:close', 'secrets:dispose']) assert(!f.log.includes(event), event);
}

test('API restart hides projections until terminal old API and replacement admission; concurrent requests share one promise', options, async t => {
  const f = fixture(t), session = f.start();
  assert.deepEqual(await session.ready, { origin: 'http://127.0.0.1:4101' });
  assert.equal(session.status().apiGeneration, 1); assert.equal(session.credentials.length, 1);
  const old = f.apis[0], oldGate = f.gate(), newGate = f.gate(), entered = f.gate();
  old.closeBehavior = async () => { await oldGate.promise; old.finish(); };
  f.launches.set(2, async () => { entered.resolve(); await newGate.promise; });
  const first = session.restartApi(), second = session.restartApi();
  assert.equal(first, second); await old.closeEntered.promise;
  assert.equal(session.status().phase, 'restarting-api'); assert.equal(session.status().ready, false);
  assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
  assert.equal(f.apis.length, 1); unchangedCore(f); assert.equal(f.forgotten, 0);
  oldGate.resolve(); await entered.promise;
  assert.equal(session.status().ready, false); assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
  assert.equal(session.status().apiGeneration, 2); unchangedCore(f);
  newGate.resolve(); assert.deepEqual(await first, { origin: 'http://127.0.0.1:4102', apiGeneration: 2 });
  assert.equal(session.status().ready, true); assert.equal(session.origin, 'http://127.0.0.1:4102');
  assert.equal(session.credentials.length, 1); assert.equal(f.forgotten, 0);
  assert.deepEqual(f.apiStorage, [f.storage, f.storage]); unchangedCore(f);
  const history = session.status().apiRestarts;
  assert.equal(history.length, 1); assert.equal(history[0].generation, 1);
  assert.equal(history[0].status.terminal, true); assert.equal(history[0].status.exitCode, 0);
  old.state.eventTimeline[0].elapsedMs = 999;
  assert.equal(session.status().apiRestarts[0].status.eventTimeline[0].elapsedMs, 1, 'history must not alias child diagnostics');
  old.unavailable.resolve(); await turn();
  assert.equal(session.status().ready, true); assert.equal(session.status().failed, false);
  const closed = await session.close(); assert.deepEqual(closed, { stopped: true, failed: false });
  assert(f.log.indexOf('api2:close') < f.log.indexOf('worker:close'));
  assert(f.log.indexOf('worker:close') < f.log.indexOf('connections:close'));
  assert(f.log.indexOf('connections:close') < f.log.indexOf('database:stop'));
  assert(f.log.indexOf('database:stop') < f.log.indexOf('media:close'));
  assert(f.log.indexOf('media:close') < f.log.indexOf('secrets:dispose'));
});

test('restart refuses input arguments and non-ready phases without damaging a healthy session', options, async t => {
  const f = fixture(t), initialize = f.gate(); f.storage.initialize = () => initialize.promise;
  const session = f.start();
  await assert.rejects(Promise.resolve().then(() => session.restartApi()));
  initialize.resolve(); await session.ready;
  for (const value of [undefined, {}, 0, 'http://outside.invalid'])
    await assert.rejects(Promise.resolve().then(() => session.restartApi(value)));
  assert.equal(session.status().ready, true); assert.equal(f.apis.length, 1); assert.equal(session.status().failed, false);
  await session.close(); await assert.rejects(Promise.resolve().then(() => session.restartApi()));
});

test('API restart has an explicit ten-retirement limit and leaves the eleventh healthy API running', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  for (let index = 1; index <= 10; index++) {
    assert.equal((await session.restartApi()).apiGeneration, index + 1);
    assert.equal(session.status().apiRestarts.length, index);
  }
  await assert.rejects(Promise.resolve().then(() => session.restartApi()));
  assert.equal(f.apis.length, 11); assert.equal(f.apis.at(-1).closeCalls, 0);
  assert.equal(session.status().ready, true); assert.equal(session.status().failed, false); unchangedCore(f);
  assert.deepEqual(session.status().apiRestarts.map(value => value.generation), Array.from({ length: 10 }, (_, index) => index + 1));
});

for (const [field, value] of [['terminal', false], ['stopped', false], ['closeObserved', false], ['stdioClosed', false],
  ['exitCode', 1], ['signalCode', 'SIGTERM'], ['failureCode', 'SYNTHETIC_CHILD_FAILED'], ['observationTimedOut', true], ['spawnFailed', true]]) {
  test(`replacement is never spawned without clean retired API proof: ${field}`, options, async t => {
    const f = fixture(t), session = f.start(); await session.ready;
    const old = f.apis[0];
    old.closeBehavior = async () => { old.finish(); old.state[field] = value; };
    await assert.rejects(session.restartApi()); await turn();
    assert.equal(f.apis.length, 1); assert.equal(session.status().failed, true);
    assert.equal(session.status().apiRestarts.length, 0);
    assert.equal(session.status().ready, false); assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
  });
}

test('unconfirmed old API close preserves database and secrets until the same handle is rechecked', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const old = f.apis[0]; old.closeBehavior = async () => { throw Error('synthetic stop incomplete'); };
  await assert.rejects(session.restartApi()); await turn();
  assert.equal(session.status().phase, 'stop-unconfirmed'); assert.equal(f.apis.length, 1);
  assert.equal(session.status().api.terminal, false); assert.equal(session.status().apiRestarts.length, 0);
  unchangedCore(f); const previousCalls = old.closeCalls;
  old.closeBehavior = null;
  assert.deepEqual(await session.close(), { stopped: true, failed: true });
  assert(old.closeCalls > previousCalls); assert.equal(f.apis.length, 1);
  assert.equal(session.status().phase, 'stopped'); assert(f.log.includes('database:stop')); assert(f.log.includes('secrets:dispose'));
});

test('a rejected old close never authorizes replacement even if its terminal status is clean', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const old = f.apis[0]; old.closeBehavior = async () => { old.finish(); throw Error('synthetic close rejected'); };
  await assert.rejects(session.restartApi());
  assert.deepEqual(await session.waitForStop(), { stopped: true, failed: true });
  assert.equal(f.apis.length, 1); assert.equal(session.status().apiRestarts.length, 0);
});

test('user close during old API retirement cancels restart without counting a user stop as failure', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const old = f.apis[0], gate = f.gate(); old.closeBehavior = async () => { await gate.promise; old.finish(); };
  const restart = session.restartApi(), rejected = assert.rejects(restart); await old.closeEntered.promise;
  const close = session.close(); assert.equal(session.status().ready, false);
  gate.resolve(); await rejected;
  assert.deepEqual(await close, { stopped: true, failed: false }); assert.equal(f.apis.length, 1);
});

test('user close during replacement admission owns and closes the newly registered API without restoring projections', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const entered = f.gate(), gate = f.gate(); f.launches.set(2, async () => { entered.resolve(); await gate.promise; });
  const restart = session.restartApi(), rejected = assert.rejects(restart); await entered.promise;
  const close = session.close(); gate.resolve(); await rejected;
  assert.deepEqual(await close, { stopped: true, failed: false }); assert.equal(f.apis.length, 2);
  assert(f.apis[1].closeCalls > 0); assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
});

test('replacement registered after user close is still owned and drains before database and key cleanup', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const original = f.plan.api, entered = f.gate(), register = f.gate(), registered = f.gate(), drained = f.gate();
  f.plan.api = async input => {
    entered.resolve(); await register.promise;
    return original({ ...input, onOwned(child) {
      child.closeBehavior = async () => { await drained.promise; child.finish(); };
      input.onOwned(child); registered.resolve();
    } });
  };
  const restart = session.restartApi(), rejected = assert.rejects(restart); await entered.promise;
  const close = session.close(); await turn();
  assert.equal(f.apis.length, 1); assert.equal(session.status().ready, false); assert.equal(session.origin, undefined);
  assert(!f.log.includes('database:stop')); assert(!f.log.includes('secrets:dispose'));
  register.resolve(); await registered.promise; await rejected; await turn();
  assert.equal(f.apis.length, 2); assert(f.apis[1].closeCalls > 0);
  assert.equal(f.apis[1].state.terminal, false); assert.equal(session.status().failed, false);
  assert.equal(session.origin, undefined); assert.deepEqual(session.credentials, []);
  assert(!f.log.includes('connections:close')); assert(!f.log.includes('database:stop')); assert(!f.log.includes('secrets:dispose'));
  drained.resolve(); assert.deepEqual(await close, { stopped: true, failed: false });
  assert.equal(f.apis[1].state.terminal, true); assert(f.log.includes('database:stop')); assert(f.log.includes('secrets:dispose'));
  assert.equal(session.origin, undefined); assert.equal(session.status().apiGeneration, 2);
});

test('worker loss during replacement admission cannot be mistaken for planned API retirement', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  const entered = f.gate(), gate = f.gate(); f.launches.set(2, async () => { entered.resolve(); await gate.promise; });
  const restart = session.restartApi(), rejected = assert.rejects(restart); await entered.promise;
  f.worker.fault(); await turn(); assert.equal(session.status().ready, false);
  gate.resolve(); await rejected;
  assert.deepEqual(await session.waitForStop(), { stopped: true, failed: true });
  assert(f.apis[1].closeCalls > 0); assert.equal(session.origin, undefined);
  assert.equal(f.log.filter(value => value === 'worker:allocate').length, 1);
});

test('replacement launch failure closes every known resource and retains the successful prior retirement snapshot', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready;
  f.launches.set(2, async () => { throw Error('synthetic replacement refused'); });
  await assert.rejects(session.restartApi());
  assert.deepEqual(await session.waitForStop(), { stopped: true, failed: true });
  assert.equal(session.status().apiGeneration, 2); assert.equal(session.status().apiRestarts.length, 1);
  assert.equal(session.status().apiRestarts[0].generation, 1); assert(f.apis[1].closeCalls > 0);
  assert(f.log.includes('database:stop')); assert(f.log.includes('secrets:dispose'));
});

test('unplanned current API unavailability still stops the whole session', options, async t => {
  const f = fixture(t), session = f.start(); await session.ready; await session.restartApi();
  f.apis[1].fault(); assert.deepEqual(await session.waitForStop(), { stopped: true, failed: true });
  assert.equal(f.apis.length, 2); assert.equal(session.origin, undefined);
});
