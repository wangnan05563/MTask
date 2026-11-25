/**
 * T06329 静态门禁：顶栏项目/工作区切换器、全局项目上下文与消费页接入。
 * 用法：node scripts/tests/verify-t06329-static.mjs
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
function must(label, text, needle) {
  if (!text.includes(needle)) failures.push(`${label} 缺少 ${needle}`);
}
function mustNot(label, text, needle) {
  if (text.includes(needle)) failures.push(`${label} 不应出现 ${needle}`);
}
function count(label, text, needle, expected) {
  const actual = text.split(needle).length - 1;
  if (actual !== expected) failures.push(`${label} ${needle} 数量期望 ${expected} 实际 ${actual}`);
}

const store = read('web/src/ui/activeProject.ts');
const switcher = read('web/src/ui/nav/ProjectSwitcher.tsx');
const app = read('web/src/App.tsx');
const css = read('web/src/ui/nav/primaryNav.css');

for (const marker of [
  "ACTIVE_PROJECT_KEY = 'tasks.activeProject'",
  "ALL_PROJECTS = '__all__'",
  'export function getActiveProject',
  'export function setActiveProject',
  'export function useActiveProject',
  'export function activeProjectLabel',
  'export function normalizeActiveProject',
  'useSyncExternalStore',
  "addEventListener('storage'",
  'localStorage',
]) must('全局项目上下文', store, marker);
must('全局项目上下文', store, '全部项目');
mustNot('全局项目上下文', store, 'location.reload');

for (const marker of [
  'aria-haspopup="listbox"',
  'aria-expanded={open}',
  'role="listbox"',
  'role="option"',
  'aria-selected={o.id === projectId}',
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
  'Escape',
  "'Enter'",
  "' '",
  'buttonRef.current?.focus()',
  '全部项目',
  '项目列表加载中…',
  '项目列表加载失败',
  '暂无项目',
]) must('顶栏切换器', switcher, marker);
must('顶栏切换器', switcher, 'useProjectList({ excludeInbox: true })');
must('顶栏切换器', switcher, 'useActiveProject()');
mustNot('顶栏切换器', switcher, 'location.reload');
mustNot('顶栏切换器', switcher, 'window.location');

count('App 顶栏', app, '<ProjectSwitcher />', 1);
must('App 顶栏', app, "from './ui/nav/ProjectSwitcher'");
const headerIndex = app.indexOf('<header className="mt-top-switcher"');
const switcherIndex = app.indexOf('<ProjectSwitcher />');
const tabsIndex = app.indexOf('{activeGroup.tabs.length > 1 && (');
if (!(headerIndex >= 0 && headerIndex < switcherIndex && switcherIndex < tabsIndex)) {
  failures.push('ProjectSwitcher 未位于顶栏分组名之后、页签之前');
}

for (const marker of [
  '.mt-project-switcher',
  '.mt-project-switcher-button',
  '.mt-project-menu',
  '.mt-project-option',
  'aria-expanded="true"',
  'var(--card-bg)',
  'var(--accent)',
  'var(--text)',
  'max-width: 120px',
]) must('切换器样式', css, marker);
if (/#[0-9a-fA-F]{3,8}/.test(css.split('T06329')[1] ?? '') || /rgba?\(/.test(css.split('T06329')[1] ?? '')) {
  failures.push('T06329 样式出现硬编码颜色，必须走主题变量');
}
for (const [label, text] of [['全局上下文', store], ['切换器', switcher]]) {
  if (/#[0-9a-fA-F]{3,8}/.test(text) || /rgba?\(/.test(text)) failures.push(`${label} 出现硬编码颜色`);
}

const tasks = read('web/src/pages/TasksPage.tsx');
const plan = read('web/src/pages/PlanPage.tsx');
const req = read('web/src/pages/ReqPage.tsx');
const queue = read('web/src/pages/QueuePage.tsx');
const report = read('web/src/pages/ReportPage.tsx');

must('任务页', tasks, "from '../ui/activeProject'");
must('任务页', tasks, 'useActiveProject()');
mustNot('任务页', tasks, "usePersistentState('tasks.activeProject'");
mustNot('任务页', tasks, "const ALL_PROJECTS = '__all__'");
must('任务页', tasks, 'projectId === ALL_PROJECTS ? \'\' : projectId');

must('计划页', plan, "from '../ui/activeProject'");
must('计划页', plan, 'const projectId = globalProject');
must('计划页', plan, 'setGlobalProject(id)');
mustNot('计划页', plan, 'const projectId = globalProject || sessionProjectId');
mustNot('计划页', plan, 'setProjectId(ps[0].id)');
const planReload = plan.indexOf('const reload = useCallback');
const planEmptyGuard = plan.indexOf('if (!projectId) {', planReload);
const planClearPlans = plan.indexOf('setPlans([])', planEmptyGuard);
if (planReload < 0 || planEmptyGuard < 0 || planClearPlans < 0) {
  failures.push('计划页切到全部项目时未清空上一项目的 plans，空态会被旧数据占住');
}
must('需求页', req, "from '../ui/activeProject'");
must('需求页', req, 'useActiveProject()');
mustNot('需求页', req, "usePersistentState('tasks.activeProject'");
must('队列页', queue, "from '../ui/activeProject'");
must('队列页', queue, 'const projectId = globalProject');
must('报表页', report, "from '../ui/activeProject'");
must('报表页', report, 'setProjectIds(globalProject ? [globalProject] : [])');
must('报表页', report, 'scopeInitialized');
mustNot('报表页', report, 'mountedWithGlobalScope');

const out = {
  files: {
    store: 'web/src/ui/activeProject.ts',
    switcher: 'web/src/ui/nav/ProjectSwitcher.tsx',
    app: 'web/src/App.tsx',
    css: 'web/src/ui/nav/primaryNav.css',
  },
  consumers: ['任务', '项目计划', '通用需求', '投递队列', '报表'],
  failures,
};
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06329 顶栏项目切换器、全局项目上下文与消费页接入静态门禁通过。');
