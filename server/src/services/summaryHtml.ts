/**
 * 阶段总结汇报 PPT 的 HTML 版模型适配（2026-11-06）。
 *
 * 与 kickoffHtml 同一分工：只把 `SummaryDeckData` + `SummaryOutlineItem[]` 折成中性模型，
 * 不碰 HTML 标签。合并版按项目取数（大纲项带 projectId），单项目稿走 `projectOf` 短路。
 */
import type { SummaryDeckData, SummaryProjectData } from './summaryPptData';
import type { SummaryOutlineItem } from './summaryPptOutline';
import { renderDeckHtml, type DeckHtmlBlock, type DeckHtmlModel, type DeckHtmlPage } from './deckHtml';
import { statusToneOf } from './deckDesign';

const MAX_BLOCKS_PER_PAGE = 2;
const MAX_TABLE_ROWS = 8;

function statusLabel(raw: string): string {
  const s = String(raw ?? '');
  if (s === 'done') return '已完成';
  if (s === 'doing') return '进行中';
  if (s === 'blocked') return '阻塞';
  return '未开始';
}

/** 单页作用域：带 projectId 的按项目取，不带的落到第一个项目（单项目稿即全部数据） */
function scopeProject(deck: SummaryDeckData, projectId?: string): SummaryProjectData | undefined {
  // 不用 projectOf：那是数据层的运行时依赖（会拖入数据库层），HTML 适配器只认已采集好的 deck
  return (projectId ? deck.projects.find((p) => p.id === projectId) : undefined) ?? deck.projects[0];
}

function kpiBlock(deck: SummaryDeckData, p: SummaryProjectData | undefined, all: boolean): DeckHtmlBlock {
  if (all && deck.projects.length > 0) {
    const tasks = deck.projects.reduce((s, x) => s + x.tasks.done, 0);
    const plans = deck.projects.reduce((s, x) => s + x.plans.total, 0);
    const overdue = deck.projects.reduce((s, x) => s + x.plans.overdue, 0);
    const milestones = deck.projects.reduce((s, x) => s + x.milestones.filter((m) => m.status === 'done').length, 0);
    return {
      type: 'metrics',
      items: [
        { label: '项目数', value: String(deck.projects.length), tone: 'neutral' },
        { label: '已完成任务', value: String(tasks), tone: 'ok' },
        { label: '计划总数', value: String(plans), tone: 'neutral' },
        { label: '逾期计划', value: String(overdue), tone: overdue > 0 ? 'bad' : 'ok' },
        { label: '已完成里程碑', value: String(milestones), tone: 'ok' },
      ],
    };
  }
  if (!p) return { type: 'note', text: '本期无可统计项目。' };
  const mDone = p.milestones.filter((m) => m.status === 'done').length;
  return {
    type: 'metrics',
    items: [
      { label: '已完成任务', value: String(p.tasks.done), tone: 'ok', hint: `活跃 ${p.tasks.active}` },
      { label: '计划完成', value: `${p.plans.byStatus.done}/${p.plans.total}`, tone: 'neutral', hint: `平均进度 ${Math.round(p.plans.avgProgress)}%` },
      { label: '里程碑', value: `${mDone}/${p.milestones.length}`, tone: mDone === p.milestones.length ? 'ok' : 'warn' },
      { label: '逾期 / 阻塞', value: `${p.plans.overdue} / ${p.plans.blocked}`, tone: p.plans.overdue > 0 || p.plans.blocked > 0 ? 'bad' : 'ok' },
    ],
  };
}

/** 数据键 → HTML 块（合并版与单项目稿共用） */
export function blocksForKey(key: string, deck: SummaryDeckData, projectId?: string): DeckHtmlBlock[] {
  const p = scopeProject(deck, projectId);
  const all = deck.projects.length > 1;
  switch (key) {
    case 'kpi':
      return [kpiBlock(deck, p, all)];
    case 'highlights': {
      const items = p
        ? p.deliverables.donePlanTitles.slice(0, 6).map((t) => ({ title: t, desc: '本期已完成', tone: 'ok' as const }))
        : [];
      return items.length ? [{ type: 'list', items }] : [{ type: 'note', text: '本期没有已完成计划。' }];
    }
    case 'milestones':
      return [{
        type: 'timeline',
        items: (p?.milestones ?? []).slice(0, 7).map((m) => ({
          label: m.title,
          end: m.endDate || undefined,
          progress: m.progress,
          tone: statusToneOf(m.status),
          milestone: true,
        })),
      }];
    case 'planRows':
      return [{
        type: 'table',
        columns: ['计划', '状态', '起止', '进度', '逾期'],
        statusCol: 1,
        rows: (p?.plans.rows ?? []).slice(0, MAX_TABLE_ROWS).map((r) => [
          r.title, statusLabel(r.status), `${r.startDate || '—'}~${r.endDate || '—'}`, `${r.progress}%`, r.overdue ? '是' : '否',
        ]),
        note: (p?.plans.rows.length ?? 0) > MAX_TABLE_ROWS ? `共 ${p?.plans.rows.length} 条计划，此处展示前 ${MAX_TABLE_ROWS} 条` : undefined,
      }];
    case 'risks': {
      const items: Array<{ title: string; desc?: string; tag?: string; tone?: 'ok' | 'warn' | 'bad' | 'neutral' }> = [];
      if (p) {
        if (p.risks.overdue > 0) items.push({ title: `逾期计划 ${p.risks.overdue} 条`, desc: '按当前进度将超出排期，需在会上明确追赶措施', tag: '逾期', tone: 'bad' });
        if (p.risks.blocked > 0) items.push({ title: `阻塞计划 ${p.risks.blocked} 条`, desc: '阻塞未解除，后继工作无法按期开工', tag: '阻塞', tone: 'bad' });
        if (p.risks.complex > 0) items.push({ title: `高复杂度计划 ${p.risks.complex} 条`, desc: '复杂度 ≥4，估算与排期风险偏高', tag: '复杂度', tone: 'warn' });
        for (const issue of p.issues.slice(0, 4)) {
          items.push({ title: issue.question, desc: issue.answer, tag: issue.level, tone: statusToneOf(issue.status) });
        }
      }
      return items.length ? [{ type: 'list', items: items.slice(0, 6) }] : [{ type: 'note', text: '本期无逾期、阻塞与待决问题。' }];
    }
    case 'workload': {
      if (!p) return [{ type: 'note', text: '本期无工作量数据。' }];
      const w = p.workload;
      const items = [
        { label: '人工估算人天', value: String(w.likelyDays), tone: 'neutral' as const, hint: w.footer },
        { label: '已完成计划', value: String(w.donePlans), tone: 'ok' as const },
        { label: '工期消耗', value: `${w.doneDurationDays}/${w.totalDurationDays}`, tone: 'neutral' as const, hint: '工作日' },
        { label: '高复杂度行', value: String(w.complexRows), tone: w.complexRows > 0 ? 'warn' as const : 'ok' as const },
      ];
      const blocks: DeckHtmlBlock[] = [{ type: 'metrics', items }];
      if (w.byPhase.length >= 2) {
        blocks.push({ type: 'bars', items: w.byPhase.map((x) => ({ label: x.phase, value: x.likely, text: String(x.likely) })), note: '按阶段的人工估算人天' });
      }
      return blocks;
    }
    case 'deliverables': {
      if (!p) return [{ type: 'note', text: '本期无交付物。' }];
      const items = p.deliverables.docs.slice(0, 6).map((d) => ({ title: d.filename, desc: `更新于 ${d.updatedAt}`, tag: d.status, tone: statusToneOf(d.status) }));
      return items.length ? [{ type: 'list', items }] : [{ type: 'note', text: '本期没有文档类交付物。' }];
    }
    case 'nextSteps':
      return [{
        type: 'table',
        columns: ['下阶段计划', '状态', '起止', '进度'],
        statusCol: 1,
        rows: (p?.nextPlans ?? []).slice(0, MAX_TABLE_ROWS).map((r) => [
          r.title, statusLabel(r.status), `${r.startDate || '—'}~${r.endDate || '—'}`, `${r.progress}%`,
        ]),
        note: p?.nextMilestone ? `下个里程碑：${p.nextMilestone.title}（${p.nextMilestone.endDate || '未定日期'}）` : undefined,
      }];
    case 'summary':
      return [{ type: 'note', text: p ? summaryText(p) : '本期总结待补充。' }];
    case 'appendix':
      return [{ type: 'note', text: [
        `数据口径：${deck.periodLabel}（${deck.range.start} ~ ${deck.range.end}），数据截至 ${deck.dataAsOf}`,
        deck.coverage.degraded ? deck.coverage.footnote : '事件覆盖正常',
      ].join('\n') }];
    case 'compare':
      return [{
        type: 'table',
        columns: ['项目', '已完成任务', '计划完成', '逾期', '里程碑'],
        rows: deck.projects.slice(0, MAX_TABLE_ROWS).map((x) => [
          x.name,
          String(x.tasks.done),
          `${x.plans.byStatus.done}/${x.plans.total}`,
          String(x.plans.overdue),
          `${x.milestones.filter((m) => m.status === 'done').length}/${x.milestones.length}`,
        ]),
      }];
    case 'horizontal':
      return [{
        type: 'bars',
        items: deck.projects.map((x) => ({ label: x.name, value: Math.round(x.plans.avgProgress), text: `${Math.round(x.plans.avgProgress)}%` })),
        note: '各项目计划平均进度',
      }];
    default:
      return [];
  }
}

/** 本期总结：只用库内事实拼句，不调用模型、不编造结论 */
function summaryText(p: SummaryProjectData): string {
  const mDone = p.milestones.filter((m) => m.status === 'done').length;
  return [
    `本期「${p.name}」完成计划 ${p.plans.byStatus.done} 条、任务 ${p.deliverables.doneTasks} 项，里程碑 ${mDone}/${p.milestones.length} 达成。`,
    p.plans.overdue > 0 || p.plans.blocked > 0
      ? `仍有逾期 ${p.plans.overdue} 条、阻塞 ${p.plans.blocked} 条，需在下阶段优先处置。`
      : '本期无逾期与阻塞，节奏正常。',
    p.nextMilestone ? `下阶段聚焦「${p.nextMilestone.title}」，目标日期 ${p.nextMilestone.endDate || '待定'}。` : '下阶段计划见「下阶段计划」页。',
  ].join('\n');
}

function toPage(item: SummaryOutlineItem, deck: SummaryDeckData): DeckHtmlPage {
  const keys = item.dataKeys.slice(0, MAX_BLOCKS_PER_PAGE);
  const omitted = item.dataKeys.slice(MAX_BLOCKS_PER_PAGE);
  const blocks = keys.flatMap((k) => blocksForKey(k, deck, item.projectId));
  return {
    section: item.section,
    title: item.title,
    bullets: item.bullets,
    layout: item.layout,
    blocks,
    footnote: omitted.length ? `本页省略 ${omitted.length} 个数据块（${omitted.join('、')}），完整数据见 MTask 对应页` : undefined,
  };
}

/** 阶段总结 HTML 模型（合并版与单项目稿共用；单项目稿传单项目 deck 即可） */
export function buildSummaryDeckModel(deck: SummaryDeckData, outline: SummaryOutlineItem[]): DeckHtmlModel {
  const cover = outline.find((o) => o.layout === 'cover');
  const lead = cover?.bullets.find((x) => String(x ?? '').trim()) ?? `${deck.periodLabel}阶段总结：进展、问题与下阶段计划。`;
  const names = deck.projects.map((p) => p.name).join('、') || '全部项目';
  return {
    kind: 'summary',
    title: `${names} 阶段性总结`,
    lead,
    meta: [
      { label: '周期', value: deck.periodLabel },
      { label: '范围', value: `${deck.range.start} ~ ${deck.range.end}` },
      { label: '项目数', value: `${deck.projects.length} 个` },
      { label: '数据截至', value: deck.dataAsOf },
    ],
    pages: outline.map((item) => toPage(item, deck)),
    chromeLeft: '阶段性总结',
    chromeRight: deck.periodLabel,
  };
}

/** 单份总结稿的 HTML（合并版或单项目版） */
export function buildSummaryHtml(deck: SummaryDeckData, outline: SummaryOutlineItem[]): string {
  return renderDeckHtml(buildSummaryDeckModel(deck, outline));
}
