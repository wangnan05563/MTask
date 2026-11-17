/**
 * T02875（六期 3.4，PRD FR-7.1/7.2）：预检的预算估算段。
 *
 * 预检本体（项目/commit/文件/±行/排除命中/git 可用性）在 `lectureScope.previewLectureScope`，
 * 这里只把统计面折成「这单大概要烧几次调用、多久、多少字」，放在预检覆盖层给用户决策用。
 * 估算口径刻意保守可解释：大纲 1 次 + 八段 × 项目内分组数（每组 6 文件），单次按 10s 计。
 */

import { LECTURE_CONTEXT_BUDGET } from './lectureContext';
import { PREFLIGHT_ESTIMATE_MODEL, estimateAiRun } from './preflightEstimate';
import type { PreflightEstimate } from './preflightEstimate';
import type { LectureScopePreview } from './lectureScope';

export interface LecturePreflightEstimate extends PreflightEstimate {
  /** 项目内分段组数（每 6 个保留文件一组） */
  groups: number;
  /** 实际进上下文的字符数（预算内）——与 `chars` 同值的历史别名（t02875 门/面板镜像在用） */
  contextChars: number;
  /** 单次调用上下文预算（60k，与 PRD 同源） */
  contextBudget: number;
}

export const LECTURE_FILES_PER_GROUP = 6;
/** 点值基线收口到预估模型单源（T03174 ⑥：改系数=升模型版本） */
export const LECTURE_SECONDS_PER_CALL = PREFLIGHT_ESTIMATE_MODEL.secondsPerCall;

export function estimateLectureRun(preview: LectureScopePreview): LecturePreflightEstimate {
  const ready = preview.projects.filter((p) => !p.blocked);
  const groups = ready.reduce((sum, p) => sum + Math.max(1, Math.ceil(p.kept.files / LECTURE_FILES_PER_GROUP)), 0);
  const calls = ready.length === 0 ? 0 : 1 + 8 * groups;
  const base = estimateAiRun(calls, preview.totals.keptChars);
  return {
    groups,
    ...base,
    contextChars: base.chars,
    contextBudget: LECTURE_CONTEXT_BUDGET,
  };
}
