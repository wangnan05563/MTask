import { createHash } from 'node:crypto';
import { getDb } from '../db/connection';
import { isMemoryType } from '../util/memoryTypes';
import { normalizeProductKey } from '../util/productKey';
import { detectPiiKind, guardMemoryCandidate, type MemorySourceKind } from '../util/memoryGuard';
import { applyRewriteBudget } from '../util/memoryRewrite'; // T04145：W1-W8 重写限次
import {
  normalizeMemoryAuthority, normalizeMemoryKind, normalizeMemoryScope,
} from '../util/memoryLayers'; // T06071：分层/作用域/权威默认与校验

/** T06069（T06068 P0）：抽取上下文取全量有效记忆，最多 200 条（与容量上限同量级）。 */
export const EXISTING_MEMORY_LIMIT = 200;

/** T06069：任务 + 结果哈希，作为抽取幂等键；不依赖 source_task_id 是否存在新行。 */
export function memoryResultHash(resultText: string): string {
  return createHash('sha256').update(String(resultText ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/** 同任务同结果已成功抽取过则跳过；表缺失/旧库异常时返回 false，不阻断抽取。 */
export function isExtractRunDone(taskId: string, resultText: string): boolean {
  try {
    const db = getDb();
    return !!db.prepare(`SELECT 1 FROM memory_extract_runs
      WHERE task_id = ? AND result_hash = ? AND status = 'done'`)
      .get(taskId, memoryResultHash(resultText));
  } catch {
    return false;
  }
}

/** 项目必须存在且 product_key 与当前产品一致；否则候选不得落库。 */
function projectBelongsToProduct(db: ReturnType<typeof getDb>, projectId: string, productKey: string): boolean {
  const row = db.prepare('SELECT product_key FROM projects WHERE id = ?').get(projectId) as
    { product_key?: string | null } | undefined;
  return !!row && normalizeProductKey(row.product_key ?? '') === productKey;
}

/** 同任务同序号默认 id 已被历史结果占用时，追加内容哈希/序号，避免跨结果重跑时主键冲突。 */
function makeUniqueMemoryId(
  db: ReturnType<typeof getDb>, taskId: string, index: number, content: string,
): string {
  const base = `mem-${taskId}-${index}`;
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id);
  if (!exists(base)) return base;
  const suffix = createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 8);
  let candidate = `${base}-${suffix}`;
  let n = 1;
  while (exists(candidate)) candidate = `${base}-${suffix}-${n++}`;
  return candidate;
}

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
W1 可判定口径：**单条 content 最多 1 个句末标点（句号或分号）**；同一主题的「做法 + 失效边界」可以合成一句，但出现第二个句号/分号时必须拆成两条独立 memories 候选。
W8 口径：content 按字符数计 30–120 字（不足 30 字的信息并入相邻候选或补足边界条件，超过 120 字必须拆条）。
# 第四步：禁止项
不得编造、不得推断未明说属性、不得把请求本身抽成记忆、不得搬运既有记忆细节、不得输出语义等价的两条、不得输出解释文字。
# 输出格式（严格 JSON，无 Markdown 包裹）
{"memories":[{"action":"ADD|UPDATE|NOOP","id":"UPDATE 时填既有 id","invalidated_ids":["被否证 id"],"title":"≤20 字","content":"完整自足陈述句","type":"user|feedback|project|reference","memory_kind":"semantic|episodic|procedural","scope":"product|project|task","authority":"user|system|tool|inferred|external","tags":["≤5 个"],"confidence":0.0,"source_kind":"auto|manual|user_said|tool_output|inferred","project_id":null}],"dropped":[{"title":"被丢弃候选","reason":"Q1-Q7 编号或禁止项名称"}]}`;

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
      cur = { title: m[1].replaceAll(/（可选）|\(可选\)/g, '').trim(), body: '' };
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
  /** T06071：可选分层/作用域/权威；缺省按 type/source_kind/project_id 推导 */
  memory_kind?: string;
  scope?: string;
  authority?: string;
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
  // 段缺失时跳过而非报错（MEM-206）；幂等按「任务 + 结果哈希」判定（T06069）：
  // 同任务同结果只跑一次，同任务结果变化允许重跑；不再依赖 source_task_id 是否有新行。
  if (base.noExtractableSection) return base;
  const resultHash = memoryResultHash(args.resultText);
  if (db.prepare(`SELECT 1 FROM memory_extract_runs
    WHERE task_id = ? AND result_hash = ? AND status = 'done'`).get(args.taskId, resultHash)) {
    base.dropped.push({ title: args.taskId, reason: 'MEM-207 幂等跳过' });
    return base;
  }

  // T06069：不再只取最近 50 条。容量上限 200，当前产品全量有效记忆均进入判定上下文，
  // 避免最早 12 条对模型不可见而重复 ADD；规模超限后可在调用侧换成相似 top-k。
  const existing = db.prepare(`SELECT id, title, content, type, memory_kind, scope, authority FROM memories
    WHERE product_key = ? AND invalidated_at IS NULL AND invalid_at IS NULL AND expired_at IS NULL
    ORDER BY updated_at DESC LIMIT ?`).all(
    pk, EXISTING_MEMORY_LIMIT,
  ) as { id: string; title: string; content: string; type: string; memory_kind: string | null; scope: string | null; authority: string | null }[];
  const existingIds = new Set(existing.map((e) => e.id));
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

    const sourceKind = (SOURCE_KINDS.includes(String(c.source_kind)) ? c.source_kind : 'auto') as MemorySourceKind;
    // T06069：标签去空、去重、截断，避免 186 个标签/62 条的失控词表继续扩散。
    const tags = Array.isArray(c.tags)
      ? JSON.stringify([...new Set(c.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 5))
      : null;

    // T06069：候选未给 project_id 时默认当前任务项目；显式值必须是当前产品下的真实项目。
    const candidateProject = c.project_id === undefined || c.project_id === null
      ? '' : String(c.project_id).trim();
    const requestedProject = candidateProject || String(args.projectId ?? '').trim();
    if (requestedProject && !projectBelongsToProduct(db, requestedProject, pk)) {
      dropped.push({ title, reason: `project_id 不属于当前产品:${requestedProject}` });
      continue;
    }
    const projectScope = requestedProject || null;
    // T06071：分层/作用域/权威由候选显式值优先，缺省按 type/source_kind/项目推导；
    // scope=task 必须有来源任务，否则回退项目/产品级，避免产生无归属任务级记忆。
    const kind = normalizeMemoryKind(c.memory_kind, c.type);
    const authority = normalizeMemoryAuthority(c.authority, sourceKind);
    const scopeKind = c.scope === 'task' && !args.taskId
      ? normalizeMemoryScope(undefined, projectScope)
      : normalizeMemoryScope(c.scope, projectScope);

    // PII：不入库、不静默丢弃，转待确认队列
    if (detectPiiKind(`${title} ${content}`)) {
      guardMemoryCandidate({
        id: `q-${args.taskId}-${i}`, productKey: pk, projectId: projectScope,
        title, content, type: c.type, sourceTaskId: args.taskId,
        sourceKind: sourceKind,
        confidence: Number(c.confidence),
      });
      base.queued++;
      continue;
    }

    // T06069：UPDATE 命中既有行时，实际替代者就是该行 id；ADD/失效退化时才使用新行 id。
    const updateTargetId = c.action === 'UPDATE' && c.id && existingIds.has(String(c.id))
      ? String(c.id) : null;
    // 同任务同序号默认 id 可能已被历史结果占用（结果变更后重跑），这里提前算好唯一新 id。
    const fallbackId = makeUniqueMemoryId(db, args.taskId, i, content);
    let targetId = updateTargetId ?? fallbackId;

    // invalidated_ids 白名单：只允许本次 existing 返回的 id，最多 2 条，不得指向当前 UPDATE 目标。
    const rawInvalidated = Array.isArray(c.invalidated_ids)
      ? c.invalidated_ids.map((id) => String(id).trim()).filter(Boolean) : [];
    const uniqueInvalidated = [...new Set(rawInvalidated)];
    const eligibleInvalidated = uniqueInvalidated.filter((id) => existingIds.has(id) && id !== targetId);
    const toInvalidate = eligibleInvalidated.slice(0, 2);
    const ignoredInvalidated = uniqueInvalidated.filter((id) => !toInvalidate.includes(id));
    if (ignoredInvalidated.length) {
      dropped.push({ title, reason: `invalidated_ids 未授权/指向目标/超上限，已忽略:${ignoredInvalidated.join(',')}` });
    }

    // T06069：目标先落、旧行后失效，整段包在事务里；任何一步失败都回滚，避免半写。
    let wroteUpdate = false;
    let invalidatedChanges = 0;
    const applyCandidate = db.transaction(() => {
      if (updateTargetId) {
        const r = db.prepare(`UPDATE memories SET title = ?, content = ?, tags = ?, confidence = ?,
          source_kind = ?, memory_kind = ?, scope = ?, authority = ?,
          valid_at = ?, invalid_at = NULL, expired_at = NULL, invalidated_reason = NULL,
          revision = revision + 1, updated_at = ?
          WHERE id = ? AND product_key = ? AND invalidated_at IS NULL`)
          .run(title, content, tags, Number(c.confidence), sourceKind, kind, scopeKind, authority,
            now, now, updateTargetId, pk);
        if (r.changes) { wroteUpdate = true; targetId = updateTargetId; }
      }
      if (!wroteUpdate) {
        db.prepare(`INSERT INTO memories
          (id,product_key,project_id,type,memory_kind,scope,authority,valid_at,invalid_at,expired_at,revision,invalidated_reason,
           title,content,tags,source_task_id,source_kind,confidence,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          fallbackId, pk, projectScope, c.type, kind, scopeKind, authority,
          now, null, null, 1, null, title, content, tags,
          args.taskId, sourceKind, Number(c.confidence), now, now,
        );
        targetId = fallbackId;
      }
      // 旧行只允许失效仍未失效的行；superseded_by 必须写实际目标 id，而不是固定拼 mem-task-i。
      for (const oldId of toInvalidate) {
        const r = db.prepare(`UPDATE memories SET invalidated_at = ?, invalid_at = ?,
          invalidated_reason = ?, superseded_by = ?, revision = revision + 1
          WHERE id = ? AND product_key = ? AND invalidated_at IS NULL`)
          .run(now, now, 'superseded', targetId, oldId, pk);
        invalidatedChanges += r.changes;
      }
    });
    applyCandidate();
    base.invalidated += invalidatedChanges;
    if (wroteUpdate) base.updated++; else base.stored++;
  }

  // T06069：抽取成功（含 0 条/全 dropped）也记台账；同结果下次不再重跑，结果变化时哈希不同可重抽。
  try {
    db.prepare(`INSERT INTO memory_extract_runs
      (id,task_id,result_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(task_id,result_hash) DO UPDATE SET status = 'done', updated_at = excluded.updated_at`)
      .run(`xr-${args.taskId}-${resultHash.slice(0, 12)}`, args.taskId, resultHash, 'done', now, now);
  } catch { /* 台账失败不影响已落库结果；最坏情况是下次重跑一次 */ }
  base.dropped = dropped;
  return base;
}
