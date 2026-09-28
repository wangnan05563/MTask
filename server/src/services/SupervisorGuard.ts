/**
 * T01276（PRD FR-4.1~FR-4.5）：监督决策的**安全护栏**——LLM 只「建议」，护栏「拍板」。
 *
 * 职责边界：本模块**只裁决动作能否落地**，不执行任何动作（RESUME/REDISPATCH/SPLIT 的落地
 * 属执行层 FR-3.x，由 M3 承接）。输入是 T01275 产出的动作计划，输出「放行 / 拦截（降级 ESCALATE）」，
 * 拦截原因供 T01278 写 `monitor_runs.blocked_by` 审计。
 *
 * 依赖方向有意为单向：Guard 不 import SupervisorService（否则与 decide() 构成循环依赖），
 * 故熔断判定 `readEnabled` 在此实现并对外导出，由 SupervisorService 复用——两处必须同一口径。
 *
 * 五道闸（顺序即优先级；前两道是全局闸，命中即整轮降级）：
 * 1) 熔断 `supervisor.enabled=0`（FR-4.5）——用户一键接管，任何自动动作都不许发；
 * 2) 预算 `supervisor.tokenBudget`（FR-4.4）——成本失控的代价高于「本轮少跑几个任务」，故先于单动作闸；
 * 3) 并发 `supervisor.maxConcurrent`（FR-4.1）——仅「会新开执行会话」的动作占槽；
 * 4) 重试上限 `supervisor.maxRetry`（FR-4.2）——仅「触发类」动作受约束；
 * 5) 冷却 `supervisor.cooldownMs`（FR-4.3）——同上，防同一任务抖动循环。
 *
 * 被拦截的动作一律**降级**为 ESCALATE（FR-2.4）而非丢弃：让「AI 想做什么但被拦」在审计与
 * 通知里可见，避免静默失败（NFR-3）。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';

/** 熔断开关配置键（与 SupervisorService 同口径） */
const ENABLED_KEY = 'supervisor.enabled';

/** 护栏默认值（PRD FR-4.1~FR-4.3）；配置缺失/非法时回退 */
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_RETRY = 3;
/** 冷却默认 5min：远大于监督周期 30s（防抖动），又短于会话停滞阈值 10min（不误伤正常续跑） */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/** 触发类动作：会改变任务/会话执行状态，受重试上限与冷却约束 */
const TRIGGER_ACTIONS = new Set(['RESUME', 'REDISPATCH', 'SPLIT']);
/** 占并发槽的动作：会新开或重开外部平台执行会话（CONTINUE 只是等待，SPLIT 只产子任务不派发） */
const CONCURRENCY_ACTIONS = new Set(['RESUME', 'REDISPATCH']);

/** 冷却窗口内扫描的审计行上限：窗口已由 cooldownMs 限定，此值只兜底防大表全扫 */
const COOLDOWN_SCAN_LIMIT = 200;

/** IN 查询分片大小：规避 SQLite 变量上限 999（与 TaskService / ExecSessionService 同口径） */
const IN_CHUNK = 200;

/**
 * 护栏动作的最小结构约束。
 * 有意不直接复用 SupervisorService 的 SupervisorAction——那会形成循环依赖；
 * 结构化类型下 SupervisorAction 天然兼容本接口，调用方无需转换。
 */
export interface GuardAction {
  type: string;
  taskId?: string;
  platform?: string;
  toPlatform?: string;
  reason: string;
}

/** 护栏上下文：只取拍板所需的最小输入，避免与 MonitorSnapshot 强耦合 */
export interface GuardContext {
  /** 当前活跃执行会话数（取自快照 budget.concurrent）——并发闸的「已用」侧 */
  concurrent: number;
}

export interface BlockedAction<A extends GuardAction> {
  /** LLM 原始动作 */
  action: A;
  /** 拦截原因详情（含具体数值，供展示） */
  reason: string;
  /** 降级后的动作（ESCALATE，保留 taskId 便于人工接手） */
  degraded: A;
}

export interface GuardResult<A extends GuardAction> {
  /** 放行、可落地的动作（原样） */
  applied: A[];
  /** 被拦截并降级的动作 */
  blocked: BlockedAction<A>[];
  /** 拦截原因去重汇总（「；」连接；空串=未拦截），供 monitor_runs.blocked_by */
  blockedBy: string;
  /** 是否触发全局停摆（熔断/预算耗尽）——调用方据此跳过本轮全部落地 */
  halted: boolean;
}

/** 熔断开关读取：仅 '1' / 'true' 视为开启（与 SupervisorService 同口径） */
export function readEnabled(): boolean {
  const raw = getSetting(ENABLED_KEY);
  return raw === '1' || raw === 'true';
}

/** 数值型护栏配置读取：缺失/空串/非法一律回退默认。
 *  必须显式挡空值——`Number(null)` 与 `Number('')` 都是 0，会让 maxConcurrent 意外变 0（全部动作被拦）。 */
function readInt(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 批量取任务监督重试计数（FR-4.2 口径：tasks.monitor_retry） */
function loadRetryCounts(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const chunk = uniq.slice(i, i + IN_CHUNK);
    const rows = getDb()
      .prepare(`SELECT id, monitor_retry FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Array<{ id: string; monitor_retry: number }>;
    for (const r of rows) out.set(r.id, r.monitor_retry ?? 0);
  }
  return out;
}

/** 解析 monitor_runs.applied（JSON 数组）；脏数据按空数组处理 */
function parseApplied(raw: string | null): GuardAction[] {
  try {
    const v = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is GuardAction => !!x && typeof x === 'object' && typeof (x as GuardAction).type === 'string');
  } catch {
    return [];
  }
}

/**
 * 取各任务「最近一次触发」时间戳（冷却闸输入，FR-4.3）。
 *
 * 数据源为 `monitor_runs.applied`——审计表是「动作已落地」的权威留痕（由 T01278 写入），
 * 比 tasks 的状态时间字段更贴合「触发」语义。表内暂无记录时视为「从未触发」→ 冷却不拦：
 * 护栏逻辑保持完备，数据源待审计落库填充，不会因缺数据而误拦正常续跑。
 */
function loadLastFiredAt(cooldownMs: number): Map<string, number> {
  const out = new Map<string, number>();
  if (cooldownMs <= 0) return out;
  const since = new Date(Date.now() - cooldownMs).toISOString();
  const rows = getDb()
    .prepare('SELECT ran_at, applied FROM monitor_runs WHERE ran_at >= ? ORDER BY ran_at DESC LIMIT ?')
    .all(since, COOLDOWN_SCAN_LIMIT) as Array<{ ran_at: string; applied: string | null }>;
  for (const r of rows) {
    const ts = Date.parse(r.ran_at);
    if (!Number.isFinite(ts)) continue;
    for (const a of parseApplied(r.applied)) {
      if (!a.taskId || !TRIGGER_ACTIONS.has(a.type)) continue;
      const prev = out.get(a.taskId);
      if (prev == null || ts > prev) out.set(a.taskId, ts);
    }
  }
  return out;
}

/** 降级为 ESCALATE：保留 taskId 便于人工接手，reason 带原动作与拦截原因（可审计） */
function degrade<A extends GuardAction>(a: A, reason: string): A {
  return { ...a, type: 'ESCALATE', reason: `[护栏拦截] ${reason}；原动作 ${a.type}：${a.reason}` } as A;
}

/**
 * 动作计划过护栏（FR-2.4 / §6）。
 * 泛型保留调用方的动作类型（传入 SupervisorAction[] 即得 SupervisorAction[]，无需转换）。
 */
export function guard<A extends GuardAction>(actions: A[], ctx: GuardContext): GuardResult<A> {
  const applied: A[] = [];
  const blocked: BlockedAction<A>[] = [];
  const reasons: string[] = [];

  /** 全局闸命中：整轮动作降级。reasons 记「类别」而非带数值详情，避免 blocked_by 被同因刷屏 */
  const halt = (detail: string, category: string): GuardResult<A> => {
    for (const a of actions) blocked.push({ action: a, reason: detail, degraded: degrade(a, detail) });
    reasons.push(category);
    return { applied, blocked, blockedBy: summarize(reasons), halted: true };
  };

  if (actions.length === 0) return { applied, blocked, blockedBy: '', halted: false };

  // 闸 1：熔断（FR-4.5）——用户一键接管，优先级最高
  if (!readEnabled()) return halt('熔断开关已关闭（supervisor.enabled=0）', '熔断已关闭');

  // 闸 2：预算（FR-4.4）——成本失控的代价高于「本轮少跑」，故先于单动作闸
  const budget = readInt('supervisor.tokenBudget', 0);
  const used = readInt('supervisor.tokenUsed', 0);
  if (budget > 0 && used >= budget) return halt(`token 预算已耗尽（${used}/${budget}）`, 'token 预算耗尽');

  const maxConcurrent = readInt('supervisor.maxConcurrent', DEFAULT_MAX_CONCURRENT);
  const maxRetry = readInt('supervisor.maxRetry', DEFAULT_MAX_RETRY);
  const cooldownMs = readInt('supervisor.cooldownMs', DEFAULT_COOLDOWN_MS);
  const retryById = loadRetryCounts(actions.map((a) => a.taskId ?? ''));
  const lastFiredById = loadLastFiredAt(cooldownMs);
  // 已用并发槽 = 当前活跃会话数 + 本轮已放行的占槽动作：一次 tick 内多个动作须累计，否则会超卖
  let usedSlots = Math.max(0, ctx.concurrent);

  for (const a of actions) {
    // CONTINUE 只是「保持等待」、ESCALATE 已是人工态：均不消耗资源，直接放行
    if (!TRIGGER_ACTIONS.has(a.type)) {
      applied.push(a);
      continue;
    }
    const tid = a.taskId;

    // 闸 3：并发（FR-4.1）
    if (CONCURRENCY_ACTIONS.has(a.type) && usedSlots >= maxConcurrent) {
      const detail = `并发已达上限（${usedSlots}/${maxConcurrent}）`;
      reasons.push('并发已达上限');
      blocked.push({ action: a, reason: detail, degraded: degrade(a, detail) });
      continue;
    }

    if (tid) {
      // 闸 4：重试上限（FR-4.2）——超限说明反复失败，自动重试只会继续撞墙，必须转人工
      const retry = retryById.get(tid) ?? 0;
      if (retry >= maxRetry) {
        const detail = `重试已达上限（${retry}/${maxRetry}）`;
        reasons.push('重试已达上限');
        blocked.push({ action: a, reason: detail, degraded: degrade(a, detail) });
        continue;
      }
      // 闸 5：冷却（FR-4.3）——防同一任务被高频重复触发形成抖动循环
      const last = lastFiredById.get(tid);
      if (last != null && Date.now() - last < cooldownMs) {
        const detail = `冷却未过（距上次触发 ${Math.round((Date.now() - last) / 1000)}s < ${Math.round(cooldownMs / 1000)}s）`;
        reasons.push('冷却未过');
        blocked.push({ action: a, reason: detail, degraded: degrade(a, detail) });
        continue;
      }
    }

    if (CONCURRENCY_ACTIONS.has(a.type)) usedSlots++;
    applied.push(a);
  }

  return { applied, blocked, blockedBy: summarize(reasons), halted: false };
}

/** 拦截原因去重汇总：同类闸命中多次只记一次 */
function summarize(reasons: string[]): string {
  return [...new Set(reasons)].join('；');
}