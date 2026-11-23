/**
 * T06325：派发通道的唯一命名表。
 *
 * 机器值（B0 / A / D）仍是 dispatch_attempts、REST 响应与历史数据的稳定契约，
 * 不随展示名变化；面向用户的文案、日志与代码标识统一使用本文件的中文主名/英文短名。
 *
 * 语义（来自九期 PRD §6.1）：
 * - B0 = CodeBuddy 网关（主动推送，Gateway）
 * - A  = MCP 就绪池（等外部 Agent 拉取，ReadyPool）
 * - D  = 人工确认（只标记待人工处理，不自动开 GUI，Manual）
 */
export const DISPATCH_CHANNEL_CODE = {
  GATEWAY: 'B0',
  READY_POOL: 'A',
  MANUAL: 'D',
} as const;

export type DispatchChannelCode = (typeof DISPATCH_CHANNEL_CODE)[keyof typeof DISPATCH_CHANNEL_CODE];

/** 落库/审计用的平台标识；与展示名解耦，改名不得影响历史数据。 */
export const DISPATCH_PLATFORM = {
  GATEWAY: 'codebuddy-gateway',
  READY_POOL: 'mcp',
  MANUAL: 'd-gui',
} as const;

export interface DispatchChannelMeta {
  readonly code: DispatchChannelCode;
  /** 中文主标签（UI 首选，不得直接暴露代号） */
  readonly name: string;
  /** 中文短标签（空间受限的 pill/表格用） */
  readonly shortName: string;
  /** 规范英文短名（日志、接口文档与跨语言调用用） */
  readonly englishName: string;
  /** 一句话解释“这个通道做什么” */
  readonly description: string;
}

export const DISPATCH_CHANNELS: Record<DispatchChannelCode, DispatchChannelMeta> = {
  B0: {
    code: 'B0',
    name: 'CodeBuddy 网关',
    shortName: '网关',
    englishName: 'Gateway',
    description: '主动推送到 CodeBuddy 本地 run 网关',
  },
  A: {
    code: 'A',
    name: 'MCP 就绪池',
    shortName: '就绪池',
    englishName: 'ReadyPool',
    description: '把任务放回就绪池，等外部 Agent 自己来领',
  },
  D: {
    code: 'D',
    name: '人工确认',
    shortName: '人工',
    englishName: 'Manual',
    description: '只标记待人工处理，不自动打开 GUI',
  },
};

/** UI/日志统一入口：未知值不抛错，回退为可读文案，避免旧数据把页面打崩。 */
export function dispatchChannelLabel(code: string | null | undefined): string {
  const key = String(code ?? '').trim().toUpperCase() as DispatchChannelCode;
  return DISPATCH_CHANNELS[key]?.name ?? '未知通道';
}

export function dispatchChannelShortLabel(code: string | null | undefined): string {
  const key = String(code ?? '').trim().toUpperCase() as DispatchChannelCode;
  return DISPATCH_CHANNELS[key]?.shortName ?? '未知';
}
