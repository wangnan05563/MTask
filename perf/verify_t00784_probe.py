"""T00784 验证：反向索引改造的正确性（结构等价）+ 性能收益（耗时对比）。

做法：
1. 用 TS 直接编译 PlanService 的两个版本（旧 O(N×M) / 新反向索引）在同库上跑，
   对比返回 JSON 逐字段相等 → 证明行为等价。
2. 计时对比，量化收益。

数据：用 seed-v3 造的大数据集（400 需求 × 950 任务）才看得出差距。
"""
import json, os, re, shutil, subprocess, sys, textwrap, time

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
DATA = os.path.join(ROOT, 'perf', 'sandbox', 'data3')
pid = '1ca54445-192d-4664-b495-f1830eb9b8e4'

# 直接对生产库跑（只读）——用生产库的 mtask 项目，但需求数少；
# 更好：用 seed 库。先看 seed 库是否存在
for cand in [os.path.join(DATA, 'mtask.db'),
             os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'MTask', 'data', 'mtask.db')]:
    if os.path.exists(cand):
        print('可用库:', cand)
