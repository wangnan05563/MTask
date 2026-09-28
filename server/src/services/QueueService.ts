import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { type TaskView } from './TaskService';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';
import { logService } from './LogService';
import { getSetting } from './AppSettings';
import { TaskService } from './TaskService';
import { notifyChange } from './ChangeBus';
import type { SubmitResult, PollResult } from '../adapters/types';

/** 队列列表 TTL：读多写少，5s 内允许过期值，写操作会主动 cacheClear 保证一致 */
const LIST_TTL_MS = 5000;

export interface QueueRow {
  id: string;
  name: string;
  date: string;
  status: string;
  created_at: string;
}

export interface QueueJobRow {
  id: string;
  queue_id: string;
  task_id: string;
  tool_id: string;
  order_index: number;
  status: string;
  request_payload: string | null;
  response_payload: string | null;
  error: string | null;
  sent_at: string | null;
  finished_at: string | null;
  ticket: string | null;
  submitted_at: string | null;
}

export interface QueueItemInput {
  taskId: string;
  toolId: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * 提交单个 Job 并落库状态；返回该 Job 是否进入异步在途（受理 ticket，等待 poller 收敛）。
 * 从 submitAll 拆出以降低其认知复杂度；单 Job 提交异常按 failed 落库而不上抛，
 * 保证队列循环内单点失败不影响其余 Job（与拆分前行为一致）。
 */
/**
 * 队列自动回写（T00453 / PRD INT-4）：Job 成功后把关联待办置为 done——
 * 触发 TaskService 内部的计划反向联动（linked plan 同步 done）。
 * 设置项 queue.autoCompleteTask=0 可关闭（KV：AppSettings）；默认开启。
 */
function autoCompleteQueueTask(taskId: string): void {
  if (getSetting('queue.autoCompleteTask') === '0') return;
  try {
    const t = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (!t || t.status === 'done') return;
    TaskService.setStatus(taskId, 'done');
    logService.log('INFO', 'queue', `队列自动回写：task=${taskId.slice(0, 8)} → done（queue.autoCompleteTask 开启）`);
  } catch (e) {
    logService.log('ERROR', 'queue', `队列自动回写失败：task=${taskId.slice(0, 8)}，${e instanceof Error ? e.message : String(e)}`);
  }
}

async function submitOneJob(
  job: QueueJobRow,
  submit: (job: QueueJobRow) => Promise<SubmitResult>,
): Promise<boolean> {
  const db = getDb();
  db.prepare("UPDATE queue_jobs SET status = 'sending', sent_at = ? WHERE id = ?").run(now(), job.id);
  logService.log('INFO', 'queue', `队列任务提交：job=${job.id.slice(0, 8)}（task=${job.task_id.slice(0, 8)}）`);
  try {
    const result = await submit(job);
    if (result.ok && typeof result.content === 'string') {
      // 同步完成：直接置 success（ticket 清空、submitted_at 记为完成时刻）
      db.prepare(
        "UPDATE queue_jobs SET status = 'success', response_payload = ?, error = NULL, ticket = NULL, submitted_at = ?, finished_at = ? WHERE id = ?",
      ).run(result.content, now(), now(), job.id);
      logService.log('INFO', 'queue', `队列任务同步完成：job=${job.id.slice(0, 8)}（响应 ${result.content.length} 字符）`);
      autoCompleteQueueTask(job.task_id);
      notifyChange('queue');
      return false;
    }
    if (result.ok && result.accepted) {
      // 异步受理：记录回执标识与提交时间，等待 poller 收敛
      db.prepare("UPDATE queue_jobs SET status = 'sending', ticket = ?, submitted_at = ? WHERE id = ?")
        .run(result.ticket ?? null, now(), job.id);
      logService.log('INFO', 'queue', `队列任务已受理（异步）：job=${job.id.slice(0, 8)}，等待回执收敛`);
      return true;
    }
    db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(result.error ?? '提交失败', now(), job.id);
    logService.log('ERROR', 'queue', `队列任务提交失败：job=${job.id.slice(0, 8)}，原因=${result.error ?? '提交失败'}`);
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(msg, now(), job.id);
    logService.log('ERROR', 'queue', `队列任务提交异常：job=${job.id.slice(0, 8)}，${msg}`);
    return false;
  }
}

/**
 * FR4 每日任务队列：构建 → 触发 → Job 状态机（queued/sending/success/failed/timeout）→ 回执落库。
 * 参考：OpenHands Agent 控制器 / LibreChat Subagents 的轻量编排（同类产品分析报告 4.3）。
 */
export const QueueService = {
  /** FR4.1 创建队列 */
  create(name: string, date: string): QueueRow {
    const db = getDb();
    const id = uuid();
    db.prepare('INSERT INTO queues (id, name, date, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, date, 'draft', now());
    cacheClear('queues'); // 列表缓存失效，保证新建立即可见
    return this.getById(id)!;
  },

  getById(id: string): QueueRow | null {
    const row = getDb().prepare('SELECT * FROM queues WHERE id = ?').get(id) as QueueRow | undefined;
    return row ?? null;
  },

  list() {
    const cached = cacheGet<QueueRow[]>('queues');
    if (cached) return cached;
    const rows = getDb().prepare('SELECT * FROM queues ORDER BY date DESC, created_at DESC').all() as QueueRow[];
    cacheSet('queues', rows, LIST_TTL_MS);
    return rows;
  },

  /** 向队列追加任务项（绑定目标 AI 工具，支持跨项目） */
  addJobs(queueId: string, items: QueueItemInput[]): QueueJobRow[] {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status !== 'draft') throw new Error('仅草稿队列可编辑');
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM queue_jobs WHERE queue_id = ?').get(queueId) as { m: number }).m;
    const insert = db.prepare(
      `INSERT INTO queue_jobs (id, queue_id, task_id, tool_id, order_index, status) VALUES (?, ?, ?, ?, ?, 'queued')`
    );
    const ids: string[] = [];
    db.transaction(() => {
      items.forEach((item, i) => {
        const jobId = uuid();
        insert.run(jobId, queueId, item.taskId, item.toolId, maxOrder + 1 + i);
        ids.push(jobId);
      });
    })();
    return ids.map((id) => this.getJob(id)!);
  },

  getJob(id: string): QueueJobRow | null {
    const row = getDb().prepare('SELECT * FROM queue_jobs WHERE id = ?').get(id) as QueueJobRow | undefined;
    return row ?? null;
  },

  listJobs(queueId: string): QueueJobRow[] {
    return getDb().prepare('SELECT * FROM queue_jobs WHERE queue_id = ? ORDER BY order_index').all(queueId) as QueueJobRow[];
  },

  /** 队列详情用：LEFT JOIN 附带任务标题与工具名称（task/工具可能已删，用 LEFT JOIN 保行） */
  listJobsDetailed(queueId: string): Array<QueueJobRow & { task_title: string | null; tool_name: string | null }> {
    return getDb().prepare(
      `SELECT j.*, t.title AS task_title, a.name AS tool_name
       FROM queue_jobs j
       LEFT JOIN tasks t    ON t.id = j.task_id
       LEFT JOIN ai_tools a ON a.id = j.tool_id
       WHERE j.queue_id = ?
       ORDER BY j.order_index`
    ).all(queueId) as Array<QueueJobRow & { task_title: string | null; tool_name: string | null }>;
  },

  /** T01298：移除队列中的单个任务项——sending（在途）不可移除，避免后台 poller 更新已删行 */
  removeJob(queueId: string, jobId: string): void {
    const job = this.getJob(jobId);
    if (!job || job.queue_id !== queueId) return;
    if (job.status === 'sending') throw new Error('任务正在发送中，不可移除');
    getDb().prepare('DELETE FROM queue_jobs WHERE id = ? AND queue_id = ?').run(jobId, queueId);
  },

  /** T01298：删除整个队列——queue_jobs 随 FK ON DELETE CASCADE 级联清理；running 中禁止删除 */
  remove(queueId: string): void {
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status === 'running') throw new Error('队列正在发送中，不可删除');
    getDb().prepare('DELETE FROM queues WHERE id = ?').run(queueId);
    cacheClear('queues');
  },

  /** FR4.2 触发：逐 Job 发送（串行保序）。由 AIService 注入真实发送函数，便于测试。 */
  async sendAll(queueId: string, send: (job: QueueJobRow) => Promise<{ ok: boolean; content?: string; error?: string }>) {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status === 'running') throw new Error('队列正在发送中');
    db.prepare("UPDATE queues SET status = 'running' WHERE id = ?").run(queueId);
    const jobs = this.listJobs(queueId);
    try {
      for (const job of jobs) {
        if (job.status === 'success') continue; // 已成功的不重复发送
        db.prepare("UPDATE queue_jobs SET status = 'sending', sent_at = ? WHERE id = ?").run(now(), job.id);
        try {
          const result = await send(job);
          db.prepare(
            "UPDATE queue_jobs SET status = ?, response_payload = ?, error = ?, finished_at = ? WHERE id = ?"
          ).run(result.ok ? 'success' : 'failed', result.content ?? null, result.error ?? null, now(), job.id);
          if (result.ok) autoCompleteQueueTask(job.task_id);
          notifyChange('queue');
        } catch (e) {
          db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
            .run(e instanceof Error ? e.message : String(e), now(), job.id);
        }
      }
      db.prepare("UPDATE queues SET status = 'finished' WHERE id = ?").run(queueId);
      return this.listJobs(queueId);
    } catch (e) {
      db.prepare("UPDATE queues SET status = 'failed' WHERE id = ?").run(queueId);
      throw e;
    }
  },

  /** FR4.5 失败重试：将 failed/timeout Job 重置为 queued */
  resetFailed(queueId: string): void {
    getDb().prepare("UPDATE queue_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE queue_id = ? AND status IN ('failed', 'timeout')")
      .run(queueId);
  },

  /**
   * 异步提交（FR4.2 异步路径）：逐 Job 调用 submit()，不再阻塞等待完整结果。
   * - 同步即返回（accepted=false + content）→ 直接置 success
   * - 异步受理（accepted=true + ticket）→ 保持 sending 并记录 ticket/submitted_at，交由 pollPending 轮询收口
   * - 提交失败 → failed
   * 由 AIService.buildSubmitter 注入实际提交函数；对不支持 submit 的同步工具，该闭包自动回退 send。
   */
  async submitAll(queueId: string, submit: (job: QueueJobRow) => Promise<SubmitResult>) {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status === 'running') throw new Error('队列正在发送中');
    db.prepare("UPDATE queues SET status = 'running' WHERE id = ?").run(queueId);
    const jobs = this.listJobs(queueId);
    let anySending = false;
    try {
      for (const job of jobs) {
        if (job.status === 'success') continue; // 已成功的不重复提交
        if (await submitOneJob(job, submit)) anySending = true;
      }
      // 仍有异步在途 → 队列保持 running，待 poller 收敛后再置 finished
      db.prepare("UPDATE queues SET status = ? WHERE id = ?").run(anySending ? 'running' : 'finished', queueId);
      return this.listJobs(queueId);
    } catch (e) {
      db.prepare("UPDATE queues SET status = 'failed' WHERE id = ?").run(queueId);
      throw e;
    }
  },

  /**
   * 异步收口（FR4.2 回调/轮询路径）：轮询所有"已受理待回执"（sending + 有 ticket）的 Job。
   * - success → 写回 response_payload 并完成
   * - failed/timeout → 写失败并打时间戳
   * - running → 保持 sending 继续等待（超时判定由 buildPoller 依据各工具 timeoutMs 完成）
   * 队列内无在途 sending 时收敛为 finished。
   */
  async pollPending(poll: (job: QueueJobRow, ticket: string) => Promise<PollResult>): Promise<void> {
    const db = getDb();
    const jobs = db
      .prepare("SELECT * FROM queue_jobs WHERE status = 'sending' AND ticket IS NOT NULL")
      .all() as QueueJobRow[];
    const affectedQueues = new Set<string>();
    for (const job of jobs) {
      affectedQueues.add(job.queue_id);
      try {
        const result = await poll(job, job.ticket!);
        if (result.status === 'success') {
          db.prepare("UPDATE queue_jobs SET status = 'success', response_payload = ?, error = NULL, finished_at = ? WHERE id = ?")
            .run(result.content ?? null, now(), job.id);
          autoCompleteQueueTask(job.task_id);
          notifyChange('queue');
        } else if (result.status === 'failed' || result.status === 'timeout') {
          db.prepare("UPDATE queue_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?")
            .run(result.status, result.error ?? null, now(), job.id);
        }
        // running → 不动
      } catch (e) {
        db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
          .run(e instanceof Error ? e.message : String(e), now(), job.id);
      }
    }
    for (const qid of affectedQueues) {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM queue_jobs WHERE queue_id = ? AND status = 'sending'").get(qid) as { c: number };
      if (pending.c === 0) db.prepare("UPDATE queues SET status = 'finished' WHERE id = ?").run(qid);
    }
  },

  /** 快照任务上下文到 request_payload（发送前固化，避免任务被改导致回执错位） */
  snapshotTaskContext(task: TaskView, projectName: string): string {
    return JSON.stringify({
      taskId: task.id,
      title: task.title,
      description: task.description,
      aiSummary: task.ai_summary,
      projectName,
      priority: task.priority,
    }, null, 2);
  },
};
