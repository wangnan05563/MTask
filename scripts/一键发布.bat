@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo  MTask One-Click Publish
echo ============================================
echo.

REM Thin ASCII launcher: all logic (incl. the Chinese-named build script)
REM lives in the UTF-8 BOM powershell orchestrator, keeping this .bat pure ASCII.
powershell -ExecutionPolicy Bypass -File "%~dp0publish-oneclick.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] publish script exited with code %RC%
  pause
  exit /b %RC%
)

pause
exit /b 0
