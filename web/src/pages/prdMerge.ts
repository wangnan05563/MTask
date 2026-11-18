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

/** T04010：面板里的缺失片行——带来源文件名、行唯一键与服务端失败片 id（补解析成功后按它删服务端索引） */
export type FailedShardRow = PrdFailedChunk & { file: string; uid: string; serverId?: string };

/** T04010：服务端恢复的缺失片——原文由后端按 prd_docs.content_md + 落库区间现切，库里不存第二份正文 */
export interface RestoredFailedChunk extends PrdFailedChunk {
  id: string;
  file: string;
  prdId: string;
  createdAt: string;
}

/**
 * T04010：关窗/重启后把服务端恢复行并入本地列表——保持「并入而非覆盖」：
 * 同 serverId 或同「来源文件 + 片号」的已在列表中则不重复加，本地已有行（可能刚补解析出新内容）不被覆盖。
 */
export function mergeRestoredFailures(
  local: ReadonlyArray<FailedShardRow>,
  restored: ReadonlyArray<RestoredFailedChunk>,
): FailedShardRow[] {
  const seenIds = new Set(local.map((r) => r.serverId).filter((x): x is string => !!x));
  const seenChunks = new Set(local.map((r) => `${r.file}\u0000${r.index}`));
  const out = [...local];
  for (const r of restored) {
    if (seenIds.has(r.id) || seenChunks.has(`${r.file}\u0000${r.index}`)) continue;
    out.push({ ...r, uid: `srv:${r.id}`, serverId: r.id });
  }
  return out;
}

/** T00662：单文件解析响应（/plans/ai-parse-prd） */
export interface PrdParseResult {
  /** T04064：sourceIndex = 该需求来自第几个来源文件（与 import payload 的 prdDocs 下标对齐） */
  requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string; sourceIndex?: number; type?: string; acceptanceRefs?: string[] }>;
  drafts: Array<{ title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily'; wbsCode?: string; parentCode?: string; phaseCode?: string; priority?: string; sourceSection?: string; deliverable?: string; acceptanceRefs?: string[]; dependsOn?: string[]; taskType?: string; estimateDays?: number }>;
  coverageWarn?: string;
  /** T00908：后端随解析返回的 PRD 提取全文，供确认导入时落库到 PRD 管理视图 */
  textMd?: string;
  /** T01156：首轮输出被截断、已用精简模式重试（需求可能静默丢失） */
  truncatedNote?: string;
  /** T02270 复议：长文档已分片解析并完整合并——信息性提示，不是有损警示（与 truncatedNote 互斥） */
  parseNote?: string;
  /** 2026-11-18：本次解析实际走的路径——single 单轮 / skeleton 骨架 / chunked 分片；
   *  chunked 仅超长文档或显式请求，不再作为单轮失败后的自动回退。 */
  parsePath?: 'single' | 'skeleton' | 'chunked';
  /** 2026-11-18：模型输出预算低于建议值时的提示（低预算会优先走骨架模式） */
  budgetWarn?: string;
  /** T03730：HTML 输入中被跳过、无法转为正文的片段（内嵌页/图表/无 alt 图片等）——必须显式提示用户 */
  parseWarnings?: string[];
  /** T03700+：分片失败/中止时缺失的片（含原文），面板据此提供查看、复制与单片补解析 */
  failedChunks?: PrdFailedChunk[];
  /** T04010：服务端失败片索引 id（与 failedChunks 同序）——用于补解析成功后删除对应索引 */
  failedChunkIds?: string[];
  /** T03700+：服务端自动补齐的计划行对应的需求编号（原缺口需求） */
  autoFilledReqNos?: string[];
  /** T05571：服务端按源文档条目补齐的计划行明细（原文有编号、解析结果未覆盖） */
  sourceEntryFilled?: Array<{ id: string; label: string; title: string; description: string; excerpt: string }>;
  /** 2026-11-10 质量复核优化②：服务端跨片合并后检测到的并行 WBS 套数（>1 需归一化） */
  wbsGroups?: number;
}

/**
 * AC 验收项识别：类型标记、AC 编号或来源章节三者任一命中。
 * 计划里的 `acceptanceRefs` 只写 AC 编号时，也必须算作「已被计划关联」，
 * 否则会把「验收项挂载」误报成「需求没有实现计划」。
 */
export function isAcceptanceReq(
  r: Pick<PrdParseResult['requirements'][number], 'type' | 'reqNo' | 'sourceRef'>,
): boolean {
  return r.type === 'AC'
    || /^AC[-_.]?\d/i.test(r.reqNo ?? '')
    || /验收标准/.test(r.sourceRef ?? '');
}

/**
 * T03700+：按界面最终结果算「未被任何计划关联的需求」——多文件合并会把编号全局重排，
 * 直接引用后端按单文件编号算出的告警会和表格里的行号对不上；这里以合并后的编号为准。
 * 调用方传入的 requirements/drafts 应已按勾选过滤（未勾选的计划不参与导入，其覆盖不算数）。
 * 2026-11-17：`acceptanceRefs` 是 AC 的第一关联字段，必须与 `reqNos` 一起计入覆盖，
 * 否则 AC 明明已挂到验收任务，仍会被报成「30 条需求未关联」。
 */
export function findUncoveredReqs(
  requirements: ReadonlyArray<PrdParseResult['requirements'][number]>,
  drafts: ReadonlyArray<PrdParseResult['drafts'][number]>,
): PrdParseResult['requirements'] {
  const referenced = new Set(drafts.flatMap((d) => [...d.reqNos, ...(d.acceptanceRefs ?? [])]));
  return requirements.filter((r) => r.title.trim() && !referenced.has(r.reqNo));
}

/**
 * T03700+：为未关联需求生成补齐计划草稿（确定性，不经模型）。
 * 提示词一直要求模型自行补「REQ-xxx 相关实现/验证」，但分片计划上限 45 条时补偿行最先被裁掉，
 * 缺口集合因此随每次解析漂移；这里由界面一键生成，每需求一行 normal、工期 1 天，可再编辑/取消勾选。
 */
export function buildGapFillDrafts(
  requirements: ReadonlyArray<PrdParseResult['requirements'][number]>,
): PrdParseResult['drafts'] {
  // AC 是验收标准，不是待开发需求：不能给它补「实现/验证」任务。
  // AC 未承接时应挂到验收任务（服务端 ensurePrdAcceptanceCoverage 负责），
  // 这里只给 FR/NFR/EX 等实现类需求补计划，避免一次点击生成 30 条垃圾任务。
  return requirements.filter((r) => !isAcceptanceReq(r)).map((r) => ({
    title: `${r.reqNo} ${r.title.slice(0, 24)} 实现/验证`,
    description: '自动补齐：该需求在 AI 拆解的 WBS 中没有对应节点（导入前可改标题或取消勾选）',
    durationDays: 1,
    reqNos: [r.reqNo],
    kind: 'normal' as const,
  }));
}

/**
 * T00824：多文件解析结果合并——需求编号全局重排，并把每份 WBS 草稿的
 * `reqNos` 与 `acceptanceRefs` 同步重映射后再拼接。
 * T01995：old→new 表**按来源文件分表**（旧实现跨文件共用一张表，后份文档的同名旧号会覆盖前份，
 * 导致前份计划/待办关联整体后移「前序文档需求条数」位）；草稿重映射只用产出它的那份文件的表，
 * 两趟循环按同一 `list` 下标对齐。本份表查不到的旧号原样保留（交给服务端 unlinkedReqNos 告警）。
 *
 * 2026-11-17 修复：AC 验收项必须保留 AC 编号空间，不能再被统一重排成 REQ-xxx。
 * 旧实现只改 `reqNos`、不改 `acceptanceRefs`：当计划把 AC 只放在 acceptanceRefs 时，
 * 需求行已变成 REQ-044，计划仍写 AC-14，质量门就会把 30 条 AC 全部判成「没有任何任务承接」。
 */
export function mergePrdResults(list: PrdParseResult[]): {
  requirements: PrdParseResult['requirements'];
  drafts: PrdParseResult['drafts'];
} {
  const maps = list.map(() => new Map<string, string>());
  const requirements: PrdParseResult['requirements'] = [];
  let reqSeq = 1;
  let acSeq = 1;
  list.forEach((r, fileIdx) => {
    for (const x of r.requirements) {
      const ac = isAcceptanceReq(x);
      const nn = ac
        ? `AC-${String(acSeq++).padStart(2, '0')}`
        : `REQ-${String(reqSeq++).padStart(3, '0')}`;
      maps[fileIdx].set(x.reqNo, nn);
      requirements.push({ ...x, reqNo: nn, type: ac ? 'AC' : x.type, sourceIndex: fileIdx });
    }
  });
  const drafts: PrdParseResult['drafts'] = [];
  list.forEach((r, fileIdx) => {
    const map = maps[fileIdx];
    for (const d of r.drafts) {
      // 服务端自动补齐行把原编号写进标题前缀；跨文件全局重排后同步改写前缀，
      // 否则标题里的 REQ-xxx/AC-xx 会与 reqNos 指向的最终编号对不上
      const m = /^(REQ-\d{3}|AC-\d{2,3})\s/.exec(d.title);
      const mapped = m ? map.get(m[1]) : undefined;
      const title = m && mapped ? `${mapped}${d.title.slice(m[1].length)}` : d.title;
      const reqNos = d.reqNos.map((x) => map.get(x) ?? x);
      const acceptanceRefs = (d.acceptanceRefs ?? []).map((x) => map.get(x) ?? x);
      drafts.push({ ...d, title, reqNos, acceptanceRefs: acceptanceRefs.length > 0 ? acceptanceRefs : undefined });
    }
  });
  return { requirements, drafts };
}
