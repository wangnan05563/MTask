import importlib.util, json, sys, os, re

SKILL = r"C:/Users/hspcadmin/.qoder-cn/skills/mtask/scripts/mcp-direct-call.py"
spec = importlib.util.spec_from_loader("m", None)
src = open(SKILL, encoding="utf-8").read()
mod = {}
exec(compile(src.split("def main(")[0], SKILL, "exec"), mod)
ensure_session, call, unwrap = mod["ensure_session"], mod["call"], mod["unwrap"]

SID = ensure_session()


def tool(name, args):
    res = call(SID, name, args, 3)
    if res is None:
        return None
    if isinstance(res, (dict, list)):
        sc = res.get("structuredContent") if isinstance(res, dict) else None
        if sc is not None:
            res = sc
        else:
            text = "\n".join(i.get("text", "") for i in res.get("content", [])
                             if i.get("type") == "text")
            m = re.search(r"[\[{]", text)
            res = json.loads(text[m.start():]) if m else text
    if isinstance(res, str):
        m = re.search(r"[\[{]", res)
        if m:
            try:
                res = json.loads(res[m.start():])
            except Exception:
                pass
    return res


def rpc(name, args):
    res = call(SID, name, args, 3)
    if isinstance(res, dict) and res.get("isError"):
        print("ERR", json.dumps(res, ensure_ascii=False)[:600])
        return None
    if isinstance(res, dict):
        return "\n".join(i.get("text", "") for i in res.get("content", []) if i.get("type") == "text")
    return str(res)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "tasks":
        d = tool("mtask_list_tasks", {"projectName": sys.argv[2]})
        json.dump(d, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("saved", len(d))
    elif cmd == "prd":
        out = rpc("mtask_get_prd", json.loads(sys.argv[2]))
        open(sys.argv[3], "w", encoding="utf-8").write(out or "")
        print("prd chars", len(out or ""))
    elif cmd == "detail":
        out = rpc("mtask_get_task", {"taskNo": sys.argv[2]})
        print(out[:6000])
    elif cmd == "result":
        print(rpc("mtask_update_task_result",
                  {"taskNo": sys.argv[2], "result": open(sys.argv[3], encoding="utf-8").read()})[:600])
    elif cmd == "call":
        print(rpc(sys.argv[2], json.loads(sys.argv[3]))[:6000])
