/**
 * T03245（PRD AI-103 ①②③）：长文分段生成的持久台账。
 *
 * 此前讲稿/长文的段落只活在一次 SSE 连接里：单段失败后已生成内容随页面刷新一起消失，
 * 「重试失败段」只能靠前端内存记住点了哪几节。这里把任务（job）与段（segment）落进
 * `ai_gen_jobs` / `ai_gen_segments`，让三件事变成服务端事实：
 *   ① 单段失败只标记该段（status=failed），其余段照常 done 且正文留档；
 *   ② 重试按段做——done 段直接复用正文，只为 failed/pending 段发 AI 调用；
 *   ③ 刷新/重进后按卡取最近一个 job 回读进度，不需要前端记得本次选择。
 *
 * 与 console_jobs（T00417）同族；与 ai_job_runs（T03192）不同：后者只存「整轮终态样本」用于
 * 成功率统计，本表存的是可续生成的过程态。旧任务按卡保留最近 N 份，防止长文正文无限堆积。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';

/** 每卡保留最近多少个任务（含段落正文）——长文重试只需要最近一份，更早的留作短时追溯 */
export const GEN_JOB_KEEP_PER_CARD = 20;

export type GenJobStatus = 'running' | 'done' | 'partial' | 'aborted' | 'error';
export type GenSegmentStatus = 'pending' | 'running' | 'done' | 'failed' | 'stale';

export interface GenSegmentPlan {
  sectionKey: string;
  /** 段内稳定标识（讲稿：`projectId|module`）——跨请求一致才能复用 */
  segmentKey: string;
  label: string;
  projectId?: string;
  projectName?: string;
  module?: string;
  heading?: string;
  orderIndex: number;
}

export interface GenSegmentRecord extends Required<Omit<GenSegmentPlan, 'projectId' | 'projectName' | 'module' | 'heading'>> {
  projectId: string;
  projectName: string;
  module: string;
  heading: string;
  status: GenSegmentStatus;
  text: string;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface GenSegmentView extends GenSegmentRecord {
  anchors: unknown[];
  anchorIssues: unknown[];
}

export interface GenSectionView {
  key: string;
  total: number;
  done: number;
  failed: number;
  segments: GenSegmentView[];
}

export interface GenJobView {
  id: string;
  cardKey: string;
  toolId: string;
  title: string;
  status: GenJobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  progress: {
    sectionsTotal: number;
    sectionsDone: number;
    segmentsTotal: number;
    segmentsDone: number;
    segmentsFailed: number;
  };
  sections: GenSectionView[];
}

interface JobRow {
  id: string;
  card_key: string;
  tool_id: string;
  title: string;
  status: GenJobStatus;
  request_json: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface SegmentRow {
  job_id: string;
  section_key: string;
  segment_key: string;
  label: string;
  project_id: string;
  project_name: string;
  module: string;
  heading: string;
  order_index: number;
  status: GenSegmentStatus;
  text: string;
  error: string | null;
  attempts: number;
  anchors_json: string;
  anchor_issues_json: string;
  updated_at: string;
}

const now = (): string => new Date().toISOString();

const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

/** 开一个新任务；同一卡超出保留份数的旧任务连同段落一起删除 */
export function openJob(args: { cardKey: string; toolId: string; title: string; request: unknown }): string {
  const db = getDb();
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO ai_gen_jobs (id, card_key, tool_id, title, status, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(id, args.cardKey, args.toolId, args.title, JSON.stringify(args.request ?? {}), t, t);
  const stale = db.prepare(
    `SELECT id FROM ai_gen_jobs WHERE card_key = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
  ).all(args.cardKey, GEN_JOB_KEEP_PER_CARD) as Array<{ id: string }>;
  for (const row of stale) {
    db.prepare('DELETE FROM ai_gen_segments WHERE job_id = ?').run(row.id);
    db.prepare('DELETE FROM ai_gen_jobs WHERE id = ?').run(row.id);
  }
  return id;
}

/** 任务原始入参（刷新后重试靠它重建请求，用户不必重选范围） */
export function jobRequest(jobId: string): { view: GenJobView; request: Record<string, unknown> } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_gen_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!row) return null;
  const request = parseJson<Record<string, unknown>>(row.request_json, {});
  return { view: toView(row, db.prepare('SELECT * FROM ai_gen_segments WHERE job_id = ? ORDER BY order_index, section_key').all(jobId) as SegmentRow[]), request };
}

/**
 * 声明本轮计划的全部段落（幂等）。已有行只更新展示信息，绝不覆盖 status/text——
 * 刷新/重试时「已完成段」正是靠这一点保住。
 * `markStale=true` 时，计划外且仍为 pending/failed 的行标 stale（仓库区间变了导致模块消失），
 * done 行保持 done：正文仍是有效产出，不该因为一次口径变化被抹掉。
 */
export function declareSegments(jobId: string, plan: readonly GenSegmentPlan[], opts: { markStale?: boolean } = {}): void {
  const db = getDb();
  const t = now();
  const upsert = db.prepare(
    `INSERT INTO ai_gen_segments
       (job_id, section_key, segment_key, label, project_id, project_name, module, heading, order_index, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(job_id, section_key, segment_key) DO UPDATE SET
       label = excluded.label,
       project_id = excluded.project_id,
       project_name = excluded.project_name,
       module = excluded.module,
       heading = excluded.heading,
       order_index = excluded.order_index,
       updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const p of plan) {
      upsert.run(jobId, p.sectionKey, p.segmentKey, p.label, p.projectId ?? '', p.projectName ?? '', p.module ?? '', p.heading ?? '', p.orderIndex, t);
    }
    if (opts.markStale) {
      const keep = new Set(plan.map((p) => `${p.sectionKey}\u0000${p.segmentKey}`));
      const rows = db.prepare(
        `SELECT section_key, segment_key FROM ai_gen_segments WHERE job_id = ? AND status IN ('pending', 'failed', 'running')`,
      ).all(jobId) as Array<{ section_key: string; segment_key: string }>;
      const mark = db.prepare(
        `UPDATE ai_gen_segments SET status = 'stale', updated_at = ? WHERE job_id = ? AND section_key = ? AND segment_key = ?`,
      );
      for (const r of rows) {
        if (!keep.has(`${r.section_key}\u0000${r.segment_key}`)) mark.run(t, jobId, r.section_key, r.segment_key);
      }
    }
    db.prepare('UPDATE ai_gen_jobs SET updated_at = ? WHERE id = ?').run(t, jobId);
  })();
}

/** 读回本任务里已成功的段（key = section\u0000segment），供重试/续作跳过重复调用 */
export function reusableSegments(jobId: string): Map<string, GenSegmentView> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM ai_gen_segments WHERE job_id = ? AND status = 'done' AND text <> ''`,
  ).all(jobId) as SegmentRow[];
  const map = new Map<string, GenSegmentView>();
  for (const r of rows) map.set(`${r.section_key}\u0000${r.segment_key}`, toSegmentView(r));
  return map;
}

/**
 * T03263（REQ-020）：跨任务复用——同卡、同 sectionKey 下历史上已完成的段，最新任务优先。
 * 请求指纹相同的重跑（失败重试 / 刷新重来）直接拿回已完成段，不再重复调用模型；
 * `reusableSegments` 只在单个任务内复用，本函数把复用面扩到同卡的历史任务。
 */
export function doneSegmentsFor(cardKey: string, sectionKey: string): Map<string, GenSegmentView> {
  const rows = getDb().prepare(
    `SELECT s.* FROM ai_gen_segments s JOIN ai_gen_jobs j ON j.id = s.job_id
      WHERE j.card_key = ? AND s.section_key = ? AND s.status = 'done' AND s.text <> ''
      ORDER BY j.created_at DESC, s.updated_at DESC`,
  ).all(cardKey, sectionKey) as SegmentRow[];
  const map = new Map<string, GenSegmentView>();
  for (const r of rows) {
    const k = `${r.section_key}\u0000${r.segment_key}`;
    if (!map.has(k)) map.set(k, toSegmentView(r));
  }
  return map;
}

/** 段开始：置 running、attempts+1（刷新时 running 视为未完成，下一轮会重跑） */
export function beginSegment(jobId: string, sectionKey: string, segmentKey: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE ai_gen_segments SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE job_id = ? AND section_key = ? AND segment_key = ?`,
  ).run(now(), jobId, sectionKey, segmentKey);
  db.prepare('UPDATE ai_gen_jobs SET updated_at = ? WHERE id = ?').run(now(), jobId);
}

/** 段结束：成功写正文与锚点；失败只写错误，不动其他段 */
export function finishSegment(jobId: string, args: {
  sectionKey: string; segmentKey: string; ok: boolean; text: string; error?: string;
  anchors?: unknown[]; anchorIssues?: unknown[];
}): void {
  const db = getDb();
  db.prepare(
    `UPDATE ai_gen_segments SET status = ?, text = ?, error = ?, anchors_json = ?, anchor_issues_json = ?, updated_at = ?
     WHERE job_id = ? AND section_key = ? AND segment_key = ?`,
  ).run(
    args.ok ? 'done' : 'failed',
    args.ok ? args.text : '',
    args.ok ? null : (args.error ?? '生成失败'),
    JSON.stringify(args.ok ? (args.anchors ?? []) : []),
    JSON.stringify(args.ok ? (args.anchorIssues ?? []) : []),
    now(), jobId, args.sectionKey, args.segmentKey,
  );
  db.prepare('UPDATE ai_gen_jobs SET updated_at = ? WHERE id = ?').run(now(), jobId);
}

/** 任务收尾：状态由调用方判定（done / partial / aborted / error），此处只落终态 */
export function finalizeJob(jobId: string, status: Exclude<GenJobStatus, 'running'>): void {
  const t = now();
  getDb().prepare('UPDATE ai_gen_jobs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?').run(status, t, t, jobId);
}

/** 按卡取最近一个任务（刷新恢复入口）；无任务返回 null */
export function latestJob(cardKey: string): GenJobView | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM ai_gen_jobs WHERE card_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(cardKey) as JobRow | undefined;
  if (!row) return null;
  return toView(row, db.prepare('SELECT * FROM ai_gen_segments WHERE job_id = ? ORDER BY order_index, section_key').all(row.id) as SegmentRow[]);
}

function toSegmentView(r: SegmentRow): GenSegmentView {
  return {
    sectionKey: r.section_key,
    segmentKey: r.segment_key,
    label: r.label,
    projectId: r.project_id,
    projectName: r.project_name,
    module: r.module,
    heading: r.heading,
    orderIndex: r.order_index,
    status: r.status,
    text: r.text,
    error: r.error,
    attempts: r.attempts,
    updatedAt: r.updated_at,
    anchors: parseJson<unknown[]>(r.anchors_json, []),
    anchorIssues: parseJson<unknown[]>(r.anchor_issues_json, []),
  };
}

/** 视图只暴露非 stale 段：口径变化后消失的模块不该继续出现在进度里 */
function toView(row: JobRow, segments: readonly SegmentRow[]): GenJobView {
  const sections: GenSectionView[] = [];
  const byKey = new Map<string, GenSectionView>();
  for (const r of segments) {
    if (r.status === 'stale') continue;
    let section = byKey.get(r.section_key);
    if (!section) {
      section = { key: r.section_key, total: 0, done: 0, failed: 0, segments: [] };
      byKey.set(r.section_key, section);
      sections.push(section);
    }
    const seg = toSegmentView(r);
    section.segments.push(seg);
    section.total += 1;
    if (seg.status === 'done') section.done += 1;
    if (seg.status === 'failed') section.failed += 1;
  }
  const segmentsTotal = sections.reduce((n, s) => n + s.total, 0);
  return {
    id: row.id,
    cardKey: row.card_key,
    toolId: row.tool_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    progress: {
      sectionsTotal: sections.length,
      sectionsDone: sections.filter((s) => s.total > 0 && s.done === s.total).length,
      segmentsTotal,
      segmentsDone: sections.reduce((n, s) => n + s.done, 0),
      segmentsFailed: sections.reduce((n, s) => n + s.failed, 0),
    },
    sections,
  };
}
