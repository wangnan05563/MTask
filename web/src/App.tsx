import { useEffect, useState, useSyncExternalStore } from 'react';
import { TasksPage } from './pages/TasksPage';
import { AIToolsPage } from './pages/AIToolsPage';
import { QueuePage } from './pages/QueuePage';
import { ExecSessionsPage } from './pages/ExecSessionsPage'; // T01271-FR1.4：执行会话观测面板
import { PromptsPage } from './pages/PromptsPage';
import { ReqPage } from './pages/ReqPage';
import { SettingsPage } from './pages/SettingsPage';
import { ReportPage } from './pages/ReportPage';
import { PlanPage } from './pages/PlanPage';
import { NotifyBell } from './ui/NotifyBell'; // T01064-FR1.4：全局通知中心
import { api, setAccessToken } from './api/client';
import { MarkdownStyles } from './ui/Markdown';
import { CommandPalette } from './pages/CommandPalette';
import { SettingsProvider } from './settings';
import { MobileShell } from './mobile/MobileShell';
import { Activity, Boxes, CalendarRange, Compass, Lightbulb, ListOrdered, ListTodo, ScrollText, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import { PageGuideDialog, hasSeenGuide, markGuideSeen } from './pages/PageGuide'; // T00706：通用使用向导
import { GUIDES } from './pages/guides'; // T00706：各菜单向导内容配置
import { useReportStream } from './reportStream'; // T01038：AI 工作台运行态（周报生成）
import { usePrdGen } from './stores/prdGenStore'; // T01038：原始需求生成 PRD 运行态
import { aiImportStore } from './stores/aiImportStore'; // T01038：项目计划/PRD 导入运行态
import { Loader2 } from 'lucide-react'; // T01038：Tab 运行指示旋转图标

// T00441：日志/归档入口从顶部菜单移入「设置」（内网穿透下方），顶部菜单收敛为高频功能
type Tab = 'tasks' | 'aitools' | 'prompts' | 'req' | 'plan' | 'queue' | 'report' | 'exec-sessions' | 'settings';

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'tasks', label: '任务', icon: ListTodo },
  { key: 'aitools', label: '模型', icon: Boxes },
  { key: 'prompts', label: '提示词', icon: ScrollText },
  { key: 'req', label: '通用需求', icon: Lightbulb },
  { key: 'plan', label: '项目管理', icon: CalendarRange }, // T00664：更名——后续定位为项目管理模块
  // T01154：仪表盘入口迁至「设置 → 仪表盘」（通用设置之后），顶部菜单不再占位
  { key: 'report', label: 'AI 工作台', icon: Sparkles }, // T00569：周报改名 AI 工作台（卡片化入口）
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'exec-sessions', label: '执行会话', icon: Activity }, // T01271-FR1.4：外部平台执行会话观测面板
  { key: 'settings', label: '设置', icon: Settings },
];

/** 应用外壳：导航 + 主题变量容器。颜色取自 CSS 变量，主题切换即时全局生效 */
function Shell() {
  const [tab, setTab] = useState<Tab>('tasks');
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  // T00443 / PRD UX-4：全局命令面板（T00560：快捷键 Ctrl+F）
  const [paletteOpen, setPaletteOpen] = useState(false);
  // T00706：全菜单使用向导——当前菜单首次进入自动弹出，导航右侧常驻「向导」按钮随时唤起
  const guide = GUIDES[tab];
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = () => { if (guide) { markGuideSeen(guide.seenKey); } setGuideOpen(false); };
  useEffect(() => { if (guide && !hasSeenGuide(guide.seenKey)) setGuideOpen(true); }, [guide]);
  // T00821：全局 Tab 导航事件——供深层页面（如 AI 工作台确认录入成功）跨 Tab 跳转到目标菜单
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const d = (e as CustomEvent).detail as { tab?: string } | undefined;
      if (d?.tab && typeof d.tab === 'string' && TABS.some((t) => t.key === d.tab)) setTab(d.tab as Tab);
    };
    globalThis.addEventListener('mtaskNavigate', onNavigate);
    return () => globalThis.removeEventListener('mtaskNavigate', onNavigate);
  }, []);
  // T01057-FR1.1：OS 通知点击 → 聚焦窗口后定位到对应任务（写 focusId 供任务页定位，再切到任务菜单）
  useEffect(() => {
    const desktop = (globalThis as unknown as { mtaskDesktop?: { onNavigateTask?: (cb: (taskNo: string) => void) => () => void } }).mtaskDesktop;
    if (!desktop?.onNavigateTask) return; // 浏览器环境无桌面桥，跳过
    const off = desktop.onNavigateTask((taskNo) => {
      try { sessionStorage.setItem('tasks.focusId', JSON.stringify(taskNo)); } catch { /* 忽略 */ }
      setTab('tasks');
    });
    return off;
  }, []);
  // T00443 / PRD UX-4：Ctrl+F 唤起/关闭命令面板（T00560：由 Ctrl+K 调整为更符合操作习惯的 Ctrl+F）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    api.get<{ ok: boolean }>('/health')
      .then(() => setServerOk(true))
      .catch(() => setServerOk(false));
  }, []);

  // 启动时同步访问令牌：若后端已配置（或重置过）令牌，更新本地，避免带旧令牌触发 401
  useEffect(() => {
    api.get<{ accessToken?: string }>('/tunnel/config')
      .then((c) => { if (c.accessToken) setAccessToken(c.accessToken); })
      .catch(() => { /* 后端不可用时忽略 */ });
  }, []);

  // T01038：AI 工作台（report）任一能力卡片运行中时，导航 Tab 同步显示旋转指示
  const rs = useReportStream();
  const pg = usePrdGen();
  const aiImp = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  const workbenchRunning = rs.streaming || pg.streaming || aiImp.busy;

  // 连接状态三态（未知/正常/异常）的色值与文案：用 if 显式分支而非嵌套三元，可读性更好
  let statusColor = 'var(--text-muted)';
  let statusText = '连接后端中…';
  if (serverOk === true) {
    statusColor = 'var(--success)';
    statusText = '● 后端已连接';
  } else if (serverOk === false) {
    statusColor = 'var(--danger)';
    statusText = '● 后端未连接（请先启动 server）';
  }

  return (
    <div
      style={{
        fontFamily: 'var(--font-family)',
        // 自适应尽量占满屏幕：width:100% 让小屏贴合，上限 1600px 让大屏充分铺展避免原 1080 固定宽度造成两侧大块空白
        width: '100%',
        maxWidth: 1600,
        margin: '0 auto',
        boxSizing: 'border-box',
        padding: '0 16px 40px',
        background: 'var(--app-bg)',
        color: 'var(--text)',
        minHeight: '100vh',
      }}
    >
      {/* Markdown 作用域样式在应用根统一注入一次，供全部页面共享 */}
      <MarkdownStyles />
      {paletteOpen && (
        <CommandPalette
          open
          onClose={() => setPaletteOpen(false)}
          onNavigate={(t) => { setPaletteOpen(false); setTab(t); }}
        />
      )}
      {/* 全局按钮去边框：扁平简约统一视觉，显式边框按钮随后逐个移除 */}
      <style>{`button { border: none; cursor: pointer; transition: transform .12s ease; }
        button:disabled { cursor: default; opacity: .6; }
        button:active:not(:disabled) { transform: scale(0.95); }
        /* T00475：导航默认大图标、悬浮整项平滑展开图标+文字（键盘 focus-visible 同样展开） */
        .nav-btn .nav-label { display: inline-block; max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; transition: max-width .25s ease, opacity .2s ease; }
        .nav-btn:hover .nav-label, .nav-btn:focus-visible .nav-label { max-width: 120px; opacity: 1; }
        /* T00486：全系统控件交互动画统一（参照任务菜单多选按钮 tbtn-anim 基准） */
        /* T00497：动态提示浮层化——固定右上与菜单栏同行空白区，不占文档流，杜绝控件串行/记录错位 */
        .flash-toast { position: fixed; top: 14px; right: 16px; z-index: 90; max-width: 42vw; padding: 5px 12px; border-radius: 8px; background: var(--card-bg); border: 1px solid var(--accent); color: var(--accent); font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.12); animation: toast-in .2s ease; }
        @keyframes toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        /* T00486：全系统按钮悬浮倾斜 + 点击缩放（对齐 tbtn-anim 基准：.18s ease，hover 倾斜、active 缩放） */
        input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); cursor: pointer; transition: transform .18s ease; }
        input[type="checkbox"]:hover, input[type="radio"]:hover { transform: scale(1.12) rotate(8deg); }
        input[type="checkbox"]:active, input[type="radio"]:active { transform: scale(.88); }
        /* T00908：AI 工作台「已上传 PRD 文档」入口——3D 透视倾斜悬浮（perspective 仿立体凸起），无文字图标按钮 */
        .prd-tilt-btn { transform: perspective(420px) rotateX(0deg) rotateY(0deg); transition: transform .22s ease, box-shadow .22s ease; }
        .prd-tilt-btn:hover:not(:disabled) { transform: perspective(420px) rotateX(-8deg) rotateY(8deg) scale(1.1); box-shadow: 0 6px 14px rgba(0,0,0,.14); }
        .prd-tilt-btn:active:not(:disabled) { transform: perspective(420px) scale(.9); }
        .abtn svg, .ghost svg { transition: transform .18s ease; }
        .abtn:hover:not(:disabled) svg, .ghost:hover:not(:disabled) svg { transform: scale(1.15) rotate(8deg); }
        .abtn:active svg, .ghost:active svg { transform: scale(.88); }
        .task-op button:hover:not(:disabled), .task-op .tbtn-anim:hover { transform: scale(1.15) rotate(8deg); }
        .task-op button:active:not(:disabled), .task-op .tbtn-anim:active { transform: scale(.88); }
        .task-op button, .task-op .tbtn-anim { transition: transform .18s ease; }
        /* T00770：PRD 管理入口——开源 SVG 笔迹流动动画（文档书写意象），无文字标签；悬浮加速 */
        @keyframes prd-doc-flow { 0% { stroke-dashoffset: 26; } 100% { stroke-dashoffset: 0; } }
        .prd-ico-anim svg { overflow: visible; }
        .prd-ico-anim svg path, .prd-ico-anim svg polyline, .prd-ico-anim svg line, .prd-ico-anim svg circle {
          stroke-dasharray: 26; animation: prd-doc-flow 2.6s linear infinite;
        }
        .prd-ico-anim:hover svg path, .prd-ico-anim:hover svg polyline, .prd-ico-anim:hover svg line, .prd-ico-anim:hover svg circle {
          animation-duration: 1s;
        }
        @media (prefers-reduced-motion: reduce) {
          .prd-ico-anim svg path, .prd-ico-anim svg polyline, .prd-ico-anim svg line, .prd-ico-anim svg circle { animation: none; stroke-dasharray: none; }
        }
        /* T00513 修正：task-op 同时被用作行内操作按钮自身的类名（后代选择器不命中）——补自身形式选择器 */
        button.task-op, a.task-op { transition: transform .18s ease; }
        button.task-op:hover:not(:disabled) { transform: scale(1.15) rotate(8deg); }
        button.task-op:active:not(:disabled) { transform: scale(.88); }
        /* T00522 修正：全站原生 select 统一悬浮微倾斜+缩放——一条规则覆盖所有页面的所有下拉条
           （工具栏筛选/行内优先级分类/设置表单等，不再按 task-op 类名分派导致无类下拉条无效果） */
        select { transition: transform .18s ease; }
        select:hover:not(:disabled) { transform: scale(1.04) rotate(-1.5deg); }
        /* T00513：标题行状态/验证按钮（title-op）同样悬浮倾斜缩放 */
        .title-op { transition: transform .18s ease; }
        .title-op:hover:not(:disabled) { transform: scale(1.15) rotate(8deg); }
        .title-op:active:not(:disabled) { transform: scale(.88); }
        /* 文字/功能按钮：整体轻微倾斜（幅度收敛避免文本难读），active 缩放 */
        button:hover:not(:disabled):not(.tbtn-anim):not(.nav-btn):not(.abtn):not(.ghost):not(.row-title-btn):not(.task-op) { transform: rotate(-1.5deg); } /* T00494：记录标题按钮不参与悬浮旋转；T00513：task-op 行内按钮走倾斜缩放基准 */
        /* T00890：导航与行标题按钮补齐悬浮微倾斜——两者被上方兜底 :not() 排除，需各自独立声明才具备「所有页面按钮悬浮微倾斜」的统一反馈。
           nav-btn 含文字标签，幅度略大带缩放；row-title-btn 是标题，幅度轻微避免文字难读。 */
        .nav-btn:hover:not(:disabled) { transform: scale(1.06) rotate(-2deg); }
        button.row-title-btn:hover:not(:disabled) { transform: scale(1.02) rotate(-1deg); }
        button { transition: transform .18s ease, background-color .15s ease; }
        /* T00530：请求进行中的呼吸反馈上提为全局（任务页/计划页共用） */
        .task-breathe { animation: task-breathe 1.3s ease-in-out infinite; }
        @keyframes task-breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.35); }
          50% { transform: scale(1.06); box-shadow: 0 0 0 5px rgba(37, 99, 235, 0); }
        }
        /* T00491：菜单操作控件/搜索框统一「默认隐藏、悬浮宿主区显示」（后代选择器支持嵌套组） */
        .op-host .op-hidden { opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s; }
        .op-host:hover .op-hidden, .op-host:focus-within .op-hidden { opacity: 1; visibility: visible; transition: opacity .2s ease, visibility 0s; }
        /* T00477：菜单下拉/过滤条件悬浮展示（默认淡化，悬浮或聚焦完全显示） */
        .toolbar-reveal { opacity: .35; transition: opacity .18s ease; }
        .toolbar-reveal:hover, .toolbar-reveal:focus-within { opacity: 1; }
        .abtn:hover, .ghost:hover { background: var(--surface-2); }`}</style>

      {/* 菜单行：置顶，导航项居左；后端连接状态用 margin-left:auto 推到右端且垂直居中，与菜单项同行 */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => {
          // 菜单图标置于文字前：使用开源 lucide 图标库，与全局视觉一致
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              className="nav-btn"
              onClick={() => setTab(t.key)}
              title={t.label}
              aria-label={t.label}
              style={{
                padding: '7px 10px',
                borderRadius: 6,
                background: tab === t.key ? 'var(--accent)' : 'var(--card-bg)',
                color: tab === t.key ? 'var(--accent-text)' : 'var(--text)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon size={18} />
              <span className="nav-label">{t.label}</span>
              {/* T01038：AI 工作台 Tab 运行中旋转指示（与卡片/控制台状态联动） */}
              {t.key === 'report' && workbenchRunning && <Loader2 size={12} className="aispin" style={{ color: tab === t.key ? 'var(--accent-text)' : 'var(--accent)' }} />}
            </button>
          );
        })}
        {/* T01064-FR1.4：全局通知中心（铃铛 + 未读角标 + 事件下拉） */}
        <NotifyBell />
        {/* 后端连接状态：随 serverOk 动态更新，常驻菜单行最右侧。
            色值与文案按三态（未知/正常/异常）显式计算，避免 JSX 中嵌套三元 */}
        <span
          style={{ fontSize: 12, marginLeft: 'auto', color: statusColor }}
        >
          {statusText}
        </span>
        {/* T00706：常驻「向导」按钮（菜单行最右）——参考项目管理向导（T00665）。
            T00735：去掉呼吸动画（task-breathe）改为静态、并去掉文字仅保留图标——
            项目管理页曾出现「全局 + 页内」两个向导按钮，统一保留本按钮（页内重复项已删除） */}
        {guide && (
          <button
            onClick={() => setGuideOpen(true)}
            title={`使用向导 — 查看「${guide.title.split(' · ')[0]}」菜单各功能的使用说明与要点`}
            aria-label="打开当前菜单使用向导"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 8px', marginLeft: 10, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--accent)', background: 'var(--card-bg)', color: 'var(--accent)' }}
          >
            <Compass size={15} />
          </button>
        )}
      </nav>

      {tab === 'tasks' && <TasksPage />}
      {tab === 'aitools' && <AIToolsPage />}
      {tab === 'prompts' && <PromptsPage />}
      {tab === 'req' && <ReqPage />}
      {tab === 'queue' && <QueuePage />}
      {tab === 'exec-sessions' && <ExecSessionsPage />}
      {tab === 'plan' && <PlanPage />}
      {/* T01154：仪表盘迁入设置页（通用设置 tab 后） */}
      {tab === 'report' && <ReportPage />}
      {/* T00441：日志/归档入口移至「设置」页（内网穿透下方） */}
      {tab === 'settings' && <SettingsPage />}

      {/* T00706：当前菜单的使用向导弹窗（首次进入自动弹出 / 导航右侧按钮唤起） */}
      {guide && <PageGuideDialog open={guideOpen} onClose={closeGuide} title={guide.title} steps={guide.steps} />}
    </div>
  );
}

/**
 * 解析当前 UI 模式：URL 覆盖（?m=1 移动 / ?m=0 桌面）> 本地偏好（localStorage）> 自动检测。
 * 自动检测：触摸设备且视口 ≤ 820px 视为移动端，否则桌面端（不干扰桌面窄窗用户）。
 */
function resolveUiMode(): 'mobile' | 'desktop' {
  const params = new URLSearchParams(location.search);
  const override = params.get('m');
  if (override === '1') return 'mobile';
  if (override === '0') return 'desktop';
  try {
    const stored = localStorage.getItem('mtask.uiMode');
    if (stored === 'mobile' || stored === 'desktop') return stored;
  } catch { /* 忽略 */ }
  const touch = 'ontouchstart' in globalThis || (navigator.maxTouchPoints ?? 0) > 0;
  const small = globalThis.matchMedia('(max-width: 820px)').matches;
  return touch && small ? 'mobile' : 'desktop';
}

export function App() {
  const ui = resolveUiMode();
  return (
    <SettingsProvider>
      {ui === 'mobile' ? <MobileShell /> : <Shell />}
    </SettingsProvider>
  );
}