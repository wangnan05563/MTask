@echo off
setlocal
cd /d "%~dp0.."

REM MTask build script: install deps, typecheck, build server, build web, package exe.
REM This file is pure ASCII on purpose so cmd (ANSI codepage) parses it reliably.

REM Prefer the WorkBuddy managed Node (matches better-sqlite3 ABI).
set "MGNode=C:\Users\hspcadmin\.workbuddy\binaries\node\versions\22.22.2"
if exist "%MGNode%\node.exe" set "PATH=%MGNode%;%PATH%"

REM Use npmmirror so electron + electron-builder binaries can be downloaded.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo ============================================
echo  MTask Build
echo ============================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node or configure managed node.
    pause
    exit /b 1
)

REM [1/6] dependency check (npm workspaces installs node_modules at root)
echo [1/6] Check dependencies...
if not exist "node_modules" (
    echo   node_modules missing, running npm install...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
) else (
    echo   [OK] node_modules exists
)

REM [2/6] ensure electron binary is downloaded
echo [2/6] Check electron binary...
if not exist "node_modules\electron\dist\electron.exe" (
    echo   electron.exe missing, downloading...
    call node "node_modules\electron\install.js"
    if errorlevel 1 (
        echo [ERROR] electron binary download failed
        pause
        exit /b 1
    )
) else (
    echo   [OK] electron.exe exists
)

REM [3/6] typecheck server
echo [3/6] Typecheck server...
pushd server
call npm run typecheck
if errorlevel 1 (
    popd
    echo [ERROR] server typecheck failed
    pause
    exit /b 1
)
popd

REM [4/6] build server
echo [4/6] Build server...
pushd server
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] server build failed
    pause
    exit /b 1
)
popd

REM [5/6] build web
echo [5/6] Build web...
pushd web
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] web build failed
    pause
    exit /b 1
)
popd

REM [6/6] package electron exe.
REM Bump version first so each build gets a distinct version.
REM bump-version.js writes <major>.<minor>.<MMDD>.<seq>; both segments stay
REM within Windows' 0..65535 per-segment limit (a raw 8-digit date would overflow).
echo [6/6] Package electron exe...
node "scripts\bump-version.js"
if errorlevel 1 (
    echo [ERROR] version bump failed
    pause
    exit /b 1
)

REM Backup the dev-state (Node ABI) native binary first, then force a rebuild
REM for the Electron ABI. npmRebuild is off, so the rebuild must happen here.
REM Guard: abort early if better_sqlite3.node is locked by a running dev process.
REM A loaded native DLL cannot be deleted by electron-rebuild (EPERM on unlink).
set "BSQLITE_CHECK=node_modules\better-sqlite3\build\Release\better_sqlite3.node"
powershell -NoProfile -Command "if(Test-Path '%BSQLITE_CHECK%'){try{[IO.File]::Open('%BSQLITE_CHECK%','Open','ReadWrite','None').Close();'UNLOCKED'}catch{'LOCKED'}}else{'UNLOCKED'}" > "%TEMP%\mtask_bslock.txt" 2>nul
set /p "BSLOCK=" < "%TEMP%\mtask_bslock.txt"
del "%TEMP%\mtask_bslock.txt" >nul 2>nul
if /i not "%BSLOCK%"=="UNLOCKED" (
    echo [ERROR] better_sqlite3.node is locked by a running dev process.
    echo   Close the dev server and any running MTask app first, then rerun.
    echo   [WARN] version was bumped already but no artifact was produced this run.
    pause
    exit /b 1
)
REM Put the Electron-state binary in place BEFORE electron-builder packages node_modules.
REM The cached build\native\electron binary guarantees the Electron ABI (130) without a
REM C++ toolchain and without depending on an earlier build's win-unpacked output.
call scripts\native-switch.bat electron
if errorlevel 1 (
    echo [ERROR] failed to switch better-sqlite3 to Electron ABI.
    echo   Make sure build\native\electron\better_sqlite3.node exists. Recreate the
    echo   cache with:  scripts\native-switch.bat dev  then a prebuild-install download.
    pause
    exit /b 1
)

REM Clean up a stale unpack dir so electron-builder can unpack into a clean tree.
REM Without this EnsureEmptyDir fails when a leftover file is held open by Explorer/antivirus.
REM T00442: fall forward through release2..9 until an unlocked dir is found (antivirus may
REM hold handles on a freshly packed asar for minutes, so a single fallback is not enough).
REM
REM BUGFIX (build 0.1.0913.63 aborted with cmd error "unexpected token are"):
REM   1) the old "[ERROR] all release dirs (2-9) are locked." echo had UNESCAPED parens - inside
REM      a ( ... ) block cmd treats the ")" of "(2-9)" as the block terminator, so the following
REM      text became an unexpected token and the whole script aborted at parse time. Echo text
REM      inside a block must be paren-free (or use ^( ^) escapes).
REM   2) "endlocal & set OUTDIR=%OUTDIR%" expanded %OUTDIR% at BLOCK-PARSE time, i.e. the value
REM      set before the block ("release") - so a chosen fallback dir never propagated out.
REM Rewritten without setlocal/delayed expansion: "if defined" is evaluated at runtime, so the
REM loop below correctly sees the value assigned by the previous iteration.
REM T00528: stop any MTask.exe instances running from this project's release
REM dirs first - their open app.asar handle makes the cleanup below fail and
REM pushes every build into fallback dirs. Only project-release instances are
REM killed (installed copies are left alone).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='MTask.exe'\" | Where-Object { $_.ExecutablePath -like '*\26_MTask\release*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
set "OUTDIR=release"
if exist "release\win-unpacked" (
    powershell -NoProfile -Command "try{[IO.Directory]::Delete('%CD%\release\win-unpacked',$true);exit 0}catch{exit 1}" >nul 2>&1
    if errorlevel 1 (
        set "OUTDIR="
        for %%N in (2 3 4 5 6 7 8 9) do if not defined OUTDIR if not exist "release%%N\win-unpacked" set "OUTDIR=release%%N"
        if not defined OUTDIR (
            echo   [ERROR] all fallback release dirs 2-9 are still locked. Close apps using them or add an antivirus exclusion for this project folder, then rerun.
            pause
            exit /b 1
        )
    )
)
if not "%OUTDIR%"=="release" echo   [WARN] release\win-unpacked still in use, packaging into %OUTDIR% to bypass the lock.
REM disable publish so CI-detected electron-builder does not try to push to GitHub
REM (would otherwise fail with "GH_TOKEN is not set" after the artifact is fully built)
call npx electron-builder --win --config.directories.output=%OUTDIR% --publish=never
if errorlevel 1 (
    echo [ERROR] electron-builder failed
    pause
    exit /b 1
)

REM After packaging, restore the dev-state binary so the workspace stays dev-ready.
call scripts\native-switch.bat dev
if errorlevel 1 (
    echo [ERROR] failed to restore dev-state better-sqlite3.
    echo   Run:  scripts\native-switch.bat dev
    pause
    exit /b 1
)

echo.
REM T00528: after packaging, remove the win-unpacked tree so the release dir
REM only holds the setup exe - the unpacked copy is what users run for quick
REM tests and what locks the asar, making the next cleanup fail. Failure here
REM is non-fatal (a warning is printed and the tree is left in place).
if exist "%OUTDIR%\win-unpacked" (
    powershell -NoProfile -Command "try{[IO.Directory]::Delete('%CD%\%OUTDIR%\win-unpacked',$true);exit 0}catch{exit 1}" >nul 2>&1
    if errorlevel 1 (
        echo   [WARN] could not remove %OUTDIR%\win-unpacked - a process still holds it. Delete it manually before the next build.
    ) else (
        echo   [OK] removed %OUTDIR%\win-unpacked - release dir now holds only the installer.
    )
)

echo ============================================
echo  Build done
echo ============================================
echo  server:  server\dist
echo  web:     web\dist
echo  exe:     release\
REM Print the actual version used this run so each artifact can be traced back.
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APPVER=%%v"
if defined APPVER echo  version: %APPVER%
echo.
pause
exit /b 0
