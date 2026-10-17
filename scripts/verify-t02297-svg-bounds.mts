/**
 * T02297 回归门：估算面板三图（E11 阶段柱 / E11 帕累托 / E14 龙卷风）的
 * 「<text> 越出 viewBox」与「柱子↔条目可对应」断言。
 *
 * 拦的是**几何类**缺陷：字宽/条宽/viewBox 三者算错才显形，`tsc --noEmit`、API 门、PDF 门全看不见。
 * 同族缺陷已发生过一次（T02083：σ 数值被 SVG 裁掉，靠一次性 Playwright 探针发现，修完没留门）；
 * 本门把「任何人把 `X1`/`SIGMA_LABEL_RESERVE`/字号改回去 → CI 全绿、缺陷静默复发」这条路堵上。
 *
 * 机制：`react-dom/server` 静态渲染三图 → 取 `viewBox` 宽与每个 `<text>` 的
 * `x`/`font-size`/`text-anchor` → 按 textAnchor 语义 + 估算字宽（CJK 计 1.0×fs、其余 0.55×fs）
 * 求左右边界 → 断言不得越出 viewBox（±0.5 容差）。断言只喂**夹具**（含 T02083 的贴边用例
 * 「最长条 + 三位数 σ 108.5」），不锚实现字面量、不读生产数据。
 *
 * 用法（无需起服务、无网络、无 AI；纯静态渲染）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02297-svg-bounds.mts
 * 仓库根**没有** tsconfig.json，只有 web/tsconfig.json（`jsx: react-jsx`）；从根跑若不指定它，
 * JSX 会编成经典运行时 → `ReferenceError: React is not defined`。门首自行补 `TSX_TSCONFIG_PATH`
 * 再透传重启（照 scripts/verify-t02192-prdgen-pointer.mts 的房内写法，不依赖 npm script 的 ENV 前缀）。
 *
 * 已知边界（如实）：只断水平边界与对应通道，不断纵向越界与文字互相重叠。
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// JSX 编译口径依赖 web/tsconfig.json —— 未指定时用 tsx 重新拉起自己（argv 里没有 tsx cli 时
// 直接透传 execArgv 会变成「node 裸跑 .mts」，Node 的 type-stripping 不认 .tsx → 假失败）
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
const { PhaseBarChart, ParetoChart, TornadoChart, paretoGeometries, tornadoGeometries } =
  await import('../web/src/components/estimateCharts.tsx');
const { writeGateResults } = await import('./lib/gate-results.mts');

type TextNode = { x: number; right: number; left: number; s: string };
type Parsed = { vbW: number; texts: TextNode[]; titles: number; ticks: number };

// CJK/全角按 1 字宽、其余按 0.55 字宽估算（首轮曾因字符类误匹配 ASCII 数字而假红，故按码位区间判定）
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯…·±→∝≤]/;
const estWidth = (s: string, fs: number): number =>
  [...s].reduce((w, ch) => w + (CJK.test(ch) ? fs : fs * 0.55), 0);

/** 渲染 → 抽出 viewBox 宽与每个 text 的左右边界（按 textAnchor 语义换算） */
function parse(html: string): Parsed {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html);
  if (!vb) throw new Error('未取得 viewBox');
  const vbW = Number(vb[1]);
  const texts: TextNode[] = [];
  for (const m of html.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const x = Number(/ x="([-\d.]+)"/.exec(m[1])?.[1] ?? NaN);
    const fs = Number(/ font-size="([\d.]+)"/.exec(m[1])?.[1] ?? 10);
    const anchor = / text-anchor="(\w+)"/.exec(m[1])?.[1] ?? 'start';
    const w = estWidth(m[2], fs);
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    const right = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x : x + w;
    texts.push({ x, right, left, s: m[2] });
  }
  return { vbW, texts, titles: (html.match(/<title>/g) ?? []).length, ticks: texts.filter((t) => /^\d+$/.test(t.s)).length };
}

const lines: string[] = [];
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  console.log(lines[lines.length - 1]);
  if (cond) pass++; else fail++;
};
const within = (name: string, p: Parsed): void => {
  const bad = p.texts.filter((t) => t.right > p.vbW + 0.5 || t.left < -0.5);
  ok(`${name}：所有文字落在 viewBox 宽 ${p.vbW} 内`, bad.length === 0,
    bad.map((b) => `「${b.s}」x=${b.x} [${b.left.toFixed(1)},${b.right.toFixed(1)}]`).join(' / '));
  // 现场量纲一并留档：日后调字号/调 reserve 时知道余量还剩多少
  const minLeft = Math.min(...p.texts.map((t) => t.left));
  const maxRight = Math.max(...p.texts.map((t) => t.right));
  const note = `     ↳ viewBox=${p.vbW} 文字边界=[${minLeft.toFixed(1)}, ${maxRight.toFixed(1)}] 右侧余量=${(p.vbW - maxRight).toFixed(1)}`;
  lines.push(note);
  console.log(note);
};

// 夹具①龙卷风：最长条（sigmaPct=100）+ 三位数 σ 读数（T02083 缺陷的贴边用例）
const tornado = tornadoGeometries([
  { key: 'a', title: '启动会 PPT 与客户版材料口径校对', sigma: 108.5 },
  { key: 'b', title: '估算面板重构', sigma: 90 },
  { key: 'c', title: '短', sigma: 0.5 },
], new Set<string>());
within('A1 龙卷风（最长条 + 三位数 σ）', parse(renderToStaticMarkup(createElement(TornadoChart, { geoms: tornado }))));

// 夹具②阶段柱：6 类阶段全有数据 + 四位数读数
const phases = (['design', 'impl', 'test', 'common', 'onsite', 'req'] as const).map((phase, i) => ({
  phase, expected: 1200 - i * 100, sigma: 320, rowCount: 12, ratio: 0.2,
})) as never as import('../web/src/api/estimates.ts').PhaseStat[];
within('A2 阶段柱（6 阶段 + 四位数读数）', parse(renderToStaticMarkup(createElement(PhaseBarChart,
  { phases, phaseLabels: { design: '设计', impl: '开发', test: '测试', common: '通用', onsite: '现场', req: '需求' } as never }))));

// 夹具③帕累托：n=27（四期真实行数级）与 n=8（稀疏规则不得误伤全标）
const many = Array.from({ length: 27 }, (_, i) => ({ key: `p${i}`, expected: 120 - i * 4, title: `计划条目 ${i + 1}号` }));
const few = many.slice(0, 8);
const p27 = parse(renderToStaticMarkup(createElement(ParetoChart, { geoms: paretoGeometries(many, new Set<string>()) })));
const p8 = parse(renderToStaticMarkup(createElement(ParetoChart, { geoms: paretoGeometries(few, new Set<string>()) })));
ok('A3 帕累托 n=27：x 轴可对应标识 > 0（T02296 稀疏刻度）', p27.ticks > 0, `ticks=${p27.ticks}`);
ok('A4 帕累托 n=27：每柱都有条目对应通道（<title>）', p27.titles === 27, `title=${p27.titles}`);
ok('A5 帕累托 n=8：稀疏规则不误伤全标（ticks=8）', p8.ticks === 8, `ticks=${p8.ticks}`);
within('A6 帕累托 n=27：文字落在 viewBox 内', p27);

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-t02297-svg-bounds（静态渲染，无服务/无网络）\n${lines.join('\n')}\n`;
console.log(`\n${head(pass, fail)}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02297-svg-bounds-gate-results.txt', summary);
console.log(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);

function head(p: number, f: number) {
  return `PASS=${p} FAIL=${f}`;
}
