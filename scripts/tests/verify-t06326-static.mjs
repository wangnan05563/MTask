/**
 * T06326 C6 剩余 13 个原语静态门禁：
 * ① 文件与统一出口齐全；
 * ② 新代码不出现十六进制色值与 --mt-primitive-* 直引；
 * ③ 关键可访问性属性/交互状态存在；
 * ④ components.css 具备各原语基础选择器与 focus/disabled 状态。
 * 用法：node scripts/tests/verify-t06326-static.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/code/otherProjects/MTask';
const UI = join(ROOT, 'web/src/ui/components');
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
};

const components = [
  'Select', 'Checkbox', 'Radio', 'Switch', 'Dialog', 'Drawer', 'Popover',
  'Tooltip', 'Tabs', 'Toast', 'ErrorState', 'Toolbar', 'Panel',
];
const files = components.map((name) => join(UI, `${name}.tsx`));
say('T06326-01 13 个原语文件齐全', files.every((file) => existsSync(file)), { missing: files.filter((f) => !existsSync(f)) });

const index = readFileSync(join(UI, 'index.ts'), 'utf8');
const missingExports = components.filter((name) => !new RegExp(`export \\{[^}]*${name}`, 'm').test(index));
say('T06326-02 统一出口导出全部 13 个原语', missingExports.length === 0, { missingExports });

const newSources = [...files, join(UI, 'modalLayer.ts'), join(ROOT, 'web/src/ui/components.css')];
const hexHits = [];
const primitiveHits = [];
const rgbaHits = [];
for (const file of newSources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) hexHits.push(`${file}:${match[0]}`);
  for (const match of text.matchAll(/--mt-primitive-/g)) primitiveHits.push(`${file}:${match[0]}`);
  for (const match of text.matchAll(/rgba?\s*\(/g)) rgbaHits.push(`${file}:${match[0]}`);
}
say('T06326-03 新代码零十六进制色值', hexHits.length === 0, { hexHits });
say('T06326-04 新代码零 primitive Token 直引', primitiveHits.length === 0, { primitiveHits });
say('T06326-05 新代码零 rgba 硬编码颜色', rgbaHits.length === 0, { rgbaHits });

const read = (name) => readFileSync(join(UI, `${name}.tsx`), 'utf8');
const ariaGates = [
  ['Select 表单错误语义', 'Select', ['aria-describedby', 'aria-errormessage', 'aria-invalid', 'role="alert"']],
  ['Checkbox indeterminate 与错误语义', 'Checkbox', ['indeterminate', 'aria-describedby', 'aria-invalid']],
  ['Radio 原生 radio 与错误语义', 'Radio', ['type="radio"', 'aria-describedby', 'aria-invalid']],
  ['Switch role/aria-checked', 'Switch', ['role="switch"', 'aria-checked', 'aria-describedby']],
  ['Dialog 模态语义与焦点行为', 'Dialog', ['role="dialog"', 'aria-modal="true"', 'aria-labelledby', 'useModalLayer', 'createPortal']],
  ['Drawer 模态语义与左右侧', 'Drawer', ['role="dialog"', 'aria-modal="true"', 'data-side', 'useModalLayer']],
  ['Popover 触发器与关闭行为', 'Popover', ['aria-haspopup="dialog"', 'aria-expanded', 'aria-controls', 'pointerdown', 'useEscapeLayer', 'closeFromEsc', 'focusTrigger']],
  ['Tooltip role/描述关联', 'Tooltip', ['role="tooltip"', 'aria-describedby', 'onMouseEnter', 'onFocusCapture']],
  ['Tabs 方向键与 aria-selected', 'Tabs', ['role="tablist"', 'role="tab"', 'aria-selected', 'ArrowRight', 'Home', 'End', 'role="tabpanel"']],
  ['Toast live/alert 与关闭', 'Toast', ['aria-live="polite"', "'danger' ? 'alert' : 'status'", 'aria-label="关闭通知"', 'useToast']],
  ['ErrorState role=alert 与重试', 'ErrorState', ['role="alert"', 'retry', 'Button']],
  ['Toolbar role=toolbar 三槽位', 'Toolbar', ['role="toolbar"', 'mt-toolbar__start', 'mt-toolbar__center', 'mt-toolbar__end']],
  ['Panel 折叠与 aria-expanded', 'Panel', ['aria-expanded', 'aria-controls', 'defaultCollapsed', 'mt-panel__foot']],
];
const ariaFailures = [];
for (const [label, name, markers] of ariaGates) {
  const text = read(name);
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length) ariaFailures.push({ label, missing });
}
say('T06326-06 13 个原语关键可访问性/交互标记齐全', ariaFailures.length === 0, { ariaFailures });

const modalLayer = readFileSync(join(UI, 'modalLayer.ts'), 'utf8');
const modalGates = [
  'modalStack',
  'modalStack[modalStack.length - 1] !== id',
  'escapeStack',
  'escapeStack[escapeStack.length - 1]',
  'useEscapeLayer',
  'ensureEscapeListener',
  'enabledRef.current',
  'event.stopPropagation()',
  'event.stopImmediatePropagation()',
  'focusableIn',
  "node.closest('[inert]')",
  "node.closest('[aria-hidden=\"true\"]')",
  'node.getClientRects().length > 0',
  "body.style.overflow = 'hidden'",
  "root.setAttribute('inert', '')",
  "root.setAttribute('aria-hidden', 'true')",
  'modalStack.lastIndexOf(id)',
  'trapTab(event, panel)',
];
const missingModalGates = modalGates.filter((marker) => !modalLayer.includes(marker));
say('T06326-09 模态层 Esc 栈/滚动锁/背景 inert/焦点拉回齐全', missingModalGates.length === 0, { missingModalGates });

const toastSource = read('Toast');
const toastTimerManaged = toastSource.includes('单一 timer 管理点')
  && toastSource.includes('timers.current.has(item.id)')
  && !toastSource.includes('keptIds');
say('T06326-11 Toast timer 由 items effect 单点管理', toastTimerManaged, {
  hasEffectMarker: toastSource.includes('单一 timer 管理点'),
  hasTimerDedup: toastSource.includes('timers.current.has(item.id)'),
  legacyUpdaterCleanup: toastSource.includes('keptIds'),
});

const dialogsSource = readFileSync(join(ROOT, 'web/src/ui/dialogs.tsx'), 'utf8');
const dialogEscapeLayers = (dialogsSource.match(/useEscapeLayer\(true, true,/g) ?? []).length;
const legacyDialogKeydown = /(globalThis|document)\.addEventListener\('keydown'/.test(dialogsSource);
say('T06326-12 四个 Promise 弹窗全部接入统一 Esc 栈', dialogEscapeLayers >= 4 && !legacyDialogKeydown, {
  dialogEscapeLayers,
  legacyDialogKeydown,
});

const css = readFileSync(join(ROOT, 'web/src/ui/components.css'), 'utf8');
const tabsOverflowReady = /\.mt-tabs__list\s*\{[^}]*overflow-x:\s*auto/.test(css)
  && /\.mt-tabs__tab\s*\{[^}]*flex:\s*0 0 auto/.test(css);
say('T06326-10 Tabs 窄屏横向滚动且 tab 不压缩', tabsOverflowReady, {});

const cssSelectors = [
  '.mt-select__control', '.mt-choice__mark', '.mt-radio__mark', '.mt-switch__track',
  '.mt-overlay', '.mt-dialog', '.mt-drawer', '.mt-popover__panel', '.mt-tooltip__bubble',
  '.mt-tabs__list', '.mt-toast-viewport', '.mt-error-state', '.mt-toolbar', '.mt-panel',
];
const missingCss = cssSelectors.filter((selector) => !css.includes(selector));
say('T06326-07 components.css 覆盖 13 个原语基础选择器', missingCss.length === 0, { missingCss });
const stateGates = [
  ['.mt-select__input:disabled', 'Select disabled'],
  ['.mt-choice__input:focus-visible', 'Checkbox/Radio focus'],
  ['.mt-choice__input:checked', 'Checkbox/Radio checked'],
  ['.mt-switch__control[aria-checked=', 'Switch checked'],
  ['.mt-dialog:focus', 'Dialog focus'],
  ['.mt-popover__trigger:focus-visible', 'Popover focus'],
  ['.mt-tabs__tab:disabled', 'Tabs disabled'],
  ['.mt-toast[data-tone=', 'Toast tone'],
  ['.mt-toolbar[data-wrap=', 'Toolbar wrap'],
  ['.mt-panel[data-padding=', 'Panel padding'],
];
const missingStates = stateGates.filter(([selector]) => !css.includes(selector)).map(([, label]) => label);
say('T06326-08 状态矩阵选择器齐全', missingStates.length === 0, { missingStates });

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} PASS`);
if (passed !== checks.length) process.exitCode = 1;
