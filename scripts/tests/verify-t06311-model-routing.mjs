/**
 * T06311（REQ-038 / PRD §B9）模型路由与成本预算独立验收。
 *
 * 覆盖：增量表、任务类型推断、成本/延迟/上下文/健康度路由、80% 预警、
 * 100% 硬停、单 Run 上限降级横幅、模拟器不占预算、队列 auto 落真实工具、
 * 审计与成本归因导出。全部使用临时 SQLite，不触碰生产库。
 *
 * 运行：
 *   node scripts/tests/verify-t06311-model-routing.mjs
 * 可选环境：
 *   T06311_OUT=/path/to/evidence  MTask_DATA_DIR=/tmp/...
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const OUT = process.env.T06311_OUT || 'D:/tmp/t06311-model-routing';
const DATA = process.env.T06311_DATA || join(OUT, 'db');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

mkdirSync(OUT, { recursive: true });
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.MTask_DATA_DIR = DATA;

const dbSchema = await import(pathToFileURL(join(ROOT, 'server/dist/db/schema.js')).href);
dbSchema.initSchema();
const { getDb } = await import(pathToFileURL(join(ROOT, 'server/dist/db/connection.js')).href);
const { ModelRoutingService, ModelRoutingError } = await import(
  pathToFileURL(join(ROOT, 'server/dist/services/ModelRoutingService.js')).href
);
const { QueueService } = await import(pathToFileURL(join(ROOT, 'server/dist/services/QueueService.js')).href);

const db = getDb();
const at = new Date(2026, 10, 25, 10, 0, 0, 0);
const iso = at.toISOString();
const now = iso;

function seedProject(id, name) {
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, '', 0, 10, now, now);
}
function seedTask(id, projectId, title, description) {
  db.prepare('INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
    .run(id, null, projectId, title, description, 'normal', 'todo', now, now);
}
function seedTool(id, name, model, maxTokens = 4096) {
  db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, model, max_tokens, timeout_ms, enabled, is_default_organize, is_default_develop, created_at, updated_at)
              VALUES (?, ?, 'openai-compatible', 'develop', 'http://127.0.0.1:1', ?, ?, 30000, 1, 0, 0, ?, ?)`)
    .run(id, name, model, maxTokens, now, now);
}
function seedQueue(id, name = 'T06311-queue') {
  db.prepare('INSERT INTO queues (id, name, date, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, '2026-11-25', 'draft', now);
}
function addCommittedDecision(projectId, cost, runId = null, model = 'seed') {
  const id = `seed-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO model_route_decisions
      (id, task_id, project_id, run_id, task_type, selected_tool_id, selected_model, estimated_cost,
       estimated_latency_ms, input_tokens, output_tokens, budget_status, budget_banner, downgraded_from,
       reason, candidates_json, committed, created_at)
      VALUES (?, NULL, ?, ?, 'general', 'seed-tool', ?, ?, 0, 1, 1, 'ok', '', '', 'seed', '[]', 1, ?)`)
    .run(id, projectId, runId, model, cost, now);
}

seedProject('p-t06311', 'T06311路由验收');
seedTask('t-t06311', 'p-t06311', '修复登录按钮在深色主题下不可见的问题', '定位按钮色值并改为 Design Token，补充回归验证。');
seedQueue('q-t06311');

seedTool('tool-cheap', '轻量快模', 'cheap-1');
seedTool('tool-long', '长上下文模型', 'long-context-1');
seedTool('tool-strong', '高质模型', 'strong-1');
seedTool('tool-premium', '摘要优选模型', 'premium-1');
seedTool('tool-down', '故障供应商', 'down-1');
seedTool('tool-degraded', '降级供应商', 'degraded-1');

ModelRoutingService.upsertProfile('tool-cheap', {
  inputCostPer1K: 0.001, outputCostPer1K: 0.002, expectedLatencyMs: 300, contextLimit: 32000,
  capabilities: 'general,summary,testcase,code', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-long', {
  inputCostPer1K: 0.006, outputCostPer1K: 0.012, expectedLatencyMs: 1200, contextLimit: 256000,
  capabilities: 'general,summary,long-context', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-strong', {
  inputCostPer1K: 0.012, outputCostPer1K: 0.024, expectedLatencyMs: 1800, contextLimit: 200000,
  capabilities: 'general,code,review,summary', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-premium', {
  inputCostPer1K: 0.009, outputCostPer1K: 0.018, expectedLatencyMs: 200, contextLimit: 256000,
  capabilities: 'summary,long-context,general', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-down', {
  inputCostPer1K: 0.0001, outputCostPer1K: 0.0002, expectedLatencyMs: 100, contextLimit: 128000,
  capabilities: 'general,code', health: 'down',
});
ModelRoutingService.upsertProfile('tool-degraded', {
  inputCostPer1K: 0.0002, outputCostPer1K: 0.0004, expectedLatencyMs: 900, contextLimit: 128000,
  capabilities: 'general,summary', health: 'degraded',
});

ModelRoutingService.upsertBudget('p-t06311', {
  projectLimit: 100, dailyLimit: 5, monthlyLimit: 20, runLimit: 1, warningPct: 80, stopMode: 'stop',
});

check('增量表：画像/预算/决策三表存在', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('model_route_profiles','model_budgets','model_route_decisions')").all();
  assert(tables.length === 3, `实际 ${tables.length}`);
  return tables.map((t) => t.name).join(',');
});
check('画像：成本/延迟/上下文/能力/健康 5 维落库', () => {
  const p = ModelRoutingService.listProfiles().find((x) => x.toolId === 'tool-cheap');
  assert(p && p.configured, '画像未配置');
  assert(p.inputCostPer1K === 0.001 && p.contextLimit === 32000, '画像字段不符');
  assert(p.capabilities.includes('code'), '能力缺失 code');
  return `${p.inputCostPer1K}/${p.expectedLatencyMs}/${p.contextLimit}`;
});
check('任务类型：代码修复 → code', () => {
  assert(ModelRoutingService.inferTaskType('修复登录按钮在深色主题下不可见的问题') === 'code', '未推断 code');
  assert(ModelRoutingService.inferTaskType('整理本周任务摘要') === 'summary', '未推断 summary');
  return 'code,summary';
});
check('短上下文代码任务：成本/延迟更优的轻量快模胜出', () => {
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '修复登录按钮', contextTokens: 1000, outputTokens: 200, at, commit: false });
  assert(d.selectedToolId === 'tool-cheap', `实际 ${d.selectedToolId}`);
  assert(d.taskType === 'code', `任务类型 ${d.taskType}`);
  assert(d.budget.state === 'ok', `预算状态 ${d.budget.state}`);
  return `${d.selectedModel} $${d.estimatedCost.toFixed(4)}`;
});
check('健康度：down 供应商即使最便宜也排除', () => {
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '普通开发任务', contextTokens: 1000, outputTokens: 200, at, commit: false });
  const down = d.candidates.find((c) => c.toolId === 'tool-down');
  assert(down && down.excludedReason.includes('down'), 'down 未排除');
  assert(d.selectedToolId !== 'tool-down', '选中了 down');
  return down.excludedReason;
});
check('上下文：32k 模型在 100k 输入下排除', () => {
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '总结大型 PRD', taskType: 'summary', contextTokens: 100000, outputTokens: 500, costLimit: 0.8, at, commit: false });
  const cheap = d.candidates.find((c) => c.toolId === 'tool-cheap');
  assert(cheap && cheap.excludedReason.includes('上下文'), '32k 未排除');
  assert(d.selectedToolId === 'tool-long', `实际 ${d.selectedToolId}`);
  return `${d.selectedToolId} ${d.estimatedCost.toFixed(4)}`;
});
check('单 Run 上限：优选模型超限时降级并返回横幅', () => {
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '总结大型 PRD', taskType: 'summary', contextTokens: 100000, outputTokens: 500, costLimit: 0.4, at, commit: false });
  assert(d.selectedToolId === 'tool-degraded', `实际 ${d.selectedToolId}`);
  assert(d.downgradedFrom.includes('long-context-1'), `降级来源 ${d.downgradedFrom}`);
  assert(d.banner.includes('降级') && d.banner.includes('单 Run'), `横幅 ${d.banner}`);
  return d.banner;
});
check('模拟器：commit=false 不落库、不占预算', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM model_route_decisions').get().c;
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '摘要测试', contextTokens: 1000, outputTokens: 200, at, commit: false });
  assert(d.committed === false, '模拟器标记错误');
  assert(db.prepare('SELECT COUNT(*) AS c FROM model_route_decisions').get().c === before, '模拟器落库了');
  return `decisions=${before}`;
});
check('80% 预警：预算不拒绝但返回预警横幅', () => {
  addCommittedDecision('p-t06311', 4.2, 'seed-run-warning');
  const d = ModelRoutingService.route({ projectId: 'p-t06311', title: '摘要测试', contextTokens: 1000, outputTokens: 200, at, commit: false });
  assert(d.budget.state === 'warning', `状态 ${d.budget.state}`);
  assert(d.banner.includes('预算预警'), `横幅 ${d.banner}`);
  return `${d.budget.percent.toFixed(1)}%`;
});
check('100% 硬停：stop 模式抛 409 并写 hard_stop 审计', () => {
  addCommittedDecision('p-t06311', 5.0, 'seed-run-hard');
  let thrown = null;
  try {
    ModelRoutingService.route({ projectId: 'p-t06311', title: '摘要测试', contextTokens: 1000, outputTokens: 200, at, commit: true });
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof ModelRoutingError, '未抛出 ModelRoutingError');
  assert(thrown.statusCode === 409, `status ${thrown.statusCode}`);
  assert(thrown.code === 'budget_hard_stop', `code ${thrown.code}`);
  const row = db.prepare("SELECT * FROM model_route_decisions WHERE project_id='p-t06311' AND budget_status='hard_stop' ORDER BY created_at DESC LIMIT 1").get();
  assert(row && Number(row.committed) === 1, 'hard_stop 未写审计');
  return thrown.message;
});
check('预算快照：项目/日/月/单 Run 四档读数一致', () => {
  const s = ModelRoutingService.budgetSnapshot('p-t06311', at);
  assert(s.budget && s.budget.dailyLimit === 5, '预算缺失');
  assert(s.spend.day >= 9.2, `日花费 ${s.spend.day}`);
  assert(s.scopes.some((x) => x.key === 'day' && x.state === 'hard_stop'), '日预算未 hard_stop');
  return `day=${s.spend.day.toFixed(2)}`;
});
check('预算写入：degrade 模式可持久化', () => {
  const b = ModelRoutingService.upsertBudget('p-t06311', { stopMode: 'degrade', dailyLimit: 10 });
  assert(b.stopMode === 'degrade' && b.dailyLimit === 10, 'degrade 未保存');
  return b.stopMode;
});
check('降级策略：预算无可用候选时仍硬停（不静默放行）', () => {
  addCommittedDecision('p-t06311', 0.8, 'seed-run-degrade');
  let thrown = null;
  try {
    ModelRoutingService.route({ projectId: 'p-t06311', title: '摘要测试', contextTokens: 1000, outputTokens: 200, at, commit: true });
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof ModelRoutingError && thrown.code === 'budget_hard_stop', 'degrade 未硬停');
  return thrown.message;
});
check('队列 auto：落库写真实 tool_id，不写 auto', () => {
  db.prepare('DELETE FROM model_route_decisions WHERE project_id=?').run('p-t06311');
  const jobs = QueueService.addJobs('q-t06311', [{ taskId: 't-t06311', toolId: 'auto' }]);
  assert(jobs.length === 1 && jobs[0].tool_id === 'tool-cheap', `实际 ${jobs[0]?.tool_id}`);
  const d = db.prepare("SELECT * FROM model_route_decisions WHERE project_id='p-t06311' ORDER BY created_at DESC LIMIT 1").get();
  assert(d && d.selected_tool_id === 'tool-cheap', '路由决策未落库');
  return `${jobs[0].id.slice(0, 8)} → ${jobs[0].tool_id}`;
});
check('审计：真实路由 committed=1 且候选/原因可读', () => {
  const rows = ModelRoutingService.listDecisions('p-t06311', 10);
  assert(rows.length >= 1 && rows[0].candidates.length >= 3, '审计候选不足');
  assert(rows[0].reason.includes('任务类型'), '审计原因缺失');
  return `decisions=${rows.length}`;
});
check('成本归因：按模型聚合且可导出 CSV', () => {
  const rows = ModelRoutingService.costAttribution('p-t06311');
  assert(rows.length >= 1 && rows[0].estimatedCost > 0, '归因无成本');
  const csv = ModelRoutingService.costAttributionCsv('p-t06311');
  assert(csv.split('\n')[0] === 'project_id,model,tool_id,run_id,decisions,estimated_cost', 'CSV 表头不符');
  return `${rows[0].model}=${rows[0].estimatedCost.toFixed(4)}`;
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const report = [
  `# T06311 模型路由与成本预算验收`,
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 数据目录：${DATA}`,
  `- 结果：**${passed} PASS / ${failed} FAIL**`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} \`${r.name}\`${r.detail ? `：${r.detail}` : ''}`),
].join('\n');
writeFileSync(join(OUT, 'report.txt'), report, 'utf8');
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ passed, failed, results, at: iso }, null, 2), 'utf8');
console.log(report);
process.exit(failed ? 1 : 0);
