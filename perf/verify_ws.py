"""T00786/T00782/T00790 直接验证：隔离库 + 大工作空间，实测三处优化收益。

通过 tsx 直接 import WorkspaceService，绕过 HTTP 层，精确测量：
1. search() 无命中路径的预算截断（T00786）：扫描文件数 ≤ 2000、partial 标记
2. autoContext() 批量缓存（T00782 M-1）：同一关键词重复调用耗时骤降；多关键词集合总耗时
3. refreshSymbols() 事务化 + mtime Map（T00790①②）：冷建/温重建耗时
"""
import json, os, shutil, sqlite3, subprocess, sys, time, uuid

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
TSX = os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-big').replace('\\', '/')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws')
PROD_DB = os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data', 'mtask.db')

if os.path.exists(DATA):
    shutil.rmtree(DATA)
os.makedirs(DATA, exist_ok=True)
shutil.copy2(PROD_DB, os.path.join(DATA, 'mtask.db'))

# 绑定工作空间到 mtask 项目（测试副本的 schema 可能缺列，先补齐）
PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'
con = sqlite3.connect(os.path.join(DATA, 'mtask.db'))
cols = [r[1] for r in con.execute('PRAGMA table_info(projects)')]
if 'workspace_path' not in cols:
    con.execute('ALTER TABLE projects ADD COLUMN workspace_path TEXT')
    print('已补列 projects.workspace_path')
con.execute('UPDATE projects SET workspace_path = ? WHERE id = ?', (WS, PID))
con.commit()
print('已绑定工作空间:', con.execute('SELECT workspace_path FROM projects WHERE id=?', (PID,)).fetchone())
con.close()

SCRIPT = r'''
import { WorkspaceService } from './services/WorkspaceService';
const PID = process.argv[2];
const WS = process.argv[3];

function ms(fn) { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }

const out = {};

// ---- T00786: 无命中路径预算 ----
const miss = ms(() => WorkspaceService.search(PID, 'zzzz_not_exist_keyword_zzzz'));
out.searchMiss = { ms: Math.round(miss.ms * 10) / 10, hits: miss.r.length, partial: miss.r.partial, scannedFiles: miss.r.scannedFiles };

// 弱命中（只匹配到极少文件）
const weak = ms(() => WorkspaceService.search(PID, 'mod07Fn099'));
out.searchWeak = { ms: Math.round(weak.ms * 10) / 10, hits: weak.r.length, partial: weak.r.partial, scannedFiles: weak.r.scannedFiles };

// 强命中（很多文件都有）——应在 50 条早退
const strong = ms(() => WorkspaceService.search(PID, 'export const v'));
out.searchStrong = { ms: Math.round(strong.ms * 10) / 10, hits: strong.r.length, partial: strong.r.partial, scannedFiles: strong.r.scannedFiles };

// 常规关键词
const normal = ms(() => WorkspaceService.search(PID, 'return'));
out.searchNormal = { ms: Math.round(normal.ms * 10) / 10, hits: normal.r.length, partial: normal.r.partial };

// ---- T00782 M-1: autoContext 批量缓存 ----
WorkspaceService.invalidateSearchCache(PID);
const kws = ['mod07Fn099', 'export', 'function', 'return', 'const', 'number', 'value', 'module', 'file', 'index', 'data'];

const first = ms(() => WorkspaceService.autoContext(PID, kws));
const second = ms(() => WorkspaceService.autoContext(PID, kws));
const third = ms(() => WorkspaceService.autoContext(PID, kws));
out.autoContext = {
  firstMs: Math.round(first.ms * 10) / 10,     // 含一次全树预扫描
  secondMs: Math.round(second.ms * 10) / 10,   // 命中 memo，应显著更快
  thirdMs: Math.round(third.ms * 10) / 10,
  outLen: first.r.length,
  sameOutput: first.r === second.r && second.r === third.r,
};

// 模拟 organize 10 任务：每任务 11 关键词（原先 = 110 次全树扫描）
WorkspaceService.invalidateSearchCache(PID);
const t0 = process.hrtime.bigint();
for (let t = 0; t < 10; t++) WorkspaceService.autoContext(PID, kws);
out.organizeSim = { totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 10) / 10 };

// ---- T00790: refreshSymbols ----
WorkspaceService.clearSymbols(PID);
const cold = ms(() => WorkspaceService.refreshSymbols(PID));
const warm = ms(() => WorkspaceService.refreshSymbols(PID));
const warm2 = ms(() => WorkspaceService.refreshSymbols(PID));
out.refreshSymbols = {
  coldMs: Math.round(cold.ms * 10) / 10, coldStat: cold.r,
  warmMs: Math.round(warm.ms * 10) / 10, warmStat: warm.r,
  warm2Ms: Math.round(warm2.ms * 10) / 10, warm2Stat: warm2.r,
};

// 符号查询仍可用
out.querySymbols = WorkspaceService.querySymbols(PID, 'mod07Fn099', 10);

console.log('__RESULT__' + JSON.stringify(out));
'''

script_path = os.path.join(ROOT, 'server', 'src', '_perf_ws_probe.ts')
open(script_path, 'w', encoding='utf-8').write(SCRIPT.replace('ROOT', ROOT.replace('\\', '/')).replace("'ROOT/server/src/services/WorkspaceService'", "'./services/WorkspaceService'"))

env = dict(os.environ)
env['MTask_DATA_DIR'] = DATA
env['MTASK_DATA_DIR'] = DATA
env['MTask_PORT'] = '39906'

# 先启动一次服务完成 schema migration（CREATE TABLE IF NOT EXISTS 在启动时执行），
# 确保 workspace_symbols 等表存在后再跑直接探针
import urllib.request
LOG = os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws_boot.log')
logf = open(LOG, 'w', encoding='utf-8', errors='replace')
boot = subprocess.Popen([NODE, TSX, 'src/index.ts'], cwd=os.path.join(ROOT, 'server'), env=env,
                        stdout=logf, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
ready = False
for i in range(60):
    time.sleep(0.5)
    if boot.poll() is not None:
        break
    try:
        with urllib.request.urlopen('http://127.0.0.1:39906/api/health', timeout=3) as r:
            if r.status == 200:
                ready = True
                break
    except Exception:
        pass
print('迁移实例就绪:', ready)
boot.kill()
time.sleep(0.5)

r = subprocess.run([NODE, TSX, script_path, PID, WS], capture_output=True, text=True,
                   encoding='utf-8', cwd=os.path.join(ROOT, 'server'), env=env, timeout=600)
print('--- stdout ---')
print(r.stdout[-6000:])
if r.returncode != 0:
    print('--- stderr ---')
    print(r.stderr[-4000:])
    sys.exit(1)

idx = r.stdout.find('__RESULT__')
res = json.loads(r.stdout[idx + len('__RESULT__'):].strip().splitlines()[0])
json.dump(res, open(os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws.result.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('已保存结果')
