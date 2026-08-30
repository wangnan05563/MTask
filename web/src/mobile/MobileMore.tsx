/**
 * 移动端：更多（聚合低频模块，§2.3 / §5.3）。半屏式列表承载：
 * 配置记录管理 / 归档 / 周报 / 日志 / 设置。点按进入只读视图或引导桌面端。
 * 设置子页含：隧道连接状态、默认记事项目、主题、退出（清除本机令牌）。
 */
import { useEffect, useState } from 'react';
import { api, setAccessToken, type AITool, type Project, type Task } from '../api/client';
import { useSettings } from '../settings';
import { Boxes, Archive, BarChart3, Terminal, Settings, ExternalLink, LogOut, Moon, Sun, ChevronRight } from 'lucide-react';

interface Props { notify: (msg: string) => void; openDesktop: () => void; }

type Sub = 'root' | 'aitools' | 'archive' | 'report' | 'logs' | 'settings';

const ITEMS: { key: Sub; label: string; icon: typeof Boxes; desc: string }[] = [
  { key: 'aitools', label: '配置记录管理', icon: Boxes, desc: 'AI 工具（查看）' },
  { key: 'archive', label: '归档', icon: Archive, desc: '已归档任务（查询）' },
  { key: 'report', label: '周报', icon: BarChart3, desc: '在桌面端生成' },
  { key: 'logs', label: '日志', icon: Terminal, desc: '后台运行日志' },
  { key: 'settings', label: '设置', icon: Settings, desc: '连接 / 默认项目 / 退出' },
];

export function MobileMore({ notify, openDesktop }: Props) {
  const [sub, setSub] = useState<Sub>('root');
  const { prefs, update } = useSettings();

  return (
    <div style={page}>
      <header style={hdr}>{sub === 'root' ? '更多' : SUB_TITLE[sub]}<button onClick={() => setSub('root')} style={backBtn}>‹</button></header>
      <div style={body}>
        {sub === 'root' && ITEMS.map((it) => {
          const Icon = it.icon;
          return (
            <button key={it.key} onClick={() => setSub(it.key)} style={row}>
              <Icon size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left', marginLeft: 10 }}>
                <span style={{ display: 'block', fontSize: 15 }}>{it.label}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.desc}</span>
              </span>
              <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
          );
        })}
        {sub === 'aitools' && <AitoolsView notify={notify} />}
        {sub === 'archive' && <ArchiveView notify={notify} />}
        {sub === 'report' && <ReportView openDesktop={openDesktop} />}
        {sub === 'logs' && <LogsView notify={notify} />}
        {sub === 'settings' && <SettingsView notify={notify} openDesktop={openDesktop} theme={prefs.theme} setTheme={(t) => update('theme', t)} />}
      </div>
    </div>
  );
}

const SUB_TITLE: Record<Sub, string> = { root: '更多', aitools: '配置记录管理', archive: '归档', report: '周报', logs: '日志', settings: '设置' };

// ---------- 配置记录管理（只读） ----------
function AitoolsView({ notify }: { notify: (msg: string) => void }) {
  const [tools, setTools] = useState<AITool[]>([]);
  useEffect(() => { api.get<AITool[]>('/aitools').then(setTools).catch((e) => notify(e instanceof Error ? e.message : String(e))); }, [notify]);
  return (
    <>
      {tools.length === 0 && <div style={muted}>暂无 AI 工具</div>}
      {tools.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ fontWeight: 600 }}>{t.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t.type} · {t.model ?? '未配置模型'}</div>
        </div>
      ))}
      <div style={muted}>移动端仅查看；新增 / 编辑请在桌面端操作。</div>
    </>
  );
}

// ---------- 归档（只读） ----------
function ArchiveView({ notify }: { notify: (msg: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => { api.get<Task[]>('/tasks?archived=1').then(setTasks).catch((e) => notify(e instanceof Error ? e.message : String(e))); }, [notify]);
  return (
    <>
      {tasks.length === 0 && <div style={muted}>暂无归档任务</div>}
      {tasks.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ fontSize: 14 }}>{t.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t.archived_at?.slice(0, 10) ?? ''} 归档</div>
        </div>
      ))}
      <div style={muted}>移动端仅供查询；还原 / 删除请在桌面端操作。</div>
    </>
  );
}

// ---------- 周报（引导桌面端） ----------
function ReportView({ openDesktop }: { openDesktop: () => void }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 14, marginBottom: 8 }}>周报生成涉及模板与报表渲染，建议在桌面端完成。</div>
      <button onClick={openDesktop} style={deskBtn}><ExternalLink size={14} /> 在桌面端生成周报</button>
    </div>
  );
}

// ---------- 日志（只读） ----------
function LogsView({ notify }: { notify: (msg: string) => void }) {
  const [logs, setLogs] = useState<string>('');
  useEffect(() => {
    api.get<{ items?: { message: string }[]; log?: string }>('/logs').then((r) => {
      const items = (r.items ?? []).map((i) => i.message).join('\n');
      setLogs(items || r.log || '（空）');
    }).catch((e) => notify(e instanceof Error ? e.message : String(e)));
  }, [notify]);
  return <pre style={logPre}>{logs}</pre>;
}

// ---------- 设置 ----------
function SettingsView({ notify, openDesktop, theme, setTheme }: { notify: (msg: string) => void; openDesktop: () => void; theme: string; setTheme: (t: 'light' | 'dark') => void }) {
  const [status, setStatus] = useState<{ status: string; publicUrl: string | null }>({ status: 'stopped', publicUrl: null });
  const [projects, setProjects] = useState<Project[]>([]);
  const [noteProject, setNoteProject] = useState('');
  useEffect(() => {
    void (async () => {
      try { setStatus(await api.get('/tunnel/status')); } catch { /* 忽略 */ }
      try {
        const list = await api.get<Project[]>('/projects');
        setProjects(list);
        setNoteProject((await api.get<{ projectId: string }>('/settings/note-project')).projectId);
      } catch { /* 忽略 */ }
    })();
  }, []);

  async function saveNoteProject(e: React.ChangeEvent<HTMLSelectElement>) {
    const pid = e.target.value;
    try {
      await api.post('/settings/note-project', { projectId: pid });
      setNoteProject(pid);
      notify('默认记事项目已更新');
    } catch (err) { notify(err instanceof Error ? err.message : String(err)); }
  }

  function logout() {
    setAccessToken('');
    location.reload();
  }

  return (
    <div>
      <div style={setRow}>
        <span style={setLabel}>隧道连接</span>
        <span style={{ fontSize: 13, color: status.publicUrl ? 'var(--success)' : 'var(--text-muted)' }}>
          {status.publicUrl ? '● 已连接' : '○ 未连接'}
        </span>
      </div>
      {status.publicUrl && <div style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all', padding: '0 0 8px' }}>{status.publicUrl}</div>}

      <div style={setRow}>
        <span style={setLabel}>默认记事项目</span>
        <select value={noteProject} onChange={(e) => void saveNoteProject(e)} style={sel}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div style={setRow}>
        <span style={setLabel}>主题</span>
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} style={seg}>
          {theme === 'light' ? <><Sun size={14} /> 浅色</> : <><Moon size={14} /> 深色</>}
        </button>
      </div>

      <button onClick={openDesktop} style={deskBtn}><ExternalLink size={14} /> 切换到桌面版</button>
      <button onClick={logout} style={logoutBtn}><LogOut size={14} /> 退出登录（清除本机令牌）</button>
      <div style={muted}>移动端不落库敏感数据；通行口令仅存于本机会话。</div>
    </div>
  );
}

// ---------- 样式 ----------
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)' };
const hdr: React.CSSProperties = { fontSize: 16, fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)', display: 'flex', alignItems: 'center', gap: 10 };
const backBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 22, lineHeight: 1, cursor: 'pointer' };
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', padding: 14, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10, cursor: 'pointer', color: 'var(--text)' };
const card: React.CSSProperties = { padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10 };
const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 12, padding: '4px 2px' };
const deskBtn: React.CSSProperties = { marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 14 };
const logoutBtn: React.CSSProperties = { marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--danger)', border: 'none', cursor: 'pointer', fontSize: 14 };
const setRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--surface-2)' };
const setLabel: React.CSSProperties = { fontSize: 14, color: 'var(--text)' };
const sel: React.CSSProperties = { padding: 8, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 13, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 180 };
const seg: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' };
const logPre: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--surface)', borderRadius: 8, padding: 10, maxHeight: '100%', overflowY: 'auto' };
