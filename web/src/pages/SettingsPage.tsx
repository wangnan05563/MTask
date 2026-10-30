import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { api, type TaskCategory } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { FONT_OPTIONS, FONT_SIZE_OPTIONS, useSettings, type ImportMode } from '../settings';
import { Ban, Download, ExternalLink, FileUp, FolderPlus, Info, MonitorCog, Moon, Pencil, RefreshCw, RotateCcw, Save, Settings, ShieldCheck, Sun, Trash2 } from 'lucide-react';
import { getLang, setLang, onLangChange, type Lang } from '../i18n'; // T01071-FR5.4：i18n 底座
import { usePersistentState } from '../ui/session'; // T03271（UX-09③）：Tab 选中态跨页面/跨会话保持（沿用 T02977 口径）
import { SETTINGS_TAB_LABELS, filterSettingsGroups, normalizeSettingsTab, type SettingsTabKey } from '../ui/settingsTabs'; // T03271（UX-09①②）：页签与分组单源
import { updateCardStore, shownProgressOf, type UpdateCheckInfo } from '../stores/updateCardStore';

/** T01060-FR4.1：强调色预设色板（与主题内置 accent 同源的六色系） */
const ACCENT_PRESETS = ['#2563eb', '#0891b2', '#16a34a', '#7c3aed', '#ea580c', '#dc2626'];

/** T01068-FR4.3：主题预设库——主题 + 强调色的开箱组合 */
const THEME_PRESETS: Array<{ label: string; theme: 'light' | 'dark' | 'auto'; accent: string }> = [
  { label: '默认浅色', theme: 'light', accent: '' },
  { label: '默认深色', theme: 'dark', accent: '' },
  { label: '海洋', theme: 'dark', accent: '#0891b2' },
  { label: '北欧', theme: 'dark', accent: '#5eead4' },
  { label: '日暮', theme: 'light', accent: '#ea580c' },
  { label: '玫瑰', theme: 'light', accent: '#e11d48' },
];
import { desktopApi } from '../ui/desktop'; // T00878：Electron 壳内一键下载并静默安装更新包
import { isInFlightStatus, updateProgressView } from '../ui/updateProgress'; // T02977 复验补：下载进度文案单源
import { TunnelPanel } from './TunnelPanel';
import { HistoryPage } from './HistoryPage'; // T00756：历史资产嵌入设置
import { HelpTab } from './HelpTab';
import { DbAdminTab } from './DbAdminTab';
import { LogsPage } from './LogsPage';
import { ArchivePage } from './ArchivePage';
import { RecurringTab, ApiTokensTab } from './RecurringTokensTabs'; // T01073：循环任务 + API Token
import { SupervisorPanel } from './SupervisorPanel'; // T01286：监督状态与审计（FR-5.2~5.4）
import { DashboardPage } from './DashboardPage'; // T01154：仪表盘迁入设置页
import { CustomFieldsTab } from './CustomFieldsTab'; // T03231（PM-203）：项目级自定义字段
import { SonarSettingsTab } from './SonarSettingsTab'; // T03371（八期 §3.4.1）：SonarQube 环境配置子页

/** 应用信息（与根 package.json 保持一致） */
const APP_NAME = 'MTask';
const APP_VERSION = '0.1.0';
const APP_DESC = 'AI 任务开发管理工具：项目维度任务管理 + AI 梳理 + 队列分发。';

/** 导入策略文案映射：显式枚举映射替代嵌套三元，新增策略时只需补一行 */
const IMPORT_MODE_LABELS: Record<ImportMode, string> = { merge: '合并', keep: '保留', overwrite: '覆盖' };

/** 设置页面：三组页签（偏好 / 数据 / 运维与诊断）+ 组内搜索（T03271 / UX-09）。 */
export function SettingsPage() {
  // T03271（UX-09③）：沿用 T02977 口径——切走返回、整页刷新后仍停原页签；脏值由单源兜底回「通用设置」
  const [st, setSt] = usePersistentState<string>('settings.tab', 'general');
  const active = normalizeSettingsTab(st);
  // T03271（UX-09②）：命令面板直达时设置页可能已挂载——只写存储不会重渲染，故另派事件即时切页签
  useEffect(() => {
    const onFocus = (e: Event) => setSt(normalizeSettingsTab((e as CustomEvent<{ key?: string }>).detail?.key));
    globalThis.addEventListener('mtaskSettingsTab', onFocus);
    return () => globalThis.removeEventListener('mtaskSettingsTab', onFocus);
  }, [setSt]);
  const [q, setQ] = useState('');
  const groups = filterSettingsGroups(q);
  return (
    <section>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索设置项"
          placeholder="搜索设置项（如：主题 / 备份 / 日志）…"
          style={{ width: 260, maxWidth: '100%', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)' }}
        />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {groups.reduce((n, g) => n + g.tabs.length, 0)} 项
        </span>
      </div>
      <nav aria-label="设置分组" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.label} data-t03271="group" data-group={g.key}
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 72 }}>{g.label}</span>
            {g.tabs.map((t) => {
              const on = active === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setSt(t.key)}
                  aria-current={on ? 'page' : undefined}
                  data-t03271="tab"
                  data-tab={t.key}
                  title={SETTINGS_TAB_LABELS[t.key]}
                  style={{
                    fontSize: 'var(--fs-m)',
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: on ? 'var(--accent)' : 'var(--card-bg)',
                    color: on ? 'var(--accent-text)' : 'var(--text)',
                    cursor: 'pointer',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <div role="status" data-t03271="empty" style={{ padding: '8px 0', fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
            无匹配设置项
          </div>
        )}
      </nav>

      {active === 'general' && <GeneralTab />}
      {active === 'dashboard' && <DashboardPage />} {/* T01154：仪表盘迁入设置页 */}
      {active === 'supervisor' && <SupervisorPanel />} {/* T01286：监督状态与审计（FR-5.2~5.4） */}
      {active === 'migration' && <MigrationTab />}
      {active === 'dbadmin' && <DbAdminTab />}
      {active === 'categories' && <CategoriesTab />}
      {active === 'fields' && <CustomFieldsTab />}
      {active === 'recurring' && <RecurringTab />}
      {active === 'apitokens' && <ApiTokensTab />}
      {active === 'sonar' && <SonarSettingsTab />} {/* T03371（八期 §3.4.1）：SonarQube 环境配置，位于 API Token 之后 */}
      {active === 'tunnel' && <TunnelPanel />}
      {/* T00441：日志/归档入口从顶部菜单迁入设置页（内网穿透下方） */}
      {active === 'logs' && <LogsPage />}
      {active === 'archive' && <ArchivePage />}
      {active === 'history' && <HistoryPage />} {/* T00756：历史资产（项目快照）嵌入设置页 */}
      {active === 'help' && <HelpTab />}
      {active === 'about' && <AboutTab />}
    </section>
  );
}

/** 任务分类管理：增删改分类。删除分类会使其下任务的分类置空（任务保留、回到未分类） */
function CategoriesTab() {
  const [cats, setCats] = useState<TaskCategory[]>([]);
  const [notice, setNotice] = useState('');

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

  const load = async () => {
    try { setCats(await api.get<TaskCategory[]>('/task-categories')); } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };

  const add = async () => {
    const name = await askInput({ title: '新增任务分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      await api.post('/task-categories', { name });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };

  const rename = async (c: TaskCategory) => {
    const name = await askInput({ title: '重命名分类', defaultValue: c.name, placeholder: '请输入新的分类名称' });
    if (!name || name === c.name) return;
    try {
      await api.patch(`/task-categories/${c.id}`, { name });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (c: TaskCategory) => {
    const ok = await askConfirm(`确认删除分类「${c.name}」？\n该分类下的任务不会被删除，将回到「未分类」。此操作不可恢复。`);
    if (!ok) return;
    try {
      await api.del(`/task-categories/${c.id}`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => { void load(); }, []);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--card-bg)',
    marginBottom: 8,
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-l)', fontWeight: 600 }}><FolderPlus size={14} /> 任务分类</div>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>管理任务归类选项；删除分类后其下任务回到「未分类」。</div>
        </div>
        <button onClick={() => void add()} title="新增分类 — 新建一个任务分类选项" aria-label="新增分类：新建任务分类选项" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <FolderPlus size={13} /> 新增分类
        </button>
      </div>

      {cats.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>暂无分类，点击「新增分类」创建。分类用于在任务页对任务进行归类与筛选。</p>}

      {cats.map((c) => (
        <div key={c.id} style={rowStyle}>
          <FolderPlus size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontWeight: 600 }}>{c.name}</span>
          <button onClick={() => void rename(c)} title="编辑 — 修改该分类名称" aria-label="编辑：修改分类名称" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Pencil size={13} /></button>
          <button onClick={() => void remove(c)} title="删除 — 删除该分类，其下任务回到未分类" aria-label="删除：删除该分类" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
        </div>
      ))}

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}

/** 通用设置：主题 / 字体 / 字号，改动即时生效并持久化 */
function GeneralTab() {
  const { prefs, update } = useSettings();
  // T01057-FR1.1：任务通知开关——AI 任务完成/失败时弹系统通知（仅 Electron 桌面壳环境提供）
  const desktop = (globalThis as unknown as { mtaskDesktop?: { getNotifyEnabled?: () => Promise<boolean>; setNotifyEnabled?: (v: boolean) => Promise<boolean> } }).mtaskDesktop;
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null);
  useEffect(() => { desktop?.getNotifyEnabled?.().then(setNotifyOn); }, [desktop]);
  // T03256（AI-203③）：任务分类建议总开关 + 采纳率（分母为已展示数；无展示时显示「暂无数据」而非 0%）
  const [suggestState, setSuggestState] = useState<{ enabled: boolean; shown: number; accepted: number; adoptionRate: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ enabled: boolean; shown: number; accepted: number; adoptionRate: number | null }>('/ai/suggestions/stats')
      .then((r) => { if (alive) setSuggestState(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const toggleSuggest = async (enabled: boolean) => {
    try {
      const r = await api.put<{ ok: boolean; enabled: boolean }>('/ai/suggestions/enabled', { enabled });
      setSuggestState((cur) => (cur ? { ...cur, enabled: r.enabled } : cur));
    } catch { /* 保存失败保持原态，避免界面显示与服务端不一致 */ }
  };
  // T01071-FR5.4：界面语言（i18n 底座，渐进式接入）
  const [langState, setLangState] = useState<Lang>(getLang());
  const forceRender = useReducer((x: number) => x + 1, 0)[1];
  useEffect(() => onLangChange(() => { setLangState(getLang()); forceRender(); }), []);
  const changeLang = (l: Lang) => { setLang(l); };

  const segButton = (active: boolean): React.CSSProperties => ({
    fontSize: 'var(--fs-m)',
    padding: '4px 12px',
    background: active ? 'var(--accent)' : 'var(--card-bg)',
    color: active ? 'var(--accent-text)' : 'var(--text)',
    cursor: 'pointer',
    borderRadius: 4,
  });

  const field = (title: string, desc: string) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>{desc}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, fontSize: 'var(--fs-l)', fontWeight: 600 }}>
        <Settings size={14} /> 通用设置
      </div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 16 }}>
        以下偏好会立即应用并自动保存，刷新或重开应用后保持。
      </div>

      <div style={{ marginBottom: 18 }}>
        {field('主题', '选择界面配色风格')}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => update('theme', 'light')} style={segButton(prefs.theme === 'light')} title="浅色主题" aria-label="主题：浅色">
            <Sun size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />浅色
          </button>
          <button onClick={() => update('theme', 'dark')} style={segButton(prefs.theme === 'dark')} title="深色主题" aria-label="主题：深色">
            <Moon size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />深色
          </button>
          {/* T01060-FR4.2：跟随系统——auto 由 matchMedia 动态解析明暗 */}
          <button onClick={() => update('theme', 'auto')} style={segButton(prefs.theme === 'auto')} title="跟随系统 — 随操作系统明暗设置自动切换" aria-label="主题：跟随系统">
            <MonitorCog size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />跟随系统
          </button>
        </div>
      </div>

      {/* T01068-FR4.3：主题预设库——主题+强调色的开箱组合，一键应用（当前命中项高亮描边） */}
      <div style={{ marginBottom: 18 }}>
        {field('主题预设', '一键应用成套的主题与强调色组合；应用后仍可在上方微调')}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {THEME_PRESETS.map((p) => {
            const active = prefs.theme === p.theme && prefs.accent === p.accent;
            let themeLabel = '浅色';
            if (p.theme === 'dark') themeLabel = '深色';
            else if (p.theme === 'auto') themeLabel = '跟随系统';
            const accentSuffix = p.accent ? ` · ${p.accent}` : ' · 默认强调色';
            return (
              <button key={p.label}
                onClick={() => { update('theme', p.theme); update('accent', p.accent); }}
                title={`应用预设「${p.label}」（${themeLabel}${accentSuffix}）`}
                aria-label={`主题预设：${p.label}`}
                style={{ ...segButton(active), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: p.accent || (p.theme === 'dark' ? '#3b82f6' : '#2563eb'), display: 'inline-block', border: '1px solid rgba(127,127,127,.35)' }} />
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* T01071-FR5.4：界面语言（i18n 框架底座——渐进式接入，见 web/src/i18n.ts） */}
      <div style={{ marginBottom: 18 }}>
        {field('界面语言 / Language', '切换界面语言；语言包为渐进式接入，未覆盖的页面仍显示中文')}
        <select
          aria-label="界面语言 / Language"
          value={langState}
          onChange={(e) => changeLang(e.target.value === 'en' ? 'en' : 'zh')}
          style={{ padding: 6, fontSize: 'var(--fs-m)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          <option value="zh">中文（默认）</option>
          <option value="en">English (Beta)</option>
        </select>
      </div>

      {/* T01060-FR4.1：自定义强调色——全站 --accent 变量即时生效（按钮文字按亮度自动取深/白） */}
      <div style={{ marginBottom: 18 }}>
        {field('强调色', '全站主按钮/链接/高亮的主色调；恢复默认则回到主题内置配色')}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {ACCENT_PRESETS.map((c) => (
            <button key={c} onClick={() => update('accent', c)} title={`强调色 ${c}`}
              aria-label={`强调色 ${c}`}
              style={{ width: 26, height: 26, borderRadius: 6, border: prefs.accent === c ? '2px solid var(--text)' : '1px solid var(--border-strong)', background: c, cursor: 'pointer' }} />
          ))}
          <input type="color" value={prefs.accent || '#2563eb'} onChange={(e) => update('accent', e.target.value)}
            title="自定义强调色（取色器）" aria-label="自定义强调色取色器"
            style={{ width: 34, height: 26, padding: 0, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', cursor: 'pointer' }} />
          <button onClick={() => update('accent', '')} style={segButton(prefs.accent === '')} title="恢复主题默认强调色" aria-label="恢复默认强调色">
            恢复默认
          </button>
        </div>
      </div>

      {notifyOn !== null && desktop?.setNotifyEnabled && (
        <div style={{ marginBottom: 18 }}>
          {field('任务通知', 'AI 任务处理完成或失败时弹出系统通知，点击通知可跳转到对应任务（仅桌面应用内可用）')}
          <button
            onClick={() => desktop.setNotifyEnabled?.(!notifyOn).then(setNotifyOn)}
            title={notifyOn ? '任务通知：已开启（点击关闭）' : '任务通知：已关闭（点击开启）'}
            aria-label="任务通知开关"
            style={{ ...segButton(notifyOn), minWidth: 150 }}
          >
            {notifyOn ? '已开启（点击关闭）' : '已关闭（点击开启）'}
          </button>
        </div>
      )}

      {suggestState && (
        <div style={{ marginBottom: 18 }} data-t03256="suggest-settings">
          {field('任务分类建议', '在新建/编辑任务时按标题与同项目历史给出分类、优先级和理由；关闭后入口隐藏且不再生成建议')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              onClick={() => void toggleSuggest(!suggestState.enabled)}
              title={suggestState.enabled ? '任务分类建议：已开启（点击关闭）' : '任务分类建议：已关闭（点击开启）'}
              aria-label="任务分类建议开关"
              style={{ ...segButton(suggestState.enabled), minWidth: 150 }}
            >
              {suggestState.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）'}
            </button>
            <span style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }} data-t03256="suggest-stats">
              {suggestState.shown > 0
                ? `采纳率 ${((suggestState.adoptionRate ?? 0) * 100).toFixed(1)}%（${suggestState.accepted}/${suggestState.shown} 条已展示）`
                : '采纳率：暂无数据（尚未展示过建议）'}
            </span>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        {field('字体', '选择界面显示字体')}
        <select
          aria-label="字体"
          value={prefs.font}
          onChange={(e) => update('font', e.target.value as typeof prefs.font)}
          style={{ fontSize: 'var(--fs-m)', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          {FONT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <div style={{ marginTop: 6, fontSize: 'var(--fs-l)', color: 'var(--text-secondary)' }}>
          实时预览：MTask 任务开发管理，AI 梳理与队列分发。
        </div>
      </div>

      <div>
        {field('字体大小', '调节整体字号，实时预览')}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {FONT_SIZE_OPTIONS.map((o) => (
            <button key={o.key} onClick={() => update('fontSize', o.key)} style={segButton(prefs.fontSize === o.key)} title={`字号：${o.label}`} aria-label={`字号：${o.label}`}>
              {o.label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 'var(--fs-l)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', background: 'var(--card-bg)' }}>
          这是一段用于预览字号的正文——随着档位变化，它的字号也会随之缩放。
        </div>
        <div style={{ marginTop: 6, fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
          生效范围：桌面与移动端的页面正文、控件、表格与弹层均已接入字号令牌；导出的 PDF/PPT/Excel 保持固定版式，不随档位缩放。
        </div>
      </div>
    </div>
  );
}

/** 数据迁移：全量导出 / 导入。明确面向换机重装场景 */
function MigrationTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [fname, setFname] = useState('');

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 4000);
  };

  /** 全量导出：调后端把全部用户数据导出为 JSON 并下载到本地文件 */
  async function doExport() {
    try {
      setBusy(true);
      const bundle = await api.get<unknown>('/settings/export');
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dt = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `mtask-backup-${dt}.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash('导出成功，已将全部用户数据保存为备份文件');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 读取所选文件，确认后用选择策略导入 */
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许再次选择同一文件
    if (!file) return;
    setFname(file.name);
    const ok = await askConfirm(
      `将从「${file.name}」导入备份数据（策略：${IMPORT_MODE_LABELS[mode]}）。\n` +
      (mode === 'overwrite'
        ? '覆盖会清空并替换当前应用内的全部数据。导入前会自动创建数据库快照，可在「设置 → 数据维护」恢复；快照创建失败则中止导入、数据保持不变。确认继续？'
        : '确认继续？'),
    );
    if (!ok) return;
    const text = await file.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { flash('文件解析失败：不是有效的 JSON 备份文件'); return; }
    try {
      setBusy(true);
      const r = await api.post<{ imported: number; skippedDuplicateNames?: number; snapshot?: { name: string; size: number } | null; nameConflicts?: Array<{ name: string; owners: Array<{ id: string; name: string }> }> }>('/settings/import', { data, mode });
      // T02945：keep/merge 撞项目重名的行按行跳过（导入是恢复性操作，不整单失败）——跳过了必须说，否则用户以为全量导入了
      const skipped = r.skippedDuplicateNames ?? 0;
      flash(`导入完成，共写入 ${r.imported} 条记录。`
        + (r.snapshot ? `覆盖前快照已保存为 ${r.snapshot.name}，可在「设置 → 数据维护」恢复。` : '')
        + (skipped > 0 ? `其中 ${skipped} 行因项目名与库内重名被跳过（占用行 id 见导入响应/控制台）。` : '')
        + '可切换其他页面查看，或刷新以重载列表');
      if (skipped > 0) console.warn('[settings/import] 项目名冲突跳过的行：', r.nameConflicts);
      setFname('');
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const subOpts = (label: string, desc: string, m: ImportMode) => (
    // aria-label 显式提供可访问名称：label 文本嵌在 span 内，部分辅助技术难以聚合
    <label key={m} aria-label={`${label}：${desc}`} style={{ display: 'flex', gap: 8, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', cursor: 'pointer', alignItems: 'flex-start' }}>
      <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
      <span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>{desc}</span>
      </span>
    </label>
  );

  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>数据迁移</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 14 }}>
        用于<strong>换电脑或重装系统</strong>时迁移用户数据：先在旧机导出备份文件，再到新机安装本应用后导入即可。
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14, background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 6 }}><Download size={14} /> 数据导出</div>
        <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 10 }}>
          将当前应用的全部项目、任务、配置、提示词与队列数据打包为单个 JSON 文件。
        </div>
        <button onClick={() => void doExport()} disabled={busy} title="导出数据 — 把全部用户数据下载为备份文件" aria-label="导出数据：把全部用户数据导出为备份文件" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Save size={13} /> 导出备份
        </button>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 6 }}><FileUp size={14} /> 数据导入</div>
        <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 10 }}>
          选择之前导出的备份文件导入。请先选择冲突处理策略。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {subOpts('合并（推荐）', '导入记录与现有记录合并：ID 相同则用导入值覆盖，新记录追加。', 'merge')}
          {subOpts('保留现有', '仅导入当前不存在的记录，不覆盖已有数据。', 'keep')}
          {subOpts('覆盖全部', '清空并完全替换当前全部数据，以备份文件为准。', 'overwrite')}
        </div>
        {fname && <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>已选择：{fname}</div>}
        <button onClick={() => fileRef.current?.click()} disabled={busy} title="选择备份文件 — 打开文件选择器选取 JSON 备份并导入" aria-label="选择备份文件：选取 JSON 备份并导入" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <FileUp size={13} /> 选择文件导入
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" aria-label="选择备份文件（.json）导入" style={FILE_INPUT_SR_ONLY} onChange={(e) => void onFile(e)} />
      </div>

      {notice && <div style={{ marginTop: 10, fontSize: 'var(--fs-m)', color: 'var(--accent)' }}>{notice}</div>}
    </div>
  );
}

/** 关于：应用信息、版本更新（GitHub Releases 自动检测）、团队与开源协议 */
function AboutTab() {
  const [version, setVersion] = useState(APP_VERSION);

  // 回显真实版本：从后端 /update/version 读取（与 package.json 一致），失败回退编译期常量
  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<{ version: string }>('/update/version');
        if (r.version && r.version !== '0.0.0') setVersion(r.version);
      } catch { /* 接口异常时保留编译期常量，不影响页面展示 */ }
    })();
  }, []);

  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><Info size={14} /> 关于</div>
      <div style={{ marginTop: 12, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
        <div style={{ fontSize: 'var(--fs-title)', fontWeight: 600 }}>{APP_NAME}</div>
        <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginTop: 4 }}>{APP_DESC}</div>
        <div style={{ marginTop: 10, display: 'grid', gap: 4, fontSize: 'var(--fs-m)' }}>
          <div>版本：v{version}</div>
          <div>开发者：南屿轻舟</div>
          <div>邮箱：<a href="mailto:107038953@qq.com" style={{ color: 'var(--accent)' }}>107038953@qq.com</a></div>
          <div>技术栈：Electron · React · Express · SQLite</div>
        </div>
        {/* 纵向 flex + gap 提供显式间距：两个文本都包 span，消除 JSX 换行产生的歧义空格 */}
        <div style={{ marginTop: 14, fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>本应用基于 MIT 协议开源，界面组件使用开源图标库 lucide-react。</span>
          <span>如有问题与建议，请在项目仓库提交 Issue。</span>
        </div>
      </div>

      {/* 版本更新模块：GitHub 仓库配置 + 自动检测最新 Release */}
      <UpdateSection />
    </div>
  );
}

/** 版本更新接口的展示配置（检查结果结构见 stores/updateCardStore） */
interface UpdateConfigView {
  /** 已保存的手动地址（空串＝未配置，回退内置地址） */
  repo: string;
  /** T02977：内置兜底地址 */
  builtinRepo: string;
  /** T02977：当前实际生效的地址来源 */
  source: 'manual' | 'builtin';
  tokenConfigured: boolean;
  tokenMasked: string;
}

/** 版本更新模块：仓库地址 + 可选 Token 配置（加密存储、不回显明文），一键检测 GitHub 最新 Release。
 *  T02977：手动仓库地址会覆盖菜单内置下载地址；留空＝回退内置地址。
 *  T02977 复验补：在途下载/检查结果/失败回执一律取自 updateCardStore——切页回来现场还在，
 *  进度也不会因为组件卸载而看不见。 */
function UpdateSection() {
  const [cfg, setCfg] = useState<UpdateConfigView>({ repo: '', builtinRepo: '', source: 'builtin', tokenConfigured: false, tokenMasked: '' });
  const [repoDraft, setRepoDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const card = useSyncExternalStore(updateCardStore.subscribe, updateCardStore.getSnapshot);
  const { busy, result, cancelledPart, installError, notice } = card;

  const flash = (msg: string) => updateCardStore.flash(msg);
  // busy/result 也归 store：切页回来仍知道「正在下载」还是「空闲」
  const setBusy = updateCardStore.setBusy;
  const setResult = updateCardStore.setResult;

  // T02976 补 → T02977 复验补：现场改由 store 持有。挂载时只保证「进度订阅在位 + 恢复正在进行的那条下载」，
  // 组件卸载不再拆订阅、也不再丢进度（菜单自驱、切页、刷新回来都仍是同一份现场）。
  useEffect(() => { updateCardStore.attach(); }, []);

  // 提示条仍保持「5 秒自动消失」的旧观感：文案存在 store 里（切页不丢），消失计时归界面
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => updateCardStore.clearNotice(), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // T02071：安装成功时应用被安装器接管退出，当场收不到回执——下次启动向主进程对账取回，
  // 成功给一条提示，失败直接进入可重试的回执条（浏览器环境无该 API，自然跳过）
  useEffect(() => {
    void (async () => {
      const desk = desktopApi();
      if (!desk?.getUpdatePendingResult) return;
      try {
        const r = await desk.getUpdatePendingResult();
        if (!r) return;
        if (r.status === 'installed') flash(`上次更新已安装完成${r.targetVersion ? `（v${r.targetVersion}）` : ''}，重启后即为新版本`);
        else updateCardStore.patch({ installError: { message: r.reason ?? '上次安装未生效', filePath: r.filePath ?? '', targetVersion: r.targetVersion ?? '' } });
      } catch { /* 无待回执时静默，不影响页面 */ }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const c = await api.get<UpdateConfigView>('/update/config');
        setCfg(c);
        setRepoDraft(c.repo);
      } catch { /* 配置读取失败不阻塞页面，检查更新时会有明确提示 */ }
    })();
  }, []);

  /** 保存配置：token 留空=不改动已保存值；填入新值=覆盖；私有仓库才需要 Token */
  async function doSave() {
    try {
      setBusy('save');
      const body: Record<string, string> = { repo: repoDraft };
      if (tokenDraft.trim()) body.token = tokenDraft.trim();
      const c = await api.post<UpdateConfigView>('/update/config', body);
      setCfg(c);
      setRepoDraft(c.repo);
      setTokenDraft('');
      flash('配置已保存');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** 连通性测试：用当前表单草稿验证仓库可达（不落库）；留空则测试内置地址 */
  async function doTest() {
    const targetRepo = repoDraft.trim() || cfg.builtinRepo;
    const isBuiltin = !repoDraft.trim();
    try {
      setBusy('test');
      const r = await api.post<{ ok: boolean; latestVersion?: string; error?: string }>('/update/test', { repo: targetRepo, token: tokenDraft || undefined });
      flash(r.ok
        ? `连接成功（${isBuiltin ? '内置地址' : '手动地址'} ${targetRepo}），最新 Release 版本：v${r.latestVersion}`
        : `连接失败：${r.error ?? '未知错误'}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** 检查更新：与当前版本比较，展示最新版本、更新日志与下载入口 */
  async function doCheck() {
    try {
      setBusy('check');
      setResult(null);
      const r = await api.post<UpdateCheckInfo>('/update/check', { force: true });
      setResult(r);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // T00878：应用内一键下载更新包并静默安装（仅 Electron 壳；浏览器环境仍回退 window.open）
  // T02071：下载阶段可中途取消（保留 .part，再点续传）；安装阶段回收退出码，失败给回执条 + 重试
  // T02977 复验补：链路本体搬进 updateCardStore——组件卸载不再打断下载，回来仍看得见进度与取消入口
  async function doDownload() {
    if (!result?.hasUpdate) return;
    const desk = desktopApi();
    if (!desk?.downloadUpdate || !desk.installUpdate) { window.open(result.downloadUrl, '_blank'); return; }
    await updateCardStore.downloadAndInstall(result);
  }

  /** T02071：下载中途取消——断连但保留 .part；结果经 store 的 await 收口为「继续下载」态 */
  async function doCancelDownload() {
    await updateCardStore.cancelDownload();
  }

  /** T02071：安装独立成入口——「重试安装」复用已下载的安装包，不重新下载 */
  async function runInstall(filePath: string, targetVersion: string) {
    await updateCardStore.install(filePath, targetVersion);
  }

  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, fontSize: 'var(--fs-m)', padding: '6px 10px',
    border: '1px solid var(--border-strong)', borderRadius: 6,
    background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box',
  };
  const btnStyle = (primary: boolean): React.CSSProperties => ({
    fontSize: 'var(--fs-m)', padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
    whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4,
    background: primary ? 'var(--accent)' : 'var(--card-bg)',
    color: primary ? 'var(--accent-text)' : 'var(--text)',
    border: primary ? 'none' : '1px solid var(--border-strong)',
  });

  // T00878：按当前阶段给更新按钮友好文案（T02071 增加「继续下载」与取消入口）
  // T02976 补：菜单发起的下载也走同一套按钮/进度呈现，文案上标明来源
  const shownProgress = shownProgressOf(card);
  // T02977 复验补：进度视图走单源纯函数——起步（还没收到首帧）与无总量也都有话可说
  const progressView = shownProgress ? updateProgressView(shownProgress) : null;
  // 下载在途（含刚点下去、主进程还没回第一帧）——这一段此前界面只有按钮文案，容易被当成「没反应」
  const downloadInFlight = busy === 'download' || (card.externalDl !== null && isInFlightStatus(card.externalDl.status));
  let updateBtnLabel = cancelledPart !== null ? '继续下载' : '立即更新';
  if (busy === 'download') updateBtnLabel = progressView?.pct != null ? `下载中 ${progressView.pct}%` : '下载中…';
  else if (busy === 'install') updateBtnLabel = '正在安装…';
  else if (card.externalDl && isInFlightStatus(card.externalDl.status)) updateBtnLabel = progressView?.pct != null ? `下载中 ${progressView.pct}%` : '下载中…';

  return (
    <div style={{ marginTop: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><RefreshCw size={14} /> 版本更新</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginTop: 4 }}>
        通过 GitHub Releases 自动检测新版本。菜单「帮助 → 检查在线更新」默认使用内置地址；下方手动填写的仓库地址会覆盖内置地址，留空则回退内置地址
        {cfg.builtinRepo ? `（内置：${cfg.builtinRepo}）` : ''}。公开仓库无需认证；私有仓库请配置具有读取权限的 Token（加密存储，不会回显明文）。
      </div>

      {/* 仓库地址 */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 'var(--fs-m)', whiteSpace: 'nowrap' }} htmlFor="update-repo">仓库地址</label>
        <input
          id="update-repo"
          value={repoDraft}
          onChange={(e) => setRepoDraft(e.target.value)}
          placeholder={cfg.builtinRepo ? `留空使用内置地址 ${cfg.builtinRepo}` : 'owner/repo 或 https://github.com/owner/repo'}
          style={inputStyle}
        />
      </div>
      <div style={{ marginTop: 4, marginLeft: 64, fontSize: 'var(--fs-s, 12px)', color: 'var(--text-secondary)' }}>
        当前生效：{cfg.source === 'manual' ? `手动地址 ${cfg.repo}` : `内置地址 ${cfg.builtinRepo || '—'}`}
      </div>
      {/* 认证凭据（可选）：password 型避免旁观泄露；已配置时 placeholder 展示掩码 */}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 'var(--fs-m)', whiteSpace: 'nowrap' }} htmlFor="update-token">访问令牌</label>
        <input
          id="update-token"
          type="password"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          placeholder={cfg.tokenConfigured ? `已配置（${cfg.tokenMasked}），留空表示不修改` : '可选：私有仓库填 GitHub Token（公开仓库留空）'}
          style={inputStyle}
          autoComplete="new-password"
        />
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => void doSave()} disabled={busy !== null} title="保存配置 — 仓库地址留空表示回退内置地址" aria-label="保存更新配置" style={btnStyle(true)}>
          <Save size={13} /> {busy === 'save' ? '保存中…' : '保存配置'}
        </button>
        <button onClick={() => void doTest()} disabled={busy !== null} title="测试连接 — 验证地址可达并读取最新 Release 版本号；留空测试内置地址" aria-label="测试 GitHub 连接" style={btnStyle(false)}>
          <ShieldCheck size={13} /> {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button onClick={() => void doCheck()} disabled={busy !== null} title="检查更新 — 拉取当前生效地址的最新 Release 并与当前版本比较" aria-label="检查更新" style={btnStyle(false)}>
          <RefreshCw size={13} /> {busy === 'check' ? '检查中…' : '检查更新'}
        </button>
      </div>

      {/* 检查结果卡片 */}
      {result && (
        <div style={{
          marginTop: 12, padding: 12, borderRadius: 6, fontSize: 'var(--fs-m)',
          border: `1px solid ${result.hasUpdate ? 'var(--success, #2e7d32)' : 'var(--border)'}`,
          background: result.hasUpdate ? 'rgba(46, 125, 50, 0.06)' : 'transparent',
        }}>
          {result.hasUpdate ? (
            <>
              <div style={{ fontWeight: 600 }}>
                发现新版本：v{result.latestVersion}（当前 v{result.currentVersion}）
              </div>
              {result.publishedAt && (
                <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
                  发布时间：{result.publishedAt.slice(0, 10)}
                </div>
              )}
              <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
                下载来源：{result.source === 'manual' ? '手动配置地址' : '内置地址'}{result.repo ? ` ${result.repo}` : ''}
              </div>
              {result.changelog && (
                <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: 220, overflowY: 'auto', lineHeight: 1.6 }}>
                  {result.changelog}
                </div>
              )}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => void doDownload()} disabled={downloadInFlight || busy === 'install'} title={cancelledPart !== null ? '继续下载 — 从上次取消的断点续传' : '下载新版本 — 应用内下载安装包并静默安装重启'} aria-label="下载并静默安装新版本" style={btnStyle(true)}>
                  <Download size={13} />
                  {/* T00878：按当前阶段给按钮友好文案 */}
                  {updateBtnLabel}
                </button>
                {/* T02071 缺口 1：下载中给出取消入口（取消保留 .part，可继续）；
                    T02976 补：菜单发起的下载同样可在这里取消，不必回去找菜单 */}
                {downloadInFlight && (
                  <button onClick={() => void doCancelDownload()} title="取消下载 — 中断本次下载并保留已下载部分，稍后可从断点继续" aria-label="取消当前下载" style={btnStyle(false)}>
                    <Ban size={13} /> 取消下载
                  </button>
                )}
                <button onClick={() => window.open(result.releaseUrl, '_blank')} title="查看 Release 页 — 浏览完整更新说明与历史版本" aria-label="查看 Release 页面" style={btnStyle(false)}>
                  <ExternalLink size={13} /> 查看发布页
                </button>
              </div>
              {/* T00878：下载进度——Electron 壳内下载时展示 received/total；
                  T02976 补：菜单通道的下载同样在此显示（shownProgress 已按来源选好）；
                  T02977 复验补：只要有下载在途就必有可见进度行（起步/无总量也不例外），
                  否则「点了下载却什么都没提示」又回来了 */}
              {progressView && (
                <div style={{ marginTop: 10 }} data-update-progress>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--border-strong)', overflow: 'hidden' }}>
                    {progressView.showBar ? (
                      <div style={{ height: '100%', width: `${progressView.pct}%`, background: 'var(--accent)', transition: 'width .2s' }} />
                    ) : (
                      // 总量未知：不画假百分比，用整条弱色表示「确实在跑」
                      <div style={{ height: '100%', width: '100%', background: 'var(--accent-soft, var(--border))', opacity: .45 }} />
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                    {progressView.text}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div>当前已是最新版本：v{result.currentVersion}（远端最新 v{result.latestVersion}）</div>
              <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
                下载来源：{result.source === 'manual' ? '手动配置地址' : '内置地址'}{result.repo ? ` ${result.repo}` : ''}
              </div>
            </>
          )}
        </div>
      )}

      {/* T02071 缺口 2：安装失败回执条——当场失败或下次启动对账为失败都会出现在这里，
          应用保持存活，「重试安装」复用已下载的安装包（不重新下载） */}
      {installError && (
        <div style={{
          marginTop: 12, padding: 12, borderRadius: 6, fontSize: 'var(--fs-m)',
          border: '1px solid var(--danger, #c62828)', background: 'rgba(198, 40, 40, 0.06)',
        }}>
          <div style={{ fontWeight: 600 }}>安装失败：{installError.message}</div>
          <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
            当前版本未改变，应用仍在运行。安装包已保留{installError.filePath ? `（${installError.filePath}）` : ''}，可直接重试。
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void runInstall(installError.filePath, installError.targetVersion)} disabled={busy !== null || !installError.filePath} title="重试安装 — 用已下载的安装包重新静默安装" aria-label="重试安装新版本" style={btnStyle(true)}>
              <RotateCcw size={13} /> 重试安装
            </button>
            <button onClick={() => updateCardStore.patch({ installError: null })} title="关闭提示" aria-label="关闭安装失败提示" style={btnStyle(false)}>关闭</button>
          </div>
        </div>
      )}

      {notice && <div style={{ marginTop: 8, fontSize: 'var(--fs-m)', color: 'var(--accent)' }}>{notice}</div>}
    </div>
  );
}