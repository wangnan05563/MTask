/**
 * 指标基线路由（T03190 / PRD G-4）。
 * G-2 覆盖率在 `/ai/coverage`（T03172），G-1 材料耗时在 `/report/material-timing/*`（T03189）；
 * 这里只放「按统计日出数」的 G-4 逾期率，路径自带完整前缀并整体挂载。
 */
import { Router } from 'express';
import { OverdueRateService } from '../services/OverdueRateService';

export const metricsApi = Router();

function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

metricsApi.get('/overdue-rate', (req, res) => {
  wrap(res, () => OverdueRateService.report({
    at: typeof req.query.at === 'string' && req.query.at ? req.query.at : undefined,
    projectId: typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined,
  }));
});
