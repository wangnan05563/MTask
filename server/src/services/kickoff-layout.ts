/**
 * T02098：启动会 PPT 版式断言层（PRD-项目启动会PPT生成 §6.3 六条门禁的 Node 移植）。
 *
 * 定位（技术方案 §4）：本模块只做**几何与色彩断言**，是纯函数层——
 * 不 import pptxgenjs（适配层 `kickoffBuilder.ts` 独占，风险 R1 不散用）、不 import 数据库层。
 * 之所以要这么一层：技能路径的 Layout Safety 纪律原靠开发期 Python 工具人工 QA，
 * 而装机版没有 Python 运行时（PRD §6.4 实测 `python3` exit 49）——
 * 「无越界」因此必须是断言级保证（验收 7），不能留成抽查级观察。
 *
 * 六条门禁 ↔ 导出：
 *   1 画布先行 → `CANVAS` / `KICKOFF_LAYOUT_DEF` / `MARGIN` / `getContentFrame()`
 *   2 逐元素边界 → `assertInBounds()`（每个 add* 前调用，返回原因串由调用方降级）
 *   3 纵向堆叠单源 → `stackY()`（gap ≥0.3、底部留 ≥0.4，禁止散写 y）
 *   4 换版式必缩放 → `scaleBox()`
 *   5 动态布局防重叠 → `findOverlaps()`
 *   6 对比度 → `contrastRatio()` / `assertContrast()`，色值取自 `util/exportStyle.ts` 单源
 */
import {
  ACCENT_FONT,
  BORDER_ARGB,
  HEAD_FILL,
  INK_FONT,
  PAPER_BG,
  WARN_FONT,
  ZEBRA_FILL,
} from '../util/exportStyle';

// ---------- 门禁 1：画布与内容框 ----------

/** 元素盒（英寸，左上角原点）。pptxgenjs 的 x/y/w/h 直接用同一套数值，不做单位换算 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 16:9 画布（PRD §5.3：版式尺寸表 10×5.625"） */
export const CANVAS = { width: 10, height: 5.625 } as const;

/** 画布整框（`assertInBounds` 放宽到底带时用；与 `Box` 的 w/h 同义，字段名按 PRD §5.3 尺寸表写） */
export const CANVAS_BOX = { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height };

/** 交给适配层 `defineLayout` 的登记参数——尺寸单源，散写会在换屏时漂移 */
export const KICKOFF_LAYOUT_DEF = { name: 'KICKOFF', width: CANVAS.width, height: CANVAS.height };

/** 四周安全边距 */
export const MARGIN = 0.5;

/** 底部保留带（页脚/来源标注之外不可侵占） */
export const BOTTOM_KEEP = 0.4;

/** 纵向堆叠最小间距（PRD §6.3 门禁 3） */
export const MIN_GAP = 0.3;

/** 正文最小字号（PRD §5.3：正文 ≥14pt） */
export const MIN_BODY_PT = 14;

/** 单页 bullet 行数上限 */
export const BULLET_MAX_LINES = 6;

/** 单条 bullet 字符上限（与大纲段 `validateOutline` 同值，两处不一致会让「过了校验仍放不进」） */
export const BULLET_MAX_CHARS = 42;

/** R3：pptxgenjs 不嵌字体，换机打开会回退——固定微软雅黑并显式声明 fallback */
export const FONT = { face: '微软雅黑', fallback: 'Microsoft YaHei' } as const;

/** 门禁 6 阈值：WCAG 2.1 AA 正文对比度 */
export const MIN_CONTRAST = 4.5;

/** 内容框：画布去四周边距，再让出底部保留带 */
export function getContentFrame(): Box {
  return {
    x: MARGIN,
    y: MARGIN,
    w: CANVAS.width - MARGIN * 2,
    h: CANVAS.height - MARGIN * 2 - BOTTOM_KEEP,
  };
}

// ---------- 门禁 2：逐元素边界断言 ----------

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * 每个 `addText/addShape/addImage/addChart` 前调用。
 * 返回 `null` 表示合规；返回原因串由调用方决定降级（验收 7：越界页改「标题+正文」安全版式）。
 * 缺省按 `getContentFrame()` 检查——比画布更严，因为侵占底部保留带同样是版式事故。
 */
export function assertInBounds(box: Box, frame: Box = getContentFrame()): string | null {
  const nums = [box.x, box.y, box.w, box.h];
  if (!nums.every(finite)) return `坐标含非有限数：${JSON.stringify(box)}`;
  if (box.w <= 0) return `宽度非正：${box.w.toFixed(3)}`;
  if (box.h <= 0) return `高度非正：${box.h.toFixed(3)}`;
  if (box.x < frame.x - 1e-9) return `左边界越出：x=${box.x.toFixed(2)} < ${frame.x.toFixed(2)}`;
  if (box.y < frame.y - 1e-9) return `上边界越出：y=${box.y.toFixed(2)} < ${frame.y.toFixed(2)}`;
  if (box.x + box.w > frame.x + frame.w + 1e-9) {
    return `右边界越出：x+w=${(box.x + box.w).toFixed(2)} > ${(frame.x + frame.w).toFixed(2)}`;
  }
  if (box.y + box.h > frame.y + frame.h + 1e-9) {
    return `下边界越出：y+h=${(box.y + box.h).toFixed(2)} > ${(frame.y + frame.h).toFixed(2)}`;
  }
  return null;
}

// ---------- 门禁 3：纵向堆叠单源 ----------

/**
 * 从 `startY` 起按 `gap` 纵向排布若干块，横向落在内容框内。
 * `gap` 下限钳到 `MIN_GAP`（0.3"）——把间距调小来「挤进去」会让页面失去呼吸感，
 * 拥挤应改由调用方降页或裁内容解决，所以这里钳而不缩。
 * 排不下时不静默截断：后续块继续生成、越界由 `assertInBounds` 逐条点名。
 */
export function stackY(startY: number, blocks: Array<{ h: number }>, gap = MIN_GAP): Box[] {
  const frame = getContentFrame();
  const step = Math.max(MIN_GAP, gap);
  const y0 = Math.max(startY, frame.y);
  let cursor = y0;
  return blocks.map((b) => {
    const box: Box = { x: frame.x, y: cursor, w: frame.w, h: b.h };
    cursor += b.h + step;
    return box;
  });
}

// ---------- 门禁 4：换版式必缩放 ----------

/**
 * 把 `box` 从 `fromFrame` 的相对位置等比映射到 `toFrame`。
 * 半迁移（只换 x 不换宽）会让双栏页的右栏压到左栏上，故缩放必须整体做。
 */
export function scaleBox(box: Box, fromFrame: Box, toFrame: Box): Box {
  const rx = fromFrame.w > 0 ? toFrame.w / fromFrame.w : 1;
  const ry = fromFrame.h > 0 ? toFrame.h / fromFrame.h : 1;
  return {
    x: toFrame.x + (box.x - fromFrame.x) * rx,
    y: toFrame.y + (box.y - fromFrame.y) * ry,
    w: box.w * rx,
    h: box.h * ry,
  };
}

// ---------- 门禁 5：动态布局防重叠 ----------

function intersects(a: Box, b: Box, tol: number): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > tol && overlapY > tol;
}

/**
 * 两两求交（含 `tol` 容差，默认 0.02"——贴边相邻不算重叠）。
 * 时间线条与日期轴、双栏左右栏都是动态宽度，只有实测相交才拦得住。
 */
export function findOverlaps(boxes: Box[], tol = 0.02): Array<[Box, Box]> {
  const out: Array<[Box, Box]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(boxes[i], boxes[j], tol)) out.push([boxes[i], boxes[j]]);
    }
  }
  return out;
}

// ---------- 门禁 6：对比度 ----------

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** sRGB 通道线性化（WCAG 2.1 相对亮度定义） */
function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 相对亮度 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`非法色值：${hex}（须 6 位或 3 位 hex，来自 exportStyle 单源）`);
  const [r, g, b] = rgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度 (L1+0.05)/(L2+0.05)，恒 ≥1 */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 返回 `null` 达标；否则点名色值与实测比值 */
export function assertContrast(fg: string, bg: string, min: number = MIN_CONTRAST): string | null {
  const ratio = contrastRatio(fg, bg);
  if (ratio < min) {
    return `对比度不足：${fg}/${bg} = ${ratio.toFixed(2)} < ${min}`;
  }
  return null;
}

/** 版式用色单源表（适配层只能从这里取色，散写字面量会绕过门禁 6） */
export const PALETTE = {
  ink: INK_FONT,
  paper: PAPER_BG,
  headFill: HEAD_FILL,
  zebraFill: ZEBRA_FILL,
  border: BORDER_ARGB,
  warn: WARN_FONT,
  accent: ACCENT_FONT,
} as const;

/** 自检：正文/提示/强调三种前景分别压过 4.5，返回不达标项（装配阶段调用，问题早暴露） */
export function auditPalette(): string[] {
  const pairs: Array<[string, string, string]> = [
    ['正文/纸面', PALETTE.ink, PALETTE.paper],
    ['正文/表头底', PALETTE.ink, PALETTE.headFill],
    ['正文/斑马底', PALETTE.ink, PALETTE.zebraFill],
    ['提示红/纸面', PALETTE.warn, PALETTE.paper],
    ['强调蓝/纸面', PALETTE.accent, PALETTE.paper],
  ];
  const bad: string[] = [];
  for (const [name, fg, bg] of pairs) {
    const reason = assertContrast(fg, bg);
    if (reason) bad.push(`${name}：${reason}`);
  }
  return bad;
}

// ---------- 版式族（PRD §5.3 三套内置版式） ----------

/** 三套物理版式：封面目录（cover/toc 共用）、图文双栏、数据页（表/图/时间线/列表共用框架） */
export type LayoutFamily = 'cover' | 'twoCol' | 'data';

/** 大纲 layout（7 值）→ 物理版式族（3 套）：一个大纲值落到哪套框架 */
export function layoutFamilyOf(layout: string): LayoutFamily {
  if (layout === 'cover' || layout === 'toc') return 'cover';
  if (layout === 'twoCol') return 'twoCol';
  return 'data';
}

/** 各版式族的框：标题带 + 正文区（双栏另有左右栏框） */
export interface LayoutFrames {
  family: LayoutFamily;
  title: Box;
  body: Box;
  cols?: [Box, Box];
}

/**
 * 版式框单源。`toc` 与 `cover` 同族不同框——封面标题居中占半屏，目录标题只占一行，
 * 靠 `sub` 区分而不是让调用方散写坐标（门禁 3「禁止散写 y」的另一半含义）。
 */
export function framesFor(family: LayoutFamily, sub?: string): LayoutFrames {
  const frame = getContentFrame();
  const titleH = 0.7;
  if (family === 'cover') {
    const centered = sub === 'toc';
    const title: Box = centered
      ? { x: frame.x, y: frame.y, w: frame.w, h: titleH }
      : { x: frame.x, y: frame.y + frame.h * 0.28, w: frame.w, h: titleH * 1.6 };
    const body: Box = centered
      ? { x: frame.x, y: frame.y + titleH + MIN_GAP, w: frame.w, h: frame.h - titleH - MIN_GAP }
      : { x: frame.x, y: frame.y + frame.h * 0.28 + titleH * 1.6 + MIN_GAP, w: frame.w, h: frame.h * 0.34 };
    return { family, title, body };
  }
  if (family === 'twoCol') {
    const title: Box = { x: frame.x, y: frame.y, w: frame.w, h: titleH };
    const top = frame.y + titleH + MIN_GAP;
    const bodyH = frame.y + frame.h - top;
    const colW = (frame.w - MIN_GAP) / 2;
    const left: Box = { x: frame.x, y: top, w: colW, h: bodyH };
    const right: Box = { x: frame.x + colW + MIN_GAP, y: top, w: colW, h: bodyH };
    return { family, title, body: left, cols: [left, right] };
  }
  const title: Box = { x: frame.x, y: frame.y, w: frame.w, h: titleH };
  const body: Box = { x: frame.x, y: frame.y + titleH + MIN_GAP, w: frame.w, h: frame.h - titleH - MIN_GAP };
  return { family, title, body };
}

/** 安全版式（验收 7 的落点）：越界页只保留「标题 + 正文」，框一定在内容框内 */
export function safeFrames(): LayoutFrames {
  return framesFor('data');
}

// ---------- 文本宽度预留（R3：中文字体不嵌入，按字符数预留） ----------

/**
 * 估算文本排版宽度（英寸）。
 * CJK 全角按 1 em、ASCII 按 0.55 em——不追求像素级精确，
 * 目的是让「放得下」的判断偏保守：宁可提前降页，也不要产物里出现截字。
 */
export function estimateTextWidthIn(text: string, fontPt: number): number {
  const em = fontPt / 72;
  let units = 0;
  for (const ch of text) {
    if (/[\u3000-\u30ff\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) units += 1;
    else if (/\s/.test(ch)) units += 0.34;
    else units += 0.55;
  }
  return units * em;
}

/** 单行放得下且字数不超限 */
export function fitsOneLine(text: string, widthIn: number, fontPt: number): boolean {
  if ([...text].length > BULLET_MAX_CHARS) return false;
  return estimateTextWidthIn(text, fontPt) <= widthIn;
}

/** 单行可排字符数（按全角字宽保守估算） */
export function charsPerLine(widthIn: number, fontPt: number): number {
  return Math.max(1, Math.floor(widthIn / (fontPt / 72)));
}

/** 行数估算（超行即调用方降页，§3.3） */
export function bulletLineCount(text: string, widthIn: number, fontPt: number): number {
  return Math.max(1, Math.ceil([...text].length / charsPerLine(widthIn, fontPt)));
}

/**
 * 整页文本自检（标题 + bullet），返回降级原因数组（空数组 = 合格）。
 * 装配层在写入前调用；这里只报事实，改不改版由调用方决定。
 */
export function checkPageText(page: { title: string; bullets?: string[] }, bodyWidthIn?: number, fontPt: number = MIN_BODY_PT): string[] {
  const frame = getContentFrame();
  const width = bodyWidthIn ?? frame.w;
  const issues: string[] = [];
  const titlePt = 24;
  if (estimateTextWidthIn(page.title, titlePt) > width) {
    issues.push(`标题超出可排宽度：${[...page.title].length} 字 / ${width.toFixed(2)}"`);
  }
  const bullets = page.bullets ?? [];
  if (bullets.length > BULLET_MAX_LINES) issues.push(`bullet ${bullets.length} 行超出 ${BULLET_MAX_LINES} 行`);
  bullets.forEach((b, i) => {
    if ([...b].length > BULLET_MAX_CHARS) issues.push(`第 ${i + 1} 条 bullet ${[...b].length} 字超出 ${BULLET_MAX_CHARS} 字`);
    else if (!fitsOneLine(b, width, fontPt)) issues.push(`第 ${i + 1} 条 bullet 排不进 ${width.toFixed(2)}" 宽`);
  });
  return issues;
}

// ---------- 时间线几何（FR-4.5，绘制在 T02100 适配层） ----------

/** 计划条高度（PRD §5.3 时间线口径） */
export const TIMELINE_BAR_H = 0.18;

export interface DateRange {
  min: number;
  max: number;
}

/**
 * 取 `min(start_date)~max(end_date)`。
 * 无有效日期返回 `null`——调用方据此降级为 `sort_order` 列表版（P3 预警已在 preflight 给出）。
 */
export function dateRangeOf(rows: Array<{ start_date?: string | null; end_date?: string | null }>): DateRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    for (const v of [r.start_date, r.end_date]) {
      if (!v) continue;
      const t = Date.parse(v);
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // 单日项目给 1 天宽度，避免除零
  return { min, max: max === min ? min + 86400000 : max };
}

/** 日期 → 内容框 x 线性映射 */
export function xAt(dateMs: number, range: DateRange, frame: Box): number {
  const span = range.max - range.min;
  const ratio = span > 0 ? (dateMs - range.min) / span : 0;
  return frame.x + Math.min(1, Math.max(0, ratio)) * frame.w;
}

/**
 * 计划条盒（起止越界钳到框内）。
 * 返回 `null` 表示该条没有可绘日期——调用方跳过或降级，不画「猜出来的条」。
 */
export function barBox(
  row: { start_date?: string | null; end_date?: string | null },
  range: DateRange,
  frame: Box,
  rowY: number
): Box | null {
  const s = row.start_date ? Date.parse(row.start_date) : NaN;
  const e = row.end_date ? Date.parse(row.end_date) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  const x1 = xAt(s, range, frame);
  const x2 = xAt(Math.max(e, s), range, frame);
  const w = Math.max(x2 - x1, 0.06);
  return { x: x1, y: rowY, w, h: TIMELINE_BAR_H };
}

/** 里程碑菱形盒（居中于日期刻度，边长与条高同量级） */
export function diamondBox(dateMs: number, range: DateRange, frame: Box, axisY: number): Box {
  const cx = xAt(dateMs, range, frame);
  const size = TIMELINE_BAR_H * 1.6;
  return { x: Math.min(Math.max(cx - size / 2, frame.x), frame.x + frame.w - size), y: axisY - size / 2, w: size, h: size };
}

/** 日期轴刻度（等分，返回位置与 YYYY-MM-DD 短标签） */
export function axisTicks(range: DateRange, count = 4): Array<{ x: number; label: string }> {
  const frame = getContentFrame();
  const n = Math.max(2, count);
  return Array.from({ length: n }, (_, i) => {
    const t = range.min + ((range.max - range.min) * i) / (n - 1);
    const d = new Date(t);
    return { x: frame.x + (frame.w * i) / (n - 1), label: `${d.getMonth() + 1}/${d.getDate()}` };
  });
}
