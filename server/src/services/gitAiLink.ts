/**
 * T03621：已完成视图「AI 智能关联」——用模型把「已完成但未回写」的任务与本仓库近期提交对上。
 *
 * 三条红线（与 §3.1.5 手动关联同口径）：
 *  1. **只读**：本服务只产出建议，不写 `task_git_links`；是否关联由用户在前端勾选确认，确认走的仍是
 *     `POST /tasks/:id/git/links`（source=manual）。
 *  2. **取数经白名单**：提交清单走 `queryGitLog`（gitCollect 只读子命令），不另起第二套 git 口径。
 *  3. **宁可漏不可错**：模型输出只是候选；服务端二次校验（sha 必须真在该仓库取到的清单里、confidence 阈值、
 *     同一提交只归一条任务），校验不过一律丢弃——「避免错误关联」优先于召回。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import { AIService } from './AIService';
import { queryGitLog } from './lectureGitLog';

export interface AiLinkCommitRef {
  sha: string;
  short: string;
  subject: string;
  date: string;
  author: string;
}

export interface AiLinkSuggestion {
  taskId: string;
  taskNo: string | null;
  taskTitle: string;
  confidence: number;
  reason: string;
  commits: AiLinkCommitRef[];
}

export interface AiLinkSuggestResult {
  ok: boolean;
  projectId?: string;
  projectName?: string;
  workspacePath?: string;
  /** 参与比对的规模，前端据此解释「为什么只有这几条建议」 */
  candidates?: { tasks: number; commits: number };
  suggestions: AiLinkSuggestion[];
  dropped?: number;
  kind?: string;
  message?: string;
  error?: string;
}

const DEFAULT_MAX_TASKS = 20;
const DEFAULT_MAX_COMMITS = 100;
const MAX_TASKS_LIMIT = 50;
const MAX_COMMITS_LIMIT = 200;
/** 低于该置信度的建议直接丢弃：宁可让人手动补，也不给「看起来很聪明」的错配 */
const MIN_CONFIDENCE = 0.5;

interface TaskRow {
  id: string;
  task_no: string | null;
  title: string;
  description: string | null;
  updated_at: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string | null;
}

const clampInt = (v: unknown, dflt: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(Math.max(n, 1), max);
};

/** 已完成 + 未归档 + 未搁置 + 尚无任何提交关联的任务（与前端 `unlinkedDone` 同一判据） */
function loadUnlinkedDoneTasks(projectId: string, limit: number): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.task_no, t.title, t.description, t.updated_at
         FROM tasks t
        WHERE t.project_id = ?
          AND t.status = 'done'
          AND COALESCE(t.archived, 0) = 0
          AND COALESCE(t.shelved, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM task_git_links l WHERE l.task_id = t.id)
        ORDER BY t.updated_at DESC
        LIMIT ?`,
    )
    .all(projectId, limit) as TaskRow[];
}

/** 已关联过的提交不再参与建议（同一提交重复推荐只会让人误以为漏关联） */
function linkedShasOf(shas: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!shas.length) return out;
  const db = getDb();
  const stmt = db.prepare('SELECT DISTINCT sha FROM task_git_links WHERE sha = ?');
  for (const sha of shas) {
    const row = stmt.get(sha) as { sha: string } | undefined;
    if (row) out.add(row.sha);
  }
  return out;
}

function buildSystemPrompt(): string {
  return [
    '你是代码提交与任务记录的匹配助手。输入是「已完成但尚未回写提交」的任务清单，以及该仓库最近的提交清单。',
    '请只做有证据的匹配：提交信息里出现任务编号，或提交主题/正文与任务标题及描述的主题高度一致时才配对。',
    '宁缺勿错：没有把握的提交不要配给任何任务，宁可返回空数组。',
    '只输出 JSON 数组，不要代码块、不要解释。元素形如：',
    '{"task": 任务序号(整数), "commits": ["提交短 SHA 前缀(至少 7 位)"], "confidence": 0~1 的小数, "reason": "不超过 30 字的中文依据"}',
    '同一条提交只能出现在一个元素里；task 序号必须来自给定的任务清单。',
  ].join('\n');
}

function buildUserPrompt(tasks: TaskRow[], commits: AiLinkCommitRef[]): string {
  const taskLines = tasks.map((t, i) => {
    const desc = (t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${i + 1}. [${t.task_no ?? '无编号'}] ${t.title}${desc ? `｜${desc}` : ''}`;
  });
  const commitLines = commits.map((c) => `- ${c.short}｜${c.date.slice(0, 10)}｜${c.subject}`);
  return [
    '【已完成未回写任务】',
    ...taskLines,
    '',
    '【仓库最近提交】',
    ...commitLines,
    '',
    '请输出 JSON 数组。',
  ].join('\n');
}

/** 解析模型输出：容忍 ``` 围栏与前后废话，但结构不对就抛错（由 askJson 触发一次重试） */
export function parseSuggestions(raw: string): unknown[] {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('输出中没有 JSON 数组');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('输出不是 JSON 数组');
  return arr;
}

/**
 * 服务端二次校验：模型给的只是「候选」，能落地的才留。
 * 纯函数（无 DB/无 git），门脚本可直接喂合成数据跑边界：非法 sha、前缀歧义、低置信度、越界序号、一提交多单认领。
 */
export function materializeSuggestions(
  tasks: readonly { id: string; task_no: string | null; title: string }[],
  commits: readonly AiLinkCommitRef[],
  raw: readonly unknown[],
): { suggestions: AiLinkSuggestion[]; dropped: number } {
  const bySha = new Map<string, AiLinkCommitRef>();
  for (const c of commits) bySha.set(c.sha, c);
  const resolveSha = (v: unknown): AiLinkCommitRef | null => {
    const p = String(v ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(p)) return null;
    const exact = bySha.get(p);
    if (exact) return exact;
    const hits = commits.filter((c) => c.sha.startsWith(p));
    return hits.length === 1 ? hits[0] : null; // 前缀歧义/查无此提交 → 丢
  };

  const claimed = new Map<string, { taskIdx: number; confidence: number }>();
  let dropped = 0;
  const perTask = new Map<number, { confidence: number; reason: string; commits: AiLinkCommitRef[] }>();
  for (const item of raw) {
    const rec = (item ?? {}) as { task?: unknown; commits?: unknown; confidence?: unknown; reason?: unknown };
    const idx = typeof rec.task === 'number' ? Math.trunc(rec.task) : NaN;
    if (!Number.isInteger(idx) || idx < 1 || idx > tasks.length) { dropped++; continue; }
    const confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? Math.max(0, Math.min(1, rec.confidence)) : 0;
    if (confidence < MIN_CONFIDENCE) { dropped++; continue; }
    const shas = Array.isArray(rec.commits) ? rec.commits : [];
    const resolved: AiLinkCommitRef[] = [];
    for (const s of shas) {
      const c = resolveSha(s);
      if (!c) { dropped++; continue; }
      const prev = claimed.get(c.sha);
      if (prev) {
        // 同一提交被多条任务认领：只保留置信度更高的那条，平手时保留先出现的
        if (prev.confidence >= confidence) { dropped++; continue; }
        const prevEntry = perTask.get(prev.taskIdx);
        if (prevEntry) prevEntry.commits = prevEntry.commits.filter((x) => x.sha !== c.sha);
        dropped++;
      }
      claimed.set(c.sha, { taskIdx: idx, confidence });
      resolved.push(c);
    }
    if (!resolved.length) continue;
    const entry = perTask.get(idx) ?? { confidence, reason: '', commits: [] };
    entry.confidence = Math.max(entry.confidence, confidence);
    const reason = String(rec.reason ?? '').trim().slice(0, 60);
    if (reason) entry.reason = reason;
    entry.commits = [...entry.commits, ...resolved.filter((r) => !entry.commits.some((x) => x.sha === r.sha))];
    perTask.set(idx, entry);
  }

  const suggestions: AiLinkSuggestion[] = [...perTask.entries()]
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .map(([idx, e]) => {
      const t = tasks[idx - 1];
      return {
        taskId: t.id,
        taskNo: t.task_no,
        taskTitle: t.title,
        confidence: Math.round(e.confidence * 100) / 100,
        reason: e.reason,
        commits: e.commits,
      };
    })
    .filter((s) => s.commits.length > 0);
  return { suggestions, dropped };
}

export async function suggestGitLinks(input: {
  projectId: string;
  toolId: string;
  maxTasks?: number;
  maxCommits?: number;
}, deps: { askJson?: typeof AIService.askJson } = {}): Promise<AiLinkSuggestResult> {
  const projectId = String(input.projectId ?? '').trim();
  if (!projectId) return { ok: false, suggestions: [], kind: 'denied', message: 'projectId 必填' };
  const db = getDb();
  const project = db
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return { ok: false, suggestions: [], kind: 'denied', message: '项目不存在或已归档（请刷新项目列表）' };
  const workspacePath = (project.workspace_path ?? '').trim();
  if (!workspacePath) {
    return { ok: false, projectId, projectName: project.name, suggestions: [], kind: 'no-workspace', message: '未配置工作空间路径（请先在项目管理中绑定仓库目录）' };
  }

  const maxTasks = clampInt(input.maxTasks, DEFAULT_MAX_TASKS, MAX_TASKS_LIMIT);
  const maxCommits = clampInt(input.maxCommits, DEFAULT_MAX_COMMITS, MAX_COMMITS_LIMIT);

  const tasks = loadUnlinkedDoneTasks(projectId, maxTasks);
  if (tasks.length === 0) {
    return { ok: true, projectId, projectName: project.name, workspacePath, candidates: { tasks: 0, commits: 0 }, suggestions: [], message: '没有「已完成但未回写提交」的任务，无需关联' };
  }

  const log = await queryGitLog({ projectId, limit: maxCommits, skip: 0 });
  if (!log.ok) {
    return { ok: false, projectId, projectName: project.name, workspacePath, suggestions: [], kind: log.error?.kind ?? 'git', message: log.error?.message ?? '提交清单取数失败' };
  }
  const linked = linkedShasOf(log.commits.map((c) => c.sha));
  const commits: AiLinkCommitRef[] = log.commits
    .filter((c) => !linked.has(c.sha))
    .map((c) => ({ sha: c.sha, short: c.short, subject: c.subject, date: c.date, author: c.author }));
  if (commits.length === 0) {
    return { ok: true, projectId, projectName: project.name, workspacePath, candidates: { tasks: tasks.length, commits: 0 }, suggestions: [], message: '近期提交都已关联到任务，没有待匹配的提交' };
  }

  const askJson = deps.askJson ?? AIService.askJson;
  const res = await askJson(
    input.toolId,
    buildSystemPrompt(),
    buildUserPrompt(tasks, commits),
    parseSuggestions,
    {
      // 结构化但不长：给足余量避免截断触发「精简重试」把配对又砍掉
      minMaxTokens: 2048,
      temperature: 0,
      timeoutMs: 120_000,
    },
  );
  if (!res.ok || !res.data) {
    return { ok: false, projectId, projectName: project.name, workspacePath, suggestions: [], kind: 'ai', error: res.error ?? 'AI 调用失败' };
  }

  const { suggestions, dropped } = materializeSuggestions(tasks, commits, res.data);

  return {
    ok: true,
    projectId,
    projectName: project.name,
    workspacePath,
    candidates: { tasks: tasks.length, commits: commits.length },
    suggestions,
    dropped,
    ...(suggestions.length === 0 ? { message: 'AI 未能找到有把握的匹配，可改用「手动关联」逐条补录' } : {}),
  };
}
