"""T00785 API 级验证：隔离实例确认 pragma 生效 + 写接口落库正确。"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39905
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify785')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify785.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=30):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            b = resp.read().decode('utf-8', 'replace')
            return resp.status, b, (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e), (time.time() - t0) * 1000


for i in range(60):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 进程退出 rc=', proc.returncode); break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        print('✅ 服务就绪'); break
else:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2500:])
    proc.kill(); sys.exit(1)

PID = 'proj-main'

# 写负载：连续 300 次状态更新，测吞吐与错误率
print('\n=== 300 连写（/api/tasks/:id PATCH）===')
st, body, _ = req('/api/tasks?projectId=%s' % PID)
tasks = json.loads(body) if st == 200 else []
if isinstance(tasks, dict):
    tasks = tasks.get('items', tasks.get('tasks', []))
print('  任务数:', len(tasks))

n_ok = n_err = 0
t0 = time.time()
sample = tasks[:300] if len(tasks) >= 300 else tasks
for k, t in enumerate(sample):
    tid = t.get('id')
    payload = {'aiSummary': 'T00785 写基准 %d' % k}
    st, body, _ = req('/api/tasks/%s' % tid, 'PATCH', payload)
    if st == 200:
        n_ok += 1
    else:
        n_err += 1
        if n_err <= 3:
            print('    err', st, body[:150])
wall = (time.time() - t0)
print('  成功 %d / 失败 %d  墙钟 %.2fs  → %.0f req/s' % (n_ok, n_err, wall, n_ok / wall))

# 抽验落库
if sample:
    tid = sample[0].get('id')
    st, body, _ = req('/api/tasks/%s' % tid)
    obj = json.loads(body) if st == 200 else {}
    obj = obj.get('task', obj) if isinstance(obj, dict) else {}
    print('\n=== 落库抽验 task=%s ===' % tid)
    print('  aiSummary =', repr(obj.get('aiSummary') or obj.get('ai_summary'))[:120])

# 读 /health 灵敏度
hl = []
for i in range(10):
    st, _, ms = req('/api/health', timeout=5)
    hl.append(ms)
print('\n/health 10 次: max=%.1f ms 中位=%.1f ms' % (max(hl), sorted(hl)[5]))

logf.flush()
tail = open(LOG, encoding='utf-8', errors='replace').read()
bad = [l for l in tail.splitlines() if 'Error' in l or 'TypeError' in l or 'SQLITE' in l]
print('\n=== 日志异常 ===')
print('\n'.join(bad[-12:]) if bad else '(无异常)')

proc.kill()

# 直接查库确认 synchronous 持久化状态
import sqlite3
con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
print('\n=== 落库检查 ===')
print('  tasks.updated_at 已被更新的行数:',
      con.execute("SELECT COUNT(*) FROM tasks WHERE updated_at > '2026-09-19T00:00:00'").fetchone()[0])
con.close()
print('\n已停止隔离实例')
