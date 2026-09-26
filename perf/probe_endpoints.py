#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单发探针：对「破坏性 / 需全量前置数据 / 一次性」端点逐一单发，测量真实响应码与延迟。

为什么单独跑：这些端点若放进负载循环，固定夹具会在第二次调用起系统性 4xx（404 不存在 /
409 冲突 / 400 已关联），把「夹具耗尽」伪装成「服务错误」，污染错误率口径。
本探针每端点只发一次真实请求，如实记录成功/失败语义。

全部端点、路径、请求体、夹具均来自 config/jmeter-config.yml 的 `probes` / `scenarios.fixtures`
分区 —— 本脚本零业务硬编码。

用法：
  python perf/probe_endpoints.py --config perf/config/jmeter-config.yml
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

try:
    import yaml
except ImportError:
    raise SystemExit("需要 PyYAML")


def expand(value, fixtures: dict):
    """替换 {{fixture}}（与 gen_jmx.py 同规则：逗号分隔取首个）。"""
    if not isinstance(value, str):
        return value

    def repl(m):
        key = m.group(1).strip()
        name = key.split(".", 1)[0]
        raw = str(fixtures.get(name, ""))
        parts = [p.strip() for p in raw.split(",")]
        return parts[0] if parts else ""

    return re.sub(r"\{\{([^}]+)\}\}", repl, value)


def send(method: str, url: str, body, headers: dict, timeout: float):
    """单发请求，返回 (状态码, 毫秒, 完整响应体文本)。

    注意：必须返回**完整**响应体——动态前置（如先 GET 活跃计划 id 再 reorder、
    先导出再回导）依赖完整 JSON 解析；截断会让 json.loads 失败并退化成空对象，
    从而把「工具截断」伪装成「接口 400」。
    """
    data = None
    hdrs = dict(headers)
    if body is not None:
        if isinstance(body, str):
            if body.strip()[:1] in ("{", "["):
                hdrs.setdefault("Content-Type", "application/json")
            data = body.encode("utf-8")
        else:
            data = body
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in hdrs.items():
        req.add_header(k, v)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            code = str(resp.status)
    except urllib.error.HTTPError as e:
        raw = b""
        try:
            raw = e.read()
        except Exception:
            pass
        code = str(e.code)
    except Exception as e:
        raw = str(e).encode("utf-8", "replace")
        code = "000"
    el = (time.perf_counter() - t0) * 1000.0
    return code, round(el, 2), raw.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--only", default="", help="仅执行指定探针（逗号分隔 name），便于修正后选择性重跑")
    a = ap.parse_args()
    only = {x.strip() for x in a.only.split(",") if x.strip()}

    base_dir = os.path.dirname(os.path.abspath(a.config))
    with open(a.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    target = cfg.get("target", {})
    base_url = str(target.get("base_url", "")).rstrip("/")
    fixed_headers = dict(target.get("fixed_headers", {}) or {})
    fixtures = (cfg.get("scenarios", {}) or {}).get("fixtures", {}) or {}
    probes = cfg.get("probes", {}) or {}
    plist = probes.get("list", []) or []
    timeout = float(probes.get("timeout_sec", 120) or 120)
    out_dir = cfg.get("report", {}).get("output_dir", base_dir)

    results = []
    for p in plist:
        name = p["name"]
        if only and name not in only:
            continue
        method = (p.get("method") or "GET").upper()
        path = expand(p.get("path", "/"), fixtures)
        query = expand(p.get("query", ""), fixtures) or ""
        body = expand(p.get("body"), fixtures)
        dynamic = p.get("dynamic")
        note = ""

        # ---- 动态前置（无响应抽取能力，故按端点语义在探针内做一次显式准备）----
        if dynamic == "plans_reorder":
            _, _, full = send("GET", f"{base_url}/api/plans?projectId={fixtures.get('project_id')}",
                              None, fixed_headers, timeout)
            try:
                ids = [r["id"] for r in json.loads(full)]
            except Exception:
                ids = []
            body = json.dumps({"projectId": fixtures.get("project_id"), "orderedIds": ids})
            note = f"前置拉取活跃计划 {len(ids)} 条"
        elif dynamic == "db_insert_row":
            now = datetime.now(timezone.utc).isoformat()
            body = json.dumps({"id": f"probe-{uuid.uuid4().hex[:8]}", "name": "probe-row",
                               "sort_weight": 0, "created_at": now, "updated_at": now})
            note = "运行期生成唯一主键（避免 PK 冲突伪缺陷）"
        elif dynamic == "settings_import":
            _, _, full = send("GET", f"{base_url}/api/settings/export", None, fixed_headers, timeout)
            try:
                bundle = json.loads(full)
            except Exception:
                bundle = {}
            body = json.dumps({"data": bundle, "mode": "keep"})
            note = f"前置导出({len(full)} 字节) 再以 keep 模式回导（幂等）"

        url = f"{base_url}{path}{query}"
        hdrs = dict(fixed_headers)
        if p.get("content_type"):
            hdrs["Content-Type"] = p["content_type"]
        code, el, full = send(method, url, body, hdrs, timeout)
        ok = code.startswith(("2", "3"))
        snippet = full[:160].replace("\n", " ")
        results.append({"name": name, "method": method, "url": url, "code": code,
                        "ok": ok, "ms": el, "note": note, "resp": snippet})
        print(f"{'OK ' if ok else 'ERR'} {name:24s} {method:6s} {code:4s} {el:9.1f}ms  {note}")

    # 落盘（--only 重跑时与既有结果合并，保留其它探针的结论）
    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "probe_results.json")
    if only and os.path.exists(json_path):
        try:
            with open(json_path, encoding="utf-8") as f:
                prev = {r["name"]: r for r in json.load(f)}
            for r in results:
                prev[r["name"]] = r
            merged = [prev[k] for k in sorted(prev)]
            results = merged
        except Exception:
            pass
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    lines = ["# 单发探针结果（破坏性 / 一次性端点）", "",
             "| 端点 | 方法 | 响应码 | 耗时(ms) | 结果 | 说明 |", "|---|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['name']} | {r['method']} | {r['code']} | {r['ms']:.1f} | "
                     f"{'通过' if r['ok'] else '失败'} | {r['note']} |")
    with open(os.path.join(out_dir, "probe_results.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n[probe] 共 {len(results)} 项，失败 {sum(1 for r in results if not r['ok'])} 项 "
          f"→ {out_dir}/probe_results.md")


if __name__ == "__main__":
    main()
