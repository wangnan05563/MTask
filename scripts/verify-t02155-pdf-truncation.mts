/**
 * T02155 第二轮复验（针对 2026-10-15 的【验证失败】反馈：「内部版本 PDF 存在截断问题，且缺少帕累托、龙卷风图」）。
 *
 * 三件事分别对应反馈的三个字：
 *  A 轨 几何不越页：pdfkit 的 `rect/moveTo/lineTo/circle` **不会自动换页**（只有 `text()` 会），
 *    修复前图表整块画到页底以下 → PDF 用户坐标里出现负的 y（横向则是列宽之和超页宽）。
 *    本轨把两份真件的 `re` 绘制指令逐条取出来，断言全部落在 MediaBox 内 —— 越页一画就红。
 *  B 轨 图在件上（去「缺图」）：帕累托内部版/客户版都要有；龙卷风**只在内部版**
 *    （§6.2 客户版隐藏 σ，连标题文字都不许进文本层，否则 X-04 脱敏门被自己的新图打穿）。
 *  C 轨 标题与图体同页（去「截断」的另一种形态）：标题在最后一页、图体在下一页 = 读者看到的仍是半张图。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02155-pdf-truncation.mts
 * 环境变量：T02155_KEEP=1 保留产物目录（默认写系统临时目录并打印路径）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02155-trunc-'));

const E = await import('../server/src/services/estimate-engine.ts');
const X = await import('../server/src/services/estimateExportXlsx.ts');
const PDFSVC = await import('../server/src/services/estimateExportPdf.ts');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
};

const CFG = { ...E.DEFAULT_ESTIMATE_CONFIG, hideCoefsForClient: true };

/** 夹具：行数刻意给多（40 行 + 1 里程碑），把明细表推到后页，图表正好落在页底附近——复现原缺陷的条件 */
const mkRow = (i: number, phase: string): any => {
  const o = 2 + (i % 5);
  const l = o + 3 + (i % 3);
  return {
    planId: `r-${phase}-${i}`,
    title: `功能单元${phase}-${i}（标题稍长以测试列宽摊薄与换行，不写死短标题）`,
    detail: `第 ${i} 条：需求描述要压平成一行，D 列不吃换行；含竖线 a|b 也必须被转义为纯文本。`,
    phase,
    planKind: 'normal',
    milestone: `M${(i % 3) + 1} 里程碑`,
    optimistic: o,
    likely: l,
    pessimistic: l + 4 + (i % 2),
    source: i % 4 === 0 ? 'rule' : 'manual',
    complexity: (i % 5) + 1,
    reqNos: [`R${100 + i}`],
  };
};
const ROWS: any[] = [
  ...['M1 平台基座', 'M2 交付件', 'M3 验收'].map((t, i) => ({
    planId: `r-ms-${i}`, title: t, detail: t, phase: 'dev', planKind: 'milestone',
    milestone: '', optimistic: null, likely: null, pessimistic: null, source: '', complexity: null, reqNos: [],
  })),
  ...Array.from({ length: 10 }, (_, i) => mkRow(i + 1, 'req')),
  ...Array.from({ length: 8 }, (_, i) => mkRow(i + 1, 'design')),
  ...Array.from({ length: 14 }, (_, i) => mkRow(i + 1, 'dev')),
  ...Array.from({ length: 5 }, (_, i) => mkRow(i + 1, 'impl')),
  ...Array.from({ length: 3 }, (_, i) => mkRow(i + 1, 'common')),
];

const layoutOf = (audience: 'internal' | 'client') =>
  X.layoutEstimate({
    projectId: 'p-t02155',
    projectName: 'T02155截断复验',
    estimateDate: '2026-10-15',
    reviewer: '王南',
    rows: ROWS,
    config: CFG,
    scope: 'all',
    audience,
    generatedAt: '2026-10-15T09:00:00.000Z',
  } as any);

console.log(`\n== 生成真件（产物目录 ${DATA_DIR}）`);
const intLayout = layoutOf('internal');
const cliLayout = layoutOf('client');
const intBuf = await PDFSVC.buildEstimatePdf(intLayout);
const cliBuf = await PDFSVC.buildEstimatePdf(cliLayout);
const fInt = join(DATA_DIR, 'internal.pdf');
const fCli = join(DATA_DIR, 'client.pdf');
writeFileSync(fInt, intBuf);
writeFileSync(fCli, cliBuf);
console.log(`  internal=${intBuf.length}B client=${cliBuf.length}B 明细行=${intLayout.devRows.length}`);
ok('G-00 两份真件均为 PDF 且体量合理（>4KB，排除空件假绿）',
  intBuf.subarray(0, 5).toString() === '%PDF-' && cliBuf.subarray(0, 5).toString() === '%PDF-'
  && intBuf.length > 4_000 && cliBuf.length > 4_000, [intBuf.length, cliBuf.length]);

// 负对照：复刻修复前的画法（矢量指令不做换页判定，直接画到页底以下），
// 用来证明 A 轨的越页检查不是空转——它必须在这份件上报警。
const PRD = await import('../server/src/services/prdExport.ts');
const neg = await PRD.newPdfDoc('负对照（越页绘制）');
const nd = neg.doc;
PRD.renderMdPdf(nd, '# 负对照\n\n下面故意把矩形画到页底之外（等价于修复前 drawBarChart 的行为）。');
nd.rect(nd.page.margins.left, nd.y + 900, 120, 40).fill('#0059E9');
nd.end();
await neg.done;
const fBad = join(DATA_DIR, 'negative.pdf');
writeFileSync(fBad, neg.finish());

// ------------------------------------------------------------------ python / pypdf 取证
const PY = String.raw`
import json, re, sys
from pypdf import PdfReader

def content_text(page):
    # get_contents() 对 pdfkit 的流取到空串（实测），必须按对象取原始流再 get_data() 解压。
    c = page.get('/Contents')
    if c is None:
        return ''
    obj = c
    parts = []
    items = obj if isinstance(obj, list) else [obj]
    for it in items:
        o = it.get_object()
        parts.append(o.get_data())
    return b'\n'.join(parts).decode('latin-1')

def page_checks(path):
    r = PdfReader(path)
    bad = []
    n_rect = 0
    for pi, page in enumerate(r.pages):
        mb = page.mediabox
        W = float(mb.width); H = float(mb.height)
        txt = content_text(page)
        for m in re.finditer(r'([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re', txt):
            x, y, w, h = (float(g) for g in m.groups())
            n_rect += 1
            # pdfkit 每页起手「1 0 0 -1 0 H cm」翻转 y 轴，绘制坐标是左上原点、y 向下，
            # 越下界 = y + h > H（负对照件实测 y=1027 > 841.89，正是修复前图表的画法）
            if x < -0.01 or y < -0.01 or x + w > W + 0.5 or y + h > H + 0.5:
                bad.append({'page': pi + 1, 'x': round(x, 2), 'y': round(y, 2),
                            'w': round(w, 2), 'h': round(h, 2), 'W': round(W, 1), 'H': round(H, 1)})
    texts = [(p.extract_text() or '') for p in r.pages]
    return {'pages': len(r.pages), 'bad_rects': bad[:20], 'bad_total': len(bad), 'rect_total': n_rect,
            'titles': {t: [i + 1 for i, s in enumerate(texts) if t in s]
                       for t in ['帕累托', '龙卷风', '各阶段最终估算值', '各阶段占比', '累计占比', '报价结论', 'σ_total']},
            'sigma_pages': [i + 1 for i, s in enumerate(texts) if 'σ' in s],
            'pipe_total': sum(s.count('|') for s in texts),
            'full_text_len': sum(len(s) for s in texts)}

out = {'internal': page_checks(sys.argv[1]), 'client': page_checks(sys.argv[2]),
       'negative': page_checks(sys.argv[4])}
with open(sys.argv[3], 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False))
`;
const PY_JSON = join(DATA_DIR, 'pypdf.json');
const pyOut = spawnSync('python', ['-c', PY, fInt, fCli, PY_JSON, fBad], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
const pyStderr = (pyOut.stderr ?? '').trim();
if (pyOut.status !== 0 || !existsSync(PY_JSON)) {
  console.log(`  [SKIP] python/pypdf 不可用（code=${pyOut.status}）：${pyStderr.slice(0, 200)}`);
  console.log(`\n结果：${pass} PASS / ${fail} FAIL（A/B/C 轨未取得 pypdf 证据，不能算通过）`);
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(PY_JSON, 'utf-8')) as Record<string, any>;
const INT = parsed.internal;
const CLI = parsed.client;

console.log('\n== X 轨 文字层可取（中文子集字体），后续断言的前提');
ok('X-00 内部版文字层取得出中文正文（「报价结论」「σ_total」）',
  (INT.titles['报价结论'] ?? []).length > 0 && (INT.titles['σ_total'] ?? []).length > 0, INT.titles);

console.log('\n== A 轨 绘制几何不越页');
for (const [name, p] of [['internal', INT], ['client', CLI]] as const) {
  // rect_total>0 是前置条件：内容流解析不到任何矩形时「0 处越页」是假的绿
  ok(`A-01 ${name}：内容流可解析（${p.rect_total} 条矩形指令）且全部落在页面内（越页 ${p.bad_total} 处）`,
    p.rect_total > 0 && p.bad_total === 0, [p.rect_total, p.bad_rects.slice(0, 5)]);
}
// 负对照必须报警：不报警说明 A 轨检查是空转（写了个永远为真的断言）
ok('A-02 负对照（复刻修复前的越页画法）被检出越页 —— 证明 A-01 不是空转',
  parsed.negative.bad_total > 0, parsed.negative.bad_rects);

console.log('\n== B 轨 图表补齐 + 客户版 σ 门控');
ok('B-01 内部版有帕累托图（标题出现在文字层）', (INT.titles['帕累托'] ?? []).length > 0, INT.titles);
ok('B-02 内部版有龙卷风图', (INT.titles['龙卷风'] ?? []).length > 0, INT.titles);
ok('B-03 客户版有帕累托图（不含 σ 的图，可给客户）', (CLI.titles['帕累托'] ?? []).length > 0, CLI.titles);
ok('B-04 客户版无龙卷风图（§6.2 隐藏 σ：标题文字也不进文本层）', (CLI.titles['龙卷风'] ?? []).length === 0,
  CLI.titles['龙卷风']);
ok('B-05 客户版文字层无 σ 字符（新图未打穿 E7 X-04 脱敏门）', CLI.sigma_pages.length === 0, CLI.sigma_pages);
ok('B-06 两版均有阶段柱状图两张', ['各阶段最终估算值', '各阶段占比'].every((t) => (INT.titles[t] ?? []).length > 0)
  && ['各阶段最终估算值', '各阶段占比'].every((t) => (CLI.titles[t] ?? []).length > 0), [INT.titles, CLI.titles]);

console.log('\n== C 轨 标题与图体同页 + 页数关系');
for (const [name, p] of [['internal', INT], ['client', CLI]] as const) {
  const tPages: number[] = p.titles['帕累托'] ?? [];
  const cumPages: number[] = p.titles['累计占比'] ?? [];
  ok(`C-01 ${name}：帕累托标题页与「累计占比」图例同页（无孤页标题）`,
    tPages.length > 0 && tPages.every((pg) => cumPages.includes(pg)), [tPages, cumPages]);
}
ok('C-02 客户版页数 ≤ 内部版（脱敏只减内容，E7 X-07 同口径）', CLI.pages <= INT.pages, [CLI.pages, INT.pages]);
ok('C-03 明细表文本层无裸竖线拼接残留（上轮 md 修复不回退）', INT.pipe_total === 0 && CLI.pipe_total === 0,
  [INT.pipe_total, CLI.pipe_total]);
ok('C-04 件有实质正文（文字层非空，排除渲染中断）', INT.full_text_len > 800 && CLI.full_text_len > 500,
  [INT.full_text_len, CLI.full_text_len]);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
console.log(`产物：${DATA_DIR}`);
process.exit(fail === 0 ? 0 : 1);
