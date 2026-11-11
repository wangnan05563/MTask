# 项目计划编制与回写（PRD / 概要设计 → 计划 → 项目计划菜单）

> 触发：任务要求「编写项目计划 / 编制项目执行计划 / 拆解 WBS / 输出里程碑与工期」时读取本文件。原则：产出计划文档后必须回写至 MTask「项目计划」菜单（`prd_to_plan.py --plan`），不建散任务刷屏。

> 触发：任务要求「编写项目计划 / 编制项目执行计划 / 拆解 WBS / 输出里程碑与工期」。
> 原则：**产出计划文档后必须回写至 MTask「项目计划」菜单**——不必只在文档里躺着，也不必建成一堆散任务。

### 工具
`scripts/prd_to_plan.py`（随本技能分发；零第三方依赖，Python 3 即可）

```bash
# 1) 只生成计划文档（先预览，不写入）
python scripts/prd_to_plan.py --prd <PRD/SRS.md> --hld <概要设计.md> --out <计划.md> --project <项目名>

# 2) 确认无误后回写至「项目计划」菜单
python scripts/prd_to_plan.py --prd ... --hld ... --out ... --project <项目名> --plan

# 可选：同时把工作项也建为散任务（默认不建）
... --plan --writeback
# 可选：小批量验证 / 不自动串联依赖
... --plan --limit 2
... --plan --no-chain
# 可选：生成任务卡（内嵌 FR 原文+验收准则，供 AI 逐卡自动执行）
... --emit-cards            # 输出到 <计划.md 所在目录>/plan-cards/（W001.md…W0NN.md + INDEX.md）
```

### 回写目标与接口
- **目标**：MTask「项目计划」菜单，工具 `mtask_create_plans`。
- **入参结构（T02131 实测）**：
  - 顶层：`projectId` 或 `projectName`（**必填，否则报「projectId 或 projectName 必填」**）+ `items: [...]`，
    以及关联三件套 `requirements`、`items[].reqNos`、`createTasks`。
  - item 字段：`title`（**唯一必填**）、`description`、`startDate`、`durationDays`、`status`、`assignee`、
    `kind`（normal/milestone/daily）、`complexity`（1~5 整数，越界被 zod 早拒）、`ref`（批内临时标识，供 deps 引用，不落库）、
    `deps[{ref|planId|planTitle, type: serial|parallel|child}]`、`reqNos[]`（需求编号）。
    ⚠ 无 `endDate`/`progress`/`linkedTaskNo` 入参——起止由工期与依赖推导，进度由关联待办派生，改已有条目走 `mtask_update_plan`。
- **两条通道，语义完全不同（务必分清）**：
  | 传参 | 走的服务层 | 落库效果 |
  | --- | --- | --- |
  | 只有 `items`（无 requirements/reqNos/createTasks） | `PlanService.createBatch` | 仅 plan_tasks 行；`req_ids` 空、无待办；≥3 条时回「纯计划通道」孤儿告警 |
  | 带 `requirements` 或 `items[].reqNos` 或 `createTasks` | `PlanService.importPrd`（与页面 PRD 导入同链路） | 矩阵行 + 计划 `req_ids` + `[PRD]` 待办与 `linked_task_id` + 里程碑 child 边/工期汇总；返回 `channel:'prd_import'`、`planRowIds`、`reqNoMap`、`unlinkedReqNos`、`orphanRequirements` |
  **默认走第二条**：需求拆解类回写不带关联就是制造孤儿（四期 K1~K8 12 行即此事故，事后只能整批归档善后）。
- **编号口径**：`reqNo` 项目内唯一，撞存量号自动顺延并回传 `reqNoMap`（原号→落库号），计划仍按你传的原号引用即可挂上；
  增量补录引用**既往已建**的编号同样有效（不必每次重传整张矩阵）。
- **与建散任务的区别**：`--writeback` 走 `mtask_create_task`（任务列表，会刷屏）；`--plan` 走 `mtask_create_plans`（项目计划 WBS，正确归属）。
  传 `createTasks:true` 时由服务端按条目生成 `[PRD] <标题>` 待办并双向关联，比手工建散任务可靠（进度/状态同步链路已通）。

### 关键坑（实测）
1. **列表响应会被截断**：`mtask_list_plans` 返回体超过约 5KB 时 SSE 会在中途断开（末尾 JSON 断在半个字段）。`scripts/mcp-direct-call.py` 只取**最后一个** `data:` 事件，会拿到不完整数据 → **核验条数必须拼接全部 SSE data 事件**，否则会误判（实测：36 条被数成 10 条）。
2. **改/删有工具，别再手工删界面**：`mtask_update_plan`（按 id 或标题改日期/工期/进度/状态/kind/deps，deps 变更会触发排期联动与里程碑包络重算）、`mtask_delete_plan`（**软归档**，可在归档菜单恢复，非硬删）。历史版本此处曾记「无删除/更新工具」，已过期。
3. **回写防重入分两层**：`mtask_create_plans` 默认带 T01868 拦截——本批标题与项目已有计划同名占比 ≥3 条且 ≥60% 时判定「同一份拆解重复回写」直接拒写，确属补录才传 `allowDuplicates:true`；关联通道（importPrd）另有 T01875 口径，撞名默认让号加「（2）」后缀、传 `onDuplicatePlan:'reuse'` 才幂等复用原行（reuse 不改原行 status/progress）。重跑前仍应先 `mtask_list_plans` 核对。
4. `--project` 必须显式传：否则（对 `mtask_create_task`）会被兜底到 `sys-inbox` 收件箱。
5. **回写后必查关联（T02131 口径）**：`mtask_list_plans {projectId}` 逐条看 `reqIds` 是否非空、里程碑行是否有子边；带 `createTasks` 时再 `mtask_list_tasks` 复核 `[PRD]` 待办与计划徽标。任一为空 = 走成了裸通道，当场补 `requirements`/`reqNos` 重写，不要把孤儿留给下一次巡检（K1~K8 是事后 12 行整批归档善后的）。result 里写明「矩阵 N 行 / 计划 M 条（全部带 req_ids）/ 待办 K 条」。

### 自动推进（AI 按计划逐卡执行）

计划回写 + `--emit-cards` 生成任务卡后，AI 可按 WBS 依赖顺序自动推进。核心循环（每轮 = 一条 WBS）：

1. **取卡**：读 `plan-cards/INDEX.md`，按依赖找第一条「所有依赖 done、自身 todo」的 WBS → 读该卡。卡内已内嵌 FR 原文 + 验收准则 + HLD 依据，**无需再翻 PRD**。
2. **对镜**：按卡标题在项目任务列表找到 `[计划] <同标题>` 镜像待办（计划条目与镜像待办 linked_task_id 双向同步）。
3. **闭环**：显式 running → 执行 → 按阶段验证（设计=文档+自检；实现=编译+单测；联调=API 冒烟；验证=**逐条对照卡内 FR 验收准则**）→ 回传 result → done/unread。
4. **同步**：镜像 done 后计划进度自动更新；下一轮取下一条。

约束：
- **执行非幂等**：开工前先查该 `[计划]` 镜像待办是否已有 handle_result / 已 done，避免重复执行。
- **真机受限项**（如 M1 通知捕获、M7 IME 注入类）：本环境无法实测 → verified:false + 缺口单，不要伪验证。
- **PRD 变更对账**：PRD 改动后重跑 `--emit-cards` 刷新任务卡，并 diff「FR 集 ↔ 计划条目集」防漂移；**卡是生成时快照，PRD 变更必须重新生成**。
- 推进节奏建议**半自动起步**（每轮「继续」推一条，人工把关），稳定后再考虑定时自动（automation）或跨模块并行（无依赖项可并行，TeamCreate/子 Agent）。

### 输出标准
计划文档需含：概览（工作项数 / 净工时 / 含缓冲工时 / 起止 / 关键路径）、WBS 表（ID / 工作项 / 模块 / 优先级 / 工时 / 起止 / 依赖 / 关联需求）、里程碑、资源与关键路径、风险登记、假设与约束；缓冲默认 12%（符合 10%~15% 要求），工作项粒度钳制 2~5 人日。

## 适用场景 / 不适用场景

**适用**：
- mtask MCP 已连接，任务以 `Txxxx` 编号存在、需「排查/修复 + 结论回传 + 完成标注」。
- 待办归属当前可访问的工作区（project_id 匹配），可实际读取代码、修改并自检。
- 任务体量可拆为逐条独立处理的单元。

**不适用**：
- mtask MCP 未连接 / 未授权（无法读取任务）。
- 任务依赖人工施测、外部系统或大量实时数据，Agent 无法在本会话独立闭环。
- 用户要求纯只读（不改任何文件）时，不做修复只出结论。
- 任务横跨多个互不相关仓储且无对应环境/凭据，只能输出书面评估。
