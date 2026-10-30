/**
 * 汇报材料耗时采样路由（T03189 / PRD G-1）。
 *
 * 三个端点都按完整路径声明并整体挂载（同 iterations.ts 的口径）：
 *  - `POST /report/material-timing/start`  卡片展开即开始计时（重试复用同一样本）；
 *  - `POST /report/material-timing/finish` 下载成功（或放弃）时收口；
 *  - `GET  /report/material-timing/stats`  按时间窗出 P50/P90。
 */
import { Router } from 'express';
import { MaterialTimingService } from '../services/MaterialTimingService';
import { scalarText } from '../util/scalarText';

export const materialTimingApi = Router();

function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

materialTimingApi.post('/report/material-timing/start', (req, res) => {
  wrap(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cardKey = b.cardKey ?? b.card_key;
    return MaterialTimingService.start({ cardKey: scalarText(cardKey ?? ''), projectId: b.projectId ? scalarText(b.projectId) : undefined });
  });
});

materialTimingApi.post('/report/material-timing/finish', (req, res) => {
  wrap(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return MaterialTimingService.finish({
      id: b.id ? scalarText(b.id) : undefined,
      cardKey: b.cardKey ? scalarText(b.cardKey) : undefined,
      ok: b.ok === undefined ? undefined : Boolean(b.ok),
    });
  });
});

materialTimingApi.get('/report/material-timing/stats', (req, res) => {
  wrap(res, () => MaterialTimingService.stats(Number(req.query.days ?? 30)));
});
