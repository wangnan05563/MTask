@echo off
rem ============================================================
rem  MTask build & package (T01496)
rem  Steps:
rem    1) Release the native-module lock: kill repo-dev electron.exe
rem       so better_sqlite3.node is not memory-mapped during packaging.
rem       NOTE: this does NOT touch the installed "MTask.exe" (the user's
rem       running desktop app). Stopping that is handled by
rem       electron/nsis-kill-process.nsh at INSTALL time, not build time.
rem    2) Build server (tsc -> server/dist) and web (vite -> web/dist).
rem    3) Package with electron-builder --win -> release\MTask Setup <ver>.exe
rem  ASCII-only messages to avoid console codepage issues.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo [1/3] Release native lock: kill repo-dev electron.exe ...
taskkill /F /IM electron.exe >nul 2>&1
if errorlevel 1 (echo       no repo-dev electron.exe running - ok)

echo [2/3] Build server and web ...
call npm run build:server
if errorlevel 1 goto :fail
call npm run build:web
if errorlevel 1 goto :fail

echo [3/3] Package installer (electron-builder --win) ...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo DONE. Installer(s) under release\ :
dir /b "%~dp0release\*.exe" 2>nul
endlocal
exit /b 0

:fail
echo.
echo FAILED - see the output above. No installer produced.
endlocal
exit /b 1
