/**
 * 汇报材料耗时样本（T03189 / PRD G-1）。
 *
 * 口径（G-1 原文）：**固定卡种与数据集，从打开卡片到成品下载，包含用量确认和必要重试；同时记录 P50/P90**。
 * 故一个样本 = 一次「打开卡片 → 拿到成品文件」的完整用户回合：
 *  - `started_at` 在卡片展开那一刻记（不是点「生成」时），用量确认阶段也算在内；
 *  - 重试不新开样本（同一卡片未结束前重复 start 返回原样本），保证「必要重试」被如实计入时长；
 *  - 只有下载成功才 `ok=1`；用户放弃/失败也留样本（`ok=0`）但**不进 P50/P90**——否则「放弃」会拉低指标。
 *
 * 刻意不做的事：不按 AI 调用累加（那是 `ai_usage` 的职责，G-2/G-3 用它），
 * 也不在这里存模型/硬件指纹（G-1 要求的「固定场景」由卡种 + 采集周期在展示层声明）。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';

export interface TimingSample {
  cardKey: string;
  projectId?: string;
}

export interface TimingStats {
  cardKey: string;
  samples: number;
  ok: number;
  abandoned: number;
  p50Ms: number | null;
  p90Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
}

export interface TimingReport {
  windowDays: number;
  since: string;
  byCard: TimingStats[];
  overall: TimingStats;
  notes: string[];
}

const nowIso = (): string => new Date().toISOString();

/**
 * 未收口样本的保鲜期：4 小时内视为同一轮（切走再回来、重试都计入同一样本）；
 * 超时说明用户已离开这一轮，按放弃收口——否则「隔天再打开同一个卡片」会被算成几小时的准备时长，
 * 把 P90 直接打穿。放弃样本只计入放弃率，不进 P50/P90。
 */
const OPEN_SAMPLE_TTL_MS = 4 * 60 * 60 * 1000;

/** 最近邻百分位（样本少时比插值更贴近「实测值」语义，避免报出一个没人达到过的数字） */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function toStats(cardKey: string, rows: Array<{ duration_ms: number; ok: number }>): TimingStats {
  const done = rows.filter((r) => r.ok === 1).map((r) => r.duration_ms).sort((a, b) => a - b);
  const abandoned = rows.length - done.length;
  const sum = done.reduce((a, b) => a + b, 0);
  return {
    cardKey,
    samples: rows.length,
    ok: done.length,
    abandoned,
    p50Ms: percentile(done, 50),
    p90Ms: percentile(done, 90),
    avgMs: done.length ? Math.round(sum / done.length) : null,
    maxMs: done.length ? done[done.length - 1] : null,
  };
}

export class MaterialTimingService {
  /** 卡片展开：已有未结束样本则复用（重试不另起一条），返回样本 id */
  static start(args: TimingSample): { id: string } {
    const db = getDb();
    const cardKey = String(args.cardKey ?? '').trim();
    if (!cardKey) throw new Error('卡片标识必填');
    const open = db.prepare(
      'SELECT id, started_at FROM material_timing_samples WHERE card_key = ? AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1',
    ).get(cardKey) as { id: string; started_at: string } | undefined;
    if (open) {
      const age = Date.now() - new Date(open.started_at).getTime();
      if (age <= OPEN_SAMPLE_TTL_MS) return { id: open.id };
      MaterialTimingService.finish({ id: open.id, ok: false }); // 跨轮遗留：收口为放弃，再从零起算
    }
    const id = uuid();
    db.prepare(
      'INSERT INTO material_timing_samples (id, card_key, project_id, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, cardKey, args.projectId ?? null, nowIso(), nowIso());
    return { id };
  }

  /**
   * 拿回样本 id 收口。`ok=false` 也落库（放弃/失败样本用于看「放弃率」，不进 P50/P90）。
   * 传 `sampleId` 时按 id 收口（下载发生在另一处、卡片卸载后仍可收口）；
   * 不传则按卡种找最近一条未结束样本（同一卡片同时只会有一条未结束样本，见 start 的复用规则）。
   */
  static finish(args: { id?: string; cardKey?: string; ok?: boolean }): { id: string | null; durationMs: number | null } {
    const db = getDb();
    let row: { id: string; started_at: string } | undefined;
    if (args.id) {
      row = db.prepare('SELECT id, started_at FROM material_timing_samples WHERE id = ? AND finished_at IS NULL').get(args.id) as typeof row;
    } else if (args.cardKey) {
      row = db.prepare(
        'SELECT id, started_at FROM material_timing_samples WHERE card_key = ? AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1',
      ).get(String(args.cardKey)) as typeof row;
    }
    if (!row) return { id: null, durationMs: null };
    const finishedAt = nowIso();
    const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(row.started_at).getTime());
    db.prepare('UPDATE material_timing_samples SET finished_at = ?, duration_ms = ?, ok = ? WHERE id = ?')
      .run(finishedAt, durationMs, args.ok === false ? 0 : 1, row.id);
    return { id: row.id, durationMs };
  }

  /** 按采集窗口出 P50/P90。窗口内一条样本都没有时返回空统计 + 说明（不报 0ms） */
  static stats(days = 30): TimingReport {
    const db = getDb();
    // 只认「≥1 的有限整数」；0/负数/非数字一律按未指定处理（30 天）。
    // 不用 `Number(x) || 30`：0 会被吞成 30、负数又被 clamp 成 1，同一类非法输入落两个口径。
    const n = Math.floor(Number(days));
    const windowDays = Number.isFinite(n) && n >= 1 ? Math.min(365, n) : 30;
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const rows = db.prepare(
      'SELECT card_key, duration_ms, ok FROM material_timing_samples WHERE created_at >= ? AND finished_at IS NOT NULL',
    ).all(since) as Array<{ card_key: string; duration_ms: number; ok: number }>;
    const byCardMap = new Map<string, Array<{ duration_ms: number; ok: number }>>();
    for (const r of rows) {
      const list = byCardMap.get(r.card_key) ?? [];
      list.push({ duration_ms: r.duration_ms, ok: r.ok });
      byCardMap.set(r.card_key, list);
    }
    const byCard = Array.from(byCardMap.entries())
      .map(([k, list]) => toStats(k, list))
      .sort((a, b) => b.samples - a.samples || a.cardKey.localeCompare(b.cardKey));
    const notes: string[] = [];
    if (rows.length === 0) notes.push(`近 ${windowDays} 天还没有完成的材料准备样本；P50/P90 不予估算`);
    notes.push('口径：从展开材料卡片到成品下载成功；用量确认与重试均计入；放弃/失败样本只计入放弃率，不进 P50/P90');
    return { windowDays, since, byCard, overall: toStats('all', rows), notes };
  }
}
