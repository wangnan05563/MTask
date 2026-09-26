"""通过 MCP raw 调用 mtask_list_tasks，拿全量待办（不受脚本 8000 字符截断）。"""
import json, os, re, sys, tempfile, urllib.request, urllib.error

sys.path.insert(0, r'C:/Users/hspcadmin/.workbuddy/skills/mtask/scripts')
import importlib.util
spec = importlib.util.spec_from_file_location(
    "mdc", r'C:/Users/hspcadmin/.workbuddy/skills/mtask/scripts/mcp-direct-call.py')
# 直接复用其函数（注意该脚本 import 时不会执行 main）
mdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mdc)

sid = mdc.ensure_session()
res = mdc.call(sid, "mtask_list_tasks", {"projectName": "mtask"}, 2)
obj = mdc.unwrap(res)
if isinstance(obj, str):
    print(obj[:2000]); sys.exit(1)
tasks = obj if isinstance(obj, list) else obj.get('tasks', [])
print('TOTAL', len(tasks))
out = []
for t in tasks:
    out.append({
        'no': t.get('task_no'), 'status': t.get('status'), 'verified': t.get('verified'),
        'archived': t.get('archived'), 'priority': t.get('priority'),
        'title': t.get('title'), 'desc': (t.get('description') or '')[:500],
        'id': t.get('id'), 'derived_from': t.get('derived_from'),
        'handle_result_len': len(t.get('handle_result') or ''),
    })
json.dump(out, open(r'D:/code/otherProjects/26_MTask/perf/_mtlist_full.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
for t in out:
    print('%-7s %-6s v=%-5s arch=%-5s %-7s | %s' % (
        t['no'], t['status'], t['verified'], t['archived'], t['priority'], t['title']))
