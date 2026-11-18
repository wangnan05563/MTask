import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * T06019：设置子页的「说明图标」——原顶部纯文本说明改为语义图标，
 * 悬浮/聚焦/点击时再展开说明文字，保持页面首屏简洁。
 *
 * 视觉基准对齐「循环任务」页的说明入口：单行、圆角、轻边框；
 * 图标沿用该页签在 settingsTabs.ts 中已配置的语义图标。
 */
export function SettingsHelpIcon({
  icon: Icon,
  label,
  description,
  ariaDescription,
}: {
  icon: LucideIcon;
  label: string;
  description: ReactNode;
  /** 供 aria-label 使用的纯文本版本（description 含 JSX 时传入） */
  ariaDescription?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-help-wrap" data-t06019="help">
      <button
        type="button"
        className="settings-help-btn"
        aria-label={`${label}：${ariaDescription ?? label}`}
        aria-expanded={open}
        aria-haspopup="true"
        title={ariaDescription}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
      >
        <Icon size={15} aria-hidden="true" />
      </button>
      <div className={`settings-help-tip${open ? ' is-open' : ''}`} role="tooltip">
        {description}
      </div>
      <style>{`
        .settings-help-wrap { position: relative; display: inline-flex; align-items: center; }
        .settings-help-btn {
          width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
          padding: 0; border: 1px solid var(--border-strong); border-radius: 999px;
          background: var(--card-bg); color: var(--text-secondary); cursor: pointer;
          transition: background .16s ease, border-color .16s ease, color .16s ease, transform .16s ease;
        }
        button.settings-help-btn:hover:not(:disabled) {
          background: var(--accent-soft, rgba(9,105,218,.10)); border-color: var(--accent);
          color: var(--accent); transform: translateY(-1px) rotate(0deg) !important;
        }
        button.settings-help-btn:active:not(:disabled) { transform: scale(.96) !important; }
        .settings-help-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .settings-help-tip {
          position: absolute; left: calc(100% + 8px); top: 50%; z-index: 20;
          width: max-content; max-width: min(420px, 70vw); padding: 8px 10px;
          border: 1px solid var(--border); border-radius: 8px;
          background: var(--card-bg); color: var(--text);
          box-shadow: 0 10px 24px rgba(15,23,42,.16);
          font-size: var(--fs-s); line-height: 1.6; text-align: left; white-space: normal;
          opacity: 0; visibility: hidden; transform: translateY(calc(-50% - 3px)); pointer-events: none;
          transition: opacity .16s ease, transform .16s ease, visibility 0s linear .16s;
        }
        .settings-help-wrap:hover .settings-help-tip,
        .settings-help-wrap:focus-within .settings-help-tip,
        .settings-help-tip.is-open {
          opacity: 1; visibility: visible; transform: translateY(-50%);
          transition: opacity .16s ease, transform .16s ease, visibility 0s;
        }
        @media (prefers-reduced-motion: reduce) {
          .settings-help-btn, .settings-help-tip { transition: none; }
          button.settings-help-btn:hover:not(:disabled) { transform: none !important; }
        }
      `}</style>
    </div>
  );
}
