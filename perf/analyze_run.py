#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-18 轮压测数据聚合：从原始 jsonl 实测汇总（不信任工具 success 字段）。

输入：perf/out4/*.jsonl（各阶段原始样本）、probe_results.json、sut_resource.csv、sut.stdout.log
输出：perf/out4/analysis.json + 终端摘要（按阶段 × 端点的错误率/缺陷率/百分位/TPS）
"""
from __future__ import annotations

import csv
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

OUT = Path(r"D:/code/otherProjects/26_MTask/perf/out4")

DEFECT_CODES = {"000", "405"}
DEFECT_PREFIX = "5"


def pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p / 100.0
    f, c = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def load_phase(path: Path) -> dict:
    """解析单阶段 jsonl：{phase, span_s, by_label: {label: {n, codes, els}}}。"""
    by = defaultdict(lambda: {"n": 0, "codes": defaultdict(int), "els": []})
    t_first = t_last = None
    for ln in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            d = json.loads(ln)
        except Exception:
            continue
        lab, code, el = d.get("label", "?"), str(d.get("code", "?")), float(d.get("el", 0))
        ts = d.get("ts") or d.get("timeStamp")
        by[lab]["n"] += 1
        by[lab]["codes"][code] += 1
        by[lab]["els"].append(el)
        if ts is not None:
            t_first = float(ts) if t_first is None else min(t_first, float(ts))
            t_last = float(ts) if t_last is None else max(t_last, float(ts))
    return {"by": by, "span_s": (t_last - t_first) if (t_first is not None and t_last and t_last > t_first) else None}


def summarize(phase: str, loaded: dict) -> dict:
    rows = []
    total_n = total_err = total_def = 0
    for lab, d in loaded["by"].items():
        els = sorted(d["els"])
        n = d["n"]
        err = sum(c for code, c in d["codes"].items() if not code.startswith("2"))
        dfc = sum(c for code, c in d["codes"].items() if code in DEFECT_CODES or code.startswith(DEFECT_PREFIX))
        total_n += n
        total_err += err
        total_def += dfc
        rows.append({
            "label": lab, "n": n,
            "err_pct": round(err * 100.0 / n, 2),
            "defect_pct": round(dfc * 100.0 / n, 2),
            "p50": round(pct(els, 50), 1), "p95": round(pct(els, 95), 1), "p99": round(pct(els, 99), 1),
            "mean": round(statistics.fmean(els), 1), "max": round(els[-1], 1),
            "rps": round(n / loaded["span_s"], 1) if loaded["span_s"] else None,
            "codes": dict(sorted(d["codes"].items(), key=lambda x: -x[1])[:4]),
        })
    rows.sort(key=lambda r: (-r["p95"], -r["err_pct"]))
    return {
        "phase": phase, "rows": rows,
        "total_n": total_n,
        "err_pct": round(total_err * 100.0 / total_n, 3) if total_n else 0,
        "defect_pct": round(total_def * 100.0 / total_n, 3) if total_n else 0,
        "rps_total": round(total_n / loaded["span_s"], 1) if loaded["span_s"] else None,
    }


def load_resource() -> dict:
    f = OUT / "sut_resource.csv"
    if not f.exists():
        return {}
    rows = list(csv.DictReader(f.open(encoding="utf-8")))
    if not rows:
        return {}
    def peak(col):
        vals = []
        for r in rows:
            try:
                vals.append(float(r.get(col, "") or 0))
            except ValueError:
                pass
        return max(vals) if vals else None
    return {
        "samples": len(rows),
        "peak_rss_mb": peak("rss_mb"),
        "peak_private_mb": peak("private_mb"),
        "peak_cpu_pct": peak("cpu_percent"),
        "peak_handles": peak("handles"),
        "peak_threads": peak("threads"),
    }


def load_probes() -> list[dict]:
    f = OUT / "probe_results.json"
    if not f.exists():
        return []
    data = json.loads(f.read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("results", data.get("probes", []))
    out = []
    for d in items:
        out.append({
            "name": d.get("name"), "method": d.get("method"), "path": d.get("path"),
            "code": str(d.get("code") or d.get("status")), "ms": d.get("ms") or d.get("el"),
            "note": (d.get("note") or "")[:60],
        })
    return out


def slow_log_top(limit=25) -> list[str]:
    f = OUT / "sut.stdout.log"
    if not f.exists():
        return []
    pat = re.compile(r"\[mtask\] (\S+) (\S+) (\d+) ([\d.]+)ms")
    rows = []
    for ln in f.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pat.search(ln)
        if m:
            rows.append((float(m.group(4)), ln.strip()))
    rows.sort(key=lambda x: -x[0])
    return [ln for _, ln in rows[:limit]]


def main() -> None:
    phases = {}
    for f in sorted(OUT.glob("*.jsonl")):
        if f.name.startswith("probe"):
            continue
        phases[f.stem] = summarize(f.stem, load_phase(f))

    result = {
        "phases": phases,
        "resource": load_resource(),
        "probes": load_probes(),
        "slow_log_top": slow_log_top(),
    }
    (OUT / "analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    # 终端摘要
    print(f"{'phase':<16} {'n':>7} {'err%':>6} {'def%':>6} {'rps':>7}")
    for ph, s in phases.items():
        print(f"{ph:<16} {s['total_n']:>7} {s['err_pct']:>6} {s['defect_pct']:>6} {str(s['rps_total']):>7}")
    print("\n=== 每阶段 Top8 慢端点（按 p95）===")
    for ph, s in phases.items():
        print(f"\n-- {ph} --")
        for r in s["rows"][:8]:
            flag = " <<<" if r["p95"] >= 100 else ""
            print(f"  {r['label']:<22} n={r['n']:>6} p50={r['p50']:>7} p95={r['p95']:>8} p99={r['p99']:>8} rps={r['rps']} err={r['err_pct']}%{flag}")
    res = result["resource"]
    if res:
        print(f"\n=== 资源峰值 ===\nRSS={res['peak_rss_mb']}MB private={res['peak_private_mb']}MB cpu={res['peak_cpu_pct']}% handles={res['peak_handles']} threads={res['peak_threads']} samples={res['samples']}")


if __name__ == "__main__":
    main()
