@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. See personal\README.md for setup.
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" personal/main.cjs
