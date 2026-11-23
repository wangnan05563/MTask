# T06290 代码迁移工具：硬编码色 Lint 与语义 Token Codemod

- 任务：T06290「[PRD] 实现代码迁移工具」，priority urgent
- 关联需求：REQ-038；验收口径 AC-04「核心页面扫描 0 处硬编码色」
- 范围：核心页面内联样式与旧颜色变量的十六进制 fallback；**不改业务逻辑、不改布局、不改设计预设与数据可视化色板**
- 结论：核心 12 个页面/入口的硬编码 hex 从 **25 处降为 0**；`verify:t06290` 退出码 0；Web 类型检查与生产构建 exit 0。

## 1. 改造前基线

按与 Lint 相同的口径（排除 `var(--token, #hex)` fallback、排除注释），`HEAD=d27eb18` 核心页面共 **25 处直接 hex**：

| 文件 | 处数 | 典型 |
|---|---:|---|
| `web/src/pages/SettingsPage.tsx` | 16 | 主题预设色板、强调色默认值、关于页品牌名片 |
| `web/src/pages/ExecSessionsPage.tsx` | 5 | 运行态流动边框 `#5eead4`、mask `#000` |
| `web/src/pages/TasksPage.tsx` | 2 | 危险按钮 `color:'#fff'` |
| `web/src/pages/ReportPage.tsx` | 2 | 常用星标 `#d97706` / `#f59e0b` |

另扫描到 **41 处** `var(--语义变量, #hex)` 的历史 fallback，分布在 18 个文件；它们让主题切换实际失效（fallback 抢在 Token 前生效），由 Codemod 统一收敛。

基线证据：`evidence/t06290-baseline.log`。

## 2. 实现

### 2.1 Lint（门禁）

`D:\code\otherProjects\MTask\scripts\tests\lint-t06290-hardcoded-colors.mjs`（新增）

- 扫描 12 个核心页面/入口：`App.tsx` + 概览、任务、计划、需求、报表、队列、执行会话、提示词、模型、设置；
- 识别 `#rgb/#rrggbb/#rrggbbaa`，`var(--token, #hex)` 不计入违规；
- 输出 `文件:行号` 与命中值，发现即 exit 1；
- 提供 `hardcoded-color-allow` 行级豁免，但**本轮核心页面未使用任何豁免**。

### 2.2 Codemod（自动迁移）

`D:\code\otherProjects\MTask\scripts\tests\codemod-t06290-colors.mjs`（新增）

- 只匹配 `var(--已定义语义变量, #hex)`，替换为 `var(--语义变量)`；
- 只处理 `web/src/**/*.{tsx,ts,css}`，不触碰 `theme/presets.ts` 的设计预设、`MemoryGraph` 可视化色板、`KickoffPptPanel` 的 PPT 品牌色；
- `node …codemod-t06290-colors.mjs` 为 dry-run，仍有可迁移项时 exit 1；`--write` 落盘。
- 本轮实跑：**18 个文件、41 处 fallback**。

### 2.3 页面与 Token 改动

- `web/src/theme/presets.ts`（新增）：`ACCENT_PRESETS`、`THEME_PRESETS`、`DEFAULT_ACCENT` 单源；`SettingsPage` 不再内联设计预设色。
- `web/src/settings.tsx`
  - 新增 `--warning: var(--warn)` 别名：历史代码统一写 `var(--warning)`，此前该 Token 根本不存在，fallback 被删后会失效；
  - 新增 `--session-live-accent`（浅色 `#0f766e`、深色 `#5eead4`）；
  - 新增固定品牌资产 Token `--brand-card-bg/text/pink`，关于页名片 3 个 hex 收口。
- `web/src/pages/SettingsPage.tsx`：主题圆点与 color input 默认色改走 `var(--accent)` / `DEFAULT_ACCENT`；关于页名片改用品牌 Token。
- `web/src/pages/TasksPage.tsx`、`SonarSettingsTab.tsx`：实底按钮文字 `#fff` → `var(--on-solid)`。
- `web/src/pages/ReportPage.tsx`：常用星标颜色/填充 → `var(--warning)` / `currentColor`。
- `web/src/pages/ExecSessionsPage.tsx`：流动边框高亮 → `var(--session-live-accent)`；mask 由 `#000` 改为 `currentColor`（mask 只取 alpha）。
- 其余 18 个文件的 fallback 收敛由 Codemod 完成，逐文件见 `01-代码变更清单.csv`。

## 3. 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 迁移前基线 | 读取 `HEAD` 核心页面按 Lint 口径统计 | **25 处**，见 `evidence/t06290-baseline.log` |
| Lint 门禁 | `npm run verify:t06290` | `corePages=12 hardcodedHex=0`，**exit 0** |
| Codemod 幂等 | 同上（dry-run） | `files=0 replacements=0`，**exit 0** |
| Web 类型检查 + 构建 | `npm --workspace web run build` | `tsc --noEmit` 通过，Vite 1864 modules，**exit 0** |
| 改动范围 | `git diff --stat` | 23 个跟踪文件 + 1 个新预设文件 + 2 个脚本；无业务逻辑改动 |

证据：

- `evidence/t06290-baseline.log`：改造前 25 处分布；
- `evidence/t06290-verify.log`：Lint 0 + Codemod 0；
- `evidence/t06290-build-web.log`：类型检查与构建。

## 4. 边界与后续

- Lint 当前只统计**十六进制**色值；`rgba()` 阴影/遮罩仍是下一阶段治理对象，不在 AC-04 的 hex 口径内。
- 设计预设、数据可视化色板、PPT 品牌色属于“设计资产”，不纳入 UI 硬编码色；已在 Codemod 与 Lint 范围中显式排除。
- 高对比度主题与色盲模拟不在本轮验证范围；Token 化后可在后续主题扩展中复用。
