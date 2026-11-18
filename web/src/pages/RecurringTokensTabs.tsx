import { useCallback, useEffect, useState } from 'react';
import { api, type TaskCategory } from '../api/client';
import { askConfirm } from '../ui/dialogs'; // T01699：确认框归一（原生 confirm 阻塞渲染线程且样式不一致）
import { AlertTriangle, ChevronDown, HelpCircle, LayoutTemplate, Pencil, Play, Save, X } from 'lucide-react';
import { RecurringSchedulePicker, defaultSchedule, ruleFromSchedule, scheduleFromRule, scheduleSummary, type RecurringSchedule } from './RecurringSchedulePicker';
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
  id: string; project_id: string; project_name: string; title: string; description?: string;
  priority?: string; category_id?: string | null; interval_n?: number | null; first_run_immediate?: number | null;
  freq: string; cron_expr?: string; next_run_at: string; last_task_no: string | null; enabled: number; created_at: string;
}
const FREQ_LABELS: Record<string, string> = {
  daily: term('每天'), weekly: term('每周'), monthly: term('每月'), cron: term('cron 定时'),
  interval_days: term('每 N 天'), interval_weeks: term('每 N 周'),
};
/** T01071 后续：频率标签在渲染时取译文（模块级 t() 只会算一次，切语言后不刷新） */
const freqLabel = (k: string): string => t(FREQ_LABELS[k] ?? k, FREQ_LABELS[k] ?? k);
/** T01073 后续：cron 5 段式提示（分 时 日 月 周） */
const CRON_PLACEHOLDER = '0 9 * * 1';

/** T05818：后端 next_run_at 是 UTC 存储串；展示时转本地（不再直接 slice）。 */
const INBOX_PROJECT_ID = 'sys-inbox';

/** T06003：常用循环任务模板——卡片只负责填表，项目统一落收件箱，创建仍走原 /recurring 接口。 */
interface RecurringTemplate {
  id: string;
  name: string;
  hint: string;
  title: string;
  description: string;
  priority: string;
  categoryName: string;
  kind: RecurringSchedule['kind'];
  hour: number;
  minute: number;
  weekday?: number;
  monthDay?: number;
  intervalN?: number;
}

const RECURRING_TEMPLATES: RecurringTemplate[] = [
  {
    id: 'daily-read', name: '每日资讯阅读', hint: '每天 08:30 生成一份阅读任务',
    title: '今日资讯阅读', description: '阅读当天与项目相关的行业资讯/公告，整理 3 条要点并标注来源；完成后把摘要回写到任务结果。', priority: 'normal', categoryName: '学习', kind: 'daily', hour: 8, minute: 30,
  },
  {
    id: 'weekly-report', name: '每周工作周报', hint: '每周五 17:30 生成',
    title: '本周工作周报', description: '汇总本周完成事项、未完成事项与下周计划；按项目/任务编号列出来源，输出 Markdown 周报。', priority: 'normal', categoryName: '文档', kind: 'weekly', hour: 17, minute: 30, weekday: 5,
  },
  {
    id: 'weekly-review', name: '每周复盘', hint: '每周一 10:00 生成',
    title: '上周复盘与本周计划', description: '复盘上周目标达成情况、阻塞与风险，给出本周三项优先事项及可执行动作。', priority: 'high', categoryName: '复盘', kind: 'weekly', hour: 10, minute: 0, weekday: 1,
  },
  {
    id: 'monthly-check', name: '每月数据核对', hint: '每月 1 日 09:00 生成',
    title: '月度数据核对', description: '核对上月关键数据口径与异常波动，列出差异清单、原因假设和需要人工确认的问题。', priority: 'normal', categoryName: '数据', kind: 'monthly', hour: 9, minute: 0, monthDay: 1,
  },
  {
    id: 'interval-followup', name: '隔天跟进事项', hint: '每 2 天生成一次跟进任务',
    title: '隔天跟进待办', description: '检查当前未闭环事项的进展，按负责人/截止时间列出需要跟进的对象，并给出下一步动作。', priority: 'normal', categoryName: '跟进', kind: 'interval_days', hour: 9, minute: 0, intervalN: 2,
  },
  /* T06011：扩充 8 条常用循环任务模板（资讯/知识/竞品/安全/分支/技术简报）。 */
  {
    id: 'daily-ai-news', name: '每日 AI 新闻推送', hint: '每天 08:00，AI coding 与具身智能 3-5 条',
    title: '每日 AI 新闻推送',
    description: `关注当天 AI 领域的重要动态，侧重 AI coding 与具身智能方向。筛选 3-5 条有价值的信息，简要说明事件内容及值得关注的原因。结合 memory.md 里之前推送过的内容，尽量不要重复。`,
    priority: 'normal', categoryName: '学习', kind: 'daily', hour: 8, minute: 0,
  },
  {
    id: 'today-history', name: '历史上的今天', hint: '每天 08:30，科技/电影/音乐任选一则',
    title: '历史上的今天',
    description: `历史上的今天发生过什么有趣的事？从科技、电影、音乐等领域中挑一个，讲讲它的来龙去脉。控制在 200-300 字左右。`,
    priority: 'normal', categoryName: '学习', kind: 'daily', hour: 8, minute: 30,
  },
  {
    id: 'daily-knowledge', name: '学点小知识', hint: '每天 07:09，冷知识问答 200-300 字',
    title: '学点小知识',
    description: `从科学、历史、自然、动物、人体、食物、文化、日常生活等领域中随机选题，尽量不和之前的重复；先抛出一个引人好奇的问题，再给出通俗有趣的解答，像跟朋友聊天一样讲清楚来龙去脉，答案控制在 200-300 字。`,
    priority: 'normal', categoryName: '学习', kind: 'daily', hour: 7, minute: 9,
  },
  {
    id: 'competitor-ai-apps', name: '竞品动态调研', hint: '每天 07:09，AI 类 APP 过去 24 小时动态',
    title: '竞品动态调研',
    description: `搜集过去 24 小时内 AI 类 APP/客户端的动态，包括但不限于产品更新、功能变动、定价调整和市场动作等，按重要性从高到低排序，并标注信息来源。`,
    priority: 'normal', categoryName: '数据', kind: 'daily', hour: 7, minute: 9,
  },
  {
    id: 'chip-storage-news', name: '每日新闻推送', hint: '每天 07:09，芯片存储行业 5-8 条',
    title: '每日新闻推送',
    description: `搜集过去 24 小时内芯片存储行业的全球重要动态，筛选 5-8 条最有价值的信息，按重要性从高到低排序，并标注信息来源。`,
    priority: 'normal', categoryName: '学习', kind: 'daily', hour: 7, minute: 9,
  },
  {
    id: 'active-security-scan', name: '主动安全扫描', hint: '每天 09:00，扫描密钥/注入/路径穿越/依赖漏洞',
    title: '主动安全扫描',
    description: `对本仓库做一次主动安全扫描：检查硬编码密钥/凭证/Token、命令拼接与 SQL 拼接、不安全反序列化、路径穿越与越权读写、依赖中的已知高危漏洞。每条必须定位到具体文件行号；按可利用性判高/中/低；只给修复建议，不要改代码。输出开头一行统计，并按可利用性排序列出文件路径 + 行号 + 风险类型 + 一句话修复建议，与上次扫描对比标出新增项。`,
    priority: 'high', categoryName: '复盘', kind: 'daily', hour: 9, minute: 0,
  },
  {
    id: 'stale-branch-cleanup', name: '陈旧本地分支清理建议', hint: '每周一 09:30，只给建议不执行删除',
    title: '陈旧本地分支清理建议',
    description: `盘点本地 30 天没有提交活动的分支（远程分支一律不动），查清最后提交时间、是否已合入主干、是否有未推送提交；只给清理建议，绝对不要执行删除命令。已合入主干且无未推送提交的才建议删除，有未推送提交的一律建议保留。输出建议删除/建议保留两组，每条列分支名 + 最后提交时间 + 一句话理由。`,
    priority: 'normal', categoryName: '跟进', kind: 'weekly', hour: 9, minute: 30, weekday: 1,
  },
  {
    id: 'tech-hot-brief', name: '技术热点简报', hint: '每周一 08:30，GitHub 新项目/版本/行业动态',
    title: '技术热点简报',
    description: `扫描最近三天的技术热点：GitHub 上近期冒头的项目（看增速而非总 star 数）、常用技术栈的重要版本发布或重大特性、值得关注的行业动态或开源事件。全文 10 行以内；每个项目一句话说清它做什么、为什么突然火、和我的关系；没有值得看的内容直接说没有，不要凑数。按「新项目」「版本更新」「其他动态」分段，无内容写「本期无」。`,
    priority: 'normal', categoryName: '学习', kind: 'weekly', hour: 8, minute: 30, weekday: 1,
  },
];

function parseStoreTime(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function formatLocalDateTime(s: string, withTime = true): string {
  const d = parseStoreTime(s);
  if (!d) return s || '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

export function RecurringTab() {
  useLang();
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const projectList = useProjectList({ excludeInbox: true });
  const { projects } = projectList;
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [categoryId, setCategoryId] = useState('');
  const [schedule, setSchedule] = useState<RecurringSchedule>(() => defaultSchedule());
  const [firstImmediate, setFirstImmediate] = useState(true);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runBusyId, setRunBusyId] = useState('');
  const [editRule, setEditRule] = useState<RecurringRule | null>(null);
  const [notice, setNotice] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3500); };

  const load = useCallback(async () => {
    void loadProjectList();
    try { setRules(await api.get<RecurringRule[]>('/recurring')); } catch { /* 规则列表失败不阻塞表单 */ }
    try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 分类失败不阻塞 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // T05823 复查：周期选择变化即向后端要「下次生成」预览；空自定义 cron 不发请求，失败时清空旧预览，
  // 避免「上一次有效时间」与错误提示并列展示造成误判。
  useEffect(() => {
    let alive = true;
    const rule = ruleFromSchedule(schedule);
    if (!schedule.advanced && schedule.kind === 'cron' && !rule.cron) {
      setPreview('');
      setPreviewError('自定义 cron 不能为空');
      return;
    }
    setPreview('');
    setPreviewError('');
    const timer = setTimeout(() => {
      api.post<{ nextRunAt: string }>('/recurring/preview', { ...rule, firstRunImmediate: firstImmediate })
        .then((r) => { if (alive) { setPreview(formatLocalDateTime(r.nextRunAt)); setPreviewError(''); } })
        .catch((e) => { if (alive) { setPreview(''); setPreviewError(e instanceof Error ? e.message : String(e)); } });
    }, 260);
    return () => { alive = false; clearTimeout(timer); };
  }, [schedule, firstImmediate]);

  async function createRule() {
    const rule = ruleFromSchedule(schedule);
    if (!projectId || !title.trim()) return flash(t('请选择项目并填写标题', '请选择项目并填写标题'));
    if (!schedule.advanced && schedule.kind === 'cron' && !rule.cron) return flash('自定义 cron 不能为空');
    if (!description.trim() && !(await askConfirm('未填写「执行说明」：生成的任务只有标题，外部 Agent 认领后可能不知道要做什么。仍要创建吗？'))) return;
    setBusy(true);
    try {
      await api.post('/recurring', {
        projectId, title: title.trim(), description: description.trim(), priority,
        categoryId: categoryId || null, freq: rule.freq, cron: rule.cron, intervalN: rule.intervalN, firstRunImmediate: firstImmediate,
      });
      setTitle('');
      setDescription('');
      flash(`循环规则已创建；${firstImmediate ? '下一分钟内生成首份' : `首份按计划 ${preview || '首次到期时刻'} 生成`}。周期只决定何时生成，任务仍由外部 Agent 认领执行。`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  /** T06003：套用模板——项目强制收件箱，其余字段按模板预填，用户可继续微调。 */
  function applyTemplate(tpl: RecurringTemplate) {
    const base = defaultSchedule();
    setProjectId(INBOX_PROJECT_ID);
    setTitle(tpl.title);
    setDescription(tpl.description);
    setPriority(tpl.priority);
    const matched = categories.find((c) => c.name === tpl.categoryName);
    setCategoryId(matched?.id ?? '');
    setSchedule({
      ...base, advanced: false, kind: tpl.kind, hour: tpl.hour, minute: tpl.minute, weekday: tpl.weekday ?? base.weekday,
      monthDay: tpl.monthDay ?? base.monthDay, intervalN: tpl.intervalN ?? base.intervalN,
    });
    setTemplatesOpen(false);
    flash(`已套用模板「${tpl.name}」：项目已设为收件箱，确认周期与执行说明后点「添加规则」。`);
  }

  async function toggleRule(rule: RecurringRule) {
    try { await api.put(`/recurring/${rule.id}`, { enabled: !rule.enabled }); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function runNow(rule: RecurringRule) {
    if (runBusyId) return;
    setRunBusyId(rule.id);
    try {
      const r = await api.post<{ taskNo: string; nextRunAt: string }>(`/recurring/${rule.id}/run-now`, {});
      flash(`已立即生成 ${r.taskNo}；当前轮次已推进，下一轮 ${formatLocalDateTime(r.nextRunAt)}`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setRunBusyId(''); }
  }

  const cell: { padding: number; borderBottom: string; fontSize: string } = { padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)' };
  const projectSelectIdleText = projectList.phase === 'loading' ? t('项目列表加载中…', '项目列表加载中…') : t('选择项目…', '选择项目…');
  // T06002：收件箱始终作为显式选项（sys-inbox 与任务菜单收件箱同值）；其余活跃项目来自统一容错层（已排除收件箱）
  const projectOptions = [
    { id: INBOX_PROJECT_ID, name: '收件箱' },
    ...projects.filter((p) => p.id !== INBOX_PROJECT_ID),
  ];
  const rule = ruleFromSchedule(schedule);

  return (
    <div style={{ maxWidth: 980 }}>
      {/* T06002：大段说明默认收敛为帮助入口，点击展开/再点收起；收敛态不占主要操作区垂直空间 */}
      <div data-t06002="help" style={{ marginBottom: 10 }}>
        <button type="button" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} aria-controls="recurring-help-body"
          title={helpOpen ? '收起循环任务说明' : '展开循环任务说明：周期只决定何时生成，不执行任务'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--fs-s)' }}>
          <HelpCircle size={14} />
          循环任务如何工作？
          <ChevronDown size={13} style={{ transform: helpOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
        </button>
        {helpOpen && (
          <div id="recurring-help-body" data-t05823="intro"
            style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginTop: 8, background: 'var(--surface)', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
            <div style={{ fontSize: 'var(--fs-m)', fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>循环任务只负责「按周期生成任务副本」，不会自动执行任务</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>执行由外部 Agent / WorkBuddy 从 MTask 就绪池认领后完成；循环规则本身不运行任务内容。</li>
              <li>周期 / cron 只决定「何时生成」，不决定「任务做什么」；任务做什么必须写进下面的<b>执行说明</b>。</li>
              <li>规则名称只作为生成任务的标题模板，生成时会自动追加日期后缀；不要把执行指令藏在名称里。</li>
              <li>调度器每 60 秒检查一次；<b>错过的历史周期不会自动补生成</b>，恢复后只生成当前一轮。</li>
              <li>时间按本地时区展示，存储仍为 UTC；创建或编辑调度时可选「立即生成首份」或「按首次计划时刻生成」。</li>
            </ul>
          </div>
        )}
      </div>

      <div data-t05823="create" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('循环任务项目', '循环任务项目')}
            disabled={projectList.phase === 'loading' && projects.length === 0}
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="">{projectList.phase === 'error' ? t('项目列表加载失败', '项目列表加载失败') : projectSelectIdleText}</option>
            {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <ProjectListHint view={projectList} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="规则名称（生成任务标题模板，如：写周报）" aria-label="循环任务标题"
            style={{ flex: 1, minWidth: 200, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="生成任务优先级"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option>
          </select>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="生成任务分类"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="">不分类</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          placeholder="执行说明 / 任务描述：告诉外部执行者具体要做什么、输入在哪、完成标准是什么。该内容会写入每一条生成任务。"
          aria-label="循环任务执行说明"
          data-t05817="description"
          style={{ width: '100%', boxSizing: 'border-box', padding: 8, fontSize: 'var(--fs-s)', border: `1px solid ${description.trim() ? 'var(--border-strong)' : 'var(--warning, #d97706)'}`, borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', resize: 'vertical' }} />
        {!description.trim() && <div data-t05817="empty-warning" style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning, #d97706)', display: 'flex', gap: 4, alignItems: 'center' }}><AlertTriangle size={12} /> 建议填写执行说明：空描述会让认领者只能看到标题。</div>}

        <RecurringSchedulePicker value={schedule} onChange={setSchedule} previewText={preview} error={previewError} />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--fs-xs)' }}>
          <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={firstImmediate} onChange={(e) => setFirstImmediate(e.target.checked)} />
            创建后立即生成首份（不勾选则按{rule.cron ? ' cron 首次计划时刻' : '该间隔的首次到期时刻'}生成）
          </label>
          <span style={{ flex: 1 }} />
          <button onClick={() => void createRule()} disabled={busy}
            style={{ padding: '7px 16px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', fontSize: 'var(--fs-s)', fontWeight: 600 }}>
            {busy ? '创建中…' : t('添加规则', '添加规则')}
          </button>
          {/* T06003：模板入口固定在「添加规则」右侧 */}
          <button type="button" onClick={() => setTemplatesOpen((v) => !v)} aria-expanded={templatesOpen} aria-controls="recurring-templates"
            title="从模板添加 — 套用预设的名称/说明/周期/分类/优先级，项目默认收件箱"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-s)' }}>
            <LayoutTemplate size={13} /> 从模板添加
            <ChevronDown size={12} style={{ transform: templatesOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
          </button>
        </div>
        {notice && <div data-t05823="notice" style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}
      </div>

      {/* T06003：模板卡片容器——点击任意卡片即回填表单，项目强制收件箱 */}
      {templatesOpen && (
        <div id="recurring-templates" data-t06003="templates" style={{ marginBottom: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
          <div style={{ fontSize: 'var(--fs-m)', fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>从模板添加</div>
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 10 }}>选择常用场景，自动填入规则名称、执行说明、周期、分类与优先级；项目统一使用收件箱，仍可创建前微调。</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
            {RECURRING_TEMPLATES.map((tpl) => (
              <button key={tpl.id} type="button" data-t06003="template-card" onClick={() => applyTemplate(tpl)}
                title={`套用模板「${tpl.name}」`}
                style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer', display: 'grid', gap: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', fontWeight: 600 }}>
                  <LayoutTemplate size={13} style={{ color: 'var(--accent)' }} /> {tpl.name}
                </span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{tpl.hint}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>优先级 {tpl.priority} · 分类 {tpl.categoryName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {rules.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>{t('暂无循环规则——上方添加一条即可。', '暂无循环规则——上方添加一条即可。')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
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
                <tr key={r.id} data-t05823="rule-row">
                  <td style={{ ...cell, color: r.enabled ? 'var(--text)' : 'var(--text-muted)', maxWidth: 280 }}>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    {r.description?.trim() && <div title={r.description} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{r.description}</div>}
                  </td>
                  <td style={cell}>{r.project_name}</td>
                  <td style={cell}>
                    <div>{r.freq === 'cron' ? <span style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'var(--fs-xs)' }}>{r.cron_expr}</span> : freqLabel(r.freq)}</div>
                    {(r.freq === 'interval_days' || r.freq === 'interval_weeks') && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>间隔 {r.interval_n ?? 1}</div>}
                  </td>
                  <td style={{ ...cell, color: 'var(--text-muted)' }} title={`本地时间：${formatLocalDateTime(r.next_run_at)}；存储 UTC：${r.next_run_at}`}>{formatLocalDateTime(r.next_run_at)}</td>
                  <td style={cell}>{r.last_task_no ?? '—'}</td>
                  <td style={cell}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => void runNow(r)} disabled={runBusyId === r.id}
                        title="立即生成 — 不等 tick，马上生成一份任务副本" aria-label="立即生成"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', padding: '3px 7px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--accent)', cursor: runBusyId === r.id ? 'wait' : 'pointer' }}>
                        <Play size={11} />{runBusyId === r.id ? '生成中…' : '立即生成'}
                      </button>
                      <button onClick={() => setEditRule(r)} title="编辑规则 — 标题/说明/调度/项目" aria-label="编辑循环规则"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', padding: '3px 7px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}>
                        <Pencil size={11} />编辑
                      </button>
                      <button onClick={() => void toggleRule(r)} title={r.enabled ? t('停用该规则', '停用该规则') : t('启用该规则', '启用该规则')}
                        style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: r.enabled ? 'var(--text-secondary)' : 'var(--accent)', cursor: 'pointer' }}>
                        {r.enabled ? t('停用', '停用') : t('启用', '启用')}
                      </button>
                      <button onClick={async () => { if (await askConfirm(`${t('删除循环规则', '删除循环规则')}「${r.title}」？${t('已生成的任务不受影响。', '已生成的任务不受影响。')}`)) { await api.del(`/recurring/${r.id}`); void load(); } }}
                        title={t('删除该规则', '删除该规则')}
                        style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--danger)', cursor: 'pointer' }}>
                        {t('删除', '删除')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editRule && <RecurringRuleEditor rule={editRule} projects={projects} categories={categories}
        onClose={() => setEditRule(null)} onSaved={async () => { setEditRule(null); await load(); flash('规则已保存，新生成任务将使用新值'); }} />}
    </div>
  );
}

/** T05820：规则编辑弹窗——与新建共用同一套引导式选择器/高级模式，保存后由服务端重算 next_run_at。 */
function RecurringRuleEditor({ rule, projects, categories, onClose, onSaved }: {
  readonly rule: RecurringRule;
  readonly projects: Array<{ id: string; name: string }>;
  readonly categories: TaskCategory[];
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(rule.title);
  const [description, setDescription] = useState(rule.description ?? '');
  const [priority, setPriority] = useState(rule.priority ?? 'normal');
  const [categoryId, setCategoryId] = useState(rule.category_id ?? '');
  const [projectId, setProjectId] = useState(rule.project_id);
  const [schedule, setSchedule] = useState<RecurringSchedule>(() => scheduleFromRule(rule));
  const [firstImmediate, setFirstImmediate] = useState((rule.first_run_immediate ?? 1) !== 0);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const r = ruleFromSchedule(schedule);
    const baseline = ruleFromSchedule(scheduleFromRule(rule));
    const scheduleChanged = r.cron !== baseline.cron || r.freq !== baseline.freq || r.intervalN !== baseline.intervalN;
    if (!schedule.advanced && schedule.kind === 'cron' && !r.cron) {
      setPreview('');
      setError('自定义 cron 不能为空');
      return;
    }
    // 复查：调度未变时保存不会重排 next_run_at，预览必须显示库里的当前值；
    // 若仍调用 preview（从 now 起算），间隔类规则会显示一个与真实下一次不同的时间。
    if (!scheduleChanged) {
      setPreview(rule.next_run_at ? formatLocalDateTime(rule.next_run_at) : '');
      setError('');
      return;
    }
    setPreview('');
    setError('');
    const timer = setTimeout(() => {
      // 只改标题/说明时 scheduleChanged=false，预览不能显示「现在」，否则会与「保存不重排」的真实行为相反。
      api.post<{ nextRunAt: string }>('/recurring/preview', { ...r, firstRunImmediate: scheduleChanged ? firstImmediate : false })
        .then((x) => { if (alive) { setPreview(formatLocalDateTime(x.nextRunAt)); setError(''); } })
        .catch((e) => { if (alive) { setPreview(''); setError(e instanceof Error ? e.message : String(e)); } });
    }, 260);
    return () => { alive = false; clearTimeout(timer); };
  }, [schedule, firstImmediate, rule]);

  async function save() {
    const r = ruleFromSchedule(schedule);
    if (!title.trim() || !projectId) { setError('标题与项目必填'); return; }
    if (!schedule.advanced && schedule.kind === 'cron' && !r.cron) { setError('自定义 cron 不能为空'); return; }
    setBusy(true);
    try {
      await api.put(`/recurring/${rule.id}`, {
        title: title.trim(), description: description.trim(), priority, categoryId: categoryId || null,
        projectId, freq: r.freq, cron: r.cron, intervalN: r.intervalN, firstRunImmediate: firstImmediate,
      });
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label="编辑循环规则" style={{ width: 'min(720px, 94vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card-bg)', borderRadius: 10, boxShadow: '0 10px 34px rgba(0,0,0,.2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', fontWeight: 700 }}>
          <Pencil size={14} /> 编辑循环规则
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="关闭编辑弹窗" title="关闭" style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer' }}><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="规则项目" style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="规则标题" placeholder="规则名称" style={{ flex: 1, minWidth: 180, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="优先级" style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option>
          </select>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="分类" style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="">不分类</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} aria-label="执行说明"
          placeholder="执行说明 / 任务描述：会写入每条生成任务，外部执行者据此执行"
          style={{ width: '100%', boxSizing: 'border-box', padding: 8, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', resize: 'vertical' }} />
        <RecurringSchedulePicker value={schedule} onChange={setSchedule} previewText={preview} error={error} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-xs)' }}>
          <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={firstImmediate} onChange={(e) => setFirstImmediate(e.target.checked)} />
            调度变更后立即生成首份（不勾选则按计划/间隔首次到期时刻）
          </label>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ padding: '6px 12px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}>取消</button>
          <button onClick={() => void save()} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: busy ? 'wait' : 'pointer' }}>
            <Save size={13} />{busy ? '保存中…' : '保存'}
          </button>
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>当前摘要：{scheduleSummary(schedule)}</div>
      </div>
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
