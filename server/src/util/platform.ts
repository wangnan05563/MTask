/**
 * T01288（PRD §6.1 / FR-3.1 / FR-3.4）：外部平台标识的**统一归一化**——Trae 接入适配的基础口径。
 *
 * 为什么必须归一：平台标识在链路上是**多处独立消费的自由字符串**——
 * - 平台自己上报/认领时传入（`mtask_report_progress` / `mtask_claim_task` 的 platform）；
 * - 决策 LLM 输出 REDISPATCH 的 `toPlatform`，写入 `tasks.monitor_preferred_platform`；
 * - 拉取时 `mtask_list_ready_tasks(platform)` 与上者做等值匹配（FR-3.1 平台偏好过滤）；
 * - `supervisor.relayPlatforms` 判定该平台是否走推送兜底（FR-3.6）。
 *
 * 这些入口各写各的（此前只有 relay 一处做了 lowercase），大小写/空白一旦不一致就会出现
 * 「Trae 自称 Trae、偏好平台存成 trae → 任务永远拉不到」的**静默排水停滞**——任务看着「就绪」，
 * 实际无平台能取。故在**边界处**统一归一，全链路只认一种形态（小写去空白）。
 *
 * 归一规则取 `trim + toLowerCase`：
 * - 平台名是机器标识（非展示文案），大小写不承载语义，与 URL/协议名同类；
 * - 与 RelayDispatchService 既有口径一致，不引入第二套规则。
 */

/**
 * 平台标识归一化：`trim + toLowerCase`。
 * 空值统一返回空串（调用方据此判「未指定平台」，语义同此前各自的 `?.trim()`）。
 */
export function normalizePlatform(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}
