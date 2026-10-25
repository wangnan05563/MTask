import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { Project } from '../api/client';

/**
 * T02165：项目范围多选器（原实现内联在 `ReportPage.tsx`）。
 *
 * T02857（六期 S6）把它提到 ui 层：阶段性总结汇报 PPT 面板需要「本卡片另选项目」的覆盖开关，
 * PRD FR-2.2 明确要求复用同一个勾选器，而不是在面板里再造一套（评审 I1）。
 * 行为与视觉逐字保持：未勾选 = 全部项目；勾选顺序即后端分块顺序（序号徽标可见）；
 * 到上限时未勾选项置灰而非静默失效。
 */

/**
 * 一次聚合的项目数上限——与 server `REPORT_PROJECT_MAX` 同值。
 * 前端用它把超限的复选项置灰，后端仍是最终裁决（直接打接口时返回可读 400）。
 */
export const REPORT_PROJECT_MAX = 8;

/**
 * 范围摘要文案：0 个=全部项目，1 个=项目名，多个=「A + B 等 N 个项目」。
 * T02165：多选器、生成按钮文案、AI 控制台回显共用一份，避免三处各写一种范围写法。
 */
export function scopeSummary(names: string[]): string {
  if (names.length === 0) return '全部项目';
  if (names.length === 1) return names[0];
  return `${names[0]} + ${names[1]}${names.length > 2 ? ` 等 ${names.length} 个项目` : ''}`;
}

/** 勾选顺序即报表里的项目分块顺序，序号徽标让它可见（后端按同一顺序聚合） */
const scopeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-m)', minWidth: 0 };

/** 触发钮样式：与报表页其余字段控件同口径（原 ReportPage 的 fieldStyle） */
const pickerFieldStyle: CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)' };

export function ProjectScopePicker({ projects, value, onChange }: {
  readonly projects: Project[];
  readonly value: string[];
  readonly onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const summary = scopeSummary(value.map(nameOf));

  function toggle(id: string) {
    // 取消勾选直接移出；新增受 REPORT_PROJECT_MAX 约束（面板已满时该项置灰，见 disabled）
    if (value.includes(id)) { onChange(value.filter((x) => x !== id)); return; }
    if (value.length >= REPORT_PROJECT_MAX) return;
    onChange([...value, id]);
  }

  return (
    <div ref={hostRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`项目范围：${value.length ? summary : '全部项目（不限范围）'} — 可勾选 2~${REPORT_PROJECT_MAX} 个项目聚合生成`}
        aria-label="项目范围：选择要聚合的项目（多选）"
        aria-expanded={open}
        style={{ ...pickerFieldStyle, display: 'flex', alignItems: 'center', gap: 6, width: '100%', maxWidth: '100%', minWidth: 0, cursor: 'pointer', textAlign: 'left', boxSizing: 'border-box' }}
      >
        <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span style={{ flex: '1 1 auto' }} />
        <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{value.length ? `${value.length}/${REPORT_PROJECT_MAX}` : '不限'}</span>
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 30, boxSizing: 'border-box',
          minWidth: 240, maxWidth: 'min(360px, calc(100vw - 24px))', maxHeight: 280, overflowY: 'auto',
          border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--card-bg)',
          color: 'var(--text)', boxShadow: '0 6px 18px rgba(0,0,0,.14)', padding: 6,
        }}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => onChange([])}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange([]); } }}
            style={{ ...scopeRowStyle, color: value.length === 0 ? 'var(--accent)' : 'var(--text-muted)', fontWeight: value.length === 0 ? 600 : 400 }}
          >
            <X size={12} style={{ flexShrink: 0 }} />
            <span>全部项目（不限范围）</span>
          </div>
          {projects.map((p) => {
            const idx = value.indexOf(p.id);
            const checked = idx >= 0;
            // 已达上限时未勾选项置灰而非静默失效（后端同上限会 400，前端提前拦住更直观）
            const blocked = !checked && value.length >= REPORT_PROJECT_MAX;
            return (
              <label key={p.id} style={{ ...scopeRowStyle, opacity: blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}>
                <input type="checkbox" checked={checked} disabled={blocked} onChange={() => toggle(p.id)}
                  aria-label={`纳入项目 ${p.name}`} style={{ flexShrink: 0, cursor: 'pointer' }} />
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {checked && (
                  <span title="勾选顺序（报表按此顺序分块）" style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--accent)' }}>{idx + 1}</span>
                )}
              </label>
            );
          })}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '4px 6px 0' }}>
            {value.length === 0 ? '未勾选任何项目：按全部项目聚合（与单选「全部项目」一致）'
              : `已选 ${value.length} 个，最多 ${REPORT_PROJECT_MAX} 个；报表头部与 AI 提示会标注该范围`}
          </div>
        </div>
      )}
    </div>
  );
}
