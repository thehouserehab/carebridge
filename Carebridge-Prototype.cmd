@echo off
setlocal
chcp 65001 >nul
title Carebridge Prototype
cd /d "%~dp0"
set "CAREBRIDGE_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "CAREBRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%CAREBRIDGE_NODE%" scripts\prototype.mjs --confirm-synthetic-local --open
if errorlevel 1 (
  echo Carebridge could not start. See the message above.
  pause
)
endlocal
