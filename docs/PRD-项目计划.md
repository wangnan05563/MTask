# PRD：项目计划模块（MTask）

> 来源任务：T00431 ｜ 版本：v1.0 ｜ 日期：2026-09-12 ｜ 状态：已实现

## 1. 背景与目标

MTask 现有任务管理以「单条待办」为核心，缺少**项目级时间线视图**：无法按顺序编排一批任务的起止日期、无法以 Excel 批量初始化/交付计划、也无法把计划中的条目与日常待办联动。

本模块新增「项目计划」页（菜单位于**周报前**），提供：

- Excel 批量导入 / 导出（模板化、行级校验、事务写入）
- 动态任务管理（插入/删除后自动串行重排时间线，自动避开周末与节假日）
- 计划任务 ↔ 待办（tasks）状态联动

参考方案（GitHub 调研结论）：

| 参考 | 采纳点 |
|---|---|
| Focalboard（mattn/focalboard，MIT） | 板块内行式计划列表 + 按项目隔离的数据归属 |
| Planka（plankanban/planka，MIT） | 卡片↔列表的状态单向同步（源→镜像），避免双向环 |
| leaky-weekly-report 类周报工具 | Excel 模板列固定 + 行级错误定位反馈的导入交互 |

协议约束：仅使用项目已有依赖（exceljs，MIT），不引入新依赖。

## 2. 数据模型

### plan_tasks（计划任务）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | uuid |
| project_id | TEXT FK→projects | 归属项目，级联删除 |
| title | TEXT NOT NULL | 标题（同项目内导入时查重） |
| description | TEXT | 描述 |
| start_date | TEXT | 起始日 YYYY-MM-DD |
| end_date | TEXT | 结束日（含当天，由开始日+工期按工作日推算） |
| duration_days | INTEGER | 工期（工作日数，≥1） |
| progress | INTEGER | 进度 0-100 |
| status | TEXT | todo / doing / done / blocked |
| assignee | TEXT | 负责人 |
| sort_order | INTEGER | 顺序（时间线按此串行重排） |
| linked_task_id | TEXT | 关联待办 tasks.id（可空） |
| created_at / updated_at | TEXT | ISO 时间戳 |

### holidays（节假日）

| 字段 | 类型 | 说明 |
|---|---|---|
| date | TEXT PK | YYYY-MM-DD |
| name | TEXT | 节假日名称 |

工作日定义：**非周六、周日且不在 holidays 表**的日期。

## 3. 业务流程

### 3.1 时间线串行重排（核心）

计划内任务按 `sort_order` **串行瀑布**编排：任务 N 的开始日 = 任务 N-1 结束日之后的**下一个工作日**。任一任务的开始日/工期被修改、或中间插入/删除任务后，从该位置向后全量重排（`PlanService.rescheduleFrom`）。首任务开始日为用户指定锚点。

### 3.2 Excel 导入

1. 模板下载：`GET /api/plans/template`（含表头 + 1 行示例）
2. 列规范（顺序固定）：`标题* | 描述 | 开始日期* | 工期(工作日)* | 负责人 | 状态`
   - 开始日期：`YYYY-MM-DD`；工期：≥1 整数；状态：todo/doing/done/blocked（默认 todo）
3. 校验：必填、格式、枚举、**同项目标题重复**逐行检查；任何一行失败 → **整体不入库**，返回全部 `{row, message}` 行级错误
4. 全部通过 → better-sqlite3 事务批量写入（5000 行上限）→ 导入后按 sort_order 全量重排时间线

### 3.3 Excel 导出

`GET /api/plans/export?projectId=`：两个 sheet（计划任务 / 节假日），文件名 `项目计划-YYYYMMDD-HHmmss.xlsx`。

### 3.4 待办联动（单向：计划 → 待办）

- 关联：计划任务选择同项目待办 `linked_task_id`；无关联待办时可**一键创建**新待办（接收计划标题/描述）
- 状态同步：计划状态变更时同步关联待办——`done → task done`；`todo/doing/blocked → task todo`（MTask 待办仅 todo/done 两态）
- 解除关联：置 `linked_task_id = NULL`，待办本身不受影响

## 4. 交互与权限

- 菜单：「项目计划」，位于「周报」前（App.tsx TABS）
- 单机单用户系统，无角色区分；页面内项目下拉切换数据范围
- 操作均即时落库；危险操作（删除）前端二次确认

## 5. 约束与边界

- 导入 ≤5000 行/次，超出拒绝
- UTF-8 全链路；导出文件名含时间戳
- 不修改既有菜单/模块逻辑（纯新增）
- 已关联待办被删除时：计划行 `linked_task_id` 由查询时左联检测自动显示「待办已删除」并允许解除/重连

## 6. 验收标准

1. 菜单可见可进，页面按项目展示计划任务
2. 模板下载→填数→导入：合法数据入库且时间线正确；异常数据返回行级错误且库无脏数据
3. 导出文件可用 Excel 打开、内容完整、文件名含时间戳
4. 插入/删除/改工期后时间线自动重排且跳过周末与节假日
5. 计划状态流转联动待办状态；关联/解除关联正常

## 7. 里程碑父子口径与进度聚合（T02090 签字，2026-10-13）

> 本节是 T02042 收口残项的签字结论，替代此前「deps child（T01704/skill）」与「排序区间
> （milestoneDurations / 里程碑汇总）」并存的双口径局面。实现：`util/planDeps`（三型解析）、
> `util/milestoneChild`（child 边纯函数）、`services/milestoneProgress`（聚合与对账）、
> `PlanService.importPrd`（导入补边）、门脚本 `scripts/verify-t02042-milestone-deps.mts`。

### 7.1 口径签字：A——`deps child` 是唯一父子口径

- **父子关系只认 `plan_tasks.deps` 内 `{id:<里程碑id>, type:'child'}`**（子行指向父里程碑）。
  采纳理由：与 T01704 包络重算、依赖图渲染、估算导出 C 列归属同一份结构化数据；
  排序区间（位置切片）会把错位行归错里程碑（实测四期 K1~K8 位置在前、M-K 里程碑在后，
  区间口径会把 K 系列挂到已关闭的「5 联调与验收」上）。
- 排序区间口径**降级为展示汇总**（PlanPage.milestoneMeta，T01621 已注明）与**导入侧工期汇总**
  （milestoneDurations：里程碑工期=其下明细之和），不再作为父子判据。
- PRD 导入必须补 child 边（区间规则：里程碑之后、下一里程碑之前的 normal 行）；存量由
  幂等补边脚本 `tmp/ai-scratch/t02090-backfill-child-edges.mts` 修复（只写 deps，护栏：done 里程碑
  + 未 done 子行不补，避免把历史错位误 regression）。

### 7.2 deps 三型契约

`[{id, type}]`，type ∈ `serial`（严格先后，阻塞排水）｜`parallel`（并发，不阻塞）｜
`child`（结构性归属，**不阻塞排水、不参与日期传播**）。解析单源 `util/planDeps.parsePlanDeps`
（T02090 起保留 child——旧实现把它并成 serial，会造成「等里程碑完成⇄等子任务完成」倒挂卡死）。

### 7.3 进度聚合作业口径

子项 = 指向该里程碑的 child 边的未归档行；`progress = round(done/total×100)`（clamp 0~100）；
全 done → `status=done`+100；部分 done → `doing`；全未 done → `todo`+0；**无子项不动**
（保留人工状态）。聚合作主：人工 PATCH 里程碑 status/progress 后若仍有子项，以子项实况覆盖
（红线：子项未动时里程碑不得 100%——先把里程碑标完成会让后续进度失去意义）。

### 7.4 联动顺序（T00478 类误读面）

里程碑**因聚合翻为 done** 时，关联待办置 `status=done` + `ai_state=unread`（待读）而非静默
done——「已完成」永远有结论档支撑，面板先出未读圆点。仅在「非 done → done」翻转时触发一次。

### 7.5 触发点与对账家族

触发：PlanService.update（status/progress/deps 变更，含里程碑自身）、TaskService
.syncPlanOnStatusChange（任务完成度是聚合输入）、archive/restore（子项进出分母）。
启动对账（T00470 家族）：`reconcileLinkedPlanStatuses`（排除聚合作主的里程碑）→
`reconcileReqStatuses`（T02087）→ `reconcileMilestoneProgresses`（T02090，按子项实况权威收敛）。
