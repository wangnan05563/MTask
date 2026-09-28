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
 * 写接口只开放**用户可决策**的三项：熔断开关（FR-5.4，PRD 要求显式开关）、
 * 中继兜底通道（T01283 的两个配置键，此前无 UI 入口）。
 * `intervalMs` 有意不开放：定时器在 server 启动时按周期注册，改了不重启只会「显示已改、实际没变」，
 * 属于误导性开关，不如不做（真要改周期需重启，属运维动作）。
 */
import { Router } from 'express';
import { getDb } from '../db/connection';
import { getSetting, setSetting } from '../services/AppSettings';
import { logService } from '../services/LogService';
import { SupervisorService } from '../services/SupervisorService';
import { listMonitorRuns } from '../services/SupervisorAudit';

/** 熔断开关配置键（与 SupervisorGuard / SupervisorService 同口径） */
const ENABLED_KEY = 'supervisor.enabled';
/** 中继兜底通道配置键（与 RelayDispatchService 同口径） */
const RELAY_PLATFORMS_KEY = 'supervisor.relayPlatforms';
const RELAY_TOOL_KEY = 'supervisor.relayToolId';

export const supervisorApi = Router();

/** 配置读出口：只回面板可编辑的三项（节奏/限值/预算由 /status 统一给出，避免双数据源） */
function readConfig() {
  return {
    enabled: SupervisorService.getConfig().enabled,
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

/**
 * 配置写入（FR-5.4 熔断开关 + T01283 中继通道）。
 * 未提供的字段保持原值——面板按需提交单项，不必回传整份配置。
 */
supervisorApi.post('/config', (req, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown; relayPlatforms?: unknown; relayToolId?: unknown };
  try {
    let changed = false;
    if (typeof body.enabled === 'boolean') {
      setSetting(ENABLED_KEY, body.enabled ? '1' : '0');
      // 熔断开关是「自动执行是否被允许」的总闸，写行为必须留痕（日志页可查谁在何时开/关）
      logService.log('WARN', 'supervisor', `熔断开关${body.enabled ? '已开启（自动动作生效）' : '已关闭（自动动作停摆，人工接管）'}`);
      changed = true;
    }
    if (typeof body.relayPlatforms === 'string') {
      setSetting(RELAY_PLATFORMS_KEY, body.relayPlatforms.trim());
      changed = true;
    }
    if (typeof body.relayToolId === 'string') {
      const id = body.relayToolId.trim();
      // 中继工具 id 写错会导致派发静默 skipped，故写入前校验存在性（空串=清除配置，允许）
      if (id && !getDb().prepare('SELECT 1 FROM ai_tools WHERE id = ?').get(id)) {
        return res.status(400).json({ error: '中继工具不存在，请先在「模型」页创建' });
      }
      setSetting(RELAY_TOOL_KEY, id);
      changed = true;
    }
    if (!changed) return res.status(400).json({ error: '无可写字段（支持 enabled / relayPlatforms / relayToolId）' });
    res.json(readConfig());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
