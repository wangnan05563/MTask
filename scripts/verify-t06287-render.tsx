/**
 * T06287 SSR 渲染门禁：用 react-dom/server 验证原语真的能渲染，且状态映射到 DOM。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t06287-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, Button, Card, EmptyState, IconButton, Input, Skeleton, Table } from '../web/src/ui/components/index.ts';

const failures: string[] = [];
function expectIncludes(label: string, html: string, markers: string[]) {
  for (const marker of markers) {
    if (!html.includes(marker)) failures.push(`${label} 缺少 ${marker}`);
  }
}

const button = renderToStaticMarkup(
  <Button variant="primary" size="md" loading loadingText="保存中">
    保存
  </Button>,
);
expectIncludes('Button loading', button, [
  'data-variant="primary"',
  'data-size="md"',
  'data-loading="true"',
  'aria-busy="true"',
  'disabled=""',
  'mt-btn__spinner',
  '保存中',
]);

const disabledButton = renderToStaticMarkup(<Button disabled>删除</Button>);
expectIncludes('Button disabled', disabledButton, ['disabled=""', 'data-variant="secondary"']);

const iconButton = renderToStaticMarkup(<IconButton icon={<span>+</span>} label="新建任务" />);
expectIncludes('IconButton', iconButton, ['mt-icon-btn', 'aria-label="新建任务"', 'title="新建任务"']);

const card = renderToStaticMarkup(
  <Card title="最近任务" extra={<Badge tone="accent">12</Badge>}>
    <Skeleton width={120} height={8} />
  </Card>,
);
expectIncludes('Card + Badge + Skeleton', card, [
  'mt-card',
  'mt-card__head',
  'mt-card__title',
  'mt-card__body',
  'mt-badge',
  'data-tone="accent"',
  'mt-skeleton',
  'aria-hidden="true"',
]);

const emptyState = renderToStaticMarkup(
  <EmptyState title="还没有任务" hint="创建第一条任务后开始" action={{ label: '新建任务', onClick: () => undefined }} />,
);
expectIncludes('EmptyState', emptyState, ['mt-empty', 'mt-empty__title', 'mt-empty__hint', 'mt-empty__action']);

const input = renderToStaticMarkup(
  <Input label="任务名称" hint="用于列表展示" error="不能为空" defaultValue="demo" />,
);
expectIncludes('Input error', input, [
  'mt-field__label',
  'aria-invalid="true"',
  'aria-describedby=',
  '-hint',
  '-error',
  'role="alert"',
  '不能为空',
]);

interface Row {
  id: string;
  name: string;
  status: string;
}

const columns = [
  { key: 'name', title: '名称', render: (row: Row) => row.name, width: 200 },
  { key: 'status', title: '状态', render: (row: Row) => row.status, align: 'center' as const },
];
const rows: Row[] = [
  { id: 'a', name: 'Alpha', status: '待办' },
  { id: 'b', name: 'Beta', status: '完成' },
];

const table = renderToStaticMarkup(
  <Table
    ariaLabel="任务列表"
    columns={columns}
    rows={rows}
    rowKey={(row) => row.id}
    selectedKey="b"
    onRowClick={() => undefined}
  />,
);
expectIncludes('Table selected', table, [
  'aria-label="任务列表"',
  'scope="col"',
  'data-selected="true"',
  'aria-selected="true"',
  'data-clickable="true"',
  'Beta',
]);

const loadingTable = renderToStaticMarkup(
  <Table ariaLabel="加载中列表" columns={columns} rows={rows} rowKey={(row) => row.id} loading loadingRows={2} />,
);
expectIncludes('Table loading', loadingTable, ['aria-busy="true"', 'mt-table__skeleton']);
const skeletonCount = [...loadingTable.matchAll(/mt-table__skeleton/g)].length;
if (skeletonCount !== 4) failures.push(`Table loading 骨架数应为 4，实际 ${skeletonCount}`);

const emptyTable = renderToStaticMarkup(
  <Table ariaLabel="空列表" columns={columns} rows={[]} rowKey={(row) => row.id} emptyText="还没有任务" />,
);
expectIncludes('Table empty', emptyTable, ['mt-table__empty', '还没有任务']);

const summary = {
  buttonLoadingBytes: button.length,
  iconButtonBytes: iconButton.length,
  cardCompositionBytes: card.length,
  emptyStateBytes: emptyState.length,
  inputErrorBytes: input.length,
  tableSelectedBytes: table.length,
  tableLoadingSkeletons: skeletonCount,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} 项`);
  process.exit(1);
}
console.log('\nPASS: T06287 8 个原语 SSR 渲染与状态映射通过。');
