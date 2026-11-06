# Test-only, memory-only TLS material. Never imports a certificate or writes a
# key/certificate file. The parent Node test owns and consumes the stdout pipe.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rsa = $null
$certificate = $null
$privateKeyBytes = $null
$report = $null
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported runtime.' }
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=Carebridge synthetic HTTPS test', $rsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            ([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
             [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment), $true))
    $usages = [Security.Cryptography.OidCollection]::new()
    $null = $usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add(
        [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false))
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    # An invented RFC1918 fixture address, not a user's device address.
    $san.AddIpAddress([Net.IPAddress]::Parse('10.231.9.10'))
    $request.CertificateExtensions.Add($san.Build())
    $now = [DateTimeOffset]::UtcNow
    $certificate = $request.CreateSelfSigned($now.AddMinutes(-1), $now.AddMinutes(30))
    $privateKeyBytes = $rsa.ExportPkcs8PrivateKey()
    $report = [ordered]@{
        schema = 1
        purpose = 'synthetic-memory-https-certificate'
        cert = $certificate.ExportCertificatePem()
        key = [Security.Cryptography.PemEncoding]::WriteString('PRIVATE KEY', $privateKeyBytes)
    }
    [Console]::Out.Write(($report | ConvertTo-Json -Compress))
} catch {
    # Do not serialize exceptions, certificate contents or private key material.
    [Console]::Error.Write('SYNTHETIC_HTTPS_CERTIFICATE_UNAVAILABLE')
    exit 1
} finally {
    if ($null -ne $privateKeyBytes) { [Array]::Clear($privateKeyBytes, 0, $privateKeyBytes.Length) }
    $report = $null
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $rsa) { $rsa.Dispose() }
    # Managed PEM/JSON strings cannot be guaranteed to be zeroized. They never
    # leave this short-lived process except through its private stdout pipe.
}
