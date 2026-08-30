import { Router } from 'express';
import { getDb } from '../db/connection';
import { TaskService, type TaskListOptions } from '../services/TaskService';
import { ConfigService } from '../services/ConfigService';
import { QueueService } from '../services/QueueService';
import { AIService } from '../services/AIService';
import { ArchiveService } from '../services/ArchiveService';
import { TaskImageService } from '../services/TaskImageService';
import { TaskCategoryService } from '../services/TaskCategoryService';
import { exportBundle, importBundle } from '../services/SettingsService';
import { getDefaultNoteProjectId, INBOX_PROJECT_ID, setSetting } from '../services/AppSettings';
import { logService } from '../services/LogService';
import { generateReport, listTemplates, saveTemplate, deleteTemplate, aiGenerateReport, aiGenerateReportStream, isReportToken, readAndDeleteReport, gatherReportData, type ReportPeriod } from '../services/ReportService';
import { Buffer } from 'node:buffer';
import { v4 as uuid } from 'uuid';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';

/** 低频集合列表 TTL（5s）：读多写少，写端点会主动 cacheClear 保持一致性 */
const LIST_TTL_MS = 5000;

function now(): string {
  return new Date().toISOString();
}

export const api = Router();

// ---------- 健康检查 ----------
api.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mtask-server', time: now() });
});

// ---------- 后台日志（实时查看） ----------
// since：增量游标（pos 的 seq），首次不传/为 0 返回当前缓冲全量；latestSeq 供下一轮增量
api.get('/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(logService.list(since));
});

// ---------- 项目 ----------
api.get('/projects', (_req, res) => {
  const cached = cacheGet<unknown[]>('projects');
  if (cached) return res.json(cached);
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY sort_weight, created_at').all();
  cacheSet('projects', rows, LIST_TTL_MS);
  res.json(rows);
});

api.post('/projects', (req, res) => {
  const { name, description = '' } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
  const id = uuid();
  getDb().prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, description, now(), now());
  cacheClear('projects'); // 新建项目后列表缓存失效，立即可见
  res.status(201).json(getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

api.patch('/projects/:id', (req, res) => {
  const { name, description, sortWeight } = req.body ?? {};
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (description !== undefined) { sets.push('description = ?'); values.push(description); }
  if (sortWeight !== undefined) { sets.push('sort_weight = ?'); values.push(sortWeight); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('projects'); // 改名/排序影响列表展示
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

api.delete('/projects/:id', (req, res) => {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id); // 级联删任务
  cacheClear('projects');
  res.status(204).end();
});

// ---------- 任务 ----------
// 可选参数：projectId / archived / limit / offset / keyword / categoryId / sort（全部向后兼容，缺省=全量）
api.get('/tasks', (req, res) => {
  const { projectId, archived, limit, offset, keyword, categoryId, sort } = req.query;
  // limit 仅接受 1~500 的正整数，非法则忽略（保持全量语义），避免恶意超大分页拖垮查询
  let limitN: number | undefined;
  const limitRaw = Number(limit);
  if (Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 500) limitN = Math.floor(limitRaw);
  res.json(TaskService.list({
    projectId: projectId as string | undefined,
    archived: archived === '1' || archived === 'true',
    limit: limitN,
    offset: offset !== undefined ? Math.max(0, Math.floor(Number(offset) || 0)) : undefined,
    keyword: keyword as string | undefined,
    categoryId: categoryId as string | undefined,
    sort: sort as TaskListOptions['sort'],
  }));
});

api.post('/tasks', (req, res) => {
  const { projectId, title, description, priority, status, categoryId } = req.body ?? {};
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  // 移动端随手记：projectId 可选（§3.1/§3.3）。缺省落"默认记事项目"（用户设置优先，否则收件箱系统项目）
  const pid = projectId && typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : getDefaultNoteProjectId();
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) {
    return res.status(400).json({ error: '归属项目不存在' });
  }
  res.status(201).json(TaskService.create({ projectId: pid, title: title.trim(), description, priority, status, categoryId }));
});

api.patch('/tasks/:id', (req, res) => {
  const { title, description, priority, status, verified, aiSummary, pinned, categoryId } = req.body ?? {};
  res.json(TaskService.update(req.params.id, { title, description, priority, status, verified, ai_summary: aiSummary, pinned, category_id: categoryId }));
});

api.post('/tasks/move', (req, res) => {
  const { taskIds, projectId } = req.body ?? {};
  if (!Array.isArray(taskIds) || !projectId) return res.status(400).json({ error: 'taskIds 数组与 projectId 必填' });
  TaskService.moveProject(taskIds, projectId);
  res.status(204).end();
});

// 复用（复制）任务到目标项目；同名冲突 / 目标不存在映射为 409
api.post('/tasks/:id/reuse', (req, res) => {
  const { projectId } = req.body ?? {};
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  try {
    res.status(201).json(TaskService.reuse(req.params.id, projectId));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// 将任务复制为提示词页可复用资产（打包成单份 JSON 写入目标提示词分类）；分类不存在映射为 409
api.post('/tasks/:id/to-prompt', (req, res) => {
  const { categoryId } = req.body ?? {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId 必填' });
  try {
    res.status(201).json(TaskService.toPromptAsset(req.params.id, categoryId));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// ---------- 任务分类 ----------
api.get('/task-categories', (_req, res) => {
  res.json(TaskCategoryService.list());
});

api.post('/task-categories', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  res.status(201).json(TaskCategoryService.create(name));
});

api.patch('/task-categories/:id', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  const cat = TaskCategoryService.rename(req.params.id, name);
  if (!cat) return res.status(404).json({ error: '分类不存在' });
  res.json(cat);
});

api.delete('/task-categories/:id', (req, res) => {
  // 删除分类会把其下任务 category_id 置空（任务保留、回到未分类）
  if (!TaskCategoryService.remove(req.params.id)) return res.status(404).json({ error: '分类不存在' });
  res.status(204).end();
});

// FR5.1 采纳：审阅后的 AI 文本保存到任务并置为 done（仅保存文本，待人工合并）
api.post('/tasks/:id/adopt', (req, res) => {
  const { content } = req.body ?? {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
  try {
    res.json(TaskService.adoptContent(req.params.id, content));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 任务截图/图片附件（FR1.3 图文混合描述） ----------
// 上传：body { data: base64（不含 data: 前缀）, mimeType? }，支持 dataURL 自动去前缀
api.post('/tasks/:id/images', (req, res) => {
  let { data, mimeType } = req.body ?? {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'data(base64) 必填' });
  // 兼容前端直接传 dataURL 的情况
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(data);
  if (m) { mimeType = mimeType ?? m[1]; data = m[2]; }
  try {
    res.status(201).json(TaskImageService.add(req.params.id, data, mimeType));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 任务的图片列表（元信息，不含 BLOB）
api.get('/tasks/:id/images', (req, res) => {
  res.json(TaskImageService.listByTask(req.params.id));
});

// 读取图片二进制（<img src> 直接使用）
api.get('/images/:id', (req, res) => {
  const img = TaskImageService.getData(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.setHeader('Content-Type', img.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(img.data);
});

// 删除单张图片（替换/移除操作）
api.delete('/images/:id', (req, res) => {
  if (!TaskImageService.remove(req.params.id)) return res.status(404).json({ error: '图片不存在' });
  res.status(204).end();
});

// ---------- AI 工具配置 ----------
api.get('/aitools', (_req, res) => {
  res.json(ConfigService.list());
});

api.get('/aitools/types', (_req, res) => {
  res.json(ConfigService.listAdapterTypes());
});

// 草稿连接测试：用表单未保存的 type/endpoint/apiKey/model 提前验证连通性（不落库）
api.post('/aitools/test', async (req, res) => {
  try {
    res.json(await ConfigService.testDraft(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 草稿模型列表：用表单未保存的 type/endpoint/apiKey 拉取服务商可用模型（不落库）
api.post('/aitools/models', async (req, res) => {
  try {
    res.json(await ConfigService.listModelsDraft(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/aitools', (req, res) => {
  try {
    res.status(201).json(ConfigService.create(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.patch('/aitools/:id', (req, res) => {
  try {
    res.json(ConfigService.update(req.params.id, req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/aitools/:id', (req, res) => {
  ConfigService.remove(req.params.id);
  res.status(204).end();
});

api.post('/aitools/:id/test', async (req, res) => {
  try {
    res.json(await ConfigService.testConnection(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 已保存工具的可用模型列表（服务端解密密钥后拉取，带 5 分钟缓存）
api.post('/aitools/:id/models', async (req, res) => {
  try {
    res.json(await ConfigService.listModels(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 查看原文：按需返回解密后的 API Key（仅用户显式点击时拉取，不随列表返回）
api.get('/aitools/:id/api-key', (req, res) => {
  try {
    res.json(ConfigService.getApiKey(req.params.id));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// FR3.4 默认工具绑定
api.get('/aitools/defaults', (_req, res) => {
  res.json(ConfigService.getDefaults());
});

api.post('/aitools/:id/set-default', (req, res) => {
  const { kind } = req.body ?? {};
  if (kind !== 'organize' && kind !== 'develop') return res.status(400).json({ error: "kind 必填（organize|develop）" });
  try {
    ConfigService.setDefault(req.params.id, kind);
    res.json(ConfigService.getDefaults());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 队列 ----------
api.get('/queues', (_req, res) => {
  res.json(QueueService.list());
});

api.get('/queues/:id', (req, res) => {
  const queue = QueueService.getById(req.params.id);
  if (!queue) return res.status(404).json({ error: '队列不存在' });
  res.json({ ...queue, jobs: QueueService.listJobsDetailed(req.params.id) });
});

api.post('/queues', (req, res) => {
  const { name, date } = req.body ?? {};
  if (!name || !date) return res.status(400).json({ error: 'name 与 date 必填' });
  res.status(201).json(QueueService.create(name, date));
});

api.post('/queues/:id/jobs', (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items 必填' });
  try {
    res.status(201).json(QueueService.addJobs(req.params.id, items));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/queues/:id/jobs/:jobId', (req, res) => {
  QueueService.removeJob(req.params.id, req.params.jobId);
  res.status(204).end();
});

api.post('/queues/:id/send', async (req, res) => {
  try {
    const jobs = await QueueService.sendAll(req.params.id, AIService.buildSender());
    res.json(jobs);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 异步提交：不阻塞等待完整结果，受理后由后台 poller 轮询收口（同步工具自动回退、行为不变）
api.post('/queues/:id/submit', async (req, res) => {
  try {
    const jobs = await QueueService.submitAll(req.params.id, AIService.buildSubmitter());
    res.json(jobs);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/queues/:id/reset', (req, res) => {
  QueueService.resetFailed(req.params.id);
  res.status(204).end();
});

// ---------- 梳理（FR2） ----------
api.post('/ai/organize', async (req, res) => {
  const { taskIds, toolId } = req.body ?? {};
  if (!Array.isArray(taskIds) || !toolId) return res.status(400).json({ error: 'taskIds 数组与 toolId 必填' });
  try {
    res.json(await AIService.organize(taskIds, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 标题美化 ----------
api.post('/ai/beautify', async (req, res) => {
  const { toolId, title } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (!title) return res.status(400).json({ error: 'title 必填' });
  try {
    res.json(await AIService.beautifyTitle(title, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 报表生成与模板管理 ----------
api.post('/report/generate', async (req, res) => {
  const { period, format, projectId, templateId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  try {
    const { buffer, filename } = await generateReport(period, format, {
      projectId: projectId || undefined,
      templateId: templateId || undefined,
    });
    // 各格式对应 MIME：xlsx/docx 为 OOXML，pdf 为 application/pdf，pptx 为演示文稿 OOXML
    const MIME: Record<string, string> = {
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pdf: 'application/pdf',
    };
    res.setHeader('Content-Type', MIME[format] ?? 'application/octet-stream');
    // RFC5987：文件名含中文需编码，避免下载名乱码
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.get('/report/templates', (_req, res) => {
  res.json(listTemplates());
});

api.post('/report/ai-generate', async (req, res) => {
  const { period, format, projectId, toolId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: '请选择 AI 模型' });
  try {
    // AI 周报：先落临时文件，返回下载令牌与洞察正文（前端再经 ai-download 下载即删）
    const r = await aiGenerateReport(period, format, {
      projectId: projectId || undefined,
      toolId,
    });
    res.json({ ok: true, token: r.token, filename: r.filename, insight: r.insight });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- AI 周报（SSE 流式）：联动 AI 控制台实时展示生成过程 ----------
api.post('/report/ai-generate-stream', async (req, res) => {
  const { period, format, projectId, toolId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: '请选择 AI 模型' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 客户端断开后停止继续写流，避免向已关闭的 socket 写入抛错。
  // 必须监听 res 的 close（响应真正关闭才代表客户端断开/响应结束），不能监听 req.on('close')：
  // SSE 请求体已被 express.json() 消费完，IncomingMessage 无数据可读时 req 会提前触发 close，
  // 导致后续 chunk/done/error 事件被误丢弃（实测只发出前几条 stage 就"卡住"）。
  let closed = false;
  const send = (event: string, payload: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  res.on('close', () => { closed = true; });

  try {
    const r = await aiGenerateReportStream(
      period,
      format,
      { projectId: projectId || undefined, toolId },
      (msg) => send('stage', { msg }),
      (text) => send('chunk', { text }),
    );
    send('done', { token: r.token, filename: r.filename });
    res.end();
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
    res.end();
  }
});

api.post('/report/ai-download', (req, res) => {
  const { token, filename } = req.body ?? {};
  if (typeof token !== 'string' || !isReportToken(token)) return res.status(400).json({ error: 'token 非法' });
  // 下载文件名做白名单清洗，避免注入非法字符
  const safe = typeof filename === 'string' && /^[\w\-.()·\u4e00-\u9fa5 ]+\.(xlsx|docx|pdf|pptx)$/i.test(filename) ? filename : 'MTask-ai-report.xlsx';
  const buf = readAndDeleteReport(token);
  if (!buf) return res.status(404).json({ error: '文件已过期，请重新生成' });
  const MIME: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
  };
  const ext = (safe.split('.').pop() ?? '').toLowerCase();
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  // RFC5987：文件名含中文需编码，避免下载名乱码
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`);
  res.send(buf);
});

api.post('/report/templates', async (req, res) => {
  const { filename, data } = req.body ?? {};
  if (typeof filename !== 'string' || typeof data !== 'string') {
    return res.status(400).json({ error: 'filename 与 data 必填' });
  }
  // 前端上传以 base64 承载，校验并落盘；非法格式/路径/体积返回明确提示
  if (!saveTemplate(filename, Buffer.from(data, 'base64'))) {
    return res.status(400).json({ error: '模板文件校验失败，仅支持 .xlsx / .docx（≤10MB）' });
  }
  res.json({ ok: true });
});

api.delete('/report/templates/:id', (req, res) => {
  if (!deleteTemplate(req.params.id)) return res.status(400).json({ error: '模板不存在或名称非法' });
  res.status(204).end();
});

// ---------- AI 控制台通用问答 ----------
// 可选注入周期数据：控制台「周期分析」类预设（汇总/风险/建议）携带 period 时，
// 后端用与 AI 周报相同的 gatherReportData 聚合真实任务数据注入，使 AI 作答有据可依；
// 不带 period（自定义问答）则保持纯对话，不注入数据。
const REPORT_PERIODS = new Set<ReportPeriod>(['day', 'week', 'month']);
api.post('/ai/chat', async (req, res) => {
  const { toolId, system, user, period, projectId } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (typeof user !== 'string' || !user.trim()) return res.status(400).json({ error: 'user 必填' });

  let sys = typeof system === 'string' ? system : '';
  let usr = user.trim();
  if (typeof period === 'string' && REPORT_PERIODS.has(period as ReportPeriod)) {
    const data = gatherReportData(period as ReportPeriod, typeof projectId === 'string' && projectId ? projectId : undefined);
    // 限定模型必须依据随附真实数据作答，提示所依据周期，避免常识性发挥与用户预期不符
    sys = `${sys}\n本次必须严格依据随附的当前周期真实任务数据进行作答，不得虚构任务或数据；请点明所依据周期（${data.periodLabel} ${data.startDate}~${data.endDate}）。`.trim();
    usr = [
      `【周期=${data.periodLabel} ${data.startDate} ~ ${data.endDate}】`,
      `【项目汇总】${JSON.stringify(data.projects)}`,
      `【任务明细】${JSON.stringify(data.tasks)}`,
      `\n问题：${usr}`,
    ].join('\n\n');
  }

  try {
    res.json(await AIService.ask(toolId, sys, usr));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 任务智能分类 ----------
api.post('/tasks/classify', async (req, res) => {
  const { title, toolId, categories } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories 必填' });
  try {
    res.json(await AIService.classifyCategory(title, categories, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 提示词优化 ----------
api.post('/ai/optimize', async (req, res) => {
  const { toolId, title, description } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  try {
    res.json(await AIService.optimizeText(title ?? '', description ?? '', toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 归档（FR6） ----------
api.post('/archive', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  res.json(ArchiveService.archive(taskIds));
});

api.post('/archive/restore', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  res.json(ArchiveService.restore(taskIds));
});

api.delete('/archive', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  const removed = ArchiveService.remove(taskIds);
  res.json({ removed });
});

// ---------- 提示词仓库 ----------
api.get('/prompt-categories', (_req, res) => {
  const cached = cacheGet<unknown[]>('prompt-categories');
  if (cached) return res.json(cached);
  const cats = getDb().prepare('SELECT * FROM prompt_categories ORDER BY sort_weight, created_at').all() as { id: string }[];
  const counts = getDb().prepare('SELECT category_id, COUNT(*) AS c FROM prompts GROUP BY category_id').all() as { category_id: string; c: number }[];
  const countMap = new Map(counts.map((r) => [r.category_id, r.c]));
  const out = cats.map((c) => ({ ...c, promptCount: countMap.get(c.id) ?? 0 }));
  cacheSet('prompt-categories', out, LIST_TTL_MS);
  res.json(out);
});

api.post('/prompt-categories', (req, res) => {
  const { name, description = '' } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
  const id = uuid();
  getDb().prepare('INSERT INTO prompt_categories (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), description, now(), now());
  cacheClear('prompt-categories');
  res.status(201).json(getDb().prepare('SELECT * FROM prompt_categories WHERE id = ?').get(id));
});

api.patch('/prompt-categories/:id', (req, res) => {
  const { name, description } = req.body ?? {};
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (description !== undefined) { sets.push('description = ?'); values.push(description); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE prompt_categories SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('prompt-categories');
  res.json(db.prepare('SELECT * FROM prompt_categories WHERE id = ?').get(req.params.id));
});

api.delete('/prompt-categories/:id', (req, res) => {
  getDb().prepare('DELETE FROM prompt_categories WHERE id = ?').run(req.params.id); // 级联删分类下提示词
  cacheClear('prompt-categories');
  res.status(204).end();
});

api.get('/prompts', (req, res) => {
  const { categoryId, keyword } = req.query;
  const where: string[] = [];
  const values: unknown[] = [];
  if (categoryId) { where.push('category_id = ?'); values.push(categoryId); }
  if (keyword) { where.push('(title LIKE ? OR content LIKE ?)'); values.push(`%${keyword}%`, `%${keyword}%`); }
  const sql = `SELECT * FROM prompts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC`;
  res.json(getDb().prepare(sql).all(...values));
});

api.post('/prompts', (req, res) => {
  const { categoryId, title, content = '' } = req.body ?? {};
  if (!categoryId || !title || typeof title !== 'string') return res.status(400).json({ error: 'categoryId 与 title 必填' });
  const id = uuid();
  getDb().prepare('INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, categoryId, title.trim(), content, now(), now());
  cacheClear('prompt-categories'); // 分类计数变化
  res.status(201).json(getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

api.patch('/prompts/:id', (req, res) => {
  const { title, content, categoryId, pinned } = req.body ?? {};
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(title); }
  if (content !== undefined) { sets.push('content = ?'); values.push(content); }
  if (categoryId !== undefined) { sets.push('category_id = ?'); values.push(categoryId); }
  if (pinned !== undefined) { sets.push('pinned = ?'); values.push(pinned ? 1 : 0); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('prompt-categories'); // 改分类/置顶影响分类计数与顺序
  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id));
});

api.delete('/prompts/:id', (req, res) => {
  getDb().prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  cacheClear('prompt-categories'); // 分类计数变化
  res.status(204).end();
});

// ---------- 移动端：默认记事项目设置 ----------
// 读取当前默认记事项目（用户设置优先，否则收件箱系统项目）
api.get('/settings/note-project', (_req, res) => {
  res.json({ projectId: getDefaultNoteProjectId(), inboxId: INBOX_PROJECT_ID });
});

// 设置默认记事项目（移动端随手记缺省归属）；仅校验目标项目存在
api.post('/settings/note-project', (req, res) => {
  const { projectId } = req.body ?? {};
  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return res.status(400).json({ error: 'projectId 必填' });
  }
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId.trim())) {
    return res.status(400).json({ error: '项目不存在' });
  }
  setSetting('defaultNoteProjectId', projectId.trim());
  res.json({ projectId: projectId.trim() });
});

// ---------- 设置中心：数据迁移（换机重装用） ----------
api.get('/settings/export', (_req, res) => {
  try {
    res.json(exportBundle());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/settings/import', (req, res) => {
  const { data, mode } = req.body ?? {};
  if (mode !== 'overwrite' && mode !== 'keep' && mode !== 'merge') {
    return res.status(400).json({ error: 'mode 必填（overwrite|keep|merge）' });
  }
  try {
    res.json(importBundle(data, mode));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
