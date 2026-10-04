/**
 * T01485：测试用例面板主体（PRD-测试用例管理 §7 / §9.1 / §12 文件清单 #11）。
 *
 * 职责边界：本文件只做「取数 + 状态 + 动作」，渲染拆给
 * `TestCaseToolbar`（第一行工具栏与批量条）/ `TestCaseFilterBar`（第二行新增与筛选）/
 * `TestCaseTable`（列、行内编辑、步骤展开、空态、分页）——四文件合计仍各自守住「单文件 ≤600 行」。
 *
 * 状态一律 `useSessionState`（§7.1 明令，对照反面案例 `ReqMatrixPanel` 的 14 个裸 `useState`）：
 * 切页/刷新后面板保持展开、筛选、分页与选中态，符合移动端/桌面端一致的续写预期。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { useSessionState } from '../ui/session';
import { saveBlob } from '../utils/download';
import { TestCaseToolbar } from './TestCaseToolbar';
import { TestCaseFilterBar } from './TestCaseFilterBar';
import { TestCaseTable } from './TestCaseTable';
import {
  EMPTY_FILTERS, buildExportBody, buildListQuery, hasActiveFilter, scopeOf,
  type CaseBatchFields, type CaseCoverage, type CaseFilters, type CaseMeta, type CasePatchBody,
  type CaseRow, type CaseStats, type ReqLite,
} from './testCaseModel';

/** 列表响应（服务端 `TestCaseService.list`） */
interface CaseListRes { total: number; items: CaseRow[] }

export function TestCasePanel({ projectId, focusReqId, focusSeq, onLocateReq, onClose }: {
  readonly projectId: string;
  /** 需求跟踪矩阵下钻带来的筛选需求 id（空串=不过滤，§7.1） */
  readonly focusReqId?: string;
  /**
   * T01486 A4：下钻序号。只靠 `focusReqId` 去重会让「同一需求重复下钻」静默失效——
   * 用户手动清掉筛选后再点同一个「用例 N」chip，意图值没变、effect 不重跑，按钮看上去就是坏的。
   * 父级每次点击自增序号，本面板据此判定「这是一次新意图」，而不是「这个需求我又见了一次」。
   */
  readonly focusSeq?: number;
  /**
   * T01486 §4.3：用例侧点「关联需求」chip 反向跳矩阵。由父级负责展开矩阵并定位行；
   * 没传时退化为本面板内的按需求筛选（用例侧至少得有个可见反馈，不能点了什么都不发）。
   */
  readonly onLocateReq?: (reqId: string) => void;
  readonly onClose: () => void;
}) {
  // ---------- 会话态（§7.1 会话键表） ----------
  const [reqFilter, setReqFilter] = useSessionState<string>('tc.reqFilter', '');
  const [keyword, setKeyword] = useSessionState<string>('tc.keyword', '');
  const [filters, setFilters] = useSessionState<CaseFilters>('tc.filters', EMPTY_FILTERS);
  const [multi, setMulti] = useSessionState<boolean>('tc.multi', false);
  const [selIds, setSelIds] = useSessionState<string[]>('tc.selIds', []);
  const [page, setPage] = useSessionState<number>('tc.page', 0);
  const [pageSize, setPageSize] = useSessionState<number>('tc.pageSize', 200);
  const [expandedId, setExpandedId] = useSessionState<string>('tc.expanded', '');
  const [newTitle, setNewTitle] = useSessionState<string>('tc.newTitle', '');
  const [filterOpen, setFilterOpen] = useSessionState<boolean>('tc.filterOpen', false);
  // 「未覆盖的需求」是覆盖度视图而非用例筛选，独立成键，避免与 filters.orphanOnly 双写互相覆盖
  const [uncoveredOnly, setUncoveredOnly] = useSessionState<boolean>('tc.uncovered', false);

  // ---------- 运行态（派生数据与瞬时反馈，不需要跨页恢复） ----------
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<CaseMeta | null>(null);
  const [stats, setStats] = useState<CaseStats>({ total: 0, linked: 0, orphan: 0 });
  const [coverage, setCoverage] = useState<CaseCoverage | null>(null);
  const [reqs, setReqs] = useState<ReqLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  // 保存失败时 +1，让表格 `tbody` 重挂载，把行内输入框回落到库里真实值
  const [syncNonce, setSyncNonce] = useState(0);
  const allRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); }, []);

  /**
   * 关键词防抖：`tc.keyword` 是输入框回显值（逐字符变化），实际参与取数的是 300ms 稳定后的值。
   * 不防抖则每个按键一次列表请求（§11 性能：用例量级远大于矩阵）。
   */
  const [kwArg, setKwArg] = useState(keyword.trim());
  useEffect(() => {
    const t = setTimeout(() => setKwArg(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    try {
      const [list, m, st, cv, rq] = await Promise.all([
        api.get<CaseListRes>(buildListQuery({ projectId, reqId: reqFilter, keyword: kwArg, filters, pageSize, page })),
        api.get<CaseMeta>(`/plans/test-cases/meta?projectId=${encodeURIComponent(projectId)}`).catch(() => null),
        api.get<CaseStats>(`/plans/test-cases/stats?projectId=${encodeURIComponent(projectId)}`).catch(() => ({ total: 0, linked: 0, orphan: 0 })),
        api.get<CaseCoverage>(`/plans/test-cases/coverage?projectId=${encodeURIComponent(projectId)}`).catch(() => null),
        api.get<ReqLite[]>(`/plans/prd-requirements?projectId=${encodeURIComponent(projectId)}`)
          .then((v) => v.map((r) => ({ id: r.id, req_no: r.req_no, title: r.title }))).catch(() => []),
      ]);
      setRows(list.items);
      setTotal(list.total);
      setMeta(m);
      setStats(st);
      setCoverage(cv);
      setReqs(rq);
      // 删完当页 / 筛选变窄后停在越界页：回落首页，否则用户看到的是「空列表 + 页码还在第 3 页」
      if (list.items.length === 0 && list.total > 0 && page > 0) setPage(0);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId, reqFilter, kwArg, filters, pageSize, page, flash, setPage]);

  useEffect(() => { void load(); }, [load]);

  // 服务端写操作末尾 notifyChange('plans')（§6.7）——外部改动（AI 生成、MCP、其他端）无需手动刷新
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 订阅只建一次：取数函数经 loadRef 转发，避开“筛选一变就重连 SSE”
    const close = api.openChangeStream((kind) => {
      if (kind !== 'plans') return;
      // 自身写操作也会触发广播，合并 300ms 内的连续通知，避免一次批量保存打出 N 次列表请求
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void loadRef.current(); }, 300);
    });
    return () => { close(); if (timer) clearTimeout(timer); };
  }, []);

  // 多选表头半选态（与 `ReqMatrixPanel` 同机制）
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selIds.length > 0 && selIds.length < total;
  }, [selIds, total]);

  // 矩阵下钻：父级把需求 id 放进来 → 回填筛选并退出其他视图（§4.3）
  // 去重看 (id, seq) 这一对：id 相同但 seq 变了就是新意图；两者都没变而 effect 因 filters
  // 变更重跑时，必须早退，否则会把用户手动改的筛选又拽回下钻的那个需求
  const lastFocus = useRef('');
  const lastSeq = useRef(-1);
  useEffect(() => {
    const id = focusReqId ?? '';
    const seq = focusSeq ?? 0;
    if (!id || (seq === lastSeq.current && id === lastFocus.current)) return;
    lastSeq.current = seq;
    lastFocus.current = id;
    setReqFilter(id);
    setUncoveredOnly(false);
    setFilters({ ...filters, orphanOnly: false });
    setPage(0);
  }, [focusReqId, focusSeq, setReqFilter, setUncoveredOnly, setFilters, setPage, filters]);

  /** 统一写入口：成功后提示并刷新，失败时提示服务端文案并重挂载表格（防界面与库里不一致） */
  const patchCase = useCallback(async (id: string, patch: CasePatchBody, label: string): Promise<void> => {
    setBusy(true);
    try {
      await api.patch(`/plans/test-cases/${id}`, patch);
      flash(label);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
      setSyncNonce((n) => n + 1);
      await load();
    } finally {
      setBusy(false);
    }
  }, [flash, load]);

  const addCase = useCallback(async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title) return flash('请输入用例标题');
    setBusy(true);
    try {
      await api.post('/plans/test-cases', { projectId, title, ...(reqFilter ? { reqId: reqFilter } : {}) });
      setNewTitle('');
      flash('已新增用例');
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newTitle, projectId, reqFilter, flash, load, setNewTitle]);

  const removeCase = useCallback(async (row: CaseRow): Promise<void> => {
    if (!(await askConfirm(`删除用例「${row.case_no} ${row.title}」？\n\n其 ${row.steps.length} 个步骤一并删除，此操作不可撤销。`))) return;
    setBusy(true);
    try {
      await api.del(`/plans/test-cases/${row.id}`);
      setSelIds(selIds.filter((x) => x !== row.id));
      if (expandedId === row.id) setExpandedId('');
      flash('已删除用例及其步骤');
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selIds, expandedId, flash, load, setSelIds, setExpandedId]);

  const duplicateCases = useCallback(async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return flash('请先勾选用例');
    setBusy(true);
    try {
      const r = await api.post<{ ids: string[] }>('/plans/test-cases/duplicate', { ids });
      flash(`已复制 ${r.ids.length} 条用例（编号自动重排，副本回到草稿状态）`);
      setSelIds([]);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [flash, load, setSelIds]);

  const batchPatch = useCallback(async (fields: CaseBatchFields, label: string): Promise<void> => {
    if (selIds.length === 0) return;
    setBusy(true);
    try {
      const r = await api.patch<{ updated: number }>('/plans/test-cases/batch', { ids: selIds, patch: fields });
      flash(`已把 ${r.updated} 条用例${label}`);
      setSelIds([]);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selIds, flash, load, setSelIds]);

  const batchDelete = useCallback(async (): Promise<void> => {
    if (selIds.length === 0) return;
    if (!(await askConfirm(`删除选中的 ${selIds.length} 条测试用例？\n\n其步骤一并删除，此操作不可撤销。`))) return;
    setBusy(true);
    try {
      const r = await api.del<{ deleted: number }>('/plans/test-cases/batch', { ids: selIds });
      flash(`已删除 ${r.deleted} 条用例及其步骤`);
      setSelIds([]);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selIds, flash, load, setSelIds]);

  /** 全选作用于当前筛选结果（服务端 total 范围内），非仅当前页（§7.5） */
  const selectAll = useCallback(async (): Promise<void> => {
    if (selIds.length >= total && total > 0) return setSelIds([]);
    const q = buildListQuery({ projectId, reqId: reqFilter, keyword: kwArg, filters, pageSize: 0, page: 0 });
    try {
      const r = await api.get<CaseListRes>(q);
      setSelIds(r.items.map((x) => x.id));
      flash(`已选中当前筛选结果 ${r.items.length} 条`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, reqFilter, kwArg, filters, selIds, total, flash, setSelIds]);

  /**
   * 导出范围文案（§7.6）。必须与下方 `exportCases` 实际下发的条件同源：
   * 菜单写「全部 N 条（含关键词…）」而请求体不带关键词，就是提示与内容不一致（T01485 留下的口径裂缝，本单补掉）。
   */
  const exportScope = ((): string => {
    if (selIds.length > 0) return `选中的 ${selIds.length} 条`;
    if (reqFilter) {
      const hit = reqs.find((r) => r.id === reqFilter);
      return hit ? `需求 ${hit.req_no} ${hit.title}`.trim() : '当前筛选需求下的用例';
    }
    if (hasActiveFilter(filters, kwArg, '')) {
      return kwArg ? `当前筛选结果 ${total} 条（关键词「${kwArg}」）` : `当前筛选结果 ${total} 条`;
    }
    return `全部 ${stats.total} 条`;
  })();

  const exportCases = useCallback(async (format: string): Promise<void> => {
    setExporting(true);
    try {
      const r = await api.postDownload('/plans/test-cases/export',
        buildExportBody({ projectId, reqId: reqFilter, keyword, filters, ids: selIds, format }));
      saveBlob(r.blob, r.filename);
      flash(`已导出 ${r.filename}`);
    } catch (e) {
      flash(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }, [projectId, selIds, reqFilter, keyword, filters, flash]);

  const setFilter = useCallback((patch: Partial<CaseFilters>): void => {
    setFilters({ ...filters, ...patch });
    setPage(0);
  }, [filters, setFilters, setPage]);

  const clearFilter = useCallback((): void => {
    setFilters(EMPTY_FILTERS);
    setKeyword('');
    setReqFilter('');
    setUncoveredOnly(false);
    setPage(0);
  }, [setFilters, setKeyword, setReqFilter, setUncoveredOnly, setPage]);

  const scope = scopeOf(filters, uncoveredOnly);
  const filtered = hasActiveFilter(filters, keyword, reqFilter) || uncoveredOnly;
  const uncovered = (coverage?.byReq ?? []).filter((r) => r.caseCount === 0)
    .map((r) => ({ reqId: r.reqId, reqNo: r.reqNo, title: r.title }));

  return (
    <section aria-label="测试用例面板" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 12, background: 'var(--card-bg)' }}>
      <TestCaseToolbar meta={meta} stats={stats} multi={multi} selIds={selIds} total={total} filterOpen={filterOpen}
        loading={busy} exporting={exporting} exportScope={exportScope} reqs={reqs}
        onToggleMulti={() => { setMulti(!multi); setSelIds([]); }}
        onToggleFilter={() => setFilterOpen(!filterOpen)}
        onRefresh={() => void load()}
        onClose={onClose}
        onExport={(f) => void exportCases(f)}
        onBatch={(fields, label) => void batchPatch(fields, label)}
        onBatchDelete={() => void batchDelete()}
        onDuplicate={() => void duplicateCases(selIds)}
        onSelectAll={() => void selectAll()} />

      <TestCaseFilterBar meta={meta} reqs={reqs} reqFilter={reqFilter} scope={scope} newTitle={newTitle} keyword={keyword}
        filters={filters} filterOpen={filterOpen} busy={busy} notice={notice}
        onNewTitle={setNewTitle} onAdd={() => void addCase()}
        onScope={(v) => {
          setUncoveredOnly(v === 'uncovered');
          setFilters({ ...filters, orphanOnly: v === 'orphan' });
          setPage(0);
        }}
        onKeyword={setKeyword} onFilter={setFilter} onClear={clearFilter} />

      <TestCaseTable meta={meta} reqs={reqs} rows={rows} total={total} page={page} pageSize={pageSize} multi={multi}
        selIds={selIds} expandedId={expandedId} scope={scope} uncovered={uncovered} filtered={filtered} busy={busy}
        syncNonce={syncNonce} allRef={allRef}
        onToggleExpand={(id) => setExpandedId(expandedId === id ? '' : id)}
        onToggleSel={(id) => setSelIds(selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id])}
        onToggleAll={() => void selectAll()}
        onPatch={(id, patch, label) => void patchCase(id, patch, label)}
        onRemove={(row) => void removeCase(row)}
        onDuplicate={(row) => void duplicateCases([row.id])}
        onLocateReq={(reqId) => {
          if (onLocateReq) onLocateReq(reqId);
          else { setReqFilter(reqId); setPage(0); flash('已按该需求筛选用例'); }
        }}
        onCoverReq={(reqId) => { setUncoveredOnly(false); setReqFilter(reqId); setPage(0); flash('已切到该需求，在上方输入框回车即可补用例'); }}
        onClearFilter={clearFilter}
        onPage={(p) => setPage(Math.max(0, p))}
        onPageSize={(s) => { setPageSize(s); setPage(0); }} />
    </section>
  );
}
