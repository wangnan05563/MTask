#!/usr/bin/env node
/**
 * T06287 UI 组件库静态门禁。
 * 校验：文件齐全、统一出口、Token 接入、状态 API、零硬编码色、零 primitive 直引、组件文档存在。
 *
 * 用法：node scripts/verify-t06287-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const uiRoot = path.join(repoRoot, 'web/src/ui/components');

const files = {
  button: path.join(uiRoot, 'Button.tsx'),
  iconButton: path.join(uiRoot, 'IconButton.tsx'),
  input: path.join(uiRoot, 'Input.tsx'),
  table: path.join(uiRoot, 'Table.tsx'),
  card: path.join(uiRoot, 'Card.tsx'),
  badge: path.join(uiRoot, 'Badge.tsx'),
  skeleton: path.join(uiRoot, 'Skeleton.tsx'),
  emptyState: path.join(uiRoot, 'EmptyState.tsx'),
  index: path.join(uiRoot, 'index.ts'),
  css: path.join(repoRoot, 'web/src/ui/components.css'),
  main: path.join(repoRoot, 'web/src/main.tsx'),
  docs: path.join(repoRoot, 'docs/十期-UI组件库-T06287.md'),
};

const failures = [];
function read(p) {
  if (!fs.existsSync(p)) {
    failures.push(`缺少文件: ${path.relative(repoRoot, p)}`);
    return '';
  }
  return fs.readFileSync(p, 'utf8');
}
const contents = Object.fromEntries(Object.entries(files).map(([key, p]) => [key, read(p)]));

for (const key of Object.keys(files)) {
  if (!contents[key]) continue;
  const text = contents[key];
  if (key !== 'docs' && /#[0-9a-f]{3,8}\b/i.test(text)) failures.push(`${path.relative(repoRoot, files[key])} 含十六进制硬编码色`);
  if (key !== 'docs' && text.includes('--mt-primitive-')) failures.push(`${path.relative(repoRoot, files[key])} 直接引用 primitive Token`);
}

if (contents.index) {
  for (const name of ['Button', 'IconButton', 'Input', 'Table', 'Card', 'Badge', 'Skeleton', 'EmptyState']) {
    if (!contents.index.includes(name)) failures.push(`统一出口缺少 ${name}`);
  }
}
if (contents.main && !contents.main.includes("./theme/tokens.css")) failures.push('main.tsx 未接入 tokens.css');
if (contents.main && !contents.main.includes("./ui/components.css")) failures.push('main.tsx 未接入 components.css');

if (contents.button) {
  for (const marker of ['loading', 'disabled', 'aria-busy', 'mt-btn__spinner', 'data-variant']) {
    if (!contents.button.includes(marker)) failures.push(`Button 缺少状态标记: ${marker}`);
  }
}
if (contents.input) {
  for (const marker of ['aria-invalid', 'aria-describedby', 'aria-errormessage', 'mt-field__error', 'data-invalid']) {
    if (!contents.input.includes(marker)) failures.push(`Input 缺少状态标记: ${marker}`);
  }
}
if (contents.table) {
  for (const marker of ['aria-busy', 'data-selected', 'scope="col"', 'mt-table__empty', 'mt-table__skeleton']) {
    if (!contents.table.includes(marker)) failures.push(`Table 缺少状态标记: ${marker}`);
  }
}
if (contents.css) {
  for (const marker of [':focus-visible', ':focus-within', 'data-density', 'mt-table__skeleton']) {
    if (!contents.css.includes(marker)) failures.push(`components.css 缺少状态样式: ${marker}`);
  }
}
if (contents.docs && contents.docs.length < 1600) failures.push('组件文档过短，未达到可交接说明');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?|css)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const allWebFiles = walk(path.join(repoRoot, 'web/src'));
const tokenFile = path.resolve(path.join(repoRoot, 'web/src/theme/tokens.css'));
let hardcoded = 0;
let newHardcoded = 0;
const newFiles = new Set(Object.values(files).filter((p) => p.startsWith(uiRoot) || p.endsWith('components.css')).map((p) => path.resolve(p)));
for (const file of allWebFiles) {
  if (path.resolve(file) === tokenFile) continue;
  const text = fs.readFileSync(file, 'utf8');
  const count = [...text.matchAll(/#[0-9a-f]{3,8}\b/gi)].length;
  hardcoded += count;
  if (newFiles.has(path.resolve(file))) newHardcoded += count;
}

const summary = {
  components: ['Button', 'IconButton', 'Input', 'Table', 'Card', 'Badge', 'Skeleton', 'EmptyState'],
  docsBytes: contents.docs ? contents.docs.length : 0,
  newHardcodedColor: newHardcoded,
  existingHardcodedColorBaseline: hardcoded,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} 项`);
  process.exit(1);
}
console.log('\nPASS: T06287 UI 组件库结构、状态 API、Token 接入与零硬编码门禁通过。');
