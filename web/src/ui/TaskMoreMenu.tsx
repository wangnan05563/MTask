import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

/**
 * T05712：任务标题下方工具栏的低频功能「...」下拉菜单。
 *
 * 设计约束（工单 + 参考图）：
 *  - 7 项低频功能不再以独立按钮直接显示，统一收进本菜单（左图标 + 文字、白底圆角卡片、
 *    细边框、轻阴影、行距统一），主工具栏只留高频操作。
 *  - 迁移后原有点击事件 / 回调 / 参数 / 禁用与显隐口径不变：调用方把原按钮的
 *    aria-label / title / onClick 原样传入 items，本组件只负责承载与呈现。
 *  - 菜单必须 createPortal 挂 body：任务行 .task-toolbar 有 overflow:hidden 与
 *    .cv-auto(content-visibility:auto) 的 paint containment，行内 fixed/absolute 弹层
 *    会被按行裁剪（T01299 同源）；Portal 同时让 fixed 坐标按视口解析。
 *  - 纯前端静态渲染，不发起任何请求：旧版本客户端 / 无网络状态下菜单与 7 个选项仍可展示。
 *  - 字体颜色是文本属性设置，由 trailing 内嵌原 FontColorButton 提供颜色选择器入口，
 *    该行不是 menuitem 按钮（避免按钮嵌套按钮的非法 DOM），控件自身保留全部原交互。
 */
export interface TaskMoreMenuItem {
  /** 稳定键，同时用于 data-t05712 断言属性 */
  key: string;
  /** 菜单文字 */
  label: string;
  /** 沿用原按钮的 aria-label（供既有 UI 门 / 无障碍定位） */
  ariaLabel?: string;
  /** 沿用原按钮的 title（含「— 说明」全文） */
  title?: string;
  /** 左图标（14px 基准，与文字左对齐） */
  icon?: ReactNode;
  disabled?: boolean;
  /** 危险项文字取 --danger（本单 7 项均为非破坏性操作，预留能力不滥用） */
  danger?: boolean;
  /** 沿用原显隐口径：true 时该行不渲染（如分类建议开关关闭） */
  hidden?: boolean;
  /** 沿用原按钮的 data-* 回归锚（如 data-t03255 / data-t03257），迁移后仍可被 UI 门探测 */
  dataAttrs?: Record<string, string>;
  /** 右侧自定义控件（字体颜色色板入口）；存在时整行降级为 group，不渲染 menuitem 按钮 */
  trailing?: ReactNode;
  /** 原按钮 onClick 原样传入；带事件以便「文件导出」沿用 getBoundingClientRect 定位 */
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface Props {
  items: TaskMoreMenuItem[];
  /** 用于 aria-label 归属说明，避免多条同 label 按钮在辅助技术里无法区分 */
  taskTitle?: string;
}

const MENU_W = 196;
const ROW_H = 34;

export function TaskMoreMenu({ items, taskTitle }: Readonly<Props>) {
  const visible = items.filter((it) => !it.hidden);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const close = () => setOpen(false);

  /** 由触发按钮的实时 rect 计算 fixed 坐标（打开、滚动、resize 共用同一口径，避免菜单漂移）。 */
  const place = (r: DOMRect) => {
    const menuH = visible.length * ROW_H + 8;
    // T00565 口径：接近视口底部时向上弹，避免最后一条任务处菜单被截断
    const up = r.bottom + menuH + 8 > globalThis.innerHeight;
    const top = up ? Math.max(8, r.top - menuH - 4) : r.bottom + 4;
    // 右边缘对齐触发按钮，窄屏时钳制进视口（不写死像素断点）
    const left = Math.max(8, Math.min(r.right - MENU_W, globalThis.innerWidth - MENU_W - 8));
    setPos({ top, left });
  };

  // 外点 / Esc 收起；滚动与 resize **重定位而非关闭**：
  // 早期版本用 document 捕获阶段监听 scroll 直接 close()，但点击菜单项后聚焦编辑器、
  // 展开色板、或自动化里的 scrollIntoView 都会触发 scroll，菜单被误收起导致点击失效。
  // Portal 面板与触发按钮都不算外部，否则 mousedown 先于 click 命中菜单项、click 永远不触发。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (hostRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      btnRef.current?.focus();
    };
    const reposition = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) place(r);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visible.length]);

  const toggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (open) { close(); return; }
    place(e.currentTarget.getBoundingClientRect());
    setOpen(true);
  };

  const onItemClick = (it: TaskMoreMenuItem) => (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (it.disabled) return;
    close();
    it.onClick?.(e);
  };

  return (
    <span ref={hostRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        type="button"
        className="task-op"
        data-t05712="more-trigger"
        onClick={toggle}
        title="更多操作 — 展开低频功能（创建子任务 / 文件导出 / 字体颜色 / 搁置 / 分类建议 / 修改处理结果 / 复用此任务）"
        aria-label={taskTitle ? `更多操作：${taskTitle}` : '更多操作'}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', color: 'var(--text-muted)' }}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label="更多操作"
          data-t05712="more-menu"
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 1200,
            width: MENU_W, maxWidth: 'calc(100vw - 16px)',
            // 字体颜色项的色板是 absolute 向外展开的，overflow:auto/hidden 会把它裁掉；
            // 这里只限高不建裁剪上下文，色板入口在下拉里完整可用（窄屏高度由 top 翻转兜底）。
            maxHeight: 'calc(100vh - 16px)', overflow: 'visible',
            background: 'var(--card-bg)', border: '1px solid var(--border-strong)',
            borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,.18)', padding: 4,
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {visible.map((it) => it.trailing ? (
            <div
              key={it.key}
              role="group"
              aria-label={it.ariaLabel ?? it.label}
              title={it.title}
              data-t05712={`item-${it.key}`}
              {...it.dataAttrs}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', minHeight: ROW_H, borderRadius: 6, color: 'var(--text)' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, fontSize: 'var(--fs-m)' }}>
                <span style={{ display: 'inline-flex', color: 'var(--text-muted)', flexShrink: 0 }}>{it.icon}</span>
                <span>{it.label}</span>
              </span>
              {it.trailing}
            </div>
          ) : (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              data-t05712={`item-${it.key}`}
              {...it.dataAttrs}
              disabled={it.disabled}
              title={it.title}
              aria-label={it.ariaLabel ?? it.label}
              onClick={onItemClick(it)}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onFocus={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onBlur={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', gap: 8,
                padding: '7px 10px', minHeight: ROW_H, fontSize: 'var(--fs-m)',
                border: 'none', background: 'transparent', borderRadius: 6, textAlign: 'left',
                color: it.danger ? 'var(--danger)' : 'var(--text)',
                cursor: it.disabled ? 'not-allowed' : 'pointer',
                opacity: it.disabled ? 0.5 : 1,
              }}
            >
              <span style={{ display: 'inline-flex', color: it.danger ? 'var(--danger)' : 'var(--text-muted)', flexShrink: 0 }}>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
