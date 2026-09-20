import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, FolderOpen, Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import { askInput } from './dialogs';
import { desktopApi } from './desktop';
import { pickServerDirectory } from './DirBrowser'; // T00771 二轮：无桌面壳时的服务端目录浏览

/**
 * T00771：工作空间选择器（参考 workbuddy 工作空间下拉）。
 * - 无框触发按钮：FolderOpen 图标 + 当前绑定文件夹名（未绑定显示「工作空间」）；
 * - 面板：搜索框过滤历史 + 最近使用列表 + 「新建工作空间」（服务端建目录）+「打开本地文件夹」（Electron 目录选择）；
 * - 选中即回调 onBind(path)（父组件负责 PATCH 绑定与刷新），无效路径由服务端 400 阻断，错误经 flash 反馈。
 * variant='bare' 时不渲染触发按钮，仅输出面板内容（供「新建项目」弹窗内嵌复用）。
 */

/** 取路径的文件夹名（兼容 \ 与 /；根盘符退化返回全路径） */
export function wsBasename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function WorkspaceSelect({ project, onBind, flash, variant = 'trigger' }: {
  /** 当前项目（读取已绑定路径做回显；切项目由父组件换 props 自动联动） */
  readonly project?: { id: string; workspace_path?: string | null } | null;
  /** 绑定回调：执行持久化（PATCH），失败抛错由组件捕获 flash */
  readonly onBind: (path: string) => Promise<void>;
  readonly flash?: (m: string) => void;
  readonly variant?: 'trigger' | 'bare';
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const bound = project?.workspace_path ?? '';

  // 点击面板外关闭（仅触发器模式需要）
  useEffect(() => {
    if (!open || variant !== 'trigger') return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, variant]);

  async function loadHistory() {
    try {
      const r = await api.get<{ history: string[] }>('/projects/workspace-history');
      setHistory(r.history ?? []);
    } catch { /* 历史拉取失败不阻断选择 */ }
  }

  async function bind(path: string) {
    const p = path.trim();
    if (!p) { flash?.('路径不能为空'); return; }
    setBusy(true);
    try {
      await onBind(p);
      setOpen(false);
      setSearch('');
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e)); // 服务端 400（不存在/非文件夹）原样透出
    } finally { setBusy(false); }
  }

  async function createWorkspace() {
    const p = await askInput({ title: '新建工作空间', placeholder: '输入新文件夹的完整路径，如 D:\\code\\MyWorkspace' });
    if (!p) return;
    setBusy(true);
    try {
      await api.post('/projects/workspace-create', { path: p.trim() });
      await bind(p.trim());
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /**
   * 「打开本地文件夹」两级通道：
   * ① Electron 壳内 → 原生目录对话框（IPC → dialog.showOpenDialog），体验最好；
   * ② 无桌面壳（Vite dev / 浏览器）→ 服务端目录浏览器（GET /api/fs/dirs 逐层枚举）。
   * T00771 二轮：原先 ② 走的是 `<input webkitdirectory>` + `File.path` 反推目录，而 `File.path`
   * 只在 Electron 中存在，纯浏览器必然取不到绝对路径（点了等于没点）—— 故改用服务端枚举，
   * 这条路在两种环境下都能真正选中文件夹。
   */
  async function pickLocalFolder() {
    const shell = desktopApi();
    setBusy(true);
    try {
      const dir = shell ? await shell.openDirectory() : await pickServerDirectory();
      if (dir) await bind(dir);
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filtered = search.trim()
    ? history.filter((h) => h.toLowerCase().includes(search.trim().toLowerCase()) || wsBasename(h).toLowerCase().includes(search.trim().toLowerCase()))
    : history;

  const panel = (
    <div role="listbox" aria-label="选择工作空间"
      style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,.16)', zIndex: 45, width: 260, padding: 6, color: 'var(--text)' }}>
      {/* 搜索工作空间 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', marginBottom: 4 }}>
        <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索工作空间" aria-label="搜索工作空间"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, minWidth: 0 }} />
      </div>
      {/* 最近使用（历史记录） */}
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {filtered.length === 0
          ? <div style={{ padding: '8px 6px', fontSize: 11, color: 'var(--text-muted)' }}>{history.length === 0 ? '暂无使用记录 — 选择或新建一个文件夹' : '无匹配的历史工作空间'}</div>
          : filtered.map((h) => (
            <button key={h} role="option" aria-selected={h === bound} onClick={() => void bind(h)} disabled={busy}
              title={h}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '5px 6px', fontSize: 12, border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', background: h === bound ? 'var(--accent-soft)' : 'transparent', color: h === bound ? 'var(--accent)' : 'var(--text)' }}>
              <Folder size={13} style={{ flexShrink: 0, color: h === bound ? 'var(--accent)' : 'var(--text-muted)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wsBasename(h)}</span>
            </button>
          ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
      {/* 新建工作空间 / 打开本地文件夹 */}
      <button role="option" onClick={() => void createWorkspace()} disabled={busy}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px', fontSize: 12, border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', background: 'transparent', color: 'var(--text)' }}>
        <Plus size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> 新建工作空间
      </button>
      <button role="option" onClick={pickLocalFolder} disabled={busy}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px', fontSize: 12, border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', background: 'transparent', color: 'var(--text)' }}>
        <FolderOpen size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> 打开本地文件夹
      </button>
    </div>
  );

  if (variant === 'bare') return panel;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {/* 无框触发按钮：对齐任务菜单工具栏字号/图标尺寸，仅悬浮变色区分可点击 */}
      <button onClick={() => { if (!open) void loadHistory(); setOpen((o) => !o); }} aria-haspopup="listbox" aria-expanded={open}
        title={bound ? `工作空间：${bound} — 点击切换` : '选择工作空间 — 绑定项目上下文根路径，AI 功能以此路径加载上下文'}
        aria-label="选择工作空间"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 4px', border: 'none', background: 'transparent', color: bound ? 'var(--text)' : 'var(--text-muted)', fontSize: 12, cursor: 'pointer', maxWidth: 220 }}>
        <FolderOpen size={13} style={{ flexShrink: 0, color: bound ? 'var(--accent)' : 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bound ? wsBasename(bound) : '工作空间'}</span>
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>
      {open && panel}
    </div>
  );
}
