/**
 * T01273（PRD FR-2.1）：常驻监督器骨架——「AI 编排大脑」决策层的驱动入口。
 *
 * 复用 RecurringService 的 tick 驱动方式：由 server 周期调用 supervisorTick()，单例幂等——
 * 无监督对象时空转返回，只走索引探测，不调 LLM、不开写事务，满足 NFR-1「空转单轮 < 50ms」。
 *
 * 职责边界（本任务只搭骨架）：
 * - 观测层停滞兜底并入本 tick（M1 已上线的 ExecSessionService.expireStaleSessions）；
 * - 快照采集 → T01274；LLM 裁决 → T01275；护栏约束 → T01276。
 *
 * 熔断语义（FR-4.5）：`supervisor.enabled=0`（默认）时**决策层**完全停摆，任务保持现状；
 * 但观测层兜底不受开关影响——停滞标记是零风险的只读观测信号，一并停掉会让面板停在「假存活」。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { ExecSessionService } from './ExecSessionService';

/** 监督 tick 默认周期 30s（FR-2.1） */
const DEFAULT_INTERVAL_MS = 30_000;
/** 熔断开关（FR-4.5）：默认关闭，自动动作需用户显式开启 */
const ENABLED_KEY = 'supervisor.enabled';
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
  /** 本轮是否进入决策流程（false = 空转 / 熔断） */
  ran: boolean;
  reason: 'ok' | 'disabled' | 'idle';
  /** 本轮新标记为 stalled 的会话数（观测层兜底产物） */
  stalledMarked: number;
  probe: SupervisorProbe;
}

/** 配置解析：缺失/非法一律回退默认，避免 0 或 NaN 让定时器退化成忙轮询 */
function readEnabled(): boolean {
  const raw = getSetting(ENABLED_KEY);
  return raw === '1' || raw === 'true';
}

function readIntervalMs(): number {
  const n = Number(getSetting(INTERVAL_KEY));
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
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
   * 监督 tick 入口（FR-2.1）。步骤顺序有意为之：
   * 1) 观测层停滞兜底**先跑且不受熔断影响**（理由见文件头）；
   * 2) 熔断开关关闭 → 决策层空转返回（FR-4.5）；
   * 3) 无监督对象 → 空转返回，不进入决策（NFR-1）。
   */
  supervisorTick(): SupervisorTickResult {
    const stalledMarked = ExecSessionService.expireStaleSessions();
    const probe = this.probe();
    if (!readEnabled()) return { ran: false, reason: 'disabled', stalledMarked, probe };
    if (!probe.hasWork) return { ran: false, reason: 'idle', stalledMarked, probe };
    // T01274~T01276 将在此接入「快照采集 → LLM 裁决 → 护栏拍板」；骨架阶段仅确认进入决策态。
    console.log(
      `[supervisor] 进入决策流程：活跃会话=${probe.hasActiveSession} 停滞会话=${probe.hasStalledSession} running任务=${probe.hasRunningTask}`,
    );
    return { ran: true, reason: 'ok', stalledMarked, probe };
  },
};