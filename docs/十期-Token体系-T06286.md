# 十期 Token 体系设计交付（T06286）

- 任务：T06286「[PRD] 设计 Token 体系」
- 日期：2026-11-23
- 结论：**Token 变量文件、三套预设主题、主题专用 Token、使用文档与自动门禁已完成；旧代码未改动。**
- 注意：任务卡验收项写 AC-04，需求矩阵实际锚定 **AC-34《验收标准：硬编码检查》**。本任务只交付设计底座，**AC-04/AC-34 的“核心页 0 硬编码色”尚未闭合**，需由 T06290（迁移 codemod）与 T06287（组件库接入）承接。

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `web/src/theme/tokens.css` | primitive / semantic / component 三层 Token，light / dark / high-contrast 三套主题 |
| `scripts/verify-t06286-tokens.mjs` | 结构、命名、主题一致性、component 隔离、对比度与硬编码基线门禁 |
| `docs/十期-Token体系-T06286.md` | 本设计说明、使用规则、迁移映射与验收边界 |

本文件是**独立设计底座**，当前未被 `main.tsx` 引入，不改变任何现有页面样式；删除该文件即可回滚。

## 2. 三层 Token 结构

| 层 | 前缀 | 数量 | 职责 |
| --- | --- | --- | --- |
| primitive | `--mt-primitive-*` | 80 | 原始色阶，只允许 semantic 层引用，页面禁止直接用 |
| semantic | `--mt-semantic-*` | 每套主题 49 | 表达 bg / text / border / status / chart / diff / gantt / canvas 的语义 |
| component | `--mt-component-*` | 37 | 按钮、输入框、卡片、表格、导航、Toast、抽屉、标签与焦点环 |

命名规则统一为 `--mt-{category}-{role}-{state}`。组件颜色 Token 只允许引用 `--mt-semantic-*`，不得越过 semantic 直接引用 primitive。

**分层引用链：**

```text
primitive（原始值）
  → semantic（主题语义，随 data-theme 切换）
    → component（组件角色，跟随 semantic 自动换肤）
      → 页面 / 组件使用
```

## 3. 三套预设主题

通过 `data-theme` 切换：`light`、`dark`、`high-contrast`。三套主题的 semantic 键集合完全一致，页面只写 semantic/component Token 即可自动换肤。

| 语义 | light | dark | high-contrast |
| --- | --- | --- | --- |
| 画布 `bg-canvas` | `#ffffff` | `#18181b` | `#000000` |
| 表面 `bg-surface` | `#f9fafb` | `#1e1e21` | `#000000` |
| 正文 `text-primary` | `#1f2937` | `#e5e7eb` | `#ffffff` |
| 弱文本 `text-muted` | `#646a75` | `#94949c` | `#e6e6e6` |
| 边框 `border-default` | `#e5e7eb` | `#3f3f46` | `#ffffff` |
| 强调 `accent-primary` | `#2563eb` | `#5b9bf8` | `#ffff00` |
| 成功 `status-success-fg` | `#15803d` | `#22c55e` | `#00ff66` |
| 危险 `status-danger-fg` | `#c81e1e` | `#f87171` | `#ff4d4d` |
| 警告 `status-warn-fg` | `#92400e` | `#fbbf24` | `#ffff00` |
| 信息 `status-info-fg` | `#2563eb` | `#60a5fa` | `#66ccff` |

高对比主题采用纯黑底、纯白正文、黄色焦点与高饱和状态色，适配系统高对比模式；后续接入系统 `prefers-contrast` 由设置/原生壳任务处理。

## 4. 图表、diff、甘特与画布 Token

- 图表：`--mt-semantic-chart-1` ~ `chart-8` 八色序列，加 `chart-grid` / `chart-axis` / `chart-label`，深浅主题各用一套明度适配色，避免把浅色主题的图表色直接搬到深色底。
- diff：`diff-add-bg/fg`、`diff-del-bg/fg`、`diff-ctx-bg/fg` 三组，正文对比度均 ≥ 5:1。
- 甘特：`gantt-bar-bg/fg`、`gantt-grid`，条形标签与底色对比度 5.17（light）/ 6.32（dark）/ 19.56（high-contrast）。
- 画布：`canvas-bg`、`canvas-node-bg`、`canvas-node-border`、`canvas-edge`，节点与连线在深色底上使用独立边框/连线色，不依赖卡片阴影。

## 5. 使用与迁移规则

**页面/组件使用：**

```css
/* 推荐：组件角色 */
background: var(--mt-component-card-bg);
color: var(--mt-semantic-text-primary);
border: 1px solid var(--mt-semantic-border-default);

/* 禁止：页面直接引用 primitive */
color: var(--mt-primitive-neutral-800); /* ✗ */
```

- 文本、背景、边框、状态优先用 semantic；按钮/输入框/卡片/表格等用 component。
- 图表库只接受 `--mt-semantic-chart-*`，不得在图表配置里写十六进制。
- 主题切换只改 `data-theme`，不通过 JS 改具体颜色。

**旧变量迁移映射（供 T06290 使用，本任务不执行）：**

| 旧变量 | 新 Token |
| --- | --- |
| `--app-bg` | `--mt-semantic-bg-canvas` |
| `--card-bg` | `--mt-component-card-bg` |
| `--surface` / `--surface-2` | `--mt-semantic-bg-surface` / `--mt-semantic-bg-subtle` |
| `--text` / `--text-secondary` / `--text-muted` | `--mt-semantic-text-primary` / `text-secondary` / `text-muted` |
| `--border` / `--border-strong` | `--mt-semantic-border-default` / `border-strong` |
| `--accent` / `--accent-ink` / `--accent-text` | `--mt-semantic-accent-primary` / `accent-on` / `accent-on` |
| `--accent-soft` | `--mt-semantic-accent-soft` |
| `--success` / `--danger` / `--warn` | `--mt-semantic-status-success-fg` / `danger-fg` / `warn-fg` |
| `--overlay` | `--mt-semantic-overlay` |
| `--diff-add-bg/text` | `--mt-semantic-diff-add-bg` / `diff-add-fg` |
| `--diff-del-bg/text` | `--mt-semantic-diff-del-bg` / `diff-del-fg` |
| `--diff-ctx-bg/text` | `--mt-semantic-diff-ctx-bg` / `diff-ctx-fg` |

`--code-bg`、`--code-border`、`--bar-sheen`、`--bar-grip` 等在迁移时按实际语义分别落到 `bg-subtle` / `border-default`，或由组件库新增组件级 Token；不要为了“全量替换”硬套不匹配的语义。

## 6. 验证证据

执行：

```powershell
cd D:\code\otherProjects\MTask
node scripts/verify-t06286-tokens.mjs
```

实测结果（2026-11-23，退出码 0）：

| 检查项 | 结果 |
| --- | --- |
| primitive Token | 80 |
| 每套主题 semantic Token | 49 |
| component Token | 37 |
| 主题数 | 3（light / dark / high-contrast） |
| 对比度检查 | 13 对 × 3 主题 = 39 项，全部 ≥ 4.5:1 |
| 最低对比度 | **5.02:1**（light `status-success-fg/bg-canvas`） |
| 三主题键集合一致性 | 通过 |
| component 绕过 semantic 直引 primitive | 0 |
| 页面直接引用 primitive | 0 |
| 旧代码硬编码色基线 | **313 处**（`web/src` 内 `#hex`，排除本 Token 文件） |
| 失败项 | 0 |

关键对比度实测：

| 主题 | 正文/画布 | 次正文/表面 | 弱文本/表面 | 强调文字/强调底 | 主题最低 |
| --- | --- | --- | --- | --- | --- |
| light | 14.68 | 7.23 | 5.21 | 5.17 | 5.02 |
| dark | 14.31 | 8.44 | 5.52 | 6.68 | 5.52 |
| high-contrast | 21.00 | 21.00 | 16.83 | 19.56 | 6.42 |

> 硬编码基线说明：PRD 正文估计“约 160 处”，本次按 `#hex` 字面量实测为 **313 处**（`web/src` 全部 `.ts/.tsx/.css`，排除 `tokens.css`）。两者口径不同，迁移应以脚本实测清单为准，不能按 160 处估算工作量。

## 7. 验收结论与未闭合项

**本任务已完成：**

- primitive / semantic / component 三层变量文件生成。
- light / dark / high-contrast 三套预设，三套 semantic 键完全一致。
- chart / diff / gantt / canvas 专用 Token 补齐。
- Token 文档包含用途、映射、对比度与使用禁令。
- 自动门禁可重复执行，结构/隔离/对比度全部通过。

**未闭合、不能虚假声明通过：**

1. **AC-04/AC-34“核心页 0 硬编码色”未通过**：实测仍有 313 处硬编码色。T06286 明确“不修改旧代码”，清零必须由 T06290 codemod + T06287 组件库接入完成，再由 T06291 做视觉回归。不能因为 Token 文件通过门禁就把 AC-34 标成通过。
2. **三套 vs PRD D1 六套**：本任务按任务卡交付三套；D1 的 6 套映射中剩余预设属于主题包/设置后续任务，不在本单扩张。
3. **视觉一致性未验证**：当前 Token 文件未接入页面，尚未做三主题逐页像素比对；接入后由 T06291 执行。
4. **旧代码零改动**：`settings.tsx` / `index.html` 的旧变量与硬编码色均未改，避免与 T06287/T06290 冲突。

## 8. 复现与回滚

```powershell
# 验证（退出码 0 即通过）
node scripts/verify-t06286-tokens.mjs

# 查看对比度明细
node scripts/verify-t06286-tokens.mjs --details
```

回滚：删除 `web/src/theme/tokens.css` 即可；该文件未被应用入口引用，不影响构建与运行时。
