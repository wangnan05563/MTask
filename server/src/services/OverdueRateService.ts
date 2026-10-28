/**
 * T03190（PRD G-4 / 7.2）：计划逾期率基线出数。
 *
 * 口径（G-4 原文）：逾期率 = 统计日已到期且未完成的有效计划数 ÷ 统计日已到期有效计划数；另展示逾期数量。
 * - 「已到期」复用 D-12 的 `isPastEndDate`：**边界日当天不算到期**，分子分母共用同一时间契约；
 * - 无 `end_date`/非法日期、已归档计划不进分母；计划行物理删除后天然不在库内；
 * - 分母为 0 时 `rate=null` + 「暂无可比计划」，绝不把缺失报成 0%；
 * - **不伪造历史**：季度环比需要历史快照，等 PM-205（T03236）日快照上线后按快照出数，
 *   本服务只负责「此刻可观测」的同一口径读数（快照写入口上线后可直接复用本函数）。
 */
import { getDb } from '../db/connection';
import { isPastEndDate, isRealYmd, systemTz, ymdInTimezone } from '../util/workdays';
import { resolveProjectTz } from './ProjectTimeZone'; // T03268：单项目口径取项目时区，全局口径取系统时区

// T03265：时区取数与其他出数面共用一个实现；保留本模块的导出路径，旧调用方无需改动
export { systemTz };

export interface OverdueRateBucket {
  dueTotal: number;   // 分母：统计日已到期的有效计划数
  overdue: number;    // 分子：其中未完成
  doneDue: number;    // 已到期且已完成（用于核对分子分母关系）
  rate: number | null; // 0..1；分母为 0 时为 null（缺失 ≠ 0）
}

export interface OverdueProjectRow extends OverdueRateBucket {
  projectId: string;
  projectName: string;
}

export interface OverdueRateReport {
  /** 统计日（YYYY-MM-DD，入参 or 今天，按项目/系统时区） */
  at: string;
  tz: string;
  overall: OverdueRateBucket;
  projects: OverdueProjectRow[];
  note: string;
}

/** 比率保留 4 位小数（0..1 口径，与 G-2 卡片覆盖率的 ratio 一致） */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export class OverdueRateService {
  static report(args: { at?: string; projectId?: string } = {}): OverdueRateReport {
    const db = getDb();
    // T03268：projectId 口径用项目时区；未指定项目（全局视图）沿用系统时区
    const { tz } = resolveProjectTz(args.projectId);
    if (args.at && !isRealYmd(args.at)) throw new Error(`at 需为 YYYY-MM-DD，收到：${args.at}`);
    // D-12：显式 at 就是业务日本身，直接按日期比较到期；未给 at 才把「此刻」按项目时区折成日历日。
    // 旧写法 `new Date(`${at}T12:00:00`)` 走系统本地正午再换算到项目时区：系统 Asia/Shanghai、项目
    // America/New_York 时本地正午折过去是前一天 23:00，统计日会整体退一天（T03268 修）
    const now = new Date();
    const at = args.at ?? ymdInTimezone(now, tz);
    const isPast = (endDate: string) => (args.at
      ? isRealYmd(endDate || '') && endDate < at
      : isPastEndDate(endDate, now, tz));

    if (args.projectId && !db.prepare('SELECT id FROM projects WHERE id = ?').get(args.projectId)) {
      throw new Error('项目不存在');
    }
    const rows = db.prepare(
      `SELECT t.project_id, p.name AS project_name, t.end_date, t.status
         FROM plan_tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.archived = 0${args.projectId ? ' AND t.project_id = ?' : ''}`,
    ).all(...(args.projectId ? [args.projectId] : [])) as Array<{
      project_id: string; project_name: string; end_date: string; status: string;
    }>;

    const byProject = new Map<string, { name: string; dueTotal: number; overdue: number }>();
    for (const r of rows) {
      // 未到期 / 无日期 / 归档（SQL 已排）→ 不进分母；边界日当天 isPast 为 false，同样不进
      if (!isPast(r.end_date)) continue;
      const agg = byProject.get(r.project_id) ?? { name: r.project_name, dueTotal: 0, overdue: 0 };
      agg.dueTotal += 1;
      if (r.status !== 'done') agg.overdue += 1;
      byProject.set(r.project_id, agg);
    }

    const projects: OverdueProjectRow[] = Array.from(byProject.entries())
      .map(([projectId, a]) => ({
        projectId,
        projectName: a.name,
        dueTotal: a.dueTotal,
        overdue: a.overdue,
        doneDue: a.dueTotal - a.overdue,
        rate: ratio(a.overdue, a.dueTotal),
      }))
      .sort((a, b) => b.dueTotal - a.dueTotal || a.projectName.localeCompare(b.projectName));

    const dueTotal = projects.reduce((s, p) => s + p.dueTotal, 0);
    const overdue = projects.reduce((s, p) => s + p.overdue, 0);
    return {
      at,
      tz,
      overall: { dueTotal, overdue, doneDue: dueTotal - overdue, rate: ratio(overdue, dueTotal) },
      projects,
      note: dueTotal === 0
        ? '统计日没有已到期的有效计划，暂无可比计划'
        : '口径：已到期且未完成 ÷ 已到期有效计划；边界日当天不算到期（D-12），无日期/已归档计划不进分母',
    };
  }
}
