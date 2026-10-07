/**
 * T01066 后续（MCP 领取路径池满提示）冒烟脚本。
 *
 * 建独立库，造 N 个 running 任务后断言：
 * - 运行中数 < 上限 → full=false、提示为空串（不打扰）；
 * - 运行中数 ≥ 上限 → full=true、提示含槽位与「软引导」措辞；
 * - 上限写入有边界校验（0/11 被拒）。
 *
 * 运行：npx tsx server/scripts/verify-pool-hint.ts
 */
process.env.MTask_DATA_DIR = process.env.MTask_DATA_DIR ?? require('node:os').tmpdir() + '/mtask-pool-hint-smoke';

import { getDb } from '../src/db/connection';
import { initSchema } from '../src/db/schema';
import { TaskService } from '../src/services/TaskService';
import { readPoolStatus, readPoolLimit, setPoolLimit, poolFullHint } from '../src/services/ConcurrencyPool';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

initSchema();
const db = getDb();
// 清干净，保证断言只看本轮造的数据
db.prepare('DELETE FROM tasks').run();

const proj = db.prepare('SELECT id FROM projects ORDER BY sort_weight, created_at LIMIT 1').get() as { id: string } | undefined;
assert(!!proj, '存在可用项目（schema 种子）');
const pid = proj ? proj.id : '';

console.log('[1] 默认上限 3，无运行中任务时未满');
assert(readPoolLimit() === 3, `默认上限 = 3（实际 ${readPoolLimit()}）`);
let s = readPoolStatus();
assert(s.full === false, 'full=false');
assert(poolFullHint(s) === '', '未满时提示为空串（不制造噪音）');

console.log('[2] 造 2 个 running 任务 → 仍未满（2/3）');
const mk = (title: string) => TaskService.create({ projectId: pid, title }) as { id: string };
const a = mk('池测试任务A');
const b = mk('池测试任务B');
TaskService.setAiState(a.id, 'running');
TaskService.setAiState(b.id, 'running');
s = readPoolStatus();
assert(s.runningCount === 2, `运行中 2（实际 ${s.runningCount}）`);
assert(s.full === false, 'full=false');
assert(poolFullHint(s) === '', '未满时提示为空串');

console.log('[3] 上限调为 2 → 池满，提示出现');
setPoolLimit(2);
s = readPoolStatus();
assert(s.limit === 2, `上限 = 2（实际 ${s.limit}）`);
assert(s.full === true, 'full=true');
const hint = poolFullHint(s);
assert(hint.startsWith('⚠ 并发池已满（2/2'), `提示含槽位 2/2（实际开头：${hint.slice(0, 20)}）`);
assert(hint.includes('软引导'), '提示声明为软引导（不硬拦截）');
assert(hint.includes(a.task_no ?? '') || hint.includes('池测试任务A'), '提示列出运行中任务');

console.log('[4] 上限边界校验');
let threw = false;
try {
  setPoolLimit(0);
} catch {
  threw = true;
}
assert(threw, '上限 0 被拒');
threw = false;
try {
  setPoolLimit(11);
} catch {
  threw = true;
}
assert(threw, '上限 11 被拒');

console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
process.exit(failed === 0 ? 0 : 1);
