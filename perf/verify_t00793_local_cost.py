"""T00793：mock 上游下的 AI 端点本地编排成本评估。

目标：把 26 条「外部依赖端点」的上游指到 server/scripts/mock-ai-server.mjs，
      单线程逐个压测，量化**本地编排成本**（prompt 组装、上下文注入、
      prdContext/autoContext 预算截断、SSE 流式回传框架开销），
      输出各端点本地耗时基线表（p50/p95）。

隔离：复用 T00792 的干净树（perf/sandbox/t00792_repo），独立端口 + 独立数据目录。

设计要点：
  - mock 上游与 SUT 同机不同进程；mock 自身耗时 ~0（内存应答，无 IO）。
  - 因此测得的延迟 ≈ 本地编排 + 一次 loopback HTTP 往返。
  - 用 `mock-slow`（mock 侧 2500ms 延迟）做「上游慢」的对照锚点，
    证明本方法能把「本地编排慢」与「上游慢」区分开。
"""
import json, os, shutil, statistics, subprocess, sqlite3, time, urllib.request, urllib.error

REPO = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(REPO, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
MOCK = os.path.join(SRV, 'scripts', 'mock-ai-server.mjs')

SUT_PORT = 39930
MOCK_PORT = 18995
DATA = os.path.join(REPO, 'perf', 'sandbox', 't793')
SUT_LOG = os.path.join(REPO, 'perf', 'sandbox', 't793-sut.log')
MOCK_LOG = os.path.join(REPO, 'perf', 'sandbox', 't793-mock.log')

BASE = f'http://127.0.0.1:{SUT_PORT}'
TOOL_ID = 'tool-t793'
TOOL_SLOW = 'tool-t793-slow'


def rmtree_safe(path):
    if not os.path.exists(path):
        return
    if os.name == 'nt':
        import ctypes
        _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        for root, dirs, files in os.walk(path, topdown=False):
            for f in files:
                _k32.DeleteFileW(os.path.join(root, f))
            for d in dirs:
                _k32.RemoveDirectoryW(os.path.join(root, d))
        _k32.RemoveDirectoryW(path)
    else:
        shutil.rmtree(path, ignore_errors=True)


def proc_spawn(cmd, cwd, env, log):
    lf = open(log, 'w', encoding='utf-8', errors='replace')
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdout=lf, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def proc_kill(p):
    if p is None:
        return
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
        else:
            p.terminate()
    except Exception:
        pass
    try:
        p.wait(timeout=10)
    except Exception:
        pass


def http(method, path, body=None, timeout=60):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        payload = e.read()
        code = e.code
    except Exception as e:
        return {'ms': (time.perf_counter() - t0) * 1000, 'code': 0, 'err': str(e)}
    ms = (time.perf_counter() - t0) * 1000
    try:
        js = json.loads(payload)
    except Exception:
        js = None
    return {'ms': ms, 'code': code, 'json': js, 'bytes': len(payload)}


# ---------------- 启动 ----------------
rmtree_safe(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))

# 1) mock 上游
mock_env = dict(os.environ)
mock_env['MOCK_PORT'] = str(MOCK_PORT)
mock = proc_spawn([NODE, MOCK], SRV, mock_env, MOCK_LOG)
mock_ok = False
for _ in range(40):
    time.sleep(0.25)
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{MOCK_PORT}/v1/models', timeout=2).read()
        mock_ok = True
        break
    except Exception:
        pass
print('MOCK_UP:', mock_ok)

# 2) 预置 ai_tools 指向 mock（含一个 slow 变体做上游慢对照）
con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
con.execute("DELETE FROM ai_tools WHERE id IN (?,?)", (TOOL_ID, TOOL_SLOW))
con.execute(
    "INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,"
    "timeout_ms,enabled,is_default_organize,is_default_develop,pinned,created_at,updated_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (TOOL_ID, 'Mock AI', 'openai-compatible', 'develop',
     f'http://127.0.0.1:{MOCK_PORT}', None, 'mock-model', 0.2, 4096,
     60000, 1, 1, 1, 0, now, now))
con.execute(
    "INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,"
    "timeout_ms,enabled,is_default_organize,is_default_develop,pinned,created_at,updated_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (TOOL_SLOW, 'Mock AI Slow', 'openai-compatible', 'develop',
     f'http://127.0.0.1:{MOCK_PORT}', None, 'mock-slow', 0.2, 4096,
     60000, 1, 0, 0, 0, now, now))
con.commit()

# 取若干真实任务做 organize/classify 夹具
task_ids = [r[0] for r in con.execute(
    "SELECT id FROM tasks WHERE archived=0 AND COALESCE(history_at,'')='' AND title != '' "
    "ORDER BY created_at DESC LIMIT 5")]
# classify 需要 {id,name}[] 对象数组（路径内 c.name 会被 trim）
categories = [{'id': r[0], 'name': r[1]} for r in con.execute(
    "SELECT id, name FROM task_categories WHERE name IS NOT NULL AND name != '' LIMIT 3")]
con.close()
print('FIXTURE task_ids:', len(task_ids), 'categories:', len(categories))

# 3) SUT
sut_env = dict(os.environ)
sut_env['MTask_PORT'] = str(SUT_PORT)
sut_env['MTask_DATA_DIR'] = DATA
sut = proc_spawn([NODE, os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                 SRV, sut_env, SUT_LOG)
sut_ok = False
for _ in range(120):
    time.sleep(0.5)
    try:
        urllib.request.urlopen(f'{BASE}/api/tasks?limit=1', timeout=2).read()
        sut_ok = True
        break
    except Exception:
        pass
print('SUT_UP:', sut_ok)

CASES = []
try:
    if not (mock_ok and sut_ok):
        raise RuntimeError(f'启动失败 mock={mock_ok} sut={sut_ok}')

    # 端点用例：(名称, method, path, body, repeats)
    if task_ids:
        CASES.append(('POST /ai/organize',
                      'POST', '/api/ai/organize',
                      {'taskIds': task_ids, 'toolId': TOOL_ID}, 8))
    CASES += [
        ('POST /ai/chat (无 period)',
         'POST', '/api/ai/chat',
         {'toolId': TOOL_ID, 'user': '总结一下当前进度'}, 8),
        ('POST /ai/chat (period=week)',
         'POST', '/api/ai/chat',
         {'toolId': TOOL_ID, 'user': '本周有什么风险', 'period': 'week'}, 8),
        ('POST /ai/simplify',
         'POST', '/api/ai/simplify',
         {'toolId': TOOL_ID, 'title': '需要简化的一个比较长的任务标题用于测试',
          'description': '这里是任务详情。' * 40}, 8),
        ('POST /ai/beautify',
         'POST', '/api/ai/beautify',
         {'toolId': TOOL_ID, 'title': '美化这个标题'}, 8),
        ('POST /ai/optimize',
         'POST', '/api/ai/optimize',
         {'toolId': TOOL_ID, 'title': '优化标题', 'description': '优化这段提示词内容。' * 20}, 8),
    ]
    if categories:
        CASES.append(('POST /tasks/classify',
                      'POST', '/api/tasks/classify',
                      {'title': '修复登录页白屏', 'categories': categories, 'toolId': TOOL_ID}, 8))
    CASES += [
        ('POST /aitools/:id/models',
         'POST', f'/api/aitools/{TOOL_ID}/models', {}, 8),
        ('POST /update/check',
         'POST', '/api/update/check', {'force': False}, 6),
        # 上游慢对照（mock-slow，2500ms）
        ('[对照] POST /ai/chat (上游 slow)',
         'POST', '/api/ai/chat',
         {'toolId': TOOL_SLOW, 'user': '慢上游对照'}, 3),
    ]

    results = []
    for name, method, path, body, reps in CASES:
        lat, codes, errs = [], [], []
        for i in range(reps):
            r = http(method, path, body, timeout=90)
            lat.append(r['ms'])
            codes.append(r['code'])
            if r['code'] != 200 and len(errs) < 1:
                errs.append(str(r.get('json') or r.get('err'))[:160])
            time.sleep(0.05)
        lat_sorted = sorted(lat)

        def pct(q):
            return round(lat_sorted[min(len(lat_sorted) - 1, int(len(lat_sorted) * q))], 2)

        results.append({
            'endpoint': name, 'n': len(lat),
            'ok_codes': f'{codes.count(200)}/{len(codes)}',
            'codes': codes,
            'err_sample': errs[0] if errs else None,
            'p50': pct(0.5), 'p95': pct(0.95), 'min': round(min(lat), 2), 'max': round(max(lat), 2),
        })
        print(f"{name:38} p50={pct(0.5):8.2f}ms p95={pct(0.95):8.2f}ms codes={codes} {errs[0] if errs else ''}", flush=True)

    print('\n===== RESULT =====')
    payload = {'mock_up': mock_ok, 'sut_up': sut_ok, 'results': results}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    out = os.path.join(REPO, 'perf', 't00793_local_cost.json')
    with open(out, 'w', encoding='utf-8', newline='') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print('\nWROTE:', out)
finally:
    proc_kill(sut)
    proc_kill(mock)
