/**
 * T05823：循环任务周期选择器——引导式选择树为主，原频率下拉 + cron 为高级备选。
 *
 * 组件只产出 `freq` / `cron` / `intervalN` 三元组，最终仍走既有 POST/PUT /recurring 接口；
 * 引导式分支不要求用户理解 cron，高级分支保留完整原始能力（老规则可继续编辑）。
 */
import { useMemo, type CSSProperties } from 'react';
import { CalendarClock, ChevronDown, Code2, HelpCircle } from 'lucide-react';

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'quarterly' | 'interval_days' | 'interval_weeks' | 'cron';

export interface RecurringSchedule {
  advanced: boolean;
  kind: ScheduleKind;
  hour: number;
  minute: number;
  weekday: number;
  monthDay: number;
  intervalN: number;
  cron: string;
  advancedFreq: string;
  advancedCron: string;
}

export interface ScheduleRule {
  freq: string;
  cron: string;
  intervalN: number;
}

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  daily: '每天',
  weekdays: '工作日（周一至周五）',
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季度',
  interval_days: '每 N 天',
  interval_weeks: '每 N 周',
  cron: '自定义 cron（高级）',
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function defaultSchedule(): RecurringSchedule {
  return {
    advanced: false, kind: 'weekly', hour: 9, minute: 0, weekday: 1,
    monthDay: 1, intervalN: 7, cron: '0 9 * * 1',
    advancedFreq: 'weekly', advancedCron: '',
  };
}

/** 供父级把规则回填到选择器（编辑旧规则时使用；能识别的 cron 还原为引导式，识别不了留在高级 cron）。 */
export function scheduleFromRule(r: { freq?: string; cron_expr?: string; interval_n?: number | null; first_run_immediate?: number | null }): RecurringSchedule {
  const base = defaultSchedule();
  const cron = String(r.cron_expr ?? '').trim();
  if (!cron && r.freq === 'interval_days') return { ...base, kind: 'interval_days', intervalN: Number(r.interval_n) || 1 };
  if (!cron && r.freq === 'interval_weeks') return { ...base, kind: 'interval_weeks', intervalN: Number(r.interval_n) || 1 };
  if (!cron && (r.freq === 'daily' || r.freq === 'weekly' || r.freq === 'monthly')) return { ...base, kind: r.freq, advancedFreq: r.freq };
  // 常见引导式 cron 反向识别；不是这些形态就原样留在高级 cron，绝不静默改成别的周期
  const m = /^(\d{1,2})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(cron);
  if (!m) return { ...base, advanced: true, advancedCron: cron, advancedFreq: 'cron' };
  const minute = Number(m[1]); const hour = Number(m[2]);
  const dom = m[3]; const month = m[4]; const dow = m[5];
  if (dom === '*' && month === '*' && dow === '*') return { ...base, kind: 'daily', hour, minute, advancedFreq: 'daily' };
  if (dom === '*' && month === '*' && dow === '1-5') return { ...base, kind: 'weekdays', hour, minute, advancedFreq: 'daily' };
  if (dom === '*' && month === '*' && /^\d$/.test(dow)) return { ...base, kind: 'weekly', hour, minute, weekday: Number(dow), advancedFreq: 'weekly' };
  if (/^\d{1,2}$/.test(dom) && month === '*' && dow === '*') return { ...base, kind: 'monthly', hour, minute, monthDay: Number(dom), advancedFreq: 'monthly' };
  if (/^\d{1,2}$/.test(dom) && month === '1,4,7,10' && dow === '*') return { ...base, kind: 'quarterly', hour, minute, monthDay: Number(dom), advancedFreq: 'monthly' };
  return { ...base, advanced: true, advancedCron: cron, advancedFreq: 'cron' };
}

/** 生成提交给后端的字段。 */
export function ruleFromSchedule(s: RecurringSchedule): ScheduleRule {
  if (s.advanced) {
    const cron = s.advancedCron.trim();
    return { freq: cron ? 'cron' : s.advancedFreq, cron, intervalN: s.intervalN };
  }
  const hh = Math.max(0, Math.min(23, Math.floor(s.hour)));
  const mm = Math.max(0, Math.min(59, Math.floor(s.minute)));
  switch (s.kind) {
    case 'daily': return { freq: 'daily', cron: `${mm} ${hh} * * *`, intervalN: 1 };
    case 'weekdays': return { freq: 'daily', cron: `${mm} ${hh} * * 1-5`, intervalN: 1 };
    case 'weekly': return { freq: 'weekly', cron: `${mm} ${hh} * * ${s.weekday}`, intervalN: 1 };
    case 'monthly': return { freq: 'monthly', cron: `${mm} ${hh} ${s.monthDay} * *`, intervalN: 1 };
    case 'quarterly': return { freq: 'monthly', cron: `${mm} ${hh} ${s.monthDay} 1,4,7,10 *`, intervalN: 1 };
    case 'interval_days': return { freq: 'interval_days', cron: '', intervalN: Math.max(1, Math.floor(s.intervalN)) };
    case 'interval_weeks': return { freq: 'interval_weeks', cron: '', intervalN: Math.max(1, Math.floor(s.intervalN)) };
    default: return { freq: 'cron', cron: s.cron.trim(), intervalN: 1 };
  }
}

/** 自然语言摘要：只说明“哪天/几点生成”，同时提醒循环任务本身不执行。 */
export function scheduleSummary(s: RecurringSchedule): string {
  const hhmm = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  switch (s.kind) {
    case 'daily': return `每天 ${hhmm} 生成一份任务副本（循环任务本身不执行任务）`;
    case 'weekdays': return `工作日（周一至周五）${hhmm} 生成一份任务副本（循环任务本身不执行任务）`;
    case 'weekly': return `每周${WEEKDAY_LABELS[s.weekday] ?? '一'} ${hhmm} 生成一份任务副本（循环任务本身不执行任务）`;
    case 'monthly': return `每月 ${s.monthDay} 日 ${hhmm} 生成一份任务副本（2/4/6/9/11 月无该日时自动跳过）`;
    case 'quarterly': return `每季度首月（1/4/7/10 月）${s.monthDay} 日 ${hhmm} 生成一份任务副本（短月自动跳过）`;
    case 'interval_days': return `从创建时刻起，每 ${s.intervalN} 天生成一份任务副本（不是按自然日 0 点对齐）`;
    case 'interval_weeks': return `从创建时刻起，每 ${s.intervalN} 周生成一份任务副本（不是按周一对齐）`;
    default: return `按自定义 cron「${s.cron}」生成任务副本；cron 只决定何时生成，不决定任务做什么`;
  }
}

/** 频率/cron 只读回显：便于排查“为什么这时生成”。 */
export function scheduleExpression(s: RecurringSchedule): string {
  const r = ruleFromSchedule(s);
  if (r.cron) return `cron：${r.cron}`;
  return r.freq === 'interval_days' || r.freq === 'interval_weeks'
    ? `freq：${r.freq}，intervalN=${r.intervalN}`
    : `freq：${r.freq}`;
}

const field: CSSProperties = {
  padding: 5, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)',
  borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)',
};

function TimeFields({ value, onChange }: { readonly value: RecurringSchedule; readonly onChange: (v: RecurringSchedule) => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select value={value.hour} onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })}
        aria-label="生成小时" title="生成小时（本地时区）" style={field}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
      </select>
      <span style={{ color: 'var(--text-muted)' }}>:</span>
      <input type="number" min={0} max={59} value={value.minute}
        onChange={(e) => onChange({ ...value, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })}
        aria-label="生成分钟" title="生成分钟（本地时区）" style={{ ...field, width: 58 }} />
    </span>
  );
}

export function RecurringSchedulePicker({
  value, onChange, previewText = '', error = '',
}: {
  readonly value: RecurringSchedule;
  readonly onChange: (v: RecurringSchedule) => void;
  readonly previewText?: string;
  readonly error?: string;
}) {
  const rule = useMemo(() => ruleFromSchedule(value), [value]);
  return (
    <div data-t05823="schedule-picker" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <CalendarClock size={14} style={{ color: 'var(--accent)' }} />
        <b style={{ fontSize: 'var(--fs-s)' }}>生成周期</b>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>引导式选择树（常用周期无需手写 cron）</span>
        <span style={{ flex: 1 }} />
        <button type="button"
          onClick={() => onChange({ ...value, advanced: !value.advanced })}
          title={value.advanced ? '切回引导式选择' : '高级模式：保留原频率下拉与 cron 输入'}
          aria-pressed={value.advanced}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 'var(--fs-xs)', borderRadius: 6, border: '1px solid var(--border-strong)', background: value.advanced ? 'var(--accent-soft, rgba(9,105,218,.10))' : 'var(--card-bg)', color: value.advanced ? 'var(--accent)' : 'var(--text)', cursor: 'pointer' }}>
          {value.advanced ? <CalendarClock size={12} /> : <Code2 size={12} />}
          {value.advanced ? '回到引导式' : '高级模式（freq + cron）'}
        </button>
      </div>

      {value.advanced ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={value.advancedFreq} onChange={(e) => onChange({ ...value, advancedFreq: e.target.value, advancedCron: '' })}
            aria-label="高级模式频率" title="原频率下拉（daily/weekly/monthly）" style={field}>
            <option value="daily">每天（daily）</option>
            <option value="weekly">每周（weekly）</option>
            <option value="monthly">每月（monthly）</option>
          </select>
          <input value={value.advancedCron}
            onChange={(e) => onChange({ ...value, advancedCron: e.target.value })}
            placeholder="cron 可选，如 0 9 * * 1"
            aria-label="高级模式 cron 表达式"
            title="cron 5 段式（分 时 日 月 周，本地时区）；填写后优先于左侧频率"
            style={{ ...field, flex: 1, minWidth: 180, fontFamily: 'Consolas, Menlo, monospace' }} />
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>填写 cron 后忽略左侧频率，二者都保留为兼容入口</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as ScheduleKind })}
            aria-label="生成周期类型" title="先选周期类型，再填具体时刻" style={field}>
            {(Object.keys(SCHEDULE_KIND_LABELS) as ScheduleKind[]).map((k) => <option key={k} value={k}>{SCHEDULE_KIND_LABELS[k]}</option>)}
          </select>
          {(value.kind === 'daily' || value.kind === 'weekdays' || value.kind === 'weekly' || value.kind === 'monthly' || value.kind === 'quarterly') && (
            <TimeFields value={value} onChange={onChange} />
          )}
          {value.kind === 'weekly' && (
            <select value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}
              aria-label="每周星期几" style={field}>
              {WEEKDAY_LABELS.map((label, i) => <option key={label} value={i}>{label}</option>)}
            </select>
          )}
          {(value.kind === 'monthly' || value.kind === 'quarterly') && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              每月
              <input type="number" min={1} max={31} value={value.monthDay}
                onChange={(e) => onChange({ ...value, monthDay: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
                aria-label="每月日期" style={{ ...field, width: 62 }} />
              日
            </label>
          )}
          {(value.kind === 'interval_days' || value.kind === 'interval_weeks') && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              每
              <input type="number" min={1} max={365} value={value.intervalN}
                onChange={(e) => onChange({ ...value, intervalN: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                aria-label="间隔数量" style={{ ...field, width: 66 }} />
              {value.kind === 'interval_days' ? '天' : '周'}
            </label>
          )}
          {value.kind === 'cron' && (
            <input value={value.cron} onChange={(e) => onChange({ ...value, cron: e.target.value })}
              placeholder="0 9 * * 1"
              aria-label="自定义 cron 表达式"
              title="cron 5 段式：分 时 日 月 周（本地时区）"
              style={{ ...field, flex: 1, minWidth: 190, fontFamily: 'Consolas, Menlo, monospace' }} />
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--fs-xs)' }}>
        <HelpCircle size={12} style={{ color: 'var(--text-muted)' }} />
        <span data-t05823="summary" style={{ color: 'var(--text)' }}>{scheduleSummary(value)}</span>
        {previewText && <span data-t05823="preview" style={{ color: 'var(--accent)' }}>下次生成：{previewText}（本地时区）</span>}
        {rule.cron && <code style={{ color: 'var(--text-muted)' }}>{rule.cron}</code>}
        {error && <span data-t05823="invalid" style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>

      <details style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        <summary style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ChevronDown size={12} /> 表达式回显与口径
        </summary>
        <div style={{ marginTop: 4 }}>{scheduleExpression(value)}；存储 UTC、展示本地；调度器每 60 秒检查一次，错过的历史周期不自动补生成。</div>
      </details>
    </div>
  );
}
