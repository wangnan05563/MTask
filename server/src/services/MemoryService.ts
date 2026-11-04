import { getDb } from '../db/connection';
import { recordUsage } from '../util/aiUsageRecord';
import { normalizeProductKey } from '../util/productKey';
import { checkAiReadiness } from './AiReadinessService';

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
    if (!task?.project_id) return; // 无归属任务（系统临时单等）无可绑产品，静默跳过
    // MEM-207：同一 source_task_id 已产生过记忆则跳过重抽（规范 §4.1 第 0 步）
    if (db.prepare('SELECT 1 FROM memories WHERE source_task_id = ? LIMIT 1').get(taskId)) {
      telemetry(taskId, 'idempotent');
      return;
    }
    const proj = db.prepare('SELECT product_key, memory_auto_extract FROM projects WHERE id = ?').get(task.project_id) as
      | { product_key: string | null; memory_auto_extract: number }
      | undefined;
    if (!proj) return;
    // MEM-204：开关关闭计遥测，不静默
    if (!proj.memory_auto_extract) { telemetry(taskId, 'switch_off'); return; }
    // MEM-204：未绑产品不启用自动抽取，计遥测（不静默失败）
    const productKey = normalizeProductKey(proj.product_key ?? '');
    if (!productKey) { telemetry(taskId, 'unbound_product'); return; }
    // AI 未实配时抽取必然失败，提前跳过并留痕（配置就绪后此分支自然消失）
    if (!checkAiReadiness().ready) { telemetry(taskId, 'ai_not_ready'); return; }
    if (runningKeys.has(productKey)) { telemetry(taskId, 'busy_serial'); return; }
    runningKeys.add(productKey);
    try {
      // T04144 在此接入六段流程抽取（askJson + 准入 Q1-Q7 / 写法 W1-W8 / 分区映射 + 落库）。
      // 规则引擎接入前不落任何记忆，显式遥测避免「触发了却什么都没发生」的静默态。
      telemetry(taskId, 'rules_pending');
      void resultText;
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
