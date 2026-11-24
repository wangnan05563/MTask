import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { api, type Prompt, type SearchHit, type SearchOutOfSight, type SearchResponse } from '../api/client';
import { focusTaskByNo } from '../ui/focusTask'; // T02162：对齐通知中心：点击任务走同一套「解析→写键→派发 mtaskFocusTask→开抽屉」定位逻辑
import { focusExecSession } from '../ui/focusExecSession'; // T06296：Run 命中后直达执行会话卡片
import { loadProjectList, ProjectListHint, useProjectList } from '../ui/projectList'; // T02201：项目取数走统一容错层
import { ResourceHint, useResource } from '../ui/resourceState'; // T02213：任务/提示词取数改走可见失败态层
import { TABS, type Tab } from '../ui/tabs'; // T03184（PM-102）：页面列表从导航单源生成
import { SETTINGS_TABS, focusSettingsTab, matchesSettingsTab } from '../ui/settingsTabs'; // T03271（UX-09②）：设置页签单源 + 直达写入
import { focusSettingsSearch, type SettingsSearchIntentTab } from '../ui/settingsSearch'; // T04099：范围外跳转把关键词带到历史资产/归档页


/** 与 useSessionState 同格式写入会话存储（JSON）——供目标页 useSessionState 读取初始搜索词 */
function setSessionState(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额异常静默 */ }
}
/** T02201：项目条目改用统一容错层的 Project（原本地 ProjectLite 已冗余） */
// T02213：空列表用常驻引用，避免每次渲染现造新数组让 items 的 useMemo 依赖整表变化。
const NO_PROMPTS: Prompt[] = [];
const NO_HITS: SearchHit[] = [];

interface Item {
  group: string;
  label: string;
  hint: string;
  /** T06296：任务正文/Run 阶段等上下文预览，第二行展示；页面/项目条目没有。 */
  snippet?: string;
  action: () => void;
}

/** T03184：页面直达 = 页面路由单源——全部页面（含首页/执行会话）可搜；T06289 起一级导航收敛为 5 组，分组见 ui/nav/primaryNavGroups。 */
function buildPageItems(kwLower: string, onNavigate: (tab: Tab) => void): Item[] {
  const out: Item[] = [];
  for (const t of TABS) {
    if (!kwLower || t.label.toLowerCase().includes(kwLower)) {
      out.push({ group: '页面', label: t.label, hint: `跳转到「${t.label}」`, action: () => onNavigate(t.key) });
    }
  }
  return out;
}

/** T03271（UX-09②）：设置页签直达——名称取自同一份 settingsTabs 单源，与导航逐字一致；
 *  仅在输入关键词时出现，避免空查询时把 15 个设置项堆在默认列表里。 */
function buildSettingsItems(kwLower: string, onNavigate: (tab: Tab) => void): Item[] {
  if (!kwLower) return [];
  const out: Item[] = [];
  for (const t of SETTINGS_TABS) {
    if (matchesSettingsTab(t, kwLower)) {
      out.push({
        group: '设置', label: t.label, hint: `跳转到「设置 → ${t.label}」`,
        action: () => { focusSettingsTab(t.key); onNavigate('settings'); },
      });
    }
  }
  return out;
}

/** T00560：项目搜索——跳任务页并写入搜索词（任务页按名称过滤展示） */
function buildProjectItems(kwLower: string, projects: ReadonlyArray<{ id: string; name: string }>, onNavigate: (tab: Tab) => void): Item[] {
  const out: Item[] = [];
  for (const pr of projects) {
    if (!kwLower || pr.name.toLowerCase().includes(kwLower)) {
      out.push({
        group: '项目', label: pr.name, hint: '跳任务页并按项目名过滤',
        action: () => { setSessionState('tasks.search', pr.name); onNavigate('tasks'); },
      });
    }
  }
  return out;
}

/**
 * T06296：统一搜索结果转命令面板条目。
 * - 任务：走 focusTaskByNo，跨项目解析、写齐定位键并自动开详情抽屉；
 * - 原生 Run：暂未挂载 Run 详情页，落到关联任务详情；
 * - 旧执行会话：写定位意图并切到执行会话页，页面挂载/已挂载两条路径都能滚到卡片。
 */
function buildSearchItems(hits: readonly SearchHit[], onNavigate: (tab: Tab) => void): Item[] {
  return hits.map((hit) => {
    if (hit.type === 'task') {
      return {
        group: '任务',
        label: hit.title,
        hint: hit.subtitle || '打开任务',
        snippet: hit.snippet,
        action: () => { void focusTaskByNo(hit.taskNo ?? hit.title, 'notice'); },
      };
    }
    if (hit.source === 'exec_session') {
      return {
        group: 'Run',
        label: hit.title,
        hint: hit.subtitle || '打开执行会话',
        snippet: hit.snippet,
        action: () => { focusExecSession(hit.id); onNavigate('exec-sessions'); },
      };
    }
    return {
      group: 'Run',
      label: hit.title,
      hint: hit.subtitle || '打开关联任务',
      snippet: hit.snippet,
      action: () => { void focusTaskByNo(hit.taskNo ?? hit.title, 'notice'); },
    };
  });
}

/**
 * T03983：任务命中为 0 时的「范围外」可跳转条目。
 * 默认列表把「已归档 / 历史资产 / 搁置」三态整片排除（T00589/T00719），所以面板里「搜不到」
 * 大多是「不在当前可见区」而不是「不存在」——服务端把这部分差集按桶计数回传，这里只如实成条。
 * 计数为 0 的桶一条都不生成：把用户引向一个必然为空的页面，比不给入口更糟。
 * 搁置没有独立菜单（在任务页的搁置 tab），故写 tasks.search + tasks.activeTab 两个会话键过去；
 * 历史资产/归档同理带关键词（T04099），否则用户进页后得把同一个词重打一遍。
 */
function buildOutOfSightItems(kw: string, outOfSight: SearchOutOfSight | undefined, taskHitCount: number, onNavigate: (tab: Tab) => void): Item[] {
  if (!kw || taskHitCount > 0 || !outOfSight || outOfSight.total === 0) return [];
  const toSettings = (key: SettingsSearchIntentTab, label: string, count: number): Item => ({
    group: '范围外',
    label: `${label}中另有 ${count} 条「${kw}」`,
    hint: `跳转到「设置 → ${label}」（带当前关键词）`,
    action: () => { focusSettingsSearch(key, kw); onNavigate('settings'); },
  });
  const out: Item[] = [];
  if (outOfSight.history > 0) out.push(toSettings('history', '历史资产', outOfSight.history));
  if (outOfSight.archived > 0) out.push(toSettings('archive', '归档', outOfSight.archived));
  if (outOfSight.shelved > 0) {
    out.push({
      group: '范围外', label: `搁置中另有 ${outOfSight.shelved} 条「${kw}」`,
      hint: '跳任务页并切到搁置列表（带当前关键词）',
      action: () => { setSessionState('tasks.search', kw); setSessionState('tasks.activeTab', 'shelved'); onNavigate('tasks'); },
    });
  }
  return out;
}

/** 提示词（列表量级小，仍走一次取数后本地过滤） */
function buildPromptItems(kwLower: string, prompts: readonly Prompt[], onNavigate: (tab: Tab) => void): Item[] {
  const out: Item[] = [];
  for (const p of prompts) {
    if (!kwLower || p.title.toLowerCase().includes(kwLower)) {
      out.push({ group: '提示词', label: p.title, hint: '跳提示词页并定位高亮', action: () => { focusPrompt(p); onNavigate('prompts'); } });
    }
  }
  return out;
}

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
 * 全局命令面板（T00443 / PRD UX-4）：Ctrl+K 勾起（T03170 / D-07：T03983 起第二个唤起键为 Shift+F，
 * 不再占用 Ctrl+F），跨实体搜索、↑↓ 选择、Enter 执行、Esc 关闭。
 *
 * T06296：搜索数据源改为 `/api/search` 统一服务——任务与 Run 同一次请求返回，
 * 分组计数、耗时、零结果建议与范围外计数都由服务端给出；页面/项目/设置/提示词仍保留本地即时条目，
 * 避免「输入一个字就把导航项全挤掉」的老体验回退。前 20 条均可用键盘选择。
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
  // T06296：关掉 hook 的自跑，由下方防抖 effect 统一触发（打开时立即搜，输入后 180ms 再搜）
  const searchView = useResource<SearchResponse>(
    () => api.get<SearchResponse>(`/search?q=${encodeURIComponent(kw.trim())}&limit=10`),
    { enabled: false },
  );
  const hits = useMemo(() => searchView.data?.groups.flatMap((g) => g.items) ?? NO_HITS, [searchView.data]);
  const taskHitCount = searchView.data?.groups.find((g) => g.type === 'task')?.items.length ?? 0;
  const projectList = useProjectList();
  const { projects } = projectList;
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    setKw(''); setActive(0);
    void loadProjectList(true); // T02201：项目取数交统一容错层（打开面板强刷一次的口径不变，失败态见下方提示行）
    // 等 DOM 挂载后聚焦
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // T06296：输入防抖——每个字符都打一次搜索只会让结果闪烁；180ms 落在「打字节奏内不打断、停手即出结果」的区间。
  // useResource 自带轮次令牌，迟到的上一轮响应不会覆盖新结果。
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchView.reload(), kw.trim() ? 180 : 0);
    return () => clearTimeout(timer);
  }, [open, kw, searchView.reload]);

  const kwTrim = kw.trim();
  const kwLower = kwTrim.toLowerCase();
  // T03983：空态指引的取数与本轮结果同源（useResource 的轮次令牌保证不会吃到迟到的上一轮计数）
  const outOfSight = searchView.data?.outOfSight;

  const searchItems = useMemo(() => buildSearchItems(hits, onNavigate), [hits, onNavigate]);
  const localItems = useMemo<Item[]>(() => [
    ...buildPageItems(kwLower, onNavigate),
    ...buildSettingsItems(kwLower, onNavigate),
    ...buildProjectItems(kwLower, projects, onNavigate),
    ...buildPromptItems(kwLower, prompts, onNavigate),
  ], [kwLower, projects, prompts, onNavigate]);

  const items = useMemo<Item[]>(() => [
    // 输入关键词时搜索结果优先；空查询时页面直达在前，最近任务/Run 作为「最近使用」在后。
    ...(kwLower ? searchItems : localItems),
    ...buildOutOfSightItems(kwTrim, outOfSight, taskHitCount, onNavigate),
    ...(kwLower ? localItems : searchItems),
  ], [kwLower, kwTrim, outOfSight, taskHitCount, searchItems, localItems, onNavigate]);

  // 结果数量随查询变化：把高亮项收回到有效范围，避免 Enter 落到已消失的旧下标。
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  // 键盘走到视口外时把当前条目滚进可视区（前 20 条均需可操作）。
  useEffect(() => {
    rowRefs.current.get(active)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

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

  // 遮罩点击关闭：文档级监听替代遮罩容器上的鼠标事件（容器保持非交互语义）；
  // 卡片内部点击的 target 不是遮罩本身，因此不再需要额外的冒泡阻断。
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => { if (e.target === overlayRef.current) onClose(); };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open, onClose]);

  if (!open) return null;
  const result = searchView.data;
  const searchFailed = searchView.phase === 'error';
  const showNoMatch = items.length === 0 && !searchFailed && searchView.phase !== 'loading';
  const outOfSightNote = !showNoMatch && !!kwTrim && !!result
    && (result.groups.find((g) => g.type === 'task')?.items.length ?? 0) === 0
    && (result.outOfSight?.total ?? 0) > 0;
  return createPortal(
    <div ref={overlayRef} data-palette-root role="dialog" aria-modal="true" aria-label="全局搜索"
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}>
      <div data-palette-panel style={{ background: 'var(--card-bg)', borderRadius: 10, width: 'min(620px, 92vw)', boxShadow: '0 12px 40px rgba(0,0,0,.25)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input ref={inputRef} value={kw} onChange={(e) => { setKw(e.target.value); setActive(0); }} onKeyDown={onKeyDown}
            placeholder="搜索任务、Run；支持 type:task/run、status:、project:…"
            aria-label="命令面板搜索"
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-l)' }} />
          {searchView.phase === 'loading' && <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>搜索中…</span>}
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {/* T03983：空态不再只是一行「无匹配结果」——默认视图把归档/历史资产/搁置整片排除（T00589/T00719），
              用户搜不到时首先要说清「这不是不存在，而是不在本面板范围」，再按真实计数给跳转（见上方「范围外」条目）。
              T06296：零结果按服务端建议逐条给出下一步，不再只报「没有」。 */}
          {showNoMatch && (
            <div data-palette-zero style={{ padding: 16, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.7 }}>
              <div>{kwTrim ? '没有找到匹配的任务或 Run' : '无匹配结果'}</div>
              {kwTrim && (
                <div data-palette-scope-note style={{ marginTop: 4 }}>
                  相关任务可能已归档至历史资产或处于搁置状态——本面板只搜当前可见区
                  {result ? '（这些范围内也没有同关键词的命中）' : ''}
                </div>
              )}
              {!!result?.suggestions.length && (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {result.suggestions.map((s) => (
                    <span key={s} style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px', fontSize: 'var(--fs-2xs)' }}>{s}</span>
                  ))}
                </div>
              )}
            </div>
          )}
          {searchView.phase === 'loading' && items.length === 0 && (
            <output style={{ display: 'block', padding: 16, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center' }}>搜索中…</output>
          )}
          {/* T03983：任务命中为 0、但范围外有命中时，先把「为什么这里是空的」说清楚，再列可跳转的条目 */}
          {outOfSightNote && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
              当前可见区没有匹配任务——同关键词在归档 / 历史资产 / 搁置中另有 {result?.outOfSight.total} 条：
            </div>
          )}
          {items.map((it, i) => (
            <button type="button"
              key={`${it.group}-${it.label}-${i}`}
              ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i); }}
              data-palette-result
              data-palette-type={it.group}
              data-palette-index={i}
              onClick={() => execute(i)}
              onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 14px', cursor: 'pointer', textAlign: 'left', border: 'none', background: i === active ? 'var(--surface-2)' : 'transparent' }}>
              <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{it.group}</span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 'var(--fs-m)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                {it.snippet && (
                  <span data-palette-snippet style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.snippet}</span>
                )}
              </span>
              <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', maxWidth: '44%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{i === active ? <CornerDownLeft size={11} /> : it.hint}</span>
            </button>
          ))}
        </div>
        <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          ↑↓ 选择 · Enter 执行 · Esc 关闭 —— 任务开详情、Run 定位执行会话，页面/项目/提示词跳转定位
          {/* T06296：状态行给出命中总数、服务端耗时与降级原因，避免「没结果」时分不清语法/数据问题 */}
          {result && (
            <output data-palette-hint style={{ color: result.degraded ? 'var(--danger)' : 'var(--text-muted)' }}>
              命中 {result.total} 条 · {result.elapsedMs}ms{result.hint ? ` · ${result.hint}` : ''}
            </output>
          )}
          {/* T02201：项目取数失败时显式给出原因与重试入口，不再只剩「无匹配结果」 */}
          <ProjectListHint view={projectList} />
          {/* T02213：提示词取数失败同理——任一来源模糊都会让「无匹配结果」失真，逐源给原因 */}
          <ResourceHint view={searchView} label="全局搜索" />
          <ResourceHint view={promptsView} label="提示词列表" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
