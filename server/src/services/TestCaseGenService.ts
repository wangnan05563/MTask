import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db/connection';
import { getAdapter, type AIAdapter, type ToolConfig } from '../adapters';
import { ConfigService } from './ConfigService';
import { PlanService } from './PlanService';
import { logService } from './LogService';
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
  return v == null ? '' : String(v).trim();
}

export interface TcGenDraft {
  requirements: DraftRequirement[];
  cases: DraftCase[];
  coverage: DraftCoverage;
  notes: string[];
  /** 分块重试耗尽仍有块被截断 → true，草稿页据此标注「本轮可能被截断，建议调大 max_tokens 后重跑」 */
  truncated: boolean;
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

/** 检索增强（镜像 PrdGenService.buildRetrieveBlock）：按关键词搜索代码注入 top 片段，失败不阻塞主流程（返回空串） */
function buildRetrieveBlock(project: { workspace_path: string | null }, input: { projectId: string; content: string; onStage: (m: string) => void }): string {
  if (!project.workspace_path) return '';
  try {
    const stat = WorkspaceService.refreshSymbols(input.projectId);
    input.onStage(`符号索引刷新：文件 ${stat.files} 个、符号 ${stat.symbols} 个（未变跳过 ${stat.skipped}）`);
    const kws = WorkspaceService.extractKeywords(input.content);
    const block = WorkspaceService.autoContext(input.projectId, kws);
    input.onStage(block ? `检索增强：按关键词 [${kws.slice(0, 6).join(', ')}] 命中代码片段已注入上下文` : '检索增强：无命中片段，跳过注入');
    return block;
  } catch {
    return '';
  }
}

/** 单次流式调用：抬预算 → max_tokens 被拒则回退重试 → 触顶返回 partial（truncated=true）。 */
async function callOnce(
  adapter: AIAdapter,
  system: string,
  user: string,
  genConfig: ToolConfig,
  onDelta: (t: string) => void,
  onStage: (m: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  let res = await adapter.chatStream(system, user, genConfig, onDelta, signal);
  // 提供商拒绝抬高的输出上限（直接 400）→ 回退到用户原值重试一次（与 PrdGenService 的 16K→8K 回退同款思路）
  if (!res.ok && !res.partial && /max_tokens|max_completion_tokens|too large|invalid/i.test(res.error ?? '')) {
    onStage(`模型未接受 ${genConfig.maxTokens} tokens 输出上限，回退重试…`);
    res = await adapter.chatStream(system, user, { ...genConfig, maxTokens: TESTCASE_FALLBACK_OUTPUT_TOKENS }, onDelta, signal);
  }
  if (res.ok) return { text: res.content ?? '', truncated: false };
  // finish_reason=length：adapter 给出 partial + 「超长被截断」；选择性采纳已成功部分并显式告警（其余失败原样抛出）
  if (res.partial && /超长被截断/.test(res.error ?? '')) return { text: res.partial, truncated: true };
  throw new Error(res.error ?? 'AI 生成失败');
}

/**
 * 生成测试用例主流程（三步 pipeline）。
 * @param input.content 已解析为文本的 PRD 原文（内部文档 content_md / 上传文件，由 T01491 路由负责取文本）
 * @param input.resplitRequirements 勾选「重新拆分」→ 强制 AI 输出 REQUIREMENTS；否则项目已有需求即默认复用
 */
export async function generateTestCasesStream(input: {
  projectId: string;
  toolId: string;
  content: string;
  source?: string;
  resplitRequirements?: boolean;
  prefs?: GenPrefs;
  onStage: (msg: string) => void;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}): Promise<TcGenDraft> {
  const db = getDb();
  const project = db.prepare('SELECT name, workspace_path FROM projects WHERE id = ?').get(input.projectId) as
    { name: string; workspace_path: string | null } | undefined;
  if (!project) throw new Error('项目不存在');
  if (!str(input.content)) throw new Error('PRD 原文为空，无法生成用例');

  const { type, config } = runtimeWithModel(input.toolId);
  const adapter = getAdapter(type);
  const startedAt = Date.now();
  const genConfig: ToolConfig = {
    ...config,
    maxTokens: Math.max(config.maxTokens ?? 4096, TESTCASE_MIN_OUTPUT_TOKENS),
    timeoutMs: Math.max(config.timeoutMs ?? 60_000, TESTCASE_MIN_TIMEOUT_MS),
  };

  // ---- 加载内置技能（SKILL.md + 三份 references）----
  input.onStage('加载内置技能「testcase-generate」…');
  const DIR = skillDir();
  const skill = readFileSync(join(DIR, 'SKILL.md'), 'utf8');
  const rules = REFERENCES
    .map((n) => `\n<!-- references/${n}.md -->\n${readFileSync(join(DIR, 'references', `${n}.md`), 'utf8')}`)
    .join('\n');
  const system = `${skill}\n\n# 测试设计规范库（生成时逐条对照）\n${rules}`;

  const srcLabel = input.source || 'PRD';
  input.onStage(`已载入 PRD：${srcLabel}（${input.content.length.toLocaleString('en-US')} 字）`);

  // ---- 工作空间上下文 + 检索增强（可选，失败静默跳过）----
  const ws = loadWorkspaceContext(project.workspace_path ?? '');
  input.onStage(ws ? '项目源码上下文已加载（目录树 + 说明文件片段）' : '跳过源码上下文（工作空间未绑定或不可读）');
  const retrieveBlock = buildRetrieveBlock(project, input);

  // 共享上下文块（拆分与分块生成都带上）
  const contextBlock = [
    `【目标项目】${project.name}`,
    ws ? `【项目源码上下文】\n${ws}` : '【项目源码上下文】未提供（未配置工作空间）',
    retrieveBlock ? `【工作空间检索片段】\n${retrieveBlock}` : '',
    `【PRD 原文（来源：${srcLabel}）】\n${ContextBudget.headTail(input.content, ContextBudget.prdContextChars, 'PRD ')}`,
  ].filter(Boolean).join('\n\n');

  // ================= 步骤 1/3：拆分需求跟踪矩阵 =================
  const existingReqs = PlanService.listRequirements(input.projectId);
  const existingReqNos = new Set(existingReqs.map((r) => str(r.req_no)).filter(Boolean));
  const notes: string[] = [];
  let requirements: DraftRequirement[];

  if (existingReqs.length > 0 && !input.resplitRequirements) {
    requirements = existingReqs.map((r) => ({
      reqNo: str(r.req_no),
      title: str(r.title),
      content: str(r.content),
      sourceRef: str(r.source_ref),
      priority: str(r.priority) || REQ_PRIORITY_DEFAULT,
      isNew: false,
    })).filter((r) => r.reqNo);
    input.onStage(`步骤 1/3｜拆分需求跟踪矩阵…（检测到项目已有 ${requirements.length} 条需求，默认复用；如需重新拆分请勾选「重新拆分」）`);
    input.onStage(`步骤 1/3 完成：复用已有需求 ${requirements.length} 条`);
  } else {
    input.onStage(`步骤 1/3｜拆分需求跟踪矩阵…${existingReqs.length > 0 ? `（已勾选重新拆分，将复用已有 ${existingReqs.length} 条 reqNo 并补充缺口）` : '（项目暂无需求，按 PRD 拆分）'}`);
    const existingLine = existingReqs.length > 0
      ? `【已有需求（复用其 reqNo，勿重复拆分）】\n${existingReqs.map((r) => `- ${str(r.req_no)}：${str(r.title)}`).join('\n')}`
      : '【已有需求】无（请从 REQ-001 顺序拆分）';
    const splitUser = [
      contextBlock,
      existingLine,
      '【本轮任务】仅拆分/补充需求，用例段输出空数组。',
      '按输出协议，只填充 <<<REQUIREMENTS>>> 段（<<<CASES>>> 输出 []）；每条需求原子、可独立验证、带 sourceRef 指向原文定位。',
    ].join('\n\n');
    const splitRes = await callOnce(adapter, system, splitUser, genConfig, input.onDelta, input.onStage, input.signal);
    const reqObjs = extractArray(splitRes.text, REQ_MARKER, CASE_MARKER, isRequirementObj);
    const seen = new Set<string>();
    const splitReqs: DraftRequirement[] = [];
    for (const o of reqObjs) {
      const r = normRequirement(o, existingReqNos);
      if (r && !seen.has(r.reqNo)) { seen.add(r.reqNo); splitReqs.push(r); }
    }
    requirements = splitReqs;
    notes.push(...parseNotes(splitRes.text));
    if (requirements.length === 0) {
      if (existingReqs.length > 0) {
        requirements = existingReqs.map((r) => ({ reqNo: str(r.req_no), title: str(r.title), content: str(r.content), sourceRef: str(r.source_ref), priority: str(r.priority) || REQ_PRIORITY_DEFAULT, isNew: false })).filter((r) => r.reqNo);
        notes.push('重新拆分未产出需求，已回退为复用已有需求');
      } else {
        throw new Error('未能从 PRD 拆分出任何需求条目——请检查 PRD 是否包含可验证需求，或更换模型后重试');
      }
    }
    const news = requirements.filter((r) => r.isNew).length;
    input.onStage(`步骤 1/3 完成：需求 ${requirements.length} 条（复用 ${requirements.length - news}，新增 ${news}）`);
  }

  if (input.signal?.aborted) throw new Error('生成已中止');

  // 需求 reqNo → 草稿需求映射（供用例校验悬空引用；已有需求也纳入）
  const reqByNo = new Map(requirements.map((r) => [r.reqNo, r]));
  const reqSetNos = [...reqByNo.keys()];

  // ================= 步骤 2/3：分块生成测试用例 =================
  const existingKeys = new Set(
    (db.prepare("SELECT source_key FROM test_cases WHERE project_id = ? AND source_key <> ''").all(input.projectId) as Array<{ source_key: string }>).map((r) => r.source_key),
  );
  const prefs = input.prefs ?? {};
  const prefLine = [
    prefs.perReq ? `每需求用例数≈${prefs.perReq}` : '',
    prefs.granularity === 'points' ? '粒度=仅要点（steps 可为空，但用例级 expected 必须完整可判定）' : '粒度=包含步骤（steps ≥2，一步一动作，每步给预期）',
    prefs.includeNegative === false ? '' : '必须包含负向用例（异常/边界）',
    prefs.priorityStrategy ? `优先级策略=${prefs.priorityStrategy}` : '优先级=风险驱动',
  ].filter(Boolean).join('；') || '按技能默认值';

  const allCases: DraftCase[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < reqSetNos.length; i += CHUNK_SIZE) chunks.push(reqSetNos.slice(i, i + CHUNK_SIZE));
  input.onStage(`步骤 2/3｜生成测试用例…（${reqSetNos.length} 条需求分 ${chunks.length} 块处理，每块≤${CHUNK_SIZE}）`);

  let truncatedAny = false;

  // 生成一个块；触顶或解析为空则对半拆块重试（≤MAX_SHRINK_RETRY 层）
  const genChunk = async (reqNos: string[], shrinkLeft: number): Promise<void> => {
    if (input.signal?.aborted) throw new Error('生成已中止');
    const scopeList = reqNos
      .map((no) => reqByNo.get(no))
      .filter((r): r is DraftRequirement => !!r)
      .map((r) => `- ${r.reqNo}：${r.title}${r.content ? `（${ContextBudget.headTail(r.content, 200, '内容 ')}）` : ''}`)
      .join('\n');
    const caseUser = [
      contextBlock,
      `【本次分块范围——仅为以下 ${reqNos.length} 条需求生成用例】\n${scopeList}`,
      `【生成偏好】${prefLine}`,
      '【本轮任务】按输出协议填充 <<<CASES>>> 段；已复用/已存在的需求 <<<REQUIREMENTS>>> 输出 []。',
      '每条用例必须：可判定（另一位工程师无需回来问即可执行并给出通过/失败）、可追溯到上述某条 reqNo、不输出 caseNo/id/status/lastResult 等服务端字段。',
      '严格独占一行输出标记：<<<REQUIREMENTS>>> 与 <<<CASES>>>（可选 <<<NOTES>>>）。',
    ].join('\n\n');

    const res = await callOnce(adapter, system, caseUser, genConfig, input.onDelta, input.onStage, input.signal);
    const objs = extractArray(res.text, CASE_MARKER, NOTE_MARKER, isCaseObj);
    const cases = objs
      .map((o) => normCase(o, existingKeys))
      .filter((c): c is DraftCase => !!c);
    notes.push(...parseNotes(res.text));

    // 缩块重试触发条件：触顶截断，或解析零用例但块内仍有 ≥2 需求（多半是被截断/协议跑偏）
    if (reqNos.length > 1 && shrinkLeft > 0 && (res.truncated || cases.length === 0)) {
      const round = MAX_SHRINK_RETRY - shrinkLeft + 1;
      input.onStage(`warn：块（${reqNos.length} 需求）输出${res.truncated ? '被截断' : '未产出用例'}，已缩小块大小重试（${round}/${MAX_SHRINK_RETRY}）`);
      const mid = Math.ceil(reqNos.length / 2);
      await genChunk(reqNos.slice(0, mid), shrinkLeft - 1);
      await genChunk(reqNos.slice(mid), shrinkLeft - 1);
      return;
    }
    if (res.truncated) {
      truncatedAny = true;
      input.onStage(`⚠ 本块输出触及上限，已保留 ${cases.length} 条成功用例——建议在「模型管理」调大 max_tokens 后对未覆盖需求重跑`);
    }
    for (const c of cases) {
      if (!reqByNo.has(c.reqNo)) {
        notes.push(`用例「${c.title}」引用了未知需求 ${c.reqNo}（悬空引用，导入时将按无需求处理或跳过）`);
      }
      allCases.push(c);
    }
    const coveredNow = new Set(allCases.map((c) => c.reqNo)).size;
    input.onStage(`  ▸ 已生成 ${coveredNow}/${reqSetNos.length} 条需求的用例（累计 ${allCases.length} 条）`);
  };

  for (const chunk of chunks) await genChunk(chunk, MAX_SHRINK_RETRY);

  // ================= 步骤 3/3：覆盖率校验 + 定向补生成 =================
  input.onStage('步骤 3/3｜覆盖率校验…');
  const countByReq = new Map<string, number>();
  for (const c of allCases) countByReq.set(c.reqNo, (countByReq.get(c.reqNo) ?? 0) + 1);
  let uncovered = reqSetNos.filter((no) => !countByReq.has(no));

  if (uncovered.length > 0) {
    input.onStage(`  未覆盖 ${uncovered.length} 条需求，定向补生成中…`);
    const before = allCases.length;
    for (let i = 0; i < uncovered.length; i += CHUNK_SIZE) {
      await genChunk(uncovered.slice(i, i + CHUNK_SIZE), MAX_SHRINK_RETRY);
    }
    countByReq.clear();
    for (const c of allCases) countByReq.set(c.reqNo, (countByReq.get(c.reqNo) ?? 0) + 1);
    uncovered = reqSetNos.filter((no) => !countByReq.has(no));
    input.onStage(`  补生成新增 ${allCases.length - before} 条用例，仍有 ${uncovered.length} 条需求未覆盖`);
    if (uncovered.length > 0) notes.push(`以下需求经补生成仍未产出用例：${uncovered.join(', ')}（可在草稿视图手动补充或忽略）`);
  }

  const total = reqSetNos.length;
  const covered = total - uncovered.length;
  const coverage: DraftCoverage = {
    total,
    covered,
    uncovered: uncovered.length,
    rate: total === 0 ? 0 : Math.round((covered / total) * 1000) / 10,
    byReq: requirements.map((r) => ({ reqNo: r.reqNo, title: r.title, caseCount: countByReq.get(r.reqNo) ?? 0, isNew: r.isNew })),
  };
  input.onStage(`步骤 3/3 完成：覆盖 ${covered}/${total}（${coverage.rate}%）`);

  // 用例去重（同一 source_key 在一次生成内可能被多块重复产出）
  const dedup = new Map<string, DraftCase>();
  for (const c of allCases) if (!dedup.has(c.sourceKey)) dedup.set(c.sourceKey, c);
  const cases = [...dedup.values()];

  const secs = Math.round((Date.now() - startedAt) / 1000);
  input.onStage(`生成完成：需求 ${total} 条、用例 ${cases.length} 条（耗时 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒）——请在草稿视图确认后导入`);
  logService.log('INFO', 'ai', `[用例生成] project=${input.projectId} reqs=${total} cases=${cases.length} 覆盖=${coverage.rate}% truncated=${truncatedAny} 耗时=${Date.now() - startedAt}ms`);

  return { requirements, cases, coverage, notes, truncated: truncatedAny };
}
