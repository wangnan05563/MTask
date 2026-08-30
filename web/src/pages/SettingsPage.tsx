import { useEffect, useRef, useState } from 'react';
import { api, type TaskCategory } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { FONT_OPTIONS, FONT_SIZE_OPTIONS, useSettings, type ImportMode } from '../settings';
import { Download, FileUp, FolderPlus, Info, Moon, Network, Pencil, Save, Settings, Sun, Trash2 } from 'lucide-react';
import { TunnelPanel } from './TunnelPanel';

/** 应用信息（与根 package.json 保持一致） */
const APP_NAME = 'MTask';
const APP_VERSION = '0.1.0';
const APP_DESC = 'AI 任务开发管理工具：项目维度任务管理 + AI 梳理 + 队列分发。';

type STab = 'general' | 'migration' | 'categories' | 'tunnel' | 'about';

const SUB_TABS: { key: STab; label: string }[] = [
  { key: 'general', label: '通用设置' },
  { key: 'migration', label: '数据迁移' },
  { key: 'categories', label: '任务分类' },
  { key: 'tunnel', label: '内网穿透' },
  { key: 'about', label: '关于' },
];

/** 设置页面：多 Tab 布局（通用设置 / 数据迁移 / 关于）。所有颜色用 CSS 变量，自动适配当前主题。 */
export function SettingsPage() {
  const [st, setSt] = useState<STab>('general');
  return (
    <section>
      <nav style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSt(t.key)}
            style={{
              fontSize: 'var(--fs-m)',
              padding: '6px 14px',
              borderRadius: 6,
              background: st === t.key ? 'var(--accent)' : 'var(--card-bg)',
              color: st === t.key ? 'var(--accent-text)' : 'var(--text)',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {st === 'general' && <GeneralTab />}
      {st === 'migration' && <MigrationTab />}
      {st === 'categories' && <CategoriesTab />}
      {st === 'tunnel' && <TunnelPanel />}
      {st === 'about' && <AboutTab />}
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
          <button onClick={() => void rename(c)} title="编辑 — 修改该分类名称" aria-label="编辑：修改分类名称" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Pencil size={13} /></button>
          <button onClick={() => void remove(c)} title="删除 — 删除该分类，其下任务回到未分类" aria-label="删除：删除该分类" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
        </div>
      ))}

      {notice && <div style={{ marginTop: 8, fontSize: 'var(--fs-m)', color: 'var(--accent)' }}>{notice}</div>}
    </div>
  );
}

/** 通用设置：主题 / 字体 / 字号，改动即时生效并持久化 */
function GeneralTab() {
  const { prefs, update } = useSettings();

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
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        {field('字体', '选择界面显示字体')}
        <select
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
      `将从「${file.name}」导入备份数据（策略：${mode === 'overwrite' ? '覆盖' : mode === 'keep' ? '保留' : '合并'}）。\n` +
      (mode === 'overwrite' ? '覆盖会清空并替换当前应用内的全部数据，此操作不可恢复，确认继续？' : '确认继续？'),
    );
    if (!ok) return;
    const text = await file.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { flash('文件解析失败：不是有效的 JSON 备份文件'); return; }
    try {
      setBusy(true);
      const r = await api.post<{ imported: number }>('/settings/import', { data, mode });
      flash(`导入完成，共写入 ${r.imported} 条记录。可切换其他页面查看，或刷新以重载列表`);
      setFname('');
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const subOpts = (active: (m: ImportMode) => boolean, label: string, desc: string, m: ImportMode) => (
    <label key={m} style={{ display: 'flex', gap: 8, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', cursor: 'pointer', alignItems: 'flex-start' }}>
      <input type="radio" name="mode" checked={active(m)} onChange={() => setMode(m)} />
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
          {subOpts((m) => m === 'merge', '合并（推荐）', '导入记录与现有记录合并：ID 相同则用导入值覆盖，新记录追加。', 'merge')}
          {subOpts((m) => m === 'keep', '保留现有', '仅导入当前不存在的记录，不覆盖已有数据。', 'keep')}
          {subOpts((m) => m === 'overwrite', '覆盖全部', '清空并完全替换当前全部数据，以备份文件为准。', 'overwrite')}
        </div>
        {fname && <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>已选择：{fname}</div>}
        <button onClick={() => fileRef.current?.click()} disabled={busy} title="选择备份文件 — 打开文件选择器选取 JSON 备份并导入" aria-label="选择备份文件：选取 JSON 备份并导入" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <FileUp size={13} /> 选择文件导入
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => void onFile(e)} />
      </div>

      {notice && <div style={{ marginTop: 10, fontSize: 'var(--fs-m)', color: 'var(--accent)' }}>{notice}</div>}
    </div>
  );
}

/** 关于：应用信息、团队与开源协议 */
function AboutTab() {
  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><Info size={14} /> 关于</div>
      <div style={{ marginTop: 12, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{APP_NAME}</div>
        <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginTop: 4 }}>{APP_DESC}</div>
        <div style={{ marginTop: 10, display: 'grid', gap: 4, fontSize: 'var(--fs-m)' }}>
          <div>版本：v{APP_VERSION}</div>
          <div>开发者：MTask 开发团队</div>
          <div>技术栈：Electron · React · Express · SQLite</div>
        </div>
        <div style={{ marginTop: 14, fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
          本应用基于 MIT 协议开源，界面组件使用开源图标库 lucide-react。
          <span style={{ display: 'block', marginTop: 4 }}>
            如有问题与建议，请在项目仓库提交 Issue。
          </span>
        </div>
      </div>
    </div>
  );
}