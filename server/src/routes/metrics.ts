/**
 * 指标基线路由（T03190 / PRD G-4；T03192 / PRD G-3；T03237 / PRD PM-205）。
 * G-2 覆盖率在 `/ai/coverage`（T03172），G-1 材料耗时在 `/report/material-timing/*`（T03189）；
 * 这里放按统计日出数的 G-4 逾期率、G-3 job 级成功率的写入/出数，以及 PM-205 日快照的采集与读取。
 */
import { Router } from 'express';
import { OverdueRateService } from '../services/OverdueRateService';
import { AiJobStats } from '../services/AiJobStats';
import { MetricSnapshotService } from '../services/MetricSnapshotService';

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

/** T03237（PM-205）：各项目快照覆盖与近 30 天缺失日（页面「可回溯起点 / 数据积累中」） */
metricsApi.get('/day-snapshots/coverage', (req, res) => {
  wrap(res, () => MetricSnapshotService.coverage({
    projectId: typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined,
  }));
});

/** T03237（PM-205）：按项目 + 时间范围取日快照序列（CFD/吞吐/逾期趋势共用同一份读数） */
metricsApi.get('/day-snapshots', (req, res) => {
  wrap(res, () => MetricSnapshotService.range({
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
    from: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
    to: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
  }));
});

/** T03237（PM-205）：手动采当天快照（启动自动采一轮；过去日期拒绝，避免从事件表伪造成历史） */
metricsApi.post('/day-snapshots/capture', (req, res) => {
  wrap(res, () => {
    const at = (req.body ?? {}) as { at?: unknown };
    return MetricSnapshotService.capture(at.at == null || at.at === '' ? undefined : String(at.at));
  });
});
