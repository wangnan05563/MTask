/**
 * 启动会 / 阶段总结两套演示稿的统一设计单源（2026-11-06）。
 *
 * 为什么单独一层：这两套稿现在各有 PPTX 与 HTML 两种产物，如果颜色、字号、状态语义
 * 各写一份，下一次调整必然只改一处——PPTX 与 HTML 的观感会从「同一份稿」退化成两份近似品。
 * 本模块只放**纯常量与纯函数**，不 import 数据库、不 import pptxgenjs / 渲染器，
 * 两边都从这里取，门也可以单独断言（对比度、状态色语义、字号阶梯）。
 *
 * 视觉口径参考正式工作汇报：暖白纸面 + 近黑正文 + 克制的品牌蓝 + 语义化的状态色，
 * 靠细线、对齐与留白建立秩序，不靠圆角卡片堆叠（那会让汇报看起来像仪表盘）。
 */
import { BRAND_BRIGHT, BRAND_DEEP, BRAND_PALE, DECK_STYLES, type DeckStyleKey } from '../util/exportStyle';

/** 正文近黑（与 exportStyle.INK_FONT 同值；此处按「设计角色」再命名一次，渲染层只认角色） */
export const INK = '1F2937';
/** 次级文字：说明、出处、时间 */
export const INK_SOFT = '4B5563';
/** 弱化文字：页脚、角标 */
export const INK_MUTED = '6B7280';
/** 纸面：暖白（比纯白柔和，长时间投影不刺眼） */
export const PAPER = 'FBFAF7';
/** 卡片/表面：纯白，压在纸面上形成一级层次 */
export const SURFACE = 'FFFFFF';
/** 细线：表格与卡片边框，比正文浅两个量级 */
export const HAIRLINE = 'E3E0D8';
/** 分区底：表头、斑马纹、目录条 */
export const TINT = 'F3F1EA';

/** 语义状态色：只用在这三件事上，不做装饰（插件配方明确列为失败信号） */
export const STATUS = {
  ok: { fg: '0B6B3A', bg: 'E6F4EC' },
  warn: { fg: '9A5B00', bg: 'FBF0DC' },
  bad: { fg: 'B42318', bg: 'FBEAE8' },
  neutral: { fg: INK_SOFT, bg: TINT },
} as const;

export type StatusTone = keyof typeof STATUS;

/** 字体栈：两套产物都用系统可用的中文字体，HTML 端不引外链（离线可看） */
export const TYPE = {
  /** 标题：衬线优先，正式汇报的「纸面感」靠这一层 */
  display: "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif",
  /** 正文：无衬线，投影可读性优先 */
  body: "'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif",
  /** 数字与代码：等宽，指标页对齐用 */
  mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
} as const;

/** 字号阶梯（px，对应 1280×720 画布）。PPTX 侧按 0.75 折算为 pt，两边同一比例 */
export const TYPE_SCALE = {
  /** 封面主标题 */
  cover: 64,
  /** 章节页编号 */
  sectionNo: 96,
  /** 页标题 */
  title: 34,
  /** 章节页标题 */
  sectionTitle: 40,
  /** 副标题/导语 */
  lead: 19,
  /** 正文 */
  body: 17,
  /** 表格与列表正文 */
  dense: 15,
  /** 角标、页脚、出处 */
  micro: 12,
} as const;

/** px → pt（PPTX 用）。0.75 = 72/96 */
export function pxToPt(px: number): number {
  return Math.round(px * 0.75 * 10) / 10;
}

/** 间距节奏（px）：4 的倍数，越大的间距只用于页与页之间的呼吸 */
export const SPACE = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40, xxl: 64 } as const;

/** 页面几何（与 pptxgenjs 的 10×5.625in 同比例：1280×720 px = 96dpi） */
export const CANVAS_PX = { width: 1280, height: 720 } as const;
/** 内容安全区：左右 72、上下 64（为顶底 chrome 让位） */
export const PADDING_PX = { x: 72, y: 64 } as const;
/** 顶/底 chrome 的视觉高度 */
export const CHROME_PX = 40;

export interface DeckTheme {
  key: DeckStyleKey;
  label: string;
  /** 品牌主色：标题、章节编号、页脚、强调线 */
  brand: string;
  /** 品牌次色：图形与图表首色 */
  accent: string;
  /** 品牌浅色：装饰线与弱提示底 */
  pale: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  paper: string;
  surface: string;
  hairline: string;
  tint: string;
}

/**
 * 三档主题。键与 `DECK_STYLES` 完全对齐（standard/ink/evergreen），
 * 避免 HTML 多出一套「只有它认识」的样式名。
 */
export function deckTheme(key: DeckStyleKey = 'standard'): DeckTheme {
  const preset = DECK_STYLES[key] ?? DECK_STYLES.standard;
  // 次色与浅色按主色派生：三档只在主色上不同，派生规则保持一致——
  // 这样新增一档只需要给一个主色，不会出现「某个档忘了配图表色」的缺口。
  const accent = key === 'standard' ? BRAND_BRIGHT : preset.brandDeep;
  const pale = key === 'standard' ? BRAND_PALE : blend(preset.brandDeep, 'FFFFFF', 0.82);
  return {
    key,
    label: preset.label,
    brand: preset.brandDeep,
    accent,
    pale,
    ink: INK,
    inkSoft: INK_SOFT,
    inkMuted: INK_MUTED,
    paper: PAPER,
    surface: SURFACE,
    hairline: HAIRLINE,
    tint: TINT,
  };
}

/** 两色线性混合（t=0 取 a，t=1 取 b）；仅用于派生浅色，不做通用色彩库 */
function blend(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return mix.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hex(v: string): [number, number, number] {
  const s = v.replace('#', '');
  return [Number.parseInt(s.slice(0, 2), 16), Number.parseInt(s.slice(2, 4), 16), Number.parseInt(s.slice(4, 6), 16)];
}

/**
 * 状态色解析：把业务口径（done/todo/blocked/overdue…）折成四种语义色。
 * PPTX 与 HTML 共用这一份映射——否则同一页里「超期」在表格是红、在指标卡是灰。
 */
export function statusToneOf(raw: string | null | undefined): StatusTone {
  const s = String(raw ?? '').toLowerCase();
  if (/done|完成|已验收|verified|ok|正常|达标/.test(s)) return 'ok';
  if (/blocked|阻塞|overdue|逾期|超期|failed|失败|风险|落后|不达标/.test(s)) return 'bad';
  if (/doing|进行|warn|预警|临近|待验证|部分/.test(s)) return 'warn';
  return 'neutral';
}

/** 品牌装饰：封面与章节页的角标线（PPTX 与 HTML 同宽高比） */
export const BRAND_ACCENT_BAR = { width: 56, height: 6 } as const;

/**
 * 缺数占位词：两套产物与大纲校验共用同一个字面量。
 * 放在设计层是为了让 HTML 适配器不必为了一个常量去 import 整个 kickoffService（那会拖入数据库层，
 * 门与单测都得先起库）。`kickoffService.KICKOFF_PLACEHOLDER` 仍导出同名同值，既有调用方不受影响。
 */
export const PLACEHOLDER = '待补充';
