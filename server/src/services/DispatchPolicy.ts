/**
 * T06257/T06261（十期 · 派发入口与自动触发）：自动派发策略的单源读写与校验。
 *
 * 配置走 app_settings KV（PRD §6.3），不新增表；所有读取都做范围夹取，避免手工写库后
 * 出现「每轮 500 条」「冷却 0ms」这类失控值。写入口只做校验，不触发调度，热重载由路由调用 scheduler.reload()。
 */
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';
import { ConfigService } from './ConfigService';

export type DispatchDefaultChannel = 'auto' | 'b0';
export type DispatchTrigger = 'ready' | 'interval';

export interface DispatchPolicy {
  autoEnabled: boolean;
  defaultChannel: DispatchDefaultChannel;
  b0ToolId: string;
  scopeProjectIds: string[];
  trigger: DispatchTrigger;
  intervalMs: number;
  cooldownMs: number;
  maxPerTick: number;
  maxAttempts: number;
  allowFallbackA: boolean;
  allowAutoD: false;
  retentionDays: number;
  updatedAt: string;
}

export interface DispatchToolLite {
  id: string;
  name: string;
  type: string;
  endpoint?: string;
  enabled?: boolean;
}

const DEFAULTS: DispatchPolicy = {
  autoEnabled: false,
  defaultChannel: 'auto',
  b0ToolId: '',
  scopeProjectIds: [],
  trigger: 'ready',
  intervalMs: 30_000,
  cooldownMs: 300_000,
  maxPerTick: 5,
  maxAttempts: 3,
  allowFallbackA: true,
  allowAutoD: false,
  retentionDays: 30,
  updatedAt: '',
};

const KEYS = {
  autoEnabled: 'dispatch.autoEnabled',
  defaultChannel: 'dispatch.defaultChannel',
  b0ToolId: 'dispatch.b0ToolId',
  scopeProjectIds: 'dispatch.scopeProjectIds',
  trigger: 'dispatch.trigger',
  intervalMs: 'dispatch.intervalMs',
  cooldownMs: 'dispatch.cooldownMs',
  maxPerTick: 'dispatch.maxPerTick',
  maxAttempts: 'dispatch.maxAttempts',
  allowFallbackA: 'dispatch.allowFallbackA',
  allowAutoD: 'dispatch.allowAutoD',
  retentionDays: 'dispatch.retentionDays',
  updatedAt: 'dispatch.updatedAt',
} as const;

function readBool(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function readInt(key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(key);
  // 注意：Number(null) === 0，必须先把「未配置」判掉，否则默认值会被 min 夹成最小值
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readScope(): string[] {
  const raw = getSetting(KEYS.scopeProjectIds);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  } catch {
    return [];
  }
}

export function readPolicy(): DispatchPolicy {
  const channel = getSetting(KEYS.defaultChannel) === 'b0' ? 'b0' : 'auto';
  const trigger = getSetting(KEYS.trigger) === 'interval' ? 'interval' : 'ready';
  return {
    autoEnabled: readBool(KEYS.autoEnabled, DEFAULTS.autoEnabled),
    defaultChannel: channel,
    b0ToolId: (getSetting(KEYS.b0ToolId) ?? '').trim(),
    scopeProjectIds: readScope(),
    trigger,
    intervalMs: readInt(KEYS.intervalMs, DEFAULTS.intervalMs, 5_000, 3_600_000),
    cooldownMs: readInt(KEYS.cooldownMs, DEFAULTS.cooldownMs, 60_000, 86_400_000),
    maxPerTick: readInt(KEYS.maxPerTick, DEFAULTS.maxPerTick, 1, 20),
    maxAttempts: readInt(KEYS.maxAttempts, DEFAULTS.maxAttempts, 1, 10),
    // PRD 硬边界：自动链路绝不执行人工确认，读侧也强制为 false
    allowFallbackA: readBool(KEYS.allowFallbackA, DEFAULTS.allowFallbackA),
    allowAutoD: false,
    retentionDays: readInt(KEYS.retentionDays, DEFAULTS.retentionDays, 1, 365),
    updatedAt: getSetting(KEYS.updatedAt) ?? '',
  };
}

export function listGatewayTools(): DispatchToolLite[] {
  return (ConfigService.list() as unknown as DispatchToolLite[])
    .filter((tool) => tool.type === 'codebuddy-gateway' && tool.enabled !== false);
}

/** 与 PushDispatcher 共用同一口径：显式配置优先，否则取第一条 enabled 的 CodeBuddy 网关工具。 */
export function resolveGatewayTool(policy = readPolicy()): { tool: DispatchToolLite | null; reason?: string } {
  const candidates = listGatewayTools();
  const pick = (tool: DispatchToolLite | undefined): { tool: DispatchToolLite | null; reason?: string } => {
    if (!tool) return { tool: null };
    try {
      assertEndpointAllowed(tool.endpoint ?? '');
      return { tool };
    } catch (e) {
      return { tool: null, reason: `工具 ${tool.name || tool.id} endpoint 不符合安全要求：${e instanceof Error ? e.message : String(e)}` };
    }
  };
  if (policy.b0ToolId) {
    const hit = candidates.find((tool) => tool.id === policy.b0ToolId);
    if (!hit) return { tool: null, reason: `已配置的 CodeBuddy 网关工具未找到（dispatch.b0ToolId=${policy.b0ToolId}），请检查工具是否启用` };
    return pick(hit);
  }
  if (!candidates.length) return { tool: null, reason: '未配置 codebuddy-gateway 类型的 AI 工具' };
  return pick(candidates[0]);
}

/** endpoint 脱敏：只保留 origin + path，丢弃 query/hash/userinfo（口令可能藏在 query）。 */
export function sanitizeEndpoint(endpoint: string | undefined): string {
  const raw = (endpoint ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    // 非法 URL 也要做兜底脱敏：不能把 user:pass@ 或 query 里的 token 原样吐给前端
    return raw.replace(/\/\/[^/\s]+@/i, '//[REDACTED]@').replace(/[?#].*$/, '');
  }
}

/**
 * CodeBuddy 网关 endpoint 安全边界（FR-5）：
 * - 回环/本机允许 http；
 * - 远程必须 https；
 * - 带 userinfo 的 URL 一律拒绝（口令不能进 URL）。
 */
export function assertEndpointAllowed(endpoint: string): void {
  const raw = (endpoint ?? '').trim();
  if (!raw) throw new Error('CodeBuddy 网关地址为空');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CodeBuddy 网关地址不是合法 URL');
  }
  if (url.username || url.password) throw new Error('CodeBuddy 网关地址不能包含用户名/口令');
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (!loopback && url.protocol !== 'https:') {
    throw new Error('CodeBuddy 网关远程地址必须使用 HTTPS（仅 localhost/127.0.0.1 允许 HTTP）');
  }
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0' || value === 'false') return false;
  if (value === 1 || value === '1' || value === 'true') return true;
  return fallback;
}

function validateScope(ids: unknown): string[] {
  if (ids === undefined) return readScope();
  if (!Array.isArray(ids)) throw new Error('scopeProjectIds 必须是数组');
  const unique = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT id FROM projects WHERE archived = 0 AND id IN (${placeholders})`,
  ).all(...unique) as Array<{ id: string }>;
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = unique.filter((id) => !found.has(id));
    throw new Error(`scopeProjectIds 含不存在或已归档项目：${missing.join(', ')}`);
  }
  return unique;
}

function validateGatewayTool(toolId: string): string {
  const trimmed = (toolId ?? '').trim();
  if (!trimmed) return '';
  const row = getDb().prepare('SELECT type, enabled, endpoint FROM ai_tools WHERE id = ? AND COALESCE(archived, 0) = 0').get(trimmed) as
    | { type: string; enabled: number; endpoint: string }
    | undefined;
  if (!row) throw new Error(`CodeBuddy 网关工具不存在：${trimmed}`);
  if (row.type !== 'codebuddy-gateway') throw new Error(`所选工具不是 CodeBuddy 网关（type=${row.type}）`);
  if (!row.enabled) throw new Error('CodeBuddy 网关工具未启用');
  assertEndpointAllowed(row.endpoint);
  return trimmed;
}

export class DispatchConfigConflictError extends Error {
  readonly code = 'CONFIG_CONFLICT';
  constructor(message = '配置已被其他窗口修改，请刷新后重试') {
    super(message);
    this.name = 'DispatchConfigConflictError';
  }
}

/**
 * 保存策略：只接受已知字段，未知字段忽略；校验失败一次性抛出，由路由转 400。
 * 数值范围与 PRD §8.2.2 对齐。allowAutoD=true 直接拒绝，不静默改写。
 * expectedUpdatedAt 用于乐观并发：旧版本保存必须拒绝，避免双窗口互相覆盖。
 */
export function savePolicy(input: Record<string, unknown>, expectedUpdatedAt?: string): DispatchPolicy {
  const current = readPolicy();
  const expected = (expectedUpdatedAt ?? '').trim();
  if (expected && expected !== current.updatedAt) {
    throw new DispatchConfigConflictError();
  }
  if (input.allowAutoD === true || input.allowAutoD === 1 || input.allowAutoD === '1') {
    throw new Error('allowAutoD 必须为 false：人工确认通道仅允许手动触发');
  }
  const defaultChannel = input.defaultChannel === 'b0' ? 'b0' : input.defaultChannel === 'auto' ? 'auto' : current.defaultChannel;
  if (input.defaultChannel !== undefined && input.defaultChannel !== 'auto' && input.defaultChannel !== 'b0') {
    throw new Error(`默认通道仅允许「自动 / CodeBuddy 网关」之一（机器值 auto / b0），收到：${String(input.defaultChannel)}`);
  }
  const trigger = input.trigger === 'interval' ? 'interval' : input.trigger === 'ready' ? 'ready' : current.trigger;
  if (input.trigger !== undefined && input.trigger !== 'ready' && input.trigger !== 'interval') {
    throw new Error('trigger 仅允许 ready / interval');
  }
  const b0ToolId = input.b0ToolId === undefined ? current.b0ToolId : validateGatewayTool(String(input.b0ToolId ?? ''));
  const scopeProjectIds = validateScope(input.scopeProjectIds);

  const intField = (name: keyof DispatchPolicy, key: string, min: number, max: number): number => {
    if (input[name] === undefined) return current[name] as number;
    const n = Number(input[name]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 取值 ${min}~${max}`);
    return Math.round(n);
  };
  // 同一毫秒内连续保存时也要推进版本号，否则乐观并发会把两次保存误判成同一版本
  let nextUpdatedAt = new Date().toISOString();
  if (nextUpdatedAt === current.updatedAt) {
    const previousMs = Date.parse(current.updatedAt);
    nextUpdatedAt = Number.isFinite(previousMs) ? new Date(previousMs + 1).toISOString() : nextUpdatedAt;
  }
  const next: DispatchPolicy = {
    autoEnabled: input.autoEnabled === undefined ? current.autoEnabled : normalizeBool(input.autoEnabled, current.autoEnabled),
    defaultChannel,
    b0ToolId,
    scopeProjectIds,
    trigger,
    intervalMs: intField('intervalMs', KEYS.intervalMs, 5_000, 3_600_000),
    cooldownMs: intField('cooldownMs', KEYS.cooldownMs, 60_000, 86_400_000),
    maxPerTick: intField('maxPerTick', KEYS.maxPerTick, 1, 20),
    maxAttempts: intField('maxAttempts', KEYS.maxAttempts, 1, 10),
    allowFallbackA: input.allowFallbackA === undefined ? current.allowFallbackA : normalizeBool(input.allowFallbackA, current.allowFallbackA),
    allowAutoD: false,
    retentionDays: intField('retentionDays', KEYS.retentionDays, 1, 365),
    updatedAt: nextUpdatedAt,
  };

  const db = getDb();
  const tx = db.transaction(() => {
    setSetting(KEYS.autoEnabled, next.autoEnabled ? '1' : '0');
    setSetting(KEYS.defaultChannel, next.defaultChannel);
    setSetting(KEYS.b0ToolId, next.b0ToolId);
    setSetting(KEYS.scopeProjectIds, JSON.stringify(next.scopeProjectIds));
    setSetting(KEYS.trigger, next.trigger);
    setSetting(KEYS.intervalMs, String(next.intervalMs));
    setSetting(KEYS.cooldownMs, String(next.cooldownMs));
    setSetting(KEYS.maxPerTick, String(next.maxPerTick));
    setSetting(KEYS.maxAttempts, String(next.maxAttempts));
    setSetting(KEYS.allowFallbackA, next.allowFallbackA ? '1' : '0');
    setSetting(KEYS.allowAutoD, '0');
    setSetting(KEYS.retentionDays, String(next.retentionDays));
    setSetting(KEYS.updatedAt, next.updatedAt);
  });
  tx();
  return next;
}

export interface DispatchConfigView extends DispatchPolicy {
  b0: {
    configured: boolean;
    toolId: string | null;
    toolName: string | null;
    endpoint: string;
    reason: string | null;
  };
  runnable: boolean;
  blockedReason: string;
}

export function readConfigView(): DispatchConfigView {
  const policy = readPolicy();
  const resolved = resolveGatewayTool(policy);
  const blocked = !policy.autoEnabled
    ? '自动派发已暂停'
    : !policy.scopeProjectIds.length
      ? '未选择项目范围（空数组=不启用）'
      : !resolved.tool
        ? `CodeBuddy 网关配置不完整：${resolved.reason ?? '未配置工具'}`
        : '';
  return {
    ...policy,
    b0: {
      configured: Boolean(resolved.tool),
      toolId: resolved.tool?.id ?? null,
      toolName: resolved.tool?.name ?? null,
      endpoint: sanitizeEndpoint(resolved.tool?.endpoint),
      reason: resolved.reason ?? null,
    },
    runnable: !blocked,
    blockedReason: blocked,
  };
}

/** 就绪标记与决策层解耦（T05741）；默认开启，关闭时自动候选恒空。 */
export function isReadyMarkEnabled(): boolean {
  return readBool('supervisor.readyMarkEnabled', true);
}
