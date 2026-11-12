/**
 * T05695 门：启动会大纲生成的输出预算托底。
 *
 * 现场（真链路留档）：12~18 页大纲 JSON 在工具默认 max_tokens（≈4096）下被截断——
 * 「已输出 5050 字符——请调大该工具的 max_tokens」直接判死重试轮；而首轮「单条 bullet 超出 42 字」
 * 本可走「硬拒→重试自纠→lenient 裁剪」链收口，只是重试轮输出又被预算掐断。
 *
 * 判据：
 *   A-01 kickoffOutline 的 askJson 补 minMaxTokens=8192（T02275 下限语义，PRD 解析同款先例）。
 *   A-02 托底而非硬覆盖——工具配置更高时不被砍回（用 minMaxTokens，不用 maxTokens）。
 *   A-03 「硬拒→重试自纠→lenient 裁剪」链不被回退（T02223 口径逐字保留）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05695-outline-budget.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const SVC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');
const AISVC = readFileSync(join(ROOT, 'server/src/services/AIService.ts'), 'utf8');

const outline = SVC.slice(SVC.indexOf('export async function kickoffOutline'));
ok('A-01 kickoffOutline 的 askJson 补输出预算托底 minMaxTokens=8192（T05695）',
  /cardKey: 'ai\.kickoff_ppt',[\s\S]{0,300}minMaxTokens: 8192,/.test(outline));
ok('A-02 用下限语义（minMaxTokens）而非硬覆盖——工具配置更高时不再被砍回（T02275 单源判定）',
  !outline.slice(0, outline.indexOf('const warnings')).includes('maxTokens:')
  && /Math\.max\(configMax \?\? 4096, minMaxTokens\)/.test(AISVC));
ok('A-03 「首轮硬拒 → 重试自纠 → lenient 裁剪」链保留（T02223 口径不回退）',
  /lenientBullets: parseRound > 1/.test(outline)
  && /单条 bullet 超出 \$\{BULLET_MAX_CHARS\} 字/.test(SVC)
  && /重试后仍超限，已裁剪为 \$\{BULLET_MAX_CHARS\} 字/.test(SVC));
ok('A-04 askJson 的 parse 回调留档口径不动（失败可追「厂商原始响应」）',
  /厂商原始响应已留档/.test(outline));

const body = [`T05695 大纲预算门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05695-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05695-gate-results.txt')}`);
