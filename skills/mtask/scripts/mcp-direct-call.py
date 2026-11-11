#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mtask MCP 直连调用器 —— 会话未注册 mtask 工具时的 HTTP 降级通道。

背景：WorkBuddy 会话里 ToolSearch 可能只暴露 mtask 的查询工具，`mtask_update_task_result`
/ `mtask_update_task` 搜不到 != 服务端没有。本脚本按 streamable HTTP 直连 JSON-RPC：
    initialize（从响应头 mcp-session-id 取会话 ID）
    -> notifications/initialized（必须带 Mcp-Session-Id 头，否则 400）
    -> tools/call
响应可能是 SSE（`data:` 行）或纯 JSON，两种都解析。

连接信息自动从 `~/.workbuddy/mcp.json` 的 mcpServers.mtask 读取（url + X-Access-Token），
会话 ID 缓存在 %TEMP%/mtask-session.txt，失效时删除该文件重跑即可。

用法：
    python mcp-direct-call.py get T00424                          # 读单条任务
    python mcp-direct-call.py list                                # 待处理+未验证清单
    python mcp-direct-call.py result T00424 result.md             # 回传处理结果（Markdown）
    python mcp-direct-call.py done T00424                         # 标注 done（默认不传 verified，留待人工/后续验证）
    python mcp-direct-call.py done T00424 verified                # 仅在验证全链闭环后显式标注 done + verified:true
    python mcp-direct-call.py create "【AI回写待审核】<标题>" desc.md [projectName|projectId] [原任务taskNo]
                                  # 建单后自动回写 ai_state=unread；带第 4 参时同时挂 parentId
    python mcp-direct-call.py merge T00573 T00572 结论.md            # 默认 dry-run：只打印拟写入节 + 差异
    python mcp-direct-call.py merge T00573 T00572 结论.md --write    # 显式写盘：归并/就地刷新 + 归档派生单
                                  # 判据与服务端 derivedOrigin.ts 同构（已含且一致 → 不重复追加）
    python mcp-direct-call.py progress start T00424 "排查中"       # 开工上报执行会话（生成并缓存会话标识，可选阶段）
    python mcp-direct-call.py progress ping T00424 40 "执行测试"   # 心跳续报进度/阶段（复用缓存标识）
    python mcp-direct-call.py progress done T00424                # 完工收口会话（pct=100 + done，清除缓存标识）
    python mcp-direct-call.py progress fail T00424 "上游接口报错"  # 异常收口会话（failed，phase=失败原因，清除缓存标识）
    python mcp-direct-call.py raw <toolName> '<json参数>'          # 任意工具兜底
"""
import datetime
import difflib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request


def load_endpoint():
    # T00480：环境变量优先（MTASK_MCP_URL / MTASK_MCP_TOKEN），便于隔离测试指向临时实例而不改 mcp.json
    env_url = os.environ.get('MTASK_MCP_URL')
    env_token = os.environ.get('MTASK_MCP_TOKEN')
    if env_url:
        return env_url, (env_token or '')
    cfg_path = os.path.join(os.path.expanduser("~"), ".workbuddy", "mcp.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    for name, c in cfg.get("mcpServers", {}).items():
        if "mtask" in name.lower() and c.get("url"):
            token = None
            for v in list((c.get("headers") or {}).values()) + list((c.get("env") or {}).values()):
                if isinstance(v, str) and ("token" in v.lower() or len(v) in (32, 36, 48, 64)):
                    token = v
                    break
            return c["url"], token
    raise SystemExit("mcp.json 中未找到 mtask 服务（含 url 的条目）")


URL, TOKEN = load_endpoint()
# T04572：隔离测试（门指向临时实例）时可覆盖会话缓存，避免与生产会话互相顶掉
SESSION_FILE = os.environ.get('MTASK_SESSION_FILE') or os.path.join(
    tempfile.gettempdir(), "mtask-session.txt")


def _proxy_context():
    """T01369：connector-proxy 端点要求携带 X-WorkBuddy-MCP-Context（会话上下文），
    从进程环境 CODEBUDDY_MCP_CONFIG 的 mtask 条目自动提取。"""
    raw = os.environ.get('CODEBUDDY_MCP_CONFIG')
    if not raw:
        return None
    try:
        cfg = json.loads(raw)
        for name, c in cfg.get('mcpServers', {}).items():
            if 'mtask' not in name.lower():
                continue
            for k, v in (c.get('headers') or {}).items():
                if k.lower().startswith('x-workbuddy-mcp-context'):
                    return v
    except Exception:
        pass
    return None


CTX = _proxy_context()


def post(payload, session=None, timeout=30):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if TOKEN:
        # T01369：兼容两类端点——MTask 原生端点认 X-Access-Token；
        # WorkBuddy connector-proxy（/mcp 路径）认 Authorization: Bearer，两者同时发互不干扰
        req.add_header('X-Access-Token', TOKEN)
        req.add_header('Authorization', TOKEN if TOKEN.lower().startswith('bearer ') else 'Bearer ' + TOKEN)
    if session:
        req.add_header("Mcp-Session-Id", session)
    if CTX:
        req.add_header("X-WorkBuddy-MCP-Context", CTX)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s: %s" % (e.code, e.read()[:400].decode("utf-8", "replace")))
    sid = resp.headers.get("mcp-session-id") or resp.headers.get("Mcp-Session-Id")
    return resp.status, sid, resp.read().decode("utf-8", "replace")


def parse_body(raw):
    """SSE（data: 行）或纯 JSON 都兼容；返回 JSON-RPC result 或 None。"""
    if not raw.strip():
        return None
    if raw.lstrip().startswith("{"):
        obj = json.loads(raw)
        return obj.get("result", obj) if isinstance(obj, dict) else obj
    # T00978-P2：大响应会被服务端拆成多个 data: 片段分批下发，此前 reverse 只解析
    # 最后一条，最后一个片段往往是不完整 JSON 而被 json.loads 丢弃 → 整段结果变 None（截断）。
    # 改为顺序累积全部片段后用 raw_decode 顺序扫描，既能拼回被拆分的单帧，也兼容多帧响应
    # （仍取最后一个 JSON-RPC 响应帧，与旧 reverse 语义一致）。
    decoder = json.JSONDecoder()
    text = ""
    latest = None
    for line in re.findall(r"^data:\s*(.*)$", raw, re.M):
        s = line.strip()
        if not s or s == "[DONE]":
            continue
        text += s
        pos = 0
        while pos < len(text):
            try:
                obj, pos = decoder.raw_decode(text, pos)
            except json.JSONDecodeError:
                break
            if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                latest = obj.get("result", obj)
    return latest


def mark_unread(sid, task_no, rid=9):
    """【2026-09-15 起：不再自动调用】状态由**服务端接口自动驱动**（T00566 二轮）：
    - mtask_get_task（读取待办详情）→ running
    - mtask_update_task_result（回传结果）→ unread
    - mtask_update_task {status:'done'} → unread；{verified:false} → failed
    - REST PATCH 同规则（显式 aiState 优先）

    因此脚本**不得**再兜底强制 unread——那会覆盖服务端刚写入的 failed/running
    （2026-09-15 实测：脚本 raw 分支强制 unread 覆盖 failed，导致验证失败状态丢失）。
    本函数仅保留供**显式**场景手动调用（如需把某任务标为已读/未读）。"""

    if not task_no:
        return
    st = unwrap(call(sid, "mtask_write_task_status",
                     {"taskNo": task_no, "state": "unread"}, rid))
    state = st.get("ai_state") if isinstance(st, dict) else st
    print("已标记未读:", task_no, "ai_state =", state)


def ensure_session(_retried=False):
    if os.path.exists(SESSION_FILE):
        sid = open(SESSION_FILE, encoding="utf-8").read().strip()
        if sid and not _retried:
            # T00540：缓存的会话可能因服务重启失效——initialize 带 400 即删缓存重建
            try:
                st, _, raw = post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "workbuddy-agent", "version": "1.0"}}}, session=sid)
                if st == 200:
                    return sid
            except SystemExit:
                pass
        os.remove(SESSION_FILE)
    st, sid, raw = post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "workbuddy-agent", "version": "1.0"}}})
    if not sid:
        raise SystemExit("initialize 未返回会话 ID：HTTP %s / %s" % (st, raw[:300]))
    open(SESSION_FILE, "w").write(sid)
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session=sid)
    print("会话已建立:", sid)
    return sid


def call(session, name, args, rid=1, _retried=False):
    st, sid, raw = post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                         "params": {"name": name, "arguments": args}}, session=session)
    # T00540：会话失效（服务重启后旧 session 失效返回 400 no valid session）→ 自动重建会话并重放一次
    if st in (400, 404) and 'no valid session' in raw and not _retried:
        if os.path.exists(SESSION_FILE):
            os.remove(SESSION_FILE)
        new_sid = ensure_session()
        return call(new_sid, name, args, rid=rid, _retried=True)
    if st in (400, 404):
        raise SystemExit("tools/call HTTP %s：%s" % (st, raw[:400]))
    return parse_body(raw)


def unwrap(res):
    if res is None:
        return None
    if res.get("isError"):
        print("工具报错:", json.dumps(res, ensure_ascii=False)[:600])
        return None
    text = "\n".join(i.get("text", "") for i in res.get("content", []) if i.get("type") == "text")
    m = re.search(r"\[.*\]|\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return text
    return text


# ---- T04572：归并判据（与服务端 server/src/services/derivedOrigin.ts 的
# alreadyMerged / mergedContentMatches / refreshMergedBody 同构，脚本侧不得另写一套正则） ----
def _merged_heading_re(task_no):
    esc = re.escape(task_no)
    return re.compile(
        r"^(?:(【派生单 %s 处理结果 )([^】]*)】|(##\s*派生单回填 %s（)([^）]*)）)[ \t]*$"
        % (esc, esc),
        re.M)


def find_merged_sections(text, task_no):
    """定位母单里属于该子单的全部归并节（自动通道【…】与补录通道 ## 两种标题形态）。"""
    if not text or not task_no:
        return []
    heads = []
    for m in _merged_heading_re(task_no).finditer(text):
        prefix = m.group(1) or m.group(3) or ""
        date = m.group(2) if m.group(2) is not None else (m.group(4) or "")
        date_start = m.start() + len(prefix)
        heads.append({
            "start": m.start(), "end": m.end(), "line": m.group(0),
            "date_start": date_start, "date_end": date_start + len(date),
        })
    if not heads:
        return []
    marks = [m.start() for m in re.finditer(
        r"^【派生单 T\d+ 处理结果[^】]*】$|^##\s*派生单回填 T\d+（[^）]*）$|^---$", text, re.M)]
    sections = []
    for h in heads:
        body_end = len(text)
        for pos in marks:
            if pos > h["end"]:
                body_end = pos
                break
        sections.append(dict(h, body_start=h["end"], body_end=body_end))
    return sections


def normalize_body(s):
    """比较用归一化：行尾统一 LF、去掉节正文首尾空行与行末空白（同服务端 normalizeBody）。"""
    return "\n".join(line.rstrip() for line in (s or "").replace("\r\n", "\n").split("\n")).strip()


def merged_content_matches(handle_result, task_no, result):
    sections = find_merged_sections(handle_result or "", task_no)
    if not sections:
        return False
    last = sections[-1]
    return normalize_body((handle_result or "")[last["body_start"]:last["body_end"]]) == normalize_body(result)


def refresh_merged_body(handle_result, task_no, result, stamp):
    """就地刷新最后一节的正文与日期槽；无命中节时按补录通道标题追加一节。"""
    text = handle_result or ""
    sections = find_merged_sections(text, task_no)
    if not sections:
        prev = text.strip()
        block = "## 派生单回填 %s（%s）\n%s" % (task_no, stamp, result)
        return (prev + "\n\n" + block) if prev else block
    last = sections[-1]
    heading = text[last["start"]:last["end"]]
    rel_s = last["date_start"] - last["start"]
    rel_e = last["date_end"] - last["start"]
    dated = heading[:rel_s] + stamp + heading[rel_e:]
    tail = text[last["body_end"]:]
    return text[:last["start"]] + dated + "\n" + result + (("\n\n" + tail) if tail else "")



def main():
    argv = sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    mode = argv[0]
    sid = ensure_session()
    if mode == "get":
        print(json.dumps(unwrap(call(sid, "mtask_get_task", {"taskNo": argv[1]}, 2)),
                         ensure_ascii=False, indent=1)[:6000])
    elif mode == "list":
        args = {}
        if len(argv) > 1:
            args["projectName"] = argv[1]
        # 不截断：列表响应被硬截 8000 字符会产生非法 JSON（2026-09-26 实测 aimsg 18 单即触发）
        print(json.dumps(unwrap(call(sid, "mtask_list_tasks", args, 2)),
                         ensure_ascii=False, indent=1))
    elif mode == "result":
        md = open(argv[2], encoding="utf-8").read()
        print(json.dumps(call(sid, "mtask_update_task_result",
                              {"taskNo": argv[1], "result": md}, 2), ensure_ascii=False)[:800])
        # T00566 二轮：状态由服务端自动驱动（回传结果 → unread），脚本不再兜底
    elif mode == "done":
        # T00871 用户裁决（2026-09-22）：未彻底验证通过禁止标注已验证。
        # 默认只传 status:'done'（verified 由服务端保持未验证态，任务留在"未验证"清单待人工复核）；
        # 仅当全链路验证已闭环（命令层编译+API冒烟+数据断言，或 UI 实测通过）后，才显式 `done <taskNo> verified`。
        payload = {"taskNo": argv[1], "status": "done"}
        if len(argv) > 2 and argv[2] == "verified":
            payload["verified"] = True
        print(json.dumps(call(sid, "mtask_update_task", payload, 2),
                         ensure_ascii=False)[:800])
        # T00566 二轮：标记完成 → 服务端自动置 unread，脚本不再兜底
    elif mode == "create":
        desc = open(argv[2], encoding="utf-8").read()
        args = {"title": argv[1], "description": desc}
        # 2026-09-14：必须带项目，否则服务端兜底到 sys-inbox 收件箱——按 projectName
        # 拉取时永远看不到它（形成待办却进不了来源项目流程），且 dedupe（同项目同标题）
        # 拦不住跨项目重复。第 3 参传 projectName 或 projectId。
        if len(argv) > 3 and argv[3]:
            key = "projectId" if ("-" in argv[3] and len(argv[3]) > 20) else "projectName"
            args[key] = argv[3]
        else:
            print("警告：未传项目（第 3 参），任务将落到 sys-inbox 收件箱；"
                  "建议传 projectName 或 projectId", file=sys.stderr)
        # 第 4 参（可选）= 原任务 taskNo：传 derivedFrom 建立**派生溯源**（T00577）。
        # 语义区分：derivedFrom = 本单派生自哪个任务（MTask 会在派生单完成后自动把结论
        # 整合回原任务，避免单子过多）；parentId = epic→task 层级父子关系（T00450），
        # 两者不是一回事——早期误用 parentId 做派生关联，已纠正。
        if len(argv) > 4 and argv[4]:
            args["derivedFrom"] = argv[4]
            print("已标记派生于:", argv[4])
        res = unwrap(call(sid, "mtask_create_task", args, 2))
        print(json.dumps(res, ensure_ascii=False)[:1200])
        # T00566 二轮：新任务不需要状态标记——待 Agent 读取详情时服务端自动置 running；
        # 若确需显式标记，用 status 子命令。
    elif mode == "merge":
        # T04572：先判后写。用户 2026-11-07 裁决「不写母单」⇒ 默认 dry-run：
        # 只打印拟写入的节 + 与母单现有内容的差异；写盘/归档必须显式加 --write。
        # 判据与服务端 derivedOrigin.ts 同构：已含且内容一致 → 跳过写库（不重复追加）；
        # 不一致 → 只在原节上就地刷新（refreshMergedBody 语义），不再尾部另挂一节。
        # 用法：merge <派生单taskNo> <原单taskNo> <结论.md> [--write]
        write = "--write" in argv
        pos = [a for a in argv[1:] if a != "--write"]
        if len(pos) < 3:
            raise SystemExit("merge 用法：merge <派生单taskNo> <原单taskNo> <结论.md> [--write]")
        derived_no, origin_no, md_path = pos[0], pos[1], pos[2]
        sec = open(md_path, encoding="utf-8").read().strip()
        origin = unwrap(call(sid, "mtask_get_task", {"taskNo": origin_no}, 2))
        if not isinstance(origin, dict) or not origin.get("id"):
            raise SystemExit("未取到原单 %s 的内部 id，终止（避免误写）" % origin_no)
        prev = origin.get("handle_result") or ""
        today = datetime.date.today().isoformat()
        sections = find_merged_sections(prev, derived_no)
        if sections and merged_content_matches(prev, derived_no, sec):
            print("母单 %s 已含本单归并记录且内容一致，未重复追加（handle_result %d 字符不变）"
                  % (origin_no, len(prev)))
        else:
            merged = refresh_merged_body(prev, derived_no, sec, today)
            diff = "\n".join(difflib.unified_diff(
                prev.splitlines(), merged.splitlines(),
                fromfile="母单现有 handle_result", tofile="拟写入 handle_result", lineterm=""))
            print("--- 拟写入的节 ---")
            print("## 派生单回填 %s（%s）\n%s" % (derived_no, today, sec))
            print("--- 与母单现有内容的差异 ---")
            print(diff if diff else "（无差异）")
            if write:
                call(sid, "mtask_update_task_result", {"taskNo": origin_no, "result": merged}, 3)
                verb = "就地刷新" if sections else "追加"
                print("已%s归并到原单 %s：handle_result %d -> %d 字符（原单 status/verified 未改动）"
                      % (verb, origin_no, len(prev), len(merged)))
            else:
                print("dry-run：未写库、未回灌母单（R-333 不写母单；需要写盘请显式加 --write）")
        if write:
            # T00566 二轮：归并走 mtask_update_task_result → 服务端自动置 unread，脚本不再兜底
            derived = unwrap(call(sid, "mtask_get_task", {"taskNo": derived_no}, 2))
            if isinstance(derived, dict) and derived.get("id"):
                # 2026-09-15 用户裁决：归并完成后一律归档派生单（内容已一致时属幂等收口，同样归档）。
                unwrap(call(sid, "mtask_set_tasks_archived",
                            {"taskIds": [derived["id"]], "archived": True}, 4))
                print("已归档派生单:", derived_no)
            else:
                print("警告：未取到派生单 %s 的内部 id，未归档" % derived_no, file=sys.stderr)
        else:
            print("dry-run：未归档派生单 %s（加 --write 才归档）" % derived_no)
    elif mode == "status":
        # T00566：回写 AI 处理状态（running/failed/unread）——Agent 生命周期钩子
        print(json.dumps(unwrap(call(sid, "mtask_write_task_status",
                              {"taskNo": argv[1], "state": argv[2]}, 2)), ensure_ascii=False)[:600])
    elif mode == "progress":
        # T01351：执行会话心跳上报（PRD FR-1.2）——「执行会话」面板的唯一数据来源。
        # 此前 skill 只写任务 ai_state、从不上报会话，面板恒空（生产库 exec_sessions 0 行）。
        # 会话标识按任务缓存在 %TEMP%/mtask-progress-<taskNo>.txt：start 生成一次、ping/done/fail 复用，
        # 避免「每调一次就多一行会话」刷爆面板；也避免跨轮复用旧标识——服务端只支持
        # stalled/failed→active 复活，done 会话不会被新心跳拉回 active，故每次开工必须换新标识。
        # T01358：新增 fail 失败收口（T01356 服务端口径：failed:true 置会话 failed），
        # 异常/中断路径与任务侧 failed 口径对齐——否则只会停心跳，10 分钟后被误判「停滞」。
        if len(argv) < 3:
            raise SystemExit(
                "progress 用法：\n"
                "  progress start <taskNo> [phase]        开工上报（生成并缓存会话标识，可选阶段）\n"
                "  progress ping  <taskNo> <pct> [phase]  心跳续报（pct 需 0~100 整数）\n"
                "  progress done  <taskNo> [phase]        正常完工收口\n"
                "  progress fail  <taskNo> [原因]         异常收口（置 failed，原因写入 phase）")
        action, task_no = argv[1], argv[2]
        if action not in ("start", "ping", "done", "fail"):
            raise SystemExit("progress 动作需为 start / ping / done / fail，收到：" + action)
        # T01665：默认平台按脚本所在宿主目录推断（真实宿主），MTASK_PLATFORM 环境变量仍可显式覆盖
        _host_default = "trae" if ".trae-cn" in __file__ else ("qoder" if ".qoder-cn" in __file__ else "workbuddy")
        platform = os.environ.get("MTASK_PLATFORM", _host_default)
        cache = os.path.join(tempfile.gettempdir(), "mtask-progress-%s.txt" % task_no)
        if action == "start":
            sess_id = "%s-%s-%s" % (platform, task_no,
                                    datetime.datetime.now().strftime("%Y%m%d%H%M%S"))
            open(cache, "w", encoding="utf-8").write(sess_id)
        else:
            if not os.path.exists(cache):
                raise SystemExit("未找到 %s 的执行会话标识：请先执行 progress start %s" % (task_no, task_no))
            sess_id = open(cache, encoding="utf-8").read().strip()
        args = {"platform": platform, "session_id": sess_id, "task_id": task_no}
        rest = argv[3:]
        if action == "done":
            args["done"] = True
            args["phase"] = rest[0] if rest and rest[0] else "完工"
        elif action == "fail":
            # T01358：失败收口——phase 携带失败原因，供面板与决策层区分失败类型
            args["failed"] = True
            args["phase"] = rest[0] if rest and rest[0] else "执行失败"
        elif action == "start":
            # T01358：start 现接受可选 phase（此前阶段串会被当 pct 误报「需 0~100 整数」）
            if rest and rest[0]:
                args["phase"] = rest[0]
        else:  # ping
            if rest and rest[0]:
                try:
                    args["pct"] = int(rest[0])
                except ValueError:
                    raise SystemExit("pct 需为 0~100 整数，收到：" + rest[0])
            if len(rest) > 1 and rest[1]:
                args["phase"] = rest[1]
        res = unwrap(call(sid, "mtask_report_progress", args, 2))
        print(json.dumps(res, ensure_ascii=False)[:600])
        # 上报失败（unwrap 返回 None）时保留本地标识，便于重试；done/fail 成功后清缓存
        if action in ("done", "fail") and res is not None and os.path.exists(cache):
            os.remove(cache)
            print("执行会话已收口，本地标识已清除")
    elif mode == "raw":
        raw_args = json.loads(argv[2]) if len(argv) > 2 else {}
        print(json.dumps(call(sid, argv[1], raw_args, 2), ensure_ascii=False)[:4000])
        # T00566 二轮：**移除**写操作兜底——服务端已按接口语义自动驱动状态
        # （get_task→running / result→unread / done→unread / verified=false→failed）；
        # 此处强制 unread 会覆盖服务端的 failed（2026-09-15 实测踩坑）。
    else:
        raise SystemExit("未知模式: " + mode)


if __name__ == "__main__":
    main()
