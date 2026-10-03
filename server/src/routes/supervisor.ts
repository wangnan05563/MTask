/**
 * T01286（PRD FR-5.2~5.4）：监督器状态/审计/配置的后端出口。
 *
 * 单独成路由而不塞进 routes/index.ts：监督能力的读出口（状态、审计）与写出口（熔断、中继配置）
 * 都应只有一处口径，挂载点 `api.use('/supervisor', supervisorApi)` 只是一行接线。
 *
 * 三条读接口对应三个前端诉求：
 * - `GET /status`：状态看板（FR-5.2）——熔断开关、tick 节奏、预算占用、最近决策、活跃会话；
 * - `GET /runs`：审计视图（FR-5.3）——`monitor_runs` 列表，逐条回溯「AI 为什么这么做」；
 * - `GET /config`：配置回填（FR-5.4）——面板打开时把当前值读出来，避免「显示了默认值其实库里另存」。
 *
 * 写接口开放**用户可决策**的四项：熔断开关（FR-5.4，PRD 要求显式开关）、
 * 中继兜底通道（T01283 的两个配置键，此前无 UI 入口）、tick 周期与审计保留天数（T01311）。
 * `intervalMs` 直到 T01311 才开放：此前定时器无句柄可 clear，改了不重启只会「显示已改、实际没变」，
 * 属误导性开关；现 `SupervisorService.setIntervalMs` 写库后即刻重注册定时器，写入即生效。
 */
import { Router } from 'express';
import { getDb } from '../db/connection';
import { getSetting, setSetting } from '../services/AppSettings';
import { logService } from '../services/LogService';
import { SupervisorService } from '../services/SupervisorService';
import { listMonitorRuns, setRetentionDays } from '../services/SupervisorAudit';

/** 熔断开关配置键（与 SupervisorGuard / SupervisorService 同口径） */
const ENABLED_KEY = 'supervisor.enabled';
/** 中继兜底通道配置键（与 RelayDispatchService 同口径） */
const RELAY_PLATFORMS_KEY = 'supervisor.relayPlatforms';
const RELAY_TOOL_KEY = 'supervisor.relayToolId';

export const supervisorApi = Router();

/** 配置读出口：只回面板可编辑的项（限值/预算由 /status 统一给出，避免双数据源） */
function readConfig() {
  const cfg = SupervisorService.getConfig();
  return {
    enabled: cfg.enabled,
    intervalMs: cfg.intervalMs,
    auditRetentionDays: cfg.auditRetentionDays,
    relayPlatforms: getSetting(RELAY_PLATFORMS_KEY) ?? '',
    relayToolId: getSetting(RELAY_TOOL_KEY) ?? '',
  };
}

// FR-5.2：状态看板数据源
supervisorApi.get('/status', (_req, res) => {
  try {
    res.json(SupervisorService.getStatus());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// FR-5.3：审计列表（默认 30 条，上限 200，收口在 listMonitorRuns 内）
supervisorApi.get('/runs', (req, res) => {
  try {
    const limit = Number(req.query.limit);
    const runs = listMonitorRuns(Number.isFinite(limit) ? limit : undefined);
    res.json({ runs, total: runs.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

supervisorApi.get('/config', (_req, res) => res.json(readConfig()));

/** POST /config 的请求体结构（全部可选：未提供的字段保持原值） */
interface SupervisorConfigPatch {
  enabled?: unknown;
  relayPlatforms?: unknown;
  relayToolId?: unknown;
  intervalMs?: unknown;
  auditRetentionDays?: unknown;
}

/** 单字段写入器：返回 true 表示本字段已落库；非法值抛错，交由路由统一转 400 */
type ConfigWriter = (b: SupervisorConfigPatch) => boolean;

/** 熔断开关：自动执行的总闸，写行为必须留痕（日志页可查谁在何时开/关） */
const writeEnabled: ConfigWriter = (b) => {
  if (typeof b.enabled !== 'boolean') return false;
  setSetting(ENABLED_KEY, b.enabled ? '1' : '0');
  logService.log('WARN', 'supervisor', `熔断开关${b.enabled ? '已开启（自动动作生效）' : '已关闭（自动动作停摆，人工接管）'}`);
  return true;
};

/** tick 周期：越界由 setIntervalMs 抛错；合法值写库后即刻重注册定时器（热重载，无需重启） */
const writeIntervalMs: ConfigWriter = (b) => {
  if (typeof b.intervalMs !== 'number') return false;
  const ms = SupervisorService.setIntervalMs(b.intervalMs);
  logService.log('WARN', 'supervisor', `tick 周期已改为 ${ms}ms（热重载生效，无需重启）`);
  return true;
};

/** 审计保留天数：决定审计证据的存续时长，属「会静默删数据」的配置，必须留痕 */
const writeRetentionDays: ConfigWriter = (b) => {
  if (typeof b.auditRetentionDays !== 'number') return false;
  const days = setRetentionDays(b.auditRetentionDays);
  logService.log('WARN', 'supervisor', `审计保留天数已改为 ${days} 天（${days <= 0 ? '不清理，保留全部' : '过期自动清理'}）`);
  return true;
};

const writeRelayPlatforms: ConfigWriter = (b) => {
  if (typeof b.relayPlatforms !== 'string') return false;
  setSetting(RELAY_PLATFORMS_KEY, b.relayPlatforms.trim());
  return true;
};

/** 中继工具 id：写错会导致派发静默 skipped，故写入前校验存在性（空串=清除配置，允许） */
const writeRelayToolId: ConfigWriter = (b) => {
  if (typeof b.relayToolId !== 'string') return false;
  const id = b.relayToolId.trim();
  if (id && !getDb().prepare('SELECT 1 FROM ai_tools WHERE id = ?').get(id)) {
    throw new Error('中继工具不存在，请先在「模型」页创建');
  }
  setSetting(RELAY_TOOL_KEY, id);
  return true;
};

/** 按序执行全部写入器，返回是否有字段实际落库 */
function writeSupervisorConfig(b: SupervisorConfigPatch): boolean {
  let changed = false;
  for (const write of [writeEnabled, writeIntervalMs, writeRetentionDays, writeRelayPlatforms, writeRelayToolId]) {
    if (write(b)) changed = true;
  }
  return changed;
}

/**
 * 配置写入（FR-5.4 熔断开关 + T01283 中继通道 + T01311 运行参数）。
 * 未提供的字段保持原值——面板按需提交单项，不必回传整份配置。
 */
supervisorApi.post('/config', (req, res) => {
  const body = (req.body ?? {}) as SupervisorConfigPatch;
  try {
    if (!writeSupervisorConfig(body)) {
      return res.status(400).json({ error: '无可写字段（支持 enabled / intervalMs / auditRetentionDays / relayPlatforms / relayToolId）' });
    }
    res.json(readConfig());
  } catch (e) {
    // 越界/不存在等校验失败统一 400：这类错误由写入器抛 Error 携带人话文案
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
