#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""资源监控编排：等待沙箱 SUT 就绪 → 解析监听 pid → 写 pid 文件 → 启动 monitor_sut.py。

为什么需要它：monitor_sut.py 的 cmd_substr 匹配依赖 WMI 命令行枚举，在 Windows 上不稳定；
改用 pid_file 模式时，引擎本身**不会**写 pid 文件（它只在内存里持有 spawn 句柄），
因此需要由压测编排在 SUT 就绪后把「监听端口所属 pid」写入 pid 文件。

用法：python perf/start_monitor.py --config perf/config/jmeter-config.yml
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.request

try:
    import yaml
except ImportError:
    raise SystemExit("需要 PyYAML")


def listening_pid(port: int):
    """解析监听指定端口的 pid（netstat 输出在中文 Windows 非 UTF-8，须容错解码）。"""
    out = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", "replace")
    for ln in out.splitlines():
        if "LISTENING" in ln and f"127.0.0.1:{port}" in ln:
            return ln.split()[-1]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--monitor", required=True, help="monitor_sut.py 路径")
    a = ap.parse_args()

    with open(a.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    port = int((cfg.get("sandbox") or {}).get("port", 0) or 0)
    base = str((cfg.get("target") or {}).get("base_url", "")).rstrip("/")
    rm = cfg.get("resource_monitor") or {}
    pid_file = ((rm.get("match") or {}).get("pid_file")) or "perf/out2/sut.pid"

    ok = False
    for _ in range(400):
        try:
            urllib.request.urlopen(base + "/api/health", timeout=2)
            ok = True
            break
        except Exception:
            time.sleep(2)
    if not ok:
        print("[monitor-launcher] SUT 未在超时内就绪，放弃采样", flush=True)
        return 1

    pid = None
    for _ in range(30):
        pid = listening_pid(port)
        if pid:
            break
        time.sleep(1)
    print(f"[monitor-launcher] SUT 就绪（port={port} pid={pid}），开始资源采样", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(pid_file)), exist_ok=True)
    with open(pid_file, "w", encoding="utf-8") as f:
        f.write(str(pid or ""))

    subprocess.run([sys.executable, a.monitor, "--config", a.config])
    print("[monitor-launcher] 采样结束", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
