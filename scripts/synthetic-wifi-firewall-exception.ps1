# Narrow, explicitly approved exception to one existing TCP/Public block.
# Dot-sourcing only defines functions. All mutations require the elevated lease.
function Get-CarebridgeExceptionKey([string]$Name,[string]$Program) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Name.ToUpperInvariant() + '|' + $Program.ToUpperInvariant() + '|Public|8443')))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Get-CarebridgeIPv4Complement([string]$Address) {
    $bytes = ([Net.IPAddress]::Parse($Address)).GetAddressBytes()
    if ($bytes.Length -ne 4) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $number = (([uint64]$bytes[0] -shl 24) -bor ([uint64]$bytes[1] -shl 16) -bor ([uint64]$bytes[2] -shl 8) -bor [uint64]$bytes[3])
    if ($number -le 0 -or $number -ge 4294967295) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $before = $number - 1; $after = $number + 1
    $beforeText = ((24,16,8,0 | ForEach-Object { [string](($before -shr $_) -band 255) }) -join '.')
    $afterText = ((24,16,8,0 | ForEach-Object { [string](($after -shr $_) -band 255) }) -join '.')
    return @(('0.0.0.0-' + $beforeText), ($afterText + '-255.255.255.255'), '::/0')
}
function Assert-CarebridgeExceptionCurrent($Context,[string]$ExpectedPort = '') {
    foreach ($store in @('PersistentStore','ActiveStore')) {
        $rules = @(Get-CarebridgeExactFirewallRule $Context.Name $store)
        if ($rules.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        $current = Get-CarebridgeFirewallSnapshot $rules[0]
        $ports = $current.LocalPort -join ','
        if ($current.Invariant -cne $Context.Invariant -or $ports -cnotin @('Any','0-8442,8444-65535') -or
            ($ExpectedPort -ne '' -and $ports -cne $ExpectedPort)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    }
}
function Restore-CarebridgeException($Context) {
    # Never restore an entire snapshot: only our LocalPort postimage may change.
    # A deleted or externally edited original is not recreated or overwritten.
    Assert-CarebridgeExceptionCurrent $Context
    $original = @(Get-CarebridgeExactFirewallRule $Context.Name 'PersistentStore')
    if ($original.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $snapshot = Get-CarebridgeFirewallSnapshot $original[0]
    if ($snapshot.Invariant -cne $Context.Invariant) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    if (($snapshot.LocalPort -join ',') -cne 'Any') {
        $port = @($original[0] | Get-NetFirewallPortFilter -ErrorAction Stop)
        if ($port.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        $null = $port[0] | Set-NetFirewallPortFilter -LocalPort Any -ErrorAction Stop
    }
    Assert-CarebridgeExceptionCurrent $Context 'Any'
}
function Assert-CarebridgeGuard($Context,[string]$Name,[string]$Dimension) {
    $complement = if ($Dimension -ceq 'Local') { @(Get-CarebridgeIPv4Complement $Context.LocalIPv4) } else { @(Get-CarebridgeIPv4Complement $Context.PeerIPv4) }
    foreach ($store in @('PersistentStore','ActiveStore')) {
        $rules = @(Get-CarebridgeExactFirewallRule $Name $store)
        if ($rules.Count -ne 1) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        $snapshot = Get-CarebridgeFirewallSnapshot $rules[0]
        $data = $snapshot.Invariant | ConvertFrom-Json
        foreach ($section in @($data.Rule,$data.Application,$data.Address)) {
            foreach ($field in @('PolicyAppId','RemoteDynamicKeywordAddresses')) {
                if ($section.PSObject.Properties[$field] -and @($section.$field).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
            }
        }
        if ($data.Rule.Name[0] -cne $Name -or $data.Rule.Description[0] -cne $Context.Marker -or
            $data.Rule.Enabled[0] -ne 'True' -or $data.Rule.Profile[0] -ne 'Public' -or $data.Rule.Direction[0] -ne 'Inbound' -or
            $data.Rule.Action[0] -ne 'Block' -or $data.Rule.EdgeTraversalPolicy[0] -ne 'Block' -or
            $data.Rule.PolicyStoreSourceType[0] -ne 'Local' -or $data.Rule.PolicyStoreSource[0] -ne 'PersistentStore' -or
            @($data.Rule.Owner).Count -ne 0 -or @($data.Rule.PackageFamilyName).Count -ne 0 -or @($data.Rule.Platform).Count -ne 0 -or
            $data.Rule.LooseSourceMapping[0] -ne 'False' -or $data.Rule.LocalOnlyMapping[0] -ne 'False' -or
            @($data.Application.Program).Count -ne 1 -or -not [String]::Equals($data.Application.Program[0],$Context.Program,[StringComparison]::OrdinalIgnoreCase) -or
            @($data.Application.Package).Count -ne 0 -or ($snapshot.LocalPort -join ',') -cne '8443' -or
            $data.Port.Protocol[0] -notin @('TCP','6') -or $data.Port.DynamicTarget[0] -notin @('Any','0') -or
            $data.Security.Authentication[0] -notin @('NotRequired','0') -or $data.Security.Encryption[0] -notin @('NotRequired','0') -or
            $data.Security.OverrideBlockRules[0] -ne 'False') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        foreach ($field in @($data.Port.RemotePort,$data.Port.IcmpType,$data.Interface.InterfaceAlias,$data.InterfaceType.InterfaceType,
            $data.Service.Service,$data.Security.LocalUser,$data.Security.RemoteUser,$data.Security.RemoteMachine)) {
            if (@($field).Count -ne 1 -or $field[0] -cne 'Any') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
        }
        $actual = @(if ($Dimension -ceq 'Local') { $data.Address.LocalAddress } else { $data.Address.RemoteAddress })
        $other = @(if ($Dimension -ceq 'Local') { $data.Address.RemoteAddress } else { $data.Address.LocalAddress })
        if (($actual -join ',') -cne (($complement | Sort-Object -CaseSensitive) -join ',') -or
            $other.Count -ne 1 -or $other[0] -cne 'Any') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    }
}
function Remove-CarebridgeOwnedRule([string]$Name,[string]$Marker) {
    $owned = @(Get-CarebridgeExactFirewallRule $Name 'PersistentStore')
    if ($owned.Count -gt 1 -or ($owned.Count -eq 1 -and $owned[0].Description -cne $Marker)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    if ($owned.Count -eq 1) { $owned[0] | Remove-NetFirewallRule -ErrorAction Stop }
    foreach ($store in @('PersistentStore','ActiveStore')) {
        if (@(Get-CarebridgeExactFirewallRule $Name $store).Count -ne 0) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    }
}
function Invoke-CarebridgeExceptionCleanup($Context) {
    $restored = $false; $allowRemoved = $false; $guardsRemoved = $false
    try { Restore-CarebridgeException $Context; $restored = $true } catch { }
    # Even a tampered/missing original must not strand this lease's Allow.
    try { Remove-CarebridgeOwnedRule $Context.AllowName $Context.Marker; $allowRemoved = $true } catch { }
    if ($restored) {
        try {
            Assert-CarebridgeExceptionCurrent $Context 'Any'
            Remove-CarebridgeOwnedRule $Context.LocalGuardName $Context.Marker
            Assert-CarebridgeExceptionCurrent $Context 'Any'
            Remove-CarebridgeOwnedRule $Context.RemoteGuardName $Context.Marker
            Assert-CarebridgeExceptionCurrent $Context 'Any'
            $guardsRemoved = $true
        } catch { }
    }
    if (-not ($restored -and $allowRemoved -and $guardsRemoved)) { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
}
function Get-CarebridgeExceptionCleanupCommand($Context,[string]$TaskName) {
    # Embed trusted, fixed function definitions at registration, never load a
    # user-writable script/snapshot when SYSTEM runs later. Context is JSON data,
    # transported as Base64, never interpolated as executable PowerShell.
    $definitions = foreach ($functionName in @('Get-CarebridgeExactFirewallRule','Get-CarebridgeFirewallFields','Get-CarebridgeFirewallSnapshot',
        'Assert-CarebridgeExceptionCurrent','Restore-CarebridgeException','Remove-CarebridgeOwnedRule','Invoke-CarebridgeExceptionCleanup')) {
        'function ' + $functionName + ' {' + (Get-Command $functionName -CommandType Function -ErrorAction Stop).ScriptBlock.ToString() + '}'
    }
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Context | ConvertTo-Json -Depth 8 -Compress)))
    if ($payload.Length -gt 16000 -or $TaskName -cnotmatch '^Carebridge-Synthetic-WiFi-Exception-[a-f0-9]{64}$') { throw 'SYNTHETIC_WIFI_LEASE_UNAVAILABLE' }
    $action = @'
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
$mutex=$null; $locked=$false;
try {
$context=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__DATA__')) | ConvertFrom-Json;
$mutex=[Threading.Mutex]::new($false,'Global\Carebridge-Synthetic-WiFi-Operation-'+$context.Key);
try {$locked=$mutex.WaitOne(30000)} catch [Threading.AbandonedMutexException] {$locked=$true};
if(-not $locked){throw 'cleanup unavailable'};
$tasks=@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object {$_.TaskName -ceq '__TASK__'});
if($tasks.Count -ne 1 -or $tasks[0].Description -cne $context.Marker){throw 'cleanup ownership changed'};
Invoke-CarebridgeExceptionCleanup $context;
Unregister-ScheduledTask -TaskName '__TASK__' -TaskPath '\' -Confirm:$false -ErrorAction Stop;
if(@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object {$_.TaskName -ceq '__TASK__'}).Count -ne 0){throw 'cleanup incomplete'};
exit 0
} catch {exit 1} finally {if($locked){$mutex.ReleaseMutex()}; if($null -ne $mutex){$mutex.Dispose()}}
'@
    return ($definitions -join "`n") + "`n" + $action.Replace('__DATA__',$payload).Replace('__TASK__',$TaskName)
}
