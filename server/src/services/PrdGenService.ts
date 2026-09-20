import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getDb } from '../db/connection';
import { getAdapter, type AIAdapter, type ToolConfig } from '../adapters';
import { ConfigService } from './ConfigService';
import { PlanService } from './PlanService';
import { logService } from './LogService';
import { ContextBudget, WorkspaceService, loadIgnoreRules, isIgnored } from './WorkspaceService';
import { stripThinking } from '../util/thinking'; // T00814：解析问题清单前剔除思考块
import { parseIssuesJson, parsePrdIssues, splitPrdBody, type PrdGenIssue } from './prdIssues'; // T00814：问题清单解析抽为可测模块

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

/** 项目源码上下文：目录树（忽略构建/依赖目录）+ README/package.json 片段。读取失败返回空串（跳过并注明）。 */
export function loadWorkspaceContext(workspacePath: string): string {
  if (!workspacePath) return '';
  try {
    statSync(workspacePath);
  } catch {
    return '';
  }
  const tree: string[] = [];
  const rules = loadIgnoreRules(workspacePath); // M-4：与文件搜索共用同一忽略规则源（含 .mtaskignore），消除双轨
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 3 || tree.length >= TREE_LIMIT) return;
    let entries: Array<{ name: string; isDir: boolean; relChild: string }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDir: e.isDirectory(), relChild: rel ? `${rel}/${e.name}` : e.name }))
        .filter((e) => !isIgnored(e.relChild, e.isDir, rules) && !e.name.startsWith('.'))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir));
    } catch {
      return;
    }
    for (const e of entries) {
      if (tree.length >= TREE_LIMIT) { tree.push('…（超出采样上限，已截断）'); return; }
      tree.push(`${'  '.repeat(depth)}${e.isDir ? '[目录] ' : ''}${e.name}`);
      if (e.isDir) walk(join(dir, e.name), e.relChild, depth + 1);
    }
  };
  walk(workspacePath, '', 0);
  const parts = [`项目目录树（深度 3，最多 ${TREE_LIMIT} 项）：\n${tree.join('\n')}`];
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

export type { PrdGenIssue }; // T00814：类型定义随解析模块迁移

/**
 * 流式生成 PRD：内置技能 prompt + 原始需求 + 项目上下文 → adapter.chatStream。
 * onStage 推阶段日志、onDelta 推正文增量；完成后按 <<<PRD>>>/<<<ISSUES>>> 协议解析。
 */
/** 检索增强：按需求关键词搜索代码，注入 top 片段；失败不阻塞主流程（返回空串） */
function buildRetrieveBlock(
  project: { workspace_path: string | null },
  input: { projectId: string; content: string; onStage: (msg: string) => void },
): string {
  if (!project.workspace_path) return '';
  try {
    const stat = WorkspaceService.refreshSymbols(input.projectId);
    input.onStage(`符号索引刷新：文件 ${stat.files} 个、符号 ${stat.symbols} 个（未变跳过 ${stat.skipped}）`);
    const kws = WorkspaceService.extractKeywords(input.content);
    const block = WorkspaceService.autoContext(input.projectId, kws);
    input.onStage(block ? `检索增强：按关键词 [${kws.slice(0, 6).join(', ')}] 命中代码片段已注入上下文` : '检索增强：无命中片段，跳过注入');
    return block;
  } catch { return ''; /* 检索增强失败不阻塞主流程 */ }
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
  onStage: (msg: string) => void,
): Promise<PrdGenIssue[]> {
  onStage('未解析到待确认问题 —— 发起一次补充提问（基于已生成 PRD 反推待确认项）…');
  const system = '你是资深需求分析师。只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。';
  const user = [
    `【目标项目】${project.name}`,
    '【已生成的 PRD 摘要】\n' + ContextBudget.headTail(prdMd, 4000, 'PRD '),
    '【原始需求片段】\n' + ContextBudget.headTail(source, 2000, '需求 '),
    '请基于上述 PRD 与原始需求，列出 5~10 条仍需与业务方确认的问题（缺失即阻塞落地的关键信息）。',
    '输出格式：[{"level":"blocker|suggested|info","question":"…","context":"…"}]',
    'level 语义：blocker=不确认无法开工；suggested=影响方案选择；info=补充说明。',
  ].join('\n\n');
  try {
    const r = await adapter.chat(system, user, config);
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
}): Promise<{ prdMd: string; issues: PrdGenIssue[] }> {
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

  // T00769 验证失败修复：工作空间状态显式检测 + 友好提示（未绑定/不可读都能在控制台看到可操作指引）
  const wsStatus = workspaceStage(project.workspace_path);
  if (!wsStatus.ok) input.onStage(wsStatus.msg);

  input.onStage('加载项目源码上下文…');
  const ws = loadWorkspaceContext(project.workspace_path ?? '');
  input.onStage(ws ? '项目源码上下文已加载（目录树 + 说明文件片段）' : '跳过源码上下文（工作空间未绑定或不可读）');

  const retrieveBlock = buildRetrieveBlock(project, input);

  input.onStage(`原始需求文本提取完成：${input.filename}（${input.content.length} 字符），开始 AI 生成…`);

  // T00769 验证失败修复：把「必须输出待确认问题清单」写成硬约束，避免无上下文时模型只写正文不产问题
  const ISSUE_RULE = [
    '【输出硬性要求（务必遵守）】',
    '1. 先输出完整 PRD 正文；',
    '2. 正文结束后另起一行输出分隔符 <<<ISSUES>>>，其后紧跟 JSON 数组，列出 5~10 条待确认问题；',
    '3. 每条格式：{"level":"blocker|suggested|info","question":"…","context":"…"}；',
    '4. 即使项目源码上下文缺失，也必须基于原始需求本身列出阻塞落地的关键未知项，不得省略该 JSON 段。',
    // T00814：长文档实测会在 8K 输出上限处被截断，导致整份 PRD 作废；这里给出篇幅边界，
    // 把预算花在变更点/字段/验收标准上，而不是无节制铺陈
    '5. 篇幅控制：PRD 正文不超过 6000 字，聚焦「变更点、字段清单、业务规则、验收标准、影响面」；不要复述原始需求全文，不要输出目录。',
  ].join('\n');

  const system = `${skill}\n\n# 三角色审查规则库（审查时逐条对照）\n${rules}`;
  const user = [
    `【目标项目】${project.name}`,
    ws ? `【项目源码上下文】\n${ws}` : '【项目源码上下文】未提供（未配置工作空间）',
    retrieveBlock ? `【工作空间检索片段（T00777 自动检索）】\n${retrieveBlock}` : '',
    `【原始需求文件】${input.filename}`,
    `【原始需求全文】\n${input.content}`,
    ISSUE_RULE,
  ].filter(Boolean).join('\n\n');

  let result = await adapter.chatStream(system, user, genConfig, input.onDelta);
  // T00814：个别提供商不接受 16K 输出上限（请求直接 400）——此时回退到 8K 重试一次，
  // 避免"提高了预算反而整个功能不可用"。仅在错误文本确指 max_tokens 时回退，其余错误照旧抛出。
  if (!result.ok && /max_tokens|max_completion_tokens|too large|invalid/i.test(result.error ?? '')) {
    input.onStage(`模型未接受 ${genConfig.maxTokens} tokens 输出上限，回退 ${PRD_FALLBACK_OUTPUT_TOKENS} 重试…`);
    result = await adapter.chatStream(system, user, { ...genConfig, maxTokens: PRD_FALLBACK_OUTPUT_TOKENS }, input.onDelta);
  }
  // T00814：长文档实测即使预算给到 16K/32K，部分思考型模型仍会在自身上限处截断
  // （流出的正文 9~10K 字符即 finish_reason=length）。此时整份作废太浪费 ——
  // 改为「保留已生成部分 + 显式告警」，问题清单随后由补问兜底；其它失败仍原样抛出。
  let text = '';
  if (result.ok) {
    text = result.content ?? '';
  } else if (result.partial && /超长被截断/.test(result.error ?? '')) {
    text = result.partial;
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
    issues = await fallbackIssues(project, prdMd, input.content, adapter, genConfig, input.onStage);
  }
  input.onStage(`解析完成：PRD ${prdMd.length} 字符、待确认问题 ${issues.length} 条（🔴 阻塞 ${issues.filter((i) => i.level === 'blocker').length} / 🟡 建议 ${issues.filter((i) => i.level === 'suggested').length} / 🟢 提示 ${issues.filter((i) => i.level === 'info').length}）`);
  // T00783-L3：startedAt 此前只 void 掉（死代码）——真实记录耗时，便于排查长耗时生成
  logService.log('INFO', 'ai', `[PRD生成] project=${input.projectId} file=${input.filename} prd=${prdMd.length}ch issues=${issues.length} 耗时=${Date.now() - startedAt}ms`);
  return { prdMd, issues };
}
