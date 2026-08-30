/**
 * MTask MCP server：把现有 Express REST 服务能力以 MCP tools 形式暴露给外部 AI agent。
 *
 * 设计原则：直接复用现有 service（TaskService/ReportService/SettingsService 等），
 * 因此数据校验、图片 BLOB、密钥加密、导入导出逻辑与 Web 端完全一致，不产生第二套业务实现。
 * 传输层（streamable HTTP）与会话管理在 mcp/http.ts，鉴权复用现有 accessToken 体系。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/connection';
import { TaskService } from '../services/TaskService';
import { ArchiveService } from '../services/ArchiveService';
import {
  gatherReportData,
  generateReport,
  aiGenerateReport,
  readAndDeleteReport,
  type ReportPeriod,
  type ReportFormat,
} from '../services/ReportService';
import { exportBundle, importBundle, type ImportMode } from '../services/SettingsService';

/** MCP 工具统一返回结构：文本供 LLM 阅读，structuredContent 供程序消费 */
function ok(text: string, data?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data ?? {} };
}
function err(msg: string): CallToolResult {
  return { content: [{ type: 'text', text: `错误：${msg}` }], isError: true };
}
const json = (d: unknown) => JSON.stringify(d, null, 2);

const PERIODS = ['day', 'week', 'month'] as const;
const FORMATS = ['xlsx', 'docx', 'pdf', 'pptx'] as const;

/** 创建 MCP server 并注册全部工具 */
export async function createMCPServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'mtask', version: '1.0.0' });

  // ---------------- 任务管理 ----------------
  server.registerTool('mtask_list_projects', {
    title: '列出项目',
    description: '返回 MTask 全部项目（项目维度任务管理的容器）。',
  }, async () => {
    try {
      const rows = getDb().prepare('SELECT * FROM projects ORDER BY sort_weight, created_at').all();
      return ok(json(rows), { projects: rows });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_create_task', {
    title: '创建任务',
    description: '在指定项目下新建任务；projectId 缺省时落到默认记事项目。title 必填。',
    inputSchema: {
      projectId: z.string().describe('目标项目 id，缺省用默认记事项目'),
      title: z.string().describe('任务标题（必填）'),
      description: z.string().optional().describe('任务描述'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('优先级'),
      status: z.enum(['todo', 'done']).optional().describe('状态'),
      categoryId: z.string().optional().describe('任务分类 id'),
    },
  }, async (a) => {
    try {
      if (!a.title || !a.title.trim()) return err('title 必填');
      const task = TaskService.create({
        projectId: a.projectId,
        title: a.title,
        description: a.description,
        priority: a.priority,
        status: a.status,
        categoryId: a.categoryId,
      });
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_task', {
    title: '更新任务',
    description: '按 id 更新任务字段（title/description/priority/status/verified/pinned/categoryId）；未提供的字段保持不变。',
    inputSchema: {
      id: z.string().describe('任务 id（必填）'),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      status: z.enum(['todo', 'done']).optional(),
      verified: z.boolean().optional().describe('验证完成标记'),
      pinned: z.boolean().optional().describe('置顶'),
      categoryId: z.string().nullish().describe('任务分类 id，传 null 清除分类'),
    },
  }, async (a) => {
    try {
      const task = TaskService.update(a.id, {
        title: a.title, description: a.description, priority: a.priority,
        status: a.status, verified: a.verified, pinned: a.pinned, category_id: a.categoryId,
      });
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_tasks', {
    title: '列出任务',
    description: '按项目/归档态列出任务；projectId 为空列出全部项目。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，缺省列出全部项目任务'),
      archived: z.boolean().optional().default(false).describe('是否列出已归档任务'),
    },
  }, async (a) => {
    try {
      // list 已重构为单一选项对象签名（支持分页/搜索/分类/排序）
      const tasks = TaskService.list({ projectId: a.projectId, archived: a.archived ?? false });
      return ok(json(tasks), { tasks });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_get_task', {
    title: '查询任务',
    description: '按 id 返回单个任务详情（含截图元信息）。不存在返回错误。',
    inputSchema: { id: z.string().describe('任务 id') },
  }, async (a) => {
    try {
      const task = TaskService.getById(a.id);
      if (!task) return err(`任务不存在：${a.id}`);
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_move_tasks', {
    title: '批量移动项目',
    description: '把一组任务移动到目标项目（taskIds 与 projectId 均必填）。',
    inputSchema: {
      taskIds: z.array(z.string()).describe('任务 id 数组'),
      projectId: z.string().describe('目标项目 id'),
    },
  }, async (a) => {
    try {
      TaskService.moveProject(a.taskIds, a.projectId);
      return ok(`已移动 ${a.taskIds.length} 个任务`); 
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_set_tasks_archived', {
    title: '归档/还原任务',
    description: '批量归档（archived=true）或还原（archived=false）一组任务。',
    inputSchema: {
      taskIds: z.array(z.string()).describe('任务 id 数组'),
      archived: z.boolean().describe('true=归档，false=还原'),
    },
  }, async (a) => {
    try {
      const tasks = a.archived ? ArchiveService.archive(a.taskIds) : ArchiveService.restore(a.taskIds);
      return ok(json(tasks), { tasks });
    } catch (e) { return err((e as Error).message); }
  });

  // ---------------- 提示词管理 ----------------
  server.registerTool('mtask_list_prompt_categories', {
    title: '列出提示词分类',
    description: '返回全部提示词分类及其下提示词数量。',
  }, async () => {
    try {
      const cats = getDb().prepare('SELECT * FROM prompt_categories ORDER BY sort_weight, created_at').all() as { id: string }[];
      const counts = getDb().prepare('SELECT category_id, COUNT(*) AS c FROM prompts GROUP BY category_id').all() as { category_id: string; c: number }[];
      const countMap = new Map(counts.map((r) => [r.category_id, r.c]));
      const rows = cats.map((c) => ({ ...c, promptCount: countMap.get(c.id) ?? 0 }));
      return ok(json(rows), { categories: rows });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_create_prompt_category', {
    title: '创建提示词分类',
    description: '新建提示词分类（name 必填）。',
    inputSchema: { name: z.string().describe('分类名称'), description: z.string().optional().describe('分类说明') },
  }, async (a) => {
    try {
      const id = randomUUID();
      const t = new Date().toISOString();
      getDb().prepare('INSERT INTO prompt_categories (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, a.name.trim(), a.description ?? '', t, t);
      const row = getDb().prepare('SELECT * FROM prompt_categories WHERE id = ?').get(id);
      return ok(json(row), { category: row });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_prompts', {
    title: '列出提示词',
    description: '按分类/关键词列出提示词库中的条目。',
    inputSchema: {
      categoryId: z.string().optional().describe('分类 id，缺省列出全部'),
      keyword: z.string().optional().describe('标题/内容模糊检索关键词'),
    },
  }, async (a) => {
    try {
      const where: string[] = [];
      const values: unknown[] = [];
      if (a.categoryId) { where.push('category_id = ?'); values.push(a.categoryId); }
      if (a.keyword) { where.push('(title LIKE ? OR content LIKE ?)'); values.push(`%${a.keyword}%`, `%${a.keyword}%`); }
      const sql = `SELECT * FROM prompts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC`;
      const rows = getDb().prepare(sql).all(...values);
      return ok(json(rows), { prompts: rows });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_create_prompt', {
    title: '创建提示词',
    description: '在指定分类下创建提示词条目（categoryId 与 title 必填）。',
    inputSchema: {
      categoryId: z.string().describe('目标提示词分类 id'),
      title: z.string().describe('提示词标题（必填）'),
      content: z.string().optional().default('').describe('提示词内容'),
    },
  }, async (a) => {
    try {
      const id = randomUUID();
      const t = new Date().toISOString();
      getDb().prepare('INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, a.categoryId, a.title.trim(), a.content ?? '', t, t);
      const row = getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id);
      return ok(json(row), { prompt: row });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_prompt', {
    title: '更新提示词',
    description: '更新提示词（title/content/categoryId/pinned），未提供的字段保持不变。',
    inputSchema: {
      id: z.string().describe('提示词 id'),
      title: z.string().optional(),
      content: z.string().optional(),
      categoryId: z.string().optional(),
      pinned: z.boolean().optional().describe('置顶'),
    },
  }, async (a) => {
    try {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (a.title !== undefined) { sets.push('title = ?'); values.push(a.title); }
      if (a.content !== undefined) { sets.push('content = ?'); values.push(a.content); }
      if (a.categoryId !== undefined) { sets.push('category_id = ?'); values.push(a.categoryId); }
      if (a.pinned !== undefined) { sets.push('pinned = ?'); values.push(a.pinned ? 1 : 0); }
      if (sets.length === 0) return err('无更新字段');
      sets.push('updated_at = ?'); values.push(new Date().toISOString(), a.id);
      getDb().prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      const row = getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(a.id);
      return ok(json(row), { prompt: row });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_delete_prompt', {
    title: '删除提示词',
    description: '按 id 删除提示词条目（不可恢复）。',
    inputSchema: { id: z.string().describe('提示词 id') },
  }, async (a) => {
    try {
      getDb().prepare('DELETE FROM prompts WHERE id = ?').run(a.id);
      return ok(`已删除提示词 ${a.id}`);
    } catch (e) { return err((e as Error).message); }
  });

  // ---------------- 周报生成 ----------------
  server.registerTool('mtask_gather_report_data', {
    title: '聚合周期数据',
    description: '聚合指定周期（day/week/month）内的真实任务数据（项目汇总 + 任务明细），供 AI 据此分析。只读，不生成文件。',
    inputSchema: {
      period: z.enum(PERIODS).describe('周期：day=日报/week=周报/month=月报'),
      projectId: z.string().optional().describe('项目 id，缺省聚合全部项目'),
    },
  }, async (a) => {
    try {
      if (!(PERIODS as readonly string[]).includes(a.period)) return err('period 非法（day|week|month）');
      const data = gatherReportData(a.period as ReportPeriod, a.projectId);
      return ok(json(data), { data });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_generate_report', {
    title: '生成周期报表文件',
    description: '按周期+格式生成标准报表文件（真实数据排版），返回 base64 文件内容与文件名。',
    inputSchema: {
      period: z.enum(PERIODS).describe('周期'),
      format: z.enum(FORMATS).describe('输出格式'),
      projectId: z.string().optional().describe('项目 id，缺省全项目'),
      templateId: z.string().optional().describe('用户模板文件名（仅 xlsx/docx）'),
    },
  }, async (a) => {
    try {
      if (!(PERIODS as readonly string[]).includes(a.period)) return err('period 非法（day|week|month）');
      if (!(FORMATS as readonly string[]).includes(a.format)) return err('format 非法（xlsx|docx|pdf|pptx）');
      const r = await generateReport(a.period as ReportPeriod, a.format as ReportFormat, {
        projectId: a.projectId, templateId: a.templateId,
      });
      return ok('', { filename: r.filename, format: a.format, size: r.buffer.length, base64: r.buffer.toString('base64') });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_ai_generate_report', {
    title: 'AI 生成周报',
    description: '基于周期真实数据由 AI 撰写洞察并合成指定格式文件；返回洞察正文 Markdown + 文件 base64。toolId 为已配置且可用的 AI 工具。',
    inputSchema: {
      period: z.enum(PERIODS).describe('周期'),
      format: z.enum(FORMATS).describe('输出格式'),
      toolId: z.string().describe('AI 工具 id'),
      projectId: z.string().optional().describe('项目 id，缺省全项目'),
    },
  }, async (a) => {
    try {
      if (!(PERIODS as readonly string[]).includes(a.period)) return err('period 非法（day|week|month）');
      if (!(FORMATS as readonly string[]).includes(a.format)) return err('format 非法（xlsx|docx|pdf|pptx）');
      const { token, filename, insight } = await aiGenerateReport(a.period as ReportPeriod, a.format as ReportFormat, {
        projectId: a.projectId, toolId: a.toolId,
      });
      // 消费一次性临时文件：读取即删除，换取 base64 供调用方直接存储/使用
      const buf = readAndDeleteReport(token);
      return ok(insight, { insight, filename, format: a.format, size: buf?.length, base64: buf?.toString('base64') });
    } catch (e) { return err((e as Error).message); }
  });

  // ---------------- 数据迁移 ----------------
  server.registerTool('mtask_export_data', {
    title: '导出全量数据',
    description: '导出 MTask 全部业务数据为 bundle JSON（任务/项目/提示词/AI 工具等），用于换机迁移或备份。',
  }, async () => {
    try {
      const bundle = exportBundle();
      return ok('', { bundle });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_import_data', {
    title: '导入全量数据',
    description: '导入 export 产出的 bundle JSON；mode: overwrite=清空后全量覆盖 / keep=保留已有 id / merge=覆盖同名 id 合并。整个导入在单事务内完成，失败回滚。',
    inputSchema: {
      data: z.unknown().describe('export 工具导出的 bundle 对象（结构含 app/version/data）'),
      mode: z.enum(['overwrite', 'keep', 'merge'] as const).describe('冲突策略'),
    },
    annotations: { destructiveHint: true },
  }, async (a) => {
    try {
      const r = importBundle(a.data, a.mode as ImportMode);
      return ok(json(r), { result: r });
    } catch (e) { return err((e as Error).message); }
  });

  return server;
}