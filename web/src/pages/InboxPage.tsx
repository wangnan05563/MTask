import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ClipboardCheck, FolderInput, Gavel, Inbox,
  RefreshCw, ShieldCheck, UserMinus, UserRound,
} from 'lucide-react';
import type { InboxCounts, InboxItem, InboxListResult, InboxStatus, InboxType } from '../api/client';
import { api } from '../api/client';
import { Badge, Button, Card, EmptyState, Skeleton } from '../ui/components';
import { FilterBar, PageHeader, PageShell } from '../ui/layout';
import { focusTaskByNo } from '../ui/focusTask';
import { projectListPlaceholder, useProjectList } from '../ui/projectList';
import type { LucideIcon } from 'lucide-react';
import './inboxPage.css';

/**
 * T06295（REQ-032 / PRD §A2）：可操作收件箱。
 *
 * 把 AI 失败、待裁决、待验证与停滞会话收敛成统一待办；支持分类筛选、认领、忽略与转任务。
 * 本页不接邮件，也不做审批/重试/批量——那些属于后续单，当前只保证每条 open 事项都有下一步。
 * 打开页面后 POST /inbox/read 清未读角标；顶栏 InboxBell 与页面通过 mtaskInboxChanged 同步。
 */

const TYPE_META: Record<InboxType, { label: string; icon: LucideIcon; tone: 'danger' | 'warning' | 'accent' | 'neutral' }> = {
  decision: { label: '待决策', icon: Gavel, tone: 'warning' },
  ai_failed: { label: 'AI 失败', icon: AlertTriangle, tone: 'danger' },
  verify_pending: { label: '待验证', icon: ClipboardCheck, tone: 'warning' },
  system: { label: '系统', icon: ShieldCheck, tone: 'neutral' },
};

const STATUS_LABEL: Record<InboxStatus, string> = { open: '待处理', ignored: '已忽略', resolved: '已解决' };
const RESOLUTION_LABEL: Record<string, string> = {
  ignored_by_user: '已忽略', converted_to_task: '已转为任务', source_cleared: '来源已清除',
};
/** 当前单机本地身份；接入团队账号后只改这一处（服务端仍需按会话身份校验）。 */
const INBOX_ACTOR = '我';
type ClaimFilter = '' | 'mine' | 'unclaimed';

function relTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function notifyChanged(): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskInboxChanged'));
}

function navigate(tab: 'exec-sessions'): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab } }));
}

export function InboxPage() {
  const projectView = useProjectList({ excludeInbox: true });
  const projects = projectView.projects;
  const [typeFilter, setTypeFilter] = useState<InboxType | ''>('');
  const [status, setStatus] = useState<InboxStatus>('open');
  const [projectFilter, setProjectFilter] = useState('');
  const [claimFilter, setClaimFilter] = useState<ClaimFilter>('');
  const [targetProjectId, setTargetProjectId] = useState('');
  const [data, setData] = useState<InboxListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState('');
  const [flash, setFlash] = useState('');
  const seqRef = useRef(0);
  const readMarked = useRef(false);

  useEffect(() => {
    if (!targetProjectId && projects.length > 0) setTargetProjectId(projects[0].id);
  }, [projects, targetProjectId]);

  async function fetchPage(offset: number, append: boolean): Promise<void> {
    const seq = ++seqRef.current;
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ status, limit: '50', offset: String(offset) });
      if (typeFilter) params.set('type', typeFilter);
      if (projectFilter) params.set('projectId', projectFilter);
      if (claimFilter === 'mine') params.set('assignee', INBOX_ACTOR);
      else if (claimFilter === 'unclaimed') params.set('claimed', 'no');
      const result = await api.get<InboxListResult>(`/inbox?${params.toString()}`);
      if (seq !== seqRef.current) return;
      setData((prev) => append && prev
        ? { ...result, items: [...prev.items, ...result.items] }
        : result);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : '收件箱加载失败');
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    void fetchPage(0, false);
    // 筛选变化即重新取第一页；fetchPage 内部用 seq 丢弃过期响应。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, status, projectFilter, claimFilter]);

  // 页面打开并成功取到数据后清一次未读：未读只影响角标，不改变 open 口径。
  useEffect(() => {
    if (!data || readMarked.current) return;
    readMarked.current = true;
    void api.post<{ changed: number }>('/inbox/read', {}).then(() => {
      setData((prev) => prev ? {
        ...prev,
        counts: { ...prev.counts, unread: 0 },
        items: prev.items.map((it) => ({ ...it, unread: false })),
      } : prev);
      notifyChanged();
    }).catch(() => { readMarked.current = false; });
  }, [data]);

  function showFlash(text: string): void {
    setFlash(text);
    globalThis.setTimeout(() => setFlash(''), 2600);
  }

  async function act(item: InboxItem, action: 'claim' | 'unclaim' | 'ignore' | 'convert'): Promise<void> {
    if (action === 'convert' && !targetProjectId) {
      setError('请先选择「转入项目」');
      return;
    }
    setActionId(item.id);
    setError('');
    try {
      if (action === 'claim') {
        await api.post(`/inbox/${item.id}/claim`, { actor: INBOX_ACTOR });
        showFlash('已认领，可打开任务处理或取消认领');
      } else if (action === 'unclaim') {
        await api.post(`/inbox/${item.id}/unclaim`, { actor: INBOX_ACTOR });
        showFlash('已取消认领，条目回到未认领');
      } else if (action === 'ignore') {
        await api.post(`/inbox/${item.id}/ignore`, { actor: INBOX_ACTOR });
        showFlash('已忽略');
      } else {
        const created = await api.post<{ task: { task_no: string | null } }>(
          `/inbox/${item.id}/convert`,
          { projectId: targetProjectId, actor: INBOX_ACTOR },
        );
        showFlash(`已转为任务 ${created.task.task_no ?? ''}`);
      }
      await fetchPage(0, false);
      notifyChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setActionId('');
    }
  }

  const counts: InboxCounts = data?.counts ?? { open: 0, unread: 0, decision: 0, ai_failed: 0, verify_pending: 0, system: 0 };
  const canLoadMore = Boolean(data && data.items.length < data.total);

  return (
    <PageShell className="mt-inbox-page">
      <PageHeader
        title="收件箱"
        minimal
        description="认领是排他标记，不改变 open；可随时取消认领。打开源任务处理或转任务后，来源恢复会自动从待处理消失。本页不接邮件。"
      />

      <FilterBar ariaLabel="收件箱筛选">
        <div className="mt-inbox-tabs" role="tablist" aria-label="收件箱分类">
          <button
            type="button"
            role="tab"
            aria-selected={typeFilter === ''}
            data-active={typeFilter === ''}
            className="mt-inbox-tab"
            onClick={() => setTypeFilter('')}
          >
            全部
            <span className="mt-inbox-tab-count">{counts.open}</span>
          </button>
          {(Object.keys(TYPE_META) as InboxType[]).map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={typeFilter === type}
              data-active={typeFilter === type}
              className="mt-inbox-tab"
              onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
            >
              {TYPE_META[type].label}
              <span className="mt-inbox-tab-count">{counts[type]}</span>
            </button>
          ))}
        </div>

        <label className="mt-inbox-field">
          <span>状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as InboxStatus)}>
            <option value="open">待处理</option>
            <option value="ignored">已忽略</option>
            <option value="resolved">已解决</option>
          </select>
        </label>

        <label className="mt-inbox-field">
          <span>认领</span>
          <select value={claimFilter} onChange={(e) => setClaimFilter(e.target.value as ClaimFilter)}>
            <option value="">全部</option>
            <option value="mine">我认领的</option>
            <option value="unclaimed">未认领</option>
          </select>
        </label>

        <label className="mt-inbox-field">
          <span>项目</span>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <div className="mt-inbox-target-group">
          <label className="mt-inbox-field">
            <span>转入项目</span>
            <span className="mt-inbox-select">
              <select value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)}>
                {projects.length === 0 && <option value="">{projectListPlaceholder(projectView, '无可用项目')}</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown size={13} className="mt-inbox-select-arrow" aria-hidden="true" />
            </span>
          </label>
          <button
            type="button"
            className="mt-inbox-refresh"
            aria-label="刷新收件箱"
            title="刷新"
            data-loading={loading || undefined}
            disabled={loading}
            onClick={() => { void fetchPage(0, false); }}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </FilterBar>

      {flash && <div className="mt-inbox-flash" role="status">{flash}</div>}
      {error && (
        <div className="mt-inbox-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" onClick={() => { void fetchPage(0, false); }}>重试</button>
        </div>
      )}
      {projectView.phase === 'error' && (
        <div className="mt-inbox-error" role="alert">
          <AlertTriangle size={14} />
          <span>项目列表加载失败：{projectView.error}。转任务暂不可用。</span>
          <button type="button" onClick={projectView.retry}>重试</button>
        </div>
      )}

      {loading && !data && (
        <div className="mt-inbox-skeleton">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      )}

      {!loading && !data && !error && (
        <EmptyState icon={<Inbox size={28} />} title="收件箱暂时不可用" hint="刷新重试；数据恢复后会继续显示未处理事项。" />
      )}

      {data && (
        <Card
          padding="none"
          className="mt-inbox-list"
          title={(
            <span className="mt-inbox-list-title">
              {STATUS_LABEL[status]}
              <span className="mt-inbox-total">共 {data.total} 条{status === 'open' && counts.unread > 0 ? ` · ${counts.unread} 条未读` : ''}</span>
            </span>
          )}
          extra={status === 'open' && <span className="mt-inbox-hint">认领后可「去处理」，也可取消认领；处理源事件后自动消失</span>}
        >
          {loading && <div className="mt-inbox-loading-line">正在刷新…</div>}
          {data.items.length === 0 ? (
            <EmptyState
              icon={status === 'open' ? <CheckCircle2 size={28} /> : <Inbox size={28} />}
              title={status === 'open' ? '没有待处理事项' : `暂无${STATUS_LABEL[status]}记录`}
              hint={status === 'open' ? 'AI 失败、待裁决、待验证和停滞会话会自动进入这里；处理完会从 open 中消失。' : '切回「待处理」查看当前需要动作的事项。'}
            />
          ) : (
            <div className="mt-inbox-rows">
              {data.items.map((item) => {
                const meta = TYPE_META[item.type];
                const Icon = meta.icon;
                const isOpen = item.status === 'open';
                const busy = actionId === item.id;
                const claimedByMe = isOpen && item.assignee === INBOX_ACTOR;
                const canAct = !item.assignee || claimedByMe;
                const canConvert = isOpen && !item.task_id && canAct;
                return (
                  <article key={item.id} className="mt-inbox-row" data-type={item.type} data-unread={item.unread || undefined}>
                    <span className="mt-inbox-row-icon" data-tone={meta.tone} aria-hidden="true"><Icon size={16} /></span>
                    <div className="mt-inbox-row-main">
                      <div className="mt-inbox-row-head">
                        {item.task_no && item.task_id ? (
                          <button
                            type="button"
                            className="mt-inbox-row-title"
                            onClick={() => { void focusTaskByNo(item.task_no, 'notice'); }}
                            title={`打开任务 ${item.task_no}`}
                          >
                            {item.title}
                          </button>
                        ) : <span className="mt-inbox-row-title">{item.title}</span>}
                        {item.unread && isOpen && <span className="mt-inbox-unread" title="未读" aria-label="未读" />}
                        {!isOpen && <Badge tone={item.status === 'resolved' ? 'success' : 'neutral'}>{STATUS_LABEL[item.status]}</Badge>}
                        {!isOpen && item.resolution && <span className="mt-inbox-resolution">{RESOLUTION_LABEL[item.resolution] ?? item.resolution}</span>}
                      </div>
                      <p className="mt-inbox-row-body">{item.body}</p>
                      <div className="mt-inbox-row-meta">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {item.project_name && <span>{item.project_name}</span>}
                        {item.task_no && <span className="mt-inbox-mono">{item.task_no}</span>}
                        {item.assignee && (
                          <span
                            className="mt-inbox-assignee"
                            title={item.claimed_at ? `${item.assignee} 于 ${item.claimed_at} 认领` : `${item.assignee} 认领`}
                          >
                            <UserRound size={11} />{item.assignee}
                            {item.claimed_at && <span className="mt-inbox-claim-time">· {relTime(item.claimed_at)}认领</span>}
                          </span>
                        )}
                        <span>{relTime(item.created_at)}</span>
                      </div>
                    </div>
                    <div className="mt-inbox-row-actions">
                      {item.task_no && item.task_id && (
                        <Button size="sm" variant={claimedByMe ? 'primary' : 'secondary'} rightIcon={<ArrowRight size={12} />}
                          onClick={() => { void focusTaskByNo(item.task_no, 'notice'); }}>
                          {claimedByMe ? '去处理' : '打开任务'}
                        </Button>
                      )}
                      {isOpen && item.type === 'system' && (
                        <Button size="sm" variant={claimedByMe ? 'primary' : 'secondary'} rightIcon={<ArrowRight size={12} />}
                          onClick={() => navigate('exec-sessions')}>
                          {claimedByMe ? '去处理' : 'AI 控制台'}
                        </Button>
                      )}
                      {canConvert && (
                        <Button size="sm" variant={claimedByMe ? 'secondary' : 'primary'} loading={busy}
                          leftIcon={<FolderInput size={12} />}
                          onClick={() => { void act(item, 'convert'); }}>
                          转任务
                        </Button>
                      )}
                      {isOpen && !item.assignee && (
                        <Button size="sm" variant="ghost" loading={busy}
                          leftIcon={<UserRound size={12} />}
                          onClick={() => { void act(item, 'claim'); }}>
                          认领
                        </Button>
                      )}
                      {isOpen && claimedByMe && (
                        <Button size="sm" variant="ghost" loading={busy}
                          leftIcon={<UserMinus size={12} />}
                          onClick={() => { void act(item, 'unclaim'); }}>
                          取消认领
                        </Button>
                      )}
                      {isOpen && canAct && (
                        <Button size="sm" variant="ghost" loading={busy}
                          onClick={() => { void act(item, 'ignore'); }}>
                          忽略
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {canLoadMore && (
            <div className="mt-inbox-more">
              <Button size="sm" variant="ghost" loading={loadingMore}
                onClick={() => { void fetchPage(data.items.length, true); }}>
                加载更多（还有 {data.total - data.items.length} 条）
              </Button>
            </div>
          )}
        </Card>
      )}
    </PageShell>
  );
}
