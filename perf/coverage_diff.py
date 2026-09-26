#!/usr/bin/env python3
"""静态提取 MTask 后端全 API 路径，与压测配置已覆盖路径做差集。

目的：确保"全面测试"不留盲区 —— 任何源码里新增的端点都会被这个差集发现。
输入：server/src/routes/*.ts + server/src/index.ts + perf/config/jmeter-config.yml
输出：终端打印「已覆盖 / 未覆盖」统计与未覆盖清单
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(r"D:/code/otherProjects/26_MTask")
SRC = ROOT / "server" / "src"
ROUTES = SRC / "routes"
CONFIG = ROOT / "perf" / "config" / "jmeter-config.yml"

VERBS = r"get|post|put|patch|delete"


def extract_paths(file: Path) -> list[tuple[str, str]]:
    """提取 (METHOD, path)，兼容 `router.get('/x'` 与 `router.get("/x"`。"""
    text = file.read_text(encoding="utf-8", errors="replace")
    out: list[tuple[str, str]] = []
    for m in re.finditer(r"\.(%s)\(\s*(['\"])([^'\"]+)\2" % VERBS, text):
        out.append((m.group(1).upper(), m.group(3)))
    return out


def build_surface() -> dict[str, str]:
    """拼装完整路径表 {METHOD /api/xxx : 来源文件}。"""
    surface: dict[str, str] = {}

    # 主路由 index.ts (挂载于 /api)
    for verb, p in extract_paths(ROUTES / "index.ts"):
        if p.startswith("/health") or True:
            surface[f"{verb} /api{p}"] = "index"

    # 子路由：读 mounted 前缀
    mounts = {
        "dbadmin": ("dbadminApi", "/api/dbadmin"),
        "plans": ("planApi", "/api/plans"),
        "history": ("historyApi", "/api/history"),
    }
    for fname, (_var, prefix) in mounts.items():
        f = ROUTES / f"{fname}.ts"
        for verb, p in extract_paths(f):
            surface[f"{verb} {prefix}{p}"] = fname

    # tunnel：router get/post... 挂载于 /api/tunnel
    for verb, p in extract_paths(ROUTES / "tunnel.ts"):
        surface[f"{verb} /api/tunnel{p}"] = "tunnel"

    # index.ts 顶层 + MCP + SSE
    surface["GET /api/events"] = "index"
    for verb in ("GET", "POST", "DELETE"):
        surface[f"{verb} /api/mcp/"] = "mcp"
    return surface


def covered_from_config() -> set[str]:
    """从配置里抽取所有已覆盖 path（含 {{fixture}} 占位符→通配化）。"""
    text = CONFIG.read_text(encoding="utf-8", errors="replace")
    covered: set[str] = set()
    # 形如: path: "/api/xxx", method: "GET"
    for m in re.finditer(
        r"path:\s*[\"']([^\"']+)[\"']\s*,\s*method:\s*[\"']([A-Z]+)[\"']", text
    ):
        p, verb = m.group(1), m.group(2).upper()
        covered.add(f"{verb} {p}")
    return covered


def wildcard(p: str) -> str:
    """把 /xxx/{id}、/xxx/:id、/xxx/{{fixture}} 统一成 /xxx/* 以便比较。"""
    parts = p.split("/")
    norm = []
    for seg in parts:
        if seg.startswith(":") or seg.startswith("{{") or seg.startswith("{"):
            norm.append("*")
        else:
            norm.append(seg)
    return "/".join(norm)


def main() -> int:
    surface = build_surface()
    covered = covered_from_config()
    cov_wild = {wildcard(p) for p in covered}

    missing = []
    for key, src in sorted(surface.items()):
        # key 形如 "GET /api/tasks"：必须以「动词+路径」整体比较，
        # 否则会把 "GET /api/x" 与 "POST /api/x" 视为同一条而漏判未覆盖。
        if wildcard(key) not in cov_wild:
            missing.append((key.split(" ", 1)[0], key.split(" ", 1)[1], src))

    print(f"== API 面总数（源码静态提取）: {len(surface)} ==")
    print(f"== 配置中出现的路径条目数  : {len(covered)} ==")
    print(f"== 未被任何测试覆盖的端点  : {len(missing)} ==\n")
    if missing:
        print("--- 未覆盖清单 ---")
        for verb, path, src in missing:
            print(f"  {verb:6} {path}    [{src}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
