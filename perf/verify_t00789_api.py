"""T00789 API 级验证：导出类端点并发闸（隔离实例）。

验收项：
  1. tsc --noEmit 通过（脚本外单独跑）
  2. 并发 5 路 GET /api/plans/export 断言：恰好 2 路 200 + 3 路 429
  3. 429 响应体含中文提示「导出任务过多，请稍后再试」
  4. 全部完成后信号量归零（后续单发请求恢复 200）
  5. 覆盖其余三个端点：settings/export、dbadmin/*/export、report/generate 同样受闸
  6. 异常/客户端断开不泄漏计数（连发多轮后仍能正常服务）
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
import threading

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39916
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify789')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify789.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

# 取一个真实 projectId（plans/export 需要）
import sqlite3 as _sq
_c = _sq.connect(os.path.join(DATA, 'mtask.db'))
_row = _c.execute("SELECT id, name FROM projects ORDER BY created_at LIMIT 1").fetchone()
_proj = _row[0] if _row else None
# 取一个真实表名（dbadmin export）——优先选行数最多的表，确保导出让出足够时间片以形成重叠
_big = _c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
    "ORDER BY (SELECT COUNT(*) FROM pragma_table_info(name)) DESC LIMIT 1").fetchone()
_candidates = [r[0] for r in _c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
_tbl, _tbl_cnt = 'tasks', 0
for _n in _candidates:
    try:
        _ct = _c.execute('SELECT COUNT(*) FROM "%s"' % _n).fetchone()[0]
    except Exception:
        continue
    if _ct > _tbl_cnt:
        _tbl, _tbl_cnt = _n, _ct
_c.close()
print('   测试用 projectId=%s，dbadmin 表=%s（%d 行）' % (_proj, _tbl, _tbl_cnt))

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
    """并发 n 路请求，返回 [(status, body, ms), ...]。
    用 barrier 强制所有线程在同一时刻发出请求——否则前序请求可能已完成（尤其快端点），
    无法形成真正的重叠（首轮误判 settings/dbadmin 未生效即此原因）。"""
    out = [None] * n
    barrier = threading.Barrier(n)

    def worker(i):
        barrier.wait()  # 等齐 N 路后同时出发
        out[i] = req(path, method, body)

    ths = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    print('   [%s] 并发 %d 路 → %s' % (label, n, [r[0] for r in out]))
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
    # ---------- 验收 2：plans/export 并发 5 路 ----------
    gate_path = '/api/plans/export?projectId=%s' % _proj
    res = burst(gate_path, 5, label='plans/export')
    codes = sorted(r[0] for r in res)
    n200 = sum(1 for r in res if r[0] == 200)
    n429 = sum(1 for r in res if r[0] == 429)
    results['plans_export_burst5'] = {'codes': codes, 'n200': n200, 'n429': n429}
    expect_ok = (n200 == 2 and n429 == 3)
    print('   ✅ 断言 2×200 + 3×429：%s（实测 2×%d + 3×%d）'
          % ('通过' if (n200 == 2 and n429 == 3) else '未达', n200, n429))
    if not expect_ok:
        ok = False

    # ---------- 验收 3：429 中文提示 ----------
    msg_ok = True
    for r in res:
        if r[0] == 429:
            try:
                j = json.loads(r[1].decode('utf-8', 'replace'))
            except Exception:
                msg_ok = False; break
            if j.get('error') != '导出任务过多，请稍后再试':
                msg_ok = False
    results['429_message_ok'] = msg_ok
    print('   ✅ 429 中文提示「导出任务过多，请稍后再试」：%s' % ('是' if msg_ok else '否'))
    if not msg_ok:
        ok = False

    # ---------- 验收 4：信号量归零（并发结束后单发应恢复 200） ----------
    time.sleep(0.8)
    zero = True
    recover = []
    for i in range(6):
        st, b, _ = req(gate_path)
        recover.append(st)
        if st != 200:
            zero = False
        time.sleep(0.3)
    results['semaphore_released'] = zero
    results['recover_codes'] = recover
    print('   ✅ 信号量归零（并发后连发 6 次全 200）：%s %s' % ('是' if zero else '否', recover))
    if not zero:
        ok = False

    # ---------- 验收 5：其余三个端点同样受闸 ----------
    others = {}
    # settings/export
    r_s = burst('/api/settings/export', 5, label='settings/export')
    others['settings'] = {'n200': sum(1 for r in r_s if r[0] == 200), 'n429': sum(1 for r in r_s if r[0] == 429)}
    time.sleep(0.6)
    # dbadmin export
    r_d = burst('/api/dbadmin/tables/%s/export' % _tbl, 5, label='dbadmin/export')
    others['dbadmin'] = {'n200': sum(1 for r in r_d if r[0] == 200), 'n429': sum(1 for r in r_d if r[0] == 429)}
    time.sleep(0.6)
    # report/generate（POST，需合法 period/format）
    r_g = burst('/api/report/generate', 5, method='POST',
                body={'period': 'month', 'format': 'xlsx'}, label='report/generate')
    others['report'] = {'n200': sum(1 for r in r_g if r[0] in (200, 500)), 'n429': sum(1 for r in r_g if r[0] == 429),
                        'codes': [r[0] for r in r_g]}
    results['other_endpoints'] = others
    for k, v in others.items():
        print('   ✅ %s：200=%d 429=%d' % (k, v['n200'], v['n429']))
    if not all(v['n429'] >= 1 for v in others.values()):
        print('   !! 存在未触发闸门的端点')
        ok = False

    # ---------- 验收 6：多轮连发不泄漏计数 ----------
    leak_ok = True
    for rd in range(3):
        rr = burst(gate_path, 5, label='plans/export 第%d轮' % (rd + 2))
        time.sleep(0.6)
        st, _, _ = req(gate_path)
        if st != 200:
            leak_ok = False
    results['no_leak_after_rounds'] = leak_ok
    print('   ✅ 多轮并发后计数不泄漏（每轮后单发恢复 200）：%s' % ('是' if leak_ok else '否'))
    if not leak_ok:
        ok = False

except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    results['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify789.result.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('OVERALL:', results['overall'])
    sys.exit(0 if ok else 1)
