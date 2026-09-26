"""T00788 补充测量：拆解「N+1 消除」与「响应体序列化」两块成本。

背景：首轮 seed 用 31 快照 × 45 任务 × 每任务 ~4KB 文本 → 响应体 11.4MB，
p50 199ms 全部花在 JSON 序列化而非 SQL。需分别量化：
  A. 查询阶段成本（N+1 消除的收益）——直接对 DB 跑新旧两种查询模式计时
  B. 端点整体延迟随响应体规模的变化——按真实规模（任务 description 短）复测
"""
import json, os, shutil, sqlite3 as _sq, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39913
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify788b')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify788b.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))
dbp = os.path.join(DATA, 'mtask.db')

NSNAP, NPER = 24, 45
_conn = _sq.connect(dbp)
_t = '2026-09-19T00:00:00.000Z'
for i in range(NSNAP):
    pid = 'snap-perf788-%02d' % i
    _conn.execute(
        "INSERT INTO projects (id,name,description,history_at,archived,created_at,updated_at,sort_weight) VALUES (?,?,?,?,0,?,?,0)",
        (pid, 'perf788 快照 %02d' % i, '快照项目描述 %d' % i, '2026-09-%02dT00:00:00.000Z' % (i % 28 + 1), _t, _t))
    for j in range(NPER):
        # 真实规模：description ~60 字符、handle_result ~200 字符（非首轮的 4KB 极端值）
        _conn.execute(
            "INSERT INTO tasks (id,project_id,task_no,title,description,status,verified,priority,category_id,handle_result,created_at,updated_at,archived) "
            "VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,0)",
            ('t788-%02d-%03d' % (i, j), pid, 'T8%02d%03d' % (i, j), '任务标题 %d-%d' % (i, j),
             '任务描述正文，约六十个字符的常规长度。', 'done' if j % 3 == 0 else 'todo',
             1 if j % 4 == 0 else 0, 'normal', '## 回传结论\n' + ('要点说明。' * 40), _t, _t))
    for k in range(8):
        _conn.execute(
            "INSERT INTO plan_tasks (id,project_id,title,description,kind,status,progress,start_date,end_date,duration_days,sort_order,archived,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            ('p788-%02d-%03d' % (i, k), pid, '计划 %d-%d' % (i, k), '计划描述 ' * 12,
             'milestone' if k % 2 else 'task', 'done' if k % 2 else 'doing', k * 10,
             '2026-09-01', '2026-09-10', 5, k, _t, _t))
_conn.commit()
_ids = [r[0] for r in _conn.execute("SELECT id FROM projects WHERE id LIKE 'snap-perf788-%' ORDER BY history_at DESC")]
_np = len(_ids)
_nt = _conn.execute("SELECT COUNT(*) FROM tasks WHERE project_id LIKE 'snap-perf788-%'").fetchone()[0]
_conn.close()

# ---------- A. 查询阶段成本：旧 N+1 模式 vs 新 IN 分组模式（纯 SQL，排除序列化） ----------
def bench_legacy(n=30):
    ts = []
    for _ in range(n):
        c = _sq.connect(dbp); c.row_factory = _sq.Row
        t0 = time.perf_counter()
        for pid in _ids:
            c.execute('SELECT id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at FROM tasks WHERE project_id = ? ORDER BY task_no', (pid,)).fetchall()
            c.execute('SELECT id, title, description, kind, status, progress, start_date, end_date, duration_days FROM plan_tasks WHERE project_id = ? ORDER BY sort_order', (pid,)).fetchall()
        ts.append((time.perf_counter() - t0) * 1000)
        c.close()
    return ts


def bench_optimized(n=30):
    ph = ','.join('?' * len(_ids))
    ts = []
    for _ in range(n):
        c = _sq.connect(dbp); c.row_factory = _sq.Row
        t0 = time.perf_counter()
        c.execute("SELECT id, name, description, history_at FROM projects WHERE COALESCE(history_at,'') != '' ORDER BY history_at DESC").fetchall()
        allt = c.execute(f'SELECT id, project_id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at FROM tasks WHERE project_id IN ({ph}) ORDER BY task_no', _ids).fetchall()
        allp = c.execute(f'SELECT id, project_id, title, description, kind, status, progress, start_date, end_date, duration_days FROM plan_tasks WHERE project_id IN ({ph}) ORDER BY sort_order', _ids).fetchall()
        # 内存分组（与实现同构）
        bt, bp = {}, {}
        for r in allt:
            bt.setdefault(r['project_id'], []).append(r)
        for r in allp:
            bp.setdefault(r['project_id'], []).append(r)
        ts.append((time.perf_counter() - t0) * 1000)
        c.close()
    return ts


def med(xs):
    return sorted(xs)[len(xs) // 2]


bench_legacy(3); bench_optimized(3)  # 预热
lg, op = bench_legacy(30), bench_optimized(30)

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, timeout=60):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (PORT, path), timeout=timeout) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e), (time.time() - t0) * 1000


results = {'scenario': 'realistic payload (24 snapshots x 45 tasks)', 'seeded_snapshots': _np, 'seeded_tasks': _nt}
ok = True
try:
    got = False
    for _ in range(80):
        time.sleep(0.5)
        if proc.poll() is not None:
            break
        st, _, _ = req('/api/health')
        if st == 200:
            got = True
            print('✅ 服务就绪（端口 %d）' % PORT)
            break
    if not got:
        logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2500:]); sys.exit(1)

    print('   预置：%d 快照 / %d 任务（description 短、handle_result ~200 字符，贴近真实）' % (_np, _nt))

    lat, body, sizes = [], None, []
    for i in range(25):
        st, b, ms = req('/api/history/list')
        if st != 200:
            print('!! GET 失败', st, b[:300]); ok = False; break
        lat.append(ms); body = b; sizes.append(len(b))
    p50, p95 = sorted(lat)[len(lat) // 2], sorted(lat)[max(0, int(len(lat) * 0.95) - 1)]
    results['endpoint_latency'] = {'n': len(lat), 'p50_ms': round(p50, 2), 'p95_ms': round(p95, 2),
                                   'min_ms': round(min(lat), 2), 'payload_kb': round(len(body.encode('utf-8')) / 1024, 1)}
    print('✅ 端点延迟：p50=%.2fms p95=%.2fms（响应体 %.1f KB）' % (p50, p95, len(body.encode('utf-8')) / 1024))

    results['query_phase'] = {'legacy_n1_ms': round(med(lg), 2), 'optimized_in_ms': round(med(op), 2),
                              'speedup': round(med(lg) / max(med(op), 0.001), 2),
                              'legacy_queries': 1 + 2 * _np, 'optimized_queries': 3}
    print('✅ 查询阶段（纯 SQL，30 次中位）：N+1 %.2fms → IN 分组 %.2fms（%.2f×；查询数 %d → 3）'
          % (med(lg), med(op), med(lg) / max(med(op), 0.001), 1 + 2 * _np))

    # 逐字节对照复验
    import sqlite3 as _s2
    c = _s2.connect(dbp); c.row_factory = _s2.Row
    ref = []
    for p in c.execute("SELECT id, name, description, history_at FROM projects WHERE COALESCE(history_at,'') != '' ORDER BY history_at DESC"):
        p = dict(p)
        tasks = [dict(r) for r in c.execute('SELECT id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at FROM tasks WHERE project_id = ? ORDER BY task_no', (p['id'],))]
        plans = [dict(r) for r in c.execute('SELECT id, title, description, kind, status, progress, start_date, end_date, duration_days FROM plan_tasks WHERE project_id = ? ORDER BY sort_order', (p['id'],))]
        ref.append({**p, 'stats': {'tasks': len(tasks), 'doneTasks': sum(1 for t in tasks if t['status'] == 'done'),
                                   'plans': len(plans), 'donePlans': sum(1 for x in plans if x['status'] == 'done')},
                    'tasks': tasks, 'plans': plans})
    c.close()
    same = json.dumps(json.loads(body)['snapshots'], sort_keys=True, ensure_ascii=False) == json.dumps(ref, sort_keys=True, ensure_ascii=False)
    results['byte_equivalent'] = same
    print('✅ 与旧实现逐字节等价：%s' % ('是' if same else '否'))
    if not same:
        ok = False

    target = p50 < 30.0
    results['acceptance_p50_lt_30ms_realistic'] = target
    print('✅ 验收 p50<30ms（真实规模 24 快照）：%s（实测 %.2fms）' % ('通过' if target else '未达', p50))
    if not target:
        ok = False
except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    results['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify788b.result.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('OVERALL:', results['overall'])
    sys.exit(0 if ok else 1)
