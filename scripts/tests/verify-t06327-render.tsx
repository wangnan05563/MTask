/**
 * T06327 SSR 门禁：页面壳/页头/筛选条在 react-dom/server 下输出唯一 h1、面包屑、主操作槽与吸顶语义。
 * 用法：node node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json scripts/tests/verify-t06327-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar, PageHeader, PageShell } from '../../web/src/ui/layout/index.ts';

const failures: string[] = [];
function expectIncludes(label: string, html: string, markers: string[]) {
  for (const marker of markers) {
    if (!html.includes(marker)) failures.push(`${label} 缺少 ${marker}`);
  }
}
function expectNotIncludes(label: string, html: string, marker: string) {
  if (html.includes(marker)) failures.push(`${label} 不应出现 ${marker}`);
}
function count(label: string, html: string, needle: string, expected: number) {
  const actual = html.split(needle).length - 1;
  if (actual !== expected) failures.push(`${label} ${needle} 数量期望 ${expected} 实际 ${actual}`);
}

const full = renderToStaticMarkup(
  <PageShell className="mt-ssr-page">
    <PageHeader
      title="项目计划"
      titleId="ssr-page-title"
      description="按项目编排串行/并行计划与里程碑。"
      breadcrumbs={[{ label: '工作台', href: '#dashboard' }, { label: '项目计划' }]}
      primaryAction={<button type="button">新建计划</button>}
      secondaryActions={<button type="button">导出</button>}
      viewSwitch={<span>列表 / 时间线</span>}
    />
    <FilterBar ariaLabel="计划筛选">
      <label>状态 <select defaultValue="all"><option value="all">全部</option></select></label>
    </FilterBar>
    <section>正文</section>
  </PageShell>,
);

expectIncludes('完整页面壳', full, [
  'mt-page-shell', 'mt-ssr-page', 'mt-page-header', 'mt-page-title',
  'aria-label="面包屑"', 'mt-page-breadcrumb-link', 'mt-page-breadcrumb-text',
  'data-page-primary-action="true"', 'mt-page-secondary-actions', 'mt-page-view-switch',
  'role="search"', 'aria-label="计划筛选"', 'mt-page-filter-sticky', '项目计划', '工作台', '新建计划', '导出',
]);
count('完整页面壳', full, '<h1', 1);

const noExtras = renderToStaticMarkup(
  <PageHeader title="通用需求" description="沉淀可复用方案。" breadcrumbs={[{ label: '通用需求' }]} />,
);
expectIncludes('极简页头', noExtras, ['mt-page-header', 'mt-page-title', '通用需求', '沉淀可复用方案。']);
expectNotIncludes('极简页头', noExtras, 'data-page-primary-action');
count('极简页头', noExtras, '<h1', 1);

const nonSticky = renderToStaticMarkup(<FilterBar sticky={false}><span>关键字</span></FilterBar>);
expectIncludes('非吸顶筛选条', nonSticky, ['role="search"', 'mt-page-filter', '关键字']);
expectNotIncludes('非吸顶筛选条', nonSticky, 'mt-page-filter-sticky');

const out = {
  fullBytes: Buffer.byteLength(full),
  minimalBytes: Buffer.byteLength(noExtras),
  nonStickyBytes: Buffer.byteLength(nonSticky),
  failures,
};
console.log(JSON.stringify(out, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06327 页面壳、页头与筛选条 SSR 门禁通过。');
