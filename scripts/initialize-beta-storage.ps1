[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Base,
    [switch]$ConfirmLocalBetaStorage
)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmLocalBetaStorage) { throw 'Explicit local beta storage confirmation is required.' }
. (Join-Path $PSScriptRoot 'beta-storage-policy.ps1')
$policy = Get-CarebridgeStoragePolicy $Base
$operatorSid = $policy.OperatorSid
$principalSids = $policy.PrincipalSids
$privateRoot = $policy.PrivateRoot
$receiptPath = Join-Path $privateRoot '.carebridge-storage-owner.json'
$children = @('media', 'recovery', 'secrets', 'logs', 'checks')

Assert-CarebridgeDirectoryChain $privateRoot
$reused = Test-Path -LiteralPath $privateRoot
if ($reused) {
    # Never repair/adopt an unrecognized existing directory or overwrite data.
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'Existing private directory has no ownership receipt; left unchanged.' }
    Assert-CarebridgeStorageReceipt $policy
} else {
    $null = New-Item -ItemType Directory -Path $privateRoot
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($operatorSid)
    foreach ($sid in $principalSids) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $privateRoot -AclObject $security
    Assert-CarebridgePrivateAcl $privateRoot $policy $true
    $receipt = [ordered]@{
        schema = 1; purpose = 'carebridge-local-beta-storage'; root = $privateRoot
        operatorSid = $operatorSid.Value; initializedAt = [DateTime]::UtcNow.ToString('o')
    }
    # A receipt, not a secret or service credential. Exclusive create only.
    $receiptFile = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $receiptBytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json))
        $receiptFile.Write($receiptBytes, 0, $receiptBytes.Length)
        $receiptFile.Flush($true)
    } finally { $receiptFile.Dispose() }
}

foreach ($name in $children) {
    $directory = Join-Path $privateRoot $name
    Assert-CarebridgeDirectoryChain $directory
    if (-not (Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory }
    Assert-CarebridgePrivateAcl $directory $policy
}

[ordered]@{
    initialized = $true; reused = [bool]$reused; privateRoot = $privateRoot
    directories = $children; allowedPrincipalCount = 3; rootInheritanceBlocked = $true
    limitations = @('No database/API/service activation or existing data migration',
        'Current Windows operator still has full access; not dedicated service-account isolation',
        'No disk encryption, independent backup, power-loss or external-access verification')
} | ConvertTo-Json -Depth 4
