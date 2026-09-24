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
  /**
   * T00964：允许"空输入提交"。默认 false —— 空输入点确定等同取消（resolve null），
   * 调用方无法区分"用户清空后确认"与"取消"，导致"用默认值导入"这类场景静默无响应。
   * 为 true 时空输入点确定 resolve ''（取消仍是 null），由调用方决定回退到默认值。
   */
  allowEmpty?: boolean;
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

/** 输入弹窗 props：readonly 修饰（S6759），与 ConfirmDialogProps 保持一致 */
interface InputDialogProps {
  readonly options: AskInputOptions;
  readonly onSubmit: (value: string | null) => void;
}

function InputDialog({ options, onSubmit }: InputDialogProps) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const ref = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // T00964：allowEmpty 时空输入 resolve ''（仍可与取消 null 区分），否则维持"空=取消"老语义
  const ok = () => onSubmit(value.trim() ? value.trim() : (options.allowEmpty ? '' : null));
  const cancel = () => onSubmit(null);

  // 遮罩点击关闭用文档级事件委托 + ref 包含性判断（S6848），避免在非交互遮罩上挂交互 handler
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) cancel();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  });

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} style={panelStyle}>
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

/** 确认弹窗 props：readonly 修饰（S6759） */
interface ConfirmDialogProps {
  readonly message: string;
  readonly onSubmit: (ok: boolean) => void;
}

function ConfirmDialog({ message, onSubmit }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape 关闭用 globalThis 监听（S7764，环境无关的全局对象）；
  // 遮罩点击关闭同 InputDialog 改为文档级事件委托（S6848），resolve(false) 行为不变
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSubmit(false);
    };
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onSubmit(false);
    };
    globalThis.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      globalThis.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [onSubmit]);

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} style={panelStyle}>
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

// ---------- 扩展输入弹窗（T00506 调整：文本 + 下拉选择 + 条件数字字段，用于「新建计划任务」弹窗） ----------

export interface AskInputExOptions {
  title: string;
  placeholder?: string;
  /** 下拉选择字段（如任务类型） */
  select: { label: string; options: Array<{ value: string; label: string }>; defaultValue: string };
  /** 条件数字字段（如日常任务的工时估算）；showIf 依据下拉值决定是否显示。
   *  T00750：label/required 支持函数形式——按所选类型给出不同文案与必填性（工期字段默认可见） */
  numberField?: {
    label: string | ((selectValue: string) => string);
    placeholder?: string;
    min?: number;
    required?: boolean | ((selectValue: string) => boolean);
    showIf?: (selectValue: string) => boolean;
  };
}

export interface AskInputExResult {
  text: string;
  selectValue: string;
  numberValue: number | null;
}

interface InputDialogExProps {
  readonly options: AskInputExOptions;
  readonly onSubmit: (result: AskInputExResult | null) => void;
}

function InputDialogEx({ options, onSubmit }: InputDialogExProps) {
  const [text, setText] = useState('');
  const [sel, setSel] = useState(options.select.defaultValue);
  const [num, setNum] = useState<string>('');
  const ref = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const showNum = options.numberField ? (options.numberField.showIf?.(sel) ?? true) : false;
  // T00750：required/label 支持函数形式（如「工期」对日常任务必填、对普通任务选填）
  const numRequiredRaw = options.numberField?.required;
  const numRequired = typeof numRequiredRaw === 'function' ? numRequiredRaw(sel) : !!numRequiredRaw;
  const labelRaw = options.numberField?.label;
  const numLabel = typeof labelRaw === 'function' ? labelRaw(sel) : (labelRaw ?? '');
  const numOk = !options.numberField || !showNum || !numRequired || (Number(num) >= (options.numberField.min ?? Number.NEGATIVE_INFINITY) && num.trim() !== '');

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onSubmit(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onSubmit(null); };
    globalThis.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => { globalThis.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDocMouseDown); };
  }, [onSubmit]);

  const ok = () => { if (text.trim() && numOk) onSubmit({ text: text.trim(), selectValue: sel, numberValue: showNum && num.trim() !== '' ? Number(num) : null }); };
  const fieldLabel: CSSProperties = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} style={panelStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{options.title}</div>
        <label style={fieldLabel}>{options.select.label}</label>
        <select value={sel} onChange={(e) => setSel(e.target.value)}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box', marginBottom: 12 }}>
          {options.select.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label style={fieldLabel}>{options.select.label === '任务类型' ? '任务标题' : '标题'}</label>
        <input ref={ref} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && numOk) ok(); }}
          placeholder={options.placeholder}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
        />
        {options.numberField && showNum && (
          <>
            <label style={{ ...fieldLabel, marginTop: 12 }}>{numLabel}{numRequired ? '（必填）' : ''}</label>
            <input type="number" value={num} min={options.numberField.min} onChange={(e) => setNum(e.target.value)}
              placeholder={options.numberField.placeholder}
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
            />
          </>
        )}
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ghost" onClick={() => onSubmit(null)} title="取消 — 放弃本次输入" aria-label="取消：放弃本次输入" style={{ padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={14} style={{ verticalAlign: '-2px' }} />取消</button>
          <button
            onClick={ok}
            disabled={!numOk}
            title={numOk ? '确定 — 确认并提交' : '请先填写必填的数字字段'}
            aria-label="确定：确认并提交"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: numOk ? 'pointer' : 'not-allowed', opacity: numOk ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Check size={14} style={{ verticalAlign: '-2px' }} />确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 扩展输入对话框：返回 { 文本, 下拉值, 数字值 }，取消返回 null（标题为空视为取消） */
export function askInputEx(options: AskInputExOptions): Promise<AskInputExResult | null> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <InputDialogEx
        options={options}
        onSubmit={(r) => { close(); resolve(r); }}
      />
    ));
  });
}
