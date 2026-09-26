#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全端点压测结果分析：把 perf/out2 下的 jsonl / 资源 CSV / 探针 JSON 汇总为 Markdown 报告。

口径（与 SKILL.md §6 一致）：
- 断言错误率：响应码非 2xx/3xx 的占比（无断言时引擎的口径）。
- 真实缺陷率：响应码 ∈ {000, 405} 或 5xx 前缀的占比。
- 百分位：对「原始样本」按端点/阶段排序后取 p50/p95/p99（不信任工具 success 字段）。

用法：python perf/report_all_endpoints.py --config perf/config/jmeter-config.yml
"""
from __future__ import annotations

import argparse
import json
import os
from bisect import insort

import yaml

DEFECT_CODES = {"000", "405"}
DEFECT_PREFIXES = ("5",)


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def is_defect(code: str) -> bool:
    return code in DEFECT_CODES or code.startswith(DEFECT_PREFIXES)


def read_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows


def phase_metrics(rows, duration):
    if not rows:
        return None
    errs = sum(1 for r in rows if not str(r["code"]).startswith(("2", "3")))
    defects = sum(1 for r in rows if is_defect(str(r["code"])))
    lats = sorted(r["el"] for r in rows)
    return {
        "total": len(rows),
        "errs": errs,
        "err_rate": 100.0 * errs / len(rows),
        "defects": defects,
        "def_rate": 100.0 * defects / len(rows),
        "p50": pct(lats, 50), "p95": pct(lats, 95), "p99": pct(lats, 99),
        "avg": sum(lats) / len(lats),
        "tps": len(rows) / duration if duration else 0.0,
    }


def by_label(rows):
    out = {}
    for r in rows:
        out.setdefault(r["label"], []).append(r)
    return out


def label_metrics(rows):
    errs = sum(1 for r in rows if not str(r["code"]).startswith(("2", "3")))
    defects = sum(1 for r in rows if is_defect(str(r["code"])))
    lats = sorted(r["el"] for r in rows)
    codes = {}
    for r in rows:
        codes[str(r["code"])] = codes.get(str(r["code"]), 0) + 1
    return {"n": len(rows), "codes": codes, "err": errs, "defect": defects,
            "p50": pct(lats, 50), "p95": pct(lats, 95), "p99": pct(lats, 99)}


def read_resource_csv(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.strip()]
    if len(lines) < 2:
        return None
    hdr = lines[0].split(",")
    idx = {k: i for i, k in enumerate(hdr)}
    samples = []
    for ln in lines[1:]:
        parts = ln.split(",")
        if len(parts) != len(hdr):
            continue
        try:
            samples.append({k: float(parts[i]) for k, i in idx.items() if parts[i] not in ("", "nan")})
        except Exception:
            pass
    if not samples:
        return None
    def mx(k):
        vs = [s[k] for s in samples if k in s]
        return max(vs) if vs else 0.0
    def av(k):
        vs = [s[k] for s in samples if k in s]
        return sum(vs) / len(vs) if vs else 0.0
    return {
        "n": len(samples),
        "rss_max": mx("rss_mb"), "rss_avg": av("rss_mb"),
        "priv_max": mx("private_mb"), "priv_avg": av("private_mb"),
        "cpu_max": mx("cpu_percent"), "cpu_avg": av("cpu_percent"),
        "handles_max": mx("handles"), "threads_max": mx("threads"),
        "peak_rss_col": mx("peak_rss_mb"), "peak_priv_col": mx("peak_private_mb"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    out_dir = cfg["report"]["output_dir"]
    phases = [p for p in cfg["phases"] if p.get("enabled", True)]

    L = []
    add = L.append

    # ---------------- 阶段总览 ----------------
    overview = []
    phase_rows = {}
    for ph in phases:
        rows = read_jsonl(os.path.join(out_dir, ph["name"] + ".jsonl"))
        phase_rows[ph["name"]] = rows
        dur = ph.get("duration_override") or 0
        m = phase_metrics(rows, dur)
        if m:
            overview.append((ph, m))

    add("# 26_MTask 后端 API 全端点性能测试报告")
    add("")
    add("> 被测：Express + better-sqlite3 后端（`server/dist/index.js`，专用沙箱端口 39899，独立数据目录 `perf/sandbox/data2`）  ")
    add("> 引擎：jmeter-performance-test（python_replay 模式，无 Java/JVM；JMX 等价重放）  ")
    add(f"> 夹具：确定性种子集（{590} 任务 / 40 计划 / 50 队列明细 / 400 用量 …），可复现  ")
    add("")
    add("## 1. 阶段总览")
    add("")
    add("| 阶段 | JMX | 并发 | 时长(s) | 采样器 | 请求数 | 断言错误率 | 真实缺陷率 | TPS | p50(ms) | p95(ms) | p99(ms) |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for ph, m in overview:
        nlab = len(by_label(phase_rows[ph["name"]]))
        add(f"| {ph['name']} | {os.path.basename(ph['jmx'])} | {ph.get('threads_override','')} | "
            f"{ph.get('duration_override','')} | {nlab} | "
            f"{m['total']:,} | {m['err_rate']:.2f}% | {m['def_rate']:.2f}% | {m['tps']:.1f} | "
            f"{m['p50']:.1f} | {m['p95']:.1f} | {m['p99']:.1f} |")
    add("")

    # ---------------- 读端点：并发梯度 ----------------
    def endpoint_table(phase_names, title, note=""):
        add(f"### {title}")
        add("")
        if note:
            add(note)
            add("")
        # 收集端点（以第一个存在的阶段为准，保持稳定顺序）
        labels = []
        per = {}
        for pn in phase_names:
            rows = phase_rows.get(pn) or []
            lab = by_label(rows)
            per[pn] = lab
            for k in lab:
                if k not in labels:
                    labels.append(k)
        hdr = "| 端点 | " + " | ".join(f"{pn} p50/p95" for pn in phase_names) + " | 错误率(基线) |"
        add(hdr)
        add("|---" * (len(phase_names) + 2) + "|")
        for lb in labels:
            cells = []
            err = "-"
            for pn in phase_names:
                rows = per[pn].get(lb)
                if not rows:
                    cells.append("-")
                    continue
                m = label_metrics(rows)
                cells.append(f"{m['p50']:.0f} / {m['p95']:.0f}")
                if pn == phase_names[0]:
                    err = f"{100.0*m['err']/m['n']:.1f}%"
            add(f"| {lb} | " + " | ".join(cells) + f" | {err} |")
        add("")

    endpoint_table(["smoke_reads"], "2. 读端点单线程基线（绝对值最可信档）",
                   "> 单线程 20s，无并发排队，最接近真实服务延迟。")
    endpoint_table(["reads_baseline", "reads_mid", "reads_stress"],
                   "3. 读端点并发梯度（5 / 15 / 30 并发）",
                   "> 同机负载生成器 + 系统 CPU 饱和会放大高并发尾延迟；用于**相对比较**（端点快慢、并发劣化斜率）。")
    endpoint_table(["writes_baseline", "writes_mid", "writes_stress"],
                   "4. 写端点并发梯度（5 / 10 / 20 并发）",
                   "> SQLite 单写者：观察写并发下的锁竞争与抖动。")
    endpoint_table(["heavy"], "5. 重端点（单线程，报表/导出/大数据量）")
    endpoint_table(["stability"], "6. 稳定性阶段（混合读写 10 并发 × 120s）")

    # ---------------- 资源 ----------------
    res = read_resource_csv(os.path.join(out_dir, "sut_resource.csv"))
    add("## 7. SUT 资源占用（sidecar 采样）")
    add("")
    if res:
        add(f"- 采样点：{res['n']}（3s 间隔）")
        add(f"- RSS：峰值 **{res['rss_max']:.1f} MB**，均值 {res['rss_avg']:.1f} MB")
        add(f"- 私有内存：峰值 **{res['priv_max']:.1f} MB**，均值 {res['priv_avg']:.1f} MB")
        add(f"- CPU（进程级）：峰值 {res['cpu_max']:.1f}%，均值 {res['cpu_avg']:.1f}%")
        add(f"- 句柄峰值 {res['handles_max']:.0f}；线程峰值 {res['threads_max']:.0f}")
    else:
        add("- 未采集到资源样本（检查 resource_monitor / pid_file）。")
    add("")

    # ---------------- 探针 ----------------
    pj = os.path.join(out_dir, "probe_results.json")
    add("## 8. 单发探针（破坏性 / 一次性端点）")
    add("")
    if os.path.exists(pj):
        with open(pj, encoding="utf-8") as f:
            probes = json.load(f)
        add("| 端点 | 方法 | 响应码 | 耗时(ms) | 结果 | 说明 |")
        add("|---|---|---|---|---|---|")
        for r in probes:
            add(f"| {r['name']} | {r['method']} | {r['code']} | {r['ms']:.1f} | "
                f"{'通过' if r['ok'] else '失败'} | {r.get('note','')} |")
    else:
        add("- 未执行单发探针。")
    add("")

    # ---------------- 覆盖矩阵 ----------------
    sc = cfg.get("scenarios", {}) or {}
    read_cnt = 0
    write_cnt = 0
    for s in sc.get("list", []):
        if s["name"] == "reads":
            read_cnt = len(s["samplers"])
        elif s["name"] == "writes":
            write_cnt = len(s["samplers"])
    probes_n = len((cfg.get("probes") or {}).get("list", []) or [])
    heavy_n = next((len(s["samplers"]) for s in sc.get("list", []) if s["name"] == "heavy"), 0)
    add("## 9. 覆盖统计")
    add("")
    add(f"- 负载阶段覆盖：读 **{read_cnt}** + 写 **{write_cnt}** + 重端点 **{heavy_n}** = **{read_cnt+write_cnt+heavy_n}** 个采样器")
    add(f"- 单发探针覆盖：**{probes_n}** 个破坏性/一次性端点")
    add(f"- 合计覆盖 **{read_cnt+write_cnt+heavy_n+probes_n}** 个本地端点调用面")
    add("")

    out_path = os.path.join(out_dir, "全端点性能测试报告.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print(f"[report] 已生成 {out_path}（{len(L)} 行）")


if __name__ == "__main__":
    main()
