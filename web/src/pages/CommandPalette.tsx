import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { api, type Prompt, type Task } from '../api/client';


/** T00560：命令面板可直达的页面（与 App Tab 对齐的子集） */
type AppTab = 'tasks' | 'aitools' | 'prompts' | 'req' | 'plan' | 'queue' | 'report' | 'settings';

/** 与 useSessionState 同格式写入会话存储（JSON）——供目标页 useSessionState 读取初始搜索词 */
function setSessionState(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额异常静默 */ }
}
interface ProjectLite { id: string; name: string }

/**
 * 全局命令面板（T00443 / PRD UX-4，P2）：Ctrl+K 唤起，跨实体搜索（任务/提示词/页面直达），
 * ↑↓ 选择、Enter 执行、Esc 关闭。数据在打开时一次性并行拉取（前端过滤，量级可控）。
 */
export function CommandPalette({ open, onClose, onNavigate }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (tab: AppTab) => void;
}) {
  const [kw, setKw] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKw(''); setActive(0);
    void api.get<Task[]>('/tasks?archived=0&limit=500').then(setTasks).catch(() => undefined);
    void api.get<Prompt[]>('/prompts').then(setPrompts).catch(() => undefined);
    void api.get<ProjectLite[]>('/projects').then(setProjects).catch(() => undefined);
    // 等 DOM 挂载后聚焦
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  interface Item { group: string; label: string; hint: string; action: () => void }
  const kwLower = kw.trim().toLowerCase();

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    // 页面直达
    // T00560：页面直达覆盖全部主菜单
    const pages: Array<[string, AppTab]> = [
      ['任务', 'tasks'], ['模型菜单', 'aitools'], ['提示词', 'prompts'], ['通用需求', 'req'],
      ['项目计划', 'plan'], ['队列', 'queue'], ['AI 工作台', 'report'], ['设置', 'settings'],
    ];
    for (const [label, tab] of pages) {
      if (!kwLower || label.toLowerCase().includes(kwLower)) {
        out.push({ group: '页面', label, hint: '跳转到该页面', action: () => onNavigate(tab) });
      }
    }
    // T00560：项目搜索——跳任务页并写入搜索词（任务页按名称过滤展示）
    for (const pr of projects) {
      if (!kwLower || pr.name.toLowerCase().includes(kwLower)) {
        out.push({
          group: '项目', label: pr.name, hint: '跳任务页并按项目名过滤',
          action: () => { setSessionState('tasks.search', pr.name); onNavigate('tasks'); },
        });
      }
    }
    // 任务（跨项目）
    for (const t of tasks) {
      const label = `${t.task_no ?? 'T?????'} ${t.title}（${t.status === 'done' ? '已完成' : '待办'}）`;
      if (!kwLower || t.title.toLowerCase().includes(kwLower) || (t.task_no ?? '').toLowerCase().includes(kwLower)) {
        out.push({
          group: '任务', label, hint: '跳任务页并定位该任务（搜索编号）',
          action: () => { setSessionState('tasks.search', t.task_no ?? t.title); onNavigate('tasks'); },
        });
      }
    }
    // 提示词
    for (const p of prompts) {
      if (!kwLower || p.title.toLowerCase().includes(kwLower)) {
        out.push({ group: '提示词', label: p.title, hint: '跳转到提示词页', action: () => onNavigate('prompts') });
      }
    }
    return out;
  }, [kwLower, tasks, prompts, projects, onNavigate]);

  const execute = useCallback((i: number) => {
    const it = items[i];
    if (it) { onClose(); it.action(); }
  }, [items, onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(active); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [items.length, active, execute, onClose]);

  if (!open) return null;
  return createPortal(
    <div /* NOSONAR - 遮罩点击空白关闭为便捷辅助，正式关闭入口为 Esc（输入框 onKeyDown 处理），无需对背景遮罩聚焦键盘 */
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}
      onClick={onClose}>
      <div /* NOSONAR - 阻断点击冒泡属事件传递逻辑而非独立交互控件，可访问关闭入口为 Esc 与输入框键盘处理 */
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--card-bg)', borderRadius: 10, width: 'min(560px, 92vw)', boxShadow: '0 12px 40px rgba(0,0,0,.25)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input ref={inputRef} value={kw} onChange={(e) => { setKw(e.target.value); setActive(0); }} onKeyDown={onKeyDown}
            placeholder="搜索任务编号/标题、提示词或页面…（↑↓ 选择，Enter 执行）"
            aria-label="命令面板搜索"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {items.length === 0 && <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>无匹配结果</div>}
          {items.map((it, i) => (
            <div /* NOSONAR - 列表项点击/悬停属鼠标便捷操作，键盘导航由搜索框统一处理（↑↓ 选择、Enter 执行） */
              key={`${it.group}-${it.label}-${i}`} onClick={() => execute(i)}
              onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer', background: i === active ? 'var(--surface-2)' : 'transparent' }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{it.group}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{i === active ? <CornerDownLeft size={11} /> : it.hint}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-muted)' }}>
          ↑↓ 选择 · Enter 执行 · Esc 关闭 —— 选中任务/项目/提示词会跳转对应页面并自动定位
        </div>
      </div>
    </div>,
    document.body,
  );
}
