import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const policyFile=fileURLToPath(new URL('../../scripts/synthetic-wifi-firewall-policy.ps1',import.meta.url));
const exceptionFile=fileURLToPath(new URL('../../scripts/synthetic-wifi-firewall-exception.ps1',import.meta.url));
const leaseFile=fileURLToPath(new URL('../../scripts/synthetic-wifi-firewall-lease.ps1',import.meta.url));
const [policy,exception,lease]=await Promise.all([policyFile,exceptionFile,leaseFile].map(path=>readFile(path,'utf8')));

test('approved exception changes only LocalPort and preserves ports 0 and 65535',()=>{
  assert.doesNotMatch(policy,/Set-Net|New-Net|Remove-Net|Register-ScheduledTask/);
  assert.doesNotMatch(exception+lease,/Set-NetFirewallRule|Disable-NetFirewallRule|Enable-NetFirewallRule|Set-NetConnectionProfile|Set-NetFirewallProfile/);
  assert.ok(lease.includes("Set-NetFirewallPortFilter -LocalPort @('0-8442','8444-65535')"));
  assert.ok(exception.includes('Set-NetFirewallPortFilter -LocalPort Any'));
  assert.equal((exception+lease).match(/Set-NetFirewallPortFilter /g).length,2);
  assert.ok(policy.includes("'Get-NetFirewallSecurityFilter'"));
  assert.ok(policy.includes("[string]$rule.PolicyStoreSourceType -ne 'Local'"));
  assert.ok(policy.includes("[string]$rule.PolicyStoreSource -ne 'PersistentStore'"));
});

test('two blocking guards are installed before port exception, and restore gates guard/task removal',()=>{
  const enable=lease.slice(lease.indexOf('function Enable-BlockException'),lease.indexOf('function Assert-CleanupTask'));
  assert.ok(enable.indexOf('New-NetFirewallRule')<enable.indexOf('Set-NetFirewallPortFilter'));
  assert.ok(enable.indexOf('Assert-CarebridgeGuard')<enable.indexOf('Set-NetFirewallPortFilter'));
  assert.ok(enable.includes("foreach ($dimension in @('Local','Remote'))"));
  assert.ok(enable.includes('-Action Block'));
  assert.ok(enable.includes('-InterfaceAlias Any -InterfaceType Any'));
  const cleanup=exception.slice(exception.indexOf('function Invoke-CarebridgeExceptionCleanup'),exception.indexOf('function Get-CarebridgeExceptionCleanupCommand'));
  assert.ok(cleanup.indexOf('Restore-CarebridgeException')<cleanup.indexOf('Remove-CarebridgeOwnedRule $Context.AllowName'));
  assert.ok(cleanup.includes('if ($restored)'));
  assert.ok(cleanup.includes('$restored -and $allowRemoved -and $guardsRemoved'));
  assert.ok(lease.includes("if ($cleanupVerified -and $taskCleanupVerified) { Write-LeaseStage 'removed' }"));
});

test('independent recovery reserves original, serializes mutations, and retries without a finite deadline assumption',()=>{
  for(const token of ['Global\\Carebridge-Synthetic-WiFi-Lifetime-','Global\\Carebridge-Synthetic-WiFi-Operation-',
    "'Carebridge-Synthetic-WiFi-Exception-' + $key",'if (-not $created)',
    '-RepetitionInterval ([TimeSpan]::FromMinutes(1))','-MultipleInstances IgnoreNew',
    '$taskArguments.Length -gt 30000','[DateTime]::UtcNow -ge $deadline.ToUniversalTime()',
    "$once[0].Repetition.Duration -ne ''",'$once[0].Repetition.StopAtDurationEnd',"$once[0].EndBoundary -ne ''"]) assert.ok(lease.includes(token),token);
  assert.ok(exception.includes("$Name.ToUpperInvariant() + '|' + $Program.ToUpperInvariant()"));
  assert.ok(exception.includes('$mutex.WaitOne(30000)'));
  assert.ok(exception.includes('$tasks[0].Description -cne $context.Marker'));
  assert.doesNotMatch(exception,/Invoke-Expression|Get-Content|ReadAllText|ReadAllBytes|\.ps1['"]|-File\s|Start-Process|Invoke-WebRequest/);
});

test('mocked NetSecurity validates original, exact guards, tamper refusal, idempotent recovery and fixed task code',t=>{
  if(process.platform!=='win32'||!process.env.CAREBRIDGE_TEST_POWERSHELL) return t.skip('Explicit Windows PowerShell runtime needed; no native firewall calls are used.');
  const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
  const command=String.raw`
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
. $env:CAREBRIDGE_POLICY_SOURCE; . $env:CAREBRIDGE_EXCEPTION_SOURCE;
function Require($Condition,[string]$Label){if(-not $Condition){throw $Label};$script:checks++}
function Refuses([scriptblock]$Action,[string]$Label){$refused=$false;try{& $Action}catch{$refused=$true};Require $refused $Label}
$checks=0;$writes=[Collections.Generic.List[string]]::new();$removeFailure=$false;$restoreFailure=$false;
$program='C:\synthetic-test\node.exe';$originalName='TCP Query User{11111111-2222-4333-8444-555555555555}'+$program;
$uuid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';$allowName='Carebridge-Synthetic-WiFi-'+$uuid;$marker='Carebridge temporary synthetic-only Wi-Fi lease '+$uuid;
function Fixture([string]$Name,[string]$Description='node.exe'){
  [pscustomobject]@{InstanceID=$Name;Name=$Name;DisplayName='node.exe';Description=$Description;Group=$null;Enabled='True';Profile='Public';Platform=@();Direction='Inbound';Action='Block';EdgeTraversalPolicy='DeferToUser';LooseSourceMapping=$false;LocalOnlyMapping=$false;Owner=$null;PackageFamilyName=$null;PolicyStoreSource='PersistentStore';PolicyStoreSourceType='Local';Filters=@{
  Application=[pscustomobject]@{Program=$program;Package=$null};Address=[pscustomobject]@{LocalAddress=@('Any');RemoteAddress=@('Any')};
  Port=[pscustomobject]@{Protocol='TCP';LocalPort=@('Any');RemotePort=@('Any');IcmpType=@('Any');DynamicTarget='Any'};
  Interface=[pscustomobject]@{InterfaceAlias=@('Any')};InterfaceType=[pscustomobject]@{InterfaceType=@('Any')};Service=[pscustomobject]@{Service='Any'};
  Security=[pscustomobject]@{Authentication='NotRequired';Encryption='NotRequired';OverrideBlockRules=$false;LocalUser=@('Any');RemoteUser=@('Any');RemoteMachine=@('Any')}}}
}
$persistent=[Collections.Generic.List[object]]::new();$active=[Collections.Generic.List[object]]::new();
function Reset-Fixtures {$script:persistent.Clear();$script:active.Clear();$script:writes.Clear();$script:persistent.Add((Fixture $originalName));$script:active.Add((Fixture $originalName))}
function Get-NetFirewallRule {param($PolicyStore,$Enabled,$Direction,$ErrorAction) if($PolicyStore -ceq 'PersistentStore'){$persistent.ToArray()}elseif($PolicyStore -ceq 'ActiveStore'){$active.ToArray()}else{throw 'UNMOCKED_STORE'}}
function Get-NetFirewallApplicationFilter {param([Parameter(ValueFromPipeline)]$InputObject,$PolicyStore) process{if($InputObject){$InputObject.Filters.Application}else{foreach($r in $active){[pscustomobject]@{InstanceID=$r.InstanceID;Program=$r.Filters.Application.Program;Package=$r.Filters.Application.Package}}}}}
function Get-NetFirewallAddressFilter {param([Parameter(ValueFromPipeline)]$InputObject) process{$InputObject.Filters.Address}}
function Get-NetFirewallPortFilter {param([Parameter(ValueFromPipeline)]$InputObject) process{$InputObject.Filters.Port}}
function Get-NetFirewallInterfaceFilter {param([Parameter(ValueFromPipeline)]$InputObject) process{$InputObject.Filters.Interface}}
function Get-NetFirewallInterfaceTypeFilter {param([Parameter(ValueFromPipeline)]$InputObject) process{$InputObject.Filters.InterfaceType}}
function Get-NetFirewallServiceFilter {param([Parameter(ValueFromPipeline)]$InputObject,$PolicyStore) process{if($InputObject){$InputObject.Filters.Service}else{foreach($r in $active){[pscustomobject]@{InstanceID=$r.InstanceID;Service=$r.Filters.Service.Service}}}}}
function Get-NetFirewallSecurityFilter {param([Parameter(ValueFromPipeline)]$InputObject) process{$InputObject.Filters.Security}}
function Set-NetFirewallPortFilter {param([Parameter(ValueFromPipeline)]$InputObject,$LocalPort) process{if($restoreFailure){throw 'MOCK_RESTORE_FAILURE'};Require ($persistent[0].Filters.Port -eq $InputObject) 'exact original port object';$writes.Add('restore');$persistent[0].Filters.Port.LocalPort=@($LocalPort);$active[0].Filters.Port.LocalPort=@($LocalPort)}}
function Remove-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject) process{if($removeFailure){throw 'MOCK_REMOVE_FAILURE'};$writes.Add('remove:'+$InputObject.Name);$null=$persistent.Remove($InputObject);foreach($r in @($active.ToArray())){if($r.Name -ceq $InputObject.Name){$null=$active.Remove($r)}}}}
Reset-Fixtures;
$snapshot=Get-CarebridgeTemporaryBlockSnapshot $originalName $program;
Require (($snapshot.LocalPort -join ',') -ceq 'Any') 'accept exact original';
$context=[pscustomobject]@{Name=$originalName;Program=$program;Invariant=$snapshot.Invariant;Key=(Get-CarebridgeExceptionKey $originalName $program);AllowName=$allowName;Marker=$marker;LocalIPv4='10.231.9.10';PeerIPv4='10.231.9.11';LocalGuardName=$allowName+'-Guard-Local';RemoteGuardName=$allowName+'-Guard-Remote'};
Require ($context.Key -ceq (Get-CarebridgeExceptionKey $originalName.ToUpperInvariant() $program.ToUpperInvariant())) 'case independent reservation';
Require ((@(Get-CarebridgeIPv4Complement '10.231.9.11') -join ',') -ceq '0.0.0.0-10.231.9.10,10.231.9.12-255.255.255.255,::/0') 'complement exact';
Require ($null -eq (Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $program -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Test-WiFi' -TemporaryTcpBlockRule $originalName)) 'approved original exclusion';
Require ((Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $program -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Test-WiFi') -ceq 'firewall-block') 'unapproved original refused';
foreach($change in @('Profile','Action','PolicyStoreSource','PolicyStoreSourceType','Description','Name')){
  $before=$active[0].$change;$active[0].$change='Changed';Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} ('changed '+$change);$active[0].$change=$before
}
$persistent.Add((Fixture $originalName));Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} 'duplicate original';$persistent.RemoveAt(1);
$before=$active[0].Filters.Security.RemoteUser;$active[0].Filters.Security.RemoteUser=@('S-1-5-18');Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} 'security restriction';$active[0].Filters.Security.RemoteUser=$before;
$before=$active[0].Filters.Address.RemoteAddress;$active[0].Filters.Address.RemoteAddress=@('10.231.9.11');Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} 'original not Any';$active[0].Filters.Address.RemoteAddress=$before;
$active[0] | Add-Member -NotePropertyName RemoteDynamicKeywordAddresses -NotePropertyValue @('11111111-2222-4333-8444-555555555555');Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} 'dynamic address restriction';$active[0].PSObject.Properties.Remove('RemoteDynamicKeywordAddresses');
foreach($r in @($persistent[0],$active[0])){$r.Filters.Port.LocalPort=@('0-8442','8444-65535')};
Refuses {Get-CarebridgeTemporaryBlockSnapshot $originalName $program} 'new lease refuses adjusted original';
Require ((Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $program -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Test-WiFi' -TemporaryTcpBlockRule $originalName) -ceq 'firewall-uncertain') 'preflight does not adopt residual adjusted block';
$null=Get-CarebridgeTemporaryBlockSnapshot $originalName $program -AllowAdjusted;
Assert-CarebridgeExceptionCurrent $context '0-8442,8444-65535';$checks++;
Restore-CarebridgeException $context;Require ($writes.Count -eq 1 -and $writes[0] -ceq 'restore') 'restore only LocalPort';
Restore-CarebridgeException $context;Require ($writes.Count -eq 1) 'idempotent restore';
function Add-Owned {
  foreach($store in @($persistent,$active)){
    $allow=Fixture $allowName $marker;$allow.Action='Allow';$store.Add($allow);
    foreach($dimension in @('Local','Remote')){
      $guard=Fixture ($allowName+'-Guard-'+$dimension) $marker;$guard.EdgeTraversalPolicy='Block';$guard.Filters.Port.LocalPort=@('8443');
      if($dimension -ceq 'Local'){$guard.Filters.Address.LocalAddress=@(Get-CarebridgeIPv4Complement $context.LocalIPv4)}else{$guard.Filters.Address.RemoteAddress=@(Get-CarebridgeIPv4Complement $context.PeerIPv4)};$store.Add($guard)
    }
  }
}
Add-Owned;
Assert-CarebridgeGuard $context $context.LocalGuardName 'Local';Assert-CarebridgeGuard $context $context.RemoteGuardName 'Remote';$checks+=2;
$active[2].Filters.Address.LocalAddress=@('Any');Refuses {Assert-CarebridgeGuard $context $context.LocalGuardName 'Local'} 'guard tamper rejected';$active[2].Filters.Address.LocalAddress=@(Get-CarebridgeIPv4Complement $context.LocalIPv4);
$active[0].Description='external change';$writes.Clear();Refuses {Invoke-CarebridgeExceptionCleanup $context} 'tampered original prevents successful cleanup';
Require ($writes.Count -eq 1 -and $writes[0] -ceq ('remove:'+$allowName)) 'allow removed despite restore refusal';
Require ($persistent.Count -eq 3 -and $active.Count -eq 3) 'guards retained after restore refusal';
$active[0].Description='node.exe';Invoke-CarebridgeExceptionCleanup $context;Require ($persistent.Count -eq 1 -and $active.Count -eq 1) 'recovery removes only guards';
Add-Owned;foreach($r in @($persistent[0],$active[0])){$r.Filters.Port.LocalPort=@('0-8442','8444-65535')};$restoreFailure=$true;$writes.Clear();
Refuses {Invoke-CarebridgeExceptionCleanup $context} 'provider restore failure';Require ($persistent.Count -eq 3 -and $writes[0] -ceq ('remove:'+$allowName)) 'provider failure leaves guards';$restoreFailure=$false;
Invoke-CarebridgeExceptionCleanup $context;Require ($persistent.Count -eq 1) 'provider recovery';
Add-Owned;$persistent.RemoveAt(0);$active.RemoveAt(0);$writes.Clear();Refuses {Invoke-CarebridgeExceptionCleanup $context} 'deleted original not recreated';
Require ($persistent.Count -eq 2 -and $writes.Count -eq 1 -and $writes[0] -ceq ('remove:'+$allowName)) 'deleted original retains guards and removes own allow';
Reset-Fixtures;foreach($r in @($persistent[0],$active[0])){$r.Filters.Port.LocalPort=@('80')};Refuses {Restore-CarebridgeException $context} 'external port edit not overwritten';Require ($writes.Count -eq 0) 'no mutation on external port edit';Reset-Fixtures;
$extra=Fixture 'unrelated-allow';$extra.Action='Allow';$extra.Filters.Address.LocalAddress=@('10.231.9.99');$extra.Filters.Interface.InterfaceAlias=@('Ethernet');$active.Add($extra);
Require ((Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $program -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Test-WiFi' -TemporaryTcpBlockRule $originalName) -ceq 'firewall-allow') 'global original scope allow rejected';
$extra.Action='AllowBypass';Require ((Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $program -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Test-WiFi' -TemporaryTcpBlockRule $originalName) -ceq 'firewall-uncertain') 'global authenticated bypass refused';$active.RemoveAt(1);
$taskName='Carebridge-Synthetic-WiFi-Exception-'+$context.Key;
$action=Get-CarebridgeExceptionCleanupCommand $context $taskName;$tokens=$null;$errors=$null;
$null=[Management.Automation.Language.Parser]::ParseInput($action,[ref]$tokens,[ref]$errors);Require ($errors.Count -eq 0) 'fixed SYSTEM action parses';
$length=('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($action))).Length;
Require ($length -le 30000) ('action length '+$length);
Require (-not $action.Contains($originalName)) 'original name encoded as data';
Require (-not $action.Contains('Get-Content') -and -not $action.Contains('Invoke-Expression')) 'no disk script or evaluated data';
$leaseAst=[Management.Automation.Language.Parser]::ParseFile($env:CAREBRIDGE_LEASE_SOURCE,[ref]$tokens,[ref]$errors);
foreach($functionName in @('Assert-OneValue','Assert-AddressValue','Assert-RuleBoundary')){
  $definition=$leaseAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName},$true);
  . ([scriptblock]::Create($definition.Extent.Text))
}
$ruleName=$allowName;$ruleMarker=$marker;$NodeExecutablePath=$program;$LocalIPv4='10.231.9.10';$PeerIPv4='10.231.9.11';
$ownAllow=Fixture $allowName $marker;$ownAllow.Action='Allow';$ownAllow.EdgeTraversalPolicy='Block';$ownAllow.Filters.Port.LocalPort=@('8443');
$ownAllow.Filters.Address.LocalAddress=@($LocalIPv4);$ownAllow.Filters.Address.RemoteAddress=@($PeerIPv4);$ownAllow.Filters.Interface.InterfaceAlias=@('Test-WiFi');$ownAllow.Filters.InterfaceType.InterfaceType=@('Wireless');
Assert-RuleBoundary $ownAllow 'Test-WiFi';$checks++;
foreach($scope in @($ownAllow,$ownAllow.Filters.Application,$ownAllow.Filters.Address)){
  foreach($field in @('RemoteDynamicKeywordAddresses','PolicyAppId')){
    $scope | Add-Member -NotePropertyName $field -NotePropertyValue $null;
    Assert-RuleBoundary $ownAllow 'Test-WiFi';$checks++;
    $scope.$field=@();Assert-RuleBoundary $ownAllow 'Test-WiFi';$checks++;
    $scope.$field='';Assert-RuleBoundary $ownAllow 'Test-WiFi';$checks++;
    $scope.$field=@('11111111-2222-4333-8444-555555555555');Refuses {Assert-RuleBoundary $ownAllow 'Test-WiFi'} ('owned allow scope drift '+$field);
    $scope.PSObject.Properties.Remove($field)
  }
}
foreach($path in @($env:CAREBRIDGE_POLICY_SOURCE,$env:CAREBRIDGE_EXCEPTION_SOURCE,$env:CAREBRIDGE_LEASE_SOURCE)){$null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors);Require ($errors.Count -eq 0) 'all source parses'}
[Console]::Out.Write((@{checks=$checks;actionCharacters=$length} | ConvertTo-Json -Compress))
`;
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,CAREBRIDGE_POLICY_SOURCE:policyFile,CAREBRIDGE_EXCEPTION_SOURCE:exceptionFile,CAREBRIDGE_LEASE_SOURCE:leaseFile},encoding:'utf8',timeout:60_000,maxBuffer:32_768,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.ok(report.checks>=30);assert.ok(report.actionCharacters<=30_000);
  t.diagnostic(`${report.checks} mocked assertions; encoded cleanup command ${report.actionCharacters} characters.`);
});
