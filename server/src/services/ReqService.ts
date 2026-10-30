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
  /** T03683：收藏位（与 pinned 正交——置顶管排序、收藏管筛选），DB 存 0/1 */
  is_favorited?: number;
  /** T03685：归档标记与归档时刻——补齐与 prompts / plan_tasks 同构的软删模型 */
  archived?: number;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** 列条目查询条件（T03683 / T03685 把它从位置参数收成对象：可选轴继续增多，位置参数会排不清） */
export interface ReqEntryQuery {
  categoryId?: string;
  /** 标题/内容关键词（非 string 的 query 值一律忽略，避免污染 LIKE 条件） */
  keyword?: unknown;
  /** 只看已收藏（T03683：显式 true 才收窄，缺省保持全量） */
  favorited?: boolean;
  /** 归档视图（T03685）：true 只列已归档，false/缺省只列未归档——与 GET /prompts 的 archived 口径一致 */
  archived?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export const ReqCategoryService = {
  /** 分类列表：按排序权重/创建时间，附带各分类条目计数 */
  list(): ReqCategoryRow[] {
    const cats = getDb().prepare('SELECT * FROM req_categories ORDER BY sort_weight, created_at').all() as ReqCategoryRow[];
    // T03685：分类计数排除已归档条目——口径与提示词分类（prompts WHERE archived = 0）一致，
    // 否则归档一条后侧栏计数仍含它，与列表可见条数不符
    const counts = getDb().prepare('SELECT category_id, COUNT(*) AS c FROM req_entries WHERE archived = 0 GROUP BY category_id').all() as { category_id: string; c: number }[];
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
  /** 列条目：按分类过滤 + 可选关键词/收藏/归档轴；置顶优先 + 更新时间降序 */
  listByCategory(query: ReqEntryQuery = {}): ReqEntryRow[] {
    const db = getDb();
    const { categoryId, keyword, favorited, archived } = query;
    const where: string[] = [];
    const values: unknown[] = [];
    // T03685：归档轴默认只列未归档（软删语义），显式 archived=true 才进归档视图——同 GET /prompts
    where.push(archived ? 'archived = 1' : 'archived = 0');
    if (categoryId) { where.push('category_id = ?'); values.push(categoryId); }
    // keyword 显式收窄为 string：query 值可能是数组/对象，避免污染 LIKE 条件
    if (typeof keyword === 'string' && keyword) {
      const kw = keyword;
      where.push('(title LIKE ? OR content LIKE ?)');
      values.push(`%${kw}%`, `%${kw}%`);
    }
    // T03683：收藏是「显式才收窄」的可选轴，缺省不动存量消费方
    if (favorited) where.push('is_favorited = 1');
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM req_entries${whereSql} ORDER BY pinned DESC, CASE WHEN sort_weight = 0 THEN 1 ELSE 0 END, sort_weight, updated_at DESC`).all(...values) as ReqEntryRow[];
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

  update(id: string, input: { title?: string; content?: string; categoryId?: string; pinned?: boolean; color?: string; isFavorited?: boolean; archived?: boolean }): ReqEntryRow | null {
    const db = getDb();
    if (!db.prepare('SELECT id FROM req_entries WHERE id = ?').get(id)) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.title !== undefined) { sets.push('title = ?'); values.push(input.title); }
    if (input.content !== undefined) { sets.push('content = ?'); values.push(input.content); }
    if (input.categoryId !== undefined) { sets.push('category_id = ?'); values.push(input.categoryId); }
    if (input.pinned !== undefined) { sets.push('pinned = ?'); values.push(input.pinned ? 1 : 0); }
    if (input.color !== undefined) { sets.push('color = ?'); values.push(input.color); } // T00490
    // T03683：收藏位与置顶同口径（布尔→0/1），切换走同一 PATCH 通道
    if (input.isFavorited !== undefined) { sets.push('is_favorited = ?'); values.push(input.isFavorited ? 1 : 0); }
    // T03685：归档同时写 archived_at（还原置空），与 prompts / plan_tasks 的软删留痕一致
    if (input.archived !== undefined) {
      sets.push('archived = ?'); values.push(input.archived ? 1 : 0);
      sets.push('archived_at = ?'); values.push(input.archived ? now() : null);
    }
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