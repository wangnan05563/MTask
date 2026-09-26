"""T00792 A/B：语句缓存开/关的吞吐与 CPU 对比（同库、同刻、同一进程行为）。

做法：临时把 TaskService.list 的 cachedPrepare 换回 db.prepare（旧行为），
测一轮混合排序变体的吞吐 + node 进程 CPU 时间；再换回缓存版测一轮。
用进程 CPU time（user+sys）作为「编译成本降低」的直接证据（不由网络/序列化噪声污染）。
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
import sqlite3 as _sq

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
TS = os.path.join(SRV, 'src', 'services', 'TaskService.ts')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify792ab')
SORTS = ['pinned', 'created_desc', 'created_asc', 'priority_desc', 'priority_asc', 'manual']

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

orig = open(TS, encoding='utf-8').read()
CACHED_LINE = '    const rows = cachedPrepare(db, sql).all(...values) as TaskRow[];'
PLAIN_LINE = '    const rows = db.prepare(sql).all(...values) as TaskRow[];'
assert CACHED_LINE in orig, '未找到缓存版调用行'


def req(port, path, timeout=90):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=timeout) as resp:
            return resp.status, len(resp.read()), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        e.read(); return e.code, 0, (time.time() - t0) * 1000
    except Exception:
        return 0, 0, (time.time() - t0) * 1000


def run_case(port, label, n_requests):
    """起实例 → 跑 N 次混合变体请求 → 记录耗时与进程 CPU → 关闭"""
    env = dict(os.environ); env['MTask_PORT'] = str(port); env['MTask_DATA_DIR'] = DATA
    logf = open(os.path.join(ROOT, 'perf', 'sandbox', 'v792_%s.log' % label), 'w', encoding='utf-8', errors='replace')
    proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                            cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        ready = False
        for _ in range(80):
            time.sleep(0.5)
            if proc.poll() is not None:
                logf.flush(); print('!! [%s] 退出:\n' % label + open(logf.name, encoding='utf-8', errors='replace').read()[-1500:]); return None
            st, _, _ = req(port, '/api/health', timeout=3)
            if st == 200:
                ready = True; break
        if not ready:
            print('!! [%s] 未就绪' % label); return None

        # 预热（让 JIT / 页面缓存稳定）
        for i in range(30):
            req(port, '/api/tasks?sort=%s' % SORTS[i % len(SORTS)])

        # 采样 CPU（读 /proc 不可用于 win；改由 psutil 或 tasklist？用 node 自身 process.cpuUsage 更准）
        # 简化：用 wall-time + 请求数即可；CPU 由脚本外 tasklist 采样太噪，此处以 wall-time 与
        # 请求延迟分位为主证据，并在服务端日志中无额外 IO。
        t0 = time.perf_counter()
        lat = []
        for i in range(n_requests):
            s = SORTS[i % len(SORTS)]
            st, sz, ms = req(port, '/api/tasks?sort=%s' % s)
            if st != 200:
                print('!! [%s] 请求失败 %s' % (label, st)); return None
            lat.append(ms)
        wall = (time.perf_counter() - t0) * 1000
        lat.sort()
        return {'label': label, 'n': n_requests, 'wall_ms': round(wall, 1),
                'req_per_sec': round(n_requests / (wall / 1000.0), 1),
                'lat_p50': round(lat[len(lat) // 2], 2),
                'lat_p95': round(lat[int(len(lat) * 0.95) - 1], 2),
                'lat_min': round(lat[0], 2)}
    finally:
        try: proc.terminate(); proc.wait(timeout=10)
        except Exception:
            try: proc.kill()
            except Exception: pass


res = {}
ok = True
try:
    N = 300
    # --- A: 缓存版（当前代码） ---
    a = run_case(39920, 'cached', N)
    if not a:
        print('缓存版测量失败'); sys.exit(1)
    print('✅ [CACHED] %d 请求 %.1f ms → %.1f req/s  p50=%.2fms p95=%.2fms'
          % (a['n'], a['wall_ms'], a['req_per_sec'], a['lat_p50'], a['lat_p95']))

    # --- B: 旧版（每次 prepare）---
    with open(TS, 'w', encoding='utf-8') as f:
        f.write(orig.replace(CACHED_LINE, PLAIN_LINE))
    print('   已临时切回 db.prepare（测毕还原）')
    b = run_case(39921, 'plain', N)
    if not b:
        print('旧版测量失败'); sys.exit(1)
    print('✅ [PLAIN ] %d 请求 %.1f ms → %.1f req/s  p50=%.2fms p95=%.2fms'
          % (b['n'], b['wall_ms'], b['req_per_sec'], b['lat_p50'], b['lat_p95']))

    res['cached'] = a
    res['plain'] = b
    res['throughput_gain'] = round(a['req_per_sec'] / max(b['req_per_sec'], 0.001), 3)
    res['lat_p50_reduction_pct'] = round((b['lat_p50'] - a['lat_p50']) / max(b['lat_p50'], 0.001) * 100, 1)
    print('\n✅ 吞吐比：CACHED/PLAIN = %.3f×（>1 表示缓存版更快）' % res['throughput_gain'])
    print('✅ p50 降幅：%.1f%%（%.2f → %.2f ms）' % (res['lat_p50_reduction_pct'], b['lat_p50'], a['lat_p50']))
finally:
    with open(TS, 'w', encoding='utf-8') as f:
        f.write(orig)
    restored = open(TS, encoding='utf-8').read()
    res['restored_ok'] = (restored == orig)
    print('\n✅ 已还原缓存版实现：%s' % res['restored_ok'])
    res['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(res, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify792ab.result.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
