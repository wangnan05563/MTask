import { Router } from 'express';
import { DbAdminService } from '../services/DbAdminService';
import { exportGate } from '../util/export-gate'; // T00789：导出类端点并发闸

/**
 * 数据库维护路由（设置 > 数据维护 Tab）。参考 17_xianyu api_db_admin 的等效 Express 实现。
 * 写操作由前端二次确认（输入 CONFIRM_DELETE）；此处只做参数校验与统一错误包装。
 */
export const dbAdminApi = Router();

/** 统一错误包装：业务错误 → 400 + { error } */
function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------- 表清单 / 结构 ----------
dbAdminApi.get('/tables', (_req, res) => wrap(res, () => DbAdminService.listTables()));

dbAdminApi.get('/tables/:table/schema', (req, res) => wrap(res, () => DbAdminService.getColumns(req.params.table)));

// ---------- 行数据 ----------
dbAdminApi.get('/tables/:table/rows', (req, res) =>
  wrap(res, () =>
    DbAdminService.listRows(req.params.table, {
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      orderBy: typeof req.query.order_by === 'string' ? req.query.order_by : undefined,
    }),
  ),
);

dbAdminApi.post('/tables/:table/rows', (req, res) => wrap(res, () => DbAdminService.insertRow(req.params.table, req.body ?? {})));

dbAdminApi.patch('/tables/:table/rows/:pk', (req, res) =>
  wrap(res, () => DbAdminService.updateRow(req.params.table, req.params.pk, req.body ?? {})),
);

dbAdminApi.delete('/tables/:table/rows/:pk', (req, res) => wrap(res, () => DbAdminService.deleteRow(req.params.table, req.params.pk)));

dbAdminApi.post('/tables/:table/batch-delete', (req, res) => {
  const { pks } = (req.body ?? {}) as { pks?: unknown };
  if (!Array.isArray(pks) || pks.length === 0) return res.status(400).json({ error: 'pks 必填（主键数组）' });
  wrap(res, () => DbAdminService.batchDelete(req.params.table, pks.map(String)));
});

// ---------- 导入 / 导出 ----------
dbAdminApi.post('/tables/:table/import', (req, res) => {
  const { rows } = (req.body ?? {}) as { rows?: unknown };
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows 必填（对象数组）' });
  if (rows.length > 5000) return res.status(400).json({ error: '单次导入上限 5000 行' });
  wrap(res, () => DbAdminService.importRows(req.params.table, rows as Record<string, unknown>[]));
});

// T00789：全表导出为同步重活（db.prepare().all() + map，无 await）→ defer 让出事件循环，
// 否则同步执行期间无法接受后续请求，闸门计数永远到不了上限（见 export-gate.ts 注释）
dbAdminApi.get('/tables/:table/export', exportGate('dbadmin-export', undefined, { defer: true }), (req, res) => wrap(res, () => DbAdminService.exportRows(req.params.table)));
