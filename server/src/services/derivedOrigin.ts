/**
 * T02320：派生单溯源的「描述兜底 / 存量对账 / 归并幂等」单源实现。
 *
 * 缺陷形态：自动归并只认 `tasks.derived_from` 字段（结果通道在 `server/src/mcp/server.ts`），
 * 而外部 Agent 建单时常把派生关系只写进 description 首行「来源：Txxxx」。字段为空 ⇒ 结论永久只躺在
 * 子单里，子单归档后（走 FR6.4 物理删除还会一并消失）无人能发现——实测 4 张已完成单即此形态。
 *
 * 口径：
 *  - 建单：显式 `derivedFrom` 优先；缺省时解析正文首行，**只在母单编号确实存在时**回填（不猜）；
 *  - 解析不到（或解析到但母单查无）而标题带「【AI回写待审核】」⇒ 回一条显式告警，照 T02131
 *    纯计划通道孤儿告警的做法——看到告警就回补，不静默；
 *  - 归并：母单 `handle_result` 已含本单号的归并标记 ⇒ 跳过，不重复叠加同一段结论；
 *  - 存量：启动对账回填同类历史行，母单不存在的只记日志不猜。
 *
 * 本模块只依赖 getDb，不 import TaskService——TaskService/MCP/REST 三方都要用，放任一侧都会形成循环导入。
 */
import { getDb } from '../db/connection';

/** 技能硬规则里的 AI 回写单标题前缀——带它却没溯源 = 注定失联，必须告警 */
export const AI_WRITEBACK_PREFIX = '【AI回写待审核】';

/**
 * 解析正文首行的「来源：Txxxx」（全/半角冒号皆可，容忍 markdown 强调、引用与列表前缀）。
 * 只看第一个非空行：正文中部出现的「来源」不属于建单口径，不能据此认母单。
 */
export function parseOriginNo(description?: string | null): string | null {
  const first = (description ?? '').split(/\r?\n/).find((l) => l.trim() !== '');
  if (!first) return null;
  const norm = first.replace(/[*_>#[\s]/g, '').replace(/^-+/, '');
  const m = /^来源[:：](T\d{1,6})(?![0-9])/.exec(norm);
  return m ? m[1] : null;
}

/** 编号是否为库内真实存在的任务（task_no 全局唯一，跨项目按编号定位即此口径） */
export function originExists(taskNo: string): boolean {
  if (!taskNo) return false;
  return !!getDb().prepare('SELECT 1 AS hit FROM tasks WHERE task_no = ?').get(taskNo);
}

export interface CreateOrigin {
  /** 写入 tasks.derived_from 的值（null = 不认母单） */
  derived_from: string | null;
  /** 需要回显给调用方的显式告警；无告警时缺省 */
  warning?: string;
}

/** 建单通道的溯源判定：MCP `mtask_create_task` 与 `POST /tasks` 共用，两条通道不许各写一套 */
export function resolveCreateOrigin(input: {
  derivedFrom?: string | null;
  description?: string | null;
  title?: string | null;
}): CreateOrigin {
  const explicit = (input.derivedFrom ?? '').trim();
  if (explicit) {
    // 显式传了编号就按原样落库（调用方的意图不改写），但母单查无时必须说出来——
    // 否则归并通道 findByNo 找不到目标，结论静默留在子单里。
    return originExists(explicit)
      ? { derived_from: explicit }
      : { derived_from: explicit, warning: `derivedFrom=${explicit} 在库中查无此编号：字段已按原样记录，但结论不会自动归并（母单不存在）` };
  }
  const parsed = parseOriginNo(input.description);
  if (parsed) {
    return originExists(parsed)
      ? { derived_from: parsed }
      : { derived_from: null, warning: `正文首行的「来源：${parsed}」在库中查无此编号：不猜母单、未回填 derived_from，结论不会自动归并` };
  }
  if ((input.title ?? '').includes(AI_WRITEBACK_PREFIX)) {
    return {
      derived_from: null,
      warning: `标题带${AI_WRITEBACK_PREFIX}但既未传 derivedFrom、正文首行也无「来源：Txxxx」：结论不会自动归并回母单，请补传 derivedFrom（或补首行来源）`,
    };
  }
  return { derived_from: null };
}

/**
 * 归并幂等判据：两条写回通道各有标记形态（MCP 自动归并写 `【派生单 Txxxx 处理结果 日期】`，
 * 脚本补录写 `派生单回填 Txxxx`），任一命中即视为已归并。
 */
export function alreadyMerged(handleResult: string | null | undefined, taskNo: string | null | undefined): boolean {
  const no = (taskNo ?? '').trim();
  if (!no) return false;
  const text = handleResult ?? '';
  return text.includes(`【派生单 ${no} 处理结果`) || text.includes(`派生单回填 ${no}`);
}

export interface ReconcileResult {
  scanned: number;
  backfilled: number;
  missingOrigin: number;
}

/**
 * 存量对齐：扫「derived_from 为空 且 正文首行含来源编号」的历史行回填字段。
 * 直写单字段、不走 TaskService.update——后者会连带状态同步/事件埋点，对账只补溯源不改语义。
 * 母单查无的行计入 missingOrigin 供日志核对，不猜、不回填。
 */
export function reconcileDerivedFrom(): ReconcileResult {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, description FROM tasks
      WHERE (derived_from IS NULL OR TRIM(derived_from) = '')
        AND description IS NOT NULL AND description LIKE '%来源%'`,
  ).all() as Array<{ id: string; description: string }>;
  let backfilled = 0;
  let missingOrigin = 0;
  const t = new Date().toISOString();
  const write = db.prepare('UPDATE tasks SET derived_from = ?, updated_at = ? WHERE id = ?');
  for (const row of rows) {
    const no = parseOriginNo(row.description);
    if (!no) continue;
    if (!originExists(no)) { missingOrigin += 1; continue; }
    write.run(no, t, row.id);
    backfilled += 1;
  }
  return { scanned: rows.length, backfilled, missingOrigin };
}
