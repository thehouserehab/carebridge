# Internal, bounded binary stdin/stdout protocol only. No key/password args,
# environment credentials, UI, LocalMachine fallback, export or reset command.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$inputBytes = $null; $plain = $null; $resultBytes = $null; $entropy = $null

function Read-ExactBytes([int]$Length) {
    $bytes = [byte[]]::new($Length)
    $offset = 0
    while ($offset -lt $Length) {
        $count = $inputStream.Read($bytes, $offset, $Length - $offset)
        if ($count -eq 0) { throw 'Invalid input frame.' }
        $offset += $count
    }
    return ,$bytes
}
function Canonical-Base64([string]$Value, [int]$Minimum, [int]$Maximum) {
    if ($Value.Length -gt 12000) { throw 'Invalid value.' }
    $bytes = [Convert]::FromBase64String($Value)
    if ($bytes.Length -lt $Minimum -or $bytes.Length -gt $Maximum -or [Convert]::ToBase64String($bytes) -cne $Value) { throw 'Invalid value.' }
    return ,$bytes
}
try {
    . (Join-Path $PSScriptRoot 'beta-storage-policy.ps1')
    $header = Read-ExactBytes 4
    $length = [int](([uint32]$header[0] -shl 24) -bor ([uint32]$header[1] -shl 16) -bor ([uint32]$header[2] -shl 8) -bor [uint32]$header[3])
    if ($length -lt 2 -or $length -gt 16384) { throw 'Invalid input size.' }
    $inputBytes = Read-ExactBytes $length
    if ($inputStream.ReadByte() -ne -1) { throw 'Trailing input.' }
    $json = [Text.UTF8Encoding]::new($false, $true).GetString($inputBytes)
    $document = [Text.Json.JsonDocument]::Parse($json)
    try {
        $properties = @($document.RootElement.EnumerateObject())
        if ($properties.Count -ne 10 -or @($properties.Name | Select-Object -Unique).Count -ne 10) { throw 'Invalid request shape.' }
    } finally { $document.Dispose() }
    $request = ConvertFrom-CarebridgeJson $json
    if ((($request.Keys | Sort-Object) -join ',') -cne 'base,createdAt,keyId,operation,ownerSid,purpose,schema,scope,syntheticRunId,value' -or
        ($request.schema -isnot [long] -and $request.schema -isnot [int]) -or $request.schema -cne 1 -or
        $request.purpose -isnot [string] -or $request.purpose -cne 'carebridge-recovery-key' -or
        $request.scope -isnot [string] -or $request.scope -cne 'CurrentUser' -or
        $request.operation -isnot [string] -or $request.operation -cnotin @('protect', 'unprotect', 'check') -or
        $request.base -isnot [string] -or $request.keyId -isnot [string] -or
        $request.keyId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $request.createdAt -isnot [string] -or $request.createdAt -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or
        $request.value -isnot [string]) { throw 'Invalid request.' }
    $timestamp = [DateTime]::ParseExact($request.createdAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    if ($request.operation -ceq 'protect') {
        if ($null -ne $request.ownerSid) { throw 'Invalid protection owner.' }
        $plain = Canonical-Base64 $request.value 32 32
    }
    $policy = Get-CarebridgeStoragePolicy $request.base
    Assert-CarebridgeStorageReceipt $policy
    if ($null -eq $request.syntheticRunId) {
        $parent = Join-Path $policy.PrivateRoot 'secrets'
        $root = Join-Path $parent 'recovery-keys'
    } else {
        if ($request.syntheticRunId -isnot [string] -or $request.syntheticRunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid synthetic identifier.' }
        $parent = Join-Path $policy.PrivateRoot 'checks'
        $root = Join-Path $parent ('key-check-' + $request.syntheticRunId)
    }
    Assert-CarebridgePrivateAcl $parent $policy
    Assert-CarebridgeDirectoryChain $root
    $receiptPath = Join-Path $root '.carebridge-key-store.json'
    if (-not (Test-Path -LiteralPath $root)) {
        if ($request.operation -cne 'protect') { throw 'Missing key store.' }
        $null = New-Item -ItemType Directory -Path $root
        Assert-CarebridgePrivateAcl $root $policy
        $receipt = [ordered]@{ schema = 1; purpose = 'carebridge-windows-recovery-keys'; root = $root; operatorSid = $policy.OperatorSid.Value }
        $receiptFile = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $receiptBytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
            $receiptFile.Write($receiptBytes); $receiptFile.Flush($true)
        } finally { $receiptFile.Dispose() }
    }
    Assert-CarebridgePrivateAcl $root $policy
    $receipt = Read-CarebridgePrivateReceipt $receiptPath $policy
    if ((($receipt.Keys | Sort-Object) -join ',') -cne 'operatorSid,purpose,root,schema' -or
        $receipt.schema -cne 1 -or $receipt.purpose -cne 'carebridge-windows-recovery-keys' -or
        $receipt.root -cne $root -or $receipt.operatorSid -cne $policy.OperatorSid.Value) { throw 'Unknown key store; not adopted.' }
    $keyPath = Join-Path $root ($request.keyId + '.dpapi')
    if ($request.operation -ceq 'protect') {
        if (Test-Path -LiteralPath $keyPath) { throw 'Existing key must not be overwritten.' }
    } else {
        if ($request.ownerSid -isnot [string] -or $request.ownerSid -cne $policy.OperatorSid.Value) { throw 'Wrong key owner.' }
        Assert-CarebridgePrivateAcl $keyPath $policy $false $true
    }
    # Metadata is part of DPAPI's authenticated additional entropy. A copied
    # blob cannot be relabelled with another key ID, timestamp, scope or owner.
    $entropyText = @('carebridge-recovery-key', '1', 'CurrentUser', $request.keyId, $request.createdAt, $policy.OperatorSid.Value) -join '|'
    $entropy = [Text.Encoding]::UTF8.GetBytes($entropyText)
    if ($request.operation -ceq 'protect') {
        $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $response = [ordered]@{ schema = 1; purpose = 'carebridge-recovery-key'; scope = 'CurrentUser'; keyId = $request.keyId
            createdAt = $request.createdAt; ownerSid = $policy.OperatorSid.Value; value = [Convert]::ToBase64String($protected) }
    } elseif ($request.operation -ceq 'unprotect') {
        $protected = Canonical-Base64 $request.value 64 8192
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -ne 32) { throw 'Invalid key length.' }
        $response = [ordered]@{ schema = 1; keyId = $request.keyId; value = [Convert]::ToBase64String($plain) }
    } else { $response = [ordered]@{ schema = 1; keyId = $request.keyId; verified = $true } }
    $resultBytes = [Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Compress))
    if ($resultBytes.Length -gt 16384) { throw 'Invalid output size.' }
    $responseHeader = [byte[]]::new(4)
    for ($i = 0; $i -lt 4; $i++) { $responseHeader[$i] = ($resultBytes.Length -shr (24 - 8 * $i)) -band 255 }
    $outputStream.Write($responseHeader); $outputStream.Write($resultBytes); $outputStream.Flush()
    exit 0
} catch {
    # Do not serialize native exceptions, filenames, JSON or cryptographic data.
    [Console]::Error.Write('WINDOWS_RECOVERY_KEY_UNAVAILABLE')
    exit 1
} finally {
    if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
    if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
    if ($null -ne $resultBytes) { [Array]::Clear($resultBytes, 0, $resultBytes.Length) }
    if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
}
