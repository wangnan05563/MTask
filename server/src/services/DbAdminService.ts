import { getDb } from '../db/connection';

/**
 * 数据库维护服务（参考 17_xianyu DatabaseAdmin 菜单的 Express/SQLite 等效实现）。
 * 面向本应用业务表的在线 CRUD：表清单（含行数）/ 表结构 / 分页检索 / 增删改 / CSV·JSON 导入导出。
 *
 * 安全边界：
 * - 表名/列名无法走参数绑定，必须白名单校验（^[\w]+$ 且必须存在于 sqlite_master / PRAGMA 结果）后才可拼 SQL；
 * - 仅暴露业务表（排除 sqlite_% 系统表）；值一律参数绑定；
 * - BLOB 列（task_images.data）不参与文本搜索，导出时以 base64 呈现。
 */

export interface DbTableInfo {
  name: string;
  label: string;
  rows: number;
}

export interface DbColumn {
  name: string;
  type: string;
  primary_key: boolean;
  nullable: boolean;
  default: string | null;
}

export interface RowsQuery {
  limit?: number;
  offset?: number;
  search?: string;
  orderBy?: string; // 'col' 升序 / '-col' 降序（与参考项目约定一致）
}

/** 表名 → 中文显示名（侧边栏更易识别；与 db/schema.ts 保持同步） */
const TABLE_LABELS: Record<string, string> = {
  projects: '项目',
  tasks: '任务',
  task_categories: '任务分类',
  task_images: '任务图片',
  ai_tools: 'AI 工具',
  queues: '队列',
  queue_jobs: '队列作业',
  prompt_categories: '提示词分类',
  prompts: '提示词',
  app_settings: '应用设置',
};

const IDENT_RE = /^[\w]+$/;

function assertIdent(name: string, kind = '标识符'): void {
  if (!IDENT_RE.test(name)) throw new Error(`非法${kind}: ${name}`);
}

/** 校验表名存在且为业务表（sqlite_master 白名单），返回校验通过的名字 */
function assertTable(table: string): string {
  assertIdent(table, '表名');
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? AND name NOT LIKE 'sqlite_%'")
    .get(table);
  if (!row) throw new Error(`表不存在: ${table}`);
  return table;
}

interface PragmaCol {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** 列名校验：必须真实存在于该表（防拼接注入），返回 PRAGMA 行 */
function assertColumn(table: string, column: string): PragmaCol {
  assertIdent(column, '列名');
  const col = tableColumns(table).find((c) => c.name === column);
  if (!col) throw new Error(`列不存在: ${table}.${column}`);
  return col;
}

/** 模块级取表结构（PRAGMA table_info），供校验与服务方法共用 */
function tableColumns(table: string): PragmaCol[] {
  return getDb().prepare(`PRAGMA table_info("${table}")`).all() as PragmaCol[];
}

export const DbAdminService = {
  /** 表清单：业务表 + 行数（COUNT 子查询逐表取数，表数量个位数，可接受） */
  listTables(): DbTableInfo[] {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return tables.map((t) => {
      let rows = 0;
      try {
        assertIdent(t.name);
        rows = (db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c;
      } catch {
        rows = -1; // 非常规表名等异常情况：行数标记为未知，不影响列表展示
      }
      return { name: t.name, label: TABLE_LABELS[t.name] ?? t.name, rows };
    });
  },

  /** 表结构：PRAGMA table_info（name/type/pk/notnull/default） */
  getColumns(table: string): DbColumn[] {
    assertTable(table);
    const cols = tableColumns(table);
    return cols.map((c) => ({
      name: c.name,
      type: c.type || 'TEXT',
      primary_key: c.pk > 0,
      nullable: c.notnull === 0,
      default: c.dflt_value,
    }));
  },

  /** 主键列名（复合主键取第一个；本库所有业务表均为单列主键） */
  pkColumn(table: string): string {
    const cols = this.getColumns(table);
    const pk = cols.find((c) => c.primary_key);
    if (!pk) throw new Error(`表 ${table} 无主键，不支持行级操作`);
    return pk.name;
  },

  /** 分页检索：search 对全部 TEXT 列做 LIKE，orderBy 支持 '-col' 降序前缀 */
  listRows(
    table: string,
    q: RowsQuery,
  ): { rows: Record<string, unknown>[]; total: number } {
    assertTable(table);
    const db = getDb();
    const cols = this.getColumns(table);
    const textCols = cols
      .filter((c) => /TEXT|CHAR|CLOB/i.test(c.type) || c.type === '')
      .map((c) => c.name);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.search) {
      // 参数绑定的 OR LIKE 组；BLOB 列不参与文本搜索
      where.push(textCols.map((c) => `"${c}" LIKE ?`).join(' OR '));
      textCols.forEach(() => params.push(`%${q.search}%`));
    }
    const whereSql = where.length ? `WHERE ${where.join(' ')}` : '';

    let orderSql = '';
    if (q.orderBy) {
      const desc = q.orderBy.startsWith('-');
      const col = desc ? q.orderBy.slice(1) : q.orderBy;
      assertColumn(table, col); // 校验通过后才允许拼入 ORDER BY
      orderSql = `ORDER BY "${col}" ${desc ? 'DESC' : 'ASC'}`;
    }

    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM "${table}" ${whereSql}`).get(...params) as { c: number }
    ).c;
    const rows = db
      .prepare(`SELECT * FROM "${table}" ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return { rows, total };
  },

  /** 新增一行：仅接受表中真实存在的列名；自增/主键留空由 SQLite 处理 */
  insertRow(table: string, data: Record<string, unknown>): void {
    assertTable(table);
    const cols = this.getColumns(table);
    const keys = Object.keys(data).filter((k) => {
      assertColumn(table, k);
      return data[k] !== undefined;
    });
    if (keys.length === 0) throw new Error('无有效字段');
    const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    getDb().prepare(sql).run(...keys.map((k) => data[k]));
  },

  /** 按主键更新（PATCH 语义：仅更新传入列） */
  updateRow(table: string, pkValue: string, data: Record<string, unknown>): void {
    assertTable(table);
    const pk = this.pkColumn(table);
    const keys = Object.keys(data).filter((k) => {
      assertColumn(table, k);
      return data[k] !== undefined;
    });
    if (keys.length === 0) throw new Error('无有效字段');
    const sql = `UPDATE "${table}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE "${pk}" = ?`;
    const r = getDb().prepare(sql).run(...keys.map((k) => data[k]), pkValue);
    if (r.changes === 0) throw new Error('记录不存在或未变更');
  },

  /** 按主键删除单行 */
  deleteRow(table: string, pkValue: string): void {
    assertTable(table);
    const pk = this.pkColumn(table);
    getDb().prepare(`DELETE FROM "${table}" WHERE "${pk}" = ?`).run(pkValue);
  },

  /** 批量删除（按主键数组），事务内执行；返回 实际删除/请求数 */
  batchDelete(table: string, pkValues: string[]): { affected: number; requested: number } {
    assertTable(table);
    const pk = this.pkColumn(table);
    const db = getDb();
    const del = db.prepare(`DELETE FROM "${table}" WHERE "${pk}" = ?`);
    let affected = 0;
    db.transaction(() => {
      for (const v of pkValues) affected += del.run(v).changes;
    })();
    return { affected, requested: pkValues.length };
  },

  /** 导入：逐行 insert，单行失败跳过（skip-on-error），事务批量提交；返回 统计 */
  importRows(
    table: string,
    rows: Record<string, unknown>[],
  ): { inserted: number; skipped: number; errors: string[] } {
    assertTable(table);
    const cols = this.getColumns(table);
    const validCols = new Set(cols.map((c) => c.name));
    const db = getDb();
    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    const insertOne = (data: Record<string, unknown>) => {
      const keys = Object.keys(data).filter((k) => validCols.has(k) && data[k] !== undefined);
      if (keys.length === 0) throw new Error('无有效字段');
      const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...keys.map((k) => data[k]));
    };

    db.transaction(() => {
      rows.forEach((row, i) => {
        try {
          insertOne(row);
          inserted += 1;
        } catch (e) {
          skipped += 1;
          if (errors.length < 20) errors.push(`第 ${i + 1} 行: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    })();
    return { inserted, skipped, errors };
  },

  /** 全量导出（分批拼接，BLOB 转 base64），由路由层决定 CSV/JSON 序列化 */
  exportRows(table: string): Record<string, unknown>[] {
    assertTable(table);
    const rows = getDb().prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v instanceof Buffer) out[k] = `base64:${v.toString('base64')}`;
        else out[k] = v;
      }
      return out;
    });
  },
};
