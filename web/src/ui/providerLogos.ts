/**
 * T05780 二轮：厂商图标本地资产映射。
 *
 * 背景：预制卡的 icon_url 指向厂商官网 favicon/CDN，但打包版以 file:// 加载 web/dist，
 * 且部分站点 favicon 返回 404 / 非图片（如 agnes、智谱、火山、百炼），导致「图标缺失」。
 * 这里把可用图标随前端一起打包，import 后由 Vite 产出相对 URL（base './'），离线可渲染。
 * 未收录的厂商仍回落 preset.icon_url，再失败才用首字母兜底。
 */
import agnes from '../assets/providers/agnes.png';
import anthropic from '../assets/providers/anthropic.svg';
import deepseek from '../assets/providers/deepseek.svg';
import gemini from '../assets/providers/gemini.svg';
import groq from '../assets/providers/groq.ico';
import kimi from '../assets/providers/kimi.svg';
import dashscope from '../assets/providers/dashscope.png';
import mimo from '../assets/providers/mimo.svg';
import minimax from '../assets/providers/minimax.svg';
import mistral from '../assets/providers/mistral.svg';
import ollama from '../assets/providers/ollama.svg';
import openai from '../assets/providers/openai.ico';
import openrouter from '../assets/providers/openrouter.svg';
import qwen from '../assets/providers/qwen.svg';
import siliconflow from '../assets/providers/siliconflow.png';
import volcengine from '../assets/providers/volcengine.png';
import zhipu from '../assets/providers/zhipu.png';

/** 预制 id → 本地打包图标 URL；优先于远端 icon_url。 */
export const LOCAL_PROVIDER_LOGOS: Readonly<Record<string, string>> = {
  agnes,
  anthropic,
  deepseek,
  gemini,
  groq,
  kimi,
  moonshot: kimi,
  mimo,
  minimax,
  mistral,
  ollama,
  openai,
  openrouter,
  qwen,
  dashscope,
  siliconflow,
  volcengine,
  zhipu,
};

/**
 * 由配置记录（名称/Endpoint/模型）推断预制 id，供列表名称列展示厂商 logo。
 * 只做品牌关键词匹配，不改变任何业务字段；推断不出返回 null，调用方回落到首字母徽标。
 *
 * T06052 复查：原实现把 name/type/endpoint 拼成一个字符串后按提示表顺序取第一个命中，
 * 导致 Qwen 记录只要 Endpoint 含 dashscope 就被判成「阿里云百炼」，同一批不同厂商记录
 * 全部显示同一个图标。现改为分字段计分：名称中的品牌 > Endpoint 品牌 > 模型品牌，
 * 并对「OpenAI Compatible / 自定义」这类通用名称降权，避免协议名盖过真实厂商。
 */
interface ProviderHint {
  readonly id: string;
  readonly names: readonly string[];
  readonly urls: readonly string[];
  readonly models?: readonly string[];
}

const PROVIDER_HINTS: readonly ProviderHint[] = [
  { id: 'agnes', names: ['agnes ai', 'agnes'], urls: ['agnes-ai.com', 'apihub.agnes'] },
  { id: 'kimi', names: ['kimi', 'moonshot', '月之暗面'], urls: ['moonshot.cn', 'kimi.com'] },
  { id: 'mimo', names: ['小米 mimo', 'mimo', 'xiaomi', '小米'], urls: ['xiaomimimo.com'] },
  { id: 'minimax', names: ['minimax', '海螺'], urls: ['minimax.io'] },
  { id: 'dashscope', names: ['阿里云百炼', '百炼', 'dashscope', 'bailian'], urls: ['dashscope.aliyuncs.com'] },
  { id: 'qwen', names: ['qwen', '通义千问', '通义', '千问'], urls: ['qwen.ai'] },
  { id: 'deepseek', names: ['deepseek', '深度求索'], urls: ['api.deepseek.com', 'deepseek.com'] },
  { id: 'openrouter', names: ['openrouter'], urls: ['openrouter.ai'] },
  { id: 'openai', names: ['openai', 'chatgpt'], urls: ['api.openai.com', 'openai.com'] },
  { id: 'anthropic', names: ['anthropic', 'claude'], urls: ['api.anthropic.com', 'anthropic.com'] },
  { id: 'gemini', names: ['google gemini', 'gemini', 'google', '谷歌'], urls: ['generativelanguage.googleapis.com', 'ai.google.dev'] },
  { id: 'groq', names: ['groq'], urls: ['api.groq.com', 'groq.com'] },
  { id: 'mistral', names: ['mistral'], urls: ['api.mistral.ai', 'mistral.ai'] },
  { id: 'zhipu', names: ['智谱', 'zhipu', 'glm', 'bigmodel'], urls: ['bigmodel.cn'] },
  { id: 'volcengine', names: ['火山方舟', '火山引擎', 'volcengine', '豆包', 'doubao', '方舟'], urls: ['ark.cn-beijing.volces.com', 'volces.com'] },
  { id: 'siliconflow', names: ['硅基流动', 'siliconflow'], urls: ['siliconflow.cn'] },
  { id: 'ollama', names: ['ollama'], urls: ['127.0.0.1:11434', 'localhost:11434'] },
];

const GENERIC_NAME_RE = /compatible|兼容|自定义|代理|proxy|aggregator|聚合/i;

/** 名称命中：完全等于品牌名给 100 分；包含品牌词给 45+词长；通用名称降权。 */
function nameScore(name: string, hints: readonly string[]): number {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  for (const hint of hints) {
    if (normalized === hint) score = Math.max(score, 100);
    else if (normalized.includes(hint)) score = Math.max(score, 45 + Math.min(hint.length, 20));
  }
  return GENERIC_NAME_RE.test(normalized) ? Math.min(score, 12) : score;
}

/** Endpoint 命中：按域名/端口品牌词给 35+词长，不与名称品牌抢优先级。 */
function endpointScore(endpoint: string, hints: readonly string[]): number {
  const normalized = endpoint.trim().toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  for (const hint of hints) {
    if (normalized.includes(hint)) score = Math.max(score, 35 + Math.min(hint.length, 20));
  }
  return score;
}

/** 模型名命中：仅作兜底，避免模型名中的 gpt/claude 等词盖过厂商名称。 */
function modelScore(model: string, hints: readonly string[] | undefined): number {
  const normalized = model.trim().toLowerCase();
  if (!normalized || !hints) return 0;
  for (const hint of hints) {
    if (normalized.includes(hint)) return 16;
  }
  return 0;
}

/**
 * 兼容旧调用：只传一个字符串时按名称处理；新调用应传分字段对象。
 * 同分时按名称/Endpoint 的词长优先，确保厂商预制 id 唯一且可预测。
 */
export function inferProviderId(
  input: string | { readonly name?: string; readonly endpoint?: string; readonly model?: string },
): string | null {
  const ctx = typeof input === 'string' ? { name: input } : input;
  let best: { id: string; score: number; specificity: number } | null = null;
  for (const hint of PROVIDER_HINTS) {
    const n = nameScore(ctx.name ?? '', hint.names);
    const u = endpointScore(ctx.endpoint ?? '', hint.urls);
    const m = modelScore(ctx.model ?? '', hint.models);
    const score = Math.max(n, u, m);
    if (score <= 0) continue;
    const specificity = Math.max(
      ...hint.names.filter((h) => (ctx.name ?? '').toLowerCase().includes(h)).map((h) => h.length),
      ...hint.urls.filter((h) => (ctx.endpoint ?? '').toLowerCase().includes(h)).map((h) => h.length),
      0,
    );
    if (!best || score > best.score || (score === best.score && specificity > best.specificity)) {
      best = { id: hint.id, score, specificity };
    }
  }
  return best?.id ?? null;
}
