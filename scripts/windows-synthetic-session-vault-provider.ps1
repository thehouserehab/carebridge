# Synthetic-session-only bounded stdin/stdout protocol. No credential arguments,
# environment secrets, plaintext export, LocalMachine fallback, reset or adopt.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$inputBytes = $null; $plain = $null; $protected = $null; $resultBytes = $null; $entropy = $null

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
    if ($Value.Length -gt 12288) { throw 'Invalid value.' }
    $bytes = [Convert]::FromBase64String($Value)
    if ($bytes.Length -lt $Minimum -or $bytes.Length -gt $Maximum -or [Convert]::ToBase64String($bytes) -cne $Value) {
        [Array]::Clear($bytes, 0, $bytes.Length)
        throw 'Invalid value.'
    }
    return ,$bytes
}
try {
    if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
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
        if ($properties.Count -ne 11 -or @($properties.Name | Select-Object -Unique).Count -ne 11) { throw 'Invalid request shape.' }
    } finally { $document.Dispose() }
    $request = ConvertFrom-CarebridgeJson $json
    if ((($request.Keys | Sort-Object) -join ',') -cne 'base,createdAt,operation,ownerSid,purpose,root,schema,scope,syntheticRunId,value,vaultId' -or
        ($request.schema -isnot [long] -and $request.schema -isnot [int]) -or $request.schema -cne 1 -or
        $request.purpose -isnot [string] -or $request.purpose -cne 'carebridge-synthetic-session' -or
        $request.scope -isnot [string] -or $request.scope -cne 'CurrentUser' -or
        $request.operation -isnot [string] -or $request.operation -cnotin @('protect','unprotect','check') -or
        $request.base -isnot [string] -or $request.root -isnot [string] -or $request.vaultId -isnot [string] -or
        $request.vaultId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $request.syntheticRunId -isnot [string] -or
        $request.syntheticRunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $request.createdAt -isnot [string] -or $request.createdAt -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or
        $request.value -isnot [string]) { throw 'Invalid request.' }
    $timestamp = [DateTime]::ParseExact($request.createdAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    if ($request.operation -ceq 'protect') {
        if ($null -ne $request.ownerSid) { throw 'Invalid protection owner.' }
        $plain = Canonical-Base64 $request.value 32 8192
    } else { $protected = Canonical-Base64 $request.value 64 9216 }
    $policy = Get-CarebridgeStoragePolicy $request.base
    Assert-CarebridgeStorageReceipt $policy
    $parent = Join-Path $policy.PrivateRoot 'checks'
    $root = Join-Path $parent ('session-vault-' + $request.syntheticRunId)
    if ($request.root -cne $root) { throw 'Invalid vault root.' }
    Assert-CarebridgePrivateAcl $parent $policy
    Assert-CarebridgeDirectoryChain $root
    $receiptPath = Join-Path $root '.carebridge-session-vault.json'
    if (-not (Test-Path -LiteralPath $root)) {
        if ($request.operation -cne 'protect') { throw 'Missing vault.' }
        $null = New-Item -ItemType Directory -Path $root
        Assert-CarebridgePrivateAcl $root $policy
        $receipt = [ordered]@{schema=1; purpose='carebridge-windows-synthetic-session-vault'; root=$root
            syntheticRunId=$request.syntheticRunId; operatorSid=$policy.OperatorSid.Value}
        $receiptFile = [IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {
            $receiptBytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
            $receiptFile.Write($receiptBytes); $receiptFile.Flush($true)
        } finally { $receiptFile.Dispose() }
    }
    Assert-CarebridgePrivateAcl $root $policy
    $receipt = Read-CarebridgePrivateReceipt $receiptPath $policy
    if ((($receipt.Keys | Sort-Object) -join ',') -cne 'operatorSid,purpose,root,schema,syntheticRunId' -or
        $receipt.schema -cne 1 -or $receipt.purpose -cne 'carebridge-windows-synthetic-session-vault' -or
        $receipt.root -cne $root -or $receipt.syntheticRunId -cne $request.syntheticRunId -or
        $receipt.operatorSid -cne $policy.OperatorSid.Value) { throw 'Unknown vault; not adopted.' }
    $vaultPath = Join-Path $root ($request.vaultId + '.dpapi')
    if ($request.operation -ceq 'protect') {
        if (Test-Path -LiteralPath $vaultPath) { throw 'Existing vault must not be overwritten.' }
    } else {
        if ($request.ownerSid -isnot [string] -or $request.ownerSid -cne $policy.OperatorSid.Value) { throw 'Wrong vault owner.' }
        Assert-CarebridgePrivateAcl $vaultPath $policy $false $true
    }
    # Both the session identity and canonical root bind this purpose-specific
    # ciphertext. Copying it to another session/root does not grant adoption.
    $entropyText = @('carebridge-synthetic-session','1','CurrentUser',$request.syntheticRunId,$request.vaultId,
        $request.createdAt,$policy.OperatorSid.Value,$root.ToUpperInvariant()) -join '|'
    $entropy = [Text.Encoding]::UTF8.GetBytes($entropyText)
    if ($request.operation -ceq 'protect') {
        $protected = [Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($protected.Length -lt 64 -or $protected.Length -gt 9216) { throw 'Invalid protected size.' }
        $response = [ordered]@{schema=1; purpose='carebridge-synthetic-session'; scope='CurrentUser'
            syntheticRunId=$request.syntheticRunId; vaultId=$request.vaultId; root=$root
            createdAt=$request.createdAt; ownerSid=$policy.OperatorSid.Value; value=[Convert]::ToBase64String($protected)}
    } elseif ($request.operation -ceq 'unprotect') {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -lt 32 -or $plain.Length -gt 8192) { throw 'Invalid payload size.' }
        $response = [ordered]@{schema=1; vaultId=$request.vaultId; value=[Convert]::ToBase64String($plain)}
    } else { $response = [ordered]@{schema=1; vaultId=$request.vaultId; verified=$true} }
    $resultBytes = [Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Compress))
    if ($resultBytes.Length -gt 16384) { throw 'Invalid output size.' }
    $responseHeader = [byte[]]::new(4)
    for ($i=0; $i -lt 4; $i++) { $responseHeader[$i] = ($resultBytes.Length -shr (24 - 8 * $i)) -band 255 }
    $outputStream.Write($responseHeader); $outputStream.Write($resultBytes); $outputStream.Flush()
    exit 0
} catch {
    [Console]::Error.Write('WINDOWS_SYNTHETIC_SESSION_VAULT_UNAVAILABLE')
    exit 1
} finally {
    if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($null -ne $protected) { [Array]::Clear($protected,0,$protected.Length) }
    if ($null -ne $inputBytes) { [Array]::Clear($inputBytes,0,$inputBytes.Length) }
    if ($null -ne $resultBytes) { [Array]::Clear($resultBytes,0,$resultBytes.Length) }
    if ($null -ne $entropy) { [Array]::Clear($entropy,0,$entropy.Length) }
}
