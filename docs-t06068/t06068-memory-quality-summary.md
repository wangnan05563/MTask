# T06068 记忆评估摘要

- 评估对象：产品 `mtask` 的 62 条基线记忆；当前 64 条，新增 2 条不混入 62 条统计。
- 数据源：`C:\Users\hspcadmin\AppData\Roaming\MTask\data\mtask.db`，只读。
- 代码基线：`D:\code\otherProjects\MTask`，HEAD `6938059213875ef1c41753574d2131a48d25bf9d`。

## 评分结果

| 等级 | 条数 | 占比 |
|---|---:|---:|
| A 优质 | 7 | 11.3% |
| B 合格 | 24 | 38.7% |
| C 待优化 | 29 | 46.8% |
| D 应清理 | 2 | 3.2% |

平均分 70.0；最高 97，最低 43。维度均分：准确性 3.9、完整性 3.9、冗余度 3.9、时效性 3.2、可复用性 2.8。

## 关键数据

- 类型：project 55、reference 3、feedback 4、user 0。
- 来源：tool_output 59、manual 1、inferred 1、auto 1；无 user_said。
- 43/62 条 `access_count=0`，从未被召回。
- 57/62 条 `project_id` 为 NULL；5 条非空里 4 条非法，仅 1 条是真实项目 id。
- 来源任务 36 个；8 个任务贡献 24/62（39%）。
- 186 个不同标签；最高频 `MTask=23`、`UI=10`。
- 53/62 条置信度 ≥0.9；35/62 ≥0.95；5 条为 1.0。
- `memory_review_queue=0`、`memory_review_log=0`，质量评审闭环从未运行。

## 三个 P0

1. **UPDATE + INVALIDATE 替代链断链（已复现）**：旧行 `superseded_by='mem-<taskId>-<i>'`，但 UPDATE 只改原行，不创建该 id；生产唯一失效行走的是 ADD 路径，所以尚未暴露。
2. **项目隔离失效**：`project_id` 直接采用模型输出，未默认当前项目、未校验；92% 产品级共享，4 条非法值。
3. **无事务、先失效后写入**：目标写入失败会留下旧行已失效、新行不存在的半写状态。

## 优先修复

1. 目标先落、旧行后失效，整体事务；`invalidated_at IS NULL` 防重写；`id !== targetId` 防自失效。
2. `project_id` 默认当前项目 + 项目/产品校验；`scope` 显式区分 project/product。
3. `invalidated_ids` 白名单 + 最多 2 条，只允许本次 existing/相似检索返回的 id。
4. 幂等改为 `memory_extract_runs(task_id, result_hash)`；`source_task_id` 只做溯源并强制 UUID。
5. existing 改为相似 top-k（当前全量 ≤200 也可），不再只取最近 50 条。
6. `feedback` 只允许用户纠正/验收；代码变更事实一律 `project`。
7. 类型感知遗忘：`user`/`feedback` 不自动 stale；`project` 到期进复核，不直接失效。
8. `queryForContext` 增加任务 query；相关度优先，类型/时间次之；做多样性。

## 交付物

- 完整报告：`D:\code\otherProjects\MTask\docs-t06068\t06068-memory-evaluation-report.md`
- 逐条评分表：`D:\code\otherProjects\MTask\docs-t06068\t06068-memory-quality-scores.csv`

> 说明：`D:\code\otherProjects\MTask\docs` 是指向 `E:\mtask-build-cache\docs` 的 Junction，E 盘已满（quota free 为负），无法写入新文件；本次报告落在同项目根的 `docs-t06068` 目录，未改动原 docs 目录。
