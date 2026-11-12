/**
 * T05686 门：AI 大纲 JSON 的结构位全角标点容错。
 *
 * 现场报错：「大纲生成失败：AI 未返回合规大纲：Expected double-quoted property name in JSON
 * at position 642 (line 5 column 194)（已自动重试 1 次）」——多项目合并大纲时模型把
 * 全角冒号/逗号写进了结构位（`{"title"："x"，"bullets"：[…]}`），报错文案指向「属性名」，
 * 看着像引号问题，实际是 `"title"` 后面那个 `：`。
 *
 * 判据：
 *   A 组 行为——全角冒号/逗号/全角空格在结构位被归一后可解析；字符串内的全角标点原样保留；
 *        尾逗号/围栏/中文引号等既有容错不回归；未闭合 JSON 仍然抛错（不静默返回空对象）。
 *   B 组 源码锚——parseAiJson 的修复链包含 normalizeJsonPunct，且命中会记入 hits（不静默改写）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05686-json-punct.mts
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

const S = await import('../../server/src/services/kickoffService.ts');
const parse = (s: string, hits?: string[]) => S.parseAiJson(s, hits) as unknown;

// A-01：最贴近现场的一条——全角冒号 + 全角逗号 + 相邻字符串漏逗号
const realWorld = `[
  {"section"："背景"，"title"："BEMP 项目背景"，"bullets"：["「REQ-001」待确认" "「REQ-002」已闭环"]，"dataKeys"：["reqList"]，"layout"："table"}
]`;
{
  const hits: string[] = [];
  const v = parse(realWorld, hits) as Array<{ title: string; bullets: string[] }>;
  ok('A-01 结构位全角冒号/逗号 + 相邻字符串漏逗号：可解析且字段值正确',
    Array.isArray(v) && v[0]?.title === 'BEMP 项目背景' && v[0]?.bullets?.length === 2,
    { hits, got: v });
  ok('A-02 修复命中已记入 hits（不静默改写）',
    hits.some((h) => /全角标点/.test(h)), hits);
}

// A-03：字符串内的全角标点是内容，必须原样保留
{
  const v = parse('[{"title"："进度，延后：两周"}]') as Array<{ title: string }>;
  ok('A-03 字符串内的全角逗号/冒号原样保留（只改结构位）',
    v[0]?.title === '进度，延后：两周', v[0]?.title);
}

// A-04：全角空格
ok('A-04 结构位全角空格归一后可解析',
  (parse('[{\u3000"a"\u3000:\u30001}]') as Array<{ a: number }>)[0]?.a === 1);

// A-05/A-06：既有容错不回归
ok('A-05 尾逗号仍可解析（T03589 既有能力不回归）',
  (parse('[{"a":1,},{"b":2,},]') as unknown[]).length === 2);
ok('A-06 代码围栏仍可剥离',
  (parse('```json\n[{"a":1}]\n```') as unknown[]).length === 1);

// A-07：坏输入仍要报错——不能为了「不报错」把解析失败吞成空对象
{
  let threw = false;
  try { parse('[{"a": 1'); } catch { threw = true; }
  ok('A-07 未闭合 JSON 仍然抛错（容错不等于放开）', threw);
}

// B 组：源码锚
const SRC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');
ok('B-01 parseAiJson 的修复链包含 normalizeJsonPunct 且顺序在引号修复之后',
  /const punct = normalizeJsonPunct\(quotes\.text\)/.test(SRC)
  && SRC.indexOf('normalizeJsonPunct(quotes.text)') > SRC.indexOf('repairChineseJsonQuotes(stripFence(content))'),
  { hasFn: /export function normalizeJsonPunct/.test(SRC) });
ok('B-02 归一范围限定结构位（字符串内走 continue，不改内容）',
  /if \(inStr\) \{[\s\S]{0,220}continue;/.test(SRC.slice(SRC.indexOf('export function normalizeJsonPunct'))));

const body = [`T05686 JSON 全角标点门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05686-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05686-gate-results.txt')}`);
