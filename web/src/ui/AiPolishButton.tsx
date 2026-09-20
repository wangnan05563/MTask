import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { api, type AITool } from '../api/client';

/**
 * T00796 二轮：通用正文「AI 美化」按钮（复用 POST /api/ai/polish）。
 *
 * 抽出公共组件的动因：验证失败反馈、处理结果、通用需求内容都是同一类诉求
 * ——把口语化随手记润色为规范书面文本，且都要求「回填输入框、用户确认后再保存」。
 * 各页面自己写一遍会重复 busy 态 / 禁用态 / 错误反馈 / 图标动画四套逻辑。
 *
 * toolId 为空时自动取「模型管理」里第一个已配置模型的工具（模块级缓存，避免每行都拉一次）。
 * 润色结果一律通过 onPolished 回填，由调用方决定何时保存 —— 不自动落库。
 */

/** 模块级缓存：AI 工具列表在同一会话内不变，避免每个按钮各拉一次 /aitools */
let toolCache: string | null = null;
let toolPending: Promise<string> | null = null;

async function resolveToolId(): Promise<string> {
  if (toolCache) return toolCache;
  if (!toolPending) {
    toolPending = api.get<AITool[]>('/aitools')
      .then((list) => {
        const valid = (list ?? []).filter((t) => t.model);
        toolCache = valid[0]?.id ?? '';
        return toolCache;
      })
      .catch(() => '')
      .finally(() => { toolPending = null; });
  }
  return toolPending;
}

export function AiPolishButton({ value, onPolished, toolId, disabled, flash, title }: {
  /** 待润色的原文（空则按钮禁用） */
  readonly value: string;
  /** 润色结果回填回调（不自动保存，由调用方确认后落库） */
  readonly onPolished: (text: string) => void;
  /** 指定 AI 工具；缺省时自动取模型管理里第一个已配置模型的工具 */
  readonly toolId?: string;
  readonly disabled?: boolean;
  /** 提示回调（页面统一的 flash/toast）；不传时静默 */
  readonly flash?: (msg: string) => void;
  /** 悬浮提示文案；不同场景语义不同，由调用方给出 */
  readonly title: string;
}) {
  const [busy, setBusy] = useState(false);
  const [autoToolId, setAutoToolId] = useState('');

  useEffect(() => {
    if (toolId) return;
    void resolveToolId().then(setAutoToolId);
  }, [toolId]);

  const text = value.trim();
  const active = toolId || autoToolId;

  async function run() {
    if (!text) { flash?.('请先填写内容，再点击 AI 美化'); return; }
    if (!active) { flash?.('请先在「模型管理」页添加并选择 AI 工具'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/polish', { toolId: active, text });
      if (!r.ok) { flash?.(r.error ?? 'AI 美化失败'); return; }
      if (!r.content?.trim()) { flash?.('AI 未返回美化结果'); return; }
      onPolished(r.content.trim());
      flash?.('已美化，请核对后保存');
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 可用性只体现在颜色与指针上，不再把不透明度压到 0.45 ——
  // 用户反馈「找不到 AI 美化按钮」：空文本时按钮几乎隐形（0.45 下 13px 描边图标在浅色背景上不可辨），
  // 按钮本身必须始终清晰可见，否则功能等于不存在。
  const noText = !text;
  const idle = !busy && !disabled && !noText;
  const label = busy ? 'AI 美化进行中…' : (noText ? `${title}（请先填写内容）` : title);
  return (
    <button
      onClick={() => void run()}
      disabled={busy || disabled || noText}
      title={label}
      aria-label={busy ? 'AI 美化进行中' : 'AI 美化：润色正文'}
      className={`task-op tbtn-anim${busy ? ' task-breathe' : ''}`}
      style={{
        fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', border: 'none',
        cursor: idle ? 'pointer' : 'default',
        background: busy ? 'var(--accent)' : 'transparent',
        color: busy ? 'var(--accent-text)' : (idle ? 'var(--text)' : 'var(--text-muted)'),
        opacity: idle || busy ? 1 : 0.75,
      }}
    >
      {busy ? <Loader2 size={13} className="aispin" /> : <Sparkles size={13} />}
    </button>
  );
}
