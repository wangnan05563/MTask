/**
 * 移动端「需求 / 计划 / 甘特」只读视图（PM-104 ⑤⑥）。
 *
 * 口径：
 * - 桌面端的能力（新建/编辑/拖拽排期/状态流转/AI 评估）一律不搬到移动端；
 *   本页只提供「能看到」，页面常驻只读提示，避免出现点了没反应的伪编辑控件。
 * - 数据源与桌面同源：`GET /plans?projectId=`、`GET /plans/prd-requirements?projectId=`。
 * - 甘特为纯几何投影：按起止日（自然日）在统一时间轴上等比例画条，进度以条内填充表示，
 *   今日线仅作刻度参考；没有任何拖拽/点击改值入口。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { loadProjectList, ProjectListHint, useProjectList } from '../ui/projectList';
import { Badge, cardStyle, EmptyState, mutedStyle, Skeleton, wideHintStyle, type BadgeTone } from './ui';

interface Props {
  readonly notify: (msg: string, isErr?: boolean) => void;
}

interface PlanRow {
  readonly id: string;
  readonly title: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly duration_days: number;
  readonly progress: number;
  readonly status: 'todo' | 'doing' | 'done' | 'blocked';
  readonly kind?: string;
  readonly assignee?: string;
}

interface ReqRow {
  readonly id: string;
  readonly req_no: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly priority: string | null;
  readonly linkedPlans: ReadonlyArray<{ id: string; title: string; status: string }>;
  readonly linkedTasks: ReadonlyArray<{ taskNo: string | null; title: string | null; status: string; verified: boolean }>;
}

const PLAN_STATUS: Record<PlanRow['status'], { label: string; tone: BadgeTone }> = {
  todo: { label: '待开始', tone: 'neutral' },
  doing: { label: '进行中', tone: 'accent' },
  done: { label: '已完成', tone: 'success' },
  blocked: { label: '受阻', tone: 'danger' },
};

const REQ_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  todo: { label: '待实现', tone: 'neutral' },
  doing: { label: '实现中', tone: 'accent' },
  done: { label: '已实现', tone: 'success' },
  changed: { label: '已变更', tone: 'danger' },
};

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → UTC 天序号（按日历日对齐，避开本地时区/DST 造成的半天偏移） */
function dayIndex(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function todayIndex(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
}

function mdLabel(iso: string): string {
  return iso.slice(5, 10);
}

export function MobilePlans({ notify }: Props) {
  const list = useProjectList();
  const [projectId, setProjectId] = useState('');
  const [tab, setTab] = useState<'plans' | 'reqs'>('plans');
  const [view, setView] = useState<'list' | 'gantt'>('list');
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [reqs, setReqs] = useState<ReqRow[] | null>(null);

  useEffect(() => { void loadProjectList(); }, []);

  // 首次进入：沿用移动端「上次浏览项目」，缺失或已删时回落列表首个
  useEffect(() => {
    if (projectId || list.projects.length === 0) return;
    let pref = '';
    try { pref = localStorage.getItem('mtask.mobile.lastProject') ?? ''; } catch { /* 忽略 */ }
    setProjectId(list.projects.some((p) => p.id === pref) ? pref : list.projects[0].id);
  }, [list.projects, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setPlans(null);
    setReqs(null);
    void (async () => {
      try {
        const q = `projectId=${encodeURIComponent(projectId)}`;
        const [p, r] = await Promise.all([
          api.get<PlanRow[]>(`/plans?${q}`),
          api.get<ReqRow[]>(`/plans/prd-requirements?${q}`),
        ]);
        if (!alive) return;
        setPlans(Array.isArray(p) ? p : []);
        setReqs(Array.isArray(r) ? r : []);
      } catch (e) {
        if (!alive) return;
        setPlans([]);
        setReqs([]);
        notify(e instanceof Error ? e.message : String(e), true);
      }
    })();
    return () => { alive = false; };
  }, [projectId, notify]);

  const loading = plans === null || reqs === null;
  const projectName = list.projects.find((p) => p.id === projectId)?.name ?? '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 8px' }}>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', flexShrink: 0 }}>项目</span>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="切换查看的项目"
          style={{ flex: 1, padding: 8, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-m)', background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          {list.projects.length === 0 && <option value="">{projectName || '暂无项目'}</option>}
          {list.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ProjectListHint view={list} style={{ ...wideHintStyle, padding: '0 0 8px' }} />

      <div style={segWrap} role="group" aria-label="需求或计划">
        <button type="button" onClick={() => setTab('plans')} aria-pressed={tab === 'plans'} style={seg(tab === 'plans')}>计划（{plans?.length ?? 0}）</button>
        <button type="button" onClick={() => setTab('reqs')} aria-pressed={tab === 'reqs'} style={seg(tab === 'reqs')}>需求（{reqs?.length ?? 0}）</button>
      </div>

      {tab === 'plans' && (
        <div style={segWrap} role="group" aria-label="计划视图">
          <button type="button" onClick={() => setView('list')} aria-pressed={view === 'list'} style={seg(view === 'list')}>列表</button>
          <button type="button" onClick={() => setView('gantt')} aria-pressed={view === 'gantt'} style={seg(view === 'gantt')}>甘特图</button>
        </div>
      )}

      <div style={{ ...mutedStyle, padding: '2px 2px 10px' }}>
        移动端只读视图——查看排期与进度，编辑 / 拖拽 / 新建请在桌面端操作。
      </div>

      {loading && <Skeleton rows={4} card />}

      {!loading && tab === 'plans' && plans.length === 0 && (
        <EmptyState icon="🗓️" message="该项目暂无计划" hint="可在桌面端「项目计划」中导入或新建。" />
      )}
      {!loading && tab === 'plans' && plans.length > 0 && view === 'list' && <PlanList plans={plans} />}
      {!loading && tab === 'plans' && plans.length > 0 && view === 'gantt' && <PlanGantt plans={plans} />}

      {!loading && tab === 'reqs' && reqs.length === 0 && (
        <EmptyState icon="📋" message="该项目暂无需求" hint="需求来自 PRD 导入或需求跟踪矩阵。" />
      )}
      {!loading && tab === 'reqs' && reqs.length > 0 && reqs.map((r) => {
        const meta = REQ_STATUS[r.status ?? ''] ?? { label: r.status || '未定', tone: 'neutral' as BadgeTone };
        return (
          <div key={r.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>{r.req_no ?? '未编号'}</span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {r.priority && <Badge>优先级 {r.priority}</Badge>}
            </div>
            <div style={{ fontSize: 'var(--fs-l)', marginTop: 4 }}>{r.title ?? '（无标题）'}</div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginTop: 4 }}>
              关联计划 {r.linkedPlans.length} · 关联待办 {r.linkedTasks.length}
              {r.linkedPlans.length > 0 && ` · ${r.linkedPlans.map((p) => p.title).slice(0, 2).join('、')}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlanList({ plans }: Readonly<{ plans: PlanRow[] }>) {
  return (
    <>
      {plans.map((p) => {
        const meta = PLAN_STATUS[p.status] ?? PLAN_STATUS.todo;
        return (
          <div key={p.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {p.kind === 'milestone' && <Badge tone="accent">里程碑</Badge>}
              <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>{mdLabel(p.start_date)} ~ {mdLabel(p.end_date)} · {p.duration_days} 天</span>
            </div>
            <div style={{ fontSize: 'var(--fs-l)', marginTop: 4 }}>{p.title}</div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', marginTop: 8, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, p.progress))}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>进度 {p.progress}%</div>
          </div>
        );
      })}
    </>
  );
}

/** 只读甘特：时间轴 = 该项目全部计划的起止范围，条形按自然日等比例投影 */
function PlanGantt({ plans }: Readonly<{ plans: PlanRow[] }>) {
  const range = useMemo(() => {
    const starts = plans.map((p) => dayIndex(p.start_date)).filter((n) => Number.isFinite(n));
    const ends = plans.map((p) => dayIndex(p.end_date)).filter((n) => Number.isFinite(n));
    const min = Math.min(...starts);
    const max = Math.max(...ends);
    return { min, max, span: Math.max(1, max - min + 1) };
  }, [plans]);
  const today = todayIndex();
  const todayPct = (today - range.min + 0.5) / range.span * 100;
  const rows = [...plans].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.title.localeCompare(b.title));
  const colorOf = (s: PlanRow['status']) => (s === 'done' ? 'var(--success)' : s === 'doing' ? 'var(--accent)' : s === 'blocked' ? 'var(--danger)' : 'var(--border-strong)');

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
        <span>{mdLabel(new Date(range.min * DAY_MS).toISOString())}</span>
        <span>自然日轴 · 只读</span>
        <span>{mdLabel(new Date(range.max * DAY_MS).toISOString())}</span>
      </div>
      <div style={{ position: 'relative' }}>
        {todayPct >= 0 && todayPct <= 100 && (
          <div aria-hidden="true" style={{ position: 'absolute', left: `calc(104px + (100% - 104px) * ${todayPct / 100})`, top: 0, bottom: 0, width: 1, background: 'var(--danger)', opacity: 0.6 }} />
        )}
        {rows.map((p) => {
          const start = dayIndex(p.start_date);
          const end = dayIndex(p.end_date);
          const left = (start - range.min) / range.span * 100;
          const width = Math.max(1.5, (end - start + 1) / range.span * 100);
          const milestone = p.kind === 'milestone';
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', height: 30, gap: 4 }}>
              <div title={p.title} style={{ width: 100, flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {milestone ? `◆ ${p.title}` : p.title}
              </div>
              <div style={{ position: 'relative', flex: 1, height: 16, background: 'var(--surface-2)', borderRadius: 4 }}>
                <div
                  title={`${p.title} ${p.start_date} ~ ${p.end_date} 进度 ${p.progress}%`}
                  style={{
                    position: 'absolute', left: `${left}%`, width: `${width}%`, top: milestone ? 4 : 0, height: milestone ? 8 : 16,
                    background: colorOf(p.status), borderRadius: 4, opacity: 0.9, overflow: 'hidden',
                  }}
                >
                  {!milestone && <div style={{ width: `${Math.max(0, Math.min(100, p.progress))}%`, height: '100%', background: 'var(--bar-sheen)' }} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 8 }}>
        <span>■ 进行中</span><span>■ 已完成</span><span>■ 受阻</span><span>■ 待开始</span><span>▏今日</span>
      </div>
    </div>
  );
}

const segWrap: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 };
const seg = (active: boolean): React.CSSProperties => ({
  flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 'var(--fs-m)', cursor: 'pointer',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
  background: active ? 'var(--accent)' : 'var(--card-bg)',
  color: active ? 'var(--accent-text)' : 'var(--text)',
});
