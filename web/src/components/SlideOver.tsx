/**
 * T01562（FR-3.2 真抽屉）：右侧滑入抽屉基元。
 * 真抽屉语义：固定右侧、遮罩点按关闭、ESC 关闭、焦点进入/归还、aria-modal；
 * 与现有「行内展开」并存（行内=列表内快速预览，抽屉=完整操作台）。
 * 采用「始终挂载 + transform 过渡」实现滑入/滑出动画，关闭时不阻断主列表（pointer-events 切换）。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { DRAWER_Z } from '../ui/primitives'; // PM-302 ①：抽屉层叠/遮罩单源

/** T03274（UX-14①）：拖拽调宽的取值范围与落盘键（导出供门禁直测边界） */
export const DRAWER_MIN_W = 320;
export const DRAWER_MAX_RATIO = 0.92;
export const DRAWER_WIDTH_STORAGE_KEY = 'mtask.drawer.width';
/** 视口窄于此值时抽屉铺满整屏（移动端独立），拖拽手柄隐藏 */
export const DRAWER_FULLSCREEN_BELOW = 640;

/** 宽度夹取：下限 320，上限视口的 92%（窄视口时上限不低于下限，避免 min>max 翻转） */
export function clampDrawerWidth(px: number, viewportW: number): number {
  const max = Math.max(DRAWER_MIN_W, Math.floor(viewportW * DRAWER_MAX_RATIO));
  const n = Number.isFinite(px) ? Math.round(px) : DRAWER_MIN_W;
  return Math.min(Math.max(n, DRAWER_MIN_W), max);
}

/** 读上次拖拽的宽度（损坏/超范围的值交给 clampDrawerWidth 兜底） */
export function readStoredDrawerWidth(fallback: number): number {
  try {
    const raw = localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY);
    const n = raw == null ? Number.NaN : Number(JSON.parse(raw));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function storeDrawerWidth(px: number): void {
  try { localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, JSON.stringify(px)); } catch { /* 配额异常静默 */ }
}

export function SlideOver({ open, title, onClose, children, width = 480 }: {
  readonly open: boolean;
  readonly title?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  // T03274（UX-14①）：自适应 + 拖拽调宽——宽度按上次拖拽结果恢复，超出当前视口时夹回 92%
  const [vw, setVw] = useState(() => globalThis.innerWidth || 1280);
  const [w, setW] = useState(() => readStoredDrawerWidth(width));
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onResize = () => setVw(globalThis.innerWidth);
    globalThis.addEventListener('resize', onResize);
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  const fullscreen = vw < DRAWER_FULLSCREEN_BELOW;
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
    const id = globalThis.setTimeout(() => {
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
      globalThis.clearTimeout(id);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.(); // 兜底：父级直接卸载（非经 close）时仍尝试归还焦点
    };
  }, [open]);

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: DRAWER_Z.slideOver,
        pointerEvents: open ? 'auto' : 'none',
        visibility: open ? 'visible' : 'hidden',
      }}
      aria-hidden={!open}
    >
      {/* 遮罩：走 `--overlay` 令牌（PM-302 ① 抽屉单源）点按关闭，淡入 200ms。
          键盘可达由组件自身的全局 Escape 监听（见上方 onKey）与面板右上角原生关闭按钮负责；
          此处另补 Enter/Space 激活，使鼠标便捷路径与键盘路径同效。 */}
      <div /* NOSONAR: S6848 豁免——同项目遮罩统一口径（PlanPage:1029/TasksPage:3598 等）：点空白关闭是便捷辅助，正式关闭入口为 Esc 与原生关闭按钮；改原生 button 会被 App.tsx:207 全局 `button:hover…{transform:rotate(-1.5deg)}` 命中，整屏遮罩悬停即倾斜；补 role="button" 则复现 S6819 */
        tabIndex={-1}
        onClick={close}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') close(); }}
        style={{
          position: 'absolute', inset: 0, background: 'var(--overlay)', // PM-302 ①：遮罩单源走 --overlay 令牌（原硬编码 .32，暗色下压不住亮底）
          opacity: open ? 1 : 0, transition: 'opacity 200ms ease',
        }}
      />
      {/* 抽屉面板：右进右出 translateX(100%)→0 300ms */}
      <div /* NOSONAR: S6819 豁免——面板常驻挂载、以transform/visibility/pointer-events动画；原生<dialog>不调showModal()不渲染且位于顶层，切换将重写开合动画模型 */
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '抽屉'}
        tabIndex={-1}
        style={{
          position: 'absolute', top: 0, right: 0, height: '100%',
          width: fullscreen ? '100vw' : `${clampDrawerWidth(w, vw)}px`, background: 'var(--card-bg)',
          boxShadow: '-8px 0 24px rgba(0,0,0,.18)', borderLeft: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms cubic-bezier(.22,1,.36,1)',
        }}
      >
        {/* T03274（UX-14①）：左缘拖拽调宽；键盘 ←/→ 以 16px 步进（Shift 64px），宽度记在本地 */}
        {!fullscreen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整抽屉宽度（←/→ 键，Shift 加大步长）"
            aria-valuemin={DRAWER_MIN_W}
            aria-valuemax={Math.max(DRAWER_MIN_W, Math.floor(vw * DRAWER_MAX_RATIO))}
            aria-valuenow={clampDrawerWidth(w, vw)}
            tabIndex={0}
            data-drawer-resize="1"
            onPointerDown={(e) => {
              dragRef.current = { startX: e.clientX, startW: clampDrawerWidth(w, vw) };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              setW(clampDrawerWidth(d.startW + (d.startX - e.clientX), vw));
            }}
            onPointerUp={() => {
              if (!dragRef.current) return;
              dragRef.current = null;
              storeDrawerWidth(clampDrawerWidth(w, vw));
            }}
            onPointerCancel={() => { dragRef.current = null; }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 64 : 16;
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const next = clampDrawerWidth(clampDrawerWidth(w, vw) + (e.key === 'ArrowLeft' ? step : -step), vw);
              setW(next);
              storeDrawerWidth(next);
            }}
            style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize',
              background: 'transparent', touchAction: 'none', zIndex: 1,
            }}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
          <div id={titleId} style={{ fontWeight: 600, fontSize: 'var(--fs-xl)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{title}</div>
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
