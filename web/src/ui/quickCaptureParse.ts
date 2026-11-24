/**
 * T06297（PRD §A5 / REQ-034）：快速捕获的自然语言解析单源。
 *
 * 语法：`@日期`、`!优先级`、`#项目`、`/类型`。
 * - 日期：今天/明天/后天/大后天、周X/本周X/下周X、N天/周后、YYYY-MM-DD、M月D日、M/D；
 *   schema 无独立截止字段，故解析后由捕获入口以 `⏰ 日期` 写进描述，信息不丢。
 * - 类型：复用现有任务分类（categoryId），不新增一套“任务类型”字段。
 * - 未命中的标记原样留在标题里并回传 unresolved，由 UI 提示而不是静默吞字。
 */
export type QuickCapturePriority = 'urgent' | 'high' | 'normal' | 'low';
export type QuickCaptureTokenKind = 'priority' | 'project' | 'type' | 'date';

export interface QuickCaptureProject {
  id: string;
  name: string;
}

export interface QuickCaptureCategory {
  id: string;
  name: string;
}

export interface QuickCaptureToken {
  kind: QuickCaptureTokenKind;
  /** 原始标记（含前缀符号），供 chips 编辑时从原文摘除。 */
  raw: string;
  /** 归一后的值：priority 值 / 项目 id / 分类 id / YYYY-MM-DD。 */
  value: string;
}

export interface QuickCaptureUnresolved {
  kind: QuickCaptureTokenKind;
  raw: string;
  value: string;
}

export interface QuickCaptureParsed {
  title: string;
  priority?: QuickCapturePriority;
  projectId?: string;
  projectName?: string;
  categoryId?: string;
  categoryName?: string;
  dueDate?: string;
  dueLabel?: string;
  tokens: QuickCaptureToken[];
  unresolved: QuickCaptureUnresolved[];
}

export interface ParseQuickCaptureOptions {
  projects: readonly QuickCaptureProject[];
  categories: readonly QuickCaptureCategory[];
  /** 测试固定“今天”；生产缺省取本机当前时间。 */
  now?: Date;
}

const PRIORITY_ALIASES: Record<string, QuickCapturePriority> = {
  urgent: 'urgent', high: 'high', normal: 'normal', low: 'low',
  紧急: 'urgent', 高: 'high', 普通: 'normal', 中: 'normal', 低: 'low',
  p0: 'urgent', p1: 'high', p2: 'normal', p3: 'low',
};

/** 常用英文类型别名 → 现有分类名。分类仍以库里真实名称为准，别名只是少打几个字。 */
const CATEGORY_ALIASES: Record<string, string[]> = {
  bug: ['缺陷修复'],
  feature: ['功能优化', '需求分析'],
  feat: ['功能优化'],
  doc: ['文档编写'],
  docs: ['文档编写'],
  test: ['功能测试'],
  review: ['代码评审'],
  design: ['系统设计'],
  req: ['需求分析'],
  perf: ['性能优化'],
  clean: ['垃圾清理'],
  dev: ['开发编码'],
};

const WEEKDAY_VALUE: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日期归一（不用 toISOString，避免东八区凌晨被折到前一天）。 */
export function toLocalYmd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function midday(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12, 0, 0, 0);
}

function weekdayDiff(from: Date, target: number): number {
  return (target - from.getDay() + 7) % 7;
}

/** 以周一为一周起点；返回该周周一（本地中午）。 */
function mondayOfWeek(date: Date): Date {
  const offset = (date.getDay() + 6) % 7;
  return addDays(date, -offset);
}

/** 周内偏移：周一=0 … 周日=6。 */
function weekdayOffsetFromMonday(target: number): number {
  return (target + 6) % 7;
}

/** 解析单个日期标记；返回 null 表示不是可识别日期。 */
function parseDueValue(raw: string, now: Date): { date: string; label: string } | null {
  const text = raw.trim();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  let date: Date | null = null;

  const relative: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
  if (relative[text] !== undefined) date = addDays(base, relative[text]);
  else {
    const offset = /^(\d{1,3})(天|日|周|星期)后$/.exec(text);
    if (offset) {
      const n = Number(offset[1]);
      const days = (offset[2] === '周' || offset[2] === '星期') ? n * 7 : n;
      if (Number.isSafeInteger(days) && days <= 3650) date = addDays(base, days);
    }
  }

  if (!date) {
    const week = /^(下下|下|本)?周([一二三四五六日天])$/.exec(text);
    if (week) {
      const target = WEEKDAY_VALUE[week[2]];
      const thisMonday = mondayOfWeek(base);
      const offset = weekdayOffsetFromMonday(target);
      if (week[1] === '本') date = addDays(thisMonday, offset);
      else if (week[1] === '下') date = addDays(thisMonday, 7 + offset);
      else if (week[1] === '下下') date = addDays(thisMonday, 14 + offset);
      else date = addDays(base, weekdayDiff(base, target));
    }
  }

  if (!date) {
    const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (iso) date = midday(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  if (!date) {
    const cn = /^(\d{1,2})月(\d{1,2})日?$/.exec(text);
    if (cn) date = midday(now.getFullYear(), Number(cn[1]), Number(cn[2]));
  }

  if (!date) {
    const short = /^(\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (short) date = midday(now.getFullYear(), Number(short[1]), Number(short[2]));
  }

  if (!date) return null;
  const ymd = toLocalYmd(date);
  const diff = Math.round((date.getTime() - base.getTime()) / 86_400_000);
  let label = `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_LABEL[date.getDay()]}`;
  if (diff === 0) label = `今天 · ${date.getMonth() + 1}-${date.getDate()}`;
  else if (diff === 1) label = `明天 · ${date.getMonth() + 1}-${date.getDate()}`;
  else if (diff === 2) label = `后天 · ${date.getMonth() + 1}-${date.getDate()}`;
  else if (diff === 3) label = `大后天 · ${date.getMonth() + 1}-${date.getDate()}`;
  return { date: ymd, label };
}

/** 日期 chip 手工改值后仍用同一套标签格式化。 */
export function dueLabelForYmd(ymd: string, now = new Date()): string {
  return parseDueValue(ymd, now)?.label ?? ymd;
}

function findProject(value: string, projects: readonly QuickCaptureProject[]): QuickCaptureProject | undefined {
  const needle = value.trim().toLowerCase();
  return projects.find((p) => p.name.trim().toLowerCase() === needle);
}

function findCategory(value: string, categories: readonly QuickCaptureCategory[]): QuickCaptureCategory | undefined {
  const needle = value.trim().toLowerCase();
  const exact = categories.find((c) => c.name.trim().toLowerCase() === needle);
  if (exact) return exact;
  const aliases = CATEGORY_ALIASES[needle];
  if (!aliases) return undefined;
  for (const name of aliases) {
    const hit = categories.find((c) => c.name.trim() === name);
    if (hit) return hit;
  }
  return undefined;
}

function markerKind(marker: string): QuickCaptureTokenKind | null {
  if (marker === '!' || marker === '！') return 'priority';
  if (marker === '#' || marker === '＃') return 'project';
  if (marker === '/' || marker === '／') return 'type';
  if (marker === '@' || marker === '＠') return 'date';
  return null;
}

/**
 * 解析一条捕获文本。
 * 只有命中项目/分类/优先级/日期的标记才从标题摘除；未命中原样保留，避免“写了却被吞掉”。
 */
export function parseQuickCapture(raw: string, opts: ParseQuickCaptureOptions): QuickCaptureParsed {
  const now = opts.now ?? new Date();
  const tokens: QuickCaptureToken[] = [];
  const unresolved: QuickCaptureUnresolved[] = [];
  let priority: QuickCapturePriority | undefined;
  let project: QuickCaptureProject | undefined;
  let category: QuickCaptureCategory | undefined;
  let due: { date: string; label: string } | undefined;

  // 标记可紧跟中文/英文正文（`修bug#项目`），也可由空格/标点分隔；未命中的标记原样保留。
  const tokenRe = /([!！#＃/／@＠])([^\s，。；、!！?#＃@＠]+)/g;
  const title = raw.replace(tokenRe, (full: string, marker: string, value: string) => {
    const kind = markerKind(marker);
    if (!kind) return full;
    const tokenRaw = `${marker}${value}`;
    if (kind === 'priority') {
      const p = PRIORITY_ALIASES[value.toLowerCase()];
      if (p) {
        priority = p;
        tokens.push({ kind, raw: tokenRaw, value: p });
        return '';
      }
    } else if (kind === 'project') {
      const hit = findProject(value, opts.projects);
      if (hit) {
        project = hit;
        tokens.push({ kind, raw: tokenRaw, value: hit.id });
        return '';
      }
    } else if (kind === 'type') {
      const hit = findCategory(value, opts.categories);
      if (hit) {
        category = hit;
        tokens.push({ kind, raw: tokenRaw, value: hit.id });
        return '';
      }
    } else {
      const hit = parseDueValue(value, now);
      if (hit) {
        due = hit;
        tokens.push({ kind, raw: tokenRaw, value: hit.date });
        return '';
      }
    }
    unresolved.push({ kind, raw: tokenRaw, value });
    return full;
  });

  const cleanTitle = title
    .replace(/\s{2,}/g, ' ')
    .replace(/[，,；;、]\s*$/, '')
    .trim();

  return {
    title: cleanTitle,
    priority,
    projectId: project?.id,
    projectName: project?.name,
    categoryId: category?.id,
    categoryName: category?.name,
    dueDate: due?.date,
    dueLabel: due?.label,
    tokens,
    unresolved,
  };
}
