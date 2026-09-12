import { useEffect, useState } from 'react';
import { TasksPage } from './pages/TasksPage';
import { AIToolsPage } from './pages/AIToolsPage';
import { QueuePage } from './pages/QueuePage';
import { PromptsPage } from './pages/PromptsPage';
import { ReqPage } from './pages/ReqPage';
import { SettingsPage } from './pages/SettingsPage';
import { ReportPage } from './pages/ReportPage';
import { PlanPage } from './pages/PlanPage';
import { api, setAccessToken } from './api/client';
import { MarkdownStyles } from './ui/Markdown';
import { SettingsProvider } from './settings';
import { MobileShell } from './mobile/MobileShell';
import { Archive, BarChart3, Boxes, CalendarRange, Lightbulb, ListOrdered, ListTodo, ScrollText, Settings, type LucideIcon } from 'lucide-react';

// T00441：日志/归档入口从顶部菜单移入「设置」（内网穿透下方），顶部菜单收敛为高频功能
type Tab = 'tasks' | 'aitools' | 'prompts' | 'req' | 'plan' | 'queue' | 'report' | 'settings';

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'tasks', label: '任务', icon: ListTodo },
  { key: 'aitools', label: '模型', icon: Boxes },
  { key: 'prompts', label: '提示词', icon: ScrollText },
  { key: 'req', label: '通用需求', icon: Lightbulb },
  { key: 'plan', label: '项目计划', icon: CalendarRange },
  { key: 'report', label: '周报', icon: BarChart3 },
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'settings', label: '设置', icon: Settings },
];

/** 应用外壳：导航 + 主题变量容器。颜色取自 CSS 变量，主题切换即时全局生效 */
function Shell() {
  const [tab, setTab] = useState<Tab>('tasks');
  const [serverOk, setServerOk] = useState<boolean | null>(null);

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
      {/* 全局按钮去边框：扁平简约统一视觉，显式边框按钮随后逐个移除 */}
      <style>{`button { border: none; cursor: pointer; transition: transform .12s ease; }
        button:disabled { cursor: default; opacity: .6; }
        button:active:not(:disabled) { transform: scale(0.95); }
        .abtn:hover, .ghost:hover { background: var(--surface-2); }`}</style>

      {/* 菜单行：置顶，导航项居左；后端连接状态用 margin-left:auto 推到右端且垂直居中，与菜单项同行 */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => {
          // 菜单图标置于文字前：使用开源 lucide 图标库，与全局视觉一致
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.label}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: tab === t.key ? 'var(--accent)' : 'var(--card-bg)',
                color: tab === t.key ? 'var(--accent-text)' : 'var(--text)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon size={14} />
              {t.label}
            </button>
          );
        })}
        {/* 后端连接状态：随 serverOk 动态更新，常驻菜单行最右侧。
            色值与文案按三态（未知/正常/异常）显式计算，避免 JSX 中嵌套三元 */}
        <span
          style={{ fontSize: 12, marginLeft: 'auto', color: statusColor }}
        >
          {statusText}
        </span>
      </nav>

      {tab === 'tasks' && <TasksPage />}
      {tab === 'aitools' && <AIToolsPage />}
      {tab === 'prompts' && <PromptsPage />}
      {tab === 'req' && <ReqPage />}
      {tab === 'queue' && <QueuePage />}
      {tab === 'plan' && <PlanPage />}
      {tab === 'report' && <ReportPage />}
      {/* T00441：日志/归档入口移至「设置」页（内网穿透下方） */}
      {tab === 'settings' && <SettingsPage />}
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