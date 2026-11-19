/**
 * T06088：模型上下文容量三挡口径。
 *
 * 只在前端把「官方上下文上限」折算成低/中/高三挡，并把用户选择的档位记录在既有
 * `model_notes` 文本中（不新增后端字段，不改数据库结构）。各 AI 功能实际使用的
 * 上下文预算仍由各自模块控制，本字段只用于选择与展示模型容量。
 *
 * 官方来源：
 * - Agnes 2.5 Flash：512K 上下文
 *   https://wiki.agnes-ai.com/zh-Hans/docs/agnes-25-flash
 * - 智谱 GLM-4.5：128K 上下文
 *   https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5
 * - Qwen3.5-4B：256K 上下文
 *   https://registry.ollama.ai/library/qwen3.5
 * - DeepSeek deepseek-flash：1M 上下文；deepseek-chat/reasoner：128K
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * - Groq Llama 3.3 70B：128K 上下文
 *   https://groq.com/pricing
 * - OpenAI GPT-4o mini：128K 上下文
 *   https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/
 */
import type { AITool } from '../api/client';

export interface ModelContextTier {
  readonly label: string;
  readonly tokens: number;
}

export interface ModelContextProfile {
  readonly maxTokens: number;
  readonly officialLabel: string;
  readonly source: string;
  readonly tiers: readonly ModelContextTier[];
}

type ToolLike = Pick<AITool, 'name' | 'model' | 'endpoint' | 'model_notes'>;

interface ProfileRule {
  readonly pattern: RegExp;
  readonly maxTokens: number;
  readonly officialLabel: string;
  readonly source: string;
}

const PROFILE_RULES: readonly ProfileRule[] = [
  {
    pattern: /agnes[-_. ]?2(?:\.|[-_])?5(?:\.|[-_])?flash/i,
    maxTokens: 512 * 1024,
    officialLabel: '512K',
    source: 'Agnes 官方文档：Agnes 2.5 Flash 上下文窗口 512K',
  },
  {
    pattern: /glm[-_. ]?4(?:\.|[-_])?5/i,
    maxTokens: 128 * 1024,
    officialLabel: '128K',
    source: '智谱官方文档：GLM-4.5 上下文窗口 128K',
  },
  {
    pattern: /qwen(?:3(?:\.|[-_])?5)?[-_. ]?4b/i,
    maxTokens: 256 * 1024,
    officialLabel: '256K',
    source: 'Qwen3.5 官方模型卡：Qwen3.5-4B 上下文窗口 256K',
  },
  {
    pattern: /llama[-_. ]?3(?:\.|[-_])?3[-_. ]?70b/i,
    maxTokens: 128 * 1024,
    officialLabel: '128K',
    source: 'Groq 官方定价页：Llama 3.3 70B Versatile 上下文 128K',
  },
  {
    pattern: /gpt[-_. ]?4o[-_. ]?mini/i,
    maxTokens: 128 * 1024,
    officialLabel: '128K',
    source: 'OpenAI 官方发布：GPT-4o mini 上下文窗口 128K',
  },
  {
    // 2026-11 官方定价页：deepseek-flash / deepseek-v4-flash 为 1M 上下文
    pattern: /deepseek[-_. ]?(?:v4[-_. ]?flash|flash)/i,
    maxTokens: 1024 * 1024,
    officialLabel: '1M',
    source: 'DeepSeek 官方定价页：deepseek-flash 上下文长度 1M',
  },
  {
    pattern: /deepseek[-_. ]?(?:chat|reasoner|v3(?:\.|[-_])?2)/i,
    maxTokens: 128 * 1024,
    officialLabel: '128K',
    source: 'DeepSeek 官方定价页：deepseek-chat / reasoner 上下文长度 128K',
  },
];

function fmtTokens(tokens: number): string {
  if (tokens >= 1024 * 1024) {
    const m = tokens / (1024 * 1024);
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1024)}K`;
}

function buildProfile(rule: ProfileRule): ModelContextProfile {
  const fourth = rule.maxTokens / 4;
  const half = rule.maxTokens / 2;
  return {
    maxTokens: rule.maxTokens,
    officialLabel: rule.officialLabel,
    source: rule.source,
    tiers: [
      { label: fmtTokens(fourth), tokens: fourth },
      { label: fmtTokens(half), tokens: half },
      { label: fmtTokens(rule.maxTokens), tokens: rule.maxTokens },
    ],
  };
}

/** 按模型名推断官方上下文档位；未命中（如本地网关/未知模型）返回 null，不虚构容量。 */
export function contextProfileFor(tool: Pick<ToolLike, 'name' | 'model' | 'endpoint'>): ModelContextProfile | null {
  const haystack = `${tool.model ?? ''} ${tool.name} ${tool.endpoint}`;
  const rule = PROFILE_RULES.find((r) => r.pattern.test(haystack));
  return rule ? buildProfile(rule) : null;
}

/** 从 model_notes 解析已记录的上下文容量，例如「上下文容量：128K」。 */
export function parseContextCapacity(notes: string | null | undefined): string {
  const m = (notes ?? '').match(/上下文容量\s*[：:]\s*([0-9]+(?:\.[0-9]+)?[KM])/i);
  return m ? m[1].toUpperCase() : '';
}

/** 写入/替换 model_notes 中的上下文容量标注，保留其他说明文字。 */
export function withContextCapacity(notes: string | null | undefined, label: string): string {
  const stripped = (notes ?? '')
    .replace(/上下文容量\s*[：:]\s*[0-9]+(?:\.[0-9]+)?[KM]\s*[；;，,。.、]?/gi, '')
    .replace(/[；;，,。.、\s]+$/g, '')
    .replace(/^[；;，,。.、\s]+/g, '')
    .trim();
  return [stripped, label ? `上下文容量：${label}` : ''].filter(Boolean).join('；');
}

export interface ContextBadge {
  readonly label: string;
  readonly configured: boolean;
  readonly profile: ModelContextProfile | null;
  readonly title: string;
}

/**
 * 列表/选择器展示用：优先取配置值；未配置时展示官方中档作为默认建议，
 * 让用户在选择模型时能看到容量量级，同时不修改任何已保存数据。
 */
export function contextBadgeFor(tool: ToolLike): ContextBadge | null {
  const profile = contextProfileFor(tool);
  const configuredLabel = parseContextCapacity(tool.model_notes);
  if (!configuredLabel && !profile) return null;
  const label = configuredLabel || profile?.tiers[1]?.label || '';
  const configured = Boolean(configuredLabel);
  const title = configured
    ? `上下文容量：${label}（已配置）`
    : `上下文容量：${label}（官方建议中档；${profile?.source ?? ''}）`;
  return { label, configured, profile, title };
}

/** 编辑表单用：已配置值优先，否则回落到官方中档建议。 */
export function selectedContextCapacity(tool: ToolLike): string {
  const configured = parseContextCapacity(tool.model_notes);
  if (configured) return configured;
  return contextProfileFor(tool)?.tiers[1]?.label ?? '';
}
