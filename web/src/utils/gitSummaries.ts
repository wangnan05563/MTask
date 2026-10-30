/**
 * 八期 §3.1.6：任务列表「本页提交摘要」批量取数。
 *
 * 口径（PRD 定死，实现不得自行放宽）：
 *  - 一页（PAGE_SIZE=200）**一次** `POST /git/commit-summaries`，页内零逐行 Git 请求；
 *  - 请求体是「本页唯一 SHA 集合」，服务端按 workspace 分组解析；
 *  - 缓存按「本页 SHA 集合」键控、60s 内复用——翻页/筛选变化即换键重取；
 *  - 超限（唯一 SHA > 200）服务端回 `truncated`，页脚据此提示「本页部分提交摘要未解析」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GitCommitSummary, type GitDegraded, type GitRemoteInfo, type GitSummaryGroup, type Task } from '../api/client';

const CACHE_TTL_MS = 60_000;

type CacheEntry = { at: number; groups: GitSummaryGroup[] };
const cache = new Map<string, CacheEntry>();

export interface GitSummaries {
  /** 按 40 位 SHA 取摘要（解析不出来时 undefined → 徽标走「不可用/未解析」口径） */
  summaryOf(sha: string): GitCommitSummary | undefined;
  /** 该任务所属 workspace 的分组回执（含 available/kind/remote） */
  groupOfTask(taskId: string): GitSummaryGroup | undefined;
  /** 该任务的 Git 取数是否整体不可用（no-git / not-a-repo / no-remote / timeout / too-large / no-workspace） */
  degradedOfTask(taskId: string): GitDegraded | undefined;
  /** 该任务所属 workspace 的外链信息（服务端已剥离凭据） */
  remoteOfTask(taskId: string): GitRemoteInfo | undefined;
  /** 本页是否存在被截断未解析的 SHA（§3.1.6 页脚提示） */
  anyTruncated: boolean;
  loading: boolean;
  error: string;
  /** 手动重取（失效当前键并重新请求） */
  refresh: () => void;
}

/** 空摘要结果：Git 开关关闭或本页无关联提交时用，保证调用方拿到的形态一致 */
const EMPTY: GitSummaries = {
  summaryOf: () => undefined,
  groupOfTask: () => undefined,
  degradedOfTask: () => undefined,
  remoteOfTask: () => undefined,
  anyTruncated: false,
  loading: false,
  error: '',
  refresh: () => undefined,
};

export function useGitSummaries(tasks: Task[], enabled: boolean, workspaceOf: (t: Task) => string): GitSummaries {
  const [groups, setGroups] = useState<GitSummaryGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  /** 任务 id → workspace，分组归属在本地判定（不依赖服务端回传 taskId） */
  const wsByTask = useRef(new Map<string, string>());

  // 本页唯一 SHA 集合 + 每个 SHA 归属的 workspace（分组归属在本地判定）
  const page = useMemo(() => {
    const shas = new Set<string>();
    /** 服务端按 taskId 反查 workspace，故 links 必须逐条带 taskId（省略会全部落进 no-workspace 分组） */
    const links: { taskId: string; sha: string }[] = [];
    const ws = new Map<string, string>();
    if (enabled) {
      for (const t of tasks) {
        ws.set(t.id, workspaceOf(t));
        for (const l of t.gitLinks ?? []) {
          if (!shas.has(l.sha)) shas.add(l.sha);
          links.push({ taskId: t.id, sha: l.sha });
        }
      }
    }
    wsByTask.current = ws;
    return { shas: [...shas].sort((a, b) => a.localeCompare(b)), links, empty: shas.size === 0 };
    // workspaceOf 每次渲染都是新闭包，但它只读 projects 数组——以 tasks 与 enabled 作依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, enabled]);

  const cacheKey = useMemo(() => page.shas.join('|'), [page.shas]);

  useEffect(() => {
    if (!enabled || page.empty) {
      setGroups([]);
      setError('');
      return;
    }
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      setGroups(hit.groups);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const res = await api.post<{ groups: GitSummaryGroup[] }>('/git/commit-summaries', { links: page.links }, ac.signal);
        if (!alive) return;
        cache.set(cacheKey, { at: Date.now(), groups: res.groups });
        setGroups(res.groups);
      } catch (e) {
        if (!alive || ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setGroups([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [cacheKey, enabled, page, nonce]);

  const bySha = useMemo(() => new Map(groups.flatMap((g) => g.commits).map((c) => [c.sha, c])), [groups]);

  /** 找到某任务对应的分组：先按 workspace 精确匹配；跨项目视图下 workspace 为空时回退到 no-workspace 分组 */
  const groupOfTask = useCallback((taskId: string): GitSummaryGroup | undefined => {
    const ws = wsByTask.current.get(taskId) ?? '';
    return groups.find((g) => g.workspacePath === ws) ?? (ws === '' ? groups.find((g) => g.kind === 'no-workspace') : undefined);
  }, [groups]);

  return useMemo(() => ({
    summaryOf: (sha: string) => bySha.get(sha),
    groupOfTask,
    degradedOfTask: (taskId: string) => {
      const g = groupOfTask(taskId);
      if (!g) return undefined;
      if (g.kind === 'no-workspace') return { kind: 'no-workspace', message: '项目未绑定工作空间，请先绑定仓库目录' };
      if (!g.available && g.kind) return { kind: g.kind, message: g.message ?? 'Git 取数不可用' };
      return undefined;
    },
    remoteOfTask: (taskId: string) => groupOfTask(taskId)?.remote,
    anyTruncated: groups.some((g) => g.truncated),
    loading,
    error,
    refresh: () => {
      cache.delete(cacheKey);
      setNonce((n) => n + 1);
    },
  }), [bySha, groupOfTask, loading, error, cacheKey]);
}
