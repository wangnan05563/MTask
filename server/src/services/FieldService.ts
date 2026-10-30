/**
 * T03231（PRD PM-203①②）：项目级自定义字段。
 *
 * 边界（Q-1 裁决）：字段只描述任务，**不参与 tasks.status**——状态仍是 todo|done 二元，
 * 所以这里既不读也不写 status，任何列表/看板/状态门的消费路径都不需要改口径。
 *
 * 存储：字段定义挂项目（project_fields），值挂任务（task_field_values）。
 * 「字段归档」与「选项停用」都是软删——值不会被抹掉，重新启用前历史仍可追溯；
 * 只有项目/任务被物理删除时才靠 FK 级联清值。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { scalarText } from '../util/scalarText';
import { notifyChange } from './ChangeBus'; // 字段/值变化会改变任务列表的徽标渲染，复用既有 tasks 通道让前端刷新

export const FIELD_TYPES = new Set(['text', 'number', 'date', 'select']);
export type FieldType = 'text' | 'number' | 'date' | 'select';

/** 单选项：`archived` 的选项不出现在填写候选里，但历史值仍按 label 显示 */
export interface FieldOptionView {
  id: string;
  label: string;
  archived: boolean;
}

export interface ProjectFieldView {
  id: string;
  project_id: string;
  name: string;
  type: FieldType;
  options: FieldOptionView[];
  sort_weight: number;
  archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 列表行带出的字段值：`display` 是给人看的文本（单选项回 label），`value` 是落库原值 */
export interface TaskFieldValueView {
  field_id: string;
  name: string;
  type: FieldType;
  value: string;
  display: string;
}

interface ProjectFieldRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  options: string;
  sort_weight: number;
  archived: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 分批 IN 规避 SQLite 999 变量上限（与任务阻塞关系、计划联动同一口径） */
const LOOKUP_BATCH = 400;
const NAME_MAX = 40;
const TEXT_MAX = 2000;

function now(): string {
  return new Date().toISOString();
}

function parseOptions(raw: string): FieldOptionView[] {
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: FieldOptionView[] = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.label !== 'string') continue;
    out.push({ id: r.id, label: r.label, archived: r.archived === true });
  }
  return out;
}

function toView(r: ProjectFieldRow): ProjectFieldView {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    type: (FIELD_TYPES.has(r.type) ? r.type : 'text') as FieldType,
    options: parseOptions(r.options),
    sort_weight: r.sort_weight,
    archived: r.archived === 1,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowById(fieldId: string): ProjectFieldRow | undefined {
  return getDb().prepare('SELECT * FROM project_fields WHERE id = ?').get(fieldId) as ProjectFieldRow | undefined;
}

function mustField(fieldId: string): ProjectFieldRow {
  const row = rowById(fieldId);
  if (!row) throw new Error('自定义字段不存在');
  return row;
}

function normName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new Error('字段名称必填');
  if (name.length > NAME_MAX) throw new Error(`字段名称不能超过 ${NAME_MAX} 个字符`);
  return name;
}

function ensureNameFree(projectId: string, name: string, selfId?: string): void {
  const hit = getDb().prepare(
    'SELECT id FROM project_fields WHERE project_id = ? AND name = ? AND archived = 0 AND id <> ?',
  ).get(projectId, name, selfId ?? '') as { id: string } | undefined;
  if (hit) throw new Error(`已存在同名字段「${name}」`);
}

/**
 * 选项入参归一：保留已有 id（否则每次改名都会让已落库的值指向不存在的选项），
 * 丢弃空标签、按标签去重。显式传 `archived:true` 即「停用」。
 */
function normOptions(raw: unknown, prev: FieldOptionView[]): FieldOptionView[] {
  if (!Array.isArray(raw)) throw new Error('单选字段必须提供至少一个选项');
  const prevById = new Map(prev.map((o) => [o.id, o]));
  const seenLabels = new Set<string>();
  const out: FieldOptionView[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label) continue;
    if (label.length > NAME_MAX) throw new Error(`选项「${label}」超过 ${NAME_MAX} 个字符`);
    if (seenLabels.has(label)) throw new Error(`选项「${label}」重复`);
    seenLabels.add(label);
    const id = typeof o.id === 'string' && prevById.has(o.id) ? o.id : uuid();
    out.push({ id, label, archived: o.archived === true });
  }
  if (out.length === 0) throw new Error('单选字段必须提供至少一个选项');
  return out;
}

/** 被引用过的选项（哪怕此刻值已被清空，行也可能已被删——所以只按现存值行判定，口径见 PM-203④注释） */
function optionUsage(fieldId: string): Map<string, number> {
  const rows = getDb().prepare(
    'SELECT value, COUNT(*) AS n FROM task_field_values WHERE field_id = ? GROUP BY value',
  ).all(fieldId) as Array<{ value: string; n: number }>;
  return new Map(rows.map((r) => [r.value, r.n]));
}

function valueCount(fieldId: string): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM task_field_values WHERE field_id = ?').get(fieldId) as { n: number };
  return r.n;
}

/**
 * 按字段类型校验并归一写入值。
 * 返回空串表示「清空」，由调用方删行；抛错即整批回滚（setValues 用事务包裹）。
 */
function normalizeValue(field: ProjectFieldView, raw: unknown): string {
  let s: string;
  if (typeof raw === 'string') s = raw.trim();
  else if (raw === null || raw === undefined) s = '';
  else s = scalarText(raw).trim();
  if (!s) return '';
  if (field.type === 'text') {
    if (s.length > TEXT_MAX) throw new Error(`字段「${field.name}」的值不能超过 ${TEXT_MAX} 个字符`);
    return s;
  }
  if (field.type === 'number') {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`字段「${field.name}」需要数字，收到「${s}」`);
    return String(n);
  }
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`字段「${field.name}」需要 YYYY-MM-DD 日期，收到「${s}」`);
    const d = new Date(`${s}T00:00:00Z`);
    // 2026-02-30 会被 Date 顺延成 3 月，必须回读比对才算合法日期
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new Error(`字段「${field.name}」的日期「${s}」不存在`);
    }
    return s;
  }
  const opt = field.options.find((o) => o.id === s);
  if (!opt) throw new Error(`字段「${field.name}」没有这个选项：${s}`);
  if (opt.archived) throw new Error(`字段「${field.name}」的选项「${opt.label}」已停用，不能再被选中`);
  return s;
}

function displayOf(field: ProjectFieldView, value: string): string {
  if (!value) return '';
  if (field.type !== 'select') return value;
  return field.options.find((o) => o.id === value)?.label ?? '（选项已删除）';
}

export const FieldService = {
  /** 字段列表：默认只返回未归档；`includeArchived` 供设置页「已归档」分区与审计使用 */
  list(projectId: string, opts: { includeArchived?: boolean } = {}): ProjectFieldView[] {
    const rows = getDb().prepare(
      `SELECT * FROM project_fields WHERE project_id = ? ${opts.includeArchived ? '' : 'AND archived = 0'}
        ORDER BY sort_weight, created_at`,
    ).all(projectId) as ProjectFieldRow[];
    return rows.map(toView);
  },

  create(projectId: string, input: { name?: unknown; type?: unknown; options?: unknown }): ProjectFieldView {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('项目不存在');
    const name = normName(input.name);
    const type = scalarText(input.type ?? '');
    if (!FIELD_TYPES.has(type)) throw new Error('字段类型必须是 text / number / date / select');
    ensureNameFree(projectId, name);
    const options = type === 'select' ? normOptions(input.options, []) : [];
    const id = uuid();
    const t = now();
    const weight = (db.prepare('SELECT COALESCE(MAX(sort_weight), 0) AS w FROM project_fields WHERE project_id = ?').get(projectId) as { w: number }).w + 1;
    db.prepare(
      'INSERT INTO project_fields (id, project_id, name, type, options, sort_weight, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(id, projectId, name, type, JSON.stringify(options), weight, t, t);
    notifyChange('tasks');
    return toView(mustField(id));
  },

  /**
   * 改字段：名称、单选选项、类型（仅当尚无任何值时）。
   * 改类型会静默改读已落库的值（"2026-10-01" 变成数字就成脏数据），故有值时直接拒收，让用户先清空。
   */
  update(fieldId: string, patch: { name?: unknown; type?: unknown; options?: unknown }): ProjectFieldView {
    const db = getDb();
    const before = mustField(fieldId);
    const view = toView(before);
    if (before.archived) throw new Error('字段已归档，不能编辑');

    const name = patch.name === undefined ? before.name : normName(patch.name);
    if (name !== before.name) ensureNameFree(before.project_id, name, fieldId);

    const type = patch.type === undefined ? view.type : scalarText(patch.type);
    if (!FIELD_TYPES.has(type)) throw new Error('字段类型必须是 text / number / date / select');
    if (type !== view.type && valueCount(fieldId) > 0) throw new Error('该字段已有任务填写值，不能改类型（请先清空或另建字段）');

    let options: FieldOptionView[] = type === 'select' ? view.options : [];
    if (type === 'select') {
      if (patch.options !== undefined) {
        options = normOptions(patch.options, view.options);
        // PM-203④：已引用的选项只能停用，不能硬删——静默删会让任务上的值变成指向空气的孤值
        const kept = new Set(options.map((o) => o.id));
        const usage = optionUsage(fieldId);
        for (const o of view.options) {
          const used = usage.get(o.id) ?? 0;
          if (used > 0 && !kept.has(o.id)) {
            throw new Error(`选项「${o.label}」已被 ${used} 个任务引用，只能停用不能删除`);
          }
        }
      } else if (view.options.length === 0) {
        throw new Error('单选字段必须提供至少一个选项');
      }
    }

    db.prepare('UPDATE project_fields SET name = ?, type = ?, options = ?, updated_at = ? WHERE id = ?')
      .run(name, type, JSON.stringify(options), now(), fieldId);
    notifyChange('tasks');
    return toView(mustField(fieldId));
  },

  /** 归档字段：值保留在库。归档后列表/抽屉不再展示，但历史值可查（不清行） */
  archive(fieldId: string): ProjectFieldView {
    const row = mustField(fieldId);
    if (row.archived === 1) return toView(row);
    getDb().prepare('UPDATE project_fields SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), fieldId);
    // 归档会从列表徽标与抽屉里撤下该字段，任务内容没变但呈现变了，同样要走 tasks 通道
    notifyChange('tasks');
    return toView(mustField(fieldId));
  },

  /** 任务可编辑的字段 + 当前值（抽屉「自定义字段」页取数，两件事一次给全） */
  valuesFor(taskId: string): { fields: ProjectFieldView[]; values: Record<string, string> } {
    const db = getDb();
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    if (!task) throw new Error('任务不存在');
    const fields = this.list(task.project_id);
    const rows = db.prepare('SELECT field_id, value FROM task_field_values WHERE task_id = ?').all(taskId) as Array<{ field_id: string; value: string }>;
    const known = new Set(fields.map((f) => f.id));
    const values: Record<string, string> = {};
    for (const r of rows) {
      // 归档字段的值不返回：抽屉只编辑「现行字段」，避免给已下线的字段发写入
      if (known.has(r.field_id)) values[r.field_id] = r.value;
    }
    return { fields, values };
  },

  /**
   * 写值（部分更新语义）：只处理传入的字段，空串=清空该行。
   * 全部校验先做完再开事务写，任何一条不合法就整批不动——避免「前两条存了、第三条报错」的半份数据。
   */
  setValues(taskId: string, input: unknown): { fields: ProjectFieldView[]; values: Record<string, string> } {
    const db = getDb();
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    if (!task) throw new Error('任务不存在');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('values 必须是 { 字段id: 值 } 对象');

    const byId = new Map(this.list(task.project_id).map((f) => [f.id, f]));
    const writes: Array<{ fieldId: string; value: string }> = [];
    for (const [fieldId, raw] of Object.entries(input as Record<string, unknown>)) {
      const field = byId.get(fieldId);
      if (!field) throw new Error('字段不存在或不属于该任务所在项目');
      const value = normalizeValue(field, raw);
      // 单选项即便传的是 label 也当 id 处理会误伤；这里只接受 id（抽屉下拉的 value 就是 id）
      writes.push({ fieldId, value });
    }

    const t = now();
    const run = db.transaction(() => {
      for (const w of writes) {
        if (!w.value) {
          db.prepare('DELETE FROM task_field_values WHERE task_id = ? AND field_id = ?').run(taskId, w.fieldId);
          continue;
        }
        const existing = db.prepare('SELECT id FROM task_field_values WHERE task_id = ? AND field_id = ?').get(taskId, w.fieldId) as { id: string } | undefined;
        if (existing) {
          db.prepare('UPDATE task_field_values SET value = ?, updated_at = ? WHERE id = ?').run(w.value, t, existing.id);
        } else {
          db.prepare('INSERT INTO task_field_values (id, task_id, field_id, value, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(uuid(), taskId, w.fieldId, w.value, t);
        }
      }
    });
    run();
    notifyChange('tasks');
    return this.valuesFor(taskId);
  },

  /**
   * 列表行批量带值：只查未归档字段，按任务分批 IN。
   * 没有值的任务不进 Map（`decorateRows` 据此决定是否挂 `field_values`），避免给每行塞空数组。
   */
  mapByTasks(taskIds: string[]): Map<string, TaskFieldValueView[]> {
    const out = new Map<string, TaskFieldValueView[]>();
    if (taskIds.length === 0) return out;
    const db = getDb();
    for (let i = 0; i < taskIds.length; i += LOOKUP_BATCH) {
      const chunk = taskIds.slice(i, i + LOOKUP_BATCH);
      if (chunk.length === 0) continue;
      const rows = db.prepare(
        `SELECT v.task_id, v.field_id, v.value, f.name, f.type, f.options
           FROM task_field_values v
           JOIN project_fields f ON f.id = v.field_id
          WHERE f.archived = 0 AND v.task_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY f.sort_weight, f.created_at`,
      ).all(...chunk) as Array<{ task_id: string; field_id: string; value: string; name: string; type: string; options: string }>;
      for (const r of rows) {
        const type = (FIELD_TYPES.has(r.type) ? r.type : 'text') as FieldType;
        const field: ProjectFieldView = {
          id: r.field_id, project_id: '', name: r.name, type, options: parseOptions(r.options),
          sort_weight: 0, archived: false, archived_at: null, created_at: '', updated_at: '',
        };
        const list = out.get(r.task_id) ?? [];
        list.push({ field_id: r.field_id, name: r.name, type, value: r.value, display: displayOf(field, r.value) });
        out.set(r.task_id, list);
      }
    }
    return out;
  },
};
