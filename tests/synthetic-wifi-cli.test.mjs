import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runSyntheticWifiApi, syntheticWifiCliOptions } from '../scripts/synthetic-wifi-api.mjs';

const args = ['--host', '10.231.9.10', '--peer', '10.231.9.20', '--interface-index', '8', '--confirm-private-wifi',
  '--base', 'E:\\CarebridgeBeta', '--powershell', 'C:\\Tools\\pwsh.exe', '--confirm-synthetic-e-drive'];
const blockRule = 'TCP Query User{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}C:\\Fixture\\node.exe';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(patch = {}) {
  const input = Object.assign(new EventEmitter(), { isTTY: true, pause() {} }), target = new EventEmitter();
  const done = deferred(), stopped = deferred(), leaseDone = deferred();
  const state = { calls: [], text: '', errors: '', phase: 'ready', forgotten: 0, credentialsRead: 0, diagnostics: [] };
  const material = { key: Buffer.alloc(256, 65), cert: Buffer.alloc(256, 66), publicCertificate: Buffer.alloc(128),
    fingerprint: 'a'.repeat(64), expiresAt: '2026-01-02T00:00:00Z' };
  const output = { isTTY: true, write(text) { state.text += text;
    if (text.includes('r + Enter')) queueMicrotask(() => input.emit('data', Buffer.from('q\n'))); } };
  const session = { ready: Promise.resolve({ origin: 'https://10.231.9.10:8443' }), status: () => ({ phase: state.phase }),
    forgetCredentials() { state.forgotten++; }, get credentials() { state.credentialsRead++; return [
      { role: 'therapist', email: 'synthetic@carebridge.test', password: 'SYNTHETIC_ONCE' },
    ]; }, restartApi: async () => ({ origin: 'https://10.231.9.10:8443' }), waitForStop: () => stopped.promise,
    close: async () => { state.calls.push('session-close'); state.phase = 'stopped'; stopped.resolve({ stopped: true }); return { stopped: true }; } };
  const lease = { ready: Promise.resolve(), waitForStop: () => leaseDone.promise,
    diagnostics: Object.freeze({ schema:1, observationOnly:true, state:'removed', preflight:'passed', ready:'active', failureReason:null,
      readyDeadlineExpired:false, lifetimeExpired:false, cleanupDeadlineExpired:false, everActive:true,
      stopRequested:true, cleanup:'confirmed', observedStage:'removed', launcher:null }),
    close: async () => { state.calls.push('lease-close'); leaseDone.resolve({ removed: true }); return { removed: true }; } };
  const runtime = async () => ({
    generateSyntheticWifiCertificate: async () => { state.calls.push('certificate'); return material; },
    createSyntheticWifiLease(options) { state.calls.push('lease'); state.leaseOptions = options; assert.equal(options.maxLifetimeSeconds, 7200); return lease; },
    createWindowsSyntheticWifiSession(options) { state.calls.push('session'); assert(options.key.equals(Buffer.alloc(256, 65))); return session; },
    ...patch,
  });
  const config = { input, output, target, diagnostic: { write(text) { state.errors += text; } }, runtime,
    publish: async value => { assert.equal(value, material); state.calls.push('public-certificate'); return 'C:\\Synthetic\\root.cer'; },
    persistDiagnostic: async (event, snapshot) => { state.diagnostics.push({ event, snapshot }); return 'C:\\Synthetic\\diagnostic.json'; } };
  return { input, output, target, session, lease, leaseDone, material, state, config, done };
}

test('Wi-Fi CLI captures only an explicit, ephemeral, single-peer configuration', () => {
  const value = syntheticWifiCliOptions(args);
  assert.equal(value.network.port, 8443); assert.equal(value.interfaceIndex, 8);
  assert(Object.isFrozen(value)); assert(Object.isFrozen(value.postgresArgs));
  for (const invalid of [[], args.slice(1), [...args, '--create-resumable'],
    args.map((v, i) => i === 1 ? '0.0.0.0' : v), args.map((v, i) => i === 3 ? args[1] : v),
    args.map((v, i) => i === 5 ? '-1' : v), args.map((v, i) => i === 6 ? '--yes' : v),
    args.map((v, i) => i === 8 ? 'C:\\Production' : v)])
    assert.throws(() => syntheticWifiCliOptions(invalid), /SYNTHETIC_WIFI_CLI_CONFIGURATION/);
});

test('noninteractive Wi-Fi invocation never imports a runtime or requests elevation', async () => {
  const f = fixture(); f.input.isTTY = false;
  await runSyntheticWifiApi(args, f.config);
  assert.equal(f.target.exitCode, 1); assert.deepEqual(f.state.calls, []); assert.equal(f.state.credentialsRead, 0);
});

test('TCP block exception requires one explicit exact application-query rule name', () => {
  assert.equal(Object.hasOwn(syntheticWifiCliOptions(args), 'temporaryTcpBlockRule'), false);
  const value = syntheticWifiCliOptions([...args, '--temporary-tcp-block-rule', blockRule]);
  assert.equal(value.temporaryTcpBlockRule, blockRule);
  for (const extra of [[], [''], ['*'], ['node.exe'], [blockRule, '--yes'],
    [blockRule.replace('node.exe', 'other.exe')], [blockRule.replace('C:\\Fixture', 'C:\\Fixture\\..')]]) {
    assert.throws(() => syntheticWifiCliOptions([...args, '--temporary-tcp-block-rule', ...extra]), /SYNTHETIC_WIFI_CLI_CONFIGURATION/);
  }
  assert.throws(() => syntheticWifiCliOptions([...args, '--allow-all', blockRule]), /SYNTHETIC_WIFI_CLI_CONFIGURATION/);
});

test('opt-in is passed only to the firewall owner and explains conditional restoration', async () => {
  const f = fixture(); await runSyntheticWifiApi([...args, '--temporary-tcp-block-rule', blockRule], f.config);
  assert.equal(f.state.leaseOptions.temporaryTcpBlockRule, blockRule);
  assert.match(f.state.text, /다른 포트·주소의 차단을 유지/);
  assert.equal(f.state.errors, '');
});

test('approved CLI owns lease before session, shows credentials once, and closes both boundaries', async () => {
  const f = fixture(); await runSyntheticWifiApi(args, f.config);
  assert.deepEqual(f.state.calls.slice(0, 4), ['certificate', 'public-certificate', 'lease', 'session']);
  assert(f.state.calls.includes('lease-close')); assert(f.state.calls.includes('session-close'));
  assert.equal(f.state.credentialsRead, 1); assert.equal(f.state.text.split('SYNTHETIC_ONCE').length, 2);
  assert.equal(f.state.errors, ''); assert(f.material.key.every(value => value === 0));
  assert.equal(Object.hasOwn(f.state.leaseOptions, 'temporaryTcpBlockRule'), false);
  assert.equal(f.target.listenerCount('SIGINT'), 0); assert.equal(f.input.listenerCount('data'), 0);
  assert.match(f.state.text, /전체 종료 후 재개되지 않습니다/);
  assert.match(f.state.text, /인증서 유효기한\(UTC\)/); assert.doesNotMatch(f.state.text, /인증서 만료\(UTC\)/);
  assert.deepEqual(f.state.diagnostics.map(row => row.event), ['cleanup-confirmed']);
});

test('failed certificate generation never opens a firewall or session', async () => {
  const f = fixture({ generateSyntheticWifiCertificate: async () => { throw Error('PRIVATE_INTERNAL'); } });
  await runSyntheticWifiApi(args, f.config);
  assert.equal(f.target.exitCode, 1); assert.deepEqual(f.state.calls, []);
  assert.doesNotMatch(f.state.errors, /PRIVATE_INTERNAL/);
});

test('failed lease readiness is still owned and closed; no API allocated', async () => {
  const f = fixture(); f.lease.ready = Promise.reject(Error('PRIVATE_RULE'));
  await runSyntheticWifiApi(args, f.config);
  assert(f.state.calls.includes('lease-close')); assert(!f.state.calls.includes('session'));
  assert.equal(f.state.credentialsRead, 0); assert.equal(f.target.exitCode, 1);
  assert(f.material.key.every(value => value === 0)); assert.doesNotMatch(f.state.errors, /PRIVATE_RULE/);
});

test('failed API startup closes both owners and never displays a password', async () => {
  const f = fixture(); f.session.ready = Promise.reject(Error('PRIVATE_DB'));
  await runSyntheticWifiApi(args, f.config);
  assert(f.state.calls.includes('lease-close')); assert(f.state.calls.includes('session-close'));
  assert.equal(f.state.credentialsRead, 0); assert.equal(f.target.exitCode, 1);
  assert.doesNotMatch(f.state.errors + f.state.text, /PRIVATE_DB|SYNTHETIC_ONCE/);
});

test('stop while preparing certificate prevents all later allocations', async () => {
  const f = fixture(); f.config.publish = async () => { f.target.emit('SIGINT'); return 'C:\\Synthetic\\root.cer'; };
  await runSyntheticWifiApi(args, f.config);
  assert(!f.state.calls.includes('lease')); assert(!f.state.calls.includes('session'));
  assert(f.material.key.every(value => value === 0)); assert.equal(f.state.errors, '');
});

test('Ctrl+C immediately cancels an owned lease still waiting for UAC readiness', async () => {
  const f = fixture(), pending = deferred(), owned = deferred();
  f.lease.ready = pending.promise;
  f.lease.close = async () => { f.state.calls.push('lease-close'); pending.reject(Error('CANCELLED')); };
  const original = f.config.runtime;
  f.config.runtime = async () => {
    const runtime = await original(), create = runtime.createSyntheticWifiLease;
    runtime.createSyntheticWifiLease = options => { const lease = create(options); owned.resolve(); return lease; };
    return runtime;
  };
  const run = runSyntheticWifiApi(args, f.config);
  await owned.promise; f.target.emit('SIGINT'); await run;
  assert(f.state.calls.includes('lease-close')); assert(!f.state.calls.includes('session'));
  assert.equal(f.target.listenerCount('SIGINT'), 0); assert.equal(f.state.errors, '');
});

test('uncertain close keeps signal ownership and retry, while still stopping the API', async () => {
  const f = fixture(); let attempts = 0;
  f.lease.close = () => { if (++attempts === 1) throw Error('PRIVATE_CLOSE'); return Promise.resolve({ removed: true }); };
  await runSyntheticWifiApi(args, f.config);
  assert(f.state.calls.includes('session-close')); assert(f.target.listenerCount('SIGINT') > 0);
  assert.doesNotMatch(f.state.text, /시험 종료:/); assert.doesNotMatch(f.state.errors, /PRIVATE_CLOSE/);
  f.target.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2); assert.equal(f.target.listenerCount('SIGINT'), 0);
  assert.deepEqual(f.state.diagnostics.map(row => row.event), ['cleanup-unconfirmed', 'cleanup-confirmed']);
});

test('preparation stop is not reported as loss of an already running API', async () => {
  const f = fixture(), pending = deferred();
  f.lease.ready = pending.promise;
  f.lease.waitForStop = () => Promise.resolve({ stage:'failed' });
  f.lease.close = async () => { f.state.calls.push('lease-close'); pending.reject(Error('PRIVATE_APPROVAL')); };
  await runSyntheticWifiApi(args, f.config);
  assert(!f.state.calls.includes('session')); assert.equal(f.state.credentialsRead, 0);
  assert.match(f.state.errors, /관리자 요청·방화벽 준비를 확인하지 못해 중단/);
  assert.doesNotMatch(f.state.errors, /실행 중|PRIVATE_APPROVAL/);
  assert.equal(f.target.exitCode, 1);
});

test('an active lease failure stops the owned API and uses the runtime boundary message', async () => {
  const f = fixture();
  f.output.write = text => {
    f.state.text += text;
    if (text.includes('r + Enter')) queueMicrotask(() => f.leaseDone.resolve({ stage:'failed' }));
  };
  await runSyntheticWifiApi(args, f.config);
  assert(f.state.calls.includes('session')); assert(f.state.calls.includes('session-close'));
  assert.match(f.state.errors, /실행 중 방화벽 시험 경계를 유지하지 못해/);
  assert.doesNotMatch(f.state.errors, /앱과 DB는 시작하지 않았습니다/);
});

test('diagnostic IO failure never exposes errors or changes cleanup and signal ownership', async () => {
  const f = fixture();
  f.config.persistDiagnostic = async () => { throw Error('PRIVATE_DIAGNOSTIC_KEY'); };
  await runSyntheticWifiApi(args, f.config);
  assert.equal(f.state.phase, 'stopped'); assert(f.state.calls.includes('lease-close'));
  assert.equal(f.target.listenerCount('SIGINT'), 0); assert.equal(f.target.exitCode, undefined);
  assert.match(f.state.text, /시험 종료:/); assert.match(f.state.errors, /진단 파일을 저장하지 못했습니다/);
  assert.doesNotMatch(f.state.text + f.state.errors, /PRIVATE_DIAGNOSTIC_KEY/);
});

test('diagnostic failures cannot hide an unconfirmed cleanup and retries remain available', async () => {
  const f = fixture(); let attempts = 0, writes = 0;
  f.lease.close = async () => { if (++attempts < 3) throw Error('PRIVATE_CLOSE'); };
  f.config.persistDiagnostic = async () => { writes++; throw Error('PRIVATE_LOG'); };
  await runSyntheticWifiApi(args, f.config);
  assert.equal(writes, 1); assert(f.target.listenerCount('SIGINT') > 0);
  assert.doesNotMatch(f.state.text, /시험 종료:/);
  f.target.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1); assert(f.target.listenerCount('SIGINT') > 0);
  f.target.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3); assert.equal(writes, 2); assert.equal(f.target.listenerCount('SIGINT'), 0);
  assert.match(f.state.text, /시험 종료:/); assert.doesNotMatch(f.state.errors, /PRIVATE_CLOSE|PRIVATE_LOG/);
});

test('stalled diagnostic IO cannot delay cleanup status or prevent a retry', async t => {
  for (const uncertain of [false, true]) await t.test(uncertain ? 'unconfirmed then retry' : 'confirmed', async () => {
    const f = fixture(), blocked = deferred(), started = deferred(); let attempts = 0;
    f.lease.close = async () => { if (++attempts === 1 && uncertain) throw Error('PRIVATE_CLOSE'); };
    f.config.persistDiagnostic = () => { started.resolve(); return blocked.promise; };
    const run = runSyntheticWifiApi(args, f.config); let returned = false;
    void run.then(() => { returned = true; });
    try {
      await started.promise; await new Promise(resolve => setImmediate(resolve));
      assert.equal(returned, true); assert.equal(f.state.phase, 'stopped');
      if (uncertain) {
        assert.match(f.state.errors, /종료가 아직 확인되지 않았습니다/);
        assert.doesNotMatch(f.state.text, /시험 종료:/);
        assert(f.target.listenerCount('SIGINT') > 0);
        f.target.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve));
        assert.equal(attempts, 2);
      }
      assert.equal(f.target.listenerCount('SIGINT'), 0); assert.match(f.state.text, /시험 종료:/);
    } finally {
      // Release only the test-owned promise, even if this regression fails.
      blocked.resolve('C:\\Synthetic\\diagnostic.json'); await run;
      if (f.target.listenerCount('SIGINT')) {
        f.target.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve));
      }
    }
  });
});

test('late diagnostic rejection is handled without changing confirmed cleanup or exit status', async () => {
  const f = fixture(), blocked = deferred();
  f.config.persistDiagnostic = () => blocked.promise;
  await runSyntheticWifiApi(args, f.config);
  assert.match(f.state.text, /시험 종료:/); assert.equal(f.target.exitCode, undefined);
  blocked.reject(Error('PRIVATE_LATE_DIAGNOSTIC'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.state.errors, /진단 파일을 저장하지 못했습니다/);
  assert.doesNotMatch(f.state.errors, /PRIVATE_LATE_DIAGNOSTIC/);
  assert.equal(f.target.exitCode, undefined); assert.equal(f.target.listenerCount('SIGINT'), 0);
});
