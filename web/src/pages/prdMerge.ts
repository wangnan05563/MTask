/**
 * T01995：多份 PRD 解析结果的合并逻辑（从 PrdImportPanel 抽出为无依赖纯函数，便于脚本级断言）。
 *
 * 背景：每份 PRD 的 AI 解析都各自从 REQ-001 起号。合并成一次导入时必须把「文件内旧号」
 * 重映射为「全局新号」，否则后一份文档的 REQ-001 会把前一份的同名旧号覆盖掉，
 * 前一份的 WBS 草稿整体偏移到后一份的需求行上（实测 mtask四期 前 20 行零关联）。
 */

/** T03700+：有损交付时缺失的分片（含原文）——供面板展示/复制/单独补解析 */
export interface PrdFailedChunk {
  index: number;
  total: number;
  reason: 'rate-limit' | 'error' | 'aborted' | 'not-run';
  message?: string;
  chars: number;
  text: string;
}

/** T00662：单文件解析响应（/plans/ai-parse-prd） */
export interface PrdParseResult {
  /** T04064：sourceIndex = 该需求来自第几个来源文件（与 import payload 的 prdDocs 下标对齐） */
  requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string; sourceIndex?: number }>;
  drafts: Array<{ title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily' }>;
  coverageWarn?: string;
  /** T00908：后端随解析返回的 PRD 提取全文，供确认导入时落库到 PRD 管理视图 */
  textMd?: string;
  /** T01156：首轮输出被截断、已用精简模式重试（需求可能静默丢失） */
  truncatedNote?: string;
  /** T02270 复议：长文档已分片解析并完整合并——信息性提示，不是有损警示（与 truncatedNote 互斥） */
  parseNote?: string;
  /** T03730：HTML 输入中被跳过、无法转为正文的片段（内嵌页/图表/无 alt 图片等）——必须显式提示用户 */
  parseWarnings?: string[];
  /** T03700+：分片失败/中止时缺失的片（含原文），面板据此提供查看、复制与单片补解析 */
  failedChunks?: PrdFailedChunk[];
  /** T03700+：服务端自动补齐的计划行对应的需求编号（原缺口需求） */
  autoFilledReqNos?: string[];
}

/**
 * T03700+：按界面最终结果算「未被任何计划关联的需求」——多文件合并会把编号全局重排，
 * 直接引用后端按单文件编号算出的告警会和表格里的行号对不上；这里以合并后的编号为准。
 * 调用方传入的 requirements/drafts 应已按勾选过滤（未勾选的计划不参与导入，其覆盖不算数）。
 */
export function findUncoveredReqs(
  requirements: ReadonlyArray<PrdParseResult['requirements'][number]>,
  drafts: ReadonlyArray<PrdParseResult['drafts'][number]>,
): PrdParseResult['requirements'] {
  const referenced = new Set(drafts.flatMap((d) => d.reqNos));
  return requirements.filter((r) => r.title.trim() && !referenced.has(r.reqNo));
}

/**
 * T03700+：为未关联需求生成补齐计划草稿（确定性，不经模型）。
 * 提示词一直要求模型自行补「REQ-xxx 相关实现/验证」，但分片计划上限 45 条时补偿行最先被裁掉，
 * 缺口集合因此随每次解析漂移；这里由界面一键生成，每需求一行 normal、工期 1 天，可再编辑/取消勾选。
 */
export function buildGapFillDrafts(
  requirements: ReadonlyArray<{ reqNo: string; title: string }>,
): PrdParseResult['drafts'] {
  return requirements.map((r) => ({
    title: `${r.reqNo} ${r.title.slice(0, 24)} 实现/验证`,
    description: '自动补齐：该需求在 AI 拆解的 WBS 中没有对应节点（导入前可改标题或取消勾选）',
    durationDays: 1,
    reqNos: [r.reqNo],
    kind: 'normal' as const,
  }));
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
      requirements.push({ ...x, reqNo: nn, sourceIndex: fileIdx });
    }
  });
  const drafts: PrdParseResult['drafts'] = [];
  list.forEach((r, fileIdx) => {
    const map = maps[fileIdx];
    for (const d of r.drafts) {
      // 服务端自动补齐行把原编号写进标题前缀；跨文件全局重排后同步改写前缀，
      // 否则标题里的 REQ-xxx 会与 reqNos 指向的最终编号对不上
      const m = /^(REQ-\d{3})\s/.exec(d.title);
      const mapped = m ? map.get(m[1]) : undefined;
      const title = m && mapped ? `${mapped}${d.title.slice(m[1].length)}` : d.title;
      drafts.push({ ...d, title, reqNos: d.reqNos.map((x) => map.get(x) ?? x) });
    }
  });
  return { requirements, drafts };
}
