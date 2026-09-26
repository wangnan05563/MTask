"""T00791 端到端验收 v2：造数据 → 关联 → 解除关联（覆盖修复 2 的 splice 分支）。"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
PORT = 39903
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify791c')
PROD_DB_DIR = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
src_db = os.path.join(PROD_DB_DIR, 'mtask.db')
if os.path.exists(src_db):
    shutil.copy2(src_db, os.path.join(DATA, 'mtask.db'))

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
env['NODE_ENV'] = 'development'
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify791c.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=20):
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


for i in range(60):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 进程退出 rc=', proc.returncode); break
    st, _ = req('/api/health', timeout=3)
    if st == 200:
        print('✅ 服务就绪'); break
else:
    print('!! 未就绪'); proc.kill(); sys.exit(1)

PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'  # mtask 项目

# 造一条需求
st, body = req('/api/plans/prd-requirements', 'POST',
               {'projectId': PID, 'title': 'T00791 验收临时需求', 'reqNo': 'TMP-791',
                'content': '验证解除关联路径', 'priority': 'P1'})
print('\n[0] 创建需求 ->', st, body[:300])
try:
    created = json.loads(body)
except Exception:
    created = {}
RID = created.get('id') or (created.get('requirement') or {}).get('id')

# 取任务
st, tb = req('/api/tasks?projectId=%s' % PID)
tasks = json.loads(tb) if st == 200 else []
if isinstance(tasks, dict):
    tasks = tasks.get('items', tasks.get('tasks', []))
print('    任务数 =', len(tasks))

st, pb = req('/api/plans?projectId=%s' % PID)
plans = json.loads(pb) if st == 200 else []
if isinstance(plans, dict):
    plans = plans.get('items', plans.get('plans', []))
print('    计划数 =', len(plans))

steps = {}
if RID and tasks:
    tid = tasks[0].get('id')

    # 建立关联
    st, body = req('/api/plans/prd-requirements/%s/link' % RID, 'POST',
                   {'kind': 'task', 'targetId': tid, 'linked': True})
    steps['link'] = {'status': st, 'body': body[:200]}
    print('\n[1] 建立关联 ->', st, body[:200])

    st, body = req('/api/plans/prd-requirements?projectId=%s' % PID)
    rs = json.loads(body) if st == 200 else []
    if isinstance(rs, dict):
        rs = rs.get('items', rs.get('requirements', []))
    tgt = next((x for x in rs if x.get('id') == RID), None)
    print('    关联后:', json.dumps(tgt, ensure_ascii=False)[:500] if tgt else '?')
    steps['after_link'] = tgt

    # 解除关联 —— 修复 2 核心（原代码 `ids = ids.filter(...)` 对 const 赋值 → TypeError/500）
    st, body = req('/api/plans/prd-requirements/%s/link' % RID, 'POST',
                   {'kind': 'task', 'targetId': tid, 'linked': False})
    steps['unlink'] = {'status': st, 'body': body[:300]}
    print('\n[2] 解除关联 ->', st, body[:300])
    print('    ==> 结论:', '✅ 200 修复生效' if st == 200 else '❌ 失败 %s' % st)

    st, body = req('/api/plans/prd-requirements?projectId=%s' % PID)
    rs = json.loads(body) if st == 200 else []
    if isinstance(rs, dict):
        rs = rs.get('items', rs.get('requirements', []))
    tgt = next((x for x in rs if x.get('id') == RID), None)
    print('    解除后:', json.dumps(tgt, ensure_ascii=False)[:500] if tgt else '?')
    steps['after_unlink'] = tgt

    # 再关联一次（确认可重复）
    st, body = req('/api/plans/prd-requirements/%s/link' % RID, 'POST',
                   {'kind': 'task', 'targetId': tid, 'linked': True})
    print('\n[3] 再次关联 ->', st, body[:200])
    steps['relink'] = {'status': st, 'body': body[:200]}

# 清理临时需求
if RID:
    st, body = req('/api/plans/prd-requirements/%s' % RID, 'DELETE')
    print('\n[4] 清理临时需求 ->', st, body[:150])

print('\n=== 日志异常 ===')
logf.flush()
tail = open(LOG, encoding='utf-8', errors='replace').read()
bad = [l for l in tail.splitlines() if ('Error' in l) or ('TypeError' in l)]
print('\n'.join(bad[-12:]) if bad else '(无异常)')

json.dump(steps, open(os.path.join(ROOT, 'perf', 'sandbox', 'verify791c.result.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
proc.kill()
print('已停止隔离实例')
