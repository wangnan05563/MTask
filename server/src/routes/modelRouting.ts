import { Router } from 'express';
import {
  ModelRoutingService,
  ModelRoutingError,
  type ProfilePatch,
  type BudgetPatch,
  type RouteRequest,
  type TaskType,
} from '../services/ModelRoutingService';

/**
 * T06311（REQ-038 / PRD §B9）：模型路由与成本预算接口。
 *
 * - POST /route：按任务特征自动路由；请求体显式拒绝 toolId/model，避免退化成手动指定。
 * - 模拟器：body.simulate=true 或 commit=false，不写审计、不占预算，返回候选对比。
 * - GET  /profiles、PUT /profiles/:toolId：成本/延迟/上下文/能力/健康画像。
 * - GET/PUT /budgets/:projectId：项目/日/月/单 Run 预算、80% 预警、100% 停或降级。
 * - GET  /decisions、/attribution、/attribution.csv：审计与成本归因导出。
 */
export const modelRoutingApi = Router();

function fail(res: { status: (code: number) => { json: (body: unknown) => void } }, e: unknown): void {
  const err = e instanceof ModelRoutingError ? e : null;
  const status = err?.statusCode ?? 400;
  const message = e instanceof Error ? e.message : String(e);
  const body: Record<string, unknown> = { error: message };
  if (err?.code) body.code = err.code;
  if (err?.decision) body.decision = err.decision;
  res.status(status).json(body);
}

modelRoutingApi.get('/profiles', (req, res) => {
  try {
    res.json({ profiles: ModelRoutingService.listProfiles() });
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.put('/profiles/:toolId', (req, res) => {
  try {
    const body = (req.body ?? {}) as ProfilePatch;
    res.json(ModelRoutingService.upsertProfile(req.params.toolId, body));
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.get('/budgets/:projectId', (req, res) => {
  try {
    res.json(ModelRoutingService.budgetSnapshot(req.params.projectId));
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.put('/budgets/:projectId', (req, res) => {
  try {
    const body = (req.body ?? {}) as BudgetPatch;
    res.json(ModelRoutingService.upsertBudget(req.params.projectId, body));
  } catch (e) {
    fail(res, e);
  }
});

const TASK_TYPES = new Set(['general', 'summary', 'testcase', 'document', 'review', 'code']);

modelRoutingApi.post('/route', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.toolId !== undefined || body.model !== undefined) {
      return fail(res, new ModelRoutingError('manual_model_not_allowed', '不支持手动指定模型：路由由任务特征与预算自动决定', 400));
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!projectId) return fail(res, new ModelRoutingError('project_required', 'projectId 必填', 400));
    const simulate = body.simulate === true || body.commit === false;
    const taskType = typeof body.taskType === 'string' && TASK_TYPES.has(body.taskType)
      ? (body.taskType as TaskType)
      : undefined;
    const request: RouteRequest = {
      projectId,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      runId: typeof body.runId === 'string' ? body.runId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      taskType,
      contextTokens: Number.isFinite(Number(body.contextTokens)) ? Number(body.contextTokens) : undefined,
      outputTokens: Number.isFinite(Number(body.outputTokens)) ? Number(body.outputTokens) : undefined,
      costLimit: Number.isFinite(Number(body.costLimit)) ? Number(body.costLimit) : undefined,
      latencyBudgetMs: Number.isFinite(Number(body.latencyBudgetMs)) ? Number(body.latencyBudgetMs) : undefined,
      commit: !simulate,
    };
    const decision = ModelRoutingService.route(request);
    if (!simulate && decision.budget.state === 'hard_stop') {
      return res.status(409).json({ error: decision.banner, code: 'budget_hard_stop', decision });
    }
    res.json(decision);
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.get('/decisions', (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    res.json({ decisions: ModelRoutingService.listDecisions(projectId, limit) });
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.get('/attribution', (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    res.json({ rows: ModelRoutingService.costAttribution(projectId) });
  } catch (e) {
    fail(res, e);
  }
});

modelRoutingApi.get('/attribution.csv', (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const csv = ModelRoutingService.costAttributionCsv(projectId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="model-cost-attribution-${projectId || 'project'}.csv"`);
    res.send(csv);
  } catch (e) {
    fail(res, e);
  }
});
