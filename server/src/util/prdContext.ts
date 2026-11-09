/**
 * T00763：PRD 上下文解析（独立 util，避免 AIService ↔ PlanService 循环依赖）。
 * 按任务/计划/需求 id 反查关联的 PRD 原文：req_ids → prd_requirements.prd_id → prd_docs。
 *
 * T04896：自动注入从「命中最新一篇」扩展为「全量命中 + 总预算」，并透出同项目文档目录，
 * 让外部 AI 能发现设计文档等其余 prd_docs。红线：单文档场景 `content`/`filename`/`prdId`
 * 与 T04896 之前**逐字一致**（存量单文档调用方拼 `PRD 文档《x》相关原文：\n${content}` 零变化）；
 * 多文档/目录信息全部走**新增可选字段**（`contentMulti`/`docIndex`），调用方按需消费。
 */
import { getDb } from '../db/connection';

export type PrdHitBy = 'requirement' | 'req_ids' | 'title';

/** T04896：一篇被截断后的 PRD 正文段（多文档拼接单元；docId 用于标注全量获取入口） */
export interface PrdDocSegment {
  prdId: string;
  filename: string;
  content: string;
}

export interface PrdContext {
  prdId: string;
  filename: string;
  /** 单文档正文（截断后）。**T04896 红线：单文档场景与改造前逐字一致。** */
  content: string;
  /** T00978-P1：本次反查命中的路径（requirement=reqId 直挂；req_ids=任务/计划显式关联；title=标题兜底）。
   *  供审计 / MCP 排查「为何命中这篇 PRD」，避免标题兜底误命中难追溯。 */
  hitBy: PrdHitBy;
  /** T04896：该对象同项目下全部 prd_docs 的目录（主 PRD 在前，按 updated_at 倒序）。
   *  仅当命中路径为 req_ids（显式关联、跨多需求）时填充；单文档/requirement/title 命中为 undefined（不改变存量）。
   *  供注入块尾追加「【本任务关联文档】」提示，让外部 AI 发现设计文档。
   *  T04897：元素带 docKind（'prd'/'design'/'test'），formatPrdContext 据此在目录行外显类型标签。 */
  docIndex?: Array<{ prdId: string; filename: string; chars: number; hit: boolean; docKind: 'prd' | 'design' | 'test' }>;
  /** T04896：全量命中正文（含多文档总预算截断结果），每篇一段。
   *  单文档场景与 `content` 同值（逐字一致）；多文档场景拼 `PRD 文档《A》相关原文：…\n…\nPRD 文档《B》相关原文：…`。
   *  调用方消费本字段替代裸 `content` 即可零成本获得多文档能力，存量单文档调用方不改也仍逐字一致。 */
  contentMulti?: string;
}

/** 反查结果：命中的 PRD id 与命中路径 */
interface PrdHit {
  prdId: string;
  hitBy: PrdHitBy;
}

/** PRD 上下文截断长度；超长时保头保尾，避免撑爆提示词 */
export const PRD_CONTEXT_LIMIT = 6000;
/** T04896：多文档总预算——超出按「主 PRD 优先、其余按 updated_at 倒序」裁，主 PRD 永不省 */
export const PRD_CONTEXT_TOTAL_LIMIT = 24000;

/** T04898：章节感知截断的关键词权重表（可配置常量，不硬编码死在函数里）。
 *  高权重：命中即该章节信息密度高（验收/接口/设计/字段/错误码/性能/约束），预算不足时优先保留；
 *  低权重：目录/修订记录/参考文献等低信息量章节，预算不足时优先省略。 */
export const PRD_SECTION_HIGH_KEYWORDS: readonly string[] = [
  '验收标准', '验收', '接口', 'api', '设计', '字段', '数据模型', '错误码', '性能', '约束', '需求', '范围', '数据',
];
export const PRD_SECTION_LOW_KEYWORDS: readonly string[] = [
  '目录', '修订记录', 'changelog', '参考文献', '附录', '修订历史', '版本记录',
];
/** T04898：章节评分——标题命中高权重词 +2、正文高权重词每个 +1、低权重词每个 -1（下限 0）。
 *  标题命中的信号最强（章节名即主题），权重高于正文命中。 */
export function scorePrdSection(heading: string, body: string): number {
  const h = heading.toLowerCase();
  const b = body.toLowerCase();
  let s = 0;
  for (const k of PRD_SECTION_HIGH_KEYWORDS) {
    if (h.includes(k.toLowerCase())) s += 2;
    const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const m = b.match(re);
    if (m) s += Math.min(m.length, 3); // 正文命中封顶，避免长章节靠重复词刷分
  }
  for (const k of PRD_SECTION_LOW_KEYWORDS) {
    if (h.includes(k.toLowerCase())) s -= 2;
    if (b.toLowerCase().includes(k.toLowerCase())) s -= 1;
  }
  return Math.max(0, s);
}

/** 解析 req_ids：脏数据/非数组一律视为无关联 */
function parseReqIds(raw: string | null | undefined): string[] {
  try {
    const a = JSON.parse(raw ?? 'null') as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 路径一：requirementId 直挂——从其所属需求反查 prd_id */
function hitByRequirement(db: ReturnType<typeof getDb>, requirementId: string): PrdHit | null {
  const r = db.prepare('SELECT prd_id FROM prd_requirements WHERE id = ?').get(requirementId) as { prd_id: string | null } | undefined;
  return r?.prd_id ? { prdId: r.prd_id, hitBy: 'requirement' } : null;
}

/**
 * 路径二：通过任务/计划的 req_ids 反查命中需求所属的 PRD。
 * T04896：改为**全量命中**——按 prd_id 分组、以该文档 updated_at 倒序，返回全部关联文档
 * （主 PRD = 最新一篇在首）。原「DISTINCT + LIMIT 1」只取最新一篇的口径由此扩展为完整集合。
 */
function hitByReqIdsAll(db: ReturnType<typeof getDb>, ids: string[]): PrdHit[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT d.id, d.updated_at FROM prd_docs d
       JOIN prd_requirements r ON r.prd_id = d.id
      WHERE r.id IN (${ph})
      GROUP BY d.id
      ORDER BY MAX(r.updated_at) DESC`,
  ).all(...ids) as { id: string; updated_at: string }[];
  return rows.map((r) => ({ prdId: r.id, hitBy: 'req_ids' as PrdHitBy }));
}

/**
 * 路径三（T00978-P0 兜底）：显式关联缺失时按标题反查——匹配 PRD 文件名/正文含目标标题的最新一篇，
 * 避免「已导入 PRD 却反查不到」。ESCAPE 守卫标题中 % _ \ 通配符。
 */
function hitByTitle(db: ReturnType<typeof getDb>, title: string | null | undefined): PrdHit | null {
  const t = title?.trim();
  if (!t) return null;
  const like = `%${t.replaceAll(/[\\%_]/g, (c) => '\\' + c)}%`;
  const d = db.prepare(
    String.raw`SELECT id FROM prd_docs WHERE filename LIKE ? ESCAPE '\' OR content_md LIKE ? ESCAPE '\' ORDER BY updated_at DESC LIMIT 1`,
  ).get(like, like) as { id: string } | undefined;
  return d ? { prdId: d.id, hitBy: 'title' } : null;
}

/** 命中任务/计划时的行读取 + 三条命中路径按优先级串联（T04896：req_ids 路径返回全量集合） */
function hitByTargetRowAll(db: ReturnType<typeof getDb>, taskId?: string, planId?: string): PrdHit[] {
  const table = taskId ? 'tasks' : 'plan_tasks';
  // T00978-P0：一并读 title，供 req_ids 缺失时按标题兜底反查
  const row = db.prepare(`SELECT title, req_ids FROM ${table} WHERE id = ?`).get(taskId ?? planId) as { title: string | null; req_ids: string | null } | undefined;
  const reqHits = hitByReqIdsAll(db, parseReqIds(row?.req_ids));
  if (reqHits.length > 0) return reqHits;
  const titleHit = hitByTitle(db, row?.title);
  return titleHit ? [titleHit] : [];
}

/**
 * T04898：章节感知截断（替代机械保头保尾）。
 * - 用 `^#{1,6}\s` 标题切章节；无标题结构（切不出带标题的段落）退化为旧机械保头保尾，零回归；
 * - 每段按 scorePrdSection 算信息分，预算不足时按「低分优先省略」选出保留集，再**按原文顺序**拼接；
 * - 章节边界保留（整段省略，不跨章节机械切字）；被省略章节名在末尾显式列出；
 * - 单章节本身超预算时，对该章退化为机械保头保尾兜底（章节内仍无法取舍）。
 */
function trimPrdContent(content: string, docId: string): string {
  if (content.length <= PRD_CONTEXT_LIMIT) return content;
  const sections = splitPrdSections(content);
  // 无标题结构（如纯文本、或全文仅一段无标题正文）→ 退化为旧机械保头保尾（零回归红线）
  if (sections.length <= 1) {
    const half = Math.floor(PRD_CONTEXT_LIMIT / 2);
    return `${content.slice(0, half)}\n\n……（中段略去 ${content.length - PRD_CONTEXT_LIMIT} 字符，全文见 PRD 文档 ${docId}）……\n\n${content.slice(-half)}`;
  }
  const scored = sections.map((s) => ({ ...s, score: scorePrdSection(s.heading, s.body) }));
  // 贪心选章：按分数降序，入选直到预算耗尽；低分章节（目录/修订记录）自然被优先挤出
  let budget = PRD_CONTEXT_LIMIT;
  const selected = new Set<number>();
  const byScore = scored.map((s, i) => ({ i, score: s.score, len: s.full.length })).sort((a, b) => b.score - a.score || a.i - b.i);
  for (const item of byScore) {
    const len = item.len;
    // 单章超预算：截断该章（保头保尾）仍入选，占满预算
    if (len <= budget) {
      selected.add(item.i);
      budget -= len;
    } else if (budget > 0 && selected.size === 0) {
      // 第一入选章节就超预算（极端单章超长）：对该章机械保头保尾兜底
      const s = scored[item.i];
      const half = Math.max(1, Math.floor(budget / 2));
      s.full = `${s.full.slice(0, half)}\n\n……（中段略去 ${s.full.length - budget} 字符，全文见 PRD 文档 ${docId}）……\n\n${s.full.slice(-half)}`;
      selected.add(item.i);
      budget = 0;
      break;
    } else {
      break; // 预算已不足以容纳下一章，后续章节全部省略
    }
  }
  // 按原文顺序输出选中的章节
  const kept = scored.filter((_, i) => selected.has(i)).map((s) => s.full);
  const omitted = scored.filter((_, i) => !selected.has(i)).map((s) => s.heading || '(无标题段)');
  let out = kept.join('\n\n');
  if (omitted.length > 0) {
    out += `\n\n……（已省略章节：${omitted.join('、')}，全文见 PRD 文档 ${docId}）……`;
  }
  return out;
}

/** T04898：用 `^#{1,6}\s` 标题把 PRD 正文切成章节段。返回 [{heading, body, full}]，heading 为标题行文本（无 # 前缀）。 */
interface PrdSection { heading: string; body: string; full: string }
function splitPrdSections(content: string): PrdSection[] {
  const headingRe = /^#{1,6}\s+(.+)$/gm;
  const matches: Array<{ index: number; heading: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(content)) !== null) {
    matches.push({ index: m.index, heading: m[1].trim() });
  }
  if (matches.length === 0) return [];
  const sections: PrdSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const full = content.slice(start, end).trim();
    const heading = matches[i].heading;
    // body = 去掉首行标题后的正文
    const firstNewline = full.indexOf('\n');
    const body = firstNewline >= 0 ? full.slice(firstNewline + 1) : '';
    sections.push({ heading, body, full });
  }
  return sections;
}

/** T04896：把一篇 prd_docs 取正文并截断成一个段（复用单篇 trimPrdContent 口径） */
function buildSegment(db: ReturnType<typeof getDb>, prdId: string): PrdDocSegment | null {
  const doc = db.prepare('SELECT id, filename, content_md FROM prd_docs WHERE id = ?').get(prdId) as { id: string; filename: string; content_md: string } | undefined;
  if (!doc) return null;
  return { prdId: doc.id, filename: doc.filename, content: trimPrdContent(doc.content_md, doc.id) };
}

/** T04896：按总预算拼多文档正文——主 PRD（首篇）永不省，其余按序填入直到超预算，被省篇数标注在末尾 */
function joinSegmentsMulti(primary: PrdDocSegment, rest: PrdDocSegment[]): string {
  const primaryLine = `PRD 文档《${primary.filename || '未命名'}》相关原文：\n${primary.content}`;
  if (rest.length === 0) return primaryLine;
  const lines = [primaryLine];
  let used = primary.content.length;
  let omitted = 0;
  for (const s of rest) {
    const line = `PRD 文档《${s.filename || '未命名'}》相关原文：\n${s.content}`;
    if (used + line.length > PRD_CONTEXT_TOTAL_LIMIT) { omitted += 1; continue; }
    lines.push(line);
    used += line.length;
  }
  return omitted > 0 ? `${lines.join('\n\n')}\n\n……（已省略 ${omitted} 篇关联 PRD，全文见 mtask_get_prd）` : lines.join('\n\n');
}

/** T04896：同项目 prd_docs 目录（主 PRD 在前，余按 updated_at 倒序），供注入块尾提示；T04897：透出 doc_kind */
function buildDocIndex(db: ReturnType<typeof getDb>, projectId: string, primaryPrdId: string): PrdContext['docIndex'] {
  const rows = db.prepare(
    `SELECT id, filename, content_md, doc_kind FROM prd_docs WHERE project_id = ? ORDER BY updated_at DESC`,
  ).all(projectId) as { id: string; filename: string; content_md: string; doc_kind: string }[];
  return rows.map((r) => ({
    prdId: r.id,
    filename: r.filename,
    chars: r.content_md.length,
    hit: r.id === primaryPrdId,
    docKind: (r.doc_kind === 'design' || r.doc_kind === 'test' ? r.doc_kind : 'prd') as 'prd' | 'design' | 'test',
  }));
}

/**
 * 解析目标对象关联的 PRD 原文；未关联返回 null。
 * T04896：req_ids 命中路径返回**全量**关联文档（主 PRD 取最新一篇在前）；超长时按总预算裁、主 PRD 不省。
 * `content`/`filename`/`prdId` 在单文档场景保持与改造前逐字一致（红线）；多文档与目录走 `contentMulti`/`docIndex`。
 */
export function resolvePrdContext(target: { taskId?: string; planId?: string; requirementId?: string }): PrdContext | null {
  const db = getDb();
  // M6-6.4：命中判定展开为显式分支（原为嵌套三元，S3358）
  let hits: PrdHit[] = [];
  if (target.requirementId) {
    const single = hitByRequirement(db, target.requirementId);
    hits = single ? [single] : [];
  } else if (target.taskId || target.planId) {
    hits = hitByTargetRowAll(db, target.taskId, target.planId);
  }
  if (hits.length === 0) return null;
  const primaryHit = hits[0];
  const primary = buildSegment(db, primaryHit.prdId);
  if (!primary) return null;
  // 单文档场景：content 与 T04896 前逐字一致（红线）
  const base: PrdContext = { prdId: primary.prdId, filename: primary.filename, content: primary.content, hitBy: primaryHit.hitBy,
    contentMulti: primary.content };
  // 多文档（req_ids 显式关联、命中 ≥2 篇）：补全量正文 + 同项目文档目录
  if (primaryHit.hitBy === 'req_ids' && hits.length >= 2) {
    const restSegs: PrdDocSegment[] = [];
    for (let i = 1; i < hits.length; i += 1) {
      const seg = buildSegment(db, hits[i].prdId);
      if (seg) restSegs.push(seg);
    }
    base.contentMulti = joinSegmentsMulti(primary, restSegs);
    // 文档目录：取主 PRD 所属项目（prd_docs.project_id），列全部文档
    const projRow = db.prepare('SELECT project_id FROM prd_docs WHERE id = ?').get(primary.prdId) as { project_id: string } | undefined;
    if (projRow?.project_id) base.docIndex = buildDocIndex(db, projRow.project_id, primary.prdId);
  }
  return base;
}

/**
 * T04896：把 PrdContext 拼成注入提示词用的字符串。
 * - 多文档场景：用 `contentMulti`（全量 + 总预算截断）替代单篇 `content`，避免外部 AI 只拿到最新一篇；
 * - 尾部按需追加「【本任务关联文档】」目录行（仅当 `docIndex` 存在，即 req_ids 多文档命中），
 *   把「要不要读设计文档」的判断权交给 AI，而非 MTask 硬注入。
 * - 单文档场景（无 docIndex）：输出与 T04896 之前逐字一致（`PRD 文档《x》相关原文：\n${content}`），存量零变化。
 * 调用方统一经本函数拼装，避免 4 处各自拼法再次分叉。
 */
export function formatPrdContext(prd: PrdContext | null): string | undefined {
  if (!prd) return undefined;
  // 单文档场景：contentMulti 与 content 同值（均为纯正文），须补 `PRD 文档《x》相关原文：` 前缀，
  //   与 T04896 之前调用方裸拼逐字一致（红线）。多文档场景 contentMulti 已是 joinSegmentsMulti
  //   拼好的带前缀多段文本，直接用。
  const isMulti = prd.contentMulti != null && prd.contentMulti !== prd.content;
  let out = isMulti
    ? prd.contentMulti!
    : `PRD 文档《${prd.filename || '未命名'}》相关原文：\n${prd.content}`;
  if (prd.docIndex && prd.docIndex.length > 0) {
    const idx = prd.docIndex
      .map((d) => `${d.filename || '未命名'}(${d.docKind}, ${d.chars}字)`)
      .join(', ');
    out += `\n【本任务关联文档】prd_docs: [${idx}]；全文调 mtask_get_prd(prdId=...) 取`;
  }
  return out;
}
