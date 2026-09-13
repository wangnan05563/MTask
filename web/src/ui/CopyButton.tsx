import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * T00538：统一复制按钮——点击复制后图标切换为对号（✓）短暂反馈，随后恢复。
 * 全站复制按钮统一使用本组件（任务/提示词/通用需求等），保证动画与交互一致。
 */
export function CopyButton(props: {
  getText: () => string;
  title?: string;
  ariaLabel?: string;
  size?: number;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    const text = props.getText();
    void navigator.clipboard.writeText(text).catch(() => {
      // Electron/file:// 下 clipboard API 可能受限，execCommand 兜底
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      className="abtn"
      onClick={doCopy}
      title={copied ? '已复制' : (props.title ?? '复制到剪贴板')}
      aria-label={(props.ariaLabel ?? '复制') + (copied ? '（已复制）' : '')}
      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', ...(props.style ?? {}) }}
    >
      {copied ? <Check size={props.size ?? 13} style={{ color: 'var(--success)' }} /> : <Copy size={props.size ?? 13} />}
    </button>
  );
}
