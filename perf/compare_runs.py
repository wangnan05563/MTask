#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""优化前后对照：比较两轮压测产物（同阶段名 / 同端点）并输出 Markdown 对照表。

用法：python perf/compare_runs.py --before perf/out2 --after perf/out3 --out perf/out3/before_after.md
"""
from __future__ import annotations

import argparse
import json
import os

DEFECT_CODES = {"000", "405"}


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def is_defect(code: str) -> bool:
    return code in DEFECT_CODES or code.startswith("5")


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


def agg(rows):
    if not rows:
        return None
    lats = sorted(r["el"] for r in rows)
    errs = sum(1 for r in rows if not str(r["code"]).startswith(("2", "3")))
    defects = sum(1 for r in rows if is_defect(str(r["code"])))
    return {"n": len(rows), "err": errs, "defect": defects,
            "p50": pct(lats, 50), "p95": pct(lats, 95), "p99": pct(lats, 99)}


def dl(before, after):
    """变化百分比（after 相对 before，负=变快）"""
    if before is None or after is None or before == 0:
        return "-"
    return f"{(after - before) / before * 100:+.0f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    phases = ["smoke_reads", "smoke_writes", "reads_baseline", "reads_mid", "reads_stress",
              "writes_baseline", "writes_mid", "writes_stress", "heavy", "stability"]

    L = []
    add = L.append
    add("# 优化前后对照（before = `perf/out2` ／ after = `perf/out3`）")
    add("")
    add("> 同一套 JMX、同一夹具种子、同一机器与时段；before=优化前代码，after=本轮 P0/P1 优化后代码。")
    add("> 百分比为 after 相对 before 的变化，**负值表示更快/更低**。")
    add("")

    add("## 1. 阶段总览对照")
    add("")
    add("| 阶段 | before 样本 | after 样本 | before p50 | after p50 | p50 变化 | before p95 | after p95 | p95 变化 | before p99 | after p99 | p99 变化 | before 错误率 | after 错误率 |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for ph in phases:
        b = agg(read_jsonl(os.path.join(a.before, ph + ".jsonl")))
        c = agg(read_jsonl(os.path.join(a.after, ph + ".jsonl")))
        if not b and not c:
            continue
        row = [ph]
        row.append(f"{b['n']:,}" if b else "-")
        row.append(f"{c['n']:,}" if c else "-")
        for key in ("p50", "p95", "p99"):
            row.append(f"{b[key]:.1f}" if b else "-")
            row.append(f"{c[key]:.1f}" if c else "-")
            row.append(dl(b[key] if b else None, c[key] if c else None))
        row.append(f"{100.0*b['err']/b['n']:.2f}%" if b else "-")
        row.append(f"{100.0*c['err']/c['n']:.2f}%" if c else "-")
        add("| " + " | ".join(row) + " |")
    add("")

    # ---- 端点级对照（重点端点）----
    KEY = [
        ("create_plan", "计划-单条创建"),
        ("batch_plans", "计划-批量创建"),
        ("plan_insert_after", "计划-任意位置插入"),
        ("add_holiday", "节假日-新增"),
        ("patch_plan", "计划-更新"),
        ("tasks_by_project", "任务列表(按项目,无分页)"),
        ("tasks_page", "任务列表(limit=200)"),
        ("plans", "计划列表读取"),
        ("task_categories", "任务分类列表"),
        ("tasks_by_category", "任务列表(按分类)"),
        ("settings_export", "配置全量导出"),
        ("report_generate_xlsx", "报表 xlsx 生成"),
        ("health", "健康检查"),
    ]
    add("## 2. 重点端点对照（跨阶段汇总该端点的全部样本）")
    add("")
    add("| 端点 | before p50 | after p50 | p50 变化 | before p95 | after p95 | p95 变化 |")
    add("|---|---|---|---|---|---|---|")
    for label, title in KEY:
        b_rows, c_rows = [], []
        for ph in phases:
            for r in read_jsonl(os.path.join(a.before, ph + ".jsonl")):
                if r["label"] == label:
                    b_rows.append(r)
            for r in read_jsonl(os.path.join(a.after, ph + ".jsonl")):
                if r["label"] == label:
                    c_rows.append(r)
        b, c = agg(b_rows), agg(c_rows)
        if not b and not c:
            continue
        add(f"| {title} (`{label}`) | " +
            (f"{b['p50']:.1f}" if b else "-") + " | " +
            (f"{c['p50']:.1f}" if c else "-") + " | " +
            dl(b["p50"] if b else None, c["p50"] if c else None) + " | " +
            (f"{b['p95']:.1f}" if b else "-") + " | " +
            (f"{c['p95']:.1f}" if c else "-") + " | " +
            dl(b["p95"] if b else None, c["p95"] if c else None) + " |")
    add("")

    # ---- 探针对照 ----
    pb, pa = os.path.join(a.before, "probe_results.json"), os.path.join(a.after, "probe_results.json")
    if os.path.exists(pb) and os.path.exists(pa):
        with open(pb, encoding="utf-8") as f:
            bmap = {r["name"]: r for r in json.load(f)}
        with open(pa, encoding="utf-8") as f:
            amap = {r["name"]: r for r in json.load(f)}
        add("## 3. 单发探针对照（破坏性/一次性端点延迟）")
        add("")
        add("| 探针 | before 码 | after 码 | before ms | after ms | 变化 |")
        add("|---|---|---|---|---|---|")
        for name in sorted(set(bmap) | set(amap)):
            b, c = bmap.get(name), amap.get(name)
            if b and c:
                add(f"| {name} | {b['code']} | {c['code']} | {b['ms']:.1f} | {c['ms']:.1f} | {dl(b['ms'], c['ms'])} |")
            else:
                bm = f"{b['ms']:.1f}" if b else "-"
                cm = f"{c['ms']:.1f}" if c else "-"
                add(f"| {name} | {b['code'] if b else '-'} | {c['code'] if c else '-'} | {bm} | {cm} | - |")
        add("")

    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    print(f"[compare] 已生成 {a.out}")


if __name__ == "__main__":
    main()
