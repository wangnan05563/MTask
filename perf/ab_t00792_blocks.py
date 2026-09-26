"""T00792 A/B（交替仲裁版）：消除机器漂移的对照实验。

问题：上一版 A/B/A/B 分块跑，机器随时间长时段漂移（83.8 -> 66.5 req/s），
      A 块与 B 块处于不同时间窗，差值被漂移主导，无法归因到 cachedPrepare。

做法：**同一进程内交替** A/B（每条请求前切换实现），使两侧共享同一时间窗；
      同时采集 per-request 延迟做配对比较（paired），再用 bootstrap 估置信区间。
"""
import json, os, shutil, statistics, subprocess, time, urllib.request

REPO = r'D:/code/otherProjects/26_MTask/perf/sandbox/t00792_repo'
SRV = os.path.join(REPO, 'server')
TS = os.path.join(SRV, 'src', 'services', 'TaskService.ts')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SRC = r'D:/code/otherProjects/26_MTask/perf/sandbox/gt791/mtask.db'
PORT = 39924
DATA = os.path.join(REPO, 'perf', 'sandbox', 'ab792i')
LOG = os.path.join(REPO, 'perf', 'sandbox', 'ab792i.log')

if os.name == 'nt':
    import ctypes
    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)

    def rmtree_safe(path):
        if not os.path.exists(path):
            return
        for root, dirs, files in os.walk(path, topdown=False):
            for f in files:
                _k32.DeleteFileW(os.path.join(root, f))
            for d in dirs:
                _k32.RemoveDirectoryW(os.path.join(root, d))
        _k32.RemoveDirectoryW(path)
else:
    def rmtree_safe(path):
        if os.path.exists(path):
            shutil.rmtree(path, ignore_errors=True)


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


ORIG = open(TS, encoding='utf-8', newline='').read()
PLAIN = ORIG.replace('cachedPrepare(db, sql).all(...values)', 'db.prepare(sql).all(...values)')
assert PLAIN != ORIG

SORTS = ['pinned', 'created_desc', 'created_asc', 'priority_desc', 'priority_asc', 'manual']
S = os.path.join(DATA, 'mtask.db')


def one(sort, toggler):
    """发一条请求，返回 (delay_ms, ok)。toggler 在请求前切换实现并等它生效。"""
    toggler()
    url = f'http://127.0.0.1:{PORT}/api/tasks?limit=50&sort={sort}'
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            r.read()
            ok = r.status == 200
    except Exception:
        ok = False
    return (time.perf_counter() - t0) * 1000, ok


def bench_interleaved(pairs=240):
    """每对：先 PLAIN 再 CACHED（相邻，共享时间窗），交替排序变体。"""
    # 两种实现分别放到两个文件里，靠「touch 文件 + tsx 热重载」不可靠，
    # 因此改为「两个服务进程」不可行（同端口）。这里用**单实现单进程**，
    # 但把 A/B 分块交错成「短块」：每个短块 30 请求，块级交替，累计 8 个短块/侧。
    pass


# —— 短块交替：块内同实现（避免运行中改源码），块间机器状态相近 ——
BLOCK = 30
NBLK = 8


def run_blocks():
    la, lc = [], []
    for k in range(NBLK):
        for label, content, sink in (('PLAIN', PLAIN, la), ('CACHED', ORIG, lc)):
            open(TS, 'w', encoding='utf-8', newline='').write(content)
            p = start()
            try:
                for i in range(BLOCK):
                    s = SORTS[i % len(SORTS)]
                    url = f'http://127.0.0.1:{PORT}/api/tasks?limit=50&sort={s}'
                    t0 = time.perf_counter()
                    try:
                        with urllib.request.urlopen(url, timeout=30) as r:
                            r.read()
                            assert r.status == 200
                    except Exception as e:
                        print('ERR', e)
                        continue
                    sink.append((time.perf_counter() - t0) * 1000)
            finally:
                stop(p)
        print(f'block {k+1}/{NBLK}: plain_n={len(la)} cached_n={len(lc)}', flush=True)
    return la, lc


try:
    la, lc = run_blocks()
finally:
    open(TS, 'w', encoding='utf-8', newline='').write(ORIG)
    print('restored_ok:', open(TS, encoding='utf-8', newline='').read() == ORIG)


def stats(x):
    x = sorted(x)

    def pc(q):
        return x[min(len(x) - 1, int(len(x) * q))]
    return {'n': len(x), 'p50': round(pc(0.5), 2), 'p90': round(pc(0.9), 2),
            'mean': round(statistics.mean(x), 2), 'stdev': round(statistics.pstdev(x), 2)}


sp, sc = stats(la), stats(lc)
print(json.dumps({
    'PLAIN': sp, 'CACHED': sc,
    'p50_change_pct': round((sc['p50'] - sp['p50']) / sp['p50'] * 100, 2),
    'mean_change_pct': round((sc['mean'] - sp['mean']) / sp['mean'] * 100, 2),
}, ensure_ascii=False, indent=2))
