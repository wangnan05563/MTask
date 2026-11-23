/**
 * 移动端离线能力（§3.4 / §4.4）：
 * - 离线时随手记内容落 localStorage 草稿队列，恢复联网后批量补提；
 * - useOnlineStatus 反映连接状态：浏览器 online/offline 事件 + 后端 `/health` 探活（后端挂掉也算离线）；
 * - submitQuickNote 为随手记统一提交入口（带图片上传），供在线提交与草稿补提复用。
 */
import { useEffect, useState } from 'react';
import { api, type Task } from '../api/client';

const DRAFT_KEY = 'mtask.mobileDrafts';

/** 随手记草稿（离线未提交内容） */
export interface QuickDraft {
  id: string;
  title: string;
  description?: string;
  priority?: string;
  categoryId?: string | null;
  projectId?: string;
  images?: string[];
  createdAt: string;
}

function uid(): string {
  try { return crypto.randomUUID(); } catch { return 'd' + Date.now() + Math.random().toString(36).slice(2); }
}

export function loadDrafts(): QuickDraft[] {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]') as QuickDraft[]; } catch { return []; }
}

function saveDrafts(list: QuickDraft[]): boolean {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list)); return true; } catch { return false; } // 评审修复：配额溢出返回 false 让调用方提示
}

export function addDraft(d: Omit<QuickDraft, 'id' | 'createdAt'>): QuickDraft & { saved: boolean } {
  const full: QuickDraft = { ...d, id: uid(), createdAt: new Date().toISOString() };
  // 评审修复：配额溢出不再静默——saved=false 让调用方提示用户（如移除图片后重试）
  const saved = saveDrafts([full, ...loadDrafts()]);
  return { ...full, saved };
}

export function removeDraft(id: string): void {
  saveDrafts(loadDrafts().filter((d) => d.id !== id));
}

export function clearDrafts(): void {
  saveDrafts([]);
}

/** 随手记统一提交入口：创建任务 + 上传图片附件。projectId 省略时由后端落默认记事项目 */
export async function submitQuickNote(payload: {
  title: string;
  description?: string;
  priority?: string;
  categoryId?: string | null;
  projectId?: string;
  images?: string[];
}): Promise<Task> {
  const created = await api.post<Task>('/tasks', {
    projectId: payload.projectId,
    title: payload.title.trim(),
    description: payload.description?.trim() || undefined,
    priority: payload.priority ?? 'normal',
    categoryId: payload.categoryId ?? undefined,
  });
  for (const url of payload.images ?? []) {
    try { await api.post(`/tasks/${created.id}/images`, { data: url }); } catch { /* 单图失败不阻断整条 */ }
  }
  return created;
}

/**
 * 补提离线草稿：逐条提交，成功的从队列移除，失败的保留。
 * 返回成功补提条数（0 表示无草稿或全部失败）。
 */
export async function flushDrafts(): Promise<number> {
  const drafts = loadDrafts();
  if (drafts.length === 0) return 0;
  let ok = 0;
  const failedIds = new Set<string>();
  for (const d of drafts) {
    try {
      await submitQuickNote({
        title: d.title,
        description: d.description,
        priority: d.priority,
        categoryId: d.categoryId,
        projectId: d.projectId,
        images: d.images,
      });
      ok++;
    } catch {
      failedIds.add(d.id); // 评审修复：记录失败 id 而非整对象——结束后与新草稿合并，杜绝竞态丢数据
    }
  }
  // 评审修复：flush 过程中用户可能新增草稿——按「快照之外的全部现存草稿 + 快照中失败的」合并保存
  const surviving = loadDrafts().filter((d) => !drafts.some((snap) => snap.id === d.id) || failedIds.has(d.id));
  saveDrafts(surviving);
  return ok;
}

/**
 * 实时在线状态 = 浏览器在线 **且** 后端可达。
 *
 * 只看 navigator.onLine 会误报：后端挂了/隧道断了但网络还在时，顶栏依旧显示「在线」，
 * 与此同时队列页却在提示「数据截至（离线缓存）」，两个信号互相打脸。
 * 这里在浏览器在线时每 15s 探一次 `/api/health`（守卫豁免、无鉴权、极轻），
 * 探活失败即判离线；浏览器 offline 事件立即判离线，恢复后再探。
 */
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;

export function useOnlineStatus(): boolean {
  const [browserOnline, setBrowserOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [serverUp, setServerUp] = useState(true);

  useEffect(() => {
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    globalThis.addEventListener('online', on);
    globalThis.addEventListener('offline', off);
    return () => {
      globalThis.removeEventListener('online', on);
      globalThis.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!browserOnline) { setServerUp(false); return; }
    let cancelled = false;
    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        await api.get('/health', ctrl.signal);
        if (!cancelled) setServerUp(true);
      } catch {
        if (!cancelled) setServerUp(false);
      } finally {
        clearTimeout(timer);
      }
    };
    void probe();
    const id = setInterval(() => { void probe(); }, PROBE_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [browserOnline]);

  return browserOnline && serverUp;
}

// ---------- T01425：stale-while-revalidate 缓存（弱网/无网降级） ----------
const CACHE_PREFIX = 'mtask.swrcache.';

/** 缓存盒：data + 拉取时间（asOf），供「数据截至」角标展示 */
export interface StaleCache<T> { asOf: string; data: T; }

export function loadStaleCache<T>(key: string): StaleCache<T> | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as StaleCache<T>) : null;
  } catch { return null; }
}

export function saveStaleCache<T>(key: string, data: T): void {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ asOf: new Date().toISOString(), data } satisfies StaleCache<T>)); } catch { /* 配额溢出静默忽略 */ }
}

/** 缓存时间 → HH:MM 展示 */
export function fmtAsOf(asOf: string): string {
  const d = new Date(asOf);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
