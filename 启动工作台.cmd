@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" launch.mjs
  if errorlevel 1 pause
  exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Folio needs Node.js 22.2 or later. Install Node.js and try again.
  pause
  exit /b 1
)
node launch.mjs
if errorlevel 1 pause
