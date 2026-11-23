/**
 * T05747：B0/A/D 派发的手动入口与状态出口。
 * T06261/T06262/T06263（十期）：补配置、候选预览、立即跑一轮、连接测试、派发历史。
 *
 * 该路由只做参数校验与结果透传，挂载点 `api.use('/dispatch', dispatchApi)` 一行接线。
 * 安全：沿用 /api 的 accessTokenGuard；不返回 apiKey/口令，endpoint 只返回 host/path。
 */
import { Router } from 'express';
import { PushDispatcher, type DispatchChannel } from '../services/PushDispatcher';
import { ConfigService } from '../services/ConfigService';
import {
  readConfigView, savePolicy, sanitizeEndpoint, assertEndpointAllowed, resolveB0Tool, DispatchConfigConflictError,
} from '../services/DispatchPolicy';
import { DispatchScheduler } from '../services/DispatchScheduler';
import { listAttempts } from '../services/DispatchAttempts';

export const dispatchApi = Router();

const CHANNELS = new Set<DispatchChannel>(['auto', 'b0', 'a', 'd']);

function fail(res: import('express').Response, status: number, code: string, error: string, detail?: string) {
  res.status(status).json({ error, code, ...(detail ? { detail } : {}) });
}

dispatchApi.get('/status', (_req, res) => {
  try {
    const base = PushDispatcher.status();
    const runtime = DispatchScheduler.runtimeStatus();
    res.json({
      ...base,
      auto: {
        ...base.auto,
        ...runtime,
        enabled: base.auto.enabled,
        defaultChannel: base.auto.defaultChannel,
        b0ToolId: base.auto.b0ToolId,
        scopeProjectIds: base.auto.scopeProjectIds,
        trigger: base.auto.trigger,
        intervalMs: base.auto.intervalMs,
        cooldownMs: base.auto.cooldownMs,
        maxPerTick: base.auto.maxPerTick,
        maxAttempts: base.auto.maxAttempts,
        allowFallbackA: base.auto.allowFallbackA,
        allowAutoD: false,
        retentionDays: base.auto.retentionDays,
      },
    });
  } catch (e) {
    fail(res, 500, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.post('/task', async (req, res) => {
  try {
    const taskRef = String(req.body?.taskNo ?? req.body?.taskId ?? '').trim();
    if (!taskRef) {
      fail(res, 400, 'TASK_NOT_FOUND', '缺少 taskNo 或 taskId');
      return;
    }
    const rawChannel = String(req.body?.channel ?? readConfigView().defaultChannel).toLowerCase() as DispatchChannel;
    if (!CHANNELS.has(rawChannel)) {
      fail(res, 400, 'CONFIG_INVALID', `channel 需为 auto/b0/a/d，收到：${rawChannel}`);
      return;
    }
    const idempotencyKey = String(req.body?.idempotencyKey ?? '').trim();
    const result = await PushDispatcher.dispatch(taskRef, rawChannel, {
      actor: 'manual',
      allowD: rawChannel === 'd' || rawChannel === 'auto',
      allowFallbackA: true,
      idempotencyKey,
    });
    if (result.code === 'DISPATCH_DUPLICATE') {
      res.status(409).json({ ...result, error: result.detail, code: result.code });
      return;
    }
    // 业务失败也返回 200 + 结构化结果：调用方要区分“路由拒绝”和“通道失败”
    res.json(result);
  } catch (e) {
    fail(res, 500, 'DISPATCH_INTERNAL', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.get('/config', (_req, res) => {
  try {
    res.json(readConfigView());
  } catch (e) {
    fail(res, 500, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.put('/config', (req, res) => {
  try {
    const expectedUpdatedAt = String((req.body as Record<string, unknown> | undefined)?.expectedUpdatedAt ?? '').trim();
    const view = savePolicy((req.body ?? {}) as Record<string, unknown>, expectedUpdatedAt || undefined);
    DispatchScheduler.reload();
    res.json({ ...readConfigView(), saved: view });
  } catch (e) {
    if (e instanceof DispatchConfigConflictError) {
      fail(res, 409, e.code, e.message);
      return;
    }
    fail(res, 400, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.get('/candidates', (req, res) => {
  try {
    const projectId = String(req.query.projectId ?? '').trim() || undefined;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
    res.json({ items: DispatchScheduler.candidates({ projectId, limit }) });
  } catch (e) {
    fail(res, 500, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.post('/auto/run', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.body?.dryRun === 1;
    const projectId = String(req.body?.projectId ?? '').trim() || undefined;
    const result = await DispatchScheduler.tick({ force: true, dryRun, actor: 'manual', projectId });
    res.json(result);
  } catch (e) {
    fail(res, 500, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.post('/test', async (req, res) => {
  try {
    const requested = String(req.body?.toolId ?? '').trim();
    const tool = requested
      ? ConfigService.getById(requested)
      : (() => {
          const resolved = resolveB0Tool();
          return resolved.tool ? ConfigService.getById(resolved.tool.id) : null;
        })();
    if (!tool) {
      fail(res, 400, 'B0_NOT_CONFIGURED', '未配置可用的 CodeBuddy 网关工具');
      return;
    }
    if (tool.type !== 'codebuddy-gateway') {
      fail(res, 400, 'B0_NOT_CONFIGURED', `工具 type=${tool.type}，不是 codebuddy-gateway`);
      return;
    }
    const endpoint = sanitizeEndpoint(tool.endpoint);
    try {
      assertEndpointAllowed(tool.endpoint);
    } catch (e) {
      fail(res, 400, 'B0_UNREACHABLE', e instanceof Error ? e.message : String(e), endpoint);
      return;
    }
    const result = await ConfigService.testConnection(tool.id);
    res.json({
      configured: true,
      toolId: tool.id,
      toolName: tool.name,
      endpoint,
      ok: result.ok,
      message: result.message,
      code: result.ok ? undefined : /鉴权|401|403|口令/i.test(result.message) ? 'B0_AUTH_FAILED' : 'B0_UNREACHABLE',
    });
  } catch (e) {
    fail(res, 500, 'B0_UNREACHABLE', e instanceof Error ? e.message : String(e));
  }
});

dispatchApi.get('/attempts', (req, res) => {
  try {
    const taskNo = String(req.query.taskNo ?? '').trim() || undefined;
    const taskId = String(req.query.taskId ?? '').trim() || undefined;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 10) || 10));
    res.json({ items: listAttempts({ taskNo, taskId, limit }) });
  } catch (e) {
    fail(res, 500, 'CONFIG_INVALID', e instanceof Error ? e.message : String(e));
  }
});
