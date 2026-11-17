param([string]$NodePath = 'node')
$ErrorActionPreference = 'Stop'
if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    throw '직접 사용하는 터미널에서 실행하세요. 키를 명령 인수나 파일로 전달하지 마세요.'
}
$aiScript = Join-Path $PSScriptRoot 'local-ai-api.mjs'
if (-not (Test-Path -LiteralPath $aiScript -PathType Leaf)) { throw 'AI 실행기 파일을 찾을 수 없습니다.' }
$aiNodeCommand = Get-Command $NodePath -CommandType Application -ErrorAction Stop | Select-Object -First 1
Write-Host 'Carebridge OpenAI 키를 입력하세요. 입력 문자는 표시되지 않습니다.'
Write-Host '가상 자료 전용이며 AI 버튼을 누를 때 외부 API 비용이 발생할 수 있습니다.'
$aiSecureKey = Read-Host 'OpenAI API key' -AsSecureString
$aiProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
$aiProcessInfo.FileName = $aiNodeCommand.Source
$aiProcessInfo.UseShellExecute = $false
$aiProcessInfo.Arguments = '"' + $aiScript + '" --confirm-synthetic-local --enable-external-ai'
$aiProcessInfo.RedirectStandardInput = $false
$aiProcessInfo.RedirectStandardOutput = $false
$aiProcessInfo.RedirectStandardError = $false
$aiKeyPointer = [IntPtr]::Zero
try {
    $aiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($aiSecureKey)
    $aiProcessInfo.EnvironmentVariables['CAREBRIDGE_OPENAI_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($aiKeyPointer)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($aiKeyPointer)
    $aiKeyPointer = [IntPtr]::Zero
    $aiSecureKey.Dispose()
    $aiChildProcess = [System.Diagnostics.Process]::Start($aiProcessInfo)
    $aiProcessInfo.EnvironmentVariables.Remove('CAREBRIDGE_OPENAI_API_KEY')
    $aiChildProcess.WaitForExit()
    if ($aiChildProcess.ExitCode -ne 0) { Write-Host '실행 오류가 발생했습니다. 키 값을 공유하지 말고 위 상태 문구만 확인하세요.' }
} finally {
    if ($aiKeyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($aiKeyPointer) }
    if ($null -ne $aiSecureKey) { $aiSecureKey.Dispose() }
    $aiProcessInfo.EnvironmentVariables.Remove('CAREBRIDGE_OPENAI_API_KEY')
    if ($null -ne $aiChildProcess -and $aiChildProcess.HasExited) { $aiChildProcess.Dispose() }
}
