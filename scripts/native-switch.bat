@echo off
rem MTask better-sqlite3 native ABI switcher.
rem Usage: native-switch.bat dev|electron
rem Copies the cached <ABI>.node into node_modules so the loaded module matches
rem the current Node / Electron runtime WITHOUT needing a C++ toolchain.
rem Cache lives under build\native\: dev = Node ABI(127), electron = Electron ABI(130).
setlocal
set "MODE=%~1"
if /i "%MODE%"=="dev" goto valid
if /i "%MODE%"=="electron" goto valid
echo [ERROR] usage: native-switch.bat dev^|electron
exit /b 1
:valid
set "SRC=%~dp0..\build\native\%MODE%\better_sqlite3.node"
set "DST=%~dp0..\node_modules\better-sqlite3\build\Release\better_sqlite3.node"
if not exist "%SRC%" (
    echo [ERROR] cache missing: %SRC%
    exit /b 1
)
if not exist "%~dp0..\node_modules\better-sqlite3\build\Release" mkdir "%~dp0..\node_modules\better-sqlite3\build\Release" 2>nul
copy /Y "%SRC%" "%DST%" >nul
if errorlevel 1 (
    echo [ERROR] copy failed. The binary may be locked by a running MTask / dev process.
    echo   Close it and rerun.
    exit /b 1
)
echo [OK] better-sqlite3 switched to %MODE% from cache
exit /b 0