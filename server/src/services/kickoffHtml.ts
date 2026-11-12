/**
 * 启动会 PPT 的 HTML 版模型适配（2026-11-06）。
 *
 * 职责：把 `KickoffBundle`（数据库采集结果）+ `KickoffOutlineItem[]`（AI 大纲）
 * 折成 `deckHtml.ts` 认识的中性模型。渲染器不认识 bundle 字段，本文件不认识 HTML 标签——
 * 这样新增一种数据键只需要改这里，版式样式仍集中在渲染器。
 *
 * 与 PPTX 的关系：同一份 bundle 与 outline，**内容口径逐项同源**（占位词、状态名、截断规则），
 * 只是表达方式换成网页版式。两个产物不共享几何，故不共享版式代码。
 */
import type { KickoffBundle, KickoffOutlineItem } from './kickoffService';
import { renderDeckHtml, type DeckHtmlBlock, type DeckHtmlModel, type DeckHtmlPage } from './deckHtml';
import { PLACEHOLDER, statusToneOf } from './deckDesign';
import type { DeckStyleKey } from '../util/exportStyle';

/** 单页最多承载的数据块：再多会挤掉正文，宁可让读者翻到下一页（页脚会注明被省略的键） */
const MAX_BLOCKS_PER_PAGE = 2;

/** 表格行上限：与 PPTX 的 MAX_TABLE_ROWS 同量级，超出折成一句「共 N 条」 */
const MAX_TABLE_ROWS = 8;

function cell(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  return s || PLACEHOLDER;
}

function statusLabel(status: string): string {
  if (status === 'done') return '已完成';
  if (status === 'doing') return '进行中';
  if (status === 'blocked') return '阻塞';
  return '未开始';
}

/** PRD 摘要清洗：剔除 Markdown 表格行与行内标记，与 PPTX 的 prdDocLines 同规则（否则原文符号会印上屏） */
function cleanPrdExcerpt(b: KickoffBundle): string {
  if (!b.prdDoc) return '未导入 PRD 原文，技术章节按计划口径撰写。';
  const lines = b.prdExcerpt
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l))
    .filter((l) => !/^\s*[-=:|\s]*$/.test(l))
    .map((l) => l
      .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
      .replaceAll(/`([^`]+)`/g, '$1')
      .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s*\|.*$/, '')
      .replace(/^[#>*\-\s]+/, '')
      .trim())
    .filter((l) => l.length > 4)
    .slice(0, 4);
  return [`来源：${b.prdDoc.filename}（${b.prdDoc.updatedAt}）`, ...lines].join('\n');
}

/** 数据键 → HTML 块。顺序即页面内的堆叠顺序。 */
export function blocksForKey(key: string, b: KickoffBundle): DeckHtmlBlock[] {
  switch (key) {
    case 'prdDoc':
      return [{ type: 'note', text: cleanPrdExcerpt(b) }];
    case 'reqList':
      return [{
        type: 'table',
        columns: ['编号', '需求', '优先级', '状态', '关联计划'],
        statusCol: 3,
        rows: b.requirements.slice(0, MAX_TABLE_ROWS).map((r) => [
          r.req_no ?? '', r.title ?? '', r.priority ?? '', statusLabel(r.status ?? 'todo'), String(r.linkedPlans.length),
        ]),
        note: b.requirements.length > MAX_TABLE_ROWS ? `共 ${b.requirements.length} 条需求，此处展示前 ${MAX_TABLE_ROWS} 条` : undefined,
      }];
    case 'reqStats': {
      const done = b.requirements.filter((r) => r.status === 'done').length;
      const doing = b.requirements.filter((r) => r.status === 'doing').length;
      const unlinked = b.requirements.filter((r) => r.linkedPlans.length === 0).length;
      return [{
        type: 'metrics',
        items: [
          { label: '需求总数', value: String(b.requirements.length), tone: 'neutral' },
          { label: '已完成', value: String(done), tone: 'ok' },
          { label: '进行中', value: String(doing), tone: 'warn' },
          { label: '未关联计划', value: String(unlinked), tone: unlinked > 0 ? 'bad' : 'ok', hint: unlinked > 0 ? '会上确认归属' : undefined },
        ],
      }];
    }
    case 'planRows':
      return [{
        type: 'table',
        columns: ['任务', '起止', '负责人', '状态', '进度'],
        statusCol: 3,
        rows: b.plans.slice(0, MAX_TABLE_ROWS).map((p) => [
          p.title, `${cell(p.start_date)}~${cell(p.end_date)}`, cell(p.assignee), statusLabel(p.status), `${p.progress}%`,
        ]),
        note: b.plans.length > MAX_TABLE_ROWS ? `共 ${b.plans.length} 条计划，此处展示前 ${MAX_TABLE_ROWS} 条` : undefined,
      }];
    case 'milestones':
      return [{
        type: 'timeline',
        items: b.milestones.slice(0, 7).map((m) => ({
          label: m.title,
          start: m.start_date || undefined,
          end: m.end_date || undefined,
          progress: m.progress,
          tone: statusToneOf(m.status),
          milestone: true,
        })),
      }];
    case 'coverage':
      return [
        {
          type: 'metrics',
          items: b.coverage.caseTotal === 0
            ? [
                { label: '测试用例', value: PLACEHOLDER, tone: 'neutral', hint: '本期未建用例' },
                { label: '需求数', value: String(b.coverage.total), tone: 'neutral' },
              ]
            : [
                { label: '测试用例', value: String(b.coverage.caseTotal), tone: 'neutral' },
                { label: '已覆盖需求', value: String(b.coverage.covered), tone: 'ok' },
                { label: '未覆盖需求', value: String(b.coverage.uncovered), tone: b.coverage.uncovered > 0 ? 'bad' : 'ok' },
                { label: '需求覆盖率', value: `${b.coverage.rate}%`, tone: b.coverage.rate >= 80 ? 'ok' : 'warn' },
              ],
        },
      ];
    case 'assignees':
      return b.assignees.length
        ? [{ type: 'chips', groups: b.assignees.slice(0, 6).map((a) => ({ label: a.name || PLACEHOLDER, items: [`承担 ${a.planCount} 项`] })) }]
        : [{ type: 'note', text: `负责人来源为计划行的 assignee 字段，当前 ${b.plans.length} 条计划均未填写，一律记「${PLACEHOLDER}」——会上现场确认后再补，页面不代填人名。` }];
    case 'risks':
      return [{
        type: 'list',
        items: b.risks.slice(0, 6).map((r) => ({
          title: r.item,
          desc: `影响：${r.impact}；应对：${r.mitigation}`,
          tag: r.source,
          tone: 'bad' as const,
        })),
      }];
    case 'workload': {
      const w = b.workload;
      if (w.noData) {
        return [{ type: 'note', text: `总工作量：${PLACEHOLDER}（无估算行，且 ${w.counted} 条计划均未填工期）。补数路径：估算工作台生成三点估算，或在项目计划逐条填「工期(工作日)」。` }];
      }
      const items = [
        { label: '总工作量(P50)', value: `${w.manDays.expected} 人天`, tone: 'neutral' as const },
        { label: '人月', value: `${w.manMonth}`, tone: 'neutral' as const, hint: `人月 = 人天 ÷ ${w.manDaysPerManMonth}` },
      ];
      if (w.quote) {
        items.push({ label: '报价 P50', value: `${Math.round(w.quote.p50ManDays * 10) / 10} 人天`, tone: 'neutral' as const });
        items.push({ label: '报价 P84', value: `${Math.round(w.quote.p84ManDays * 10) / 10} 人天`, tone: 'neutral' as const });
      }
      const blocks: DeckHtmlBlock[] = [{ type: 'metrics', items }];
      if (w.phases.length >= 2) {
        blocks.push({ type: 'bars', items: w.phases.map((p) => ({ label: p.phase, value: p.expected, text: `${p.expected}` })), note: w.footer });
      }
      return blocks;
    }
    case 'workspace':
      return [{ type: 'note', text: [b.project.workspacePath ? `工作空间：${b.project.workspacePath}` : '工作空间：未配置', b.workspaceNote ?? '技术章节按计划口径撰写，未引用工作空间内素材'].join('\n') }];
    case 'timeline':
      return [{
        type: 'timeline',
        items: b.plans.slice(0, 7).map((p) => ({
          label: p.title,
          start: p.start_date || undefined,
          end: p.end_date || undefined,
          progress: p.progress,
          tone: statusToneOf(p.status),
        })),
      }];
    case 'preflight':
      return [{
        type: 'list',
        items: b.preflight.items.slice(0, 7).map((i) => ({
          title: `${i.key} ${i.label}`,
          desc: i.note,
          tag: String(i.count),
          tone: i.status === 'ok' ? 'ok' as const : i.status === 'warn' ? 'warn' as const : 'bad' as const,
        })),
      }];
    default:
      return [];
  }
}

/** 大纲页 → HTML 页：dataKeys 展开成块，超出单页承载量的键在页脚注明 */
function toPage(item: KickoffOutlineItem, b: KickoffBundle): DeckHtmlPage {
  const keys = item.dataKeys.slice(0, MAX_BLOCKS_PER_PAGE);
  const omitted = item.dataKeys.slice(MAX_BLOCKS_PER_PAGE);
  const blocks = keys.flatMap((k) => blocksForKey(k, b));
  const footnote = omitted.length
    ? `本页省略 ${omitted.length} 个数据块（${omitted.join('、')}），完整数据见 MTask 对应页`
    : undefined;
  return {
    section: item.section,
    title: item.title,
    bullets: item.bullets,
    layout: item.layout,
    blocks,
    footnote,
  };
}

/**
 * 启动会 HTML 模型。封面导语优先取大纲封面页的第一条 bullet（AI 已经写过一句定位语），
 * 没有再回落一句不含数字的默认描述——封面不编造指标。
 */
export function buildKickoffDeckModel(b: KickoffBundle, outline: KickoffOutlineItem[], style: DeckStyleKey = 'standard'): DeckHtmlModel {
  const cover = outline.find((o) => o.layout === 'cover');
  const lead = cover?.bullets.find((x) => String(x ?? '').trim()) ?? `本次启动会同步项目目标、范围、计划与风险，形成可执行的开工共识。`;
  const pages = outline.map((item) => toPage(item, b));
  return {
    kind: 'kickoff',
    title: `${b.project.name} 项目启动会`,
    lead,
    meta: [
      { label: '项目', value: b.project.name },
      { label: '数据截至', value: b.dataAsOf },
      { label: '需求', value: `${b.requirements.length} 条` },
      { label: '计划', value: `${b.plans.length} 条` },
    ],
    pages,
    chromeLeft: '项目启动会',
    chromeRight: b.dataAsOf.replaceAll('-', '.'),
    style,
  };
}

/** 启动会 HTML 单文件 */
export function buildKickoffHtml(b: KickoffBundle, outline: KickoffOutlineItem[], style: DeckStyleKey = 'standard'): string {
  return renderDeckHtml(buildKickoffDeckModel(b, outline, style));
}

