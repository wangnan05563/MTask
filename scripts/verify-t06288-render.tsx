/**
 * T06288 SSR 门禁：验证 PageShell / PageHeader / FilterBar 实际渲染语义与组合关系。
 * 用法：node node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json scripts/verify-t06288-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar, PageHeader, PageShell } from '../web/src/ui/layout/PageShell.tsx';

const failures: string[] = [];
function expectIncludes(label: string, html: string, markers: string[]) {
  for (const marker of markers) {
    if (!html.includes(marker)) failures.push(`${label} 缺少 ${marker}`);
  }
}

const page = renderToStaticMarkup(
  <PageShell>
    <PageHeader
      title="任务"
      description="统一查看待办与已完成任务。"
      breadcrumbs={[{ label: '工作台' }, { label: '任务', href: '/tasks' }]}
      primaryAction={<button type="button">新建任务</button>}
      secondaryActions={<button type="button">导出</button>}
      viewSwitch={<span>列表 / 看板</span>}
    />
    <FilterBar ariaLabel="任务筛选">
      <input aria-label="搜索任务" />
    </FilterBar>
  </PageShell>,
);

expectIncludes('PageShell', page, ['mt-page-shell', '<section']);
expectIncludes('PageHeader', page, [
  'mt-page-header',
  '<h1',
  'aria-label="面包屑"',
  'mt-page-breadcrumb-link',
  'href="/tasks"',
  'mt-page-primary-action',
  'data-page-primary-action="true"',
  'mt-page-secondary-actions',
  'mt-page-view-switch',
  '统一查看待办与已完成任务',
]);
expectIncludes('FilterBar', page, ['role="search"', 'aria-label="任务筛选"', 'mt-page-filter', 'mt-page-filter-sticky']);

const nonSticky = renderToStaticMarkup(
  <FilterBar ariaLabel="非吸顶筛选" sticky={false}>
    <span>筛选项</span>
  </FilterBar>,
);
expectIncludes('FilterBar 非吸顶', nonSticky, ['mt-page-filter', 'role="search"']);
if (nonSticky.includes('mt-page-filter-sticky')) failures.push('FilterBar sticky=false 仍输出吸顶类');

const out = {
  pageBytes: Buffer.byteLength(page),
  nonStickyBytes: Buffer.byteLength(nonSticky),
  failures,
};
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06288 页面壳/页头/筛选条 SSR 渲染与语义通过。');
