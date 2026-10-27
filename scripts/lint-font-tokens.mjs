#!/usr/bin/env node
/**
 * T03220（UX-11）：字号令牌 lint 门禁 —— 新增「数字字号」直接判失败。
 *
 * 为什么需要它：PM-301④ 把应用内统一字号收敛到 `--fs-*` 档位变量，用户切字号档时界面才会整体跟随。
 * 只要还剩一处写死 `fontSize: 12`，那一处在「小/大」档下就不跟随——整改做完全覆盖后，
 * 缺的不是「再清一遍」而是「不让再写进来」，所以这条 lint 进了提交链路（scripts/safe-commit.mjs）。
 *
 * 三条规则（对 web/src 全量，或 --paths 指定的文件子集）：
 *   F-1  `fontSize: <数字>`        —— React 内联样式对象里的数字字号
 *   F-2  `fontSize: '<N>px|pt'`    —— 字符串写死 px/pt 的同款变体
 *   F-3  `font-size: <N>px|pt`     —— CSS 文本（模板串 / `<style>`）里的字号
 * 令牌定义本身（`--fs-s: 12px` 这类）**不**命中：规则只认 `font-size` 属性名，不认自定义属性。
 *
 * 用法：
 *   node scripts/lint-font-tokens.mjs                 # 全量扫描 web/src
 *   node scripts/lint-font-tokens.mjs --paths a.tsx b.tsx   # 只扫这几个文件（提交链路用：
 *                                                       #   别人的 WIP 不得冒充本次提交的失败）
 * 退出码：0 无违规；1 有违规（逐条打 file:line + 片段）；2 用法/IO 错误。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'web', 'src');

const RULES = [
  { id: 'F-1', re: /\bfontSize:\s*\d+(?:\.\d+)?\b/, hint: '改用 fontSize: \'var(--fs-*)\'' },
  { id: 'F-2', re: /\bfontSize:\s*['"]\d+(?:\.\d+)?(?:px|pt)['"]/, hint: '改用 fontSize: \'var(--fs-*)\'' },
  { id: 'F-3', re: /\bfont-size:\s*\d+(?:\.\d+)?(?:px|pt)\b/, hint: '改用 font-size: var(--fs-*)' },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(name)) out.push(p);
  }
  return out;
}

function scan(files) {
  const hits = [];
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch (e) {
      process.stderr.write(`读取失败 ${f}: ${e.message}\n`);
      process.exit(2);
    }
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const r of RULES) {
        if (r.re.test(lines[i])) hits.push({ 文件: rel, 行: i + 1, 规则: r.id, 提示: r.hint, 片段: lines[i].trim().slice(0, 120) });
      }
    }
  }
  return hits;
}

const argv = process.argv.slice(2);
let files;
if (argv[0] === '--paths') {
  files = argv.slice(1).map((p) => resolve(ROOT, p));
} else if (argv.length > 0) {
  process.stderr.write('用法：node scripts/lint-font-tokens.mjs [--paths <文件...>]\n');
  process.exit(2);
} else {
  files = walk(WEB_SRC);
}

const hits = scan(files);
const scope = argv[0] === '--paths' ? `${files.length} 个指定文件` : `web/src 全量（${files.length} 个文件）`;
if (hits.length === 0) {
  console.log(`[PASS] 字号令牌 lint：${scope} — 数字字号 0 处（F-1/F-2/F-3 全清）`);
  process.exit(0);
}
console.log(`[FAIL] 字号令牌 lint：${scope} — 数字字号 ${hits.length} 处（应用 --fs-* 档位令牌）`);
for (const h of hits) console.log(`  ${h.文件}:${h.行} [${h.规则}] ${h.片段}\n      → ${h.提示}`);
process.exit(1);
