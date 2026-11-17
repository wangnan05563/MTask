@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo  MTask One-Click Publish
echo ============================================
echo.

rem ------------------------------------------------------------
rem  Thin ASCII launcher with preflight checks. The real pipeline
rem  (build -> locate artifact -> release notes -> skill zip -> GitHub
rem  Release) lives in publish-oneclick.ps1, matching AirMirror's
rem  "launcher + PowerShell orchestrator" split.
rem
rem  Preflight items mirror the AirMirror one-click launcher:
rem    0) load GH_TOKEN/GITHUB_TOKEN from .env (process env wins,
rem       quotes stripped, token never echoed)
rem    1) git present
rem    2) PowerShell present
rem    3) python present (MTask release chain is python-driven;
rem       publish-oneclick.ps1 also resolves managed python)
rem  Then: pass args through, check exit code, NO_PAUSE opt-out.
rem
rem  Pure ASCII on purpose: with chcp 65001 the console is UTF-8,
rem  and ASCII echo lines never fall victim to codepage drift.
rem ------------------------------------------------------------

set "ROOT=%~dp0.."
set "ENV_FILE=%ROOT%\.env"
set "PUBLISH_PS=%~dp0publish-oneclick.ps1"

rem --- [0] Load GitHub token from .env (process env wins; never echo) ---
if not defined GH_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i /b "GH_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GH_TOKEN=%%b"
)
if not defined GITHUB_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i /b "GITHUB_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GITHUB_TOKEN=%%b"
)
if defined GH_TOKEN set "GH_TOKEN=!GH_TOKEN:"=!"
if defined GITHUB_TOKEN set "GITHUB_TOKEN=!GITHUB_TOKEN:"=!"
if defined GH_TOKEN (
    echo [OK]   GH_TOKEN available
) else (
    if defined GITHUB_TOKEN (
        echo [OK]   GITHUB_TOKEN available
    ) else (
        echo [WARN] No GH_TOKEN/GITHUB_TOKEN in env or .env - publish will fall back to the git credential helper.
    )
)

rem --- [1] Preflight: git ---
where git >nul 2>nul
if errorlevel 1 (
    echo [FAIL] git not found. Install Git for Windows and add it to PATH.
    goto :fail
)
for /f "tokens=*" %%v in ('git --version 2^>nul') do echo [OK]   %%v

rem --- [2] Preflight: PowerShell (runs publish-oneclick.ps1) ---
where powershell >nul 2>nul
if errorlevel 1 (
    echo [FAIL] powershell not found; cannot run publish-oneclick.ps1.
    goto :fail
)
echo [OK]   PowerShell available

rem --- [3] Preflight: python (drives publish-release.py / gen-release-notes.py / pack-skill.py) ---
where python >nul 2>nul
if errorlevel 1 (
    echo [WARN] python not on PATH; publish-oneclick.ps1 will resolve the managed python.
) else (
    for /f "tokens=*" %%v in ('python --version 2^>nul') do echo [OK]   %%v
)

rem --- Local sandbox: let electron-builder clean release dirs (safe-delete shim) ---
if not defined CODEBUDDY_SAFE_DELETE_ENABLED set "CODEBUDDY_SAFE_DELETE_ENABLED=0"

set "EXTRA=%*"
echo.
echo [INFO] powershell -ExecutionPolicy Bypass -File "%PUBLISH_PS%" !EXTRA!
echo.

powershell -ExecutionPolicy Bypass -File "%PUBLISH_PS%" !EXTRA!
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo [ERROR] publish script exited with code %RC%
    goto :fail
)

echo.
echo [DONE] Publish finished. Release URL is in the PowerShell output above.
if not defined NO_PAUSE pause
exit /b 0

:fail
if not defined NO_PAUSE pause
exit /b 1
