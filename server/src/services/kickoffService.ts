/**
 * T02095：「项目启动会 PPT 生成」前置校验（PRD-项目启动会PPT生成 §3.2 FR-2）。
 *
 * 施工契约见 `docs/技术方案-项目启动会PPT生成.md` §2.1：本文件**只读、零 AI 调用**（FR-2.3），
 * 直接复用各 Service 的既有查询而不是自开聚合 SQL——校验口径必须与页面实际条数一致
 * （验收 3），另起一套查询迟早漂移。
 *
 * `workloadSource` 取估算侧的 `countedKeys` 而非「数一遍 estimate_items」：汇总会排除里程碑等
 * 不参与计算的角色，自己数出来的条数与 PPT 工作量页的合计口径可能对不上，降级判断就会 flip。
 */
import { statSync } from 'node:fs';
import { getDb } from '../db/connection';
import { PlanService } from './PlanService';
import { TestCaseService } from './TestCaseService';
import { estimatesSnapshot } from '../routes/estimates';

export type PreflightKey = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
/** ✓ / ⚠ / ✕（FR-2.2）：`warn` 是可降级继续，`fail` 是缺料 */
export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightItem {
  key: PreflightKey;
  label: string;
  /** 实际条数（面板 checklist 直接显示，与对应端点返回一致） */
  count: number;
  status: PreflightStatus;
  /** 一句「怎么补」，warn 级还要说明降级后果 */
  note: string;
  /** 前端深链：`plan?menu=*` 落项目管理面板，`report?card=*` 落 AI 工作台卡片 */
  deepLink: string;
  /** 硬缺失项（P1/P2/P3）：三项同时 fail 才整体阻塞（FR-2.4） */
  hard: boolean;
}

export interface PreflightResult {
  projectId: string;
  projectName: string;
  items: PreflightItem[];
  blocked: boolean;
  /** fail 的硬项 key，供「按钮置灰 + 点名 3 条深链」（验收 2） */
  missingHard: PreflightKey[];
  workloadSource: 'estimate' | 'duration';
}

/** FR-2.1 判定阈值单源（改这里而不是散在各项里） */
const MIN_PRD_DOCS = 1;
const MIN_REQUIREMENTS = 3; // <3 视为「未梳理」
const MIN_PLANS = 3;
const MIN_DATE_FILL_RATE = 0.6; // 起始/完成日期填充率，低于则时间线页无法绘制
const MIN_WORKLOAD_FILL_RATE = 0.8; // 复杂度/工期非空率，低于则工作量页留降级标记

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

/** 与工作空间实际语义一致：路径存在且是目录才算「可引用素材」（同 `WorkspaceService.getProjectWorkspace` 的三条守卫） */
function workspaceInfo(projectId: string): { path: string | null; reason: string } {
  const row = getDb()
    .prepare('SELECT workspace_path FROM projects WHERE id = ?')
    .get(projectId) as { workspace_path: string | null } | undefined;
  const path = row?.workspace_path ?? '';
  if (!path) return { path: null, reason: '该项目未配置工作空间（项目管理 → 选择工作空间）' };
  try {
    if (!statSync(path).isDirectory()) return { path: null, reason: `工作空间路径不是目录：${path}` };
  } catch {
    return { path: null, reason: `工作空间目录不可访问（已移动或删除？）：${path}` };
  }
  return { path, reason: '' };
}

export function preflight(projectId: string): PreflightResult {
  if (!projectId) throw new Error('projectId 必填');
  const brief = PlanService.getProjectBrief(projectId);
  const docs = PlanService.listPrdDocs(projectId);
  const reqs = PlanService.listRequirements(projectId);
  const plans = PlanService.list(projectId); // 已滤归档（T00442 语义）
  const milestones = plans.filter((p) => p.kind === 'milestone');
  const cases = TestCaseService.stats(projectId);
  const cov = TestCaseService.coverage(projectId);
  const ws = workspaceInfo(projectId);
  const summary = estimatesSnapshot(projectId).summary;

  // P3 的日期口径要起止都有：时间线按 min(start)~max(end) 线性映射，缺任一端就画不出条
  const dated = plans.filter((p) => !!p.start_date?.trim() && !!p.end_date?.trim()).length;
  const rated = plans.filter((p) => p.complexity != null || (p.duration_days ?? 0) > 0).length;
  const linkedReq = reqs.filter((r) => r.linkedPlans.length > 0).length;
  const dateRateOk = plans.length > 0 && dated / plans.length >= MIN_DATE_FILL_RATE;
  const workloadRateOk = plans.length > 0 && rated / plans.length >= MIN_WORKLOAD_FILL_RATE;

  const items: PreflightItem[] = [
    {
      key: 'P1',
      label: 'PRD 文档',
      count: docs.length,
      hard: true,
      deepLink: 'plan?menu=prd',
      status: docs.length >= MIN_PRD_DOCS ? 'ok' : 'fail',
      note: docs.length >= MIN_PRD_DOCS
        ? `${docs.length} 份原文，背景页/技术页据此引用`
        : `还没有 PRD 原文——在「项目管理 → PRD 管理」导入，或用 AI 工作台「原始需求生成 PRD」卡片生成`,
    },
    {
      key: 'P2',
      label: '需求矩阵',
      count: reqs.length,
      hard: true,
      deepLink: 'plan?menu=matrix',
      status: reqs.length >= MIN_REQUIREMENTS ? 'ok' : 'fail',
      note: reqs.length >= MIN_REQUIREMENTS
        ? `${reqs.length} 条需求，其中 ${linkedReq} 条已关联计划`
        : `需求矩阵仅 ${reqs.length} 条（<${MIN_REQUIREMENTS} 视为未梳理）——矩阵面板可直接补录，或走「从 PRD 导入项目计划」批量提取`,
    },
    {
      key: 'P3',
      label: '项目计划',
      count: plans.length,
      hard: true,
      deepLink: 'report?card=prd-import',
      status: plans.length < MIN_PLANS ? 'fail' : dateRateOk ? 'ok' : 'warn',
      note:
        plans.length < MIN_PLANS
          ? `未归档计划仅 ${plans.length} 条（<${MIN_PLANS}）——用 AI 工作台「从 PRD 导入项目计划」拆分 WBS`
          : !dateRateOk
            ? `${plans.length} 条计划中 ${plans.length - dated} 条缺起止日期（填充率 ${pct(dated, plans.length)}%，<60%）——时间线页将降级为列表，请在项目管理页补齐日期`
            : dated === plans.length
              ? `${plans.length} 条计划均有起止日期，时间线页按真实排期绘制`
              : `${dated}/${plans.length} 条有起止日期（${pct(dated, plans.length)}%，≥60%）——剩余 ${plans.length - dated} 条无排期，时间线页画不出这些条`,
    },
    {
      key: 'P4',
      label: '里程碑',
      count: milestones.length,
      hard: false,
      deepLink: 'plan',
      status: milestones.length >= 1 ? 'ok' : 'warn',
      note:
        milestones.length >= 1
          ? `${milestones.length} 个里程碑，时间线页绘制菱形节点`
          : `没有里程碑行（计划类型=阶段里程碑）——时间线页降级为按日期排序的计划列表`,
    },
    {
      key: 'P5',
      label: '测试用例',
      count: cases.total,
      hard: false,
      deepLink: 'report?card=tc-gen',
      status: cases.total > 0 ? 'ok' : 'warn',
      note:
        cases.total === 0
          ? '本期未建用例——覆盖率页改写「测试策略按 PRD 验收标准描述」'
          : `${cases.total} 条用例，需求覆盖率 ${cov.rate}%${cov.uncovered > 0 ? `（${cov.uncovered} 条需求未覆盖，页面上如实标注）` : ''}`,
    },
    {
      key: 'P6',
      label: '复杂度/工期',
      count: rated,
      hard: false,
      deepLink: 'plan',
      status: workloadRateOk ? 'ok' : 'warn',
      note:
        plans.length === 0
          ? '无计划行可校验——工作量页无数据源'
          : workloadRateOk
            ? `${rated}/${plans.length} 条有计划数据（${pct(rated, plans.length)}%），工作量页数据完整`
            : `仅 ${rated}/${plans.length} 条有计划数据（${pct(rated, plans.length)}%，<80%）——工作量页页脚标注「工期由排期推导，建议复核」`,
    },
    {
      key: 'P7',
      label: '工作空间',
      count: ws.path ? 1 : 0,
      hard: false,
      deepLink: 'plan',
      status: ws.path ? 'ok' : 'warn',
      note: ws.path ? `${ws.path} 可访问，技术章节可引用其中素材` : `${ws.reason}——技术章节只写计划口径`,
    },
  ];

  const hardItems = items.filter((i) => i.hard);
  const missingHard = hardItems.filter((i) => i.status === 'fail').map((i) => i.key);
  return {
    projectId,
    projectName: brief.name,
    items,
    // FR-2.4：P1+P2+P3 同时 ✕ 才阻塞（部分缺失仍可生成，页面上留痕）
    blocked: hardItems.length > 0 && missingHard.length === hardItems.length,
    missingHard,
    workloadSource: summary.countedKeys.length > 0 ? 'estimate' : 'duration',
  };
}
