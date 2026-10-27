/**
 * PM-302 ①：六类高频组件（按钮 / 输入 / 下拉 / 徽标 / 空态 / 抽屉）的单源样式常量。
 *
 * 取值不是新设计的：每个常量都等于整改前在页面里重复次数最多的那一组字面量
 * （例如输入框 `{padding:8, border:'1px solid var(--border-strong)', borderRadius:6}` 实测 26 处），
 * 所以收编本身零视觉变化；被收编的页面常量改为从这里派生。
 * 例外只有一处刻意的统一：抽屉遮罩改用 `var(--overlay)` 令牌（原先桌面 .32 / 移动 .4 两个硬编码，
 * 暗色下 .32 压不住亮底）。
 *
 * 空态与抽屉是「单源实现」而非样式常量：组件分别在 ui/EmptyState.tsx 与
 * components/SlideOver.tsx（移动端抽屉为 mobile/ui.tsx 的 HalfSheet，属另一平台的形态，
 * 共用本文件的遮罩/圆角常量）。本文件只导出它们共用的外壳样式。
 */
import type { CSSProperties } from 'react';

// ---------- 按钮 ----------

/** 按钮公共形态：所有变体的基底 */
export const BTN_BASE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 'var(--fs-s)' };

/** 主按钮（状态实底 + accent-text，暗色自动反转） */
export const BTN_PRIMARY: CSSProperties = { ...BTN_BASE, padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6 };

/** 次按钮：描边透明底（全站数量最多的一型） */
export const BTN_SECONDARY: CSSProperties = { ...BTN_BASE, padding: '3px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)' };

/** 次按钮（稍大一号：面板工具条用） */
export const BTN_SECONDARY_MD: CSSProperties = { ...BTN_SECONDARY, padding: '4px 9px', borderRadius: 6 };

/** 危险按钮：实底 danger + `--on-solid`（原先多处分写 `color:'#fff'`，暗色下 danger 是亮红，白字只有 2.9:1） */
export const BTN_DANGER: CSSProperties = { ...BTN_PRIMARY, background: 'var(--danger)', color: 'var(--on-solid)' };

/** 危险按钮（描边形态） */
export const BTN_DANGER_OUTLINE: CSSProperties = { ...BTN_SECONDARY, borderColor: 'var(--danger)', color: 'var(--danger)' };

/** 图标-only 按钮（§9.1 表格基线） */
export const BTN_ICON: CSSProperties = { display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' };

/** 禁用态叠加样式（与变体展开顺序：先变体后 disabled） */
export const BTN_DISABLED: CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };

// ---------- 输入 ----------

/**
 * 表单输入框/文本域基准：默认档字号。
 * 基准**不带** background/color——这正是整改前 26 处重复字面量的形状（浏览器画默认底）。
 * 需要卡片底的一律显式用 FIELD_CARD，以免在暗色下白底。
 */
export const FIELD: CSSProperties = {
  padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6,
  fontSize: 'var(--fs-m)', boxSizing: 'border-box',
};

/** 基准 + 卡片底 + 正文色（ReportPage / InsightPanel / SprintPanel / WebhookPanel 一系） */
export const FIELD_CARD: CSSProperties = { ...FIELD, background: 'var(--card-bg)', color: 'var(--text)' };

/** 通栏输入（width:100% 组合，AIToolsPage 用这一型） */
export const FIELD_BLOCK: CSSProperties = { ...FIELD, width: '100%' };

/** 紧凑输入（面板内小表单，padding 5 / 小号字） */
export const FIELD_SM: CSSProperties = { ...FIELD_CARD, padding: 5, fontSize: 'var(--fs-s)' };

/** 通栏紧凑输入 */
export const FIELD_SM_BLOCK: CSSProperties = { ...FIELD_SM, width: '100%' };

/** 表单行内小控件（padding 6 / 默认档字号，ReportPage 一系的密度） */
export const FIELD_XS: CSSProperties = { ...FIELD_CARD, padding: 6 };

/** 弱化边框输入（工具条内联：--border 而非 --border-strong，底色 --surface） */
export const FIELD_QUIET: CSSProperties = { fontSize: 'var(--fs-s)', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' };

/** 行内编辑输入：默认透明边框呈文本观感（§9.1 表格基线，配合 `tr:hover` 显形） */
export const FIELD_INLINE: CSSProperties = {
  border: '1px solid transparent', borderRadius: 4, background: 'transparent',
  color: 'var(--text)', fontSize: 'var(--fs-s)', padding: '1px 4px',
};

/** 表格行内输入（显形后用卡片底；PlanPage 原引用的 --bg 是未定义令牌，此处收编为 --card-bg） */
export const FIELD_ROW: CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 6px', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' };

/** 表单标签 */
export const FIELD_LABEL: CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };

// ---------- 下拉 ----------

/** 下拉（select）：紧凑输入形态 + 手型 */
export const SELECT: CSSProperties = { ...FIELD_SM, cursor: 'pointer' };

/** 通栏下拉 */
export const SELECT_BLOCK: CSSProperties = { ...SELECT, width: '100%' };

/** 批量条内小下拉（§7.5：padding 2 / fs 11 / radius 4） */
export const SELECT_MINI: CSSProperties = {
  padding: 2, fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4,
  background: 'var(--card-bg)', color: 'var(--text)',
};

/** 浮层下拉面板（自定义 popover 的容器型态，非原生 select） */
export const SELECT_POPOVER: CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,.16)', color: 'var(--text)', overflow: 'hidden',
};

// ---------- 徽标 ----------

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** 徽标公共形态（与移动端既有 Badge 完全同值，桌面端由此获得同一单源） */
export const BADGE: CSSProperties = { fontSize: 'var(--fs-xs)', borderRadius: 6, padding: '2px 6px', border: '1px solid transparent' };

/** 徽标配色：全部走 CSS 变量，暗色自动跟随 */
export const BADGE_TONE: Record<BadgeTone, CSSProperties> = {
  neutral: { color: 'var(--text-secondary)', background: 'var(--surface-2)' },
  accent: { color: 'var(--accent)', background: 'var(--surface-2)', borderColor: 'var(--accent)' },
  success: { color: 'var(--success)', background: 'var(--surface-2)', borderColor: 'var(--success)' },
  /* PM-302 ③ 新增档：优先级「高」需要与看板左边框、列表圆点同色（--warn），而既有四档里没有琥珀色 */
  warning: { color: 'var(--warn)', background: 'var(--surface-2)', borderColor: 'var(--warn)' },
  danger: { color: 'var(--danger)', background: 'var(--surface-2)', borderColor: 'var(--danger)' },
};

/** 关联 chip（§9.1 基线：fs 11 / border-strong / radius 4 / padding 0 4px） */
export const CHIP: CSSProperties = { fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: 'var(--text)' };

/** 胶囊标签（PM-302 ①）：CodeReviewLecturePanel 与 GitTreePickerModal 整改前各写了一份逐字节相同的定义 */
export const PILL: CSSProperties = {
  fontSize: 'var(--fs-xs)', padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-secondary)',
};

// ---------- 优先级色（PM-302 ③ 的取值面） ----------

/**
 * 优先级四档的颜色取值。放在 primitives 而不是 priority.ts，
 * 是因为 `--warn` 这类令牌归属由本文件统一维护；ui/priority.ts 负责把它们映射到优先级语义。
 * 这里只允许出现 `var(--*)`，不允许出现十六进制——门（T03221 P-04）断言这一点。
 */
export const PRIORITY_TOKEN = {
  urgent: 'var(--danger)',
  high: 'var(--warn)',
  normal: 'var(--accent)',
  low: 'var(--text-muted)',
} as const;

// ---------- 空态 / 抽屉外壳 ----------

/** 空态外壳（组件本体见 ui/EmptyState.tsx，这里只单源其容器观感） */
export const EMPTY_WRAP: CSSProperties = { padding: 28, textAlign: 'center' };
export const EMPTY_ICON_PLATE: CSSProperties = {
  marginBottom: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 44, height: 44, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)',
};
export const EMPTY_TITLE: CSSProperties = { fontSize: 'var(--fs-m)', color: 'var(--text)', fontWeight: 600, marginBottom: 4 };
export const EMPTY_HINT: CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--text-muted)', maxWidth: 420, margin: '0 auto' };

/** 遮罩：单源走 `--overlay` 令牌（浅 .35 / 深 .55），不再各写一个 rgba */
export const OVERLAY_MASK: CSSProperties = { position: 'absolute', inset: 0, background: 'var(--overlay)' };

/** 抽屉层叠：桌面右滑 1100 / 移动底部半屏 1000（两处既有实测值，集中在此以免被后来者改写） */
export const DRAWER_Z = { slideOver: 1100, halfSheet: 1000 } as const;

/** 移动端卡片/行骨架（原 mobile/ui.tsx 内联值，提来供两屏形态共用） */
export const MOBILE_CARD: CSSProperties = { padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10 };
