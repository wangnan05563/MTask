/**
 * T05208（裁决：方案 B）：PRD 文档「显式关联」——补齐 任务/计划/需求 ↔ 设计文档（SDD）的链路。
 *
 * 缺陷根因（2026-11-10 实测）：`mtask_get_prd {taskNo}` 只能返回**有需求行的那一篇**文档。
 * 「方案设计 / 测试用例」这类文档不产生 prd_requirements 行，`req_ids → prd_id` 反查永远命中不到，
 * 在数据里表现为**孤儿文档**：正文在 prd_docs 里、按 prdId 直查可取，但按任务/计划/需求取不到。
 *
 * 方案 B（裁决口径）：在 `prd_docs` 上落一条**显式关联边** `related_prd_id`（设计/测试文档 → 主 PRD），
 *   - 导入「PRD + 设计方案」同批时自动建边（无需人工挂接）；
 *   - 存量孤儿文档由 `backfillPrdDocLinks()` 在服务启动时按「同主题唯一命中」回填一次；
 *   - `get_prd` 只按这条边返回 `docs[]`，**无关联时退回单文档行为**（不再运行时猜同源）。
 * 文件名归一/同主题判定只服务于「导入回落 + 存量回填」两处，不在读取路径上做推导。
 */
import { getDb } from '../db/connection';

export type PrdDocKind = 'prd' | 'design' | 'test';
export type PrdDocRelation = 'primary' | 'linked';

export interface PrdDocRef {
  prdId: string;
  filename: string;
  docKind: PrdDocKind;
  chars: number;
  relation: PrdDocRelation;
}

/** 文档类型词——从文件名中剥离后剩下的才是「主题」，否则同源的 PRD 与设计文档永远归一不到一起。
 *  顺序无关（按长度倒序匹配，避免「需求」先吃掉「业务需求」）。 */
const DOC_KIND_WORDS: readonly string[] = [
  '需求规格说明书', '业务需求说明书', '产品需求文档', '业务需求', '产品需求', '需求文档', '需求说明', '需求',
  '方案设计', '设计方案', '设计文档', '设计说明', '详细设计', '概要设计', '概设', '技术方案', '架构设计', '设计',
  '测试用例', '测试案例', '测试文档', '测试方案', '测试',
  'design document', 'test cases', 'test case', 'testcases', 'requirements', 'requirement', 'design', 'test', 'spec',
  'prd', 'pdr',
].sort((a, b) => b.length - a.length);

/** 设计类文件名特征（用于 doc_kind 推断；只认文件名，不猜正文） */
const DESIGN_HINTS: readonly string[] = ['方案设计', '设计方案', '设计文档', '详细设计', '概要设计', '概设', '技术方案', '架构设计', '设计', 'design'];
/** 测试类文件名特征 */
const TEST_HINTS: readonly string[] = ['测试用例', '测试案例', '测试文档', '测试方案', '测试', 'test'];

/**
 * 按文件名推断文档类型：**只做文件名判定**，判不出即 'prd'。
 * 用途：修正「设计文档被当作主 PRD 导入」时 doc_kind 一律落 'prd' 的数据成因（T04897 的 docKind 只有 UI 上传时显式带值）。
 */
export function inferDocKindFromFilename(filename: string | null | undefined): PrdDocKind {
  const name = stripExt((filename ?? '').trim()).toLowerCase();
  if (!name) return 'prd';
  // 测试先判：「测试用例」不含设计类词，但「设计测试方案」这类混合名以测试为准更安全
  if (TEST_HINTS.some((k) => name.includes(k))) return 'test';
  if (DESIGN_HINTS.some((k) => name.includes(k))) return 'design';
  return 'prd';
}

/** 去扩展名与目录前缀 */
function stripExt(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? name;
  return base.replace(/\.(md|markdown|txt|docx?|pdf|xlsx?|csv)$/i, '');
}

/**
 * 文件名 → 主题串：去扩展名/目录、小写、去日期（20261106 / 2026-11-06 / 2026.11.06 / 2026年11月6日）、
 * 去版本号（-v6 / _V2.1 / 第3版）、去文档类型词、去标点空白。
 * 例：`审批功能优化和指导利率改动20261106业务需求-v6.md` → `审批功能优化和指导利率改动`。
 */
export function normalizeDocTopic(filename: string | null | undefined): string {
  let s = stripExt((filename ?? '').trim()).toLowerCase();
  if (!s) return '';
  s = s.replace(/20\d{2}[-._年]?\d{1,2}[-._月]?\d{1,2}日?/g, ' '); // 2026-11-06 / 20261106 / 2026年11月6日
  s = s.replace(/\b20\d{6}\b/g, ' ');
  s = s.replace(/[-_ ]?v\d+(?:\.\d+)*/g, ' '); // -v6 / _V2.1
  s = s.replace(/第\s*\d+\s*版/g, ' ');
  for (const w of DOC_KIND_WORDS) s = s.split(w).join(' ');
  s = s.replace(/[\s\-_—–·.,，。、:：;；()（）[\]【】「」《》"'!?！？~]+/g, '');
  return s.replace(/\d+$/, ''); // 主题末尾的流水号（"…改动2"）不参与比较
}

/** 两个已归一主题是否同源 */
export function isSameTopic(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return a.length >= 4; // 过短的主题（如"需求"归一后为空/2字）不作数
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 6 && long.includes(short)) return true; // 「A」与「A-补充说明」
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  return i >= 8 && i / short.length >= 0.6; // 长公共前缀且占比过半（中文 8 字已足够特异）
}

interface DocRow { id: string; project_id: string; filename: string; content_md: string; doc_kind: string; related_prd_id: string }

/**
 * `archived` 列由 T05080 引入，可能是尚未落库的并发改动。读取时动态探测一次：
 * 有该列就过滤归档文档，没有就按全量返回——避免本模块单独提交时在老库上抛 no such column。
 */
let archivedColumnKnown: boolean | null = null;
function archivedFilter(db: ReturnType<typeof getDb>): string {
  if (archivedColumnKnown === null) {
    try {
      const cols = db.prepare('PRAGMA table_info(prd_docs)').all() as Array<{ name?: string }>;
      archivedColumnKnown = cols.some((c) => c.name === 'archived');
    } catch {
      archivedColumnKnown = false;
    }
  }
  return archivedColumnKnown ? 'AND archived = 0' : '';
}

/** 库内 doc_kind 为缺省 'prd' 时按文件名推断，使「设计文档被导入成 prd」也能贴对类型 */
export function effectiveDocKind(filename: string | null | undefined, stored: string | null | undefined): PrdDocKind {
  if (stored === 'design' || stored === 'test') return stored;
  return inferDocKindFromFilename(filename);
}

/**
 * 主 PRD id 解析：若传入的是设计/测试文档，按其 `related_prd_id` 上溯到主 PRD；
 * 上溯目标已不存在（被物理删除）时退回自身，保证单文档行为不报错。
 */
export function resolvePrimaryPrdId(prdId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT related_prd_id FROM prd_docs WHERE id = ?').get(prdId) as { related_prd_id?: string } | undefined;
  const parent = row?.related_prd_id?.trim();
  if (!parent) return prdId;
  const exists = db.prepare('SELECT 1 FROM prd_docs WHERE id = ?').get(parent);
  return exists ? parent : prdId;
}

/**
 * 主 PRD 的关联文档全集（主 PRD 恒在首位）。无关联时返回仅含主 PRD 的 1 项——
 * 调用方据此区分「无配套设计文档」（1 项）与「未关联 PRD」（0 项/找不到）。
 */
export function listRelatedPrdDocs(primaryPrdId: string, opts: { maxDocs?: number } = {}): PrdDocRef[] {
  const db = getDb();
  const primaryId = resolvePrimaryPrdId(primaryPrdId);
  const primary = db.prepare(
    'SELECT id, project_id, filename, content_md, doc_kind, related_prd_id FROM prd_docs WHERE id = ?',
  ).get(primaryId) as DocRow | undefined;
  if (!primary) return [];

  const rows = db.prepare(
    `SELECT id, project_id, filename, content_md, doc_kind, related_prd_id FROM prd_docs
      WHERE project_id = ? AND related_prd_id = ? AND id <> ? ${archivedFilter(db)}
      ORDER BY updated_at DESC`,
  ).all(primary.project_id, primary.id, primary.id) as DocRow[];

  const related: PrdDocRef[] = rows.map((r) => ({
    prdId: r.id,
    filename: r.filename,
    docKind: effectiveDocKind(r.filename, r.doc_kind),
    chars: r.content_md.length,
    relation: 'linked' as const,
  }));
  // 类型优先（设计 → 测试 → 其余），同类型按 updated_at 倒序（rows 已是倒序，sort 稳定）
  const rank: Record<PrdDocKind, number> = { design: 0, test: 1, prd: 2 };
  related.sort((a, b) => rank[a.docKind] - rank[b.docKind]);

  const max = opts.maxDocs ?? 8;
  return [
    {
      prdId: primary.id,
      filename: primary.filename,
      docKind: effectiveDocKind(primary.filename, primary.doc_kind),
      chars: primary.content_md.length,
      relation: 'primary',
    },
    ...related.slice(0, Math.max(0, max - 1)),
  ];
}

/** mtask_get_prd 的 `docs[]` 元素（对外契约）：id/filename/doc_kind/chars/relation [+ content] */
export interface PrdDocPayload {
  id: string;
  filename: string;
  doc_kind: PrdDocKind;
  chars: number;
  relation: PrdDocRelation;
  content?: string;
}

/**
 * 组装 mtask_get_prd 的 `docs[]`（纯增量字段）。
 * `readContent` 由调用方注入（MCP 层传 PlanService.getPrdDoc），本模块不依赖 service 层，避免循环导入。
 * 关联查询失败降级为 `[]`，绝不让主查询整体失败。
 */
export function buildPrdDocsPayload(
  primaryPrdId: string,
  opts: { includeContent?: boolean; readContent?: (prdId: string) => string } = {},
): PrdDocPayload[] {
  let refs: PrdDocRef[];
  try {
    refs = listRelatedPrdDocs(primaryPrdId);
  } catch {
    return [];
  }
  const withContent = opts.includeContent !== false && typeof opts.readContent === 'function';
  return refs.map((r) => {
    const item: PrdDocPayload = {
      id: r.prdId, filename: r.filename, doc_kind: r.docKind, chars: r.chars, relation: r.relation,
    };
    if (withContent) {
      try {
        item.content = opts.readContent!(r.prdId) ?? '';
      } catch {
        item.content = '';
      }
    }
    return item;
  });
}

/** 项目内主 PRD 候选（未归档，且类型判定为 'prd'） */
function listPrimaryCandidates(db: ReturnType<typeof getDb>, projectId: string, selfId: string): Array<{ id: string; filename: string }> {
  const rows = db.prepare(
    `SELECT id, filename, doc_kind FROM prd_docs WHERE project_id = ? AND id <> ? ${archivedFilter(db)}`,
  ).all(projectId, selfId) as Array<{ id: string; filename: string; doc_kind: string }>;
  return rows.filter((r) => effectiveDocKind(r.filename, r.doc_kind) === 'prd').map((r) => ({ id: r.id, filename: r.filename }));
}

/**
 * 按文件名主题为主 PRD 找「唯一」候选：命中多篇时判为歧义，宁可留空也不乱挂
 * （设计文档挂错主 PRD 会把 A 任务的 SDD 注入到 B 任务上下文，比查不到更糟）。
 */
function findTopicPrdId(db: ReturnType<typeof getDb>, projectId: string, filename: string, selfId: string): string {
  const topic = normalizeDocTopic(filename);
  if (!topic) return '';
  const matched = listPrimaryCandidates(db, projectId, selfId).filter((c) => isSameTopic(topic, normalizeDocTopic(c.filename)));
  const ids = [...new Set(matched.map((c) => c.id))];
  return ids.length === 1 ? ids[0] : '';
}

/**
 * 导入建边：同一批落库的 design/test 文档显式挂到本批主 PRD。
 * - 本批含主 PRD：直接用（同批即配套关系，覆盖旧边）；
 * - 本批只有设计文档：按「同主题唯一命中」回落到项目存量主 PRD（单独补传 SDD 的场景）；
 * - 回落歧义/无候选：留空，读取时自然退回单文档行为。
 * 返回实际建立/更新的边数。
 */
export function linkImportedPrdDocs(
  projectId: string,
  docs: Array<{ id?: string; filename: string; docKind: PrdDocKind }>,
  t: string,
): number {
  const db = getDb();
  const persisted = docs.filter((d): d is { id: string; filename: string; docKind: PrdDocKind } => !!d.id);
  if (persisted.length === 0) return 0;
  const primaryId = persisted.find((d) => d.docKind === 'prd')?.id ?? '';
  let linked = 0;
  for (const d of persisted) {
    if (d.docKind === 'prd') continue;
    const target = primaryId || findTopicPrdId(db, projectId, d.filename, d.id);
    if (!target || target === d.id) continue;
    // 同批含主 PRD 时以本批为准（覆盖旧边）；回落模式只补空值，不抢用户已有的显式关联
    const sql = primaryId
      ? 'UPDATE prd_docs SET related_prd_id = ?, doc_kind = ?, updated_at = ? WHERE id = ?'
      : "UPDATE prd_docs SET related_prd_id = ?, doc_kind = ?, updated_at = ? WHERE id = ? AND COALESCE(related_prd_id, '') = ''";
    linked += db.prepare(sql).run(target, d.docKind, t, d.id).changes;
  }
  return linked;
}

/** 需求跟踪矩阵「关联SDD」列的数据源：主 PRD id → 一份设计文档（多份时取最近更新的那份） */
export function listSddDocIndex(projectId: string): Map<string, { id: string; filename: string }> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, filename, related_prd_id, doc_kind FROM prd_docs
      WHERE project_id = ? AND COALESCE(related_prd_id, '') <> '' ${archivedFilter(db)}
      ORDER BY updated_at DESC`,
  ).all(projectId) as Array<{ id: string; filename: string; related_prd_id: string; doc_kind: string }>;
  const out = new Map<string, { id: string; filename: string }>();
  for (const r of rows) {
    if (effectiveDocKind(r.filename, r.doc_kind) !== 'design') continue;
    if (!out.has(r.related_prd_id)) out.set(r.related_prd_id, { id: r.id, filename: r.filename });
  }
  return out;
}

/**
 * 存量回填（服务启动时调用，幂等）：把还没有关联边的 design/test 文档按「同主题唯一命中」挂到主 PRD。
 * 只处理 evidence 明确的行——文件名能判出设计/测试类型、且同项目内主题唯一匹配；
 * 判不出的保持原样（''），读取路径退回单文档行为，不做猜测。
 * 同时修正「设计文档被导入成 doc_kind='prd'」的历史脏值。
 */
export function backfillPrdDocLinks(): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, project_id, filename, doc_kind FROM prd_docs WHERE COALESCE(related_prd_id, '') = '' ${archivedFilter(db)}`,
  ).all() as Array<{ id: string; project_id: string; filename: string; doc_kind: string }>;
  const t = new Date().toISOString();
  let linked = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      const kind = effectiveDocKind(r.filename, r.doc_kind);
      if (kind === 'prd') continue;
      const target = findTopicPrdId(db, r.project_id, r.filename, r.id);
      if (!target) continue;
      linked += db.prepare('UPDATE prd_docs SET related_prd_id = ?, doc_kind = ?, updated_at = ? WHERE id = ?')
        .run(target, kind, t, r.id).changes;
    }
  });
  run();
  return linked;
}
