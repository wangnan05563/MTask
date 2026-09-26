"""T00790 前后对比：先跑改造后（事务+mtime Map），再切换为改造前重跑。"""
import json, os, shutil, sqlite3, subprocess, sys, time, urllib.request

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
TSX = os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-mid').replace('\\', '/')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify_790')
PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'
PROD_DB = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data', 'mtask.db')

# --- 造工作空间：500 文件 / 2000 符号（不触上限）---
if os.path.exists(WS):
    shutil.rmtree(WS)
os.makedirs(WS)
for d in range(10):
    sub = os.path.join(WS, 'm%02d' % d)
    os.makedirs(sub)
    for f in range(50):
        lines = []
        for i in range(20):
            lines.append('export function m%02d_f%02d_s%d(): void {}' % (d, f, i) if i < 4 else '// filler %d' % i)
        open(os.path.join(sub, 'f%02d.ts' % f), 'w', encoding='utf-8').write('\n'.join(lines))
print('工作空间:', WS, '文件数', sum(len(x) for _, _, x in os.walk(WS)))

PROBE = r'''
import { WorkspaceService } from './services/WorkspaceService';
const PID = process.argv[2];
function ms(fn) { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }
const out = {};
WorkspaceService.clearSymbols(PID);
const c = ms(() => WorkspaceService.refreshSymbols(PID));
out.cold = { ms: c.ms, stat: c.r };
const w1 = ms(() => WorkspaceService.refreshSymbols(PID));
out.warm1 = { ms: w1.ms, stat: w1.r };
const w2 = ms(() => WorkspaceService.refreshSymbols(PID));
out.warm2 = { ms: w2.ms, stat: w2.r };
out.q = WorkspaceService.querySymbols(PID, 'm0', 5).length;
console.log('__RESULT__' + JSON.stringify(out));
'''


def prep_db():
    if os.path.exists(DATA):
        shutil.rmtree(DATA)
    os.makedirs(DATA)
    shutil.copy2(PROD_DB, os.path.join(DATA, 'mtask.db'))
    con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
    cols = [r[1] for r in con.execute('PRAGMA table_info(projects)')]
    if 'workspace_path' not in cols:
        con.execute('ALTER TABLE projects ADD COLUMN workspace_path TEXT')
    con.execute('UPDATE projects SET workspace_path = ? WHERE id = ?', (WS, PID))
    con.commit()
    con.close()


def migrate():
    env = dict(os.environ)
    env['MTask_DATA_DIR'] = DATA
    env['MTASK_DATA_DIR'] = DATA
    env['MTask_PORT'] = '39909'
    logf = open(os.path.join(ROOT, 'perf', 'sandbox', 'verify_790.log'), 'w', encoding='utf-8', errors='replace')
    b = subprocess.Popen([NODE, TSX, 'src/index.ts'], cwd=os.path.join(ROOT, 'server'), env=env,
                         stdout=logf, stderr=subprocess.STDOUT,
                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(60):
        time.sleep(0.5)
        if b.poll() is not None:
            break
        try:
            with urllib.request.urlopen('http://127.0.0.1:39909/api/health', timeout=3) as r:
                if r.status == 200:
                    break
        except Exception:
            pass
    b.kill()
    time.sleep(0.5)


def probe(label):
    env = dict(os.environ)
    env['MTask_DATA_DIR'] = DATA
    env['MTASK_DATA_DIR'] = DATA
    env['MTask_PORT'] = '39909'
    sp = os.path.join(ROOT, 'server', 'src', '_perf_790.ts')
    open(sp, 'w', encoding='utf-8').write(PROBE)
    r = subprocess.run([NODE, TSX, sp, PID], capture_output=True, text=True, encoding='utf-8',
                       cwd=os.path.join(ROOT, 'server'), env=env, timeout=900)
    os.remove(sp)
    if r.returncode != 0:
        print(label, 'FAIL:', r.stderr[-2000:]); sys.exit(1)
    idx = r.stdout.find('__RESULT__')
    res = json.loads(r.stdout[idx + 10:].strip().splitlines()[0])
    print('\n[%s] 冷建 %.1f ms %s' % (label, res['cold']['ms'], res['cold']['stat']))
    print('      温重建1 %.1f ms %s' % (res['warm1']['ms'], res['warm1']['stat']))
    print('      温重建2 %.1f ms %s' % (res['warm2']['ms'], res['warm2']['stat']))
    return res


# --- 改造后 ---
subprocess.run([NODE, '-e', '1'], capture_output=True)  # noop
subprocess.run(['C:/Users/hspcadmin/.workbuddy/binaries/python/versions/3.13.12/python.exe',
                os.path.join(ROOT, 'perf', 'toggle_ws_impl.py'), 'revert'], capture_output=True)
prep_db(); migrate()
after = probe('改造后 事务+mtimeMap')

# --- 改造前 ---
subprocess.run(['C:/Users/hspcadmin/.workbuddy/binaries/python/versions/3.13.12/python.exe',
                os.path.join(ROOT, 'perf', 'toggle_ws_impl.py'), 'before'], capture_output=True)
before = probe('改造前 无事务+逐文件SELECT')

# --- 还原 ---
subprocess.run(['C:/Users/hspcadmin/.workbuddy/binaries/python/versions/3.13.12/python.exe',
                os.path.join(ROOT, 'perf', 'toggle_ws_impl.py'), 'revert'], capture_output=True)

print('\n=== T00790 对比 ===')
print('冷建  : 改造前 %.1f ms → 改造后 %.1f ms  (提速 %.1fx)' % (
    before['cold']['ms'], after['cold']['ms'],
    before['cold']['ms'] / after['cold']['ms'] if after['cold']['ms'] else 0))
print('温重建: 改造前 %.1f ms → 改造后 %.1f ms' % (before['warm1']['ms'], after['warm1']['ms']))
print('符号数一致性: 改造前 %s / 改造后 %s' % (before['cold']['stat'], after['cold']['stat']))

json.dump({'before': before, 'after': after},
          open(os.path.join(ROOT, 'perf', 'sandbox', 't790_cmp.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
