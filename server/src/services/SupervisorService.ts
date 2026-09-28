/**
 * T01273（PRD FR-2.1）：常驻监督器骨架——「AI 编排大脑」决策层的驱动入口。
 *
 * 复用 RecurringService 的 tick 驱动方式：由 server 周期调用 supervisorTick()，单例幂等——
 * 无监督对象时空转返回，只走索引探测，不调 LLM、不开写事务，满足 NFR-1「空转单轮 < 50ms」。
 *
 * 职责边界：
 * - 观测层停滞兜底并入本 tick（M1 已上线的 ExecSessionService.expireStaleSessions）；
 * - 状态快照采集见 collectSnapshot()（T01274）；LLM 裁决见 decide()（T01275）；
 *   护栏拍板见 SupervisorGuard.guard()（T01276，独立模块以避免与 decide() 循环依赖）；
 * - 异常降级见 buildDegradedActions()（T01278 / NFR-3）：决策 LLM 不可用时把待人工关注的对象
 *   统一升级为 ESCALATE 并打日志，避免「AI 不可用 → 本轮静默无动作 → 任务无人管」。
 * - 就绪排水入口在 tick 内调用 TaskService.markMonitorReady()（T01280 / FR-3.1）：无未完成前置依赖的
 *   待办置 monitor_ready=1，外部平台据此拉取；标记须先于空转判定执行（理由见 supervisorTick 注释）。
 *
 * 熔断语义（FR-4.5）：`supervisor.enabled=0`（默认）时**决策层**完全停摆，任务保持现状；
 * 但观测层兜底不受开关影响——停滞标记是零风险的只读观测信号，一并停掉会让面板停在「假存活」。
 *
 * 审计落库见 SupervisorAudit.recordMonitorRun（T01285 / FR-4.6）：tick 在进入决策流程的轮次末
 * 写一行 monitor_runs；本文件只负责把各阶段产出交给它，落库实现与摘要口径均在审计模块内。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { ExecSessionService } from './ExecSessionService';
import { AIService } from './AIService';
import { ConfigService } from './ConfigService';
import { TaskService } from './TaskService'; // T01280：就绪待办标记（FR-3.1），TaskService 不反向依赖本模块，无循环
import { guard, readEnabled, type GuardResult } from './SupervisorGuard';
import { applyActions, type ApplyOutcome } from './SupervisorExecutor'; // T01282：动作落地（FR-3.3~3.5）
import { recordMonitorRun } from './SupervisorAudit'; // T01285：决策轮次审计落库（FR-4.6）
import { parsePlanDeps, depsSatisfied } from '../util/planDeps'; // T01284：deps 判定统一实现（FR-3.7，与 TaskService 同口径）

/** 监督 tick 默认周期 30s（FR-2.1） */
const DEFAULT_INTERVAL_MS = 30_000;
/** tick 周期配置键（FR-2.1） */
const INTERVAL_KEY = 'supervisor.intervalMs';

export interface SupervisorConfig {
  /** 熔断开关：默认关闭，自动动作需用户显式开启（FR-4.5） */
  enabled: boolean;
  intervalMs: number;
}

/** 空转探测结果：只回答「有没有监督对象」，不拉明细（明细由 T01274 的快照采集负责） */
export interface SupervisorProbe {
  hasActiveSession: boolean;
  hasStalledSession: boolean;
  hasRunningTask: boolean;
  /** 任一为真即需进入决策流程 */
  hasWork: boolean;
}

export interface SupervisorTickResult {
  /** 本轮是否进入决策流程（false = 空转 / 熔断 / 上一轮未结束） */
  ran: boolean;
  reason: 'ok' | 'disabled' | 'idle' | 'busy';
  /** 本轮新标记为 stalled 的会话数（观测层兜底产物） */
  stalledMarked: number;
  probe: SupervisorProbe;
  /** 进入决策流程时采集的状态快照（T01274）；空转/熔断轮次为 undefined */
  snapshot?: MonitorSnapshot;
  /** 本轮 LLM 裁决结果（T01275）；未进入决策流程时为 undefined */
  decision?: SupervisorDecision;
  /** 本轮动作过护栏的拍板结果（T01276）；未进入决策流程时为 undefined */
  guard?: GuardResult<SupervisorAction>;
  /** T01278：本轮因决策 LLM 不可用而走异常降级——decision.actions 由 buildDegradedActions 生成而非 LLM 产出 */
  degraded?: boolean;
  /** T01280：本轮新标记就绪（monitor_ready=1）的待办数；熔断轮次不标记，故为 undefined */
  readyMarked?: number;
  /** T01282：本轮护栏放行动作的落地结果（FR-3.3~3.5）；未进入决策流程时为 undefined，供 T01285 写 monitor_runs */
  executed?: ApplyOutcome[];
}

/** 快照规模上限：LLM 输入需可控（NFR-1「有动作时 LLM 调用 < 10s」），超出部分只计数不入快照 */
const PENDING_LIMIT = 50;
const FAILED_LIMIT = 50;

/** 决策 LLM 超时（NFR-1：有动作时 LLM 调用 < 10s，超时由上层降级 ESCALATE） */
const DECISION_TIMEOUT_MS = 10_000;
/** 决策输出 token 上限（PRD §7：决策输出短小） */
const DECISION_MAX_TOKENS = 2048;
/** 决策温度（PRD §7：temperature=0 让同一快照的裁决稳定可复现） */
const DECISION_TEMPERATURE = 0;
/** 单轮动作数上限：白名单之外的刷屏式输出直接截断，防幻觉放大 */
const ACTION_LIMIT = 20;
/** 监督决策模型配置键（PRD §13：独立「监控专用」模型） */
const TOOL_KEY = 'supervisor.toolId';

/** 待办优先级排序权重（SQL CASE 与之一致，改这里需同步改 collectSnapshot 的 ORDER BY） */
const PRIORITY_CASE = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 9 END";

/** 快照里的前置依赖项（源：plan_tasks.deps，T00499） */
export interface SnapshotDep {
  planTaskId: string;
  title: string;
  type: 'serial' | 'parallel';
  /** 前置计划是否已完成；计划行已不存在时按「已完成」处理，与 PlanService.readyTasks 同口径 */
  done: boolean;
}

export interface SnapshotPending {
  taskId: string;
  taskNo: string | null;
  title: string;
  priority: string;
  deps: SnapshotDep[];
  /** 依赖满足（serial 前置均已完成；parallel 不阻塞；无 deps 视为就绪）——FR-3.1/3.7 排水判定输入 */
  ready: boolean;
}

export interface SnapshotSession {
  platform: string;
  status: string;
  progress: number;
  /** 停滞标记（status='stalled' 的语义化别名，便于 LLM 直接消费） */
  stale: boolean;
  /** 会话关联任务（LLM 据 taskId 产出 RESUME/REDISPATCH 动作） */
  tasks: Array<{ taskId: string; taskNo: string | null; title: string }>;
}

export interface SnapshotFailed {
  taskId: string;
  taskNo: string | null;
  title: string;
  /** 监督器重试计数（tasks.monitor_retry，FR-4.2） */
  retryCount: number;
}

export interface SnapshotBudget {
  /** 已用 token：ai_usage 当前无 token 列，M2 先读累计配置键，FR-4.4 落地时改为真实计量 */
  usedTokens: number;
  /** 预算上限，0 = 不限（supervisor.tokenBudget） */
  maxTokens: number;
  /** 当前活跃会话数 */
  concurrent: number;
  maxConcurrent: number;
}

/** 决策 LLM 的输入快照（设计 §4.2 / PRD FR-2.2） */
export interface MonitorSnapshot {
  generatedAt: string;
  pending: SnapshotPending[];
  /** 待办池全量计数（pending 受 PENDING_LIMIT 截断，此值供 LLM 判断积压规模） */
  pendingTotal: number;
  sessions: SnapshotSession[];
  failed: SnapshotFailed[];
  budget: SnapshotBudget;
}

/** 决策动作类型（PRD §6 白名单：仅这 5 类安全动作，其余一律判为无效输出） */
export type SupervisorActionType = 'CONTINUE' | 'RESUME' | 'REDISPATCH' | 'SPLIT' | 'ESCALATE';

const ACTION_TYPES = new Set<string>(['CONTINUE', 'RESUME', 'REDISPATCH', 'SPLIT', 'ESCALATE']);

/** 决策 LLM 产出的单条动作（结构对齐 PRD §7 模板） */
export interface SupervisorAction {
  type: SupervisorActionType;
  /** 目标任务 id（取自快照）；无目标动作可缺省 */
  taskId?: string;
  /** RESUME 的源平台 */
  platform?: string;
  /** REDISPATCH 的目标平台 */
  toPlatform?: string;
  reason: string;
}

/** 一轮裁决结果（含审计所需的模型名与耗时） */
export interface SupervisorDecision {
  ok: boolean;
  /** 决策模型名（供 T01278 写 monitor_runs 审计） */
  model: string;
  /** 动作计划；ok=false 时为空数组 */
  actions: SupervisorAction[];
  /** 是否经过「精简提示词」重试 */
  retried: boolean;
  error?: string;
  durationMs: number;
}

/** 决策 LLM system 提示（PRD §7 模板逐条落地） */
const MONITOR_SYSTEM_PROMPT = [
  '你是 MTask 的监督决策器。你监控外部 AI 平台（WorkBuddy/Trae）的执行会话与待办状态，产出下一步动作计划。',
  '只依据下方快照，不虚构任务、不虚构 taskId。',
  '可用动作：',
  '- CONTINUE：会话健康，等待下一心跳',
  '- RESUME：会话停滞，重新标记就绪触发续跑',
  '- REDISPATCH：连续失败，换到另一个平台（toPlatform 指定目标平台）',
  '- SPLIT：任务复杂度过高，拆分为子任务',
  '- ESCALATE：超重试上限/需人工判断',
  '只输出 JSON：{"actions":[{"type":"...","taskId":"...","toPlatform":"...","reason":"..."}]}；',
  '无需动作时输出 {"actions":[]}；reason 用简体中文，一句话说明依据。',
].join('\n');

/** 重试用的精简提示（复用 askJson 的 retrySystem 机制）：首轮截断/解析失败时压缩输出规模再试 */
const MONITOR_RETRY_PROMPT = [
  '你是 MTask 的监督决策器。仅输出 JSON，不要解释、不要 Markdown 代码块。',
  '格式：{"actions":[{"type":"CONTINUE|RESUME|REDISPATCH|SPLIT|ESCALATE","taskId":"...","toPlatform":"...","reason":"..."}]}',
  'taskId 必须取自快照；无动作输出 {"actions":[]}。',
].join('\n');

/**
 * 解析并校验决策 LLM 的 JSON 输出（作为 askJson 的 parse 回调——抛错即触发其自带的一次重试）。
 * 校验从严：动作类型须在 §6 白名单内、reason 必填；不合规即整轮判为无效输出，
 * 交给 askJson 用精简提示重试，仍失败则由 tick 记入 decision.error 降级（NFR-3）。
 */
function parseActions(content: string): SupervisorAction[] {
  const parsed = JSON.parse(content) as { actions?: unknown };
  if (!Array.isArray(parsed?.actions)) throw new Error('输出缺少 actions 数组');
  const out: SupervisorAction[] = [];
  for (const item of parsed.actions.slice(0, ACTION_LIMIT)) {
    if (!item || typeof item !== 'object') throw new Error('动作项不是对象');
    const r = item as Record<string, unknown>;
    const type = String(r.type ?? '').toUpperCase();
    if (!ACTION_TYPES.has(type)) throw new Error(`未知动作类型：${String(r.type)}`);
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!reason) throw new Error(`动作 ${type} 缺少 reason`);
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    out.push({
      type: type as SupervisorActionType,
      taskId: str(r.taskId),
      platform: str(r.platform),
      toPlatform: str(r.toPlatform),
      reason,
    });
  }
  return out;
}

/**
 * T01278（NFR-3）：决策 LLM 不可用时的**异常降级**——产出人工可见的 ESCALATE 动作。
 *
 * 为什么必须产出动作而不是空手而归：`decide()` 失败若只留空动作，链路表现就是「AI 看过快照
 * 但什么都没做」，与「快照里确实无事可做」在日志和面板上无从区分——前者是故障、后者是正常，
 * 静默会让人误判系统健康。NFR-3 要求异常「统一降级为人工可见状态」，故此处显式升级为 ESCALATE。
 *
 * 指向对象按「最需人工介入」排序：停滞会话关联任务 → 失败任务，去重后上限 ACTION_LIMIT。
 * 快照里没有这两类对象时（例如仅 running 任务且会话健康）产出一条无 taskId 的全局信号，
 * 保证降级始终可见，而非因「无对象可指」再次静默。
 *
 * 「平台不可达」的降级不在 M2：M2 无平台调用（拉取式属 T01280、推送式兜底属 T01283），
 * 而平台不可达在观测层的表现就是心跳超时 → 会话 stalled，已被本函数的第一个来源覆盖。
 */
function buildDegradedActions(snapshot: MonitorSnapshot, error?: string): SupervisorAction[] {
  const reason = `[异常降级] 决策 LLM 不可用（${error || '未知错误'}），本轮无法自动裁决，转人工`;
  const out: SupervisorAction[] = [];
  const seen = new Set<string>();
  /** 追加一条降级动作；返回是否已达上限（true = 调用方应立即收手） */
  const push = (taskId?: string): boolean => {
    if (taskId) {
      if (seen.has(taskId)) return false;
      seen.add(taskId);
    }
    out.push({ type: 'ESCALATE', taskId, reason });
    return out.length >= ACTION_LIMIT;
  };
  for (const s of snapshot.sessions) {
    if (!s.stale) continue;
    for (const t of s.tasks) if (push(t.taskId)) return out;
  }
  for (const f of snapshot.failed) if (push(f.taskId)) return out;
  if (out.length === 0) push();
  return out;
}

/**
 * 解析监督决策所用模型：优先「监控专用」配置 `supervisor.toolId`（PRD §13 独立监控模型）；
 * 未配置（或指向已删除工具）时回退默认 AI 梳理 / 开发工具——否则开关打开后决策链路会整体不可用。
 */
function resolveDecisionToolId(): string | null {
  const explicit = getSetting(TOOL_KEY);
  if (explicit && getDb().prepare('SELECT 1 FROM ai_tools WHERE id = ?').get(explicit)) return explicit;
  const d = ConfigService.getDefaults();
  return d.organize ?? d.develop ?? null;
}

/** 异步 tick 的重入闸：LLM 调用最长 DECISION_TIMEOUT_MS 而 intervalMs 最小可配 1s，无闸会叠轮重复调 LLM */
let ticking = false;

/** 配置解析：缺失/非法一律回退默认，避免 0 或 NaN 让定时器退化成忙轮询 */
function readIntervalMs(): number {
  const n = Number(getSetting(INTERVAL_KEY));
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
}

/** 数值型监督配置读取：缺失/空串/非法回退默认（`supervisor.maxConcurrent`、`supervisor.tokenBudget` 等）。
 *  显式挡空值——`Number(null)` 为 0，会让未配置的 maxConcurrent 显示成 0 并与护栏口径不一致。 */
function readIntSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** exec_sessions.task_ids（JSON 数组字符串）解析；脏数据按空数组处理 */
function parseTaskIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const SupervisorService = {
  getConfig(): SupervisorConfig {
    return { enabled: readEnabled(), intervalMs: readIntervalMs() };
  },

  /**
   * 空转探测：三条 EXISTS 各走一条索引（idx_exec_platform_status / idx_tasks_ai_state），
   * 用 LIMIT 1 而非 COUNT——命中即返回，让空转轮次成本与表规模无关（NFR-1）。
   */
  probe(): SupervisorProbe {
    const db = getDb();
    const has = (sql: string): boolean => !!db.prepare(sql).get();
    const hasActiveSession = has("SELECT 1 FROM exec_sessions WHERE status = 'active' LIMIT 1");
    const hasStalledSession = has("SELECT 1 FROM exec_sessions WHERE status = 'stalled' LIMIT 1");
    const hasRunningTask = has("SELECT 1 FROM tasks WHERE ai_state = 'running' LIMIT 1");
    return {
      hasActiveSession,
      hasStalledSession,
      hasRunningTask,
      hasWork: hasActiveSession || hasStalledSession || hasRunningTask,
    };
  },

  /**
   * T01274（FR-2.2）：采集决策 LLM 的输入快照——待办池（含计划依赖）、活跃/停滞会话、失败任务、预算占用。
   *
   * 全部为**只读批量查询**，不做 N+1：待办、其计划行、依赖计划、会话关联任务各自一次 IN 查询；
   * IN 批次按 200 切分以规避 SQLite 变量上限 999（与 TaskService / ExecSessionService 同口径）。
   */
  collectSnapshot(): MonitorSnapshot {
    const db = getDb();

    // --- 待办池：未认领（ai_state=''）且未归档未搁置的 todo ---
    const pendingTotal = (db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo' AND archived = 0 AND shelved = 0 AND ai_state = ''",
    ).get() as { n: number }).n;
    const pendingRows = db.prepare(
      `SELECT id, task_no, title, priority FROM tasks
        WHERE status = 'todo' AND archived = 0 AND shelved = 0 AND ai_state = ''
        ORDER BY ${PRIORITY_CASE}, created_at LIMIT ?`,
    ).all(PENDING_LIMIT) as Array<{ id: string; task_no: string | null; title: string; priority: string }>;

    // 待办 → 计划行（plan_tasks.linked_task_id 反指 tasks.id），并收集其依赖的计划 id
    const planByTask = new Map<string, { deps: string | null }>();
    const depIds = new Set<string>();
    const taskIds = pendingRows.map((r) => r.id);
    if (taskIds.length > 0) {
      const plans = db.prepare(
        `SELECT linked_task_id, deps FROM plan_tasks
          WHERE archived = 0 AND linked_task_id IN (${taskIds.map(() => '?').join(',')})`,
      ).all(...taskIds) as Array<{ linked_task_id: string; deps: string | null }>;
      for (const p of plans) {
        planByTask.set(p.linked_task_id, { deps: p.deps });
        for (const d of parsePlanDeps(p.deps)) depIds.add(d.id);
      }
    }
    const depStatus = new Map<string, { title: string; status: string }>();
    const depIdList = [...depIds];
    for (let i = 0; i < depIdList.length; i += 200) {
      const chunk = depIdList.slice(i, i + 200);
      const found = db.prepare(
        `SELECT id, title, status FROM plan_tasks WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk) as Array<{ id: string; title: string; status: string }>;
      for (const f of found) depStatus.set(f.id, { title: f.title, status: f.status });
    }

    // T01284：判定用「存在行的状态」表；只查到的行入表，缺行由 depsSatisfied 视为已完成
    const depStatusById = new Map<string, string>();
    for (const [id, v] of depStatus) depStatusById.set(id, v.status);

    const pending: SnapshotPending[] = pendingRows.map((r) => {
      const planDeps = parsePlanDeps(planByTask.get(r.id)?.deps ?? null);
      const deps: SnapshotDep[] = planDeps.map((d) => {
        const info = depStatus.get(d.id);
        return {
          planTaskId: d.id,
          title: info?.title ?? '',
          type: d.type,
          // 计划行已不存在时按「已完成」处理，与 PlanService.readyTasks 同口径（避免脏引用永久卡住排水）
          done: !info || info.status === 'done',
        };
      });
      // T01284（FR-3.7）：与 TaskService 排水**同一判定**（util/planDeps）——serial 前置须完成，
      // parallel 不阻塞（可并发投给不同平台会话）。此前按「全部完成」判定，把 parallel 误当 serial。
      return {
        taskId: r.id,
        taskNo: r.task_no,
        title: r.title,
        priority: r.priority,
        deps,
        ready: depsSatisfied(planDeps, depStatusById),
      };
    });

    // --- 活跃/停滞会话（带关联任务，供 LLM 定位 RESUME / REDISPATCH 目标） ---
    const sessRows = db.prepare(
      "SELECT platform, status, progress, task_ids FROM exec_sessions WHERE status IN ('active','stalled') ORDER BY last_heartbeat DESC",
    ).all() as Array<{ platform: string; status: string; progress: number; task_ids: string }>;
    const sessTaskIds = new Set<string>();
    for (const s of sessRows) for (const id of parseTaskIds(s.task_ids)) sessTaskIds.add(id);
    const briefById = new Map<string, { taskId: string; taskNo: string | null; title: string }>();
    const sessTaskList = [...sessTaskIds];
    for (let i = 0; i < sessTaskList.length; i += 200) {
      const chunk = sessTaskList.slice(i, i + 200);
      const found = db.prepare(
        `SELECT id, task_no, title FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk) as Array<{ id: string; task_no: string | null; title: string }>;
      for (const f of found) briefById.set(f.id, { taskId: f.id, taskNo: f.task_no, title: f.title });
    }
    const sessions: SnapshotSession[] = sessRows.map((s) => ({
      platform: s.platform,
      status: s.status,
      progress: s.progress,
      stale: s.status === 'stalled',
      tasks: parseTaskIds(s.task_ids)
        .map((id) => briefById.get(id))
        .filter((t): t is { taskId: string; taskNo: string | null; title: string } => !!t),
    }));

    // --- 失败任务（监督器重试口径，FR-4.2） ---
    const failedRows = db.prepare(
      `SELECT id, task_no, title, monitor_retry FROM tasks
        WHERE archived = 0 AND ai_state = 'failed' ORDER BY ai_state_at DESC LIMIT ?`,
    ).all(FAILED_LIMIT) as Array<{ id: string; task_no: string | null; title: string; monitor_retry: number }>;

    const concurrent = (db.prepare(
      "SELECT COUNT(*) AS n FROM exec_sessions WHERE status = 'active'",
    ).get() as { n: number }).n;

    return {
      generatedAt: new Date().toISOString(),
      pending,
      pendingTotal,
      sessions,
      failed: failedRows.map((f) => ({
        taskId: f.id,
        taskNo: f.task_no,
        title: f.title,
        retryCount: f.monitor_retry ?? 0,
      })),
      budget: {
        usedTokens: readIntSetting('supervisor.tokenUsed', 0),
        maxTokens: readIntSetting('supervisor.tokenBudget', 0),
        concurrent,
        maxConcurrent: readIntSetting('supervisor.maxConcurrent', 2),
      },
    };
  },

  /**
   * 监督 tick 入口（FR-2.1）。步骤顺序有意为之：
   * 1) 观测层停滞兜底**先跑且不受熔断影响**（理由见文件头）；
   * 2) 熔断开关关闭 → 决策层空转返回（FR-4.5）；
   * 3) 就绪标记（T01280 / FR-3.1）——须早于空转判定，否则「有就绪待办但无会话」时排水死锁（见下方注释）；
   * 4) 无监督对象 → 空转返回，不进入决策（NFR-1）；
   * 5) 采集快照 → 调决策 LLM 得动作计划（T01275）→ 动作过护栏拍板（T01276；落地执行属 M3）。
   *
   * 因含 LLM 调用而为异步，故用 `ticking` 重入闸避免叠轮。
   */
  async supervisorTick(): Promise<SupervisorTickResult> {
    const stalledMarked = ExecSessionService.expireStaleSessions();
    const probe = this.probe();
    if (!readEnabled()) return { ran: false, reason: 'disabled', stalledMarked, probe };
    // T01280（FR-3.1）：就绪标记必须早于 hasWork 空转判定——积压里全是就绪待办、但无活跃会话/无 running 时，
    // probe.hasWork 为假会直接空转返回，就绪任务永远标不上、拉取接口永远返空（排水死锁）。
    // 位置在 readEnabled 之后，遵守 FR-4.5「开关关闭则监督器完全停摆」。
    const readyMarked = TaskService.markMonitorReady();
    if (!probe.hasWork) return { ran: false, reason: 'idle', stalledMarked, probe, readyMarked };
    if (ticking) return { ran: false, reason: 'busy', stalledMarked, probe, readyMarked };
    ticking = true;
    try {
      const snapshot = this.collectSnapshot();
      const readyCount = snapshot.pending.filter((p) => p.ready).length;
      console.log(
        `[supervisor] 快照：待办 ${snapshot.pending.length}/${snapshot.pendingTotal}（就绪 ${readyCount}）` +
          ` 活跃或停滞会话 ${snapshot.sessions.length} 失败任务 ${snapshot.failed.length}` +
          ` 并发 ${snapshot.budget.concurrent}/${snapshot.budget.maxConcurrent}`,
      );
      const decision = await this.decide(snapshot);
      console.log(
        `[supervisor] 裁决：模型 ${decision.model || '(未配置)'} 动作 ${decision.actions.length} 耗时 ${decision.durationMs}ms` +
          (decision.ok ? '' : ` 失败：${decision.error ?? ''}`),
      );
      // T01278（NFR-3）：决策不可用时改走异常降级——动作由 buildDegradedActions 生成，保证异常人工可见
      const actions = decision.ok ? decision.actions : buildDegradedActions(snapshot, decision.error);
      if (!decision.ok) {
        // console.warn 会被 LogService 环形缓冲捕获，前端日志页可查（降级必须留痕，不能静默）
        console.warn(`[supervisor] 异常降级：决策不可用，产出 ${actions.length} 条 ESCALATE 待人工处理`);
      }
      // T01276：LLM 只「建议」，动作能否落地由护栏拍板；被拦动作降级 ESCALATE
      const guarded = guard(actions, { concurrent: snapshot.budget.concurrent });
      console.log(
        `[supervisor] 护栏：放行 ${guarded.applied.length} 拦截 ${guarded.blocked.length}` +
          (guarded.blockedBy ? `（${guarded.blockedBy}）` : ''),
      );
      // T01282（FR-3.3~3.5）：护栏只放行不执行，落地在这里——被拦动作已在 guard 内降级为 ESCALATE，
      // 故落地对象只取 applied（blocked 的降级动作不改数据，由人工接手）。
      // T01283：applyActions 改为异步（推送兜底需走中继 submit），动作间仍串行、独立容错。
      const executed = await applyActions(guarded.applied);
      const cnt = (s: ApplyOutcome['status']) => executed.filter((e) => e.status === s).length;
      console.log(`[supervisor] 落地：成功 ${cnt('applied')} 跳过 ${cnt('skipped')} 失败 ${cnt('failed')}`);
      // T01285（FR-4.6）：决策轮次写审计（空转/熔断/叠轮不写，理由见 SupervisorAudit 文件头）。
      // 传本轮**实际采用**的动作而非 decision.actions——降级轮次 LLM 无输出，若传空会让审计丢失
      // 「对哪些对象发了 ESCALATE」；降级本身由摘要里的 degraded/decisionError 标记区分。
      recordMonitorRun({
        snapshot,
        actions,
        executed,
        blockedBy: guarded.blockedBy,
        blockedCount: guarded.blocked.length,
        decision,
        readyMarked,
        stalledMarked,
      });
      return { ran: true, reason: 'ok', stalledMarked, probe, snapshot, decision, guard: guarded, degraded: !decision.ok, readyMarked, executed };
    } finally {
      ticking = false;
    }
  },

  /**
   * T01275（FR-2.3）：把快照交给「监控专用」模型裁决，产出结构化动作计划。
   *
   * 复用 AIService.askJson——自带截断/解析失败重试 1 次与 ai_usage 计量（kind='ask-json'）；
   * 调用参数按 PRD §7：max_tokens=2048、temperature=0、超时 10s（NFR-1）。
   * 本方法**只裁决不落地**：动作是否被护栏放行、是否写 monitor_runs，属 T01276 / T01278。
   */
  async decide(snapshot: MonitorSnapshot): Promise<SupervisorDecision> {
    const toolId = resolveDecisionToolId();
    if (!toolId) {
      return { ok: false, model: '', actions: [], retried: false, error: '未配置监督决策模型（supervisor.toolId）', durationMs: 0 };
    }
    const model = (getDb().prepare('SELECT model FROM ai_tools WHERE id = ?').get(toolId) as { model: string | null } | undefined)?.model ?? '';
    const startedAt = Date.now();
    try {
      const res = await AIService.askJson<SupervisorAction[]>(
        toolId,
        MONITOR_SYSTEM_PROMPT,
        JSON.stringify(snapshot),
        parseActions,
        DECISION_TIMEOUT_MS,
        MONITOR_RETRY_PROMPT,
        DECISION_MAX_TOKENS,
        DECISION_TEMPERATURE,
      );
      return {
        ok: res.ok,
        model,
        actions: res.data ?? [],
        retried: Boolean(res.retried),
        error: res.error,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      // 模型未配置 / 工具被删时 runtimeWithModel 抛错——统一按「决策不可用」返回，由 tick 记录降级
      return {
        ok: false,
        model,
        actions: [],
        retried: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};