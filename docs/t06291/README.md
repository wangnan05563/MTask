# T06291 组件视觉回归：三主题截图矩阵与对比度门禁

- 任务：T06291「[PRD] 组件视觉回归」，priority urgent
- 关联需求：REQ-016「主题对比度门禁与截图回归测试，阻断视觉缺陷」；AC-04「核心页面扫描 0 处硬编码色」
- 范围：**测试与门禁**。不改造 Design System 组件结构、交互或业务页面布局
- 结论：核心 10 页 × 3 主题共 **30 张**、Design System 画廊 × 3 主题共 **3 张**截图全部生成并通过结构校验；三主题下 **33 个渲染上下文 `color-contrast` 违规均为 0**；`verify:t06291` **73 PASS / 0 FAIL，exit 0**

## 1. 测试设计

### 1.1 截图矩阵

| 维度 | 取值 |
|---|---|
| 主题 | `light`、`dark`、`high-contrast` |
| 核心页 | 概览、任务、计划/项目、需求、报表、队列、执行会话、提示词、模型、设置 |
| 组件画廊 | Button、Input、Badge、Card、Table、EmptyState + Skeleton |
| 视口 | 1280 × 900，实际截图画布 1258 × 802 |
| 运行基础 | 真实 Chrome + `web/dist` 生产构建 + 本地 API 代理，不使用 mock 数据 |

每张页面截图先等待加载完成：导航项正确、`#root` 文本非空、`.mt-skeleton` 为 0、无「加载中/正在加载」残留，再截图。避免把骨架屏当成组件最终视觉。

### 1.2 阻断项

1. **主题生效**：三主题 `body` 背景必须分别为 `rgb(255,255,255)`、`rgb(24,24,27)`、`rgb(0,0,0)`，且互异；截图内 `data-theme` 必须与目标一致。
2. **对比度**：对 30 个页面上下文和 3 个画廊上下文执行 axe-core 4.10.2 的 `color-contrast` 规则，任何违规即失败。
3. **截图有效性**：PNG 尺寸不小于 1200 × 700、字节数大于 8 KB、页面文本长度大于 60、导航高亮正确。
4. **矩阵完整性**：页面截图必须 30 张、画廊截图必须 3 张。

## 2. 实现

### 2.1 新增脚本

| 文件 | 作用 |
|---|---|
| `scripts/tests/t06291-gallery.tsx` | 用 React SSR 输出 Design System 六类组件的静态画廊，CSS 直接取 `tokens.css` + `components.css` |
| `scripts/tests/verify-t06291-visual.mjs` | Chrome CDP 截图矩阵、加载完成等待、axe 对比度门禁、主题背景断言、`matrix.html/json` 汇总 |
| `package.json` → `verify:t06291` | 串联 `verify:t06290`（AC-04 + Codemod 幂等）→ `verify-t06286-tokens`（三主题 Token 对比度）→ 本任务视觉门禁 |

复跑：

```powershell
npm --workspace web run build
npm run verify:t06291
```

输出默认 `D:/tmp/t06291-visual`，可用 `T06291_OUT` 覆盖；测试端口为 39912（静态服务）与 39877（本地 API）。

### 2.2 高对比主题的真实渲染

T06286 已在 `web/src/theme/tokens.css` 定义 `[data-theme='high-contrast']` 的 `--mt-*` 语义 Token，但旧页面仍消费 `settings.tsx` 的旧变量组。仅切换 `data-theme` 时会出现「纯黑画布 + 白色旧卡片」的混搭，首轮门禁因此失败。

在 `web/src/settings.tsx` 新增 `[data-theme='high-contrast']` 旧变量映射块，把 `--app-bg/card-bg/text/border/accent/success/danger/...` 对到高对比语义值，使生产构建下的高对比页面真实可测。**未修改 `web/src/ui/components/**` 或任何业务页面的结构、交互、布局。**

边界说明：设置页当前仍未暴露「高对比」档位，本轮通过测试侧写入 `data-theme='high-contrast'` 验证该主题的生产 CSS；如需用户可选，应由后续主题设置任务接入，不在本轮擅自扩功能。

## 3. 验证结果

| 验证项 | 结果 | 证据 |
|---|---|---|
| T06291 视觉门禁 | **73 PASS / 0 FAIL，exit 0** | `evidence/t06291-verify.log`、`visual-result.json` |
| 页面截图矩阵 | 30 张，全部 1258 × 802，最小 26762 字节，加载完成 `skeletons=0` | `matrix.json`、`evidence/matrix/` |
| 画廊截图 | 3 张，六类组件均可见，最小 42392 字节 | `evidence/gallery/` |
| 页面 `color-contrast` | 30/30 上下文 **0 违规** | `evidence/t06291-verify.log` |
| 画廊 `color-contrast` | 3/3 主题 **0 违规** | 同上 |
| 三主题画布互异 | 白 / `rgb(24,24,27)` / 纯黑，断言通过 | 同上 |
| Token 对比度（T06286） | 39 对检查，最低 **5.02:1**（light success-fg/canvas），`failures=[]` | 同上 |
| AC-04（T06290） | `corePages=12 hardcodedHex=0`；Codemod `files=0 replacements=0` | 同上 |
| Web 类型检查 + 生产构建 | 1864 modules，`✓ built in 2m 15s`，exit 0 | `evidence/t06291-build.log` |

## 4. 证据索引

- `evidence/t06291-verify.log`：完整 73 项 PASS 明细、Token 门禁与 AC-04 输出
- `evidence/t06291-build.log`：`tsc --noEmit` + Vite 生产构建，末行 `[t06291-build] exit=0`
- `evidence/visual-result.json`：73 项检查的结构化结果
- `evidence/matrix/matrix.html`：30 张页面截图的联系表，可直接浏览三主题差异
- `evidence/matrix/matrix.json`：每张图的主题、页面、字节数、尺寸、SHA、导航、文本长度、加载状态
- `evidence/matrix/matrix-<theme>-<tab>.png`：30 张页面截图
- `evidence/gallery/gallery-<theme>.png`：3 张 Design System 画廊截图
- `03-截图矩阵.csv`：33 张截图的逐张索引

## 5. 边界与后续

- 本轮**不做跨次像素 diff**：页面数据来自真实本地 API，任务数、队列状态会随时间变化，固定像素基线会产生假阳性。当前拦截的是主题未生效、加载未完成、截图失效与对比度违规四类缺陷；像素级 diff 需要确定性 fixture，建议后续单独立项。
- 高对比主题的强制应用依赖测试侧写入属性；设置页可选档位与用户偏好持久化不在本轮范围。
- `verify-t06286-tokens` 输出的 `hardcodedColorBaseline=295` 是 `web/src` 全量统计口径，不是 AC-04 的 12 个核心页面口径；AC-04 以 `hardcodedHex=0` 为准。
- 截图为 2026-11-24 当次真实数据快照，页面内容随数据变化，主题与对比度结论不受影响。
