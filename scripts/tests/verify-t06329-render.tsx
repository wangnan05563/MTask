/**
 * T06329 SSR 门禁：切换器默认折叠态、可访问语义与全局项目纯函数。
 * 用法：node node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json scripts/tests/verify-t06329-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function main() {
  // api/client 在模块加载期读取 document.baseURI；SSR 下给最小桩，避免把浏览器依赖带进服务端渲染断言。
  (globalThis as unknown as { document: { baseURI: string } }).document = { baseURI: 'http://localhost/' };

  const { ProjectSwitcher } = await import('../../web/src/ui/nav/ProjectSwitcher.tsx');
  const { activeProjectLabel, getActiveProject, setActiveProject } = await import('../../web/src/ui/activeProject.ts');

  const failures: string[] = [];
  const must = (label: string, text: string, marker: string) => {
    if (!text.includes(marker)) failures.push(`${label} 缺少 ${marker}`);
  };
  const mustNot = (label: string, text: string, marker: string) => {
    if (text.includes(marker)) failures.push(`${label} 不应出现 ${marker}`);
  };

  const html = renderToStaticMarkup(<ProjectSwitcher />);
  must('SSR 切换器', html, 'mt-project-switcher');
  must('SSR 切换器', html, 'aria-haspopup="listbox"');
  must('SSR 切换器', html, 'aria-expanded="false"');
  must('SSR 切换器', html, '全部项目');
  must('SSR 切换器', html, '当前项目/工作区：全部项目');
  mustNot('SSR 切换器', html, 'role="listbox"');
  mustNot('SSR 切换器', html, 'mt-project-menu');
  mustNot('SSR 切换器', html, 'aria-selected');

  if (getActiveProject() !== '') failures.push(`SSR 初始项目应为空，实际 ${getActiveProject()}`);
  if (activeProjectLabel('', []) !== '全部项目') failures.push('空作用域展示名应为「全部项目」');
  if (activeProjectLabel('p1', [{ id: 'p1', name: '四期' }]) !== '四期') failures.push('已知项目未展示项目名');
  if (activeProjectLabel('gone', [{ id: 'p1', name: '四期' }]) !== '项目已删除') failures.push('已删项目未给出明确未知态');
  setActiveProject('p1');
  if (getActiveProject() !== 'p1') failures.push('setActiveProject 未更新内存快照（localStorage 不可用时应降级生效）');
  setActiveProject('');

  console.log(JSON.stringify({
    htmlLength: html.length,
    defaultLabel: '全部项目',
    checks: ['折叠态', 'aria-haspopup/expanded', '无未展开菜单', '纯函数回退'],
    failures,
  }, null, 2));
  if (failures.length > 0) process.exit(1);
  console.log('PASS: T06329 顶栏切换器 SSR 与全局项目纯函数门禁通过。');
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
