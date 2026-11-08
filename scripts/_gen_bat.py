# -*- coding: utf-8 -*-
"""生成 MTask 的 .bat 脚本（GBK 编码 + CRLF 行尾，脚本内部 chcp 936）。
注意：不要用 UTF-8 + chcp 65001，cmd 在 65001 代码页下对含 goto/标签的
批处理存在行解析缺陷（会把 echo 内容误识别为命令）。
用法: python _gen_bat.py
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))

# T03731: 构建打包.bat 的旧模板（6 步、无守卫、无 ABI 切换）已删除，避免误生成覆盖真实入口。
# 真正的入口是 7 步版，直接编辑 scripts构建打包.bat；三条入口共享同一份 [7/7] 段。

START_BAT = r"""@echo off
chcp 936 >nul 2>&1
REM MTask 服务启动脚本：后端(39876) + 前端 Vite(5175)
REM 脚本位于 scripts/ 子目录，回到项目根目录
cd /d "%~dp0.."
setlocal enabledelayedexpansion

REM 优先使用 WorkBuddy managed Node
REM T02616: no version dir is pinned by name any more - the two pinned directories this used
REM to write are gone, "if exist" judged false and the PATH override silently stopped happening.
REM Resolution is by availability via scripts\lib\resolve-managed-node.ps1; MTASK_MG_NODE_ROOT
REM overrides the root. Keep this block in sync with scripts\*\*.bat - see the T02616 gate.
if not defined MTASK_MG_NODE_ROOT set "MTASK_MG_NODE_ROOT=C:\Users\hspcadmin\.workbuddy\binaries\node\versions"
set "MGNode="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\resolve-managed-node.ps1"`) do set "MGNode=%%D"
if defined MGNode set "PATH=%MGNode%;%PATH%"
if defined MGNode (
    echo   managed node: %MGNode%
) else (
    echo   [WARN] no usable managed node under %MTASK_MG_NODE_ROOT%
    echo   [WARN] this run uses the node already on PATH - native module ABI is not guaranteed
)

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
"""

STOP_BAT = r"""@echo off
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
"""

# 隐藏窗口启动辅助：wscript runhidden.vbs "<完整命令行>"
# 纯 ASCII 内容，避免 cscript/wscript 的编码问题
RUNHIDDEN_VBS = r"""' runhidden.vbs - run a command line in a fully hidden window (no console)
' Usage: wscript runhidden.vbs "<full command line>"
' Note: the command line is passed as ONE quoted argument from the .bat file;
' doubled quotes ("") inside it are literal quotes per Windows arg parsing rules.
Option Explicit
Dim cmd, i
If WScript.Arguments.Count >= 1 Then
    cmd = WScript.Arguments(0)
    For i = 1 To WScript.Arguments.Count - 1
        cmd = cmd & " " & WScript.Arguments(i)
    Next
    CreateObject("WScript.Shell").Run cmd, 0, False
End If
"""


def write_bat(name: str, content: str) -> str:
    path = os.path.join(HERE, name)
    with open(path, 'wb') as f:
        f.write(content.replace('\n', '\r\n').encode('gbk'))
    return path


def verify(name: str, expect_fragment: str) -> None:
    path = os.path.join(HERE, name)
    with open(path, 'rb') as f:
        raw = f.read()
    assert raw[:3] != b'\xef\xbb\xbf', f'{name}: 不应有 UTF-8 BOM'
    assert b'\r\n' in raw, f'{name}: 应为 CRLF 行尾'
    text = raw.decode('gbk')
    assert expect_fragment in text, f'{name}: 缺少关键内容片段'
    print(f'  [OK] {name} ({len(raw)} bytes, GBK + CRLF)')


if __name__ == '__main__':
    print('生成 MTask 脚本...')
    # T03731: 构建打包.bat 不再由本文件生成。BUILD_BAT 模板停在 6 步版本（无 HEAD 自洽预检、
    # 无 ABI 切换、无版本回滚），而仓库里真正的入口已经是 7 步版并接入了多条守卫；
    # 早先误跑本脚本会把 7 步版整份覆盖回 6 步版，一跑构建就丢守卫 —— 这是「改错」的一个来源。
    # 该入口请直接编辑 scripts\构建打包.bat（三条入口保持同一份 [7/7] 段）。
    write_bat('启动服务.bat', START_BAT)
    write_bat('停止服务.bat', STOP_BAT)
    write_bat('runhidden.vbs', RUNHIDDEN_VBS)
    print('校验...')
    verify('启动服务.bat', '正在启动桌面壳')
    verify('停止服务.bat', '正在停止 MTask 服务')
    verify('runhidden.vbs', 'WScript.Shell')
    print('完成。')
