/**
 * T06342 SSR 门禁：minimal 页头只输出隐藏 h1 + 操作槽，不再输出面包屑/可见标题/说明。
 * 用法：node node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json scripts/tests/verify-t06342-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeader } from '../../web/src/ui/layout/index.ts';

const failures: string[] = [];
const expect = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

const minimal = renderToStaticMarkup(
  <PageHeader
    title="任务"
    titleId="t06342-title"
    description="不应出现在视觉页头"
    breadcrumbs={[{ label: '工作台' }, { label: '任务' }]}
    primaryAction={<button type="button">新建任务</button>}
    minimal
  />,
);

expect('minimal 标记缺失', minimal.includes('mt-page-header--minimal'));
expect('隐藏 h1 缺失', minimal.includes('mt-page-title-visually-hidden') && minimal.includes('id="t06342-title"') && minimal.includes('任务'));
expect('h1 数量应为 1', minimal.split('<h1').length - 1 === 1);
expect('仍渲染面包屑', !minimal.includes('aria-label="面包屑"'));
expect('仍渲染可见标题类', !minimal.includes('class="mt-page-title"'));
expect('仍渲染说明', !minimal.includes('mt-page-description') && !minimal.includes('不应出现在视觉页头'));
expect('操作槽丢失', minimal.includes('data-page-primary-action="true"') && minimal.includes('新建任务'));

const plain = renderToStaticMarkup(<PageHeader title="设置" minimal />);
expect('无操作时不应输出空操作容器', !plain.includes('mt-page-header-actions'));
expect('无操作时仍保留隐藏 h1', plain.includes('mt-page-title-visually-hidden') && plain.split('<h1').length - 1 === 1);

console.log(JSON.stringify({ minimalBytes: minimal.length, plainBytes: plain.length, failures }, null, 2));
if (failures.length > 0) process.exit(1);
console.log('PASS: T06342 minimal 页头 SSR 门禁通过。');
