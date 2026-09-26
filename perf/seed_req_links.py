"""为 seed 库补种需求-计划/任务关联（相当于真实使用场景：需求矩阵已建立关联）。
不加此数据，listRequirements 的 O(N×M) 差异体现不出来（parse(null) 秒返回）。
"""
import json, os, shutil, sqlite3

ROOT = r'D:/code/otherProjects/26_MTask'
SANDBOX = os.path.join(ROOT, 'perf', 'sandbox', 'gt791')
DB = os.path.join(SANDBOX, 'mtask.db')
SEED = os.path.join(ROOT, 'perf', 'sandbox', 'data3', 'mtask.db')

# 从原始 seed 重新复制（避免上次运行残留）
shutil.copy2(SEED, DB)

con = sqlite3.connect(DB)
PID = 'proj-main'
reqs = [r[0] for r in con.execute('SELECT id FROM prd_requirements WHERE project_id=? ORDER BY sort_order', (PID,))]
plans = [r[0] for r in con.execute('SELECT id FROM plan_tasks WHERE project_id=? AND archived=0', (PID,))]
tasks = [r[0] for r in con.execute('SELECT id FROM tasks WHERE project_id=? AND archived=0', (PID,))]
print('需求 %d / 计划 %d / 任务 %d' % (len(reqs), len(plans), len(tasks)))

# 真实场景：部分需求被关联（约 45% 需求有关联，每个关联 1~4 个计划 + 2~6 个任务）
import random
random.seed(20260918)

n_link_req = int(len(reqs) * 0.45)
linked_reqs = reqs[:n_link_req]
print('将建立关联的需求数:', n_link_req)

# 建立计划→需求 映射：先给每个计划分配 1~3 个需求
plan_reqs = {}
for p in plans:
    k = random.randint(1, 3)
    plan_reqs[p] = random.sample(linked_reqs, min(k, len(linked_reqs)))

task_reqs = {}
for t in tasks:
    if random.random() < 0.55:
        k = random.randint(1, 4)
        task_reqs[t] = random.sample(linked_reqs, min(k, len(linked_reqs)))

# 写回 req_ids
n_p = 0
for p, ids in plan_reqs.items():
    con.execute('UPDATE plan_tasks SET req_ids=? WHERE id=?', (json.dumps(ids), p))
    n_p += 1
n_t = 0
for t, ids in task_reqs.items():
    con.execute('UPDATE tasks SET req_ids=? WHERE id=?', (json.dumps(ids), t))
    n_t += 1
con.commit()

# 验证
has_p = con.execute("SELECT COUNT(*) FROM plan_tasks WHERE project_id=? AND COALESCE(req_ids,'')!=''", (PID,)).fetchone()[0]
has_t = con.execute("SELECT COUNT(*) FROM tasks WHERE project_id=? AND COALESCE(req_ids,'')!=''", (PID,)).fetchone()[0]
print('写入后：带 req_ids 的计划 %d / 任务 %d' % (has_p, has_t))

# 统计关联分布
import collections
c = collections.Counter()
for (v,) in con.execute("SELECT req_ids FROM plan_tasks WHERE project_id=? AND COALESCE(req_ids,'')!=''", (PID,)):
    for i in json.loads(v):
        c[i] += 1
print('平均每需求被计划引用: %.2f' % (sum(c.values()) / max(len(c), 1)))
con.close()
print('✅ 补种完成（t00784 验证专用副本）')
