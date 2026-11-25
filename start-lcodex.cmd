@echo off
setlocal
if not exist "%~dp0.local\releases\win-unpacked\lcodex.exe" (
  echo Build the local candidate first: npm run package:win
  pause
  exit /b 1
)
if not exist "%~dp0.local\desktop" mkdir "%~dp0.local\desktop"
start "" "%~dp0.local\releases\win-unpacked\lcodex.exe" "--user-data-dir=%~dp0.local\desktop"
