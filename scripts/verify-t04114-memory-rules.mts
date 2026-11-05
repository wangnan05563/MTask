// T04159 门脚本：记忆提取规则规范 §10.3 六条可自动化断言（MEM-602 / T04114）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-t04114-memory-rules.mts
//
// 说明：本门全在服务层 + 隔离临时库内完成，不启动 HTTP 实例，因此不需要 `lib/gate-boot.mts`
// 的「隔离实例就绪」判据；断言的是规则引擎行为（never-store / C2 / C3 / 动作 / INVALIDATE / C4）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04114-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../server/src/db/schema');
const { getDb, closeDb } = await import('../server/src/db/connection');
const { runRulesExtraction } = await import('../server/src/services/MemoryRulesService');
const { resolveMemoryScope } = await import('../server/src/util/memoryScope');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const RESULT = '## 根因\n网关漏桶参数误配导致 429\n## 修复\n改为指数退避并抬高阈值\n## 验证\n压测 50 并发无 429';
const count = (taskId: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE source_task_id = ?').get(taskId) as { c: number }).c;

/** 构造一条合法候选（让各断言只测目标维度，避免被其它守卫顺带丢掉） */
const cand = (over: Record<string, unknown> = {}) => ({
  action: 'ADD', title: '网关限流退避', content: '429 时按指数退避重试，阈值 50 并发',
  type: 'project', tags: ['限流'], confidence: 0.9, source_kind: 'auto', ...over,
});

// ① never-store：密钥/密码/令牌命中 → 落库 0
let r = await runRulesExtraction({
  taskId: 't-ns', resultText: RESULT, productKey: 'p-ns',
  askJson: async () => ({
    memories: [
      cand({ title: '密钥', content: 'sk-live-abc123' }),
      cand({ title: '密码', content: 'password=hunter2' }),
      cand({ title: '令牌', content: 'Bearer eyJhbGciOi' }),
    ],
  }),
});
check('never-store 落库 0 条', count('t-ns') === 0, String(count('t-ns')));
check('never-store 逐条记 dropped 原因', r.dropped.length === 3 && r.dropped.every((d) => d.reason.includes('C1 never-store')),
  JSON.stringify(r.dropped.map((d) => d.reason)));

// ② C2：单次 20 条 → 入库 ≤5，其余显式 dropped
r = await runRulesExtraction({
  taskId: 't-c2', resultText: RESULT, productKey: 'p-c2',
  askJson: async () => ({ memories: Array.from({ length: 20 }, (_, i) => cand({ title: `候选${i}`, content: `事实${i}` })) }),
});
check('C2 入库 ≤5 条', r.stored <= 5, String(r.stored));
check('C2 超出部分逐条记 dropped', r.dropped.filter((d) => d.reason.includes('C2')).length === 15,
  String(r.dropped.filter((d) => d.reason.includes('C2')).length));

// ③ C3：confidence=0.5 → 不入库且 dropped 有该条
r = await runRulesExtraction({
  taskId: 't-c3', resultText: RESULT, productKey: 'p-c3',
  askJson: async () => ({ memories: [cand({ confidence: 0.5 })] }),
});
check('C3 低置信度不入库', count('t-c3') === 0);
check('C3 dropped 带阈值原因', r.dropped.some((d) => d.reason.includes('C3 置信度')), JSON.stringify(r.dropped));

// ④ ADD/UPDATE/NOOP：NOOP 行数不变；UPDATE 命中既有 id 且 id 不变
const now = new Date().toISOString();
db.prepare(`INSERT INTO memories (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('mem-upd', 'p-act', null, 'project', '旧标题', '旧内容', 'auto', now, now);
r = await runRulesExtraction({
  taskId: 't-noop', resultText: RESULT, productKey: 'p-act',
  askJson: async () => ({ memories: [cand({ action: 'NOOP' })] }),
});
check('NOOP 不新增行', count('t-noop') === 0 && r.dropped.some((d) => d.reason === 'NOOP'));
r = await runRulesExtraction({
  taskId: 't-upd', resultText: RESULT, productKey: 'p-act',
  askJson: async () => ({ memories: [cand({ action: 'UPDATE', id: 'mem-upd', title: '新标题' })] }),
});
const updated = db.prepare("SELECT id,title FROM memories WHERE id='mem-upd'").get() as { id: string; title: string } | undefined;
check('UPDATE 命中既有行且 id 不变', updated?.id === 'mem-upd' && updated?.title === '新标题', JSON.stringify(updated));

// ⑤ INVALIDATE：旧行软失效仍物理存在，superseded_by 指向新行
db.prepare(`INSERT INTO memories (id,product_key,project_id,type,title,content,source_kind,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run('mem-old', 'p-inv', null, 'project', '旧结论', '不再成立', 'auto', now, now);
r = await runRulesExtraction({
  taskId: 't-inv', resultText: RESULT, productKey: 'p-inv',
  askJson: async () => ({ memories: [cand({ invalidated_ids: ['mem-old'], title: '新结论', content: '以新阈值为准' })] }),
});
const oldRow = db.prepare('SELECT id,invalidated_at,superseded_by FROM memories WHERE id = ?').get('mem-old') as
  { id: string; invalidated_at: string | null; superseded_by: string | null } | undefined;
check('INVALIDATE 旧行仍物理存在', !!oldRow?.id);
check('INVALIDATE 旧行 invalidated_at 非空', !!oldRow?.invalidated_at, String(oldRow?.invalidated_at));
check('INVALIDATE 旧行 superseded_by 指向新行', oldRow?.superseded_by === 'mem-t-inv-0', String(oldRow?.superseded_by));
check('INVALIDATE 新行已入库', count('t-inv') === 1);

// ⑥ C4：无 product_key 的查询必须报错，而不是返回全量
const noScope = resolveMemoryScope({});
check('C4 无作用域报错', noScope.kind === 'error' && noScope.error.includes('C4'));
const emptyScope = resolveMemoryScope({ productKey: '' });
check('空串作用域走空集+hint（与 C4 不同）', emptyScope.kind === 'empty');

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
