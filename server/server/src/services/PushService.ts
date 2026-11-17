/**
 * T01440（mtask三期 4.1）：Web Push 推送服务。
 * - VAPID 密钥对：首启自动生成并持久化到 app_settings；
 * - 订阅管理：push_subscriptions 表（endpoint 唯一）；
 * - 推送触发：任务 ai_state 置 failed、监督器 ESCALATE（fire-and-forget，失败仅日志）。
 */
import webpush from 'web-push';
import { getDb } from '../db/connection';

const VAPID_KEY = 'push.vapid';
const SUB_TABLE = 'push_subscriptions';

export interface PushSubscriptionJSONLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ${SUB_TABLE} (
      endpoint TEXT PRIMARY KEY,
      keys     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

/** 读取（无则生成）VAPID 密钥对 */
function ensureVapid(): { publicKey: string; privateKey: string } {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(VAPID_KEY) as { value: string } | undefined;
  if (row) {
    try { return JSON.parse(row.value); } catch { /* 损坏则重新生成 */ }
  }
  const keys = webpush.generateVAPIDKeys();
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(VAPID_KEY, JSON.stringify(keys));
  return keys as unknown as { publicKey: string; privateKey: string };
}

export const PushService = {
  /** 客户端订阅所需的 VAPID 公钥 */
  publicKey(): string {
    return ensureVapid().publicKey;
  },

  /** 保存订阅（endpoint 唯一，重复则更新 keys） */
  subscribe(sub: PushSubscriptionJSONLike): void {
    ensureTable();
    getDb().prepare(
      `INSERT INTO ${SUB_TABLE} (endpoint, keys, created_at) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys`,
    ).run(sub.endpoint, JSON.stringify(sub.keys), new Date().toISOString());
  },

  unsubscribe(endpoint: string): void {
    ensureTable();
    getDb().prepare(`DELETE FROM ${SUB_TABLE} WHERE endpoint = ?`).run(endpoint);
  },

  /** 向全部订阅者推送（fire-and-forget：单条失败删订阅，整体不抛错） */
  async notify(title: string, body: string): Promise<void> {
    ensureTable();
    const subs = getDb().prepare(`SELECT endpoint, keys FROM ${SUB_TABLE}`).all() as { endpoint: string; keys: string }[];
    if (subs.length === 0) return;
    const { publicKey, privateKey } = ensureVapid();
    webpush.setVapidDetails('mailto:mtask@localhost', publicKey, privateKey);
    const payload = JSON.stringify({ title, body });
    await Promise.allSettled(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          getDb().prepare(`DELETE FROM ${SUB_TABLE} WHERE endpoint = ?`).run(s.endpoint); // 订阅已失效
        }
        console.warn(`[PushService] 推送失败（${s.endpoint.slice(-16)}）: ${status ?? ''}`);
      }
    }));
  },

  /** 测试推送（设置页「发送测试」按钮） */
  async sendTest(): Promise<number> {
    ensureTable();
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM ${SUB_TABLE}`).get() as { n: number }).n;
    if (n === 0) throw new Error('尚无订阅——请先在浏览器开启推送授权');
    await PushService.notify('MTask 测试推送', '推送链路正常 ✓（T01440）');
    return n;
  },
};
