/**
 * T03192（七期 §7.4，PRD 整合版 G-3）：AI 生成 job 级终态样本 —— 成功率基线积累。
 *
 * 为什么单独落库：`ai_usage` 是「一次模型调用」粒度（不知道 job 的终态、取消、产物齐全度），
 * `console_jobs` 是自由提示词控制台的运行历史（无取消/节次概念），都不能替代 G-3 的 job 口径。
 *
 * 口径单源：成功/部分/取消的判定走 `lectureMetrics.summarizeJobSuccess`
 * （与 T02169/T03173 同规则——取消不进分母、done 但节次不全只进分母、AI/离线按 mode 分列），
 * 这里只负责落库与窗口筛选，不另写一套算法。
 *
 * 数据来源：`POST /metrics/ai-jobs` 由各生成入口在 job 终态上报；讲稿流式生成（`/api/plans/code-review-lecture-stream`）
 * 已接入完整轮（非仅大纲、非续作/单节重试）。其余卡片的生产者接入见派生单（T03192 回传的后续建议）。
 */
import { getDb } from '../db/connection';
import { isRegisteredCardKey } from '../util/aiCards';
import { summarizeJobSuccess, type JobSuccessSummary, type LectureSessionMode } from './lectureMetrics';
import { scalarText } from '../util/scalarText';

const STATUSES = new Set(['done', 'aborted', 'error']);
const MODES = new Set(['ai', 'offline', 'unknown']);

export interface AiJobRunInput {
  jobId: string;
  cardKey: string;
  status: string;
  mode?: string | null;
  sectionsTotal?: unknown;
  sectionsOk?: unknown;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface AiJobRunRow {
  id: string;
  card_key: string;
  mode: string;
  status: string;
  sections_total: number;
  sections_ok: number;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export interface JobSuccessRateReport extends JobSuccessSummary {
  windowDays: number;
  since: string;
  target: number;
  /** 样本不足（分母 0）时为 null——缺失不判达标也不判不达标 */
  meets: boolean | null;
  note: string;
}

const TARGET = 0.9;

function nonNegativeInt(value: unknown, name: string): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 需为非负整数，收到：${scalarText(value)}`);
  return n;
}

function isoOr(value: unknown, name: string, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const text = scalarText(value);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`${name} 需为可解析的时间，收到：${text}`);
  return new Date(ms).toISOString();
}

export class AiJobStats {
  static record(input: AiJobRunInput): AiJobRunRow {
    const jobId = String(input.jobId ?? '').trim();
    if (!jobId) throw new Error('jobId 必填');
    if (jobId.length > 120) throw new Error('jobId 过长（≤120 字符）');
    const cardKey = String(input.cardKey ?? '').trim();
    if (!cardKey) throw new Error('cardKey 必填');
    // 未注册的 key 一律拒收：放任等于允许调用方用通道 kind 冒充卡片维度（G-2/G-3 同一红线）
    if (!isRegisteredCardKey(cardKey)) throw new Error(`card_key 未注册：${cardKey}`);
    const status = String(input.status ?? '');
    if (!STATUSES.has(status)) throw new Error(`status 需为 done|aborted|error，收到：${status}`);
    const mode = input.mode === undefined || input.mode === null || input.mode === '' ? 'unknown' : String(input.mode);
    if (!MODES.has(mode)) throw new Error(`mode 需为 ai|offline|unknown，收到：${mode}`);
    const sectionsTotal = nonNegativeInt(input.sectionsTotal, 'sectionsTotal');
    const sectionsOk = nonNegativeInt(input.sectionsOk, 'sectionsOk');
    if (sectionsOk > sectionsTotal) throw new Error('sectionsOk 不能大于 sectionsTotal');
    const now = new Date().toISOString();
    const startedAt = isoOr(input.startedAt, 'startedAt', now);
    const finishedAt = isoOr(input.finishedAt, 'finishedAt', now);
    if (startedAt > finishedAt) throw new Error('startedAt 不能晚于 finishedAt');

    getDb().prepare(
      `INSERT INTO ai_job_runs (id, card_key, mode, status, sections_total, sections_ok, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         card_key = excluded.card_key, mode = excluded.mode, status = excluded.status,
         sections_total = excluded.sections_total, sections_ok = excluded.sections_ok,
         started_at = excluded.started_at, finished_at = excluded.finished_at`,
    ).run(jobId, cardKey, mode, status, sectionsTotal, sectionsOk, startedAt, finishedAt, now);
    return AiJobStats.get(jobId)!;
  }

  static get(jobId: string): AiJobRunRow | undefined {
    return getDb().prepare('SELECT * FROM ai_job_runs WHERE id = ?').get(jobId) as AiJobRunRow | undefined;
  }

  static successRate(args: { days?: unknown; mode?: unknown; cardKey?: unknown } = {}): JobSuccessRateReport {
    // 与材料耗时统计同一解析口径：非法/0/负数按未指定处理（30 天），上限 365
    const n = Math.floor(Number(args.days));
    const windowDays = Number.isFinite(n) && n >= 1 ? Math.min(365, n) : 30;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const where = ['finished_at >= ?'];
    const params: string[] = [since];
    if (args.mode !== undefined && args.mode !== null && args.mode !== '') {
      const mode = scalarText(args.mode);
      if (!MODES.has(mode)) throw new Error(`mode 需为 ai|offline|unknown，收到：${mode}`);
      where.push('mode = ?');
      params.push(mode);
    }
    if (args.cardKey !== undefined && args.cardKey !== null && args.cardKey !== '') {
      where.push('card_key = ?');
      params.push(scalarText(args.cardKey));
    }

    const rows = getDb().prepare(
      `SELECT status, sections_total AS total, sections_ok AS ok, mode FROM ai_job_runs
        WHERE ${where.join(' AND ')} ORDER BY finished_at`,
    ).all(...params) as Array<{ status: string; total: number; ok: number; mode: string }>;
    const summary = summarizeJobSuccess(rows.map((r) => ({
      status: r.status as 'done' | 'aborted' | 'error',
      sectionsTotal: r.total,
      sectionsOk: r.ok,
      ...(r.mode === 'unknown' ? {} : { mode: r.mode as Exclude<LectureSessionMode, 'unknown'> }),
    })));

    const note = summary.attempted === 0
      ? `近 ${windowDays} 天还没有可计入的 AI job 终态样本（用户取消不计入分母），成功率暂不估算`
      : '口径：按 job 统计（segment 不重复计）；用户主动取消不进分母；done 但节次不全计 partial，只进分母；重试复用同一 jobId 时以终态覆盖；离线/AI 按 mode 分列';

    return {
      ...summary,
      windowDays,
      since,
      target: TARGET,
      meets: summary.successRate === null ? null : summary.successRate >= TARGET,
      note,
    };
  }
}
