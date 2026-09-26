# -*- coding: utf-8 -*-
"""全量抓取待办任务（绕过 mcp-direct-call list 的 [:8000] 输出截断），并映射项目名。"""
import json, os, re, sys, tempfile, urllib.error, urllib.request

URL, TOKEN = None, None
SESSION_FILE = os.path.join(tempfile.gettempdir(), "mtask-session.txt")


def load_endpoint():
    env_url = os.environ.get('MTASK_MCP_URL')
    env_token = os.environ.get('MTASK_MCP_TOKEN')
    if env_url:
        return env_url, (env_token or '')
    cfg = json.load(open(os.path.join(os.path.expanduser("~"), ".workbuddy", "mcp.json"), encoding="utf-8"))
    for name, c in cfg.get("mcpServers", {}).items():
        if "mtask" in name.lower() and c.get("url"):
            token = None
            for v in list((c.get("headers") or {}).values()) + list((c.get("env") or {}).values()):
                if isinstance(v, str) and ("token" in v.lower() or len(v) in (32, 36, 48, 64)):
                    token = v
                    break
            return c["url"], token
    raise SystemExit("no mtask server")


URL, TOKEN = load_endpoint()


def post(payload, session=None, timeout=30):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if TOKEN:
        req.add_header("X-Access-Token", TOKEN)
    if session:
        req.add_header("Mcp-Session-Id", session)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %s: %s" % (e.code, e.read()[:400].decode("utf-8", "replace")))
    sid = resp.headers.get("mcp-session-id") or resp.headers.get("Mcp-Session-Id")
    return resp.status, sid, resp.read().decode("utf-8", "replace")


def parse_body(raw):
    if raw.lstrip().startswith("{"):
        obj = json.loads(raw)
        return obj.get("result", obj) if isinstance(obj, dict) else obj
    # SSE：拼接全部 data 行（可能是分块）再解析，避免大响应截断
    lines = [l.strip() for l in re.findall(r"^data:\s*(.*)$", raw, re.M) if l.strip() and l.strip() != "[DONE]"]
    if not lines:
        return None
    if len(lines) == 1:
        obj = json.loads(lines[0])
        if isinstance(obj, dict) and ("result" in obj or "error" in obj):
            return obj.get("result", obj)
    # 多片段：若每行是独立 JSON-RPC message，取含 result 的最后一条；否则尝试整体拼接
    for ln in reversed(lines):
        try:
            obj = json.loads(ln)
        except Exception:
            continue
        if isinstance(obj, dict) and ("result" in obj or "error" in obj):
            return obj.get("result", obj)
    try:
        return json.loads("".join(lines))
    except Exception:
        return None


def ensure_session(_retried=False):
    if os.path.exists(SESSION_FILE):
        sid = open(SESSION_FILE, encoding="utf-8").read().strip()
        if sid:
            try:
                st, _, raw = post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "workbuddy-agent", "version": "1.0"}}}, session=sid)
                if st == 200:
                    return sid
            except SystemExit:
                pass
            try:
                os.remove(SESSION_FILE)
            except OSError:
                pass
    st, sid, raw = post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "workbuddy-agent", "version": "1.0"}}})
    open(SESSION_FILE, "w").write(sid)
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session=sid)
    return sid


def call(session, name, args, rid=1, _retried=False):
    st, sid, raw = post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                         "params": {"name": name, "arguments": args}}, session=session)
    if st in (400, 404) and 'no valid session' in raw and not _retried:
        try:
            os.remove(SESSION_FILE)
        except OSError:
            pass
        return call(ensure_session(), name, args, rid=rid, _retried=True)
    if st in (400, 404):
        raise SystemExit("tools/call HTTP %s: %s" % (st, raw[:400]))
    return parse_body(raw)


def unwrap(res):
    if res is None:
        return None
    if res.get("isError"):
        return None
    text = "\n".join(i.get("text", "") for i in res.get("content", []) if i.get("type") == "text")
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\[.*\]|\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return text
        return text


sid = ensure_session()
tasks = unwrap(call(sid, "mtask_list_tasks", {}, 2))
if not isinstance(tasks, list):
    print("!! mtask_list_tasks 返回非数组:", type(tasks));
    sys.exit(1)
projects = unwrap(call(sid, "mtask_list_projects", {}, 2))
pname = {}
if isinstance(projects, list):
    for p in projects:
        if isinstance(p, dict) and p.get("id"):
            pname[p["id"]] = p.get("name", "")
with open(r'D:/code/otherProjects/26_MTask/perf/_mt_pending_full.json', 'w', encoding='utf-8') as f:
    json.dump({"tasks": tasks, "projects": pname}, f, ensure_ascii=False, indent=1)
print('已写入 %d 个任务' % len(tasks))
print('待处理+未验证:')
for t in tasks:
    if t.get('status') != 'done' or t.get('verified') is False:
        print('  - %s | status=%s verified=%s state=%s | 项目=%s | %s' % (
            t.get('task_no') or t.get('id')[:8], t.get('status'), t.get('verified'),
            repr(t.get('ai_state')), pname.get(t['project_id'], t['project_id'][:8]),
            (t.get('title') or '')[:50]))