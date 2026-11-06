import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getSystemErrorMap } from 'node:util';
import { privateSecretEnvironment } from '../server/windows-private-secret-io.mjs';
import { createAdminTaskObservation, syntheticWifiAdminTaskScripts, syntheticWifiAdminTaskFailurePhases } from './synthetic-wifi-admin-task-observer.mjs';

const moduleFile = fileURLToPath(new URL('./synthetic-wifi-admin-task-observer.mjs', import.meta.url));
const moduleSource = await fs.readFile(moduleFile, 'utf8');
const shapeFile = fileURLToPath(new URL('./synthetic-wifi-task-shape.mjs', import.meta.url));
const shapeSource = await fs.readFile(shapeFile, 'utf8');
const fixture = () => ({ powershell: 'C:\\Fixture\\pwsh.exe', leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAt: Date.now() + 60_000 });
const json = (state = 'exited', code = 0, healthy = true) => JSON.stringify({ schema: 1, state, code, healthy });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function mocked(t, changes = {}, { spawnError = false, notSpawned = false, noStreams = false } = {}) {
  const options = { ...fixture(), ...changes };
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { throw new Error('LAUNCHER_MUST_NOT_BE_KILLED'); };
  t.mock.method(fs, 'realpath', async value => value);
  t.mock.method(fs, 'lstat', async value => ({ isSymbolicLink: () => false,
    isDirectory: () => !value.endsWith('pwsh.exe'), isFile: () => value.endsWith('pwsh.exe'), nlink: 1 }));
  let invocation;
  t.mock.method(childProcess, 'spawn', (...args) => {
    invocation = args;
    if (spawnError) throw spawnError instanceof Error ? spawnError : new Error('synthetic-private-spawn-error');
    if (noStreams) { child.stdout = null; child.stderr = null; }
    if (!notSpawned) { child.pid = 12345; queueMicrotask(() => child.emit('spawn')); }
    return child;
  });
  const handle = createAdminTaskObservation(options);
  await tick();
  return { handle, child, options, invocation, close(output = json(), code = 0, signal = null) {
    if (output) child.stdout?.write(Buffer.from(output));
    child.stdout?.end(); child.stderr?.end(); child.emit('close', code, signal);
  } };
}

test('admin observation rejects getters, unknown options, noncanonical executable, UUID and deadline', () => {
  for (const input of [null, {}, { ...fixture(), extra: true }, { ...fixture(), leaseId: '../unsafe' },
    { ...fixture(), leaseId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { ...fixture(), powershell: 'pwsh.exe' }, { ...fixture(), powershell: 'C:\\Fixture\\..\\pwsh.exe' },
    { ...fixture(), powershell: 'C:\\Fixture\\powershell.exe' }, { ...fixture(), expiresAt: Date.now() },
    { ...fixture(), expiresAt: Date.now() + 7_300_000 }, { ...fixture(), expiresAt: 'tomorrow' },
    Object.defineProperty(fixture(), 'leaseId', { get() { throw new Error('GETTER_MUST_NOT_RUN'); } })]) {
    assert.throws(() => createAdminTaskObservation(input), { message: 'ADMIN_TASK_OBSERVATION_FAILED', phase: 'configuration' });
  }
});

test('admin scripts use fixed read-only Windows PowerShell, exact task and bounded exit codes', () => {
  const scripts = syntheticWifiAdminTaskScripts(fixture());
  assert.ok(scripts.launcher.includes("$startInfo.FileName=[IO.Path]::Combine($system,'WindowsPowerShell\\v1.0\\powershell.exe')"));
  assert.ok(scripts.launcher.includes("$startInfo.UseShellExecute=$true;$startInfo.Verb='runas'"));
  assert.equal((scripts.launcher.match(/\[Diagnostics\.Process\]::Start\(\$startInfo\)/g) ?? []).length, 1);
  assert.ok(scripts.launcher.includes('$helper.WaitForExit(250)'));
  assert.ok(scripts.launcher.includes('$exited=$helper.HasExited'));
  assert.ok(scripts.launcher.includes("if($exited -isnot [bool]){throw 'REFUSED'}"));
  assert.ok(scripts.launcher.indexOf('$helper.Dispose()') < scripts.launcher.lastIndexOf("Emit 'exited'"));
  assert.ok(scripts.elevated.includes("WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1"));
  assert.ok(scripts.elevated.includes("ScheduledTasks\\Get-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop"));
  assert.ok(scripts.elevated.includes('Carebridge-Synthetic-WiFi-Cleanup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.equal((scripts.elevated.match(/UtcNow\.ToUnixTimeMilliseconds\(\) -ge \$deadline/g) ?? []).length, 3);
  assert.doesNotMatch(scripts.elevated, /\$env:|WriteAll|Set-Content|Add-Content|Out-File|Register-ScheduledTask|Set-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Get-Net|SetSecurityDescriptor|Invoke-Expression|\.Message|ConvertTo-Json|Write-Output/);
  assert.ok(scripts.launcher.length + 512 < 32_000);
  assert.ok(Object.isFrozen(syntheticWifiAdminTaskFailurePhases));
});

test('result waits for launcher close, not only its exit or stdout receipt', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  const run = await mocked(t);
  let settled = false; run.handle.result.then(() => { settled = true; });
  run.child.stdout.write(json()); run.child.emit('exit', 0, null);
  await tick(); assert.equal(settled, false);
  run.close('');
  assert.deepEqual(await run.handle.result, { verified: true });
  assert.deepEqual(await run.handle.closed, { confirmed: true });
  assert.deepEqual(run.invocation[1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(run.invocation[2].shell, false); assert.equal(run.invocation[2].windowsHide, true);
  assert.deepEqual(run.invocation[2].stdio, ['ignore', 'pipe', 'pipe']);
});

for (const [name, output, expectedPhase, confirmed] of [
  ['admin verification mismatch', json('exited', 15), 'task-fields', true],
  ['sticky wait or dispose failure', json('exited', 0, false), 'observation', true],
  ['unknown elevated exit', json('exited', 255, false), 'observation', true],
  ['typed native UAC cancellation', json('declined', 1223), 'declined', true],
  ['launcher deadline before start', json('not-started', 11), 'expired', true],
  ['unknown process start outcome', json('unknown', 253, false), 'observation', false],
  ['no receipt', '', 'protocol', false],
  ['extra diagnostic field', '{"schema":1,"state":"exited","code":0,"healthy":true,"message":"private"}', 'protocol', false],
  ['duplicate key', '{"schema":1,"state":"exited","code":10,"code":0,"healthy":true}', 'protocol', false],
  ['unknown exit code cannot forge success', json('exited', 99), 'protocol', false],
  ['whitespace is not canonical', `${json()}\n`, 'protocol', false],
  ['oversized output', 'x'.repeat(513), 'protocol', false],
]) {
  test(`mock launcher ${name}`, async t => {
    if (process.platform !== 'win32') return t.skip('Windows path ownership test');
    const run = await mocked(t); run.close(output);
    await assert.rejects(run.handle.result, { message: 'ADMIN_TASK_OBSERVATION_FAILED', phase: expectedPhase });
    assert.deepEqual(await run.handle.closed, { confirmed });
  });
}

test('cancel rejects result but preserves pending close ownership until late real receipt', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  const run = await mocked(t); let closed = false;
  run.handle.closed.then(() => { closed = true; }); run.handle.cancel(); run.handle.cancel();
  await assert.rejects(run.handle.result, { phase: 'cancelled' }); await tick(); assert.equal(closed, false);
  run.close(); assert.deepEqual(await run.handle.closed, { confirmed: true });
  await assert.rejects(run.handle.result, { phase: 'cancelled' });
});

test('expiry rejects result without closing or killing a pending reader', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  const run = await mocked(t, { expiresAt: Date.now() + 100 }); let closed = false;
  run.handle.closed.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 140));
  await assert.rejects(run.handle.result, { phase: 'expired' }); assert.equal(closed, false);
  run.close(); assert.deepEqual(await run.handle.closed, { confirmed: true });
});

test('spawn failure, stderr, signal and transport error cannot claim closure', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  for (const scenario of ['throw', 'stderr', 'signal', 'error']) {
    await t.test(scenario, async childTest => {
      const run = await mocked(childTest, {}, { spawnError: scenario === 'throw' });
      if (scenario === 'stderr') run.child.stderr.write('synthetic-private-error');
      if (scenario === 'error') run.child.emit('error', new Error('synthetic-private-error'));
      if (scenario !== 'throw') run.close(json(), scenario === 'signal' ? null : 0, scenario === 'signal' ? 'SIGTERM' : null);
      await assert.rejects(run.handle.result, { message: 'ADMIN_TASK_OBSERVATION_FAILED' });
      assert.deepEqual(await run.handle.closed, { confirmed: false });
    });
  }
});

test('documented failed-spawn path confirms no launcher only after error and close', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  for (const noStreams of [false, true]) {
    await t.test(noStreams ? 'missing failed-spawn pipes' : 'closed failed-spawn pipes', async childTest => {
      const run = await mocked(childTest, {}, { notSpawned: true, noStreams });
      let closed = false; run.handle.closed.then(() => { closed = true; });
      run.child.emit('error', Object.assign(new Error('synthetic-private-error'), { code: 'ENOENT' }));
      await assert.rejects(run.handle.result, { phase: 'launch' }); await tick(); assert.equal(closed, false);
      run.close('', -4058, null); assert.deepEqual(await run.handle.closed, { confirmed: true });
    });
  }
});

test('native synchronous spawn refusal is distinct from generic or mismatched throws', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path ownership test');
  const invalidArgument = [...getSystemErrorMap()].find(([, [name]]) => name === 'EINVAL')[0];
  for (const [name, error, confirmed] of [
    ['native', Object.assign(new Error('synthetic-private-error'), { errno: invalidArgument, syscall: 'spawn', code: 'EINVAL' }), true],
    ['wrong syscall', Object.assign(new Error('synthetic-private-error'), { errno: invalidArgument, syscall: 'kill', code: 'EINVAL' }), false],
    ['wrong code', Object.assign(new Error('synthetic-private-error'), { errno: invalidArgument, syscall: 'spawn', code: 'ENOENT' }), false]
  ]) await t.test(name, async childTest => {
    const run = await mocked(childTest, {}, { spawnError: error });
    await assert.rejects(run.handle.result, { phase: 'launch' });
    assert.deepEqual(await run.handle.closed, { confirmed });
  });
});

// No elevated command is executed. The one real Process.Start expression in
// the fixed launcher is replaced IN MEMORY by a managed facade. The entire
// source is hash-pinned and the replacement/AST/command whitelist are checked
// before execution, while the real token must be nonadministrator.
const managedCommand = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();try{
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NONADMIN_REQUIRED'}
}finally{$identity.Dispose()};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_ADMIN_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_ADMIN_SHA256){throw 'SOURCE_CHANGED'};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_ADMIN_SHAPE_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_ADMIN_SHAPE_SHA256){throw 'SHAPE_CHANGED'};
$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CAREBRIDGE_ADMIN_BODY));
$needle='[Diagnostics.Process]::Start($startInfo)';
if([regex]::Matches($body,[regex]::Escape($needle)).Count -ne 1){throw 'PROCESS_CALL_SHAPE_CHANGED'};
$body=$body.Replace($needle,'[FakeProcess]::Start($startInfo)');
if($body -match '(?i)\[Diagnostics\.Process\]|Start-Process|Invoke-Expression|DllImport|CreateProcess'){throw 'REAL_PROCESS_CALL_REMAINS'};
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_LAUNCHER_AST'};
foreach($node in $ast.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
  if($node.GetCommandName() -cnotin @('Set-StrictMode','Emit')){throw 'LAUNCHER_COMMAND_SCOPE_CHANGED'}
};
$encodedMatches=[regex]::Matches($body,'-EncodedCommand ([A-Za-z0-9+/=]+)');
if($encodedMatches.Count -ne 1){throw 'ENCODED_COMMAND_SHAPE_CHANGED'};
$env:CAREBRIDGE_ADMIN_EXPECTED_ARGUMENTS='-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encodedMatches[0].Groups[1].Value;
$adminBody=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encodedMatches[0].Groups[1].Value));
$adminAst=[Management.Automation.Language.Parser]::ParseInput($adminBody,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_ADMIN_AST'};
foreach($node in $adminAst.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
  if($node.GetCommandName() -cnotin @('Set-StrictMode','Import-Module','ScheduledTasks\Get-ScheduledTask','ForEach-Object','Sort-Object')){throw 'ADMIN_COMMAND_SCOPE_CHANGED'}
};
# Defense in depth: the elevated body is not invoked, and no OS/task provider
# entry point is permitted if this fixture accidentally adds a call.
foreach($name in @('Start-Process','Get-ScheduledTask','Register-ScheduledTask','Set-ScheduledTask','Unregister-ScheduledTask',
  'Start-ScheduledTask','Get-NetFirewallRule','New-NetFirewallRule','Set-NetFirewallRule','Remove-NetFirewallRule','Invoke-Command')){
  Set-Item -LiteralPath ('Function:global:'+$name) -Value {throw 'UNEXPECTED_OS_CALL'} -Options ReadOnly
};
if($env:CAREBRIDGE_ADMIN_CASE.StartsWith('admin-')){
  # Exercise the elevated body's own role/deadline/exit mapping without any
  # elevation, module import, provider access or real task. Replace only the
  # five known boundaries, retaining the exact shared task-shape checks.
  foreach($replacement in @(
    @('[Security.Principal.WindowsIdentity]::GetCurrent()','[AdminMockIdentity]::new()',1),
    @('([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)','[AdminMock]::IsAdministrator()',1),
    @('Import-Module -Name $manifest -ErrorAction Stop -WarningAction SilentlyContinue','Import-AdminMockModule $manifest',1),
    @('ScheduledTasks\Get-ScheduledTask','Get-AdminMockTask',1),
    @('[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()','[AdminMock]::Clock()',3)
  )){
    if([regex]::Matches($adminBody,[regex]::Escape($replacement[0])).Count -ne $replacement[2]){throw 'ADMIN_BOUNDARY_SHAPE_CHANGED'};
    $adminBody=$adminBody.Replace($replacement[0],$replacement[1])
  };
  if($adminBody -match 'WindowsIdentity|WindowsPrincipal|Import-Module|ScheduledTasks\\Get-ScheduledTask|DateTimeOffset|ProcessStartInfo|RunAs'){throw 'REAL_ADMIN_BOUNDARY_REMAINS'};
  $adminAst=[Management.Automation.Language.Parser]::ParseInput($adminBody,[ref]$tokens,[ref]$errors);
  if($errors.Count){throw 'INVALID_ADMIN_FACADE_AST'};
  foreach($node in $adminAst.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
    if($node.GetCommandName() -cnotin @('Set-StrictMode','Import-AdminMockModule','Get-AdminMockTask','ForEach-Object','Sort-Object')){throw 'ADMIN_FACADE_SCOPE_CHANGED'}
  };
  $deadlines=[regex]::Matches($adminBody,'\$deadline=\[long\]([0-9]+)');
  if($deadlines.Count -ne 1){throw 'DEADLINE_SHAPE_CHANGED'};
  $env:CAREBRIDGE_ADMIN_EXPECTED_DEADLINE=$deadlines[0].Groups[1].Value;
  Add-Type -TypeDefinition @'
using System;
public sealed class AdminMockIdentity : IDisposable { public void Dispose() {} }
public static class AdminMock {
  public static int Clocks;
  public static string Scenario { get { return Environment.GetEnvironmentVariable("CAREBRIDGE_ADMIN_CASE"); } }
  public static bool IsAdministrator() { return Scenario!="admin-role-denied"; }
  public static long Clock() {
    Clocks++;
    long deadline=long.Parse(Environment.GetEnvironmentVariable("CAREBRIDGE_ADMIN_EXPECTED_DEADLINE"));
    if(Scenario=="admin-expired-before" || (Scenario=="admin-expired-import" && Clocks>=2) || (Scenario=="admin-expired-after" && Clocks>=3)) return deadline;
    return deadline-1;
  }
}
'@;
  function Import-AdminMockModule([string]$Manifest){
    $expected=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System),'WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1');
    if($Manifest -cne $expected -or [AdminMock]::Clocks -ne 1 -or [AdminMock]::Scenario -cin @('admin-role-denied','admin-expired-before')){
      [Console]::Error.Write('MOCK_IMPORT_ORDER_INVALID');throw 'REFUSED'
    }
  };
  function Get-AdminMockTask {
    [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)
    $expectedName='Carebridge-Synthetic-WiFi-Cleanup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if($TaskName -cne $expectedName -or $TaskPath -cne '\' -or [AdminMock]::Clocks -ne 2 -or
       [AdminMock]::Scenario -cin @('admin-role-denied','admin-expired-before','admin-expired-import')){
      [Console]::Error.Write('MOCK_QUERY_ORDER_INVALID');throw 'REFUSED'
    };
    if([AdminMock]::Scenario -ceq 'admin-empty'){return};
    $actualName=if([AdminMock]::Scenario -ceq 'admin-wrong-name'){'synthetic-mismatch'}else{$expectedName};
    return [pscustomobject]@{TaskName=$actualName;TaskPath='\';Description='Carebridge temporary synthetic-only Wi-Fi lease aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      Settings=[pscustomobject]@{Enabled=$true;StartWhenAvailable=$true};
      Principal=[pscustomobject]@{UserId='SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'};
      Actions=@([pscustomobject]@{Execute=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System),'WindowsPowerShell\v1.0\powershell.exe')});
      Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'}},[pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskTimeTrigger'}})
    }
  };
  & ([scriptblock]::Create($adminBody));throw 'ADMIN_EXIT_MISSING'
};
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
public sealed class FakeHandle {
  readonly string scenario;
  int waits, probes;
  bool exited;
  public FakeHandle(string value) { scenario=value; }
  public bool WaitForExit(int timeout) {
    if(timeout!=250) throw new InvalidOperationException("unexpected-timeout");
    waits++;
    if(scenario=="wait-error" && waits==1) throw new InvalidOperationException("synthetic-private-wait-error");
    return waits>=2;
  }
  public bool HasExited { get {
    probes++;
    if(scenario=="has-exited-error" && probes==1) throw new InvalidOperationException("synthetic-private-probe-error");
    exited=waits>=2; return exited;
  } }
  public int ExitCode { get {
    if(!exited) throw new InvalidOperationException("premature-code");
    if(scenario=="exit-code-error") throw new InvalidOperationException("synthetic-private-code-error");
    return scenario=="task-fields" ? 15 : scenario=="unknown-code" ? 99 : 0;
  } }
  public void Dispose() {
    if(!exited || waits<2) throw new InvalidOperationException("premature-dispose");
    if(scenario=="dispose-error") throw new InvalidOperationException("synthetic-private-dispose-error");
  }
}
public sealed class NativeCodeLookalike : Exception { public int NativeErrorCode { get { return 1223; } } }
public static class FakeProcess {
  public static FakeHandle Start(ProcessStartInfo value) {
    string expected=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
    if(value.FileName!=expected || value.Arguments!=Environment.GetEnvironmentVariable("CAREBRIDGE_ADMIN_EXPECTED_ARGUMENTS") ||
       !value.UseShellExecute || value.Verb!="runas" || value.WindowStyle!=ProcessWindowStyle.Hidden ||
       value.RedirectStandardOutput || value.RedirectStandardError || value.RedirectStandardInput)
       throw new InvalidOperationException("unexpected-start-info");
    string scenario=Environment.GetEnvironmentVariable("CAREBRIDGE_ADMIN_CASE");
    if(scenario=="declined") throw new Win32Exception(1223);
    if(scenario=="native-other") throw new Win32Exception(5);
    if(scenario=="native-spoof") throw new NativeCodeLookalike();
    if(scenario=="null-handle") return null;
    return new FakeHandle(scenario);
  }
}
'@;
& ([scriptblock]::Create($body));
`;

for (const [scenario, expected, expectedCode = 0] of [
  ['success', json()], ['task-fields', json('exited', 15)], ['wait-error', json('exited', 0, false)],
  ['has-exited-error', json('exited', 0, false)], ['exit-code-error', json('exited', 255, false)],
  ['dispose-error', json('exited', 0, false)], ['unknown-code', json('exited', 255, false)],
  ['declined', json('declined', 1223)], ['native-other', json('unknown', 253, false)],
  ['native-spoof', json('unknown', 253, false)], ['null-handle', json('unknown', 253, false)],
  ['admin-success', '', 0], ['admin-role-denied', '', 10], ['admin-expired-before', '', 11],
  ['admin-expired-import', '', 11], ['admin-expired-after', '', 11], ['admin-empty', '', 14], ['admin-wrong-name', '', 15]
]) {
  test(`managed-only launcher facade ${scenario}`, t => {
    if (process.platform !== 'win32' || !process.env.CAREBRIDGE_TEST_POWERSHELL) return t.skip('Explicit nonadministrator PowerShell required; no UAC or task providers.');
    const powershell = process.env.CAREBRIDGE_TEST_POWERSHELL;
    assert.match(powershell, /^[A-Za-z]:[\\/].*[\\/]pwsh\.exe$/i);
    const body = syntheticWifiAdminTaskScripts(fixture()).launcher;
    const result = childProcess.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', managedCommand], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 4096,
      env: { ...privateSecretEnvironment(process.env, powershell), CAREBRIDGE_ADMIN_SOURCE: moduleFile,
        CAREBRIDGE_ADMIN_SHA256: createHash('sha256').update(moduleSource).digest('hex').toUpperCase(),
        CAREBRIDGE_ADMIN_SHAPE_SOURCE: shapeFile, CAREBRIDGE_ADMIN_SHAPE_SHA256: createHash('sha256').update(shapeSource).digest('hex').toUpperCase(),
        CAREBRIDGE_ADMIN_BODY: Buffer.from(body).toString('base64'), CAREBRIDGE_ADMIN_CASE: scenario }
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, expectedCode); assert.equal(result.stderr, ''); assert.equal(result.stdout, expected);
  });
}
