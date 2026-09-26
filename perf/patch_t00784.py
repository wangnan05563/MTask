"""T00784：listRequirements 反向索引改造（带位置断言防并发改写）。
改法：把 reqs.map 内的 plans.filter/tasks.filter（每次重 parse）换成一次遍历建 Map<reqId, items[]>。
"""
import hashlib
import io
import sys

P = r'D:/code/otherProjects/26_MTask/server/src/services/PlanService.ts'
src = io.open(P, encoding='utf-8', newline='').read()
before_md5 = hashlib.md5(src.encode('utf-8')).hexdigest()
print('改写前 md5:', before_md5)

OLD = """    // T00763：项目内 PRD 文档摘要——矩阵行经 prd_id 关联，前端「查看PRD」按钮按此取文档
    const prdDocs = db.prepare('SELECT id, filename FROM prd_docs WHERE project_id = ?').all(projectId) as Array<{ id: string; filename: string }>;
    const docById = new Map(prdDocs.map((d) => [d.id, d]));
    return reqs.map((r) => {
      const rid = String(r.id);
      const linkedPlans = plans.filter((p) => parse(p.req_ids).includes(rid)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
      const linkedTasks = tasks.filter((x) => parse(x.req_ids).includes(rid)).map((x) => ({ id: x.id, taskNo: x.task_no, title: x.title, status: x.status, verified: !!x.verified }));
      const prdId = typeof r.prd_id === 'string' ? r.prd_id : null;
      const prdDoc = prdId ? docById.get(prdId) : undefined;
      return { ...r, linkedPlans, linkedTasks, prdDoc: prdDoc ?? null };
    });"""

NEW = """    // T00763：项目内 PRD 文档摘要——矩阵行经 prd_id 关联，前端「查看PRD」按钮按此取文档
    const prdDocs = db.prepare('SELECT id, filename FROM prd_docs WHERE project_id = ?').all(projectId) as Array<{ id: string; filename: string }>;
    const docById = new Map(prdDocs.map((d) => [d.id, d]));
    // T00784：反向索引替换 O(N×M) 逐需求 filter——原先每个需求都对全量 plans/tasks 重跑
    // JSON.parse（N 需求 × M 计划/任务），压测实测 436 次调用累计 117.6s 事件循环时间，
    // 并拖慢同进程所有其它端点。现改为对 plans/tasks 各遍历一次建 Map<reqId, 摘要[]>，
    // 复杂度降为 O(N+M)，req_ids 仅解析一次。（不改返回结构与字段顺序）
    const plansByReq = new Map<string, Array<{ id: string; title: string; status: string }>>();
    for (const p of plans) {
      for (const id of parse(p.req_ids)) {
        const bucket = plansByReq.get(id);
        const item = { id: p.id, title: p.title, status: p.status };
        if (bucket) bucket.push(item); else plansByReq.set(id, [item]);
      }
    }
    const tasksByReq = new Map<string, Array<{ id: string; taskNo: string | null; title: string; status: string; verified: boolean }>>();
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
    });"""

# 位置断言：确认锚点唯一
cnt = src.count(OLD)
print('锚点命中次数:', cnt)
assert cnt == 1, '锚点不唯一或不匹配（可能有并发改写），中止'

src2 = src.replace(OLD, NEW, 1)
io.open(P, 'w', encoding='utf-8', newline='').write(src2)
after_md5 = hashlib.md5(io.open(P, encoding='utf-8', newline='').read().encode('utf-8')).hexdigest()
print('改写后 md5:', after_md5)
print('✅ 已写入')
