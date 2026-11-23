/**
 * T06289 静态门禁：5 个一级入口、顶栏子页签、折叠与响应式样式、旧顶部导航移除。
 * 仅用于本次验收，脚本可提交。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const failures = [];

const groups = read('web/src/ui/nav/primaryNavGroups.ts');
const app = read('web/src/App.tsx');
const tabs = read('web/src/ui/tabs.ts');
const css = read('web/src/ui/nav/primaryNav.css');
const main = read('web/src/main.tsx');

const groupCount = (groups.match(/defaultTab: '/g) ?? []).length;
if (groupCount !== 5) failures.push(`一级入口数量应为 5，实际 ${groupCount}`);

const labels = [...groups.matchAll(/^ {4}label: '([^']+)',$/gm)].map((m) => m[1]);
for (const expected of ['首页', '任务', '项目', 'AI 控制台', '设置']) {
  if (!labels.includes(expected)) failures.push(`缺少一级入口：${expected}`);
}
if (labels.length !== 5) failures.push(`一级入口标签数应为 5，实际 ${labels.length}: ${labels.join('|')}`);

if (!tabs.includes("'dashboard'")) failures.push('tabs.ts 缺少 dashboard 页面键');
if (!app.includes('<PrimaryNav')) failures.push('App.tsx 未接入 PrimaryNav');
if (!app.includes('className="mt-top-switcher"')) failures.push('App.tsx 缺少顶栏切换器');
if (!app.includes("{tab === 'dashboard' && <DashboardPage />}")) failures.push('App.tsx 缺少首页渲染');
if (app.includes('className="nav-btn"')) failures.push('App.tsx 仍残留旧顶部导航按钮');
if (app.includes('TABS.map((t, i)')) failures.push('App.tsx 仍按 TABS 渲染顶部导航');
if (!app.includes('/^[1-5]$/')) failures.push('数字快捷键未收敛到 1~5');
if (!app.includes('mtask.nav.collapsed')) failures.push('折叠状态未持久化');

if (!css.includes('--mt-nav-width: 240px')) failures.push('侧栏展开宽度不是 240px');
if (!css.includes('--mt-nav-width: 64px')) failures.push('侧栏折叠宽度不是 64px');
if (!css.includes('min-height: 56px')) failures.push('顶栏高度不是 56px');
if (!css.includes('position: sticky')) failures.push('导航/顶栏缺少 sticky');
if (!css.includes('@media (max-width: 960px)')) failures.push('缺少 960px 响应式兜底');
if (!main.includes("./ui/nav/primaryNav.css")) failures.push('main.tsx 未引入导航样式');
if (!main.includes('./ui/layout/pageShell.css')) failures.push('main.tsx 丢失页面壳样式');

console.log(JSON.stringify({ groupCount, labels, failures }, null, 2));
if (failures.length) {
  console.error('FAIL: T06289 导航静态门禁未通过。');
  process.exit(1);
}
console.log('PASS: T06289 5 个一级入口、顶栏切换器、折叠与响应式静态门禁通过。');
