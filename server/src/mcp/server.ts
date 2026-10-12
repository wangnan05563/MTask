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
import { readPoolStatus, poolFullHint } from '../services/ConcurrencyPool'; // T01066 后续：MCP 领取路径池满提示
import { TaskService } from '../services/TaskService';
import { TaskImageService } from '../services/TaskImageService'; // T00610：截图读取（供 AI 识别验证失败反馈截图）
import { PlanService } from '../services/PlanService';
import { parsePlanDeps } from '../util/planDeps'; // T01689：deps 解析单源复用（T01284 统一实现，MCP 层不再自造第二套口径）
import { ExecSessionService } from '../services/ExecSessionService'; // T01269：执行会话心跳上报（FR-1.2）
import { SupervisorService } from '../services/SupervisorService'; // T01286：监督状态查询（FR-5.2）
import { resolvePrdContext } from '../util/prdContext'; // T00763：PRD 上下文反查
import { TestCaseService, type CasePatch } from '../services/TestCaseService'; // T01493：测试用例 MCP 工具（复用服务层单源枚举与幂等落库）
import { CASE_PRIORITY, CASE_TYPE, CASE_METHOD, CASE_STATUS, CASE_RESULT } from '../util/testCaseEnums'; // T01493：zod 枚举从单源导入，杜绝第三次口径漂移
import { ArchiveService } from '../services/ArchiveService';
import { EstimateService, ESTIMATE_META, ESTIMATE_PHASES, ESTIMATE_SOURCES } from '../services/EstimateService'; // T02044：估算 MCP 工具（枚举单源，zod 不许自造第二套词表）
import { expected, sigma } from '../services/estimate-engine'; // T02044：回写后回执里的 E/σ 由引擎给，MCP 层不重算三点
import { ESTIMATE_ARTIFACT_FORMATS, buildEstimateArtifact, estimatesSnapshot, parseAudience, parsePhases, parseScope } from '../routes/estimates'; // T02044：与 REST 同一份取数与导出流水线
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

/** 按项目名解析 id（精确 → 大小写不敏感），供 MCP 工具复用；返回 {id} 或 {error} */
function resolveProjectByName(name: string): { id?: string; error?: string } {
  const all = getDb().prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
  const exact = all.find((p) => p.name === name);
  const ci = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const hit = exact ?? ci;
  if (!hit) return { error: `项目「${name}」不存在。候选：${all.slice(0, 10).map((p) => p.name).join('、')}（可先调 mtask_list_projects 查询）` };
  return { id: hit.id };
}

/** 父任务校验（存在且同项目）；通过返回 null，否则返回错误文案 */
function validateParent(parentId: string | undefined, pid: string): string | null {
  if (parentId) {
    const parent = getDb().prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(parentId) as { project_id: string } | undefined;
    if (!parent) return '父任务不存在';
    if (parent.project_id !== pid) return '子任务与父任务必须同项目';
  }
  return null;
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
    description: '在指定项目下新建任务；projectId/projectName 均缺省时落到默认记事项目（附日志警告）。建议传 projectName 按名路由。title 必填。默认开启查重：同项目存在同标题任务时不再新建，直接返回既有任务（reused=true），避免多渠道回写产生重复待办。',
    inputSchema: {
      projectId: z.string().optional().describe('目标项目 id；与 projectName 二选一，都在时 projectId 优先'),
      projectName: z.string().optional().describe('目标项目名称（T00482：按名路由到对应项目，大小写不敏感；无命中/多命中时报错并列出候选）'),
      title: z.string().describe('任务标题（必填）'),
      description: z.string().optional().describe('任务描述'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('优先级'),
      status: z.enum(['todo', 'done']).optional().describe('状态'),
      categoryId: z.string().optional().describe('任务分类 id'),
      parentId: z.string().optional().describe('父任务 id（T00450：创建子任务挂到 epic→task 层级；须与目标项目一致）'),
      dedupe: z.boolean().optional().describe('同项目同标题查重（默认开启；命中时返回既有任务且 reused=true，不新建）'),
      derivedFrom: z.string().optional().describe('T00577：原任务编号（如 T00422）——本单为该任务派生出的待办单时传入，便于处理后自动把结论整合回原任务，避免单子过多'),
    },
  }, async (a) => {
    try {
      // 可选链：title 为空时 ?. 短路返回 undefined，与原「判空 || trim 判空」逻辑等价
      if (!a.title?.trim()) return err('title 必填');
      // T00482：项目归属路由——projectId 优先；其次 projectName 按名解析（精确 → 大小写不敏感）；
      // 都未提供才缺省「默认记事项目」（用户设置优先，否则收件箱），并打日志警告便于排查误入收件箱
      let pid = a.projectId?.trim() || '';
      if (!pid && a.projectName?.trim()) {
        const r = resolveProjectByName(a.projectName.trim());
        if (r.error) return err(r.error);
        pid = r.id ?? '';
      }
      if (!pid) {
        pid = getDefaultNoteProjectId();
        console.warn(`[mtask-mcp] mtask_create_task 缺少项目归属（projectId/projectName 均未提供），任务「${a.title?.trim()}」落入默认记事项目 ${pid}`);
      }
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
      const perr = validateParent(parentId, pid);
      if (perr) return err(perr);
      const task = TaskService.create({ derived_from: a.derivedFrom?.trim() || null, /* T00577 */
        projectId: pid,
        title: a.title,
        description: a.description,
        priority: a.priority,
        status: a.status,
        categoryId: a.categoryId,
        parentId,
      });
      // T00713：AI 建单（含回写派生单）后置 unread 未读圆点——否则派生单在列表中与手工单无异，
      // 用户无从感知「AI 产生了新单待处理」（T00620 显式驱动后不再有读取自动置 running 的兜底表现）
      let fresh = task;
      if ((task.status ?? 'todo') === 'todo') {
        fresh = TaskService.setAiState(task.id, 'unread') ?? task;
      }
      return ok(json(fresh), { task: fresh });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_plans', {
    title: '列出项目计划',
    description: '列出指定项目的计划任务（串行瀑布时间线，含 id/类型 kind/起止日期/工期/状态/进度/关联待办编号）。Agent 用于了解项目排期与规划上下文，避免与既有计划重复回写。条目多时建议 brief=true（省掉 description 与依赖明细、只回 depsCount/reqIdsCount，避免响应被截断）；只看里程碑可用 kind=milestone 过滤。includeArchived=true 时返回已归档计划。T01689：完整模式每条另回 deps（[{id,type:serial|parallel}] 前置依赖——外部 Agent 可用于排期/排水校验与「里程碑↔子任务」归属判定）、reqIds（需求矩阵锚点——校验计划↔需求覆盖度/重复锚定）、complexity（AI 复杂度评级 1~5，参与工期判断）；响应 meta 附 withDeps/withReqAnchors 计数（带依赖/带需求锚点的条目数，一眼看出覆盖缺口）。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，与 projectName 二选一'),
      projectName: z.string().optional().describe('项目名称（如 MTask），按名称解析'),
      includeArchived: z.boolean().optional().describe('是否包含已归档计划（默认否）'),
      // T01490：计划条目多时（>5KB）SSE 传输会被中途截断、客户端只拿到残缺 JSON。
      // brief=true 省略 description 并跳过关联待办查询，显著降低响应体量。
      brief: z.boolean().optional().describe('精简输出：省略 description 与关联待办查询，降低响应体量（计划条目多时避免传输截断）；需要看详情时不传'),
      kind: z.enum(['normal', 'milestone', 'daily']).optional().describe('按计划类型过滤（如只取里程碑 kind=milestone）'),
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
      // T01689：req_ids JSON → string[]（与 PlanService 内部 parseLinkIds 同口径；私有函数不跨层引用）
      const parseReqIds = (raw: string | null | undefined): string[] => {
        try {
          const v: unknown = JSON.parse(raw || '[]');
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        } catch { return []; }
      };
      // complexity 列由 ensureColumn 补齐、PRD 导入写入；PlanTaskRow 已声明为可选字段，历史行为 NULL
      const cx = (r: { complexity?: number | null }): number | null => r.complexity ?? null;
      if (a.includeArchived) {
        const all = PlanService.listArchived().filter((r) => r.project_id === pid);
        return ok(json(all.map((r) => ({
          id: r.id, title: r.title, kind: r.kind, startDate: r.start_date, endDate: r.end_date,
          durationDays: r.duration_days, status: r.status, progress: r.progress, assignee: r.assignee, archived: true,
          deps: parsePlanDeps(r.deps), reqIds: parseReqIds(r.req_ids), complexity: cx(r),
        }))), { plans: all });
      }
      let rows = PlanService.list(pid);
      if (a.kind) rows = rows.filter((r) => r.kind === a.kind);
      // T01490：brief 模式省略 description + 跳过关联待办查询，压低体量避免传输截断
      // T01689：brief 仍回 depsCount/reqIdsCount/complexity（数量级字段，Agent 可低成本判断覆盖度）
      if (a.brief) {
        const brief = rows.map((r) => {
          const deps = parsePlanDeps(r.deps); const reqIds = parseReqIds(r.req_ids);
          return {
            id: r.id, title: r.title, kind: r.kind, startDate: r.start_date, endDate: r.end_date,
            durationDays: r.duration_days, progress: r.progress, status: r.status, assignee: r.assignee,
            depsCount: deps.length, reqIdsCount: reqIds.length, complexity: cx(r),
          };
        });
        return ok(json(brief), {
          plans: brief, count: brief.length,
          withDeps: brief.filter((p) => p.depsCount > 0).length,
          withReqAnchors: brief.filter((p) => p.reqIdsCount > 0).length,
        });
      }
      const plans = rows.map((r) => ({
        id: r.id, title: r.title, kind: r.kind, description: r.description,
        startDate: r.start_date, endDate: r.end_date,
        durationDays: r.duration_days, progress: r.progress, status: r.status, assignee: r.assignee,
        deps: parsePlanDeps(r.deps), reqIds: parseReqIds(r.req_ids), complexity: cx(r),
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
      return ok(json(plans), {
        plans, count: plans.length,
        withDeps: plans.filter((p) => p.deps.length > 0).length,
        withReqAnchors: plans.filter((p) => p.reqIds.length > 0).length,
      });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_create_plans', {
    title: '批量创建项目计划',
    description: '把 WBS/需求拆解结果批量写入指定项目的计划时间线（串行瀑布：任务按顺序自动按工作日排期，跳过周末与节假日；首条可带 startDate 作锚点）。适用于「把需求文档/PRD 拆分为项目计划」类回写。item.kind 可指定 milestone 建里程碑（如「5 M5 AI 编排大脑落地」），缺省为 normal。',
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
        // T01490：kind 原先未暴露——导致经 MCP 回写的计划全部落为 normal，建不出里程碑
        // （PlanService.createBatch 内部支持 kind，仅 MCP schema 缺字段被 zod 剥离）。
        kind: z.enum(['normal', 'milestone', 'daily']).optional()
          .describe('计划类型：milestone=里程碑（汇总节点，如「5 M5 AI 编排大脑落地」，先子后父收口）/ normal=普通工作项（默认）/ daily=日常'),
        // T02122：复杂度钳位早拒——非法值在入口处被 zod 拦截，服务层 clampComplexity 作兜底
        complexity: z.number().int().min(1).max(5).optional().describe('T01058 / T02122：AI 复杂度评级（1~5 整数），随导入落库供工期估算参考'),
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
    description: '按 id 或任务编号 taskNo 更新任务字段（title/description/priority/status/verified/pinned/categoryId）；未提供的字段保持不变。T00502：verified=false + feedback 时自动回退待办并把失败反馈写入处理结果。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      status: z.enum(['todo', 'done']).optional(),
      verified: z.boolean().optional().describe('验证完成标记'),
      feedback: z.string().optional().describe('T00502：验证失败反馈——verified=false 时建议提供，将自动回退待办并以【验证失败】前缀写入处理结果'),
      pinned: z.boolean().optional().describe('置顶'),
      categoryId: z.string().nullish().describe('任务分类 id，传 null 清除分类'),
    },
  }, async (a) => {
    try {
      const target = resolveTask(a);
      if (!target) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      // T00502：验证失败闭环——verified=false 时强制回退待办，feedback 以【验证失败】前缀追加到处理结果
      const failRollback = a.verified === false;
      const status = failRollback ? 'todo' as const : a.status;
      let handle_result: string | undefined = undefined;
      if (failRollback && a.feedback?.trim()) {
        const stamp = new Date().toISOString().slice(0, 10);
        handle_result = `${target.handle_result ?? ''}\n\n【验证失败 ${stamp}】${a.feedback.trim()}`.trim();
      }
      const task = TaskService.update(target.id, {
        title: a.title, description: a.description, priority: a.priority,
        status, verified: a.verified, pinned: a.pinned, category_id: a.categoryId,
        handle_result,
      });
      // T00566 二轮：状态**自动驱动**（不依赖技能显式调用）——验证失败→failed；标记完成→unread（待查看）
      if (failRollback) TaskService.setAiState(target.id, 'failed');
      else if (a.status === 'done') TaskService.setAiState(target.id, 'unread');
      const fresh = TaskService.getById(target.id) ?? task;
      return ok(json(fresh), { task: fresh });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_tasks', {
    title: '列出任务',
    description: '按项目/状态/归档态列出任务；projectId 或 projectName 二者可选其一过滤项目，都不传则列出全部项目。默认只返回「待处理 或 未验证」的任务（利于 AI 分析决策）；需查其他需显式传 status。'
      + '【并发池提示】T01066 后续：并发池已满（运行中任务数 ≥ 上限，默认 3）时，返回文本开头会带一段 ⚠ 软引导，'
      + '提示先收口已领取任务；structuredContent.pool 给出 limit/running/queued/full。此为提示不是拦截——是否继续领取由 Agent 自行判断。',
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
      // T01066 后续：领取路径的池满提示——说明"上限"是软引导而非硬拦截，
      // 让 Agent 自己决定是先收口旧任务还是继续领取（硬拦会破坏多 Agent 自主并发）。
      const pool = readPoolStatus();
      const hint = poolFullHint(pool);
      return ok(hint ? `${hint}\n\n${json(tasks)}` : json(tasks), { tasks, pool });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_get_task', {
    title: '查询任务',
    description: '按 id 或任务编号 taskNo 返回单个任务详情（含 task_no 与截图元信息）。不存在返回错误。'
      + '【状态不再自动驱动】T00620：读取详情**不会**自动置 running（原行为导致"仅查看也转圈、处理完仍转圈"）；'
      + 'Agent 确实开始处理时请显式调用 mtask_write_task_status({state:"running"})，或本次读取传 markRunning:true。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
      markRunning: z.boolean().optional().describe('T00620：显式声明"本次读取即开始处理"，仅在任务从未被处理过（ai_state 与 ai_state_at 均空）时置 running；默认 false'),
    },
  }, async (a) => {
    try {
      const task = resolveTask(a);
      if (!task) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      // T00620：状态**不再自动驱动**。原实现「读取待办即置 running」会把
      // ①仅查看/三查的任务钉成转圈、②已完成的 unread 与中断后的 failed 抹回 running
      // （用户实测："任务处理结束后状态还是运行态"）。
      // 现在：状态只由显式写入驱动（mtask_write_task_status / markRunning:true），
      // 且 running 超时（默认 1 小时，见 TaskService.expireStaleRunning）自动兜底为 failed。
      if (a.markRunning && task.status === 'todo' && task.ai_state === '' && !task.ai_state_at) {
        TaskService.setAiState(task.id, 'running');
      }
      const fresh = TaskService.getById(task.id) ?? task;
      // T01066 后续：markRunning 是真正的「领取」动作——领取后若池已满，把提示带回去，
      // 让 Agent 知道自己已占满槽位、继续领取会挤掉上下文（仍不硬拦）。
      const claimHint = a.markRunning ? poolFullHint(readPoolStatus()) : '';
      return ok(claimHint ? `${claimHint}\n\n${json(fresh)}` : json(fresh), { task: fresh });
    } catch (e) { return err((e as Error).message); }
  });

  // T00610：读取任务截图（含 base64 dataURL）——供 AI 识别验证失败反馈中的截图内容
  server.registerTool('mtask_get_task_images', {
    title: '读取任务截图',
    description: '按 id 或任务编号 taskNo 读取该任务的全部截图（含验证失败反馈随附的截图）。默认返回 base64 dataURL，AI 可直接识别图片内容（如报错弹窗、异常界面）。单张超过 3MB 时仅返回元信息（避免超出上下文）。',
    inputSchema: {
      id: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00001，与 id 二选一）'),
      includeData: z.boolean().optional().describe('是否返回 base64 图片数据（默认 true 供 AI 识别；仅需元信息时传 false）'),
    },
  }, async (a) => {
    try {
      const task = resolveTask(a);
      if (!task) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      const metas = TaskImageService.listByTask(task.id);
      if (metas.length === 0) return ok(JSON.stringify({ count: 0, images: [], note: '该任务没有截图' }), { count: 0, images: [] });
      const includeData = a.includeData !== false;
      const maxBytes = 3 * 1024 * 1024;
      const images = metas.map((m) => {
        const base: Record<string, unknown> = { id: m.id, mime_type: m.mime_type, size: m.size, created_at: m.created_at };
        if (!includeData) return base;
        if (m.size > maxBytes) {
          base.note = `图片 ${(m.size / 1024 / 1024).toFixed(1)}MB 超过 3MB 上限，未返回数据（可用 GET /api/images/${m.id} 下载后本地查看）`;
          return base;
        }
        const data = TaskImageService.getData(m.id);
        if (!data) { base.note = '图片数据缺失'; return base; }
        base.dataUrl = `data:${data.mime_type};base64,${data.data.toString('base64')}`;
        return base;
      });
      return ok(JSON.stringify({ task_no: task.task_no, count: images.length, images }), { task_no: task.task_no, count: images.length, images });
    } catch (e) { return err((e as Error).message); }
  });

  // ---------- T00662：PRD 导入 + 需求跟踪矩阵（外部 AI Agent 全链路） ----------

  /** 项目解析辅助（projectId 优先；projectName 精确 → 大小写不敏感），供 PRD/矩阵系列工具复用 */
  const resolveProjectIdOf = (projectId?: string, projectName?: string): { id?: string; error?: string } => {
    const pid = projectId?.trim();
    if (pid) {
      const hit = getDb().prepare('SELECT id FROM projects WHERE id = ?').get(pid) as { id: string } | undefined;
      return hit ? { id: hit.id } : { error: `项目 id 不存在：${pid}` };
    }
    const name = projectName?.trim();
    if (!name) return { error: 'projectId 或 projectName 必填' };
    const all = getDb().prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
    const hit = all.find((p) => p.name === name) ?? all.find((p) => p.name.toLowerCase() === name.toLowerCase());
    return hit ? { id: hit.id } : { error: `项目「${name}」不存在。候选：${all.slice(0, 10).map((p) => p.name).join('、')}` };
  };

  server.registerTool('mtask_import_prd', {
    title: '从 PRD 导入项目计划',
    description: '上传 PRD 文件（base64）：自动提取文本（.docx/.md/.txt/.xlsx/.csv/.pdf）→ AI 拆分 WBS 并**逐条提取可跟踪需求** → 事务创建需求项（需求跟踪矩阵行）+ 项目计划（自动关联需求）+ 可选同步生成待办任务。返回导入统计与清单摘要。',
    inputSchema: {
      projectId: z.string().optional().describe('目标项目 id（与 projectName 二选一）'),
      projectName: z.string().optional().describe('目标项目名称（与 projectId 二选一）'),
      toolId: z.string().describe('AI 模型工具 id（必填——PRD 解析需要模型）'),
      filename: z.string().describe('原始文件名（决定解析方式，如 prd.docx / prd.pdf）'),
      fileBase64: z.string().describe('文件内容的 base64（不含 data: 前缀）'),
      createTasks: z.boolean().optional().describe('是否同时把 WBS 节点转为待办任务（默认 false，便于 AI 推进执行）'),
      // T01875：撞名计划处置（同一份 PRD 重复导入的幂等口径）
      onDuplicatePlan: z.enum(['new', 'reuse']).optional().describe("项目内已有同名计划时的处置：'new'（默认）= 仍新建，但新行标题自动加「（N）」后缀区分，原行不动；'reuse' = 命中同名原行做幂等补写（只补空描述/复杂度与需求关联，只增不减），不新建、绝不改原行状态与进度"),
    },
  }, async (a) => {
    try {
      const loc = resolveProjectIdOf(a.projectId, a.projectName);
      if (!loc.id) return err(loc.error ?? '项目未指定');
      const buf = Buffer.from(a.fileBase64, 'base64');
      if (buf.length === 0) return err('fileBase64 解析为空');
      const text = await PlanService.extractPrdText(buf, a.filename);
      const parsed = await PlanService.aiParsePrd(a.toolId, text);
      // T00763：PRD 原文（提取后的 Markdown）随导入完整落库，需求行回填 prd_id
      const r = PlanService.importPrd(loc.id, { requirements: parsed.requirements, plans: parsed.drafts, createTasks: a.createTasks === true, prdMd: text, prdFilename: a.filename, onDuplicatePlan: a.onDuplicatePlan });
      const summary = {
        projectId: loc.id,
        imported: r,
        requirements: parsed.requirements.slice(0, 20),
        plans: parsed.drafts.slice(0, 20).map((d) => ({ title: d.title, durationDays: d.durationDays, reqNos: d.reqNos })),
        truncated: parsed.requirements.length > 20 || parsed.drafts.length > 20,
        coverageWarn: parsed.coverageWarn || undefined,
        uncoveredReqNos: parsed.uncoveredReqNos ?? [],
        truncatedNote: parsed.truncatedNote || undefined,
      };
      return ok(JSON.stringify(summary), summary);
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_list_matrix', {
    title: '查询需求跟踪矩阵',
    description: '按项目返回需求跟踪矩阵：每条需求（reqNo/标题/状态/原文定位）及其**关联的计划与待办任务**（含状态、是否已验证）。供 AI 核对需求覆盖与进度。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id（与 projectName 二选一）'),
      projectName: z.string().optional().describe('项目名称（与 projectId 二选一）'),
    },
  }, async (a) => {
    try {
      const loc = resolveProjectIdOf(a.projectId, a.projectName);
      if (!loc.id) return err(loc.error ?? '项目未指定');
      const rows = PlanService.listRequirements(loc.id);
      return ok(JSON.stringify({ projectId: loc.id, count: rows.length, requirements: rows }), { projectId: loc.id, count: rows.length, requirements: rows });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_matrix', {
    title: '更新需求跟踪矩阵',
    description: '维护需求跟踪矩阵：action=create（新建需求，需 projectId/projectName + title）/ update（改需求字段，需 reqId）/ delete（删需求并清理关联）/ link（调整需求与计划或待办的关联，需 reqId + kind + targetId + linked）。',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete', 'link']).describe('操作类型'),
      projectId: z.string().optional().describe('create 时使用：项目 id'),
      projectName: z.string().optional().describe('create 时使用：项目名称'),
      reqId: z.string().optional().describe('update/delete/link 时使用：需求 id（可由 mtask_list_matrix 获取）'),
      reqNo: z.string().optional().describe('create/update：需求编号（留空自动生成 REQ-xxx）'),
      title: z.string().optional().describe('create 必填 / update 可选：需求标题'),
      content: z.string().optional().describe('需求描述/原文要点'),
      sourceRef: z.string().optional().describe('PRD 原文定位（章节/段落）'),
      priority: z.enum(['low', 'normal', 'high', 'urgent', 'P0', 'P1', 'P2', 'P3', 'p0', 'p1', 'p2', 'p3']).optional()
        .describe('优先级：low|normal|high|urgent 或 P0~P3（P 档自动换算入库：P0=urgent / P1=high / P2=normal / P3=low，与用例词表统一）'),
      status: z.enum(['todo', 'doing', 'done', 'changed']).optional().describe('需求状态'),
      kind: z.enum(['plan', 'task']).optional().describe('link 时使用：关联目标类型'),
      targetId: z.string().optional().describe('link 时使用：计划或待办的任务 id'),
      linked: z.boolean().optional().describe('link 时使用：true 建立关联 / false 解除（默认 true）'),
    },
  }, async (a) => {
    try {
      // T01703：P 档 → 存储枚举换算（存储层不动，兼容旧客户端读取）；非法值原样传入由服务层报错
      const PRIO_ALIAS: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = { P0: 'urgent', P1: 'high', P2: 'normal', P3: 'low' };
      const normPrio = (p?: string): string | undefined => {
        if (!p) return p;
        const hit = PRIO_ALIAS[p.toUpperCase()];
        return hit ?? p;
      };
      if (a.action === 'create') {
        const loc = resolveProjectIdOf(a.projectId, a.projectName);
        if (!loc.id) return err(loc.error ?? '项目未指定');
        if (!a.title?.trim()) return err('create 需要 title');
        const row = PlanService.createRequirement(loc.id, {
          reqNo: a.reqNo, title: a.title, content: a.content, sourceRef: a.sourceRef, priority: normPrio(a.priority), status: a.status,
        });
        return ok(JSON.stringify(row), row);
      }
      if (!a.reqId) return err(`${a.action} 需要 reqId`);
      if (a.action === 'update') {
        const row = PlanService.updateRequirement(a.reqId, {
          title: a.title, content: a.content, reqNo: a.reqNo, sourceRef: a.sourceRef, priority: normPrio(a.priority), status: a.status,
        });
        return ok(JSON.stringify(row), row);
      }
      if (a.action === 'delete') {
        PlanService.deleteRequirement(a.reqId);
        return ok(JSON.stringify({ ok: true, deleted: a.reqId }), { ok: true, deleted: a.reqId });
      }
      // link
      if (!a.kind || !a.targetId) return err('link 需要 kind(plan|task) 与 targetId');
      PlanService.linkRequirement(a.reqId, { kind: a.kind, targetId: a.targetId, linked: a.linked !== false });
      return ok(JSON.stringify({ ok: true, reqId: a.reqId, kind: a.kind, targetId: a.targetId, linked: a.linked !== false }), { ok: true });
    } catch (e) { return err((e as Error).message); }
  });

  // ---------- T01493：测试用例（查询 / 维护），zod 枚举从 testCaseEnums 单源导入 ----------

  server.registerTool('mtask_list_testcases', {
    title: '查询测试用例',
    description: '按项目返回测试用例列表（含步骤与关联需求摘要 reqNo/reqTitle）+ 覆盖度摘要（总/已覆盖/未覆盖/覆盖率）。可按需求行 reqId、关键词 q、模块、优先级/类型/状态/执行结果筛选，orphanOnly 仅取未关联需求的孤儿用例，支持 limit/offset 分页。供 AI 核对用例覆盖与进度。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id（与 projectName 二选一）'),
      projectName: z.string().optional().describe('项目名称（与 projectId 二选一）'),
      reqId: z.string().optional().describe('可选：按需求 id（矩阵行）过滤'),
      q: z.string().optional().describe('可选：关键词（标题/模块/预期等）'),
      module: z.string().optional().describe('可选：按模块过滤'),
      priority: z.enum(CASE_PRIORITY).optional().describe('可选：优先级 P0~P3'),
      type: z.enum(CASE_TYPE).optional().describe('可选：用例类型'),
      status: z.enum(CASE_STATUS).optional().describe('可选：生命周期状态'),
      result: z.enum(CASE_RESULT).optional().describe('可选：最近执行结果'),
      orphanOnly: z.boolean().optional().describe('可选：仅返回未关联需求的孤儿用例'),
      limit: z.number().int().optional().describe('可选：分页大小（省略=200；≤0=全部）'),
      offset: z.number().int().optional().describe('可选：分页偏移'),
    },
  }, async (a) => {
    try {
      const loc = resolveProjectIdOf(a.projectId, a.projectName);
      if (!loc.id) return err(loc.error ?? '项目未指定');
      const res = TestCaseService.list({
        projectId: loc.id, reqId: a.reqId, q: a.q, module: a.module,
        priority: a.priority, type: a.type, status: a.status, result: a.result,
        orphanOnly: a.orphanOnly, limit: a.limit, offset: a.offset,
      });
      const cov = TestCaseService.coverage(loc.id);
      const summary = {
        projectId: loc.id, total: res.total, returned: res.items.length,
        coverage: { total: cov.total, covered: cov.covered, uncovered: cov.uncovered, rate: cov.rate },
      };
      return ok(JSON.stringify({ ...summary, cases: res.items }), { ...summary, cases: res.items });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_testcases', {
    title: '维护测试用例',
    description: '维护测试用例：action=create（新建，需 projectId/projectName + title，可带 reqId/steps/枚举字段）/ update（改字段，需 caseId；字符串传空串=清空）/ delete（删单条，需 caseId）/ link（挂/解需求，需 caseId + reqId，reqId 传空串或 null 解除）/ batch-patch（批量改枚举/模块/关联，需 caseIds + patch，不含 title/caseNo）。字段一律走 TestCaseService，枚举经单源校验（非法值回落默认）、写后 notifyChange(\'plans\')，落库以返回体的实际字段为准。',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete', 'link', 'batch-patch']).describe('操作类型'),
      projectId: z.string().optional().describe('create 时使用：项目 id（与 projectName 二选一）'),
      projectName: z.string().optional().describe('create 时使用：项目名称'),
      caseId: z.string().optional().describe('update/delete/link 时使用：用例 id（可由 mtask_list_testcases 获取）'),
      caseIds: z.array(z.string()).optional().describe('batch-patch 时使用：目标用例 id 数组'),
      reqId: z.string().nullable().optional().describe('create/link：关联的需求 id；link 传空串或 null 解除关联'),
      title: z.string().optional().describe('create 必填 / update 可选：用例标题'),
      caseNo: z.string().optional().describe('create/update：用例编号（留空自动 TC-xxx）'),
      module: z.string().optional().describe('模块'),
      preconditions: z.string().optional().describe('前置条件'),
      expected: z.string().optional().describe('预期结果'),
      testData: z.string().optional().describe('测试数据'),
      postconditions: z.string().optional().describe('后置条件'),
      priority: z.enum(CASE_PRIORITY).optional().describe('优先级'),
      type: z.enum(CASE_TYPE).optional().describe('用例类型'),
      method: z.enum(CASE_METHOD).optional().describe('执行方式'),
      status: z.enum(CASE_STATUS).optional().describe('生命周期状态'),
      lastResult: z.enum(CASE_RESULT).optional().describe('最近执行结果'),
      tags: z.string().optional().describe('标签'),
      steps: z.array(z.object({ action: z.string().optional(), expected: z.string().optional(), stepNo: z.number().int().optional() })).optional().describe('create/update 全量替换步骤：[{action,expected,stepNo?}]'),
      patch: z.object({
        priority: z.enum(CASE_PRIORITY).optional(), type: z.enum(CASE_TYPE).optional(), method: z.enum(CASE_METHOD).optional(),
        status: z.enum(CASE_STATUS).optional(), lastResult: z.enum(CASE_RESULT).optional(),
        module: z.string().optional(), reqId: z.string().nullable().optional(),
      }).optional().describe('batch-patch 时使用：批量改动字段'),
    },
  }, async (a) => {
    try {
      if (a.action === 'create') {
        const loc = resolveProjectIdOf(a.projectId, a.projectName);
        if (!loc.id) return err(loc.error ?? '项目未指定');
        if (!a.title?.trim()) return err('create 需要 title');
        const row = TestCaseService.create({
          projectId: loc.id, reqId: a.reqId ?? null, title: a.title, caseNo: a.caseNo, module: a.module,
          preconditions: a.preconditions, expected: a.expected, testData: a.testData, postconditions: a.postconditions,
          priority: a.priority, type: a.type, method: a.method, status: a.status, lastResult: a.lastResult,
          tags: a.tags, steps: a.steps,
        });
        return ok(JSON.stringify(row), { ...row });
      }
      if (a.action === 'batch-patch') {
        if (!Array.isArray(a.caseIds) || a.caseIds.length === 0) return err('batch-patch 需要 caseIds 数组');
        if (!a.patch) return err('batch-patch 需要 patch');
        const r = TestCaseService.batchPatch(a.caseIds, a.patch);
        return ok(JSON.stringify({ ok: true, ...r }), { ok: true, ...r });
      }
      if (!a.caseId) return err(`${a.action} 需要 caseId`);
      if (a.action === 'delete') {
        TestCaseService.remove(a.caseId);
        return ok(JSON.stringify({ ok: true, deleted: a.caseId }), { ok: true, deleted: a.caseId });
      }
      if (a.action === 'link') {
        if (a.reqId === undefined) return err('link 需要 reqId（传空串或 null 解除关联）');
        const row = TestCaseService.update(a.caseId, { reqId: a.reqId });
        return ok(JSON.stringify(row), { ...row });
      }
      // update：仅把调用方显式提供的字段并入 patch（省略=不改）
      const patch: CasePatch = {};
      if (a.title !== undefined) patch.title = a.title;
      if (a.caseNo !== undefined) patch.caseNo = a.caseNo;
      if (a.module !== undefined) patch.module = a.module;
      if (a.preconditions !== undefined) patch.preconditions = a.preconditions;
      if (a.expected !== undefined) patch.expected = a.expected;
      if (a.testData !== undefined) patch.testData = a.testData;
      if (a.postconditions !== undefined) patch.postconditions = a.postconditions;
      if (a.priority !== undefined) patch.priority = a.priority;
      if (a.type !== undefined) patch.type = a.type;
      if (a.method !== undefined) patch.method = a.method;
      if (a.status !== undefined) patch.status = a.status;
      if (a.lastResult !== undefined) patch.lastResult = a.lastResult;
      if (a.tags !== undefined) patch.tags = a.tags;
      if (a.reqId !== undefined) patch.reqId = a.reqId;
      if (a.steps !== undefined) patch.steps = a.steps;
      const row = TestCaseService.update(a.caseId, patch);
      return ok(JSON.stringify(row), { ...row });
    } catch (e) { return err((e as Error).message); }
  });

  // ---------- T00763：PRD 原文文档（查询 / 反向更新） ----------

  server.registerTool('mtask_get_prd', {
    title: '查询关联的 PRD 原文',
    description: '按任务 id/编号、计划 id 或需求 id 反查其关联的 PRD 文档完整 Markdown 原文（导入时保留）；也可按项目列出全部 PRD 文档。AI 处理待办/评估时应先调用本工具获取需求背景作为上下文。',
    inputSchema: {
      taskId: z.string().optional().describe('任务内部 id（与 taskNo 二选一）'),
      taskNo: z.string().optional().describe('任务编号（如 T00763，与 taskId 二选一）'),
      planId: z.string().optional().describe('计划条目 id'),
      reqId: z.string().optional().describe('需求 id（矩阵行）'),
      prdId: z.string().optional().describe('PRD 文档 id（直接取全文）'),
      projectId: z.string().optional().describe('按项目列出全部 PRD 文档（与 projectName 二选一；仅列表元信息不含正文）'),
      projectName: z.string().optional().describe('按项目列出全部 PRD 文档'),
    },
  }, async (a) => {
    try {
      const db = getDb();
      if (a.prdId) {
        const doc = PlanService.getPrdDoc(a.prdId);
        return ok(JSON.stringify(doc), doc);
      }
      // 任务编号 → 内部 id
      let taskId = a.taskId;
      if (!taskId && a.taskNo) {
        const row = db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(a.taskNo) as { id: string } | undefined;
        if (!row) return err(`任务不存在：${a.taskNo}`);
        taskId = row.id;
      }
      if (taskId || a.planId || a.reqId) {
        const ctx = resolvePrdContext({ taskId, planId: a.planId, requirementId: a.reqId });
        if (!ctx) return ok(JSON.stringify({ found: false, message: '该对象未关联 PRD 文档' }), { found: false });
        const doc = { ...ctx, content: PlanService.getPrdDoc(ctx.prdId).content_md };
        return ok(JSON.stringify({ found: true, ...doc }), { found: true, ...doc });
      }
      const loc = resolveProjectIdOf(a.projectId, a.projectName);
      if (!loc.id) return err('需提供 taskId/taskNo/planId/reqId/prdId 之一，或 projectId/projectName 列出项目文档');
      const docs = PlanService.listPrdDocs(loc.id);
      return ok(JSON.stringify({ projectId: loc.id, count: docs.length, docs }), { projectId: loc.id, count: docs.length, docs });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_prd', {
    title: '反向更新 PRD 原文',
    description: '把修订后的 PRD 内容（完整 Markdown）反向覆盖到指定 PRD 文档（全量覆盖，非增量）。用于 AI 依据实施结论修订需求文档等场景。',
    inputSchema: {
      prdId: z.string().describe('PRD 文档 id（可由 mtask_get_prd 获取）'),
      contentMd: z.string().describe('修订后的完整 Markdown 原文（全量覆盖，不能为空）'),
      filename: z.string().optional().describe('可选：更新文档名'),
    },
  }, async (a) => {
    try {
      const doc = PlanService.updatePrdDoc(a.prdId, { contentMd: a.contentMd, filename: a.filename });
      const contentMd: string = (doc.content_md ?? '') as string;
      return ok(JSON.stringify({ ok: true, id: doc.id, updated_at: doc.updated_at, content_chars: contentMd.length }), { ok: true, id: doc.id });
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
      // T00566 二轮：状态**自动驱动**——回传处理结果 = 处理完成待用户查看（unread）
      TaskService.setAiState(target.id, 'unread');
      // T00577：派生单整合——本任务若为派生单（derived_from 有值），把结论同时追加回原任务处理结果，
      // 让原任务成为唯一信息汇聚点，避免派生单越积越多
      const row = getDb().prepare('SELECT derived_from FROM tasks WHERE id = ?').get(target.id) as { derived_from: string | null } | undefined;
      const originNo = row?.derived_from?.trim();
      let merged = '';
      if (originNo) {
        const origin = TaskService.findByNo(originNo);
        if (origin) {
          const stamp = new Date().toISOString().slice(0, 10);
          const originText = (origin.handle_result ?? '').trim();
          const prefix = originText ? originText + '\n\n' : '';
          const mergedText = `${prefix}---
【派生单 ${task.task_no ?? target.id} 处理结果 ${stamp}】
${a.result}`;
          TaskService.update(origin.id, { handle_result: mergedText });
          // T00713：结论归并进原单后置原单 unread——用户在列表上能看到「原单有新内容待查看」，
          // 否则回流结论只躺在处理结果里无人知晓
          TaskService.setAiState(origin.id, 'unread');
          merged = `；并已整合回原任务 ${originNo}`;
        }
      }
      return ok(`已同步处理结果到任务 ${task.task_no ?? target.id}${merged}`, { task, mergedTo: originNo || undefined });
    } catch (e) { return err((e as Error).message); }
  });

  // T00566：AI 处理状态回写——AIAgent 生命周期专用（running 处理中 / failed 中断失败 / unread 完成待查看）
  // 状态机：running → failed | unread；failed → running（重试）；unread →（用户查看）→ ''（已读隐藏）
  server.registerTool('mtask_write_task_status', {
    title: '回写任务 AI 处理状态',
    description: '按 id 或任务编号 taskNo 回写任务的 AI 处理状态动画（任务编号前显示）。state=running 表示 Agent 开始处理（旋转动画）；state=failed 表示处理中断/异常（红色警示）；state=unread 表示处理完成等待用户查看（未读圆点）；用户查看后前端自动清空（已读隐藏）。',
    inputSchema: {
      taskNo: z.string().optional().describe('任务编号（如 T00001），与 id 二选一'),
      id: z.string().optional().describe('任务内部 id，与 taskNo 二选一'),
      state: z.enum(['running', 'failed', 'unread']).describe('目标状态：running=开始处理；failed=处理中断/异常；unread=处理完成待查看'),
    },
  }, async (a) => {
    try {
      const target = resolveTask(a);
      if (!target) return err(a.id || a.taskNo ? `任务不存在：${a.id || a.taskNo}` : taskLocateError());
      const task = TaskService.setAiState(target.id, a.state);
      if (!task) return err('任务不存在');
      return ok(JSON.stringify({ id: task.id, task_no: task.task_no, ai_state: task.ai_state }), { task });
    } catch (e) {
      return err((e as Error).message);
    }
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

  // ---------------- AI 编排大脑（观测 / 监督，T01269 起） ----------------
  // T01269（PRD FR-1.2）：外部平台执行会话心跳上报——观测层入口，仅观测不自动动作（P0）
  server.registerTool('mtask_report_progress', {
    title: '上报执行会话进度',
    description: '外部 AI 平台（WorkBuddy/Trae/中继）执行任务期间周期调用（建议 30~60s），上报平台会话标识、关联任务与进度/阶段并刷新会话心跳。MTask 据此在「执行会话」面板展示存活与进度、判定停滞。task_id 可传任务内部 id 或任务编号（Txxxxx）。pct>=100 或 done=true 表示本轮完成（会话置 done、任务置完成待查看）；failed=true 表示本轮执行失败（会话置 failed，面板显示「失败」，失败原因写 phase）——done 与 failed 同传时以 done 为准。',
    inputSchema: {
      platform: z.string().describe("平台标识，如 'workbuddy' | 'trae' | 'relay:xxx'。大小写/空白不敏感（内部统一归一为小写）"),
      session_id: z.string().describe('平台侧会话标识'),
      task_id: z.string().describe('关联任务：任务内部 id 或任务编号（Txxxxx）'),
      phase: z.string().optional().describe('当前阶段描述（如「读取代码」「执行测试」）'),
      pct: z.number().optional().describe('进度百分比 0~100'),
      note: z.string().optional().describe('附注（可选）'),
      done: z.boolean().optional().describe('平台显式声明本轮执行完成'),
      failed: z.boolean().optional().describe('平台显式声明本轮执行失败（T01356，PRD §8）：会话置 failed，面板显示「失败」；失败原因请写入 phase。与 done 互斥，同传时以 done 为准'),
    },
  }, async (a) => {
    try {
      const r = ExecSessionService.reportProgress({
        platform: a.platform,
        sessionId: a.session_id,
        taskRef: a.task_id,
        phase: a.phase,
        pct: a.pct,
        note: a.note,
        done: a.done,
        failed: a.failed,
      });
      return ok(json(r), { ...r });
    } catch (e) { return err((e as Error).message); }
  });

  // T01280（PRD FR-3.1 / §6.1）：外部平台拉取就绪待办——执行层入口（拉取式）
  server.registerTool('mtask_list_ready_tasks', {
    title: '拉取就绪任务',
    description: '外部 AI 平台拉取可执行的就绪待办。仅返回：未被认领（ai_state 为空）、status=todo、monitor_ready=1（Supervisor 已判定无未完成前置依赖）、且平台偏好匹配（monitor_preferred_platform 为空或等于 platform）的任务，并按优先级排序。注意：monitor_ready 由监督器 tick 标记，需 supervisor.enabled=1 才会产生就绪任务。',
    inputSchema: {
      platform: z.string().optional().describe("请求方平台标识（如 'workbuddy' | 'trae'）；只返回无平台偏好或偏好等于该值的任务，缺省则不按平台过滤。大小写/空白不敏感（内部统一归一为小写）"),
      limit: z.number().optional().describe('返回条数上限（默认 20，上限 200）'),
    },
  }, async (a) => {
    try {
      const tasks = TaskService.listMonitorReady({ platform: a.platform?.trim() || undefined, limit: a.limit });
      return ok(json(tasks), { tasks });
    } catch (e) { return err((e as Error).message); }
  });

  // T01281（PRD FR-3.2 / §6.1）：原子认领——多平台拉到同一任务时只有一个能认领成功，防重复执行
  server.registerTool('mtask_claim_task', {
    title: '原子认领任务',
    description: '外部 AI 平台从 mtask_list_ready_tasks 拿到任务后，先调本工具认领再开始执行。事务内校验任务未被认领（ai_state 为空）后原子置 ai_state=running、绑定执行会话并清零就绪标记，从而防止多平台抢同一任务导致重复执行。已被其他平台抢走（conflict=true, reason=already_claimed）、或任务非待办/已归档（reason=not_ready）时认领失败，应换下一个任务而不是重试。task_id 可传任务内部 id 或任务编号（Txxxxx）。',
    inputSchema: {
      task_id: z.string().describe('要认领的任务：任务内部 id 或任务编号（Txxxxx）'),
      platform: z.string().describe("认领方平台标识，如 'workbuddy' | 'trae' | 'relay:xxx'。大小写/空白不敏感（内部统一归一为小写）"),
      session_id: z.string().describe('认领方平台侧会话标识（后续 mtask_report_progress 用同一标识续上报）'),
    },
  }, async (a) => {
    try {
      const r = ExecSessionService.claimTask({ taskRef: a.task_id, platform: a.platform, sessionId: a.session_id });
      if (!r.claimed) {
        // PRD 契约「返回成功/冲突(409)」：MCP 无 HTTP 状态码，用 isError + conflict 标记表达冲突语义
        let why: string;
        if (r.reason === 'not_found') {
          why = '任务不存在';
        } else if (r.reason === 'already_claimed') {
          why = `任务已被认领（ai_state=${r.aiState || '非空'}）`;
        } else {
          why = '任务不是可执行的待办（非 todo 或已归档）';
        }
        const taskNoSuffix = r.taskNo ? `（${r.taskNo}）` : '';
        return {
          content: [{ type: 'text', text: `认领冲突：${why}${taskNoSuffix}` }],
          structuredContent: { conflict: true, ...r },
          isError: true,
        };
      }
      return ok(json(r), { conflict: false, ...r });
    } catch (e) { return err((e as Error).message); }
  });

  // T01286（PRD FR-5.2 / §6.1）：监督状态查询——外部平台在拉取任务前先判断监督器是否开启、当前是否可执行
  server.registerTool('mtask_supervisor_status', {
    title: '查询监督状态',
    description: '查询 AI 监督器的当前运行态：熔断开关（enabled，关闭时不产生就绪任务，拉取接口会返空）、tick 周期与下次 tick 时刻、token 预算占用、活跃/停滞会话、以及最近一轮决策的动作与所用模型。只读接口，不触发决策。',
  }, async () => {
    try {
      const s = SupervisorService.getStatus();
      return ok(json(s), { ...s });
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
      const bundle = await exportBundle();
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

  // ---------------- 估算视图（T02044 · E10：PRD-估算视图与工作量评估导出 §8 三枚工具） ----------------
  // 分层与 `mtask_list_plans` 一致：三点校验、PERT 汇总、导出流水线全部复用既有导出
  // （`routes/estimates.ts` 的 `estimatesSnapshot` / `buildEstimateArtifact`、`EstimateService`），
  // MCP 层只做**定位参数翻译**（projectName / taskNo → id）与**响应体量控制**（默认精简 + 显式 full）。
  // 体量口径沿用 T01490 的实测教训：给 LLM 的 `content[0].text` 恒为精简摘要，
  // 全量数据只进 `structuredContent`——两处都塞全文会让 SSE 帧翻倍、大项目直接被截断。
  const resolveEstimateProject = (a: { projectId?: string; projectName?: string }): { id: string; name: string } => {
    const db = getDb();
    const id = (a.projectId ?? '').trim();
    const name = (a.projectName ?? '').trim();
    if (id) {
      const row = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id) as { id: string; name: string } | undefined;
      if (!row) throw new Error(`项目不存在：${id}`); // 外部调用方拼错 id 必须报错，不能出一份空报价件
      return row;
    }
    if (!name) throw new Error('projectId 或 projectName 必填');
    const row = db.prepare('SELECT id, name FROM projects WHERE name = ?').get(name) as { id: string; name: string } | undefined;
    if (!row) throw new Error(`项目不存在：${name}`);
    return row;
  };

  /**
   * taskNo → 计划行。权威 linkage 只有一处：`plan_tasks.linked_task_id`（`schema.ts:196`，
   * 与「共享 req_ids 的软关联」是两套机制，`PlanService.ts:499` 已注明——估算是按 planId 记账的，
   * 这里只认硬关联，多条命中时把消歧责任交回调用方，不猜。
   */
  const planByTaskNo = (taskNo: string): { planId: string; projectId: string; planTitle: string } => {
    const rows = getDb()
      .prepare(
        `SELECT pt.id AS planId, pt.project_id AS projectId, pt.title AS planTitle
           FROM plan_tasks pt JOIN tasks t ON t.id = pt.linked_task_id
          WHERE t.task_no = ? AND t.archived = 0 AND COALESCE(pt.archived, 0) = 0`,
      )
      .all(taskNo) as Array<{ planId: string; projectId: string; planTitle: string }>;
    if (rows.length === 0) throw new Error(`待办 ${taskNo} 没有关联计划行（plan_tasks.linked_task_id 为空），请改传 planId`);
    if (rows.length > 1) {
      throw new Error(`待办 ${taskNo} 关联了 ${rows.length} 条计划（${rows.map((r) => r.planTitle).join(' / ')}），请改传 planId 指明哪一条`);
    }
    return rows[0];
  };

  const r3 = (v: number): number => Math.round(v * 1000) / 1000;

  /** 精简摘要（也是 full 模式给 LLM 的那段文本）：字段名与 REST `GET /api/estimates` 的 summary 同源 */
  function estimateBriefView(s: ReturnType<typeof estimatesSnapshot>, projectName: string) {
    const su = s.summary;
    return {
      projectName,
      totals: {
        directManDays: r3(su.directManDays.expected),
        idealManMonths: r3(su.idealManMonths.expected),
        actualManMonths: r3(su.actualManMonths.expected),
        coefSum: r3(su.coefSum),
        sigmaTotal: r3(su.sigmaTotal),
      },
      quote: {
        p50ManDays: r3(su.quote.p50ManDays),
        p84ManDays: r3(su.quote.p84ManDays),
        p50ManMonth: r3(su.quote.p50ManMonth),
        p84ManMonth: r3(su.quote.p84ManMonth),
      },
      phases: su.phases
        .filter((p) => p.rowCount > 0)
        .map((p) => ({
          phase: p.phase,
          label: ESTIMATE_META.phaseLabels[p.phase],
          manDays: r3(p.expected),
          idealManMonth: r3(p.idealManMonth),
          ratio: r3(p.ratio),
          rowCount: p.rowCount,
        })),
      coefs: su.coefRows.map((c) => ({ key: c.key, label: c.label, value: r3(c.expected) })),
      checks: {
        sumRatio: r3(su.ratioCheck.sumRatio),
        deviationPct: r3(su.ratioCheck.deviationPct),
        danger: su.ratioCheck.danger,
        coverage: s.checks.coverage,
        estimated: s.checks.estimated,
        visiblePlans: s.checks.visiblePlans,
        detached: s.checks.detached,
      },
      params: {
        manDaysPerManMonth: s.params.config.manDaysPerManMonth,
        hoursPerManDay: s.params.config.hoursPerManDay,
        caseWeightK: s.params.caseWeightK,
      },
    };
  }

  server.registerTool('mtask_get_estimates', {
    title: '读取估算汇总（可选明细）',
    description: '读取某项目的估算数据：三点加权后的 E 人天、理想/实际预估人月、阶段构成、报价区间 P50/P84、调节系数与自检结果。**默认精简模式**（阶段汇总 + 计数，不含逐行明细，避免响应被截断 T01490）；full=true 才附 items 明细行（每条估算的 planId/planTitle/phase/optimistic/likely/pessimistic/source/note）。所有数字由服务端估算引擎产出，本工具不做二次计算；includeArchived 与 REST 同口径——只影响 items，不影响汇总（§3.1「归档行不进 Σ」）。外部 Agent 出报价取 actualManMonths.expected（= 理想人月 ×(1+Σ系数)），对外报价口径看 quote.p84*。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，与 projectName 二选一'),
      projectName: z.string().optional().describe('项目名称，按名称解析'),
      full: z.boolean().optional().describe('true=附逐行明细 items；缺省为精简模式（只有汇总与计数）'),
      includeArchived: z.boolean().optional().describe('明细是否包含已归档计划的估算行（默认否；不影响汇总数值）'),
    },
  }, async (a) => {
    try {
      const proj = resolveEstimateProject(a);
      const snap = estimatesSnapshot(proj.id, { includeArchived: a.includeArchived === true });
      const brief = estimateBriefView(snap, proj.name);
      if (!a.full) return ok(json(brief), brief);
      // full：text 仍是精简摘要（LLM 侧不必读全文），items/params/meta 进 structuredContent
      return ok(json(brief), {
        ...brief,
        items: snap.items,
        meta: snap.meta,
        params: snap.params,
        detailRows: snap.items.length,
      });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_update_estimates', {
    title: '回写三点估算',
    description: '按 planId 或 taskNo 回写一条计划的三点估算（乐观/最可能/悲观，人天）。校验 O≤M≤P，不合格直接报错、不落库；写入走 `EstimateService.upsert`，与界面行内录入同一条通道（阶段、单位、updatedAt 与 §4.3 的 E/σ 由服务端重算，本工具不回写计算结果）。定位优先级：planId 优先；只给 taskNo 时按 `plan_tasks.linked_task_id` 反查计划，反查不到或命中多条会报错并要求改传 planId。source 缺省 `manual`——与 REST PATCH 同口径（人工/代理显式录入即视为已复核）；若只是按规则批量补数、不希望计入复核率，显式传 rule 或 default。项目定位可靠 planId 单独给出（由计划行反查项目），也可用 projectId/projectName 并做一致性校验。',
    inputSchema: {
      planId: z.string().optional().describe('计划任务 id（估算行的记账主键）'),
      taskNo: z.string().optional().describe('待办编号（如 T00001），反查其关联计划行'),
      projectId: z.string().optional().describe('项目 id；给了就与计划行所属项目比对'),
      projectName: z.string().optional().describe('项目名，用于解析 projectId'),
      optimistic: z.number().describe('乐观值（人天）'),
      likely: z.number().describe('最可能值（人天）'),
      pessimistic: z.number().describe('悲观值（人天）'),
      phase: z.enum(ESTIMATE_PHASES).optional().describe('阶段；缺省沿用原值，新行按标题推断'),
      source: z.enum(ESTIMATE_SOURCES).optional().describe('来源标记，缺省 manual'),
      note: z.string().optional().describe('备注'),
    },
    annotations: { destructiveHint: false },
  }, async (a) => {
    try {
      const planId = (a.planId ?? '').trim();
      const taskNo = (a.taskNo ?? '').trim();
      let resolved = { planId, projectId: '' };
      let planTitle = '';
      if (planId) {
        const row = getDb()
          .prepare('SELECT id, project_id AS projectId, title FROM plan_tasks WHERE id = ? AND COALESCE(archived, 0) = 0')
          .get(planId) as { projectId: string; title: string } | undefined;
        if (!row) throw new Error(`计划不存在或已归档：${planId}`);
        resolved = { planId, projectId: row.projectId };
        planTitle = row.title;
      } else if (taskNo) {
        const p = planByTaskNo(taskNo);
        resolved = { planId: p.planId, projectId: p.projectId };
        planTitle = p.planTitle;
      } else {
        return err('planId 与 taskNo 至少提供一个');
      }
      if (a.projectId?.trim() || a.projectName?.trim()) {
        const proj = resolveEstimateProject(a);
        if (proj.id !== resolved.projectId) {
          throw new Error(`项目与计划不匹配：计划属于 ${resolved.projectId}，请求里给的是 ${proj.id}（${proj.name}）`);
        }
      }
      const item = EstimateService.upsert(resolved.projectId, resolved.planId, {
        optimistic: a.optimistic,
        likely: a.likely,
        pessimistic: a.pessimistic,
        phase: a.phase,
        source: a.source ?? 'manual',
        note: a.note,
      });
      return ok(json({ planId: item.plan_id, planTitle, expected: r3(expected({ optimistic: item.optimistic, likely: item.likely, pessimistic: item.pessimistic })), sigma: r3(sigma({ optimistic: item.optimistic, likely: item.likely, pessimistic: item.pessimistic })) }), {
        projectId: resolved.projectId,
        planId: item.plan_id,
        planTitle,
        item,
      });
    } catch (e) { return err((e as Error).message); }
  });

  server.registerTool('mtask_export_estimate_workload', {
    title: '导出工作量评估件',
    description: '生成《项目工作量评估》交付件并返回 base64。与界面「导出 Excel / 导出 PDF」走**同一条流水线**（`buildEstimateArtifact`）：同一份行落位与汇总、同一个件名口径、每次成功导出都写一条快照并回 snapshotId，因此外部 Agent 出的件与用户在面板上下载的是同一份数。format=xlsx 是正式交付（严格复刻客户模板、公式与缓存值双轨）；format=pdf 是汇报/预览件（裁决 D4，中文依赖系统黑体）。audience=client 时脱敏发生在服务端组装阶段：系数分项、σ/置信区间、备注三条、附加 sheet 名都不出现在件里，报价数不变。scope/phases/audience 的词表校验与 REST 一致，未知值直接报错而不是忽略。base64 是文件正文，调用方应直接落盘，不要读进上下文。',
    inputSchema: {
      projectId: z.string().optional().describe('项目 id，与 projectName 二选一'),
      projectName: z.string().optional().describe('项目名称，按名称解析'),
      format: z.enum(ESTIMATE_ARTIFACT_FORMATS).describe('交付格式：xlsx=正式交付件 / pdf=预览件'),
      audience: z.string().optional().describe("internal（默认）/ client；客户版按服务端脱敏"),
      scope: z.string().optional().describe("all（默认）/ estimated_only：只导已估算行"),
      phases: z.string().optional().describe('阶段筛选，逗号分隔（req,design,dev,impl,common,onsite）；缺省全部六阶段'),
    },
  }, async (a) => {
    try {
      const proj = resolveEstimateProject(a);
      const artifact = await buildEstimateArtifact(proj.id, a.format, {
        audience: parseAudience(a.audience),
        scope: parseScope(a.scope),
        phases: parsePhases(a.phases),
      });
      const su = artifact.layout.summary;
      return ok(
        json({
          filename: artifact.filename,
          format: a.format,
          size: artifact.buffer.length,
          snapshotId: artifact.snapshotId,
          actualManMonths: r3(su.actualManMonths.expected),
          directManDays: r3(su.directManDays.expected),
          unreviewed: artifact.layout.unreviewed,
        }),
        {
          projectId: proj.id,
          projectName: proj.name,
          filename: artifact.filename,
          format: a.format,
          audience: artifact.audience,
          scope: artifact.scope,
          size: artifact.buffer.length,
          base64: artifact.buffer.toString('base64'),
          snapshotId: artifact.snapshotId,
          unreviewed: artifact.layout.unreviewed,
          milestoneSkipped: artifact.layout.milestoneSkipped,
          actualManMonths: r3(su.actualManMonths.expected),
        },
      );
    } catch (e) { return err((e as Error).message); }
  });

  return server;
}