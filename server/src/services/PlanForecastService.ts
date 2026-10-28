/**
 * T03258（PRD AI-204 / D-03 / D-12）：周/月报「计划预测逾期清单」——普通计划行时间进度模型。
 *
 * 与 PM-204 里程碑模型**分开维护**（对象不同，不套同一公式），但共用 `util/workdays` 的
 * 业务日/边界日/缺失值/工作日推进原语（D-03）。
 *
 * 模型（可解释、可复算，`model='plan-time-pace-v1'`）：
 * 1. 只统计未完成（`status!=='done'` 且 `progress<100`）且有合法起止日期的计划行；
 * 2. 时间已过比例 = `[start, min(业务日, end)]` 工作日 ÷ `[start, end]` 工作日（上限 100%）；
 * 3. 速度为 0（进度 0%）或时间尚未流逝时不外推，按原计划结束日；
 * 4. 其余按「完成比例 ÷ 已过工作日」外推剩余 `ceil(已过 × (1−p) ÷ p)` 个工作日，
 *    从业务日起**含当天**排期，落点即预测完成日（与 PM-204 同一「含当天」口径）；
 * 5. 只有「预测完成日 > 计划结束日」的未完成计划进入清单；无排期、未开始不外推（缺失 ≠ 0）；
 * 6. 同一业务日 + 同一数据 + 同一 holidays 表 → 同输出（纯计算，无随机、无历史回溯）。
 *
 * 口径只到**计划行**：PRD 明确本期不引入任务级截止日，文案不得表述为任务级到期。
 */
import {
  advanceWorkdaysInclusive, countWorkdaysBetween, isWorkday, parseYmd, type WorkdayCal,
} from '../util/workdays';

export type PlanForecastVerdict = 'predicted-late' | 'on-track' | 'not-started' | 'done' | 'missing-schedule';

export interface PlanForecastInput {
  title: string;
  project: string;
  status: string;
  startDate: string;
  endDate: string;
  progress: number;
}

export interface PlanForecastItem {
  title: string;
  project: string;
  status: string;
  startDate: string;
  endDate: string;
  /** 完成进度 0..100（原值 clamp） */
  progress: number;
  /** 时间已过比例 0..1 */
  timeElapsedRatio: number;
  elapsedWorkdays: number;
  totalWorkdays: number;
  /** 外推剩余工作日；速度为 0 时按原计划剩余（已过结束日则为 0） */
  remainingWorkdays: number;
  forecastDate: string;
  /** 已过计划结束日（边界日当天不算） */
  alreadyOverdue: boolean;
  verdict: PlanForecastVerdict;
  /** 逐条依据：时间比例 vs 完成进度 + 外推过程 */
  basis: string;
}

export interface PlanForecastSection {
  at: string;
  tz: string;
  model: 'plan-time-pace-v1';
  /** 「预测值，非承诺」恒随出数返回 */
  disclaimer: string;
  /** 仅预测晚于计划结束日且未完成的计划 */
  items: PlanForecastItem[];
  note: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clampProgress = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
const pct = (v: number): number => Math.round(v * 1000) / 10;

function basisOf(f: {
  alreadyOverdue: boolean; timeElapsedRatio: number; elapsedWorkdays: number; totalWorkdays: number;
  progress: number; remainingWorkdays: number; forecastDate: string; noPace: boolean;
}): string {
  const head = f.alreadyOverdue ? '已过计划结束日；' : '';
  const time = `时间已过 ${pct(f.timeElapsedRatio)}%（${f.elapsedWorkdays}/${f.totalWorkdays} 个工作日），完成 ${f.progress}%`;
  if (f.noPace) {
    return `${head}${time}；进度 0% 无速度可外推，按原计划结束日 ${f.forecastDate} 计`;
  }
  return `${head}${time}；按当前速度外推还需 ${f.remainingWorkdays} 个工作日，预测 ${f.forecastDate}`;
}

/**
 * 单个计划行的预测。返回 null 表示该行不参与清单（已完成 / 未开始 / 缺排期）。
 * `at` 为业务日（D-12：项目未配置时区则系统时区），调用方负责换算。
 */
export function forecastPlanRow(row: PlanForecastInput, at: string, cal: WorkdayCal): PlanForecastItem | null {
  if (!DATE_RE.test(at)) return null;
  const progress = clampProgress(Number(row.progress));
  if (row.status === 'done' || progress >= 100) return null;
  if (!DATE_RE.test(row.startDate || '') || !DATE_RE.test(row.endDate || '')) return null;
  if (row.startDate > row.endDate) return null;
  // 未开始：没有已过时间，宁可不预测也不凭空造数
  if (at < row.startDate) return null;

  const totalWorkdays = countWorkdaysBetween(row.startDate, row.endDate, cal);
  if (totalWorkdays <= 0) return null;
  const elapsedTo = at > row.endDate ? row.endDate : at;
  const elapsedWorkdays = countWorkdaysBetween(row.startDate, elapsedTo, cal);
  if (elapsedWorkdays <= 0) return null;
  const timeElapsedRatio = Math.min(1, elapsedWorkdays / totalWorkdays);
  const p = progress / 100;
  const alreadyOverdue = row.endDate < at;

  let remainingWorkdays: number;
  let forecastDate: string;
  const noPace = p <= 0;
  if (noPace) {
    remainingWorkdays = countWorkdaysBetween(at, row.endDate, cal);
    forecastDate = alreadyOverdue ? at : row.endDate;
  } else {
    // 速度为 0 之外的外推：已过 N 个工作日做完 p，总需 N/p，剩余 = ceil(N × (100−progress) ÷ progress)
    // 用百分数做整数分子，避免 0.8/0.2 这类浮点把 12 算成 12.000000000000002 → 13
    remainingWorkdays = Math.max(1, Math.ceil((elapsedWorkdays * (100 - progress)) / progress));
    forecastDate = advanceWorkdaysInclusive(at, remainingWorkdays, cal);
  }

  const verdict: PlanForecastVerdict = forecastDate > row.endDate ? 'predicted-late' : 'on-track';
  const item: PlanForecastItem = {
    title: row.title,
    project: row.project,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    progress,
    timeElapsedRatio,
    elapsedWorkdays,
    totalWorkdays,
    remainingWorkdays,
    forecastDate,
    alreadyOverdue,
    verdict,
    basis: basisOf({
      alreadyOverdue, timeElapsedRatio, elapsedWorkdays, totalWorkdays, progress, remainingWorkdays, forecastDate, noPace,
    }),
  };
  return item;
}

/** 汇总清单：只保留预测逾期的行；无行时消费侧不得渲染空节 */
export function buildPlanForecastSection(
  rows: PlanForecastInput[],
  opts: { at: string; tz: string; cal: WorkdayCal },
): PlanForecastSection {
  const items = rows
    .map((r) => forecastPlanRow(r, opts.at, opts.cal))
    .filter((x): x is PlanForecastItem => x !== null && x.verdict === 'predicted-late')
    .sort((a, b) => b.forecastDate.localeCompare(a.forecastDate)
      || a.project.localeCompare(b.project, 'zh-Hans-CN')
      || a.title.localeCompare(b.title, 'zh-Hans-CN'));
  return {
    at: opts.at,
    tz: opts.tz,
    model: 'plan-time-pace-v1',
    disclaimer: '预测值，非承诺',
    items,
    note: items.length > 0
      ? '口径：时间已过比例按工作日计，完成进度取计划当前 progress；仅列预测完成日晚于计划结束日的未完成计划'
      : '本周期没有预测逾期且未完成的计划',
  };
}
