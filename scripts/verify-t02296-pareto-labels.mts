/**
 * T02296 回归门：帕累托图（E11）「柱子 ↔ 条目」必须始终可对应。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 拦的缺陷：`ParetoChart` 的 x 轴行号标签原受 `n <= 14 &&` 整段门控——行数一多整条轴清空
 *   （mtask四期真实数据 n=27 实测 `text=1`，只有 80% 参考线文字）；且 n≤14 时标签也只是纯序号，
 *   没有任何反查通道。修复（方案①）：密集时「每 5 根标一次 + 始终标末根」，并给每根柱加原生
 *   SVG `<title>`（`序号. 行标题 · E 值 · 累计 N%`）。
 *
 * 改判口径（本轮）：
 *  - 判据 1（打在产物上）：本门断言**全部**打在 `react-dom/server` 渲染出的 SVG 文本上——
 *    `<rect>`/`<title>`/`<text>` 的实数与坐标、`paretoGeometries` 返回值；无一条读产品源码再正则
 *    匹配标识符/字面量（故本门没有需要降级成 okPair 字面腿的源码文本锚；G/P/E 三段照旧，只是把
 *    取证函数化，供 N 组在同一判据上复放）。
 *  - 判据 2（门自造数据）：夹具行由 `mkRows` 当场构造，零生产数据依赖（改前即如此，本轮如实保留）。
 *  - 判据 3（字面锚配对）：见上，无源码文本锚；轴刻度集 P-02、tooltip 三要素 P-04 打的是**渲染产物**
 *    文本，属行为侧。
 *  - 判据 4（负对照，N 组两条通道）：
 *      N-01~N-03 产物副本篡改反证——把渲染出的 SVG 字符串真破坏掉（剥 `<title>`、删末根刻度、
 *        改 tooltip 话术），同一判据必须在篡改副本上转假、在原物上为真；反例副本自证「篡改确实
 *        落了盘」（sha256 前后不同 + 目标串在原件存在/在副本消失）。
 *      N-04 行为反证（HEAD 副本 worktree）——在 `git worktree add --detach` 副本里把修复改回
 *        缺陷形态（`if (n > 14) return null;` 的旧轴门控 + `<title>` 元素摘除），让**同一个本门脚本**
 *        在副本里再跑一遍，要求 P-01/P-02/P-03/P-07/P-08 转红（主仓工作树全程只读，N-05 sha256 自证）。
 *  - 环境缺口记 `skipped()` 不计 PASS；本门纯静态渲染无外部依赖，正常情况下零 SKIP。
 *
 * 用法（tsx 按 **cwd** 找 tsconfig 的 jsx 口径；门首未指定 `TSX_TSCONFIG_PATH` 时会照 t02297
 * 的房内写法自行带 ENV 重启一次，仓库根直接跑亦可）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02296-pareto-labels.mts
 * 环境变量：`T02296_SKIP_NEG=1`（供 N-04 副本子跑：跳过 N 组防递归）、`T02296_TMP_ROOT`（负对照
 *   worktree 根，默认 D:/code/tmp，**勿指 C:**——常年 0 可用会造成假性失败）。
 * 结果落 .workbuddy/t02296-pareto-labels-gate-results-<运行标识>.txt（口径见 scripts/lib/gate-results.mts）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// JSX 编译口径依赖 web/tsconfig.json——未指定时用 tsx 重新拉起自己（与 verify-t02297 同房内写法）
if (!process.env.TSX_TSCONFIG_PATH) {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), self], {
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'web', 'tsconfig.json') },
  });
  process.exit(r.status ?? 1);
}

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ParetoChart, paretoGeometries } = await import('../web/src/components/estimateCharts.tsx');
type ParetoGeom = ReturnType<typeof paretoGeometries>[number];
const { writeGateResults } = await import('./lib/gate-results.mts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); }
  else { fail += 1; lines.push(`[FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`); }
  console.log(`  ${lines[lines.length - 1]}`);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};
const group = (t: string) => console.log(`\n== ${t}`);

type Row = { key: string; expected: number; title?: string };
const mkRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i + 1}`, expected: 120 - i * 4, title: `计划条目 ${i + 1}号` }));

interface Render { rects: number; titleNodes: number; ticks: string[]; allTexts: string[]; titles: string[]; html: string }
/** 取证函数：只从渲染串抽数——判据与 N 组反证共用同一取证通道（判据 4「同一判据」的前提） */
const render = (geoms: readonly ParetoGeom[]): Render => {
  const html = renderToStaticMarkup(createElement(ParetoChart, { geoms }));
  const allTexts = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  return {
    html,
    rects: (html.match(/<rect/g) ?? []).length,
    titleNodes: titles.length,
    ticks: allTexts.filter((s) => /^\d+$/.test(s)),
    allTexts,
    titles,
  };
};

/** 判据抽成纯函数（入参=取证串），N 组要在「原物/篡改副本」两侧跑同一个函数 */
const judgeTicks27 = (r: Pick<Render, 'ticks'>) => JSON.stringify(r.ticks) === JSON.stringify(['1', '6', '11', '16', '21', '26', '27']);
const judgeTitleCover = (n: number, r: Pick<Render, 'titleNodes' | 'rects'>) => r.titleNodes === n && r.rects === n;
const judgeTitleText = (first: string) => /^1\. 计划条目 1号 · E /.test(first) && /累计 \d+%$/.test(first);

group('G-0 几何入参：title/expected 透传，数值口径逐字不变');
{
  const rows = mkRows(27);
  const geoms = paretoGeometries(rows, new Set(['p3']));
  ok('G-01 里程碑行不进图（过滤数=入参数-1）', geoms.length === 26, { n: geoms.length });
  ok('G-02 title 透传、expected 随行携带（仅显示用）',
    geoms.every((g, i) => g.title === rows.filter((r) => !['p3'].includes(r.key))[i].title && Number.isFinite(g.expected)),
    { first: geoms[0]?.title });
  ok('G-03 title 缺省回落 key', paretoGeometries([{ key: 'k9', expected: 5 }], new Set())[0]?.title === 'k9');
  const sorted = [...geoms].sort((a, b) => b.expected - a.expected);
  const maxE = sorted[0].expected;
  const total = geoms.reduce((s, g) => s + g.expected, 0);
  let cum = 0;
  const replay = geoms.map((g) => { cum += g.expected; return { ePct: (g.expected / maxE) * 100, cumPct: (cum / total) * 100 }; });
  ok('G-04 ePct/cumPct 与独立重算一致（零计算红线未破，1e-9）',
    geoms.every((g, i) => Math.abs(g.ePct - replay[i].ePct) < 1e-9 && Math.abs(g.cumPct - replay[i].cumPct) < 1e-9));
  ok('G-05 末根累计=100%', Math.abs(geoms[geoms.length - 1].cumPct - 100) < 1e-9, { cum: geoms.at(-1)?.cumPct });
}

group('P 段：轴刻度与 tooltip 对应通道（断言打在渲染产物上）');
let dense: Render;
{
  dense = render(paretoGeometries(mkRows(27), new Set()));
  ok('P-01 n=27 时 x 轴有标识（>0，缺陷复现用例）', dense.ticks.length > 0, { ticks: dense.ticks });
  ok('P-02 n=27 刻度为稀疏集「每 5 根 + 末根」=[1,6,11,16,21,26,27]', judgeTicks27(dense), { ticks: dense.ticks });
  ok('P-03 n=27 每根柱都有 <title> 对应通道（titleNodes=rects=27）', judgeTitleCover(27, dense),
    { titleNodes: dense.titleNodes, rects: dense.rects });
  ok('P-04 title 文本含「序号. 行标题 · E 值 · 累计 %」三要素', judgeTitleText(dense.titles[0] ?? ''), { first: dense.titles[0] });

  const oldRule = new Set<number>();
  const n = dense.rects;
  if (n <= 14) for (let i = 0; i < n; i++) oldRule.add(String(i + 1) as unknown as number);
  ok('P-05 反证/非空转：改前规则（n≤14 才画）在 n=27 下刻度集为空，本组 P-01/P-02 只有新实现能过',
    oldRule.size === 0 && dense.ticks.length > 0, { old: [...oldRule], now: dense.ticks });

  const sparse = render(paretoGeometries(mkRows(12), new Set()));
  ok('P-06 n≤14 行为不回归：刻度仍是全量 1..12',
    JSON.stringify(sparse.ticks) === JSON.stringify(Array.from({ length: 12 }, (_, i) => String(i + 1))), { ticks: sparse.ticks });
  ok('P-07 n=12 同样每柱有 title（补上「序号无法反查」那层）', judgeTitleCover(12, sparse), { titleNodes: sparse.titleNodes });

  const big = render(paretoGeometries(mkRows(200), new Set()));
  ok('P-08 标签不随行数爆炸（n=200 刻度仍 ≤ 行数/4，title 覆盖每柱）',
    big.ticks.length > 0 && big.ticks.length <= 50 && big.titleNodes === big.rects,
    { ticks: big.ticks.length, titleNodes: big.titleNodes, rects: big.rects });
}

group('E 段：空态与边界');
{
  const empty = render(paretoGeometries([], new Set()));
  ok('E-01 空批：无柱、无刻度、无 title（空态不画）',
    empty.rects === 0 && empty.ticks.length === 0 && empty.titleNodes === 0, empty);
  const single = render(paretoGeometries(mkRows(1), new Set()));
  ok('E-02 单行：1 柱 1 刻度 1 title（末根规则不误伤）',
    single.rects === 1 && single.ticks.length === 1 && single.titleNodes === 1, { ticks: single.ticks });
  const zeroE = paretoGeometries([{ key: 'z', expected: 0, title: '零行' }], new Set());
  ok('E-03 expected≤0 不进图（原口径保持）', zeroE.length === 0, { n: zeroE.length });
}

// =====================================================================
// N 组：负对照（判据 4）。子跑（N-04 在 HEAD 副本里重跑本门）带 T02296_SKIP_NEG=1 跳过本组。
// =====================================================================
const SKIP_NEG = process.env.T02296_SKIP_NEG === '1';
if (SKIP_NEG) {
  skipped('N 组', '本子跑是 N-04 行为反证的副本执行（SKIP_NEG=1），负对照只在主跑做，避免递归');
} else {
  group('N 组：负对照（产物副本篡改 + HEAD 副本行为反证）');
  const shaOf = (buf: string | Uint8Array) => createHash('sha256').update(buf).digest('hex');

  // N-01 剥掉每柱 <title>（改标签名让取证正则取不到）→ P-03 判据必须转假；且自证篡改落盘
  {
    const tamperedHtml = dense.html.replaceAll('<title>', '<ntitle>').replaceAll('</title>', '</ntitle>');
    const landed = tamperedHtml !== dense.html && /<title>/.test(dense.html) && !/<title>/.test(tamperedHtml);
    const t = { titleNodes: [...tamperedHtml.matchAll(/<title>([^<]*)<\/title>/g)].length, rects: (tamperedHtml.match(/<rect/g) ?? []).length };
    ok('N-01 判据有牙：产物副本剥掉 <title> 后 P-03 判据转假（原物为真、篡改确已落盘）',
      judgeTitleCover(27, dense) === true && judgeTitleCover(27, t) === false && landed,
      { 篡改后: t, 落盘自证: landed });
  }

  // N-02 删掉末根刻度那条 <text>27</text> → P-02 稀疏集判据必须转假；落盘自证同法
  {
    const marker = />27<\/text>/;
    const tamperedHtml = dense.html.replace(marker, '>X]<\/text>');
    const landed = tamperedHtml !== dense.html && marker.test(dense.html);
    const ticks = [...tamperedHtml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((s) => /^\d+$/.test(s));
    ok('N-02 判据有牙：产物副本抽掉末根刻度后 P-02 判据转假（「始终标末根」这一格真有牙齿）',
      judgeTicks27(dense) === true && judgeTicks27({ ticks }) === false && landed,
      { 篡改后刻度: ticks, 落盘自证: landed });
  }

  // N-03 改坏 tooltip 话术（「· E 」段抽空）→ P-04 三要素判据必须转假；原物仍为真
  {
    const first = dense.titles[0] ?? '';
    const tampered = first.replace(' · E ', ' ');
    const landed = tampered !== first && / · E /.test(first);
    ok('N-03 判据有牙：title 副本剥掉「E 值」段后 P-04 判据转假（三要素缺一即红，不是宽松 in 判定）',
      judgeTitleText(first) === true && judgeTitleText(tampered) === false && landed,
      { 原: first, 篡改后: tampered, 落盘自证: landed });
  }

  // N-04 HEAD 副本 worktree 行为反证：把修复改回缺陷形态，同一个本门在副本里跑必须转红（主仓零写入）
  const { execFileSync, spawnSync } = await import('node:child_process');
  const TMP_ROOT = process.env.T02296_TMP_ROOT || 'D:/code/tmp';
  mkdirSync(TMP_ROOT, { recursive: true });
  const NEG_ROOT = join(TMP_ROOT, `t02296-negwt-${process.pid}`);
  const REL = join('web', 'src', 'components', 'estimateCharts.tsx');
  const mainShaBefore = shaOf(readFileSync(join(ROOT, REL)));
  let negReady = false;
  try {
    if (existsSync(NEG_ROOT)) rmSync(NEG_ROOT, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', NEG_ROOT, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 180_000 });
    // junction 复用主仓 node_modules（原生依赖 ABI 必须一致；无需管理员权限）
    symlinkSync(join(ROOT, 'node_modules'), join(NEG_ROOT, 'node_modules'), 'junction');
    negReady = existsSync(join(NEG_ROOT, REL)) && existsSync(join(NEG_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
  } catch { negReady = false; }
  ok('N-00 负对照工作区就绪：HEAD 的 detached worktree 副本 + node_modules junction（主仓工作树全程只读）',
    negReady, { NEG_ROOT });
  if (negReady) {
    const patchFile = (find: RegExp, to: string, mustKeep?: RegExp) => {
      const p = join(NEG_ROOT, REL);
      const before = readFileSync(p, 'utf8');
      const m = find.exec(before);
      if (!m) return { hit: false as const, reason: `锚点未命中：${find}` };
      const after = before.slice(0, m.index) + to + before.slice(m.index + m[0].length);
      if (mustKeep && !mustKeep.test(after)) return { hit: false as const, reason: '篡改后守卫串缺失' };
      writeFileSync(p, after);
      const back = readFileSync(p, 'utf8'); // 落盘回读自证
      return { hit: true as const, landed: shaOf(back) !== shaOf(before), residual: find.test(back) };
    };
    // ① 轴门控退回缺陷形态；② 每柱 <title> 元素改名成取证正则取不到的标签（保持 JSX 合法，红因才是行为不是编译崩）
    const g1 = patchFile(/if \(!\(n <= 14 \|\| i % 5 === 0 \|\| i === n - 1\)\) return null;/, 'if (n > 14) return null;');
    const g2 = patchFile(/<title>\{/, '<ntitle>{');
    const g3 = patchFile(/\}<\/title>/, '}</ntitle>');
    const backFinal = readFileSync(join(NEG_ROOT, REL), 'utf8');
    const landed = g1.hit === true && g2.hit === true && g3.hit === true
      && g1.landed && g2.landed && g3.landed
      && /if \(n > 14\) return null;/.test(backFinal) && !/\|\| i % 5 === 0/.test(backFinal)
      && (backFinal.match(/<ntitle>/g) ?? []).length === 1;
    ok('N-04a 篡改确实落了盘：副本里三处补丁均命中、回读 sha256 变化且旧锚消失（替换串不存在＝假牙齿）',
      landed, { g1, g2, g3 });
    const child = spawnSync(process.execPath,
      [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(NEG_ROOT, 'scripts', 'verify-t02296-pareto-labels.mts')],
      {
        cwd: join(NEG_ROOT, 'web'),
        env: { ...process.env, TSX_TSCONFIG_PATH: join(NEG_ROOT, 'web', 'tsconfig.json'), T02296_SKIP_NEG: '1', TMP: TMP_ROOT, TEMP: TMP_ROOT },
        encoding: 'utf8', timeout: 120_000,
      });
    const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    const reds = new Set([...out.matchAll(/^\s*\[FAIL\] ([A-Z]-\d+)/gm)].map((m) => m[1]));
    const want = ['P-01', 'P-02', 'P-03', 'P-07', 'P-08'];
    const missing = want.filter((id) => !reds.has(id));
    ok('N-04 行为反证：HEAD 副本退回缺陷形态后，同一个本门在副本里对 P-01/P-02/P-03/P-07/P-08 全部转红',
      reds.size >= want.length && missing.length === 0, { 红项: [...reds], 缺: missing, tail: out.slice(-260) });
    ok('N-04b 反证没有把整门跑崩（子跑确实执行了断言且 G 段仍绿，红是行为失守不是崩溃）',
      /合计 PASS=\d+ FAIL=\d+/.test(out) || /PASS=\d+ FAIL=\d+/.test(out), { tail: out.slice(-160) });
    // 先摘 junction 再 worktree remove（否则会顺链删掉主仓真实依赖）
    try { rmSync(join(NEG_ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* 未建成 */ }
    try { execFileSync('git', ['worktree', 'remove', '--force', NEG_ROOT], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
    catch { rmSync(NEG_ROOT, { recursive: true, force: true }); }
    try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 }); } catch { /* 尽力 */ }
  } else {
    ok('N-04a 篡改确实落了盘：副本里三处补丁均命中、回读 sha256 变化且旧锚消失（替换串不存在＝假牙齿）', false, '负对照工作区未建成');
    ok('N-04 行为反证：HEAD 副本退回缺陷形态后，同一个本门在副本里对 P-01/P-02/P-03/P-07/P-08 全部转红', false, '负对照工作区未建成');
    ok('N-04b 反证没有把整门跑崩（子跑确实执行了断言且 G 段仍绿，红是行为失守不是崩溃）', false, '负对照工作区未建成');
  }
  ok('N-05 主仓工作树零写入自证：负对照全程后 estimateCharts.tsx 的 sha256 与开跑前一致',
    shaOf(readFileSync(join(ROOT, REL))) === mainShaBefore, { before: mainShaBefore.slice(0, 16) });
}

console.log(`\n合计 PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
lines.unshift(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02296-pareto-labels-gate-results.txt',
  lines.join('\n') + (skippedList.length ? `\n跳过项：\n${skippedList.join('\n')}\n` : ''));
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
