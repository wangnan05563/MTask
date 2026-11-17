/**
 * T01422（mtask三期 2.1）：移动端组件规范化基础层。
 *
 * 四类基元 + 页面骨架样式，统一消费全局 CSS 变量（--app-bg/--card-bg/--border/--surface-2/
 * --text* 系列与 --accent 等），为「明暗跟随系统」(2.6) 提供单一适配面。
 * 约定：移动端页面优先组合本文件导出的样式常量与组件；确需页面特有样式时以本层值为基底覆盖。
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { t, registerDict } from '../i18n';
import { DRAWER_Z, OVERLAY_MASK } from '../ui/primitives';

/** 页面容器：占满视口、纵向布局、应用底色 */
export const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)' };

/** 顶栏：标题 + 左右操作槽 */
export const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };

/** 内容滚动区 */
export const bodyStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };

/** 卡片（容器型） */
export const cardStyle: CSSProperties = { padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10 };

/** 可点击卡片（按钮型：整块可点、文字左对齐） */
export const tapCardStyle: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: 14, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10, cursor: 'pointer', color: 'var(--text)' };

/** 列表行（分隔线式） */
export const rowStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 2px', borderBottom: '1px solid var(--surface-2)' };

/** 次要说明文本 */
export const mutedStyle: CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-s)', padding: '4px 2px' };

/**
 * 状态提示行的窄屏版（T02212）：占满整行并允许换行。
 * 公共层的失败提示默认是内联形态，桌面端表单够用；移动端 360px 宽下
 * 「失败原因 + 过期标注 + 重试按钮」一行放不下，被裁掉就等于没有提示。
 * `boxSizing:border-box` 是实测出来的必需项：提示件常带左右内边距贴边排版，
 * content-box 下 `width:100%` 会变成「容器宽 + 内边距」，正好把页面顶出横向滚动。
 */
export const wideHintStyle: CSSProperties = { width: '100%', flexWrap: 'wrap', boxSizing: 'border-box' };

/**
 * PM-302 ①：徽标单源在 `ui/Badge.tsx`（样式常量在 `ui/primitives.ts`）。
 * 移动端保留同名导出只是为了不动十来个调用点；实现已改为转发，不再自带一份配色。
 */
export type { BadgeTone } from '../ui/primitives';
export { Badge } from '../ui/Badge';

/** 半屏抽屉基元：底部滑入的半屏面板（后续队列半操作/详情抽屉复用）。
 *  遮罩点击 / Esc 关闭；挂载于普通文档流外（fixed），打开时才渲染。
 *  结构注意：遮罩与 dialog 必须平级——若 dialog 处于 aria-hidden 遮罩内部，
 *  整个抽屉会被无障碍树剔除（T01423 实测）。 */
export function HalfSheet({ open, title, onClose, children }: Readonly<{ open: boolean; title?: string; onClose: () => void; children: ReactNode }>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: DRAWER_Z.halfSheet }}>
      {/* 遮罩：纯装饰层（aria-hidden），点击关闭为鼠标便捷通路 */}
      <div
        aria-hidden="true"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={OVERLAY_MASK}
      />
      <dialog
        open
        aria-modal="true"
        aria-label={title}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '62%', overflowY: 'auto', background: 'var(--card-bg)', color: 'var(--text)', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 14, boxSizing: 'border-box', animation: 'sheet-up 220ms ease-in-out', border: 'none', margin: 0 }}
      >
        {title && <div style={{ fontWeight: 600, fontSize: 'var(--fs-xl)', marginBottom: 10 }}>{title}</div>}
        {children}
      </dialog>
      <style>{'@keyframes sheet-up { from { transform: translateY(40%); opacity: .4 } to { transform: translateY(0); opacity: 1 } }'}</style>
    </div>
  );
}

// ---------- T01430：下拉刷新与骨架屏公共组件 ----------

/** 下拉刷新容器：顶部下拉超过阈值（55px）触发 onRefresh；指示器内建。
 *  内部滚动，外层不再需要 overflowY。 */
export function PullRefresh({ onRefresh, children }: Readonly<{ onRefresh: () => Promise<void> | void; children: ReactNode }>) {
  const [pullY, setPullY] = useState(0);
  const startY = useRef<number | null>(null);
  const refreshing = useRef(false);

  function onTouchStart(e: React.TouchEvent) { startY.current = e.touches[0].clientY; }
  function onTouchMove(e: React.TouchEvent) {
    if (startY.current == null || (e.currentTarget as HTMLElement).scrollTop > 0) { setPullY(0); return; }
    const d = e.touches[0].clientY - startY.current;
    if (d > 0) setPullY(Math.min(d, 70));
  }
  async function onTouchEnd() {
    const hit = pullY > 55;
    startY.current = null;
    setPullY(0);
    if (hit && !refreshing.current) {
      refreshing.current = true;
      try { await onRefresh(); } catch (e) { console.warn('[PullRefresh] 刷新失败', e); } finally { refreshing.current = false; } // 评审修复：不再吞错到不可见
    }
  }

  return (
    <div
      style={{ flex: 1, overflowY: 'auto', position: 'relative', transition: pullY ? 'none' : 'transform .15s ease' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {pullY > 10 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)', padding: 6 }}>{pullY > 55 ? '释放刷新…' : '下拉刷新'}</div>}
      {children}
    </div>
  );
}

/** 骨架屏：弱网初载占位（行式），样式全部走 CSS 变量。
 *  M6-6.3：占位行键取自模块级常量数组（map 回调不出现索引变量，规避 S6479） */
const SKEL_KEYS = Array.from({ length: 24 }, (_, i) => `skel-${i}`);
export function Skeleton({ rows = 3, card = false }: Readonly<{ rows?: number; card?: boolean }>) {
  return (
    <div aria-hidden="true">
      <style>{'@keyframes mtask-skel { 0%, 100% { opacity: .4 } 50% { opacity: .85 } }'}</style>
      {SKEL_KEYS.slice(0, rows).map((k, i) => (
        <div
          key={k}
          style={{
            height: card ? 64 : 44,
            borderRadius: 10,
            marginBottom: 10,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            animation: 'mtask-skel 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

// ---------- T01444：空态与引导统一 ----------
registerDict('en', {
  '还没有待办': 'No to-dos yet', '暂无执行会话': 'No exec sessions', '暂无队列': 'No queues',
  '该队列暂无 Job': 'No jobs in this queue', '该分类下暂无提示词': 'No prompts in this category',
  '暂无 AI 工具': 'No AI tools', '暂无归档任务': 'No archived tasks', '暂无可用模板': 'No templates available',
  '开始随手记': 'Start quick note', '没有需要关注的任务了': 'Nothing needs attention',
});

/**
 * 空态统一组件：图标 + 一句话（i18n）+ 可选行动按钮。
 * T03655：icon 收 ReactNode（lucide 组件），不再接受 emoji 字符——emoji 随系统字体变样且不可着色，
 * 与 REQ-027 §3.5「图标统一 lucide」相悖；未传时用 FileText 兜底。
 */
export function EmptyState({ icon, message, hint, actionLabel, onAction }: Readonly<{
  icon?: ReactNode; message: string; hint?: string; actionLabel?: string; onAction?: () => void;
}>) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ color: 'var(--text-muted)' }} aria-hidden="true">{icon ?? <FileText size={32} />}</div>
      <div style={{ fontSize: 'var(--fs-l)', color: 'var(--text-secondary)' }}>{t(message, message)}</div>
      {hint && <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>{hint}</div>}
      {actionLabel && onAction && (
        <button onClick={onAction} style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 20, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-l)' }}>
          {t(actionLabel, actionLabel)}
        </button>
      )}
    </div>
  );
}
