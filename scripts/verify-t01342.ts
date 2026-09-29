// T01342 隔离验证：护栏拦截 LLM 决策的悬空/越权 taskId（真实性闸）
// 临时数据目录 + initSchema，不触碰生产库。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mtask-t01342-'));
process.env.MTask_DATA_DIR = tmp;

import { getDb } from '../server/src/db/connection';
import { initSchema } from '../server/src/db/schema';
import { guard, type GuardAction } from '../server/src/services/SupervisorGuard';
import { applyActions } from '../server/src/services/SupervisorExecutor';

const setSetting = (k: string, v: string) =>
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

let fail = 0;
const check = (name: string, cond: boolean, extra?: string) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};

async function main() {
  initSchema();
  const db = getDb();
  setSetting('supervisor.enabled', '1'); // 开熔断开关，否则整轮被闸 1 拦下

  // 建项目 + 一个真实任务（快照内）
  const projectId = 'p_t01342';
  db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)')
    .run(projectId, 'T01342', new Date().toISOString(), new Date().toISOString());
  const realId = 'task_real';
  db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, status, verified, ai_state, ai_state_at, monitor_retry, monitor_ready, created_at, updated_at)
    VALUES (?,?,?,?, 'todo', 0, '', '', 0, 1, ?, ?)`)
    .run(realId, 'T90001', projectId, '真实任务', new Date().toISOString(), new Date().toISOString());

  const ghostId = 'task_ghost_0000'; // 幻觉 id（库中不存在、也不在快照）
  const snapIds = new Set<string>([realId]);

  const act = (type: string, taskId?: string): GuardAction => ({ type, taskId, reason: '测试' } as GuardAction);

  console.log('\n[场景1] 快照内的 taskId → 放行（回归，行为同现状）');
  let r = guard([act('RESUME', realId)], { concurrent: 0, knownTaskIds: snapIds });
  check('放行 1 条', r.applied.length === 1 && r.blocked.length === 0, `applied=${r.applied.length} blocked=${r.blocked.length}`);
  check('放行的是原动作（未被改写）', r.applied[0]?.type === 'RESUME' && r.applied[0]?.taskId === realId);
  check('blockedBy 为空', r.blockedBy === '');

  console.log('\n[场景2] 快照外的 taskId（幻觉/越权）→ 降级 ESCALATE，不落地');
  r = guard([act('RESUME', ghostId)], { concurrent: 0, knownTaskIds: snapIds });
  check('未被放行', r.applied.length === 0, `applied=${r.applied.length}`);
  check('被拦 1 条', r.blocked.length === 1);
  check('降级为 ESCALATE', r.blocked[0]?.degraded.type === 'ESCALATE', r.blocked[0]?.degraded.type);
  check('降级保留原 taskId（便于人工接手）', r.blocked[0]?.degraded.taskId === ghostId);
  check('降级 reason 含拦截说明与原始动作', (r.blocked[0]?.degraded.reason ?? '').includes('不在本轮快照') && (r.blocked[0]?.degraded.reason ?? '').includes('RESUME'));
  check('blockedBy 汇总含「目标任务不在快照」（供审计 blocked_by）', r.blockedBy.includes('目标任务不在快照'), r.blockedBy);

  console.log('\n[场景3] 被拦动作不占并发槽');
  setSetting('supervisor.maxConcurrent', '2');
  // 并发尚余 1 槽：假动作若占槽，后面的真实动作就会被并发闸拦下
  r = guard([act('RESUME', ghostId), act('RESUME', realId)], { concurrent: 1, knownTaskIds: snapIds });
  check('假动作被真实性闸拦（reason 含「不在本轮快照」）',
    r.blocked.length === 1 && r.blocked[0]?.action.taskId === ghostId && (r.blocked[0]?.reason ?? '').includes('不在本轮快照'),
    r.blocked[0]?.reason ?? '');
  check('真实动作仍获放行（证明假动作未占并发槽）', r.applied.length === 1 && r.applied[0]?.taskId === realId, `applied=${r.applied.length}`);

  console.log('\n[场景3b] 被拦动作不写数据（无越权写）');
  const before = db.prepare('SELECT ai_state, monitor_retry, monitor_ready, monitor_preferred_platform FROM tasks WHERE id = ?').get(realId) as Record<string, unknown>;
  r = guard([act('RESUME', ghostId)], { concurrent: 0, knownTaskIds: snapIds });
  const out = await applyActions(r.applied);
  check('applyActions 不处理被拦动作（applied 为空）', r.applied.length === 0 && out.length === 0);
  const after = db.prepare('SELECT ai_state, monitor_retry, monitor_ready, monitor_preferred_platform FROM tasks WHERE id = ?').get(realId) as Record<string, unknown>;
  check('任务行未被改动（guard/apply 未越权写）', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  console.log('\n[场景4] SPLIT 指向不存在任务 → 不新建/不改写任何任务');
  const cntBefore = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  r = guard([act('SPLIT', ghostId)], { concurrent: 0, knownTaskIds: snapIds });
  check('SPLIT 被拦', r.applied.length === 0 && r.blocked.length === 1);
  await applyActions(r.applied);
  const cntAfter = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  check('任务总数不变（未新建子任务）', cntBefore === cntAfter, `${cntBefore} → ${cntAfter}`);

  console.log('\n[场景5] 未传 knownTaskIds（既有调用方）→ 不做真实性校验，行为不变');
  r = guard([act('RESUME', ghostId)], { concurrent: 0 });
  check('未传集合时仍放行（向后兼容）', r.applied.length === 1 && r.blocked.length === 0);

  console.log('\n[场景6] 无 taskId 的动作维持既有语义');
  r = guard([act('CONTINUE')], { concurrent: 0, knownTaskIds: snapIds });
  check('CONTINUE 放行', r.applied.length === 1);
  r = guard([act('ESCALATE', ghostId)], { concurrent: 0, knownTaskIds: snapIds });
  check('ESCALATE 放行（已是人工态，不再二次降级）', r.applied.length === 1);

  console.log(fail === 0 ? '\nALL PASS' : `\nHAS FAILURE (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
