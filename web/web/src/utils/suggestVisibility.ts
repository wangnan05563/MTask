/**
 * T03257（AI-203④ / PRD D-14）：上下文建议入口的显隐判定。
 *
 * 口径：
 *  - 用户主动关闭建议（T03256 开关）→ 隐藏；
 *  - 从未启用过（AI 从未配置任何工具，且台账里没有任何已展示建议）→ 隐藏；
 *  - 配置过但当前失效（工具停用/未填模型/配置不符）→ 可见但禁用，原因走 aiReadiness 原语；
 *  - 诊断未返回（加载中）→ 先显示，避免首帧闪烁。
 */
export type SuggestEntryState = 'hidden' | 'disabled' | 'visible';

export function suggestEntryState(input: {
  featureEnabled: boolean;
  everShown: boolean;
  readiness: { ready: boolean; code?: string } | null;
}): SuggestEntryState {
  if (!input.featureEnabled) return 'hidden';
  const r = input.readiness;
  if (!r) return 'visible';
  if (r.ready) return 'visible';
  // no_tool = 从未配置过 AI 工具；一旦展示过建议就说明启用过，此后一律按禁用+原因展示
  if (!input.everShown && r.code === 'no_tool') return 'hidden';
  return 'disabled';
}
