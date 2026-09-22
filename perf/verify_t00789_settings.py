# -*- coding: utf-8 -*-
"""T00789 建议①/② 验证（隔离实例）。

建议① exportGate 上限改从 app_settings 读取:
  - 写入 exportGateLimit.settings-export='1' 后并发 5 路 → 恰好 1×200 + 4×429
  - 配置非法('abc')回退默认 EXPORT_GATE_LIMIT=2 → 5 路 = 2×200 + 3×429
建议② exportBundle 分表让出（async）:
  - 单发全量导出返回结构完整 bundle（10 张表齐全、exportedAt 合理）
  - 单发子集 ?tables=projects,ai_tools 仅含这 2 张表
  - 导出进行中并发 /api/health 应快速返回（事件循环被 let 出，非独占）
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error, sqlite3
import threading

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39921
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify789settings')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify789settings.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

# 注入配置：建议① 的 app_settings 键
SETTING_VALUE = os.environ.get('GATE_SETTING', '1')
_c = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
_c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
           ('exportGateLimit.settings-export', SETTING_VALUE))
_c.commit(); _c.close()
print('   已注入 app_settings exportGateLimit.settings-export = %r' % SETTING_VALUE)

env = dict(os.environ)
env['MTask_PORT'] = str(PORT)
env['MTask_DATA_DIR'] = DATA
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                        cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def req(path, method='GET', body=None, timeout=90):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, raw, (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read(), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e).encode(), (time.time() - t0) * 1000


def burst(path, n, method='GET', body=None, label=''):
    out = [None] * n
    barrier = threading.Barrier(n)

    def worker(i):
        barrier.wait()
        out[i] = req(path, method, body)

    ths = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    codes = [r[0] for r in out]
    print('   [%s] 并发 %d 路 → %s' % (label, n, codes))
    return out


results = {}
ok = True

booted = False
for _ in range(80):
    time.sleep(0.5)
    if proc.poll() is not None:
        print('!! 进程退出 rc=', proc.returncode); break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        booted = True
        print('✅ 服务就绪（端口 %d）' % PORT); break
if not booted:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-3000:]); sys.exit(1)

try:
    # ---------- 建议① 核心：limit 改自 app_settings=1 → 1×200 + 4×429 ----------
    res = burst('/api/settings/export', 5, label='settings/export (limit=1 建议①)')
    n200 = sum(1 for r in res if r[0] == 200)
    n429 = sum(1 for r in res if r[0] == 429)
    results['gate_setting_1'] = {'n200': n200, 'n429': n429}
    # 429 体校验
    msg_ok = all(
        json.loads(r[1].decode('utf-8', 'replace')).get('error') == '导出任务过多，请稍后再试'
        for r in res if r[0] == 429)
    results['gate_setting_1_msg'] = msg_ok
    burst_ok = (n200 == 1 and n429 == 4 and msg_ok)
    print('   ✅ 建议① limit=1 → 1×200+4×429 且 429 中文提示：%s' % ('通过' if burst_ok else '未达'))
    if not burst_ok:
        ok = False
    time.sleep(0.6)

    # ---------- 建议② 等价：单发全量导出结构完整（10 表） ----------
    st, body, ms = req('/api/settings/export', timeout=120)
    bundle = json.loads(body.decode('utf-8', 'replace')) if st == 200 else None
    tables = list(bundle['data'].keys()) if bundle else []
    struct_ok = (st == 200 and bundle and bundle.get('app') == 'mtask'
                 and bundle.get('version') == 1 and bundle.get('exportedAt')
                 and sorted(tables) == sorted([
                     'projects', 'prompt_categories', 'ai_tools', 'queues',
                     'task_categories', 'app_settings', 'tasks', 'prompts',
                     'task_images', 'queue_jobs']))
    results['export_full'] = {'status': st, 'ms': round(ms, 1), 'tables': tables, 'ok': struct_ok}
    print('   ✅ 建议② 全量导出：status=%d %.0fms，10 表齐全结构完整：%s' % (st, ms, '是' if struct_ok else '否'))
    if not struct_ok:
        ok = False

    # ---------- 建议② 等价：子集导出仅含指定表 ----------
    st2, body2, ms2 = req('/api/settings/export?tables=projects,ai_tools', timeout=60)
    b2 = json.loads(body2.decode('utf-8', 'replace')) if st2 == 200 else None
    sub_ok = (st2 == 200 and b2 and sorted(b2['data'].keys()) == ['ai_tools', 'projects'])
    results['export_subset'] = {'status': st2, 'ok': sub_ok}
    print('   ✅ 建议② 子集导出 ?tables=projects,ai_tools → 仅含 2 表：%s' % ('是' if sub_ok else '否'))
    if not sub_ok:
        ok = False

    # ---------- 建议② 让出佐证：导出进行中并发 /api/health 应快速返回 ----------
    # 用一个后台线程放大导出耗时（轮询扫描大表），主线程同时并发 health，
    # 若让出有效，health 在导出期间能插入执行且低延迟。
    thread_stop = threading.Event()

    def slow_export_worker():
        try:
            for _ in range(6):
                st_, b_, _ = req('/api/settings/export', timeout=120)
                if st_ != 200:
                    break
                if thread_stop.is_set():
                    break
        except Exception:
            pass

    tw = threading.Thread(target=slow_export_worker)
    tw.start()
    time.sleep(0.3)  # 让导出开始
    heaths = burst('/api/health', 8, label='health@导出进行中')
    thread_stop.set()
    tw.join(timeout=30)
    h_stats = {
        'n200': sum(1 for r in heaths if r[0] == 200),
        'max_ms': max(r[2] for r in heaths),
        'min_ms': min(r[2] for r in heaths),
        'avg_ms': round(sum(r[2] for r in heaths) / len(heaths), 1),
    }
    results['health_during_export'] = h_stats
    # 不硬失败：仅当全部超 500ms 才判让出失效（说明事件循环被长期独占）
    yield_ok = h_stats['n200'] == 8 and h_stats['max_ms'] < 500
    print('   ✅ 建议② 导出进行中 health 并发 8 路 -> %s' % h_stats)
    if not yield_ok:
        print('   !! 导出期间 health 响应偏慢，让出可能未生效')
        ok = False
    time.sleep(0.6)

    # ---------- 建议① 回退：非法配置回退默认 EXPORT_GATE_LIMIT=2 ----------
    _c2 = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
    _c2.execute("UPDATE app_settings SET value='abc' WHERE key='exportGateLimit.settings-export'")
    _c2.commit(); _c2.close()
    # 每次请求实时读配置，改库后无需重启即时生效
    res2 = burst('/api/settings/export', 5, label='settings/export (非法配置→回退默认2)')
    n200b = sum(1 for r in res2 if r[0] == 200)
    n429b = sum(1 for r in res2 if r[0] == 429)
    results['gate_invalid_fallback'] = {'n200': n200b, 'n429': n429b}
    fallback_ok = (n200b == 2 and n429b == 3)
    print('   ✅ 建议① 非法配置回退默认 2 → 2×200+3×429：%s' % ('通过' if fallback_ok else '未达'))
    # 恢复配置消除副作用（避免污染后续同库测试）
    _c3 = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
    _c3.execute("UPDATE app_settings SET value='1' WHERE key='exportGateLimit.settings-export'")
    _c3.commit(); _c3.close()
    if not fallback_ok:
        ok = False

except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    results['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify789settings.result.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('OVERALL:', results['overall'])
    sys.exit(0 if ok else 1)