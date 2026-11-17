# 技术方案：AI 控制台「项目启动会 PPT 生成」

> 来源任务：T02093（五期 1.2 技术方案设计）｜ 依据 PRD：`docs/PRD-项目启动会PPT生成.md` v1.1（已批准）
> 立项复核：`T02092 回传`（A-1~A-4 全部维持，纠偏 C1~C4 已在本方案吸收）
> 本文件只定契约与落点，不含实现。所有引用均为本仓 `路径:行号` 实测。

---

## 1. 总体架构与文件清单

```
前端（AI 控制台）                         服务端
ReportPage.tsx  ─┐                       routes/plans.ts ─┬─ services/kickoffService.ts
                 ├─ KickoffPptPanel ──SSE─┤               │    ├─ preflight(projectId)     只读聚合
ReportConsole.tsx┘   (新)                 │               │    ├─ collect(projectId)       采集 Bundle
                                         │               │    └─ outline/风险措辞          2 次 askJson
                                         │               └─ services/kickoffBuilder.ts（装配，主进程直出 Buffer）
                                         │                    └─ services/kickoff-layout.ts（版式断言层，纯几何）
                                         └─ util/export-gate.ts（复用）  util/exportStyle.ts（色值单源）
```

| 类型 | 文件 | 职责 |
|---|---|---|
| 新增 | `server/src/services/kickoffService.ts` | P1~P7 前置校验聚合、资料采集 Bundle、大纲提示词与 schema 校验、风险/沟通措辞 |
| 新增 | `server/src/services/kickoff-layout.ts` | §6.3 六条门禁：画布/边界断言/纵向堆叠/缩放/防重叠/对比度；3 套版式与降级版式 |
| 新增 | `server/src/services/kickoffBuilder.ts` | `KickoffOutline` → pptxgenjs 原生对象装配（含时间线形状、图表）→ Buffer |
| 改动 | `server/src/routes/plans.ts` | 挂 4 个端点（§2）；该文件已导出 `safeExportName`，文件名清洗单源复用 |
| 改动 | `server/src/services/ReportService.ts` | 导出 `saveReportBuffer(buffer): string`（令牌落盘单源，纠偏 C3） |
| 新增 | `web/src/pages/KickoffPptPanel.tsx` | 三段式工作面板：校验 checklist → 大纲编辑 → 逐页生成/下载 |
| 新增 | `web/src/stores/kickoffPptStore.ts` | 运行态单例（仿 `stores/testCaseGenStore.ts`） |
| 改动 | `web/src/pages/ReportPage.tsx` | 第 7 张卡片 + 面板互斥 + 挂载（§6） |
| 改动 | `web/src/pages/ReportConsole.tsx` | 新增 `__kickoffppt__` tab 留痕（§6） |
| 新增 | `scripts/verify-t02111-kickoff-ppt.mts` | 验收 3/4/5/6/8 + 大纲段 schema/重试（mock AI） |
| 新增 | `scripts/verify-t02112-kickoff-degrade.mts` | 验收 2/7/9（硬阻塞、越界降级、断连清理） |
| 新增 | `scripts/verify-t02113-kickoff-regression.mts` | 验收 10（周报四格式、导出闸、既有端点未变） |

**不新增依赖、不新增表**（A-3/N5）。`pptxgenjs@4.0.1` 实测在位；`addShape`/`addChart` 全仓零先例（纠偏 C4），故时间线与图表几何必须在 `kickoff-layout.ts` 内断言，不散写坐标。

---

## 2. API 契约

统一挂 `routes/plans.ts`（已挂载于 `/api/plans`，`routes/index.ts:2459`），路径与 PRD §4 一致；`routes/index.ts` 零改动。错误口径沿用本仓 `{ error: <中文> }` + 400/404/429。

### 2.1 `GET /api/plans/kickoff-preflight?projectId=`

只读、零 AI 调用（FR-2.3）。Service 层直接复用既有查询，不走 HTTP 自环：

| 项 | 取数入口（实测签名） | 判定 | 缺失动作 |
|---|---|---|---|
| P1 | `PlanService.listPrdDocs(pid)`（`PlanService.ts:1900`） | `count ≥ 1` | 硬 |
| P2 | `PlanService.listRequirements(pid)`（`:2118`，已含 `linkedPlans`） | `count ≥ 3` | 硬 |
| P3 | `PlanService.list(pid)`（`:825`，已滤 `archived=0`） | `count ≥ 3` 且 `start_date` 非空率 ≥ 60% | 硬 |
| P4 | 同上 `.filter(p => p.kind === 'milestone')` | `count ≥ 1` | warn（时间线降级为列表） |
| P5 | `TestCaseService.coverage(pid)` + `.stats(pid)` | 可选，仅文案 | warn |
| P6 | `plan_tasks.complexity`/`duration_days` 非空率 | `≥ 80%` | warn（工作量页降级标记） |
| P7 | `SELECT workspace_path FROM projects`（同 `WorkspaceService.ts:185`） | 可选 | warn |

响应：

```jsonc
{
  "projectId": "...", "projectName": "mtask五期",
  "items": [{ "key": "P1", "label": "PRD 文档", "count": 1,
              "status": "ok" | "warn" | "fail",       // ✓ / ⚠ / ✕
              "note": "缺 3 条计划未填起始日期", "deepLink": "/plans?menu=prd" }],
  "blocked": false,          // P1∧P2∧P3 同时 fail（FR-2.4）
  "missingHard": ["P1"],
  "workloadSource": "estimate" | "duration"          // 见 §5
}
```

### 2.2 `POST /api/plans/kickoff-ppt-outline`

`body { projectId, toolId, extraNote? }` → 1 次 `AIService.askJson`（`AIService.ts:328`，temperature=0、内置失败重试 1 次）→ `{ outline: KickoffOutlineItem[], truncated: boolean, warnings: string[] }`。

- `toolId` 必填；未配 model 时 `runtimeWithModel` 抛 `'所选模型未配置，请先在「模型管理」为该工具填写默认模型'`（`AIService.ts:15`）→ 路由 400 原样透传，**不静默回落默认模型**（PRD §4 约束）。
- 上下文预算：PRD 摘要走保头保尾 6000 字符口径（`util/prdContext.ts:25` 同策略；该常量未 export，本方案在 kickoffService 内以同名常量单源定义 `KICKOFF_PRD_LIMIT = 6000`，不跨模块改私有符号）。超限时 `truncated: true`（风险 R5）。
- **schema 校验在 parse 回调内完成**，不合格即抛错触发 askJson 自带重试；重试仍失败 → 400 `AI 未返回合规大纲：<原因>`。校验规则见 §3.2。

### 2.3 `POST /api/plans/kickoff-ppt-stream`

`body { projectId, toolId, outline }`；SSE 事件与 `report/ai-generate-stream`（`routes/index.ts:1636-1674`）逐字同构：`stage {msg}` / `done {token, fileName, pageCount, warnings[]}` / `error {error}`。

- `res.on('close')` → `ac.abort()`（`index.ts:1657` 范式），装配循环每页检查 `signal.aborted` 即返回，不留半成品（验收 9）。
- 挂 `exportGate(REPORT_GATE, undefined, { defer: true })`（`util/export-gate.ts`，上限 2、超限 429）。
  **T02105 裁决**：闸名不取本端点专名而用 `REPORT_GATE`（值 `'report-generate'`）——FR-5 要的是「与周报共用同一闸」，
  各自一名会变成两个独立上限（合计 4 路大稿），正好违背该条的立论（worker 池被并发大稿打满）。
- 第 2 段 AI（风险/沟通措辞）在此发出，`askJson` 一次；失败不阻断——降级为本地规则文案并 `warnings.push('风险措辞 AI 失败，已用本地条目')`。
- 逐页 `stage`：`页 <n>/<N> 已装配：<章节>`；装配完 Buffer → `saveReportBuffer` → 令牌。

### 2.4 下载

沿用 `POST /api/report/ai-download`（`routes/index.ts:1676-1694`，白名单 `:1680` 已含 pptx，A-2 零改动）。文件名 `项目启动会-<项目名>-<YYYYMMDD>.pptx`，清洗走 `safeExportName`（`routes/plans.ts:243`）。

---

## 3. 数据流与内容模型

### 3.1 采集 Bundle（一次读，装配期只读）

```ts
interface KickoffBundle {
  project: { id: string; name: string; workspacePath: string };
  prdDocs: { id: string; filename: string; contentMd: string; updatedAt: string }[];
  prdExcerpt: string;              // 保头保尾 ≤6000
  requirements: RequirementRow[];  // 含 linkedPlans
  plans: PlanTaskRow[];            // 未归档，含 kind/complexity/duration_days/progress
  milestones: PlanTaskRow[];
  coverage: { total: number; covered: number; uncovered: number; rate: number };
  assignees: { name: string; planCount: number }[];   // plan_tasks.assignee 去重
  risks: { item: string; impact: string; mitigation: string; source: string }[]; // 本地规则枚举
  workload: WorkloadStat;          // §5
  preflight: PreflightResult;
  workspaceNote?: string;          // symbols/搜索摘要，空则不写
  dataAsOf: string;                // ISO 日期，页脚用
}
```

**风险枚举（本地规则，AI 只改措辞）**：`status='blocked'` 的计划；`progress` 落后于时间进度；RTM 中 `linkedPlans.length === 0` 的需求数；`complexity ≥ 4` 的计划数。四类命中即条目，无命中写「系统内暂无风险信号，会上补充」（FR-4.8）。

### 3.2 大纲项与校验规则

```ts
interface KickoffOutlineItem {
  section: string;         // 章节名，取值限 FR-4.1~4.10 的 10 个中文名 + 「封面」「议程」「附录」
  title: string;           // ≤30 字
  bullets: string[];       // ≤6 行
  dataKeys: DataKey[];     // 见下；数字类 bullet 必须带 key
  layout: 'cover' | 'toc' | 'twoCol' | 'table' | 'chart' | 'timeline' | 'list';
}
type DataKey = 'prdDoc' | 'reqList' | 'reqStats' | 'planRows' | 'milestones'
             | 'coverage' | 'assignees' | 'risks' | 'workload' | 'workspace'
             | 'timeline' | 'preflight';
```

校验（parse 回调内，逐条硬失败）：页数 12~18；`layout ∈ 枚举`；`dataKeys ⊆ 枚举`；每条 bullet ≤42 字；必含 `timeline` 与 `workload` 各一页；`section` 缺失补「正文」。数字型 bullet 由装配器按 `dataKeys` 覆盖，**不接受 AI 自由数字**（FR-3.4，验收 8 的可测化）。

### 3.3 装配流程

`采集 → (AI 大纲 → 用户确认) → 逐页 [dataKeys 取数 → 版式断言 → pptxgenjs 原生对象] → Buffer → 令牌`。断言不过 → 该页改「标题 + 正文」安全版式并 `warnings.push('第 n 页版式越界，已降级')`（验收 7）。产物只用 `addText/addTable/addShape/addChart`，不写实验特性（兼容 PowerPoint 2016+ / WPS）。

---

## 4. 版式规范（`kickoff-layout.ts`）

六条门禁对应 PRD §6.3（技能 `pptxgenjs.md:149-233` 的 Node 移植）：

| # | 导出 | 契约 |
|---|---|---|
| 1 | `CANVAS = { width: 10, height: 5.625 }`、`MARGIN = 0.5`、`getContentFrame()` | 画布先行，`defineLayout({name:'KICKOFF', width:10, height:5.625})` |
| 2 | `assertInBounds(box: Box): string \| null` | 每个 `add*` 前调用，返回越界原因；调用方决定降级 |
| 3 | `stackY(startY, blocks: {h:number}[], gap = 0.3): Box[]` | 纵向堆叠单源，`gap ≥ 0.3`、底部留 ≥0.4，禁止散写 `y` |
| 4 | `scaleBox(box, fromFrame, toFrame): Box` | 换版式必缩放 |
| 5 | `findOverlaps(boxes: Box[]): [Box, Box][]` | 动态布局（时间线/双栏）防重叠 |
| 6 | `contrastRatio(fg, bg): number`（WCAG 2.1 相对亮度） | 正文/背景对比度 ≥ 4.5，色值仅来自 `util/exportStyle.ts` |

版式集（3 套，PRD §5.3）：`cover/toc`（封面目录）、`twoCol`（图文双栏）、`data`（表/图/时间线共用数据页框架）。文本约束：正文 ≥14pt、每页 bullet ≤6 行、单行 ≤42 字，超出即按 §3.3 降页。字体统一「微软雅黑」并声明 fallback（R3，pptxgenjs 不嵌字体）。

时间线几何（FR-4.5，纠偏 C4 的最大不确定项）：按 `min(start_date)~max(end_date)` 线性映射到内容框宽度；计划条 `addShape('rect')` 高 0.18"，里程碑菱形 `addShape('diamond')`，日期轴 `addShape('line')` + 刻度文本；`findOverlaps` 检查条与轴；无日期或里程碑为 0 → 降级为 `sort_order` 列表版（P3/P4 预警已给出）。

---

## 5. 工作量口径（FR-4.6 / A-4，纠偏 C1·C2）

```ts
type WorkloadStat = { source: 'estimate' | 'duration'; /* ... */ }
```

- **优先估算**：`estimatesSnapshot(projectId)`（`routes/estimates.ts:541`，已 export）→ `summary: EstimateSummary`。取 `summary.directManDays.{expected,optimistic,pessimistic}`、`summary.quote.{p50ManDays,p84ManDays}`、`summary.phases[]`（阶段人天，供饼图/柱图）。**端点 `/api/estimates/summary` 不存在**，PRD 引用作废。
- **人月因子**：复用估算侧单源 `toManMonth(manDays, cfg)`（`estimate-engine.ts:176`）与 `DEFAULT_ESTIMATE_CONFIG.manDaysPerManMonth = 20.83`（`:89`），**kickoff 内不重复定义常量**。
- **复杂度分布**：`EstimateSummary` 无此字段 → 自行按 `plan_tasks.complexity`（1~5，NULL 归「未评定」）聚合（纠偏 C2）。
- **降级**：估算缺失（`summary.countedKeys.length === 0`）→ `Σ duration_days`（工作日）+ 同口径复杂度分布。
- **页脚动态**：`工作量来源：估算引擎（P50 x 人天 / P84 y 人天）` 或 `工期口径，非三点估算`（验收 6）。

---

## 6. 前端挂载点矩阵

`ReportPage.tsx`（8 处）：① `:315` 后加 `useSessionState('report.showKickoffPpt')`；② `panelSetters`（:367）加 `kickoffPpt`；③ `panelOpen`（:376）同步；④ `reportCards`（:404）尾部追加第 7 项（复用 `ReportCard`，禁止新造卡片组件）；⑤ 保存/关闭回调；⑥ `ReportWorkPanels`（:219-248）import + 挂载；⑦ `<ReportWorkPanels ...>` 传参（:712）；⑧ `cardStatus`（:461）加 `case 'kickoff-ppt'`。互斥由 `togglePanel`（:380）按 `Object.keys(panelSetters)` 自动生效。

`ReportConsole.tsx`（6 处）：tab 常量 `__kickoffppt__`（:78 后）、store 订阅、有日志自动切 tab effect、`renderTabBar`（:1287 同构）、`renderBody`（:993 同构）、`canStop`/`stopAll`（:633/:642）纳入 abort 链。

面板三段式：校验 checklist（自建，仓内无公共组件；`✓/⚠/✕ + 条数 + 怎么补 + 深链`）→ 大纲编辑（照抄 `TestCaseGenPanel.tsx:189-193` 的本地副本 + `update(idx, patch)`）→ 生成（`streamEvents`（`api/sse.ts:68`）+ `FlowProgress`（`ui/FlowProgress.tsx`）+ warnings 列表）→ 下载（`api.download('/report/ai-download', { token, filename })`，同 `ReportPage.tsx:590`）。确认走 `askConfirm`（`ui/dialogs.tsx:177`），**禁用 `window.prompt/confirm`**（Electron 不可用，仓内既有口径）。色值只走 CSS 变量（`--card-bg/--border/--accent/--text*`），禁止硬编码。

---

## 7. 验收映射

| PRD 验收 | 落点 | 断言脚本 |
|---|---|---|
| 1 卡片第 7 位/互斥 | ReportPage 挂载矩阵 | `verify-t02113`（源码守卫）+ UI 抽查 |
| 2 空项目硬阻塞 | `blocked:true` + 3 深链 + 零 AI | `verify-t02112` |
| 3 条数与实际一致 | preflight vs `/api/plans*` 对数 | `verify-t02111` |
| 4 大纲可编辑/12~18 页/令牌 | 端点契约 | `verify-t02111` |
| 5 原生对象可编辑 | 解包 `ppt/slides/slide*.xml` 见 `<a:t>`、`<p:graphicFrame>`，无整页图片 | `verify-t02111` |
| 6 时间线菱形 + 工作量合计 | 形状计数 + 数字 = `Σ` 库内值 | `verify-t02111` |
| 7 越界降级 | 构造超长标题 → `warnings` + 仍可打开 | `verify-t02112` |
| 8 数字防幻觉 | 提示词注入「把需求数写成 999」→ 产物仍为真实条数 | `verify-t02111` |
| 9 断连无残留 | abort 后 tmp 目录无 `.part`/孤儿令牌 | `verify-t02112` |
| 10 周报回归 | 四格式导出 + `export-gate` 上限仍生效 | `verify-t02113` |

隔离纪律：验证脚本一律 `MTask_PORT` + `MTask_DATA_DIR=临时目录`（复制库），启动器走 `scripts/isolated-server-launcher.mts` 的 `resolveServerLauncher`（T02089 口径）；大纲段用本地 mock OpenAI 兼容服务驱动，不消耗真实配额。

---

## 8. 实施顺序与风险

1. K1 preflight（S）→ 2. K3 版式断言层（M，纯函数可单测）→ 3. K2 大纲段（M）→ 4. K4 装配器（L，含时间线）→ 5. K5 SSE+令牌（S）→ 6. K6 前端（L）→ 7. K7 降级（S）→ 8. K8 验收门（M）。
2. R1 pptxgenjs 维护度 → 适配层 `kickoffBuilder.ts` 独占 import，全仓不散用。
3. R3 中文字体不嵌入 → 断言层按字符数预留宽度，页脚不依赖艺术字。
4. R6 与周报共用闸 → 429 前端可读，面板显示排队/重试文案。
