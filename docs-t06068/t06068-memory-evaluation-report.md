# MTask 记忆现状评估、替换逻辑审计与优化路线

> 任务：T06068「MTask 62 项记忆评估、替换逻辑分析及优化建议」
> 评估对象：产品标签 `mtask` 下的 62 条基线记忆；当前库已增至 64 条，新增 2 条另行标注，不混入 62 条统计。
> 数据源：生产库 `C:\Users\hspcadmin\AppData\Roaming\MTask\data\mtask.db`，全程只读；未直接改写生产库。
> 代码基线：仓库 `D:\code\otherProjects\MTask`，HEAD `6938059213875ef1c41753574d2131a48d25bf9d` 及其工作区。
> 报告语言：简体中文。

---

## 0. 结论摘要

### 0.1 一句话结论

MTask 的记忆模块目前更像一个“任务结论知识库”，而不是“可持续学习、可纠错、可隔离的 Agent 记忆系统”：**写入链路完整、安全兜底较好，但项目隔离基本失效、替换链存在可复现断链、检索召回覆盖极低、质量评审闭环从未运行**。

### 0.2 关键数字

| 指标 | 结果 | 判断 |
|---|---:|---|
| 62 条评分 | A 优质 7、B 合格 24、C 待优化 29、D 应清理 2 | 平均 70.0 分；C+D 占 50% |
| 维度均分（5 分制） | 准确性 3.9、完整性 3.9、冗余度 3.9、时效性 3.2、可复用性 2.8 | 时效性与可复用性最弱 |
| 从未被召回 | 43 / 62（69%）`access_count=0` | 记忆近似“只写不读” |
| 项目作用域 | 57 / 62 的 `project_id` 为 NULL；5 条非空里 4 条非法 | 项目隔离基本失效 |
| 来源任务 | 36 个任务；8 个任务贡献 24/62（39%） | 单任务多条、任务级冗余明显 |
| 类型分布 | project 55、reference 3、feedback 4、user 0 | 没有真正的“用户偏好”记忆 |
| 来源分布 | tool_output 59、manual 1、inferred 1、auto 1 | 记忆来自任务结论，不是用户交互 |
| 标签 | 186 个不同标签 / 62 条 | 词表失控，检索不可控 |
| 置信度 | 53/62 ≥0.9；35/62 ≥0.95；5 条为 1.0 | 模型自报置信度饱和，区分度弱 |
| 失效记忆 | 仅 1 条，且是 ADD 路径 | UPDATE 替换路径在生产中几乎未演练 |
| 人工评审 | `memory_review_queue=0`、`memory_review_log=0` | 质量闭环从未运行 |

### 0.3 最重要的三个发现

1. **替换链 P0（已复现）**：当模型对一条既有记忆执行 `UPDATE`，同时把另一条旧记忆放进 `invalidated_ids` 时，旧记忆的 `superseded_by` 被写成 `mem-<taskId>-<i>`，但 UPDATE 只改原行、不会创建这个新 id。结果是旧记忆指向不存在的替代者，审计链断裂。生产库目前只有 1 条失效记忆，恰好走的是 ADD 路径，所以这个缺陷尚未在真实数据中暴露；隔离复现已确认。
2. **项目隔离 P0（数据已证明）**：`project_id` 直接采用模型输出、未校验、未默认当前项目，导致 57/62 条为产品级共享；4 条是非法的 `MTask` / `mem-t05777`；25 个项目共用 `mtask` 产品标签，MTask十期会看到 57 条产品级记忆，其中 13 条来自 MTask八期。项目边界形同虚设。
3. **召回覆盖 P1（数据已证明）**：`queryForContext` 不接受任务语义 query，只按类型/来源/时间排序取通用 top-N；43/62 条从未被选中，说明大量记忆从未进入上下文。记忆写得越多，噪声越大，真正有用的条目越难浮现。

---

## 1. 评估口径与数据基线

### 1.1 62 条如何界定

T06068 创建于 `2026-11-18T14:16:26Z`。按创建时刻回溯，产品 `mtask` 在创建前已存在 62 条有效记忆，最后一条创建于 `2026-11-18T11:27:28.164Z`。创建后 `14:29:04Z` 新增 2 条（T06019 的设置页签与安装版验证），当前有效 64 条。

本报告所有“62 条”统计均以这 62 条为准；两条新增只在“当前状态”处单独说明，不混入口径。

### 1.2 评分方法

五个维度，均为 1–5 分：

| 维度 | 权重 | 5 分含义 | 1 分含义 |
|---|---:|---|---|
| 准确性 | 25% | 已用当前代码/数据复核，事实成立 | 已被当前代码否证或明显错误 |
| 完整性 | 15% | 自足，含背景、边界、结论 | 片段化，离开任务看不懂 |
| 冗余度 | 15% | 同产品内唯一，不重复 | 与同任务/同主题条目高度重叠 |
| 时效性 | 20% | 长期稳定或仍与当前实现一致 | 已被后续任务/代码演进推翻 |
| 可复用性 | 25% | 跨任务可复用的规则/事实 | 一次性实现日志，复用价值极低 |

综合分 =（准确性×0.25 + 完整性×0.15 + 冗余度×0.15 + 时效性×0.20 + 可复用性×0.25）/ 5 × 100。

等级：A ≥85；B 70–84；C 55–69；D <55。

评分不是纯客观测量，但每条的扣分理由都在逐条 CSV 的“评审备注”中写明；A 类尽量用当前代码/数据复核，D 类直接用代码否证。

### 1.3 数据基线补充

- `memories` 表共 99 行，评估时有效 98 行、失效 1 行；`mtask` 产品有效 64 行。
- 62 条类型：`project=55`、`reference=3`、`feedback=4`、`user=0`。
- 62 条来源：`tool_output=59`、`manual=1`、`inferred=1`、`auto=1`；没有 `user_said`。
- 62 条正文长度：最短 69 字、最长 260 字、平均 102 字；仅 1 条超过 120 字（#19），无少于 30 字的条目。
- 62 条标签：186 个不同标签；最高频 `MTask=23`、`UI=10`、`workbuddy=6`、`B0=5`、`T03302=4`、`CodeBuddy=4`、`T06056=4`。
- 62 条来源任务：36 个；8 个任务各贡献 ≥3 条，合计 24/62（约 39%）。
- `project_id`：57 条 NULL；2 条 `MTask`（非法）、2 条 `mem-t05777`（非法）、1 条 `e4d8b042...`（真实项目 MTask九期）。
- `source_task_id`：1 条为 `T05748`（任务号而非 UUID），其余为 UUID；表无外键，非法值不会被数据库拦截。

---

## 2. 62 项质量评分统计

### 2.1 等级分布

| 等级 | 条数 | 占比 | 处置建议 |
|---|---:|---:|---|
| A 优质 | 7 | 11.3% | 保留，作为核心记忆 |
| B 合格 | 24 | 38.7% | 保留，补边界、去任务号、压缩表达 |
| C 待优化 | 29 | 46.8% | 合并、更新或淘汰候选 |
| D 应清理 | 2 | 3.2% | 已被代码否证，应立即失效/重写 |
| 合计 | 62 | 100% | C+D 共 31 条（50%） |

### 2.2 A 类（7 条）

| # | 标题 | 分数 | 保留理由 |
|---|---|---:|---|
| 5 | SDD 文档不在 PRD 反查链路 | 97 | 引用链路事实，跨任务可复用 |
| 6 | 孤儿设计文档实测案例 | 89 | 为 #5 提供实测证据，边界清楚 |
| 19 | 通知弹窗延迟的根因与修复（T05748） | 85 | 根因/修复/提交完整；但 260 字超 W8，应拆两条 |
| 25 | WorkBuddy 最小间隔实机为 1 小时 | 93 | 实机限制，直接影响自动化配置 |
| 41 | B0 网关认证缺失风险 | 93 | 安全风险，长期有效 |
| 49 | 循环任务为生成器非执行器 | 97 | 核心语义，防止用户误解 |
| 57 | AI 工作台卡片图标基准策略 | 88 | 设计决策，可作为后续图标验收基准 |

### 2.3 D 类（2 条，应立即失效或重写）

| # | 标题 | 分数 | 否证证据 |
|---|---|---:|---|
| 16 | listMonitorReady 缺项目过滤 | 43 | 当前 `TaskService.ts:1159-1168` 已有 `projectId` 参数与 `project_id = ?` 过滤；注释明确 `T05741` 增加项目过滤 |
| 17 | 缺 WorkBuddy 专用派发技能模板 | 43 | 仓库已存在 `skills/workbuddy-mtask-dispatch/SKILL.md`，用户目录也有副本；结论已被落地事实否证 |

这两条不是“写得不好”，而是**当前已假**。应软失效并写 `invalidated_reason='superseded-by-code'`，或改写成“T05741/T05739 已补齐，旧缺口关闭”，不要让后续任务继续召回错误结论。

### 2.4 C 类（29 条）的主要形态

- **已被部分演进覆盖**：#8（normalizeWbs 已做章号重映射/全局折叠）、#50（循环任务 7 类缺陷部分已被 T05819/T05820/T05822 修复）、#3（任务号 `T009222` 应为 `T00922`）、#12（`.gitignore` 实际 106 行，记忆写 103 行）。
- **类型误标**：#36、#52 内容属实，但 `type=feedback` 错误；它们描述 UI 变更，应为 `project`。
- **一次性验证注记**：#31“未跑全量测试”是任务当时的 caveat，复用价值低；应改写为稳定规则“全量单测未跑时，UI 实测通过也只能标未验证”，或转入临时质量注记。
- **任务专属实现日志**：#10、#11、#14、#23、#26、#27、#29、#30、#32、#34、#35、#44–#48、#54–#56 等，内容准确但离开任务号就无法复用；应合并为模块级规则或降级为 episodic 记录。
- **产品事实但仍可用**：#2、#20、#21、#22、#24、#33、#37、#38、#39、#40、#42、#43、#53 等，保留但要去掉任务号、补边界。

### 2.5 当前 64 条（附加观察，不计入 62 条统计）

T06019 新增 2 条：

| # | 标题 | 类型 | 评分 | 等级 |
|---|---|---|---|---:|
| 63 | T06019 验证面须用安装版 | project | 93 | A |
| 64 | T06019 设置页签 compact 默认 | project | 71 | B |

若按同口径补评，当前 64 条约 A 8、B 25、C 29、D 2，平均约 70.4。两条新增都来自 T06019，且是同一任务两条；它们再次说明“一个任务可以产出多条实现日志”，也再次触发任务级冗余问题。

> 逐条分数、维度分、处置与评审备注见 `docs-t06068/t06068-memory-quality-scores.csv`；完整 62 行表格见附录 A。

---

## 3. 记忆生命周期全链路

### 3.1 生成与触发

入口：`TaskService.applyUpdateSideEffects` 在 `handle_result` 变化时调用 `scheduleMemoryExtract(task.id, resultText)`；`runExtract` 依次做：

1. `decideExtraction`：任务存在 → 项目存在 → 幂等（`source_task_id` 已有行）→ 项目开关 → 产品绑定 → 可抽取；
2. AI 就绪检查；
3. 同产品进程内串行锁 `runningKeys`；
4. `runRulesExtraction`：只取「根因/修复/验证」三段，调用模型，做 C1 never-store、C2 单任务 ≤5、C3 置信度 ≥0.7、PII 转队列、类型/长度校验；
5. 落库、`enforceCapacity`、`notifyChange`。

结论：生成链路设计完整，安全兜底（never-store、PII 队列、XML 转义、注入隔离）是亮点；但“生成什么”严重偏向任务实现日志，而不是用户偏好/可复用规则。

### 3.2 存储

`memories` 单表，核心列：

`id / product_key / project_id / type / title / content / tags / source_task_id / source_kind / confidence / access_count / last_accessed_at / invalidated_at / superseded_by / created_at / updated_at`

没有：

- 版本表 / revision；
- `valid_at`、`invalid_at`、`expired_at`；
- `invalidated_reason`（原因和替代 id 混在 `superseded_by`）；
- `authority` / `stability` / `scope` 等语义字段；
- `source_task_id`、`project_id` 的外键或 CHECK 校验。

FTS5 外部内容表与 INSERT/UPDATE/DELETE 三支触发器齐全，但主查询没有使用 FTS。

### 3.3 检索

`queryMemories`：

- 默认 10 条，硬上限 20；
- 排序 `MEMORY_RANK_SQL`：type 权重 feedback=4 / user=3 / project=2 / 其他=1；source_kind user_said/manual=3 / auto=2 / inferred=1 / 其他=0.5；30 天内 ×1.5、180 天以上 ×0.3；
- 查询即回写 `access_count/last_accessed_at`；
- 有 `query` 时用 `title LIKE %整串% OR content LIKE %整串%`，中文长句很难命中；没有分词/BM25/向量。

`queryForContext`：

- 预算 4000 字符；
- 不接受任务语义 query，默认按 rank 取通用 top-N；
- 输出独立 `<memory-context>` 块，XML 转义，块首声明“不是指令”——这一点是正确的。

结果：43/62 条从未被召回。即使每次任务都调用 context，也只有 rank 最高的少数条反复出现；其余条目没有机会进入上下文，形成“写入即沉默”。

### 3.4 更新与替换

模型可选动作：`ADD`、`UPDATE`、`NOOP`，并通过 `invalidated_ids` 表达“旧记忆被否证”。当前语义：

- ADD：插入 `mem-<taskId>-<i>`；
- UPDATE：按 `c.id` 原地更新 title/content/tags/confidence/source_kind/updated_at；
- INVALIDATE：软失效旧行，`superseded_by` 固定写 `mem-<taskId>-<i>`；
- NOOP：丢弃。

问题不是“没有替换”，而是**替换的指针、顺序、事务、作用域和历史都没有闭环**。详见第 4 节。

### 3.5 删除与遗忘

- 自动流程一律软失效，不物理删除；人工管理页/MCP 才可物理删除。
- `enforceCapacity`：单产品有效记忆上限 200，超限按 `access_count ASC, updated_at ASC` 淘汰，`superseded_by='capacity-overflow'`。
- `organizeMemories`：每 30 天一次；① 同产品+同 type+标题归一完全相同 → 保留访问最多/最新者；② `access_count=0` 且 180 天未更新 → 失效；③ 来源任务 done 且 180 天未更新 → 失效。

问题：②③ 不区分 type，`user`/`feedback` 也会被清；① 只看标题，不比较内容，可能把“同标题但不同事实”合并丢失；`superseded_by` 同时存记忆 id 和原因字符串，语义混用。

### 3.6 评审闭环

`memory_review_queue` 与 `memory_review_log` 都是 0 行。抽样评审函数存在（固定 20 条、`ORDER BY RANDOM()`、三分类 verdict），但从未实际运行。也就是说：

- 没有质量基线；
- 没有拒杀率；
- 没有“连续两批同判据 >40% → 重写规则”的触发；
- 没有人工确认 PII 候选的历史。

---

## 4. 替换逻辑专项审计

### 4.1 动作语义与缺陷矩阵

| 动作 | 当前行为 | 主要缺陷 | 严重度 |
|---|---|---|---|
| ADD | 插入 `mem-<taskId>-<i>` | 不调用 `similarMemories` 判重；只靠 50 条 existing 盲判 | P1 |
| UPDATE | 原地覆盖；id 不变 | 不保留旧版本；不更新 source_task_id/type/project_id；替代链指向不存在 id | P0/P1 |
| INVALIDATE | 软失效旧行；`superseded_by` 固定为新 id | 只对 ADD 正确；不校验 id；无数量上限；可自失效；可重写已有失效记录 | P0/P1 |
| NOOP | 丢弃 | 不写幂等标记；若整轮全是 UPDATE/NOOP，下一次同任务会重跑 | P1 |

### 4.2 P0-1：UPDATE + INVALIDATE 替代链断链（已复现）

代码路径：

- `MemoryRulesService.ts:197-202`：对每个 `invalidated_ids` 执行
  `UPDATE memories SET invalidated_at=?, superseded_by=? WHERE id=? AND product_key=?`，
  其中 `superseded_by` 固定为 `mem-${args.taskId}-${i}`。
- `MemoryRulesService.ts:203-209`：如果 `c.action==='UPDATE' && c.id`，只更新 `c.id` 这一行，然后 `continue`。
- `MemoryRulesService.ts:210-215`：只有 ADD/UPDATE 失败退化时才插入 `mem-${args.taskId}-${i}`。

因此，当候选是“UPDATE 目标行 + invalidated_ids 指向另一条旧行”时：

1. 旧行被失效，`superseded_by='mem-task-i'`；
2. 目标行被更新，但 `mem-task-i` 从未创建；
3. 旧记忆指向一个不存在的替代者，审计链断裂；图谱 `supersede` 边也画不出来。

隔离复现（临时库，不碰生产）结果：

```json
{
  "old": {
    "id": "mem-old",
    "invalidated_at": "2026-11-18T15:12:06.228Z",
    "superseded_by": "mem-t-combo-0"
  },
  "target": {
    "id": "mem-target",
    "title": "目标结论",
    "content": "新内容",
    "invalidated_at": null
  },
  "link": null,
  "deterministicRowExists": false
}
```

现有门禁 `scripts/verify-t04114-memory-rules.mts` 是 14 pass / 0 fail，但它把 UPDATE 和 INVALIDATE 分开测：UPDATE 用例只断言 id/title 变化，INVALIDATE 用例只测 ADD 路径。**组合路径没有测试，所以缺陷一直没暴露。**

### 4.3 P0-2：project_id 未校验/未默认当前项目，项目隔离失效

代码路径：

- `MemoryRulesService.ts:195`：`const projectScope = c.project_id ?? null;`
- `MemoryRulesService.ts:210-215`：INSERT 直接写 `projectScope`。
- `runRulesExtraction` 明明接收了 `args.projectId`，却没有把它作为默认值；模型不输出 `project_id` 时就落 NULL。
- `project_id` 也没有校验是否属于当前产品/项目。

数据结果（62 条基线）：

| project_id | 条数 | 说明 |
|---|---:|---|
| NULL | 57 | 产品级共享，所有项目可见 |
| `MTask` | 2 | 非法，不是项目 id |
| `mem-t05777` | 2 | 非法，看起来是记忆 id/任务号片段 |
| `e4d8b042-0808-43df-bb11-a630e8ee9e56` | 1 | 真实项目 MTask九期 |

按“来源任务所属项目”统计：48 条来自 MTask十期、13 条来自 MTask八期、1 条无法 join（`source_task_id='T05748'`）。

影响：

- `mtask` 产品下 25 个项目共用同一批产品级记忆；MTask十期会看到 57 条产品级记忆，其中 13 条来自 MTask八期；
- 记忆作用域 `project_id IS NULL OR project_id = ?` 本意是“产品级共享 + 本期特有”，但 92% 是 NULL，等于没有项目隔离；
- 非法 `project_id` 不会被 SQL 拦截（表无外键），只会让该条记忆在按项目查询时“消失”或错误出现。

### 4.4 P0-3：无事务、先失效后写入，可能半写

`runRulesExtraction` 对每个候选逐条执行 `UPDATE`/`INSERT`，没有 `db.transaction` 包裹；`INVALIDATE` 又发生在目标行写入之前。任何后续 INSERT/UPDATE 失败（约束、磁盘、进程中断）都会留下：

- 旧记忆已失效；
- 新记忆不存在；
- `superseded_by` 指向不存在目标。

容量淘汰和月度整理用了事务，但抽取主链路没有。替换是跨行写操作，必须原子化。

### 4.5 P1-1：invalidated_ids 无校验、无上限、可自失效

`MemoryRulesService.ts:198` 直接遍历模型给的数组：

- 不校验 id 是否在 `existing`/相似集合中；
- 不校验是否属于当前产品之外的项目；
- 不限制数量；
- 不排除 `c.id` 本身（UPDATE 目标可能被自己失效，更新成功但行已不可召回）；
- 不检查 `invalidated_at IS NULL`，重复失效会覆盖原失效时间/替代者，破坏审计。

模型幻觉可以一次失效一批无关记忆。应改为“只允许失效本次 existing/相似检索返回的 id，最多 1–2 条，且不得等于目标 id”。

### 4.6 P1-2：UPDATE 原地覆盖，丢失历史与溯源

`UPDATE` 只改 title/content/tags/confidence/source_kind/updated_at：

- 不保留旧版本，无法回答“之前是什么、为什么改”；
- 不更新 `source_task_id`，新结论的溯源仍指向旧任务；
- 不更新 `type`/`project_id`，模型即使给出新类型/项目也被忽略；
- `access_count` 继承旧值，新事实继承旧热度；
- 与 prompt 的 W7“变更留痕”直接矛盾。

长期看，应该“新增 revision + 关闭旧 revision 的有效期”，而不是原地覆盖。

### 4.7 P1-3：幂等键与输出耦合，任务结果变更后不再抽取

`runExtract` 与 `runRulesExtraction` 都用：

```sql
SELECT 1 FROM memories WHERE source_task_id = ? LIMIT 1
```

作为幂等判据。后果是双向的：

- 如果首轮全是 UPDATE/NOOP/queued/dropped，没有新行，幂等标记不存在；同一任务再次回传会重跑，可能重复抽取；
- 如果首轮存了任意一条，后续该任务结果发生实质变化，也永远不再抽取；新结论只能靠人工补，旧记忆继续存在。

此外，`source_task_id` 允许任务号：62 条中 1 条为 `T05748`，导致 `JOIN tasks t ON t.id=m.source_task_id` 失败，月度整理的任务归档规则也跳过它。

正确做法是新增 `memory_extract_runs(task_id, result_hash, status, created_at)`，按“任务 + 结果哈希”判幂等；`source_task_id` 只做溯源，并强制为任务 UUID。

### 4.8 P1-4：existing 只取最近 50 条，且不使用相似检索

`MemoryRulesService.ts:148-150`：

```sql
SELECT id,title,content,type FROM memories
WHERE product_key=? AND invalidated_at IS NULL
ORDER BY updated_at DESC LIMIT 50
```

62 条基线中有 12 条对抽取模型不可见；模型只能凭最近 50 条做 ADD/UPDATE/INVALIDATE，容易重复 ADD 或错过该更新的旧条目。

`similarMemories` 已实现 FTS5 + LIKE 兜底，但抽取链路从未调用。Mem0 论文的更新阶段会对每个候选检索 top-10 相似记忆，再让模型选动作；MTask 现在是“50 条最近记忆 + 盲判”，信息更少、噪声更大。

### 4.9 P1-5：上下文注入没有任务语义，召回覆盖极低

`queryForContext(scope, opts)` 直接调用 `queryMemories(scope, opts)`；MCP/Skill 侧通常只传产品/项目与 `context=true`，不传 query。于是：

- 排序只看类型/来源/时间，不看当前任务；
- 最近 30 天的 project 记忆 ×1.5，容易把“刚写完的实现日志”顶上来；
- 4000 字符预算下，真正相关的条目可能被挤出；
- 查询即访问，只有被选中的条目 `access_count` 增加，43/62 条永远为 0。

这解释了“记忆很多、但任务里感觉没用”的根因：不是没有记忆，而是召回没有任务相关性。

### 4.10 P1-6：月度整理的类型盲区与标题合并风险

`organizeMemories`：

- ② `access_count=0 AND updated_at<cutoff`：不区分 type，`user`/`feedback` 也会被失效；
- ③ 来源任务 done 且 180 天未更新：同样不区分 type；
- ① 只按 `product_key + type + title.trim().toLowerCase()` 分组，不比较内容；同标题但不同事实会被合并，保留访问最多/最新的一条，另一条直接失效；
- `superseded_by` 被写成 `organize:stale` / `organize:task-archived` / `capacity-overflow` 原因字符串，与“记忆 id”混用。

在 180 天后，43 条 zero-access 记忆会被批量清掉；如果其中包含用户偏好或关键反馈，属于不可逆损失（虽然软失效可审计，但默认不再召回）。

### 4.11 P1-7：类型体系失真，feedback 被当作 UI 变更标签

62 条中 `feedback=4`，但没有一条来自 `user_said`：

- #15 滚动误关弹层：UI 交互规则；
- #31 未跑全量测试：验证 caveat；
- #36 归档页签优化：UI 变更；
- #52 卡片头去冗余：UI 变更。

`memoryTypes.ts` 的定义是 `feedback=反馈纠正`，应只表示用户纠正/验收规则；当前被用来装“从任务结论里总结的 UI 规则”。这会让 feedback 在排序中获得 4 分权重，压过 project 事实，进一步扭曲召回。

同时 `user=0`：系统没有真正的“用户偏好”记忆。MTask 记忆模块当前只学习“项目发生了什么”，没有学习“用户希望怎样工作”。

### 4.12 P1-8：source_kind / confidence 由模型自报，排序可被操纵

- `source_kind` 直接采用模型输出，只要在枚举内就接受；抽取自工具结果却可标 `user_said`/`manual`，从而获得 3 倍溯源权重。
- `confidence` 由模型自报，53/62 ≥0.9、35/62 ≥0.95、5 条为 1.0；置信度已经饱和，无法区分“确证事实”和“模型推测”。
- 置信度只做 `>=0.7` 门槛，没有校准、没有来源约束、没有人工复核。

### 4.13 P2 级问题

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P2-1 | 标签失控 | 186 个标签 / 62 条；抽取路径 `JSON.stringify(c.tags.slice(0,5))` 不 trim/不去重/不校验类型 | 标签检索不稳定，同义标签分裂 |
| P2-2 | W8 长度不一致 | prompt 要求 30–120 字；代码 `MAX_CONTENT_CHARS=400`；#19 为 260 字 | 长条目未拆，违反写法规则 |
| P2-3 | C2 单任务 5 条 + 任务集中 | 8 个任务贡献 24/62；T06056 4 条、T05795 4 条、T05210 4 条 | 单任务多条，任务级冗余 |
| P2-4 | 评审闭环未运行 | `memory_review_queue=0`、`memory_review_log=0` | 无质量基线、无拒杀率、无规则迭代 |
| P2-5 | 主查询不用 FTS | `queryMemories` 用 LIKE 整串；`similarMemories` 才用 FTS | 中文检索命中差，相似判重能力未进入主链路 |
| P2-6 | 图谱边依赖失效指针 | `buildMemoryGraph` 的 supersede 边只在 `superseded_by` 命中有效集时连边 | 断链时图谱丢边，审计视图不完整 |
| P2-7 | 失效原因与替代 id 混用 | `superseded_by` 同时存记忆 id、`capacity-overflow`、`organize:stale` | UI/图谱/统计无法区分“被谁替代”与“为何失效” |

---

## 5. 根因归纳

1. **产品语义混用**：把“任务结论知识库”直接命名为“记忆”。真正的记忆应分 user / feedback / project / reference，并区分语义记忆、情景记忆、程序性记忆；当前 55/62 是 project，0 条 user。
2. **写入时让模型做全量 diff，但给不起 diff 所需上下文**：只给最近 50 条、无相似检索、无时间/权威/项目元数据，模型只能凭标题和内容猜 ADD/UPDATE/INVALIDATE。
3. **数据模型缺少历史与时间**：原地 UPDATE、只有 `invalidated_at`、没有 revision / valid_at / invalid_at / expired_at，无法表达“何时为真、何时被替代、为什么”。
4. **作用域依赖模型自愿输出**：`project_id` 不由系统默认、不校验，导致 92% 产品级共享、非法值混入。
5. **替换没有事务与指针解析**：先失效、后写入，`superseded_by` 固定拼新 id，只对 ADD 成立。
6. **没有召回评估**：没有“是否被召回/是否被采用/是否被纠正”的闭环，43/62 零访问无人察觉。
7. **没有质量评审**：抽样、verdict、拒杀率代码都有，但从未运行；规则无法迭代。
8. **安全做得比质量好**：never-store、PII 队列、XML 转义、注入隔离都在；但“记什么、怎么替换、怎么召回”仍是初版。

---

## 6. 外部调研：开源框架与一线产品

### 6.1 开源框架对比

| 方案 | 架构/写入 | 检索 | 冲突/遗忘 | 优点 | 代价/局限 | 对 MTask 的启示 |
|---|---|---|---|---|---|---|
| **Mem0 OSS v3** | 单次 LLM 调用，**ADD-only**；先检索 top-10 相关记忆做去重上下文，再批量嵌入、MD5 去重、批量插入 | semantic + BM25 + entity 三路混合 | 新旧事实并存，由检索排序决定“当前”；应用显式 update/delete | 写入成本低、延迟约减半；官方称 LoCoMo +20、LongMemEval +26 | 不自动解决矛盾；旧事实会累积；图记忆移到 Platform | MTask 不必在每次写入做重型 diff；可改为“在线 ADD-only + 离线整合” |
| **Mem0 论文版（v1）** | 两阶段：抽取候选 → 对每个候选检索 top-10 相似记忆 → LLM 选 ADD/UPDATE/DELETE/NOOP | 向量相似 top-s | UPDATE 覆盖、DELETE 删除 | 精度高、语义一致 | 两次 LLM 调用，成本/延迟高；对相似检索质量依赖大 | MTask 当前是“论文版的退化版”：四动作有了，但只给 50 条最近记忆，没有 top-10 相似检索 |
| **Zep / Graphiti** | 时序知识图谱；每条事实边带 `valid_at`、`invalid_at`、`created_at`、`expired_at` | 图 + 向量/关键词 | 新事实矛盾时关闭旧事实有效期，保留旧事实与 source episode | 双时间轴、可回答“某时点真相”、审计强 | 图模型复杂、写入/维护成本高 | 直接参照：MTask 应补 `valid_at/invalid_at` 与 revision，不要原地覆盖 |
| **LangChain / LangGraph** | 短期记忆 = thread checkpoint；长期记忆 = 跨 session store，按 namespace 组织 | 向量/内容过滤 | 更新可走 hot path 或 background；类型分 semantic / episodic / procedural | 分层清晰，适合会话型 Agent | 不内置冲突策略；需要自己设计 | MTask 应至少区分“任务情景记忆”和“跨任务语义/规则记忆” |
| **Letta / MemGPT** | core memory（常驻上下文、可编辑块）+ recall memory（完整对话历史）+ archival memory（外部库） | 工具调用检索 | agent 自主读写；sleep-time compute 空闲整理 | 上下文工程清晰；常驻核心 + 外部归档 | 复杂度高、需要 agent 工具协议 | 可借鉴“小核心常驻 + 大库归档 + 空闲整理”，不要把 64 条全塞进同一层 |

关键事实来源：

- Mem0 v3 迁移文档：`https://docs.mem0.ai/migration/oss-v2-to-v3`（ADD-only、top-10 去重、hybrid search）。
- Mem0 论文：`https://arxiv.org/html/2504.19413`（两阶段、top-s=10、ADD/UPDATE/DELETE/NOOP）。
- Zep 双时间轴：`https://www.getzep.com/blog/context-graphs-two-timelines-every-fact/`；论文 `https://arxiv.org/pdf/2501.13956`。
- LangChain Memory 概览：`https://docs.langchain.com/oss/python/concepts/memory`。
- Letta Agent Memory：`https://www.letta.com/blog/agent-memory`。

### 6.2 一线产品对比

| 产品 | 记忆机制 | 用户控制 | 冲突/遗忘 | 对 MTask 的启示 |
|---|---|---|---|---|
| **ChatGPT Memory** | 两套：Saved memories（用户明确要求/自动保存）+ Chat history reference（从历史对话持续合成） | Memory summary 可查看、编辑、纠正、删除；可关闭；Temporary Chat 不读不写 | 关闭后旧记忆按计划删除；删除聊天不等删 saved memory；纠正可“Don't mention this again” | MTask 缺“记忆摘要 + 一键纠正 + 关闭开关”；记忆页只有 CRUD |
| **Claude Memory** | 每个 project 独立 memory space；memory summary 汇总，可查看/编辑/reset；incognito chat 不读写 | 细粒度控制；项目边界作为安全护栏 | 项目隔离优先；敏感对话不进入记忆 | MTask 已有 product/project 作用域，方向对；但 92% 产品级共享，项目边界没有真正生效 |
| **文心一言 / 文小言 / GenFlow** | 文小言上线“记忆个性化”（喜好/职业/性格）；GenFlow3.0 内置记忆中心，从历史规划/任务形成长期记忆，用户可主动补充工作偏好 | 用户可补充偏好；具体管理细节公开有限 | 公开资料未给出完整冲突/遗忘算法 | 启示：记忆应围绕“用户偏好 + 历史任务”两层；MTask 当前只有任务结论，没有用户偏好层 |

来源与证据强度：

- ChatGPT：OpenAI Help Center “Memory in ChatGPT”“What is Memory?”等（`http://www.shturl.cc/c8f0e599a8b0db882339013c75a9858b`、`http://www.shturl.cc/d7b401302858019f2eb69571411f8c89`、`http://www.shturl.cc/7e145c8bd51682e93381829062697ba5`）。官方文档，证据强。
- Claude：`https://claude.com/blog/memory`。官方博客，证据强。
- 文心/文小言：`http://m.toutiao.com/group/7410709245852647963/`（文小言记忆个性化）；`https://view.inews.qq.com/a/20251219A0660000`（GenFlow3.0 记忆中心）。公开报道/访谈，证据中等，未把它写成确定算法结论。

### 6.3 最佳实践（可直接对照）

1. **分层**：短期会话记忆、跨任务语义记忆、情景记忆、程序性规则分开；不要用一张表装所有东西。
2. **写入时只做必要判断**：要么 ADD-only + 离线整合（Mem0 v3），要么“候选 + top-k 相似检索 + 四动作”（Mem0 论文）；不要用“50 条最近记忆”做全量 diff。
3. **不可变历史**：更新不覆盖旧版本；用 revision / valid_at / invalid_at 表达时间。
4. **冲突显式化**：新事实与旧事实矛盾时，关闭旧事实有效期，保留旧事实与来源，而不是删除或静默覆盖。
5. **作用域系统默认**：项目级记忆默认写当前项目；只有明确标记的产品级事实才共享。
6. **检索任务化**：用任务标题/描述/标签构造 query；语义 + 关键词 + 实体/标签混合；控制预算与多样性。
7. **类型感知遗忘**：user/feedback 不自动过期；project/reference 到期先复核，不直接失效。
8. **用户可见可控**：记忆摘要、查看/编辑/删除、关闭开关、临时会话（参考 ChatGPT/Claude）。
9. **质量闭环**：抽样评审、拒杀率、召回率、stale rate、人工纠正率；用数据改 prompt。
10. **来源与置信度校准**：source_kind 由系统产生，confidence 用人工/结果反馈校准，不让模型自报即生效。

---

## 7. 差距分析

| 维度 | MTask 现状 | 最佳实践 | 差距 | 优先级 |
|---|---|---|---|---|
| 分层 | 单表，project 55 / feedback 4 / user 0 | semantic / episodic / procedural 分层 | 没有情景记忆与程序性规则层；用户偏好层为空 | P1 |
| 写入 | 50 条 recent + 四动作 | top-k 相似检索 + 四动作，或 ADD-only + 整合 | 上下文不足，模型盲判 | P0/P1 |
| 历史 | UPDATE 原地覆盖 | revision + 双时间轴 | 无变更历史，无法审计 | P0 |
| 作用域 | 57/62 product-level；4 条非法 project_id | 默认当前项目，系统校验 | 项目隔离基本失效 | P0 |
| 替换 | `superseded_by` 固定拼新 id；无事务 | 先落目标、后失效、事务、指针校验 | 已复现断链与半写风险 | P0 |
| 检索 | 类型/来源/时间排序；无任务 query | 任务化 hybrid retrieval | 43/62 零召回 | P1 |
| 遗忘 | 180 天 type-agnostic；容量淘汰不看类型 | 类型感知 + 复核 | 可能误清 user/feedback | P1 |
| 质量 | review queue/log = 0 | 抽样 20、拒杀率、回归基线 | 闭环未运行 | P1 |
| 用户控制 | 管理页 CRUD | 摘要/纠正/关闭/临时会话 | 缺产品层控制 | P2 |
| 安全 | never-store、PII 队列、XML 转义 | 同等或更强 | 这块做得好，保持 | — |

---

## 8. 短期优化：清洗与规则调整

> 原则：先修数据完整性与隔离，再改抽取规则，最后才做检索/架构。短期不做大重构，先用可回滚的小步修复把“错误记忆、断链、跨项目污染”止住。

### 8.1 一次性数据清洗（生产库需备份 + 维护窗口）

建议按以下顺序执行；每一步先只读核对，再事务写入；不要物理删除，统一软失效并写原因。

1. **备份**：复制 `mtask.db` 到独立目录，记录清洗前计数。
2. **修正 source_task_id**：把 `T05748` 解析为真实任务 UUID；校验所有 `source_task_id` 是否存在于 `tasks.id`，不存在的置 NULL 并标记 `invalid_source`。
3. **回填 project_id**：对 `project_id IS NULL` 的记忆，按 `source_task_id` 关联 `tasks.project_id` 回填；只把确实跨项目的“产品级事实”保留为 NULL，并增加 `scope='product'` 语义（后续 schema）。
4. **修正非法 project_id**：`MTask`、`mem-t05777` 按来源任务项目回填；无法解析的置 NULL 并标记待复核。
5. **类型纠正**：#36、#52 改为 `project`；#15、#31 复核后决定 `project` 或 `feedback`；确保 `feedback` 只保留“用户纠正/验收规则”。
6. **失效/重写 D 类**：#16、#17 软失效，原因 `superseded-by-code`；或改写成“已由 T05741/T05739 补齐”的新事实。
7. **更新部分过时 C 类**：#8 改为当前 `normalizeWbs` 的章号回退/重映射 + 全局折叠；#50 删除已修复项，只保留仍存在的缺陷；#3 修正 `T00922`；#12 修正 `.gitignore:106`。
8. **合并任务簇**：T06056 4 条 → 1–2 条；T05795 4 条 → 2 条；T05210 4 条 → 2 条；T05739 3 条 → 1–2 条；T05778 3 条 → 1–2 条；T06004 3 条 → 1 条；T05816 3 条 → 1 条；T05754 3 条 → 1–2 条。合并时保留“结论 + 边界”，删除任务过程细节。
9. **标签归一**：建立受控词表（产品/模块/类型/主题），去掉纯任务号标签；每条最多 5 个，trim、去重、小写。
10. **开启评审**：从清洗后的 62 条随机抽 20 条，按 `worth/not_worth/poor_writing` 记录；建立第一批基线。

SQL 只读核对示例（不要直接在生产执行写入）：

```sql
-- 作用域异常
SELECT m.id, m.title, m.project_id, m.source_task_id, t.project_id AS task_project
FROM memories m
LEFT JOIN tasks t ON t.id = m.source_task_id
WHERE m.product_key = 'mtask'
  AND m.invalidated_at IS NULL
  AND (m.project_id IS NULL OR m.project_id NOT IN (SELECT id FROM projects));

-- 来源任务异常
SELECT m.id, m.title, m.source_task_id
FROM memories m
LEFT JOIN tasks t ON t.id = m.source_task_id
WHERE m.product_key = 'mtask' AND m.invalidated_at IS NULL AND t.id IS NULL;
```

回填示意（必须先备份、先 dry-run、再事务）：

```sql
BEGIN;
UPDATE memories
SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = memories.source_task_id)
WHERE product_key = 'mtask'
  AND project_id IS NULL
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = memories.source_task_id);
COMMIT;
```

### 8.2 替换逻辑的最小代码修复

#### 修复 1：先落目标，再失效旧行，整体事务

```ts
const targetId =
  c.action === 'UPDATE' && isValidExistingId(c.id, existing)
    ? c.id
    : `mem-${args.taskId}-${i}`;

const allowed = new Set(existing.map(e => e.id));
const toInvalidate = (Array.isArray(c.invalidated_ids) ? c.invalidated_ids : [])
  .filter(id => allowed.has(id) && id !== targetId)
  .slice(0, 2);

const tx = db.transaction(() => {
  if (c.action === 'UPDATE' && isValidExistingId(c.id, existing)) {
    // update target first
  } else {
    // insert target first
  }
  for (const oldId of toInvalidate) {
    db.prepare(`UPDATE memories
      SET invalidated_at = ?, superseded_by = ?
      WHERE id = ? AND product_key = ? AND invalidated_at IS NULL`)
      .run(now, targetId, oldId, pk);
  }
});
tx();
```

关键点：目标先存在，旧指针才有意义；任何一步失败，整体回滚；`invalidated_at IS NULL` 防止重写已有失效记录；`id !== targetId` 防止自失效。

#### 修复 2：项目作用域默认当前项目 + 校验

```ts
const requestedProject = c.project_id === undefined || c.project_id === null
  ? args.projectId ?? null
  : String(c.project_id);

if (requestedProject && !projectExistsInProduct(requestedProject, pk)) {
  dropped.push({ title, reason: 'project_id 不属于当前产品' });
  continue;
}
const projectScope = requestedProject;
```

更彻底的做法：prompt 输出 `scope: 'project' | 'product'`，`project_id` 只作为 `scope=project` 时的可选覆盖；默认 `project`，只有明确 `product` 才写 NULL。

#### 修复 3：invalidated_ids 白名单 + 上限

```ts
const allowed = new Set(existing.map(e => e.id));
const invalidatedIds = (c.invalidated_ids ?? [])
  .filter(id => allowed.has(id) && id !== c.id)
  .slice(0, 2);
```

只允许失效本次上下文里出现过的 id；最多 2 条；不得等于 UPDATE 目标；不满足的记 `dropped`，不静默。

#### 修复 4：幂等改为“任务 + 结果哈希”

```sql
CREATE TABLE IF NOT EXISTS memory_extract_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- running | done | failed
  created_at TEXT NOT NULL,
  UNIQUE(task_id, result_hash)
);
```

抽取前查 `(task_id, result_hash)`，同一结果只跑一次；结果变化允许重跑。`source_task_id` 仍写任务 UUID，用于溯源，不再承担幂等职责。

#### 修复 5：existing 改为“相似 top-k”，不再只取 50 条最近

- 对每个候选/每个分区调用 `similarMemories(scope, title + content, { limit: 10 })`；
- 把返回的 id/title/content/type/updated_at/confidence/project_id 给模型；
- 当前产品只有 64 条，可直接把全部 active 记忆（≤200）给模型；规模变大后再切 top-k。

#### 修复 6：类型/来源后校验

```ts
// feedback 只能来自用户纠正/验收；代码变更事实一律 project
if (c.type === 'feedback' && sourceKind !== 'user_said') c.type = 'project';
if (c.type === 'user' && !['user_said', 'manual'].includes(sourceKind)) c.type = 'project';
```

`source_kind` 由调用方决定：抽取链路固定 `tool_output`；模型输出只作参考，不参与排序权重。

#### 修复 7：类型感知保留期

- `user` / `feedback`：不自动 stale，不参与容量淘汰的前排；
- `project`：180 天未更新 → `need_review`，进入复核队列，不直接失效；
- `reference`：可 365 天复核；
- `superseded_by` 只存记忆 id；新增 `invalidated_reason` 存 `capacity-overflow` / `organize:stale` / `organize:task-archived`。

#### 修复 8：上下文注入任务化

`queryForContext` 增加 `query` 参数，由任务标题/描述/标签构造；排序改为“相关度优先，类型/时间次之”；预算内做 MMR/多样性，避免同一任务 4 条霸占上下文。

### 8.3 62 条处置清单（按动作分组）

| 动作 | 条目 | 说明 |
|---|---|---|
| 立即失效/重写 | #16、#17 | 已被当前代码/仓库否证；写 `superseded-by-code` |
| 更新事实 | #8、#50、#3、#12 | 代码/行号/任务号已变化；更新后保留 |
| 类型纠正 | #36、#52；复核 #15、#31 | feedback 误标为 project；feedback 只留用户纠正 |
| 合并压缩 | T06056 #59–62；T05795 #38–41；T05210 #9–12；T05739 #16–18；T05778 #29–31；T06004 #54–56；T05816 #46–48；T05754 #25–27 | 每簇保留 1–2 条“结论 + 边界”，删除过程细节 |
| 保留补边界 | B 类 24 条 | 去掉任务号/提交号，补“适用条件/失效边界” |
| 保留 | A 类 7 条 | 作为核心记忆；#19 拆成两条 |

> 逐条动作见 CSV 的“处置”列；本表只列需要优先人工处理的簇。

### 8.4 验收门（短期必须通过）

1. **组合替换门**：`UPDATE + invalidated_ids` 后，旧行 `superseded_by` 必须等于被更新的目标 id，且目标行存在、未失效。
2. **事务门**：模拟目标写入失败，断言旧行没有被失效（整体回滚）。
3. **作用域门**：候选未给 `project_id` 时，落当前项目；非法 project_id 被 drop；产品级记忆必须显式标记。
4. **幂等门**：同任务同结果第二次跳过；同任务不同结果允许重跑；`source_task_id` 全部为 UUID。
5. **召回门**：用任务标题/描述查询，top-10 至少命中 1 条相关记忆；zero-access 比例下降。
6. **清洗门**：62 条中 0 条非法 project_id、0 条非 UUID source_task_id、D 类全部失效/重写、类型分布与人工复核一致。
7. **评审门**：review log ≥20 行，能计算拒杀率。

现有 `verify-t04114-memory-rules.mts` 14 pass / 0 fail，但缺组合路径；短期应先补第 1、2 条门。

---

## 9. 长期架构路线

### 9.1 分层记忆模型

建议把“记忆”拆成三层，仍共用作用域与安全守卫：

| 层 | 内容 | 生命周期 | 示例 |
|---|---|---|---|
| Semantic memory | 跨任务稳定事实、用户偏好、项目规则 | 长期，人工/高置信才淘汰 | “WorkBuddy 最小间隔 1 小时”“B0 `--auth none` 有风险” |
| Episodic memory | 单任务过程、根因、修复、验证 | 中期，任务归档后降权/摘要 | “T06056 停滞阈值冲突根因” |
| Procedural memory | 工作流规则、验收门、提示词/Skill 规则 | 长期，版本化 | “UI 验证必须用安装版”“全量单测未跑只能标未验证” |

当前 55/62 是 project，其中大量是 episodic；应迁到 episodic 层，避免污染 semantic 检索。

### 9.2 数据模型升级

建议新增/调整：

- `memory_kind`：semantic / episodic / procedural；
- `scope`：product / project / task；
- `valid_at`、`invalid_at`、`expired_at`（参考 Zep 双时间轴）；
- `revision`、`supersedes`、`superseded_by`、`invalidated_reason`；
- `authority`（user_said / manual / tool_output / inferred）；
- `last_verified_at`、`verified_by`；
- `memory_revisions` 表：每次更新新增 revision，旧 revision 关闭有效期；
- `memory_extract_runs`：任务 + 结果哈希幂等；
- `memory_events`：召回/采用/纠正/删除，用于评估。

### 9.3 写入策略

推荐两条路线，按规模选择：

- **小规模（当前 64 条）**：两阶段“候选 + top-k 相似 + 四动作”，但把 top-k 从“最近 50 条”改为“相似 top-10 + 全量 ≤200”；写入事务化；UPDATE 生成 revision。
- **规模变大后**：在线 ADD-only（Mem0 v3 思路）+ 离线整合（去重、合并、冲突关闭）；在线只负责“记住”，离线负责“整理”。

无论哪条，都必须：

- 目标先写、旧行后失效；
- 事务；
- 指针校验；
- `project_id` 默认当前项目；
- `source_kind` 系统产生；
- 类型后校验；
- 记录 extract run。

### 9.4 检索策略

1. 任务化 query：任务标题 + 描述 + 项目 + 模块标签；
2. 混合检索：FTS/BM25 + 向量 + 标签/实体；
3. 重排：相关度、类型、权威、时间衰减、项目匹配；
4. 多样性：同一来源任务最多 1–2 条，避免任务簇霸屏；
5. 预算：4000 字符内，按“核心规则 > 相关事实 > 情景案例”排序；
6. 评估：召回率、采用率、纠正率、zero-access 比例。

### 9.5 遗忘与冲突

- `user`/`feedback` 永不自动过期；
- `project` 到期进入复核，不直接失效；
- `reference` 可较长保留；
- 冲突：新事实关闭旧事实 `invalid_at`，保留旧事实与 source；不物理删除；
- 容量：保护 user/feedback/procedural，优先淘汰低访问的 episodic；
- 所有失效写 `invalidated_reason`，`superseded_by` 只存 id。

### 9.6 产品层

- 记忆摘要页：按 semantic / episodic / procedural 分组；
- 用户可编辑/删除/纠正；
- “不要再提这条”；
- 项目级开关与临时会话；
- 记忆变更审计：谁、何时、为什么、替代了谁；
- 评审工作台：抽样 20、三分类、拒杀率、规则重写建议。

### 9.7 路线图

| 阶段 | 时间 | 交付 | 验收 |
|---|---|---|---|
| Phase 0 数据完整性 | 0–2 周 | 组合替换事务、project 默认/校验、source_task_id 校验、幂等表、62 条清洗 | 第 8.4 节 1–4、6 门通过 |
| Phase 1 分层与生命周期 | 2–6 周 | memory_kind/scope、revision、类型感知保留、评审闭环 | semantic/episodic 分离；review log ≥20；stale 不误清 user/feedback |
| Phase 2 检索 | 6–10 周 | 任务化 query、FTS/BM25 + 向量、MMR、召回指标 | 相关命中率提升；zero-access 降到 <30% |
| Phase 3 时间与整合 | 10–16 周 | valid_at/invalid_at、冲突关闭、离线整合、图谱 | 能回答“某时点真相”；断链 0；冲突可审计 |
| Phase 4 产品化 | 16 周+ | 记忆摘要、用户纠正、临时会话、评估看板 | 用户可控制；质量指标可观测 |

---

## 10. 验收与复现

### 10.1 本报告已完成的验证

- 62 条基线计数：`created_at <= 2026-11-18T11:27:28.164Z` 时 `mtask` 有效记忆 = 62；当前 = 64。
- 评分表：62 行，A7/B24/C29/D2，平均 70.0。
- 代码核对：#16 已被 `TaskService.ts:1159-1168` 否证；#17 已被仓库 Skill 否证；#8/#50 部分过时；#3/#12 笔误/行号错误；#36/#52 类型错误。
- 组合替换复现：`old.superseded_by='mem-t-combo-0'`，该 id 不存在；`target` 已更新；`link=null`。
- 现有门禁：`verify-t04114-memory-rules.mts` 14 pass / 0 fail，但未覆盖组合路径。
- 数据统计：57/62 project_id NULL；4 条非法；48/13/1 来源项目分布；43/62 zero access；186 tags；53/62 confidence ≥0.9；review queue/log = 0。

### 10.2 复现脚本

- `D:\code\otherProjects\MTask\.workbuddy\t06068-evidence\t06068-mem-overview.js`：分布统计。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-evidence\t06068-export-memories.js`：导出 64 条有效记忆到 JSON/CSV。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-evidence\t06068-memories.json` / `.csv` / `-readable.txt`：62 条基线 + 2 条新增明细。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-score.js`：评分与 CSV/MD 生成。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-memory-quality-scores.csv`：62 条逐条评分。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-repro-update-supersede.mts`：组合替换断链复现。
- `D:\code\otherProjects\MTask\.workbuddy\t06068-source-map.js`：来源任务映射。

### 10.3 未验证/边界

- 外部产品的内部算法无法完全核实：ChatGPT/Claude 只依据官方文档；文心/GenFlow 依据公开报道，具体冲突/遗忘实现未公开，报告中未写成确定结论。
- 62 条评分为人工规则评分，不是模型自动评分；分数用于排序和处置，不替代人工复核。
- `project_id` 回填建议依赖 `source_task_id` 可解析；`T05748` 需先解析为 UUID，否则该条只能人工判断。
- 本次未直接修改生产库，未执行清洗 SQL；所有清洗动作需在维护窗口、备份后执行。
- 交付路径说明：`D:\code\otherProjects\MTask\docs` 是指向 `E:\mtask-build-cache\docs` 的 Junction，E 盘 quota free 为负、无法写入新文件；本次报告落在同项目根的 `docs-t06068`，未改动原 docs 目录。

---

## 11. 结论

MTask 记忆模块的“安全底座”是合格的：never-store、PII 队列、XML 转义、注入隔离、软失效审计都已具备。真正的问题在“记忆观”：

- 它记录的是任务实现过程，不是跨任务可复用的知识与用户偏好；
- 它把项目作用域交给模型自愿填写，导致项目隔离失效；
- 它用原地 UPDATE 和固定拼 id 表达替换，导致断链与历史丢失；
- 它没有任务化召回，43/62 条从未进入上下文；
- 它没有质量评审，规则无法迭代。

短期先把“数据完整性 + 作用域 + 替换事务 + 幂等”四条修好，再补“类型感知保留 + 任务化召回 + 评审闭环”；长期再走向“分层记忆 + 双时间轴 + 混合检索 + 用户可控”。不建议先做向量库或图谱，否则会把当前的脏数据、错作用域和断链一起放大。

---

## 附录 A：62 项逐条评分表

| # | 记忆标题 | 类型 | 准确性 | 完整性 | 冗余度 | 时效性 | 可复用 | 综合分 | 等级 | 处置 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 记忆抽取前置产品标签 | project | 4 | 4 | 3 | 4 | 3 | **72** | B 合格 | 保留并补边界 |
| 2 | 批量绑定产品标签修复 | project | 4 | 4 | 3 | 4 | 2 | **67** | C 待优化 | 合并/更新/淘汰候选 |
| 3 | 未验证统计口径偏差根因 | project | 3 | 4 | 4 | 3 | 3 | **66** | C 待优化 | 合并/更新/淘汰候选 |
| 4 | ReportCard可点击语义由内嵌button承担 | project | 5 | 5 | 4 | 4 | 3 | **83** | B 合格 | 保留并补边界 |
| 5 | SDD文档不在PRD反查链路 | reference | 5 | 5 | 4 | 5 | 5 | **97** | A 优质 | 保留 |
| 6 | 孤儿设计文档实测案例 | reference | 5 | 5 | 3 | 5 | 4 | **89** | A 优质 | 保留 |
| 7 | flex子项省略号失效根因 | project | 4 | 4 | 4 | 4 | 3 | **75** | B 合格 | 保留并补边界 |
| 8 | normalizeWbs去重失效致多套WBS并列 | project | 4 | 4 | 4 | 2 | 4 | **72** | B 合格 | 保留并补边界 |
| 9 | T03302 弹窗 role 缺失 | project | 5 | 4 | 4 | 3 | 3 | **76** | B 合格 | 保留并补边界 |
| 10 | T03302-U03行内按钮包裹文本 | project | 4 | 4 | 4 | 3 | 2 | **66** | C 待优化 | 合并/更新/淘汰候选 |
| 11 | T03302-U18切项目数据未落定 | project | 4 | 4 | 4 | 3 | 2 | **66** | C 待优化 | 合并/更新/淘汰候选 |
| 12 | scripts/tests被gitignore忽略 | project | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 13 | T05708缩略图放大失效根因 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 14 | T05708回归测试覆盖范围 | project | 4 | 4 | 3 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 15 | 滚动误关弹层修正策略 | feedback | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 16 | listMonitorReady缺项目过滤 | project | 1 | 4 | 4 | 1 | 2 | **43** | D 应清理 | 失效/重写 |
| 17 | 缺WorkBuddy专用派发技能模板 | project | 1 | 4 | 4 | 1 | 2 | **43** | D 应清理 | 失效/重写 |
| 18 | 缺按平台角色令牌 | project | 4 | 5 | 4 | 4 | 4 | **83** | B 合格 | 保留并补边界 |
| 19 | 通知弹窗延迟的根因与修复（T05748） | project | 5 | 4 | 4 | 4 | 4 | **85** | A 优质 | 保留 |
| 20 | B0网关AuthError识别机制 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 21 | 统计仪表盘多维聚合缺口 | project | 4 | 4 | 4 | 4 | 3 | **75** | B 合格 | 保留并补边界 |
| 22 | 仪表盘聚合性能取舍 | project | 4 | 4 | 4 | 4 | 3 | **75** | B 合格 | 保留并补边界 |
| 23 | 预制卡自动填充字段 | project | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 24 | 厂商属性独立于协议 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 25 | WorkBuddy最小间隔实机为1小时 | reference | 5 | 5 | 4 | 4 | 5 | **93** | A 优质 | 保留 |
| 26 | T05782失败样本平台归属澄清 | project | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 27 | T05781并发冲突分支证据边界 | project | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 28 | T05780空态与错误态分离策略 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 29 | T05778双击标题开详情抽屉 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 30 | 更多菜单新增查看详细信息 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 31 | T05778验证未跑全量测试 | feedback | 4 | 4 | 4 | 3 | 1 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 32 | T05789移除设置页顶部图标 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 33 | T05790记忆图谱交互补齐 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 34 | T05792 ReportPage头部重构 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 35 | T05792 会话页按钮精简 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 36 | T05808归档页签优化 | feedback | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 37 | T05767 卡片去状态徽标 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 38 | B0 CodeBuddy本地网关配置 | project | 4 | 4 | 3 | 4 | 4 | **77** | B 合格 | 保留并补边界 |
| 39 | B0成功E2E验收 | project | 4 | 4 | 3 | 3 | 3 | **68** | C 待优化 | 合并/更新/淘汰候选 |
| 40 | B0失败回退A机制 | project | 4 | 4 | 3 | 3 | 3 | **68** | C 待优化 | 合并/更新/淘汰候选 |
| 41 | B0网关认证缺失风险 | project | 5 | 5 | 4 | 4 | 5 | **93** | A 优质 | 保留 |
| 42 | Trae A 通道适配器架构边界 | project | 4 | 5 | 4 | 4 | 4 | **83** | B 合格 | 保留并补边界 |
| 43 | B0网关认证风险 | project | 4 | 4 | 3 | 3 | 3 | **68** | C 待优化 | 合并/更新/淘汰候选 |
| 44 | ReqPage低频操作收进更多菜单 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 45 | PromptsPage 低频操作收进更多菜单 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 46 | ReportConsole消息气泡设计 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 47 | ReportConsole生成态动效 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 48 | ReportConsole滚动跟随控制 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 49 | 循环任务为生成器非执行器 | project | 5 | 5 | 4 | 5 | 5 | **97** | A 优质 | 保留 |
| 50 | 循环任务链路7类缺陷 | project | 4 | 4 | 3 | 2 | 4 | **69** | C 待优化 | 合并/更新/淘汰候选 |
| 51 | 循环任务tick精度修复 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 52 | T05810 卡片头去冗余保留Logo | feedback | 3 | 4 | 4 | 3 | 2 | **61** | C 待优化 | 合并/更新/淘汰候选 |
| 53 | T06003 模板填充循环任务 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 54 | SupervisorPanel 五模块标签页重构 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 55 | SupervisorPanel 前端分页规范 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 56 | SupervisorPanel 指标卡 tone 主题色 | project | 4 | 3 | 4 | 3 | 2 | **63** | C 待优化 | 合并/更新/淘汰候选 |
| 57 | AI工作台卡片图标基准策略 | project | 5 | 5 | 4 | 4 | 4 | **88** | A 优质 | 保留 |
| 58 | T06015卡片标题全宽规范 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 59 | T06056 停滞阈值冲突根因 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 60 | T06056 进度更新修复逻辑 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 61 | T06056会话复用重置规则 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
| 62 | T06056 任务态交叉校准修复 | project | 4 | 4 | 4 | 3 | 3 | **71** | B 合格 | 保留并补边界 |
