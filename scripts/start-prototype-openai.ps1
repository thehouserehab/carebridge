param([string]$NodePath = 'node', [switch]$VerifyHome)
$ErrorActionPreference = 'Stop'
$aiKeyPointer = [IntPtr]::Zero
$aiSecureKey = $null
$aiProcessInfo = $null
$aiChildProcess = $null
try {
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'INTERACTIVE_TERMINAL_REQUIRED' }
    $aiScript = Join-Path $PSScriptRoot 'prototype-openai.mjs'
    if (-not (Test-Path -LiteralPath $aiScript -PathType Leaf)) { throw 'LAUNCHER_NOT_FOUND' }
    $aiNodeCommand = Get-Command $NodePath -CommandType Application -ErrorAction Stop | Select-Object -First 1
    # Validate optional browser tooling before requesting a secret.
    if ($VerifyHome) {
        $aiPlaywright = $env:PLAYWRIGHT_MODULE
        if (-not $aiPlaywright) { $aiPlaywright = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs' }
        $aiChrome = $env:STUDY_CHROMIUM_EXECUTABLE
        if (-not $aiChrome) { $aiChrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }
        foreach ($aiToolPath in @($aiPlaywright, $aiChrome)) {
            if (-not [IO.Path]::IsPathFullyQualified($aiToolPath) -or -not (Test-Path -LiteralPath $aiToolPath -PathType Leaf)) { throw 'BROWSER_CHECK_TOOL_NOT_FOUND' }
        }
    }
    Write-Host 'Carebridge 홈 AI - 실제 OpenAI 연결 / 가상 자료 전용'
    Write-Host '키는 파일에 저장하지 않습니다. 입력 문자는 표시되지 않습니다.'
    Write-Host '질문과 선택한 기록 요약에는 API 비용이 발생합니다. 실제 개인정보를 입력하지 마세요.'
    if ($VerifyHome) { Write-Host '입력 후 가상 질문 1회와 가상 기록 요약 1회를 자동 확인합니다.' }
    $aiSecureKey = Read-Host 'OpenAI API key' -AsSecureString
    $aiProcessInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $aiProcessInfo.FileName = $aiNodeCommand.Source
    $aiProcessInfo.UseShellExecute = $false
    $aiProcessInfo.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $aiProcessInfo.ArgumentList.Add($aiScript)
    foreach ($aiArgument in @('--confirm-synthetic-local', '--enable-external-ai', '--open')) { $aiProcessInfo.ArgumentList.Add($aiArgument) }
    if ($VerifyHome) {
        $aiProcessInfo.ArgumentList.Add('--verify-synthetic-home')
        $aiProcessInfo.EnvironmentVariables['PLAYWRIGHT_MODULE'] = $aiPlaywright
        $aiProcessInfo.EnvironmentVariables['STUDY_CHROMIUM_EXECUTABLE'] = $aiChrome
    }
    $aiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($aiSecureKey)
    $aiProcessInfo.EnvironmentVariables['CAREBRIDGE_OPENAI_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($aiKeyPointer)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($aiKeyPointer)
    $aiKeyPointer = [IntPtr]::Zero
    $aiSecureKey.Dispose()
    $aiSecureKey = $null
    $aiChildProcess = [System.Diagnostics.Process]::Start($aiProcessInfo)
    $aiProcessInfo.EnvironmentVariables.Remove('CAREBRIDGE_OPENAI_API_KEY')
    $aiChildProcess.WaitForExit()
    if ($aiChildProcess.ExitCode -ne 0) { Write-Host '실행을 완료하지 못했습니다. 키를 공유하지 말고 오류 안내만 확인해 주세요.' }
} catch {
    # Exception text can include environment data; display a fixed message only.
    Write-Host '실행기를 시작하지 못했습니다. PowerShell 7과 Node.js 24 설치 및 실행 권한을 확인하세요.'
} finally {
    if ($aiKeyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($aiKeyPointer) }
    if ($null -ne $aiSecureKey) { $aiSecureKey.Dispose() }
    if ($null -ne $aiProcessInfo) { $aiProcessInfo.EnvironmentVariables.Remove('CAREBRIDGE_OPENAI_API_KEY') }
    if ($null -ne $aiChildProcess -and $aiChildProcess.HasExited) { $aiChildProcess.Dispose() }
}
if (-not [Console]::IsInputRedirected) { [void](Read-Host '종료하려면 Enter를 누르세요') }
