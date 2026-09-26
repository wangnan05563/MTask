"""T00791 验收：隔离实例启动 + 「需求矩阵-解除关联」冒烟。
隔离：MTask_PORT=39901 + MTask_DATA_DIR=perf/sandbox/verify791（复制生产库样本，绝不碰生产）。
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
PORT = 39901
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify791')
PROD_DB_DIR = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
# 复制生产库（含真实 schema + 数据），只读用途
src_db = os.path.join(PROD_DB_DIR, 'mtask.db')
if os.path.exists(src_db):
    shutil.copy2(src_db, os.path.join(DATA, 'mtask.db'))
    print('已复制生产库样本:', src_db)
else:
    print('!! 生产库不存在，将走空库初始化')

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
env['MTASK_DATA_DIR'] = DATA
env['NODE_ENV'] = 'development'

logf = open(os.path.join(ROOT, 'perf', 'sandbox', 'verify791.log'), 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen(
    [NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
    cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
print('PID', proc.pid)


def req(path, method='GET', body=None, timeout=10):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, str(e)


# 等待就绪
ok = False
for i in range(60):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 进程已退出，rc =', proc.returncode)
        break
    st, body = req('/api/health', timeout=3)
    if st == 200:
        print('健康检查 OK:', body[:200])
        ok = True
        break
if not ok:
    print('=== 启动日志尾部 ===')
    logf.flush()
    print(open(os.path.join(ROOT, 'perf', 'sandbox', 'verify791.log'),
               encoding='utf-8', errors='replace').read()[-3000:])
    proc.kill()
    sys.exit(1)

# 冒烟 1：需求矩阵（listRequirements 承载端点）
st, body = req('/api/plans/prd-requirements')
print('\n[1] GET /api/plans/prd-requirements ->', st, 'len=', len(body))
try:
    arr = json.loads(body)
    n = len(arr if isinstance(arr, list) else arr.get('items', arr.get('requirements', [])))
    print('    条目数 =', n)
except Exception as e:
    print('    解析失败:', e, body[:300])

# 冒烟 2：找一条带关联的需求 → 解除关联（T00791 核心验收）
st, body = req('/api/plans/prd-requirements')
linked = None
try:
    arr = json.loads(body)
    items = arr if isinstance(arr, list) else arr.get('items', arr.get('requirements', []))
    for it in items:
        if it.get('linked'):
            linked = it
            break
except Exception:
    pass
print('\n[2] 带关联需求样本:', json.dumps(linked, ensure_ascii=False)[:400] if linked else '无')

if linked:
    rid = linked.get('id') or linked.get('reqId')
    st, body = req('/api/plans/requirements/%s/unlink' % rid, method='POST', body={})
    print('    POST unlink ->', st, body[:300])
else:
    print('    跳过 unlink（无带关联需求）')

print('\n=== 启动日志尾部（查异常）===')
logf.flush()
tail = open(os.path.join(ROOT, 'perf', 'sandbox', 'verify791.log'),
            encoding='utf-8', errors='replace').read()
errs = [l for l in tail.splitlines() if 'Error' in l or 'error' in l.lower()[:40]]
print('\n'.join(errs[-15:]) if errs else '(无 Error 行)')
print('--- 尾部 1500 字符 ---')
print(tail[-1500:])

proc.kill()
print('\n已停止隔离实例')
