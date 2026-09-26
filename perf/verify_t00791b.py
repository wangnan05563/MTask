"""T00791 端到端验收：隔离实例 + 需求关联/解除关联全链路 + listRequirements 结构。
隔离：MTask_PORT=39902 + MTask_DATA_DIR=perf/sandbox/verify791b
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
PORT = 39902
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify791b')
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
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify791b.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=15):
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

# 取项目
st, body = req('/api/projects')
projects = json.loads(body) if st == 200 else []
if isinstance(projects, dict):
    projects = projects.get('items', projects.get('projects', []))
print('项目数:', len(projects))
p = None
for x in projects:
    if x.get('name') == 'mtask':
        p = x; break
if not p and projects:
    p = projects[0]
print('使用项目:', p.get('name'), p.get('id'))
PID = p['id']

# 列出需求
st, body = req('/api/plans/prd-requirements?projectId=%s' % PID)
print('\n[1] listRequirements ->', st, 'len=', len(body))
reqs = json.loads(body) if st == 200 else []
if isinstance(reqs, dict):
    reqs = reqs.get('items', reqs.get('requirements', []))
print('    需求数 =', len(reqs))
if reqs:
    s = reqs[0]
    print('    字段:', sorted(s.keys()))
    print('    样本:', json.dumps({k: s.get(k) for k in ('id', 'req_no', 'reqNo', 'title', 'linked', 'linkedPlans', 'linkedTasks', 'plans', 'tasks') if k in s}, ensure_ascii=False)[:400])

# 取任务/计划做关联目标
st, tb = req('/api/tasks?projectId=%s' % PID)
tasks = json.loads(tb) if st == 200 else []
if isinstance(tasks, dict):
    tasks = tasks.get('items', tasks.get('tasks', []))
print('\n[2] 任务数 =', len(tasks))

st, pb = req('/api/plans?projectId=%s' % PID)
plans = json.loads(pb) if st == 200 else []
if isinstance(plans, dict):
    plans = plans.get('items', plans.get('plans', []))
print('    计划数 =', len(plans))

result = {}
if reqs and tasks:
    rid = reqs[0].get('id')
    tid = tasks[0].get('id')
    print('\n[3] 建立关联: req=%s task=%s' % (rid, tid))
    st, body = req('/api/plans/prd-requirements/%s/link' % rid, 'POST',
                   {'kind': 'task', 'targetId': tid, 'linked': True})
    result['link'] = (st, body[:200])
    print('    POST link ->', st, body[:200])

    st, body = req('/api/plans/prd-requirements?projectId=%s' % PID)
    rs = json.loads(body) if st == 200 else []
    if isinstance(rs, dict):
        rs = rs.get('items', rs.get('requirements', []))
    tgt = next((x for x in rs if x.get('id') == rid), None)
    print('    关联后 linked 字段:', json.dumps(tgt, ensure_ascii=False)[:400] if tgt else '?')

    print('\n[4] 解除关联（T00791 修复 2 核心路径）')
    st, body = req('/api/plans/prd-requirements/%s/link' % rid, 'POST',
                   {'kind': 'task', 'targetId': tid, 'linked': False})
    result['unlink'] = (st, body[:300])
    ok = (st == 200)
    print('    POST unlink ->', st, body[:300])
    print('    ==> 解除关联结果:', '✅ 200（修复生效，不再 500）' if ok else '❌ %s' % st)

    st, body = req('/api/plans/prd-requirements?projectId=%s' % PID)
    rs = json.loads(body) if st == 200 else []
    if isinstance(rs, dict):
        rs = rs.get('items', rs.get('requirements', []))
    tgt = next((x for x in rs if x.get('id') == rid), None)
    print('    解除后 linked 字段:', json.dumps(tgt, ensure_ascii=False)[:400] if tgt else '?')

print('\n=== 日志中的异常 ===')
logf.flush()
tail = open(LOG, encoding='utf-8', errors='replace').read()
bad = [l for l in tail.splitlines() if ('Error' in l) or ('TypeError' in l) or ('500' in l)]
print('\n'.join(bad[-12:]) if bad else '(无异常)')

# 保存结论
json.dump(result, open(os.path.join(ROOT, 'perf', 'sandbox', 'verify791b.result.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
proc.kill()
print('\n已停止隔离实例')
