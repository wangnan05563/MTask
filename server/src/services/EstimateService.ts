/**
 * 估算服务（E1 · PRD-估算视图与工作量评估导出 §3.1/§3.2/§4.5）。
 *
 * 本文件只做「数据模型 + 校验 + CRUD」，**不含 PERT 计算**（E2 的 `estimate-engine.ts`）
 * 与路由（E3）。与 `TestCaseService` 同构：snake_case 行 / camelCase 入参 / uuid 主键 /
 * 业务错误 `throw new Error(中文文案)` 由路由 `wrap()` 转 400。
 *
 * 三条刻意口径（都是 PRD 明确项，代码里看不出来就等于没有）：
 *  1. **计划侧不建物理外键**（§3.1 记「FK→plan_tasks」，实测校正为服务层校验，理由写在 `schema.ts` 建表注释）：
 *     `PlanService.purge()` 会物理删除已归档计划，带 FK 时那条 DELETE 直接抛约束错；PRD §7 要求估算行
 *     此时原样保留（历史报价依据），面板按归档态过滤并计「脱离计划」条数（`listDetached`）；
 *  2. **行级校验、整体不入库**（§3.1 约束行）：`optimistic ≤ likely ≤ pessimistic` 且各值 ≥0，
 *     批量通道先全量校验后落库，任一行不合格返回行级错误且零写入（与 `PlanService` Excel 导入同口径）；
 *  3. **单源**：枚举与标签只在本文件定义（§9 可维护项，同 `util/planDeps` 的双口径教训），
 *     前端经 E3 的 meta 接口取用，不各自硬编码。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { notifyChange } from './ChangeBus';
import { buildCalendar, type WorkdayCal } from '../util/workdays';

/** 阶段（§3.1）：与模板 R31/R35~R40 的阶段行对齐，写入非法值直接报错——错归一会让报价人月进错桶 */
export const ESTIMATE_PHASES = ['req', 'design', 'dev', 'impl', 'common', 'onsite'] as const;
export type EstimatePhase = (typeof ESTIMATE_PHASES)[number];
/** 来源标记（§2.3-8 / §4.6）：人工改过即转 manual，面板徽标与上线度量（§9 复核率）都按它出数 */
export const ESTIMATE_SOURCES = ['manual', 'rule', 'default'] as const;
export type EstimateSource = (typeof ESTIMATE_SOURCES)[number];
/** 计量单位（§3.1）：本期只有人天（1 人天 = 8 人时，模板 E4），留列是给 §6 导出的单位行 */
export const ESTIMATE_UNITS = ['man_day'] as const;
export type EstimateUnit = (typeof ESTIMATE_UNITS)[number];
/** 快照格式（§3.2） */
export const ESTIMATE_SNAPSHOT_FORMATS = ['xlsx', 'pdf'] as const;
export type EstimateSnapshotFormat = (typeof ESTIMATE_SNAPSHOT_FORMATS)[number];

/** §3.2：每项目保留最近 20 条（`TaskService.ts:384` 历史裁剪 10 条范式的参数化） */
export const SNAPSHOT_RETAIN = 20;

/** 枚举单源下发给前端/E3 meta 接口的形状 */
export const ESTIMATE_META = {
  phases: ESTIMATE_PHASES,
  phaseLabels: {
    req: '需求分析', design: '系统设计', dev: '开发/研发',
    impl: '实施', common: '公共&远程投入', onsite: '现场维护',
  } as Record<EstimatePhase, string>,
  sources: ESTIMATE_SOURCES,
  units: ESTIMATE_UNITS,
  snapshotFormats: ESTIMATE_SNAPSHOT_FORMATS,
  snapshotRetain: SNAPSHOT_RETAIN,
};

export interface EstimateItemRow {
  id: string;
  project_id: string;
  plan_id: string;
  phase: EstimatePhase;
  unit: EstimateUnit;
  optimistic: number;
  likely: number;
  pessimistic: number;
  source: EstimateSource;
  note: string;
  created_at: string;
  updated_at: string;
}

/** 面板行：估算行 + 计划左联（§3.4 映射表的「工作项标题/排期事实/复杂度」三行） */
export interface EstimateView extends EstimateItemRow {
  planTitle: string;
  planKind: string;
  planArchived: number;
  planStatus: string;
  planProgress: number;
  startDate: string;
  endDate: string;
  durationDays: number;
  complexity: number | null;
  /** 来源计划的最后修改时间——§7「上次导出后 N 条计划已变化」的比对基准（服务端单源，面板不再记时间戳） */
  planUpdatedAt: string;
}

/** 三点入参联合：数字、可转数字的字符串，或 null（PATCH 清空/沿用原值）——重复三处，抽为别名 */
type EstimatePointInput = number | string | null;

/** 录入入参：三点可缺省（PATCH 单字段场景）——新行缺任一即报错，已有行缺省则沿用原值 */
export interface EstimateInput {
  phase?: EstimatePhase;
  unit?: EstimateUnit;
  optimistic?: EstimatePointInput;
  likely?: EstimatePointInput;
  pessimistic?: EstimatePointInput;
  source?: EstimateSource;
  note?: string;
  /** §7 收口里程碑只读行的显式解锁（真值判定走 `unlockFlag`，不散落在各处） */
  unlock?: unknown;
}

export interface EstimateWriteError {
  index: number;
  planId: string;
  message: string;
}

export interface EstimateSnapshotRow {
  id: string;
  project_id: string;
  format: EstimateSnapshotFormat;
  filename: string;
  payload: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

/** 表内 sort_order 缺省 0，计划页与面板同一排序（时间线顺序），不引入第二套次序口径 */
const LIST_ORDER = 'COALESCE(p.sort_order, 0) ASC, p.start_date ASC, e.plan_id ASC';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v).trim();
  // 对象/数组显式序列化，避免 String(obj) 得到 '[object Object]'；JSON 文本无首尾空白，等价于原 .trim()
  return JSON.stringify(v) ?? '';
}

/** §7 显式解锁的真值判定：只认 `1/true/on/yes` 与布尔真——空串、缺省、「0」都算未解锁（不做静默放行） */
export function unlockFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return /^(1|true|on|yes)$/i.test(str(v));
}

/**
 * §7「阶段里程碑收口 → 估算行只读」的唯一判据。
 * 定义放在服务层而不是引擎：写路径闸门（`requirePlan`）与只读读数（引擎 `rowDriftCheck`）必须同语义——
 * 两处各写一份 `kind==='milestone' && done` 的话，改一处就会让「面板显示只读、实际能改」或反之（双口径教训）。
 * 只收**里程碑行**：普通计划行 done 后仍要能补录（四期存量 34/37 行已收口，全挡等于挡死正常录入）。
 */
export function isClosedMilestone(v: { planKind?: string; planStatus?: string; planProgress?: number }): boolean {
  return v.planKind === 'milestone' && (v.planStatus === 'done' || (v.planProgress ?? 0) >= 100);
}

/**
 * §7 剩余排期工作日要用的日历上下文。
 * `PlanService` 里的同名 `loadCalendar()` 是模块私有函数（且该文件正被并发会话改动），
 * 这里不导出第二套语义——直接用 `util/workdays.buildCalendar`（服务端工作日唯一实现）。
 */
export function workdayCalendar(): WorkdayCal {
  const rows = getDb().prepare('SELECT date, kind FROM holidays').all() as Array<{ date: string; kind: string | null }>;
  return buildCalendar(rows);
}

/** 数值取值：未传 → undefined（沿用原值/报必填）；传了但不是数 → NaN（交给 pointsError 报「必须是数字」） */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * 三点校验（§3.1 约束）：有限、≥0、O≤M≤P。返回错误文案或 null。
 * 文案带具体数值——批量 40 行时「校验失败」这类无主语错误没法定位（PlanService 导入的老痛点）。
 */
export function pointsError(o: number, m: number, p: number): string | null {
  const pairs: Array<[number, string]> = [[o, '乐观值 O'], [m, '最可能值 M'], [p, '悲观值 P']];
  for (const [v, label] of pairs) {
    if (Number.isNaN(v)) return `${label}必须是数字`;
    if (v < 0) return `${label}不能为负（当前 ${v}）`;
  }
  if (o > m) return `乐观值 O（${o}）不能大于最可能值 M（${m}）`;
  if (m > p) return `最可能值 M（${m}）不能大于悲观值 P（${p}）`;
  return null;
}

function requireProject(projectId: string): void {
  if (!str(projectId)) throw new Error('projectId 必填');
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
}

/**
 * 计划归属校验：估算行必须挂在同项目的计划条目上（跨项目 planId 是脏数据，不是笔误）。
 *
 * §7「阶段里程碑收口（进度 100%）→ 估算行只读化」在这里落地，而不是在前端置灰：
 * 只读的目的是不让已交付项被追溯改写报价，界面禁用挡不住 MCP、也挡不住下一个批量通道。
 * 范围按 §7 原文只收**里程碑行**（`kind='milestone'` 且 done/100）——普通计划行 done 后仍可补录，
 * 否则四期这种「34/37 行已收口」的存量项目会连正常补录都被挡死（口径见 PRD §7 v2.3）。
 * 确需改写传 `unlock:true`（面板上的「解锁改写」，不做静默放行）。
 */
function requirePlan(
  projectId: string,
  planId: string,
  opts: { unlock?: boolean } = {},
): { id: string; title: string; kind: string; status: string; progress: number } {
  const db = getDb();
  if (!str(projectId)) throw new Error('projectId 必填');
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
  if (!str(planId)) throw new Error('planId 必填');
  const p = db
    .prepare('SELECT id, project_id, title, kind, status, progress FROM plan_tasks WHERE id = ?')
    .get(planId) as
    | { id: string; project_id: string; title: string; kind: string; status: string; progress: number }
    | undefined;
  if (!p) throw new Error(`计划条目不存在：${planId}`);
  if (p.project_id !== projectId) throw new Error(`计划「${p.title}」不属于该项目`);
  const closed = isClosedMilestone({ planKind: p.kind, planStatus: p.status, planProgress: p.progress });
  if (closed && !opts.unlock) {
    throw new Error(`里程碑「${p.title}」已收口（进度 ${p.progress ?? 0}%），其估算行只读——已交付项不得追溯改写报价（§7）；确需改写请显式解锁`);
  }
  return p;
}

/**
 * 单行解析：合并已有行（PATCH 语义）+ 全量校验，返回可直接落库的行。
 * 校验失败抛中文 Error——批量通道 catch 后转成 {@link EstimateWriteError} 行级错误。
 */
function resolveItem(
  projectId: string,
  planId: string,
  input: EstimateInput,
): Omit<EstimateItemRow, 'id' | 'created_at'> {
  requirePlan(projectId, planId, { unlock: unlockFlag(input.unlock) });
  const db = getDb();
  const prev = db
    .prepare('SELECT * FROM estimate_items WHERE project_id = ? AND plan_id = ?')
    .get(projectId, planId) as EstimateItemRow | undefined;

  const o = num(input.optimistic) ?? prev?.optimistic;
  const m = num(input.likely) ?? prev?.likely;
  const p = num(input.pessimistic) ?? prev?.pessimistic;
  if (o === undefined || m === undefined || p === undefined) {
    throw new Error('乐观值 O / 最可能值 M / 悲观值 P 必填（该计划尚无估算行）');
  }
  const err = pointsError(o, m, p);
  if (err) throw new Error(err);

  if (input.phase !== undefined) {
    const phase = String(input.phase);
    if (!(ESTIMATE_PHASES as readonly string[]).includes(phase)) {
      throw new Error(`未知阶段：${phase}（可用 ${ESTIMATE_PHASES.join(' / ')}）`);
    }
  }
  if (input.unit !== undefined) {
    const unit = String(input.unit);
    if (!(ESTIMATE_UNITS as readonly string[]).includes(unit)) {
      throw new Error(`未知计量单位：${unit}（本期仅 ${ESTIMATE_UNITS.join(' / ')}）`);
    }
  }
  // source 非法回落 manual：它来自 AI/批量通道，纠正比 500 可用（同 TestCaseService 枚举口径）
  const src = input.source === undefined ? (prev?.source ?? 'manual') : String(input.source);
  const source: EstimateSource = (ESTIMATE_SOURCES as readonly string[]).includes(src)
    ? (src as EstimateSource)
    : 'manual';

  return {
    project_id: projectId,
    plan_id: planId,
    phase: (input.phase as EstimatePhase) ?? prev?.phase ?? 'dev',
    unit: (input.unit as EstimateUnit) ?? prev?.unit ?? 'man_day',
    optimistic: o,
    likely: m,
    pessimistic: p,
    source,
    note: input.note === undefined ? (prev?.note ?? '') : str(input.note),
    updated_at: now(),
  };
}

/** 落库（唯一索引 (project_id, plan_id) 兜住并发重号：命中即改为更新，不报 UNIQUE 约束错） */
function writeItem(row: Omit<EstimateItemRow, 'id' | 'created_at'>): EstimateItemRow {
  const db = getDb();
  const t = row.updated_at;
  const prev = db
    .prepare('SELECT id, created_at FROM estimate_items WHERE project_id = ? AND plan_id = ?')
    .get(row.project_id, row.plan_id) as { id: string; created_at: string } | undefined;
  if (prev) {
    db.prepare(
      `UPDATE estimate_items
         SET phase = ?, unit = ?, optimistic = ?, likely = ?, pessimistic = ?, source = ?, note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(row.phase, row.unit, row.optimistic, row.likely, row.pessimistic, row.source, row.note, t, prev.id);
    return { ...row, id: prev.id, created_at: prev.created_at };
  }
  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO estimate_items
         (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, row.project_id, row.plan_id, row.phase, row.unit, row.optimistic, row.likely,
      row.pessimistic, row.source, row.note, t, t);
  } catch (e) {
    // 并发/重复提交撞上唯一索引时转成用户可读文案（ SQLITE_CONSTRAINT 原文含列名，不便直接抛给前端）
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new Error(`该计划已存在估算行，请刷新后重试（plan_id=${row.plan_id}）`);
    }
    throw e;
  }
  return { ...row, id, created_at: t };
}

function toView(row: EstimateItemRow & Partial<Omit<EstimateView, keyof EstimateItemRow>>): EstimateView {
  return {
    ...row,
    planTitle: row.planTitle ?? '',
    planKind: row.planKind ?? 'normal',
    planArchived: row.planArchived ?? 0,
    planStatus: row.planStatus ?? 'todo',
    planProgress: row.planProgress ?? 0,
    startDate: row.startDate ?? '',
    endDate: row.endDate ?? '',
    durationDays: row.durationDays ?? 1,
    complexity: row.complexity ?? null,
    planUpdatedAt: row.planUpdatedAt ?? '',
  };
}

const VIEW_FROM = `
  SELECT e.*,
         p.title AS planTitle, p.kind AS planKind, p.archived AS planArchived,
         p.status AS planStatus, p.progress AS planProgress,
         p.start_date AS startDate, p.end_date AS endDate, p.duration_days AS durationDays,
         p.complexity AS complexity, p.updated_at AS planUpdatedAt
    FROM estimate_items e
    JOIN plan_tasks p ON p.id = e.plan_id`;

type JoinedRow = EstimateItemRow & Partial<Omit<EstimateView, keyof EstimateItemRow>>;

/** 按 (project, plan) 取视图行——`upsert` 回读与 `getForPlan` 共用，避免两处各写一遍 JOIN */
function loadView(projectId: string, planId: string): EstimateView | null {
  const row = getDb()
    .prepare(`${VIEW_FROM} WHERE e.project_id = ? AND e.plan_id = ?`)
    .get(projectId, planId) as JoinedRow | undefined;
  return row ? toView(row) : null;
}

export const EstimateService = {
  /**
   * 整项目估算明细（含计划左联）。默认排除已归档计划（§3.1 B5 的视图层过滤）——
   * 归档行留在库里供历史报价复核，但不进面板、不进 Σ。
   */
  listByProject(projectId: string, opts: { includeArchived?: boolean } = {}): EstimateView[] {
    requireProject(projectId);
    const db = getDb();
    const where = opts.includeArchived
      ? ' WHERE e.project_id = ?'
      : ' WHERE e.project_id = ? AND COALESCE(p.archived, 0) = 0';
    return (db.prepare(`${VIEW_FROM}${where} ORDER BY ${LIST_ORDER}`).all(projectId) as JoinedRow[]).map(toView);
  },

  /** 单计划视图行（无估算行返回 null，供偏差徽标/区间条按行取数） */
  getForPlan(projectId: string, planId: string): EstimateView | null {
    requireProject(projectId);
    return loadView(projectId, planId);
  },

  /**
   * §7「上次导出后计划已变化」的取数口：**全量在架计划**（含尚无估算行的），每条带计划与估算两侧的
   * 最后修改时间。之所以单开一个查询而不是复用 `listByProject`：后者以 `estimate_items` 为主表，
   * 未录入的计划根本不在结果里，而那类计划恰恰是「导出后又排了期」最常见的变更来源。
   */
  plansForDrift(projectId: string): Array<{
    planId: string; title: string; kind: string; status: string; progress: number;
    planUpdatedAt: string; estimateUpdatedAt: string;
  }> {
    requireProject(projectId);
    return getDb()
      .prepare(
        `SELECT p.id AS planId, p.title, p.kind, p.status, p.progress,
                p.updated_at AS planUpdatedAt, e.updated_at AS estimateUpdatedAt
           FROM plan_tasks p
           LEFT JOIN estimate_items e ON e.plan_id = p.id AND e.project_id = p.project_id
          WHERE p.project_id = ? AND COALESCE(p.archived, 0) = 0
          ORDER BY COALESCE(p.sort_order, 0) ASC, p.start_date ASC, p.id ASC`,
      )
      .all(projectId) as Array<{
        planId: string; title: string; kind: string; status: string; progress: number;
        planUpdatedAt: string; estimateUpdatedAt: string;
      }>;
  },

  /** 单行录入（§8 PATCH 语义）：三点缺省时沿用原值，新行必须给全 */
  upsert(projectId: string, planId: string, input: EstimateInput): EstimateView {
    const written = writeItem(resolveItem(projectId, planId, input));
    notifyChange('plans');
    const view = loadView(projectId, written.plan_id);
    if (!view) throw new Error('估算行写入后回读失败（不应发生）');
    return view;
  },

  /**
   * 批量写入（§8 batch）：先逐行解析+校验，**任一行不合格则零写入**并回传行级错误
   * （§3.1 与 Excel 导入同口径）；全通过再单事务落库。
   */
  upsertBatch(
    projectId: string,
    items: Array<{ planId: string } & EstimateInput>,
  ): { written: number; errors: EstimateWriteError[] } {
    requireProject(projectId);
    if (!Array.isArray(items) || items.length === 0) throw new Error('批量写入内容为空');
    const errors: EstimateWriteError[] = [];
    const rows: Array<Omit<EstimateItemRow, 'id' | 'created_at'>> = [];
    items.forEach((it, index) => {
      try {
        rows.push(resolveItem(projectId, it.planId, it));
      } catch (e) {
        errors.push({ index, planId: str(it?.planId), message: (e as Error).message });
      }
    });
    if (errors.length > 0) return { written: 0, errors };
    const db = getDb();
    db.transaction(() => { rows.forEach((r) => writeItem(r)); })();
    notifyChange('plans');
    return { written: rows.length, errors: [] };
  },

  /** 删除某计划的估算行（§9 数据一致：删除估算不影响 plan_tasks，反之删计划也不删这里的行） */
  remove(projectId: string, planId: string, opts: { unlock?: boolean } = {}): boolean {
    requireProject(projectId);
    requirePlan(projectId, planId, opts);
    const db = getDb();
    const info = db
      .prepare('DELETE FROM estimate_items WHERE project_id = ? AND plan_id = ?')
      .run(projectId, planId);
    if (info.changes === 0) return false;
    notifyChange('plans');
    return true;
  },

  /**
   * 「脱离计划」的估算行（§7：计划被彻底删除后估算**原样保留**，面板提示「有 N 条估算已脱离计划」）。
   * `listByProject` 走 INNER JOIN 天然看不到它们，故单开 LEFT JOIN 反查通道。
   */
  listDetached(projectId: string): EstimateItemRow[] {
    requireProject(projectId);
    return getDb()
      .prepare(
        `SELECT e.* FROM estimate_items e
           LEFT JOIN plan_tasks p ON p.id = e.plan_id
          WHERE e.project_id = ? AND p.id IS NULL
          ORDER BY e.updated_at DESC`,
      )
      .all(projectId) as EstimateItemRow[];
  },

  /** 显式清理脱离行（§7「清理为显式手动操作」）：只删确属该项目且已脱离的行，其余跳过并如实计数 */
  removeDetached(projectId: string, ids: string[]): number {
    requireProject(projectId);
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('未选择要清理的估算行');
    const db = getDb();
    const findOrphan = db.prepare(
      `SELECT e.id FROM estimate_items e
         LEFT JOIN plan_tasks p ON p.id = e.plan_id
        WHERE e.id = ? AND e.project_id = ? AND p.id IS NULL`,
    );
    const del = db.prepare('DELETE FROM estimate_items WHERE id = ? AND project_id = ?');
    let removed = 0;
    db.transaction(() => {
      for (const id of ids) {
        if (!str(id)) continue;
        if (findOrphan.get(id, projectId)) removed += del.run(id, projectId).changes;
      }
    })();
    if (removed > 0) notifyChange('plans');
    return removed;
  },

  /**
   * 快照留档（§3.2）：payload 存汇总结果 JSON（各 phase 的 E/σ/比例 + 系数 + 合计），
   * **不存原始三点**（原始以 estimate_items 为准）。超出 SNAPSHOT_RETAIN 裁最旧的。
   */
  createSnapshot(
    projectId: string,
    input: { format: EstimateSnapshotFormat; filename?: string; payload: unknown },
  ): EstimateSnapshotRow {
    requireProject(projectId);
    const fmt = String(input.format);
    if (!(ESTIMATE_SNAPSHOT_FORMATS as readonly string[]).includes(fmt)) {
      throw new Error(`未知导出格式：${fmt}（可用 ${ESTIMATE_SNAPSHOT_FORMATS.join(' / ')}）`);
    }
    let payload: string;
    try {
      payload = JSON.stringify(input.payload ?? {});
    } catch {
      throw new Error('快照 payload 无法序列化为 JSON');
    }
    const db = getDb();
    const id = uuid();
    const t = now();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO estimate_snapshots (id, project_id, format, filename, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, projectId, fmt, str(input.filename), payload, t);
      db.prepare(
        `DELETE FROM estimate_snapshots
          WHERE project_id = ? AND id NOT IN (
            SELECT id FROM estimate_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ${SNAPSHOT_RETAIN}
          )`,
      ).run(projectId, projectId);
    })();
    return db.prepare('SELECT * FROM estimate_snapshots WHERE id = ?').get(id) as EstimateSnapshotRow;
  },

  /** 最近快照列表（§8 snapshots）：payload 原文返回，前端按需解析比对 */
  listSnapshots(projectId: string, limit = SNAPSHOT_RETAIN): EstimateSnapshotRow[] {
    requireProject(projectId);
    const n = Math.max(1, Math.min(SNAPSHOT_RETAIN, Math.trunc(Number(limit)) || SNAPSHOT_RETAIN));
    return getDb()
      .prepare('SELECT * FROM estimate_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, n) as EstimateSnapshotRow[];
  },
};
