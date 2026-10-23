/**
 * T02856（六期 S5）：阶段性总结汇报 PPT 的流式生成段（PRD §4 / §3.4 第 2 步）。
 *
 * 两段式，边界刻意分开（对齐 `kickoffService.kickoffPptStream`，但多一个「先备料再开流」）：
 *  - `prepareSummaryPptStream`：参数守卫 → 一次采集 → 硬阻塞拦截 → 大纲校验。
 *    全在 SSE 头**之前**完成，失败由路由回结构化 400（前端拿得到缺哪一项 / 哪一页不对），
 *    而不是流建起来后只收到一条 error——切头之后再想改状态码就来不及了。
 *  - `renderSummaryPptStream`：逐页装配（每页一条 `stage`）→ 落盘换令牌。
 *    断连/取消在每页开头检查 `signal`，全程只有一个落盘点，所以不会留半成品或孤儿令牌。
 *
 * 纪律：
 * - 本文件**不调 AI**（PRD §4：第 1 段大纲在 S3 已产出，第 2 段只装配）；不写库（只读 + 令牌落盘）。
 * - 采集**只走 `gatherSummaryBundle` / `gatherSummaryDeckData`**，并在两段之间复用同一份 bundle：
 *   校验数与页面数必须来自同一次取数，各跑一遍会让「面板说 5 条、页面写 6 条」这种漂移无法复现。
 * - 下载文件名走 `downloadSafeName`（与 `DOWNLOAD_NAME_RE` 同源），不手拼扩展名以外的任何字符。
 */
import { discardReport, saveReportBuffer, validateProjectIds } from './ReportService';
import { downloadSafeName } from '../util/export-name';
import { assertCustomRange, assertSummaryPeriod, type CustomRange } from './summaryPptPeriod';
import {
  assertSummaryNotBlocked,
  buildSummaryPreflight,
  gatherSummaryBundle,
  type SummaryBundle,
} from './summaryPptService';
import { gatherSummaryDeckData, WORKLOAD_CALIBERS, type SummaryDeckData, type WorkloadCaliber } from './summaryPptData';
import { validateSummaryOutline, type SummaryOutlineItem } from './summaryPptOutline';

/** PRD §4：`mode` 只认两档；`separate`（分别独立版 zip）由 S7 交付，本单先显式拒绝而不是静默按合并版跑 */
export const SUMMARY_STREAM_MODES = ['merged', 'separate'] as const;
export type SummaryStreamMode = (typeof SUMMARY_STREAM_MODES)[number];

export interface SummaryStreamParams {
  period: unknown;
  projectIds?: string[];
  custom?: CustomRange;
  /** 已确认/可编辑后的大纲（S3 产物原样回传） */
  outline: unknown;
  mode?: unknown;
  /** FR-5.8 工作量口径；缺省 none（裁决 A-5 默认），allocated 由取数层抛错 */
  workloadCaliber?: unknown;
}

export interface SummaryProjectPages {
  id: string;
  name: string;
  /** 该项目在大纲里独占的页数（合并版每项目固定 4 页；单项目 = 全稿页数） */
  pages: number;
}

export interface SummaryPreparedStream {
  mode: SummaryStreamMode;
  deck: SummaryDeckData;
  outline: SummaryOutlineItem[];
  /** 大纲校验的 warnings（进入 done 事件的 warnings[]，与装配期 warnings 合并） */
  warnings: string[];
  projects: SummaryProjectPages[];
}

export interface SummaryStreamResult {
  token: string;
  fileName: string;
  pageCount: number;
  warnings: string[];
  projects: SummaryProjectPages[];
  /** 被降级为安全版式的页码（S6 面板可提示「第 N 页已降级」） */
  degradedPages: number[];
}

function assertMode(raw: unknown): SummaryStreamMode {
  const mode = typeof raw === 'string' && raw.trim() ? raw.trim() : 'merged';
  if (!(SUMMARY_STREAM_MODES as readonly string[]).includes(mode)) {
    throw new Error(`mode 仅支持 ${SUMMARY_STREAM_MODES.join('/')}，当前为「${mode}」`);
  }
  if (mode === 'separate') {
    // PRD §4：A-2 已批准白名单扩展，但「分别独立版」的 zip 打包属 S7 范围；此单只交付合并版，
    // 传 separate 时显式 400，避免用户以为拿到的是每项目独立稿
    throw new Error('分别独立版（separate）尚未开放：当前请使用合并版（merged），逐项目独立稿与 zip 交付在后续版本提供');
  }
  return mode as SummaryStreamMode;
}

function assertCaliber(raw: unknown): WorkloadCaliber | undefined {
  if (raw == null || raw === '') return undefined;
  const v = String(raw);
  if (!(WORKLOAD_CALIBERS as readonly string[]).includes(v)) {
    throw new Error(`工作量口径仅支持 ${WORKLOAD_CALIBERS.join('/')}，当前为「${v}」`);
  }
  return v as WorkloadCaliber;
}

/** 逐项目页数：单项目全稿都算它的；合并版只数带该项目 projectId 的小结页 */
function projectPages(deck: SummaryDeckData, outline: SummaryOutlineItem[]): SummaryProjectPages[] {
  if (deck.projects.length <= 1) {
    return deck.projects.map((p) => ({ id: p.id, name: p.name, pages: outline.length }));
  }
  return deck.projects.map((p) => ({
    id: p.id,
    name: p.name,
    pages: outline.filter((o) => o.projectId === p.id).length,
  }));
}

/**
 * 备料：守卫 + 一次采集 + 硬阻塞 + 大纲校验。任何一步失败都抛错（路由转 400），不产生副作用。
 * `bundle` 随后原样注入装配取数，确保 S1~S9 校验数和页面数字同源。
 */
export function prepareSummaryPptStream(params: SummaryStreamParams): SummaryPreparedStream {
  const mode = assertMode(params.mode);
  const period = assertSummaryPeriod(params.period);
  const { ids, error } = validateProjectIds(params.projectIds);
  if (error) throw new Error(error);
  if (period === 'custom') {
    const rangeError = assertCustomRange(params.custom);
    if (rangeError) throw new Error(rangeError);
  }
  const caliber = assertCaliber(params.workloadCaliber);

  const bundle: SummaryBundle = gatherSummaryBundle(period, ids, params.custom);
  // S1/S2 硬阻塞：绕过大纲面板直接打生成端点也拦得住（文案与 S3 同一句）
  assertSummaryNotBlocked(buildSummaryPreflight(bundle));

  const deck = gatherSummaryDeckData(period, bundle.projectIds, params.custom, { workloadCaliber: caliber, bundle });
  const { outline, warnings } = validateSummaryOutline(params.outline, { projectIds: bundle.projectIds });
  // S9 降级：页面页脚本层会带 footnote（FR-3.2），但合并版不保证有 highlights 页，
  // 所以 warnings 里也留一条——面板与产物至少有一处一定留痕
  if (bundle.coverage.degraded && bundle.coverage.footnote && !warnings.includes(bundle.coverage.footnote)) {
    warnings.push(bundle.coverage.footnote);
  }

  return { mode, deck, outline, warnings, projects: projectPages(deck, outline) };
}

/** 下载名（FR-7 / A-2）：项目名过多时会被 `downloadSafeName` 截到 80 字，仍必然过白名单 */
export function summaryPptFileName(deck: SummaryDeckData): string {
  const names = deck.projects.map((p) => p.name).join('、') || '全部项目';
  const base = `阶段性总结-${names}-${deck.dataAsOf.replaceAll('-', '')}`;
  return `${downloadSafeName(base, '阶段性总结')}.pptx`;
}

/**
 * 装配并落盘（第 2 段）。`onStage` 的每条消息逐字进 SSE `stage`；中止语义见文件头。
 * 返回 `token` 后即由路由发送 `done`；「已落盘但 done 未送达」的断开由路由回收（T02144 同族）。
 */
export async function renderSummaryPptStream(
  prepared: SummaryPreparedStream,
  onStage: (msg: string) => void,
  signal?: AbortSignal,
): Promise<SummaryStreamResult> {
  // 动态加载：builder 静态依赖 data 层，本模块又被 route 静态引用，静态 import 会加深依赖环
  const { buildSummaryPpt, SUMMARY_ABORT_MSG } = await import('./summaryPptBuilder');
  if (signal?.aborted) throw new Error(SUMMARY_ABORT_MSG);
  const total = prepared.outline.length;
  onStage(`开始逐页装配 ${total} 页…`);
  const built = await buildSummaryPpt(prepared.deck, prepared.outline, {
    onPage: (pageNo, item) => onStage(`页 ${pageNo}/${total} 已装配：${item.section}`),
    signal,
  });
  const token = saveReportBuffer(built.buffer);
  // 中止恰好落在「已落盘、尚未回报」窗口：done 不会再有人接收，当场回收不留孤儿
  if (signal?.aborted) {
    discardReport(token);
    throw new Error(SUMMARY_ABORT_MSG);
  }
  onStage('文件已生成，可在左侧下载。');
  return {
    token,
    fileName: summaryPptFileName(prepared.deck),
    pageCount: built.pageCount,
    warnings: [...prepared.warnings, ...built.warnings],
    projects: prepared.projects,
    degradedPages: built.degradedPages,
  };
}
