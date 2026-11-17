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

// 'cron' 仅作展示口径（真正的调度由 cron_expr 列驱动）；interval_days/interval_weeks 供 T05823 引导式「每 N 天/周」使用
const FREQS = ['daily', 'weekly', 'monthly', 'interval_days', 'interval_weeks', 'cron'] as const;
export type Freq = (typeof FREQS)[number];

/** T01073 后续：API Token 权限范围——read=只读凭据（仅放行 GET），write=读写（默认，兼容既有凭据） */
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 本地日历日 YYYY-MM-DD（T05818：标题日期必须与用户看到的本地日期一致，不能直接用 UTC 串截取） */
function localDateTag(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 规范化间隔值：只接受正整数，非法回 1（避免每 N 天=0 造成每 tick 生成） */
function normalizeInterval(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.min(365, Math.floor(v)) : 1;
}

/** cron 语法合法不代表有解（如 `0 0 30 2 *`）；写库前必须确认未来 5 年内有触发时刻，否则不能静默退化成每天。 */
function nextCronOrThrow(expr: string, from = new Date()): string {
  const next = nextCronRunText(expr, from);
  if (!next) throw new Error('cron 表达式在未来 5 年内没有可触发时刻，请检查日期与月份组合');
  return next;
}

const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type TaskPriority = (typeof VALID_PRIORITIES)[number];
function normalizePriority(v: unknown): TaskPriority {
  return typeof v === 'string' && (VALID_PRIORITIES as readonly string[]).includes(v) ? v as TaskPriority : 'normal';
}

/**
 * 推进下次触发时刻。
 * - 有 cron 表达式 → 按 cron 计算（精确到分钟，本地时区解释，见 util/cron 的时区说明）；
 * - interval_days / interval_weeks → 按 N 天/N 周推进；
 * - 其余按频率粗粒度推进（daily/weekly/monthly 各自 +1 天/周/月）。
 * 存储仍是 UTC 串（与既有字符串比较口径一致），只在 UI 展示时转本地。
 */
function advanceNext(freq: Freq, from = new Date(), cron = '', intervalN = 1): string {
  if (cron.trim()) {
    const next = nextCronRunText(cron.trim(), from);
    // 无解（如 2 月 30 日）时不能返回空串写库——那会让 next_run_at <= now 恒成立、每 tick 都生成一份。
    // 复查：也不能静默退回「按天推进」，否则历史坏数据会从按 cron 变成每天高频生成；让调用方按失败处理。
    if (next) return next;
    throw new Error('cron 表达式在未来 5 年内没有可触发时刻，无法推进下次调度');
  }
  const d = new Date(from);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') {
    // 复查：直接 setMonth 会让 1/31 溢出到 3/3，跳过 2 月。按月推进时保留「日」，短月钳到当月最后一天。
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else if (freq === 'interval_days') d.setDate(d.getDate() + normalizeInterval(intervalN));
  else if (freq === 'interval_weeks') d.setDate(d.getDate() + 7 * normalizeInterval(intervalN));
  else if (freq === 'cron') throw new Error('cron 规则缺少可用的表达式，无法推进下次调度'); // 历史坏数据不再按天兜底
  else d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** S6551：unknown 值直接 String() 遇对象会得 [object Object]——显式类型分支（null/undefined 走兜底，对象序列化） */
function freqText(v: unknown, fallback: string): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
}

interface RecurringRow {
  id: string; project_id: string; title: string; description: string; priority: string;
  category_id: string | null; freq: string; cron_expr?: string | null; interval_n?: number | null;
  first_run_immediate?: number | null; next_run_at: string; last_task_no: string | null; enabled: number;
}

/** T05822：把「创建任务 + 写回 last_task_no/next_run_at」收口到一处，tick / runNow / 编辑后手动生成共用。 */
function createTaskFromRule(r: RecurringRow): { taskNo: string; title: string } {
  const dateTag = localDateTag();
  const title = `${r.title}（${dateTag}）`;
  const task = TaskService.create({
    projectId: r.project_id,
    title,
    description: r.description ?? '',
    priority: normalizePriority(r.priority),
    categoryId: r.category_id ?? undefined,
  });
  const taskNo = task.task_no;
  if (!taskNo) throw new Error('任务创建失败：未返回 task_no');
  return { taskNo, title };
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

  create(input: { projectId: string; title: string; description?: string; priority?: string; categoryId?: string | null; freq: string; cron?: string; intervalN?: number; firstRunImmediate?: boolean }): Record<string, unknown> {
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
    const firstImmediate = input.firstRunImmediate !== false ? 1 : 0;
    const intervalN = normalizeInterval(input.intervalN);
    // T05820 复查：首次策略对所有频率一致——不立即生成时，cron 取首个计划时刻，非 cron 取首个间隔到期时刻。
    // 写入前确认 cron 必有未来触发时刻，避免 `0 0 30 2 *` 这类无解表达式被静默退化成每天。
    const firstCronNext = cron ? nextCronOrThrow(cron) : '';
    const scheduledFirst = cron
      ? firstCronNext
      : advanceNext(freq as Freq, new Date(), '', intervalN);
    const nextAt = firstImmediate ? t : scheduledFirst;
    db.prepare(
      `INSERT INTO recurring_rules (id, project_id, title, description, priority, category_id, freq, cron_expr, interval_n, first_run_immediate, next_run_at, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.projectId, input.title.trim(), input.description ?? '', normalizePriority(input.priority), input.categoryId ?? null, freq, cron, intervalN, firstImmediate, nextAt, t);
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
      const next = nextCronOrThrow(expr);
      getDb().prepare("UPDATE recurring_rules SET cron_expr = ?, freq = 'cron', next_run_at = ? WHERE id = ?")
        .run(expr, next, id);
    } else {
      // 清空 cron：freq 需退回一个可用的频率，否则 'cron' 无表达式时会走按天兜底、与用户预期不符。
      // 复查：清空也是调度变更，必须按回退后的频率重算 next_run_at；否则会沿用旧的 cron 时刻。
      const row = this.byId(id);
      const back = row && freqText(row.freq, '') === 'cron' ? 'weekly' : freqText(row?.freq, 'weekly');
      const next = advanceNext(back as Freq, new Date(), '', normalizeInterval(row?.interval_n));
      getDb().prepare('UPDATE recurring_rules SET cron_expr = ?, freq = ?, next_run_at = ? WHERE id = ?').run('', back, next, id);
    }
    return this.byId(id);
  },

  /** 清空 cron 后，回退到可用的频率；若原 freq 是 cron 则默认 weekly */
  remove(id: string): void {
    getDb().prepare('DELETE FROM recurring_rules WHERE id = ?').run(id);
  },

  /**
   * T05820/T05823：编辑规则（标题、执行说明、优先级、分类、项目、调度、首次策略）。
   * 调度字段变更时会重算 next_run_at；只改标题/说明不会把已排定的下一次打乱。
   */
  update(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const db = getDb();
    const row = this.byId(id) as RecurringRow | undefined;
    if (!row) throw new Error('规则不存在');
    const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
    const title = has('title') ? String(patch.title ?? '').trim() : row.title;
    if (!title) throw new Error('标题必填');
    const description = has('description') ? String(patch.description ?? '') : (row.description ?? '');
    const priority = has('priority') ? normalizePriority(patch.priority) : normalizePriority(row.priority);
    const projectId = has('projectId') && String(patch.projectId ?? '').trim() ? String(patch.projectId) : row.project_id;
    const categoryId = has('categoryId') ? ((patch.categoryId as string | null) ?? null) : row.category_id;
    const cron = has('cron') ? String(patch.cron ?? '').trim() : (row.cron_expr ?? '').trim();
    let cronNext = '';
    if (cron) {
      const bad = validateCron(cron);
      if (bad) throw new Error(bad);
      // 复查：即使调度字段没有变化，也要确认表达式有未来触发时刻——历史坏数据不能借「只改标题」继续留在库里。
      cronNext = nextCronOrThrow(cron);
    }
    let freq = row.freq;
    if (has('freq')) {
      const candidate = String(patch.freq ?? '');
      if (!(FREQS as readonly string[]).includes(candidate)) throw new Error('频率非法');
      freq = candidate;
    }
    if (cron) freq = 'cron';
    else if (freq === 'cron') freq = 'weekly';
    // T05820 复查：前端保存时会把 freq/cron/intervalN 一并回传，不能用「字段存在」判断调度是否变化——
    // 只改标题/说明也会被误判为调度变更，firstRunImmediate=1 时会把 next_run_at 置 now，下一 tick 多生成一份。
    const intervalN = has('intervalN') ? normalizeInterval(patch.intervalN) : normalizeInterval(row.interval_n);
    const currentCron = (row.cron_expr ?? '').trim();
    const currentInterval = normalizeInterval(row.interval_n);
    const scheduleChanged = cron !== currentCron || freq !== row.freq || intervalN !== currentInterval;
    const firstImmediate = has('firstRunImmediate') ? (patch.firstRunImmediate === false ? 0 : 1) : Number(row.first_run_immediate ?? 1);
    const enabled = has('enabled') ? (patch.enabled ? 1 : 0) : row.enabled;
    let nextAt = row.next_run_at;
    if (scheduleChanged) {
      // 先校验 cron 有解，再决定「立即」还是「按首个计划时刻」；无解表达式不能写库后静默按天兜底。
      if (firstImmediate) nextAt = now();
      else if (cron) nextAt = cronNext;
      else nextAt = advanceNext(freq as Freq, new Date(), '', intervalN);
    }
    // 复查：调度未变时传 null，COALESCE 保留库中当前 next_run_at——否则只改标题的 UPDATE
    // 会把并发 tick 刚推进的下一次覆盖回旧值，导致同一轮被再次生成。
    db.prepare(
      `UPDATE recurring_rules
          SET project_id = ?, title = ?, description = ?, priority = ?, category_id = ?,
              freq = ?, cron_expr = ?, interval_n = ?, first_run_immediate = ?, enabled = ?,
              next_run_at = COALESCE(?, next_run_at)
        WHERE id = ?`,
    ).run(projectId, title, description, priority, categoryId, freq, cron, intervalN, firstImmediate, enabled, scheduleChanged ? nextAt : null, id);
    return this.byId(id)!;
  },

  /** T05823：引导式选择器/高级模式的「下次生成」预览；返回 UTC 存储串，前端按本地时区格式化。 */
  previewNext(input: { freq?: string; cron?: string; intervalN?: number; firstRunImmediate?: boolean }): { nextRunAt: string } {
    const cron = (input.cron ?? '').trim();
    if (cron) {
      const bad = validateCron(cron);
      if (bad) throw new Error(bad);
    }
    const freq = (FREQS as readonly string[]).includes(input.freq ?? '') && input.freq !== 'cron' ? input.freq as Freq : 'weekly';
    // 复查：即使勾选「立即生成」，无解 cron 也必须在这里报错——create 会拒绝写库，
    // 预览若仍显示「现在」会与保存结果矛盾，用户要到提交后才知道表达式不可用。
    const cronNext = cron ? nextCronOrThrow(cron) : '';
    if (input.firstRunImmediate !== false) return { nextRunAt: now() };
    if (cron) return { nextRunAt: cronNext };
    return { nextRunAt: advanceNext(freq, new Date(), '', normalizeInterval(input.intervalN)) };
  },

  /** T05820：立即生成一份，不等待 tick；任务创建与规则指针更新在同一事务内完成。 */
  runNow(id: string): { taskNo: string; nextRunAt: string } {
    const db = getDb();
    const row = this.byId(id) as RecurringRow | undefined;
    if (!row) throw new Error('规则不存在');
    const tx = db.transaction(() => {
      const nextRunAt = advanceNext(row.freq as Freq, new Date(), row.cron_expr ?? '', row.interval_n ?? 1);
      // T05820 复查：用 next_run_at 条件抢占，避免与编辑/调度更新并发时用旧快照覆盖已排定的下一次；
      // 同一进程内的连续点击仍按产品语义「每次点击各生成一份」，不做冷却或幂等键。
      const claimed = db.prepare('UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?')
        .run(nextRunAt, id, row.next_run_at);
      if (claimed.changes !== 1) throw new Error('规则已被其他操作更新，请稍后重试');
      const { taskNo } = createTaskFromRule(row);
      db.prepare('UPDATE recurring_rules SET last_task_no = ? WHERE id = ?').run(taskNo, id);
      return { taskNo, nextRunAt };
    });
    const r = tx.immediate();
    console.log(`[recurring] 手动生成 ${r.taskNo}（规则「${row.title}」）`);
    return r;
  },

  /**
   * 到期规则生成副本（启动 + 每 60 秒 tick 调用；单次 tick 每条最多生成 1 份，防止积压爆发）。
   * T05819/T05821：调度精度与 cron 对齐到分钟；停机跨过的历史周期不补，只生成恢复后的当前一轮。
   * T05822：任务创建与规则指针更新在同一 immediate 事务内，直接使用 TaskService.create 返回的 task_no，
   *        不再「项目+标题」反查（同名规则/同秒标题不再串号）。
   */
  tick(): number {
    const db = getDb();
    const nowStr = now();
    const due = db.prepare(
      'SELECT * FROM recurring_rules WHERE enabled = 1 AND next_run_at <= ?',
    ).all(nowStr) as RecurringRow[];
    let created = 0;
    for (const r of due) {
      try {
        const overdueMin = Math.max(0, Math.round((Date.parse(`${nowStr.replace(' ', 'T')}Z`) - Date.parse(`${r.next_run_at.replace(' ', 'T')}Z`)) / 60000));
        if (overdueMin > 1) {
          console.warn(`[recurring] 规则「${r.title}」已过期 ${overdueMin} 分钟：按策略仅生成当前一轮，错过的历史周期不补`);
        }
        const tx = db.transaction(() => {
          // 条件更新即“抢占”：并发/多实例下只有一个 tick 能把同一个 next_run_at 推进
          const next = advanceNext(r.freq as Freq, new Date(), r.cron_expr ?? '', r.interval_n ?? 1);
          const claimed = db.prepare('UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?')
            .run(next, r.id, r.next_run_at);
          if (claimed.changes !== 1) return 0;
          const { taskNo } = createTaskFromRule(r);
          db.prepare('UPDATE recurring_rules SET last_task_no = ? WHERE id = ?').run(taskNo, r.id);
          return 1;
        });
        created += tx.immediate();
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
