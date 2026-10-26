/**
 * T02877（六期 4.1，PRD §8.1）：讲稿指标口径单源。
 *
 * PRD 的三条产品指标（生成成功率 ≥90%、锚点覆盖率 ≥85%、导出率 ≥40%）与两条时效指标
 * （预检 ≤3s、单节首字 ≤8s）在这里给出**可复算的定义**：上线后观测与验收门读同一份口径，
 * 避免「面板显示一个数、验收脚本算另一个数」。
 *
 * E-4 明确本期不落库，故本模块只做纯聚合：输入是会话记录（由调用方从控制台流/导出动作收集），
 * 不读写数据库、不常驻状态。
 *
 * T03173（七期 §4，PRD 整合版 G-3）成功率口径修正，按 job（会话）而非 segment 统计：
 *  - 用户主动取消（status='aborted'）**不进分母**——此前分母是 records.length，中止被计成失败，
 *    与「无中止到达 done 的会话占比」（T02169 §8.1）矛盾；
 *  - 重试后最终成功计成功：调用方以会话的**最终**产物记录（单节重试已拼回），本模块只看终态；
 *  - 只有部分产物不得计 done：status='done' 但存在 ok=false 的节（或零节）计为 partial，只进分母不进分子；
 *  - 离线/AI 生成分别标注：调用方显式传 mode；无标注的记录归 'unknown'（D-05：不回填、不臆断生成方式）。
 */

/** G-3 生成方式标注：AI 流式生成 / 离线（规则或缓存）生成；无标注的历史记录归 unknown，不回填 */
export type LectureSessionMode = 'ai' | 'offline' | 'unknown';

export interface LectureMetricSection {
  ok: boolean;
  text: string;
  anchors: number;
}

/** 一次生成会话（job）的观测记录（status 与流式结果口径一致） */
export interface LectureSessionRecord {
  sessionId: string;
  /** 'aborted'＝用户主动取消，不计入成功率分母；'done' 但产物不全按 partial 处理 */
  status: 'done' | 'aborted' | 'error';
  sections: LectureMetricSection[];
  /** 该会话触发的导出次数（≥1 即算「完成生成后触发导出」） */
  exports: number;
  /** G-3「离线/AI 生成分别标注」；缺省归 'unknown'（不臆断生成方式，D-05 不回填） */
  mode?: Exclude<LectureSessionMode, 'unknown'>;
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
  /** status='done' 的原始会话数（含产物不全的 partial） */
  doneSessions: number;
  /** G-3：用户主动取消（aborted）数——不进成功率分母，单独呈现 */
  abortedSessions: number;
  /** 成功率分母：sessions − aborted（重试拼回后只看终态，segment 不重复计） */
  attemptedSessions: number;
  /** 成功分子：done 且产物齐全（全部节 ok 且至少一节）；partial 不计 */
  successSessions: number;
  /** G-3：done 但产物不全（存在 ok=false 的节或零节）——只进分母不进分子 */
  partialSessions: number;
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
  /** G-3「离线/AI 分别标注」：按 mode 分组的同口径子汇总，只含出现过的 mode */
  byMode: Partial<Record<LectureSessionMode, LectureMetricsSummary>>;
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

/** G-3 mode 归属：显式标注 ai/offline，其余（含缺省）归 unknown，不回填 */
export function lectureSessionModeOf(record: LectureSessionRecord): LectureSessionMode {
  return record.mode ?? 'unknown';
}

/** done 且产物齐全（至少一节且全部 ok）才算成功；只有部分产物不得计 done */
function isFullSuccessCounts(status: LectureSessionRecord['status'], sectionsTotal: number, sectionsOk: number): boolean {
  return status === 'done' && sectionsTotal > 0 && sectionsOk >= sectionsTotal;
}

function isFullSuccess(record: LectureSessionRecord): boolean {
  return isFullSuccessCounts(record.status, record.sections.length, record.sections.filter((s) => s.ok).length);
}

/** 单组记录的口径计算（不含 byMode，避免分组递归） */
function summarizeGroup(
  records: readonly LectureSessionRecord[],
  targets: LectureMetricTargets,
): Omit<LectureMetricsSummary, 'byMode'> {
  const doneSessions = records.filter((r) => r.status === 'done').length;
  const abortedSessions = records.filter((r) => r.status === 'aborted').length;
  const attemptedSessions = records.length - abortedSessions;
  const successSessions = records.filter(isFullSuccess).length;
  const partialSessions = doneSessions - successSessions;
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
    abortedSessions,
    attemptedSessions,
    successSessions,
    partialSessions,
    // G-3：分母剔除主动取消；分子只计产物齐全的终态成功
    successRate: ratio(successSessions, attemptedSessions),
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

/** 汇总会话记录：成功率（剔除主动取消）、锚点覆盖率、导出率与达标判定（除零一律 0，不产生 NaN） */
export function summarizeLectureMetrics(
  records: readonly LectureSessionRecord[],
  targets: LectureMetricTargets = LECTURE_METRIC_TARGETS,
): LectureMetricsSummary {
  const base = summarizeGroup(records, targets);
  const byMode: Partial<Record<LectureSessionMode, LectureMetricsSummary>> = {};
  for (const mode of ['ai', 'offline', 'unknown'] as const) {
    const group = records.filter((r) => lectureSessionModeOf(r) === mode);
    // 组内只剩单一 mode，再分组没有信息量——用单组计算并置空 byMode，避免自递归
    if (group.length > 0) byMode[mode] = { ...summarizeGroup(group, targets), byMode: {} };
  }
  return { ...base, byMode };
}

// ——————————————————————————————————————————————————————————————
// T03192（七期 §7.4，PRD 整合版 G-3）：job 级成功率基线。
// ai_job_runs 只存终态计数（节次总数/ok 数），不存节正文；这里与上面同口径复算，
// 复用 isFullSuccessCounts，避免「接口显示一个数、验收脚本算另一个数」。
// ——————————————————————————————————————————————————————————————

export interface JobSuccessRecord {
  status: LectureSessionRecord['status'];
  /** 该 job 应产出的节次总数（0＝没有任何产物） */
  sectionsTotal: number;
  /** 其中 ok 的节次数 */
  sectionsOk: number;
  mode?: Exclude<LectureSessionMode, 'unknown'>;
}

export interface JobSuccessGroup {
  samples: number;
  /** 分母：samples − aborted */
  attempted: number;
  success: number;
  /** done 但节次不全——只进分母不进分子 */
  partial: number;
  aborted: number;
  /** attempted=0 时为 null（缺失≠0%），否则 0..1 保留 4 位小数 */
  successRate: number | null;
}

export interface JobSuccessSummary extends JobSuccessGroup {
  byMode: Partial<Record<LectureSessionMode, JobSuccessGroup>>;
}

function summarizeJobGroup(records: readonly JobSuccessRecord[]): JobSuccessGroup {
  const aborted = records.filter((r) => r.status === 'aborted').length;
  const attempted = records.length - aborted;
  const success = records.filter((r) => isFullSuccessCounts(r.status, r.sectionsTotal, r.sectionsOk)).length;
  const partial = records.filter((r) => r.status === 'done').length - success;
  return {
    samples: records.length,
    attempted,
    success,
    partial,
    aborted,
    successRate: attempted === 0 ? null : Math.round((success / attempted) * 10000) / 10000,
  };
}

/** G-3 job 级成功率：取消不进分母、partial 不计成功、AI/离线按 mode 分列 */
export function summarizeJobSuccess(records: readonly JobSuccessRecord[]): JobSuccessSummary {
  const byMode: Partial<Record<LectureSessionMode, JobSuccessGroup>> = {};
  for (const mode of ['ai', 'offline', 'unknown'] as const) {
    const group = records.filter((r) => (r.mode ?? 'unknown') === mode);
    if (group.length > 0) byMode[mode] = summarizeJobGroup(group);
  }
  return { ...summarizeJobGroup(records), byMode };
}
