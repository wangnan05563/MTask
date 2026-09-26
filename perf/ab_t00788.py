"""T00788 A/B 端点级对照：临时切回 N+1 旧实现，与 IN 分组新实现端到端对比。

目的：验证 N+1→IN 改动在**端点级**是否真有收益（纯 SQL 层已测出 0.88×，需确认端点侧）。
做法：把 server/src/routes/history.ts 备份 → 写入旧实现 → 起实例测量 → 还原 → 起实例测量。
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
HIST = os.path.join(SRV, 'src', 'routes', 'history.ts')
BAK = os.path.join(ROOT, 'perf', 'sandbox', '_history.new.ts.bak')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify788b')

LEGACY_BLOCK = '''historyApi.get('/list', (_req, res) => {
  const db = getDb();
  const projects = db.prepare("SELECT id, name, description, history_at FROM projects WHERE COALESCE(history_at,'') != '' ORDER BY history_at DESC").all() as Array<{ id: string; name: string; description: string; history_at: string }>;
  const snapshots = projects.map((p) => {
    const tasks = db.prepare('SELECT id, task_no, title, description, status, verified, priority, category_id, handle_result, created_at FROM tasks WHERE project_id = ? ORDER BY task_no').all(p.id) as Array<Record<string, unknown>>;
    const plans = db.prepare('SELECT id, title, description, kind, status, progress, start_date, end_date, duration_days FROM plan_tasks WHERE project_id = ? ORDER BY sort_order').all(p.id) as Array<Record<string, unknown>>;
    return {
      ...p,
      stats: {
        tasks: tasks.length,
        doneTasks: tasks.filter((t) => t.status === 'done').length,
        plans: plans.length,
        donePlans: plans.filter((x) => x.status === 'done').length,
      },
      tasks,
      plans,
    };
  });
  res.json({ snapshots });
});'''


def extract_block(src, start_marker):
    """从 start_marker（行首 historyApi.get('/list' 声明）起，按花括号配平提取整个 handler 块。
    不能用首个 '});' 结束——handler 内部含嵌套的 db.prepare(...) 调用。"""
    i = src.index(start_marker)
    k = src.index('{', i)  # 首个 '{' 即 handler 体起点
    depth = 0
    j = k
    while j < len(src):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                j += 1
                break
        j += 1
    # 吞掉收尾的 ');'
    while j < len(src) and src[j] in ');':
        j += 1
    return src[i:j], i, j


def req(port, path, timeout=60):
    t0 = time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=timeout) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), (time.time() - t0) * 1000
    except Exception as e:
        return 0, str(e), (time.time() - t0) * 1000


def measure(port, label, logpath):
    env = dict(os.environ)
    env['MTask_PORT'] = str(port)
    env['MTask_DATA_DIR'] = DATA
    logf = open(logpath, 'w', encoding='utf-8', errors='replace')
    proc = subprocess.Popen([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
                            cwd=SRV, env=env, stdout=logf, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        ready = False
        for _ in range(80):
            time.sleep(0.5)
            if proc.poll() is not None:
                logf.flush()
                print('!! [%s] 进程退出，日志：' % label)
                print(open(logpath, encoding='utf-8', errors='replace').read()[-1800:])
                return None
            st, _, _ = req(port, '/api/health', timeout=3)
            if st == 200:
                ready = True
                break
        if not ready:
            print('!! [%s] 未就绪' % label)
            return None
        lat, body = [], None
        for _ in range(30):
            st, b, ms = req(port, '/api/history/list')
            if st != 200:
                print('!! [%s] GET 失败 %s' % (label, st)); return None
            lat.append(ms); body = b
        s = sorted(lat)
        return {'label': label, 'n': len(lat),
                'p50_ms': round(s[len(s) // 2], 2),
                'p95_ms': round(s[max(0, int(len(s) * 0.95) - 1)], 2),
                'min_ms': round(s[0], 2), 'max_ms': round(s[-1], 2),
                'payload_kb': round(len(body.encode('utf-8')) / 1024, 1),
                '_body': body, '_lat': lat}
    finally:
        try:
            proc.terminate(); proc.wait(timeout=10)
        except Exception:
            try: proc.kill()
            except Exception: pass


# ---------- 备份当前（新）实现 ----------
orig = open(HIST, encoding='utf-8').read()
with open(BAK, 'w', encoding='utf-8') as f:
    f.write(orig)
new_block, ni, nj = extract_block(orig, "historyApi.get('/list'")
print('已备份新实现 → %s（新块 %d 字符，位置 %d..%d）' % (BAK, nj - ni, ni, nj))

res = {}
try:
    # ---------- 测新实现 ----------
    r_new = measure(39914, 'NEW(IN分组)', os.path.join(ROOT, 'perf', 'sandbox', 'ab788_new.log'))
    if not r_new:
        print('新实现测量失败'); sys.exit(1)
    print('✅ [NEW  ] p50=%.2fms p95=%.2fms  (%.1f KB)' % (r_new['p50_ms'], r_new['p95_ms'], r_new['payload_kb']))
    body_new = r_new.pop('_body'); lat_new = r_new.pop('_lat')

    # ---------- 换成旧实现 ----------
    patched = orig[:ni] + LEGACY_BLOCK + orig[nj:]
    with open(HIST, 'w', encoding='utf-8') as f:
        f.write(patched)
    print('已临时切回 N+1 旧实现（测毕自动还原）')

    r_old = measure(39915, 'OLD(N+1)', os.path.join(ROOT, 'perf', 'sandbox', 'ab788_old.log'))
    if not r_old:
        print('旧实现测量失败'); sys.exit(1)
    print('✅ [OLD  ] p50=%.2fms p95=%.2fms  (%.1f KB)' % (r_old['p50_ms'], r_old['p95_ms'], r_old['payload_kb']))
    body_old = r_old.pop('_body'); lat_old = r_old.pop('_lat')

    # ---------- 还原 ----------
    with open(HIST, 'w', encoding='utf-8') as f:
        f.write(orig)
    restored = open(HIST, encoding='utf-8').read()
    print('✅ 已还原新实现：一致=%s' % (restored == orig))

    same_body = json.dumps(json.loads(body_new), sort_keys=True, ensure_ascii=False) == \
                json.dumps(json.loads(body_old), sort_keys=True, ensure_ascii=False)
    res['ab'] = {'new': r_new, 'old': r_old,
                 'p50_ratio_new_over_old': round(r_new['p50_ms'] / max(r_old['p50_ms'], 0.001), 3),
                 'response_identical': same_body,
                 'restored_ok': restored == orig}
    print('\n✅ 两者响应体逐字节等价：%s' % ('是' if same_body else '否'))
    print('✅ 端点 p50：NEW %.2fms vs OLD %.2fms → %.3f×（<1 表示新实现更快）'
          % (r_new['p50_ms'], r_old['p50_ms'], r_new['p50_ms'] / max(r_old['p50_ms'], 0.001)))
except Exception:
    import traceback; traceback.print_exc()
    with open(HIST, 'w', encoding='utf-8') as f:
        f.write(orig)
    print('!! 异常，已还原新实现')
finally:
    with open(HIST, 'w', encoding='utf-8') as f:
        f.write(orig)
    print('\n===== RESULT =====')
    print(json.dumps(res, ensure_ascii=False, indent=2))
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'ab788.result.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
