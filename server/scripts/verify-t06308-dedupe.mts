/**
 * T06308（REQ-071 / AC-36）导入去重机制契约测试。
 *
 * 覆盖：同一批次重复键、改名不绕过、来源命名空间隔离、空白归一、无键标题兜底、
 * 并发确认只落一条、失败回滚不留下死键、CSV 与 JSON 两条确认通道。
 *
 * 运行：起隔离服务后
 *   MTASK_BASE_URL=http://127.0.0.1:5203 node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06308-dedupe.mts
 */
const BASE = process.env.MTASK_BASE_URL || 'http://127.0.0.1:5203';
const RUN = `T06308-${Date.now()}`;

let checks = 0;
function ok(cond: unknown, label: string, detail?: unknown): void {
  checks += 1;
  if (!cond) {
    console.error(`[FAIL] ${label}`, detail ?? '');
    process.exit(1);
  }
  console.log(`[PASS] ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function tasks(projectId: string): Promise<Array<{ id: string; title: string }>> {
  return json<Array<{ id: string; title: string }>>(`/api/tasks?projectId=${encodeURIComponent(projectId)}&status=todo&limit=200`);
}

async function confirmCsv(projectId: string, items: unknown[]): Promise<{ count: number; skipped: number }> {
  return json('/api/tasks/import-csv/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, source: 'jira', items }),
  });
}

const health = await json<{ ok: boolean }>('/api/health');
ok(health.ok === true, '测试服务就绪', health);

const project = await json<{ id: string; name: string }>('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `T06308 去重契约 ${RUN}` }),
});
ok(Boolean(project.id), '测试项目创建', { projectId: project.id });

// 1) 同一批次两条同键：只允许一条落库
const sameBatch = await confirmCsv(project.id, [
  { title: `${RUN} 同批甲`, externalId: `${RUN}-K1`, priority: 'normal' },
  { title: `${RUN} 同批乙`, externalId: `${RUN}-K1`, priority: 'normal' },
]);
ok(sameBatch.count === 1 && sameBatch.skipped === 1, '同批次重复键只导入 1 条', sameBatch);
ok((await tasks(project.id)).filter((t) => t.title.startsWith(`${RUN} 同批`)).length === 1, '同批次重复键未产生第二条任务');

// 2) 改名但同键：仍判重，证明键优先于标题
const renamed = await confirmCsv(project.id, [{ title: `${RUN} 同批甲（改名）`, externalId: `${RUN}-K1`, priority: 'normal' }]);
ok(renamed.count === 0 && renamed.skipped === 1, '同键改名仍被跳过', renamed);

// 3) 不同来源复用同一外部 ID：命名空间隔离，允许各导入一条
const otherSource = await json<{ count: number; skipped: number }>('/api/tasks/import-csv/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, source: 'github', items: [{ title: `${RUN} GitHub 同键`, externalId: `${RUN}-K1` }] }),
});
ok(otherSource.count === 1 && otherSource.skipped === 0, '不同来源同外部 ID 各自独立', otherSource);

// 4) 外部 ID 首尾空白归一
const ws1 = await confirmCsv(project.id, [{ title: `${RUN} 空白甲`, externalId: `  ${RUN}-K3  ` }]);
const ws2 = await confirmCsv(project.id, [{ title: `${RUN} 空白乙`, externalId: `${RUN}-K3` }]);
ok(ws1.count === 1 && ws1.skipped === 0, '外部 ID 空白首次导入', ws1);
ok(ws2.count === 0 && ws2.skipped === 1, '外部 ID 空白归一后判重', ws2);

// 5) 无外部 ID 时回退标题去重
const noKey1 = await confirmCsv(project.id, [{ title: `${RUN} 无键同名`, priority: 'normal' }]);
const noKey2 = await confirmCsv(project.id, [{ title: `${RUN} 无键同名`, priority: 'normal' }]);
ok(noKey1.count === 1 && noKey2.count === 0 && noKey2.skipped === 1, '无外部 ID 回退标题去重', { noKey1, noKey2 });

// 6) 并发确认同键：两个请求合计只落一条
const raceItems = [{ title: `${RUN} 并发键`, externalId: `${RUN}-RACE-1`, priority: 'normal' }];
const [raceA, raceB] = await Promise.all([confirmCsv(project.id, raceItems), confirmCsv(project.id, raceItems)]);
ok(raceA.count + raceB.count === 1 && raceA.skipped + raceB.skipped === 1, '并发同键合计只导入 1 条', { raceA, raceB });
ok((await tasks(project.id)).filter((t) => t.title === `${RUN} 并发键`).length === 1, '并发同键只产生 1 条任务');

// 7) 批次中途失败：claim 随事务回滚，不留下死键；修复后同键可导入
const beforeRollback = (await tasks(project.id)).length;
let rollbackStatus = '';
try {
  await confirmCsv(project.id, [
    { title: `${RUN} 回滚键`, externalId: `${RUN}-RB-1` },
    { title: 123, externalId: `${RUN}-RB-2` },
  ]);
} catch (e) {
  rollbackStatus = e instanceof Error ? e.message : String(e);
}
ok(rollbackStatus.includes('400'), '失败批次返回 400', rollbackStatus.slice(0, 100));
ok((await tasks(project.id)).length === beforeRollback, '失败批次未落半条任务', { before: beforeRollback, after: (await tasks(project.id)).length });
const retryRollback = await confirmCsv(project.id, [{ title: `${RUN} 回滚键（重试）`, externalId: `${RUN}-RB-1` }]);
ok(retryRollback.count === 1 && retryRollback.skipped === 0, '回滚后同键可重新导入（无死键）', retryRollback);

// 8) JSON 确认通道同样先占键
const j1 = await json<{ count: number; skipped: number }>('/api/tasks/import-json/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, source: 'trello', items: [
    { title: `${RUN} JSON 甲`, externalId: `${RUN}-J1` },
    { title: `${RUN} JSON 乙`, externalId: `${RUN}-J1` },
  ] }),
});
ok(j1.count === 1 && j1.skipped === 1, 'JSON 同批次重复键只导入 1 条', j1);

console.log(JSON.stringify({ pass: true, checks, projectId: project.id, projectName: project.name, run: RUN }));
