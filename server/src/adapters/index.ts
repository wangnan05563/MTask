import type { AIAdapter, ToolConfig } from './types';
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
