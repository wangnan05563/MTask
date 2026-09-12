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
import { getDefaultNoteProjectId } from '../services/AppSettings';
import { TaskService } from '../services/TaskService';
import { PlanService } from '../services/PlanService';
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

/**
 * 按 id 或 taskNo 解析任务：二选一必传。
 * 返回 null 表示既未提供定位参数，也代表参数提供但任务不存在（调用方据文案区分）。
 */
function resolveTask({ id, taskNo }: { id?: string; taskNo?: string }) {
  if (id) return TaskService.getById(id);
  if (taskNo) return TaskService.findByNo(taskNo);
  return null;
}

/** 任务定位参数的缺省提示（缺失时返回错误信息） */
function taskLocateError(): string {
  return 'id 与 taskNo 至少提供一个；id 为任务内部 id，taskNo 为任务编号（如 T00001）';
}

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
    description: '在指定项目下新建任务；projectId 缺省时落到默认记事项目。title 必填。默认开启查重：同项目存在同标题任务时不再新建，直接返回既有任务（reused=true），避免多渠道回写产生重复待办。',
    inputSchema: {
      projectId: z.string().optional().describe('目标项目 id，缺省用默认记事项目'),
      title: z.string().describe('任务标题（必填）'),
      description: z.string().optional().describe('任务描述'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('优先级'),
      status: z.enum(['todo', 'done']).optional().describe('状态'),
      categoryId: z.string().optional().describe('任务分类 id'),
      parentId: z.string().optional().describe('父任务 id（T00450：创建子任务挂到 epic→task 层级；须与目标项目一致）'),
      dedupe: z.boolean().optional().describe('同项目同标题查重（默认开启；命中时返回既有任务且 reused=true，不新建）'),
    },
  }, async (a) => {
    try {
      // 可选链：title 为空时 ?. 短路返回 undefined，与原「判空 || trim 判空」逻辑等价
      if (!a.title?.trim()) return err('title 必填');
      // projectId 缺省落「默认记事项目」：用户设置优先，否则收件箱系统项目；与 REST /tasks 行为保持一致
      const pid = a.projectId?.trim() || getDefaultNoteProjectId();
      if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) {
        return err(`归属项目不存在：${pid}`);
      }
      // 查重（T00445 教训：MCP 回传/计划镜像/手动创建多渠道并存，无查重会产生重复待办）
      // 规范化在 JS 侧统一做（SQLite 无 regexp）：比对「去所有空白」后的标题，避免空格差异漏配
      const dedupe = a.dedupe !== false;
      const normTitle = a.title.replaceAll(/\s+/g, '');
      if (dedupe) {
        const rows = getDb().prepare('SELECT * FROM tasks WHERE project_id = ?').all(pid) as Array<Record<string, unknown>>;
        const exist = rows.find((r) => (typeof r.title === 'string' ? r.title : '').replaceAll(/\s+/g, '') === normTitle);
        if (exist) return ok(json({ reused: true, task: exist }), { reused: true, task: exist });
      }
      // T00450：父子层级——父任务校验（存在且同项目）
      let parentId = a.parentId?.trim() || undefined;
      if (parentId) {
        const parent = getDb().prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(parentId) as { project_id: string } | undefined;
        if (!parent) return err('父任务不存在');
        if (parent.project_id !== pid) return err('子任务与父任务必须同项目');
      }
      const task = TaskService.create({
        projectId: pid,
        title: a.title,
        description: a.description,
        priority: a.priority,
        status: a.status,
        categoryId: a.categoryId,
        parentId,
      });
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_plans', {
    title: '列出项目计划',
    description: '列出指定项目的计划任务（串行瀑布时间线，含起止日期/工期/状态/进度/关联待办编号）。Agent 用于了解项目排期与规划上下文，避免与既有计划重复回写。includeArchived=true 时返回已归档计划。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，与 projectName 二选一'),
      projectName: z.string().optional().describe('项目名称（如 MTask），按名称解析'),
      includeArchived: z.boolean().optional().describe('是否包含已归档计划（默认否）'),
    },
  }, async (a) => {
    try {
      let pid = a.projectId?.trim() || '';
      if (!pid && a.projectName?.trim()) {
        const p = getDb().prepare('SELECT id FROM projects WHERE name = ?').get(a.projectName.trim()) as { id: string } | undefined;
        if (!p) return err(`项目不存在：${a.projectName}`);
        pid = p.id;
      }
      if (!pid) return err('projectId 或 projectName 必填');
      if (a.includeArchived) {
        const all = PlanService.listArchived().filter((r) => r.project_id === pid);
        return ok(json(all.map((r) => ({
          title: r.title, startDate: r.start_date, endDate: r.end_date,
          durationDays: r.duration_days, status: r.status, progress: r.progress, assignee: r.assignee, archived: true,
        }))), { plans: all });
      }
      const rows = PlanService.list(pid);
      const plans = rows.map((r) => ({
        title: r.title, description: r.description, startDate: r.start_date, endDate: r.end_date,
        durationDays: r.duration_days, progress: r.progress, status: r.status, assignee: r.assignee,
        linkedTaskNo: null as string | null,
      }));
      // 附关联待办编号（Agent 回传时需要 taskNo 而非内部 id）
      for (let i = 0; i < rows.length; i++) {
        const lid = rows[i].linked_task_id;
        if (lid) {
          const t = getDb().prepare('SELECT task_no FROM tasks WHERE id = ?').get(lid) as { task_no: string | null } | undefined;
          plans[i].linkedTaskNo = t?.task_no ?? null;
        }
      }
      return ok(json(plans), { plans });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_create_plans', {
    title: '批量创建项目计划',
    description: '把 WBS/需求拆解结果批量写入指定项目的计划时间线（串行瀑布：任务按顺序自动按工作日排期，跳过周末与节假日；首条可带 startDate 作锚点）。适用于「把需求文档/PRD 拆分为项目计划」类回写。',
    inputSchema: {
      projectId: z.string().optional().describe('目标项目 id，与 projectName 二选一'),
      projectName: z.string().optional().describe('项目名称，按名称解析'),
      items: z.array(z.object({
        title: z.string().describe('任务标题（必填，建议带 WBS 编号）'),
        description: z.string().optional().describe('描述'),
        startDate: z.string().optional().describe('开始日期 YYYY-MM-DD（仅首条生效作时间线锚点，其余由串行排期推导）'),
        durationDays: z.number().optional().describe('工期（工作日数，默认 1）'),
        assignee: z.string().optional().describe('负责人'),
        status: z.enum(['todo', 'doing', 'done', 'blocked']).optional().describe('状态，默认 todo'),
      })).describe('计划条目数组（按执行顺序排列）'),
    },
  }, async (a) => {
    try {
      let pid = a.projectId?.trim() || '';
      if (!pid && a.projectName?.trim()) {
        const p = getDb().prepare('SELECT id FROM projects WHERE name = ?').get(a.projectName.trim()) as { id: string } | undefined;
        if (!p) return err(`项目不存在：${a.projectName}`);
        pid = p.id;
      }
      if (!pid) return err('projectId 或 projectName 必填');
      const r = PlanService.createBatch(pid, a.items);
      return ok(json(r), { ok: true, ...r });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_task', {
    title: '更新任务',
    description: '按 id 或任务编号 taskNo 更新任务字段（title/description/priority/status/verified/pinned/categoryId）；未提供的字段保持不变。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
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
      const target = resolveTask(a);
      if (!target) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      const task = TaskService.update(target.id, {
        title: a.title, description: a.description, priority: a.priority,
        status: a.status, verified: a.verified, pinned: a.pinned, category_id: a.categoryId,
      });
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_tasks', {
    title: '列出任务',
    description: '按项目/状态/归档态列出任务；projectId 或 projectName 二者可选其一过滤项目，都不传则列出全部项目。默认只返回「待处理 或 未验证」的任务（利于 AI 分析决策）；需查其他需显式传 status。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，缺省列出全部项目任务'),
      projectName: z.string().optional().describe('项目名称（如 MTask/wiki/xianyu），按名称解析为项目 id 过滤，与 projectId 二选一'),
      status: z.enum(['todo', 'done']).optional().describe('按状态精确过滤（todo/done）；status 与 scope 均不传时默认返回「待处理+未验证」'),
      scope: z.enum(['pending', 'all']).optional().describe('查询范围：pending=待处理或未验证（默认）；all=该范围内全部任务（等价旧行为）'),
      archived: z.boolean().optional().default(false).describe('是否列出已归档任务'),
    },
  }, async (a) => {
    try {
      // AI Agent 更习惯直接给项目名称而非 UUID：projectName 存在时先解析成 project_id 再过滤
      let pid = a.projectId;
      if (!pid && a.projectName?.trim()) {
        const p = getDb().prepare('SELECT id FROM projects WHERE name = ? ORDER BY sort_weight, created_at LIMIT 1').get(a.projectName.trim()) as { id: string } | undefined;
        if (!p) return err(`项目不存在：${a.projectName}`);
        pid = p.id;
      }
      // 范围解析：显式 status 按状态精确过滤；否则 scope=all 表示全量，scope=pending 或未说明时默认「待处理+未验证」分析范围
      let listOpts: Parameters<typeof TaskService.list>[0] = { projectId: pid, archived: a.archived ?? false };
      if (a.status) listOpts.status = a.status;
      else if (a.scope !== 'all') listOpts.pending = true;
      const tasks = TaskService.list(listOpts);
      return ok(json(tasks), { tasks });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_get_task', {
    title: '查询任务',
    description: '按 id 或任务编号 taskNo 返回单个任务详情（含 task_no 与截图元信息）。不存在返回错误。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
    },
  }, async (a) => {
    try {
      const task = resolveTask(a);
      if (!task) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      return ok(json(task), { task });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_task_result', {
    title: '同步任务处理结果',
    description: '把 AI 总结的根因分析与解决方案等结论写入指定任务的「处理结果」字段（Markdown 文本）。按 id 或任务编号 taskNo 定位。适合在排查结束后将结论回写到 MTask 对应任务，供用户在任务「处理结果」区块查看/编辑。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一），来自 mtask_list_tasks / mtask_get_task 的 id'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
      result: z.string().describe('处理结果正文（Markdown）：根因分析、解决方案、验证结论等'),
    },
  }, async (a) => {
    try {
      const target = resolveTask(a);
      if (!target) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      if (!a.result) return err('result 必填');
      const task = TaskService.update(target.id, { handle_result: a.result });
      return ok(`已同步处理结果到任务 ${target.task_no ?? target.id}`, { task });
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
      // 与 create_task 一致：空名 trim 判空，拒绝生成空名分类
      if (!a.name?.trim()) return err('name 必填');
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
      // WHERE 子句提取为独立变量：避免模板字面量嵌套，拼接逻辑也更易读
      const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const sql = `SELECT * FROM prompts${whereClause} ORDER BY pinned DESC, updated_at DESC`;
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
      // 与 create_task 一致：title 判空，拒绝空标题提示词
      if (!a.title?.trim()) return err('title 必填');
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