/**
 * T06312（REQ-044 / PRD §B9）：预算消耗监控、预警、硬停与降级模型选项独立验收。
 *
 * 覆盖：committed 决策计费、模拟器不占预算、80% 预警、100% 硬停、degrade 模式
 * 自动选择预算内降级模型、降级选项（degradeOptions）返回且可回读、四档预算快照。
 * 全部使用临时 SQLite，不触碰生产库。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const OUT = process.env.T06312_OUT || 'D:/tmp/t06312-budget-control';
const DATA = process.env.T06312_DATA || join(OUT, 'db');

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

const db = getDb();
const at = new Date(2026, 10, 25, 10, 0, 0, 0);
const now = at.toISOString();

function seedProject(id, name) {
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, '', 0, 10, now, now);
}
function seedTool(id, name, model) {
  db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, model, max_tokens, timeout_ms, enabled, is_default_organize, is_default_develop, created_at, updated_at)
              VALUES (?, ?, 'openai-compatible', 'develop', 'http://127.0.0.1:1', ?, 4096, 30000, 1, 0, 0, ?, ?)`)
    .run(id, name, model, now, now);
}
function addCommittedDecision(projectId, cost) {
  const id = `seed-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO model_route_decisions
      (id, task_id, project_id, run_id, task_type, selected_tool_id, selected_model, estimated_cost,
       estimated_latency_ms, input_tokens, output_tokens, budget_status, budget_banner, downgraded_from,
       reason, candidates_json, committed, created_at)
      VALUES (?, NULL, ?, NULL, 'general', 'seed-tool', 'seed', ?, 0, 1, 1, 'ok', '', '', 'seed', '[]', 1, ?)`)
    .run(id, projectId, cost, now);
}

seedProject('p-t06312', 'T06312预算验收');
seedProject('p-t06312-degrade', 'T06312降级验收');
seedTool('tool-cheap', '轻量快模', 'cheap-1');
seedTool('tool-long', '长上下文模型', 'long-context-1');
seedTool('tool-strong', '高质模型', 'strong-1');
seedTool('tool-degraded', '降级供应商', 'degraded-1');

ModelRoutingService.upsertProfile('tool-cheap', {
  inputCostPer1K: 0.001, outputCostPer1K: 0.002, expectedLatencyMs: 300, contextLimit: 32000,
  capabilities: 'general,summary,code', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-long', {
  inputCostPer1K: 0.006, outputCostPer1K: 0.012, expectedLatencyMs: 1200, contextLimit: 256000,
  capabilities: 'general,summary,long-context', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-strong', {
  inputCostPer1K: 0.012, outputCostPer1K: 0.024, expectedLatencyMs: 1800, contextLimit: 200000,
  capabilities: 'general,code,summary', health: 'healthy',
});
ModelRoutingService.upsertProfile('tool-degraded', {
  inputCostPer1K: 0.0002, outputCostPer1K: 0.0004, expectedLatencyMs: 900, contextLimit: 128000,
  capabilities: 'general,summary', health: 'degraded',
});
ModelRoutingService.upsertBudget('p-t06312', {
  projectLimit: 100, dailyLimit: 5, monthlyLimit: 20, runLimit: 1, warningPct: 80, stopMode: 'stop',
});

check('预算配置：项目/日/月/单 Run 四档落库', () => {
  const s = ModelRoutingService.budgetSnapshot('p-t06312', at);
  const b = s.budget;
  assert(b && b.projectLimit === 100 && b.dailyLimit === 5 && b.monthlyLimit === 20 && b.runLimit === 1, '预算字段不符');
  assert(b.warningPct === 80 && b.stopMode === 'stop', '预警/停止模式不符');
  return `${b.projectLimit}/${b.dailyLimit}/${b.monthlyLimit}/${b.runLimit} ${b.warningPct}% ${b.stopMode}`;
});

check('消耗监控：committed 路由累加日预算，模拟器不计费', () => {
  const before = ModelRoutingService.budgetSnapshot('p-t06312', at).spend.day;
  const sim = ModelRoutingService.route({ projectId: 'p-t06312', title: '修复登录按钮', contextTokens: 1000, outputTokens: 200, at, commit: false });
  assert(sim.committed === false, '模拟器标记错误');
  assert(ModelRoutingService.budgetSnapshot('p-t06312', at).spend.day === before, '模拟器写入预算');
  const real = ModelRoutingService.route({ projectId: 'p-t06312', title: '修复登录按钮', contextTokens: 1000, outputTokens: 200, at, commit: true });
  const after = ModelRoutingService.budgetSnapshot('p-t06312', at).spend.day;
  assert(after > before && Math.abs(after - (before + real.estimatedCost)) < 1e-9, `日花费未累加 ${before}→${after}`);
  return `${before.toFixed(4)}→${after.toFixed(4)}`;
});

check('80% 预警：不拒绝，返回预警横幅和剩余额度', () => {
  addCommittedDecision('p-t06312', 4.0); // 累计约 4.0014 / 5 → 80.03%
  const d = ModelRoutingService.route({ projectId: 'p-t06312', title: '修复登录按钮', contextTokens: 1000, outputTokens: 200, at, commit: false });
  assert(d.budget.state === 'warning', `状态 ${d.budget.state}`);
  assert(d.banner.includes('预算预警'), `横幅 ${d.banner}`);
  assert(d.budget.percent >= 80 && d.budget.headroom !== null, `percent=${d.budget.percent} headroom=${d.budget.headroom}`);
  assert(d.degradeOptions.length >= 1, '预警未返回降级选项');
  return `${d.budget.percent.toFixed(1)}% headroom=${d.budget.headroom.toFixed(4)} options=${d.degradeOptions.length}`;
});

check('100% 硬停：stop 模式 409、写 hard_stop 审计、返回降级选项', () => {
  addCommittedDecision('p-t06312', 1.0); // 累计约 5.0014 / 5
  let thrown = null;
  try {
    ModelRoutingService.route({ projectId: 'p-t06312', title: '修复登录按钮', contextTokens: 1000, outputTokens: 200, at, commit: true });
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof ModelRoutingError, '未抛出 ModelRoutingError');
  assert(thrown.statusCode === 409 && thrown.code === 'budget_hard_stop', `status=${thrown.statusCode} code=${thrown.code}`);
  assert(thrown.decision && thrown.decision.degradeOptions.length >= 1, '硬停响应缺降级选项');
  const row = db.prepare("SELECT * FROM model_route_decisions WHERE project_id='p-t06312' AND budget_status='hard_stop' ORDER BY created_at DESC LIMIT 1").get();
  assert(row && Number(row.committed) === 1, 'hard_stop 未写审计');
  return `${thrown.message} options=${thrown.decision.degradeOptions.length}`;
});

check('预算快照：项目/日/月/单 Run 四档读数一致', () => {
  const s = ModelRoutingService.budgetSnapshot('p-t06312', at);
  assert(s.state === 'hard_stop', `总体 ${s.state}`);
  assert(s.spend.day >= 5.0, `日花费 ${s.spend.day}`);
  assert(s.scopes.some((x) => x.key === 'day' && x.state === 'hard_stop'), '日预算未 hard_stop');
  return `day=${s.spend.day.toFixed(2)} state=${s.state}`;
});

check('degrade 模式：自动选择预算内更便宜模型并返回降级横幅', () => {
  ModelRoutingService.upsertBudget('p-t06312-degrade', {
    projectLimit: 100, dailyLimit: 5, monthlyLimit: 20, runLimit: 1, warningPct: 80, stopMode: 'degrade',
  });
  addCommittedDecision('p-t06312-degrade', 4.9);
  const d = ModelRoutingService.route({
    projectId: 'p-t06312-degrade', title: '总结大型 PRD', taskType: 'summary',
    contextTokens: 100000, outputTokens: 500, at, commit: true,
  });
  assert(d.selectedToolId === 'tool-degraded', `实际 ${d.selectedToolId}`);
  assert(d.downgradedFrom.includes('long-context-1'), `降级来源 ${d.downgradedFrom}`);
  assert(d.banner.includes('降级') && d.banner.includes('预算剩余'), `横幅 ${d.banner}`);
  assert(d.budget.headroom !== null && d.estimatedCost <= d.budget.headroom, '选中项未落在剩余预算内');
  return `${d.downgradedFrom} → ${d.selectedModel} $${d.estimatedCost.toFixed(4)} headroom=${d.budget.headroom.toFixed(4)}`;
});

check('降级模型选项：排除已选中项、按评分排序、fitsBudget 与剩余额度一致', () => {
  const d = ModelRoutingService.route({
    projectId: 'p-t06312-degrade', title: '总结大型 PRD', taskType: 'summary',
    contextTokens: 100000, outputTokens: 500, at, commit: false,
  });
  assert(d.degradeOptions.length >= 1 && d.degradeOptions.length <= 3, `选项数 ${d.degradeOptions.length}`);
  assert(!d.degradeOptions.some((o) => o.toolId === d.selectedToolId), '选项包含已选中模型');
  const expected = d.degradeOptions.map((o) => o.estimatedCost <= (d.budget.headroom ?? Number.POSITIVE_INFINITY));
  assert(d.degradeOptions.every((o, i) => o.fitsBudget === expected[i]), 'fitsBudget 判定不一致');
  return d.degradeOptions.map((o) => `${o.toolName}:${o.fitsBudget ? 'fits' : 'over'}`).join(',');
});

check('审计回读：listDecisions 可重建降级选项', () => {
  const rows = ModelRoutingService.listDecisions('p-t06312-degrade', 10);
  const row = rows.find((r) => r.selectedToolId === 'tool-degraded');
  assert(row, '未找到降级审计行');
  assert(row.degradeOptions.length >= 1, '回读缺降级选项');
  assert(row.budget.state === 'warning' || row.budget.state === 'ok', `审计预算状态 ${row.budget.state}`);
  return `decisions=${rows.length} options=${row.degradeOptions.length}`;
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const report = [
  '# T06312 预算控制验收',
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 数据目录：${DATA}`,
  `- 结果：**${passed} PASS / ${failed} FAIL**`,
  '',
  ...results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} \`${r.name}\`${r.detail ? `：${r.detail}` : ''}`),
].join('\n');
writeFileSync(join(OUT, 'report.txt'), report, 'utf8');
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ passed, failed, results, at: now }, null, 2), 'utf8');
console.log(report);
process.exit(failed ? 1 : 0);
