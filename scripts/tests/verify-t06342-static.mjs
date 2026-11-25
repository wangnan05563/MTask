/**
 * T06342 静态门禁：核心页去掉重复的面包屑与可见大标题，只保留操作槽与隐藏 h1。
 * 用法：node scripts/tests/verify-t06342-static.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    failures.push(`缺少文件：${rel}`);
    return '';
  }
  return fs.readFileSync(abs, 'utf8');
}

const pages = [
  ['首页', 'web/src/pages/DashboardPage.tsx'],
  ['收件箱', 'web/src/pages/InboxPage.tsx'],
  ['任务', 'web/src/pages/TasksPage.tsx'],
  ['提示词', 'web/src/pages/PromptsPage.tsx'],
  ['AI 工具与模型', 'web/src/pages/AIToolsPage.tsx'],
  ['通用需求', 'web/src/pages/ReqPage.tsx'],
  ['项目计划', 'web/src/pages/PlanPage.tsx'],
  ['投递队列', 'web/src/pages/QueuePage.tsx'],
  ['执行会话', 'web/src/pages/ExecSessionsPage.tsx'],
  ['设置', 'web/src/pages/SettingsPage.tsx'],
];

const sources = pages.map(([label, file]) => [label, read(file)]);

for (const [label, text] of sources) {
  if (!/<PageHeader/g.test(text)) failures.push(`${label} 缺少 PageHeader`);
  if (!/^\s*minimal\s*$/m.test(text)) failures.push(`${label} 未启用 PageHeader minimal，仍会渲染重复页头`);
  if (/breadcrumbs=/.test(text)) failures.push(`${label} 仍向 PageHeader 传面包屑`);
  if (text.split('\n').some((line) => /^\s*<h1[\s>]/.test(line))) failures.push(`${label} 仍有手写 h1`);
}

const shell = read('web/src/ui/layout/PageShell.tsx');
const css = read('web/src/ui/layout/pageShell.css');

if (!/readonly minimal\?: boolean/.test(shell)) failures.push('PageHeader 缺少 minimal 属性类型');
if (!/if \(minimal\)/.test(shell)) failures.push('PageHeader 未实现 minimal 分支');
if (!/mt-page-title-visually-hidden/.test(shell)) failures.push('minimal 分支缺少读屏可见的隐藏 h1');
if (!/<nav className="mt-page-breadcrumbs" aria-label="面包屑">/.test(shell)) failures.push('完整页头的面包屑语义被误删');
if (!/\.mt-page-header--minimal\s*\{/.test(css)) failures.push('缺少 minimal 页头样式');
if (!/padding:\s*8px 0 0/.test(css)) failures.push('minimal 页头顶部内边距不符合 8px 呼吸位');
if (!/border-bottom:\s*none/.test(css)) failures.push('minimal 页头仍保留分隔线');
if (!/\.mt-page-title-visually-hidden\s*\{/.test(css)) failures.push('缺少隐藏标题样式');

const result = {
  corePages: pages.length,
  minimalPages: sources.filter(([, text]) => /^\s*minimal\s*$/m.test(text)).length,
  breadcrumbCallers: sources.filter(([, text]) => /breadcrumbs=/.test(text)).map(([label]) => label),
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06342 核心页重复面包屑/大标题静态门禁通过。');
