@echo off
setlocal
chcp 65001 >nul
title Carebridge OpenAI Prototype
cd /d "%~dp0"
set "CAREBRIDGE_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%CAREBRIDGE_PWSH%" set "CAREBRIDGE_PWSH=pwsh.exe"
set "CAREBRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%CAREBRIDGE_NODE%" set "CAREBRIDGE_NODE=node"
"%CAREBRIDGE_PWSH%" -NoLogo -NoProfile -File "%~dp0scripts\start-prototype-openai.ps1" -NodePath "%CAREBRIDGE_NODE%"
if errorlevel 1 (
  echo Carebridge could not start. PowerShell 7 and Node.js 24 are required.
  pause
)
endlocal
