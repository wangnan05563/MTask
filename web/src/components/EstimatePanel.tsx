/**
 * 估算面板（T02039 · PRD-估算视图与工作量评估导出 §5.1/§5.2，交付拆解 E4 首段）。
 *
 * 三条口径红线：
 * ① **零计算**：本文件不做任何三点运算（E/σ/汇总/比例一律读服务端 `summary`，
 *    逐行 σ 由 `rowRatios` 下发）。前端自算一次，「面板汇总 = 模板 H35」（§10-14）
 *    就从断言退化成两套实现的巧合一致——这正是本仓 planDeps 双口径踩过的坑。
 * ② **分组单源**：明细行的里程碑分组直接复用时间线的 `groupTimelinePhases`，
 *    折叠态与列表/甘特共用同一份 `plan.collapsedMs`（T01576 口径），面板不自造第三套分组。
 * ③ **三点运算零本地实现**（T02040 起本面板可写，但写路径仍不含运算）：行内录入走 PATCH、
 *    批量填充走 `mode=derive` / `mode=set`，`O>M` 之类的不合格值**由服务端拒**（400 + 中文文案），
 *    面板只是把那行标红——前端不复写一份 `pointsError`，否则「谁被拒」会变成两套判据。
 *    改完即时重取 `GET /api/estimates`：E/σ/汇总卡的新值仍由服务端算（§10-3 的「即时刷新」）。
 * ④ 区间条（§5.4 P0，T02041）只做**排版几何**：O/P/E 三个数一律取服务端那一份，
 *    `whiskerGeometries()` 里唯一的除法是「按明细行最大 P 归一成百分比宽度」，不含任何 E/σ 公式。
 *    导出区（§5.2 第 4 段）Excel 侧随 E6/T02043 交付；PDF 属 E7，本文件不预留空壳按钮。
 * ⑤ §7 变更影响（E9，T02046）：偏差比值/阈值、收口只读、上次导出后变更、影响试算的**判定全在服务端**
 *    （`estimate-engine.rowDriftCheck` + `EstimateService.requirePlan` + `POST /what-if`），面板只排版数字。
 *    面板里出现的 1.5 / 0.67 只能是服务端下发的 `checks.drift.thresholds`，不许是字面量——
 *    阈值写第二份，调阈值就变成「只改了一处」的 bug（同红线①，也同 `util/planDeps` 的教训）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { groupTimelinePhases, type TlPlan } from './PlanTimeline';
import { computeWindowVar, VIRTUAL_OVERSCAN, VIRTUAL_VIEWPORT_H } from '../pages/testCaseModel';

// T02121 明细段窗口化常量（与 testCaseModel 虚拟滚动同族；行高写死以保证窗口数学不漂，见 computeWindowVar）
const EST_VIRTUAL_THRESHOLD = 120; // 明细行 >120 启用虚拟滚动（500 行首屏从 737ms 降至 <500ms；阈值留余量，指标不软化）
const EST_HEADER_H = 30; // 里程碑表头行高（border-box：内容 ~24 + 段间距 6），折叠语义不变
const EST_ITEM_H = 54; // 任务行高（border-box：padding8 + 边框1 + 标题/徽标/区间条 ~40），badges 行改 nowrap 防撑高
import { PhaseBarChart, ParetoChart, TornadoChart, paretoGeometries, tornadoGeometries } from './estimateCharts';
import { api } from '../api/client';
import {
  estimatesApi, parseSnapshotPayload, toGrid,
  type DeriveItem, type DeriveRule, type EstimateExportAudience, type EstimateExportOptions, type EstimateExportScope, type EstimateInput,
  type EstimateListItem, type EstimateParamLog, type EstimateParamLogEffective, type EstimateSnapshot, type EstimateSource, type EstimatesResponse,
  type RowDrift, type SnapshotDiff, type WhatIfResponse,
} from '../api/estimates';
import { saveBlob } from '../utils/download';
import { fullTime } from '../ui/format';
import { askConfirm } from '../ui/dialogs';

/** PRD §5.1：docked 分栏宽 520（T02124：用户反馈 420px 偏窄，时间线留白较多，收窄等空间给估算面板）；<1200px 转 SlideOver 时沿用同宽（两处共用一个常量） */
export const ESTIMATE_PANEL_WIDTH = 520;

/** 明细列的数字字体与右对齐口径（与 ResultDiff/时间线同一套 11~12px 阶梯） */
const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace';

/** 来源徽标：人工=已复核，规则/默认=机器值待复核（§9 上线度量「复核率」的界面读数） */
export const SOURCE_BADGE: Record<EstimateSource | 'none', { label: string; color: string }> = {
  manual: { label: '人工', color: 'var(--success)' },
  rule: { label: '规则', color: 'var(--accent)' },
  default: { label: '默认', color: 'var(--text-muted)' },
  none: { label: '未录入', color: 'var(--border-strong)' },
};

/** §10-2：未落库的行走三档推导给「默认」值，徽标要能看出是哪一档推出来的 */
export const RULE_LABEL: Record<DeriveRule, string> = {
  complexity: '默认·复杂度',
  caseWeight: '默认·用例',
  duration: '默认·工期',
};

/**
 * §11-E13「改值历史」的三个可断言谓词（T02293 判据规约：把口径从 JSX 里切出来给门判，
 * 而不是让门正则匹配那半行渲染代码——等价重构即红、删掉守卫反而不红）。
 * 三者都不做运算，只做「服务端下发的那一份怎么读给人看」。
 */

/** 键 → 中文标签：单源是 `GET /api/estimates/meta` 的 `settingLabels`；库里出现名单外的键就照原样显示，不编造标签 */
export function paramLogKeyLabel(key: string, labels: Record<string, string>): string {
  return labels[key] ?? key;
}

/** §6.1「或留空」分支的既有口径：未署名显示「未署名」，不留空单元格让复核的人以为漏了一列 */
export function paramLogActorLabel(actor: string | null | undefined): string {
  const a = (actor ?? '').trim();
  return a === '' ? '未署名' : a;
}

/** `effective` 是服务端写死的 JSON 文本；解析失败按「读不出」处理，不猜数也不让整块历史消失 */
export function parseParamLogEffective(raw: string | null | undefined): EstimateParamLogEffective | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EstimateParamLogEffective>;
    if (typeof v?.manDaysPerManMonth !== 'number' || typeof v?.hoursPerManDay !== 'number' || typeof v?.coefSum !== 'number') return null;
    return { manDaysPerManMonth: v.manDaysPerManMonth, hoursPerManDay: v.hoursPerManDay, coefSum: v.coefSum };
  } catch {
    return null;
  }
}

/** §5.3 批量填充的档位入口文案（与 `RULE_LABEL` 同一批档名，不另起一套叫法） */
export const BATCH_RULE_LABEL: Record<DeriveRule, string> = {
  complexity: '按复杂度重推',
  caseWeight: '按用例加权重推',
  duration: '按工期重推',
};

/** 服务端 `DERIVE_SKIPS` 的中文说明：跳过原因由服务端判定，面板只翻译，不第二次判定 */
export const SKIP_LABEL: Record<string, string> = {
  milestone: '里程碑行不落估算',
  exists: '已有估算行（scope=missing 只补空的）',
  manual: '人工复核过的行不覆盖',
  offRule: '不属于所选推导档',
};

const num = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
/** `ratioCheck.deviationPct` 服务端已是「百分数」本身（2.3 = 2.3%），不能再过一遍 pct */
const devPct = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}%`;

const numSigned = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  return `${v > 0 ? '+' : ''}${num(v)}`;
};
/** 服务端 `what-if` 的 `delta.pct` 已经是百分数本身（同 `deviationPct`），且可能为 null（基数为 0） */
const pctSigned = (v: number | null): string => {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}%`;
};

/** 服务端 400 的中文文案直接上屏（`wrap()` 统一 `{ error }`，`api` 客户端已抛成 Error.message） */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 按跳过原因计数（响应里的 `skipped` 是唯一来源，面板不再判一次该不该跳） */
const countSkip = (resp: { skipped: Array<{ skip: string }> }, kind: string): number =>
  resp.skipped.filter((s) => s.skip === kind).length;

/** 面板明细行（服务端三份数据合成一张表：估算行 / 推导建议 / 逐行期望值） */
export interface PanelRow {
  planId: string;
  title: string;
  kind: string;
  complexity: number | null;
  reqNos: string[];
  phase: string;
  optimistic: number | null;
  likely: number | null;
  pessimistic: number | null;
  expected: number | null;
  sigma: number | null;
  badge: { label: string; color: string };
  /** true=未落库的推导建议（灰显 + 不可当报价依据） */
  suggestion: boolean;
  /** 有估算行落库（T02040 行内录入要区分「改已有行」与「把建议值变成行」——后者 PATCH 得给全三点+阶段） */
  persisted: boolean;
  /** 估算行的来源；未落库为 'none'（「只看未复核」筛选与撤销都按它判，不靠徽标文案猜） */
  source: EstimateSource | 'none';
  /** 徽标/数值的悬停说明：已落库行取 note，建议行取推导依据 */
  tip: string;
  /** 里程碑行：值照样显示但不进 Σ（§4.6 红线一） */
  inSigma: boolean;
  /**
   * §7 行级变更影响（偏差比值 / 收口只读 / 排期压力），服务端 `rowDriftCheck` 的原始结果。
   * 面板不在此之上再判一次阈值——`null` 只出现在未落库行（未估算不参与偏差判定）与老快照。
   */
  drift: RowDrift | null;
}

/**
 * 三份来源 → 明细行（纯函数，供 verify 脚本直接断言，不经 DOM）。
 * 取值优先级：已落库估算行 > 推导建议 > 空；逐行 E/σ 只认服务端 `rowRatios`，
 * 建议行的 E 用推导响应里自带的 expected（同样是服务端算的），σ 则无（未落库不算不确定度）。
 */
export function buildPanelRows(
  plans: ReadonlyArray<TlPlan>,
  items: ReadonlyArray<EstimateListItem>,
  derives: ReadonlyArray<DeriveItem>,
  rowRatios: ReadonlyArray<{ key: string; expected: number; sigma: number }>,
  reqNosByPlan: Readonly<Record<string, string[]>>,
): PanelRow[] {
  const byPlan = new Map(items.map((i) => [i.plan_id, i]));
  const byDerive = new Map(derives.map((d) => [d.planId, d]));
  const byRatio = new Map(rowRatios.map((r) => [r.key, r]));
  return plans.map((p) => {
    const it = byPlan.get(p.id);
    const dv = byDerive.get(p.id);
    const rr = byRatio.get(p.id);
    const base = {
      planId: p.id,
      title: p.title,
      kind: p.kind ?? 'normal',
      complexity: p.complexity ?? null,
      reqNos: reqNosByPlan[p.id] ?? [],
      phase: it?.phase ?? dv?.phase ?? '',
      inSigma: (p.kind ?? 'normal') !== 'milestone',
    };
    if (it) {
      return {
        ...base,
        optimistic: it.optimistic,
        likely: it.likely,
        pessimistic: it.pessimistic,
        expected: rr?.expected ?? null,
        sigma: rr?.sigma ?? null,
        badge: SOURCE_BADGE[it.source] ?? SOURCE_BADGE.none,
        suggestion: false,
        persisted: true,
        source: it.source,
        tip: it.note || `已落库估算行（${SOURCE_BADGE[it.source]?.label ?? it.source}）`,
        drift: it.drift ?? null,
      };
    }
    if (dv) {
      return {
        ...base,
        optimistic: dv.optimistic,
        likely: dv.likely,
        pessimistic: dv.pessimistic,
        expected: dv.expected,
        sigma: null,
        badge: { label: RULE_LABEL[dv.rule], color: SOURCE_BADGE.default.color },
        suggestion: true,
        persisted: false,
        source: 'none',
        tip: dv.skip ? `不落库：${SKIP_LABEL[dv.skip] ?? dv.skip}` : dv.note,
        drift: null,
      };
    }
    return {
      ...base, optimistic: null, likely: null, pessimistic: null, expected: null, sigma: null,
      badge: SOURCE_BADGE.none, suggestion: false, persisted: false, source: 'none',
      tip: '无估算行，也没有可用的推导依据',
      drift: null,
    };
  });
}

/**
 * §5.4 区间条几何（P0，T02041）：把「O——P，中间竖线标 E」换算成容器内百分比。
 *
 * 这是**排版几何**不是估算运算——O/P/E 三个数全部来自服务端那一份，本函数只做「除以参与归一的明细行里最大的 P」
 * 这一处除法（等价于 `left:${x}%` 的宽度换算），不含 E/σ 公式：零计算红线管的是「算式不许有两份」，
 * 这里没有算式。**调用方传全量明细行而非筛后可见行**：换一次筛选就改刻度，同一行的条长会凭空变化（§5.4 v2.0 ②，真机 U-20）。
 * 写成纯函数导出，是为了让 verify 脚本能直接断言归一口径与单调性，不必经 DOM。
 */
export interface WhiskerGeom {
  readonly planId: string;
  /** 归一基数：参与渲染的行里最大的 P（同屏各行长度才可比；至少为 1 防除零） */
  readonly scaleMax: number;
  readonly loPct: number;
  readonly hiPct: number;
  readonly ePct: number;
}

export function whiskerGeometries(rows: readonly PanelRow[]): Map<string, WhiskerGeom> {
  const pts = rows.filter((r) => r.optimistic !== null && r.pessimistic !== null && r.expected !== null);
  const scaleMax = Math.max(1, ...pts.map((r) => r.pessimistic as number));
  const pctOf = (v: number): number => Math.min(100, Math.max(0, (v / scaleMax) * 100));
  return new Map(pts.map((r) => [r.planId, {
    planId: r.planId,
    scaleMax,
    loPct: pctOf(r.optimistic as number),
    hiPct: pctOf(r.pessimistic as number),
    ePct: pctOf(r.expected as number),
  }]));
}

/**
 * §5.4 区间条**绘制件**（T02293 判据规约：把可测边界从 700 行的面板里切出来，
 * 让验证脚本断言 `react-dom/server` 渲染串而不是面板源文本——
 * role/aria-label、配色口径、退化区间最小可见宽度都在这三行 JSX 上，
 * 留在 `renderItem` 内部就只能靠读源码守，改个变量名就误红、删个 aria-label 反而不红）。
 * 几何与行值由调用方传入，本件不算任何数。
 */
export function WhiskerBar({ row, geom }: { row: PanelRow; geom: WhiskerGeom | undefined }): ReactElement | null {
  if (!geom) return null; // 无几何（里程碑行、无三点行）不画——§4.6 红线一的绘制层
  const wColor = row.suggestion ? 'var(--text-muted)' : 'var(--accent)';
  const barTitle = `O ${num(row.optimistic)} —— P ${num(row.pessimistic)}，竖线为 E ${num(row.expected)} 人天`
    + `${row.suggestion ? '（推导建议值，未落库、不进 Σ）' : ''}\n横向刻度按明细行最大 P=${num(geom.scaleMax)} 归一，行间长度可比`;
  return (
    <div /* NOSONAR: S6819 误报——区间条由多个子元素绘制的复合图形，无原生元素可承载，改<img>会毁掉渲染 */
      role="img"
      aria-label={`区间条 ${row.title}`}
      title={barTitle}
      style={{ position: 'relative', height: 8, marginTop: 3 }}
    >
      <span aria-hidden style={{ position: 'absolute', top: 3, left: `${geom.loPct}%`, width: `${Math.max(geom.hiPct - geom.loPct, 0.4)}%`, minWidth: 2, height: 1, background: wColor }} />
      <span aria-hidden style={{ position: 'absolute', top: 1, left: `${geom.loPct}%`, width: 1, height: 6, background: wColor }} />
      <span aria-hidden style={{ position: 'absolute', top: 1, left: `${geom.hiPct}%`, width: 1, height: 6, background: wColor }} />
      <span aria-hidden style={{ position: 'absolute', top: 0, left: `${geom.ePct}%`, width: 2, height: 8, background: wColor, opacity: 0.85 }} />
    </div>
  );
}

/**
 * §5.4 图例可见性（T02293 判据规约）：把「一条区间都画不出来时不解释一个不存在的图形」
 * 写成可断言的谓词，而不是只留在 JSX 里的 `whisker.size > 0`——
 * 原来验证门用正则匹配那半行源码（等价重构即红、把守卫删掉反而不红），现在门直接问谓词两态。
 */
export function whiskerLegendShown(geomCount: number): boolean {
  return geomCount > 0;
}

/** PRD §5.1 的形态阈值：视口 <1200px 转覆盖式。写成纯函数是为了让 verify 脚本能断言边界，
 *  而不是把 1199/1200 这两个数只留在 matchMedia 字符串里（§10-13 走查 1200/1440/1920 三档）。 */
export function estimatePanelModeForWidth(width: number): 'docked' | 'overlay' {
  return width < 1200 ? 'overlay' : 'docked';
}

const currentMode = (): 'docked' | 'overlay' =>
  globalThis.window === undefined || typeof globalThis.window.matchMedia !== 'function'
    ? 'docked' : estimatePanelModeForWidth(globalThis.window.innerWidth);

/** 面板挂载形态：<1200px 覆盖式抽屉（PRD §5.1）。监听 resize 而非挂载时读一次——拖动窗口要即时切换。 */
export function useEstimatePanelMode(): 'docked' | 'overlay' {
  const [mode, setMode] = useState<'docked' | 'overlay'>(currentMode);
  useEffect(() => {
    if (globalThis.window === undefined) return;
    const onChange = (): void => setMode(currentMode());
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }, []);
  return mode;
}

// T02121 明细段窗口化的扁平渲染条目（表头 / 任务行），折叠·筛选态在构建时即消费
type EstFlatEntry =
  | { kind: 'header'; key: string; group: ReturnType<typeof groupTimelinePhases>[number] }
  | { kind: 'item'; key: string; row: PanelRow };

export interface EstimatePanelProps {
  readonly projectId: string;
  /** 与时间线同源的计划集（未归档）；分组/折叠口径也同源 */
  readonly plans: ReadonlyArray<TlPlan>;
  readonly collapsedMs: Readonly<Record<string, boolean>>;
  readonly onToggleMsCollapse: (id: string) => void;
  readonly onToast: (msg: string) => void;
  /** 覆盖式抽屉自带标题栏，此时隐去面板内标题（同一屏出现两个「估算面板」是噪声） */
  readonly hideHeading?: boolean;
}

/** §5.3 行内编辑的三列（顺序即列顺序；面板与 verify 脚本共用这一份名单） */
export const POINT_FIELDS = ['optimistic', 'likely', 'pessimistic'] as const;
export type PointField = (typeof POINT_FIELDS)[number];
export const POINT_LABEL: Record<PointField, string> = { optimistic: '乐观 O', likely: '最可能 M', pessimistic: '悲观 P' };

/** 正在编辑的单元格（值原样存字符串，交给服务端判「是不是数 / O≤M≤P」） */
interface Draft { planId: string; field: PointField; value: string }

/** 一次批量写入的可撤销记录：写入前每行的原貌（null=当时没有估算行，撤销等价于删行） */
export interface UndoEntry {
  /** 人话标签（进撤销 toast 与提示条 title，如「统一值填充 4 行」） */
  label: string;
  /** 本次实际写入的行数——顶部提示「已填充 N 行 · 撤销」按它出数，与服务端 `written` 同源 */
  count: number;
  before: Array<{ planId: string; snapshot: EstimateInput | null }>;
}

/** 批量填充的三种模式（§5.3）：两档走服务端推导，一档走服务端批量写 */
export type BatchMode = DeriveRule | 'uniform';

/** 已落库行的原貌快照（撤销时按它回写，`source` 一起带上——否则规则行会被「转 manual」洗成人工行） */
export function snapshotRow(r: PanelRow): EstimateInput | null {
  if (!r.persisted) return null;
  const s: EstimateInput = {
    optimistic: r.optimistic ?? undefined,
    likely: r.likely ?? undefined,
    pessimistic: r.pessimistic ?? undefined,
    source: r.source === 'none' ? undefined : r.source,
  };
  if (r.phase) s.phase = r.phase as EstimateInput['phase'] | undefined;
  return s;
}

/** 统一值表单字段的值/步进对（S3776 L306：自 JSX 内联表达式抽出的局部纯函数，行为不变） */
const uniformFieldState = (key: 'm' | 'oMul' | 'pMul', form: { m: string; oMul: string; pMul: string }): [string, number] => {
  if (key === 'm') return [form.m, 0.5];
  return [form[key], 0.1];
};

/** 快照行的受众标签（S3358 L1442：嵌套三元 → 早返回；未识别时兜底为原格式名） */
const snapshotAudienceLabel = (aud: unknown, format: string): string => {
  if (aud === 'client') return '客户版';
  if (aud === 'internal') return '内部版';
  return format;
};

/** 两次导出差异的着色（S3358 L1458：嵌套三元 → 单层分支函数） */
const deltaTone = (delta: number): string => {
  if (delta === 0) return 'var(--text-muted)';
  return delta > 0 ? 'var(--danger)' : 'var(--success)';
};

/**
 * 「统一值 + 相对幅度」模式的三点生成（§5.3 模式 ③）。
 * 只算 `M×倍率` 这一件输入侧的事，落 0.5 网格用 `toGrid`（服务端同语义镜像）；
 * 不碰 E/σ——那仍是服务端 `expected()` 的独占口径。倍率缺省取服务端下发的 `ruleRatio`。
 */
export function uniformPoints(m: number, oMul: number, pMul: number): { optimistic: number; likely: number; pessimistic: number } {
  return { optimistic: toGrid(m * oMul), likely: toGrid(m), pessimistic: toGrid(m * pMul) };
}

/**
 * 单字段 PATCH 入参的三点继承校验（S3776：自 commitDraft 抽出，逻辑逐字保留）。
 * 建议行落库=新建估算行，三点必填才过得了服务端校验；未编辑的两点继承推导值。
 * 返回 null 表示缺可继承值（已按原逻辑 toast 提示），调用方直接放弃提交。
 */
function buildPatchInput(
  field: PointField,
  raw: string,
  row: { phase: string; optimistic: number | null; likely: number | null; pessimistic: number | null },
  onMissing: (label: string) => void,
): EstimateInput | null {
  const input: EstimateInput = {};
  for (const f of POINT_FIELDS) {
    const v = f === field ? raw : row[f];
    if (v === null || v === undefined) {
      onMissing(POINT_LABEL[f]);
      return null;
    }
    input[f] = v;
  }
  if (row.phase) input.phase = row.phase as EstimateInput['phase'];
  return input;
}

/** 统一值预览文案（S3776/S2004：自渲染体 JSX 的 IIFE 抽出为局部纯函数，行为不变） */
function previewUniform(form: { m: string; oMul: string; pMul: string }): string {
  const [m, o, p] = [form.m, form.oMul, form.pMul].map(Number);
  const filled = form.m.trim() !== '' && Number.isFinite(m) && Number.isFinite(o) && Number.isFinite(p) && m > 0 && o > 0 && p > 0;
  if (!filled) return '待填';
  const pts = uniformPoints(m, o, p);
  return `O ${num(pts.optimistic)} / M ${num(pts.likely)} / P ${num(pts.pessimistic)}`;
}

/** 汇总卡（S3776：自组件体抽出的无状态局部函数，样式与结构原样保留） */
function card(title: string, main: string, sub?: string, danger = false): ReactElement {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: 8, background: 'var(--card-bg)', border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 16, fontFamily: MONO, color: danger ? 'var(--danger)' : 'var(--text)' }}>{main}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/** 工具条按钮配色档（S4323：联合类型提别名，三处签名共用） */
type ToolBtnTone = 'default' | 'accent' | 'danger';

/** 工具条按钮边框色（S3358：嵌套三元拆为单层分支函数） */
const toneBorder = (tone: ToolBtnTone): string => {
  if (tone === 'danger') return 'var(--danger)';
  return tone === 'accent' ? 'var(--accent)' : 'var(--border-strong)';
};

/** 工具条按钮文字色（S3358：嵌套三元拆为单层分支函数） */
const toneText = (tone: ToolBtnTone): string => {
  if (tone === 'danger') return 'var(--danger)';
  return tone === 'accent' ? 'var(--accent)' : 'var(--text)';
};

/** 工具条小按钮（11px 档，同 §5.5 字号阶梯；禁用态只降色不改形，避免按钮跳动） */
function toolBtn(tone: ToolBtnTone = 'default', disabled = false): CSSProperties {
  return {
    border: `1px solid ${toneBorder(tone)}`,
    borderRadius: 6,
    padding: '3px 8px',
    background: 'var(--card-bg)',
    color: disabled ? 'var(--text-muted)' : toneText(tone),
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 11,
  };
}

/** 行内录入的数字输入框（40px 定宽 = 原 span 列宽，面板 420 的账不变；appearance 只去箭头不改 step 语义） */
function pointInput(err: string | undefined): CSSProperties {
  return {
    width: 40,
    textAlign: 'right',
    fontFamily: MONO,
    fontSize: 12,
    padding: '1px 2px',
    borderRadius: 4,
    border: `1px solid ${err ? 'var(--danger)' : 'var(--border)'}`,
    background: 'var(--card-bg)',
    color: 'var(--text)',
    WebkitAppearance: 'textfield',
    appearance: 'textfield',
  };
}

/** <ul>/<li> 视口重置（S6819：role="list" 改原生 ul/li 后保持原 div 排版的 UA 重置） */
const UL_RESET: CSSProperties = { margin: 0, padding: 0, listStyle: 'none' };
const LI_RESET: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };

/** 图表区块：有几何数据才画图（S3776：自组件 JSX 的三处同构三元抽为局部函数，空态文案原样） */
function chartBlock(title: string, hasData: boolean, chart: ReactElement, emptyText: string): ReactElement {
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '12px 0 6px' }}>{title}</div>
      {hasData ? chart : <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>{emptyText}</div>}
    </>
  );
}

/** 虚拟滚动窗口切片（S2004/S3776：自渲染体 map 抽出，逻辑逐字保留） */
function estWindowSlice(entries: EstFlatEntry[], win: { start: number; end: number } | null): EstFlatEntry[] {
  if (!win) return entries;
  return entries.slice(Math.max(0, win.start), Math.min(entries.length, win.end));
}

/** S3776：组件体渲染三元提出为模块级纯函数（分支平铺 if/return，判据、文案与求值顺序逐字不变） */
function audienceTagLabel(audience: EstimateExportAudience): string {
  if (audience === 'client') return '客户版';
  return '内部版';
}

function headingTitleStyle(hidden: boolean): CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 600,
    visibility: hidden ? 'hidden' : 'visible',
  };
}

function whatIfBtnStyle(open: boolean): CSSProperties {
  if (open) return toolBtn('accent');
  return toolBtn('default');
}

function deriveBtnStyle(busy: boolean): CSSProperties {
  return {
    border: '1px solid var(--accent)',
    borderRadius: 6,
    padding: '4px 10px',
    background: 'var(--card-bg)',
    color: 'var(--accent)',
    cursor: busy ? 'default' : 'pointer',
    fontSize: 12,
  };
}

function deriveBtnLabel(busy: boolean): string {
  if (busy) return '推导中…';
  return '按规则推导';
}

function exportBtnLabel(exporting: boolean, idleLabel: string): string {
  if (exporting) return '导出中…';
  return idleLabel;
}

function excelExportTitle(blocked: boolean, audienceTag: string): string {
  if (blocked) return '有行未通过录入校验（§5.2：导出禁用），先修正';
  return `按当前选择出件（${audienceTag}）`;
}

function pdfExportTitle(blocked: boolean, okTitle: string): string {
  if (blocked) return '有行未通过录入校验（§5.2：导出禁用），先修正';
  return okTitle;
}

function exportUnreviewedNote(unreviewed: number): string {
  if (unreviewed > 0) return ` · 内含「${unreviewed} 行为系统推导值，未人工复核」标注`;
  return ' · 全部行为人工复核值';
}

function diffTotalStyle(deltaMonths: number): CSSProperties {
  return {
    fontFamily: MONO,
    marginLeft: 'auto',
    color: deltaMonths === 0 ? 'var(--text-muted)' : 'var(--danger)',
  };
}

function diffTotalSign(deltaMonths: number): string {
  if (deltaMonths > 0) return '+';
  return '';
}

export function EstimatePanel({ projectId, plans, collapsedMs, onToggleMsCollapse, onToast, hideHeading = false }: EstimatePanelProps) {
  const [data, setData] = useState<EstimatesResponse | null>(null);
  const [derives, setDerives] = useState<DeriveItem[]>([]);
  const [reqNosByPlan, setReqNosByPlan] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deriveBusy, setDeriveBusy] = useState(false);
  // ---------- T02040（§5.3）：行内录入 / 批量填充 / 撤销 / 只看未复核 ----------
  const [draft, setDraft] = useState<Draft | null>(null);
  /** planId → 服务端拒绝文案。判定权在服务端：面板不复写 `pointsError`，只把被拒的行标红 */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [selIds, setSelIds] = useState<string[]>([]);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [uniformOpen, setUniformOpen] = useState(false);
  const [uniform, setUniform] = useState<{ m: string; oMul: string; pMul: string }>({ m: '', oMul: '', pMul: '' });
  // ---------- T02046（§7 变更影响与影响试算）----------
  /** 本会话显式解锁过的行（§7「只读化（保留可解锁）」）：逐行、不持久化，写请求带 `unlock:true` 由服务端放行 */
  const [unlockedRows, setUnlockedRows] = useState<string[]>([]);
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  /** 只存「改过的」系数与行 P 值：空串=沿用服务端生效值。把空串发给服务端等于用 0 覆盖报价依据 */
  const [whatIfCoefs, setWhatIfCoefs] = useState<Record<string, string>>({});
  const [whatIfP, setWhatIfP] = useState<Record<string, string>>({});
  const [whatIfBusy, setWhatIfBusy] = useState(false);
  const [whatIfErr, setWhatIfErr] = useState('');
  const [whatIf, setWhatIf] = useState<WhatIfResponse | null>(null);

  // ---------- T02043（§5.2 第 4 段）：导出区 ----------
  const [audience, setAudience] = useState<EstimateExportAudience>('internal');
  /** §6.1 的 `scope` 只管「是否仅已估算行」，阶段筛选另有 `phases` 参数（面板暂不暴露，导出即全六阶段） */
  const [estimatedOnly, setEstimatedOnly] = useState(false);
  // 三种出件（Excel / PDF 内部版 / PDF 客户版）共用一条并发闸，但「导出中…」只标在被点的那枚上——
  // 三枚按钮同时亮同一个词等于让界面说不清此刻在出哪份件
  const [exportingKind, setExportingKind] = useState<'xlsx' | 'pdf' | null>(null);
  const exporting = exportingKind !== null;
  const [snapshots, setSnapshots] = useState<EstimateSnapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState('');
  const [cmpIds, setCmpIds] = useState<string[]>([]);
  const [cmpDiff, setCmpDiff] = useState<{ a: EstimateSnapshot; b: EstimateSnapshot; diff: SnapshotDiff } | null>(null);
  const [lastExport, setLastExport] = useState<{ filename: string; unreviewed: number } | null>(null);
  // ---------- T02624（§11-E13 改值历史 · §12-R1 后半）----------
  /** 留痕取自 `GET /params` 的 `logs`（服务端已按新→旧、限 50 条）；标签取自 `/meta`，前端不抄名单 */
  const [paramLogs, setParamLogs] = useState<EstimateParamLog[]>([]);
  const [paramLogLabels, setParamLogLabels] = useState<Record<string, string>>({});
  const [paramLogsError, setParamLogsError] = useState('');
  /** 同一格同一个被拒值不重复打接口（失焦是常态，否则一次错误输入会刷 N 次 400） */
  const rejectedSent = useRef<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [all, dv, matrix] = await Promise.all([
        estimatesApi.getAll(projectId),
        estimatesApi.derivePreview(projectId),
        // 需求编号列（§5.2）取需求矩阵现成接口，不为其加服务端字段
        api.get<Array<{ req_no: string; linkedPlans: Array<{ id: string }> }>>(
          `/plans/prd-requirements?projectId=${encodeURIComponent(projectId)}`,
        ),
      ]);
      setData(all);
      setDerives(dv.items);
      const map: Record<string, string[]> = {};
      for (const r of matrix) {
        for (const lp of r.linkedPlans ?? []) {
          // S1121：`(map[lp.id] ??= []).push(...)` 的赋值从表达式中拆出为独立语句，行为不变
          let list = map[lp.id];
          if (!list) {
            list = [];
            map[lp.id] = list;
          }
          list.push(r.req_no);
        }
      }
      setReqNosByPlan(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /** §6.3 快照列表（导出区下方「最近 5 次」）：失败只影响这一小块，不连带整面板进错误态 */
  const loadSnapshots = useCallback(async (): Promise<void> => {
    try {
      const r = await estimatesApi.listSnapshots(projectId);
      setSnapshots(r.snapshots);
      setSnapshotError('');
    } catch (e) {
      setSnapshots([]);
      setSnapshotError(errMsg(e));
    }
  }, [projectId]);
  useEffect(() => { void loadSnapshots(); }, [loadSnapshots]);

  /**
   * §11-E13 改值历史（T02624）：失败只影响这一小块（与快照同一处置），不连带整面板进错误态。
   * 参数是在面板外改的（`PUT /params`），所以重取走显式入口，不塞进 `load()`——
   * 行内每次录入都会触发 `load()`，把两次额外请求挂在写路径上没有意义。
   */
  const loadParamLogs = useCallback(async (): Promise<void> => {
    try {
      const [p, meta] = await Promise.all([estimatesApi.getParams(projectId), estimatesApi.getSettingMeta()]);
      setParamLogs(p.logs);
      setParamLogLabels(meta.settingLabels);
      setParamLogsError('');
    } catch (e) {
      setParamLogs([]);
      setParamLogLabels({});
      setParamLogsError(errMsg(e));
    }
  }, [projectId]);
  useEffect(() => { void loadParamLogs(); }, [loadParamLogs]);

  const rows = useMemo(
    () => buildPanelRows(plans, data?.items ?? [], derives, data?.summary.rowRatios ?? [], reqNosByPlan),
    [plans, data, derives, reqNosByPlan],
  );
  const rowById = useMemo(() => new Map(rows.map((r) => [r.planId, r])), [rows]);
  const phases = useMemo(() => groupTimelinePhases(plans), [plans]);
  // §5.4 区间条按**全部明细行**归一，不按「只看未复核」筛后的可见行：换一次筛选就改刻度，
  // 同一行的条长会凭空变化，读者以为是估算变了——实际变的只是谁被遮住。
  const whisker = useMemo(() => whiskerGeometries(rows), [rows]);
  // §5.4 可视化（E11/E14）：里程碑行不进图（§4.6 红线一），过滤口径单源——只从面板 rows 取 kind。
  const milestoneIds = useMemo(() => new Set(rows.filter((r) => r.kind === 'milestone').map((r) => r.planId)), [rows]);
  // 帕累托/E14 几何只取服务端 summary（rowRatios），零计算；title 由 rowById 反查（仅显示用）。
  // 此处早于 `if (!data) return null`，故用可选链 + 稳定空数组兜底（data 为空时组件会提前返回，memo 结果被丢弃）。
  const rowRatios = data?.summary.rowRatios ?? [];
  const pareto = useMemo(() => paretoGeometries(
    rowRatios.map((r) => ({ key: r.key, expected: r.expected, title: rowById.get(r.key)?.title ?? r.key })),
    milestoneIds,
  ), [rowRatios, rowById, milestoneIds]);
  const tornado = useMemo(
    () => tornadoGeometries(
      rowRatios.map((r) => ({ key: r.key, title: rowById.get(r.key)?.title ?? r.key, sigma: r.sigma })),
      milestoneIds,
    ),
    [rowRatios, rowById, milestoneIds],
  );

  // T02121 明细段窗口化（§9 性能红线，500 行首屏 ≤500ms）：仅「全部」明细且行数 >阈值 启用，
  // 折叠/筛选态由 estFlat 构建时即消费，渲染只切窗内行；几何与 testCaseModel.computeWindowVar 单源。
  const [scrollTop, setScrollTop] = useState(0);
  const estVirtual = rows.length > EST_VIRTUAL_THRESHOLD;
  const estFlat = useMemo<EstFlatEntry[]>(() => {
    const out: EstFlatEntry[] = [];
    for (const group of phases) {
      const ms = group.milestone;
      if (ms) out.push({ kind: 'header', key: ms.id, group });
      const collapsed = ms ? !!collapsedMs[ms.id] : false;
      if (collapsed) continue; // 折叠态：段体随折叠整体收起（与列表/甘特共用 collapsedMs）
      const msRow = ms ? rowById.get(ms.id) : null;
      const items = [msRow, ...group.items.map((p) => rowById.get(p.id))].filter((r): r is PanelRow => !!r);
      for (const r of items) {
        if (onlyUnreviewed && r.source === 'manual') continue; // 与旧逻辑一致：手动已复核行在「只看未复核」下隐藏
        out.push({ kind: 'item', key: r.planId, row: r });
      }
    }
    return out;
  }, [phases, rowById, collapsedMs, onlyUnreviewed]);
  const estOffsets = useMemo(() => {
    const off = [0];
    let acc = 0;
    for (const e of estFlat) {
      acc += e.kind === 'header' ? EST_HEADER_H : EST_ITEM_H;
      off.push(acc);
    }
    return off;
  }, [estFlat]);
  const estWin = estVirtual ? computeWindowVar(scrollTop, estOffsets, VIRTUAL_VIEWPORT_H, VIRTUAL_OVERSCAN) : null;
  const estVisible = estWindowSlice(estFlat, estWin);

  /** 空态：一条估算都没落库（未录入 ≠ 全为 default——default 行也要先经「按规则推导」写入才存在） */
  const isEmpty = !loading && !error && (data?.items.length ?? 0) === 0;

  /** 明细非虚拟分支的扁平行（S3776：自 phases.map 回调里的链式 filter/map 抽为局部函数，口径不变） */
  const flatGroupRows = (group: ReturnType<typeof groupTimelinePhases>[number]): PanelRow[] => {
    const msRow = group.milestone ? rowById.get(group.milestone.id) : null;
    const items = [msRow, ...group.items.map((p) => rowById.get(p.id))].filter((r): r is PanelRow => !!r);
    return items.filter((r) => !onlyUnreviewed || r.source !== 'manual');
  };

  async function fillByRules(): Promise<void> {
    setDeriveBusy(true);
    try {
      const preview = await estimatesApi.derivePreview(projectId);
      const n = preview.writableCount;
      if (n === 0) { onToast('没有可推导的行（可能全部已录入或均为里程碑）'); return; }
      const go = await askConfirm(
        `将按 §4.6 三档规则写入 ${n} 行初始估算值（里程碑与人工行不动）。\n`
        + `用例加权档的 k=${preview.caseWeightK}（来源：${preview.caseWeightKFrom}）。\n预览行数与写入行数同源，确认即写入？`,
      );
      if (!go) return;
      const w = await estimatesApi.deriveWrite(projectId);
      // S4624：嵌套模板串先赋给局部 const 再插值，文案逐字不变
      const rejectedNote = (w.errors?.length ?? 0) > 0 ? `，${w.errors?.length} 行被拒` : '';
      onToast(`已按规则推导写入 ${w.written ?? 0} 行${rejectedNote}`);
      await load();
    } catch (e) {
      onToast(`推导失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeriveBusy(false);
    }
  }

  /** 可见行（「只看未复核」= source≠manual：规则/默认/未录入都算待复核，§5.2 状态要求） */
  const visibleRows = useMemo(
    () => rows.filter((r) => !onlyUnreviewed || r.source !== 'manual'),
    [rows, onlyUnreviewed],
  );
  /** 批量填充的作用域：可见 + 非里程碑（里程碑行服务端也不落估算，红线下不放进候选） */
  const batchableIds = useMemo(
    () => visibleRows.filter((r) => r.kind !== 'milestone').map((r) => r.planId),
    [visibleRows],
  );
  const selRows = useMemo(
    () => selIds.map((id) => rowById.get(id)).filter((r): r is PanelRow => !!r && r.kind !== 'milestone'),
    [selIds, rowById],
  );

  const toggleSel = (id: string): void =>
    setSelIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const selectAllVisible = (): void => setSelIds(batchableIds);

  /** 一次批量写入的可撤销记录（原值取**写入前**的行快照，连 `source` 一起带上才谈得上还原） */
  function pushUndo(label: string, count: number, before: Array<{ planId: string; snapshot: EstimateInput | null }>): void {
    if (before.length === 0) return;
    setUndoStack((p) => [...p, { label, count, before }]);
  }

  /** 清除某行的被拒标红（S3776：两处重复的 setRowErrors 撤销逻辑抽为局部函数，行为不变） */
  const clearRowError = (planId: string): void => {
    setRowErrors((prev) => {
      if (!(planId in prev)) return prev;
      const next = { ...prev };
      delete next[planId];
      return next;
    });
  };

  /**
   * 单格保存（§5.3：Enter / 失焦即 PATCH）。
   * 值的合法性一律交服务端：`O>M`、负数、非数字都由 400 中文文案回，面板只把该行标红——
   * 前端再判一遍就是两套判据（同 §9 计算单源，也同 E4 首段的零计算红线）。
   */
  async function commitDraft(d: Draft | null): Promise<void> {
    setDraft(null);
    if (!d) return;
    const r = rowById.get(d.planId);
    if (!r) return;
    const raw = d.value.trim();
    // 清空 = 取消这次编辑：0 人天是一条真实报价，不该由误触落库
    if (raw === '') return;
    const key = `${d.planId}|${d.field}|${raw}`;
    if (rejectedSent.current.has(key)) return; // 同一个被拒值不重打接口（失焦会连着触发）
    if (r.persisted && String(r[d.field] ?? '') === raw) {
      clearRowError(d.planId);
      return;
    }

    let input: EstimateInput;
    if (r.persisted) {
      // 单字段 PATCH：另外两点由服务端沿用原值（§8 PATCH 语义）
      const single: EstimateInput = {};
      single[d.field] = raw;
      input = single;
    } else {
      // 建议行落库=新建估算行，三点必填才过得了服务端校验；未编辑的两点继承推导值
      const filled = buildPatchInput(d.field, raw, r, (label) => onToast(`该行没有可继承的推导值，请把「${label}」一起填上`));
      if (!filled) return;
      input = filled;
    }
    // §7 收口里程碑的显式解锁：能走到这里的只读行都是本会话点过「解锁改写」的（其余输入框是 disabled）。
    // 真拦截在服务端 `requirePlan`，这里的 `unlock` 只是把用户意图带到，面板不因为「看起来只读」就不发请求。
    if (r.drift?.locked) input.unlock = true;

    setBusy(true);
    try {
      await estimatesApi.patchItem(projectId, d.planId, input);
      rejectedSent.current.delete(key);
      clearRowError(d.planId);
      await load(); // E/σ/汇总卡的新值仍由服务端算（§10-3「即时刷新」的实现方式）
    } catch (e) {
      rejectedSent.current.add(key);
      setRowErrors((p) => ({ ...p, [d.planId]: errMsg(e) }));
      // 被拒的值留在格子里：清掉它就逼用户重打一遍，而红框+行内文案已经说明了为什么没进去。
      // 连着触发的失焦不会重打接口——`rejectedSent` 按 planId|field|value 拦。
      setDraft(d);
    } finally {
      setBusy(false);
    }
  }

  /** 打开「统一值 + 相对幅度」表单：倍率预填服务端下发的 `ruleRatio`，面板不自带一套经验值 */
  function openUniform(): void {
    const ratio = data?.params.config.ruleRatio;
    setUniform({ m: '', oMul: ratio ? String(ratio.oMul) : '', pMul: ratio ? String(ratio.pMul) : '' });
    setUniformOpen(true);
  }

  /** §7 收口里程碑的逐行解锁（只影响本会话的输入态与 `unlock` 入参，库里与参数都没有第二个开关） */
  function toggleUnlock(planId: string): void {
    setUnlockedRows((p) => (p.includes(planId) ? p.filter((x) => x !== planId) : [...p, planId]));
  }

  function openWhatIf(): void {
    setWhatIfCoefs({});
    setWhatIfP({});
    setWhatIf(null);
    setWhatIfErr('');
    setWhatIfOpen(true);
  }

  /**
   * §7 影响试算：把「改过的」系数与勾选行的 P 覆盖发给服务端，取回前后两端的读数。
   * 面板不参与任何运算——连 Δ% 都是服务端算的（`delta.pct`），这里只做格式化与排版。
   */
  async function runWhatIf(): Promise<void> {
    setWhatIfBusy(true);
    setWhatIfErr('');
    try {
      const coefs: Record<string, number> = {};
      for (const [k, v] of Object.entries(whatIfCoefs)) {
        if (String(v).trim() !== '') coefs[k] = Number(v);
      }
      const rows = selRows
        .filter((r) => r.persisted && String(whatIfP[r.planId] ?? '').trim() !== '')
        .map((r) => ({
          planId: r.planId,
          optimistic: r.optimistic as number,
          likely: r.likely as number,
          pessimistic: Number(whatIfP[r.planId]),
        }));
      const resp = await estimatesApi.whatIf(projectId, {
        ...(Object.keys(coefs).length > 0 ? { coefs } : {}),
        ...(rows.length > 0 ? { rows } : {}),
      });
      setWhatIf(resp);
    } catch (e) {
      setWhatIf(null);
      setWhatIfErr(errMsg(e));
    } finally {
      setWhatIfBusy(false);
    }
  }

  /**
   * 批量填充·统一值模式（§5.3 模式 ③，S3776：自 runBatch 抽出的局部函数，行为逐字保留）。
   */
  async function runUniformBatch(): Promise<void> {
    const nums = [uniform.m, uniform.oMul, uniform.pMul].map((v) => v.trim());
    if (nums.some((v) => v === '' || !Number.isFinite(Number(v)))) {
      onToast('统一值模式需要「最可能 M」与两个倍率都填数字');
      return;
    }
    const mArr = nums.map(Number);
    const [m, oMul, pMul] = [mArr[0], mArr[1], mArr[2]];
    if (m <= 0 || oMul <= 0 || pMul <= 0) { onToast('统一值与倍率必须是正数'); return; }
    const pts = uniformPoints(m, oMul, pMul);
    const items = selRows.map((r) => ({
      planId: r.planId,
      ...pts,
      source: 'manual' as const, // 人给的统一值就是人工复核，不能让批量通道把徽标留在「规则」
      ...(r.phase ? { phase: r.phase as EstimateInput['phase'] } : {}),
    }));
    const go = await askConfirm(
      `将把 ${items.length} 行的三点设为 O ${num(pts.optimistic)} / M ${num(pts.likely)} / P ${num(pts.pessimistic)} 人天`
      + `（M=${num(m)}，倍率 ${num(oMul)} / ${num(pMul)}，落 0.5 网格）。\n`
      + '已有估算的行会被覆盖并转「人工」，确认写入？',
    );
    if (!go) return;
    const before = selRows.map((r) => ({ planId: r.planId, snapshot: snapshotRow(r) }));
    const w = await estimatesApi.batchSet(projectId, items);
    if (w.written === 0) {
      // 服务端「任一行不合格零写入」：把行级错误摊到对应行上，一行都不动
      const next: Record<string, string> = {};
      w.errors.forEach((e) => { next[e.planId] = e.message; });
      setRowErrors((p) => ({ ...p, ...next }));
      onToast(`批量填充被拒绝：${w.errors.length > 0 ? w.errors[0].message : '未写入任何行'}`);
      return;
    }
    pushUndo(`统一值填充 ${w.written} 行`, w.written, before);
    // S4624：嵌套模板串先赋给局部 const 再插值，文案逐字不变
    const rejectedNote = w.errors.length > 0 ? `，${w.errors.length} 行被拒` : '';
    onToast(`已填充 ${w.written} 行${rejectedNote}`);
    await load();
  }

  /**
   * 批量填充·规则重推模式（§5.3 模式 ①②，S3776：自 runBatch 抽出的局部函数，行为逐字保留）。
   * includeManual 缺省 false：§4.6 红线二在批量通道同样生效——人工复核过的行由服务端跳过
   * （skip='manual'），面板如实报数，而不是替用户决定「覆盖你复核过的值」。
   * `onlyRule` 是这三个按钮的全部区别：不带它，「按用例加权重推」会和「按复杂度重推」做同一件事。
   */
  async function runRuleBatch(mode: DeriveRule): Promise<void> {
    const deriveOpts = { planIds: selRows.map((r) => r.planId), scope: 'all' as const, onlyRule: mode };
    const preview = await estimatesApi.batchDerive(projectId, { ...deriveOpts, dryRun: true });
    const n = preview.writableCount;
    if (n === 0) {
      onToast(`没有可${BATCH_RULE_LABEL[mode]}的行（${preview.skipped.length} 行全部被跳过，原因见明细 tooltip）`);
      return;
    }
    const skipped = preview.skipped.length;
    // S4624：嵌套模板串先赋给局部 const 再插值，文案逐字不变
    const skipNote = skipped > 0
      ? `，${skipped} 行跳过（其中 ${countSkip(preview, 'offRule')} 行不属于该档、${countSkip(preview, 'manual')} 行为人工复核过的行）`
      : '';
    const go = await askConfirm(
      `${BATCH_RULE_LABEL[mode]}：选中 ${selRows.length} 行中 ${n} 行可写入${skipNote}。\n`
      + `用例加权档的 k=${preview.caseWeightK}（来源：${preview.caseWeightKFrom}）。\n预览行数与写入行数同源，确认即写入？`,
    );
    if (!go) return;
    const before = new Map(selRows.map((r) => [r.planId, snapshotRow(r)]));
    const w = await estimatesApi.batchDerive(projectId, deriveOpts);
    // 撤销快照只覆盖**真正被写入**的行：优先取服务端回传的 `writtenPlanIds`（等长才非空），
    // 拿不到时按本次选中的可写行兜底——绝不拿「全选可见」当作用域，否则会碰到没写过的行。
    // S3358：嵌套三元拆成两个独立语句（兜底 ids 为纯计算，提前求值不改变行为）
    const fallbackIds = (w.written ?? 0) > 0 ? selRows.filter((r) => preview.items.some((it) => it.planId === r.planId && it.writable)).map((r) => r.planId) : [];
    const ids = w.writtenPlanIds && w.writtenPlanIds.length > 0 ? w.writtenPlanIds : fallbackIds;
    pushUndo(`${BATCH_RULE_LABEL[mode]} ${w.written ?? 0} 行`, w.written ?? 0, ids.map((id) => ({ planId: id, snapshot: before.get(id) ?? null })));
    // S4624：嵌套模板串先赋给局部 const 再插值，文案逐字不变
    const rejectedNote = (w.errors?.length ?? 0) > 0 ? `，${w.errors?.length} 行被拒` : '';
    onToast(`已${BATCH_RULE_LABEL[mode]}写入 ${w.written ?? 0} 行${rejectedNote}`);
    await load();
  }

  /**
   * 批量填充（§5.3 三模式）：预览 → `askConfirm` → 写入 → 压撤销栈。
   * 模式 ①② 走 `mode=derive` + `onlyRule`：**过滤不是强制改算式**——某行的自然择档不是它时
   * 服务端整行跳过（`skip='offRule'`），面板如实报「N 行不属于该档」。没有复杂度档的行被
   * 「按复杂度」硬填出数来就是假数据，这条是本次实施给服务端补的口径。
   * （S3776：两种模式的执行体抽为 runUniformBatch / runRuleBatch 局部函数，闸与错误口径留在入口。）
   */
  async function runBatch(mode: BatchMode): Promise<void> {
    if (selRows.length === 0) { onToast('先勾选要批量填充的行（里程碑行不参与）'); return; }
    setBusy(true);
    try {
      if (mode === 'uniform') {
        await runUniformBatch();
        return;
      }
      await runRuleBatch(mode);
    } catch (e) {
      onToast(`批量填充失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 撤销最近一次批量写入（§5.3：会话内存栈；原态是「无估算行」的，删除才等价于回滚） */
  async function undoLast(): Promise<void> {
    const entry = undoStack.at(-1);
    if (!entry) return;
    setBusy(true);
    try {
      const restore = entry.before.filter((b) => b.snapshot !== null).map((b) => ({ planId: b.planId, ...b.snapshot as EstimateInput }));
      const drop = entry.before.filter((b) => b.snapshot === null).map((b) => b.planId);
      let restored = 0, removed = 0;
      if (restore.length > 0) {
        const r = await estimatesApi.batchSet(projectId, restore);
        if (r.written === 0) {
          onToast(`撤销失败：${r.errors[0]?.message ?? '未写入任何行'}`);
          return;
        }
        restored = r.written;
      }
      for (const id of drop) {
        // 只读行（§7）的删除同样要带 `unlock`——否则「解锁改写后撤销」会卡在删除这一步
        const res = await estimatesApi.removeItem(projectId, id, { unlock: rowById.get(id)?.drift?.locked === true });
        if (res.removed) removed += 1;
      }
      setUndoStack((p) => p.slice(0, -1));
      setSelIds([]);
      // S4624：嵌套模板串先赋给局部 const 再插值，文案逐字不变
      const removedNote = removed > 0 ? `，删除 ${removed} 行新建估算` : '';
      onToast(`已撤销「${entry.label}」：还原 ${restored} 行${removedNote}`);
      await load();
    } catch (e) {
      onToast(`撤销失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * §6.1 / §6.2 导出：件名与快照 id 都取自服务端响应头（`api.exportXlsx` / `api.exportPdf`），
   * 面板不拼第二套命名口径；「未人工复核 N 行」取的是**这份件**写进快照的那个数（§6.3 留痕侧），
   * 不是面板另算一遍的筛选计数。两种格式在客户端只是路径不同——服务端 `buildEstimateArtifact`
   * 保证同一份行落位、同一个件名规则、同一条快照留痕。
   *
   * `aud` 缺省跟随受众 radio（Excel 用），PDF 两枚按钮各带各的受众（§5.2 第 4 段：
   * 「导出 PDF（内部版）」「导出 PDF（客户版）」——§10-9 要一次出两版对照，radio 只能表达一个）。
   */
  async function runExport(
    fmt: 'xlsx' | 'pdf' = 'xlsx',
    aud: EstimateExportAudience = audience,
  ): Promise<void> {
    setExportingKind(fmt);
    const opts: EstimateExportOptions = {
      audience: aud,
      scope: (estimatedOnly ? 'estimated_only' : 'all') as EstimateExportScope,
    };
    try {
      const r = fmt === 'pdf'
        ? await estimatesApi.exportPdf(projectId, opts)
        : await estimatesApi.exportXlsx(projectId, opts);
      saveBlob(r.blob, r.filename);
      onToast(`已导出 ${r.filename}`);
      const list = await estimatesApi.listSnapshots(projectId);
      setSnapshots(list.snapshots);
      setSnapshotError('');
      const row = list.snapshots.find((x) => x.id === r.snapshotId);
      const pl = row ? parseSnapshotPayload(row.payload) : null;
      setLastExport(pl ? { filename: r.filename, unreviewed: pl.unreviewed } : null);
      setCmpIds([]);
      setCmpDiff(null);
      // §7「上次导出后 N 条计划已变化 → 建议重导」必须在这一次出件后归零：提示读的是
      // `data.checks.changedSinceExport`，而 `listSnapshots` 只换快照列表、不动 checks——
      // 少这一步，出件成功的界面反而会长期挂着一条已经不成立的「建议重导」（本地把计数写成 0 是第二套口径，不做）。
      await load();
    } catch (e) {
      onToast(`导出失败：${errMsg(e)}`);
    } finally {
      setExportingKind(null);
    }
  }

  /** 对比至多选两条（§5.2 第 4 段）：第三条进来时挤掉最早的一条，不给「先取消再选」的额外步骤 */
  const toggleCmp = (id: string): void => {
    setCmpIds((p) => {
      const next = p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2);
      return next;
    });
    setCmpDiff(null);
  };

  async function runCompare(): Promise<void> {
    if (cmpIds.length !== 2) return;
    try {
      const r = await estimatesApi.compareSnapshots(projectId, cmpIds[0], cmpIds[1]);
      if (!r.compare) { onToast('两次快照无法比对（可能已不在最近 20 条内）'); setCmpDiff(null); return; }
      setCmpDiff(r.compare);
    } catch (e) {
      onToast(`比对失败：${errMsg(e)}`);
    }
  }

  /** §7 的显式清理入口：脱离计划的估算行——先列清单再确认，绝不做成自动清理 */
  async function cleanupDetached(): Promise<void> {
    setBusy(true);
    try {
      const list = await estimatesApi.listDetached(projectId);
      const ids = list.rows.map((r) => r.id);
      if (ids.length === 0) { onToast('当前没有脱离计划的估算行（可能刚被其他入口清理过）'); await load(); return; }
      const sample = list.rows.slice(0, 3).map((r) => `${num(r.optimistic)}/${num(r.likely)}/${num(r.pessimistic)}`).join('、');
      const go = await askConfirm(
        `有 ${ids.length} 条估算已脱离计划（计划被彻底删除后估算按 §7 原样保留）。\n`
        + `三点值：${sample}${ids.length > 3 ? ' 等' : ''} 人天。\n`
        + '删除后不进撤销栈、无法恢复，确认清理？',
      );
      if (!go) return;
      const r = await estimatesApi.cleanupDetached(projectId, ids);
      // S7735：取反条件改正向（分支互换）；S4624：嵌套模板串先赋给局部 const 再插值。文案逐字不变
      const undelNote = r.removed === ids.length ? '' : `，${ids.length - r.removed} 条未删（已不满足脱离条件）`;
      onToast(`已清理 ${r.removed} 条脱离计划的估算行${undelNote}`);
      await load();
    } catch (e) {
      onToast(`清理失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 12 }}>
        <div className="skel" style={{ width: 150, height: 14 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ flex: 1, height: 58 }} />)}
        </div>
        <div className="skel" style={{ width: '60%', height: 12, marginTop: 14 }} />
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 22, marginTop: 8 }} />)}
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 8 }}>估算数据加载失败</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, wordBreak: 'break-all' }}>{error}</div>
        <button type="button" className="tbtn-anim" onClick={() => void load()}
          style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '4px 10px', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;

  // T02121：里程碑表头 / 任务行渲染（窗口化后作为扁平条目；显式 height+border-box 保证窗口数学不漂）
  const renderHeader = (group: ReturnType<typeof groupTimelinePhases>[number]): ReactElement => {
    const ms = group.milestone;
    if (!ms) return <div key={group.items[0]?.id ?? 'prelude'} aria-hidden />;
    const msRow = rowById.get(ms.id);
    const collapsed = !!collapsedMs[ms.id];
    return (
      <button
        type="button"
        key={ms.id}
        onClick={() => { onToggleMsCollapse(ms.id); }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', background: 'transparent', border: 'none', borderTop: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 12, fontWeight: 600, height: EST_HEADER_H, boxSizing: 'border-box' }}
        title={collapsed ? '展开该阶段明细' : '收起该阶段明细（与列表/甘特共用折叠态）'}
      >
        <span style={{ color: 'var(--text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ms.title}</span>
        {msRow && <span style={{ fontFamily: MONO, color: 'var(--text-muted)', fontWeight: 400 }}>E {num(msRow.expected)}</span>}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>不进 Σ</span>
      </button>
    );
  };

  // T02121：任务行（窗口化后作为扁平条目；显式 height+border-box 保证窗口数学不漂；badges 改 nowrap 防撑高）
  const renderItem = (r: PanelRow): ReactElement => {
    const err = rowErrors[r.planId];
    const locked = r.drift?.locked === true;
    const unlocked = unlockedRows.includes(r.planId);
    const editable = (r.kind !== 'milestone' && !locked) || (locked && unlocked);
    // S3358：嵌套三元 → 早返回 + 单层三元，取值口径不变
    const cellValue = (f: PointField): string => {
      if (draft && draft.planId === r.planId && draft.field === f) return draft.value;
      return r[f] === null ? '' : String(r[f]);
    };
    // S3358/S4624：嵌套三元与嵌套模板串 → 局部函数内早返回 + 单层 const（文案逐字不变）
    const cellTitle = (f: PointField): string => {
      if (!editable) {
        if (locked) return '§7 里程碑已收口 → 估算行只读（已交付项不得追溯改写报价），需点「解锁改写」';
        return '里程碑行不落估算（§4.6 红线一），值只作参考';
      }
      const unlockNote = locked && unlocked ? '（本行已显式解锁，写入带 unlock）' : '';
      const errNote = err ? `\n${err}` : '';
      return `${POINT_LABEL[f]}（人天，0.5 步进）：Enter 或失焦即落库，Esc 还原${unlockNote}${errNote}`;
    };
    const badge = (
      <span title={r.tip} style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: `1px solid ${r.badge.color}`, color: r.badge.color, whiteSpace: 'nowrap' }}>
        {r.badge.label}
      </span>
    );
    const g = whisker.get(r.planId);
    return (
      <div key={r.planId} style={{ borderBottom: '1px solid var(--border)', padding: '4px 0 4px 4px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', height: EST_ITEM_H, boxSizing: 'border-box', overflow: 'hidden' }}>
        <input
          type="checkbox"
          checked={selIds.includes(r.planId)}
          disabled={r.kind === 'milestone' || !editable}
          onChange={() => toggleSel(r.planId)}
          title={editable ? '勾选后参与批量填充' : '里程碑行不参与批量填充（§4.6 红线一）'}
          style={{ margin: 0, flex: '0 0 auto' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.suggestion ? 'var(--text-muted)' : 'var(--text)' }} title={r.title}>
            {r.reqNos.length > 0 && <span style={{ color: 'var(--text-muted)', marginRight: 4, fontFamily: MONO, fontSize: 11 }}>{r.reqNos.join('、')}</span>}
            {r.title}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, flexWrap: 'nowrap', overflow: 'hidden' }}>
            {badge}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>复杂度 {r.complexity ?? '—'}</span>
            {r.drift?.flag && (
              <span
                title={`偏差比值 = E ÷ 排期工作日 = ${num(r.drift.ratio)}\n服务端阈值：> ${data.checks.drift.thresholds.high} 或 < ${data.checks.drift.thresholds.low}（§7「计划工期改动」行，面板不重算比值）`}
                style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: '1px solid var(--warning, #c80)', color: 'var(--warning, #c80)', whiteSpace: 'nowrap' }}
              >
                偏差 {num(r.drift.ratio)}
              </span>
            )}
            {r.drift?.pressure && (
              <span
                title={`E ${num(r.expected)} 人天 > 剩余排期工作日 ${num(r.drift.remainingWorkdays)}（今日 ${data.checks.drift.today}，工作日已扣节假日/计加班日）`}
                style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: '1px solid var(--danger)', color: 'var(--danger)', whiteSpace: 'nowrap' }}
              >
                超排期
              </span>
            )}
            {locked && (
              <span
                title={unlocked
                  ? '本会话已解锁：改写会带 unlock 入参，服务端放行这一行（不改任何全局开关）'
                  : '§7 已收口里程碑 → 估算行只读（已交付项不得追溯改写报价）；确需改写点右侧「解锁改写」'}
                style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: `1px solid ${unlocked ? 'var(--accent)' : 'var(--border-strong)'}`, color: unlocked ? 'var(--accent)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}
              >
                {unlocked ? '已解锁' : '已收口·只读'}
              </span>
            )}
            {locked && (
              <button type="button" className="tbtn-anim" style={toolBtn(unlocked ? 'danger' : 'accent')} onClick={() => toggleUnlock(r.planId)}
                title={unlocked ? '收回解锁，本行重新按只读处理' : '仅对本行、仅本会话放开编辑；写入仍走服务端校验'}>
                {unlocked ? '取消解锁' : '解锁改写'}
              </button>
            )}
            {err && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{err}</span>}
          </div>
          <WhiskerBar row={r} geom={g} />
        </div>
        <div style={{ display: 'flex', gap: 4, fontFamily: MONO, textAlign: 'right', alignItems: 'center' }}>
          {POINT_FIELDS.map((f) => (
            <input
              key={f}
              type="number"
              step={0.5}
              min={0}
              disabled={!editable || busy}
              value={cellValue(f)}
              placeholder="—"
              aria-label={`${r.title} ${POINT_LABEL[f]}（人天）`}
              title={cellTitle(f)}
              onChange={(e) => setDraft({ planId: r.planId, field: f, value: e.target.value })}
              onFocus={() => setDraft({ planId: r.planId, field: f, value: cellValue(f) })}
              onBlur={() => void commitDraft(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitDraft(draft); }
                else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
              }}
              style={{ ...pointInput(err), color: f === 'likely' ? 'var(--text)' : 'var(--text-muted)' }}
            />
          ))}
          <span style={{ width: 38, textAlign: 'right' }} title="期望值 E（服务端算，只读）">{num(r.expected)}</span>
          <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }} title="σ（未落库行不计算）">{num(r.sigma)}</span>
        </div>
      </div>
    );
  };

  const s = data.summary;
  const cfg = data.params.config;
  const rc = s.ratioCheck;

  // S4624：嵌套模板串（外层 title 串内再嵌 rows.map 的模板串）→ 内层先赋 const 再插值。文案逐字不变
  const changedRowsNote = data.checks.changedSinceExport.rows
    .map((c) => `${c.title}（${c.changed.join('+')}）`)
    .join('、');
  // S3358：嵌套三元（Excel 导出按钮 title 里嵌受众三元）→ 独立 const
  const audienceTag = audienceTagLabel(audience);
  // S3776：偏差提示区四个判据先命名再组合（布尔代数与原式等价），并从 JSX 条件中提出
  const hasChangedSinceExport = data.checks.changedSinceExport.count > 0;
  const hasDriftPressure = data.checks.drift.pressure > 0;
  const hasDriftLocked = data.checks.drift.locked > 0;
  const hasDriftDeviation = data.checks.drift.high + data.checks.drift.low > 0;
  const hasDriftNotices = hasChangedSinceExport || hasDriftPressure || hasDriftLocked || hasDriftDeviation;
  // S3776：导出禁用判据提出为命名 const（`disabled={}` 中直接 false 分支，行为等价）
  const hasBlockedRows = Object.keys(rowErrors).length > 0;
  const rowErrorCount = Object.keys(rowErrors).length;
  const rowErrorIds = Object.keys(rowErrors);
  // S3776：批量档按钮名单（自 JSX 的 Object.keys(...).map 链提出，口径不变）
  const batchRuleKeys = Object.keys(BATCH_RULE_LABEL) as DeriveRule[];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
      {/* 1) 汇总卡（sticky，§5.2-1）——读数全部来自服务端 summary */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, padding: 10, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={headingTitleStyle(hideHeading)}>估算面板</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: MONO }}>
            {cfg.manDaysPerManMonth} 人天/人月 · 系数和 {num(s.coefSum)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{card('实际预估人月 P50 / P84', `${num(s.quote.p50ManMonth)} / ${num(s.quote.p84ManMonth)}`, `σ_total ${num(s.quote.sigma)} 人天`)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>{card('理想人月（ΣE）', num(s.idealManMonths.expected), `直接投入 ${num(s.directManDays.expected)} 人天`)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>{card('Σ估算比例（I40）', pct(rc.sumRatio), `偏差 ${devPct(rc.deviationPct)}`, rc.danger)}</div>
        </div>
        {/* §7 变更影响提示条（sticky 区常驻）：计数与文案口径都在服务端 checks，面板不做第二次判定 */}
        {hasDriftNotices && (
          <output aria-label="估算变更影响提示" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
            {hasChangedSinceExport && (
              <div
                style={{ color: 'var(--warning, #c80)', cursor: 'help' }}
                title={`上次导出：${data.checks.changedSinceExport.at}（快照 ${data.checks.changedSinceExport.snapshotId}）\n其后有变更的计划：${changedRowsNote}`}
              >
                上次导出后 {data.checks.changedSinceExport.count} 条计划已变化 → 建议重导
              </div>
            )}
            {hasDriftPressure && (
              <div style={{ color: 'var(--danger)', cursor: 'help' }} title={`今日 ${data.checks.drift.today}；E 人天 > 剩余排期工作日的行（§7「排期与估算不一致」）`}>
                {data.checks.drift.pressure} 行估算人天超过剩余排期工作日 —— 排期与估算不一致
              </div>
            )}
            {hasDriftDeviation && (
              <div style={{ color: 'var(--text-muted)', cursor: 'help' }}
                title={`偏差比值 = E ÷ 排期工作日；阈值由服务端下发（高 >${data.checks.drift.thresholds.high}、低 <${data.checks.drift.thresholds.low}）`}>
                {data.checks.drift.high + data.checks.drift.low} 行的 E 与排期偏差超阈值（黄色徽标，比值 = E ÷ 排期工作日）
              </div>
            )}
            {hasDriftLocked && (
              <div style={{ color: 'var(--text-muted)' }}>
                {data.checks.drift.locked} 行属于已收口里程碑，服务端已置只读（§7，需逐行显式解锁）
              </div>
            )}
          </output>
        )}
        {/* §5.3 撤销：本会话内存栈顶（批量写入前抓的原值）；空栈不占位 */}
        {undoStack.length > 0 && (() => {
          const last = undoStack.at(-1);
          if (!last) return null;
          const stepNote = undoStack.length > 1 ? `（剩 ${undoStack.length - 1} 步）` : '';
          return (
            <output aria-label="批量填充撤销条" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>已填充 {last.count} 行 · 撤销</span>
              <button type="button" className="tbtn-anim" style={toolBtn('accent', busy)} disabled={busy}
                title={`${last.label}（本会话第 ${undoStack.length} 步，仅还原最近一次批量写入）`}
                onClick={() => void undoLast()}>
                撤销{stepNote}
              </button>
            </output>
          );
        })()}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {/* 2) 阶段视图（§5.2-2）：固定 6 类阶段，无数据置灰且不删行 */}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px' }}>阶段（人天 / σ / 比例）</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {s.phases.map((ph) => {
              const empty = ph.rowCount === 0;
              return (
                <tr key={ph.phase} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 2px', color: empty ? 'var(--text-muted)' : 'var(--text)' }}>
                    {data.meta.phaseLabels[ph.phase] ?? ph.phase}
                  </td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: empty ? 'var(--text-muted)' : 'var(--text)' }}>{num(ph.expected)}</td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{num(ph.sigma)}</td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{empty ? '未纳入本次报价' : pct(ph.ratio)}</td>
                </tr>
              );
            })}
            {s.coefRows.map((c) => (
              <tr key={c.key} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 2px', color: 'var(--text-muted)' }}>{c.label}（系数）</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{num(c.points.likely)}</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>—</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{pct(c.ratio)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* §5.4 可视化图表（E11 阶段柱+误差线 / E11 帕累托 / E14 龙卷风）：数据只取服务端 summary，
            零计算、纯 SVG、CSS 变量色、里程碑行不进图、空态不画图例 */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px' }}>阶段柱与 ±1σ 误差线（E11）</div>
          <PhaseBarChart phases={s.phases} phaseLabels={data.meta.phaseLabels} />
          {chartBlock('帕累托（E11 · 按行 E 降序累计占比）', pareto.length > 0, <ParetoChart geoms={pareto} />, '暂无有效估算行')}
          {chartBlock('龙卷风（E14 · 敏感性，σ 降序）', tornado.length > 0, <TornadoChart geoms={tornado} />, '暂无 σ 数据')}
        </div>

        {/* 3) 明细工具条（§5.3 批量填充 + 只看未复核）：作用域=可见且非里程碑的行，里程碑由服务端红线排除 */}
        <div role="toolbar" aria-label="估算批量填充工具条" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '14px 0 6px' }}>
          <label
            title="隐藏已复核（source=manual）的行——规则/默认/未录入都算待复核（§5.2 状态要求）"
            style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <input type="checkbox" checked={onlyUnreviewed} onChange={(e) => setOnlyUnreviewed(e.target.checked)} />
            <span>只看未复核</span>
          </label>
          <button type="button" className="tbtn-anim" style={toolBtn()} onClick={selectAllVisible}
            title={`选中当前可见的 ${batchableIds.length} 行（里程碑行不参与批量填充）`}>
            全选可见
          </button>
          <button type="button" className="tbtn-anim" style={toolBtn('default', selIds.length === 0)} disabled={selIds.length === 0}
            onClick={() => setSelIds([])}>
            清空
          </button>
          {batchRuleKeys.map((rule) => (
            <button key={rule} type="button" className="tbtn-anim" style={toolBtn('accent', busy || selRows.length === 0)}
              disabled={busy || selRows.length === 0} onClick={() => void runBatch(rule)}
              title={`把选中行里自然择档为「${RULE_LABEL[rule]}」的那些按 §4.6 该档重推；不属于该档的行由服务端整行跳过（offRule），不硬凑假数据`}>
              {BATCH_RULE_LABEL[rule]}
            </button>
          ))}
          <button type="button" className="tbtn-anim" style={toolBtn('accent', busy)} disabled={busy || selRows.length === 0} onClick={openUniform}
            title={`给选中的 ${selRows.length} 行写同一组三点（M + O/P 倍率，落 0.5 网格）`}>
            统一值…
          </button>
          <button type="button" className="tbtn-anim" style={whatIfBtnStyle(whatIfOpen)} onClick={openWhatIf}
            title="§7 影响试算：改系数或改勾选行的 P 值，看实际预估人月 X → Y（Δ%）。零写入，试算值不落库">
            影响试算…
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>已选 {selRows.length} 行</span>
        </div>

        {uniformOpen && (
          <fieldset aria-label="统一值批量填充表单"
            style={{ margin: 0, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, background: 'var(--card-bg)', fontSize: 11 }}>
            <span style={{ color: 'var(--text-muted)' }}>统一值 + 相对幅度</span>
            {([['m', '最可能 M', '人天'], ['oMul', 'O 倍率', '如 0.8'], ['pMul', 'P 倍率', '如 1.4']] as const).map(([key, label, hint]) => {
              // S1121：三元中的解构赋值 `[[uval, ustep]] = …` 提为独立取值语句（previewUniform 同：JSX IIFE → 局部纯函数）
              const [uval, ustep] = uniformFieldState(key, uniform);
              return (
              <label key={key} title={`${label}（${hint}）`} style={{ display: 'flex', gap: 3, alignItems: 'center', color: 'var(--text-muted)' }}>
                {label}
                <input type="number" step={ustep} min={0} value={uval}
                  onChange={(e) => setUniform((p) => ({ ...p, [key]: e.target.value }))}
                  style={{ width: 52, textAlign: 'right', fontFamily: MONO, fontSize: 12, padding: '1px 2px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                />
              </label>
              );
            })}
            <span style={{ color: 'var(--text-muted)' }}>→ {previewUniform(uniform)}</span>
            <button type="button" className="tbtn-anim" style={toolBtn('accent', busy || selRows.length === 0)}
              disabled={busy || selRows.length === 0} onClick={() => void runBatch('uniform')}>
              写入 {selRows.length} 行
            </button>
            <button type="button" className="tbtn-anim" style={toolBtn()} onClick={() => setUniformOpen(false)}>取消</button>
          </fieldset>
        )}

        {/* §7 影响试算（E9）：面板只发「改过的」系数与勾选行的 P 覆盖；X → Y（Δ%）与逐阶段差全部读服务端 */}
        {whatIfOpen && (() => {
          const coefTouched = Object.values(whatIfCoefs).some((v) => String(v).trim() !== '');
          const rowTouched = selRows.some((r) => String(whatIfP[r.planId] ?? '').trim() !== '');
          // S2004 L1204/L1218：onChange 里 5 层嵌套的函数式更新闭包提为具名局部函数（行为不变）
          const setCoef = (key: string, value: string): void => setWhatIfCoefs((p) => ({ ...p, [key]: value }));
          const setRowP = (planId: string, value: string): void => setWhatIfP((p) => ({ ...p, [planId]: value }));
          return (
            <fieldset aria-label="影响试算表单"
              style={{ margin: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, background: 'var(--card-bg)', fontSize: 11, marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>影响试算（零写入 · 不改配置）</span>
                <button type="button" className="tbtn-anim" style={toolBtn()} onClick={() => { setWhatIfOpen(false); setWhatIf(null); }}>收起</button>
              </div>
              {s.coefRows.map((c) => (
                <label key={c.key} title={`${c.label}：当前生效 ${num(c.points.likely)}，留空表示不改`}
                  style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-muted)', marginBottom: 2 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  <span style={{ fontFamily: MONO }}>{num(c.points.likely)}</span>
                  <input type="number" step={0.01} min={0} max={1} value={whatIfCoefs[c.key] ?? ''} placeholder="改为"
                    onChange={(e) => setCoef(c.key, e.target.value)}
                    style={{ width: 48, textAlign: 'right', fontFamily: MONO, fontSize: 12, padding: '1px 2px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                  />
                </label>
              ))}
              {selRows.some((r) => r.persisted) && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>勾选行的悲观 P 覆盖（留空=不改）</div>
                  {selRows.filter((r) => r.persisted).map((r) => (
                    <label key={r.planId} title={`${r.title}：当前 P ${num(r.pessimistic)}`}
                      style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-muted)', marginBottom: 2 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                      <span style={{ fontFamily: MONO }}>{num(r.pessimistic)}</span>
                      <input type="number" step={0.5} min={r.likely ?? 0} value={whatIfP[r.planId] ?? ''} placeholder="P"
                        onChange={(e) => setRowP(r.planId, e.target.value)}
                        style={{ width: 44, textAlign: 'right', fontFamily: MONO, fontSize: 12, padding: '1px 2px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                <button type="button" className="tbtn-anim" style={toolBtn('accent', whatIfBusy || !(coefTouched || rowTouched))}
                  disabled={whatIfBusy || !(coefTouched || rowTouched)} onClick={() => void runWhatIf()}
                  title="改系数或改勾选行 P 后点它：只算不写（服务端 what-if），要真改参数请去导出区上方的参数入口">
                  试算
                </button>
                {!(coefTouched || rowTouched) && <span style={{ color: 'var(--text-muted)' }}>先改一个系数或某行 P</span>}
                {whatIfErr && <span style={{ color: 'var(--danger)' }}>{whatIfErr}</span>}
              </div>
              {whatIf && (
                <output aria-label="影响试算结果" style={{ display: 'block', marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                  <div>
                    实际预估人月 {num(whatIf.before.actualManMonths)} → <b>{num(whatIf.after.actualManMonths)}</b>
                    （Δ {numSigned(whatIf.delta.actualManMonths)} · {pctSigned(whatIf.delta.pct)}）
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    直接投入人天 {num(whatIf.before.directManDays)} → {num(whatIf.after.directManDays)}
                    （Δ {numSigned(whatIf.delta.directManDays)}）· 系数和 {num(whatIf.before.coefSum)} → {num(whatIf.after.coefSum)}
                  </div>
                  {whatIf.delta.phases.some((p) => Math.abs(p.delta) > 1e-9) && (
                    <div style={{ color: 'var(--text-muted)', fontFamily: MONO }}>
                      {whatIf.delta.phases.filter((p) => Math.abs(p.delta) > 1e-9)
                        .map((p) => `${data.meta.phaseLabels[p.phase] ?? p.phase} ${numSigned(p.delta)}`).join(' · ')}
                    </div>
                  )}
                  <div style={{ color: 'var(--text-muted)' }}>
                    本次试算未写入任何数据（服务端 written={whatIf.written}）；应用范围：
                    {whatIf.applied.coefs.length > 0 ? `系数 ${whatIf.applied.coefs.length} 项` : '无系数'}
                    {whatIf.applied.rows.length > 0 ? ` · 行 ${whatIf.applied.rows.length} 条` : ''}
                  </div>
                </output>
              )}
            </fieldset>
          );
        })()}

        {/* 4) 明细行（§5.2-3）：分组与折叠与时间线同源 */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '14px 0 2px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>明细（O / M / P / E / σ）</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}
            title="未录入明细=还没有三点值的明细行数；未估阶段=六个标准阶段里没有任何有值行进入 Σ 的阶段个数（与交付件 §4.4 备注同键同值，T02630 乙′）">
            已计入 Σ {s.countedKeys.length} 行 · 未录入明细 {rc.excluded.unEstimated} 行 · 未估阶段 {rc.excluded.unEstimatedPhases} 个
          </div>
        </div>
        {/* §5.4 区间条图例：没有它，那条短线就是一个没人能自证含义的图形。
            空态（一条区间都画不出来）时不渲染——图例解释的是一个当前并不存在的图形。 */}
        {whiskerLegendShown(whisker.size) && (
        <div aria-label="区间条图例" style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--accent)' }}>
            <span style={{ width: 1, height: 7, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 18, height: 1, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 2, height: 9, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 18, height: 1, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 1, height: 7, background: 'currentColor', display: 'inline-block' }} />
          </span>
          <span>区间条：端点 O / P，粗竖线 E（横向按最大 P 归一，行间可比）</span>
        </div>
        )}

        {isEmpty && (
          <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--card-bg)' }}>
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 6 }}>尚未录入估算——点「按规则推导」用复杂度/用例/工期生成初始值。</div>
            <button type="button" className="tbtn-anim" disabled={deriveBusy} onClick={() => void fillByRules()}
              style={deriveBtnStyle(deriveBusy)}>
              {deriveBtnLabel(deriveBusy)}
            </button>
          </div>
        )}

        {estVirtual ? (
          // S6819 L1294：role="list" → 原生 <ul>/<li>（UL_RESET/LI_RESET 抵消 UA 默认边距与符号，排版与原 div 一致）
          <ul
            aria-label="估算明细（虚拟滚动）"
            style={{ ...UL_RESET, maxHeight: VIRTUAL_VIEWPORT_H, overflowY: 'auto', marginTop: 8 }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {estWin && estWin.padTop > 0 && <li aria-hidden style={{ ...LI_RESET, height: estWin.padTop }} />}
            {estVisible.map((e) => (
              <li key={e.key} style={LI_RESET}>
                {e.kind === 'header' ? renderHeader(e.group) : renderItem(e.row)}
              </li>
            ))}
            {estWin && estWin.padBottom > 0 && <li aria-hidden style={{ ...LI_RESET, height: estWin.padBottom }} />}
          </ul>
        ) : (
          phases.map((group) => {
            const ms = group.milestone;
            const collapsed = ms ? !!collapsedMs[ms.id] : false;
            // S3776 L306：链式 filter/map 提出为局部函数 flatGroupRows（口径不变）
            return (
              <div key={ms?.id ?? 'prelude'} style={{ marginBottom: 0 }}>
                {ms && renderHeader(group)}
                {!collapsed && flatGroupRows(group).map((r) => renderItem(r))}
              </div>
            );
          })
        )}
        {estVirtual && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            明细已载入 {rows.length} 行（超过 {EST_VIRTUAL_THRESHOLD} 行自动启用虚拟滚动，仅渲染视口附近 {estVisible.length} 行）；折叠 / 筛选即时生效。
          </div>
        )}
        {/* 5) 告警条（§5.2 状态要求里「比例自检」那一档 + §7 脱离计划行） */}
        {(rc.danger || rc.unassigned.length > 0 || data.checks.detached > 0) && (
          <div style={{ marginTop: 10, border: `1px solid ${rc.danger ? 'var(--danger)' : 'var(--border-strong)'}`, borderRadius: 8, padding: 8, background: 'var(--card-bg)', fontSize: 12 }}>
            <div style={{ color: rc.danger ? 'var(--danger)' : 'var(--text)', marginBottom: 4 }}>
              Σ估算比例 {pct(rc.sumRatio)} 偏离 100%（{devPct(rc.deviationPct)}）
              {rc.danger ? ' —— 导出前须核对未归阶段的行' : ''}
            </div>
            {rc.unassigned.length > 0 && (
              <div style={{ color: 'var(--text-muted)' }}>
                未归入六阶段的行：{rc.unassigned.map((u) => rowById.get(u.key)?.title ?? u.key).join('、')}
              </div>
            )}
            {data.checks.detached > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>另有 {data.checks.detached} 条估算行已脱离计划</span>
                <button type="button" className="tbtn-anim" style={toolBtn('danger', busy)} disabled={busy}
                  title="§7：计划被彻底删除后估算行原样保留（历史报价依据）；清理是显式手动操作，不进撤销栈"
                  onClick={() => void cleanupDetached()}>
                  清理脱离行
                </button>
              </div>
            )}
          </div>
        )}

        {/* 6) 行内录入错误条（§5.2 状态要求：被拒的行逐行点名 + 底部计数；判据全在服务端，面板只转录 400 文案） */}
        {rowErrorIds.length > 0 && (
          <div role="alert" aria-label="行内录入错误提示"
            style={{ marginTop: 10, border: '1px solid var(--danger)', borderRadius: 8, padding: 8, background: 'var(--card-bg)', fontSize: 12, color: 'var(--danger)' }}>
            <div>{rowErrorCount} 行不满足录入校验（O≤M≤P），导出前须修正</div>
            {Object.entries(rowErrors).map(([id, msg]) => (
              <div key={id} style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                {rowById.get(id)?.title ?? id}：{msg}
              </div>
            ))}
          </div>
        )}

        {/* 6b) 改值历史（§11-E13 · §12-R1 后半，T02624）：留痕数据源只有 `GET /params` 的 `logs`
            这一面（T02120 的设计约束），键名标签走 `/meta` 的 `settingLabels` 单源，排序/条数
            一律服务端说了算——前端不排、不截、不自算第二套口径。 */}
        <section aria-label="估算参数改值历史" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span>改值历史（最近 {paramLogs.length} 条，新→旧）</span>
            <button type="button" className="tbtn-anim" style={toolBtn()} onClick={() => void loadParamLogs()}
              aria-label="刷新改值历史"
              title="参数是在面板外改的（API / 参数页），这里给一枚显式重取的入口">
              刷新
            </button>
          </div>
          {paramLogsError && (
            <div role="alert" style={{ fontSize: 11, color: 'var(--danger)' }}>改值历史读取失败：{paramLogsError}</div>
          )}
          {!paramLogsError && paramLogs.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              本次版本起尚无改值记录（此前的参数变更没有留痕，因为留痕表是这一版才建的，不是查询失败）
            </div>
          )}
          {paramLogs.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th scope="col" style={{ padding: '3px 6px 3px 0', fontWeight: 400 }}>改值时间</th>
                  <th scope="col" style={{ padding: '3px 6px 3px 0', fontWeight: 400 }}>参数</th>
                  <th scope="col" style={{ padding: '3px 6px 3px 0', fontWeight: 400 }}>旧值 → 新值</th>
                  <th scope="col" style={{ padding: '3px 6px 3px 0', fontWeight: 400 }}>操作人</th>
                  <th scope="col" style={{ padding: '3px 0 3px 0', fontWeight: 400 }}>改后生效值</th>
                </tr>
              </thead>
              <tbody>
                {paramLogs.map((log) => {
                  const eff = parseParamLogEffective(log.effective);
                  return (
                    <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '4px 6px 4px 0', whiteSpace: 'nowrap' }} title={fullTime(log.created_at)}>
                        {fullTime(log.created_at)}
                      </td>
                      <td style={{ padding: '4px 6px 4px 0' }}>{paramLogKeyLabel(log.key, paramLogLabels)}</td>
                      <td style={{ padding: '4px 6px 4px 0', fontFamily: MONO }}>
                        {(log.old_value || '（未设置）')} → {log.new_value || '（清空回落默认）'}
                      </td>
                      <td style={{ padding: '4px 6px 4px 0' }}>{paramLogActorLabel(log.actor)}</td>
                      <td style={{ padding: '4px 0', fontFamily: MONO, color: 'var(--text-muted)' }}>
                        {eff ? `${num(eff.manDaysPerManMonth)} 人天/人月 · ${num(eff.hoursPerManDay)} 人时/天 · Σ系数 ${num(eff.coefSum)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* 7) 导出区（§5.2 第 4 段 · E6 Excel + E7 PDF）：Excel 内部版/客户版 + PDF 两枚 + 最近快照与对比。
            件名、未复核行数、合并区数一律取自服务端响应头与快照 payload——面板不拼第二套口径。
            PDF 两枚按钮各自定受众（§5.2 原文形态），因为 §10-9 的验收是「一次出两版对照脱敏」。 */}
        <section aria-label="估算导出区" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>导出（Excel 复刻客户模板）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <label title="客户版不含「估算明细/参数」两个附加 sheet，也不写备注三条；开折叠后系数分项并进一行合计（报价数不变）"
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="radio" name="estimate-audience" checked={audience === 'client'} onChange={() => setAudience('client')} />
              <span>客户版</span>
            </label>
            <label title="内部版含全量明细 sheet（plan_id / 来源 / σ）与参数 sheet，供内部复核"
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="radio" name="estimate-audience" checked={audience === 'internal'} onChange={() => setAudience('internal')} />
              <span>内部版</span>
            </label>
            <label title={`scope=estimated_only：只有落了估算的行进件；不勾=全部计划（未估算行成行但三点留空，不把「没估」写成 0）`}
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={estimatedOnly} onChange={(e) => setEstimatedOnly(e.target.checked)} />
              <span>只导已估算行</span>
            </label>
            <button type="button" className="tbtn-anim" style={toolBtn('accent', exporting || hasBlockedRows)}
              disabled={exporting || hasBlockedRows} onClick={() => void runExport('xlsx')}
              aria-label="导出 Excel 文件"
              title={excelExportTitle(hasBlockedRows, audienceTag)}>
              {exportBtnLabel(exportingKind === 'xlsx', '导出 Excel')}
            </button>
            {audience === 'client' && cfg.hideCoefsForClient && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>系数分项将折叠（参数页开关）</span>
            )}
          </div>
          {/* §5.2 第 4 段的 PDF 两枚（E7）。裁决 D4：PDF 仅预览、Excel 为正式交付——这句要印在按钮旁边，
              不能只在 PRD 里；脱敏由服务端在中间文档阶段完成，按钮标题里说清各版不含什么 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <button type="button" className="tbtn-anim" style={toolBtn('default', exporting || Object.keys(rowErrors).length > 0)}
              disabled={exporting || Object.keys(rowErrors).length > 0} onClick={() => void runExport('pdf', 'internal')}
              aria-label="导出 PDF 内部版"
              title={pdfExportTitle(Object.keys(rowErrors).length > 0,
                'PDF 内部版：含系数分项、σ/P50/P84 区间、自检与备注三条（汇报/预览用，正式交付以 Excel 为准）')}>
              {exportBtnLabel(exportingKind === 'pdf', '导出 PDF（内部版）')}
            </button>
            <button type="button" className="tbtn-anim" style={toolBtn('default', exporting || Object.keys(rowErrors).length > 0)}
              disabled={exporting || Object.keys(rowErrors).length > 0} onClick={() => void runExport('pdf', 'client')}
              aria-label="导出 PDF 客户版"
              title={pdfExportTitle(Object.keys(rowErrors).length > 0,
                'PDF 客户版：服务端组装阶段就不写系数分项、σ/置信区间、备注三条与附加 sheet 名，报价数与内部版一致')}>
              导出 PDF（客户版）
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PDF 为预览件，正式交付以 Excel 为准（裁决 D4）</span>
          </div>
          {lastExport && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              本次件：{lastExport.filename}
              {exportUnreviewedNote(lastExport.unreviewed)}
            </div>
          )}

          {/* §5.2 第 4 段下半：最近 5 次快照 + 两条对比（§7「上次导出后计划已变化」的界面侧） */}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 4px' }}>
            最近导出（{snapshots.length}）
            {cmpIds.length === 2 && (
              <button type="button" className="tbtn-anim" style={{ ...toolBtn(), marginLeft: 6 }} onClick={() => void runCompare()}>
                对比所选两条
              </button>
            )}
          </div>
          {snapshotError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>快照记录读取失败：{snapshotError}</div>}
          {snapshots.length === 0 && !snapshotError && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>还没有导出记录（§6.3：每次导出写一条快照留痕）</div>
          )}
          {snapshots.map((sn) => {
            const pl = parseSnapshotPayload(sn.payload);
            const picked = cmpIds.includes(sn.id);
            return (
              <div key={sn.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11, borderBottom: '1px solid var(--border)', padding: '3px 0' }}>
                <input type="checkbox" checked={picked} onChange={() => toggleCmp(sn.id)} title="勾选两条可对比（§7 版本差异）" />
                <span style={{ fontFamily: MONO }}>{(sn.created_at ?? '').slice(0, 16).replace('T', ' ')}</span>
                <span style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{sn.format.toUpperCase()}</span>
                <span style={{ color: pl?.audience === 'client' ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {snapshotAudienceLabel(pl?.audience, sn.format)}
                </span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontFamily: MONO }} title="该次导出的实际预估人月（ΣE）">
                  {pl ? `${num(pl.actualManMonths?.expected)} 人月` : ''}
                </span>
              </div>
            );
          })}
          {cmpDiff && (
            <fieldset aria-label="两次导出差异" style={{ margin: 0, marginTop: 6, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, background: 'var(--card-bg)', fontSize: 11 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
                对比：{(cmpDiff.a.created_at ?? '').slice(0, 16).replace('T', ' ')} → {(cmpDiff.b.created_at ?? '').slice(0, 16).replace('T', ' ')}
              </div>
              {cmpDiff.diff.phases.map((p) => (
                <div key={p.phase} style={{ display: 'flex', gap: 6 }}>
                  <span>{data.meta.phaseLabels[p.phase as keyof typeof data.meta.phaseLabels] ?? p.phase}</span>
                  <span style={{ fontFamily: MONO, marginLeft: 'auto', color: deltaTone(p.expected.delta) }}>
                    {p.expected.delta > 0 ? '+' : ''}{num(p.expected.delta)} 人天
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                <span>实际预估人月</span>
                <span style={diffTotalStyle(cmpDiff.diff.totals.actualManMonths)}>
                  {diffTotalSign(cmpDiff.diff.totals.actualManMonths)}{num(cmpDiff.diff.totals.actualManMonths)}
                </span>
              </div>
            </fieldset>
          )}
        </section>
      </div>
    </div>
  );
}
