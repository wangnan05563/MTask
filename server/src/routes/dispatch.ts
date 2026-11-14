/**
 * T05747：B0/A/D 派发的手动入口与状态出口。
 *
 * 为什么单独成路由：PushDispatcher 是服务层，不把 HTTP 细节塞进 services；
 * 该路由只做参数校验与结果透传，挂载点 `api.use('/dispatch', dispatchApi)` 一行接线。
 *
 * 安全：与既有 /api 一致，受 accessTokenGuard 保护；不返回 apiKey/口令，只返回工具 id/name/endpoint。
 */
import { Router } from 'express';
import { PushDispatcher, type DispatchChannel } from '../services/PushDispatcher';

export const dispatchApi = Router();

const CHANNELS = new Set<DispatchChannel>(['auto', 'b0', 'a', 'd']);

dispatchApi.get('/status', (_req, res) => {
  try {
    res.json(PushDispatcher.status());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

dispatchApi.post('/task', async (req, res) => {
  try {
    const taskRef = String(req.body?.taskNo ?? req.body?.taskId ?? '').trim();
    if (!taskRef) {
      res.status(400).json({ error: '缺少 taskNo 或 taskId' });
      return;
    }
    const rawChannel = String(req.body?.channel ?? 'auto').toLowerCase() as DispatchChannel;
    if (!CHANNELS.has(rawChannel)) {
      res.status(400).json({ error: `channel 需为 auto/b0/a/d，收到：${rawChannel}` });
      return;
    }
    const result = await PushDispatcher.dispatch(taskRef, rawChannel);
    // 业务失败也返回 200 + 结构化结果：调用方要区分“路由拒绝”和“通道失败”
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
