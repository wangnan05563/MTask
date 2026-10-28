import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { api, type Prompt, type Task } from '../api/client';
import { focusTaskByNo } from '../ui/focusTask'; // T02162：对齐通知中心：点击任务走同一套「解析→写键→派发 mtaskFocusTask→开抽屉」定位逻辑
import { loadProjectList, ProjectListHint, useProjectList } from '../ui/projectList'; // T02201：项目取数走统一容错层
import { ResourceHint, useResource } from '../ui/resourceState'; // T02213：任务/提示词取数改走可见失败态层
import { TABS, type Tab } from '../ui/tabs'; // T03184（PM-102）：页面列表从导航单源生成
import { SETTINGS_TABS, focusSettingsTab, matchesSettingsTab } from '../ui/settingsTabs'; // T03271（UX-09②）：设置页签单源 + 直达写入 // T03271（UX-09②）：设置页签与导航同名，可直达具体页签


/** T03184：后端 `/tasks/search` 信封——total/truncated/degraded 是面板提示语的唯一依据 */
interface TaskSearchResult {
  readonly items: Task[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly mode: 'fuzzy' | 'structured';
  readonly degraded: boolean;
  readonly truncated: boolean;
  readonly hint: string;
}

/** 与 useSessionState 同格式写入会话存储（JSON）——供目标页 useSessionState 读取初始搜索词 */
function setSessionState(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额异常静默 */ }
}
/** T02201：项目条目改用统一容错层的 Project（原本地 ProjectLite 已冗余） */
// T02213：空列表用常驻引用，避免每次渲染现造新数组让 items 的 useMemo 依赖整表变化。
const NO_TASKS: Task[] = [];
const NO_PROMPTS: Prompt[] = [];

/** T03184：提示词命中——写会话键（供目标页挂载时读取）+ 派发事件（供已挂载页面即时定位） */
function focusPrompt(prompt: Prompt): void {
  setSessionState('prompts.search', '');
  if (prompt.category_id) setSessionState('prompts.activeCat', prompt.category_id);
  setSessionState('prompts.focusId', { promptId: prompt.id, categoryId: prompt.category_id, at: Date.now() });
  globalThis.dispatchEvent(new CustomEvent('mtaskPromptFocus', {
    detail: { promptId: prompt.id, categoryId: prompt.category_id },
  }));
}

/**
 * 全局命令面板（T00443 / PRD UX-4，P2）：Ctrl+K 唤起（T03170 / D-07：页内无搜索时 Ctrl+F 亦达），
 * 跨实体搜索（任务/提示词/页面直达），↑↓ 选择、Enter 执行、Esc 关闭。
 *
 * T03184（PM-102）：任务搜索改走后端 `/tasks/search`——结构化语法（status:/priority:/project: +
 * AND/OR + 括号）在**全表**过滤后再分页，面板只负责展示 total 与截断/降级提示；
 * 页面直达列表改由 TABS 单源生成（含「执行会话」）。
 */
export function CommandPalette({ open, onClose, onNavigate }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (tab: Tab) => void;
}) {
  const [kw, setKw] = useState('');
  // T02213：提示词取数改走可见失败态层——此前 `.catch(() => undefined)` 让
  // 「后端没答上」与「库里真没数据」同形，面板只显示「无匹配结果」，用户无从判断该重试还是该接受。
  const promptsView = useResource<Prompt[]>(() => api.get<Prompt[]>('/prompts'), { enabled: open });
  const prompts = promptsView.data ?? NO_PROMPTS;
  // 任务搜索：关掉 hook 的自跑，由下方防抖 effect 统一触发（打开时立即搜，输入后 180ms 再搜）
  const searchView = useResource<TaskSearchResult>(
    () => api.get<TaskSearchResult>(`/tasks/search?q=${encodeURIComponent(kw.trim())}&limit=500`),
    { enabled: false },
  );
  const tasks = searchView.data?.items ?? NO_TASKS;
  const projectList = useProjectList();
  const { projects } = projectList;
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKw(''); setActive(0);
    void loadProjectList(true); // T02201：项目取数交统一容错层（打开面板强刷一次的口径不变，失败态见下方提示行）
    // 等 DOM 挂载后聚焦
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // T03184：输入防抖——每个字符都打一次全表搜索只会让结果闪烁；180ms 落在「打字节奏内不打断、停手即出结果」的区间。
  // useResource 自带轮次令牌，迟到的上一轮响应不会覆盖新结果。
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchView.reload(), kw.trim() ? 180 : 0);
    return () => clearTimeout(timer);
  }, [open, kw]); // eslint-disable-line react-hooks/exhaustive-deps

  interface Item { group: string; label: string; hint: string; action: () => void }
  const kwLower = kw.trim().toLowerCase();

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    // T03184：页面直达 = 导航单源——名称与顶部菜单逐字一致，九个一级页面（含「执行会话」）全部可搜
    for (const t of TABS) {
      if (!kwLower || t.label.toLowerCase().includes(kwLower)) {
        out.push({ group: '页面', label: t.label, hint: `跳转到「${t.label}」`, action: () => onNavigate(t.key) });
      }
    }
    // T03271（UX-09②）：设置页签直达——名称取自同一份 settingsTabs 单源，与导航逐字一致；
    // 仅在输入关键词时出现，避免空查询时把 15 个设置项堆在默认列表里。
    if (kwLower) {
      for (const t of SETTINGS_TABS) {
        if (matchesSettingsTab(t, kwLower)) {
          out.push({
            group: '设置', label: t.label, hint: `跳转到「设置 → ${t.label}」`,
            action: () => { focusSettingsTab(t.key); onNavigate('settings'); },
          });
        }
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
    // 任务（跨项目，结构化/模糊均由后端过滤）
    // T00836：点击任务除写入搜索词外，还下发 focusId/focusTab，任务页据此滚动定位 + 高亮 + 展开该记录
    // T02162：改为复用通知中心同款 focusTaskByNo——它不仅写齐全部会话键，还派发 mtaskFocusTask 事件。
    // 旧逻辑只写过次键 + onNavigate('tasks')=setTab：当用户本就停在任务页时 setTab 同值不触发重挂载，
    // useSessionState 只在挂载时读一次键，于是「点击无反应 / 定位到上一条」（T01568 同一个坑，此前只修了通知中心）。
    // focusTaskByNo 的事件路径让已挂载的任务页直接吃到定位意图；'notice' 同时按任务实际状态自动弹出详情抽屉。
    for (const t of tasks) {
      const label = `${t.task_no ?? 'T?????'} ${t.title}（${t.status === 'done' ? '已完成' : '待办'}）`;
      out.push({
        group: '任务', label, hint: '跳任务页并定位该任务（搜索编号）',
        action: () => { void focusTaskByNo(t.task_no ?? t.title, 'notice'); },
      });
    }
    // 提示词（列表量级小，仍走一次取数后本地过滤）
    for (const p of prompts) {
      if (!kwLower || p.title.toLowerCase().includes(kwLower)) {
        out.push({ group: '提示词', label: p.title, hint: '跳提示词页并定位高亮', action: () => { focusPrompt(p); onNavigate('prompts'); } });
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
  const result = searchView.data;
  const searchFailed = searchView.phase === 'error';
  const showNoMatch = items.length === 0 && !searchFailed && searchView.phase !== 'loading';
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
            placeholder="搜索任务（支持 status:/priority:/project: 与 AND/OR）、提示词或页面…"
            aria-label="命令面板搜索"
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-l)' }} />
        </div>
        <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {showNoMatch && <div style={{ padding: 16, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center' }}>无匹配结果</div>}
          {searchView.phase === 'loading' && items.length === 0 && (
            <div role="status" style={{ padding: 16, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center' }}>搜索中…</div>
          )}
          {items.map((it, i) => (
            <div /* NOSONAR - 列表项点击/悬停属鼠标便捷操作，键盘导航由搜索框统一处理（↑↓ 选择、Enter 执行） */
              key={`${it.group}-${it.label}-${i}`} onClick={() => execute(i)}
              onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer', background: i === active ? 'var(--surface-2)' : 'transparent' }}>
              <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{it.group}</span>
              <span style={{ flex: 1, fontSize: 'var(--fs-m)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>{i === active ? <CornerDownLeft size={11} /> : it.hint}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          ↑↓ 选择 · Enter 执行 · Esc 关闭 —— 选中任务/项目/提示词会跳转对应页面并自动定位
          {/* T03184：搜索结果的状态行——命中总数、截断提示（仅显示前 500 条）与语法降级原因都显式给出 */}
          {result && (
            <span role="status" data-palette-hint style={{ color: result.degraded ? 'var(--danger)' : 'var(--text-muted)' }}>
              任务命中 {result.total} 条{result.mode === 'structured' ? '（结构化）' : ''}{result.hint ? ` · ${result.hint}` : ''}
            </span>
          )}
          {/* T02201：项目取数失败时显式给出原因与重试入口，不再只剩「无匹配结果」 */}
          <ProjectListHint view={projectList} />
          {/* T02213：提示词取数失败同理——任一来源模糊都会让「无匹配结果」失真，逐源给原因 */}
          <ResourceHint view={searchView} label="任务搜索" />
          <ResourceHint view={promptsView} label="提示词列表" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
