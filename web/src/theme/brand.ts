/**
 * T06352：品牌包 JSON → 运行时主题。
 *
 * 证据文件 `docs/evidence/t06352-brand/mtask-brand.json` 是品牌包源头；
 * `web/src/theme/mtask-brand.json` 是随应用构建的运行时副本，两者由
 * `scripts/tests/verify-t06352-brand.tsx` 校验字节一致，避免运行时另造一套值。
 *
 * 只把品牌包应用到浅色主题：品牌包本身只定义了浅色基准，深色/高对比仍由
 * `settings.tsx` 与 `tokens.css` 的既有主题负责。品牌 CSS 以 `[data-theme='light']`
 * 为作用域，且在 themeCss 之后注入，因此不会误覆盖深色主题。
 */
import brandJson from './mtask-brand.json';

export interface BrandPackage {
  name: string;
  label: string;
  version: number;
  raw: Record<string, string>;
  semantic: Record<string, string>;
  component: Record<string, string>;
}

export interface ResolvedBrand {
  raw: Record<string, string>;
  semantic: Record<string, string>;
  component: Record<string, string>;
}

const REF_LAYERS = new Set(['raw', 'semantic', 'component']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const REQUIRED_RAW = [
  'blue50', 'blue600', 'blue700',
  'neutral0', 'neutral50', 'neutral100', 'neutral200', 'neutral300',
  'neutral550', 'neutral600', 'neutral800',
];
const REQUIRED_SEMANTIC = [
  'brand', 'brand-ink', 'brand-soft',
  'bg', 'surface', 'surface-2', 'card', 'ink', 'ink-2', 'muted', 'line', 'line-strong',
  'ff', 'fs-2xs', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl',
  'r-sm', 'r-md', 'r-lg', 'shadow', 'motion-fast', 'motion-base', 'motion-ease',
];
const REQUIRED_COMPONENT = [
  'button.primary.background', 'button.primary.foreground', 'button.primary.hover.background',
  'badge.brand.background', 'badge.brand.foreground',
  'card.background', 'card.border', 'card.radius',
];

const RAW_TO_PRIMITIVE: Record<string, string> = {
  blue50: '--mt-primitive-blue-50',
  blue600: '--mt-primitive-blue-600',
  blue700: '--mt-primitive-blue-700',
  neutral0: '--mt-primitive-neutral-0',
  neutral50: '--mt-primitive-neutral-50',
  neutral100: '--mt-primitive-neutral-100',
  neutral200: '--mt-primitive-neutral-200',
  neutral300: '--mt-primitive-neutral-300',
  neutral550: '--mt-primitive-neutral-550',
  neutral600: '--mt-primitive-neutral-600',
  neutral800: '--mt-primitive-neutral-800',
};

const SEMANTIC_TO_APP_VAR: Record<string, string> = {
  bg: '--app-bg',
  card: '--card-bg',
  surface: '--surface',
  'surface-2': '--surface-2',
  ink: '--text',
  'ink-2': '--text-secondary',
  muted: '--text-muted',
  line: '--border',
  'line-strong': '--border-strong',
  brand: '--accent',
  'brand-ink': '--accent-ink',
  'brand-soft': '--accent-soft',
  ff: '--font-family',
};

const COMPONENT_TO_VAR: Record<string, string> = {
  'button.primary.background': '--mt-component-button-primary-bg',
  'button.primary.foreground': '--mt-component-button-primary-fg',
  'button.primary.hover.background': '--mt-component-button-primary-hover-bg',
  'badge.brand.background': '--mt-component-tag-bg',
  'badge.brand.foreground': '--mt-component-tag-fg',
  'card.background': '--mt-component-card-bg',
  'card.border': '--mt-component-card-border',
  'card.radius': '--mt-component-card-radius',
};

function fail(message: string): never {
  throw new Error(`[brand] ${message}`);
}

function resolveRef(ref: string, pkg: BrandPackage, stack: string[]): string {
  const dot = ref.indexOf('.');
  if (dot < 1) return ref;
  const layer = ref.slice(0, dot);
  if (!REF_LAYERS.has(layer)) return ref;
  const key = ref.slice(dot + 1);
  if (stack.includes(ref)) fail(`token 引用成环：${[...stack, ref].join(' → ')}`);
  const table = pkg[layer as keyof Pick<BrandPackage, 'raw' | 'semantic' | 'component'>];
  const value = table[key];
  if (typeof value !== 'string' || value.length === 0) fail(`找不到 ${layer}.${key}`);
  return resolveRef(value, pkg, [...stack, ref]);
}

/** 校验品牌包结构并把所有 raw./semantic./component. 引用解析成最终字面量。 */
export function resolveBrand(pkg: BrandPackage): ResolvedBrand {
  if (!pkg || typeof pkg !== 'object') fail('品牌包不是对象');
  if (pkg.name !== 'mtask') fail(`品牌名必须为 mtask，实际 ${String(pkg.name)}`);
  if (typeof pkg.version !== 'number' || pkg.version < 1) fail('version 必须为正整数');
  if (!pkg.raw || !pkg.semantic || !pkg.component) fail('品牌包必须包含 raw/semantic/component 三层');

  for (const key of REQUIRED_RAW) {
    if (!HEX_COLOR.test(pkg.raw?.[key] ?? '')) fail(`raw.${key} 必须是 #rrggbb`);
  }
  for (const key of REQUIRED_SEMANTIC) {
    if (typeof pkg.semantic?.[key] !== 'string' || pkg.semantic[key].length === 0) fail(`缺少 semantic.${key}`);
  }
  for (const key of REQUIRED_COMPONENT) {
    if (typeof pkg.component?.[key] !== 'string' || pkg.component[key].length === 0) fail(`缺少 component.${key}`);
  }

  const raw = Object.fromEntries(
    Object.entries(pkg.raw).map(([key, value]) => [key, resolveRef(value, pkg, [`raw.${key}`])]),
  );
  const semantic = Object.fromEntries(
    Object.entries(pkg.semantic).map(([key, value]) => [key, resolveRef(value, pkg, [`semantic.${key}`])]),
  );
  const component = Object.fromEntries(
    Object.entries(pkg.component).map(([key, value]) => [key, resolveRef(value, pkg, [`component.${key}`])]),
  );

  return { raw, semantic, component };
}

function cssLines(entries: Array<[string, string]>): string {
  return entries.map(([name, value]) => `  ${name}: ${value};`).join('\n');
}

/** 由已解析的品牌包生成浅色主题 CSS；同一品牌值同时落旧变量与 --mt-* 令牌层。 */
export function buildBrandCss(pkg: ResolvedBrand): string {
  const primitive = Object.entries(RAW_TO_PRIMITIVE)
    .filter(([key]) => key in pkg.raw)
    .map(([key, cssVar]) => [cssVar, pkg.raw[key]] as [string, string]);
  const appVars = Object.entries(SEMANTIC_TO_APP_VAR)
    .filter(([key]) => key in pkg.semantic)
    .map(([key, cssVar]) => [cssVar, pkg.semantic[key]] as [string, string]);
  const componentVars = Object.entries(COMPONENT_TO_VAR)
    .filter(([key]) => key in pkg.component)
    .map(([key, cssVar]) => [cssVar, pkg.component[key]] as [string, string]);

  const appEntries: Array<[string, string]> = [
    ...primitive,
    ...appVars,
    ['--accent-text', pkg.component['button.primary.foreground']],
    ['--mt-component-control-radius', pkg.semantic['r-sm']],
    ...componentVars,
  ];

  return `/* T06352 brand ${pkg.semantic['brand']} (${pkg.raw['blue600']}) */\n[data-theme='light'] {\n${cssLines(appEntries)}\n}\n`;
}

export const BRAND_META = {
  name: brandJson.name,
  label: brandJson.label,
  version: brandJson.version,
} as const;

/**
 * 启动时静默兜底：品牌包损坏时退化为既有 themeCss 的默认色，避免应用白屏。
 * 结构问题由 verify-t06352-brand.mjs 在构建前暴露，而不是留到用户端。
 */
export const BRAND_LIGHT_CSS = (() => {
  try {
    return buildBrandCss(resolveBrand(brandJson as unknown as BrandPackage));
  } catch (error) {
    console.error('[brand] 品牌包校验失败，已回退默认主题', error);
    return '';
  }
})();
