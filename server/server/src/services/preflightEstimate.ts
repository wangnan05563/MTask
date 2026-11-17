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
  /**
   * 单次调用的产出字符量基线（产出型通道用，见 `estimateOutputRun`）。
   * 上下文型通道（讲稿）不走这个系数，仍按实际进上下文字符量预估。
   */
  outputCharsPerCall: number;
  /** ② 绝对偏差阈值（0.5 = 50%，严格大于才提示） */
  deviationThreshold: number;
}

/** 版本登记：系数任何变化都追加一条（⑥ 前后差异可解释，见 T03244） */
export const PREFLIGHT_MODEL_HISTORY: readonly (PreflightEstimateModel & { changes: string[] })[] = [
  {
    version: 'ai-preflight-v1',
    secondsPerCall: 10,
    secondsLowPerCall: 6,
    secondsHighPerCall: 18,
    outputCharsPerCall: 0,
    deviationThreshold: 0.5,
    changes: [],
  },
  {
    version: 'ai-preflight-v2',
    secondsPerCall: 10,
    secondsLowPerCall: 6,
    secondsHighPerCall: 18,
    outputCharsPerCall: 2500,
    deviationThreshold: 0.5,
    // 只新增系数、不动耗时口径——讲稿通道读数不变，周报改为按产出字符量预估
    changes: ['新增产出字符量基线 2500 字/次（周报等产出型通道按此预估字符量）；耗时系数不变'],
  },
];

export const PREFLIGHT_ESTIMATE_MODEL: PreflightEstimateModel = PREFLIGHT_MODEL_HISTORY.at(-1)!;

/**
 * T03244（AI-102⑥）：系数中文名单源——版本差异由服务端生成可读文案，
 * 前端只负责排版，不再写死一份系数名称或数字。
 */
export const PREFLIGHT_COEFFICIENT_LABELS = {
  secondsPerCall: '单次耗时点值',
  secondsLowPerCall: '单次耗时下界',
  secondsHighPerCall: '单次耗时上界',
  outputCharsPerCall: '单次产出字符量',
  deviationThreshold: '偏差提示阈值',
} as const;

export type PreflightCoefficientKey = keyof typeof PREFLIGHT_COEFFICIENT_LABELS;

export const PREFLIGHT_COEFFICIENT_KEYS = Object.keys(PREFLIGHT_COEFFICIENT_LABELS) as PreflightCoefficientKey[];

export interface ModelCoefficientDelta {
  key: PreflightCoefficientKey;
  /** 中文名（来自 `PREFLIGHT_COEFFICIENT_LABELS`） */
  label: string;
  from: number;
  to: number;
}

/** 两版模型之间真正变化的系数（未变化的不列出，避免读者在噪声里找差异） */
export function diffPreflightModel(prev: PreflightEstimateModel, next: PreflightEstimateModel): ModelCoefficientDelta[] {
  return PREFLIGHT_COEFFICIENT_KEYS
    .filter((key) => prev[key] !== next[key])
    .map((key) => ({ key, label: PREFLIGHT_COEFFICIENT_LABELS[key], from: prev[key], to: next[key] }));
}

/** 同一请求（1 次调用、产出型口径）在上一版与当前版下的预估读数 */
export interface ModelReadingSample {
  calls: number;
  prevChars: number;
  nextChars: number;
  prevSeconds: number;
  nextSeconds: number;
}

export interface PreflightModelRevision {
  version: string;
  previousVersion: string | null;
  /** 该版本自述的变更说明（首版为空） */
  changes: string[];
  coefficients: ModelCoefficientDelta[];
  /** 系数变化对用户读数的影响；首版无可比基数，为 null */
  sample: ModelReadingSample | null;
}

/** 版本沿革（最新在前）：供预检响应用户解释「为什么这次估的和上次不一样」 */
export function preflightModelRevisions(
  history: readonly (PreflightEstimateModel & { changes: string[] })[] = PREFLIGHT_MODEL_HISTORY,
): PreflightModelRevision[] {
  return history
    .map((model, i) => {
      const prev = i > 0 ? history[i - 1] : undefined;
      return {
        version: model.version,
        previousVersion: prev?.version ?? null,
        changes: [...model.changes],
        coefficients: prev ? diffPreflightModel(prev, model) : [],
        sample: prev
          ? {
              calls: 1,
              prevChars: prev.outputCharsPerCall,
              nextChars: model.outputCharsPerCall,
              prevSeconds: prev.secondsPerCall,
              nextSeconds: model.secondsPerCall,
            }
          : null,
      };
    })
    .reverse();
}

/**
 * 版本登记自检（门/诊断用）：改了系数却没升版本、或升了版本却没写差异说明，都在这里报出来。
 * 这是 ⑥「可解释」的机器判据——只靠人记约定，迟早会出现一声不响改系数的版本。
 */
export function auditPreflightModelHistory(
  history: readonly (PreflightEstimateModel & { changes: string[] })[] = PREFLIGHT_MODEL_HISTORY,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  history.forEach((model, i) => {
    if (!model.version.trim()) problems.push(`#${i} 版本号为空`);
    else if (seen.has(model.version)) problems.push(`版本号重复：${model.version}`);
    seen.add(model.version);
    if (!(model.secondsLowPerCall <= model.secondsPerCall && model.secondsPerCall <= model.secondsHighPerCall)) {
      problems.push(`${model.version} 耗时期间自相矛盾（下界/点值/上界未按序）`);
    }
    if ([model.secondsPerCall, model.secondsLowPerCall, model.secondsHighPerCall, model.outputCharsPerCall].some((v) => v < 0)) {
      problems.push(`${model.version} 存在负系数`);
    }
    if (!(model.deviationThreshold > 0 && model.deviationThreshold <= 1)) problems.push(`${model.version} 偏差阈值越界（应在 (0,1]）`);
    const prev = i > 0 ? history[i - 1] : undefined;
    if (!prev) {
      if (model.changes.length > 0) problems.push(`首版 ${model.version} 不应有变更说明`);
      return;
    }
    const delta = diffPreflightModel(prev, model);
    if (delta.length > 0 && model.changes.every((c) => !c.trim())) {
      problems.push(`${model.version} 改了系数（${delta.map((d) => d.key).join('/')}）却没有变更说明`);
    }
    if (delta.length === 0 && model.changes.length > 0) {
      problems.push(`${model.version} 系数未变却声明了变更说明（说明与实现不一致）`);
    }
  });
  return problems;
}

export interface PreflightEstimate {
  /** 预估模型调用次数 */
  calls: number;
  /** 预估字符量：口径见 `charsBasis` */
  chars: number;
  /** 字符量口径：context=进上下文字符量（讲稿）；output=预计产出字符量（周报） */
  charsBasis: 'context' | 'output';
  /** 点值（calls × secondsPerCall），保留给旧消费者 */
  seconds: number;
  /** 耗时区间下界 */
  secondsLow: number;
  /** 耗时区间上界 */
  secondsHigh: number;
  /** ⑥ 产出该预估的模型版本 */
  modelVersion: string;
}

/** 三项预估（①）：纯乘法，可解释优先于精确；chars 为「进上下文」口径 */
export function estimateAiRun(calls: number, chars: number, model: PreflightEstimateModel = PREFLIGHT_ESTIMATE_MODEL): PreflightEstimate {
  const c = Math.max(0, Math.floor(calls));
  return {
    calls: c,
    chars: Math.max(0, Math.floor(chars)),
    charsBasis: 'context',
    seconds: c * model.secondsPerCall,
    secondsLow: c * model.secondsLowPerCall,
    secondsHigh: c * model.secondsHighPerCall,
    modelVersion: model.version,
  };
}

/**
 * 产出型通道（周报/汇报稿）的字符量预估：`calls × outputCharsPerCall`。
 * 与 `estimateAiRun` 同一模型版本与耗时口径，只有字符量基准从「输入上下文」换成「预计产出」——
 * 周报的上下文是数据 JSON（随数据量剧烈变化），不是用户关心的「这份报告大概多少字」。
 */
export function estimateOutputRun(calls: number, model: PreflightEstimateModel = PREFLIGHT_ESTIMATE_MODEL): PreflightEstimate {
  const c = Math.max(0, Math.floor(calls));
  return {
    calls: c,
    chars: c * model.outputCharsPerCall,
    charsBasis: 'output',
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
