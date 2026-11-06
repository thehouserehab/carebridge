# Internal memory-only provider. Input and output belong to one parent Node
# process through anonymous pipes. Never writes keys, imports trust, or opens a
# listener. The parent may separately export only the public root DER bytes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rootKey = $null
$rootCertificate = $null
$leafKey = $null
$leafCertificate = $null
$leafKeyBytes = $null
$report = $null
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported runtime.' }
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 128) { throw 'Invalid request.' }
    $inputData = $inputText | ConvertFrom-Json -AsHashtable
    if ($null -eq $inputData -or $inputData.Count -ne 1 -or -not $inputData.ContainsKey('host') -or
        $inputData.host -isnot [string]) { throw 'Invalid request.' }
    $taskHost = $inputData.host
    $address = [Net.IPAddress]::Parse($taskHost)
    if ($address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $address.ToString() -cne $taskHost) { throw 'Invalid host.' }
    $octets = $address.GetAddressBytes()
    $privateHost = $octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
    if (-not $privateHost -and $taskHost -cne '127.0.0.1') { throw 'Invalid host.' }

    $identity = [Guid]::NewGuid().ToString('D')
    $now = [DateTimeOffset]::UtcNow
    $rootKey = [Security.Cryptography.RSA]::Create(2048)
    $rootRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        ('CN=Carebridge synthetic Wi-Fi root ' + $identity), $rootKey,
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $rootRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))
    $rootRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            ([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
             [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign), $true))
    $rootRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($rootRequest.PublicKey, $false))
    $rootCertificate = $rootRequest.CreateSelfSigned($now.AddMinutes(-1), $now.AddHours(24))

    $leafKey = [Security.Cryptography.RSA]::Create(2048)
    $leafRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        ('CN=Carebridge synthetic Wi-Fi server ' + $identity), $leafKey,
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $leafRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $leafRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            ([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
             [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment), $true))
    $usages = [Security.Cryptography.OidCollection]::new()
    $null = $usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $leafRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false))
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress($address)
    $leafRequest.CertificateExtensions.Add($san.Build())
    $leafRequest.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($leafRequest.PublicKey, $false))
    $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $serial[0] = $serial[0] -band 0x7f
    $serial[15] = $serial[15] -bor 1
    $leafCertificate = $leafRequest.Create($rootCertificate, $now.AddMinutes(-1), $now.AddHours(23), $serial)

    # Capture only the public root, then release its private signing objects
    # immediately after this single leaf has been signed. Never export its key.
    $rootPem = $rootCertificate.ExportCertificatePem()
    $rootDer = $rootCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    $rootCertificate.Dispose()
    $rootCertificate = $null
    $rootKey.Dispose()
    $rootKey = $null
    $rootRequest = $null

    $leafKeyBytes = $leafKey.ExportPkcs8PrivateKey()
    $report = [ordered]@{
        schema = 1
        purpose = 'synthetic-wifi-memory-certificate'
        cert = $leafCertificate.ExportCertificatePem()
        key = [Security.Cryptography.PemEncoding]::WriteString('PRIVATE KEY', $leafKeyBytes)
        ca = $rootPem
        publicCertificate = [Convert]::ToBase64String($rootDer)
        expiresAt = $leafCertificate.NotAfter.ToUniversalTime().ToString('O')
        fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rootDer)).ToLowerInvariant()
    }
    [Console]::Out.Write(($report | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.Write('SYNTHETIC_WIFI_CERTIFICATE_UNAVAILABLE')
    exit 1
} finally {
    if ($null -ne $leafKeyBytes) { [Array]::Clear($leafKeyBytes, 0, $leafKeyBytes.Length) }
    if ($null -ne $rootCertificate) { $rootCertificate.Dispose() }
    if ($null -ne $rootKey) { $rootKey.Dispose() }
    if ($null -ne $leafCertificate) { $leafCertificate.Dispose() }
    if ($null -ne $leafKey) { $leafKey.Dispose() }
    $report = $null
    # Managed strings and crypto-runtime internal copies cannot be promised to
    # be zeroized. Their lifetime is bounded by this short-lived child process.
}
