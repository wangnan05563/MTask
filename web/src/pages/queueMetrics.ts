/**
 * 队列消费监控的纯计算层（不渲染、不请求），供 QueuePage / 面板组件共用。
 *
 * 为什么单独成文件：监控口径（成功率、平均耗时、吞吐、ETA）一旦散落在 JSX 里，
 * 就会随「表格里算一遍、卡片里再算一遍」漂移——例如成功率的分母到底含不含 timeout。
 * 这里统一约定：
 *   - **已收口** = success + failed + timeout（终态，poller 不会再改）
 *   - **成功率** = success / 已收口（未开始时为 null，而不是 0%，避免「刚建队列就 0%」的误导）
 *   - **耗时** = finished_at −（sent_at ?? submitted_at）；在途项用 now − 同一起点算「已等待」
 * 时间一律按 ISO 字符串解析为毫秒时间戳，解析失败按 null 处理（脏数据不参与统计，不静默当 0）。
 */
import { fmtElapsed } from '../ui/runStatus';
import type { QueueJob } from '../api/client';

/** Job 状态筛选档位：running 覆盖 sending（用户视角的「执行中」） */
export type JobFilter = 'all' | 'queued' | 'running' | 'success' | 'failed';

/** 单工具消费统计 */
export interface ToolStat {
  readonly id: string;
  readonly name: string;
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly avgCostMs: number | null;
}

/** 单项目消费统计（跨项目队列才有意义） */
export interface ProjectStat {
  readonly id: string;
  readonly name: string;
  readonly total: number;
  readonly success: number;
}

export interface QueueMetrics {
  readonly total: number;
  readonly queued: number;
  readonly sending: number;
  readonly success: number;
  /** failed + timeout（用户视角都是「失败」，细分见 timeout） */
  readonly failed: number;
  readonly timeout: number;
  /** 已收口任务数（success + failed + timeout） */
  readonly settled: number;
  /** 收口进度 0~1（无任务时为 0） */
  readonly progress: number;
  /** success / settled；尚无收口任务时为 null */
  readonly successRate: number | null;
  readonly avgCostMs: number | null;
  readonly maxCostMs: number | null;
  /** 最慢的一条（用于「哪条在拖」的点名提示） */
  readonly slowest: { readonly title: string; readonly ms: number } | null;
  /** 近 5 分钟收口条数（吞吐展示用） */
  readonly completedLast5Min: number;
  /** 待执行（排队 + 在途）× 平均耗时；无均值时为 null */
  readonly etaMs: number | null;
  /** 当前最久在途项的已等待时长；无在途为 null */
  readonly oldestSendingMs: number | null;
  readonly byTool: readonly ToolStat[];
  readonly byProject: readonly ProjectStat[];
  /** 首个 Job 的开始时刻（毫秒）；从未开始为 null */
  readonly startedAt: number | null;
  /** 最后一个收口时刻（毫秒） */
  readonly lastFinishedAt: number | null;
}

const SETTLED_STATUS = new Set(['success', 'failed', 'timeout']);
const FIVE_MIN_MS = 5 * 60 * 1000;

/** ISO 字符串 → 毫秒；空值/非法值返回 null（不参与统计） */
export function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
}

/** Job 起算点：优先 sent_at，异步受理类工具有 submitted_at 兜底 */
function startOf(job: QueueJob): number | null {
  return parseTs(job.sent_at) ?? parseTs(job.submitted_at);
}

/** 已收口 Job 的耗时（毫秒）；未收口/时间缺失返回 null */
export function jobCostMs(job: QueueJob): number | null {
  if (!SETTLED_STATUS.has(job.status)) return null;
  const start = startOf(job);
  const end = parseTs(job.finished_at);
  if (start == null || end == null) return null;
  return Math.max(0, end - start);
}

/** 在途 Job 的已等待时长（毫秒）；非在途/缺起点返回 null */
export function jobElapsedMs(job: QueueJob, now = Date.now()): number | null {
  if (job.status !== 'sending') return null;
  const start = startOf(job);
  if (start == null) return null;
  return Math.max(0, now - start);
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** 展示用：耗时（复用 runStatus 的 45s / 1m05s 口径，避免两套格式） */
export function fmtCost(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return fmtElapsed(ms);
}

/** 展示用：时间点（本地时区 HH:MM:SS，不回显时区后缀——本地单机工具无需） */
export function fmtClock(value: string | null | undefined): string {
  const n = parseTs(value);
  if (n == null) return '—';
  return new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 展示用：相对时刻（「3 分钟前」），列表卡片上比绝对时刻更好读 */
export function fmtAgo(value: string | null | undefined, now = Date.now()): string {
  const n = parseTs(value);
  if (n == null) return '—';
  const diff = Math.max(0, now - n);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 队列消费监控聚合：一次遍历，全部派生指标在本地算 */
export function computeQueueMetrics(jobs: readonly QueueJob[], now = Date.now()): QueueMetrics {
  let queued = 0;
  let sending = 0;
  let success = 0;
  let failedOnly = 0;
  let timeout = 0;

  const costs: number[] = [];
  const costsByTool = new Map<string, number[]>();
  const toolAgg = new Map<string, { name: string; total: number; success: number; failed: number }>();
  const projectAgg = new Map<string, { name: string; total: number; success: number }>();

  let slowest: { title: string; ms: number } | null = null;
  let oldestSendingMs: number | null = null;
  let startedAt: number | null = null;
  let lastFinishedAt: number | null = null;
  let completedLast5Min = 0;

  for (const job of jobs) {
    const start = startOf(job);
    if (start != null && (startedAt == null || start < startedAt)) startedAt = start;

    if (job.status === 'queued') queued += 1;
    if (job.status === 'sending') {
      sending += 1;
      const elapsed = jobElapsedMs(job, now);
      if (elapsed != null && (oldestSendingMs == null || elapsed > oldestSendingMs)) oldestSendingMs = elapsed;
    }
    if (job.status === 'success') success += 1;
    if (job.status === 'failed') failedOnly += 1;
    if (job.status === 'timeout') timeout += 1;

    const cost = jobCostMs(job);
    if (cost != null) {
      costs.push(cost);
      const end = parseTs(job.finished_at);
      if (end != null) {
        if (lastFinishedAt == null || end > lastFinishedAt) lastFinishedAt = end;
        if (now - end <= FIVE_MIN_MS) completedLast5Min += 1;
      }
      const title = job.task_title ?? job.task_no ?? job.task_id.slice(0, 8);
      if (!slowest || cost > slowest.ms) slowest = { title, ms: cost };
    }

    // 工具维度：所有 Job 都计入（含未执行），耗时只算已收口的
    const toolKey = job.tool_id;
    const toolName = job.tool_name ?? job.tool_id.slice(0, 8) ?? '未知工具';
    const tool = toolAgg.get(toolKey) ?? { name: toolName, total: 0, success: 0, failed: 0 };
    tool.total += 1;
    if (job.status === 'success') tool.success += 1;
    if (job.status === 'failed' || job.status === 'timeout') tool.failed += 1;
    toolAgg.set(toolKey, tool);
    if (cost != null) {
      const list = costsByTool.get(toolKey) ?? [];
      list.push(cost);
      costsByTool.set(toolKey, list);
    }

    // 项目维度：任务已删（LEFT JOIN 为 null）归入「未知项目」，不丢计数
    const projectId = job.task_project_id ?? '';
    const projectName = job.task_project_name ?? '未知项目';
    const project = projectAgg.get(projectId) ?? { name: projectName, total: 0, success: 0 };
    project.total += 1;
    if (job.status === 'success') project.success += 1;
    projectAgg.set(projectId, project);
  }

  const total = jobs.length;
  const settled = success + failedOnly + timeout;
  const failed = failedOnly + timeout;
  const avgCostMs = average(costs);

  return {
    total,
    queued,
    sending,
    success,
    failed,
    timeout,
    settled,
    progress: total === 0 ? 0 : settled / total,
    successRate: settled === 0 ? null : success / settled,
    avgCostMs,
    maxCostMs: costs.length === 0 ? null : Math.max(...costs),
    slowest,
    completedLast5Min,
    etaMs: avgCostMs == null || queued + sending === 0 ? null : avgCostMs * (queued + sending),
    oldestSendingMs,
    byTool: [...toolAgg.entries()]
      .map(([id, v]) => ({ id, name: v.name, total: v.total, success: v.success, failed: v.failed, avgCostMs: average(costsByTool.get(id) ?? []) }))
      .sort((a, b) => b.total - a.total),
    byProject: [...projectAgg.entries()]
      .map(([id, v]) => ({ id, name: v.name, total: v.total, success: v.success }))
      // 未归属项目（id=''）固定排最后：它是「任务被删」的兜底桶，不是真实项目
      .sort((a, b) => {
        if (a.id === '') return 1;
        if (b.id === '') return -1;
        return b.total - a.total;
      }),
    startedAt,
    lastFinishedAt,
  };
}

/** 状态档位命中判定（单源，列表 tab 与行内高亮必须同一口径） */
export function matchesJobFilter(job: QueueJob, filter: JobFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'queued': return job.status === 'queued';
    case 'running': return job.status === 'sending';
    case 'success': return job.status === 'success';
    case 'failed': return job.status === 'failed' || job.status === 'timeout';
    default: return true;
  }
}

/** 关键词检索：任务编号/标题/工具/项目/错误信息（大小写不敏感） */
export function filterJobs(jobs: readonly QueueJob[], filter: JobFilter, keyword: string): QueueJob[] {
  const kw = keyword.trim().toLowerCase();
  return jobs.filter((job) => {
    if (!matchesJobFilter(job, filter)) return false;
    if (!kw) return true;
    const haystack = [job.task_no, job.task_title, job.tool_name, job.task_project_name, job.error]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(kw);
  });
}
