/**
 * T01562（FR-3.2 真抽屉）：右侧滑入抽屉基元。
 * 真抽屉语义：固定右侧、遮罩点按关闭、ESC 关闭、焦点进入/归还、aria-modal；
 * 与现有「行内展开」并存（行内=列表内快速预览，抽屉=完整操作台）。
 * 采用「始终挂载 + transform 过渡」实现滑入/滑出动画，关闭时不阻断主列表（pointer-events 切换）。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function SlideOver({ open, title, onClose, children, width = 480 }: {
  readonly open: boolean;
  readonly title?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  // T01562 验收口径：无障碍用 aria-labelledby 指向标题节点（而非把标题塞进 aria-label）
  const titleId = useId();
  // onClose 多为父级内联箭头（每次渲染新身份）：放进 ref，避免 effect 因身份变化反复
  // 执行「焦点归还」清理——那会把 prevFocus 重新捕获为抽屉内元素，关闭后焦点落到 body。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 关闭请求统一入口：**先**把焦点归还给触发按钮，**再**通知父级卸载抽屉。
  // 顺序很关键——卸载后触发按钮随行 hover 收起（visibility:hidden），focus() 会静默失败，
  // 焦点掉到 body（键盘/读屏用户在关闭后失去上下文）。先聚焦后关闭可让 :focus-within 继续撑开工具栏。
  const close = () => {
    prevFocus.current?.focus?.();
    onCloseRef.current();
  };

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    // 打开后将焦点移入抽屉首个可聚焦控件
    const id = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      el?.focus();
    }, 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // 抽屉打开期间锁定背景滚动
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.(); // 兜底：父级直接卸载（非经 close）时仍尝试归还焦点
    };
  }, [open]);

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        pointerEvents: open ? 'auto' : 'none',
        visibility: open ? 'visible' : 'hidden',
      }}
      aria-hidden={!open}
    >
      {/* 遮罩：rgba(0,0,0,.32) 点按关闭，淡入 200ms */}
      <div
        onClick={close}
        style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,.32)',
          opacity: open ? 1 : 0, transition: 'opacity 200ms ease',
        }}
      />
      {/* 抽屉面板：右进右出 translateX(100%)→0 300ms */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '抽屉'}
        tabIndex={-1}
        style={{
          position: 'absolute', top: 0, right: 0, height: '100%',
          width: `min(${width}px, 92vw)`, background: 'var(--card-bg)',
          boxShadow: '-8px 0 24px rgba(0,0,0,.18)', borderLeft: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms cubic-bezier(.22,1,.36,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
          <div id={titleId} style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{title}</div>
          <button
            onClick={close}
            aria-label="关闭抽屉"
            title="关闭抽屉（ESC）"
            className="tbtn-anim"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'inline-flex', padding: 4, color: 'var(--text)' }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
