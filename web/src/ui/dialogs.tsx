import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Check, X } from 'lucide-react';

/**
 * Promise 风格的模态对话框，替代 window.prompt / window.confirm。
 * Electron（Chromium）不支持 window.prompt，点击后无任何弹窗，故自绘。
 */

export interface AskInputOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const panelStyle: CSSProperties = {
  background: 'var(--card-bg)',
  borderRadius: 8,
  padding: 20,
  minWidth: 340,
  maxWidth: 480,
  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
  fontFamily: 'system-ui, sans-serif',
};

function mountDialog(render: (close: () => void) => ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const close = () => {
    root.unmount();
    container.remove();
  };
  root.render(render(close));
}

function InputDialog({ options, onSubmit }: { options: AskInputOptions; onSubmit: (value: string | null) => void }) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const ok = () => onSubmit(value.trim() ? value.trim() : null);
  const cancel = () => onSubmit(null);

  return (
    <div style={overlayStyle} onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div style={panelStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{options.title}</div>
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ok();
            if (e.key === 'Escape') cancel();
          }}
          placeholder={options.placeholder}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ghost" onClick={cancel} title="取消 — 放弃本次输入" aria-label="取消：放弃本次输入" style={{ padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={14} style={{ verticalAlign: '-2px' }} />{options.cancelText ?? '取消'}</button>
          <button
            onClick={ok}
            title="确定 — 确认并提交输入"
            aria-label="确定：确认并提交输入"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Check size={14} style={{ verticalAlign: '-2px' }} />{options.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ message, onSubmit }: { message: string; onSubmit: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSubmit(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSubmit]);

  return (
    <div style={overlayStyle} onMouseDown={(e) => e.target === e.currentTarget && onSubmit(false)}>
      <div style={panelStyle}>
        <div style={{ fontSize: 14, marginBottom: 16, whiteSpace: 'pre-wrap' }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ghost" onClick={() => onSubmit(false)} title="取消 — 取消并关闭确认" aria-label="取消：取消并关闭确认" style={{ padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={14} style={{ verticalAlign: '-2px' }} />取消</button>
          <button
            onClick={() => onSubmit(true)}
            title="确定 — 确认执行该操作"
            aria-label="确定：确认执行该操作"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Check size={14} style={{ verticalAlign: '-2px' }} />确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 输入对话框：确定返回输入值，取消/空输入返回 null */
export function askInput(options: AskInputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <InputDialog
        options={options}
        onSubmit={(v) => { close(); resolve(v); }}
      />
    ));
  });
}

/** 确认对话框 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <ConfirmDialog
        message={message}
        onSubmit={(ok) => { close(); resolve(ok); }}
      />
    ));
  });
}
