/**
 * T02098 门：版式断言层（PRD-项目启动会PPT生成 §6.3 六条门禁 / 技术方案 §4）。
 *
 * 断言：
 *   S 组 源码守卫：纯函数层（零 pptxgenjs/零库）、色值单源、尺寸单源、跨文件文本约束一致。
 *   U 组 纯函数单测（直接 import 被测模块，不起服务、不碰库、不烧配额）：
 *     门禁 1 画布/内容框 · 门禁 2 边界与降级原因 · 门禁 3 堆叠与 gap 钳制 ·
 *     门禁 4 缩放幂等 · 门禁 5 重叠与贴边容差 · 门禁 6 WCAG 对比度与配色自检 ·
 *     版式族三套框互不越界 · 文本宽度预留（R3）· 时间线几何（FR-4.5 交 T02100 绘制）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02098-kickoff-layout.mts
 * 断言输出落 .workbuddy/t02098-gate-results.txt（GBK 控制台乱码，以文件为权威）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// ---------- S 组：源码/契约守卫 ----------
const srcPath = join(ROOT, 'server', 'src', 'services', 'kickoff-layout.ts');
const L = readFileSync(srcPath, 'utf8');
const styleSrc = readFileSync(join(ROOT, 'server', 'src', 'util', 'exportStyle.ts'), 'utf8');
const svcSrc = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');

const L_NO_COMMENT = L.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const L_IMPORTS = L_NO_COMMENT.match(/^import[\s\S]*?;$/gm)?.join('\n') ?? '';
ok('S-01 纯函数层：零 pptxgenjs / 零数据库依赖（适配层独占 import，风险 R1 不散用）',
  !/pptxgenjs|better-sqlite3|\.\/db\/|require\(/.test(L_IMPORTS) && !/(await )?import\(/.test(L_NO_COMMENT), L_IMPORTS);
ok('S-02 色值单源：从 exportStyle 取色，本模块不出现裸 hex 字面量（门禁 6 前提）',
  /from '\.\.\/util\/exportStyle'/.test(L) && !/(["'#])[0-9a-fA-F]{6}\b/.test(L.replace(/\/\/.*$/gm, '')),
  L.match(/["'#][0-9a-fA-F]{6}/g)?.slice(0, 3));
ok('S-03 导出层新增墨色/纸色/强调色三值并在 exportStyle 单源定义',
  /export const INK_FONT/.test(styleSrc) && /export const PAPER_BG/.test(styleSrc) && /export const ACCENT_FONT/.test(styleSrc));
ok('S-04 画布尺寸单源：10×5.625 与 defineLayout 参数同源（PRD §5.3 尺寸表）',
  /CANVAS = \{ width: 10, height: 5\.625 \}/.test(L) && /KICKOFF_LAYOUT_DEF = \{ name: 'KICKOFF', width: CANVAS\.width, height: CANVAS\.height \}/.test(L));
ok('S-05 文本约束与大纲段同值（BULLET_MAX_CHARS=42 两处不一致会「过了校验仍放不进」）',
  /BULLET_MAX_CHARS = 42/.test(L) && /BULLET_MAX_CHARS = 42/.test(svcSrc) && /BULLET_MAX_LINES = 6/.test(L) && /MIN_BODY_PT = 14/.test(L));
ok('S-06 六条门禁各有导出（bounds/stack/scale/overlap/contrast/canvas）',
  ['assertInBounds', 'stackY', 'scaleBox', 'findOverlaps', 'contrastRatio', 'getContentFrame'].every((n) => new RegExp(`export function ${n}\\b`).test(L)));
ok('S-07 底部保留带与最小间距常量化（门禁 3「底部留 ≥0.4」「gap ≥0.3」）',
  /BOTTOM_KEEP = 0\.4/.test(L) && /MIN_GAP = 0\.3/.test(L));
ok('S-08 中文字体回退显式声明（R3：pptxgenjs 不嵌字体）', /face: '微软雅黑'/.test(L) && /fallback: 'Microsoft YaHei'/.test(L));

// ---------- U 组：纯函数单测 ----------
const M = await import('../server/src/services/kickoff-layout.ts');

// 门禁 1
const frame = M.getContentFrame();
ok('U-01 内容框 = 画布去边距再让出底带（9 × 4.225）',
  Math.abs(frame.x - 0.5) < 1e-9 && Math.abs(frame.w - 9) < 1e-9 && Math.abs(frame.h - 4.225) < 1e-9, frame);
ok('U-02 合规盒 assertInBounds 返回 null', M.assertInBounds(frame) === null);
ok('U-03 右溢出点名「右边界越出」并带数值',
  /右边界越出：x\+w=10\.00 > 9\.50/.test(String(M.assertInBounds({ x: 1, y: 1, w: 9, h: 1 }))), M.assertInBounds({ x: 1, y: 1, w: 9, h: 1 }));
ok('U-04 侵占底部保留带同样判越出（默认参照比画布严）',
  /下边界越出/.test(String(M.assertInBounds({ x: 0.5, y: 4.9, w: 8, h: 0.4 }))), M.assertInBounds({ x: 0.5, y: 4.9, w: 8, h: 0.4 }));
ok('U-05 同一盒放宽到 CANVAS_BOX 后合规（页脚/通栏可用底带）',
  M.assertInBounds({ x: 0.5, y: 4.9, w: 8, h: 0.4 }, M.CANVAS_BOX) === null);
ok('U-06 非正尺寸与非有限坐标各自点名',
  /宽度非正/.test(String(M.assertInBounds({ x: 1, y: 1, w: 0, h: 1 })))
  && /高度非正/.test(String(M.assertInBounds({ x: 1, y: 1, w: 1, h: -2 })))
  && /非有限数/.test(String(M.assertInBounds({ x: Number.NaN, y: 1, w: 1, h: 1 }))));

// 门禁 3
const stacked = M.stackY(1, [{ h: 0.5 }, { h: 0.5 }], 0.05);
ok('U-07 gap 钳到 ≥0.3：传 0.05 实排 0.3（拥挤该降页不该挤压）',
  Math.abs(stacked[1].y - (1 + 0.5 + 0.3)) < 1e-9, stacked.map((b) => b.y));
ok('U-08 堆叠横向落在内容框内且起点不高于 frame.y',
  stacked.every((b) => Math.abs(b.x - frame.x) < 1e-9 && Math.abs(b.w - frame.w) < 1e-9)
  && Math.abs(M.stackY(-3, [{ h: 0.2 }])[0].y - frame.y) < 1e-9, M.stackY(-3, [{ h: 0.2 }]));
const crowded = M.stackY(1, Array.from({ length: 10 }, () => ({ h: 0.6 })));
ok('U-09 排不下不静默截断：越界块由 assertInBounds 逐条点名（10×0.6 溢出）',
  crowded.length === 10 && crowded.filter((b) => M.assertInBounds(b) !== null).length === 6,
  crowded.map((b) => b.y.toFixed(2)));

// 门禁 4
const half = M.scaleBox({ x: 1, y: 1, w: 2, h: 1 }, frame, M.CANVAS_BOX);
ok('U-10 换版式整体缩放：相对位置与尺寸同步（不出现半迁移）',
  Math.abs(half.x - (0 + (1 - 0.5) * (10 / 9))) < 1e-6 && Math.abs(half.w - 2 * (10 / 9)) < 1e-6, half);
ok('U-11 同框缩放幂等', (() => {
  const b = { x: 2, y: 2, w: 3, h: 1 };
  const r = M.scaleBox(b, frame, frame);
  return ['x', 'y', 'w', 'h'].every((k) => Math.abs((r as any)[k] - (b as any)[k]) < 1e-9);
})());

// 门禁 5
const a = { x: 0, y: 0, w: 2, h: 1 };
const touch = { x: 2, y: 0, w: 2, h: 1 };
const cross = { x: 1.5, y: 0.5, w: 2, h: 1 };
ok('U-12 贴边相邻不误报、真实相交必报',
  M.findOverlaps([a, touch]).length === 0 && M.findOverlaps([a, cross]).length === 1);
const axis = { x: frame.x, y: 3, w: frame.w, h: 0.02 };
const bar = { x: frame.x + 1, y: 2.95, w: 1.2, h: M.TIMELINE_BAR_H };
ok('U-13 时间线典型重叠（条压到日期轴）能检出', M.findOverlaps([axis, bar]).length === 1);

// 门禁 6
ok('U-14 WCAG 已知对：黑/白 = 21', Math.abs(M.contrastRatio('000000', 'FFFFFF') - 21) < 0.01, M.contrastRatio('000000', 'FFFFFF'));
ok('U-15 同色对比度 = 1 且不对称依赖入参顺序', Math.abs(M.contrastRatio('FFFFFF', 'FFFFFF') - 1) < 1e-9);
ok('U-16 3 位缩写 hex 可解析', Math.abs(M.contrastRatio('fff', '000') - 21) < 0.01);
ok('U-17 低对比组合点名实测比值', /对比度不足：CCCCCC\/FFFFFF = /.test(String(M.assertContrast('CCCCCC', 'FFFFFF'))), M.assertContrast('CCCCCC', 'FFFFFF'));
ok('U-18 非法色值直接抛错点名（不让脏色值静默通过门禁）', (() => {
  try { M.contrastRatio('GGGGGG', 'FFFFFF'); return false; } catch (e) { return /非法色值/.test(String(e)); }
})());
ok('U-19 内置配色自检全过 4.5（正文/表头底/斑马底/提示红/强调蓝）', M.auditPalette().length === 0, M.auditPalette());

// 版式族
ok('U-20 大纲 7 个 layout 值归入 3 套物理版式（PRD §5.3，N1 不做母版套用）',
  M.layoutFamilyOf('cover') === 'cover' && M.layoutFamilyOf('toc') === 'cover'
  && M.layoutFamilyOf('twoCol') === 'twoCol'
  && ['table', 'chart', 'timeline', 'list'].every((k) => M.layoutFamilyOf(k) === 'data'));
const families: Array<[string, string | undefined]> = [['cover', undefined], ['cover', 'toc'], ['twoCol', undefined], ['data', undefined]];
ok('U-21 三套版式的标题带/正文区全部过边界断言',
  families.every(([f, sub]) => {
    const fr = M.framesFor(f as any, sub);
    return M.assertInBounds(fr.title, M.CANVAS_BOX) === null && M.assertInBounds(fr.body, M.CANVAS_BOX) === null;
  }), families.map(([f, sub]) => JSON.stringify(M.framesFor(f as any, sub))));
const twoCol = M.framesFor('twoCol');
ok('U-22 双栏左右框互不重叠且总宽不越内容框',
  twoCol.cols && M.findOverlaps([twoCol.cols[0], twoCol.cols[1]]).length === 0
  && twoCol.cols[1].x + twoCol.cols[1].w <= frame.x + frame.w + 1e-9, twoCol.cols);
ok('U-23 安全版式（验收 7 降级目标）本身必在内容框内', (() => {
  const s = M.safeFrames();
  return M.assertInBounds(s.title) === null && M.assertInBounds(s.body) === null;
})());

// 文本宽度预留（R3）
ok('U-24 全角宽度按 1 em 预留：20 字 24pt = 6.67"', Math.abs(M.estimateTextWidthIn('标'.repeat(20), 24) - 20 * (24 / 72)) < 1e-9, M.estimateTextWidthIn('标'.repeat(20), 24));
ok('U-25 字数硬上限优先于宽度（43 字即使放得下也判不合格）',
  M.fitsOneLine('一'.repeat(43), 20, 14) === false && M.fitsOneLine('一'.repeat(20), 8, 14) === true);
ok('U-26 行数估算与每行字数换算一致（4" 宽 14pt 每行 20 字 → 25 字占 2 行）',
  M.charsPerLine(4, 14) === 20 && M.bulletLineCount('一'.repeat(25), 4, 14) === 2,
  { perLine: M.charsPerLine(4, 14), lines: M.bulletLineCount('一'.repeat(25), 4, 14) });
const pageIssues = M.checkPageText({ title: '标'.repeat(40), bullets: Array.from({ length: 7 }, (_, i) => `要点${i}`.padEnd(45, '字')) });
ok('U-27 整页自检点名长标题 + 超行数 + 超字数条目',
  pageIssues.some((s) => /标题超出可排宽度/.test(s)) && pageIssues.some((s) => /bullet 7 行超出 6 行/.test(s)) && pageIssues.filter((s) => /超出 42 字/.test(s)).length === 7,
  pageIssues.slice(0, 3));
ok('U-28 合规页自检返回空数组（不误伤）', M.checkPageText({ title: '里程碑与工期', bullets: ['三期已交付估算视图', '五期补启动会交付稿'] }).length === 0,
  M.checkPageText({ title: '里程碑与工期', bullets: ['三期已交付估算视图', '五期补启动会交付稿'] }));

// 时间线几何
const rows = [{ start_date: '2026-01-05', end_date: '2026-02-20' }, { start_date: '2026-01-10', end_date: '2026-01-12' }];
const range = M.dateRangeOf(rows)!;
ok('U-29 时间线范围 = min(start)~max(end)',
  range && new Date(range.min).toISOString().slice(0, 10) === '2026-01-05' && new Date(range.max).toISOString().slice(0, 10) === '2026-02-20', range);
ok('U-30 无有效日期返回 null → 调用方降级 sort_order 列表版（P3 预警口径）',
  M.dateRangeOf([{ start_date: null, end_date: '' }, {}]) === null);
ok('U-31 单日项目不把范围压成 0（防除零）', (() => {
  const r = M.dateRangeOf([{ start_date: '2026-03-01', end_date: '2026-03-01' }])!;
  return r.max > r.min;
})());
const bodyFrame = M.framesFor('data').body;
const firstBar = M.barBox(rows[0], range, bodyFrame, bodyFrame.y + 0.5)!;
ok('U-32 计划条映射：起点贴框左缘、高度 = TIMELINE_BAR_H、落在框内',
  Math.abs(firstBar.x - bodyFrame.x) < 1e-6 && Math.abs(firstBar.h - M.TIMELINE_BAR_H) < 1e-9 && M.assertInBounds(firstBar, M.CANVAS_BOX) === null, firstBar);
ok('U-33 越界日期钳制到框内（不外溢）',
  Math.abs(M.xAt(range.min - 86400000 * 30, range, bodyFrame) - bodyFrame.x) < 1e-9 && Math.abs(M.xAt(range.max + 86400000 * 30, range, bodyFrame) - (bodyFrame.x + bodyFrame.w)) < 1e-9);
ok('U-34 起止缺失或倒置的条返回 null（不画猜出来的条）',
  M.barBox({ start_date: null, end_date: '2026-02-01' }, range, bodyFrame, 1) === null && M.barBox({ start_date: '2026-03-01', end_date: '2026-02-01' }, range, bodyFrame, 1) === null);
const diamond = M.diamondBox(range.max, range, bodyFrame, bodyFrame.y + bodyFrame.h - 0.2);
ok('U-35 里程碑菱形不越出内容框（末端日期也钳回）',
  Math.abs(diamond.x + diamond.w - (bodyFrame.x + bodyFrame.w)) < 1e-6 && diamond.y >= bodyFrame.y, diamond);
const ticks = M.axisTicks(range, 4);
ok('U-36 日期轴刻度等分且首尾贴内容框左右缘',
  ticks.length === 4 && Math.abs(ticks[0].x - frame.x) < 1e-9 && Math.abs(ticks[3].x - (frame.x + frame.w)) < 1e-9 && ticks.every((t) => /^\d+\/\d+$/.test(t.label)),
  ticks);
ok('U-37 时间线绘制所需形状参数齐（rect 条 / diamond / line 轴，供 T02100 消费）',
  M.TIMELINE_BAR_H === 0.18 && diamond.w > M.TIMELINE_BAR_H && typeof M.xAt === 'function');

// ---------- T02099 消费面回归（改动 stackY / framesFor 后必须仍成立） ----------
ok('U-38 stackY 传栏框时 x/w 跟随栏宽（双栏堆叠同源，不再是散写 y）', (() => {
  const col = { x: 5, y: 1, w: 3, h: 3 };
  const bs = M.stackY(1, [{ h: 0.5 }, { h: 0.5 }], 0.3, col);
  return bs.every((b) => b.x === 5 && b.w === 3) && Math.abs(bs[1].y - 1.8) < 1e-9;
})(), M.stackY(1, [{ h: 0.5 }, { h: 0.5 }], 0.3, { x: 5, y: 1, w: 3, h: 3 }));
ok('U-39 TEXT_SPLIT 单源 = 6:4（PRD §5.3 图文配比），双栏按它分且不重叠',
  M.TEXT_SPLIT === 0.6 && (() => {
    const f = M.framesFor('twoCol', undefined, M.TEXT_SPLIT);
    const [l, r] = f.cols!;
    return Math.abs(l.w / r.w - 1.5) < 0.02 && M.findOverlaps([l, r]).length === 0;
  })(), M.framesFor('twoCol', undefined, M.TEXT_SPLIT).cols);
ok('U-40 split 越界值被钳制（0.98 这种配比会把右栏压成 0 宽）', (() => {
  const f = M.framesFor('twoCol', undefined, 0.98);
  const [l, r] = f.cols!;
  return l.w / r.w <= 0.85 / 0.15 + 0.01 && r.w > 0.5 && M.assertInBounds(r) === null;
})(), M.framesFor('twoCol', undefined, 0.98).cols);

// ---------- 输出 ----------
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02098-gate-results.txt'), `T02098 版式断言层门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
