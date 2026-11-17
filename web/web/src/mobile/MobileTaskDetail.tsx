/**
 * T01423（mtask三期 2.2）：任务详情半屏抽屉。
 * 展示：标题/状态/优先级/分类/描述/处理结果/AI 摘要/时间线/图片附件；
 * 编辑：描述、处理结果（回传）可在抽屉内就地编辑；操作：完成（回退）、搁置（恢复）。
 * 与桌面端 TaskDetailDrawer（T01562）功能对齐——移动端用 HalfSheet 半屏承载（T01563 增强）。
 * 基于 ui.tsx 的 HalfSheet 基元（T01422 组件规范化基础层）。
 */
import { useState } from 'react';
import { ChevronRight, Pin } from 'lucide-react'; // T03654：折叠箭头/置顶徽标统一 lucide（.hs-caret 旋转 90° 后即为下箭头）
import { api, imageUrl, type Task, type TaskCategory, type TaskImage } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { ResultDiffPanel } from '../ui/ResultDiff'; // T01698：结果历史 diff/回滚——与桌面抽屉/行内同一组件
import { Badge, HalfSheet } from './ui';
import { priorityBadgeLabel, priorityTone } from '../ui/priority';
import { TaskEventTimeline } from '../components/TaskEventTimeline';

const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };
/* PM-302 ③：优先级色/文案/色调改用 ui/priority.ts 单源 */

const labelStyle: React.CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--text-muted)' };
// T01563：可折叠段头（summary 用 flex 布局后 Chromium 会隐藏原生 disclosure marker，故自绘箭头并随 open 旋转）
const summaryStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', listStyle: 'none', fontSize: labelStyle.fontSize, color: labelStyle.color, padding: '2px 0' };
const opBtn: React.CSSProperties = { flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '10px 0', borderRadius: 10, fontSize: 'var(--fs-l)', border: '1px solid var(--border-strong)' };
const sectionEditBtn: React.CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' };
const textareaStyle: React.CSSProperties = { width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', resize: 'vertical' };
const fieldBtnBase: React.CSSProperties = { flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)' };
const cancelBtnStyle: React.CSSProperties = { ...fieldBtnBase, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)' };
const saveBtnStyle: React.CSSProperties = { ...fieldBtnBase, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)' };
const emptyNoteStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-m)', marginTop: 2 };
const thumbBtnStyle: React.CSSProperties = { padding: 0, background: 'none', border: 'none', cursor: 'pointer', display: 'block', lineHeight: 0, maxWidth: '100%' };
const zoomedImgStyle: React.CSSProperties = { width: '100%', height: 'auto', maxWidth: '100%', objectFit: 'contain' };
const thumbImgStyle: React.CSSProperties = { height: 88, width: 'auto', maxWidth: '100%', objectFit: 'contain' };
const caret = <span className="hs-caret"><ChevronRight size={12} aria-hidden /></span>;

/** 就地编辑区（描述 / 处理结果共用）：文本域 + 取消/保存 */
function FieldEditor({ value, ariaLabel, saveBusy, onChange, onCancel, onSave }: Readonly<{
  value: string;
  ariaLabel: string;
  saveBusy: boolean;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}>) {
  return (
    <div style={{ marginTop: 4 }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        aria-label={ariaLabel}
        style={textareaStyle}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button onClick={onCancel} disabled={saveBusy}
          style={{ ...cancelBtnStyle, cursor: saveBusy ? 'default' : 'pointer' }}>取消</button>
        <button onClick={onSave} disabled={saveBusy}
          style={{ ...saveBtnStyle, cursor: saveBusy ? 'default' : 'pointer' }}>{saveBusy ? '保存中…' : '保存'}</button>
      </div>
    </div>
  );
}

/** 描述段：可折叠 + 就地编辑（与桌面 TaskDetailDrawer 对齐） */
function DescSection({ description, editing, draft, busy, saveBusy, onStart, onDraft, onCancel, onSave }: Readonly<{
  description: string;
  editing: boolean;
  draft: string;
  busy: boolean;
  saveBusy: boolean;
  onStart: () => void;
  onDraft: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}>) {
  let body: React.ReactNode;
  if (editing) {
    body = <FieldEditor value={draft} ariaLabel="编辑任务描述" saveBusy={saveBusy} onChange={onDraft} onCancel={onCancel} onSave={onSave} />;
  } else if (description) {
    body = <MarkdownContent content={description} />;
  } else {
    body = <div style={emptyNoteStyle}>（无描述）</div>;
  }
  return (
    <details open style={{ marginTop: 10 }}>
      <summary style={summaryStyle}>
        <span>{caret}描述</span>
        {!editing && (
          <button onClick={(e) => { e.preventDefault(); onStart(); }} disabled={busy || saveBusy}
            style={sectionEditBtn}>编辑</button>
        )}
      </summary>
      {body}
    </details>
  );
}

/** 处理结果段：可折叠 + 就地回传 + 历史 diff/回滚 */
function ResultSection({ taskNo, handleResult, editing, draft, busy, saveBusy, onStart, onDraft, onCancel, onSave, onRollback }: Readonly<{
  taskNo: string | null;
  handleResult: string | null;
  editing: boolean;
  draft: string;
  busy: boolean;
  saveBusy: boolean;
  onStart: () => void;
  onDraft: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onRollback: (next?: string) => void;
}>) {
  let body: React.ReactNode;
  if (editing) {
    body = <FieldEditor value={draft} ariaLabel="编辑/回传处理结果" saveBusy={saveBusy} onChange={onDraft} onCancel={onCancel} onSave={onSave} />;
  } else {
    body = (
      <div>
        {handleResult ? <MarkdownContent content={handleResult} /> : <div style={emptyNoteStyle}>（暂无处理结果，AI 分析结论将回写于此）</div>}
        {/* T01698：结果历史 diff/回滚——与桌面抽屉/行内同一组件（T01607）；渲染只看 task_no 不看正文
            （回滚到「空正文」版本时面板仍在，否则失去再滚回来的入口）。半屏无缩进 indent=0。 */}
        {taskNo && (
          <ResultDiffPanel
            taskNo={taskNo}
            current={handleResult ?? ''}
            indent={0}
            onRollback={onRollback}
          />
        )}
      </div>
    );
  }
  return (
    <details open style={{ marginTop: 12 }}>
      <summary style={summaryStyle}>
        <span>{caret}处理结果</span>
        {!editing && (
          <button onClick={(e) => { e.preventDefault(); onStart(); }} disabled={busy || saveBusy}
            style={sectionEditBtn}>{handleResult ? '编辑' : '回传'}</button>
        )}
      </summary>
      {body}
    </details>
  );
}

/** 附件缩略图：点击原位放大/收起（T01572） */
function TaskImages({ images, previewId, onToggle }: Readonly<{
  images: TaskImage[];
  previewId: string;
  onToggle: (id: string) => void;
}>) {
  if (images.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={labelStyle}>附件（{images.length}）{previewId ? ' · 已放大，再点同一张收起' : ''}</div>
      {/* T01572：补齐与桌面抽屉的最后一处不一致——缩略图点击放大（原位切换尺寸，不用 window.open / showModal，
          那两者在 Electron 渲染层不可用且会盖住半屏）。放大态 width:100% 撑满半屏内容区、height:auto 保原比例，
          仍受 HalfSheet 的 maxHeight 62% + overflowY:auto 约束（可纵向滚动，不撑破视口、不横向溢出）。 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {images.map((img) => {
          const zoomed = previewId === img.id;
          return (
            <button
              key={img.id}
              type="button"
              onClick={() => onToggle(img.id)}
              title="放大预览 — 点击放大或收起截图"
              aria-label={zoomed ? '收起截图：点击收起放大预览' : '任务截图：点击放大预览'}
              // 放大态撑满一行：按钮是 flex 项（基准=内容宽），img 的 width:100% 缺确定基准会退回原始尺寸（与桌面抽屉同因）
              style={{ ...thumbBtnStyle, ...(zoomed ? { width: '100%' } : {}) }}
            >
              <img
                src={imageUrl(img.id)}
                alt="任务截图"
                style={{
                  // 放大态：撑满内容区、高度自适应原比例（height:'100%' 在 auto 高度父级下会退回原始尺寸）
                  ...(zoomed ? zoomedImgStyle : thumbImgStyle),
                  borderRadius: 8,
                  border: zoomed ? '2px solid var(--accent)' : '1px solid var(--border)',
                  display: 'block',
                  cursor: 'zoom-in',
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 底部操作：完成/回退、搁置/恢复 */
function ActionRow({ done, shelved, busy, onToggleStatus, onToggleShelve }: Readonly<{
  done: boolean;
  shelved: boolean | undefined;
  busy: boolean;
  onToggleStatus: () => void;
  onToggleShelve: () => void;
}>) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
      <button disabled={busy} onClick={onToggleStatus}
        style={{ ...opBtn, cursor: busy ? 'wait' : 'pointer', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none' }}>
        {done ? '↩ 回退待办' : '✓ 标记完成'}
      </button>
      <button disabled={busy} onClick={onToggleShelve}
        style={{ ...opBtn, cursor: busy ? 'wait' : 'pointer', background: 'var(--surface-2)', color: 'var(--text)' }}>
        {shelved ? '恢复' : '搁置'}
      </button>
    </div>
  );
}

export function MobileTaskDetail({ task, categories, onClose, onChanged, notify }: {
  readonly task: Task | null;
  readonly categories: TaskCategory[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly notify: (msg: string, isErr?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  // T01563：移动端就地编辑态（与桌面 TaskDetailDrawer 对齐）——描述 / 处理结果可编辑
  const [editing, setEditing] = useState<null | 'desc' | 'result'>(null);
  const [descDraft, setDescDraft] = useState('');
  const [resultDraft, setResultDraft] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  // T01572：附件点击放大态（与桌面 TaskDetailDrawer 同口径——previewId 记录当前放大的图，点同图收起）
  const [previewId, setPreviewId] = useState('');
  if (!task) return null;

  // 参数窄化不穿透到下方闭包，闭包内统一用这个已窄化的引用
  const current = task;
  const catName = categories.find((c) => c.id === current.category_id)?.name ?? '';
  const done = current.status === 'done';

  async function act(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await fn();
      notify(okMsg);
      onChanged();
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally { setBusy(false); }
  }

  // T01563：保存描述 / 处理结果（与桌面抽屉共用同一回传通道 api.patch）
  async function saveField(kind: 'desc' | 'result') {
    setSaveBusy(true);
    try {
      if (kind === 'desc') {
        await api.patch(`/tasks/${current.id}`, { description: descDraft });
        notify('描述已保存');
      } else {
        await api.patch(`/tasks/${current.id}`, { handleResult: resultDraft });
        notify('处理结果已回传');
      }
      setEditing(null);
      onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally { setSaveBusy(false); }
  }

  function startEdit(kind: 'desc' | 'result') {
    if (kind === 'desc') setDescDraft(current.description ?? '');
    else setResultDraft(current.handle_result ?? '');
    setEditing(kind);
  }

  // 回滚成功：草稿镜像同步（下次进入编辑态基于回滚后文本），并通知父级重拉列表刷新 task prop
  function handleRollback(next?: string) {
    if (next !== undefined) setResultDraft(next);
    onChanged();
  }

  function togglePreview(id: string) {
    setPreviewId((p) => (p === id ? '' : id));
  }

  return (
    <HalfSheet open title="任务详情" onClose={onClose}>
      <style>{`.hs-caret{display:inline-block;margin-right:5px;color:var(--accent);transition:transform .18s ease}details[open]>summary .hs-caret{transform:rotate(90deg)}`}</style>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>{current.title}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone={done ? 'success' : 'accent'}>{STATUS_LABEL[current.status] ?? current.status}</Badge>
        <Badge tone={priorityTone(current.priority)}>{priorityBadgeLabel(current.priority)}</Badge>
        {catName && <Badge>{catName}</Badge>}
        {current.pinned && <Badge tone="accent"><Pin size={12} aria-hidden /> 置顶</Badge>}
      </div>
      {/* 描述：可折叠段 + 就地编辑（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <DescSection
        description={current.description}
        editing={editing === 'desc'}
        draft={descDraft}
        busy={busy}
        saveBusy={saveBusy}
        onStart={() => startEdit('desc')}
        onDraft={setDescDraft}
        onCancel={() => setEditing(null)}
        onSave={() => void saveField('desc')}
      />
      {/* 处理结果：可折叠段 + 就地回传（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <ResultSection
        taskNo={current.task_no}
        handleResult={current.handle_result}
        editing={editing === 'result'}
        draft={resultDraft}
        busy={busy}
        saveBusy={saveBusy}
        onStart={() => startEdit('result')}
        onDraft={setResultDraft}
        onCancel={() => setEditing(null)}
        onSave={() => void saveField('result')}
        onRollback={handleRollback}
      />
      {/* AI 摘要：可折叠段（默认收起，窄屏不挤占正文；与桌面一致但同样可展开查看） */}
      {current.ai_summary && (
        <details style={{ marginTop: 12 }}>
          <summary style={summaryStyle}>
            <span>{caret}AI 摘要</span>
          </summary>
          <div style={{ marginTop: 2 }}><MarkdownContent content={current.ai_summary} /></div>
        </details>
      )}
      {/* T01442：状态流转时间线（最近事件自动记录，与桌面端同源） */}
      <TaskEventTimeline taskId={current.id} />
      <TaskImages images={current.images} previewId={previewId} onToggle={togglePreview} />
      <ActionRow
        done={done}
        shelved={current.shelved}
        busy={busy}
        onToggleStatus={() => void act(() => api.patch(`/tasks/${current.id}`, { status: done ? 'todo' : 'done' }), done ? '已回退到待办' : '已完成')}
        onToggleShelve={() => void act(() => api.post(`/tasks/${current.id}/shelve`, { shelved: !current.shelved }), current.shelved ? '已恢复' : '已搁置——AI 处理待办时自动忽略')}
      />
    </HalfSheet>
  );
}
