import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { api, type Project, type AITool } from '../api/client';
import { ProjectListHint, useProjectList } from '../ui/projectList'; // T02201：项目列表取数容错层
import { ProjectScopePicker, scopeSummary } from '../ui/projectScopePicker'; // T02857：范围多选器提到 ui 层（总结汇表面板复用同一份）
import { ResourceHint, useResource } from '../ui/resourceState'; // T02213：开关状态取数改走可见失败态层
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { reportStream, useReportStream } from '../reportStream';
import { ReportConsole } from './ReportConsole';
import { AiPlanImportPanel } from './AiPlanImportPanel';
import { PrdImportPanel } from './PrdImportPanel'; // T00662：从 PRD 导入项目计划
import { PrdGenPanel } from './PrdGenPanel'; // T00769：原始需求生成 PRD
import { TestCaseGenPanel } from './TestCaseGenPanel'; // T01492：从 PRD 生成测试用例
import { KickoffPptPanel } from './KickoffPptPanel'; // T02108：项目启动会 PPT 工作面板
import { SummaryPptPanel } from './SummaryPptPanel'; // T02857：阶段性项目总结汇报 PPT 工作面板
import { CodeReviewLecturePanel } from './CodeReviewLecturePanel'; // T02872：代码评审会议讲稿工作面板（三区布局）
import { useSessionState } from '../ui/session';
import { usePrdGen } from '../stores/prdGenStore'; // T01038：PRD 生成卡片统一运行状态
import { useTestCaseGen } from '../stores/testCaseGenStore'; // T01492：测试用例生成卡片运行状态
import { useKickoffPpt } from '../stores/kickoffPptStore'; // T02109：启动会 PPT 卡片运行状态
import { useSummaryPpt } from '../stores/summaryPptStore'; // T02857：总结汇报 PPT 卡片运行状态
import { useCodeReviewLecture } from '../stores/codeReviewLectureStore'; // T02872：代码评审讲稿卡片运行状态
import { aiImportStore } from '../stores/aiImportStore'; // T01038：项目计划/PRD 导入运行态
import { RunStatusBadge, type RunStatus } from '../ui/runStatus'; // T01038：统一运行状态徽标
import { FlowButton } from '../ui/FlowButton'; // T01068-FR4.4：流光按钮（loading 态）
import { Download, Trash2, Upload, Sparkles, PanelRightOpen, Maximize, FileSpreadsheet, FileUp, FileStack, Loader2, X, RotateCcw, Zap, ListChecks, Presentation, FileChartColumn, ScrollText } from 'lucide-react';
import { resetWorkbenchArtifacts, RESET_CONFIRM_CARD } from '../ui/consoleReset'; // T01042：卡片侧重置入口（与控制台重置共用核心）
import { askConfirm } from '../ui/dialogs'; // T01042 建议：重置二次确认统一走对话框（Electron 下原生 confirm 不可靠）
import { focusTaskByNo } from '../ui/focusTask'; // T01057 建议：就绪任务跳转按编号定位（跨项目可命中）
import { AiUnavailableHint, aiBlocked, aiBlockedTitle, useAiReadiness } from '../ui/aiReadiness'; // T03176（D-14）：AI 不可用主入口可见但禁用 + 原因/修复动作

interface ReportTemplate {
  id: string;
  filename: string;
  format: string;
  size: number;
}

const PERIODS = [
  { key: 'day', label: '日报' },
  { key: 'week', label: '周报' },
  { key: 'month', label: '月报' },
] as const;

const FORMATS = [
  { key: 'xlsx', label: 'Excel (.xlsx)' },
  { key: 'docx', label: 'Word (.docx)' },
  { key: 'pdf', label: 'PDF (.pdf)' },
  { key: 'pptx', label: 'PPT (.pptx)' },
] as const;

type ReportFormat = 'xlsx' | 'docx' | 'pdf' | 'pptx';
/** 标准版式按输出格式对应的内置 skill 生成 */
const SKILL_BY_FORMAT: Record<ReportFormat, string> = { xlsx: 'xlsx-trae', docx: 'docx-trae', pdf: 'pdf-trae', pptx: 'pptx-trae' };

/** 内置技能：标准版式生成所依据的 office skill（已随应用内置） */
const BUILTIN_SKILLS = [
  { id: 'xlsx-trae', name: 'xlsx-trae', format: 'xlsx', desc: 'Excel 版式规范：浅表头填充、斑马纹、细浅边框、合计加粗强调' },
  { id: 'docx-trae', name: 'docx-trae', format: 'docx', desc: 'Word 文档规范：结构化标题、汇总表加粗表头' },
  { id: 'pdf-trae', name: 'pdf-trae', format: 'pdf', desc: 'PDF 处理技能（内置资源，供参考）' },
  { id: 'pptx-trae', name: 'pptx-trae', format: 'pptx', desc: '演示文稿技能（内置资源，供参考）' },
] as const;

/** Uint8Array 转 base64（分段避免栈溢出），供模板上传 JSON 承载 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const labelStyle: CSSProperties = { fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 };
const fieldStyle: CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)' };

/** 能力卡片配置 */
interface ReportCardCfg {
  readonly key: string;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly desc: React.ReactNode;
  readonly hint: string;
  readonly aria: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** T00908：卡片右上角可选的动作按钮（如「已上传 PRD 文档」），点击不触发卡片展开 */
  readonly action?: React.ReactNode;
  /** T01042：卡片侧重置入口——效果与控制台重置按钮一致（共用 resetWorkbenchArtifacts） */
  readonly onReset?: () => Promise<void> | void;
  /** T01038：卡片底部可选的运行状态徽标（动画图标 + 实时秒数 + 最终耗时），统一各能力卡运行状态提示 */
  readonly statusNode?: React.ReactNode;
  /** T03176（D-14）：该卡片的能力依赖 AI 工具——AI 不可用时仍可见，但点击只给原因、不展开 */
  readonly needsAi?: boolean;
}

/** 能力入口卡片（T00621，S3776 抽取；T00908 支持可选右上角动作按钮；T01038 支持底部运行状态徽标） */
function ReportCard({ icon, title, desc, hint, aria, open, onToggle, action, statusNode, onReset, glow, blocked, onBlocked }: {
  readonly icon: React.ReactNode; readonly title: string; readonly desc: React.ReactNode;
  readonly hint: string; readonly aria: string; readonly open: boolean; readonly onToggle: () => void;
  readonly action?: React.ReactNode; readonly statusNode?: React.ReactNode;
  /** T01042：卡片侧重置入口——点击效果与控制台重置按钮一致（共用 resetWorkbenchArtifacts 核心，DRY） */
  readonly onReset?: () => Promise<void> | void;
  /** T01068-FR4.4：运行态流光延展——AI 运行中时卡片外框光晕呼吸（ai-shimmer 文字流光的容器延展形态） */
  readonly glow?: boolean;
  /** T03176（D-14）：AI 不可用——卡片保留可见与工具提示，点击只回显原因（不展开面板、不真隐藏） */
  readonly blocked?: boolean;
  readonly onBlocked?: () => void;
}) {
  // T00908：容器用 div role=button（不用原生 button）——右上角动作/重置按钮是交互子元素，
  //         不能嵌套在按钮内（HTML 语法/可达性）；键盘激活能力由下方 onKeyDown 等价补齐。
  //         T02143 复位：fdc6090 的「div role=button 转原生 button」批修没考虑内嵌角标按钮，
  //         把非法 DOM 改了进来——容器含交互子元素时不得用原生 button 包裹，勿再改回。
  const [resetting, setResetting] = useState(false);
  async function handleReset() {
    if (resetting || !onReset) return;
    if (!await askConfirm(RESET_CONFIRM_CARD)) return; // 二次确认：防误操作
    setResetting(true);
    try { await onReset(); } finally { setResetting(false); }
  }
  const hasCorner = Boolean(action || onReset);
  const act = () => { if (blocked) { onBlocked?.(); return; } onToggle(); };
  return (
    <div /* NOSONAR: S6819 豁免——T02143：卡片右上角动作/重置是原生 button 子元素，HTML 禁止按钮套按钮；键盘支持已在下方 onKeyDown 等价补齐，勿再改回原生 button */
      role="button"
      tabIndex={0}
      aria-disabled={blocked || undefined}
      onClick={act}
      onKeyDown={(e) => {
        // 只认卡片自身获得焦点时的按键：角标按钮的 Enter/Space 会冒泡到这里，
        // 不判 target 会让「键盘激活角标」顺带把卡片收起（T02143 实测踩到）
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
      }}
      title={hint}
      aria-label={aria}
      className={`card-btn ln${glow && !blocked ? ' flow-glow' : ''}`}
      style={{ position: 'relative', textAlign: 'left', padding: 14, border: open && !blocked ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.65 : 1, display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%' }}
    >
      {icon}
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: 'var(--fs-l)', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>{desc}</span>
        <span style={{ display: 'block', fontSize: 'var(--fs-xs)', color: blocked ? 'var(--warn)' : 'var(--accent)', marginTop: 8 }}>
          {blocked ? '暂不可用 — 原因与修复动作见上方提示' : (open ? '收起工作面板 ↑' : '点击展开工作面板 ↓')}
        </span>
        {statusNode && <span style={{ display: 'block', marginTop: 6 }}>{statusNode}</span>}
      </span>
      {hasCorner && (
        // S6848/S1082：角标按钮各自 stopPropagation——冒泡到卡片会连带触发展开/收起
        <span style={{ position: 'absolute', top: 9, right: 9, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {action}
          {onReset && (
            <button
              onClick={(e) => { e.stopPropagation(); void handleReset(); }}
              disabled={resetting}
              title={resetting ? '重置中…' : '重置 — 清空控制台任务、该能力运行状态与关联草稿产物（与控制台重置等效）'}
              aria-label={`重置${title}的运行状态与关联草稿产物`}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text-muted)', cursor: resetting ? 'wait' : 'pointer', opacity: resetting ? 0.6 : 1 }}
            >
              {resetting ? <Loader2 size={13} className="aispin" /> : <RotateCcw size={13} />}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** T00908：PRD 管理视图文档行（弹出列表中呈现） */
interface PrdDocRow {
  id: string;
  filename: string;
  /** 'prd'=草稿/评审中 | 'confirmed'=确认版 */
  status: string;
  content_chars: number;
  updated_at: string;
}

/** T00908：AI 工作台「已上传 PRD 文档」弹层——列出当前项目 PRD 管理视图的全部文档，点击即关联到导入流程 */
function PrdDocsPopup({ open, projectId, onAssociate, onClose }: {
  readonly open: boolean;
  readonly projectId: string;
  readonly onAssociate: (docId: string, filename: string) => void;
  readonly onClose: () => void;
}) {
  const [docs, setDocs] = useState<PrdDocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assocDoc, setAssocDoc] = useState<string>('');

  // T00908：打开即拉取当前项目 PRD 管理视图文档，保证与「PRD 管理」视图数据实时同步
  useEffect(() => {
    if (!open) return;
    setLoading(true); setError(''); setDocs([]); setAssocDoc('');
    void api.get<PrdDocRow[]>(`/plans/prd-docs?projectId=${projectId}`)
      .then((ds) => setDocs(ds))
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  if (!open) return null;
  const doAssociate = (d: PrdDocRow) => {
    setAssocDoc(d.id);
    onAssociate(d.id, d.filename);
  };
  return (
    // T01361：遮罩为纯装饰层（aria-hidden），点击关闭是鼠标便捷通路
    <div
      aria-hidden="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{ width: 480, maxWidth: '92vw', maxHeight: '72vh', overflow: 'auto', background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 16, boxShadow: '0 12px 32px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <FileStack size={15} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 'var(--fs-l)' }}>已上传 PRD 文档</strong>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>点击文档即关联到当前计划导入流程</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} className="ln" title="关闭" aria-label="关闭已上传 PRD 文档"
            style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', padding: '3px 6px' }}><X size={13} /></button>
        </div>
        {loading && <div style={{ display: 'flex', alignItems: 'center', fontSize: 'var(--fs-s)' }}><span className="ai-shimmer" style={{ fontWeight: 600 }}>加载中…</span></div>}
        {!loading && error && <div style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>{error}</div>}
        {!loading && !error && docs.length === 0 && (
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: '8px 0' }}>当前项目还没有 PRD 文档——请先在「项目管理 → PRD 管理」中导入或生成。</div>
        )}
        {!loading && !error && docs.length > 0 && docs.map((d) => (
          <button key={d.id} type="button" disabled={assocDoc === d.id}
            className="ln" title={`关联「${d.filename}」到计划导入流程`} aria-label={`关联 PRD 文档 ${d.filename}`}
            onClick={() => doAssociate(d)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--text)', cursor: assocDoc === d.id ? 'default' : 'pointer', marginBottom: 6 }}>
            <FileStack size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 'var(--fs-s)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: d.status === 'confirmed' ? 'var(--success)' : 'var(--text-muted)', flexShrink: 0 }}>
              {d.status === 'confirmed' ? '确认版' : '草稿'}
            </span>
            {assocDoc === d.id ? <Loader2 size={13} className="aispin" style={{ color: 'var(--accent)' }} /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * T02165：旧会话遗留的单选范围迁移——多选改造把存储键从 `report.project`（单串）换成
 * `report.projects`（数组），首次读取时把单值转成单元素数组，避免升级后范围被重置为「全部项目」。
 */
function legacyProjectScope(): string[] {
  try {
    const raw = sessionStorage.getItem('report.project');
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'string' && v ? [v] : [];
  } catch {
    return [];
  }
}

/** 三块 AI 工作面板的条件渲染（S3776：条件块下沉为独立组件） */
function ReportWorkPanels({ aiToolId, projectId, projectIds, projects, scopeNote, showKickoffPpt, closeKickoffPpt, showSummaryPpt, closeSummaryPpt, showReviewLecture, closeReviewLecture, openCard, showPrdGen, closePrdGen, prdGenSaved, showTcGen, closeTcGen, tcImported, showPrdImport, closePrdImport, prdImportSaved, showAiImport, closeAiImport, aiImportSaved, prdImportKey }: {
  readonly aiToolId: string;
  readonly projectId: string;
  /** T02857：总结汇表面板默认消费顶部多选范围（空=全部项目），与 kickoff 的单项目口径不同 */
  readonly projectIds: string[];
  readonly projects: Project[];
  /** T02190：多项目范围时单项目工件卡片的明示文案（见 ReportPage 的 singleScopeNote） */
  readonly scopeNote: string;
  readonly showKickoffPpt: boolean; readonly closeKickoffPpt: () => void;
  readonly showSummaryPpt: boolean; readonly closeSummaryPpt: () => void;
  /** T02872：代码评审讲稿面板（第 9 张卡，三区布局） */
  readonly showReviewLecture: boolean; readonly closeReviewLecture: () => void;
  /** T02108：启动会校验清单的「去补充」深链落到本页对应能力卡片（report?card=prd-import / tc-gen） */
  readonly openCard: (key: 'prd-import' | 'tc-gen') => void;
  readonly showPrdGen: boolean; readonly closePrdGen: () => void; readonly prdGenSaved: (r: { issues: number }) => void;
  readonly showTcGen: boolean; readonly closeTcGen: () => void; readonly tcImported: (r: { imported: number }) => void;
  readonly showPrdImport: boolean; readonly closePrdImport: () => void; readonly prdImportSaved: (r: { requirements: number; plans: number; tasks: number }) => void;
  readonly showAiImport: boolean; readonly closeAiImport: () => void; readonly aiImportSaved: (n: number) => void;
  /** T00908：PRD 导入面板重挂载键——从弹层关联文档后递增，强制面板重挂以读取新会话标记 */
  readonly prdImportKey: number;
}) {
  return (
    <>
      {/* T02108（PRD §5.2）：项目启动会 PPT 面板（第 7 张卡）——逐页装配日志走右侧控制台，停止/重置已接进控制台链 */}
      {showKickoffPpt && (
        <KickoffPptPanel projectId={projectId} toolId={aiToolId} onClose={closeKickoffPpt} openCard={openCard} scopeNote={scopeNote} />
      )}
      {/* T02857（PRD-阶段性项目总结汇报PPT §3.1 FR-1.3）：第 8 张卡——默认跟随顶部多选范围（A-6 例外仅限本卡片） */}
      {showSummaryPpt && (
        <SummaryPptPanel projectIds={projectIds} projects={projects} toolId={aiToolId} onClose={closeSummaryPpt} openCard={openCard} />
      )}
      {/* T02872（PRD §6.1）：第 9 张卡——三区布局自带左 diff / 右讲稿，阶段日志同时进右侧控制台 */}
      {showReviewLecture && (
        <CodeReviewLecturePanel projectIds={projectIds} projects={projects} toolId={aiToolId} onClose={closeReviewLecture} />
      )}
      {/* T01492：从 PRD 生成测试用例面板（日志/正文同走右侧控制台；停止已接进控制台 stopAll） */}
      {showTcGen && (
        <TestCaseGenPanel toolId={aiToolId} onClose={closeTcGen} onImported={tcImported} />
      )}
      {/* T00769：原始需求生成 PRD 面板（插在「从 PRD 导入项目计划」面板前；日志/正文同走右侧控制台） */}
      {showPrdGen && (
        <PrdGenPanel toolId={aiToolId} onClose={closePrdGen} onSaved={prdGenSaved} />
      )}
      {/* T00662：从 PRD 导入面板——AI 拆 WBS + 需求跟踪矩阵（日志同走控制台） */}
      {showPrdImport && (
        <PrdImportPanel key={prdImportKey} toolId={aiToolId} onClose={closePrdImport} onSaved={prdImportSaved} />
      )}
      {/* T00569 二轮：AI 项目计划导入面板——功能完整迁移至本页内联执行（含控制台滚动输出） */}
      {showAiImport && (
        <AiPlanImportPanel toolId={aiToolId} onClose={closeAiImport} onSaved={aiImportSaved} />
      )}
    </>
  );
}

/** AI 报表生成成功后的下载入口（S3776：条件块下沉为独立组件）
 *  T02157：按钮文案随所选周期联动——选月报时不再显示「下载 AI 周报」。 */
function AiResultDownload({ aiResult, onDownload, periodLabel }: {
  readonly aiResult: { filename: string }; readonly onDownload: () => Promise<void>; readonly periodLabel: string;
}) {
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--surface-2)', paddingTop: 10 }}>
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 8 }}>
        «{aiResult.filename}» 已生成，洞察过程见右侧控制台。
      </div>
      <button
        onClick={() => void onDownload()}
        title={`下载 AI ${periodLabel} — 经令牌从后台取回（下载即删）`}
        aria-label={`下载 AI ${periodLabel}`}
        style={{ padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Download size={14} /> 下载 AI {periodLabel}
      </button>
    </div>
  );
}

/** 周报/报表页面：按周期与格式生成报表，支持模板导入与管理 */
export function ReportPage() {
  // 用户选项与已产生结果改为会话级持久化（useSessionState）：切换页面返回后仍保留选择与上次分析结果
  const [period, setPeriod] = useSessionState<'day' | 'week' | 'month'>('report.period', 'week');
  const [format, setFormat] = useSessionState<ReportFormat>('report.format', 'xlsx');
  // T02201：项目列表走统一容错层（加载中/失败可见 + 重试；空范围仍是合法的「全部项目」口径，故只显式提示不锁死）
  const projectList = useProjectList();
  const { projects } = projectList;
  // T02165：项目范围由单选升级为多选（sessionStorage 键 report.projects）；旧 report.project 单值自动迁移。
  // 空数组 = 全部项目（与原单选「全部项目」口径一致），勾选顺序即报表与 AI 里的项目分块顺序。
  const [projectIds, setProjectIds] = useSessionState<string[]>('report.projects', useMemo(legacyProjectScope, []));
  // 单项目产物的消费方（启动会 PPT / PRD 导入目标 / 已上传 PRD 弹层 / 就绪任务推荐）仍按项目级口径，取首个勾选项目
  const projectId = projectIds[0] ?? '';
  // T01058-FR1.3：就绪任务推荐——deps 前置均完成的执行行（跟随工作台项目选择刷新）
  const [readyPlans, setReadyPlans] = useState<Array<{ id: string; title: string; duration_days: number; complexity: number | null; start_date: string; task_no: string | null }>>([]);
  useEffect(() => {
    if (!projectId) { setReadyPlans([]); return; }
    let alive = true;
    void api.get<{ id: string; title: string; duration_days: number; complexity: number | null; start_date: string; task_no: string | null }[]>(`/plans/ready?projectId=${encodeURIComponent(projectId)}&limit=2`)
      .then((rows) => { if (alive) setReadyPlans(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setReadyPlans([]); });
    return () => { alive = false; };
  }, [projectId]);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templateId, setTemplateId] = useSessionState('report.template', '');
  const [busy, setBusy] = useState(false);
  // T01038：离线生成卡片的本地计时（短时任务，页面卸载即清空；长任务见下方模块级 store）
  const [offlineStartedAt, setOfflineStartedAt] = useState<number | undefined>(undefined);
  const [offlineFinal, setOfflineFinal] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState('');
  // 文档区收起态：为让 AI 控制台全屏浏览，提供收起/展开动态按钮切换左侧文档区显隐
  const [splitCollapsed, setSplitCollapsed] = useState(false);
  // T00816：AI 控制台收起态——与文档区互为反操作（收起控制台让左侧文档区全屏），二者互斥避免两侧同隐的空屏
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // AI 周报：AI 工具选择会话级保留；生成运行态打入模块级 store（useReportStream），
  // 以便切页期间 SSE 照常写入、返回后立即恢复进度（见 reportStream.ts 设计说明）
  // T00569 二轮：AI 项目计划导入面板展开态
  // T00769 二轮：五个工作面板的展开态统一改为会话级持久化 —— 反馈「点击展开工作面板需要页面切换状态保持」，
  // 此前 useState 在切页卸载组件后丢失，切回即收起（生成/填写中途切页回到面板会看不到内容与进度）。
  const [showAiImport, setShowAiImport] = useSessionState('report.showAiImport', false);
  // T00621：三卡片各自的工作面板展开态（互斥，保持左侧简洁）
  const [showOffline, setShowOffline] = useSessionState('report.showOffline', false);
  const [showAiLive, setShowAiLive] = useSessionState('report.showAiLive', false);
  // T00662：从 PRD 导入面板展开态（与其余三卡互斥）
  const [showPrdImport, setShowPrdImport] = useSessionState('report.showPrdImport', false);
  // T00769：原始需求生成 PRD 面板展开态（插在「从 PRD 导入项目计划」前一位，与其余卡片互斥）
  const [showPrdGen, setShowPrdGen] = useSessionState('report.showPrdGen', false);
  // T01492：从 PRD 生成测试用例面板展开态（第 6 张卡，与其余卡片互斥）
  const [showTcGen, setShowTcGen] = useSessionState('report.showTcGen', false);
  // T02107（PRD FR-1.3）：项目启动会 PPT 面板展开态（第 7 张卡）——同样走会话级持久化，
  // 生成是分钟级长任务，切页返回必须回到展开态，否则用户看不到进行中的大纲与进度
  const [showKickoffPpt, setShowKickoffPpt] = useSessionState('report.showKickoffPpt', false);
  // T02857：阶段性项目总结汇报 PPT 面板展开态（第 8 张卡，互斥）——分钟级长任务，切页返回要回到展开态
  const [showSummaryPpt, setShowSummaryPpt] = useSessionState('report.showSummaryPpt', false);
  // T02872（PRD §6.1）：代码评审会议讲稿面板展开态（第 9 张卡，互斥）——生成分钟级长任务，切页返回要回到展开态
  const [showReviewLecture, setShowReviewLecture] = useSessionState('report.showReviewLecture', false);
  // T00908：「已上传 PRD 文档」弹层展开态 + 导入面板强制重挂载计数（选择文档后递增 key 触发面板重挂，
  //          使 useSessionState 重新读取 sessionStorage 中的目标项目与 docId，保证自动带入生效）
  const [prdDocsOpen, setPrdDocsOpen] = useState(false);
  const [prdRemountKey, setPrdRemountKey] = useState(0);
  const [aiTools, setAiTools] = useState<AITool[]>([]);
  const [aiToolId, setAiToolId] = useSessionState('report.aiTool', '');
  // T00558 / PRD AI-5：周报摘要写入收件箱开关（服务端 report.aiSummaryToInbox）——开关状态持久于服务端
  // T02213：取值改走可见失败态层。此前 GET 失败被 `.catch(() => undefined)` 吞掉，界面按初始 false
  // 渲染成「后端是关的」——而真实值可能是开的，回显与后端不一致会直接误导一次生成结果的去向。
  const summaryInboxView = useResource<{ enabled: boolean }>(() => api.get<{ enabled: boolean }>('/settings/ai-summary-inbox'));
  const summaryToInbox = summaryInboxView.data?.enabled ?? false;
  // T01038：订阅各模块级 store 的运行态，供卡片统一状态徽标 + 导航 Tab 旋转指示共用（跨 Tab 切换天然保持）
  const { streaming: aiStreaming, logs: aiLogs, streamText: aiStreamText, result: aiResult, startedAt: reportStartedAt, finalElapsed: reportFinal } = useReportStream();
  const prdSnap = usePrdGen();
  const tcSnap = useTestCaseGen(); // T01492：测试用例生成卡片运行状态供徽标共用
  const kfSnap = useKickoffPpt(); // T02109：启动会 PPT 卡片运行状态供徽标共用
  const sumSnap = useSummaryPpt(); // T02857：总结汇报 PPT 卡片运行状态供徽标共用
  const lectureSnap = useCodeReviewLecture(); // T02872：代码评审讲稿卡片运行状态供徽标共用
  const aiImp = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  // T03176（D-14）：AI 可用性走单源诊断（与后端 runtimeWithModel 同口径）——
  // 不可用时本页 8 张 AI 卡仍可见但禁用，页面顶部给一次原因 + 「去模型管理」修复动作。
  const readiness = useAiReadiness();
  const aiDown = aiBlocked(readiness);
  // 显式选中/持久化的工具优先（控制台选择器仍在），仅在为空时落到诊断给出的可用工具，
  // 避免与用户选择打架；loadAiTools 已排除停用工具，故 aiToolId 不会指向停用项。
  const activeToolId = aiToolId || readiness?.toolId || '';

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 3200);
  };

  // T00558：摘要写入收件箱开关（S3776：回调下沉）
  const changeSummaryInbox = (v: boolean) => {
    summaryInboxView.setData({ enabled: v });
    void api.post('/settings/ai-summary-inbox', { enabled: v }).catch((e) => {
      summaryInboxView.setData({ enabled: !v });
      flash(`开关保存失败，已回退：${e instanceof Error ? e.message : String(e)}`);
    });
  };

  // T00662：PRD 导入完成回调（S4624：内层模板抽出为变量，避免嵌套模板字符串）
  const prdImportSaved = (r: { requirements: number; plans: number; tasks: number }) => {
    const taskPart = r.tasks ? `、待办任务 ${r.tasks} 条` : '';
    flash(`PRD 导入完成：需求 ${r.requirements} 条、计划 ${r.plans} 条${taskPart}（矩阵见项目计划页「需求跟踪矩阵」）`);
  };

  // T00908：从「已上传 PRD 文档」弹层选择文档→关联到当前计划导入流程。
  // 与 PrdPanel.goImportPrd 同语义：写入目标项目与 docId 会话标记，展开并重挂导入面板，
  // 使其挂载时读取标记自动带入所选 PRD（见 PrdImportPanel 的 prd-import.docId 消费）
  const associatePrdDoc = (docId: string, filename: string) => {
    try {
      sessionStorage.setItem('prd-import.project', JSON.stringify(projectId));
      sessionStorage.setItem('prd-import.docId', docId);
    } catch { /* 会话写入异常静默，不影响面板手动选择 */ }
    setShowPrdImport(true);
    setPrdRemountKey((k) => k + 1);
    setPrdDocsOpen(false);
    flash(`已关联 PRD「${filename}」——请在打开的导入面板中确认并开始解析`);
  };

  // T00769 二轮：五张卡片互斥开关统一由 togglePanel 处理。
  // 原实现各写一份 setX(!v) + 手挑几个 setY(false)，prd-import 漏关 prd-gen、两个旧卡片漏关新卡片，
  // 展开态持久化后会留下「两面板同时展开」的脏状态，故改为按 key 全量互斥。
  const panelSetters = {
    aiImport: setShowAiImport,
    offline: setShowOffline,
    aiLive: setShowAiLive,
    prdImport: setShowPrdImport,
    prdGen: setShowPrdGen,
    tcGen: setShowTcGen,
    kickoffPpt: setShowKickoffPpt,
    summaryPpt: setShowSummaryPpt,
    reviewLecture: setShowReviewLecture,
  } as const;
  type PanelKey = keyof typeof panelSetters;
  const panelOpen: Record<PanelKey, boolean> = {
    aiImport: showAiImport, offline: showOffline, aiLive: showAiLive, prdImport: showPrdImport, prdGen: showPrdGen, tcGen: showTcGen,
    kickoffPpt: showKickoffPpt,
    summaryPpt: showSummaryPpt,
    reviewLecture: showReviewLecture,
  };
  /** 点击卡片：已展开则收起，否则只展开它（其余全部收起） */
  function togglePanel(key: PanelKey) {
    const keys = Object.keys(panelSetters) as PanelKey[];
    for (const k of keys) panelSetters[k](k === key && !panelOpen[key]);
  }

  // T00908：「已上传 PRD 文档」倾斜动画按钮——无文字图标入口，置于「从 PRD 导入项目计划」卡片右上角。
  // 未选项目时不弹层，改用 flash 提示先确定范围（弹层需按项目拉取 PRD 管理视图）
  const prdDocsAction = (
    <button type="button"
      onClick={(e) => { e.stopPropagation(); if (!projectId) { flash('请先在页面顶部选择目标项目范围，再查看已上传 PRD 文档'); return; } setPrdDocsOpen(true); }}
      title="已上传 PRD 文档 — 查看当前项目已上传的 PRD 文档并关联到导入计划"
      aria-label="已上传 PRD 文档：查看当前项目已上传的 PRD 文档并关联到导入计划"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--accent)', cursor: 'pointer' }}>
      {/* T01558：去除文档面板专属的 3D 倾斜（prd-tilt-btn），改为与 tc-gen 等其余卡片一致的扁平卡片按钮（chrome 与卡片重置按钮同源） */}
      <FileStack size={14} />
    </button>
  );

  // 五张能力卡片配置（S3776：数据驱动替代五段重复 JSX）
  // T01042：有产物/草稿的四张卡提供卡片侧重置入口（共用 resetWorkbenchArtifacts 核心，效果与控制台重置一致）
  const resetArtifacts = async () => {
    const r = await resetWorkbenchArtifacts();
    if (!r.ok) globalThis.alert(`重置失败：${r.error ?? '未知错误'}（本地状态已清理，可再次重置兜底）`);
  };
  // T02157：AI 报表侧文案随所选周期联动——选「月报」时不再写死显示「AI 周报生成」
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? '周报';
  const aiReportLabel = `AI ${periodLabel}生成`;
  const offlineReportLabel = `离线${periodLabel}生成`;

  // T02190：顶部范围选择器可多选（T02165 起周报/报表链路按 projectIds 聚合），但「启动会 PPT」
  // 是**单项目工件**（一份 PPT 只属于一个项目，后端无多项目入参），面板整体取范围首个项目；
  // 「从 PRD 导入项目计划」面板自带目标项目下拉，只有卡片角标的「已上传 PRD 文档」入口取 projectIds[0]。
  // 多选时不标注就会形成「范围显示 3 个项目、产物只按第 1 个生成」的口径分裂，
  // 故按各自真实落位分别明示（口径 1：提示优先，产物仍单项目；不改动 projectIds 语义）。
  const scopeName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const scopeNoteOf = (subject: string): string => (projectIds.length > 1
    ? `${subject}按首个项目「${scopeName}」生成，多项目范围仅作用于周报/报表`
    : '');
  const withScopeNote = (d: React.ReactNode, note: string): React.ReactNode => (note
    ? <>{d}<span style={{ display: 'block', marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>{note}</span></>
    : d);

  const reportCards: ReportCardCfg[] = [
    { key: 'ai-import', needsAi: true, icon: <FileUp size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: 'AI 项目计划导入',
      desc: '上传 Excel/需求文档，AI 解析为项目计划草稿（工期/依赖/负责人），确认后批量入库',
      hint: 'AI 项目计划导入 — 上传 Excel/需求文档，AI 解析为计划草稿并批量入库（本页直接执行）', aria: 'AI 项目计划导入',
      open: showAiImport,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('aiImport') },
    { key: 'offline', icon: <FileSpreadsheet size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: offlineReportLabel,
      desc: '本地聚合本周期任务数据，按模板或标准版式直接合成文件（无需联网）；含模板管理与导入',
      hint: `${offlineReportLabel} — 本地聚合数据按模板合成报表（工作面板内含模板管理）`, aria: offlineReportLabel,
      open: showOffline,
      onToggle: () => togglePanel('offline') },
    { key: 'ai-live', needsAi: true, icon: <Sparkles size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: aiReportLabel,
      desc: <>结合真实任务数据调用 AI 生成洞察，按内置 skill「{SKILL_BY_FORMAT[format]}」版式智能合成</>,
      hint: `${aiReportLabel} — 结合真实数据由 AI 撰写洞察并按内置 skill 版式合成`, aria: aiReportLabel,
      open: showAiLive,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('aiLive') },
    { key: 'prd-gen', needsAi: true, icon: <Sparkles size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '原始需求生成 PRD',
      desc: '上传原始需求（Word/Excel/Markdown/文本），内置技能结合源码上下文生成 PRD + 待确认问题，确认后录入 PRD 管理视图',
      hint: '原始需求生成 PRD — 上传原始需求文件，内置技能结合项目源码上下文生成标准化 PRD 与待确认问题，确认后录入 PRD 管理视图', aria: '原始需求生成 PRD',
      open: showPrdGen,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('prdGen') },
    { key: 'prd-import', needsAi: true, icon: <FileUp size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '从 PRD 导入项目计划',
      desc: withScopeNote('AI 拆分 WBS + 逐条提取需求 → 生成计划与需求跟踪矩阵（可选同步待办任务）',
        projectIds.length > 1
          ? `角标「已上传 PRD 文档」只列首个项目「${scopeName}」的文档；导入目标项目以面板内下拉为准`
          : ''),
      hint: '从 PRD 导入项目计划 — 上传 PRD（Word/Excel/Markdown/文本/PDF），AI 拆分 WBS 并逐条提取需求，确认后导入计划与需求跟踪矩阵', aria: '从 PRD 导入项目计划',
      open: showPrdImport,
      action: prdDocsAction,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('prdImport') },
    { key: 'tc-gen', needsAi: true, icon: <ListChecks size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '从 PRD 生成测试用例',
      desc: '选择内部 PRD 或上传需求文档，内置技能拆分需求 + 分块生成用例 + 覆盖校验，草稿确认后入库（同一 PRD 重跑幂等）',
      hint: '从 PRD 生成测试用例 — 内部 PRD 文档或外部上传，内置技能 testcase-generate 结合项目源码上下文生成用例草稿，勾选确认后入库', aria: '从 PRD 生成测试用例',
      open: showTcGen,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('tcGen') },
    // T02107（PRD FR-1.1/1.2）：第 7 张卡——数组尾部追加，标题/描述/hint 逐字取 PRD 口径，
    // 复用 ReportCard 与既有图标风格（色值只走 CSS 变量，不新造卡片组件）
    { key: 'kickoff-ppt', needsAi: true, icon: <Presentation size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '项目启动会 PPT 生成',
      desc: withScopeNote('按项目资料自动装配 Kickoff 材料（原生可编辑 .pptx）', scopeNoteOf('本卡片')),
      hint: '需 PRD/需求矩阵/计划至少各 1 条', aria: '项目启动会 PPT 生成',
      open: showKickoffPpt,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('kickoffPpt') },
    // T02857（PRD-阶段性项目总结汇报PPT §3.1 FR-1.1）：第 8 张卡——文案逐字取 PRD 口径；
    // 与 kickoff 的单项目口径不同，本卡片的多项目合并产物是 T02190 的首个例外（A-6），范围默认跟随顶部选择器
    { key: 'summary-ppt', needsAi: true, icon: <FileChartColumn size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '阶段性项目总结汇报 PPT 生成',
      desc: withScopeNote('按汇报周期与项目范围自动装配阶段总结汇报材料（原生可编辑 .pptx）',
        projectIds.length > 1 ? `合并版：${projectIds.length} 个项目将在同一份 deck 内分区呈现` : ''),
      hint: '周期内至少有 1 个项目有活动数据', aria: '阶段性项目总结汇报 PPT 生成',
      open: showSummaryPpt,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('summaryPpt') },
    // T02872（PRD §1 术语表「卡位冲突声明」）：本卡与总结汇报卡同争尾部位，PRD 已按落地时点定序——
    // 总结汇报先落地为第 8 张，本卡为第 9 张，标题逐字取 PRD §1 口径（「代码评审会议讲稿生成」），不改写、不顶替。
    { key: 'review-lecture', needsAi: true, icon: <ScrollText size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />, title: '代码评审会议讲稿生成',
      desc: withScopeNote('按评审范围采集阶段性增量（Git Diff / Commit 日志），装配可直接照念的八段评审会议讲稿——左 diff、右讲稿、锚点可定位',
        projectIds.length > 1 ? `多项目：按「总-分-总」装配，每项目独立成章（${projectIds.length} 个项目）` : ''),
      hint: '项目已配置工作空间路径，或可粘贴 patch 走降级通道', aria: '代码评审会议讲稿生成',
      open: showReviewLecture,
      onReset: resetArtifacts,
      onToggle: () => togglePanel('reviewLecture') },
  ];

  // 工作面板开关回调（S3776：从 JSX 内联箭头下沉）
  const closePrdGen = () => setShowPrdGen(false);
  const prdGenSaved = (r: { issues: number }) => flash(`PRD 已录入管理视图（含问题 ${r.issues} 条）——可在「项目管理」页的 PRD 管理视图中查看`);
  // T01492：从 PRD 生成测试用例面板关闭与导入回调
  const closeTcGen = () => setShowTcGen(false);
  const tcImported = (r: { imported: number }) => flash(`已导入 ${r.imported} 条测试用例——可在「项目管理 → 测试用例视图」查看`);
  const closePrdImport = () => setShowPrdImport(false);
  const closeAiImport = () => setShowAiImport(false);
  const aiImportSaved = (n: number) => flash(`AI 导入完成：已创建 ${n} 条计划（可在「项目计划」查看）`);
  // T02108（PRD §5.2）：启动会面板关闭 + 校验清单深链落位——深链走「确保展开」而非卡片点击的 toggle
  //（面板已展开时 toggle 会把它收起，用户点「去补充」反而看不到入口）；互斥仍复用 togglePanel 单一口径
  const closeKickoffPpt = () => setShowKickoffPpt(false);
  const openCard = (key: 'prd-import' | 'tc-gen') => {
    const panel: PanelKey = key === 'prd-import' ? 'prdImport' : 'tcGen';
    if (panelOpen[panel]) return;
    togglePanel(panel);
    flash(key === 'prd-import' ? '已切到「从 PRD 导入项目计划」——补齐 PRD 与需求矩阵后回到启动会卡片重开校验' : '已切到「从 PRD 生成测试用例」——生成用例后回到启动会卡片重开校验');
  };

  // T01038：统一各能力卡片运行状态徽标——按 store 运行态推导状态/起始时间/最终耗时，集中映射避免散落。
  // ai-import 与 prd-import 共用 aiImportStore（kind: 'plan'|'prd'）；offline 仅本地短时计时。
  // S3358/S7735：状态推导收敛为独立函数（运行中优先；无最终耗时为 idle，否则 success），替代嵌套三元与否定条件
  const deriveStatus = (streaming: boolean, finalElapsed?: number): RunStatus => {
    if (streaming) return 'running';
    if (finalElapsed == null) return 'idle';
    return 'success';
  };
  const cardStatus = (key: string): { status: RunStatus; startedAt?: number; finalElapsed?: number } => {
    switch (key) {
      case 'ai-live':
        return { status: deriveStatus(aiStreaming, reportFinal), startedAt: reportStartedAt, finalElapsed: reportFinal };
      case 'prd-gen':
        return { status: deriveStatus(prdSnap.streaming, prdSnap.finalElapsed), startedAt: prdSnap.startedAt, finalElapsed: prdSnap.finalElapsed };
      case 'tc-gen':
        return { status: deriveStatus(tcSnap.streaming, tcSnap.finalElapsed), startedAt: tcSnap.startedAt, finalElapsed: tcSnap.finalElapsed };
      case 'kickoff-ppt':
        return { status: deriveStatus(kfSnap.streaming, kfSnap.finalElapsed), startedAt: kfSnap.startedAt, finalElapsed: kfSnap.finalElapsed };
      case 'summary-ppt':
        return { status: deriveStatus(sumSnap.streaming, sumSnap.finalElapsed), startedAt: sumSnap.startedAt, finalElapsed: sumSnap.finalElapsed };
      case 'review-lecture':
        return { status: deriveStatus(lectureSnap.streaming, lectureSnap.finalElapsed), startedAt: lectureSnap.startedAt, finalElapsed: lectureSnap.finalElapsed };
      case 'ai-import':
      case 'prd-import': {
        // 两面板共用同一 store——按运行类型 kind 分流，避免「从 PRD 导入」运行时「AI 项目计划导入」卡片也转圈（2026-09-26 用户反馈）。
        const mine = (key === 'prd-import') === (aiImp.kind === 'prd');
        if (!mine) return { status: 'idle' };
        return { status: deriveStatus(aiImp.busy, aiImp.finalElapsed), startedAt: aiImp.startedAt, finalElapsed: aiImp.finalElapsed };
      }
      case 'offline':
        return { status: deriveStatus(busy, offlineFinal), startedAt: offlineStartedAt, finalElapsed: offlineFinal };
      default:
        return { status: 'idle' };
    }
  };

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api.get<ReportTemplate[]>('/report/templates'));
    } catch {
      setTemplates([]);
    }
  }, []);

  // 加载已配置模型的 AI 工具，默认选中第一个，供 AI 周报生成使用。
  // 提取为组件级函数：避免 then 回调内再嵌套 setState 回调导致函数嵌套过深
  const loadAiTools = useCallback(async () => {
    try {
      const list = await api.get<AITool[]>('/aitools');
      // T03176：排除停用工具——此前只筛 model，停用但仍带 model 的工具会被选成默认，运行时直接报「未配置」
      const valid = list.filter((t) => t.model && t.enabled !== false);
      setAiTools(valid);
      // T00534：统一以模型菜单配置为准——固定默认整理工具，不再由本页选择
      if (valid.length) setAiToolId(valid[0].id);
    } catch { /* 工具列表加载失败静默：aiToolId 为空时由 UI 提示先配置模型 */ }
  }, [setAiToolId]);

  useEffect(() => {
    void loadTemplates();
    void loadAiTools();
  }, [loadTemplates, loadAiTools]);

  /** 生成报表并下载（后端按周期聚合任务数据，xlsx/docx） */
  async function generate() {
    const t0 = Date.now();
    setOfflineStartedAt(t0);
    setOfflineFinal(undefined); // T01038：新一轮开始，清除上次最终耗时
    setBusy(true);
    try {
      const { blob, filename } = await api.download('/report/generate', {
        period,
        format,
        projectIds,
        templateId: templateId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      flash(`已生成 ${filename} 并开始下载`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setOfflineFinal(Date.now() - t0); // T01038：保留最终耗时
    }
  }

  /** AI 周报生成（流式）：SSE 实时推送阶段日志与洞察正文到右侧控制台，完成后获得下载令牌。
   * 状态直接写入模块级 store，切换页面期间生成照常推进，返回后恢复进度。 */
  async function aiGenerate() {
    if (!activeToolId) {
      // T03176：诊断已给出具体缺失项（未配置工具/全部停用/未填默认模型）时按诊断原文提示，不再泛化成一句「去配置」
      flash(aiDown && readiness ? `AI 暂不可用：${readiness.reason}` : '请先在「模型管理」配置并选择 AI 工具');
      return;
    }
    reportStream.begin();
    // T00838：登记本次生成的 AbortController，供控制台「停止」按钮跨组件中止
    const ac = new AbortController();
    reportStream.setAbortCtrl(ac);
    let errMsg = '';
    try {
      await streamEvents(
        '/report/ai-generate-stream',
        { period, format, projectIds, toolId: activeToolId },
        (name, payload) => {
          switch (name) {
            case 'stage':
              reportStream.pushLog((payload as { msg: string }).msg);
              break;
            case 'chunk':
              reportStream.appendText((payload as { text: string }).text);
              break;
            case 'done': {
              const { token, filename } = payload as { token: string; filename: string };
              reportStream.setResult({ token, filename });
              break;
            }
            case 'error':
              errMsg = (payload as { error: string }).error;
              break;
          }
        },
        ac.signal,
      );
      if (errMsg) throw new Error(errMsg);
      reportStream.finish();
    } catch (e) {
      // 用户「停止」主动中止：状态已由 reportStream.abort() 清空，不再追加失败日志
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      // T02142 §5：被并发闸拒不是「生成失败」——与启动会面板同口径走排队态文案（PRD §5 R6）
      const queued = msg.includes(GATE_BUSY_MSG);
      flash(queued ? `${msg}——前面有周报/启动会稿在装配，稍后重试即可（不是失败）` : msg);
      reportStream.finish(queued ? `并发闸排队：${msg}` : `生成失败：${msg}`);
    } finally {
      reportStream.setAbortCtrl(null);
    }
  }

  /** 下载 AI 生成的周报：经临时令牌从后台取回（下载即删） */
  async function aiDownload() {
    if (!aiResult) return;
    try {
      const { blob, filename } = await api.download('/report/ai-download', { token: aiResult.token, filename: aiResult.filename });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      reportStream.setResult(null);
      flash(`已下载 AI ${periodLabel} ${filename}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 选择本地 .xlsx/.docx 模板，转 base64 上传 */
  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/(\.xlsx|\.docx)$/i.test(f.name)) {
      flash('仅支持 .xlsx / .docx 模板文件');
      return;
    }
    const buf = await f.arrayBuffer();
    try {
      await api.post<{ ok: boolean }>('/report/templates', { filename: f.name, data: bytesToBase64(new Uint8Array(buf)) });
      await loadTemplates();
      flash(`已导入模板「${f.name}」`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }

  /** 删除已导入模板 */
  async function removeTemplate(id: string, name: string) {
    try {
      await api.del(`/report/templates/${encodeURIComponent(id)}`);
      if (templateId === id) setTemplateId('');
      await loadTemplates();
      flash(`已删除模板「${name}」`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }

  /** T02165：范围摘要（全部项目 / 单项目名 / 「A + B 等 N 个项目」），生成按钮与 AI 控制台回显共用 */
  const scopeLabel = scopeSummary(projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? id));

  return (
    <section>
      {/* 左主区 + 右侧 AI 控制台：两栏布局，参考企业对比工具 AI 分析栏。
          收起文档区后左侧主区隐藏，控制台 flex 自动占满整行，实现全屏浏览 AI 洞察 */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: splitCollapsed ? 'none' : 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h2 style={{ fontSize: 'var(--fs-2xl)', margin: 0 }}>AI 工作台</h2>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>AI 能力入口与报表生成（按周期聚合任务数据生成 Excel / Word 报表）</span>
        <span style={{ flex: 1 }} />
        {/* T00816：去掉展开/收起两组开关按钮，改为「AI 工作台」窗格单一全屏按钮（无文字、带动画）——
            点击隐藏右侧控制台让本窗格全屏，再点还原；全屏中按钮仍在本窗格内可见，无需额外恢复入口 */}
        <button
          onClick={() => setConsoleCollapsed((v) => !v)}
          title={consoleCollapsed ? '还原 — 退出全屏，并排展示 AI 工作台与控制台' : '全屏 — 隐藏右侧 AI 控制台，让 AI 工作台占满整行'}
          aria-label={consoleCollapsed ? '还原：退出全屏' : '全屏：隐藏 AI 控制台'}
          className={`tbtn-anim${consoleCollapsed ? ' task-breathe' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', padding: 4, borderRadius: 6, cursor: 'pointer', background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          {consoleCollapsed ? <PanelRightOpen size={14} /> : <Maximize size={14} />}
        </button>
      </div>

      {/* T01058-FR1.3：「现在做这个」就绪任务推荐条——deps 前置均完成的执行行（有就绪项时置顶展示，点击定位任务） */}
      {projectId && readyPlans.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '14px 0 0', padding: '10px 14px', border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--accent-soft)' }}>
          <Zap size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>现在做：</span>
          {readyPlans.map((rp) => {
            // S4624：内层模板抽出为局部常量，避免嵌套模板字符串
            const complexityPart = rp.complexity ? `，复杂度 ${rp.complexity}/5` : '';
            const taskNoPart = rp.task_no ? ` ${rp.task_no}` : '';
            return (
            <button
              key={rp.id}
              onClick={() => {
                // T01568：就绪条的意图是「现在做这个」——要看的是任务正文而非一行高亮，直达抽屉「描述」页
                void focusTaskByNo(rp.task_no, 'desc');
              }}
              title={`就绪任务：前置依赖均已完成${complexityPart} — 点击打开任务详情${taskNoPart}`}
              aria-label={`前往就绪任务 ${rp.title}`}
              style={{ fontSize: 'var(--fs-s)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--card-bg)', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {rp.title}（{rp.duration_days} 天{rp.complexity ? ` · 复杂度${rp.complexity}` : ''}）→
            </button>
            );
          })}
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>前置依赖已完成的就绪任务（来自项目计划依赖图）</span>
        </div>
      )}

      {/* T03176（D-14）：AI 不可用只提示一次（而非每张卡重复一遍），卡片本身保留可见但禁用 */}
      {aiDown && readiness && <AiUnavailableHint r={readiness} style={{ margin: '14px 0 0' }} />}

      {/* T00621：AI 能力入口五卡片同行（统一风格：图标 + 标题 + 描述 + 底部展开提示；S3776 数据驱动抽取） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, margin: '14px 0 0' }}>
        {reportCards.map((c) => {
          const st = cardStatus(c.key);
          const cardDown = Boolean(c.needsAi) && aiDown;
          return (
            <ReportCard
              key={c.key}
              icon={c.icon}
              title={c.title}
              desc={c.desc}
              hint={cardDown ? aiBlockedTitle(readiness, c.hint) : c.hint}
              aria={c.aria}
              open={c.open}
              action={c.action}
              onReset={c.onReset}
              blocked={cardDown}
              onBlocked={() => flash(`「${c.title}」暂不可用：${readiness?.reason ?? 'AI 未就绪'}——点击上方「去模型管理」配置后重试`)}
              glow={st.status === 'running'} /* T01068-FR4.4：运行中卡片光晕呼吸 */
              onToggle={c.onToggle}
              statusNode={<RunStatusBadge status={st.status} startedAt={st.startedAt} finalElapsed={st.finalElapsed} size={12} showLabel={false} />}
            />
          );
        })}
      </div>

      <ReportWorkPanels aiToolId={activeToolId} projectId={projectId} projectIds={projectIds} projects={projects} scopeNote={scopeNoteOf('本面板')}
        showKickoffPpt={showKickoffPpt} closeKickoffPpt={closeKickoffPpt} openCard={openCard}
        showSummaryPpt={showSummaryPpt} closeSummaryPpt={() => setShowSummaryPpt(false)}
        showReviewLecture={showReviewLecture} closeReviewLecture={() => setShowReviewLecture(false)}
        showPrdGen={showPrdGen} closePrdGen={closePrdGen} prdGenSaved={prdGenSaved}
        showTcGen={showTcGen} closeTcGen={closeTcGen} tcImported={tcImported}
        showPrdImport={showPrdImport} closePrdImport={closePrdImport} prdImportSaved={prdImportSaved}
        showAiImport={showAiImport} closeAiImport={closeAiImport} aiImportSaved={aiImportSaved}
        prdImportKey={prdRemountKey} />

      {/* T00908：「已上传 PRD 文档」弹层——选择文档即关联到计划导入流程 */}
      <PrdDocsPopup open={prdDocsOpen} projectId={projectId} onAssociate={associatePrdDoc} onClose={() => setPrdDocsOpen(false)} />

      {/* 公共配置：周期 / 格式 / 项目范围，离线与 AI 两条路径共用 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '14px 0 0', padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
        <div>
          <div style={labelStyle}>报表周期</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                title={`生成${p.label}`}
                style={{
                  padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-m)',
                  background: period === p.key ? 'var(--accent)' : 'var(--card-bg)',
                  color: period === p.key ? 'var(--accent-text)' : 'var(--text)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={labelStyle}>输出格式</div>
          <select value={format} onChange={(e) => setFormat(e.target.value as ReportFormat)} style={fieldStyle}>
            {FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div>
          {/* T02165：单选下拉 → 复选多选（可勾 2~8 个项目聚合，勾选顺序即报表分块顺序）；
              宿主给确定宽度，面板里的触发钮才能按 width:100% 铺满而不随内容塌陷 */}
          <div style={labelStyle}>项目范围（可多选）</div>
          <div style={{ width: 240, maxWidth: '100%' }}>
            <ProjectScopePicker projects={projects} value={projectIds} onChange={setProjectIds} />
          </div>
          {/* T02201：取数失败/加载中显式化（此前一次失败即整页项目选择器空到下次进页，且无提示） */}
          <ProjectListHint view={projectList} />
        </div>
      </div>

      {/* T00621：工作面板区——由上方三卡片点击展开（互斥，默认收起保持页面简洁） */}
      <div style={{ display: 'flex', gap: 16, margin: '12px 0', flexWrap: 'wrap' }}>
        {/* 离线周报生成工作面板：本地聚合 + 模板管理（模板列表/导入整合于此） */}
        {showOffline && (
        <div style={{ flex: '1 1 320px', border: '1px solid var(--accent)', borderRadius: 10, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>
            <FileSpreadsheet size={15} style={{ color: 'var(--accent)' }} /> {offlineReportLabel} · 工作面板
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowOffline(false)} className="tbtn-anim" title="收起工作面板" aria-label={`收起 ${offlineReportLabel}工作面板`}
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: '1px 6px' }}>收起 ↑</button>
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>本地聚合本周期任务数据，按模板或标准版式直接合成文件，无需联网。</div>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>模板</div>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
              <option value="">标准模板（内置 skill）</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.filename}</option>)}
            </select>
            {templateId === '' && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                使用内置 skill「{SKILL_BY_FORMAT[format]}」生成标准版式
              </div>
            )}
          </div>
          {/* T00621：模板管理整合到离线周报工作面板（导入 / 列表 / 删除） */}
          <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>模板管理（{templates.length}）</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => fileRef.current?.click()} className="tbtn-anim"
                title="导入模板 — 选择 .xlsx / .docx 模板文件上传" aria-label="导入模板"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                <Upload size={11} /> 导入模板
              </button>
            </div>
            {templates.length === 0
              ? <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>暂无自定义模板，可导入 .xlsx/.docx 模板文件后在上方「模板」下拉中选择。</div>
              : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 120, overflowY: 'auto' }}>
                  {templates.map((t) => (
                    <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', padding: '2px 0', borderBottom: '1px solid var(--border)' }}>
                      <FileSpreadsheet size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.filename}</span>
                      <button onClick={() => void removeTemplate(t.id, t.filename)} className="tbtn-anim"
                        title="删除该模板" aria-label={`删除模板 ${t.filename}`}
                        style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <FlowButton
            onClick={() => void generate()}
            disabled={busy}
            title={`${offlineReportLabel} — 本地聚合数据生成报表`}
            aria-label={`${offlineReportLabel}：本地聚合数据生成报表`}
            loading={busy}
            loadingText="生成中…"
          >
            <><Download size={14} /> 离线生成{PERIODS.find((p) => p.key === period)?.label}（{scopeLabel}）</>
          </FlowButton>
        </div>
        )}

        {/* AI 报表生成工作面板：AI 洞察 + 内置技能说明（技能依据整合于此） */}
        {showAiLive && (
        <div style={{ flex: '1 1 320px', border: '1px solid var(--accent)', borderRadius: 10, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>
            <Sparkles size={15} style={{ color: 'var(--accent)' }} /> {aiReportLabel} · 工作面板
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowAiLive(false)} className="tbtn-anim" title="收起工作面板" aria-label={`收起 ${aiReportLabel}工作面板`}
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: '1px 6px' }}>收起 ↑</button>
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>
            结合真实任务数据调用 AI 生成洞察，按内置 skill 版式智能合成；洞察生成过程在右侧 AI 控制台实时滚动展示。
          </div>
          {/* T00621：内置技能整合到 AI 周报工作面板 */}
          <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, transparent)' }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>内置技能（标准版式依据）</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--text)' }}>
              <Sparkles size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <code style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{SKILL_BY_FORMAT[format]}</code>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                — 当前报表格式 {format.toUpperCase()} 对应的内置版式技能；AI 生成时按该 skill 的标准结构组织内容
              </span>
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
              切换上方「报表格式」即自动匹配对应技能：xlsx-trae / docx-trae / pdf-trae / pptx-trae
            </div>
          </div>
          <div style={{ marginBottom: 12, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            AI 工具统一使用「模型菜单」的默认整理工具（无需在此重复选择）。
          </div>
          <FlowButton
            onClick={() => void aiGenerate()}
            disabled={aiStreaming || aiDown}
            title={aiDown ? aiBlockedTitle(readiness, `${aiReportLabel} — 结合任务数据调用 AI 生成${periodLabel}`) : `${aiReportLabel} — 结合任务数据调用 AI 生成${periodLabel}`}
            aria-label={`${aiReportLabel}：结合任务数据调用 AI 生成${periodLabel}`}
            loading={aiStreaming}
            loadingText="AI 生成中…"
          >
            <><Sparkles size={14} /> {aiReportLabel}</>
          </FlowButton>
          {/* T00558 / PRD AI-5：生成后把 AI 洞察摘要写入收件箱任务 */}
          {/* T02213：状态未经服务端确认（加载中/取数失败）时禁用开关并如实标注——
              此前 GET 失败被吞，界面按 false 渲染成「后端是关的」，而真实值可能是开的 */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', cursor: summaryInboxView.phase === 'ready' ? 'pointer' : 'not-allowed' }}
            title={`勾选后，${aiReportLabel}时会把洞察摘要写入「收件箱」项目的一条待办任务（便于后续跟进）`}>
            <input type="checkbox" checked={summaryToInbox} disabled={summaryInboxView.phase !== 'ready'}
              style={{ cursor: summaryInboxView.phase === 'ready' ? 'pointer' : 'not-allowed' }}
              onChange={(e) => changeSummaryInbox(e.target.checked)} />
            {' '}
            生成后把摘要写入收件箱任务
          </label>
          <ResourceHint view={summaryInboxView} label="摘要写入收件箱开关状态" showLoading style={{ marginLeft: 6 }} />
          {/* AI 洞察已移至右侧控制台流式展示，左侧仅在生成成功后保留下载入口 */}
          {aiResult && <AiResultDownload aiResult={aiResult} onDownload={aiDownload} periodLabel={PERIODS.find((p) => p.key === period)?.label ?? '周报'} />}
        </div>
        )}
      </div>

      {notice && <output className="flash-toast">{notice}</output>}

      {/* T00621：原「内置技能」「模板管理」独立区块已整合进各自工作面板（AI 周报面板=内置技能；离线周报面板=模板管理），此处仅保留隐藏的上传入口与占位符说明 */}
      <input ref={fileRef} type="file" accept=".xlsx,.docx" style={FILE_INPUT_SR_ONLY} onChange={(e) => void onUpload(e)} />

      <div style={{ marginTop: 12, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        说明：报表按本周期内更新过的任务（未归档）聚合，包含各项目汇总与任务明细；选用 Word 模板时以 {`{period}`}、{`{periodLabel}`}、{`{startDate}`}、{`{endDate}`}、{`{projects}`}、{`{tasks}`} 占位符渲染。模板导入入口在「{offlineReportLabel}」工作面板内（仅支持 .xlsx / .docx，≤10MB）。
      </div>
        </div>
        <aside style={{ boxSizing: 'border-box', alignSelf: 'stretch', display: consoleCollapsed ? 'none' : undefined, ...(splitCollapsed ? { width: '100%' } : { flex: '0 0 360px', maxWidth: '44vw' }) }}>
          <ReportConsole tools={aiTools} toolId={aiToolId} onToolIdChange={setAiToolId} period={period} projectIds={projectIds} scopeLabel={scopeLabel} streaming={aiStreaming} logs={aiLogs} streamText={aiStreamText}
            unavailableReason={aiDown ? (readiness?.reason ?? '') : ''}
            onCollapse={() => setSplitCollapsed((v) => !v)} collapsed={splitCollapsed} />
        </aside>
      </div>
    </section>
  );
}