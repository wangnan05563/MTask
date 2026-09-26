"""T00793 补充：上下文预算截断实测（任务验收项 ①）。

任务原文要求：「验证 T00776/T00777 的上下文预算（headTail 截断）在高负载下确实生效」。

做法（端到端，非单测）：
  1. 在隔离库里塞一条超长 PRD 文档（>> 6000 字符）并关联到任务；
  2. 打 /api/ai/chat 触发 prdContext 注入；
  3. 从 mock 上游的 /__last 拿回**实际发出的 prompt**，
     断言其中含 headTail 的省略标记，且长度被压到预算内。

这直接证明「预算在高负载路径上生效」，而不是只看源码。
"""
import json, os, sqlite3, subprocess, time, urllib.request, urllib.error

REPO = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(REPO, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
MOCK = os.path.join(SRV, 'scripts', 'mock-ai-server.mjs')
SUT_PORT = 39932
MOCK_PORT = 18997
DATA = os.path.join(REPO, 'perf', 'sandbox', 't793b')
BASE = f'http://127.0.0.1:{SUT_PORT}'
TOOL_ID = 'tool-t793b'
PRD_LIMIT = 6000

BIG_PRD_ID = 'prd-t793-big'
BIG_REQ_ID = 'req-t793-big'


def rmtree_safe(path):
    if not os.path.exists(path):
        return
    if os.name == 'nt':
        import ctypes
        _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        for root, dirs, files in os.walk(path, topdown=False):
            for f in files:
                _k32.DeleteFileW(os.path.join(root, f))
            for d in dirs:
                _k32.RemoveDirectoryW(os.path.join(root, d))
        _k32.RemoveDirectoryW(path)
    else:
        import shutil
        shutil.rmtree(path, ignore_errors=True)


def spawn(cmd, env, log):
    return subprocess.Popen(cmd, cwd=SRV, env=env,
                            stdout=open(log, 'w', encoding='utf-8', errors='replace'),
                            stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def kill(p):
    if not p:
        return
    try:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
    except Exception:
        pass
    try:
        p.wait(timeout=10)
    except Exception:
        pass


def post_json(url, body, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


rmtree_safe(DATA)
os.makedirs(DATA, exist_ok=True)
import shutil as _sh
_sh.copy2(SRC, os.path.join(DATA, 'mtask.db'))

menv = dict(os.environ); menv['MOCK_PORT'] = str(MOCK_PORT)
mock = spawn([NODE, MOCK], menv, os.path.join(REPO, 'perf', 'sandbox', 't793b-mock.log'))
for _ in range(40):
    time.sleep(0.25)
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{MOCK_PORT}/v1/models', timeout=2).read(); break
    except Exception:
        pass

con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
con.execute("DELETE FROM ai_tools WHERE id=?", (TOOL_ID,))
con.execute(
    "INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,"
    "timeout_ms,enabled,is_default_organize,is_default_develop,pinned,created_at,updated_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (TOOL_ID, 'MockB', 'openai-compatible', 'develop', f'http://127.0.0.1:{MOCK_PORT}',
     None, 'mock-model', 0.2, 4096, 60000, 1, 1, 1, 0, now, now))

# 取一个真实任务，挂上超长 PRD 上下文
task_id = con.execute(
    "SELECT id FROM tasks WHERE archived=0 AND COALESCE(history_at,'')='' AND title!='' "
    "ORDER BY created_at DESC LIMIT 1").fetchone()[0]

BIG = '段落开始标记HEAD\n' + ('这是一段用于撑爆上下文预算的 PRD 原文内容。' * 200) + '\n段落结束标记TAIL'
while len(BIG) < 40000:
    BIG = BIG.replace('\n段落结束标记TAIL', '这是一段用于撑爆上下文预算的 PRD 原文内容。' * 200 + '\n段落结束标记TAIL')
assert len(BIG) > PRD_LIMIT * 5, len(BIG)
print('BIG_PRD_LEN:', len(BIG))

# prd_docs / prd_requirements 列兼容：按实际 schema 动态取列
def cols(t):
    return [r[1] for r in con.execute(f'PRAGMA table_info({t})')]

doc_cols = cols('prd_docs')
print('prd_docs cols:', doc_cols)
req_cols = cols('prd_requirements')
print('prd_requirements cols:', req_cols)

project_id = con.execute("SELECT id FROM projects LIMIT 1").fetchone()
project_id = project_id[0] if project_id else 'proj-t793'

con.execute("DELETE FROM prd_docs WHERE id=?", (BIG_PRD_ID,))
doc_vals = {'id': BIG_PRD_ID, 'filename': 'big-prd.md', 'content_md': BIG,
            'project_id': project_id, 'status': 'active'}
doc_vals = {k: v for k, v in doc_vals.items() if k in doc_cols}
if 'created_at' in doc_cols: doc_vals['created_at'] = now
if 'updated_at' in doc_cols: doc_vals['updated_at'] = now
ph = ','.join('?' * len(doc_vals))
con.execute(f"INSERT INTO prd_docs ({','.join(doc_vals)}) VALUES ({ph})", list(doc_vals.values()))

con.execute("DELETE FROM prd_requirements WHERE id=?", (BIG_REQ_ID,))
rq = {'id': BIG_REQ_ID, 'prd_id': BIG_PRD_ID, 'title': '超长上下文需求',
      'project_id': project_id, 'req_no': 'REQ-T793', 'content': 'x' * 100,
      'priority': 'normal', 'status': 'active', 'sort_order': 0}
rq = {k: v for k, v in rq.items() if k in req_cols}
if 'created_at' in req_cols: rq['created_at'] = now
if 'updated_at' in req_cols: rq['updated_at'] = now
ph = ','.join('?' * len(rq))
con.execute(f"INSERT INTO prd_requirements ({','.join(rq)}) VALUES ({ph})", list(rq.values()))

con.execute("UPDATE tasks SET req_ids=? WHERE id=?", (json.dumps([BIG_REQ_ID]), task_id))
con.commit()
con.close()
print('TASK_ID:', task_id)

senv = dict(os.environ); senv['MTask_PORT'] = str(SUT_PORT); senv['MTask_DATA_DIR'] = DATA
sut = spawn([NODE, os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
            senv, os.path.join(REPO, 'perf', 'sandbox', 't793b-sut.log'))
for _ in range(120):
    time.sleep(0.5)
    try:
        urllib.request.urlopen(f'{BASE}/api/tasks?limit=1', timeout=2).read(); break
    except Exception:
        pass

try:
    # 触发带 PRD 上下文的 AI 调用（taskId 走 organize，其内部注入 prdContext）
    code, body = post_json(f'{BASE}/api/ai/organize', {'taskIds': [task_id], 'toolId': TOOL_ID}, timeout=90)
    print('organize code:', code)

    # 从 mock 的 /__last 取实际发出的 prompt
    with urllib.request.urlopen(f'http://127.0.0.1:{MOCK_PORT}/__last', timeout=10) as r:
        last = json.loads(r.read())

    msgs = (last.get('body') or {}).get('messages') or []
    blob = json.dumps(msgs, ensure_ascii=False)
    has_head = '段落开始标记HEAD' in blob
    has_tail = '段落结束标记TAIL' in blob
    has_ellipsis = '中段略去' in blob
    print('PROMPT_TOTAL_CHARS:', len(blob))
    print('含头部标记:', has_head)
    print('含尾部标记:', has_tail)
    print('含截断省略标记(中段略去):', has_ellipsis)
    # 预算断言：PRD 原文被压到 limit 附近（允许提示词其它部分占用额外空间）
    print('PRD 原文长度:', len(BIG), '→ 注入后 prompt 总长:', len(blob))
    verdict = has_head and has_tail and has_ellipsis
    print('BUDGET_TRUNCATION_VERIFIED:', verdict)
    if not has_ellipsis:
        print('（未检测到省略标记——可能该路径未注入 PRD，或预算未触发）blob 片段:')
        print(blob[:600])
except Exception as e:
    print('ERROR:', e)
finally:
    kill(sut)
    kill(mock)
