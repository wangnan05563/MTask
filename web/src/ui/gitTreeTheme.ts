/**
 * T05210：IDEA 风格 Git 视图的 **Design Tokens 与仓库色映射**（单源）。
 *
 * 为什么单独成模块：需求要求「左栏仓库色 = 右栏文件树节点色」（left-to-right mapping），
 * 这条映射一旦散在两侧 JSX 里，改一处忘另一处就会出现「左边紫、右边橙」的静默错位。
 * 这里把 ① 尺寸/字号 token、② 仓库色索引、③ 状态色 三件事收在一处，两侧都只消费。
 *
 * 配色取自 JetBrains New UI 的 Git 视图观感（低饱和、行高紧凑、选中态偏蓝灰），
 * 但**全部走 CSS 变量**并按 `[data-theme]` 分浅/深两套：
 *  - 需求要求「对比度足够」，同一串 hex 不可能同时在 #fff 与 #1e1e1e 上都达标，
 *    所以浅色用 600/700 级、深色用 300/400 级，两套都是 WCAG AA（≥4.5:1）量级；
 *  - 主题由 `settings.tsx` 强制解析成 `light|dark` 写进 `document.dataset.theme`（跟随系统也解析），
 *    因此 `[data-theme='dark']` 一定命中，不依赖 `prefers-color-scheme`。
 */

/** 行高：22px 是 IDEA 表格行的观感（也是虚拟滚动切片的基准，必须与 CSS 里用的一致） */
export const GIT_TREE_ROW_H = 22;
/** 每层缩进：IDEA 的树缩进比正文窄一档 */
export const GIT_TREE_INDENT = 11;
/** 仓库色板容量：超过这个数量的仓库会按序复用颜色（下面 `repoColorMap` 会显式告知是否复用） */
export const REPO_COLOR_COUNT = 8;

/**
 * 仓库色索引：把「当前视图里出现过的仓库」排成稳定序，逐个取色。
 *
 * 为什么不按字符串 hash 直接取模：hash 撞色在小集合上非常常见（8 个仓库里 2 个同色 = 视图中
 * 「用颜色区分仓库」直接失效），而按集合排序取色在当前视图内**保证两两不同**。
 * 稳定性来自排序（`repoSub` 字典序），同一批仓库在任何一侧算出来的索引都一样。
 */
export function repoColorMap(repoKeys: readonly string[]): { index: Record<string, number>; reused: boolean } {
  const uniq = [...new Set(repoKeys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index: Record<string, number> = {};
  uniq.forEach((key, i) => { index[key] = i % REPO_COLOR_COUNT; });
  return { index, reused: uniq.length > REPO_COLOR_COUNT };
}

/** 仓库色 CSS 变量名（左栏竖条/圆点、右栏树节点、分组头共用同一个） */
export function repoColorVar(index: number | undefined): string {
  if (index === undefined || index < 0) return 'var(--gt-repo-none)';
  return `var(--gt-repo-${index % REPO_COLOR_COUNT})`;
}

/**
 * 注入用的样式块：变量 + 少量只能用选择器表达的交互态（hover/selected/滚动条）。
 *
 * 放在组件内部的 `<style>` 里而不是全局 `settings.tsx`：这组 token 只服务本弹窗，
 * 变量名统一加 `--gt-` 前缀，既不会污染其它页面，也避免为一个弹窗去改全局主题文件。
 */
export const GIT_TREE_STYLE = `
:root, [data-theme='light'] {
  --gt-repo-none: #94a3b8;
  --gt-repo-0: #6d28d9;
  --gt-repo-1: #0f766e;
  --gt-repo-2: #b45309;
  --gt-repo-3: #1d4ed8;
  --gt-repo-4: #be123c;
  --gt-repo-5: #4d7c0f;
  --gt-repo-6: #a21caf;
  --gt-repo-7: #475569;
  --gt-status-add: #1a7f37;
  --gt-status-del: #cf222e;
  --gt-status-mod: #9a6700;
  --gt-status-ren: #0969da;
  --gt-row-hover: rgba(15, 23, 42, 0.045);
  --gt-row-selected: #e2ebf7;
  --gt-guide: rgba(100, 116, 139, 0.35);
  --gt-panel-bg: #ffffff;
  --gt-panel-head: #f6f8fa;
}
[data-theme='dark'] {
  --gt-repo-none: #94a3b8;
  --gt-repo-0: #a78bfa;
  --gt-repo-1: #5eead4;
  --gt-repo-2: #fcd34d;
  --gt-repo-3: #93c5fd;
  --gt-repo-4: #fda4af;
  --gt-repo-5: #bef264;
  --gt-repo-6: #f0abfc;
  --gt-repo-7: #cbd5e1;
  --gt-status-add: #3fb950;
  --gt-status-del: #f85149;
  --gt-status-mod: #d29922;
  --gt-status-ren: #58a6ff;
  --gt-row-hover: rgba(255, 255, 255, 0.06);
  --gt-row-selected: #2b3a4d;
  --gt-guide: rgba(148, 163, 184, 0.3);
  --gt-panel-bg: #1f2328;
  --gt-panel-head: #22272e;
}
.gt-tree {
  --gt-row-h: ${GIT_TREE_ROW_H}px;
  --gt-indent: ${GIT_TREE_INDENT}px;
}
.gt-row { height: var(--gt-row-h); }
.gt-row:hover { background: var(--gt-row-hover); }
/* T05690：悬停记录不应用任何倾斜/旋转动画（全站按钮的 rotate(8deg) 不能漏进记录行） */
.gt-row:hover, .gt-row:hover * { transform: none !important; }
.gt-row[data-active='1'] { background: var(--gt-row-selected); }
.gt-tree-scroll { scrollbar-width: thin; }
.gt-tree-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.gt-tree-scroll::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
.gt-file-path { direction: ltr; unicode-bidi: plaintext; }
`;

/**
 * 状态字母的单元格宽度固定：`M`/`A`/`D` 同宽才不会让文件名左右跳动（IDEA 也是等宽对齐）。
 * 用 mono 字体 + 固定宽度，避免不同系统字体度量差异。
 */
export const GT_STATUS_WIDTH = 14;
