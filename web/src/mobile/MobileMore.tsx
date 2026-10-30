/**
 * 移动端：更多（聚合低频模块，§2.3 / §5.3）。半屏式列表承载：
 * 配置记录管理 / 归档 / 周报 / 日志 / 设置。点按进入只读视图或引导桌面端。
 * 设置子页含：隧道连接状态、默认记事项目、主题、退出（清除本机令牌）。
 */
import { pageStyle as page, tapCardStyle as row, cardStyle as card, mutedStyle as muted, EmptyState, Skeleton, wideHintStyle } from './ui';
import { useEffect, useRef, useState } from 'react';
import { api, setAccessToken, type AITool, type Task } from '../api/client';
import { ProjectListHint, loadProjectList, projectListPlaceholder, useProjectList } from '../ui/projectList'; // T02212：项目取数接入 T02201 统一容错层
import { useSettings } from '../settings';
import { Boxes, Archive, BarChart3, Terminal, Activity, Settings, ExternalLink, LogOut, Moon, Sun, Monitor, ChevronRight, Bell, ListChecks, Wrench } from 'lucide-react'; // T03655：空态改 lucide（Archive 已用于归档入口）
import { MobileExecSessions } from './MobileExecSessions';
import { MobileNotifications } from './MobileNotifications';
import { MobilePlans } from './MobilePlans';

interface Props { readonly notify: (msg: string, isErr?: boolean) => void; readonly openDesktop: () => void; readonly onOpenTask: (taskNo: string) => void; }

type Sub = 'root' | 'notifications' | 'plans' | 'aitools' | 'archive' | 'report' | 'logs' | 'execsessions' | 'settings';

const ITEMS: { key: Sub; label: string; icon: typeof Boxes; desc: string }[] = [
  { key: 'notifications', label: '通知', icon: Bell, desc: '任务事件 / 回传 / 失败提醒' },
  { key: 'plans', label: '需求 / 计划', icon: ListChecks, desc: '只读查看需求矩阵、计划与甘特' },
  { key: 'aitools', label: '配置记录管理', icon: Boxes, desc: 'AI 工具（查看）' },
  { key: 'archive', label: '归档', icon: Archive, desc: '已归档任务（查询）' },
  { key: 'report', label: '周报', icon: BarChart3, desc: '在桌面端生成' },
  { key: 'execsessions', label: '执行会话', icon: Activity, desc: 'AI 执行监控 / 一键重派' },
  { key: 'logs', label: '日志', icon: Terminal, desc: '后台运行日志' },
  { key: 'settings', label: '设置', icon: Settings, desc: '连接 / 默认项目 / 退出' },
];

/** M6-6.4：base64url → Uint8Array（Web Push 订阅公钥解码）。模块级函数，供 togglePush 复用。 */
function b64ToUint8(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(raw, (c) => c.codePointAt(0) ?? 0);
}

export function MobileMore({ notify, openDesktop, onOpenTask }: Props) {
  const [sub, setSub] = useState<Sub>('root');
  const { prefs, update } = useSettings();

  return (
    <div style={page}>
      <header style={hdr}>{sub === 'root' ? '更多' : SUB_TITLE[sub]}<button onClick={() => setSub('root')} aria-label="返回更多页" style={backBtn}>‹</button></header>
      <div style={body}>
        {sub === 'root' && ITEMS.map((it) => {
          const Icon = it.icon;
          return (
            <button key={it.key} onClick={() => setSub(it.key)} style={row}>
              <Icon size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left', marginLeft: 10 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-xl)' }}>{it.label}</span>
                <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>{it.desc}</span>
              </span>
              <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
          );
        })}
        {sub === 'notifications' && <MobileNotifications notify={notify} onOpenTask={onOpenTask} />}
        {sub === 'plans' && <MobilePlans notify={notify} />}
        {sub === 'aitools' && <AitoolsView notify={notify} />}
        {sub === 'archive' && <ArchiveView notify={notify} />}
        {sub === 'report' && <ReportView openDesktop={openDesktop} />}
        {sub === 'execsessions' && <MobileExecSessions notify={notify} />}
        {sub === 'logs' && <LogsView notify={notify} />}
        {sub === 'settings' && <SettingsView notify={notify} openDesktop={openDesktop} theme={prefs.theme} setTheme={(t) => update('theme', t)} accent={prefs.accent} setAccent={(v) => update('accent', v)} zen={prefs.zen ?? false} setZen={(v) => update('zen', v)} />}
      </div>
    </div>
  );
}

const SUB_TITLE: Record<Sub, string> = { root: '更多', notifications: '通知', plans: '需求 / 计划', aitools: '配置记录管理', archive: '归档', report: '周报', logs: '日志', execsessions: '执行会话', settings: '设置' };

// 退出仅清本机令牌并刷新页面，不依赖任何组件状态，置于模块顶层避免每次渲染重建函数
function logout() {
  setAccessToken('');
  location.reload();
}

// ---------- 配置记录管理（只读） ----------
function AitoolsView({ notify }: { readonly notify: (msg: string) => void }) {
  const [tools, setTools] = useState<AITool[]>([]);
  useEffect(() => { api.get<AITool[]>('/aitools').then(setTools).catch((e) => notify(e instanceof Error ? e.message : String(e))); }, [notify]);
  return (
    <>
      {tools.length === 0 && <EmptyState icon={<Wrench size={32} />} message="暂无 AI 工具" />}
      {tools.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ fontWeight: 600 }}>{t.name}</div>
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>{t.type} · {t.model ?? '未配置模型'}</div>
        </div>
      ))}
      <div style={muted}>移动端仅查看；新增 / 编辑请在桌面端操作。</div>
    </>
  );
}

// ---------- 归档（只读） ----------
const ARCHIVE_PAGE = 100;
function ArchiveView({ notify }: { readonly notify: (msg: string) => void }) {
  // M7-7.1：原实现 /tasks?archived=1 全量拉取后本地过滤——归档区是增长最快的数据集。
  // 改为服务端 keyword 过滤 + limit/offset 分页（加载更多），按月分组只作用于已加载行。
  const [tasks, setTasks] = useState<Task[]>([]);
  const [kw, setKw] = useState(''); // T01442：关键词过滤（300ms 防抖后走服务端）
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const seqRef = useRef(0); // 防竞态：仅采纳最后一次请求的结果

  const fetchPage = (keyword: string, offset: number, replace: boolean) => {
    const seq = ++seqRef.current;
    const q = new URLSearchParams({ archived: '1', limit: String(ARCHIVE_PAGE), offset: String(offset) });
    if (keyword) q.set('keyword', keyword);
    const p = api.get<Task[]>(`/tasks?${q}`).then((list) => {
      if (seq !== seqRef.current) return; // 过期响应丢弃
      setTasks((cur) => (replace ? list : [...cur, ...list]));
      offsetRef.current = offset + list.length;
      setHasMore(list.length === ARCHIVE_PAGE);
    });
    if (replace) { setLoading(true); p.finally(() => setLoading(false)); }
    else { setLoadingMore(true); p.finally(() => setLoadingMore(false)); }
    return p;
  };
  // 首次加载
  useEffect(() => { fetchPage('', 0, true).catch((e) => notify(e instanceof Error ? e.message : String(e))); }, [notify]);
  // 关键词防抖（300ms）→ 服务端过滤并重置分页
  useEffect(() => {
    const t = setTimeout(() => { fetchPage(kw.trim(), 0, true).catch((e) => notify(e instanceof Error ? e.message : String(e))); }, kw ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw]);
  function loadMore() {
    if (loadingMore || !hasMore) return;
    fetchPage(kw.trim(), offsetRef.current, false).catch((e) => notify(e instanceof Error ? e.message : String(e)));
  }
  // T01442：按归档月份分组（倒序）——仅作用于已加载行
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const month = (t.archived_at ?? '').slice(0, 7) || '未知月份';
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month)!.push(t);
  }
  return (
    <>
      <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索归档任务标题…"
        aria-label="搜索归档任务"
        style={{ width: '100%', padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-l)', background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box', marginBottom: 10 }} />
      {loading && <Skeleton rows={4} card />}
      {!loading && tasks.length === 0 && <EmptyState icon={<Archive size={32} />} message="暂无归档任务" hint={kw ? '换个关键词试试' : undefined} />}
      {[...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, list]) => (
        <div key={month}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text-muted)', padding: '8px 2px 6px' }}>{month}（{list.length}）</div>
          {list.map((t) => (
            <div key={t.id} style={card}>
              <div style={{ fontSize: 'var(--fs-l)' }}>{t.title}</div>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>{t.archived_at?.slice(0, 10) ?? ''} 归档</div>
            </div>
          ))}
        </div>
      ))}
      {hasMore && !loading && (
        <button onClick={loadMore} disabled={loadingMore}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 'var(--fs-m)', cursor: 'pointer' }}>
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
      <div style={muted}>移动端仅供查询；还原 / 删除请在桌面端操作。</div>
    </>
  );
}

// ---------- 周报（T01443：移动摘要卡 + 跳桌面） ----------
function ReportView({ openDesktop }: { readonly openDesktop: () => void }) {
  const [stats, setStats] = useState<{ done: number; created: number; failed: number } | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        // M7-7.1：原实现拉 /tasks?archived=0 全量后本地数数，改为轻量聚合端点
        setStats(await api.get<{ done: number; created: number; failed: number }>('/stats/weekly'));
      } catch { setStats({ done: 0, created: 0, failed: 0 }); }
    })();
  }, []);
  const rows: { label: string; value: number; color: string }[] = stats ? [
    { label: '本周完成', value: stats.done, color: 'var(--success)' },
    { label: '本周新增', value: stats.created, color: 'var(--accent)' },
    { label: '失败待处理（当前积压）', value: stats.failed, color: 'var(--danger)' },
  ] : [];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={card}>
      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', marginBottom: 10 }}>本周摘要</div>
      {stats ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-s)', marginBottom: 3 }}>
                <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
                <span style={{ fontWeight: 600, color: r.color }}>{r.value}</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.round((r.value / max) * 100)}%`, height: '100%', background: r.color, borderRadius: 4, transition: 'width .4s ease' }} />
              </div>
            </div>
          ))}
        </div>
      ) : <div style={muted}>统计加载中…</div>}
      <div style={{ marginTop: 12 }}><button onClick={openDesktop} style={deskBtn}><ExternalLink size={14} /> 完整周报在桌面端生成</button></div>
    </div>
  );
}

// ---------- 日志（只读） ----------
function LogsView({ notify }: { readonly notify: (msg: string) => void }) {
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
function SettingsView({ notify, openDesktop, theme, setTheme, accent, setAccent, zen, setZen }: { readonly notify: (msg: string, isErr?: boolean) => void; readonly openDesktop: () => void; readonly theme: string; readonly setTheme: (t: 'auto' | 'light' | 'dark') => void; readonly accent: string; readonly setAccent: (v: string) => void; readonly zen: boolean; readonly setZen: (v: boolean) => void }) {
  const [status, setStatus] = useState<{ status: string; publicUrl: string | null }>({ status: 'stopped', publicUrl: null });
  const projectList = useProjectList(); // T02212：项目列表由统一容错层供给（失败可见 + 重试 + 上次数据标注过期）
  const [noteProject, setNoteProject] = useState('');
  useEffect(() => {
    void (async () => {
      try { setStatus(await api.get('/tunnel/status')); } catch { /* 忽略 */ }
      void loadProjectList();
      // T02212：原「取项目列表 + 取默认记事项目」同处一个 try，项目列表一失败就把
      // 默认项目一起拖没（且整段静默）。拆开后设置项单独兜底，项目列表的失败态交给提示行呈现。
      try {
        setNoteProject((await api.get<{ projectId: string }>('/settings/note-project')).projectId);
      } catch { /* 取不到默认项目时下拉留空，不阻塞其余设置 */ }
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

  // T01440：Web Push 开关与测试
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on'>('off');
  useEffect(() => {
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in globalThis) || !('Notification' in globalThis)) { setPushState('unsupported'); return; }
      try {
        const reg = await navigator.serviceWorker.ready;
        setPushState((await reg.pushManager.getSubscription()) ? 'on' : 'off');
      } catch { setPushState('off'); }
    })();
  }, []);
  async function togglePush() {
    try {
      if (pushState === 'on') {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
        setPushState('off');
        notify('推送已关闭');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { notify('通知权限未授权，请在系统设置中允许', true); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.get<{ publicKey: string }>('/push/public-key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) as BufferSource });
      await api.post('/push/subscribe', sub.toJSON());
      setPushState('on');
      notify('推送已开启——任务失败/停滞将通知');
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }
  async function sendTestPush() {
    try { await api.post('/push/test', {}); notify('测试推送已发送'); }
    catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }

  return (
    <div>
      <div style={setRow}>
        <span style={setLabel}>隧道连接</span>
        <span style={{ fontSize: 'var(--fs-m)', color: status.publicUrl ? 'var(--success)' : 'var(--text-muted)' }}>
          {status.publicUrl ? '● 已连接' : '○ 未连接'}
        </span>
      </div>
      {status.publicUrl && <div style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', wordBreak: 'break-all', padding: '0 0 8px' }}>{status.publicUrl}</div>}

      <div style={setRow}>
        <span style={setLabel}>默认记事项目</span>
        <select value={noteProject} onChange={(e) => void saveNoteProject(e)} style={sel}>
          {projectList.projects.length === 0 && <option value="">{projectListPlaceholder(projectList)}</option>}
          {projectList.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ProjectListHint view={projectList} style={{ ...wideHintStyle, padding: '0 14px 8px' }} />

      <div style={setRow}>
        <span style={setLabel}>主题</span>
        {/* T01427：三选一（跟随系统/浅色/深色）——auto 档由 SettingsProvider 的 matchMedia
            监听实时切换 data-theme（与桌面端 T01060 同一机制） */}
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {([['auto', '跟随系统', <Monitor size={14} key="a" />], ['light', '浅色', <Sun size={14} key="l" />], ['dark', '深色', <Moon size={14} key="d" />]] as const).map(([val, label, icon]) => (
            <button key={val} onClick={() => setTheme(val)} aria-pressed={theme === val}
              style={{ ...seg, ...(theme === val ? { background: 'var(--accent)', color: 'var(--accent-text)', borderColor: 'var(--accent)' } : {}) }}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* T01440：Web Push 开关与测试 */}
      <div style={setRow}>
        <span style={setLabel}>失败推送通知</span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {pushState !== 'unsupported' && (
            <button onClick={() => void togglePush()} aria-pressed={pushState === 'on'}
              style={{ ...seg, background: pushState === 'on' ? 'var(--accent)' : 'var(--card-bg)', color: pushState === 'on' ? 'var(--accent-text)' : 'var(--text)' }}>
              {pushState === 'on' ? '已开启' : '已关闭'}
            </button>
          )}
          {pushState === 'on' && (
            <button onClick={() => void sendTestPush()} style={seg}>发送测试</button>
          )}
        </span>
      </div>
      {pushState === 'unsupported' && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '0 0 8px' }}>当前浏览器不支持 Web Push</div>}

      {/* T01445：Zen 极简阅读——隐藏徽标/计数、放大字号 */}
      <div style={setRow}>
        <span style={setLabel}>Zen 极简阅读</span>
        <button onClick={() => setZen(!zen)} aria-pressed={zen} title="隐藏徽标与计数、放大字号，专注阅读"
          style={{ ...seg, background: zen ? 'var(--accent)' : 'var(--card-bg)', color: zen ? 'var(--accent-text)' : 'var(--text)', borderColor: zen ? 'var(--accent)' : 'var(--border-strong)' }}>
          {zen ? '已开启' : '已关闭'}
        </button>
      </div>

      {/* T01437：自定义强调色——与桌面端同一 prefs.accent 数据源，6 预置色 + 取色器 + 恢复默认 */}
      <div style={setRow}>
        <span style={setLabel}>强调色</span>
        <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2'].map((c) => (
            <button key={c} onClick={() => setAccent(c)} aria-label={`强调色 ${c}`}
              style={{ width: 24, height: 24, borderRadius: 6, border: accent === c ? '2px solid var(--text)' : '1px solid var(--border-strong)', background: c, cursor: 'pointer' }} />
          ))}
          <input type="color" value={accent || '#2563eb'} onChange={(e) => setAccent(e.target.value)}
            title="自定义强调色（取色器）" aria-label="自定义强调色取色器"
            style={{ width: 30, height: 24, padding: 0, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', cursor: 'pointer' }} />
          <button onClick={() => setAccent('')} title="恢复默认强调色" aria-label="恢复默认强调色"
            style={{ ...seg, fontSize: 'var(--fs-s)' }}>默认</button>
        </div>
      </div>

      <button onClick={openDesktop} style={deskBtn}><ExternalLink size={14} /> 切换到桌面版</button>
      <button onClick={logout} style={logoutBtn}><LogOut size={14} /> 退出登录（清除本机令牌）</button>
      <div style={muted}>移动端不落库敏感数据；通行口令仅存于本机会话。</div>
    </div>
  );
}

// ---------- 样式 ----------
const hdr: React.CSSProperties = { fontSize: 'var(--fs-2xl)', fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)', display: 'flex', alignItems: 'center', gap: 10 };
const backBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-title)', lineHeight: 1, cursor: 'pointer' };
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };
const deskBtn: React.CSSProperties = { marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-l)' };
const logoutBtn: React.CSSProperties = { marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--danger)', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-l)' };
const setRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--surface-2)' };
const setLabel: React.CSSProperties = { fontSize: 'var(--fs-l)', color: 'var(--text)' };
const sel: React.CSSProperties = { padding: 8, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-m)', background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 180 };
const seg: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 8, fontSize: 'var(--fs-m)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' };
const logPre: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', background: 'var(--surface)', borderRadius: 8, padding: 10, maxHeight: '100%', overflowY: 'auto' };
