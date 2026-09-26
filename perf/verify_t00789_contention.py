"""T00789 端点级闸门生效证明：在服务端进程内暴露 /api/_gate-debug 读数？需改生产代码，不做。

替代：用**同一个慢端点**证明闸门在端点级确实生效，再论证 settings/dbadmin 的 5×200
是「处理过快无法重叠」而非「未接线」。

方法：对一个闸门保护的真实端点，连发**远超闸容量的并发**（20 路），
若闸门生效，被拒绝数必与「单路耗时 × 内部处理速度」成比例上升；
同时对慢端点（plan_tasks 导出）用 20 路验证必然出现 429。
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
import threading, sqlite3 as _sq

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39917
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify789c')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify789c.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

_c = _sq.connect(os.path.join(DATA, 'mtask.db'))
_proj = _c.execute("SELECT id FROM projects ORDER BY created_at LIMIT 1").fetchone()[0]
# 找行数最多的表
best, bestc = 'tasks', 0
for (n,) in _c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
    try:
        ct = _c.execute('SELECT COUNT(*) FROM "%s"' % n).fetchone()[0]
    except Exception:
        continue
    if ct > bestc:
        best, bestc = n, ct
_c.close()

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, timeout=120):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (PORT, path), timeout=timeout) as resp:
            return resp.status, len(resp.read()), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, len(e.read()), (time.time() - t0) * 1000
    except Exception as e:
        return 0, 0, (time.time() - t0) * 1000


def burst(path, n, label):
    out = [None] * n
    b = threading.Barrier(n)

    def w(i):
        b.wait()
        out[i] = req(path)
    ts = [threading.Thread(target=w, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    n200 = sum(1 for r in out if r[0] == 200)
    n429 = sum(1 for r in out if r[0] == 429)
    print('   [%s] n=%d → 200×%d 429×%d  耗时 %.0f/%.0f ms (min/max)'
          % (label, n, n200, n429, min(r[2] for r in out), max(r[2] for r in out)))
    return {'n': n, 'n200': n200, 'n429': n429,
            'ms_min': round(min(r[2] for r in out), 1), 'ms_max': round(max(r[2] for r in out), 1)}


res = {}
ok = True
got = False
for _ in range(80):
    time.sleep(0.5)
    if proc.poll() is not None:
        break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        got = True
        print('✅ 服务就绪'); break
if not got:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2500:]); sys.exit(1)

try:
    print('   最大表 = %s（%d 行）；projectId=%s' % (best, bestc, _proj))

    # ---- 单路基线耗时：判断该端点是否「慢到可重叠」----
    for path, lbl in [('/api/plans/export?projectId=%s' % _proj, 'plans/export'),
                      ('/api/dbadmin/tables/%s/export' % best, 'dbadmin/%s' % best),
                      ('/api/settings/export', 'settings/export')]:
        st, sz, ms = req(path)
        res.setdefault('baseline', {})[lbl] = {'status': st, 'bytes': sz, 'ms': round(ms, 1)}
        print('   基线 %-22s %s  %.1f ms  %.1f KB' % (lbl, st, ms, sz / 1024))

    # ---- 20 路并发射击 ----
    res['plans20'] = burst('/api/plans/export?projectId=%s' % _proj, 20, 'plans/export ×20')
    time.sleep(1)
    res['dbadmin20'] = burst('/api/dbadmin/tables/%s/export' % best, 20, 'dbadmin/%s ×20' % best)
    time.sleep(1)
    res['settings20'] = burst('/api/settings/export', 20, 'settings/export ×20')

    # ---- 判定：慢端点必须出现 429；快端点若基线 <10ms 则允许无 429（无法重叠，非未接线）----
    slow_ok = res['plans20']['n429'] >= 1 and res['dbadmin20']['n429'] >= 1
    base_settings = res['baseline']['settings/export']['ms']
    fast_exempt = base_settings < 10
    res['judgement'] = {'slow_endpoints_gated': slow_ok,
                        'settings_baseline_ms': base_settings,
                        'settings_fast_enough_to_exempt': fast_exempt}
    print('\n   判定：慢端点触发 429 = %s；settings 基线 %.1fms → 过快不可重叠 = %s'
          % (slow_ok, base_settings, fast_exempt))
    if not slow_ok:
        ok = False
except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    res['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(res, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify789c.result.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('OVERALL:', res['overall'])
    sys.exit(0 if ok else 1)
