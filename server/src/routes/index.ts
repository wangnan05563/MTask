import { Router, raw } from 'express';
import { getDb } from '../db/connection';
import { TaskService, type TaskInput, type TaskListOptions } from '../services/TaskService';
import { ConfigService } from '../services/ConfigService';
import { ConsoleJobService } from '../services/ConsoleJobService';
import { QueueService } from '../services/QueueService';
import { AIService } from '../services/AIService';
import { ArchiveService } from '../services/ArchiveService';
import { TaskImageService } from '../services/TaskImageService';
import { TaskCategoryService } from '../services/TaskCategoryService';
import { ReqCategoryService, ReqEntryService } from '../services/ReqService';
import { exportBundle, importBundle, isExportTable } from '../services/SettingsService';
import { getDefaultNoteProjectId, getSetting, INBOX_PROJECT_ID, setSetting } from '../services/AppSettings';
import { getConfig as getUpdateConfig, saveConfig as saveUpdateConfig, testConfig as testUpdateConfig, checkUpdate, currentVersion as currentAppVersion } from '../services/UpdateService';
import { logService } from '../services/LogService';
import { dbAdminApi } from './dbadmin';
import { planApi } from './plans';
import { historyApi } from './history'; // T00589：历史资产（转移/统计）
import { generateReport, listTemplates, saveTemplate, deleteTemplate, aiGenerateReport, aiGenerateReportStream, isReportToken, readAndDeleteReport, gatherReportData, type ReportPeriod } from '../services/ReportService';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { notifyChange } from '../services/ChangeBus';
import { v4 as uuid } from 'uuid';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';

/** 低频集合列表 TTL（5s）：读多写少，写端点会主动 cacheClear 保持一致性 */
const LIST_TTL_MS = 5000;

function now(): string {
  return new Date().toISOString();
}

/**
 * 解析模型返回的「通用需求分组草案」JSON。
 * 兼容 ```json 代码围栏与裸 JSON 数组：先剥围栏，再取首个 '[' 到末尾 ']' 之间的片段解析，
 * 逐条兜底校验 title 必填，其余字段缺失以空串回填（AI 输出不可靠，宁缺毋滥）。
 */
function parseReqDraft(text: string): { title: string; content: string; category: string }[] {
  const bare = text.replaceAll(/```json/gi, '').replaceAll(/```/gi, '').trim();
  const start = bare.indexOf('[');
  const end = bare.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(bare.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: { title: string; content: string; category: string }[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.title !== 'string' || !o.title.trim()) continue;
    out.push({
      title: o.title.trim(),
      content: typeof o.content === 'string' ? o.content : '',
      category: typeof o.category === 'string' ? o.category.trim() : '',
    });
  }
  return out;
}

export const api = Router();

// ---------- 健康检查 ----------
api.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mtask-server', time: now() });
});

// ---------- 后台日志（实时查看） ----------
// since：增量游标（pos 的 seq），首次不传/为 0 返回当前缓冲全量；latestSeq 供下一轮增量
api.get('/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(logService.list(since));
});

// ---------- 项目 ----------
api.get('/projects', (req, res) => {
  // T00589 二轮：默认**排除**已沉淀为历史资产快照的项目与已归档项目（任务/计划菜单的项目列表不再出现）；
  // 历史资产页以 ?includeHistory=1 取全量（含历史/归档、并带 history_at 供分区展示）
  const includeHistory = req.query.includeHistory === '1';
  if (includeHistory) {
    const all = getDb().prepare('SELECT * FROM projects ORDER BY sort_weight, created_at').all() as Array<Record<string, unknown>>;
    res.json(all);
    return;
  }
  const cached = cacheGet<unknown[]>('projects');
  if (cached) return res.json(cached);
  const rows = getDb().prepare("SELECT * FROM projects WHERE COALESCE(history_at,'') = '' AND COALESCE(archived,0) = 0 ORDER BY sort_weight, created_at").all() as Array<Record<string, unknown>>;
  // T00496：附每项目待办/未验证计数（供项目下拉徽标展示）
  const counts = getDb().prepare(
    `SELECT project_id,
            SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
            SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS unverified_count
     FROM tasks WHERE archived = 0 GROUP BY project_id`,
  ).all() as Array<{ project_id: string; todo_count: number; unverified_count: number }>;
  // T00505：计划菜单项目下拉统计（按 plan_tasks.status：todo=待开始、doing=进行中、done=已完成）
  const planCounts = getDb().prepare(
    `SELECT project_id,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS plan_done,
            SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS plan_doing,
            SUM(CASE WHEN status NOT IN ('done') THEN 1 ELSE 0 END) AS plan_open
     FROM plan_tasks WHERE archived = 0 GROUP BY project_id`,
  ).all() as Array<{ project_id: string; plan_done: number; plan_doing: number; plan_open: number }>;
  const planByPid = new Map(planCounts.map((c) => [c.project_id, c]));
  const byPid = new Map(counts.map((c) => [c.project_id, c]));
  const rowsWithCounts = rows.map((r) => {
    const c = byPid.get(r.id as string);
    const pc = planByPid.get(r.id as string);
    return { ...r, todo_count: c?.todo_count ?? 0, unverified_count: c?.unverified_count ?? 0, plan_done: pc?.plan_done ?? 0, plan_doing: pc?.plan_doing ?? 0, plan_open: pc?.plan_open ?? 0 };
  });
  cacheSet('projects', rowsWithCounts, LIST_TTL_MS);
  res.json(rowsWithCounts);
});

api.post('/projects', (req, res) => {
  const { name, description = '' } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
  // T00589 二轮：项目名全局唯一——**含历史资产快照中的项目名**与已归档项目（避免与沉淀快照重名混淆）
  const dup = getDb().prepare('SELECT name, history_at FROM projects WHERE name = ?').get(name.trim()) as { name: string; history_at: string | null } | undefined;
  if (dup) {
    return res.status(400).json({ error: dup.history_at ? `项目名「${name.trim()}」已被历史资产中的项目使用，请换名` : `项目名「${name.trim()}」已存在` });
  }
  const id = uuid();
  getDb().prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, description, now(), now());
  cacheClear('projects'); // 新建项目后列表缓存失效，立即可见
  res.status(201).json(getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

api.patch('/projects/:id', (req, res) => {
  const { name, description, sortWeight } = req.body ?? {};
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (description !== undefined) { sets.push('description = ?'); values.push(description); }
  if (sortWeight !== undefined) { sets.push('sort_weight = ?'); values.push(sortWeight); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('projects'); // 改名/排序影响列表展示
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

api.delete('/projects/:id', (req, res) => {
  // 系统收件箱是移动端随手记的默认归属（schema 启动时种子，非用户创建）：
  // 运行中删除会让 getDefaultNoteProjectId 回退到已不存在的 id，随手记落库直接失败，故禁止删除
  if (req.params.id === INBOX_PROJECT_ID) {
    return res.status(400).json({ error: '系统收件箱项目不可删除' });
  }
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id); // 级联删任务
  cacheClear('projects');
  res.status(204).end();
});

// ---------- 任务 ----------
// 可选参数：projectId / archived / limit / offset / keyword / categoryId / sort（全部向后兼容，缺省=全量）
api.get('/tasks', (req, res) => {
  const { projectId, archived, limit, offset, keyword, categoryId, priority, sort } = req.query;
  // limit 仅接受 1~500 的正整数，非法则忽略（保持全量语义），避免恶意超大分页拖垮查询
  let limitN: number | undefined;
  const limitRaw = Number(limit);
  if (Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 500) limitN = Math.floor(limitRaw);
  res.json(TaskService.list({
    projectId: projectId as string | undefined,
    archived: archived === '1' || archived === 'true',
    priority: priority as string | undefined,
    limit: limitN,
    // 肯定形式分支：先处理缺省（undefined），避免否定条件与 else 并存造成误读
    offset: offset === undefined ? undefined : Math.max(0, Math.floor(Number(offset) || 0)),
    keyword: keyword as string | undefined,
    categoryId: categoryId as string | undefined,
    sort: sort as TaskListOptions['sort'],
  }));
});

// 按任务编号查询单个任务：AI Agent / 前端凭 task_no 定位（编号全局唯一）
api.get('/tasks/by-no/:taskNo', (req, res) => {
  const task = TaskService.findByNo(req.params.taskNo);
  if (!task) return res.status(404).json({ error: `任务「${req.params.taskNo}」不存在` });
  res.json(task);
});

api.post('/tasks', (req, res) => {
  const { projectId, title, description, priority, status, categoryId, parentId } = req.body ?? {};
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  // 移动端随手记：projectId 可选（§3.1/§3.3）。缺省落"默认记事项目"（用户设置优先，否则收件箱系统项目）
  const pid = projectId && typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : getDefaultNoteProjectId();
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) {
    return res.status(400).json({ error: '归属项目不存在' });
  }
  // T00450：父子层级——父任务必须存在且同项目（防跨项目挂接）
  let parent = undefined;
  if (parentId && typeof parentId === 'string') {
    parent = getDb().prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(parentId) as { id: string; project_id: string } | undefined;
    if (!parent) return res.status(400).json({ error: '父任务不存在' });
    if (parent.project_id !== pid) return res.status(400).json({ error: '子任务与父任务必须同项目' });
  }
  res.status(201).json(TaskService.create({ projectId: pid, title: title.trim(), description, priority, status, categoryId, parentId: parent?.id }));
});

api.patch('/tasks/:id', (req, res) => {
  const { title, description, priority, status, verified, aiSummary, handleResult, pinned, categoryId, parentId, color, aiState, derivedFrom } = req.body ?? {}; // T00566：aiState AI 处理状态 // T00490：color 记录字体颜色
  // T00450：parentId 挂接/换父/解除（null）——同项目校验；父任务不可挂到自己或其后代（两级层级下后代不存在，仅防自挂）
  if (parentId !== undefined) {
    if (parentId === req.params.id) return res.status(400).json({ error: '父任务不能是任务自身' });
    if (parentId) {
      const parent = getDb().prepare('SELECT id, project_id, parent_id FROM tasks WHERE id = ?').get(parentId) as { id: string; project_id: string; parent_id: string | null } | undefined;
      if (!parent) return res.status(400).json({ error: '父任务不存在' });
      // T00450 评审修复：两级层级约束——父任务本身不可是子任务（防 A→B→C 三级链破坏 arrange 分组渲染）
      if (parent.parent_id) return res.status(400).json({ error: '父任务已是子任务，层级限制两级' });
    }
  }
  // T00566 二轮：状态**自动驱动**（REST 侧同样不依赖技能）——显式 aiState 优先；
  // 否则按语义推导：验证失败→failed；标记完成→unread；回传处理结果→unread
  const autoAiState = aiState !== undefined
    ? aiState
    : verified === false ? 'failed'
      : status === 'done' ? 'unread'
        : handleResult !== undefined ? 'unread'
          : undefined;
  res.json(TaskService.update(req.params.id, { title, description, priority, status, verified, ai_summary: aiSummary, handle_result: handleResult, pinned, category_id: categoryId, parent_id: parentId === undefined ? undefined : (parentId || null), color, ai_state: autoAiState, derived_from: derivedFrom }));
});

api.post('/tasks/move', (req, res) => {
  const { taskIds, projectId } = req.body ?? {};
  if (!Array.isArray(taskIds) || !projectId) return res.status(400).json({ error: 'taskIds 数组与 projectId 必填' });
  TaskService.moveProject(taskIds, projectId);
  res.status(204).end();
});

// 任务手动排序（T00446）：拖拽后的完整 id 顺序 → user_sort 1..n；列表 sort=manual 时生效
// 通用需求条目拖拽排序（T00463）：同 /tasks/reorder 模式，写 sort_weight
api.post('/req-entries/reorder', (req, res) => {
  const { categoryId, orderedIds } = req.body ?? {};
  if (typeof categoryId !== 'string' || !categoryId || !Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'categoryId 与 orderedIds 必填' });
  }
  try {
    const db = getDb();
    const known = new Set(
      (db.prepare('SELECT id FROM req_entries WHERE category_id = ?').all(categoryId) as Array<{ id: string }>).map((r) => r.id),
    );
    const ids = (orderedIds as string[]).filter((id) => known.has(id));
    db.transaction(() => {
      ids.forEach((id, i) => {
        db.prepare('UPDATE req_entries SET sort_weight = ?, updated_at = ? WHERE id = ?').run(i + 1, now(), id);
      });
    })(); // T00516 修正：transaction 必须立即调用（此前漏 ()，包装函数创建后从未执行，整个 UPDATE 静默跳过）
    res.json({ ok: true, reordered: ids.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 重置提示词为默认排序（T00465）：清空 sort_weight，回落到 updated_at DESC
api.post('/prompts/reorder/reset', (req, res) => {
  const { categoryId } = req.body ?? {};
  if (typeof categoryId !== 'string' || !categoryId) return res.status(400).json({ error: 'categoryId 必填' });
  try {
    const r = getDb().prepare('UPDATE prompts SET sort_weight = 0, updated_at = ? WHERE category_id = ? AND sort_weight != 0').run(now(), categoryId);
    cacheClear('prompt-categories');
    res.json({ ok: true, reset: r.changes });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 提示词拖拽排序（T00463）：同模式
api.post('/prompts/reorder', (req, res) => {
  const { categoryId, orderedIds } = req.body ?? {};
  if (typeof categoryId !== 'string' || !categoryId || !Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'categoryId 与 orderedIds 必填' });
  }
  try {
    const db = getDb();
    const known = new Set(
      (db.prepare('SELECT id FROM prompts WHERE category_id = ?').all(categoryId) as Array<{ id: string }>).map((r) => r.id),
    );
    const ids = (orderedIds as string[]).filter((id) => known.has(id));
    db.transaction(() => {
      ids.forEach((id, i) => {
        db.prepare('UPDATE prompts SET sort_weight = ?, updated_at = ? WHERE id = ?').run(i + 1, now(), id); // T00494 修正：参数错位
      });
    })(); // T00516 修正：transaction 必须立即调用（此前漏 ()，UPDATE 体从未执行）
    cacheClear('prompt-categories');
    res.json({ ok: true, reordered: ids.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body ?? {};
  if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'orderedIds 必填（id 字符串数组，按新顺序）' });
  }
  res.json(TaskService.reorder(orderedIds as string[]));
});

// ---------- CSV 任务导入（INT-6 最小可用版）：preview 解析校验 / confirm 确认导入 ----------
/** 收尾当前行：拼接末尾字段并按「非空则入行」规则推送；供 parseCsv 复用 */
function flushCsvRow(rows: string[][], cur: string[], field: string): void {
  const cells = cur.concat(field);
  if (cells.some((c) => c.trim())) rows.push(cells);
}

/** CSV 状态机单步：消费 text[i] 并推进状态，返回下一个索引（供 parseCsv 复用） */
function consumeCsvChar(text: string, i: number, st: { cur: string[]; field: string; inQuotes: boolean }, rows: string[][]): number {
  const ch = text[i];
  const next = text[i + 1];
  if (st.inQuotes) {
    if (ch === '"' && next === '"') { // 连续双引号：转义为一个引号
      st.field += '"';
      return i + 2;
    }
    if (ch === '"') { // 引号结束
      st.inQuotes = false;
      return i + 1;
    }
    st.field += ch; // 引号内普通字符
    return i + 1;
  }
  if (ch === '"') st.inQuotes = true;
  else if (ch === ',') { st.cur.push(st.field); st.field = ''; }
  else if (ch === '\n' || ch === '\r') {
    if (ch === '\r' && next === '\n') i++;
    flushCsvRow(rows, st.cur, st.field);
    st.cur = [];
    st.field = '';
  } else st.field += ch;
  return i + 1;
}

/** CSV 简易解析：RFC4180 引号感知，返回二维单元格数组 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const st = { cur: [] as string[], field: '', inQuotes: false };
  let i = 0;
  while (i < text.length) {
    i = consumeCsvChar(text, i, st, rows);
  }
  if (st.field || st.cur.length) flushCsvRow(rows, st.cur, st.field);
  return rows;
}

/** 表头映射：宽松匹配常见列名 */
function mapCsvColumns(headers: string[]): Record<string, number> {
  const alias: Record<string, string> = {
    标题: 'title', 名称: 'title', 任务: 'title', 任务名称: 'title', 任务标题: 'title',
    描述: 'description', 内容: 'description', 说明: 'description', 详情: 'description',
    优先级: 'priority', 状态: 'status', 分类: 'category', 备注: 'description',
  };
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = alias[h.trim()] ?? alias[h.trim().toLowerCase()];
    if (key !== undefined && !(key in map)) map[key] = i;
  });
  return map;
}

const PRIORITY_ALIAS: Record<string, string> = { 高: 'high', 中: 'normal', 普通: 'normal', 低: 'low', high: 'high', normal: 'normal', low: 'low', urgent: 'urgent' };
const STATUS_ALIAS: Record<string, string> = { 完成: 'done', 已完成: 'done', 待办: 'todo', 未开始: 'todo', done: 'done', todo: 'todo' };

/** CSV 单行导入结果：skip=整行空跳过 */
type CsvImportResult =
  | { kind: 'skip' }
  | { kind: 'error'; message: string }
  | { kind: 'item'; item: { title: string; description: string; priority: string; status: string; categoryId: string | null } };

/** 分类名 → 分类 id；名称缺失返回 null，不存在则给出错误 */
function resolveCsvCategory(name: string, catByName: Map<string, string>): { id: string | null; error?: string } {
  if (!name) return { id: null };
  const hit = catByName.get(name);
  return hit ? { id: hit } : { id: null, error: '分类不存在：' + name };
}

/** 校验并归一化一行 CSV（标题/去重/状态/分类），供 /tasks/import-csv/preview 复用 */
function buildCsvImportRow(
  r: string[],
  map: Record<string, number>,
  catByName: Map<string, string>,
  existTitles: Set<string>,
  seen: Set<string>,
): CsvImportResult {
  const get = (key: string) => (map[key] === undefined ? '' : (r[map[key]] ?? '').trim());
  const title = get('title');
  if (!title && !r.some((c) => c.trim())) return { kind: 'skip' };
  if (!title) return { kind: 'error', message: '标题必填' };
  if (existTitles.has(title) || seen.has(title)) return { kind: 'error', message: '标题重复：' + title };
  const priority = PRIORITY_ALIAS[get('priority').toLowerCase()] ?? 'normal';
  const statusRaw = get('status').toLowerCase();
  const status = STATUS_ALIAS[statusRaw] ?? (statusRaw === 'completed' ? 'done' : 'todo');
  if (statusRaw && !STATUS_ALIAS[statusRaw]) return { kind: 'error', message: '状态非法：' + get('status') };
  const cat = resolveCsvCategory(get('category'), catByName);
  if (cat.error) return { kind: 'error', message: cat.error };
  seen.add(title);
  return { kind: 'item', item: { title, description: get('description'), priority, status, categoryId: cat.id } };
}

// 预览：解析 CSV → 校验 → 返回映射结果与行级错误（不入库）
api.post('/tasks/import-csv/preview', raw({ type: () => true, limit: '20mb' }), (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为 CSV 文本' });
  try {
    const text = req.body.toString('utf-8').replace(/^\ufeff/, '');
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ headers: [], items: [], errors: [{ row: 1, message: 'CSV 至少需要表头与一行数据' }] });
    const headers = rows[0].map((h) => h.trim());
    const map = mapCsvColumns(headers);
    if (map.title === undefined) return res.status(400).json({ error: '未找到标题列（支持列名：标题/名称/任务/任务名称/任务标题）' });
    const catRows = getDb().prepare('SELECT id, name FROM task_categories').all() as Array<{ id: string; name: string }>;
    const catByName = new Map(catRows.map((c) => [c.name.trim(), c.id]));
    const items: Array<{ title: string; description: string; priority: string; status: string; categoryId: string | null }> = [];
    const errors: Array<{ row: number; message: string }> = [];
    const seen = new Set<string>();
    const existTitles = new Set(
      (getDb().prepare('SELECT title FROM tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ title: string }>).map((r) => r.title),
    );
    for (let i = 1; i < rows.length; i++) {
      const res = buildCsvImportRow(rows[i], map, catByName, existTitles, seen);
      if (res.kind === 'error') { errors.push({ row: i + 1, message: res.message }); continue; }
      if (res.kind === 'item') items.push(res.item);
    }
    res.json({ headers, items, errors });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 确认导入：复用 TaskService.create（task_no 分配/计划联动一致），跳过已存在标题
api.post('/tasks/import-csv/confirm', (req, res) => {
  const { projectId, items } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items 必填' });
  try {
    const created: string[] = [];
    for (const it of items as Array<{ title: string; description?: string; priority?: string; status?: string; categoryId?: string | null }>) {
      if (!it.title?.trim()) continue;
      if (getDb().prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? AND archived = 0').get(projectId, it.title)) continue;
      TaskService.create({ projectId, title: it.title, description: it.description, priority: (it.priority as TaskInput['priority']) ?? 'normal', status: (it.status as TaskInput['status']) ?? undefined, categoryId: it.categoryId ?? null });
      created.push(it.title);
    }
    notifyChange('tasks');
    res.status(201).json({ ok: true, count: created.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- T00556 / PRD INT-6：JSON 任务导入（Trello 导出 / 通用 JSON 数组，preview + confirm） ----------
/** 把多种 JSON 形态归一为任务条目：数组 / {cards|tasks|items|issues:[]} / Trello board {lists:[{cards:[]}]} */
function extractJsonImportItems(data: unknown): Array<{ title: string; description: string; priority?: string }> {
  const toItem = (o: Record<string, unknown>): { title: string; description: string; priority?: string } | null => {
    const title = String(o.title ?? o.name ?? o.summary ?? '').trim();
    if (!title) return null;
    const description = String(o.description ?? o.desc ?? o.details ?? o.content ?? '').trim();
    const pr = String(o.priority ?? '').toLowerCase();
    const priority = PRIORITY_ALIAS[pr] ? pr : undefined;
    return priority ? { title, description, priority } : { title, description };
  };
  const fromArray = (arr: unknown[]) => arr
    .filter((x) => x !== null && typeof x === 'object')
    .map((x) => toItem(x as Record<string, unknown>))
    .filter((x): x is { title: string; description: string; priority?: string } => x !== null);
  if (Array.isArray(data)) return fromArray(data);
  if (data !== null && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['cards', 'tasks', 'items', 'issues']) {
      if (Array.isArray(o[k])) return fromArray(o[k] as unknown[]);
    }
    if (Array.isArray(o.lists)) {
      return (o.lists as unknown[]).flatMap((l) => {
        const lo = (l ?? {}) as Record<string, unknown>;
        return Array.isArray(lo.cards) ? fromArray(lo.cards as unknown[]) : [];
      });
    }
  }
  return [];
}

api.post('/tasks/import-json/preview', raw({ type: () => true, limit: '20mb' }), (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为 JSON 文件二进制' });
  let data: unknown;
  try {
    data = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'JSON 解析失败：请上传有效的 Trello 导出或 JSON 数组文件' });
  }
  const items = extractJsonImportItems(data);
  if (items.length === 0) return res.status(400).json({ error: '未从 JSON 中识别到任务：支持数组、cards[]、tasks[]、Trello board lists[].cards[]' });
  const existing = new Set((getDb().prepare('SELECT title FROM tasks WHERE project_id = ? AND archived = 0').all(projectId) as Array<{ title: string }>).map((r) => r.title));
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Set<string>();
  const valid: typeof items = [];
  items.forEach((it, i) => {
    if (existing.has(it.title)) { errors.push({ row: i + 1, message: `标题已存在：${it.title}` }); return; }
    if (seen.has(it.title)) { errors.push({ row: i + 1, message: `标题重复：${it.title}` }); return; }
    seen.add(it.title);
    valid.push(it);
  });
  res.json({ items: valid.map((it) => ({ ...it, priority: it.priority ?? 'normal', status: 'todo', categoryId: null, categoryName: '' })), errors });
});

api.post('/tasks/import-json/confirm', (req, res) => {
  const { projectId, items } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items 必填' });
  try {
    let count = 0;
    for (const it of items as Array<{ title: string; description?: string; priority?: string }>) {
      if (!it.title?.trim()) continue;
      if (getDb().prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? AND archived = 0').get(projectId, it.title)) continue;
      TaskService.create({ projectId, title: it.title, description: it.description, priority: (it.priority as TaskInput['priority']) ?? 'normal' });
      count += 1;
    }
    notifyChange('tasks');
    res.status(201).json({ ok: true, count });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});


/** 单个任务的批量操作分派（T00457）；未知 action 抛错，由路由统一映射 400 */
function applyBatchAction(db: ReturnType<typeof getDb>, id: string, action: string | undefined, value: string | undefined): void {
  if (action === 'status') {
    if (value !== 'todo' && value !== 'done') throw new Error('status 值非法');
    TaskService.setStatus(id, value);
    return;
  }
  if (action === 'category') {
    if (value && !db.prepare('SELECT id FROM task_categories WHERE id = ?').get(value)) throw new Error('分类不存在');
    db.prepare('UPDATE tasks SET category_id = ?, updated_at = ? WHERE id = ?').run(value || null, now(), id);
    return;
  }
  // T00588：批量优先级 / 字体颜色（与计划页批量能力对齐）
  if (action === 'priority') {
    if (!value || !['low', 'normal', 'high', 'urgent'].includes(value)) throw new Error('priority 值非法');
    db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(value, now(), id);
    return;
  }
  if (action === 'color') {
    db.prepare('UPDATE tasks SET color = ?, updated_at = ? WHERE id = ?').run(value ?? '', now(), id);
    return;
  }
  if (action === 'archive') {
    ArchiveService.archive([id]);
    return;
  }
  throw new Error(`不支持的批量操作：${action}`);
}

// 批量操作（T00457 / PRD UX-5）：多选后批量改状态/分类/归档——单事务，任一失败整体回滚
api.post('/tasks/batch', (req, res) => {
  const { ids, action, value } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'ids 必填（任务 id 字符串数组）' });
  }
  try {
    const db = getDb();
    const affected: string[] = [];
    db.transaction(() => {
      for (const id of ids as string[]) {
        if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) continue;
        applyBatchAction(db, id, action, value);
        affected.push(id);
      }
    })();
    notifyChange('tasks');
    res.json({ ok: true, affected: affected.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 复用（复制）任务到目标项目；同名冲突 / 目标不存在映射为 409
api.post('/tasks/:id/reuse', (req, res) => {
  const { projectId } = req.body ?? {};
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  try {
    res.status(201).json(TaskService.reuse(req.params.id, projectId));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// 将任务复制为提示词页可复用资产（打包成单份 JSON 写入目标提示词分类）；分类不存在映射为 409
api.post('/tasks/:id/to-prompt', (req, res) => {
  const { categoryId } = req.body ?? {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId 必填' });
  try {
    res.status(201).json(TaskService.toPromptAsset(req.params.id, categoryId));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

api.post('/tasks/:id/to-req', (req, res) => {
  const { categoryId } = req.body ?? {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId 必填' });
  try {
    res.status(201).json(TaskService.toReqAsset(req.params.id, categoryId));
    cacheClear('req-categories'); // 新增条目使分类计数变化
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// ---------- 任务分类 ----------
api.get('/task-categories', (_req, res) => {
  res.json(TaskCategoryService.list());
});

api.post('/task-categories', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  res.status(201).json(TaskCategoryService.create(name));
});

api.patch('/task-categories/:id', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  const cat = TaskCategoryService.rename(req.params.id, name);
  if (!cat) return res.status(404).json({ error: '分类不存在' });
  res.json(cat);
});

api.delete('/task-categories/:id', (req, res) => {
  // 删除分类会把其下任务 category_id 置空（任务保留、回到未分类）
  if (!TaskCategoryService.remove(req.params.id)) return res.status(404).json({ error: '分类不存在' });
  res.status(204).end();
});

// FR5.1 采纳：审阅后的 AI 文本保存到任务并置为 done（仅保存文本，待人工合并）
api.post('/tasks/:id/adopt', (req, res) => {
  const { content } = req.body ?? {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
  try {
    res.json(TaskService.adoptContent(req.params.id, content));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 任务截图/图片附件（FR1.3 图文混合描述） ----------
// 上传：body { data: base64（不含 data: 前缀）, mimeType? }，支持 dataURL 自动去前缀
api.post('/tasks/:id/images', (req, res) => {
  let { data, mimeType } = req.body ?? {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'data(base64) 必填' });
  // 兼容前端直接传 dataURL 的情况
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(data);
  if (m) { mimeType = mimeType ?? m[1]; data = m[2]; }
  try {
    res.status(201).json(TaskImageService.add(req.params.id, data, mimeType));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 任务的图片列表（元信息，不含 BLOB）
api.get('/tasks/:id/images', (req, res) => {
  res.json(TaskImageService.listByTask(req.params.id));
});

// 读取图片二进制（<img src> 直接使用）
api.get('/images/:id', (req, res) => {
  const img = TaskImageService.getData(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.setHeader('Content-Type', img.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(img.data);
});

// 删除单张图片（替换/移除操作）
api.delete('/images/:id', (req, res) => {
  if (!TaskImageService.remove(req.params.id)) return res.status(404).json({ error: '图片不存在' });
  res.status(204).end();
});

// ---------- AI 工具配置 ----------
api.get('/aitools', (_req, res) => {
  res.json(ConfigService.list());
});

api.get('/aitools/types', (_req, res) => {
  res.json(ConfigService.listAdapterTypes());
});

// 草稿连接测试：用表单未保存的 type/endpoint/apiKey/model 提前验证连通性（不落库）
// 模型拖拽排序（T00446）：orderedIds 全量校验后事务重写 sort_weight
api.post('/aitools/reorder', (req, res) => {
  const { orderedIds } = (req.body ?? {}) as { orderedIds?: unknown };
  if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'orderedIds 必填（id 字符串数组，按新顺序）' });
  }
  try {
    const db = getDb();
    const known = new Set(
      (db.prepare('SELECT id FROM ai_tools').all() as Array<{ id: string }>).map((r) => r.id),
    );
    const ids = (orderedIds as string[]).filter((id) => known.has(id));
    db.transaction(() => {
      ids.forEach((id, i) => {
        db.prepare('UPDATE ai_tools SET sort_weight = ? WHERE id = ?').run(i, id);
      });
    })();
    cacheClear('aitools');
    res.json({ ok: true, reordered: ids.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/aitools/test', async (req, res) => {
  try {
    res.json(await ConfigService.testDraft(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 草稿模型列表：用表单未保存的 type/endpoint/apiKey 拉取服务商可用模型（不落库）
api.post('/aitools/models', async (req, res) => {
  try {
    res.json(await ConfigService.listModelsDraft(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/aitools', (req, res) => {
  try {
    res.status(201).json(ConfigService.create(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.patch('/aitools/:id', (req, res) => {
  try {
    res.json(ConfigService.update(req.params.id, req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// T00587：模型配置归档 / 恢复（删除按钮改归档后的服务端支持）
api.post('/aitools/:id/archive', (req, res) => {
  ConfigService.archive(req.params.id);
  res.json({ ok: true });
});
api.post('/aitools/:id/restore', (req, res) => {
  ConfigService.restore(req.params.id);
  res.json({ ok: true });
});
api.get('/aitools/archived', (_req, res) => {
  res.json(ConfigService.listArchived());
});

api.delete('/aitools/:id', (req, res) => {
  ConfigService.remove(req.params.id);
  res.status(204).end();
});

api.post('/aitools/:id/test', async (req, res) => {
  try {
    res.json(await ConfigService.testConnection(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 已保存工具的可用模型列表（服务端解密密钥后拉取，带 5 分钟缓存）
api.post('/aitools/:id/models', async (req, res) => {
  try {
    res.json(await ConfigService.listModels(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 查看原文：按需返回解密后的 API Key（仅用户显式点击时拉取，不随列表返回）
api.get('/aitools/:id/api-key', (req, res) => {
  try {
    res.json(ConfigService.getApiKey(req.params.id));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// FR3.4 默认工具绑定
api.get('/aitools/defaults', (_req, res) => {
  res.json(ConfigService.getDefaults());
});

api.post('/aitools/:id/set-default', (req, res) => {
  const { kind } = req.body ?? {};
  if (kind !== 'organize' && kind !== 'develop') return res.status(400).json({ error: "kind 必填（organize|develop）" });
  try {
    ConfigService.setDefault(req.params.id, kind);
    res.json(ConfigService.getDefaults());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 队列 ----------
api.get('/queues', (_req, res) => {
  res.json(QueueService.list());
});

api.get('/queues/:id', (req, res) => {
  const queue = QueueService.getById(req.params.id);
  if (!queue) return res.status(404).json({ error: '队列不存在' });
  res.json({ ...queue, jobs: QueueService.listJobsDetailed(req.params.id) });
});

api.post('/queues', (req, res) => {
  const { name, date } = req.body ?? {};
  if (!name || !date) return res.status(400).json({ error: 'name 与 date 必填' });
  res.status(201).json(QueueService.create(name, date));
});

api.post('/queues/:id/jobs', (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items 必填' });
  try {
    res.status(201).json(QueueService.addJobs(req.params.id, items));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.delete('/queues/:id/jobs/:jobId', (req, res) => {
  QueueService.removeJob(req.params.id, req.params.jobId);
  res.status(204).end();
});

api.post('/queues/:id/send', async (req, res) => {
  try {
    const jobs = await QueueService.sendAll(req.params.id, AIService.buildSender());
    res.json(jobs);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 异步提交：不阻塞等待完整结果，受理后由后台 poller 轮询收口（同步工具自动回退、行为不变）
api.post('/queues/:id/submit', async (req, res) => {
  try {
    const jobs = await QueueService.submitAll(req.params.id, AIService.buildSubmitter());
    res.json(jobs);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/queues/:id/reset', (req, res) => {
  QueueService.resetFailed(req.params.id);
  res.status(204).end();
});

// ---------- 梳理（FR2） ----------
api.post('/ai/organize', async (req, res) => {
  const { taskIds, toolId } = req.body ?? {};
  if (!Array.isArray(taskIds) || !toolId) return res.status(400).json({ error: 'taskIds 数组与 toolId 必填' });
  try {
    res.json(await AIService.organize(taskIds, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 标题美化 ----------
// T00597：AI 简化标题——依据任务详情高度总结（限 40 字），需有详情内容方可触发
api.post('/ai/simplify', async (req, res) => {
  const { toolId, title, description } = req.body ?? {};
  if (!toolId || typeof toolId !== 'string') return res.status(400).json({ error: 'toolId 必填' });
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '标题为空，无可简化内容' });
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: '任务详情为空——AI 简化需依据详情内容总结标题，请先补充任务详情' });
  }
  try {
    res.json(await AIService.simplifyTitle(title.trim(), description.trim(), toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/ai/beautify', async (req, res) => {
  const { toolId, title } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (!title) return res.status(400).json({ error: 'title 必填' });
  try {
    res.json(await AIService.beautifyTitle(title, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 报表生成与模板管理 ----------
api.post('/report/generate', async (req, res) => {
  const { period, format, projectId, templateId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  try {
    const { buffer, filename } = await generateReport(period, format, {
      projectId: projectId || undefined,
      templateId: templateId || undefined,
    });
    // 各格式对应 MIME：xlsx/docx 为 OOXML，pdf 为 application/pdf，pptx 为演示文稿 OOXML
    const MIME: Record<string, string> = {
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pdf: 'application/pdf',
    };
    res.setHeader('Content-Type', MIME[format] ?? 'application/octet-stream');
    // RFC5987：文件名含中文需编码，避免下载名乱码
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.get('/report/templates', (_req, res) => {
  res.json(listTemplates());
});

api.post('/report/ai-generate', async (req, res) => {
  const { period, format, projectId, toolId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: '请选择 AI 模型' });
  try {
    // AI 周报：先落临时文件，返回下载令牌与洞察正文（前端再经 ai-download 下载即删）
    const r = await aiGenerateReport(period, format, {
      projectId: projectId || undefined,
      toolId,
    });
    res.json({ ok: true, token: r.token, filename: r.filename, insight: r.insight });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- AI 周报（SSE 流式）：联动 AI 控制台实时展示生成过程 ----------
api.post('/report/ai-generate-stream', async (req, res) => {
  const { period, format, projectId, toolId } = req.body ?? {};
  if (!['day', 'week', 'month'].includes(period)) return res.status(400).json({ error: 'period 非法' });
  if (!['xlsx', 'docx', 'pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format 非法' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: '请选择 AI 模型' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 客户端断开后停止继续写流，避免向已关闭的 socket 写入抛错。
  // 必须监听 res 的 close（响应真正关闭才代表客户端断开/响应结束），不能监听 req.on('close')：
  // SSE 请求体已被 express.json() 消费完，IncomingMessage 无数据可读时 req 会提前触发 close，
  // 导致后续 chunk/done/error 事件被误丢弃（实测只发出前几条 stage 就"卡住"）。
  let closed = false;
  const send = (event: string, payload: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  res.on('close', () => { closed = true; });

  try {
    const r = await aiGenerateReportStream(
      period,
      format,
      { projectId: projectId || undefined, toolId },
      (msg) => send('stage', { msg }),
      (text) => send('chunk', { text }),
    );
    send('done', { token: r.token, filename: r.filename });
    res.end();
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
    res.end();
  }
});

api.post('/report/ai-download', (req, res) => {
  const { token, filename } = req.body ?? {};
  if (typeof token !== 'string' || !isReportToken(token)) return res.status(400).json({ error: 'token 非法' });
  // 下载文件名做白名单清洗，避免注入非法字符
  const safe = typeof filename === 'string' && /^[\w\-.()·\u4e00-\u9fa5 ]+\.(xlsx|docx|pdf|pptx)$/i.test(filename) ? filename : 'MTask-ai-report.xlsx';
  const buf = readAndDeleteReport(token);
  if (!buf) return res.status(404).json({ error: '文件已过期，请重新生成' });
  const MIME: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
  };
  const ext = (safe.split('.').pop() ?? '').toLowerCase();
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  // RFC5987：文件名含中文需编码，避免下载名乱码
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`);
  res.send(buf);
});

api.post('/report/templates', async (req, res) => {
  const { filename, data } = req.body ?? {};
  if (typeof filename !== 'string' || typeof data !== 'string') {
    return res.status(400).json({ error: 'filename 与 data 必填' });
  }
  // 前端上传以 base64 承载，校验并落盘；非法格式/路径/体积返回明确提示
  if (!saveTemplate(filename, Buffer.from(data, 'base64'))) {
    return res.status(400).json({ error: '模板文件校验失败，仅支持 .xlsx / .docx（≤10MB）' });
  }
  res.json({ ok: true });
});

api.delete('/report/templates/:id', (req, res) => {
  if (!deleteTemplate(req.params.id)) return res.status(400).json({ error: '模板不存在或名称非法' });
  res.status(204).end();
});

// ---------- AI 控制台通用问答 ----------
// 可选注入周期数据：控制台「周期分析」类预设（汇总/风险/建议）携带 period 时，
// 后端用与 AI 周报相同的 gatherReportData 聚合真实任务数据注入，使 AI 作答有据可依；
// 不带 period（自定义问答）则保持纯对话，不注入数据。
const REPORT_PERIODS = new Set<ReportPeriod>(['day', 'week', 'month']);
api.post('/ai/chat', async (req, res) => {
  const { toolId, system, user, period, projectId } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (typeof user !== 'string' || !user.trim()) return res.status(400).json({ error: 'user 必填' });

  let sys = typeof system === 'string' ? system : '';
  let usr = user.trim();
  if (typeof period === 'string' && REPORT_PERIODS.has(period as ReportPeriod)) {
    const data = gatherReportData(period as ReportPeriod, typeof projectId === 'string' && projectId ? projectId : undefined);
    // 限定模型必须依据随附真实数据作答，提示所依据周期，避免常识性发挥与用户预期不符
    sys = `${sys}\n本次必须严格依据随附的当前周期真实任务数据进行作答，不得虚构任务或数据；请点明所依据周期（${data.periodLabel} ${data.startDate}~${data.endDate}）。`.trim();
    usr = [
      `【周期=${data.periodLabel} ${data.startDate} ~ ${data.endDate}】`,
      `【项目汇总】${JSON.stringify(data.projects)}`,
      `【任务明细】${JSON.stringify(data.tasks)}`,
      `\n问题：${usr}`,
    ].join('\n\n');
  }

  try {
    res.json(await AIService.ask(toolId, sys, usr));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- AI 控制台持久化并行任务（T00417） ----------
// 与上面同步问答不同：这里 POST 受理后即返回 {id}，真正执行由后台不 await 的 promise 完成并回写库，
// 任务运行不依赖前端会话（页面切换/刷新仍继续），前端靠 GET 轮询收敛为完成态。
const CONSOLE_PERIODS = new Set(['day', 'week', 'month']);
api.post('/console-jobs', (req, res) => {
  const { title, prompt, category, period, toolId } = req.body ?? {};
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt 必填' });
  if (!toolId || typeof toolId !== 'string') return res.status(400).json({ error: 'toolId 必填' });
  const p = typeof period === 'string' && CONSOLE_PERIODS.has(period) ? (period as 'day' | 'week' | 'month') : null;
  const job = ConsoleJobService.create({
    title: title.trim(),
    prompt: prompt.trim(),
    category: typeof category === 'string' && category ? category : 'custom',
    period: p,
  });
  // 不 await：受理即返回，后台 promise 完成后 markDone/markError 回写库
  void ConsoleJobService.runJob(job.id, toolId);
  res.status(201).json({ id: job.id });
});

api.get('/console-jobs', (_req, res) => {
  res.json(ConsoleJobService.list());
});

api.post('/console-jobs/:id/restart', (req, res) => {
  const { toolId } = req.body ?? {};
  if (!toolId || typeof toolId !== 'string') return res.status(400).json({ error: 'toolId 必填' });
  const job = ConsoleJobService.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  ConsoleJobService.reset(req.params.id); // 复用固化 prompt/周期重跑
  void ConsoleJobService.runJob(req.params.id, toolId);
  res.json({ id: job.id });
});

api.delete('/console-jobs/:id', (req, res) => {
  if (!ConsoleJobService.remove(req.params.id)) return res.status(404).json({ error: '任务不存在' });
  res.status(204).end();
});

// 清空全部（「重置控制台」语义）：与 /console-jobs/:id 路径不同，无 id 时不冲突
api.delete('/console-jobs', (_req, res) => {
  ConsoleJobService.clear();
  res.status(204).end();
});

// ---------- 任务智能分类 ----------
api.post('/tasks/classify', async (req, res) => {
  const { title, toolId, categories } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories 必填' });
  try {
    res.json(await AIService.classifyCategory(title, categories, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 提示词优化 ----------
api.post('/ai/optimize', async (req, res) => {
  const { toolId, title, description } = req.body ?? {};
  if (!toolId) return res.status(400).json({ error: 'toolId 必填' });
  try {
    res.json(await AIService.optimizeText(title ?? '', description ?? '', toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 内容指纹（T00435）：规范化标题+正文后哈希，用于转存查重 */
function contentFingerprint(title: string, content: string): string {
  return createHash('sha256').update(`${title.trim()}\n${content.replaceAll(/\s+/g, ' ').trim()}`).digest('hex').slice(0, 24);
}

/** 分类名 → id（带缓存；空名返回空串；不存在则新建），供 AI 分组复用 */
function ensureReqCategory(cats: Map<string, string>, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const hit = cats.get(trimmed);
  if (hit) return hit;
  const exist = getDb().prepare('SELECT id FROM req_categories WHERE name = ?').get(trimmed) as { id: string } | undefined;
  const id = exist?.id ?? ReqCategoryService.create(trimmed).id;
  cats.set(trimmed, id);
  return id;
}

type CreatedReq = { title: string; content: string; categoryId: string; categoryName: string };

/** 手动分组：整批写入指定分类（参数/分类非法抛错，由路由统一映射 400） */
function generalizeManualReq(categoryId: unknown, items: unknown, skipped: string[], created: CreatedReq[]): void {
  if (typeof categoryId !== 'string' || !categoryId) throw new Error('categoryId 必填');
  const catRow = getDb().prepare('SELECT id, name FROM req_categories WHERE id = ?').get(categoryId) as { id: string; name: string } | undefined;
  if (!catRow) throw new Error('归属分类不存在');
  if (!Array.isArray(items)) throw new Error('items 必填');
  for (const it of items) {
    if (!it || typeof it.title !== 'string' || !it.title.trim()) continue;
    const fp = contentFingerprint(it.title, typeof it.content === 'string' ? it.content : '');
    if (ReqEntryService.existsByFingerprint(fp)) { skipped.push(it.title.trim()); continue; }
    const e = ReqEntryService.create({ categoryId, title: it.title.trim(), content: typeof it.content === 'string' ? it.content : '', fingerprint: fp });
    created.push({ title: e.title, content: e.content, categoryId: e.category_id, categoryName: catRow.name });
  }
}

/** AI 智能分组：抽取通用需求并归入最贴切分类（AI/参数异常抛错，由路由统一映射 400） */
async function generalizeAiReq(toolId: unknown, answer: unknown, cats: Map<string, string>, skipped: string[], created: CreatedReq[]): Promise<void> {
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('answer 必填');
  if (typeof toolId !== 'string' || !toolId) throw new Error('toolId 必填（AI 智能分组需要模型工具）');
  const candidate = ReqCategoryService.list().map((c) => c.name);
  if (!candidate.includes('通用')) candidate.push('通用');
  const system = [
    '你是 MTask 的通用需求提炼助手。给定一份“通用需求清单”Markdown，抽取其中具备跨项目复用价值的若干条通用需求（结合“需求标题/适用场景/实现要点/复用价值”四要素），为每一条输出 JSON。',
    '要求：',
    '1. 输出一个 JSON 数组，每元素为 {"title":"需求标题","content":"完整需求描述(Markdown，含适用场景/实现要点/复用价值)","category":"归类分类名"}',
    '2. category 必须从候选分类名中选择最贴切的一个；若无合适分类，选“通用”',
    '3. 只输出 JSON 数组本身，不要任何解释、前后缀、Markdown 代码围栏',
    `候选分类：${candidate.join('、')}`,
  ].join('\n');
  const ai = await AIService.ask(toolId, system, `【通用需求清单】\n${answer.trim()}`);
  if (!ai.ok || !ai.content) throw new Error(`AI 分组失败：${ai.error ?? '模型未返回结果'}`);
  const drafts = parseReqDraft(ai.content);
  if (!drafts.length) throw new Error('AI 未能从清单中解析出通用需求条目，请检查清单格式或改用手动分组');
  for (const d of drafts) {
    const cid = ensureReqCategory(cats, d.category || '通用');
    if (!cid) continue;
    const fp = contentFingerprint(d.title, d.content);
    if (ReqEntryService.existsByFingerprint(fp)) { skipped.push(d.title); continue; }
    const e = ReqEntryService.create({ categoryId: cid, title: d.title, content: d.content, fingerprint: fp });
    const nm = getDb().prepare('SELECT name FROM req_categories WHERE id = ?').get(cid) as { name: string };
    created.push({ title: e.title, content: e.content, categoryId: e.category_id, categoryName: nm.name });
  }
}

// ---------- 通用需求：AI 智能分组 / 批量转存 ----------
// mode='ai'：AI 从 answer（通用需求清单 Markdown）抽取若干条通用需求，自动归入/新建最贴切分类后批量写入 req_entries；
// mode='manual'：按 items [{title,content}] 批量写入指定分类 categoryId。
// 复用 AIService.ask（已有的单轮对话封装），不再引入新的 AI 编排。
api.post('/ai/generalize-to-req', async (req, res) => {
  const { toolId, answer, mode = 'ai', categoryId, items } = req.body ?? {};
  try {
    const skipped: string[] = [];
    // 分类名 -> id 缓存：AI 输出同名分类会重复出现，一次解析后复用，避免重复建分类
    const cats = new Map<string, string>();
    const created: CreatedReq[] = [];

    if (mode === 'manual') {
      // 手动分组：目标分类 + 前端解析好的 items，整批落入同一分类
      generalizeManualReq(categoryId, items, skipped, created);
    } else {
      // AI 智能分组：让模型把清单拆成多条并归入最贴切分类，缺失匹配时兜底到「通用」分类
      await generalizeAiReq(toolId, answer, cats, skipped, created);
    }

    cacheClear('req-categories'); // 新增/新建分类影响分类计数与列表
    res.status(201).json({ ok: true, count: created.length, skipped, entries: created });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 复制到待办（T00436）：提示词 / 通用需求 一键转待办，落到默认记事项目（收件箱） ----------
/** 通用实现：按来源表取标题/内容，创建 tasks 行；目标项目=移动端随手记默认项目（收件箱兜底） */
function createTaskFromSource(table: 'prompts' | 'req_entries', sourceId: string, targetProjectId?: string): { taskId: string; projectId: string; reused: boolean } {
  const src = getDb().prepare(`SELECT id, title, content FROM ${table} WHERE id = ?`).get(sourceId) as { title: string; content: string } | undefined;
  if (!src) throw new Error('来源内容不存在');
  // T00629：支持指定目标项目（提示词/通用需求「复制到待办任务」可选择落到哪个项目）；缺省仍为默认记事项目（收件箱）
  const projectId = targetProjectId ?? getDefaultNoteProjectId();
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('目标项目不存在');
  const prefix = table === 'prompts' ? '[提示词]' : '[通用需求]';
  // T00445 教训：多渠道创建易重复——同项目同标题已存在则直接返回既有任务，不重复插入
  const exist = getDb().prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? LIMIT 1').get(projectId, `${prefix} ${src.title}`) as { id: string } | undefined;
  if (exist) return { taskId: exist.id, projectId, reused: true };
  const id = uuid();
  getDb().prepare(
    `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'normal', 'todo', 0, 0, 0, ?, ?)`,
  ).run(id, projectId, `${prefix} ${src.title}`, src.content || '', now(), now());
  return { taskId: id, projectId, reused: false };
}

/** AI 用量聚合（T00448 / PRD AI-1）：近 N 天概览（按天/按工具）+ 最近明细 */
api.get('/ai/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const db = getDb();
  const summary = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS calls,
            SUM(ok) AS okCalls,
            SUM(1 - ok) AS failCalls,
            CAST(AVG(duration_ms) AS INTEGER) AS avgMs,
            SUM(content_chars) AS contentChars
     FROM ai_usage WHERE created_at >= ? GROUP BY day ORDER BY day`,
  ).all(since);
  const byTool = db.prepare(
    `SELECT tool_name, model, kind, COUNT(*) AS calls,
            SUM(ok) AS okCalls, SUM(1 - ok) AS failCalls,
            CAST(AVG(duration_ms) AS INTEGER) AS avgMs,
            SUM(content_chars) AS contentChars
     FROM ai_usage WHERE created_at >= ? GROUP BY tool_name, model, kind ORDER BY calls DESC`,
  ).all(since);
  const recent = db.prepare(
    `SELECT tool_name, model, kind, ok, duration_ms, content_chars, error, created_at
     FROM ai_usage ORDER BY created_at DESC LIMIT 30`,
  ).all();
  res.json({ days, summary, byTool, recent });
});

api.post('/prompts/:id/to-task', (req, res) => {
  // T00629：可选 projectId——指定待办落到哪个项目（不传则默认记事项目/收件箱）
  const { projectId } = (req.body ?? {}) as { projectId?: unknown };
  try { res.status(201).json({ ok: true, ...createTaskFromSource('prompts', req.params.id, typeof projectId === 'string' && projectId ? projectId : undefined) }); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

api.post('/req-entries/:id/to-task', (req, res) => {
  // T00629：可选 projectId（与提示词页一致，支持指定目标项目）
  const { projectId } = (req.body ?? {}) as { projectId?: unknown };
  try { res.status(201).json({ ok: true, ...createTaskFromSource('req_entries', req.params.id, typeof projectId === 'string' && projectId ? projectId : undefined) }); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// ---------- 归档（FR6） ----------
api.post('/archive', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  res.json(ArchiveService.archive(taskIds));
});

api.post('/archive/restore', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  res.json(ArchiveService.restore(taskIds));
});

api.delete('/archive', (req, res) => {
  const { taskIds } = req.body ?? {};
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: 'taskIds 必填' });
  const removed = ArchiveService.remove(taskIds);
  res.json({ removed });
});

// ---------- 提示词仓库 ----------
api.get('/prompt-categories', (_req, res) => {
  const cached = cacheGet<unknown[]>('prompt-categories');
  if (cached) return res.json(cached);
  const cats = getDb().prepare('SELECT * FROM prompt_categories ORDER BY sort_weight, created_at').all() as { id: string }[];
  const counts = getDb().prepare('SELECT category_id, COUNT(*) AS c FROM prompts WHERE archived = 0 GROUP BY category_id').all() as { category_id: string; c: number }[];
  const countMap = new Map(counts.map((r) => [r.category_id, r.c]));
  const out = cats.map((c) => ({ ...c, promptCount: countMap.get(c.id) ?? 0 }));
  cacheSet('prompt-categories', out, LIST_TTL_MS);
  res.json(out);
});

api.post('/prompt-categories', (req, res) => {
  const { name, description = '' } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
  const id = uuid();
  getDb().prepare('INSERT INTO prompt_categories (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), description, now(), now());
  cacheClear('prompt-categories');
  res.status(201).json(getDb().prepare('SELECT * FROM prompt_categories WHERE id = ?').get(id));
});

api.patch('/prompt-categories/:id', (req, res) => {
  const { name, description } = req.body ?? {};
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (description !== undefined) { sets.push('description = ?'); values.push(description); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE prompt_categories SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('prompt-categories');
  res.json(db.prepare('SELECT * FROM prompt_categories WHERE id = ?').get(req.params.id));
});

api.delete('/prompt-categories/:id', (req, res) => {
  getDb().prepare('DELETE FROM prompt_categories WHERE id = ?').run(req.params.id); // 级联删分类下提示词
  cacheClear('prompt-categories');
  res.status(204).end();
});

api.get('/prompts', (req, res) => {
  const { categoryId, keyword } = req.query;
  const where: string[] = [];
  const values: unknown[] = [];
  where.push('archived = 0'); // T00525：已归档默认不列出
  if (categoryId) { where.push('category_id = ?'); values.push(categoryId); }
  // keyword 显式收窄为 string：query 值可能是数组/对象，隐式字符串化会得到 "[object Object]" 污染 LIKE 条件
  if (typeof keyword === 'string' && keyword) {
    const kw = keyword;
    where.push('(title LIKE ? OR content LIKE ?)');
    values.push(`%${kw}%`, `%${kw}%`);
  }
  // WHERE 子句先独立拼接，避免模板字面量嵌套
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM prompts${whereSql} ORDER BY pinned DESC, CASE WHEN sort_weight = 0 THEN 1 ELSE 0 END, sort_weight, updated_at DESC`;
  res.json(getDb().prepare(sql).all(...values));
});

api.post('/prompts', (req, res) => {
  const { categoryId, title, content = '' } = req.body ?? {};
  if (!categoryId || !title || typeof title !== 'string') return res.status(400).json({ error: 'categoryId 与 title 必填' });
  const id = uuid();
  getDb().prepare('INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, categoryId, title.trim(), content, now(), now());
  cacheClear('prompt-categories'); // 分类计数变化
  res.status(201).json(getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

api.patch('/prompts/:id', (req, res) => {
  const { title, content, categoryId, pinned, color, archived } = req.body ?? {}; // T00490/T00525
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(title); }
  if (content !== undefined) { sets.push('content = ?'); values.push(content); }
  if (categoryId !== undefined) { sets.push('category_id = ?'); values.push(categoryId); }
  if (pinned !== undefined) { sets.push('pinned = ?'); values.push(pinned ? 1 : 0); }
  if (color !== undefined) { sets.push('color = ?'); values.push(String(color)); } // T00490
  if (archived !== undefined) { sets.push('archived = ?'); values.push(archived ? 1 : 0); } // T00525：删除改归档
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updated_at = ?'); values.push(now());
  db.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
  cacheClear('prompt-categories'); // 改分类/置顶影响分类计数与顺序
  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id));
});

api.delete('/prompts/:id', (req, res) => {
  getDb().prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  cacheClear('prompt-categories'); // 分类计数变化
  res.status(204).end();
});

// ---------- 通用需求仓库 ----------
// 分类列表带条目计数（与提示词分类一致，缓存 5s；写端点主动 cacheClear）
api.get('/req-categories', (_req, res) => {
  const cached = cacheGet<unknown[]>('req-categories');
  if (cached) return res.json(cached);
  const out = ReqCategoryService.list();
  cacheSet('req-categories', out, LIST_TTL_MS);
  res.json(out);
});

api.post('/req-categories', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  cacheClear('req-categories');
  res.status(201).json(ReqCategoryService.create(name));
});

api.patch('/req-categories/:id', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name 必填' });
  const cat = ReqCategoryService.rename(req.params.id, name);
  if (!cat) return res.status(404).json({ error: '分类不存在' });
  cacheClear('req-categories');
  res.json(cat);
});

api.delete('/req-categories/:id', (req, res) => {
  // 删除分类会级联删除其下条目（req_entries 外键 ON DELETE CASCADE）
  if (!ReqCategoryService.remove(req.params.id)) return res.status(404).json({ error: '分类不存在' });
  cacheClear('req-categories');
  res.status(204).end();
});

api.get('/req-entries', (req, res) => {
  const { categoryId, keyword } = req.query;
  res.json(ReqEntryService.listByCategory(categoryId as string | undefined, keyword as string | undefined));
});

api.post('/req-entries', (req, res) => {
  const { categoryId, title, content = '' } = req.body ?? {};
  if (!categoryId || !title || typeof title !== 'string') return res.status(400).json({ error: 'categoryId 与 title 必填' });
  // 分类不存在直接映射 400，避免写入悬空外键
  const catExists = getDb().prepare('SELECT 1 FROM req_categories WHERE id = ?').get(categoryId);
  if (!catExists) return res.status(400).json({ error: '归属分类不存在' });
  const entry = ReqEntryService.create({ categoryId, title, content });
  cacheClear('req-categories'); // 分类计数变化
  res.status(201).json(entry);
});

api.patch('/req-entries/:id', (req, res) => {
  const { title, content, categoryId, pinned, color } = req.body ?? {}; // T00490：color
  // 移动分组时校验目标分类存在，避免写入悬空外键
  if (categoryId !== undefined && !getDb().prepare('SELECT 1 FROM req_categories WHERE id = ?').get(categoryId)) {
    return res.status(400).json({ error: '归属分类不存在' });
  }
  const entry = ReqEntryService.update(req.params.id, { title, content, categoryId, pinned, color });
  if (!entry) return res.status(404).json({ error: '条目不存在' });
  cacheClear('req-categories'); // 改分类/置顶影响分类计数与顺序
  res.json(entry);
});

api.delete('/req-entries/:id', (req, res) => {
  if (!ReqEntryService.remove(req.params.id)) return res.status(404).json({ error: '条目不存在' });
  cacheClear('req-categories'); // 分类计数变化
  res.status(204).end();
});

// ---------- 移动端：默认记事项目设置 ----------
// 读取当前默认记事项目（用户设置优先，否则收件箱系统项目）
api.get('/settings/note-project', (_req, res) => {
  res.json({ projectId: getDefaultNoteProjectId(), inboxId: INBOX_PROJECT_ID });
});

// 设置默认记事项目（移动端随手记缺省归属）；仅校验目标项目存在
api.post('/settings/note-project', (req, res) => {
  const { projectId } = req.body ?? {};
  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return res.status(400).json({ error: 'projectId 必填' });
  }
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId.trim())) {
    return res.status(400).json({ error: '项目不存在' });
  }
  setSetting('defaultNoteProjectId', projectId.trim());
  res.json({ projectId: projectId.trim() });
});

// ---------- T00558 / PRD AI-5：周报摘要写入收件箱开关 ----------
api.get('/settings/ai-summary-inbox', (_req, res) => {
  res.json({ enabled: getSetting('report.aiSummaryToInbox') === '1' });
});
api.post('/settings/ai-summary-inbox', (req, res) => {
  setSetting('report.aiSummaryToInbox', req.body?.enabled ? '1' : '0');
  res.json({ ok: true, enabled: Boolean(req.body?.enabled) });
});

// ---------- 设置中心：数据迁移（换机重装用） ----------
api.get('/settings/export', (req, res) => {
  try {
    // 可选 ?tables=a,b,c 子集导出（默认全量）。未知表名直接 400，避免静默产出空包。
    const raw = typeof req.query.tables === 'string' ? req.query.tables.trim() : '';
    if (raw) {
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !isExportTable(n));
      if (bad.length) return res.status(400).json({ error: `未知导出表：${bad.join(', ')}` });
      return res.json(exportBundle(names));
    }
    res.json(exportBundle());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

api.post('/settings/import', (req, res) => {
  const { data, mode } = req.body ?? {};
  if (mode !== 'overwrite' && mode !== 'keep' && mode !== 'merge') {
    return res.status(400).json({ error: 'mode 必填（overwrite|keep|merge）' });
  }
  try {
    res.json(importBundle(data, mode));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 版本更新（关于页）：GitHub Releases 检测最新版本 ----------
// 当前运行版本：回显关于页真实版本（与 package.json 一致），不依赖仓库配置，仅供展示
api.get('/update/version', (_req, res) => {
  res.json({ version: currentAppVersion() });
});

// 配置读取：token 绝不回传明文，只回「是否已配置 + 掩码」
api.get('/update/config', (_req, res) => {
  res.json(getUpdateConfig());
});

// 配置保存：repo 必填且规范化为 owner/repo；token 可选（undefined=不改动，空串=清除）
api.post('/update/config', (req, res) => {
  const { repo, token } = req.body ?? {};
  if (repo !== undefined && (typeof repo !== 'string' || !repo.trim())) {
    return res.status(400).json({ error: '仓库地址非法：请填「owner/repo」或 GitHub 仓库完整 URL' });
  }
  if (token !== undefined && typeof token !== 'string') return res.status(400).json({ error: 'token 非法' });
  try {
    res.json(saveUpdateConfig({ repo, token }));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 连通性测试：用表单未保存的草稿配置拉一次 releases/latest（不落库），返回最新版本号或错误
api.post('/update/test', async (req, res) => {
  const { repo, token } = req.body ?? {};
  if (typeof repo !== 'string') return res.status(400).json({ error: 'repo 必填' });
  res.json(await testUpdateConfig({ repo, token }));
});

// 检查更新：与当前版本比较，返回是否可更新 + 最新版本 + 更新日志 + 下载地址；带 5 分钟缓存
api.post('/update/check', async (req, res) => {
  const force = Boolean(req.body?.force);
  try {
    res.json(await checkUpdate(force));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- 数据库维护（设置 > 数据维护 Tab） ----------
api.use('/dbadmin', dbAdminApi);

// ---------- 项目计划（T00431，菜单位于周报前） ----------
api.use('/plans', planApi);
api.use('/history', historyApi); // T00589：历史资产页面后端（转移 + 统计）
