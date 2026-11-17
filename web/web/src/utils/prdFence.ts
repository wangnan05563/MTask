/**
 * T00815：PRD 流式正文的前端净化。
 *
 * 「AI 控制台 PRD 正文（实时）」渲染的是**原始流式累积文本**（streamText），与落库用的
 * `prdMd`（服务端已在 splitPrdBody 清洗）不同源。模型偶尔会把整份 PRD 包进 ```markdown 围栏、
 * 或先输出 <<<PRD>>>/<<<ISSUES>>> 标记——渲染器会把整体当**一个代码块**原样显示，
 * 用户看到的就是原始 #/** 符号。这里做与 server/src/services/prdIssues.ts 同口径的前端清洗：
 * - 去掉 <<<PRD>>>/<<<ISSUES>>> 标记及其后的问题 JSON 段（实时流中 JSON 段可能未到，只去标记）；
 * - 解开「首行 ``` + 末行 ```」的整体围栏（流式中末行围栏未到时只去首行，增量场景依然干净）。
 * 逻辑必须与 server 侧 splitPrdBody/unwrapTopFence 保持同口径，改动请两处同步。
 */

const MARKER_RE = /<{1,4}\s*(?:PRD|ISSUES)\s*>{1,4}/g;

/** 解开「首行 ``` + 末行 ```」的整体代码围栏（流式中允许末行未到，仅去首行） */
export function unwrapMdFence(text: string): string {
  const t = text.replace(/^\s+/, '');
  const open = /^```[\w-]*[ \t]*\n/.exec(t);
  if (open) {
    const inner = t.slice(open[0].length);
    // 流式期间末行围栏可能尚未到达：存在闭合则去掉，不存在只去首行
    return /```[ \t]*$/.test(inner.trimEnd()) ? inner.trimEnd().replace(/```[ \t]*$/, '') : inner;
  }
  return text;
}

/** 控制台实时正文净化：去标记 → 解围栏。纯函数，便于与 server 侧口径对齐测试 */
export function cleanPrdStreamText(text: string): string {
  if (!text) return '';
  // 问题清单 JSON 段（标记之后的部分）在实时流中可能逐渐到达：只移除标记本身，
  // JSON 段保留原样（服务端 done 后会给出清洗后的 prdMd，录入/预览均以它为准）
  const noMarker = text.replaceAll(MARKER_RE, '');
  return unwrapMdFence(noMarker);
}
