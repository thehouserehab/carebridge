[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Base,
    [switch]$ConfirmPortableRuntime,
    [switch]$VerifyOnly
)

# Project-scoped tools only. No cluster, service, account, firewall, PATH or
# Docker changes. A failed stage is retained, never executed or auto-adopted.
$ErrorActionPreference = 'Stop'
if (-not $ConfirmPortableRuntime) { throw 'Explicit portable PostgreSQL confirmation is required.' }
if (-not $IsWindows -or [IntPtr]::Size -ne 8) { throw 'Windows PowerShell 7 on x64 is required.' }
$version = '18.6-5'
$source = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip'
$sourcePage = 'https://www.enterprisedb.com/download-postgresql-binaries'
$checksumSource = 'https://github.com/EnterpriseDB/edb-installers/issues/733#issuecomment-6012030716'
$expectedHash = 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2'
$expectedBytes = 384620317

if ($VerifyOnly -and (-not [IO.Path]::IsPathFullyQualified($Base) -or
    -not (Test-Path -LiteralPath (Join-Path $Base "private/runtime/postgresql-$version")))) {
    throw 'Verify-only requires an already prepared project runtime; no download or initialization.'
}

# Reuse the authoritative private-root/owner/NTFS ACL checks. It refuses
# unrecognized existing roots rather than relaxing or repairing permissions.
& (Join-Path $PSScriptRoot 'initialize-beta-storage.ps1') -Base $Base -ConfirmLocalBetaStorage | Out-Null
$privateRoot = Join-Path ([IO.Path]::GetFullPath($Base)) 'private'
$runtimeRoot = Join-Path $privateRoot 'runtime'
$target = Join-Path $runtimeRoot "postgresql-$version"
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Assert-PrivatePath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ([bool]$item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Runtime paths must be regular files/directories, not links.'
    }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operatorSid) { throw 'Runtime owner mismatch.' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $allowed = @($operatorSid, 'S-1-5-18', 'S-1-5-32-544')
    if ($rules.Count -ne 3) { throw 'Unexpected runtime access rules.' }
    foreach ($sid in $allowed) {
        $matches = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
        if ($matches.Count -ne 1 -or $matches[0].AccessControlType -ne 'Allow' -or
            $matches[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'Runtime permissions do not match the private operator policy.'
        }
    }
}

function Write-NewFile([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Assert-Runtime([string]$Root) {
    Assert-PrivatePath $Root $true
    $receiptPath = Join-Path $Root '.carebridge-runtime.json'
    Assert-PrivatePath $receiptPath $false
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.schema -ne 1 -or $receipt.purpose -ne 'carebridge-portable-postgres' -or
        $receipt.version -ne $version -or $receipt.archiveSha256 -ne $expectedHash -or
        $receipt.source -ne $source -or $receipt.checksumSource -ne $checksumSource -or
        $receipt.operatorSid -ne $operatorSid -or @($receipt.files).Count -lt 5) {
        throw 'Unrecognized PostgreSQL runtime receipt; left unchanged.'
    }
    $archivePath = Join-Path $Root 'package.zip'
    Assert-PrivatePath $archivePath $false
    if ((Get-Item -LiteralPath $archivePath).Length -ne $expectedBytes -or
        (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'PostgreSQL archive checksum mismatch.'
    }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null = $expected.Add('.carebridge-runtime.json'); $null = $expected.Add('package.zip')
    foreach ($file in $receipt.files) {
        if ($file.name -notmatch '^pgsql/(bin|lib|share)/[a-zA-Z0-9_./ +@-]+$' -or
            $file.name -match '(^|/)\.\.?(/|$)' -or -not $expected.Add($file.name) -or
            $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid runtime file manifest.' }
        $path = Join-Path $Root $file.name
        Assert-PrivatePath $path $false
        if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw 'PostgreSQL runtime file changed; do not execute it.'
        }
    }
    $found = @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
    foreach ($item in $found) {
        Assert-PrivatePath $item.FullName ([bool]$item.PSIsContainer)
        if (-not $item.PSIsContainer) {
            $name = [IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\', '/')
            if (-not $expected.Contains($name)) { throw 'Unrecognized file in PostgreSQL runtime.' }
        }
    }
    if (@($found | Where-Object { -not $_.PSIsContainer }).Count -ne $expected.Count) { throw 'Runtime file inventory mismatch.' }
    foreach ($name in @('postgres', 'initdb', 'pg_ctl', 'pg_dump', 'pg_restore', 'psql')) {
        if (-not $expected.Contains("pgsql/bin/$name.exe")) { throw 'Required PostgreSQL executable is absent.' }
    }
    return $receipt
}

if (-not (Test-Path -LiteralPath $runtimeRoot)) { $null = New-Item -ItemType Directory -Path $runtimeRoot }
Assert-PrivatePath $runtimeRoot $true
$lockPath = Join-Path $runtimeRoot '.prepare-postgres.lock'
. (Join-Path $PSScriptRoot 'postgres-prepare-lock.ps1')
$lock = Open-CarebridgePostgresPrepareLock -Path $lockPath
try {
    $reused = Test-Path -LiteralPath $target
    if ($reused) {
        $receipt = Assert-Runtime $target
    } else {
        $stage = Join-Path $runtimeRoot ('.postgres-stage-' + [Guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $stage
        Assert-PrivatePath $stage $true
        $archivePath = Join-Path $stage 'package.zip'
        # HTTPS without insecure TLS flags; no redirect to an unreviewed host.
        $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false
        $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [TimeSpan]::FromMinutes(10)
        $response = $null; $inputStream = $null; $outputStream = $null
        $downloadDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(10))
        try {
            $response = $client.GetAsync($source, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -ne 200 -or $response.Content.Headers.ContentLength -ne $expectedBytes) {
                throw 'Unexpected official archive response; no runtime execution.'
            }
            $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $outputStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $buffer = [byte[]]::new(1048576); $total = 0
            while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $downloadDeadline.Token).GetAwaiter().GetResult()) -gt 0) {
                $total += $count
                if ($total -gt $expectedBytes) { throw 'Official archive exceeded expected length.' }
                $outputStream.Write($buffer, 0, $count)
            }
            $outputStream.Flush($true)
            if ($total -ne $expectedBytes) { throw 'Incomplete PostgreSQL archive download.' }
        } finally {
            if ($null -ne $outputStream) { $outputStream.Dispose() }
            if ($null -ne $inputStream) { $inputStream.Dispose() }
            if ($null -ne $response) { $response.Dispose() }
            $downloadDeadline.Dispose()
            $client.Dispose(); $handler.Dispose()
        }
        if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
            throw 'Vendor-supplied SHA-256 does not match. Archive retained, not extracted or executed.'
        }
        $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
        $inventory = [Collections.Generic.List[object]]::new()
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        try {
            $expandedBytes = 0
            foreach ($entry in $zip.Entries) {
                # Only the DB engine/tools/libraries/catalogs; no pgAdmin,
                # StackBuilder, extension installer or OS integration.
                if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/') { continue }
                $name = $entry.FullName
                if ($name -notmatch '^pgsql/(bin|lib|share)/[a-zA-Z0-9_./ +@-]+$' -or
                    $name -match '(^|/)\.\.?(/|$)' -or -not $names.Add($name) -or
                    (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe ZIP entry.' }
                $path = [IO.Path]::GetFullPath((Join-Path $stage $name))
                if (-not $path.StartsWith($stage + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path escapes its fresh stage.' }
                if ($name.EndsWith('/')) { $null = [IO.Directory]::CreateDirectory($path); continue }
                $expandedBytes += $entry.Length
                if ($expandedBytes -gt 1073741824 -or $entry.Length -gt 268435456 -or $inventory.Count -gt 20000) { throw 'ZIP expansion limit exceeded.' }
                $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
                $inputStream = $entry.Open()
                $outputStream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
                finally { $outputStream.Dispose(); $inputStream.Dispose() }
                if ((Get-Item -LiteralPath $path).Length -ne $entry.Length) { throw 'Extracted ZIP length mismatch.' }
                $inventory.Add([ordered]@{ name = $name; bytes = $entry.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() })
            }
        } finally { $zip.Dispose() }
        $receipt = [ordered]@{ schema = 1; purpose = 'carebridge-portable-postgres'; version = $version
            archiveSha256 = $expectedHash; source = $source; sourcePage = $sourcePage; checksumSource = $checksumSource
            operatorSid = $operatorSid; preparedAt = [DateTime]::UtcNow.ToString('o'); files = @($inventory.ToArray()) }
        Write-NewFile (Join-Path $stage '.carebridge-runtime.json') ([Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 5)))
        $receipt = Assert-Runtime $stage
        [IO.Directory]::Move($stage, $target) # Fails if target exists; never replaces/adopts it.
    }
    [ordered]@{ prepared = $true; reused = [bool]$reused; version = $version
        runtimeRoot = $target; bin = (Join-Path $target 'pgsql/bin'); verifiedFileCount = @($receipt.files).Count
        archiveSha256 = $expectedHash; checksumSource = $checksumSource
        limitations = @('Unsigned vendor binaries; vendor checksum verified, no security-policy bypass',
            'No database, service, actual accounts, API, external access or production readiness') } | ConvertTo-Json -Depth 3
} finally {
    $lock.Dispose()
}
