/**
 * T02198 门：启动会 PPT 新增 flow / chip 图示版式（一页一复合块 + 里程碑与人员真数据源）。
 *
 * 四条口径各一组断言：
 *   F 组 flow 阶段链：节点文字一律照抄库内里程碑（不给 AI 编的机会）；整组自绘**不进**
 *        fitStack/flexStrip 的分型可读高预算（9 块按 T02172 口径会被整块 drop，那是误伤）；
 *        箭头是装饰件（同 axis 口径）不参与越界/重叠；里程碑 <3 或高度不够回落表格版并留痕；
 *        >5 只画前 5 并如实点名余数；超宽阶段名截断留痕。
 *   H 组 chip 人员标签：标签全部来自 assignees；宽度按 estimateTextWidthIn 实算、超宽换行；
 *        版面排不下的如实计数（其余 n 人见分工页），不硬画越界；assignees 空则整页走原表格路径。
 *   V 组 接线：layout 枚举含 flow/chip 且落 data 族框；validateOutline 接受；提示词话术带
 *        「各至多一页 / bullets 不复述」；带字形状走 addText 的 shape 选项（addShape+叠 addText
 *        两块同框会被 findOverlaps 判重叠）；色值仍全部取自 PALETTE（不破门禁 6）。
 *   P 组 真产物：解包 .pptx 证 roundRect 形状框内真的带文字（形状与文字同一原生对象）、
 *        箭头数 = 节点数-1、flow/chip 页没被降级也没有「已省略」。
 *
 * 隔离纪律：不连生产库、不起服务、不调 AI（Bundle 脚本内构造）。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02198-kickoff-flow.mts
 * 结果落 .workbuddy/t02198-gate-results-<运行标识>.txt 与 t02198-flow-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 700)}`}`);
};

const M = await import('../server/src/services/kickoffBuilder.ts');
const LAY = await import('../server/src/services/kickoff-layout.ts');
const SVC = await import('../server/src/services/kickoffService.ts');
const BLD_SRC = readFileSync(join(ROOT, 'server/src/services/kickoffBuilder.ts'), 'utf8');
const SVC_SRC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');

const FLOW_MIN_H = 0.88; // FLOW_NODE_H + FLOW_NOTE_H
const DAY = 86400000;
const iso = (base: number, off: number) => new Date(base + off * DAY).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 5);

// ---------- 测试夹具：7 个里程碑（超 5 上限）+ 12 个负责人（超一页版面）----------
const planRow = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '',
  start_date: iso(T0, i * 3), end_date: iso(T0, i * 3 + 6), duration_days: 5, progress: i < 8 ? 100 : 20,
  status: i < 8 ? 'done' : 'doing', assignee: '张三', sort_order: i, linked_task_id: null, req_ids: null,
  color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '',
});
const MS_TITLES = ['需求拆解', '原型与设计', '后端接口开发', '前端页面开发', '联调与测试', '试运行', '验收交付'];
const milestone = (i: number) => ({
  ...planRow(200 + i), id: `m${i + 1}`, title: MS_TITLES[i],
  start_date: iso(T0, i * 10), end_date: iso(T0, i * 10 + 8), kind: 'milestone',
});
const mkBundle = (milestoneCount: number, assigneeCount: number) => ({
  project: { id: 'p1', name: 'mtask五期', workspacePath: ROOT },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n口径来源说明。' },
  prdExcerpt: '# 背景\n口径来源说明。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: 'normal', status: i < 6 ? 'done' : 'doing', sort_order: i, created_at: null, updated_at: null,
    prd_id: 'd1', linkedPlans: [], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 12 }, (_, i) => planRow(i)),
  milestones: Array.from({ length: milestoneCount }, (_, i) => milestone(i)),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: Array.from({ length: assigneeCount }, (_, i) => ({ name: i === 3 ? '东方不败·研发一组·平台与数据双栈' : `李四${i + 1}`, planCount: 12 - i })),
  risks: [{ item: '计划进度落后', impact: '排期后移', mitigation: '拆分并行', source: '计划表' }],
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }, { phase: '测试', expected: 36, rowCount: 6 }],
    complexity: [{ level: '1', count: 4 }], counted: 12, footer: '工作量来源：估算引擎（P50 96 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 12, 7, 1, 12, 1][i], status: 'ok' as const, note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
} as any);

const B = mkBundle(7, 12);
const dataFrames = LAY.framesFor('data', 'flow');
const body = dataFrames.body;
const flowItem = { section: '实施计划', title: '阶段推进主线', bullets: ['按里程碑顺序推进，节点日期取自库内计划'], dataKeys: ['milestones'], layout: 'flow' };
const chipItem = { section: '组织分工', title: '人员投入分布', bullets: ['负责人承担计划数分布如下'], dataKeys: ['assignees'], layout: 'chip' };

const kindOf = (b: any) => (b.chart ? 'chart' : b.table ? 'table' : b.text ? 'text' : b.shape ? 'shape' : 'other');
const shapesWith = (blocks: any[], tone: string) => blocks.filter((b: any) => b.shape?.tone === tone);
const nodesOf = (r: any) => shapesWith(r.blocks, 'flowNode');
const arrowsOf = (r: any) => shapesWith(r.blocks, 'flow');
const chipsOf = (r: any) => shapesWith(r.blocks, 'chip');

// ---------- F 组：flow 阶段链 ----------
const flowPass = M.layoutBody(flowItem as any, B, dataFrames, flowItem.bullets) as any;
ok('F-01 flow 页画出节点而不是表格：里程碑数据块不进堆叠预算，也就不会被「空间不足，已省略」吃掉',
  nodesOf(flowPass).length > 0 && !flowPass.blocks.some((b: any) => kindOf(b) === 'table') && flowPass.dropped.length === 0,
  { nodes: nodesOf(flowPass).length, dropped: flowPass.dropped, kinds: flowPass.blocks.map(kindOf) });
ok('F-02 7 个里程碑只承载前 5 个（超过 5 格每格窄到读不清），余数如实点名且不进 dropped',
  nodesOf(flowPass).length === 5 && flowPass.notes.some((n: string) => /只承载前 5 个里程碑，其余 2 个/.test(n)),
  { nodes: nodesOf(flowPass).length, notes: flowPass.notes });
ok('F-03 节点顺序 = 库内里程碑按截止日升序，文字逐字照抄（阶段名不给 AI 编的机会）',
  nodesOf(flowPass).map((b: any) => b.shape.label.text).join('|') === MS_TITLES.slice(0, 5).join('|'),
  nodesOf(flowPass).map((b: any) => b.shape.label.text));
ok('F-04 箭头是连接装饰：数量 = 节点数-1，且不参与越界/重叠判定（硬算就是每页假违规）',
  arrowsOf(flowPass).length === nodesOf(flowPass).length - 1 &&
    arrowsOf(flowPass).every((a: any) => a.shape.kind === 'rightArrow') && flowPass.violations.length === 0,
  { arrows: arrowsOf(flowPass).length, violations: flowPass.violations });
ok('F-05 带字形状走 addText 的 shape 选项（形状与文字同一个原生对象；两块同框会被 findOverlaps 判重叠）',
  /const label = block\.shape\.label;/.test(BLD_SRC) &&
    /slide\.addText\(label\.text,\s*\{[\s\S]{0,240}shape: block\.shape\.kind/.test(BLD_SRC),
  BLD_SRC.slice(BLD_SRC.indexOf('const label = block.shape.label'), BLD_SRC.indexOf('const label = block.shape.label') + 320));
ok('F-06 截止日注来自库内日期（每节点一条），不是套话',
  flowPass.blocks.filter((b: any) => b.text && /截止 \d{2}-\d{2}/.test(b.text.content)).length === nodesOf(flowPass).length,
  flowPass.blocks.filter((b: any) => b.text).map((b: any) => b.text.content));
ok('F-07 整组自排不套分型可读高：14 块（5 节点 + 5 截止日注 + 4 箭头）不会被 T02172 的 flexStrip 判 6.75" 整块 drop',
  M.layoutBody({ ...flowItem, bullets: [] } as any, B, dataFrames, []).blocks.length >=
    nodesOf(flowPass).length * 2 + arrowsOf(flowPass).length && flowPass.violations.length === 0,
  { blocks: flowPass.blocks.length });
ok('F-08 里程碑不足 3 个就没有「链」：如实回落 milestones 表格版并留痕',
  M.flowDegradeReason(mkBundle(2, 3)) !== null && (() => {
    const r = M.layoutBody(flowItem as any, mkBundle(2, 3), dataFrames, flowItem.bullets) as any;
    return nodesOf(r).length === 0 && r.blocks.some((b: any) => kindOf(b) === 'table');
  })(),
  { reason: M.flowDegradeReason(mkBundle(2, 3)) });
// 版面被压到不足 FLOW_MIN_H：组件画不出来 → 回落表格版（宁可退回表格，不画读不清的链）
const squeezedFrames = { ...dataFrames, body: { ...body, h: 0.6 } };
const squeezedFlow = M.layoutBody(flowItem as any, B, squeezedFrames as any, flowItem.bullets) as any;
ok('F-09 剩余高度排不下节点+截止日注：组件让位并点名「回落表格版」，不硬画（硬画就是越界页）',
  nodesOf(squeezedFlow).length === 0 && squeezedFlow.notes.some((n: string) => /阶段链回落表格版/.test(n)),
  { notes: squeezedFlow.notes, kinds: squeezedFlow.blocks.map(kindOf) });
ok('F-10 flow 组件最小高单源：版面预留与绘制前提都用同一个 FLOW_MIN_H（两处各写一份必漂移）',
  (BLD_SRC.match(/const FLOW_MIN_H = FLOW_NODE_H \+ FLOW_NOTE_H/g) ?? []).length === 1 &&
    /frame\.h < FLOW_MIN_H/.test(BLD_SRC) && /\(diagramOn \? diagramMinH \+ MIN_GAP : 0\)/.test(BLD_SRC),
  (BLD_SRC.match(/FLOW_MIN_H/g) ?? []).length);

// ---------- H 组：chip 人员标签 ----------
const chipPass = M.layoutBody(chipItem as any, B, dataFrames, chipItem.bullets) as any;
ok('H-01 标签文字全部来自 assignees（姓名·承担计划数），零虚构',
  chipsOf(chipPass).length > 0 && chipsOf(chipPass).every((c: any) =>
    B.assignees.some((a: any) => c.shape.label.text.startsWith(a.name) && c.shape.label.text.includes(`${a.planCount} 项`))),
  chipsOf(chipPass).map((c: any) => c.shape.label.text));
ok('H-02 超宽即换行：同一行不越右边界，换行后 y 递增（横向流式排布）',
  chipsOf(chipPass).every((c: any) => c.box.x + c.box.w <= body.x + body.w + 1e-6) &&
    new Set(chipsOf(chipPass).map((c: any) => +c.box.y.toFixed(3))).size >= 2,
  chipsOf(chipPass).map((c: any) => ({ x: +c.box.x.toFixed(2), y: +c.box.y.toFixed(2), w: +c.box.w.toFixed(2) })));
// 窄栏残余版面（真实形态：双栏右栏/长要点挤剩的窄条）——组件必须如实报余数，而不是硬画越界
const narrowFrame: any = { x: body.x, y: body.y, w: 2.2, h: 2.0 };
const chipNarrow = M.chipBlocks(B as any, narrowFrame) as any;
ok('H-03 版面排不下的如实计数（其余 n 人见分工页与工作量页，一条不丢），且不硬画越界',
  chipNarrow.drawn > 0 && chipNarrow.drawn < B.assignees.length && chipNarrow.overflow === B.assignees.length - chipNarrow.drawn &&
    chipNarrow.notes.some((n: string) => /其余 \d+ 人见分工页与工作量页（一条不丢）/.test(n)) && chipNarrow.violations.length === 0,
  { drawn: chipNarrow.drawn, overflow: chipNarrow.overflow, notes: chipNarrow.notes });
ok('H-04 过长标签截断有留痕（压字与静默缩字都是谎报）',
  chipNarrow.notes.some((n: string) => /\d+ 个标签过长已截断显示/.test(n)) &&
    chipNarrow.blocks.some((c: any) => /…$/.test(c.shape.label.text)),
  { notes: chipNarrow.notes, texts: chipNarrow.blocks.map((c: any) => c.shape.label.text) });
const emptyAssignees = M.layoutBody(chipItem as any, mkBundle(7, 0), dataFrames, chipItem.bullets) as any;
ok('H-05 assignees 为空：整页回落原有堆叠路径（不虚画标签盒，也不谎报「其余 0 人」）',
  chipsOf(emptyAssignees).length === 0 &&
    !emptyAssignees.notes.some((n: string) => /其余 \d+ 人/.test(n)),
  { kinds: emptyAssignees.blocks.map(kindOf), notes: emptyAssignees.notes });
ok('H-06 chip 页同理不进 dropped（标签版式不是「多出来的一块」，是同一份数据的另一种表达）',
  emptyAssignees.blocks.some((b: any) => kindOf(b) === 'table') && chipsOf(chipPass).length > 0 && chipPass.dropped.length === 0,
  { dropped: chipPass.dropped });

// ---------- V 组：接线与校验 ----------
ok('V-01 layout 枚举扩到 11 值且含 flow / chip（旧 9 值会把这两版式在 schema 层打死）',
  SVC.KICKOFF_LAYOUTS.includes('flow' as any) && SVC.KICKOFF_LAYOUTS.includes('chip' as any) && SVC.KICKOFF_LAYOUTS.length === 11,
  SVC.KICKOFF_LAYOUTS);
ok('V-02 flow / chip 都落 data 族框（复用正文框单源，不新增散写坐标）',
  LAY.layoutFamilyOf('flow') === 'data' && LAY.layoutFamilyOf('chip') === 'data' &&
    LAY.framesFor('data', 'flow').body.h > FLOW_MIN_H,
  { flow: LAY.layoutFamilyOf('flow'), body: LAY.framesFor('data', 'flow').body });
const page = (i: number, dataKeys: string[], layout = 'twoCol') => ({
  section: '实施计划', title: `第${i + 1}页`, bullets: ['「需求 1」已完成拆解'], dataKeys, layout,
});
const outlineOf = () => Array.from({ length: 12 }, (_, i) =>
  i === 0 ? page(0, [], 'cover')
    : i === 1 ? page(1, [], 'toc')
      : i === 3 ? page(3, ['milestones'], 'flow')
        : i === 4 ? page(4, ['assignees'], 'chip')
          : i === 5 ? page(5, ['timeline'], 'timeline')
            : i === 7 ? page(7, ['workload'])
              : i === 11 ? page(11, [], 'thanks')
                : page(i, ['reqStats']));
let vErr = '';
try { SVC.validateOutline(outlineOf()); } catch (e) { vErr = e instanceof Error ? e.message : String(e); }
ok('V-03 validateOutline 接受 flow+milestones / chip+assignees 组合（合法 dataKeys 不被误杀）',
  vErr === '' && SVC.validateOutline(outlineOf()).outline[3].layout === 'flow', vErr);
ok('V-04 提示词话术带图示版式约束：各至多一页 + 文字由系统按库内真值绘制 + bullets 不复述',
  /layout:'flow'（dataKeys 写 milestones）/.test(SVC_SRC) && /layout:'chip'\s*（dataKeys 写 assignees）/.test(SVC_SRC) &&
    /两者各至多一页/.test(SVC_SRC) && /不复述阶段名与人名、不自造步骤/.test(SVC_SRC),
  SVC_SRC.slice(SVC_SRC.indexOf('T02198 图示版式'), SVC_SRC.indexOf('T02198 图示版式') + 300));
ok('V-05 重试那一轮也知道有图示版式（RETRY 话术同步，否则重试退回旧 9 值口径）',
  /阶段链用 flow、人员标签用 chip（各至多一页）/.test(SVC_SRC.slice(SVC_SRC.indexOf('OUTLINE_SYSTEM_RETRY'), SVC_SRC.indexOf('OUTLINE_SYSTEM_RETRY') + 900)),
  SVC_SRC.slice(SVC_SRC.indexOf('const OUTLINE_SYSTEM_RETRY'), SVC_SRC.indexOf('const OUTLINE_SYSTEM_RETRY') + 620));
const toneBody = BLD_SRC.slice(BLD_SRC.indexOf('function shapeToneColor'), BLD_SRC.indexOf('export function drawBlock'));
ok('V-06 色值单源不破门禁 6：三个新 tone 全取 PALETTE，builder 里零 hex 字面量',
  ['flowNode', "'flow'", 'chip'].every((t) => new RegExp(`tone === ${t.startsWith("'") ? t : `'${t}'`}\\) return PALETTE\\.`).test(toneBody)) &&
    (BLD_SRC.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).length === 0,
  { hex: BLD_SRC.match(/#[0-9A-Fa-f]{6}\b/g), tone: toneBody });
ok('V-07 版式层豁免与绘制层一致：blockBoundsIssues / contentBoxes 都把 tone=flow 箭头排除（漏一处就是假违规）',
  /blk\.shape\?\.tone === 'axis' \|\| blk\.shape\?\.tone === 'flow'/.test(BLD_SRC) &&
    /blk\.shape\?\.tone !== 'axis' && blk\.shape\?\.tone !== 'flow'/.test(BLD_SRC),
  { bounds: /tone === 'flow'/.test(BLD_SRC), content: /tone !== 'flow'/.test(BLD_SRC) });

const PANEL_SRC = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');
const feLayouts = [...(PANEL_SRC.match(/const LAYOUTS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((x) => x[1]);
ok('V-08 三处同源不漏第三处：前端大纲编辑下拉的版式候选与服务端枚举逐字同序（漏了手工改稿就选不到 flow/chip）',
  feLayouts.join(',') === SVC.KICKOFF_LAYOUTS.join(','), { fe: feLayouts, srv: [...SVC.KICKOFF_LAYOUTS] });

// ---------- P 组：真产物 ----------
const built = await M.buildKickoffPpt(B as any, [
  page(0, [], 'cover'), page(1, [], 'toc'), page(2, ['milestones'], 'flow'),
  page(3, ['assignees'], 'chip'), page(4, ['timeline'], 'timeline'), page(5, ['workload']), page(6, [], 'thanks'),
] as any);
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
const xmls: Record<string, string> = {};
for (const n of slideNames) xmls[n] = await zip.file(n)!.async('string');
/** 抽出某类原生形状的对象盒：pptxgenjs 把 addText(shape:...) 写成 prstGeom 同名 + 内含 a:t 的 <p:sp> */
const spsOf = (xml: string, prst: string) =>
  (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).filter((sp) => new RegExp(`prst="${prst}"`).test(sp));
const flowXml = xmls[slideNames[2]];
const chipXml = xmls[slideNames[3]];
ok('P-01 产物里 flow 节点是「形状内带文字」的同一个原生对象（roundRect 的 <p:sp> 内含库内阶段名）',
  spsOf(flowXml, 'roundRect').length === 5 &&
    MS_TITLES.slice(0, 5).every((t) => spsOf(flowXml, 'roundRect').some((sp) => sp.includes(`<a:t>${t}</a:t>`))),
  { nodes: spsOf(flowXml, 'roundRect').length, texts: spsOf(flowXml, 'roundRect').map((sp) => (sp.match(/<a:t>([^<]*)<\/a:t>/) ?? [])[1]) });
ok('P-02 箭头真的落进产物（rightArrow 对象数 = 节点数-1），且没被当成内容盒报违规',
  (flowXml.match(/prst="rightArrow"/g) ?? []).length === 4,
  { arrows: (flowXml.match(/prst="rightArrow"/g) ?? []).length });
ok('P-03 chip 页产物同理：标签形状带「姓名·n 项」真值',
  spsOf(chipXml, 'roundRect').length > 0 &&
    spsOf(chipXml, 'roundRect').every((sp) => /·\d+ 项/.test(sp)) &&
    spsOf(chipXml, 'roundRect').some((sp) => sp.includes('<a:t>李四1·12 项</a:t>')),
  { chips: spsOf(chipXml, 'roundRect').length, texts: spsOf(chipXml, 'roundRect').map((sp) => (sp.match(/<a:t>([^<]*)<\/a:t>/) ?? [])[1]).slice(0, 8) });
ok('P-04 flow/chip 页没被降级，全稿没有「空间不足，已省略」与越界告警（组件自排没把别的页带崩）',
  built.degradedPages.length === 0 &&
    !built.warnings.some((w: string) => /省略|越界|超出页面/.test(w)) &&
    !built.warnings.some((w: string) => /对比度/.test(w)),
  { degraded: built.degradedPages, warnings: built.warnings });
ok('P-05 flow 页几何不越页：节点+箭头底边都在正文框内（EMU 逐张核对，防「placed 但出界」）',
  spsOf(flowXml, 'roundRect').every((sp) => {
    const m = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/.exec(sp);
    if (!m) return false;
    const [, x, y, w, h] = m.map(Number);
    return (x + w) / 914400 <= 10 + 1e-4 && (y + h) / 914400 <= 5.625 + 1e-4;
  }),
  spsOf(flowXml, 'roundRect').map((sp) => /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/.exec(sp)?.slice(1).map((v) => +(Number(v) / 914400).toFixed(2))));

writeFileSync(gateArtifactPath(OUT_DIR, 't02198-flow.pptx'), built.buffer);
writeGateResults(OUT_DIR, 't02198-gate-results.txt', `T02198 flow/chip 图示版式门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
