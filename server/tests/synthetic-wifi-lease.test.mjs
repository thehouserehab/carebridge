import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {syntheticWifiLeaseOptions,createSyntheticWifiLease,inspectSyntheticWifiLease} from '../synthetic-wifi-lease.mjs';
import {sanitizeSyntheticWifiDiagnostic} from '../synthetic-wifi-diagnostic.mjs';

const network={host:'10.231.9.10',peerAddress:'10.231.9.11',port:8443,confirmSynthetic:true};
const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
const input=()=>({network:{...network},powershell:powershell??'C:\\Tools\\pwsh.exe',interfaceIndex:8,maxLifetimeSeconds:60});
const blockRule='TCP Query User{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}C:\\Fixture\\node.exe';
const inspectResult={schema:1,ok:true,ownerStartTimeUtcTicks:'638975520000000000',interfaceIndex:8,interfaceAlias:'Wi-Fi'};
const native=Boolean(process.platform==='win32'&&powershell);
const source=await fs.readFile(new URL('../synthetic-wifi-lease.mjs',import.meta.url),'utf8');
const policyFile=new URL('../../scripts/synthetic-wifi-firewall-policy.ps1',import.meta.url);
const policy=await fs.readFile(policyFile,'utf8');

test('lease options require exact plain data with bounded lifetime and explicit PowerShell',()=>{
  const value=syntheticWifiLeaseOptions(input());
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.network));
  const invalid=[null,[],{},Object.create(input()),{...input(),extra:true},{...input(),interfaceIndex:0},
    {...input(),interfaceIndex:'8'},{...input(),maxLifetimeSeconds:59},{...input(),maxLifetimeSeconds:7201},
    {...input(),maxLifetimeSeconds:undefined},{...input(),powershell:'pwsh.exe'},{...input(),powershell:'C:\\Tools\\cmd.exe'},
    {...input(),powershell:'C:\\Tools\\..\\pwsh.exe'},{...input(),network:{...network,host:'0.0.0.0'}},
    {...input(),network:{...network,extra:1}},{...input(),network:{...network,confirmSynthetic:false}}];
  for(const item of invalid)assert.throws(()=>syntheticWifiLeaseOptions(item),{code:'SYNTHETIC_WIFI_LEASE_UNAVAILABLE'});
  let invoked=false;const getter={...input()};Object.defineProperty(getter,'powershell',{get(){invoked=true;return powershell;},enumerable:true});
  assert.throws(()=>syntheticWifiLeaseOptions(getter));assert.equal(invoked,false);
});

test('existing block exception is explicit, own-data only, and never a broad rule selector',()=>{
  assert.equal(Object.hasOwn(syntheticWifiLeaseOptions(input()),'temporaryTcpBlockRule'),false);
  assert.equal(syntheticWifiLeaseOptions({...input(),temporaryTcpBlockRule:blockRule}).temporaryTcpBlockRule,blockRule);
  for(const value of [undefined,null,'','*','node.exe','TCP Query User{bad}C:\\Fixture\\node.exe',
    blockRule.replace('node.exe','cmd.exe'),blockRule+'\n',blockRule.replace('Fixture','FIXTU~1'),
    blockRule.replace('Fixture','%TEMP%'),blockRule.replace('Fixture','Fixture\\..'),
    blockRule.replace('Fixture','Fixture.'),blockRule.replace('C:\\','\\\\host\\')]) {
    assert.throws(()=>syntheticWifiLeaseOptions({...input(),temporaryTcpBlockRule:value}),{code:'SYNTHETIC_WIFI_LEASE_UNAVAILABLE'});
  }
  let invoked=false;const getter={...input()};
  Object.defineProperty(getter,'temporaryTcpBlockRule',{get(){invoked=true;return blockRule;},enumerable:true});
  assert.throws(()=>syntheticWifiLeaseOptions(getter));assert.equal(invoked,false);
});

test('existing restricted package and service rules are excluded before generic Node firewall analysis',()=>{
  for(const token of ['Get-NetFirewallServiceFilter',"$app.Package -ne 'Any'", "$service.Service -ne 'Any'",
    "Properties['PackageFamilyName']",'[Environment]::ExpandEnvironmentVariables',
    "return 'firewall-allow'","return 'firewall-block'","return 'firewall-uncertain'",
    'AddressMatch $address.LocalAddress $LocalIPv4','PortMatch $port.LocalPort',
    'AddressMatch $address.RemoteAddress $PeerIPv4'])assert.ok(policy.includes(token),token);
  for(const token of ["DefaultInboundAction -eq 'Allow'","AllowLocalFirewallRules -eq 'False'",'Get-CarebridgeSyntheticFirewallConflict'])assert.ok(source.includes(token),token);
  assert.ok(policy.indexOf('$app.Package')<policy.indexOf('PortMatch $port.LocalPort'));
  assert.doesNotMatch(source,/Set-NetConnectionProfile|Set-NetFirewallProfile|Remove-NetFirewallRule|Register-ScheduledTask/);
  assert.doesNotMatch(policy,/Set-Net|New-Net|Remove-Net|Register-ScheduledTask/);
});

test('launcher elevates only a fixed synchronous helper, preserves native cancellation and keeps timeout ownership',()=>{
  for(const token of ["$startInfo.Verb='runas'",'$startInfo.UseShellExecute=$true',
    '$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden','[Diagnostics.Process]::Start($startInfo)',
    '$cause -is [ComponentModel.Win32Exception]','$helper.WaitForExit()','$helper.HasExited','$helper.Dispose()',
    "['-NoProfile','-NonInteractive','-EncodedCommand'",
    "windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false","child.once('close'",'terminateReadOnly()',
    "fs.open(stopPath,'wx'",'statusHandle.read(buffer,0,65,0)',"error.reason",'get controlDirectory()',
    'ready,','waitForStop()'])assert.ok(source.includes(token),token);
  assert.doesNotMatch(source,/\.kill\('SIGKILL'|rm\(|rmdir\(|unlink\(|recursive:/);
  assert.ok(source.includes("if(readOnly&&!done)child?.kill()"));
});

function fakeChild(){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=0;
  child.finish=(code=0,signal=null)=>{child.stdout.end();child.stderr.end();child.emit('exit',code,signal);child.emit('close',code,signal);};
  child.kill=()=>{child.kills++;queueMicrotask(()=>child.finish(null,'SIGTERM'));return true;};
  return child;
}
function mockChildren(t,{inspection=inspectResult,launcher,launcherSpawnError,commands}={}){
  const children=[];
  t.mock.method(childProcess,'spawn',(_exe,args,options)=>{
    assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
    assert.ok(Object.keys(options.env).every(key=>['SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATH'].includes(key)));
    const command=Buffer.from(args.at(-1),'base64').toString('utf16le');
    commands?.push(command);
    if(!command.startsWith('$inputData=')&&launcherSpawnError)throw launcherSpawnError;
    const child=fakeChild();child.command=command;children.push(child);
    queueMicrotask(async()=>{
      child.emit('spawn');
      if(command.startsWith('$inputData=')){child.stdout.write(JSON.stringify(inspection));child.finish(inspection.ok?0:1);}
      else{
        const directory=command.match(/"-ControlDirectory" "([^"]+)"/)?.[1];assert.ok(directory);
        child.directory=directory;
        try{await launcher(child,directory,command);}catch(error){child.stderr.write(String(error));child.finish(1);}
      }
    });
    return child;
  });
  return children;
}
async function removeTestFiles(directory){
  if(!directory)return;
  assert.match(path.basename(directory),/^carebridge-synthetic-wifi-[a-f0-9-]{36}$/);
  for(const file of ['status.json','stop'])await fs.unlink(path.join(directory,file)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await fs.rmdir(directory);
}
async function waitFor(predicate){
  for(let n=0;n<150;n++){if(await predicate())return;await delay(20);}throw new Error('Test fixture observation timed out');
}

test('readonly inspection returns only identity and rejects sanitized preflight refusals without UAC',{skip:!native},async t=>{
  const children=mockChildren(t);
  assert.deepEqual(await inspectSyntheticWifiLease(input()),{ownerStartTimeUtcTicks:inspectResult.ownerStartTimeUtcTicks,interfaceIndex:8,interfaceAlias:'Wi-Fi'});
  assert.equal(children.length,1);assert.equal(children[0].kills,0);
});

test('preflight block owns no elevated child, and close verifies the observed readonly process exit',{skip:!native},async t=>{
  const children=mockChildren(t,{inspection:{schema:1,ok:false,reason:'firewall-block'}});
  const lease=createSyntheticWifiLease(input());
  assert.equal(typeof lease.close,'function');assert.ok(lease.ready instanceof Promise);
  await assert.rejects(lease.ready,{reason:'firewall-block'});
  assert.equal(children.length,1);assert.equal(lease.controlDirectory,null);
  const snapshot=lease.diagnostics;
  assert.deepEqual(sanitizeSyntheticWifiDiagnostic(snapshot),snapshot);
  assert.ok(Object.isFrozen(snapshot));assert.equal(snapshot.preflight,'failed');
  assert.equal(snapshot.launcher,null);assert.equal(snapshot.failureReason,'firewall-block');
  assert.deepEqual(await lease.close(),{stage:'removed'});
  assert.equal(snapshot.cleanup,'not-started');assert.equal(lease.diagnostics.cleanup,'confirmed');
  assert.equal(lease.diagnostics.failureReason,'firewall-block');
});

test('exact exception reaches readonly preflight and the fixed helper without selecting a different rule',{skip:!native},async t=>{
  const children=mockChildren(t,{launcher:async child=>{child.stdout.write('{"stage":"declined"}');child.finish(1223);}});
  const lease=createSyntheticWifiLease({...input(),temporaryTcpBlockRule:blockRule});
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});await lease.close();
  const payload=children[0].command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
  assert.equal(JSON.parse(Buffer.from(payload,'base64').toString()).temporaryTcpBlockRule,blockRule);
  assert.ok(children[1].command.includes(`"-TemporaryTcpBlockRule" "${blockRule}"`));
});

test('parent expiry ends admission even if helper remains active; restoration still needs a receipt',{skip:!native},async t=>{
  const originalTimeout=globalThis.setTimeout;let expire,helper;
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{
    if(milliseconds===60_000){assert.equal(expire,undefined);expire=callback;}
    return originalTimeout(callback,milliseconds,...args);
  });
  mockChildren(t,{launcher:async(child,directory)=>{helper=child;await fs.writeFile(path.join(directory,'status.json'),'{"stage":"active"}',{flag:'wx'});}});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{if(helper&&!helper.closed)helper.finish();await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await lease.ready;assert.equal(typeof expire,'function');expire();
  assert.deepEqual(await lease.waitForStop(),{stage:'failed'});
  assert.equal(lease.diagnostics.lifetimeExpired,true);assert.equal(lease.diagnostics.readyDeadlineExpired,false);
  assert.equal(lease.diagnostics.everActive,true);assert.equal(lease.diagnostics.cleanupDeadlineExpired,false);
  await waitFor(()=>fs.stat(path.join(helper.directory,'stop')).then(()=>true,()=>false));
  assert.notEqual(lease.status,'removed');
  await fs.writeFile(path.join(helper.directory,'status.json'),'{"stage":"removed"}');helper.finish();helper.closed=true;
  assert.deepEqual(await lease.close(),{stage:'removed'});
});

test('active lease returns ownership immediately and waits for removed plus actual child stream closure',{skip:!native},async t=>{
  let helper;
  const children=mockChildren(t,{launcher:async(child,directory,command)=>{
    helper=child;assert.ok(command.includes("$startInfo.Verb='runas'"));assert.ok(command.includes('$helper.WaitForExit()'));
    await fs.writeFile(path.join(directory,'status.json'),'{"stage":"active"}',{flag:'wx'});
  }});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{if(helper&&!helper.closed){helper.finish();}await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await lease.ready;assert.equal(lease.status,'active');
  let settled=false;const closing=lease.close().then(result=>{settled=true;return result;});
  await waitFor(()=>fs.stat(path.join(helper.directory,'stop')).then(()=>true,()=>false));
  await fs.writeFile(path.join(helper.directory,'status.json'),'{"stage":"removed"}');
  helper.emit('exit',0,null); // exit is not proof that pipes/helper launcher closed.
  assert.deepEqual(await lease.waitForStop(),{stage:'removed'});
  await delay(50);assert.equal(settled,false);
  const beforeClose=lease.diagnostics;
  assert.equal(beforeClose.launcher.exitObserved,true);assert.equal(beforeClose.launcher.closed,false);
  assert.equal(beforeClose.launcher.outcome,'pending');assert.equal(beforeClose.cleanup,'pending');
  assert.ok(Object.isFrozen(beforeClose)&&Object.isFrozen(beforeClose.launcher));
  assert.deepEqual(sanitizeSyntheticWifiDiagnostic(beforeClose),beforeClose);
  helper.finish();helper.closed=true;
  assert.deepEqual(await closing,{stage:'removed'});assert.equal(lease.status,'removed');
  assert.equal(beforeClose.launcher.closed,false);assert.equal(lease.diagnostics.launcher.closed,true);
  assert.equal(lease.diagnostics.launcher.outcome,'exited');assert.equal(lease.diagnostics.cleanup,'confirmed');
  assert.equal(children.length,2);assert.ok(children.every(child=>child.kills===0));
});

test('closing while UAC is pending creates stop first; late approval must produce removed before success',{skip:!native},async t=>{
  let helper;
  mockChildren(t,{launcher:async child=>{helper=child;}});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{if(helper&&!helper.closed)helper.finish();await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await waitFor(()=>helper);
  const closing=lease.close();
  await assert.rejects(lease.ready,{reason:'cancelled'});
  await waitFor(()=>fs.stat(path.join(helper.directory,'stop')).then(()=>true,()=>false));
  await fs.writeFile(path.join(helper.directory,'status.json'),'{"stage":"removed"}',{flag:'wx'});
  helper.finish();helper.closed=true;
  assert.deepEqual(await closing,{stage:'removed'});assert.equal(helper.kills,0);
});

test('explicit Windows UAC cancellation is terminal evidence that the elevated helper never started',{skip:!native},async t=>{
  const children=mockChildren(t,{launcher:async child=>{child.stdout.write('{"stage":"declined"}');child.finish(1223);}});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});
  assert.deepEqual(await lease.close(),{stage:'removed'});assert.equal(children[1].kills,0);
  assert.equal(lease.diagnostics.launcher.outcome,'declined');
  assert.equal(lease.diagnostics.launcher.exitCode,1223);assert.equal(lease.diagnostics.everActive,false);
});

test('launcher diagnostics require exact outcome pairs and never expose raw output',{skip:!native},async t=>{
  const marker='PRIVATE_LAUNCHER_OUTPUT_MUST_NOT_LEAK';
  const cases=[
    ['launch-failed',253,'{"stage":"launch-failed"}'],
    ['helper-failed',1,'{"stage":"helper-failed"}'],
    ['observation-failed',253,'{"stage":"observation-failed"}'],
    ['exited',0,''],
    ['unrecognized',0,'{"stage":"declined"}'],
    ['unrecognized',1223,marker],
    ['unrecognized',253,'{"stage":"launch-failed"}\n'],
    ['unrecognized',null,'','SIGTERM'],
  ];
  for(const [index,[expected,code,stdout,signal=null]] of cases.entries()) await t.test(`${index}: ${expected}/${code}`,async t=>{
    const children=mockChildren(t,{launcher:async(child,directory)=>{
      await fs.writeFile(path.join(directory,'status.json'),'{"stage":"removed"}',{flag:'wx'});
      child.stdout.write(stdout);child.stderr.write(marker);child.finish(code,signal);
    }});
    const lease=createSyntheticWifiLease(input());
    t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
    await assert.rejects(lease.ready,{reason:'approval'});
    const first=lease.diagnostics;
    assert.equal(first.launcher.outcome,expected);assert.equal(first.launcher.closed,true);
    assert.deepEqual(sanitizeSyntheticWifiDiagnostic(first),first);
    assert.doesNotMatch(JSON.stringify(first),new RegExp(marker));
    // Diagnostic classification is deliberately not a new cleanup authority.
    if(expected==='helper-failed'||(code===0&&!signal)) await lease.close();
    else await assert.rejects(lease.close(),{reason:'cleanup-pending'});
    assert.equal(lease.diagnostics.failureReason,first.failureReason);assert.equal(children[1].kills,0);
  });
});

test('synchronous launcher spawn failure is observed without inventing UAC visibility',{skip:!native},async t=>{
  const children=mockChildren(t,{launcherSpawnError:new Error('PRIVATE_SPAWN_ERROR')});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});
  assert.deepEqual(lease.diagnostics.launcher,{spawnObserved:false,exitObserved:false,closed:true,
    errorObserved:true,signalObserved:false,exitCode:null,outcome:'not-spawned'});
  assert.doesNotMatch(JSON.stringify(lease.diagnostics),/PRIVATE_SPAWN_ERROR|uacVisible|approved/);
  assert.deepEqual(await lease.close(),{stage:'removed'});assert.equal(children.length,1);
});

test('readiness and cleanup deadlines are separate observations; late approval still owns cleanup',{skip:!native},async t=>{
  const originalTimeout=globalThis.setTimeout;let now=Date.now(),helper;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>
    originalTimeout(callback,milliseconds===30_000?1:milliseconds,...args));
  mockChildren(t,{launcher:async child=>{helper=child;}});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{if(helper&&!helper.closed)helper.finish();await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await waitFor(()=>helper);now+=120_001;
  await assert.rejects(lease.ready,{reason:'approval'});
  const timedOut=lease.diagnostics;
  assert.equal(timedOut.readyDeadlineExpired,true);assert.equal(timedOut.lifetimeExpired,false);
  assert.equal(timedOut.cleanupDeadlineExpired,false);assert.equal(timedOut.launcher.closed,false);
  assert.equal(timedOut.failureReason,'approval');assert.equal(timedOut.everActive,false);
  await assert.rejects(lease.close(),{reason:'cleanup-pending'});
  assert.equal(lease.diagnostics.cleanupDeadlineExpired,true);assert.equal(lease.diagnostics.cleanup,'unconfirmed');
  assert.equal(lease.diagnostics.launcher.closed,false);assert.equal(helper.kills,0);
  assert.ok((await fs.stat(path.join(helper.directory,'stop'))).isFile());
  await fs.writeFile(path.join(helper.directory,'status.json'),'{"stage":"removed"}',{flag:'wx'});
  helper.finish();helper.closed=true;
  assert.deepEqual(await lease.close(),{stage:'removed'});
  assert.equal(lease.diagnostics.cleanup,'confirmed');assert.equal(lease.diagnostics.failureReason,'approval');
  assert.equal(lease.diagnostics.readyDeadlineExpired,true);assert.equal(lease.diagnostics.cleanupDeadlineExpired,true);
  assert.equal(helper.kills,0);
});

test('a failed helper receipt is not a verified cleanup even when the launcher has exited',{skip:!native},async t=>{
  mockChildren(t,{launcher:async(child,directory)=>{
    await fs.writeFile(path.join(directory,'status.json'),'{"stage":"failed"}',{flag:'wx'});child.finish(1);
  }});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});
  assert.deepEqual(await lease.waitForStop(),{stage:'failed'});
  await assert.rejects(lease.close(),{reason:'cleanup-pending'});
  await assert.rejects(lease.close(),{reason:'cleanup-pending'}); // retries preserve ownership, no fake terminal success.
});

test('helper failure remains a readiness failure but verified rule/task absence allows owned cleanup',{skip:!native},async t=>{
  mockChildren(t,{launcher:async(child,directory)=>{
    await fs.writeFile(path.join(directory,'status.json'),'{"stage":"removed"}',{flag:'wx'});
    child.stdout.write('{"stage":"helper-failed"}');child.finish(1);
  }});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});
  assert.deepEqual(await lease.close(),{stage:'removed'});
});

test('read-only inspection and elevated-launch command both parse as PowerShell without being executed',{skip:!native},async t=>{
  const originalSpawn=childProcess.spawn;
  const commands=[];
  const children=mockChildren(t,{commands,launcher:async child=>{child.stdout.write('{"stage":"declined"}');child.finish(1223);}});
  // Apostrophes, parentheses and dollar signs remain literal argument data.
  // The parser is run; neither captured command body is executed by this test.
  const literalRule=blockRule.replace('Fixture', "Fixture O'Neil$()");
  const lease=createSyntheticWifiLease({...input(),temporaryTcpBlockRule:literalRule});
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready);await lease.close();assert.equal(children.length,2);
  // Use the captured real spawn only for Parser.ParseInput: never either command body.
  for(const value of commands){
    const parser=`$t=$null;$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}')),[ref]$t,[ref]$e);if($e.Count){exit 1};exit 0`;
    const actual=originalSpawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parser,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
    const result=await new Promise((resolve,reject)=>{actual.once('error',reject);actual.once('close',resolve);});
    assert.equal(result,0);
  }
});

test('actual PowerShell classifies generated launcher outcomes through an inert Process.Start replacement',{skip:!native},async t=>{
  const children=mockChildren(t,{launcher:async child=>{child.stdout.write('{"stage":"declined"}');child.finish(1223);}});
  const lease=createSyntheticWifiLease(input());
  t.after(async()=>{await lease.close().catch(()=>{});await removeTestFiles(lease.controlDirectory);});
  await assert.rejects(lease.ready,{reason:'approval'});await lease.close();
  assert.equal(children.length,2);
  const command=children[1].command;
  const nativeStart='[Diagnostics.Process]::Start($startInfo)';
  assert.equal(command.split(nativeStart).length-1,1);
  const inertCommand=command.replace(nativeStart,'[CarebridgeInertLaunch]::Start($startInfo)');
  // Fail before running PowerShell if a real process-launch path remains.
  // All other generated launcher code, including catch/wait/dispose, is exact.
  assert.doesNotMatch(inertCommand,/\[(?:System\.)?Diagnostics\.Process\]::Start|\bStart-Process\b|Invoke-Expression/);
  const fake=String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
public sealed class CarebridgeFakeNativeException : Exception {
    public int NativeErrorCode { get { return 1223; } }
}
public sealed class CarebridgeInertHelper {
    public void WaitForExit() {
        Console.Error.Write("wait;");
        if (CarebridgeInertLaunch.Scenario == "wait-1223") throw new Win32Exception(1223);
    }
    public bool HasExited { get {
        Console.Error.Write("has-exited;");
        if (CarebridgeInertLaunch.Scenario == "has-exited-1223") throw new Win32Exception(1223);
        return CarebridgeInertLaunch.Scenario != "still-running";
    } }
    public int ExitCode { get {
        Console.Error.Write("exit;");
        if (CarebridgeInertLaunch.Scenario == "exit-1223") throw new Win32Exception(1223);
        if (CarebridgeInertLaunch.Scenario == "helper-1223") return 1223;
        return CarebridgeInertLaunch.Scenario == "helper-one" ? 1 : 0;
    } }
    public void Dispose() {
        Console.Error.Write("dispose;");
        if (CarebridgeInertLaunch.Scenario == "dispose-1223") throw new Win32Exception(1223);
    }
}
public static class CarebridgeInertLaunch {
    public static string Scenario;
    public static CarebridgeInertHelper Start(ProcessStartInfo info) {
        if (!info.UseShellExecute || info.Verb != "runas" || info.WindowStyle != ProcessWindowStyle.Hidden ||
            info.RedirectStandardInput || info.RedirectStandardOutput || info.RedirectStandardError ||
            String.IsNullOrEmpty(info.FileName) || !info.FileName.EndsWith("pwsh.exe",StringComparison.OrdinalIgnoreCase) ||
            !info.Arguments.Contains("\"-File\"") || !info.Arguments.Contains("\"-ControlDirectory\""))
            throw new InvalidOperationException("FAKE_CONFIGURATION_REJECTED");
        Console.Error.Write("configured;start;");
        if (Scenario == "start-1223") throw new Win32Exception(1223);
        if (Scenario == "wrapped-start-1223") throw new InvalidOperationException("mock",new Win32Exception(1223));
        if (Scenario == "start-five") throw new Win32Exception(5);
        if (Scenario == "message-only-1223") throw new InvalidOperationException("1223");
        if (Scenario == "cmdlet-message-only") throw new InvalidOperationException(new Win32Exception(1223).Message);
        if (Scenario == "spoofed-native-property") throw new CarebridgeFakeNativeException();
        if (Scenario == "start-null") return null;
        return new CarebridgeInertHelper();
    }
}
`;
  const start='configured;start;', complete=start+'wait;has-exited;exit;dispose;';
  const cases=[
    ['start-1223',1223,'{"stage":"declined"}',start],
    ['wrapped-start-1223',1223,'{"stage":"declined"}',start],
    ['start-five',253,'{"stage":"launch-failed"}',start],
    ['message-only-1223',253,'{"stage":"launch-failed"}',start],
    ['cmdlet-message-only',253,'{"stage":"launch-failed"}',start],
    ['spoofed-native-property',253,'{"stage":"launch-failed"}',start],
    ['start-null',253,'{"stage":"launch-failed"}',start],
    ['wait-1223',253,'{"stage":"observation-failed"}',start+'wait;dispose;'],
    ['has-exited-1223',253,'{"stage":"observation-failed"}',start+'wait;has-exited;dispose;'],
    ['still-running',253,'{"stage":"observation-failed"}',start+'wait;has-exited;dispose;'],
    ['exit-1223',253,'{"stage":"observation-failed"}',complete],
    ['dispose-1223',253,'{"stage":"observation-failed"}',complete],
    ['helper-1223',253,'{"stage":"observation-failed"}',complete],
    ['helper-zero',0,'',complete],
    ['helper-one',1,'{"stage":"helper-failed"}',complete],
  ];
  for(const [scenario,code,stdout,events] of cases) await t.test(scenario,()=>{
    const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${fake}\n'@\n[CarebridgeInertLaunch]::Scenario='${scenario}';\n${inertCommand}`;
    assert.doesNotMatch(script,/\[(?:System\.)?Diagnostics\.Process\]::Start|\bStart-Process\b|Process\.Start\(/);
    const result=childProcess.spawnSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {encoding:'utf8',windowsHide:true,timeout:20_000,maxBuffer:8192});
    assert.equal(result.error,undefined,scenario);assert.equal(result.signal,null,scenario);
    assert.equal(result.status,code,scenario);assert.equal(result.stdout,stdout,scenario);
    // The inert helper emits only ordering telemetry. A raw exception/error
    // record, unexpected launch, skipped wait or skipped dispose fails here.
    assert.equal(result.stderr,events,scenario);
  });
});

test('PowerShell cmdlet-style message-only wrapping loses native 1223 and must not be guessed from text',{skip:!native},()=>{
  // Mirrors official PowerShell v7.6.5 Process.cs StartWithShellExecute:
  // Win32Exception.Message -> InvalidOperationException(message), no inner.
  // This advanced function shadows the cmdlet and never starts a process.
  const script=String.raw`
function Start-Process {
  [CmdletBinding()]param()
  $native=[ComponentModel.Win32Exception]::new(1223);
  $wrapped=[InvalidOperationException]::new($native.Message);
  $record=[Management.Automation.ErrorRecord]::new($wrapped,'InvalidOperationException',[Management.Automation.ErrorCategory]::InvalidOperation,$null);
  $PSCmdlet.ThrowTerminatingError($record)
}
$ErrorActionPreference='Stop';
try { Start-Process; exit 2 }
catch {
  $cause=$_.Exception; $nativeFound=$false; $depth=0;
  while($null -ne $cause) {
    $depth++;
    if($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223){$nativeFound=$true};
    $cause=$cause.InnerException
  };
  [Console]::Out.Write(([ordered]@{nativeFound=$nativeFound;depth=$depth;messagePresent=([string]$_.Exception.Message).Length -gt 0}|ConvertTo-Json -Compress));
  exit 0
}`;
  const result=childProcess.spawnSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:20_000,maxBuffer:8192});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{nativeFound:false,depth:1,messagePresent:true});
});

test('shared firewall policy checks real matching logic against mocked rule/filter snapshots only',{skip:!native},async()=>{
  const own='Carebridge-Synthetic-WiFi-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const base={rule:{Name:'fixture',InstanceID:'fixture',Profile:'Public',Action:'Allow',PackageFamilyName:''},
    app:{InstanceID:'fixture',Program:'C:\\Fixture\\node.exe',Package:'Any'},service:{InstanceID:'fixture',Service:'Any'},
    port:{InstanceID:'fixture',Protocol:'TCP',LocalPort:['Any']},address:{InstanceID:'fixture',LocalAddress:['Any'],RemoteAddress:['Any']},
    iface:{InstanceID:'fixture',InterfaceAlias:['Any']},type:{InstanceID:'fixture',InterfaceType:['Any']},exclude:''};
  const fixture=(name,change,expected)=>{const value=structuredClone(base);change(value);return {name,...value,expected};};
  const cases=[fixture('ordinary Node broad allow',()=>{},'firewall-allow'),
    fixture('another canonical node path',v=>{v.app.Program='C:\\OtherFixture\\node.exe';},null),
    fixture('system program',v=>{v.app.Program='System';},null),
    fixture('unresolved program macro',v=>{v.app.Program='%CAREBRIDGE_UNDEFINED_FIXTURE%\\node.exe';},'firewall-uncertain'),
    fixture('8.3 ambiguous program',v=>{v.app.Program='C:\\FIXTUR~1\\node.exe';},'firewall-uncertain'),
    fixture('app filter package',v=>{v.app.Program='Any';v.app.Package='S-1-15-2-1234';},null),
    fixture('rule package family with blank app package',v=>{v.rule.PackageFamilyName='FixtureApp_123';v.app.Package='';v.app.Program='Any';},null),
    fixture('service restricted',v=>{v.app.Program='Any';v.service.Service='FixtureService';},null),
    fixture('different profile',v=>{v.rule.Profile='Private';},null),
    fixture('different TCP port',v=>{v.port.LocalPort=['3000-4000'];},null),
    fixture('range covers 8443',v=>{v.port.LocalPort=['8000-9000'];},'firewall-allow'),
    fixture('unknown port keyword',v=>{v.port.LocalPort=['Uncertain'];},'firewall-uncertain'),
    fixture('different local subnet',v=>{v.address.LocalAddress=['10.232.0.0/16'];},null),
    fixture('local subnet covers host',v=>{v.address.LocalAddress=['10.231.9.0/24'];},'firewall-allow'),
    fixture('phone block',v=>{v.rule.Action='Block';v.address.RemoteAddress=['10.231.9.11'];},'firewall-block'),
    fixture('other address block',v=>{v.rule.Action='Block';v.address.RemoteAddress=['10.231.9.20'];},null),
    fixture('unknown local address keyword',v=>{v.address.LocalAddress=['UnknownKeyword'];},'firewall-uncertain'),
    fixture('different interface',v=>{v.iface.InterfaceAlias=['Other Wi-Fi'];},null),
    fixture('only exact own UUID excluded',v=>{v.rule.Name=own;v.exclude=own;},null),
    fixture('invalid exclusion',v=>{v.exclude='Carebridge-*';},'firewall-uncertain')];
  const shared=policyFile.pathname.slice(1).replaceAll('/','\\');
  // Every firewall command is replaced by a local fixture function before the
  // shared policy executes. This tests the decision logic, not OS firewall IO.
  const script=`$ErrorActionPreference='Stop';. '${decodeURIComponent(shared).replaceAll("'","''")}';
function Get-NetFirewallRule{return $script:item.rule}
function Get-NetFirewallApplicationFilter{return $script:item.app}
function Get-NetFirewallServiceFilter{return $script:item.service}
function Get-NetFirewallPortFilter{return $script:item.port}
function Get-NetFirewallAddressFilter{return $script:item.address}
function Get-NetFirewallInterfaceFilter{return $script:item.iface}
function Get-NetFirewallInterfaceTypeFilter{return $script:item.type}
$cases=([Console]::In.ReadToEnd()|ConvertFrom-Json);
$results=@(foreach($item in $cases){$script:item=$item;$result=Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath 'C:\\Fixture\\node.exe' -LocalIPv4 '10.231.9.10' -PeerIPv4 '10.231.9.11' -InterfaceAlias 'Wi-Fi' -ExcludeRuleName $item.exclude;@{name=$item.name;actual=$result}});
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))`;
  const result=childProcess.spawnSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:65_536});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),cases.map(({name,expected})=>({name,actual:expected})));
});
