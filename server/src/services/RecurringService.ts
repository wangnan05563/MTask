/**
 * T01073：循环任务（REQ-037）与 API Token（REQ-038）管理。
 *
 * - 循环任务：规则到期（next_run_at <= now）时由 server 定时 tick 自动生成任务副本
 *   （标题带生成日期后缀），并按频率推进 next_run_at；支持 daily/weekly/monthly。
 * - API Token：具名凭据表，外部脚本经 X-Access-Token 头调用 REST；
 *   accessTokenGuard 在隧道主令牌之外额外校验启用的 api_tokens（并更新 last_used_at）。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/connection';
import { TaskService } from './TaskService';

const FREQS = ['daily', 'weekly', 'monthly'] as const;
export type Freq = (typeof FREQS)[number];

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function advanceNext(freq: Freq, from = new Date()): string {
  const d = new Date(from);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export const RecurringService = {
  list(): Array<Record<string, unknown>> {
    return getDb().prepare(
      `SELECT r.*, p.name AS project_name, c.name AS category_name
         FROM recurring_rules r JOIN projects p ON p.id = r.project_id
         LEFT JOIN task_categories c ON c.id = r.category_id
        ORDER BY r.created_at DESC`,
    ).all() as Array<Record<string, unknown>>;
  },

  create(input: { projectId: string; title: string; description?: string; priority?: string; categoryId?: string | null; freq: string }): Record<string, unknown> {
    const freq = (FREQS as readonly string[]).includes(input.freq) ? input.freq : 'weekly';
    if (!input.projectId || !input.title?.trim()) throw new Error('projectId 与 title 必填');
    const db = getDb();
    const id = cryptoId();
    const t = now();
    // 首次生成即视为到期（当天生成第一份），此后按频率推进
    db.prepare(
      `INSERT INTO recurring_rules (id, project_id, title, description, priority, category_id, freq, next_run_at, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.projectId, input.title.trim(), input.description ?? '', input.priority ?? 'normal', input.categoryId ?? null, freq, t, t);
    const row = this.byId(id);
    if (!row) throw new Error('循环规则创建失败');
    return row;
  },

  byId(id: string): Record<string, unknown> | undefined {
    return getDb().prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  },

  setEnabled(id: string, enabled: boolean): Record<string, unknown> | undefined {
    getDb().prepare('UPDATE recurring_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.byId(id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM recurring_rules WHERE id = ?').run(id);
  },

  /** 到期规则生成副本（启动 + 每小时 tick 调用；单次 tick 每条最多生成 1 份，防止积压爆发） */
  tick(): number {
    const db = getDb();
    const nowStr = now();
    const due = db.prepare(
      'SELECT * FROM recurring_rules WHERE enabled = 1 AND next_run_at <= ?',
    ).all(nowStr) as Array<{ id: string; project_id: string; title: string; description: string; priority: string; category_id: string | null; freq: string }>;
    let created = 0;
    for (const r of due) {
      try {
        const dateTag = nowStr.slice(0, 10);
        TaskService.create({
          projectId: r.project_id,
          title: `${r.title}（${dateTag}）`,
          description: r.description,
          priority: (r.priority === 'low' || r.priority === 'high' || r.priority === 'urgent' ? r.priority : 'normal'),
          categoryId: r.category_id ?? undefined,
        });
        created++;
        db.prepare('UPDATE recurring_rules SET next_run_at = ?, last_task_no = (SELECT task_no FROM tasks WHERE id = ?) WHERE id = ?')
          .run(advanceNext(r.freq as Freq), (db.prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1').get(r.project_id, `${r.title}（${dateTag}）`) as { id: string } | undefined)?.id ?? '', r.id);
      } catch (e) {
        console.error('[recurring] 生成循环任务失败:', r.title, e);
      }
    }
    if (created > 0) console.log(`[recurring] 本轮生成 ${created} 条循环任务`);
    return created;
  },
};

function cryptoId(): string {
  return randomBytes(16).toString('hex');
}

export const TokenService = {
  list(): Array<{ id: string; name: string; token_masked: string; enabled: number; created_at: string; last_used_at: string | null }> {
    return (getDb().prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as Array<Record<string, unknown>>)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        token_masked: mask(String(r.token)),
        enabled: Number(r.enabled),
        created_at: String(r.created_at),
        last_used_at: (r.last_used_at as string | null) ?? null,
      }));
  },

  /** 创建并返回**明文 token（仅此一次展示）** */
  create(name: string): { id: string; name: string; token: string } {
    if (!name?.trim()) throw new Error('name 必填');
    const db = getDb();
    const id = cryptoId();
    const token = `sk-mtask-${randomBytes(24).toString('base64url')}`;
    db.prepare('INSERT INTO api_tokens (id, name, token, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(id, name.trim(), token, now());
    return { id, name: name.trim(), token };
  },

  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('UPDATE api_tokens SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  },

  /** accessTokenGuard 调用：token 命中任一启用凭据则通过（并刷新 last_used_at） */
  verify(token: string): boolean {
    const db = getDb();
    const row = db.prepare('SELECT id FROM api_tokens WHERE token = ? AND enabled = 1').get(token) as { id: string } | undefined;
    if (!row) return false;
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    return true;
  },
};

function mask(token: string): string {
  if (token.length <= 12) return '****';
  return `${token.slice(0, 10)}****${token.slice(-4)}`;
}
