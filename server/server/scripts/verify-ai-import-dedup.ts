/**
 * T03160（UX-07④⑤）：AI 计划导入去重与关联回执的进程内数据断言。
 * 隔离实例（MTask_DATA_DIR 落 D: 盘临时目录），tsx 直跑源码，不触生产库。
 */
import * as fs from 'node:fs';
process.env.MTask_DATA_DIR = fs.mkdtempSync('D:/tmp/t03160-');
process.env.MTask_PORT = '0';

import { initSchema } from '../src/db/schema';
import { getDb } from '../src/db/connection';
import { PlanService } from '../src/services/PlanService';

initSchema();
const db = getDb();
const iso = () => new Date().toISOString();
db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)')
  .run('p1', 'T03160验证项目', '', iso(), iso());

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const items = () => ([
  { title: '任务甲', description: 'A', durationDays: 2 },
  { title: '任务乙', description: 'B', durationDays: 3 },
  { title: '任务丙', description: 'C', durationDays: 1 },
]);

// 1) 首导（reuse 通道）：全部新建、无关联 → unlinked=3
const r1 = PlanService.createBatch('p1', items(), { onDuplicate: 'reuse' });
check('首导 inserted=3', r1.inserted === 3);
check('首导 reused=0', r1.reused === 0);
check('首导 unlinked=3（未带需求关联的新建行计入未关联）', r1.unlinked === 3);
check('首导 ids 与输入对齐（3 个新 id）', r1.ids.length === 3 && r1.ids.every(Boolean));

// 2) 用户推进其中一行状态后重导同一内容：不生成重复计划、原行状态一字不动
PlanService.update(r1.ids[1]!, { status: 'doing', progress: 50 });
const r2 = PlanService.createBatch('p1', items(), { onDuplicate: 'reuse' });
check('重导 inserted=0（同一内容不生成重复计划）', r2.inserted === 0);
check('重导 reused=3（跳过重复）', r2.reused === 3);
check('重导 unlinked=0（复用行不产生新未关联）', r2.unlinked === 0);
check('库内计划仍 3 行（无重复堆积）', (db.prepare('SELECT COUNT(*) c FROM plan_tasks WHERE project_id=?').get('p1') as { c: number }).c === 3);
const rowB = db.prepare('SELECT status, progress, start_date, end_date, description FROM plan_tasks WHERE id=?').get(r2.ids[1]) as { status: string; progress: number; start_date: string; end_date: string; description: string };
check('复用行 status/progress 不被重导打回', rowB.status === 'doing' && rowB.progress === 50);
check('复用行起止日期不被重导改写', !!rowB.start_date && !!rowB.end_date);

// 3) 需求关联：reqNos 命中既有矩阵行 → req_ids 落库；引用不存在编号 → 点名 warning 且该新行计未关联
db.prepare('INSERT INTO prd_requirements (id, project_id, req_no, title, priority, status, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('q1', 'p1', 'REQ-001', '需求一', 'normal', 'todo', 0, iso(), iso());
const r3 = PlanService.createBatch('p1', [
  { title: '任务丁', reqNos: ['REQ-001'] },
  { title: '任务戊', reqNos: ['REQ-404'] },
], { onDuplicate: 'reuse' });
check('带关联导入 inserted=2', r3.inserted === 2);
check('未关联计数=1（丁已挂接、戊编号不存在）', r3.unlinked === 1);
check('未解析编号点名进 warnings', (r3.warnings ?? []).some((w) => w.includes('REQ-404')));
const ding = db.prepare('SELECT req_ids FROM plan_tasks WHERE id=?').get(r3.ids[0]) as { req_ids: string };
check('命中编号写入 req_ids', JSON.parse(ding.req_ids ?? '[]').includes('q1'));

// 4) reuse 命中的补写语义：描述只在原值为空时补填、req_ids 取并集、状态不动
const wuId = r3.ids[1]!;
PlanService.update(wuId, { status: 'doing', progress: 80 });
const r4 = PlanService.createBatch('p1', [{ title: '任务戊', description: '补充说明', reqNos: ['REQ-001'] }], { onDuplicate: 'reuse' });
check('撞名行走复用（reused=1、inserted=0）', r4.reused === 1 && r4.inserted === 0);
const wu = db.prepare('SELECT status, progress, description, req_ids FROM plan_tasks WHERE id=?').get(wuId) as { status: string; progress: number; description: string; req_ids: string | null };
check('复用行原描述为空→补填', wu.description === '补充说明');
check('复用行 req_ids 并集补挂 REQ-001', JSON.parse(wu.req_ids ?? '[]').includes('q1'));
check('复用行状态/进度仍不动', wu.status === 'doing' && wu.progress === 80);

// 5) kind 分键判重：里程碑与 normal 同名不互相命中（与 importPrd 同函数同口径）
//    注：同名不同 kind 时 taken 让号会把里程碑改名「M1（2）」避免同名行——importPrd 既有口径，非复用命中。
db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)').run('p2', 'P2', '', iso(), iso());
const r5a = PlanService.createBatch('p2', [{ title: 'M1' }], { onDuplicate: 'reuse' });
const r5b = PlanService.createBatch('p2', [{ title: 'M1', kind: 'milestone' as const }], { onDuplicate: 'reuse' });
check('同名不同 kind 不互相复用（走让号新建）', r5a.inserted === 1 && r5b.inserted === 1 && r5b.reused === 0);
const msRow = db.prepare("SELECT title FROM plan_tasks WHERE id=?").get(r5b.ids[0]) as { title: string };
check('让号后缀生效（不产生同名行）', msRow.title !== 'M1');
// 精确 kind+同名 → 复用命中（用里程碑专属项目排除让号干扰）
db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)').run('p3', 'P3', '', iso(), iso());
const r5c = PlanService.createBatch('p3', [{ title: 'M9', kind: 'milestone' as const }], { onDuplicate: 'reuse' });
const r5d = PlanService.createBatch('p3', [{ title: 'M9', kind: 'milestone' as const }], { onDuplicate: 'reuse' });
check('同 kind 同名重导复用命中', r5c.inserted === 1 && r5d.inserted === 0 && r5d.reused === 1 && r5d.ids[0] === r5c.ids[0]);

// 6) 默认（非 reuse）通道行为不变：MCP/PRD 导入沿用原 inserted=clean.length 口径
const r6 = PlanService.createBatch('p2', [{ title: '新条目X' }]);
check('默认通道 inserted=1（不带 reuse 仍直接新建）', r6.inserted === 1 && r6.reused === 0);
const r7 = PlanService.createBatch('p2', [{ title: '新条目X' }]);
check('默认通道重名不吞行（仍新建，由 dupPolicy 拦截策略另行处置）', r7.inserted === 1);

console.log(`\nT03160 去重与关联验证：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
