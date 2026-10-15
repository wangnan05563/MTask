import type { AIAdapter, ToolConfig } from './types';

export type { AIAdapter, ToolConfig } from './types';
import { OpenAICompatAdapter } from './openaiCompat';
import { ClaudeAdapter } from './claude';
import { OllamaAdapter } from './ollama';
import { WorkBuddyAdapter } from './workbuddy';

const registry: Record<string, AIAdapter> = {
  'openai-compatible': new OpenAICompatAdapter(),
  claude: new ClaudeAdapter(),
  ollama: new OllamaAdapter(),
  workbuddy: new WorkBuddyAdapter(),
};

export function getAdapter(type: string): AIAdapter {
  const adapter = registry[type];
  if (!adapter) throw new Error(`未注册的 AI 工具类型: ${type}`);
  return adapter;
}

export function listAdapterTypes(): string[] {
  return Object.keys(registry);
}

/** 供 ConfigService 连接测试使用 */
export async function testAdapter(type: string, config: ToolConfig) {
  return getAdapter(type).testConnection(config);
}

/** 供 ConfigService 获取可用模型列表使用（不支持的适配器返回 ok:false） */
export async function listAdapterModels(type: string, config: ToolConfig) {
  return getAdapter(type).listModels(config);
}

/**
 * T02208：最小实调探测的固定指令与预算。
 * maxTokens 给到 64 而非 16：过小会让「模型回了两句客套话」被判成触顶截断（适配器把
 * finish_reason=length 一律记失败），探测结果反而失真——64 token 的成本仍属可忽略量级。
 */
const PROBE_SYSTEM = '你是连通性探测器。无论收到什么输入，都只回复两个字母：OK';
const PROBE_USER = 'ping';
const PROBE_MAX_TOKENS = 64;
const PROBE_TIMEOUT_MS = 30_000;

/** 供最小实调探测使用（调用方 ConfigService.probe）：走真实调用通道（chat），只允许用户显式触发 */
export async function probeAdapter(type: string, config: ToolConfig) {
  return getAdapter(type).chat(PROBE_SYSTEM, PROBE_USER, {
    ...config,
    temperature: 0,
    maxTokens: PROBE_MAX_TOKENS,
    timeoutMs: Math.min(config.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
  });
}
