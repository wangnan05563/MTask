import { getDb } from './connection';

/**
 * T06305（REQ-010 / PRD §B2）：任务/项目模板与实例化记录。
 *
 * 只做增量表，不改既有 tasks/projects。模板体存 schema_json（无宏变量，直接是可复用字段），
 * 实例表回答「这次一键创建建了什么、能不能撤销」——撤销必须能精确回收，不能靠猜标题。
 *
 * 设计口径：
 * - type=task  → 实例化后在指定项目建一条任务；
 * - type=project → 实例化后建一个项目（名称唯一）及其模板内的任务。
 * - builtin=1 的模板只读（可实例化，不可改/删），自定义模板可维护。
 */
const TEMPLATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS templates (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK(type IN ('task','project')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema_json TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_templates_type_name ON templates(type, name);

CREATE TABLE IF NOT EXISTS template_instances (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK(template_type IN ('task','project')),
  project_id  TEXT,
  task_ids    TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  undone_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_instances_template ON template_instances(template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_template_instances_project ON template_instances(project_id, created_at DESC);
`;

function now(): string {
  return new Date().toISOString();
}

/**
 * 内置模板只在缺失时插入，不覆盖用户副本；名称固定，升级时靠新增名称扩展。
 * 任务模板是「单任务字段」，项目模板是「项目描述 + 任务清单」，都不含变量。
 */
const BUILTIN_TEMPLATES: Array<{ type: 'task' | 'project'; name: string; description: string; schema: unknown }> = [
  {
    type: 'task',
    name: '功能开发任务',
    description: '内置 · 单条功能开发任务的字段骨架',
    schema: {
      title: '功能开发：',
      description: '## 目标\n\n## 验收标准\n\n## 影响范围\n',
      priority: 'normal',
      status: 'todo',
    },
  },
  {
    type: 'project',
    name: '标准交付项目',
    description: '内置 · 需求到发布的标准项目骨架（4 条任务）',
    schema: {
      description: '需求澄清 → 方案设计 → 开发自测 → 验收发布',
      tasks: [
        { title: '需求澄清与验收标准', description: '确认范围、边界与验收口径。', priority: 'high', status: 'todo' },
        { title: '方案设计与评审', description: '输出技术方案，完成评审并记录决策。', priority: 'normal', status: 'todo' },
        { title: '开发与自测', description: '按方案实现并完成自测。', priority: 'normal', status: 'todo' },
        { title: '验收与发布', description: '按验收标准复核，完成发布与回滚预案。', priority: 'high', status: 'todo' },
      ],
    },
  },
];

export function ensureTemplateSchema(): void {
  const db = getDb();
  db.exec(TEMPLATE_SCHEMA_SQL);
  const stmt = db.prepare(
    `INSERT INTO templates (id, type, name, description, schema_json, version, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT(type, name) DO NOTHING`,
  );
  const t = now();
  for (const item of BUILTIN_TEMPLATES) {
    stmt.run(`builtin-${item.type}-${item.name}`, item.type, item.name, item.description, JSON.stringify(item.schema), t, t);
  }
}
