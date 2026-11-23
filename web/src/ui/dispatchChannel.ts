/**
 * T06325：派发通道的前端唯一命名表。
 *
 * 机器值 B0/A/D 来自接口与历史审计，不能改；所有页面必须经本文件转成
 * 「CodeBuddy 网关 / MCP 就绪池 / 人工确认」后再上屏，禁止直接渲染 channel 原值。
 */
export type DispatchChannelCode = 'B0' | 'A' | 'D';

export interface DispatchChannelMeta {
  readonly code: DispatchChannelCode;
  /** 中文主标签（UI 首选） */
  readonly name: string;
  /** 中文短标签（pill/窄列） */
  readonly shortName: string;
  /** 规范英文短名（接口文档/日志） */
  readonly englishName: string;
  /** 一句话说明 */
  readonly description: string;
  /** 该通道在界面中的语义色 token */
  readonly tone: string;
}

export const DISPATCH_CHANNELS: Record<DispatchChannelCode, DispatchChannelMeta> = {
  B0: {
    code: 'B0',
    name: 'CodeBuddy 网关',
    shortName: '网关',
    englishName: 'Gateway',
    description: '主动推送到 CodeBuddy 本地 run 网关',
    tone: 'var(--accent)',
  },
  A: {
    code: 'A',
    name: 'MCP 就绪池',
    shortName: '就绪池',
    englishName: 'ReadyPool',
    description: '把任务放回就绪池，等外部 Agent 自己来领',
    tone: 'var(--warn)',
  },
  D: {
    code: 'D',
    name: '人工确认',
    shortName: '人工',
    englishName: 'Manual',
    description: '只标记待人工处理，不自动打开 GUI',
    tone: 'var(--danger)',
  },
};

const CHANNEL_KEYS: readonly DispatchChannelCode[] = ['B0', 'A', 'D'];

/**
 * 界面顶部的一行口径说明；所有页面共用，避免各页各写一套。
 * 只出现可读名称，机器代号 B0/A/D 不作为界面文案。
 */
export const DISPATCH_CHANNEL_LEGEND = 'CodeBuddy 网关 = 主动推送；MCP 就绪池 = 等待外部 Agent 拉取；人工确认 = 仅手动标记，不自动打开 GUI';

export function isDispatchChannelCode(value: string | null | undefined): value is DispatchChannelCode {
  return CHANNEL_KEYS.includes(String(value ?? '').trim().toUpperCase() as DispatchChannelCode);
}

/** 未知/空值回退为「未知通道」，避免旧数据或历史异常记录把页面打崩。 */
export function dispatchChannelName(code: string | null | undefined, fallback = '未知通道'): string {
  return isDispatchChannelCode(code) ? DISPATCH_CHANNELS[code.trim().toUpperCase() as DispatchChannelCode].name : fallback;
}

export function dispatchChannelShortName(code: string | null | undefined, fallback = '未知'): string {
  return isDispatchChannelCode(code) ? DISPATCH_CHANNELS[code.trim().toUpperCase() as DispatchChannelCode].shortName : fallback;
}

export function dispatchChannelTone(code: string | null | undefined, fallback = 'var(--text)'): string {
  return isDispatchChannelCode(code) ? DISPATCH_CHANNELS[code.trim().toUpperCase() as DispatchChannelCode].tone : fallback;
}

/**
 * 历史审计 detail 里可能残留 B0/A/D 代号；展示前做最小范围替换。
 * 只替换明确的通道短语，不对单个 A/D 做全局替换（避免误伤普通英文/型号）。
 */
export function humanizeDispatchText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/auto\/b0\/a\/d/gi, '自动 / CodeBuddy 网关 / MCP 就绪池 / 人工确认')
    .replace(/B0\s*→\s*A\s*→\s*D/g, 'CodeBuddy 网关 → MCP 就绪池 → 人工确认')
    .replace(/B0\s*→\s*A/g, 'CodeBuddy 网关 → MCP 就绪池')
    .replace(/A\s*→\s*D/g, 'MCP 就绪池 → 人工确认')
    .replace(/B0\/A\/D/g, 'CodeBuddy 网关/MCP 就绪池/人工确认')
    .replace(/B0\/A 均不可用/g, 'CodeBuddy 网关与 MCP 就绪池均不可用')
    .replace(/B0\/A/g, 'CodeBuddy 网关/MCP 就绪池')
    .replace(/A\/D 均不可用/g, 'MCP 就绪池与人工确认均不可用')
    .replace(/\bB0 未配置\b/g, 'CodeBuddy 网关未配置')
    .replace(/\bB0 工具\b/g, 'CodeBuddy 网关工具')
    .replace(/\bB0 派发\b/g, 'CodeBuddy 网关派发')
    .replace(/\bB0 失败\b/g, 'CodeBuddy 网关失败')
    .replace(/\bB0\b/g, 'CodeBuddy 网关')
    .replace(/\bA 就绪池\b/g, 'MCP 就绪池')
    .replace(/\bA 兜底\b/g, 'MCP 就绪池兜底')
    .replace(/\bA 均不可用\b/g, 'MCP 就绪池均不可用')
    .replace(/\bA 未配置\b/g, 'MCP 就绪池未配置')
    .replace(/\bD 通道\b/g, '人工确认通道')
    .replace(/\bD 应急\b/g, '人工确认')
    .replace(/\bD 人工\b/g, '人工确认')
    .replace(/\bD 派发\b/g, '人工确认派发')
    .replace(/\bD 不自动执行\b/g, '人工确认不自动执行');
}

const ERROR_CODE_LABEL: Record<string, string> = {
  TASK_ARCHIVED: '任务已归档',
  TASK_NOT_TODO: '任务不在待办状态',
  TASK_RUNNING: '任务正在执行',
  TASK_NOT_FOUND: '任务不存在',
  B0_NOT_CONFIGURED: 'CodeBuddy 网关未配置',
  B0_AUTH_FAILED: 'CodeBuddy 网关鉴权失败',
  B0_TIMEOUT: 'CodeBuddy 网关响应超时',
  B0_STREAM_LOST: 'CodeBuddy 网关结果流中断',
  B0_UNREACHABLE: 'CodeBuddy 网关不可达',
  A_NOT_READY: 'MCP 就绪池归位失败',
  D_MANUAL_ONLY: '需人工确认',
  DISPATCH_DUPLICATE: '重复派发已拦截',
};

/** 稳定错误码仍保留给机器/排障；界面只显示可读中文，原码放在 tooltip。 */
export function dispatchErrorCodeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return ERROR_CODE_LABEL[code] ?? '派发失败';
}
