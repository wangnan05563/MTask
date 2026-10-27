/**
 * 迭代路由（T03186 / PRD PM-201）。
 *
 * 路径同时含项目级 `/projects/:id/iterations` 与对象级 `/iterations/:id`，
 * 故本路由按完整路径声明并整体挂载（`api.use(iterationApi)`），不挂前缀——
 * 挂前缀会让其中一半路径变形，`/projects` 前缀又会与既有项目路由抢匹配顺序。
 * 错误口径沿用计划模块：业务校验失败 → 400 + `{ error }`（与 `routes/plans.ts` 的 wrap 同形）。
 */
import { Router } from 'express';
import { IterationService } from '../services/IterationService';
import type { IterationStatus } from '../services/IterationService';

export const iterationApi = Router();

/** 统一错误包装：业务错误 → 400 + { error }（与 plans.ts 一致，不另造状态码语义） */
function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

function body(req: import('express').Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function optStr(v: unknown): string | undefined {
  return v == null || v === '' ? undefined : String(v);
}

/** 计划行 id 数组：只接受字符串数组，其它类型按空处理（避免把对象塞进 SQL 参数位） */
function idList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

function boolish(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// ---------- 项目级 ----------

iterationApi.get('/projects/:id/iterations', (req, res) => {
  wrap(res, () => IterationService.list(req.params.id, { includeArchived: boolish(req.query.includeArchived) }));
});

iterationApi.post('/projects/:id/iterations', (req, res) => {
  const b = body(req);
  wrap(res, () => IterationService.create(req.params.id, {
    name: str(b.name),
    goal: optStr(b.goal),
    dod: optStr(b.dod),
    startDate: str(b.startDate ?? b.start_date),
    endDate: str(b.endDate ?? b.end_date),
    status: (optStr(b.status) as IterationStatus | undefined) ?? undefined,
  }));
});

/** 项目燃尽（无迭代归属时的整体口径）：窗口缺省取计划包络 */
iterationApi.get('/projects/:id/burndown', (req, res) => {
  wrap(res, () => IterationService.projectBurndown(req.params.id, optStr(req.query.from), optStr(req.query.to)));
});

// ---------- 对象级 ----------

iterationApi.get('/iterations/:id', (req, res) => {
  const row = IterationService.get(req.params.id);
  if (!row) { res.status(404).json({ error: '迭代不存在' }); return; }
  res.json(row);
});

iterationApi.put('/iterations/:id', (req, res) => {
  const b = body(req);
  wrap(res, () => IterationService.update(req.params.id, {
    name: b.name === undefined ? undefined : str(b.name),
    goal: b.goal === undefined ? undefined : str(b.goal),
    dod: b.dod === undefined ? undefined : str(b.dod),
    startDate: b.startDate === undefined && b.start_date === undefined ? undefined : str(b.startDate ?? b.start_date),
    endDate: b.endDate === undefined && b.end_date === undefined ? undefined : str(b.endDate ?? b.end_date),
    status: (optStr(b.status) as IterationStatus | undefined) ?? undefined,
  }));
});

/** 删除=仅解绑（详细设计 §3.3）：计划行不删，事件流保留 */
iterationApi.delete('/iterations/:id', (req, res) => {
  wrap(res, () => IterationService.remove(req.params.id));
});

iterationApi.post('/iterations/:id/archive', (req, res) => wrap(res, () => ({ archived: IterationService.archive(req.params.id) })));
iterationApi.post('/iterations/:id/unarchive', (req, res) => wrap(res, () => ({ archived: !IterationService.unarchive(req.params.id) })));

iterationApi.post('/iterations/:id/attach', (req, res) => {
  const b = body(req);
  const mode = str(b.mode) === 'replace' ? 'replace' : 'add';
  wrap(res, () => IterationService.attach(req.params.id, idList(b.planTaskIds ?? b.plan_task_ids), mode));
});

iterationApi.post('/iterations/:id/detach', (req, res) => {
  wrap(res, () => IterationService.detach(req.params.id, idList(body(req).planTaskIds ?? body(req).plan_task_ids)));
});

iterationApi.get('/iterations/:id/burndown', (req, res) => wrap(res, () => IterationService.burndown(req.params.id)));
iterationApi.get('/iterations/:id/summary', (req, res) => wrap(res, () => IterationService.summary(req.params.id)));
iterationApi.get('/iterations/:id/events', (req, res) => wrap(res, () => IterationService.events(req.params.id)));

// T03227（PM-201⑥）：周报卡。GET 只读当前卡（无则 { card: null }），POST 幂等发布，
// 重复 POST 返回既有卡 + created=false——前端据此可原样把回执显示给用户，不制造第二张卡。
iterationApi.get('/iterations/:id/weekly-card', (req, res) => wrap(res, () => ({ card: IterationService.weeklyCard(req.params.id) })));
iterationApi.post('/iterations/:id/weekly-card', (req, res) => wrap(res, () => IterationService.publishWeeklyCard(req.params.id)));

/**
 * T03227：跨结束日补生成的显式入口。生产路径由 `index.ts` 启动时自动调用一次；
 * 本路由存在只为让验收门/联调能对同一套代码断言「重复调用不产生第二张卡」——
 * 若只有内部定时器可触发，验收就只能读启动日志，那是把「仅一份」写进日志而不是写进断言。
 */
iterationApi.post('/iterations/backfill-weekly-cards', (_req, res) => wrap(res, () => IterationService.backfillWeeklyCards()));
