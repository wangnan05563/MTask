"""T00788 API 级验证：history/list 消 N+1（隔离实例）。

验收项：
  1. tsc --noEmit 通过（脚本外单独跑）
  2. seed 造 20+ 快照项目，GET /api/history/list p50 < 30ms
  3. 新旧实现输出**逐字节等价**（用旧实现算法在脚本内独立复算做对照）
  4. 任务/计划顺序（task_no / sort_order）与旧实现一致
  5. 空快照 / 无任务快照等边界不抛错
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
import sqlite3 as _sq

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39912
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify788')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify788.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))
dbp = os.path.join(DATA, 'mtask.db')

# ---------- 启动前 seed：造 24 个快照项目，各带任务/计划（含长 description 模拟真实体积）----------
NSNAP = 24
NPER = 45
_conn = _sq.connect(dbp)
_long_desc = '任务描述正文，用于模拟真实 description 字段体积。' * 60
_long_res = '## 处理结果\n' + ('回传结论正文。' * 300)
_t = '2026-09-19T00:00:00.000Z'
for i in range(NSNAP):
    pid = 'snap-perf788-%02d' % i
    _conn.execute(
        "INSERT INTO projects (id,name,description,history_at,archived,created_at,updated_at,sort_weight) "
        "VALUES (?,?,?,?,0,?,?,0)",
        (pid, 'perf788 快照 %02d' % i, '快照项目描述 %d' % i, '2026-09-%02dT00:00:00.000Z' % (i % 28 + 1), _t, _t),
    )
    for j in range(NPER):
        _conn.execute(
            "INSERT INTO tasks (id,project_id,task_no,title,description,status,verified,priority,category_id,handle_result,created_at,updated_at,archived) "
            "VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,0)",
            ('t788-%02d-%03d' % (i, j), pid, 'T8%02d%03d' % (i, j), '任务标题 %d-%d' % (i, j),
             _long_desc, 'done' if j % 3 == 0 else 'todo', 1 if j % 4 == 0 else 0, 'normal', _long_res, _t, _t),
        )
    for k in range(8):
        _conn.execute(
            "INSERT INTO plan_tasks (id,project_id,title,description,kind,status,progress,start_date,end_date,duration_days,sort_order,archived,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            ('p788-%02d-%03d' % (i, k), pid, '计划 %d-%d' % (i, k), '计划描述 ' * 40,
             'milestone' if k % 2 else 'task', 'done' if k % 2 else 'doing', k * 10,
             '2026-09-01', '2026-09-10', 5, k, _t, _t),
        )
# 追加一个「无任务无计划」的空快照，验证边界
_conn.execute(
    "INSERT INTO projects (id,name,description,history_at,archived,created_at,updated_at,sort_weight) "
    "VALUES ('snap-perf788-empty','perf788 空快照','',?,0,?,?,0)",
    ('2026-09-01T00:00:00.000Z', _t, _t),
)
_conn.commit()
_np = _conn.execute("SELECT COUNT(*) FROM projects WHERE COALESCE(history_at,'')!=''").fetchone()[0]
_nt = _conn.execute("SELECT COUNT(*) FROM tasks WHERE project_id LIKE 'snap-perf788-%'").fetchone()[0]
_nplan = _conn.execute("SELECT COUNT(*) FROM plan_tasks WHERE project_id LIKE 'snap-perf788-%'").fetchone()[0]
_conn.close()

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen(
    [NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
    cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
)


def req(path, method='GET', body=None, timeout=60):
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


def pct(xs, p):
    s = sorted(xs)
    i = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[i]


def legacy_reference():
    """在脚本内用**旧实现算法**独立复算一遍，用作逐字节对照基准（同一 DB 同一时刻）。"""
    c = _sq.connect(dbp)
    c.row_factory = _sq.Row
    projects = [dict(r) for r in c.execute(
        "SELECT id, name, description, history_at FROM projects WHERE COALESCE(history_at,'') != '' ORDER BY history_at DESC")]
    out = []
    for p in projects:
        tasks = [dict(r) for r in c.execute(
            'SELECT id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at '
            'FROM tasks WHERE project_id = ? ORDER BY task_no', (p['id'],))]
        plans = [dict(r) for r in c.execute(
            'SELECT id, title, description, kind, status, progress, start_date, end_date, duration_days '
            'FROM plan_tasks WHERE project_id = ? ORDER BY sort_order', (p['id'],))]
        out.append({
            **p,
            'stats': {
                'tasks': len(tasks),
                'doneTasks': sum(1 for t in tasks if t['status'] == 'done'),
                'plans': len(plans),
                'donePlans': sum(1 for x in plans if x['status'] == 'done'),
            },
            'tasks': tasks,
            'plans': plans,
        })
    c.close()
    return out


results = {}
ok = True

booted = False
for _ in range(80):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 进程退出 rc=', proc.returncode)
        break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        booted = True
        print('✅ 服务就绪（端口 %d）' % PORT)
        break
if not booted:
    logf.flush()
    print(open(LOG, encoding='utf-8', errors='replace').read()[-3000:])
    sys.exit(1)

try:
    print('   预置负载：%d 个快照项目 / %d 任务 / %d 计划（每任务 description≈%d 字符，handle_result≈%d 字符）'
          % (_np, _nt, _nplan, len(_long_desc), len(_long_res)))

    # ---------- 验收 2：p50 ----------
    lat = []
    body = None
    for i in range(25):
        st, b, ms = req('/api/history/list')
        if st != 200:
            print('!! GET 失败', st, b[:300]); ok = False; break
        lat.append(ms)
        body = b
    p50, p95 = pct(lat, 50), pct(lat, 95)
    results['latency'] = {'n': len(lat), 'p50_ms': round(p50, 2), 'p95_ms': round(p95, 2),
                          'min_ms': round(min(lat), 2), 'max_ms': round(max(lat), 2),
                          'payload_bytes': len(body.encode('utf-8')) if body else 0}
    print('✅ 延迟：n=%d p50=%.2fms p95=%.2fms min=%.2f max=%.2f（响应体 %.1f KB）'
          % (len(lat), p50, p95, min(lat), max(lat), len(body.encode('utf-8')) / 1024))

    # ---------- 验收 3：与旧实现逐字节等价 ----------
    api_snaps = json.loads(body)['snapshots']
    ref = legacy_reference()
    same = json.dumps(api_snaps, sort_keys=True, ensure_ascii=False) == \
           json.dumps(ref, sort_keys=True, ensure_ascii=False)
    results['byte_equivalent_to_legacy'] = same
    print('✅ 与旧实现输出逐字节等价：%s（快照 %d 个）' % ('是' if same else '否', len(api_snaps)))
    if not same:
        ok = False
        # 定位首个差异
        for a, r in zip(api_snaps, ref):
            if json.dumps(a, sort_keys=True) != json.dumps(r, sort_keys=True):
                print('   ✗ 首个差异快照:', a.get('id'))
                for k in set(list(a.keys()) + list(r.keys())):
                    if json.dumps(a.get(k), sort_keys=True) != json.dumps(r.get(k), sort_keys=True):
                        print('     字段', k, '不一致')
                break

    # ---------- 验收 4：顺序一致 ----------
    order_ok = all(
        [t['task_no'] for t in a['tasks']] == [t['task_no'] for t in r['tasks']]
        and [p['id'] for p in a['plans']] == [p['id'] for p in r['plans']]
        for a, r in zip(api_snaps, ref)
    )
    proj_order_ok = [s['id'] for s in api_snaps] == [s['id'] for s in ref]
    results['order_task_no_and_sort'] = order_ok
    results['order_projects'] = proj_order_ok
    print('✅ 顺序一致：项目 history_at DESC=%s，任务 task_no / 计划 sort_order=%s'
          % (proj_order_ok, order_ok))
    if not (order_ok and proj_order_ok):
        ok = False

    # ---------- 验收 5：边界——空快照 ----------
    empty_snap = next((s for s in api_snaps if s['id'] == 'snap-perf788-empty'), None)
    edge_ok = empty_snap is not None and empty_snap['tasks'] == [] and empty_snap['plans'] == [] \
        and empty_snap['stats'] == {'tasks': 0, 'doneTasks': 0, 'plans': 0, 'donePlans': 0}
    results['edge_empty_snapshot'] = edge_ok
    print('✅ 边界（空快照）：stats 全 0 且 tasks/plans 为 []：%s' % ('是' if edge_ok else '否'))
    if not edge_ok:
        ok = False

    # ---------- 验收 2 判定 ----------
    target = p50 < 30.0
    results['acceptance_p50_lt_30ms'] = target
    print('✅ 验收 p50<30ms：%s（实测 %.2fms，快照 %d 个 × %d 任务）'
          % ('通过' if target else '未达', p50, _np, NPER))
    if not target:
        ok = False

    # ---------- 查询次数对照（解释 N+1 消除） ----------
    results['query_counts'] = {'legacy': '1 + 2N = %d' % (1 + 2 * _np), 'optimized': '3（与快照数无关）'}

except Exception:
    import traceback
    traceback.print_exc()
    ok = False
finally:
    results['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify788.result.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    print('OVERALL:', results['overall'])
    sys.exit(0 if ok else 1)
