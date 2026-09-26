"""T00789 诊断证实：同步阻塞处理器使中间件闸门失效。

假设：settings/export 与 dbadmin/export 的**处理器体为完全同步**（exportBundle /
exportRows 内部是 db.prepare().all() + map 循环，无 await），Node 单线程在同步执行期间
**无法接受并解析下一个 HTTP 请求**，因此第 2 个请求的出口中间件根本不会在计数已为 1 时被求值
——闸门计数永远达不到 2，故 0×429。

对照：plans/export 的处理器是 async（PlanService.exportExcel(...).then(...)），
执行中会让出事件循环，后续请求得以抵达闸门 → 18×429。

验证方式：用 Node 原生 http 并发打「同一闸门保护的慢同步端点」，
观察响应时间是否**线性叠加**（1 路 122ms → 20 路最慢 1972ms ≈ 线性），
以及是否出现 429（预期 0 个）——与异步端点形成对照。
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
import threading, sqlite3 as _sq

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39918
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify789d')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify789d.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))
_c = _sq.connect(os.path.join(DATA, 'mtask.db'))
_proj = _c.execute("SELECT id FROM projects ORDER BY created_at LIMIT 1").fetchone()[0]
_c.close()

env = dict(os.environ); env['MTask_PORT'] = str(PORT); env['MTask_DATA_DIR'] = DATA
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, timeout=180):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (PORT, path), timeout=timeout) as resp:
            resp.read(); return resp.status, (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        e.read(); return e.code, (time.time() - t0) * 1000
    except Exception:
        return 0, (time.time() - t0) * 1000


def burst(path, n):
    out = [None] * n
    b = threading.Barrier(n)
    def w(i):
        b.wait(); out[i] = req(path)
    ts = [threading.Thread(target=w, args=(i,)) for i in range(n)]
    for t in ts: t.start()
    for t in ts: t.join()
    ms = [r[1] for r in out]
    return {'n': n, 'n200': sum(1 for r in out if r[0] == 200),
            'n429': sum(1 for r in out if r[0] == 429),
            'ms_min': round(min(ms), 1), 'ms_max': round(max(ms), 1),
            'ms_sum': round(sum(ms), 1)}


res = {'hypothesis': 'sync handler blocks event loop → gate counter never reaches limit'}
ok = True
got = False
for _ in range(80):
    time.sleep(0.5)
    if proc.poll() is not None: break
    st, _ = req('/api/health', timeout=3)
    if st == 200:
        got = True; print('✅ 服务就绪'); break
if not got:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2000:]); sys.exit(1)

try:
    for path, lbl in [('/api/settings/export', 'settings/export(SYNC)'),
                      ('/api/plans/export?projectId=%s' % _proj, 'plans/export(ASYNC)')]:
        base_st, base_ms = req(path)
        print('\n=== %s ===  基线 %s %.1f ms' % (lbl, base_st, base_ms))
        res.setdefault('cases', {})[lbl] = {'baseline_ms': round(base_ms, 1)}
        for n in (2, 5, 10):
            r = burst(path, n)
            res['cases'][lbl]['burst%d' % n] = r
            print('   并发 %2d 路 → 200×%d 429×%d  单请求 %.0f~%.0f ms  总耗时 %.0f ms'
                  % (n, r['n200'], r['n429'], r['ms_min'], r['ms_max'], r['ms_sum']))
            time.sleep(1)

    # 判定：SYNC 端点应 0×429 且耗时近线性；ASYNC 端点应有 429
    s = res['cases']['settings/export(SYNC)']
    a = res['cases']['plans/export(ASYNC)']
    res['conclusion'] = {
        'sync_gate_fires': sum(s['burst%d' % n]['n429'] for n in (2, 5, 10)) > 0,
        'sync_serializes': s['burst10']['ms_max'] > s['baseline_ms'] * 5,
        'async_gate_fires': sum(a['burst%d' % n]['n429'] for n in (2, 5, 10)) > 0,
    }
    print('\n结论：')
    print('  · 同步端点闸门生效：%s（预期 False）' % res['conclusion']['sync_gate_fires'])
    print('  · 同步端点串行化（10 路最慢 > 5×基线）：%s（预期 True）' % res['conclusion']['sync_serializes'])
    print('  · 异步端点闸门生效：%s（预期 True）' % res['conclusion']['async_gate_fires'])
    ok = (res['conclusion']['sync_gate_fires'] is False
          and res['conclusion']['sync_serializes'] is True
          and res['conclusion']['async_gate_fires'] is True)
except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    res['diagnosis_confirmed'] = ok
    print('\n===== RESULT =====')
    print(json.dumps(res, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify789d.result.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    try: proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('DIAGNOSIS CONFIRMED:', ok)
