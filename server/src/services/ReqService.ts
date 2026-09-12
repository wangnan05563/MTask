/**
 * 通用需求服务：分类与条目的增删改查。
 * 与提示词仓库同构（分类 → 条目 两级组织），用于沉淀"通用优秀实现/解决方案"。
 * 删除分类时依赖 req_entries 的 ON DELETE CASCADE 级联删除其下条目。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';

export interface ReqCategoryRow {
  id: string;
  name: string;
  sort_weight: number;
  created_at: string;
  updated_at: string;
  /** 分类列表接口附带的条目数量 */
  reqCount?: number;
}

export interface ReqEntryRow {
  id: string;
  category_id: string;
  title: string;
  content: string;
  /** 置顶：DB 存 0/1，返回布尔语义 */
  pinned: boolean;
  sort_weight: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export const ReqCategoryService = {
  /** 分类列表：按排序权重/创建时间，附带各分类条目计数 */
  list(): ReqCategoryRow[] {
    const cats = getDb().prepare('SELECT * FROM req_categories ORDER BY sort_weight, created_at').all() as ReqCategoryRow[];
    const counts = getDb().prepare('SELECT category_id, COUNT(*) AS c FROM req_entries GROUP BY category_id').all() as { category_id: string; c: number }[];
    const countMap = new Map(counts.map((r) => [r.category_id, r.c]));
    return cats.map((c) => ({ ...c, reqCount: countMap.get(c.id) ?? 0 }));
  },

  create(name: string): ReqCategoryRow {
    const db = getDb();
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO req_categories (id, name, sort_weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim(), 0, t, t);
    return db.prepare('SELECT * FROM req_categories WHERE id = ?').get(id) as ReqCategoryRow;
  },

  rename(id: string, name: string): ReqCategoryRow | null {
    const db = getDb();
    if (!db.prepare('SELECT id FROM req_categories WHERE id = ?').get(id)) return null;
    db.prepare('UPDATE req_categories SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), now(), id);
    return db.prepare('SELECT * FROM req_categories WHERE id = ?').get(id) as ReqCategoryRow;
  },

  /** 删除分类：其下条目随外键 ON DELETE CASCADE 一并删除 */
  remove(id: string): boolean {
    const db = getDb();
    if (!db.prepare('SELECT id FROM req_categories WHERE id = ?').get(id)) return false;
    db.prepare('DELETE FROM req_categories WHERE id = ?').run(id);
    return true;
  },
};

export const ReqEntryService = {
  /** 列条目：按分类过滤 + 可选标题/内容关键词；置顶优先 + 更新时间降序 */
  listByCategory(categoryId?: string, keyword?: string): ReqEntryRow[] {
    const db = getDb();
    const where: string[] = [];
    const values: unknown[] = [];
    if (categoryId) { where.push('category_id = ?'); values.push(categoryId); }
    // keyword 显式收窄为 string：query 值可能是数组/对象，避免污染 LIKE 条件
    if (typeof keyword === 'string' && keyword) {
      const kw = keyword;
      where.push('(title LIKE ? OR content LIKE ?)');
      values.push(`%${kw}%`, `%${kw}%`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM req_entries${whereSql} ORDER BY pinned DESC, updated_at DESC`).all(...values) as ReqEntryRow[];
  },

  create(input: { categoryId: string; title: string; content: string; fingerprint?: string }): ReqEntryRow {
    const db = getDb();
    const id = uuid();
    const t = now();
    db.prepare('INSERT INTO req_entries (id, category_id, title, content, fingerprint, pinned, sort_weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)')
      .run(id, input.categoryId, input.title.trim(), input.content, input.fingerprint ?? '', t, t);
    return db.prepare('SELECT * FROM req_entries WHERE id = ?').get(id) as ReqEntryRow;
  },

  /** 指纹查重（T00435）：同指纹条目是否已存在（转存前拦截重复提炼转存） */
  existsByFingerprint(fingerprint: string): boolean {
    if (!fingerprint) return false;
    return !!getDb().prepare('SELECT id FROM req_entries WHERE fingerprint = ?').get(fingerprint);
  },

  update(id: string, input: { title?: string; content?: string; categoryId?: string; pinned?: boolean }): ReqEntryRow | null {
    const db = getDb();
    if (!db.prepare('SELECT id FROM req_entries WHERE id = ?').get(id)) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.title !== undefined) { sets.push('title = ?'); values.push(input.title); }
    if (input.content !== undefined) { sets.push('content = ?'); values.push(input.content); }
    if (input.categoryId !== undefined) { sets.push('category_id = ?'); values.push(input.categoryId); }
    if (input.pinned !== undefined) { sets.push('pinned = ?'); values.push(input.pinned ? 1 : 0); }
    if (sets.length > 0) {
      sets.push('updated_at = ?'); values.push(now());
      db.prepare(`UPDATE req_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return db.prepare('SELECT * FROM req_entries WHERE id = ?').get(id) as ReqEntryRow;
  },

  remove(id: string): boolean {
    const db = getDb();
    if (!db.prepare('SELECT id FROM req_entries WHERE id = ?').get(id)) return false;
    db.prepare('DELETE FROM req_entries WHERE id = ?').run(id);
    return true;
  },
};