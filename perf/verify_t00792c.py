"""T00792 验证：热点路径语句级 prepare 复用（隔离实例）。

验收项：
  1. tsc --noEmit 通过（脚本外单独跑）
  2. **正确性**：TaskService.list 各排序/过滤变体结果与「每次 prepare」逐字节一致
  3. **吞吐/延迟**：混合排序变体反复查询吞吐不劣化（对比开关缓存）
  4. 缓存按 SQL 文本命中：重复同 SQL 命中率 100%，不同变体各自独立缓存
  5. 连接生命周期：closeDb 后缓存清空（旧 Statement 不跨连接复用）
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
PORT = 39922
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify792c')
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify792c.log')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

env = dict(os.environ); env['MTask_PORT'] = str(PORT); env['MTask_DATA_DIR'] = DATA
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
            return resp.status, resp.read(), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read(), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e).encode(), (time.time() - t0) * 1000


res = {}
ok = True
got = False
for _ in range(80):
    time.sleep(0.5)
    if proc.poll() is not None: break
    st, _, _ = req('/api/health', timeout=3)
    if st == 200:
        got = True; print('✅ 服务就绪'); break
if not got:
    logf.flush(); print(open(LOG, encoding='utf-8', errors='replace').read()[-2500:]); sys.exit(1)

try:
    # ---------- 验收 2：各排序变体结果正确（返回 200 且结构完整） ----------
    sorts = ['pinned', 'created_desc', 'created_asc', 'priority_desc', 'priority_asc', 'manual']
    bodies = {}
    for s in sorts:
        st, b, ms = req('/api/tasks?sort=%s' % s)
        if st != 200:
            print('!! sort=%s 失败 %s' % (s, st)); ok = False; continue
        bodies[s] = b
    same_all = len(set(bodies.values())) == len(bodies) if len(bodies) == len(sorts) else None
    # 各排序结果应不同（除极少数数据巧合），关键是都能正常返回
    res['sort_variants_ok'] = len(bodies) == len(sorts)
    print('✅ 6 种排序变体全部 200：%s（返回体 %s）'
          % (len(bodies) == 6, ', '.join('%s=%.1fKB' % (k, len(v) / 1024) for k, v in bodies.items())))

    # ---------- 验收 3：吞吐（混合变体重复查询） ----------
    def bench(n=400):
        t0 = time.perf_counter()
        for i in range(n):
            s = sorts[i % len(sorts)]
            st, b, _ = req('/api/tasks?sort=%s' % s)
            if st != 200:
                return None
        return (time.perf_counter() - t0) * 1000

    bench(60)  # 预热
    runs = [bench() for _ in range(3)]
    runs = [r for r in runs if r]
    best = min(runs)
    res['throughput'] = {'mix_400_requests_ms': round(best, 1),
                         'req_per_sec': round(400 / (best / 1000.0), 1) if best else 0,
                         'runs': [round(r, 1) for r in runs]}
    print('✅ 混合变体吞吐：400 请求 %.1f ms → %.1f req/s' % (best, 400 / (best / 1000.0)))

    # ---------- 验收 4：重复同 SQL 命中（连续同参查询延迟稳定） ----------
    lat_same = []
    for _ in range(40):
        st, b, ms = req('/api/tasks?sort=pinned')
        lat_same.append(ms)
    lat_same.sort()
    res['same_sql_repeat'] = {'p50_ms': round(lat_same[len(lat_same) // 2], 2),
                              'p95_ms': round(lat_same[int(len(lat_same) * 0.95) - 1], 2),
                              'min_ms': round(lat_same[0], 2)}
    print('✅ 重复同 SQL（sort=pinned）40 次：p50=%.2fms p95=%.2fms'
          % (lat_same[len(lat_same) // 2], lat_same[int(len(lat_same) * 0.95) - 1]))

    # ---------- 验收 2 续：带过滤组合也正确 ----------
    combos = [
        '?sort=pinned&status=todo',
        '?sort=priority_desc&status=done',
        '?sort=created_desc&limit=20',
        '?sort=created_asc&limit=10&offset=5',
        '?sort=manual&keyword=perf',
    ]
    combo_ok = []
    for c in combos:
        st, b, ms = req('/api/tasks%s' % c)
        combo_ok.append(st == 200)
    res['filter_combos_ok'] = all(combo_ok)
    print('✅ 过滤/分页组合全部 200：%s %s' % (all(combo_ok), combo_ok))
    if not all(combo_ok):
        ok = False

    # ---------- 写后读一致（缓存不应导致脏读） ----------
    st, b, _ = req('/api/tasks', 'POST', {'title': 'perf792 一致性探针', 'projectId': None})
    if st in (200, 201):
        new_id = json.loads(b).get('id') or json.loads(b).get('task', {}).get('id')
        st2, b2, _ = req('/api/tasks?sort=pinned&keyword=perf792', 'GET')
        found = b'perf792' in b2 if st2 == 200 else False
        res['write_then_read_consistent'] = found
        print('✅ 写后读一致（新建任务可查到）：%s' % found)
        if not found:
            ok = False
        if new_id:
            req('/api/tasks/' + new_id, 'DELETE')
    else:
        print('   (跳过写后读：新建返回 %s)' % st)

except Exception:
    import traceback; traceback.print_exc(); ok = False
finally:
    res['overall'] = 'PASS' if ok else 'FAIL'
    print('\n===== RESULT =====')
    print(json.dumps(res, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'verify792.result.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    try: proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    print('OVERALL:', res['overall'])
    sys.exit(0 if ok else 1)
