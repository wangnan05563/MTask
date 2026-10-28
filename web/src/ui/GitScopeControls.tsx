import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, GitBranch, Plus, X } from 'lucide-react';
import { FIELD_QUIET, PILL, SELECT_POPOVER } from './primitives'; // PM-302 ① 单源
import {
  AUTHOR_GROUP_MAX,
  datePresets,
  dayOf,
  describeWindow,
  endBoundary,
  filterAuthorSuggestions,
  filterBranches,
  joinAuthorGroups,
  monthCells,
  monthOf,
  parseAuthorGroups,
  pickDay,
  removeAuthorGroup,
  sanitizeAuthorTerm,
  todayIso,
  addAuthorGroup,
  type BranchOption,
} from '../utils/scopeControls';

/**
 * T03590：代码评审讲稿卡「采集范围」的点选控件（分支 / 日期范围 / 提交人）。
 *
 * 三件事都遵循同一条边界——**控件只是输入法的替代，产物仍是原来那几个字符串**：
 *  - 分支选择器回填的是版本号字段（分支名/标签名/SHA 都收），输入框始终可手写；
 *  - 日期控件落成 `since` / `until` 两个字符串（结束日补到 23:59:59 才「含当天」）；
 *  - 提交人标签按 `|` 分组拼接，组内的 `,` 原样保留（服务端的「且」语义不被吞掉）。
 * 因此这三个控件不改变任何采集语义，只把「记分支名 / 查日历 / 手拼分隔符」换成点选。
 */

const TRIGGER: CSSProperties = {
  ...FIELD_QUIET, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, boxSizing: 'border-box',
};
const POPOVER: CSSProperties = {
  ...SELECT_POPOVER, position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 40,
  boxShadow: '0 6px 18px rgba(0,0,0,.16)', padding: 6, maxHeight: 300, overflowY: 'auto',
  minWidth: 220, maxWidth: 'min(360px, calc(100vw - 24px))',
};
const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'transparent',
  color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 'var(--fs-s)', padding: '4px 6px', borderRadius: 4,
};
const INNER_INPUT: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, border: 'none', background: 'transparent', color: 'inherit',
  fontSize: 'inherit', padding: '2px 0', outline: 'none',
};

/** 点击外部关闭（面板里三个弹层共用；挂在文档 mousedown 上，避免冒泡到按钮自身的 onClick） */
function useOutsideClose(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, ref, close]);
}

// ---------------------------------------------------------------------------
// 分支 / 标签 / SHA 选择器
// ---------------------------------------------------------------------------

export function BranchPicker({ value, onChange, options, placeholder, disabled, testId, ariaLabel, width = 150, onOpen }: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly options: readonly BranchOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly ariaLabel: string;
  readonly width?: number;
  /** 首次展开时向上层要候选（懒加载：默认「全部项目」不该在进面板时就逐仓扫） */
  readonly onOpen?: () => void;
}) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const close = () => { setOpenState(false); setQuery(''); };
  useOutsideClose(open, hostRef, close);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (next) onOpen?.();
  };

  const filtered = useMemo(() => filterBranches(options, query, 100), [options, query]);
  const commit = (name: string) => { onChange(name); close(); };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { close(); return; }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); commit(filtered[active].name); }
  }

  return (
    <div ref={hostRef} style={{ position: 'relative', width, maxWidth: '100%' }}>
      <div style={{ ...TRIGGER, opacity: disabled ? 0.55 : 1 }}>
        <GitBranch size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <input
          data-lck={testId}
          value={value}
          disabled={disabled}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? '分支/标签/SHA'}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          style={INNER_INPUT}
        />
        {value && !disabled && (
          <button type="button" data-lck={testId ? `${testId}-clear` : undefined} aria-label={`清除${ariaLabel}`}
            title="清除（回到默认：HEAD）"
            onClick={() => { onChange(''); setOpen(false); }}
            style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
            <X size={12} />
          </button>
        )}
        <button type="button" data-lck={testId ? `${testId}-toggle` : undefined} aria-label={`展开${ariaLabel}候选`}
          onClick={() => setOpen(!open)} disabled={disabled}
          style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <div data-lck={testId ? `${testId}-menu` : undefined} role="listbox" aria-label={`${ariaLabel}候选`} style={POPOVER}>
          <input
            data-lck={testId ? `${testId}-filter` : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="模糊过滤：输入几个字母即可（如 f/r/s）"
            aria-label={`过滤${ariaLabel}`}
            autoFocus
            style={{ ...FIELD_QUIET, width: '100%', boxSizing: 'border-box', marginBottom: 4 }}
          />
          {filtered.length === 0 && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '4px 6px' }}>
              {options.length === 0 ? '未取到分支列表：仍可直接手输分支/标签/SHA' : `没有匹配「${query}」的分支或标签`}
            </div>
          )}
          {filtered.map((option, i) => (
            // 只给标签挂类型：装饰里的分支名与远端名都是 `feature/x` 形态（`--decorate=short` 分不出本地/远端），
            // 硬贴「分支/远端」会贴错，标签是唯一能确定的类型
            <button key={`${option.type}:${option.name}`} type="button" role="option" aria-selected={option.name === value}
              data-lck={testId ? `${testId}-option` : undefined} data-ref={option.name} data-ref-type={option.type}
              title={option.type === 'tag' ? `标签 · ${option.name}` : option.name}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(option.name)}
              style={{ ...ROW, background: i === active ? 'var(--surface-2)' : 'transparent' }}>
              {option.type === 'tag' && <span style={{ ...PILL, flexShrink: 0 }}>标签</span>}
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {option.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 日期范围（起止点选 + 快捷项 + 高级原始值）
// ---------------------------------------------------------------------------

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function DateRangeField({ start, end, onChange, testId = 'lecture-since', today = todayIso(), width = 240 }: {
  /** 原始起始值（可为 `2026-10-01 00:00:00` 或 `14 days ago`） */
  readonly start: string;
  /** 原始截止值（空 = 不设右界） */
  readonly end: string;
  readonly onChange: (start: string, end: string) => void;
  readonly testId?: string;
  readonly today?: string;
  readonly width?: number;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useOutsideClose(open, hostRef, close);

  const startDay = dayOf(start);
  const endDay = dayOf(end);
  const [view, setView] = useState(() => monthOf(startDay ?? today));
  const [hover, setHover] = useState('');

  // 外部值变化（快捷项/高级输入/会话恢复）时把月历翻到对应月份
  useEffect(() => {
    const anchor = startDay ?? endDay;
    if (anchor) setView(monthOf(anchor));
  }, [startDay, endDay]);

  const cells = useMemo(() => monthCells(view.year, view.month, today), [view, today]);
  const presets = useMemo(() => datePresets(today), [today]);
  const summary = describeWindow(start, end);

  // 起始保持纯日期（与手输 `2026-10-01` 同值）；截止补到 23:59:59 才「含当天」
  const applyDays = (s: string, e: string) => {
    onChange(s, e ? endBoundary(e) : '');
  };

  const within = (iso: string): boolean => {
    if (!startDay) return false;
    const hi = endDay ?? (open && hover >= startDay ? hover : '');
    return iso >= startDay && (hi ? iso <= hi : iso === startDay);
  };

  return (
    <div ref={hostRef} style={{ position: 'relative', width, maxWidth: '100%' }}>
      <div data-lck={testId} role="group" aria-label="起始时间范围" style={TRIGGER}>
        <button type="button" data-lck={`${testId}-toggle`} aria-label="展开日期点选" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={summary || '选择时间窗（可只设起始，也可起止都设）'}
          style={{ ...INNER_INPUT, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
          <CalendarDays size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: summary ? 'var(--text)' : 'var(--text-muted)' }}>
            {summary || '起始时间（点选日期）'}
          </span>
        </button>
        {(start || end) && (
          <button type="button" data-lck={`${testId}-clear`} aria-label="清除时间窗" title="清除时间窗"
            onClick={() => { onChange('', ''); setOpen(false); }}
            style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
            <X size={12} />
          </button>
        )}
        <button type="button" aria-label="展开日期点选" onClick={() => setOpen((v) => !v)}
          style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <div data-lck={`${testId}-menu`} style={{ ...POPOVER, width: 268 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {presets.map((p) => {
              const hit = startDay === p.start && endDay === p.end;
              return (
                <button key={p.key} type="button" data-lck={`${testId}-preset`} data-preset={p.key}
                  onClick={() => applyDays(p.start, p.end)}
                  style={{ ...PILL, cursor: 'pointer', background: hit ? 'var(--accent)' : 'var(--surface-2)', color: hit ? 'var(--accent-text)' : 'var(--text-secondary)' }}>
                  {p.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <button type="button" aria-label="上一月" onClick={() => setView((v) => { const n = new Date(v.year, v.month - 2, 1); return { year: n.getFullYear(), month: n.getMonth() + 1 }; })}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}>
              <ChevronLeft size={13} />
            </button>
            <span style={{ flex: '1 1 auto', textAlign: 'center', fontSize: 'var(--fs-s)' }}>{view.year} 年 {view.month} 月</span>
            <button type="button" aria-label="下一月" onClick={() => setView((v) => { const n = new Date(v.year, v.month, 1); return { year: n.getFullYear(), month: n.getMonth() + 1 }; })}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}>
              <ChevronRight size={13} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textAlign: 'center', marginBottom: 2 }}>
            {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }} onMouseLeave={() => setHover('')}>
            {cells.map((c) => {
              const isStart = c.iso === startDay;
              const isEnd = c.iso === endDay;
              const edge = isStart || isEnd;
              return (
                <button key={c.iso} type="button" data-lck={`${testId}-day`} data-day={c.iso}
                  data-in-month={c.inMonth ? '1' : '0'} data-today={c.isToday ? '1' : '0'} data-edge={edge ? '1' : '0'}
                  aria-label={`${c.iso}${c.isToday ? '（今天）' : ''}`} aria-pressed={edge}
                  onMouseEnter={() => setHover(c.iso)}
                  onClick={() => { const next = pickDay(startDay ?? '', endDay ?? '', c.iso); applyDays(next.start, next.end); }}
                  style={{
                    padding: '4px 0', border: edge ? '1px solid var(--accent)' : '1px solid transparent', borderRadius: 4,
                    background: edge ? 'var(--accent)' : within(c.iso) ? 'var(--accent-soft)' : 'transparent',
                    color: edge ? 'var(--accent-text)' : c.inMonth ? 'var(--text)' : 'var(--text-muted)',
                    outline: c.isToday && !edge ? '1px dashed var(--accent)' : 'none',
                    cursor: 'pointer', fontSize: 'var(--fs-xs)',
                  }}>
                  {c.day}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>点第 1 天=起始；再点第 2 天=截止（结束日含当天 23:59:59）</span>
          </div>
          <label style={{ display: 'block', marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            起始（可填 14 days ago）
            <input data-lck={`${testId}-raw-start`} value={start} onChange={(e) => onChange(e.target.value, end)}
              placeholder="2026-10-01 / 14 days ago"
              style={{ ...FIELD_QUIET, width: '100%', boxSizing: 'border-box', marginTop: 2 }} aria-label="起始原始值" />
          </label>
          <label style={{ display: 'block', marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            截止（留空=不限）
            <input data-lck={`${testId}-raw-end`} value={end} onChange={(e) => onChange(start, e.target.value)}
              placeholder="2026-10-28"
              style={{ ...FIELD_QUIET, width: '100%', boxSizing: 'border-box', marginTop: 2 }} aria-label="截止原始值" />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 提交人多选（标签 + 搜索 + 候选）
// ---------------------------------------------------------------------------

export function AuthorMultiSelect({ value, onChange, authors, onRequestAuthors, testId = 'lecture-author-filter', placeholder = '提交人（多选）', width = 230 }: {
  /** 原始过滤串：`甲 | 乙`（或）；组内 `甲, 乙`（且）原样保留 */
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** 候选来源（仓库最近提交的 author/committer）；为空时退化为手输 */
  readonly authors: readonly string[];
  readonly onRequestAuthors?: () => void;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => { setOpen(false); setQuery(''); };
  useOutsideClose(open, hostRef, close);

  const groups = useMemo(() => parseAuthorGroups(value), [value]);
  const suggestions = useMemo(() => filterAuthorSuggestions(authors, groups, query), [authors, groups, query]);
  const typed = sanitizeAuthorTerm(query);
  const typedIsNew = Boolean(typed) && !suggestions.some((s) => s.toLowerCase() === typed!.toLowerCase())
    && !groups.some((g) => g.toLowerCase() === typed!.toLowerCase());

  function add(term: string) {
    const clean = sanitizeAuthorTerm(term);
    if (!clean) return;
    // 到上限时静默不加会让人以为没点上：留一条可由父层读到的 title 提示，标签数本身也已可见
    if (groups.length >= AUTHOR_GROUP_MAX) return;
    onChange(joinAuthorGroups(addAuthorGroup(groups, clean)));
    setQuery('');
  }

  function remove(index: number) {
    onChange(joinAuthorGroups(removeAuthorGroup(groups, index)));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); add(query); return; }
    if (e.key === 'Backspace' && !query && groups.length > 0) { remove(groups.length - 1); return; }
    if (e.key === 'Escape') close();
  }

  return (
    <div ref={hostRef} style={{ position: 'relative', width, maxWidth: '100%' }}>
      <div data-lck={testId} role="group" aria-label="提交人过滤（多选）"
        onClick={() => inputRef.current?.focus()}
        style={{ ...TRIGGER, flexWrap: 'wrap', padding: '2px 4px', cursor: 'text', minHeight: 26 }}>
        {groups.map((g, i) => (
          <span key={`${g}-${i}`} style={{ ...PILL, display: 'inline-flex', alignItems: 'center', gap: 2, maxWidth: 150 }}>
            <span title={g} style={{ maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g}</span>
            <button type="button" data-lck={`${testId}-remove`} data-author={g} aria-label={`移除提交人 ${g}`}
              onClick={(e) => { e.stopPropagation(); remove(i); }}
              style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input ref={inputRef} data-lck={`${testId}-input`} value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); onRequestAuthors?.(); }}
          onKeyDown={onKeyDown}
          placeholder={groups.length === 0 ? placeholder : ''}
          aria-label="搜索或输入提交人后回车添加"
          style={{ ...INNER_INPUT, flex: '1 1 70px', minWidth: 60 }}
        />
        {groups.length === 0 && !query && (
          <ChevronDown size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        )}
      </div>
      {open && (
        <div data-lck={`${testId}-menu`} style={{ ...POPOVER, width: 250 }} role="listbox" aria-label="提交人候选">
          {typedIsNew && (
            <button type="button" data-lck={`${testId}-add`} onClick={() => add(query)} style={{ ...ROW, color: 'var(--accent)' }}>
              <Plus size={12} />添加「{typed}」
            </button>
          )}
          {suggestions.map((name) => (
            <button key={name} type="button" role="option" aria-selected={false}
              data-lck={`${testId}-option`} data-author={name} title={name}
              onClick={() => add(name)}
              style={ROW}>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </button>
          ))}
          {!typedIsNew && suggestions.length === 0 && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '4px 6px' }}>
              {authors.length === 0 ? '没有候选名单：输入完整姓名后回车即可添加' : `没有匹配「${query}」的提交人`}
            </div>
          )}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '4px 6px 0', borderTop: '1px solid var(--border)', marginTop: 4 }}>
            多个提交人之间是「或」；要「且」请直接写成「甲, 乙」。服务端按姓名精确比对。
          </div>
        </div>
      )}
    </div>
  );
}
