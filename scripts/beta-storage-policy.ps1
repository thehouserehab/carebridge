# Shared, read-only Windows storage checks. Dot-sourcing never creates/repairs a
# directory, changes an ACL, starts a service or emits an ownership receipt.
function Assert-CarebridgeDirectoryChain([string]$Target) {
    $part = [IO.Path]::GetFullPath($Target)
    while ($true) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Storage directory chains must not contain files, junctions or symbolic links.'
            }
        }
        $parent = [IO.Directory]::GetParent($part)
        if ($null -eq $parent) { break }
        $part = $parent.FullName
    }
}

function Get-CarebridgeStoragePolicy([string]$Base) {
    if (-not $IsWindows) { throw 'Windows PowerShell 7 is required.' }
    if (-not [IO.Path]::IsPathFullyQualified($Base) -or $Base -notmatch '^[Ee]:[\\/]') { throw 'Use an explicit E-drive directory.' }
    $betaBase = [IO.Path]::GetFullPath($Base).TrimEnd([char[]]@('\', '/'))
    if ($betaBase -eq 'E:' -or $betaBase -eq 'e:' -or $betaBase.Substring(2) -match '[:*?"<>|\x00-\x1f\x7f]') {
        throw 'A valid application directory, not a drive root, is required.'
    }
    $volume = Get-Volume -DriveLetter E
    if ($volume.DriveType -ne 'Fixed' -or $volume.FileSystemType -ne 'NTFS' -or $volume.HealthStatus -ne 'Healthy') {
        throw 'A healthy fixed NTFS E drive is required.'
    }
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    [pscustomobject]@{
        Base = $betaBase; PrivateRoot = (Join-Path $betaBase 'private'); OperatorSid = $operatorSid
        PrincipalSids = @($operatorSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    }
}

function Assert-CarebridgePrivateAcl([string]$Target, $Policy, [bool]$RequireProtected = $false, [bool]$File = $false) {
    if ($File) {
        Assert-CarebridgeDirectoryChain ([IO.Path]::GetDirectoryName($Target))
        $item = Get-Item -LiteralPath $Target -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private files must not be links.' }
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    } else {
        Assert-CarebridgeDirectoryChain $Target
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $acl = Get-Acl -LiteralPath $Target
    if ($RequireProtected -and -not $acl.AreAccessRulesProtected) { throw 'Private root ACL inheritance is not blocked.' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Policy.OperatorSid.Value) { throw 'Storage owner is not the current operator.' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { throw 'Unexpected private storage access rules.' }
    foreach ($sid in $Policy.PrincipalSids) {
        $matches = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
        if ($matches.Count -ne 1 -or $matches[0].AccessControlType -ne 'Allow' -or
            $matches[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $matches[0].InheritanceFlags -ne $inheritance -or
            $matches[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw 'Private storage permissions do not match the explicit local operator policy.'
        }
    }
}

function Read-CarebridgePrivateReceipt([string]$Path, $Policy) {
    Assert-CarebridgePrivateAcl $Path $Policy $false $true
    # Immutable receipts may be read by concurrent API/worker providers.
    # Share only reads; writers and deletion/replacement remain excluded.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 2 -or $stream.Length -gt 8192) { throw 'Invalid receipt size.' }
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
        try { ConvertFrom-CarebridgeJson ($reader.ReadToEnd()) } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function ConvertFrom-CarebridgeJson([string]$Json) {
    # PowerShell 7.5+ otherwise converts ISO dates to DateTime automatically.
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        $Json | ConvertFrom-Json -AsHashtable -DateKind String
    } else { $Json | ConvertFrom-Json -AsHashtable }
}

function Assert-CarebridgeStorageReceipt($Policy) {
    Assert-CarebridgePrivateAcl $Policy.PrivateRoot $Policy $true
    $receipt = Read-CarebridgePrivateReceipt (Join-Path $Policy.PrivateRoot '.carebridge-storage-owner.json') $Policy
    if ((($receipt.Keys | Sort-Object) -join ',') -cne 'initializedAt,operatorSid,purpose,root,schema' -or
        $receipt.schema -cne 1 -or $receipt.purpose -cne 'carebridge-local-beta-storage' -or
        $receipt.root -cne $Policy.PrivateRoot -or $receipt.operatorSid -cne $Policy.OperatorSid.Value -or
        $receipt.initializedAt -isnot [string]) { throw 'Storage receipt does not match this local operator and directory.' }
}
