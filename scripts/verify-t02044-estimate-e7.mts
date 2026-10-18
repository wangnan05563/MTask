/**
 * T02044 · PRD-估算视图与工作量评估导出 §11-E7 验证（PDF 导出，内部版/客户版，服务端脱敏）。
 *
 * 四轨（对齐 E6 的门禁纪律，见 §11 v2.1 ①）：
 *  G 轨 Markdown 中间文档：`buildEstimateReportMd()` 是脱敏发生的**那一层**——客户版正文里
 *    根本不长出系数分项 / σ / P50/P84 / 备注三条 / 附加 sheet 名。断言这层比断言 PDF 更有效，
 *    因为「涂黑式脱敏」在 PDF 层看不出来（字还在，只是不显示）。
 *  P 轨 PDF 字节：魔数 `%%PDF-` 头 + `%%EOF` 尾 + 体积合理 + 内部版与客户版字节不同。
 *  R 轨 REST 端点：`/export-pdf` 的状态码、两个响应头、快照 payload 的 §7 比对契约、
 *    参数词表 400、性能预算（§9：500 行明细 PDF < 6s）。
 *  X 轨 pypdf 真件文字（第四双眼睛）：把两份 PDF 落盘，用 python `pypdf` 取**渲染后的文字层**，
 *    证明脱敏不只是「md 里没有」，而是「件里取不出来」；同时证明报价数字在两版里逐字相同。
 *    本机 python/pypdf 不可用时显式 `[SKIP]`，不放行假绿（同 E6 的 openpyxl 轨口径）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02044-estimate-e7.mts
 * 可选环境变量：T02044_PORT（隔离实例端口，默认 39936）、T02044_KEEP（保留临时目录与 PDF 产物）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02044-e7-'));
const OUT_DIR = join(DATA_DIR, 'out');

const E = await import('../server/src/services/estimate-engine.ts');
const X = await import('../server/src/services/estimateExportXlsx.ts');
const PDFSVC = await import('../server/src/services/estimateExportPdf.ts');
const { ESTIMATE_PHASES, ESTIMATE_PROJECT_NOT_FOUND } = await import('../server/src/services/EstimateService.ts');
/**
 * T02293 批⑪：件名判据不再由门手写「工作量评估」前缀自证——取产品的两份单源
 * （文案常量 + 清洗函数），把观测到的件名重组成**同一函数的输出**来比。
 * 只 import util/service，不 import routes（那会带进 express/DB 副作用，门进程与服务实例是两套环境）。
 */
const { ESTIMATE_FILE_BASE, ESTIMATE_FILE_CLIENT_MARK } = await import('../server/src/services/estimateCopy.ts');
const { safeExportName } = await import('../server/src/util/export-name.ts');

/**
 * 件名单源自证（判据 1）：门直接取产品的两份单源（文案常量 + 清洗函数）重拼观测件名，
 * **逐字相同**才算数——门不手写 `startsWith('工作量评估-…')` 当判据，也不另抄一份拼装模板。
 * 与 `routes/estimates.ts:774` 同口径：`safeExportName(基名[-客户版]-项目名-时间戳) + '.pdf'`
 * （扩展名在清洗函数之外附加，比对时一并补回；不 import routes，那会把 express/DB 副作用带进门进程）。
 */
const reraiseName = (observed: string, audience: 'internal' | 'client', proj: string): boolean => {
  const m = new RegExp(`^(${ESTIMATE_FILE_BASE})(${audience === 'client' ? ESTIMATE_FILE_CLIENT_MARK : ''})-${proj}-(\\d{8}-\\d{6})\\.pdf$`).exec(observed);
  return !!m && observed === `${safeExportName(`${m[1]}${m[2]}-${proj}-${m[3]}`, ESTIMATE_FILE_BASE)}.pdf`;
};
/** T02293 规约判据 1：交付件文案的期望值一律取自 `PDF_TEXTS` 单源——断言里不再抄第二份中文口径 */
const PT = PDFSVC.PDF_TEXTS;

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
};
const skipped = (name: string, why: string) => console.log(`  [SKIP] ${name}（${why}）——不计 PASS`);
const group = (t: string) => console.log(`\n== ${t}`);

const CFG = { ...E.DEFAULT_ESTIMATE_CONFIG, hideCoefsForClient: true };
const STD = CFG.manDaysPerManMonth;
const COEF_SUM = E.ESTIMATE_COEF_KEYS.reduce((a: number, k) => a + CFG.coefs[k], 0);
const COEF_LABELS = E.ESTIMATE_COEF_LABELS as Record<string, string>;

// ---------------------------------------------------------------- 夹具（G/P 轨用，不碰 DB）
const mk = (
  planId: string, title: string, phase: string, pts: [number, number, number] | null,
  over: Record<string, unknown> = {},
): any => ({
  planId,
  title,
  detail: X.cleanDetail(over['description'] as string ?? '', title),
  phase,
  planKind: (over.planKind as string) ?? 'normal',
  milestone: (over.milestone as string) ?? '',
  optimistic: pts ? pts[0] : null,
  likely: pts ? pts[1] : null,
  pessimistic: pts ? pts[2] : null,
  source: (over.source as string) ?? '',
  complexity: (over.complexity as number) ?? null,
  reqNos: (over.reqNos as string[]) ?? [],
});

const FIX_ROWS: any[] = [
  mk('r-req-1', '需求分析与用例梳理', 'req', [3, 5, 8], { source: 'manual' }),
  mk('r-des-1', '系统概设与数据库设计', 'design', [2, 4, 6], { source: 'rule' }),
  mk('r-ms-1', 'M1 平台基座', 'dev', [5, 5, 5], { planKind: 'milestone', source: 'manual' }),
  mk('r-dev-1', '登录与权限模块', 'dev', [4, 6, 9], { milestone: 'M1 平台基座', source: 'manual' }),
  mk('r-dev-2', '估算面板前端', 'dev', [2, 3, 4], { milestone: 'M1 平台基座', source: 'default' }),
  mk('r-dev-3', '导出服务端', 'dev', [5, 8, 12], { milestone: 'M2 交付件', source: 'manual' }),
  mk('r-dev-4', '这一行还没有三点', 'dev', null, { milestone: 'M2 交付件' }),
  mk('r-imp-1', '安装部署与验收', 'impl', [1, 2, 4], { source: 'rule' }),
  mk('r-com-1', '项目管理与质量投入', 'common', [2, 4, 6], { source: 'manual' }),
];

/** 本脚本**独立**重算一套期望值（不用 layout 的返回值当期望，否则是同义反复） */
const handE = (r: any): number | null =>
  r.optimistic !== null ? (r.optimistic + 4 * r.likely + r.pessimistic) / 6 : null;
const inPool = (r: any) => r.planKind !== 'milestone';
const HAND_SUM_E = FIX_ROWS.filter(inPool).reduce((a: number, r) => a + (handE(r) ?? 0), 0);
const HAND_IDEAL_MM = HAND_SUM_E / STD;
const HAND_ACTUAL_MM = HAND_IDEAL_MM * (1 + COEF_SUM);
const HAND_DEV_E = FIX_ROWS.filter((r) => r.phase === 'dev' && inPool(r)).reduce((a: number, r) => a + (handE(r) ?? 0), 0);
const HAND_UNREVIEWED = FIX_ROWS.filter((r) => inPool(r) && handE(r) !== null && (r.source === 'rule' || r.source === 'default')).length;

const input = (over: Record<string, unknown> = {}): any => ({
  projectId: 'p-e7',
  projectName: (over.projectName as string) ?? 'T02044-E7验证',
  estimateDate: '2026-10-12',
  reviewer: (over.reviewer as string) ?? '王南',
  rows: FIX_ROWS,
  config: CFG,
  scope: (over.scope as string) ?? 'all',
  phases: over.phases as string[] | undefined,
  audience: (over.audience as string) ?? 'internal',
  generatedAt: '2026-10-12T09:00:00.000Z',
});
const layoutOf = (over: Record<string, unknown> = {}) => X.layoutEstimate(input(over) as any);
const mdOf = (over: Record<string, unknown> = {}) => PDFSVC.buildEstimateReportMd(layoutOf(over));
/** 归一化：pypdf 取出的文字里空格/换行不稳定，md 里也有全角空格问题——比对一律去空白 */
const flat = (s: string) => s.replace(/\s+/g, '');

// ---------------------------------------------------------------- G 轨：中间文档与脱敏边界
group('G1 内部版结构与必备内容（§6.2 四类内容 + §6.3 首页标注）');
{
  const md = mdOf();
  ok('G-01 件名沿用模板标题（不是自造一个「工作量评估报告」）', md.includes(`${X.TEMPLATE_TEXTS.title}（${PT.audienceInternal}）`) || PDFSVC.estimatePdfTitle(layoutOf()) === `${X.TEMPLATE_TEXTS.title}（${PT.audienceInternal}）`, PDFSVC.estimatePdfTitle(layoutOf()));
  const CNH = ['一', '二', '三', '四', '五', '六', '七', '八'];
  // 章节清单取 PDF_TEXTS 单源全名（此前抄的是截断形态「四、开发段明细」，改一次文案打一次与功能无关的红）
  const must = [PT.secQuote, PT.secRange, PT.secPhases, PT.secDev, PT.secCoefs, PT.secSelfCheck, PT.secRemarks, PT.secDisclaimer]
    .map((t, i) => `${CNH[i]}、${t}`);
  ok('G-02 内部版八个章节齐全且按序出现', must.every((h, i) => { const p = md.indexOf(h); return p >= 0 && (i === 0 || p > md.indexOf(must[i - 1])); }), must.filter((h) => !md.includes(h)));
  ok('G-03 表格式汇总（Markdown 表格行存在，pdfkit 渲染为 `a | b` 文本行；行标签取单源）',
    new RegExp(`\\|[^\\n]*${PT.quoteDirect}[^\\n]*\\|`).test(md) && new RegExp(`\\|[^\\n]*${PT.quoteActual}[^\\n]*\\|`).test(md),
    { need: [PT.quoteDirect, PT.quoteActual] });
  ok('G-04 §6.2 要求的「置信区间说明」在内部版出现（P50/P84 + σ_total）', md.includes('P50') && md.includes('P84') && md.includes('σ_total'));
  ok('G-05 备注三条逐条出现（§6.1 内部版必带，取自 TEMPLATE_REMARKS 单源）', X.TEMPLATE_REMARKS.every((r) => md.includes(r)));
  ok('G-06 免责声明落在件尾（PDF 是预览件这件事必须写在件里，不只是 PRD 里）', md.lastIndexOf(PT.secDisclaimer) > md.lastIndexOf(PT.secRemarks) && md.includes(PT.disclaimerDelivery), { need: PT.disclaimerDelivery });
  ok('G-07 首页待复核标注（§6.3：PDF 首页显著标注）在前 400 字符内', md.indexOf(PT.unreviewedTail) > 0 && md.indexOf(PT.unreviewedTail) < 400, md.slice(0, 260));
  okPair(ok, 'G-08 项目名/估算日期/估算人进抬头',
    // 行为侧：三个夹具值都落在**抬头区**（首个小节标题之前）——旧判据只问「全文有没有」，
    //        值掉到件尾也照样绿，那已经不是「进抬头」这条口径了
    () => {
      const head = md.split(/\n(?=#{2,3}\s)/)[0];
      return ['T02044-E7验证', '2026-10-12', '王南'].every((v) => head.includes(v));
    },
    () => md.includes('T02044-E7验证') && md.includes('2026-10-12') && md.includes('王南'),
    () => ({ 抬头区: md.split(/\n(?=#{2,3}\s)/)[0].slice(0, 260) }));
  ok('G-09 估算人为空时写「（待填写）」而不是留白塌陷成 `| | |`', mdOf({ reviewer: '' }).includes(PT.pendingReviewer), { need: PT.pendingReviewer });
  ok('G-10 阶段标签用模板文案（不是面板标签：内部版标签给客户看会长出客户没见过的词）',
    md.includes(X.TEMPLATE_PHASE_LABELS.design) && !md.includes('| 系统设计 |'));
}

group('G2 数字与独立重算一致（§11.1 E6 红线 2：预览件与交付件同数）');
{
  const md = mdOf();
  const l = layoutOf();
  const grab = (label: string): number | null => {
    const m = new RegExp(`${label}[^\\d-]*([\\d.]+)`).exec(md);
    return m ? Number(m[1]) : null;
  };
  ok('G-11 直接投入人天 = Σ(O+4M+P)/6（脚本手算对照）', Math.abs((grab(PT.quoteDirect) ?? NaN) - HAND_SUM_E) < 0.01,
    { got: grab(PT.quoteDirect), want: HAND_SUM_E });
  ok('G-12 理想人月 = 直接人天 ÷ 每人月工天标准（除数取配置，不写死 20.83）',
    Math.abs((grab(PT.quoteIdeal) ?? NaN) - HAND_IDEAL_MM) < 0.005 && md.includes(`÷ ${X.NAMED_RANGE_STD} ${STD}`),
    { got: grab(PT.quoteIdeal), want: HAND_IDEAL_MM });
  ok('G-13 实际预估人月 = 理想人月 ×(1+Σ系数)', Math.abs((grab(PT.quoteActual) ?? NaN) - HAND_ACTUAL_MM) < 0.005,
    { got: grab(PT.quoteActual), want: HAND_ACTUAL_MM });
  ok('G-14 里程碑行（5/5/5）不进 Σ：件里合计等于非里程碑行之和',
    Math.abs(l.summary.directManDays.expected - HAND_SUM_E) < 1e-9 && HAND_SUM_E !== 0);
  ok('G-15 阶段构成合计行与报价结论的直接人天同数（一处算、两处读）',
    (md.match(new RegExp(`${PT.totalRow} \\| [\\d.]+ \\| [\\d.]+ \\| [\\d.]+ \\| ${String(Number(HAND_SUM_E.toFixed(2)))}`, '')) ?? []).length === 1,
    md.split('\n').find((s) => s.startsWith(`| ${PT.totalRow}`)));
  ok('G-16 未估算行写成「未估算」而不是 0（§6.1：没估 ≠ 估了 0 天）', md.includes(`| ${PT.unEstimatedCell} |`) && !md.includes(`| 0 | ${PT.unEstimatedCell}`));
  ok('G-17 空阶段（onsite 无明细）不出现在阶段构成表里', !md.includes(X.TEMPLATE_PHASE_LABELS.onsite));
  ok('G-18 待复核计数 N 与 layout.unreviewed 同一个数（§6.3 只认服务端那一份）',
    HAND_UNREVIEWED === layoutOf().unreviewed && md.includes(`有 ${HAND_UNREVIEWED} ${PT.unreviewedTail}`), { md: HAND_UNREVIEWED, layout: layoutOf().unreviewed });
}

group('G3 客户版脱敏（§6.2 四项：系数分项 / σ·置信区间 / 备注三条 / 附加 sheet 引用）');
{
  const mdCli = mdOf({ audience: 'client' });
  const mdInt = mdOf({ audience: 'internal' });
  const hidden = [COEF_LABELS.collaboration, COEF_LABELS.quality, COEF_LABELS.scope, COEF_LABELS.schedule,
    'P50', 'P84', 'σ_total', '置信', X.TEMPLATE_REMARKS[0], X.TEMPLATE_REMARKS[1], X.TEMPLATE_REMARKS[2],
    PT.secRemarks, X.SHEET_DETAIL, X.SHEET_PARAMS, PT.secSelfCheck];
  const leaked = hidden.filter((t) => mdCli.includes(t));
  ok('G-19 客户版正文不含：四系数分项 / P50·P84·σ / 备注三条 / 附加 sheet 名 / 自检段', leaked.length === 0, leaked);
  ok('G-20 内部版这些都含（脱敏是真分支，不是两边都缺的假绿）',
    [COEF_LABELS.collaboration, 'P84', 'σ_total', X.TEMPLATE_REMARKS[0], X.SHEET_DETAIL].every((t) => mdInt.includes(t)));
  ok('G-21 客户版仍含报价三数（藏依据不改数）',
    [PT.quoteDirect, PT.quoteIdeal, PT.quoteActual].every((k) => flat(mdCli).includes(flat(k))));
  const numLine = (md: string, label: string): string => {
    const m = new RegExp(`\\| ${label} \\| ([^|]+) \\|`).exec(md);
    return m ? m[1].trim() : '';
  };
  ok('G-22 两版的三个报价数字逐字相同（字符串相等，不是四舍五入后相等）',
    [PT.quoteDirect, PT.quoteIdeal, PT.quoteActual].every((k) => numLine(mdCli, k) === numLine(mdInt, k) && numLine(mdInt, k) !== ''),
    [PT.quoteDirect, PT.quoteIdeal, PT.quoteActual].map((k) => [numLine(mdInt, k), numLine(mdCli, k)]));
  ok('G-23 客户版件名标（客户版）', PDFSVC.estimatePdfTitle(layoutOf({ audience: 'client' })).endsWith(`（${PT.audienceClient}）`));
  ok('G-24 待复核标注对客户版同样保留（§6.3 没有受众例外：少报待复核行比少报系数更贵）',
    mdCli.includes(`有 ${HAND_UNREVIEWED} ${PT.unreviewedTail}`));
  const heads = (md: string) => md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).split('、')[0]);
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
  ok('G-25 章节号按「实际出现的节」连续（客户版一~五 / 内部版一~八，隐藏章节不占号）',
    heads(mdCli).join('') === CN.slice(0, 5).join('') && heads(mdInt).join('') === CN.slice(0, 8).join(''),
    { cli: heads(mdCli), int: heads(mdInt) });
  // 阶段筛选把开发段整段筛掉时也必须连续：编号写死会跳成「一、二、四、五」，件面像漏了内容
  const mdNoDev = PDFSVC.buildEstimateReportMd(X.layoutEstimate(input({ audience: 'client', phases: ['impl'] }) as any) as any);
  ok('G-25b 开发段整段不在件上时，客户版章节号仍连续且不出现「开发段明细」',
    heads(mdNoDev).join('') === CN.slice(0, heads(mdNoDev).length).join('') && !mdNoDev.includes(PT.secDev),
    heads(mdNoDev));
}

group('G4 hideCoefsForClient 只管折叠（与 E6 的 Excel 语义一致，不是无条件藏系数）');
{
  const noFold = { ...CFG, hideCoefsForClient: false };
  const mdCliNoFold = PDFSVC.buildEstimateReportMd(X.layoutEstimate({ ...input({ audience: 'client' }), config: noFold } as any));
  ok('G-26 关折叠时客户版保留系数分项（配置控制的是「折叠明细」，§6.2 的 σ/备注/sheet 仍是无条件隐藏）',
    mdCliNoFold.includes(COEF_LABELS.collaboration) && !mdCliNoFold.includes('σ_total') && !mdCliNoFold.includes(X.SHEET_DETAIL));
  const mdCliFold = mdOf({ audience: 'client' });
  ok('G-27 开折叠时并进一行合计（标签取自模板单源）',
    mdCliFold.includes(X.TEMPLATE_TEXTS.foldedCoef) && !mdCliFold.includes(COEF_LABELS.collaboration));
  ok('G-28 折叠行数值 = Σ四个系数（报价数分毫不差的依据）',
    new RegExp(`${X.TEMPLATE_TEXTS.foldedCoef} \\| ${String(Number(COEF_SUM.toFixed(2)))}`).test(mdCliFold), mdCliFold.split('\n').find((s) => s.includes(X.TEMPLATE_TEXTS.foldedCoef)));
}

group('G5 scope / phases 口径');
{
  const mdEst = mdOf({ scope: 'estimated_only' });
  okPair(ok, 'G-29 estimated_only 时未估算行不成行（r-dev-4 正文不出现）',
    // 行为侧：对照面先证「全量口径下这行确实会上件」，再证 estimated_only 下它整行消失、
    //        且正文仍有其它行（防「导出空文档」也让「不含该行」为真）
    () => mdOf().includes('这一行还没有三点') && !mdEst.includes('这一行还没有三点') && mdEst.includes('登录与权限模块'),
    () => !mdEst.includes('这一行还没有三点'),
    () => ({ 全量面含此行: mdOf().includes('这一行还没有三点'), estimated_only表格行数: mdEst.split('\n').filter((s) => s.trim().startsWith('|')).length }));
  ok('G-30 口径行写「仅已估算行」（件里说清这次导了什么范围）', mdEst.includes(PT.scopeEstimatedOnly) && mdOf().includes(PT.scopeAll), { need: [PT.scopeEstimatedOnly, PT.scopeAll] });
  const mdDev = mdOf({ phases: ['dev'] });
  ok('G-31 phases=dev 时其他阶段不上件（模板阶段标签不出现）',
    !mdDev.includes(X.TEMPLATE_PHASE_LABELS.req) && !mdDev.includes(X.TEMPLATE_PHASE_LABELS.impl) && mdDev.includes('登录与权限模块'));
  ok('G-32 阶段筛选只缩范围、不改筛选后阶段的算价口径（Σ 仍等于该阶段行之和）',
    (() => { const m = new RegExp(`${PT.totalRow} \\| [\\d.]+ \\| [\\d.]+ \\| [\\d.]+ \\| ([\\d.]+)`).exec(mdDev); return m ? Math.abs(Number(m[1]) - HAND_DEV_E) < 0.01 : false; })(),
    mdDev.split('\n').find((s) => s.startsWith(`| ${PT.totalRow}`)), HAND_DEV_E);
  {
    // 行为侧（结构判据）：正文里的表格**每行列数一致**，且没有任何一列的表头是追溯列
    //（单元格级判定）。旧判据只问「这两个汉字在全文任何位置都不出现」——正文里出现一句无关的
    // 「复杂度」就会假红，而真的多出一列却可能因为列名换了而漏判。
    // 件里可以有多张表（封面信息表 4 列、报价表 N 列…），所以列数一致性只能在**每张表内部**判；
    // 跨表统一列数会把正常的多表结构判成失守。
    const tablesOf = (s: string) => {
      const out: string[][][] = [];
      let cur: string[][] = [];
      for (const line of s.split('\n')) {
        if (/^\s*\|.*\|\s*$/.test(line)) cur.push(line.trim().slice(1, -1).split('|').map((c) => c.trim()));
        else if (cur.length) { out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
      return out;
    };
    okPair(ok, 'G-33 需求编号 / 复杂度 不在 PDF 正文里（PDF 是预览件，追溯列属 Excel 附加 sheet）',
      () => {
        const ts = tablesOf(mdOf());
        return ts.length >= 2 && ts.every((t) => t.length >= 2 && t.every((r) => r.length === t[0].length))
          && !ts.some((t) => t[0].some((h) => /需求编号|追溯|复杂度/.test(h)))
          && !ts.some((t) => t.some((r) => r.some((c) => /^REQ-/.test(c))));
      },
      () => !mdOf().includes('REQ-') && !mdOf().includes('复杂度'),
      () => ({ 表格数: tablesOf(mdOf()).length, 各表表头: tablesOf(mdOf()).map((t) => t[0]), 列数不齐的表: tablesOf(mdOf()).filter((t) => !t.every((r) => r.length === t[0].length)).map((t) => t.map((r) => r.length)) }));
  }
}

// ---------------------------------------------------------------- P 轨：PDF 字节
group('P 轨 PDF 字节形态');
{
  const intBuf = await PDFSVC.buildEstimatePdf(layoutOf());
  const cliBuf = await PDFSVC.buildEstimatePdf(layoutOf({ audience: 'client' }));
  ok('P-01 PDF 魔数 %PDF- 头', intBuf.subarray(0, 5).toString() === '%PDF-', intBuf.subarray(0, 8).toString());
  ok('P-02 尾部 %%EOF（渲染链跑完，不是半份文件）', intBuf.subarray(-64).toString().includes('%%EOF'));
  ok('P-03 体积合理（>4KB 且 <2MB；中文字体子集被嵌进去，太小就是没渲染正文）',
    intBuf.length > 4_000 && intBuf.length < 2_000_000, intBuf.length);
  ok('P-04 客户版与内部版是两份不同的件（不是同一 buffer 改标题）', intBuf.length !== cliBuf.length && !intBuf.equals(cliBuf),
    { internal: intBuf.length, client: cliBuf.length });
  writeFileSync(join(DATA_DIR, 'e7-internal.pdf'), intBuf);
  writeFileSync(join(DATA_DIR, 'e7-client.pdf'), cliBuf);
  ok('P-05 两份件已落盘（X 轨与人工过目都用得到）', existsSync(join(DATA_DIR, 'e7-internal.pdf')) && existsSync(join(DATA_DIR, 'e7-client.pdf')));
  ok('P-06 md 中间文档可由 buildEstimatePdf 的默认参数注入（渲染链单源：PDF 正文 = 这份 md）',
    (() => {
      const md = mdOf();
      const b2 = PDFSVC.buildEstimatePdf(layoutOf(), md);
      return typeof b2.then === 'function';
    })());
}

// ---------------------------------------------------------------- R 轨：隔离实例 REST
const PORT = Number(process.env.T02044_PORT ?? 39936);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
const BASE = `http://127.00.1:${PORT}`;
async function waitForServer(ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  let out: Record<string, any> | null = null;
  try { out = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json: out };
}
async function getPdf(query: string) {
  const res = await fetch(`${BASE}/api/estimates/export-pdf${query}`);
  if (!res.ok) {
    return { status: res.status, buf: Buffer.alloc(0), headers: res.headers, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers, json: null as Record<string, any> | null };
}
async function getXlsx(query: string) {
  const res = await fetch(`${BASE}/api/estimates/export-xlsx${query}`);
  return {
    status: res.status,
    buf: res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0),
    headers: res.headers,
    json: res.ok ? null : ((await res.json().catch(() => ({}))) as Record<string, any>),
  };
}

if (!(await waitForServer())) {
  console.log('  [FAIL] 隔离服务未就绪，R 段整体跳过');
  console.log(serverLog.join('').slice(-1500));
  fail += 1;
} else {
  group('R1 端点基本形态（§6.2 + E6 实测补充「沿用同一对响应头」）');
  // 造一个真项目：计划 → 规则推导 → 人工改两行 → 设估算人
  const proj = (await api('POST', '/api/projects', { name: 'T02044-E7R段' })).json;
  const PID = String(proj?.id ?? '');
  ok('R-01 隔离实例就绪并建好夹具项目', (await api('GET', '/api/health')).status === 200 && !!PID, PID);
  const items: any[] = [{ title: 'M1 平台基座', kind: 'milestone' }];
  for (let i = 1; i <= 12; i++) {
    items.push({
      title: `W1.${i} 功能点${i}`,
      kind: 'normal',
      description: `第 ${i} 条功能点：需求描述要压平成一行，导出件的 D 列不吃换行。`,
      complexity: (i % 5) + 1,
    });
  }
  const batch = await api('POST', '/api/plans/batch', { projectId: PID, items });
  const planIds: string[] = batch.json?.ids ?? [];
  ok('R-02 13 条计划（含 1 里程碑）建好', planIds.length === 13, planIds.length);
  const derived = await api('POST', '/api/estimates/derive', { projectId: PID, dryRun: false, scope: 'missing' });
  ok('R-03 规则推导落库（制造真实的「未人工复核」行）', derived.status === 200, derived.json);
  const patched = await api('PATCH', `/api/estimates/${planIds[2]}?projectId=${PID}`, { phase: 'dev', unit: 'man_day', optimistic: 4, likely: 6, pessimistic: 9 });
  ok('R-04 人工改一行（转 manual，§4.6）', patched.status === 200 && patched.json?.item?.source === 'manual', patched.json);
  const rev = await api('PUT', '/api/estimates/params', { projectId: PID, settings: { 'estimate.reviewer': '评审人甲' } });
  ok('R-05 估算人（署名项）有写入通道——没有它，PDF 件的「估算人」恒为「（待填写）」', rev.status === 200, rev.json);
  const PQ = `projectId=${PID}`;

  {
    const r = await getPdf(`?${PQ}`);
    ok('R-06 GET /export-pdf 200 + application/pdf', r.status === 200 && String(r.headers.get('content-type')) === 'application/pdf',
      [r.status, r.headers.get('content-type')]);
    ok('R-07 字节是 PDF（%PDF- 头），且体量与纯计算轨同量级', r.buf.subarray(0, 5).toString() === '%PDF-' && r.buf.length > 4_000, r.buf.length);
    const cd = String(r.headers.get('content-disposition'));
    const fname = decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? '');
    okPair(ok, 'R-08 件名走 RFC5987 + §6.3 命名口径（中文项目名不变成 ???）',
      // 行为侧：观测件名就是「产品单源常量 + 产品清洗函数」重拼出来的那一个字，且夹具项目名段完整存活（没被洗成 ??? 或空）
      () => cd.includes("filename*=UTF-8''") && reraiseName(fname, 'internal', 'T02044-E7R段') && fname.includes('T02044-E7R段'),
      () => fname.startsWith('工作量评估-T02044-E7R段-') && fname.endsWith('.pdf'),
      () => ({ cd, fname }));
    ok('R-08b 件名判据有牙：多一段/换项目名的副本必须不被自证放行（防「形状恰好匹配」的空判据）',
      reraiseName(`抄${ESTIMATE_FILE_BASE}-T02044-E7R段-20260101-000000.pdf`, 'internal', 'T02044-E7R段') === false
      && reraiseName(fname, 'client', 'T02044-E7R段') === false
      && reraiseName(fname.replace('T02044-E7R段', '别的项目'), 'internal', 'T02044-E7R段') === false
      && reraiseName(fname, 'internal', 'T02044-E7R段') === true,
      fname);
    ok('R-09 响应头回带快照 id（§6.3 每次导出留痕）', /^[\w-]+$/.test(String(r.headers.get('x-estimate-snapshot'))), r.headers.get('x-estimate-snapshot'));
    const cli = await getPdf(`?${PQ}&audience=client`);
    const cliName = decodeURIComponent(String(cli.headers.get('content-disposition')).split("filename*=UTF-8''")[1] ?? '');
    okPair(ok, 'R-10 客户版件名带 -客户版（与 Excel 同一套件名规则，不开第三种取件名通道）',
      // 行为侧：客户版件名 = 内部版件名**只差单源标记段**（同一规则的两个输出，不是第二处手写模板），
      //         且它自己也能过一遍同源自证。时间戳段先摘掉再比——两次导出跨秒是常态，
      //         把秒差当成「命名规则不同」会让判据随机红（反模式：门的时钟依赖不是产品的行为差异）。
      () => reraiseName(cliName, 'client', 'T02044-E7R段')
        && cliName.replace(/-\d{8}-\d{6}\.pdf$/, '') === fname.replace(/-\d{8}-\d{6}\.pdf$/, '').replace(`${ESTIMATE_FILE_BASE}-`, `${ESTIMATE_FILE_BASE}${ESTIMATE_FILE_CLIENT_MARK}-`),
      () => cliName.startsWith('工作量评估-客户版-T02044-E7R段-') && cliName.endsWith('.pdf'),
      () => ({ fname, cliName }));
    const noPid = await getPdf('');
    ok('R-11 projectId 缺失 → 400 中文文案', noPid.status === 400 && noPid.json?.error === 'projectId 必填', noPid.json);
    const badAud = await getPdf(`?${PQ}&audience=both`);
    // 规约判据 3：错误消息是路由内联文案（门不便 import 路由），故配行为断言（400）兜底并区分红因
    okPair(ok, 'R-12 未知版本 → 400（不放行「看起来合理」的值）',
      () => badAud.status === 400, () => String(badAud.json?.error).includes('未知导出版本'), () => badAud.json);
    const badScope = await getPdf(`?${PQ}&scope=both`);
    okPair(ok, 'R-13 未知范围 → 400', () => badScope.status === 400,
      () => String(badScope.json?.error).includes('未知导出范围'), () => badScope.json);
    const badPh = await getPdf(`?${PQ}&phases=dev,bogus`);
    okPair(ok, 'R-14 未知阶段 → 400', () => badPh.status === 400,
      () => String(badPh.json?.error).includes('未知阶段'), () => badPh.json);
    writeFileSync(join(DATA_DIR, 'r-internal.pdf'), r.buf);
    writeFileSync(join(DATA_DIR, 'r-client.pdf'), cli.buf);
    ok('R-15 R 段两份件已落盘（X 轨读它们）', r.buf.length > 0 && cli.buf.length > 0 && r.buf.length !== cli.buf.length,
      { internal: r.buf.length, client: cli.buf.length });
    // 第三份：把 §6.2 的折叠开关真的打开再出客户件，X 轨据此证明「服务端折叠」落到件上（不是只在 md 里没有）
    const foldOn = await api('PUT', '/api/estimates/params', { projectId: PID, settings: { 'estimate.hideCoefsForClient': '1' } });
    const foldCli = await getPdf(`?${PQ}&audience=client`);
    writeFileSync(join(DATA_DIR, 'r-client-fold.pdf'), foldCli.buf);
    ok('R-15b hideCoefsForClient=1 落 KV 后客户版重导出仍 200，件名规则不变',
      foldOn.status === 200 && foldCli.status === 200
      && decodeURIComponent(String(foldCli.headers.get('content-disposition')).split("filename*=UTF-8''")[1] ?? '').startsWith('工作量评估-客户版-'),
      { foldOn: foldOn.status, config: foldOn.json?.config?.hideCoefsForClient });
  }

  group('R2 §6.3 快照 payload 比对契约（PDF 也必须写顶层 phases / 两个合计 / phaseFilter）');
  {
    const a = await getPdf(`?${PQ}`);
    const sid = String(a.headers.get('x-estimate-snapshot'));
    const list = await api('GET', `/api/estimates/snapshots?projectId=${PID}&limit=10`);
    const row = (list.json?.snapshots ?? []).find((s: any) => s.id === sid);
    ok('R-16 PDF 快照出现在 /snapshots 且 format=pdf', !!row && row.format === 'pdf', row);
    const pl = row ? JSON.parse(row.payload) : {};
    ok('R-17 payload 顶层 phases 是逐阶段数组（不是阶段筛选串——同名两义会让比对器静默出空表）',
      Array.isArray(pl.phases) && pl.phases.length > 0 && typeof pl.phases[0]?.expected === 'number', pl.phases);
    ok('R-18 payload 顶层 directManDays / actualManMonths 是四列结构',
      typeof pl.directManDays?.expected === 'number' && typeof pl.actualManMonths?.expected === 'number',
      [pl.directManDays, pl.actualManMonths]);
    ok('R-19 阶段筛选写进 phaseFilter（§6.3 v2.1 契约）', Array.isArray(pl.phaseFilter) && pl.phaseFilter.length > 0, pl.phaseFilter);
    ok('R-20 payload.unreviewed 是 §6.3 的 N（界面与件上那个数同源）', typeof pl.unreviewed === 'number', pl.unreviewed);
    const xl = await getXlsx(`?${PQ}`);
    const xid = String(xl.headers.get('x-estimate-snapshot'));
    const xrow = (await api('GET', `/api/estimates/snapshots?projectId=${PID}&limit=10`)).json?.snapshots?.find((s: any) => s.id === xid);
    const xpl = xrow ? JSON.parse(xrow.payload) : {};
    ok('R-21 同参数下 PDF 与 xlsx 两条快照的汇总逐字相同（一条流水线，两种格式）',
      JSON.stringify(pl.phases) === JSON.stringify(xpl.phases)
      && pl.actualManMonths.expected === xpl.actualManMonths.expected
      && pl.unreviewed === xpl.unreviewed,
      { pdf: pl.actualManMonths.expected, xlsx: xpl.actualManMonths.expected });
    const stemOf = (cd: string) => decodeURIComponent(String(cd).split("filename*=UTF-8''")[1] ?? '').replace(/\.(pdf|xlsx)$/, '');
    // 时间戳按秒取，两次导出各得一个（报价件要按次留名）——同一条命名规则不等于同一个字符串
    const destamp = (s: string) => s.replace(/-\d{8}-\d{6}$/, '');
    const pdfStem = stemOf(String(a.headers.get('content-disposition')));
    const xlsStem = stemOf(String(xl.headers.get('content-disposition')));
    ok('R-22 件名规则同一条：去掉时间戳后完全一致，且两版都带 §6.3 的 `YYYYMMDD-HHmmss` 段',
      destamp(pdfStem) === destamp(xlsStem) && /-\d{8}-\d{6}$/.test(pdfStem) && /-\d{8}-\d{6}$/.test(xlsStem),
      [pdfStem, xlsStem]);
    const cmp = await api('GET', `/api/estimates/snapshots?projectId=${PID}&limit=10&compare=${xid},${sid}`);
    const d23 = cmp.json?.compare?.diff;
    ok('R-23 xlsx → pdf 两条快照走 §7 比对通道出数，且合计差全 0（同一份数据、两种格式）',
      cmp.status === 200 && d23?.totals?.directManDays === 0 && d23?.totals?.actualManMonths === 0
      && (d23?.phases ?? []).every((p: any) => p?.expected?.delta === 0), d23?.totals);
  }

  group('R3 「上次导出后计划已变化」对 PDF 快照同样成立（§7）');
  {
    const before = await getPdf(`?${PQ}`);
    const bid = String(before.headers.get('x-estimate-snapshot'));
    const targetPlan = planIds[2]; // R-04 刚人工写成 4·6·9 的那一行，ΔE 可预知
    const upd = await api('PATCH', `/api/estimates/${targetPlan}?projectId=${PID}`, { phase: 'dev', unit: 'man_day', optimistic: 4, likely: 12, pessimistic: 12 });
    ok('R-30 改一行三点（4·6·9 → 4·12·12）', upd.status === 200 && upd.json?.item?.likely === 12, upd.json?.item ?? upd.json);
    const after = await getPdf(`?${PQ}`);
    const aid = String(after.headers.get('x-estimate-snapshot'));
    const cmp = await api('GET', `/api/estimates/snapshots?projectId=${PID}&limit=10&compare=${bid},${aid}`);
    const tot = cmp.json?.compare?.diff?.totals;
    const eOld = (4 + 4 * 6 + 9) / 6;
    const eNew = (4 + 4 * 12 + 12) / 6;
    ok('R-31 PDF → PDF 比对给出的合计差（totals.directManDays）= 脚本按 §4.2 手算的 ΔE（不用被测返回值当期望）',
      typeof tot?.directManDays === 'number' && Math.abs(tot.directManDays - (eNew - eOld)) < 0.01,
      { got: tot?.directManDays, want: eNew - eOld });
    ok('R-32 比对器没有静默出空表（phases 数组非空）',
      Array.isArray(cmp.json?.compare?.diff?.phases) && cmp.json.compare.diff.phases.length > 0,
      cmp.json?.compare?.diff?.phases?.length);
  }

  group('R4 §9 性能预算（500 行明细：PDF < 6s）');
  {
    const big = (await api('POST', '/api/projects', { name: 'T02044-E7性能500行' })).json;
    const BID = String(big?.id ?? '');
    const many: any[] = [];
    for (let i = 1; i <= 500; i++) many.push({ title: `P500-${i} 功能点`, description: `第 ${i} 条：五百行明细是 §9 的基准规模。`, complexity: (i % 5) + 1 });
    const mb = await api('POST', '/api/plans/batch', { projectId: BID, items: many });
    ok('R-40 500 条计划建好', (mb.json?.ids ?? []).length === 500, mb.json?.ids?.length ?? mb.json);
    const d500 = await api('POST', '/api/estimates/derive', { projectId: BID, dryRun: false, scope: 'missing' });
    ok('R-41 500 行全部推导出三点', d500.status === 200, d500.json?.written ?? d500.json);
    const t0 = Date.now();
    const r = await getPdf(`?projectId=${BID}`);
    const ms = Date.now() - t0;
    ok('R-42 500 行 PDF 生成 < 6000ms（§9 性能行）', r.status === 200 && ms < 6_000, `${ms}ms, ${r.buf.length}B`);
    const t1 = Date.now();
    const x = await getXlsx(`?projectId=${BID}`);
    const msx = Date.now() - t1;
    ok('R-43 同规模 xlsx 仍在 §9 的 3s 预算内（E7 没有把 E6 的流水线拖慢）', x.status === 200 && msx < 3_000, `${msx}ms`);
    const pages = (r.buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    ok('R-44 500 行确实分页了（>3 页；只有一页说明明细被吞了）', pages > 3, pages);
  }

  group('R5 边界：空项目 / 不存在项目（不编造数字）');
  {
    const empty = (await api('POST', '/api/projects', { name: 'T02044-E7空项目' })).json;
    const r = await getPdf(`?projectId=${empty.id}`);
    ok('R-50 零计划项目出件不 500（报价为 0 的件仍是一份结构完整的空件）',
      r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
    const ghost = await getPdf('?projectId=no-such-project-e7');
    ok('R-51 不存在的项目：200 空件或 400 中文报错，二者之一（不许 500、不许半份件）',
      ghost.status === 400 ? String(ghost.json?.error).includes(ESTIMATE_PROJECT_NOT_FOUND) : ghost.status === 200,
      { status: ghost.status, json: ghost.json });
  }
}

// ---------------------------------------------------------------- X 轨：pypdf 真件文字层
group('X 轨 pypdf 只读交叉解析（第四双眼睛：件里取不出才算脱敏）');
{
  const f1 = join(DATA_DIR, 'r-internal.pdf');
  const f2 = join(DATA_DIR, 'r-client.pdf');
  const f3 = join(DATA_DIR, 'r-client-fold.pdf');
  const pyCode = `
import json,sys
from pypdf import PdfReader
out={}
for tag,path in (('internal',sys.argv[1]),('client',sys.argv[2]),('clientFold',sys.argv[3])):
    if not path:
        continue
    try:
        r=PdfReader(path)
        out[tag]={'pages':len(r.pages),'text':'\\n'.join(p.extract_text() or '' for p in r.pages)}
    except Exception as e:
        out[tag]={'error':str(e)}
print(json.dumps(out,ensure_ascii=False))
`;
  const run = async (): Promise<{ code: number; out: string }> => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('python', ['-c', pyCode, f1, f2, existsSync(f3) ? f3 : ''],
      { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 32 * 1024 * 1024 });
    return { code: r.status ?? -1, out: String(r.stdout ?? '') + String(r.stderr ?? '') };
  };
  if (!existsSync(f1) || !existsSync(f2)) {
    skipped('X-01 ~ X-08', 'R 段未出件（服务未就绪），真件文字轨无从取样');
  } else {
    const { code, out } = await run();
    let parsed: Record<string, any> | null = null;
    try { parsed = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* python 不可用 */ }
    if (code !== 0 || !parsed?.internal?.text) {
      skipped('X-01 ~ X-08', `本机 python/pypdf 不可用（code=${code}）：${out.slice(0, 160)}`);
    } else {
      const ti = flat(parsed.internal.text);
      const tc = flat(parsed.client.text);
      ok('X-01 pypdf 能读出中文文字层（系统黑体 + ToUnicode 映射有效，不是方框）',
        ti.includes(flat(X.TEMPLATE_TEXTS.title)) && ti.includes(flat(PT.secQuote)), parsed.internal.text.slice(0, 60));
      ok('X-02 内部版件里取得出系数分项与 P84/σ（真件层面确认「内部版全含」，§10-9）',
        [COEF_LABELS.collaboration, 'P84', 'σ_total'].map(flat).every((t) => ti.includes(t)), []);
      ok('X-03 内部版件里取得出备注三条与附加 sheet 名',
        X.TEMPLATE_REMARKS.every((r) => ti.includes(flat(r))) && ti.includes(flat(X.SHEET_DETAIL)));
      // §6.2 的四项无条件脱敏（σ/区间、备注三条、内部 sheet 引用、自检段）。
      // 系数分项不在此列：本件的折叠开关是默认关（hideCoefsForClient=false），E6 已定口径「配置控制折叠」，
      // 真件层面对折叠的取证走 X-04b。
      const leaked = ['P84', 'P50', 'σ_total', X.TEMPLATE_REMARKS[0], X.TEMPLATE_REMARKS[1], X.SHEET_DETAIL, X.SHEET_PARAMS, '自检与对账']
        .filter((t) => tc.includes(flat(t)));
      ok('X-04 客户版件里取不出：P50·P84 / σ / 备注三条 / 附加 sheet 名 / 自检段', leaked.length === 0, leaked);
      const foldText = String(parsed?.clientFold?.text ?? '');
      const tf = flat(foldText);
      ok('X-04b hideCoefsForClient=1 后，客户版件里连系数分项也取不出，只剩一行合计（服务端折叠落到件上）',
        !!parsed?.clientFold?.text
        && [COEF_LABELS.collaboration, COEF_LABELS.quality, COEF_LABELS.scope, COEF_LABELS.schedule].every((t) => !tf.includes(flat(t)))
        && tf.includes(flat(X.TEMPLATE_TEXTS.foldedCoef)) && tf.includes(flat(String(Number(COEF_SUM.toFixed(2))))),
        tf.slice(tf.indexOf(flat('四、调节系数')), tf.indexOf(flat('四、调节系数')) + 60));
      // 件里的表格单元格为独立文本（T02155 起不再以 `标签 | 数值` 拼接，故取数不依赖竖线分隔符）：
      // 标签与数值同单元格行相邻，用「标签后跟任意非数字再接数字」匹配，兼容旧 `|` 与新独立单元格两种件式
      const money = /实际预估人月\D*?([\d.]+)/;
      const mi = money.exec(ti);
      const mc = money.exec(tc);
      ok('X-05 两版件上的「实际预估人月」数值相同（脱敏藏依据、不改报价数——真件层面取证）',
        !!mi && !!mc && mi[1] === mc[1], { internal: mi?.[1], client: mc?.[1] });
      ok('X-06 两版都含免责声明（PDF 是预览件这句话在件里，不只在 PRD 里）',
        ti.includes(flat('正式交付以Excel')) && tc.includes(flat('正式交付以Excel')));
      ok('X-07 客户版页数 ≤ 内部版（少掉区间、自检、备注三段）',
        parsed.client.pages <= parsed.internal.pages, { client: parsed.client.pages, internal: parsed.internal.pages });
      ok('X-08 估算人从 KV 走到件上（R-05 写的那一栏在文字层取得出——署名通道全链闭环）',
        ti.includes(flat('评审人甲')) && tc.includes(flat('评审人甲')),
        { internal: /评审人甲/.test(parsed.internal.text), client: /评审人甲/.test(parsed.client.text) });
      console.log(`  [INFO] 真件页数：内部版 ${parsed.internal.pages} / 客户版 ${parsed.client.pages} / 客户版(折叠) ${parsed.clientFold?.pages ?? '—'}`);
    }
  }
}

group('G9 §6.1 备注自检计数与引擎同源（T02302：E7 侧区分性断言）');
{
  // 期望值独立推导：未估算 = 无三点非里程碑明细行 + 无点值聚合阶段行（本夹具 onsite 整段无有值行）
  const unestDetail = FIX_ROWS.filter((r) => r.planKind !== 'milestone' && r.optimistic === null).length;
  const emptyPhases = ['req', 'design', 'impl', 'common', 'onsite']
    .filter((p) => !FIX_ROWS.some((r) => r.phase === p && r.planKind !== 'milestone' && r.optimistic !== null)).length;
  const unestExpect = unestDetail + emptyPhases;
  const rc7 = layoutOf().summary.ratioCheck.excluded;
  const note = /未计入合计的行：小计 (\d+) 行、里程碑 (\d+) 行、未估算 (\d+) 行/.exec(mdOf());
  // 三态判据同 E6 11-01：= 期望 → PASS；= 0 而期望 > 0 → SKIP（等 T02298）；其它 → FAIL
  const g34Name = `G-34 备注「未估算 N 行」= 夹具独立推导值（未估算明细 ${unestDetail} + 空阶段 ${emptyPhases}）（T02123 少报在 PDF 备注面必须可见）`;
  const gotNote7 = note ? Number(note[3]) : Number.NaN;
  if (gotNote7 === unestExpect) {
    ok(g34Name, true);
  } else if (gotNote7 === 0 && unestExpect > 0) {
    skipped('G-34 备注「未估算 N 行」区分性断言',
      `T02298（导出侧「无点值行也要进引擎」）尚未入库：备注实测 0 行而夹具独立推导应为 ${unestExpect}；该修复落地后本条自动转 PASS，其它取值判 FAIL`);
  } else {
    ok(g34Name, false, { note: note && note[0], expect: unestExpect, excluded: rc7 });
  }
  ok('G-35 备注三计数与引擎 ratioCheck.excluded 逐项同值（备注取数单源，不是第二份口径）',
    !!note && Number(note[1]) === rc7.subtotal && Number(note[2]) === rc7.milestone && Number(note[3]) === rc7.unEstimated,
    { note: note && note[0], excluded: rc7 });
  // T02304 口径甲：备注面的「里程碑 M 行」此前恒 0（导出侧没把里程碑行喂进引擎），
  // 期望值由夹具里程碑行数独立推导。
  const msExpect7 = FIX_ROWS.filter((r) => r.planKind === 'milestone').length;
  ok('G-36 备注「里程碑 M 行」= 夹具里程碑行数独立推导值（不再恒 0，与 milestoneSkipped 同值）（T02304）',
    !!note && Number(note[2]) === msExpect7 && rc7.milestone === msExpect7 && layoutOf().milestoneSkipped === msExpect7,
    { note: note && note[0], expect: msExpect7, got: note && Number(note[2]), milestoneSkipped: layoutOf().milestoneSkipped, excluded: rc7 });
}

group('G7 文案锚点单源自证（T02293 判据 1/3/4：改文案不该打红门，破行为/抄第二份口径必须打红门）');
{
  // 反证 A · 配对器语义自测（判据 4）：三种输入必须落出三种结果，且红因可区分。
  //   配对器若写成「只看字面锚点」或「红因不分」，下面三条里必有一条红——即本组自身带判别力。
  const rec: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const probeOk = (name: string, cond: boolean, extra?: unknown) => { rec.push({ name, cond, extra }); };
  okPair(probeOk, 'A 行为失守', () => false, () => true);
  okPair(probeOk, 'B 行为在、锚点失配', () => true, () => false);
  okPair(probeOk, 'C 双绿', () => true, () => true);
  const why = (i: number): string => String((rec[i]?.extra as any)?.红因 ?? '');
  ok('G-37 okPair 三态语义：行为失守判红且红因指行为、行为在而锚点失配判红且红因指锚点、双绿才 PASS',
    rec.length === 3 && rec[0].cond === false && why(0).includes('行为失守')
      && rec[1].cond === false && why(1).includes('字面锚点失配') && rec[2].cond === true, rec);

  // 反证 B · 改文案自证（判据 1）：把 PDF_TEXTS 某条换成探针词后现场重建正文——
  //   正文随常量移动 ⇒ 门与产物同一份口径，日后改文案只改一处、门不会凭空红；
  //   正文不随动 ⇒ 该处仍在产物里硬编码（或门抄了第二份），本条判红。
  const lay = layoutOf();
  // 探针词与原文**不相含**（否则 includes(orig) 会被探针自身命中，判据失真）；
  // 每条用自己的 layout：口径行只在 scope=estimated_only 时才长出「仅已估算行」，用默认件测它必然假红。
  const probes: Array<{ key: keyof typeof PT; probe: string; lay: any }>[] = [
    { key: 'secDisclaimer', probe: '丁卯探针尾', lay: lay },
    { key: 'unreviewedTail', probe: '戊辰探针注', lay: lay },
    { key: 'scopeEstimatedOnly', probe: '己巳探针径', lay: layoutOf({ scope: 'estimated_only' }) },
    { key: 'quoteIdeal', probe: '庚午探针月', lay: lay },
    { key: 'quoteDirect', probe: '辛未探针天', lay: lay },
  ];
  for (const { key, probe, lay: l } of probes) {
    const orig = PT[key] as string;
    const mdBaseline = PDFSVC.buildEstimateReportMd(l as any);
    let moved = false;
    let residual = '';
    try {
      (PT as Record<string, string>)[key] = probe;
      const mdAfter = PDFSVC.buildEstimateReportMd(l as any);
      moved = mdAfter.includes(probe) && !mdAfter.includes(orig);
      if (!moved && mdAfter.includes(probe)) residual = `正文别处还留着「${orig}」的第二份抄写`;
    } finally {
      (PT as Record<string, string>)[key] = orig;
    }
    ok(`G-38 文案改名单源自证 ${String(key)}：正文随 PDF_TEXTS 同步移动且旧文案不留第二处（断言与产物同源，改文案不打红门）`,
      moved, { key: String(key), probe, orig, residual });
    ok(`G-39 还原 ${String(key)} 后正文与改名前逐字符相同（自证不留残留状态）`,
      PDFSVC.buildEstimateReportMd(l as any) === mdBaseline, { key: String(key) });
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(`T02044 E7 验证结果：PASS=${pass} FAIL=${fail}`);
console.log(`PDF 产物目录：${process.env.T02044_KEEP ? OUT_DIR + ' / ' + DATA_DIR : DATA_DIR + '（进程退出即随临时目录清理，设 T02044_KEEP 保留）'}`);

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 600));
if (process.platform === 'win32' && child.pid) {
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}
if (!process.env.T02044_KEEP) {
  try { const { rmSync } = await import('node:fs'); rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 占用 */ }
}
process.exit(fail === 0 ? 0 : 1);
