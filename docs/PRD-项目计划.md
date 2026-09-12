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
