# Shared read-only overlap policy for non-elevated preflight and elevated lease.
# No rule mutation, category changes, or code/paths from rule data are executed.
# Application/service tables are joined by InstanceID first. Only matching
# candidates use associated port/address/interface reads: unprivileged Windows
# denies a bulk ActiveStore port-table read, but permits these scoped reads.
function Get-CarebridgeAddressNumber([string]$Value) {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Value,[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $null }
    $b = $ip.GetAddressBytes()
    return (([uint64]$b[0] -shl 24) -bor ([uint64]$b[1] -shl 16) -bor ([uint64]$b[2] -shl 8) -bor [uint64]$b[3])
}
function Get-CarebridgeAddressMatch($Values,[string]$Target) {
    $number = Get-CarebridgeAddressNumber $Target
    $uncertain = $false
    if (@($Values).Count -eq 0) { return -1 }
    foreach ($value in @($Values)) {
        $text = [string]$value
        if ($text -in @('Any','LocalSubnet','LocalSubnet4')) { return 1 }
        if ($text.Contains(':')) { continue }
        if ($text -match '^([0-9.]+)/([0-9]{1,2})$') {
            $base = Get-CarebridgeAddressNumber $Matches[1]; $prefix = [int]$Matches[2]
            if ($null -eq $base -or $prefix -gt 32) { $uncertain = $true; continue }
            $mask = if ($prefix -eq 0) { [uint64]0 } else { ([uint64]4294967295 -shl (32 - $prefix)) -band [uint64]4294967295 }
            if (($base -band $mask) -eq ($number -band $mask)) { return 1 }; continue
        }
        if ($text -match '^([0-9.]+)-([0-9.]+)$') {
            $first = Get-CarebridgeAddressNumber $Matches[1]; $last = Get-CarebridgeAddressNumber $Matches[2]
            if ($null -eq $first -or $null -eq $last -or $first -gt $last) { $uncertain = $true; continue }
            if ($number -ge $first -and $number -le $last) { return 1 }; continue
        }
        $single = Get-CarebridgeAddressNumber $text
        if ($null -eq $single) { $uncertain = $true } elseif ($single -eq $number) { return 1 }
    }
    if ($uncertain) { return -1 }; return 0
}
function Get-CarebridgePortMatch($Values) {
    $uncertain = $false
    if (@($Values).Count -eq 0) { return -1 }
    foreach ($value in @($Values)) {
        $text = [string]$value
        if ($text -eq 'Any') { return 1 }
        if ($text -match '^[0-9]{1,5}$') {
            if ([int]$text -gt 65535) { $uncertain = $true; continue }
            if ([int]$text -eq 8443) { return 1 }; continue
        }
        if ($text -match '^([0-9]{1,5})-([0-9]{1,5})$') {
            $first = [int]$Matches[1]; $last = [int]$Matches[2]
            if ($first -gt $last -or $last -gt 65535) { $uncertain = $true; continue }
            if ($first -le 8443 -and $last -ge 8443) { return 1 }; continue
        }
        $uncertain = $true
    }
    if ($uncertain) { return -1 }; return 0
}
function Get-CarebridgeFilterIndex($Filters) {
    $index = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($filter in @($Filters)) {
        $id = [string]$filter.InstanceID
        if ([string]::IsNullOrWhiteSpace($id) -or $index.ContainsKey($id)) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $index.Add($id,$filter)
    }
    return ,$index
}
function Get-CarebridgeExactFirewallRule([string]$Name,[string]$Store) {
    return @(Get-NetFirewallRule -PolicyStore $Store -ErrorAction Stop | Where-Object { $_.Name -ceq $Name })
}
function Get-CarebridgeFirewallFields($Object,[string[]]$Fields) {
    $result = [ordered]@{}
    foreach ($field in $Fields) {
        if (-not $Object.PSObject.Properties[$field]) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $result[$field] = @($Object.$field | Where-Object { $null -ne $_ -and [string]$_ -ne '' } | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    }
    return $result
}
function Get-CarebridgeFirewallSnapshot($Rule) {
    # Capture every configurable field on the seven associated filter types.
    # Runtime health/status/CIM transport properties are deliberately not policy.
    $result = [ordered]@{
        Rule = Get-CarebridgeFirewallFields $Rule @('InstanceID','Name','DisplayName','Description','Group','Enabled','Profile','Platform','Direction','Action','EdgeTraversalPolicy','LooseSourceMapping','LocalOnlyMapping','Owner','PackageFamilyName','PolicyStoreSource','PolicyStoreSourceType')
    }
    foreach ($field in @('PolicyAppId','RemoteDynamicKeywordAddresses')) {
        if ($Rule.PSObject.Properties[$field]) { $result.Rule[$field] = (Get-CarebridgeFirewallFields $Rule @($field))[$field] }
    }
    foreach ($entry in @(
        @('Application','Get-NetFirewallApplicationFilter',@('Program','Package')),
        @('Address','Get-NetFirewallAddressFilter',@('LocalAddress','RemoteAddress')),
        @('Port','Get-NetFirewallPortFilter',@('Protocol','RemotePort','IcmpType','DynamicTarget')),
        @('Interface','Get-NetFirewallInterfaceFilter',@('InterfaceAlias')),
        @('InterfaceType','Get-NetFirewallInterfaceTypeFilter',@('InterfaceType')),
        @('Service','Get-NetFirewallServiceFilter',@('Service')),
        @('Security','Get-NetFirewallSecurityFilter',@('Authentication','Encryption','OverrideBlockRules','LocalUser','RemoteUser','RemoteMachine'))
    )) {
        $filters = @($Rule | & $entry[1] -ErrorAction Stop)
        if ($filters.Count -ne 1) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $result[$entry[0]] = Get-CarebridgeFirewallFields $filters[0] $entry[2]
        foreach ($field in @('PolicyAppId','RemoteDynamicKeywordAddresses')) {
            if ($filters[0].PSObject.Properties[$field]) { $result[$entry[0]][$field] = (Get-CarebridgeFirewallFields $filters[0] @($field))[$field] }
        }
        if ($entry[0] -eq 'Port') { $ports = @($filters[0].LocalPort | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive) }
    }
    return [pscustomobject]@{ Invariant = ($result | ConvertTo-Json -Depth 8 -Compress); LocalPort = $ports }
}
function Get-CarebridgeTemporaryBlockSnapshot([string]$Name,[string]$Program,[switch]$AllowAdjusted) {
    # Only the explicitly approved Windows-generated, full-path TCP block can
    # qualify. Never treat an arbitrary rule name as an overlap exemption.
    if ($Name -cnotmatch '^TCP Query User\{[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}\}([A-Za-z]:\\[^\x00-\x1f]+\\node\.exe)$' -or
        -not [String]::Equals($Matches[1],$Program,[StringComparison]::OrdinalIgnoreCase) -or
        $Program -match '[%~*?<>"|/\x00-\x1f]' -or $Program.Substring(2).Contains(':') -or
        -not [String]::Equals([IO.Path]::GetFullPath($Program),$Program,[StringComparison]::OrdinalIgnoreCase)) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
    $baseline = $null
    foreach ($store in @('PersistentStore','ActiveStore')) {
        $rules = @(Get-CarebridgeExactFirewallRule $Name $store)
        if ($rules.Count -ne 1) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $rule = $rules[0]
        if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Profile -ne 'Public' -or
            [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Block' -or
            [string]$rule.PolicyStoreSourceType -ne 'Local' -or [string]$rule.PolicyStoreSource -ne 'PersistentStore' -or
            $rule.Owner -or $rule.PackageFamilyName -or @($rule.Platform).Count -ne 0 -or
            $rule.LooseSourceMapping -or $rule.LocalOnlyMapping) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $snapshot = Get-CarebridgeFirewallSnapshot $rule
        $data = $snapshot.Invariant | ConvertFrom-Json
        foreach ($section in @($data.Rule,$data.Application,$data.Address)) {
            foreach ($field in @('PolicyAppId','RemoteDynamicKeywordAddresses')) {
                if ($section.PSObject.Properties[$field] -and @($section.$field).Count -ne 0) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
            }
        }
        foreach ($field in @($data.Address.LocalAddress,$data.Address.RemoteAddress,$data.Port.RemotePort,$data.Port.IcmpType,
            $data.Interface.InterfaceAlias,$data.InterfaceType.InterfaceType,$data.Service.Service,
            $data.Security.LocalUser,$data.Security.RemoteUser,$data.Security.RemoteMachine)) {
            if (@($field).Count -ne 1 -or [string]$field[0] -ne 'Any') { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        }
        if (@($data.Application.Program).Count -ne 1 -or -not [String]::Equals($data.Application.Program[0],$Program,[StringComparison]::OrdinalIgnoreCase) -or
            @($data.Application.Package).Count -ne 0 -or $data.Port.Protocol[0] -notin @('TCP','6') -or
            $data.Port.DynamicTarget[0] -notin @('Any','0') -or $data.Security.Authentication[0] -notin @('NotRequired','0') -or
            $data.Security.Encryption[0] -notin @('NotRequired','0') -or $data.Security.OverrideBlockRules[0] -ne 'False') { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $portText = $snapshot.LocalPort -join ','
        if ($portText -cne 'Any' -and (-not $AllowAdjusted -or $portText -cne '0-8442,8444-65535')) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        if ($null -ne $baseline -and ($baseline.Invariant -cne $snapshot.Invariant -or ($baseline.LocalPort -join ',') -cne $portText)) { throw 'SYNTHETIC_WIFI_FIREWALL_UNCERTAIN' }
        $baseline = $snapshot
    }
    return $baseline
}
function Get-CarebridgeSyntheticFirewallConflict {
    param([string]$NodeExecutablePath,[string]$LocalIPv4,[string]$PeerIPv4,[string]$InterfaceAlias,[string]$ExcludeRuleName = '',
        [string]$TemporaryTcpBlockRule = '',[string[]]$VerifiedGuardNames = @(),[switch]$AllowAdjustedTemporaryBlock)
    try {
        if ($ExcludeRuleName -ne '' -and $ExcludeRuleName -cnotmatch '^Carebridge-Synthetic-WiFi-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { return 'firewall-uncertain' }
        if ($VerifiedGuardNames.Count -gt 0 -and ($TemporaryTcpBlockRule -eq '' -or $ExcludeRuleName -eq '' -or $VerifiedGuardNames.Count -ne 2 -or
            $VerifiedGuardNames[0] -cne ($ExcludeRuleName + '-Guard-Local') -or $VerifiedGuardNames[1] -cne ($ExcludeRuleName + '-Guard-Remote'))) { return 'firewall-uncertain' }
        if ($AllowAdjustedTemporaryBlock -and $VerifiedGuardNames.Count -ne 2) { return 'firewall-uncertain' }
        if ($TemporaryTcpBlockRule -ne '') { $null = Get-CarebridgeTemporaryBlockSnapshot $TemporaryTcpBlockRule $NodeExecutablePath -AllowAdjusted:$AllowAdjustedTemporaryBlock }
        $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -ErrorAction Stop)
        $applications = Get-CarebridgeFilterIndex @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction Stop)
        $services = Get-CarebridgeFilterIndex @(Get-NetFirewallServiceFilter -PolicyStore ActiveStore -ErrorAction Stop)
        foreach ($rule in $rules) {
            if ($ExcludeRuleName -ne '' -and $rule.Name -ceq $ExcludeRuleName) { continue }
            if ($TemporaryTcpBlockRule -ne '' -and ($rule.Name -ceq $TemporaryTcpBlockRule -or $rule.Name -cin $VerifiedGuardNames)) { continue }
            if ([string]$rule.Profile -ne 'Any' -and [string]$rule.Profile -notmatch '(^|,\s*)Public($|,)') { continue }
            # Modern packaged-app rules can carry the restriction on the rule
            # itself even when ApplicationFilter.Package is empty.
            if ($rule.PSObject.Properties['PackageFamilyName'] -and $rule.PackageFamilyName -and [string]$rule.PackageFamilyName -ne 'Any') { continue }
            $id = [string]$rule.InstanceID
            if (-not $applications.ContainsKey($id) -or -not $services.ContainsKey($id)) { return 'firewall-uncertain' }
            $app = $applications[$id]; $service = $services[$id]
            # Package and service restrictions cannot match this ordinary node.exe app.
            if ($app.Package -and [string]$app.Package -ne 'Any') { continue }
            if ($service.Service -and [string]$service.Service -ne 'Any') { continue }
            $program = [Environment]::ExpandEnvironmentVariables([string]$app.Program)
            if ([string]::IsNullOrWhiteSpace($program)) { return 'firewall-uncertain' }
            if ($program -eq 'System') { continue }
            if ($program -ne 'Any' -and ($program -cnotmatch '^[A-Za-z]:\\' -or $program -match '[%~*?<>"|/\x00-\x1f]' -or
                $program.Substring(2).Contains(':') -or -not [String]::Equals([IO.Path]::GetFullPath($program),$program,[StringComparison]::OrdinalIgnoreCase))) { return 'firewall-uncertain' }
            if ($program -ne 'Any' -and -not [String]::Equals($program,$NodeExecutablePath,[StringComparison]::OrdinalIgnoreCase)) {
                # Program rules match the full application path, not a basename.
                # A separately installed, canonical node.exe is another program.
                continue
            }
            $portRows = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
            if ($portRows.Count -ne 1) { return 'firewall-uncertain' }
            $port = $portRows[0]
            if ([string]$port.Protocol -notin @('Any','256','TCP','6')) { continue }
            $portMatch = Get-CarebridgePortMatch $port.LocalPort
            if ($portMatch -eq 0) { continue }; if ($portMatch -lt 0) { return 'firewall-uncertain' }
            # An exception removes 8443 from a machine-wide Public block. An
            # existing allow on ANY local address/interface could then escape
            # the approved tuple, so reject it before narrowing by NIC/address.
            if ($TemporaryTcpBlockRule -ne '') {
                if ([string]$rule.Action -eq 'Allow') { return 'firewall-allow' }
                # Authenticated AllowBypass/unknown actions must not evade the
                # machine-wide guard audit by using another local NIC/address.
                if ([string]$rule.Action -ne 'Block') { return 'firewall-uncertain' }
            }
            $addressRows = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
            $interfaceRows = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
            $typeRows = @($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
            if ($addressRows.Count -ne 1 -or $interfaceRows.Count -ne 1 -or $typeRows.Count -ne 1) { return 'firewall-uncertain' }
            $address = $addressRows[0]; $interface = $interfaceRows[0]; $type = $typeRows[0]
            if (@($type.InterfaceType).Count -eq 0) { return 'firewall-uncertain' }
            if (@($type.InterfaceType | Where-Object { $_ -in @('Any','Wireless') }).Count -eq 0) { continue }
            $aliases = @($interface.InterfaceAlias)
            if ($aliases.Count -eq 0) { return 'firewall-uncertain' }
            if (@($aliases | Where-Object { $_ -eq 'Any' -or $_ -ceq $InterfaceAlias }).Count -eq 0) {
                if (@($aliases | Where-Object { [string]$_ -match '[*?\[\]]' }).Count -gt 0) { return 'firewall-uncertain' }; continue
            }
            $localMatch = Get-CarebridgeAddressMatch $address.LocalAddress $LocalIPv4
            if ($localMatch -eq 0) { continue }; if ($localMatch -lt 0) { return 'firewall-uncertain' }
            if ([string]$rule.Action -eq 'Allow') { return 'firewall-allow' }
            if ([string]$rule.Action -eq 'Block') {
                $remoteMatch = Get-CarebridgeAddressMatch $address.RemoteAddress $PeerIPv4
                if ($remoteMatch -eq 0) { continue }; if ($remoteMatch -lt 0) { return 'firewall-uncertain' }; return 'firewall-block'
            }
            return 'firewall-uncertain'
        }
        return $null
    } catch { return 'firewall-uncertain' }
}
