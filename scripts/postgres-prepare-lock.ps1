# The caller validates the private runtime directory before acquiring this lock.
# CreateNew rejects existing locks; FileShare.None excludes other preparers.
# The OS deletes this exact file when its handle closes, including process death.
# Do not replace this with a path deletion after Dispose: another owner could
# create its lock between closing this handle and deleting that path.
function Open-CarebridgePostgresPrepareLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1,
        [IO.FileOptions]::DeleteOnClose)
}
