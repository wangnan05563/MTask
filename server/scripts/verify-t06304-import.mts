/**
 * T06304（REQ-010 / PRD §B2）导入器契约测试。
 *
 * 覆盖：CSV 字段映射与自动识别、外部 ID 去重（改名仍判重）、JSON/Trello 导入、
 * 确认导入幂等跳过、批量中途异常整体回滚。
 *
 * 运行：先起隔离服务（MTask_DATA_DIR 指向临时目录），再
 *   node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06304-import.mts
 * 环境：MTASK_BASE_URL 默认 http://127.0.0.1:5202
 */
const BASE = process.env.MTASK_BASE_URL || 'http://127.0.0.1:5202';

let checks = 0;
function ok(cond: unknown, label: string, detail?: unknown): void {
  checks += 1;
  if (!cond) {
    console.error(`[FAIL] ${label}`, detail ?? '');
    process.exit(1);
  }
  console.log(`[PASS] ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${BASE}${path}`, init);
  return r;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await req(path, init);
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

const health = await json<{ ok: boolean }>('/api/health');
ok(health.ok === true, '测试服务就绪', health);

const project = await json<{ id: string; name: string }>('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `T06304 导入契约 ${Date.now()}` }),
});
ok(Boolean(project.id), '测试项目创建', { projectId: project.id });

const csv = [
  'Summary,Description,Priority,Status,Issue key',
  'T06304 CSV 甲,第一条,High,To Do,JIRA-101',
  'T06304 CSV 乙,第二条,Low,Done,JIRA-102',
].join('\n');

const preview1 = await json<{ source: string; mapping: Record<string, string>; items: Array<{ title: string; externalId?: string }>; errors: unknown[] }>(
  `/api/tasks/import-csv/preview?projectId=${encodeURIComponent(project.id)}`,
  { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv },
);
ok(preview1.source === 'jira', 'CSV 自动识别 Jira', preview1.source);
ok(preview1.mapping.externalId === 'Issue key', 'Issue key 自动映射为外部 ID', preview1.mapping.externalId);
ok(preview1.items.length === 2 && preview1.errors.length === 0, 'CSV 预览 2 条通过', { items: preview1.items.length, errors: preview1.errors.length });
ok(preview1.items[0]?.externalId === 'JIRA-101', '预览携带外部 ID', preview1.items[0]?.externalId);

const confirm1 = await json<{ count: number; skipped: number }>('/api/tasks/import-csv/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, source: 'jira', items: preview1.items }),
});
ok(confirm1.count === 2 && confirm1.skipped === 0, '首次确认导入 2 条', confirm1);

const preview2 = await json<{ items: unknown[]; errors: Array<{ message: string }> }>(
  `/api/tasks/import-csv/preview?projectId=${encodeURIComponent(project.id)}`,
  { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv },
);
ok(preview2.items.length === 0 && preview2.errors.length === 2, '同来源+外部 ID 预览判重', { items: preview2.items.length, errors: preview2.errors.length });
ok(preview2.errors.every((e) => e.message.includes('jira:JIRA-10')), '错误信息带来源+外部 ID', preview2.errors.map((e) => e.message));

// 改名但保留同一外部 ID：仍应判重，证明不是仅靠标题去重
const renamed = csv.replace('T06304 CSV 甲', 'T06304 CSV 甲（改名）').replace('T06304 CSV 乙', 'T06304 CSV 乙（改名）');
const preview3 = await json<{ items: unknown[]; errors: Array<{ message: string }> }>(
  `/api/tasks/import-csv/preview?projectId=${encodeURIComponent(project.id)}`,
  { method: 'POST', headers: { 'content-type': 'text/csv' }, body: renamed },
);
ok(preview3.items.length === 0 && preview3.errors.length === 2, '外部 ID 改名后仍判重', preview3.errors.map((e) => e.message));

const confirm2 = await json<{ count: number; skipped: number }>('/api/tasks/import-csv/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, source: 'jira', items: preview1.items }),
});
ok(confirm2.count === 0 && confirm2.skipped === 2, '重复确认全部跳过', confirm2);

// 事务回滚：第二条 title 非字符串触发 TypeError，第一条不得落库
const before = await json<Array<unknown>>(`/api/tasks?projectId=${encodeURIComponent(project.id)}&status=todo&limit=200`);
const badItems = [{ title: 'T06304 回滚甲', priority: 'normal' }, { title: 123, priority: 'normal' }];
let rollbackError = '';
try {
  await json('/api/tasks/import-csv/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, source: 'jira', items: badItems }),
  });
} catch (e) {
  rollbackError = e instanceof Error ? e.message : String(e);
}
ok(rollbackError.includes('400'), '异常条目返回 400', rollbackError.slice(0, 120));
const after = await json<Array<unknown>>(`/api/tasks?projectId=${encodeURIComponent(project.id)}&status=todo&limit=200`);
ok(after.length === before.length, '批量失败整体回滚，未落半批', { before: before.length, after: after.length });

// JSON / Trello：id 作为外部 ID，重复卡片跳过
const trello = JSON.stringify({ lists: [{ cards: [{ id: 'card-t06304-1', name: 'T06304 Trello 卡片', desc: '来自 Trello' }] }] });
const jpreview = await json<{ source: string; items: Array<{ externalId?: string }>; errors: unknown[] }>(
  `/api/tasks/import-json/preview?projectId=${encodeURIComponent(project.id)}`,
  { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: trello },
);
ok(jpreview.source === 'trello', 'JSON 识别 Trello', jpreview.source);
ok(jpreview.items.length === 1 && jpreview.items[0]?.externalId === 'card-t06304-1', 'Trello 卡片携带 id', jpreview.items[0]);
const jconfirm = await json<{ count: number; skipped: number }>('/api/tasks/import-json/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, source: 'trello', items: jpreview.items }),
});
ok(jconfirm.count === 1 && jconfirm.skipped === 0, 'Trello 首次导入 1 条', jconfirm);
const jpreview2 = await json<{ items: unknown[]; errors: Array<{ message: string }> }>(
  `/api/tasks/import-json/preview?projectId=${encodeURIComponent(project.id)}`,
  { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: trello },
);
ok(jpreview2.items.length === 0 && jpreview2.errors.length === 1 && jpreview2.errors[0].message.includes('trello:card-t06304-1'), 'Trello 重复卡片判重', jpreview2.errors);

console.log(JSON.stringify({ pass: true, checks, projectId: project.id, projectName: project.name }));
