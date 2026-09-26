"""T00786/T00782/T00790 改造前后对比：
在同一工作空间上运行改造前实现（用 patched=false 的方式反转关键点）与改造后实现。

做法：直接对比「有预算」与「无预算」两版 search 语义，以及「有 memo」与「无 memo」两版 autoContext。
用参数注入方式（临时改常量）不便，改为：
- search 预算：临时把 SEARCH_MAX_FILES 设为极大值 → 等价改造前（无上限）
- autoContext memo：改造前 = 逐关键词调 search（可用 invalidateSearchCache + 每关键词 search 模拟）
"""
import json, os, shutil, sqlite3, subprocess, sys

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
TSX = os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-big').replace('\\', '/')
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'verify_ws')
PID = '1ca54445-192d-4664-b495-f1830eb9b8e4'

SCRIPT = r'''
import { WorkspaceService } from './services/WorkspaceService';
const PID = process.argv[2];

function ms(fn) { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }
const out = {};
const kws = ['mod07Fn099', 'export', 'function', 'return', 'const', 'number', 'value', 'module', 'file', 'index', 'data'];

// ---- 改造前 autoContext 语义：每个关键词各调一次 search（全树扫描）----
WorkspaceService.invalidateSearchCache(PID);
const t0 = process.hrtime.bigint();
let collected = 0;
for (let t = 0; t < 10; t++) {
  for (const kw of kws) {
    const hits = WorkspaceService.search(PID, kw);
    collected += hits.length;
  }
}
out.before_organize = { totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 10) / 10, calls: 10 * kws.length, collected };

// ---- 改造后：memo 缓存 ----
WorkspaceService.invalidateSearchCache(PID);
const t1 = process.hrtime.bigint();
for (let t = 0; t < 10; t++) WorkspaceService.autoContext(PID, kws);
out.after_organize = { totalMs: Math.round(Number(process.hrtime.bigint() - t1) / 1e6 * 10) / 10 };

// ---- 单次无命中检索（改造后 = 有预算 800）----
WorkspaceService.invalidateSearchCache(PID);
const m1 = ms(() => WorkspaceService.search(PID, 'zzzz_not_exist_zzzz'));
out.after_miss = { ms: Math.round(m1.ms * 10) / 10, partial: m1.r.partial, scannedFiles: m1.r.scannedFiles };

console.log('__RESULT__' + JSON.stringify(out));
'''

sp = os.path.join(ROOT, 'server', 'src', '_perf_cmp.ts')
open(sp, 'w', encoding='utf-8').write(SCRIPT)

env = dict(os.environ)
env['MTask_DATA_DIR'] = DATA
env['MTASK_DATA_DIR'] = DATA
env['MTask_PORT'] = '39908'

r = subprocess.run([NODE, TSX, sp, PID], capture_output=True, text=True, encoding='utf-8',
                   cwd=os.path.join(ROOT, 'server'), env=env, timeout=900)
os.remove(sp)
if r.returncode != 0:
    print('STDERR:', r.stderr[-3000:]); sys.exit(1)
idx = r.stdout.find('__RESULT__')
res = json.loads(r.stdout[idx + 10:].strip().splitlines()[0])
print(json.dumps(res, ensure_ascii=False, indent=1))

b = res['before_organize']['totalMs']
a = res['after_organize']['totalMs']
print('\n=== organize 10 任务 × 11 关键词 ===')
print('改造前（逐关键词全树扫描）: %.1f ms  (%d 次 search)' % (b, res['before_organize']['calls']))
print('改造后（memo 一次预扫描）  : %.1f ms' % a)
print('加速比: %.1fx  节省 %.1f ms' % (b / a if a else 0, b - a))
print('\n改造后无命中检索: %.1f ms  partial=%s  scannedFiles=%d' % (
    res['after_miss']['ms'], res['after_miss']['partial'], res['after_miss']['scannedFiles']))
