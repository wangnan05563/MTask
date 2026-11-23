/** T06289：PrimaryNav SSR 门禁——5 个入口、二级页签、aria 语义与折叠态。 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrimaryNav } from '../web/src/ui/nav/PrimaryNav';
import type { Tab } from '../web/src/ui/tabs';

const render = (activeTab: Tab, collapsed: boolean) => renderToStaticMarkup(createElement(PrimaryNav, {
  activeTab,
  collapsed,
  onToggle: () => {},
  onSelect: () => {},
}));

const failures: string[] = [];
const assert = (condition: boolean, message: string) => { if (!condition) failures.push(message); };

const expanded = render('queue', false);
assert((expanded.match(/class="mt-nav-item"/g) ?? []).length === 5, '展开态一级入口数不是 5');
for (const label of ['首页', '任务', '项目', 'AI 控制台', '设置']) {
  assert(expanded.includes(label), `展开态缺少入口：${label}`);
}
for (let i = 1; i <= 5; i += 1) {
  assert(expanded.includes(`aria-keyshortcuts="${i}"`), `缺少数字快捷键 ${i}`);
}
assert(expanded.includes('aria-label="一级导航"'), '缺少一级导航 aria-label');
assert(expanded.includes('aria-current="page"'), '当前入口缺少 aria-current');
assert((expanded.match(/class="mt-nav-subitem"/g) ?? []).length === 4, 'AI 控制台二级页签数不是 4');
for (const label of ['队列', '执行会话', '提示词', '模型']) {
  assert(expanded.includes(label), `AI 控制台缺少二级页签：${label}`);
}
assert(expanded.includes('aria-label="AI 控制台子页面"'), '缺少二级页签 aria-label');
assert(expanded.includes('aria-label="折叠导航"'), '展开态缺少折叠按钮语义');

const collapsed = render('queue', true);
assert((collapsed.match(/class="mt-nav-item"/g) ?? []).length === 5, '折叠态一级入口数不是 5');
assert(collapsed.includes('mt-primary-nav is-collapsed'), '折叠态缺少 is-collapsed 类');
assert(!collapsed.includes('mt-nav-sub'), '折叠态不应渲染二级页签');
assert(collapsed.includes('aria-label="展开导航"'), '折叠态缺少展开按钮语义');

const home = render('dashboard', false);
assert(!home.includes('mt-nav-sub'), '首页不应渲染二级页签');
assert(home.includes('aria-current="page"'), '首页缺少当前入口语义');

console.log(JSON.stringify({
  expandedBytes: expanded.length,
  collapsedBytes: collapsed.length,
  homeBytes: home.length,
  failures,
}, null, 2));
if (failures.length) {
  console.error('FAIL: T06289 主导航 SSR 语义门禁未通过。');
  process.exit(1);
}
console.log('PASS: T06289 主导航 5 入口、二级页签、折叠与 aria 语义通过。');
