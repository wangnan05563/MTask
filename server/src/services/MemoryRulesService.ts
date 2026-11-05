import { getDb } from '../db/connection';
import { isMemoryType, type MemoryType } from '../util/memoryTypes';
import { normalizeProductKey } from '../util/productKey';
import { detectPiiKind, guardMemoryCandidate, type MemorySourceKind } from '../util/memoryGuard';
import { applyRewriteBudget } from '../util/memoryRewrite'; // T04145：W1-W8 重写限次

/**
 * T04144（PRD MEM-202 / MEM-203 / MEM-206；规范 §3.3 / §6 / §8 / §9）：六段流程的规则引擎。
 *
 * 设计要点：`askJson` 由调用方注入——真实运行时走 AIService.askJson，隔离验证可注入 mock，
 * 因此「三段分区 / C1-C3 代码强制 / 四动作 / dropped[]」无需 AI 实配也能端到端断言。
 * 提示词只是第一道，never-store 与限流/阈值必须由代码兜底（规范 §6.1 原则）。
 */

/** C2：单次任务回传最多落 5 条（超出部分进 dropped） */
export const MAX_MEMORIES_PER_RESULT = 5;
/** C3：置信度低于 0.7 不入库（记 dropped，不静默） */
export const MIN_CONFIDENCE = 0.7;
/** 大块原文剥离：单条内容长度上限（中文约 120 字 × 2 字节余量） */
export const MAX_CONTENT_CHARS = 400;

/** 规范 §9 的 system prompt 常量（六段流程 + Q1-Q7 + W1-W8 + 严格 JSON 输出） */
export const EXTRACTION_SYSTEM_PROMPT = `你是 MTask 记忆提取器。输入是一份技术任务处理结论（Markdown）与既有记忆列表，输出应当被长期记住的结构化记忆。
# 第一步：准入判定（逐条独立，任一否决即丢弃）
Q1 行为改变 / Q2 仍真仍有用 / Q3 不可秒查 / Q4 具体可执行 / Q5 带理由 / Q6 稳定或有期 / Q7 安全可存。
# 第二步：动作判定
ADD（无同义无矛盾）/ UPDATE（表达同一事实且新增专名·数字·版本·路径·命令、触发条件、决策理由或失效边界，沿用既有 id）/ INVALIDATE（输出 invalidated_ids，不物理删除）/ NOOP。
# 第三步：写法规则
W1 一事一条 / W2 自足 / W3 保真具体 / W4 时间锚定到 now / W5 数值精确 / W6 语义精确 / W7 变更留痕 / W8 长度 30-120 字。
# 第四步：禁止项
不得编造、不得推断未明说属性、不得把请求本身抽成记忆、不得搬运既有记忆细节、不得输出语义等价的两条、不得输出解释文字。
# 输出格式（严格 JSON，无 Markdown 包裹）
{"memories":[{"action":"ADD|UPDATE|NOOP","id":"UPDATE 时填既有 id","invalidated_ids":["被否证 id"],"title":"≤20 字","content":"完整自足陈述句","type":"user|feedback|project|reference","tags":["≤5 个"],"confidence":0.0,"source_kind":"auto|manual|user_said|tool_output|inferred","project_id":null}],"dropped":[{"title":"被丢弃候选","reason":"Q1-Q7 编号或禁止项名称"}]}`;

/** 规范 §3.3：仅「根因 / 修复 / 验证」三段参与抽取；建议段（待办）默认不抽取，段缺失跳过不报错。 */
const EXTRACT_SECTIONS = ['根因', '修复', '验证'];
export interface ResultSection { title: string; body: string }
export function splitResultSections(text: string): { sections: ResultSection[]; skipped: string[] } {
  const lines = String(text ?? '').split(/\r?\n/);
  const sections: ResultSection[] = [];
  const skipped: string[] = [];
  let cur: ResultSection | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { title: m[1].replace(/（可选）|\(可选\)/g, '').trim(), body: '' };
      if (EXTRACT_SECTIONS.includes(cur.title)) sections.push(cur);
      else skipped.push(cur.title);
      continue;
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + line;
  }
  return { sections: sections.filter((s) => s.body.trim()), skipped };
}

/** C1：正则 + 字段名黑名单，返回命中类别（用于 dropped 原因），未命中返回 null。 */
const NEVER_STORE_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'credential', re: /(?:api[_-]?key|token|password|passwd|secret|cookie|authorization)\s*[:=]\s*\S+/i },
  // T04159（规范 §10.3 断言①）：`Bearer ` 是独立敏感形态（HTTP 头里不带冒号/等号），
  // 旧规则把它绑在 `[:=]` 后，实测 `Bearer eyJ...` 全部漏拦。sk- 前缀同理放宽到 6 位以上（含 -/_）。
  { tag: 'credential', re: /\bbearer\s+[A-Za-z0-9\-._~+/]{6,}/i },
  { tag: 'credential', re: /\b(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{6,}\b/ },
  { tag: 'connection_string', re: /(?:postgres|mysql|redis|mongodb|amqp):\/\/[^\s:]+:[^\s@]+@/i },
  { tag: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
const FIELD_BLACKLIST = ['api_key_enc', 'secret_enc', 'password_hash', 'auth_token', 'cookie', 'authorization'];
export function containsNeverStore(text: string): string | null {
  for (const { tag, re } of NEVER_STORE_PATTERNS) if (re.test(text)) return tag;
  const lower = text.toLowerCase();
  for (const f of FIELD_BLACKLIST) if (lower.includes(f)) return `field:${f}`;
  return null;
}

export interface ExtractCandidate {
  action?: 'ADD' | 'UPDATE' | 'NOOP';
  id?: string;
  invalidated_ids?: string[];
  title: string;
  content: string;
  type: string;
  tags?: string[];
  confidence: number;
  source_kind?: string;
  project_id?: string | null;
}
export interface RulesOutput {
  memories: ExtractCandidate[];
  dropped?: { title: string; reason: string }[];
}
/** 可注入的模型调用：真实运行时由 MemoryService 包 AIService.askJson，验证时注入 mock。 */
export type AskJsonFn = (system: string, user: string) => Promise<RulesOutput>;

export function buildExtractionUserPrompt(
  sections: ResultSection[],
  existing: { id: string; title: string; content: string; type: string }[],
  now: string,
): string {
  return [
    `# 结论分区（仅以下三段，建议段已剥离）`,
    ...sections.map((s) => `## ${s.title}\n${s.body.trim()}`),
    `# 既有记忆（用于 ADD/UPDATE/INVALIDATE 判定）`,
    JSON.stringify(existing),
    `# 时间锚点 now（相对时间一律换算成基于它的绝对日期）`,
    now,
  ].join('\n\n');
}

export interface RulesRunResult {
  stored: number; queued: number; updated: number; invalidated: number;
  dropped: { title: string; reason: string }[];
  skippedSections: string[];
  noExtractableSection: boolean;
  /** T04145：本轮写法校验实际触发的重写次数（0 或 1） */
  rewrites: number;
}

const SOURCE_KINDS: readonly string[] = ['auto', 'manual', 'user_said', 'tool_output', 'inferred'];

/** 六段流程执行：分区 → askJson（准入/动作/写法）→ C1/C2/C3 代码兜底 → PII 队列 → 落库 + dropped。 */
export async function runRulesExtraction(args: {
  taskId: string;
  resultText: string;
  productKey: string;
  projectId?: string;
  askJson: AskJsonFn;
  now?: string;
  /** T04145（MEM-208）：写法违规时的重写通道，最多调用 1 次；不传则跳过写法校验（兼容既有调用） */
  rewrite?: (violations: { index: number; item: ExtractCandidate; rules: string[] }[]) =>
    Promise<{ index: number; item: ExtractCandidate }[]>;
}): Promise<RulesRunResult> {
  const db = getDb();
  const pk = normalizeProductKey(args.productKey);
  const now = args.now ?? new Date().toISOString();
  const { sections, skipped } = splitResultSections(args.resultText);
  const base: RulesRunResult = {
    stored: 0, queued: 0, updated: 0, invalidated: 0, dropped: [], skippedSections: skipped,
    noExtractableSection: sections.length === 0, rewrites: 0,
  };
  // 段缺失时跳过而非报错（MEM-206）；也顺带保证幂等（同 source_task_id 已有记忆不重抽）
  if (base.noExtractableSection) return base;
  if (db.prepare('SELECT 1 FROM memories WHERE source_task_id = ? LIMIT 1').get(args.taskId)) {
    base.dropped.push({ title: args.taskId, reason: 'MEM-207 幂等跳过' });
    return base;
  }

  const existing = db.prepare(`SELECT id, title, content, type FROM memories
    WHERE product_key = ? AND invalidated_at IS NULL ORDER BY updated_at DESC LIMIT 50`).all(pk) as
    { id: string; title: string; content: string; type: string }[];
  const out = await args.askJson(EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt(sections, existing, now));
  const candidates = Array.isArray(out?.memories) ? out.memories : [];
  const dropped = [...(Array.isArray(out?.dropped) ? out.dropped : [])];

  // C2：写入限流，超出 5 条的部分显式记 dropped（不静默截断）
  for (const extra of candidates.slice(MAX_MEMORIES_PER_RESULT)) {
    dropped.push({ title: extra?.title ?? '', reason: 'C2 单任务上限 5 条' });
  }
  // T04145：写法校验 + 最多 1 次重写（不传 rewrite 时保持既有行为，T04144 的门断言不受影响）
  let loopItems = candidates.slice(0, MAX_MEMORIES_PER_RESULT).map((c, i) => ({ c, i }));
  if (args.rewrite) {
    const rb = await applyRewriteBudget(
      candidates.slice(0, MAX_MEMORIES_PER_RESULT),
      args.rewrite,
    );
    base.rewrites = rb.rewrites;
    for (const d of rb.dropped) dropped.push(d);
    loopItems = rb.accepted.map((a) => ({ c: a.item, i: a.index }));
  }
  for (const { c, i } of loopItems) {
    const title = String(c?.title ?? '').trim();
    const content = String(c?.content ?? '').trim();
    if (!title || !content) { dropped.push({ title, reason: '空标题/空内容' }); continue; }
    if (c.action === 'NOOP') { dropped.push({ title, reason: 'NOOP' }); continue; }
    // C1：never-store 代码强制（模型自检不可靠）
    const bad = containsNeverStore(`${title} ${content}`);
    if (bad) { dropped.push({ title, reason: `C1 never-store:${bad}` }); continue; }
    // C3：置信度阈值
    if (!(Number(c.confidence) >= MIN_CONFIDENCE)) { dropped.push({ title, reason: `C3 置信度<${MIN_CONFIDENCE}` }); continue; }
    if (!isMemoryType(c.type)) { dropped.push({ title, reason: 'type 非法枚举' }); continue; }
    if (content.length > MAX_CONTENT_CHARS) { dropped.push({ title, reason: '大块原文超长' }); continue; }
    // PII：不入库、不静默丢弃，转待确认队列
    if (detectPiiKind(`${title} ${content}`)) {
      guardMemoryCandidate({
        id: `q-${args.taskId}-${i}`, productKey: pk, projectId: args.projectId ?? null,
        title, content, type: c.type as MemoryType, sourceTaskId: args.taskId,
        sourceKind: (SOURCE_KINDS.includes(String(c.source_kind)) ? c.source_kind : 'auto') as MemorySourceKind,
        confidence: Number(c.confidence),
      });
      base.queued++;
      continue;
    }
    const sourceKind = (SOURCE_KINDS.includes(String(c.source_kind)) ? c.source_kind : 'auto') as MemorySourceKind;
    const tags = Array.isArray(c.tags) ? JSON.stringify(c.tags.slice(0, 5)) : null;
    const projectScope = c.project_id ?? null;

    // INVALIDATE：软失效被否证的既有记忆，保留审计链（不物理删除）
    for (const oldId of (Array.isArray(c.invalidated_ids) ? c.invalidated_ids : [])) {
      const r = db.prepare('UPDATE memories SET invalidated_at = ?, superseded_by = ? WHERE id = ? AND product_key = ?')
        .run(now, `mem-${args.taskId}-${i}`, oldId, pk);
      base.invalidated += r.changes;
    }
    if (c.action === 'UPDATE' && c.id) {
      const r = db.prepare(`UPDATE memories SET title = ?, content = ?, tags = ?, confidence = ?,
        source_kind = ?, updated_at = ? WHERE id = ? AND product_key = ?`)
        .run(title, content, tags, Number(c.confidence), sourceKind, now, c.id, pk);
      if (r.changes) { base.updated++; continue; }
      // id 不存在时退化为 ADD，不静默丢候选
    }
    db.prepare(`INSERT INTO memories
      (id,product_key,project_id,type,title,content,tags,source_task_id,source_kind,confidence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `mem-${args.taskId}-${i}`, pk, projectScope, c.type, title, content, tags,
      args.taskId, sourceKind, Number(c.confidence), now, now,
    );
    base.stored++;
  }
  base.dropped = dropped;
  return base;
}
