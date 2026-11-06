param([string]$Base, [string]$RunId, [string]$KeyId, [ValidateSet('file-add','file-remove','root-add','root-remove')][string]$Action,
    [ValidateSet('recovery','database')][string]$Purpose = 'recovery')
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot '../../scripts/beta-storage-policy.ps1')
    $policy = Get-CarebridgeStoragePolicy $Base
    Assert-CarebridgeStorageReceipt $policy
    if ($RunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $KeyId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid fixture identifiers.' }
    $prefix = if ($Purpose -ceq 'database') { 'credential-check-' } else { 'key-check-' }
    $receiptName = if ($Purpose -ceq 'database') { '.carebridge-database-credentials.json' } else { '.carebridge-key-store.json' }
    $receiptPurpose = if ($Purpose -ceq 'database') { 'carebridge-windows-database-credentials' } else { 'carebridge-windows-recovery-keys' }
    $root = Join-Path (Join-Path $policy.PrivateRoot 'checks') ($prefix + $RunId)
    Assert-CarebridgeDirectoryChain $root
    $receipt = Read-CarebridgePrivateReceipt (Join-Path $root $receiptName) $policy
    if ($receipt.root -cne $root -or $receipt.operatorSid -cne $policy.OperatorSid.Value -or $receipt.purpose -cne $receiptPurpose) { throw 'Unknown fixture.' }
    $target = if ($Action.StartsWith('file-')) { Join-Path $root ($KeyId + '.dpapi') } else { $root }
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture must not be a link.' }
    $acl = Get-Acl -LiteralPath $target
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $policy.OperatorSid.Value) { throw 'Wrong fixture owner.' }
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
    $matches = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $users.Value })
    if ($Action.EndsWith('-add')) {
        if ($matches.Count -ne 0) { throw 'Fixture already has unexpected access.' }
        $acl.AddAccessRule($rule)
    } else {
        if ($matches.Count -ne 1 -or $matches[0].IsInherited -or $matches[0].AccessControlType -ne 'Allow' -or
            $matches[0].FileSystemRights -ne $rule.FileSystemRights) { throw 'Unknown fixture ACL; not repaired.' }
        $acl.RemoveAccessRuleSpecific($matches[0])
    }
    Set-Acl -LiteralPath $target -AclObject $acl
    [Console]::Write('KEY_FIXTURE_ACL_OK')
} catch { [Console]::Error.Write('KEY_FIXTURE_FAILED'); exit 1 }
