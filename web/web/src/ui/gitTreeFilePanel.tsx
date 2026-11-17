/**
 * T05210：Git 树选范围弹窗的**右栏**——变更文件树 + 摘要（IDEA Git 视图的右半）。
 *
 * 三条设计取舍（都为了「不撒谎」）：
 *  1. **文件清单单独取**：左栏的 `git log` 不带文件清单（带上了就要为每一行的全部改动付一次
 *     `--raw --numstat`，100 行列表会慢一个数量级）。所以这里是「点选后才取」，并且按 40 个提交分片
 *     （服务端 `MAX_COMMIT_FILES_BATCH` 同一口径），分片进度显示成「读取中 k/n」而不是一个转圈。
 *  2. **缺失的提交要说话**：某个 SHA 在批量里没回来（rebase/force-push/gc 之后很常见），
 *     清单里就没有它——这时显式列一句「N 条提交的文件清单取不到」，绝不把空清单当成「它没改文件」。
 *  3. **跨仓库不假装能对比**：Base 对比只在选中记录同属一个仓库时开放。不同仓库的同名路径是两个文件，
 *     强行对比会得出「只改了 3 个文件」这种错结论。
 *
 * 渲染性能：单个仓库上千文件时走虚拟滚动（固定行高 + 上下占位），阈值与切片逻辑在
 * `utils/gitFileTree.ts`（`FILE_TREE_VIRTUAL_THRESHOLD` / `windowSlice`），本文件只把切片摊到 DOM。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { fullTime, relTime } from './format';
import { PILL } from './primitives';
import type { GitRefName } from '../utils/gitTreeSelect';
import {
  FILE_TREE_VIRTUAL_THRESHOLD,
  allDirPaths,
  buildFileTree,
  compareFileSets,
  ellipsisPath,
  fileStatsOf,
  flattenFileTree,
  groupCommitFilesByRepo,
  statusMeta,
  windowSlice,
  type CommitFileEntry,
  type FileDir,
  type FileLeaf,
  type FileTreeRow,
  type RepoCommitFiles,
} from '../utils/gitFileTree';
import { GIT_TREE_INDENT, GT_STATUS_WIDTH, repoColorVar } from './gitTreeTheme';

/** 与服务端 `gitCommitFiles.CommitFilesResult` 的前端镜像 */
interface CommitFilesResponse {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  repoSub: string;
  files: Record<string, CommitFileEntry[]>;
  missing: string[];
  limit: number;
  dropped: number;
  error?: { kind: string; message: string };
}

/** 右栏需要的一条「选中记录」——提交元信息 + 它属于哪个仓库 */
export interface DetailEntry {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  refs: GitRefName[];
  projectId: string;
  repoSub: string;
  repoLabel: string;
  /** `projectId\0repoSub`，与 `zipRepoKey` 同形（颜色与分组都以它为准） */
  repoKey: string;
}

const FONT_MONO = 'Consolas, Menlo, monospace';
/**
 * 单次请求最多点名多少个提交：与服务端 `gitCommitFiles.MAX_COMMIT_FILES_BATCH` 同值（40）。
 * 改这里必须同步改那边——本侧按它切分片，服务端按它截断；两边漂移会出现「明明是 41 个提交，
 * 第 41 个永远取不到清单」，而界面上只会显示少一个文件。
 */
const COMMIT_FILES_CHUNK = 40;
const chipStyle: React.CSSProperties = PILL;

/** 面板行：分组头 + 树行混在一个数组里，虚拟滚动才能只切一次 */
type PanelRow =
  | { kind: 'head'; key: string; repoKey: string; label: string; count: number; additions: number; deletions: number; sub: string }
  | { kind: 'node'; key: string; repoKey: string; row: FileTreeRow };

export function GitTreeFilePanel({ entries, colorIndex }: {
  readonly entries: readonly DetailEntry[];
  /** 仓库色索引（`repoColorMap` 的结果）：左右两栏必须消费同一份 */
  readonly colorIndex: Record<string, number>;
}) {
  const [filesBySha, setFilesBySha] = useState<Record<string, CommitFileEntry[]>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  /** 本次取数覆盖的「选择签名」：切换选择时清空旧文件，避免右栏短暂显示上一条记录的文件 */
  const [loadedSig, setLoadedSig] = useState('');
  const seqRef = useRef(0);

  const sig = useMemo(
    () => entries.map((e) => `${e.projectId}\u0000${e.repoSub}\u0000${e.sha}`).join('|'),
    [entries],
  );
  /** 取数闭包要读「此刻的选择」，但选择数组每次渲染都是新引用：
   *  进依赖会让「换一批文件」变成无限重取，故只让签名进依赖、数组走 ref。 */
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    const list = entriesRef.current;
    if (!list.length) {
      setFilesBySha({});
      setMissing([]);
      setError('');
      setLoadedSig('');
      setLoading(false);
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const stale = () => seqRef.current !== seq;
    // 按「项目 + 仓库」分组：混合时间线里一条选择可能横跨多个仓库，各自取各自的 .git
    const groups = new Map<string, { projectId: string; repoSub: string; shas: string[] }>();
    for (const e of list) {
      const g = groups.get(e.repoKey) ?? { projectId: e.projectId, repoSub: e.repoSub, shas: [] };
      if (!g.shas.includes(e.sha)) g.shas.push(e.sha);
      groups.set(e.repoKey, g);
    }
    const totalUnits = [...groups.values()].reduce((n, g) => n + Math.max(1, Math.ceil(g.shas.length / COMMIT_FILES_CHUNK)), 0);
    setLoading(true);
    setError('');
    setProgress({ done: 0, total: totalUnits });
    setMissing([]);
    setFilesBySha({});
    setLoadedSig(sig);
    void (async () => {
      const merged: Record<string, CommitFileEntry[]> = {};
      const gone: string[] = [];
      const problems: string[] = [];
      let done = 0;
      try {
        for (const g of groups.values()) {
          for (let i = 0; i < g.shas.length; i += COMMIT_FILES_CHUNK) {
            const chunk = g.shas.slice(i, i + COMMIT_FILES_CHUNK);
            const r = await api.post<CommitFilesResponse>('/git/commit-files', {
              projectId: g.projectId,
              repoSub: g.repoSub,
              shas: chunk,
            });
            if (stale()) return;
            if (!r?.ok) {
              problems.push(r?.error?.message ?? '变更文件取数失败');
            } else {
              Object.assign(merged, r.files ?? {});
              if (r.missing?.length) gone.push(...r.missing);
            }
            done += 1;
            setProgress({ done, total: totalUnits });
            // 边取边渲染：1000 个文件的大提交不必等全部分片回来才出图
            setFilesBySha({ ...merged });
          }
        }
        if (stale()) return;
        setMissing([...new Set(gone)]);
        if (problems.length) setError([...new Set(problems)].join('；'));
      } catch (e) {
        if (stale()) return;
        setError(`无法读取变更文件：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!stale()) setLoading(false);
      }
    })();
  }, [sig, reloadTick]);

  const ready = loadedSig === sig && !loading;
  const leavesByRepo = useMemo(() => {
    const commits: RepoCommitFiles[] = entries
      .filter((e) => filesBySha[e.sha])
      .map((e) => ({
        sha: e.sha,
        date: e.date,
        repoKey: e.repoKey,
        repoLabel: e.repoLabel,
        files: filesBySha[e.sha],
      }));
    return groupCommitFilesByRepo(commits);
  }, [entries, filesBySha]);

  const stats = useMemo(() => {
    const all = leavesByRepo.flatMap((g) => g.leaves);
    return fileStatsOf(all);
  }, [leavesByRepo]);

  /* ---------- Base 对比（只在同仓库、且 ≥2 条选中时开放） ---------- */
  const repoNames = useMemo(() => [...new Set(entries.map((e) => e.repoKey))], [entries]);
  const crossRepo = repoNames.length > 1;
  const [baseSha, setBaseSha] = useState('');
  useEffect(() => {
    // 选择变了就清空基准：留着上一条记录的基准会让「对比」静默对着错误的一侧算
    setBaseSha('');
  }, [sig]);
  const baseEntry = entries.find((e) => e.sha === baseSha) ?? null;
  const compareRows = useMemo(() => {
    if (!baseEntry || crossRepo) return null;
    const baseFiles = filesBySha[baseEntry.sha];
    if (!baseFiles) return null;
    const others: CommitFileEntry[] = [];
    for (const e of entries) {
      if (e.sha === baseEntry.sha) continue;
      for (const f of filesBySha[e.sha] ?? []) if (!others.some((o) => o.path === f.path)) others.push(f);
    }
    return compareFileSets(baseFiles, others);
  }, [baseEntry, crossRepo, entries, filesBySha]);

  /* ---------- 渲染行装配 ---------- */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 仓库身份 → 展示用坐标（分组头右侧那一段）。`repoKey` 是 `projectId\0repoSub` 的复合键，
   *  直接显示会把 projectId 也印出来，故这里单独留一份「人看的」子路径。 */
  const repoSubOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of entries) m[e.repoKey] = e.repoSub;
    return m;
  }, [entries]);
  const treeGroups = useMemo(
    () => leavesByRepo.map((g) => ({ ...g, nodes: buildFileTree(g.leaves) })),
    [leavesByRepo],
  );
  // 换提交就把新树的目录全展开（IDEA 的默认观感）；折叠态是「这一次查看」的局部状态，不跨记录复用
  useEffect(() => {
    const all = new Set<string>();
    for (const g of treeGroups) for (const p of allDirPaths(g.nodes)) all.add(`${g.repoKey}\u0000${p}`);
    setExpanded(all);
  }, [treeGroups]);

  const rows = useMemo<PanelRow[]>(() => {
    const out: PanelRow[] = [];
    if (compareRows) {
      const sections: { kind: 'only-others' | 'only-base' | 'both-different' | 'both-same'; title: string }[] = [
        { kind: 'only-others', title: '仅其余记录改过' },
        { kind: 'only-base', title: '仅基准记录改过' },
        { kind: 'both-different', title: '两边都改过，状态不同' },
        { kind: 'both-same', title: '两边都改过，状态相同' },
      ];
      for (const sec of sections) {
        const list = compareRows.filter((r) => r.kind === sec.kind);
        if (!list.length) continue;
        out.push({ kind: 'head', key: `cmp-${sec.kind}`, repoKey: repoNames[0] ?? '', label: sec.title, count: list.length, additions: 0, deletions: 0, sub: '' });
        for (const r of list) {
          out.push({
            kind: 'node', key: `cmp-${sec.kind}-${r.path}`, repoKey: repoNames[0] ?? '',
            row: {
              depth: 1,
              node: {
                // 对比列表是扁平的整路径（没有目录层可省），超长时中间省略，全路径留在 title 里
                kind: 'file', name: ellipsisPath(r.path, 72), path: r.path, depth: 1, status: r.status,
                additions: null, deletions: null, binary: false, shas: [], latestSha: '', statuses: [],
              },
            },
          });
        }
      }
      return out;
    }
    for (const g of treeGroups) {
      out.push({
        kind: 'head', key: `head-${g.repoKey}`, repoKey: g.repoKey, label: g.repoLabel,
        count: g.leaves.length, additions: 0, deletions: 0, sub: repoSubOf[g.repoKey] ?? '',
      });
      for (const row of flattenFileTree(g.nodes, expandedKeySet(expanded, g.repoKey))) {
        out.push({ kind: 'node', key: `n-${g.repoKey}-${row.node.path}`, repoKey: g.repoKey, row });
      }
    }
    return out;
  }, [compareRows, treeGroups, expanded, repoNames, repoSubOf]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, rows.length]);

  const virtual = rows.length > FILE_TREE_VIRTUAL_THRESHOLD;
  const slice = virtual ? windowSlice(rows.length, scrollTop, viewportH) : { start: 0, end: rows.length, padTop: 0, padBottom: 0 };
  const visible = rows.slice(slice.start, slice.end);

  function toggleDir(repoKey: string, path: string) {
    const key = `${repoKey}\u0000${path}`;
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  /* ---------- 空/加载/错误态 ---------- */
  if (!entries.length) {
    return (
      <section data-lck="git-tree-detail" aria-label="变更文件与提交摘要"
        style={panelStyle}>
        <div style={{ padding: '18px 14px', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>变更文件</div>
          在左侧点选一条提交，这里显示它改动了哪些文件；勾选多条则汇总成一份综合文件树。
        </div>
      </section>
    );
  }

  const onlyOne = entries.length === 1;

  return (
    <section data-lck="git-tree-detail" aria-label="变更文件与提交摘要" style={panelStyle}>
      {/* 头部：仓库色点 + 名称 + 文件统计（多选时是聚合口径） */}
      <header data-lck="git-tree-detail-head"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', flex: '0 0 auto',
          borderBottom: '1px solid var(--border)', background: 'var(--gt-panel-head)',
          fontSize: 'var(--fs-s)', minWidth: 0,
        }}>
        <span aria-hidden style={{
          width: 9, height: 9, borderRadius: 2, flex: '0 0 auto',
          background: repoColorVar(colorIndex[entries[0].repoKey]),
        }} />
        <strong style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '46%' }}
          title={onlyOne ? entries[0].repoLabel : `${entries.length} 条提交 · ${repoNames.length} 个仓库`}>
          {onlyOne ? entries[0].repoLabel : `${entries.length} 条提交`}
        </strong>
        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {ready ? `${stats.files} 个文件` : '统计中…'}
        </span>
        {ready && stats.additions + stats.deletions > 0 && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--gt-status-add)' }}>+{stats.additions}</span>
            {' '}
            <span style={{ color: 'var(--gt-status-del)' }}>−{stats.deletions}</span>
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          {/* Base 对比入口：同仓库才开放，跨仓库给出可读的原因而不是一个灰掉的控件 */}
          {entries.length >= 2 && (
            crossRepo ? (
              <span data-lck="git-tree-base-disabled" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                跨仓库不可对比
              </span>
            ) : (
              <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}
                title="选一条作为基准记录，右栏改为「基准 / 其余记录」的文件集对比">
                基准记录
                <select data-lck="git-tree-base-select" value={baseSha} onChange={(e) => setBaseSha(e.target.value)}
                  style={{ fontSize: 'var(--fs-xs)', padding: '1px 2px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', maxWidth: 210 }}>
                  <option value="">不设基准（汇总文件树）</option>
                  {entries.map((e) => <option key={e.sha} value={e.sha}>{`${e.short} ${e.subject}`.slice(0, 60)}</option>)}
                </select>
              </label>
            )
          )}
          <button type="button" data-lck="git-tree-detail-refresh" onClick={() => setReloadTick((n) => n + 1)}
            disabled={loading} title="重新读取变更文件" aria-label="重新读取变更文件"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: loading ? 'default' : 'pointer', padding: 0, display: 'inline-flex' }}>
            <RefreshCw size={12} className={loading ? 'aispin' : undefined} />
          </button>
        </div>
      </header>

      {error && (
        <p data-lck="git-tree-detail-error" style={{ margin: 0, padding: '4px 8px', fontSize: 'var(--fs-xs)', color: 'var(--danger)', borderBottom: '1px solid var(--border)' }}>
          {error}
        </p>
      )}
      {missing.length > 0 && (
        <p data-lck="git-tree-detail-missing" style={{ margin: 0, padding: '4px 8px', fontSize: 'var(--fs-xs)', color: '#b45309', borderBottom: '1px solid var(--border)' }}
          title={missing.join(' ')}>
          {missing.length} 条提交的变更清单取不到（可能已被 rebase/force-push 丢弃），其改动未计入下方汇总。
        </p>
      )}

      {/* 文件区：一个滚动容器装所有分组，虚拟滚动只切这一份行数组 */}
      <div ref={scrollRef} data-lck="git-tree-files" className="gt-tree gt-tree-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{ flex: '1 1 auto', minHeight: 90, overflow: 'auto', background: 'var(--gt-panel-bg)' }}>
        {loading && !ready && rows.length === 0 && (
          <p data-lck="git-tree-files-loading" style={{ margin: 0, padding: '10px 12px', fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
            <Loader2 size={12} className="aispin" style={{ marginRight: 5, verticalAlign: '-2px' }} />
            正在读取变更文件{progress.total > 1 ? `（${progress.done}/${progress.total} 批）` : ''}…
          </p>
        )}
        {ready && rows.length === 0 && !error && (
          <p data-lck="git-tree-files-empty" style={{ margin: 0, padding: '10px 12px', fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
            这条提交没有改动任何文件（空提交或仅改了子模块指针）。
          </p>
        )}
        {virtual && slice.padTop > 0 && <div style={{ height: slice.padTop }} aria-hidden />}
        {visible.map((row) => (
          row.kind === 'head'
            ? <GroupHead key={row.key} label={row.label} count={row.count} repoKey={row.repoKey} colorIndex={colorIndex} sub={row.sub} />
            : <TreeRow key={row.key} row={row.row} repoKey={row.repoKey} colorIndex={colorIndex}
              expanded={expanded.has(`${row.repoKey}\u0000${row.row.node.path}`)}
              compareMode={!!compareRows}
              onToggle={() => toggleDir(row.repoKey, row.row.node.path)} />
        ))}
        {virtual && slice.padBottom > 0 && <div style={{ height: slice.padBottom }} aria-hidden />}
        {loading && ready && (
          <p style={{ margin: 0, padding: '6px 12px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            后续分批读取中（{progress.done}/{progress.total}）…
          </p>
        )}
      </div>

      {/* 底部摘要区：单条 = 提交详情；多条 = 选中清单 + 聚合统计 */}
      <SummaryBox entries={entries} baseSha={baseSha} compareRows={compareRows} stats={stats}
        leavesByRepo={leavesByRepo} filesBySha={filesBySha} ready={ready} />
    </section>
  );
}

/** 把全局展开集合切片成「某仓库可见的目录集合」（目录 key 带仓库前缀，避免跨仓库同名目录串台） */
function expandedKeySet(all: ReadonlySet<string>, repoKey: string): ReadonlySet<string> {
  const prefix = `${repoKey}\u0000`;
  const out = new Set<string>();
  for (const k of all) if (k.startsWith(prefix)) out.add(k.slice(prefix.length));
  return out;
}

const panelStyle: React.CSSProperties = {
  flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column',
  border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)',
};

/** 仓库/对比分组头：色块 + 名称 + 数量（多选聚合时右栏的视觉分节，对应 IDEA 的仓库分组） */
function GroupHead({ label, count, repoKey, colorIndex, sub }: {
  readonly label: string;
  readonly count: number;
  readonly repoKey: string;
  readonly colorIndex: Record<string, number>;
  readonly sub: string;
}) {
  return (
    <div data-lck="git-tree-file-group" data-repo-key={repoKey} data-count={count}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', position: 'sticky', top: 0, zIndex: 1,
        borderBottom: '1px solid var(--border)', background: 'var(--gt-panel-head)',
        fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-secondary)',
      }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: repoColorVar(colorIndex[repoKey]) }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{count} 个文件</span>
      {sub && <code style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontWeight: 400, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }} title={sub}>{sub}</code>}
    </div>
  );
}

/**
 * 一行树节点。目录可折叠；文件行显示状态字母 + 增删行数（聚合视图改显示「改过 K 次」）。
 *
 * 文件名的颜色 = 该记录所属仓库的标识色（需求「左→右映射」的落点）：左侧色条、分组色块、
 * 这里的文件名三处同源，用户不必读仓库名就能对上。
 */
function TreeRow({ row, repoKey, colorIndex, expanded, compareMode, onToggle }: {
  readonly row: FileTreeRow;
  readonly repoKey: string;
  readonly colorIndex: Record<string, number>;
  readonly expanded: boolean;
  readonly compareMode: boolean;
  readonly onToggle: () => void;
}) {
  const node = row.node;
  const isDir = node.kind === 'dir';
  const color = repoColorVar(colorIndex[repoKey]);
  const meta = isDir ? null : statusMeta((node as FileLeaf).status);
  const leaf = isDir ? null : node as FileLeaf;
  const indent = 6 + row.depth * GIT_TREE_INDENT;
  return (
    <div className="gt-row" data-lck="git-tree-file-row" data-kind={isDir ? 'dir' : 'file'}
      data-status={leaf?.status} data-path={node.path}
      onClick={isDir ? onToggle : undefined}
      onKeyDown={isDir ? (e) => {
        // 目录行是 role=button 的 div：不给键盘通路的话「可折叠」对键盘用户等于不存在
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
      } : undefined}
      role={isDir ? 'button' : undefined}
      tabIndex={isDir ? 0 : undefined}
      aria-expanded={isDir ? expanded : undefined}
      title={node.path}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, paddingLeft: indent, paddingRight: 8,
        cursor: isDir ? 'pointer' : 'default', fontSize: 'var(--fs-s)', minWidth: 0,
      }}>
      {isDir
        ? <span style={{ display: 'inline-flex', width: 10, flex: '0 0 auto', color: 'var(--text-muted)' }} aria-hidden>
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        : <span style={{ width: 10, flex: '0 0 auto' }} aria-hidden />}
      {isDir
        ? (expanded ? <FolderOpen size={12} style={{ flex: '0 0 auto', color: 'var(--text-muted)' }} aria-hidden />
          : <Folder size={12} style={{ flex: '0 0 auto', color: 'var(--text-muted)' }} aria-hidden />)
        : <FileText size={12} style={{ flex: '0 0 auto', color }} aria-hidden />}
      <span className="gt-file-path" style={{
        flex: isDir ? '1 1 auto' : '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: isDir ? 'var(--text)' : color,
        fontWeight: isDir ? 600 : 400,
      }}>
        {node.name}
      </span>
      {/* 目录的文件数只在**折叠**时显示：展开后子项自己会数，逐层印同一个数字只是噪声 */}
      {isDir && !expanded && (
        <span style={{ flex: '0 0 auto', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{(node as FileDir).fileCount}</span>
      )}
      {leaf && meta && (
        <>
          {/* 状态字母紧跟文件名（需求「文件名称旁」），行宽富余时把增删数字推到最右，列对齐不跳动 */}
          <span data-lck="git-tree-file-status" title={meta.label}
            style={{ flex: '0 0 auto', width: GT_STATUS_WIDTH, textAlign: 'center', fontFamily: FONT_MONO, fontWeight: 700, fontSize: 'var(--fs-xs)', color: meta.color }}>
            {meta.letter}
          </span>
          <span aria-hidden style={{ flex: '1 1 auto' }} />
          <span style={{ flex: '0 0 auto', fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 48, textAlign: 'right' }}>
            {compareMode
              ? (leaf.statuses.length > 1 ? '状态不一' : '')
              : leaf.shas.length > 1
                ? `改过 ${leaf.shas.length} 次`
                : leaf.binary ? '二进制' : `+${leaf.additions ?? 0} −${leaf.deletions ?? 0}`}
          </span>
        </>
      )}
    </div>
  );
}

/** 底部摘要区：单条给出提交元信息；多条给出选中清单与聚合统计 */
function SummaryBox({ entries, baseSha, compareRows, stats, leavesByRepo, filesBySha, ready }: {
  readonly entries: readonly DetailEntry[];
  readonly baseSha: string;
  readonly compareRows: ReturnType<typeof compareFileSets> | null;
  readonly stats: ReturnType<typeof fileStatsOf>;
  readonly leavesByRepo: ReturnType<typeof groupCommitFilesByRepo>;
  readonly filesBySha: Record<string, CommitFileEntry[]>;
  readonly ready: boolean;
}) {
  const one = entries.length === 1 ? entries[0] : null;
  return (
    <div data-lck="git-tree-summary"
      className="gt-tree-scroll"
      style={{
        flex: '0 0 auto', maxHeight: '34%', overflow: 'auto', borderTop: '1px solid var(--border)',
        padding: '6px 9px', background: 'var(--surface)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)',
      }}>
      {one ? (
        <>
          <div data-lck="git-tree-summary-subject" style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
            {one.subject}
          </div>
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'center' }}>
            <code style={{ fontFamily: FONT_MONO, color: 'var(--text)' }} data-lck="git-tree-summary-sha">{one.sha.slice(0, 12)}</code>
            <span data-lck="git-tree-summary-author">作者 {one.author}</span>
            <span title={fullTime(one.date)}>{fullTime(one.date)}（{relTime(one.date)}）</span>
          </div>
          <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'center' }}>
            <span data-lck="git-tree-summary-stat">
              {ready ? `${stats.files} 个文件` : '统计中…'}
              {ready && stats.additions + stats.deletions > 0 ? ` · +${stats.additions} −${stats.deletions}` : ''}
              {ready && stats.binary > 0 ? ` · 二进制 ${stats.binary}` : ''}
              {ready ? ` · 新增 ${stats.byStatus.A} / 修改 ${stats.byStatus.M} / 删除 ${stats.byStatus.D}` : ''}
            </span>
            <span title={one.parents.length ? one.parents.join(' ') : '根提交'} data-lck="git-tree-summary-parents">
              父 {one.parents.length === 0 ? '(根提交)' : one.parents.map((p) => p.slice(0, 7)).join(' ')}
            </span>
          </div>
          {one.refs.length > 0 && (
            <div data-lck="git-tree-summary-refs" style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {one.refs.map((r) => <span key={`${r.type}:${r.name}`} style={{ ...chipStyle, fontSize: 'var(--fs-xs)' }} title={r.type === 'branch' ? '本地分支' : r.type === 'remote' ? '远程分支' : '标签'}>{r.name}</span>)}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'center' }}>
            <span data-lck="git-tree-summary-stat" style={{ color: 'var(--text)' }}>
              已选 {entries.length} 条提交 · 汇总 {ready ? `${stats.files} 个文件` : '统计中…'}
              {ready ? ` · 新增 ${stats.byStatus.A} / 修改 ${stats.byStatus.M} / 删除 ${stats.byStatus.D}` : ''}
            </span>
            {leavesByRepo.length > 0 && (
              <span data-lck="git-tree-summary-repos">
                {leavesByRepo.map((g) => `${g.repoLabel} ${g.leaves.length} 个`).join(' · ')}
              </span>
            )}
          </div>
          {compareRows && baseSha && (
            <div data-lck="git-tree-compare-stat" style={{ marginTop: 3 }}>
              基准对比：仅其余记录 {compareRows.filter((r) => r.kind === 'only-others').length} 个 · 仅基准 {compareRows.filter((r) => r.kind === 'only-base').length} 个 ·
              两边状态不同 {compareRows.filter((r) => r.kind === 'both-different').length} 个 · 状态相同 {compareRows.filter((r) => r.kind === 'both-same').length} 个
            </div>
          )}
          <ul data-lck="git-tree-summary-list" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
            {entries.slice(0, 20).map((e) => (
              <li key={e.sha} data-lck="git-tree-summary-item" style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '1px 0' }}>
                <code style={{ fontFamily: FONT_MONO, color: 'var(--text-muted)', flex: '0 0 auto' }}>{e.short}</code>
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.subject}>{e.subject}</span>
                <span style={{ flex: '0 0 auto', color: 'var(--text-muted)' }}>
                  {(filesBySha[e.sha]?.length ?? 0)} 个文件{e.repoLabel ? ` · ${e.repoLabel}` : ''}
                </span>
              </li>
            ))}
            {entries.length > 20 && (
              <li style={{ color: 'var(--text-muted)' }}>…另有 {entries.length - 20} 条（右栏只列前 20 条，确认范围不受影响）</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 左栏行的仓库色条：与右栏同名变量，保证左→右同色
 * ------------------------------------------------------------------ */

/** 左栏每行最左侧的仓库色条（IDEA 的变更集色块观感）；单仓库平铺视图不渲染 */
export function RepoStripe({ repoKey, colorIndex }: {
  readonly repoKey: string;
  readonly colorIndex: Record<string, number>;
}) {
  return (
    <span aria-hidden data-lck="git-tree-row-stripe" data-repo-key={repoKey}
      style={{ flex: '0 0 auto', alignSelf: 'stretch', width: 3, minHeight: 12, borderRadius: 2, background: repoColorVar(colorIndex[repoKey]) }} />
  );
}
