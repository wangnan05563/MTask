/**
 * T03431：对比度工具（WCAG 2.1 相对亮度 / 对比度）。
 * 纯函数、无 React 依赖——主题令牌的取值与门禁脚本共用同一套算式，
 * 避免「门里算一套、页面算另一套」。所有函数只接受 #rrggbb。
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function isHex6(v: string): boolean {
  return HEX6.test(v);
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** weightA 为 a 的占比（0~1），其余为 b；用于复刻 CSS `color-mix(in srgb, a W%, b)` */
export function mixHex(a: string, b: string, weightA: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) =>
    Math.round((((pa >> shift) & 0xff) * weightA + ((pb >> shift) & 0xff) * (1 - weightA)))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/**
 * 把 color 朝黑（浅底）或白（深底）方向压到与 bg 对比度 ≥ min。
 * 用于「强调色当文字」：自定义强调色可能浅到 1.07:1，压暗后仍保留色相。
 */
export function contrastSafeText(color: string, bg: string, min = 4.5): string {
  if (!isHex6(color) || !isHex6(bg)) return color;
  let out = color;
  const toward = relativeLuminance(bg) > 0.5 ? '#000000' : '#ffffff';
  for (let i = 0; i < 64 && contrastRatio(out, bg) < min; i += 1) out = mixHex(out, toward, 0.92);
  return contrastRatio(out, bg) >= contrastRatio(color, bg) ? out : color;
}

/**
 * 实底（--accent/--success/--danger/--warn）上的文字：先在白字与主题深字间取对比度更高者；
 * 若两者都不到 min（中亮度实底，如 #ef4444 上 3.90:1），退到纯黑/纯白——
 * 任何底色都至少有一侧 ≥4.58:1（两侧相等的最坏点是 L=0.179）。
 */
export function onSolidText(solid: string, dark: string, light = '#ffffff', min = 4.5): string {
  const preferred = contrastRatio(dark, solid) >= contrastRatio(light, solid) ? dark : light;
  if (contrastRatio(preferred, solid) >= min) return preferred;
  return contrastRatio('#000000', solid) >= contrastRatio('#ffffff', solid) ? '#000000' : '#ffffff';
}

/** 自定义强调色 10% 叠底色——与 settings.tsx 写入的 `--accent-soft` 算式保持一致 */
export function accentSoftHex(accent: string, appBg: string): string {
  return mixHex(accent, appBg, 0.1);
}
