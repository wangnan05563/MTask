/**
 * 八期 §3.3 / §4.2「Git 增量资产提取」端点（T03399 / T03424 / T03425 / T03426 / T03351）。
 *
 * 三个入口：
 *  - `POST /git-extract/plan`：只回范围摘要与计数（面板「已选 3 个项目 / 12 个任务 / 共 47 个文件」常显重算用），不落盘不打包；
 *  - `POST /git-extract`：SSE 分阶段执行（汇总 → 读取 → 打包 → 可下载），与既有导出闸共用（超限 429、不排队）；
 *  - `GET /git-extract/download?token=`：一次性令牌换文件，下载即删。
 *
 * 错误口径：范围/上限类问题在**切到 SSE 之前**以 JSON 4xx 返回（面板能直接落到行内提示），
 * 执行期错误走 `error` 事件；降级（非仓库/无 git/超时）保留 gitCollect 的 kind 供前端给指引。
 */
import { Router } from 'express';
import {
  ExtractError,
  GIT_EXTRACT_MODES,
  planExtract,
  runExtract,
  sweepGitExtractTmp,
  type GitExtractMode,
} from '../services/gitExtract';
import { GitCollectError } from '../services/gitCollect';
import { isReportToken, readAndDeleteReport } from '../services/ReportService';
import { DOWNLOAD_NAME_RE } from '../util/export-name';
import { exportGate } from '../util/export-gate';
import { scalarText } from '../util/scalarText';

export const gitExtractApi = Router();

/** jobId → 中止句柄（SSE 断开或用户点「中止」都要能掐掉正在跑的 cat-file 子进程） */
const controllers = new Map<string, AbortController>();

function errorShape(e: unknown): { status: number; body: { error: string; kind: string; counts?: { files: number; bytes: number } } } {
  if (e instanceof ExtractError) {
    let status: number;
    if (e.kind === 'no-tasks' || e.kind === 'no-links' || e.kind === 'empty') status = 400;
    else if (e.kind === 'task-not-found') status = 404;
    else if (e.kind === 'cross-workspace' || e.kind === 'no-workspace') status = 400;
    else if (e.kind === 'too-many-files' || e.kind === 'too-large') status = 413;
    else status = 400;
    return { status, body: { error: e.message, kind: e.kind, ...(e.counts ? { counts: e.counts } : {}) } };
  }
  if (e instanceof GitCollectError) {
    return { status: 200, body: { error: e.message, kind: e.kind } };
  }
  return { status: 500, body: { error: e instanceof Error ? e.message : String(e), kind: 'failed' } };
}

function modeOf(raw: unknown): GitExtractMode {
  const m = scalarText(raw ?? '');
  if (!(GIT_EXTRACT_MODES as readonly string[]).includes(m)) {
    throw new ExtractError('bad-mode', `未知提取方式「${m.slice(0, 16)}」，可选：${GIT_EXTRACT_MODES.join(' / ')}`);
  }
  return m as GitExtractMode;
}

function idsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ExtractError('bad-args', 'taskIds 需为数组');
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** 范围摘要：面板每次勾选变化都调它重算计数（只读，不产生任何落盘） */
gitExtractApi.post('/git-extract/plan', async (req, res) => {
  try {
    const plan = await planExtract(idsOf(req.body?.taskIds));
    res.json({
      workspacePath: plan.workspacePath,
      projects: plan.projects.length,
      tasks: plan.tasks.length,
      commits: plan.commits.length,
      files: plan.uniquePaths,
      manifestRows: plan.manifestRows,
      unlinked: plan.unlinked,
      missingShas: plan.missingShas,
    });
  } catch (e) {
    const { status, body } = errorShape(e);
    res.status(status).json(body);
  }
});

/** 发起提取 job（SSE） */
gitExtractApi.post('/git-extract', exportGate('git-extract'), async (req, res) => {
  let plan;
  let mode: GitExtractMode;
  try {
    mode = modeOf(req.body?.mode);
    plan = await planExtract(idsOf(req.body?.taskIds));
  } catch (e) {
    // 切 SSE 之前的问题一律 JSON，前端按 kind 走行内提示（不弹错误框）
    const { status, body } = errorShape(e);
    return res.status(status).json(body);
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const controller = new AbortController();
  controllers.set(plan.jobId, controller);
  // 客户端断开（刷新/关面板）等同中止：不留一个没人收的 zip 在跑
  res.on('close', () => controller.abort());
  sweepGitExtractTmp();
  try {
    send('job', { jobId: plan.jobId, projects: plan.projects.length, tasks: plan.tasks.length, files: plan.uniquePaths });
    const result = await runExtract(plan, mode, (stage, detail) => send('stage', { stage, ...(detail ? { detail } : {}) }), controller.signal);
    send('done', result);
  } catch (e) {
    if (controller.signal.aborted || e instanceof ExtractError && e.kind === 'aborted') {
      send('aborted', { jobId: plan.jobId, message: '已中止，临时目录已回收' });
    } else {
      const { body } = errorShape(e);
      send('error', body);
    }
  } finally {
    controllers.delete(plan.jobId);
    res.end();
  }
});

/** 中止：掐掉子进程并回收 tmp（幂等——job 已结束也回 ok，前端只需要收掉运行徽标） */
gitExtractApi.post('/git-extract/stop', (req, res) => {
  const jobId = String(req.body?.jobId ?? '').trim();
  const c = controllers.get(jobId);
  if (c) c.abort();
  controllers.delete(jobId);
  res.json({ ok: true, aborted: !!c });
});

/** 一次性令牌下载（下载即删；分卷时每个 token 各下一次） */
gitExtractApi.get('/git-extract/download', (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || !isReportToken(token)) return res.status(400).json({ error: 'token 非法' });
  const name = typeof req.query.name === 'string' && DOWNLOAD_NAME_RE.test(req.query.name) ? req.query.name : 'git-extract.zip';
  const buf = readAndDeleteReport(token);
  if (!buf) return res.status(404).json({ error: '文件已过期或已被下载，请重新生成' });
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const MIME: Record<string, string> = {
    zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    md: 'text/markdown;charset=utf-8',
  };
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
});
