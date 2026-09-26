import { useEffect, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import { api, type AITool } from '../api/client';

/**
 * 「提示词优化」按钮（T00842 二轮）：把一段正文改写为结构化提示词。
 *
 * 语义对齐任务页菜单的同名操作：调 POST /api/ai/optimize，输入为「标题 + 正文」，
 * 用整理工具生成可复用、要素清晰的结构化提示词。与前缀 AiPolishButton（/ai/polish 润色
 * 而非改写结构）是两个不同诉求，故单独抽出而非混用。
 *
 * 与 AiPolishButton 一致的约定：
 * - toolId 为空时自动取「模型管理」里第一个已配置模型的工具（模块级缓存）；
 * - 结果通过 onOptimized 回填输入框，由调用方确认后再保存，不自动落库；
 *   ——所以本组件不做“是否脏数据”判断，保存决策交给页面。
 * - 大模型常把结果包在 ```markdown ``` 代码围栏里，回填前剥离，避免落库/渲染多出围栏。
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

/** 剥离大模型常见的 ```markdown``` 代码围栏，避免结构标记残留在落库内容里 */
function stripCodeFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

export function PromptOptimizeButton({ title, content, onClick, onOptimized, disabled, flash }: {
  /** 条目/标题，作为优化输入的辅助信息（用于生成结构上下文） */
  readonly title: string;
  /** 待优化的正文（空则按钮禁用） */
  readonly content: string;
  /** 自定义执行钩子；不传时用内置逻辑调 /ai/optimize */
  readonly onClick?: () => void;
  /** 优化结果回填回调（不自动保存，由调用方确认后落库） */
  readonly onOptimized: (text: string) => void;
  readonly disabled?: boolean;
  /** 提示回调（页面统一的 flash/toast）；不传时静默 */
  readonly flash?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [autoToolId, setAutoToolId] = useState('');

  useEffect(() => {
    void resolveToolId().then(setAutoToolId);
  }, []);

  const text = content.trim();
  const active = autoToolId;

  async function run() {
    if (onClick) { onClick(); return; }
    if (!text) { flash?.('请先填写内容，再点击提示词优化'); return; }
    if (!active) { flash?.('请先在「模型管理」页添加并选择 AI 工具'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/optimize', {
        toolId: active, title, description: text,
      });
      if (!r.ok) { flash?.(r.error ?? '提示词优化失败'); return; }
      if (!r.content?.trim()) { flash?.('AI 未返回优化结果'); return; }
      onOptimized(stripCodeFence(r.content.trim()));
      flash?.('已生成结构化提示词，请核对后保存');
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const idle = !busy && !disabled && !!text;
  const label = busy ? '提示词优化进行中…' : '提示词优化 — 用选中工具把内容改写为结构化提示词';
  return (
    <button
      onClick={() => void run()}
      disabled={busy || disabled || !text}
      title={text ? label : `${label}（请先填写内容）`}
      aria-label={busy ? '提示词优化进行中' : '提示词优化：把内容改写为结构化提示词'}
      className={`task-op tbtn-anim${busy ? ' task-breathe' : ''}`}
      style={{
        fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', border: 'none',
        cursor: idle ? 'pointer' : 'default',
        background: busy ? 'var(--accent)' : 'transparent',
        color: busy ? 'var(--accent-text)' : (idle ? 'var(--text)' : 'var(--text-muted)'),
        opacity: idle || busy ? 1 : 0.75,
      }}
    >
      {busy ? <Loader2 size={13} className="aispin" /> : <Wand2 size={13} />}
    </button>
  );
}