/**
 * T05712 门 A（源码锚）：任务标题下方工具栏低频功能「...」下拉归集。
 *
 * 现场（工单）：7 项低频功能（创建子任务 / 文件导出 / 字体颜色 / 搁置 /
 * 分类建议 / 修改处理结果 / 复用此任务）原以独立按钮平铺在任务标题下方工具栏，
 * 要求收敛进「...」下拉；主工具栏只留高频操作；迁移后回调 / 参数 / 禁用 /
 * 显隐口径不得改变；旧版本或离线时菜单仍可展示静态选项；窄屏不溢出。
 *
 * 本门只做源码级静态断言（无需启动服务），真机交互路径见
 * verify-t05712-more-menu-ui.mjs。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05712-more-menu.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'web/src/pages/TasksPage.tsx'), 'utf8');
const MENU = readFileSync(join(ROOT, 'web/src/ui/TaskMoreMenu.tsx'), 'utf8');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

// 工具栏函数体：从 renderTaskMetaRow 定义起，到下一个函数定义止（限定作用域，避免误命中页面别处同名 token）
const META_START = SRC.indexOf('function renderTaskMetaRow(');
const META_END = SRC.indexOf('function renderVerifyButton(', META_START);
const META = SRC.slice(META_START, META_END);
const ITEMS_START = SRC.indexOf('const moreItems: TaskMoreMenuItem[]', META_START);
const ITEMS_END = SRC.indexOf('    return (', ITEMS_START);
const ITEMS = SRC.slice(ITEMS_START, ITEMS_END);
// 工具栏 JSX（moreItems 之后）：只取直接渲染的按钮，用于「7 项不再独立显示」判定
const JSX = SRC.slice(ITEMS_END, META_END);

// ---------- A 组：归集事实 ----------
ok('A-01 工具栏引入 TaskMoreMenu 单触发器（7 项不再平铺）',
  /<TaskMoreMenu items=\{moreItems\} taskTitle=\{t\.title\} \/>/.test(META));
ok('A-02 组件从 ../ui/TaskMoreMenu 引入并带类型',
  /import \{ TaskMoreMenu, type TaskMoreMenuItem \} from '\.\.\/ui\/TaskMoreMenu'/.test(SRC));
ok('A-03 moreItems 恰好 7 项，键与工单一一对应',
  ['subtask', 'export', 'font-color', 'shelve', 'suggest', 'result', 'reuse']
    .every((k) => ITEMS.includes(`key: '${k}'`)) &&
  (ITEMS.match(/key: '/g) ?? []).length === 7,
  { keys: [...ITEMS.matchAll(/key: '([^']+)'/g)].map((m) => m[1]) });

// 7 个独立按钮的 aria-label 不再出现在工具栏 JSX（但保留在菜单项定义里）
const movedAria = [
  '创建子任务',
  '文件导出：',
  '复用此任务：将该任务复制到其他项目或资产页',
  '恢复任务',
  '获取该任务的分类与优先级建议',
];
ok('A-04 主工具栏 JSX 不再直接渲染这 7 个独立按钮',
  movedAria.every((a) => !JSX.includes(`aria-label="${a}"`)) &&
  !JSX.includes('aria-label={resultBtnLbl.aria}') &&
  !JSX.includes('aria-label={t.shelved ?') &&
  !JSX.includes('<FontColorButton'),
  { leftovers: movedAria.filter((a) => JSX.includes(`aria-label="${a}"`)) });
ok('A-05 高频操作仍保留在主工具栏（复制 / 描述 / 归档 / AI 美化与重命名 / 优先级与分类）',
  /aria-label="复制：复制该任务内容到剪贴板"/.test(JSX) &&
  /aria-label=\{descEditing \? '收起描述' : '编辑该任务描述'\}/.test(JSX) &&
  /aria-label="归档：将该任务移入归档"/.test(JSX) &&
  /renderTitleActions\(t, titleEditing, true\)/.test(JSX) &&
  /aria-label="切换任务优先级"/.test(JSX) &&
  /aria-label="切换任务分类"/.test(JSX));
ok('A-06 工具栏无视觉断层：仍是 flex-end + gap 10 单行布局',
  /className="task-op task-toolbar"[^>]*justifyContent: 'flex-end', alignItems: 'center', gap: 10/.test(META));

// ---------- B 组：功能完整性（回调 / 参数 / 禁用 / 显隐逐项对齐迁移前） ----------
ok('B-01 创建子任务：回调 createSubTask(t) 与 title/aria 原样',
  /key: 'subtask'[\s\S]{0,220}onClick: \(\) => void createSubTask\(t\)/.test(ITEMS) &&
  ITEMS.includes("title: '创建子任务 — 在该任务下创建子任务（层级展示）'") &&
  ITEMS.includes("ariaLabel: '创建子任务'"));
ok('B-02 文件导出：仍用 getBoundingClientRect 定位三格式菜单，保留 exportBusy 禁用',
  /key: 'export'[\s\S]{0,400}disabled: exportBusy/.test(ITEMS) &&
  /setExportMenu\(\{ taskId: t\.id, x: r\.left, y: r\.bottom \+ 4 \}\)/.test(ITEMS) &&
  ITEMS.includes('ariaLabel: `文件导出：${t.title}`'));
ok('B-03 字体颜色：确认为文本属性设置，下拉内嵌原 FontColorButton 色板入口且 onApply 回调逐字保留',
  /trailing: <FontColorButton current=\{t\.color \?\? ''\}/.test(ITEMS) &&
  ITEMS.includes('void api.patch(`/tasks/${t.id}`, { color: c }).then(() => { flash(c ? \'字体颜色已应用\' : \'已恢复默认颜色\'); void loadTasks(activeProject); });') &&
  /key: 'font-color'[\s\S]{0,600}trailing: <FontColorButton/.test(ITEMS));
ok('B-04 搁置/恢复：动态文案 + 图标 + toggleShelve(t) 原样',
  /key: 'shelve'[\s\S]{0,400}onClick: \(\) => void toggleShelve\(t\)/.test(ITEMS) &&
  ITEMS.includes("label: t.shelved ? '恢复' : '搁置'") &&
  ITEMS.includes("ariaLabel: t.shelved ? '恢复任务' : '搁置任务'") &&
  ITEMS.includes("icon: t.shelved ? <RotateCcw size={14} /> : <CirclePause size={14} />"));
ok('B-05 分类建议：显隐/禁用/AI 不可用原因口径不变，且保留原 data-t03255 / data-t03257 回归锚',
  /key: 'suggest'[\s\S]{0,900}hidden: suggestEntry === 'hidden'/.test(ITEMS) &&
  ITEMS.includes("disabled: rowSuggestBusy === t.id || suggestEntry === 'disabled'") &&
  ITEMS.includes("dataAttrs: { 'data-t03255': 'row-trigger', 'data-t03257': suggestEntry }") &&
  ITEMS.includes('aiBlockedTitle(readiness,') &&
  ITEMS.includes('onClick: () => void suggestForTask(t)'));
ok('B-06 修改处理结果：编辑器展开/取消的完整逻辑原样搬移，title/aria 取同一 resultBtnLbl',
  /key: 'result'[\s\S]{0,700}title: resultBtnLbl\.title[\s\S]{0,120}ariaLabel: resultBtnLbl\.aria/.test(ITEMS) &&
  ITEMS.includes('startEditResult(t);') &&
  ITEMS.includes('if (!t.handle_result) setResultOpen((p) => ({ ...p, [t.id]: false }));'));
ok('B-07 复用此任务：弹窗预置状态与分类加载回调原样',
  /key: 'reuse'[\s\S]{0,500}setReuseOpen\(t\.id\); setReuseProjectId\(''\); setReuseSearch\(''\); setReuseCategoryId\(''\); void loadPromptCats\(\); void loadReqCats\(\);/.test(ITEMS));

// ---------- C 组：弹层健壮性（历史踩坑） ----------
ok('C-01 菜单 createPortal 挂 document.body（逃出 .task-toolbar overflow:hidden 与 .cv-auto paint containment）',
  /createPortal\(/.test(MENU) && /document\.body,/.test(MENU) && /position: 'fixed'/.test(MENU));
ok('C-02 外点收起放行触发按钮与 Portal 面板（否则 mousedown 先收起、菜单项 click 不触发）',
  /hostRef\.current\?\.contains\(target\) \|\| panelRef\.current\?\.contains\(target\)\) return;/.test(MENU));
ok('C-03 Esc 收起并把焦点还给触发按钮',
  /e\.key !== 'Escape'/.test(MENU) && /btnRef\.current\?\.focus\(\)/.test(MENU));
ok('C-03b 滚动 / resize 只重定位不关闭（修复：scrollIntoView、聚焦编辑器、展开色板都会触发 scroll，早版捕获阶段 close() 会误收起菜单导致点击失效）',
  /const reposition = \(\) => \{[\s\S]{0,140}place\(r\)/.test(MENU) &&
  /document\.addEventListener\('scroll', reposition, true\)/.test(MENU) &&
  /window\.addEventListener\('resize', reposition\)/.test(MENU) &&
  !/addEventListener\('scroll', onScroll/.test(MENU));
ok('C-04 接近视口底部向上弹（T00565 口径），左右钳制进视口避免窄屏溢出',
  /const up = r\.bottom \+ menuH \+ 8 > globalThis\.innerHeight/.test(MENU) &&
  /Math\.max\(8, Math\.min\(r\.right - MENU_W, globalThis\.innerWidth - MENU_W - 8\)\)/.test(MENU) &&
  /const place = \(r: DOMRect\)/.test(MENU) &&
  MENU.includes("maxWidth: 'calc(100vw - 16px)'") &&
  MENU.includes("maxHeight: 'calc(100vh - 16px)'"));
ok('C-05 色板为 absolute 向外展开，菜单只限高不建裁剪上下文（overflow:visible）',
  /maxHeight: 'calc\(100vh - 16px\)', overflow: 'visible'/.test(MENU) &&
  !/overflowY: 'auto'/.test(MENU));
ok('C-06 触发器 aria-haspopup=menu / aria-expanded，菜单 role=menu、项 role=menuitem',
  /aria-haspopup="menu"/.test(MENU) && /aria-expanded=\{open\}/.test(MENU) &&
  /role="menu"/.test(MENU) && /role="menuitem"/.test(MENU));

// ---------- D 组：兼容性 / 主题 / 视觉 ----------
ok('D-01 静态渲染：组件不发起任何网络请求（离线/旧版本仍展示 7 个静态选项）',
  !/\b(fetch|axios|api\.|XMLHttpRequest)\b/.test(MENU) &&
  /visible\.map\(/.test(MENU));
ok('D-02 下拉项保留原 aria-label / title / disabled（功能完整性与无障碍）',
  /aria-label=\{it\.ariaLabel \?\? it\.label\}/.test(MENU) &&
  /title=\{it\.title\}/.test(MENU) &&
  /disabled=\{it\.disabled\}/.test(MENU) &&
  /\{\.\.\.it\.dataAttrs\}/.test(MENU));
ok('D-03 菜单项点击先收起再执行原回调；禁用项不触发',
  /if \(it\.disabled\) return;[\s\S]{0,60}close\(\);[\s\S]{0,60}it\.onClick\?\.\(e\)/.test(MENU));
ok('D-04 视觉对齐参考图：左图标 + 文字左对齐、白底圆角卡片、细边框、轻阴影、统一行距',
  /background: 'var\(--card-bg\)'/.test(MENU) &&
  /border: '1px solid var\(--border-strong\)'/.test(MENU) &&
  /borderRadius: 8/.test(MENU) &&
  /boxShadow: '0 6px 18px rgba\(0,0,0,\.18\)'/.test(MENU) &&
  /alignItems: 'center', gap: 8/.test(MENU) &&
  /padding: '7px 10px', minHeight: ROW_H/.test(MENU) &&
  /textAlign: 'left'/.test(MENU));
ok('D-05 颜色全部取自主题变量，无硬编码色值（font-color 色板除外，沿用既有组件）',
  !/#[0-9a-fA-F]{3,8}\b/.test(MENU) &&
  /var\(--text\)/.test(MENU) && /var\(--text-muted\)/.test(MENU) &&
  /var\(--surface-2\)/.test(MENU) && /var\(--danger\)/.test(MENU));
ok('D-06 逐行 data-t05712 锚便于回归门定位（触发器 / 面板 / 每项）',
  /data-t05712="more-trigger"/.test(MENU) &&
  /data-t05712="more-menu"/.test(MENU) &&
  /data-t05712=\{`item-\$\{it\.key\}`\}/.test(MENU));

const outDir = join(ROOT, '.workbuddy');
mkdirSync(outDir, { recursive: true });
const summary = `T05712 门 A（源码锚）：${pass} 通过 / ${fail} 失败`;
lines.push('', summary);
writeFileSync(join(outDir, 't05712-gate-results.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
if (fail > 0) process.exit(1);
