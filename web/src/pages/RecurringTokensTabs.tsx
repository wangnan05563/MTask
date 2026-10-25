import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs'; // T01699：确认框归一（原生 confirm 阻塞渲染线程且样式不一致）
import { ProjectListHint, loadProjectList, useProjectList } from '../ui/projectList'; // T02201：项目列表统一容错层
import { getLang, onLangChange, registerDict, setLang as setGlobalLang, t, term, useLang, type Lang } from '../i18n';

/**
 * T01073-FR5.5 / FR-5.6：循环任务与 API Token 管理面板（设置页嵌入）。
 *
 * T01071 后续：本文件是「按菜单逐页迁移」的**试点页**——页面专有文案在此集中注册英文包，
 * 通用词（保存/删除/启用…）走 web/src/i18n/terms.ts 术语表，页面内不再出现裸中文字面量。
 * 迁移范式：① 集中 registerDict ② 调用处一律 t('中文') ③ CI（npm run i18n:report）验证覆盖率。
 */
registerDict('en', {
  // 页面专有文案
  '切换界面语言': 'Switch UI language',
  '切换到中文': 'Switch to Chinese',
  '请选择项目并填写标题': 'Pick a project and enter a title',
  '循环规则已创建': 'Recurring rule created',
  '按 cron 定时生成': 'scheduled by cron',
  '循环规则已创建（server 启动与每小时 tick 时到期生成）': 'Recurring rule created (generated on server start and every hourly tick when due)',
  '已改为 cron': 'changed to cron',
  '已取消 cron，按': 'cron cleared, generating',
  '生成': 'Generate',
  '按周期自动生成任务副本（例：每周周报）。到期由后端每小时检查并生成，标题自动带日期后缀。':
    'Generates task copies on a schedule (e.g. a weekly report). The server checks every hour and appends the date to the title.',
  '需要精确到时刻时填 cron 表达式': 'For an exact time, fill in a cron expression',
  '分 时 日 月 周': 'min hour day month weekday',
  '，如': ', e.g.',
  '= 每周一 9:00，按本地时区；留空则按上面的频率粗粒度生成。': '= every Monday at 9:00 in local time; leave empty to fall back to the frequency above.',
  '选择项目…': 'Select project…',
  // T02201：项目列表容错态占位文案
  '项目列表加载中…': 'Loading projects…',
  '项目列表加载失败': 'Failed to load the project list',
  '任务标题（如：写周报）': 'Task title (e.g. write weekly report)',
  '循环任务项目': 'Recurring task project',
  '循环任务标题': 'Recurring task title',
  '循环频率': 'Recurrence frequency',
  'cron 可选（如': 'cron optional (e.g.',
  'cron 表达式': 'cron expression',
  'cron 5 段式：分 时 日 月 周（按本地时区）。填写后忽略上面的频率下拉，可精确到时刻，如「0 9 * * 1」= 每周一 9:00':
    'cron with 5 fields: min hour day month weekday (local time). Overrides the frequency above, e.g. "0 9 * * 1" = every Monday at 9:00',
  '添加规则': 'Add rule',
  '暂无循环规则——上方添加一条即可。': 'No recurring rules yet — add one above.',
  '频率': 'Frequency',
  '下次生成': 'Next run',
  '最近生成': 'Last run',
  '操作': 'Actions',
  '停用该规则': 'Disable this rule',
  '启用该规则': 'Enable this rule',
  '停用': 'Disable',
  '启用': 'Enable',
  '删除循环规则': 'Delete recurring rule',
  '已生成的任务不受影响。': 'Tasks already generated are unaffected.',
  '删除该规则': 'Delete this rule',
  'cron 5 段式：分 时 日 月 周（本地时区）。回车/失焦保存；清空则回退为按频率生成':
    'cron with 5 fields: min hour day month weekday (local time). Save on Enter/blur; clear to fall back to the frequency',
  // API Token 页签
  '请填写凭据名称（如：CI 脚本）': 'Enter a credential name (e.g. CI script)',
  '权限范围已改为': 'scope changed to',
  '供外部脚本调用 MTask REST API 的具名凭据（请求头 X-Access-Token）；在内网穿透开启时与主令牌等效。可随时停用或撤销。':
    'Named credentials for external scripts calling the MTask REST API (header X-Access-Token); equivalent to the master token when the tunnel is on. Disable or revoke at any time.',
  '凭据仅放行 GET（写操作返回 403），适合给看板/统计类脚本——拿到 token 也改不动数据。':
    'A read-only credential allows GET only (writes return 403) — good for dashboards and stats scripts, since the token cannot change data.',
  '凭据名称（如：CI 脚本）': 'Credential name (e.g. CI script)',
  'API Token 名称': 'API Token name',
  'API Token 权限范围': 'API Token scope',
  '只读 = 仅放行 GET 请求（写操作返回 403）；读写 = 与当前行为一致': 'Read-only = GET only (writes return 403); Read/write = same as today',
  '生成 Token': 'Generate Token',
  '暂无 Token——上方生成一个即可。': 'No tokens yet — generate one above.',
  '请立即复制': 'Copy now',
  '的 Token（明文仅展示这一次）：': 'token (plaintext shown only once):',
  '已复制到剪贴板': 'Copied to clipboard',
  '调用示例：': 'Example call:',
  '范围': 'Scope',
  '最近使用': 'Last used',
  '从未使用': 'Never used',
  '切换权限范围 — 只读凭据只能发 GET 请求': 'Toggle scope — read-only credentials can only issue GET requests',
  '撤销': 'Revoke',
  '的脚本将立即失去访问权限。': 'scripts using it lose access immediately.',
  '撤销凭据': 'Revoke credential',
});

/** T01071-FR5.4 复用：语言切换按钮（i18n 底座的用户可见接入点） */
export function LangSwitch() {
  const [lang, setLang] = useState<Lang>(getLang());
  useEffect(() => onLangChange(() => setLang(getLang())), []);
  const next: Lang = lang === 'zh' ? 'en' : 'zh';
  return (
    <button
      onClick={() => setGlobalLang(next)}
      title={lang === 'zh' ? 'Switch to English (Beta)' : t('切换到中文', '切换到中文')}
      aria-label={t('切换界面语言', '切换界面语言')}
      style={{ fontSize: 'var(--fs-xs)', padding: '3px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}
    >
      {lang === 'zh' ? 'EN' : '中'}
    </button>
  );
}

interface RecurringRule {
  id: string; project_id: string; project_name: string; title: string;
  freq: string; cron_expr?: string; next_run_at: string; last_task_no: string | null; enabled: number; created_at: string;
}
const FREQ_LABELS: Record<string, string> = { daily: term('每天'), weekly: term('每周'), monthly: term('每月'), cron: term('cron 定时') };
/** T01071 后续：频率标签在渲染时取译文（模块级 t() 只会算一次，切语言后不刷新） */
const freqLabel = (k: string): string => t(FREQ_LABELS[k] ?? k, FREQ_LABELS[k] ?? k);
/** T01073 后续：cron 5 段式提示（分 时 日 月 周） */
const CRON_PLACEHOLDER = '0 9 * * 1';

export function RecurringTab() {
  useLang(); // T01071 后续：语言切换后重渲染（t() 结果随之更新）
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const projectList = useProjectList({ excludeInbox: true }); // T02201
  const { projects } = projectList;
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [freq, setFreq] = useState('weekly');
  // T01073 后续：cron 表达式（可选）。非空时优先于上面的频率下拉——精确到「每周一 9:00」这类时刻
  const [cron, setCron] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    // T02201：项目列表改由容错层取数——与规则列表解绑，任一条取数失败不再连带把另一条也拖成空态
    void loadProjectList();
    try {
      setRules(await api.get<RecurringRule[]>('/recurring'));
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createRule() {
    if (!projectId || !title.trim()) return flash(t('请选择项目并填写标题', '请选择项目并填写标题'));
    setBusy(true);
    try {
      await api.post('/recurring', { projectId, title: title.trim(), freq, cron: cron.trim(), priority: 'normal' });
      setTitle('');
      setCron('');
      flash(cron.trim()
        ? `${t('循环规则已创建', '循环规则已创建')}（${t('按 cron 定时生成', '按 cron 定时生成')}「${cron.trim()}」）`
        : t('循环规则已创建（server 启动与每小时 tick 时到期生成）', '循环规则已创建（server 启动与每小时 tick 时到期生成）'));
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** T01073 后续：行内改 cron 表达式（改完即时生效；非法表达式由后端拒绝，错误直接闪现） */
  async function updateCron(rule: RecurringRule, expr: string) {
    if (expr === (rule.cron_expr ?? '')) return;
    try {
      await api.put(`/recurring/${rule.id}`, { cron: expr });
      flash(expr
        ? `「${rule.title}」${t('已改为 cron', '已改为 cron')}「${expr}」`
        : `「${rule.title}」${t('已取消 cron，按', '已取消 cron，按')}${freqLabel(rule.freq)}${t('生成', '生成')}`);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); }
  }

  const cell: { padding: number; borderBottom: string; fontSize: string } = { padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)' };

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>{t('循环任务', '循环任务')}</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('按周期自动生成任务副本（例：每周周报）。到期由后端每小时检查并生成，标题自动带日期后缀。', '按周期自动生成任务副本（例：每周周报）。到期由后端每小时检查并生成，标题自动带日期后缀。')}
        {t('需要精确到时刻时填 cron 表达式', '需要精确到时刻时填 cron 表达式')}（<code>{t('分 时 日 月 周', '分 时 日 月 周')}</code>{t('，如', '，如')} <code>0 9 * * 1</code> {t('= 每周一 9:00，按本地时区；留空则按上面的频率粗粒度生成。', '= 每周一 9:00，按本地时区；留空则按上面的频率粗粒度生成。')}）
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('循环任务项目', '循环任务项目')}
          disabled={projectList.unusable}
          style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">{projectList.phase === 'error' ? t('项目列表加载失败', '项目列表加载失败')
            : projectList.phase === 'loading' ? t('项目列表加载中…', '项目列表加载中…')
            : t('选择项目…', '选择项目…')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ProjectListHint view={projectList} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('任务标题（如：写周报）', '任务标题（如：写周报）')} aria-label={t('循环任务标题', '循环任务标题')}
          style={{ flex: 1, minWidth: 180, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
        <select value={freq} onChange={(e) => setFreq(e.target.value)} aria-label={t('循环频率', '循环频率')}
          style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {Object.entries(FREQ_LABELS).map(([k]) => <option key={k} value={k}>{freqLabel(k)}</option>)}
        </select>
        <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder={`${t('cron 可选（如', 'cron 可选（如')} ${CRON_PLACEHOLDER}）`} aria-label={t('cron 表达式', 'cron 表达式')}
          title={t('cron 5 段式：分 时 日 月 周（按本地时区）。填写后忽略上面的频率下拉，可精确到时刻，如「0 9 * * 1」= 每周一 9:00', 'cron 5 段式：分 时 日 月 周（按本地时区）。填写后忽略上面的频率下拉，可精确到时刻，如「0 9 * * 1」= 每周一 9:00')}
          onKeyDown={(e) => { if (e.key === 'Enter') void createRule(); }}
          style={{ width: 150, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
        <button onClick={() => void createRule()} disabled={busy}
          style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-s)' }}>
          {t('添加规则', '添加规则')}
        </button>
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}

      {rules.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>{t('暂无循环规则——上方添加一条即可。', '暂无循环规则——上方添加一条即可。')}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('标题', '标题')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('项目', '项目')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('频率', '频率')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('下次生成', '下次生成')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('最近生成', '最近生成')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('操作', '操作')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td style={{ ...cell, color: r.enabled ? 'var(--text)' : 'var(--text-muted)' }}>{r.title}</td>
                <td style={cell}>{r.project_name}</td>
                <td style={cell}>
                  {r.freq === 'cron' ? (
                    <input key={`${r.id}-${r.cron_expr ?? ''}`} defaultValue={r.cron_expr ?? ''} aria-label={`${r.title} ${t('cron 表达式', 'cron 表达式')}`}
                      title={t('cron 5 段式：分 时 日 月 周（本地时区）。回车/失焦保存；清空则回退为按频率生成', 'cron 5 段式：分 时 日 月 周（本地时区）。回车/失焦保存；清空则回退为按频率生成')}
                      onBlur={(e) => void updateCron(r, e.target.value.trim())}
                      onKeyDown={(e) => { if (e.key === 'Enter') void updateCron(r, e.currentTarget.value.trim()); }}
                      style={{ width: 110, padding: 3, fontSize: 'var(--fs-xs)', fontFamily: 'Consolas, Menlo, monospace', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text)' }} />
                  ) : (freqLabel(r.freq))}
                </td>
                <td style={{ ...cell, color: 'var(--text-muted)' }}>{r.next_run_at.slice(0, r.freq === 'cron' ? 16 : 10)}</td>
                <td style={cell}>{r.last_task_no ?? '—'}</td>
                <td style={cell}>
                  <button onClick={async () => { await api.put(`/recurring/${r.id}`, { enabled: !r.enabled }); void load(); }}
                    title={r.enabled ? t('停用该规则', '停用该规则') : t('启用该规则', '启用该规则')}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: r.enabled ? 'var(--text-secondary)' : 'var(--accent)', cursor: 'pointer', marginRight: 4 }}>
                    {r.enabled ? t('停用', '停用') : t('启用', '启用')}
                  </button>
                  <button onClick={async () => { if (await askConfirm(`${t('删除循环规则', '删除循环规则')}「${r.title}」？${t('已生成的任务不受影响。', '已生成的任务不受影响。')}`)) { await api.del(`/recurring/${r.id}`); void load(); } }}
                    title={t('删除该规则', '删除该规则')}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--danger)', cursor: 'pointer' }}>
                    {t('删除', '删除')}
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

/** T01073 后续：权限范围——read 只读（仅放行 GET，写操作返回 403）/ write 读写 */
type TokenScope = 'read' | 'write';
const SCOPE_LABELS: Record<TokenScope, string> = { read: term('只读'), write: term('读写') };
/** T01071 后续：范围标签同样在渲染时取译文 */
const scopeLabel = (k: TokenScope): string => t(SCOPE_LABELS[k], SCOPE_LABELS[k]);
interface ApiTokenRow { id: string; name: string; token_masked: string; scope?: TokenScope; enabled: number; created_at: string; last_used_at: string | null }

export function ApiTokensTab() {
  useLang(); // T01071 后续：语言切换后重渲染
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('write');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [notice, setNotice] = useState('');
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    try { setTokens(await api.get<ApiTokenRow[]>('/tokens')); } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createToken() {
    if (!name.trim()) return flash(t('请填写凭据名称（如：CI 脚本）', '请填写凭据名称（如：CI 脚本）'));
    try {
      const r = await api.post<{ id: string; name: string; token: string; scope: TokenScope }>('/tokens', { name: name.trim(), scope });
      setFresh({ name: r.name, token: r.token }); // 明文仅此一次展示
      setName('');
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); }
  }

  /** T01073 后续：切换权限范围（只读凭据的写操作会被后端 403 拦下） */
  async function toggleScope(tk: ApiTokenRow) {
    const next: TokenScope = tk.scope === 'read' ? 'write' : 'read';
    try {
      await api.put(`/tokens/${tk.id}`, { scope: next });
      flash(`「${tk.name}」${t('权限范围已改为', '权限范围已改为')}${scopeLabel(next)}`);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); }
  }

  const cell: { padding: number; borderBottom: string; fontSize: string } = { padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)' };

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>API Token</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('供外部脚本调用 MTask REST API 的具名凭据（请求头 X-Access-Token）；在内网穿透开启时与主令牌等效。可随时停用或撤销。', '供外部脚本调用 MTask REST API 的具名凭据（请求头 X-Access-Token）；在内网穿透开启时与主令牌等效。可随时停用或撤销。')}
        <b>{t('只读', '只读')}</b>{t('凭据仅放行 GET（写操作返回 403），适合给看板/统计类脚本——拿到 token 也改不动数据。', '凭据仅放行 GET（写操作返回 403），适合给看板/统计类脚本——拿到 token 也改不动数据。')}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('凭据名称（如：CI 脚本）', '凭据名称（如：CI 脚本）')} aria-label={t('API Token 名称', 'API Token 名称')}
          onKeyDown={(e) => { if (e.key === 'Enter') void createToken(); }}
          style={{ flex: 1, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
        <select value={scope} onChange={(e) => setScope(e.target.value as TokenScope)} aria-label={t('API Token 权限范围', 'API Token 权限范围')}
          title={t('只读 = 仅放行 GET 请求（写操作返回 403）；读写 = 与当前行为一致', '只读 = 仅放行 GET 请求（写操作返回 403）；读写 = 与当前行为一致')}
          style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {(Object.keys(SCOPE_LABELS) as TokenScope[]).map((k) => <option key={k} value={k}>{scopeLabel(k)}</option>)}
        </select>
        <button onClick={() => void createToken()}
          style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-s)' }}>
          {t('生成 Token', '生成 Token')}
        </button>
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}

      {fresh && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--accent-soft)' }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 6 }}>⚠ {t('请立即复制', '请立即复制')}「{fresh.name}」{t('的 Token（明文仅展示这一次）：', '的 Token（明文仅展示这一次）：')}</div>
          <code style={{ display: 'block', padding: 8, background: 'var(--card-bg)', borderRadius: 6, fontSize: 'var(--fs-s)', wordBreak: 'break-all', userSelect: 'all' }}>{fresh.token}</code>
          <button onClick={() => { void navigator.clipboard.writeText(fresh.token); flash(t('已复制到剪贴板', '已复制到剪贴板')); }}
            style={{ marginTop: 8, fontSize: 'var(--fs-s)', padding: '4px 12px', border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--accent)', cursor: 'pointer' }}>
            {t('复制', '复制')}
          </button>
          <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {t('调用示例：', '调用示例：')}<code>curl -H &quot;X-Access-Token: &lt;token&gt;&quot; http://127.0.0.1:39876/api/tasks?archived=0</code>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>{t('暂无 Token——上方生成一个即可。', '暂无 Token——上方生成一个即可。')}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('标题', '标题')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>Token</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('范围', '范围')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('最近使用', '最近使用')}</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{t('操作', '操作')}</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id}>
                <td style={{ ...cell, color: tk.enabled ? 'var(--text)' : 'var(--text-muted)' }}>{tk.name}</td>
                <td style={{ ...cell, fontFamily: 'Consolas, Menlo, monospace', color: 'var(--text-muted)' }}>{tk.token_masked}</td>
                <td style={cell}>
                  <button onClick={() => void toggleScope(tk)} title={t('切换权限范围 — 只读凭据只能发 GET 请求', '切换权限范围 — 只读凭据只能发 GET 请求')}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: tk.scope === 'read' ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer' }}>
                    {scopeLabel(tk.scope ?? 'write')}
                  </button>
                </td>
                <td style={cell}>{tk.last_used_at ? tk.last_used_at.slice(0, 16) : t('从未使用', '从未使用')}</td>
                <td style={cell}>
                  <button onClick={async () => { await api.put(`/tokens/${tk.id}`, { enabled: !tk.enabled }); void load(); }}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: tk.enabled ? 'var(--text-secondary)' : 'var(--accent)', cursor: 'pointer', marginRight: 4 }}>
                    {tk.enabled ? t('停用', '停用') : t('启用', '启用')}
                  </button>
                  <button onClick={async () => { if (await askConfirm(`${t('撤销', '撤销')}「${tk.name}」？${t('的脚本将立即失去访问权限。', '的脚本将立即失去访问权限。')}`)) { await api.del(`/tokens/${tk.id}`); void load(); } }}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--danger)', cursor: 'pointer' }}>
                    {t('撤销', '撤销')}
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
