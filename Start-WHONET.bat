@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to run WHONET Data Tool locally.
  echo Install the current LTS version from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

start "WHONET Data Tool Server" /min cmd /c "npm start"
