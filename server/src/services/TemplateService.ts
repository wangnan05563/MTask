/**
 * T06305（REQ-010 / PRD §B2）：任务/项目模板的 CRUD 与一键实例化、撤销。
 *
 * 口径：
 * - 不支持宏变量：schema 里就是可直接落库的字段；
 * - task 模板在指定项目建一条任务；project 模板建项目 + 模板内任务；
 * - 每次实例化写一条 template_instances，撤销按实例精确回收（task 归档、project 删除且拒绝已继续编辑的项目）；
 * - 内置模板只读，自定义模板可增改删；名称同类型内唯一。
 */
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';
import { TaskService } from './TaskService';
import { findProjectNameOwners, projectNameConflictError } from '../util/projectRouting';
import { detachMemoriesFromProject } from '../util/memoryProjectRef';
import { cacheClear } from '../util/ttl-cache';

export type TemplateType = 'task' | 'project';
export type TemplatePriority = 'low' | 'normal' | 'high' | 'urgent';
export type TemplateTaskStatus = 'todo' | 'done';

export interface TaskTemplateBody {
  title: string;
  description?: string;
  priority?: TemplatePriority;
  status?: TemplateTaskStatus;
}

export interface ProjectTemplateBody {
  description?: string;
  tasks?: TaskTemplateBody[];
}

export interface TemplateRow {
  id: string;
  type: TemplateType;
  name: string;
  description: string;
  schema: TaskTemplateBody | ProjectTemplateBody;
  version: number;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  type: TemplateType;
  name: string;
  description?: string;
  schema: unknown;
}

export interface TemplatePatch {
  name?: string;
  description?: string;
  schema?: unknown;
}

export interface InstantiateInput {
  /** task 模板必填；project 模板忽略 */
  projectId?: string;
  /** project 模板可指定项目名；缺省用模板名并自动避让重名 */
  name?: string;
  /** task 模板可覆盖任务标题；缺省用模板标题 */
  title?: string;
}

export interface TemplateInstanceView {
  id: string;
  templateId: string;
  templateType: TemplateType;
  projectId: string | null;
  taskIds: string[];
  createdAt: string;
  undoneAt: string | null;
}

export interface InstantiateResult {
  instanceId: string;
  templateId: string;
  type: TemplateType;
  projectId: string;
  projectName: string;
  tasks: Array<{ id: string; task_no: string | null; title: string }>;
  undoHint: string;
}

export class TemplateError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TYPES: ReadonlySet<string> = new Set(['task', 'project']);
const PRIORITIES: ReadonlySet<string> = new Set(['low', 'normal', 'high', 'urgent']);
const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'done']);
const MAX_NAME = 60;
const MAX_SCHEMA_BYTES = 100_000;
const MAX_PROJECT_TASKS = 50;
const MAX_TASK_TITLE = 200;
const MAX_TASK_DESC = 20_000;

function now(): string {
  return new Date().toISOString();
}

function decodeSchema(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function assertObject(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TemplateError(400, `${label}必须是 JSON 对象`);
  return v as Record<string, unknown>;
}

function normalizeTaskBody(raw: unknown, label: string): TaskTemplateBody {
  const o = assertObject(raw, label);
  if (typeof o.title !== 'string' || !o.title.trim()) throw new TemplateError(400, `${label}标题必填`);
  const title = o.title.trim();
  if (title.length > MAX_TASK_TITLE) throw new TemplateError(400, `${label}标题不能超过 ${MAX_TASK_TITLE} 个字符`);
  const description = typeof o.description === 'string' ? o.description : '';
  if (description.length > MAX_TASK_DESC) throw new TemplateError(400, `${label}描述不能超过 ${MAX_TASK_DESC} 个字符`);
  const priority = o.priority === undefined ? 'normal' : o.priority;
  if (typeof priority !== 'string' || !PRIORITIES.has(priority)) throw new TemplateError(400, `${label}优先级必须是 low/normal/high/urgent`);
  const status = o.status === undefined ? 'todo' : o.status;
  if (typeof status !== 'string' || !TASK_STATUSES.has(status)) throw new TemplateError(400, `${label}状态必须是 todo/done`);
  return { title, description, priority: priority as TemplatePriority, status: status as TemplateTaskStatus };
}

function normalizeSchema(type: TemplateType, raw: unknown): TaskTemplateBody | ProjectTemplateBody {
  const parsed = decodeSchema(raw);
  if (parsed === null) throw new TemplateError(400, '模板 schema 不是合法 JSON');
  const bytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) throw new TemplateError(400, `模板 schema 不能超过 ${MAX_SCHEMA_BYTES} 字节`);
  if (type === 'task') return normalizeTaskBody(parsed, '任务模板');
  const o = assertObject(parsed, '项目模板');
  const description = typeof o.description === 'string' ? o.description : '';
  if (description.length > 2_000) throw new TemplateError(400, '项目模板描述不能超过 2000 个字符');
  const tasksRaw = o.tasks === undefined ? [] : o.tasks;
  if (!Array.isArray(tasksRaw)) throw new TemplateError(400, '项目模板 tasks 必须是数组');
  if (tasksRaw.length > MAX_PROJECT_TASKS) throw new TemplateError(400, `项目模板任务不能超过 ${MAX_PROJECT_TASKS} 条`);
  const tasks = tasksRaw.map((t, i) => normalizeTaskBody(t, `项目模板任务 ${i + 1} `));
  return { description, tasks };
}

function validateType(type: unknown): TemplateType {
  if (typeof type !== 'string' || !TYPES.has(type)) throw new TemplateError(400, '模板类型必须是 task/project');
  return type as TemplateType;
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new TemplateError(400, '模板名必填');
  const trimmed = name.trim();
  if (!trimmed) throw new TemplateError(400, '模板名不能为空');
  if (trimmed.length > MAX_NAME) throw new TemplateError(400, `模板名不能超过 ${MAX_NAME} 个字符`);
  return trimmed;
}

function rowToTemplate(row: Record<string, unknown>): TemplateRow {
  return {
    id: String(row.id),
    type: row.type as TemplateType,
    name: String(row.name),
    description: String(row.description ?? ''),
    schema: (decodeSchema(row.schema_json) ?? {}) as TaskTemplateBody | ProjectTemplateBody,
    version: Number(row.version ?? 1),
    builtin: Boolean(row.builtin),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToInstance(row: Record<string, unknown>): TemplateInstanceView {
  let taskIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.task_ids ?? '[]')) as unknown;
    if (Array.isArray(parsed)) taskIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* 脏数据按空处理，不阻断撤销 */ }
  return {
    id: String(row.id),
    templateId: String(row.template_id),
    templateType: row.template_type as TemplateType,
    projectId: row.project_id === null ? null : String(row.project_id),
    taskIds,
    createdAt: String(row.created_at),
    undoneAt: row.undone_at === null ? null : String(row.undone_at),
  };
}

function projectExists(id: string): boolean {
  return Boolean(getDb().prepare('SELECT id FROM projects WHERE id = ?').get(id));
}

function uniqueProjectName(base: string): string {
  const cleanBase = base.trim().slice(0, 80) || '模板项目';
  for (let i = 1; i <= 50; i += 1) {
    const candidate = i === 1 ? cleanBase : `${cleanBase}（${i}）`;
    if (findProjectNameOwners(candidate).length === 0) return candidate;
  }
  throw new TemplateError(409, `项目名「${cleanBase}」重复过多，请指定名称`);
}

export class TemplateService {
  list(type?: string): TemplateRow[] {
    const db = getDb();
    const rows = type
      ? db.prepare('SELECT * FROM templates WHERE type = ? ORDER BY builtin DESC, updated_at DESC, name').all(validateType(type))
      : db.prepare('SELECT * FROM templates ORDER BY builtin DESC, type, updated_at DESC, name').all();
    return (rows as Array<Record<string, unknown>>).map(rowToTemplate);
  }

  get(id: string): TemplateRow {
    const row = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new TemplateError(404, '模板不存在');
    return rowToTemplate(row);
  }

  create(input: TemplateInput): TemplateRow {
    const type = validateType(input.type);
    const name = validateName(input.name);
    const schema = normalizeSchema(type, input.schema);
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 2_000) : '';
    const id = uuid();
    const t = now();
    try {
      getDb().prepare(
        `INSERT INTO templates (id, type, name, description, schema_json, version, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      ).run(id, type, name, description, JSON.stringify(schema), t, t);
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) throw new TemplateError(409, '同类型下模板名已存在');
      throw e;
    }
    return this.get(id);
  }

  update(id: string, patch: TemplatePatch): TemplateRow {
    const current = this.get(id);
    if (current.builtin) throw new TemplateError(403, '内置模板只读，请复制为自定义模板后再修改');
    const name = patch.name === undefined ? current.name : validateName(patch.name);
    const description = patch.description === undefined ? current.description : String(patch.description).trim().slice(0, 2_000);
    const schema = patch.schema === undefined ? current.schema : normalizeSchema(current.type, patch.schema);
    try {
      getDb().prepare('UPDATE templates SET name = ?, description = ?, schema_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(name, description, JSON.stringify(schema), now(), id);
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) throw new TemplateError(409, '同类型下模板名已存在');
      throw e;
    }
    return this.get(id);
  }

  delete(id: string): void {
    const current = this.get(id);
    if (current.builtin) throw new TemplateError(403, '内置模板不可删除');
    getDb().prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  instantiate(id: string, input: InstantiateInput): InstantiateResult {
    const template = this.get(id);
    const db = getDb();
    const instanceId = uuid();
    const createdTasks: Array<{ id: string; task_no: string | null; title: string }> = [];
    let projectId = '';
    let projectName = '';

    const run = db.transaction(() => {
      if (template.type === 'task') {
        if (!input.projectId) throw new TemplateError(400, '任务模板实例化必须指定 projectId');
        if (!projectExists(input.projectId)) throw new TemplateError(404, '目标项目不存在');
        const body = template.schema as TaskTemplateBody;
        const task = TaskService.create({
          projectId: input.projectId,
          title: (input.title && input.title.trim()) || body.title,
          description: body.description ?? '',
          priority: body.priority ?? 'normal',
          status: body.status ?? 'todo',
        });
        projectId = input.projectId;
        projectName = String((db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name ?? '');
        createdTasks.push({ id: task.id, task_no: task.task_no ?? null, title: task.title });
      } else {
        const body = template.schema as ProjectTemplateBody;
        const base = (input.name && input.name.trim()) || template.name;
        if (input.name && input.name.trim() && findProjectNameOwners(input.name.trim()).length > 0) {
          throw new TemplateError(409, projectNameConflictError(input.name.trim(), findProjectNameOwners(input.name.trim())));
        }
        projectName = uniqueProjectName(base);
        projectId = uuid();
        const t = now();
        db.prepare(
          `INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at)
           VALUES (?, ?, ?, 0, 10, ?, ?)`,
        ).run(projectId, projectName, body.description ?? `从模板「${template.name}」创建`, t, t);
        for (const taskBody of body.tasks ?? []) {
          const task = TaskService.create({
            projectId,
            title: taskBody.title,
            description: taskBody.description ?? '',
            priority: taskBody.priority ?? 'normal',
            status: taskBody.status ?? 'todo',
          });
          createdTasks.push({ id: task.id, task_no: task.task_no ?? null, title: task.title });
        }
        cacheClear('projects');
      }
      db.prepare(
        `INSERT INTO template_instances (id, template_id, template_type, project_id, task_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(instanceId, template.id, template.type, projectId, JSON.stringify(createdTasks.map((t) => t.id)), now());
    });

    try { run(); } catch (e) {
      // 事务内抛错时 better-sqlite3 已回滚项目与任务；把错误换成模板域错误便于路由映射。
      if (e instanceof TemplateError) throw e;
      throw new TemplateError(400, e instanceof Error ? e.message : String(e));
    }

    return {
      instanceId,
      templateId: template.id,
      type: template.type,
      projectId,
      projectName,
      tasks: createdTasks,
      undoHint: template.type === 'task' ? '撤销将归档本次创建的任务' : '撤销将删除本次创建的项目及其任务',
    };
  }

  getInstance(id: string): TemplateInstanceView {
    const row = getDb().prepare('SELECT * FROM template_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new TemplateError(404, '模板实例不存在');
    return rowToInstance(row);
  }

  listInstances(projectId?: string): TemplateInstanceView[] {
    const db = getDb();
    const rows = projectId
      ? db.prepare('SELECT * FROM template_instances WHERE project_id = ? ORDER BY created_at DESC LIMIT 100').all(projectId)
      : db.prepare('SELECT * FROM template_instances ORDER BY created_at DESC LIMIT 100').all();
    return (rows as Array<Record<string, unknown>>).map(rowToInstance);
  }

  /**
   * 撤销一次实例化：
   * - task 模板：归档实例创建的任务（不物理删，保留历史可审计）；
   * - project 模板：仅当项目里仍然只有本实例创建的任务时才删项目（含级联），
   *   一旦用户往里加过任务就拒绝，避免撤销误删后续工作。
   */
  undo(instanceId: string): { ok: true; undoneTaskIds: string[]; deletedProjectId: string | null } {
    const instance = this.getInstance(instanceId);
    if (instance.undoneAt) throw new TemplateError(409, '该实例已撤销');
    const db = getDb();
    const t = now();

    const run = db.transaction(() => {
      if (instance.templateType === 'project') {
        if (!instance.projectId || !projectExists(instance.projectId)) {
          throw new TemplateError(409, '项目已不存在，无法撤销');
        }
        const projectTaskIds = (db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(instance.projectId) as Array<{ id: string }>).map((r) => r.id);
        const expected = new Set(instance.taskIds);
        const extra = projectTaskIds.filter((id) => !expected.has(id));
        if (extra.length > 0) throw new TemplateError(409, `项目已被继续编辑（新增 ${extra.length} 条任务），不能整体撤销`);
        detachMemoriesFromProject(instance.projectId);
        db.prepare('DELETE FROM projects WHERE id = ?').run(instance.projectId);
        cacheClear('projects');
      } else {
        for (const taskId of instance.taskIds) {
          if (db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) TaskService.update(taskId, { archived: 1 });
        }
      }
      db.prepare('UPDATE template_instances SET undone_at = ? WHERE id = ?').run(t, instanceId);
    });

    try { run(); } catch (e) {
      if (e instanceof TemplateError) throw e;
      throw new TemplateError(400, e instanceof Error ? e.message : String(e));
    }
    return { ok: true, undoneTaskIds: instance.taskIds, deletedProjectId: instance.templateType === 'project' ? instance.projectId : null };
  }
}
