import { ArrowUpDown, CalendarRange, Compass, FileSpreadsheet, Link2, Table2 } from 'lucide-react';
import { PageGuideDialog, type GuideStep } from './PageGuide'; // T00706：向导弹窗壳抽取为通用组件，本文件只保留项目管理内容

/** T00665：项目管理向导已读状态（localStorage——清除浏览器缓存后自动恢复初始引导） */
export const GUIDE_SEEN_KEY = 'mtask.projectGuide.seen';

export const hasSeenProjectGuide = (): boolean => {
  try { return localStorage.getItem(GUIDE_SEEN_KEY) === '1'; } catch { return true; /* 隐私模式下不可读：不打扰用户 */ }
};

export const markProjectGuideSeen = (): void => {
  try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* 忽略存储失败（隐私模式） */ }
};

/** 重置引导（供「重新查看」或调试使用） */
export const resetProjectGuide = (): void => {
  try { localStorage.removeItem(GUIDE_SEEN_KEY); } catch { /* 忽略 */ }
};

interface Step { title: string; icon: typeof Compass; desc: string; points: string[]; demo: 'sort' | 'gantt' | 'matrix' | 'import' | 'overview'; }

const STEPS: Step[] = [
  {
    title: '认识「项目管理」',
    icon: Compass,
    desc: '本模块用于按项目组织计划任务（原「项目计划」菜单，已升级为项目管理模块）。',
    points: [
      '左侧选择项目：下拉展示全部活跃项目，并附计划统计徽标（已完成/进行中/待开始）',
      '中部为计划列表或甘特视图：按工作日串行排期，自动跳过周末与节假日',
      '相邻入口：需求跟踪矩阵（PRD 需求 ↔ 计划/待办关联）、节假日管理、Excel 导入导出',
    ],
    demo: 'overview',
  },
  {
    title: '项目排序与置顶',
    icon: ArrowUpDown,
    desc: '项目下拉支持排序与置顶，与「任务菜单」完全一致的交互（同一套逻辑）。',
    points: [
      '排序按钮（项目下拉旁，悬浮工具栏显示）：默认/名称/创建时间/待办数量共 7 种方式，选择后跨会话保持',
      '置顶：下拉中项目名左侧图钉，点击后该项目在默认排序下排最前（服务端持久化）',
      '拖拽排序：默认排序下可直接拖动项目行调整顺序，松开即保存',
    ],
    demo: 'sort',
  },
  {
    title: '列表与甘特视图',
    icon: CalendarRange,
    desc: '两种视图自由切换，均按「串行瀑布」时间线自动排期。',
    points: [
      '列表视图：行内直接编辑标题/工期/负责人/进度/状态，悬浮行展开全部字段',
      '甘特视图：横向时间轴 + 周末/节假日底纹 + 今日线，进度内嵌任务条',
      '修改工期或节假日 → 全项目时间线自动重排（同一事务内完成）',
    ],
    demo: 'gantt',
  },
  {
    title: '需求跟踪矩阵',
    icon: Table2,
    desc: '由「从 PRD 导入项目计划」生成，也可手动维护——追踪每条需求覆盖到哪些计划与待办。',
    points: [
      '矩阵行：需求编号 / 标题 / 状态 / PRD 原文定位',
      '关联列：展示该需求关联的计划任务与待办任务（含状态色）',
      '「关联」按钮：勾选即建立关联、取消即解除；支持新增/删除/行内编辑需求',
    ],
    demo: 'matrix',
  },
  {
    title: '导入导出与节假日',
    icon: FileSpreadsheet,
    desc: '批量进出的两条通道 + 时间线基准维护。',
    points: [
      'Excel：下载空白模板 → 填好后导入（自动重排时间线）；也可导出当前计划',
      'AI 导入：到「AI 工作台」用「AI 项目计划导入」或「从 PRD 导入项目计划」卡片',
      '节假日：手动维护或联网导入法定节假日，导入后所有项目计划自动重排',
    ],
    demo: 'import',
  },
];

/** T00665：演示区——用轻量 CSS 动画模拟关键交互（无需录屏，可随组件复用） */
function StepDemo({ kind }: { readonly kind: Step['demo'] }) {
  const box: React.CSSProperties = { background: 'var(--surface-2, rgba(0,0,0,.03))', border: '1px solid var(--border)', borderRadius: 8, padding: 10, minHeight: 108, position: 'relative', overflow: 'hidden' };
  if (kind === 'sort') {
    return (
      <div style={box} aria-label="排序与置顶交互演示">
        <style>{`
          @keyframes pg-menu { 0%,15% { opacity:0; transform:translateY(-4px) } 30%,55% { opacity:1; transform:none } 70%,100% { opacity:0; transform:translateY(-4px) } }
          @keyframes pg-pin { 0%,40% { transform:none; color:var(--text-muted) } 60%,100% { transform:rotate(-45deg) scale(1.15); color:var(--accent) } }
          @keyframes pg-drag { 0%,50% { transform:translateY(0) } 70%,85% { transform:translateY(-22px); opacity:.7 } 100% { transform:translateY(-22px) } }
          .pg-anim-menu { animation: pg-menu 4s ease-in-out infinite; }
          .pg-anim-pin { animation: pg-pin 4s ease-in-out infinite; display:inline-flex; }
          .pg-anim-drag { animation: pg-drag 4s ease-in-out infinite; }
        `}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          <ArrowUpDown size={12} /> 排序菜单
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            图钉置顶
            {' '}
            <span className="pg-anim-pin" aria-hidden>📌</span>
          </span>
        </div>
        <div className="pg-anim-menu" style={{ marginTop: 6, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: 4, fontSize: 11 }}>
          <div style={{ padding: '2px 6px' }}>默认（置顶优先）</div>
          <div style={{ padding: '2px 6px', background: 'var(--accent-soft)', borderRadius: 4 }}>名称 A → Z</div>
          <div style={{ padding: '2px 6px' }}>待办数量：多 → 少</div>
        </div>
        <div className="pg-anim-drag" style={{ marginTop: 6, fontSize: 11, background: 'var(--card-bg)', border: '1px dashed var(--accent)', borderRadius: 6, padding: '3px 6px' }}>
          ⠿ 拖拽项目行调整顺序（松开即保存）
        </div>
      </div>
    );
  }
  if (kind === 'gantt') {
    return (
      <div style={box} aria-label="甘特排期演示">
        <style>{`@keyframes pg-bar { 0%,10% { width:18% } 60%,100% { width:62% } } .pg-anim-bar { animation: pg-bar 4s ease-in-out infinite; }`}</style>
        <div style={{ display: 'flex', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
          {['一', '二', '三', '四', '五', '六', '日', '一', '二'].map((d, i) => (
            <span key={`${d}-${i}`} style={{ flex: 1, textAlign: 'center', background: (i === 5 || i === 6) ? 'var(--danger-soft, rgba(220,38,38,.10))' : 'transparent', borderRadius: 3 }}>{d}</span>
          ))}
        </div>
        <div style={{ marginTop: 8, height: 16, background: 'var(--accent-soft)', borderRadius: 4, width: '62%' }}>
          <div className="pg-anim-bar" style={{ height: 16, background: 'var(--accent)', borderRadius: 4, display: 'flex', alignItems: 'center', paddingLeft: 6, fontSize: 10, color: 'var(--accent-text)' }}>任务 A 62%</div>
        </div>
        <div style={{ marginTop: 6, height: 16, background: 'var(--surface-2, rgba(0,0,0,.05))', borderRadius: 4, width: '46%' }}>
          <div style={{ height: 16, background: 'var(--text-muted)', opacity: .5, borderRadius: 4, width: '30%' }} />
        </div>
        <div style={{ position: 'absolute', top: 26, bottom: 8, left: '58%', width: 1, background: 'var(--danger)' }} title="今日线" />
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>周末/节假日底纹 + 今日线；工期变更后自动重排</div>
      </div>
    );
  }
  if (kind === 'matrix') {
    return (
      <div style={box} aria-label="需求跟踪矩阵演示">
        <style>{`@keyframes pg-link { 0%,20% { opacity:.25; transform:scaleX(.6) } 45%,80% { opacity:1; transform:scaleX(1) } 100% { opacity:.25 } } .pg-anim-link { transform-origin:left center; animation: pg-link 4s ease-in-out infinite; }`}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 4, padding: '2px 6px' }}>REQ-001 对账规则配置</span>
          <span className="pg-anim-link" style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent)' }}><Link2 size={14} /></span>
          <span style={{ border: '1px solid var(--border-strong)', borderRadius: 4, padding: '2px 6px' }}>3 对账规则配置开发</span>
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 4, padding: '2px 6px' }}>REQ-002 差异明细查询</span>
          <span className="pg-anim-link" style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent)', animationDelay: '.4s' }}><Link2 size={14} /></span>
          <span style={{ border: '1px solid var(--border-strong)', borderRadius: 4, padding: '2px 6px' }}>T1042 差异明细查询</span>
          <span style={{ color: 'var(--success)', fontSize: 10 }}>✓ 已验证</span>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>勾选即建立关联 / 取消即解除；支持增删改需求</div>
      </div>
    );
  }
  if (kind === 'import') {
    return (
      <div style={box} aria-label="导入导出演示">
        <style>{`@keyframes pg-flow { 0% { opacity:0; transform:translateX(-8px) } 40%,80% { opacity:1; transform:none } 100% { opacity:0 } } .pg-anim-flow { animation: pg-flow 4s ease-in-out infinite; }`}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span style={{ border: '1px dashed var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>📄 计划模板.xlsx</span>
          <span className="pg-anim-flow" style={{ color: 'var(--accent)', fontSize: 14 }}>➜</span>
          <span style={{ border: '1px solid var(--accent)', borderRadius: 6, padding: '6px 10px', color: 'var(--accent)' }}>导入并自动排期</span>
        </div>
        <div className="pg-anim-flow" style={{ marginTop: 10, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px', animationDelay: '.5s' }}>
          ✨ AI 工作台：AI 项目计划导入 / 从 PRD 导入（拆分 WBS + 生成需求矩阵）
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>节假日维护或导入后，所有项目计划时间线自动重排</div>
      </div>
    );
  }
  // overview
  return (
    <div style={box} aria-label="模块总览演示">
      <div style={{ display: 'flex', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
        {[
          { icon: <CalendarRange size={13} />, label: '列表 / 甘特视图' },
          { icon: <Table2 size={13} />, label: '需求跟踪矩阵' },
          { icon: <ArrowUpDown size={13} />, label: '排序 / 置顶' },
          { icon: <FileSpreadsheet size={13} />, label: 'Excel 导入导出' },
        ].map((x) => (
          <span key={x.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }}>
            {x.icon}{x.label}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        项目管理 = 项目维度的时间线管理中枢：从需求（PRD 矩阵）→ 计划（甘特/列表）→ 待办（任务联动）全链路贯通。
      </div>
    </div>
  );
}

/**
 * T00665：项目管理菜单向导引导弹窗。
 * - 首次进入项目管理模块自动弹出（由调用方依据 hasSeenProjectGuide 判定）；
 * - 右上角常驻向导按钮可随时重新唤起；
 * - 「开始体验」/「跳过」均由调用方记录已看状态（localStorage，清缓存后恢复初始引导）；
 * - 每步内嵌轻量 CSS 演示动画（可复用演示素材，无需录屏）；
 * - T00706：弹窗壳（步骤指示/翻页/跳过）委托给通用 PageGuideDialog，本文件只保留步骤内容。
 */
export const PROJECT_GUIDE_STEPS: GuideStep[] = STEPS.map((s) => ({
  title: s.title,
  icon: s.icon,
  desc: s.desc,
  points: s.points,
  visual: <StepDemo kind={s.demo} />,
}));

export function ProjectGuideDialog({ open, onClose }: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return <PageGuideDialog open={open} onClose={onClose} title="项目管理 · 使用向导" steps={PROJECT_GUIDE_STEPS} />;
}
