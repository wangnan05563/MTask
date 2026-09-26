"""T00786/T00782/T00790 验证：构造大工作空间，实测三处优化。

工作空间：perf/sandbox/ws-big —— 3000 个 .ts 文件（每个 ~40 行），避开 DEFAULT_IGNORE_DIRS。
"""
import os, shutil, sys

ROOT = r'D:/code/otherProjects/26_MTask'
WS = os.path.join(ROOT, 'perf', 'sandbox', 'ws-big')

if os.path.exists(WS):
    shutil.rmtree(WS)

N_DIRS = 30
N_FILES_PER_DIR = 100   # 30 × 100 = 3000 文件
LINES = 40

body = '\n'.join('export const K%03d_%03d = "%s";' % (0, i, 'x' * 20) for i in range(LINES))

os.makedirs(WS, exist_ok=True)
for d in range(N_DIRS):
    sub = os.path.join(WS, 'mod%02d' % d)
    os.makedirs(sub, exist_ok=True)
    for f in range(N_FILES_PER_DIR):
        lines = []
        for i in range(LINES):
            if i == 5:
                lines.append('export function mod%02dFn%03d(): number { return %d; }' % (d, f, i))
            else:
                lines.append('export const v%02d_%03d = "%s";' % (d, i, 'y' * 30))
        open(os.path.join(sub, 'file%03d.ts' % f), 'w', encoding='utf-8').write('\n'.join(lines))

total = sum(len(fs) for _, _, fs in os.walk(WS))
ts = sum(1 for _, _, fs in os.walk(WS) for f in fs if f.endswith('.ts'))
print('工作空间:', WS)
print('总文件', total, ' ts 文件', ts)
