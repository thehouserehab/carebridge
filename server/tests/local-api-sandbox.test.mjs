import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { createLocalApiSandbox } from '../local-api-sandbox.mjs';
import { getPendingSyntheticCleanup } from '../local-sandbox-cleanup.mjs';
import { parseLocalApiArguments } from '../../scripts/local-api.mjs';

const execute = promisify(execFile);
let sandbox;

function http(origin, pathname = '/', { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path: pathname, method,
      headers: { Host: target.host, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Owned local request timed out.')));
    req.end(body);
  });
}

async function login(runtime, role = 'guardian') {
  const { email, password } = runtime.credentials.find((item) => item.role === role);
  const response = await http(runtime.origin, '/api/local/auth/login', {
    method: 'POST', headers: { Origin: runtime.origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /^cb_local_[a-f0-9]{32}=[A-Za-z0-9_-]{40,100}; Path=\/api\/local\/; HttpOnly; SameSite=Strict;/);
  assert.equal(Object.hasOwn(JSON.parse(response.body), 'token'), false);
  return cookie.split(';')[0];
}

before(async () => { sandbox = await createLocalApiSandbox(); });
after(async () => { await sandbox?.close(); });

test('factory permits only an explicit numeric port and CLI requires synthetic confirmation', async () => {
  for (const input of [null, '4180', [], { port: '4180' }, { port: NaN }, { port: 0.5 }, { port: -1 },
    { port: 80 }, { port: 443 }, { port: 1023 }, { port: 65536 }, { port: undefined },
    { host: '0.0.0.0' }, { database: {} }, { path: 'synthetic' },
    { databaseUrl: 'postgres://synthetic.invalid/example' }, { [Symbol('input')]: 0 }, new Date(),
    Object.defineProperty({}, 'port', { get() { throw new Error('Must not invoke an option getter.'); } }),
  ]) await assert.rejects(createLocalApiSandbox(input), TypeError);
  assert.deepEqual(parseLocalApiArguments(['--confirm-synthetic-local']), { port: 4180 });
  assert.deepEqual(parseLocalApiArguments(['--port=0', '--confirm-synthetic-local']), { port: 0 });
  assert.deepEqual(parseLocalApiArguments(['--confirm-synthetic-local', '--port=1024']), { port: 1024 });
  assert.deepEqual(parseLocalApiArguments(['--confirm-synthetic-local', '--port=65535']), { port: 65535 });
  for (const args of [[], ['--port=4180'], ['--confirm-synthetic-local', '--confirm-synthetic-local'],
    ['--confirm-synthetic-local', '--port=01'], ['--confirm-synthetic-local', '--port=65536'],
    ['--confirm-synthetic-local', '--port=80'], ['--confirm-synthetic-local', '--port=1023'],
    ['--confirm-synthetic-local', '--port=1.5'], ['--confirm-synthetic-local', '--port=0', '--port=1'],
    ['--confirm-synthetic-local', '--host=0.0.0.0'], ['--confirm-synthetic-local', '--database=memory'],
  ]) assert.throws(() => parseLocalApiArguments(args), TypeError);
});

test('runtime has the complete schema, three role-separated synthetic accounts, safe profiles and normal scrypt', async () => {
  assert.match(sandbox.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.equal(Object.keys(sandbox).includes('credentials'), false);
  assert.equal(Object.keys(sandbox).includes('database'), false);
  assert.equal(JSON.stringify(sandbox).includes('@carebridge.test'), false);
  const { rows: migrations } = await sandbox.database.query('SELECT name FROM cb_schema_migrations ORDER BY name');
  assert.equal(migrations.length, 23);
  assert.equal(migrations.at(-1).name, '023-care-recipient-links.sql');
  const { rows: accounts } = await sandbox.database.query('SELECT email,password_hash FROM cb_auth_accounts ORDER BY email');
  assert.equal(accounts.length, 3);
  for (const account of accounts) {
    assert.match(account.email, /^(guardian|therapist|center)\.[a-f0-9-]+@carebridge\.test$/);
    assert.match(account.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(sandbox.credentials.some((credential) => account.password_hash.includes(credential.password)), false);
  }
  const { rows: children } = await sandbox.database.query('SELECT name,age,age_as_of FROM cb_child_profiles');
  assert.deepEqual(children, [{ name: '가상 아동', age: null, age_as_of: null }]);
  const { rows: messages } = await sandbox.database.query('SELECT body FROM cb_messages');
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /가상 자료/);
});

test('only explicit screen and pure content modules are served with no-store and self-only security headers', async () => {
  for (const [pathname, type] of [['/', 'text/html'], ['/local-api/client.js', 'text/javascript'],
    ['/local-api/app.js', 'text/javascript'], ['/local-api/styles.css', 'text/css'],
    ['/local-api/email-login-client.js', 'text/javascript'], ['/local-api/email-login-ui.js', 'text/javascript'],
    ['/local-api/care-client.js', 'text/javascript'], ['/local-api/care-ui.js', 'text/javascript'],
    ['/local-api/workspace-ui.js', 'text/javascript'],
    ['/local-api/care-recipient-client.js', 'text/javascript'], ['/local-api/operations-recipient.js', 'text/javascript'],
    ['/local-api/operations-ui.js', 'text/javascript'], ['/local-api/operations-onboarding.js', 'text/javascript'], ['/local-api/operations-schedule.js', 'text/javascript'], ['/local-api/operations-client.js', 'text/javascript'], ['/src/profile-fields.js', 'text/javascript'],
    ['/local-api/goal-client.js', 'text/javascript'], ['/src/context-fields.js', 'text/javascript'],
    ['/local-api/appointment-client.js', 'text/javascript'],
    ['/local-api/media-client.js', 'text/javascript'], ['/local-api/media-ui.js', 'text/javascript'], ['/src/media-policy.js', 'text/javascript'],
    ['/src/record-fields.js', 'text/javascript'], ['/src/feedback-fields.js', 'text/javascript']]) {
    const response = await http(sandbox.origin, pathname);
    assert.equal(response.status, 200);
    if (pathname === '/') assert.match(response.body, /data-email-login-mode="synthetic"/);
    assert.match(response.headers['content-type'], new RegExp(`^${type}`));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline|https?:|\*/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    for (const credential of sandbox.credentials) assert.equal(response.body.includes(credential.password), false);
  }
  const head = await http(sandbox.origin, '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 0);
  assert.equal((await http(sandbox.origin, '/favicon.ico')).status, 204);
  for (const pathname of ['/local-api/index.html', '/src/app.js', '/server/auth.mjs', '/.env', '/package.json',
    '/../server/auth.mjs', '/local-api/../server/auth.mjs', '/local-api/%2e%2e/server/auth.mjs',
    '/%2eenv', '/local-api/app.js?debug=1', '/?credentials=true', '//local-api/app.js', '/local-api/client.js/']) {
    assert.equal((await http(sandbox.origin, pathname)).status, 404, pathname);
  }
  const post = await http(sandbox.origin, '/', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal((await http(sandbox.origin, '/api/auth/login')).status, 404);
});

test('static and API requests reject forged hosts, other origins, forwarded headers and cross-site fetches', async () => {
  for (const pathname of ['/', '/local-api/app.js', '/api/local/auth/session']) {
    for (const headers of [ { Host: 'attacker.invalid' }, { Host: `localhost:${new URL(sandbox.origin).port}` },
      { Host: '127.0.0.1:1' }, { Origin: 'http://127.0.0.1:1' }, { Origin: 'null' },
      { Origin: 'https://synthetic.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' }, { Forwarded: 'host=synthetic.invalid' }, { 'X-Forwarded-Host': 'synthetic.invalid' },
    ]) {
      const response = await http(sandbox.origin, pathname, { headers });
      assert.equal(response.status, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal((await http(sandbox.origin, '/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
});

test('fresh factory ignores database/path/port environment and creates different accounts, cookie and data', async (t) => {
  const environment = {
    DATABASE_URL: 'postgresql://synthetic:unusable@203.0.113.1:1/not-a-database',
    PGHOST: '203.0.113.1', PGPORT: '1', PGDATABASE: 'not-a-database',
    PGLITE_DATA_DIR: 'Z:/synthetic-must-not-be-created', CAREBRIDGE_DATA_ROOT: 'Z:/synthetic-must-not-be-created',
    HOST: '0.0.0.0', PORT: '1', NODE_ENV: 'production',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  const create = PGlite.create;
  const argumentsSeen = [];
  let creationDepth = 0;
  const wrapped = t.mock.method(PGlite, 'create', async function (...args) {
    // PGlite may recursively build its own noInitDb memory instance. Observe
    // the factory entry point, without treating library-internal calls as inputs.
    if (creationDepth === 0) argumentsSeen.push(args);
    creationDepth += 1;
    try { return await create.apply(this, args); }
    finally { creationDepth -= 1; }
  });
  let fresh;
  try {
    Object.assign(process.env, environment);
    fresh = await createLocalApiSandbox();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    wrapped.mock.restore();
  }
  t.after(async () => { await fresh?.close(); });
  assert.deepEqual(argumentsSeen, [[]]);
  assert.notEqual(fresh.origin, sandbox.origin);
  assert.notDeepEqual(fresh.ids, sandbox.ids);
  assert.equal(fresh.credentials.length, 3);
  for (let index = 0; index < fresh.credentials.length; index += 1) {
    assert.notEqual(fresh.credentials[index].email, sandbox.credentials[index].email);
    assert.notEqual(fresh.credentials[index].password, sandbox.credentials[index].password);
    assert.ok(fresh.credentials[index].password.length >= 24);
  }
  const firstCookie = await login(sandbox), nextCookie = await login(fresh);
  assert.notEqual(firstCookie.split('=')[0], nextCookie.split('=')[0]);
  assert.equal((await http(fresh.origin, '/api/local/auth/session', { headers: { Cookie: firstCookie } })).status, 401);
  const sourceRows = await fresh.database.query('SELECT id FROM cb_users WHERE id=$1', [sandbox.ids.guardianId]);
  assert.deepEqual(sourceRows.rows, []);
  const accountReference = fresh.credentials[0];
  await fresh.close();
  assert.equal(accountReference.password, ''); assert.equal(accountReference.email, '');
  assert.deepEqual(fresh.credentials, []); assert.equal(fresh.database.closed, true);
});

test('listen failure closes the newly created memory database', async (t) => {
  const create = PGlite.create;
  let attempted;
  const wrapped = t.mock.method(PGlite, 'create', async function (...args) {
    attempted = await create.apply(this, args); return attempted;
  });
  try {
    await assert.rejects(createLocalApiSandbox({ port: Number(new URL(sandbox.origin).port) }), { code: 'EADDRINUSE' });
    assert.equal(attempted.closed, true);
  } finally { wrapped.mock.restore(); if (attempted && !attempted.closed) await attempted.close(); }
});

test('migration/startup failure closes its memory database before rejecting', async (t) => {
  const create = PGlite.create;
  let attempted;
  const wrapped = t.mock.method(PGlite, 'create', async function (...args) {
    attempted = await create.apply(this, args);
    t.mock.method(attempted, 'transaction', async () => { throw new Error('synthetic migration failure'); });
    return attempted;
  });
  try {
    await assert.rejects(createLocalApiSandbox(), /synthetic migration failure/);
    assert.equal(attempted.closed, true);
  } finally { wrapped.mock.restore(); if (attempted && !attempted.closed) await attempted.close(); }
});

test('startup plus cleanup failure retains only its exact memory database cleanup for retry', async t => {
  const create = PGlite.create, initial = Error('synthetic startup failure'), cleanup = Error('synthetic close failure');
  let attempted, actualClose, depth = 0, closeCalls = 0;
  t.mock.method(PGlite, 'create', async function (...args) {
    depth++;
    try {
      const database = await create.apply(this, args);
      if (depth === 1) {
        attempted = database; actualClose = database.close.bind(database);
        t.mock.method(database, 'transaction', async () => { throw initial; });
        t.mock.method(database, 'close', async () => { if (++closeCalls <= 2) throw cleanup; await actualClose(); });
      }
      return database;
    } finally { depth--; }
  });
  try {
    let failure;
    await assert.rejects(createLocalApiSandbox(), error => { failure = error; return error instanceof AggregateError; });
    assert.deepEqual(failure.errors, [initial, cleanup]); assert.equal(JSON.stringify(failure), '{}');
    assert.equal(attempted.closed, false); assert.equal(closeCalls, 1);
    const close = getPendingSyntheticCleanup(failure); assert.equal(typeof close, 'function');
    await assert.rejects(close(), error => error === cleanup);
    assert.equal(getPendingSyntheticCleanup(failure), close); assert.equal(attempted.closed, false);
    await close(); assert.equal(attempted.closed, true); assert.equal(closeCalls, 3);
    assert.equal(getPendingSyntheticCleanup(failure), undefined);
    assert.equal(sandbox.database.closed, false); // The independent shared fixture is untouched.
  } finally { if (attempted && !attempted.closed) await actualClose(); }
});

test('a database close deadline retains the actual pending operation until a successful retry observes completion', async t => {
  const create = PGlite.create, gate = Promise.withResolvers(), originalTimeout = globalThis.setTimeout;
  let attempted, actualClose, depth = 0, closeCalls = 0;
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) =>
    originalTimeout(callback, milliseconds === 5000 ? 5 : milliseconds, ...args));
  t.mock.method(PGlite, 'create', async function (...args) {
    depth++;
    try {
      const database = await create.apply(this, args);
      if (depth === 1) {
        attempted = database; actualClose = database.close.bind(database);
        t.mock.method(database, 'transaction', async () => { throw Error('synthetic initialization failed'); });
        t.mock.method(database, 'close', async () => { closeCalls++; await gate.promise; await actualClose(); });
      }
      return database;
    } finally { depth--; }
  });
  let close;
  try {
    let failure;
    await assert.rejects(createLocalApiSandbox(), error => { failure = error; return error instanceof AggregateError; });
    close = getPendingSyntheticCleanup(failure); assert.equal(typeof close, 'function');
    assert.equal(attempted.closed, false); assert.equal(closeCalls, 1);
    await assert.rejects(close(), /Local sandbox shutdown timed out/);
    assert.equal(getPendingSyntheticCleanup(failure), close); assert.equal(closeCalls, 1);
    assert.equal(attempted.closed, false);
    timer.mock.restore(); gate.resolve(); await close();
    assert.equal(attempted.closed, true); assert.equal(closeCalls, 1);
    assert.equal(getPendingSyntheticCleanup(failure), undefined);
  } finally {
    timer.mock.restore(); gate.resolve();
    if (close) await close();
    else if (attempted && !attempted.closed) await actualClose();
  }
});

test('CLI refuses piped/noninteractive execution without printing credentials or starting a listener', async () => {
  const script = fileURLToPath(new URL('../../scripts/local-api.mjs', import.meta.url));
  const result = await execute(process.execPath, [script, '--confirm-synthetic-local', '--port=0'], {
    timeout: 10000, encoding: 'utf8', windowsHide: true,
  }).then(() => { throw new Error('Noninteractive execution must fail.'); }, (error) => error);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /대화형 터미널/);
  assert.doesNotMatch(result.stderr, /@carebridge\.test|cb_local_|http:\/\/127/);
});

test('close is idempotent, bounds idle/incomplete connections and makes the database and HTTP unavailable', async () => {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(sandbox.origin).port) });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('GET / HTTP/1.1\r\nHost: '); // Deliberately unfinished, no actual data.
  const ended = new Promise((resolve) => socket.once('close', resolve));
  const started = performance.now();
  const first = sandbox.close();
  assert.equal(sandbox.close(), first);
  await first;
  await ended;
  assert.ok(performance.now() - started < 10000);
  assert.equal(sandbox.database.closed, true);
  assert.deepEqual(sandbox.credentials, []);
  await assert.rejects(sandbox.database.query('SELECT 1'));
  await assert.rejects(http(sandbox.origin), { code: 'ECONNREFUSED' });
});
