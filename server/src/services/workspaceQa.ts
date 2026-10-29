/**
 * T03250（PRD 5.1）：工作空间只读问答。
 *
 * 回答必须带 `file:line` 引用，且引用要能真正跳转——所以引用不是「模型说了算」：
 * 服务端先按问题关键词从现成证据源取片段（符号索引 `workspace_symbols` + 全文检索），
 * 模型只允许在给定片段范围内作答；回答里的 `[path:line]` 再逐条回到证据集合校验，
 * 不在证据里的引用直接丢弃（宁少不假）。
 *
 * 只读红线：取数只走 WorkspaceService.search/readFile/symbolMatches（同一套路径防穿越 + 忽略规则），
 * 本服务不写文件、不建索引、不改任务数据。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import { AIService } from './AIService';
import { WorkspaceService } from './WorkspaceService';

export interface QaEvidence {
  path: string;
  line: number;
  text: string;
  symbol?: string;
}

export interface QaCitation {
  path: string;
  line: number;
  symbol?: string;
}

export interface WorkspaceAskResult {
  ok: boolean;
  answer?: string;
  citations: QaCitation[];
  /** 送进模型的证据条数（0 表示没检索到可用片段，此时不应让模型硬答） */
  evidenceCount: number;
  keywords: string[];
  /** 上下文是否因预算被截断（T03251 要求「超预算明示截断」） */
  truncated: boolean;
  contextChars: number;
  kind?: string;
  message?: string;
  error?: string;
}

/** 单次问答的上下文预算（字符）：够放十几个片段，又不会把长回答顶出模型窗口 */
export const QA_CONTEXT_LIMIT = 12_000;
/** 送模型的片段条数上限（符号命中 + 全文命中合计） */
export const QA_EVIDENCE_LIMIT = 14;
/** 单条片段送模型的字符上限：长行（压缩产物/大表）不整行塞进去，超出即算截断 */
export const QA_ROW_LIMIT = 400;

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string | null;
}

const normPath = (p: string): string => p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * 取证据：先符号（密度高、定位准），再全文（补注释/字符串里的说法），按 `path:line` 去重，
 * 每个片段从文件里回读一行真实文本（检索片段可能是整行截断，符号只有位置）。
 */
export function collectEvidence(projectId: string, question: string): { evidence: QaEvidence[]; keywords: string[]; truncated: boolean; contextChars: number } {
  const keywords = WorkspaceService.extractKeywords(question).slice(0, 8);
  const picked: QaEvidence[] = [];
  const seen = new Set<string>();
  const push = (e: QaEvidence) => {
    const key = `${normPath(e.path)}:${e.line}`;
    if (seen.has(key) || picked.length >= QA_EVIDENCE_LIMIT) return;
    seen.add(key);
    picked.push({ ...e, path: normPath(e.path) });
  };

  let truncated = false;

  if (keywords.length > 0) {
    for (const hit of WorkspaceService.symbolMatches(projectId, keywords, 6)) {
      push({ path: hit.path, line: hit.line, text: '', symbol: hit.symbol });
    }
    // 全文检索最多打前 3 个关键词：每个词条数太多会把符号命中挤掉
    for (const kw of keywords.slice(0, 3)) {
      try {
        const hits = WorkspaceService.search(projectId, kw);
        if (hits.partial === true) truncated = true;
        for (const h of hits.slice(0, 5)) {
          if (h.line <= 0) continue; // 文件名命中没有行号，做不了可跳转引用
          push({ path: h.path, line: h.line, text: h.snippet });
        }
      } catch { /* 关键词太短/非法：跳过该词，不影响其它证据 */ }
    }
  }

  // 回读真实行文本：符号命中只有位置，检索 snippet 可能被截断；回读失败（文件已删）就丢弃该片段
  const resolved: QaEvidence[] = [];
  let used = 0;
  for (const e of picked) {
    let text = e.text;
    if (!text.trim()) {
      try {
        const f = WorkspaceService.readFile(projectId, e.path, Math.max(0, e.line - 1), 1);
        text = f.lines[0]?.text ?? '';
      } catch { continue; }
    }
    const full = text.trim();
    if (full.length > QA_ROW_LIMIT) truncated = true;
    const rowText = full.slice(0, QA_ROW_LIMIT);
    const row = `${e.path}:${e.line}: ${rowText}`;
    if (used + row.length > QA_CONTEXT_LIMIT) { truncated = true; break; }
    used += row.length + 1;
    resolved.push({ ...e, text: rowText });
  }

  return { evidence: resolved, keywords, truncated, contextChars: used };
}

export function buildSystemPrompt(): string {
  return [
    '你是代码库问答助手，只能依据用户消息里给出的「代码片段」作答。',
    '规则：',
    '1. 每条结论后面用 [相对路径:行号] 标注依据，行号必须取自片段标记，不得编造；',
    '2. 片段不足以回答时直接说明「工作空间里没有找到相关依据」，不要靠通用知识补全；',
    '3. 不要输出与问题无关的代码，回答尽量简短（≤200 字）；',
    '4. 只读：不要建议直接改仓库文件。',
  ].join('\n');
}

export function buildUserPrompt(question: string, evidence: readonly QaEvidence[]): string {
  const blocks = evidence.map((e) => `【${e.path}:${e.line}】${e.symbol ? `（符号 ${e.symbol}）` : ''}\n${e.text}`);
  return [`问题：${question}`, '', '代码片段：', ...blocks, '', '请按规则作答，并为每条结论标注 [路径:行号]。'].join('\n');
}

/**
 * 从回答里抽引用并与证据集合核对。
 * 支持 `[path:line]`（首选格式）与裸写 `path.ext:line` 两种；路径不在证据里的引用一律丢弃。
 */
export function parseCitations(answer: string, evidence: readonly QaEvidence[]): QaCitation[] {
  const byPath = new Map<string, Set<number>>();
  for (const e of evidence) {
    const p = normPath(e.path);
    const set = byPath.get(p) ?? new Set<number>();
    set.add(e.line);
    byPath.set(p, set);
  }
  const out: QaCitation[] = [];
  const seen = new Set<string>();
  const add = (rawPath: string, rawLine: string) => {
    const p = normPath(rawPath.trim());
    const line = Number(rawLine);
    if (!Number.isInteger(line) || line < 1) return;
    const lines = byPath.get(p);
    // 行号必须落在该文件被引用的证据行上（模型常见错误是「文件对了、行号随手写」）
    if (!lines || !lines.has(line)) return;
    const key = `${p}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ev = evidence.find((e) => normPath(e.path) === p && e.line === line);
    out.push({ path: p, line, ...(ev?.symbol ? { symbol: ev.symbol } : {}) });
  };
  for (const m of answer.matchAll(/\[([^\]\s:]+(?:\/[^\]\s:]+)*|\S+?\.\w+):(\d{1,6})\]/g)) add(m[1], m[2]);
  for (const m of answer.matchAll(/(?:^|[\s(（])([\w./-]+\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|cs|cpp|c|h|sql|md|json|yml|yaml)):(\d{1,6})\b/g)) add(m[1], m[2]);
  return out;
}

export async function askWorkspace(
  input: { projectId: string; question: string; toolId: string },
  deps: { ask?: typeof AIService.ask } = {},
): Promise<WorkspaceAskResult> {
  const projectId = String(input.projectId ?? '').trim();
  const question = String(input.question ?? '').trim();
  const base = { citations: [] as QaCitation[], evidenceCount: 0, keywords: [] as string[], truncated: false, contextChars: 0 };
  if (!projectId) return { ok: false, ...base, kind: 'denied', message: 'projectId 必填' };
  if (question.length < 2) return { ok: false, ...base, kind: 'denied', message: '问题至少 2 个字符' };
  const project = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return { ok: false, ...base, kind: 'denied', message: '项目不存在或已归档（请刷新项目列表）' };
  const workspace = (project.workspace_path ?? '').trim();
  if (!workspace) return { ok: false, ...base, kind: 'no-workspace', message: '该项目未绑定工作空间——请先在项目上绑定仓库目录再提问' };

  const { evidence, keywords, truncated, contextChars } = collectEvidence(projectId, question);
  const shell = { keywords, truncated, contextChars, evidenceCount: evidence.length };
  if (evidence.length === 0) {
    return { ok: true, ...shell, citations: [], message: '工作空间里没有检索到与该问题相关的代码片段（可换用更具体的标识符/文件名再问）', answer: '工作空间里没有找到相关依据。' };
  }

  const ask = deps.ask ?? AIService.ask;
  const system = buildSystemPrompt();
  const user = buildUserPrompt(question, evidence);
  const first = await ask(input.toolId, system, user, 120_000);
  if (!first.ok) return { ok: false, ...shell, citations: [], kind: 'ai', error: first.error ?? 'AI 调用失败' };

  let answer = (first.content ?? '').trim();
  let citations = parseCitations(answer, evidence);
  if (citations.length === 0) {
    // 没引用 = 回答不可核验：按「只给片段」再收紧一次，而不是把无依据的回答当真
    const stricter = [
      system,
      '5. 上一轮回答缺少可核验的引用。这一次必须至少给出一条 [相对路径:行号]，行号取自片段标记；做不到就只回答「工作空间里没有找到相关依据」。',
    ].join('\n');
    const second = await ask(input.toolId, stricter, user, 120_000);
    if (second.ok) {
      answer = (second.content ?? '').trim();
      citations = parseCitations(answer, evidence);
    }
  }
  return {
    ok: true,
    ...shell,
    answer,
    citations,
    ...(citations.length === 0 ? { message: '回答未给出可核验的 file:line 引用——不展示为结论，建议换更具体的问法' } : {}),
  };
}
