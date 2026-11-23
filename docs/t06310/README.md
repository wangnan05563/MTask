# T06310 无障碍修复：焦点环、ARIA 与对比度

- 任务：T06310「[PRD] 无障碍修复」，priority urgent
- 关联需求：REQ-005「统一错误状态、可重试、键盘可达与对比度」；REQ-030「高对比度/色盲/密度，满足 AA」
- 范围：修复焦点环、ARIA 语义与颜色对比度缺陷；**不修改布局**
- 结论：浅色/深色两套主题、10 个关键路径，axe-core 4.10.2 WCAG 2 A/AA 均为 **0 个 serious/critical**；键盘焦点环 2px 且对比度 ≥3:1。

## 1. 根因（改造前基线扫描）

真实 Chrome + 生产构建 + 10 个关键路径扫描，共 14 条规则级 serious/critical（涉及 120 个 DOM 节点）：

| 缺陷 | 级别 | 命中点 | 根因 |
|---|---|---|---|
| `aria-allowed-attr` | critical | `HoverCard` 外层 `span[data-t03394="hover-trigger"]`，8 个页面 | 普通 `span` 上挂了 `aria-haspopup` / `aria-expanded`，这两个属性对 generic role 不允许 |
| `aria-prohibited-attr` | serious | 任务失败态 `.ai-failed-pulse`；执行会话 `PlatformLogo` 100 个节点 | 普通 `span` 只有 `aria-label`，没有可承载名称的语义 role |
| `scrollable-region-focusable` | serious | 概览「完成趋势」横向滚动容器 | 可横向滚动区域无法键盘聚焦，键盘用户看不到右侧内容 |
| `color-contrast` | serious | 计划页「已完成 29」小徽标 | `#15803d` 对 `#e3f4e9` 仅 4.39:1，低于小字号 4.5:1 |
| 焦点环对比不足 | serious | 左侧导航品牌标 `M` | 品牌标是实底蓝，全局蓝色 2px 焦点环叠在同色底上，对比度 1:1，键盘用户看不见焦点 |

基线日志：`evidence/a11y-baseline.log`。

## 2. 修复（绝对路径与改动点）

- `D:\code\otherProjects\MTask\web\src\ui\HoverCard.tsx`
  - 去掉外层普通 `span` 上的 `aria-haspopup` / `aria-expanded`；弹层本身仍是原生 `<dialog aria-label>`，打开时保留 `aria-describedby`。
- `D:\code\otherProjects\MTask\web\src\ui\PlatformLogo.tsx`
  - 平台图标 `span` 增加 `role="img"`，让 `aria-label="来源平台：…"` 合法承载；不改尺寸与颜色。
- `D:\code\otherProjects\MTask\web\src\pages\TasksPage.tsx`
  - AI 运行中/失败指示 `span` 增加 `role="img"`，保留原有 `aria-label` 与动画。
- `D:\code\otherProjects\MTask\web\src\pages\DashboardPage.tsx`
  - 「完成趋势」滚动容器增加 `role="region"`、`aria-label="完成趋势图表（可横向滚动）"`、`tabIndex={0}`；键盘可进入并横向滚动。
- `D:\code\otherProjects\MTask\web\src\settings.tsx`
  - 新增 `--success-strong`：浅色 `#0f6b32`、深色 `#6ee7a0`，专供小号成功徽标在 soft 底上使用。
- `D:\code\otherProjects\MTask\web\src\pages\PlanPage.tsx`
  - 两处「已完成 N」徽标文字改用 `var(--success-strong)`；底色、尺寸、间距不变。
- `D:\code\otherProjects\MTask\web\src\ui\nav\primaryNav.css`
  - `.mt-nav-mark:focus-visible`：2px 实底反色内环 + 4px 强调色外环；浅/深主题均 ≥3:1。
- `D:\code\otherProjects\MTask\scripts\tests\verify-t06310-a11y.mjs`（新增）
  - 生产 dist + 本地 API 代理 + 真实 Chrome CDP；10 个关键路径逐页 axe 扫描，输出违规、截图与焦点环探针。
- `D:\code\otherProjects\MTask\package.json`
  - 新增 `verify:t06310`。

## 3. 验证（实测证据）

| 验证 | 命令/条件 | 结果 |
|---|---|---|
| 基线扫描（修复前） | `node scripts/tests/verify-t06310-a11y.mjs` | 10 页共 **14 处 serious/critical**，见 `evidence/a11y-baseline.log` |
| 浅色主题复扫 | 同上，`T06310_THEME=light` | **15 PASS / 0 FAIL**，10 页 serious/critical **0** |
| 深色主题复扫 | `T06310_THEME=dark node scripts/tests/verify-t06310-a11y.mjs` | **16 PASS / 0 FAIL**（含主题应用断言），10 页 serious/critical **0** |
| 键盘焦点环 | 连按 Tab 进入主导航 | `mt-nav-mark` 焦点环 2px；浅色对比度 **5.21:1**，深色 **6.70:1** |
| Web 类型检查 | `tsc --noEmit -p web/tsconfig.json` | **exit 0** |
| 全站构建 | `npm --workspace web run build` | **exit 0**，Vite 产物生成 |
| axe 版本 | axe-core 4.10.2，`wcag2a` + `wcag2aa` | 覆盖首页/任务/计划/需求/报表/队列/执行会话/提示词/模型/设置 |

截图证据：

- `evidence/01-dashboard-light.png`：概览浅色，滚动图表可聚焦；
- `evidence/02-plan-light.png`：计划页成功徽标对比度修复；
- `evidence/03-exec-sessions-light.png`：执行会话平台图标语义修复；
- `evidence/04-dashboard-dark.png`、`05-exec-sessions-dark.png`：深色主题复扫。

## 4. 验证缺口与边界

- 不修改布局：仅增加 ARIA/role、焦点样式、颜色 token 与滚动区 `tabIndex`；未改宽高、间距、栅格。
- 高对比度主题（`[data-theme='high-contrast']`）已有 token 定义，但本次实测覆盖浅/深两套实际可选主题；高对比模式未在设置面板暴露，未纳入本轮自动化。
- 色盲模式未做独立色板模拟；本轮按 axe WCAG 2 A/AA 结构+对比度规则验证，色觉障碍专属模拟属后续增强。
