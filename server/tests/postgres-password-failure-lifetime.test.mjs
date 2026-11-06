// Diagnostic control for the installed pg/pg-pool, not a PostgreSQL server,
// native E fixture or credential-provider test. The owned loopback wire double
// requests a password; failures produce no password packets. Late resolution
// uses only a synthetic non-secret string after the connection has closed.
// ssl:false belongs ONLY to this wire double, never to the Windows service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { postgresDatabase } from '../database.mjs';

const unavailable = () => new Error('SYNTHETIC_POSTGRES_WIRE_UNAVAILABLE');
async function within(promise, milliseconds = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function wireFixture({ holdPeerEnd = false, authentication = 'challenge' } = {}) {
  const sockets = new Set(), closures = new Set(), authenticated = Promise.withResolvers();
  authenticated.promise.catch(() => {});
  const waiters = new Set();
  const state = { accepted: 0, startup: 0, postChallengePackets: 0, passwordPackets: 0, queryPackets: 0,
    terminatePackets: 0, peerEnded: 0, peerClosed: 0, invalid: false, queries: [] };
  const notify = () => {
    for (const waiter of waiters) if (state[waiter.key] >= waiter.count) { waiters.delete(waiter); waiter.resolve(); }
  };
  const ready = Buffer.from([90, 0, 0, 0, 5, 73]); // ReadyForQuery, idle.
  const command = tag => {
    const text = Buffer.from(`${tag}\0`), packet = Buffer.alloc(5 + text.length);
    packet[0] = 67; packet.writeUInt32BE(4 + text.length, 1); text.copy(packet, 5); text.fill(0);
    return Buffer.concat([packet, ready]);
  };
  const server = createServer({ allowHalfOpen: holdPeerEnd }, socket => {
    state.accepted++; sockets.add(socket);
    const closed = Promise.withResolvers(); closures.add(closed.promise);
    let bytes = Buffer.alloc(0), started = false;
    const invalid = () => { state.invalid = true; authenticated.reject(unavailable()); socket.destroy(); };
    socket.on('error', () => {});
    socket.on('end', () => { state.peerEnded++; notify(); });
    socket.once('close', () => {
      bytes.fill(0); sockets.delete(socket); state.peerClosed++;
      closures.delete(closed.promise); closed.resolve(); notify();
    });
    socket.on('data', input => {
      if (started) state.postChallengePackets++;
      if (bytes.length + input.length > 8192) return invalid();
      const previous = bytes; bytes = Buffer.concat([previous, input]); previous.fill(0);
      if (!started) {
        if (bytes.length < 4) return;
        const length = bytes.readUInt32BE(0);
        if (length < 8 || length > 8192) return invalid();
        if (bytes.length < length) return;
        if (bytes.length !== length || bytes.readUInt32BE(4) !== 196608) return invalid();
        bytes.fill(0); bytes = Buffer.alloc(0); state.startup++; started = true; notify();
        // R, length=8, AuthenticationCleartextPassword=3. Failure tests never
        // produce a password. A separate no-auth synthetic mode accepts only
        // the fixed harmless transaction commands below, not arbitrary SQL.
        socket.write(authentication === 'challenge' ? Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 3])
          : Buffer.concat([Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]), ready]));
        authenticated.resolve(); return;
      }
      while (bytes.length >= 5) {
        const type = bytes[0], length = bytes.readUInt32BE(1);
        if (length < 4 || length > 8191) return invalid();
        if (bytes.length < length + 1) return;
        const payload = Buffer.from(bytes.subarray(5, length + 1)), remaining = Buffer.from(bytes.subarray(length + 1));
        bytes.fill(0); bytes = remaining;
        try {
          if (type === 112) state.passwordPackets++;
          else if (type === 88 && length === 4) { state.terminatePackets++; if (!holdPeerEnd) socket.end(); }
          else if (type === 81) {
            state.queryPackets++;
            if (authentication !== 'ready' || payload.at(-1) !== 0) return invalid();
            const sql = payload.subarray(0, -1).toString('utf8');
            const commands = new Map([['BEGIN', 'BEGIN'], ["SET LOCAL statement_timeout = '10s'", 'SET'],
              ["SET LOCAL lock_timeout = '5s'", 'SET'], ['SELECT 1', 'SELECT 1'], ['COMMIT', 'COMMIT'], ['ROLLBACK', 'ROLLBACK']]);
            if (!commands.has(sql)) return invalid();
            state.queries.push(commands.get(sql)); socket.write(command(commands.get(sql)));
          } else return invalid();
        } finally { payload.fill(0); }
      }
    });
  });
  server.on('error', () => { state.invalid = true; authenticated.reject(unavailable()); });
  await new Promise((resolve, reject) => {
    const failed = () => { server.off('listening', listening); reject(unavailable()); };
    const listening = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', listening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
  let cleanup;
  return {
    port: server.address().port, state, challenged: authenticated.promise,
    openPeers: () => sockets.size,
    reached(key, count = 1) {
      if (!['startup', 'peerEnded', 'peerClosed'].includes(key)) throw unavailable();
      if (state[key] >= count) return Promise.resolve();
      return new Promise(resolve => waiters.add({ key, count, resolve }));
    },
    releasePeerEnds() { for (const socket of sockets) if (!socket.destroyed) socket.end(); },
    close() {
      return cleanup ??= (async () => {
        const actualClosures = [...closures];
        const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(unavailable()) : resolve()));
        for (const socket of sockets) socket.destroy(); // Exact sockets owned by this fixture only.
        await Promise.all([serverClosed, ...actualClosures]);
        assert.equal(server.listening, false); assert.equal(sockets.size, 0);
      })();
    },
  };
}

function poolFor(wire, password, connectionTimeoutMillis) {
  const pool = new Pool({ host: '127.0.0.1', port: wire.port, user: 'synthetic_wire_actor', database: 'synthetic_wire_fixture',
    password, ssl: false, connectionTimeoutMillis, idleTimeoutMillis: 1000, max: 1 });
  pool.on('error', () => {}); // Never print a driver error or its connection details.
  return pool;
}

function managed(wire, password, connectionTimeoutMillis = 5000, max = 1) {
  return postgresDatabase({ host: '127.0.0.1', port: wire.port, user: 'synthetic_wire_actor', database: 'synthetic_wire_fixture',
    password, ssl: false, connectionTimeoutMillis, idleTimeoutMillis: 1000, max });
}
function noAuthenticationOrQueries(wire) {
  assert.equal(wire.state.passwordPackets, 0); assert.equal(wire.state.queryPackets, 0); assert.equal(wire.state.invalid, false);
}
function refused(database, expected) {
  const result = assert.rejects(database.transaction(() => assert.fail('Failed authentication must not reach application work.')),
    expected instanceof Error ? error => error === expected : expected);
  void result.catch(() => {}); // Gate-driven observations may await this later.
  return result;
}

test('installed raw pg drops a rejected-password client from pool custody while its owned TCP peer remains open', { timeout: 10000 }, async () => {
  const wire = await wireFixture(); let passwordCalls = 0, ending;
  const pool = poolFor(wire, async () => { passwordCalls++; throw new Error('SYNTHETIC_PASSWORD_REJECTED'); }, 250);
  try {
    const connect = pool.connect();
    const refused = assert.rejects(connect, { message: 'SYNTHETIC_PASSWORD_REJECTED' });
    await within(wire.challenged); await within(refused);
    assert.equal(passwordCalls, 1); assert.equal(pool.totalCount, 0); assert.equal(pool.waitingCount, 0);
    ending = pool.end(); await within(ending);
    assert.equal(pool.ended, true);
    // This is an observation past the configured connection timer, not a
    // relaxed product deadline or a substitute for actual socket closure.
    await delay(500);
    assert.equal(wire.openPeers(), 1); assert.equal(wire.state.peerClosed, 0);
    assert.equal(wire.state.accepted, 1); assert.equal(wire.state.startup, 1);
    assert.equal(wire.state.postChallengePackets, 0); assert.equal(wire.state.invalid, false);
  } finally {
    await wire.close();
    await (ending ??= pool.end());
  }
});

test('installed raw pg connection timeout instead destroys the socket while the password promise is still pending', { timeout: 10000 }, async () => {
  const wire = await wireFixture(), password = Promise.withResolvers(); let passwordCalls = 0, ending;
  const pool = poolFor(wire, () => { passwordCalls++; return password.promise; }, 250);
  try {
    const refused = assert.rejects(pool.connect(), error => error instanceof Error);
    await within(wire.challenged); await within(refused);
    ending = pool.end(); await within(ending);
    await delay(100);
    assert.equal(passwordCalls, 1); assert.equal(pool.totalCount, 0); assert.equal(wire.openPeers(), 0);
    assert.equal(wire.state.peerClosed, 1); assert.equal(wire.state.postChallengePackets, 0); assert.equal(wire.state.invalid, false);
  } finally {
    password.reject(new Error('SYNTHETIC_PASSWORD_CANCELLED'));
    await wire.close();
    await (ending ??= pool.end());
  }
});

for (const kind of ['sync-throw', 'async-reject', 'invalid-nonstring'])
  test(`managed failed ${kind} preserves its error and awaits owned TCP closure`, { timeout: 10000 }, async () => {
    const wire = await wireFixture(), expected = new Error('SYNTHETIC_PASSWORD_REJECTED'); let passwordCalls = 0;
    const database = managed(wire, () => {
      passwordCalls++;
      if (kind === 'sync-throw') throw expected;
      return kind === 'async-reject' ? Promise.reject(expected) : Promise.resolve(42);
    });
    try {
      await within(refused(database, kind === 'invalid-nonstring' ? { name: 'TypeError', message: 'Password must be a string' } : expected));
      const closing = database.close(); await within(closing); await within(wire.reached('peerClosed'));
      assert.equal(database.close(), closing); assert.equal(passwordCalls, 1); assert.equal(wire.openPeers(), 0);
      assert.equal(wire.state.accepted, 1); noAuthenticationOrQueries(wire);
    } finally { await wire.close(); await database.close(); }
  });

test('managed failed connect is not released until the peer completes its controlled FIN handshake', { timeout: 10000 }, async () => {
  const wire = await wireFixture({ holdPeerEnd: true }), expected = new Error('SYNTHETIC_PASSWORD_REJECTED');
  const database = managed(wire, async () => { throw expected; }); let connectSettled = false, closeSettled = false;
  try {
    const failure = refused(database, expected).then(() => { connectSettled = true; });
    void failure.catch(() => {});
    await within(wire.reached('peerEnded'));
    const closing = database.close(); closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connectSettled, false); assert.equal(closeSettled, false); assert.equal(wire.openPeers(), 1);
    wire.releasePeerEnds(); await within(Promise.all([failure, closing, wire.reached('peerClosed')]));
    assert.equal(connectSettled, true); assert.equal(closeSettled, true); noAuthenticationOrQueries(wire);
  } finally { await wire.close(); await database.close(); }
});

for (const outcome of ['resolve', 'reject'])
  test(`managed timeout followed by late password ${outcome} cannot reopen or send on the closed connection`, { timeout: 10000 }, async () => {
    const wire = await wireFixture(), password = Promise.withResolvers(); let passwordCalls = 0;
    const database = managed(wire, () => { passwordCalls++; return password.promise; }, 250);
    try {
      const failure = refused(database, error => error instanceof Error);
      await within(wire.challenged); await within(failure); await within(database.close()); await within(wire.reached('peerClosed'));
      if (outcome === 'resolve') password.resolve('synthetic-not-a-credential');
      else password.reject(new Error('SYNTHETIC_PASSWORD_REJECTED'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(passwordCalls, 1); assert.equal(wire.openPeers(), 0); assert.equal(wire.state.accepted, 1);
      noAuthenticationOrQueries(wire);
    } finally { password.reject(new Error('SYNTHETIC_PASSWORD_CANCELLED')); await wire.close(); await database.close(); }
  });

test('managed concurrent close waits for both failed connections without retrying or replacing either original error', { timeout: 10000 }, async () => {
  const wire = await wireFixture({ holdPeerEnd: true }), passwords = [Promise.withResolvers(), Promise.withResolvers()];
  const expected = [new Error('SYNTHETIC_FIRST_FAILURE'), new Error('SYNTHETIC_SECOND_FAILURE')];
  const entered = Promise.withResolvers(), received = new Set();
  for (const pending of passwords) void pending.promise.catch(() => {});
  let calls = 0, settled = false;
  const database = managed(wire, () => {
    const pending = passwords[calls++]; if (calls === 2) entered.resolve(); return pending.promise;
  }, 5000, 2);
  try {
    const failures = expected.map(() => refused(database, error => { received.add(error); return expected.includes(error); }));
    await within(entered.promise); assert.equal(wire.state.startup, 2);
    // Request shutdown while both authenticated password lookups are pending.
    const closing = database.close(); assert.equal(database.close(), closing);
    closing.then(() => { settled = true; }, () => { settled = true; });
    passwords.forEach((pending, index) => pending.reject(expected[index]));
    await within(wire.reached('peerEnded', 2)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(wire.openPeers(), 2);
    wire.releasePeerEnds(); await within(Promise.all([...failures, closing, wire.reached('peerClosed', 2)]));
    assert.equal(received.size, 2); for (const error of expected) assert(received.has(error));
    assert.equal(calls, 2); assert.equal(wire.openPeers(), 0); assert.equal(wire.state.accepted, 2); noAuthenticationOrQueries(wire);
  } finally {
    passwords.forEach(pending => pending.reject(new Error('SYNTHETIC_PASSWORD_CANCELLED')));
    await wire.close(); await database.close();
  }
});

test('managed healthy connection still performs normal transactions and close waits for its actual FIN handshake', { timeout: 10000 }, async () => {
  const wire = await wireFixture({ holdPeerEnd: true, authentication: 'ready' }); let passwordCalls = 0, settled = false;
  const database = managed(wire, () => { passwordCalls++; throw unavailable(); });
  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      assert.equal(await within(database.transaction(async tx => { await tx.query('SELECT 1'); return 'synthetic-ok'; })), 'synthetic-ok');
    }
    assert.deepEqual(wire.state.queries, Array.from({ length: 3 }, () => ['BEGIN', 'SET', 'SET', 'SELECT 1', 'COMMIT']).flat());
    assert.equal(passwordCalls, 0); assert.equal(wire.state.accepted, 1); assert.equal(wire.state.invalid, false);
    const closing = database.close(); closing.then(() => { settled = true; }, () => { settled = true; });
    await within(wire.reached('peerEnded')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); wire.releasePeerEnds(); await within(Promise.all([closing, wire.reached('peerClosed')]));
    assert.equal(database.close(), closing); assert.equal(wire.state.passwordPackets, 0); assert.equal(wire.openPeers(), 0);
  } finally { await wire.close(); await database.close(); }
});
