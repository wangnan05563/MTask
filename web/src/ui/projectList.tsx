import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, type Project } from '../api/client';

/**
 * T02201：项目列表取数的统一容错层。
 *
 * 治的是「数据获取失败被渲染成无数据」这类静默失败：此前各页各写一套
 * `api.get('/projects').then(setProjects).catch(() => undefined)`，异常整体吞掉、
 * 无加载中/失败/重试，空下拉与「库里真没项目」在 UI 上完全同形；
 * 再叠上 `useSessionState` 的会话缓存，一次拿到空/旧列表后本次会话后续挂载都复用它。
 *
 * 本层的口径：
 * - 显式状态机 `loading | ready | error`，失败态必须可见且可重试；
 * - **失败绝不写缓存**：失败时保留上次成功的列表（标记 stale 供 UI 注明），
 *   但 phase 落 error，调用方据此提示，不把旧数据当正常数据；
 * - 请求侧短超时 + 有限次指数退避重试，后端短暂不可用不至于整场会话空白；
 * - 挂载时机兜底：`window focus` / 页面重新可见时，若列表为空或上次失败则自动重取
 *   （后端启动需要时间，桌面壳首帧抢跑是同类空列表的高发场景）；
 * - 单飞：多面板同时挂载只发一次请求；ready 结果在窗口内复用（替代原会话缓存语义）。
 */

export type ProjectListPhase = 'loading' | 'ready' | 'error';

interface Snapshot {
  projects: Project[];
  phase: ProjectListPhase;
  error: string;
  /** 最近一次成功时刻（0=从未成功） */
  at: number;
}

/** 单次请求超时：后端短暂不可用时不至于让下拉一直转圈 */
const FETCH_TIMEOUT_MS = 10_000;
/** 一轮取数的尝试次数与退避（首尝试 + 两次退避） */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 400, 1_200];
/** ready 结果复用窗口（等价原「本次会话内不重复拉」的缓存语义） */
const READY_TTL_MS = 60_000;
/** 失败后的自动重取最小间隔：避免页面来回切换时对刚失败的后端连环打 */
const ERROR_RETRY_GAP_MS = 3_000;

const INBOX_ID = 'sys-inbox';

let snap: Snapshot = { projects: [], phase: 'loading', error: '', at: 0 };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let lastAttemptAt = 0;
let revisibleBound = false;

function commit(patch: Partial<Snapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of [...listeners]) l();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const hasData = (s: Snapshot): boolean => s.projects.length > 0;

/** 走一轮取数（内部含超时与退避重试）；成功后才把数据落到快照 */
async function runRound(): Promise<void> {
  lastAttemptAt = Date.now();
  let lastError = '';
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const list = await api.get<Project[]>('/projects', ctrl.signal);
      clearTimeout(timer);
      if (!Array.isArray(list)) throw new Error('项目列表返回格式异常');
      commit({ projects: list, phase: 'ready', error: '', at: Date.now() });
      return;
    } catch (e) {
      clearTimeout(timer);
      lastError = ctrl.signal.aborted
        ? `请求超时（${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒未响应）`
        : e instanceof Error ? e.message : String(e);
    }
  }
  // 失败：projects 保持上次成功值（不冒充正常数据，phase 已落 error 供 UI 显式呈现）
  commit({ phase: 'error', error: lastError || '项目列表加载失败' });
}

/**
 * 取项目列表（单飞 + 复用）。
 * `force=true` 用于重试按钮 / 窗口重新可见兜底 / 项目增删改后的主动刷新。
 */
export function loadProjectList(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force) {
    if (snap.phase === 'ready' && Date.now() - snap.at < READY_TTL_MS) return Promise.resolve();
    // 刚失败过就别立刻再打（3 秒内重复挂载只提示，交由重试按钮/焦点兜底触发）
    if (snap.phase === 'error' && Date.now() - lastAttemptAt < ERROR_RETRY_GAP_MS) return Promise.resolve();
  }
  inflight = runRound().finally(() => { inflight = null; });
  return inflight;
}

/** 新建/重命名/删除项目后强制重取（与 loadProjectList() 区分：始终发起请求） */
export const refreshProjectList = (): Promise<void> => loadProjectList(true);

/** 命令式读取当前列表（供「取数后据列表纠正选中项目」这类页面逻辑用，避免依赖渲染态） */
export const getProjectListSnapshot = (): Project[] => snap.projects;

/** 乐观更新单条（如工作空间绑定后回填 workspace_path），避免为一个小字段整表重取 */
export function patchProject(id: string, patch: Partial<Project>): void {
  commit({ projects: snap.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}

/** 兜底重取：列表为空或上次失败时才发请求（后端启动慢/桌面壳首帧抢跑场景） */
function refetchIfEmpty(): void {
  if (!hasData(snap) || snap.phase === 'error') void loadProjectList(true);
}

/** 只绑一次：窗口聚焦 / 标签页重新可见时兜底 */
function bindRevisible(): void {
  if (revisibleBound || typeof window === 'undefined') return;
  revisibleBound = true;
  window.addEventListener('focus', refetchIfEmpty);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refetchIfEmpty();
  });
}

function subscribe(cb: () => void): () => void {
  bindRevisible();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = (): Snapshot => snap;

export interface ProjectListView {
  /** 项目列表（按 opts 过滤后）；失败态下为上次成功的数据（可能为空） */
  projects: Project[];
  phase: ProjectListPhase;
  error: string;
  /** 失败但手上仍有旧数据：可继续用，但 UI 需注明可能过期 */
  stale: boolean;
  /** 无可用选项（下拉应禁用，避免「静默空下拉」） */
  unusable: boolean;
  retry: () => void;
}

export function useProjectList(opts: { readonly excludeInbox?: boolean } = {}): ProjectListView {
  const { excludeInbox = false } = opts;
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { void loadProjectList(); }, []);
  const projects = useMemo(
    () => (excludeInbox ? s.projects.filter((p) => p.id !== INBOX_ID) : s.projects),
    [s.projects, excludeInbox],
  );
  const retry = useCallback(() => { void loadProjectList(true); }, []);
  return {
    projects,
    phase: s.phase,
    error: s.error,
    stale: s.phase === 'error' && s.projects.length > 0,
    unusable: s.phase !== 'ready' && projects.length === 0,
    retry,
  };
}

/** 下拉占位项文案：加载中 / 失败 与「真没项目」区分开 */
export function projectListPlaceholder(view: Pick<ProjectListView, 'phase'>, idleText = '选择项目…'): string {
  if (view.phase === 'loading') return '项目列表加载中…';
  if (view.phase === 'error') return '项目列表加载失败';
  return idleText;
}

/**
 * 失败/加载中提示行（放在项目下拉旁）：
 * 加载中只在空列表时占位（有旧数据不必打断操作），失败态始终给出原因与重试入口。
 * `style`（T02212 新增可选属性）供窄屏覆盖布局——默认内联形态在桌面端表单里合适，
 * 移动端 360px 宽下「失败原因 + 过期标注 + 重试」需要整行换行才读得全。
 */
export function ProjectListHint({ view, showLoading = true, style }: {
  readonly view: Pick<ProjectListView, 'phase' | 'error' | 'stale' | 'unusable' | 'retry'>;
  readonly showLoading?: boolean;
  readonly style?: React.CSSProperties;
}) {
  if (view.phase === 'error') {
    return (
      <span
        role="status"
        data-t02201="project-list-error"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--danger)', ...style }}
      >
        项目列表加载失败 · {view.error}
        {view.stale && '（以下为上次成功的数据，可能过期）'}
        <button
          onClick={view.retry}
          title="重新拉取项目列表"
          aria-label="重试加载项目列表"
          style={{ fontSize: 'var(--fs-s)', padding: '2px 10px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          重试
        </button>
      </span>
    );
  }
  if (view.phase === 'loading' && showLoading && view.unusable) {
    return (
      <span
        role="status"
        data-t02201="project-list-loading"
        style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', ...style }}
      >
        项目列表加载中…
      </span>
    );
  }
  return null;
}
