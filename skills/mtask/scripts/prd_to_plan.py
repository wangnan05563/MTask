#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prd_to_plan.py —— PRD/需求规格 + 概要设计 → 项目执行计划 → 回写 MTask

功能：
  1. 解析 PRD/SRS（提取 FR 条目与优先级、里程碑）与概要设计（提取模块表、风险表）
  2. 拆解工作项（按模块 × 设计/实现/联调/验证），粒度 2~5 人日，含依赖与关键路径
  3. 编排时间线（里程碑、起止时间、10%~15% 机动缓冲）与风险登记
  4. 输出 Markdown 项目计划；可选 --writeback 回写至 MTask（经 MCP streamable HTTP）

用法：
  python prd_to_plan.py --prd docs/需求规格说明书_xxx.md --hld docs/概要设计说明书_xxx.md \
      --out docs/项目计划_xxx.md [--project aimsg] [--buffer 0.12] [--start 2026-09-17]
  python prd_to_plan.py ... --writeback        # 额外把工作项回写到 MTask 项目

约束：
  - 回写需 ~/.workbuddy/mcp.json 中存在 mtask 的 url 与 headers.X-Access-Token
  - 回写为写操作，务必先不加 --writeback 预览 plan 后再执行
"""

import argparse
import json
import os
import re
import sys
from datetime import date, timedelta

# ------------------------- 解析 -------------------------

def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def parse_frs(prd_text):
    """提取 FR 条目：
    列表样式 - **FR-1.1【P0】** 标题；
    表格样式 | FR-1.1 | 标题 | … |（T02136：新式 PRD 的 FR 在表格里，此前解析为空 →
    requirements 缺失 → mtask_create_plans 走纯计划通道漏关联）。两种样式同现时列表优先、表格补缺。"""
    out = []
    seen = set()
    for m in re.finditer(r"\*\*(FR-[\d.]+)\s*【(P\d)】\*\*\s*(.+)", prd_text):
        out.append({"id": m.group(1), "priority": m.group(2), "title": m.group(3).strip()})
        seen.add(m.group(1))
    # 表格样式：FR 编号在第一列，标题取第二列；优先级读整行的 P0/P1/P2 标记，缺省 P1
    for m in re.finditer(r"^\|\s*(FR-[\d.]+)\s*\|\s*([^|\n]+)\|", prd_text, re.M):
        fid = m.group(1)
        if fid in seen:
            continue
        pri_m = re.search(r"P(\d)", m.group(0))
        out.append({"id": fid, "priority": f"P{pri_m.group(1)}" if pri_m else "P1", "title": m.group(2).strip()})
        seen.add(fid)
    return out


def parse_milestones(prd_text):
    """提取里程碑：形如 - **M1 概念验证（约 4 周）**：说明"""
    out = []
    for m in re.finditer(r"\*\*(M\d)\s*([^（*(]+)[（(]约?\s*([\d~]+)\s*周", prd_text):
        out.append({"id": m.group(1), "name": m.group(2).strip(), "weeks": m.group(3)})
    return out


def parse_modules(hld_text):
    """提取模块表行：形如 | M1 通知捕获 Adapter | 职责 | FR-1.1/1.2 |"""
    out = []
    for line in hld_text.splitlines():
        m = re.match(r"\|\s*(M\d+)\s+([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|", line)
        if m:
            out.append({
                "id": m.group(1).strip(),
                "name": m.group(2).strip(),
                "duty": m.group(3).strip(),
                "fr": m.group(4).strip(),
            })
    return out


def parse_risks(hld_text):
    out = []
    for m in re.finditer(r"\|\s*([^|]{2,40})\s*\|\s*([🔴🟠🟡✅⚠️ 高中低]+)\s*\|\s*([^|]+)\|", hld_text):
        out.append({"risk": m.group(1).strip(), "level": m.group(2).strip(), "mitigation": m.group(3).strip()})
    return out


# ------------------------- 计划编排 -------------------------

STAGES = [
    ("设计", 0.20),
    ("实现", 0.50),
    ("联调", 0.18),
    ("验证", 0.12),
]
PRIORITY_DAYS = {"P0": 4.0, "P1": 3.0, "P2": 2.0}


def build_wbs(modules, frs, buffer_ratio):
    """按模块拆解工作项：设计/实现/联调/验证。返回 list[dict]"""
    fr_pri = {f["id"].split("-")[1].split(".")[0]: f["priority"] for f in frs}
    wbs, seq = [], 0
    for mod in modules:
        mod_no = re.sub(r"\D", "", mod["id"]) or "0"
        # 该模块关联的 FR 主编号 → 决定优先级与工时基准
        fr_nos = re.findall(r"FR-(\d+)", mod["fr"])
        pri = "P1"
        for n in fr_nos:
            if n in fr_pri:
                pri = fr_pri[n]
                break
        base = PRIORITY_DAYS.get(pri, 3.0)
        prev_ids = []
        for stage, ratio in STAGES:
            seq += 1
            days = round(max(2.0, min(5.0, base * ratio * 4)) , 1)  # 控制在 2~5 人日
            wbs.append({
                "id": f"W{seq:03d}",
                "module": mod["id"],
                "title": f"[{mod['id']} {mod['name']}] {stage}",
                "priority": pri if stage != "验证" else "P1",
                "days": days,
                "depends": list(prev_ids),
                "fr": mod["fr"],
            })
            prev_ids = [f"W{seq:03d}"]
    total = sum(w["days"] for w in wbs)
    buffered = round(total * (1 + buffer_ratio), 1)
    return wbs, total, buffered


def schedule(wbs, start_date, buffer_ratio):
    """按依赖顺序排期（5 天/周，单人串行估算），返回带日期的 wbs"""
    cur = start_date
    for w in wbs:
        # 依赖：取依赖项中最晚结束日
        if w["depends"]:
            dep_end = max(x["end"] for x in wbs if x["id"] in w["depends"])
            cur = max(cur, dep_end + timedelta(days=1))
        # 跳过周末
        while cur.weekday() >= 5:
            cur += timedelta(days=1)
        w["start"] = cur
        days_needed = int(w["days"] * (1 + buffer_ratio))
        end = cur
        added = 0
        while added < days_needed:
            if end.weekday() < 5:
                added += 1
            end += timedelta(days=1)
        w["end"] = end - timedelta(days=1)
        cur = w["end"] + timedelta(days=1)
    return wbs


# ------------------------- 输出 -------------------------

def render_plan(plan_ctx):
    wbs = plan_ctx["wbs"]
    lines = []
    lines.append(f"# {plan_ctx['title']} —— 项目执行计划\n")
    lines.append(f"> 生成工具：`tools/prd_to_plan.py`　|　生成日期：{plan_ctx['today']}")
    lines.append(f"> 输入：PRD/SRS `{plan_ctx['prd']}`；概要设计 `{plan_ctx['hld']}`\n")

    lines.append("## 1. 计划概览\n")
    lines.append("| 项 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| 工作项数 | {len(wbs)} |")
    lines.append(f"| 净工时（人日） | {plan_ctx['total']} |")
    lines.append(f"| 含缓冲工时（{int(plan_ctx['buffer']*100)}%） | {plan_ctx['buffered']} |")
    lines.append(f"| 计划起止 | {wbs[0]['start']} ~ {max(w['end'] for w in wbs)} |")
    lines.append(f"| 依赖关键路径 | {' → '.join(plan_ctx['critical'])} |\n")

    lines.append("## 2. 工作分解（WBS）\n")
    lines.append("| ID | 工作项 | 模块 | 优先级 | 工时(人日) | 开始 | 结束 | 依赖 | 关联需求 |")
    lines.append("|----|--------|------|--------|-----------|------|------|------|----------|")
    for w in wbs:
        lines.append(
            f"| {w['id']} | {w['title']} | {w['module']} | {w['priority']} | {w['days']} | "
            f"{w['start']} | {w['end']} | {', '.join(w['depends']) or '—'} | {w['fr'] or '—'} |"
        )
    lines.append("")

    if plan_ctx["milestones"]:
        lines.append("## 3. 里程碑（源自 SRS）\n")
        lines.append("| 里程碑 | 名称 | 原估周期 |")
        lines.append("|--------|------|----------|")
        for m in plan_ctx["milestones"]:
            lines.append(f"| {m['id']} | {m['name']} | {m['weeks']} 周 |")
        lines.append("")

    lines.append("## 4. 资源与关键路径\n")
    lines.append(f"- 关键路径（串行最长链）：{' → '.join(plan_ctx['critical'])}")
    lines.append(f"- 建议配置：Android 1–2 人、后端 1 人、测试 0.5 人（按 {plan_ctx['buffered']} 人日总量折算）")
    lines.append(f"- 缓冲：按 {int(plan_ctx['buffer']*100)}% 计入各工作项（符合 10%~15% 机动要求）\n")

    if plan_ctx["risks"]:
        lines.append("## 5. 风险登记（源自概要设计）\n")
        lines.append("| 风险 | 等级 | 应对 |")
        lines.append("|------|------|------|")
        for r in plan_ctx["risks"][:10]:
            lines.append(f"| {r['risk']} | {r['level']} | {r['mitigation']} |")
        lines.append("")

    lines.append("## 6. 假设与约束\n")
    lines.append("- 工时为单人串行估算，未做资源平衡；多人并行需按关键路径重排。")
    lines.append("- WBS 由文档结构化解析生成，**不虚构 PRD/概要设计中不存在的功能**。")
    lines.append("- 回写至 MTask 时默认归属 `--project` 指定项目；不传项目会被服务端落到收件箱。\n")
    return "\n".join(lines)


# ------------------------- MTask 回写（MCP streamable HTTP） -------------------------

def mcp_session(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    servers = cfg.get("mcpServers", {})
    if "mtask" not in servers:
        raise SystemExit("mcp.json 中未找到 mtask 服务配置")
    s = servers["mtask"]
    url = s.get("url")
    token = (s.get("headers") or {}).get("X-Access-Token")
    if not url or not token:
        raise SystemExit("mtask 配置缺少 url 或 X-Access-Token")
    return url, token


def mcp_call(url, token, method, params=None, session_id=None, rid=1):
    import urllib.request
    body = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Access-Token": token,
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "ignore")
            new_sid = resp.headers.get("mcp-session-id") or session_id
            data = None
            for line in raw.splitlines():
                if line.startswith("data:"):
                    try:
                        data = json.loads(line[5:].strip())
                    except Exception:
                        pass
            return new_sid, (data or {"raw": raw})
    except Exception as e:
        return session_id, {"error": str(e)}


def writeback(wbs, project, cfg_path):
    url, token = mcp_session(cfg_path)
    sid, _ = mcp_call(url, token, "initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "prd_to_plan", "version": "1.0"},
    })
    if not sid:
        raise SystemExit("初始化失败：未取得 Mcp-Session-Id（可删除会话缓存后重试）")
    mcp_call(url, token, "notifications/initialized", {}, session_id=sid)
    ok, fail = [], []
    for i, w in enumerate(wbs):
        desc = "\n".join([
            f"来源：PRD/概要设计自动拆解（{w['module']}）",
            f"模块：{w['module']}；关联需求：{w['fr'] or '—'}",
            f"工时：{w['days']} 人日；计划：{w['start']} ~ {w['end']}",
            f"依赖：{', '.join(w['depends']) or '—'}",
        ])
        _, res = mcp_call(url, token, "tools/call", {
            "name": "mtask_create_task",
            "arguments": {"title": w["title"], "description": desc, "projectName": project},
        }, session_id=sid, rid=100 + i)
        txt = json.dumps(res, ensure_ascii=False)
        if '"isError":true' in txt or "error" in res and res.get("error"):
            fail.append(w["id"])
        else:
            ok.append(w["id"])
    return ok, fail


def writeback_plan(wbs, project, cfg_path, frs=None, prd_text="", with_tasks=False):
    """回写至 MTask「项目计划」菜单（mtask_create_plans），生成 WBS 计划条目，而非散任务。

    T02131 起该工具有两条通道，本函数走**关联通道**（服务端转 importPrd）：
      requirements + items[].reqNos 同批写入需求跟踪矩阵并回填 plan.req_ids；
      with_tasks=True 时再加 createTasks，由服务端生成 [PRD] 待办并回填 linked_task_id。
    只传 items 会走纯计划通道（req_ids 空、无待办），服务端 ≥3 条时回孤儿告警——不要无视。

    item 字段（实测 schema）：title / description / startDate / durationDays / status /
                            assignee / kind / complexity / ref / deps / reqNos
    ⚠ 无 endDate / progress / linkedTaskNo 入参（多余字段被 zod 静默剥离，别指望它们生效）；
      起止由 durationDays + 依赖推导，进度由关联待办派生。
    顶层必填：projectId 或 projectName（否则报「projectId 或 projectName 必填」）
    """
    url, token = mcp_session(cfg_path)
    sid, _ = mcp_call(url, token, "initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "prd_to_plan", "version": "1.2"},
    })
    if not sid:
        raise SystemExit("初始化失败：未取得 Mcp-Session-Id（可删除会话缓存后重试）")
    mcp_call(url, token, "notifications/initialized", {}, session_id=sid)

    # 需求跟踪矩阵行：以 PRD 的 FR 编号为 req_no（项目内唯一，撞存量号服务端自动顺延并回传 reqNoMap）
    blocks = parse_fr_blocks(prd_text) if prd_text else {}
    requirements = [
        {
            "reqNo": f["id"],
            "title": f["title"],
            "content": blocks.get(f["id"], f["title"]),
            "sourceRef": f["id"],
            "priority": {"P0": "high", "P1": "high", "P2": "normal"}.get(f.get("priority", ""), "normal"),
        }
        for f in (frs or [])
    ]

    items = []
    for w in wbs:
        items.append({
            "title": w["title"],
            "description": "\n".join([
                f"来源：PRD/概要设计自动拆解（{w['module']}）",
                f"关联需求：{w['fr'] or '—'}；优先级：{w['priority']}",
                f"工时：{w['days']} 人日；计划：{w['start']} ~ {w['end']}",
                f"依赖：{', '.join(w['depends']) or '—'}",
            ]),
            "startDate": str(w["start"]),
            "durationDays": int(round(w["days"])),
            "status": "todo",
            "assignee": "",
            # 关联锚点：模块 FR 引用串展开后的编号列表，落库到 plan.req_ids
            "reqNos": expand_fr_refs(w.get("fr", "")),
        })

    arguments = {"projectName": project, "items": items}
    if requirements:
        arguments["requirements"] = requirements
    if with_tasks:
        arguments["createTasks"] = True
    _, res = mcp_call(url, token, "tools/call", {
        "name": "mtask_create_plans",
        "arguments": arguments,
    }, session_id=sid, rid=999)
    txt = json.dumps(res, ensure_ascii=False)
    if '"isError":true' in txt:
        raise SystemExit(f"写入「项目计划」失败：{txt[:500]}")
    # 关联体检：服务端返回的告警（未解析编号 / 顺延明细 / 零关联需求）必须显式打印，
    # 否则又会出现「计划写了、矩阵没挂上」而无人知晓的孤儿批次（四期 K1~K8 教训）。
    # T02133 回修：isError/不可解析响应不得落进 {} 默认值——那会把「防重入拦截」误打印成
    # 「已写入 N 条」（E2E 实测踩坑：被 T01868 拒后仍回显成功）。失败必须显式报错并退出非 0。
    body = res.get("result") or res
    raw_text = ""
    try:
        raw_text = (body.get("content") or [{}])[0].get("text") or ""
    except Exception:
        pass
    if body.get("isError") or not raw_text.strip().startswith("{"):
        print(f"[plan][失败] 服务端未写入（isError={body.get('isError', False)}）：{raw_text[:400] or json.dumps(res, ensure_ascii=False)[:400]}")
        raise SystemExit(1)
    try:
        payload = json.loads(raw_text)
    except Exception:
        print(f"[plan][失败] 响应非 JSON：{raw_text[:400]}")
        raise SystemExit(1)
    warns = payload.get("warnings") or []
    print(f"[plan] 通道={payload.get('channel', 'create_batch')}；矩阵 {payload.get('requirements', len(requirements))} 行 / "
          f"计划 {payload.get('plans', len(items))} 条 / 待办 {payload.get('tasks', 0)} 条")
    for w in warns:
        print(f"[plan][告警] {w}")
    return len(items)


def parse_fr_blocks(prd_text):
    """抽取 FR 条目整块（含验收准则）：- **FR-x.y【Pn】** 主行 + 缩进续行，至下一个 FR 或小节标题"""
    blocks, cur, buf = {}, None, []
    pat = re.compile(r"^- \*\*(FR-[\d.]+)【([^】]+)】\*\*(.*)$")
    for ln in prd_text.splitlines():
        m = pat.match(ln.strip())
        if m:
            if cur and buf:
                blocks[cur] = "\n".join(buf).strip()
            cur = m.group(1)
            buf = ["- **" + m.group(1) + "【" + m.group(2) + "】**" + m.group(3)]
        elif cur is not None:
            s = ln.strip()
            if s.startswith("### ") or s.startswith("## ") or pat.match(s):
                blocks[cur] = "\n".join(buf).strip()
                cur, buf = None, []
                if pat.match(s):
                    m2 = pat.match(s)
                    cur = m2.group(1)
                    buf = ["- **" + m2.group(1) + "【" + m2.group(2) + "】**" + m2.group(3)]
            else:
                buf.append(ln.rstrip())
    if cur and buf:
        blocks[cur] = "\n".join(buf).strip()
    # T02136：表格式 FR 兜底——表格行没有缩进续行，content 取整行原文（含落点列，保留溯源）。
    # 列表样式的块优先（setdefault），两种样式同现时以信息量更大的列表块为准。
    if prd_text:
        for m in re.finditer(r"^\|\s*FR-[\d.]+\s*\|[^|\n]+\|.*$", prd_text, re.M):
            fid = re.match(r"^\|\s*(FR-[\d.]+)", m.group(0)).group(1)
            blocks.setdefault(fid, m.group(0).strip())
    return blocks


def expand_fr_refs(fr_str):
    """展开 FR 引用简写：'FR-1.1/1.2/1.5' → [FR-1.1, FR-1.2, FR-1.5]（章节号继承首项）"""
    ids, base_ch = [], None
    if not fr_str:
        return ids
    for p in [x.strip() for x in fr_str.replace("；", "/").replace("、", "/").split("/") if x.strip()]:
        if p.upper().startswith("FR-"):
            fid = p[3:]
            base_ch = fid.split(".")[0]
        else:
            if not base_ch:
                continue
            fid = p if "." in p else base_ch + "." + p
        ids.append("FR-" + fid)
    return ids


def emit_cards(wbs, modules, frs, prd_text, out_dir):
    """为每条 WBS 生成任务卡：内嵌 FR 原文（含验收准则）+ HLD 设计依据 + 执行约定。

    这是「拆分任务时关联 PRD」的工程化落点——执行 AI 读一张卡即获得全部上下文，
    无需在执行时再去 PRD 里翻对应条款。
    """
    fr_blocks = parse_fr_blocks(prd_text)
    hld_mod = {m["id"]: m for m in modules}
    os.makedirs(out_dir, exist_ok=True)
    idx = ["# 任务卡索引（按依赖序）", "",
           "| ID | 任务卡 | 模块 | 阶段 | 依赖 | 排期 |",
           "|---|---|---|---|---|---|"]
    for w in wbs:
        fr_ids = expand_fr_refs(w.get("fr"))
        fr_secs = []
        for fid in fr_ids:
            if fid in fr_blocks:
                fr_secs.append("### " + fid + "\n" + fr_blocks[fid])
        stage = w["title"].split("] ")[-1] if "] " in w["title"] else ""
        mod = hld_mod.get(w["module"], {})
        card = ["# 任务卡 " + w["id"] + " — " + w["title"], "",
                "| 项 | 值 |", "|---|---|",
                "| 模块 | " + w["module"] + " " + mod.get("name", "") + " |",
                "| 阶段 | " + stage + " |",
                "| 优先级 | " + w["priority"] + " |",
                "| 工时 | " + str(w["days"]) + " 人日 |",
                "| 排期 | " + str(w["start"]) + " ~ " + str(w["end"]) + " |",
                "| 依赖 | " + (", ".join(w["depends"]) or "—（就绪可开工）") + " |",
                "| 关联需求 | " + (w["fr"] or "—") + " |", ""]
        if fr_secs:
            card.append("## 关联需求（PRD/SRS 原文摘录，含验收准则）")
            card.append("")
            card.append("\n\n".join(fr_secs))
            card.append("")
        if mod:
            card.append("## 设计依据（HLD）")
            card.append("")
            card.append("- 职责：" + mod.get("duty", ""))
            card.append("- 模块关联需求：" + mod.get("fr", ""))
            card.append("- 详见 `docs/概要设计说明书_高情商聊天回复助手.md` §3（模块）/ §5（接口）/ §10（复用项 C1–C31 映射）")
            card.append("")
        card.append("## 执行约定")
        card.append("")
        card.append("1. 按 mtask 技能闭环：显式 running → 执行 → 验证 → 回传 result → done/unread。")
        card.append("2. 验证等级按阶段：设计=文档产出+自检；实现=编译+单测；联调=API 冒烟；验证=**逐条对照上方 FR 验收准则**。")
        card.append("3. 真机受限项（M1 通知捕获 / M7 IME 注入）：本环境无法实测 → verified:false + 缺口单（参照 T00644）。")
        card.append("4. 每任务独立 commit；跨项目复用约束见 HLD §10（C1–C31）。")
        card.append("")
        with open(os.path.join(out_dir, w["id"] + ".md"), "w", encoding="utf-8") as f:
            f.write("\n".join(card))
        idx.append("| " + w["id"] + " | [" + w["title"] + "](" + w["id"] + ".md) | " + w["module"] + " | " + stage
                   + " | " + (", ".join(w["depends"]) or "—") + " | " + str(w["start"]) + " ~ " + str(w["end"]) + " |")
    with open(os.path.join(out_dir, "INDEX.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(idx) + "\n")
    return len(wbs)


# ------------------------- main -------------------------

def main():
    ap = argparse.ArgumentParser(description="PRD + 概要设计 → 项目计划 → 回写 MTask")
    ap.add_argument("--prd", required=True, help="PRD / 需求规格说明书 md")
    ap.add_argument("--hld", required=True, help="概要设计说明书 md")
    ap.add_argument("--out", required=True, help="输出项目计划 md")
    ap.add_argument("--project", default="aimsg", help="回写目标项目名（默认 aimsg）")
    ap.add_argument("--buffer", type=float, default=0.12, help="缓冲比例，默认 0.12")
    ap.add_argument("--start", default=str(date.today()), help="计划起始日 YYYY-MM-DD")
    ap.add_argument("--writeback", action="store_true", help="回写工作项至 MTask 任务列表（散任务）")
    ap.add_argument("--plan", action="store_true", help="回写至 MTask「项目计划」菜单（mtask_create_plans），生成 WBS 计划条目；与 --writeback 可同时使用")
    ap.add_argument("--plan-tasks", action="store_true", help="--plan 的加强档：同时传 createTasks，由服务端按条目生成 [PRD] 待办并回填 plan.linked_task_id（计划与待办联动）")
    ap.add_argument("--limit", type=int, default=0, help="仅回写前 N 条工作项（0=全部）；用于小批量验证，避免一次写入大量任务")
    ap.add_argument("--no-chain", action="store_true", help="不自动串联依赖（默认模块内 设计→实现→联调→验证 串行依赖）；依赖应可手动设置，避免默认顺序依赖牵一发动全身")
    ap.add_argument("--emit-cards", action="store_true", help="为每条 WBS 生成任务卡（内嵌 FR 原文+验收准则+HLD 设计依据），供 AI 逐卡自动执行")
    ap.add_argument("--cards-dir", default=None, help="任务卡输出目录（默认 <计划.md 所在目录>/plan-cards）")
    ap.add_argument("--mcp-config", default=os.path.expanduser("~/.workbuddy/mcp.json"))
    args = ap.parse_args()

    prd_text = read_text(args.prd)
    hld_text = read_text(args.hld)

    frs = parse_frs(prd_text)
    milestones = parse_milestones(prd_text)
    modules = parse_modules(hld_text)
    risks = parse_risks(hld_text)

    if not modules:
        print("[warn] 概要设计未解析到模块表，WBS 将为空；请确认模块表格式为 | M1 名称 | 职责 | FR |")

    wbs, total, buffered = build_wbs(modules, frs, args.buffer)
    if args.no_chain:
        for w in wbs:
            w["depends"] = []
    y, m, d = (int(x) for x in args.start.split("-"))
    wbs = schedule(wbs, date(y, m, d), args.buffer)
    critical = [w["id"] for w in wbs if w["module"] == (modules[0]["id"] if modules else "")] or [w["id"] for w in wbs[:4]]

    ctx = {
        "title": "EmoReply 跨平台高情商聊天回复助手",
        "today": str(date.today()),
        "prd": args.prd, "hld": args.hld,
        "wbs": wbs, "total": total, "buffered": buffered,
        "buffer": args.buffer, "milestones": milestones, "risks": risks,
        "critical": critical,
    }
    md = render_plan(ctx)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"[ok] 计划已生成：{args.out}")
    print(f"     工作项 {len(wbs)} 条；净工时 {total} 人日；含缓冲 {buffered} 人日")

    if args.writeback:
        items = wbs[:args.limit] if args.limit and args.limit > 0 else wbs
        print(f"[writeback] 目标项目：{args.project}；待写入 {len(items)} 条" + ("（--limit 生效）" if args.limit else ""))
        ok, fail = writeback(items, args.project, args.mcp_config)
        print(f"[writeback] 成功 {len(ok)} 条，失败 {len(fail)} 条" + (f"（失败：{fail}）" if fail else ""))
        if fail:
            sys.exit(1)

    if args.plan:
        pitems = wbs[:args.limit] if args.limit and args.limit > 0 else wbs
        print(f"[plan] 目标项目：{args.project}；写入 {len(pitems)} 条计划条目" + ("（--limit 生效）" if args.limit else ""))
        n = writeback_plan(pitems, args.project, args.mcp_config, frs=frs, prd_text=prd_text, with_tasks=args.plan_tasks)
        print(f"[plan] 已写入 MTask「项目计划」菜单：{n} 条")

    if args.emit_cards:
        cdir = args.cards_dir or os.path.join(os.path.dirname(os.path.abspath(args.out)), "plan-cards")
        n = emit_cards(wbs, modules, frs, prd_text, cdir)
        print(f"[cards] 已生成任务卡 {n} 份 → {cdir}")


if __name__ == "__main__":
    main()
