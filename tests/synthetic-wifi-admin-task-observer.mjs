// Dedicated, read-only elevation for one synthetic lease's cleanup task.
// The application, database and lease owner are never elevated here.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSystemErrorName } from 'node:util';
import { privateSecretEnvironment } from '../server/windows-private-secret-io.mjs';
import { syntheticWifiTaskShapeScript } from './synthetic-wifi-task-shape.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXIT_PHASES = Object.freeze({ 0: 'verified', 10: 'admin-role', 11: 'expired', 12: 'module',
  13: 'task-query', 14: 'task-count', 15: 'task-fields', 16: 'task-action', 17: 'task-trigger', 18: 'inspection' });
export const syntheticWifiAdminTaskFailurePhases = Object.freeze([
  'configuration', 'cancelled', 'expired', 'launch', 'protocol', 'declined', 'observation',
  'admin-role', 'module', 'task-query', 'task-count', 'task-fields', 'task-action', 'task-trigger', 'inspection'
]);
const MAX_OUTPUT = 512;
const encode = value => Buffer.from(value, 'utf16le').toString('base64');
function fail(phase) {
  const error = new Error('ADMIN_TASK_OBSERVATION_FAILED');
  error.code = 'ADMIN_TASK_OBSERVATION_FAILED'; error.phase = phase;
  return error;
}
function options(input) {
  if (!input || ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== 3 ||
      Reflect.ownKeys(input).some(key => !['powershell', 'leaseId', 'expiresAt'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) throw fail('configuration');
  const { powershell, leaseId, expiresAt } = input;
  if (typeof powershell !== 'string' || powershell.length > 240 || !/^[A-Za-z]:\\/.test(powershell) ||
      /[<>"|?*\x00-\x1f/]/.test(powershell) || powershell.slice(2).includes(':') ||
      path.win32.normalize(powershell) !== powershell ||
      powershell.split('\\').slice(1).some(part => !part || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) ||
      path.win32.basename(powershell).toLowerCase() !== 'pwsh.exe' ||
      typeof leaseId !== 'string' || !UUID.test(leaseId) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 7_200_000) throw fail('configuration');
  return Object.freeze({ powershell, leaseId, expiresAt });
}

function scripts({ leaseId, expiresAt }) {
  // Only the validated UUID and integer deadline are interpolated. No file,
  // network, caller-supplied script or result-channel input is consumed.
  const elevated = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';
Set-StrictMode -Version Latest;
$taskName='Carebridge-Synthetic-WiFi-Cleanup-${leaseId}';
$marker='Carebridge temporary synthetic-only Wi-Fi lease ${leaseId}';
$deadline=[long]${expiresAt};$observationPhase='admin-role';
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent();
  try {if(-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'REFUSED'}}finally{$identity.Dispose()};
  $observationPhase='expired';if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline){throw 'REFUSED'};
  $observationPhase='module';
  $system=[Environment]::GetFolderPath([Environment+SpecialFolder]::System);
  if([string]::IsNullOrWhiteSpace($system)){throw 'REFUSED'};
  $manifest=[IO.Path]::Combine($system,'WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1');
  Import-Module -Name $manifest -ErrorAction Stop -WarningAction SilentlyContinue;
  $observationPhase='expired';if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline){throw 'REFUSED'};
  $observationPhase='task-query';
  $tasks=@(ScheduledTasks\Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop);
  $observationPhase='task-count';if($tasks.Count -ne 1){throw 'REFUSED'};
${syntheticWifiTaskShapeScript}
  $observationPhase='expired';if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline){throw 'REFUSED'};
  exit 0
} catch {
  switch -CaseSensitive ($observationPhase) {
    'admin-role' {exit 10};'expired' {exit 11};'module' {exit 12};'task-query' {exit 13};
    'task-count' {exit 14};'task-fields' {exit 15};'task-action' {exit 16};'task-trigger' {exit 17};
    default {exit 18}
  }
}`;
  const elevatedEncoded = encode(elevated);
  const launcher = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';
Set-StrictMode -Version Latest;
function Emit([string]$state,[int]$code,[bool]$healthy){
  $flag=if($healthy){'true'}else{'false'};
  [Console]::Out.Write('{"schema":1,"state":"'+$state+'","code":'+$code.ToString([Globalization.CultureInfo]::InvariantCulture)+',"healthy":'+$flag+'}')
};
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent();
  try {if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'REFUSED'}}finally{$identity.Dispose()};
  if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]${expiresAt}){Emit 'not-started' 11 $true;exit 0};
  $system=[Environment]::GetFolderPath([Environment+SpecialFolder]::System);
  if([string]::IsNullOrWhiteSpace($system)){throw 'REFUSED'};
  $startInfo=[Diagnostics.ProcessStartInfo]::new();
  $startInfo.FileName=[IO.Path]::Combine($system,'WindowsPowerShell\v1.0\powershell.exe');
  $startInfo.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${elevatedEncoded}';
  $startInfo.UseShellExecute=$true;$startInfo.Verb='runas';$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;
} catch {Emit 'unknown' 253 $false;exit 0};
try {$helper=[Diagnostics.Process]::Start($startInfo)}
catch {
  $cause=$_.Exception;$declined=$false;
  for($depth=0;$null -ne $cause -and $depth -lt 8;$depth++){
    if($cause.GetType() -eq [ComponentModel.Win32Exception]){$declined=$cause.NativeErrorCode -eq 1223;break};
    if($cause -isnot [Management.Automation.RuntimeException] -and $cause -isnot [Reflection.TargetInvocationException]){break};
    $cause=$cause.InnerException
  };
  if($declined){Emit 'declined' 1223 $true}else{Emit 'unknown' 253 $false};exit 0
};
if($null -eq $helper){Emit 'unknown' 253 $false;exit 0};
$observed=$false;$healthy=$true;$code=255;
# A wait error is sticky, but does not end ownership of a possibly live reader.
# Never kill the launcher or infer reader exit from elapsed time / a PID lookup.
while(-not $observed){
  try {$null=$helper.WaitForExit(250)}catch{$healthy=$false};
  try {
    $exited=$helper.HasExited;
    if($exited -isnot [bool]){throw 'REFUSED'};
    if($exited){
      $observed=$true;
      try {$raw=$helper.ExitCode;if($raw -is [int] -and $raw -in @(0,10,11,12,13,14,15,16,17,18)){$code=$raw}else{$healthy=$false}}
      catch {$healthy=$false}
    }
  } catch {$healthy=$false};
  if(-not $observed){[Threading.Thread]::Sleep(100)}
};
try {$helper.Dispose()}catch{$healthy=$false};
Emit 'exited' $code $healthy;exit 0`;
  // Windows CreateProcess command lines have a 32,767 UTF-16 character limit.
  if (launcher.length + 512 > 32_000 || elevatedEncoded.length + 512 > 32_000) throw fail('configuration');
  return Object.freeze({ elevated, launcher });
}

// Export strings for AST inspection and managed-facade tests, never execution
// of the native probe. Production callers use createAdminTaskObservation only.
export function syntheticWifiAdminTaskScripts(input) { return scripts(options(input)); }

async function assertExecutable(file) {
  if (process.platform !== 'win32' || (await fs.realpath(file)).toLowerCase() !== file.toLowerCase()) throw fail('configuration');
  let current = path.win32.parse(file).root;
  for (const part of file.slice(current.length).split('\\')) {
    current = path.win32.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw fail('configuration');
    if (current.toLowerCase() === file.toLowerCase() && (!stat.isFile() || stat.nlink !== 1)) throw fail('configuration');
  }
}

function receipt(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
  if (!value || Object.keys(value).join(',') !== 'schema,state,code,healthy' || JSON.stringify(value) !== text ||
      value.schema !== 1 || typeof value.healthy !== 'boolean' || !Number.isInteger(value.code)) throw fail('protocol');
  if (value.state === 'exited' && (Object.hasOwn(EXIT_PHASES, value.code) || value.code === 255)) return value;
  if (value.state === 'declined' && value.code === 1223 && value.healthy) return value;
  if (value.state === 'not-started' && value.code === 11 && value.healthy) return value;
  if (value.state === 'unknown' && value.code === 253 && !value.healthy) return value;
  throw fail('protocol');
}

function nativeSpawnRefusal(error) {
  // Node 24's internal ChildProcess.spawn closes its handle before throwing
  // this native-spawn error. Do not treat an arbitrary synchronous exception
  // (which could arise after creation) as proof that no launcher exists.
  try {
    return error instanceof Error && error.syscall === 'spawn' && Number.isInteger(error.errno) &&
      error.errno < 0 && getSystemErrorName(error.errno) === error.code;
  } catch { return false; }
}

export function createAdminTaskObservation(input) {
  const value = options(input), command = scripts(value).launcher;
  let settled = false, cancelled = false, resolveResult, rejectResult, resolveClosed;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  result.catch(() => {});
  function reject(phase) { if (!settled) { settled = true; rejectResult(fail(phase)); } }
  const timer = setTimeout(() => reject('expired'), Math.max(0, value.expiresAt - Date.now()));
  timer.unref?.();
  function finishClosed(confirmed) { clearTimeout(timer); resolveClosed(Object.freeze({ confirmed })); }
  void (async () => {
    try { await assertExecutable(value.powershell); }
    catch { reject('configuration'); finishClosed(true); return; } // No start attempted.
    if (cancelled || Date.now() >= value.expiresAt) {
      reject(cancelled ? 'cancelled' : 'expired'); finishClosed(true); return;
    }
    let child, spawned = false, invalid = false, spawnError = false, size = 0, stderrSize = 0;
    const chunks = [];
    try {
      // shell:false passes this fixed launcher as one argument; encoding it a
      // second time would needlessly approach Windows' command-line limit.
      child = childProcess.spawn(value.powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: privateSecretEnvironment(process.env, value.powershell)
      });
    } catch (error) { reject('launch'); finishClosed(nativeSpawnRefusal(error)); return; }
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => { spawnError = !spawned; invalid = true; reject('launch'); });
    for (const stream of [child.stdout, child.stderr]) stream?.once('error', () => { invalid = true; reject('protocol'); });
    child.stdout?.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { invalid = true; reject('protocol'); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', chunk => { stderrSize += chunk.length; if (chunk.length) { invalid = true; reject('protocol'); } });
    // Node's close event is after process exit AND its stdio streams close.
    child.once('close', (code, signal) => {
      // Per Node's event contract, a failed spawn emits error instead of spawn,
      // leaves pid undefined and closes stdio before close. No kill/send/abort
      // API is used here, so this exact event path proves no launcher started.
      if (!spawned && spawnError && child.pid === undefined && size === 0 && stderrSize === 0 && signal === null) {
        reject('launch'); finishClosed(true); return;
      }
      let record;
      try {
        if (!spawned || invalid || code !== 0 || signal !== null) throw fail('protocol');
        record = receipt(Buffer.concat(chunks));
      } catch { reject('protocol'); finishClosed(false); return; }
      finally { for (const chunk of chunks) chunk.fill(0); }
      const confirmed = record.state === 'exited' || record.state === 'declined' || record.state === 'not-started';
      finishClosed(confirmed);
      if (cancelled) { reject('cancelled'); return; }
      if (Date.now() >= value.expiresAt) { reject('expired'); return; }
      if (record.state === 'declined') { reject('declined'); return; }
      if (record.state === 'not-started') { reject('expired'); return; }
      if (record.state !== 'exited' || !record.healthy || record.code === 255) { reject('observation'); return; }
      if (record.code !== 0) { reject(EXIT_PHASES[record.code]); return; }
      if (!settled) { settled = true; resolveResult(Object.freeze({ verified: true })); }
    });
  })().catch(() => { reject('observation'); finishClosed(false); });
  return Object.freeze({ result, closed, cancel() { cancelled = true; reject('cancelled'); } });
}
