/**
 * T01995：多份 PRD 解析结果的合并逻辑（从 PrdImportPanel 抽出为无依赖纯函数，便于脚本级断言）。
 *
 * 背景：每份 PRD 的 AI 解析都各自从 REQ-001 起号。合并成一次导入时必须把「文件内旧号」
 * 重映射为「全局新号」，否则后一份文档的 REQ-001 会把前一份的同名旧号覆盖掉，
 * 前一份的 WBS 草稿整体偏移到后一份的需求行上（实测 mtask四期 前 20 行零关联）。
 */

/** T00662：单文件解析响应（/plans/ai-parse-prd） */
export interface PrdParseResult {
  requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>;
  drafts: Array<{ title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily' }>;
  coverageWarn?: string;
  /** T00908：后端随解析返回的 PRD 提取全文，供确认导入时落库到 PRD 管理视图 */
  textMd?: string;
  /** T01156：首轮输出被截断、已用精简模式重试（需求可能静默丢失） */
  truncatedNote?: string;
  /** T02270 复议：长文档已分片解析并完整合并——信息性提示，不是有损警示（与 truncatedNote 互斥） */
  parseNote?: string;
}

/**
 * T00824：多文件解析结果合并——统一重编号 REQ-001…，并把每份 WBS 草稿的 reqNos 转换后再拼接。
 * T01995：old→new 表**按来源文件分表**（旧实现跨文件共用一张表，后份文档的同名旧号会覆盖前份，
 * 导致前份计划/待办关联整体后移「前序文档需求条数」位）；草稿重映射只用产出它的那份文件的表，
 * 两趟循环按同一 `list` 下标对齐。本份表查不到的旧号原样保留（交给服务端 unlinkedReqNos 告警）。
 */
export function mergePrdResults(list: PrdParseResult[]): {
  requirements: PrdParseResult['requirements'];
  drafts: PrdParseResult['drafts'];
} {
  const maps = list.map(() => new Map<string, string>());
  const requirements: PrdParseResult['requirements'] = [];
  let n = 1;
  list.forEach((r, fileIdx) => {
    for (const x of r.requirements) {
      const nn = `REQ-${String(n++).padStart(3, '0')}`;
      maps[fileIdx].set(x.reqNo, nn);
      requirements.push({ ...x, reqNo: nn });
    }
  });
  const drafts: PrdParseResult['drafts'] = [];
  list.forEach((r, fileIdx) => {
    const map = maps[fileIdx];
    for (const d of r.drafts) {
      drafts.push({ ...d, reqNos: d.reqNos.map((x) => map.get(x) ?? x) });
    }
  });
  return { requirements, drafts };
}
