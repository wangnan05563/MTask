import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db/connection';
import { getAdapter, type AIAdapter, type ToolConfig } from '../adapters';
import type { StreamResult } from '../adapters/types';
import { recordUsage } from '../util/aiUsageRecord'; // T03296（G-2）：直连适配器的卡由本服务补记 card_key 用量

/** T03296（G-2 覆盖率）：测试用例生成卡的稳定 key（注册表 server/src/util/aiCards.ts） */
const TESTCASE_CARD = 'ai.test_case_gen';
/** 需求拆分段的段键：台账 segmentKey 与 ai_usage.stage 共用同一标识（T04003，避免两处各写各的） */
const SPLIT_SEG = 'split';
import { ConfigService } from './ConfigService';
import { PlanService } from './PlanService';
import { logService } from './LogService';
import { beginSegment, declareSegments, doneSegmentsFor, finalizeJob, finishSegment, openJob, type GenSegmentView } from './AiGenJournal';
import { buildCardProvenance, chars, recordCardProvenance, type CardProvenance } from './aiCardProvenance';
import { ContextBudget, WorkspaceService } from './WorkspaceService';
import { loadWorkspaceContext } from './PrdGenService';
import {
  CASE_MARKER,
  NOTE_MARKER,
  REQ_MARKER,
  REQ_PRIORITY_DEFAULT,
  extractArray,
  isCaseObj,
  isRequirementObj,
  normCase,
  normRequirement,
  parseNotes,
} from './testCaseGenParse';
import type { DraftCase, DraftCoverage, DraftRequirement } from './testCaseGenParse';
import { scalarText } from '../util/scalarText';

// 幂等去重键与草稿类型单源于 testCaseGenParse；此处原样转出，供 SSE 路由（T01491）与草稿导入（T01492）就近引用
export { caseSourceKey, caseContentHash } from './testCaseGenParse';
export type { DraftCase, DraftRequirement, DraftStep, DraftCoverage } from './testCaseGenParse';

/**
 * T01490（PRD-测试用例管理 §8.3/§8.4）：AI 生成测试用例的 pipeline 后端。
 *
 * 形态完全对齐 `PrdGenService.generatePrdStream`（同为「内置技能 + 工作空间上下文 → 流式生成 → 协议解析」），
 * 三点关键差异都是本场景特有：
 *  1. **分块生成**：用例集规模远大于单份 PRD，一次性生成必然触输出上限（§8.4 的头号教训）。
 *     故按需求分块（≤5 条/块）逐块调用，失败自动缩块重试 ≤2 次——「分块」比「抬预算」更是防截断的根本手段。
 *  2. **双数组协议**：输出含 `<<<REQUIREMENTS>>>` 与 `<<<CASES>>>`（+ 可选 `<<<NOTES>>>`）多段，
 *     而 `scanJsonArrays` 只会按配平扫描返回**全部**顶层数组、无法区分哪段是哪段——必须先按标记切段、再段内扫描
 *     （这正是 `testcase-generate/SKILL.md` 协议硬约束第 4 条「标记必须真实独占一行」的对偶实现）。
 *  3. **只产草稿、不落库**：本函数返回 `TcGenDraft`，落库与幂等导入在 `POST /plans/test-cases/import-draft`（T01492）。
 *     但幂等去重键 `source_key` 的**生成口径在此单源**并导出，供 T01492 写库时逐字复现——两处不一致去重即失效。
 */

/** 内置技能资产目录：优先 dist/skills（build 脚本从 src/skills 复制），回退 src/skills（未跑复制脚本时）——与 PrdGenService.skillDir 同语义 */
function skillDir(): string {
  const candidates = [join(__dirname, '..', 'skills', 'testcase-generate'), join(__dirname, '..', '..', 'src', 'skills', 'testcase-generate')];
  for (const dir of candidates) {
    try { statSync(join(dir, 'SKILL.md')); return dir; } catch { /* 尝试下一候选 */ }
  }
  return candidates[0];
}

/**
 * 三份 references 的文件名是 **loader 契约**（与 prd-generate 一样按名字数组硬编码读，改名即运行时炸）；
 * 名单必须与 `server/scripts/skill-contract-check.mjs` 校验的名单一致。
 */
const REFERENCES = ['test-design-rules', 'coverage-rules', 'case-style-rules'] as const;

/** §8.4：输出预算下限（全库默认 4096，长用例集必触顶——取「用户配置与下限的较大值」）；超时同理放宽到 5 分钟 */
const TESTCASE_MIN_OUTPUT_TOKENS = 8192;
const TESTCASE_FALLBACK_OUTPUT_TOKENS = 4096; // 提供商拒绝 8K 上限时的回退（用户原值或全局默认）
const TESTCASE_MIN_TIMEOUT_MS = 300_000;
/** §8.3 步骤 2/3：每块需求数上限（防截断）与缩块重试次数（每失败一次对半拆，≤2 层） */
const CHUNK_SIZE = 5;
const MAX_SHRINK_RETRY = 2;

/** 文本列取值（与 testCaseGenParse 同语义）：null/undefined → 空串，去首尾空白 */
function str(v: unknown): string {
  return v == null ? '' : scalarText(v).trim();
}

export interface TcGenDraft {
  requirements: DraftRequirement[];
  cases: DraftCase[];
  coverage: DraftCoverage;
  notes: string[];
  /** 分块重试耗尽仍有块被截断 → true，草稿页据此标注「本轮可能被截断，建议调大 max_tokens 后重跑」 */
  truncated: boolean;
  /** T03262（AI-101①）：溯源行——来源/截断/模型与面板、导出稿逐字同源 */
  provenance: CardProvenance;
}

export interface GenPrefs {
  perReq?: number;
  granularity?: 'steps' | 'points';
  includeNegative?: boolean;
  priorityStrategy?: string;
}

/** 取运行时配置并校验模型已配置（与 PrdGenService.runtimeWithModel 同语义，独立实现避免循环依赖） */
function runtimeWithModel(toolId: string) {
  const { type, config } = ConfigService.getRuntimeConfig(toolId);
  if (!config.model) throw new Error('所选模型未配置，请先在「模型管理」为该工具填写默认模型');
  return { type, config };
}

/** 检索增强（镜像 PrdGenService.buildRetrieveBlock）：按关键词搜索代码注入 top 片段，失败不阻塞主流程（返回空串）。
 * T02200（本单同族让路）：异步分片，符号索引刷新/memo 预扫描不再饿死只读接口。 */
async function buildRetrieveBlock(project: { workspace_path: string | null }, input: { projectId: string; content: string; onStage: (m: string) => void }): Promise<string> {
  if (!project.workspace_path) return '';
  try {
    const stat = await WorkspaceService.refreshSymbols(input.projectId);
    input.onStage(`符号索引刷新：文件 ${stat.files} 个、符号 ${stat.symbols} 个（未变跳过 ${stat.skipped}）${stat.deferred ? '，超预算余量已交后台续跑（T02200 让路，下次刷新补齐）' : ''}`);
    const kws = WorkspaceService.extractKeywords(input.content);
    const block = await WorkspaceService.autoContext(input.projectId, kws);
    input.onStage(block ? `检索增强：按关键词 [${kws.slice(0, 6).join(', ')}] 命中代码片段已注入上下文` : '检索增强：无命中片段，跳过注入');
    return block;
  } catch {
    return '';
  }
}

/** 流式调用函数形态：生产走适配器，门测试可注入替身（T03263） */
type ChatFn = (
  system: string,
  user: string,
  config: ToolConfig,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) => Promise<StreamResult>;

/** 单次流式调用入参：S107——8 参收成对象 */
interface CallOnceArgs {
  chat: ChatFn;
  system: string;
  user: string;
  genConfig: ToolConfig;
  onDelta: (text: string) => void;
  onStage: (msg: string) => void;
  toolId: string;
  signal?: AbortSignal;
  /** T04003：本笔调用属于哪个 job（台账标识）与哪一段（台账 segmentKey），用量才可按段还原 */
  jobId: string;
  stage: string;
}

/** 单次流式调用：抬预算 → max_tokens 被拒则回退重试 → 触顶返回 partial（truncated=true）。 */
async function callOnce(args: CallOnceArgs): Promise<{ text: string; truncated: boolean }> {
  const { chat, system, user, genConfig, onDelta, onStage, toolId, signal, jobId, stage } = args;
  // T03296（G-2 覆盖率）：本服务直连适配器，每次真实调用显式记一笔 card_key 用量。
  // T04003：同一笔调用自带段归属（job_id + stage）；失败/断流时按「本次已流出的增量字符」记账，
  // 不再落成 0——否则一次长跑断流后，用量表只剩 duration_ms 而产出量凭空消失。
  const attempt = async (cfg: ToolConfig) => {
    const startedAt = Date.now();
    let streamedChars = 0;
    const r = await chat(system, user, cfg, (text) => { streamedChars += text.length; onDelta(text); }, signal);
    const chars = (r.ok ? r.content?.length : r.partial?.length) ?? streamedChars;
    recordUsage({ kind: 'stream', toolId, model: cfg.model, ok: r.ok, startedAt, contentChars: chars, error: r.error, cardKey: TESTCASE_CARD, jobId, stage, usage: r.usage });
    return r;
  };
  let res = await attempt(genConfig);
  // 提供商拒绝抬高的输出上限（直接 400）→ 回退到用户原值重试一次（与 PrdGenService 的 16K→8K 回退同款思路）
  if (!res.ok && !res.partial && /max_tokens|max_completion_tokens|too large|invalid/i.test(res.error ?? '')) {
    onStage(`模型未接受 ${genConfig.maxTokens} tokens 输出上限，回退重试…`);
    res = await attempt({ ...genConfig, maxTokens: TESTCASE_FALLBACK_OUTPUT_TOKENS });
  }
  if (res.ok) return { text: res.content ?? '', truncated: false };
  // finish_reason=length：adapter 给出 partial + 「超长被截断」；选择性采纳已成功部分并显式告警（其余失败原样抛出）
  if (res.partial && /超长被截断/.test(res.error ?? '')) return { text: res.partial, truncated: true };
  throw new Error(res.error ?? 'AI 生成失败');
}

/** 加载内置技能（SKILL.md + 三份 references）为 system 提示 */
function loadSkillSystem(dir: string): string {
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const rules = REFERENCES
    .map((n) => {
      const file = `${n}.md`;
      return `\n<!-- references/${file} -->\n${readFileSync(join(dir, 'references', file), 'utf8')}`;
    })
    .join('\n');
  return `${skill}\n\n# 测试设计规范库（生成时逐条对照）\n${rules}`;
}

/** 拆分与分块生成共用的上下文块（项目 / 源码 / 检索 / PRD 原文） */
function buildContextBlock(projectName: string, ws: string, retrieveBlock: string, content: string, srcLabel: string): string {
  return [
    `【目标项目】${projectName}`,
    ws ? `【项目源码上下文】\n${ws}` : '【项目源码上下文】未提供（未配置工作空间）',
    retrieveBlock ? `【工作空间检索片段】\n${retrieveBlock}` : '',
    `【PRD 原文（来源：${srcLabel}）】\n${ContextBudget.headTail(content, ContextBudget.prdContextChars, 'PRD ')}`,
  ].filter(Boolean).join('\n\n');
}

/** 项目已有需求 → 草稿需求（reqNo 为空的行丢弃） */
function mapExistingRequirements(rows: ReturnType<typeof PlanService.listRequirements>): DraftRequirement[] {
  return rows.map((r) => ({
    reqNo: str(r.req_no),
    title: str(r.title),
    content: str(r.content),
    sourceRef: str(r.source_ref),
    priority: str(r.priority) || REQ_PRIORITY_DEFAULT,
    isNew: false,
  })).filter((r) => r.reqNo);
}

/** 生成偏好行（prefs 缺省时用技能默认值） */
function buildPrefLine(prefs: GenPrefs): string {
  return [
    prefs.perReq ? `每需求用例数≈${prefs.perReq}` : '',
    prefs.granularity === 'points' ? '粒度=仅要点（steps 可为空，但用例级 expected 必须完整可判定）' : '粒度=包含步骤（steps ≥2，一步一动作，每步给预期）',
    prefs.includeNegative === false ? '' : '必须包含负向用例（异常/边界）',
    prefs.priorityStrategy ? `优先级策略=${prefs.priorityStrategy}` : '优先级=风险驱动',
  ].filter(Boolean).join('；') || '按技能默认值';
}

/** 块内需求清单（供 prompt 的「本次分块范围」段） */
function chunkScopeList(reqNos: string[], reqByNo: Map<string, DraftRequirement>): string {
  return reqNos
    .map((no) => reqByNo.get(no))
    .filter((r): r is DraftRequirement => !!r)
    .map((r) => {
      const contentPart = r.content ? `（${ContextBudget.headTail(r.content, 200, '内容 ')}）` : '';
      return `- ${r.reqNo}：${r.title}${contentPart}`;
    })
    .join('\n');
}

/** 分块 prompt：范围 + 偏好 + 输出协议约束 */
function buildCaseUserPrompt(contextBlock: string, scopeList: string, reqCount: number, prefLine: string): string {
  return [
    contextBlock,
    `【本次分块范围——仅为以下 ${reqCount} 条需求生成用例】\n${scopeList}`,
    `【生成偏好】${prefLine}`,
    '【本轮任务】按输出协议填充 <<<CASES>>> 段；已复用/已存在的需求 <<<REQUIREMENTS>>> 输出 []。',
    '每条用例必须：可判定（另一位工程师无需回来问即可执行并给出通过/失败）、可追溯到上述某条 reqNo、不输出 caseNo/id/status/lastResult 等服务端字段。',
    '严格独占一行输出标记：<<<REQUIREMENTS>>> 与 <<<CASES>>>（可选 <<<NOTES>>>）。',
  ].join('\n\n');
}

/** 拆分段的依赖（含缓存段与既有需求复用判据）；stage 属「每次调用」而非「阶段共享」，故在此剥掉 */
interface SplitDeps extends Omit<CallOnceArgs, 'user' | 'stage'> {
  contextBlock: string;
  existingReqs: ReturnType<typeof PlanService.listRequirements>;
  existingReqNos: Set<string>;
  notes: string[];
  splitCached?: GenSegmentView;
  resplitRequirements?: boolean;
  jobId: string;
  sectionKey: string;
}

/** 去重：同一 reqNo 只保留首条（normRequirement 已过滤非法行） */
function dedupeRequirements(objs: Array<Record<string, unknown>>, existingReqNos: Set<string>): DraftRequirement[] {
  const seen = new Set<string>();
  const out: DraftRequirement[] = [];
  for (const o of objs) {
    const r = normRequirement(o, existingReqNos);
    if (!r || seen.has(r.reqNo)) continue;
    seen.add(r.reqNo);
    out.push(r);
  }
  return out;
}

/** 重新拆分未产出需求：有既有需求则回退复用，否则报错（不给空清单假成功） */
function fallbackExistingRequirements(deps: SplitDeps): DraftRequirement[] {
  if (deps.existingReqs.length === 0) {
    throw new Error('未能从 PRD 拆分出任何需求条目——请检查 PRD 是否包含可验证需求，或更换模型后重试');
  }
  deps.notes.push('重新拆分未产出需求，已回退为复用已有需求');
  return mapExistingRequirements(deps.existingReqs);
}

/** 步骤 1/3 的模型拆分分支 */
async function splitByModel(deps: SplitDeps): Promise<DraftRequirement[]> {
  const resplitHint = deps.existingReqs.length > 0
    ? `（已勾选重新拆分，将复用已有 ${deps.existingReqs.length} 条 reqNo 并补充缺口）`
    : '（项目暂无需求，按 PRD 拆分）';
  deps.onStage(`步骤 1/3｜拆分需求跟踪矩阵…${resplitHint}`);
  const existingReqBlock = deps.existingReqs.map((r) => `- ${str(r.req_no)}：${str(r.title)}`).join('\n');
  const existingLine = deps.existingReqs.length > 0
    ? `【已有需求（复用其 reqNo，勿重复拆分）】\n${existingReqBlock}`
    : '【已有需求】无（请从 REQ-001 顺序拆分）';
  const splitUser = [
    deps.contextBlock,
    existingLine,
    '【本轮任务】仅拆分/补充需求，用例段输出空数组。',
    '按输出协议，只填充 <<<REQUIREMENTS>>> 段（<<<CASES>>> 输出 []）；每条需求原子、可独立验证、带 sourceRef 指向原文定位。',
  ].join('\n\n');
  const splitRes = await callOnce({ ...deps, user: splitUser, stage: SPLIT_SEG });
  const splitReqs = dedupeRequirements(extractArray(splitRes.text, REQ_MARKER, CASE_MARKER, isRequirementObj), deps.existingReqNos);
  deps.notes.push(...parseNotes(splitRes.text));
  if (splitReqs.length === 0) return fallbackExistingRequirements(deps);
  const news = splitReqs.filter((r) => r.isNew).length;
  deps.onStage(`步骤 1/3 完成：需求 ${splitReqs.length} 条（复用 ${splitReqs.length - news}，新增 ${news}）`);
  return splitReqs;
}

/** 步骤 1/3：缓存段复用 / 既有需求复用 / 模型拆分 三分支，并在本任务台账落 done */
async function resolveRequirementsStep(deps: SplitDeps): Promise<DraftRequirement[]> {
  if (deps.splitCached) {
    const cached = JSON.parse(deps.splitCached.text) as { requirements: DraftRequirement[]; notes?: string[] };
    deps.notes.push(...(cached.notes ?? []), '本轮复用上一次已完成的需求拆分（未重复调用模型）');
    // 复用也要在本任务里落 done——否则新任务台账显示「未完成」，刷新恢复会误判进度
    beginSegment(deps.jobId, deps.sectionKey, 'split');
    finishSegment(deps.jobId, { sectionKey: deps.sectionKey, segmentKey: 'split', ok: true, text: deps.splitCached.text });
    deps.onStage(`步骤 1/3 复用：上一次已完成的需求拆分（${cached.requirements.length} 条），本次未调用模型`);
    return cached.requirements;
  }
  if (deps.existingReqs.length > 0 && !deps.resplitRequirements) {
    const requirements = mapExistingRequirements(deps.existingReqs);
    deps.onStage(`步骤 1/3｜拆分需求跟踪矩阵…（检测到项目已有 ${requirements.length} 条需求，默认复用；如需重新拆分请勾选「重新拆分」）`);
    // 复用不是「照着这份 PRD 拆」而是「直接拿矩阵里现成的行」：所选 PRD 只是用例上下文，不进需求清单。
    // 不说破的话，换一份 PRD 重跑会得到上一份 PRD 的需求与用例，看起来像「没生成 / 延续了上次的上下文」。
    deps.onStage(`步骤 1/3 完成：复用已有需求 ${requirements.length} 条（未按本次 PRD 拆分需求；要按本 PRD 拆分并补充缺口，请勾选「重新拆分需求」后重跑）`);
    deps.notes.push(`本轮复用项目已有需求 ${requirements.length} 条，未按所选 PRD 拆分需求——如需按本 PRD 拆分，请勾选「重新拆分需求」后重跑`);
    return requirements;
  }
  return splitByModel(deps);
}

/** 分块阶段的共享上下文（genChunk / runChunk 递归复用；同时满足 callOnce 的入参形状，stage 由每次调用现给） */
interface TcGenCtx extends Omit<CallOnceArgs, 'user' | 'stage'> {
  contextBlock: string;
  prefLine: string;
  reqByNo: Map<string, DraftRequirement>;
  existingKeys: Set<string>;
  notes: string[];
  allCases: DraftCase[];
  jobId: string;
  sectionKey: string;
  segOf: (key: string) => GenSegmentView | undefined;
  chunkKey: (nos: string[]) => string;
  reqNos: string[];
}

/** 块级状态：触顶标记、失败需求与最近一次错误 */
interface TcGenState {
  truncated: boolean;
  failedReqNos: Set<string>;
  lastChunkErr: string;
}

/** 缩块条件：块内仍有 ≥2 需求、还有重试层数，且触顶或无产出（多半是被截断/协议跑偏） */
function needsShrink(reqCount: number, shrinkLeft: number, truncated: boolean, caseCount: number): boolean {
  return reqCount > 1 && shrinkLeft > 0 && (truncated || caseCount === 0);
}

/** 缩块重试：对半拆开递归生成 */
async function shrinkRetry(ctx: TcGenCtx, state: TcGenState, reqNos: string[], shrinkLeft: number, truncated: boolean): Promise<void> {
  const round = MAX_SHRINK_RETRY - shrinkLeft + 1;
  ctx.onStage(`warn：块（${reqNos.length} 需求）输出${truncated ? '被截断' : '未产出用例'}，已缩小块大小重试（${round}/${MAX_SHRINK_RETRY}）`);
  const mid = Math.ceil(reqNos.length / 2);
  await genChunk(ctx, state, reqNos.slice(0, mid), shrinkLeft - 1);
  await genChunk(ctx, state, reqNos.slice(mid), shrinkLeft - 1);
}

/** 收录本块用例：悬空 reqNo 只记说明，不丢弃用例 */
function appendCases(ctx: TcGenCtx, cases: DraftCase[]): void {
  for (const c of cases) {
    if (!ctx.reqByNo.has(c.reqNo)) {
      ctx.notes.push(`用例「${c.title}」引用了未知需求 ${c.reqNo}（悬空引用，导入时将按无需求处理或跳过）`);
    }
    ctx.allCases.push(c);
  }
}

/** 生成一个块；触顶或解析为空则对半拆块重试（≤MAX_SHRINK_RETRY 层） */
async function genChunk(ctx: TcGenCtx, state: TcGenState, reqNos: string[], shrinkLeft: number): Promise<void> {
  if (ctx.signal?.aborted) throw new Error('生成已中止');
  const scopeList = chunkScopeList(reqNos, ctx.reqByNo);
  const caseUser = buildCaseUserPrompt(ctx.contextBlock, scopeList, reqNos.length, ctx.prefLine);
  // stage 用「本次实际作用范围」的块键：对半拆块重试时 scope 变小，段键随之变化，
  // 用量表就能区分「整块一次过」和「触顶后拆细重跑」这两种真实调用形态（T04003）
  const res = await callOnce({ ...ctx, user: caseUser, stage: ctx.chunkKey(reqNos) });
  const cases = extractArray(res.text, CASE_MARKER, NOTE_MARKER, isCaseObj)
    .map((o) => normCase(o, ctx.existingKeys))
    .filter((c): c is DraftCase => !!c);
  ctx.notes.push(...parseNotes(res.text));
  if (needsShrink(reqNos.length, shrinkLeft, res.truncated, cases.length)) {
    await shrinkRetry(ctx, state, reqNos, shrinkLeft, res.truncated);
    return;
  }
  if (res.truncated) {
    state.truncated = true;
    ctx.onStage(`⚠ 本块输出触及上限，已保留 ${cases.length} 条成功用例——建议在「模型管理」调大 max_tokens 后对未覆盖需求重跑`);
  }
  appendCases(ctx, cases);
  const coveredNow = new Set(ctx.allCases.map((c) => c.reqNo)).size;
  ctx.onStage(`  ▸ 已生成 ${coveredNow}/${ctx.reqNos.length} 条需求的用例（累计 ${ctx.allCases.length} 条）`);
}

/** 复用上一次已完成的分块（同请求同块键），并在本任务台账落 done */
function reuseChunk(ctx: TcGenCtx, key: string, nos: string[], cached: GenSegmentView): void {
  const cachedCases = JSON.parse(cached.text) as DraftCase[];
  ctx.allCases.push(...cachedCases);
  // 复用也要在本任务里落 done——否则新任务台账显示「未完成」，刷新恢复会误判进度
  beginSegment(ctx.jobId, ctx.sectionKey, key);
  finishSegment(ctx.jobId, { sectionKey: ctx.sectionKey, segmentKey: key, ok: true, text: cached.text });
  ctx.onStage(`  ▸ 复用上一次已完成的用例块（${nos.length} 需求 / ${cachedCases.length} 条），未调用模型`);
}

/** 块级容错：单块失败只跳过该块（用户主动停止仍整体上抛） */
function recordChunkFailure(ctx: TcGenCtx, state: TcGenState, nos: string[], key: string, e: unknown): void {
  if (ctx.signal?.aborted) throw e;
  finishSegment(ctx.jobId, { sectionKey: ctx.sectionKey, segmentKey: key, ok: false, text: '', error: e instanceof Error ? e.message : String(e) });
  state.lastChunkErr = e instanceof Error ? e.message : String(e);
  nos.forEach((n) => state.failedReqNos.add(n));
  ctx.onStage(`⚠ 本块（${nos.length} 需求）生成失败：${state.lastChunkErr}——跳过该块，其余块继续`);
}

/** 跑一个块：命中缓存则复用，否则生成并把成功部分写进台账 */
async function runChunk(ctx: TcGenCtx, state: TcGenState, nos: string[]): Promise<void> {
  const key = ctx.chunkKey(nos);
  const cached = ctx.segOf(key);
  if (cached) {
    reuseChunk(ctx, key, nos, cached);
    return;
  }
  beginSegment(ctx.jobId, ctx.sectionKey, key);
  const before = ctx.allCases.length;
  try {
    await genChunk(ctx, state, nos, MAX_SHRINK_RETRY);
    finishSegment(ctx.jobId, { sectionKey: ctx.sectionKey, segmentKey: key, ok: true, text: JSON.stringify(ctx.allCases.slice(before)) });
  } catch (e) {
    recordChunkFailure(ctx, state, nos, key, e);
  }
}

/** 定向补生成：对未覆盖需求按块重跑，返回补生成后的未覆盖清单 */
async function fillUncovered(ctx: TcGenCtx, state: TcGenState, uncovered: string[]): Promise<string[]> {
  ctx.onStage(`  未覆盖 ${uncovered.length} 条需求，定向补生成中…`);
  const before = ctx.allCases.length;
  for (let i = 0; i < uncovered.length; i += CHUNK_SIZE) {
    await runChunk(ctx, state, uncovered.slice(i, i + CHUNK_SIZE));
  }
  const countByReq = countCasesByReq(ctx.allCases);
  const still = ctx.reqNos.filter((no) => !countByReq.has(no));
  ctx.onStage(`  补生成新增 ${ctx.allCases.length - before} 条用例，仍有 ${still.length} 条需求未覆盖`);
  if (still.length > 0) ctx.notes.push(`以下需求经补生成仍未产出用例：${still.join(', ')}（可在草稿视图手动补充或忽略）`);
  return still;
}

/** reqNo → 用例数 */
function countCasesByReq(cases: DraftCase[]): Map<string, number> {
  const countByReq = new Map<string, number>();
  for (const c of cases) countByReq.set(c.reqNo, (countByReq.get(c.reqNo) ?? 0) + 1);
  return countByReq;
}

/** 覆盖率小结 */
function buildCoverage(
  requirements: DraftRequirement[],
  reqTotal: number,
  uncoveredCount: number,
  countByReq: Map<string, number>,
): DraftCoverage {
  const covered = reqTotal - uncoveredCount;
  return {
    total: reqTotal,
    covered,
    uncovered: uncoveredCount,
    rate: reqTotal === 0 ? 0 : Math.round((covered / reqTotal) * 1000) / 10,
    byReq: requirements.map((r) => ({ reqNo: r.reqNo, title: r.title, caseCount: countByReq.get(r.reqNo) ?? 0, isNew: r.isNew })),
  };
}

/** T03262（AI-101①）：溯源行。分块数与实际失败块都进来——「覆盖 100%」不等于「没被截断」，
 * 只写需求/用例条数会让用户看不出这一轮是靠补生成凑齐的。 */
function buildTcProvenance(args: {
  input: { content: string; source?: string };
  reqTotal: number;
  caseCount: number;
  chunkCount: number;
  reusedCount: number;
  truncatedAny: boolean;
  failedCount: number;
  model?: string;
}): CardProvenance {
  const prdSourceSuffix = args.input.source ? `（${args.input.source}）` : '';
  return buildCardProvenance({
    cardKey: 'ai.testcase_gen',
    sources: [
      { label: 'PRD 原文', value: `${chars(args.input.content.length)}${prdSourceSuffix}` },
      { label: '需求', value: `${args.reqTotal} 条` },
      { label: '用例', value: `${args.caseCount} 条（分 ${args.chunkCount} 块生成）` },
      ...(args.reusedCount > 0 ? [{ label: '复用', value: `${args.reusedCount} 段来自上次同一请求（未调用模型）` }] : []),
    ],
    truncations: [
      ...(args.truncatedAny ? ['有分块输出触及 max_tokens 上限，已保留已生成部分'] : []),
      ...(args.failedCount > 0 ? [`${args.failedCount} 条需求的用例块调用失败被跳过`] : []),
    ],
    model: args.model ?? null,
  });
}

/**
 * 生成测试用例主流程（三步 pipeline）。
 * @param input.content 已解析为文本的 PRD 原文（内部文档 content_md / 上传文件，由 T01491 路由负责取文本）
 * @param input.resplitRequirements 勾选「重新拆分」→ 强制 AI 输出 REQUIREMENTS；否则项目已有需求即默认复用
 */
export interface TcGenStreamInput {
  projectId: string;
  toolId: string;
  content: string;
  source?: string;
  resplitRequirements?: boolean;
  prefs?: GenPrefs;
  onStage: (msg: string) => void;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  /** T03263：门测试注入点——生产不传，走真实适配器 */
  chatStream?: ChatFn;
}

/** 生成所需项目行；项目不存在直接抛（路由层翻 4xx） */
function loadGenProject(projectId: string): { name: string; workspace_path: string | null } {
  const row = getDb().prepare('SELECT name, workspace_path FROM projects WHERE id = ?').get(projectId) as
    { name: string; workspace_path: string | null } | undefined;
  if (!row) throw new Error('项目不存在');
  return row;
}

/** 适配器 + 抬过预算的生成配置（chatStream 可被门测试替换） */
function resolveChatRunner(toolId: string, injected?: ChatFn): { chat: ChatFn; genConfig: ToolConfig } {
  const { type, config } = runtimeWithModel(toolId);
  const adapter: AIAdapter = getAdapter(type);
  const chat: ChatFn = injected ?? ((s, u, c, d, sig) => adapter.chatStream(s, u, c, d, sig));
  return {
    chat,
    genConfig: {
      ...config,
      maxTokens: Math.max(config.maxTokens ?? 4096, TESTCASE_MIN_OUTPUT_TOKENS),
      timeoutMs: Math.max(config.timeoutMs ?? 60_000, TESTCASE_MIN_TIMEOUT_MS),
    },
  };
}

/** 请求指纹（项目 + 工具 + PRD + 偏好 + 是否重拆）决定分段复用的边界 */
function sectionKeyOf(input: TcGenStreamInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ p: input.projectId, t: input.toolId, c: input.content, prefs: input.prefs ?? null, resplit: Boolean(input.resplitRequirements) }))
    .digest('hex')
    .slice(0, 16);
}

/** 按 CHUNK_SIZE 切块（保持原顺序） */
function chunkReqNos(reqNos: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < reqNos.length; i += CHUNK_SIZE) chunks.push(reqNos.slice(i, i + CHUNK_SIZE));
  return chunks;
}

/** 零产出兜底：块失败抛原始错误，全部零产出（无失败）则提示协议问题——都不能发空草稿假成功 */
function assertCasesProduced(allCases: DraftCase[], state: TcGenState, reqCount: number): void {
  if (allCases.length > 0) return;
  if (state.failedReqNos.size > 0) {
    throw new Error(`所有需求块生成失败：${state.lastChunkErr}——请在「模型管理」检查该工具的端点/网络后重试`);
  }
  throw new Error(`AI 未返回任何可解析的用例（${reqCount} 条需求全部零产出）——请确认该模型按 <<<CASES>>> 协议输出 JSON，或更换模型后重试`);
}

/** 去重（同一 source_key 在一次生成内可能被多块重复产出） */
function dedupeCases(allCases: DraftCase[]): DraftCase[] {
  const dedup = new Map<string, DraftCase>();
  for (const c of allCases) if (!dedup.has(c.sourceKey)) dedup.set(c.sourceKey, c);
  return [...dedup.values()];
}

/**
 * 生成测试用例主流程（三步 pipeline）。
 * @param input.content 已解析为文本的 PRD 原文（内部文档 content_md / 上传文件，由 T01491 路由负责取文本）
 * @param input.resplitRequirements 勾选「重新拆分」→ 强制 AI 输出 REQUIREMENTS；否则项目已有需求即默认复用
 */
export async function generateTestCasesStream(input: TcGenStreamInput): Promise<TcGenDraft> {
  const project = loadGenProject(input.projectId);
  if (!str(input.content)) throw new Error('PRD 原文为空，无法生成用例');

  const { chat, genConfig } = resolveChatRunner(input.toolId, input.chatStream);
  const startedAt = Date.now();

  // T03263（REQ-020 / AI-103）：分段台账。请求指纹（项目+模型+PRD+偏好+是否重拆）决定 sectionKey，
  // 同指纹的历史完成段跨任务复用——失败重试 / 刷新重来只重跑未完成的段，不再整轮重烧配额。
  const CARD_KEY = 'ai.testcase_gen';
  const sectionKey = sectionKeyOf(input);
  const jobId = openJob({ cardKey: CARD_KEY, toolId: input.toolId, title: '测试用例生成', request: { projectId: input.projectId, sectionKey } });
  const reused = doneSegmentsFor(CARD_KEY, sectionKey);
  const segOf = (key: string) => reused.get(`${sectionKey}\u0000${key}`);
  if (reused.size > 0) {
    input.onStage(`发现同一请求上一次的 ${reused.size} 个已完成段：本轮只补未完成的段，已完成段不重复调用模型`);
  }

  // ---- 加载内置技能（SKILL.md + 三份 references）----
  input.onStage('加载内置技能「testcase-generate」…');
  const system = loadSkillSystem(skillDir());

  const srcLabel = input.source || 'PRD';
  input.onStage(`已载入 PRD：${srcLabel}（${input.content.length.toLocaleString('en-US')} 字）`);

  // ---- 工作空间上下文 + 检索增强（可选，失败静默跳过）----
  const ws = await loadWorkspaceContext(project.workspace_path ?? '');
  input.onStage(ws ? '项目源码上下文已加载（目录树 + 说明文件片段）' : '跳过源码上下文（工作空间未绑定或不可读）');
  const retrieveBlock = await buildRetrieveBlock(project, input);
  const contextBlock = buildContextBlock(project.name, ws, retrieveBlock, input.content, srcLabel);

  // ================= 步骤 1/3：拆分需求跟踪矩阵 =================
  const existingReqs = PlanService.listRequirements(input.projectId);
  const existingReqNos = new Set(existingReqs.map((r) => str(r.req_no)).filter(Boolean));
  const notes: string[] = [];

  // T03263：需求拆分段——同指纹已拆过就直接复用清单，不再调用模型（段键 SPLIT_SEG 已提到模块作用域，供用量记账复用）
  declareSegments(jobId, [{ sectionKey, segmentKey: SPLIT_SEG, label: '需求拆分', orderIndex: 0 }]);
  // 显式勾选「重新拆分」时不复用拆分段——用户要的就是重新拆一遍，缓存会把它变成「没反应」
  const splitCached = input.resplitRequirements ? undefined : segOf(SPLIT_SEG);
  const requirements = await resolveRequirementsStep({
    chat, system, genConfig, contextBlock, toolId: input.toolId, onDelta: input.onDelta, onStage: input.onStage, signal: input.signal,
    existingReqs, existingReqNos, notes, splitCached, resplitRequirements: input.resplitRequirements, jobId, sectionKey,
  });

  if (!splitCached) {
    finishSegment(jobId, { sectionKey, segmentKey: SPLIT_SEG, ok: true, text: JSON.stringify({ requirements, notes }) });
  }

  if (input.signal?.aborted) throw new Error('生成已中止');

  // 需求 reqNo → 草稿需求映射（供用例校验悬空引用；已有需求也纳入）
  const reqByNo = new Map(requirements.map((r) => [r.reqNo, r]));
  const reqSetNos = [...reqByNo.keys()];

  // ================= 步骤 2/3：分块生成测试用例 =================
  const existingKeys = new Set(
    (getDb().prepare("SELECT source_key FROM test_cases WHERE project_id = ? AND source_key <> ''").all(input.projectId) as Array<{ source_key: string }>).map((r) => r.source_key),
  );
  const prefLine = buildPrefLine(input.prefs ?? {});

  const allCases: DraftCase[] = [];
  const chunks = chunkReqNos(reqSetNos);
  // T03263：块键按「需求号 + 标题 + 正文」指纹——需求内容改过自然 miss 缓存，不拿旧用例冒充新结果
  const chunkKey = (nos: string[]): string => 'cases:' + createHash('sha256')
    .update(nos.map((n) => `${n}:${reqByNo.get(n)?.title ?? ''}:${reqByNo.get(n)?.content ?? ''}`).join('|'))
    .digest('hex')
    .slice(0, 16);
  declareSegments(jobId, chunks.map((nos, i) => ({ sectionKey, segmentKey: chunkKey(nos), label: `用例块 ${i + 1}/${chunks.length}`, orderIndex: i + 1 })));
  input.onStage(`步骤 2/3｜生成测试用例…（${reqSetNos.length} 条需求分 ${chunks.length} 块处理，每块≤${CHUNK_SIZE}）`);

  const ctx: TcGenCtx = {
    chat, system, genConfig, contextBlock, prefLine, reqByNo, existingKeys, notes, allCases,
    jobId, sectionKey, segOf, chunkKey, reqNos: reqSetNos,
    onDelta: input.onDelta, onStage: input.onStage, toolId: input.toolId, signal: input.signal,
  };
  const state: TcGenState = { truncated: false, failedReqNos: new Set<string>(), lastChunkErr: '' };

  // 块级容错：单块 AI 调用失败（网络/提供商错误）只跳过该块，不报废整轮——
  // 此前一个 fetch failed 会让已生成结果全部丢失且草稿视图空白（用户报障：生成完成后看不到结果）。
  // 用户主动「停止」（signal.aborted）仍立即整体上抛；全部块皆零产出时抛错，避免给出空草稿假成功。
  for (const chunk of chunks) await runChunk(ctx, state, chunk);

  // ================= 步骤 3/3：覆盖率校验 + 定向补生成 =================
  input.onStage('步骤 3/3｜覆盖率校验…');
  let countByReq = countCasesByReq(allCases);
  let uncovered = reqSetNos.filter((no) => !countByReq.has(no));

  if (uncovered.length > 0) {
    uncovered = await fillUncovered(ctx, state, uncovered);
    countByReq = countCasesByReq(allCases);
  }

  // 整轮零产出：抛错（给空草稿不如给明确故障），与 A11「部分覆盖带告警」不冲突
  assertCasesProduced(allCases, state, reqSetNos.length);
  // 失败块点名（排除补生成已成功挽回的）：让用户知道哪些需求是故障跳过而非模型没写
  const failedStillUncovered = [...state.failedReqNos].filter((no) => !countByReq.has(no));
  if (failedStillUncovered.length > 0) {
    notes.push(`以下需求因调用失败被跳过：${failedStillUncovered.join(', ')}（最近一次错误：${state.lastChunkErr}）`);
  }

  const total = reqSetNos.length;
  const coverage = buildCoverage(requirements, total, uncovered.length, countByReq);
  input.onStage(`步骤 3/3 完成：覆盖 ${coverage.covered}/${total}（${coverage.rate}%）`);

  const cases = dedupeCases(allCases);

  const secs = Math.round((Date.now() - startedAt) / 1000);
  input.onStage(`生成完成：需求 ${total} 条、用例 ${cases.length} 条（耗时 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒）——请在草稿视图确认后导入`);
  logService.log('INFO', 'ai', `[用例生成] project=${input.projectId} reqs=${total} cases=${cases.length} 覆盖=${coverage.rate}% truncated=${state.truncated} 耗时=${Date.now() - startedAt}ms`);

  // T03263：终态落台账——只有「失败且补生成也没挽回」的块才算 partial，补偿成功的整轮仍是 done
  finalizeJob(jobId, failedStillUncovered.length > 0 ? 'partial' : 'done');

  const provenance = buildTcProvenance({
    input, reqTotal: total, caseCount: cases.length, chunkCount: chunks.length,
    reusedCount: reused.size, truncatedAny: state.truncated, failedCount: failedStillUncovered.length, model: genConfig.model,
  });
  // T03262（AI-101①）：落一份快照——重进卡片页按 projectId 取回，不必重跑生成才知道这一轮的来源
  recordCardProvenance(provenance, input.projectId);

  return { requirements, cases, coverage, notes, truncated: state.truncated, provenance };
}
