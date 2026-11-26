/**
 * T06343 静态门禁：任务工具条低频项收口到「更多」，模板入口前置于添加任务，搜索框收缩。
 * 用法：node scripts/tests/verify-t06343-static.mjs
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

const text = read('web/src/pages/TasksPage.tsx');
const between = (startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) { failures.push(`无法定位代码段：${startMarker} → ${endMarker}`); return ''; }
  return text.slice(start, end);
};

const morePanel = between('function renderMorePanel()', 'function renderToolbar()');
const exportHelper = between('function renderProjectExportSelect()', 'function renderProjectActionButtons()');
const toolbar = between('function renderToolbar()', 'function renderSuggestionStrip(');
const newTaskForm = between('function renderNewTaskForm()', 'function renderTaskLists(');

for (const marker of [
  'data-t06343="more-panel"',
  'data-t06343="saved-view"',
  'SavedViewMenu',
  'renderWsAskButton()',
  'renderBeautifyToolbarButton()',
  'data-t06322="density"',
  'data-t03343="git-toggle"',
  'data-t06343="project-actions"',
  'renderProjectActionButtons()',
  'renderProjectExportSelect()',
]) {
  if (!morePanel.includes(marker)) failures.push(`「更多」面板缺少 ${marker}`);
}
if (!exportHelper.includes('data-t03267="project-export"')) failures.push('导出项目控件缺少 data-t03267 标识');

for (const marker of [
  'SavedViewMenu',
  '<TemplateMenu',
  'renderBeautifyToolbarButton()',
  'renderWsAskButton()',
  'renderProjectActionButtons()',
  'data-t06322="density"',
  'data-t03343="git-toggle"',
]) {
  if (toolbar.includes(marker)) failures.push(`任务工具条主排仍直接渲染 ${marker}`);
}

if (!toolbar.includes('{renderMorePanel()}') || toolbar.includes('moreOpen && renderMorePanel()')) {
  failures.push('「更多」面板未常驻挂载/关闭时未保留 DOM');
}
if (!morePanel.includes("display: moreOpen ? 'flex' : 'none'")) failures.push('「更多」面板未按展开态切换 display');
if (!/maxWidth: 160/.test(toolbar) || !/data-page-search/.test(toolbar)) failures.push('搜索框未收缩到 160px');
const searchAt = toolbar.indexOf('data-page-search');
if (searchAt >= 0) {
  const searchBefore = toolbar.slice(Math.max(0, searchAt - 220), searchAt);
  if (/className="op-hidden"/.test(searchBefore)) failures.push('搜索框仍默认隐藏，首排只留高频操作的口径未落地');
}

if (!newTaskForm.includes('<TemplateMenu')) failures.push('新建任务行缺少模板入口');
const templateAt = newTaskForm.indexOf('<TemplateMenu');
const addAt = newTaskForm.indexOf("aria-label={creating ? '添加中");
if (templateAt < 0 || addAt < 0 || templateAt > addAt) failures.push('模板入口未前置于添加任务按钮');
if (!/data-t06305="template-menu"/.test(read('web/src/components/TemplateMenu.tsx'))) failures.push('TemplateMenu 缺少稳定标识');

if (!text.includes('aria-label="更多：低频操作与筛选"')) failures.push('「更多」入口的可访问名未覆盖低频操作');
if (!text.includes('data-t06343="beautify"')) failures.push('AI 美化按钮缺少 T06343 标识');
if (!toolbar.includes('{renderBeautifyStatus()}')) failures.push('美化运行态未外置到「更多」之外');
if (!text.includes('if (anyBeautify) return null;')) failures.push('美化运行态仍可能随「更多」一起渲染取消/进度');

const result = { morePanelMarkers: morePanel.length, toolbarLength: toolbar.length, formLength: newTaskForm.length, failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06343 任务工具条低频收口与模板前置静态门禁通过。');
