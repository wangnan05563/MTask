/**
 * T03197（PRD PM-404 / 整合 D-09）：脱敏分享快照。
 *
 * 输出一份 PDF：项目统计 + 里程碑 + 逾期计划摘要。三条硬约束：
 * 1. **默认不含计划标题**（`includeTitles=false`），只有调用方显式选择才带入——选择时 UI 必须给出明确提示；
 * 2. 快照**只查白名单字段**（计划 id/标题/排期/进度/状态/deps 结构边），绝不读取任务描述、
 *    AI 摘要、处理结果、事件明细或任何密钥；deps 仅用于数子项，不落进文档；
 * 3. 页脚恒含项目名、生成时间与时区，PDF 内不留可回连内部数据的标识。
 *
 * 逾期口径不另立一套：直接复用 {@link OverdueRateService}（D-12：边界日当天不算到期、
 * 无日期/归档计划不进分母、分母为 0 时率显示「暂无可比计划」而非 0%）。
 */
import { createRequire } from 'node:module';
import { getDb } from '../db/connection';
import { childParentIds } from '../util/milestoneChild';
import { isPastEndDate, ymdInTimezone } from '../util/workdays';
import { safeExportName } from '../util/export-name';
import { OverdueRateService, systemTz } from './OverdueRateService';

/**
 * 按需加载 prdExport（pdfkit/docx 较重）。
 * 这里用 CJS require 而非 `import()`：服务端以 tsx CJS 运行，动态 import() 走 ESM 解析，
 * 无扩展名的 `./prdExport` 不会被补成 `.ts`（实测直接 400 Cannot find module）。
 */
const requireCjs = createRequire(__filename);

export type ShareSnapshotStatus = 'todo' | 'doing' | 'done' | 'blocked';

export interface ShareSnapshotMilestone {
  /** 标题已隐藏时为占位（不含原始标题） */
  title: string;
  startDate: string;
  endDate: string;
  progress: number;
  status: string;
  childTotal: number;
  childDone: number;
}

export interface ShareSnapshotOverdueRow {
  title: string;
  endDate: string;
  progress: number;
  status: string;
}

export interface ShareSnapshotData {
  projectId: string;
  projectName: string;
  /** 是否包含计划标题（含标题时数据里才有真实标题） */
  includeTitles: boolean;
  /** 统计日（YYYY-MM-DD，与逾期口径同一业务日） */
  at: string;
  tz: string;
  generatedAt: string;
  stats: {
    tasks: { total: number; done: number; open: number };
    plans: { total: number; done: number; doing: number; milestones: number };
  };
  milestones: ShareSnapshotMilestone[];
  overdue: {
    dueTotal: number;
    overdue: number;
    doneDue: number;
    /** 0..1；分母为 0 时 null（缺失 ≠ 0） */
    rate: number | null;
    rows: ShareSnapshotOverdueRow[];
  };
}

const STATUS_LABEL: Record<string, string> = { todo: '待开始', doing: '进行中', done: '已完成', blocked: '受阻' };

function statusText(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function hiddenTitle(prefix: string, index: number): string {
  return `${prefix} ${index + 1}（标题已隐藏）`;
}

/** 生成时间按快照口径格式化（与页脚时区同源，避免本机 locale 与声明时区打架） */
function formatGeneratedAt(now: Date, tz: string): string {
  try {
    return now.toLocaleString('zh-CN', { timeZone: tz, hour12: false });
  } catch {
    return now.toLocaleString('zh-CN');
  }
}

interface PlanRow {
  id: string;
  title: string;
  kind: string | null;
  start_date: string;
  end_date: string;
  progress: number;
  status: string;
  deps: string | null;
}

/**
 * 只读取数（纯函数入口，供路由与门禁复用）。
 * 注意：`plans` 的 SELECT 只有白名单列——新增字段必须人工确认不含敏感内容。
 */
export function buildShareSnapshot(args: { projectId: string; includeTitles?: boolean; now?: Date }): ShareSnapshotData {
  const db = getDb();
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(args.projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) throw new Error('项目不存在');

  const includeTitles = args.includeTitles === true;
  const now = args.now ?? new Date();
  const tz = systemTz();
  const at = ymdInTimezone(now, tz);
  const ref = new Date(`${at}T12:00:00`); // 与 OverdueRateService 的统计日参考时刻同口径

  const taskAgg = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE project_id = ? AND archived = 0`,
    )
    .get(project.id) as { total: number; done: number | null };
  const taskTotal = Number(taskAgg.total ?? 0);
  const taskDone = Number(taskAgg.done ?? 0);

  const plans = db
    .prepare(
      `SELECT id, title, kind, start_date, end_date, progress, status, deps
         FROM plan_tasks WHERE project_id = ? AND archived = 0
        ORDER BY start_date, sort_order`,
    )
    .all(project.id) as PlanRow[];

  const childrenByParent = new Map<string, PlanRow[]>();
  for (const row of plans) {
    for (const parentId of childParentIds(row.deps)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(row);
      childrenByParent.set(parentId, list);
    }
  }

  const milestones: ShareSnapshotMilestone[] = plans
    .filter((r) => r.kind === 'milestone')
    .map((r, i) => {
      const children = childrenByParent.get(r.id) ?? [];
      return {
        title: includeTitles ? r.title : hiddenTitle('里程碑', i),
        startDate: r.start_date,
        endDate: r.end_date,
        progress: r.progress,
        status: r.status,
        childTotal: children.length,
        childDone: children.filter((c) => c.status === 'done').length,
      };
    });

  const overdueRows = plans.filter((r) => r.status !== 'done' && isPastEndDate(r.end_date, ref, tz));
  const overdueReport = OverdueRateService.report({ projectId: project.id, at });
  const bucket = overdueReport.projects.find((p) => p.projectId === project.id);

  return {
    projectId: project.id,
    projectName: project.name,
    includeTitles,
    at,
    tz,
    generatedAt: formatGeneratedAt(now, tz),
    stats: {
      tasks: { total: taskTotal, done: taskDone, open: Math.max(0, taskTotal - taskDone) },
      plans: {
        total: plans.length,
        done: plans.filter((r) => r.status === 'done').length,
        doing: plans.filter((r) => r.status === 'doing').length,
        milestones: milestones.length,
      },
    },
    milestones,
    overdue: {
      dueTotal: bucket?.dueTotal ?? 0,
      overdue: bucket?.overdue ?? 0,
      doneDue: bucket?.doneDue ?? 0,
      rate: bucket?.rate ?? null,
      rows: overdueRows.map((r, i) => ({
        title: includeTitles ? r.title : hiddenTitle('计划行', i),
        endDate: r.end_date,
        progress: r.progress,
        status: r.status,
      })),
    },
  };
}

/** 逾期率展示：分母为 0 时给「暂无可比计划」，绝不把缺失报成 0% */
function rateText(rate: number | null): string {
  return rate === null ? '暂无可比计划' : `${(rate * 100).toFixed(1)}%`;
}

type PDFDoc = PDFKit.PDFDocument;

function renderShareSnapshot(doc: PDFDoc, data: ShareSnapshotData): void {
  const { stats } = data;

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor('#000000').text('一、项目统计');
  doc.fontSize(10).fillColor('#222222');
  doc.text(`任务：共 ${stats.tasks.total} 项，已完成 ${stats.tasks.done} 项，未完成 ${stats.tasks.open} 项`);
  doc.text(
    `计划：共 ${stats.plans.total} 项，已完成 ${stats.plans.done} 项，进行中 ${stats.plans.doing} 项，里程碑 ${stats.plans.milestones} 个`,
  );
  doc.text(
    `逾期：统计日 ${data.at}，已到期 ${data.overdue.dueTotal} 项，逾期 ${data.overdue.overdue} 项，逾期率 ${rateText(data.overdue.rate)}`,
  );

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor('#000000').text('二、里程碑');
  doc.fontSize(10).fillColor('#222222');
  if (data.milestones.length === 0) {
    doc.text('（暂无里程碑）');
  } else {
    data.milestones.forEach((m) => {
      doc.text(`${m.title}`, { continued: false });
      doc.fillColor('#444444').text(
        `排期 ${m.startDate || '—'} ~ ${m.endDate || '—'} · 进度 ${m.progress}% · 状态 ${statusText(m.status)} · 子项 ${m.childDone}/${m.childTotal} 已完成`,
        { indent: 12 },
      );
      doc.fillColor('#222222');
    });
  }

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor('#000000').text('三、逾期计划摘要');
  doc.fontSize(10).fillColor('#222222');
  if (data.overdue.rows.length === 0) {
    doc.text('（无逾期计划，或统计日没有已到期的计划）');
  } else {
    data.overdue.rows.forEach((r) => {
      doc.text(`${r.title}`);
      doc
        .fillColor('#444444')
        .text(`计划结束 ${r.endDate || '—'} · 进度 ${r.progress}% · 状态 ${statusText(r.status)}`, { indent: 12 });
      doc.fillColor('#222222');
    });
  }

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor('#000000').text('四、说明');
  doc.fontSize(10).fillColor('#222222').text(
    '本快照仅包含项目统计、里程碑与逾期计划摘要；不包含任务描述、处理结果与任何密钥。',
  );
  doc.text(
    data.includeTitles
      ? '任务标题：已按你的选择包含（请在对外分享前自行确认内容是否适合披露）。'
      : '任务标题：已隐藏（默认脱敏口径）。',
  );
}

/**
 * 生成 PDF（pdfkit 按需加载）。页脚逐页写入：项目名 · 生成时间 · 时区。
 */
export async function buildShareSnapshotPdf(args: {
  projectId: string;
  includeTitles?: boolean;
  now?: Date;
}): Promise<{ buffer: Buffer; filename: string; data: ShareSnapshotData }> {
  const data = buildShareSnapshot(args);
  const { newPdfDoc } = requireCjs('./prdExport') as typeof import('./prdExport'); // pdfkit 只在真正导出时加载
  const { doc, done, finish } = await newPdfDoc(`${data.projectName} · 项目分享快照`, { bufferPages: true });
  renderShareSnapshot(doc, data);

  const footer = `项目：${data.projectName} · 生成时间：${data.generatedAt} · 时区：${data.tz}`;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // 页脚写在页边距外：不临时归零 bottom margin，pdfkit 会判定「放不下」而自动加页（实测每页凭空多一页）
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor('#666666').text(footer, 50, doc.page.height - 38, {
      width: doc.page.width - 100,
      align: 'center',
      lineBreak: false,
    });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  await done;
  return {
    buffer: finish(),
    filename: `${safeExportName(`${data.projectName}-分享快照`, '分享快照')}.pdf`,
    data,
  };
}
