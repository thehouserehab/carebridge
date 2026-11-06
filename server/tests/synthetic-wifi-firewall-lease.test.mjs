import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,mkdir,readdir,realpath,rmdir,unlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {win32} from 'node:path';
import {privateSecretEnvironment} from '../windows-private-secret-io.mjs';

// Default checks are static, compiler or managed-memory mocks only. A separate
// opt-in creates CIM trigger objects in memory, never registered tasks. Opted-in
// native regressions run the actual helper as a nonadministrator: cancellation
// has a pre-created stop file; diagnostic cases stop at the administrator guard.
// Call-operator cases additionally shadow OS commands; those functions DO NOT
// propagate into the separate direct -File process. No case elevates.
// Source/AST checks verify the pre-stop/admin boundaries. No test invokes real
// NetSecurity, scheduled-task registration/control, UAC, a socket, or a trust API.
// Native firewall and cleanup lifecycle require a separately approved real run.
const file = fileURLToPath(new URL('../../scripts/synthetic-wifi-firewall-lease.ps1', import.meta.url));
const source = await readFile(file,'utf8');

test('firewall lease fixes port, direction, action, interface and current Public profile', () => {
  const create = source.match(/\$null = New-NetFirewallRule -Name \$ruleName[\s\S]+?-ErrorAction Stop/)?.[0];
  assert.ok(create);
  for (const flag of ['-PolicyStore PersistentStore','-Enabled True','-Profile Public','-Direction Inbound','-Action Allow',
    '-Program $NodeExecutablePath','-Protocol TCP','-LocalPort 8443','-RemotePort Any',
    '-LocalAddress $LocalIPv4','-RemoteAddress $PeerIPv4','-InterfaceAlias $interfaceAlias',
    '-InterfaceType Wireless','-EdgeTraversalPolicy Block']) assert.ok(create.includes(flag),flag);
  assert.equal((source.match(/New-NetFirewallRule -Name/g) ?? []).length,2); // one Allow and one fixed guard loop
  assert.doesNotMatch(source,/Set-NetConnectionProfile|Set-NetFirewallProfile|Set-NetFirewallRule|Enable-NetFirewallRule|Disable-NetFirewallRule|netsh\s/);
});

test('process lease pins an actual Windows handle, creation time and image path without PID adoption', () => {
  for (const token of ['OpenProcess(0x00101000','WaitForSingleObject(handle, milliseconds)',
    'GetProcessTimes(handle','DateTime.FromFileTimeUtc(fileTime).Ticks == ticks',
    'QueryFullProcessImageName(handle','String.Equals(path.ToString(), executable',
    '::PinProcess($OwnerPid,$ownerTicks,$NodeExecutablePath)',
    '::Matches($processHandle,$ownerTicks,$NodeExecutablePath)',
    '::WaitExited($processHandle,500)']) assert.ok(source.includes(token),token);
  assert.doesNotMatch(source,/Get-Process|Stop-Process|Start-Process|taskkill|RunAs/);
});

test('only canonical RFC1918 host and peer on the same active physical Wi-Fi are accepted', () => {
  for (const token of ['Assert-PrivateIPv4 $LocalIPv4','Assert-PrivateIPv4 $PeerIPv4',
    "$LocalIPv4 -ceq $PeerIPv4",'Get-NetAdapter -Physical','NdisPhysicalMedium -notin @(1,9)',
    "NetworkCategory -cne 'Public'", "AddressState -eq 'Preferred'",'Get-NetIPAddress -InterfaceIndex $InterfaceIndex',
    '$localBytes[$byte] -band $mask','$peerBytes[$byte] -band $mask']) assert.ok(source.includes(token),token);
  assert.doesNotMatch(source,/192\.168\.0\.(?:15|32)/);
});

test('lease metadata uses a fresh UUID directory and protected existing handles, never adopts paths or status', () => {
  for (const token of ["^carebridge-synthetic-wifi-",'[IO.Directory]::EnumerateFileSystemEntries($ControlDirectory)',
    "[IO.Path]::Combine($ControlDirectory,'status.json')","[IO.Path]::Combine($ControlDirectory,'stop')",
    'Pin-DirectoryChain $ControlDirectory','GetFileInformationByHandle(handle','info.Links != 1',
    '(info.Attributes & 0x400) != 0','GetFinalPathNameByHandle(handle','0x02200000','0x80200000',
    'CreateFile(path, 0xC0000000, 1, IntPtr.Zero, 1','CheckFile($statusStream.SafeFileHandle',
    "@('active','removed','failed')"]) assert.ok(source.includes(token),token);
  assert.doesNotMatch(source,/Get-Content|ReadAllText|ReadAllBytes|Remove-Item|Move-Item|Set-Content|Out-File/);
});

test('new unique rule is read back with all narrowing filters and idempotent own-object cleanup', () => {
  for (const token of ['Get-NetFirewallApplicationFilter','Get-NetFirewallAddressFilter','Get-NetFirewallPortFilter',
    'Get-NetFirewallInterfaceFilter','Get-NetFirewallInterfaceTypeFilter',"Assert-OneValue $ports[0].LocalPort '8443'",
    'Assert-AddressValue $addresses[0].LocalAddress $LocalIPv4','Assert-AddressValue $addresses[0].RemoteAddress $PeerIPv4',
    'Assert-OneValue $interfaces[0].InterfaceAlias $Alias',"Assert-OneValue $types[0].InterfaceType 'Wireless'",
    'Assert-RuleBoundary $rules[0] $interfaceAlias','Assert-RuleBoundary $activeRules[0] $interfaceAlias',
    'foreach ($scope in @($Rule,$applications[0],$addresses[0]))',"@('RemoteDynamicKeywordAddresses','PolicyAppId')",
    '$owned[0] | Remove-NetFirewallRule -ErrorAction Stop']) assert.ok(source.includes(token),token);
  assert.ok(source.indexOf("@(Get-ExactRule 'PersistentStore').Count -ne 0 -or @(Get-ExactRule 'ActiveStore').Count -ne 0") < source.indexOf('$creationStarted = $true'));
  assert.doesNotMatch(source,/Remove-NetFirewallRule\s+-(?:Name|DisplayName|Group)|-Name\s+['"]?Carebridge\*/);
});

test('deadline/stop/process loss cleanup is bounded and removal is never reported before verification', () => {
  for (const token of ['[ValidateRange(60,7200)]','[Diagnostics.Stopwatch]::StartNew()',
    '$timer.Elapsed.TotalSeconds -lt $MaxLifetimeSeconds',"EnumerateFileSystemEntries($ControlDirectory,'stop',[IO.SearchOption]::TopDirectoryOnly)",
    'if (Test-StopRequested) { break }', '$nextBoundaryCheck = $timer.Elapsed.TotalSeconds + 5.0',
    '$cleanupVerified = $true',"if ($cleanupVerified -and $taskCleanupVerified) { Write-LeaseStage 'removed' }",
    "else { Write-LeaseStage 'failed' }"]) assert.ok(source.includes(token),token);
  assert.ok(source.lastIndexOf('$cleanupVerified = $true') < source.indexOf("Write-LeaseStage 'removed'"));
});

test('independent SYSTEM cleanup is registered and verified before any inbound rule is created', () => {
  for (const token of ['New-ScheduledTaskTrigger -Once -At $Deadline','New-ScheduledTaskTrigger -AtStartup',
    'New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    "New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    '[Environment]::GetFolderPath([Environment+SpecialFolder]::System)',"'WindowsPowerShell\\v1.0\\powershell.exe'",
    '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand',
    "MSFT_TaskTimeTrigger","MSFT_TaskBootTrigger",'Assert-CleanupTask $tasks[0]']) assert.ok(source.includes(token),token);
  assert.ok(source.indexOf('Register-CleanupTask $deadline') < source.indexOf('$creationStarted = $true'));
  assert.ok(source.includes('$taskRegistrationStarted -and $cleanupVerified'));
  assert.doesNotMatch(source,/Register-ScheduledTask[^\r\n]*-Force|Start-ScheduledTask|Set-ScheduledTask/);
  const factory=source.slice(source.indexOf('function New-CleanupTimeTrigger'),source.indexOf('function Register-CleanupTask'));
  assert.ok(factory.includes('$onceTrigger.Repetition.StopAtDurationEnd = $false'));
  assert.ok(source.includes('$triggers = @((New-CleanupTimeTrigger $Deadline),'));
  assert.ok(source.includes('$once[0].Repetition.StopAtDurationEnd -or'));
});

test('in-memory cleanup trigger factory matches strict task readback and rejects trigger drift',t=>{
  if(process.platform!=='win32'||process.env.CAREBRIDGE_TEST_IN_MEMORY_TASK_TRIGGER!=='1') {
    return t.skip('Opt in with CAREBRIDGE_TEST_IN_MEMORY_TASK_TRIGGER=1 on nonadministrator Windows; no task registration.');
  }
  const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
  assert.match(powershell??'',/^[A-Za-z]:[\\/].*[\\/]pwsh\.exe$/i);
  const command=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();try{
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NONADMIN_REQUIRED'}
}finally{$identity.Dispose()};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_LEASE_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_LEASE_SHA256){throw 'SOURCE_CHANGED'};
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:CAREBRIDGE_LEASE_SOURCE,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_AST'};
# Extract two named definitions only. Never invoke/dot-source the helper body.
foreach($functionName in @('New-CleanupTimeTrigger','Assert-CleanupTask')){
  $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName},$true));
  if($definitions.Count -ne 1){throw 'FUNCTION_SHAPE_CHANGED'};
  $allowed=if($functionName -ceq 'New-CleanupTimeTrigger'){@('New-ScheduledTaskTrigger')}else{@('Where-Object')};
  foreach($node in $definitions[0].FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
    if($node.GetCommandName() -cnotin $allowed){throw 'FUNCTION_OS_SCOPE_CHANGED'}
  };
  . ([scriptblock]::Create($definitions[0].Extent.Text))
};
# In-memory factory is the sole allowed ScheduledTasks command. Block every
# other task/network command in the helper, plus process/UAC launch paths.
$blocked=@('Start-Process','Start-Job','Start-ThreadJob','Invoke-Command','Invoke-Expression','netsh','netsh.exe','schtasks','schtasks.exe',
  'Register-ScheduledTask','Set-ScheduledTask','Unregister-ScheduledTask','Start-ScheduledTask','Stop-ScheduledTask',
  'Get-ScheduledTask','Get-ScheduledTaskInfo','Enable-ScheduledTask','Disable-ScheduledTask','Invoke-CimMethod','Set-CimInstance',
  'New-CimInstance','Remove-CimInstance','Get-CimInstance','Get-WmiObject','Invoke-WebRequest','Invoke-RestMethod');
foreach($node in $ast.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
  $name=$node.GetCommandName();if($name -and $name -match '(?i)(?:^|-)(?:Net|ScheduledTask)' -and $name -cne 'New-ScheduledTaskTrigger'){$blocked+=,$name}
};
$global:BlockedTriggerTestCalls=0;
foreach($name in @($blocked | Sort-Object -Unique)){
  Set-Item -LiteralPath ('Function:global:'+$name) -Value {$global:BlockedTriggerTestCalls++;throw 'OS_COMMAND_FORBIDDEN_IN_TRIGGER_TEST'} -Options ReadOnly
};
$deadline=[DateTime]::Now.AddSeconds(180);$taskName='synthetic-task-fixture';$ruleMarker='synthetic-marker';
$taskExecutable='synthetic-executable';$taskArguments='synthetic-arguments';
function New-TriggerTaskFixture {
  $once=New-CleanupTimeTrigger $deadline;
  if($once.Repetition.StopAtDurationEnd -or [string]$once.Repetition.Duration -cne ''){throw 'FACTORY_REPETITION_INVALID'};
  return [pscustomobject]@{
    TaskName=$taskName;TaskPath='\';Description=$ruleMarker;
    Actions=@([pscustomobject]@{Execute=$taskExecutable;Arguments=$taskArguments});
    Principal=[pscustomobject]@{UserId='SYSTEM';RunLevel='Highest';LogonType='ServiceAccount'};
    Settings=[pscustomobject]@{StartWhenAvailable=$true;Enabled=$true;DisallowStartIfOnBatteries=$false;StopIfGoingOnBatteries=$false;ExecutionTimeLimit='PT5M';MultipleInstances='IgnoreNew'};
    Triggers=@($once,(New-ScheduledTaskTrigger -AtStartup -ErrorAction Stop))
  }
};
$fixture=New-TriggerTaskFixture;Assert-CleanupTask $fixture;
$changes=@(
  {param($task)$task.Triggers[0].Repetition.StopAtDurationEnd=$true},
  {param($task)$task.Triggers[0].StartBoundary=$deadline.AddMinutes(1).ToString('s')},
  {param($task)$task.Triggers[0].Repetition.Duration='PT2M'},
  {param($task)$task.Triggers[0].EndBoundary=$deadline.AddMinutes(5).ToString('s')},
  {param($task)$task.Triggers[0].Repetition.Interval='PT2M'},
  {param($task)$task.Triggers[1].Enabled=$false}
);
foreach($change in $changes){
  $fixture=New-TriggerTaskFixture;& $change $fixture;$rejected=$false;
  try{Assert-CleanupTask $fixture}catch{$rejected=$true};
  if(-not $rejected){throw 'TRIGGER_DRIFT_ACCEPTED'}
};
if($global:BlockedTriggerTestCalls -ne 0){throw 'OS_COMMAND_ATTEMPTED'};
[Console]::Out.Write('in-memory-trigger-and-six-drift-checks-passed');
`;
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{
    env:{...privateSecretEnvironment(process.env,powershell),CAREBRIDGE_LEASE_SOURCE:file,
      CAREBRIDGE_LEASE_SHA256:createHash('sha256').update(source).digest('hex').toUpperCase()},
    encoding:'utf8',timeout:30_000,maxBuffer:16_384,windowsHide:true,shell:false
  });
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');assert.equal(result.stdout,'in-memory-trigger-and-six-drift-checks-passed');
});

test('shared overlapping firewall policy is rechecked after UAC, before active and while leased',()=>{
  assert.ok(source.includes(". (Join-Path $PSScriptRoot 'synthetic-wifi-firewall-policy.ps1')"));
  assert.ok(source.includes('-ExcludeRuleName $ruleName'));
  assert.equal((source.match(/Assert-NoOverlappingFirewallRule \$interfaceAlias/g)??[]).length,4);
  assert.ok(source.indexOf('Assert-NoOverlappingFirewallRule $interfaceAlias')<source.indexOf('$creationStarted = $true'));
  const afterAudit=source.slice(source.indexOf('# Recheck after UAC'),source.indexOf('$creationStarted = $true'));
  assert.ok(afterAudit.includes('::Matches($processHandle,$ownerTicks,$NodeExecutablePath)'));
  assert.ok(afterAudit.includes('Test-StopRequested'));
  assert.ok(afterAudit.includes('$timer.Elapsed.TotalSeconds -ge $MaxLifetimeSeconds'));
  assert.ok(source.lastIndexOf('Assert-NoOverlappingFirewallRule $interfaceAlias')>source.indexOf('while ($timer.Elapsed.TotalSeconds'));
  const periodic=source.slice(source.indexOf('while ($timer.Elapsed.TotalSeconds'),source.indexOf('} catch {\n    $failed = $true'));
  assert.ok(periodic.includes("foreach ($store in @('PersistentStore','ActiveStore'))"));
  assert.ok(periodic.includes('$current = @(Get-ExactRule $store)'));
});

test('SYSTEM cleanup action contains only fixed code plus UUID-derived identifiers and no disk script', () => {
  const command = source.match(/\$command = @'\r?\n([\s\S]+?)\r?\n'@/)?.[1];
  assert.ok(command);
  for (const token of ['__RULE__','__MARKER__','__TASK__',
    "$rules[0] | Remove-NetFirewallRule -ErrorAction Stop",
    "@('PersistentStore','ActiveStore')",'Unregister-ScheduledTask']) assert.ok(command.includes(token),token);
  assert.doesNotMatch(command,/\.ps1|-File|Get-Content|Invoke-Expression|Invoke-WebRequest|ControlDirectory|NodeExecutablePath|LocalIPv4|PeerIPv4/);
  const substitution = source.match(/\$command = \$command\.Replace[^\r\n]+/)?.[0];
  assert.equal((substitution.match(/\.Replace\('__\w+__'/g) ?? []).length,3);
});

test('PowerShell AST and embedded native code compile without running helper or changing OS state', t => {
  if (process.platform !== 'win32') return t.skip('Windows compiler check requires Windows; static invariants ran.');
  const powershell = process.env.CAREBRIDGE_TEST_POWERSHELL;
  if (!powershell) return t.skip('Set explicit CAREBRIDGE_TEST_POWERSHELL; no PATH executable fallback.');
  assert.match(powershell,/^[A-Za-z]:[\\/].*[\\/]pwsh\.exe$/i);
  const command = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile($env:CAREBRIDGE_LEASE_SOURCE,[ref]$tokens,[ref]$errors); if($errors.Count){throw 'AST_FAILED'}; $type=$ast.Find({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true); Add-Type -TypeDefinition $type.CommandElements[2].Value; $inner=$ast.Find({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$command' -and $n.Right.Extent.Text.StartsWith("@'" )},$true); if($null -eq $inner){throw 'ACTION_MISSING'}; $value=$inner.Right.Expression.Value; $innerAst=[System.Management.Automation.Language.Parser]::ParseInput($value,[ref]$tokens,[ref]$errors); if($errors.Count){throw 'ACTION_AST_FAILED'}; [Console]::Out.Write('compiled-only')`;
  const result = spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{
    env:{...process.env,CAREBRIDGE_LEASE_SOURCE:file},encoding:'utf8',timeout:30_000,maxBuffer:16_384,windowsHide:true
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'compiled-only');
});

test('pre-created cancellation precedes administrator, network and task initialization',()=>{
  const normalized=source.replaceAll('\r\n','\n');
  const mainStart=normalized.indexOf('\ntry {\n');
  assert.ok(mainStart>=0);
  const main=normalized.slice(mainStart);
  const cancellation='if (Test-StopRequested) { $cleanupVerified = $true; $taskCleanupVerified = $true; return }';
  assert.ok(main.indexOf(cancellation)>main.indexOf('::CreateStatus($statusPath)'));
  for(const later of ['$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$adminVerified = $true','$interfaceAlias = Assert-NetworkBoundary','Initialize-BlockException','Register-CleanupTask $deadline']) {
    assert.ok(main.indexOf(cancellation)<main.indexOf(later),later);
  }
  assert.ok(source.includes('} elseif ($adminVerified) {'));
  assert.ok(source.includes('} elseif (-not $taskRegistrationStarted -and $adminVerified) {'));
  assert.doesNotMatch(source,/\$args\.Count/);
  assert.ok(source.includes('[CmdletBinding()]'));
});

test('failure sidecar is bounded enum-only evidence and cannot change cleanup receipts',()=>{
  const diagnostic=source.slice(source.indexOf('function Write-FailureDiagnostic'),source.indexOf('function Test-StopRequested'));
  assert.ok(diagnostic.includes('if (-not $failed -or $null -eq $statusStream) { return }'));
  assert.ok(diagnostic.includes('CheckFile($statusStream.SafeFileHandle,$statusPath,$false)'));
  assert.ok(diagnostic.includes("[IO.Path]::Combine($ControlDirectory,'failure.json')"));
  assert.ok(diagnostic.includes('::CreateStatus($diagnosticPath)'));
  assert.ok(diagnostic.includes('CheckFile($diagnosticStream.SafeFileHandle,$diagnosticPath,$false)'));
  assert.ok(diagnostic.includes('[ordered]@{schema=1;phase=$phase;cleanup=$cleanup;flags=$flags;line=$line}'));
  assert.ok(diagnostic.includes('$bytes.Length -gt 256'));
  assert.ok(diagnostic.includes('$flags -lt 0 -or $flags -gt 63'));
  assert.ok(diagnostic.includes('$firstFailurePhase -cin $phases'));
  assert.ok(diagnostic.includes('$firstCleanupFailure -cin $cleanupPhases'));
  assert.ok(diagnostic.includes("$line = if ($firstFailurePhase -cne 'none') { $firstFailureLine } else { $firstCleanupFailureLine }"));
  assert.ok(diagnostic.includes('$line -isnot [int] -or $line -lt 0 -or $line -gt 99999'));
  assert.ok(diagnostic.includes('} catch { } finally {'));
  assert.doesNotMatch(diagnostic,/\$_|\$Error|Exception|Message|StackTrace|\$env:|\$OwnerPid|\$LocalIPv4|\$PeerIPv4|DateTime/);
  assert.doesNotMatch(diagnostic,/\$(?:failed|cleanupVerified|taskCleanupVerified)\s*=/);
  assert.match(source,/if \(\$firstFailurePhase -ceq 'none'\) \{\s*\$firstFailurePhase = \$currentFailurePhase\s*\$firstFailureLine = Get-FailureSourceLine \$failureRecord/);
  assert.match(source,/if \(\$firstCleanupFailure -ceq 'none'\) \{\s*\$firstCleanupFailure = \$cleanupObservationPhase\s*\$firstCleanupFailureLine = Get-FailureSourceLine \$cleanupRecord/);
  const location=source.slice(source.indexOf('function Get-FailureSourceLine'),source.indexOf('function Write-FailureDiagnostic'));
  assert.ok(location.includes('try {'));assert.ok(location.includes('catch { return 0 }'));
  assert.ok(location.includes('[int]$Record.InvocationInfo.ScriptLineNumber'));
  assert.doesNotMatch(location,/ScriptName|\.Message|StackTrace|FullyQualifiedErrorId/);
  assert.ok(source.includes("if ($cleanupVerified -and $taskCleanupVerified) { Write-LeaseStage 'removed' }"));
  assert.ok(source.lastIndexOf('Write-FailureDiagnostic')<source.indexOf('$statusStream.Dispose()'));
});

test('diagnostic writer retains first enums and swallows exclusive-create failure without changing cleanup state',t=>{
  if(process.platform!=='win32'||!process.env.CAREBRIDGE_TEST_POWERSHELL) return t.skip('Explicit PowerShell runtime required for managed-only mock.');
  const command=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:CAREBRIDGE_LEASE_SOURCE,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_AST'};
foreach($functionName in @('Get-FailureSourceLine','Write-FailureDiagnostic')){
  $definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName},$true);
  . ([scriptblock]::Create($definition.Extent.Text))
};
foreach($sample in @($null,[pscustomobject]@{},[pscustomobject]@{InvocationInfo=$null},
  [pscustomobject]@{InvocationInfo=[pscustomobject]@{ScriptLineNumber=-1}},
  [pscustomobject]@{InvocationInfo=[pscustomobject]@{ScriptLineNumber=100000}},
  [pscustomobject]@{InvocationInfo=[pscustomobject]@{ScriptLineNumber='not-an-integer'}})){
  if((Get-FailureSourceLine $sample) -ne 0){throw 'LINE_OBSERVATION_NOT_BOUNDED'}
};
if((Get-FailureSourceLine ([pscustomobject]@{InvocationInfo=[pscustomobject]@{ScriptLineNumber=321}})) -ne 321){throw 'LINE_OBSERVATION_MISSING'};
# Managed-only stub: no P/Invoke, filesystem, policy provider or helper body.
Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class DiagnosticMemoryFile : IDisposable {
  public object SafeFileHandle { get { return this; } }
  public void Write(byte[] bytes,int offset,int count) { CarebridgeWifiLeaseNative.Bytes=new byte[count]; Array.Copy(bytes,offset,CarebridgeWifiLeaseNative.Bytes,0,count); }
  public void Flush(bool durable) { }
  public void Dispose() { }
}
public static class CarebridgeWifiLeaseNative {
  public static bool RejectCreate, RejectCheck;
  public static int Creates;
  public static byte[] Bytes;
  public static void CheckFile(object handle,string path,bool directory) { if(RejectCheck) throw new IOException(); }
  public static DiagnosticMemoryFile CreateStatus(string path) { Creates++; if(RejectCreate) throw new IOException(); return new DiagnosticMemoryFile(); }
}
'@;
$statusStream=[pscustomobject]@{SafeFileHandle=[object]::new()};$statusPath='fixture-status';$ControlDirectory='C:\synthetic-diagnostic';
$failed=$true;$adminVerified=$true;$taskRegistrationStarted=$true;$creationStarted=$true;$exceptionArmed=$false;$cleanupVerified=$false;$taskCleanupVerified=$true;
$firstFailurePhase='owner-pin';$firstCleanupFailure='task-query';$firstFailureLine=321;$firstCleanupFailureLine=654;Write-FailureDiagnostic;
$text=[Text.Encoding]::UTF8.GetString([CarebridgeWifiLeaseNative]::Bytes);$value=$text | ConvertFrom-Json;
if($text.Length -gt 256 -or $value.schema -ne 1 -or $value.phase -cne 'owner-pin' -or $value.cleanup -cne 'task-query' -or $value.flags -ne 39 -or $value.line -ne 321){throw 'PAYLOAD_INVALID'};
if((@($value.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'cleanup,flags,line,phase,schema'){throw 'UNEXPECTED_DIAGNOSTIC_FIELDS'};
$before=[Convert]::ToBase64String([CarebridgeWifiLeaseNative]::Bytes);
[CarebridgeWifiLeaseNative]::RejectCreate=$true;$firstFailurePhase='network';Write-FailureDiagnostic;
if([CarebridgeWifiLeaseNative]::Creates -ne 2 -or [Convert]::ToBase64String([CarebridgeWifiLeaseNative]::Bytes) -cne $before){throw 'EXCLUSIVE_WRITE_CHANGED_EXISTING_DATA'};
if(-not $failed -or $cleanupVerified -or -not $taskCleanupVerified){throw 'DIAGNOSTIC_CHANGED_RECEIPT_FLAGS'};
[CarebridgeWifiLeaseNative]::RejectCheck=$true;Write-FailureDiagnostic;
if([CarebridgeWifiLeaseNative]::Creates -ne 2){throw 'UNPINNED_DIAGNOSTIC_CREATED'};
[CarebridgeWifiLeaseNative]::RejectCreate=$false;[CarebridgeWifiLeaseNative]::RejectCheck=$false;
$firstFailurePhase='10.231.9.10 synthetic secret';$firstCleanupFailure='C:\synthetic-private';Write-FailureDiagnostic;
$value=[Text.Encoding]::UTF8.GetString([CarebridgeWifiLeaseNative]::Bytes) | ConvertFrom-Json;
if($value.phase -cne 'unknown' -or $value.cleanup -cne 'unknown'){throw 'ARBITRARY_DIAGNOSTIC_TEXT'};
$firstFailurePhase='none';$firstCleanupFailure='task-query';Write-FailureDiagnostic;
$value=[Text.Encoding]::UTF8.GetString([CarebridgeWifiLeaseNative]::Bytes) | ConvertFrom-Json;
if($value.line -ne 654){throw 'CLEANUP_LOCATION_FALLBACK_MISSING'};
$firstFailurePhase='network';$firstFailureLine=100000;Write-FailureDiagnostic;
$value=[Text.Encoding]::UTF8.GetString([CarebridgeWifiLeaseNative]::Bytes) | ConvertFrom-Json;
if($value.line -ne 0){throw 'OUT_OF_RANGE_LOCATION_WRITTEN'};
$failed=$false;Write-FailureDiagnostic;
if([CarebridgeWifiLeaseNative]::Creates -ne 5){throw 'SUCCESS_CREATED_DIAGNOSTIC'};
$failed=$true;$statusStream=$null;Write-FailureDiagnostic;
if([CarebridgeWifiLeaseNative]::Creates -ne 5){throw 'MISSING_STATUS_CREATED_DIAGNOSTIC'};
[Console]::Out.Write('diagnostic-managed-mock-passed');
`;
  const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{
    env:{...privateSecretEnvironment(process.env,powershell),CAREBRIDGE_LEASE_SOURCE:file},encoding:'utf8',timeout:30_000,maxBuffer:16_384,windowsHide:true,shell:false
  });
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');assert.equal(result.stdout,'diagnostic-managed-mock-passed');
});

for(const entry of ['call-operator','direct-file','unknown-named','extra-positional','admin-rejection','admin-rejection-file']) {
const rejectsArguments=['unknown-named','extra-positional'].includes(entry);
const rejectsAdmin=entry.startsWith('admin-rejection');
const usesCallOperator=['call-operator','admin-rejection'].includes(entry);
test(`native pre-cancelled helper ${entry} ${rejectsArguments?'rejects arguments before creating status':rejectsAdmin?'records bounded failure without stop':'creates status and exits removed'} without elevation or OS policy calls`,async t=>{
  if(process.platform!=='win32'||process.env.CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE!=='1') {
    return t.skip('Opt in with CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1 on nonadministrator Windows.');
  }
  const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
  assert.match(powershell??'',/^[A-Za-z]:[\\/].*[\\/]pwsh\.exe$/i);
  assert.equal(win32.basename(process.execPath),'node.exe');
  const childEnvironment=privateSecretEnvironment(process.env,powershell);
  const nonadmin=String.raw`$ErrorActionPreference='Stop';$identity=[Security.Principal.WindowsIdentity]::GetCurrent();try{$principal=[Security.Principal.WindowsPrincipal]::new($identity);if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NONADMIN_REQUIRED'};[Console]::Out.Write('nonadmin')}finally{$identity.Dispose()}`;
  const preflight=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',nonadmin],{
    env:childEnvironment,encoding:'utf8',timeout:15_000,maxBuffer:16_384,windowsHide:true,shell:false
  });
  // This check happens BEFORE creating any test directory or invoking helper.
  assert.equal(preflight.error,undefined);assert.equal(preflight.status,0,preflight.stderr);
  assert.equal(preflight.stdout,'nonadmin');assert.equal(preflight.stderr,'');

  const temporaryRoot=await realpath(tmpdir());
  const directory=win32.join(temporaryRoot,`carebridge-synthetic-wifi-${randomUUID()}`);
  assert.equal(win32.dirname(directory),temporaryRoot);
  assert.ok(directory.length<=240);
  for(let path=temporaryRoot;;path=win32.dirname(path)) {
    const stat=await lstat(path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
    assert.equal((await realpath(path)).toLowerCase(),path.toLowerCase());
    if(win32.dirname(path)===path) break;
  }
  await mkdir(directory,{recursive:false}); // UUID name; an existing folder is never adopted.
  const directoryIdentity=await lstat(directory);
  const stop=win32.join(directory,'stop'),status=win32.join(directory,'status.json');
  let observedExit=false;
  try {
    if(!rejectsAdmin) await writeFile(stop,'',{flag:'wx'});
    assert.deepEqual(await readdir(directory),rejectsAdmin?[]:['stop']);
    const command=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();try{
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NONADMIN_REQUIRED'}
}finally{$identity.Dispose()};
if((Get-FileHash -LiteralPath $env:CAREBRIDGE_LEASE_SOURCE -Algorithm SHA256).Hash -cne $env:CAREBRIDGE_LEASE_SHA256){throw 'SOURCE_CHANGED'};
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:CAREBRIDGE_LEASE_SOURCE,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'INVALID_HELPER_AST'};
$main=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
if($main.Count -ne 1){throw 'UNEXPECTED_HELPER_FLOW'};
$statements=@($main[0].Body.Statements);
$cancel=@($statements | Where-Object {$_.Extent.Text -ceq 'if (Test-StopRequested) { $cleanupVerified = $true; $taskCleanupVerified = $true; return }'});
if($cancel.Count -ne 1){throw 'CANCELLATION_GUARD_MISSING'};
$before=@($statements | Where-Object {$_.Extent.StartOffset -lt $cancel[0].Extent.StartOffset});
if(($before.Extent.Text -join ' ') -match 'WindowsIdentity|adminVerified|Assert-NetworkBoundary|Initialize-BlockException|Register-CleanupTask|New-Net|Set-Net|Remove-Net'){throw 'UNSAFE_CANCELLATION_ORDER'};
$admin=@($statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst] -and $_.Body.Extent.Text.Contains('WindowsBuiltInRole]::Administrator')});
if($admin.Count -ne 1 -or $admin[0].Extent.StartOffset -le $cancel[0].Extent.StartOffset -or
  -not $admin[0].Body.Extent.Text.Contains('if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw ''SYNTHETIC_WIFI_LEASE_UNAVAILABLE'' }')){throw 'ADMIN_BOUNDARY_CHANGED'};
foreach($statement in $statements){
  if($statement.Extent.Text -match '^\$interfaceAlias = Assert-NetworkBoundary|^if \(\$TemporaryTcpBlockRule|^Register-CleanupTask|^\$null = New-NetFirewallRule'){
    if($statement.Extent.StartOffset -le $admin[0].Extent.EndOffset){throw 'OS_ACTION_BEFORE_ADMIN_BOUNDARY'}
  }
};
if($ast.Extent.Text -match '(?i)RunAs|Start-Process|ProcessStartInfo|Process\]\s*::\s*Start|Process\.Start|ShellExecute|CreateProcess|WinExec|WScript\.Shell|Shell\.Application'){throw 'HELPER_CAN_START_OR_ELEVATE_PROCESS'};
$native=$ast.Find({param($node)$node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$statusStream' -and $node.Right.Extent.Text -like '*::CreateStatus*'},$true);
if($null -eq $native -or $native.Extent.StartOffset -ge $cancel[0].Extent.StartOffset){throw 'STATUS_NOT_EXERCISED'};
$allAsts=@($ast);
foreach($name in @('synthetic-wifi-firewall-policy.ps1','synthetic-wifi-firewall-exception.ps1')){
  $path=Join-Path ([IO.Path]::GetDirectoryName($env:CAREBRIDGE_LEASE_SOURCE)) $name;
  $dependency=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors);
  if($errors.Count -or @($dependency.EndBlock.Statements | Where-Object {$_ -isnot [Management.Automation.Language.FunctionDefinitionAst]}).Count -ne 0){throw 'DEPENDENCY_HAS_TOP_LEVEL_ACTION'};
  $allAsts+=,$dependency
};
$names=@('Start-Process','Start-Job','Start-ThreadJob','Invoke-Command','Invoke-Expression','netsh','netsh.exe','schtasks','schtasks.exe',
  'Get-NetFirewallRule','Get-NetFirewallApplicationFilter','Get-NetFirewallAddressFilter','Get-NetFirewallPortFilter',
  'Get-NetFirewallInterfaceFilter','Get-NetFirewallInterfaceTypeFilter','Get-NetFirewallServiceFilter','Get-NetFirewallSecurityFilter',
  'Get-NetFirewallProfile','Get-NetAdapter','Get-NetIPAddress','Get-NetConnectionProfile',
  'Invoke-WebRequest','Invoke-RestMethod','Test-NetConnection','New-PSSession','Enter-PSSession','curl','curl.exe','wget',
  'Invoke-CimMethod','Set-CimInstance','New-CimInstance','Remove-CimInstance','Get-CimInstance','Get-WmiObject');
foreach($tree in $allAsts){
  foreach($node in $tree.FindAll({param($item)$item -is [Management.Automation.Language.CommandAst]},$true)){
    $name=$node.GetCommandName();
    if($name -and $name -match '(?i)(?:^|-)(?:Net|ScheduledTask)'){
      if($name -match '[\\/]'){throw 'MODULE_QUALIFIED_OS_COMMAND'};$names+=,$name
    }
  }
};
$global:CarebridgeBlockedNativeCalls=0;
foreach($name in @($names | Sort-Object -Unique)){
  Set-Item -LiteralPath ('Function:global:'+$name) -Value {$global:CarebridgeBlockedNativeCalls++;throw 'OS_COMMAND_FORBIDDEN_IN_CANCEL_TEST'} -Options ReadOnly;
  if((Get-Command $name -CommandType Function).CommandType -ne 'Function'){throw 'SHADOW_MISSING'}
};
$entries=@([IO.Directory]::EnumerateFileSystemEntries($env:CAREBRIDGE_CANCEL_DIRECTORY));
if($env:CAREBRIDGE_CANCEL_ENTRY -cin @('admin-rejection','admin-rejection-file')){
  if($entries.Count -ne 0){throw 'FAILURE_DIRECTORY_NOT_FRESH'}
}elseif($entries.Count -ne 1 -or [IO.Path]::GetFileName($entries[0]) -cne 'stop'){throw 'CANCEL_DIRECTORY_NOT_FRESH'};
$owner=[Diagnostics.Process]::GetProcessById([int]$env:CAREBRIDGE_CANCEL_OWNER_PID);
try{$ticks=$owner.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}finally{$owner.Dispose()};
if($env:CAREBRIDGE_CANCEL_ENTRY -cnotin @('call-operator','admin-rejection')){
  # This process only verifies source/AST, nonadmin identity and fresh stop.
  # Its throwing functions are NOT inherited by the next direct -File child.
  [Console]::Out.Write((@{stage='prepared-nonadmin-file-entry';ownerTicks=$ticks} | ConvertTo-Json -Compress));exit 0
};
$global:LASTEXITCODE=0;$Error.Clear();$invocationFailed=$false;
try {
  & $env:CAREBRIDGE_LEASE_SOURCE -OwnerPid ([int]$env:CAREBRIDGE_CANCEL_OWNER_PID) -OwnerStartTimeUtcTicks $ticks -NodeExecutablePath $env:CAREBRIDGE_CANCEL_NODE -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceIndex 1 -ControlDirectory $env:CAREBRIDGE_CANCEL_DIRECTORY -MaxLifetimeSeconds 60;
} catch {$invocationFailed=$true};
if($env:CAREBRIDGE_CANCEL_ENTRY -ceq 'admin-rejection' -and -not $invocationFailed -and $LASTEXITCODE -eq 1 -and $global:CarebridgeBlockedNativeCalls -eq 0){
  [Console]::Out.Write('admin-rejected-without-os-calls');exit 1
};
if($invocationFailed -or $LASTEXITCODE -ne 0 -or $global:CarebridgeBlockedNativeCalls -ne 0 -or $Error.Count -ne 0){
  $diagnostic=[ordered]@{stage='cancelled-helper-error';line=0;type='none';id='none';source='unknown'};
  if($Error.Count -gt 0){
    # Error[0] is newest: report the oldest error after our pre-invocation clear.
    # Never print Message, StackTrace, ScriptName, arguments, or environment.
    $first=$Error[$Error.Count-1];$diagnostic.line=[int]$first.InvocationInfo.ScriptLineNumber;
    $type=$first.Exception.GetType().FullName;$id=[string]$first.FullyQualifiedErrorId;
    $diagnostic.type=if($type -cmatch '^[A-Za-z0-9_.+]{1,160}$'){$type}else{'redacted'};
    $diagnostic.id=if($id -cmatch '^[A-Za-z0-9_.:, -]{1,180}$'){$id}else{'redacted'};
    $diagnostic.source=if([string]$first.InvocationInfo.ScriptName -ceq $env:CAREBRIDGE_LEASE_SOURCE){'helper'}else{'wrapper-or-dependency'}
  };
  [Console]::Error.WriteLine(($diagnostic | ConvertTo-Json -Compress));exit 1
};
[Console]::Out.Write('cancelled-without-os-calls');
`;
    const environment={...childEnvironment,CAREBRIDGE_LEASE_SOURCE:file,CAREBRIDGE_CANCEL_ENTRY:entry,
      CAREBRIDGE_LEASE_SHA256:createHash('sha256').update(source).digest('hex').toUpperCase(),
      CAREBRIDGE_CANCEL_DIRECTORY:directory,CAREBRIDGE_CANCEL_OWNER_PID:String(process.pid),CAREBRIDGE_CANCEL_NODE:process.execPath};
    const options={env:environment,encoding:'utf8',timeout:30_000,maxBuffer:32_768,windowsHide:true,shell:false};
    let result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],options);
    observedExit=Number.isInteger(result.status);
    assert.equal(result.error,undefined);assert.equal(result.signal,null);
    if(!rejectsAdmin){assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');}
    if(!usesCallOperator) {
      const prepared=JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(prepared).sort(),['ownerTicks','stage']);
      assert.equal(prepared.stage,'prepared-nonadmin-file-entry');
      assert.match(prepared.ownerTicks,/^[0-9]{17,19}$/);
      assert.equal(createHash('sha256').update(await readFile(file)).digest('hex').toUpperCase(),environment.CAREBRIDGE_LEASE_SHA256);
      assert.deepEqual(await readdir(directory),rejectsAdmin?[]:['stop']);
      if(!rejectsAdmin) {
        const stopMetadata=await lstat(stop);
        assert.ok(stopMetadata.isFile()&&!stopMetadata.isSymbolicLink()&&stopMetadata.nlink===1&&stopMetadata.size===0);
      }
      // Direct CreateProcess argv serialization exercises the actual -File
      // entry/parameter binder, including Unicode paths and any spaces. No
      // shell, UAC/Verb, manually joined command line or wrapper script is used.
      // This does not test the elevated launcher's manually quoted
      // ProcessStartInfo.Arguments or ShellExecute/UAC boundary.
      const argumentsForFile=['-NoProfile','-NonInteractive','-File',file,
        '-OwnerPid',String(process.pid),'-OwnerStartTimeUtcTicks',prepared.ownerTicks,
        '-NodeExecutablePath',process.execPath,'-LocalIPv4','10.231.9.10','-PeerIPv4','10.231.9.11',
        '-InterfaceIndex','1','-ControlDirectory',directory,'-MaxLifetimeSeconds','60'];
      if(entry==='unknown-named') argumentsForFile.push('-UnexpectedSyntheticLeaseArgument','rejected');
      if(entry==='extra-positional') argumentsForFile.push('-TemporaryTcpBlockRule','synthetic-placeholder','unexpected-extra-argument');
      observedExit=false;
      result=spawnSync(powershell,argumentsForFile,options);
    }
    observedExit=Number.isInteger(result.status);
    assert.equal(result.error,undefined);assert.equal(result.signal,null);
    if(rejectsArguments) {
      assert.equal(result.status,1);assert.equal(result.stdout,'');
      assert.match(result.stderr,entry==='unknown-named'?/UnexpectedSyntheticLeaseArgument/:/unexpected-extra-argument/);
      assert.doesNotMatch(result.stderr,/SYNTHETIC_WIFI_LEASE_UNAVAILABLE/);
      assert.deepEqual(await readdir(directory),['stop']);
      return; // Parameter binding stopped execution before status/native body.
    }
    if(rejectsAdmin) {
      assert.equal(result.status,1,result.stderr);
      assert.equal(result.stdout,usesCallOperator?'admin-rejected-without-os-calls':'');
      assert.equal(result.stderr,'SYNTHETIC_WIFI_LEASE_UNAVAILABLE');
      assert.deepEqual((await readdir(directory)).sort(),['failure.json','status.json']);
      assert.equal(await readFile(status,'utf8'),'{"stage":"failed"}');
      const diagnosticPath=win32.join(directory,'failure.json'),metadata=await lstat(diagnosticPath);
      assert.ok(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.nlink===1&&metadata.size<=256);
      const text=await readFile(diagnosticPath,'utf8'),diagnostic=JSON.parse(text);
      const identityFailureLine=source.split(/\r?\n/).findIndex(line=>line.includes("if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }"))+1;
      assert.ok(identityFailureLine>0&&identityFailureLine<=99999);
      assert.deepEqual(diagnostic,{schema:1,phase:'identity',cleanup:'none',flags:0,line:identityFailureLine});
      assert.equal(JSON.stringify(diagnostic),text);
      assert.doesNotMatch(text,/10\.231|node\.exe|[A-Za-z]:\\|owner|token|secret|message|time/i);
      return;
    }
    assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
    assert.equal(result.stdout,entry==='call-operator'?'cancelled-without-os-calls':'');
    assert.deepEqual((await readdir(directory)).sort(),['status.json','stop']);
    const statusMetadata=await lstat(status);
    assert.ok(statusMetadata.isFile()&&!statusMetadata.isSymbolicLink()&&statusMetadata.nlink===1&&statusMetadata.size<=64);
    assert.equal(await readFile(status,'utf8'),'{"stage":"removed"}');
  } finally {
    // Never clean an unknown/running child or adopt an older failed folder.
    // Retain unexpected contents for inspection instead of recursive deletion.
    if(observedExit) {
      const current=await lstat(directory);
      assert.ok(current.isDirectory()&&!current.isSymbolicLink());
      assert.equal(current.dev,directoryIdentity.dev);assert.equal(current.ino,directoryIdentity.ino);
      assert.equal((await realpath(directory)).toLowerCase(),directory.toLowerCase());
      const entries=await readdir(directory);
      assert.ok(entries.every(name=>name==='stop'||name==='status.json'||name==='failure.json'));
      for(const name of entries) {
        const path=win32.join(directory,name),stat=await lstat(path);
        assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);
        assert.ok(name==='stop' ? stat.size===0 : stat.size<=(name==='failure.json'?256:64));
        if(name==='failure.json') {
          const diagnostic=JSON.parse(await readFile(path,'utf8'));
          assert.deepEqual(Object.keys(diagnostic).sort(),['cleanup','flags','line','phase','schema']);
          assert.equal(diagnostic.schema,1);assert.ok(Number.isInteger(diagnostic.flags)&&diagnostic.flags>=0&&diagnostic.flags<=63);
          assert.ok(Number.isInteger(diagnostic.line)&&diagnostic.line>=0&&diagnostic.line<=99999);
          assert.ok(['none','initialization','status-init','stop-check','identity','exe-pin','owner-pin','owner-check','network','exception',
            'rule-check','task-check','task-build','task-register','task-verify','overlap','ready-check','rule-create','rule-verify','active-write','monitor','unknown'].includes(diagnostic.phase));
          assert.ok(['none','restore','rule-query','rule-remove','task-query','task-verify','task-remove','status-write','unknown'].includes(diagnostic.cleanup));
        }
      }
      for(const name of entries) await unlink(win32.join(directory,name));
      await rmdir(directory); // exact UUID folder, empty, non-recursive
    } else {
      t.diagnostic(`Unconfirmed child exit; newly created cancellation evidence retained at ${directory}`);
    }
  }
});
}
