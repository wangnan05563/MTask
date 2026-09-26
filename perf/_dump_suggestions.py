# 提取任务标题/状态/描述/结论中的【下一步建议】段
import io, json, os, re, tempfile, urllib.request

def load_endpoint():
    cfg = json.load(open(os.path.join(os.path.expanduser("~"), ".workbuddy", "mcp.json"), encoding="utf-8"))
    for name, c in cfg.get("mcpServers", {}).items():
        if "mtask" in name.lower() and c.get("url"):
            token = None
            for v in list((c.get("headers") or {}).values()) + list((c.get("env") or {}).values()):
                if isinstance(v, str) and ("token" in v.lower() or len(v) in (32, 36, 48, 64)):
                    token = v; break
            return c["url"], token
    raise SystemExit("mcp.json 未找到 mtask")

URL, TOKEN = load_endpoint()
sf = os.path.join(tempfile.gettempdir(), "mtask-session.txt")
if os.path.exists(sf): os.remove(sf)

def post(p, s=None, t=30):
    b = json.dumps(p, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(URL, data=b, method="POST")
    r.add_header("Content-Type", "application/json")
    r.add_header("Accept", "application/json, text/event-stream")
    if TOKEN: r.add_header("X-Access-Token", TOKEN)
    if s: r.add_header("Mcp-Session-Id", s)
    res = urllib.request.urlopen(r, timeout=t)
    return res.status, res.headers.get("mcp-session-id"), res.read().decode("utf-8", "replace")

def pb(raw):
    if not raw.strip(): return None
    if raw.lstrip().startswith("{"):
        o = json.loads(raw); return o.get("result", o) if isinstance(o, dict) else o
    for line in reversed(re.findall(r"^data:\s*(.*)$", raw, re.M)):
        line=line.strip()
        if not line or line=="[DONE]": continue
        try: o=json.loads(line)
        except Exception: continue
        if isinstance(o,dict) and ("result" in o or "error" in o): return o.get("result",o)
    return None

def unwrap(r): return r["result"] if isinstance(r,dict) and "result" in r else r

st,sid,_ = post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"1.0.0"}}})
post({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}, sid)

for no in ["T00789","T00797"]:
    st,sid,res = post({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mtask_get_task","arguments":{"taskNo":no}}}, sid)
    t = unwrap(pb(res))
    if isinstance(t,dict) and "content" in t:
        t = json.loads(t["content"][0]["text"])
    print("="*70)
    print("NO:", no, "| title:", t.get("title"), "| status:", t.get("status"), "| verified:", t.get("verified"), "| prio:", t.get("priority"))
    print("--- DESCR ---")
    print((t.get("description") or "")[:1500])
    hr = t.get("handle_result") or ""
    # 提取 下一步建议 段
    m = re.search(r"## 下一步建议(.*?)(?=\n## |\Z)", hr, re.S)
    print("--- 下一步建议 ---")
    print((m.group(0) if m else "(无下一步建议段)").strip())
    print("--- handle_result 尾部 ---")
    print(hr[-1200:])