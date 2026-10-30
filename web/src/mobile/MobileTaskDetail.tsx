/**
 * T01423（mtask三期 2.2）：任务详情半屏抽屉。
 * 展示：标题/状态/优先级/分类/描述/处理结果/AI 摘要/时间线/图片附件；
 * 编辑：描述、处理结果（回传）可在抽屉内就地编辑；操作：完成（回退）、搁置（恢复）。
 * 与桌面端 TaskDetailDrawer（T01562）功能对齐——移动端用 HalfSheet 半屏承载（T01563 增强）。
 * 基于 ui.tsx 的 HalfSheet 基元（T01422 组件规范化基础层）。
 */
import { useState } from 'react';
import { ChevronRight, Pin } from 'lucide-react'; // T03654：折叠箭头/置顶徽标统一 lucide（.hs-caret 旋转 90° 后即为下箭头）
import { api, imageUrl, type Task, type TaskCategory } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { ResultDiffPanel } from '../ui/ResultDiff'; // T01698：结果历史 diff/回滚——与桌面抽屉/行内同一组件
import { Badge, HalfSheet } from './ui';
import { priorityBadgeLabel, priorityTone } from '../ui/priority';
import { TaskEventTimeline } from '../components/TaskEventTimeline';

const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };
/* PM-302 ③：优先级色/文案/色调改用 ui/priority.ts 单源 */

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

  const labelStyle: React.CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--text-muted)' };
  // T01563：可折叠段头（summary 用 flex 布局后 Chromium 会隐藏原生 disclosure marker，故自绘箭头并随 open 旋转）
  const summaryStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', listStyle: 'none', fontSize: labelStyle.fontSize, color: labelStyle.color, padding: '2px 0' };
  const opBtn: React.CSSProperties = { flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '10px 0', borderRadius: 10, fontSize: 'var(--fs-l)', cursor: busy ? 'wait' : 'pointer', border: '1px solid var(--border-strong)' };

  return (
    <HalfSheet open title="任务详情" onClose={onClose}>
      <style>{`.hs-caret{display:inline-block;margin-right:5px;color:var(--accent);transition:transform .18s ease}details[open]>summary .hs-caret{transform:rotate(90deg)}`}</style>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>{task.title}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone={done ? 'success' : 'accent'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <Badge tone={priorityTone(task.priority)}>{priorityBadgeLabel(task.priority)}</Badge>
        {catName && <Badge>{catName}</Badge>}
        {task.pinned && <Badge tone="accent"><Pin size={12} aria-hidden /> 置顶</Badge>}
      </div>
      {/* 描述：可折叠段 + 就地编辑（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <details open style={{ marginTop: 10 }}>
        <summary style={summaryStyle}>
          <span><span className="hs-caret"><ChevronRight size={12} aria-hidden /></span>描述</span>
          {editing !== 'desc' && (
            <button onClick={(e) => { e.preventDefault(); setDescDraft(task.description ?? ''); setEditing('desc'); }} disabled={busy || saveBusy}
              style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>编辑</button>
          )}
        </summary>
        {editing === 'desc' ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              rows={5}
              aria-label="编辑任务描述"
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setEditing(null)} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: saveBusy ? 'default' : 'pointer' }}>取消</button>
              <button onClick={() => void saveField('desc')} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: saveBusy ? 'default' : 'pointer' }}>{saveBusy ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : (
          task.description ? <MarkdownContent content={task.description} /> : <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)', marginTop: 2 }}>（无描述）</div>
        )}
      </details>
      {/* 处理结果：可折叠段 + 就地回传（与桌面 TaskDetailDrawer 对齐；T01563 移动端增强） */}
      <details open style={{ marginTop: 12 }}>
        <summary style={summaryStyle}>
          <span><span className="hs-caret"><ChevronRight size={12} aria-hidden /></span>处理结果</span>
          {editing !== 'result' && (
            <button onClick={(e) => { e.preventDefault(); setResultDraft(task.handle_result ?? ''); setEditing('result'); }} disabled={busy || saveBusy}
              style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>{task.handle_result ? '编辑' : '回传'}</button>
          )}
        </summary>
        {editing === 'result' ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              value={resultDraft}
              onChange={(e) => setResultDraft(e.target.value)}
              rows={5}
              aria-label="编辑/回传处理结果"
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setEditing(null)} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: saveBusy ? 'default' : 'pointer' }}>取消</button>
              <button onClick={() => void saveField('result')} disabled={saveBusy}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: saveBusy ? 'default' : 'pointer' }}>{saveBusy ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : (
          <div>
            {task.handle_result ? <MarkdownContent content={task.handle_result} /> : <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)', marginTop: 2 }}>（暂无处理结果，AI 分析结论将回写于此）</div>}
            {/* T01698：结果历史 diff/回滚——与桌面抽屉/行内同一组件（T01607）；渲染只看 task_no 不看正文
                （回滚到「空正文」版本时面板仍在，否则失去再滚回来的入口）。半屏无缩进 indent=0。 */}
            {task.task_no && (
              <ResultDiffPanel
                taskNo={task.task_no}
                current={task.handle_result ?? ''}
                indent={0}
                onRollback={(next) => {
                  // 回滚成功：草稿镜像同步（下次进入编辑态基于回滚后文本），并通知父级重拉列表刷新 task prop
                  if (typeof next === 'string') setResultDraft(next);
                  onChanged();
                }}
              />
            )}
          </div>
        )}
      </details>
      {/* AI 摘要：可折叠段（默认收起，窄屏不挤占正文；与桌面一致但同样可展开查看） */}
      {task.ai_summary && (
        <details style={{ marginTop: 12 }}>
          <summary style={summaryStyle}>
            <span><span className="hs-caret"><ChevronRight size={12} aria-hidden /></span>AI 摘要</span>
          </summary>
          <div style={{ marginTop: 2 }}><MarkdownContent content={task.ai_summary} /></div>
        </details>
      )}
      {/* T01442：状态流转时间线（最近事件自动记录，与桌面端同源） */}
      <TaskEventTimeline taskId={task.id} />
      {task.images.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={labelStyle}>附件（{task.images.length}）{previewId ? ' · 已放大，再点同一张收起' : ''}</div>
          {/* T01572：补齐与桌面抽屉的最后一处不一致——缩略图点击放大（原位切换尺寸，不用 window.open / showModal，
              那两者在 Electron 渲染层不可用且会盖住半屏）。放大态 width:100% 撑满半屏内容区、height:auto 保原比例，
              仍受 HalfSheet 的 maxHeight 62% + overflowY:auto 约束（可纵向滚动，不撑破视口、不横向溢出）。 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.images.map((img) => (
              <button
                key={img.id}
                type="button"
                onClick={() => setPreviewId((p) => (p === img.id ? '' : img.id))}
                title="放大预览 — 点击放大或收起截图"
                aria-label={previewId === img.id ? '收起截图：点击收起放大预览' : '任务截图：点击放大预览'}
                // 放大态撑满一行：按钮是 flex 项（基准=内容宽），img 的 width:100% 缺确定基准会退回原始尺寸（与桌面抽屉同因）
                style={{ padding: 0, background: 'none', border: 'none', cursor: 'pointer', display: 'block', lineHeight: 0, maxWidth: '100%', ...(previewId === img.id ? { width: '100%' } : {}) }}
              >
                <img
                  src={imageUrl(img.id)}
                  alt="任务截图"
                  style={{
                    // 放大态：撑满内容区、高度自适应原比例（height:'100%' 在 auto 高度父级下会退回原始尺寸）
                    ...(previewId === img.id
                      ? { width: '100%', height: 'auto', maxWidth: '100%', objectFit: 'contain' as const }
                      : { height: 88, width: 'auto', maxWidth: '100%', objectFit: 'contain' as const }),
                    borderRadius: 8,
                    border: previewId === img.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                    display: 'block',
                    cursor: 'zoom-in',
                  }}
                />
              </button>
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
