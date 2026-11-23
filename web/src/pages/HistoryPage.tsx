import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Archive, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FolderInput, History, RotateCcw, Search, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState } from '../ui/session';
import { SETTINGS_SEARCH_EVENT, peekSettingsSearchIntent, takeSettingsSearchIntent, type SettingsSearchIntentEventDetail } from '../ui/settingsSearch'; // T04099：命令面板跳转带关键词
import { ProjectListHint, projectListPlaceholder, refreshProjectList, useProjectList } from '../ui/projectList'; // T02201：项目列表取数容错层
import { SettingsHelpIcon } from '../ui/settingsHelp'; // T06019：子页说明文字改为语义图标

/** 快照内任务（只读） */
interface SnapTask {
  id: string;
  task_no: string | null;
  title: string;
  description: string;
  status: string;
  verified: number;
  priority: string;
  handle_result: string | null;
  created_at: string;
}
/** 快照内计划（只读） */
interface SnapPlan {
  id: string;
  title: string;
  description: string | null;
  kind: string | null;
  status: string;
  progress: number | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
}
/** 项目快照 */
interface Snapshot {
  id: string;
  name: string;
  description: string;
  /** T05776：项目的产品标签（归一化文本，空串＝未绑定）——历史资产页按此动态分 Sheet */
  product_key?: string;
  history_at: string;
  stats: { tasks: number; doneTasks: number; plans: number; donePlans: number };
  tasks: SnapTask[];
  plans: SnapPlan[];
}

interface HistorySummary {
  activeProjects: number;
  snapshotProjects: number;
  snapshotTasks: number;
  snapshotPlans: number;
  firstHistoryAt: string | null;
  lastHistoryAt: string | null;
}

const PAGE_SIZE = 10;
/** 快照内计划状态与任务状态保持同一套中文口径，避免同页出现 todo / done 原始枚举 */
const PLAN_STATUS_LABEL: Record<string, string> = { todo: '待办', doing: '进行中', done: '已完成', blocked: '阻塞', canceled: '已取消' };

/**
 * 历史资产页（T00589 二轮：**项目级快照**）。
 * 「归档」= 软删除区；「历史资产」= 项目整体沉淀为快照——沉淀后该项目在任务/计划菜单的项目列表中不再出现，
 * 本页以**项目为单位**查看快照全量内容，并支持整体恢复（回活跃）或归档删除（转归档区）。
 */
export function HistoryPage() {
  // T02201：活跃项目走统一容错层（此前与历史列表绑在同一 Promise.all，项目接口一挂整页 load 抛出）
  const projectList = useProjectList();
  const { projects: activeProjects } = projectList;
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [transferProject, setTransferProject] = useSessionState<string>('history.transferProject', '');
  const [kw, setKw] = useSessionState<string>('history.kw', '');
  const [openIds, setOpenIds] = useSessionState<string[]>('history.openSnaps', []);
  const [productTag, setProductTag] = useSessionState<string>('history.productTag', '');
  const [page, setPage] = useState(1);
  const tabScrollRef = useRef<HTMLDivElement>(null);

  // T04099：命令面板「历史资产中另有 N 条」带过来的关键词——挂载时消费一次（读到即删）。
  // 意图只做一次性覆盖（searchKw），不写回 `history.kw`：否则下次不经面板进入页面还会看到上次的关键词。
  // 初始化器只读（StrictMode 双跑，不能在这里删键）；真正的消费与聚焦放在 effect 里
  const [intentKw, setIntentKw] = useState<string | null>(() => peekSettingsSearchIntent('history') || null);
  const searchKw = intentKw ?? kw;
  const setSearchKw = (v: string) => { setIntentKw(null); setKw(v); };
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!intentKw) return;
    takeSettingsSearchIntent('history');
    setPage(1);
    searchRef.current?.focus();
  }, [intentKw]);
  // 面板点击时本页可能已挂载：只写会话键不会重渲染，事件路径即时覆盖；同样消费意图键，避免下次直接进入残留
  useEffect(() => {
    const onSearch = (e: Event) => {
      const detail = (e as CustomEvent<SettingsSearchIntentEventDetail>).detail;
      if (detail?.key !== 'history') return;
      takeSettingsSearchIntent('history');
      setIntentKw(detail.kw);
      setPage(1);
      searchRef.current?.focus();
    };
    globalThis.addEventListener(SETTINGS_SEARCH_EVENT, onSearch);
    return () => globalThis.removeEventListener(SETTINGS_SEARCH_EVENT, onSearch);
  }, []);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3200); };

  const load = useCallback(async () => {
    // T02201：活跃项目改由统一容错层取数（原先与历史列表绑在同一 Promise.all，
    // 项目接口一挂整页 load 抛出且无提示）；本页其余取数失败也补了可见反馈。
    try {
      const [data, sumResult] = await Promise.all([
        api.get<{ snapshots: Snapshot[] }>('/history/list'),
        api.get<HistorySummary>('/history/summary')
          .then((value) => ({ ok: true as const, value }))
          .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
      ]);
      setSnapshots(data.snapshots);
      if (sumResult.ok) {
        setSummary(sumResult.value);
        setSummaryError('');
      } else {
        // 统计失败不能用 0 冒充真实值；保留错误入口，列表仍照常可用。
        setSummary(null);
        setSummaryError(sumResult.error || '统计数据加载失败');
      }
      setLoadError('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      flash(`历史数据加载失败：${msg}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // T05776：鼠标纵向滚轮在标签栏内转为横向滚动（原生监听 + passive:false，避免 React 合成 wheel 无法阻止页面滚动）
  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [snapshots.length]);

  // T05776：产品标签从快照数据动态生成（不硬编码）；顺序沿用快照接口的 history_at DESC，
  // 同一产品标签只出现一次；空 product_key 归入「未绑定产品」，避免与「全部产品」混淆。
  const productTabs = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; count: number }>();
    for (const s of snapshots) {
      const raw = (s.product_key ?? '').trim();
      const key = raw || '__none__';
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { key, label: raw || '未绑定产品', count: 1 });
    }
    return [
      { key: '', label: '全部产品', count: snapshots.length },
      ...Array.from(groups.values()),
    ];
  }, [snapshots]);
  // 数据刷新后若当前标签已不存在，回落到「全部产品」，避免空白 Sheet
  const activeProduct = productTabs.some((t) => t.key === productTag) ? productTag : '';
  const activeProductLabel = productTabs.find((t) => t.key === activeProduct)?.label ?? '全部产品';
  useEffect(() => {
    // 首屏快照尚未返回时 productTabs 只有「全部产品」，不能据此清掉会话里恢复的标签；
    // 等数据到位后再判断标签是否仍存在，避免刷新后产品筛选被静默重置。
    if (snapshots.length === 0) return;
    if (productTag && !productTabs.some((t) => t.key === productTag)) setProductTag('');
  }, [productTag, productTabs, snapshots.length, setProductTag]);

  const filtered = useMemo(() => {
    const k = searchKw.trim().toLowerCase();
    const byProduct = (s: Snapshot) => {
      if (activeProduct === '') return true;
      const raw = (s.product_key ?? '').trim();
      return activeProduct === '__none__' ? raw === '' : raw === activeProduct;
    };
    return snapshots.filter((s) => byProduct(s) && (!k || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(k)));
  }, [snapshots, searchKw, activeProduct]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const pageSnaps = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  function toggleOpen(id: string) {
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function scrollProductTabs(dir: -1 | 1) {
    tabScrollRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  }

  /** 沉淀：整个项目转为历史快照 */
  async function transfer() {
    if (!transferProject) return flash('请先选择要沉淀的项目');
    const name = activeProjects.find((p) => p.id === transferProject)?.name ?? transferProject;
    if (!(await askConfirm(`将项目「${name}」整体沉淀为历史资产快照？\n\n沉淀后：\n· 该项目在任务菜单/项目计划菜单的项目列表中不再出现\n· 全部任务与计划以快照形式保留在本页，可整体恢复或归档删除\n· 项目名将被占用（新建同名项目会被拒绝）`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; tasks: number; plans: number; projectName: string }>('/history/transfer', { projectId: transferProject });
      flash(`已沉淀快照「${r.projectName}」：任务 ${r.tasks} 条、计划 ${r.plans} 条`);
      setTransferProject('');
      await Promise.all([load(), refreshProjectList()]);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** 恢复：整个快照回到活跃项目 */
  async function restore(s: Snapshot) {
    if (!(await askConfirm(`将快照「${s.name}」整体恢复为活跃项目？\n恢复后该项目重新出现在任务/计划菜单的项目列表。`))) return;
    setBusy(true);
    try {
      await api.post('/history/restore', { projectId: s.id });
      flash(`快照「${s.name}」已恢复为活跃项目`);
      // 恢复后项目重新变为活跃：同步刷新全局项目列表，否则沉淀下拉要等 60s 缓存过期才出现该项。
      await Promise.all([load(), refreshProjectList()]);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** 归档删除：整个快照转归档区（软删除，可经归档菜单恢复） */
  async function toArchive(s: Snapshot) {
    if (!(await askConfirm(`将快照「${s.name}」整体归档删除？\n\n· 该项目的 ${s.stats.tasks} 条任务与 ${s.stats.plans} 条计划将转入「归档」区（软删除）\n· 项目本身标记为已归档`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ tasks: number; plans: number }>('/history/to-archive', { projectId: s.id });
      flash(`已归档删除「${s.name}」：任务 ${r.tasks} 条、计划 ${r.plans} 条已转入归档区`);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  const statCards = [
    { label: '活跃项目', value: summaryError ? '—' : summary?.activeProjects ?? 0, hint: '当前任务/计划菜单可见的项目', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    { label: '历史快照', value: summaryError ? '—' : summary?.snapshotProjects ?? 0, hint: '已整体沉淀的项目快照', color: 'var(--success)', bg: 'color-mix(in srgb, var(--success) 10%, transparent)' },
    { label: '快照任务', value: summaryError ? '—' : summary?.snapshotTasks ?? 0, hint: '快照内保留的任务总数', color: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn) 10%, transparent)' },
    { label: '快照计划', value: summaryError ? '—' : summary?.snapshotPlans ?? 0, hint: '快照内保留的计划总数', color: 'var(--danger)', bg: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  ];

  return (
    <section>
      <style>{`
        .snap-card:hover { border-color: var(--accent) !important; }
        .snap-card-action { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .snap-card:hover .snap-card-action, .snap-card:focus-within .snap-card-action,
        .snap-card-action:focus-visible { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @media (hover: none) {
          .snap-card-action { opacity: 1; visibility: visible; }
        }
        .snap-precipitate-action { opacity: .35; transition: opacity .15s ease; }
        .snap-precipitate:hover .snap-precipitate-action, .snap-precipitate:focus-within .snap-precipitate-action,
        .snap-precipitate-action:focus-visible { opacity: 1; }
        @media (hover: none) { .snap-precipitate-action { opacity: 1; } }
      `}</style>

      {notice && <div data-t06001="notice" role="status" aria-live="polite" aria-atomic="true" style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 'var(--fs-s)', color: 'var(--text)' }}>{notice}</div>}

      <div style={{ marginBottom: 4 }}>
        <SettingsHelpIcon
          icon={History}
          label="历史版本"
          ariaDescription="项目级组织过程资产沉淀——项目整体转为快照后从任务/计划菜单隐去；归档为软删除区，二者独立。"
          description={<>项目级组织过程资产沉淀——项目整体转为快照后从任务/计划菜单隐去；<strong style={{ color: 'var(--text)' }}>归档</strong>为软删除区，二者独立</>}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, margin: '12px 0' }}>
        {statCards.map((c) => (
          <div key={c.label} data-t06001="stat-card" title={c.hint}
            style={{ padding: '10px 12px', border: '1px solid var(--border)', borderLeft: `3px solid ${c.color}`, borderRadius: 8, background: c.bg }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: c.color, fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 'var(--fs-title)', fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>{c.value}</div>
          </div>
        ))}
      </div>
      {summaryError && (
        <div data-t05776="summary-error" role="alert"
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px', marginBottom: 10, border: '1px solid var(--danger)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
          <span style={{ color: 'var(--danger)' }}>统计数据加载失败：{summaryError}（统计卡暂以「—」显示，不代表 0）</span>
          <button type="button" onClick={() => void load()} className="tbtn-anim"
            style={{ border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', borderRadius: 5, cursor: 'pointer', fontSize: 'var(--fs-s)', padding: '2px 8px' }}>
            重试
          </button>
        </div>
      )}
      {!summaryError && (summary?.firstHistoryAt || summary?.lastHistoryAt) && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>
          沉淀时间跨度：{summary?.firstHistoryAt ? relTime(summary.firstHistoryAt) : '—'} ~ {summary?.lastHistoryAt ? relTime(summary.lastHistoryAt) : '—'}
        </div>
      )}

      {/* 沉淀操作 + 搜索 */}
      <div className="snap-precipitate" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', marginBottom: 12 }}>
        <select value={transferProject} onChange={(e) => setTransferProject(e.target.value)}
          aria-label="选择要沉淀的项目" title="选择一个活跃项目整体沉淀为历史快照"
          disabled={projectList.unusable || (projectList.phase === 'ready' && activeProjects.length === 0)}
          style={{ padding: 4, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">{projectList.phase === 'ready' && activeProjects.length === 0 ? '暂无活跃项目' : projectListPlaceholder(projectList)}</option>
          {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ProjectListHint view={projectList} />
        <button onClick={() => void transfer()} disabled={busy || !transferProject} className="tbtn-anim snap-precipitate-action"
          title="把所选项目整体沉淀为历史资产快照" aria-label="沉淀为历史快照"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 26, padding: '0 8px', borderRadius: 6, cursor: transferProject ? 'pointer' : 'not-allowed', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 'var(--fs-s)', opacity: transferProject ? 1 : 0.5 }}>
          <FolderInput size={13} />
          <span>沉淀</span>
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input ref={searchRef} value={searchKw} onChange={(e) => { setSearchKw(e.target.value); setPage(1); }}
            placeholder="搜索快照项目…" aria-label="搜索历史快照" data-page-search
            style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', width: 160 }} />
          {searchKw && <button onClick={() => { setSearchKw(''); setPage(1); }} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
      </div>

      {/* T05776：取数失败时给出常驻错误出口（toast 会消失；失败态下不把“无快照”误报成空数据） */}
      {loadError && (
        <div data-t05776="load-error" role="alert"
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px', marginBottom: 10, border: '1px solid var(--danger)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
          <span style={{ color: 'var(--danger)' }}>历史数据加载失败：{loadError}</span>
          <button type="button" onClick={() => void load()} className="tbtn-anim"
            style={{ border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', borderRadius: 5, cursor: 'pointer', fontSize: 'var(--fs-s)', padding: '2px 8px' }}>
            重试
          </button>
        </div>
      )}

      {/* T05776：产品标签 Sheet 页签——标签由快照 product_key 动态生成；超出容器时横向滚动 + 左右箭头提示，
          并支持鼠标纵向滚轮转为横向滚动；切换标签只影响下方快照列表，不改沉淀/恢复/归档逻辑 */}
      {snapshots.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
          <button type="button" onClick={() => scrollProductTabs(-1)} aria-label="向左滚动产品标签" title="向左滚动产品标签"
            style={{ flex: '0 0 auto', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 2px', display: 'inline-flex' }}>
            <ChevronLeft size={16} />
          </button>
          <div ref={tabScrollRef} data-t05776="product-tabs" role="group" aria-label="历史资产产品标签 Sheet 切换"
            style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 1, minWidth: 0, overflowX: 'auto', borderBottom: '1px solid var(--border-strong)', scrollBehavior: 'smooth' }}>
            {productTabs.map((t) => (
              <button key={t.key || 'all'} type="button" aria-pressed={activeProduct === t.key}
                onClick={() => { setProductTag(t.key); setPage(1); }}
                title={`${t.label}（${t.count} 个快照） — 点击切换产品标签 Sheet`}
                style={{
                  fontSize: 'var(--fs-l)', padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                  flex: '0 0 auto', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: activeProduct === t.key ? 700 : 400,
                  color: activeProduct === t.key ? 'var(--text)' : 'var(--text-muted)',
                  borderBottom: activeProduct === t.key ? '2px solid var(--accent)' : '2px solid transparent',
                }}>
                {t.label}（{t.count}）
              </button>
            ))}
          </div>
          <button type="button" onClick={() => scrollProductTabs(1)} aria-label="向右滚动产品标签" title="向右滚动产品标签"
            style={{ flex: '0 0 auto', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 2px', display: 'inline-flex' }}>
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {!loadError && filtered.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          {snapshots.length === 0
            ? '暂无历史快照。选择一个活跃项目点击「沉淀」——沉淀后该项目从任务/计划菜单隐去，内容以快照形式在此留存。'
            : searchKw.trim()
              ? `「${activeProductLabel}」下没有匹配「${searchKw.trim()}」的快照。`
              : `「${activeProductLabel}」下暂无历史快照。`}
        </p>
      )}

      {/* 项目快照列表（每项为一个项目快照） */}
      {pageSnaps.map((s) => {
        const open = openIds.includes(s.id);
        return (
          <div key={s.id} className="snap-card" role="group" aria-label={`历史快照：${s.name}`} data-t06001="snap-card" data-snapshot-id={s.id}
            style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', marginBottom: 10, transition: 'border-color .15s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', flexWrap: 'wrap' }}>
              <button onClick={() => toggleOpen(s.id)} className="tbtn-anim"
                title={open ? `收起快照内容：${s.name}` : `展开快照内容：${s.name}`}
                aria-label={open ? `收起快照内容：${s.name}` : `展开快照内容：${s.name}`}
                style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
                {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              <strong style={{ fontSize: 'var(--fs-l)', color: 'var(--text)', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{s.name}</strong>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                任务 {s.stats.tasks}（完成 {s.stats.doneTasks}）· 计划 {s.stats.plans}（完结 {s.stats.donePlans}）· 沉淀于 {relTime(s.history_at)}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                <button onClick={() => void restore(s)} disabled={busy} className="tbtn-anim snap-card-action"
                  title="恢复 — 该快照整体恢复为活跃项目（重新出现在任务/计划菜单）" aria-label={`恢复该快照：${s.name}`}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26, padding: 0, borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 'var(--fs-s)', cursor: 'pointer' }}>
                  <RotateCcw size={12} />
                </button>
                <button onClick={() => void toArchive(s)} disabled={busy} className="tbtn-anim snap-card-action"
                  title="归档删除 — 整个项目内容转入归档区（软删除，可恢复）" aria-label={`归档删除该快照：${s.name}`}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26, padding: 0, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--danger)', fontSize: 'var(--fs-s)', cursor: 'pointer' }}>
                  <Archive size={12} />
                </button>
              </span>
            </div>

            {open && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>任务快照（{s.tasks.length}）</div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {s.tasks.length === 0 && <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>无任务</div>}
                    {s.tasks.map((t) => (
                      <div key={t.id} title={t.description || t.handle_result || ''} style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', padding: '3px 0', borderBottom: '1px solid var(--surface-2)', display: 'flex', gap: 6 }}>
                        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', flexShrink: 0 }}>{t.task_no ?? '—'}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        <span style={{ fontSize: 'var(--fs-xs)', color: t.status === 'done' ? 'var(--success, #16a34a)' : 'var(--text-muted)', flexShrink: 0 }}>{t.status === 'done' ? '已完成' : '待办'}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>计划快照（{s.plans.length}）</div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {s.plans.length === 0 && <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>无计划</div>}
                    {s.plans.map((p) => (
                      <div key={p.id} title={p.description ?? ''} style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', padding: '3px 0', borderBottom: '1px solid var(--surface-2)', display: 'flex', gap: 6 }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                          {p.kind === 'milestone' ? '里程碑 · ' : ''}{PLAN_STATUS_LABEL[p.status] ?? p.status}{typeof p.progress === 'number' ? ` · ${p.progress}%` : ''}{p.duration_days !== null && p.duration_days !== undefined ? ` · ${p.duration_days}天` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
          <button onClick={() => setPage(Math.max(1, cur - 1))} disabled={cur <= 1} title="上一页" aria-label="上一页"
            style={{ cursor: cur <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {cur} / {pages} 页</span>
          <button onClick={() => setPage(Math.min(pages, cur + 1))} disabled={cur >= pages} title="下一页" aria-label="下一页"
            style={{ cursor: cur >= pages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur >= pages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}
    </section>
  );
}
