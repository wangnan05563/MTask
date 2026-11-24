/**
 * T06291 组件视觉回归画廊：用 react-dom/server 渲染 design system 原语，
 * 输出静态 HTML 片段，供 verify-t06291-visual.mjs 注入三主题页面。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/tests/t06291-gallery.mts <out-file>
 */
import { writeFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, Button, Card, EmptyState, Input, Skeleton, Table } from '../../web/src/ui/components/index.ts';

type Row = { id: string; name: string; status: string; owner: string };
const rows: Row[] = [
  { id: 'T06290', name: '硬编码色迁移', status: '已完成', owner: 'Doubao' },
  { id: 'T06291', name: '组件视觉回归', status: '进行中', owner: 'Doubao' },
  { id: 'T06292', name: '视觉降噪走查', status: '待开始', owner: '未分配' },
];
const columns = [
  { key: 'name', title: '任务', render: (row: Row) => row.name },
  { key: 'status', title: '状态', render: (row: Row) => row.status },
  { key: 'owner', title: '负责人', render: (row: Row) => row.owner },
];

const body = renderToStaticMarkup(
  <main className="t06291-gallery" data-testid="t06291-gallery">
    <header className="t06291-gallery__head">
      <h1>Design System 视觉回归画廊</h1>
      <p>按钮 / 输入 / 徽标 / 卡片 / 表格 / 空态，三主题共用同一组 Token。</p>
    </header>

    <section className="t06291-gallery__section" data-gallery-section="button">
      <h2>Button</h2>
      <div className="t06291-gallery__row">
        <Button variant="primary">主操作</Button>
        <Button variant="secondary">次操作</Button>
        <Button variant="ghost">幽灵按钮</Button>
        <Button variant="danger">危险操作</Button>
        <Button variant="primary" loading loadingText="保存中">保存</Button>
      </div>
    </section>

    <section className="t06291-gallery__section" data-gallery-section="input">
      <h2>Input</h2>
      <div className="t06291-gallery__grid2">
        <Input label="任务名称" hint="用于列表展示" defaultValue="组件视觉回归" />
        <Input label="任务名称" error="不能为空" defaultValue="" />
      </div>
    </section>

    <section className="t06291-gallery__section" data-gallery-section="badge">
      <h2>Badge</h2>
      <div className="t06291-gallery__row">
        <Badge tone="neutral">中性</Badge>
        <Badge tone="accent">强调</Badge>
        <Badge tone="success" dot>通过</Badge>
        <Badge tone="warning" dot>待复核</Badge>
        <Badge tone="danger" dot>阻塞</Badge>
      </div>
    </section>

    <section className="t06291-gallery__section" data-gallery-section="card">
      <h2>Card</h2>
      <Card title="最近任务" extra={<Badge tone="accent">3</Badge>}>
        <p className="t06291-gallery__body">卡片承载标题、额外操作位与内容；颜色全部来自 semantic / component Token。</p>
      </Card>
    </section>

    <section className="t06291-gallery__section" data-gallery-section="table">
      <h2>Table</h2>
      <Table ariaLabel="最近任务" columns={columns} rows={rows} rowKey={(row) => row.id} selectedKey="T06291" density="compact" />
    </section>

    <section className="t06291-gallery__section" data-gallery-section="empty">
      <h2>EmptyState / Skeleton</h2>
      <EmptyState title="还没有任务" hint="创建第一条任务后开始" action={{ label: '新建任务', onClick: () => undefined }} />
      <div className="t06291-gallery__skeleton">
        <Skeleton width={180} height={8} />
        <Skeleton width={120} height={8} />
      </div>
    </section>
  </main>,
);

writeFileSync(process.argv[2], body, 'utf8');
console.log(`[t06291-gallery] bytes=${Buffer.byteLength(body)} out=${process.argv[2]}`);
