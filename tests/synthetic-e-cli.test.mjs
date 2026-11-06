// CLI contract doubles plus a credential-free Node child for event-loop
// lifetime only. No E files, services, Docker or native inspection are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { runSyntheticEApi } from '../scripts/synthetic-e-api.mjs';

// Contract tests never leave a real keepalive behind if an assertion fails.
// The isolated child below retains real timers to prove actual process life.
test.beforeEach(t => {
  const active = new Set();
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    const timer = { callback, delay, referenced: true, cleared: false,
      ref() { this.referenced = true; return this; }, unref() { this.referenced = false; return this; },
      hasRef() { return this.referenced && !this.cleared; } };
    active.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => {
    if (timer !== undefined) { assert(active.has(timer)); timer.cleared = true; active.delete(timer); }
  });
  t.after(() => assert.equal(active.size, 0, 'The CLI must release its own lifetime anchor after confirmed cleanup.'));
});

const args = ['--base', 'E:\\SyntheticOnly', '--powershell', 'C:\\SyntheticOnly\\pwsh.exe', '--confirm-synthetic-e-drive'];
const secret = 'SYNTHETIC_PASSWORD_SENTINEL', privateDetail = 'PRIVATE_ERROR_PATH_E:\\DO_NOT_PRINT';
const tick = () => new Promise(resolve => setImmediate(resolve));
function io({ inputTTY = true, outputTTY = true } = {}) {
  const stdout = [], stderr = [], target = new EventEmitter();
  const input = { isTTY: inputTTY }, output = { isTTY: outputTTY, write: value => { stdout.push(String(value)); return true; } };
  const diagnostic = { write: value => { stderr.push(String(value)); return true; } };
  return { input, output, diagnostic, target, stdout, stderr,
    text: () => stdout.join(''), errors: () => stderr.join('') };
}
function fixture() {
  const ready = Promise.withResolvers(), stopped = Promise.withResolvers(); ready.promise.catch(() => {}); stopped.promise.catch(() => {});
  let phase = 'starting', failed = false, closeCalls = 0, forgotten = 0, credentialsRead = 0;
  const credentials = [{ role: 'therapist', email: 'therapist@synthetic.test', password: secret },
    { role: 'guardian', email: 'guardian@synthetic.test', password: secret + '_GUARDIAN' }];
  let closeWork = () => { phase = 'stopping'; return stopped.promise; };
  const session = { ready: ready.promise, close() { closeCalls++; return closeWork(); },
    status: () => ({ phase, failed }), waitForStop: () => stopped.promise,
    forgetCredentials() { forgotten++; for (const value of credentials) { value.email = ''; value.password = ''; } credentials.length = 0; } };
  Object.defineProperty(session, 'credentials', { get() { credentialsRead++; return credentials; } });
  return { session, ready, stopped, closeCalls: () => closeCalls, forgotten: () => forgotten, credentialsRead: () => credentialsRead,
    prepare() { phase = 'ready'; ready.resolve({ origin: 'http://127.0.0.1:12345' }); },
    rejectStart({ failed: failure = true } = {}) { failed = failure; ready.reject(Error(privateDetail)); },
    finish({ failed: failure = failed } = {}) { failed = failure; phase = 'stopped'; stopped.resolve({ stopped: true, failed }); },
    closeWith(work) { closeWork = work; }, phase: value => { phase = value; } };
}
function start(f, streams, create = () => f.session) {
  return runSyntheticEApi(args, { ...streams, create });
}
function listenersCleared(streams) {
  assert.equal(streams.target.listenerCount('SIGINT'), 0); assert.equal(streams.target.listenerCount('SIGTERM'), 0);
}
function privateErrorsAbsent(streams) {
  assert.equal(streams.errors().includes(secret), false); assert.equal(streams.errors().includes(privateDetail), false);
  assert.equal(streams.text().includes(privateDetail), false);
}

test('TTY refusal never creates a session or registers signal listeners', async () => {
  for (const options of [{ inputTTY: false }, { outputTTY: false }, { inputTTY: false, outputTTY: false }]) {
    const streams = io(options); let creates = 0;
    await runSyntheticEApi(args, { ...streams, create: () => { creates++; throw Error(privateDetail); } });
    assert.equal(creates, 0); assert.equal(streams.target.exitCode, 1); assert.equal(streams.text(), '');
    assert.equal(setInterval.mock.calls.length, 0);
    assert.match(streams.errors(), /대화형 터미널/); listenersCleared(streams); privateErrorsAbsent(streams);
  }
});

test('invalid CLI arguments never create a session or echo supplied paths and secrets', async () => {
  const streams = io(); let creates = 0;
  await runSyntheticEApi(['--password', secret, privateDetail], { ...streams, create: () => { creates++; } });
  assert.equal(creates, 0); assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
  assert.equal(setInterval.mock.calls.length, 0);
});

test('only preparation text appears before ready and signals are registered before create', async () => {
  const f = fixture(), streams = io();
  const running = start(f, streams, () => {
    assert.equal(streams.target.listenerCount('SIGINT'), 1); assert.equal(streams.target.listenerCount('SIGTERM'), 1); return f.session;
  });
  await tick(); assert.match(streams.text(), /준비합니다/); assert.equal(streams.text().includes('준비 완료'), false);
  assert.equal(streams.text().includes('http://'), false); assert.equal(f.credentialsRead(), 0); assert.equal(f.forgotten(), 0);
  f.prepare(); await tick(); f.finish(); await running; listenersCleared(streams);
});

test('ready credentials go only to the direct TTY and are forgotten before waiting for stop', async () => {
  const f = fixture(), streams = io(), running = start(f, streams);
  f.prepare(); await tick();
  assert.match(streams.text(), /준비 완료: http:\/\/127\.0\.0\.1:12345/);
  assert.ok(streams.text().includes('therapist@synthetic.test')); assert.ok(streams.text().includes('guardian@synthetic.test'));
  assert.ok(streams.text().includes(secret)); assert.equal(f.forgotten(), 1); assert.equal(f.credentialsRead(), 1);
  assert.equal(streams.errors(), ''); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  f.finish(); await running; assert.match(streams.text(), /DB를 종료했습니다/); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('ready SIGINT waits for actual stop before announcing cleanup or removing signal ownership', async () => {
  const f = fixture(), streams = io(); let done = false;
  const running = start(f, streams).then(() => { done = true; }); f.prepare(); await tick(); streams.target.emit('SIGINT');
  await tick(); assert.equal(f.closeCalls(), 1); assert.equal(done, false); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  assert.equal(streams.target.listenerCount('SIGINT'), 1); f.finish(); await running;
  assert.equal(streams.target.exitCode, undefined); assert.match(streams.text(), /DB를 종료했습니다/); listenersCleared(streams);
});

test('SIGTERM follows the same owned stop path without exposing private diagnostics', async () => {
  const f = fixture(), streams = io(), running = start(f, streams); f.prepare(); await tick(); streams.target.emit('SIGTERM');
  await tick(); assert.equal(f.closeCalls(), 1); f.finish(); await running; listenersCleared(streams); privateErrorsAbsent(streams);
});

test('SIGINT raised inside create is applied to the newly returned handle and normal cancellation is not a failure', async () => {
  const f = fixture(), streams = io();
  const running = start(f, streams, () => { streams.target.emit('SIGINT'); return f.session; });
  await tick(); assert.equal(f.closeCalls(), 1); f.rejectStart({ failed: false }); await tick();
  assert.equal(streams.text().includes(secret), false); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  f.finish({ failed: false }); await running;
  assert.equal(streams.target.exitCode, undefined); assert.equal(f.credentialsRead(), 0); listenersCleared(streams);
});

test('late ready after initial cancellation never prints credentials and still awaits actual stop', async () => {
  const f = fixture(), streams = io(); let done = false;
  const running = start(f, streams).then(() => { done = true; }); streams.target.emit('SIGINT'); f.prepare(); await tick();
  assert.equal(done, false); assert.equal(f.credentialsRead(), 0); assert.equal(streams.text().includes('준비 완료'), false);
  f.finish(); await running; listenersCleared(streams);
});

test('create throw is redacted and removes only the CLI listeners', async () => {
  const streams = io(), other = () => {}; streams.target.on('SIGINT', other);
  await start(null, streams, () => { throw Error(privateDetail); });
  assert.equal(streams.target.exitCode, 1); assert.deepEqual(streams.target.listeners('SIGINT'), [other]);
  assert.equal(setInterval.mock.calls.length, 1); assert.equal(setInterval.mock.calls[0].result.cleared, true);
  assert.equal(streams.target.listenerCount('SIGTERM'), 0); privateErrorsAbsent(streams);
});

test('failed readiness retains the same handle and never announces success before confirmed cleanup', async () => {
  const f = fixture(), streams = io(); let done = false;
  const running = start(f, streams).then(() => { done = true; }); f.rejectStart(); await tick();
  assert.equal(done, false); assert.equal(f.closeCalls(), 1); assert.equal(f.credentialsRead(), 0);
  assert.equal(streams.text().includes('DB를 종료했습니다'), false); assert.equal(streams.target.listenerCount('SIGINT'), 1);
  f.finish({ failed: true }); await running; assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('failed close preserves the signal-owned handle and a later same-handle retry cleans listeners', async () => {
  const f = fixture(), streams = io(); let creates = 0;
  f.closeWith(() => { f.phase('stop-unconfirmed'); return Promise.reject(Error(privateDetail)); });
  const running = start(f, streams, () => { creates++; return f.session; }); f.rejectStart(); await running;
  assert.equal(streams.target.listenerCount('SIGINT'), 1); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  assert.match(streams.errors(), /보존/); assert.equal(f.closeCalls(), 1);
  f.closeWith(() => { f.finish({ failed: true }); return f.stopped.promise; }); streams.target.emit('SIGINT'); await tick();
  assert.equal(creates, 1); assert.equal(f.closeCalls(), 2); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('credential output failure still explicitly forgets credentials and retains cleanup ownership', async () => {
  const f = fixture(), streams = io(), write = streams.output.write;
  streams.output.write = value => { if (value.includes('시험 비밀번호')) throw Error(privateDetail); return write(value); };
  const running = start(f, streams); f.prepare(); await tick();
  assert.equal(f.forgotten(), 1); assert.equal(f.closeCalls(), 1); assert.equal(streams.target.listenerCount('SIGINT'), 1);
  f.finish({ failed: true }); await running; assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('TTY eligibility is rechecked after asynchronous setup before any credential access', async () => {
  const f = fixture(), streams = io(), running = start(f, streams);
  streams.output.isTTY = false; f.prepare(); await tick();
  assert.equal(f.credentialsRead(), 0); assert.equal(streams.text().includes(secret), false);
  f.finish({ failed: true }); await running; assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('a failed runtime may confirm cleanup, but does not become a successful CLI result', async () => {
  const f = fixture(), streams = io(), running = start(f, streams); f.prepare(); await tick(); f.finish({ failed: true });
  await running; assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('repeated stop signals share the pending attempt and print the actual completion message once', async () => {
  const f = fixture(), streams = io(), running = start(f, streams); f.prepare(); await tick();
  streams.target.emit('SIGINT'); streams.target.emit('SIGINT'); streams.target.emit('SIGTERM'); await tick();
  assert.equal(f.closeCalls(), 1); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  f.finish(); await running; assert.equal(streams.text().split('DB를 종료했습니다').length - 1, 1); listenersCleared(streams);
});

test('a result without actual stopped state cannot announce successful cleanup', async () => {
  const f = fixture(), streams = io(); f.session.waitForStop = () => Promise.resolve({ failed: false });
  const running = start(f, streams); f.prepare(); await tick();
  assert.equal(streams.text().includes('DB를 종료했습니다'), false); assert.equal(f.closeCalls(), 1);
  assert.equal(streams.target.listenerCount('SIGINT'), 1); f.finish({ failed: true }); await running;
  assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('synchronous close failure retains ownership and a same-handle retry can finish later', async () => {
  const f = fixture(), streams = io(); f.closeWith(() => { f.phase('stop-unconfirmed'); throw Error(privateDetail); });
  const running = start(f, streams); f.rejectStart(); await running;
  assert.equal(streams.target.listenerCount('SIGINT'), 1); assert.equal(f.closeCalls(), 1); privateErrorsAbsent(streams);
  f.closeWith(() => { f.finish({ failed: true }); return f.stopped.promise; }); streams.target.emit('SIGTERM'); await tick();
  assert.equal(f.closeCalls(), 2); listenersCleared(streams);
});

test('partial signal registration failure never creates a session and removes the already registered listener', async () => {
  const streams = io(), original = streams.target.on; let creates = 0;
  streams.target.on = function(name, listener) { if (name === 'SIGTERM') throw Error(privateDetail); return original.call(this, name, listener); };
  await start(null, streams, () => { creates++; });
  assert.equal(creates, 0); assert.equal(streams.target.exitCode, 1); listenersCleared(streams); privateErrorsAbsent(streams);
});

test('a broken diagnostic sink never leaks its error or allocates resources after TTY refusal', async () => {
  const streams = io({ inputTTY: false }); let creates = 0;
  streams.target.exitCode = 7; streams.diagnostic.write = () => { throw Error(privateDetail); };
  await runSyntheticEApi(args, { ...streams, create: () => { creates++; } });
  assert.equal(creates, 0); assert.equal(streams.target.exitCode, 7); listenersCleared(streams);
});

test('referenced ownership survives failed cleanup without automatically retrying work', async () => {
  const f = fixture(), streams = io(); let anchor;
  f.closeWith(() => { f.phase('stop-unconfirmed'); return Promise.reject(Error(privateDetail)); });
  const running = start(f, streams, () => {
    assert.equal(setInterval.mock.calls.length, 1); anchor = setInterval.mock.calls[0].result;
    assert.equal(anchor.hasRef(), true); return f.session;
  });
  f.rejectStart(); await running;
  assert.equal(anchor.hasRef(), true); assert.equal(f.closeCalls(), 1);
  anchor.callback(); await tick();
  assert.equal(f.closeCalls(), 1); assert.equal(streams.text().includes('DB를 종료했습니다'), false);
  f.closeWith(() => { f.finish({ failed: true }); return f.stopped.promise; });
  streams.target.emit('SIGINT'); await tick();
  assert.equal(f.closeCalls(), 2); assert.equal(anchor.cleared, true); assert.equal(anchor.hasRef(), false);
  listenersCleared(streams); privateErrorsAbsent(streams);
});

for (const prepared of [false, true]) {
test(`resource-free failed cleanup ${prepared ? 'after readiness' : 'during startup'} keeps the real process alive for an explicit same-handle retry`, async () => {
  const cli = new URL('../scripts/synthetic-e-api.mjs', import.meta.url).href;
  const source = `
    import { runSyntheticEApi } from ${JSON.stringify(cli)};
    let phase='starting', closeCalls=0, retryObserved=false, completed=0, warnings=0;
    const stopped=Promise.withResolvers();
    const session={ready:${prepared ? "Promise.resolve({origin:'http://127.0.0.1:12345'})" : "Promise.reject(Error('SYNTHETIC_START_FAILURE'))"},credentials:[],forgetCredentials(){},
      status:()=>({phase,failed:true}),waitForStop:()=>stopped.promise,
      close(){closeCalls++;if(closeCalls===1){phase='stop-unconfirmed';return Promise.reject(Error('SYNTHETIC_CLOSE_FAILURE'));}
        phase='stopped';const result={stopped:true,failed:true};stopped.resolve(result);return Promise.resolve(result);}};
    const output={isTTY:true,write(text){if(text.includes('DB를 종료했습니다'))completed++;return true;}};
    const diagnostic={write(){warnings++;return true;}};
    // This timer cannot keep the child alive. No IPC, stdin read, sockets,
    // fixture process or other referenced handle can impersonate ownership.
    ${prepared ? "setTimeout(()=>process.emit('SIGINT'),10).unref();" : ''}
    setTimeout(()=>{retryObserved=true;process.emit('SIGINT');},100).unref();
    await runSyntheticEApi(${JSON.stringify(args)},{input:{isTTY:true},output,diagnostic,target:process,create:()=>session});
    process.on('exit',()=>process.stdout.write(JSON.stringify({retryObserved,closeCalls,completed,warnings,
      phase,listeners:process.listenerCount('SIGINT')+process.listenerCount('SIGTERM')})+'\\n'));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
  });
  let stdout = '', stderrBytes = 0, timedOut = false, exitSeen = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.on('exit', () => { exitSeen = true; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Failure containment owns only this fresh, resource-free child. This
  // parent timer is not inherited and cannot keep the child's loop alive.
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
  let result;
  try { result = await closed; } finally { clearTimeout(timeout); }
  assert.equal(timedOut, false); assert.equal(exitSeen, true);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(stderrBytes, 0); assert.equal(result.signal, null); assert.equal(result.code, 1);
  const evidence = JSON.parse(stdout.trim());
  assert.deepEqual(evidence, { retryObserved: true, closeCalls: 2, completed: 1, warnings: prepared ? 1 : 2, phase: 'stopped', listeners: 0 });
});
}
