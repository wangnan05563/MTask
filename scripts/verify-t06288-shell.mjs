/**
 * T06288 静态门禁：页面壳/页头/筛选条落位、Token 约束、核心页接入与响应式规则。
 * 用法：node scripts/verify-t06288-shell.mjs
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

const shellTsx = read('web/src/ui/layout/PageShell.tsx');
const shellCss = read('web/src/ui/layout/pageShell.css');
const shellIndex = read('web/src/ui/layout/index.ts');
const mainTsx = read('web/src/main.tsx');
const appTsx = read('web/src/App.tsx');
const tasksPage = read('web/src/pages/TasksPage.tsx');
const promptsPage = read('web/src/pages/PromptsPage.tsx');

const checks = [
  ['PageShell 导出三个组件', /export function PageShell/.test(shellTsx) && /export function PageHeader/.test(shellTsx) && /export function FilterBar/.test(shellTsx)],
  ['PageHeader 面包屑语义', /aria-label="面包屑"/.test(shellTsx)],
  ['PageHeader 主操作槽位', /data-page-primary-action="true"/.test(shellTsx)],
  ['FilterBar 搜索语义', /role="search"/.test(shellTsx)],
  ['FilterBar 吸顶开关', /mt-page-filter-sticky/.test(shellTsx) && /position:\s*sticky/.test(shellCss)],
  ['内容宽度 1440', /--mt-page-max:\s*1440px/.test(shellCss)],
  ['筛选条 48px 基线', /--mt-page-filter-height:\s*48px/.test(shellCss) && /min-height:\s*var\(--mt-page-filter-height\)/.test(shellCss)],
  ['窄屏横向滚动', /max-width:\s*960px/.test(shellCss) && /overflow-x:\s*auto/.test(shellCss)],
  ['布局样式已接入入口', mainTsx.includes("import './ui/layout/pageShell.css'")],
  ['App 页边距 24px', /padding: '0 24px 40px'/.test(appTsx)],
  ['任务页接入页面壳', tasksPage.includes("from '../ui/layout'") && /<PageShell>/.test(tasksPage) && /<PageHeader/.test(tasksPage)],
  ['提示词页接入页面壳与筛选条', promptsPage.includes("from '../ui/layout'") && /<PageShell>/.test(promptsPage) && /<PageHeader/.test(promptsPage) && /<FilterBar/.test(promptsPage)],
  ['布局统一出口', /export \{ PageShell, PageHeader, FilterBar \}/.test(shellIndex)],
  ['新布局文件无硬编码色', !/#[0-9a-fA-F]{3,8}/.test(shellTsx + shellCss) && !/rgba?\(/.test(shellTsx + shellCss)],
];

for (const [label, ok] of checks) {
  if (!ok) failures.push(label);
}

const pageHeaderCount = (tasksPage.match(/<PageHeader/g) ?? []).length + (promptsPage.match(/<PageHeader/g) ?? []).length;
const pageShellCount = (tasksPage.match(/<PageShell>/g) ?? []).length + (promptsPage.match(/<PageShell>/g) ?? []).length;
const filterBarCount = (promptsPage.match(/<FilterBar/g) ?? []).length;

const out = {
  pageHeaderCount,
  pageShellCount,
  filterBarCount,
  cssBytes: Buffer.byteLength(shellCss),
  failures,
};
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06288 页面壳、页头、筛选条与核心页接入门禁通过。');
