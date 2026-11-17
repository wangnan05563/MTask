# PRD：测试用例管理（MTask · 需求跟踪矩阵关联 + AI 生成）

> 版本：v1.0 ｜ 日期：2026-10-01 ｜ 状态：待评审 ｜ 作者：产品（AI 辅助）
>
> 关联模块：项目管理（PlanPage / ReqMatrixPanel）、AI 工作台（ReportPage）、需求跟踪矩阵（T00662）、PRD 管理（T00770）

---

## 1. 背景与目标

MTask 已有完整的**需求侧**链路：PRD 导入 → 需求跟踪矩阵（`prd_requirements`）→ 项目计划 / 待办联动。`PlanService.listRequirements` 已能把「需求 ↔ 计划 ↔ 待办」三者的覆盖率算出来，但链路在**验证侧**断掉了：

- 需求有没有被测试覆盖、覆盖了哪些用例，**无从得知**；
- 测试用例目前散落在 `docs/` 下的 Markdown（如 `docs/版本更新功能测试用例清单.md`）或 Excel 里，**不受项目管理视图管理**、无法 CRUD、无 tracing；
- AI 工作台已有「从 PRD 导入项目计划」，但**没有「从 PRD 生成测试用例」**，PRD 到测试之间仍是人工翻译。

### 1.1 本期目标

| 编号 | 目标 | 衡量方式 |
|---|---|---|
| G1 | 在项目管理页提供「测试用例视图」，具备完整增删改查 | 单条 / 批量均可增删改 |
| G2 | 用例与需求跟踪矩阵条目建立**多对一**关联，从矩阵可一键下钻 | 矩阵行显示用例数，点击到位 |
| G3 | 用例视图支持 Excel / Word / Markdown 导出，沿用内置技能版式 | 三种格式产出可评审、可流转 |
| G4 | AI 工作台新增「从 PRD 生成测试用例」卡片，过程在 AI 控制台可见 | 控制台逐阶段日志 + 流式输出 |
| G5 | 生成结果经**草稿视图确认**后正式入库，且**拆分齐全**（覆盖率可校验） | 覆盖率 100% 或显式告警 |
| G6 | 全链路**页面切换状态保持**，与其他模块风格/交互完全一致 | 切页返回无任何状态丢失 |

### 1.2 非目标（本期不做）

- 测试计划（Test Run）/ 测试轮次编排 / 缺陷管理 —— 留待后续迭代（见 §16 路线图）。
- 自动化执行引擎对接（JUnit / Playwright 结果回传）。
- 移动端 `web/src/mobile` 适配（本期仅桌面端，见 §11 非功能需求「兼容」行）。
- 多用户权限、用例评审流（仅保留 `status` 字段预留）。

---

## 2. GitHub / 业界同类产品调研

> 调研对象：TestRail（商业标杆）、MeterSphere（国产开源 · GitHub `metersphere/metersphere`）、Kiwi TCMS、ThoroTest（`ecamuto/thorotest`）、TestLink、Squash TM、TestPlanIt、禅道（需求-用例双向关联）。

### 2.1 竞品矩阵

| 产品 | 定位 | 关键优点 | 主要短板 | 对 MTask 的启发 |
|---|---|---|---|---|
| **TestRail** | 商业标杆 | 用例模板体系（Text / Steps / BDD / 探索式 / AI 评测）；步骤级预期结果；`Section` 分模块的 Suite 树；milestone 级聚合覆盖率 | 按席位收费、闭源 | **用例字段模型与「步骤级预期结果」直接采纳**；`Passed/Failed/Blocked/Retest/Skipped` 结果集采纳 |
| **MeterSphere** | 国产开源、内置 AI 助手 | 「系统-组织-项目」三层；AI 生成功能用例/接口用例；用例与需求双向关联；插件市场（禅道/Jira 需求同步） | 重量级（Spring Boot + Kafka + MySQL + MinIO），无法嵌入桌面应用 | **AI 生成用例的交互范式**（需求选择 → AI 生成 → 预览勾选 → 入库）采纳 |
| **Kiwi TCMS** | 现代开源 | 干净 UI、完整 REST API、Tagging + 版本化、执行历史 | 无内置 AI、无 PRD 溯源 | **API 优先设计 + 标签分类**采纳（`tags` 字段预留） |
| **ThoroTest** | 2026 新兴自托管 | 手工/自动化**统一时间线**；9 种导入器自动识别（TestRail/Zephyr/Xray/CSV/XLSX）；导入**幂等**（按 source id 匹配，可重复同步）；Tests-as-code 双向 YAML sync；BYOK AI | 项目年轻 | **导入幂等 + 覆盖度可视化（coverage bar）**采纳 |
| **TestLink** | 老牌开源 | 需求↔用例 traceability 完整、Issue tracker 集成 | UI 陈旧（1.9.x）、升级需手工跑 SQL、**UI 体验是最大反面教材** | **反面案例**：不要把用例塞进深层目录树一层层点开；MTask 走「扁平表格 + 筛选」 |
| **Squash TM** | 企业级 | 需求覆盖度量、Campaign 规划、Gherkin 支持 | 偏重、流程重 | **覆盖度作为一等公民**采纳 |
| **TestPlanIt** | 开源 AI 原生 | 从 issue/requirement/文档直接 AI 生成用例，可对接 Jira/GitHub Issues | 成熟度低 | **「从 PRD 对象直接生成」的入口设计**采纳 |

### 2.2 归纳出的 12 条设计准则（本期需落实）

| # | 准则 | 来源 | 落地方式 |
|---|---|---|---|
| P1 | **用例 ≠ 执行结果**：用例是资产（可复用），执行结果是运行时数据 | TestRail / Kiwi | 拆 `status`（生命周期）+ `last_result`（最近结论） |
| P2 | 每条用例需完整包含：前置条件 / 步骤 / **步骤级预期结果** / 测试数据 / 后置条件 | TestRail Steps 模板 | `test_cases` 表 + `case_steps` 子表 |
| P3 | 必须有**优先级**（P0…P3）与**类型**（功能/接口/性能/安全/兼容/回归） | 全系一致 | 服务端单源枚举常量，前后端共用 |
| P4 | 用例**必须挂在需求上**，未挂需求的是"孤儿用例"，要能筛出来 | TestLink / Squash | `req_id` 可空 + 视图提供「仅看未关联」筛选 |
| P5 | **覆盖度是核心指标**：需求维度显示「已覆盖 / 未覆盖 / at-risk」 | ThoroTest / Squash | 矩阵列显示用例数；AI 卡片显示覆盖率条 |
| P6 | **导入/生成必须幂等**，重复跑同一份 PRD 不产生重复用例 | ThoroTest | `source_hash` + `source_key` 去重键 |
| P7 | 拒绝深目录树，用**扁平表格 + 多维筛选** | TestLink 反面 | 视图为单表 + 顶部筛选条 |
| P8 | **步骤/用例可拖拽排序** | TestRail / MeterSphere | `sort_order` 已在项目内有先例（`plan_tasks`），暴露拖拽 UI |
| P9 | 导出是刚需，且要保留**可编辑格式**（xlsx 便于批量改） | 全系 | Excel / Word / Markdown 三格式 |
| P10 | AI 生成过程要**可见、可中断** | MeterSphere / ThoroTest | SSE 流 + 控制台阶段日志 + 停止按钮 |
| P11 | AI 产物不能直接入库，必须有**草稿预览 + 勾选**环节 | MeterSphere | 草稿视图 + 确认导入 |
| P12 | 批量操作是高频刚需（批量改优先级/类型/删除/导出） | TestRail / Kiwi | 多选模式 + 批量条 |

---

## 3. 术语与角色

| 术语 | 定义 |
|---|---|
| 需求（Requirement） | `prd_requirements` 表中的一行，需求跟踪矩阵的一条 |
| 测试用例（Test Case） | `test_cases` 表中的一行，描述一次可执行的验证过程 |
| 步骤（Step） | `case_steps` 子表一行，含操作描述与该步预期结果 |
| 覆盖率 | 项目内「至少关联 1 条用例」的需求数 / 需求总数 |
| 孤儿用例 | `req_id` 为空的用例 |
| 草稿（Draft） | AI 生成后、尚未入库的临时结果，存在于面板状态 + 会话存储 |

角色：单人/小团队自用为主（与 MTask 现状一致），不区分权限。

---

## 4. 信息架构与入口设计

### 4.1 用例视图入口（项目管理菜单）

**位置**：`web/src/pages/PlanPage.tsx` → 子组件 `PlanPanelToggles`（`function` 定义在 **333** 行，按钮区止于 355 行）内，**需求跟踪矩阵按钮之后**插入。

现工具条线性顺序（自左向右）：

```
项目下拉 → 新建/导入/导出/模板 → AI评估 → 多选开关 → [批量条] → 列表|甘特 → PRD管理(FilePenLine) → 需求跟踪矩阵(Table2) → 节假日 → 刷新
                                                                                                  ↑在此之后插入 ↓
                                                                                        测试用例视图(TestTubes)
```

**新增按钮 JSX（与邻近按钮完全同构）**：

```tsx
{/* Txxxxx：测试用例视图入口——位于需求跟踪矩阵按钮之后；仅图标，title/aria 保留完整语义 */}
<button onClick={() => setShowTestCases((v) => !v)} className="tbtn-anim"
  title="测试用例视图 — 基于需求跟踪矩阵编写/管理测试用例，支持批量操作与 Excel/Word/Markdown 导出"
  aria-label="测试用例视图" aria-expanded={showTestCases}
  style={{ ...btnStyle, background: showTestCases ? 'var(--accent)' : 'transparent',
           color: showTestCases ? 'var(--accent-text)' : 'var(--text)',
           borderColor: showTestCases ? 'var(--accent)' : 'var(--border-strong)' }}>
  <TestTubes size={13} />
</button>
```

- 图标：`TestTubes`（lucide-react，尺寸 13 与矩阵按钮一致；若目标版本无此图标，回退 `FlaskConical`）
- 面板挂载：`{showTestCases && projectId && <TestCasePanel projectId={projectId} focusReqId={tcReqFilter} onClose={...} />}`
- 面板渲染顺序：PRD 管理 → 需求跟踪矩阵 → **测试用例视图**（自上而下，符合 PRD→需求→测试的流向）
- 展开态：`useSessionState<boolean>('plan.showTestCases', false)`（与 `plan.showMatrix` / `plan.showPrd` 同款）

### 4.2 AI 工作台新增卡片

**位置**：`web/src/pages/ReportPage.tsx` → `reportCards` 数组（`ReportCardCfg[]`，现 391-422 行）。

新增第 6 项，**排在「从 PRD 导入项目计划」之后**（同为 PRD 消费链路，形成 PRD → 需求/计划 → 测试用例的完整序列）：

```tsx
{ key: 'testcase-gen', icon: <TestTubes size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />,
  title: '从 PRD 生成测试用例',
  desc: '选择已录入 PRD 或上传外部文档，结合工作空间代码拆分需求并生成测试用例，覆盖率校验后确认入库',
  hint: '从 PRD 生成测试用例 — 可选内部 PRD 或上传外部文档，AI 结合项目源码拆分需求跟踪矩阵并逐条生成用例，草稿确认后导入测试用例视图',
  aria: '从 PRD 生成测试用例',
  open: showTestCaseGen,
  onReset: resetArtifacts,
  onToggle: () => togglePanel('testCaseGen') },
```

配套改动：
- `panelSetters` / `panelOpen` 增加 `testCaseGen`（互斥逻辑由现有 `togglePanel` 统一处理）
- `cardStatus` 增加 `case 'testcase-gen'` 分支（状态取 `testCaseGenStore` 快照）
- `web/src/stores/testCaseGenStore.ts` 新建（仿 `prdGenStore.ts`）
- `ReportConsole.tsx` 增加 `TEST_CASE_GEN_TAB = '__testcasegen__'` 标签页（仿 PRD_GEN_TAB 渲染逻辑）
- `web/src/ui/consoleReset.ts` 的 `ARTIFACT_SESSION_KEYS` 追加草稿键
- `web/src/pages/guides.tsx` 的 `REPORT_STEPS` 追加一步（可选）

### 4.3 双向跳转（矩阵 ⇄ 用例）

| 起点 | 操作 | 结果 |
|---|---|---|
| 需求跟踪矩阵行 →「用例」列 chip（显示数量，如 `用例 3`） | 点击 | 展开/聚焦测试用例视图，自动按该需求筛选（顶部筛选器回填，可一键清除） |
| 测试用例视图 →「关联需求」列 chip | 点击 | 展开需求跟踪矩阵并滚动/高亮到该需求行 |
| 需求跟踪矩阵 → 右上角「跳转生成」按钮（`Upload` 图标，与现 `goImportPrd` 同款） | 点击 | 写入 `sessionStorage` 标记 → `mtaskNavigate` 跳转 AI 工作台并自动展开「从 PRD 生成测试用例」卡片，带入当前项目与所选需求集合 |

跳转状态载体（沿用 T00824 范式）：

```ts
sessionStorage.setItem('report.showTestCaseGen', JSON.stringify(true));
sessionStorage.setItem('tcgen.project', JSON.stringify(projectId));
sessionStorage.setItem('tcgen.reqIds', JSON.stringify(reqIds));   // 可为 []
globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'report' } }));
```

---

## 5. 数据模型

### 5.1 新表 `test_cases`（写于 `server/src/db/schema.ts` 的 `initSchema()` DDL 段）

```sql
-- Txxxxx：测试用例——每条用例多对一关联需求跟踪矩阵条目（prd_requirements）
CREATE TABLE IF NOT EXISTS test_cases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  req_id       TEXT REFERENCES prd_requirements(id) ON DELETE CASCADE,  -- 可空=孤儿用例
  case_no      TEXT NOT NULL DEFAULT '',                                 -- TC-001，项目内唯一
  module       TEXT NOT NULL DEFAULT '',                                 -- 所属模块/章节
  title        TEXT NOT NULL,
  preconditions TEXT NOT NULL DEFAULT '',
  expected     TEXT NOT NULL DEFAULT '',                                 -- 整体预期结果（用例级）
  test_data    TEXT NOT NULL DEFAULT '',                                 -- 测试数据
  postconditions TEXT NOT NULL DEFAULT '',                               -- 后置条件
  priority     TEXT NOT NULL DEFAULT 'P1',                               -- P0/P1/P2/P3
  type         TEXT NOT NULL DEFAULT 'functional',                       -- functional/api/performance/security/compat/ui/regression/smoke
  method       TEXT NOT NULL DEFAULT 'manual',                           -- manual/automation
  status       TEXT NOT NULL DEFAULT 'draft',                            -- draft/review/approved/deprecated
  last_result  TEXT NOT NULL DEFAULT 'untested',                         -- untested/pass/fail/blocked/skip
  tags         TEXT NOT NULL DEFAULT '',                                 -- 逗号分隔标签
  source_key   TEXT NOT NULL DEFAULT '',                                 -- 幂等去重键（AI 生成来源）
  source_hash  TEXT NOT NULL DEFAULT '',                                 -- PRD 内容哈希，重复生成识别
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_cases_project ON test_cases(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_test_cases_req ON test_cases(req_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_cases_no ON test_cases(project_id, case_no);
```

### 5.2 新表 `case_steps`（步骤子表）

```sql
-- Txxxxx：测试用例步骤——一步一行，含该步预期结果（TestRail Steps 模板）
CREATE TABLE IF NOT EXISTS case_steps (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  step_no       INTEGER NOT NULL,
  action        TEXT NOT NULL DEFAULT '',   -- 操作描述
  expected      TEXT NOT NULL DEFAULT '',   -- 本步预期结果
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_steps_case ON case_steps(case_id, step_no);
```

### 5.3 关联现有表

- `test_cases.req_id` → `prd_requirements.id`（CASCADE 删除）
  - ⚠️ 连带影响：`PlanService.deleteRequirement`（`PlanService.ts:1816`）删除需求时，其下用例被 SQLite 外键联动删除。**必须在前端确认弹窗中展示用例条数**（见验收 A15）。
  - ✅ 前提已具备：`server/src/db/connection.ts:76` 已 `db.pragma('foreign_keys = ON')`，CASCADE 才会生效。**新增自我保护用例（关闭该 pragma 或改为逻辑删除时级联即静默失效）**，回归脚本须覆盖该断言。
- **不需要**给 `prd_requirements` 加反向冗余列（避免重蹈 `req_ids` JSON 数组反范式的维护成本：每次改关联都要双写）。聚合一律走 `SELECT ... WHERE req_id = ?` 走索引。
- 既有 `req_ids`（plan/task 侧 JSON 数组）保持不变，本期不动。

### 5.4 枚举常量（服务端单源，前后端共用）

> 背景：现项目存在口径漂移 —— `plans.ts` 用 `high/medium/normal/low`，MCP `mtask_update_matrix` 用 `high/urgent/normal/low`。新模块的枚举**必须只有一处定义**。

```ts
// server/src/util/testCaseEnums.ts（新增，供 service / route / MCP / 前端共享字符串常量）
export const CASE_PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
export const CASE_TYPE = ['functional','api','performance','security','compat','ui','regression','smoke'] as const;
export const CASE_METHOD = ['manual','automation'] as const;
export const CASE_STATUS = ['draft','review','approved','deprecated'] as const;
export const CASE_RESULT = ['untested','pass','fail','blocked','skip'] as const;
```

中文标签映射（`CASE_PRIORITY_LABEL` / `CASE_TYPE_LABEL` / …）服务端导出路由与前端共用同一份 JSON，经 `GET /api/plans/test-cases/meta` 下发，避免像 `STATUS_LABEL` 一样在路由里重复硬编码。

---

## 6. 接口设计

路由文件：`server/src/routes/plans.ts`（沿用现有 `planApi` Router，无需改 `routes/index.ts`）。
**注册顺序铁律**（见 `plans.ts:8-11` 注释）：静态路径必须先于 `/:id` 注册。

### 6.1 元信息

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/plans/test-cases/meta` | 枚举 + 中文标签（供前端 select 与导出） |

### 6.2 CRUD

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/plans/test-cases` | query: `projectId`(必填) `reqId?` `q?` `module?` `priority?` `type?` `status?` `result?` `orphanOnly?` `limit?` `offset?` | `{ total, items: TestCaseWithSteps[] }` |
| GET | `/api/plans/test-cases/:id` | — | `TestCaseWithSteps` |
| POST | `/api/plans/test-cases` | `{ projectId, reqId?, title, module?, preconditions?, expected?, testData?, postconditions?, priority?, type?, method?, tags?, steps?: [{action, expected}] }` | 新建行（含自动生成的 `case_no`） |
| PATCH | `/api/plans/test-cases/:id` | 同上字段子集 + `sortOrder?` `status?` `lastResult?` `reqId?`（传 `''` 表示解除关联） | 更新后行 |
| DELETE | `/api/plans/test-cases/:id` | — | `{ ok: true }` |
| GET | `/api/plans/test-cases/coverage?projectId=` | — | `{ total, covered, uncovered: number, rate: number, byReq: [{ reqId, reqNo, title, caseCount }] }` |

**列表查询要点**：
- 过滤与分页全部**服务端做**（对比：`listRequirements` 目前全量返回，用例数量级更大，不可照抄）。
- `coverage` 接口用一次 `GROUP BY req_id` 出结果，**禁止** N+1 查询。
- 默认 `limit=200&offset=0`；`total` 用于前端分页与「共 N 条」统计。

### 6.3 批量操作（静态路径，先于 `/:id`）

| Method | Path | Request | 说明 |
|---|---|---|---|
| PATCH | `/api/plans/test-cases/batch` | `{ ids: string[], patch: { priority?\|type?\|method?\|status?\|lastResult?\|reqId?\|module? } }` | 事务批量改字段 |
| DELETE | `/api/plans/test-cases/batch` | `{ ids: string[] }` | 事务批量删除（级联删步骤） |
| POST | `/api/plans/test-cases/reorder` | `{ projectId, reqId?: string\|null, ids: string[] }` | 拖拽排序重写 `sort_order` |
| POST | `/api/plans/test-cases/duplicate` | `{ ids: string[] }` | 复制选中用例（编号重排），批量操作高频需求 |

### 6.4 导出

| Method | Path | Request | 说明 |
|---|---|---|---|
| POST | `/api/plans/test-cases/export` | `{ projectId, ids?: string[], reqId?: string\|null, format: 'xlsx'\|'docx'\|'md' }` | `ids` 为空=导出当前筛选全量；`reqId` 支持从矩阵单需求导出 |

**服务端实现要求**（对齐现有导出基础设施）：
- 套 `exportGate('testcase-export', undefined, { defer: true })` 并发闸（默认 2 路，见 `server/src/util/export-gate.ts`）
  - ⚠️ 若合成是同步重活必须传 `{ defer: true }`，否则 Node 单线程下计数停在 1、闸门失效
- `exceljs` / `docx` 用 `await import(...)` **按需加载**，不常驻
- 响应头：`Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(name)>`（中文文件名必须 RFC 5987 编码）
- 文件名：`测试用例-{项目名}-{yyyyMMdd}.{ext}`，经 `safeExportName()` 清洗

### 6.5 AI 生成

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/plans/testcase-generate-stream` | SSE 流式生成（注册于 `routes/index.ts`，与 `prd-generate-stream` 同处，需 `raw({ type: () => true, limit: '30mb' })` + `text/event-stream`） |
| POST | `/api/plans/test-cases/import-draft` | 草稿确认入库 |

**为何走 SSE 而非普通 POST**：`(a)` 用例量大、需要过程可见；`(b)` 需注入项目源码上下文（体量大）；`(c)` 与现有 PRD 生成链路体验统一。已在 §2.2 P10 论证。

### 6.6 MCP 工具（保持 `mtask_*` 家族命名）

| 工具 | 说明 |
|---|---|
| `mtask_list_testcases` | `{projectId?, reqId?, q?, limit?}` → 用例列表 + 覆盖度摘要 |
| `mtask_update_testcases` | `{action: 'create'\|'update'\|'delete'\|'link'\|'batch-patch', ...}` → 服务层幂等；`link` 负责挂/解需求 |

输入 schema 用 zod（与 `mtask_update_matrix` 保持一致），并**必须**从 `util/testCaseEnums.ts` 导入枚举，杜绝第三次口径漂移。

### 6.7 变更广播

`PlanService` 现有需求矩阵写操作**没有调用 `notifyChange()`**（因此前端每次写后必须手动 `load()`）。新模块修正这一点：所有 `TestCaseService` 写操作末尾调用 `notifyChange('plans')`（`ChangeKind` 现仅 `tasks\|plans\|queue\|projects`，不新增类型），使多窗口 / MCP 侧变更可准实时刷新。

---

## 7. 前端组件设计：`web/src/pages/TestCasePanel.tsx`

### 7.1 Props 与状态保持

```tsx
export function TestCasePanel({ projectId, focusReqId, onClose }: {
  readonly projectId: string;
  /** 需求跟踪矩阵下钻带来的筛选需求 id（空串=不过滤） */
  readonly focusReqId?: string;
  readonly onClose: () => void;
}) { ... }
```

**状态全部走 `useSessionState`（`web/src/ui/session.ts`），禁止裸 `useState` 承载用户可感知状态**（对比：`ReqMatrixPanel` 14 个 `useState`，切页即丢，是明确的反面案例）：

| 会话键 | 内容 | 类型 |
|---|---|---|
| `plan.showTestCases` | 面板展开态 | boolean |
| `tc.reqFilter` | 关联需求筛选（矩阵下钻回填） | string |
| `tc.keyword` | 关键词 | string |
| `tc.filters` | `{ module, priority, type, status, result, orphanOnly }` | object |
| `tc.multi` / `tc.selIds` | 多选模式与选中项 | boolean / string[] |
| `tc.page` | 当前分页 | number |
| `tcgen.draft` | AI 草稿（键名须与 §8.7 / §12 一致，**勿写成 `tc.draft`**） | object |

### 7.2 工具栏布局（两行，行结构与 `ReqMatrixPanel` 一致）

**第一行**：`TestTubes`(15, accent) + 「测试用例」标题 + 统计文案（共 N 条 · 已关联需求 M 条 · 孤儿 K 条）+ `<span flex:1 />` + 右侧操作组：

| 顺序 | 控件 | 图标 | className | 行为 |
|---|---|---|---|---|
| 1 | 多选模式开关 | `ListChecks` / `Check` | `tbtn-anim` | 进入/退出多选，清空选中 |
| 2 | 批量条（仅 `multi && selIds.length>0`） | — | `span.op-host` | 见 §7.5 |
| 3 | 筛选 | `Filter` | `tbtn-anim` | 展开第二行筛选条（受 `aria-expanded`） |
| 4 | 导出 | `Download` | `tbtn-anim prd-tilt-btn` | 弹出三格式菜单（见 §7.6） |
| 5 | 刷新 | `RefreshCw` | `tbtn-anim` | 重新拉取 |
| 6 | 收起 | `X` | `tbtn-anim` | `onClose()` |

**第二行**：新增输入框（`placeholder="新增用例标题（回车提交）"`，`Enter` 提交）+ `Plus` 按钮 + `[仅显示]` 下拉（全部 / 未关联需求的孤儿用例 / 未覆盖的需求）+ 通知文案。

> 一致性说明：新增交互刻意与 `ReqMatrixPanel` 完全同构（「顶部输入 + Enter 提交」），在同一页面操作两个面板时无需重新学习，已形成的肌肉记忆可直接复用。

### 7.3 表格列定义

| # | 列名 | 字段 | 宽度 | 交互 |
|---|---|---|---|---|
| 0 | 勾选（仅多选） | `selIds` | 30 | checkbox，表头全选含半选（`indeterminate`，见 `ReqMatrixPanel` `allRef`） |
| 1 | 用例编号 | `case_no` | 100 | 行内 input，`onBlur` 保存，accent 色 |
| 2 | 用例标题 | `title` | min 200 | 行内 input + 展开详情按钮（`ChevronDown/Up`） |
| 3 | 所属模块 | `module` | 120 | 行内 input（`datalist` 提示已有模块，选项取 meta 接口的 `modules`） |
| 4 | 关联需求 | `reqNo` chip | 160 | **chip 可点击** → 跳转/高亮矩阵（§4.3）；点击「换」可改关联 |
| 5 | 优先级 | `priority` | 88 | `<select>` P0..P3，change 即存 |
| 6 | 类型 | `type` | 96 | `<select>`，change 即存 |
| 7 | 状态 | `status` | 96 | `<select>` draft/review/approved/deprecated |
| 8 | 执行结果 | `last_result` | 96 | `<select>` untested/pass/fail/blocked/skip，**按结果着色**（pass→`--success`，fail→`--danger`，blocked/skip→`--text-muted`） |
| 9 | 步骤 | steps 条数 badge | 70 | 点击展开行内步骤编辑区（见 §7.4） |
| 10 | 操作 | — | nowrap | 复制 / 删除（`Trash2`，`--danger`） |

表格容器：`overflowX:auto` + `border:1px solid var(--border)` + `borderRadius:6`；`table` 的 `fontSize:12` + `borderCollapse:collapse`。（与 `ReqMatrixPanel:306-311` 完全一致）

**分页**：底部「共 N 条 · 第 x/y 页」+ 上/下一页，默认每页 200 条，提供「200 / 500 / 全部」切换。仅当切到「全部」且结果 > 1000 条时才启用虚拟滚动（性能要求见 §11）。

### 7.4 步骤编辑（行内展开）

点击「步骤 N」badge → 行下方内联展开块（`background: var(--surface-2)`，`fontSize:11`）：

```
┌ 步骤 ─────────────────────────────────────────┐
│ 1. [操作描述 input.................] [预期结果 input.................] [×] │
│ 2. [操作描述 input.................] [预期结果 input.................] [×] │
│ + 添加步骤                                                              │
└───────────────────────────────────────────────┘
```

- 步骤增删.Change 即写（`POST/PATCH/DELETE /plans/test-cases/:id/steps` 或随用例 PATCH 整体提交，实现时二选一，**推荐随用例整体提交**以减少端点数量）
- 拖拽排序复用 `sort_order`（`GripVertical` 手柄）

### 7.5 批量操作条

条件渲染，样式直接复制 `ReqMatrixPanel:245-264`（`span.op-host` + `border:1px solid var(--accent)` + `radius 6` + `padding 2px 8px`）：

```
已选 12  [全选/取消全选] [批量优先级▾] [批量类型▾] [批量状态▾] [批量改所属模块▾]
         [批量关联需求▾] [复制] [导出▾] [删除 🗑(danger)]
```

- 全选作用于**当前筛选结果**（服务端返回的 `total` 范围内），非仅当前页
- 删除走 `askConfirm`（`web/src/ui/dialogs`），文案含数量：删除选中的 12 条测试用例及其步骤？此操作不可撤销。
- 「批量关联需求」下拉列出当前项目需求（`REQ-001 标题`），选中即把勾选用例挂上去；提供「解除关联」项

### 7.6 导出交互

复用 `PrdPanel.tsx:40-107` 的 `PrdDownloadButton` 结构（全仓最接近可复用下拉菜单的实现）——`position:relative` 容器 + `absolute` 浮层 + `mousedown` 外部关闭 + 每项 `Icon` + 两行 `title`：

```tsx
const CASE_EXPORT_FORMATS = [
  { key: 'xlsx', label: 'Excel（.xlsx）', desc: '浅色表头 + 斑马纹表格，含步骤明细子表，便于批量编辑与统计', Icon: FileSpreadsheet },
  { key: 'docx', label: 'Word（.docx）', desc: '按需求分组的结构化文档，可直接评审打印', Icon: FileType },
  { key: 'md',   label: 'Markdown（.md）', desc: '纯文本渲染，便于纳入版本管理与 Wiki', Icon: FileText },
] as const;
```

导出范围三选一（依优先顺序）：选中用例 > 当前需求筛选 > 全量。按钮 `title` 动态说明当前将导出的范围（避免「点了不知道导出什么」）。

### 7.7 空态与异常态

- 无用例：`该项目暂无测试用例——可在上方手动新增，或前往 AI 工作台「从 PRD 生成测试用例」。`
- 筛选无结果：`无匹配结果。[清除筛选]`
- 孤儿用例 > 0 时，标题统计行以 `--text-muted` 提示 `其中 K 条未关联需求`

---

## 8. AI 工作台「从 PRD 生成测试用例」卡片

### 8.1 输入区（兼容外部导入 + 内部选择）

完全对齐 `PrdImportPanel`（T00662 / T00907）的双通道设计：

```
┌─ 目标项目 ─────────────────────────────────────────────┐
│ [项目下拉 ▾]                                            │
├─ PRD 来源 ─────────────────────────────────────────────┤
│ ① 内部选择：[已录入 PRD 文档 ▾]（GET /plans/prd-docs?projectId=）│
│ ② 外部导入：[选择文件] 支持 .docx/.xlsx/.md/.txt/.pdf          │
│ ➜ 两类可同时存在，文件仅「追加到待处理列表」，点确认才触发生成      │
├─ 生成偏好 ─────────────────────────────────────────────┤
│ 默认每需求生成用例数 [3 ▾] ｜ 用例粒度 [包含步骤▾/仅要点]        │
│ 优先级策略 [风险驱动▾] ｜ 是否包含负向用例 [是▾]                 │
│ [ ] 同时把新拆分的需求写入需求跟踪矩阵                            │
└────────────────────────────────────────────────────────┘
            [开始生成] [停止]（生成中）
```

**内部 PRD 自动带入**：从需求跟踪矩阵跳转而来时，读取 `sessionStorage` 标记，`autoPullDoc()` 拉 `GET /plans/prd-docs/:id` 构造 `File` 填入列表，**不自动触发生成**（沿用 T00841「确认才执行」），并在控制台打一行 `已自动带入所选 PRD：xxx.md`。

### 8.2 内置技能资产（新增）

```
server/src/skills/testcase-generate/
├── SKILL.md                          # 输出协议 + 角色定义 + 硬性要求
└── references/
    ├── test-design-rules.md          # 等价类划分/边界值/判定表/状态迁移/场景法/正交实验
    ├── coverage-rules.md             # 需求→用例覆盖映射规则、正反用例配比、优先级策略
    └── case-style-rules.md           # 步骤书写规范、可判定预期结果写法、禁止模糊表述
```

- 加载方式：复制 `PrdGenService.skillDir()` 的双候选路径 + `readFileSync` 模式
- **不需要**引入任何 registry / loader / runner —— 项目里所谓「内置技能」即 Markdown prompt 资产，不是可执行代码（详见 §10.1 澄清）
- `server/package.json` 的 build 脚本已 `fs.cpSync('src/skills','dist/skills')`，新目录自动被带上，无需改脚本

### 8.3 生成 pipeline（`server/src/services/TestCaseGenService.ts`）

```
① 解析 PRD 原文（内部文档 content_md / 上传文件 → text）
   ↓ onStage
② loadWorkspaceContext(project.workspace_path)  —— 目录树(depth3,150项) + README/package.json 片段
③ buildRetrieveBlock() —— refreshSymbols + extractKeywords + autoContext 注入代码片段
   ↓ onStage
④ 步骤 1/3｜拆分需求跟踪矩阵
   - 项目已有需求（`listRequirements` 非空）→ 默认复用，不重复生成
   - 无需求 或 用户勾选「重新拆分」→ AI 按 PRD 输出 <<<REQUIREMENTS>>>
   ↓ onStage（打印「已生成 K/M 条需求的用例」进度）
⑤ 步骤 2/3｜分块生成测试用例（≤5 条需求/块，避免触输出上限）
   - 每块独立调用，失败自动缩块重试 ≤2 次
   ↓ onDelta 流式 + onStage 进度「已生成 K/M 条需求」
⑥ 步骤 3/3｜覆盖率校验
   - 未覆盖需求 → 定向补生成一轮
   - 仍缺失 → 返回 coverageWarn，控制台 warning
   ↓
⑦ 返回草稿 { requirements, cases, coverage, notes[] }
```

**输出协议**（沿用 `<<<X>>>` 分隔符，与 `prd-generate` 一致，解析器可复用 `scanJsonArrays` 三级容错）：

```
<<<REQUIREMENTS>>>
[{"reqNo":"REQ-001","title":"…","content":"…","sourceRef":"PRD 3.2 节","priority":"normal"}]
<<<CASES>>>
[{"reqNo":"REQ-001","module":"登录","title":"使用已注册手机号+正确密码登录成功","preconditions":"用户已完成注册且未锁定",
  "priority":"P0","type":"functional","method":"manual","testData":"13800000000 / Pass@123",
  "steps":[{"action":"打开登录页","expected":"展示手机号、密码输入框与登录按钮"},
           {"action":"输入上述账号密码并点击登录","expected":"跳转首页，右上角显示昵称"}],
  "expected":"登录成功并跳转首页","postconditions":"退出登录，清理会话"}]
```

### 8.4 输出预算（关键约束 · 必读）

> 教训来源：全库 AI 工具默认 `max_tokens=4096`，**长文本一次成文必然触顶截断**（实测某模型 1775 字符即 `finish_reason=length`），且表现为「上层拿不到 done、用户只看到没输出」，极易误判成模型问题。

因此必须：
- `TESTCASE_MIN_OUTPUT_TOKENS = 8192`，`TESTCASE_TIMEOUT_MS = 300_000`，取**「用户配置与下限的较大值」**（与 `PRD_PARSE_MIN_OUTPUT_TOKENS` 同款写法）
- **按需求分块**调用而非一次性生成全量（这是防截断的根本手段，比抬预算更可靠）
- 命中 `finish_reason === 'length'` → 控制台打 `warn：本轮输出被截断，已自动缩小块大小重试（1/2）`；重试耗尽 → `error` 并在草稿页标注
- 参考 `PrdParseResult.truncatedNote` 语义，草稿保留已成功部分

### 8.5 草稿视图与确认导入

```
┌─ 草稿预览 ──────────────────────────────────────────────────┐
│ 覆盖度 ████████░░ 18/22 需求已覆盖  ·  共 64 条用例          │
│ ⚠ 4 条需求未生成用例：[补生成] [忽略]                          │
├──────────────────────────────────────────────────────────────┤
│ ☑ REQ-001 用户登录（🆕 将新建 / ✓ 已入库）        用例 4 条    │
│   ☑ TC-001 使用已注册手机号登录成功   P0  functional  [编辑][删]│
│   ☑ TC-002 密码错误时提示且不跳转     P1  functional  [编辑][删]│
│   ☐ TC-003 连续5次失败锁定账号        P2  security    [编辑][删]│
│ ☐ REQ-002 订单取消（✓ 已入库）                    用例 3 条    │
├──────────────────────────────────────────────────────────────┤
│ [全选] [反选] [按优先级筛选▾]  选中 58/64                       │
│                          [取消] [重新生成] [确认导入 58 条]      │
└──────────────────────────────────────────────────────────────┘
```

- 每条用例可勾选 `include`（不勾选不入库）、可就地编辑、可删除
- 「已入库」标记通过对 `source_key` 查重得出（幂等，重复生成不产生重复用例，见 §2.2 P6）
- **确认导入**走 `POST /plans/test-cases/import-draft`，服务端单事务：需求创建（可选）→ 需求 id 映射 → 用例落库 → 步骤落库 → `source_key` 写入 → `notifyChange('plans')`
- 导入后 `flash`：`已导入 58 条测试用例（覆盖 20/22 条需求）——可在「项目管理 → 测试用例视图」查看`，并可选自动跳转

### 8.6 AI 控制台呈现

`web/src/stores/testCaseGenStore.ts`（仿 `prdGenStore.ts`：`pushLog` / `setResult` / `begin` / `finish` / `abort`），`ReportConsole.tsx` 新增 `TEST_CASE_GEN_TAB`。

阶段日志样例（中文，逐条 push）：

```
加载内置技能「testcase-generate」…
已载入 PRD：需求规格说明书.md（12,438 字，来自：内部文档）
符号索引刷新：文件 156 个、符号 2,041 个（未变跳过 12）
检索增强：按关键词 [login, validate, session] 命中代码片段已注入上下文
步骤 1/3｜拆分需求跟踪矩阵…（检测到项目已有 12 条需求，将复用并补充缺口）
步骤 1/3 完成：需求 22 条（复用 12，新增 10）
步骤 2/3｜生成测试用例…（22 条需求分 5 块处理）
  ▸ 已生成 15/22 条需求的用例（累计 44 条）
warn：第 3 块输出被截断，已缩小块大小重试（1/2）
  ▸ 已生成 22/22 条需求的用例（累计 64 条）
步骤 3/3｜覆盖率校验…未覆盖 4 条，定向补生成中
步骤 3/3 完成：覆盖 22/22（100%）
生成完成：需求 22 条、用例 64 条（耗时 1 分 42 秒）——请在草稿视图确认后导入
```

- 「停止」按钮 → `AbortSignal` 中断底层 AI 请求（沿用 `PrdGenService` 的 `signal?: AbortSignal` 约定）
- 切换卡片/Tab 不中断进行中的任务（与现有三通道一致）：日志 store 是模块级的，返回后台视图继续滚动

### 8.7 草稿状态保持

**必须**采用 `PrdImportPanel` T00982 的做法：组件卸载会导致 `useSessionState` 的持久化 effect 不再执行，因此**在生成完成回调里同步写一次 `sessionStorage`**：

```ts
sessionStorage.setItem('tcgen.draft', JSON.stringify({ projectId, requirements, cases, coverage, source }));
```

恢复时机：卡片展开时读取； keys 一并加入 `consoleReset.ARTIFACT_SESSION_KEYS`，使「重置控制台 / 卡片侧重置」可清空。

---

## 9. 一致性规范（UI/UX）

> 基准来源：项目管理页工具条 + `ReqMatrixPanel`（全站已定型）。

### 9.1 必须遵守的既有基线

| 项 | 规范 | 出处 |
|---|---|---|
| 按钮基础样式 | `btnStyle`：`inline-flex / gap 4 / fs 12 / padding 3px 8px / border 1px solid var(--border-strong) / radius 4` | `PlanPage.tsx:74` |
| 交互动画 | 所有按钮 `className="tbtn-anim"`（`.18s ease`，hover scale 1.15 rotate 8deg，active scale .88） | `App.tsx:163-165` |
| 导出按钮动效 | `prd-tilt-btn`（3D 透视倾斜 + 阴影）或 `export-anim` | `App.tsx:148-159` |
| 激活态 | `background: var(--accent)` + `color: var(--accent-text)` + `borderColor: var(--accent)` | `PlanPanelToggles` |
| 图标库 | `lucide-react`，工具栏 `size={12~13}`，卡片 `size={18}`，标题 `size={15}`，加载态 `<Loader2 size={13} className="aispin" />` | 全站 |
| 下拉条 | 原生 `<select>`，全局 CSS 统一 hover `scale(1.04) rotate(-1.5deg)`；批量条内下拉 `padding 2 / fs 11 / radius 4` | `App.tsx:184-185` |
| 表格 | `fontSize 12 / borderCollapse collapse`；容器 `overflowX auto + 1px solid var(--border) + radius 6`；表头 `color: var(--text-muted)` | `ReqMatrixPanel:306-311` |
| 关联 chip | `fs 11 / border 1px solid var(--border-strong) / radius 4 / padding 0 4px`；>14 字截断 | `ReqMatrixPanel:402-412` |
| 危险色 | `--danger`；成功色 `--success`；弱化 `--text-muted` | 全站 |
| 通知 | 内联 `notice` 短文本（fs 11, accent）或 `<output className="flash-toast">` | `App.tsx:146-147` |
| 确认 | `import { askConfirm } from '../ui/dialogs'` | `ReqMatrixPanel:3` |
| 弹窗 | 原生 `<dialog open>`；**禁止**遮罩点击关闭 / Esc 关闭（Sonar S6847），必须保留显式关闭按钮 | `docs/SonarQube质量修复报告-2026-09-19.md:39` |
| 无障碍 | 图标-only 按钮**必须**同时具备 `title`（中文，支持 `\n` 两行浮层）+ `aria-label` + 展开类带 `aria-expanded` | `ReqMatrixPanel:273-278` |
| 悬浮显隐 | 批量条等次要控件用 `span.op-host` 包裹 `.op-hidden`（默认隐藏、悬浮/聚焦显示） | `App.tsx:204-205` |
| 路由层校验 | 手写 `typeof` 收窄（`wrap` / `optStr` / `pid` 三件套），不引入 zod 到 HTTP 层 | `plans.ts:14-41` |

### 9.2 本期新增的一致性要求

1. **按钮顺序**：所有"容器级操作"（筛选/导出/刷新/收起）统一居右，顺序为 多选 → 批量条 → 功能 → 导出 → 刷新 → 收起。
2. **术语统一**：全站统一称「测试用例」「需求」「关联需求」「覆盖度」，不出现「案例」「用例项」「tracing」等混称。
3. **文案语气**：与 `ReqMatrixPanel` 一致——祈使句短句，tooltip 第一行一句话概括、第二行补充约束或后果。
4. **加载态**：任何 >300ms 的操作必须显示 `Loader2 aispin`，禁用按钮并把 `cursor` 改为 `default/wait`。
5. **空态必须给出口**：不能只说「暂无数据」，必须指明下一步 action 路径。

---

## 10. 导出样式规范（「内置技能」口径澄清）

### 10.1 先厘清概念（避免实现误解）

调研发现：项目里的 `xlsx-trae` / `docx-trae` / `pdf-trae` / `pptx-trae` 这四个"内置技能"名，**在代码库中没有任何实现文件**。它们只存在于两处：

- `ReportService.ts:75` 起的 `SKILL_BY_FORMAT` 常量（`{ name, desc }` 两个字符串），用途是把版式要求**写进 LLM prompt**；
- `report-builder.ts` / `prdExport.ts` 中的**硬编码版式常量**与注释。

即：**所谓「导出样式使用内置技能」= 遵循 `xlsx-trae` / `docx-trae` 的版式规范常量，实际合成仍由 Node 服务端 `exceljs` / `docx` 完成。** 没有任何外部 CLI / Python / MCP 调用参与。本期沿用同一口径，不做架构变更。

### 10.2 版式标准（测试用例模块采用「规范 A」）

项目现存 **3 套互不一致**的导出样式：

| 规范 | 用于 | 表头填充 | 斑马纹 | 边框 |
|---|---|---|---|---|
| A 浅色 `xlsx-trae` | 报表、**需求跟踪矩阵** | `EAF2FF` 加粗 | `F7F9FC` | `D9DEE7` thin 全边框 |
| B 深蓝 `FF1F4E79` 白字 | 项目计划/模板 | 深蓝 | 无 | 仅底边框 |
| C 无样式 | 任务导出 | 仅加粗 | 无 | 无 |

**裁决：测试用例导出统一采用规范 A**，理由是它与需求跟踪矩阵同源（`prdExport.ts:198` 起的 `buildMatrixXlsx`），两张表业务上成对流转（矩阵 + 用例），必须视觉一致。同时趁本期把 A 的参数抽成共享常量 `server/src/util/exportStyle.ts`，供矩阵导出与用例导出共用，减少第三份拷贝。

### 10.3 三种格式产出定义

**Excel（.xlsx）**
- Sheet 1「测试用例」：列 = 用例编号 / 所属模块 / 用例标题 / 前置条件 / 测试步骤 / 预期结果 / 测试数据 / 后置条件 / 优先级 / 类型 / 执行方式 / 状态 / 执行结果 / 关联需求编号 / 关联需求标题
- Sheet 2「需求覆盖率」：`需求编号 / 需求标题 / 用例数 / 是否覆盖`，未覆盖行整行 `--` 并标注
- 表头行1：统计行（`项目：X ｜ 用例 N 条 ｜ 覆盖 x/y（z%）｜ 导出时间`），加粗
- 冻结前 2 行（`views: [{ state:'frozen', ySplit: 2 }]`），自动筛选 `autoFilter`
- 列宽对齐 `MATRIX_COLUMNS` 风格；中文字体默认，步骤列 `wrapText: true` + 行高自适应

**Word（.docx）**
- 一级标题 = 需求（`REQ-001 用户登录`），其下二级标题 = 所属模块，再下为用例表格
- 用例表格：`TableRow` 两列（字段 / 值）；**步骤**用独立表格（序号 / 操作 / 预期结果），表头 `shading: { fill: 'EAF2FF' }` 加粗（对齐 `prdExport.ts:81-96`）
- 文末追加「覆盖率汇总」表格

**Markdown（.md）**
- `# 测试用例 - {项目名}` → 元信息 → `## REQ-001 需求标题` → `### TC-001 用例标题` → 字段列表 → 步骤表格
- 参考 `TaskExportService.ts:44-59` 与 `PlanService.exportMarkdown` 的既有排版习惯

---

## 11. 非功能需求

| 项 | 要求 |
|---|---|
| 性能 | 列表服务端分页（默认 200/页，可切 500/全部）；N+1 禁止（步骤 `WHERE case_id IN (...)` 一次取、覆盖度一次 `GROUP BY`）；**仅「全部」模式 >1000 条时启用虚拟滚动**（分页模式不会触发，勿过度设计）；导出套 `exportGate`；`exceljs`/`docx` 动态 import |
| AI 稳定性 | 分块生成 + 截断重试；预算 ≥8192 tokens，超时 300s；失败不丢已成功部分 |
| 幂等 | 重复生成同一 PRD 不产生重复用例（`source_key` + `source_hash`）；各级修改一律采用 `if (!has) push` 式幂等写法（对齐 `linkRequirement`） |
| 数据一致 | 用例 ↔ 步骤、需求 → 用例的删除全部走 `db.transaction()`；删除需求时级联删用例并在**确认弹窗明示条数** |
| 无障碍 | 见 §9.1 无障碍行；表格列头用 `<th>` 且带语义；`<dialog>` 必须有显式关闭按钮 |
| i18n | `web/src/i18n.ts` 为渐进式底座（`t(key, fallback)` + `registerDict`）：新模块**不改 `dicts` 对象**，在模块内 `registerDict('en', {…})` 注册本模块英文键；调用处写 `t('导出', '导出')` 形式，未命中自动回落中文；本期只出中文 |
| 兼容 | Electron（`api://mtask` 协议）与浏览器（`/api`）双通路——统一走 `api.getBinary` / `api.postDownload`，不写死 fetch |
| 质量 | 改动文件不得新增 Sonar 阻断项；单函数圈复杂度 ≤ 15（工具条/行渲染沿用现有「S3776 抽取子组件」范式，避免 `PlanPage` 那种巨型组件） |

---

## 12. 实施计划（文件级改动清单）

| # | 文件 | 动作 |
|---|---|---|
| 1 | `server/src/db/schema.ts` | 追加 `test_cases` / `case_steps` DDL + 3 个索引 |
| 2 | `server/src/util/testCaseEnums.ts` | 新建：枚举单源 + 中文标签 |
| 3 | `server/src/util/exportStyle.ts` | 新建：抽取 xlsx-trae 版式常量（HEAD_FILL/ZEBRA_FILL/THIN + 应用函数） |
| 4 | `server/src/services/TestCaseService.ts` | 新建：CRUD / batch / coverage / reorder / duplicate / importDraft（含事务与 `notifyChange('plans')`） |
| 5 | `server/src/services/testCaseExport.ts` | 新建：`buildCaseXlsx` / `buildCaseDocx` / `buildCaseMd` |
| 6 | `server/src/routes/plans.ts` | 追加 6.x 全部路由（**静态路径先于 `/:id`**） |
| 7 | `server/src/skills/testcase-generate/**` | 新建 SKILL.md + 3 个 references |
| 8 | `server/src/services/TestCaseGenService.ts` | 新建：pipeline + 分块 + 覆盖校验 + 输出预算常量 |
| 9 | `server/src/routes/index.ts` | 注册 SSE `POST /plans/testcase-generate-stream` |
| 10 | `server/src/mcp/server.ts` | 新增 `mtask_list_testcases` / `mtask_update_testcases` |
| 11 | `web/src/pages/TestCasePanel.tsx` | 新建：视图主体 |
| 12 | `web/src/pages/PlanPage.tsx` | `PlanPanelToggles` 增按钮 + `useSessionState('plan.showTestCases')` + 面板挂载 + 矩阵下钻状态 |
| 13 | `web/src/pages/ReqMatrixPanel.tsx` | 增「用例」列（chip 显示数量 + 点击下钻）+ 跳转生成按钮 + 删除确认提示用例数 |
| 14 | `web/src/pages/TestCaseGenPanel.tsx` | 新建：AI 卡片面板（输入区 + 草稿视图） |
| 15 | `web/src/stores/testCaseGenStore.ts` | 新建：SSE 日志 store |
| 16 | `web/src/pages/ReportPage.tsx` | `reportCards` 增第 6 项 + `panelSetters`/`panelOpen`/`cardStatus` 扩展 |
| 17 | `web/src/pages/ReportConsole.tsx` | 新增 `TEST_CASE_GEN_TAB` 标签页与内容渲染 |
| 18 | `web/src/ui/consoleReset.ts` | `ARTIFACT_SESSION_KEYS` 追加 `tcgen.draft` 等 |
| 19 | `web/src/pages/guides.tsx` | `REPORT_STEPS` 追加一步（可选） |
| 20 | `server/scripts/` + `docs/` | 新增回归脚本与验收报告 |

**迭代建议**

- **P0（首迭代）**：#1-#6、#11-#13 —— 用例视图 CRUD + 批量 + 导出 + 矩阵下钻（不依赖 AI）
- **P1（次迭代）**：#7-#10、#14-#19 —— AI 生成链路
- **P2**：虚拟滚动、执行结果与缺陷联动、测试轮次（Test Run）

---

## 13. 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 项目管理页工具条「需求跟踪矩阵」按钮后出现「测试用例视图」按钮，样式/动画/激活态与相邻按钮一致 | 目视 + 悬浮/点击实感一致 |
| A2 | 用例增删改查可用：顶部输入新增、行内编辑编号/标题/模块、select 改优先级/类型/状态/执行结果、删除带确认 | 手工清单逐项走通 |
| A3 | 每条用例可编辑 0~N 条步骤（操作 + 该步预期结果），步骤可增删排序 | 手工 + 刷新后数据仍在 |
| A4 | 需求跟踪矩阵每行显示「用例 N」chip，点击查看该需求的用例；用例侧「关联需求」chip 可反向跳转 | 双向跳转各 3 次无误 |
| A5 | 多选模式下批量改优先级/类型/状态/所属需求、批量复制、批量删除、批量导出均生效 | 每项 ≥2 条样本验证 |
| A6 | Excel/Word/Markdown 三格式导出成功，Excel 含「需求覆盖率」子表，样式与需求跟踪矩阵导出同源 | 打开三份产物逐项核对 |
| A7 | AI 工作台出现「从 PRD 生成测试用例」卡片，图标/排版/重置按钮/状态徽标与其余 5 卡一致 | 目视 + 状态流转验证 |
| A8 | 支持内部 PRD 选择与外部文件上传，两类可共存，确认后才触发 | 两条通道各验证一次 |
| A9 | 生成全过程在 AI 控制台滚动输出阶段日志（≥6 条阶段），可中断 | 观察日志 + 点「停止」 |
| A10 | 生成结果进草稿视图，显示覆盖率、未覆盖可补生成，勾选/编辑/删除后再确认入库 | 一次完整流程 |
| A11 | **覆盖率 100%**（或缺失项有明确告警标注），关联关系正确（每条用例指向正确 REQ） | 抽样 10 条用例核对所属需求 |
| A12 | 同一份 PRD 二次生成不产生重复用例 | 重复跑一次，用例总数不变 |
| A13 | 切换任意菜单再返回，面板展开态、筛选、分页、多选、AI 草稿均保持 | §7.1 全部会话键逐一验证 |
| A14 | `npx tsc --noEmit` 与打包通过，无新增 Sonar 阻断 | CI 结果 |
| A15 | 删除带用例的需求时，确认弹窗明示「将一并删除 N 条测试用例」 | 手工验证 |

---

## 14. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **AI 输出截断导致用例静默缺失** | 高 —— 用户以为生成完了 | 分块生成（≤5 需求/块）+ 预算 ≥8192 + 截断自动重试 + 覆盖率兜底校验 + 控制台显式 warn（历史教训：务必先看 stage 日志的 error） |
| 用例数量爆炸导致列表卡顿 | 中 | 服务端分页 + 索引 + 虚拟滚动阈值；禁止照抄 `listRequirements` 的全量返回 |
| 删除需求连带删用例造成数据损失 | 中 | 确认弹窗明示条数；后续可升级为「解除关联 + 标记孤儿」而非物理删除 |
| 导出样式第四份拷贝 | 低 | 本期抽出 `exportStyle.ts` 共享常量，矩阵导出一并 migrate 引用 |
| 巨型组件重蹈 `PlanPage`（210KB）覆辙 | 中 | 强制拆分子组件（工具栏 / 表格 / 行 / 批量条 / 步骤编辑器 / 导出菜单），单文件 ≤600 行 |
| 同一仓库并发诉求导致源码行号漂移 | 中 | 编辑脚本带位置断言；修改前先 md5 取证（历史教训） |
| 生产实例构建滞后使新 MCP 参数被 zod 静默剥离 | 中 | 任何新上报参数必须做**落库断言**，不止步于「调用成功」 |

---

## 15. 后续路线图（不在本期范围）

1. **测试轮次 / Test Run**：选定用例集合 → 分配执行人 → 记录每条用例在某轮次的结果（届时 `case_results` 表承载，`last_result` 降级为派生字段）。
2. **自动化对接**：导入 JUnit / Playwright XML 结果，反向回写每条用例的 `pass/fail`。

3. **缺陷联动**：失败用例一键创建 MTask 待办（`tasks`），回填 `task_no` 到用例。
4. **需求逆向生成**：从已有用例反推未覆盖需求，产出「缺口测试建议」。
5. **移动端**：`web/src/mobile` 下提供只读/执行视图。

---

## 附录 A：调研来源清单

- TestRail 官方 Blog《How to Write and Organize Manual Test Cases》《Test Scenario vs Test Case》
- TestRail Support《Test case templates》（Text / Steps / Exploratory / BDD / AI Evaluation）
- GitHub `metersphere/metersphere`（v3.x）—— AI 生成功能用例/接口用例、需求双向关联
- GitHub `ecamuto/thorotest` —— 统一手工/自动化时间线、9 种导入器幂等迁移、coverage bar
- Kiwi TCMS —— API 优先、Tagging、版本化
- TestLink 1.9.x —— 需求↔用例 traceability（UI 陈旧作为反面教材）
- Squash TM —— 覆盖度量与 Campaign 规划
- TestPlanIt —— 从 issue/requirement/文档 AI 生成用例

## 附录 B：项目内既有资产索引（本期复用）

| 资产 | 路径 |
|---|---|
| 需求矩阵视图 | `web/src/pages/ReqMatrixPanel.tsx` |
| 需求矩阵 Service | `server/src/services/PlanService.ts`（`listRequirements` 1743 / `linkRequirement` 1835） |
| 需求矩阵导出 | `server/src/services/prdExport.ts:171-229` |
| PRD 导入面板 | `web/src/pages/PrdImportPanel.tsx` |
| PRD 生成 Service | `server/src/services/PrdGenService.ts`（`skillDir` / `loadWorkspaceContext` / `buildRetrieveBlock`） |
| 内置技能目录 | `server/src/skills/prd-generate/` |
| 导出并发闸 | `server/src/util/export-gate.ts` |
| 下载工具 | `web/src/utils/download.ts` |
| 会话状态 | `web/src/ui/session.ts`（`useSessionState`） |
| 运行状态徽标 | `web/src/ui/runStatus.tsx` |
| 控制台重置 | `web/src/ui/consoleReset.ts` |
| 确认弹窗 | `web/src/ui/dialogs.ts`（`askConfirm`） |
| 变更广播 | `server/src/services/ChangeBus.ts` |
| 历史测试报告 | `docs/T00707-PRD导入与需求跟踪矩阵测试报告.md` |
| 压测基线 | `perf/config/jmeter-config-2026-09-18.yml:356` |
