@echo off
setlocal
chcp 65001 >nul
title Player Bridge Server
cd /d "%~dp0"
set PORT=8124
set INGEST_KEY=zon_2026_secret_7aX9LpQ2m

echo [INFO] checking port %PORT%...
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo [ERROR] Port %PORT% is already in use.
  echo [HINT] Close old node process or change PORT value in this file.
  echo.
)

:run
echo [INFO] starting site-server.js on port %PORT%...
node site-server.js
set ERR=%ERRORLEVEL%
echo.
echo [INFO] site-server.js stopped (code %ERR%).
echo [INFO] Press any key to retry, or close this window to exit.
pause >nul
goto run