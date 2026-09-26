"""T00786/T00782/T00790 API 级验证：隔离实例 + 大工作空间，验证 HTTP 端点行为与落库。"""
import json, os, shutil, sqlite3, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
TSX = os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-big').replace('\\', '/')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws_api')
PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'
PROD_DB = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data', 'mtask.db')
PORT = 39910

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA)
shutil.copy2(PROD_DB, os.path.join(DATA, 'mtask.db'))
con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
cols = [r[1] for r in con.execute('PRAGMA table_info(projects)')]
if 'workspace_path' not in cols:
    con.execute('ALTER TABLE projects ADD COLUMN workspace_path TEXT')
con.execute('UPDATE projects SET workspace_path = ? WHERE id = ?', (WS, PID))
con.commit()
con.close()

env = dict(os.environ)
env['MTask_DATA_DIR'] = DATA
env['MTASK_DATA_DIR'] = DATA
env['MTask_PORT'] = str(PORT)
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws_api.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, TSX, 'src/index.ts'], cwd=os.path.join(ROOT, 'server'), env=env,
                        stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=120):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e), (time.time() - t0) * 1000


for i in range(80):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 退出 rc=', proc.returncode); break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        print('✅ 服务就绪'); break
else:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2000:])
    proc.kill(); sys.exit(1)

import urllib.parse
P = urllib.parse.quote(PID)

print('\n=== [T00786] GET /workspace/search ===')
cases = [
    ('无命中关键词', 'zzzz_not_exist_zzzz'),
    ('弱命中', 'mod07Fn099'),
    ('强命中', 'export const v'),
    ('常规', 'return'),
]
for label, q in cases:
    st, body, ms = req('/api/workspace/search?projectId=%s&q=%s' % (P, urllib.parse.quote(q)))
    try:
        o = json.loads(body)
        print('  %-8s status=%s %.1fms count=%s partial=%s scannedFiles=%s' % (
            label, st, ms, o.get('count'), o.get('partial'), o.get('scannedFiles')))
    except Exception:
        print('  %-8s status=%s %.1fms body=%s' % (label, st, ms, body[:150]))

print('\n=== [T00782/T00790] POST /workspace/symbols/refresh ===')
st, body, ms = req('/api/workspace/symbols/refresh', 'POST', {'projectId': PID})
print('  冷建 status=%s %.1fms %s' % (st, ms, body[:200]))
st, body, ms = req('/api/workspace/symbols/refresh', 'POST', {'projectId': PID})
print('  温重建 status=%s %.1fms %s' % (st, ms, body[:200]))

print('\n=== 符号查询 GET /workspace/symbols ===')
st, body, ms = req('/api/workspace/symbols?projectId=%s&q=mod07Fn099&limit=5' % P)
print('  status=%s %.1fms count=%s' % (st, ms, len(json.loads(body)) if st == 200 else '?'))

print('\n=== /health 灵敏度（检索后）===')
hl = []
for i in range(8):
    st, _, ms = req('/api/health', timeout=5)
    hl.append(ms)
print('  max=%.1f ms 中位=%.1f ms' % (max(hl), sorted(hl)[4]))

logf.flush()
tail = open(LOG, encoding='utf-8', errors='replace').read()
bad = [l for l in tail.splitlines() if 'Error' in l or 'TypeError' in l]
print('\n=== 日志异常 ===')
print('\n'.join(bad[-10:]) if bad else '(无异常)')

proc.kill()
print('\n已停止隔离实例')
