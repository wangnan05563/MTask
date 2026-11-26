import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Check, X } from 'lucide-react';
import { useEscapeLayer } from './components/modalLayer';
import { ProductTagCombobox } from './ProductTagCombobox';

/**
 * Promise 风格的模态对话框，替代 window.prompt / window.confirm。
 * Electron（Chromium）不支持 window.prompt，点击后无任何弹窗，故自绘。
 */

export interface AskInputOptions {
  title: string;
  /** 可选正文说明（危险操作确认等需要多行提示；不设置时保持原有单标题外观） */
  description?: string;
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
  minWidth: 'min(340px, calc(100vw - 32px))',
  maxWidth: 'min(480px, calc(100vw - 32px))',
  boxSizing: 'border-box',
  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
  fontFamily: 'system-ui, sans-serif',
};

function mountDialog(render: (close: () => void) => ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = false;
  const close = () => {
    // Esc 与遮罩 mousedown 可能在同一交互里先后触发；重复 unmount 会让 React 报警，也会重复 resolve。
    if (closed) return;
    closed = true;
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
  const cancel = () => onSubmit(null);

  // Esc 走统一栈，且只触发栈顶；避免与打开本弹窗的 More/Drawer 同时响应一次 Escape。
  useEscapeLayer(true, true, cancel);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // T00964：allowEmpty 时空输入 resolve ''（仍可与取消 null 区分），否则维持"空=取消"老语义
  const ok = () => {
    const trimmed = value.trim();
    onSubmit(trimmed || (options.allowEmpty ? '' : null));
  };

  // 遮罩点击关闭用文档级事件委托 + ref 包含性判断（S6848），避免在非交互遮罩上挂交互 handler
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onSubmit(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onSubmit]);

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} tabIndex={-1} style={panelStyle} role="dialog" aria-modal="true" aria-label={options.title}>
        <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 12 }}>{options.title}</div>
        {options.description && (
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: 10 }}>{options.description}</div>
        )}
        <input
          ref={ref}
          value={value}
          aria-label={options.title}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ok();
          }}
          placeholder={options.placeholder}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', boxSizing: 'border-box' }}
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
  /** 在抽屉（SlideOver，z-index 1100）内调用时必须抬高，否则确认面板被抽屉盖住：
   *  按钮看不见也点不着，而「面板外 mousedown 即取消」的文档级委托会把手指落在遮罩上的动作判成取消。 */
  readonly zIndex?: number;
}

function ConfirmDialog({ message, onSubmit, zIndex = 1000 }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancel = () => onSubmit(false);

  // Esc 走统一栈；同一时刻只有最上层响应，避免确认框与背后的 More/Drawer 一起关闭。
  useEscapeLayer(true, true, cancel);

  // 遮罩点击关闭保持文档级事件委托（S6848），resolve(false) 行为不变
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onSubmit(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onSubmit]);

  return (
    <div style={{ ...overlayStyle, zIndex }}>
      <div ref={panelRef} tabIndex={-1} style={panelStyle} role="alertdialog" aria-modal="true" aria-label="确认操作">
        <div style={{ fontSize: 'var(--fs-l)', marginBottom: 16, whiteSpace: 'pre-wrap' }}>{message}</div>
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

/** 确认对话框；options.zIndex 供抽屉等高层浮层内调用时抬层级（默认 1000） */
export function askConfirm(message: string, options?: { zIndex?: number }): Promise<boolean> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <ConfirmDialog
        message={message}
        zIndex={options?.zIndex}
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
  // T00783-N1：填了就校验 min，留空才看必填——原先选填态（numRequired=false）会跳过 min 校验，
  // 工期填 0/-3 也能提交（服务端 Math.max(1) 静默兜底为 1 天，用户无感知）
  const numOk = !options.numberField || !showNum
    || (num.trim() === ''
      ? !numRequired
      : Number(num) >= (options.numberField.min ?? Number.NEGATIVE_INFINITY) && Number.isFinite(Number(num)));

  // Esc 走统一浮层栈，避免与 More/Drawer 的 Esc 监听级联关闭。
  useEscapeLayer(true, true, () => onSubmit(null));

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onSubmit(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onSubmit]);

  const ok = () => { if (text.trim() && numOk) onSubmit({ text: text.trim(), selectValue: sel, numberValue: showNum && num.trim() !== '' ? Number(num) : null }); };
  const fieldLabel: CSSProperties = { display: 'block', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} tabIndex={-1} style={panelStyle} role="dialog" aria-modal="true" aria-label={options.title}>
        <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 12 }}>{options.title}</div>
        <label style={fieldLabel}>{options.select.label}</label>
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label={options.select.label}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box', marginBottom: 12 }}>
          {options.select.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label style={fieldLabel}>{options.select.label === '任务类型' ? '任务标题' : '标题'}</label>
        <input ref={ref} value={text} onChange={(e) => setText(e.target.value)}
          aria-label={options.select.label === '任务类型' ? '任务标题' : '标题'}
          onKeyDown={(e) => { if (e.key === 'Enter' && numOk) ok(); }}
          placeholder={options.placeholder}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', boxSizing: 'border-box' }}
        />
        {options.numberField && showNum && (
          <>
            <label style={{ ...fieldLabel, marginTop: 12 }}>{numLabel}{numRequired ? '（必填）' : ''}</label>
            <input type="number" value={num} min={options.numberField.min} onChange={(e) => setNum(e.target.value)}
              aria-label={numLabel}
              placeholder={options.numberField.placeholder}
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', boxSizing: 'border-box' }}
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

/** T06407：产品标签弹窗——候选来自项目现有 product_key，无匹配时可直接创建 */
export interface AskProductTagOptions {
  title: string;
  options: readonly string[];
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  /** 弹窗内选择/创建/确定时真正保存；返回 false 时保留弹窗与输入并提示。 */
  onSave?: (value: string) => Promise<boolean>;
}

interface ProductTagDialogProps {
  readonly options: AskProductTagOptions;
  readonly onSubmit: (value: string | null) => void;
}

function ProductTagDialog({ options, onSubmit }: ProductTagDialogProps) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const cancel = () => onSubmit(null);

  useEscapeLayer(true, true, cancel);

  /** 手动确定/选择已有标签：先保存，成功后才关闭；失败保留当前输入。 */
  const commit = async (next: string) => {
    if (saving) return;
    if (!options.onSave) { onSubmit(next); return; }
    setSaving(true);
    setError('');
    try {
      const saved = await options.onSave(next);
      if (!saved) {
        setError('保存失败，请重试；当前输入已保留');
        return;
      }
      setSaving(false);
      onSubmit(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={options.title}
        style={{ ...panelStyle, minWidth: 360 }}>
        <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 8 }}>{options.title}</div>
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 10 }}>
          {options.hint ?? '选择已有标签，或直接输入新名称创建；留空并确定＝清空绑定。'}
        </div>
        <ProductTagCombobox
          value={value}
          options={options.options}
          onChange={setValue}
          onSelect={(next, source) => {
            // 快速创建已由 onCreate 落库；已有标签/手动确定才需要在这里保存。
            if (source === 'create') onSubmit(next);
            else void commit(next);
          }}
          onCreate={options.onSave ? options.onSave : async () => true}
          placeholder={options.placeholder}
          ariaLabel="产品标签"
          autoFocus
        />
        {error && (
          <div role="alert" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>{error}</div>
        )}
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={cancel} aria-label="取消产品标签设置"
            style={{ padding: '6px 14px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-secondary)' }}>
            取消
          </button>
          <button onClick={() => void commit(value.trim())} disabled={saving} aria-label="确定产品标签"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: saving ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={14} style={{ verticalAlign: '-2px' }} />{saving ? '保存中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 打开产品标签选择/创建弹窗；取消返回 null，确定（含快速创建）返回归一化后的标签 */
export function askProductTag(options: AskProductTagOptions): Promise<string | null> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <ProductTagDialog
        options={options}
        onSubmit={(value) => { close(); resolve(value); }}
      />
    ));
  });
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

/**
 * P1-5：结果清单弹窗（导入错误的可操作化展示）。
 * 与 askConfirm 的「一句话提示」不同，这里保留**完整清单**：整文件级原因置顶、行级错误逐条列出，
 * 并提供「复制清单」——用户不必再从一闪而过的 flash 里抄错误。
 */
export interface ReportDialogOptions {
  title: string;
  intro?: string;
  items?: string[];
  footnote?: string;
}

interface ReportDialogProps {
  readonly options: ReportDialogOptions;
  readonly onClose: () => void;
}

function ReportDialog({ options, onClose }: ReportDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const items = options.items ?? [];

  // Esc 走统一浮层栈；报告弹窗可能从 Dialog/Drawer 内打开，只关最上层。
  useEscapeLayer(true, true, onClose);

  const copyAll = async () => {
    const text = [options.title, options.intro ?? '', ...items, options.footnote ?? ''].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div style={overlayStyle}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={options.title}
        style={{ ...panelStyle, minWidth: 420, maxWidth: 640, maxHeight: '76vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 8 }}>{options.title}</div>
        {options.intro && (
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: 10 }}>{options.intro}</div>
        )}
        {items.length > 0 && (
          <ol aria-label="错误清单" style={{ margin: 0, paddingLeft: 20, overflowY: 'auto', maxHeight: '46vh', fontSize: 'var(--fs-s)', lineHeight: 1.7, color: 'var(--text)' }}>
            {items.map((it) => <li key={it}>{it}</li>)}
          </ol>
        )}
        {options.footnote && (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 10 }}>{options.footnote}</div>
        )}
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {items.length > 0 && (
            <button onClick={() => void copyAll()} title="复制完整错误清单到剪贴板" aria-label="复制错误清单"
              style={{ padding: '6px 14px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-secondary)' }}>
              {copied ? '已复制' : '复制清单'}
            </button>
          )}
          <button onClick={onClose} title="关闭" aria-label="关闭"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={14} style={{ verticalAlign: '-2px' }} />知道了
          </button>
        </div>
      </div>
    </div>
  );
}

/** 打开结果清单弹窗（无返回值；关闭即结束） */
export function showReport(options: ReportDialogOptions): void {
  mountDialog((close) => <ReportDialog options={options} onClose={close} />);
}
