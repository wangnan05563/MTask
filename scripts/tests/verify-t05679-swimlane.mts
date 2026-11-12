/**
 * T05679 门：里程碑季度泳道（54 个里程碑不再只画 5 个，且页数不变）。
 *
 * 现状问题：`flowBlocks` 横向链一页只放得下 5 个节点，54 个里程碑里只画 5 个，
 * 其余 49 个只在 notes 里指向时间线页——启动会最关键的信息被压成小字。
 * 直接按 5 个/页扩页会把 14 页撑到 20+（超 PAGE_MAX=18），所以改为**同页分列**。
 *
 * 判据：
 *   A 组 纯函数——跨季度时一页画 3 列 × 每列 4 个（12 个 > 原 5 个）；列头带季度与条数；
 *        单季度/无日期/≤5 个不启用泳道（回退原链，不退化）；跨 >4 季度只画前 4 列并如实计数；
 *        空数据不炸；节点文本带截止日。
 *   B 组 源码锚——builder 导出两个函数；planDiagram 与 tryDiagramPage 共用同一启用判据；
 *        flow 页页数不因里程碑多而增加。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05679-swimlane.mts
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

const B = await import('../../server/src/services/kickoffBuilder.ts');

type Spec = Array<[string, number]>;
const mk = (spec: Spec) => ({
  milestones: spec.flatMap(([ym, n]) => Array.from({ length: n }, (_, i) => ({
    id: `m-${ym}-${i}`,
    title: `${ym || '未排期'} 阶段 ${i + 1}`,
    start_date: ym ? `${ym}-01` : '',
    end_date: ym ? `${ym}-${String(10 + (i % 18)).padStart(2, '0')}` : '',
    progress: 0,
    status: 'todo',
  }))),
}) as never;

const frame = { x: 0.5, y: 1.3, w: 9, h: 2.6 };
const inside = (r: { blocks: Array<{ box: { x: number; y: number; w: number; h: number } }> }) =>
  r.blocks.every((b) => b.box.x >= frame.x - 1e-6 && b.box.y >= frame.y - 1e-6
    && b.box.x + b.box.w <= frame.x + frame.w + 1e-6 && b.box.y + b.box.h <= frame.y + frame.h + 1e-6);

const bemp = mk([['2026-10', 20], ['2027-01', 20], ['2027-04', 14]]);
const r54 = B.quarterSwimlaneBlocks(bemp, frame);
const headers54 = r54.blocks.filter((x) => x.text).map((x) => x.text!.content);

ok('A-01 54 个里程碑（跨 3 季度）一页画出 12 个节点，远多于原链的 5 个',
  r54.drawn === 12 && r54.drawn > 5, { drawn: r54.drawn });
ok('A-02 分 3 列且列头写清季度与条数（20/20/14）',
  headers54.length === 3 && headers54[0].includes('2026 Q4') && headers54[0].includes('20 个')
  && headers54[2].includes('2027 Q2') && headers54[2].includes('14 个'), headers54);
ok('A-03 无越界、无重叠，全部落在给定框内',
  r54.violations.length === 0 && inside(r54), r54.violations.slice(0, 3));
ok('A-04 溢出如实计数并指向时间线页（42 个，不静默丢）',
  r54.overflow === 42 && r54.notes.some((n: string) => /其余 42 个/.test(n) && /时间线页/.test(n)), r54.notes);
ok('A-05 节点文本带截止日（库内日期切片，不造假）',
  r54.blocks.filter((x) => x.shape).every((x) => /截止 \d{2}-\d{2}|未排截止日/.test(x.shape!.label!.text)),
  r54.blocks.find((x) => x.shape)?.shape?.label?.text);

ok('A-06 单季度 12 个不启用泳道（分列没有分组价值，会少画）',
  B.shouldUseSwimlane(mk([['2026-10', 12]])) === false);
ok('A-07 无日期 8 个不启用泳道（归「未排期」一列没有时间轴语义）',
  B.shouldUseSwimlane(mk([['', 8]])) === false);
ok('A-08 ≤5 个不启用泳道（保持原阶段链）', B.shouldUseSwimlane(mk([['2026-10', 5]])) === false);
ok('A-09 跨 6 个季度只画前 4 列，其余季度如实计数',
  B.shouldUseSwimlane(mk([['2026-01', 3], ['2026-04', 3], ['2026-07', 3], ['2026-10', 3], ['2027-01', 3], ['2027-04', 3]])) === true
  && B.quarterSwimlaneBlocks(mk([['2026-01', 3], ['2026-04', 3], ['2026-07', 3], ['2026-10', 3], ['2027-01', 3], ['2027-04', 3]]), frame)
    .notes.some((n: string) => /其他季度/.test(n)));
ok('A-10 空数据不炸、不造空列', (() => {
  const r = B.quarterSwimlaneBlocks({ milestones: [] } as never, frame);
  return r.drawn === 0 && r.blocks.length === 0;
})());

// B 组：源码锚
const SRC = readFileSync(join(ROOT, 'server/src/services/kickoffBuilder.ts'), 'utf8');
ok('B-01 builder 导出泳道与启用判据',
  /export function quarterSwimlaneBlocks\(/.test(SRC) && /export function shouldUseSwimlane\(/.test(SRC));
ok('B-02 绘制计划与绘制分派共用同一判据（不会出现「计划说画泳道、实际画链」）',
  (SRC.match(/shouldUseSwimlane\(b\)/g) ?? []).length >= 2
  && /if \(item\.layout === 'flow' && shouldUseSwimlane\(b\)\)/.test(SRC)
  && /shouldUseSwimlane\(b\)\s*\?\s*quarterSwimlaneBlocks/.test(SRC));
ok('B-03 flow 页不因里程碑多而扩页（页数不变）',
  B.expandTimelinePages(bemp, [{ section: '计划', title: '阶段链', bullets: [], dataKeys: ['milestones'], layout: 'flow' }]).length === 1);

const body = [`T05679 季度泳道门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05679-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05679-gate-results.txt')}`);
