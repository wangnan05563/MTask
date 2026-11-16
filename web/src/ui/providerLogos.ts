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
import mimo from '../assets/providers/mimo.svg';
import minimax from '../assets/providers/minimax.svg';
import mistral from '../assets/providers/mistral.svg';
import ollama from '../assets/providers/ollama.svg';
import openai from '../assets/providers/openai.ico';
import openrouter from '../assets/providers/openrouter.svg';
import qwen from '../assets/providers/qwen.svg';

/** 预制 id → 本地打包图标 URL；优先于远端 icon_url。 */
export const LOCAL_PROVIDER_LOGOS: Readonly<Record<string, string>> = {
  agnes,
  anthropic,
  deepseek,
  gemini,
  groq,
  kimi,
  mimo,
  minimax,
  mistral,
  ollama,
  openai,
  openrouter,
  qwen,
};

/**
 * 由配置记录（名称/厂商类型/Endpoint/模型）推断预制 id，供列表名称列展示厂商 logo。
 * 只做品牌关键词匹配，不改变任何业务字段；推断不出返回 null，调用方回落到首字母徽标。
 */
const PROVIDER_HINTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['agnes', ['agnes']],
  ['kimi', ['kimi', 'moonshot']],
  ['mimo', ['mimo', 'xiaomi', '小米']],
  ['minimax', ['minimax', '海螺']],
  ['qwen', ['qwen', '通义', '千问', 'dashscope', '百炼']],
  ['deepseek', ['deepseek', '深度求索']],
  ['openrouter', ['openrouter']],
  ['openai', ['openai', 'chatgpt', 'gpt-']],
  ['anthropic', ['anthropic', 'claude']],
  ['gemini', ['gemini', 'google', '谷歌']],
  ['groq', ['groq']],
  ['mistral', ['mistral']],
  ['zhipu', ['zhipu', '智谱', 'bigmodel', 'glm']],
  ['volcengine', ['volcengine', '火山', '方舟', 'doubao', '豆包']],
  ['siliconflow', ['siliconflow', '硅基流动']],
  ['ollama', ['ollama']],
];

export function inferProviderId(text: string): string | null {
  const hay = text.toLowerCase();
  for (const [id, hints] of PROVIDER_HINTS) {
    if (hints.some((h) => hay.includes(h))) return id;
  }
  return null;
}
