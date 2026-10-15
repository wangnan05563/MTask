/**
 * T01058 后续：计划行复杂度（plan_tasks.complexity）批量补算。
 *
 * 背景：complexity 目前只在 **PRD 导入**时由 AI 一并给出（`PlanService.aiParsePrd`），
 * 手工新建/Excel 导入/早期存量行一律为 NULL——「复杂度 ≥4 建议拆分」的提示对这些行完全不生效
 * （实测 mtask 项目 19 行、aimsg 行全为空）。本服务把缺失的补上。
 *
 * 为什么**批量**而不是复用单条 AI 评估：单条评估是「一行一次模型调用」，19 行 = 19 次往返，
 * 既慢又容易撞限流；批量按批（默认 20 行/次）让模型一次看一片，口径也更一致
 * （模型能横向比较同一批任务的相对复杂度，逐条打分反而容易全给 3）。
 */
import { getDb } from '../db/connection';
import { AIService } from './AIService';

/** 单批行数：兼顾输出长度（每行约 40 字符）与模型一次看全一片的口径一致性 */
const DEFAULT_BATCH = 20;

export interface ComplexityRow {
  id: string;
  title: string;
  description: string;
  duration_days: number;
  kind: string;
}

export interface BackfillResult {
  /** 扫描到的目标行数（缺失复杂度的行；force=1 时为项目下全部行） */
  scanned: number;
  /** 成功写入的行数 */
  updated: number;
  /** 每批的调用情况（供前端提示哪批失败、可重跑） */
  batches: Array<{ offset: number; size: number; updated: number; error?: string }>;
}

/** 取待补算的计划行：有 description 时截断（避免把整篇 PRD 塞进提示词） */
export function listMissing(projectId: string, opts: { force?: boolean; ids?: string[] } = {}): ComplexityRow[] {
  const db = getDb();
  const args: unknown[] = [projectId];
  let where = 'project_id = ? AND archived = 0';
  if (!opts.force) where += ' AND complexity IS NULL';
  if (opts.ids && opts.ids.length > 0) {
    where += ` AND id IN (${opts.ids.map(() => '?').join(',')})`;
    args.push(...opts.ids);
  }
  return db
    .prepare(`SELECT id, title, COALESCE(description, '') AS description, duration_days, COALESCE(kind, 'normal') AS kind FROM plan_tasks WHERE ${where} ORDER BY sort_order, created_at`)
    .all(...args) as ComplexityRow[];
}

/** 复杂度钳位单源函数：AI / Excel / 手工批量常返回 3.5/7/0 这类越界值，一律夹回 1~5 的整数 */
export function clampComplexity(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 1 || r > 5) return null;
  return r;
}

/** T02122：取未归档行中 complexity 非空但落在 1~5 之外的非法行 */
export interface InvalidRow {
  id: string;
  title: string;
  complexity: number;
}

export function listInvalid(projectId: string): InvalidRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, title, complexity FROM plan_tasks WHERE project_id = ? AND archived = 0 AND complexity IS NOT NULL AND (complexity < 1 OR complexity > 5) ORDER BY sort_order, created_at",
    )
    .all(projectId) as InvalidRow[];
}

const SYSTEM = [
  '你是项目计划评审助手。对给定的计划任务逐条评定**实现复杂度**（1~5 整数）。',
  '评级口径：1=琐碎（半天内可完成，无不确定性）；2=简单（1~2 天，做法明确）；3=中等（3~5 天，需查资料或联调）；',
  '4=复杂（不确定性高、跨模块耦合，建议再拆分）；5=极复杂（应拆分为多个任务才能落地）。',
  '要求：',
  '1. 只依据「任务标题 + 描述 + 工期」判断，不要臆造需求背景；信息不足时按标题字面给中位值 3。',
  '2. 里程碑行（kind=milestone）给其下明细的平均水平，通常不超过 3。',
  '3. **只输出 JSON 数组**，每项 {"id":"<原样回抄输入 id>","complexity":<1~5 整数>}，不要解释、不要代码围栏。',
  '4. 必须为每个输入行都输出一项，id 原样回抄，不得增删行。',
].join('\n');

/** 单行的提示词条目：id 原样回抄，描述截断（整篇 PRD 塞进提示词会把注意力吃光） */
function rowPromptLine(r: ComplexityRow): string {
  const desc = r.description ? ` | 描述=${r.description.slice(0, 200)}` : '';
  return `- id=${r.id} | kind=${r.kind} | 工期=${r.duration_days}天 | 标题=${r.title}${desc}`;
}

/** askJson 的解析器：模型偶尔带代码围栏/前后废话，抠完还必须真是数组，否则抛错让本批判失败 */
function parseBatchOutput(content: string): Array<{ id?: unknown; complexity?: unknown }> {
  const parsed: unknown = JSON.parse(extractJson(content));
  if (!Array.isArray(parsed)) throw new Error('输出不是 JSON 数组');
  return parsed as Array<{ id?: unknown; complexity?: unknown }>;
}

/** 按 id 建索引：模型偶尔漏行/改 id，逐 id 匹配比按数组下标对齐稳（下标错位会把分数写错行） */
function indexScoresByid(items: Array<{ id?: unknown; complexity?: unknown }>): Map<string, number | null> {
  const byId = new Map<string, number | null>();
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (id) byId.set(id, clampComplexity(item?.complexity));
  }
  return byId;
}

/**
 * 批量补算复杂度。
 *
 * @param toolId    AI 工具 id（前端模型下拉）
 * @param projectId 项目 id
 * @param opts.force  true = 连已有评级的行也重算（默认只补 NULL）
 * @param opts.ids    限定行（多选批量时用）；为空 = 项目下全部目标行
 * @param opts.batch  每批行数（默认 20）
 */
export async function backfillComplexity(
  toolId: string,
  projectId: string,
  opts: { force?: boolean; ids?: string[]; batch?: number } = {},
): Promise<BackfillResult> {
  if (!toolId) throw new Error('toolId 必填（请先在模型菜单配置 AI 工具）');
  if (!projectId) throw new Error('projectId 必填');
  const rows = listMissing(projectId, opts);
  const size = Math.min(50, Math.max(1, Math.round(opts.batch ?? DEFAULT_BATCH)));
  const out: BackfillResult = { scanned: rows.length, updated: 0, batches: [] };
  if (rows.length === 0) return out;

  const db = getDb();
  const upd = db.prepare('UPDATE plan_tasks SET complexity = ?, updated_at = ? WHERE id = ?');
  const nowIso = new Date().toISOString();

  for (let offset = 0; offset < rows.length; offset += size) {
    const slice = rows.slice(offset, offset + size);
    const batch: { offset: number; size: number; updated: number } = { offset, size: slice.length, updated: 0 };
    const user = slice.map(rowPromptLine).join('\n');
    const res = await AIService.askJson<Array<{ id?: unknown; complexity?: unknown }>>(
      toolId,
      SYSTEM,
      `【待评定的计划行（共 ${slice.length} 行）】\n${user}`,
      parseBatchOutput,
      { maxTokens: 4096, temperature: 0 },
    );
    if (!res.ok || !res.data) {
      out.batches.push({ ...batch, error: res.error ?? 'AI 调用失败' });
      continue;
    }
    const byId = indexScoresByid(res.data);
    for (const r of slice) {
      const c = byId.get(r.id);
      if (c == null) continue; // 该行未给出合法评级 → 保持原值，下一轮可重跑
      upd.run(c, nowIso, r.id);
      batch.updated++;
      out.updated++;
    }
    out.batches.push(batch);
  }
  return out;
}

/** 从可能带代码围栏/前后废话的输出里抠出 JSON（askJson 的 parse 抛错即视为无效，故必须稳健） */
function extractJson(content: string): string {
  const s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('未找到 JSON 数组');
  return body.slice(start, end + 1);
}
