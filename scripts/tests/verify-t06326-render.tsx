/**
 * T06326 SSR 渲染门禁：验证 13 个新原语在 react-dom/server 下不触碰 document/window，
 * 且关键状态映射到 DOM。用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t06326-render.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Checkbox,
  Dialog,
  Drawer,
  ErrorState,
  Panel,
  Popover,
  Radio,
  Select,
  Switch,
  Tabs,
  Toast,
  ToastProvider,
  Toolbar,
  Tooltip,
} from '../../web/src/ui/components/index.ts';

const failures: string[] = [];
function expectIncludes(label: string, html: string, markers: string[]) {
  for (const marker of markers) {
    if (!html.includes(marker)) failures.push(`${label} 缺少 ${marker}`);
  }
}
function expectEqual(label: string, actual: string, expected: string) {
  if (actual !== expected) failures.push(`${label} 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
}

const select = renderToStaticMarkup(
  <Select
    label="优先级"
    hint="用于排序"
    error="请选择优先级"
    placeholder="请选择"
    defaultValue="normal"
    options={[
      { value: 'high', label: '高' },
      { value: 'normal', label: '普通' },
    ]}
  />,
);
expectIncludes('Select error', select, [
  'mt-field__label', 'mt-select__control', 'aria-invalid="true"',
  'aria-describedby=', '-hint', '-error', 'role="alert"', '请选择优先级',
]);

const checkbox = renderToStaticMarkup(
  <Checkbox label="全选" hint="选择当前页" indeterminate />,
);
expectIncludes('Checkbox', checkbox, [
  'mt-choice__box', 'mt-choice__input', 'type="checkbox"',
  'aria-describedby=', '-hint', 'mt-choice__label', '全选',
]);

const radio = renderToStaticMarkup(
  <Radio name="scope" value="all" label="全部" defaultChecked />,
);
expectIncludes('Radio', radio, [
  'mt-radio', 'type="radio"', 'name="scope"', 'checked=""', 'mt-radio__mark', '全部',
]);

const switchMarkup = renderToStaticMarkup(
  <Switch label="自动派发" defaultChecked hint="开启后自动领取" />,
);
expectIncludes('Switch', switchMarkup, [
  'role="switch"', 'aria-checked="true"', 'mt-switch__track',
  'mt-switch__thumb', 'aria-describedby=', '自动派发',
]);

const tabs = renderToStaticMarkup(
  <Tabs
    ariaLabel="视图"
    defaultValue="board"
    items={[
      { key: 'list', label: '列表', content: <span>列表内容</span> },
      { key: 'board', label: '看板', content: <span>看板内容</span> },
    ]}
  />,
);
expectIncludes('Tabs', tabs, [
  'role="tablist"', 'aria-label="视图"', 'role="tab"', 'aria-selected="true"',
  'aria-controls=', 'role="tabpanel"', '看板内容',
]);

const popover = renderToStaticMarkup(
  <Popover trigger={<span>更多</span>} triggerLabel="更多操作" defaultOpen placement="bottom-end" label="操作菜单">
    <button type="button">归档</button>
  </Popover>,
);
expectIncludes('Popover', popover, [
  'aria-haspopup="dialog"', 'aria-expanded="true"', 'aria-controls=',
  'role="dialog"', 'aria-label="操作菜单"', 'mt-popover__panel', '归档',
]);

const tooltip = renderToStaticMarkup(
  <Tooltip content="按 Ctrl+K 打开" open placement="bottom">
    <span>命令面板</span>
  </Tooltip>,
);
expectIncludes('Tooltip', tooltip, [
  'role="tooltip"', 'mt-tooltip__bubble', 'aria-describedby=', '按 Ctrl+K 打开',
]);

const toast = renderToStaticMarkup(
  <Toast tone="danger" title="保存失败" description="网络超时" action={{ label: '重试', onClick: () => undefined }} onClose={() => undefined} />,
);
expectIncludes('Toast danger', toast, [
  'mt-toast', 'data-tone="danger"', 'role="alert"', 'mt-toast__title',
  'mt-toast__desc', 'mt-toast__action', 'aria-label="关闭通知"', '重试',
]);

const toastProvider = renderToStaticMarkup(
  <ToastProvider><span>页面内容</span></ToastProvider>,
);
expectIncludes('ToastProvider SSR', toastProvider, ['页面内容']);

const errorState = renderToStaticMarkup(
  <ErrorState title="任务加载失败" message="请稍后重试" details="HTTP 500" retry={{ onClick: () => undefined }} />,
);
expectIncludes('ErrorState', errorState, [
  'mt-error-state', 'role="alert"', 'mt-error-state__icon', 'mt-error-state__title',
  'mt-error-state__message', 'mt-error-state__details', 'mt-error-state__action', '重试',
]);

const toolbar = renderToStaticMarkup(
  <Toolbar ariaLabel="任务工具条" start={<span>左</span>} end={<button type="button">右</button>}>
    <span>中间</span>
  </Toolbar>,
);
expectIncludes('Toolbar', toolbar, [
  'role="toolbar"', 'aria-label="任务工具条"', 'mt-toolbar__start',
  'mt-toolbar__end', 'mt-toolbar__main', '中间',
]);

const panel = renderToStaticMarkup(
  <Panel title="执行记录" subtitle="最近 24 小时" extra={<span>3</span>} footer={<button type="button">查看全部</button>} collapsible defaultCollapsed={false}>
    <span>记录内容</span>
  </Panel>,
);
expectIncludes('Panel', panel, [
  'mt-panel', 'mt-panel__head', 'mt-panel__title', 'mt-panel__subtitle',
  'mt-panel__extra', 'aria-expanded="true"', 'aria-controls=', 'mt-panel__body',
  'mt-panel__foot', '记录内容',
]);

// 模态层依赖 document，SSR 必须安全返回空串，不能抛错。
expectEqual('Dialog SSR 安全', renderToStaticMarkup(
  <Dialog open onClose={() => undefined} title="确认删除"><span>内容</span></Dialog>,
), '');
expectEqual('Drawer SSR 安全', renderToStaticMarkup(
  <Drawer open onClose={() => undefined} title="详情"><span>内容</span></Drawer>,
), '');

if (failures.length) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  console.error(`\n${failures.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log('[PASS] T06326 SSR 渲染门禁：13 个原语 14 组断言全通过');
}
