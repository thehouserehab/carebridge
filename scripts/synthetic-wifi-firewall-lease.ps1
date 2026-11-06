# Elevated, synthetic-only lease. The caller owns UAC and the HTTPS listener.
# No network category, router, DNS, or certificate store changes. One exact
# approved TCP block may receive a guarded, automatically restored port exception.
# A separate SYSTEM cleanup task limits residual PersistentStore rules after
# helper termination / power loss. Normal callers still await removed.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OwnerPid,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]{17,19}$')][string]$OwnerStartTimeUtcTicks,
    [Parameter(Mandatory)][string]$NodeExecutablePath,
    [Parameter(Mandatory)][string]$LocalIPv4,
    [Parameter(Mandatory)][string]$PeerIPv4,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$InterfaceIndex,
    [Parameter(Mandatory)][string]$ControlDirectory,
    [ValidateRange(60,7200)][int]$MaxLifetimeSeconds = 7200,
    [string]$TemporaryTcpBlockRule = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$statusStream = $null
$processHandle = $null
$pathHandles = [Collections.Generic.List[IDisposable]]::new()
$creationStarted = $false
$cleanupVerified = $false
$taskCleanupVerified = $false
$adminVerified = $false
$failed = $false
$ruleName = $null
$ruleMarker = $null
$taskRegistrationStarted = $false
$taskName = $null
$taskExecutable = $null
$taskArguments = $null
$exceptionContext = $null
$exceptionArmed = $false
$lifetimeMutex = $null
$operationMutex = $null
$lifetimeLocked = $false
$operationLocked = $false
$verifiedGuardNames = @()
$currentFailurePhase = 'initialization'
$firstFailurePhase = 'none'
$firstFailureLine = 0
$cleanupObservationPhase = 'none'
$firstCleanupFailure = 'none'
$firstCleanupFailureLine = 0

# Pin the process itself, not a PID lookup that could adopt a replacement.
# File handles refuse reparse points and remain open without FILE_SHARE_DELETE.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CarebridgeWifiLeaseNative {
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes; public FileTime Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(SafeWaitHandle process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    static Exception Invalid() { return new InvalidOperationException("SYNTHETIC_WIFI_LEASE_UNAVAILABLE"); }
    public static SafeWaitHandle PinProcess(int pid, long ticks, string executable) {
        var handle = OpenProcess(0x00101000, false, (uint)pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        try {
            if (handle.IsInvalid || !Matches(handle, ticks, executable)) throw Invalid();
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    public static bool Matches(SafeWaitHandle handle, long ticks, string executable) {
        FileTime created, exited, kernel, user;
        if (WaitForSingleObject(handle, 0) != 258 || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) return false;
        var fileTime = ((long)created.High << 32) | created.Low;
        var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
        return DateTime.FromFileTimeUtc(fileTime).Ticks == ticks &&
            QueryFullProcessImageName(handle, 0, path, ref length) &&
            String.Equals(path.ToString(), executable, StringComparison.OrdinalIgnoreCase);
    }
    public static bool WaitExited(SafeWaitHandle handle, uint milliseconds) {
        var result = WaitForSingleObject(handle, milliseconds);
        if (result == 0) return true;
        if (result == 258) return false;
        throw Invalid();
    }
    public static void CheckFile(SafeFileHandle handle, string expected, bool directory) {
        FileInfo info;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) ||
            (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || info.Links != 1) throw Invalid();
        var path = new StringBuilder(32768);
        uint count = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        if (count == 0 || count >= path.Capacity) throw Invalid();
        var actual = path.ToString();
        if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
        if (!String.Equals(actual.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw Invalid();
    }
    public static SafeFileHandle PinPath(string path, bool directory) {
        // Attributes-only read for directories; pin the executable against writes too.
        var handle = CreateFile(path, directory ? 0U : 0x80000000U, directory ? 3U : 1U,
            IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); // OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        try { CheckFile(handle, path, directory); return handle; }
        catch { handle.Dispose(); throw; }
    }
    public static FileStream CreateStatus(string path) {
        var handle = CreateFile(path, 0xC0000000, 1, IntPtr.Zero, 1, 0x80200000, IntPtr.Zero);
        // CREATE_NEW + OPEN_REPARSE_POINT + WRITE_THROUGH; readers only, no rename/delete.
        try { CheckFile(handle, path, false); return new FileStream(handle, FileAccess.ReadWrite, 4096, false); }
        catch { handle.Dispose(); throw; }
    }
}
'@

function Assert-CanonicalLocalPath([string]$Path) {
    if ($Path -cnotmatch '^[A-Za-z]:\\' -or $Path.Length -gt 240 -or
        $Path.Substring(2) -match '[:/\x00-\x1f]' -or $Path.EndsWith('\') -or
        $Path -match '(?:^|\\)(?:\.|\.\.)(?:\\|$)' -or $Path -match '[ .](?:\\|$)' -or
        -not [String]::Equals([IO.Path]::GetFullPath($Path), $Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE'
    }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if ($part.Length -eq 0 -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    }
}
function Assert-PrivateIPv4([string]$Value) {
    if ($Value -cnotmatch '^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Value,[ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $bytes = $address.GetAddressBytes()
    if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Pin-DirectoryChain([string]$Directory) {
    $root = [IO.Path]::GetPathRoot($Directory)
    $pathHandles.Add([CarebridgeWifiLeaseNative]::PinPath($root,$true))
    $current = $root
    foreach ($part in $Directory.Substring($root.Length).Split('\')) {
        $current = [IO.Path]::Combine($current,$part)
        $pathHandles.Add([CarebridgeWifiLeaseNative]::PinPath($current,$true))
    }
}
function Assert-NetworkBoundary([string]$ExpectedAlias = '') {
    $adapters = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $InterfaceIndex })
    if ($adapters.Count -ne 1 -or $adapters[0].Status -ne 'Up' -or [int]$adapters[0].NdisPhysicalMedium -notin @(1,9)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $alias = [string]$adapters[0].Name
    if ([string]::IsNullOrWhiteSpace($alias) -or $alias.IndexOfAny([char[]]'*?[]') -ge 0 -or ($ExpectedAlias -ne '' -and $alias -cne $ExpectedAlias)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $profiles = @(Get-NetConnectionProfile -InterfaceIndex $InterfaceIndex -ErrorAction Stop)
    if ($profiles.Count -ne 1 -or [string]$profiles[0].NetworkCategory -cne 'Public') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $addresses = @(Get-NetIPAddress -InterfaceIndex $InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -ceq $LocalIPv4 -and $_.AddressState -eq 'Preferred' })
    if ($addresses.Count -ne 1 -or $addresses[0].PrefixLength -lt 8 -or $addresses[0].PrefixLength -gt 30) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $localBytes = ([Net.IPAddress]::Parse($LocalIPv4)).GetAddressBytes()
    $peerBytes = ([Net.IPAddress]::Parse($PeerIPv4)).GetAddressBytes()
    for ($i = 0; $i -lt [int]$addresses[0].PrefixLength; $i++) {
        $mask = 1 -shl (7 - ($i % 8)); $byte = [int][Math]::Floor($i / 8)
        if (($localBytes[$byte] -band $mask) -ne ($peerBytes[$byte] -band $mask)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    }
    $firewall = @(Get-NetFirewallProfile -Name Public -PolicyStore ActiveStore -ErrorAction Stop)
    if ($firewall.Count -ne 1 -or [string]$firewall[0].Enabled -ne 'True' -or [string]$firewall[0].AllowInboundRules -eq 'False' -or
        [string]$firewall[0].DefaultInboundAction -eq 'Allow' -or [string]$firewall[0].AllowLocalFirewallRules -eq 'False') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    return $alias
}
function Get-ExactRule([string]$Store) {
    # Full enumeration with terminating errors distinguishes absence from provider failure.
    return @(Get-NetFirewallRule -PolicyStore $Store -ErrorAction Stop | Where-Object { $_.Name -ceq $ruleName })
}
function Assert-NoOverlappingFirewallRule([string]$Alias) {
    $conflict = Get-CarebridgeSyntheticFirewallConflict -NodeExecutablePath $NodeExecutablePath -LocalIPv4 $LocalIPv4 `
        -PeerIPv4 $PeerIPv4 -InterfaceAlias $Alias -ExcludeRuleName $ruleName `
        -TemporaryTcpBlockRule $TemporaryTcpBlockRule -VerifiedGuardNames $verifiedGuardNames `
        -AllowAdjustedTemporaryBlock:($verifiedGuardNames.Count -eq 2)
    if ($null -ne $conflict) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Assert-OneValue($Values, [string]$Expected) {
    $items = @($Values)
    if ($items.Count -ne 1 -or [string]$items[0] -cne $Expected) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Assert-AddressValue($Values, [string]$Expected) {
    $items = @($Values)
    if ($items.Count -ne 1 -or ([string]$items[0] -cne $Expected -and [string]$items[0] -cne ($Expected + '/32'))) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Assert-RuleBoundary($Rule, [string]$Alias) {
    if ($Rule.Name -cne $ruleName -or $Rule.Description -cne $ruleMarker -or [string]$Rule.Enabled -ne 'True' -or
        [string]$Rule.Direction -ne 'Inbound' -or [string]$Rule.Action -ne 'Allow' -or
        [string]$Rule.Profile -ne 'Public' -or [string]$Rule.EdgeTraversalPolicy -ne 'Block') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $applications = @($Rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    $addresses = @($Rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $ports = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $interfaces = @($Rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
    $types = @($Rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
    if ($applications.Count -ne 1 -or $addresses.Count -ne 1 -or $ports.Count -ne 1 -or $interfaces.Count -ne 1 -or $types.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    # Dynamic keywords can add destinations beside the displayed static IPs.
    # An app-id also must not change the identity scope of this exact-program
    # rule. Inspect all provider locations on creation AND every lease check.
    foreach ($scope in @($Rule,$applications[0],$addresses[0])) {
        foreach ($field in @('RemoteDynamicKeywordAddresses','PolicyAppId')) {
            if ($scope.PSObject.Properties[$field] -and
                @($scope.$field | Where-Object { $null -ne $_ -and [string]$_ -ne '' }).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        }
    }
    if (-not [String]::Equals([string]$applications[0].Program,$NodeExecutablePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-AddressValue $addresses[0].LocalAddress $LocalIPv4
    Assert-AddressValue $addresses[0].RemoteAddress $PeerIPv4
    if ([string]$ports[0].Protocol -notin @('TCP','6')) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-OneValue $ports[0].LocalPort '8443'
    Assert-OneValue $ports[0].RemotePort 'Any'
    Assert-OneValue $interfaces[0].InterfaceAlias $Alias
    Assert-OneValue $types[0].InterfaceType 'Wireless'
}
function Write-LeaseStage([string]$Stage) {
    if ($Stage -cnotin @('active','removed','failed') -or $null -eq $statusStream) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    [CarebridgeWifiLeaseNative]::CheckFile($statusStream.SafeFileHandle,$statusPath,$false)
    $bytes = [Text.Encoding]::UTF8.GetBytes('{"stage":"' + $Stage + '"}')
    $statusStream.Position = 0; $statusStream.Write($bytes,0,$bytes.Length)
    $statusStream.SetLength($bytes.Length); $statusStream.Flush($true)
}
function Get-FailureSourceLine($Record) {
    # Location only, never a path, message or error identifier. Unknown is 0.
    # Observation itself must not replace the original failure or stop cleanup.
    try {
        if ($null -eq $Record -or $null -eq $Record.InvocationInfo) { return 0 }
        $line = [int]$Record.InvocationInfo.ScriptLineNumber
        if ($line -lt 0 -or $line -gt 99999) { return 0 }
        return $line
    } catch { return 0 }
}
function Write-FailureDiagnostic {
    # Diagnostic evidence is not a cleanup receipt and never changes success.
    # Only a status handle obtained after pinning the control directory permits
    # this best-effort, exclusive sidecar creation. Never overwrite/adopt a file.
    $diagnosticStream = $null
    try {
        if (-not $failed -or $null -eq $statusStream) { return }
        [CarebridgeWifiLeaseNative]::CheckFile($statusStream.SafeFileHandle,$statusPath,$false)
        $phases = @('none','initialization','status-init','stop-check','identity','exe-pin','owner-pin','owner-check',
            'network','exception','rule-check','task-check','task-build','task-register','task-verify','overlap',
            'ready-check','rule-create','rule-verify','active-write','monitor','unknown')
        $cleanupPhases = @('none','restore','rule-query','rule-remove','task-query','task-verify','task-remove','status-write','unknown')
        $phase = if ($firstFailurePhase -cin $phases) { $firstFailurePhase } else { 'unknown' }
        $cleanup = if ($firstCleanupFailure -cin $cleanupPhases) { $firstCleanupFailure } else { 'unknown' }
        # Prefer the first main failure; cleanup is a fallback, never a rewrite.
        # A line does not identify which script failed; 0 means unknown.
        $line = if ($firstFailurePhase -cne 'none') { $firstFailureLine } else { $firstCleanupFailureLine }
        if ($line -isnot [int] -or $line -lt 0 -or $line -gt 99999) { $line = 0 }
        # Bits 1/16/32 mean verified admin/rule-cleanup/task-cleanup. Bits 2/4
        # mean task-registration/rule-creation ATTEMPTED, not successful. Bit 8
        # means exception cleanup was armed, not that a port edit succeeded.
        $flags = 0
        if ($adminVerified) { $flags = $flags -bor 1 }
        if ($taskRegistrationStarted) { $flags = $flags -bor 2 }
        if ($creationStarted) { $flags = $flags -bor 4 }
        if ($exceptionArmed) { $flags = $flags -bor 8 }
        if ($cleanupVerified) { $flags = $flags -bor 16 }
        if ($taskCleanupVerified) { $flags = $flags -bor 32 }
        $json = [ordered]@{schema=1;phase=$phase;cleanup=$cleanup;flags=$flags;line=$line} | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        if ($bytes.Length -gt 256 -or $flags -lt 0 -or $flags -gt 63) { return }
        $diagnosticPath = [IO.Path]::Combine($ControlDirectory,'failure.json')
        $diagnosticStream = [CarebridgeWifiLeaseNative]::CreateStatus($diagnosticPath)
        [CarebridgeWifiLeaseNative]::CheckFile($diagnosticStream.SafeFileHandle,$diagnosticPath,$false)
        $diagnosticStream.Write($bytes,0,$bytes.Length); $diagnosticStream.Flush($true)
    } catch { } finally {
        if ($null -ne $diagnosticStream) { try { $diagnosticStream.Dispose() } catch { } }
    }
}
function Test-StopRequested {
    # Directory-entry presence also catches a broken link without following it.
    return @([IO.Directory]::EnumerateFileSystemEntries($ControlDirectory,'stop',[IO.SearchOption]::TopDirectoryOnly)).Count -ne 0
}
function Get-ExactCleanupTask {
    return @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $taskName })
}
function Assert-MutationReady {
    $script:currentFailurePhase = 'ready-check'
    $null = Assert-NetworkBoundary $interfaceAlias
    $tasks = @(Get-ExactCleanupTask)
    if ($tasks.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-CleanupTask $tasks[0]
    # Check these AFTER slow CIM reads and while holding the operation mutex.
    if ([DateTime]::UtcNow -ge $deadline.ToUniversalTime() -or $timer.Elapsed.TotalSeconds -ge $MaxLifetimeSeconds -or
        -not [CarebridgeWifiLeaseNative]::Matches($processHandle,$ownerTicks,$NodeExecutablePath) -or (Test-StopRequested)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Enter-ExceptionOperation {
    if ($null -eq $operationMutex -or $operationLocked) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    try { $script:operationLocked = $operationMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $script:operationLocked = $true }
    if (-not $operationLocked) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Exit-ExceptionOperation {
    if ($operationLocked) { $operationMutex.ReleaseMutex(); $script:operationLocked = $false }
}
function Initialize-BlockException {
    $key = Get-CarebridgeExceptionKey $TemporaryTcpBlockRule $NodeExecutablePath
    $created = $false
    $script:lifetimeMutex = [Threading.Mutex]::new($true,('Global\Carebridge-Synthetic-WiFi-Lifetime-' + $key),[ref]$created)
    if (-not $created) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $script:lifetimeLocked = $true
    $script:operationMutex = [Threading.Mutex]::new($false,('Global\Carebridge-Synthetic-WiFi-Operation-' + $key))
    $script:taskName = 'Carebridge-Synthetic-WiFi-Exception-' + $key
    # Residual deterministic tasks reserve the original across helper crashes.
    # A new UUID is not permission to adopt an older unfinished transaction.
    if (@(Get-ExactCleanupTask).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $snapshot = Get-CarebridgeTemporaryBlockSnapshot $TemporaryTcpBlockRule $NodeExecutablePath
    $script:exceptionContext = [pscustomobject]@{
        Name = $TemporaryTcpBlockRule; Program = $NodeExecutablePath; Invariant = $snapshot.Invariant; Key = $key
        AllowName = $ruleName; Marker = $ruleMarker; LocalIPv4 = $LocalIPv4; PeerIPv4 = $PeerIPv4
        LocalGuardName = $ruleName + '-Guard-Local'; RemoteGuardName = $ruleName + '-Guard-Remote'
    }
    foreach ($name in @($exceptionContext.LocalGuardName,$exceptionContext.RemoteGuardName)) {
        foreach ($store in @('PersistentStore','ActiveStore')) {
            if (@(Get-CarebridgeExactFirewallRule $name $store).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        }
    }
}
function Enable-BlockException {
    # Caller holds the operation mutex until its exact Allow is read back.
    Assert-CarebridgeExceptionCurrent $exceptionContext 'Any'
    foreach ($dimension in @('Local','Remote')) {
        Assert-MutationReady
        $name = if ($dimension -ceq 'Local') { $exceptionContext.LocalGuardName } else { $exceptionContext.RemoteGuardName }
        $local = if ($dimension -ceq 'Local') { @(Get-CarebridgeIPv4Complement $LocalIPv4) } else { @('Any') }
        $remote = if ($dimension -ceq 'Remote') { @(Get-CarebridgeIPv4Complement $PeerIPv4) } else { @('Any') }
        $null = New-NetFirewallRule -Name $name -DisplayName $name -Description $ruleMarker `
            -PolicyStore PersistentStore -Enabled True -Profile Public -Direction Inbound -Action Block `
            -Program $NodeExecutablePath -Protocol TCP -LocalPort 8443 -RemotePort Any `
            -LocalAddress $local -RemoteAddress $remote -InterfaceAlias Any -InterfaceType Any `
            -EdgeTraversalPolicy Block -ErrorAction Stop
        Assert-CarebridgeGuard $exceptionContext $name $dimension
    }
    $script:verifiedGuardNames = @($exceptionContext.LocalGuardName,$exceptionContext.RemoteGuardName)
    Assert-NoOverlappingFirewallRule $interfaceAlias
    Assert-CarebridgeExceptionCurrent $exceptionContext 'Any'
    $original = @(Get-CarebridgeExactFirewallRule $TemporaryTcpBlockRule 'PersistentStore')
    if ($original.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $ports = @($original[0] | Get-NetFirewallPortFilter -ErrorAction Stop)
    if ($ports.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-MutationReady
    # Microsoft NetSecurity accepts port zero. All ports except 8443 remain blocked.
    $null = $ports[0] | Set-NetFirewallPortFilter -LocalPort @('0-8442','8444-65535') -ErrorAction Stop
    Assert-CarebridgeExceptionCurrent $exceptionContext '0-8442,8444-65535'
    Assert-CarebridgeGuard $exceptionContext $exceptionContext.LocalGuardName 'Local'
    Assert-CarebridgeGuard $exceptionContext $exceptionContext.RemoteGuardName 'Remote'
}
function Assert-CleanupTask($Task) {
    if ($Task.TaskName -cne $taskName -or $Task.TaskPath -cne '\' -or $Task.Description -cne $ruleMarker -or
        @($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -cne $taskExecutable -or
        $Task.Actions[0].Arguments -cne $taskArguments -or [string]$Task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or
        [string]$Task.Principal.RunLevel -ne 'Highest' -or [string]$Task.Principal.LogonType -ne 'ServiceAccount' -or
        @($Task.Triggers).Count -ne 2 -or -not $Task.Settings.StartWhenAvailable -or -not $Task.Settings.Enabled -or
        $Task.Settings.DisallowStartIfOnBatteries -or $Task.Settings.StopIfGoingOnBatteries -or
        [string]$Task.Settings.ExecutionTimeLimit -ne 'PT5M' -or [string]$Task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $once = @($Task.Triggers | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskTimeTrigger' })
    $startup = @($Task.Triggers | Where-Object { $_.CimClass.CimClassName -ceq 'MSFT_TaskBootTrigger' })
    if ($once.Count -ne 1 -or $startup.Count -ne 1 -or -not $once[0].Enabled -or -not $startup[0].Enabled -or
        [Math]::Abs(([DateTime]::Parse($once[0].StartBoundary) - $deadline).TotalSeconds) -gt 2 -or
        [string]$once[0].Repetition.Interval -ne 'PT1M' -or [string]$once[0].Repetition.Duration -ne '' -or
        $once[0].Repetition.StopAtDurationEnd -or [string]$once[0].EndBoundary -ne '') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function New-CleanupTimeTrigger([DateTime]$Deadline) {
    $onceTrigger = New-ScheduledTaskTrigger -Once -At $Deadline -RepetitionInterval ([TimeSpan]::FromMinutes(1)) -ErrorAction Stop
    # The CIM factory defaults this flag to true, even without a duration.
    # Explicitly match our indefinite-retry policy before registration; retain
    # the strict readback check instead of accepting an unintended task shape.
    $onceTrigger.Repetition.StopAtDurationEnd = $false
    return $onceTrigger
}
function Register-CleanupTask([DateTime]$Deadline) {
    $script:currentFailurePhase = 'task-check'
    if (@(Get-ExactCleanupTask).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $script:currentFailurePhase = 'task-build'
    # The action is fixed code with only validated UUID-derived identifiers.
    # It never executes this script or reads the user-writable control folder.
    $command = @'
$ErrorActionPreference='Stop'; try {
$name='__RULE__'; $marker='__MARKER__';
$rules=@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -ceq $name });
if($rules.Count -gt 1 -or ($rules.Count -eq 1 -and $rules[0].Description -cne $marker)){throw 'cleanup refused'};
if($rules.Count -eq 1){$rules[0] | Remove-NetFirewallRule -ErrorAction Stop};
foreach($store in @('PersistentStore','ActiveStore')){if(@(Get-NetFirewallRule -PolicyStore $store -ErrorAction Stop | Where-Object { $_.Name -ceq $name }).Count -ne 0){throw 'cleanup incomplete'}};
Unregister-ScheduledTask -TaskName '__TASK__' -TaskPath '\' -Confirm:$false -ErrorAction Stop;
exit 0
} catch {exit 1}
'@
    $command = $command.Replace('__RULE__',$ruleName).Replace('__MARKER__',$ruleMarker).Replace('__TASK__',$taskName).Replace("`r",'').Replace("`n",' ')
    if ($null -ne $exceptionContext) { $command = Get-CarebridgeExceptionCleanupCommand $exceptionContext $taskName }
    $script:taskExecutable = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System),'WindowsPowerShell\v1.0\powershell.exe')
    $script:taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    if ($taskArguments.Length -gt 30000) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $action = New-ScheduledTaskAction -Execute $taskExecutable -Argument $taskArguments -ErrorAction Stop
    # Infinite repetition retries failed restoration without depending on a
    # finite restart count. It is removed only after restoration is verified.
    $triggers = @((New-CleanupTimeTrigger $Deadline), (New-ScheduledTaskTrigger -AtStartup -ErrorAction Stop))
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5)) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -ErrorAction Stop
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest -ErrorAction Stop
    $script:taskRegistrationStarted = $true
    $script:currentFailurePhase = 'task-register'
    $null = Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Description $ruleMarker -Action $action `
        -Trigger $triggers -Settings $settings -Principal $principal -ErrorAction Stop
    $script:currentFailurePhase = 'task-verify'
    $tasks = @(Get-ExactCleanupTask)
    if ($tasks.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-CleanupTask $tasks[0]
}

try {
    # CmdletBinding rejects unbound arguments before the body runs. Under
    # direct -File entry, $args is not defined; StrictMode would reject a valid
    # launch here. Do not rely on a calling script's inherited automatic vars.
    . (Join-Path $PSScriptRoot 'synthetic-wifi-firewall-policy.ps1')
    . (Join-Path $PSScriptRoot 'synthetic-wifi-firewall-exception.ps1')
    Assert-CanonicalLocalPath $ControlDirectory
    Assert-CanonicalLocalPath $NodeExecutablePath
    if ([IO.Path]::GetFileName($NodeExecutablePath) -cne 'node.exe') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $folder = [IO.Path]::GetFileName($ControlDirectory)
    if ($folder -cnotmatch '^carebridge-synthetic-wifi-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $leaseId = $Matches[1]
    $ruleName = 'Carebridge-Synthetic-WiFi-' + $leaseId
    $ruleMarker = 'Carebridge temporary synthetic-only Wi-Fi lease ' + $leaseId
    $taskName = 'Carebridge-Synthetic-WiFi-Cleanup-' + $leaseId
    Assert-PrivateIPv4 $LocalIPv4; Assert-PrivateIPv4 $PeerIPv4
    if ($LocalIPv4 -ceq $PeerIPv4) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Pin-DirectoryChain $ControlDirectory
    $existingEntries = @([IO.Directory]::EnumerateFileSystemEntries($ControlDirectory))
    if ($existingEntries.Count -gt 1 -or ($existingEntries.Count -eq 1 -and [IO.Path]::GetFileName($existingEntries[0]) -cne 'stop')) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $statusPath = [IO.Path]::Combine($ControlDirectory,'status.json')
    $stopPath = [IO.Path]::Combine($ControlDirectory,'stop')
    $currentFailurePhase = 'status-init'
    $statusStream = [CarebridgeWifiLeaseNative]::CreateStatus($statusPath)
    # A caller may time out while UAC is still visible. A later approval must
    # observe that cancellation before creating any task or firewall rule.
    $currentFailurePhase = 'stop-check'
    if (Test-StopRequested) { $cleanupVerified = $true; $taskCleanupVerified = $true; return }
    $currentFailurePhase = 'identity'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        $adminVerified = $true
    } finally { $identity.Dispose() }
    $currentFailurePhase = 'exe-pin'
    Pin-DirectoryChain ([IO.Path]::GetDirectoryName($NodeExecutablePath))
    $pathHandles.Add([CarebridgeWifiLeaseNative]::PinPath($NodeExecutablePath,$false))
    $currentFailurePhase = 'owner-pin'
    $ownerTicks = [long]::Parse($OwnerStartTimeUtcTicks,[Globalization.CultureInfo]::InvariantCulture)
    $processHandle = [CarebridgeWifiLeaseNative]::PinProcess($OwnerPid,$ownerTicks,$NodeExecutablePath)
    $currentFailurePhase = 'network'
    $interfaceAlias = Assert-NetworkBoundary
    $currentFailurePhase = 'exception'
    if ($TemporaryTcpBlockRule -ne '') { Initialize-BlockException }
    $currentFailurePhase = 'rule-check'
    if (@(Get-ExactRule 'PersistentStore').Count -ne 0 -or @(Get-ExactRule 'ActiveStore').Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $currentFailurePhase = 'owner-check'
    if (-not [CarebridgeWifiLeaseNative]::Matches($processHandle,$ownerTicks,$NodeExecutablePath)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    if (Test-StopRequested) { $cleanupVerified = $true; return }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $deadline = [DateTime]::Now.AddSeconds($MaxLifetimeSeconds)
    Register-CleanupTask $deadline
    if ($null -ne $exceptionContext) { $exceptionArmed = $true }
    $currentFailurePhase = 'owner-check'
    if ($timer.Elapsed.TotalSeconds -ge ($MaxLifetimeSeconds - 10) -or
        -not [CarebridgeWifiLeaseNative]::Matches($processHandle,$ownerTicks,$NodeExecutablePath)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    if (Test-StopRequested) { $cleanupVerified = $true; return }
    # Recheck after UAC and immediately before creating a rule. The initial
    # non-elevated snapshot cannot authorize a changed machine-wide policy.
    $currentFailurePhase = 'overlap'
    Assert-NoOverlappingFirewallRule $interfaceAlias
    # CIM reads may take time. Revalidate liveness, cancellation and the lease
    # deadline after they return, before allowing any new inbound traffic.
    $currentFailurePhase = 'owner-check'
    if ($timer.Elapsed.TotalSeconds -ge $MaxLifetimeSeconds -or
        -not [CarebridgeWifiLeaseNative]::Matches($processHandle,$ownerTicks,$NodeExecutablePath)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    if (Test-StopRequested) { $cleanupVerified = $true; return }
    if ($null -ne $exceptionContext) {
        Enter-ExceptionOperation
        Enable-BlockException
    }
    Assert-MutationReady
    $currentFailurePhase = 'rule-create'
    $creationStarted = $true
    $null = New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Description $ruleMarker `
        -PolicyStore PersistentStore -Enabled True -Profile Public -Direction Inbound -Action Allow `
        -Program $NodeExecutablePath -Protocol TCP -LocalPort 8443 -RemotePort Any `
        -LocalAddress $LocalIPv4 -RemoteAddress $PeerIPv4 -InterfaceAlias $interfaceAlias `
        -InterfaceType Wireless -EdgeTraversalPolicy Block -ErrorAction Stop
    $currentFailurePhase = 'rule-verify'
    $rules = @(Get-ExactRule 'PersistentStore')
    $activeRules = @(Get-ExactRule 'ActiveStore')
    if ($rules.Count -ne 1 -or $activeRules.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    Assert-RuleBoundary $rules[0] $interfaceAlias
    Assert-RuleBoundary $activeRules[0] $interfaceAlias
    if ($null -ne $exceptionContext) { Exit-ExceptionOperation }
    $currentFailurePhase = 'overlap'
    Assert-NoOverlappingFirewallRule $interfaceAlias
    Assert-MutationReady
    $currentFailurePhase = 'active-write'
    Write-LeaseStage 'active'
    $currentFailurePhase = 'monitor'
    $nextBoundaryCheck = 0.0
    while ($timer.Elapsed.TotalSeconds -lt $MaxLifetimeSeconds -and [DateTime]::UtcNow -lt $deadline.ToUniversalTime()) {
        if ([CarebridgeWifiLeaseNative]::WaitExited($processHandle,500)) { break }
        # Only presence is observed. No stop-file contents, targets, or credentials are read.
        if (Test-StopRequested) { break }
        if (-not [CarebridgeWifiLeaseNative]::Matches($processHandle,$ownerTicks,$NodeExecutablePath)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        if ($timer.Elapsed.TotalSeconds -ge $nextBoundaryCheck) {
            $null = Assert-NetworkBoundary $interfaceAlias
            foreach ($store in @('PersistentStore','ActiveStore')) {
                $current = @(Get-ExactRule $store)
                if ($current.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
                Assert-RuleBoundary $current[0] $interfaceAlias
            }
            if ($null -ne $exceptionContext) {
                Assert-CarebridgeExceptionCurrent $exceptionContext '0-8442,8444-65535'
                Assert-CarebridgeGuard $exceptionContext $exceptionContext.LocalGuardName 'Local'
                Assert-CarebridgeGuard $exceptionContext $exceptionContext.RemoteGuardName 'Remote'
            }
            Assert-NoOverlappingFirewallRule $interfaceAlias
            $tasks = @(Get-ExactCleanupTask)
            if ($tasks.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            Assert-CleanupTask $tasks[0]
            $nextBoundaryCheck = $timer.Elapsed.TotalSeconds + 5.0
        }
    }
} catch {
    $failed = $true
    $failureRecord = $_
    if ($firstFailurePhase -ceq 'none') {
        $firstFailurePhase = $currentFailurePhase
        $firstFailureLine = Get-FailureSourceLine $failureRecord
    }
} finally {
    if ($exceptionArmed) {
        try {
            $cleanupObservationPhase = 'restore'
            if (-not $operationLocked) { Enter-ExceptionOperation }
            Invoke-CarebridgeExceptionCleanup $exceptionContext
            $cleanupVerified = $true
        } catch {
            $cleanupRecord = $_
            $failed = $true; $cleanupVerified = $false
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = $cleanupObservationPhase
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
            # A mutex/provider/restoration failure must still attempt to close
            # our unique Allow; guard rules and cleanup task remain for recovery.
            try { Remove-CarebridgeOwnedRule $ruleName $ruleMarker } catch { }
        }
    } elseif ($creationStarted) {
        try {
            $cleanupObservationPhase = 'rule-query'
            $owned = @(Get-ExactRule 'PersistentStore')
            if ($owned.Count -gt 1 -or ($owned.Count -eq 1 -and $owned[0].Description -cne $ruleMarker)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            if ($owned.Count -eq 1) {
                # The exact unique rule created by this invocation only; no wildcard/name-prefix deletion.
                $cleanupObservationPhase = 'rule-remove'
                $owned[0] | Remove-NetFirewallRule -ErrorAction Stop
            }
            $cleanupObservationPhase = 'rule-query'
            if (@(Get-ExactRule 'PersistentStore').Count -ne 0 -or @(Get-ExactRule 'ActiveStore').Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            $cleanupVerified = $true
        } catch {
            $cleanupRecord = $_; $failed = $true
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = $cleanupObservationPhase
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
        }
    } elseif ($adminVerified) {
        try {
            $cleanupObservationPhase = 'rule-query'
            if (@(Get-ExactRule 'PersistentStore').Count -ne 0 -or @(Get-ExactRule 'ActiveStore').Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            $cleanupVerified = $true
        } catch {
            $cleanupRecord = $_; $failed = $true; $cleanupVerified = $false
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = $cleanupObservationPhase
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
        }
    }
    if ($taskRegistrationStarted -and $cleanupVerified) {
        try {
            $cleanupObservationPhase = 'task-query'
            $tasks = @(Get-ExactCleanupTask)
            if ($tasks.Count -gt 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            if ($tasks.Count -eq 1) {
                $cleanupObservationPhase = 'task-verify'
                Assert-CleanupTask $tasks[0]
                $cleanupObservationPhase = 'task-remove'
                Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
            }
            $cleanupObservationPhase = 'task-query'
            if (@(Get-ExactCleanupTask).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            $taskCleanupVerified = $true
        } catch {
            $cleanupRecord = $_; $failed = $true
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = $cleanupObservationPhase
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
        }
    } elseif (-not $taskRegistrationStarted -and $adminVerified) {
        try {
            $cleanupObservationPhase = 'task-query'
            if (@(Get-ExactCleanupTask).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            $taskCleanupVerified = $true
        } catch {
            $cleanupRecord = $_; $failed = $true; $taskCleanupVerified = $false
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = $cleanupObservationPhase
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
        }
    }
    if ($null -ne $statusStream) {
        try {
            # Execution may fail while cleanup succeeds; keep exit 1 but retain
            # the independently verified absence receipt for safe parent close.
            if ($cleanupVerified -and $taskCleanupVerified) { Write-LeaseStage 'removed' }
            else { Write-LeaseStage 'failed' }
        } catch {
            $cleanupRecord = $_; $failed = $true
            if ($firstCleanupFailure -ceq 'none') {
                $firstCleanupFailure = 'status-write'
                $firstCleanupFailureLine = Get-FailureSourceLine $cleanupRecord
            }
        }
        Write-FailureDiagnostic
        $statusStream.Dispose()
    }
    if ($null -ne $processHandle) { $processHandle.Dispose() }
    if ($operationLocked) { Exit-ExceptionOperation }
    if ($null -ne $operationMutex) { $operationMutex.Dispose() }
    if ($lifetimeLocked) { $lifetimeMutex.ReleaseMutex() }
    if ($null -ne $lifetimeMutex) { $lifetimeMutex.Dispose() }
    for ($i = $pathHandles.Count - 1; $i -ge 0; $i--) { $pathHandles[$i].Dispose() }
}
if ($failed) { [Console]::Error.Write('SYNTHETIC_WIFI_LEASE_UNAVAILABLE'); exit 1 }
exit 0
