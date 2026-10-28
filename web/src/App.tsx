import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { focusTaskByNo } from './ui/focusTask'; // T01057 建议：通知点击跨项目定位（写齐 focusId/项目/tab）
import { api, setAccessToken } from './api/client';
import { desktopApi } from './ui/desktop'; // T02976：菜单通道下载进度的桌面桥（浏览器环境无此桥）
import { MarkdownStyles } from './ui/Markdown';
import { CommandPalette } from './pages/CommandPalette';
import { SettingsProvider } from './settings';
import { MobileShell } from './mobile/MobileShell';
import { Compass } from 'lucide-react'; // T03184（PM-102）：菜单图标随 TABS 一并迁入 ui/tabs.ts，此处只留命令面板入口图标
import { PageGuideDialog, hasSeenGuide, markGuideSeen } from './pages/PageGuide'; // T00706：通用使用向导
import { GUIDES } from './pages/guides'; // T00706：各菜单向导内容配置
import { useReportStream } from './reportStream'; // T01038：AI 工作台运行态（周报生成）
import { usePrdGen } from './stores/prdGenStore'; // T01038：原始需求生成 PRD 运行态
import { aiImportStore } from './stores/aiImportStore'; // T01038：项目计划/PRD 导入运行态
import { Loader2 } from 'lucide-react'; // T01038：Tab 运行指示旋转图标

import { TABS, type Tab } from './ui/tabs'; // T03184（PM-102）：一级导航单源——命令面板页面列表同源生成
import { applyDeepLink, buildDeepLink, readDeepLinkFromLocation } from './ui/deepLink'; // T03187（D-13）：深链契约单源

// T00441：日志/归档入口从顶部菜单移入「设置」（内网穿透下方），顶部菜单收敛为高频功能

// T02977 复验补：下载进度文案/字节格式化单源在 ui/updateProgress（设置页卡片与这条全局条共用，
// 免得两处各自漏态——此前「无总量」「刚点击」两态在卡片侧就是纯空白）
import { isInFlightStatus, updateProgressView } from './ui/updateProgress';

/** 应用外壳：导航 + 主题变量容器。颜色取自 CSS 变量，主题切换即时全局生效 */
function Shell() {
  const [tab, setTab] = useState<Tab>('tasks');
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  // T01836：启动自动检测到的新版本（仅提示，一键下载安装仍在「设置 → 版本更新」卡片内）
  const [updateHint, setUpdateHint] = useState<{ latestVersion: string; currentVersion: string } | null>(null);
  // T02976：菜单「帮助 → 检查在线更新」的下载由主进程自驱，此时用户可能不在设置页——
  // 这条状态承载全局进度条，只接 origin='menu' 的事件（设置页卡片自己有进度，不重复显示）。
  // 更新下载续传：retrying = 网络中断后的自动续传重试中——进度保持不变，但要让用户知道「没卡死、在自愈」
  // T02977 复验补：starting = 主进程已发起请求但还没收到任何字节（连 DNS/TLS 都算在内）；
  // 没有这一帧，点击后那段空窗在界面上等于「什么都没发生」。
  const [dlToast, setDlToast] = useState<{ status: 'starting' | 'downloading' | 'resuming' | 'retrying' | 'downloaded' | 'failed'; received: number; total: number; message?: string } | null>(null);
  // T00443 / PRD UX-4：全局命令面板（T03170 / D-07：Ctrl+K 打开；Ctrl+F 优先页内搜索）
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
  // T03187（D-13）：深链入口——首次进入读 URL、之后跟随 hashchange（手改地址/外部链接/浏览器后退）。
  // 解析与交付都在契约模块内完成，这里只负责「链接变了就重放一遍」，不再各自拼跳转。
  useEffect(() => {
    const applyFromLocation = () => {
      const link = readDeepLinkFromLocation();
      if (link) applyDeepLink(link);
    };
    applyFromLocation();
    globalThis.addEventListener('hashchange', applyFromLocation);
    return () => globalThis.removeEventListener('hashchange', applyFromLocation);
  }, []);
  // T03187（D-13）：地址栏跟随实际页签——顶栏点击 / 命令面板直达都只改 tab 状态，
  // 若不同步，刷新或复制链接会落到上一个页签，「稳定路由」就是假的。
  // 保留当前链接里的 projectId；锚点仅在页签未变时保留（换页后旧锚点已无意义）。
  // 首帧跳过：进入时 URL 才是权威（可能正是带锚点的深链），此时 tab 仍是默认值，
  // 若照常同步会把 `.../plan/matrix` 改写成 `.../tasks`，锚点当场丢失。
  const urlSyncedRef = useRef(false);
  useEffect(() => {
    if (!urlSyncedRef.current) { urlSyncedRef.current = true; return; }
    const cur = readDeepLinkFromLocation();
    if (!cur?.projectId) return;
    const target = buildDeepLink({ projectId: cur.projectId, tab, anchor: cur.tab === tab ? cur.anchor : undefined });
    if (location.hash !== target) {
      try { history.replaceState(null, '', target); } catch { /* 忽略 */ }
    }
  }, [tab]);
  // T01057-FR1.1：OS 通知点击 → 聚焦窗口后定位到对应任务。
  // T01057 建议：改用 focusTaskByNo——按编号解析 id/项目/状态写齐定位键（含切 activeProject），
  // 修复此前「只写 focusId=task_no、跨项目任务定位不到」的问题（编号≠行 uuid）。
  // T01568：OS 通知只由「任务处理完成/失败」（electron/main 轮询 ai_state 变化）产生，
  // 用 'notice' 让落位跟着任务实际状态走——已回传结果→处理结果页；失败或尚无结果→描述页。
  useEffect(() => {
    const desktop = (globalThis as unknown as { mtaskDesktop?: { onNavigateTask?: (cb: (taskNo: string) => void) => () => void } }).mtaskDesktop;
    if (!desktop?.onNavigateTask) return; // 浏览器环境无桌面桥，跳过
    const off = desktop.onNavigateTask((taskNo) => { void focusTaskByNo(taskNo, 'notice'); });
    return off;
  }, []);
  // T03170（PRD D-07）：Ctrl+K 固定打开命令面板；Ctrl+F 优先聚焦当前页搜索框
  // （带 data-page-search 标记、可见且未禁用），无页内搜索时才打开命令面板。
  // 旧实现（T00560）把 Ctrl+F 整个让给面板并 preventDefault——按 D-07 统一裁决回退。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (k === 'f') {
        const cands = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-page-search], textarea[data-page-search]'));
        const tryFocus = (el: HTMLInputElement | HTMLTextAreaElement): boolean => {
          // op-hidden 控件默认 visibility:hidden，程序 focus() 无效——先经宿主 op-force 显形再聚焦，失焦撤销
          const host = el.closest('.op-host');
          if (host) host.classList.add('op-force');
          el.focus();
          el.select();
          if (document.activeElement !== el) {
            if (host) host.classList.remove('op-force');
            return false;
          }
          const undo = () => { if (host) host.classList.remove('op-force'); };
          el.addEventListener('blur', undo, { once: true });
          return true;
        };
        const target = cands.find((el) => el.offsetParent !== null && !el.disabled);
        e.preventDefault();
        if (target && tryFocus(target)) {
          setPaletteOpen(false);
        } else {
          setPaletteOpen(true);
        }
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  // T03184（PM-102 / D-07）：数字键 1～9 直达对应一级菜单——仅在「非输入、无弹窗、非输入法组合」时生效。
  // 输入框里的 1～9 是内容；弹窗打开时用户在做局部操作，切页会把上下文弄丢；IME 组合中的按键不能当快捷键。
  useEffect(() => {
    const onDigit = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const anchor = e.target instanceof Element ? e.target : null;
      if (anchor?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
      const target = TABS[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      setTab(target.key);
    };
    globalThis.addEventListener('keydown', onDigit);
    return () => globalThis.removeEventListener('keydown', onDigit);
  }, []);

  useEffect(() => {
    api.get<{ ok: boolean }>('/health')
      .then(() => setServerOk(true))
      .catch(() => setServerOk(false));
  }, []);

  // T01836 需求 1「应用启动时自动检测是否有新版本」：等后端就绪后静默查一次
  //（force=false 走服务端 15min 缓存，不会每次启动都打 GitHub API）。
  // T03273（UX-13）：auto=true 让后端把网络失败/无配置收成 200 skipped——冷启动不再出 4xx 红色噪声。
  useEffect(() => {
    if (!serverOk) return;
    if (sessionStorage.getItem('mtask.updateHintClosed')) return; // 本次会话已手动关掉就不再弹
    api.post<{ hasUpdate?: boolean; latestVersion?: string; currentVersion?: string; skipped?: boolean }>('/update/check', { force: false, auto: true })
      .then((r) => { if (!r?.skipped && r?.hasUpdate && r.latestVersion) setUpdateHint({ latestVersion: r.latestVersion, currentVersion: r.currentVersion ?? '' }); })
      .catch(() => { /* 静默路径已不应抛错；保留兜底，极端情况下同样不打扰用户 */ });
  }, [serverOk]);

  // T02976：订阅主进程下载进度，只消费菜单通道（origin='menu'）。
  // 浏览器环境没有桌面桥——下载走浏览器自带下载管理器，这里自然不渲染任何东西。
  useEffect(() => {
    const desk = desktopApi();
    if (!desk?.onUpdateProgress) return;
    let hideTimer = 0;
    const off = desk.onUpdateProgress((d) => {
      if (d.origin !== 'menu') return;
      const received = d.received ?? 0;
      const total = d.total ?? 0;
      if (d.status === 'downloading' || d.status === 'resuming' || d.status === 'starting') {
        window.clearTimeout(hideTimer);
        setDlToast({ status: d.status, received, total });
      } else if (d.status === 'retrying') {
        // 更新下载续传：主进程正在自动续传重试——保留进度条与取消入口，只把文案换成可读原因，
        // 否则用户看到进度归零/停滞会误判成下载失败
        window.clearTimeout(hideTimer);
        setDlToast({ status: 'retrying', received, total, message: d.message });
      } else if (d.status === 'downloaded') {
        setDlToast({ status: 'downloaded', received, total });
        // 主进程随后弹「立即安装 / 稍后安装」对话框；进度条只留 3 秒做完成回执即收起
        hideTimer = window.setTimeout(() => setDlToast((cur) => (cur?.status === 'downloaded' ? null : cur)), 3000);
      } else if (d.status === 'failed') {
        setDlToast({ status: 'failed', received: 0, total: 0, message: d.message ?? '下载失败' });
      } else {
        setDlToast(null); // cancelled 等终态：菜单通道没有「继续下载」入口，直接收起
      }
    });
    return () => { window.clearTimeout(hideTimer); off(); };
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

  // T02977 复验补：文案/百分比收进 updateProgressView（与设置页卡片同一单源），这里只管布局与按钮
  const dlView = dlToast ? updateProgressView(dlToast) : null;
  const dlPct = dlView?.pct ?? 0;
  const dlInFlight = dlToast !== null && isInFlightStatus(dlToast.status);

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
        .flash-toast { position: fixed; top: 14px; right: 16px; z-index: 90; max-width: 42vw; padding: 5px 12px; border-radius: 8px; background: var(--card-bg); border: 1px solid var(--accent); color: var(--accent); font-size: var(--fs-s); box-shadow: 0 4px 14px rgba(0,0,0,.12); animation: toast-in .2s ease; }
        @keyframes toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        /* T01480：导出图标动效——悬浮倾斜、按下缩放（≤300ms） */
        .export-anim { transition: transform .18s ease; }
        .export-anim:hover { transform: rotate(-8deg) scale(1.08); }
        .export-anim:active { transform: scale(.9); }
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
        /* T02143：能力卡片容器（div role=button，内嵌角标按钮不能套在原生 button 里）补回全局
           button 规则给过的悬浮/手感——否则这次 DOM 规范修复会顺带回退 T00494 的微交互体系 */
        .card-btn { cursor: pointer; transition: transform .18s ease, background-color .15s ease; }
        .card-btn:hover { transform: rotate(-1.5deg); }
        .card-btn:active { transform: scale(0.95); }
        /* T00530：请求进行中的呼吸反馈上提为全局（任务页/计划页共用） */
        .task-breathe { animation: task-breathe 1.3s ease-in-out infinite; }
        @keyframes task-breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.35); }
          50% { transform: scale(1.06); box-shadow: 0 0 0 5px rgba(37, 99, 235, 0); }
        }
        /* T02196：跨视图「定位成功」反馈——徽标点击后目标行短暂高亮（任务行 div 与计划行 tr 共用）。
           由页面 state 加类驱动：行会随任意状态重渲染，命令式改 el.style 会被 React 覆写回原值。 */
        .locate-flash { animation: locate-flash 1.5s ease; }
        @keyframes locate-flash {
          0%, 55% { background: var(--accent-soft); outline: 2px solid var(--accent); outline-offset: -2px; }
          100% { background: transparent; outline: 2px solid transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          .locate-flash { animation: none; background: var(--accent-soft); }
        }
        /* T00491：菜单操作控件/搜索框统一「默认隐藏、悬浮宿主区显示」（后代选择器支持嵌套组） */
        .op-host .op-hidden { opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s; }
        .op-host:hover .op-hidden, .op-host:focus-within .op-hidden, .op-host.op-force .op-hidden { opacity: 1; visibility: visible; transition: opacity .2s ease, visibility 0s; }
        /* T01674：键盘可达的文件选择入口——sr-only file input 聚焦时容器（label）显示焦点环，
           与相邻按钮焦点观感一致；不加此环则 Tab 命中后无可见指示 */
        .op-hidden:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 6px; }
        /* T03162（U39）硬规范（全库单源，新增 op-host 必须遵守；U06 模型页为该规范回归用例）：
           ① 每个 .op-host 至少含一个「常驻可见 + 可聚焦」元素，且排在所有 .op-hidden 兄弟之前
              ——否则纯键盘 Tab 掠过宿主区时整段悬浮控件不可达（visibility:hidden 即移出 Tab 序）；
           ② 新建/删除等主操作按钮常驻显示时图标旁保留文字标签，可发现性不得只依赖鼠标扫过；
           ③ 悬浮显形仅由 :hover/:focus-within 驱动，禁止对宿主内全部控件默认隐身。 */
        /* T02952：搜索清空按钮——悬浮时图标倾斜 5°~10°（任务约束区间），过渡流畅；按钮自身 transform 若被占用（居中），倾斜落在子 svg 上 */
        .ws-clear-btn svg { transition: transform .18s ease; }
        .ws-clear-btn:hover svg { transform: rotate(-7deg); }
        /* T00477：菜单下拉/过滤条件悬浮展示（默认淡化，悬浮或聚焦完全显示） */
        .toolbar-reveal { opacity: .35; transition: opacity .18s ease; }
        .toolbar-reveal:hover, .toolbar-reveal:focus-within { opacity: 1; }
        /* T01577：时间线节点卡上的可操作角标（跳转关联待办）——hover/键盘焦点都要有可见反馈 */
        .tl-chip { transition: filter .12s ease, box-shadow .12s ease; }
        .tl-chip:hover { filter: brightness(.94); }
        .tl-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .abtn:hover, .ghost:hover { background: var(--surface-2); }`}</style>

      {/* 菜单行：置顶，导航项居左；后端连接状态用 margin-left:auto 推到右端且垂直居中，与菜单项同行。
          T02174：窄窗口下导航项 + 行尾三枚动态元素（未读角标/连接状态/向导按钮）总宽必然超过容器，
          nowrap 会把末元素顶出 nav 边框（456px 实测越界 142px）——改 wrap + rowGap 折行兜底，
          与 TasksPage.renderToolbar 同口径；宽窗口仍是单行，布局不变。 */}
      <nav style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, rowGap: 6, margin: '0', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t, i) => {
          // 菜单图标置于文字前：使用开源 lucide 图标库，与全局视觉一致
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              className="nav-btn"
              onClick={() => setTab(t.key)}
              title={`${t.label}（快捷键 ${i + 1}）`}
              aria-label={t.label}
              aria-keyshortcuts={String(i + 1)} // T03184：数字键 1～9 直达（输入框/弹窗内不生效）
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
          style={{ fontSize: 'var(--fs-s)', marginLeft: 'auto', color: statusColor }}
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

      {/* T01836：启动自动检测新版本的一次性提示条——点击去「设置 → 版本更新」走一键下载/静默安装，
          关掉后本次会话不再弹（sessionStorage），不影响已是最新版本的静默场景 */}
      {updateHint && (
        <output style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 'var(--fs-s)', background: 'var(--accent-soft)', color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
          <span>发现新版本 v{updateHint.latestVersion}（当前 v{updateHint.currentVersion}）</span>
          <button
            onClick={() => setTab('settings')}
            style={{ cursor: 'pointer', border: '1px solid var(--accent)', background: 'var(--card-bg)', color: 'var(--accent)', borderRadius: 6, padding: '2px 10px', fontSize: 'var(--fs-s)' }}
          >
            立即更新
          </button>
          <button
            onClick={() => { sessionStorage.setItem('mtask.updateHintClosed', '1'); setUpdateHint(null); }}
            aria-label="关闭新版本提示"
            style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}
          >
            忽略本次
          </button>
        </output>
      )}

      {/* T02976：菜单通道下载进度条——顶部一条（不遮挡内容），完成/失败各有明确下一步。
          数据源只来自主进程的菜单自驱下载；设置页下载有自己的卡片内进度，不走这条。 */}
      {dlToast && (
        <output
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 'var(--fs-s)',
            background: dlToast.status === 'failed' ? 'rgba(220, 38, 38, .08)' : 'var(--accent-soft)',
            color: dlToast.status === 'failed' ? 'var(--danger)' : 'var(--accent)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ whiteSpace: 'nowrap' }}>
            {dlView?.text}
          </span>
          {dlInFlight && dlView?.showBar && (
            <span style={{ flex: 1, minWidth: 80, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              {/* transition 把 200ms 一次的事件跳动抹平，观感上是连续推进 */}
              <span style={{ display: 'block', height: '100%', width: `${dlPct}%`, background: 'var(--accent)', transition: 'width .2s ease' }} />
            </span>
          )}
          {dlInFlight && (
            /* T02976 补：下载中必须有取消入口——否则用户只能干等 110MB 走完；重试等待期同样可取消 */
            <button
              onClick={() => { void desktopApi()?.cancelUpdateDownload?.(); }}
              title="取消下载 — 中断本次下载并保留已下载部分，稍后可从断点继续"
              aria-label="取消下载：中断本次下载并保留已下载部分"
              style={{ cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 6, padding: '2px 10px', fontSize: 'var(--fs-s)' }}
            >
              取消
            </button>
          )}
          {dlToast.status === 'failed' && (
            <button
              onClick={() => { setDlToast(null); void desktopApi()?.retryOnlineUpdate?.(); }}
              title="重试 — 重新检查并下载新版本安装包"
              aria-label="重试：重新检查并下载新版本安装包"
              style={{ cursor: 'pointer', border: '1px solid var(--danger)', background: 'var(--card-bg)', color: 'var(--danger)', borderRadius: 6, padding: '2px 10px', fontSize: 'var(--fs-s)' }}
            >
              重试
            </button>
          )}
          <button
            onClick={() => setDlToast(null)}
            title="关闭 — 收起下载进度提示（下载仍在后台继续）"
            aria-label="关闭：收起下载进度提示"
            style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 'var(--fs-s)', marginLeft: dlToast.status === 'failed' ? 0 : 'auto' }}
          >
            关闭
          </button>
        </output>
      )}

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