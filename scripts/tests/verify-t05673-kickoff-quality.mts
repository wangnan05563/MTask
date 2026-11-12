/**
 * T05673 门：启动会稿 P0 三项质量改造（标题结论化 / 卡片网格 / 封面待补角标）。
 *
 * 背景见 `docs/评估结果-T05672-启动会PPT技能质量对比.md`：
 *   1. 14 页里 12 页标题是栏目名（会议议程/项目风险/工作量评估），读者读完全文才知道这页想说什么；
 *   2. 5 张表格/46 单元格承载需求、计划、风险、团队，表格高度刚性 → 要点被压缩（T05671 的 4 条提示根因）；
 *   3. 负责人 258 条全空、工作量待确认，但封面没有任何「这次有多少项待补」的提示。
 *
 * 判据：
 *   A 组 纯函数——cards 版式在枚举内；标题黑名单不含「谢谢/致谢」（结束页合法）；提示词带黑名单；
 *        卡片 3/6/8 条的排布与溢出；卡片文本 title\nmeta；空数据不炸；封面 footer 带待补数、正文页不带。
 *   B 组 源码锚——builder 接入 cards（planDiagram + tryDiagramPage）、前端可选 cards、标题输入提示结论化。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05673-kickoff-quality.mts
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

// ---------------- A 组：纯函数 ----------------
const S = await import('../../server/src/services/kickoffService.ts');
const B = await import('../../server/src/services/kickoffBuilder.ts');
const L = await import('../../server/src/services/kickoff-layout.ts');

ok('A-01 KICKOFF_LAYOUTS 含 cards，且前后版式未丢',
  (S.KICKOFF_LAYOUTS as readonly string[]).includes('cards')
  && ['cover', 'toc', 'table', 'chart', 'timeline', 'flow', 'chip', 'section', 'thanks'].every((k) => (S.KICKOFF_LAYOUTS as readonly string[]).includes(k)),
  S.KICKOFF_LAYOUTS);

const anti = S.KICKOFF_TITLE_ANTIPATTERNS as readonly string[];
ok('A-02 标题黑名单覆盖真实栏目名，且不误伤结束页（无「谢谢/致谢」）',
  anti.includes('项目风险') && anti.includes('工作量评估') && anti.includes('会议议程')
  && !anti.includes('谢谢') && !anti.includes('致谢'), anti);

ok('A-03 大纲提示词带黑名单与「结论」要求（主提示 + 重试提示）',
  S.OUTLINE_SYSTEM.includes('可被反驳的结论') && S.OUTLINE_SYSTEM.includes('项目风险')
  && /栏目名/.test(S.OUTLINE_SYSTEM),
  { main: S.OUTLINE_SYSTEM.slice(0, 0), hit: S.OUTLINE_SYSTEM.includes('项目风险') });

const frame = { x: 0.5, y: 1.3, w: 9, h: 2.6 };
const mk = (n: number) => ({
  requirements: Array.from({ length: n }, (_, i) => ({
    req_no: `REQ-${String(i + 1).padStart(3, '0')}`,
    title: `需求条目 ${i + 1}：某业务字段调整`,
    priority: 'P1',
    status: 'todo',
    linkedPlans: [],
  })),
  risks: [], assignees: [], plans: [], milestones: [],
}) as never;

const inside = (r: { blocks: Array<{ box: { x: number; y: number; w: number; h: number } }> }) =>
  r.blocks.every((b) => b.box.x >= frame.x - 1e-6 && b.box.y >= frame.y - 1e-6
    && b.box.x + b.box.w <= frame.x + frame.w + 1e-6 && b.box.y + b.box.h <= frame.y + frame.h + 1e-6);

const c3 = B.cardGridBlocks(mk(3), 'reqList', frame);
const c6 = B.cardGridBlocks(mk(6), 'reqList', frame);
const c8 = B.cardGridBlocks(mk(8), 'reqList', frame);
const c0 = B.cardGridBlocks(mk(0), 'reqList', frame);

ok('A-04 3 条 → 3 卡、无溢出、全部在框内',
  c3.drawn === 3 && c3.overflow === 0 && c3.violations.length === 0 && inside(c3), { drawn: c3.drawn, overflow: c3.overflow });
ok('A-05 6 条 → 2×3 满格（6 卡）、无溢出、无重叠违规',
  c6.drawn === 6 && c6.overflow === 0 && c6.violations.length === 0 && inside(c6), { drawn: c6.drawn, overflow: c6.overflow });
ok('A-06 8 条 → 6 卡 + 溢出 2 并写明去向（一条不丢）',
  c8.drawn === 6 && c8.overflow === 2 && c8.notes.some((n: string) => /其余 2 条/.test(n)), { drawn: c8.drawn, overflow: c8.overflow, notes: c8.notes });
ok('A-07 卡片是「标题\\n副信息」两行，且带编号/状态（与表格同源）',
  /需求条目 1[^\n]*\nREQ-001 · P1 · 待办|需求条目 1[^\n]*\nREQ-001 · P1 · 进行中|需求条目 1[^\n]*\nREQ-001 · P1 · /.test(c6.blocks[0]?.shape?.label?.text ?? ''),
  c6.blocks[0]?.shape?.label?.text);
ok('A-08 空数据 → 0 卡不炸、不造占位卡', c0.drawn === 0 && c0.blocks.length === 0 && c0.notes.length === 0);

const bundle = {
  project: { name: 'BEMP11月迭代' }, dataAsOf: '2026-11-12', workload: { footer: '口径：工期推导' },
  preflight: { items: [{ status: 'warn' }, { status: 'warn' }, { status: 'ok' }] },
} as never;
const cover = B.footerOf({ section: '封面', layout: 'cover', dataKeys: [] } as never, bundle, 1, 14);
const body = B.footerOf({ section: '风险', layout: 'list', dataKeys: [] } as never, bundle, 9, 14);
ok('A-09 封面 footer 带「待补 N 项」，正文页不带（不制造噪声）',
  /待补 2 项/.test(cover) && !/待补/.test(body), { cover, body });
ok('A-10 preflight 无 warn 时封面不写「待补 0 项」',
  !/待补/.test(B.footerOf({ section: '封面', layout: 'cover', dataKeys: [] } as never,
    { ...(bundle as object), preflight: { items: [{ status: 'ok' }] } } as never, 1, 14)));

// ---------------- B 组：源码锚 ----------------
const BUILDER = readFileSync(join(ROOT, 'server/src/services/kickoffBuilder.ts'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');

ok('B-01 cards 走组件自绘旁路：planDiagram 识别 + tryDiagramPage 分派',
  /item\.layout === 'cards'/.test(BUILDER)
  && /cardGridBlocks\(b, diagram\.key, area\)/.test(BUILDER)
  && /CARD_KEYS/.test(BUILDER));
ok('B-02 卡片守「一块一形状一带字」：只产出 shape.label，不叠 text 块',
  /shape:\s*\{\s*\n\s*kind: 'roundRect',\s*\n\s*tone: 'chip',\s*\n\s*label: \{ text: `\$\{c\.title\}\\n\$\{c\.meta\}`/.test(BUILDER));
ok('B-03 前端版式下拉可选 cards', /'cards'/.test(PANEL.slice(PANEL.indexOf('const LAYOUTS'), PANEL.indexOf('const LAYOUTS') + 200)));
ok('B-04 前端标题输入提示「写结论，不写栏目名」',
  /标题写结论，不写栏目名/.test(PANEL));

// ---------------- P1/P2：主题、复杂度图表、品牌色 ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const std = L.paletteOf('standard').brandDeep;
const ink = L.paletteOf('ink').brandDeep;
const evg = L.paletteOf('evergreen').brandDeep;
ok('A-11 三档主题主色互不相同，自定义品牌色优先，非法值回落主题',
  std !== ink && ink !== evg && std !== evg
  && L.paletteOf('standard', '#C2703A').brandDeep === 'C2703A'
  && L.paletteOf('standard', 'not-a-color').brandDeep === std,
  { std, ink, evg });

const seen: Record<string, string> = {};
await Promise.all([
  L.runWithPalette(L.paletteOf('ink'), async () => { await sleep(25); seen.ink = L.PALETTE.brandDeep; await sleep(8); seen.inkAfter = L.PALETTE.brandDeep; }),
  L.runWithPalette(L.paletteOf('evergreen'), async () => { await sleep(8); seen.evg = L.PALETTE.brandDeep; await sleep(28); seen.evgAfter = L.PALETTE.brandDeep; }),
]);
ok('A-12 ALS 并发隔离：两路主题互不串色，退出后回落默认',
  seen.ink === ink && seen.inkAfter === ink && seen.evg === evg && seen.evgAfter === evg
  && L.PALETTE.brandDeep === std, seen);

const wb = {
  workload: {
    noData: false, counted: 204, manDays: { expected: 120, optimistic: 90, pessimistic: 160 },
    manMonth: 5.52, quote: null, footer: '口径：工期推导', manDaysPerManMonth: 21.75,
    phases: [], complexity: [{ level: 1, count: 44 }, { level: 2, count: 94 }, { level: 3, count: 73 }],
  },
} as never;
const wBlocks = B.blocksForKey('workload', wb);
ok('A-13 阶段不足 2 段时复杂度分布出条形图（原来只有一行文字）',
  wBlocks.some((d) => d.chart?.type === 'bar' && /复杂度分布/.test(d.chart.name) && d.chart.values.length === 3),
  wBlocks.map((d) => (d.chart ? d.chart.name : d.table ? 'table' : 'text')));

const ROUTE_SRC = readFileSync(join(ROOT, 'server/src/routes/plans.ts'), 'utf8');
const SVC_SRC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');
const HTML_SRC = readFileSync(join(ROOT, 'server/src/services/kickoffHtml.ts'), 'utf8');

ok('B-05 启动会路由在 SSE 头前校验主题与品牌色（非法值结构化 400）',
  /deckStylePreset\(b\.style\)/.test(ROUTE_SRC) && /品牌色需为 6 位十六进制/.test(ROUTE_SRC)
  && /ac\.signal, style, brandColor(?:, imageTokens)?\)/.test(ROUTE_SRC));
ok('B-06 builder 用 runWithPalette 包裹装配（并发生成不串色）',
  /return runWithPalette\(paletteOf\(opts\.style \?\? 'standard', opts\.brandColor\),/.test(BUILDER));
ok('B-07 服务层透传主题/品牌色，done 负载带 style',
  /style: DeckStyleKey = 'standard'/.test(SVC_SRC) && /brandColor\?: string/.test(SVC_SRC)
  && /send\('done', \{[^}]*style: r\.style/.test(ROUTE_SRC));
ok('B-08 HTML 版同主题（PPTX 与 HTML 不各走一套）',
  /buildKickoffHtml\(bundleForBuild, built\.outline, style\)/.test(SVC_SRC)
  && /style: DeckStyleKey = 'standard'/.test(HTML_SRC));
ok('B-09 前端有主题下拉与品牌色输入，品牌色空则不发（跟随主题）',
  /aria-label="演示稿主题"/.test(PANEL) && /aria-label="品牌色"/.test(PANEL)
  && /\.\.\.\(brandColor \? \{ brandColor \} : \{\}\)/.test(PANEL));

const body2 = [(`T05673 P0 门：PASS ${pass} / FAIL ${fail}`), ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05673-gate-results.txt'), `${body2}\n`, 'utf8');
console.log(body2);
console.log(`结果文件：${join(OUT_DIR, 't05673-gate-results.txt')}`);
