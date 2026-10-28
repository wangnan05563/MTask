/**
 * T03267（PRD PM-402）：项目级导入导出扩展——任务/计划导出 Markdown / JSON。
 *
 * Markdown 保留层级：任务按 `tasks.parent_id`（epic→task），计划按 `deps` 里的 `{type:'child'}`
 * （子行指向里程碑）；每行都带状态与优先级/进度，满足 PM-402④「Markdown 含任务树/状态/优先级」。
 * JSON 为扁平行 + 父指针（parentId），下游可自行重建树——两格式共用同一份取数，不各写一套。
 */
import { getDb } from '../db/connection';

export type ProjectExportScope = 'tasks' | 'plans';
export type ProjectExportFormat = 'md' | 'json';

export interface ProjectExportFile {
  buffer: Buffer;
  filename: string;
  mime: string;
}

const PRIORITY_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '中', low: '低' };
const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成', in_progress: '进行中' };
const PLAN_STATUS_LABEL: Record<string, string> = { todo: '待开始', doing: '进行中', done: '已完成' };

interface TaskRow {
  id: string;
  task_no: string | null;
  title: string;
  description: string;
  priority: string;
  status: string;
  category: string | null;
  parent_id: string | null;
  created_at: string;
}

interface PlanRow {
  id: string;
  title: string;
  description: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  progress: number;
  status: string;
  kind: string;
  assignee: string;
  deps: string;
  sort_order: number;
}

function projectName(projectId: string): string {
  const row = getDb().prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
  if (!row) throw new Error('项目不存在');
  return row.name;
}

/** 文件名里的时间戳与项目名都要能落盘：去掉 Windows 非法字符 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || '项目';
}

function ymd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadTasks(projectId: string): TaskRow[] {
  return getDb().prepare(`
    SELECT t.id, t.task_no, t.title, t.description, t.priority, t.status,
           c.name AS category, t.parent_id, t.created_at
    FROM tasks t LEFT JOIN task_categories c ON c.id = t.category_id
    WHERE t.project_id = ? AND t.archived = 0
    ORDER BY t.created_at ASC, t.id ASC
  `).all(projectId) as TaskRow[];
}

function loadPlans(projectId: string): PlanRow[] {
  return getDb().prepare(`
    SELECT id, title, description, start_date, end_date, duration_days, progress,
           status, kind, assignee, deps, sort_order
    FROM plan_tasks
    WHERE project_id = ? AND archived = 0
    ORDER BY sort_order ASC, created_at ASC
  `).all(projectId) as PlanRow[];
}

/** 任务树：父不在本集合里（父被归档/跨项目）时按根处理，避免整枝消失 */
function taskChildren(rows: TaskRow[]): Map<string | null, TaskRow[]> {
  const ids = new Set(rows.map((r) => r.id));
  const map = new Map<string | null, TaskRow[]>();
  for (const r of rows) {
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

function planParentId(row: PlanRow, planIds: Set<string>): string | null {
  let deps: Array<{ id?: unknown; type?: unknown }> = [];
  try {
    const parsed = JSON.parse(row.deps || '[]');
    deps = Array.isArray(parsed) ? parsed : [];
  } catch {
    deps = [];
  }
  // type='child' 是归属边（子行 → 里程碑）；serial 只是排期顺序，不建树
  const edge = deps.find((d) => d && d.type === 'child' && typeof d.id === 'string' && planIds.has(d.id));
  return edge ? String(edge.id) : null;
}

function planChildren(rows: PlanRow[]): Map<string | null, PlanRow[]> {
  const ids = new Set(rows.map((r) => r.id));
  const map = new Map<string | null, PlanRow[]>();
  for (const r of rows) {
    const key = planParentId(r, ids);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

function markTaskLine(r: TaskRow, depth: number): string {
  const box = r.status === 'done' ? 'x' : ' ';
  const no = r.task_no ? `${r.task_no} · ` : '';
  const prio = PRIORITY_LABEL[r.priority] ?? r.priority;
  const status = STATUS_LABEL[r.status] ?? r.status;
  return `${'  '.repeat(depth)}- [${box}] ${no}${r.title}（状态：${status} · 优先级：${prio}${r.category ? ` · 分类：${r.category}` : ''}）`;
}

function markPlanLine(r: PlanRow, depth: number): string {
  const status = PLAN_STATUS_LABEL[r.status] ?? r.status;
  const kind = r.kind === 'milestone' ? '里程碑 · ' : '';
  const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} ~ ${r.end_date}`;
  return `${'  '.repeat(depth)}- ${r.title}（${kind}状态：${status} · 进度：${r.progress}% · ${range}）`;
}

/**
 * 深度优先展开；visited 防 deps 自环/互指把导出挂死。
 * 成环的行从根走不到——收尾时补到顶层，宁可多一行也不能让数据静默消失。
 */
function walkTree<T extends { id: string }>(map: Map<string | null, T[]>, visit: (row: T, depth: number) => string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    if (depth > 20) return;
    for (const row of map.get(parent) ?? []) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      out.push(visit(row, depth));
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const rows of map.values()) {
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      out.push(visit(row, 0));
    }
  }
  return out;
}

function buildTasksMarkdown(projectId: string, rows: TaskRow[]): string {
  const done = rows.filter((r) => r.status === 'done').length;
  const body = walkTree(taskChildren(rows), markTaskLine);
  return [
    `# 项目任务导出：${projectName(projectId)}（${rows.length} 条）`,
    '',
    `> 完成 ${done} / ${rows.length}；层级按父子任务展开，未挂父任务的行在顶层。`,
    '',
    ...body,
    '',
  ].join('\n');
}

function buildPlansMarkdown(projectId: string, rows: PlanRow[]): string {
  const body = walkTree(planChildren(rows), markPlanLine);
  return [
    `# 项目计划导出：${projectName(projectId)}（${rows.length} 条）`,
    '',
    '> 层级按里程碑归属（deps type=child）展开；serial 依赖只影响排期，不在导出里建树。',
    '',
    ...body,
    '',
  ].join('\n');
}

function buildTasksJson(projectId: string, rows: TaskRow[]): string {
  return JSON.stringify({
    project: { id: projectId, name: projectName(projectId) },
    scope: 'tasks',
    exportedAt: new Date().toISOString(),
    count: rows.length,
    tasks: rows.map((r) => ({
      id: r.id,
      taskNo: r.task_no,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      category: r.category,
      parentId: r.parent_id,
      createdAt: r.created_at,
    })),
  }, null, 2);
}

function buildPlansJson(projectId: string, rows: PlanRow[]): string {
  const ids = new Set(rows.map((r) => r.id));
  return JSON.stringify({
    project: { id: projectId, name: projectName(projectId) },
    scope: 'plans',
    exportedAt: new Date().toISOString(),
    count: rows.length,
    plans: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      startDate: r.start_date,
      endDate: r.end_date,
      durationDays: r.duration_days,
      progress: r.progress,
      status: r.status,
      kind: r.kind,
      assignee: r.assignee,
      parentId: planParentId(r, ids),
      deps: r.deps,
    })),
  }, null, 2);
}

export class ProjectExportService {
  static export(projectId: string, scope: ProjectExportScope, format: ProjectExportFormat): ProjectExportFile {
    const name = safeName(projectName(projectId));
    if (scope === 'tasks') {
      const rows = loadTasks(projectId);
      const text = format === 'json' ? buildTasksJson(projectId, rows) : buildTasksMarkdown(projectId, rows);
      return {
        buffer: Buffer.from(text, 'utf-8'),
        filename: `${name}-任务-${ymd()}.${format}`,
        mime: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      };
    }
    const rows = loadPlans(projectId);
    const text = format === 'json' ? buildPlansJson(projectId, rows) : buildPlansMarkdown(projectId, rows);
    return {
      buffer: Buffer.from(text, 'utf-8'),
      filename: `${name}-计划-${ymd()}.${format}`,
      mime: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    };
  }
}
