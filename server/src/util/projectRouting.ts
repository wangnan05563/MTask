/**
 * T02938：按项目名解析项目行的**单源通道**。
 *
 * 缺陷本体：同名项目在库里可以有多行（T02481「项目归档后重建同名项目」、历史资产沉淀都会留下
 * 旧行），而 MCP 层 8 处 `SELECT id FROM projects WHERE name = ?` / `.find(p => p.name === name)`
 * 既不过滤也不排序，取的是数据库返回的**第一行**——通常正是先创建的归档/历史项目。
 * 2026-10-22 实测：以 `projectName="wiki三期"` 连建 3 张缺陷单，全部落进 `archived=1` 的同名
 * 历史项目，任务「创建成功」却在待办列表永远看不到，等于建了单就消失。
 *
 * 现行项目判据与 REST `GET /api/projects`（`server/src/routes/index.ts`）逐字同口径：
 * `COALESCE(history_at,'') = '' AND COALESCE(archived,0) = 0`
 * ——归档=软删除、`history_at` 非空=整个项目已沉淀为组织过程资产快照，两者都不再出现在任务/计划菜单。
 * T02938 起该判据由本文件 `ACTIVE_PROJECT_WHERE` 单源提供，REST 两处（项目列表 / 历史资产概览）
 * 与 MCP 按名解析共用同一串——两处口径分叉过一次，才让「页面看不到」与「按名能写进去」并存。
 * 这两处口径必须一起改，否则「页面看不到的项目」与「按名能写进去的项目」又会分叉。
 *
 * 解析次序（稳定、可预期，不猜）：
 * ① 名字精确匹配优先，无命中再大小写不敏感（T00482 既有语义）；
 * ② 同档内「现行项目」优先——同名多行时归档/历史行不再靠排序靠前抢单；
 * ③ 仍多命中（同名现行项目本身就有好几行）时取 `created_at` 最新的一行并回 `warning`
 *    把消歧责任交回调用方；
 * ④ 只命中归档/历史行时**不报错**（保持旧「项目存在」语义，不把 AI 回写通道堵死），
 *    但必回 `warning` 点名单子落在了非现行项目，让调用方有机会复核。
 *
 * ⚠ 报错文案含「项目不存在」四字干——`estimateCopy.ESTIMATE_PROJECT_NOT_FOUND` 是估算族
 *   拒绝文案的单源锚（verify-t02044-mcp-e10 M-16 逐字比对），改文案不许把它拆掉。
 */
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';

/**
 * 现行项目判据（T02938 单源）。
 * 逐字取自修复前 `GET /api/projects` 的 WHERE 子句（`routes/index.ts`），
 * 收口到这里后由 REST 列表/历史资产概览/按名解析三处共用——SQL 文本一字未改，
 * 只是不再各写一份（判据分叉就等于「页面看不到的项目仍能被按名写进去」）。
 */
export const ACTIVE_PROJECT_WHERE = "COALESCE(history_at,'') = '' AND COALESCE(archived,0) = 0";

/** `projects` 解析所需列（含归档/历史态与创建时间） */
type ProjectRow = { id: string; name: string; created_at: string; is_active: number };

/** 按名解析结果：命中给 `id`/`name`，未命中给 `error`，跨界或歧义给 `warning` */
export type ProjectNameResolution = {
  id?: string;
  name?: string;
  error?: string;
  warning?: string;
  /** 命中的是否现行项目（false=只能落到归档/历史行，见注释 ④） */
  active?: boolean;
  /** 匹配方式：exact=名字精确，ci=大小写不敏感 */
  via?: 'exact' | 'ci';
};

const SELECT_PROJECT_ROWS = `
  SELECT id, name, created_at,
         CASE WHEN ${ACTIVE_PROJECT_WHERE} THEN 1 ELSE 0 END AS is_active
    FROM projects`;

/**
 * 按项目名解析项目行（精确 → 大小写不敏感；同名多行时现行项目优先、其次创建时间最新）。
 * `db` 参数供门内夹具注入临时库，产品调用一律走默认 `getDb()`。
 */
export function resolveProjectByName(name: string, db: Database.Database = getDb()): ProjectNameResolution {
  const all = db.prepare(SELECT_PROJECT_ROWS).all() as ProjectRow[];
  const lower = name.toLowerCase();
  const exact = all.filter((p) => p.name === name);
  const cands = exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase() === lower);
  if (cands.length === 0) {
    return {
      error: `项目不存在：「${name}」。候选：${all.slice(0, 10).map((p) => p.name).join('、')}`
        + '（可先调 mtask_list_projects 查询）',
    };
  }
  const actives = cands.filter((p) => p.is_active === 1);
  // T02938：归档/历史行只能作最后回落——旧实现没有这一步，同名「归档 + 现行」两行时靠库序撞运气
  const pool = (actives.length > 0 ? actives : cands)
    .slice()
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? 1 : -1));
  const hit = pool[0];
  const isActive = hit.is_active === 1;
  let warning: string | undefined;
  if (!isActive) {
    warning = `项目名「${name}」只匹配到归档/历史资产行（id=${hit.id}），任务将写入非现行项目、`
      + '在待办列表不可见——同名项目已重建时请改传 projectId。';
  } else if (pool.length > 1) {
    warning = `项目名「${name}」仍有 ${pool.length} 行同名现行项目，已取创建时间最新的 ${hit.id}，`
      + '建议改传 projectId 消歧。';
  }
  return { id: hit.id, name: hit.name, active: isActive, via: exact.length > 0 ? 'exact' : 'ci', warning };
}
