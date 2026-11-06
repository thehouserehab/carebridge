import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateSecretEnvironment } from '../server/windows-private-secret-io.mjs';
import { syntheticWifiLeaseInspectScript, syntheticWifiLeaseObserverFailurePhase,
  syntheticWifiLeaseCheckOptions, verifyActiveAdminTaskObservation, confirmAdminTaskObserverClosed } from './windows-synthetic-wifi-lease-check.mjs';

// Execute only the exported read-only observer string, with fixed synthetic
// provider/task mocks. Never run its native probe, lease helper, UAC or API.
const observerFile = fileURLToPath(new URL('./windows-synthetic-wifi-lease-check.mjs', import.meta.url));
const observerSource = await readFile(observerFile, 'utf8');
const taskShapeFile = fileURLToPath(new URL('./synthetic-wifi-task-shape.mjs', import.meta.url));
const taskShapeSource = await readFile(taskShapeFile, 'utf8');
const phases = ['input','original-snapshot','guard-boundary','task-query',
  'persistent-query','persistent-snapshot','persistent-rule','persistent-network',
  'active-query','active-snapshot','active-rule','active-network',
  'task-count','task-fields','task-action','task-trigger','task-not-enumerated',
  'task-not-found','task-access-denied','task-query-unavailable','absence','result'];

test('administrator task observation is a separate explicit, UUID-only native-probe option', () => {
  const args = ['--host', '10.231.9.10', '--peer', '10.231.9.11', '--interface-index', '8', '--confirm-private-wifi',
    '--base', 'E:\\CarebridgeBeta', '--powershell', 'C:\\Fixture\\pwsh.exe', '--confirm-synthetic-e-drive'];
  assert.equal(syntheticWifiLeaseCheckOptions(args).adminTaskObservationRequested, false);
  assert.equal(syntheticWifiLeaseCheckOptions(['--verify-task-as-admin', ...args]).adminTaskObservationRequested, true);
  const exception = [...args, '--temporary-tcp-block-rule', 'TCP Query User{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}C:\\Fixture\\node.exe'];
  assert.equal(syntheticWifiLeaseCheckOptions(exception).adminTaskObservationRequested, false);
  for (const invalid of [['--verify-task-as-admin', ...exception], [...args, '--verify-task-as-admin'],
    ['--verify-task-as-admin', '--verify-task-as-admin', ...args], ['--admin', ...args]]) {
    assert.throws(() => syntheticWifiLeaseCheckOptions(invalid));
  }
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function adminFixture() {
  const result = deferred(), closed = deferred(), stopped = deferred();
  const state = { cancelled: 0, checkpoints: 0, rejected: false };
  const lease = { status: 'active', waitForStop: () => stopped.promise };
  const observation = { result: result.promise, closed: closed.promise, cancel() { state.cancelled++; } };
  const checkpoint = () => { state.checkpoints++; if (state.rejected) throw Error('cancelled'); };
  return { result, closed, stopped, state, lease, observation, checkpoint };
}
test('task success and actual observer exit are independently required', async () => {
  const f = adminFixture();
  const result = verifyActiveAdminTaskObservation(f.lease, f.observation, f.checkpoint);
  f.result.resolve({ verified: true });
  assert.deepEqual(await result, { verified: true }); assert.equal(f.state.checkpoints, 2);
  await assert.rejects(confirmAdminTaskObserverClosed(f.observation, 10));
  f.closed.resolve({ confirmed: true });
  await confirmAdminTaskObserverClosed(f.observation);
  assert.equal(f.state.cancelled, 0);
});
for (const scenario of ['inactive-before', 'stop', 'stop-reject', 'inactive-after', 'cancel', 'result-failed', 'malformed']) {
  test(`administrator observation cannot pass after ${scenario}`, async () => {
    const f = adminFixture();
    if (scenario === 'inactive-before') f.lease.status = 'removed';
    const result = verifyActiveAdminTaskObservation(f.lease, f.observation, f.checkpoint);
    if (scenario === 'stop') f.stopped.resolve();
    else if (scenario === 'stop-reject') f.stopped.reject(Error('stopped'));
    else if (scenario === 'result-failed') f.result.reject(Error('failed'));
    else {
      if (scenario === 'inactive-after') f.lease.status = 'removed';
      if (scenario === 'cancel') f.state.rejected = true;
      f.result.resolve(scenario === 'malformed' ? { verified: true, ignored: true } : { verified: true });
    }
    await assert.rejects(result); assert.equal(f.state.cancelled, 1);
    f.closed.resolve({ confirmed: true });
    await confirmAdminTaskObserverClosed(f.observation);
  });
}
test('unconfirmed, malformed or failed process closure never becomes cleanup evidence', async () => {
  for (const closed of [() => Promise.resolve({ confirmed: false }), () => Promise.resolve({ confirmed: true, extra: true }),
    () => Promise.resolve(null), () => Promise.reject(Error('failed'))]) {
    await assert.rejects(confirmAdminTaskObserverClosed({ closed: closed() }));
  }
});

test('observer diagnostics accept only the fixed failure schema and phase enum', () => {
  for (const phase of phases) assert.equal(syntheticWifiLeaseObserverFailurePhase({ schema: 1, ok: false, phase }), phase);
  for (const value of [null, [], {}, { schema: 1, ok: false },
    { schema: 2, ok: false, phase: 'task-query' }, { schema: 1, ok: true, phase: 'task-query' },
    { schema: 1, ok: false, phase: '' }, { schema: 1, ok: false, phase: 'unknown' },
    { schema: 1, ok: false, phase: 1 }, { schema: 1, ok: false, phase: 'C:\\synthetic-private' },
    { schema: 1, ok: false, phase: 'task-query', message: 'synthetic-private-error' },
    { schema: 1, ok: false, phase: 'task-query', line: 99 }]) {
    assert.throws(() => syntheticWifiLeaseObserverFailurePhase(value), { message: 'SYNTHETIC_WIFI_LEASE_CHECK_FAILED' });
  }
  const failure = syntheticWifiLeaseInspectScript.slice(syntheticWifiLeaseInspectScript.lastIndexOf('} catch {'));
  assert.ok(failure.includes('[ordered]@{schema=1;ok=$false;phase=$observationPhase}'));
  assert.doesNotMatch(failure, /\$_|\$Error|Exception|Message|StackTrace|ScriptName|FullyQualifiedErrorId|\$inputData/);
  assert.ok(observerSource.includes('!invalid && code === 1 && signal === null && value?.ok === false'));
  assert.ok(observerSource.includes('throw fail(syntheticWifiLeaseObserverFailurePhase(value))'));
  assert.ok(observerSource.includes('observerPhases.includes(observerPhase) ? { observerPhase } : {}'));
  const lookup=syntheticWifiLeaseInspectScript.slice(syntheticWifiLeaseInspectScript.indexOf('function Get-ObserverTaskLookupOutcome'),syntheticWifiLeaseInspectScript.indexOf('$taskLookupPhases='));
  assert.ok(lookup.includes("New-Object -ComObject 'Schedule.Service'"));
  assert.ok(lookup.includes('$null=$service.Connect()'));
  assert.ok(lookup.includes("$folder=$service.GetFolder('\\')"));
  assert.ok(lookup.includes('$registered=$folder.GetTask($Name)'));
  assert.ok(lookup.includes('$definition=$registered.Definition'));
  assert.ok(lookup.includes('$candidate -is [Runtime.InteropServices.COMException]'));
  assert.ok(lookup.includes("$step -ceq 'task' -and $lookupFailure.HResult -in @(-2147024894,-2147024893)"));
  assert.ok(lookup.includes('$candidate.GetType() -eq [IO.FileNotFoundException] -and $candidate.HResult -eq -2147024894'));
  assert.ok(lookup.includes('$candidate.GetType() -eq [IO.DirectoryNotFoundException] -and $candidate.HResult -eq -2147024893'));
  assert.ok(lookup.includes('$candidate.GetType() -eq [UnauthorizedAccessException] -and $candidate.HResult -eq -2147024891'));
  assert.ok(lookup.includes('::FinalReleaseComObject($owned)'));
  assert.ok(lookup.includes("catch {$outcome='unavailable'}"));
  assert.equal((lookup.match(/return \$outcome/g)??[]).length,1);
  assert.ok(lookup.lastIndexOf('return $outcome')>lookup.indexOf('} finally {'));
  assert.doesNotMatch(lookup,/\.Message|\.ToString\(|SetSecurityDescriptor|RegisterTask|DeleteTask|\.Run\(/);
});

const command = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();try{
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NONADMIN_REQUIRED'}
}finally{$identity.Dispose()};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_OBSERVER_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_OBSERVER_SHA256){throw 'SOURCE_CHANGED'};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_TASK_SHAPE_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_TASK_SHAPE_SHA256){throw 'SOURCE_CHANGED'};
$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CAREBRIDGE_OBSERVER_BODY));
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_OBSERVER_AST'};
$allowed=@('Set-StrictMode','Digest','One','OneAddress','Get-ObserverTaskLookupOutcome','New-Object','Get-CarebridgeTemporaryBlockSnapshot','Get-CarebridgeExceptionKey','Assert-CarebridgeGuard',
  'Get-ScheduledTask','Where-Object','Get-CarebridgeExactFirewallRule','Get-CarebridgeFirewallSnapshot',
  'ConvertFrom-Json','Get-NetFirewallRule','Get-NetFirewallApplicationFilter','ForEach-Object','Sort-Object','ConvertTo-Json');
foreach($node in $ast.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
  if($node.GetCommandName() -cnotin $allowed){throw 'OBSERVER_COMMAND_SCOPE_CHANGED'}
};
if($body -match '(?i)RunAs|Start-Process|ProcessStartInfo|Process\]\s*::\s*Start|ShellExecute|CreateProcess|DllImport|Invoke-Expression'){throw 'OBSERVER_PROCESS_SCOPE_CHANGED'};
$blocked=@('Register-ScheduledTask','Set-ScheduledTask','Unregister-ScheduledTask','Start-ScheduledTask','Stop-ScheduledTask',
  'Enable-ScheduledTask','Disable-ScheduledTask','New-ScheduledTaskTrigger','New-ScheduledTaskAction','New-ScheduledTaskPrincipal',
  'New-ScheduledTaskSettingsSet','Get-ScheduledTaskInfo','Get-NetAdapter','Get-NetIPAddress','Get-NetConnectionProfile','Get-NetFirewallProfile',
  'New-NetFirewallRule','Set-NetFirewallRule','Remove-NetFirewallRule','Enable-NetFirewallRule','Disable-NetFirewallRule',
  'Set-NetFirewallPortFilter','Set-NetConnectionProfile','Set-NetFirewallProfile','Get-NetFirewallAddressFilter','Get-NetFirewallPortFilter',
  'Get-NetFirewallInterfaceFilter','Get-NetFirewallInterfaceTypeFilter','Get-NetFirewallServiceFilter','Get-NetFirewallSecurityFilter',
  'Start-Process','Start-Job','Start-ThreadJob','Invoke-Command','Invoke-Expression','Invoke-WebRequest','Invoke-RestMethod',
  'Invoke-CimMethod','Set-CimInstance','New-CimInstance','Remove-CimInstance','Get-CimInstance','Get-WmiObject',
  'netsh','netsh.exe','schtasks','schtasks.exe');
foreach($name in $blocked){
  Set-Item -LiteralPath ('Function:global:'+$name) -Value {throw 'UNEXPECTED_OS_CALL'} -Options ReadOnly
};
$case=$env:CAREBRIDGE_OBSERVER_CASE;
$inputData=[pscustomobject]@{stage='active';leaseId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';alias='Synthetic Wi-Fi';name='';program='C:\Fixture\node.exe';host='10.231.9.10';peer='10.231.9.11'};
if($case.StartsWith('absence')){$inputData.stage='after'};
if($case -ceq 'before'){$inputData.stage='before';$inputData.leaseId=''};
if($case.StartsWith('separate-')){
  $inputData|Add-Member -NotePropertyName taskInspection -NotePropertyValue 'separate-admin';
  if($case -ceq 'separate-before'){$inputData.stage='before'};
  if($case -ceq 'separate-after'){$inputData.stage='after'};
  if($case -ceq 'separate-exception'){$inputData.name='synthetic-exception'};
  if($case -ceq 'separate-empty-id'){$inputData.leaseId=''};
  if($case -ceq 'separate-invalid-id'){$inputData.leaseId='*'};
  if($case -ceq 'separate-unknown'){$inputData.taskInspection='unknown'};
};
$expectedName='Carebridge-Synthetic-WiFi-'+$inputData.leaseId;
$expectedTaskName='Carebridge-Synthetic-WiFi-Cleanup-'+$inputData.leaseId;
$expectedMarker='Carebridge temporary synthetic-only Wi-Fi lease '+$inputData.leaseId;
# Pure managed stand-ins: no COM activation, P/Invoke, task provider or file IO.
# New-Object is shadowed below, so the real observer's local COM expression
# exercises only these methods and their typed exception/inner-exception shapes.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
public sealed class ObserverMockSpoofException : Exception {
  public ObserverMockSpoofException() : base("synthetic-private-error 0x80070002") { HResult=unchecked((int)0x80070002); }
}
public sealed class ObserverMockTask {
  readonly string scenario;
  public ObserverMockTask(string value) { scenario=value; }
  public object Definition { get {
    if(scenario.Contains("definition-missing")) throw new COMException("synthetic-private-error",unchecked((int)0x80070002));
    if(scenario.Contains("definition-denied")) throw new COMException("synthetic-private-error",unchecked((int)0x80070005));
    if(scenario.Contains("definition-null")) return null;
    return new object();
  } }
}
public sealed class ObserverMockFolder {
  readonly string scenario;
  readonly string expectedName;
  public ObserverMockFolder(string value,string name) { scenario=value;expectedName=name; }
  public ObserverMockTask GetTask(string name) {
    if(name!=expectedName) throw new InvalidOperationException("unexpected-task-name");
    if(scenario.Contains("mapped-file-wrong-code")) {
      var error=new FileNotFoundException("synthetic-private-error");
      typeof(Exception).GetProperty("HResult").SetValue(error,unchecked((int)0x80004005));
      throw error;
    }
    if(scenario.Contains("mapped-file")) throw new FileNotFoundException("synthetic-private-error");
    if(scenario.Contains("mapped-directory")) throw new DirectoryNotFoundException("synthetic-private-error");
    if(scenario.Contains("mapped-access")) throw new UnauthorizedAccessException("synthetic-private-error");
    if(scenario=="absence" || scenario.Contains("task-missing")) throw new COMException("synthetic-private-error",unchecked((int)0x80070002));
    if(scenario.Contains("task-path-missing")) throw new COMException("synthetic-private-error",unchecked((int)0x80070003));
    if(scenario.Contains("task-denied")) throw new COMException("synthetic-private-error",unchecked((int)0x80070005));
    if(scenario.Contains("task-unknown")) throw new COMException("synthetic-private-error",unchecked((int)0x80004005));
    if(scenario.Contains("task-spoof")) throw new ObserverMockSpoofException();
    if(scenario.Contains("task-wrapped")) throw new TargetInvocationException(new COMException("synthetic-private-error",unchecked((int)0x80070002)));
    return new ObserverMockTask(scenario);
  }
}
public sealed class ObserverMockService {
  readonly string scenario;
  readonly string expectedName;
  public ObserverMockService(string value,string name) { scenario=value;expectedName=name; }
  public void Connect() {
    if(scenario.Contains("connect-mapped-file")) throw new FileNotFoundException("synthetic-private-error");
    if(scenario.Contains("connect-missing")) throw new COMException("synthetic-private-error",unchecked((int)0x80070002));
    if(scenario.Contains("connect-denied")) throw new COMException("synthetic-private-error",unchecked((int)0x80070005));
  }
  public ObserverMockFolder GetFolder(string path) {
    if(path!="\\") throw new InvalidOperationException("unexpected-task-folder");
    if(scenario.Contains("folder-missing")) throw new COMException("synthetic-private-error",unchecked((int)0x80070003));
    if(scenario.Contains("folder-denied")) throw new COMException("synthetic-private-error",unchecked((int)0x80070005));
    return new ObserverMockFolder(scenario,expectedName);
  }
}
public static class ObserverMockRelease {
  public static readonly System.Collections.Generic.List<string> Attempts=new System.Collections.Generic.List<string>();
  public static int FailAt;
  static string Label(object value) {
    if(value is ObserverMockTask) return "registered";
    if(value is ObserverMockFolder) return "folder";
    if(value is ObserverMockService) return "service";
    if(value!=null && value.GetType()==typeof(object)) return "definition";
    throw new InvalidOperationException("unexpected-managed-release-type");
  }
  public static bool IsComObject(object value) { Label(value);return true; }
  public static int FinalReleaseComObject(object value) {
    Attempts.Add(Label(value));
    if(FailAt==Attempts.Count) throw new InvalidOperationException("fixed-managed-release-failure");
    return 0;
  }
}
'@;
function New-Object {
  [CmdletBinding()]param([string]$ComObject)
  if($ComObject -cne 'Schedule.Service' -or $case -cin @('active','before','many-tasks') -or $case.StartsWith('separate-')){throw 'UNEXPECTED_COM_ACTIVATION'};
  return [ObserverMockService]::new($case,$expectedTaskName)
};
function Get-ScheduledTask {
  [CmdletBinding()]param([string]$TaskPath)
  if($case.StartsWith('separate-')){throw 'UNEXPECTED_TASK_PROVIDER_CALL'};
  if($TaskPath -cne '\'){throw 'MOCK_TASK_PATH_MISMATCH'};
  if($case -ceq 'task-query-denied'){throw 'SYNTHETIC_PRIVATE_PROVIDER_ERROR'};
  if($case -ceq 'empty-task' -or $case.StartsWith('lookup-') -or $case.StartsWith('absence')){return};
  $execute=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System),'WindowsPowerShell\v1.0\powershell.exe');
  if($case -ceq 'task-action'){$execute='synthetic-mismatching-action'};
  $triggerKind=if($case -ceq 'task-trigger'){'MSFT_TaskLogonTrigger'}else{'MSFT_TaskTimeTrigger'};
  $fixture=[pscustomobject]@{TaskName=$expectedTaskName;TaskPath='\';Description=$expectedMarker;
    Settings=[pscustomobject]@{Enabled=($case -cne 'task-fields');StartWhenAvailable=$true};
    Principal=[pscustomobject]@{UserId='SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'};
    Actions=@([pscustomobject]@{Execute=$execute});
    Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'}},[pscustomobject]@{CimClass=[pscustomobject]@{CimClassName=$triggerKind}})
  };
  if($case -ceq 'many-tasks'){return @($fixture,$fixture)};
  return $fixture
};
function Get-CarebridgeExactFirewallRule([string]$Name,[string]$Store) {
  if($Store -cnotin @('PersistentStore','ActiveStore')){throw 'MOCK_STORE_MISMATCH'};
  if($case.StartsWith('absence')){return};
  if($Name -cne $expectedName){throw 'MOCK_RULE_NAME_MISMATCH'};
  if($case -ceq 'persistent-query') {throw 'SYNTHETIC_PRIVATE_PROVIDER_ERROR'};
  if($case -ceq 'active-query' -and $Store -ceq 'ActiveStore'){throw 'SYNTHETIC_PRIVATE_PROVIDER_ERROR'};
  return [pscustomobject]@{Name=$Name;Store=$Store}
};
function Get-CarebridgeFirewallSnapshot($Rule) {
  if($case -ceq 'snapshot-error' -or ($case -ceq 'active-snapshot' -and $Rule.Store -ceq 'ActiveStore')){throw 'SYNTHETIC_PRIVATE_SNAPSHOT_ERROR'};
  $action=if($case -ceq 'field-mismatch' -or ($case -ceq 'active-rule' -and $Rule.Store -ceq 'ActiveStore')){'Block'}else{'Allow'};
  $remote=if($case -ceq 'network-mismatch' -or ($case -ceq 'active-network' -and $Rule.Store -ceq 'ActiveStore')){'Any'}else{$inputData.peer};
  $data=[ordered]@{
    Rule=[ordered]@{Name=@($expectedName);Description=@($expectedMarker);Enabled=@('True');Profile=@('Public');Direction=@('Inbound');Action=@($action);EdgeTraversalPolicy=@('Block');PolicyStoreSourceType=@('Local');PolicyStoreSource=@('PersistentStore')};
    Port=[ordered]@{RemotePort=@('Any');Protocol=@('TCP')};
    Application=[ordered]@{Program=@($inputData.program)};
    Address=[ordered]@{LocalAddress=@($inputData.host);RemoteAddress=@($remote)};
    Interface=[ordered]@{InterfaceAlias=@($inputData.alias)};InterfaceType=[ordered]@{InterfaceType=@('Wireless')}
  };
  return [pscustomobject]@{Invariant=($data|ConvertTo-Json -Depth 8 -Compress);LocalPort=@('8443')}
};
# Remaining provider entry points are fixed mocks too; this default-mode fixture
# must not accidentally call the real module or use exception-mode functions.
function Get-NetFirewallRule {
  [CmdletBinding()]param([string]$PolicyStore)
  if($case -cne 'before' -or $PolicyStore -cnotin @('PersistentStore','ActiveStore')){throw 'UNEXPECTED_MOCK_BRANCH'}
};
foreach($name in @('Get-CarebridgeTemporaryBlockSnapshot','Get-CarebridgeExceptionKey','Assert-CarebridgeGuard','Get-NetFirewallApplicationFilter')){
  Set-Item -LiteralPath ('Function:global:'+$name) -Value {throw 'UNEXPECTED_MOCK_BRANCH'} -Options ReadOnly
};
foreach($name in @('New-Object','Get-ScheduledTask','Get-CarebridgeExactFirewallRule','Get-CarebridgeFirewallSnapshot','Get-NetFirewallRule')){
  if((Get-Command $name -CommandType Function).CommandType -ne 'Function'){throw 'MOCK_NOT_BOUND'}
};
if($case.StartsWith('release-')){
  # Exercise the real finally control flow with managed objects only. Replace
  # exactly its two Marshal calls in memory; never change the product source.
  $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-ObserverTaskLookupOutcome'},$true));
  if($definitions.Count -ne 1){throw 'LOOKUP_FUNCTION_SHAPE_CHANGED'};
  $definitionText=$definitions[0].Extent.Text;
  foreach($replacement in @(
    @('[Runtime.InteropServices.Marshal]::IsComObject($owned)','[ObserverMockRelease]::IsComObject($owned)'),
    @('[Runtime.InteropServices.Marshal]::FinalReleaseComObject($owned)','[ObserverMockRelease]::FinalReleaseComObject($owned)')
  )){
    if([regex]::Matches($definitionText,[regex]::Escape($replacement[0])).Count -ne 1){throw 'RELEASE_CALL_SHAPE_CHANGED'};
    $definitionText=$definitionText.Replace($replacement[0],$replacement[1])
  };
  if($definitionText.Contains('[Runtime.InteropServices.Marshal]')){throw 'REAL_MARSHAL_CALL_REMAINS'};
  $null=[Management.Automation.Language.Parser]::ParseInput($definitionText,[ref]$tokens,[ref]$errors);
  if($errors.Count){throw 'RELEASE_FACADE_AST_INVALID'};
  . ([scriptblock]::Create($definitionText));
  [ObserverMockRelease]::FailAt=if($case -ceq 'release-readable-succeeds'){0}else{1};
  $outcome=Get-ObserverTaskLookupOutcome $expectedTaskName;
  $expectedOutcome=if($case -ceq 'release-readable-succeeds'){'readable'}else{'unavailable'};
  $expectedAttempts=if($case -ceq 'release-task-missing'){'folder,service'}else{'definition,registered,folder,service'};
  if($outcome -cne $expectedOutcome -or ([ObserverMockRelease]::Attempts -join ',') -cne $expectedAttempts){throw 'RELEASE_OUTCOME_OR_REMAINING_ATTEMPTS_INVALID'};
  [Console]::Out.Write('managed-release-facade-passed');exit 0
};
& ([scriptblock]::Create($body));
`;

for (const [scenario, expectedPhase] of [
  ['active', null], ['before', null], ['absence', null], ['absence-mapped-file', null], ['empty-task', 'task-not-enumerated'], ['many-tasks', 'task-count'],
  ['task-fields', 'task-fields'], ['task-query-denied', 'task-query'],
  ['persistent-query', 'persistent-query'], ['snapshot-error', 'persistent-snapshot'], ['field-mismatch', 'persistent-rule'],
  ['network-mismatch', 'persistent-network'], ['active-query', 'active-query'], ['active-snapshot', 'active-snapshot'],
  ['active-rule', 'active-rule'], ['active-network', 'active-network'], ['task-action', 'task-action'], ['task-trigger', 'task-trigger'],
  ['lookup-task-missing','task-not-found'], ['lookup-task-path-missing','task-not-found'],
  ['lookup-task-denied','task-access-denied'], ['lookup-task-unknown','task-query-unavailable'],
  ['lookup-task-spoof','task-query-unavailable'], ['lookup-task-wrapped','task-not-found'],
  ['lookup-mapped-file','task-not-found'], ['lookup-mapped-directory','task-not-found'], ['lookup-mapped-access','task-access-denied'],
  ['lookup-mapped-file-wrong-code','task-query-unavailable'], ['lookup-connect-mapped-file','task-query-unavailable'],
  ['lookup-connect-missing','task-query-unavailable'], ['lookup-connect-denied','task-access-denied'],
  ['lookup-folder-missing','task-query-unavailable'], ['lookup-folder-denied','task-access-denied'],
  // This managed property getter loses its COM error in PowerShell and returns
  // null; only the product null guard's generic RuntimeException is observable.
  ['lookup-definition-missing','task-query-unavailable'], ['lookup-definition-denied','task-query-unavailable'],
  ['lookup-definition-null','task-query-unavailable'], ['absence-readable','task-not-enumerated'],
  ['absence-task-denied','task-access-denied'], ['absence-task-unknown','task-query-unavailable'],
  ['absence-task-spoof','task-query-unavailable'], ['absence-connect-missing','task-query-unavailable'],
  ['absence-definition-missing','task-query-unavailable'],
  ['release-readable-fails',null], ['release-task-missing',null], ['release-readable-succeeds',null],
  ['separate-active',null], ['separate-before','input'], ['separate-after','input'], ['separate-exception','input'],
  ['separate-empty-id','input'], ['separate-invalid-id','input'], ['separate-unknown','input']
]) {
  test(`read-only observer mock ${scenario} keeps checks and reports only bounded phase`, t => {
    if (process.platform !== 'win32' || !process.env.CAREBRIDGE_TEST_POWERSHELL) return t.skip('Explicit PowerShell on nonadministrator Windows required; no OS provider calls.');
    const powershell = process.env.CAREBRIDGE_TEST_POWERSHELL;
    assert.match(powershell, /^[A-Za-z]:[\\/].*[\\/]pwsh\.exe$/i);
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...privateSecretEnvironment(process.env, powershell), CAREBRIDGE_OBSERVER_SOURCE: observerFile,
        CAREBRIDGE_OBSERVER_SHA256: createHash('sha256').update(observerSource).digest('hex').toUpperCase(),
        CAREBRIDGE_TASK_SHAPE_SOURCE: taskShapeFile,
        CAREBRIDGE_TASK_SHAPE_SHA256: createHash('sha256').update(taskShapeSource).digest('hex').toUpperCase(),
        CAREBRIDGE_OBSERVER_BODY: Buffer.from(syntheticWifiLeaseInspectScript).toString('base64'), CAREBRIDGE_OBSERVER_CASE: scenario },
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.stderr, '');
    if(scenario.startsWith('release-')){
      assert.equal(result.status,0);assert.equal(result.stdout,'managed-release-facade-passed');
      return;
    }
    const value = JSON.parse(result.stdout);
    if (expectedPhase) {
      assert.equal(result.status, 1);
      assert.deepEqual(value, { schema: 1, ok: false, phase: expectedPhase });
      assert.equal(syntheticWifiLeaseObserverFailurePhase(value), expectedPhase);
      assert.ok(Buffer.byteLength(result.stdout) <= 128);
      assert.doesNotMatch(result.stdout, /Fixture|10\.231|node\.exe|private|provider|SYNTHETIC_PRIVATE|message|error|account|SYSTEM/i);
    } else {
      assert.equal(result.status, 0);
      assert.deepEqual(value, { schema: 1, ok: true, originalHash: null, invariantHash: null, storesVerified: 2,
        expectedPorts: false, ownRuleEntries: ['active', 'separate-active'].includes(scenario) ? 2 : 0, taskCount: scenario === 'active' ? 1 : 0,
        boundaries: true, taskVerified: !['before', 'separate-active'].includes(scenario) });
    }
  });
}
