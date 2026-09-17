import { useEffect, useState } from 'react';
import { Check, Compass, X, type LucideIcon } from 'lucide-react';

/**
 * T00706：通用页面使用向导基础设施。
 * 参考项目管理向导（T00665，ProjectGuide.tsx）的交互与视觉，抽取为可复用组件：
 * - PageGuideDialog：通用向导弹窗（步骤指示 / 上一步 / 下一步 / 跳过 / 开始体验）；
 * - hasSeenGuide / markGuideSeen：按 seenKey 的已读状态（localStorage，清缓存恢复初始引导）；
 * - 各菜单的向导「内容」（步骤文案与演示视觉）集中在 guides.tsx 配置，本组件只管壳。
 */

export interface GuideStep {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly desc: string;
  readonly points: readonly string[];
  /** 可选演示视觉（任意 ReactNode；留空则不渲染演示区） */
  readonly visual?: React.ReactNode;
}

/** 已读状态（localStorage；隐私模式读取失败按「已看过」处理，不打扰用户） */
export const hasSeenGuide = (seenKey: string): boolean => {
  try { return localStorage.getItem(seenKey) === '1'; } catch { return true; }
};

export const markGuideSeen = (seenKey: string): void => {
  try { localStorage.setItem(seenKey, '1'); } catch { /* 忽略存储失败（隐私模式） */ }
};

/**
 * 通用向导弹窗：视觉与交互对齐 ProjectGuideDialog（T00665 基准）——
 * 遮罩点击 / Escape / 关闭按钮均视为「跳过并记住」；移动端宽度 min(560px, 92vw)。
 */
export function PageGuideDialog({ open, onClose, title, steps }: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 弹窗标题（如「任务 · 使用向导」） */
  readonly title: string;
  readonly steps: readonly GuideStep[];
}) {
  const [step, setStep] = useState(0);
  useEffect(() => { if (open) setStep(0); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || steps.length === 0) return null;
  const cur = steps[step];
  const Icon = cur.icon;
  const last = step === steps.length - 1;
  const finish = () => onClose();

  return (
    <div /* NOSONAR - 遮罩点击为鼠标便捷关闭，关闭按钮提供键盘可达通路 */
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay, rgba(0,0,0,.45))', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      onClick={(e) => { if (e.target === e.currentTarget) finish(); }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ background: 'var(--card-bg)', borderRadius: 10, width: 'min(560px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,.22)' }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <Compass size={16} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 14 }}>{title}</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{step + 1} / {steps.length}</span>
          <span style={{ flex: 1 }} />
          <button onClick={finish} title="关闭向导（不再自动弹出）" aria-label="关闭向导"
            style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '2px 6px' }}>
            <X size={13} />
          </button>
        </div>

        {/* 步骤指示 */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 14px 0' }}>
          {steps.map((s, i) => (
            <button key={s.title} onClick={() => setStep(i)} title={s.title} aria-label={`第 ${i + 1} 步：${s.title}`}
              style={{ flex: 1, height: 4, border: 'none', borderRadius: 2, cursor: 'pointer', background: i <= step ? 'var(--accent)' : 'var(--border-strong)', transition: 'background .2s ease' }} />
          ))}
        </div>

        {/* 内容 */}
        <div style={{ padding: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Icon size={16} style={{ color: 'var(--accent)' }} />
            <strong style={{ fontSize: 14 }}>{cur.title}</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{cur.desc}</div>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, color: 'var(--text)' }}>
            {cur.points.map((p) => <li key={p} style={{ marginBottom: 4 }}>{p}</li>)}
          </ul>
          {cur.visual}
        </div>

        {/* 底部操作 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <button onClick={finish} title="跳过向导（记录已看状态，不再自动弹出）" aria-label="跳过向导"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12 }}>跳过</button>
          <span style={{ flex: 1 }} />
          <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="tbtn-anim"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: step === 0 ? 'default' : 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12, opacity: step === 0 ? .5 : 1 }}>上一步</button>
          {last
            ? <button onClick={finish} className="tbtn-anim" title="开始体验 — 关闭向导并记住已看过" aria-label="开始体验"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
              <Check size={13} /> 开始体验
            </button>
            : <button onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))} className="tbtn-anim"
              style={{ padding: '5px 14px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>下一步</button>}
        </div>
      </div>
    </div>
  );
}
