/**
 * 执行会话「平台」列的展示名归一（T01578 引入；T01665 收窄职责）。
 *
 * 服务端对 `exec_sessions.platform` 只做 `trim + toLowerCase` 归一，不参与任何改写。
 * T05793 起统一委托 PlatformLogo 的 brandFor/alias 表：豆包、Codex、Trae、Qoder 等
 * 别名（relay:/mcp: 前缀、-mcp/-ai 后缀、中文名）都能得到一致的品牌展示名。
 */
import { platformDisplayName } from './PlatformLogo';

/** 平台展示名：大小写/空白归一后查品牌表；未识别的值原样返回（不臆造品牌名）。 */
export function platformLabel(raw: string | null | undefined): string {
  return platformDisplayName(raw);
}
