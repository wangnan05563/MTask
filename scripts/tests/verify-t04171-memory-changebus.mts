// T04171 门脚本：记忆写操作必须发 'memories' SSE 变更（PRD v1.2·F11 / MEM-502）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04171-memory-changebus.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'mtask-t04171-gate-'));
process.env.MTask_DATA_DIR = DIR;
const { initSchema } = await import('../../server/src/db/schema');
const { getDb, closeDb } = await import('../../server/src/db/connection');
const { changeBus } = await import('../../server/src/services/ChangeBus');
const { saveMemory, updateMemory, deleteMemory, queryMemories } = await import('../../server/src/services/MemoryService');
const { enforceCapacity } = await import('../../server/src/services/MemoryMaintenanceService');
const { guardMemoryCandidate, resolvePendingMemory } = await import('../../server/src/util/memoryGuard');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

initSchema();
const db = getDb();
const events: string[] = [];
changeBus.on('change', (kind: string) => events.push(kind));
const take = () => events.splice(0, events.length);
const scope = { kind: 'ok' as const, productKey: 'wiki' };

// 写操作逐一发事件
const saved = saveMemory({ scope, type: 'project', title: 'T04171-保存', content: '写后推送' });
check('保存成功', saved.kind === 'stored', saved.kind);
check('保存发 memories 事件', take().includes('memories'));

updateMemory((saved as { id: string }).id, scope, { title: 'T04171-更新' });
check('更新发 memories 事件', take().includes('memories'));

deleteMemory((saved as { id: string }).id, scope);
check('删除发 memories 事件', take().includes('memories'));

// 待确认队列：入队 + 确认
const q = guardMemoryCandidate({
  id: 'q-1', productKey: 'wiki', projectId: null, title: '联系方式', content: '电话 13800138000', type: 'project',
});
check('敏感候选入队', q.action === 'queue');
const before = take();
check('入队本身不发记忆事件（队列非记忆）', !before.includes('memories'), before.join(','))
resolvePendingMemory('q-1', 'confirm');
check('确认入库发 memories 事件', take().includes('memories'));

// 容量淘汰：有实际失效时发事件；未超限查询不发（先清空，保证总量恰好 205）
db.prepare('DELETE FROM memories').run();
take();
for (let i = 0; i < 205; i++) {
  saveMemory({ scope, type: 'project', title: `容量-${i}`, content: `内容-${i}` });
}
take();
const removed = enforceCapacity('wiki');
check('超限淘汰 5 条', removed === 5, String(removed));
check('淘汰发 memories 事件', take().includes('memories'));

take();
queryMemories(scope, { limit: 5 });
check('只读查询不发 memories 事件', take().length === 0);

try { closeDb(); rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻塞结论 */ }
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
