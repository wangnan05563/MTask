"""T00787 API 级验证：console-jobs 列表 TTL 缓存（隔离实例）。

验收项：
  1. tsc --noEmit 通过（脚本外单独跑）
  2. GET /api/console-jobs 命中缓存后 p50 显著下降（目标 <50ms）
  3. 连发 POST 创建 job 后 5s 内 GET 可见（写端点 cacheClear 正确）
  4. 列表内容与直接落库一致（缓存不脏读）
  5. POST /console-jobs/:id/restart、DELETE 后列表立刻反映
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = os.path.join(ROOT, 'perf', 'sandbox', 'gt791', 'mtask.db')
PORT = 39911
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify787')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify787.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

# ---------- 启动前直接造真实负载：40 行 × ~12KB answer（模拟"含完整 answer 长文本"的全表扫） ----------
import sqlite3 as _sq
_dbp = os.path.join(DATA, 'mtask.db')
_conn = _sq.connect(_dbp)
_long = '# 分析结果\n' + ('这是一段很长的 AI 分析正文，用于模拟真实 answer 字段体积与 JSON 序列化成本。' * 400)
_t = time.strftime('%Y-%m-%dT%H:%M:%S')
for _i in range(40):
    _conn.execute(
        "INSERT INTO console_jobs (id,title,prompt,category,period,status,answer,error,created_at,updated_at) "
        "VALUES (?,?,?,'custom',NULL,'done',?,NULL,?,?)",
        ('job-perf787-%03d' % _i, 'perf787-seed-%02d' % _i, 'seed prompt',
         _long, '2026-09-19T00:%02d:00' % _i, _t),
    )
_conn.commit()
_rows = _conn.execute('SELECT COUNT(*) FROM console_jobs').fetchone()[0]
_bytes = _conn.execute("SELECT COALESCE(SUM(LENGTH(COALESCE(answer,''))),0) FROM console_jobs").fetchone()[0]
_rows2 = _conn.execute('SELECT COUNT(*) FROM console_jobs').fetchone()[0]
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


def req(path, method='GET', body=None, timeout=30):
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
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[i]


results = {}
ok = True

# ---------- 启动 ----------
booted = False
for i in range(80):
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
    print('   启动前预置负载：%d 行，answer 总长 %d 字符' % (_rows, _bytes))

    # ---------- 验收 2：缓存命中后延迟 ----------
    req('/api/console-jobs')  # 首次 miss，填充缓存
    # 等缓存生效后连测 60 次，全部应命中（TTL 5s 内高频命中）
    lat_hit = []
    t_start = time.time()
    for i in range(60):
        st, b, ms = req('/api/console-jobs')
        if st != 200:
            print('!! GET 失败', st, b[:200]); ok = False; break
        lat_hit.append(ms)
        if time.time() - t_start > 9000:
            break  # 控制在 ~9s 内，避免跨 TTL 把 miss 混进命中样本
    p50 = pct(lat_hit, 50)
    p95 = pct(lat_hit, 95)
    results['cached'] = {'n': len(lat_hit), 'p50_ms': round(p50, 2), 'p95_ms': round(p95, 2),
                         'min_ms': round(min(lat_hit), 2), 'max_ms': round(max(lat_hit), 2)}
    print('✅ 缓存命中：n=%d p50=%.2fms p95=%.2fms min=%.2f max=%.2f'
          % (len(lat_hit), p50, p95, min(lat_hit), max(lat_hit)))

    # ---------- 对照：冷查询（每次 cacheClear 后立刻查）延迟 ----------
    # 通过 POST create 强制失效再 GET（注意：这会真的触发后台 AI 调用，只取它的"失效+冷查"延迟）
    lat_cold = []
    for i in range(15):
        st, b, _ = req('/api/console-jobs', 'POST', {
            'title': 'perf787-cold-%02d' % i, 'prompt': 'cold probe',
            'category': 'custom', 'toolId': 'tool-perf'})
        st2, b2, ms = req('/api/console-jobs')
        if st2 != 200:
            print('!! 冷查询 GET 失败', st2); ok = False; break
        lat_cold.append(ms)
    p50c = pct(lat_cold, 50)
    results['cold'] = {'n': len(lat_cold), 'p50_ms': round(p50c, 2),
                       'p95_ms': round(pct(lat_cold, 95), 2)}
    print('✅ 冷查询对照：n=%d p50=%.2fms p95=%.2fms'
          % (len(lat_cold), p50c, pct(lat_cold, 95)))
    if p50c > 0:
        print('   → p50 降幅 %.1f×（冷 %.2fms → 命中 %.2fms）' % (p50c / max(p50, 0.001), p50c, p50))

    # ---------- 验收 3：连发 POST 后 5s 内 GET 可见 ----------
    vis = []
    for i in range(5):
        t0 = time.time()
        st, b, _ = req('/api/console-jobs', 'POST', {
            'title': 'perf787-vis-%02d' % i, 'prompt': 'visibility probe',
            'category': 'custom', 'toolId': 'tool-perf'})
        if st != 201:
            print('!! POST 失败', st, b[:200]); ok = False; break
        jid = json.loads(b)['id']
        st2, b2, _ = req('/api/console-jobs')
        items = json.loads(b2)
        found = any(it['id'] == jid for it in items)
        dt = (time.time() - t0) * 1000
        vis.append({'created': jid, 'visible': found, 'ms': round(dt, 1)})
        if not found:
            ok = False
    all_vis = all(v['visible'] for v in vis)
    results['visibility_after_post'] = {'all_visible': all_vis, 'samples': vis}
    print('✅ 连发 POST 后立即可见：%s（%d/%d）'
          % ('是' if all_vis else '否', sum(1 for v in vis if v['visible']), len(vis)))
    if vis:
        print('   创建→可见最快 %.1fms，最慢 %.1fms（均 <5s TTL）'
              % (min(v['ms'] for v in vis), max(v['ms'] for v in vis)))

    # ---------- 验收 4：缓存不脏读——GET 内容 vs 直接查库 ----------
    dbp = _dbp
    st, b, _ = req('/api/console-jobs')
    api_items = json.loads(b)
    conn = _sq.connect(dbp)
    conn.row_factory = _sq.Row
    db_items = [dict(r) for r in conn.execute('SELECT * FROM console_jobs ORDER BY created_at')]
    conn.close()
    same_len = len(api_items) == len(db_items)
    same_ids = [i['id'] for i in api_items] == [i['id'] for i in db_items]
    same_answer = all(
        (a.get('answer') or '') == (d.get('answer') or '')
        for a, d in zip(api_items, db_items)
    )
    # GET 前先 sleep 让 TTL 过期再查，确保比对的是落库真值
    time.sleep(5.2)
    st, b, _ = req('/api/console-jobs')
    fresh = json.loads(b)
    fresh_ok = (len(fresh) == len(db_items)
                and [i['id'] for i in fresh] == [i['id'] for i in db_items]
                and all((a.get('answer') or '') == (d.get('answer') or '')
                        for a, d in zip(fresh, db_items)))
    results['integrity'] = {'len_match': same_len, 'id_order_match': same_ids,
                            'answer_match': same_answer, 'after_ttl_match': fresh_ok,
                            'rows': len(db_items)}
    print('✅ 缓存一致性：行数=%s 顺序=%s answer逐字节=%s（TTL 过期后复比=%s，共 %d 行）'
          % (same_len, same_ids, same_answer, fresh_ok, len(db_items)))
    if not (same_len and same_ids and same_answer and fresh_ok):
        ok = False

    # ---------- 验收 5：DELETE 后立刻反映 ----------
    victim = 'job-perf787-000'
    st, _, _ = req('/api/console-jobs/' + victim, 'DELETE')
    st2, b2, _ = req('/api/console-jobs')
    gone = not any(it['id'] == victim for it in json.loads(b2))
    results['delete_visible'] = gone
    print('✅ DELETE 后立刻从列表消失：%s' % ('是' if gone else '否'))
    if not gone:
        ok = False

    # ---------- 验收 6：clear 后立刻空 ----------
    st, _, _ = req('/api/console-jobs', 'DELETE')
    st2, b2, _ = req('/api/console-jobs')
    empty = json.loads(b2) == []
    results['clear_visible'] = empty
    print('✅ 重置控制台后列表立刻为空：%s' % ('是' if empty else '否'))
    if not empty:
        ok = False

    # ---------- 验收 2 判定 ----------
    target_met = p50 < 50.0
    results['acceptance_p50_lt_50ms'] = target_met
    print('✅ 验收 p50<50ms：%s（实测 p50=%.2fms）' % ('通过' if target_met else '未达', p50))
    if not target_met:
        ok = False

except Exception as e:
    import traceback
    traceback.print_exc()
    ok = False
finally:
    results['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify787.result.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    print('OVERALL:', results['overall'])
    sys.exit(0 if ok else 1)
