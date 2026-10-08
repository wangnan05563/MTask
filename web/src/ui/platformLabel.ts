/**
 * 执行会话「平台」列的展示名归一（T01578）。
 *
 * 为什么放在展示层：`exec_sessions.platform` 是上报方自由字符串，服务端只做 `trim + toLowerCase`
 * 归一（`server/src/util/platform.ts`），不参与任何改写；历史上接入脚本把默认平台写死为 `trae`
 * （本仓实际宿主是 Qoder），库里存量行已无法追溯真名。故只在渲染时把机器标识换成品牌名，
 * 既覆盖存量行，也不影响 claim / relay 依赖的等值匹配口径。
 */
const PLATFORM_LABEL: Record<string, string> = {
  trae: 'qcoder', // 接入脚本的历史默认值，非真实 Trae 会话
  qoder: 'qcoder',
  qcoder: 'qcoder',
  workbuddy: 'WorkBuddy',
};

/** 平台展示名：大小写/空白归一后查表，未识别的值原样返回（不臆造品牌名）。 */
export function platformLabel(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toLowerCase();
  return PLATFORM_LABEL[key] ?? (raw ?? '');
}
