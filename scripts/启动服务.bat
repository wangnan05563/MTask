@echo off
chcp 936 >nul 2>&1
REM MTask 服务启动脚本：后端(39876) + 前端 Vite(5175)
REM 脚本位于 scripts/ 子目录，回到项目根目录
cd /d "%~dp0.."
setlocal enabledelayedexpansion

REM 优先使用 WorkBuddy managed Node
set "MGNode=C:\Users\hspcadmin\.workbuddy\binaries\node\versions\22.22.2"
if exist "%MGNode%\node.exe" set "PATH=%MGNode%;%PATH%"

set "SERVER_PORT=39876"
set "WEB_PORT=5175"

echo ========================================
echo   MTask 服务启动中...
echo ========================================

REM [1/6] 清理旧进程：PID 文件优先，端口扫描兜底，最后清理残留包装窗口
echo [1/6] 正在清理旧进程...

if not exist "logs" mkdir logs

if exist "logs\server.pid" (
    for /f "tokens=*" %%a in (logs\server.pid) do (
        taskkill /F /T /PID %%a >nul 2>&1
    )
    del "logs\server.pid" >nul 2>&1
)
if exist "logs\web.pid" (
    for /f "tokens=*" %%a in (logs\web.pid) do (
        taskkill /F /T /PID %%a >nul 2>&1
    )
    del "logs\web.pid" >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%SERVER_PORT%.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%WEB_PORT%.*LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
)

REM 清理上次异常退出后可能残留的包装 cmd 窗口（按命令行匹配 MTask 服务）
for /f "tokens=2 delims=," %%p in ('wmic process where "name='cmd.exe' and CommandLine like '%%MTask-Server%%'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /T /PID %%p >nul 2>&1
)
for /f "tokens=2 delims=," %%p in ('wmic process where "name='cmd.exe' and CommandLine like '%%MTask-Web%%'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /T /PID %%p >nul 2>&1
)

REM 清理上次残留的 Electron 桌面壳（开发模式，命令行含 electron\main.js）
for /f "tokens=2 delims=," %%p in ('wmic process where "name='electron.exe' and CommandLine like '%%electron\main.js%%'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /T /PID %%p >nul 2>&1
)

REM 等待端口释放，最多 5 秒
set /a portWait=0
:wait_port_release
netstat -aon | findstr ":%SERVER_PORT%.*LISTENING" >nul 2>&1
if not errorlevel 1 (
    set /a portWait+=1
    if !portWait! lss 5 (
        timeout /t 1 >nul 2>&1
        goto wait_port_release
    )
    echo [WARN] 端口 %SERVER_PORT% 仍被占用，继续启动可能失败
)
timeout /t 1 >nul 2>&1

REM [2/6] 检查依赖（npm workspaces 依赖提升到根 node_modules，两处都检查），缺失则自动安装
echo [2/6] 正在检查依赖...

if not exist "node_modules\.bin\tsx.cmd" if not exist "server\node_modules\.bin\tsx.cmd" (
    echo   后端依赖缺失，正在自动安装（项目根目录 npm install）...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] 依赖安装失败，请检查网络后重试，或手动执行: npm install
        pause
        exit /b 1
    )
)
if not exist "node_modules\.bin\tsx.cmd" if not exist "server\node_modules\.bin\tsx.cmd" (
    echo [ERROR] 后端依赖仍缺失，请手动执行: npm install
    pause
    exit /b 1
)
if not exist "node_modules\.bin\vite.cmd" if not exist "web\node_modules\.bin\vite.cmd" (
    echo   前端依赖缺失，正在自动安装（项目根目录 npm install）...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] 依赖安装失败，请检查网络后重试，或手动执行: npm install
        pause
        exit /b 1
    )
)
if not exist "node_modules\.bin\vite.cmd" if not exist "web\node_modules\.bin\vite.cmd" (
    echo [ERROR] 前端依赖仍缺失，请手动执行: npm install
    pause
    exit /b 1
)

REM 原生模块 ABI 探测：electron-builder 打包会按 Electron ABI 重编译 better-sqlite3，
REM 导致 Node 直跑后端时 dlopen 失败；不匹配则自动 npm rebuild 修复
node -e "require('better-sqlite3')" >nul 2>&1
if errorlevel 1 (
    echo   原生模块与当前 Node ABI 不匹配（常见于 Electron 打包后），自动重建...
    call npm rebuild better-sqlite3 --no-audit --no-fund
    if errorlevel 1 (
        echo [WARN] 原生模块重建失败，后端可能无法启动
    ) else (
        node -e "require('better-sqlite3')" >nul 2>&1
        if errorlevel 1 (
            echo [WARN] 原生模块仍不可用，后端可能无法启动
        ) else (
            echo   [OK] 原生模块已重建
        )
    )
)
echo   [OK] 依赖检查通过

REM [3/6] 启动后端服务
echo [3/6] 正在启动后端服务...

REM 定位 tsx：优先 workspace 提升后的根 node_modules\.bin，其次 server 本地
if exist "node_modules\.bin\tsx.cmd" (
    set "TSX_BIN=%~dp0..\node_modules\.bin"
) else (
    set "TSX_BIN=%~dp0..\server\node_modules\.bin"
)
REM 后台隐藏启动（无终端窗口），日志写入 logs\server.log
wscript scripts\runhidden.vbs "cmd /c cd /d ""%~dp0..\server"" && ""%TSX_BIN%\tsx.cmd"" src\index.ts >""%~dp0..\logs\server.log"" 2>&1"

echo   正在等待后端服务就绪...
set /a tries=0
:wait_server
set /a tries+=1
timeout /t 1 /nobreak >nul 2>&1
netstat -aon | findstr ":%SERVER_PORT%.*LISTENING" >nul 2>&1
if errorlevel 1 (
    if !tries! lss 60 (
        echo   等待中... !tries!/60
        goto wait_server
    )
    echo [ERROR] 后端服务在 60 秒内未启动成功！
    echo   请查看 logs\server.log 中的错误信息
    pause
    exit /b 1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%SERVER_PORT%.*LISTENING"') do (
    echo %%a> "logs\server.pid"
)
echo   [OK] 后端服务已监听 %SERVER_PORT% 端口

REM [4/6] 启动前端 Vite
echo [4/6] 正在启动前端...

REM 定位 vite：优先根 node_modules\.bin，其次 web 本地
if exist "node_modules\.bin\vite.cmd" (
    set "VITE_BIN=%~dp0..\node_modules\.bin"
) else (
    set "VITE_BIN=%~dp0..\web\node_modules\.bin"
)
REM 后台隐藏启动（无终端窗口），日志写入 logs\web.log
wscript scripts\runhidden.vbs "cmd /c cd /d ""%~dp0..\web"" && ""%VITE_BIN%\vite.cmd"" --port %WEB_PORT% --strictPort >""%~dp0..\logs\web.log"" 2>&1"

set /a tries=0
:wait_web
set /a tries+=1
timeout /t 1 /nobreak >nul 2>&1
netstat -aon | findstr ":%WEB_PORT%.*LISTENING" >nul 2>&1
if errorlevel 1 (
    if !tries! lss 30 (
        echo   等待前端中... !tries!/30
        goto wait_web
    )
    echo [ERROR] 前端服务在 30 秒内未启动成功！
    echo   请查看 logs\web.log 中的错误信息
    pause
    exit /b 1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%WEB_PORT%.*LISTENING"') do (
    echo %%a> "logs\web.pid"
)
echo   [OK] 前端已监听 %WEB_PORT% 端口

REM [5/6] 验证后端健康检查
echo [5/6] 正在验证后端健康检查...
curl -s -o nul http://127.0.0.1:%SERVER_PORT%/api/health
if errorlevel 1 (
    echo   [WARN] 健康检查未通过，请检查 MTask-Server 子窗口日志
) else (
    echo   [OK] 健康检查通过
)

REM [6/6] 启动桌面壳（Electron 原生窗口；服务已就绪，壳直接复用后端）
echo [6/6] 正在启动桌面壳...
if exist "node_modules\electron\dist\electron.exe" (
    REM MTask_DEV=1 让壳加载 Vite dev server（http://localhost:5175），由子进程继承
    set "MTask_DEV=1"
    wscript scripts\runhidden.vbs "cmd /c cd /d ""%~dp0.."" && ""node_modules\electron\dist\electron.exe"" electron\main.js >""%~dp0..\logs\shell.log"" 2>&1"
    echo   [OK] 桌面壳已在后台启动（日志: logs\shell.log）
) else (
    echo   [WARN] 未找到 Electron 二进制，降级为打开浏览器（可先运行 scripts\构建打包.bat）
    start "" http://localhost:%WEB_PORT%
)

echo.
echo ========================================
echo   MTask 服务已启动（后台运行）
echo ========================================
echo   桌面壳:    Electron 窗口（关闭本窗口不影响运行）
echo   后端 API:  http://127.0.0.1:%SERVER_PORT%/api
echo   前端页面:  http://localhost:%WEB_PORT%
echo   服务日志:  logs\server.log / logs\web.log / logs\shell.log
echo.
echo   停止服务请双击 scripts\停止服务.bat
echo ========================================
echo.
echo   按任意键关闭本窗口（服务与桌面壳继续后台运行）...
pause >nul
exit /b 0
