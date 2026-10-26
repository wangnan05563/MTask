/**
 * 指标基线路由（T03190 / PRD G-4；T03192 / PRD G-3）。
 * G-2 覆盖率在 `/ai/coverage`（T03172），G-1 材料耗时在 `/report/material-timing/*`（T03189）；
 * 这里放按统计日出数的 G-4 逾期率，以及 G-3 job 级成功率的写入/出数，路径自带完整前缀并整体挂载。
 */
import { Router } from 'express';
import { OverdueRateService } from '../services/OverdueRateService';
import { AiJobStats } from '../services/AiJobStats';

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

/** T03192（G-3）：job 终态上报——同一 jobId 重复上报以最后一次为准（终态覆盖，对应「重试后最终成功」） */
metricsApi.post('/ai-jobs', (req, res) => {
  wrap(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]) => keys.map((k) => b[k]).find((v) => v !== undefined);
    const finishedAt = pick('finishedAt', 'finished_at');
    return AiJobStats.record({
      jobId: String(pick('jobId', 'job_id') ?? ''),
      cardKey: String(pick('cardKey', 'card_key') ?? ''),
      status: String(b.status ?? ''),
      mode: b.mode == null ? undefined : String(b.mode),
      sectionsTotal: pick('sectionsTotal', 'sections_total'),
      sectionsOk: pick('sectionsOk', 'sections_ok'),
      startedAt: b.startedAt == null ? undefined : String(b.startedAt),
      finishedAt: finishedAt == null ? undefined : String(finishedAt),
    });
  });
});

/** T03192（G-3）：近 N 天 job 级成功率——取消不进分母、partial 不计成功、AI/离线分列 */
metricsApi.get('/ai-jobs/success-rate', (req, res) => {
  wrap(res, () => AiJobStats.successRate({
    days: req.query.days,
    mode: req.query.mode,
    cardKey: typeof req.query.cardKey === 'string' && req.query.cardKey ? req.query.cardKey : undefined,
  }));
});
