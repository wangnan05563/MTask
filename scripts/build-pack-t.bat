@echo off
setlocal
cd /d "%~dp0.."

REM MTask build script: install deps, typecheck, build server, build web, package exe.
REM This file is pure ASCII on purpose so cmd (ANSI codepage) parses it reliably.

REM Prefer the WorkBuddy managed Node - its ABI matches build\native\dev (see T02616 below).
REM T02616: this used to be one hard-coded version dir (22.22.2 here, 22.22.2-3 in the twin).
REM Both directories are gone, "if exist" judged false, the PATH override silently stopped
REM happening and every build ran on whatever node sat on PATH - a different
REM NODE_MODULE_VERSION than the dev ABI cache, with no signal at all. Resolution is now by
REM availability: the "current" pointer file first, then the highest version dir that really
REM has node.exe. MTASK_MG_NODE_ROOT overrides the root (the verification gate points it at a
REM fixture); no version is ever pinned by name.
if not defined MTASK_MG_NODE_ROOT set "MTASK_MG_NODE_ROOT=C:\Users\hspcadmin\.workbuddy\binaries\node\versions"
set "MGNode="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\resolve-managed-node.ps1"`) do set "MGNode=%%D"
if defined MGNode set "PATH=%MGNode%;%PATH%"

REM Use npmmirror so electron + electron-builder binaries can be downloaded.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo ============================================
echo  MTask Build
echo ============================================
echo.

REM T02616: say out loud which interpreter this build runs on. A missing managed node must
REM show up in the log instead of being a silent PATH fallback.
if defined MGNode (
    echo   managed node: %MGNode%
) else (
    echo   [WARN] no usable managed node under %MTASK_MG_NODE_ROOT%
    echo   [WARN] this build runs on the node already on PATH - native module ABI is not guaranteed
)

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node or configure managed node.
    pause
    exit /b 1
)

REM T02616: record node version + NODE_MODULE_VERSION + which exe won the PATH lookup, then
REM print the ABI picture read from the native binaries themselves (never from constants).
REM The hint is advisory: its exit code is deliberately not checked.
set "NODEEXE="
for /f "usebackq delims=" %%N in (`where node 2^>nul`) do if not defined NODEEXE set "NODEEXE=%%N"
for /f "usebackq delims=" %%V in (`node -p "process.version + ' ABI ' + process.versions.modules"`) do set "NODEVER=%%V"
echo   [INFO] build interpreter: %NODEVER%   exe=%NODEEXE%
node "scripts\lib\abi-hint.mjs"

REM [1/7] dependency check (npm workspaces installs node_modules at root)
echo [1/7] Check dependencies...
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

REM [2/7] ensure electron binary is downloaded
echo [2/7] Check electron binary...
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

REM [3/7] HEAD self-consistency precheck (T02355).
REM The worktree is HEAD plus uncommitted WIP of concurrent sessions, so a green worktree
REM typecheck does NOT prove the commit can be rebuilt. One shared implementation with
REM the Node packing script step 3 and scripts/dist.js: scripts/lib/head-precheck.mjs.
REM COMMIT RULE (T02617): the index of this repo often already holds OTHER sessions' staged
REM   files, including a stale copy of these four release entries. A plain "git commit"
REM   without path arguments commits that stale copy and silently removes the precheck call
REM   above, while the worktree still looks green. Always commit with explicit paths:
REM     git commit -- scripts/<pack-entry> scripts/lib/head-precheck.mjs
REM   The step below self-checks the call line in three faces (worktree / HEAD / index)
REM   and aborts before any build step if one of them lost it.
echo [3/7] HEAD self-consistency precheck...
if /i "%MTASK_SKIP_HEAD_CHECK%"=="1" echo   [WARN] MTASK_SKIP_HEAD_CHECK is set - precheck not run, treat the artifact as an unreproducible temp build.
node "scripts\lib\head-precheck.mjs" %*
if errorlevel 1 (
    echo [ERROR] HEAD is not self-consistent. Packaging aborted before any build step.
    echo   Commit the missing definition first, or set MTASK_SKIP_HEAD_CHECK=1 for a temp build.
    pause
    exit /b 1
)
if /i "%MTASK_BUILD_STOP_AFTER_PRECHECK%"=="1" (
    echo   Step [3/7] finished. Stop-after-precheck requested, build steps not entered.
    exit /b 0
)

REM [4/7] typecheck server
echo [4/7] Typecheck server...
pushd server
call npm run typecheck
if errorlevel 1 (
    popd
    echo [ERROR] server typecheck failed
    pause
    exit /b 1
)
popd

REM [5/7] build server
echo [5/7] Build server...
pushd server
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] server build failed
    pause
    exit /b 1
)
popd

REM [6/7] build web
echo [6/7] Build web...
pushd web
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] web build failed
    pause
    exit /b 1
)
popd

REM [7/7] package electron exe.
REM T03731: check the native module BEFORE bumping the version. The old order bumped first and only
REM then aborted on a "locked" probe, so every failed run left package.json / electron\package.json /
REM package-lock.json bumped with no artifact behind them - noise that later reads like someone's WIP.
REM The old probe was also unsound: it opened the file with FileShare.None and passed the verdict
REM through a shared %TEMP% file read with "set /p". Any PowerShell hiccup, or a concurrent build
REM touching the same temp file, left the variable empty and the empty value was judged LOCKED.
REM The check now lives in scripts\lib\abi-cli.mjs: real write open, bounded retries, holder PIDs.
echo [7/7] Preflight native module...
node "scripts\lib\abi-cli.mjs" probe
if errorlevel 1 (
    echo [ERROR] native module preflight failed - nothing was built and the version is unchanged.
    pause
    exit /b 1
)

REM Bump version first so each build gets a distinct version.
REM bump-version.js writes <major>.<minor>.<MMDD>.<seq>; both segments stay
REM within Windows' 0..65535 per-segment limit (a raw 8-digit date would overflow).
REM It also snapshots the three version files first, so a failed run can put them back byte for byte.
echo [7/7] Package electron exe...
node "scripts\bump-version.js"
if errorlevel 1 (
    echo [ERROR] version bump failed
    pause
    exit /b 1
)

REM Put the Electron-state binary in place BEFORE electron-builder packages node_modules.
REM The cached build\native\electron binary guarantees the Electron ABI without a C++ toolchain.
REM abi-cli switch snapshots the workspace binary and falls back to a rename takeover when another
REM process holds it, so a running dev server no longer has to be closed by hand.
node "scripts\lib\abi-cli.mjs" switch electron
if errorlevel 1 (
    echo [ERROR] failed to switch better_sqlite3 to Electron ABI.
    node "scripts\bump-version.js" --restore
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
powershell -NoProfile -Command "$root=[IO.Path]::GetFullPath('%~dp0..'); Get-CimInstance Win32_Process -Filter \"Name='MTask.exe'\" | Where-Object { $_.ExecutablePath -like ($root + '\release*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
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
REM T03731: inject the version the same way the two Node entries (scriptsdist.js and the
REM mjs entry under scripts) already do.
REM The version scheme is <major>.<minor>.<MMDD>.<seq> - 4 segments, because each Windows
REM file-version segment must stay <= 65535 - so it is NOT valid semver. Left to itself,
REM electron-builder normalizes package.json through semver and the installer comes out named
REM "MTask Setup 0.1.110-1.235.exe" for version 0.1.1101.235. That is not cosmetic:
REM scriptspublish-oneclick.ps1 step [3] derives the published version FROM THE FILENAME, so
REM the release tag stops matching the version the installed app reports. buildVersion is
REM injected from package.json at runtime, so it cannot drift from what bump-version.js wrote.
set "APPVER="
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "APPVER=%%V"
if not defined APPVER (
    echo [ERROR] could not read the version from package.json - aborting before packaging.
    node "scripts\lib\abi-cli.mjs" restore
    node "scripts\bump-version.js" --restore
    pause
    exit /b 1
)
REM disable publish so CI-detected electron-builder does not try to push to GitHub
REM (would otherwise fail with "GH_TOKEN is not set" after the artifact is fully built)
call npx electron-builder --win -c.buildVersion=%APPVER% --config.directories.output=%OUTDIR% --publish=never
if errorlevel 1 (
    echo [ERROR] electron-builder failed
    node "scripts\lib\abi-cli.mjs" restore
    node "scripts\bump-version.js" --restore
    pause
    exit /b 1
)

REM After packaging, restore the dev-state binary so the workspace stays dev-ready.
REM abi-cli restore replays the snapshot byte for byte and verifies the sha256; a failed build
REM therefore cannot leave the workspace on the Electron ABI (which breaks node server\dist).
node "scripts\lib\abi-cli.mjs" restore
if errorlevel 1 (
    echo [ERROR] failed to restore dev-state better-sqlite3.
    node "scripts\bump-version.js" --restore
    echo   Run:  scripts\native-switch.bat dev
    pause
    exit /b 1
)
REM Installer produced and ABI restored: this bump is final, drop the rollback snapshot.
node "scripts\bump-version.js" --discard

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
