# 十期 · Today View 首页看板（T06294）

## 对应需求

| 编号 | 要求 | 本次落点 |
| --- | --- | --- |
| REQ-001 | 打开应用 3 秒内看到今日三组行动卡片，支持直接处理与空态 CTA | 默认 `dashboard` 页改为「今日」首屏；三组卡片 + 每卡空态 + 任务点击直达抽屉 |
| AC-01 | Given 5k 任务库, When 首次打开, Then 3 秒内展示首屏 | 新增 `/api/stats/today` 服务端聚合，只回最多 7 + 5 + 6 条；统计仪表盘下沉为按需展开；5k 内存库门禁实测聚合 18.1ms，真实 3.3k 库浏览器首屏 790ms |
| REQ-026 | WIP 限制、泳道与虚拟化，提升大规模任务管理 | 首页只取有限条数、不拉全量任务；5k 库的候选扫描全部在 SQLite 内完成，前端不承载大数组 |

## 改动

### 服务端

- 新增 `server/src/services/TodayService.ts`：
  - `buildTodayView(db, projectId)` 输出 `today / waiting / running / alerts / summary`。
  - 今日行动池：`archived=0`、`history_at` 为空、`shelved=0`、`status=todo`，且 `pinned=1` 或 `urgent/high`；按置顶 → 优先级 → 最近更新取前 7。
  - 等我处理：未完成任务的 AI 失败 / 未读 / 待裁决 + 已完成未验证 + 近 7 天完成未读；10 天前的完成未读（当前库约 1.8k 条历史积压）不进入首页。最多展示 5 条，同时返回四类信号计数。
  - AI 正在跑：`TodayService` 内部直读最近 50 个 `exec_sessions`（+ `task_ids` 关联任务摘要），active 会话优先；未被会话覆盖但 `ai_state=running` 的任务以「无会话」兜底显示，避免静默运行。**不调用 `ExecSessionService.listSessions()`**，防止每次刷新首页都触发会话停滞写库。
  - 告警：AI 失败任务数；最近 50 个会话中的停滞数；均为当前工作集，不拉历史。
- `server/src/routes/index.ts` 新增 `GET /api/stats/today?projectId=`，`Cache-Control: no-store`；只做只读聚合，停滞状态由既有调度器按周期收敛，首页展示已落库状态。

### 前端

- 新增 `web/src/pages/TodayBoard.tsx` + `todayBoard.css`：
  - 顶部四格摘要（今天做 / 等我处理 / AI 正在跑 / 告警），三组卡片使用 T06287 的 `Card / Badge / Button / EmptyState / Skeleton` 原语。
  - 任务行点击走既有 `focusTaskByNo`，跨项目定位并打开任务抽屉；AI 卡片和告警可切到 `exec-sessions`。
  - 三组全空时给「今天还没有需要你出手的事」CTA；单组空态分别给行动指引。
  - 1200/760 两档响应式：3 列 → 2 列 → 1 列，1280 宽度不横向溢出。
- 重写 `web/src/pages/DashboardPage.tsx`：
  - 页面壳改用 `PageShell + PageHeader + FilterBar`（T06288 口径），标题「今日」，保留项目筛选。
  - `/stats/today` 是首屏唯一必取数据；原统计仪表盘封装为 `StatsSection`，默认不挂载、不请求 `/stats/dashboard`，点「项目统计」才取数，避免统计查询拖慢首屏。
  - 保留原有统计区全部指标与 breakdown，不删既有能力。
- `web/src/api/client.ts` 增加 `TodayView / TodayTaskItem / TodayRunningItem / TodayAlert` 契约。

## 验证

- 类型检查：`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json`、`-p web/tsconfig.json` 均 exit 0。
- 前端构建：`npm run build:web` exit 0（vite 1875 modules，约 1m47s）。
- 5k 任务门禁：`node node_modules/tsx/dist/cli.mjs server/scripts/verify-t06294-today.mts` PASS：
  - 5,264 条任务；`today_candidates=105` → 展示 7 条；`waiting=158`（failed 5 / unread 70 / verify 80 / ruling 3）；`running=3`（2 活跃会话 + 1 无会话兜底）；`alerts=2`。
  - 10 天前 100 条完成未读被排除；项目筛选、无会话 running 兜底、置顶排序均通过。
  - 聚合耗时 **18.1ms**（上一轮 47.1ms，受机器负载波动；含直读 50 个执行会话），远低于 AC-01 的 3s 预算。
- 隔离 API/UI 验收使用生产库副本 + `MTask_PORT=5193`，不改生产库；结果见 `C:\pyfix_tmp\t06294-*.log`、`C:\pyfix_tmp\t06294-ui\`。
  - 真实 `/api/stats/today` 返回 `today=7 / today_candidates=101 / waiting=351 / running=2 / alerts=2`。
  - 浏览器验收：`node scripts/verify-t06294-visual.mjs`，首页 1440/1280/760 三档截图 + 首屏计时 + 横向溢出检查，结果见 `t06294-ui/visual-result.json`；实测首屏数据就绪 **790ms**，三档均无横向溢出，前端无未捕获异常。
  - 证据图：`docs/evidence/p10-ui/23-t06294-today-1440.png`、`24-t06294-today-1280.png`、`25-t06294-today-760.png`；机器可读结果 `docs/evidence/p10-ui/t06294-visual-result.json`。

## 边界

- MTask 任务模型当前没有截止日期与指派人字段，因此「今天做」用置顶 + 紧急/高优先级 + 最近更新作为当前行动信号，页面副标题明确写「从 N 条高优先级中取前 7」；不伪造到期/负责人语义。若后续补 due/assignee，应替换该排序口径而不是叠加。
- 统计仪表盘的数据口径与 UI 原样保留；本次只改变挂载时机（按需展开），不改统计 SQL。
- 本单不新增 Run 表查询 UI；「AI 正在跑」仍读现有 `exec_sessions` 与任务 `ai_state`，Run/RunStep 查询 API 由派生单 T06332 承接。
- AC-01 的浏览器首屏已在真实 3.3k 生产库副本上验证：服务端正常启动维护完成后，首屏数据就绪 790ms；5k 聚合门禁 47.1ms。**冷库首次 API 调用（跳过启动维护、磁盘页缓存全冷）实测 2.8s，仍低于 3s，但浏览器冷启动全链路未单独测**；正常桌面应用启动后的首页首屏为本轮已证据化部分。
