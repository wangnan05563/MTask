import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Database, Download, FileUp, Pencil, Plus, RefreshCw, Search, Table2, Trash2, X } from 'lucide-react';

/**
 * 数据库维护 Tab（设置 > 数据维护，位于「数据迁移」右侧）。
 * 参考 17_xianyu DatabaseAdmin 页面实现的等效功能：业务表在线 CRUD +
 * 分页检索 + CSV/JSON 导入导出 + 表结构查看；危险操作需输入确认码。
 * 样式与设置页其余 Tab 一致：无 UI 库，CSS 变量适配主题。
 */

const CONFIRM_TOKEN = 'CONFIRM_DELETE';
const PAGE_SIZE = 50;

interface DbTableInfo {
  name: string;
  label: string;
  rows: number;
}

interface DbColumn {
  name: string;
  type: string;
  primary_key: boolean;
  nullable: boolean;
  default: string | null;
}

/** 表名 → 中文显示名（与后端 DbAdminService.TABLE_LABELS 一致） */
const TABLE_LABELS: Record<string, string> = {
  projects: '项目',
  tasks: '任务',
  task_categories: '任务分类',
  task_images: '任务图片',
  ai_tools: 'AI 工具',
  queues: '队列',
  queue_jobs: '队列作业',
  prompt_categories: '提示词分类',
  prompts: '提示词',
  app_settings: '应用设置',
};

type CellValue = string | number | boolean | null;

/** 单元格文本化：对象 JSON 化，其余 String()（NULL 由调用方单独处理） */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 按列类型推断表单控件类型（编辑/新增弹窗用） */
function inferFormType(colType: string): 'number' | 'checkbox' | 'textarea' | 'text' {
  const t = colType.toUpperCase();
  if (t.includes('INT') || t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUMERIC')) return 'number';
  if (t.includes('BOOL')) return 'checkbox';
  if (t.includes('TEXT') || t.includes('JSON') || t.includes('CLOB')) return 'textarea';
  return 'text';
}

/** 简易 CSV 解析：支持双引号转义与 CRLF；首行表头，返回 [表头, ...行] */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let val = '';
  let inQuote = false;
  if (text.codePointAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') { val += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cur.push(val); val = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(val); val = '';
      rows.push(cur); cur = [];
    } else val += ch;
  }
  if (val !== '' || cur.length > 0) { cur.push(val); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/** 行数组 → CSV 文本（首行表头；值含逗号/引号/换行时加引号转义） */
function toCSV(headers: string[], rows: Record<string, unknown>[]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(formatCell(r[h]))).join(','));
  return lines.join('\n');
}

/** 触发浏览器下载 */
function download(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const btnStyle = (primary = false, danger = false): React.CSSProperties => ({
  fontSize: 'var(--fs-m)', padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
  background: primary ? 'var(--accent)' : 'var(--card-bg)',
  color: danger ? 'var(--danger)' : primary ? 'var(--accent-text)' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border-strong)',
});

export function DbAdminTab() {
  const [tables, setTables] = useState<DbTableInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ mode: 'create' | 'update'; row?: Record<string, unknown> } | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 4000);
  };

  const pkCol = useMemo(() => columns.find((c) => c.primary_key)?.name ?? 'id', [columns]);

  const loadTables = useCallback(async (keepActive = true) => {
    try {
      const list = await api.get<DbTableInfo[]>('/dbadmin/tables');
      setTables(list);
      setActive((prev) => (keepActive && prev && list.some((t) => t.name === prev) ? prev : list[0]?.name ?? null));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRows = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setSelected(new Set());
    try {
      const r = await api.get<{ rows: Record<string, unknown>[]; total: number }>(
        `/dbadmin/tables/${active}/rows?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}` +
        `&search=${encodeURIComponent(search)}` + (orderBy ? `&order_by=${encodeURIComponent(orderBy)}` : ''),
      );
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [active, page, search, orderBy]);

  // 切表：重置分页/搜索/排序；结构 + 数据一起加载
  useEffect(() => {
    if (!active) return;
    setPage(1); setSearch(''); setOrderBy(undefined);
    api.get<DbColumn[]>(`/dbadmin/tables/${active}/schema`).then(setColumns).catch((e) => flash(e instanceof Error ? e.message : String(e)));
  }, [active]);

  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { void loadTables(false); }, [loadTables]);

  /** 危险操作确认：输入 CONFIRM_DELETE 才放行（与参考项目交互一致） */
  async function confirmDanger(title: string, detail: string): Promise<boolean> {
    const ok = await askConfirm(`${title}\n${detail}\n\n确认码：${CONFIRM_TOKEN}（输入确认弹窗中才生效）`);
    return ok;
  }

  async function handleDelete(pkValue: string) {
    if (!active) return;
    const ok = await confirmDanger(`确认删除表 ${active} 的一行记录？`, `主键：${pkValue}。此操作不可恢复。`);
    if (!ok) return;
    try {
      await api.del(`/dbadmin/tables/${active}/rows/${encodeURIComponent(pkValue)}`);
      flash('已删除');
      await Promise.all([loadRows(), loadTables()]);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleBatchDelete() {
    if (!active || selected.size === 0) return;
    const ok = await confirmDanger(`确认批量删除 ${selected.size} 行？`, `表 ${active} 中选中的记录将全部删除，此操作不可恢复。`);
    if (!ok) return;
    try {
      const r = await api.post<{ affected: number; requested: number }>(`/dbadmin/tables/${active}/batch-delete`, { pks: [...selected] });
      flash(`已删除 ${r.affected}/${r.requested} 行`);
      await Promise.all([loadRows(), loadTables()]);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExport(format: 'csv' | 'json') {
    if (!active) return;
    try {
      const data = await api.get<Record<string, unknown>[]>(`/dbadmin/tables/${active}/export`);
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '').replaceAll('T', '');
      if (format === 'json') {
        download(`${active}_${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
      } else {
        const headers = data.length > 0 ? Object.keys(data[0]) : columns.map((c) => c.name);
        download(`${active}_${stamp}.csv`, '\ufeff' + toCSV(headers, data), 'text/csv;charset=utf-8');
      }
      flash('导出成功');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!active || !file) return;
    try {
      const text = await file.text();
      let data: Record<string, unknown>[];
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) { flash('JSON 必须是非空对象数组'); return; }
        data = parsed as Record<string, unknown>[];
      } else {
        const all = parseCSV(text);
        if (all.length < 2) { flash('CSV 至少需要表头 + 1 行数据'); return; }
        const headers = all[0];
        data = all.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
      }
      const ok = await askConfirm(`将向表「${active}」导入 ${data.length} 行（单行失败自动跳过）。确认继续？`);
      if (!ok) return;
      const r = await api.post<{ inserted: number; skipped: number; errors: string[] }>(`/dbadmin/tables/${active}/import`, { rows: data });
      flash(`导入完成：${r.inserted} 成功，${r.skipped} 跳过${r.errors.length ? `；首条错误：${r.errors[0]}` : ''}`);
      await Promise.all([loadRows(), loadTables()]);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 'var(--fs-m)', padding: '5px 10px', border: '1px solid var(--border-strong)',
    borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)',
  };

  return (
    <div>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Database size={14} /> 数据维护
      </div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        业务表在线增删改查。删除操作需确认码 <b>{CONFIRM_TOKEN}</b>；建议先「导出」备份再修改。
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* 左侧表清单 */}
        <div style={{ width: 190, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', fontWeight: 600, borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-m)' }}>业务表</div>
          {tables.map((t) => (
            <button
              key={t.name}
              onClick={() => setActive(t.name)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', cursor: 'pointer',
                background: active === t.name ? 'var(--accent)' : 'transparent',
                color: active === t.name ? 'var(--accent-text)' : 'var(--text)',
                border: 'none', borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontSize: 'var(--fs-m)', fontWeight: active === t.name ? 600 : 400 }}>{t.label}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{t.name} · {t.rows >= 0 ? `${t.rows} 行` : '?'}</div>
            </button>
          ))}
        </div>

        {/* 右侧数据区 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {active ? (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                <button style={btnStyle(true)} onClick={() => setEditing({ mode: 'create' })} title="新增一行记录"><Plus size={13} /> 新增</button>
                <button style={btnStyle(false, true)} disabled={selected.size === 0} onClick={() => void handleBatchDelete()} title="批量删除选中行（需确认码）">
                  <Trash2 size={13} /> 删除{selected.size > 0 ? `(${selected.size})` : ''}
                </button>
                <label style={{ ...btnStyle(false), marginBottom: 0 }} title="从 CSV / JSON 文件导入数据">
                  <FileUp size={13} /> 导入
                  <input type="file" accept=".csv,.json" style={{ display: 'none' }} onChange={(e) => void handleImportFile(e)} />
                </label>
                <button style={btnStyle(false)} onClick={() => void handleExport('csv')} title="导出当前表全部数据为 CSV"><Download size={13} /> CSV</button>
                <button style={btnStyle(false)} onClick={() => void handleExport('json')} title="导出当前表全部数据为 JSON"><Download size={13} /> JSON</button>
                <button style={btnStyle(false)} onClick={() => setSchemaOpen(true)} title="查看当前表字段结构"><Table2 size={13} /> 表结构</button>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); void loadRows(); } }}
                  placeholder="搜索文本列"
                  style={{ ...inputStyle, width: 180 }}
                />
                <button style={btnStyle(false)} onClick={() => { setPage(1); void loadRows(); }} title="按关键词查询"><Search size={13} /> 查询</button>
                <button style={{ ...btnStyle(false), marginLeft: 'auto' }} onClick={() => { void loadRows(); void loadTables(); }} title="刷新数据与表清单"><RefreshCw size={13} /></button>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflowX: 'auto', background: 'var(--card-bg)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-m)' }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', width: 30 }}>
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && selected.size === rows.length}
                          onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => formatCell(r[pkCol]))) : new Set())}
                        />
                      </th>
                      {columns.map((c) => (
                        <th
                          key={c.name}
                          onClick={() => setOrderBy((o) => (o === c.name ? `-${c.name}` : c.name))}
                          title={`${c.type}${c.nullable ? '' : ' NOT NULL'}（点击排序）`}
                          style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}
                        >
                          {c.name}{c.primary_key && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)' }}>PK</span>}
                          {orderBy === c.name && ' ↑'}{orderBy === `-${c.name}` && ' ↓'}
                        </th>
                      ))}
                      <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', width: 90 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const pk = formatCell(r[pkCol]);
                      return (
                        <tr key={pk}>
                          <td style={{ padding: '5px 8px' }}>
                            <input
                              type="checkbox"
                              checked={selected.has(pk)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(pk); else next.delete(pk);
                                setSelected(next);
                              }}
                            />
                          </td>
                          {columns.map((c) => {
                            const v = r[c.name];
                            const text = formatCell(v);
                            return (
                              <td key={c.name} style={{ padding: '5px 8px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
                                {v === null || v === undefined ? <span style={{ opacity: 0.45 }}>NULL</span> : text}
                              </td>
                            );
                          })}
                          <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                            <button style={{ ...btnStyle(false), padding: '2px 6px', marginRight: 4 }} onClick={() => setEditing({ mode: 'update', row: r })} title="编辑该行"><Pencil size={12} /></button>
                            <button style={{ ...btnStyle(false, true), padding: '2px 6px' }} onClick={() => void handleDelete(pk)} title="删除该行（需确认码）"><Trash2 size={12} /></button>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr><td colSpan={columns.length + 2} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>{loading ? '加载中…' : '无数据'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
                <span>共 {total} 行 · 第 {page}/{Math.max(Math.ceil(total / PAGE_SIZE), 1)} 页</span>
                <button style={{ ...btnStyle(false), padding: '3px 10px' }} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
                <button style={{ ...btnStyle(false), padding: '3px 10px' }} disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((p) => p + 1)}>下一页</button>
              </div>
            </>
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>请从左侧选择一张表</div>
          )}
        </div>
      </div>

      {editing && active && (
        <EditModal
          table={active}
          mode={editing.mode}
          row={editing.row}
          columns={columns}
          pkCol={pkCol}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            flash(msg);
            await Promise.all([loadRows(), loadTables()]);
          }}
        />
      )}

      {schemaOpen && active && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setSchemaOpen(false)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 16, minWidth: 420, maxWidth: 640, maxHeight: '70vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600 }}>表结构 - {active}</div>
              <button style={{ ...btnStyle(false), padding: '2px 6px' }} onClick={() => setSchemaOpen(false)}><X size={13} /></button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-m)' }}>
              <thead>
                <tr>
                  {['列名', '类型', '主键', '可空', '默认值'].map((h) => (
                    <th key={h} style={{ padding: '5px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.name}>
                    <td style={{ padding: '4px 8px' }}>{c.name}</td>
                    <td style={{ padding: '4px 8px' }}>{c.type}</td>
                    <td style={{ padding: '4px 8px' }}>{c.primary_key ? '✓' : ''}</td>
                    <td style={{ padding: '4px 8px' }}>{c.nullable ? 'YES' : 'NO'}</td>
                    <td style={{ padding: '4px 8px' }}>{c.default ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {notice && <div style={{ marginTop: 10, fontSize: 'var(--fs-m)', color: 'var(--accent)' }}>{notice}</div>}
    </div>
  );
}

/** 编辑/新增弹窗：按列类型动态生成表单项 */
function EditModal(props: {
  readonly table: string;
  readonly mode: 'create' | 'update';
  readonly row?: Record<string, unknown>;
  readonly columns: DbColumn[];
  readonly pkCol: string;
  readonly onClose: () => void;
  readonly onSaved: (msg: string) => void | Promise<void>;
}) {
  const { table, mode, row, columns, pkCol, onClose, onSaved } = props;
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const c of columns) {
      const v = row?.[c.name];
      const type = inferFormType(c.type);
      init[c.name] = type === 'checkbox' ? Boolean(v) : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      const data: Record<string, unknown> = {};
      for (const c of columns) {
        const v = values[c.name];
        const type = inferFormType(c.type);
        if (type === 'checkbox') { data[c.name] = v ? 1 : 0; continue; }
        const s = typeof v === 'string' ? v.trim() : '';
        if (s === '') continue; // 空串不提交，走列默认/可空语义
        if (type === 'number') data[c.name] = Number(s);
        else data[c.name] = s;
      }
      if (mode === 'create') {
        await api.post(`/dbadmin/tables/${table}/rows`, data);
        await onSaved('已新增');
      } else {
        await api.patch(`/dbadmin/tables/${table}/rows/${encodeURIComponent(String(row?.[pkCol]))}`, data);
        await onSaved('已更新');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%', fontSize: 'var(--fs-m)', padding: '5px 8px',
    border: '1px solid var(--border-strong)', borderRadius: 6,
    background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 20, minWidth: 380, maxWidth: 560, maxHeight: '80vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>{mode === 'create' ? `新增 → ${table}` : `编辑 → ${table}`}</div>
        {columns.map((c) => {
          const type = inferFormType(c.type);
          const editable = !(mode === 'update' && c.primary_key);
          return (
            <div key={c.name} style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', marginBottom: 3 }}>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                {c.primary_key && <span style={{ fontSize: 10, color: 'var(--accent)' }}>PK</span>}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.type}</span>
              </label>
              {type === 'checkbox' ? (
                <input type="checkbox" disabled={!editable} checked={Boolean(values[c.name])} onChange={(e) => setValues((p) => ({ ...p, [c.name]: e.target.checked }))} />
              ) : type === 'textarea' ? (
                <textarea rows={3} disabled={!editable} value={String(values[c.name])} onChange={(e) => setValues((p) => ({ ...p, [c.name]: e.target.value }))} style={fieldStyle} />
              ) : (
                <input
                  type={type === 'number' ? 'number' : 'text'}
                  step="any"
                  disabled={!editable}
                  value={String(values[c.name])}
                  onChange={(e) => setValues((p) => ({ ...p, [c.name]: e.target.value }))}
                  style={fieldStyle}
                />
              )}
            </div>
          );
        })}
        {err && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-m)', marginBottom: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={btnStyle(false)} onClick={onClose}>取消</button>
          <button style={btnStyle(true)} disabled={busy} onClick={() => void submit()}>{busy ? '保存中…' : mode === 'create' ? '新增' : '更新'}</button>
        </div>
      </div>
    </div>
  );
}
