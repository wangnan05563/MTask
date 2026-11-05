import { getDb } from '../db/connection';
import { recordUsage } from '../util/aiUsageRecord';
import { decideExtraction, type ExtractProjectState } from '../util/memoryExtractPolicy'; // T04146：开关/绑定/幂等/归档解耦判定单源
import { checkAiReadiness } from './AiReadinessService';
import { AIService } from './AIService'; // T04144：规则引擎的真实 askJson 通道
import { ConfigService } from './ConfigService';
import { EXTRACTION_SYSTEM_PROMPT, runRulesExtraction, type ExtractCandidate, type RulesOutput } from './MemoryRulesService';
import { buildMemoryScopeWhere, type ActiveMemoryScope } from '../util/memoryScope';
import { isMemoryType, type MemoryType } from '../util/memoryTypes';

/**
 * T04143（PRD MEM-201 / MEM-204 / MEM-207，v1.2·F3）：记忆抽取的触发与隔离。
 *
 * 触发点收敛在 `TaskService.update` 的 handle_result 变更分支（唯一副作用出口），
 * 天然覆盖 MCP `mtask_update_task_result` 与 Web `PATCH /tasks/:id` 等全部写入口；
 * 本模块 fire-and-forget 且吞掉一切异常——抽取失败只留遥测，绝不回滚/报错主任务链路。
 * 抽取内容生成（六段流程/提示词/准入写法约束）由 T04144 接入 `runRulesExtraction`。
 */

/** 遥测卡 key（MEM-601）：抽取数/跳过原因/失败全部落 ai_usage，供拒杀率与未归属统计 */
const EXTRACT_CARD = 'memory_extract';

/** MEM-605：同产品抽取串行（进程内锁），避免并发抽取挤占 AI 配额；T04144 的真实抽取复用 */
const runningKeys = new Set<string>();

/** 记一条抽取遥测。stage 携带跳过原因，job_id 携带发起任务 id，面板可按任务区分「未绑产品/开关关/幂等/AI 未就绪」 */
function telemetry(taskId: string, stage: string, ok = true, error = ''): void {
  try {
    recordUsage({
      kind: 'memory_extract', toolId: '', ok, startedAt: Date.now(),
      cardKey: EXTRACT_CARD, stage, jobId: taskId, error: error.slice(0, 300),
    });
  } catch { /* 遥测失败也绝不上抛 */ }
}

/**
 * 抽取入口：调用方 fire-and-forget，本函数保证不抛。
 * 前置链（顺序即成本序）：幂等 → 项目级开关 → 产品绑定 → AI 就绪 → 同产品串行。
 */
async function runExtract(taskId: string, resultText: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const db = getDb();
    const task = db.prepare('SELECT project_id, handle_result FROM tasks WHERE id = ?').get(taskId) as
      | { project_id: string; handle_result: string | null }
      | undefined;
    // T04146：前置判定收口到 decideExtraction（纯函数、可逐项断言）。
    // SQL 刻意带出 archived / history_at 但**不加 archived=0 过滤**——MEM-205 归档解耦：
    // 归档/沉淀项目的结论仍可抽取，记忆可见性只看 product_key。
    const proj = task?.project_id
      ? db.prepare('SELECT product_key, memory_auto_extract, archived, history_at FROM projects WHERE id = ?')
        .get(task.project_id) as ExtractProjectState | undefined
      : undefined;
    const decision = decideExtraction({
      taskExists: !!task?.project_id,
      project: proj,
      alreadyExtracted: !!db.prepare('SELECT 1 FROM memories WHERE source_task_id = ? LIMIT 1').get(taskId),
    });
    if (decision.kind === 'skip') {
      // MEM-204：开关关闭/未绑产品/幂等均计遥测不静默；无归属任务与无项目仍静默（无可归属对象）
      if (decision.reason !== 'no_task' && decision.reason !== 'no_project') telemetry(taskId, decision.reason);
      return;
    }
    const productKey = decision.productKey;
    // 类型收窄：decideExtraction 已按 no_task 跳过，此处 task 必存在（编译器无法从纯函数结果推断）
    if (!task?.project_id) return;
    // AI 未实配时抽取必然失败，提前跳过并留痕（配置就绪后此分支自然消失）
    if (!checkAiReadiness().ready) { telemetry(taskId, 'ai_not_ready'); return; }
    // 与就绪判据同源取一个可用工具（启用 + 已填模型），供 askJson 指定 toolId
    const tool = ConfigService.list().find((t) => t.enabled && (t.model ?? '').trim());
    if (!tool) { telemetry(taskId, 'ai_not_ready'); return; }
    if (runningKeys.has(productKey)) { telemetry(taskId, 'busy_serial'); return; }
    runningKeys.add(productKey);
    try {
      // T04144：六段流程规则引擎（分区映射 + C1/C2/C3 代码兜底 + 四动作 + PII 队列 + dropped[]）。
      // askJson 在此注入真实实现；规则引擎本身可注入 mock，因此无 AI 实配也能端到端验证。
      const r = await runRulesExtraction({
        taskId, resultText, productKey, projectId: task.project_id,
        askJson: async (system, user) => {
          const ai = await AIService.askJson<RulesOutput>(
            tool.id, system, user,
            (content) => JSON.parse(content) as RulesOutput,
            { cardKey: 'memory_extract' },
          );
          if (!ai.ok || !ai.data) throw new Error(ai.error ?? 'askJson 无有效输出');
          return ai.data;
        },
        // T04145（MEM-208）：写法违规最多重写 1 次，由 applyRewriteBudget 保证不会进入第二轮
        rewrite: async (violations) => {
          const sys = `${EXTRACTION_SYSTEM_PROMPT}\n# 重写任务\n仅修正下列候选的写法违规（W1/W2/W4/W5/W8），保持事实、专名与数字不变，不得编造；输出严格 JSON 的 memories 数组，顺序与输入一致。`;
          const user = JSON.stringify(violations.map((v) => ({
            index: v.index, title: v.item.title, content: v.item.content, fix: v.rules,
          })));
          const ai = await AIService.askJson<RulesOutput>(
            tool.id, sys, user,
            (content) => JSON.parse(content) as RulesOutput,
            { cardKey: 'memory_extract' },
          );
          if (!ai.ok || !ai.data) return [];
          return (ai.data.memories ?? []).map((m, i) => ({
            index: violations[i]?.index ?? -1, item: m as ExtractCandidate,
          }));
        },
      });
      telemetry(taskId, `rules_ok:stored=${r.stored},queued=${r.queued},updated=${r.updated},invalidated=${r.invalidated},dropped=${r.dropped.length},rewrites=${r.rewrites}`);
    } finally {
      runningKeys.delete(productKey);
    }
  } catch (err) {
    telemetry(taskId, 'error', false, String((err as Error)?.message ?? err));
  }
}

/** 唯一对外入口：fire-and-forget，同步返回不阻塞主任务链路 */
export function scheduleMemoryExtract(taskId: string, resultText: string): void {
  void runExtract(taskId, resultText).catch(() => { /* runExtract 已全量捕获，此处双保险 */ });
}

/* ================= T04148（PRD MEM-301 / MEM-303 / F6 / F13）：记忆查询与排序 ================= */

/** MEM-301：默认 10 条、硬上限 20 条；超上限按上限截断而非报错（查询是高频只读路径） */
export const MEMORY_QUERY_DEFAULT_LIMIT = 10;
export const MEMORY_QUERY_MAX_LIMIT = 20;

/**
 * MEM-303 排序级联：类型权重 → 溯源权重 → 访问衰减 → 最近访问/更新时间。
 * 类型顺序按「约束强度」定：反馈纠正（用户明确说这样做不对）> 用户偏好 > 项目事实 > 外部参考。
 * 溯源权重按规范 §6.3 防线二：user_said 与 manual 同档（人工明确写入不弱于用户陈述，F6 修订）。
 * 衰减按规范 §7.2：30 天内访问过 ×1.5、超 180 天未访问 ×0.3（陈旧但可召回，不删除）。
 */
const MEMORY_RANK_SQL = `(
  CASE type WHEN 'feedback' THEN 4 WHEN 'user' THEN 3 WHEN 'project' THEN 2 ELSE 1 END *
  CASE source_kind WHEN 'user_said' THEN 3 WHEN 'manual' THEN 3 WHEN 'auto' THEN 2 WHEN 'inferred' THEN 1 ELSE 0.5 END *
  CASE
    WHEN julianday('now') - julianday(COALESCE(last_accessed_at, updated_at)) <= 30 THEN 1.5
    WHEN julianday('now') - julianday(COALESCE(last_accessed_at, updated_at)) > 180 THEN 0.3
    ELSE 1.0
  END
)`;

export interface MemoryRow {
  id: string;
  product_key: string;
  project_id: string | null;
  type: MemoryType;
  title: string;
  content: string;
  tags: string | null;
  source_task_id: string | null;
  source_kind: string;
  confidence: number | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  /** 本次排序得分（调试/断言用；不落库） */
  rank_score: number;
}

export interface QueryMemoriesOptions {
  type?: string;
  /** 标题/内容模糊匹配（F13：tags 用 JSON 文本 LIKE，不走全文索引） */
  query?: string;
  tags?: string[];
  limit?: number;
}

/** LIKE 参数转义：标签/关键字里的 % _ \ 不能当通配符，否则 '100%' 会误配全部 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * MEM-301：所有查询必须经 buildMemoryScopeWhere（product_key 恒在场），
 * 有项目子作用域时合并「产品级共享 + 本期特有」，失效行默认排除。
 * 召回即访问：批量回写 access_count/last_accessed_at，供 §7.2 衰减下一次生效。
 */
export function queryMemories(
  scope: ActiveMemoryScope,
  opts: QueryMemoriesOptions = {},
): MemoryRow[] {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? MEMORY_QUERY_DEFAULT_LIMIT)),
    MEMORY_QUERY_MAX_LIMIT,
  );
  const where = buildMemoryScopeWhere(scope);
  const clauses = [where.sql];
  const params: unknown[] = [...where.params];

  const rows: MemoryRow[] = [];
  if (opts.type !== undefined) {
    // 非法 type 直接返回空集：查询侧不做静默纠正，避免「查 user 却拿到 project」的错觉
    if (!isMemoryType(opts.type)) return rows;
    clauses.push('type = ?');
    params.push(opts.type);
  }
  const kw = (opts.query ?? '').trim();
  if (kw) {
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
    params.push(`%${escapeLike(kw)}%`, `%${escapeLike(kw)}%`);
  }
  for (const tag of (opts.tags ?? []).map((t) => t.trim()).filter(Boolean)) {
    clauses.push("tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(tag)}"%`);
  }

  const db = getDb();
  const sql = `SELECT id, product_key, project_id, type, title, content, tags, source_task_id,
      source_kind, confidence, access_count, last_accessed_at, created_at, updated_at,
      ${MEMORY_RANK_SQL} AS rank_score
    FROM memories
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank_score DESC, COALESCE(last_accessed_at, updated_at) DESC, updated_at DESC
    LIMIT ?`;
  const list = db.prepare(sql).all(...params, limit) as MemoryRow[];
  if (list.length) {
    const now = new Date().toISOString();
    const mark = db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id IN (${list.map(() => '?').join(',')})`,
    );
    mark.run(now, ...list.map((r) => r.id));
  }
  return list;
}
