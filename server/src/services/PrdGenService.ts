import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getDb } from '../db/connection';
import { getAdapter, type AIAdapter, type ToolConfig } from '../adapters';
import { ConfigService } from './ConfigService';
import { PlanService } from './PlanService';
import { logService } from './LogService';
import { ContextBudget, WorkspaceService, loadIgnoreRules, isIgnored, yieldToEventLoop, type RetrieveContext } from './WorkspaceService';
import { runGitReadonly, GitCollectError } from './gitCollect';
import { extractNeedles, parseDomainVocab, FALLBACK_VOCAB, type VocabEntry } from './prdKeywords'; // T03442：中文需求 → 代码标识符的词桥
import { parseIssuesJson, parsePrdIssues, splitPrdBody, inlineIssuesSection, type PrdGenIssue } from './prdIssues'; // T00814：问题清单解析抽为可测模块；T00818：清单内联正文章节
import { buildCardProvenance, chars, recordCardProvenance, type CardProvenance } from './aiCardProvenance'; // T03262（AI-101①）：溯源行与面板/导出稿逐字同源
import { recordUsage } from '../util/aiUsageRecord'; // T03296（G-2）：本服务直连适配器，用量需显式落 card_key

/** T03296（G-2 覆盖率）：PRD 生成卡的稳定 key（注册表 server/src/util/aiCards.ts） */
const PRD_GEN_CARD = 'ai.prd_gen';

/**
 * T00769：原始需求生成 PRD（AI 控制台卡片「原始需求生成PRD」后端）。
 * 内置技能 server/src/skills/prd-generate/（由 bemp-generate-prd 转内置）驱动：
 * 原始需求文件（.md/.txt/.docx/.xlsx/.csv）+ 项目源码上下文 → 流式生成 PRD + 待确认问题清单。
 * 老式 .doc/.xls（BIFF 二进制）不支持，沿用既有友好提示引导另存。
 */

/** 内置技能资产目录：优先 dist/skills（build 脚本从 src/skills 复制），回退 src/skills（未跑复制脚本时） */
function skillDir(): string {
  const candidates = [join(__dirname, '..', 'skills', 'prd-generate'), join(__dirname, '..', '..', 'src', 'skills', 'prd-generate')];
  for (const dir of candidates) {
    try { statSync(join(dir, 'SKILL.md')); return dir; } catch { /* 尝试下一候选 */ }
  }
  return candidates[0];
}

/** 工作区上下文采样上限：目录树最多条目数（字符预算见 ContextBudget，T00776） */
const TREE_LIMIT = 150;

/** 取运行时配置并校验模型已配置（与 AIService.runtimeWithModel 同语义，独立实现避免循环依赖） */
function runtimeWithModel(toolId: string) {
  const { type, config } = ConfigService.getRuntimeConfig(toolId);
  if (!config.model) throw new Error('所选模型未配置，请先在「模型管理」为该工具填写默认模型');
  return { type, config };
}

/** 原始需求文件 → 文本（按扩展名分发，复用 PlanService 既有提取能力；不支持的格式抛可操作提示） */
export async function extractSourceText(filename: string, buffer: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  const ext = extname(lower);
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return buffer.toString('utf8');
  if (ext === '.docx') return PlanService.docxToMarkdown(buffer);
  if (ext === '.xlsx' || ext === '.csv') return PlanService.tableToTextAsync(buffer, filename);
  if (ext === '.doc') throw new Error('老式 .doc 暂不支持，请用 Word 另存为 .docx 后重新上传');
  if (ext === '.xls') throw new Error('老式 .xls 暂不支持，请用 Excel 另存为 .xlsx 后重新上传');
  throw new Error(`不支持的文件格式「${ext || filename}」——支持 .doc/.docx/.xls/.xlsx/.md/.txt`);
}

/**
 * 项目源码上下文：目录树（忽略构建/依赖目录）+ README/package.json 片段。读取失败返回空串（跳过并注明）。
 * T02200（与符号索引/检索 memo 同族的让路改造）：目录树采样原是一次性跑完的同步递归，
 * 现改为显式栈 + 每 25ms 让出事件循环。深度 3、TREE_LIMIT 与输出口径不变。
 */
const WS_TREE_SLICE_MS = 25;

export async function loadWorkspaceContext(workspacePath: string): Promise<string> {
  if (!workspacePath) return '';
  try {
    statSync(workspacePath);
  } catch {
    return '';
  }
  const tree: string[] = [];
  const rules = loadIgnoreRules(workspacePath); // M-4：与文件搜索共用同一忽略规则源（含 .mtaskignore），消除双轨
  type TreeFrame = { dir: string; rel: string; depth: number; entries: Array<{ name: string; isDir: boolean; relChild: string }>; i: number };
  const stack: TreeFrame[] = [];
  const pushDir = (dir: string, rel: string, depth: number): void => {
    if (depth > 3 || tree.length >= TREE_LIMIT) return;
    let entries: TreeFrame['entries'];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDir: e.isDirectory(), relChild: rel ? `${rel}/${e.name}` : e.name }))
        .filter((e) => !isIgnored(e.relChild, e.isDir, rules) && !e.name.startsWith('.'))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir));
    } catch {
      return;
    }
    stack.push({ dir, rel, depth, entries, i: 0 });
  };
  pushDir(workspacePath, '', 0);
  let done = false;
  while (!done) {
    const until = Date.now() + WS_TREE_SLICE_MS;
    while (!done && Date.now() < until) {
      // 采样上限命中：注明截断并整体终止（原实现在每层递归各补一次说明，内容等价，此处只留一条）
      if (tree.length >= TREE_LIMIT) { tree.push('…（超出采样上限，已截断）'); stack.length = 0; done = true; break; }
      const frame = stack.at(-1);
      if (!frame) { done = true; break; }
      if (frame.i >= frame.entries.length) { stack.pop(); continue; }
      const e = frame.entries[frame.i++];
      tree.push(`${'  '.repeat(frame.depth)}${e.isDir ? '[目录] ' : ''}${e.name}`);
      if (e.isDir) pushDir(join(frame.dir, e.name), e.relChild, frame.depth + 1);
    }
    if (!done) await yieldToEventLoop();
  }
  const parts = [`项目目录树（深度 3，最多 ${TREE_LIMIT} 项）：\n${tree.join('\n')}`];
  await yieldToEventLoop(); // T02200：说明文件片段读取同样给只读接口让路
  for (const f of ['README.md', 'readme.md', 'package.json']) {
    try {
      const p = join(workspacePath, f);
      statSync(p);
      // T00776：片段截断走统一 ContextBudget（替换原 FILE_SNIPPET_LIMIT 硬编码）
      const text = ContextBudget.headTail(readFileSync(p, 'utf8'), ContextBudget.fileSnippetChars, `${f} `);
      parts.push(`【${f} 片段】\n${text}`);
      break; // 命中一个说明性文件即可，控制上下文体积
    } catch { /* 无该文件继续 */ }
  }
  return ContextBudget.headTail(parts.join('\n\n'), ContextBudget.treeChars + ContextBudget.fileSnippetChars, '项目上下文 ');
}

/**
 * T00769 验证失败修复：PRD 生成的输出预算下限。
 * 全库 AI 工具默认 max_tokens=4096，而本场景要一次产出「完整 PRD 正文」，思考型模型的
 * 思维链还会占用同一预算 —— 实测 DeepSeek 上仅输出 1775 字符即触顶截断（finish_reason=length），
 * 上层按 T00779 判定失败，表现即「右侧控制台无输出 + 未识别出待确认问题」。
 * 这里按场景抬到下限值（仍尊重用户更高的自定义配置），超时同理放宽到 5 分钟。
 */
const PRD_MIN_OUTPUT_TOKENS = 16_384;
/** 提供商不接受 16K 输出上限时的回退值（原先的下限，能跑通但长文档可能触顶） */
const PRD_FALLBACK_OUTPUT_TOKENS = 8192;
const PRD_MIN_TIMEOUT_MS = 300_000;

export type { PrdGenIssue } from './prdIssues'; // T00814：类型定义随解析模块迁移

/**
 * 流式生成 PRD：内置技能 prompt + 原始需求 + 项目上下文 → adapter.chatStream。
 * onStage 推阶段日志、onDelta 推正文增量；完成后按 <<<PRD>>>/<<<ISSUES>>> 协议解析。
 */
/** 检索增强：按需求关键词搜索代码，注入 top 片段；失败不阻塞主流程（返回空串）。
 *  T02200：改异步——符号索引刷新与 memo 预扫描都在片间让出事件循环，不再饿死只读接口。
 *  T03441：连覆盖度一起回传（扫描文件数 / 是否触顶 / 跳过超大文件），
 *  使 stage 能区分「仓库里确实没有」与「预算内没扫到」。
 *  T03442：检索词改由 `extractNeedles` 产出（词表 → 拉丁 → 中文短语），并走目录级定向检索；
 *  stage 回显「未命中词」，便于判断是词表缺词还是代码里确实没有。
 *  T03443：再叠一层「符号词典反查」——用 workspace_symbols 把需求词反查成完整标识符（含 path:line），
 *  既直接进 prompt，也作为补充检索词喂回检索，弥补中英跨语言的字面缺口。 */
async function buildRetrieveBlock(
  project: { workspace_path: string | null },
  input: { projectId: string; needles: string[]; dropped?: string[]; onStage: (msg: string) => void },
): Promise<{ block: string; coverage: string; hitPaths: string[] }> {
  const empty = { block: '', coverage: '', hitPaths: [] };
  if (!project.workspace_path) return empty;
  if (input.needles.length === 0) {
    input.onStage('检索增强：需求里没有可用的检索词（拉丁标识符/业务短语/词表均未命中），跳过代码检索');
    return empty;
  }
  try {
    const stat = await WorkspaceService.refreshSymbols(input.projectId);
    input.onStage(`符号索引刷新：文件 ${stat.files} 个、符号 ${stat.symbols} 个（未变跳过 ${stat.skipped}）${stat.deferred ? '，超预算余量已交后台续跑（T02200 让路，下次刷新补齐）' : ''}`);
    const dropped = input.dropped ?? [];
    const droppedNote = dropped.length > 0 ? `；未纳入 ${dropped.length} 个：${dropped.slice(0, 6).join('、')}` : '';
    input.onStage(`检索词 ${input.needles.length} 个：[${input.needles.slice(0, 8).join(', ')}${input.needles.length > 8 ? ' …' : ''}]`
      + droppedNote);
    // T03443：符号反查（索引即查，失败降级为无反查，不影响主检索）
    let symbols: Array<{ path: string; symbol: string; line: number; kind: string }> = [];
    try { symbols = WorkspaceService.symbolMatches(input.projectId, input.needles); } catch { symbols = []; }
    const symbolBlock = buildSymbolBlock(symbols);
    const symbolNames = symbols.slice(0, 3).map((s) => s.symbol).join(', ');
    const symbolMore = symbols.length > 3 ? ' …' : '';
    input.onStage(symbols.length > 0
      ? `符号词典反查：命中 ${symbols.length} 个标识符（${symbolNames}${symbolMore}）`
      : '符号词典反查：无匹配标识符（符号索引未覆盖，或该领域无对应英文命名）');
    // 补充检索词：符号全名往往比需求用词更贴近代码字面（上限沿用 NEEDLE 口径，避免稀释）
    const extra = symbols.map((s) => s.symbol).filter((s) => !input.needles.includes(s)).slice(0, 6);
    const needles = [...input.needles, ...extra];
    const r = await WorkspaceService.autoContextScoped(input.projectId, needles);
    const coverage = coverageNote(r);
    const scope = `${r.scannedFiles} 个文件${scopeSuffix(r)}`;
    const dirsMore = (r.scopedDirs?.length ?? 0) > 3 ? ' …' : '';
    const dirs = r.scopedDirs && r.scopedDirs.length > 0 ? `；目录定向深扫 ${r.scopedDirs.length} 个目录（${r.scopedDirs.slice(0, 3).join('、')}${dirsMore}）` : '';
    const block = [symbolBlock, r.block].filter(Boolean).join('\n\n');
    if (r.hits === 0 && !symbolBlock) {
      input.onStage(`检索增强：预算内无命中（扫描 ${scope}${dirs}）——仓库里可能确实没有相关代码`);
      return { block: '', coverage, hitPaths: [] };
    }
    const unmatched = r.unmatchedKeywords ?? [];
    const unmatchedNote = unmatched.length > 0 ? `；未命中词：${unmatched.slice(0, 6).join('、')}` : '';
    input.onStage(`检索增强：命中 ${r.hits} 条片段（扫描 ${scope}${dirs}）`
      + unmatchedNote);
    return { block, coverage, hitPaths: r.hitPaths ?? [] };
  } catch { return empty; /* 检索增强失败不阻塞主流程 */ }
}

/** T03443：符号反查段的渲染（纯函数：便于门断言顺序与预算；空输入返回空串） */
export function buildSymbolBlock(rows: ReadonlyArray<{ path: string; symbol: string; line: number; kind: string }>): string {
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const kindNote = r.kind ? `  (${r.kind})` : '';
    return `${r.symbol}  ${r.path}:${r.line}${kindNote}`;
  });
  return ContextBudget.headTail(
    `【符号词典反查（workspace_symbols，需求词 → 代码标识符）】\n${lines.join('\n')}`,
    ContextBudget.symbolContextChars,
    '符号反查 ',
  );
}

/** T03441：扫描范围后缀——「是否触顶」与「跳过的超大文件」是用户判断命中可信度的关键 */
export function scopeSuffix(r: RetrieveContext): string {
  const truncated = r.truncated ? '，已到预算上限，未覆盖全部代码' : '，未触顶';
  const skipped = r.skippedOversized > 0 ? `，跳过超大文件 ${r.skippedOversized} 个` : '';
  return `${truncated}${skipped}`;
}

/** T03441：给模型的覆盖度说明——上下文不全时必须让模型知道，避免它自信补全 */
export function coverageNote(r: RetrieveContext): string {
  if (r.hits === 0) {
    return `未命中任何片段（扫描 ${r.scannedFiles} 个文件${scopeSuffix(r)}）。` +
      '若需求涉及代码改动，请把「该模块在代码中的现状」列为待确认问题，不要凭空假设。';
  }
  return `命中 ${r.hits} 条；扫描 ${r.scannedFiles} 个文件${scopeSuffix(r)}。`.concat(
    r.truncated ? '上下文不完整，涉及影响面/兼容性的判断请在待确认问题中标注依据不足。' : '',
  );
}

/** T03441：注入的近期提交条数（一次 git log，输出再按 ContextBudget.gitContextChars 截断） */
const GIT_CONTEXT_COMMITS = 50;

/**
 * T03441：近期提交脉络——此前 PRD 生成只看到「当前文件快照」，不知道「最近在动什么」，
 * 影响面/兼容性章节因此缺少事实依据。本函数复用只读引擎 `runGitReadonly`（选项均已在 log 白名单内），
 * 任何失败（未装 git / 非仓库 / 超时）一律降级为跳过并在 stage 说明原因，绝不阻塞生成。
 */
export async function buildGitContext(workspacePath: string | null | undefined): Promise<{ block: string; stage: string }> {
  if (!workspacePath) return { block: '', stage: '跳过 Git 上下文（未绑定工作空间）' };
  try {
    const r = await runGitReadonly(
      'log',
      [`-n${GIT_CONTEXT_COMMITS}`, '--no-merges', '--format=%h%x09%an%x09%aI%x09%s'],
      ['--'],
      workspacePath,
    );
    const rows = r.stdout.split('\n').filter(Boolean).flatMap((line) => {
      const [sha, author, date, ...rest] = line.split('\t');
      if (!sha || !date) return [];
      return [`${sha}  ${author}  ${date.slice(0, 10)}  ${rest.join('\t')}`];
    });
    if (rows.length === 0) return { block: '', stage: '跳过 Git 上下文（仓库还没有提交）' };
    const text = `【近期提交脉络（最近 ${rows.length} 次，仅摘要）】\n${rows.join('\n')}`;
    const block = ContextBudget.headTail(text, ContextBudget.gitContextChars, '提交脉络 ');
    return { block, stage: `Git 上下文：最近 ${rows.length} 次提交已注入（${block.length} 字符，预算 ${ContextBudget.gitContextChars}）` };
  } catch (e) {
    const kind = e instanceof GitCollectError ? e.kind : 'failed';
    let label: string;
    if (kind === 'no-git') label = '未安装 git';
    else if (kind === 'not-a-repo') label = '不是 Git 仓库';
    else if (kind === 'timeout') label = 'git 读取超时';
    else label = 'git 读取失败';
    return { block: '', stage: `跳过 Git 上下文（${label}）` };
  }
}

/** T03443：按文件做提交归属的输入上限与每文件提交条数 */
export const GIT_FILE_CONTEXT_FILES = 3;
export const GIT_FILE_CONTEXT_COMMITS = 3;

/**
 * T03443：命中文件的提交归属——「这些文件最近谁在改、改了什么」是影响面/兼容性章节的直接依据。
 * 每个文件一次只读 `git log`（`-n3 --no-merges --format=… -- <path>`，选项与 `--` 均在白名单内，
 * 无需扩 gitCollect 的只读集合）。任一路径失败只跳过该文件，整体失败返回空串——绝不阻塞生成。
 */
export async function buildHitFileGitContext(
  workspacePath: string | null | undefined,
  paths: readonly string[],
): Promise<{ block: string; stage: string }> {
  const files = [...new Set(paths)].slice(0, GIT_FILE_CONTEXT_FILES);
  if (!workspacePath || files.length === 0) return { block: '', stage: '' };
  let failed = 0;
  const perFile = await Promise.all(files.map(async (rel) => {
    try {
      const r = await runGitReadonly(
        'log',
        [`-n${GIT_FILE_CONTEXT_COMMITS}`, '--no-merges', '--format=%h%x09%an%x09%aI%x09%s'],
        ['--', rel],
        workspacePath,
      );
      const rows = r.stdout.split('\n').filter(Boolean).flatMap((line) => {
        const [sha, author, date, ...rest] = line.split('\t');
        if (!sha || !date) return [];
        return [`  ${sha}  ${author}  ${date.slice(0, 10)}  ${rest.join('\t')}`];
      });
      return rows.length > 0 ? `${rel}\n${rows.join('\n')}` : '';
    } catch { failed++; return ''; /* 单文件失败只跳过该文件 */ }
  }));
  const sections = perFile.filter(Boolean);
  if (sections.length === 0) {
    return {
      block: '',
      stage: failed > 0
        ? `命中文件提交归属：Git 读取失败（${failed}/${files.length} 个文件），跳过该段`
        : `命中文件提交归属：这 ${files.length} 个文件在 Git 历史里无提交记录，跳过`,
    };
  }
  const text = `【命中文件最近改动（只读 git log，按文件；每文件至多 ${GIT_FILE_CONTEXT_COMMITS} 次）】\n${sections.join('\n')}`;
  const block = ContextBudget.headTail(text, ContextBudget.gitFileContextChars, '文件改动 ');
  return { block, stage: `命中文件提交归属：${sections.length}/${files.length} 个文件已注入（${block.length} 字符，预算 ${ContextBudget.gitFileContextChars}）` };
}

/** T03441：上下文占比行（只输出字符数与段名，不含任何正文——需求与提交作者不进 stage 日志） */
export function formatContextOverview(segments: ReadonlyArray<readonly [string, number]>): string {
  const total = segments.reduce((sum, [, n]) => sum + n, 0);
  const segmentOverview = segments.map(([k, n]) => `${k} ${(n / 1000).toFixed(1)}K`).join(' / ');
  return `上下文总览：${(total / 1000).toFixed(1)}K 字符（${segmentOverview}）`;
}

/** T03442：整份 PRD 上下文的总量闸（各段字符合计；技能规则段不参与裁剪） */
export const CONTEXT_TOTAL_LIMIT = 60000;

export interface ContextParts {
  rules: string;
  source: string;
  git: string;
  retrieve: string;
  requirement: string;
}

/**
 * T03442：超总量时按「检索片段 → 源码上下文 → Git 脉络 → 需求」顺序裁剪（信息密度由低到高），
 * 需求保底原长的 50%——宁可少给代码，也不能让需求本身被裁成残句。
 */
export function clipContextParts(parts: ContextParts, limit = CONTEXT_TOTAL_LIMIT): ContextParts & { clipped: string[] } {
  const out: ContextParts = { ...parts };
  const clipped: string[] = [];
  const total = (): number => out.rules.length + out.source.length + out.git.length + out.retrieve.length + out.requirement.length;
  const order: Array<{ key: keyof ContextParts; label: string; floorRatio: number }> = [
    { key: 'retrieve', label: '检索片段', floorRatio: 0 },
    { key: 'source', label: '源码上下文', floorRatio: 0 },
    { key: 'git', label: 'Git 脉络', floorRatio: 0 },
    { key: 'requirement', label: '原始需求', floorRatio: 0.5 },
  ];
  for (const { key, label, floorRatio } of order) {
    const over = total() - limit;
    if (over <= 0) break;
    const cur = out[key];
    if (!cur) continue;
    const floor = Math.ceil(cur.length * floorRatio);
    const target = Math.max(floor, cur.length - over);
    if (target >= cur.length) continue;
    out[key] = target > 0 ? ContextBudget.headTail(cur, target, `${label} `) : '';
    clipped.push(label);
  }
  return { ...out, clipped };
}

/**
 * T00769 验证失败修复：工作空间未绑定时的友好提示（控制台 stage 日志可见）。
 * 未绑定工作空间 → 缺少源码上下文 → AI 只能依据原始需求文本生成，待确认问题识别质量显著下降。
 * 这里给出可操作提示（去任务菜单绑定），而不是「静默跳过上下文」。
 */
function workspaceStage(path: string | null | undefined): { ok: boolean; msg: string } {
  if (!path) {
    return {
      ok: false,
      msg: '⚠ 当前项目未绑定工作空间 —— 将仅依据原始需求文本生成，缺少项目源码上下文，待确认问题的识别质量会明显下降。建议先到「任务」菜单为该项目绑定工作空间（项目下拉条右侧的「工作空间」）后重新生成。',
    };
  }
  try {
    statSync(path);
    return { ok: true, msg: '' };
  } catch {
    return { ok: false, msg: `⚠ 工作空间「${path}」不可读（已移动/删除或无权限）—— 本次跳过源码上下文，待确认问题识别质量会下降。请到「任务」菜单重新绑定有效路径。` };
  }
}

/**
 * T00769 验证失败修复：问题清单兜底补问。
 * 主流程未解析出任何待确认问题时，基于已生成的 PRD 发起一次轻量提问，只求 JSON 问题清单；
 * 失败或仍为空则放弃（保持原「AI 未生成待确认问题」提示，用户可手动补自定义问题）。
 */
async function fallbackIssues(
  project: { name: string },
  prdMd: string,
  source: string,
  adapter: AIAdapter,
  config: ToolConfig,
  toolId: string,
  onStage: (msg: string) => void,
  signal?: AbortSignal, // T00838：补问同样可被外部中止
): Promise<PrdGenIssue[]> {
  onStage('未解析到待确认问题 —— 发起一次补充提问（基于已生成 PRD 反推待确认项）…');
  const system = '你是资深需求分析师。只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。';
  const user = [
    `【目标项目】${project.name}`,
    '【已生成的 PRD 摘要】\n' + ContextBudget.headTail(prdMd, 4000, 'PRD '),
    '【原始需求片段】\n' + ContextBudget.headTail(source, 2000, '需求 '),
    '请基于上述 PRD 与原始需求，列出 5~10 条仍需与业务方确认的问题（缺失即阻塞落地的关键信息）。',
    '输出格式：[{"level":"blocker|suggested|info","question":"…","context":"…","suggestion":"…"}]',
    'level 语义：blocker=不确认无法开工；suggested=影响方案选择；info=补充说明。',
    // T00817：补充提问同样要求给出建议选项，保证兜底场景也具备「问题 + AI建议」结构
    'suggestion 语义：针对该问题的 2~4 个可落地建议选项，用「选项A：… / 选项B：… / 选项C：…」分隔。',
  ].join('\n\n');
  try {
    const startedAt = Date.now();
    const r = await adapter.chat(system, user, config, signal);
    recordUsage('ask', toolId, config.model, r.ok, startedAt, r.content?.length ?? 0, r.error, PRD_GEN_CARD); // T03296：补问同属 PRD 生成卡
    if (!r.ok || !r.content) { onStage('补充提问失败，本次未产出待确认问题（可手动新增自定义问题）'); return []; }
    const issues = parseIssuesJson(r.content);
    onStage(issues.length > 0 ? `补充提问完成：新增 ${issues.length} 条待确认问题` : '补充提问未产出问题清单（可手动新增自定义问题）');
    return issues;
  } catch {
    onStage('补充提问异常，本次未产出待确认问题（可手动新增自定义问题）');
    return [];
  }
}

export async function generatePrdStream(input: {
  projectId: string;
  toolId: string;
  filename: string;
  content: string;
  onStage: (msg: string) => void;
  onDelta: (text: string) => void;
  /** T00838：可选中止信号——上游（SSE 路由/停止按钮）可主动中断底层 AI 请求 */
  signal?: AbortSignal;
}): Promise<{ prdMd: string; issues: PrdGenIssue[]; provenance: CardProvenance }> {
  const db = getDb();
  const project = db.prepare('SELECT name, workspace_path FROM projects WHERE id = ?').get(input.projectId) as
    { name: string; workspace_path: string | null } | undefined;
  if (!project) throw new Error('项目不存在');

  const { type, config } = runtimeWithModel(input.toolId);
  const adapter = getAdapter(type);
  const startedAt = Date.now();
  // 仅在本次生成调用上抬高输出/超时预算，不改动工具本身配置（其余场景不受影响）
  const genConfig: ToolConfig = {
    ...config,
    maxTokens: Math.max(config.maxTokens ?? 4096, PRD_MIN_OUTPUT_TOKENS),
    timeoutMs: Math.max(config.timeoutMs ?? 60_000, PRD_MIN_TIMEOUT_MS),
  };

  input.onStage('加载内置技能「prd-generate」（原 bemp-generate-prd 已转内置）…');
  const SKILL_DIR = skillDir();
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const rules = (['bill-business-rules', 'compliance-rules', 'ux-rules'] as const)
    .map((n) => {
      const refMd = `${n}.md`;
      return `\n<!-- references/${n}.md -->\n${readFileSync(join(SKILL_DIR, 'references', refMd), 'utf8')}`;
    })
    .join('\n');

  // T03442：领域词表（人可改的 references/domain-vocab.md；缺失或解析为空时用内置兜底，不影响生成）
  let vocab: VocabEntry[] = FALLBACK_VOCAB;
  try {
    const parsed = parseDomainVocab(readFileSync(join(SKILL_DIR, 'references', 'domain-vocab.md'), 'utf8'));
    if (parsed.length > 0) vocab = parsed;
  } catch { /* 词表缺失走兜底 */ }

  // T00769 验证失败修复：工作空间状态显式检测 + 友好提示（未绑定/不可读都能在控制台看到可操作指引）
  const wsStatus = workspaceStage(project.workspace_path);
  if (!wsStatus.ok) input.onStage(wsStatus.msg);

  input.onStage('加载项目源码上下文…');
  const ws = await loadWorkspaceContext(project.workspace_path ?? '');
  input.onStage(ws ? '项目源码上下文已加载（目录树 + 说明文件片段）' : '跳过源码上下文（工作空间未绑定或不可读）');

  const extract = extractNeedles(input.content, vocab);
  const retrieve = await buildRetrieveBlock(project, {
    projectId: input.projectId,
    needles: extract.needles.map((n) => n.text),
    dropped: extract.dropped,
    onStage: input.onStage,
  });

  const git = await buildGitContext(project.workspace_path);
  input.onStage(git.stage);
  // T03443：命中文件的提交归属（依赖上一步检索给出的路径；无命中则整段跳过，零额外子进程）
  const fileGit = await buildHitFileGitContext(project.workspace_path, retrieve.hitPaths);
  if (fileGit.stage) input.onStage(fileGit.stage);

  // T03441：需求全文此前原样进 prompt，几十页 docx 会挤掉源码上下文且成本线性上升
  const requirement = ContextBudget.headTail(input.content, ContextBudget.requirementChars, '原始需求 ');
  if (requirement.length !== input.content.length) {
    input.onStage(`原始需求超长，已保头保尾压缩：${input.content.length} → ${requirement.length} 字符（中段略去 ${input.content.length - requirement.length}）`);
  }

  input.onStage(`原始需求文本提取完成：${input.filename}（${input.content.length} 字符），开始 AI 生成…`);

  // T00769 验证失败修复：把「必须输出待确认问题清单」写成硬约束，避免无上下文时模型只写正文不产问题
  const ISSUE_RULE = [
    '【输出硬性要求（务必遵守）】',
    '1. 先输出完整 PRD 正文；',
    '2. 正文结束后另起一行输出分隔符 <<<ISSUES>>>，其后紧跟 JSON 数组，列出 5~10 条待确认问题；',
    '3. 每条格式：{"level":"blocker|suggested|info","question":"…","context":"…","suggestion":"…"}；',
    // T00817：为每条待确认问题生成可落地的建议选项，形成「问题 + AI建议」配套，辅助产品快速决策。
    // suggestion 组织形式：用「选项A：xxx / 选项B：xxx / 选项C：xxx」分隔，给出 2~4 个有区分度的可行选项
    '4. suggestion 为该问题的 AI 建议：给出 2~4 个可落地的建议选项，用「选项A：… / 选项B：… / 选项C：…」分隔；必须基于问题与项目上下文推导，不得虚构无依据的内容；',
    '5. 即使项目源码上下文缺失，也必须基于原始需求本身列出阻塞落地的关键未知项，不得省略该 JSON 段。',
    // T00814：长文档实测会在 8K 输出上限处被截断，导致整份 PRD 作废；这里给出篇幅边界，
    // 把预算花在变更点/字段/验收标准上，而不是无节制铺陈
    '6. 篇幅控制：PRD 正文不超过 6000 字，聚焦「变更点、字段清单、业务规则、验收标准、影响面」；不要复述原始需求全文，不要输出目录。',
  ].join('\n');

  const system = `${skill}\n\n# 三角色审查规则库（审查时逐条对照）\n${rules}`;
  // T03442：总量闸——此前只有需求侧单段上限，各段相加仍可能把上下文撑到几十万字符
  const gitParts = [git.block, fileGit.block].filter(Boolean).join('\n\n');
  const parts = clipContextParts({ rules: system, source: ws, git: gitParts, retrieve: retrieve.block, requirement });
  if (parts.clipped.length > 0) {
    input.onStage(`上下文超出总量预算（${CONTEXT_TOTAL_LIMIT} 字符），已按优先级裁剪：${parts.clipped.join(' → ')}`);
  }
  const user = [
    `【目标项目】${project.name}`,
    parts.source ? `【项目源码上下文】\n${parts.source}` : '【项目源码上下文】未提供（未配置工作空间）',
    parts.git ? `【Git 脉络与命中文件改动（只读 git log）】\n${parts.git}` : '',
    parts.retrieve ? `【工作空间检索片段（T00777 自动检索）】\n${parts.retrieve}` : '',
    retrieve.coverage ? `【检索覆盖度】${retrieve.coverage}` : '',
    `【原始需求文件】${input.filename}`,
    `【原始需求全文】\n${parts.requirement}`,
    ISSUE_RULE,
  ].filter(Boolean).join('\n\n');

  // T03441：此前只打需求字符数，看不到各段占比——预算被谁吃掉无从判断
  input.onStage(formatContextOverview([
    ['规则', parts.rules.length],
    ['源码', parts.source.length],
    ['Git', parts.git.length],
    ['检索', parts.retrieve.length],
    ['需求', parts.requirement.length],
  ]));

  const genStartedAt = Date.now();
  const genChars = (res: { ok: boolean; content?: string; partial?: string }): number => (res.ok ? res.content?.length : res.partial?.length) ?? 0;
  let result = await adapter.chatStream(system, user, genConfig, input.onDelta, input.signal);
  recordUsage('stream', input.toolId, genConfig.model, result.ok, genStartedAt, genChars(result), result.error, PRD_GEN_CARD);
  // T00814：个别提供商不接受 16K 输出上限（请求直接 400）——此时回退到 8K 重试一次，
  // 避免"提高了预算反而整个功能不可用"。仅在错误文本确指 max_tokens 时回退，其余错误照旧抛出。
  if (!result.ok && /max_tokens|max_completion_tokens|too large|invalid/i.test(result.error ?? '')) {
    input.onStage(`模型未接受 ${genConfig.maxTokens} tokens 输出上限，回退 ${PRD_FALLBACK_OUTPUT_TOKENS} 重试…`);
    const retryStartedAt = Date.now();
    result = await adapter.chatStream(system, user, { ...genConfig, maxTokens: PRD_FALLBACK_OUTPUT_TOKENS }, input.onDelta, input.signal);
    recordUsage('stream', input.toolId, genConfig.model, result.ok, retryStartedAt, genChars(result), result.error, PRD_GEN_CARD);
  }
  // T00814：长文档实测即使预算给到 16K/32K，部分思考型模型仍会在自身上限处截断
  // （流出的正文 9~10K 字符即 finish_reason=length）。此时整份作废太浪费 ——
  // 改为「保留已生成部分 + 显式告警」，问题清单随后由补问兜底；其它失败仍原样抛出。
  let text = '';
  let outputTruncated = false;
  if (result.ok) {
    text = result.content ?? '';
  } else if (result.partial && /超长被截断/.test(result.error ?? '')) {
    text = result.partial;
    outputTruncated = true;
    input.onStage(`⚠ AI 输出触及上限，已保留当前 ${text.length} 字符继续 —— PRD 末尾可能不完整，请在交互表格中核对内容；待确认问题将由补充提问补齐`);
  } else {
    throw new Error(result.error ?? 'AI 生成失败');
  }

  input.onStage('AI 生成完成，解析待确认问题清单…');
  // T00814：标记识别放宽（`<<<ISSUES>>>` / `<ISSUES>` / 带空格变体），避免模型写了别的写法时
  // 把 JSON 段当成 PRD 正文留在文档里
  const prdMd = splitPrdBody(text);
  let issues = parsePrdIssues(text, prdMd, input.onStage);
  // 兜底补问：主流程未产出任何问题时，基于已生成 PRD 反推一份问题清单（失败不影响主流程）
  if (issues.length === 0) {
    issues = await fallbackIssues(project, prdMd, input.content, adapter, genConfig, input.toolId, input.onStage, input.signal);
  }
  // T00818：把拆分出的问题清单内联回 PRD 正文「待确认问题汇总」章——分区 JSON 已被 splitPrdBody 剥离，
  // 正文该章原只有标题+审查说明占位，若不下沉，前端预览末章即「提示后内容为空」。仅在有清单时改写。
  const finalPrdMd = inlineIssuesSection(prdMd, issues);
  if (finalPrdMd !== prdMd) input.onStage(`已将 ${issues.length} 条待确认问题内联到 PRD 正文「待确认问题汇总」章（预览末章不再为空）`);
  input.onStage(`解析完成：PRD ${finalPrdMd.length} 字符、待确认问题 ${issues.length} 条（🔴 阻塞 ${issues.filter((i) => i.level === 'blocker').length} / 🟡 建议 ${issues.filter((i) => i.level === 'suggested').length} / 🟢 提示 ${issues.filter((i) => i.level === 'info').length}）`);
  // T00783-L3：startedAt 此前只 void 掉（死代码）——真实记录耗时，便于排查长耗时生成
  logService.log('INFO', 'ai', `[PRD生成] project=${input.projectId} file=${input.filename} prd=${finalPrdMd.length}ch issues=${issues.length} 耗时=${Date.now() - startedAt}ms`);
  const retrieveCoverageNote = retrieve.coverage ? `（${retrieve.coverage}）` : '';
  const retrieveValue = retrieve.block.length > 0 ? `${chars(retrieve.block.length)}${retrieveCoverageNote}` : '未命中';
  // T03262（AI-101①）：溯源行。上下文预算被裁过、需求被保头保尾压过、输出被截断过——
  // 三件事都会让「PRD 看起来完整但少了一段」，必须进面板而不是只留在 stage 日志里。
  const provenance = buildCardProvenance({
    cardKey: 'ai.prd_gen',
    sources: [
      { label: '原始需求', value: `${chars(input.content.length)}（${input.filename}）` },
      { label: '项目源码上下文', value: ws ? chars(ws.length) : '未配置工作空间（未使用）' },
      { label: 'Git 脉络', value: gitParts.length > 0 ? chars(gitParts.length) : '未使用' },
      { label: '检索片段', value: retrieveValue },
      { label: '产出', value: `${chars(finalPrdMd.length)}PRD、${issues.length} 条待确认问题` },
    ],
    truncations: [
      ...(requirement.length === input.content.length ? [] : [`原始需求超长，已保头保尾压缩为 ${chars(requirement.length)}`]),
      ...(parts.clipped.length > 0 ? [`上下文超总量预算，按优先级裁剪：${parts.clipped.join(' → ')}`] : []),
      ...(outputTruncated ? ['AI 输出触及上限，PRD 末尾可能不完整'] : []),
    ],
    model: genConfig.model ?? null,
  });
  recordCardProvenance(provenance, input.projectId);
  return { prdMd: finalPrdMd, issues, provenance };
}
