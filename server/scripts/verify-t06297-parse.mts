/**
 * T06297 自然语言解析门禁：固定 2026-11-24（周二）跑 A5 常见格式。
 * 用法：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06297-parse.mts
 */
import { parseQuickCapture, type QuickCaptureCategory, type QuickCaptureProject } from '../../web/src/ui/quickCaptureParse.ts';

const now = new Date(2026, 10, 24, 12, 0, 0, 0); // 2026-11-24 周二（本地中午）
const projects: QuickCaptureProject[] = [
  { id: 'p-mtask', name: 'MTask十期' },
  { id: 'p-inbox', name: '收件箱' },
];
const categories: QuickCaptureCategory[] = [
  { id: 'c-bug', name: '缺陷修复' },
  { id: 'c-feature', name: '功能优化' },
  { id: 'c-doc', name: '文档编写' },
  { id: 'c-test', name: '功能测试' },
];

interface Case {
  name: string;
  raw: string;
  title: string;
  priority?: string;
  projectId?: string;
  categoryId?: string;
  dueDate?: string;
  tokenCount?: number;
  unresolved?: number;
}

const cases: Case[] = [
  {
    name: '组合语法（A5 主路径）',
    raw: '修复登录 #MTask十期 !紧急 /缺陷修复 @明天',
    title: '修复登录', priority: 'urgent', projectId: 'p-mtask', categoryId: 'c-bug', dueDate: '2026-11-25', tokenCount: 4,
  },
  {
    name: '英文优先级 + 收件箱 + bug + 周五',
    raw: '补一个空态 !P0 #收件箱 /bug @周五',
    title: '补一个空态', priority: 'urgent', projectId: 'p-inbox', categoryId: 'c-bug', dueDate: '2026-11-27', tokenCount: 4,
  },
  { name: '无标记保持原样', raw: '只是记一个想法', title: '只是记一个想法', tokenCount: 0 },
  { name: '今天', raw: '今天做完 @今天', title: '今天做完', dueDate: '2026-11-24', tokenCount: 1 },
  { name: '明天', raw: '明天看 @明天', title: '明天看', dueDate: '2026-11-25', tokenCount: 1 },
  { name: '后天', raw: '后天复盘 @后天', title: '后天复盘', dueDate: '2026-11-26', tokenCount: 1 },
  { name: '大后天', raw: '大后天发版 @大后天', title: '大后天发版', dueDate: '2026-11-27', tokenCount: 1 },
  { name: '3 天后', raw: '三天后提醒 @3天后', title: '三天后提醒', dueDate: '2026-11-27', tokenCount: 1 },
  { name: '2 周后', raw: '两周后回访 @2周后', title: '两周后回访', dueDate: '2026-12-08', tokenCount: 1 },
  { name: '周五（下一次）', raw: '周五上线 @周五', title: '周五上线', dueDate: '2026-11-27', tokenCount: 1 },
  { name: '本周五', raw: '本周五上线 @本周五', title: '本周五上线', dueDate: '2026-11-27', tokenCount: 1 },
  { name: '下周一', raw: '下周一对齐 @下周一', title: '下周一对齐', dueDate: '2026-11-30', tokenCount: 1 },
  { name: '下周五（跨周）', raw: '下周五评审 @下周五', title: '下周五评审', dueDate: '2026-12-04', tokenCount: 1 },
  { name: '下下周三', raw: '下下周三归档 @下下周三', title: '下下周三归档', dueDate: '2026-12-09', tokenCount: 1 },
  { name: 'ISO 日期', raw: '跨年发布 @2026-12-31', title: '跨年发布', dueDate: '2026-12-31', tokenCount: 1 },
  { name: '中文月日', raw: '十二月一日 @12月1日', title: '十二月一日', dueDate: '2026-12-01', tokenCount: 1 },
  { name: '短月日', raw: '月底 @11/30', title: '月底', dueDate: '2026-11-30', tokenCount: 1 },
  { name: '未识别项目保留原文', raw: '看下 #不存在的项目', title: '看下 #不存在的项目', tokenCount: 0, unresolved: 1 },
  { name: '未识别类型保留原文', raw: '看下 /不存在', title: '看下 /不存在', tokenCount: 0, unresolved: 1 },
  {
    name: '同字段重复标记后者生效',
    raw: '排期 #收件箱 #MTask十期 !低 !紧急',
    title: '排期', priority: 'urgent', projectId: 'p-mtask', tokenCount: 4,
  },
  {
    name: '全角标记',
    raw: '全角测试 ！高 ＃MTask十期 ／bug ＠明天',
    title: '全角测试', priority: 'high', projectId: 'p-mtask', categoryId: 'c-bug', dueDate: '2026-11-25', tokenCount: 4,
  },
  {
    name: '中文后紧贴项目与优先级',
    raw: '修一下#MTask十期!紧急',
    title: '修一下', priority: 'urgent', projectId: 'p-mtask', tokenCount: 2,
  },
  {
    name: '中文后紧贴类型与日期',
    raw: '补空态/缺陷修复@明天',
    title: '补空态', categoryId: 'c-bug', dueDate: '2026-11-25', tokenCount: 2,
  },
];

let pass = 0;
const fails: Array<{ name: string; why: string }> = [];
for (const c of cases) {
  const r = parseQuickCapture(c.raw, { projects, categories, now });
  const reasons: string[] = [];
  if (r.title !== c.title) reasons.push(`title=${JSON.stringify(r.title)} 期望 ${JSON.stringify(c.title)}`);
  if (c.priority && r.priority !== c.priority) reasons.push(`priority=${r.priority} 期望 ${c.priority}`);
  if (c.projectId && r.projectId !== c.projectId) reasons.push(`project=${r.projectId} 期望 ${c.projectId}`);
  if (c.categoryId && r.categoryId !== c.categoryId) reasons.push(`category=${r.categoryId} 期望 ${c.categoryId}`);
  if (c.dueDate && r.dueDate !== c.dueDate) reasons.push(`due=${r.dueDate} 期望 ${c.dueDate}`);
  if (c.tokenCount !== undefined && r.tokens.length !== c.tokenCount) reasons.push(`tokens=${r.tokens.length} 期望 ${c.tokenCount}`);
  if (c.unresolved !== undefined && r.unresolved.length !== c.unresolved) reasons.push(`unresolved=${r.unresolved.length} 期望 ${c.unresolved}`);
  if (reasons.length === 0) pass += 1;
  else fails.push({ name: c.name, why: reasons.join('; ') });
  console.log(`[${reasons.length === 0 ? 'PASS' : 'FAIL'}] ${c.name}${reasons.length ? ` → ${reasons.join('; ')}` : ''}`);
}

const rate = pass / cases.length;
console.log(`\n[t06297-parse] pass=${pass}/${cases.length} rate=${(rate * 100).toFixed(1)}%`);
if (fails.length) {
  console.error(JSON.stringify(fails, null, 2));
  process.exit(1);
}
if (rate < 0.9) {
  console.error('解析成功率低于 A5 要求的 90%');
  process.exit(1);
}
