"""T00784 API 级验证：隔离实例 + 真实大数据量，测端点响应时间与结构。"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')  # 已补种关联
PORT = 39904
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify784')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
env['NODE_ENV'] = 'development'
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify784.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=60):
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
    print('!! 未就绪')
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2000:])
    proc.kill(); sys.exit(1)

PID = 'proj-main'

print('\n=== 连续 5 次 GET /api/plans/prd-requirements ===')
times = []
for i in range(5):
    st, body, ms = req('/api/plans/prd-requirements?projectId=%s' % PID)
    arr = json.loads(body) if st == 200 else []
    if isinstance(arr, dict):
        arr = arr.get('items', arr.get('requirements', []))
    times.append(ms)
    print('  [%d] status=%s 耗时=%.1f ms 需求数=%d 响应体=%d B' % (i + 1, st, ms, len(arr), len(body)))

print('\n  中位耗时: %.1f ms' % sorted(times)[len(times) // 2])
print('  最慢: %.1f ms  最快: %.1f ms' % (max(times), min(times)))

# 并发 4 路验证不再互相拖垮
print('\n=== 并发 4 路（验证事件循环不再被长任务垄断）===')
import threading
res = []


def worker(k):
    st, body, ms = req('/api/plans/prd-requirements?projectId=%s' % PID)
    res.append((k, st, ms))


ths = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
t0 = time.time()
for t in ths:
    t.start()
for t in ths:
    t.join()
wall = (time.time() - t0) * 1000
print('  4 路并发墙钟: %.1f ms' % wall)
for k, st, ms in sorted(res):
    print('    #%d status=%s %.1f ms' % (k, st, ms))

# 并发期间 /health 是否受拖累（改造前会被拖到 300ms+）
print('\n=== 并发期间 /health 延迟（灵敏度探针）===')
hl = []
for i in range(5):
    st, _, ms = req('/api/health', timeout=5)
    hl.append(ms)
    time.sleep(0.05)
print('  /health 耗时:', ['%.1f' % x for x in hl], 'max=%.1f ms' % max(hl))

logf.flush()
tail = open(LOG, encoding='utf-8', errors='replace').read()
bad = [l for l in tail.splitlines() if 'Error' in l or 'TypeError' in l]
print('\n=== 日志异常 ===')
print('\n'.join(bad[-10:]) if bad else '(无异常)')

proc.kill()
print('\n已停止隔离实例')
