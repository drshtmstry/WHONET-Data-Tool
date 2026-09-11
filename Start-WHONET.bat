@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to run WHONET Data Tool.
  echo Install the current LTS version from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
start "WHONET Data Tool Server" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:7890"
