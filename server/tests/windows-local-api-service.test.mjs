import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Server, request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';
import { rootCertificates } from 'node:tls';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Pool } from 'pg';
import { Auth } from '../auth.mjs';
import { MediaAccess } from '../media-access.mjs';
import { WindowsDatabaseCredentialStore } from '../windows-database-credential-store.mjs';
import { createWindowsLocalApiService, createWindowsWifiApiService } from '../windows-local-api-service.mjs';
import { serviceInput, serviceCatalog } from './database-service-fixtures.mjs';

// Factory composition only: filesystem/credential/driver protocol doubles,
// actual owned loopback listener. No E drive IO, PowerShell, DB connection,
// migration, worker, scanner, approval or native byte delivery is performed.
const unavailable = (error) => {
  assert.equal(error.message, 'WINDOWS_LOCAL_API_UNAVAILABLE');
  assert.equal(error.cause, undefined); assert.equal(error.errors, undefined);
  assert.deepEqual(Object.keys(error), []); return true;
};
function input() {
  const run = randomUUID();
  return { database: {
    storage: { base: 'E:\\CarebridgeBeta', powershell: 'C:\\Tools\\pwsh.exe', syntheticRunId: run },
    credentialId: randomUUID(), privileges: serviceInput(),
    endpoint: { host: '127.0.0.1', port: 54321, ca: rootCertificates[0] },
  }, mediaRoot: `E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media` };
}
function deferred() {
  let resolve, settled = false;
  const promise = new Promise((yes) => { resolve = (value) => { settled = true; yes(value); }; });
  return { promise, resolve, get settled() { return settled; } };
}
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) { assert(performance.now() < deadline, 'SYNTHETIC_API_SERVICE_TIMEOUT'); await nextTurn(); }
}
function info({ file = false, symbolic = false, ...patch } = {}) {
  return { dev: 1n, ino: file ? 2n : 1n, size: file ? 10n : 0n, nlink: 1n, mtimeNs: 10n, ctimeNs: 10n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => symbolic, ...patch };
}

async function fixture(t) {
  const value = input(), root = win32.dirname(value.mediaRoot), receiptPath = win32.join(root, '.carebridge-check.json');
  const receipt = { schema: 1, purpose: 'synthetic-native-e-postgres', runId: value.database.storage.syntheticRunId, root };
  const directories = new Set();
  for (let path = value.mediaRoot; ; path = win32.dirname(path)) { directories.add(path); if (win32.dirname(path) === path) break; }
  const catalog = serviceCatalog(); catalog.state.kind = 'runtime'; let catalogQuery;
  await catalog.database.transaction(async (tx) => { catalogQuery = tx.query; });
  const state = { fsCalls: [], pools: [], loads: [], buffers: [], queries: [], ended: 0, opened: 0, receiptClosed: 0,
    mutations: 0, reads: [], mode: null, admitted: false, sequence: [] };
  const active = [], release = [];
  t.after(async () => {
    t.mock.timers.reset(); for (const finish of release) finish();
    for (const service of active) await service.close().catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const content = () => {
    if (state.mode === 'invalid-json') return Buffer.from('{');
    if (state.mode === 'invalid-utf8') return Buffer.from([0xff]);
    const current = { ...receipt };
    if (state.mode === 'wrong-receipt') current.runId = randomUUID();
    if (state.mode === 'extra-receipt') current.extra = 'SYNTHETIC_PRIVATE';
    return Buffer.from(JSON.stringify(current));
  };
  const receiptInfo = () => info({ file: true, size: BigInt(content().length) });
  t.mock.method(fs, 'lstat', async (path) => {
    state.fsCalls.push(['lstat', path]);
    await state.onStat?.(path);
    if (path === receiptPath) {
      if (state.mode === 'receipt-link') return info({ file: true, symbolic: true });
      if (state.mode === 'receipt-hardlink') return { ...receiptInfo(), nlink: 2n };
      if (state.mode === 'receipt-huge') return { ...receiptInfo(), size: 2049n };
      if (state.mode === 'receipt-empty') return { ...receiptInfo(), size: 0n };
      if (state.mode === 'receipt-directory') return info();
      if (state.mode === 'receipt-final-hardlink' && state.reads.length) return { ...receiptInfo(), nlink: 2n };
      if (state.mode === 'receipt-final-size' && state.reads.length) return { ...receiptInfo(), size: BigInt(content().length + 1) };
      return receiptInfo();
    }
    assert(directories.has(path), 'No unowned filesystem path may be read by this test.');
    if (state.mode === 'root-missing') throw new Error('SYNTHETIC_PRIVATE_PATH');
    if (state.mode === 'root-link' && path === value.mediaRoot || state.mode === 'ancestor-link' && path === root)
      return info({ symbolic: true });
    if (state.mode === 'root-after-db' && state.admitted && path === value.mediaRoot) return info({ ino: 99n });
    return info();
  });
  t.mock.method(fs, 'realpath', async (path) => {
    state.fsCalls.push(['realpath', path]); assert.equal(path, value.mediaRoot);
    return state.mode === 'noncanonical' ? `${path}-unexpected` : path;
  });
  t.mock.method(fs, 'open', async (path, flags) => {
    assert.equal(path, receiptPath); assert.equal(flags, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    state.opened++; let observations = 0;
    return {
      async stat() {
        observations++;
        if (state.mode === 'opened-different') return { ...receiptInfo(), ino: 30n };
        if (state.mode === 'after-hardlink' && observations > 1) return { ...receiptInfo(), nlink: 2n };
        if (state.mode === 'after-time' && observations > 1) return { ...receiptInfo(), mtimeNs: 20n };
        return receiptInfo();
      },
      async read(buffer, offset, length, position) {
        assert.equal(buffer.length, 2049); assert.equal(offset, 0); assert.equal(length, 2049); assert.equal(position, 0);
        state.reads.push(length);
        const bytes = content(); bytes.copy(buffer);
        return { bytesRead: state.mode === 'short-read' ? bytes.length - 1 : bytes.length, buffer };
      },
      async close() { state.receiptClosed++; if (state.mode === 'receipt-close') throw new Error('SYNTHETIC_PRIVATE_CLOSE'); },
    };
  });
  for (const method of ['mkdir', 'writeFile', 'unlink', 'rmdir', 'rm']) t.mock.method(fs, method, async () => {
    state.mutations++; throw new Error('Filesystem mutations are outside this factory test.');
  });
  syncBuiltinESMExports();
  t.mock.method(WindowsDatabaseCredentialStore.prototype, 'load', async function (...args) {
    state.loads.push(args);
    if (state.mode === 'credential-fail') throw new Error('SYNTHETIC_PRIVATE_CREDENTIAL');
    const bytes = Buffer.alloc(64, 65); state.buffers.push(bytes); return bytes;
  });
  t.mock.method(Pool.prototype, 'connect', async function () {
    if (!state.pools.includes(this)) state.pools.push(this);
    state.sequence.push('connect'); await this.options.password();
    if (state.mode === 'connect-fail') throw new Error('SYNTHETIC_PRIVATE_CONNECT');
    return Object.assign(new EventEmitter(), {
      async query(sql, params) {
        state.queries.push(sql);
        if (sql === 'COMMIT') state.admitted = true;
        if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SET TRANSACTION READ ONLY'].includes(sql)) return { rows: [] };
        return catalogQuery(sql, params);
      }, release() {},
    });
  });
  t.mock.method(Pool.prototype, 'end', async function () {
    state.ended++; state.sequence.push('db-close');
    if (state.mode === 'db-close') throw new Error('SYNTHETIC_PRIVATE_POOL_CLOSE');
  });
  return { value, root, state, catalog, keep(service) { active.push(service); return service; },
    release: (callback) => release.push(callback), create: async () => {
      const service = await createWindowsLocalApiService(value); active.push(service); return service;
    } };
}

function call(origin, pathname = '/', { method = 'GET', headers = {}, body } = {}) {
  let outgoing;
  const result = new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    outgoing = request({ hostname: '127.0.0.1', port: new URL(origin).port, path: pathname, method, headers, agent: false }, (response) => {
      const chunks = [], snapshot = (aborted) => ({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), aborted });
      response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => finish(snapshot(false)));
      response.on('error', () => finish(snapshot(true))); response.on('aborted', () => finish(snapshot(true)));
    });
    outgoing.on('error', () => finish({ status: null, body: Buffer.alloc(0), headers: {}, aborted: true })); outgoing.end(body);
  });
  return { request: outgoing, result };
}
const token = 'S'.repeat(48);
const user = () => ({ userId: 'synthetic-reader', email: 'reader@carebridge.test',
  centers: [{ id: 'synthetic-center', role: 'guardian' }], expiresAt: new Date(Date.now() + 60000).toISOString() });
async function login(t, service) {
  t.mock.method(Auth.prototype, 'login', async () => ({ token, user: user() }));
  const result = await call(service.origin, '/api/local/auth/login', { method: 'POST', headers: {
    Origin: service.origin, 'Content-Type': 'application/json', 'X-Carebridge-Request': '1',
  }, body: JSON.stringify({ email: 'reader@carebridge.test', password: 'synthetic-only-password' }) }).result;
  assert.equal(result.status, 200); return result.headers['set-cookie'][0].split(';')[0];
}

test('factory rejects extra authority and accessor options before any filesystem, credential or DB IO', async (t) => {
  const f = await fixture(t); let getterCalls = 0;
  for (const value of [undefined, null, [], new Date(), {}, { ...f.value, port: 4180 }, { ...f.value, host: '0.0.0.0' },
    { ...f.value, databaseUrl: 'SYNTHETIC_PRIVATE' }, { ...f.value, createDatabase() {} }, { ...f.value, store: {} },
    { ...f.value, scanner: {} }, { ...f.value, preparation: {} }, { ...f.value, services: {} },
    ...[undefined, null, 'quarantine', 'prepared-delivery', {}, true].map(screen => ({ ...f.value, screen })),
    { ...f.value, [Symbol('extra')]: true },
    Object.defineProperty({ ...f.value }, 'database', { get() { getterCalls++; return f.value.database; } }),
  ]) await assert.rejects(createWindowsLocalApiService(value), unavailable);
  assert.equal(getterCalls, 0);
  assert.equal(f.state.fsCalls.length, 0); assert.equal(f.state.loads.length, 0); assert.equal(f.state.pools.length, 0);
});

test('separate Wi-Fi composition rejects network/certificate authority before filesystem or DB access', async (t) => {
  const f = await fixture(t); let getterCalls = 0;
  const base = { ...f.value, network: { host: '10.231.9.10', peerAddress: '10.231.9.20', port: 8443, confirmSynthetic: true },
    cert: Buffer.alloc(256), key: Buffer.alloc(256), screen: 'prepared' };
  const network = base.network;
  for (const value of [base, f.value, { ...base, port: 8443 }, { ...base, host: network.host },
    { ...base, network: { ...network, host: '0.0.0.0' } }, { ...base, network: { ...network, peerAddress: network.host } },
    { ...base, network: { ...network, confirmSynthetic: false } }, { ...base, network: { ...network, port: 443 } },
    { ...base, key: 'PRIVATE_KEY_MUST_BE_BUFFER' }, { ...base, cert: Buffer.alloc(65537) },
    Object.defineProperty({ ...base }, 'key', { get() { getterCalls++; return base.key; } }),
  ]) await assert.rejects(createWindowsWifiApiService(value), unavailable);
  assert.equal(getterCalls, 0); assert.equal(f.state.fsCalls.length, 0);
  assert.equal(f.state.loads.length, 0); assert.equal(f.state.pools.length, 0);
  // The old entry point must not silently switch transport for valid-looking
  // Wi-Fi inputs; callers need the separate explicitly authorized factory.
  await assert.rejects(createWindowsLocalApiService(base), unavailable);
  assert.equal(f.state.fsCalls.length, 0);
});

test('explicit prepared Windows screen retains runtime admission and delivers only server-marked fixed assets', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t);
  const service = f.keep(await createWindowsLocalApiService({ ...f.value, screen: 'prepared' }));
  const page = await call(service.origin).result;
  assert.equal(page.status, 200); assert.match(page.body.toString('utf8'), /<html lang="ko" data-media-mode="prepared-delivery">/);
  assert.match(page.headers['content-security-policy'], /img-src 'self' blob:; media-src blob:/);
  assert.equal(f.state.pools[0].options.user, 'cb_runtime'); assert.equal(f.state.loads[0][2], 'runtime');
  assert.equal((await call(service.origin, '/local-api/media-viewer.js').result).status, 200);
  assert.equal((await call(service.origin, '/?screen=prepared').result).status, 404);
  assert.equal((await call(service.origin, '/server/auth.mjs').result).status, 404);
  await service.close(); assert.equal(f.state.ended, 1); assert.equal(f.state.mutations, 0);
});

test('factory refuses non-synthetic, alternate role, untrusted root and non-TLS configuration before filesystem reads', async (t) => {
  const f = await fixture(t);
  for (const change of [v => { v.database.kind = 'owner'; }, v => { v.database.password = 'SYNTHETIC_PRIVATE'; },
    v => { delete v.database.storage.syntheticRunId; }, v => { v.database.endpoint.host = '192.0.2.1'; },
    v => { delete v.database.endpoint.ca; }, v => { v.database.endpoint.ca = 'SYNTHETIC_PRIVATE'; },
    v => { v.database.endpoint = { host: '127.0.0.1', port: 54321, transport: 'synthetic-loopback' }; },
    v => { v.mediaRoot = 'E:\\CarebridgeBeta\\private\\media'; }, v => { v.mediaRoot += '\\..\\source-media'; },
    v => { v.database.storage.base = 'C:\\Users\\synthetic'; }]) {
    const value = structuredClone(f.value); change(value); await assert.rejects(createWindowsLocalApiService(value), unavailable);
  }
  assert.equal(f.state.fsCalls.length, 0); assert.equal(f.state.loads.length, 0); assert.equal(f.state.pools.length, 0);
});

test('owned-root and receipt preflight denies missing/link/oversized/wrong evidence before credential access', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only factory; configuration denial is covered separately.');
  const f = await fixture(t);
  for (const mode of ['root-missing', 'root-link', 'ancestor-link', 'noncanonical', 'receipt-link', 'receipt-hardlink',
    'receipt-empty', 'receipt-huge', 'receipt-directory', 'invalid-json', 'invalid-utf8', 'wrong-receipt', 'extra-receipt']) {
    f.state.mode = mode; await assert.rejects(f.create(), unavailable);
    assert.equal(f.state.loads.length, 0); assert.equal(f.state.pools.length, 0); assert.equal(f.state.opened, f.state.receiptClosed);
  }
  assert.equal(f.state.mutations, 0);
});

test('bounded receipt reads recheck handle/path identity and always close on malformed or changed evidence', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only receipt path.');
  const f = await fixture(t);
  for (const mode of ['opened-different', 'short-read', 'after-hardlink', 'after-time', 'receipt-final-hardlink', 'receipt-final-size', 'receipt-close']) {
    f.state.mode = mode; f.state.reads.length = 0;
    await assert.rejects(f.create(), unavailable);
    assert.equal(f.state.loads.length, 0); assert.equal(f.state.pools.length, 0); assert.equal(f.state.opened, f.state.receiptClosed);
  }
});

test('runtime-only admitted composition returns API-only origin and leaves DB/store ownership outside the listener', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t), service = await f.create();
  assert(Object.isFrozen(service)); assert.deepEqual(Object.keys(service).sort(), ['close', 'origin']);
  assert.equal(f.state.pools.length, 1); assert.equal(f.state.pools[0].options.user, 'cb_runtime');
  assert.equal(f.state.pools[0].options.ssl.rejectUnauthorized, true);
  assert.equal(f.state.loads[0][2], 'runtime'); assert.equal(f.state.opened, 2); assert.equal(f.state.receiptClosed, 2);
  assert(f.state.queries.includes('SET TRANSACTION READ ONLY'));
  assert(!f.state.queries.some((sql) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|TRUNCATE|SET ROLE)\b/.test(sql)));
  assert(f.state.buffers.every((buffer) => buffer.every((byte) => byte === 0))); assert.equal(f.state.mutations, 0);
  assert.equal((await call(service.origin).result).status, 404);
  assert.equal((await call(service.origin, '/local-api/app.js').result).status, 404);
  assert.equal((await call(service.origin, '/api/local/auth/session').result).status, 401);
  const first = service.close(); assert.equal(service.close(), first); await first;
  assert.equal(f.state.ended, 1); assert.equal((await call(service.origin).result).aborted, true);
});

test('configuration is captured before first receipt await and does not adopt caller changes', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t), gate = deferred(), entered = deferred(); f.release(() => gate.resolve());
  let first = true;
  f.state.onStat = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const original = structuredClone(f.value), pending = createWindowsLocalApiService(f.value);
  await until(() => entered.settled);
  f.value.database.endpoint.port = 1; f.value.database.credentialId = randomUUID(); f.value.database.privileges.roles.runtime = 'other';
  f.value.screen = 'prepared';
  // The fake filesystem keeps its original root scope; only external inputs mutate.
  gate.resolve(); const service = f.keep(await pending);
  assert.equal(f.state.pools[0].options.port, original.database.endpoint.port);
  assert.equal(f.state.pools[0].options.user, original.database.privileges.roles.runtime);
  assert.equal((await call(service.origin).result).status, 404);
  assert.equal(f.state.loads[0][0], original.database.credentialId); await service.close();
});

test('runtime admission errors close their pool and do not expose credential, catalog or driver diagnostics', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t);
  for (const mode of ['credential-fail', 'connect-fail', 'role-mismatch', 'target-mismatch', 'excess-privilege']) {
    f.state.mode = mode;
    f.catalog.state.kind = mode === 'role-mismatch' ? 'worker' : 'runtime';
    f.catalog.state.grantedBody = mode === 'excess-privilege';
    const value = structuredClone(f.value); if (mode === 'target-mismatch') value.database.privileges.target.oid++;
    const before = f.state.ended; await assert.rejects(createWindowsLocalApiService(value), unavailable);
    assert.equal(f.state.ended, before + 1);
  }
  assert(f.state.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
});

test('root replacement during DB admission closes the admitted DB without starting HTTP or changing files', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t); f.state.mode = 'root-after-db';
  const listens = t.mock.method(Server.prototype, 'listen', function () { assert.fail('Changed root must not start HTTP.'); });
  await assert.rejects(f.create(), unavailable);
  assert.equal(listens.mock.callCount(), 0); assert.equal(f.state.ended, 1); assert.equal(f.state.mutations, 0);
});

test('listener startup failure closes the admitted DB and returns no raw bind error or private path', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t);
  t.mock.method(Server.prototype, 'listen', function () {
    queueMicrotask(() => this.emit('error', new Error('SYNTHETIC_PRIVATE_LISTEN'))); return this;
  });
  await assert.rejects(f.create(), unavailable); assert.equal(f.state.ended, 1); assert.equal(f.state.mutations, 0);
});

test('HTTP drain timeout retains the DB and explicit retry closes it only after the actual handler finishes', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t), service = await f.create(), gate = deferred(), entered = deferred(); f.release(() => gate.resolve());
  const cookie = await login(t, service);
  t.mock.method(Auth.prototype, 'authenticate', async () => { entered.resolve(); await gate.promise; return user(); });
  const pending = call(service.origin, '/api/local/auth/session', { headers: { Cookie: cookie } });
  await until(() => entered.settled); t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = service.close(), rejected = assert.rejects(first, unavailable);
  t.mock.timers.tick(10001); await rejected; assert.equal(f.state.ended, 0);
  t.mock.timers.reset(); gate.resolve(); await service.close();
  assert.equal(f.state.ended, 1); assert.equal((await pending.result).aborted, true);
});

test('late media open and asynchronous disposal both finish before the runtime pool is closed', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t), service = await f.create(), opening = deferred(), entered = deferred(), destroying = deferred(), startedDestroy = deferred();
  const uploadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  const opened = (stream = Readable.from([bytes], { objectMode: false })) => ({ stream,
    attachment: { id: uploadId, name: 'synthetic.png', type: 'image/png', size: bytes.length },
    total: bytes.length, range: { start: 0, end: bytes.length - 1 } });
  f.release(() => { opening.resolve(opened()); destroying.resolve(); });
  const cookie = await login(t, service);
  t.mock.method(Auth.prototype, 'authenticate', async () => user());
  t.mock.method(MediaAccess.prototype, 'open', async () => { entered.resolve(); return opening.promise; });
  const path = `/api/local/centers/synthetic-center/conversations/synthetic-room/messages/synthetic-message/attachments/${uploadId}/content`;
  const pending = call(service.origin, path, { headers: { Cookie: cookie, 'X-Carebridge-Account': 'synthetic-reader' } });
  await until(() => entered.settled); pending.request.destroy(); await pending.result;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await nextTurn(); assert.equal(f.state.ended, 0); assert.equal(closed, false);
  const stream = new Readable({ read() {}, destroy(_error, callback) { startedDestroy.resolve(); destroying.promise.then(() => callback()); } });
  opening.resolve(opened(stream)); await until(() => startedDestroy.settled);
  assert.equal(f.state.ended, 0); assert.equal(closed, false);
  destroying.resolve(); await closing; assert.equal(stream.closed, true); assert.equal(f.state.ended, 1);
});

test('pool close failure remains a fixed failure on retry rather than reopening or claiming cleanup', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only runtime composition.');
  const f = await fixture(t), service = await f.create(); f.state.mode = 'db-close';
  const first = service.close(); assert.equal(service.close(), first); await assert.rejects(first, unavailable);
  await assert.rejects(service.close(), unavailable); assert.equal(f.state.ended, 1);
  assert.equal(f.state.pools.length, 1); assert.equal((await call(service.origin).result).aborted, true);
});
