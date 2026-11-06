[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [Parameter(Mandatory = $true)][ValidateSet('close', 'throw', 'hold')][string]$Mode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/postgres-prepare-lock.ps1')
$lock = Open-CarebridgePostgresPrepareLock -Path $LockPath
try {
    [Console]::Out.WriteLine('LOCK_ACQUIRED')
    [Console]::Out.Flush()
    if ($Mode -eq 'throw') { throw 'Intentional lock fixture failure.' }
    if ($Mode -eq 'hold') {
        if ([Console]::In.ReadLine() -ne 'release') { throw 'Fixture release was not received.' }
    }
} finally {
    $lock.Dispose()
}
