// In-memory CLI contract only. No TTY, E path, child process, worker or DB is
// opened; the printable credentials below are deliberately synthetic sentinels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runSyntheticEApi } from '../scripts/synthetic-e-api.mjs';

const args = ['--base', 'E:\\SyntheticOnly', '--powershell', 'C:\\SyntheticOnly\\pwsh.exe', '--confirm-synthetic-e-drive'];
const password = 'SYNTHETIC_INITIAL_PASSWORD', privateError = 'SYNTHETIC_PRIVATE_ERROR_DO_NOT_PRINT';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { const result = Promise.withResolvers(); result.promise.catch(() => {}); return result; };
const options = { timeout: 3000 };

function fixture(t, { legacy = false, foreignListeners = false } = {}) {
  const stdout = [], stderr = [], input = new EventEmitter(), target = new EventEmitter(), timers = new Set(), restarts = [];
  input.isTTY = true;
  let pauses = 0, resumes = 0, phase = 'starting', failed = false, closes = 0, forgotten = 0, reads = 0, running;
  input.pause = () => { pauses++; }; input.resume = () => { resumes++; };
  const output = { isTTY: true, write(text) { stdout.push(String(text)); return true; } };
  const diagnostic = { write(text) { stderr.push(String(text)); return true; } };
  const ready = deferred(), stopped = deferred();
  const session = { ready: ready.promise, status: () => ({ phase, failed, ready: phase === 'ready' }), waitForStop: () => stopped.promise,
    close() { closes++; phase = 'stopping'; return stopped.promise; }, forgetCredentials() { forgotten++; } };
  Object.defineProperty(session, 'credentials', { get() {
    reads++; if (reads > 1) throw Error(privateError);
    return [{ role: 'therapist', email: 'restart@example.test', password }];
  } });
  if (!legacy) session.restartApi = () => { const restart = deferred(); restarts.push(restart); return restart.promise; };
  const foreign = () => {};
  if (foreignListeners) {
    for (const name of ['data', 'end', 'error']) input.on(name, foreign);
    for (const name of ['SIGINT', 'SIGTERM']) target.on(name, foreign);
  }
  t.mock.method(globalThis, 'setInterval', (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', timer => { if (timer !== undefined) { assert(timers.has(timer)); timers.delete(timer); } });
  function finish(failure = failed) { failed = failure; phase = 'stopped'; stopped.resolve({ stopped: true, failed }); }
  t.after(async () => {
    // Release these doubles even when an assertion fails. This does not stand
    // in for terminal process evidence in the separate native harness.
    for (const restart of restarts) restart.resolve({ origin: 'http://127.0.0.1:4999', apiGeneration: 99 });
    ready.resolve({ origin: 'http://127.0.0.1:4101' }); finish(); await running;
    assert.equal(timers.size, 0, 'Confirmed stop must release only the CLI keepalive.');
  });
  return { input, target, output, diagnostic, session, stdout, stderr, restarts, timers,
    text: () => stdout.join(''), errors: () => stderr.join(''), reads: () => reads, forgotten: () => forgotten,
    closes: () => closes, pauses: () => pauses, resumes: () => resumes,
    start({ input: otherInput = input, create = () => session } = {}) {
      running = runSyntheticEApi(args, { input: otherInput, output, diagnostic, target, create }); return running;
    },
    prepare() { phase = 'ready'; ready.resolve({ origin: 'http://127.0.0.1:4101' }); }, finish,
    async prepared() { const run = this.start(); this.prepare(); await tick(); return { run }; },
    restartDone(index = 0) { restarts[index].resolve({ origin: `http://127.0.0.1:${4102 + index}`, apiGeneration: 2 + index }); },
    assertReleased() {
      for (const name of ['data', 'end', 'error']) assert.deepEqual(input.listeners(name), foreignListeners ? [foreign] : [], name);
      for (const name of ['SIGINT', 'SIGTERM']) assert.deepEqual(target.listeners(name), foreignListeners ? [foreign] : [], name);
      assert.equal(timers.size, 0);
    },
  };
}
function noPrivateErrors(f) { assert(!f.errors().includes(password)); assert(!f.errors().includes(privateError)); assert(!f.text().includes(privateError)); }

test('legacy session without restartApi never requires or subscribes to stdin stream methods', options, async t => {
  const f = fixture(t, { legacy: true }); const run = f.start({ input: { isTTY: true } }); f.prepare(); await tick();
  assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.reads(), 1);
  f.finish(); await run; f.assertReleased(); assert.equal(f.target.exitCode, undefined);
});

test('r split across Buffer chunks restarts once and announces the new URL without rereading credentials', options, async t => {
  const f = fixture(t), { run } = await f.prepared();
  for (const name of ['data', 'end', 'error']) assert.equal(f.input.listenerCount(name), 1, name);
  assert.equal(f.reads(), 1); assert.equal(f.forgotten(), 1);
  const start = f.text().length; f.input.emit('data', Buffer.from(' r'));
  await tick(); assert.equal(f.restarts.length, 0);
  f.input.emit('data', Buffer.from(' \r')); f.input.emit('data', Buffer.from('\n')); await tick();
  assert.equal(f.restarts.length, 1); assert.equal(f.closes(), 0); assert(!f.text().slice(start).includes('4102'));
  f.restartDone(); await tick();
  const message = f.text().slice(start);
  assert(message.includes('http://127.0.0.1:4102')); assert.match(message, /로그인/); assert(!message.includes(password));
  assert.equal(f.reads(), 1); assert.equal(f.forgotten(), 1);
  f.finish(); await run; f.assertReleased(); assert.equal(f.pauses(), 1); noPrivateErrors(f);
});

test('R and CR/LF commands coalesce while pending, then a later explicit command can restart again', options, async t => {
  const f = fixture(t), { run } = await f.prepared();
  f.input.emit('data', 'R\r\nr\nr\r'); await tick(); assert.equal(f.restarts.length, 1);
  f.restartDone(); await tick(); f.input.emit('data', '\n r \n'); await tick();
  assert.equal(f.restarts.length, 2); f.restartDone(1); await tick();
  assert.equal(f.reads(), 1); assert.equal(f.closes(), 0); f.finish(); await run; f.assertReleased();
});

test('ASCII command limit is sixteen characters before trim; overlong and unknown input is not echoed', options, async t => {
  const f = fixture(t), { run } = await f.prepared();
  f.input.emit('data', `${' '.repeat(7)}r${' '.repeat(8)}\n`); await tick(); assert.equal(f.restarts.length, 1);
  f.restartDone(); await tick();
  const start = f.text().length, errorStart = f.errors().length;
  const pasted = 'UNTRUSTED_PASTED_PASSWORD_SENTINEL';
  f.input.emit('data', `${' '.repeat(8)}r${' '.repeat(8)}\n${pasted}\n${'z'.repeat(4096)}\n`);
  await tick(); assert.equal(f.restarts.length, 1);
  const notices = f.text().slice(start) + f.errors().slice(errorStart);
  assert(notices.length > 0 && notices.length < 1000); assert(!notices.includes(pasted)); assert(!notices.includes('zzzz'));
  f.finish(); await run; f.assertReleased(); noPrivateErrors(f);
});

test('non-ASCII and control-bearing commands cannot invoke restart or echo raw input', options, async t => {
  const f = fixture(t), { run } = await f.prepared(); const start = f.text().length, errorStart = f.errors().length;
  f.input.emit('data', Buffer.from('ｒ\n한글비밀\nr\u0000\nrr\n\tr\t\n'));
  await tick(); assert.equal(f.restarts.length, 0);
  const notices = f.text().slice(start) + f.errors().slice(errorStart);
  assert(notices.length > 0); assert(!notices.includes('한글비밀')); assert(!notices.includes('ｒ')); assert(!notices.includes('\u0000'));
  f.finish(); await run; f.assertReleased();
});

for (const event of ['SIGINT', 'SIGTERM', 'end', 'error']) {
  test(`${event} requests whole-session close and never prints a late successful restart URL`, options, async t => {
    const f = fixture(t), { run } = await f.prepared();
    f.input.emit('data', 'r\n'); await tick(); assert.equal(f.restarts.length, 1);
    const start = f.text().length;
    if (event === 'SIGINT' || event === 'SIGTERM') f.target.emit(event);
    else f.input.emit(event, event === 'error' ? Error(privateError) : undefined);
    await tick(); assert.equal(f.closes(), 1); assert(!f.text().includes('DB를 종료했습니다'));
    assert.equal(f.input.listenerCount('data'), 1, 'Until confirmed stop, retain the owned input handlers.');
    f.restartDone(); await tick(); assert(!f.text().slice(start).includes('http://127.0.0.1:4102'));
    f.input.emit('data', 'r\n'); await tick(); assert.equal(f.restarts.length, 1);
    f.finish(); await run; f.assertReleased(); noPrivateErrors(f);
  });
}

test('EOF discards an unterminated command and closes the same owned session', options, async t => {
  const f = fixture(t), { run } = await f.prepared();
  f.input.emit('data', 'r'); f.input.emit('end'); await tick();
  assert.equal(f.restarts.length, 0); assert.equal(f.closes(), 1);
  f.finish(); await run; f.assertReleased();
});

for (const timing of ['before-command', 'before-result']) {
  test(`TTY loss ${timing} prevents restart output and closes the same owned session`, options, async t => {
    const f = fixture(t), { run } = await f.prepared(); const start = f.text().length;
    if (timing === 'before-command') { f.input.isTTY = false; f.input.emit('data', 'r\n'); }
    else { f.input.emit('data', 'r\n'); await tick(); f.output.isTTY = false; f.restartDone(); }
    await tick(); assert.equal(f.closes(), 1); assert.equal(f.target.exitCode, 1);
    assert(!f.text().slice(start).includes('4102')); assert.equal(f.reads(), 1);
    f.finish(); await run; f.assertReleased(); noPrivateErrors(f);
  });
}

for (const boundary of ['start-notice', 'completed-address']) {
  test(`restart output failure at ${boundary} retains the same owned session until confirmed cleanup`, options, async t => {
    const f = fixture(t), { run } = await f.prepared();
    const write = f.output.write, start = f.text().length;
    const marker = boundary === 'start-notice' ? '기존 API의 실제 종료' : 'API 재시작 완료:';
    let failedWrites = 0;
    f.output.write = text => {
      if (text.includes(marker)) { failedWrites++; throw Error(privateError); }
      return write(text);
    };
    f.input.emit('data', 'r\n'); await tick();
    if (boundary === 'completed-address') {
      assert.equal(f.restarts.length, 1); assert.equal(f.closes(), 0);
      f.restartDone(); await tick();
    } else assert.equal(f.restarts.length, 0, 'No restart may begin when the start notice fails.');
    assert.equal(failedWrites, 1); assert.equal(f.closes(), 1); assert.equal(f.target.exitCode, 1);
    assert.equal(f.reads(), 1); assert.equal(f.forgotten(), 1);
    const after = f.text().slice(start);
    assert(!after.includes(password)); assert(!after.includes('http://127.0.0.1:4102'));
    assert(!after.includes('DB를 종료했습니다')); noPrivateErrors(f);
    for (const name of ['data', 'end', 'error']) assert.equal(f.input.listenerCount(name), 1, name);
    assert.equal(f.target.listenerCount('SIGINT'), 1); assert.equal(f.target.listenerCount('SIGTERM'), 1);
    assert.equal(f.timers.size, 1, 'A broken output stream is not terminal cleanup evidence.');
    f.finish(); await run; f.assertReleased(); assert.equal(f.pauses(), 1); noPrivateErrors(f);
  });
}

for (const synchronous of [false, true]) {
  test(`restart ${synchronous ? 'synchronous throw' : 'promise rejection'} is redacted without abandoning or closing a still-healthy session`, options, async t => {
    const f = fixture(t);
    f.session.restartApi = () => { if (synchronous) throw Error(privateError); return Promise.reject(Error(privateError)); };
    const { run } = await f.prepared(); f.input.emit('data', 'r\n'); await tick();
    assert.equal(f.closes(), 0); assert.equal(f.target.exitCode, 1); noPrivateErrors(f);
    assert.equal(f.input.listenerCount('data'), 1); assert.equal(f.timers.size, 1);
    f.target.emit('SIGINT'); await tick(); assert.equal(f.closes(), 1);
    f.finish(); await run; f.assertReleased();
  });
}

test('confirmed shutdown removes only owned stdin/signal listeners and never pauses another data consumer', options, async t => {
  const f = fixture(t, { foreignListeners: true }), { run } = await f.prepared();
  assert.equal(f.input.listenerCount('data'), 2); f.target.emit('SIGINT'); await tick();
  assert.equal(f.input.listenerCount('data'), 2);
  f.finish(); await run; f.assertReleased(); assert.equal(f.pauses(), 0);
});

test('partial stdin registration failure is redacted and still closes the allocated session', options, async t => {
  const f = fixture(t), original = f.input.on;
  f.input.on = function(name, listener) { if (name === 'end') throw Error(privateError); return original.call(this, name, listener); };
  const run = f.start(); f.prepare(); await tick();
  assert.equal(f.closes(), 1); assert.equal(f.target.exitCode, 1);
  f.finish(true); await run; f.assertReleased(); noPrivateErrors(f);
});

test('invalid stdin chunk fails closed without discarding cleanup ownership or echoing its fields', options, async t => {
  const f = fixture(t), { run } = await f.prepared();
  f.input.emit('data', { privateValue: privateError }); await tick();
  assert.equal(f.closes(), 1); assert.equal(f.target.exitCode, 1);
  assert.equal(f.target.listenerCount('SIGINT'), 1);
  f.finish(true); await run; f.assertReleased(); noPrivateErrors(f);
});
