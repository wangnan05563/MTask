import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { AlertTriangle, CheckSquare, FolderOpen, GitCommitHorizontal, Loader2, Square } from 'lucide-react';
import { api, type Project, type Task, type TaskCategory } from '../api/client';
import { FIELD_QUIET, PILL } from './primitives';
import { wsBasename } from './WorkspaceSelect';
import { useSessionState } from './session';

/**
 * 八期 §3.3.1「Git 增量资产提取 / Sonar 质量扫描」共用的范围选择器（T03366 / T03377）。
 *
 * 四条边界决定本组件的形态，逐条对应 PRD：
 *  - **同工作空间**：多项目必须同一 `workspace_path`，否则「同一批提交」在不同仓库各自解析、产物语义不成立。
 *    与「总结汇报卡」的置灰口径一致——不是点了才报错，而是直接把不匹配项置灰并写明原因；
 *  - **只列已回写提交的任务**：关联的唯一来源是 `task_git_links`（PRD §3.1），未回写的任务置灰说明「未回写 commit id」，
 *    不算失败、也不隐藏（用户要能看见「为什么这里没有它」）；
 *  - **范围会话级**：Git 卡与 Sonar 卡**互相沿用上次范围**，故状态提到 `useGitScope()` 单键（`git.scope`），
 *    本组件是受控的，不藏副本；
 *  - **筛选不吞勾选**：改筛选只改可见集合，已勾选但当前不可见的任务保留并显式计数——
 *    静默丢弃会让「已选 12 个任务」在切一下筛选后变成 4 个，用户无从判断发生了什么。
 */

/** 一次取数的分页上限——与 `GET /tasks` 服务端钳制值同口径（超限时界面显式告知，不假装是全量） */
const TASK_PAGE_LIMIT = 500;

/** 共享范围（Git 提取卡与 Sonar 卡同一份，键 `git.scope`） */
export interface GitScope {
  /** 勾选顺序即导出清单里的项目顺序 */
  projectIds: string[];
  /** 已勾选任务 id（跨项目扁平集合） */
  taskIds: string[];
  /** 状态筛选：'' = 不限 */
  status: '' | 'todo' | 'done';
  /** 分类筛选：'' = 不限 */
  categoryId: string;
}

export const EMPTY_GIT_SCOPE: GitScope = { projectIds: [], taskIds: [], status: '', categoryId: '' };

/** 会话级共享范围（PRD「范围存会话级，与 Sonar 卡互相沿用上次范围」） */
export function useGitScope(): [GitScope, Dispatch<SetStateAction<GitScope>>] {
  return useSessionState<GitScope>('git.scope', EMPTY_GIT_SCOPE);
}

/** 任务是否已回写提交（列表行内字段：`gitLinkCount` 优先，退化用内联数组长度） */
export function isLinkedTask(t: Task): boolean {
  return (t.gitLinkCount ?? t.gitLinks?.length ?? 0) > 0;
}

/** 内联关联条数（无关联=0） */
export function linkedCountOf(t: Task): number {
  return t.gitLinkCount ?? t.gitLinks?.length ?? 0;
}

/**
 * 当前勾选范围的工作空间判定。
 * `conflict` 为真表示勾选跨了多个工作空间（理论上不会发生——不匹配项在勾选时已被置灰；
 * 保留该态是给「范围来自上次会话、之后项目改了工作空间」这种情况一个可见出口）。
 * `blocked` 是「环境不可用」的单源判据（未绑定 / 跨空间），卡片灰化与面板提示框都读它——
 * 两处各写一遍公式必然漂移。
 */
export function scopeWorkspace(projects: Project[], ids: string[]): {
  path: string;
  conflict: boolean;
  paths: string[];
  unbound: string[];
  blocked: boolean;
} {
  const chosen = projects.filter((p) => ids.includes(p.id));
  const paths = [...new Set(chosen.map((p) => p.workspace_path ?? '').filter(Boolean))];
  const unbound = chosen.filter((p) => !p.workspace_path).map((p) => p.name);
  return {
    path: paths.length === 1 ? paths[0] : '',
    conflict: paths.length > 1,
    paths,
    unbound,
    blocked: ids.length > 0 && (paths.length > 1 || paths.length === 0 || unbound.length > 0),
  };
}

/**
 * 单个项目在此刻能否勾选，不能勾时给可见原因（文案即 UI 文本，门按字面断言）。
 * 未绑定工作空间**不拦勾选**：拦了就等于把用户关在门外——PRD §3.3.1 要求环境不可用时
 * 「卡片可展开，面板内明示原因与去绑定工作空间入口」，入口在面板里，前提是先能把它勾进范围。
 * 跨工作空间仍硬拦（同工作空间是提取的可行性前提，勾进来也只会整批失败）。
 */
export function projectPickability(p: Project, picked: string[], projects: Project[]): { ok: boolean; reason: string } {
  const ws = p.workspace_path ?? '';
  if (!ws) return { ok: true, reason: '未绑定工作空间，绑定后才能取数' };
  const others = projects.filter((x) => picked.includes(x.id) && x.id !== p.id);
  const otherWs = [...new Set(others.map((x) => x.workspace_path ?? '').filter(Boolean))];
  if (otherWs.length === 1 && otherWs[0] !== ws) {
    return { ok: false, reason: `与已选项目不同工作空间（${wsBasename(otherWs[0])}）` };
  }
  if (otherWs.length > 1) return { ok: false, reason: '已选项目跨了多个工作空间，请先取消部分勾选' };
  return { ok: true, reason: '' };
}

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0,
  fontSize: 'var(--fs-s)', padding: '3px 4px', borderRadius: 5, boxSizing: 'border-box',
};
const GROUP_HEAD: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, margin: '6px 0 2px',
  fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 0,
};

/** 任务分组（一个项目一组，组名用项目名） */
interface TaskGroup { projectId: string; tasks: Task[] }

export function GitScopePicker({ projects, value, onChange }: {
  readonly projects: Project[];
  readonly value: GitScope;
  readonly onChange: (next: GitScope) => void;
}) {
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [cats, setCats] = useState<TaskCategory[]>([]);

  const idsKey = value.projectIds.join(',');
  const statusFilter = value.status;
  const categoryFilter = value.categoryId;

  useEffect(() => {
    api.get<TaskCategory[]>('/task-categories').then((r) => setCats(Array.isArray(r) ? r : [])).catch(() => setCats([]));
  }, []);

  // 只按「项目集合 + 筛选」取数：勾选任务不触发重取，否则每次点击都要拉一轮列表
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').filter(Boolean) : [];
    if (!ids.length) {
      setGroups([]); setLoadError(''); setTruncated(false); setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void (async () => {
      try {
        const next = await Promise.all(ids.map(async (projectId) => {
          const q = new URLSearchParams({ projectId, limit: String(TASK_PAGE_LIMIT), archived: '0' });
          if (statusFilter) q.set('status', statusFilter);
          if (categoryFilter) q.set('categoryId', categoryFilter);
          const list = await api.get<Task[]>(`/tasks?${q.toString()}`, controller.signal);
          return { projectId, tasks: Array.isArray(list) ? list : [] };
        }));
        if (controller.signal.aborted) return;
        setGroups(next);
        setTruncated(next.some((g) => g.tasks.length >= TASK_PAGE_LIMIT));
      } catch (e) {
        if (controller.signal.aborted) return;
        setGroups([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [idsKey, statusFilter, categoryFilter]);

  const visibleTasks = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const visibleLinked = useMemo(() => visibleTasks.filter(isLinkedTask), [visibleTasks]);
  const pickedSet = useMemo(() => new Set(value.taskIds), [value.taskIds]);
  const hiddenPicked = value.taskIds.length - visibleTasks.filter((t) => pickedSet.has(t.id)).length;
  const ws = scopeWorkspace(projects, value.projectIds);

  function toggleProject(p: Project) {
    if (value.projectIds.includes(p.id)) {
      const rest = value.projectIds.filter((x) => x !== p.id);
      // 取消项目即移出它的任务勾选：留一组「看不见的已选任务」比丢勾选更难解释
      const removedTaskIds = new Set(groups.find((g) => g.projectId === p.id)?.tasks.map((t) => t.id) ?? []);
      onChange({ ...value, projectIds: rest, taskIds: value.taskIds.filter((id) => !removedTaskIds.has(id)) });
      return;
    }
    if (!projectPickability(p, value.projectIds, projects).ok) return;
    onChange({ ...value, projectIds: [...value.projectIds, p.id] });
  }

  function toggleTask(id: string) {
    onChange({ ...value, taskIds: pickedSet.has(id) ? value.taskIds.filter((x) => x !== id) : [...value.taskIds, id] });
  }

  /** 全选当前筛选结果（PRD 明确要求：只勾「看得见且已回写提交」的行） */
  function selectAllFiltered() {
    const merged = new Set(value.taskIds);
    for (const t of visibleLinked) merged.add(t.id);
    onChange({ ...value, taskIds: [...merged] });
  }

  return (
    <div data-t03366="git-scope-picker" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {/* ① 项目多选（同工作空间硬约束） */}
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>项目（多项目必须同一工作空间）</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 150, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
        {projects.length === 0 && <div style={{ ...ROW, color: 'var(--text-muted)' }}>暂无项目</div>}
        {projects.map((p) => {
          const checked = value.projectIds.includes(p.id);
          const pick = projectPickability(p, value.projectIds, projects);
          const disabled = !pick.ok && !checked;
          return (
            <label
              key={p.id}
              title={pick.reason || p.workspace_path || '未绑定工作空间'}
              style={{ ...ROW, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
            >
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleProject(p)}
                aria-label={`纳入项目 ${p.name}`} style={{ flexShrink: 0, cursor: 'inherit' }} />
              <span style={{ ...PILL, flexShrink: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                {p.workspace_path ? wsBasename(p.workspace_path) : '未绑定工作空间'}
              </span>
              {pick.reason && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>{pick.reason}</span>}
            </label>
          );
        })}
      </div>
      {ws.conflict && (
        <div style={{ ...ROW, color: 'var(--warn)' }}>
          <AlertTriangle size={12} style={{ flexShrink: 0 }} />
          <span>已选项目跨了 {ws.paths.length} 个工作空间，请取消其一：{ws.paths.map(wsBasename).join(' / ')}</span>
        </div>
      )}
      {ws.unbound.length > 0 && (
        <div style={{ ...ROW, color: 'var(--warn)' }}>
          <AlertTriangle size={12} style={{ flexShrink: 0 }} />
          <span>以下已选项目未绑定工作空间，无法取数：{ws.unbound.join('、')}（在下方「去绑定工作空间」处理）</span>
        </div>
      )}

      {/* ② 筛选 + 全选 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <select
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as GitScope['status'] })}
          aria-label="任务状态筛选"
          style={{ ...FIELD_QUIET, width: 'auto' }}
        >
          <option value="">全部状态</option>
          <option value="todo">待办</option>
          <option value="done">已完成</option>
        </select>
        <select
          value={value.categoryId}
          onChange={(e) => onChange({ ...value, categoryId: e.target.value })}
          aria-label="任务分类筛选"
          style={{ ...FIELD_QUIET, width: 'auto', maxWidth: 160 }}
        >
          <option value="">全部分类</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button
          type="button"
          onClick={selectAllFiltered}
          disabled={visibleLinked.length === 0}
          title={`把当前筛选结果里 ${visibleLinked.length} 个已回写提交的任务全部纳入`}
          aria-label="全选当前筛选结果"
          style={{ ...PILL, cursor: visibleLinked.length ? 'pointer' : 'not-allowed', opacity: visibleLinked.length ? 1 : 0.5 }}
        >
          <CheckSquare size={12} /> 全选筛选结果（{visibleLinked.length}）
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...value, taskIds: [] })}
          disabled={value.taskIds.length === 0}
          title="清空已勾选任务"
          aria-label="清空已勾选任务"
          style={{ ...PILL, cursor: value.taskIds.length ? 'pointer' : 'not-allowed', opacity: value.taskIds.length ? 1 : 0.5 }}
        >
          <Square size={12} /> 清空勾选
        </button>
      </div>

      {/* ③ 任务勾选：未回写 commit id 的行置灰并写明原因 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
        {loading && <div style={{ ...ROW, color: 'var(--text-muted)' }}><Loader2 size={12} className="aispin" /> 任务取数中…</div>}
        {!loading && !value.projectIds.length && (
          <div style={{ ...ROW, color: 'var(--text-muted)' }}>先在上方勾选项目——任务列表按项目取数</div>
        )}
        {!loading && value.projectIds.length > 0 && visibleTasks.length === 0 && (
          <div style={{ ...ROW, color: 'var(--text-muted)' }}>当前筛选条件下没有任务（换一下状态/分类筛选）</div>
        )}
        {!loading && groups.map((g) => {
          const p = projects.find((x) => x.id === g.projectId);
          if (!g.tasks.length) return null;
          return (
            <div key={g.projectId}>
              <div style={GROUP_HEAD}>
                <FolderOpen size={11} style={{ flexShrink: 0 }} />
                <span>{p?.name ?? g.projectId}（{g.tasks.length}）</span>
              </div>
              {g.tasks.map((t) => {
                const linked = linkedCountOf(t);
                const checked = pickedSet.has(t.id);
                return (
                  <label
                    key={t.id}
                    title={linked ? `已回写 ${linked} 条提交关联` : '未回写 commit id，无可提取内容'}
                    style={{ ...ROW, opacity: linked ? 1 : 0.5, cursor: linked ? 'pointer' : 'not-allowed' }}
                  >
                    <input type="checkbox" checked={checked} disabled={!linked} onChange={() => toggleTask(t.id)}
                      aria-label={`纳入任务 ${t.task_no ?? t.title}`} style={{ flexShrink: 0, cursor: 'inherit' }} />
                    <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: 'Consolas, Menlo, monospace' }}>{t.task_no ?? '—'}</span>
                    <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    {linked
                      ? <span style={{ ...PILL, flexShrink: 0 }}><GitCommitHorizontal size={11} /> {linked}</span>
                      : <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>未回写 commit id</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {truncated && <span style={{ color: 'var(--warn)' }}>单项目仅取前 {TASK_PAGE_LIMIT} 条任务（已截断），请用筛选缩小范围。</span>}
        {hiddenPicked > 0 && <span> 已勾选中有 {hiddenPicked} 条不在当前筛选结果内（仍会一并提取）。</span>}
        {!truncated && !loading && value.projectIds.length > 0 && visibleTasks.length > 0 && (
          <span>共 {visibleTasks.length} 条任务在当前筛选内，其中 {visibleLinked.length} 条已回写 commit id 可勾选。</span>
        )}
      </div>
    </div>
  );
}
