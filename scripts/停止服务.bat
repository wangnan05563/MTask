@echo off
chcp 936 >nul 2>&1
REM MTask 服务停止脚本：PID 文件优先，端口扫描兜底
REM 脚本位于 scripts/ 子目录，回到项目根目录
cd /d "%~dp0.."
setlocal enabledelayedexpansion

set "SERVER_PORT=39876"
set "WEB_PORT=5175"

echo ========================================
echo   正在停止 MTask 服务...
echo ========================================

REM [1/3] 通过 PID 文件停止，失败回退端口扫描
echo [1/3] 正在停止服务进程...

set KILLED=0

if exist "logs\server.pid" (
    for /f "tokens=*" %%a in (logs\server.pid) do (
        taskkill /F /T /PID %%a >nul 2>&1
        if not errorlevel 1 (
            echo   [OK] 后端服务已停止
            set KILLED=1
        )
    )
    del "logs\server.pid" >nul 2>&1
)
if exist "logs\web.pid" (
    for /f "tokens=*" %%a in (logs\web.pid) do (
        taskkill /F /T /PID %%a >nul 2>&1
        if not errorlevel 1 (
            echo   [OK] 前端服务已停止
            set KILLED=1
        )
    )
    del "logs\web.pid" >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%SERVER_PORT%.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo   [OK] 后端服务已停止，通过端口 %SERVER_PORT% 找到
        set KILLED=1
    )
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%WEB_PORT%.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo   [OK] 前端服务已停止，通过端口 %WEB_PORT% 找到
        set KILLED=1
    )
)

REM 停止开发模式 Electron 桌面壳（按命令行匹配，不影响其他 Electron 应用）
for /f "tokens=2 delims=," %%p in ('wmic process where "name='electron.exe' and CommandLine like '%%electron\main.js%%'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /T /PID %%p >nul 2>&1
    if not errorlevel 1 (
        echo   [OK] 桌面壳已停止
        set KILLED=1
    )
)

if "!KILLED!"=="0" (
    echo   [SKIP] 未找到运行中的 MTask 服务进程
)

timeout /t 1 >nul 2>&1

REM [2/3] 验证端口释放
echo [2/3] 正在验证端口释放...

set PORT_FREE=1
netstat -aon | findstr ":%SERVER_PORT%.*LISTENING" >nul 2>&1
if not errorlevel 1 set PORT_FREE=0
netstat -aon | findstr ":%WEB_PORT%.*LISTENING" >nul 2>&1
if not errorlevel 1 set PORT_FREE=0

if "!PORT_FREE!"=="1" (
    echo   [OK] 端口 %SERVER_PORT% 与 %WEB_PORT% 均已释放
) else (
    echo   [WARN] 部分端口仍被占用，请检查任务管理器
)

REM [3/3] 完成
echo [3/3] 完成
echo.
echo ========================================
echo   MTask 服务已停止
echo ========================================
echo.
timeout /t 2 >nul 2>&1
exit /b 0
