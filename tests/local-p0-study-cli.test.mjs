// CLI lifecycle/IO doubles only. No server, browser, database, filesystem or
// child process is created by this test, and all lifetime timers are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseLocalP0StudyArguments, runLocalP0Study } from '../scripts/local-p0-study.mjs';
import { createOwnedCleanupError, getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';

const args = (task, duration) => ['--confirm-synthetic-local', `--task=${task}`,
  ...(duration === undefined ? [] : [`--duration-minutes=${duration}`])];
const secret = { guardian: 'SYNTHETIC-GUARDIAN-PASSWORD', therapist: 'SYNTHETIC-THERAPIST-PASSWORD', manager: 'SYNTHETIC-MANAGER-PASSWORD' };
const privateDetail = 'PRIVATE-RAW-ERROR-C:\\SECRET\\NEVER-PRINT';
const sha256 = 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const invalidArguments = () => [[], ['--task=A'], ['--task=A', '--confirm-synthetic-local'],
  ['--confirm-synthetic-local', '--task', 'A'], args('a'), args('D'),
  [...args('A'), '--confirm-synthetic-local'], [...args('A'), '--task=B'],
  [...args('A'), '--host=0.0.0.0'], [...args('A'), '--database=' + privateDetail],
  ['--yes', '--task=A'], ['--confirm-synthetic-local', '--task=A '],
  ...['', '0', '-1', '31', '121', '120.0', '120.5', '030', '0120', '+120', '1.2e2', 'Infinity',
    'infinity', 'unlimited', 'NaN', ' 120', '120 ', privateDetail].map(duration => args('A', duration)),
  [...args('A'), '--DURATION-MINUTES=120'], [...args('A'), '--duration-minutes', '120'],
  ['--confirm-synthetic-local', '--duration-minutes=120', '--task=A'],
  [...args('A', 120), '--duration-minutes=120'], [...args('A', 30), '--duration-minutes=120'],
  null, {}, '--confirm-synthetic-local --task=A'];

function timers(t) {
  const active = new Set(), created = [];
  for (const kind of ['Timeout', 'Interval']) {
    t.mock.method(globalThis, `set${kind}`, (callback, delay, ...parameters) => {
      const timer = { kind, delay, referenced: true, cleared: false,
        ref() { this.referenced = true; return this; }, unref() { this.referenced = false; return this; },
        hasRef() { return this.referenced && !this.cleared; },
        fire() { if (!this.cleared) { if (kind === 'Timeout') active.delete(this); callback(...parameters); } } };
      created.push(timer); active.add(timer); return timer;
    });
    t.mock.method(globalThis, `clear${kind}`, timer => {
      if (timer === undefined || timer === null) return;
      assert(created.includes(timer), 'Only timers allocated by this CLI double can be cleared.');
      timer.cleared = true; active.delete(timer);
    });
  }
  t.after(() => assert.equal(active.size, 0, 'Confirmed cleanup must release owned lifetime timers.'));
  return { active, created };
}

function fixture(task = 'A') {
  const input = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {}, setEncoding() {} });
  const target = new EventEmitter();
  const state = { calls: [], text: '', errors: '', sources: 0, creates: 0, closes: 0, credentialsRead: 0, ready: deferred() };
  const credentials = Object.entries(secret).map(([role, password]) => ({ role, email: `${role}@carebridge.test`, password }));
  const controls = {
    onReady() { queueMicrotask(() => input.emit('data', Buffer.from('q\n'))); },
    source() { return { sha256 }; }, prepare() { return true; },
    create() { return prepared; },
    close() {
      sandbox.database.closed = true;
      for (const item of credentials) { item.email = ''; item.password = ''; }
      credentials.length = 0;
    },
  };
  const sandbox = { origin: 'http://127.0.0.1:58123', database: { closed: false },
    get credentials() { state.credentialsRead++; return credentials; },
    async close() { state.calls.push('close'); state.closes++; return controls.close(); } };
  const prepared = { task, day: '2026-10-14', sandbox };
  const output = { isTTY: true, write(value) {
    const text = String(value); state.text += text;
    if (text.includes('평가용 서버 준비됨')) { state.ready.resolve(); controls.onReady(); }
    return true;
  } };
  const diagnostic = { write(value) { state.errors += String(value); return true; } };
  const options = { input, output, diagnostic, target,
    async observeSource() { state.calls.push('source'); return controls.source(++state.sources); },
    async prepare(expectedHash) { assert.equal(expectedHash, sha256); state.calls.push('prepare'); return controls.prepare(); },
    async createFixture(selectedTask, options) {
      state.calls.push('fixture'); state.creates++;
      assert.equal(selectedTask, task); assert.deepEqual(options, { port: 0 });
      return controls.create();
    } };
  return { input, output, diagnostic, target, state, controls, sandbox, prepared, options };
}

function noPrivateErrors(f) {
  assert(!f.state.text.includes(privateDetail)); assert(!f.state.errors.includes(privateDetail));
  for (const value of Object.values(secret)) assert(!f.state.errors.includes(value));
}
function noCredentials(f) {
  for (const [role, value] of Object.entries(secret)) {
    assert(!f.state.text.includes(value)); assert(!f.state.text.includes(`${role}@carebridge.test`));
  }
  noPrivateErrors(f);
}
function listenersCleared(f) {
  for (const event of ['SIGINT', 'SIGTERM']) assert.equal(f.target.listenerCount(event), 0);
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(f.input.listenerCount(event), 0);
}
function observeCompletion(promise) {
  let done = false;
  const completion = promise.then(value => { done = true; return value; });
  return { completion, done: () => done };
}

test('initialization cleanup failure keeps the exact owner and permits retry without opening evaluation', async t => {
  const clock = timers(t), f = fixture(), attempted = deferred(); let closes = 0;
  const ownedError = createOwnedCleanupError(Error(privateDetail), Error(privateDetail), async () => {
    closes++; attempted.resolve();
    if (closes === 1) throw Error(privateDetail);
  });
  f.controls.create = () => { throw ownedError; };
  const run = observeCompletion(runLocalP0Study(args('A'), f.options));
  await attempted.promise; await tick();
  assert.equal(run.done(), false); assert.equal(closes, 1);
  assert(f.target.listenerCount('SIGINT') > 0); assert(clock.active.size > 0);
  assert.match(f.state.errors, /종료가 확인되지 않았습니다/);
  assert.doesNotMatch(f.state.text, /평가용 서버 준비됨|평가용 서버 종료 확인/);
  noCredentials(f);
  f.target.emit('SIGINT'); await run.completion;
  assert.equal(closes, 2); assert.equal(getPendingSyntheticCleanup(ownedError), undefined);
  assert.match(f.state.text, /평가용 서버 종료 확인/); listenersCleared(f); noCredentials(f);
});

test('arguments accept only ordered synthetic tasks and an optional exact 30/120-minute duration', () => {
  for (const task of ['A', 'B', 'C']) for (const duration of [undefined, 30, 120]) {
    const value = parseLocalP0StudyArguments(args(task, duration));
    assert.deepEqual(value, { task, durationMinutes: duration ?? 30 }); assert(Object.isFrozen(value));
  }
  for (const invalid of invalidArguments()) {
    assert.throws(() => parseLocalP0StudyArguments(invalid), error => {
      assert(!String(error).includes(privateDetail)); return true;
    });
  }
});

test('invalid arguments and non-TTY inputs refuse before preparation or allocation', async t => {
  const clock = timers(t);
  for (const scenario of ['arguments', 'input', 'output']) {
    const f = fixture();
    if (scenario === 'input') f.input.isTTY = false;
    if (scenario === 'output') f.output.isTTY = false;
    await runLocalP0Study(scenario === 'arguments' ? ['--password', privateDetail] : args('A'), f.options);
    assert.deepEqual(f.state.calls, []); assert.equal(f.target.exitCode, 1);
    assert.equal(f.state.credentialsRead, 0); assert.equal(f.state.text, '');
    listenersCleared(f); noCredentials(f);
  }
  assert.equal(clock.created.length, 0);
});

test('every unsupported duration and extended non-TTY run refuse before any source, timer, listener or fixture allocation', async t => {
  const clock = timers(t);
  for (const invalid of invalidArguments()) {
    const f = fixture(); await runLocalP0Study(invalid, f.options);
    assert.deepEqual(f.state.calls, []); assert.equal(f.state.creates, 0); assert.equal(f.target.exitCode, 1);
    assert.equal(f.state.credentialsRead, 0); assert.equal(f.state.text, '');
    listenersCleared(f); noCredentials(f);
  }
  for (const stream of ['input', 'output']) {
    const f = fixture(); f[stream].isTTY = false;
    await runLocalP0Study(args('A', 120), f.options);
    assert.deepEqual(f.state.calls, []); assert.equal(f.target.exitCode, 1);
    listenersCleared(f); noCredentials(f);
  }
  assert.equal(clock.created.length, 0);
});

test('each task exposes only its required account and checks sources at all four boundaries', async t => {
  timers(t);
  for (const task of ['A', 'B', 'C']) {
    const f = fixture(task); await runLocalP0Study(args(task), f.options);
    const selected = task === 'B' ? 'therapist' : 'guardian';
    assert.match(f.state.text, /평가용 서버 준비됨/); assert.match(f.state.text, /평가용 서버 종료 확인/);
    assert.equal(f.state.text.split(secret[selected]).length, 2);
    assert.equal(f.state.text.split(`${selected}@carebridge.test`).length, 2);
    for (const role of Object.keys(secret).filter(role => role !== selected)) {
      assert(!f.state.text.includes(secret[role])); assert(!f.state.text.includes(`${role}@carebridge.test`));
    }
    assert.deepEqual(f.state.calls.slice(0, 5), ['source', 'prepare', 'source', 'fixture', 'source']);
    assert.equal(f.state.sources, 4); assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 1);
    assert.equal(f.sandbox.database.closed, true); assert.equal(f.state.errors, '');
    assert.notEqual(f.target.exitCode, 1); listenersCleared(f); noPrivateErrors(f);
    assert.match(f.state.text, /자동 (?:수집|판정)하지/);
    assert.doesNotMatch(f.state.text, /개선율\s*[:=]\s*\d|완료율\s*[:=]\s*\d/);
  }
});

test('failed or throwing preparation never allocates a fixture and redacts raw failures', async t => {
  timers(t);
  for (const throws of [false, true]) {
    const f = fixture(); f.controls.prepare = () => { if (throws) throw Error(privateDetail); return false; };
    await runLocalP0Study(args('A'), f.options);
    assert.equal(f.state.creates, 0); assert.equal(f.state.closes, 0); assert.equal(f.target.exitCode, 1);
    assert.doesNotMatch(f.state.text, /평가용 서버 준비됨/); listenersCleared(f); noCredentials(f);
  }
});

test('changed or malformed source before fixture allocation prevents a new sandbox', async t => {
  timers(t);
  for (const source of [index => ({ sha256: index === 1 ? sha256 : 'b'.repeat(64) }),
    () => ({ sha256: privateDetail }), () => { throw Error(privateDetail); }]) {
    const f = fixture(); f.controls.source = source;
    await runLocalP0Study(args('A'), f.options);
    assert.equal(f.state.creates, 0); assert.equal(f.target.exitCode, 1);
    listenersCleared(f); noCredentials(f);
  }
});

test('source change after fixture creation closes the new owner without displaying credentials', async t => {
  timers(t); const f = fixture();
  f.controls.source = index => ({ sha256: index < 3 ? sha256 : 'b'.repeat(64) });
  await runLocalP0Study(args('A'), f.options);
  assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 1); assert.equal(f.sandbox.database.closed, true);
  assert.equal(f.target.exitCode, 1); assert.doesNotMatch(f.state.text, /평가용 서버 준비됨/);
  listenersCleared(f); noCredentials(f);
});

test('source change during the study is reported without blocking owned cleanup', async t => {
  timers(t); const f = fixture();
  f.controls.source = index => ({ sha256: index < 4 ? sha256 : 'b'.repeat(64) });
  await runLocalP0Study(args('A'), f.options);
  assert.equal(f.state.sources, 4); assert.equal(f.state.closes, 1); assert.equal(f.sandbox.database.closed, true);
  assert.equal(f.target.exitCode, 1); assert.match(f.state.text, /평가용 서버 종료 확인/);
  assert.notEqual(f.state.errors, ''); listenersCleared(f); noPrivateErrors(f);
});

test('TTY loss during preparation prevents later allocation', async t => {
  timers(t);
  for (const stream of ['input', 'output']) {
    const f = fixture(); f.controls.prepare = () => { f[stream].isTTY = false; return true; };
    await runLocalP0Study(args('A'), f.options);
    assert.equal(f.state.creates, 0); assert.equal(f.target.exitCode, 1);
    listenersCleared(f); noCredentials(f);
  }
});

test('TTY loss while a fixture is being created closes it and withholds credentials', async t => {
  timers(t);
  for (const stream of ['input', 'output']) {
    const f = fixture(); f.controls.create = () => { f[stream].isTTY = false; return f.prepared; };
    await runLocalP0Study(args('A'), f.options);
    assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 1); assert.equal(f.sandbox.database.closed, true);
    assert.equal(f.target.exitCode, 1); assert.doesNotMatch(f.state.text, /평가용 서버 준비됨/);
    listenersCleared(f); noCredentials(f);
  }
});

test('a final TTY check before account disclosure catches loss during public instructions', async t => {
  timers(t); const f = fixture(), write = f.output.write;
  f.output.write = value => {
    const result = write(value);
    if (String(value).includes('과제와 관측 규칙')) f.output.isTTY = false;
    return result;
  };
  await runLocalP0Study(args('A'), f.options);
  assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 1);
  assert.equal(f.target.exitCode, 1); assert.doesNotMatch(f.state.text, /평가용 서버 준비됨/);
  listenersCleared(f); noCredentials(f);
});

test('a throwing fixture factory is redacted and never falsely reports an owned server stopped', async t => {
  timers(t); const f = fixture(); f.controls.create = () => { throw Error(privateDetail); };
  await runLocalP0Study(args('A'), f.options);
  assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 0); assert.equal(f.target.exitCode, 1);
  assert.doesNotMatch(f.state.text, /평가용 서버 종료 확인|평가용 서버 준비됨/);
  listenersCleared(f); noCredentials(f);
});

test('cancellation waits for pending preparation and never allocates a later fixture', async t => {
  timers(t); const f = fixture(), started = deferred(), pending = deferred();
  f.controls.prepare = () => { started.resolve(); return pending.promise; };
  const run = observeCompletion(runLocalP0Study(args('A'), f.options));
  await started.promise; f.target.emit('SIGINT'); await tick();
  assert.equal(run.done(), false); assert.equal(f.state.creates, 0);
  assert(f.target.listenerCount('SIGINT') > 0);
  pending.resolve(true); await run.completion;
  assert.equal(f.state.creates, 0); listenersCleared(f); noCredentials(f);
});

test('cancellation during fixture allocation awaits the returned owner and its actual close', async t => {
  timers(t); const f = fixture(), started = deferred(), pending = deferred(), closed = deferred();
  f.controls.create = () => { started.resolve(); return pending.promise; };
  f.controls.close = async () => { await closed.promise; f.sandbox.database.closed = true; };
  const run = observeCompletion(runLocalP0Study(args('A'), f.options));
  await started.promise; f.input.emit('data', Buffer.from('\n')); await tick();
  assert.equal(run.done(), false); assert.equal(f.state.closes, 0);
  pending.resolve(f.prepared); await tick();
  assert.equal(f.state.closes, 1); assert.equal(run.done(), false);
  assert.doesNotMatch(f.state.text, /평가용 서버 종료 확인|평가용 서버 준비됨/);
  noCredentials(f); closed.resolve(); await run.completion;
  assert.equal(f.sandbox.database.closed, true); listenersCleared(f);
});

test('synchronous stop from fixture creation closes the new owner without announcing ready', async t => {
  timers(t); const f = fixture();
  f.controls.create = () => { f.target.emit('SIGTERM'); return f.prepared; };
  await runLocalP0Study(args('A'), f.options);
  assert.equal(f.state.creates, 1); assert.equal(f.state.closes, 1);
  assert.doesNotMatch(f.state.text, /평가용 서버 준비됨/); listenersCleared(f); noCredentials(f);
});

test('q, empty Enter, Ctrl+C, SIGTERM and input EOF share owned cleanup', async t => {
  timers(t);
  for (const duration of [undefined, 120]) for (const stop of [f => f.input.emit('data', Buffer.from('q\n')), f => f.input.emit('data', Buffer.from('\r\n')),
    f => f.target.emit('SIGINT'), f => f.target.emit('SIGTERM'), f => f.input.emit('end')]) {
    const f = fixture(); f.controls.onReady = () => queueMicrotask(() => stop(f));
    await runLocalP0Study(args('A', duration), f.options);
    assert.equal(f.state.closes, 1); assert.equal(f.sandbox.database.closed, true);
    assert(f.state.text.includes(`준비를 포함해 최대 ${duration ?? 30}분입니다.`));
    assert.equal(f.state.errors, ''); assert.notEqual(f.target.exitCode, 1);
    assert.match(f.state.text, /평가용 서버 종료 확인/); listenersCleared(f); noPrivateErrors(f);
  }
});

test('default, explicit 30 and explicit 120 minutes allocate one exact deadline before preparation and report the selected limit', async t => {
  const clock = timers(t);
  for (const duration of [undefined, 30, 120]) {
    const f = fixture(), start = clock.created.length, minutes = duration ?? 30;
    f.controls.onReady = () => {};
    f.controls.prepare = () => {
      const deadlines = clock.created.slice(start).filter(timer => timer.kind === 'Timeout');
      assert.equal(deadlines.length, 1); assert.equal(deadlines[0].delay, minutes * 60 * 1000); return true;
    };
    const run = runLocalP0Study(args('A', duration), f.options); await f.state.ready.promise;
    const created = clock.created.slice(start), deadlines = created.filter(timer => timer.kind === 'Timeout');
    assert.equal(deadlines.length, 1); assert.equal(created.length, 2);
    assert.equal(created.find(timer => timer.kind === 'Interval').delay, 60_000);
    assert(f.state.text.includes(`준비를 포함해 최대 ${minutes}분입니다.`));
    deadlines[0].fire(); await run;
    assert.equal(clock.created.length, start + 2, 'The deadline is not renewed.');
    assert(created.every(timer => timer.cleared)); assert.equal(f.target.exitCode, 1);
    assert.equal(f.state.closes, 1); assert.match(f.state.text, /평가용 서버 종료 확인/);
    assert(f.state.errors.includes(`${minutes}분 준비·평가 시간이 끝났습니다.`));
    assert.match(f.state.text, /자동 (?:수집|판정)하지/);
    assert.doesNotMatch(f.state.text, /개선율\s*[:=]\s*\d|완료율\s*[:=]\s*\d/);
    listenersCleared(f); noPrivateErrors(f);
  }
});

test('the 120-minute deadline includes pending preparation and cannot allocate a fixture after expiration', async t => {
  const clock = timers(t), f = fixture(), started = deferred(), pending = deferred();
  f.controls.prepare = () => { started.resolve(); return pending.promise; };
  const run = observeCompletion(runLocalP0Study(args('A', 120), f.options));
  await started.promise;
  const deadline = clock.created.find(timer => timer.kind === 'Timeout');
  assert.equal(deadline.delay, 120 * 60 * 1000); deadline.fire(); await tick();
  assert.equal(run.done(), false); assert.equal(f.state.creates, 0);
  pending.resolve(true); await run.completion;
  assert.equal(f.state.creates, 0); assert.equal(f.state.credentialsRead, 0);
  assert.match(f.state.errors, /120분 준비·평가 시간이 끝났습니다/);
  assert.doesNotMatch(f.state.text, /평가용 서버 준비됨|평가용 서버 종료 확인/);
  listenersCleared(f); noCredentials(f);
});

test('extended manual stop and deadline expiration both retain cleanup ownership until an explicit retry succeeds', async t => {
  const clock = timers(t);
  for (const stopKind of ['manual', 'deadline']) {
    const f = fixture(), firstClose = deferred(); let attempts = 0;
    f.controls.onReady = () => {};
    f.controls.close = () => {
      if (++attempts === 1) { firstClose.resolve(); throw Error(privateDetail); }
      f.sandbox.database.closed = true;
    };
    const start = clock.created.length, run = observeCompletion(runLocalP0Study(args('A', 120), f.options));
    await f.state.ready.promise;
    const deadline = clock.created.slice(start).find(timer => timer.kind === 'Timeout');
    assert.equal(deadline.delay, 120 * 60 * 1000);
    if (stopKind === 'deadline') deadline.fire(); else f.input.emit('data', Buffer.from('q\n'));
    await firstClose.promise; await tick();
    assert.equal(run.done(), false); assert.equal(f.state.closes, 1); assert.equal(f.sandbox.database.closed, false);
    assert(f.target.listenerCount('SIGINT') > 0); assert(clock.active.size > 0);
    assert.doesNotMatch(f.state.text, /평가용 서버 종료 확인/); noPrivateErrors(f);
    f.target.emit('SIGINT'); await run.completion;
    assert.equal(f.state.closes, 2); assert.equal(f.sandbox.database.closed, true);
    assert.match(f.state.text, /평가용 서버 종료 확인/);
    assert.equal(clock.created.length, start + 2); listenersCleared(f); noPrivateErrors(f);
  }
});

test('cleanup failure keeps run and signal ownership alive until a successful Ctrl+C retry', async t => {
  const clock = timers(t), f = fixture(), firstClose = deferred(); let attempts = 0;
  f.controls.close = () => {
    if (++attempts === 1) { firstClose.resolve(); throw Error(privateDetail); }
    f.sandbox.database.closed = true;
  };
  const run = observeCompletion(runLocalP0Study(args('A'), f.options));
  await firstClose.promise; await tick();
  assert.equal(run.done(), false); assert.equal(f.sandbox.database.closed, false);
  assert.equal(f.state.closes, 1); assert.notEqual(f.state.errors, '');
  assert(f.target.listenerCount('SIGINT') > 0); assert(f.target.listenerCount('SIGTERM') > 0);
  assert(clock.active.size > 0); assert.doesNotMatch(f.state.text, /평가용 서버 종료 확인/); noPrivateErrors(f);
  f.target.emit('SIGINT'); await run.completion;
  assert.equal(f.state.closes, 2); assert.equal(f.sandbox.database.closed, true);
  assert.match(f.state.text, /평가용 서버 종료 확인/); listenersCleared(f); noPrivateErrors(f);
});

test('a resolved close without database.closed is not accepted as confirmed cleanup', async t => {
  timers(t); const f = fixture(), firstClose = deferred(); let attempts = 0;
  f.controls.close = () => { if (++attempts === 1) firstClose.resolve(); else f.sandbox.database.closed = true; };
  const run = observeCompletion(runLocalP0Study(args('A'), f.options));
  await firstClose.promise; await tick();
  assert.equal(run.done(), false); assert.doesNotMatch(f.state.text, /평가용 서버 종료 확인/);
  assert(f.target.listenerCount('SIGINT') > 0); noPrivateErrors(f);
  f.target.emit('SIGINT'); await run.completion;
  assert.equal(f.state.closes, 2); listenersCleared(f);
});

test('unrelated signal listeners survive normal CLI cleanup', async t => {
  timers(t); const f = fixture(), existing = () => {};
  f.target.on('SIGINT', existing); f.input.on('data', existing);
  await runLocalP0Study(args('A'), f.options);
  assert.deepEqual(f.target.listeners('SIGINT'), [existing]); assert.deepEqual(f.input.listeners('data'), [existing]);
  f.target.off('SIGINT', existing); f.input.off('data', existing); listenersCleared(f);
});
