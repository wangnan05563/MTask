# 8 · 里程碑工作流（T01037）

> 仅在「处理到里程碑相关任务 / 计划」时读本文件。前置知识：`references/7-plan-workflow.md`（计划类回写）。

## 一、怎么认出里程碑

| 场景 | 识别方式 |
| --- | --- |
| 待办列表里 | 任务行徽标显示 **里程碑**（蓝框加粗）而不是「计划」——服务端 `TaskService` 带出 `fromPlanKind='milestone'`（T01037） |
| 计划/甘特里 | `plan_tasks.kind === 'milestone'`（另两类：`normal` 普通、`daily` 日常） |
| MCP 取数 | `mtask_list_plans({projectName})` 返回条目含 `kind` 与 `deps` |

里程碑与其下子任务是**两级结构**：子计划的 `deps` 里有 `{"id":"<里程碑计划id>","type":"child"}`。

> **T02090 口径签字（2026-10-13）**：`deps child` 是父子关系的**唯一口径**（PRD-项目计划.md §7.1）。
> 项目管理页「里程碑汇总」的排序区间口径降级为纯展示（T01621），识别子任务时以 child 边为准；
> 无 child 边的存量行用 `scripts/t02090-backfill-child-edges.mts` 补边（幂等）后再按口径 A 作业。

## 二、处理顺序（硬性）

**先子任务，后里程碑。** 里程碑是汇总节点，自己没有可独立交付的内容：

1. 拿到里程碑 → 取子任务：`deps` 含 `type='child'` 且指向该里程碑的条目（口径 A）。
   （无 child 边的老数据先跑补边脚本；区间口径仅作展示参考，不再作为父子判据。）
2. 逐条处理子任务（每条走普通任务闭环：running → 实施 → 验证 → 回传 → done）。
3. **进度由服务端自动聚合（T02090）**：每条子任务完成后，服务端按「子项 done 数/总数」
   自动重算里程碑 `progress` 与 `status`（全 done 才 done；红线：子项未动不得 100%）。
   一般**无需**再手工 PATCH progress；只有当子行缺 child 边（聚合看不到）时才按老办法手工回写。
4. **全部子任务完成后**里程碑自动转 `done`，其关联待办自动置 `done` + `ai_state=unread`（待读）——
   **不要**再手工把里程碑自身的待办标 done（那是 T00478 类「面板显示已完成/结论还没落地」误读面；
   自动通道会带未读圆点，保证「已完成」永远有结论档支撑）。
5. 回传结论里写明：子任务清单与各自处置、里程碑最终状态（自动聚合结果）、关联待办的待读状态。

## 三、必须避开的坑

- **不要把里程碑当普通任务先做完**：里程碑待办一旦 done，「待办 done → 关联 plan done + progress 100」的
  双向同步会把整个里程碑提前完成（子任务还没动就 100%）。T02090 起服务端有聚合守卫：带子项的里程碑
  状态以子项实况为准，人工提前置 done 会被拉回；且自动 done 时关联待办走 `unread`（待读）而非静默 done。
- **不要手工改里程碑工期**：工期 = 其下子任务之和（T01001 二轮），改子任务会自动联动；起止日期取子任务包络（T01704）。
- **不要在里程碑的 description 里堆进度流水**：项目管理页里程碑描述是只读汇总展示；进度只写 `progress` 列（T02090 起该列由聚合自动维护）。
- 子任务里若有不可落地项：照常如实标注，里程碑进度按「可落地部分」计算并在结论里说明未完成情况，
  不要为了让进度到 100 而把 milestone 置 done。

## 四、数据落点备忘

- 计划表 `plan_tasks`：`kind` / `progress` / `status`（`todo|doing|done|blocked`）/ `deps`(JSON) / `linked_task_id`。
- 待办侧：`TaskService.list` 带出 `fromPlanTitle` + `fromPlanKind`（T01037，前端据此显示徽标）。
- REST：`PATCH /api/plans/:id`（progress/status/deps/kind 等）、`GET /api/plans?projectId=`。
