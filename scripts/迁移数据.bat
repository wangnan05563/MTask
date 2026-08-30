@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

REM Migrate dev DB snapshot into the packaged app UserData dir.
REM Pure ASCII on purpose so cmd parses it under any codepage.

set "ELEC=node_modules\electron\dist\electron.exe"
if not exist "%ELEC%" (
    echo [ERROR] electron binary not found. Install dependencies first.
    pause
    exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
echo Migrating dev data to packaged app UserData...
call "%ELEC%" "scripts\migrate-data.js"
if errorlevel 1 (
    echo.
    echo [ERROR] Migration failed.
    pause
    exit /b 1
)

echo.
echo Done. Dev data has been copied to the packaged app.
pause
exit /b 0