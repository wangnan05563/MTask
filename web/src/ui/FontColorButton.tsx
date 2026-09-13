import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * T00490：Excel 风格字体颜色按钮（记录工具栏通用组件）。
 * - 左侧主体：点击直接应用当前选中颜色（无需确认）
 * - 右侧箭头：展开 16 色板 + 「默认」清除项
 * - 动画：悬浮倾斜缩放（tbtn-anim 基准）+ 点击缩放
 * - current：当前颜色（''=默认色）；onApply(color)：'' 表示恢复默认
 */
const PALETTE = [
  '#000000', '#7F7F7F', '#880015', '#ED1C24',
  '#FF7F27', '#FFF200', '#22B14C', '#00A2E8',
  '#3F48CC', '#A349A4', '#FFFFFF', '#C3C3C3',
  '#B97A57', '#FFAEC9', '#FFC90E', '#EFE4B0',
];

export function FontColorButton({ current, onApply, label = '字体颜色' }: {
  current: string;
  onApply: (color: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const barColor = current || 'var(--text)';

  // 点击组件外部关闭色板
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={hostRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        className="tbtn-anim"
        role="button"
        tabIndex={0}
        title={`${label} — 点击应用当前颜色（${current || '默认'}）`}
        aria-label={`${label}：点击直接应用当前颜色`}
        onClick={() => onApply(current)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onApply(current); } }}
        style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1, padding: '1px 4px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text)', userSelect: 'none' }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'serif', textDecoration: 'none' }}>A</span>
        <span style={{ display: 'block', width: 14, height: 3, borderRadius: 1, background: barColor, marginTop: 1 }} />
      </span>
      <button
        className="tbtn-anim"
        onClick={() => setOpen((o) => !o)}
        title={`${label}选择 — 展开颜色面板`}
        aria-label={`${label}：展开颜色面板`}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'flex-end', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'var(--text-muted)' }}
      >
        <ChevronDown size={10} />
      </button>
      {open && (
        <div
          role="listbox"
          style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', padding: 6, zIndex: 20, display: 'grid', gridTemplateColumns: 'repeat(8, 18px)', gap: 4 }}
        >
          {PALETTE.map((c) => (
            <button
              key={c}
              role="option"
              aria-selected={current === c}
              onClick={() => { onApply(c); setOpen(false); }}
              title={c}
              style={{ width: 18, height: 18, borderRadius: 3, background: c, border: current === c ? '2px solid var(--accent)' : '1px solid var(--border)', cursor: 'pointer', transition: 'transform .12s ease' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.2)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'none'; }}
            />
          ))}
          <button
            onClick={() => { onApply(''); setOpen(false); }}
            title="默认色 — 恢复主题默认文字颜色"
            style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--surface-2)', cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            ⌫
          </button>
        </div>
      )}
    </div>
  );
}
