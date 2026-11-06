// Explicit, separately approved native firewall lease probe. This file opens
// no listener, certificate, API, database or browser. Only the existing lease
// helper may mutate the exact approved firewall boundary. The explicit
// --verify-task-as-admin option adds a separate read-only UAC observation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticWifiCliOptions } from '../scripts/synthetic-wifi-api.mjs';
import { createSyntheticWifiLease } from '../server/synthetic-wifi-lease.mjs';
import { privateSecretEnvironment } from '../server/windows-private-secret-io.mjs';
import { syntheticWifiTaskShapeScript } from './synthetic-wifi-task-shape.mjs';
import { createAdminTaskObservation, syntheticWifiAdminTaskFailurePhases } from './synthetic-wifi-admin-task-observer.mjs';

const policyPath = fileURLToPath(new URL('../scripts/synthetic-wifi-firewall-policy.ps1', import.meta.url));
const exceptionPath = fileURLToPath(new URL('../scripts/synthetic-wifi-firewall-exception.ps1', import.meta.url));
const observerPhases = Object.freeze(['input','original-snapshot','guard-boundary','task-query',
  'persistent-query','persistent-snapshot','persistent-rule','persistent-network',
  'active-query','active-snapshot','active-rule','active-network',
  'task-count','task-fields','task-action','task-trigger','task-not-enumerated',
  'task-not-found','task-access-denied','task-query-unavailable','absence','result']);
const fail = observerPhase => {
  const error = new Error('SYNTHETIC_WIFI_LEASE_CHECK_FAILED');
  if (observerPhases.includes(observerPhase)) error.observerPhase = observerPhase;
  return error;
};
export function syntheticWifiLeaseObserverFailurePhase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'ok,phase,schema' ||
      value.schema !== 1 || value.ok !== false || !observerPhases.includes(value.phase)) throw fail();
  return value.phase;
}
const quote = value => `'${value.replaceAll("'", "''")}'`;

export function syntheticWifiLeaseCheckOptions(args) {
  const adminTaskObservationRequested = args[0] === '--verify-task-as-admin';
  const remaining = adminTaskObservationRequested ? args.slice(1) : args;
  assert([12, 14].includes(remaining.length));
  const options = syntheticWifiCliOptions(remaining);
  assert.equal(options.temporaryTcpBlockRule !== undefined, remaining.length === 14);
  // Approval covers only the exact UUID cleanup task, never exception tasks.
  assert(!adminTaskObservationRequested || options.temporaryTcpBlockRule === undefined);
  return { options, adminTaskObservationRequested };
}

// Keep the result boundary distinct from process termination. A lease stop or
// cancellation invalidates admission, but never pretends the observer exited.
export async function verifyActiveAdminTaskObservation(lease, observation, checkpoint) {
  try {
    checkpoint(); assert.equal(lease.status, 'active');
    const result = await Promise.race([observation.result, lease.waitForStop().then(() => { throw fail(); })]);
    checkpoint(); assert.equal(lease.status, 'active');
    assert.deepEqual(result, { verified: true });
    return Object.freeze({ verified: true });
  } catch (error) {
    observation.cancel();
    throw error;
  }
}

export async function confirmAdminTaskObserverClosed(observation, timeoutMs = 30_000) {
  let timer;
  try {
    const closed = await Promise.race([observation.closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), timeoutMs); })]);
    assert.deepEqual(closed, { confirmed: true });
  } finally { clearTimeout(timer); }
}

// Only named read-only functions are called after dot-sourcing definitions.
// Canonical rule/filter JSON remains inside this child. Its public result has
// only hashes, counts and booleans, never the original name/program/IP/task XML.
export const syntheticWifiLeaseInspectScript = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $WarningPreference='SilentlyContinue';
Set-StrictMode -Version Latest;
function Digest([string]$text) {
  $hash=[Security.Cryptography.SHA256]::Create();
  try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}
  finally{$hash.Dispose()}
}
function One($value,[string]$expected) {if(@($value).Count -ne 1 -or [string]@($value)[0] -cne $expected){throw 'CHECK_FAILED'}}
function OneAddress($value,[string]$expected) {
  if(@($value).Count -ne 1 -or ([string]@($value)[0] -cne $expected -and [string]@($value)[0] -cne ($expected+'/32'))){throw 'CHECK_FAILED'}
}
function Get-ObserverTaskLookupOutcome([string]$Name) {
  # Enumeration may omit unreadable tasks. Query only our exact derived name,
  # locally under the current token; no credentials, ACL changes or elevation.
  if($Name -cnotmatch '^Carebridge-Synthetic-WiFi-(?:Cleanup-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|Exception-[a-f0-9]{64})$'){return 'unavailable'};
  $service=$null;$folder=$null;$registered=$null;$definition=$null;
  $step='service';$outcome='unavailable';
  try {
    $service=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop;
    $step='connect';$null=$service.Connect();
    $step='folder';$folder=$service.GetFolder('\');
    $step='task';$registered=$folder.GetTask($Name);
    $step='definition';$definition=$registered.Definition;
    if($null -eq $definition){throw 'CHECK_FAILED'};
    $outcome='readable';
  } catch {
    # COM errors can be mapped by .NET to exact IO/access exception types.
    # Accept those mappings only at GetTask with the matching HRESULT. Message
    # text, IO/access subclasses and generic HResult lookalikes prove nothing.
    $candidate=$_.Exception;$lookupFailure=$null;
    for($depth=0;$depth -lt 8 -and $null -ne $candidate;$depth++){
      if($candidate -is [Runtime.InteropServices.COMException]){$lookupFailure=$candidate;break};
      if($step -ceq 'task' -and (
        ($candidate.GetType() -eq [IO.FileNotFoundException] -and $candidate.HResult -eq -2147024894) -or
        ($candidate.GetType() -eq [IO.DirectoryNotFoundException] -and $candidate.HResult -eq -2147024893) -or
        ($candidate.GetType() -eq [UnauthorizedAccessException] -and $candidate.HResult -eq -2147024891)
      )){$lookupFailure=$candidate;break};
      if($candidate -isnot [Management.Automation.RuntimeException] -and $candidate -isnot [Reflection.TargetInvocationException]){break};
      $candidate=$candidate.InnerException
    };
    if($null -ne $lookupFailure){
      if($lookupFailure.HResult -eq -2147024891){$outcome='access-denied'}
      elseif($step -ceq 'task' -and $lookupFailure.HResult -in @(-2147024894,-2147024893)){$outcome='not-found'}
    }
  } finally {
    foreach($owned in @($definition,$registered,$folder,$service)){
      if($null -ne $owned){
        try {if([Runtime.InteropServices.Marshal]::IsComObject($owned)){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($owned)}}
        catch {$outcome='unavailable'}
      }
    }
  };
  return $outcome
}
$taskLookupPhases=@{readable='task-not-enumerated';'not-found'='task-not-found';'access-denied'='task-access-denied';unavailable='task-query-unavailable'};
$observationPhase='input';
try {
  $exception=$inputData.name -ne ''; $originalHash=$null; $invariantHash=$null; $expectedPorts=$false;
  $taskName=''; $tasks=@();
  $taskInspection=if($inputData.PSObject.Properties.Name -ccontains 'taskInspection'){$inputData.taskInspection}else{'inline'};
  if($taskInspection -cnotin @('inline','separate-admin') -or
     ($taskInspection -ceq 'separate-admin' -and ($inputData.stage -cne 'active' -or $exception -or $inputData.leaseId -ceq ''))){throw 'CHECK_FAILED'};
  if($inputData.leaseId -ne '' -and $inputData.leaseId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'CHECK_FAILED'};
  if($exception) {
    $observationPhase='original-snapshot';
    $snapshot=Get-CarebridgeTemporaryBlockSnapshot $inputData.name $inputData.program -AllowAdjusted;
    $expected=if($inputData.stage -ceq 'active'){'0-8442,8444-65535'}else{'Any'};
    if(($snapshot.LocalPort -join ',') -cne $expected){throw 'CHECK_FAILED'};
    $canonical=([ordered]@{Invariant=$snapshot.Invariant;LocalPort=@($snapshot.LocalPort)}|ConvertTo-Json -Depth 8 -Compress);
    $originalHash=Digest $canonical; $invariantHash=Digest $snapshot.Invariant; $expectedPorts=$true;
    $key=Get-CarebridgeExceptionKey $inputData.name $inputData.program;
    $taskName='Carebridge-Synthetic-WiFi-Exception-'+$key;
  } elseif($inputData.leaseId -ne '') {$taskName='Carebridge-Synthetic-WiFi-Cleanup-'+$inputData.leaseId};
  $observationPhase='task-query';
  if($taskName -ne '' -and $taskInspection -ceq 'inline') {$tasks=@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop|Where-Object{$_.TaskName -ceq $taskName})};
  $ruleCount=0; $boundaries=$false; $taskVerified=$false;
  if($inputData.stage -ceq 'active') {
    if($inputData.leaseId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'CHECK_FAILED'};
    $name='Carebridge-Synthetic-WiFi-'+$inputData.leaseId;
    $marker='Carebridge temporary synthetic-only Wi-Fi lease '+$inputData.leaseId;
    if($exception) {
      $observationPhase='guard-boundary';
      $context=[pscustomobject]@{Program=$inputData.program;LocalIPv4=$inputData.host;PeerIPv4=$inputData.peer;Marker=$marker};
      Assert-CarebridgeGuard $context ($name+'-Guard-Local') 'Local';
      Assert-CarebridgeGuard $context ($name+'-Guard-Remote') 'Remote';
    }
    foreach($store in @('PersistentStore','ActiveStore')) {
      $observationPhase=if($store -ceq 'PersistentStore'){'persistent-query'}else{'active-query'};
      $rules=@(Get-CarebridgeExactFirewallRule $name $store);
      if($rules.Count -ne 1){throw 'CHECK_FAILED'};
      $observationPhase=if($store -ceq 'PersistentStore'){'persistent-snapshot'}else{'active-snapshot'};
      $allow=Get-CarebridgeFirewallSnapshot $rules[0]; $data=$allow.Invariant|ConvertFrom-Json;
      $observationPhase=if($store -ceq 'PersistentStore'){'persistent-rule'}else{'active-rule'};
      One $data.Rule.Name $name; One $data.Rule.Description $marker;
      One $data.Rule.Enabled 'True'; One $data.Rule.Profile 'Public'; One $data.Rule.Direction 'Inbound';
      One $data.Rule.Action 'Allow'; One $data.Rule.EdgeTraversalPolicy 'Block';
      One $data.Rule.PolicyStoreSourceType 'Local'; One $data.Rule.PolicyStoreSource 'PersistentStore';
      One $allow.LocalPort '8443'; One $data.Port.RemotePort 'Any';
      if(@($data.Port.Protocol).Count -ne 1 -or $data.Port.Protocol[0] -notin @('TCP','6')){throw 'CHECK_FAILED'};
      $observationPhase=if($store -ceq 'PersistentStore'){'persistent-network'}else{'active-network'};
      if(@($data.Application.Program).Count -ne 1 -or -not [String]::Equals($data.Application.Program[0],$inputData.program,[StringComparison]::OrdinalIgnoreCase)){throw 'CHECK_FAILED'};
      OneAddress $data.Address.LocalAddress $inputData.host; OneAddress $data.Address.RemoteAddress $inputData.peer;
      One $data.Interface.InterfaceAlias $inputData.alias; One $data.InterfaceType.InterfaceType 'Wireless';
      $ruleCount+=if($exception){3}else{1};
    }
    if($taskInspection -ceq 'inline') {
      $observationPhase='task-count';
      if($tasks.Count -eq 0){
        $observationPhase='task-query-unavailable';
        $lookup=Get-ObserverTaskLookupOutcome $taskName;
        if($taskLookupPhases.ContainsKey($lookup)){$observationPhase=$taskLookupPhases[$lookup]};
        throw 'CHECK_FAILED'
      };
      if($tasks.Count -ne 1){throw 'CHECK_FAILED'};
      ${syntheticWifiTaskShapeScript}
      $taskVerified=$true;
    };
    $boundaries=$true;
  } else {
    $observationPhase='absence';
    if($tasks.Count -ne 0){throw 'CHECK_FAILED'};
    if($inputData.leaseId -ne '' -and $taskName -ne ''){
      $observationPhase='task-query-unavailable';
      $lookup=Get-ObserverTaskLookupOutcome $taskName;
      if($lookup -cne 'not-found'){
        if($taskLookupPhases.ContainsKey($lookup)){$observationPhase=$taskLookupPhases[$lookup]};
        throw 'CHECK_FAILED'
      };
      $observationPhase='absence'
    };
    if($inputData.leaseId -ne '') {
      if($inputData.leaseId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'CHECK_FAILED'};
      $name='Carebridge-Synthetic-WiFi-'+$inputData.leaseId;
      foreach($store in @('PersistentStore','ActiveStore')) {
        foreach($own in @($name,($name+'-Guard-Local'),($name+'-Guard-Remote'))) {$ruleCount+=@(Get-CarebridgeExactFirewallRule $own $store).Count}
      }
      if($ruleCount -ne 0){throw 'CHECK_FAILED'};
    } elseif(-not $exception) {
      # The lease UUID does not exist before creation. Check only Carebridge
      # rules associated with this exact executable, not unrelated sessions.
      foreach($store in @('PersistentStore','ActiveStore')) {
        $candidates=@(Get-NetFirewallRule -PolicyStore $store -ErrorAction Stop|Where-Object{$_.Name -clike 'Carebridge-Synthetic-WiFi-*'});
        foreach($candidate in $candidates) {
          $apps=@($candidate|Get-NetFirewallApplicationFilter -ErrorAction Stop);
          if($apps.Count -ne 1){throw 'CHECK_FAILED'};
          if([String]::Equals([string]$apps[0].Program,$inputData.program,[StringComparison]::OrdinalIgnoreCase)){$ruleCount++}
        }
      }
      if($ruleCount -ne 0){throw 'CHECK_FAILED'};
    }
    $boundaries=$true; $taskVerified=$taskName -ne '';
  }
  $observationPhase='result';
  [Console]::Out.Write(([ordered]@{schema=1;ok=$true;originalHash=$originalHash;invariantHash=$invariantHash;
    storesVerified=2;expectedPorts=$expectedPorts;ownRuleEntries=$ruleCount;taskCount=$tasks.Count;boundaries=$boundaries;taskVerified=$taskVerified}|ConvertTo-Json -Compress));
  exit 0
} catch { [Console]::Out.Write(([ordered]@{schema=1;ok=$false;phase=$observationPhase}|ConvertTo-Json -Compress)); exit 1 }
`;

async function inspect(options, stage, leaseId = '', alias = '', taskInspection = 'inline') {
  const exception = options.temporaryTcpBlockRule !== undefined;
  assert(['inline', 'separate-admin'].includes(taskInspection));
  assert(taskInspection !== 'separate-admin' || (stage === 'active' && !exception && leaseId !== ''));
  const data = Buffer.from(JSON.stringify({ stage, leaseId, alias, taskInspection, name: options.temporaryTcpBlockRule ?? '',
    program: process.execPath, host: options.network.host, peer: options.network.peerAddress })).toString('base64');
  const command = `. ${quote(policyPath)}; . ${quote(exceptionPath)}; $inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; ${syntheticWifiLeaseInspectScript}`;
  return new Promise((resolveResult, reject) => {
    let child, output = '', size = 0, errors = 0, invalid = false;
    try {
      child = spawn(options.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: privateSecretEnvironment(process.env, options.powershell) });
    } catch { reject(fail()); return; }
    // Killing applies only to this read-only observer, never the UAC helper.
    const timer = setTimeout(() => { invalid = true; child.kill(); }, 45_000);
    child.once('error', () => { invalid = true; });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 8192) { invalid = true; child.kill(); } else output += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { errors += chunk.length; invalid = true; if (errors > 16_384) child.kill(); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        if (!invalid && code === 1 && signal === null && value?.ok === false) {
          throw fail(syntheticWifiLeaseObserverFailurePhase(value));
        }
        assert(!invalid && code === 0 && signal === null && value.schema === 1 && value.ok === true);
        assert.equal(Object.keys(value).sort().join(','), 'boundaries,expectedPorts,invariantHash,ok,originalHash,ownRuleEntries,schema,storesVerified,taskCount,taskVerified');
        if (exception) { assert.match(value.originalHash, /^[a-f0-9]{64}$/); assert.match(value.invariantHash, /^[a-f0-9]{64}$/); }
        else { assert.equal(value.originalHash, null); assert.equal(value.invariantHash, null); }
        assert.equal(value.storesVerified, 2); assert.equal(value.expectedPorts, exception);
        assert.equal(value.ownRuleEntries, stage === 'active' ? (exception ? 6 : 2) : 0);
        assert.equal(value.taskCount, stage === 'active' && taskInspection === 'inline' ? 1 : 0);
        assert.equal(value.boundaries, true);
        assert.equal(value.taskVerified, taskInspection === 'inline' && (exception || leaseId !== ''));
        resolveResult(Object.freeze(value));
      } catch (error) { reject(fail(error?.observerPhase)); }
    });
  });
}

export async function runSyntheticWifiLeaseCheck(args) {
  const runId = randomUUID(), reportPath = `test-results/synthetic-wifi-lease-${runId}.json`;
  const report = { schema: 1, runId, mode: 'synthetic-wifi-native-lease-only', passed: false,
    startedAt: new Date().toISOString(), phase: 'CONFIGURATION', failure: null,
    temporaryExceptionRequested: false, adminTaskObservationRequested: false, cleanupRetries: 0,
    checks: { beforeCaptured: false, ready: false,
      activeRulesVerified: false, cleanupTaskVerified: false, closeConfirmed: false,
      ownedObjectsAbsent: false, observerExitsConfirmed: false }, snapshots: {}, cleanup: null };
  let options, lease, before, adminObservation, cancelled = false, interrupted = false, closing = false, retryResolve, cleanupConfirmed = false;
  const keepAlive = setInterval(() => {}, 60_000);
  const signal = () => {
    cancelled = true;
    adminObservation?.cancel();
    void lease?.close().catch(() => {});
    retryResolve?.(); retryResolve = undefined;
  };
  const checkpoint = () => { if (cancelled || interrupted) throw fail(); };
  const failure = (code, observerPhase, adminObserverPhase) => {
    report.failure ??= { phase: report.phase, code,
      ...(observerPhases.includes(observerPhase) ? { observerPhase } : {}),
      ...(syntheticWifiAdminTaskFailurePhases.includes(adminObserverPhase) ? { adminObserverPhase } : {}) };
    process.exitCode = 1;
  };
  const stage = value => { report.phase = value; process.stdout.write(`lease-check:${value}\n`); };
  const waitForCleanupRetry = () => new Promise(resolveRetry => {
    // Noninteractive parents cannot necessarily deliver SIGINT. Retry the
    // same owned close and read-only observations without requiring a TTY.
    // A signal wakes this delay early; neither path starts a new lease.
    const finish = () => {
      clearTimeout(timer);
      if (retryResolve === finish) retryResolve = undefined;
      resolveRetry();
    };
    const timer = setTimeout(finish, 30_000);
    retryResolve = finish;
  });
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  try {
    ({ options, adminTaskObservationRequested: report.adminTaskObservationRequested } = syntheticWifiLeaseCheckOptions(args));
    assert.equal(process.platform, 'win32');
    report.temporaryExceptionRequested = options.temporaryTcpBlockRule !== undefined;
    if (report.adminTaskObservationRequested) report.checks.adminObserverExitConfirmed = false;
    if (report.temporaryExceptionRequested) Object.assign(report.checks,
      { adjustedPorts: false, originalInvariantPreserved: false, originalRestored: false });
    stage('BEFORE'); before = await inspect(options, 'before'); checkpoint();
    report.snapshots.before = before; report.checks.beforeCaptured = true;
    stage('WAITING_APPROVAL');
    const expiresAt = Date.now() + 180_000;
    lease = createSyntheticWifiLease({ network: options.network, powershell: options.powershell,
      interfaceIndex: options.interfaceIndex, maxLifetimeSeconds: 180,
      ...(report.temporaryExceptionRequested ? { temporaryTcpBlockRule: options.temporaryTcpBlockRule } : {}) });
    const unexpectedStop = () => { if (!closing) { interrupted = true; adminObservation?.cancel(); void lease.close().catch(() => {}); } };
    void lease.waitForStop().then(unexpectedStop, unexpectedStop);
    const ready = await lease.ready; checkpoint(); assert.equal(lease.status, 'active'); report.checks.ready = true;
    const leaseId = basename(lease.controlDirectory).replace(/^carebridge-synthetic-wifi-/, '');
    stage('ACTIVE'); const active = await inspect(options, 'active', leaseId, ready.interfaceAlias,
      report.adminTaskObservationRequested ? 'separate-admin' : 'inline'); checkpoint();
    assert.equal(lease.status, 'active');
    if (report.temporaryExceptionRequested) {
      assert.equal(active.invariantHash, before.invariantHash);
      report.checks.adjustedPorts = true; report.checks.originalInvariantPreserved = true;
    }
    report.snapshots.active = active;
    report.checks.activeRulesVerified = true;
    if (report.adminTaskObservationRequested) {
      stage('WAITING_READ_ONLY_APPROVAL'); checkpoint(); assert.equal(lease.status, 'active');
      adminObservation = createAdminTaskObservation({ powershell: options.powershell, leaseId, expiresAt });
      report.snapshots.adminTask = await verifyActiveAdminTaskObservation(lease, adminObservation, checkpoint);
    }
    report.checks.cleanupTaskVerified = true;
  } catch (error) { failure(cancelled ? 'SYNTHETIC_WIFI_LEASE_CHECK_CANCELLED' : 'SYNTHETIC_WIFI_LEASE_CHECK_FAILED', error?.observerPhase, error?.phase); }
  finally {
    closing = true; stage('CLEANUP');
    adminObservation?.cancel();
    // A timeout/rejection is not successful cleanup. Keep the same owner alive
    // and retry every 30 seconds (or Ctrl+C) until original restoration and
    // child close are both established. The lease's maximum lifetime never
    // permits a successful exit without evidence. Do not force exit or
    // edit/remove objects independently; every attempt uses the same owner.
    while (!cleanupConfirmed) {
      try {
        if (lease) { assert.deepEqual(await lease.close(), { stage: 'removed' }); assert.equal(lease.status, 'removed'); report.checks.closeConfirmed = true; }
        if (before) {
          const leaseId = lease?.controlDirectory ? basename(lease.controlDirectory).replace(/^carebridge-synthetic-wifi-/, '') : '';
          const after = await inspect(options, 'after', leaseId);
          if (report.temporaryExceptionRequested) {
            assert.equal(after.originalHash, before.originalHash); assert.equal(after.invariantHash, before.invariantHash);
            report.checks.originalRestored = true;
          }
          report.snapshots.after = after; report.checks.ownedObjectsAbsent = true;
          report.checks.observerExitsConfirmed = true;
        }
        if (adminObservation) {
          await confirmAdminTaskObserverClosed(adminObservation);
          report.checks.adminObserverExitConfirmed = true;
        }
        cleanupConfirmed = true;
      } catch (error) {
        failure('SYNTHETIC_WIFI_LEASE_CLEANUP_UNCONFIRMED', error?.observerPhase, error?.phase);
        report.cleanupRetries += 1;
        process.stderr.write('lease-check:CLEANUP_UNCONFIRMED — 같은 정리를 30초 후 다시 확인합니다. 창을 닫지 마세요. Ctrl+C로 즉시 재확인할 수 있습니다.\n');
        await waitForCleanupRetry();
      }
    }
    report.cleanup = { leaseCreated: Boolean(lease), confirmed: cleanupConfirmed, leaseCloseConfirmed: !lease || report.checks.closeConfirmed,
      originalRestored: report.temporaryExceptionRequested ? Boolean(before && report.checks.originalRestored) : null,
      ownedObjectsAbsent: !before || report.checks.ownedObjectsAbsent,
      adminObserverCreated: Boolean(adminObservation), adminObserverExitConfirmed: !adminObservation || report.checks.adminObserverExitConfirmed };
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !cancelled && Object.values(report.checks).every(value => value === true);
    try {
      await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
      await writeFile(new URL(`../${reportPath}`, import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(`lease-check:${report.passed ? 'PASSED' : 'FAILED'} ${reportPath}\n`);
    } catch { report.passed = false; process.stderr.write('lease-check:REPORT_UNAVAILABLE\n'); }
    if (!report.passed) process.exitCode = 1;
    clearInterval(keepAlive); process.off('SIGINT', signal); process.off('SIGTERM', signal);
  }
  return report.passed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSyntheticWifiLeaseCheck(process.argv.slice(2));
