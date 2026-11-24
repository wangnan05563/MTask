import { CopyPlus, Save, Trash2 } from 'lucide-react';
import type { SavedView } from '../api/client';

/**
 * T06303（REQ-009 / PRD §B1）：保存视图选择与维护入口。
 *
 * 只做受控展示，命名/共享范围确认由页面用统一 askInput/askConfirm 收口；
 * 保持一个 select + 三个图标按钮，避免在工具条里再叠弹层。
 */
export function SavedViewMenu({
  views, activeId, busy, disabled, onSelect, onSave, onCopy, onDelete,
}: {
  readonly views: SavedView[];
  readonly activeId: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onSave: () => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}) {
  const active = views.find((v) => v.id === activeId);
  const blocked = Boolean(busy || disabled);
  return (
    <span data-t06303="saved-view-menu" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <select
        data-t06303="saved-view-select"
        aria-label="保存视图"
        title={active ? `当前视图：${active.name}（${active.visibility === 'project' ? '项目共享' : '私有'}）` : '选择已保存的视图'}
        value={activeId}
        disabled={blocked || views.length === 0}
        onChange={(e) => onSelect(e.target.value)}
        style={{ fontSize: 'var(--fs-s)', padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 170, minWidth: 110, opacity: blocked ? 0.55 : 1 }}
      >
        <option value="">{views.length === 0 ? '暂无保存视图' : '选择视图…'}</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>{`${v.name}${v.visibility === 'project' ? ' · 共享' : ''}`}</option>
        ))}
      </select>
      <button type="button" className="tbtn-anim" onClick={onSave} disabled={blocked}
        title={disabled ? '请先选择具体项目再保存视图' : '保存当前筛选/排序/视图为视图'}
        aria-label="保存当前视图"
        style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 6px', borderRadius: 6, cursor: blocked ? 'not-allowed' : 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', opacity: blocked ? 0.55 : 1 }}>
        <Save size={14} />
      </button>
      <button type="button" className="tbtn-anim" onClick={onCopy} disabled={blocked || !activeId}
        title={active ? `复制「${active.name}」` : '先选择一个视图再复制'}
        aria-label="复制当前视图"
        style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 6px', borderRadius: 6, cursor: blocked || !activeId ? 'not-allowed' : 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', opacity: blocked || !activeId ? 0.55 : 1 }}>
        <CopyPlus size={14} />
      </button>
      <button type="button" className="tbtn-anim" onClick={onDelete} disabled={blocked || !activeId}
        title={active ? `删除「${active.name}」` : '先选择一个视图再删除'}
        aria-label="删除当前视图"
        style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 6px', borderRadius: 6, cursor: blocked || !activeId ? 'not-allowed' : 'pointer', border: '1px solid var(--danger)', background: 'var(--card-bg)', color: 'var(--danger)', opacity: blocked || !activeId ? 0.55 : 1 }}>
        <Trash2 size={14} />
      </button>
    </span>
  );
}
