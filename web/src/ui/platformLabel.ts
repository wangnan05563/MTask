/**
 * 执行会话「平台」列的展示名归一（T01578 引入；T01665 收窄职责）。
 *
 * 服务端对 `exec_sessions.platform` 只做 `trim + toLowerCase` 归一，不参与任何改写。
 * 历史上接入脚本把默认平台写死为 `trae`（本仓实际宿主是 Qoder），T01665 已按宿主目录推断修正默认值——
 * 故本表不再承担「trae→qcoder」纠错职责：历史行保留原值如实展示，新行上报真实宿主；
 * 表内仅剩纯品牌名映射（不影响 claim / relay 依赖的等值匹配口径）。
 */
const PLATFORM_LABEL: Record<string, string> = {
  qoder: 'qcoder',
  qcoder: 'qcoder',
  workbuddy: 'WorkBuddy',
};

/** 平台展示名：大小写/空白归一后查表，未识别的值原样返回（不臆造品牌名）。 */
export function platformLabel(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toLowerCase();
  return PLATFORM_LABEL[key] ?? (raw ?? '');
}
