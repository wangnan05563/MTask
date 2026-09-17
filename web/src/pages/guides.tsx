import {
  Archive, Boxes, ClipboardList, CalendarClock, Compass, Database, Download, History,
  Layers, Lightbulb, ListTodo, RefreshCw, Rocket, ScrollText, Settings, Sparkles,
  Table2, Upload, Wand2,
} from 'lucide-react';
import type { GuideStep } from './PageGuide';
import { PROJECT_GUIDE_STEPS, GUIDE_SEEN_KEY } from './ProjectGuide';

/**
 * T00706：各菜单使用向导的内容配置（壳组件见 PageGuide.tsx）。
 * 参考项目管理向导（T00665）的模式：每个菜单 = 认识模块 → 核心功能 → 进阶技巧，
 * 步骤文案与实际页面功能一一对应；接入点在 App.tsx（导航右侧常驻「向导」按钮 + 首次进入自动弹出）。
 */

export interface GuideEntry {
  /** 弹窗标题（如「任务 · 使用向导」） */
  readonly title: string;
  /** 已读状态 localStorage 键（清缓存后恢复初始引导） */
  readonly seenKey: string;
  readonly steps: readonly GuideStep[];
}

/** 轻量「功能磁贴」演示视觉：无动画，罗列本步涉及的功能要点 */
function Chips({ items }: { readonly items: readonly { icon: React.ReactNode; label: string }[] }) {
  return (
    <div style={{ background: 'var(--surface-2, rgba(0,0,0,.03))', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
        {items.map((x) => (
          <span key={x.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }}>
            {x.icon}{x.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const chip = (icon: React.ReactNode, label: string) => ({ icon, label });

/** 任务菜单（TasksPage） */
const TASK_STEPS: GuideStep[] = [
  {
    title: '认识「任务」',
    icon: Compass,
    desc: '待办任务的处理中枢：按项目管理待办，配合 AI 状态流转完成「处理 → 回传 → 审核 → 归档」闭环。',
    points: [
      '左侧选择项目：下拉支持排序 / 置顶 / 重命名，任务按项目分组展示',
      '列表分「待办」与「已完成」两区，支持多选批量操作与优先级筛选',
      '每条任务可展开查看描述与 AI 处理结果，行内直接编辑保存',
    ],
    visual: <Chips items={[chip(<ListTodo size={13} />, '待办 / 已完成'), chip(<Layers size={13} />, '多选批量'), chip(<Wand2 size={13} />, 'AI 状态流转')]} />,
  },
  {
    title: 'AI 状态与审核',
    icon: Wand2,
    desc: '任务旁的状态图标反映 AI 侧的处理进度，回写结论需要人工审核转正。',
    points: [
      '转圈 = AI 处理中；绿点 = 处理完成（点击展开查看结果）；红标 = 中断 / 失败（可重新处理）',
      '「AI回写待审核」前缀的任务：点击展开描述与处理结果，审核通过后编辑标题去掉前缀即恢复正常',
      '「验证失败」反馈会随处理结果一起保存，修复后重新处理即可',
    ],
  },
  {
    title: '效率技巧',
    icon: Rocket,
    desc: '把高频操作收进一次点击。',
    points: [
      'Ctrl+F 打开全局命令面板：跨菜单搜索与跳转',
      '批量操作：多选任务后可一次性修改状态 / 归档 / 调整优先级',
      '「全部展开 / 收起」一键查看所有任务的描述与 AI 摘要',
    ],
  },
];

/** 模型菜单（AIToolsPage） */
const AITOOLS_STEPS: GuideStep[] = [
  {
    title: '认识「模型」',
    icon: Compass,
    desc: '管理 AI 厂商连接配置：模型菜单维护各 AI 服务（Base URL / API Key / 模型名），供全应用调用。',
    points: [
      '「新增配置」录入一条 AI 厂商配置（地址、密钥、模型）',
      '编辑配置时保留原 API Key，不必重复粘贴密钥',
      '不再使用的配置可归档：列表不再显示，记录保留在库中',
    ],
    visual: <Chips items={[chip(<Boxes size={13} />, '厂商配置'), chip(<Database size={13} />, 'API Key 保管'), chip(<Archive size={13} />, '归档保留')]} />,
  },
  {
    title: '默认工具设定',
    icon: Sparkles,
    desc: '两类 AI 能力分别指定默认配置，调用时无需每次手选。',
    points: [
      '「默认开发」：开发类 AI 功能（代码生成 / 工具调用）使用的配置',
      '「默认整理」：整理类 AI 功能（摘要 / 回写整理）使用的配置',
      '切换默认只需在对应配置上点一次，立即全局生效',
    ],
  },
];

/** 提示词菜单（PromptsPage） */
const PROMPTS_STEPS: GuideStep[] = [
  {
    title: '认识「提示词」',
    icon: Compass,
    desc: '沉淀可复用的提示词库：按分类组织、支持排序检索，一键变成待办任务。',
    points: [
      '「新建分类」建立自己的分组体系；「删除分类」时其下提示词回到未分类',
      '每条提示词支持新建 / 编辑 / 归档（数据保留，列表不再显示）',
      '「复制」把内容送入剪贴板，随时粘贴到任何地方使用',
    ],
    visual: <Chips items={[chip(<ScrollText size={13} />, '分类组织'), chip(<ClipboardList size={13} />, '一键复制'), chip(<Archive size={13} />, '归档保留')]} />,
  },
  {
    title: '复制到待办任务',
    icon: ListTodo,
    desc: '提示词不只是备忘——它可以直接驱动执行。',
    points: [
      '「复制到待办任务」：以该提示词在「收件箱」项目创建一条待办',
      '支持选择目标项目后再确认复制',
      '配合任务菜单的 AI 处理流程，实现「提示词 → 待办 → AI 执行」链路',
    ],
  },
];

/** 通用需求菜单（ReqPage） */
const REQ_STEPS: GuideStep[] = [
  {
    title: '认识「通用需求」',
    icon: Compass,
    desc: '跨项目复用的通用需求条目库，结构与「提示词」菜单一致（同一套交互逻辑）。',
    points: [
      '「新建分类」组织需求分组；「删除分类」时其下需求回到未分类',
      '每条需求支持新建 / 编辑 / 删除 / 复制',
      '排序字段与排序方式可自由组合，跨会话保持',
    ],
    visual: <Chips items={[chip(<Lightbulb size={13} />, '需求条目'), chip(<Layers size={13} />, '分类分组'), chip(<RefreshCw size={13} />, '组合排序')]} />,
  },
  {
    title: '复制到待办任务',
    icon: ListTodo,
    desc: '把通用需求落成可执行的任务。',
    points: [
      '「复制到待办任务」：以该需求在「收件箱」项目创建一条待办',
      '支持选择目标项目后再确认复制',
      '与「从 PRD 导入」（项目管理）互补：零散需求走这里，整份 PRD 走项目管理',
    ],
  },
];

/** AI 工作台菜单（ReportPage） */
const REPORT_STEPS: GuideStep[] = [
  {
    title: '认识「AI 工作台」',
    icon: Compass,
    desc: 'AI 能力的执行面板：周报生成、项目计划导入、控制台日志统一由主容器承载。',
    points: [
      '「AI 周报生成」：结合真实任务数据由 AI 撰写洞察并按内置 skill 版式合成',
      '「离线周报生成」：本地聚合数据按模板合成报表，不调用 AI',
      '生成的洞察摘要可勾选写入「收件箱」项目的一条待办，便于后续跟进',
    ],
    visual: <Chips items={[chip(<Sparkles size={13} />, 'AI 周报'), chip(<Table2 size={13} />, '离线报表'), chip(<ListTodo size={13} />, '洞察写回待办')]} />,
  },
  {
    title: '模板与导入',
    icon: Upload,
    desc: '报表模板与项目计划的批量入口。',
    points: [
      '工作面板内含模板管理：导入 .xlsx / .docx 模板，也可删除不需要的模板',
      '「AI 项目计划导入」：上传 Excel / 需求文档，AI 解析为计划草稿并批量入库（本页直接执行）',
      '「从 PRD 导入项目计划」：AI 拆分 WBS + 逐条提取需求，生成计划与需求跟踪矩阵（可选同步待办）',
    ],
  },
  {
    title: '控制台与文档区',
    icon: Rocket,
    desc: '长过程的可见性：所有 AI 执行日志统一输出到控制台。',
    points: [
      '「收起文档区」全屏显示 AI 控制台，专注观察执行过程；「展开文档区」恢复面板',
      '「下载 AI 周报」经令牌从后台取回，下载即删（不留存服务器）',
      '控制台日志同时服务周报生成与 PRD 导入等长任务，阶段 + 时间戳可追溯',
    ],
  },
];

/** 历史资产菜单（HistoryPage） */
const HISTORY_STEPS: GuideStep[] = [
  {
    title: '认识「历史资产」',
    icon: Compass,
    desc: '项目的「档案室」：把完成使命的项目整体沉淀为快照，随时追溯或恢复。',
    points: [
      '选择一个活跃项目，整体沉淀为历史快照（任务 / 计划 / 关联数据一并封存）',
      '「恢复」把快照整体还原为活跃项目，重新出现在任务 / 项目管理菜单',
      '支持搜索快照定位历史项目',
    ],
    visual: <Chips items={[chip(<History size={13} />, '快照沉淀'), chip(<RefreshCw size={13} />, '一键恢复'), chip(<Upload size={13} />, '搜索追溯')]} />,
  },
  {
    title: '归档与软删除',
    icon: Archive,
    desc: '历史资产是「组织过程资产」，归档删除也只是软删除。',
    points: [
      '「归档删除」把整个项目内容转入归档区（软删除，可恢复）',
      '任何沉淀 / 恢复操作都保留完整的操作痕迹，不丢数据',
      '建议节奏：项目收口 → 沉淀快照 → 确认无需高频查阅后归档',
    ],
  },
];

/** 队列菜单（QueuePage） */
const QUEUE_STEPS: GuideStep[] = [
  {
    title: '认识「队列」',
    icon: Compass,
    desc: '把「任务 + AI 工具」排成执行序列，由系统按序自动驱动。',
    points: [
      '「新建今日队列」创建今天的开发队列并打开',
      '「加入队列」把选中的任务与 AI 工具送入当前队列',
      '队列按序执行：适合把一批机械性任务（批量回传 / 批量处理）交给 AI 跑',
    ],
    visual: <Chips items={[chip(<CalendarClock size={13} />, '今日队列'), chip(<ListTodo size={13} />, '任务 + 工具'), chip(<Rocket size={13} />, '按序执行')]} />,
  },
  {
    title: '结果采纳与重试',
    icon: RefreshCw,
    desc: '队列跑完不等于结束——采纳结果才算闭环。',
    points: [
      '「采纳」把 AI 结果应用到对应任务（采纳前可先查看内容）',
      '「重试失败」把队列中失败 / 超时的任务重置为待发送，再次执行',
      '「复制」可把任务内容取出到剪贴板，便于人工介入处理',
    ],
  },
];

/** 设置菜单（SettingsPage） */
const SETTINGS_STEPS: GuideStep[] = [
  {
    title: '认识「设置」',
    icon: Compass,
    desc: '应用级偏好与数据安全的集中管理。',
    points: [
      '主题：浅色 / 深色一键切换，全局即时生效',
      '任务分类：新增 / 编辑 / 删除分类（删除后其下任务回到未分类）',
      '日志 / 归档入口也收敛在本页（内网穿透下方）',
    ],
    visual: <Chips items={[chip(<Settings size={13} />, '主题切换'), chip(<Layers size={13} />, '任务分类'), chip(<Download size={13} />, '备份恢复')]} />,
  },
  {
    title: '数据备份与更新',
    icon: Download,
    desc: '数据无价：定期备份；版本更新一键检查。',
    points: [
      '「导出数据」把全部用户数据下载为备份文件；导入前请先导出一份',
      '「选择备份文件」从 JSON 备份恢复数据（覆盖现有数据，请谨慎）',
      '「检查更新」拉取 GitHub 最新 Release 与当前版本比较；也可下载安装包 / 查看 Release 页',
    ],
  },
];

/** 全部菜单的向导注册表：key 与 App.tsx 的 Tab 一致；项目管理复用 T00665 内容 */
export const GUIDES: Readonly<Record<string, GuideEntry>> = {
  tasks: { title: '任务 · 使用向导', seenKey: 'mtask.guide.seen.tasks', steps: TASK_STEPS },
  aitools: { title: '模型 · 使用向导', seenKey: 'mtask.guide.seen.aitools', steps: AITOOLS_STEPS },
  prompts: { title: '提示词 · 使用向导', seenKey: 'mtask.guide.seen.prompts', steps: PROMPTS_STEPS },
  req: { title: '通用需求 · 使用向导', seenKey: 'mtask.guide.seen.req', steps: REQ_STEPS },
  plan: { title: '项目管理 · 使用向导', seenKey: GUIDE_SEEN_KEY, steps: PROJECT_GUIDE_STEPS },
  report: { title: 'AI 工作台 · 使用向导', seenKey: 'mtask.guide.seen.report', steps: REPORT_STEPS },
  history: { title: '历史资产 · 使用向导', seenKey: 'mtask.guide.seen.history', steps: HISTORY_STEPS },
  queue: { title: '队列 · 使用向导', seenKey: 'mtask.guide.seen.queue', steps: QUEUE_STEPS },
  settings: { title: '设置 · 使用向导', seenKey: 'mtask.guide.seen.settings', steps: SETTINGS_STEPS },
};
