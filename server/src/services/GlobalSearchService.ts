import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { getDb } from '../db/connection';
import { compileTaskQuery, parseTaskQuery, TaskQuerySyntaxError, type TaskQueryNode } from '../util/taskQuery';

/**
 * T06296（REQ-003 / PRD §A3 / AC-02）：全局搜索服务。
 *
 * 口径：
 * - 只查 MTask 本地库，不索引工作空间外部文件（`/workspace/search` 仍独立）；
 * - 任务与 Run 是本期硬下限；Run 同时覆盖：
 *   1) `agent_runs` 原生 Run（T06293 增量表，当前尚无写入方）；
 *   2) `exec_sessions` 旧执行会话（以任务/平台/阶段/会话 ID 可搜，作为当前可见的执行实例）。
 * - `type:task` / `type:run` / `type:all` 在服务端裁剪，前端不需要二次过滤；
 * - 任务沿用 T03184 的 `status:` / `priority:` / `project:` 语法；非法语法降级为全文并回传原因；
 * - 排序按「精确标题/编号 > 标题前缀 > 标题/正文包含 > 最近更新」；
 * - 每条结果带上下文摘要，零结果返回可执行搜索建议；
 * - 本服务不做写动作，因此不涉及确认/撤销；命令面板中的页面导航仍由前端本地条目承担。
 *
 * 测试可注入内存库（与 InboxService 同口径），生产默认懒取 getDb()，避免模块导入期提前开库。
 */

export type SearchHitType = 'task' | 'run';
export type SearchHitSource = 'task' | 'agent_run' | 'exec_session';
export type SearchMatch = 'exact' | 'prefix' | 'contains' | 'recent';

export interface SearchHit {
  readonly type: SearchHitType;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly taskNo: string | null;
  readonly projectId: string | null;
  readonly projectName: string;
  readonly updatedAt: string | null;
  readonly source: SearchHitSource;
  readonly match: SearchMatch;
  readonly score: number;
}

export interface SearchGroup {
  readonly type: SearchHitType;
  readonly label: string;
  readonly total: number;
  readonly items: SearchHit[];
}

export interface SearchOutOfSight {
  readonly total: number;
  readonly archived: number;
  readonly history: number;
  readonly shelved: number;
}

export interface SearchResponse {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly groups: SearchGroup[];
  readonly total: number;
  readonly limit: number;
  readonly elapsedMs: number;
  readonly degraded: boolean;
  readonly hint: string;
  readonly zeroResult: boolean;
  readonly suggestions: string[];
  readonly outOfSight: SearchOutOfSight;
}

export interface SearchOptions {
  /** 每个对象组最多返回条数，默认 10，最大 25。 */
  readonly limit?: number;
  /** 外部显式指定对象组；与查询里的 type: 同时存在时取交集。 */
  readonly types?: readonly SearchHitType[];
}

interface ParsedInput {
  readonly q: string;
  readonly types: readonly SearchHitType[];
  readonly hints: string[];
}

interface TaskRawRow {
  id: string;
  task_no: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: string;
  project_name: string | null;
  updated_at: string;
  ai_summary: string | null;
  handle_result: string | null;
}

interface NativeRunRawRow {
  id: string;
  task_id: string;
  status: string;
  model: string;
  executor: string;
  prompt_version: string;
  error_code: string;
  started_at: string | null;
  updated_at: string;
  legacy_source: string;
  legacy_ref: string;
  task_no: string | null;
  task_title: string | null;
  project_id: string | null;
  project_name: string | null;
}

interface ExecSessionRawRow {
  id: string;
  session_id: string | null;
  platform: string;
  status: string;
  progress: number;
  phase: string;
  task_ids: string;
  started_at: string;
  last_heartbeat: string;
  finished_at: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_CHARS = 200;

const TASK_STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };
const PRIORITY_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  active: '进行中',
  paused: '已暂停',
  awaiting_approval: '待审批',
  succeeded: '已成功',
  done: '已完成',
  failed: '失败',
  stalled: '已停滞',
  cancelled: '已取消',
  aborted: '已中止',
};

const TYPE_LABEL: Record<SearchHitType, string> = { task: '任务', run: 'Run' };
const ZERO_SUGGESTIONS = [
  '减少关键词，只保留标题中的一个词',
  '按任务编号搜索，例如 T06296',
  '按 Run 会话 ID、阶段或平台搜索，例如 workbuddy',
  '去掉 type: / project: / status: 条件后重试',
];

function clampLimit(value: unknown): number {
  const n = Math.floor(Number(value) || DEFAULT_LIMIT);
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** LIKE 通配符按字面处理，避免用户输入 `%` 把整表拉出来。 */
function likeValue(raw: string): string {
  return raw.replaceAll(/[%_]/g, (m) => `\\${m}`);
}

function likeContains(raw: string): string {
  return `%${likeValue(raw)}%`;
}

function makeSnippet(parts: Array<string | null | undefined>, needle: string, fallback = ''): string {
  const text = parts.map((p) => (p ?? '').replaceAll(/\s+/g, ' ').trim()).find((p) => p.length > 0) ?? fallback;
  if (!text) return '';
  const lower = text.toLowerCase();
  const target = needle.trim().toLowerCase();
  if (!target) return text.slice(0, 160);
  const at = lower.indexOf(target);
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 42);
  const end = Math.min(text.length, start + 160);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 任务结构化语法里可能带自由文本；用于排序分档（字段条件本身不参与标题匹配）。 */
function collectQueryText(node: TaskQueryNode | null): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'field') return '';
  return node.children.map(collectQueryText).filter(Boolean).join(' ').trim();
}

function taskMatch(title: string, taskNo: string | null, needle: string): { match: SearchMatch; score: number } {
  const n = needle.trim().toLowerCase();
  if (!n) return { match: 'recent', score: 3 };
  const t = title.trim().toLowerCase();
  const no = (taskNo ?? '').trim().toLowerCase();
  if (t === n || no === n) return { match: 'exact', score: 0 };
  if (t.startsWith(n) || no.startsWith(n)) return { match: 'prefix', score: 1 };
  return { match: 'contains', score: 2 };
}

function runMatch(id: string, sessionId: string | null, title: string, needle: string): { match: SearchMatch; score: number } {
  const n = needle.trim().toLowerCase();
  if (!n) return { match: 'recent', score: 3 };
  const sid = (sessionId ?? '').toLowerCase();
  const rid = id.toLowerCase();
  const t = title.trim().toLowerCase();
  if (rid === n || sid === n) return { match: 'exact', score: 0 };
  if (rid.startsWith(n) || sid.startsWith(n) || t.startsWith(n)) return { match: 'prefix', score: 1 };
  return { match: 'contains', score: 2 };
}

/**
 * 解析搜索输入：本期只截 `type:` 与 `@me`。
 * `@me` 没有负责人字段可落，不静默当普通文本，而是移除并在 hint 里说明，避免用户以为筛选生效。
 */
function parseInput(raw: string): ParsedInput {
  const hints: string[] = [];
  let q = raw.replaceAll(/\s+/g, ' ').trim();
  const types = new Set<SearchHitType>();

  let sawType = false;
  q = q.replaceAll(/\btype:\s*([a-z]+)/gi, (_all, value: string) => {
    sawType = true;
    const v = value.toLowerCase();
    if (v === 'all') { types.add('task'); types.add('run'); return ''; }
    if (v === 'task' || v === 'run') { types.add(v); return ''; }
    hints.push(`type: 只支持 task / run / all（收到「${value}」）`);
    return '';
  }).replaceAll(/\s+/g, ' ').trim();

  if (/@me\b/i.test(q)) {
    q = q.replaceAll(/@me\b/gi, '').replaceAll(/\s+/g, ' ').trim();
    hints.push('当前任务库没有负责人字段，@me 未生效');
  }

  if (!sawType) { types.add('task'); types.add('run'); }
  if (sawType && types.size === 0) hints.push('对象筛选为空，本次按任务与 Run 一起搜索');
  if (types.size === 0) { types.add('task'); types.add('run'); }

  return { q: q.slice(0, MAX_QUERY_CHARS), types: [...types], hints };
}

export class GlobalSearchService {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
  }

  search(raw: string, options: SearchOptions = {}): SearchResponse {
    const started = performance.now();
    const input = parseInput(String(raw ?? ''));
    let limit = clampLimit(options.limit);
    let types = input.types;
    if (options.types?.length) {
      const wanted = new Set(options.types);
      types = types.filter((t) => wanted.has(t));
      if (types.length === 0) types = [...wanted];
    }
    if (types.length === 0) types = ['task', 'run'];

    const hints = [...input.hints];
    let degraded = false;
    let taskTotal = 0;
    let taskRows: TaskRawRow[] = [];
    let taskNode: TaskQueryNode | null = null;
    if (input.q) {
      try {
        const parsed = parseTaskQuery(input.q);
        if (parsed.mode === 'structured' && parsed.node) taskNode = parsed.node;
      } catch (e) {
        degraded = true;
        hints.push(`查询语法有误（${e instanceof Error ? e.message : String(e)}），已按全文搜索处理`);
      }
    }

    const needsTaskRows = input.q.length > 0;
    if (types.includes('task') || needsTaskRows) {
      const needsCount = types.includes('task');
      const result = this.searchTasks(input.q, taskNode, limit, needsCount);
      taskTotal = result.total;
      taskRows = result.rows;
      if (result.degraded) {
        degraded = true;
        hints.push(result.hint);
      }
    }

    const taskIdsForRun = taskRows.slice(0, 12).map((r) => r.id);
    const native = types.includes('run') ? this.searchNativeRuns(input.q, limit) : { total: 0, rows: [] };
    const exec = types.includes('run') ? this.searchExecSessions(input.q, taskIdsForRun, limit) : { total: 0, rows: [] };

    const nativeHits = native.rows.map((r) => this.nativeHit(r, input.q));
    const nativeLegacyRefs = new Set(
      native.rows
        .filter((r) => r.legacy_source === 'exec_session' && r.legacy_ref)
        .map((r) => r.legacy_ref),
    );
    const execHits = this.execHits(exec.rows, input.q, nativeLegacyRefs);

    const groups: SearchGroup[] = [];
    if (types.includes('task')) {
      groups.push({
        type: 'task',
        label: TYPE_LABEL.task,
        total: taskTotal,
        items: taskRows.map((r) => this.taskHit(r, input.q, taskNode)),
      });
    }
    if (types.includes('run')) {
      const items = [...nativeHits, ...execHits].sort((a, b) => a.score - b.score || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, limit);
      groups.push({ type: 'run', label: TYPE_LABEL.run, total: native.total + exec.total, items });
    }

    const outOfSight = types.includes('task') && input.q
      ? this.countOutOfSight(input.q, taskNode)
      : { total: 0, archived: 0, history: 0, shelved: 0 };
    const total = groups.reduce((sum, g) => sum + g.total, 0);
    const hasItems = groups.some((g) => g.items.length > 0);
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    const hint = hints.filter(Boolean).join('；');

    return {
      query: String(raw ?? '').trim().slice(0, MAX_QUERY_CHARS),
      normalizedQuery: input.q,
      groups,
      total,
      limit,
      elapsedMs,
      degraded,
      hint,
      zeroResult: !hasItems,
      suggestions: hasItems ? [] : ZERO_SUGGESTIONS,
      outOfSight,
    };
  }

  private searchTasks(
    q: string,
    node: TaskQueryNode | null,
    limit: number,
    count: boolean,
  ): { total: number; rows: TaskRawRow[]; degraded: boolean; hint: string } {
    const where: string[] = ['t.archived = 0', "COALESCE(t.history_at, '') = ''", 'COALESCE(t.shelved, 0) = 0'];
    const values: unknown[] = [];
    let degraded = false;
    let hint = '';
    const needle = q ? (node ? collectQueryText(node) : q) : '';

    if (q && node) {
      let compiled: { where: string; values: readonly unknown[] };
      try {
        compiled = compileTaskQuery(node);
        where.push(`(${compiled.where})`);
        values.push(...compiled.values);
      } catch (e) {
        degraded = true;
        hint = e instanceof TaskQuerySyntaxError || e instanceof Error ? e.message : String(e);
        const pattern = likeContains(q);
        where.push(String.raw`(t.title LIKE ? ESCAPE '\' OR t.description LIKE ? ESCAPE '\' OR t.task_no LIKE ? ESCAPE '\')`);
        values.push(pattern, pattern, pattern);
      }
    } else if (q) {
      const pattern = likeContains(q);
      where.push(String.raw`(t.title LIKE ? ESCAPE '\' OR t.description LIKE ? ESCAPE '\' OR t.task_no LIKE ? ESCAPE '\'
        OR COALESCE(t.handle_result, '') LIKE ? ESCAPE '\' OR COALESCE(t.ai_summary, '') LIKE ? ESCAPE '\')`);
      values.push(pattern, pattern, pattern, pattern, pattern);
    }

    const baseWhere = where.join(' AND ');
    let total = 0;
    if (count) total = (this.db.prepare(`SELECT COUNT(*) AS c FROM tasks t WHERE ${baseWhere}`).get(...values) as { c: number }).c;

    const order: string[] = [];
    const orderValues: unknown[] = [];
    if (needle) {
      const exact = needle;
      const prefix = `${likeValue(needle)}%`;
      order.push(String.raw`CASE
        WHEN t.title = ? COLLATE NOCASE THEN 0
        WHEN t.task_no = ? COLLATE NOCASE THEN 0
        WHEN t.task_no LIKE ? ESCAPE '\' THEN 1
        WHEN t.title LIKE ? ESCAPE '\' THEN 1
        ELSE 2 END`);
      orderValues.push(exact, exact, `${prefix}`, `${prefix}`);
    }
    order.push('t.updated_at DESC');

    const rows = this.db.prepare(`
      SELECT t.id, t.task_no, t.title, t.description, t.status, t.priority, t.project_id,
             t.updated_at, t.ai_summary, t.handle_result, p.name AS project_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${baseWhere}
       ORDER BY ${order.join(', ')}
       LIMIT ?
    `).all(...values, ...orderValues, limit) as TaskRawRow[];

    return { total: count ? total : rows.length, rows, degraded, hint };
  }

  private countOutOfSight(q: string, node: TaskQueryNode | null): SearchOutOfSight {
    const where: string[] = ["(t.archived = 1 OR COALESCE(t.history_at, '') <> '' OR COALESCE(t.shelved, 0) = 1)"];
    const values: unknown[] = [];
    if (node) {
      try {
        const compiled = compileTaskQuery(node);
        where.push(`(${compiled.where})`);
        values.push(...compiled.values);
      } catch {
        // 语法错误时与 searchTasks 同一降级口径：按原文全文，不让范围外计数把整次搜索带崩。
        const pattern = likeContains(q);
        where.push(String.raw`(t.title LIKE ? ESCAPE '\' OR t.description LIKE ? ESCAPE '\' OR t.task_no LIKE ? ESCAPE '\')`);
        values.push(pattern, pattern, pattern);
      }
    } else {
      const pattern = likeContains(q);
      where.push(String.raw`(t.title LIKE ? ESCAPE '\' OR t.description LIKE ? ESCAPE '\' OR t.task_no LIKE ? ESCAPE '\')`);
      values.push(pattern, pattern, pattern);
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN t.archived = 1 THEN 1 ELSE 0 END) AS archived,
             SUM(CASE WHEN COALESCE(t.history_at, '') <> '' THEN 1 ELSE 0 END) AS history,
             SUM(CASE WHEN COALESCE(t.shelved, 0) = 1 THEN 1 ELSE 0 END) AS shelved
        FROM tasks t
       WHERE ${where.join(' AND ')}
    `).get(...values) as { total: number | null; archived: number | null; history: number | null; shelved: number | null } | undefined;
    return {
      total: row?.total ?? 0,
      archived: row?.archived ?? 0,
      history: row?.history ?? 0,
      shelved: row?.shelved ?? 0,
    };
  }

  private searchNativeRuns(q: string, limit: number): { total: number; rows: NativeRunRawRow[] } {
    if (!this.hasTable('agent_runs')) return { total: 0, rows: [] };
    const where: string[] = [];
    const values: unknown[] = [];
    const needle = q.trim();
    if (q) {
      const pattern = likeContains(q);
      where.push(String.raw`(ar.id LIKE ? ESCAPE '\' OR ar.model LIKE ? ESCAPE '\' OR ar.executor LIKE ? ESCAPE '\'
        OR ar.prompt_version LIKE ? ESCAPE '\' OR ar.error_code LIKE ? ESCAPE '\'
        OR COALESCE(t.title, '') LIKE ? ESCAPE '\' OR COALESCE(t.task_no, '') LIKE ? ESCAPE '\')`);
      values.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const baseWhere = where.length ? where.join(' AND ') : '1 = 1';
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS c
        FROM agent_runs ar
        LEFT JOIN tasks t ON t.id = ar.task_id
       WHERE ${baseWhere}
    `).get(...values) as { c: number }).c;

    const order: string[] = [];
    const orderValues: unknown[] = [];
    if (needle) {
      order.push(String.raw`CASE WHEN ar.id = ? COLLATE NOCASE THEN 0 WHEN ar.id LIKE ? ESCAPE '\' THEN 1 ELSE 2 END`);
      orderValues.push(needle, `${likeValue(needle)}%`);
    }
    order.push('COALESCE(ar.started_at, ar.created_at) DESC');

    const rows = this.db.prepare(`
      SELECT ar.id, ar.task_id, ar.status, ar.model, ar.executor, ar.prompt_version, ar.error_code,
             ar.started_at, ar.updated_at, ar.legacy_source, ar.legacy_ref,
             t.task_no, t.title AS task_title, t.project_id, p.name AS project_name
        FROM agent_runs ar
        LEFT JOIN tasks t ON t.id = ar.task_id
        LEFT JOIN projects p ON p.id = ar.project_id
       WHERE ${baseWhere}
       ORDER BY ${order.join(', ')}
       LIMIT ?
    `).all(...values, ...orderValues, limit) as NativeRunRawRow[];
    return { total, rows };
  }

  private searchExecSessions(
    q: string,
    taskIds: readonly string[],
    limit: number,
  ): { total: number; rows: ExecSessionRawRow[] } {
    const where: string[] = [];
    const values: unknown[] = [];
    const needle = q.trim();
    if (q) {
      const pattern = likeContains(q);
      where.push(String.raw`(es.id LIKE ? ESCAPE '\' OR COALESCE(es.session_id, '') LIKE ? ESCAPE '\'
        OR es.platform LIKE ? ESCAPE '\' OR es.phase LIKE ? ESCAPE '\' OR es.status LIKE ? ESCAPE '\')`);
      values.push(pattern, pattern, pattern, pattern, pattern);
      if (taskIds.length > 0) {
        const idClauses = taskIds.map(() => 'instr(es.task_ids, ?) > 0');
        where.push(`(${idClauses.join(' OR ')})`);
        values.push(...taskIds);
      }
    }
    const baseWhere = where.length ? where.join(' AND ') : '1 = 1';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM exec_sessions es WHERE ${baseWhere}`).get(...values) as { c: number }).c;

    const order: string[] = [];
    const orderValues: unknown[] = [];
    if (needle) {
      order.push(String.raw`CASE
        WHEN es.id = ? COLLATE NOCASE THEN 0
        WHEN COALESCE(es.session_id, '') = ? COLLATE NOCASE THEN 0
        WHEN es.id LIKE ? ESCAPE '\' THEN 1
        WHEN COALESCE(es.session_id, '') LIKE ? ESCAPE '\' THEN 1
        ELSE 2 END`);
      const prefix = `${likeValue(needle)}%`;
      orderValues.push(needle, needle, prefix, prefix);
    }
    order.push('es.last_heartbeat DESC');

    const rows = this.db.prepare(`
      SELECT es.id, es.session_id, es.platform, es.status, es.progress, es.phase, es.task_ids,
             es.started_at, es.last_heartbeat, es.finished_at
        FROM exec_sessions es
       WHERE ${baseWhere}
       ORDER BY ${order.join(', ')}
       LIMIT ?
    `).all(...values, ...orderValues, limit) as ExecSessionRawRow[];
    return { total, rows };
  }

  private taskHit(r: TaskRawRow, q: string, node: TaskQueryNode | null): SearchHit {
    const needle = q ? (node ? collectQueryText(node) : q) : '';
    const { match, score } = taskMatch(r.title, r.task_no, needle);
    const statusLabel = TASK_STATUS_LABEL[r.status] ?? r.status;
    const priority = PRIORITY_LABEL[r.priority];
    return {
      type: 'task',
      id: r.id,
      title: `${r.task_no ? `${r.task_no} ` : ''}${r.title}`,
      subtitle: [r.project_name ?? '未分配项目', statusLabel, priority ? `${priority}优先级` : ''].filter(Boolean).join(' · '),
      snippet: makeSnippet([r.description, r.handle_result, r.ai_summary], needle, ''),
      status: r.status,
      taskId: r.id,
      taskNo: r.task_no,
      projectId: r.project_id,
      projectName: r.project_name ?? '',
      updatedAt: r.updated_at,
      source: 'task',
      match,
      score,
    };
  }

  private nativeHit(r: NativeRunRawRow, q: string): SearchHit {
    const title = `${r.task_no ? `${r.task_no} ` : ''}${r.task_title ?? ''}`.trim() || `Run ${r.id.slice(0, 8)}`;
    const { match, score } = runMatch(r.id, null, title, q);
    const statusLabel = RUN_STATUS_LABEL[r.status] ?? r.status;
    return {
      type: 'run',
      id: r.id,
      title,
      subtitle: [r.project_name ?? '未分配项目', statusLabel, r.model || '未记录模型', r.executor].filter(Boolean).join(' · '),
      snippet: r.error_code ? `错误码：${r.error_code}` : (r.prompt_version ? `Prompt 版本：${r.prompt_version}` : '原生 Run'),
      status: r.status,
      taskId: r.task_id,
      taskNo: r.task_no,
      projectId: r.project_id,
      projectName: r.project_name ?? '',
      updatedAt: r.started_at ?? r.updated_at,
      source: 'agent_run',
      match,
      score,
    };
  }

  private execHits(rows: readonly ExecSessionRawRow[], q: string, skipIds: ReadonlySet<string>): SearchHit[] {
    if (rows.length === 0) return [];
    const ids = new Set<string>();
    const parsed = new Map<string, string[]>();
    for (const r of rows) {
      let list: string[] = [];
      try {
        const raw = JSON.parse(r.task_ids);
        if (Array.isArray(raw)) list = raw.filter((x): x is string => typeof x === 'string');
      } catch {
        list = [];
      }
      parsed.set(r.id, list);
      for (const id of list) ids.add(id);
    }
    const taskMap = new Map<string, { task_no: string | null; title: string; project_id: string; project_name: string | null }>();
    if (ids.size > 0) {
      const idList = [...ids].slice(0, 200);
      const placeholders = idList.map(() => '?').join(',');
      const taskRows = this.db.prepare(`
        SELECT t.id, t.task_no, t.title, t.project_id, p.name AS project_name
          FROM tasks t
          LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.id IN (${placeholders})
      `).all(...idList) as Array<{ id: string; task_no: string | null; title: string; project_id: string; project_name: string | null }>;
      for (const t of taskRows) taskMap.set(t.id, t);
    }
    const needle = q.trim().toLowerCase();
    const out: SearchHit[] = [];
    for (const r of rows) {
      if (skipIds.has(r.id)) continue;
      const list = parsed.get(r.id) ?? [];
      const firstTask = list.map((id) => taskMap.get(id)).find(Boolean);
      const matchedTask = needle
        ? list.map((id) => taskMap.get(id)).find((t) => t && (`${t.task_no ?? ''} ${t.title}`.toLowerCase().includes(needle)))
        : null;
      const displayTask = matchedTask ?? firstTask;
      const title = displayTask ? `${displayTask.task_no ? `${displayTask.task_no} ` : ''}${displayTask.title}` : `会话 ${r.session_id ?? r.id.slice(0, 8)}`;
      const { match, score } = runMatch(r.id, r.session_id, title, q);
      const statusLabel = RUN_STATUS_LABEL[r.status] ?? r.status;
      const pct = Math.max(0, Math.min(100, Math.round(r.progress ?? 0)));
      out.push({
        type: 'run',
        id: r.id,
        title,
        subtitle: [displayTask?.project_name ?? '未分配项目', r.platform, statusLabel, r.phase].filter(Boolean).join(' · '),
        snippet: r.phase ? `阶段：${r.phase} · 进度 ${pct}%` : `进度 ${pct}%`,
        status: r.status,
        taskId: displayTask ? list.find((id) => taskMap.get(id) === displayTask) ?? null : null,
        taskNo: displayTask?.task_no ?? null,
        projectId: displayTask?.project_id ?? null,
        projectName: displayTask?.project_name ?? '',
        updatedAt: r.finished_at ?? r.last_heartbeat ?? r.started_at,
        source: 'exec_session',
        match,
        score,
      });
    }
    return out;
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }
}

/** 路由层共用：解析 ?type=task,run；非法值忽略。 */
export function parseSearchTypes(raw: unknown): SearchHitType[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: SearchHitType[] = [];
  for (const part of text.split(',')) {
    const v = part.trim().toLowerCase();
    if (v === 'task' || v === 'run') out.push(v);
  }
  return out;
}
