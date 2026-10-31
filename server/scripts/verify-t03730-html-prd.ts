/**
 * T03730：HTML 版 PRD → 层级 Markdown 的进程内断言（零数据库、零端口、零 AI 调用）。
 *
 * 覆盖四类典型来源（Confluence 导出 / 内部 Wiki / 浏览器另存网页 / 不规范 HTML）+ 空壳页报错
 * + 非 HTML 分派回归（题面约束①：不得破坏既有导入流程）。
 * 运行：node node_modules/tsx/dist/cli.mjs server/scripts/verify-t03730-html-prd.ts
 */
import * as fs from 'node:fs';
process.env.MTask_DATA_DIR = fs.mkdtempSync('D:/tmp/t03730-');
process.env.MTask_PORT = '0';

import { htmlToMarkdown, decodeHtmlBuffer } from '../src/services/htmlDoc';
import { PlanService } from '../src/services/PlanService';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail)); }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const attempt = <T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } => {
  try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; }
};

// ---------- ① Confluence 导出：wiki-content 包裹 + 标题层级 + 嵌套列表 + 表格 ----------
const confluence = `<html><head><title>支付中心 PRD - Confluence</title>
<meta charset="utf-8"><style>.wiki-content{color:red}</style></head>
<body><div id="main-content" class="wiki-content">
<h1>支付中心 PRD</h1>
<h2>1 背景</h2><p>现有支付链路不支持退款，需要对账与资金流。<br>补充：退款需二次确认。</p>
<h2>2 需求</h2>
<ul><li>支持退款<ul><li>全额退款</li><li>部分退款</li></ul></li><li>退款进度可查</li></ul>
<table class="confluenceTable"><tbody>
<tr><th>编号</th><th>需求</th><th>优先级</th></tr>
<tr><td>REQ-001</td><td>发起退款</td><td>P0</td></tr>
<tr><td>REQ-002</td><td>查询退款</td><td>P1</td></tr>
</tbody></table>
<ac:structured-macro><p>宏内正文也要保留</p></ac:structured-macro>
</div></body></html>`;
const r1 = attempt(() => htmlToMarkdown(confluence));
check('C1 Confluence 导出可解析', r1.ok, r1.ok ? r1.value.stats : r1);
if (r1.ok) {
  const md = r1.value.markdown;
  check('C1 页面标题进入首行（且与同名一级标题不重复）', md.startsWith('# 支付中心 PRD') && (md.match(/^# 支付中心 PRD$/gm) ?? []).length === 1, md.split('\n').slice(0, 3));
  check('C1 h2 转二级标题', md.includes('## 1 背景') && md.includes('## 2 需求'));
  check('C1 段落 <br> 保留为换行', md.includes('现有支付链路不支持退款，需要对账与资金流。\n补充：退款需二次确认。'));
  check('C1 嵌套列表保留缩进层级', md.includes('- 支持退款\n  - 全额退款\n  - 部分退款') && md.includes('- 退款进度可查'));
  check('C1 表格转「单元格 | 单元格」', md.includes('编号 | 需求 | 优先级') && md.includes('REQ-001 | 发起退款 | P0'));
  check('C1 自定义命名空间标签内的正文不丢', md.includes('宏内正文也要保留'));
  check('C1 style 内联样式不进正文', !md.includes('color:red'));
  check('C1 统计口径（标题数/表格行数）', r1.value.stats.headings === 3 && r1.value.stats.tableRows === 3, r1.value.stats);
}

// ---------- ② 内部 Wiki：dl/dt/dd + 内联标签 + HTML 实体 ----------
const wiki = `<html><body><h2>范围</h2>
<p>本次<b>不做</b>&nbsp;国际化 &amp; 多语言，仅覆盖&ldquo;境内&rdquo;场景。</p>
<dl><dt>术语</dt><dd>解释说明</dd></dl>
<ol><li>第一步</li><li>第二步</li></ol></body></html>`;
const r2 = attempt(() => htmlToMarkdown(wiki));
check('W1 Wiki 风格可解析', r2.ok, r2.ok ? r2.value.stats : r2);
if (r2.ok) {
  const md = r2.value.markdown;
  check('W1 实体解码 + 空白归一 + 内联标签展开', md.includes('本次不做 国际化 & 多语言，仅覆盖“境内”场景。'));
  check('W1 dt/dd 转条目 + 缩进说明', md.includes('- 术语\n  解释说明'));
  check('W1 有序列表带序号', md.includes('1. 第一步') && md.includes('2. 第二步'));
}

// ---------- ③ 浏览器另存网页：脚本/样式剔除，图片说明与跳过项必须告警 ----------
const savedPage = `<HTML><HEAD><TITLE>需求说明书</TITLE>
<SCRIPT>var a = 1 < 2 && x > 3; document.write('<p>脚本生成的假正文</p>');</SCRIPT>
<STYLE>.x{display:none}</STYLE></HEAD>
<BODY><NAV>首页 &gt; 文档中心</NAV>
<H1>需求说明书</H1><P>这里是真正的正文内容，足够长以避免空壳判定的误伤。</P>
<IFRAME src="https://example.com/embed"></IFRAME>
<IMG alt="系统架构图"><IMG src="logo.png">
</BODY></HTML>`;
const r3 = attempt(() => htmlToMarkdown(savedPage));
check('P1 另存网页可解析', r3.ok, r3.ok ? r3.value.stats : r3);
if (r3.ok) {
  const md = r3.value.markdown;
  check('P1 脚本内容不进正文（含脚本里的伪标签）', !md.includes('var a') && !md.includes('脚本生成的假正文'));
  check('P1 样式不进正文', !md.includes('display:none'));
  check('P1 导航面包屑正文保留', md.includes('首页 > 文档中心'));
  check('P1 图片说明（alt）保留', md.includes('[图片：系统架构图]'));
  check('P1 跳过项必须告警（iframe + 无 alt 图片）',
    r3.value.warnings.some((w) => w.includes('<iframe>')) && r3.value.warnings.some((w) => w.includes('替代文本')),
    r3.value.warnings);
}

// ---------- ④ 不规范 HTML：不闭合标签 / 大写标签 / 裸 `<` / 裸值属性 ----------
const messy = `<H2 CLASS=t>第一章 需求</H2><P>段落一
<P>段落二<ul><LI>甲<LI>乙</ul>
<p>技术约束：响应时间 a < b 且内存 c > d，均需满足。
<p>链接到 <A HREF=https://ex.com/doc>文档</A> 与 <A HREF=https://ex.com/x></A>`;
const r4 = attempt(() => htmlToMarkdown(messy));
check('M1 不规范 HTML 可解析（不抛错）', r4.ok, r4.ok ? r4.value.stats : r4);
if (r4.ok) {
  const md = r4.value.markdown;
  check('M1 未闭合段落与列表都落到正文', md.includes('段落一') && md.includes('段落二') && md.includes('- 甲') && md.includes('- 乙'));
  check('M1 正文里的裸 `<` 不吞字', md.includes('a < b 且内存 c > d'));
  check('M1 链接文字保留、空锚点补 href', md.includes('文档') && md.includes('[链接：https://ex.com/x]'));
}

// ---------- ⑤ 空壳页（JS 动态渲染）必须报可操作的错，而不是返回空串 ----------
const shell = `<html><head><title>SPA 文档</title><script src="app.js"></script></head><body><div id="app"></div></body></html>`;
const r5 = attempt(() => htmlToMarkdown(shell));
check('E1 空壳页抛错而非静默返回空串', !r5.ok && /未提取到可读正文/.test(r5.error) && /JavaScript/.test(r5.error), r5);

// ---------- ⑥ 编码声明：GBK 页面按声明解码，不整页乱码 ----------
const gbkHtml = Buffer.concat([
  Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'latin1'),
  Buffer.from([0xd0, 0xe8, 0xc7, 0xf3]), // 「需求」的 GB2312/GBK 双字节
  Buffer.from('</p></body></html>', 'latin1'),
]);
const decoded = attempt(() => decodeHtmlBuffer(gbkHtml));
check('G1 meta charset=gbk 的字节流按声明解码', decoded.ok && decoded.value.includes('需求'), decoded.ok ? decoded.value.slice(0, 60) : decoded);

// ---------- ⑦ 病态输入与规模：不得回溯成平方级（曾考虑用 `<(a|b)>[\s\S]*?</\1>` 整篇预扫） ----------
const pathological = '<p>正文开头足够长的一段话，用于凑够正文下限。</p>' + '<svg>'.repeat(20000) + '<p>尾部正文</p>';
const t0 = Date.now();
const r8 = attempt(() => htmlToMarkdown(pathological));
const costMs = Date.now() - t0;
check('S1 2 万个未闭合 <svg> 线性完成（<3s，不栈溢出不挂死）', costMs < 3000 && r8.ok, { ms: costMs, ok: r8.ok });
check('S1 连续跳过区按 1 处记账（后续 <svg> 都在跳过区内，不重复计）', r8.ok && r8.value.stats.skipped === 1, r8.ok ? r8.value.stats : r8);

const big = `<html><body>${Array.from({ length: 3000 }, (_, i) => `<h3>章节 ${i}</h3><p>这是第 ${i} 段正文内容，用于规模验证。</p>`).join('')}</body></html>`;
const t1 = Date.now();
const r9 = attempt(() => htmlToMarkdown(big));
const bigMs = Date.now() - t1;
check('S2 3000 节文档线性完成（<5s，内容不丢）', r9.ok && bigMs < 5000 && r9.value.markdown.includes('章节 2999'), { ms: bigMs, blocks: r9.ok ? r9.value.stats.blocks : r9 });

// ---------- ⑧ 非 HTML 流程回归（约束①）：既有分派一字不改 ----------
(async () => {
  const mdIn = '# 标题\n\n正文内容';
  const mdOut = await PlanService.extractPrdText(Buffer.from(mdIn, 'utf-8'), 'prd.md');
  check('R1 .md 原样透传（零改动）', mdOut === mdIn);
  const txtIn = '纯文本需求，第一行。\n第二行。';
  const txtOut = await PlanService.extractPrdText(Buffer.from(txtIn, 'utf-8'), 'prd.txt');
  check('R2 .txt 原样透传（零改动）', txtOut === txtIn);

  const detailed = await PlanService.extractPrdTextDetailed(Buffer.from(confluence, 'utf-8'), 'prd.HTML');
  const expectedMd = r1.ok ? r1.value.markdown : '';
  check('R3 .HTML 扩展名大小写不敏感且走同一转换器', Boolean(expectedMd) && detailed.text === expectedMd);
  const plain = await PlanService.extractPrdText(Buffer.from(confluence, 'utf-8'), 'prd.html');
  check('R4 extractPrdText 与 detailed 同源（文本逐字一致）', plain === detailed.text);
  check('R5 非 HTML 分支不带告警噪声', (await PlanService.extractPrdTextDetailed(Buffer.from(mdIn, 'utf-8'), 'a.md')).warnings.length === 0);

  const docErr = await PlanService.extractPrdText(Buffer.from('x'), 'old.doc').then(() => '').catch((e: Error) => e.message);
  check('R6 老式 .doc 仍给出原有友好提示', docErr.includes('另存为 .docx'), docErr);
  const rtfErr = await PlanService.extractPrdText(Buffer.from('x'), 'a.rtf').then(() => '').catch((e: Error) => e.message);
  check('R7 不支持格式的提示已列出 .html/.htm', rtfErr.includes('.html') && rtfErr.includes('.htm'), rtfErr);

  console.log(`\nT03730 HTML PRD 验证：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
