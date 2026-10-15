/**
 * T01058 后续（计划行复杂度批量补算）冒烟脚本。
 *
 * 起一个本地「假 OpenAI」服务：读取请求里的计划行 id，回一个合法的 JSON 数组
 * （含一行故意给出越界值 9，验证钳位丢弃）。断言：
 * - 只补 NULL 行，已有评级的行不被覆盖；
 * - 非法/越界评级不写库；
 * - force=1 时连已有评级一起重算。
 *
 * 运行：npx tsx server/scripts/verify-plan-complexity.ts
 */
process.env.MTask_DATA_DIR = process.env.MTask_DATA_DIR ?? require('node:os').tmpdir() + '/mtask-plan-complexity-smoke';

import http from 'node:http';
import { getDb } from '../src/db/connection';
import { initSchema } from '../src/db/schema';
import { encrypt } from '../src/util/crypto';
import { backfillComplexity, listMissing } from '../src/services/PlanComplexity';

const MOCK_PORT = 18991;

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

/** 假 OpenAI：从 user 消息里抠 id=xxx，按序给 2/4/9/3… 的评级（含越界值 9 与小数 3.4） */
function startMock(): http.Server {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const user = String(body?.messages?.findLast?.((m: { role: string }) => m.role === 'user')?.content ?? '');
      const ids = [...user.matchAll(/id=([0-9a-f-]{8,})/g)].map((m) => m[1]);
      const scores = [2, 4, 9, 3.4, 5];
      const arr = ids.map((id, i) => ({ id, complexity: scores[i % scores.length] }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }));
    });
  });
  srv.listen(MOCK_PORT);
  return srv;
}

async function main(): Promise<void> {
  const srv = startMock();
  initSchema();
  const db = getDb();
  db.prepare('DELETE FROM plan_tasks').run();
  db.prepare('DELETE FROM ai_tools').run();

  const proj = db.prepare('SELECT id FROM projects ORDER BY sort_weight, created_at LIMIT 1').get() as { id: string };
  const toolId = 'tool-mock-cx';
  db.prepare(
    `INSERT INTO ai_tools (id, name, type, purpose, endpoint, api_key_enc, model, temperature, max_tokens, timeout_ms, enabled, created_at, updated_at)
     VALUES (?, ?, 'openai-compatible', 'develop', ?, ?, 'mock', 0.2, 4096, 20000, 1, ?, ?)`,
  ).run(toolId, '冒烟模型', `http://127.0.0.1:${MOCK_PORT}`, encrypt('sk-mock'), new Date().toISOString(), new Date().toISOString());

  const ins = db.prepare(
    `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days, progress, status, assignee, sort_order, complexity, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-10-01', '2026-10-05', 3, 0, 'todo', '', 0, ?, ?, ?)`,
  );
  const t = new Date().toISOString();
  ins.run('aaaaaaaa-0000-0000-0000-000000000001', proj.id, '任务甲', '', null, t, t);
  ins.run('aaaaaaaa-0000-0000-0000-000000000002', proj.id, '任务乙', '', null, t, t);
  ins.run('aaaaaaaa-0000-0000-0000-000000000003', proj.id, '任务丙', '', null, t, t);
  // 已有评级：默认不应被覆盖
  ins.run('aaaaaaaa-0000-0000-0000-000000000004', proj.id, '任务丁', '', 1, t, t);

  console.log('[1] 目标行识别');
  assert(listMissing(proj.id).length === 3, `仅 3 行缺复杂度（实际 ${listMissing(proj.id).length}）`);
  assert(listMissing(proj.id, { force: true }).length === 4, 'force=1 时 4 行全部纳入');

  console.log('[2] 批量补算（默认只补 NULL）');
  const r = await backfillComplexity(toolId, proj.id);
  assert(r.scanned === 3, `scanned=3（实际 ${r.scanned}）`);
  assert(r.updated === 2, `只写入 2 行——越界值 9 被丢弃（实际 ${r.updated}）`);
  const c1 = db.prepare('SELECT complexity FROM plan_tasks WHERE id = ?').get('aaaaaaaa-0000-0000-0000-000000000001') as { complexity: number | null };
  const c2 = db.prepare('SELECT complexity FROM plan_tasks WHERE id = ?').get('aaaaaaaa-0000-0000-0000-000000000002') as { complexity: number | null };
  const c3 = db.prepare('SELECT complexity FROM plan_tasks WHERE id = ?').get('aaaaaaaa-0000-0000-0000-000000000003') as { complexity: number | null };
  const c4 = db.prepare('SELECT complexity FROM plan_tasks WHERE id = ?').get('aaaaaaaa-0000-0000-0000-000000000004') as { complexity: number | null };
  assert(c1.complexity === 2, `行1 = 2（实际 ${c1.complexity}）`);
  assert(c2.complexity === 4, `行2 = 4（实际 ${c2.complexity}）`);
  assert(c3.complexity === null, `行3 评级 9 越界 → 保持 NULL（实际 ${c3.complexity}）`);
  assert(c4.complexity === 1, `已有评级未被覆盖（实际 ${c4.complexity}）`);

  console.log('[3] 小数评级四舍五入（force 重算验证）');
  const r2 = await backfillComplexity(toolId, proj.id, { force: true, ids: ['aaaaaaaa-0000-0000-0000-000000000004'] });
  assert(r2.scanned === 1 && r2.updated === 1, `指定行重算成功（scanned=${r2.scanned} updated=${r2.updated}）`);
  const c4b = db.prepare('SELECT complexity FROM plan_tasks WHERE id = ?').get('aaaaaaaa-0000-0000-0000-000000000004') as { complexity: number | null };
  assert(c4b.complexity === 2, `重算后 = 2（实际 ${c4b.complexity}）`);

  console.log('[4] 参数校验');
  let threw = false;
  try {
    await backfillComplexity('', proj.id);
  } catch {
    threw = true;
  }
  assert(threw, 'toolId 缺失被拒');
  threw = false;
  try {
    await backfillComplexity(toolId, '');
  } catch {
    threw = true;
  }
  assert(threw, 'projectId 缺失被拒');

  srv.close();
  console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
  process.exit(failed === 0 ? 0 : 1);
}

void main(); /* NOSONAR: 脚本按 CommonJS 运行（server/tsconfig.json "module": "CommonJS"、无 package.json "type": "module"，且依赖 require/__dirname），顶层 await 不可用；MTask_DATA_DIR 须前置设置再进模块加载，改 ESM 会让冒烟门读到真实数据目录 */
