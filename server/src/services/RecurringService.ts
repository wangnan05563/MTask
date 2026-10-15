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
import { nextCronRunText, validateCron } from '../util/cron'; // T01073 后续：cron 精确时刻

// 'cron' 仅作展示口径（真正的调度由 cron_expr 列驱动），故一并纳入合法频率集合
const FREQS = ['daily', 'weekly', 'monthly', 'cron'] as const;
export type Freq = (typeof FREQS)[number];

/** T01073 后续：API Token 权限范围——read=只读凭据（仅放行 GET），write=读写（默认，兼容既有凭据） */
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 推进下次触发时刻。
 * - 有 cron 表达式 → 按 cron 计算（精确到分钟，本地时区解释，见 util/cron 的时区说明）；
 * - 否则按频率粗粒度推进（daily/weekly/monthly 各自 +1 天/周/月）。
 */
function advanceNext(freq: Freq, from = new Date(), cron = ''): string {
  if (cron.trim()) {
    const next = nextCronRunText(cron.trim(), from);
    // 无解（如 2 月 30 日）时不能返回空串写库——那会让 next_run_at <= now 恒成立、每 tick 都生成一份
    if (next) return next;
  }
  const d = new Date(from);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1); // freq='cron' 但表达式缺失/无解时的兜底：按天推进，避免空转
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** S6551：unknown 值直接 String() 遇对象会得 [object Object]——显式类型分支（null/undefined 走兜底，对象序列化） */
function freqText(v: unknown, fallback: string): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
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

  create(input: { projectId: string; title: string; description?: string; priority?: string; categoryId?: string | null; freq: string; cron?: string }): Record<string, unknown> {
    // cron 优先：给了合法表达式即按 cron 调度（freq 仅作展示口径记为 'cron'）
    const cron = (input.cron ?? '').trim();
    let freq: string;
    if (cron) {
      const bad = validateCron(cron);
      if (bad) throw new Error(bad);
      freq = 'cron';
    } else {
      freq = (FREQS as readonly string[]).includes(input.freq) && input.freq !== 'cron' ? input.freq : 'weekly';
    }
    if (!input.projectId || !input.title?.trim()) throw new Error('projectId 与 title 必填');
    const db = getDb();
    const id = cryptoId();
    const t = now();
    // 首次生成即视为到期（当天生成第一份），此后按频率/cron 推进
    db.prepare(
      `INSERT INTO recurring_rules (id, project_id, title, description, priority, category_id, freq, cron_expr, next_run_at, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.projectId, input.title.trim(), input.description ?? '', input.priority ?? 'normal', input.categoryId ?? null, freq, cron, t, t);
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

  /**
   * T01073 后续：改 cron 表达式（或清空回退为频率调度）。
   * 校验放在写库前——非法表达式写进去后 tick 每轮都推进失败，规则会「卡在到期态」不断重复生成。
   */
  setCron(id: string, cron: string): Record<string, unknown> | undefined {
    const expr = (cron ?? '').trim();
    if (expr) {
      const bad = validateCron(expr);
      if (bad) throw new Error(bad);
      getDb().prepare("UPDATE recurring_rules SET cron_expr = ?, freq = 'cron' WHERE id = ?").run(expr, id);
    } else {
      // 清空 cron：freq 需退回一个可用的频率，否则 'cron' 无表达式时会走按天兜底、与用户预期不符
      const row = this.byId(id);
      const back = row && freqText(row.freq, '') === 'cron' ? 'weekly' : freqText(row?.freq, 'weekly');
      getDb().prepare('UPDATE recurring_rules SET cron_expr = ?, freq = ? WHERE id = ?').run('', back, id);
    }
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
    ).all(nowStr) as Array<{ id: string; project_id: string; title: string; description: string; priority: string; category_id: string | null; freq: string; cron_expr?: string | null }>;
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
          .run(advanceNext(r.freq as Freq, new Date(), r.cron_expr ?? ''), (db.prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1').get(r.project_id, `${r.title}（${dateTag}）`) as { id: string } | undefined)?.id ?? '', r.id);
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
  list(): Array<{ id: string; name: string; token_masked: string; scope: TokenScope; enabled: number; created_at: string; last_used_at: string | null }> {
    return (getDb().prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as Array<Record<string, unknown>>)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        token_masked: mask(String(r.token)),
        // 老库补列前读不到 scope（undefined）→ 按 write 处理，保持既有凭据行为不变（NFR-4 向后兼容）
        scope: normalizeScope(r.scope),
        enabled: Number(r.enabled),
        created_at: String(r.created_at),
        last_used_at: (r.last_used_at as string | null) ?? null,
      }));
  },

  /** 创建并返回**明文 token（仅此一次展示）**；scope 默认 write（读写） */
  create(name: string, scope = 'write'): { id: string; name: string; token: string; scope: TokenScope } {
    if (!name?.trim()) throw new Error('name 必填');
    const sc = normalizeScope(scope);
    const db = getDb();
    const id = cryptoId();
    const token = `sk-mtask-${randomBytes(24).toString('base64url')}`;
    db.prepare('INSERT INTO api_tokens (id, name, token, scope, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, name.trim(), token, sc, now());
    return { id, name: name.trim(), token, scope: sc };
  },

  /** T01073 后续：调整权限范围（read 只读 / write 读写） */
  setScope(id: string, scope: string): void {
    getDb().prepare('UPDATE api_tokens SET scope = ? WHERE id = ?').run(normalizeScope(scope), id);
  },

  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('UPDATE api_tokens SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  },

  /**
   * accessTokenGuard 调用：token 命中任一启用凭据则返回其权限范围，未命中返回 null。
   *
   * 返回 scope 而非 boolean 的原因：只读凭据需要被**单独识别**出来以拦截写操作
   * （否则「只读凭据」只是个装饰性标签，拿到 token 照样能改数据）。
   */
  verify(token: string): TokenScope | null {
    const db = getDb();
    const row = db.prepare('SELECT id, scope FROM api_tokens WHERE token = ? AND enabled = 1').get(token) as { id: string; scope?: unknown } | undefined;
    if (!row) return null;
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    return normalizeScope(row.scope);
  },
};

/** 权限范围归一：非法/缺失一律按 write（既有凭据行为不变，避免升级后旧脚本突然 403） */
export function normalizeScope(scope: unknown): TokenScope {
  return scope === 'read' ? 'read' : 'write';
}

function mask(token: string): string {
  if (token.length <= 12) return '****';
  return `${token.slice(0, 10)}****${token.slice(-4)}`;
}
