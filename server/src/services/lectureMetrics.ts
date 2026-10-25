/**
 * T02877（六期 4.1，PRD §8.1）：讲稿指标口径单源。
 *
 * PRD 的三条产品指标（生成成功率 ≥90%、锚点覆盖率 ≥85%、导出率 ≥40%）与两条时效指标
 * （预检 ≤3s、单节首字 ≤8s）在这里给出**可复算的定义**：上线后观测与验收门读同一份口径，
 * 避免「面板显示一个数、验收脚本算另一个数」。
 *
 * E-4 明确本期不落库，故本模块只做纯聚合：输入是会话记录（由调用方从控制台流/导出动作收集），
 * 不读写数据库、不常驻状态。
 */

export interface LectureMetricSection {
  ok: boolean;
  text: string;
  anchors: number;
}

/** 一次生成会话的观测记录（status 与流式结果口径一致） */
export interface LectureSessionRecord {
  sessionId: string;
  status: 'done' | 'aborted' | 'error';
  sections: LectureMetricSection[];
  /** 该会话触发的导出次数（≥1 即算「完成生成后触发导出」） */
  exports: number;
}

export interface LectureMetricTargets {
  successRate: number;
  anchorCoverage: number;
  exportRate: number;
}

/** PRD §8.1 目标值（2026-10-24 批准版） */
export const LECTURE_METRIC_TARGETS: LectureMetricTargets = { successRate: 0.9, anchorCoverage: 0.85, exportRate: 0.4 };

export interface LectureMetricsSummary {
  sessions: number;
  doneSessions: number;
  successRate: number;
  anchorItems: number;
  anchoredItems: number;
  anchorCoverage: number;
  exportedSessions: number;
  exportRate: number;
  targets: LectureMetricTargets;
  meets: { successRate: boolean; anchorCoverage: boolean; exportRate: boolean };
  /** 三条硬指标是否全部达标（时效指标不在此列，由验收门单独计时） */
  allMet: boolean;
}

/** 与服务端 `lectureService.ANCHOR_RE` / 前端 `LECTURE_ANCHOR_RE` 同形 */
const ANCHOR_RE = /\[([^[\]#\s]+)#L(\d+)(?:-L(\d+))?\]/;
const HEADING_RE = /^\s*#{1,6}\s/;
const QUOTE_RE = /^\s*>/;

/** 一条「讲解条目」＝非空、非标题、非引用的正文行（列表项与陈述句都算） */
export function isLectureItemLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && !HEADING_RE.test(t) && !QUOTE_RE.test(t);
}

/** 单节锚点覆盖：带 `[file#Lx-Ly]` 的条目 / 全部条目 */
export function anchorItemCoverage(text: string): { items: number; anchored: number; ratio: number } {
  let items = 0;
  let anchored = 0;
  for (const line of (text ?? '').split('\n')) {
    if (!isLectureItemLine(line)) continue;
    items += 1;
    if (ANCHOR_RE.test(line)) anchored += 1;
  }
  return { items, anchored, ratio: items === 0 ? 0 : anchored / items };
}

const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

/** 汇总会话记录：成功率、锚点覆盖率、导出率与达标判定（除零一律 0，不产生 NaN） */
export function summarizeLectureMetrics(
  records: readonly LectureSessionRecord[],
  targets: LectureMetricTargets = LECTURE_METRIC_TARGETS,
): LectureMetricsSummary {
  const doneSessions = records.filter((r) => r.status === 'done').length;
  let anchorItems = 0;
  let anchoredItems = 0;
  for (const record of records) {
    for (const section of record.sections) {
      if (!section.ok) continue;
      const c = anchorItemCoverage(section.text);
      anchorItems += c.items;
      anchoredItems += c.anchored;
    }
  }
  const exportedSessions = records.filter((r) => r.status === 'done' && r.exports > 0).length;
  const summary = {
    sessions: records.length,
    doneSessions,
    successRate: ratio(doneSessions, records.length),
    anchorItems,
    anchoredItems,
    anchorCoverage: ratio(anchoredItems, anchorItems),
    exportedSessions,
    exportRate: ratio(exportedSessions, doneSessions),
    targets,
  };
  const meets = {
    successRate: summary.successRate >= targets.successRate,
    anchorCoverage: summary.anchorCoverage >= targets.anchorCoverage,
    exportRate: summary.exportRate >= targets.exportRate,
  };
  return { ...summary, meets, allMet: meets.successRate && meets.anchorCoverage && meets.exportRate };
}
