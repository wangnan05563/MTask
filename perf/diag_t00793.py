"""T00793 诊断：逐个 AI 端点手动打一次，打印完整响应体，定位 400 真因。"""
import json, os, sqlite3, subprocess, time, urllib.request, urllib.error

REPO = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(REPO, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
MOCK = os.path.join(SRV, 'scripts', 'mock-ai-server.mjs')
SUT_PORT = 39931
MOCK_PORT = 18996
DATA = os.path.join(REPO, 'perf', 'sandbox', 't793d')
BASE = f'http://127.0.0.1:{SUT_PORT}'
TOOL_ID = 'tool-t793d'


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
    return subprocess.Popen(cmd, cwd=SRV, env=env, stdout=open(log, 'w', encoding='utf-8', errors='replace'),
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


def post(path, body, timeout=30):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')[:400]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:400]
    except Exception as e:
        return 0, str(e)[:300]


rmtree_safe(DATA)
os.makedirs(DATA, exist_ok=True)
import shutil as _sh
_sh.copy2(SRC, os.path.join(DATA, 'mtask.db'))

menv = dict(os.environ); menv['MOCK_PORT'] = str(MOCK_PORT)
mock = spawn([NODE, MOCK], menv, os.path.join(REPO, 'perf', 'sandbox', 't793d-mock.log'))
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
    (TOOL_ID, 'MockD', 'openai-compatible', 'develop', f'http://127.0.0.1:{MOCK_PORT}',
     'mock-key', 'mock-model', 0.2, 4096, 60000, 1, 1, 1, 0, now, now))
con.commit()
row = con.execute("SELECT id,endpoint,model,type,enabled FROM ai_tools WHERE id=?", (TOOL_ID,)).fetchone()
print('INSERTED ROW:', row)
task_ids = [r[0] for r in con.execute(
    "SELECT id FROM tasks WHERE archived=0 AND COALESCE(history_at,'')='' ORDER BY created_at DESC LIMIT 3")]
con.close()
print('task_ids:', task_ids)

senv = dict(os.environ); senv['MTask_PORT'] = str(SUT_PORT); senv['MTask_DATA_DIR'] = DATA
sut = spawn([NODE, os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
            senv, os.path.join(REPO, 'perf', 'sandbox', 't793d-sut.log'))
for _ in range(120):
    time.sleep(0.5)
    try:
        urllib.request.urlopen(f'{BASE}/api/tasks?limit=1', timeout=2).read(); break
    except Exception:
        pass

try:
    probes = [
        ('/api/aitools', 'POST', {}),
        (f'/api/aitools/{TOOL_ID}/models', 'POST', {}),
        ('/api/ai/chat', 'POST', {'toolId': TOOL_ID, 'user': 'hi'}),
        ('/api/ai/beautify', 'POST', {'toolId': TOOL_ID, 'title': '标题'}),
        ('/api/ai/optimize', 'POST', {'toolId': TOOL_ID, 'title': 't', 'description': 'd'}),
        ('/api/ai/simplify', 'POST', {'toolId': TOOL_ID, 'title': 't', 'description': 'd'}),
        ('/api/ai/organize', 'POST', {'taskIds': task_ids, 'toolId': TOOL_ID}),
        ('/api/tasks/classify', 'POST', {'title': 'x', 'categories': ['a', 'b'], 'toolId': TOOL_ID}),
    ]
    for path, method, body in probes:
        code, txt = post(path, body)
        print(f'{code}  {path:44} {txt}')
finally:
    kill(sut)
    kill(mock)
