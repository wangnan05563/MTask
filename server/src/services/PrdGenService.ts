import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getDb } from '../db/connection';
import { getAdapter } from '../adapters';
import { ConfigService } from './ConfigService';
import { PlanService } from './PlanService';
import { logService } from './LogService';
import { ContextBudget, WorkspaceService, loadIgnoreRules, isIgnored } from './WorkspaceService';

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

export interface PrdGenIssue { level: string; question: string; context: string }

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

/** 解析 AI 输出中的待确认问题清单：优先 <<<ISSUES>>> JSON 协议，回退从正文「待确认问题汇总」节提取（level 默认 info） */
function parsePrdIssues(text: string, prdMd: string, onStage: (msg: string) => void): PrdGenIssue[] {
  const sep = text.indexOf('<<<ISSUES>>>');
  if (sep >= 0) {
    try {
      const raw = JSON.parse(text.slice(sep + '<<<ISSUES>>>'.length).trim()) as Array<Partial<PrdGenIssue>>;
      if (Array.isArray(raw)) {
        const issues = raw
          .filter((x) => typeof x.question === 'string' && x.question.trim())
          .map((x) => ({
            level: ['blocker', 'suggested', 'info'].includes(String(x.level)) ? String(x.level) : 'info',
            question: String(x.question).trim(),
            context: typeof x.context === 'string' ? x.context.trim() : '',
          }));
        if (issues.length > 0) return issues;
      }
    } catch {
      onStage('问题清单 JSON 协议解析失败，回退从 PRD 正文「待确认问题汇总」节提取…');
    }
  }
  // 回退提取：模型未按 JSON 协议输出时，从主文档「待确认问题汇总」节的列表项提取
  const m = /#+\s*待确认问题汇总?\s*\n([\s\S]*)$/.exec(prdMd);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*(?:[-*]|\d+[.、])\s*(.+)$/gm)]
    .map((x) => x[1].replaceAll('**', '').trim())
    .filter((q) => q.length > 4 && !q.startsWith('---'))
    .slice(0, 20)
    .map((q) => ({ level: 'info', question: q, context: '' }));
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

  input.onStage('加载内置技能「prd-generate」（原 bemp-generate-prd 已转内置）…');
  const SKILL_DIR = skillDir();
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const rules = (['bill-business-rules', 'compliance-rules', 'ux-rules'] as const)
    .map((n) => {
      const refMd = `${n}.md`;
      return `\n<!-- references/${n}.md -->\n${readFileSync(join(SKILL_DIR, 'references', refMd), 'utf8')}`;
    })
    .join('\n');

  input.onStage('加载项目源码上下文…');
  const ws = loadWorkspaceContext(project.workspace_path ?? '');
  input.onStage(ws ? '项目源码上下文已加载（目录树 + 说明文件片段）' : '未配置工作空间或目录不可读，跳过源码上下文');

  const retrieveBlock = buildRetrieveBlock(project, input);

  input.onStage(`原始需求文本提取完成：${input.filename}（${input.content.length} 字符），开始 AI 生成…`);

  const system = `${skill}\n\n# 三角色审查规则库（审查时逐条对照）\n${rules}`;
  const user = [
    `【目标项目】${project.name}`,
    ws ? `【项目源码上下文】\n${ws}` : '【项目源码上下文】未提供（未配置工作空间）',
    retrieveBlock ? `【工作空间检索片段（T00777 自动检索）】\n${retrieveBlock}` : '',
    `【原始需求文件】${input.filename}`,
    `【原始需求全文】\n${input.content}`,
  ].filter(Boolean).join('\n\n');

  const result = await adapter.chatStream(system, user, config, input.onDelta);
  if (!result.ok) throw new Error(result.error ?? 'AI 生成失败');

  input.onStage('AI 生成完成，解析待确认问题清单…');
  const text = result.content ?? '';
  const sep = text.indexOf('<<<ISSUES>>>');
  const prdMd = (sep >= 0 ? text.slice(0, sep) : text).replace(/<<<PRD>>>\s*/, '').trim();
  const issues = parsePrdIssues(text, prdMd, input.onStage);
  input.onStage(`解析完成：PRD ${prdMd.length} 字符、待确认问题 ${issues.length} 条（🔴 阻塞 ${issues.filter((i) => i.level === 'blocker').length} / 🟡 建议 ${issues.filter((i) => i.level === 'suggested').length} / 🟢 提示 ${issues.filter((i) => i.level === 'info').length}）`);
  // T00783-L3：startedAt 此前只 void 掉（死代码）——真实记录耗时，便于排查长耗时生成
  logService.log('INFO', 'ai', `[PRD生成] project=${input.projectId} file=${input.filename} prd=${prdMd.length}ch issues=${issues.length} 耗时=${Date.now() - startedAt}ms`);
  return { prdMd, issues };
}
