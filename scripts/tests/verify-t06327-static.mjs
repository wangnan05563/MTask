/**
 * T06327 静态门禁：其余核心页接入统一页面壳、页头、筛选条与唯一标题。
 * 用法：node scripts/tests/verify-t06327-static.mjs
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

const source = Object.fromEntries(pages.map(([label, file]) => [label, read(file)]));

for (const [label] of pages) {
  const text = source[label];
  const pageShellCount = (text.match(/<PageShell/g) ?? []).length;
  const pageHeaderCount = (text.match(/<PageHeader/g) ?? []).length;
  if (!text.includes("from '../ui/layout'")) failures.push(`${label} 未从统一布局出口导入`);
  if (pageShellCount !== 1) failures.push(`${label} PageShell 数量应为 1，实际 ${pageShellCount}`);
  if (pageHeaderCount !== 1) failures.push(`${label} PageHeader 数量应为 1，实际 ${pageHeaderCount}`);
  if (text.split('\n').some((line) => /^\s*<h1[\s>]/.test(line))) failures.push(`${label} 仍有手写 h1，标题必须由 PageHeader 提供`);
}

for (const label of ['AI 工具与模型', '通用需求']) {
  const text = source[label];
  if (!/<FilterBar/.test(text)) failures.push(`${label} 未接入 FilterBar`);
  if (!/ariaLabel=/.test(text)) failures.push(`${label} FilterBar 缺少可访问名`);
}

if (!/active !== 'dashboard'/.test(source['设置'])) failures.push('设置页未让位仪表盘子页页头，存在双 h1 风险');
if (!/calc\(100vh - 260px\)/.test(source['执行会话'])) failures.push('执行会话页未为新页头预留高度');
if (!source['投递队列'].includes('primaryAction={(')) failures.push('投递队列页未把新建队列收口到页头主操作槽');

const shell = read('web/src/ui/layout/PageShell.tsx');
const css = read('web/src/ui/layout/pageShell.css');
const index = read('web/src/ui/layout/index.ts');
if (!/data-page-primary-action="true"/.test(shell)) failures.push('PageHeader 主操作槽标记缺失');
if (!/aria-label="面包屑"/.test(shell)) failures.push('PageHeader 面包屑语义缺失');
if (!/ariaLabel = '筛选条'/.test(shell)) failures.push('FilterBar 默认可访问名缺失');
if (!/--mt-page-max:\s*1440px/.test(css)) failures.push('页面壳 1440px 上限缺失');
if (!/position:\s*sticky/.test(css)) failures.push('筛选条吸顶规则缺失');
if (!/export \{ PageShell, PageHeader, FilterBar \}/.test(index)) failures.push('统一布局出口不完整');

const pageShellCount = pages.reduce((n, [, file]) => n + (fs.readFileSync(path.join(root, file), 'utf8').match(/<PageShell/g) ?? []).length, 0);
const pageHeaderCount = pages.reduce((n, [, file]) => n + (fs.readFileSync(path.join(root, file), 'utf8').match(/<PageHeader/g) ?? []).length, 0);
const filterBarPages = pages.filter(([, file]) => /<FilterBar/.test(fs.readFileSync(path.join(root, file), 'utf8'))).map(([label]) => label);

const out = {
  corePages: pages.length,
  pageShellCount,
  pageHeaderCount,
  filterBarPages,
  failures,
};
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06327 其余核心页统一页面壳、页头与筛选条门禁通过。');
