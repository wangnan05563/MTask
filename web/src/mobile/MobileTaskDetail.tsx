/**
 * T01423（mtask三期 2.2）：任务详情半屏抽屉。
 * 展示：标题/状态/优先级/分类/描述/处理结果/AI 摘要/时间线/图片附件；
 * 编辑：描述、处理结果（回传）可在抽屉内就地编辑；操作：完成（回退）、搁置（恢复）。
 * 与桌面端 TaskDetailDrawer（T01562）功能对齐——移动端用 HalfSheet 半屏承载（T01563 增强）。
 * 基于 ui.tsx 的 HalfSheet 基元（T01422 组件规范化基础层）。
 */
import { useState } from 'react';
import { api, imageUrl, type Task, type TaskCategory } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { Badge, HalfSheet, type BadgeTone } from './ui';
import { TaskEventTimeline } from '../components/TaskEventTimeline';

const PRIO_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
const PRIO_TONE: Record<string, BadgeTone> = { urgent: 'danger', high: 'accent', normal: 'neutral', low: 'neutral' };
const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };

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
  if (!task) return null;

  const catName = categories.find((c) => c.id === task.category_id)?.name ?? '';
  const done = task.status === 'done';

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
        await api.patch(`/tasks/${task!.id}`, { description: descDraft });
        notify('描述已保存');
      } else {
        await api.patch(`/tasks/${task!.id}`, { handleResult: resultDraft });
        notify('处理结果已回传');
      }
      setEditing(null);
      onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally { setSaveBusy(false); }
  }

  const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };
  // T01563：可折叠段头（summary 用 flex 布局后 Chromium 会隐藏原生 disclosure marker，故自绘 ▸ 并随 open 旋转）
  const summaryStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', listStyle: 'none', fontSize: labelStyle.fontSize, color: labelStyle.color, padding: '2px 0' };
  const opBtn: React.CSSProperties = { flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '10px 0', borderRadius: 10, fontSize: 14, cursor: busy ? 'wait' : 'pointer', border: '1px solid var(--border-strong)' };

  return (
    <HalfSheet open title="任务详情" onClose={onClose}>
      <style>{`.hs-caret{display:inline-block;margin-right:5px;color:var(--accent);transition:transform .18s ease}details[open]>summary .hs-caret{transform:rotate(90deg)}`}</style>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>{task.title}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone={done ? 'success' : 'accent'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <Badge tone={PRIO_TONE[task.priority] ?? 'neutral'}>{PRIO_LABEL[task.priority] ?? task.priority}</Badge>
        {catName && <Badge>{catName}</Badge>}
        {task.pinned && <Badge tone="accent">📌 置顶</Badge>}
      </div>
      {/* 描述：可折叠段 + 就地编辑（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <details open style={{ marginTop: 10 }}>
        <summary style={summaryStyle}>
          <span><span className="hs-caret">▸</span>描述</span>
          {editing !== 'desc' && (
            <button onClick={(e) => { e.preventDefault(); setDescDraft(task.description ?? ''); setEditing('desc'); }} disabled={busy || saveBusy}
              style={{ fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>编辑</button>
          )}
        </summary>
        {editing === 'desc' ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              rows={5}
              aria-label="编辑任务描述"
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setEditing(null)} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: saveBusy ? 'default' : 'pointer' }}>取消</button>
              <button onClick={() => void saveField('desc')} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: saveBusy ? 'default' : 'pointer' }}>{saveBusy ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : (
          task.description ? <MarkdownContent content={task.description} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>（无描述）</div>
        )}
      </details>
      {/* 处理结果：可折叠段 + 就地回传（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <details open style={{ marginTop: 12 }}>
        <summary style={summaryStyle}>
          <span><span className="hs-caret">▸</span>处理结果</span>
          {editing !== 'result' && (
            <button onClick={(e) => { e.preventDefault(); setResultDraft(task.handle_result ?? ''); setEditing('result'); }} disabled={busy || saveBusy}
              style={{ fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>{task.handle_result ? '编辑' : '回传'}</button>
          )}
        </summary>
        {editing === 'result' ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={resultDraft}
              onChange={(e) => setResultDraft(e.target.value)}
              rows={5}
              aria-label="编辑/回传处理结果"
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setEditing(null)} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: saveBusy ? 'default' : 'pointer' }}>取消</button>
              <button onClick={() => void saveField('result')} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: saveBusy ? 'default' : 'pointer' }}>{saveBusy ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : (
          task.handle_result ? <MarkdownContent content={task.handle_result} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>（暂无处理结果，AI 分析结论将回写于此）</div>
        )}
      </details>
      {/* AI 摘要：可折叠段（默认收起，窄屏不挤占正文；与桌面一致但同样可展开查看） */}
      {task.ai_summary && (
        <details style={{ marginTop: 12 }}>
          <summary style={summaryStyle}>
            <span><span className="hs-caret">▸</span>AI 摘要</span>
          </summary>
          <div style={{ marginTop: 2 }}><MarkdownContent content={task.ai_summary} /></div>
        </details>
      )}
      {/* T01442：状态流转时间线（最近事件自动记录，与桌面端同源） */}
      <TaskEventTimeline taskId={task.id} />
      {task.images.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={labelStyle}>附件（{task.images.length}）</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.images.map((img) => (
              <img key={img.id} src={imageUrl(img.id)} alt="任务截图" style={{ height: 88, borderRadius: 8, border: '1px solid var(--border)' }} />
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button disabled={busy} onClick={() => void act(() => api.patch(`/tasks/${task.id}`, { status: done ? 'todo' : 'done' }), done ? '已回退到待办' : '已完成')}
          style={{ ...opBtn, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none' }}>
          {done ? '↩ 回退待办' : '✓ 标记完成'}
        </button>
        <button disabled={busy} onClick={() => void act(() => api.post(`/tasks/${task.id}/shelve`, { shelved: !task.shelved }), task.shelved ? '已恢复' : '已搁置——AI 处理待办时自动忽略')}
          style={{ ...opBtn, background: 'var(--surface-2)', color: 'var(--text)' }}>
          {task.shelved ? '恢复' : '搁置'}
        </button>
      </div>
    </HalfSheet>
  );
}
