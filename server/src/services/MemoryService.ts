import { getDb } from '../db/connection';
import { recordUsage } from '../util/aiUsageRecord';
import { decideExtraction, type ExtractProjectState } from '../util/memoryExtractPolicy'; // T04146：开关/绑定/幂等/归档解耦判定单源
import { checkAiReadiness } from './AiReadinessService';
import { AIService } from './AIService'; // T04144：规则引擎的真实 askJson 通道
import { ConfigService } from './ConfigService';
import { EXTRACTION_SYSTEM_PROMPT, runRulesExtraction, type ExtractCandidate, type RulesOutput } from './MemoryRulesService';

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
