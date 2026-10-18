/**
 * T02297 回归门：估算面板三图（E11 阶段柱 / E11 帕累托 / E14 龙卷风）的
 * 「<text> 越出 viewBox」与「柱子↔条目可对应」断言。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 拦的是**几何类**缺陷：字宽/条宽/viewBox 三者算错才显形，`tsc --noEmit`、API 门、PDF 门全看不见。
 * 同族缺陷已发生过一次（T02083：σ 数值被 SVG 裁掉，靠一次性 Playwright 探针发现，修完没留门）；
 * 本门把「任何人把 `X1`/`SIGMA_LABEL_RESERVE`/字号改回去 → CI 全绿、缺陷静默复发」这条路堵上。
 *
 * 机制（判据 1：量的是**生成出来的 SVG 文本里的坐标**，不是源码里那个常量名）：
 * `react-dom/server` 静态渲染三图 → 取 `viewBox` 宽与每个 `<text>` 的
 * `x`/`font-size`/`text-anchor` → 按 textAnchor 语义 + 估算字宽（CJK 计 1.0×fs、其余 0.55×fs）
 * 求左右边界 → 断言不得越出 viewBox（±0.5 容差）。断言只喂**夹具**（含 T02083 的贴边用例
 * 「最长条 + 三位数 σ 108.5」），不锚实现字面量、不读生产数据（判据 2 天然满足）。
 *
 * 改判口径（本轮，判据 4 负对照两条通道）：
 *   N-01/N-02 产物副本篡改反证——把**渲染出的 SVG 串**真破坏掉（一个 `<text>` 的 x 挪出界、
 *     剥掉 viewBox），同一边界判据必须转红/取证链必须报错；反例副本自证「篡改确实落了盘」
 *     （sha256 变化 + 原锚在、新锚成）。N-02 同时封死「viewBox 缺失 → 空判据恒绿」的假牙齿形态。
 *   N-03 行为反证（HEAD 副本 worktree）——在 `git worktree add --detach` 副本里把
 *     `SIGMA_LABEL_RESERVE = 46` 改回 4（T02083 修复的逆向）并把帕累托轴门控退回 `n > 14` 清空
 *     形态、`<title>` 元素改名摘除，让**同一个本门脚本**在副本里再跑：要求 A1（龙卷风边界）、
 *     A3/A4（帕累托刻度/对应通道）转红，且 A5（n=8 全标不回归）必须仍为绿——红要红得精确，
 *     不是整门跑崩。主仓工作树全程只读（N-04 sha256 自证）。
 *   环境缺口记 `skipped()`；本门纯静态渲染无外部依赖，正常情况下零 SKIP。
 *
 * 用法（无需起服务、无网络、无 AI；纯静态渲染）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02297-svg-bounds.mts
 * 仓库根**没有** tsconfig.json，只有 web/tsconfig.json（`jsx: react-jsx`）；从根跑若不指定它，
 * JSX 会编成经典运行时 → `ReferenceError: React is not defined`。门首自行补 `TSX_TSCONFIG_PATH`
 * 再透传重启（照 scripts/verify-t02192-prdgen-pointer.mts 的房内写法，不依赖 npm script 的 ENV 前缀）。
 * 环境变量：`T02297_SKIP_NEG=1`（供 N-03 副本子跑跳过本组防递归）、`T02297_TMP_ROOT`（负对照
 *   worktree 根，默认 D:/code/tmp，勿指 C:）。
 * 结果落 .workbuddy/t02297-svg-bounds-gate-results-<运行标识>.txt。
 *
 * 已知边界（如实）：只断水平边界与对应通道，不断纵向越界与文字互相重叠。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, detail = ''): void => {
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  console.log(lines[lines.length - 1]);
  if (cond) pass++; else fail++;
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`SKIP ${range} —— ${why}（不计 PASS）`);
};
/** 边界判据抽成纯函数（判据 4 要求「同一判据」能在原物/篡改副本两侧复放） */
const outOfBounds = (p: Parsed): TextNode[] => p.texts.filter((t) => t.right > p.vbW + 0.5 || t.left < -0.5);
const within = (name: string, p: Parsed): void => {
  const bad = outOfBounds(p);
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
const tornadoHtml = renderToStaticMarkup(createElement(TornadoChart, { geoms: tornado }));
within('A1 龙卷风（最长条 + 三位数 σ）', parse(tornadoHtml));

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

// =====================================================================
// N 组：负对照（判据 4）。子跑（N-03 在 HEAD 副本里重跑本门）带 T02297_SKIP_NEG=1 跳过本组。
// =====================================================================
if (process.env.T02297_SKIP_NEG === '1') {
  skipped('N 组', '本子跑是 N-03 行为反证的副本执行（SKIP_NEG=1），负对照只在主跑做，避免递归');
} else {
  const shaOf = (buf: string | Uint8Array) => createHash('sha256').update(buf).digest('hex');

  // N-01 把渲染产物里第一个 <text> 的 x 真挪出 viewBox → 同一边界判据必须抓到越界；原物仍为净
  {
    const anchor = /<text x="([\d.]+)"/;
    const landed = anchor.test(tornadoHtml);
    const tamperedHtml = tornadoHtml.replace(anchor, '<text x="9999"');
    const tamperedChanged = tamperedHtml !== tornadoHtml;
    const badOnTampered = outOfBounds(parse(tamperedHtml));
    const badOnOriginal = outOfBounds(parse(tornadoHtml));
    ok('N-01 判据有牙：产物副本把首个 <text> 的 x 挪到 9999 后，同一边界判据必须抓到越界（原物为零违例、篡改确已落盘）',
      landed && tamperedChanged && badOnTampered.length > 0 && badOnOriginal.length === 0,
      { 违例数: badOnTampered.length, 违例: badOnTampered.map((b) => `「${b.s}」right=${b.right.toFixed(1)}`).slice(0, 3) });
  }

  // N-02 剥掉 viewBox → 取证链必须抛（封死「取不到 viewBox 就当没有文字、判据空转恒绿」的假牙齿形态）
  {
    const noVb = tornadoHtml.replace(/viewBox="[^"]*"/, 'data-noviewbox="1"');
    let threw = '';
    try { parse(noVb); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok('N-02 取证链有牙：viewBox 被抽掉时 parse 必须抛错，不静默交出空集让「无越界」恒真（且抽除确已落盘）',
      threw.includes('未取得 viewBox') && noVb !== tornadoHtml && !/viewBox=/.test(noVb), { threw });
  }

  // N-03 HEAD 副本 worktree 行为反证：reserve 退回 4 + 轴门控退回 n>14 清空 + title 摘除 → 同一本门转红
  const { execFileSync, spawnSync } = await import('node:child_process');
  const TMP_ROOT = process.env.T02297_TMP_ROOT || 'D:/code/tmp';
  mkdirSync(TMP_ROOT, { recursive: true });
  const NEG_ROOT = join(TMP_ROOT, `t02297-negwt-${process.pid}`);
  const REL = join('web', 'src', 'components', 'estimateCharts.tsx');
  const mainShaBefore = shaOf(readFileSync(join(ROOT, REL)));
  let negReady = false;
  try {
    if (existsSync(NEG_ROOT)) rmSync(NEG_ROOT, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', NEG_ROOT, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 180_000 });
    symlinkSync(join(ROOT, 'node_modules'), join(NEG_ROOT, 'node_modules'), 'junction');
    negReady = existsSync(join(NEG_ROOT, REL)) && existsSync(join(NEG_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
  } catch { negReady = false; }
  ok('N-00 负对照工作区就绪：HEAD 的 detached worktree 副本 + node_modules junction（主仓工作树全程只读）',
    negReady, { NEG_ROOT });
  if (negReady) {
    const patchFile = (find: RegExp, to: string) => {
      const p = join(NEG_ROOT, REL);
      const before = readFileSync(p, 'utf8');
      const m = find.exec(before);
      if (!m) return { hit: false as const, reason: `锚点未命中：${find}` };
      writeFileSync(p, before.slice(0, m.index) + to + before.slice(m.index + m[0].length));
      return { hit: true as const, landed: shaOf(readFileSync(p, 'utf8')) !== shaOf(before) };
    };
    const g1 = patchFile(/const SIGMA_LABEL_RESERVE = 46;/, 'const SIGMA_LABEL_RESERVE = 4;');
    const g2 = patchFile(/if \(!\(n <= 14 \|\| i % 5 === 0 \|\| i === n - 1\)\) return null;/, 'if (n > 14) return null;');
    const g3 = patchFile(/<title>\{/, '<ntitle>{');
    const g4 = patchFile(/\}<\/title>/, '}</ntitle>');
    const backFinal = readFileSync(join(NEG_ROOT, REL), 'utf8');
    const landed = [g1, g2, g3, g4].every((g) => g.hit === true && 'landed' in g && g.landed === true)
      && /SIGMA_LABEL_RESERVE = 4;/.test(backFinal) && (backFinal.match(/<ntitle>/g) ?? []).length === 1;
    ok('N-03a 篡改确实落了盘：副本四处补丁均命中、回读 sha256 变化且 reserve=4/ntitle 在场（替换串不存在＝假牙齿）',
      landed, { g1, g2, g3, g4 });
    const child = spawnSync(process.execPath,
      [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(NEG_ROOT, 'scripts', 'verify-t02297-svg-bounds.mts')],
      {
        cwd: NEG_ROOT,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(NEG_ROOT, 'web', 'tsconfig.json'), T02297_SKIP_NEG: '1', TMP: TMP_ROOT, TEMP: TMP_ROOT },
        encoding: 'utf8', timeout: 120_000,
      });
    const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    const reds = new Set([...out.matchAll(/^(?:FAIL) (A\d+)/gm)].map((m) => m[1]));
    const want = ['A1', 'A3', 'A4'];
    const missing = want.filter((id) => !reds.has(id));
    ok('N-03 行为反证：HEAD 副本退回缺陷形态后，同一个本门在副本里对 A1（龙卷风边界）/A3/A4（帕累托刻度与对应通道）全部转红',
      missing.length === 0, { 红项: [...reds], 缺: missing, tail: out.slice(-260) });
    ok('N-03b 红得精确：A5（n=8 稀疏规则不误伤全标）在反证副本里必须仍为绿——红因是行为失守不是整门跑崩',
      !reds.has('A5') && /^PASS A5/m.test(out), { 红项: [...reds] });
    try { rmSync(join(NEG_ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* 未建成 */ }
    try { execFileSync('git', ['worktree', 'remove', '--force', NEG_ROOT], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
    catch { rmSync(NEG_ROOT, { recursive: true, force: true }); }
    try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 }); } catch { /* 尽力 */ }
  } else {
    ok('N-03a 篡改确实落了盘：副本四处补丁均命中、回读 sha256 变化且 reserve=4/ntitle 在场（替换串不存在＝假牙齿）', false, '负对照工作区未建成');
    ok('N-03 行为反证：HEAD 副本退回缺陷形态后，同一个本门在副本里对 A1（龙卷风边界）/A3/A4（帕累托刻度与对应通道）全部转红', false, '负对照工作区未建成');
    ok('N-03b 红得精确：A5（n=8 稀疏规则不误伤全标）在反证副本里必须仍为绿——红因是行为失守不是整门跑崩', false, '负对照工作区未建成');
  }
  ok('N-04 主仓工作树零写入自证：负对照全程后 estimateCharts.tsx 的 sha256 与开跑前一致',
    shaOf(readFileSync(join(ROOT, REL))) === mainShaBefore, { before: mainShaBefore.slice(0, 16) });
}

const summary = `PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}\n门：verify-t02297-svg-bounds（静态渲染，无服务/无网络）\n${lines.join('\n')}\n`;
console.log(`\n${summary.split('\n')[0]}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02297-svg-bounds-gate-results.txt', summary,
  { note: skippedList.length ? `跳过 ${skippedList.length} 项` : undefined });
console.log(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);
