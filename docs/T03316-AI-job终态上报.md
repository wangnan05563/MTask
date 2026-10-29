# T03316（G-3）AI job 级终态上报与续作合并

## 背景

T03192 已建好 `ai_job_runs` 数据层（`AiJobStats.record` / `/api/metrics/ai-jobs*`），但写入方只有讲稿一条通道，G-3 成功率只能代表 1/16 张卡。本单补齐其余 AI 卡的终态上报，并把续作/重试合并到同一 job。

## 写入单源

新增 `server/src/services/aiJobReport.ts`：

- `jobIdOf(raw)`：客户端 jobId 去空白后 ≤120 字符即采用，空值/超长回落 `randomUUID()`；
- `reportAiJob(job)`：唯一 `AiJobStats.record` 调用点，异常一律吞掉——观测数据不得影响生成主流程。

## 各通道接线

| 通道 | cardKey | mode | 上报时机 |
| --- | --- | --- | --- |
| `/plans/code-review-lecture-stream` | `ai.code_review_lecture` | ai | 完整轮 done/aborted/error；续作轮仅 done 且终态覆盖（累计节次） |
| `/plans/kickoff-ppt-stream` | `ai.kickoff_ppt` | ai | done / 断连 aborted / error |
| `/plans/summary-ppt-stream` | `ai.summary_ppt` | **offline** | 本流不调模型（大纲在前一段产出），显式离线分列 |
| `/plans/prd-generate-stream` | `ai.prd_gen` | ai | done / 取消 aborted / error |
| `/plans/testcase-generate-stream` | `ai.test_case_gen` | ai | done（块数取台账累计：失败块进分母不进分子）/ error |
| `/plans/ai-parse`、`/plans/ai-parse-doc` | `ai.plan_import` | ai | 需求拆解完整一轮 done/error |
| `/plans/ai-parse-prd` | `ai.prd_import` | ai | 需求梳理完整一轮 done/error |

大纲接口（`kickoff-ppt-outline` / `summary-ppt-outline`）是中间交付，不记样本。

## 续作/重试合并

- 服务端一律优先采用客户端带来的 `jobId`（`request.jobId ?? 台账 id`）；前端新增 `web/src/util/jobId.ts` 的 `sessionJobId`（页面会话内稳定、刷新即换），四个生成面板随请求携带。
- `ai_job_runs` 主键覆盖语义：续作轮成功收口时用同一 jobId 写**累计**节次（T03246 续作轮的 `result.sections` 已按台账重建为整份）；续作轮失败/中止不覆盖既有终态，避免把已成功的 job 回写成失败——「重试后最终成功计成功」。
- 续作轮 `startedAt` 取台账首轮创建时间，job 起点不随最后一轮漂移。

## 验证

- `tsc -p server` / `tsc -p web` 通过；
- `scripts/tests/verify-t03316-ai-jobs.mts`：**28 通过 / 0 失败**（jobId 兜底、终态覆盖只留 1 行且节次累计、mode 分列、吞错、源码锚点、四个面板携带 sessionJobId）；
- 隔离实例 + 桩模型真机驱动器（复用 T03246 键盘驱动器，端口 39898、数据在 `D:/tmp/t03316-ui`）：**23 通过 / 0 失败**——生成中停止（aborted 已立账）→ 从第 3 节续作（零重复调用）→ `ai_job_runs` 仅 1 行、同一 jobId、`done`、8/8 节；生产 :39877 未被触碰。
