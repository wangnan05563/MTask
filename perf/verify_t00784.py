"""T00784 等价性 + 性能对比：
在同一份 seed 库上分别运行「旧 O(N×M) 实现」与「新反向索引实现」，
断言返回 JSON 完全一致，并对比耗时。
"""
import json, os, shutil, subprocess, sys, time

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SEED = os.path.join(ROOT, 'perf', 'sandbox', 'data3', 'mtask.db')
SANDBOX = os.path.join(ROOT, 'perf', 'sandbox', 'gt791')
os.makedirs(SANDBOX, exist_ok=True)

# 复用已补种关联的副本（由 seed_req_links.py 生成，含 req_ids 关联数据）
DB = os.path.join(SANDBOX, 'mtask.db')
if not os.path.exists(DB):
    print('!! 缺少补种副本，请先运行 perf/seed_req_links.py'); sys.exit(1)
print('测试库:', DB, os.path.getsize(DB), 'bytes')

GEN = r'''
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const PROJECT_ID = process.argv[3];
const IMPL = process.argv[4];

function now(){ return new Date().toISOString(); }

function listRequirementsOLD(projectId) {
  const reqs = db.prepare('SELECT * FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId);
  const plans = db.prepare('SELECT id, title, status, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId);
  const tasks = db.prepare('SELECT id, task_no, title, status, verified, req_ids FROM tasks WHERE project_id = ? AND archived = 0').all(projectId);
  const parse = (v) => { if (!v) return []; try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
  const prdDocs = db.prepare('SELECT id, filename FROM prd_docs WHERE project_id = ?').all(projectId);
  const docById = new Map(prdDocs.map((d) => [d.id, d]));
  return reqs.map((r) => {
    const rid = String(r.id);
    const linkedPlans = plans.filter((p) => parse(p.req_ids).includes(rid)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
    const linkedTasks = tasks.filter((x) => parse(x.req_ids).includes(rid)).map((x) => ({ id: x.id, taskNo: x.task_no, title: x.title, status: x.status, verified: !!x.verified }));
    const prdId = typeof r.prd_id === 'string' ? r.prd_id : null;
    const prdDoc = prdId ? docById.get(prdId) : undefined;
    return { ...r, linkedPlans, linkedTasks, prdDoc: prdDoc ?? null };
  });
}

function listRequirementsNEW(projectId) {
  const reqs = db.prepare('SELECT * FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId);
  const plans = db.prepare('SELECT id, title, status, req_ids FROM plan_tasks WHERE project_id = ? AND archived = 0').all(projectId);
  const tasks = db.prepare('SELECT id, task_no, title, status, verified, req_ids FROM tasks WHERE project_id = ? AND archived = 0').all(projectId);
  const parse = (v) => { if (!v) return []; try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
  const prdDocs = db.prepare('SELECT id, filename FROM prd_docs WHERE project_id = ?').all(projectId);
  const docById = new Map(prdDocs.map((d) => [d.id, d]));
  const plansByReq = new Map();
  for (const p of plans) {
    for (const id of parse(p.req_ids)) {
      const bucket = plansByReq.get(id);
      const item = { id: p.id, title: p.title, status: p.status };
      if (bucket) bucket.push(item); else plansByReq.set(id, [item]);
    }
  }
  const tasksByReq = new Map();
  for (const x of tasks) {
    for (const id of parse(x.req_ids)) {
      const bucket = tasksByReq.get(id);
      const item = { id: x.id, taskNo: x.task_no, title: x.title, status: x.status, verified: !!x.verified };
      if (bucket) bucket.push(item); else tasksByReq.set(id, [item]);
    }
  }
  return reqs.map((r) => {
    const rid = String(r.id);
    const linkedPlans = plansByReq.get(rid) ?? [];
    const linkedTasks = tasksByReq.get(rid) ?? [];
    const prdId = typeof r.prd_id === 'string' ? r.prd_id : null;
    const prdDoc = prdId ? docById.get(prdId) : undefined;
    return { ...r, linkedPlans, linkedTasks, prdDoc: prdDoc ?? null };
  });
}

const fn = IMPL === 'old' ? listRequirementsOLD : listRequirementsNEW;
// 预热
fn(PROJECT_ID);
const N = Number(process.argv[5] || 3);
const times = [];
let out = null;
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  out = fn(PROJECT_ID);
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
}
console.log(JSON.stringify({
  impl: IMPL, n: out.length,
  timesMs: times.map((x) => Math.round(x * 100) / 100),
  planRefs: out.reduce((s, r) => s + r.linkedPlans.length, 0),
  taskRefs: out.reduce((s, r) => s + r.linkedTasks.length, 0),
  hash: require('crypto').createHash('md5').update(JSON.stringify(out)).digest('hex'),
  sample: out.slice(0, 2),
}));
'''

src = os.path.join(SANDBOX, 'cmp.cjs')
open(src, 'w', encoding='utf-8').write(GEN)

PID = 'proj-main'  # 压测主项目：1805 需求 × 4291 计划 × 2209 任务


def run(impl, n=3):
    r = subprocess.run([NODE, src, DB, PID, impl, str(n)], capture_output=True, text=True,
                       cwd=ROOT, encoding='utf-8')
    if r.returncode != 0:
        print('ERR', impl, r.stderr[-2000:]); sys.exit(1)
    return json.loads(r.stdout.strip().splitlines()[-1])


print('\n=== 旧实现 O(N×M) ===')
old = run('old')
print('  需求数=%d 计划关联=%d 任务关联=%d' % (old['n'], old['planRefs'], old['taskRefs']))
print('  耗时(ms):', old['timesMs'], ' 中位=%.1f' % sorted(old['timesMs'])[len(old['timesMs']) // 2])
print('  结构 hash:', old['hash'])

print('\n=== 新实现 反向索引 ===')
new = run('new')
print('  需求数=%d 计划关联=%d 任务关联=%d' % (new['n'], new['planRefs'], new['taskRefs']))
print('  耗时(ms):', new['timesMs'], ' 中位=%.1f' % sorted(new['timesMs'])[len(new['timesMs']) // 2])
print('  结构 hash:', new['hash'])

print('\n=== 等价性断言 ===')
ok = (old['hash'] == new['hash'] and old['n'] == new['n']
      and old['planRefs'] == new['planRefs'] and old['taskRefs'] == new['taskRefs'])
print('  全量 JSON md5 一致:', old['hash'] == new['hash'])
print('  条目数一致:', old['n'] == new['n'], '(%d vs %d)' % (old['n'], new['n']))
print('  关联引用数一致:', old['planRefs'] == new['planRefs'] and old['taskRefs'] == new['taskRefs'])
print('  ==> %s' % ('✅ 行为完全等价' if ok else '❌ 存在差异'))

om = sorted(old['timesMs'])[len(old['timesMs']) // 2]
nm = sorted(new['timesMs'])[len(new['timesMs']) // 2]
print('\n=== 性能 ===')
print('  旧中位 %.1f ms → 新中位 %.1f ms' % (om, nm))
print('  加速比: %.1fx' % (om / nm if nm else 0))
print('  单次节省: %.1f ms' % (om - nm))

json.dump({'old': old, 'new': new, 'equal': ok, 'speedup': om / nm if nm else None},
          open(os.path.join(SANDBOX, 'result.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
