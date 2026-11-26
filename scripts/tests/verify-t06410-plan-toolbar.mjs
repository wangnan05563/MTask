/**
 * T06410 静态门禁：计划页工具栏「更多」改为行尾展开面板，
 * AI 评估 / 补算复杂度 / 多选迁到刷新前并沿用 op-hidden 悬浮显隐。
 * 用法：node scripts/tests/verify-t06410-plan-toolbar.mjs
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

const plan = read('web/src/pages/PlanPage.tsx').replace(/\r\n/g, '\n');
const app = read('web/src/App.tsx').replace(/\r\n/g, '\n');

const between = (text, startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures.push(`无法定位代码段：${startMarker} → ${endMarker}`);
    return '';
  }
  return text.slice(start, end);
};
const indexOrder = (text, markers, label) => {
  const positions = markers.map((marker) => text.indexOf(marker));
  if (positions.some((value) => value < 0)) {
    failures.push(`${label} 缺少标记：${markers.filter((_, i) => positions[i] < 0).join(' / ')}`);
    return;
  }
  if (positions.some((value, i) => i > 0 && value <= positions[i - 1])) {
    failures.push(`${label} 顺序不正确：${markers.join(' → ')}`);
  }
};

const toolbar = between(plan, '<div className="op-host" data-t06410="toolbar"', '{notice &&');
const moreMenu = between(plan, 'function PlanMoreMenu(', '/**\n * T03197');
const evalButton = between(plan, 'function PlanEvalButton(', 'function PlanComplexityButton(');
const complexityButton = between(plan, 'function PlanComplexityButton(', 'function PlanMultiToggle(');
const multiToggle = between(plan, 'function PlanMultiToggle(', 'function PlanViewModeToggle(');

if (!toolbar.includes('className="op-host"')) failures.push('计划工具条根节点不再是 op-host，悬浮显隐不会生效');
if (!/flexWrap: 'wrap'/.test(toolbar)) failures.push('计划工具条未保持自适应换行');
indexOrder(toolbar, ['<button onClick={reload}', '<PlanMoreMenu'], '行尾「更多」');

indexOrder(toolbar, [
  '<PlanEvalButton',
  '<PlanComplexityButton',
  '<PlanMultiToggle',
  '<button onClick={reload}',
  '<PlanMoreMenu',
], '迁移按钮');
if (toolbar.indexOf('PlanViewModeToggle') > toolbar.indexOf('<PlanEvalButton')) {
  failures.push('AI 评估仍排在视图切换之前，未完成向刷新前的迁移');
}
if (toolbar.indexOf('PlanPanelToggles') > toolbar.indexOf('<PlanEvalButton')) {
  failures.push('AI 评估仍排在视图面板之前，未完成向刷新前的迁移');
}
if (!toolbar.includes('data-t03622="holiday"') || toolbar.indexOf('data-t03622="holiday"') > toolbar.indexOf('<PlanEvalButton')) {
  failures.push('节假日管理与 AI 评估的相对顺序异常');
}

if (!/className=\{\(blocked \? '' : 'op-hidden'\) \+ \(evalBusy \? ' task-breathe' : ''\)\}/.test(evalButton)) {
  failures.push('AI 评估未保持默认 op-hidden、AI 不可用时可见禁用');
}
if (!evalButton.includes('data-ai-blocked={blocked')) {
  failures.push('AI 评估缺少不可用状态标记');
}
if (!/className=\{'op-hidden' \+ \(evalBusy \? ' task-breathe' : ''\)\}/.test(complexityButton)) {
  failures.push('补算复杂度未改为默认 op-hidden 隐身');
}
if (!/className=\{'tbtn-anim' \+ \(planMulti \? '' : ' op-hidden'\)\}/.test(multiToggle)) {
  failures.push('多选未保持默认隐身、激活后常显');
}
if (!app.includes('.op-host:hover .op-hidden') || !app.includes('.op-host:focus-within .op-hidden')) {
  failures.push('op-host 悬浮/聚焦显隐规则缺失');
}

if (plan.includes('TaskMoreMenu') || plan.includes('TaskMoreMenuItem')) {
  failures.push('计划页仍引用任务页下拉菜单组件，未移除原「更多」下拉');
}
if (!moreMenu.includes('aria-expanded={open}') || !moreMenu.includes('data-t06410="more-panel"')) {
  failures.push('「更多」触发按钮与行内面板缺少展开状态绑定');
}
if (!moreMenu.includes('aria-controls="plan-more-panel"') || !moreMenu.includes('id="plan-more-panel"')) {
  failures.push('「更多」触发按钮与面板缺少 aria-controls/id 关联');
}
if (!moreMenu.includes('data-t06410="more-trigger"')) failures.push('「更多」触发按钮缺少稳定标识');
if (!moreMenu.includes("marginLeft: 'auto'")) failures.push('「更多」触发按钮未用 margin-left:auto 贴住工具栏行尾');
if (!moreMenu.includes('role="group"') || moreMenu.includes('role="menu"')) {
  failures.push('「更多」展开面板不是行内 group 语义');
}
if (!plan.includes('order: 9') || !plan.includes("flexBasis: '100%'")) {
  failures.push('「更多」面板未独占新一行（order/flexBasis）');
}
for (const group of ['plan', 'data', 'share']) {
  if (!plan.includes(`key: '${group}'`)) failures.push(`「更多」面板缺少 ${group} 分类`);
}
if (!moreMenu.includes('data-t06410-group={g.key}')) {
  failures.push('「更多」面板缺少分类组渲染锚点');
}
for (const item of ['create-plan', 'import-excel', 'export-excel', 'export-markdown', 'download-template', 'share-snapshot']) {
  if (!moreMenu.includes(`key: '${item}'`)) failures.push(`「更多」面板缺少原入口 ${item}`);
}
if (!moreMenu.includes('onClick={() => run(it)}') || !moreMenu.includes('disabled={it.disabled}')) {
  failures.push('「更多」面板入口未保留点击/禁用逻辑');
}
if (!moreMenu.includes('importRef') || !moreMenu.includes('ShareSnapshotDialog')) {
  failures.push('导入文件输入或分享快照弹窗状态丢失');
}
if (!moreMenu.includes("e.key !== 'Escape'") || !moreMenu.includes('btnRef.current?.focus()')) {
  failures.push('「更多」面板缺少 Esc 收起与焦点回位');
}
if (!moreMenu.includes('document.addEventListener(\'mousedown\', onDoc)')) {
  failures.push('「更多」面板缺少外点收起');
}
if (moreMenu.includes('createPortal')) failures.push('「更多」仍使用 Portal 浮层，不是行内展开');

const moreStyles = between(plan, 'const PLAN_MORE_PANEL_STYLE', 'const PLAN_MORE_ITEM_STYLE');
if (!moreStyles.includes('flexWrap: \'wrap\'') || !moreStyles.includes('minWidth: 0')) {
  failures.push('「更多」面板组行未做自适应换行/收缩');
}

if (failures.length) {
  console.error('T06410 静态门禁 FAIL');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('T06410 静态门禁 PASS：行尾「更多」展开面板、三按钮迁移与悬浮显隐、导出/分享入口保留');
