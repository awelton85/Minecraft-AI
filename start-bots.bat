@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Minecraft-AI bots

rem ---- Node.js check (need >= 20)
where node >nul 2>nul
if errorlevel 1 goto :no_node
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 20 goto :old_node

rem ---- Dependencies
if exist "node_modules\" goto :run
echo node_modules not found - running npm install ...
call npm install
if errorlevel 1 goto :npm_failed

:run
echo.
echo Starting bots (node src/index.js) ...
node src/index.js
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto :clean_exit
echo.
echo [%date% %time%] Bots stopped with exit code %EXIT_CODE%. Restarting in 5 seconds ... (Ctrl+C to stop)
timeout /t 5 /nobreak >nul
goto :run

:clean_exit
echo.
echo Bots exited normally.
pause
exit /b 0

:no_node
echo.
echo Node.js was not found. Install the LTS version (20 or newer) from:
echo     https://nodejs.org/
echo Then close this window, open a new one and run start-bots.bat again.
echo.
pause
exit /b 1

:old_node
echo.
echo Node.js %NODE_MAJOR% is too old - version 20 or newer is required.
echo Download the current LTS from https://nodejs.org/
echo.
pause
exit /b 1

:npm_failed
echo.
echo npm install failed - see the messages above.
echo.
pause
exit /b 1
