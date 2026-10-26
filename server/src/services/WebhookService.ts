/**
 * T03196（PRD PM-401）：项目级 outbound Webhook。
 *
 * 边界：只有出站，不做 inbound；外部写入仍走既有 API Token / MCP。
 * - 配置校验：HTTPS only、URL 不得内嵌凭据、内网地址需显式确认、事件白名单；
 * - 投递：事件后立即尝试（响应超时 5s），失败按 1/5/30 分钟重试三次（合计最多 4 次），
 *   投递记录落库 → 应用重启后 `startDeliveryTimer` 能把待重试项续跑；
 * - 签名：`X-MTask-Signature: sha256=HMAC-SHA256(secret, rawBody)`，并带事件 ID/时间戳供接收方幂等；
 * - 安全：密钥 AES-GCM 加密存储，接口只回掩码；payload 按事件白名单最小化；日志不存响应正文与 URL 凭据。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection';
import { decrypt, encrypt, maskSecret } from '../util/crypto';
import { OverdueRateService } from './OverdueRateService';
import { ymdInTimezone } from '../util/workdays';

export const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.done',
  'plan.created', 'plan.updated', 'plan.done',
  'overdue.detected',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** 首次 + 三次重试；下标 = 已完成尝试次数 - 1 */
const RETRY_MINUTES = [1, 5, 30] as const;
const MAX_ATTEMPTS = 1 + RETRY_MINUTES.length;
const RESPONSE_TIMEOUT_MS = 5000;
const LOG_RETENTION_DAYS = 30;
/** 同一投递行并发保护（定时器与立即尝试可能同时命中） */
const inFlight = new Set<string>();

interface WebhookRow {
  id: string;
  project_id: string;
  url: string;
  secret_enc: string;
  events: string;
  enabled: number;
  allow_intranet: number;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  project_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  response_status: number | null;
  error: string | null;
  created_at: string;
}

export interface WebhookView {
  id: string;
  projectId: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  allowIntranet: boolean;
  secretMasked: string;
  createdAt: string;
  updatedAt: string;
  stats: { pending: number; success: number; failed: number };
}

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
}

const now = (): string => new Date().toISOString();

function parseEvents(raw: unknown): WebhookEventType[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const v of arr) {
    const name = String(v);
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(name)) {
      throw new Error(`不支持的事件类型：${name}（可选 ${WEBHOOK_EVENTS.join(' / ')}）`);
    }
    seen.add(name);
  }
  if (seen.size === 0) throw new Error('至少订阅一个事件');
  return [...seen] as WebhookEventType[];
}

/** 内网/回环主机识别（仅字面量；DNS 解析结果不在同步校验范围，URL 仍受 HTTPS 约束） */
function isIntranetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

function normalizeUrl(raw: string, allowIntranet: boolean): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('Webhook URL 不合法');
  }
  if (u.protocol !== 'https:') throw new Error('Webhook 仅支持 HTTPS');
  if (u.username || u.password) throw new Error('Webhook URL 不得内嵌凭据');
  if (!u.hostname) throw new Error('Webhook URL 缺少主机名');
  if (isIntranetHost(u.hostname) && !allowIntranet) {
    throw new Error('内网地址需显式确认（allowIntranet=true）后再保存');
  }
  return u.toString();
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function eventIdOf(projectId: string, date: string): string {
  return `overdue-${projectId}-${date}`;
}

export const WebhookService = {
  list(projectId: string): WebhookView[] {
    const db = getDb();
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const rows = db.prepare(
      'SELECT * FROM webhooks WHERE project_id = ? ORDER BY created_at DESC',
    ).all(projectId) as WebhookRow[];
    return rows.map((r) => {
      const stats = db.prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM webhook_deliveries WHERE webhook_id = ?`,
      ).get(r.id) as { pending: number | null; success: number | null; failed: number | null };
      let secret = '';
      try { secret = decrypt(r.secret_enc); } catch { /* 主密钥不匹配时只显示空掩码 */ }
      return {
        id: r.id,
        projectId: r.project_id,
        url: r.url,
        events: JSON.parse(r.events) as WebhookEventType[],
        enabled: Boolean(r.enabled),
        allowIntranet: Boolean(r.allow_intranet),
        secretMasked: secret ? maskSecret(secret) : '（密钥不可读，请重录）',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        stats: { pending: stats.pending ?? 0, success: stats.success ?? 0, failed: stats.failed ?? 0 },
      };
    });
  },

  create(input: { projectId?: string; url?: string; events?: unknown; secret?: string; allowIntranet?: boolean }): WebhookView {
    const db = getDb();
    const projectId = String(input.projectId ?? '');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
    const allowIntranet = Boolean(input.allowIntranet);
    const url = normalizeUrl(String(input.url ?? ''), allowIntranet);
    const events = parseEvents(input.events);
    const secret = input.secret === undefined || input.secret === '' ? randomBytes(32).toString('hex') : String(input.secret);
    if (secret.length < 16) throw new Error('Webhook 密钥至少 16 个字符');
    const id = uuid();
    const t = now();
    db.prepare(
      `INSERT INTO webhooks (id, project_id, url, secret_enc, events, enabled, allow_intranet, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, projectId, url, encrypt(secret), JSON.stringify(events), allowIntranet ? 1 : 0, t, t);
    return this.get(id)!;
  },

  get(id: string): WebhookView | null {
    const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
    if (!row) return null;
    return this.list(row.project_id).find((w) => w.id === id) ?? null;
  },

  update(id: string, patch: { url?: string; events?: unknown; secret?: string; enabled?: boolean; allowIntranet?: boolean }): WebhookView {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
    if (!row) throw new Error('Webhook 不存在');
    const allowIntranet = patch.allowIntranet === undefined ? Boolean(row.allow_intranet) : Boolean(patch.allowIntranet);
    const url = normalizeUrl(patch.url === undefined ? row.url : patch.url, allowIntranet);
    const events = patch.events === undefined ? (JSON.parse(row.events) as WebhookEventType[]) : parseEvents(patch.events);
    const enabled = patch.enabled === undefined ? Boolean(row.enabled) : Boolean(patch.enabled);
    let secretEnc = row.secret_enc;
    if (patch.secret !== undefined && patch.secret !== '') {
      if (String(patch.secret).length < 16) throw new Error('Webhook 密钥至少 16 个字符');
      secretEnc = encrypt(String(patch.secret));
    }
    db.transaction(() => {
      db.prepare(
        `UPDATE webhooks SET url = ?, events = ?, enabled = ?, allow_intranet = ?, secret_enc = ?, updated_at = ? WHERE id = ?`,
      ).run(url, JSON.stringify(events), enabled ? 1 : 0, allowIntranet ? 1 : 0, secretEnc, now(), id);
      // 停用即取消未执行重试（PM-401⑥）；保留历史日志供复盘
      if (!enabled) {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'failed', error = '配置已停用，取消待执行投递', next_attempt_at = NULL
             WHERE webhook_id = ? AND status = 'pending'`,
        ).run(id);
      }
    })();
    return this.get(id)!;
  },

  /** 删除配置（连带投递日志）；PRD 只要求停用，这里提供物理删除供清理测试数据 */
  remove(id: string): boolean {
    const r = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return r.changes > 0;
  },

  deliveries(webhookId: string, limit = 20): DeliveryView[] {
    const db = getDb();
    if (!db.prepare('SELECT id FROM webhooks WHERE id = ?').get(webhookId)) throw new Error('Webhook 不存在');
    const rows = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(webhookId, Math.min(100, Math.max(1, limit))) as DeliveryRow[];
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastAttemptAt: r.last_attempt_at,
      responseStatus: r.response_status,
      error: r.error,
      createdAt: r.created_at,
    }));
  },

  /** 测试投递：绕过事件订阅但同样走签名与超时链路 */
  test(id: string): { deliveryId: string } {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
    if (!row) throw new Error('Webhook 不存在');
    if (!row.enabled) throw new Error('配置已停用，请先启用');
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string } | undefined;
    const eventId = `test-${uuid()}`;
    const deliveryId = this.enqueue(row, 'webhook.test', eventId, {
      eventId,
      eventType: 'webhook.test',
      occurredAt: now(),
      project: { id: row.project_id, name: project?.name ?? '' },
    });
    if (!deliveryId) throw new Error('投递记录写入失败');
    return { deliveryId };
  },

  /** 内部：写入投递行并立即尝试一次；返回 null 表示该 Webhook 未订阅此事件 */
  enqueue(hook: WebhookRow, eventType: string, eventId: string, payload: Record<string, unknown>): string | null {
    const id = uuid();
    const r = getDb().prepare(
      `INSERT OR IGNORE INTO webhook_deliveries
         (id, webhook_id, project_id, event_id, event_type, payload, status, attempts, next_attempt_at, last_attempt_at, response_status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?)`,
    ).run(id, hook.id, hook.project_id, eventId, eventType, JSON.stringify(payload), now(), now());
    if (r.changes === 0) return null;
    setImmediate(() => { void this.attempt(id); });
    return id;
  },

  /** 事件分发：按项目找启用且订阅该事件的配置 */
  emit(eventType: WebhookEventType, projectId: string, eventId: string, data: Record<string, unknown>): void {
    if (!projectId) return;
    const db = getDb();
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    const hooks = db.prepare('SELECT * FROM webhooks WHERE project_id = ? AND enabled = 1').all(projectId) as WebhookRow[];
    if (hooks.length === 0) return;
    const payload = {
      eventId,
      eventType,
      occurredAt: now(),
      project: { id: projectId, name: project?.name ?? '' },
      ...data,
    };
    for (const hook of hooks) {
      const subscribed = (JSON.parse(hook.events) as string[]).includes(eventType);
      if (subscribed) this.enqueue(hook, eventType, eventId, payload);
    }
  },

  /** TaskService 事件钩子：状态变更/验证/结果回传 → task.updated|task.done */
  onTaskEvent(db: ReturnType<typeof getDb>, taskId: string, kind: string, detail: string): void {
    if (kind !== 'status' && kind !== 'verified' && kind !== 'result') return;
    const row = db.prepare(
      'SELECT project_id, task_no, status, priority, title FROM tasks WHERE id = ?',
    ).get(taskId) as { project_id: string; task_no: string | null; status: string; priority: string; title: string } | undefined;
    if (!row) return;
    const type: WebhookEventType = kind === 'status' && /→\s*done/.test(detail) ? 'task.done' : 'task.updated';
    this.emit(type, row.project_id, `task-${uuid()}`, {
      task: { id: taskId, taskNo: row.task_no, status: row.status, priority: row.priority, title: row.title.slice(0, 200) },
    });
  },

  /** 任务创建钩子（create 路径原本不写 task_events，单独埋点） */
  onTaskCreated(taskId: string): void {
    const row = getDb().prepare(
      'SELECT project_id, task_no, status, priority, title FROM tasks WHERE id = ?',
    ).get(taskId) as { project_id: string; task_no: string | null; status: string; priority: string; title: string } | undefined;
    if (!row) return;
    this.emit('task.created', row.project_id, `task-created-${taskId}`, {
      task: { id: taskId, taskNo: row.task_no, status: row.status, priority: row.priority, title: row.title.slice(0, 200) },
    });
  },

  /** 计划事件钩子（create/update/archive 调用） */
  onPlanEvent(type: 'plan.created' | 'plan.updated' | 'plan.done', plan: { id: string; project_id: string; title: string; status: string; progress: number }): void {
    this.emit(type, plan.project_id, `plan-${uuid()}`, {
      plan: { id: plan.id, title: plan.title.slice(0, 200), status: plan.status, progress: plan.progress },
    });
  },

  /**
   * 逾期事件：按项目发一次「今日新增逾期」信号，事件 ID 用项目+日期去重，
   * 定时器每轮重复扫描也不会给接收方刷重复事件（UNIQUE(webhook_id,event_id)）。
   */
  scanOverdue(): void {
    const today = ymdInTimezone(new Date());
    const db = getDb();
    const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
    for (const p of projects) {
      let bucket: { dueTotal: number; overdue: number; rate: number | null };
      try {
        bucket = OverdueRateService.report({ at: today, projectId: p.id }).overall;
      } catch {
        continue;
      }
      if (bucket.overdue <= 0) continue;
      this.emit('overdue.detected', p.id, eventIdOf(p.id, today), {
        overdue: { date: today, dueTotal: bucket.dueTotal, overdue: bucket.overdue, rate: bucket.rate },
      });
    }
  },

  /** 单次投递尝试（失败按 1/5/30 分钟安排下一次） */
  async attempt(deliveryId: string): Promise<void> {
    if (inFlight.has(deliveryId)) return;
    inFlight.add(deliveryId);
    const db = getDb();
    try {
      const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId) as DeliveryRow | undefined;
      if (!d || d.status !== 'pending') return;
      const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(d.webhook_id) as WebhookRow | undefined;
      if (!hook) return;
      if (!hook.enabled) {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'failed', error = '配置已停用，取消待执行投递', next_attempt_at = NULL WHERE id = ?`,
        ).run(deliveryId);
        return;
      }
      const attempts = d.attempts + 1;
      const startedAt = now();
      let secret: string;
      try {
        secret = decrypt(hook.secret_enc);
      } catch {
        this.finish(deliveryId, 'failed', attempts, startedAt, null, '密钥不可读，投递中止', null);
        return;
      }
      let responseStatus: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'MTask-Webhook/1.0',
            'X-MTask-Event-Id': d.event_id,
            'X-MTask-Timestamp': startedAt,
            'X-MTask-Signature': sign(secret, d.payload),
          },
          body: d.payload,
        });
        responseStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          this.finish(deliveryId, 'success', attempts, startedAt, res.status, null, null);
          return;
        }
        error = res.status >= 300 && res.status < 400
          ? `目标返回重定向（HTTP ${res.status}），已拒绝以免降级到非 HTTPS`
          : `目标返回 HTTP ${res.status}`;
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        error = name === 'TimeoutError' || name === 'AbortError'
          ? `请求超时（${RESPONSE_TIMEOUT_MS / 1000} 秒上限）`
          : `投递失败：${e instanceof Error ? e.message : String(e)}`;
      }
      if (attempts >= MAX_ATTEMPTS) {
        this.finish(deliveryId, 'failed', attempts, startedAt, responseStatus, error, null);
      } else {
        const waitMin = RETRY_MINUTES[attempts - 1];
        const next = new Date(Date.now() + waitMin * 60_000).toISOString();
        this.finish(deliveryId, 'pending', attempts, startedAt, responseStatus, error, next);
      }
    } finally {
      inFlight.delete(deliveryId);
    }
  },

  finish(
    id: string, status: 'pending' | 'success' | 'failed', attempts: number, lastAttemptAt: string,
    responseStatus: number | null, error: string | null, nextAttemptAt: string | null,
  ): void {
    getDb().prepare(
      `UPDATE webhook_deliveries
          SET status = ?, attempts = ?, last_attempt_at = ?, response_status = ?, error = ?, next_attempt_at = ?
        WHERE id = ?`,
    ).run(status, attempts, lastAttemptAt, responseStatus, error ? error.slice(0, 300) : null, nextAttemptAt, id);
  },

  /** 定时器入口：所有到期且未成功的投递（含重启前遗留） */
  processDue(at: Date = new Date()): number {
    const rows = getDb().prepare(
      `SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY next_attempt_at LIMIT 50`,
    ).all(at.toISOString()) as Array<{ id: string }>;
    for (const r of rows) void this.attempt(r.id);
    return rows.length;
  },

  pruneLogs(at: Date = new Date()): number {
    const cutoff = new Date(at.getTime() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
    return getDb().prepare(
      `DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < ?`,
    ).run(cutoff).changes;
  },

  startDeliveryTimer(intervalMs = 30_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      try {
        this.processDue();
        this.pruneLogs();
      } catch {
        /* 单轮失败不终止定时器 */
      }
    }, intervalMs);
    timer.unref?.();
    const boot = setTimeout(() => {
      try {
        this.processDue();
        this.scanOverdue();
      } catch { /* 启动恢复失败留给下一轮 */ }
    }, 1500);
    boot.unref?.();
    return timer;
  },
};
