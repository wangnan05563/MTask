import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { getLang, onLangChange, setLang, t, type Lang } from '../i18n';

/**
 * T01073-FR5.5 / FR-5.6：循环任务与 API Token 管理面板（设置页嵌入）。
 */

/** T01071-FR5.4 复用：语言切换按钮（i18n 底座的用户可见接入点） */
export function LangSwitch() {
  const [lang, setLangState] = useState<Lang>(getLang());
  useEffect(() => onLangChange(() => setLangState(getLang())), []);
  const next: Lang = lang === 'zh' ? 'en' : 'zh';
  return (
    <button
      onClick={() => setLang(next)}
      title={lang === 'zh' ? 'Switch to English (Beta)' : '切换到中文'}
      aria-label="切换界面语言"
      style={{ fontSize: 11, padding: '3px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}
    >
      {lang === 'zh' ? 'EN' : '中'}
    </button>
  );
}

interface ProjectRowLite { id: string; name: string }
interface RecurringRule {
  id: string; project_id: string; project_name: string; title: string;
  freq: string; next_run_at: string; last_task_no: string | null; enabled: number; created_at: string;
}
const FREQ_LABELS: Record<string, string> = { daily: '每天', weekly: '每周', monthly: '每月' };

export function RecurringTab() {
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [projects, setProjects] = useState<ProjectRowLite[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [freq, setFreq] = useState('weekly');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    try {
      setRules(await api.get<RecurringRule[]>('/recurring'));
      setProjects((await api.get<ProjectRowLite[]>('/projects')).filter((p) => p.id !== 'sys-inbox'));
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createRule() {
    if (!projectId || !title.trim()) return flash('请选择项目并填写标题');
    setBusy(true);
    try {
      await api.post('/recurring', { projectId, title: title.trim(), freq, priority: 'normal' });
      setTitle('');
      flash('循环规则已创建（server 启动与每小时 tick 时到期生成）');
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  const cell: { padding: number; borderBottom: string; fontSize: number } = { padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 12 };

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>{t('循环任务', '循环任务')}</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        按周期自动生成任务副本（例：每周周报）。到期由后端每小时检查并生成，标题自动带日期后缀。
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="循环任务项目"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题（如：写周报）" aria-label="循环任务标题"
          style={{ flex: 1, minWidth: 180, padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
        <select value={freq} onChange={(e) => setFreq(e.target.value)} aria-label="循环频率"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {Object.entries(FREQ_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={() => void createRule()} disabled={busy}
          style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
          添加规则
        </button>
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--accent)' }}>{notice}</div>}

      {rules.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12 }}>暂无循环规则——上方添加一条即可。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 12 }}>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>标题</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>项目</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>频率</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>下次生成</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>最近生成</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td style={{ ...cell, color: r.enabled ? 'var(--text)' : 'var(--text-muted)' }}>{r.title}</td>
                <td style={cell}>{r.project_name}</td>
                <td style={cell}>{FREQ_LABELS[r.freq] ?? r.freq}</td>
                <td style={{ ...cell, color: 'var(--text-muted)' }}>{r.next_run_at.slice(0, 10)}</td>
                <td style={cell}>{r.last_task_no ?? '—'}</td>
                <td style={cell}>
                  <button onClick={async () => { await api.put(`/recurring/${r.id}`, { enabled: !r.enabled }); void load(); }}
                    title={r.enabled ? '停用该规则' : '启用该规则'}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: r.enabled ? 'var(--text-secondary)' : 'var(--accent)', cursor: 'pointer', marginRight: 4 }}>
                    {r.enabled ? '停用' : '启用'}
                  </button>
                  <button onClick={async () => { if (window.confirm(`删除循环规则「${r.title}」？已生成的任务不受影响。`)) { await api.del(`/recurring/${r.id}`); void load(); } }}
                    title="删除该规则"
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--danger)', cursor: 'pointer' }}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ApiTokenRow { id: string; name: string; token_masked: string; enabled: number; created_at: string; last_used_at: string | null }

export function ApiTokensTab() {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [notice, setNotice] = useState('');
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    try { setTokens(await api.get<ApiTokenRow[]>('/tokens')); } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createToken() {
    if (!name.trim()) return flash('请填写凭据名称（如：CI 脚本）');
    try {
      const r = await api.post<{ id: string; name: string; token: string }>('/tokens', { name: name.trim() });
      setFresh({ name: r.name, token: r.token }); // 明文仅此一次展示
      setName('');
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); }
  }

  const cell: { padding: number; borderBottom: string; fontSize: number } = { padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 12 };

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>API Token</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        供外部脚本调用 MTask REST API 的具名凭据（请求头 X-Access-Token）；在内网穿透开启时与主令牌等效。可随时停用或撤销。
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="凭据名称（如：CI 脚本）" aria-label="API Token 名称"
          onKeyDown={(e) => { if (e.key === 'Enter') void createToken(); }}
          style={{ flex: 1, padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
        <button onClick={() => void createToken()}
          style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
          生成 Token
        </button>
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--accent)' }}>{notice}</div>}

      {fresh && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--accent-soft)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>⚠ 请立即复制「{fresh.name}」的 Token（明文仅展示这一次）：</div>
          <code style={{ display: 'block', padding: 8, background: 'var(--card-bg)', borderRadius: 6, fontSize: 12, wordBreak: 'break-all', userSelect: 'all' }}>{fresh.token}</code>
          <button onClick={() => { void navigator.clipboard.writeText(fresh.token); flash('已复制到剪贴板'); }}
            style={{ marginTop: 8, fontSize: 12, padding: '4px 12px', border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--accent)', cursor: 'pointer' }}>
            复制
          </button>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            调用示例：<code>curl -H &quot;X-Access-Token: &lt;token&gt;&quot; http://127.0.0.1:39876/api/tasks?archived=0</code>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12 }}>暂无 Token——上方生成一个即可。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 12 }}>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>名称</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>Token</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>最近使用</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id}>
                <td style={{ ...cell, color: tk.enabled ? 'var(--text)' : 'var(--text-muted)' }}>{tk.name}</td>
                <td style={{ ...cell, fontFamily: 'Consolas, Menlo, monospace', color: 'var(--text-muted)' }}>{tk.token_masked}</td>
                <td style={cell}>{tk.last_used_at ? tk.last_used_at.slice(0, 16) : '从未使用'}</td>
                <td style={cell}>
                  <button onClick={async () => { await api.put(`/tokens/${tk.id}`, { enabled: !tk.enabled }); void load(); }}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: tk.enabled ? 'var(--text-secondary)' : 'var(--accent)', cursor: 'pointer', marginRight: 4 }}>
                    {tk.enabled ? '停用' : '启用'}
                  </button>
                  <button onClick={async () => { if (window.confirm(`撤销「${tk.name}」？使用该 Token 的脚本将立即失去访问权限。`)) { await api.del(`/tokens/${tk.id}`); void load(); } }}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--danger)', cursor: 'pointer' }}>
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
