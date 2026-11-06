# Fresh OS-temporary, synthetic receipt only. Does not discover/use E storage,
# DPAPI keys, credentials, operating receipts or certificate/trust stores.
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$report=[ordered]@{schema=1;purpose='synthetic-private-receipt-sharing';pwshMajor=$PSVersionTable.PSVersion.Major;completed=$false;checks=[ordered]@{}}
$holder=$null; $script:probeLive=$false; $file=$null; $stage='runtime'
function Check([string]$Name,[bool]$Passed) { $report.checks[$Name]=$Passed }
function Sharing-Code($Failure) {
    $exception=$Failure.Exception
    while($null -ne $exception.InnerException){$exception=$exception.InnerException}
    return ($exception.HResult -band 0xffff)
}
function Set-PrivateFixtureAcl([string]$Target,[bool]$Directory) {
    $security=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $security.SetOwner($script:operatorSid); $security.SetAccessRuleProtection($true,$false)
    $inheritance=if($Directory){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($sid in $script:policy.PrincipalSids){
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $Target -AclObject $security
}
function Write-Fixture([byte[]]$Bytes) {
    $stream=[IO.File]::Open($script:file,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($Bytes,0,$Bytes.Length)}finally{$stream.Dispose()}
}
function Assert-Released {
    $stream=[IO.File]::Open($script:file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $stream.Dispose()
}
function Rejects-And-Releases([string]$Name,[byte[]]$Bytes) {
    Write-Fixture $Bytes; $rejected=$false
    try{$null=Read-CarebridgePrivateReceipt $script:file $script:policy}catch{$rejected=$true}
    Check $Name $rejected
    $released=$false; try{Assert-Released;$released=$true}catch{}
    Check ($Name+'-released') $released
}
try {
    if(-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7){throw 'FIXTURE_RUNTIME'}
    . (Join-Path $PSScriptRoot '../../scripts/beta-storage-policy.ps1')
    $stage='root'
    if(-not [IO.Path]::IsPathFullyQualified($Root) -or
       [IO.Path]::GetFileName($Root) -cnotmatch '^carebridge-private-receipt-[A-Za-z0-9]+$'){throw 'FIXTURE_ROOT'}
    $Root=[IO.Path]::GetFullPath($Root)
    Assert-CarebridgeDirectoryChain $Root
    $rootItem=Get-Item -LiteralPath $Root -Force
    if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
       @(Get-ChildItem -LiteralPath $Root -Force).Count -ne 0){throw 'FIXTURE_ROOT'}
    $script:operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $script:policy=[pscustomobject]@{OperatorSid=$script:operatorSid;PrincipalSids=@($script:operatorSid.Value,'S-1-5-18','S-1-5-32-544')}
    $stage='root-acl'
    Set-PrivateFixtureAcl $Root $true; Assert-CarebridgePrivateAcl $Root $script:policy $true
    $script:file=Join-Path $Root 'receipt.json'
    $created=[IO.File]::Open($script:file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created.Dispose()
    $stage='file-acl'
    Set-PrivateFixtureAcl $script:file $false; Assert-CarebridgePrivateAcl $script:file $script:policy $true $true
    $valid=[Text.Encoding]::UTF8.GetBytes('{"schema":1,"purpose":"synthetic-test"}')
    Write-Fixture $valid
    $stage='held-read'
    # First actual Windows sharing test: another legitimate read owner already
    # holds FileShare.Read. No thread timing, mocks or retries are involved.
    $holder=[IO.File]::Open($script:file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $shared=$false; $sharingViolation=$false
    try{$value=Read-CarebridgePrivateReceipt $script:file $script:policy;$shared=($value.schema -ceq 1)}
    catch{$sharingViolation=((Sharing-Code $_) -eq 32)}
    finally{$holder.Dispose();$holder=$null}
    Check 'held-read-allows-helper' $shared
    Check 'baseline-failure-is-sharing-violation' ($shared -or $sharingViolation)
    $report.sharingViolationCode=if($sharingViolation){32}else{0}
    Assert-Released; Check 'held-read-cleanup' $true

    # The wrapper delegates to the original JSON converter, probing only while
    # the REAL helper still owns its FileStream. Parsing is never replaced.
    $script:originalConverter=${function:ConvertFrom-CarebridgeJson}
    function ConvertFrom-CarebridgeJson([string]$Json) {
        if($script:probeLive){
            $second=$null; $readAllowed=$false
            try{$second=[IO.File]::Open($script:file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$readAllowed=$true}
            catch{}finally{if($null -ne $second){$second.Dispose()}}
            Check 'helper-allows-second-read' $readAllowed
            $writer=$null; $writeDenied=$false
            try{$writer=[IO.File]::Open($script:file,[IO.FileMode]::Open,[IO.FileAccess]::Write,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))}
            catch{$writeDenied=((Sharing-Code $_) -eq 32)}finally{if($null -ne $writer){$writer.Dispose()}}
            Check 'helper-denies-write' $writeDenied
            $deleteDenied=$false
            try{[IO.File]::Delete($script:file)}catch{$deleteDenied=((Sharing-Code $_) -eq 32)}
            Check 'helper-denies-delete' $deleteDenied
        }
        & $script:originalConverter $Json
    }
    $script:probeLive=$true
    $stage='live-read'
    try{$value=Read-CarebridgePrivateReceipt $script:file $script:policy;Check 'valid-json' ($value.schema -ceq 1)}finally{$script:probeLive=$false}
    Assert-Released; Check 'success-releases-handle' $true
    Check 'protected-read-preserves-bytes' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:file)) -ceq [Convert]::ToBase64String($valid))
    $stage='invalid-content'
    Rejects-And-Releases 'malformed-json' ([Text.Encoding]::UTF8.GetBytes('{"schema":'))
    Rejects-And-Releases 'invalid-utf8' ([byte[]]@(0xc3,0x28))
    Rejects-And-Releases 'empty' ([byte[]]@())
    Rejects-And-Releases 'undersize' ([byte[]]@(120))
    Rejects-And-Releases 'oversize' ([Text.Encoding]::UTF8.GetBytes(('{}'+(' '*8191))))
    foreach($length in @(2,8192)){
        $stage='valid-size'
        Write-Fixture ([Text.Encoding]::UTF8.GetBytes(('{}'+(' '*($length-2)))))
        $null=Read-CarebridgePrivateReceipt $script:file $script:policy;Assert-Released
        Check ('size-'+$length+'-accepted-released') $true
    }
    Write-Fixture $valid
    $stage='invalid-acl'
    # Check a wrong expected ACL policy against the real, unchanged private
    # file. This does NOT claim to test actual file ACL tampering: this Windows
    # environment denied subsequent Set-Acl attempts in the earlier fixture.
    $wrongPolicy=[pscustomobject]@{OperatorSid=$script:operatorSid;PrincipalSids=@($script:operatorSid.Value,'S-1-5-18','S-1-5-32-545')}
    $aclDenied=$false;try{$null=Read-CarebridgePrivateReceipt $script:file $wrongPolicy}catch{$aclDenied=$true}
    Check 'wrong-expected-acl-policy-rejected' $aclDenied;Assert-Released;Check 'acl-failure-releases-handle' $true
    Assert-CarebridgePrivateAcl $script:file $script:policy $true $true
    $stage='delete'
    [IO.File]::Delete($script:file);Check 'delete-after-close' (-not [IO.File]::Exists($script:file))
    $report.completed=$true
} catch {
    Check 'fixture-completed-without-setup-or-cleanup-error' $false
    $report.failure=[ordered]@{stage=$stage;line=[int]$_.InvocationInfo.ScriptLineNumber;code=[int](Sharing-Code $_)}
} finally {
    if($null -ne $holder){$holder.Dispose()}
    # The Node owner waits for actual process exit AND close before validating
    # directory identity and deleting only its exact fixture files/directory.
    [Console]::Write(($report | ConvertTo-Json -Depth 5 -Compress))
}
if(-not $report.completed -or @($report.checks.Values | Where-Object {$_ -ne $true}).Count -gt 0){exit 1}
