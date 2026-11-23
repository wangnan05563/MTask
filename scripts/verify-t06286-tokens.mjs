#!/usr/bin/env node
/**
 * T06286 Token 体系门禁。
 * 校验：
 * 1. 三层 Token 结构存在，命名符合 --mt-{category}-{role}-{state}；
 * 2. light / dark / high-contrast 三套主题的 semantic Token 键集合一致；
 * 3. component 颜色 Token 只引用 semantic，不越过 semantic 直接引用 primitive；
 * 4. 关键文字对背景的对比度 ≥ 4.5:1；
 * 5. 统计旧代码硬编码色数量（AC-04 迁移前基线，不阻断本设计任务）。
 *
 * 用法：node scripts/verify-t06286-tokens.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tokenFile = path.join(repoRoot, 'web/src/theme/tokens.css');
const css = fs.readFileSync(tokenFile, 'utf8');
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
let braceDepth = 0;
for (const ch of cssWithoutComments) {
  if (ch === '{') braceDepth += 1;
  if (ch === '}') braceDepth -= 1;
  if (braceDepth < 0) break;
}
if (braceDepth !== 0) throw new Error(`tokens.css 花括号不平衡，剩余深度 ${braceDepth}`);

function section(start, end) {
  const s = css.indexOf(start);
  const e = css.indexOf(end);
  if (s < 0 || e < 0 || e <= s) throw new Error(`缺少区块标记: ${start} / ${end}`);
  return css.slice(s + start.length, e);
}

function declarations(text) {
  const map = new Map();
  for (const m of text.matchAll(/(--mt-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

const primitive = declarations(section('/* === primitive:start === */', '/* === primitive:end === */'));
const themes = {
  light: declarations(section('/* === semantic:light:start === */', '/* === semantic:light:end === */')),
  dark: declarations(section('/* === semantic:dark:start === */', '/* === semantic:dark:end === */')),
  'high-contrast': declarations(section('/* === semantic:hc:start === */', '/* === semantic:hc:end === */')),
};
const component = declarations(section('/* === component:start === */', '/* === component:end === */'));

const requiredSemantic = [
  '--mt-semantic-bg-canvas', '--mt-semantic-bg-surface', '--mt-semantic-bg-elevated',
  '--mt-semantic-bg-subtle', '--mt-semantic-bg-hover',
  '--mt-semantic-text-primary', '--mt-semantic-text-secondary', '--mt-semantic-text-muted',
  '--mt-semantic-text-inverse',
  '--mt-semantic-border-default', '--mt-semantic-border-strong', '--mt-semantic-border-focus',
  '--mt-semantic-accent-primary', '--mt-semantic-accent-primary-hover',
  '--mt-semantic-accent-soft', '--mt-semantic-accent-on',
  '--mt-semantic-status-success-fg', '--mt-semantic-status-success-bg',
  '--mt-semantic-status-danger-fg', '--mt-semantic-status-danger-bg',
  '--mt-semantic-status-warn-fg', '--mt-semantic-status-warn-bg',
  '--mt-semantic-status-info-fg', '--mt-semantic-status-info-bg',
  '--mt-semantic-overlay',
  ...Array.from({ length: 8 }, (_, i) => `--mt-semantic-chart-${i + 1}`),
  '--mt-semantic-chart-grid', '--mt-semantic-chart-axis', '--mt-semantic-chart-label',
  '--mt-semantic-diff-add-bg', '--mt-semantic-diff-add-fg',
  '--mt-semantic-diff-del-bg', '--mt-semantic-diff-del-fg',
  '--mt-semantic-diff-ctx-bg', '--mt-semantic-diff-ctx-fg',
  '--mt-semantic-gantt-bar-bg', '--mt-semantic-gantt-bar-fg', '--mt-semantic-gantt-grid',
  '--mt-semantic-canvas-bg', '--mt-semantic-canvas-node-bg',
  '--mt-semantic-canvas-node-border', '--mt-semantic-canvas-edge',
];

const requiredComponent = [
  '--mt-component-button-primary-bg', '--mt-component-button-primary-fg',
  '--mt-component-button-primary-border', '--mt-component-button-primary-hover-bg',
  '--mt-component-button-secondary-bg', '--mt-component-button-secondary-fg',
  '--mt-component-button-secondary-border', '--mt-component-button-secondary-hover-bg',
  '--mt-component-button-danger-bg', '--mt-component-button-danger-fg',
  '--mt-component-button-danger-border', '--mt-component-button-danger-hover-bg',
  '--mt-component-input-bg', '--mt-component-input-fg', '--mt-component-input-border',
  '--mt-component-input-border-focus',
  '--mt-component-card-bg', '--mt-component-card-border',
  '--mt-component-table-header-bg', '--mt-component-table-row-bg',
  '--mt-component-table-row-hover-bg', '--mt-component-table-border',
  '--mt-component-nav-bg', '--mt-component-nav-active-bg', '--mt-component-nav-active-fg',
  '--mt-component-toast-bg', '--mt-component-toast-fg',
  '--mt-component-drawer-bg', '--mt-component-drawer-border',
  '--mt-component-tag-bg', '--mt-component-tag-fg', '--mt-component-focus-ring',
];

const failures = [];
for (const name of [primitive, themes.light, themes.dark, themes['high-contrast'], component]) {
  for (const [key, value] of name) {
    if (!/^--mt-(primitive|semantic|component)-[a-z0-9-]+$/.test(key)) failures.push(`非法 Token 名: ${key}`);
    if (!value) failures.push(`Token 值为空: ${key}`);
  }
}
for (const key of requiredSemantic) {
  for (const [themeName, theme] of Object.entries(themes)) {
    if (!theme.has(key)) failures.push(`${themeName} 缺少 semantic Token: ${key}`);
  }
}
const lightKeys = [...themes.light.keys()].sort();
for (const themeName of ['dark', 'high-contrast']) {
  const keys = [...themes[themeName].keys()].sort();
  if (keys.join('|') !== lightKeys.join('|')) {
    failures.push(`${themeName} 的 semantic 键集合与 light 不一致`);
  }
}
for (const key of requiredComponent) {
  if (!component.has(key)) failures.push(`缺少 component Token: ${key}`);
}
for (const [key, value] of component) {
  if (/(bg|fg|border|focus|ring)$/.test(key) && !value.startsWith('var(--mt-semantic-')) {
    failures.push(`component Token 绕过 semantic 直接取值: ${key}=${value}`);
  }
}

for (const [key, value] of primitive) {
  try {
    parseOpaqueColor(value, primitive);
  } catch (e) {
    failures.push(`primitive Token 颜色非法: ${key}=${value} (${e.message})`);
  }
}
for (const [themeName, theme] of Object.entries(themes)) {
  const map = new Map([...primitive, ...theme]);
  for (const [key, value] of theme) {
    if (key === '--mt-semantic-overlay') continue;
    try {
      parseOpaqueColor(value, map);
    } catch (e) {
      failures.push(`${themeName} semantic Token 无法解析: ${key}=${value} (${e.message})`);
    }
  }
}
for (const [key, value] of component) {
  if (!/(bg|fg|border|focus|ring)$/.test(key)) continue;
  try {
    parseOpaqueColor(value, new Map([...primitive, ...themes.light]));
  } catch (e) {
    failures.push(`component Token 无法解析: ${key}=${value} (${e.message})`);
  }
}

function normHex(v) {
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return null;
}
function parseOpaqueColor(v, map, depth = 0) {
  if (depth > 8) throw new Error(`Token 引用循环: ${v}`);
  const s = v.trim();
  const varMatch = /^var\((--mt-[a-z0-9-]+)\)$/.exec(s);
  if (varMatch) {
    const next = map.get(varMatch[1]);
    if (!next) throw new Error(`未定义引用: ${varMatch[1]}`);
    return parseOpaqueColor(next, map, depth + 1);
  }
  const hex = normHex(s);
  if (hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(s);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 1) throw new Error(`对比度检查不接受半透明色: ${s}`);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  throw new Error(`无法解析颜色: ${s}`);
}
function relLum([r, g, b]) {
  const c = [r, g, b].map((x) => {
    const v = x / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const checks = [
  ['text-primary', 'bg-canvas'],
  ['text-secondary', 'bg-surface'],
  ['text-muted', 'bg-surface'],
  ['accent-on', 'accent-primary'],
  ['status-success-fg', 'bg-canvas'],
  ['status-danger-fg', 'bg-canvas'],
  ['status-warn-fg', 'bg-canvas'],
  ['status-info-fg', 'bg-canvas'],
  ['chart-label', 'bg-canvas'],
  ['diff-add-fg', 'diff-add-bg'],
  ['diff-del-fg', 'diff-del-bg'],
  ['diff-ctx-fg', 'diff-ctx-bg'],
  ['gantt-bar-fg', 'gantt-bar-bg'],
];
const contrastRows = [];
for (const [themeName, theme] of Object.entries(themes)) {
  const map = new Map([...primitive, ...theme]);
  for (const [fg, bg] of checks) {
    const fgVal = theme.get(`--mt-semantic-${fg}`);
    const bgVal = theme.get(`--mt-semantic-${bg}`);
    if (!fgVal || !bgVal) continue;
    try {
      const ratio = contrast(parseOpaqueColor(fgVal, map), parseOpaqueColor(bgVal, map));
      contrastRows.push({ theme: themeName, pair: `${fg}/${bg}`, ratio: Number(ratio.toFixed(2)) });
      if (ratio < 4.5) failures.push(`${themeName} 对比度不足: ${fg}/${bg} = ${ratio.toFixed(2)}`);
    } catch (e) {
      failures.push(`${themeName} 对比度检查失败 ${fg}/${bg}: ${e.message}`);
    }
  }
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?|css)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(path.join(repoRoot, 'web/src'));
const tokenAbs = path.resolve(tokenFile);
let hardcoded = 0;
let directPrimitive = 0;
for (const f of srcFiles) {
  if (path.resolve(f) === tokenAbs) continue;
  const text = fs.readFileSync(f, 'utf8');
  hardcoded += [...text.matchAll(/#[0-9a-f]{3,8}\b/gi)].length;
  directPrimitive += [...text.matchAll(/--mt-primitive-[a-z0-9-]+/g)].length;
}
if (directPrimitive > 0) failures.push(`页面/组件直接引用 primitive Token ${directPrimitive} 处`);

const minRow = contrastRows.reduce(
  (acc, row) => (acc === null || row.ratio < acc.ratio ? row : acc),
  null,
);
const summary = {
  tokenFile: path.relative(repoRoot, tokenFile),
  primitiveTokens: primitive.size,
  semanticTokensPerTheme: themes.light.size,
  componentTokens: component.size,
  themes: Object.keys(themes),
  contrastChecks: contrastRows.length,
  minContrast: minRow ? minRow.ratio : null,
  minContrastPair: minRow ? `${minRow.theme} ${minRow.pair}` : null,
  hardcodedColorBaseline: hardcoded,
  directPrimitiveRefs: directPrimitive,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--details')) {
  console.log('\nCONTRAST_DETAILS');
  console.log(JSON.stringify(contrastRows, null, 2));
}
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} 项`);
  process.exit(1);
}
console.log('\nPASS: T06286 Token 结构、三主题一致性、component 隔离与对比度门禁通过。');
