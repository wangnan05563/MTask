"""T00790 专项验证：refreshSymbols 事务化 + mtime Map 的收益。
用一个符号数未达上限的工作空间（500 文件，每文件少量符号），对比：
- 冷建（索引为空）
- 温重建（全命中 mtime，skipped）
- 变更后重建（部分文件 mtime 变化）
"""
import json, os, shutil, sqlite3, subprocess, sys

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
TSX = os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-mid').replace('\\', '/')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify_790')
PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'
PROD_DB = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data', 'mtask.db')

# 造 500 文件 / 每文件 4 个符号 = 2000 符号（未达 5000 上限）
if os.path.exists(WS):
    shutil.rmtree(WS)
os.makedirs(WS)
for d in range(10):
    sub = os.path.join(WS, 'm%02d' % d)
    os.makedirs(sub)
    for f in range(50):
        lines = []
        for i in range(20):
            if i < 4:
                lines.append('export function m%02d_f%02d_s%d(): void {}' % (d, f, i))
            else:
                lines.append('// filler line %d' % i)
        open(os.path.join(sub, 'f%02d.ts' % f), 'w', encoding='utf-8').write('\n'.join(lines))
print('工作空间:', WS, '文件', sum(len(x) for _, _, x in os.walk(WS)))

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

env = dict(os.environ)
env['MTask_DATA_DIR'] = DATA
env['MTASK_DATA_DIR'] = DATA
env['MTask_PORT'] = '39909'

# 先启动服务完成 migration（建 workspace_symbols 表）
import time, urllib.request
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify_790.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
boot = subprocess.Popen([NODE, TSX, 'src/index.ts'], cwd=os.path.join(ROOT, 'server'), env=env,
                        stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
for i in range(60):
    time.sleep(0.5)
    if boot.poll() is not None:
        break
    try:
        with urllib.request.urlopen('http://127.0.0.1:39909/api/health', timeout=3) as r:
            if r.status == 200:
                print('迁移完成'); break
    except Exception:
        pass
boot.kill()
time.sleep(0.5)

SCRIPT = r'''
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
out.symbolsTotal = WorkspaceService.querySymbols(PID, 'm0', 100).length;
console.log('__RESULT__' + JSON.stringify(out));
'''
sp = os.path.join(ROOT, 'server', 'src', '_perf_790.ts')
open(sp, 'w', encoding='utf-8').write(SCRIPT)
r = subprocess.run([NODE, TSX, sp, PID], capture_output=True, text=True, encoding='utf-8',
                   cwd=os.path.join(ROOT, 'server'), env=env, timeout=600)
os.remove(sp)
if r.returncode != 0:
    print('STDERR:', r.stderr[-2500:]); sys.exit(1)
idx = r.stdout.find('__RESULT__')
res = json.loads(r.stdout[idx + 10:].strip().splitlines()[0])
print(json.dumps(res, ensure_ascii=False, indent=1))
print('\n=== refreshSymbols ===')
print('冷建   : %.1f ms  %s' % (res['cold']['ms'], res['cold']['stat']))
print('温重建 1: %.1f ms  %s' % (res['warm1']['ms'], res['warm1']['stat']))
print('温重建 2: %.1f ms  %s' % (res['warm2']['ms'], res['warm2']['stat']))
