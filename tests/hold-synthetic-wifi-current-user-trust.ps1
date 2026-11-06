# Explicit human-operated synthetic trial tooling; never loaded by the app.
# A killed observer or Windows restart can skip finally. Keep the receipt and
# perform exact-certificate recovery; this is not a crash-safe trust service.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CertificatePath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory)][ValidatePattern('^[A-F0-9]{40}$')][string]$ExpectedThumbprint,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OwnerPid,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]{17,19}$')][string]$OwnerStartTimeUtcTicks,
    [Parameter(Mandatory)][string]$NodeExecutablePath,
    [Parameter(Mandatory)][ValidatePattern('^S-1-5-[0-9-]+$')][string]$ExpectedUserSid,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$owner = $null; $certificateFile = $null; $certificate = $null; $receipt = $null
$ownedAttempt = $false; $active = $false; $failed = $false; $removed = $false
$phase = 'preflight'; $deadline = $null; $clock = $null; $remainingMilliseconds = 0

function Require-LocalPath([string]$Path, [bool]$ExistingFile) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2) -match '[:*?"<>|\x00-\x1f/]' -or
        [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'REFUSED' }
    $first = $true
    for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
        if ($first -and -not $ExistingFile) {
            if ([IO.File]::Exists($part) -or [IO.Directory]::Exists($part)) { throw 'REFUSED' }
        } else {
            $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($first -and $ExistingFile -and $item.PSIsContainer) -or
                (-not $first -and -not $item.PSIsContainer)) { throw 'REFUSED' }
        }
        $first = $false
    }
}
function Get-Hash([byte[]]$Bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Open-Root([bool]$Writable) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new(
        [Security.Cryptography.X509Certificates.StoreName]::Root,
        [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    try {
        $flags = [Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly
        if ($Writable) { $flags = $flags -bor [Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite }
        else { $flags = $flags -bor [Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly }
        $store.Open($flags)
        return $store
    } catch { $store.Dispose(); throw 'REFUSED' }
}
function Find-ExactRoot($Store) {
    $matches = @($Store.Certificates | Where-Object Thumbprint -CEQ $ExpectedThumbprint)
    foreach ($candidate in $matches) {
        if ($candidate.HasPrivateKey -or (Get-Hash $candidate.RawData) -cne $ExpectedSha256) { throw 'REFUSED' }
    }
    return $matches
}
function Assert-RootCount([int]$Count) {
    $store = Open-Root $false
    try { if (@(Find-ExactRoot $store).Count -ne $Count) { throw 'REFUSED' } }
    finally { $store.Dispose() }
}
function Assert-OwnerAlive {
    $exited = $owner.HasExited
    if ($exited -isnot [bool] -or $exited) { throw 'REFUSED' }
}
function Write-Receipt([string]$State) {
    $data = [ordered]@{schema=1;purpose='synthetic-wifi-current-user-root';state=$State;
        thumbprint=$ExpectedThumbprint;sha256=$ExpectedSha256;scope='CurrentUser/Root';
        ownerPid=$OwnerPid;ownerStartTimeUtcTicks=$OwnerStartTimeUtcTicks;
        deadlineUtc=$deadline.ToString('o');updatedUtc=[DateTime]::UtcNow.ToString('o')}
    $bytes = [Text.Encoding]::UTF8.GetBytes(($data | ConvertTo-Json -Compress))
    $receipt.Position = 0; $receipt.Write($bytes,0,$bytes.Length); $receipt.SetLength($bytes.Length); $receipt.Flush($true)
}
try {
    if (-not $IsWindows) { throw 'REFUSED' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
            $identity.User.Value -cne $ExpectedUserSid) { throw 'REFUSED' }
    } finally { $identity.Dispose() }
    Require-LocalPath $CertificatePath $true
    Require-LocalPath $NodeExecutablePath $true
    Require-LocalPath $ReceiptPath $false
    if ([IO.File]::Exists($ReceiptPath + '.stop') -or [IO.Directory]::Exists($ReceiptPath + '.stop')) { throw 'REFUSED' }
    $owner = Get-Process -Id $OwnerPid -ErrorAction Stop
    $null = $owner.Handle # Pin the process, not merely a reusable PID.
    Assert-OwnerAlive
    if ($owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $OwnerStartTimeUtcTicks -or
        -not [string]::Equals($owner.Path,$NodeExecutablePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSED' }
    # Reuse the original CLI lifetime, never start a new two-hour allowance.
    $deadline = $owner.StartTime.ToUniversalTime().AddHours(2)
    if ($deadline -le [DateTime]::UtcNow) { throw 'REFUSED' }
    $remainingMilliseconds = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $certificateFile = [IO.File]::Open($CertificatePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    if ($certificateFile.Length -lt 128 -or $certificateFile.Length -gt 8192) { throw 'REFUSED' }
    $bytes = [byte[]]::new([int]$certificateFile.Length)
    $certificateFile.ReadExactly($bytes)
    if ((Get-Hash $bytes) -cne $ExpectedSha256) { throw 'REFUSED' }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
    $constraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -ceq '2.5.29.19' })
    if ($certificate.HasPrivateKey -or $certificate.Thumbprint -cne $ExpectedThumbprint -or
        (Get-Hash $certificate.RawData) -cne $ExpectedSha256 -or
        $certificate.Subject -cne $certificate.Issuer -or
        $certificate.Subject -cnotmatch '^CN=Carebridge synthetic Wi-Fi root [a-f0-9-]{36}$' -or
        $constraints.Count -ne 1 -or -not $constraints[0].CertificateAuthority -or -not $constraints[0].Critical -or
        $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or
        $certificate.NotAfter.ToUniversalTime() -le $deadline -or
        $certificate.NotAfter.ToUniversalTime() -gt [DateTime]::UtcNow.AddHours(25)) { throw 'REFUSED' }
    Assert-RootCount 0
    if ($ValidateOnly) {
        [Console]::Out.WriteLine('{"preflight":true,"changed":false}')
    } else {
        # CreateNew prevents overwrite; retain this same open receipt handle.
        $receipt = [IO.File]::Open($ReceiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
        Write-Receipt 'prepared'
        Assert-OwnerAlive
        if ([DateTime]::UtcNow -ge $deadline -or $clock.Elapsed.TotalMilliseconds -ge $remainingMilliseconds) { throw 'REFUSED' }
        $phase = 'add'; $store = Open-Root $true
        try {
            if (@(Find-ExactRoot $store).Count -ne 0) { throw 'REFUSED' }
            Assert-OwnerAlive
            if ([IO.File]::Exists($ReceiptPath + '.stop') -or [DateTime]::UtcNow -ge $deadline -or
                $clock.Elapsed.TotalMilliseconds -ge $remainingMilliseconds) { throw 'REFUSED' }
            $ownedAttempt = $true
            $store.Add($certificate)
        } finally { $store.Dispose() }
        Assert-RootCount 1
        Assert-OwnerAlive
        if ([IO.File]::Exists($ReceiptPath + '.stop') -or [DateTime]::UtcNow -ge $deadline -or
            $clock.Elapsed.TotalMilliseconds -ge $remainingMilliseconds) { throw 'REFUSED' }
        $active = $true; Write-Receipt 'active'
        [Console]::Out.WriteLine('{"active":true,"scope":"CurrentUser/Root"}')
        $phase = 'observe'
        while ([DateTime]::UtcNow -lt $deadline -and $clock.Elapsed.TotalMilliseconds -lt $remainingMilliseconds -and
            -not [IO.File]::Exists($ReceiptPath + '.stop')) {
            $exited = $owner.WaitForExit(1000)
            if ($exited -isnot [bool]) { throw 'REFUSED' }
            if ($exited) { break }
        }
    }
} catch {
    $failed = $true
    [Console]::Out.WriteLine((@{failed=$true;phase=$phase} | ConvertTo-Json -Compress))
} finally {
    if ($ownedAttempt) {
        try {
            $store = Open-Root $true
            try { foreach ($candidate in @(Find-ExactRoot $store)) { $store.Remove($candidate) } }
            finally { $store.Dispose() }
            Assert-RootCount 0
            $removed = $true
        } catch {
            $failed = $true
            try { Write-Receipt 'cleanup-unconfirmed' } catch {}
            [Console]::Out.WriteLine('{"removed":false,"cleanupUnconfirmed":true}')
        }
        if ($removed) {
            try { Write-Receipt 'removed' } catch { $failed = $true }
            [Console]::Out.WriteLine('{"removed":true,"scope":"CurrentUser/Root"}')
        }
    } elseif ($null -ne $receipt) {
        try { Write-Receipt 'not-added' } catch { $failed = $true }
    }
    if ($null -ne $receipt) { $receipt.Dispose() }
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $certificateFile) { $certificateFile.Dispose() }
    if ($null -ne $owner) { $owner.Dispose() }
}
if ($failed -or ($ownedAttempt -and -not $removed)) { exit 1 }
exit 0
