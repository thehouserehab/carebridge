# Read-only ACL validation of an exact owned synthetic session. No ACL repair.
param([string]$Base,[string]$RunId)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
    . (Join-Path $PSScriptRoot 'beta-storage-policy.ps1')
    $policy=Get-CarebridgeStoragePolicy $Base; Assert-CarebridgeStorageReceipt $policy
    if($RunId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'Invalid session.'}
    $root=Join-Path (Join-Path $policy.PrivateRoot 'checks') ('postgres-check-'+$RunId)
    Assert-CarebridgePrivateAcl $root $policy
    $receipt=Read-CarebridgePrivateReceipt (Join-Path $root '.carebridge-check.json') $policy
    if((($receipt.Keys | Sort-Object)-join ',') -cne 'purpose,root,runId,schema' -or $receipt.schema -cne 1 -or
       $receipt.purpose -cne 'synthetic-native-e-postgres' -or $receipt.runId -cne $RunId -or $receipt.root -cne $root){throw 'Invalid session.'}
    foreach($name in @('source','source-media')) {Assert-CarebridgePrivateAcl (Join-Path $root $name) $policy}
    foreach($name in @('postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf','PG_VERSION')) {
        Assert-CarebridgePrivateAcl (Join-Path (Join-Path $root 'source') $name) $policy $false $true
    }
    foreach($name in @('.carebridge-resumable-session.json','.carebridge-resumable-closed.json')) {
        $path=Join-Path $root $name
        if(Test-Path -LiteralPath $path){Assert-CarebridgePrivateAcl $path $policy $false $true}
    }
    $tls=Join-Path $root 'tls'
    if(Test-Path -LiteralPath $tls) {
        Assert-CarebridgePrivateAcl $tls $policy
        foreach($name in @('good.crt','good.key','.carebridge-tls-fixture.json')) {Assert-CarebridgePrivateAcl (Join-Path $tls $name) $policy $false $true}
    }
    [Console]::Write('{"verified":true}')
}catch{[Console]::Error.Write('SYNTHETIC_SESSION_STORAGE_UNAVAILABLE');exit 1}
