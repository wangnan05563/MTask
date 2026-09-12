import { getDb } from '../db/connection';
import { ConfigService } from './ConfigService';
import { QueueService, type QueueJobRow } from './QueueService';
import { TaskService } from './TaskService';
import { logService } from './LogService';
import { v4 as uuid } from 'uuid';
import { getAdapter } from '../adapters';
import type { StreamResult, SubmitResult, PollResult } from '../adapters/types';

/** 模型未配置时的统一提示，保持与产品语境一致的表达 */
const MODEL_UNCONFIGURED = '所选模型未配置，请先在「模型管理」为该工具填写默认模型';

/** 取运行时配置并校验模型已配置；未配置则抛错，由上层转成明确提示（避免静默 fallback 到硬编码模型） */
function runtimeWithModel(toolId: string) {
  const { type, config } = ConfigService.getRuntimeConfig(toolId);
  if (!config.model) throw new Error(MODEL_UNCONFIGURED);
  return { type, config };
}

/** AI 工具名缓存查询（用量记录用） */
function toolNameOf(toolId: string): string {
  try {
    const r = getDb().prepare('SELECT name FROM ai_tools WHERE id = ?').get(toolId) as { name: string } | undefined;
    return r?.name ?? toolId;
  } catch { return toolId; }
}

/** AI 用量记录（T00448 / PRD AI-1）：每次模型调用落一行，供「模型」页用量面板聚合展示 */
function recordUsage(
  kind: string,
  toolId: string,
  model: string | undefined,
  ok: boolean,
  startedAt: number,
  contentChars = 0,
  error?: string,
): void {
  try {
    getDb().prepare(
      `INSERT INTO ai_usage (id, tool_id, tool_name, model, kind, ok, duration_ms, content_chars, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), toolId, toolNameOf(toolId), model ?? '', kind, ok ? 1 : 0, Date.now() - startedAt, contentChars, (error ?? '').slice(0, 300) || null, new Date().toISOString());
  } catch { /* 用量记录失败不影响主流程 */ }
}

/**
 * 剥离优化结果里的“任务提示词”类文档级标题行。
 * 这类标题一旦随结果回填为任务描述，后续发给 AI 执行时可能被误判为“提示词优化”任务，
 * 因此这里做确定性兜底去除（双保险，不依赖模型是否遵守约束）。
 */
function stripPromptHeading(md: string): string {
  return md
    .split('\n')
    .filter((line) => {
      const m = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (!m) return true; // 非标题行保留
      const text = m[1].trim();
      // 仅去掉“任务 / 描述”类文档标题（含“提示词”或“任务描述/标题”等元标记），
      // 保留“目标 / 输入 / 约束”等作为正文结构的小节标题。
      return !/^任务.*(提示词|描述|标题)/.test(text) && !/提示词优化/.test(text);
    })
    .join('\n')
    .trim();
}

/**
 * 剥离模型输出里的思考过程块。
 * 部分思考型模型会在 content 里附带“内心推理”，常包裹在 思考/蒂 response-delimited 标记内，
 * 若直接回填标题会污染标题输入框，因此做确定性兜底去除（不依赖模型是否遵守“只输出标题”的约束）。
 */
function stripThinking(text: string): string {
  // 依次剔除常见思考分界标记的内层（支持 中文/英文 与 反引号 变体），提纯后剩正文
  // 注：以下均为跨度未知内容的全局正则替换，String#replaceAll 只能按字面字符串替换无法表达通配，属 S7781 误报
  return text
    .replace(/\s*```\s*(?:thinking|reasoning|thought)\s*[\s\S]*?```\s*/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .trim();
}

/**
 * FR2 协助整理 与 FR4 队列分发的 AI 调用层。
 * 梳理结果回填 ai_summary（用户确认后保存）；分发结果仅保存文本（待人工合并）。
 */
export const AIService = {
  /**
   * FR2.1/2.2 单条或批量梳理：调用指定（默认整理）工具，产出结构化文本。
   * 骨架阶段真实网络调用由适配器实现，本服务只负责组装上下文与回填。
   */
  async organize(taskIds: string[], toolId: string): Promise<Record<string, string>> {
    const db = getDb();
    const startedAt = Date.now();
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    const results: Record<string, string> = {};
    for (const taskId of taskIds) {
      const task = TaskService.getById(taskId);
      if (!task) continue;
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(task.project_id) as { name: string } | undefined;
      const result = await adapter.send(
        {
          taskId: task.id,
          title: task.title,
          description: task.description,
          projectName: project?.name ?? '',
        },
        config,
      );
      if (result.ok && result.content) results[taskId] = result.content;
      recordUsage('organize', toolId, config.model, result.ok, startedAt, result.content?.length ?? 0, result.error);
    }
    return results;
  },

  /**
   * 提示词优化：将任务的标题与描述改写为一则清晰、结构化的任务提示词。
   * 使用通用单轮对话 chat，不经过 FR2 的固定整理指令。
   */
  async optimizeText(title: string, description: string, toolId: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    // 记录 AI 使用日志（供日志菜单按 source=ai 筛选排错）：记录工具/模型/启始，便于对应用时与结果
    const startedAt = Date.now();
    logService.log('INFO', 'ai', `[提示词优化] tool=${toolId} type=${type} model=${config.model ?? ''}`);
    const system = [
      '你是 MTask 的提示词优化专家。给定一个任务的标题与描述，将其优化为一则清晰、具体、结构化、可直接交由大模型或他人执行的任务提示词。',
      '要求：',
      '1. 保留原意与全部关键信息，不虚构不删改事实',
      '2. 明确定义目标、输入、约束、期望输出，缺失的地方基于上下文给出合理推断',
      '3. 使用 Markdown 分节组织，语言贴合原文语境',
      // 显式锁定输出语言：LLM 默认跟随输入语言输出，输入含繁体时会连带输出繁体，必须在指令层面强制简体
      '4. 无论输入是繁体还是简体，最终输出必须统一使用简体中文（简体字），严禁出现任何繁体字',
      '5. 只输出优化后的提示词文本，不要任何前置说明或寒暄',
      '6. 不要输出“任务提示词 / 任务描述 / 任务标题”这类文档级标题作为开头，直接从具体内容小节开始（如“目标”“步骤”“约束”），避免被误识别为提示词优化任务',
    ].join('\n');
    const user = [
      title ? `【任务标题】${title}` : '',
      description ? `【任务描述】${description}` : '',
    ].filter(Boolean).join('\n');
    const res = await adapter.chat(system, user, config);
    // 兜底剥离文档级标题，确保回填为任务描述后不会被误判成提示词任务
    if (res.ok && res.content) res.content = stripPromptHeading(res.content);
    const cost = Date.now() - startedAt;
    if (res.ok) logService.log('INFO', 'ai', `[提示词优化] 成功 耗时=${cost}ms`);
    else logService.log('ERROR', 'ai', `[提示词优化] 失败 耗时=${cost}ms ${res.error ?? ''}`);
    recordUsage('optimize', toolId, config.model, res.ok, startedAt, res.content?.length ?? 0, res.error);
    return res;
  },

  /**
   * 标题美化：将任务标题润色为一则语义清晰、表达规范、简洁得体的标题。
   * 仅优化语言表达，保留原意与全部关键信息，不虚构不删改事实。
   */
  async beautifyTitle(title: string, toolId: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    const startedAt = Date.now();
    const system = [
      '你是 MTask 的标题美化专家。给定一条任务标题，将其润色为一则语义清晰、表达规范、简洁得体的任务标题。',
      '要求：',
      '1. 保留原意与全部关键信息，不虚构、不删改事实',
      '2. 只输出润色后的标题文本（单行且不超过 50 字），不要任何解释、序号、引号或 Markdown 标记',
      // 与 optimizeText 同口径锁定简体：标题可能来自繁体输入，需显式要求输出简体
      '3. 输出统一使用简体中文（简体字），严禁任何繁体字',
    ].join('\n');
    const res = await adapter.chat(system, `【任务标题】${title}`, config);
    // 先剥离思考过程（部分思考型模型会附带内心推理），再折叠空白为单行干净标题，
    // 确保回填标题输入框时不会污染（双保险，不依赖模型是否遵守“只输出标题”约束）
    if (res.ok && res.content) res.content = stripThinking(res.content).replaceAll(/\s+/g, ' ').trim();
    recordUsage('beautify', toolId, config.model, res.ok, startedAt, res.content?.length ?? 0, res.error);
    return res;
  },

  /**
   * 通用单轮对话：供「AI 控制台」等自由问答场景使用（system + user 单条文本）。
   * 不做固定整理指令，交由调用方构造 system 上下文。
   */
  async ask(
    toolId: string,
    system: string,
    user: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; content?: string; error?: string }> {
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    // 长耗时任务（如 AI 周报洞察生成）由调用方显式传入更大的超时，覆盖该工具的默认 timeoutMs，避免中途被掐断
    const effective = timeoutMs == null ? config : { ...config, timeoutMs };
    const startedAt = Date.now();
    const res = await adapter.chat(system, user, effective);
    recordUsage('ask', toolId, config.model, res.ok, startedAt, res.content?.length ?? 0, res.error);
    return res;
  },

  /**
   * 流式通用单轮对话：逐文本增量回调（供 AI 周报 SSE 实时透传），收敛后返回完整结果。
   * 供 ReportService 在生成过程中将洞察内容逐步推送给前端控制台。
   */
  async askStream(
    toolId: string,
    system: string,
    user: string,
    onDelta: (text: string) => void,
    timeoutMs?: number,
  ): Promise<StreamResult> {
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    // 长耗时流式调用同样由调用方传入更大的超时，避免中途被掐断
    const effective = timeoutMs == null ? config : { ...config, timeoutMs };
    const startedAt = Date.now();
    let chars = 0;
    const wrapped = (text: string) => { chars += text.length; onDelta(text); };
    const res = await adapter.chatStream(system, user, effective, wrapped);
    recordUsage('stream', toolId, config.model, res.ok, startedAt, chars, res.error);
    return res;
  },

  /**
   * 智能分类：根据任务标题从候选分类中匹配最贴切的一项，返回其 id。
   * 供「任务分类下拉」的默认启用智能分类功能使用；无合适分类返回 null。
   */
  async classifyCategory(
    title: string,
    categories: { id: string; name: string }[],
    toolId: string,
  ): Promise<{ ok: boolean; content?: string; categoryId?: string | null; priority?: 'urgent' | 'high' | 'normal' | 'low' | null; error?: string }> {
    if (!categories.length) return { ok: true, categoryId: null };
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    const startedAt = Date.now();
    const system =
      '你是任务智能分类助手。给定一个任务标题和一组候选分类名，选出与标题主题最贴切的一个分类名作为该任务的类型，并按紧急重要程度给出优先级标注（U=极高、H=高、N=普通、L=低）。只输出一行：分类名|优先级字母（如：开发|H），不加任何解释；若分类都不合适，只输出 NONE|N。';
    const user = `候选分类：${categories.map((c) => c.name).join('、')}\n任务标题：${title}`;
    const res = await adapter.chat(system, user, config);
    if (!res.ok) { recordUsage('classify', toolId, config.model, false, startedAt, 0, res.error); return { ok: false, error: res.error }; }
    const raw = (res.content ?? '').trim();
    // T00473：解析「分类名|优先级」；无 | 时兼容旧格式（仅分类名，优先级为 null 不写回）
    const sep = raw.lastIndexOf('|');
    const out = sep >= 0 ? raw.slice(0, sep).trim() : raw;
    const PRIORITY_MAP: Record<string, 'urgent' | 'high' | 'normal' | 'low'> = { U: 'urgent', H: 'high', N: 'normal', L: 'low' };
    const pLetter = sep >= 0 ? raw.slice(sep + 1).trim().toUpperCase() : '';
    const priority = PRIORITY_MAP[pLetter] ?? null;
    // 精确匹配优先；无精确命中时按「最长名称包含」兜底，避免分类名互为子串（如“开发/开发优化”）误配到较短分类
    const hit =
      categories.find((c) => c.name.trim() === out) ??
      [...categories].sort((a, b) => b.name.length - a.name.length).find((c) => out.includes(c.name));
    recordUsage('classify', toolId, config.model, true, startedAt, res.content?.length ?? 0);
    return { ok: true, content: res.content, categoryId: hit ? hit.id : null, priority };
  },

  /** T00472：计划条目 AI 评估——输出简短评估（可行性/工期合理性/风险与建议），≤60 字 */
  async evaluatePlan(
    plan: { title: string; duration_days: number; progress: number; assignee?: string | null },
    toolId: string,
  ): Promise<{ ok: boolean; evaluation?: string; error?: string }> {
    const { type, config } = runtimeWithModel(toolId);
    const adapter = getAdapter(type);
    const startedAt = Date.now();
    const system =
      '你是项目计划评审助手。对给定的计划任务条目给出简短评估：工期是否合理、当前进度是否匹配、主要风险与一条建议。只输出评估正文，不超过60字，不加标题或编号。';
    const user = `任务：${plan.title}
工期（工作日）：${plan.duration_days}
进度：${plan.progress}%
负责人：${plan.assignee || '未指派'}`;
    const res = await adapter.chat(system, user, config);
    if (!res.ok) { recordUsage('plan-evaluate', toolId, config.model, false, startedAt, 0, res.error); return { ok: false, error: res.error }; }
    recordUsage('plan-evaluate', toolId, config.model, true, startedAt, res.content?.length ?? 0);
    return { ok: true, evaluation: (res.content ?? '').trim() };
  },

  /** 供 QueueService.sendAll 使用：将单个 Job 发送到其绑定的 AI 工具 */
  buildSender() {
    return async (job: QueueJobRow) => {
      const db = getDb();
      // 队列发送同样校验模型已配置，避免未配置工具静默失败（统一走 MODEL_UNCONFIGURED 提示）
      const { type, config } = runtimeWithModel(job.tool_id);
      const adapter = getAdapter(type);
      const task = TaskService.getById(job.task_id);
      if (!task) return { ok: false, error: '任务不存在' };
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(task.project_id) as { name: string } | undefined;
      const context = {
        taskId: task.id,
        title: task.title,
        description: task.description,
        aiSummary: task.ai_summary ?? undefined,
        projectName: project?.name ?? '',
      };
      // 发送前固化上下文快照（FR4.4）
      db.prepare('UPDATE queue_jobs SET request_payload = ? WHERE id = ?')
        .run(QueueService.snapshotTaskContext(task, project?.name ?? ''), job.id);
      const result = await adapter.send(context, config);
      return { ok: result.ok, content: result.content, error: result.error };
    };
  },

  /** 供 QueueService.submitAll 使用：异步提交单个 Job；同步工具自动回退 send（保证零回归） */
  buildSubmitter() {
    return async (job: QueueJobRow): Promise<SubmitResult> => {
      const db = getDb();
      const task = TaskService.getById(job.task_id);
      if (!task) return { ok: false, error: '任务不存在' };
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(task.project_id) as { name: string } | undefined;
      const context = {
        taskId: task.id,
        title: task.title,
        description: task.description,
        aiSummary: task.ai_summary ?? undefined,
        projectName: project?.name ?? '',
      };
      // 与 buildSender 一致：提交前固化上下文快照，避免任务被改导致回执错位
      db.prepare('UPDATE queue_jobs SET request_payload = ? WHERE id = ?')
        .run(QueueService.snapshotTaskContext(task, project?.name ?? ''), job.id);
      const { type, config } = runtimeWithModel(job.tool_id);
      const adapter = getAdapter(type);
      // 异步工具走 submit（受理后返回 ticket）；同步工具回退为一次 send 即时完成
      if (typeof adapter.submit === 'function') return adapter.submit(context, config);
      const r = await adapter.send(context, config);
      return { ok: r.ok, content: r.content ?? undefined, error: r.error };
    };
  },

  /** 供 QueueService.pollPending 使用：按回执标识轮询异步结果，并由各工具 timeoutMs 判定超时 */
  buildPoller() {
    return async (job: QueueJobRow, ticket: string): Promise<PollResult> => {
      const { type, config } = runtimeWithModel(job.tool_id);
      const adapter = getAdapter(type);
      if (typeof adapter.poll !== 'function') {
        return { status: 'timeout', error: '该工具不支持异步回执轮询' };
      }
      const submitted = job.submitted_at ? new Date(job.submitted_at).getTime() : Date.now();
      const limit = config.timeoutMs ?? 60000;
      const elapsed = Date.now() - submitted;
      // 喂饱平台查询后：仅当仍 running 且已超时才降级为 timeout，避免短暂轮询被误判
      const result = await adapter.poll(ticket, config);
      if (result.status === 'running' && elapsed > limit) {
        return { status: 'timeout', error: `等待结果超过 ${limit}ms，已超时` };
      }
      return result;
    };
  },
};
