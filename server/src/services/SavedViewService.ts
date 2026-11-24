/**
 * T06303（REQ-009 / PRD §B1）：保存视图的 CRUD、复制与项目隔离。
 *
 * 视图是「呈现配置」而不是任务副本：config 只存筛选/排序/分组/列宽/密度等 UI 状态，
 * 任务数据仍以 tasks 表唯一承载。visibility=project 为项目共享，private 为默认私有。
 */
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';

export type SavedViewType = 'list' | 'board' | 'table' | 'calendar';
export type SavedViewVisibility = 'private' | 'project';

export interface SavedViewConfig {
  /** 视图模式；缺省按视图行的 type 回退。 */
  viewMode?: SavedViewType;
  search?: string;
  catFilter?: string;
  priorityFilter?: string;
  fieldFilterField?: string;
  fieldFilterOp?: string;
  fieldFilterValue?: string;
  fieldSort?: string;
  density?: string;
  boardHideEmpty?: boolean;
  doneFilter?: string;
  todoSort?: string;
  doneSort?: string;
  [key: string]: unknown;
}

export interface SavedView {
  id: string;
  projectId: string;
  name: string;
  type: SavedViewType;
  config: SavedViewConfig;
  visibility: SavedViewVisibility;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewInput {
  name: string;
  type: SavedViewType;
  config?: SavedViewConfig;
  visibility?: SavedViewVisibility;
  createdBy?: string;
}

export interface SavedViewPatch {
  name?: string;
  type?: SavedViewType;
  config?: SavedViewConfig;
  visibility?: SavedViewVisibility;
}

export class SavedViewError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const VIEW_TYPES: ReadonlySet<string> = new Set(['list', 'board', 'table', 'calendar']);
const VISIBILITIES: ReadonlySet<string> = new Set(['private', 'project']);
const MAX_NAME = 60;
const MAX_CONFIG_BYTES = 20_000;

function now(): string {
  return new Date().toISOString();
}

function parseConfig(raw: unknown): SavedViewConfig {
  const text = typeof raw === 'string' ? raw : '{}';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SavedViewConfig;
  } catch {
    // 存量脏数据回退空配置，不阻断视图列表；写入侧会在 validate 阶段拒绝非法 JSON 对象。
  }
  return {};
}

function rowToView(row: Record<string, unknown>): SavedView {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    type: row.type as SavedViewType,
    config: parseConfig(row.config),
    visibility: row.visibility as SavedViewVisibility,
    createdBy: String(row.created_by ?? 'local'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new SavedViewError(400, '视图名必填');
  const trimmed = name.trim();
  if (!trimmed) throw new SavedViewError(400, '视图名不能为空');
  if (trimmed.length > MAX_NAME) throw new SavedViewError(400, `视图名不能超过 ${MAX_NAME} 个字符`);
  return trimmed;
}

function validateType(type: unknown): SavedViewType {
  if (typeof type !== 'string' || !VIEW_TYPES.has(type)) {
    throw new SavedViewError(400, '视图类型必须是 list/board/table/calendar');
  }
  return type as SavedViewType;
}

function validateVisibility(visibility: unknown): SavedViewVisibility {
  if (visibility === undefined) return 'private';
  if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) {
    throw new SavedViewError(400, '共享范围必须是 private/project');
  }
  return visibility as SavedViewVisibility;
}

function validateConfig(config: unknown): SavedViewConfig {
  if (config === undefined) return {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new SavedViewError(400, '视图配置必须是 JSON 对象');
  }
  const text = JSON.stringify(config);
  if (text.length > MAX_CONFIG_BYTES) throw new SavedViewError(400, '视图配置过大（上限 20KB）');
  return config as SavedViewConfig;
}

export class SavedViewService {
  private readonly db: Database.Database;
  constructor(db: Database.Database = getDb()) {
    this.db = db;
  }

  private assertProject(projectId: unknown): string {
    if (typeof projectId !== 'string' || !projectId) throw new SavedViewError(400, 'projectId 必填');
    const row = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id?: string } | undefined;
    if (!row) throw new SavedViewError(404, '项目不存在');
    return projectId;
  }

  private assertUniqueName(projectId: string, name: string, excludeId = ''): void {
    const row = this.db.prepare(
      'SELECT id FROM saved_views WHERE project_id = ? AND name = ? COLLATE NOCASE AND id <> ?',
    ).get(projectId, name, excludeId) as { id?: string } | undefined;
    if (row) throw new SavedViewError(409, `视图名「${name}」已存在`);
  }

  list(projectId: string): SavedView[] {
    const p = this.assertProject(projectId);
    return this.db.prepare(
      'SELECT * FROM saved_views WHERE project_id = ? ORDER BY updated_at DESC, name ASC',
    ).all(p).map((row) => rowToView(row as Record<string, unknown>));
  }

  get(id: string): SavedView {
    const row = this.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SavedViewError(404, '视图不存在');
    return rowToView(row);
  }

  create(projectId: string, input: SavedViewInput): SavedView {
    const p = this.assertProject(projectId);
    const name = validateName(input?.name);
    const type = validateType(input?.type);
    const config = validateConfig(input?.config);
    const visibility = validateVisibility(input?.visibility);
    const createdBy = typeof input?.createdBy === 'string' && input.createdBy.trim() ? input.createdBy.trim().slice(0, 60) : 'local';
    this.assertUniqueName(p, name);
    const id = uuid();
    const at = now();
    this.db.prepare(`INSERT INTO saved_views
      (id, project_id, name, type, config, visibility, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, p, name, type, JSON.stringify(config), visibility, createdBy, at, at);
    return this.get(id);
  }

  update(id: string, patch: SavedViewPatch): SavedView {
    const current = this.get(id);
    const name = patch?.name === undefined ? current.name : validateName(patch.name);
    const type = patch?.type === undefined ? current.type : validateType(patch.type);
    const config = patch?.config === undefined ? current.config : validateConfig(patch.config);
    const visibility = patch?.visibility === undefined ? current.visibility : validateVisibility(patch.visibility);
    if (name !== current.name) this.assertUniqueName(current.projectId, name, id);
    this.db.prepare(`UPDATE saved_views SET name = ?, type = ?, config = ?, visibility = ?, updated_at = ? WHERE id = ?`)
      .run(name, type, JSON.stringify(config), visibility, now(), id);
    return this.get(id);
  }

  delete(id: string): void {
    const row = this.db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
    if (row.changes === 0) throw new SavedViewError(404, '视图不存在');
  }

  /** 复制为同项目新视图；缺省名自动追加「（副本）」并按序避让重名。 */
  copy(id: string, name?: string): SavedView {
    const current = this.get(id);
    if (name !== undefined) {
      validateName(name);
      return this.create(current.projectId, {
        name, type: current.type, config: current.config, visibility: current.visibility, createdBy: current.createdBy,
      });
    }
    let n = 1;
    let candidate = '';
    while (true) {
      const suffix = n === 1 ? '（副本）' : `（副本 ${n}）`;
      candidate = `${current.name.slice(0, Math.max(1, MAX_NAME - suffix.length))}${suffix}`;
      if (!this.db.prepare('SELECT id FROM saved_views WHERE project_id = ? AND name = ? COLLATE NOCASE')
        .get(current.projectId, candidate)) break;
      n += 1;
    }
    return this.create(current.projectId, {
      name: candidate, type: current.type, config: current.config, visibility: current.visibility, createdBy: current.createdBy,
    });
  }
}
