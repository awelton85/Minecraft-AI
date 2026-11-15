@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Minecraft-AI first-time setup

echo ==== Minecraft-AI first-time setup ====
echo.

rem ---- Node.js check (need >= 20)
where node >nul 2>nul
if errorlevel 1 goto :no_node
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 20 goto :old_node
echo Found Node.js %NODE_MAJOR%.x

echo.
echo ---- Installing bot dependencies (npm install) ----
call npm install
if errorlevel 1 goto :failed

echo.
echo ---- Setting up the Minecraft server (Paper + ViaVersion) ----
rem Extra arguments given to setup.bat are passed through, e.g.:  setup.bat --install-java --ram 6G
call npm run setup-server -- %*
if errorlevel 1 goto :failed

echo.
echo ==== Setup finished ====
echo   1. Start the server: double-click server\start-server.bat
echo   2. Start the bots:   double-click start-bots.bat
echo.
pause
exit /b 0

:no_node
echo Node.js was not found. Install the LTS version (20 or newer) from:
echo     https://nodejs.org/
echo Then close this window, open a new one and run setup.bat again.
echo.
pause
exit /b 1

:old_node
echo Node.js %NODE_MAJOR% is too old - version 20 or newer is required.
echo Download the current LTS from https://nodejs.org/
echo.
pause
exit /b 1

:failed
echo.
echo Setup failed - see the messages above.
echo.
pause
exit /b 1
