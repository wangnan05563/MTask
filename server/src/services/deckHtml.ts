/**
 * 启动会 / 阶段总结的 HTML 版渲染器（2026-11-06）。
 *
 * 为什么不是「把 PPTX 的英寸坐标翻译成 px」：那只会得到一份观感相同的副本，
 * 却继承了 PPTX 的 42 字/6 条硬限制。HTML 版按**网页版式语言**重排同一份大纲与数据：
 * 1280×720 固定画布 + JS 等比缩放、键盘/滚轮/触摸/圆点四种翻页、逐页入场动画，
 * 单文件内联样式与脚本，离线双击即可放映。
 *
 * 硬约束（与 trae PPT 插件规范一致，门会逐条断言）：
 * - 画布内不出现 vw/vh/clamp，全部固定 px，缩放只由外层 transform 承担；
 * - 居中与缩放合并在**同一个元素**上，JS 重写时保留 translate(-50%,-50%)；
 * - 顶底 chrome 与圆点都在画布内、用 absolute，不用 fixed；
 * - 页切换用 opacity + visibility 过渡，不用 display 切换；
 * - 不引任何外链（字体、图片、脚本全部内联或系统自带）。
 *
 * 渲染层只认本文件里的中性模型（DeckHtmlModel），不直接依赖 kickoff/summary 的数据库结构——
 * 两个调用方各自把 bundle/deck 折成模型，渲染器保持单测友好。
 */
import { CANVAS_PX, CHROME_PX, PADDING_PX, SPACE, STATUS, TYPE, TYPE_SCALE, deckTheme, statusToneOf, type DeckTheme, type StatusTone } from './deckDesign';
import { DECK_STYLES, type DeckStyleKey } from '../util/exportStyle';

/* ------------------------------- 中性模型 ------------------------------- */

export interface DeckStat {
  label: string;
  value: string;
  hint?: string;
  tone?: StatusTone;
}

export type DeckHtmlBlock =
  | { type: 'metrics'; items: DeckStat[] }
  | { type: 'table'; columns: string[]; rows: string[][]; note?: string; statusCol?: number }
  | { type: 'list'; items: Array<{ title: string; desc?: string; tag?: string; tone?: StatusTone }> }
  | { type: 'timeline'; items: Array<{ label: string; start?: string; end?: string; progress?: number; tone?: StatusTone; milestone?: boolean }> }
  | { type: 'flow'; steps: Array<{ label: string; desc?: string }> }
  | { type: 'chips'; groups: Array<{ label: string; items: string[] }> }
  | { type: 'bars'; items: Array<{ label: string; value: number; text?: string }>; note?: string }
  | { type: 'progress'; items: Array<{ label: string; value: number; text?: string; tone?: StatusTone }> }
  | { type: 'note'; text: string };

export interface DeckHtmlPage {
  section: string;
  title: string;
  bullets: string[];
  /** 11 种版式名，与 PPTX 大纲枚举同词 */
  layout: string;
  blocks: DeckHtmlBlock[];
  /** 页脚注（数据来源/口径） */
  footnote?: string;
}

export interface DeckHtmlModel {
  kind: 'kickoff' | 'summary';
  /** 封面主标题 */
  title: string;
  /** 封面导语（一句话说清这次汇报要促成什么） */
  lead: string;
  /** 封面元信息：汇报人/周期/数据截至等 */
  meta: Array<{ label: string; value: string }>;
  pages: DeckHtmlPage[];
  /** 顶栏左侧：系列名 */
  chromeLeft: string;
  /** 顶栏右侧：年度或周期标签 */
  chromeRight: string;
  style?: DeckStyleKey;
}

/* ------------------------------- 工具 ------------------------------- */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 所有进入 HTML 的业务字符串都过这里；渲染器不接受「调用方自己记得转义」这种约定 */
export function escapeHtml(raw: unknown): string {
  return String(raw ?? '').replaceAll(/[&<>"']/g, (c) => ESC[c]);
}

const STATE_LABEL: Record<StatusTone, string> = { ok: '正常', warn: '关注', bad: '风险', neutral: '—' };

/** 状态点：颜色只承载语义，文字不省略（色盲可读） */
function toneDot(tone: StatusTone): string {
  return `<span class="dot t-${tone}" aria-hidden="true"></span>`;
}

function clampText(raw: string, max: number): string {
  const chars = [...String(raw ?? '')];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function asTextList(values: string[]): string[] {
  return values.map((v) => String(v ?? '').trim()).filter(Boolean);
}

/* ------------------------------- 版式渲染 ------------------------------- */

function pageHeader(page: DeckHtmlPage): string {
  const kicker = page.section ? `<div class="kicker anim" style="--i:0">${escapeHtml(page.section)}</div>` : '';
  return `${kicker}<h2 class="h-1 anim" style="--i:1">${escapeHtml(page.title)}</h2>`;
}

function pageFooter(page: DeckHtmlPage, idx: number, total: number): string {
  const note = page.footnote ? `<span class="foot-note">${escapeHtml(clampText(page.footnote, 90))}</span>` : '<span></span>';
  return `<div class="page-foot">${note}<span class="foot-page">${String(idx + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></div>`;
}

function bulletsBlock(bullets: string[], className = ''): string {
  const items = asTextList(bullets);
  if (!items.length) return '';
  return `<ul class="bullets ${className}">${items
    .map((b, i) => `<li class="anim" style="--i:${i + 2}"><span class="bullet-mark"></span><span>${escapeHtml(b)}</span></li>`)
    .join('')}</ul>`;
}

function metricsBlock(block: Extract<DeckHtmlBlock, { type: 'metrics' }>): string {
  if (!block.items.length) return emptyBlock('暂无指标数据');
  return `<div class="metrics">${block.items
    .map((m, i) => {
      const tone = m.tone ?? 'neutral';
      return `<div class="metric anim" style="--i:${i + 2}">
        <div class="metric-label">${escapeHtml(m.label)}</div>
        <div class="metric-value t-${tone}">${escapeHtml(m.value)}</div>
        ${m.hint ? `<div class="metric-hint">${escapeHtml(m.hint)}</div>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

function tableBlock(block: Extract<DeckHtmlBlock, { type: 'table' }>): string {
  if (!block.columns.length || !block.rows.length) return emptyBlock('暂无表格数据');
  const MAX = 8;
  const rows = block.rows.slice(0, MAX);
  const head = block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows
    .map((r, ri) => {
      const cells = block.columns
        .map((_, ci) => {
          const raw = String(r[ci] ?? '');
          const isStatus = block.statusCol === ci;
          const cell = isStatus
            ? `<td class="cell-status">${toneDot(statusToneOf(raw))}<span>${escapeHtml(clampText(raw, 16) || STATE_LABEL[statusToneOf(raw)])}</span></td>`
            : `<td>${escapeHtml(clampText(raw, 40))}</td>`;
          return cell;
        })
        .join('');
      return `<tr class="anim" style="--i:${ri + 2}">${cells}</tr>`;
    })
    .join('');
  const more = block.rows.length > MAX ? `<div class="table-more">共 ${block.rows.length} 行，此处展示前 ${MAX} 行</div>` : '';
  const note = block.note ? `<div class="table-note">${escapeHtml(block.note)}</div>` : '';
  return `<div class="table-wrap anim" style="--i:2"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}${note}</div>`;
}

function listBlock(block: Extract<DeckHtmlBlock, { type: 'list' }>): string {
  if (!block.items.length) return emptyBlock('暂无条目');
  const MAX = 6;
  const items = block.items.slice(0, MAX);
  return `<div class="list">${items
    .map((it, i) => {
      const tone = it.tone ?? 'neutral';
      return `<div class="list-row anim" style="--i:${i + 2}">
        ${toneDot(tone)}
        <div class="list-main">
          <div class="list-title">${escapeHtml(clampText(it.title, 44))}</div>
          ${it.desc ? `<div class="list-desc">${escapeHtml(clampText(it.desc, 72))}</div>` : ''}
        </div>
        ${it.tag ? `<span class="tag tag-${tone}">${escapeHtml(clampText(it.tag, 10))}</span>` : ''}
      </div>`;
    })
    .join('')}</div>${block.items.length > MAX ? `<div class="table-more">共 ${block.items.length} 条，此处展示前 ${MAX} 条</div>` : ''}`;
}

function timelineBlock(block: Extract<DeckHtmlBlock, { type: 'timeline' }>): string {
  if (!block.items.length) return emptyBlock('暂无时间线数据');
  const MAX = 7;
  const items = block.items.slice(0, MAX);
  return `<div class="timeline"><div class="tl-axis"></div><div class="tl-items">${items
    .map((it, i) => {
      const tone = it.tone ?? statusToneOf(it.progress === 100 ? 'done' : 'doing');
      const pct = Math.max(0, Math.min(100, Math.round(Number(it.progress ?? 0))));
      const range = [it.start, it.end].filter(Boolean).join(' → ');
      return `<div class="tl-item anim" style="--i:${i + 2}">
        <div class="tl-node ${it.milestone ? 'is-milestone' : ''} t-${tone}"></div>
        <div class="tl-body">
          <div class="tl-label">${escapeHtml(clampText(it.label, 28))}</div>
          ${range ? `<div class="tl-range">${escapeHtml(range)}</div>` : ''}
          <div class="tl-track"><div class="tl-fill t-${tone}" style="width:${pct}%"></div></div>
        </div>
      </div>`;
    })
    .join('')}</div></div>${block.items.length > MAX ? `<div class="table-more">共 ${block.items.length} 项，此处展示前 ${MAX} 项</div>` : ''}`;
}

function flowBlock(block: Extract<DeckHtmlBlock, { type: 'flow' }>): string {
  if (!block.steps.length) return emptyBlock('暂无流程数据');
  const MAX = 6;
  const steps = block.steps.slice(0, MAX);
  return `<div class="flow">${steps
    .map(
      (s, i) => `<div class="flow-step anim" style="--i:${i + 2}">
        <div class="flow-no">${String(i + 1).padStart(2, '0')}</div>
        <div class="flow-label">${escapeHtml(clampText(s.label, 18))}</div>
        ${s.desc ? `<div class="flow-desc">${escapeHtml(clampText(s.desc, 30))}</div>` : ''}
      </div>${i < steps.length - 1 ? '<div class="flow-arrow" aria-hidden="true"></div>' : ''}`,
    )
    .join('')}</div>`;
}

function chipsBlock(block: Extract<DeckHtmlBlock, { type: 'chips' }>): string {
  if (!block.groups.length) return emptyBlock('暂无分组数据');
  return `<div class="chips">${block.groups
    .map(
      (g, i) => `<div class="chip-group anim" style="--i:${i + 2}">
        <div class="chip-label">${escapeHtml(g.label)}</div>
        <div class="chip-items">${g.items
          .slice(0, 8)
          .map((x) => `<span class="chip">${escapeHtml(clampText(x, 16))}</span>`)
          .join('')}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function barsBlock(block: Extract<DeckHtmlBlock, { type: 'bars' }>): string {
  if (!block.items.length) return emptyBlock('暂无图表数据');
  const max = Math.max(...block.items.map((x) => Math.abs(Number(x.value) || 0)), 1);
  return `<div class="bars anim" style="--i:2">${block.items
    .map((x, i) => {
      const pct = Math.round((Math.abs(Number(x.value) || 0) / max) * 100);
      return `<div class="bar-row" style="--i:${i + 2}">
        <div class="bar-label">${escapeHtml(clampText(x.label, 16))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-value">${escapeHtml(x.text ?? String(x.value))}</div>
      </div>`;
    })
    .join('')}${block.note ? `<div class="table-note">${escapeHtml(block.note)}</div>` : ''}</div>`;
}

function progressBlock(block: Extract<DeckHtmlBlock, { type: 'progress' }>): string {
  if (!block.items.length) return emptyBlock('暂无进度数据');
  return `<div class="progress-list">${block.items
    .map((x, i) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(x.value) || 0)));
      const tone = x.tone ?? statusToneOf(pct === 100 ? 'done' : 'doing');
      return `<div class="progress-row anim" style="--i:${i + 2}">
        <div class="progress-label">${escapeHtml(clampText(x.label, 24))}</div>
        <div class="progress-track"><div class="progress-fill t-${tone}" style="width:${pct}%"></div></div>
        <div class="progress-value">${escapeHtml(x.text ?? `${pct}%`)}</div>
      </div>`;
    })
    .join('')}</div>`;
}

function noteBlock(block: Extract<DeckHtmlBlock, { type: 'note' }>): string {
  return `<p class="note anim" style="--i:2">${escapeHtml(block.text)}</p>`;
}

function emptyBlock(msg: string): string {
  return `<div class="empty anim" style="--i:2">${escapeHtml(msg)}</div>`;
}

function renderBlock(block: DeckHtmlBlock): string {
  switch (block.type) {
    case 'metrics': return metricsBlock(block);
    case 'table': return tableBlock(block);
    case 'list': return listBlock(block);
    case 'timeline': return timelineBlock(block);
    case 'flow': return flowBlock(block);
    case 'chips': return chipsBlock(block);
    case 'bars': return barsBlock(block);
    case 'progress': return progressBlock(block);
    case 'note': return noteBlock(block);
    default: return '';
  }
}

/* ------------------------------- 页面组装 ------------------------------- */

/** 结构页不参与编号目录（封面/目录/章节/致谢） */
const STRUCTURAL = new Set(['cover', 'toc', 'section', 'thanks']);

function coverPage(model: DeckHtmlModel): string {
  const meta = model.meta
    .filter((m) => m.value)
    .map((m) => `<div class="meta-item"><div class="meta-label">${escapeHtml(m.label)}</div><div class="meta-value">${escapeHtml(m.value)}</div></div>`)
    .join('');
  return `<section class="slide s-cover" data-layout="cover">
    <div class="cover-bar anim" style="--i:0"></div>
    <div class="cover-kicker anim" style="--i:1">${escapeHtml(model.chromeLeft)}</div>
    <h1 class="cover-title anim" style="--i:2">${escapeHtml(model.title)}</h1>
    <p class="cover-lead anim" style="--i:3">${escapeHtml(model.lead)}</p>
    ${meta ? `<div class="cover-meta anim" style="--i:4">${meta}</div>` : ''}
  </section>`;
}

function tocPage(page: DeckHtmlPage, model: DeckHtmlModel, idx: number, total: number): string {
  const entries: Array<{ section: string; title: string }> = [];
  for (const p of model.pages) {
    if (STRUCTURAL.has(p.layout)) continue;
    if (entries.some((e) => e.section === p.section)) continue;
    entries.push({ section: p.section || '正文', title: p.title });
  }
  const rows = entries
    .slice(0, 9)
    .map(
      (e, i) => `<div class="toc-row anim" style="--i:${i + 2}">
        <span class="toc-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="toc-sec">${escapeHtml(e.section)}</span>
        <span class="toc-dots" aria-hidden="true"></span>
        <span class="toc-title">${escapeHtml(clampText(e.title, 26))}</span>
      </div>`,
    )
    .join('');
  return `<section class="slide s-toc" data-layout="toc">
    ${pageHeader(page)}
    <div class="toc anim" style="--i:2">${rows || emptyBlock('目录暂无条目')}</div>
    ${pageFooter(page, idx, total)}
  </section>`;
}

function sectionPage(page: DeckHtmlPage, idx: number, total: number, sectionNo: number): string {
  return `<section class="slide s-section" data-layout="section">
    <div class="section-no anim" style="--i:0">${String(sectionNo).padStart(2, '0')}</div>
    <h2 class="section-title anim" style="--i:1">${escapeHtml(page.title)}</h2>
    ${page.bullets.length ? `<p class="section-lead anim" style="--i:2">${escapeHtml(clampText(page.bullets[0], 60))}</p>` : ''}
    ${pageFooter(page, idx, total)}
  </section>`;
}

function thanksPage(page: DeckHtmlPage, idx: number, total: number, model: DeckHtmlModel): string {
  return `<section class="slide s-thanks" data-layout="thanks">
    <div class="thanks-bar anim" style="--i:0"></div>
    <h2 class="thanks-title anim" style="--i:1">${escapeHtml(page.title || '谢谢')}</h2>
    ${page.bullets.length ? `<p class="thanks-lead anim" style="--i:2">${escapeHtml(clampText(page.bullets[0], 70))}</p>` : ''}
    <div class="thanks-meta anim" style="--i:3">${escapeHtml(model.chromeLeft)} · 数据截至 ${escapeHtml(model.meta.find((m) => /数据|截至/.test(m.label))?.value ?? '')}</div>
    ${pageFooter(page, idx, total)}
  </section>`;
}

function twoColPage(page: DeckHtmlPage, idx: number, total: number): string {
  const rightBlocks = page.blocks.map(renderBlock).join('');
  const left = bulletsBlock(page.bullets, 'in-col');
  const leftSide = left || (page.blocks.length ? '' : emptyBlock('本页无内容'));
  return `<section class="slide s-two-col" data-layout="twoCol">
    ${pageHeader(page)}
    <div class="two-col">
      <div class="col col-left">${leftSide}</div>
      <div class="col col-right">${rightBlocks || emptyBlock('本页无数据块')}</div>
    </div>
    ${pageFooter(page, idx, total)}
  </section>`;
}

function contentPage(page: DeckHtmlPage, idx: number, total: number): string {
  const blocks = page.blocks.map(renderBlock).join('');
  const bullets = bulletsBlock(page.bullets);
  const body = blocks || bullets || emptyBlock('本页无内容');
  // 数据块已承载信息时，bullet 退为导语（最多 2 条），避免同页两套并列文本抢注意力
  const leadBullets = blocks && page.bullets.length ? bulletsBlock(page.bullets.slice(0, 2), 'as-lead') : '';
  return `<section class="slide s-data layout-${escapeHtml(page.layout)}" data-layout="${escapeHtml(page.layout)}">
    ${pageHeader(page)}
    ${leadBullets}
    <div class="body">${body}</div>
    ${pageFooter(page, idx, total)}
  </section>`;
}

function renderPage(page: DeckHtmlPage, idx: number, total: number, model: DeckHtmlModel, sectionNo: number): string {
  if (page.layout === 'cover') return coverPage(model);
  if (page.layout === 'toc') return tocPage(page, model, idx, total);
  if (page.layout === 'section') return sectionPage(page, idx, total, sectionNo);
  if (page.layout === 'thanks') return thanksPage(page, idx, total, model);
  if (page.layout === 'twoCol') return twoColPage(page, idx, total);
  return contentPage(page, idx, total);
}

/* ------------------------------- 壳层 ------------------------------- */

function css(theme: DeckTheme): string {
  const statusVars = Object.entries(STATUS)
    .map(([k, v]) => `--${k}:${v.fg};--${k}-bg:${v.bg};`)
    .join('');
  return `
:root{--brand:${theme.brand};--accent:${theme.accent};--pale:${theme.pale};--ink:${theme.ink};--ink-soft:${theme.inkSoft};--ink-muted:${theme.inkMuted};--paper:${theme.paper};--surface:${theme.surface};--hair:${theme.hairline};--tint:${theme.tint};${statusVars}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#E8E8EC;overflow:hidden}
body{font-family:${TYPE.body};color:var(--ink);-webkit-font-smoothing:antialiased}
.deck{position:fixed;top:50%;left:50%;width:${CANVAS_PX.width}px;height:${CANVAS_PX.height}px;transform:translate(-50%,-50%) scale(1);background:var(--paper);box-shadow:0 10px 60px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08);overflow:hidden}
.slide{position:absolute;inset:0;padding:${PADDING_PX.y}px ${PADDING_PX.x}px ${PADDING_PX.y}px;display:grid;grid-template-rows:auto 1fr auto;row-gap:${SPACE.lg}px;opacity:0;visibility:hidden;transition:opacity .5s cubic-bezier(.2,.7,.2,1),visibility .5s}
.slide.is-active{opacity:1;visibility:visible}
.anim{opacity:0}
.slide.is-active .anim{animation:rise .55s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 70ms)}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.slide{transition:none}.slide.is-active .anim{animation:none;opacity:1}}
.chrome-top,.chrome-bottom{position:absolute;left:${PADDING_PX.x}px;right:${PADDING_PX.x}px;height:${CHROME_PX}px;display:flex;align-items:center;justify-content:space-between;font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);letter-spacing:.06em;text-transform:uppercase}
.chrome-top{top:0}
.chrome-bottom{bottom:0;text-transform:none;letter-spacing:0}
.chrome-brand{color:var(--brand);font-weight:600}
.dots{position:absolute;bottom:${CHROME_PX + 2}px;left:50%;transform:translateX(-50%);display:flex;gap:7px}
.dots button{width:6px;height:6px;padding:0;border:0;border-radius:50%;background:var(--hair);cursor:pointer;transition:background .25s,width .25s}
.dots button.is-on{background:var(--brand);width:18px;border-radius:3px}
.hint{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);font:${TYPE_SCALE.micro}px/1.6 ${TYPE.body};color:#8A8A8A;letter-spacing:.04em}
h1,h2,h3,p,ul{margin:0}
.kicker{font-size:${TYPE_SCALE.micro}px;letter-spacing:.18em;text-transform:uppercase;color:var(--brand);font-weight:600;margin-bottom:${SPACE.sm}px}
.h-1{font-family:${TYPE.display};font-size:${TYPE_SCALE.title}px;line-height:1.28;font-weight:600;color:var(--ink);letter-spacing:.01em}
.lead{font-size:${TYPE_SCALE.lead}px;line-height:1.6;color:var(--ink-soft);margin-top:${SPACE.sm}px;max-width:74ch}
.s-cover{grid-template-rows:1fr;align-content:center;row-gap:0}
.cover-bar{width:56px;height:6px;background:var(--brand);margin-bottom:${SPACE.xl}px}
.cover-kicker{font:600 ${TYPE_SCALE.micro}px/1 ${TYPE.body};letter-spacing:.24em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:${SPACE.md}px}
.cover-title{font-family:${TYPE.display};font-size:${TYPE_SCALE.cover}px;line-height:1.14;font-weight:600;color:var(--ink);max-width:15ch}
.cover-lead{margin-top:${SPACE.lg}px;font-size:${TYPE_SCALE.lead}px;line-height:1.65;color:var(--ink-soft);max-width:58ch}
.cover-meta{display:flex;gap:${SPACE.xl}px;margin-top:${SPACE.xxl}px;padding-top:${SPACE.md}px;border-top:1px solid var(--hair)}
.meta-label{font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);letter-spacing:.1em;margin-bottom:4px}
.meta-value{font-size:${TYPE_SCALE.dense}px;color:var(--ink);font-weight:600;font-family:${TYPE.mono}}
.toc{display:flex;flex-direction:column;gap:2px;align-content:start}
.toc-row{display:grid;grid-template-columns:48px 150px 1fr auto;align-items:baseline;gap:${SPACE.md}px;padding:${SPACE.md}px 0;border-bottom:1px solid var(--hair)}
.toc-no{font-family:${TYPE.mono};font-size:${TYPE_SCALE.dense}px;color:var(--brand);font-weight:600}
.toc-sec{font-size:${TYPE_SCALE.dense}px;color:var(--ink-soft)}
.toc-dots{border-bottom:1px dotted var(--hair);transform:translateY(-4px)}
.toc-title{font-size:${TYPE_SCALE.body}px;color:var(--ink);font-weight:600}
.s-section{align-content:center;justify-items:center;text-align:center;grid-template-rows:1fr;row-gap:0}
.section-no{font-family:${TYPE.mono};font-size:${TYPE_SCALE.sectionNo}px;line-height:1;color:var(--pale);font-weight:700;letter-spacing:-.04em}
.section-title{font-family:${TYPE.display};font-size:${TYPE_SCALE.sectionTitle}px;font-weight:600;color:var(--ink);margin-top:${SPACE.md}px}
.section-lead{margin-top:${SPACE.md}px;font-size:${TYPE_SCALE.lead}px;color:var(--ink-soft);max-width:60ch}
.s-thanks{align-content:center;justify-items:center;text-align:center;grid-template-rows:1fr;row-gap:0}
.thanks-bar{width:56px;height:6px;background:var(--brand);margin-bottom:${SPACE.xl}px}
.thanks-title{font-family:${TYPE.display};font-size:${TYPE_SCALE.cover}px;font-weight:600}
.thanks-lead{margin-top:${SPACE.md}px;font-size:${TYPE_SCALE.lead}px;color:var(--ink-soft);max-width:60ch}
.thanks-meta{margin-top:${SPACE.xl}px;font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);letter-spacing:.08em}
.two-col{display:grid;grid-template-columns:1fr 1.15fr;gap:${SPACE.xl}px;min-height:0}
.col{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:${SPACE.md}px}
.col-left{border-right:1px solid var(--hair);padding-right:${SPACE.xl}px}
.bullets{list-style:none;padding:0;display:flex;flex-direction:column;gap:${SPACE.md}px;max-height:482px;overflow:hidden}
.bullets li{display:flex;gap:${SPACE.md}px;font-size:${TYPE_SCALE.body}px;line-height:1.6;color:var(--ink)}
.bullets.as-lead li{font-size:${TYPE_SCALE.lead}px;color:var(--ink-soft)}
.bullet-mark{flex:0 0 auto;width:6px;height:6px;margin-top:10px;background:var(--brand)}
.body{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:${SPACE.md}px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--hair);border:1px solid var(--hair)}
.metric{background:var(--surface);padding:${SPACE.lg}px ${SPACE.md}px}
.metric-label{font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);letter-spacing:.06em;margin-bottom:${SPACE.sm}px}
.metric-value{font-family:${TYPE.mono};font-size:34px;line-height:1.1;font-weight:700}
.metric-hint{margin-top:${SPACE.sm}px;font-size:${TYPE_SCALE.micro}px;color:var(--ink-soft);line-height:1.45}
.table-wrap{min-height:0;overflow:hidden}
.data-table{width:100%;border-collapse:collapse;font-size:${TYPE_SCALE.dense}px}
.data-table th{ text-align:left;font-weight:600;color:var(--ink-soft);font-size:${TYPE_SCALE.micro}px;letter-spacing:.06em;padding:${SPACE.sm}px ${SPACE.md}px;border-bottom:1px solid var(--ink-muted);background:var(--tint)}
.data-table td{padding:${SPACE.sm}px ${SPACE.md}px;border-bottom:1px solid var(--hair);vertical-align:top;color:var(--ink)}
.data-table tbody tr:nth-child(even){background:var(--surface)}
.cell-status{white-space:nowrap}
.table-more,.table-note{margin-top:${SPACE.sm}px;font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted)}
.list{display:flex;flex-direction:column;gap:1px;background:var(--hair);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);max-height:482px;overflow:hidden}
.list-row{background:var(--surface);display:flex;align-items:flex-start;gap:${SPACE.md}px;padding:${SPACE.md}px}
.list-main{flex:1;min-width:0}
.list-title{font-size:${TYPE_SCALE.body}px;font-weight:600}
.list-desc{margin-top:2px;font-size:${TYPE_SCALE.dense}px;color:var(--ink-soft);line-height:1.5}
.tag{font-size:${TYPE_SCALE.micro}px;padding:2px 8px;border:1px solid currentColor;white-space:nowrap}
.tag-ok{color:var(--ok)}.tag-warn{color:var(--warn)}.tag-bad{color:var(--bad)}.tag-neutral{color:var(--ink-muted)}
.dot{display:inline-block;flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:7px}
.t-ok{color:var(--ok)}.t-warn{color:var(--warn)}.t-bad{color:var(--bad)}.t-neutral{color:var(--ink-muted)}
.dot.t-ok{background:var(--ok)}.dot.t-warn{background:var(--warn)}.dot.t-bad{background:var(--bad)}.dot.t-neutral{background:var(--ink-muted)}
.timeline{position:relative;display:flex;flex-direction:column;gap:${SPACE.md}px;max-height:482px;overflow:hidden}
.tl-axis{position:absolute;left:9px;top:0;bottom:0;width:1px;background:var(--hair)}
.tl-items{display:flex;flex-direction:column;gap:${SPACE.md}px}
.tl-item{display:grid;grid-template-columns:20px 1fr;gap:${SPACE.md}px;align-items:start}
.tl-node{width:10px;height:10px;background:var(--brand);margin-top:5px;position:relative;z-index:1}
.tl-node.is-milestone{transform:rotate(45deg)}
.tl-node.t-ok{background:var(--ok)}.tl-node.t-warn{background:var(--warn)}.tl-node.t-bad{background:var(--bad)}
.tl-body{min-width:0}
.tl-label{font-size:${TYPE_SCALE.body}px;font-weight:600}
.tl-range{font-family:${TYPE.mono};font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);margin-top:2px}
.tl-track{margin-top:6px;height:3px;background:var(--tint)}
.tl-fill{height:100%;background:var(--brand)}
.tl-fill.t-ok{background:var(--ok)}.tl-fill.t-warn{background:var(--warn)}.tl-fill.t-bad{background:var(--bad)}
.flow{display:flex;align-items:stretch;gap:${SPACE.sm}px}
.flow-step{flex:1;min-width:0;border-top:3px solid var(--brand);padding-top:${SPACE.md}px}
.flow-no{font-family:${TYPE.mono};font-size:${TYPE_SCALE.micro}px;color:var(--brand);font-weight:700}
.flow-label{margin-top:${SPACE.sm}px;font-size:${TYPE_SCALE.body}px;font-weight:600}
.flow-desc{margin-top:4px;font-size:${TYPE_SCALE.dense}px;color:var(--ink-soft);line-height:1.45}
.flow-arrow{align-self:center;width:16px;height:1px;background:var(--hair);flex:0 0 auto}
.chips{display:grid;grid-template-columns:repeat(2,1fr);gap:${SPACE.lg}px;max-height:482px;overflow:hidden}
.chip-group{border-left:2px solid var(--brand);padding-left:${SPACE.md}px}
.chip-label{font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);letter-spacing:.08em;margin-bottom:${SPACE.sm}px}
.chip-items{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:${TYPE_SCALE.dense}px;padding:4px 10px;border:1px solid var(--hair);background:var(--surface)}
.bars{display:flex;flex-direction:column;gap:${SPACE.md}px}
.bar-row{display:grid;grid-template-columns:130px 1fr 64px;gap:${SPACE.md}px;align-items:center}
.bar-label{font-size:${TYPE_SCALE.dense}px;color:var(--ink-soft);text-align:right}
.bar-track{height:14px;background:var(--tint)}
.bar-fill{height:100%;background:var(--brand)}
.bar-value{font-family:${TYPE.mono};font-size:${TYPE_SCALE.dense}px;font-weight:600}
.progress-list{display:flex;flex-direction:column;gap:${SPACE.md}px}
.progress-row{display:grid;grid-template-columns:200px 1fr 56px;gap:${SPACE.md}px;align-items:center}
.progress-label{font-size:${TYPE_SCALE.dense}px;color:var(--ink-soft)}
.progress-track{height:6px;background:var(--tint)}
.progress-fill{height:100%;background:var(--brand)}
.progress-fill.t-ok{background:var(--ok)}.progress-fill.t-warn{background:var(--warn)}.progress-fill.t-bad{background:var(--bad)}
.progress-value{font-family:${TYPE.mono};font-size:${TYPE_SCALE.dense}px;text-align:right;font-weight:600}
.note{font-size:${TYPE_SCALE.body}px;line-height:1.75;color:var(--ink-soft)}
.empty{border:1px dashed var(--hair);padding:${SPACE.xl}px;text-align:center;color:var(--ink-muted);font-size:${TYPE_SCALE.dense}px}
.page-foot{display:flex;align-items:center;justify-content:space-between;gap:${SPACE.lg}px;font-size:${TYPE_SCALE.micro}px;color:var(--ink-muted);border-top:1px solid var(--hair);padding-top:${SPACE.sm}px}
.foot-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot-page{font-family:${TYPE.mono};white-space:nowrap}
`;
}

function js(total: number): string {
  return `
(function(){
  var deck=document.getElementById('deck');
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var dots=[].slice.call(document.querySelectorAll('.dots button'));
  var idx=0,total=${total};
  function scale(){
    var s=Math.min(window.innerWidth/${CANVAS_PX.width},window.innerHeight/${CANVAS_PX.height})*0.94;
    s=Math.max(0.2,Math.min(1.6,s));
    deck.style.transform='translate(-50%,-50%) scale('+s+')';
  }
  function show(n){
    idx=Math.max(0,Math.min(total-1,n));
    slides.forEach(function(el,i){el.classList.toggle('is-active',i===idx)});
    dots.forEach(function(el,i){el.classList.toggle('is-on',i===idx)});
    if(history.replaceState){history.replaceState(null,'','#'+(idx+1))}
  }
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();show(idx+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();show(idx-1)}
    else if(e.key==='Home'){e.preventDefault();show(0)}
    else if(e.key==='End'){e.preventDefault();show(total-1)}
  });
  var wheelLock=0;
  deck.addEventListener('wheel',function(e){
    var now=Date.now(); if(now-wheelLock<420)return; 
    if(Math.abs(e.deltaY)<8&&Math.abs(e.deltaX)<8)return;
    wheelLock=now; e.preventDefault(); show(idx+(e.deltaY>0||e.deltaX>0?1:-1));
  },{passive:false});
  var tx=0,ty=0;
  deck.addEventListener('touchstart',function(e){var t=e.changedTouches[0];tx=t.clientX;ty=t.clientY},{passive:true});
  deck.addEventListener('touchend',function(e){
    var t=e.changedTouches[0],dx=t.clientX-tx,dy=t.clientY-ty;
    if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)) show(idx+(dx<0?1:-1));
  },{passive:true});
  dots.forEach(function(d,i){d.addEventListener('click',function(){show(i)})});
  window.addEventListener('resize',scale);
  scale();
  var h=parseInt((location.hash||'').replace('#',''),10);
  show(isFinite(h)&&h>0?h-1:0);
})();
`;
}

/* ------------------------------- 入口 ------------------------------- */

/**
 * 渲染单文件 HTML。返回值可直接落盘：无外链、无构建步骤、双击即放映。
 * 页序以 `model.pages` 为准；封面/目录/章节/致谢按 layout 自动分流，不要求调用方排序。
 */
export function renderDeckHtml(model: DeckHtmlModel): string {
  const theme = deckTheme(model.style ?? 'standard');
  const total = model.pages.length;
  let sectionNo = 0;
  const slides = model.pages
    .map((page, idx) => {
      if (page.layout === 'section') sectionNo += 1;
      return renderPage(page, idx, total, model, sectionNo);
    })
    .join('\n');
  const title = `${model.title} · ${model.chromeLeft}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="MTask deck-html">
<title>${escapeHtml(title)}</title>
<style>${css(theme)}</style>
</head>
<body>
<div class="deck" id="deck">
<header class="chrome-top"><span class="chrome-brand">${escapeHtml(model.chromeLeft)}</span><span>${escapeHtml(model.chromeRight)}</span></header>
${slides}
<footer class="chrome-bottom"><span>${escapeHtml(model.kind === 'kickoff' ? '项目启动会' : '阶段性总结')}</span><span>${escapeHtml(model.title)}</span></footer>
<nav class="dots" aria-label="页面导航">${model.pages.map((_, i) => `<button type="button" aria-label="第 ${i + 1} 页"></button>`).join('')}</nav>
</div>
<div class="hint">← → 翻页 · 滚轮/触摸滑动 · 圆点跳转</div>
<script>${js(total)}</script>
</body>
</html>`;
}

/** 下载名：与 PPTX 同名前缀，只换扩展名，用户在下载目录里能成对找到 */
export function htmlFileNameOf(pptxFileName: string): string {
  return pptxFileName.replace(/\.pptx$/i, '') + '.html';
}

/** 供门做结构断言：11 种版式是否都被渲染器覆盖（新增 layout 忘了实现会在这里露出来） */
export const HTML_LAYOUT_SUPPORT = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list', 'flow', 'chip', 'section', 'thanks'] as const;

/** 三档主题的可用键（HTML 与 PPTX 同一份，避免 HTML 多认一档） */
export const HTML_STYLE_KEYS = Object.keys(DECK_STYLES) as DeckStyleKey[];
