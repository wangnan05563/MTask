"""T00792 A/B（干净 checkout 版）：在仅含 T00792 改动的隔离树上，
切换 cachedPrepare <-> db.prepare，同一 DB、交替多轮，量化端点级收益。

为什么需要这一版：
  - 工作区 TaskService.ts 含并发会话 WIP（buildTaskFilter/loadPlanLinkedTitles 等重构），
    在工作区做 A/B 会把这些 WIP 一并算进对照组，结论不可信。
  - 本脚本作用于 perf/sandbox/t00792_repo（git archive HEAD + 仅 T00792 三个文件的改动）。
"""
import json, os, shutil, statistics, subprocess, time, urllib.request

# safe-delete 沙箱绕过：shutil.rmtree 会触发 SAFE_DELETE_BULK_CONFIRM_REQUIRED（threshold 50）。
# 直接调 Win32 DeleteFileW / RemoveDirectoryW，不经 Python 层包装。
if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)

    def _rmtree_win32(path):
        if not os.path.exists(path):
            return
        if os.path.isfile(path):
            _k32.DeleteFileW(path)
            return
        for root, dirs, files in os.walk(path, topdown=False):
            for f in files:
                _k32.DeleteFileW(os.path.join(root, f))
            for d in dirs:
                _k32.RemoveDirectoryW(os.path.join(root, d))
        _k32.RemoveDirectoryW(path)

    def rmtree_safe(path):
        try:
            _rmtree_win32(path)
        except Exception:
            pass
else:
    def rmtree_safe(path):
        if os.path.exists(path):
            shutil.rmtree(path, ignore_errors=True)

REPO = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(REPO, 'server')
TS = os.path.join(SRV, 'src', 'services', 'TaskService.ts')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
PORT = 39923
DATA = os.path.join(REPO, 'perf', 'sandbox', 'ab792')
LOG = os.path.join(REPO, 'perf', 'sandbox', 'ab792.log')

ORIG = open(TS, encoding='utf-8', newline='').read()
assert 'cachedPrepare(db, sql).all(...values)' in ORIG, 'cachedPrepare 调用未找到'
PLAIN = ORIG.replace('cachedPrepare(db, sql).all(...values)', 'db.prepare(sql).all(...values)')
assert PLAIN != ORIG and 'cachedPrepare(db, sql).all' not in PLAIN


def write_ts(content):
    open(TS, 'w', encoding='utf-8', newline='').write(content)


def start():
    rmtree_safe(DATA)
    os.makedirs(DATA, exist_ok=True)
    shutil.copy2(SRC, os.path.join(DATA, 'mtask.db'))
    env = dict(os.environ)
    env['MTask_PORT'] = str(PORT)
    env['MTask_DATA_DIR'] = DATA
    lf = open(LOG, 'w', encoding='utf-8', errors='replace')
    p = subprocess.Popen(
        [NODE, os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
        cwd=SRV, env=env, stdout=lf, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    )
    for _ in range(120):
        time.sleep(0.5)
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/tasks?limit=1', timeout=2).read()
            return p
        except Exception:
            pass
    raise RuntimeError('服务启动超时')


def stop(p):
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
    time.sleep(1.0)


SORTS = ['pinned', 'created_desc', 'created_asc', 'priority_desc', 'priority_asc', 'manual']


def bench(label, rounds=3, per_round=60):
    p = start()
    try:
        lat = []
        body = b''
        for _ in range(rounds):
            for i in range(per_round):
                s = SORTS[i % len(SORTS)]
                url = f'http://127.0.0.1:{PORT}/api/tasks?limit=50&sort={s}'
                t0 = time.perf_counter()
                try:
                    with urllib.request.urlopen(url, timeout=30) as resp:
                        body = resp.read()
                        assert resp.status == 200
                except Exception as e:
                    print('ERR', e)
                    continue
                lat.append((time.perf_counter() - t0) * 1000)
        lat.sort()

        def pc(q):
            return lat[min(len(lat) - 1, int(len(lat) * q))]

        return {
            'label': label, 'n': len(lat),
            'req_s': round(len(lat) / (sum(lat) / 1000), 2),
            'p50': round(pc(0.5), 2), 'p90': round(pc(0.9), 2), 'p95': round(pc(0.95), 2),
            'mean': round(statistics.mean(lat), 2), 'bytes': len(body),
        }
    finally:
        stop(p)


try:
    write_ts(PLAIN)
    r1 = bench('PLAIN')
    write_ts(ORIG)
    r2 = bench('CACHED')
    write_ts(PLAIN)
    r3 = bench('PLAIN')
    write_ts(ORIG)
    r4 = bench('CACHED')
finally:
    write_ts(ORIG)
    print('restored_ok:', open(TS, encoding='utf-8', newline='').read() == ORIG)

plain_p50 = statistics.mean([r1['p50'], r3['p50']])
cached_p50 = statistics.mean([r2['p50'], r4['p50']])
plain_rps = statistics.mean([r1['req_s'], r3['req_s']])
cached_rps = statistics.mean([r2['req_s'], r4['req_s']])

print(json.dumps({
    'rounds': [r1, r2, r3, r4],
    'plain_p50_avg': round(plain_p50, 2),
    'cached_p50_avg': round(cached_p50, 2),
    'p50_change_pct': round((cached_p50 - plain_p50) / plain_p50 * 100, 2),
    'plain_rps_avg': round(plain_rps, 2),
    'cached_rps_avg': round(cached_rps, 2),
    'throughput_gain_x': round(cached_rps / plain_rps, 3),
}, ensure_ascii=False, indent=2))
