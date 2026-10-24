/**
 * T02875（六期 3.4，PRD FR-7.1/7.2）：预检的预算估算段。
 *
 * 预检本体（项目/commit/文件/±行/排除命中/git 可用性）在 `lectureScope.previewLectureScope`，
 * 这里只把统计面折成「这单大概要烧几次调用、多久、多少字」，放在预检覆盖层给用户决策用。
 * 估算口径刻意保守可解释：大纲 1 次 + 八段 × 项目内分组数（每组 6 文件），单次按 10s 计。
 */

import { LECTURE_CONTEXT_BUDGET } from './lectureContext';
import type { LectureScopePreview } from './lectureScope';

export interface LecturePreflightEstimate {
  /** 项目内分段组数（每 6 个保留文件一组） */
  groups: number;
  /** 预估模型调用次数：1 次大纲 + 八段 × 组数 */
  calls: number;
  /** 预估墙钟秒数（单次 10s 基线） */
  seconds: number;
  /** 实际进上下文的字符数（预算内） */
  contextChars: number;
  /** 单次调用上下文预算（60k，与 PRD 同源） */
  contextBudget: number;
}

export const LECTURE_FILES_PER_GROUP = 6;
export const LECTURE_SECONDS_PER_CALL = 10;

export function estimateLectureRun(preview: LectureScopePreview): LecturePreflightEstimate {
  const ready = preview.projects.filter((p) => !p.blocked);
  const groups = ready.reduce((sum, p) => sum + Math.max(1, Math.ceil(p.kept.files / LECTURE_FILES_PER_GROUP)), 0);
  const calls = ready.length === 0 ? 0 : 1 + 8 * groups;
  return {
    groups,
    calls,
    seconds: calls * LECTURE_SECONDS_PER_CALL,
    contextChars: preview.totals.keptChars,
    contextBudget: LECTURE_CONTEXT_BUDGET,
  };
}
