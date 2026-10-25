/**
 * T03174（七期 4.3，PRD AI-102 / 整合 D-04）：AI 生成前「用量与耗时预估」口径单源。
 *
 * D-04 裁定：不称「成本」、不展示金额——只给调用次数、字符量、耗时区间三项代理指标。
 * 本模块收口三件事：
 *  1. 预估模型带版本号（⑥）：系数集中在 PREFLIGHT_ESTIMATE_MODEL，改系数必须升版本，
 *     预估读数随附 modelVersion，前后差异可解释；
 *  2. 耗时给区间不给点值（①）：`[calls × secondsLowPerCall, calls × secondsHighPerCall]`；
 *  3. 完成后偏差复算（②③④）：字符量与总耗时分别计算相对偏差，任一绝对偏差 >50% 判
 *     `noticeRequired=true`（明示但不阻断，`blocking` 恒为 false）；调用次数不参与偏差判定，
 *     另列实际值。实际值来源：调用方传入本模块前从 `ai_usage`/流式统计收集（E-4 不落库）。
 */

/** ⑤ 页面注记单源文案（前端镜像串由门比对字面量一致） */
export const PROXY_METRIC_NOTICE = '用量为代理指标（调用次数/字符量/耗时），非金额';

export interface PreflightEstimateModel {
  /** 预估模型版本：系数任何变化都必须升版本（⑥） */
  version: string;
  /** 点值基线（秒/调用），与讲稿通道既有口径一致 */
  secondsPerCall: number;
  secondsLowPerCall: number;
  secondsHighPerCall: number;
  /** ② 绝对偏差阈值（0.5 = 50%，严格大于才提示） */
  deviationThreshold: number;
}

export const PREFLIGHT_ESTIMATE_MODEL: PreflightEstimateModel = {
  version: 'ai-preflight-v1',
  secondsPerCall: 10,
  secondsLowPerCall: 6,
  secondsHighPerCall: 18,
  deviationThreshold: 0.5,
};

export interface PreflightEstimate {
  /** 预估模型调用次数 */
  calls: number;
  /** 预估进上下文的字符量 */
  chars: number;
  /** 点值（calls × secondsPerCall），保留给旧消费者 */
  seconds: number;
  /** 耗时区间下界 */
  secondsLow: number;
  /** 耗时区间上界 */
  secondsHigh: number;
  /** ⑥ 产出该预估的模型版本 */
  modelVersion: string;
}

/** 三项预估（①）：纯乘法，可解释优先于精确 */
export function estimateAiRun(calls: number, chars: number, model: PreflightEstimateModel = PREFLIGHT_ESTIMATE_MODEL): PreflightEstimate {
  const c = Math.max(0, Math.floor(calls));
  return {
    calls: c,
    chars: Math.max(0, Math.floor(chars)),
    seconds: c * model.secondsPerCall,
    secondsLow: c * model.secondsLowPerCall,
    secondsHigh: c * model.secondsHighPerCall,
    modelVersion: model.version,
  };
}

export interface DeviationDimension {
  expected: number;
  actual: number;
  /** 相对偏差 (|actual−expected|)/expected；expected=0 时为 null（无可比基数，不判偏差） */
  deviation: number | null;
  overThreshold: boolean;
}

export interface RunUsageDeviation {
  /** ② 字符量偏差（独立计算） */
  chars: DeviationDimension;
  /** ② 总耗时偏差（独立计算，秒） */
  seconds: DeviationDimension;
  /** 调用次数另列实际值，不做偏差判定 */
  actualCalls: number;
  /** 完成后是否明示偏差；恒不阻断（③） */
  noticeRequired: boolean;
  readonly blocking: false;
  modelVersion: string;
}

const dim = (expected: number, actual: number, threshold: number): DeviationDimension => {
  const deviation = expected > 0 ? Math.abs(actual - expected) / expected : null;
  return { expected, actual, deviation, overThreshold: deviation !== null && deviation > threshold };
};

/** ②③④ 完成后偏差复算：预估来自预检（含版本），实际值由调用方从流式统计收集 */
export function assessAiRunDeviation(
  estimate: PreflightEstimate,
  actual: { calls: number; chars: number; seconds: number },
): RunUsageDeviation {
  const threshold = PREFLIGHT_ESTIMATE_MODEL.deviationThreshold;
  const chars = dim(estimate.chars, actual.chars, threshold);
  const seconds = dim(estimate.seconds, actual.seconds, threshold);
  return {
    chars,
    seconds,
    actualCalls: Math.max(0, Math.floor(actual.calls)),
    noticeRequired: chars.overThreshold || seconds.overThreshold,
    blocking: false,
    modelVersion: estimate.modelVersion,
  };
}
