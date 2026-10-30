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
import { recordArtifact } from './aiArtifactService';
import { buildCardProvenance, recordCardProvenance, type CardProvenance } from './aiCardProvenance';
import { downloadSafeName } from '../util/export-name';
import { deckStylePreset, type DeckStyleKey } from '../util/exportStyle';
import { assertCustomRange, assertSummaryPeriod, type CustomRange } from './summaryPptPeriod';
import {
  assertSummaryNotBlocked,
  buildSummaryPreflight,
  gatherSummaryBundle,
  type SummaryBundle,
} from './summaryPptService';
import { gatherSummaryDeckData, WORKLOAD_CALIBERS, type SummaryDeckData, type SummaryProjectData, type WorkloadCaliber } from './summaryPptData';
import { scalarText } from '../util/scalarText';
import {
  normalizeSummaryMode,
  validateSummaryOutline,
  type SummaryMode,
  type SummaryOutlineItem,
} from './summaryPptOutline';

/** PRD §4：`mode` 只认两档；separate（FR-6.2）在 S7 起交付 */
export { SUMMARY_MODES as SUMMARY_STREAM_MODES } from './summaryPptOutline';
export type SummaryStreamMode = SummaryMode;

export interface SummaryStreamParams {
  period: unknown;
  projectIds?: string[];
  custom?: CustomRange;
  /** 已确认/可编辑后的大纲（S3 产物原样回传） */
  outline: unknown;
  mode?: unknown;
  /** FR-5.8 工作量口径；缺省 none（裁决 A-5 默认），allocated 由取数层抛错 */
  workloadCaliber?: unknown;
  /** T02960：版式预设（standard/ink/evergreen）；缺省 standard，非法值 400 点名可选值 */
  style?: unknown;
}

export interface SummaryProjectPages {
  id: string;
  name: string;
  /** 该项目在大纲里独占的页数（合并版每项目固定 4 页；单项目 = 全稿页数） */
  pages: number;
}

export interface SummaryPreparedStream {
  mode: SummaryStreamMode;
  /** T02960：本次装配的版式预设（已解析，缺省 standard） */
  style: DeckStyleKey;
  deck: SummaryDeckData;
  outline: SummaryOutlineItem[];
  /** 大纲校验的 warnings（进入 done 事件的 warnings[]，与装配期 warnings 合并） */
  warnings: string[];
  projects: SummaryProjectPages[];
}

export interface SummaryStreamResult {
  token: string;
  /** separate：与 token 同值（PRD §4 的 zipToken 字段），下载端点不变 */
  zipToken?: string;
  fileName: string;
  pageCount: number;
  warnings: string[];
  projects: SummaryProjectPages[];
  /** 被降级为安全版式的页码（S6 面板可提示「第 N 页已降级」；separate 的降级按项目写进 warnings） */
  degradedPages: number[];
  mode: SummaryStreamMode;
  /** T03262（AI-101①）：溯源行（面板与产物登记同源） */
  provenance: CardProvenance;
}

/** T03262（AI-101①）：总结 PPT 的溯源行——备料口径（项目/页数/数据截止）+ 降级与告警 */
function summaryProvenance(
  prepared: SummaryPreparedStream,
  pageCount: number,
  warnings: readonly string[],
  degradedPages: readonly number[],
): CardProvenance {
  return buildCardProvenance({
    cardKey: 'ai.summary_ppt',
    sources: [
      { label: '项目', value: `${prepared.deck.projects.length} 个（${prepared.mode === 'separate' ? '分别独立版' : '合并版'}）` },
      { label: '页数', value: `${pageCount} 页` },
      { label: '数据截止', value: prepared.deck.dataAsOf },
      { label: '版式', value: prepared.style },
    ],
    truncations: [
      ...(degradedPages.length > 0 ? [`${degradedPages.length} 页降级为安全版式`] : []),
      ...warnings,
    ],
    // 装配段只读已确认大纲、不调模型——写「未记录」会被读成「溯源缺失」，照实说明调用发生在第 1 段
    model: '装配阶段未调用模型（大纲在第 1 段生成并已确认）',
  });
}

/** 缺省 merged；非法值 400 点名（separate 的 zip 签名在 S7 已放开，A-2 已批准白名单扩展） */
function assertMode(raw: unknown): SummaryStreamMode {
  return normalizeSummaryMode(raw);
}

function assertCaliber(raw: unknown): WorkloadCaliber | undefined {
  if (raw == null || raw === '') return undefined;
  const v = scalarText(raw);
  if (!(WORKLOAD_CALIBERS as readonly string[]).includes(v)) {
    throw new Error(`工作量口径仅支持 ${WORKLOAD_CALIBERS.join('/')}，当前为「${v}」`);
  }
  return v as WorkloadCaliber;
}

/** T02960：版式预设解析。缺省/空串回落 standard；非法值抛错由路由转 400（点名可选值） */
function assertStyle(raw: unknown): DeckStyleKey {
  return deckStylePreset(raw).key;
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
  const style = assertStyle(params.style);

  const bundle: SummaryBundle = gatherSummaryBundle(period, ids, params.custom);
  // S1/S2 硬阻塞：绕过大纲面板直接打生成端点也拦得住（文案与 S3 同一句）
  assertSummaryNotBlocked(buildSummaryPreflight(bundle));

  const deck = gatherSummaryDeckData(period, bundle.projectIds, params.custom, { workloadCaliber: caliber, bundle });
  const { outline, warnings } = validateSummaryOutline(params.outline, { projectIds: bundle.projectIds, mode });
  // S9 降级：页面页脚本层会带 footnote（FR-3.2），但合并版不保证有 highlights 页，
  // 所以 warnings 里也留一条——面板与产物至少有一处一定留痕
  if (bundle.coverage.degraded && bundle.coverage.footnote && !warnings.includes(bundle.coverage.footnote)) {
    warnings.push(bundle.coverage.footnote);
  }

  return { mode, style, deck, outline, warnings, projects: projectPages(deck, outline) };
}

/** 下载名（FR-7 / A-2）：项目名过多时会被 `downloadSafeName` 截到 80 字，仍必然过白名单 */
export function summaryPptFileName(deck: SummaryDeckData): string {
  const names = deck.projects.map((p) => p.name).join('、') || '全部项目';
  const base = `阶段性总结-${names}-${deck.dataAsOf.replaceAll('-', '')}`;
  return `${downloadSafeName(base, '阶段性总结')}.pptx`;
}

/** separate：单份稿的 zip 内条目名（仍走同一洗名函数，不新开校验口子） */
function separateDeckName(projectName: string, dataAsOf: string, taken: Set<string>): string {
  const base = downloadSafeName(`阶段性总结-${projectName || '项目'}-${dataAsOf.replaceAll('-', '')}`, '阶段性总结');
  let name = `${base}.pptx`;
  let dup = 2;
  while (taken.has(name)) { name = `${base}-${dup}.pptx`; dup += 1; }
  taken.add(name);
  return name;
}

/** separate：外层 zip 名（扩展名 zip 已过 A-2 白名单） */
export function summaryPptZipFileName(deck: SummaryDeckData, count: number): string {
  const base = `阶段性总结-分别独立版-${count}个项目-${deck.dataAsOf.replaceAll('-', '')}`;
  return `${downloadSafeName(base, '阶段性总结-分别独立版')}.zip`;
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
  if (prepared.mode === 'separate') return renderSeparate(prepared, buildSummaryPpt, SUMMARY_ABORT_MSG, onStage, signal);
  const total = prepared.outline.length;
  onStage(`开始逐页装配 ${total} 页…`);
  const built = await buildSummaryPpt(prepared.deck, prepared.outline, {
    onPage: (pageNo, item) => onStage(`页 ${pageNo}/${total} 已装配：${item.section}`),
    signal,
    style: prepared.style,
  });
  const token = saveReportBuffer(built.buffer);
  // 中止恰好落在「已落盘、尚未回报」窗口：done 不会再有人接收，当场回收不留孤儿
  if (signal?.aborted) {
    discardReport(token);
    throw new Error(SUMMARY_ABORT_MSG);
  }
  onStage('文件已生成，可在左侧下载。');
  const fileName = summaryPptFileName(prepared.deck);
  const warnings = [...prepared.warnings, ...built.warnings];
  const provenance = summaryProvenance(prepared, built.pageCount, warnings, built.degradedPages);
  // T03262（AI-101④）：持久副本——令牌下载即删，刷新后靠它找回这一份
  try { recordArtifact({ cardKey: 'ai.summary_ppt', filename: fileName, buffer: built.buffer, provenance }); } catch { /* 登记失败不影响下载 */ }
  recordCardProvenance(provenance, prepared.deck.projects.length === 1 ? prepared.deck.projects[0].id : null);
  return {
    token,
    fileName,
    pageCount: built.pageCount,
    warnings,
    projects: prepared.projects,
    degradedPages: built.degradedPages,
    mode: 'merged',
    provenance,
  };
}

/**
 * separate（FR-6.2）：每项目一份完整稿，用 pizzip 打包为单 zip。
 * - 大纲已按项目分组（`projectId`），这里只做「按项目切分 + 单项目 deck 重渲染」；
 * - 降级页码在 zip 里没有全局含义，故 degradedPages 置空、逐项目前缀写进 warnings；
 * - 令牌仍是单落盘点：zip 未落盘前中止 / 落盘后未回报都当场回收，不留孤儿。
 */
async function renderSeparate(
  prepared: SummaryPreparedStream,
  build: typeof import('./summaryPptBuilder').buildSummaryPpt,
  abortMsg: string,
  onStage: (msg: string) => void,
  signal?: AbortSignal,
): Promise<SummaryStreamResult> {
  const total = prepared.outline.length;
  const multi = prepared.deck.projects.length > 1;
  const groups: Array<{ project: SummaryProjectData; items: SummaryOutlineItem[] }> = prepared.deck.projects.map((project) => ({
    project,
    items: multi ? prepared.outline.filter((o) => o.projectId === project.id) : prepared.outline,
  }));
  onStage(`分别独立版：逐项目装配 ${groups.length} 份完整稿（共 ${total} 页）…`);

  const warnings = [...prepared.warnings];
  const taken = new Set<string>();
  const entries: Array<{ name: string; buffer: Buffer }> = [];
  let done = 0;
  for (const g of groups) {
    if (signal?.aborted) throw new Error(abortMsg);
    // 单项目 deck：让大纲里未标 projectId 的页也能解析到本项目（projectOf 单项目短路）
    const deck: SummaryDeckData = { ...prepared.deck, projects: [g.project] };
    const built = await build(deck, g.items, {
      onPage: () => {
        done += 1;
        onStage(`页 ${done}/${total} 已装配：${g.project.name}`);
      },
      signal,
      style: prepared.style,
    });
    if (signal?.aborted) throw new Error(abortMsg);
    entries.push({ name: separateDeckName(g.project.name, prepared.deck.dataAsOf, taken), buffer: built.buffer });
    warnings.push(...built.warnings.map((w) => `[${g.project.name}] ${w}`));
  }

  const PizZip = (await import('pizzip')).default;
  const zip = new PizZip();
  for (const e of entries) zip.file(e.name, e.buffer);
  const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as unknown as Buffer;
  const token = saveReportBuffer(buffer);
  if (signal?.aborted) {
    discardReport(token);
    throw new Error(abortMsg);
  }
  onStage(`文件已生成，可在左侧下载（zip 内含 ${entries.length} 份 .pptx）。`);
  const fileName = summaryPptZipFileName(prepared.deck, entries.length);
  const provenance = summaryProvenance(prepared, total, warnings, []);
  try { recordArtifact({ cardKey: 'ai.summary_ppt', filename: fileName, buffer, provenance }); } catch { /* 登记失败不影响下载 */ }
  recordCardProvenance(provenance, prepared.deck.projects.length === 1 ? prepared.deck.projects[0].id : null);
  return {
    token,
    zipToken: token,
    fileName,
    pageCount: total,
    warnings,
    projects: prepared.projects,
    degradedPages: [],
    mode: 'separate',
    provenance,
  };
}
