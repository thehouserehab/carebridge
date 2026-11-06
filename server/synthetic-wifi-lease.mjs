// Owns the non-elevated launcher and a single elevated firewall lease helper.
// Never elevates Node, changes a network category, or kills an elevated helper.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {StringDecoder} from 'node:string_decoder';
import {syntheticWifiNetwork} from './synthetic-wifi-network.mjs';
import {syntheticWifiTcpBlockRule} from './synthetic-wifi-exception-policy.mjs';
import {privateSecretEnvironment} from './windows-private-secret-io.mjs';

const helperPath = fileURLToPath(new URL('../scripts/synthetic-wifi-firewall-lease.ps1',import.meta.url));
const policyPath = fileURLToPath(new URL('../scripts/synthetic-wifi-firewall-policy.ps1',import.meta.url));
const exceptionPath = fileURLToPath(new URL('../scripts/synthetic-wifi-firewall-exception.ps1',import.meta.url));
const allowedReasons = new Set(['platform','configuration','executable','elevated','network','port','firewall-allow','firewall-block','firewall-uncertain','inspection','approval','cancelled','status','cleanup-pending']);
function failure(reason='configuration') {
  const error = new Error('SYNTHETIC_WIFI_LEASE_UNAVAILABLE');
  error.code = 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE';
  error.reason = allowedReasons.has(reason) ? reason : 'configuration';
  return error;
}
function plainData(value,keys) {
  if (!value || typeof value !== 'object' || ![null,Object.prototype].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) ||
      Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))) throw failure();
  return {...value};
}
function absoluteWindowsFile(value,name) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z]:\\/.test(value) ||
      /[<>"|?*\x00-\x1f/]/.test(value) || value.slice(2).includes(':') ||
      path.win32.normalize(value) !== value || value.split('\\').slice(1).some(part => !part || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) ||
      path.win32.basename(value).toLowerCase() !== name) throw failure('executable');
  return value;
}
export function syntheticWifiLeaseOptions(input) {
  const copy = plainData(input,['network','powershell','interfaceIndex','maxLifetimeSeconds','temporaryTcpBlockRule']);
  if (!Object.hasOwn(copy,'network') || !Object.hasOwn(copy,'powershell') || !Object.hasOwn(copy,'interfaceIndex')) throw failure();
  const rawNetwork = plainData(copy.network,['host','peerAddress','port','confirmSynthetic']);
  let network;
  try { network = syntheticWifiNetwork(rawNetwork); } catch { throw failure(); }
  const powershell = absoluteWindowsFile(copy.powershell,'pwsh.exe');
  const maxLifetimeSeconds = Object.hasOwn(copy,'maxLifetimeSeconds') ? copy.maxLifetimeSeconds : 7200;
  if (!Number.isInteger(copy.interfaceIndex) || copy.interfaceIndex < 1 || copy.interfaceIndex > 2147483647 ||
      !Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 60 || maxLifetimeSeconds > 7200) throw failure();
  let temporaryTcpBlockRule;
  if (Object.hasOwn(copy,'temporaryTcpBlockRule')) {
    try { temporaryTcpBlockRule = syntheticWifiTcpBlockRule(copy.temporaryTcpBlockRule); } catch { throw failure(); }
  }
  return Object.freeze({network,powershell,interfaceIndex:copy.interfaceIndex,maxLifetimeSeconds,
    ...(temporaryTcpBlockRule === undefined ? {} : {temporaryTcpBlockRule})});
}
const quotePowerShell = value => `'${value.replaceAll("'","''")}'`;
const encodedCommand = value => Buffer.from(value,'utf16le').toString('base64');

// Fixed, read-only inspection. Candidate rules never leave this child process;
// only a bounded reason or the minimum process/network identity is returned.
const inspectionScript = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $WarningPreference='SilentlyContinue';
function Refuse([string]$reason){[Console]::Out.Write((@{schema=1;ok=$false;reason=$reason}|ConvertTo-Json -Compress));exit 1}
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent();
  try{$principal=[Security.Principal.WindowsPrincipal]::new($identity);if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Refuse 'elevated'}}finally{$identity.Dispose()};
  $owner=Get-Process -Id $inputData.ownerPid -ErrorAction Stop;
  if(-not [String]::Equals($owner.Path,$inputData.node,[StringComparison]::OrdinalIgnoreCase)){Refuse 'inspection'};
  $ticks=$owner.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
  $adapters=@(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object {$_.InterfaceIndex -eq $inputData.interfaceIndex});
  if($adapters.Count -ne 1 -or $adapters[0].Status -ne 'Up' -or [int]$adapters[0].NdisPhysicalMedium -notin @(1,9)){Refuse 'network'};
  $alias=[string]$adapters[0].Name;if([string]::IsNullOrWhiteSpace($alias) -or $alias.IndexOfAny([char[]]'*?[]') -ge 0){Refuse 'network'};
  $profiles=@(Get-NetConnectionProfile -InterfaceIndex $inputData.interfaceIndex -ErrorAction Stop);
  if($profiles.Count -ne 1 -or [string]$profiles[0].NetworkCategory -cne 'Public'){Refuse 'network'};
  $addresses=@(Get-NetIPAddress -InterfaceIndex $inputData.interfaceIndex -AddressFamily IPv4 -ErrorAction Stop | Where-Object {$_.IPAddress -ceq $inputData.host -and $_.AddressState -eq 'Preferred'});
  if($addresses.Count -ne 1 -or $addresses[0].PrefixLength -lt 8 -or $addresses[0].PrefixLength -gt 30){Refuse 'network'};
  $mask=([uint64]4294967295 -shl (32-[int]$addresses[0].PrefixLength)) -band [uint64]4294967295;
  $local=Get-CarebridgeAddressNumber $inputData.host;$peer=Get-CarebridgeAddressNumber $inputData.peer;
  if(($local -band $mask) -ne ($peer -band $mask)){Refuse 'network'};
  $hostMask=[uint64]4294967295 -bxor $mask;
  if(($local -band $hostMask) -in @(0,$hostMask) -or ($peer -band $hostMask) -in @(0,$hostMask)){Refuse 'network'};
  $firewall=@(Get-NetFirewallProfile -Name Public -PolicyStore ActiveStore -ErrorAction Stop);
  if($firewall.Count -ne 1 -or [string]$firewall[0].Enabled -ne 'True' -or [string]$firewall[0].AllowInboundRules -eq 'False' -or
    [string]$firewall[0].DefaultInboundAction -eq 'Allow' -or [string]$firewall[0].AllowLocalFirewallRules -eq 'False'){Refuse 'network'};
  if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq 8443}).Count -ne 0){Refuse 'port'};
  $conflict=Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $inputData.node -LocalIPv4 $inputData.host -PeerIPv4 $inputData.peer -InterfaceAlias $alias -TemporaryTcpBlockRule ([string]$inputData.temporaryTcpBlockRule);
  if($conflict){Refuse $conflict};
  [Console]::Out.Write((@{schema=1;ok=$true;ownerStartTimeUtcTicks=$ticks;interfaceIndex=[int]$inputData.interfaceIndex;interfaceAlias=$alias}|ConvertTo-Json -Compress));exit 0
} catch {Refuse 'inspection'}
`;

async function assertFileChain(file) {
  const resolved = await fs.realpath(file);
  if (resolved.toLowerCase() !== file.toLowerCase()) throw failure('executable');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current,part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw failure('executable');
  }
}
function startObserved(powershell,command,{readOnly=false}={}) {
  let done = false, spawned = false, errorSeen = false, tooLarge = false, stdout = '', stdoutSize = 0, stderrSize = 0;
  let exitObserved=false, exitCode=null, signalObserved=false;
  const decoder = new StringDecoder('utf8');
  let child;
  let resolveClosed;
  const closed = new Promise(resolve => {resolveClosed=resolve;});
  try {
    child = childProcess.spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',encodedCommand(command)],{
      windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false,
      env:privateSecretEnvironment(process.env,powershell)
    });
  } catch {
    errorSeen = true; done = true; resolveClosed(Object.freeze({code:null,signal:null,error:true,spawned:false,stdout:''}));
  }
  if (child) {
    child.once('spawn',()=>{spawned=true;});
    child.stdout.on('data',chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize > 16_384) { tooLarge=true; if(readOnly) child.kill(); return; }
      stdout += decoder.write(chunk);
    });
    child.stderr.on('data',chunk => {stderrSize+=chunk.length;if(stderrSize>16_384){tooLarge=true;if(readOnly)child.kill();}});
    child.once('error',() => {errorSeen=true;});
    child.once('exit',(code,signal) => {exitObserved=true;exitCode=code;signalObserved=Boolean(signal);});
    child.once('close',(code,signal) => {exitCode=code;signalObserved ||= Boolean(signal);stdout+=decoder.end();done=true;resolveClosed(Object.freeze({code,signal,error:errorSeen||tooLarge,spawned,stdout}));});
  }
  // Observation only: never use this lossy projection for readiness or cleanup.
  // In particular, spawning the ordinary launcher does not prove a UAC dialog
  // was displayed or that the elevated helper was started.
  function diagnostics() {
    let outcome='pending';
    if(done){
      if(!spawned)outcome='not-spawned';
      else if(errorSeen||tooLarge||signalObserved)outcome='unrecognized';
      else if(exitCode===1223&&stdout==='{"stage":"declined"}')outcome='declined';
      else if(exitCode===253&&stdout==='{"stage":"launch-failed"}')outcome='launch-failed';
      else if(exitCode===1&&stdout==='{"stage":"helper-failed"}')outcome='helper-failed';
      else if(exitCode===253&&stdout==='{"stage":"observation-failed"}')outcome='observation-failed';
      else if(exitCode===0&&stdout==='')outcome='exited';
      else outcome='unrecognized';
    }
    return Object.freeze({spawnObserved:spawned,exitObserved,closed:done,errorObserved:errorSeen||tooLarge,
      signalObserved,exitCode:Number.isInteger(exitCode)&&exitCode>=-2147483648&&exitCode<=4294967295?exitCode:null,outcome});
  }
  return Object.freeze({closed,get done(){return done;},get diagnostics(){return diagnostics();},terminateReadOnly(){if(readOnly&&!done)child?.kill();}});
}
async function bounded(promise,milliseconds,reason,onTimeout=()=>{}) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject) => {
      timer=setTimeout(() => {onTimeout();reject(failure(reason));},milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}
function inspectionCommand(options) {
  const payload=Buffer.from(JSON.stringify({ownerPid:process.pid,node:process.execPath,host:options.network.host,
    peer:options.network.peerAddress,interfaceIndex:options.interfaceIndex,
    temporaryTcpBlockRule:options.temporaryTcpBlockRule??''})).toString('base64');
  return `$inputData=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json);. ${quotePowerShell(policyPath)};${inspectionScript}`;
}
async function inspect(options,jobs) {
  if(process.platform!=='win32')throw failure('platform');
  absoluteWindowsFile(process.execPath,'node.exe');
  await Promise.all([assertFileChain(options.powershell),assertFileChain(process.execPath),assertFileChain(helperPath),assertFileChain(policyPath),assertFileChain(exceptionPath)]);
  const job=startObserved(options.powershell,inspectionCommand(options),{readOnly:true});jobs.push(job);
  const result=await bounded(job.closed,35_000,'inspection',() => job.terminateReadOnly());
  let value;
  try {value=JSON.parse(result.stdout);} catch {throw failure('inspection');}
  if(result.error||result.signal||!value||value.schema!==1||typeof value.ok!=='boolean')throw failure('inspection');
  if(value.ok===false)throw failure(allowedReasons.has(value.reason)?value.reason:'inspection');
  if(result.code!==0||Object.keys(value).sort().join(',')!=='interfaceAlias,interfaceIndex,ok,ownerStartTimeUtcTicks,schema'||
    !/^[0-9]{17,19}$/.test(value.ownerStartTimeUtcTicks)||value.interfaceIndex!==options.interfaceIndex||
    typeof value.interfaceAlias!=='string'||!value.interfaceAlias||value.interfaceAlias.length>256||/[\x00-\x1f*?\[\]]/.test(value.interfaceAlias))throw failure('inspection');
  return Object.freeze({ownerStartTimeUtcTicks:value.ownerStartTimeUtcTicks,interfaceIndex:value.interfaceIndex,interfaceAlias:value.interfaceAlias});
}
export async function inspectSyntheticWifiLease(input) {
  const options=syntheticWifiLeaseOptions(input), jobs=[];
  try{return await inspect(options,jobs);}finally{
    for(const job of jobs)if(!job.done)job.terminateReadOnly();
    // A read-only child is still observed through its real close event.
    await Promise.all(jobs.map(job=>job.closed));
  }
}
function launchCommand(options,identity,directory) {
  const argumentsList=['-NoProfile','-NonInteractive','-File',helperPath,'-OwnerPid',String(process.pid),
    '-OwnerStartTimeUtcTicks',identity.ownerStartTimeUtcTicks,'-NodeExecutablePath',process.execPath,
    '-LocalIPv4',options.network.host,'-PeerIPv4',options.network.peerAddress,'-InterfaceIndex',String(options.interfaceIndex),
    '-ControlDirectory',directory,'-MaxLifetimeSeconds',String(options.maxLifetimeSeconds),
    ...(options.temporaryTcpBlockRule === undefined ? [] : ['-TemporaryTcpBlockRule',options.temporaryTcpBlockRule])].map(value=>`"${value}"`).join(' ');
  // Start-Process replaces ShellExecute's Win32Exception with a message-only
  // InvalidOperationException (PowerShell 7.6.5), losing cancellation code 1223.
  // Start directly, and classify ONLY this call's typed native cancellation.
  // The fixed helper performs synchronous work; it must not launch detached
  // child jobs. WaitForExit observes this exact helper, not a process tree.
  return `$ErrorActionPreference='Stop';
$startInfo=[Diagnostics.ProcessStartInfo]::new();
$startInfo.FileName=${quotePowerShell(options.powershell)};
$startInfo.Arguments=${quotePowerShell(argumentsList)};
$startInfo.UseShellExecute=$true;
$startInfo.Verb='runas';
$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;
try { $helper=[Diagnostics.Process]::Start($startInfo) }
catch {
  $cause=$_.Exception;
  while($null -ne $cause){
    if($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223){
      [Console]::Out.Write('{"stage":"declined"}');exit 1223
    };
    $cause=$cause.InnerException
  };
  [Console]::Out.Write('{"stage":"launch-failed"}');exit 253
};
if($null -eq $helper){[Console]::Out.Write('{"stage":"launch-failed"}');exit 253};
$helperExitCode=253;
try {
  $helper.WaitForExit();
  if($helper.HasExited){$observedCode=$helper.ExitCode;if($observedCode -in @(0,1)){$helperExitCode=$observedCode}}
} catch { $helperExitCode=253 }
finally { try { $helper.Dispose() } catch { $helperExitCode=253 } };
if($helperExitCode -eq 1){[Console]::Out.Write('{"stage":"helper-failed"}')};
if($helperExitCode -eq 253){[Console]::Out.Write('{"stage":"observation-failed"}')};
exit $helperExitCode`;
}

export function createSyntheticWifiLease(input) {
  const options=syntheticWifiLeaseOptions(input);
  const jobs=[];
  let directory=null, directoryIdentity=null, statusHandle=null, statusIdentity=null, launcher=null;
  let state='preparing', observedStage=null, stopping=false, setupFinished=false, closePromise=null, pollFinished=false;
  let preflight='pending',readyOutcome='pending',failureReason=null,readyDeadlineExpired=false,lifetimeExpired=false,cleanupDeadlineExpired=false,everActive=false,cleanup='not-started';
  const rememberFailure=reason=>{failureReason??=allowedReasons.has(reason)?reason:'inspection';};
  let resolveStop;
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const notice=stage=>resolveStop(Object.freeze({stage}));
  // Independent of slow CIM reads/UAC or a delayed Scheduled Task. Expiry
  // immediately tells the owning CLI to close the API; OS restoration still
  // requires the helper's verified receipt and must not be assumed complete.
  const expiryTimer=setTimeout(()=>{
    lifetimeExpired=true;rememberFailure('status');
    state='failed';notice('failed');
    void requestStop().catch(()=>{});
  },options.maxLifetimeSeconds*1_000);
  expiryTimer.unref?.();
  let polling=Promise.resolve();
  async function checkDirectory() {
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==directoryIdentity.dev||stat.ino!==directoryIdentity.ino)throw failure('status');
  }
  async function requestStop() {
    stopping=true;
    if(!['removed','failed'].includes(state))state='stopping';
    if(!directory||!directoryIdentity)return;
    await checkDirectory();
    const stopPath=path.join(directory,'stop');
    try {const file=await fs.open(stopPath,'wx',0o600);await file.close();}
    catch(error){if(error.code!=='EEXIST')throw failure('status');}
  }
  async function readStage() {
    await checkDirectory();
    const statusPath=path.join(directory,'status.json');
    let current;
    try{current=await fs.lstat(statusPath);}catch(error){if(error.code==='ENOENT'&&!statusHandle)return null;throw failure('status');}
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.size>64)throw failure('status');
    if(!statusHandle){
      statusHandle=await fs.open(statusPath,'r');statusIdentity=await statusHandle.stat();
      if(statusIdentity.dev!==current.dev||statusIdentity.ino!==current.ino||!statusIdentity.isFile()||statusIdentity.nlink!==1)throw failure('status');
    }
    const pinned=await statusHandle.stat();
    if(current.dev!==statusIdentity.dev||current.ino!==statusIdentity.ino||pinned.nlink!==1||pinned.size>64)throw failure('status');
    const buffer=Buffer.alloc(65),result=await statusHandle.read(buffer,0,65,0);
    if(result.bytesRead>64)throw failure('status');
    const text=buffer.subarray(0,result.bytesRead).toString('utf8');
    if(text==='')return null;
    let value;
    try{value=JSON.parse(text);}catch{return null;} // A concurrent in-place status write may be incomplete for one poll.
    if(!value||Object.keys(value).length!==1||!['active','removed','failed'].includes(value.stage)||JSON.stringify(value)!==text)throw failure('status');
    return value.stage;
  }
  async function poll() {
    let incompleteSince=null;
    try{
      while(!pollFinished){
        const stage=await readStage();
        if(!stage&&observedStage){
          incompleteSince??=Date.now();
          if(Date.now()-incompleteSince>2_000)throw failure('status');
        }else{incompleteSince=null;}
        if(stage){
          if(observedStage&&observedStage!=='active'&&stage!==observedStage)throw failure('status');
          observedStage=stage;
          if(stage==='active')everActive=true;
          if(stage==='active'&&!stopping)state='active';
          if(stage==='removed'||stage==='failed'){if(stage==='failed')rememberFailure('status');state=stage;notice(stage);}
        }
        if(launcher.done){
          const result=await launcher.closed;
          if(observedStage!=='removed'||result.code!==0||result.signal||result.error){rememberFailure(readyOutcome==='active'?'status':'approval');state='failed';notice('failed');}
          pollFinished=true;break;
        }
        await delay(200);
      }
    }catch{rememberFailure('status');state='failed';notice('failed');try{await requestStop();}catch{};}
  }
  const ready=(async()=>{
    try{
      const identity=await inspect(options,jobs);
      preflight='passed';
      if(stopping)throw failure('cancelled');
      const parent=await fs.realpath(os.tmpdir());
      directory=path.join(parent,`carebridge-synthetic-wifi-${randomUUID()}`);
      await fs.mkdir(directory,{mode:0o700});directoryIdentity=await fs.lstat(directory);
      if(stopping){await requestStop();throw failure('cancelled');}
      await checkDirectory();
      launcher=startObserved(options.powershell,launchCommand(options,identity,directory));jobs.push(launcher);
      state='waiting-approval';polling=poll();
      const deadline=Date.now()+120_000;
      while(true){
        if(stopping)throw failure('cancelled');
        if(state==='active'){readyOutcome='active';return Object.freeze({interfaceAlias:identity.interfaceAlias});}
        if(state==='failed'||state==='removed'||launcher.done)throw failure('approval');
        if(Date.now()>=deadline){readyDeadlineExpired=true;throw failure('approval');}
        await delay(100);
      }
    }catch(error){
      if(preflight==='pending')preflight='failed';
      readyOutcome='failed';rememberFailure(error?.code==='SYNTHETIC_WIFI_LEASE_UNAVAILABLE'?error.reason:'inspection');
      state='failed';notice('failed');try{await requestStop();}catch{}
      throw error?.code==='SYNTHETIC_WIFI_LEASE_UNAVAILABLE'?error:failure('inspection');
    }finally{setupFinished=true;}
  })();
  // Observation handlers do not swallow the public promise's rejection.
  ready.catch(()=>{});
  function close() {
    if(closePromise)return closePromise;
    closePromise=(async()=>{
      cleanup='pending';
      await requestStop();
      await bounded(ready.catch(()=>{}),15_000,'cleanup-pending',()=>{cleanupDeadlineExpired=true;for(const job of jobs)job.terminateReadOnly();});
      if(directory)await requestStop();
      await bounded(Promise.all(jobs.map(job=>job.closed)),30_000,'cleanup-pending',()=>{cleanupDeadlineExpired=true;});
      if(launcher){
        // Poll once after process+stdio closure, then require both receipts.
        const stage=await readStage();observedStage=stage;
        const result=await launcher.closed;
        const neverStarted=!result.spawned || (!result.error&&!result.signal&&result.code===1223&&result.stdout==='{"stage":"declined"}');
        const helperFailedButRemoved=result.code===1&&result.stdout==='{"stage":"helper-failed"}';
        if(!(stage===null&&neverStarted)&&(stage!=='removed'||(!helperFailedButRemoved&&result.code!==0)||result.signal||result.error))throw failure('cleanup-pending');
      }else if(!setupFinished){throw failure('cleanup-pending');}
      pollFinished=true;await polling;
      await statusHandle?.close();statusHandle=null;
      clearTimeout(expiryTimer);
      state='removed';notice('removed');
      cleanup='confirmed';
      return Object.freeze({stage:'removed'});
    })().catch(error=>{cleanup='unconfirmed';rememberFailure('cleanup-pending');closePromise=null;throw error?.code==='SYNTHETIC_WIFI_LEASE_UNAVAILABLE'?error:failure('cleanup-pending');});
    return closePromise;
  }
  return Object.freeze({ready,get controlDirectory(){return directory;},get status(){return state;},
    get diagnostics(){return Object.freeze({schema:1,observationOnly:true,state,preflight,ready:readyOutcome,failureReason,
      readyDeadlineExpired,lifetimeExpired,cleanupDeadlineExpired,everActive,stopRequested:stopping,cleanup,observedStage,
      launcher:launcher?.diagnostics??null});},waitForStop(){return stopped;},close});
}
