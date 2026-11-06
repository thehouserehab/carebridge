# All certificate-store operations and the observed owner are in-memory fakes.
param([string]$SourcePath,[string]$CertificatePath,[string]$NodePath,[string]$ReceiptPath,[string]$Scenario)
$ErrorActionPreference='Stop'
$script:events=[Collections.Generic.List[string]]::new()
$script:certificates=[Collections.Generic.List[object]]::new()
$public=[Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($CertificatePath))
$script:fakeOwner=[pscustomobject]@{Handle=1;HasExited=$false;StartTime=[DateTime]::Now;Path=$NodePath}
if($Scenario -eq 'expired'){$script:fakeOwner.StartTime=[DateTime]::Now.AddHours(-3)}
if($Scenario -eq 'unknown-exit-state'){$script:fakeOwner.HasExited=$null}
$script:fakeOwner | Add-Member ScriptMethod WaitForExit {
    param($Milliseconds)
    $script:events.Add('wait')
    if($Scenario -eq 'observe-error'){throw 'SYNTHETIC_OBSERVATION_FAILURE'}
    if($Scenario -eq 'unknown-wait-result'){return $null}
    return $true
}
$script:fakeOwner | Add-Member ScriptMethod Dispose {$script:events.Add('owner-disposed')}
function Get-Process {param([int]$Id) return $script:fakeOwner}
if($Scenario -eq 'existing'){$script:certificates.Add($public)}
$mockOpen=@'
function Open-Root([bool]$Writable) {
    $script:events.Add(('open:'+[string]$Writable))
    $store=[pscustomobject]@{Certificates=@($script:certificates.ToArray());Writable=$Writable}
    $store | Add-Member ScriptMethod Add {
        param($Certificate)
        if(-not $this.Writable){throw 'READ_ONLY'}
        $script:events.Add('add');$script:certificates.Add($Certificate)
        if($Scenario -eq 'partial-add-error'){throw 'SYNTHETIC_PARTIAL_ADD'}
        if($Scenario -eq 'exit-after-add'){$script:fakeOwner.HasExited=$true}
        if($Scenario -eq 'unknown-exit-after-add'){$script:fakeOwner.HasExited=$null}
        if($Scenario -eq 'owner-error-after-add') {
            $script:fakeOwner | Add-Member -MemberType ScriptProperty -Name HasExited -Value {throw 'SYNTHETIC_OWNER_READ_FAILURE'} -Force
        }
        if($Scenario -eq 'stop-during-add') {[IO.File]::WriteAllBytes($ReceiptPath+'.stop',[byte[]]::new(0))}
    }
    $store | Add-Member ScriptMethod Remove {
        param($Certificate)
        $script:events.Add('remove')
        if(-not $this.Writable -or $Scenario -eq 'remove-error'){throw 'SYNTHETIC_REMOVE_FAILURE'}
        $null=$script:certificates.Remove($Certificate)
    }
    $store | Add-Member ScriptMethod Dispose {$script:events.Add('store-disposed')}
    return $store
}
'@
$source=[IO.File]::ReadAllText($SourcePath)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SOURCE_PARSE_FAILED'}
$functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-Root'},$true))
if($functions.Count -ne 1){throw 'STORE_MOCK_NOT_UNIQUE'}
$extent=$functions[0].Extent
$source=$source.Remove($extent.StartOffset,$extent.EndOffset-$extent.StartOffset).Insert($extent.StartOffset,$mockOpen)
if($source -match 'X509Store|StoreLocation|\.Open\(\$flags\)'){throw 'NATIVE_STORE_OPERATION_REMAINS'}
$source=$source.Replace('function Write-Receipt([string]$State)', 'function Write-NativeReceipt([string]$State)')
function Write-Receipt([string]$State) {
    $script:events.Add(('receipt:'+$State))
    if(($Scenario -eq 'active-receipt-error' -and $State -eq 'active') -or
        ($Scenario -eq 'removed-receipt-error' -and $State -eq 'removed')){throw 'SYNTHETIC_RECEIPT_FAILURE'}
    Write-NativeReceipt $State
    if($State -eq 'prepared' -and $Scenario -eq 'unknown-exit-before-add') {$script:fakeOwner.HasExited=$null}
    if($State -eq 'prepared' -and $Scenario -eq 'owner-error-before-add') {
        $script:fakeOwner | Add-Member -MemberType ScriptProperty -Name HasExited -Value {throw 'SYNTHETIC_OWNER_READ_FAILURE'} -Force
    }
    if($Scenario -eq 'stop-before-add' -and $State -eq 'prepared') {
        [IO.File]::WriteAllBytes($ReceiptPath+'.stop',[byte[]]::new(0))
    }
}
$ending='if ($failed -or ($ownedAttempt -and -not $removed)) { exit 1 }'+"`n"+'exit 0'
if(-not $source.Replace("`r`n","`n").Contains($ending)){throw 'TERMINAL_CONTRACT_NOT_FOUND'}
$source=$source.Replace("`r`n","`n").Replace($ending,'$script:fixtureExitCode = [int]($failed -or ($ownedAttempt -and -not $removed))')
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($public.RawData)).ToLowerInvariant()
$ticks=$script:fakeOwner.StartTime.ToUniversalTime().Ticks.ToString()
if($Scenario -eq 'wrong-hash'){$hash='0'*64}
if($Scenario -eq 'pid-reuse'){$ticks=([long]$ticks-1).ToString()}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try{$sid=$identity.User.Value}finally{$identity.Dispose()}
$arguments=@{CertificatePath=$CertificatePath;ExpectedSha256=$hash;ExpectedThumbprint=$public.Thumbprint;
    OwnerPid=123;OwnerStartTimeUtcTicks=$ticks;NodeExecutablePath=$NodePath;ExpectedUserSid=$sid;ReceiptPath=$ReceiptPath}
if($Scenario -eq 'validate-only'){$arguments.ValidateOnly=$true}
& ([scriptblock]::Create($source)) @arguments
$state=$null
if([IO.File]::Exists($ReceiptPath)){$state=([IO.File]::ReadAllText($ReceiptPath)|ConvertFrom-Json).state}
[Console]::Out.WriteLine((@{fixture=$true;events=@($script:events.ToArray());remaining=$script:certificates.Count;receiptState=$state;code=$script:fixtureExitCode}|ConvertTo-Json -Compress))
$public.Dispose()
exit $script:fixtureExitCode
