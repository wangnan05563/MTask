/**
 * T01073 后续冒烟脚本：①循环任务 cron 表达式 ②API Token scope 列。
 *
 * 运行：npx tsx server/scripts/verify-cron-and-scope.ts
 */
process.env.MTask_DATA_DIR = process.env.MTask_DATA_DIR ?? require('node:os').tmpdir() + '/mtask-cron-scope-smoke';

import { getDb } from '../src/db/connection';
import { initSchema } from '../src/db/schema';
import { parseCron, nextCronRun, validateCron, nextCronRunText } from '../src/util/cron';
import { TokenService, RecurringService, normalizeScope } from '../src/services/RecurringService';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
/** 本地时间的可读串，便于断言（cron 按本地时区解释） */
const local = (d: Date | null): string => {
  if (!d) return 'null';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

console.log('[1] cron 每天 9:00');
// 2026-10-07 是周三
assert(local(nextCronRun('0 9 * * *', new Date(2026, 9, 7, 8, 0))) === '2026-10-07 09:00', `8:00 → 当天 9:00（实际 ${local(nextCronRun('0 9 * * *', new Date(2026, 9, 7, 8, 0)))}）`);
assert(local(nextCronRun('0 9 * * *', new Date(2026, 9, 7, 10, 0))) === '2026-10-08 09:00', `10:00 → 次日 9:00（实际 ${local(nextCronRun('0 9 * * *', new Date(2026, 9, 7, 10, 0)))}）`);
assert(local(nextCronRun('0 9 * * *', new Date(2026, 9, 7, 9, 0))) === '2026-10-08 09:00', '恰好 9:00 → 顺延到次日（不含当前分钟）');

console.log('[2] cron 每周一 9:30（周三起算 → 下周一）');
const mon = nextCronRun('30 9 * * 1', new Date(2026, 9, 7, 12, 0));
assert(local(mon) === '2026-10-12 09:30', `周三 12:00 → 2026-10-12 09:30（实际 ${local(mon)}）`);
assert(mon?.getDay() === 1, '落在周一');

console.log('[3] 步长：每 15 分钟');
assert(local(nextCronRun('*/15 * * * *', new Date(2026, 9, 7, 8, 3))) === '2026-10-07 08:15', `8:03 → 8:15（实际 ${local(nextCronRun('*/15 * * * *', new Date(2026, 9, 7, 8, 3)))}）`);

console.log('[4] 稀疏表达式：2 月 29 日（跨闰年）');
const leap = nextCronRun('0 0 29 2 *', new Date(2027, 0, 1));
assert(leap !== null && leap.getMonth() === 1 && leap.getDate() === 29, `2027 年起算 → ${local(leap)}`);
assert(local(nextCronRun('0 0 30 2 *', new Date(2026, 0, 1))) === 'null', '2 月 30 日无解 → null（不会卡在到期态）');

console.log('[5] dom 与 dow 的 OR 语义：每月 1 号或每个周一');
const or = nextCronRun('0 0 1 * 1', new Date(2026, 9, 7, 12, 0));
assert(local(or) === '2026-10-12 00:00', `周三起算 → 最近的周一 10-12（实际 ${local(or)}）`);

console.log('[6] 非法表达式必须被拒（否则会写库并在 tick 里空转）');
assert(validateCron('0 9 * *') !== null, '段数不足被拒');
assert(validateCron('99 9 * * *') !== null, '分钟越界被拒');
assert(validateCron('0 9 * * 9') !== null, '星期越界被拒');
assert(validateCron('') !== null, '空串被拒');
assert(validateCron('0 9 * * *') === null, '合法表达式通过');

console.log('[7] 存储格式与既有 next_run_at 一致（UTC 截断串）');
assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(nextCronRunText('0 9 * * *')), `格式 YYYY-MM-DD HH:MM:SS（实际 ${nextCronRunText('0 9 * * *')}）`);

console.log('[8] 循环规则：cron 建单与改表达式');
initSchema();
const db = getDb();
db.prepare('DELETE FROM recurring_rules').run();
const proj = db.prepare('SELECT id FROM projects ORDER BY sort_weight, created_at LIMIT 1').get() as { id: string };
const rule = RecurringService.create({ projectId: proj.id, title: 'cron 冒烟规则', freq: 'weekly', cron: '0 9 * * 1' });
assert(String(rule.freq) === 'cron', `freq 记为 cron（实际 ${rule.freq}）`);
assert(String(rule.cron_expr) === '0 9 * * 1', 'cron_expr 已落库');
let rejected = false;
try {
  RecurringService.create({ projectId: proj.id, title: '非法 cron', freq: 'weekly', cron: '99 9 * * *' });
} catch {
  rejected = true;
}
assert(rejected, '非法 cron 建单被拒');
let threw = false;
try {
  RecurringService.setCron(String(rule.id), '0 25 * * *');
} catch {
  threw = true;
}
assert(threw, '改非法表达式被拒（不写库）');
const cleared = RecurringService.setCron(String(rule.id), '');
assert(String(cleared?.cron_expr) === '' && String(cleared?.freq) === 'weekly', '清空 cron 后 freq 退回 weekly');

console.log('[9] API Token scope');
db.prepare('DELETE FROM api_tokens').run();
const w = TokenService.create('写凭据');
assert(w.scope === 'write', `默认 scope=write（实际 ${w.scope}）`);
const r = TokenService.create('读凭据', 'read');
assert(r.scope === 'read', `显式 scope=read（实际 ${r.scope}）`);
assert(TokenService.verify(r.token) === 'read', 'verify 返回 read');
assert(TokenService.verify(w.token) === 'write', 'verify 返回 write');
assert(TokenService.verify('sk-not-exist') === null, '未知 token → null');
TokenService.setScope(r.id, 'write');
assert(TokenService.verify(r.token) === 'write', 'setScope 改 read→write 生效');
assert(normalizeScope(undefined) === 'write', '老库无 scope 列的值按 write 处理（向后兼容）');
assert(normalizeScope('READ') === 'write', '非法 scope 归一为 write');

console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
process.exit(failed === 0 ? 0 : 1);
