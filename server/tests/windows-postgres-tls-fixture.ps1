# Own fresh synthetic PG fixture only. No Windows certificate-store writes,
# operating CA/key, service installation or trust-store modification.
param([string]$Base,[string]$RunId)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$keyBytes=$null; $rsa=$null; $certificate=$null
try {
    . (Join-Path $PSScriptRoot '../../scripts/beta-storage-policy.ps1')
    $policy=Get-CarebridgeStoragePolicy $Base; Assert-CarebridgeStorageReceipt $policy
    if($RunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'Invalid fixture.'}
    $checkRoot=Join-Path (Join-Path $policy.PrivateRoot 'checks') ('postgres-check-'+$RunId)
    Assert-CarebridgePrivateAcl $checkRoot $policy
    $check=Read-CarebridgePrivateReceipt (Join-Path $checkRoot '.carebridge-check.json') $policy
    if((($check.Keys | Sort-Object)-join ',') -cne 'purpose,root,runId,schema' -or $check.schema -cne 1 -or
        $check.purpose -cne 'synthetic-native-e-postgres' -or $check.runId -cne $RunId -or $check.root -cne $checkRoot){throw 'Unknown fixture.'}
    $tlsRoot=Join-Path $checkRoot 'tls'
    Assert-CarebridgeDirectoryChain $tlsRoot
    if(Test-Path -LiteralPath $tlsRoot){throw 'Existing TLS fixture not adopted.'}
    $null=New-Item -ItemType Directory -Path $tlsRoot; Assert-CarebridgePrivateAcl $tlsRoot $policy
    $receipt=[ordered]@{schema=1;purpose='synthetic-postgres-tls';runId=$RunId;root=$tlsRoot;operatorSid=$policy.OperatorSid.Value}
    $receiptPath=Join-Path $tlsRoot '.carebridge-tls-fixture.json'
    $receiptFile=[IO.File]::Open($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$receiptBytes=[Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress));$receiptFile.Write($receiptBytes);$receiptFile.Flush($true)}finally{$receiptFile.Dispose()}
    foreach($identity in @('good','wrong')) {
        $rsa=[Security.Cryptography.RSA]::Create(3072)
        $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new(
            ('CN=Carebridge synthetic '+$identity),$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            ([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),$true))
        $usages=[Security.Cryptography.OidCollection]::new();$null=$usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages,$false))
        $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        if($identity -ceq 'good'){$san.AddIpAddress([Net.IPAddress]::Loopback);$san.AddIpAddress([Net.IPAddress]::IPv6Loopback)}
        else{$san.AddIpAddress([Net.IPAddress]::Parse('192.0.2.1'))}
        $request.CertificateExtensions.Add($san.Build())
        $certificate=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(2))
        $certificateBytes=[Text.Encoding]::UTF8.GetBytes($certificate.ExportCertificatePem()+"`n")
        $keyBytes=[Text.Encoding]::UTF8.GetBytes($rsa.ExportPkcs8PrivateKeyPem()+"`n")
        foreach($item in @(@{name=($identity+'.crt');bytes=$certificateBytes},@{name=($identity+'.key');bytes=$keyBytes})) {
            $path=Join-Path $tlsRoot $item.name
            $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{$stream.Write($item.bytes);$stream.Flush($true)}finally{$stream.Dispose()}
            Assert-CarebridgePrivateAcl $path $policy $false $true
        }
        [Array]::Clear($keyBytes,0,$keyBytes.Length);$keyBytes=$null
        $certificate.Dispose();$certificate=$null;$rsa.Dispose();$rsa=$null
    }
    [Console]::Write('{"schema":1,"purpose":"synthetic-postgres-tls","created":true}')
} catch {[Console]::Error.Write('SYNTHETIC_POSTGRES_TLS_UNAVAILABLE');exit 1}
finally {
    if($null -ne $keyBytes){[Array]::Clear($keyBytes,0,$keyBytes.Length)}
    if($null -ne $certificate){$certificate.Dispose()};if($null -ne $rsa){$rsa.Dispose()}
}
