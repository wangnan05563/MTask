/**
 * 移动端离线能力（§3.4 / §4.4）：
 * - 离线时随手记内容落 localStorage 草稿队列，恢复联网后批量补提；
 * - useOnlineStatus 监听 navigator.onLine 实时反映连接状态；
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

function saveDrafts(list: QuickDraft[]): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list)); } catch { /* 配额溢出等静默忽略 */ }
}

export function addDraft(d: Omit<QuickDraft, 'id' | 'createdAt'>): QuickDraft {
  const full: QuickDraft = { ...d, id: uid(), createdAt: new Date().toISOString() };
  saveDrafts([full, ...loadDrafts()]);
  return full;
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
  const failed: QuickDraft[] = [];
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
      failed.push(d);
    }
  }
  saveDrafts(failed);
  return ok;
}

/** 实时在线状态（监听 online/offline 事件） */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    globalThis.addEventListener('online', on);
    globalThis.addEventListener('offline', off);
    return () => {
      globalThis.removeEventListener('online', on);
      globalThis.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
