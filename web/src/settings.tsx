/**
 * 全局设置：主题（浅/深）、字体、字号。
 * - 通过 CSS 变量驱动，`:root` 定义浅色默认值，`[data-theme='dark']` 覆盖为深色值；
 * - 偏好持久化到 localStorage，刷新/重开应用后保留；
 * - 字号档位通过覆盖 `--fs-*` 变量实现，凡使用这些变量的字号都会随之变化。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'auto'; // T01060-FR4.2：auto=跟随系统（matchMedia 动态解析）
export type FontKey = 'default' | 'mono' | 'kai' | 'song';
export type FontSizeKey = 's' | 'm' | 'l';
/** 备份导入时的冲突处理策略：合并/保留现有/覆盖全部 */
export type ImportMode = 'merge' | 'keep' | 'overwrite';

export interface SettingsPrefs {
  theme: Theme;
  font: FontKey;
  fontSize: FontSizeKey;
  /** T01060-FR4.1：自定义强调色（#rrggbb；空串=跟随主题默认） */
  accent: string;
  /** T01445：Zen 极简阅读模式——隐藏徽标/计数、放大字号 */
  zen?: boolean;
}

const PREF_KEY = 'settings.prefs';

const FONT_MAP: Record<FontKey, string> = {
  default: '"system-ui", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
  song: '"Songti SC", "NSimSun", "SimSun", serif',
};

/**
 * 各字号档位对 `--fs-*` 变量组的取值：应用内统一字号都在用这些变量。
 * T03180（PM-301④ / UX-11）：三档（s/m/l）各自给全套令牌赋值，令牌名与像素刻度一一对应，
 * 保证「数值字号 → 令牌」的改造在默认档（m）下像素不变；新增的 2xs/xs/2xl 只是把相邻刻度补齐，
 * 不改变原有 s/m/l/xl/title 的档位语义。改这里的键必须同步 `:root` 默认值（门禁会比对）。
 */
const FONT_SIZE_MAP: Record<FontSizeKey, Record<string, string>> = {
  s: { '--fs-2xs': '9px', '--fs-xs': '10px', '--fs-s': '11px', '--fs-m': '12px', '--fs-l': '13px', '--fs-xl': '14px', '--fs-2xl': '16px', '--fs-title': '18px' },
  m: { '--fs-2xs': '10px', '--fs-xs': '11px', '--fs-s': '12px', '--fs-m': '13px', '--fs-l': '14px', '--fs-xl': '15px', '--fs-2xl': '17px', '--fs-title': '20px' },
  l: { '--fs-2xs': '11px', '--fs-xs': '12px', '--fs-s': '13px', '--fs-m': '14px', '--fs-l': '15px', '--fs-xl': '17px', '--fs-2xl': '19px', '--fs-title': '22px' },
};

export const FONT_OPTIONS: { key: FontKey; label: string }[] = [
  { key: 'default', label: '系统默认' },
  { key: 'mono', label: '等宽' },
  { key: 'kai', label: '楷体' },
  { key: 'song', label: '宋体' },
];

export const FONT_SIZE_OPTIONS: { key: FontSizeKey; label: string }[] = [
  { key: 's', label: '小' },
  { key: 'm', label: '中' },
  { key: 'l', label: '大' },
];

const DEFAULTS: SettingsPrefs = { theme: 'light', font: 'default', fontSize: 'm', accent: '', zen: false };

/** T01060-FR4.1：hex 亮度（0~1）——用于强调色上按钮文字自动取深/白，保证对比度 */
function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 全局 CSS 变量：浅/深两套主题 + 语义色板。所有页面改用这些变量即自动适配主题与字号 */
const themeCss = `
:root, [data-theme='light'] {
  --app-bg: #ffffff;
  --card-bg: #ffffff;
  --surface: #f9fafb;
  --surface-2: #f3f4f6;
  --text: #1f2937;
  --text-secondary: #4b5563;
  --text-muted: #6b7280;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --accent: #2563eb;
  --accent-text: #ffffff;
  /* 饱和状态实底（danger/success）上的文字：浅色主题白字、深色主题深字（两点色本身在深色下更亮） */
  --on-solid: #ffffff;
  /* 深色浮层（toast/遮罩）上的文字：恒为白字，不随主题反转 */
  --on-dark: #ffffff;
  --accent-soft: #eff6ff;
  --success: #15803d;
  --danger: #dc2626;
  --warn: #b45309;
  --overlay: rgba(0, 0, 0, 0.35);
  --code-bg: #f1f5f9;
  --code-border: #e2e8f0;
  --markdown-quote: #cbd5e1;
  color-scheme: light;
}
[data-theme='dark'] {
  --app-bg: #18181b;
  --card-bg: #1e1e21;
  --surface: #2a2a2e;
  --surface-2: #27272a;
  --text: #e5e7eb;
  --text-secondary: #a1a1aa;
  --text-muted: #8b8b93;
  --border: #3f3f46;
  --border-strong: #52525b;
  --accent: #5b9bf8;
  --accent-text: #0b1220;
  /* 饱和实底（danger/success）在深色主题里是亮色，文字随之转深，保证 ≥4.5:1 */
  --on-solid: #0b1220;
  --on-dark: #ffffff;
  --accent-soft: #1e293b;
  --success: #22c55e;
  --danger: #f87171;
  --warn: #fbbf24;
  --overlay: rgba(0, 0, 0, 0.55);
  --code-bg: #27272a;
  --code-border: #3f3f46;
  --markdown-quote: #4b5563;
  color-scheme: dark;
}

/* T03180（PM-301④）：:root 自带三档默认值（默认档 m）。JS 未执行 / 被禁用时 var(--fs-*) 仍有解析值，
   不会出现未定义变量导致字号回落；设置页切换档位时以 documentElement 内联变量覆盖这里。
   门禁 scripts/tests/verify-t03180-font-tokens.mts 校验此处与 FONT_SIZE_MAP.m 逐项一致。 */
:root {
  --font-family: "system-ui", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --fs-2xs: 10px;
  --fs-xs: 11px;
  --fs-s: 12px;
  --fs-m: 13px;
  --fs-l: 14px;
  --fs-xl: 15px;
  --fs-2xl: 17px;
  --fs-title: 20px;
  /* 展示级字号：由 title 派生，跟随档位等比缩放（KPI 数字/大图标），避免为一次性尺寸新增数字字号 */
  --fs-display: calc(var(--fs-title) * 1.3);
  --fs-hero: calc(var(--fs-title) * 2);
}

/* 底色跟随主题：React 注入的样式表未到达前由 index.html 的首帧内联规则兜住（T03179，两处保持同源） */
html, body, #root {
  background: var(--app-bg);
}
body {
  color: var(--text);
}

/* T03181（PM-303⑤）：全站统一键盘焦点环。此前只有导航与时间线 chip 各写一条，
   其余原生控件依赖 UA 默认轮廓，在浅/深主题下对比度不稳定；:focus-visible 只对键盘生效，不影响鼠标点击观感。 */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* T01038+：运行态「流光文字」动画——对齐 WorkBuddy 会话运行动画样式（lib-chat-ui cb-shining-text）：
   110° 渐变 + background-clip:text，基色 30% 透明、中段提亮 75%，background-position 200%→-200% 每 2.2s 无限扫过。
   颜色经 --ai-shimmer-color 可覆盖（如蓝底按钮内传 var(--accent-text)），默认跟随主题主文字色 var(--text)。 */
@keyframes flow-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.ai-shimmer {
  width: fit-content;
  background: linear-gradient(110deg,
    color-mix(in srgb, var(--ai-shimmer-color, var(--text)) 30%, transparent) 0%,
    color-mix(in srgb, var(--ai-shimmer-color, var(--text)) 30%, transparent) 35%,
    color-mix(in srgb, var(--ai-shimmer-color, var(--text)) 75%, transparent) 50%,
    color-mix(in srgb, var(--ai-shimmer-color, var(--text)) 30%, transparent) 65%,
    color-mix(in srgb, var(--ai-shimmer-color, var(--text)) 30%, transparent) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: flow-sweep 2.2s linear infinite;
}

/* T01067-FR3.4：长列表虚拟滚动（content-visibility）——Chromium 桌面壳原生支持，
   屏外行跳过渲染仅保留布局占位（intrinsic-size 为估算行高，展开后按实际高度自适应）。
   对不定高列表（任务行可展开/含图）优于 JS 窗口化：零改造、无测量抖动。 */
.cv-auto {
  content-visibility: auto;
  contain-intrinsic-size: auto 64px;
}

/* T01067-FR3.3：骨架屏——AI 生成/数据加载期间的占位微光条（对齐 WorkBuddy sm-skeleton-shimmer 观感）。复用全局 flow-sweep keyframes（与进度条/按钮 loading 同源）。 */
.skel {
  background: linear-gradient(90deg,
    var(--surface-2) 25%,
    var(--border) 37%,
    var(--surface-2) 63%);
  background-size: 400% 100%;
  animation: flow-sweep 1.4s ease infinite;
  border-radius: 6px;
}

/* T01068-FR4.4：流光延展——AI 运行态元素的 accent 光晕呼吸（文字流光 ai-shimmer 的边框/容器延展形态）。
   用 box-shadow 而非 conic 边框：不与各卡片 inline background 冲突、无 @property 依赖，观感近似。 */
@keyframes flow-glow {
  0%, 100% { box-shadow: 0 0 0 1px var(--accent), 0 0 10px color-mix(in srgb, var(--accent) 30%, transparent); }
  50% { box-shadow: 0 0 0 1.5px var(--accent), 0 0 20px color-mix(in srgb, var(--accent) 55%, transparent); }
}
.flow-glow {
  animation: flow-glow 1.8s ease-in-out infinite;
}

/* T01068-FR4.4：进度条——流光扫过填充（与骨架/按钮共用 flow-sweep keyframes）。
   轨道 surface-2；填充 accent 渐变带中段提亮，扫光时呈现流动高光。 */
.flow-progress {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}
.flow-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--accent) 70%, transparent) 0%,
    var(--accent) 35%,
    color-mix(in srgb, var(--accent) 70%, transparent) 50%,
    var(--accent) 65%,
    color-mix(in srgb, var(--accent) 70%, transparent) 100%);
  background-size: 200% 100%;
  animation: flow-sweep 2.2s linear infinite;
}

/* T01068-FR4.4：按钮 loading——流光扫过按钮表面（与骨架/进度条共用 flow-sweep keyframes）。
   在按钮背景上叠加一道斜向高光，loading 态呈现流动质感；标签保留可读文字。
   注意：宿主须用 background-color 长写法设底色（勿用 background 简写），否则内联 background 会覆盖本类 background-image。 */
.flow-btn {
  position: relative;
  overflow: hidden;
  background-image: linear-gradient(100deg, transparent 25%, color-mix(in srgb, var(--accent-text, #fff) 38%, transparent) 50%, transparent 75%);
  background-size: 200% 100%;
  background-repeat: no-repeat;
  animation: flow-sweep 1.8s linear infinite;
}

/* T01068-FR4.4 + 无障碍：prefers-reduced-motion 下降级全部流光动画，避免眩晕。
   文字流光回退为实色文字；进度条/按钮/骨架回退为静态填充；光晕呼吸关闭。满足「reduced-motion 下自动降级」。 */
@media (prefers-reduced-motion: reduce) {
  .ai-shimmer {
    -webkit-text-fill-color: var(--ai-shimmer-color, var(--text));
    color: var(--ai-shimmer-color, var(--text));
    background: none;
    animation: none;
  }
  .skel { animation: none; }
  .flow-progress-fill { animation: none; }
  .flow-btn { animation: none; background-image: none; }
  .flow-glow { animation: none; }
}
`;

function loadPrefs(): SettingsPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsPrefs>) };
    // 防脏数据：主题/字号/字体只在合法枚举内，否则回退默认
    if (!['light', 'dark', 'auto'].includes(p.theme)) p.theme = DEFAULTS.theme;
    if (typeof p.zen !== 'boolean') p.zen = DEFAULTS.zen; // T01445
    if (!(p.font in FONT_MAP)) p.font = DEFAULTS.font;
    if (!(p.fontSize in FONT_SIZE_MAP)) p.fontSize = DEFAULTS.fontSize;
    // T01060-FR4.1：强调色仅接受空串（默认）或 #rrggbb
    if (p.accent !== '' && !/^#[0-9a-fA-F]{6}$/.test(p.accent)) p.accent = DEFAULTS.accent;
    return p;
  } catch {
    return DEFAULTS;
  }
}

interface SettingsCtx {
  prefs: SettingsPrefs;
  update: <K extends keyof SettingsPrefs>(key: K, value: SettingsPrefs[K]) => void;
}

const Ctx = createContext<SettingsCtx>({
  prefs: DEFAULTS,
  update: () => {},
});

export function SettingsProvider({ children }: { readonly children: ReactNode }) {
  const [prefs, setPrefs] = useState<SettingsPrefs>(loadPrefs);
  // T01060-FR4.2：跟随系统——auto 时监听系统配色变化，动态解析实际主题
  const [systemDark, setSystemDark] = useState(() =>
    globalThis.window !== undefined && typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );
  useEffect(() => {
    if (prefs.theme !== 'auto' || typeof globalThis.matchMedia !== 'function') return;
    const mq = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [prefs.theme]);

  // 偏好变化即持久化 + 应用主题与字体。data-theme 用 dataset 写入（S7761）
  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略配额等写入失败 */ }
    // S3358：嵌套三元展开为 if 语句
    let effTheme: Theme = prefs.theme;
    if (effTheme === 'auto') effTheme = systemDark ? 'dark' : 'light';
    document.documentElement.dataset.theme = effTheme;
    document.documentElement.dataset.zen = prefs.zen ? '1' : ''; // T01445
    document.documentElement.style.setProperty('--font-family', FONT_MAP[prefs.font]);
    const vars = FONT_SIZE_MAP[prefs.fontSize];
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    // T01060-FR4.1：自定义强调色——inline 变量覆盖主题表；空串恢复默认
    const rootStyle = document.documentElement.style;
    const accent = prefs.accent.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(accent)) {
      rootStyle.setProperty('--accent', accent);
      // 浅底/深底通用的浅强调底：以 app-bg 调和 10%；按钮文字按亮度自动取深/白
      rootStyle.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 10%, var(--app-bg))`);
      const lum = luminance(accent);
      rootStyle.setProperty('--accent-text', lum > 0.72 ? '#1f2937' : '#ffffff');
    } else {
      rootStyle.removeProperty('--accent');
      rootStyle.removeProperty('--accent-soft');
      rootStyle.removeProperty('--accent-text');
    }
  }, [prefs, systemDark]);

  // update 用 useCallback 稳定引用：setPrefs 本身稳定，避免 value 因函数重建而每次渲染变化
  const update = useCallback<SettingsCtx['update']>(
    (key, value) => setPrefs((prev) => ({ ...prev, [key]: value })),
    [],
  );
  // Context value 用 useMemo 稳定：仅 prefs 变化时才生成新对象，避免所有订阅组件无谓重渲染
  const value = useMemo<SettingsCtx>(() => ({ prefs, update }), [prefs, update]);

  return (
    <Ctx.Provider value={value}>
      {/* 主题变量在应用根统一注入一次；Markdown 样式另由 MarkdownStyles 注入 */}
      <style>{themeCss}</style>
      {children}
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  return useContext(Ctx);
}