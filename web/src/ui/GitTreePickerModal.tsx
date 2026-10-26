import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch, Loader2, RefreshCw, Search, Tag, X } from 'lucide-react';
import { api } from '../api/client';
import type { Project } from '../api/client';
import { fullTime, relTime } from '../ui/format';
import {
  GIT_TREE_PAGE_SIZE,
  MAX_SELECTED_COMMITS,
  assignLanes,
  groupByRef,
  orderSelected,
  selectAt,
  summarizeSelection,
  toggleVisible,
  type GitRefName,
  type GitTreeCommit,
} from '../utils/gitTreeSelect';

/**
 * T03302：代码评审讲稿卡 · Git 树选范围弹窗（布局与点选语义参照 JetBrains 的 Git Log）。
 *
 * 为什么是弹窗：范围选择是一次「多步、可反悔」的动作（翻页、搜索、Shift 框选、跨页保持），
 * 铺在卡片里会把三区布局挤没；确认后才把 SHA 集合回传给卡片，卡片再按项目组装 `shape='commits'` 的范围。
 *
 * 三条不可让的边界：
 *  1. **取数失败 ≠ 没有提交**：未配工作空间 / 不是 git 仓库 / 没装 git / 网络异常各给一句话，
 *     列表空着但按钮禁用，避免用户以为「这仓没东西」；
 *  2. **跨页与搜索不丢选择**：已选 SHA 存在组件外的 `selectedByProject` 里，翻页/换分支只是改可视集；
 *  3. **上限由两端同口径把关**：前端截到 200 并说明被截条数，服务端 `normalizeSelectedCommits` 仍会拒。
 *
 * 折叠交互的取舍：分支行不做「伪树折叠」（一个提交可以同时属于两条分支，藏起来会撒谎），
 * 而是点分支 = 按该分支为起点重新取数（等价于 IDEA 的 branch filter），提交行自身可展开看 SHA/父/作者/提交者。
 */

/** `POST /api/plans/code-review-lecture/git-log` 响应（服务端 lectureGitLog 的前端镜像） */
interface GitLogResponse {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  commits: GitTreeCommit[];
  hasMore: boolean;
  skip: number;
  limit: number;
  scanned: number;
  scanTruncated: boolean;
  refs?: GitRefName[];
  error?: { kind: string; message: string };
}

const LANE_COLORS = ['var(--accent)', '#e0863a', '#3aa0e0', '#57b06a', '#b0579a', '#8a8f98'];

const boxStyle: React.CSSProperties = {
  fontSize: 'var(--fs-s)', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)',
};
const chipStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-secondary)',
};
const FONT_MONO = 'Consolas, Menlo, monospace';

export function GitTreePickerModal({ projects, activeProjectId, selectedByProject, onConfirm, onClose }: {
  readonly projects: Project[];
  readonly activeProjectId: string;
  /** 各项目已选 SHA（确认后由卡片写回；弹窗内改的是当前项目的这一份） */
  readonly selectedByProject: Record<string, string[]>;
  readonly onConfirm: (projectId: string, shas: string[]) => void;
  readonly onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(activeProjectId || projects[0]?.id || '');
  const [head, setHead] = useState('');
  const [allBranches, setAllBranches] = useState(false);
  const [search, setSearch] = useState('');
  const [commits, setCommits] = useState<GitTreeCommit[]>([]);
  const [refs, setRefs] = useState<GitRefName[]>([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>(selectedByProject[projectId] ?? []);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [foldRefs, setFoldRefs] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  const lanes = useMemo(() => assignLanes(commits), [commits]);
  const visibleRefs = useMemo(() => groupByRef(commits), [commits]);
  const summary = useMemo(() => summarizeSelection(commits, selected), [commits, selected]);

  // Esc = 取消（不丢已选：确认后才会写回卡片，取消保持原样）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 切项目 = 换一份已选与可视集，否则「在 A 项目选的提交」会串到 B 项目的范围里
  useEffect(() => {
    setSelected(selectedByProject[projectId] ?? []);
    setAnchor(null);
    setExpanded(new Set());
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(false); }, [projectId, head, allBranches]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(append: boolean) {
    if (!projectId) return;
    setLoading(true);
    setError('');
    const nextSkip = append ? commits.length : 0;
    try {
      const r = await api.post<GitLogResponse>('/plans/code-review-lecture/git-log', {
        projectId,
        head: allBranches ? undefined : head.trim(),
        all: allBranches,
        skip: nextSkip,
        limit: GIT_TREE_PAGE_SIZE,
        search: search.trim(),
      });
      if (!r.ok) {
        setError(r.error?.message ?? 'Git 取数失败');
        setCommits(append ? commits : []);
        setHasMore(false);
        return;
      }
      // 翻页追加按 SHA 去重：换分支/搜索窗口重叠时不能出现两行同样的提交
      const merged = append ? dedupe([...commits, ...r.commits]) : r.commits;
      setCommits(merged);
      setSkip(r.skip);
      setHasMore(r.hasMore);
      setScanTruncated(r.scanTruncated);
      if (r.refs) setRefs(r.refs);
      // 可视集变了就重排已选顺序（保持「新→旧」与列表一致），但不删列表外的历史选择
      setSelected((prev) => orderSelected(merged, prev));
    } catch (e) {
      // 网络异常与后端 5xx 都走这里：给出可复述的一句话，而不是一片空白列表
      setError(`无法连接到本机服务或取数被拒绝：${e instanceof Error ? e.message : String(e)}`);
      setCommits(append ? commits : []);
      setHasMore(false);
    } finally {
      setLoading(false);
      listRef.current?.focus();
    }
  }

  function onRowClick(index: number, e: React.MouseEvent) {
    const res = selectAt({ commits, selected, index, anchor, mods: { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey } });
    setSelected(res.selected);
    setAnchor(res.anchor);
    if (res.limited > 0) setError(`一次最多点选 ${MAX_SELECTED_COMMITS} 个提交，超出部分未加入（${res.limited} 条被忽略）`);
  }

  function toggleRowExpand(sha: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(sha)) n.delete(sha); else n.add(sha);
      return n;
    });
  }

  function confirm() {
    if (selected.length === 0) return;
    onConfirm(projectId, orderSelected(commits, selected));
  }

  const canConfirm = selected.length > 0 && !loading && !error;

  return (
    <div data-lck="git-tree-modal" role="dialog" aria-modal="true" aria-label="从 Git 树选择评审范围"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(1080px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--card-bg)', border: '1px solid var(--accent)', borderRadius: 10, padding: 14 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <GitBranch size={16} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 'var(--fs-l)' }}>Git 树选范围</strong>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            单击=只选这条 · Ctrl/Cmd+单击=加/减选 · Shift+单击=框选到上一条锚点；确认后按「每个选中提交相对第一父的增量」采集
          </span>
          <button type="button" onClick={onClose} aria-label="关闭 Git 树选择"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={15} />
          </button>
        </header>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
          {projects.length > 1 && (
            <select data-lck="git-tree-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={boxStyle} aria-label="选择项目仓库">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <input data-lck="git-tree-head" value={head} onChange={(e) => setHead(e.target.value)}
            placeholder="起点分支/标签/SHA（留空=HEAD）" disabled={allBranches}
            style={{ ...boxStyle, width: 200 }} aria-label="起点版本" />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-s)' }}>
            <input data-lck="git-tree-all" type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
            全部分支
          </label>
          <input data-lck="git-tree-search" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(false); }}
            placeholder="搜索标题/SHA/作者后回车" style={{ ...boxStyle, width: 200 }} aria-label="搜索提交" />
          <button type="button" onClick={() => void load(false)} disabled={loading} style={boxStyle} aria-label="重新取数" title="重新取数（当前条件）">
            {loading ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />}
          </button>
          <button type="button" data-lck="git-tree-search-btn" onClick={() => void load(false)} disabled={loading} style={boxStyle}>
            <Search size={13} style={{ marginRight: 4 }} />搜索
          </button>
        </div>

        {!foldRefs && visibleRefs.length > 0 && (
          <div data-lck="git-tree-refs" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => setFoldRefs(true)} style={{ ...chipStyle, cursor: 'pointer', background: 'var(--surface)' }} aria-label="收起分支列表">收起分支</button>
            {refs.length > 0 && <button type="button" data-lck="git-tree-ref-all" onClick={() => { setAllBranches(true); setHead(''); }} style={{ ...chipStyle, cursor: 'pointer', background: 'var(--surface)' }}>全部分支</button>}
            {visibleRefs.slice(0, 24).map((r) => (
              <button key={`${r.type}:${r.name}`} type="button" data-lck="git-tree-ref" data-ref={r.name}
                onClick={() => { setAllBranches(false); setHead(r.name); }}
                style={{ ...chipStyle, cursor: 'pointer', background: head === r.name && !allBranches ? 'var(--accent)' : 'var(--surface)', color: head === r.name && !allBranches ? '#fff' : 'var(--text-secondary)' }}>
                {r.type === 'tag' ? <Tag size={10} style={{ marginRight: 3, verticalAlign: '-1px' }} /> : null}{r.name}
              </button>
            ))}
          </div>
        )}
        {foldRefs && (
          <button type="button" data-lck="git-tree-refs-open" onClick={() => setFoldRefs(false)} style={{ ...chipStyle, cursor: 'pointer', marginBottom: 8, width: 'fit-content' }}>
            展开分支（{refs.length || visibleRefs.length}）
          </button>
        )}

        {error && <p data-lck="git-tree-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '2px 0 8px' }}>{error}</p>}

        <div ref={listRef} tabIndex={-1} data-lck="git-tree-rows" role="grid" aria-label="提交列表"
          style={{ flex: '1 1 auto', minHeight: 180, maxHeight: '48vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
          {!loading && commits.length === 0 && !error && (
            <p data-lck="git-tree-empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12, margin: 0 }}>
              这个仓库在当前条件下没有可显示的提交：换个分支、放宽搜索，或改用区间/粘贴 patch。
            </p>
          )}
          {commits.map((c, i) => {
            const checked = selected.includes(c.sha);
            const open = expanded.has(c.sha);
            return (
              <div key={c.sha} data-lck="git-tree-row" data-sha={c.sha} data-selected={checked ? '1' : '0'} role="row" aria-selected={checked}
                onClick={(e) => onRowClick(i, e)}
                style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 8px', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: checked ? 'var(--surface-2)' : 'transparent' }}>
                <input type="checkbox" checked={checked} readOnly tabIndex={-1} aria-label={`选择提交 ${c.short}`} style={{ pointerEvents: 'none' }} />
                <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'pre', minWidth: lanes.count * 10 }}>
                  {Array.from({ length: lanes.count }, (_, l) => (lanes.lanes[i] === l
                    ? <span key={l} style={{ color: LANE_COLORS[l % LANE_COLORS.length] }}>●</span>
                    : (lanes.through[i]?.includes(l) ? <span key={l} style={{ color: LANE_COLORS[l % LANE_COLORS.length] }}>│</span> : <span key="s"> </span>)))}
                </span>
                <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{c.short}</code>
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.subject}>{c.subject}</span>
                {c.refs.map((r) => <span key={`${r.type}:${r.name}`} style={chipStyle}>{r.name}</span>)}
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 90 }} title={fullTime(c.date)}>{relTime(c.date)}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 64 }} title={c.author}>{c.author}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); toggleRowExpand(c.sha); }} aria-label={open ? '收起提交详情' : '展开提交详情'}
                  aria-expanded={open} data-lck="git-tree-expand"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>
                  {open ? '▾' : '▸'}
                </button>
              </div>
            );
          })}
          {commits.map((c) => (expanded.has(c.sha) ? (
            <div key={`d-${c.sha}`} data-lck="git-tree-detail" data-sha={c.sha}
              style={{ padding: '4px 8px 6px 46px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: FONT_MONO, borderBottom: '1px solid var(--border)' }}>
              SHA {c.sha}<br />父 {c.parents.length === 0 ? '(根提交)' : c.parents.join(' ')}<br />
              作者 {c.author} · {fullTime(c.date)} · 选中它等于采集「相对第一父」的增量
            </div>
          ) : null))}
          {loading && <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 8, margin: 0 }}>取数中…</p>}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          {hasMore && (
            <button type="button" data-lck="git-tree-load-more" onClick={() => void load(true)} disabled={loading} style={boxStyle}>
              加载更多（已显示 {commits.length} 条）
            </button>
          )}
          {scanTruncated && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              搜索只扫描了最近 {GIT_TREE_PAGE_SIZE > 0 ? commits.length : 0} 条以内的窗口，可能还有更早的命中——换分支或翻页后再搜更准
            </span>
          )}
          <span data-lck="git-tree-selected" style={{ fontSize: 'var(--fs-s)', color: selected.length ? 'var(--text)' : 'var(--text-muted)' }}>
            已选 {summary.count} 个提交{summary.count > 0 ? `（${summary.runs} 段）` : ''}
            {project ? ` · 仓库 ${project.name}` : ''}
          </span>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>
            <input type="checkbox" checked={commits.length > 0 && selected.length === commits.length}
              onChange={(e) => setSelected(toggleVisible(commits, selected, e.target.checked))} />
            全选本页
          </label>
          <button type="button" data-lck="git-tree-cancel" onClick={onClose} style={boxStyle}>取消</button>
          <button type="button" data-lck="git-tree-confirm" onClick={confirm} disabled={!canConfirm}
            style={{ ...boxStyle, background: canConfirm ? 'var(--accent)' : 'var(--surface-2)', color: canConfirm ? '#fff' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed' }}>
            <Check size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />确认选择
          </button>
        </div>
      </div>
    </div>
  );
}

function dedupe(list: GitTreeCommit[]): GitTreeCommit[] {
  const seen = new Set<string>();
  const out: GitTreeCommit[] = [];
  for (const c of list) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push(c);
  }
  return out;
}
