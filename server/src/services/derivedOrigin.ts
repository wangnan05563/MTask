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
  const norm = first.replaceAll(/[*_>#[\s]/g, '').replace(/^-+/, '');
  const m = /^来源[:：](T\d{1,6})(?!\d)/.exec(norm);
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
 *
 * 这里只回答「母单有没有本单的归并记录」，供归档门（T03637）判断闭环是否走完；
 * 要不要再写一次由下面的**内容等价判据**决定（T04546）。
 */
export function alreadyMerged(handleResult: string | null | undefined, taskNo: string | null | undefined): boolean {
  const no = (taskNo ?? '').trim();
  if (!no) return false;
  const text = handleResult ?? '';
  return text.includes(`【派生单 ${no} 处理结果`) || text.includes(`派生单回填 ${no}`);
}

/** 归并节标题：自动通道 `【派生单 Txxxx 处理结果 2026-01-01】` / 补录通道 `## 派生单回填 Txxxx（2026-01-01）`。
 *  两个形态各把「前缀」和「日期槽」分成一组：日期为空也能定位槽位——
 *  早先用 `indexOf(日期串)` 反查，空串会命中行首，把日期写到标题最前面。 */
const MERGED_HEADINGS = (no: string) => {
  const esc = no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(?:(【派生单 ${esc} 处理结果 )([^】]*)】|(##\\s*派生单回填 ${esc}（)([^）]*)）)[ \\t]*$`,
    'gm',
  );
};

/** 母单里属于某子单的一节归并快照：标题整行 + 正文（正文不含下一节的分隔线/标题） */
export interface MergedSection {
  headingStart: number;
  headingEnd: number;
  headingLine: string;
  bodyStart: number;
  bodyEnd: number;
  /** 标题里的日期槽位（两种形态都用它写最后同步日） */
  dateStart: number;
  dateEnd: number;
}

/**
 * 定位母单内该子单的**全部**归并节（历史叠加时可能不止一节）。
 * 正文终止于：下一节的标题行、`---` 分隔线，或文本结尾。
 */
export function findMergedSections(handleResult: string | null | undefined, taskNo: string | null | undefined): MergedSection[] {
  const text = handleResult ?? '';
  const no = (taskNo ?? '').trim();
  if (!no || !text) return [];
  const heads: Array<{ start: number; end: number; line: string; dateStart: number; dateEnd: number }> = [];
  const re = MERGED_HEADINGS(no);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const prefixLen = (m[1] ?? m[3] ?? '').length;
    const dateStr = m[2] ?? m[4] ?? '';
    const dateStart = m.index + prefixLen;
    heads.push({
      start: m.index,
      end: m.index + m[0].length,
      line: m[0],
      dateStart,
      dateEnd: dateStart + dateStr.length,
    });
  }
  if (!heads.length) return [];
  // 正文边界：本标题行末 → 下一个「分节起点」（任何单的归并标题或 `---` 分隔线），否则文本末尾
  const boundaries: number[] = [];
  const anyHeading = /^【派生单 T\d+ 处理结果[^】]*】$|^##\s*派生单回填 T\d+（[^）]*）$|^---$/gm;
  const marks: number[] = [];
  let b: RegExpExecArray | null;
  while ((b = anyHeading.exec(text)) !== null) marks.push(b.index);
  for (let i = 0; i < heads.length; i += 1) {
    const from = heads[i].end;
    let to = text.length;
    for (const pos of marks) if (pos > from && pos < to) { to = pos; break; }
    boundaries.push(to);
  }
  return heads.map((h, i) => ({
    headingStart: h.start,
    headingEnd: h.end,
    headingLine: h.line,
    bodyStart: h.end,
    bodyEnd: boundaries[i],
    dateStart: h.dateStart,
    dateEnd: h.dateEnd,
  }));
}

/** 比较用的归一化：行尾统一 LF、去掉节正文首尾空行与行末空白 */
const normalizeBody = (s: string): string =>
  s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();

/**
 * 内容等价判据（T04546 的核心）：母单最新那节快照的正文是否与本次结论一致。
 * 找不到可比对的节 ⇒ 视为不一致（该写就写，别拿「有标记」当「内容对得上」）。
 */
export function mergedContentMatches(handleResult: string | null | undefined, taskNo: string | null | undefined, result: string): boolean {
  const sections = findMergedSections(handleResult, taskNo);
  if (!sections.length) return false;
  const last = sections[sections.length - 1];
  const text = handleResult ?? '';
  return normalizeBody(text.slice(last.bodyStart, last.bodyEnd)) === normalizeBody(result ?? '');
}

/**
 * 就地刷新母单里该子单的快照正文（保留母单其余内容逐字不动，含别的单归并节）。
 * 标题形态沿用命中的那一节，只把日期槽位写成本次同步日——不新造第三种标记，
 * 避免与脚本 `merge` 的 `## 派生单回填` 形态在母单里并存（T04546 期望处置 3）。
 * 无命中节时按补录通道的标题形态追加一节，与 `mcp-direct-call.py merge` 对齐。
 */
export function refreshMergedBody(
  handleResult: string | null | undefined,
  taskNo: string | null | undefined,
  result: string,
  stamp: string,
): string {
  const text = handleResult ?? '';
  const no = (taskNo ?? '').trim();
  const sections = findMergedSections(text, no);
  if (!sections.length) {
    const prev = text.trim();
    const block = `## 派生单回填 ${no}（${stamp}）\n${result}`;
    return prev ? `${prev}\n\n${block}` : block;
  }
  // 只刷新最后一节：更早的节是历史留痕，留着便于对照
  const last = sections[sections.length - 1];
  const heading = text.slice(last.headingStart, last.headingEnd);
  const dated = heading.slice(0, last.dateStart - last.headingStart) + stamp + heading.slice(last.dateEnd - last.headingStart);
  // 标题行与正文之间的换行由这里补；正文与下一节之间原本靠空行分隔，替换正文后要把空行还回去
  const tail = text.slice(last.bodyEnd);
  return text.slice(0, last.headingStart) + dated + '\n' + result + (tail ? `\n\n${tail}` : '');
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
