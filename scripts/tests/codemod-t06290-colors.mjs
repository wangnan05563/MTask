/**
 * T06290 Codemod：把旧颜色变量的十六进制 fallback 收敛为纯语义 Token。
 *
 * 只处理 `var(--semantic, #hex)` 形式——变量名已存在、fallback 只是历史兜底；
 * 不触碰主题定义、数据可视化色板、PPT 品牌色与用户可选色。
 *
 * 用法：
 *   node scripts/tests/codemod-t06290-colors.mjs          # dry-run，只打印拟替换数
 *   node scripts/tests/codemod-t06290-colors.mjs --write  # 落盘
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'web', 'src');
const WRITE = process.argv.includes('--write');
const TOKENS = [
  'accent', 'accent-ink', 'accent-text', 'accent-soft',
  'success', 'success-strong', 'danger', 'warning', 'warn',
  'text', 'text-secondary', 'text-muted',
  'border', 'border-strong', 'card-bg', 'app-bg', 'surface', 'surface-2',
  'on-solid', 'on-dark', 'success-soft', 'danger-soft', 'warning-soft',
];
const RE = new RegExp(`var\\((--(?:${TOKENS.map((t) => t.replace(/[-]/g, '\\-')).join('|')}))\\s*,\\s*#[0-9a-fA-F]{3,8}\\)`, 'g');

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (['.tsx', '.ts', '.css'].includes(extname(p))) files.push(p);
  }
};
walk(SRC);

let total = 0;
const changed = [];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const matches = before.match(RE) ?? [];
  if (matches.length === 0) continue;
  const after = before.replace(RE, 'var($1)');
  total += matches.length;
  changed.push({ file: relative(ROOT, file).replace(/\\/g, '/'), count: matches.length });
  if (WRITE) writeFileSync(file, after, 'utf8');
}

for (const c of changed) console.log(`${WRITE ? '[WRITE]' : '[DRY]'} ${c.file} → ${c.count}`);
console.log(`\n[t06290-codemod] mode=${WRITE ? 'write' : 'dry'} files=${changed.length} replacements=${total}`);
// dry-run 兼作门禁：仍有可收敛的 fallback 时返回非 0
if (!WRITE && total > 0) process.exitCode = 1;
