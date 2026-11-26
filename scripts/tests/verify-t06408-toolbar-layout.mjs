/**
 * T06408 静态门禁：任务菜单按钮布局迁移、More 分类换行、顶栏项目排序、行尾自适应。
 * 用法：node scripts/tests/verify-t06408-toolbar-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (rel) => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(`缺少文件：${rel}`); return ''; }
  return fs.readFileSync(abs, 'utf8');
};

const tasks = read('web/src/pages/TasksPage.tsx');
const app = read('web/src/App.tsx');
const switcher = read('web/src/ui/nav/ProjectSwitcher.tsx');
const sortButton = read('web/src/ui/nav/ProjectSortButton.tsx');
const sortPref = read('web/src/ui/tasksProjectSort.ts');
const css = read('web/src/ui/nav/primaryNav.css');

const between = (text, startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures.push(`无法定位代码段：${startMarker} → ${endMarker}`);
    return '';
  }
  return text.slice(start, end);
};

const toolbar = between(tasks, 'function renderToolbar()', 'function renderSuggestionStrip(');
const morePanel = between(tasks, 'function renderMorePanel()', 'function renderToolbar()');
const importHelper = between(tasks, 'function renderImportButton()', 'function renderProjectExportSelect()');
const exportHelper = between(tasks, 'function renderProjectExportSelect()', 'function renderProjectActionButtons()');

const topbarSortAt = app.indexOf('<ProjectSortButton />');
const projectSwitcherAt = app.indexOf('<ProjectSwitcher />');
if (topbarSortAt < 0 || projectSwitcherAt < 0 || topbarSortAt < projectSwitcherAt) {
  failures.push('框架顶栏未把项目排序入口放在「当前项目/工作区」切换器之后');
}
if (!app.includes("import { ProjectSortButton } from './ui/nav/ProjectSortButton';")) {
  failures.push('App 未引入 ProjectSortButton');
}

for (const marker of [
  'data-t06408-sort="topbar"',
  'data-t06408-sort-trigger',
  'role="menu"',
  'role="menuitemradio"',
  'PROJ_SORT_OPTIONS',
  'useTasksProjectSort',
]) {
  if (!sortButton.includes(marker)) failures.push(`顶栏项目排序缺少 ${marker}`);
}

for (const marker of [
  'useTasksProjectSort',
  'sortProjects(projects, sortMode)',
  '...sortedProjects.map',
]) {
  if (!switcher.includes(marker)) failures.push(`项目切换器未共享排序偏好：${marker}`);
}
if (!sortPref.includes("'tasks.projectSort'") || !sortPref.includes('CustomEvent')) {
  failures.push('项目排序共享状态未沿用 tasks.projectSort 持久化键或缺少同页广播');
}

if (!/data-t06408="toolbar"/.test(toolbar)) failures.push('任务工具条缺少 T06408 稳定标识');
for (const marker of ['{renderViewToggle()}', '{renderWorkspaceSearchButton()}', '{renderClassifyButton()}', '{renderMultiSelectButton()}']) {
  if (!toolbar.includes(marker)) failures.push(`主按钮栏缺少 ${marker}`);
}
const positions = ['{renderViewToggle()}', '{renderWorkspaceSearchButton()}', '{renderClassifyButton()}', '{renderMultiSelectButton()}'].map((marker) => toolbar.indexOf(marker));
if (positions.some((value, index) => value < 0 || (index > 0 && value <= positions[index - 1]))) {
  failures.push('主按钮栏顺序未保持 日历视图 → 工作空间检索 → AI 批量分类 → 多选模式');
}
if (toolbar.includes('<WorkspaceSelect') || toolbar.includes('projSort') || toolbar.includes('renderImportButton()') || toolbar.includes('renderProjectExportSelect()')) {
  failures.push('主按钮栏仍直接保留工作空间、项目排序、导入或导出控件');
}
if (toolbar.includes('项目排序') || toolbar.includes('导入数据')) {
  failures.push('主按钮栏仍直接渲染项目排序或导入数据文案');
}

if (!/data-t06408="toolbar-tail"/.test(toolbar) || !/marginLeft: 'auto'/.test(toolbar)) {
  failures.push('搜索框与「更多」未放入 margin-left:auto 的行尾自适应组');
}
const tail = between(toolbar, 'data-t06408="toolbar-tail"', '{renderMorePanel()}');
if (!tail.includes('data-page-search') || !tail.includes('data-t03623="more-trigger"')) {
  failures.push('行尾组未同时包含搜索框与「更多」入口');
}
if (tail.indexOf('data-page-search') > tail.indexOf('data-t03623="more-trigger"')) {
  failures.push('「更多」入口未位于搜索框之后的真正行尾');
}
if (!toolbar.includes('maxWidth: 160')) failures.push('搜索框未保持 160px 收缩口径');
if (!toolbar.includes('{renderMorePanel()}')) failures.push('「更多」面板未常驻挂载');

if (!/flexDirection: 'column'/.test(morePanel)) failures.push('「更多」面板未改为分类分行纵向布局');
const groupOrder = ['view', 'project', 'data', 'filters'];
const groupPositions = groupOrder.map((name) => morePanel.indexOf(`data-t06408-group="${name}"`));
if (groupPositions.some((value) => value < 0) || groupPositions.some((value, index) => index > 0 && value <= groupPositions[index - 1])) {
  failures.push('「更多」分类组未按 视图→项目→数据→筛选 顺序排列');
}
for (const group of groupOrder) {
  if (!morePanel.includes(`aria-label="${group === 'view' ? '视图与显示' : group === 'project' ? '项目与工作空间' : group === 'data' ? '数据导入与导出' : '筛选与字段'}"`)) {
    failures.push(`「更多」分类 ${group} 缺少可读名称`);
  }
}
const projectGroup = between(morePanel, 'data-t06408-group="project"', 'data-t06408-group="data"');
const workspaceAt = projectGroup.indexOf('<WorkspaceSelect');
const newProjectAt = projectGroup.indexOf('renderProjectActionButtons()');
if (workspaceAt < 0 || newProjectAt < 0 || workspaceAt >= newProjectAt) {
  failures.push('工作空间下拉条未位于「新项目」按钮组之前');
}
const dataGroup = between(morePanel, 'data-t06408-group="data"', 'data-t06408-group="filters"');
const exportAt = dataGroup.indexOf('renderProjectExportSelect()');
const importAt = dataGroup.indexOf('renderImportButton()');
if (exportAt < 0 || importAt < 0 || exportAt >= importAt) {
  failures.push('导入数据未位于导出项目之后');
}
if (!importHelper.includes('data-t03214="import-file-input"') || !importHelper.includes('导入数据')) {
  failures.push('导入数据控件未保留文件输入与简体中文文案');
}
if (!exportHelper.includes('data-t03267="project-export"')) failures.push('导出项目控件缺少稳定标识');

for (const marker of [
  'data-t06343="saved-view"',
  'renderWsAskButton()',
  'renderBeautifyToolbarButton()',
  'data-t06322="density"',
  'data-t03343="git-toggle"',
]) {
  if (!morePanel.includes(marker)) failures.push(`「更多」视图分类缺少 ${marker}`);
}
for (const marker of ['data-t03232="field-filter"', 'data-t03232="field-sort"']) {
  if (!morePanel.includes(marker)) failures.push(`「更多」筛选分类缺少 ${marker}`);
}

for (const marker of ['.mt-project-sort {', '.mt-project-sort-button {', '.mt-project-sort-menu {']) {
  if (!css.includes(marker)) failures.push(`顶栏项目排序缺少样式 ${marker}`);
}

const result = {
  toolbarLength: toolbar.length,
  morePanelLength: morePanel.length,
  groupPositions,
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06408 任务菜单按钮布局迁移与分类换行静态门禁通过。');
