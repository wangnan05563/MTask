/**
 * T03240（PRD AI-101 ①③）：报表溯源单源。
 *
 * 「同款溯源段」要求面板与导出稿逐字同源，故行文案只在这里生成一次：
 * 前端面板、xlsx/docx/pptx/pdf 四个构建器、AI 生成的 SSE done 负载全部消费同一个
 * `provenanceRows()` 结果——四处各写一份文案必然漂移。
 *
 * 本模块只依赖 ReportData 的类型（`import type`），不反向 import ReportService 的运行时，
 * ReportService ↔ report-builder ↔ reportProvenance 之间不会形成循环。
 */
import type { ReportData } from './ReportService';

/** 任务「处理结果」注入 AI prompt 时的截断阈值（与 gatherReportData 同口径） */
export const HANDLE_RESULT_LIMIT = 600;

export interface ReportProvenance {
  /** 卡片标识（aiCards.ts 单源），供前端按卡记忆溯源面板展开态 */
  cardKey: string;
  generatedAt: string;
  period: string;
  periodLabel: string;
  window: { startDate: string; endDate: string };
  sources: { projects: number; tasks: number; plans: number; projectScope: string[] | null };
  /** 截断说明；无截断为 null（不写「0 条」，避免读成「有截断但为 0」） */
  truncation: { count: number; limit: number; note: string } | null;
  /** 参与生成的模型名；离线（未调用 AI）为 null */
  model: string | null;
  /** 展示/导出共用的行文案（面板与四种导出格式逐字同源） */
  rows: ProvenanceRow[];
}

export interface ProvenanceRow { label: string; value: string }

/** 溯源段唯一文案源：面板与导出稿都渲染这里返回的行 */
export function provenanceRows(p: ReportProvenance): ProvenanceRow[] {
  return [
    { label: '数据来源', value: `${p.sources.projects} 个项目 / ${p.sources.tasks} 条任务 / ${p.sources.plans} 条计划` },
    { label: '项目范围', value: p.sources.projectScope?.length ? p.sources.projectScope.join('、') : '全部项目' },
    { label: '时间窗', value: `${p.window.startDate} ~ ${p.window.endDate}（${p.periodLabel}）` },
    { label: '截断', value: p.truncation ? p.truncation.note : '无' },
    { label: '模型', value: p.model ?? '未调用 AI（本地聚合）' },
    { label: '生成时间', value: p.generatedAt },
  ];
}

/** 每个构建器都要的纯文本行（`标签：值`），导出稿的「溯源」段即逐行落地 */
export function provenanceTextLines(p: ReportProvenance): string[] {
  return p.rows.map((r) => `${r.label}：${r.value}`);
}

/**
 * 从报表数据派生溯源。`cardKey`/`model` 由调用方给：gatherReportData 不知道是哪张卡、
 * 走没走 AI；把这两项留给调用层，才能让「同一份数据、离线导出 / AI 生成」各说各的真实来源。
 */
export function buildReportProvenance(
  data: ReportData,
  opts: { cardKey: string; model?: string | null },
): ReportProvenance {
  const count = data.truncatedTasks ?? 0;
  const p: Omit<ReportProvenance, 'rows'> = {
    cardKey: opts.cardKey,
    generatedAt: data.generatedAt,
    period: data.period,
    periodLabel: data.periodLabel,
    window: { startDate: data.startDate, endDate: data.endDate },
    sources: {
      projects: data.projects.length,
      tasks: data.tasks.length,
      plans: data.plans.length,
      projectScope: data.projectScope ?? null,
    },
    truncation: count > 0
      ? { count, limit: HANDLE_RESULT_LIMIT, note: `${count} 条任务的处理结果超过 ${HANDLE_RESULT_LIMIT} 字已截断，全文见任务详情` }
      : null,
    model: opts.model ?? null,
  };
  return { ...p, rows: provenanceRows(p as ReportProvenance) };
}
