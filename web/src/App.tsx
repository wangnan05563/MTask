import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { TasksPage } from './pages/TasksPage';
import { DashboardPage } from './pages/DashboardPage'; // T06289：Dashboard 从设置页提升为「首页」入口
import { InboxPage } from './pages/InboxPage'; // T06295（REQ-032）：可操作收件箱
import { AIToolsPage } from './pages/AIToolsPage';
import { QueuePage } from './pages/QueuePage';
import { ExecSessionsPage } from './pages/ExecSessionsPage'; // T01271-FR1.4：执行会话观测面板
import { PromptsPage } from './pages/PromptsPage';
import { ReqPage } from './pages/ReqPage';
import { SettingsPage } from './pages/SettingsPage';
import { ReportPage } from './pages/ReportPage';
import { PlanPage } from './pages/PlanPage';
import { NotifyBell } from './ui/NotifyBell'; // T01064-FR1.4：全局通知中心
import { InboxBell } from './ui/InboxBell'; // T06295（REQ-032）：收件箱顶栏入口（角标=open）
import { focusTaskByNo } from './ui/focusTask'; // T01057 建议：通知点击跨项目定位（写齐 focusId/项目/tab）
import { api, apiBase, setAccessToken } from './api/client';
import { HoverCard } from './ui/HoverCard'; // T06084：后端连接状态悬浮显示地址与端口
import { desktopApi } from './ui/desktop'; // T02976：菜单通道下载进度的桌面桥（浏览器环境无此桥）
import { MarkdownStyles } from './ui/Markdown';
import { CommandPalette } from './pages/CommandPalette';
import { QuickCapture } from './ui/QuickCapture'; // T06297（REQ-034 / PRD §A5）：全局快速捕获
import { SettingsProvider } from './settings';
import { MobileShell } from './mobile/MobileShell';
import { Compass, Loader2, Zap } from 'lucide-react'; // T03184（PM-102）：菜单图标随 TABS 一并迁入 ui/tabs.ts，此处只留命令面板入口图标
import { PageGuideDialog, hasSeenGuide, markGuideSeen } from './pages/PageGuide'; // T00706：通用使用向导
import { GUIDES } from './pages/guides'; // T00706：各菜单向导内容配置
import { useReportStream } from './reportStream'; // T01038：AI 工作台运行态（周报生成）
import { usePrdGen } from './stores/prdGenStore'; // T01038：原始需求生成 PRD 运行态
import { aiImportStore } from './stores/aiImportStore'; // T01038：项目计划/PRD 导入运行态

import { TABS, type Tab } from './ui/tabs'; // T03184（PM-102）：一级导航单源——命令面板页面列表同源生成
import { ProjectSwitcher } from './ui/nav/ProjectSwitcher'; // T06329：顶栏项目/工作区切换器
import { PrimaryNav } from './ui/nav/PrimaryNav'; // T06289：左侧 5 项一级导航
import { NAV_GROUPS, navGroupForTab } from './ui/nav/primaryNavGroups'; // T06289：一级入口分组与顶栏子页签单源
import { applyDeepLink, buildDeepLink, readDeepLinkFromLocation } from './ui/deepLink'; // T03187（D-13）：深链契约单源

// T00441：日志/归档入口从顶部菜单移入「设置」（内网穿透下方），顶部菜单收敛为高频功能

// T02977 复验补：下载进度文案/字节格式化单源在 ui/updateProgress（设置页卡片与这条全局条共用，
// 免得两处各自漏态——此前「无总量」「刚点击」两态在卡片侧就是纯空白）
import { isInFlightStatus, updateProgressView } from './ui/updateProgress';

/** T02976：菜单通道下载进度提示条的状态（retrying 额外带主进程给的续传原因文案） */
type DlToastState = {
  status: 'starting' | 'downloading' | 'resuming' | 'retrying' | 'downloaded' | 'failed';
  received: number;
  total: number;
  message?: string;
} | null;

/** T02976：主进程下载进度事件（与 preload 的 onUpdateProgress 契约同形） */
interface MenuUpdateProgress {
  status: string;
  received?: number;
  total?: number;
  origin?: string;
  message?: string;
}

/**
 * T02976：把菜单通道的进度事件落到全局提示条。
 * 只消费 origin='menu'（设置页卡片自带进度，不重复显示）；完成态留 3 秒完成回执后由定时器收起。
 */
function applyMenuProgress(
  d: MenuUpdateProgress,
  setDlToast: Dispatch<SetStateAction<DlToastState>>,
  timer: { current: ReturnType<typeof setTimeout> | undefined },
): void {
  if (d.origin !== 'menu') return;
  const received = d.received ?? 0;
  const total = d.total ?? 0;
  if (d.status === 'starting' || d.status === 'downloading' || d.status === 'resuming') {
    globalThis.clearTimeout(timer.current);
    setDlToast({ status: d.status, received, total });
  } else if (d.status === 'retrying') {
    // 更新下载续传：主进程正在自动续传重试——保留进度条与取消入口，只把文案换成可读原因，
    // 否则用户看到进度归零/停滞会误判成下载失败
    globalThis.clearTimeout(timer.current);
    setDlToast({ status: 'retrying', received, total, message: d.message });
  } else if (d.status === 'downloaded') {
    setDlToast({ status: 'downloaded', received, total });
    // 主进程随后弹「立即安装 / 稍后安装」对话框；进度条只留 3 秒做完成回执即收起
    timer.current = globalThis.setTimeout(() => setDlToast((cur) => (cur?.status === 'downloaded' ? null : cur)), 3000);
  } else if (d.status === 'failed') {
    setDlToast({ status: 'failed', received: 0, total: 0, message: d.message ?? '下载失败' });
  } else {
    setDlToast(null); // cancelled 等终态：菜单通道没有「继续下载」入口，直接收起
  }
}

/** T03170：撤销 op-force 显形（op-hidden 控件只在聚焦期间可见） */
function releaseSearchHost(host: Element | null): void {
  if (host) host.classList.remove('op-force');
}

/**
 * T03170：聚焦页内搜索框。op-hidden 控件默认 visibility:hidden，程序 focus() 无效——
 * 先经宿主 op-force 显形再聚焦，失焦即撤销；返回是否真的拿到了焦点。
 */
function focusPageSearch(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const host = el.closest('.op-host');
  if (host) host.classList.add('op-force');
  el.focus();
  el.select();
  if (document.activeElement !== el) {
    releaseSearchHost(host);
    return false;
  }
  el.addEventListener('blur', () => releaseSearchHost(host), { once: true });
  return true;
}

/** 应用外壳：导航 + 主题变量容器。颜色取自 CSS 变量，主题切换即时全局生效 */
function Shell() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('mtask.nav.collapsed') === '1'; } catch { return false; }
  });
  const toggleNav = () => setNavCollapsed((cur) => {
    const next = !cur;
    try { localStorage.setItem('mtask.nav.collapsed', next ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
    return next;
  });
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  // T01836：启动自动检测到的新版本（仅提示，一键下载安装仍在「设置 → 版本更新」卡片内）
  const [updateHint, setUpdateHint] = useState<{ latestVersion: string; currentVersion: string } | null>(null);
  // T02976：菜单「帮助 → 检查在线更新」的下载由主进程自驱，此时用户可能不在设置页——
  // 这条状态承载全局进度条，只接 origin='menu' 的事件（设置页卡片自己有进度，不重复显示）。
  // 更新下载续传：retrying = 网络中断后的自动续传重试中——进度保持不变，但要让用户知道「没卡死、在自愈」
  // T02977 复验补：starting = 主进程已发起请求但还没收到任何字节（连 DNS/TLS 都算在内）；
  // 没有这一帧，点击后那段空窗在界面上等于「什么都没发生」。
  const [dlToast, setDlToast] = useState<DlToastState>(null);
  // T00443 / PRD UX-4：全局命令面板（T03170 / D-07：Ctrl+K 打开；T03983：Shift+F 亦可；Ctrl+F 只走页内搜索）
  const [paletteOpen, setPaletteOpen] = useState(false);
  // T06297（REQ-034 / PRD §A5）：全局快速捕获浮层——任意页 Ctrl/Cmd+Shift+Space 唤起
  const [captureOpen, setCaptureOpen] = useState(false);
  // T00706：全菜单使用向导——当前菜单首次进入自动弹出，导航右侧常驻「向导」按钮随时唤起
  const guide = GUIDES[tab];
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = () => { if (guide) { markGuideSeen(guide.seenKey); } setGuideOpen(false); };
  // 队列菜单的引导改为页内常驻上手条，不再自动弹窗（autoOpen:false 只允许手动唤起）
  useEffect(() => { if (guide && guide.autoOpen !== false && !hasSeenGuide(guide.seenKey)) setGuideOpen(true); }, [guide]);
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
  // T03983：面板的第二个唤起键由 Ctrl+F 改为 **Shift+F**。Ctrl+F 与各业务页内嵌搜索框长期抢键
  // （页内搜索吃掉后，「面板打不开」被用户读成搜索功能坏了），而 Shift+F 不与浏览器查找/系统级组合冲突。
  // 因此 Ctrl+F 只保留「聚焦页内搜索」这一件事，找不到页内搜索就把键交回浏览器（不再兜底开面板、不再 preventDefault）；
  // 开面板统一走 Ctrl+K 或 Shift+F。⚠ macOS 下 Shift+F 无系统占用，但 Windows 部分输入法把 Shift+字母当候选键，
  // 故 e.isComposing 必须先判（与数字键直达同一套守卫）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // T06297（REQ-034 / PRD §A5）：Ctrl/Cmd+Shift+Space = 任意页唤起快速捕获。
      // 输入态也放行（写东西时冒出一个想法正是这个快捷键的主场景）；IME 组合中不抢键。
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'Space' || e.key === ' ')) {
        if (e.isComposing) return;
        e.preventDefault();
        setPaletteOpen(false);
        setCaptureOpen(true);
        return;
      }
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey) {
        if (e.isComposing) return;
        const anchor = e.target instanceof Element ? e.target : null;
        if (anchor?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
        if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // T06295（REQ-032）：Ctrl/Cmd+Shift+I 直达收件箱——输入态与弹窗内不抢键。
      if (k === 'i' && e.shiftKey && !e.altKey) {
        if (e.isComposing) return;
        const anchor = e.target instanceof Element ? e.target : null;
        if (anchor?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
        if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
        e.preventDefault();
        setTab('inbox');
        return;
      }
      if (k === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (k === 'f') {
        // T03983：仅在真的聚焦到页内搜索时才 preventDefault——否则把浏览器原生查找也一起吞掉，
        // 而面板已另有 Shift+F/Ctrl+K 两个入口，这里没有替它兜底的义务。
        const cands = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-page-search], textarea[data-page-search]'));
        const target = cands.find((el) => el.offsetParent !== null && !el.disabled);
        if (target && focusPageSearch(target)) {
          e.preventDefault();
          setPaletteOpen(false);
        }
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  // T06289：数字键 1～5 直达 5 个一级入口默认页——仅在「非输入、无弹窗、非输入法组合」时生效。
  // 输入框里的 1～5 是内容；弹窗打开时用户在做局部操作，切页会把上下文弄丢；IME 组合中的按键不能当快捷键。
  useEffect(() => {
    const onDigit = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing) return;
      if (!/^[1-5]$/.test(e.key)) return;
      const anchor = e.target instanceof Element ? e.target : null;
      if (anchor?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
      const target = NAV_GROUPS[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      setTab(target.defaultTab);
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
    const timer: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const off = desk.onUpdateProgress((d) => applyMenuProgress(d, setDlToast, timer));
    return () => { globalThis.clearTimeout(timer.current); off(); };
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
  const activeGroup = navGroupForTab(tab); // T06289：顶栏只展示当前一级入口下的二级页签

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
  const backendInfo = backendAddressInfo(apiBase);

  // T02977 复验补：文案/百分比收进 updateProgressView（与设置页卡片同一单源），这里只管布局与按钮
  const dlView = dlToast ? updateProgressView(dlToast) : null;
  const dlPct = dlView?.pct ?? 0;
  const dlInFlight = dlToast !== null && isInFlightStatus(dlToast.status);

  return (
    <div
      style={{
        fontFamily: 'var(--font-family)',
        // T06289：外壳改为「左侧一级导航 + 内容区」；内容宽度由 PageShell 收口到 1440px
        width: '100%',
        minHeight: '100vh',
        boxSizing: 'border-box',
        padding: 0,
        background: 'var(--app-bg)',
        color: 'var(--text)',
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
      {/* T06297（REQ-034）：浮层常驻挂载，关闭后仍保留“已捕获/撤销”toast；内层按 open 决定是否显示遮罩 */}
      <QuickCapture open={captureOpen} onClose={() => setCaptureOpen(false)} />
      {/* 全局按钮去边框：扁平简约统一视觉，显式边框按钮随后逐个移除 */}
      <style>{`button { border: none; cursor: pointer; transition: transform .12s ease; }
        button:disabled { cursor: default; opacity: .6; }
        button:active:not(:disabled) { transform: scale(0.95); }
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
        /* T04544 复盘：原 active 规则特异性 (0,2,1) 低于 hover 规则 (0,3,1)——按下时元素同时处于
           :hover 与 :active，hover 永远胜出，「点击缩放回弹」实际从未生效（全站 abtn/ghost 复制按钮皆然）。
           补 :not(:disabled) 拉平特异性并保持在后，active 才真正接管。 */
        .abtn:active:not(:disabled) svg, .ghost:active:not(:disabled) svg { transform: scale(.88); }
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
        button:hover:not(:disabled):not(.tbtn-anim):not(.abtn):not(.ghost):not(.row-title-btn):not(.task-op) { transform: rotate(-1.5deg); } /* T00494：记录标题按钮不参与悬浮旋转；T00513：task-op 行内按钮走倾斜缩放基准 */
        /* T04582：行标题按钮（row-title-btn）是任务/提示词/通用需求/通知中心/Git 树选范围五处的「数据标题」，
           去除悬浮倾斜——标题区域悬浮不再 rotate/scale（便于选中复制）；其余按钮的倾斜体系保持不变。 */
        button.row-title-btn:hover:not(:disabled) { transform: none; }
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
        /* T00491：菜单操作控件/搜索框统一「默认隐藏、悬浮宿主区显示」（后代选择器支持嵌套组）
           P2-7：旧实现用 visibility:hidden 藏控件，等于把整组导出/导入入口移出 Tab 序——纯键盘无法到达。
           改为「透明但仍可聚焦 + pointer-events:none 防误点」，焦点进入即淡入；触屏/粗指针设备常显。 */
        .op-host .op-hidden { opacity: 0; visibility: visible; pointer-events: none; transition: opacity .2s ease; }
        .op-host:hover .op-hidden, .op-host:focus-within .op-hidden, .op-host.op-force .op-hidden { opacity: 1; pointer-events: auto; transition: opacity .2s ease; }
        .op-hidden:focus-visible, .op-hidden:focus-within { opacity: 1 !important; pointer-events: auto; }
        @media (hover: none), (pointer: coarse) {
          .op-host .op-hidden { opacity: 1; pointer-events: auto; }
        }
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

      {/* T06289：左侧 5 项一级导航 + 顶栏子页签切换器；后端状态/通知/向导收进顶栏右侧 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: '100vh' }}>
        <PrimaryNav
          activeTab={tab}
          collapsed={navCollapsed}
          onToggle={toggleNav}
          onSelect={setTab}
        />
        <main className="mt-app-main" style={{ flex: 1, minWidth: 0, minHeight: '100vh' }}>
          <header className="mt-top-switcher" aria-label="页面切换">
            <span className="mt-top-group">{activeGroup.label}</span>
            <ProjectSwitcher />
            {activeGroup.tabs.length > 1 && (
              <div className="mt-top-tabs" role="tablist" aria-label={`${activeGroup.label}子页面`}>
                {activeGroup.tabs.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="mt-top-tab"
                    role="tab"
                    aria-selected={tab === item.key}
                    onClick={() => setTab(item.key)}
                  >
                    {item.label}
                    {item.key === 'report' && workbenchRunning && (
                      <Loader2 size={11} className="aispin" style={{ marginLeft: 4, verticalAlign: 'middle' }} />
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-top-actions">
              {/* T06297（REQ-034 / PRD §A5）：顶栏常驻快速捕获入口，快捷键为 Ctrl/Cmd+Shift+Space */}
              <button
                type="button"
                className="mt-top-capture"
                data-capture-open
                onClick={() => { setPaletteOpen(false); setCaptureOpen(true); }}
                title="快速捕获 — Ctrl/Cmd+Shift+Space"
                aria-label="打开快速捕获（Ctrl/Cmd+Shift+Space）"
              >
                <Zap size={15} />
              </button>
              {/* T06295（REQ-032）：收件箱入口——角标数=open 条目数，unread 仅小圆点 */}
              <InboxBell />
              {/* T01064-FR1.4：全局通知中心（铃铛 + 未读角标 + 事件下拉） */}
              <NotifyBell />
              {/* 后端连接状态：色值与文案按三态（未知/正常/异常）显式计算 */}
              <HoverCard
                card={backendInfo}
                ariaLabel="后端连接地址"
                cardW={380}
                cardH={48}
                openDelay={180}
                style={{ flexShrink: 0 }}
              >
                <span title={backendInfo} className="mt-top-status" style={{ color: statusColor, cursor: 'help' }}>
                  {statusText}
                </span>
              </HoverCard>
              {/* T00706：常驻「向导」按钮——当前菜单首次进入自动弹出，也可随时手动唤起 */}
              {guide && (
                <button
                  type="button"
                  className="mt-top-guide"
                  onClick={() => setGuideOpen(true)}
                  title={`使用向导 — 查看「${guide.title.split(' · ')[0]}」菜单各功能的使用说明与要点`}
                  aria-label="打开当前菜单使用向导"
                >
                  <Compass size={15} />
                </button>
              )}
            </div>
          </header>

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
              onClick={() => { desktopApi()?.cancelUpdateDownload?.(); }}
              title="取消下载 — 中断本次下载并保留已下载部分，稍后可从断点继续"
              aria-label="取消下载：中断本次下载并保留已下载部分"
              style={{ cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 6, padding: '2px 10px', fontSize: 'var(--fs-s)' }}
            >
              取消
            </button>
          )}
          {dlToast.status === 'failed' && (
            <button
              onClick={() => { setDlToast(null); desktopApi()?.retryOnlineUpdate?.(); }}
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

          <div className="mt-page-host" style={{ padding: tab === 'queue' || tab === 'plan' ? '12px 24px 40px' : '24px 24px 40px' }}>
            {tab === 'dashboard' && <DashboardPage />}
            {tab === 'inbox' && <InboxPage />}
            {tab === 'tasks' && <TasksPage />}
            {tab === 'aitools' && <AIToolsPage />}
            {tab === 'prompts' && <PromptsPage />}
            {tab === 'req' && <ReqPage />}
            {tab === 'queue' && <QueuePage />}
            {tab === 'exec-sessions' && <ExecSessionsPage />}
            {tab === 'plan' && <PlanPage />}
            {tab === 'report' && <ReportPage />}
            {/* T00441：日志/归档入口移至「设置」页（内网穿透下方） */}
            {tab === 'settings' && <SettingsPage />}
          </div>
        </main>
      </div>

      {/* T00706：当前菜单的使用向导弹窗（首次进入自动弹出 / 顶栏右侧按钮唤起） */}
      {guide && <PageGuideDialog open={guideOpen} onClose={closeGuide} title={guide.title} steps={guide.steps} />}
    </div>
  );
}

/**
 * T06084：把 API base 归一成「后台地址 · 接口前缀」，供连接状态悬浮提示使用。
 * 浏览器形态 base 是 http(s)://host:port/api，能直接读出地址、端口与前缀；
 * Electron 的 api:// 自定义协议没有端口，原样展示协议地址，不伪造端口。
 */
function backendAddressInfo(base: string): string {
  try {
    const u = new URL(base);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return `后台地址：${u.origin} · 接口前缀：${path}`;
    }
  } catch { /* 非标准 URL 走原样兜底 */ }
  return `后台地址：${base}`;
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
  // T05767：独立置顶监控窗口以 ?view=exec-monitor 打开——不渲染主应用导航/通知铃铛，
  // 只承载执行会话双栏页面，避免独立窗口里再出现一套应用外壳。
  const standaloneMonitor = new URLSearchParams(location.search).get('view') === 'exec-monitor';
  if (standaloneMonitor) {
    return (
      <SettingsProvider>
        <ExecSessionsPage standalone />
      </SettingsProvider>
    );
  }
  const ui = resolveUiMode();
  return (
    <SettingsProvider>
      {ui === 'mobile' ? <MobileShell /> : <Shell />}
    </SettingsProvider>
  );
}